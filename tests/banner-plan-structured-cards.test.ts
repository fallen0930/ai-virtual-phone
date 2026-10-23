import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageModule from "@/lib/narrative-writer/storage";
import * as writerModule from "@/lib/narrative-writer/writer";
import type {
  EmotionCard,
  MemoryCard,
  NarrativeWriterState,
  WaterLevelState,
} from "@/lib/narrative-writer/types";

// 走向卡生成重写（类型由代码分配）
//
// 覆盖什么（对应栗子的定稿要求）：
// 1) 类型三组轮换、目标由代码从线索/伏笔台账分配：banner-plan.ts 纯函数，不调模型；
//    没有可分配对象时按替补表换成语义邻近类型并如实标注（计划类型 ≠ 类型）。
// 2) 输出契约：每张卡一行「标题｜发生的变化｜代价｜（报幕）」，按**行序**与类型绑定；
//    解析宽松（行首序号、列表符、围栏、缺段）；个别缺行用代码骨架报幕保证三张；
//    三行全废才降级为纯文本。所有降级都不回写。
// 3) 提示词短：任务文本只含分配好的类型＋目标＋一句话上限，不含水位 JSON，长度有上限。
// 4) 标记由代码生成（模型不再照抄台账原文）；采纳回写只追加一条标注「计划」的最近变化，
//    线索状态每次最多升一级、永不自动到「收束」；骨架卡与无类型卡不回写。
// 5) 正文只收到报幕文本＋类型中性说法＋一句话上限：不出现「线索」「伏笔」二字、
//    不出现变化/代价文本、不出现机器标记。
// 6) waterLevelGuidance 纯函数：L0–L5 写死在代码里，叠加冻结/降阶/旧账/冻结项/戏外克制。
// 7) 失败降级：generateBannerOptions 空响应给中文错误（现状是英文 TypeError）；
//    批次指针与最近类型只在生成成功后落盘 writer_state，旧存档缺字段在读取处归一。
// 8) 换一批 = 再调一次生成，类型组合轮换且避开最近出过的类型；一次点击仍然只有一次调用。
//
// 只 mock 两处：大模型入口 sendLLMRequest，与住在 mixology/engine 里的 resolveMixApiConfig 桩。
// **本文件不 import mixology/engine**：走真实实现的是上下文拼装、生成走向卡、写正文、采纳回写、落盘。
//
// 尚未实现的 API 一律用可选签名或带 catch 的动态 import 取，保证「还没实现」表现为断言失败，
// 而不是模块解析错误（TS2307）或类型错误。

// ── 本地结构类型：新模块/新字段还没落地，测试按方案约定的形状断言 ──
type ChangeLike = { 变化: string; 轮次?: number; 来源消息ID?: string; 计划?: boolean };
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
  状态: string;
  来源消息ID?: string;
  来源轮次?: number;
  audience?: string[];
  createdAt: number;
  updatedAt: number;
};

/** 结构化走向卡（方案约定形状） */
type PlanCardLike = {
  id: string;
  类型: string;
  计划类型: string;
  已替换: boolean;
  目标?: { kind: string; id?: string; 名称: string };
  上限: string;
  骨架: boolean;
  回写?: { 类型: string; 名称?: string; 内容?: string; 新状态?: string; 变化?: string };
};
type ParsedLineLike = {
  标题: string;
  变化: string;
  代价: string;
  报幕: string;
  形态: string;
};
/** generateBannerOptions 的新返回值（结构化候选） */
type CandidateLike = {
  id: string;
  卡: PlanCardLike;
  标题: string;
  变化: string;
  代价: string;
  报幕: string;
  文本: string;
  形态: string;
  可回写: boolean;
};

type BannerPlanApi = {
  BANNER_GROUPS?: string[][];
  BANNER_TASK_MAX_CHARS?: number;
  RECENT_TYPES_KEEP?: number;
  assignBannerPlan?: (input: Record<string, unknown>) => PlanCardLike[];
  buildBannerTaskText?: (cards: PlanCardLike[]) => string;
  parseBannerLines?: (raw: string, cards: PlanCardLike[]) => ParsedLineLike[];
  skeletonBanner?: (card: PlanCardLike) => string;
  /** 标记由代码生成：目标与状态来自卡，"变化"文本来自模型那一句 */
  bannerMarker?: (card: PlanCardLike, 变化: string) => string;
};
type WaterLanguageApi = {
  WATER_LABELS?: Record<string, string>;
  waterLevelGuidance?: (w: WaterLevelState) => string;
  planWaterGuidance?: (
    waterLevels: Record<string, WaterLevelState>,
    opts: { 类型: string }
  ) => string;
};
type ThreadsApi = {
  applyAdoptedBanner?: (input: {
    sessionId: string;
    banner: string;
    来源消息ID?: string;
    来源轮次?: number;
    insert: (干净报幕: string) => Promise<unknown>;
  }) => Promise<{ 干净报幕: string; 推进数: number; 回收数: number; 忽略数: number }>;
};
type WriterBannerApi = {
  generateBannerOptions?: (input: unknown) => Promise<unknown>;
  writeWithSelectedBanner?: (input: unknown, selected: unknown) => Promise<unknown>;
};
type StorageBannerApi = {
  saveThreadCard?: (sessionId: string, card: ThreadLike) => Promise<void>;
  listThreadCards?: (sessionId: string) => Promise<ThreadLike[]>;
  getThreadCard?: (sessionId: string, id: string) => Promise<ThreadLike | null>;
  saveForeshadowCard?: (sessionId: string, card: ForeshadowLike) => Promise<void>;
  listForeshadowCards?: (sessionId: string) => Promise<ForeshadowLike[]>;
  getForeshadowCard?: (sessionId: string, id: string) => Promise<ForeshadowLike | null>;
  saveMemoryCard?: (sessionId: string, card: MemoryCard) => Promise<void>;
  saveEmotionCard?: (sessionId: string, card: EmotionCard) => Promise<void>;
  saveWaterLevel?: (sessionId: string, water: WaterLevelState) => Promise<void>;
  getWaterLevels?: (
    sessionId: string
  ) => Promise<Record<"戏内层" | "现实层" | "共识层", WaterLevelState>>;
  saveWriterState?: (sessionId: string, state: NarrativeWriterState) => Promise<void>;
  getWriterState?: (sessionId: string) => Promise<NarrativeWriterState>;
  purgeNarrativeSessionData?: (sessionId: string) => number;
};

const BANNER_PLAN_PATH: string = "../lib/narrative-writer/banner-plan";
const WATER_LANGUAGE_PATH: string = "../lib/narrative-writer/water-language";
const THREADS_PATH: string = "../lib/narrative-writer/threads";

async function bannerPlanModule(): Promise<BannerPlanApi> {
  const mod = await import(BANNER_PLAN_PATH).catch(() => null);
  expect(mod, "@/lib/narrative-writer/banner-plan 尚未实现").not.toBeNull();
  return mod as unknown as BannerPlanApi;
}
async function waterModule(): Promise<WaterLanguageApi> {
  const mod = await import(WATER_LANGUAGE_PATH).catch(() => null);
  expect(mod, "@/lib/narrative-writer/water-language 尚未实现").not.toBeNull();
  return mod as unknown as WaterLanguageApi;
}
async function threadsModule(): Promise<ThreadsApi> {
  const mod = await import(THREADS_PATH).catch(() => null);
  expect(mod, "@/lib/narrative-writer/threads 尚未实现").not.toBeNull();
  return mod as unknown as ThreadsApi;
}

function requireFn<K extends keyof StorageBannerApi>(
  name: K
): NonNullable<StorageBannerApi[K]> {
  const fn = (storageModule as unknown as StorageBannerApi)[name];
  expect(fn, `storage.${String(name)} 不可用`).toBeTypeOf("function");
  return fn as NonNullable<StorageBannerApi[K]>;
}
function requirePlanFn(name: keyof BannerPlanApi) {
  return (async () => {
    const api = await bannerPlanModule();
    const fn = api[name];
    expect(fn, `banner-plan.${name} 尚未实现`).toBeTypeOf("function");
    return fn;
  })();
}
const writerApi = writerModule as unknown as WriterBannerApi;

// ── LLM 桩：只记录请求，返回测试指定的负载 ──
const llmMock = vi.hoisted(() => ({
  calls: 0,
  respond: null as null | (() => string),
  requests: [] as Array<{ characterName: string; content: string; system: string }>,
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
    if (!llmMock.respond) return "[]";
    return llmMock.respond() as unknown as string;
  },
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

// ── 夹具 ──
const createdSessionIds = new Set<string>();
const BASE_TIME = 1_700_000_000_000;

function makeSessionId(tag: string): string {
  const sid = `tb_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  createdSessionIds.add(sid);
  return sid;
}
function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function markOf(tag: string): string {
  return `【${tag}】`;
}

function mkThread(tag: string, opts: Partial<ThreadLike> = {}): ThreadLike {
  return {
    id: `tb_t_${tag}_${rand()}`,
    kind: "thread",
    名称: opts.名称 ?? `线头${markOf(tag)}`,
    线索状态: opts.线索状态 ?? "潜伏",
    关联角色: opts.关联角色 ?? [],
    上次推进轮次: opts.上次推进轮次 ?? 1,
    下一步可能: opts.下一步可能 ?? "再查一层",
    最近变化: opts.最近变化 ?? [],
    状态: opts.状态 ?? "生效",
    来源消息ID: opts.来源消息ID,
    来源轮次: opts.来源轮次,
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  };
}
function mkForeshadow(tag: string, opts: Partial<ForeshadowLike> = {}): ForeshadowLike {
  return {
    id: `tb_f_${tag}_${rand()}`,
    kind: "foreshadow",
    内容: opts.内容 ?? `旧事${markOf(tag)}`,
    埋下轮次: opts.埋下轮次 ?? 2,
    预期回收窗口: opts.预期回收窗口 ?? { 起: 3, 止: 6 },
    伏笔状态: opts.伏笔状态 ?? "未收",
    状态: opts.状态 ?? "生效",
    来源消息ID: opts.来源消息ID,
    来源轮次: opts.来源轮次,
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  };
}
/** 夹具内容一律不带「线索」「伏笔」二字，正文侧的红线断言才有意义 */
function mkMemory(tag: string, opts: { 状态?: string; 主类型?: string } = {}): MemoryCard {
  return {
    id: `tb_m_${tag}_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: opts.主类型 ?? "经历节点",
    内容: `${markOf(tag)}当铺掌柜认得那枚硬币`,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: opts.状态 ?? "生效",
    证据: "测试夹具",
    时间: "第1天",
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  } as unknown as MemoryCard;
}
function mkEmotion(tag: string): EmotionCard {
  return {
    id: `tb_e_${tag}_${rand()}`,
    kind: "emotion",
    主体: "角色",
    标签: "在意",
    强度: 3,
    对象: "玩家",
    证据: "测试夹具",
    作用域: "戏内层",
    状态: "生效",
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  } as unknown as EmotionCard;
}
function mkWater(
  作用域: "戏内层" | "现实层" | "共识层",
  水位: string,
  opts: { status?: string; 未解决冲突?: string[]; 冻结项?: string[] } = {}
): WaterLevelState {
  return {
    作用域,
    水位: 水位 as WaterLevelState["水位"],
    status: (opts.status ?? "active") as WaterLevelState["status"],
    准入证据: [],
    未解决冲突: opts.未解决冲突 ?? [],
    冻结项: opts.冻结项 ?? [],
    最后更新: new Date(BASE_TIME).toISOString(),
  };
}

async function seedThreads(sid: string, cards: ThreadLike[]): Promise<void> {
  const save = requireFn("saveThreadCard");
  for (const c of cards) await save(sid, c as never);
}
async function seedForeshadows(sid: string, cards: ForeshadowLike[]): Promise<void> {
  const save = requireFn("saveForeshadowCard");
  for (const c of cards) await save(sid, c as never);
}
async function seedMemories(sid: string, cards: MemoryCard[]): Promise<void> {
  const save = requireFn("saveMemoryCard");
  for (const c of cards) await save(sid, c);
}
async function seedWaters(sid: string, waters: WaterLevelState[]): Promise<void> {
  const save = requireFn("saveWaterLevel");
  for (const w of waters) await save(sid, w);
}

function planInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threads: [],
    foreshadows: [],
    memories: [],
    emotions: [],
    waterLevels: {
      戏内层: mkWater("戏内层", "L1"),
      现实层: mkWater("现实层", "L0"),
      共识层: mkWater("共识层", "L1"),
    },
    当前角色: "角色A",
    当前轮次: 5,
    批次序号: 0,
    最近走向类型: [],
    ...overrides,
  };
}

/** 素材齐全的一组夹具：九种类型都有可绑的对象，用来验轮换与替补 */
function richPools() {
  return {
    threads: [
      mkThread("升温线", {
        名称: "AD升温",
        线索状态: "升温",
        上次推进轮次: 1,
        关联角色: ["角色A"],
      }),
      mkThread("潜伏线", { 名称: "AE潜伏", 线索状态: "潜伏", 上次推进轮次: 2 }),
    ],
    foreshadows: [
      mkForeshadow("近事", { 内容: "AF旧物", 预期回收窗口: { 起: 3, 止: 5 } }),
    ],
    memories: [
      mkMemory("待核素材", { 状态: "待核" }),
      mkMemory("世界变更素材", { 主类型: "世界变更" }),
      mkMemory("自我认知素材", { 主类型: "自我认知" }),
    ],
    emotions: [mkEmotion("在意")],
  };
}

async function seedRich(sid: string): Promise<void> {
  const pools = richPools();
  await seedThreads(sid, pools.threads);
  await seedForeshadows(sid, pools.foreshadows);
  await seedMemories(sid, pools.memories as unknown as MemoryCard[]);
  await storageModule.saveEmotionCard(sid, pools.emotions[0]);
}

function writerInput(sid: string, charName = "角色A") {
  return {
    sessionId: sid,
    characterProfile: { charName, profileText: "沉默寡言的守塔人。", worldText: "海边灯塔。" },
    worldSettings: {
      basePrompts: [] as string[],
      flavorPrompts: [] as string[],
      glassPrompts: [] as string[],
      strengthPrompts: [] as string[],
    },
    recentDialogue: "玩家：今天天气不错",
  };
}

/** 取最近一次发给模型的用户消息，按 JSON 解析出各字段 */
function lastPayload(): Record<string, string> {
  const req = llmMock.requests.filter((r) => r.characterName === "NarrativeWriter").pop();
  if (!req) throw new Error("没有发出 NarrativeWriter 请求");
  return JSON.parse(req.content) as Record<string, string>;
}

async function generate(sid: string, charName = "角色A"): Promise<CandidateLike[]> {
  const fn = writerApi.generateBannerOptions;
  expect(fn, "generateBannerOptions 不可用").toBeTypeOf("function");
  return (await fn!(writerInput(sid, charName) as never)) as CandidateLike[];
}

beforeEach(() => {
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests.length = 0;
});

afterEach(() => {
  const purge = storageModule.purgeNarrativeSessionData as (sid: string) => number;
  for (const sid of createdSessionIds) purge(sid);
  createdSessionIds.clear();
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests.length = 0;
});

// ════════════════════════════════════════════════════════════
// 一、类型分配与目标绑定（纯函数，不调模型）
// ════════════════════════════════════════════════════════════
describe("走向卡 · 类型三组轮换", () => {
  it("1. 三组类型按栗子给的顺序固定，且组内不重复", async () => {
    const api = await bannerPlanModule();
    expect(api.BANNER_GROUPS, "BANNER_GROUPS 尚未实现").toBeTypeOf("array");
    expect(api.BANNER_GROUPS).toEqual([
      ["主线", "关系", "变数"],
      ["世界动向", "伏笔回收", "人物内心"],
      ["升支线", "缓冲日常带暗线", "意外转折带因果"],
    ]);
    const 全部 = (api.BANNER_GROUPS ?? []).flat();
    expect(new Set(全部).size, "三组之间有重复类型").toBe(全部.length);
  });

  it("2. 批次 0/1/2 分别出第一/第二/第三组的类型，一次正好三张", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;
    const api = await bannerPlanModule();
    const 组 = api.BANNER_GROUPS!;

    for (let 批次 = 0; 批次 < 3; 批次 += 1) {
      const cards = 分配(planInput({ 批次序号: 批次 }));
      expect(cards, `批次${批次}的卡数`).toHaveLength(3);
      expect(cards.map((c) => c.计划类型), `批次${批次}的计划类型`).toEqual(组[批次]);
    }
  });
});

describe("走向卡 · 目标由线索台账分配", () => {
  it("3. 主线卡：爆发/升温里最久没推进的那条；同状态以最久未推进为主键，爆发优先于升温", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const 爆发新 = mkThread("爆发新", { 名称: "A线", 线索状态: "爆发", 上次推进轮次: 8 });
    const 爆发旧 = mkThread("爆发旧", { 名称: "B线", 线索状态: "爆发", 上次推进轮次: 2 });
    const 升温 = mkThread("升温", { 名称: "C线", 线索状态: "升温", 上次推进轮次: 1 });
    const 潜伏 = mkThread("潜伏", { 名称: "D线", 线索状态: "潜伏", 上次推进轮次: 0 });
    const cards = 分配(planInput({ threads: [爆发新, 升温, 潜伏, 爆发旧] }));

    const 主线 = cards.find((c) => c.类型 === "主线")!;
    expect(主线, "第一组里没有主线卡").toBeDefined();
    expect(主线.目标?.kind).toBe("thread");
    expect(主线.目标?.名称, "主线应绑最久没推进的爆发线").toBe("B线");
  });

  it("4. 关系卡：绑关联角色含当前角色的线索；没有就不绑目标，但照样出卡并带一句话上限", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const 别人的 = mkThread("别人", { 名称: "E线", 关联角色: ["角色B"] });
    const 我的 = mkThread("我的", { 名称: "F线", 关联角色: ["角色A", "角色B"] });
    const 有 = 分配(planInput({ threads: [别人的, 我的] }));
    const 关系有 = 有.find((c) => c.类型 === "关系")!;
    expect(关系有.目标?.名称, "关系卡应绑到含当前角色的那条线").toBe("F线");

    const 无 = 分配(planInput({ threads: [别人的] }));
    const 关系无 = 无.find((c) => c.类型 === "关系")!;
    expect(关系无.目标, "没有本角色的线时不该硬绑").toBeUndefined();
    expect(关系无.类型, "关系卡不能因为没线就被换掉").toBe("关系");
    expect(关系无.上限.length, "关系卡必须带一句话上限").toBeGreaterThan(4);
  });

  it("5. 变数卡：优先待核卡，其次未收伏笔，再次环境；永不绑线索", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const 待核 = mkMemory("待核素材", { 状态: "待核" });
    const 一线 = mkThread("主线素材", { 名称: "G线", 线索状态: "升温" });
    const 伏笔 = mkForeshadow("伏笔素材");

    const 有待核 = 分配(planInput({ memories: [待核], threads: [一线] })).find(
      (c) => c.类型 === "变数"
    )!;
    expect(有待核.目标?.kind, "变数卡优先吃待核卡").toBe("memory");

    const 只有伏笔 = 分配(planInput({ foreshadows: [伏笔], threads: [一线] })).find(
      (c) => c.类型 === "变数"
    )!;
    expect(只有伏笔.目标?.kind).toBe("foreshadow");

    const 光场 = 分配(planInput({ threads: [一线] })).find((c) => c.类型 === "变数")!;
    expect(光场.目标?.kind, "什么素材都没有时落到环境").toBe("environment");

    for (const card of [有待核, 只有伏笔, 光场]) {
      expect(card.目标?.kind, "变数卡不得绑线索").not.toBe("thread");
    }
  });

  it("6. 伏笔回收卡：已超期的优先，其次窗口最临近；绑到的伏笔要能被回写", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const 超期 = mkForeshadow("超期", { 内容: "H旧事", 预期回收窗口: { 起: 1, 止: 3 } });
    const 临近 = mkForeshadow("临近", { 内容: "I旧事", 预期回收窗口: { 起: 5, 止: 6 } });
    const 远处 = mkForeshadow("远处", { 内容: "J旧事", 预期回收窗口: { 起: 9, 止: 12 } });
    const cards = 分配(planInput({ foreshadows: [远处, 临近, 超期], 当前轮次: 5, 批次序号: 1 }));
    const 回收 = cards.find((c) => c.计划类型 === "伏笔回收")!;
    expect(回收.目标?.kind).toBe("foreshadow");
    expect(回收.目标?.名称, "已超期的那条优先").toBe("H旧事");
    expect(回收.回写?.类型, "伏笔回收卡要带回收回写").toBe("回收");

    const 未超期 = 分配(
      planInput({ foreshadows: [远处, 临近], 当前轮次: 5, 批次序号: 1 })
    ).find((c) => c.计划类型 === "伏笔回收")!;
    expect(未超期.目标?.名称, "都没超期时取窗口最临近的").toBe("I旧事");
  });

  it("7. 没有任何线索与伏笔：出满三张、不抛错、每张都有上限，需要素材的类型走替补并如实标注", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const cards = 分配(planInput());
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.上限.length, `${card.类型} 缺上限`).toBeGreaterThan(4);
      expect(typeof card.类型).toBe("string");
      expect(card.骨架, "代码分出来的卡不该直接标成骨架").toBe(false);
    }
  });

  it("8. 没有可回收伏笔时，伏笔回收被换成语义邻近类型并在计划类型里如实留痕", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const cards = 分配(planInput({ 批次序号: 1 }));
    const 原本 = cards.find((c) => c.计划类型 === "伏笔回收")!;
    expect(原本, "第二组里找不到伏笔回收那一张").toBeDefined();
    expect(原本.已替换, "无可回收伏笔却没有替换标记").toBe(true);
    expect(原本.类型, "仍然是伏笔回收就等于假装收了个不存在的伏笔").not.toBe("伏笔回收");
    expect(原本.目标?.kind, "替补卡不该再指向伏笔").not.toBe("foreshadow");
  });

  it("9. 升支线需要潜伏线；没有潜伏线时换成别的类型，不硬凑", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;

    const 只有爆发 = mkThread("爆发", { 名称: "K线", 线索状态: "爆发" });
    const 无潜伏 = 分配(planInput({ threads: [只有爆发], 批次序号: 2 })).find(
      (c) => c.计划类型 === "升支线"
    )!;
    expect(无潜伏.已替换, "没有潜伏线却还当升支线").toBe(true);

    const 有潜伏 = mkThread("潜伏", { 名称: "L线", 线索状态: "潜伏", 上次推进轮次: 3 });
    const 换上 = 分配(planInput({ threads: [只有爆发, 有潜伏], 批次序号: 2 })).find(
      (c) => c.计划类型 === "升支线"
    )!;
    expect(换上.已替换).toBe(false);
    expect(换上.目标?.名称).toBe("L线");
  });

  it("10. 最近 6 条里出过的类型走替补：整组都被刚用过时，三张各自换成可用且没重复的类型", async () => {
    const fn = await requirePlanFn("assignBannerPlan");
    const 分配 = fn as NonNullable<BannerPlanApi["assignBannerPlan"]>;
    if (typeof 分配 !== "function") return;
    const api = await bannerPlanModule();
    expect(api.RECENT_TYPES_KEEP, "RECENT_TYPES_KEEP 尚未导出").toBe(6);

    const cards = 分配(
      planInput({ ...richPools(), 批次序号: 0, 最近走向类型: ["主线", "关系", "变数"] })
    );
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.计划类型), "计划类型仍应是第一组").toEqual([
      "主线",
      "关系",
      "变数",
    ]);
    expect(cards.map((c) => c.类型), "刚用过的三种类型都没避开").toEqual([
      "伏笔回收",
      "人物内心",
      "世界动向",
    ]);
    expect(cards.every((c) => c.已替换), "换过类型却没标已替换").toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// 二、任务提示词：短、含分配结果、不含水位 JSON
// ════════════════════════════════════════════════════════════
describe("走向卡 · 任务提示词", () => {
  it("11. 任务文本含每张卡的类型与目标、含一句话上限，且不超过设定上限", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 拼任务 = (await requirePlanFn("buildBannerTaskText")) as NonNullable<
      BannerPlanApi["buildBannerTaskText"]
    >;
    if (typeof 分配 !== "function" || typeof 拼任务 !== "function") return;
    const api = await bannerPlanModule();

    const cards = 分配(
      planInput({
        threads: [mkThread("主线", { 名称: "M老桥", 线索状态: "升温", 上次推进轮次: 1 })],
        foreshadows: [mkForeshadow("旧事", { 内容: "N当票" })],
      })
    );
    const 文本 = 拼任务(cards);
    expect(typeof 文本).toBe("string");
    expect(文本).toContain("主线");
    expect(文本).toContain("M老桥");
    expect(文本, "上限一句话要进任务文本").toContain(cards[0].上限);
    expect(文本.length, "任务文本超出设定上限").toBeLessThanOrEqual(
      api.BANNER_TASK_MAX_CHARS ?? 0
    );
  });

  it("12. 任务文本与导演上下文都不含水位 JSON 字段名", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 拼任务 = (await requirePlanFn("buildBannerTaskText")) as NonNullable<
      BannerPlanApi["buildBannerTaskText"]
    >;
    if (typeof 分配 !== "function" || typeof 拼任务 !== "function") return;

    const 文本 = 拼任务(分配(planInput()));
    expect(文本).not.toContain("准入证据");
    expect(文本).not.toContain('"水位"');
    expect(文本).not.toContain('"status"');
    expect(文本).not.toContain("冻结项");
  });

  it("13. 「注意：」只允许出现在变数与意外转折带因果两类（不再要求必须有转折预告）", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 拼任务 = (await requirePlanFn("buildBannerTaskText")) as NonNullable<
      BannerPlanApi["buildBannerTaskText"]
    >;
    if (typeof 分配 !== "function" || typeof 拼任务 !== "function") return;

    const 文本 = 拼任务(分配(planInput()));
    expect(文本, "任务里没写「注意」的归属限制").toContain("注意");
    expect(文本, "旧的硬性转折预告还留着").not.toContain("至少包含1个转折预告");
    expect(文本).toContain("只输出这三行");
  });

  it("14. 真实链路：generateBannerOptions 的任务字段是短提示词，不再要求模型照抄台账原文", async () => {
    const sid = makeSessionId("task-text");
    await seedThreads(sid, [mkThread("链路", { 名称: "O硬币", 线索状态: "升温" })]);
    llmMock.respond = () =>
      [
        "旧物去向｜掌柜认得硬币｜追问要付代价｜（基调：推进｜场景：旧城｜走向：查证）",
        "沉默一夜｜两人各退一步｜谁都没先开口｜（基调：缓冲｜场景：灯塔｜走向：独处）",
        "潮声变调｜灯塔下来了生人｜新面孔带来麻烦｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");

    await generate(sid);
    const 任务 = lastPayload()["任务"] ?? "";
    expect(任务, "任务字段没换成短提示词").not.toContain("悬念回写标记");
    expect(任务).not.toContain("一字不差");
    expect(任务).toContain("O硬币");
    expect(任务.length, "任务字段超出短提示词上限").toBeLessThanOrEqual(600);
  });
});

// ════════════════════════════════════════════════════════════
// 三、解析、兜底与失败降级
// ════════════════════════════════════════════════════════════
describe("走向卡 · 解析与兜底", () => {
  it("15. 结构化三行按行序与类型绑定，四段齐全", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 解析 = (await requirePlanFn("parseBannerLines")) as NonNullable<
      BannerPlanApi["parseBannerLines"]
    >;
    if (typeof 分配 !== "function" || typeof 解析 !== "function") return;

    const cards = 分配(planInput());
    const 行 = [
      "标题一｜变化一｜代价一｜（基调：日常｜场景：灯塔｜走向：闲聊）",
      "标题二｜变化二｜代价二｜（基调：推进｜场景：旧城｜走向：查证）",
      "标题三｜变化三｜代价三｜（基调：转折｜场景：海堤｜走向：来客）",
    ].join("\n");
    const 结果 = 解析(行, cards);
    expect(结果).toHaveLength(3);
    expect(结果[0].标题).toBe("标题一");
    expect(结果[0].变化).toBe("变化一");
    expect(结果[0].代价).toBe("代价一");
    expect(结果[0].报幕).toBe("（基调：日常｜场景：灯塔｜走向：闲聊）");
    expect(结果.map((r) => r.形态)).toEqual(["结构化", "结构化", "结构化"]);
    expect(结果[1].报幕, "第二行必须对齐第二张卡").toContain("推进");
  });

  it("16. 宽松解析：行首序号、列表符、代码围栏都不该让整行作废", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 解析 = (await requirePlanFn("parseBannerLines")) as NonNullable<
      BannerPlanApi["parseBannerLines"]
    >;
    if (typeof 分配 !== "function" || typeof 解析 !== "function") return;

    const cards = 分配(planInput());
    const 行 = [
      "```",
      "1. 标题一｜变化一｜代价一｜（基调：日常｜场景：灯塔｜走向：闲聊）",
      "- 标题二｜变化二｜代价二｜（基调：推进｜场景：旧城｜走向：查证）",
      "3) 标题三｜变化三｜代价三｜（基调：转折｜场景：海堤｜走向：来客）",
      "```",
    ].join("\n");
    const 结果 = 解析(行, cards);
    expect(结果.filter((r) => r.报幕.startsWith("（"))).toHaveLength(3);
    expect(结果[0].标题).toBe("标题一");
    expect(结果[0].报幕).toBe("（基调：日常｜场景：灯塔｜走向：闲聊）");
  });

  it("17. 缺段：整行找得到全角括号对就拿它当报幕，变化与代价留空", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 解析 = (await requirePlanFn("parseBannerLines")) as NonNullable<
      BannerPlanApi["parseBannerLines"]
    >;
    if (typeof 分配 !== "function" || typeof 解析 !== "function") return;

    const cards = 分配(planInput());
    const 行 = [
      "（基调：日常｜场景：灯塔｜走向：闲聊）",
      "只有一句（基调：推进｜场景：旧城｜走向：查证）收尾而已",
      "这一段完全没有括号也没有报幕",
    ].join("\n");
    const 结果 = 解析(行, cards);
    expect(结果[0].报幕).toBe("（基调：日常｜场景：灯塔｜走向：闲聊）");
    expect(结果[0].形态).toBe("宽松");
    expect(结果[0].变化).toBe("");
    expect(结果[0].代价).toBe("");
    expect(结果[1].报幕).toBe("（基调：推进｜场景：旧城｜走向：查证）");
    expect(结果[1].形态).toBe("宽松");
    expect(结果[2].形态, "缺行应当被识别成缺行").toBe("骨架");
  });

  it("18. 个别缺行用代码骨架报幕兜底：仍是三张、≤40 字、且这张卡不回写", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 解析 = (await requirePlanFn("parseBannerLines")) as NonNullable<
      BannerPlanApi["parseBannerLines"]
    >;
    const 骨架 = (await requirePlanFn("skeletonBanner")) as NonNullable<
      BannerPlanApi["skeletonBanner"]
    >;
    if (
      typeof 分配 !== "function" ||
      typeof 解析 !== "function" ||
      typeof 骨架 !== "function"
    )
      return;

    const cards = 分配(
      planInput({
        threads: [mkThread("骨架素材", { 名称: "P灯语", 线索状态: "升温", 上次推进轮次: 1 })],
      })
    );
    const 缺一行 = 解析(
      [
        "标题｜变化｜代价｜（基调：日常｜场景：灯塔｜走向：闲聊）",
        "",
        "标题三｜变化三｜代价三｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n"),
      cards
    );
    expect(缺一行).toHaveLength(3);
    expect(缺一行[1].形态).toBe("骨架");
    expect(缺一行[1].报幕.startsWith("（") && 缺一行[1].报幕.endsWith("）")).toBe(true);
    expect(缺一行[1].报幕.length, "骨架报幕超过 40 字").toBeLessThanOrEqual(40);

    const 文本 = 骨架(cards[0]);
    expect(文本.startsWith("（") && 文本.endsWith("）")).toBe(true);
    expect(文本.length).toBeLessThanOrEqual(40);
    expect(文本, "骨架报幕不许出现台账术语").not.toMatch(/线索|伏笔/);
  });

  it("19. 三行全废：降级为纯文本展示，不回写", async () => {
    const sid = makeSessionId("all-garbage");
    await seedThreads(sid, [mkThread("乱", { 名称: "Q线", 线索状态: "升温" })]);
    llmMock.respond = () => "我不知道该写什么。\n抱歉。";

    const cards = await generate(sid);
    expect(cards, "乱格式时没降级成纯文本，而是直接不给卡").toHaveLength(3);
    for (const card of cards) {
      expect(card.形态, "缺行应按纯文本降级展示").toBe("纯文本");
      expect(card.可回写, "解析失败的一律不回写").toBe(false);
      expect(card.文本, "纯文本形态不该带机器标记").not.toContain("[推进:");
    }
  });

  it("20. 空响应给中文错误，不再抛英文 TypeError", async () => {
    const sid = makeSessionId("empty-response");
    llmMock.respond = () => "";
    await expect(generate(sid)).rejects.toThrow(/报幕|走向卡|内容为空|重试/);

    const 抛出 = await generate(sid).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(抛出).toBeInstanceOf(Error);
    expect(String((抛出 as Error).message)).not.toMatch(/split|undefined|Cannot read/);
  });

  it("21. 模型返回非字符串（桩返回 undefined）同样给中文错误", async () => {
    const sid = makeSessionId("null-response");
    llmMock.respond = () => undefined as never;
    const 抛出 = await generate(sid).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(抛出, "空响应没抛错").toBeInstanceOf(Error);
    expect(String((抛出 as Error).message)).not.toMatch(/split|undefined|Cannot read/);
  });

  it("22. 生成成功才推进批次指针；失败不消耗批次", async () => {
    const sid = makeSessionId("pointer");
    const 读状态 = requireFn("getWriterState") as NonNullable<
      StorageBannerApi["getWriterState"]
    >;

    llmMock.respond = () => "";
    await generate(sid).catch(() => undefined);
    const 失败后 = await 读状态(sid);
    expect((失败后 as Record<string, unknown>)["走向批次序号"], "失败也推进了批次").toBe(0);
    expect((失败后 as Record<string, unknown>)["最近走向类型"]).toEqual([]);

    llmMock.respond = () =>
      [
        "标题一｜变化一｜代价一｜（基调：日常｜场景：灯塔｜走向：闲聊）",
        "标题二｜变化二｜代价二｜（基调：推进｜场景：旧城｜走向：查证）",
        "标题三｜变化三｜代价三｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");
    const 批 = await generate(sid);
    const 成功后 = await 读状态(sid);
    expect((成功后 as Record<string, unknown>)["走向批次序号"], "成功后没推进批次").toBe(1);
    expect(
      (成功后 as Record<string, unknown>)["最近走向类型"],
      "落盘的最近类型应与本批实际出的类型一致"
    ).toEqual(批.map((c) => c.类型));
  });

  it("23. 换一批：每点一次轮换一组、避开上一批类型，且一次点击只有一次调用", async () => {
    const sid = makeSessionId("rotate");
    await seedRich(sid);
    llmMock.respond = () =>
      [
        "标题｜变化｜代价｜（基调：日常｜场景：灯塔｜走向：闲聊）",
        "标题｜变化｜代价｜（基调：推进｜场景：旧城｜走向：查证）",
        "标题｜变化｜代价｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");

    const 第一批 = await generate(sid);
    const 第二批 = await generate(sid);
    const 第三批 = await generate(sid);
    const 类型 = (list: CandidateLike[]) => list.map((c) => c.类型);

    expect(类型(第一批)).toEqual(["主线", "关系", "变数"]);
    expect(类型(第二批)).toEqual(["世界动向", "伏笔回收", "人物内心"]);
    expect(类型(第三批)).toEqual(["升支线", "缓冲日常带暗线", "意外转折带因果"]);
    const 三批 = [第一批, 第二批, 第三批];
    for (let i = 1; i < 3; i += 1) {
      const 上一批 = new Set(类型(三批[i - 1]));
      expect(
        类型(三批[i]).filter((t) => 上一批.has(t)),
        `第${i + 1}批与上一批有重复类型`
      ).toEqual([]);
    }
    expect(llmMock.calls, "换一批不该多发调用，也不该只发一次").toBe(3);
  });

  it("24. 旧存档缺新字段：读取处归一化，脏值不进减法与索引", async () => {
    const sid = makeSessionId("legacy-state");
    const 存 = requireFn("saveWriterState") as NonNullable<StorageBannerApi["saveWriterState"]>;
    const 读 = requireFn("getWriterState") as NonNullable<StorageBannerApi["getWriterState"]>;
    const 原始 = {
      ...(await 读(sid)),
      ...({
        走向批次序号: "7",
        最近走向类型: ["主线", null, 3, "主线", "不存在类型"],
      } as unknown as Partial<NarrativeWriterState>),
    };
    await 存(sid, 原始);
    // 直接写脏数据：先清掉归一化可能被覆盖的键，再落盘
    const 状态 = await 读(sid);
    expect((状态 as Record<string, unknown>)["走向批次序号"], "批次指针该是 0-2 的数字").toBe(
      1
    );
    expect((状态 as Record<string, unknown>)["最近走向类型"], "脏类型该被丢掉、重复该被压掉").toEqual(
      ["主线"]
    );

    const 干净 = await 读(makeSessionId("fresh-state"));
    expect((干净 as Record<string, unknown>)["走向批次序号"]).toBe(0);
    expect((干净 as Record<string, unknown>)["最近走向类型"]).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// 四、代码生成标记与采纳回写
// ════════════════════════════════════════════════════════════
describe("走向卡 · 代码标记与采纳回写", () => {
  it("25. 标记由代码生成，内容与卡的目标完全一致", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 标记 = (await requirePlanFn("bannerMarker")) as NonNullable<
      BannerPlanApi["bannerMarker"]
    >;
    if (typeof 分配 !== "function" || typeof 标记 !== "function") return;

    const cards = 分配(
      planInput({
        threads: [mkThread("推进", { 名称: "R硬币", 线索状态: "升温", 上次推进轮次: 1 })],
        foreshadows: [mkForeshadow("回收", { 内容: "S旧账", 预期回收窗口: { 起: 1, 止: 3 } })],
        批次序号: 0,
      })
    );
    const 主线 = cards.find((c) => c.类型 === "主线")!;
    expect(标记(主线, "计划变化一")).toBe("[推进:R硬币→爆发:计划变化一]");

    const 回收卡 = 分配(
      planInput({
        foreshadows: [mkForeshadow("回收2", { 内容: "T旧账", 预期回收窗口: { 起: 1, 止: 2 } })],
        批次序号: 1,
      })
    ).find((c) => c.类型 === "伏笔回收")!;
    expect(标记(回收卡, "任何变化"), "回收标记只带伏笔内容").toBe("[回收:T旧账]");

    const 潜伏 = mkThread("升一级", { 名称: "AG潜伏", 线索状态: "潜伏", 上次推进轮次: 1 });
    const 爆发 = mkThread("封顶", { 名称: "AH爆发", 线索状态: "爆发", 上次推进轮次: 1 });
    const 第三批 = 分配(planInput({ threads: [潜伏, 爆发], 批次序号: 2 }));
    const 升支线 = 第三批.find((c) => c.类型 === "升支线")!;
    expect(标记(升支线, "翻出了钥匙"), "潜伏只能升到升温").toBe(
      "[推进:AG潜伏→升温:翻出了钥匙]"
    );
    const 转折 = 第三批.find((c) => c.类型 === "意外转折带因果")!;
    expect(转折.目标?.名称, "资产都被占用时允许复用，不该因此换掉类型").toBe("AH爆发");
    expect(标记(转折, "摊牌"), "爆发已经是顶点，不能再往上").toContain("→爆发:");
  });

  it("26. 不推进台账的类型不带标记：变数、世界动向、人物内心、缓冲日常带暗线", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    const 标记 = (await requirePlanFn("bannerMarker")) as NonNullable<
      BannerPlanApi["bannerMarker"]
    >;
    if (typeof 分配 !== "function" || typeof 标记 !== "function") return;

    const 不推进台账 = ["变数", "世界动向", "人物内心", "缓冲日常带暗线"];
    const pools = richPools();
    let 推进卡数 = 0;
    for (const 批次序号 of [0, 1, 2]) {
      for (const card of 分配(planInput({ ...pools, 批次序号 }))) {
        if (不推进台账.includes(card.类型)) {
          expect(标记(card, "某变化"), `${card.类型} 不该带机器标记`).toBe("");
          expect(card.回写, `${card.类型} 不该有回写`).toBeUndefined();
        }
        if (card.回写?.类型 === "推进") 推进卡数 += 1;
      }
    }
    expect(推进卡数, "三批里没有任何一张推进类回写，规则表没被执行").toBeGreaterThan(0);
  });

  it("27. 骨架卡与纯文本卡不带标记，采纳时一行台账都不写", async () => {
    const sid = makeSessionId("no-writeback");
    await seedThreads(sid, [mkThread("不写", { 名称: "W硬币", 线索状态: "升温" })]);
    llmMock.respond = () => "随便说点什么\n没有括号的一行\n还是没有括号";

    const cards = await generate(sid);
    const 标记总数 = cards.filter((c) => c.可回写).length;
    expect(标记总数, "全废解析不该有可回写的卡").toBe(0);

    const api = await threadsModule();
    const 采纳 = api.applyAdoptedBanner as NonNullable<ThreadsApi["applyAdoptedBanner"]>;
    expect(typeof 采纳).toBe("function");
    const 全部 = await seedAndAdopt(采纳, sid, cards[0].报幕);
    expect(全部.推进数 + 全部.回收数 + 全部.忽略数).toBe(0);

    const 之后 = await requireFn("listThreadCards")(sid);
    expect(之后[0].最近变化, "没标记的采纳不该追加变化").toEqual([]);
  });

  it("28. 采纳回写：只追加一条最近变化、标注「计划」、线索状态每次最多升一级", async () => {
    const sid = makeSessionId("writeback-once");
    const 潜伏 = mkThread("升一级", { 名称: "X线", 线索状态: "潜伏", 上次推进轮次: 1 });
    await seedThreads(sid, [潜伏]);
    const api = await threadsModule();
    const 采纳 = api.applyAdoptedBanner as NonNullable<ThreadsApi["applyAdoptedBanner"]>;
    expect(typeof 采纳).toBe("function");

    const 结果 = await 采纳!({
      sessionId: sid,
      banner: "（基调：日常｜场景：灯塔｜走向：翻旧物）[推进:X线→升温:翻出了那把钥匙]",
      insert: async () => ({ 消息ID: "msg_1", 轮次: 9 }),
    });
    expect(结果.推进数).toBe(1);

    const 之后 = (await requireFn("getThreadCard")(sid, 潜伏.id))!;
    expect(之后.最近变化).toHaveLength(1);
    expect(之后.最近变化[0].变化).toBe("翻出了那把钥匙");
    expect(之后.最近变化[0].计划, "采纳回写反映的是报幕的计划，必须标出来").toBe(true);
    expect(之后.线索状态).toBe("升温");
    expect(之后.上次推进轮次).toBe(9);
  });

  it("29. 采纳回写永不会把线推到「收束」：爆发保持爆发", async () => {
    const sid = makeSessionId("no-closure");
    const 爆发 = mkThread("爆发线", { 名称: "Y线", 线索状态: "爆发", 上次推进轮次: 2 });
    await seedThreads(sid, [爆发]);
    const api = await threadsModule();
    const 采纳 = api.applyAdoptedBanner as NonNullable<ThreadsApi["applyAdoptedBanner"]>;
    expect(typeof 采纳).toBe("function");

    await 采纳!({
      sessionId: sid,
      banner: "（基调：高潮｜场景：旧城｜走向：摊牌）[推进:Y线→收束:线头断了]",
      insert: async () => ({ 消息ID: "msg_2", 轮次: 10 }),
    });
    const 之后 = (await requireFn("getThreadCard")(sid, 爆发.id))!;
    expect(之后.线索状态, "标记越级或被写成收束时，代码要拦住").toBe("爆发");
    expect(之后.最近变化).toHaveLength(1);
  });

  it("30. 真实链路：采纳主线卡后，代码生成的标记随卡走，台账被正确回写", async () => {
    const sid = makeSessionId("chain-writeback");
    const 升温 = mkThread("链路推进", { 名称: "Z硬币", 线索状态: "升温", 上次推进轮次: 1 });
    await seedThreads(sid, [升温]);
    llmMock.respond = () =>
      [
        "掌柜认人｜掌柜认出硬币，线彻底压不住了｜再问下去会被盯上｜（基调：推进｜场景：旧城｜走向：查证）",
        "沉默一夜｜两人各退一步｜谁都没先开口｜（基调：缓冲｜场景：灯塔｜走向：独处）",
        "潮声变调｜灯塔下来了生人｜新面孔带来麻烦｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");

    const cards = await generate(sid);
    expect(cards).toHaveLength(3);
    const 主线 = cards.find((c) => c.卡.类型 === "主线")!;
    expect(主线.卡.目标?.名称).toBe("Z硬币");
    expect(主线.可回写).toBe(true);
    expect(主线.文本, "候选文本应带上代码生成的标记").toContain("[推进:Z硬币→爆发:");
    expect(主线.报幕, "对局显示的报幕文本不带标记").not.toContain("[推进:");

    const api = await threadsModule();
    const 采纳 = api.applyAdoptedBanner as NonNullable<ThreadsApi["applyAdoptedBanner"]>;
    expect(typeof 采纳).toBe("function");
    const 结果 = await seedAndAdopt(采纳, sid, 主线.文本);
    expect(结果.推进数).toBe(1);
    expect(结果.忽略数, "代码生成的标记不该匹配不上").toBe(0);

    const 之后 = (await requireFn("getThreadCard")(sid, 升温.id))!;
    expect(之后.线索状态).toBe("爆发");
    expect(之后.最近变化[0].变化).toBe("掌柜认出硬币，线彻底压不住了");
    expect(之后.最近变化[0].计划).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// 五、正文侧：只见报幕与类型
// ════════════════════════════════════════════════════════════
describe("走向卡 · 正文提示词的边界", () => {
  it("31. 写正文时不出现「线索」「伏笔」二字，也不出现变化/代价文本与标记", async () => {
    const sid = makeSessionId("body-boundary");
    await seedThreads(sid, [
      mkThread("正文边界", { 名称: "AA旧事", 线索状态: "潜伏", 上次推进轮次: 1 }),
    ]);
    await seedForeshadows(sid, [
      mkForeshadow("正文边界", { 内容: "AB旧物", 预期回收窗口: { 起: 1, 止: 2 } }),
    ]);
    llmMock.respond = () =>
      [
        "标题甲｜变化甲很具体｜代价甲很重｜（基调：日常｜场景：灯塔｜走向：闲聊）",
        "标题乙｜变化乙很具体｜代价乙很重｜（基调：推进｜场景：旧城｜走向：查证）",
        "标题丙｜变化丙很具体｜代价丙很重｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");

    await generate(sid);
    // 第二批才有伏笔回收卡：它的目标就是一个「伏笔」资产，最容易漏进正文
    const 第二批 = await generate(sid);
    const 回收卡 = 第二批.find((c) => c.卡.类型 === "伏笔回收")!;
    expect(回收卡, "第二批里没有伏笔回收卡").toBeDefined();
    expect(回收卡.变化.length, "夹具没给出变化文本，断言会空转").toBeGreaterThan(0);

    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文一段。";
    const fn = writerApi.writeWithSelectedBanner;
    expect(fn, "writeWithSelectedBanner 不可用").toBeTypeOf("function");
    const 结果 = (await fn!(writerInput(sid) as never, 回收卡 as never)) as {
      banner: string;
      body: string;
    };

    const 内容 = lastPayload();
    const 全文 = JSON.stringify(内容);
    expect(全文, "正文提示词出现了台账术语").not.toMatch(/线索|伏笔/);
    expect(全文, "正文提示词出现了回收目标名").not.toContain("AB旧物");
    expect(全文).not.toContain("[推进:");
    expect(全文).not.toContain("[回收:");
    expect(全文, "变化文本不该进正文").not.toContain(回收卡.变化);
    expect(全文, "代价文本不该进正文").not.toContain(回收卡.代价);
    expect(内容["任务"], "正文要收到报幕原文").toContain(回收卡.报幕);
    expect(结果.banner, "返回的报幕必须干净").not.toContain("[");
  });

  it("32. 正文收到类型中性说法与一句话上限", async () => {
    const sid = makeSessionId("body-type");
    await seedWaters(sid, [mkWater("戏内层", "L3")]);
    llmMock.respond = () =>
      [
        "标题甲｜变化甲｜代价甲｜（基调：日常｜场景：灯塔｜走向：闲聊）",
        "标题乙｜变化乙｜代价乙｜（基调：推进｜场景：旧城｜走向：查证）",
        "标题丙｜变化丙｜代价丙｜（基调：转折｜场景：海堤｜走向：来客）",
      ].join("\n");
    const cards = await generate(sid);
    const 关系 = cards.find((c) => c.卡.类型 === "关系")!;

    llmMock.respond = () => "（基调：日常｜场景：灯塔｜走向：闲聊）\n\n正文一段。";
    const fn = writerApi.writeWithSelectedBanner as NonNullable<
      WriterBannerApi["writeWithSelectedBanner"]
    >;
    expect(typeof fn).toBe("function");
    await fn!(writerInput(sid) as never, 关系 as never);

    const 任务 = lastPayload()["任务"] ?? "";
    expect(任务, "正文任务里没有类型说明").toContain("关系");
    expect(任务, "正文任务里没有一句话上限").toContain(关系.卡.上限);
  });

  it("33. inferMetadata 仍按「注意」识别转折点", async () => {
    const sid = makeSessionId("metadata-note");
    llmMock.respond = () => "（基调：转折｜场景：海堤｜注意：会有人来）\n\n正文一段。";
    const fn = writerApi.writeWithSelectedBanner as NonNullable<
      WriterBannerApi["writeWithSelectedBanner"]
    >;
    expect(typeof fn).toBe("function");

    const 带注意 = (await fn!(
      writerInput(sid) as never,
      "（基调：转折｜场景：海堤｜注意：会有人来）" as never
    )) as { metadata: { isTurningPoint: boolean } };
    expect(带注意.metadata.isTurningPoint).toBe(true);

    const 无注意 = (await fn!(
      writerInput(sid) as never,
      "（基调：日常｜场景：灯塔｜走向：闲聊）" as never
    )) as { metadata: { isTurningPoint: boolean } };
    expect(无注意.metadata.isTurningPoint).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// 六、waterLevelGuidance：一句话上限
// ════════════════════════════════════════════════════════════
describe("水位 · 一句话上限", () => {
  it("34. 六级各含阶段词与可出现/不宜，L1 与 L2 不合并", async () => {
    const api = await waterModule();
    const 生成 = api.waterLevelGuidance as NonNullable<WaterLanguageApi["waterLevelGuidance"]>;
    expect(typeof 生成).toBe("function");
    expect(api.WATER_LABELS, "WATER_LABELS 没抽到共享模块").toBeTypeOf("object");
    expect(Object.keys(api.WATER_LABELS ?? {})).toHaveLength(6);

    const 文本 = (水位: string) => 生成!(mkWater("戏内层", 水位));
    expect(文本("L0")).toContain("刚认识");
    expect(文本("L1")).toContain("有点熟了");
    expect(文本("L2")).toContain("已经挺熟");
    expect(文本("L3")).toContain("关系不错");
    expect(文本("L4")).toContain("很亲密了");
    expect(文本("L5")).toContain("最亲密");
    for (const 水位 of ["L0", "L1", "L2", "L3", "L4", "L5"]) {
      expect(文本(水位), `${水位} 缺「可出现」`).toContain("可出现");
    }
    expect(文本("L1"), "L1 的频次限制丢了").toContain("1 次");
    expect(文本("L2")).toContain("玩笑");
    expect(文本("L0"), "L0 该有不宜").toContain("不宜");
  });

  it("35. 冻结、降阶、旧账、冻结项各自叠加", async () => {
    const api = await waterModule();
    const 生成 = api.waterLevelGuidance as NonNullable<WaterLanguageApi["waterLevelGuidance"]>;
    expect(typeof 生成).toBe("function");

    expect(生成!(mkWater("戏内层", "L3", { status: "frozen" }))).toContain("冻结");
    const 降阶 = 生成!(mkWater("戏内层", "L4", { status: "degraded" }));
    expect(降阶).toContain("降阶");
    expect(降阶, "降阶该用 L3 的上限").toContain("邀约");
    expect(降阶, "降到 L0 就到底了").not.toContain("最亲密");
    expect(生成!(mkWater("戏内层", "L0", { status: "degraded" }))).toContain("刚认识");
    expect(
      生成!(mkWater("戏内层", "L2", { 未解决冲突: ["借的钱没还", "另一笔"] }))
    ).toContain("借的钱没还");
    expect(生成!(mkWater("戏内层", "L2", { 冻结项: ["不提母亲"] }))).toContain("不提母亲");
  });

  it("36. 进走向卡的作用域：戏内总是给；共识只在冻结或有旧账时给；现实只在低于戏内且类型是关系/人物内心时给", async () => {
    const api = await waterModule();
    const 选 = api.planWaterGuidance as NonNullable<WaterLanguageApi["planWaterGuidance"]>;
    expect(typeof 选).toBe("function");

    const 平静 = {
      戏内层: mkWater("戏内层", "L2"),
      共识层: mkWater("共识层", "L2"),
      现实层: mkWater("现实层", "L1"),
    };
    expect(选!(平静, { 类型: "主线" })).toContain("戏内层");
    expect(选!(平静, { 类型: "主线" })).not.toContain("共识层");
    expect(选!(平静, { 类型: "主线" })).not.toContain("现实层");

    const 有账 = {
      戏内层: mkWater("戏内层", "L2"),
      共识层: mkWater("共识层", "L2", { 未解决冲突: ["失约"] }),
      现实层: mkWater("现实层", "L1"),
    };
    expect(选!(有账, { 类型: "主线" })).toContain("共识层");

    const 戏外低 = {
      戏内层: mkWater("戏内层", "L4"),
      共识层: mkWater("共识层", "L4"),
      现实层: mkWater("现实层", "L1"),
    };
    expect(选!(戏外低, { 类型: "关系" })).toContain("戏外克制");
    expect(选!(戏外低, { 类型: "人物内心" })).toContain("戏外克制");
    expect(选!(戏外低, { 类型: "主线" })).not.toContain("戏外克制");
  });

  it("37. 每张卡都拿到一句上限，且上限里不含台账术语与 JSON 字段", async () => {
    const 分配 = (await requirePlanFn("assignBannerPlan")) as NonNullable<
      BannerPlanApi["assignBannerPlan"]
    >;
    if (typeof 分配 !== "function") return;
    const cards = 分配(
      planInput({
        threads: [mkThread("上限检查", { 名称: "AC线", 线索状态: "升温" })],
        waterLevels: {
          戏内层: mkWater("戏内层", "L3"),
          共识层: mkWater("共识层", "L3"),
          现实层: mkWater("现实层", "L2"),
        },
      })
    );
    for (const card of cards) {
      expect(card.上限).toContain("戏内层");
      expect(card.上限).not.toMatch(/线索|伏笔/);
      expect(card.上限).not.toContain("准入证据");
      expect(card.上限.length).toBeLessThanOrEqual(120);
    }
  });
});

// ── 辅助：把一条候选文本当作采纳动作跑一遍 ──
async function seedAndAdopt(
  采纳: NonNullable<ThreadsApi["applyAdoptedBanner"]>,
  sid: string,
  带标记报幕: string
): Promise<{ 干净报幕: string; 推进数: number; 回收数: number; 忽略数: number }> {
  return 采纳({
    sessionId: sid,
    banner: 带标记报幕,
    insert: async () => ({ 消息ID: `msg_${rand()}`, 轮次: 12 }),
  });
}
