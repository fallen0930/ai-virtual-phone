import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageModule from "@/lib/narrative-writer/storage";
import { extractFromTurn } from "@/lib/narrative-writer/extractor";
import * as writerModule from "@/lib/narrative-writer/writer";
import { createDefaultWriterState } from "@/lib/narrative-writer/types";
import type {
  EmotionCard,
  MemoryCard,
  NarrativeWriterState,
} from "@/lib/narrative-writer/types";

// 线索卡与伏笔卡（执笔 · 导演侧悬念资产）
//
// 覆盖什么：
// 1) 热抽新增 kind="thread" / kind="foreshadow"：新建一律「待核」并带来源；
//    同名（按归一化名称完全相等）不新建，只更新 上次推进轮次 + 追加 最近变化，
//    **不改 线索状态**（升级只能由采纳回写或用户在面板改）。
// 2) 会话隔离 / 分叉复制 / 删除清理：本文件测隔离，分叉与删除分别扩展
//    tests/fork-copy.test.ts、tests/delete-purge.test.ts。
// 3) 导演上下文新增 [未决线索] ≤5（待核 ≤3）、[待收伏笔] ≤4（待核 ≤2），
//    每条只带名称 + 一句 ≤30 字的下一步，待核带「（未确认）」；
//    角色（正文）上下文一条都不含——线索卡/伏笔卡永远不进正文。
// 4) 采纳走向卡的回写：报幕行尾机器标记 [推进:线索名→新状态:变化] / [回收:伏笔内容]
//    在 insertNarrativeTurn 成功之后才回写；标记里的名字匹配不上就忽略 + console.warn；
//    插入失败不回写；剥掉标记后的报幕才是入对局的文本。
// 5) 被丢弃回复产生的线索卡/伏笔卡同样归档；「推进」类更新不回退（待办 #35）。
// 6) 旧「散落线头」显式迁移：不丢内容、不重复、幂等、迁完清空。
// 7) [执笔状态] 整段停止渲染（除 buildContinuityContext 外无人读取）；
//    批量确认扩到四类。
//
// 只 mock 两处：大模型入口 sendLLMRequest，与住在 mixology/engine 里的 resolveMixApiConfig 桩。
// **本文件不 import mixology/engine**：走真实实现的是抽取落库、上下文拼装、生成走向卡、
// 写正文、批量确认、丢弃归档。
//
// 尚未实现的 API 一律用可选签名（storage/writer 上 `typeof` 守卫）或带 catch 的动态 import
// 取，保证「还没实现」表现为**断言失败**，而不是模块解析错误或类型错误。

// ── 本地结构类型：新卡类型还没进 types.ts，测试只按方案约定的字段形状断言 ──
type ChangeLike = { 变化: string; 轮次?: number; 来源消息ID?: string };
type ThreadLike = {
  id: string;
  kind: string;
  名称: string;
  线索状态: string;
  关联角色: string[];
  上次推进轮次: number;
  下一步可能: string;
  最近变化: ChangeLike[];
  状态: string;
  来源消息ID?: string;
  来源轮次?: number;
  归档原因?: string;
  audience?: string[];
  createdAt: number;
  updatedAt: number;
};
type ForeshadowLike = {
  id: string;
  kind: string;
  内容: string;
  埋下轮次: number;
  预期回收窗口: { 起: number; 止: number };
  伏笔状态: string;
  关联线索名称?: string;
  揭示条件?: string;
  状态: string;
  来源消息ID?: string;
  来源轮次?: number;
  归档原因?: string;
  audience?: string[];
  createdAt: number;
  updatedAt: number;
};

type ExtractThreadsResult = {
  memories: unknown[];
  emotions: unknown[];
  threads: ThreadLike[];
  foreshadows: ForeshadowLike[];
};

type StorageThreadsApi = {
  saveThreadCard?: (sessionId: string, card: ThreadLike) => Promise<void>;
  listThreadCards?: (
    sessionId: string,
    opts?: { status?: string; 线索状态?: string }
  ) => Promise<ThreadLike[]>;
  getThreadCard?: (sessionId: string, id: string) => Promise<ThreadLike | null>;
  deleteThreadCard?: (sessionId: string, id: string) => Promise<void>;
  saveForeshadowCard?: (
    sessionId: string,
    card: ForeshadowLike
  ) => Promise<void>;
  listForeshadowCards?: (
    sessionId: string,
    opts?: { status?: string; 伏笔状态?: string }
  ) => Promise<ForeshadowLike[]>;
  getForeshadowCard?: (
    sessionId: string,
    id: string
  ) => Promise<ForeshadowLike | null>;
  confirmAllPendingCards?: (
    sessionId: string
  ) => Promise<{
    memories: number;
    emotions: number;
    threads: number;
    foreshadows: number;
  }>;
  onTurnsDiscarded?: (
    sessionId: string,
    discardedTurnIds: string[],
    原因: string
  ) => {
    memories: number;
    emotions: number;
    threads: number;
    foreshadows: number;
  };
};

type WriterApi = {
  buildContinuityContext?: (
    memories: MemoryCard[],
    emotions: EmotionCard[],
    waterLevels: Record<string, unknown>,
    writerState: NarrativeWriterState,
    hierarchy?: unknown,
    view?: { 视角: "角色" } | { 视角: "导演" },
    threads?: ThreadLike[],
    foreshadows?: ForeshadowLike[]
  ) => string;
};

type ThreadsModule = {
  normalizeThreadName?: (raw: unknown) => string;
  stripBannerMarkers?: (banner: string) => string;
  parseBannerMarkers?: (banner: string) => {
    干净报幕: string;
    推进: Array<{ 名称: string; 新状态: string; 变化: string }>;
    回收: Array<{ 内容: string }>;
  };
  applyAdoptedBanner?: (input: {
    sessionId: string;
    banner: string;
    来源消息ID?: string;
    来源轮次?: number;
    insert: (干净报幕: string) => Promise<unknown>;
  }) => Promise<{
    干净报幕: string;
    推进数: number;
    回收数: number;
    忽略数: number;
  }>;
  migrateLooseThreadsToCards?: (
    sessionId: string
  ) => Promise<{ 新建: number; 跳过: number }>;
  pickPriorityThread?: (threads: ThreadLike[]) => ThreadLike | null;
};

const storageApi = storageModule as unknown as StorageThreadsApi;
const writerApi = writerModule as unknown as WriterApi;

/**
 * 新模块 threads.ts 还不存在。
 * 路径写成 `: string` 变量：TS 不做模块解析（否则报 TS2307 让「红因」变成类型错误），
 * 运行时用相对路径交给 vite-node 解析；解析失败被 catch 吞掉，交给下面的断言报红。
 */
const THREADS_MODULE_PATH: string = "../lib/narrative-writer/threads";

async function threadsModule(): Promise<ThreadsModule> {
  const mod = await import(THREADS_MODULE_PATH).catch(() => null);
  expect(mod, "@/lib/narrative-writer/threads 尚未实现").not.toBeNull();
  return mod as unknown as ThreadsModule;
}

function requireStorageFn<K extends keyof StorageThreadsApi>(
  name: K
): NonNullable<StorageThreadsApi[K]> {
  const fn = storageApi[name];
  expect(fn, `storage.${String(name)} 尚未实现`).toBeTypeOf("function");
  return fn as NonNullable<StorageThreadsApi[K]>;
}

function requireContinuityContext(): NonNullable<WriterApi["buildContinuityContext"]> {
  const fn = writerApi.buildContinuityContext;
  expect(fn, "buildContinuityContext 不可用").toBeTypeOf("function");
  return fn as NonNullable<WriterApi["buildContinuityContext"]>;
}

// ── LLM 桩：只记录请求，返回测试指定的负载 ──
const llmMock = vi.hoisted(() => ({
  calls: 0,
  respond: null as null | (() => string),
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

// ── 夹具 ──
const createdSessionIds = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testthread_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  createdSessionIds.add(sid);
  return sid;
}

function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 名称/内容里带唯一标记，断言时直接查标记，不依赖整行文案 */
function markOf(tag: string): string {
  return `【${tag}】`;
}

const BASE_TIME = 1_700_000_000_000;

function mkMemory(tag: string, opts: { 状态?: string } = {}): MemoryCard {
  const now = BASE_TIME;
  return {
    id: `tf_m_${tag}_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: `${markOf(tag)}这条记忆的内容`,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: opts.状态 ?? "生效",
    证据: "测试夹具",
    时间: "第1天",
    audience: ["all"],
    createdAt: now,
    updatedAt: now,
  } as unknown as MemoryCard;
}

interface ThreadOpts {
  名称?: string;
  线索状态?: string;
  状态?: string;
  上次推进轮次?: number;
  下一步可能?: string;
  最近变化?: ChangeLike[];
  来源消息ID?: string;
  来源轮次?: number;
  关联角色?: string[];
  updatedAt?: number;
}

function mkThread(tag: string, opts: ThreadOpts = {}): ThreadLike {
  const now = opts.updatedAt ?? BASE_TIME;
  return {
    id: `tf_t_${tag}_${rand()}`,
    kind: "thread",
    名称: opts.名称 ?? `线索${markOf(tag)}`,
    线索状态: opts.线索状态 ?? "潜伏",
    关联角色: opts.关联角色 ?? [],
    上次推进轮次: opts.上次推进轮次 ?? 1,
    下一步可能: opts.下一步可能 ?? "再查一层",
    最近变化: opts.最近变化 ?? [],
    状态: opts.状态 ?? "生效",
    来源消息ID: opts.来源消息ID,
    来源轮次: opts.来源轮次,
    audience: ["all"],
    createdAt: now,
    updatedAt: now,
  };
}

interface ForeshadowOpts {
  内容?: string;
  伏笔状态?: string;
  状态?: string;
  埋下轮次?: number;
  窗口?: { 起: number; 止: number };
  来源消息ID?: string;
  来源轮次?: number;
  updatedAt?: number;
}

function mkForeshadow(tag: string, opts: ForeshadowOpts = {}): ForeshadowLike {
  const now = opts.updatedAt ?? BASE_TIME;
  return {
    id: `tf_f_${tag}_${rand()}`,
    kind: "foreshadow",
    内容: opts.内容 ?? `伏笔${markOf(tag)}`,
    埋下轮次: opts.埋下轮次 ?? 2,
    预期回收窗口: opts.窗口 ?? { 起: 3, 止: 6 },
    伏笔状态: opts.伏笔状态 ?? "未收",
    状态: opts.状态 ?? "生效",
    来源消息ID: opts.来源消息ID,
    来源轮次: opts.来源轮次,
    audience: ["all"],
    createdAt: now,
    updatedAt: now,
  };
}

async function seedThreads(
  sid: string,
  cards: ThreadLike[]
): Promise<void> {
  const save = requireStorageFn("saveThreadCard");
  for (const card of cards) await save(sid, card);
}

async function seedForeshadows(
  sid: string,
  cards: ForeshadowLike[]
): Promise<void> {
  const save = requireStorageFn("saveForeshadowCard");
  for (const card of cards) await save(sid, card);
}

async function listThreads(sid: string): Promise<ThreadLike[]> {
  const list = requireStorageFn("listThreadCards");
  return list(sid);
}

async function listForeshadows(sid: string): Promise<ForeshadowLike[]> {
  const list = requireStorageFn("listForeshadowCards");
  return list(sid);
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

/** 抽取负载：模型自己标「生效」+ 高置信度，代码仍要压成待核 */
function threadPayload(
  名称: string,
  opts: { 线索状态?: string; 下一步可能?: string; 状态?: string; 置信度?: number } = {}
): Record<string, unknown> {
  return {
    kind: "thread",
    名称,
    线索状态: opts.线索状态 ?? "潜伏",
    关联角色: [],
    下一步可能: opts.下一步可能 ?? "去当铺问来路",
    最近变化: [],
    状态: opts.状态 ?? "生效",
    置信度: opts.置信度 ?? 0.95,
    audience: ["all"],
  };
}

function foreshadowPayload(
  内容: string,
  opts: { 窗口?: { 起: number; 止: number }; 埋下轮次?: number } = {}
): Record<string, unknown> {
  return {
    kind: "foreshadow",
    内容,
    埋下轮次: opts.埋下轮次 ?? 3,
    预期回收窗口: opts.窗口 ?? { 起: 4, 止: 7 },
    伏笔状态: "未收",
    状态: "生效",
    置信度: 0.9,
    audience: ["all"],
  };
}

async function runExtract(
  sid: string,
  负载: Record<string, unknown>[],
  来源?: { 消息ID?: string; 轮次?: number }
): Promise<ExtractThreadsResult> {
  llmMock.respond = () => JSON.stringify(负载);
  const result = await extractFromTurn(sid, "玩家：桥下丢了一枚硬币", [], {
    isPlotMode: true,
    existingCardsSummary: [],
    currentWaterLevels: {},
    characterName: "角色A",
    来源,
  } as unknown as Parameters<typeof extractFromTurn>[3]);
  return result as unknown as ExtractThreadsResult;
}

function lastRequest(
  characterName: string
): { content: string; system: string } {
  const req = llmMock.requests
    .filter((r) => r.characterName === characterName)
    .pop();
  if (!req) throw new Error(`没有发出 ${characterName} 请求`);
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
  return continuityContextOf(lastRequest("NarrativeWriter").content);
}

function linesWith(ctx: string, tag: string): string[] {
  return ctx.split("\n").filter((l) => l.includes(markOf(tag)));
}

function threadCtx(
  threads: ThreadLike[],
  foreshadows: ForeshadowLike[],
  视角: "角色" | "导演" = "导演",
  writerState?: NarrativeWriterState
): string {
  return requireContinuityContext()(
    [],
    [],
    {},
    writerState ?? createDefaultWriterState("tf"),
    null,
    { 视角 },
    threads,
    foreshadows
  );
}

function 悬念行(ctx: string, 段名: string): string[] {
  const lines = ctx.split("\n");
  const start = lines.findIndex((l) => l.startsWith(段名));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith("- ")) break;
    out.push(lines[i]);
  }
  return out;
}

beforeEach(() => {
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const sid of createdSessionIds) {
    storageModule.purgeNarrativeSessionData(sid);
  }
  createdSessionIds.clear();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe("线索卡：热抽入库与同名合并", () => {
  it("1. 抽出的线索卡与伏笔卡入库为「待核」并带来源", async () => {
    const sid = makeSessionId("extract-new");
    const result = await runExtract(
      sid,
      [
        threadPayload("老桥下的硬币"),
        foreshadowPayload("雨夜未接的电话"),
      ],
      { 消息ID: "mixturn_hot", 轮次: 4 }
    );

    expect(result.threads ?? [], "抽取结果的 threads 字段").toHaveLength(1);
    expect(result.foreshadows ?? [], "抽取结果的 foreshadows 字段").toHaveLength(1);

    const [线程] = await listThreads(sid);
    expect(线程.名称).toBe("老桥下的硬币");
    // 新建的悬念资产必须过玩家的眼：模型标了生效 + 0.95 也压成待核
    expect(线程.状态).toBe("待核");
    expect(线程.线索状态).toBe("潜伏");
    expect(Array.isArray(线程.最近变化)).toBe(true);
    expect(线程.来源消息ID).toBe("mixturn_hot");
    expect(线程.来源轮次).toBe(4);

    const [伏笔] = await listForeshadows(sid);
    expect(伏笔.内容).toBe("雨夜未接的电话");
    expect(伏笔.状态).toBe("待核");
    expect(伏笔.伏笔状态).toBe("未收");
    expect(伏笔.预期回收窗口).toEqual({ 起: 4, 止: 7 });
    expect(伏笔.来源消息ID).toBe("mixturn_hot");
  });

  it("2. 同名线索不重复新建；一批里同名也合并成一张", async () => {
    const sid = makeSessionId("extract-dup");
    const 已有 = mkThread("dup", { 名称: "老桥下的硬币", 状态: "生效" });
    await seedThreads(sid, [已有]);

    // 尾随全角句号 + 首尾空格：归一化后与已有名称完全相等 → 视为更新而非新建
    const result = await runExtract(
      sid,
      [threadPayload("  老桥下的硬币。"), threadPayload("老桥下的硬币")],
      { 消息ID: "mixturn_hot", 轮次: 4 }
    );

    const 全部 = await listThreads(sid);
    expect(全部).toHaveLength(1);
    expect(全部[0].id).toBe(已有.id);
    // 返回给调用方的也不该是第二张新卡
    expect((result.threads ?? []).filter((t) => t.id !== 已有.id)).toHaveLength(0);
  });

  it("3. 同名抽取只更新「上次推进轮次」与「最近变化」，不改「线索状态」", async () => {
    const sid = makeSessionId("extract-progress");
    await seedThreads(
      sid,
      [
        mkThread("prog", {
          名称: "老桥下的硬币",
          状态: "生效",
          线索状态: "潜伏",
          上次推进轮次: 1,
          最近变化: [],
        }),
      ]
    );

    // 模型 even 建议升到爆发：抽取路径没有升级状态的权力
    await runExtract(
      sid,
      [
        {
          ...threadPayload("老桥下的硬币", { 线索状态: "爆发" }),
          本轮变化: "当铺掌柜认出了那枚硬币",
        },
      ],
      { 消息ID: "mixturn_hot", 轮次: 6 }
    );

    const [线程] = await listThreads(sid);
    expect(线程.线索状态).toBe("潜伏");
    expect(线程.上次推进轮次).toBe(6);
    expect(线程.最近变化).toHaveLength(1);
    expect(线程.最近变化[0].来源消息ID).toBe("mixturn_hot");
    expect(线程.最近变化[0].变化).toContain("当铺");

    // 只留最近 3 条
    for (let i = 1; i <= 4; i += 1) {
      await runExtract(
        sid,
        [
          {
            ...threadPayload("老桥下的硬币"),
            本轮变化: `第${i}次变化`,
          },
        ],
        { 消息ID: `mixturn_${i}`, 轮次: 7 + i }
      );
    }
    const [之后] = await listThreads(sid);
    expect(之后.最近变化).toHaveLength(3);
    expect(之后.最近变化.map((c) => c.变化)).toEqual(["第4次变化", "第3次变化", "第2次变化"]);
    expect(之后.线索状态).toBe("潜伏");
  });

  it("4. 抽取输入带上已有线索与伏笔名称列表；提示词不再有 kind:drive 与执笔状态段", async () => {
    const sid = makeSessionId("extract-prompt");
    await seedThreads(sid, [mkThread("名单", { 名称: `线索${markOf("名单")}` })]);
    await seedForeshadows(sid, [mkForeshadow("名单", { 内容: `伏笔${markOf("名单")}` })]);

    await runExtract(sid, [threadPayload("另一条新线")]);

    const 抽取请求 = lastRequest("Extractor");
    // #32 本轮范围：只给名称列表，不给内容摘要
    expect(抽取请求.content).toContain(markOf("名单"));
    expect(抽取请求.system).not.toContain('"kind":"drive"');
    expect(抽取请求.system).not.toContain("# 执笔状态");
    // 为「同名输出=本轮有进展」补的那一句必须在
    expect(抽取请求.system).toContain("同名");
  });
});

describe("线索卡：会话隔离", () => {
  it("5. A 场的线索卡与伏笔卡不出现在 B 场", async () => {
    const sidA = makeSessionId("iso-a");
    const sidB = makeSessionId("iso-b");
    await seedThreads(sidA, [mkThread("隔离", { 名称: `线索${markOf("隔离")}` })]);
    await seedForeshadows(sidA, [
      mkForeshadow("隔离", { 内容: `伏笔${markOf("隔离")}` }),
    ]);

    expect(await listThreads(sidB)).toEqual([]);
    expect(await listForeshadows(sidB)).toEqual([]);
    expect(await listThreads(sidA)).toHaveLength(1);

    await runExtract(sidB, [threadPayload("B 场新线")]);
    const A线 = await listThreads(sidA);
    const B线 = await listThreads(sidB);
    expect(A线.map((t) => t.名称)).toEqual([`线索${markOf("隔离")}`]);
    expect(B线.map((t) => t.名称)).toContain("B 场新线");
  });
});

describe("导演上下文：未决线索与待收伏笔", () => {
  it("6. 导演上下文含两块，生成走向卡链路拿得到；角色上下文一条都不含", async () => {
    const sid = makeSessionId("ctx-director");
    await seedThreads(sid, [mkThread("入导演", { 名称: `线索${markOf("入导演")}` })]);
    await seedForeshadows(sid, [
      mkForeshadow("入导演", { 内容: `伏笔${markOf("入导演")}` }),
    ]);
    llmMock.respond = () =>
      "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文。";

    // 走真实链路：走向卡（导演视角）应当读到悬念资产
    await writerModule.generateBannerOptions(writerInput(sid, "角色A") as never);
    const 导演ctx = lastContinuityContext();
    expect(悬念行(导演ctx, "[未决线索]")).toHaveLength(1);
    expect(导演ctx).toContain(markOf("入导演"));

    // 写正文（角色视角）：一条都不能进，连段名都不出现
    await writerModule.writeNarrative(writerInput(sid, "角色A") as never);
    const 正文ctx = lastContinuityContext();
    expect(正文ctx).not.toContain("[未决线索]");
    expect(正文ctx).not.toContain("[待收伏笔]");
    expect(正文ctx).not.toContain(markOf("入导演"));

    // 纯函数口径同样成立
    const 直连导演 = threadCtx(
      [mkThread("纯函数")],
      [mkForeshadow("纯函数")],
      "导演"
    );
    expect(直连导演).toContain("[未决线索]");
    expect(直连导演).toContain("[待收伏笔]");
    expect(threadCtx([mkThread("纯函数")], [mkForeshadow("纯函数")], "角色")).not.toContain(
      "[未决线索]"
    );
  });

  it("7. 名额：线索 ≤5（待核 ≤3）、伏笔 ≤4（待核 ≤2）；待核带（未确认）；下一步只留 30 字", () => {
    const 生效线索 = [1, 2, 3].map((i) =>
      mkThread(`生效线索${i}`, { 名称: `线索${markOf(`生效线索${i}`)}` })
    );
    const 待核线索 = [4, 5, 6, 7].map((i) =>
      mkThread(`待核线索${i}`, {
        名称: `线索${markOf(`待核线索${i}`)}`,
        状态: "待核",
      })
    );
    const 生效伏笔 = [1, 2, 3].map((i) =>
      mkForeshadow(`生效伏笔${i}`, { 内容: `伏笔${markOf(`生效伏笔${i}`)}` })
    );
    const 待核伏笔 = [4, 5, 6].map((i) =>
      mkForeshadow(`待核伏笔${i}`, {
        内容: `伏笔${markOf(`待核伏笔${i}`)}`,
        状态: "待核",
      })
    );

    const ctx = threadCtx([...生效线索, ...待核线索], [...生效伏笔, ...待核伏笔]);
    const 线索行 = 悬念行(ctx, "[未决线索]");
    const 伏笔行 = 悬念行(ctx, "[待收伏笔]");

    // 生效先占位，待核只填剩余名额且各自有上限 → 线索 3+2、伏笔 3+1
    expect(线索行).toHaveLength(5);
    expect(线索行.filter((l) => l.includes("（未确认）"))).toHaveLength(2);
    expect(伏笔行).toHaveLength(4);
    expect(伏笔行.filter((l) => l.includes("（未确认）"))).toHaveLength(1);
    // 生效卡一张不少；待核卡四条里只留两条、六条里只留一条（具体留哪条按新近排，不锁名字）
    for (let i = 1; i <= 3; i += 1) expect(linesWith(ctx, `生效线索${i}`)).toHaveLength(1);
    for (let i = 1; i <= 3; i += 1) expect(linesWith(ctx, `生效伏笔${i}`)).toHaveLength(1);
    expect([4, 5, 6, 7].filter((i) => linesWith(ctx, `待核线索${i}`).length > 0)).toHaveLength(2);
    expect([4, 5, 6].filter((i) => linesWith(ctx, `待核伏笔${i}`).length > 0)).toHaveLength(1);

    // 每条只带名称 + 一句 ≤30 字的下一步
    const 长下一步 = mkThread("长", {
      名称: `线索${markOf("长")}`,
      下一步可能: "甲".repeat(40),
    });
    const 单独 = threadCtx([长下一步], []);
    const 行 = linesWith(单独, "长")[0] ?? "";
    expect(行).toContain("甲".repeat(30));
    expect(行).not.toContain("甲".repeat(31));
    expect(行).toContain("线索" + markOf("长"));
  });

  it("8. 归档线索与已收伏笔不进导演上下文", () => {
    const ctx = threadCtx(
      [
        mkThread("活跃", { 名称: `线索${markOf("活跃")}` }),
        mkThread("归档", { 名称: `线索${markOf("归档")}`, 状态: "归档" }),
        mkThread("冲突", { 名称: `线索${markOf("冲突")}`, 状态: "冲突" }),
      ],
      [
        mkForeshadow("待收", { 内容: `伏笔${markOf("待收")}` }),
        mkForeshadow("收掉", {
          内容: `伏笔${markOf("收掉")}`,
          伏笔状态: "已收",
        }),
        mkForeshadow("归档", { 内容: `伏笔${markOf("归档")}`, 状态: "归档" }),
      ]
    );
    expect(linesWith(ctx, "活跃")).toHaveLength(1);
    expect(linesWith(ctx, "归档")).toHaveLength(0);
    expect(linesWith(ctx, "冲突")).toHaveLength(0);
    expect(linesWith(ctx, "待收")).toHaveLength(1);
    expect(linesWith(ctx, "收掉")).toHaveLength(0);
  });
});

describe("采纳走向卡：报幕标记回写", () => {
  it("9. 采纳后更新上次推进轮次/最近变化/线索状态，伏笔标记已收，入对局的报幕已剥标记", async () => {
    const sid = makeSessionId("adopt-ok");
    const api = await threadsModule();
    expect(typeof api.applyAdoptedBanner).toBe("function");
    const 线 = mkThread("采纳", { 名称: "老桥下的硬币", 上次推进轮次: 1 });
    const 伏 = mkForeshadow("采纳", { 内容: "雨夜未接的电话" });
    await seedThreads(sid, [线]);
    await seedForeshadows(sid, [伏]);

    const 插入收到: string[] = [];
    const result = await api.applyAdoptedBanner!({
      sessionId: sid,
      banner:
        "（基调：推进｜场景：旧城｜走向：查证）[推进:老桥下的硬币→升温:当铺掌柜认出了那枚硬币] [回收:雨夜未接的电话]",
      来源消息ID: "mixturn_adopt",
      来源轮次: 6,
      insert: async (干净报幕: string) => {
        插入收到.push(干净报幕);
        return "inserted";
      },
    });

    expect(插入收到).toHaveLength(1);
    expect(插入收到[0]).not.toContain("[推进:");
    expect(插入收到[0]).not.toContain("[回收:");
    expect(插入收到[0]).toContain("（基调：推进｜场景：旧城｜走向：查证）");
    expect(result.推进数).toBe(1);
    expect(result.回收数).toBe(1);
    expect(result.忽略数).toBe(0);
    expect(result.干净报幕).toBe(插入收到[0]);

    const [线程] = await listThreads(sid);
    expect(线程.线索状态).toBe("升温");
    expect(线程.上次推进轮次).toBe(6);
    expect(线程.最近变化[0].变化).toBe("当铺掌柜认出了那枚硬币");
    expect(线程.最近变化[0].来源消息ID).toBe("mixturn_adopt");

    const [伏笔] = await listForeshadows(sid);
    expect(伏笔.伏笔状态).toBe("已收");
  });

  it("10. 标记里的线索名对不上：忽略、不新建、console.warn", async () => {
    const sid = makeSessionId("adopt-miss");
    const api = await threadsModule();
    expect(typeof api.applyAdoptedBanner).toBe("function");
    await seedThreads(sid, [mkThread("在场", { 名称: "老桥下的硬币" })]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await api.applyAdoptedBanner!({
      sessionId: sid,
      banner: "（基调：转折｜场景：旧城｜走向：揭示）[推进:不存在的线头→爆发:有人跳河]",
      来源消息ID: "mixturn_miss",
      来源轮次: 7,
      insert: async () => "ok",
    });

    expect(result.忽略数).toBe(1);
    expect(result.推进数).toBe(0);
    expect(warn.mock.calls.some((c) => String(c.join(" ")).includes("不存在的线头"))).toBe(
      true
    );
    const 全部 = await listThreads(sid);
    expect(全部).toHaveLength(1);
    expect(全部[0].名称).toBe("老桥下的硬币");
    expect(全部[0].线索状态).toBe("潜伏");
    expect(全部[0].最近变化).toEqual([]);
  });

  it("11. 插入失败时不回写", async () => {
    const sid = makeSessionId("adopt-insert-fail");
    const api = await threadsModule();
    expect(typeof api.applyAdoptedBanner).toBe("function");
    await seedThreads(sid, [
      mkThread("失败", { 名称: "老桥下的硬币", 上次推进轮次: 1, 线索状态: "潜伏" }),
    ]);

    await expect(
      api.applyAdoptedBanner!({
        sessionId: sid,
        banner: "（基调：推进｜场景：旧城｜走向：查证）[推进:老桥下的硬币→升温:认出来了]",
        来源消息ID: "mixturn_fail",
        来源轮次: 8,
        insert: async () => {
          throw new Error("插入失败");
        },
      })
    ).rejects.toThrow("插入失败");

    const [线程] = await listThreads(sid);
    expect(线程.线索状态).toBe("潜伏");
    expect(线程.上次推进轮次).toBe(1);
    expect(线程.最近变化).toEqual([]);
  });

  it("12. 带标记的报幕通过（…）过滤；正文提示词与返回报幕都不含标记", async () => {
    const sid = makeSessionId("banner-marker");
    await seedThreads(sid, [mkThread("标记", { 名称: "老桥下的硬币" })]);
    const 带标记 =
      "（基调：推进｜场景：旧城｜走向：查证）[推进:老桥下的硬币→升温:掌柜认出硬币]";

    llmMock.respond = () =>
      [
        "（基调：日常｜场景：旧城｜走向：闲聊）",
        "（基调：推进｜场景：旧城｜走向：查证）[推进:老桥下的硬币→升温:掌柜认出硬币]",
        "（基调：转折｜场景：旧城｜注意：会有揭示）",
        "（基调：缓冲｜场景：旧城｜走向：独处）",
      ].join("\n");

    const options = await writerModule.generateBannerOptions(
      writerInput(sid, "角色A") as never
    );
    // 现状：只保留（…）整行的过滤会把带标记的行丢掉
    expect(options).toHaveLength(4);
    expect(options).toContain(带标记);

    llmMock.respond = () => "（基调：推进｜场景：旧城｜走向：查证）\n\n正文一段。";
    const written = await writerModule.writeWithSelectedBanner(
      writerInput(sid, "角色A") as never,
      带标记 as never
    );

    expect(lastRequest("NarrativeWriter").content).not.toContain("[推进:");
    expect(written.banner).not.toContain("[推进:");
    expect(written.banner).toContain("（基调：推进｜场景：旧城｜走向：查证）");
  });

  it("13. pickPriorityThread：按线索状态优先，收束与归档不参与，无线索时返回 null", async () => {
    const api = await threadsModule();
    expect(typeof api.pickPriorityThread).toBe("function");
    const 爆发 = mkThread("爆发", { 名称: "A线", 线索状态: "爆发", 上次推进轮次: 5 });
    const 潜伏 = mkThread("潜伏", { 名称: "B线", 线索状态: "潜伏", 上次推进轮次: 1 });
    const 收束 = mkThread("收束", { 名称: "C线", 线索状态: "收束" });
    const 归档 = mkThread("归档", { 名称: "D线", 状态: "归档" });

    expect(api.pickPriorityThread!([收束, 潜伏, 归档])?.名称).toBe("B线");
    expect(api.pickPriorityThread!([潜伏, 爆发])?.名称).toBe("A线");
    // 同状态时最久没推进的优先
    const 爆发旧 = mkThread("旧", { 名称: "E线", 线索状态: "爆发", 上次推进轮次: 2 });
    expect(api.pickPriorityThread!([爆发, 爆发旧])?.名称).toBe("E线");
    expect(api.pickPriorityThread!([])).toBeNull();
    expect(api.pickPriorityThread!([归档, 收束])).toBeNull();
  });
});

describe("丢弃回复：线索卡与伏笔卡归档", () => {
  it("14. 来源被丢弃的线索卡/伏笔卡归档，已有「推进」不回退", async () => {
    const sid = makeSessionId("discard");
    expect(typeof storageApi.onTurnsDiscarded).toBe("function");
    await seedThreads(
      sid,
      [
        mkThread("弃", { 名称: "线索" + markOf("弃"), 来源消息ID: "turn_gone" }),
        mkThread("留", {
          名称: "线索" + markOf("留"),
          来源消息ID: "turn_alive",
          最近变化: [{ 变化: "上一轮推进", 来源消息ID: "turn_gone" }],
        }),
      ]
    );
    await seedForeshadows(sid, [
      mkForeshadow("弃", { 内容: "伏笔" + markOf("弃"), 来源消息ID: "turn_gone" }),
    ]);

    const result = storageApi.onTurnsDiscarded!(sid, ["turn_gone"], "玩家重说了这条回复");
    // 只按卡片自身来源归档：2 条线索里 1 条来源被丢，伏笔 1 条
    expect(result).toMatchObject({ threads: 1, foreshadows: 1 });

    const 全部 = await listThreads(sid);
    const 弃 = 全部.find((t) => t.名称.includes(markOf("弃")));
    const 留 = 全部.find((t) => t.名称.includes(markOf("留")));
    expect(弃?.状态).toBe("归档");
    expect(弃?.归档原因).toBe("玩家重说了这条回复");
    expect(留?.状态).toBe("生效");
    // 待办 #35：推进类更新不回退，这里锁住现状
    expect(留?.最近变化).toHaveLength(1);

    const 伏 = (await listForeshadows(sid)).find((f) => f.内容.includes(markOf("弃")));
    expect(伏?.状态).toBe("归档");
  });
});

describe("旧「散落线头」迁移", () => {
  it("15. 显式迁移不丢内容、不重复、幂等，迁完清空散落线头", async () => {
    const sid = makeSessionId("migrate");
    const api = await threadsModule();
    expect(typeof api.migrateLooseThreadsToCards).toBe("function");
    await storageModule.saveWriterState(sid, {
      ...createDefaultWriterState(sid),
      散落线头: ["老桥下的硬币", "未署名的信", "老桥下的硬币", "   "],
    });

    const result = await api.migrateLooseThreadsToCards!(sid);
    expect(result).toEqual({ 新建: 2, 跳过: 2 });

    const 全部 = await listThreads(sid);
    expect(全部.map((t) => t.名称).sort()).toEqual(["未署名的信", "老桥下的硬币"]);
    // 旧数据来源未知：不冒充任何一条消息
    expect(全部.every((t) => t.来源消息ID === undefined)).toBe(true);
    expect(全部.every((t) => t.状态 === "待核")).toBe(true);
    expect(全部.every((t) => t.线索状态 === "潜伏")).toBe(true);

    expect((await storageModule.getWriterState(sid)).散落线头).toEqual([]);

    const 第二次 = await api.migrateLooseThreadsToCards!(sid);
    expect(第二次).toEqual({ 新建: 0, 跳过: 0 });
    expect(await listThreads(sid)).toHaveLength(2);
  });

  it("16. 归一化：全角转半角、去首尾标点空白、英文小写；纯标点视为空", async () => {
    const api = await threadsModule();
    expect(typeof api.normalizeThreadName).toBe("function");
    expect(api.normalizeThreadName!("  ＨＥＬＬＯ　桥。 ")).toBe("hello 桥");
    expect(api.normalizeThreadName!("老桥下的硬币")).toBe("老桥下的硬币");
    expect(api.normalizeThreadName!("   ")).toBe("");
    expect(api.normalizeThreadName!("——·。")).toBe("");
    expect(api.normalizeThreadName!(undefined)).toBe("");
    expect(api.normalizeThreadName!(42)).toBe("");
    expect(api.stripBannerMarkers!("（走向：查证）[推进:某线→升温:变化]")).toBe("（走向：查证）");
    const 解析 = api.parseBannerMarkers!(
      "（走向：查证）[推进:老桥下的硬币→升温:掌柜认出] [回收:雨夜未接的电话]"
    );
    expect(解析.干净报幕).toBe("（走向：查证）");
    expect(解析.推进).toEqual([
      { 名称: "老桥下的硬币", 新状态: "升温", 变化: "掌柜认出" },
    ]);
    expect(解析.回收).toEqual([{ 内容: "雨夜未接的电话" }]);
  });
});

describe("[执笔状态] 停止渲染与批量确认扩到四类", () => {
  it("17. 导演与角色上下文都不再出现 [执笔状态] 段", () => {
    const 带状态 = {
      ...createDefaultWriterState("tf"),
      当前基调: "推进" as const,
      本轮档位: "重" as const,
      连续同档: 2,
      目标: ["找到信的作者"],
      阶段进度: 0.4,
      散落线头: ["老桥下的硬币"],
    };
    const 导演 = requireContinuityContext()(
      [mkMemory("记忆")],
      [],
      {},
      带状态,
      null,
      { 视角: "导演" },
      [mkThread("状态")],
      []
    );
    const 角色 = requireContinuityContext()(
      [mkMemory("记忆")],
      [],
      {},
      带状态,
      null,
      { 视角: "角色" },
      [mkThread("状态")],
      []
    );
    expect(导演).not.toContain("[执笔状态]");
    expect(角色).not.toContain("[执笔状态]");
    expect(导演).not.toContain("当前基调");
    expect(导演).not.toContain("散落线头");
    // 素材与红线的位置关系不变：悬念段在前，大纲与水位随后，红线收尾
    expect(导演).toContain("[未决线索]");
    expect(导演.indexOf("[未决线索]")).toBeLessThan(导演.indexOf("[关系水位]"));
    expect(导演.lastIndexOf("[视角红线]")).toBeGreaterThan(导演.indexOf("[未决线索]"));
  });

  it("18. confirmAllPendingCards 返回四类数量，只把待核转生效", async () => {
    const sid = makeSessionId("confirm-four");
    const sidOther = makeSessionId("confirm-other");
    expect(typeof storageApi.confirmAllPendingCards).toBe("function");

    await storageModule.saveMemoryCard(sid, mkMemory("待核记忆", { 状态: "待核" }));
    await seedThreads(sid, [
      mkThread("待核", { 状态: "待核" }),
      mkThread("归档", { 状态: "归档" }),
    ]);
    await seedForeshadows(sid, [mkForeshadow("待核", { 状态: "待核" })]);
    await seedThreads(sidOther, [mkThread("别场", { 状态: "待核" })]);

    const result = await storageApi.confirmAllPendingCards!(sid);
    expect(result).toMatchObject({ memories: 1, threads: 1, foreshadows: 1 });

    const 全部 = await listThreads(sid);
    expect(全部.find((t) => t.名称.includes(markOf("待核")))?.状态).toBe("生效");
    expect(全部.find((t) => t.名称.includes(markOf("归档")))?.状态).toBe("归档");
    const 别场 = await listThreads(sidOther);
    expect(别场[0].状态).toBe("待核");
  });
});
