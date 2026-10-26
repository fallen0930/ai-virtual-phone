import { describe, expect, it } from "vitest";
import {
    MIX_PHONE_SETTINGS_DEFAULTS,
    mixTurnChannel,
    mixTurnToPhoneMessage,
    normalizeMixPhoneWorld,
    type MixPhoneMessage,
} from "@/lib/mixology/chatroom-types";
import {
    appendStandaloneThreadMessages,
    createMixPhoneWorld,
    deleteMixPhoneWorld,
    deletePhoneDataBySession,
    findDirectThread,
    findMixPhoneWorldBySession,
    getMixChatThread,
    getMixPhoneWorld,
    loadMixChatThreads,
    loadMixPhoneWorlds,
    loadStandaloneThreadMessages,
    loadThreadMessages,
    saveMixChatThread,
} from "@/lib/mixology/chatroom-storage";
import { createMixId, type MixTurn } from "@/lib/mixology/types";

// 聊天室（手机频道）· 存储层
//
// 钉住的规则：
//   A 世界/会话读写往返，读出时做旧数据归一（settings 缺项补默认值）。
//   B 一场对局至多一个绑定世界：findMixPhoneWorldBySession 按 sessionId 命中。
//   C 私聊会话可按 (worldId, memberId) 找到；群聊不冒充私聊。
//   D 绑定世界的消息 = 对局 turns 里 channel==="msg" 且 threadId 匹配的轮；
//     scene 轮与别家 thread 的轮一律不漏进来。
//   E 独立世界消息存独立键，随 thread/世界删除一并清理（不留孤儿键）。
//   F deletePhoneDataBySession 只删该对局名下的世界与会话，别家不受牵连。

const rand = () => createMixId(`t${Math.floor(Math.random() * 1e9)}`);

function makeTurn(partial: Partial<MixTurn> & { text: string }): MixTurn {
    return {
        id: rand(),
        role: "assistant",
        createdAt: Date.now(),
        ...partial,
    };
}

describe("chatroom: MixTurn channel 标记", () => {
    it("旧数据没有 channel 字段，一律按 scene 处理", () => {
        const turn = makeTurn({ text: "正文" });
        expect(mixTurnChannel(turn)).toBe("scene");
    });

    it("显式 msg 轮读出为 msg", () => {
        const turn = makeTurn({ text: "嗨", channel: "msg", speaker: "林晚", threadId: "th1" });
        expect(mixTurnChannel(turn)).toBe("msg");
    });

    it("mixTurnToPhoneMessage 保留说话人与文本", () => {
        const turn = makeTurn({ text: "在吗", role: "user", channel: "msg", threadId: "th1" });
        const msg = mixTurnToPhoneMessage(turn);
        expect(msg).toMatchObject({ id: turn.id, role: "user", text: "在吗", turnId: turn.id });
        expect(msg.speaker).toBeUndefined();
    });
});

describe("chatroom: 世界与设置归一", () => {
    it("createMixPhoneWorld 落默认设置并可读回", () => {
        const world = createMixPhoneWorld({ sessionId: rand(), memberIds: [rand()] });
        expect(world.id).toBeTruthy();
        expect(world.settings).toEqual(MIX_PHONE_SETTINGS_DEFAULTS);
        expect(getMixPhoneWorld(world.id)?.id).toBe(world.id);
        expect(loadMixPhoneWorlds().some((w) => w.id === world.id)).toBe(true);
    });

    it("旧数据缺 settings / memberIds 时归一补齐，不炸", () => {
        const world = createMixPhoneWorld({ memberIds: [] });
        // 模拟旧格式：删掉 settings、memberIds 置 undefined
        const raw = JSON.parse(JSON.stringify(world)) as Record<string, unknown>;
        delete raw.settings;
        (raw as { memberIds?: string[] }).memberIds = undefined;
        const fixed = normalizeMixPhoneWorld(raw);
        expect(fixed.settings).toEqual(MIX_PHONE_SETTINGS_DEFAULTS);
        expect(fixed.memberIds).toEqual([]);
    });

    it("findMixPhoneWorldBySession 只命中绑定了该对局的世界", () => {
        const sidA = rand();
        const sidB = rand();
        createMixPhoneWorld({ sessionId: sidA, memberIds: [] });
        createMixPhoneWorld({ memberIds: [] }); // 独立世界
        expect(findMixPhoneWorldBySession(sidA)?.sessionId).toBe(sidA);
        expect(findMixPhoneWorldBySession(sidB)).toBeNull();
    });
});

describe("chatroom: 会话（thread）", () => {
    it("私聊按 (worldId, memberId) 命中，群聊不冒充私聊", () => {
        const world = createMixPhoneWorld({ memberIds: ["m1", "m2"] });
        const direct: MixChatThreadLike = {
            id: rand(),
            worldId: world.id,
            kind: "direct",
            memberId: "m1",
            createdAt: Date.now(),
        };
        const group: MixChatThreadLike = {
            id: rand(),
            worldId: world.id,
            kind: "group",
            memberIds: ["m1", "m2"],
            name: "小群",
            createdAt: Date.now(),
        };
        saveMixChatThread(direct);
        saveMixChatThread(group);
        expect(findDirectThread(world.id, "m1")?.id).toBe(direct.id);
        expect(findDirectThread(world.id, "m2")).toBeNull();
        expect(getMixChatThread(group.id)?.name).toBe("小群");
        expect(loadMixChatThreads(world.id).map((t) => t.id).sort()).toEqual(
            [direct.id, group.id].sort()
        );
        expect(loadMixChatThreads("no-such-world")).toEqual([]);
    });

    it("删世界级联删会话与独立消息键，不留孤儿", () => {
        const world = createMixPhoneWorld({ memberIds: [] });
        const thread: MixChatThreadLike = {
            id: rand(),
            worldId: world.id,
            kind: "group",
            memberIds: ["a", "b"],
            createdAt: Date.now(),
        };
        saveMixChatThread(thread);
        appendStandaloneThreadMessages(thread.id, [{ id: rand(), role: "user", text: "嗨", createdAt: Date.now() }]);
        expect(loadStandaloneThreadMessages(thread.id)).toHaveLength(1);
        deleteMixPhoneWorld(world.id);
        expect(getMixPhoneWorld(world.id)).toBeNull();
        expect(getMixChatThread(thread.id)).toBeNull();
        expect(loadStandaloneThreadMessages(thread.id)).toEqual([]);
    });
});

describe("chatroom: 消息读取", () => {
    it("独立世界消息走独立键往返", () => {
        const threadId = rand();
        const msgs: MixPhoneMessage[] = [
            { id: rand(), role: "user", text: "第一条", createdAt: 1 },
            { id: rand(), role: "assistant", speaker: "林晚", text: "第二条", createdAt: 2 },
        ];
        appendStandaloneThreadMessages(threadId, msgs);
        expect(loadStandaloneThreadMessages(threadId)).toEqual(msgs);
    });

    it("绑定世界消息 = 对局 turns 里 channel=msg 且 threadId 匹配的轮，按序", () => {
        const threadId = rand();
        const otherThread = rand();
        const turns: MixTurn[] = [
            makeTurn({ text: "剧情一", role: "user" }),
            makeTurn({ text: "剧情一回复" }),
            makeTurn({ text: "私聊消息", channel: "msg", threadId, role: "user" }),
            makeTurn({ text: "别人的私聊", channel: "msg", threadId: otherThread, speaker: "他人" }),
            makeTurn({ text: "她的回复", channel: "msg", threadId, speaker: "林晚" }),
            makeTurn({ text: "剧情二", role: "user" }),
        ];
        const msgs = loadThreadMessages({ id: threadId, worldId: "w", kind: "direct", memberId: "m", createdAt: 0 }, turns);
        expect(msgs.map((m) => m.text)).toEqual(["私聊消息", "她的回复"]);
        expect(msgs[1].speaker).toBe("林晚");
    });
});

describe("chatroom: 按对局级联清理", () => {
    it("deletePhoneDataBySession 只删该对局名下数据", () => {
        const sidA = rand();
        const sidB = rand();
        const worldA = createMixPhoneWorld({ sessionId: sidA, memberIds: [] });
        const worldB = createMixPhoneWorld({ sessionId: sidB, memberIds: [] });
        const threadA: MixChatThreadLike = { id: rand(), worldId: worldA.id, kind: "direct", memberId: "m", createdAt: 0 };
        saveMixChatThread(threadA);
        appendStandaloneThreadMessages(threadA.id, [{ id: rand(), role: "user", text: "x", createdAt: 0 }]);

        expect(deletePhoneDataBySession(sidA)).toBeGreaterThanOrEqual(1);
        expect(getMixPhoneWorld(worldA.id)).toBeNull();
        expect(getMixChatThread(threadA.id)).toBeNull();
        expect(loadStandaloneThreadMessages(threadA.id)).toEqual([]);
        // B 不受牵连
        expect(getMixPhoneWorld(worldB.id)?.id).toBe(worldB.id);
    });
});

type MixChatThreadLike = Parameters<typeof saveMixChatThread>[0];
