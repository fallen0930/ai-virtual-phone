import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvGet } from "@/lib/kv-db";
import * as storageModule from "@/lib/narrative-writer/storage";
import { extractFromTurn } from "@/lib/narrative-writer/extractor";
import * as writerModule from "@/lib/narrative-writer/writer";
import { createDefaultWriterState } from "@/lib/narrative-writer/types";
import type { EmotionCard, MemoryCard } from "@/lib/narrative-writer/types";

// audience 认知隔离测试
//
// 覆盖什么：
// 1) 写入侧规范化——audience 由代码归一化后才入库，不信模型给的值；非法元素丢弃、缺失/空/非数组一律 ["all"]；
//    旧别名 "character" → 本会话当前角色名，"narrator" → "system"。
// 2) 写正文＝角色视角：只看得到 all 与自己名下的卡，玩家私密/系统预埋/别人私密的卡不得进入上下文。
// 3) 生成走向卡＝导演视角：不按角色过滤，但每张卡带知情范围标注，system 卡标「未揭示」，
//    并有一条靠后的红线；条数仍受原有 5+3 上限约束，截断时优先保留悬念素材（system/user）。
// 4) 作用域：走向卡排除「现实层」，「待确认」与缺失仍可用。
// 5) 旧数据（无 audience）视为共同知晓。
//
// 只 mock 两处：大模型入口 sendLLMRequest，与住在 mixology/engine 里的 resolveMixApiConfig 桩
// （真模块会把整条引擎依赖图拖进 Node）。**本文件不 import mixology/engine**，
// 走真实实现的是：抽取落库、写正文、生成走向卡、上下文拼装。
//
// 尚未实现的 API 用可选签名访问，让「还没实现」表现为断言失败而不是模块解析错误。

type WriterAudienceApi = {
  visibleToCharacter?: <T extends { audience?: unknown }>(
    cards: T[],
    当前角色标识: string
  ) => T[];
  buildContinuityContext?: (
    memories: MemoryCard[],
    emotions: EmotionCard[],
    waterLevels: Record<string, unknown>,
    writerState: ReturnType<typeof createDefaultWriterState>,
    hierarchy?: unknown,
    view?: { 视角: "角色" } | { 视角: "导演" }
  ) => string;
};
const writerApi = writerModule as unknown as WriterAudienceApi;

type MemoryRaw = Record<string, unknown> & { audience?: unknown };

const llmMock = vi.hoisted(() => ({
  calls: 0,
  respond: null as null | (() => string),
  // 每次调用记下 { characterName, content }，用来检查真正发给大模型的上下文
  requests: [] as Array<{ characterName: string; content: string }>,
}));

vi.mock("@/lib/chat-engine", () => ({
  sendLLMRequest: async (
    _apiConfig: unknown,
    _preset: unknown,
    messages: Array<{ role: string; content: string }>,
    _regexes: unknown,
    meta?: { characterName?: string }
  ) => {
    llmMock.calls += 1;
    const last = messages[messages.length - 1];
    llmMock.requests.push({
      characterName: meta?.characterName ?? "",
      content: String(last?.content ?? ""),
    });
    return llmMock.respond ? llmMock.respond() : "[]";
  },
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

const createdSessionIds = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testaud_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  createdSessionIds.add(sid);
  return sid;
}

function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 卡的内容都带唯一前缀，断言时直接查这个标记，不依赖整行文案 */
function markOf(tag: string): string {
  return `【${tag}】`;
}

const BASE_TIME = 1_700_000_000_000;

function mkMemory(
  tag: string,
  audience: unknown,
  opts: { 作用域?: unknown; updatedAt?: number; 状态?: string } = {}
): MemoryCard {
  return {
    id: `aud_m_${tag}_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: `${markOf(tag)}这条记忆的内容`,
    作用域: opts.作用域 ?? "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: opts.状态 ?? "生效",
    证据: "测试夹具",
    时间: "第1天",
    audience,
    createdAt: opts.updatedAt ?? BASE_TIME,
    updatedAt: opts.updatedAt ?? BASE_TIME,
  } as unknown as MemoryCard;
}

function mkEmotion(
  tag: string,
  audience: unknown,
  opts: { 作用域?: unknown; updatedAt?: number } = {}
): EmotionCard {
  return {
    id: `aud_e_${tag}_${rand()}`,
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "兴奋",
    强度: 0.7,
    对象: markOf(tag),
    作用域: opts.作用域 ?? "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    证据: "测试夹具",
    audience,
    createdAt: opts.updatedAt ?? BASE_TIME,
    updatedAt: opts.updatedAt ?? BASE_TIME,
  } as unknown as EmotionCard;
}

async function seed(
  sid: string,
  memories: MemoryCard[],
  emotions: EmotionCard[] = []
): Promise<void> {
  for (const m of memories) await storageModule.saveMemoryCard(sid, m);
  for (const e of emotions) await storageModule.saveEmotionCard(sid, e);
}

/** 夹具：4 张正常卡 + 1 张 audience 为非法值的卡 */
function baseFixture(): MemoryCard[] {
  return [
    mkMemory("明面", ["all"]),
    mkMemory("角色A秘密", ["角色A"]),
    mkMemory("玩家想法", ["user"]),
    mkMemory("系统真相", ["system"]),
    // 非法值：既不是 all/user/system，也不是本会话角色名
    mkMemory("坏值", ["灯塔编号"]),
  ];
}

function writerInput(sid: string, charName: string) {
  return {
    sessionId: sid,
    characterProfile: { charName, profileText: "角色资料", worldText: "世界观" },
    worldSettings: {
      basePrompts: [] as string[],
      flavorPrompts: [] as string[],
      glassPrompts: [] as string[],
      strengthPrompts: [] as string[],
    },
    recentDialogue: "玩家：今天天气不错",
  };
}

/** 取最近一次 NarrativeWriter 请求里真正拼进去的连续性上下文 */
function lastContinuityContext(): string {
  const req = llmMock.requests.filter((r) => r.characterName === "NarrativeWriter").pop();
  if (!req) throw new Error("没有发出执笔请求");
  try {
    return String(JSON.parse(req.content).连续性上下文 ?? "");
  } catch {
    throw new Error("执笔请求不是 JSON");
  }
}

function memoryLineCount(ctx: string, tag: string): number {
  return ctx.split("\n").filter((line) => line.includes(markOf(tag))).length;
}

function emotionPayload(
  内容: string,
  audience: unknown
): Record<string, unknown> {
  return {
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "兴奋",
    强度: 0.7,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    证据: 内容,
    audience,
  };
}

function memoryPayload(
  内容: string,
  audience?: unknown
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    时间: "第1天",
    证据: 内容,
  };
  if (audience !== undefined) base.audience = audience;
  return base;
}

/** 把该会话所有记忆卡的落盘原文读出来，按 内容 → audience 建表。
 *  读的是 kv 里的 JSON 原文，证明规范化真的写进了存储，而不是只改了内存对象。 */
async function rawAudiencesOfMemories(
  sid: string
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const card of await storageModule.listMemoryCards(sid)) {
    const raw = kvGet(`narrative:${sid}:memory:${card.id}`);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as MemoryRaw;
    out[String(parsed.内容)] = parsed.audience;
  }
  return out;
}

/** 同上，情感卡按 证据 索引 */
async function rawAudiencesOfEmotions(
  sid: string
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const card of await storageModule.listEmotionCards(sid)) {
    const raw = kvGet(`narrative:${sid}:emotion:${card.id}`);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as MemoryRaw;
    out[String(parsed.证据)] = parsed.audience;
  }
  return out;
}

beforeEach(() => {
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests = [];
});

afterEach(() => {
  for (const sid of createdSessionIds) storageModule.purgeNarrativeSessionData(sid);
  createdSessionIds.clear();
});

describe("audience 写入侧：入库规范化", () => {
  it("1. 模型给的 audience 由代码归一化后才落库：别名映射、非法元素丢弃、缺失/空/非数组一律 all", async () => {
    const sid = makeSessionId("normalize");
    llmMock.respond = () =>
      JSON.stringify([
        memoryPayload("别名character", ["character"]),
        memoryPayload("别名narrator", ["narrator"]),
        memoryPayload("混合非法", ["灯塔编号", "user"]),
        memoryPayload("全非法", ["everyone", "全部"]),
        memoryPayload("非数组", "all"),
        memoryPayload("空数组", []),
        memoryPayload("缺失"),
        memoryPayload("原样保留", ["all", "system", "角色A"]),
        emotionPayload("情感卡别名", ["character"]),
      ]);

    await extractFromTurn(sid, "正文", [], {
      isPlotMode: true,
      existingCardsSummary: [],
      currentWaterLevels: {},
      characterName: "角色A",
    } as unknown as Parameters<typeof extractFromTurn>[3]);

    // 先取全部落盘原文，再逐条对照 audience（证明规范化进了存储，不只是内存对象）
    const audienceOf = await rawAudiencesOfMemories(sid);

    // "character" 是旧别名，含义是「本会话当前角色」→ 换成角色名
    expect(audienceOf["别名character"]).toEqual(["角色A"]);
    // "narrator" 归到 system
    expect(audienceOf["别名narrator"]).toEqual(["system"]);
    // 非法元素丢弃，合法元素留下
    expect(audienceOf["混合非法"]).toEqual(["user"]);
    // 全部非法 → 结果为空 → 退到 all
    expect(audienceOf["全非法"]).toEqual(["all"]);
    // 非数组 → 丢弃模型给的值，退到 all
    expect(audienceOf["非数组"]).toEqual(["all"]);
    expect(audienceOf["空数组"]).toEqual(["all"]);
    // 缺失 → all
    expect(audienceOf["缺失"]).toEqual(["all"]);
    // 合法值原样保留，且顺序不引入重复
    expect(audienceOf["原样保留"]).toEqual([
      "all",
      "system",
      "角色A",
    ]);
    // 情感卡走同一套规范化
    const 情感audience = await rawAudiencesOfEmotions(sid);
    expect(情感audience["情感卡别名"]).toEqual(["角色A"]);
  });
});

describe("audience 读侧：写正文＝角色视角", () => {
  it("2. 当前角色为 A：只看得到共同知晓与自己名下的卡", async () => {
    const sid = makeSessionId("view-a");
    await seed(sid, baseFixture());
    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文。";

    await writerModule.writeNarrative(writerInput(sid, "角色A") as never);

    const ctx = lastContinuityContext();
    expect(ctx).toContain(markOf("明面"));
    // 现状：字面量 "character" 之外的角色名一律被过滤掉，A 看不到自己的私密卡
    expect(ctx).toContain(markOf("角色A秘密"));
    expect(ctx).not.toContain(markOf("玩家想法"));
    expect(ctx).not.toContain(markOf("系统真相"));
    expect(ctx).not.toContain(markOf("坏值"));
  });

  it("3. 当前角色为 B：看得到自己的私密卡，看不到 A 的", async () => {
    const sid = makeSessionId("view-b");
    await seed(sid, [...baseFixture(), mkMemory("角色B秘密", ["角色B"])]);
    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文。";

    await writerModule.writeNarrative(writerInput(sid, "角色B") as never);

    const ctx = lastContinuityContext();
    expect(ctx).toContain(markOf("明面"));
    expect(ctx).toContain(markOf("角色B秘密"));
    expect(ctx).not.toContain(markOf("角色A秘密"));
    expect(ctx).not.toContain(markOf("玩家想法"));
    expect(ctx).not.toContain(markOf("系统真相"));
  });

  it("5. 旧数据（无 audience）与旧别名卡视为本会话当前角色可见", async () => {
    const sid = makeSessionId("legacy");
    expect(typeof writerApi.visibleToCharacter).toBe("function");
    const legacy = [
      { id: "1", 内容: "没有 audience 字段的旧卡" },
      { id: "2", audience: [], 内容: "空数组" },
      { id: "3", audience: ["character"], 内容: "旧别名卡" },
      { id: "4", audience: ["narrator"], 内容: "旧旁白卡" },
      { id: "5", audience: ["user"], 内容: "玩家私密" },
      { id: "6", audience: ["角色A"], 内容: "A 的私密" },
    ];
    const visible = writerApi.visibleToCharacter!(legacy, "角色B");
    const ids = visible.map((c) => c.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).toContain("3");
    expect(ids).not.toContain("4");
    expect(ids).not.toContain("5");
    expect(ids).not.toContain("6");
  });
});

describe("audience 读侧：生成走向卡＝导演视角", () => {
  it("4. 走向卡拿到全部生效卡与知情范围标注，system 卡标未揭示，末尾有红线", async () => {
    const sid = makeSessionId("director");
    await seed(sid, baseFixture());
    llmMock.respond = () =>
      [
        "（基调：日常｜场景：灯塔｜走向：闲聊）",
        "（基调：推进｜场景：灯塔｜走向：追问）",
        "（基调：转折｜场景：灯塔｜注意：会有一个揭示）",
        "（基调：缓冲｜场景：灯塔｜走向：独处）",
      ].join("\n");

    await writerModule.generateBannerOptions(writerInput(sid, "角色A") as never);

    const ctx = lastContinuityContext();
    // 导演出全场：4 张正常卡都在（坏值卡按规则也进上下文，见用例 4 的标注断言）
    expect(ctx).toContain(markOf("明面"));
    expect(ctx).toContain(markOf("角色A秘密"));
    expect(ctx).toContain(markOf("玩家想法"));
    expect(ctx).toContain(markOf("系统真相"));
    // 知情范围标注
    expect(ctx).toContain("[共同知晓]");
    expect(ctx).toContain("[仅角色A知情]");
    expect(ctx).toContain("[仅玩家知情]");
    expect(ctx).toContain("[系统预埋·未揭示]");
    // 红线一句：必须存在，且放在靠后位置（在卡列表与状态段之后）
    const lines = ctx.split("\n");
    const 红线行 = lines.findIndex((l) => l.includes("知情差异"));
    const 最后一张卡行 = lines.reduce(
      (acc, l, i) => (l.startsWith("- ") && i > acc ? i : acc),
      -1
    );
    expect(红线行).toBeGreaterThan(-1);
    expect(红线行).toBeGreaterThan(最后一张卡行);
    expect(lines[红线行]).toContain("系统预埋·未揭示");
  });

  it("6. 走向卡排除作用域「现实层」的卡", async () => {
    expect(typeof writerApi.buildContinuityContext).toBe("function");
    const cards = [
      mkMemory("明面", ["all"]),
      mkMemory("戏外聊天", ["all"], { 作用域: "现实层" }),
    ];
    const ctx = writerApi.buildContinuityContext!(
      cards,
      [],
      {},
      createDefaultWriterState("director-scope"),
      null,
      { 视角: "导演" }
    );
    expect(ctx).toContain(markOf("明面"));
    expect(ctx).not.toContain(markOf("戏外聊天"));
  });

  it("7. 导演上下文条数不超过原有上限（记忆 ≤5、情感 ≤3），截断优先保留悬念素材", async () => {
    expect(typeof writerApi.buildContinuityContext).toBe("function");
    // 悬念素材故意给最旧的 updatedAt：按原有排序会被截掉
    const old = BASE_TIME - 1_000_000;
    const cards = [
      mkMemory("M1", ["all"]),
      mkMemory("M2", ["all"]),
      mkMemory("M3", ["all"]),
      mkMemory("M4", ["all"]),
      mkMemory("M5", ["all"]),
      mkMemory("M6", ["all"]),
      mkMemory("M7", ["system"], { updatedAt: old }),
      mkMemory("M8", ["user"], { updatedAt: old }),
    ];
    const emotions = [
      mkEmotion("E1", ["all"]),
      mkEmotion("E2", ["all"]),
      mkEmotion("E3", ["all"]),
      mkEmotion("E4", ["system"], { updatedAt: old }),
      mkEmotion("E5", ["user"], { updatedAt: old }),
    ];
    const ctx = writerApi.buildContinuityContext!(
      cards,
      emotions,
      {},
      createDefaultWriterState("director-cap"),
      null,
      { 视角: "导演" }
    );
    const 记忆行 = ctx.split("\n").filter((l) => /【M\d】/.test(l)).length;
    const 情感行 = ctx.split("\n").filter((l) => l.includes("瞬时情绪：")).length;
    expect(记忆行).toBeLessThanOrEqual(5);
    expect(情感行).toBeLessThanOrEqual(3);
    // 悬念素材（system/user）优先保留，哪怕排序靠后
    expect(ctx).toContain(markOf("M7"));
    expect(ctx).toContain(markOf("M8"));
    expect(ctx).toContain(markOf("E4"));
  });

  it("8. 作用域「待确认」与缺失作用域参照常在，只排除现实层", async () => {
    expect(typeof writerApi.buildContinuityContext).toBe("function");
    const cards = [
      mkMemory("待确认", ["all"], { 作用域: "待确认" }),
      mkMemory("共识层", ["all"], { 作用域: "共识层" }),
      mkMemory("没有作用域", ["all"], { 作用域: undefined }),
    ];
    const ctx = writerApi.buildContinuityContext!(
      cards,
      [],
      {},
      createDefaultWriterState("director-scope-2"),
      null,
      { 视角: "导演" }
    );
    expect(ctx).toContain(markOf("待确认"));
    expect(ctx).toContain(markOf("共识层"));
    expect(ctx).toContain(markOf("没有作用域"));
    expect(memoryLineCount(ctx, "待确认")).toBe(1);
  });
});
