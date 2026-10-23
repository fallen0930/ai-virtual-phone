import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvGet } from "@/lib/kv-db";
import * as storageModule from "@/lib/narrative-writer/storage";
import { extractFromTurn } from "@/lib/narrative-writer/extractor";
import * as writerModule from "@/lib/narrative-writer/writer";
import { createDefaultWriterState } from "@/lib/narrative-writer/types";
import type { EmotionCard, MemoryCard } from "@/lib/narrative-writer/types";

// 待核卡参与走向卡
//
// 覆盖什么：
// 1) 导演视角（生成走向卡）：待核卡可以进入上下文当线索用，但每条带「（未确认）」，
//    生效卡优先占位，待核卡只填剩余名额，且最多占记忆 3 条 / 情感 1 条；
//    待核内部按置信度从高到低、再按新近排序。
// 2) 角色视角（写正文）：待核卡一律不进上下文，直到玩家确认。角色分支还有一道
//    防御性过滤——就算调用方误传了非生效卡，也不渲染。
// 3) 批量确认：confirmAllPendingCards 只把「当前会话」的待核卡转生效，
//    归档 / 冲突 / 陈旧一律不碰。
// 4) 入库状态门槛（代码说了算，不信模型）：置信度低于该类卡「中」档阈值的新卡
//    强制待核但不丢弃；主类型「世界变更」的新卡强制待核；其余沿用模型给的状态。
//
// 只 mock 两处：大模型入口 sendLLMRequest，与住在 mixology/engine 里的 resolveMixApiConfig 桩。
// **本文件不 import mixology/engine**，走真实实现的是：抽取落库、写正文、生成走向卡、上下文拼装、批量确认。
//
// 尚未实现的 API 用可选签名访问，让「还没实现」表现为断言失败而不是模块解析错误。

type WriterPendingApi = {
  buildContinuityContext?: (
    memories: MemoryCard[],
    emotions: EmotionCard[],
    waterLevels: Record<string, unknown>,
    writerState: ReturnType<typeof createDefaultWriterState>,
    hierarchy?: unknown,
    view?: { 视角: "角色" } | { 视角: "导演" }
  ) => string;
};
type StoragePendingApi = {
  confirmAllPendingCards?: (
    sessionId: string
  ) => Promise<{ memories: number; emotions: number }>;
};
const writerApi = writerModule as unknown as WriterPendingApi;
const storageApi = storageModule as unknown as StoragePendingApi;

const llmMock = vi.hoisted(() => ({
  calls: 0,
  respond: null as null | (() => string),
  // 每次调用记下 { characterName, content, system }：content 是真发给大模型的用户消息，
  // system 是系统提示（用来检查提示词里关于「未确认」的那一句确实补上了）
  requests: [] as Array<{
    characterName: string;
    content: string;
    system: string;
  }>,
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
      system: String(messages.find((m) => m.role === "system")?.content ?? ""),
    });
    return llmMock.respond ? llmMock.respond() : "[]";
  },
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

const createdSessionIds = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testpend_${tag}_${Date.now().toString(36)}_${Math.random()
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

interface CardOpts {
  作用域?: unknown;
  updatedAt?: number;
  状态?: string;
  置信度?: number;
  主类型?: string;
}

function mkMemory(tag: string, audience: unknown, opts: CardOpts = {}): MemoryCard {
  return {
    id: `pd_m_${tag}_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: opts.主类型 ?? "经历节点",
    内容: `${markOf(tag)}这条记忆的内容`,
    作用域: opts.作用域 ?? "戏内层",
    置信档: "高",
    置信度: opts.置信度 ?? 0.9,
    状态: opts.状态 ?? "生效",
    证据: "测试夹具",
    时间: "第1天",
    audience,
    createdAt: opts.updatedAt ?? BASE_TIME,
    updatedAt: opts.updatedAt ?? BASE_TIME,
  } as unknown as MemoryCard;
}

function mkEmotion(tag: string, audience: unknown, opts: CardOpts = {}): EmotionCard {
  return {
    id: `pd_e_${tag}_${rand()}`,
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "兴奋",
    强度: 0.7,
    对象: markOf(tag),
    作用域: opts.作用域 ?? "戏内层",
    置信档: "高",
    置信度: opts.置信度 ?? 0.9,
    状态: opts.状态 ?? "生效",
    // 证据带上标记，便于直接查落盘原文（情感卡的正文渲染用的是 对象）
    证据: markOf(tag),
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

const BANNERS = [
  "（基调：日常｜场景：灯塔｜走向：闲聊）",
  "（基调：推进｜场景：灯塔｜走向：追问）",
  "（基调：转折｜场景：灯塔｜注意：会有一个揭示）",
  "（基调：缓冲｜场景：灯塔｜走向：独处）",
];

/** 取最近一次执笔请求（写正文与生成走向卡都走这个身份） */
function lastWriterRequest(): { content: string; system: string } {
  const req = llmMock.requests.filter((r) => r.characterName === "NarrativeWriter").pop();
  if (!req) throw new Error("没有发出执笔请求");
  return { content: req.content, system: req.system };
}

function continuityContextOf(content: string): string {
  try {
    return String(JSON.parse(content).连续性上下文 ?? "");
  } catch {
    throw new Error("执笔请求不是 JSON");
  }
}

function lastContinuityContext(): string {
  return continuityContextOf(lastWriterRequest().content);
}

function lineWith(ctx: string, tag: string): string | undefined {
  return ctx.split("\n").find((l) => l.includes(markOf(tag)));
}

function indexOfTag(ctx: string, tag: string): number {
  return ctx.split("\n").findIndex((l) => l.includes(markOf(tag)));
}

function memoryLineCount(ctx: string, pattern: RegExp): number {
  return ctx.split("\n").filter((l) => pattern.test(l)).length;
}

function emotionLineCount(ctx: string): number {
  return ctx.split("\n").filter((l) => l.includes("瞬时情绪：")).length;
}

function directorCtx(memories: MemoryCard[], emotions: EmotionCard[]): string {
  expect(typeof writerApi.buildContinuityContext).toBe("function");
  return writerApi.buildContinuityContext!(
    memories,
    emotions,
    {},
    createDefaultWriterState("pend"),
    null,
    { 视角: "导演" }
  );
}

function characterCtx(memories: MemoryCard[], emotions: EmotionCard[]): string {
  expect(typeof writerApi.buildContinuityContext).toBe("function");
  return writerApi.buildContinuityContext!(
    memories,
    emotions,
    {},
    createDefaultWriterState("pend"),
    null,
    { 视角: "角色" }
  );
}

/** 大模型返回的卡片负载：状态/置信度由测试指定，模拟"模型自己给生效" */
function memoryPayload(
  内容: string,
  opts: { 状态?: string; 置信度?: number; 主类型?: string; audience?: unknown } = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: "memory",
    主体: "角色",
    主类型: opts.主类型 ?? "经历节点",
    内容,
    作用域: "戏内层",
    置信档: "高",
    置信度: opts.置信度 ?? 0.9,
    状态: opts.状态 ?? "生效",
    时间: "第1天",
    证据: 内容,
  };
  if (opts.audience !== undefined) base.audience = opts.audience;
  return base;
}

function emotionPayload(
  证据: string,
  opts: { 状态?: string; 置信度?: number } = {}
): Record<string, unknown> {
  return {
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "兴奋",
    强度: 0.7,
    作用域: "戏内层",
    置信档: "高",
    置信度: opts.置信度 ?? 0.9,
    状态: opts.状态 ?? "生效",
    证据,
  };
}

/** 读落盘原文，证明状态门槛改的是存储里的卡，不只是返回给调用方的内存对象 */
async function rawStatusesOfMemories(sid: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const card of await storageModule.listMemoryCards(sid)) {
    const raw = kvGet(`narrative:${sid}:memory:${card.id}`);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    out[String(parsed.内容)] = String(parsed.状态);
  }
  return out;
}

async function rawStatusesOfEmotions(sid: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const card of await storageModule.listEmotionCards(sid)) {
    const raw = kvGet(`narrative:${sid}:emotion:${card.id}`);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    out[String(parsed.证据)] = String(parsed.状态);
  }
  return out;
}

async function runExtract(sid: string, 负载: Record<string, unknown>[]): Promise<void> {
  llmMock.respond = () => JSON.stringify(负载);
  await extractFromTurn(sid, "正文", [], {
    isPlotMode: true,
    existingCardsSummary: [],
    currentWaterLevels: {},
    characterName: "角色A",
  } as unknown as Parameters<typeof extractFromTurn>[3]);
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

describe("待核卡：导演视角可用", () => {
  it("1. 待核卡进入走向卡上下文并标注（未确认），生效卡不标注，红线说明未确认只能当线索", async () => {
    const sid = makeSessionId("director-pending");
    await seed(sid, [
      mkMemory("明面", ["all"], { 状态: "生效" }),
      mkMemory("待核线索", ["all"], { 状态: "待核", 置信度: 0.9 }),
    ]);
    llmMock.respond = () => BANNERS.join("\n");

    await writerModule.generateBannerOptions(writerInput(sid, "角色A") as never);

    const ctx = lastContinuityContext();
    expect(ctx).toContain(markOf("明面"));
    // 待核卡对导演可见（现状：走向卡只读生效卡，这里拿不到它）
    expect(ctx).toContain(markOf("待核线索"));
    expect(lineWith(ctx, "待核线索") ?? "").toContain("（未确认）");
    expect(lineWith(ctx, "待核线索") ?? "").toContain("[共同知晓]");
    expect(lineWith(ctx, "明面") ?? "").not.toContain("（未确认）");
    // 红线仍然靠后，且补了"未确认只能当线索"这一句
    const lines = ctx.split("\n");
    const 红线行 = lines.findIndex((l) => l.startsWith("[视角红线]"));
    const 最后一张卡行 = lines.reduce(
      (acc, l, i) => (l.startsWith("- ") && i > acc ? i : acc),
      -1
    );
    expect(红线行).toBeGreaterThan(最后一张卡行);
    expect(lines[红线行]).toContain("未确认");
  });
});

describe("待核卡：角色视角不进正文", () => {
  it("2. 待核卡不出现在正文上下文（含误传时的防御性过滤），正文提示词写明未确认不可当事实", async () => {
    // 防御性过滤：调用方误把待核卡传进角色视角，也不该渲染
    const ctx = characterCtx(
      [mkMemory("明面", ["all"], { 状态: "生效" }), mkMemory("待核秘密", ["all"], { 状态: "待核" })],
      [mkEmotion("待核情绪", ["all"], { 状态: "待核" })]
    );
    expect(ctx).toContain(markOf("明面"));
    expect(ctx).not.toContain(markOf("待核秘密"));
    expect(ctx).not.toContain("瞬时情绪：");

    // 正常链路口径：写正文只读生效卡
    const sid = makeSessionId("character-pending");
    await seed(sid, [
      mkMemory("明面", ["all"], { 状态: "生效" }),
      mkMemory("待核秘密", ["all"], { 状态: "待核" }),
    ]);
    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文。";

    await writerModule.writeNarrative(writerInput(sid, "角色A") as never);

    expect(lastContinuityContext()).not.toContain(markOf("待核秘密"));
    // 提示词「视角限制」段补一句：未确认的信息不能当作事实写进正文
    expect(lastWriterRequest().system).toContain("未确认");
  });
});

describe("待核卡：只填剩余名额，不挤掉生效卡", () => {
  it("3. 生效卡占满 5 条时，待核卡一条都不出现，生效卡一张不少", () => {
    const 生效 = [1, 2, 3, 4, 5].map((i) =>
      mkMemory(`M${i}`, ["all"], { 状态: "生效", updatedAt: BASE_TIME - i * 1000 })
    );
    // 悬念素材会被"优先保留"顶到前面；待核身份不能让它挤掉生效卡
    const 待核 = [
      mkMemory("待核悬念", ["system"], { 状态: "待核", updatedAt: BASE_TIME + 1000 }),
      mkMemory("待核普通", ["all"], { 状态: "待核", updatedAt: BASE_TIME + 2000 }),
    ];
    const ctx = directorCtx([...生效, ...待核], []);

    for (let i = 1; i <= 5; i++) expect(ctx).toContain(markOf(`M${i}`));
    expect(memoryLineCount(ctx, /【M\d】/)).toBe(5);
    expect(ctx).not.toContain(markOf("待核悬念"));
    expect(ctx).not.toContain(markOf("待核普通"));
  });

  it("4. 待核卡超出占位上限时，最多占记忆 3 条、情感 1 条，按置信度从高到低排", () => {
    const 待核记忆 = [
      mkMemory("P5", ["all"], { 状态: "待核", 置信度: 0.5, updatedAt: BASE_TIME - 1000 }),
      mkMemory("P1", ["all"], { 状态: "待核", 置信度: 0.3, updatedAt: BASE_TIME }),
      mkMemory("P3", ["all"], { 状态: "待核", 置信度: 0.7, updatedAt: BASE_TIME - 3000 }),
      mkMemory("P2", ["all"], { 状态: "待核", 置信度: 0.95, updatedAt: BASE_TIME - 4000 }),
      mkMemory("P4", ["all"], { 状态: "待核", 置信度: 0.85, updatedAt: BASE_TIME - 2000 }),
    ];
    const 待核情感 = [
      mkEmotion("E2", ["all"], { 状态: "待核", 置信度: 0.75 }),
      mkEmotion("E1", ["all"], { 状态: "待核", 置信度: 0.9 }),
      mkEmotion("E3", ["all"], { 状态: "待核", 置信度: 0.6 }),
    ];
    const ctx = directorCtx(待核记忆, 待核情感);

    expect(memoryLineCount(ctx, /【P\d】/)).toBe(3);
    expect(emotionLineCount(ctx)).toBe(1);
    // 置信度高的先出现：P2(0.95) > P4(0.85) > P3(0.7)
    expect(indexOfTag(ctx, "P2")).toBeLessThan(indexOfTag(ctx, "P4"));
    expect(indexOfTag(ctx, "P4")).toBeLessThan(indexOfTag(ctx, "P3"));
    expect(ctx).not.toContain(markOf("P1"));
    expect(ctx).not.toContain(markOf("P5"));
    expect(ctx).toContain(markOf("E1"));
    expect(ctx).not.toContain(markOf("E2"));
    expect(ctx).not.toContain(markOf("E3"));
    for (const tag of ["P2", "P4", "P3", "E1"]) {
      expect(lineWith(ctx, tag) ?? "").toContain("（未确认）");
    }
  });
});

describe("待核卡：批量确认", () => {
  it("5. 确认后待核转生效并进入正文上下文；归档/冲突/陈旧与别的会话不受影响", async () => {
    expect(typeof storageApi.confirmAllPendingCards).toBe("function");

    const sid = makeSessionId("confirm");
    const other = makeSessionId("confirm-other");
    await seed(
      sid,
      [
        mkMemory("待核记忆", ["all"], { 状态: "待核" }),
        mkMemory("归档记忆", ["all"], { 状态: "归档" }),
        mkMemory("冲突记忆", ["all"], { 状态: "冲突" }),
        mkMemory("陈旧记忆", ["all"], { 状态: "陈旧" }),
        mkMemory("生效记忆", ["all"], { 状态: "生效" }),
      ],
      [mkEmotion("待核情绪", ["all"], { 状态: "待核" })]
    );
    await seed(other, [mkMemory("别场待核", ["all"], { 状态: "待核" })]);

    const 结果 = await storageApi.confirmAllPendingCards!(sid);
    expect(结果).toEqual({ memories: 1, emotions: 1 });

    const statuses = await rawStatusesOfMemories(sid);
    expect(statuses[`${markOf("待核记忆")}这条记忆的内容`]).toBe("生效");
    expect(statuses[`${markOf("归档记忆")}这条记忆的内容`]).toBe("归档");
    expect(statuses[`${markOf("冲突记忆")}这条记忆的内容`]).toBe("冲突");
    expect(statuses[`${markOf("陈旧记忆")}这条记忆的内容`]).toBe("陈旧");
    expect(statuses[`${markOf("生效记忆")}这条记忆的内容`]).toBe("生效");

    const 情感状态 = await rawStatusesOfEmotions(sid);
    expect(情感状态[markOf("待核情绪")]).toBe("生效");

    // 别的会话的待核卡不许被顺带确认
    const 别场 = await rawStatusesOfMemories(other);
    expect(别场[`${markOf("别场待核")}这条记忆的内容`]).toBe("待核");

    // 确认后角色就能把它当已知事实了
    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文。";
    await writerModule.writeNarrative(writerInput(sid, "角色A") as never);
    const ctx = lastContinuityContext();
    expect(ctx).toContain(markOf("待核记忆"));
    expect(ctx).not.toContain(markOf("归档记忆"));
  });
});

describe("待核卡：入库状态门槛（代码说了算）", () => {
  it("6. 置信度低于中档阈值的新卡强制待核且不丢弃；正好等于阈值不算低", async () => {
    const sid = makeSessionId("low-confidence");
    await runExtract(sid, [
      memoryPayload("低置信记忆", { 状态: "生效", 置信度: 0.2 }),
      memoryPayload("擦线记忆", { 状态: "生效", 置信度: 0.6 }),
      emotionPayload("低置信情感", { 状态: "生效", 置信度: 0.3 }),
      emotionPayload("擦线情感", { 状态: "生效", 置信度: 0.65 }),
    ]);

    const 记忆 = await rawStatusesOfMemories(sid);
    expect(记忆["低置信记忆"]).toBe("待核");
    expect(记忆["擦线记忆"]).toBe("生效");
    const 情感 = await rawStatusesOfEmotions(sid);
    expect(情感["低置信情感"]).toBe("待核");
    expect(情感["擦线情感"]).toBe("生效");

    // 不丢弃：卡仍然在库里，只是身份是待核
    expect(await storageModule.listMemoryCards(sid)).toHaveLength(2);
    expect(await storageModule.listEmotionCards(sid)).toHaveLength(2);
  });

  it("7. 主类型「世界变更」的新卡即使高置信也强制待核", async () => {
    const sid = makeSessionId("world-change");
    await runExtract(sid, [
      memoryPayload("世界变更卡", { 状态: "生效", 置信度: 0.9, 主类型: "世界变更" }),
    ]);

    const 记忆 = await rawStatusesOfMemories(sid);
    expect(记忆["世界变更卡"]).toBe("待核");
    expect(await storageModule.listMemoryCards(sid)).toHaveLength(1);
  });

  it("8. 高置信、非世界变更的新卡保持模型给的状态，代码不擅自改", async () => {
    const sid = makeSessionId("keep-model-status");
    await runExtract(sid, [
      memoryPayload("模型说生效", { 状态: "生效", 置信度: 0.9 }),
      memoryPayload("模型说待核", { 状态: "待核", 置信度: 0.9 }),
      emotionPayload("情感生效", { 状态: "生效", 置信度: 0.9 }),
    ]);

    const 记忆 = await rawStatusesOfMemories(sid);
    expect(记忆["模型说生效"]).toBe("生效");
    // 门槛只往下压不往上抬：模型自己标待核的高置信卡，不因"够格"被自动升生效
    expect(记忆["模型说待核"]).toBe("待核");
    const 情感 = await rawStatusesOfEmotions(sid);
    expect(情感["情感生效"]).toBe("生效");
  });
});
