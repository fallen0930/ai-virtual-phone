import { describe, expect, it } from "vitest";
import {
    MIX_MSG_HISTORY_CAP,
    buildMixMessages,
    mixRoundCount,
    phoneHistoryNoteSection,
    selectHistoryTurns,
} from "@/lib/mixology/history";
import type { MixAssembledPrompt } from "@/lib/mixology/assembler";
import type { MixTurn } from "@/lib/mixology/types";

// 聊天室（手机频道）· 对局历史回传
//
// 钉住的规则：
//   A scene 轮的裁剪口径与旧 limitMixTurns 一致（找到倒数第 N+1 个正文 assistant
//     整段截起）；msg 轮不占 scene 轮数，单独只带最近 CAP 条。
//   B msg 轮进请求时带【手机消息·会话名】标记，assistant 再带说话人前缀。
//   C 小票/小剧场的"最近一条"补发看的是最后一条 **scene** assistant——
//     手机消息轮插在后面也不能把状态栏接续挤丢；机括改写同样只落在 scene 轮上。
//   D mixRoundCount 只数 scene 的 user 轮（聊天消息不算对局轮数）。
//   E 有 msg 轮才生成手机消息说明挂段，纯正文老局不受影响。

const assembled: MixAssembledPrompt = {
    system: "SYS",
    postHistory: "",
    opening: "",
    hasTicket: false,
    hasEncore: false,
};

let seq = 0;
const turn = (partial: Partial<MixTurn> & { role: "user" | "assistant"; text: string }): MixTurn => ({
    id: `t${++seq}`,
    createdAt: seq,
    ...partial,
});

describe("chatroom: 历史轮选择", () => {
    it("纯 scene 局：与旧口径一致，按 limit 截最近 N 轮", () => {
        const turns = [
            turn({ role: "user", text: "u1" }),
            turn({ role: "assistant", text: "a1" }),
            turn({ role: "user", text: "u2" }),
            turn({ role: "assistant", text: "a2" }),
            turn({ role: "user", text: "u3" }),
            turn({ role: "assistant", text: "a3" }),
        ];
        expect(selectHistoryTurns(turns, 2).map((t) => t.text)).toEqual(["u2", "a2", "u3", "a3"]);
        expect(selectHistoryTurns(turns, undefined)).toHaveLength(6);
    });

    it("msg 轮不占 scene 轮数，交错时正文与消息都保留", () => {
        const turns = [
            turn({ role: "user", text: "u1" }),
            turn({ role: "assistant", text: "a1" }),
            turn({ role: "user", text: "mu1", channel: "msg", threadId: "th", threadLabel: "林晚" }),
            turn({ role: "assistant", text: "ma1", channel: "msg", speaker: "林晚", threadId: "th", threadLabel: "林晚" }),
            turn({ role: "user", text: "u2" }),
            turn({ role: "assistant", text: "a2" }),
            turn({ role: "user", text: "u3" }),
            turn({ role: "assistant", text: "a3" }),
        ];
        const kept = selectHistoryTurns(turns, 2);
        // 时间顺序保持不变：夹在中间的聊天轮原地保留，只裁更早的正文轮
        expect(kept.map((t) => t.text)).toEqual(["mu1", "ma1", "u2", "a2", "u3", "a3"]);
    });

    it("msg 轮单独限流：超过 CAP 的旧聊天直接不进请求", () => {
        const turns: MixTurn[] = [turn({ role: "user", text: "u1" }), turn({ role: "assistant", text: "a1" })];
        for (let i = 0; i < MIX_MSG_HISTORY_CAP + 5; i += 1) {
            turns.push(turn({ role: "user", text: `m${i}`, channel: "msg", threadId: "th", threadLabel: "林晚" }));
        }
        const kept = selectHistoryTurns(turns, undefined);
        const msgKept = kept.filter((t) => t.channel === "msg");
        expect(msgKept).toHaveLength(MIX_MSG_HISTORY_CAP);
        expect(msgKept[0].text).toBe(`m5`);
        expect(kept.some((t) => t.text === "a1")).toBe(true);
    });
});

describe("chatroom: 历史消息渲染", () => {
    it("msg 轮带【手机消息】标记与说话人前缀，scene 轮原样", () => {
        const turns: MixTurn[] = [
            turn({ role: "user", text: "推剧情" }),
            turn({ role: "assistant", text: "正文回复" }),
            turn({ role: "user", text: "在吗", channel: "msg", threadId: "th", threadLabel: "林晚" }),
            turn({ role: "assistant", text: "嗯", channel: "msg", speaker: "林晚", threadId: "th", threadLabel: "林晚" }),
        ];
        const messages = buildMixMessages(
            { turns } as Parameters<typeof buildMixMessages>[0],
            assembled,
        );
        expect(messages[0]).toMatchObject({ role: "system", content: "SYS" });
        expect(messages[1]).toMatchObject({ role: "user", content: "推剧情" });
        expect(messages[2]).toMatchObject({ role: "assistant", content: "正文回复" });
        expect(messages[3]).toMatchObject({ role: "user", content: "【手机消息·林晚】在吗" });
        expect(messages[4]).toMatchObject({ role: "assistant", content: "【手机消息·林晚】林晚：嗯" });
    });

    it("状态栏补发与机括改写落在最后一条 scene assistant 上，不被手机消息挤掉", () => {
        const turns: MixTurn[] = [
            turn({
                role: "assistant",
                text: "带状态栏的正文",
                ticketRaws: [{ raw: "好感度：70" }],
            }),
            turn({ role: "assistant", text: "聊天回复", channel: "msg", speaker: "林晚", threadId: "th", threadLabel: "林晚" }),
        ];
        const messages = buildMixMessages(
            { turns } as Parameters<typeof buildMixMessages>[0],
            assembled,
            undefined,
            undefined,
            "机括改写后的整条",
        );
        // scene assistant：机括整条替换 + 状态栏块不在改写文本里（由机括自己带）
        expect(messages[1]).toMatchObject({ role: "assistant", content: "机括改写后的整条" });
        // 手机消息轮不受机括改写影响
        expect(messages[2]).toMatchObject({ role: "assistant", content: "【手机消息·林晚】林晚：聊天回复" });

        // 没有机括时：最后一条 scene assistant 补发状态栏块（接续 + 格式示范）
        const plain = buildMixMessages({ turns } as Parameters<typeof buildMixMessages>[0], assembled);
        expect(plain[1].content).toContain("[状态栏]");
        expect(plain[1].content).toContain("带状态栏的正文");
    });
});

describe("chatroom: 轮数与说明挂段", () => {
    it("mixRoundCount 只数 scene 的 user 轮", () => {
        const turns: MixTurn[] = [
            turn({ role: "user", text: "u1" }),
            turn({ role: "assistant", text: "a1" }),
            turn({ role: "user", text: "m1", channel: "msg", threadId: "th", threadLabel: "林晚" }),
            turn({ role: "assistant", text: "m2", channel: "msg", speaker: "林晚", threadId: "th", threadLabel: "林晚" }),
            turn({ role: "user", text: "u2" }),
        ];
        expect(mixRoundCount(turns)).toBe(2);
    });

    it("有 msg 轮才挂手机消息说明，纯正文局不挂", () => {
        expect(phoneHistoryNoteSection({ turns: [turn({ role: "user", text: "u1" })] })).toBeNull();
        const note = phoneHistoryNoteSection({
            turns: [turn({ role: "user", text: "m1", channel: "msg", threadId: "th", threadLabel: "林晚" })],
        });
        expect(note?.at).toBe("base");
        expect(note?.text).toContain("手机消息");
    });
});
