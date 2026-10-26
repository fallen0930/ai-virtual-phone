import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildProactivePrompt,
    markProactiveJudged,
    markProactivePing,
    maybeEnqueueProactiveCheck,
    parseProactiveVerdict,
    runProactiveVerdict,
    shouldJudgeProactive,
} from "@/lib/mixology/chatroom-proactive";
import { createMixPhoneWorld, findDirectThread, getMixPhoneWorld } from "@/lib/mixology/chatroom-storage";
import { getMixSession, saveMixSession, saveMixMaterial } from "@/lib/mixology/storage";
import { createMixId, type MixCharacterCard, type MixSession, type MixTurn } from "@/lib/mixology/types";
import { normalizeMixPhoneWorld } from "@/lib/mixology/chatroom-types";

// 聊天室（手机频道）· 主动消息
//
// 钉住的规则：
//   A 节奏：开关关 = 永不判；everyRounds 控判定频率；cooldown 控两次主动消息最小间隔；
//     首次（无记忆）放行。
//   B 判定输出是严格 JSON：{"trigger":false} 或 {"trigger":true,memberId,text,innerVoice?}；
//     坏输出/超时/异常一律 null（静默跳过，绝不影响对局）。
//   C 命中后：写进该成员的私聊（direct thread，惰性建），msg 轮带 speaker 与 threadLabel，
//     心声以 〔心声〕 壳并进 text；对局 turns 只增不改；world 记 lastPingRounds。
//   D 判定过就记 lastJudgedRounds（包括 trigger=false 的那次），冷却只记在真发消息时。

const llmMock = vi.hoisted(() => ({
    respond: null as null | (() => string),
    calls: [] as unknown[][],
}));

vi.mock("@/lib/mixology/engine", () => ({
    resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

vi.mock("@/lib/chat-engine", () => ({
    sendLLMRequest: async (...args: unknown[]) => {
        llmMock.calls.push(args);
        if (!llmMock.respond) throw new Error("no response configured");
        return llmMock.respond();
    },
}));

const rand = () => createMixId(`t${Math.floor(Math.random() * 1e9)}`);

function card(id: string, name: string): MixCharacterCard {
    return { id, kind: "character", name, charName: name, openings: [], createdAt: 0, updatedAt: 0 };
}

function sceneTurns(rounds: number): MixTurn[] {
    const turns: MixTurn[] = [];
    for (let i = 0; i < rounds; i += 1) {
        turns.push({ id: rand(), role: "user", text: `剧情发言${i}`, createdAt: i * 2 });
        turns.push({ id: rand(), role: "assistant", text: `剧情回复${i}`, createdAt: i * 2 + 1 });
    }
    return turns;
}

function makeSession(rounds: number): MixSession {
    return {
        id: rand(),
        recipe: { id: rand(), name: "配方", slots: {}, createdAt: 0, updatedAt: 0 },
        charName: "林晚",
        openingIndex: 0,
        turns: sceneTurns(rounds),
        updatedAt: 0,
        createdAt: 0,
    } as MixSession;
}

afterEach(() => {
    llmMock.respond = null;
    llmMock.calls = [];
});

describe("chatroom: 主动消息节奏", () => {
    it("开关关掉永不判；首次（无记忆）放行", () => {
        const off = createMixPhoneWorld({ memberIds: [] });
        off.settings.proactive = false;
        expect(shouldJudgeProactive(off, 5)).toBe(false);

        const on = createMixPhoneWorld({ memberIds: [] });
        expect(shouldJudgeProactive(on, 1)).toBe(true);
    });

    it("everyRounds 控判定频率；cooldown 控两次主动消息最小间隔", () => {
        const world = createMixPhoneWorld({ memberIds: [] });
        world.settings.proactiveEveryRounds = 2;
        expect(shouldJudgeProactive(world, 1)).toBe(true);
        const judged = markProactiveJudged(world, 1);
        expect(shouldJudgeProactive(judged, 2)).toBe(false); // 才过 1 轮
        expect(shouldJudgeProactive(judged, 3)).toBe(true);  // 过了 2 轮

        const pinged = markProactivePing(judged, 3);
        expect(shouldJudgeProactive(pinged, 4)).toBe(false); // 冷却 3 轮内
        expect(shouldJudgeProactive(pinged, 6)).toBe(true);  // 冷却已过
    });
});

describe("chatroom: 判定输出解析", () => {
    it("false / true / 带 json 围栏 / 心声可选都能读", () => {
        expect(parseProactiveVerdict('{"trigger": false}')).toEqual({ trigger: false });
        expect(parseProactiveVerdict('{"trigger":true,"memberId":"m1","text":"在忙吗"}')).toEqual({
            trigger: true, memberId: "m1", text: "在忙吗",
        });
        expect(parseProactiveVerdict('```json\n{"trigger":true,"memberId":"m1","text":"嗨","innerVoice":"想她了"}\n```')).toEqual({
            trigger: true, memberId: "m1", text: "嗨", innerVoice: "想她了",
        });
    });

    it("坏输出一律 null：不是 JSON / trigger=true 缺 text / 缺 memberId", () => {
        expect(parseProactiveVerdict("我觉得她今天会想找你聊聊")).toBeNull();
        expect(parseProactiveVerdict('{"trigger":true,"memberId":"m1"}')).toBeNull();
        expect(parseProactiveVerdict('{"trigger":true,"text":"嗨"}')).toBeNull();
        expect(parseProactiveVerdict("")).toBeNull();
    });
});

describe("chatroom: 判定提示词与调用", () => {
    it("提示词带成员清单/前情/判定规则与 JSON 样例", () => {
        const world = createMixPhoneWorld({ memberIds: ["m1"], sessionId: undefined });
        const member = card("m1", "林晚");
        const { system, user } = buildProactivePrompt({
            world,
            session: makeSession(3),
            members: [member],
            userName: "小舟",
        });
        expect(system).toContain("m1");
        expect(system).toContain("林晚");
        expect(system).toContain("剧情回复2");
        expect(system).toContain("判定规则");
        expect(user).toContain("trigger");
        expect(user).toContain("JSON");
    });

    it("调用返回解析结果；模型异常时静默 null", async () => {
        const world = createMixPhoneWorld({ memberIds: [] });
        llmMock.respond = () => '{"trigger":true,"memberId":"m1","text":"今晚月色真好"}';
        const verdict = await runProactiveVerdict({
            world,
            session: makeSession(2),
            members: [card("m1", "林晚")],
            userName: "你",
        });
        expect(verdict).toEqual({ trigger: true, memberId: "m1", text: "今晚月色真好" });

        llmMock.respond = () => { throw new Error("接口炸了"); };
        await expect(
            runProactiveVerdict({ world, session: makeSession(2), members: [], userName: "你" }),
        ).resolves.toBeNull();
    });
});

describe("chatroom: 命中后的写回", () => {
    it("trigger 命中：写进私聊 msg 轮（含心声壳），建 direct thread，world 记账", async () => {
        const session = makeSession(2);
        saveMixSession(session);
        // 成员必须是酒柜里的真实角色卡（引擎按 memberIds 现取酒柜）
        saveMixMaterial({
            id: "m1",
            kind: "character",
            name: "林晚",
            charName: "林晚",
            openings: [],
            createdAt: 0,
            updatedAt: 0,
        });
        const world = createMixPhoneWorld({ sessionId: session.id, memberIds: ["m1"] });
        llmMock.respond = () => JSON.stringify({
            trigger: true, memberId: "m1", text: "睡了吗", innerVoice: "其实想说的是想你了",
        });

        maybeEnqueueProactiveCheck({ world, session });
        await vi.waitFor(() => {
            const fresh = getMixSession(session.id);
            expect(fresh?.turns.some((t) => t.channel === "msg")).toBe(true);
        });

        const thread = findDirectThread(world.id, "m1");
        expect(thread).not.toBeNull();
        const fresh = getMixSession(session.id)!;
        const msgTurn = fresh.turns.at(-1)!;
        expect(msgTurn).toMatchObject({
            role: "assistant",
            channel: "msg",
            speaker: "林晚",
            threadId: thread!.id,
        });
        expect(msgTurn.text).toContain("睡了吗");
        expect(msgTurn.text).toContain("〔心声〕其实想说的是想你了");
        const worldAfter = getMixPhoneWorld(world.id)!;
        expect(worldAfter.proactive?.lastPingRounds).toBeGreaterThan(0);
        expect(worldAfter.proactive?.lastJudgedRounds).toBeGreaterThan(0);
    });

    it("trigger 不命中：什么都不写，只记判定账", async () => {
        const session = makeSession(2);
        saveMixSession(session);
        const world = createMixPhoneWorld({ sessionId: session.id, memberIds: ["m1"] });
        llmMock.respond = () => '{"trigger": false}';

        maybeEnqueueProactiveCheck({ world, session });
        await vi.waitFor(() => {
            expect(getMixPhoneWorld(world.id)?.proactive?.lastJudgedRounds).toBeGreaterThan(0);
        });
        expect(getMixSession(session.id)!.turns.every((t) => t.channel !== "msg")).toBe(true);
        expect(findDirectThread(world.id, "m1")).toBeNull();
    });

    it("旧数据缺 proactive 字段时归一不炸", () => {
        const world = createMixPhoneWorld({ memberIds: [] });
        const raw = JSON.parse(JSON.stringify(world)) as Record<string, unknown>;
        delete raw.proactive;
        const fixed = normalizeMixPhoneWorld(raw);
        expect(fixed.proactive).toBeUndefined();
        expect(shouldJudgeProactive(fixed, 1)).toBe(true);
    });
});
