import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MIX_INNER_VOICE_CLOSE,
    MIX_INNER_VOICE_OPEN,
    assembleChatroomPrompt,
    buildChatroomMessages,
    buildChatroomPlotContext,
    capChatHistory,
    makeChatTurn,
    pickChatResponders,
    runChatroomReply,
    splitChatInnerVoice,
} from "@/lib/mixology/chatroom-engine";
import type { MixPhoneMessage } from "@/lib/mixology/chatroom-types";
import type {
    MixCharacterCard,
    MixPersonaMaterial,
    MixTextMaterial,
    MixTurn,
} from "@/lib/mixology/types";

// 聊天室（手机频道）· 引擎
//
// 钉住的规则：
//   A 心声壳 〔心声〕…〔/心声〕 能从消息里拆出来，未闭合的也按心声兜住。
//   B 装配：发言者资料 + 用户资料 + 世界与剧情 + 前情 + 输出要求；心声契约按开关拼入；
//     群聊有"多人发言"说明，私聊没有；{{char}}/{{user}} 宏照常替换。
//   C 回复策略：点名 > 轮流/全员；点名未命中回落轮流。
//   D 写回：makeChatTurn 产 msg 轮，state 快照沿用上一轮现值（绝不重算）。
//   E 前情提要只取 scene 的 assistant 轮（手机消息轮不算剧情），状态行按开关。
//   F 调用走特调同一套 LLM 配置：preset=null、regexes=[]、appTags 带 chatroom；
//     流式一个字没来就报错时退回一次性请求。

const llmMock = vi.hoisted(() => ({
    streamCalls: [] as unknown[][],
    streamImpl: null as null | (() => { content: string; usage?: { total_tokens?: number } }),
    streamError: null as Error | null,
    nonStreamCalls: [] as unknown[][],
    nonStreamText: "兜底内容",
}));

vi.mock("@/lib/mixology/engine", () => ({
    resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x", enableStreaming: true }),
}));

vi.mock("@/lib/chat-engine", () => ({
    sendLLMStreamRequest: async (...args: unknown[]) => {
        llmMock.streamCalls.push(args);
        if (llmMock.streamError) throw llmMock.streamError;
        const callbacks = args[6] as { onDelta?: (text: string) => void } | undefined;
        const result = llmMock.streamImpl ? llmMock.streamImpl() : { content: "流式回复" };
        if (callbacks?.onDelta) callbacks.onDelta(result.content);
        return result;
    },
    sendLLMRequest: async (...args: unknown[]) => {
        llmMock.nonStreamCalls.push(args);
        return llmMock.nonStreamText;
    },
}));

const rand = () => `t${Math.floor(Math.random() * 1e9)}_${Math.random().toString(36).slice(2, 6)}`;

function card(name: string, extra?: Partial<MixCharacterCard>): MixCharacterCard {
    return {
        id: rand(),
        kind: "character",
        name,
        charName: name,
        openings: [],
        createdAt: 0,
        updatedAt: 0,
        ...extra,
    };
}

function persona(userName: string, content = "普通大学生"): MixPersonaMaterial {
    return { id: rand(), kind: "persona", name: "面具", createdAt: 0, updatedAt: 0, userName, content };
}

function textMaterial(content: string): MixTextMaterial {
    return { id: rand(), kind: "base", name: "基底", createdAt: 0, updatedAt: 0, content };
}

beforeEach(() => {
    llmMock.streamCalls = [];
    llmMock.streamImpl = null;
    llmMock.streamError = null;
    llmMock.nonStreamCalls = [];
});

describe("chatroom: 心声解析", () => {
    it("正文 + 心声拆成两段气泡", () => {
        const bubbles = splitChatInnerVoice(`今晚月色不错。${MIX_INNER_VOICE_OPEN}其实我想她了。${MIX_INNER_VOICE_CLOSE}`);
        expect(bubbles).toEqual([
            { kind: "text", text: "今晚月色不错。" },
            { kind: "voice", text: "其实我想她了。" },
        ]);
    });

    it("心声夹在中间、多段、未闭合都能处理", () => {
        const text = `a${MIX_INNER_VOICE_OPEN}心1${MIX_INNER_VOICE_CLOSE}b${MIX_INNER_VOICE_OPEN}心2${MIX_INNER_VOICE_CLOSE}c`;
        expect(splitChatInnerVoice(text)).toEqual([
            { kind: "text", text: "a" },
            { kind: "voice", text: "心1" },
            { kind: "text", text: "b" },
            { kind: "voice", text: "心2" },
            { kind: "text", text: "c" },
        ]);
        expect(splitChatInnerVoice(`正常话${MIX_INNER_VOICE_OPEN}忘了闭合`)).toEqual([
            { kind: "text", text: "正常话" },
            { kind: "voice", text: "忘了闭合" },
        ]);
    });

    it("没有心声就是一整条正文", () => {
        expect(splitChatInnerVoice("就一句话")).toEqual([{ kind: "text", text: "就一句话" }]);
    });
});

describe("chatroom: 提示词装配", () => {
    const speaker = card("林晚", { personality: "{{user}}的青梅竹马，嘴硬心软", worldview: "滨城永远在下雨" });
    const other = card("周叙", { baseInfo: "酒保，话少" });

    it("包含发言者资料/用户资料/世界与剧情/输出要求，宏照常替换", () => {
        const system = assembleChatroomPrompt({
            speaker,
            members: [speaker],
            worldCard: speaker,
            persona: persona("小舟"),
            baseMaterials: [textMaterial("所有人都知道{{char}}不喜欢雨天")],
            innerVoice: true,
        });
        expect(system).toContain("# 扮演总纲");
        expect(system).toContain("所有人都知道林晚不喜欢雨天");
        expect(system).toContain("小舟的青梅竹马");
        expect(system).toContain("# 用户资料");
        expect(system).toContain("# 世界与剧情");
        expect(system).toContain("滨城永远在下雨");
        expect(system).toContain("# 输出要求");
        expect(system).toContain(MIX_INNER_VOICE_OPEN);
    });

    it("心声关 = 不拼心声契约；私聊没有多人说明，群聊有", () => {
        const direct = assembleChatroomPrompt({ speaker, members: [speaker], worldCard: speaker, innerVoice: false });
        expect(direct).not.toContain(MIX_INNER_VOICE_OPEN);
        expect(direct).not.toContain("每条消息");

        const group = assembleChatroomPrompt({
            speaker,
            members: [speaker, other],
            worldCard: speaker,
            innerVoice: true,
        });
        expect(group).toContain("周叙");
    });

    it("前情给了就出现，没给就整段消失", () => {
        const withPlot = assembleChatroomPrompt({
            speaker,
            members: [speaker],
            worldCard: speaker,
            innerVoice: false,
            plotContext: "昨晚你们吵了一架。",
        });
        expect(withPlot).toContain("# 前情提要");
        expect(withPlot).toContain("昨晚你们吵了一架。");
        const withoutPlot = assembleChatroomPrompt({
            speaker,
            members: [speaker],
            worldCard: speaker,
            innerVoice: false,
        });
        expect(withoutPlot).not.toContain("# 前情提要");
    });
});

describe("chatroom: 消息组装与历史裁剪", () => {
    it("群聊历史带说话人前缀，私聊不带；用户消息在末尾", () => {
        const history: MixPhoneMessage[] = [
            { id: "1", role: "user", text: "在吗", createdAt: 1 },
            { id: "2", role: "assistant", speaker: "林晚", text: "嗯", createdAt: 2 },
        ];
        const messages = buildChatroomMessages({
            system: "SYS",
            history,
            labelSpeakers: true,
            userName: "小舟",
            userMessage: "吃了吗",
        });
        expect(messages[0]).toMatchObject({ role: "system", content: "SYS" });
        expect(messages[1]).toMatchObject({ role: "user", content: "小舟：在吗" });
        expect(messages[2]).toMatchObject({ role: "assistant", content: "林晚：嗯" });
        expect(messages.at(-1)).toMatchObject({ role: "user", content: "吃了吗" });

        const direct = buildChatroomMessages({
            system: "SYS",
            history,
            labelSpeakers: false,
            userName: "小舟",
            userMessage: "吃了吗",
        });
        expect(direct[1]).toMatchObject({ role: "user", content: "在吗" });
        expect(direct[2]).toMatchObject({ role: "assistant", content: "嗯" });
    });

    it("capChatHistory 只留最近 N 条", () => {
        const history: MixPhoneMessage[] = [
            { id: "1", role: "user", text: "1", createdAt: 1 },
            { id: "2", role: "assistant", text: "2", createdAt: 2 },
            { id: "3", role: "user", text: "3", createdAt: 3 },
        ];
        expect(capChatHistory(history, 2).map((m) => m.id)).toEqual(["2", "3"]);
        expect(capChatHistory(history, 0)).toEqual([]);
        expect(capChatHistory(history, 10)).toHaveLength(3);
    });
});

describe("chatroom: 回复策略", () => {
    const jia = card("甲");
    const yi = card("乙");
    const bing = card("丙");
    const members = [jia, yi, bing];

    it("点名命中谁就谁回，按消息里出现的顺序去重", () => {
        expect(pickChatResponders({ message: "甲乙出来玩", members, lastSpeakerName: null, policy: "mention" }))
            .toEqual([jia, yi]);
    });

    it("点名未命中回落轮流：接在上一个说话人后面", () => {
        expect(pickChatResponders({ message: "都有谁在", members, lastSpeakerName: "甲", policy: "mention" }))
            .toEqual([yi]);
        expect(pickChatResponders({ message: "都有谁在", members, lastSpeakerName: "丙", policy: "roundrobin" }))
            .toEqual([jia]);
    });

    it("轮流不认识上一个说话人时从第一位开始；all 全员按序", () => {
        expect(pickChatResponders({ message: "嗨", members, lastSpeakerName: "路人", policy: "roundrobin" }))
            .toEqual([jia]);
        expect(pickChatResponders({ message: "嗨", members, lastSpeakerName: null, policy: "all" }))
            .toEqual(members);
    });
});

describe("chatroom: 写回与状态沿用", () => {
    const baseTurns: MixTurn[] = [
        { id: "s1", role: "user", text: "推剧情", createdAt: 1 },
        { id: "s2", role: "assistant", text: "剧情回复", createdAt: 2, state: { 好感度: "70" } },
    ];

    it("msg 轮带上频道/会话/说话人，state 快照沿用最近一轮现值", () => {
        const userTurn = makeChatTurn({
            role: "user",
            text: "在吗",
            threadId: "th1",
            threadLabel: "林晚",
            baseTurns,
        });
        expect(userTurn).toMatchObject({
            role: "user",
            text: "在吗",
            channel: "msg",
            threadId: "th1",
            state: { 好感度: "70" },
        });
        const reply = makeChatTurn({
            role: "assistant",
            text: "嗯",
            speaker: "林晚",
            threadId: "th1",
            threadLabel: "林晚",
            baseTurns: [...baseTurns, userTurn],
        });
        expect(reply).toMatchObject({ role: "assistant", speaker: "林晚", channel: "msg" });
        expect(reply.state).toEqual({ 好感度: "70" });
    });

    it("没有历史时 state 留空，不凭空造值", () => {
        const turn = makeChatTurn({ role: "user", text: "嗨", threadId: "th", baseTurns: [] });
        expect(turn.state).toBeUndefined();
    });
});

describe("chatroom: 前情提要", () => {
    const turns: MixTurn[] = [
        { id: "1", role: "user", text: "开场", createdAt: 1 },
        { id: "2", role: "assistant", text: "第一幕正文", createdAt: 2 },
        { id: "3", role: "assistant", text: "手机消息不算剧情", createdAt: 3, channel: "msg", speaker: "林晚" },
        { id: "4", role: "user", text: "继续", createdAt: 4 },
        { id: "5", role: "assistant", text: "第二幕正文", createdAt: 5 },
        { id: "6", role: "assistant", text: "第三幕正文", createdAt: 6 },
    ];

    it("只取 scene 的 assistant 轮，受轮数限制；状态行按开关", () => {
        const ctx = buildChatroomPlotContext(
            { turns, state: { 好感度: "70", 心情: "复杂" } },
            { plotContextTurns: 2, includeState: true },
        );
        expect(ctx).toContain("【当前状态】好感度：70；心情：复杂");
        expect(ctx).not.toContain("第一幕正文");
        expect(ctx).toContain("第二幕正文");
        expect(ctx).toContain("第三幕正文");
        expect(ctx).not.toContain("手机消息不算剧情");

        const noState = buildChatroomPlotContext(
            { turns, state: { 好感度: "70" } },
            { plotContextTurns: 2, includeState: false },
        );
        expect(noState).not.toContain("当前状态");
    });

    it("轮数为 0 或没有剧情时返回 null", () => {
        expect(buildChatroomPlotContext({ turns: [], state: {} }, { plotContextTurns: 6, includeState: true })).toBeNull();
        expect(
            buildChatroomPlotContext({ turns, state: {} }, { plotContextTurns: 0, includeState: true }),
        ).toBeNull();
    });
});

describe("chatroom: 生成调用", () => {
    it("走特调配置：preset=null、regexes=[]、appTags 带 chatroom，历史与系统段齐全", async () => {
        llmMock.streamImpl = () => ({ content: "好", usage: { total_tokens: 9 } });
        const deltas: string[] = [];
        const result = await runChatroomReply({
            system: "SYS-聊天",
            history: [{ id: "1", role: "user", text: "在吗", createdAt: 1 }],
            labelSpeakers: true,
            userName: "小舟",
            characterName: "林晚",
            userMessage: "睡了吗",
            onDelta: (d) => deltas.push(d),
        });
        expect(result.text).toBe("好");
        expect(result.usage?.total_tokens).toBe(9);
        expect(deltas.join("")).toBe("好");
        expect(llmMock.streamCalls).toHaveLength(1);
        const [config, preset, messages, regexes, meta, options] = llmMock.streamCalls[0] as [
            unknown,
            unknown,
            { role: string; content: string }[],
            unknown,
            unknown,
            { appTags?: string[] },
        ];
        expect((config as { id: string }).id).toBe("test-config");
        expect(preset).toBeNull();
        expect(regexes).toEqual([]);
        expect(options.appTags).toContain("chatroom");
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain("聊天");
        expect(messages[1]).toMatchObject({ role: "user", content: "小舟：在吗" });
        expect(messages.at(-1)).toMatchObject({ role: "user", content: "睡了吗" });
        expect(meta).toMatchObject({ userName: "小舟" });
    });

    it("流式一个字没来就报错时退回一次性请求", async () => {
        llmMock.streamError = new Error("SSE 不支持");
        const result = await runChatroomReply({
            system: "SYS",
            history: [],
            labelSpeakers: false,
            userName: "你",
            characterName: "林晚",
            userMessage: "嗨",
        });
        expect(result.text).toBe("兜底内容");
        expect(llmMock.nonStreamCalls).toHaveLength(1);
    });
});
