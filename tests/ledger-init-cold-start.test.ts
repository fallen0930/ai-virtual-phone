import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageModule from "@/lib/narrative-writer/storage";
import { assignBannerPlan } from "@/lib/narrative-writer/banner-plan";
import type { MemoryCard } from "@/lib/narrative-writer/types";

// 台账冷启动（初始化台账 + 手动新增线索/伏笔）
//
// 为什么做这件事（栗子的定稿）：真机试玩那场对局 127 轮、69 条回复，台账里只有我试玩那
// 一次热抽出来的 1 条潜伏线索，伏笔 0 条 —— 九类走向里主线与伏笔回收永远分不到对象。
// 根因是时间差：线索卡功能上线比她跑补抽/整理晚了两小时，历史内容不会被热抽重看
// （热抽每次只喂"最后一条 assistant 正文"）。所以需要一个**能一次把整局剧情读成台账**的入口。
//
// 覆盖什么：
// 1) 初始化台账只调一次模型；输入只有 L3 大纲全文、最近 2 条 L2 摘要、已生效记忆卡标题
//    （最多 12 条、每条截 40 字）、已有线索/伏笔名称、当前角色名与人物名单 —— 不许拿待核卡当素材。
// 2) 产出 ≤6 条线索、≤4 条伏笔，全部以待核入库、audience 为 all、不写来源（= 来源未知，
//    因此永不被"丢弃即归档"与竞态检查触碰），并留一条"由剧情大纲初始化，未经核对"的变化记录。
// 3) 线索状态由模型给（潜伏｜升温｜爆发，不许收束，代码兜底潜伏）；这条决定了主线能不能立刻有素材。
// 4) 判重复用台账已有的归一化名称规则：同名不覆盖、不改状态、只计跳过。
// 5) 长度由代码截断：线索名 ≤20、下一步可能 ≤30、伏笔内容 ≤40；空名称直接丢弃。
// 6) 关联角色必须用原名：不在人物名单里、且大纲里也没出现过的人物名一律丢弃，丢光则为空数组。
// 7) 无大纲时不调用模型（断言 mock 收到 0 次请求），只返回"请先整理记忆"。
// 8) 防连点：同一时间只允许一次初始化，第二次立刻被拒；超时 60 秒给中文提示；失败不自动重试。
// 9) 手动新增（#36）保存为生效：线索填名称/关联角色/下一步，伏笔填内容/关联线索。
// 10) 初始化之后走向卡的类型分配真的能分到主线与伏笔回收（这条是整个功能的存在理由）。
//
// 只 mock 两处：大模型入口 sendLLMRequest，与住在 mixology/engine 里的 resolveMixApiConfig 桩。
// 尚未实现的 API 一律用可选签名或带 catch 的动态 import 取，保证"还没实现"表现为断言失败，
// 而不是模块解析错误（TS2307）或类型错误。

type RawThread = {
  名称?: string;
  关联角色?: string[];
  线索状态?: string;
  下一步可能?: string;
};
type RawForeshadow = { 内容?: string; 关联线索名称?: string; 揭示条件?: string };

type ThreadLike = {
  id: string;
  kind: string;
  名称: string;
  线索状态: string;
  关联角色: string[];
  上次推进轮次: number;
  下一步可能: string;
  最近变化: Array<{ 变化: string; 轮次?: number; 计划?: boolean }>;
  状态: string;
  来源消息ID?: string;
  来源轮次?: number;
  证据?: string;
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
  audience?: string[];
  createdAt: number;
  updatedAt: number;
};

/** 初始化结果：调用次数与提示都要能被断言，失败路径也必须返回结构化结果而不是抛错 */
type LedgerResultLike = {
  线索: ThreadLike[];
  伏笔: ForeshadowLike[];
  跳过: { 线索: number; 伏笔: number };
  /** 本次真正发出的模型请求数：无大纲与被连点拒掉时必须是 0 */
  调用次数: number;
  提示?: string;
  失败?: boolean;
};
type ManualResultLike = { ok: boolean; 卡?: ThreadLike | ForeshadowLike; 提示?: string };

type LedgerApi = {
  THREAD_NAME_MAX?: number;
  THREAD_NEXT_MAX?: number;
  FORESHADOW_CONTENT_MAX?: number;
  LEDGER_TASK_MAX_CHARS?: number;
  LEDGER_TIMEOUT_MS?: number;
  LEDGER_MEMORY_TITLES?: number;
  buildLedgerInitTask?: (input: Record<string, unknown>) => string;
  parseLedgerInit?: (raw: unknown) => { 线索: RawThread[]; 伏笔: RawForeshadow[] };
  initThreadLedgerFromOutline?: (input: {
    sessionId: string;
    当前角色名?: string;
    玩家名?: string;
    当前轮次?: number;
  }) => Promise<LedgerResultLike>;
  createManualThread?: (input: {
    sessionId: string;
    名称: string;
    关联角色?: string[];
    下一步可能?: string;
  }) => Promise<ManualResultLike>;
  createManualForeshadow?: (input: {
    sessionId: string;
    内容: string;
    关联线索名称?: string;
  }) => Promise<ManualResultLike>;
};

const LEDGER_PATH = "@/lib/narrative-writer/ledger-init";

async function ledgerApi(): Promise<LedgerApi> {
  const mod = await import(LEDGER_PATH).catch(() => null);
  expect(mod, `${LEDGER_PATH} 尚未实现`).not.toBeNull();
  return mod as unknown as LedgerApi;
}
async function needFn(name: keyof LedgerApi): Promise<Function> {
  const api = await ledgerApi();
  const fn = api[name];
  expect(fn, `ledger-init.${name} 尚未实现`).toBeTypeOf("function");
  return fn as unknown as Function;
}

// ── LLM 桩：记录请求，返回测试指定的负载 ──
const llmMock = vi.hoisted(() => ({
  calls: 0,
  respond: null as null | (() => string | Promise<string>),
  requests: [] as Array<{
    characterName: string;
    system: string;
    content: string;
    messages: Array<{ role: string; content: string }>;
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
    llmMock.requests.push({
      characterName: meta?.characterName ?? "",
      system: String(messages.find((m) => m.role === "system")?.content ?? ""),
      content: String(messages[messages.length - 1]?.content ?? ""),
      messages: messages.map((m) => ({ role: String(m.role), content: String(m.content) })),
    });
    if (!llmMock.respond) return "[]";
    return llmMock.respond();
  },
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

// ── 夹具 ──
const createdSessionIds = new Set<string>();
const BASE_TIME = 1_700_000_000_000;

function sid(tag: string): string {
  const s = `li_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  createdSessionIds.add(s);
  return s;
}
function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const 角色 = "林北";
const 玩家 = "小满";
/** 大纲里出现过的人物名：关联角色只认这些（外加卡里已有的名字） */
const 大纲人物 = ["林北", "周聿", "老陈"];

/** 一份像样的 L3 大纲：三条真大线头 + 一堆环境细节，人名都用原名 */
const 大纲 = [
  "### 全局主线大纲：灯塔与旧城",
  "",
  "#### 一、故事核心脉络",
  "林北接手灯塔维修单三个月，小满一直在旧城替他遮掩身份。",
  "",
  "#### 二、未解决的悬念",
  "老桥下的硬币——谁反复把硬币投进桥洞，至今没人看见过那个人——悬着是因为桥洞装了指纹锁。",
  "维修单上的第二个签名——单据上有两处签名，第二个不是林北写的——老陈咬定是他，但笔迹对不上。",
  "周聿的抽屉钥匙——多出来的一把钥匙不知道开哪扇门——林北还没问过周聿。",
  "",
  "#### 三、关键转折",
  "第41轮海水倒灌进码头，第60轮旧城断电一夜。",
].join("\n");

const L2 = [
  { turnRange: [1, 40] as [number, number], summary: "灯塔维修单被签收，林北开始夜里巡塔。", createdAt: BASE_TIME },
  { turnRange: [41, 80] as [number, number], summary: "海水倒灌，码头封了，老陈把桥洞上了锁。", createdAt: BASE_TIME },
  { turnRange: [81, 120] as [number, number], summary: "周聿搬进旧城，抽屉里多出一把钥匙。", createdAt: BASE_TIME },
  { turnRange: [121, 127] as [number, number], summary: "断电一夜，维修单上出现第二个签名。", createdAt: BASE_TIME },
];

function mkMemory(内容: string, opts: { 状态?: string; 主类型?: string } = {}): MemoryCard {
  return {
    id: `li_m_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: opts.主类型 ?? "经历节点",
    内容,
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
function mkThread(名称: string, opts: Partial<ThreadLike> = {}): ThreadLike {
  return {
    id: `li_t_${rand()}`,
    kind: "thread",
    名称,
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

async function seedHierarchy(s: string, L3_全局大纲: string): Promise<void> {
  await storageModule.saveContextHierarchy(s as never, {
    L2_章节摘要: L2,
    L3_全局大纲,
    lastCompressedAt: BASE_TIME,
    lastCompressedTurn: 127,
  } as never);
}

/** 初始化会读库里的生效卡当素材，测试里按需塞几张 */
async function seedMemories(s: string, cards: MemoryCard[]): Promise<void> {
  for (const c of cards) await storageModule.saveMemoryCard(s as never, c as never);
}
async function seedThreads(s: string, cards: ThreadLike[]): Promise<void> {
  for (const c of cards) await storageModule.saveThreadCard(s as never, c as never);
}
async function readThreads(s: string): Promise<ThreadLike[]> {
  return (await storageModule.listThreadCards(s as never)) as unknown as ThreadLike[];
}
async function readForeshadows(s: string): Promise<ForeshadowLike[]> {
  return (await storageModule.listForeshadowCards(s as never)) as unknown as ForeshadowLike[];
}

/** 模型该返回的样子：三条线索（含 升温/爆发 各一）+ 两条伏笔 */
function 正常负载(overrides: { 线索?: RawThread[]; 伏笔?: RawForeshadow[] } = {}): string {
  return JSON.stringify({
    线索: overrides.线索 ?? [
      { 名称: "老桥下的硬币", 关联角色: [角色, 玩家], 线索状态: "升温", 下一步可能: "蹲一次桥洞看是谁在投" },
      { 名称: "维修单上的第二个签名", 关联角色: ["老陈"], 线索状态: "爆发", 下一步可能: "拿单据去比对笔迹" },
      { 名称: "周聿的抽屉钥匙", 关联角色: ["周聿"], 线索状态: "潜伏", 下一步可能: "问周聿这把钥匙开哪扇门" },
    ],
    伏笔: overrides.伏笔 ?? [
      { 内容: "桥洞的指纹锁只录了一个人的手指", 关联线索名称: "老桥下的硬币", 揭示条件: "锁被第二次打开" },
      { 内容: "抽屉里那把多余的钥匙", 关联线索名称: "周聿的抽屉钥匙", 揭示条件: "找到对应的锁" },
    ],
  });
}

async function runInit(s: string, extra: Record<string, unknown> = {}): Promise<LedgerResultLike> {
  const fn = await needFn("initThreadLedgerFromOutline");
  return fn({
    sessionId: s,
    当前角色名: 角色,
    玩家名: 玩家,
    当前轮次: 128,
    ...extra,
  }) as Promise<LedgerResultLike>;
}

beforeEach(() => {
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests.length = 0;
});

afterEach(() => {
  for (const s of createdSessionIds) storageModule.purgeNarrativeSessionData(s);
  createdSessionIds.clear();
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.requests.length = 0;
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════
// 一、入库口径：待核 + 不写来源 + 留初始化标注
// ════════════════════════════════════════════════════════════
describe("台账冷启动 · 初始化入库", () => {
  it("1. 模型给的线索与伏笔全部以待核入库、audience 为 all、不写来源", async () => {
    const s = sid("init-basic");
    await seedHierarchy(s, 大纲);
    await seedMemories(s, [mkMemory("林北接手了灯塔的维修单")]);
    llmMock.respond = () => 正常负载();

    const 结果 = await runInit(s);
    expect(结果.调用次数, "初始化台账该只调一次模型").toBe(1);
    expect(llmMock.calls, "真实发出的模型请求数不是 1").toBe(1);
    expect(结果.线索).toHaveLength(3);
    expect(结果.伏笔).toHaveLength(2);

    const 线 = await readThreads(s);
    expect(线).toHaveLength(3);
    for (const t of 线) {
      expect(t.状态, `线索"${t.名称}"没以待核入库`).toBe("待核");
      expect(t.audience, "初始化台账的线索该是导演视角共享").toEqual(["all"]);
      expect(t.来源消息ID, "初始化卡不该有来源消息 id（来源未知才不会被回溯误伤）").toBeUndefined();
      expect(t.来源轮次).toBeUndefined();
      expect(t.最近变化[0]?.变化, "没留下「由剧情大纲初始化」的标注").toContain("由剧情大纲初始化");
    }
    const 伏 = await readForeshadows(s);
    expect(伏).toHaveLength(2);
    for (const f of 伏) {
      expect(f.状态).toBe("待核");
      expect(f.伏笔状态).toBe("未收");
      expect(f.来源消息ID).toBeUndefined();
    }
  });

  it("2. 线索状态由模型给：潜伏｜升温｜爆发 照收，收束与词表外的值退回潜伏", async () => {
    const s = sid("init-status");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () =>
      正常负载({
        线索: [
          { 名称: "升温的线", 关联角色: [角色], 线索状态: "升温", 下一步可能: "查" },
          { 名称: "爆发的线", 关联角色: [角色], 线索状态: "爆发", 下一步可能: "查" },
          { 名称: "收束的线", 关联角色: [角色], 线索状态: "收束", 下一步可能: "查" },
          { 名称: "瞎写的线", 关联角色: [角色], 线索状态: "白热化", 下一步可能: "查" },
        ],
        伏笔: [],
      });

    await runInit(s);
    const 线 = await readThreads(s);
    const 状态 = (名称: string) => 线.find((t) => t.名称 === 名称)?.线索状态;
    expect(状态("升温的线")).toBe("升温");
    expect(状态("爆发的线")).toBe("爆发");
    expect(状态("收束的线"), "初始化不该直接交出一条已经收束的线").toBe("潜伏");
    expect(状态("瞎写的线"), "词表外的状态该兜底潜伏").toBe("潜伏");
  });

  it("3. 已有同名不覆盖、不改状态，只计跳过", async () => {
    const s = sid("init-dedup");
    await seedHierarchy(s, 大纲);
    const 已有 = mkThread("老桥下的硬币", {
      线索状态: "爆发",
      状态: "生效",
      关联角色: [角色],
      最近变化: [{ 变化: "亲眼看见有人投币", 轮次: 90 }],
    });
    await seedThreads(s, [已有]);
    llmMock.respond = () =>
      正常负载({
        线索: [
          { 名称: " 老桥下的硬币。", 关联角色: [角色], 线索状态: "潜伏", 下一步可能: "蹲一次桥洞" },
          { 名称: "新的一条线", 关联角色: [角色], 线索状态: "升温", 下一步可能: "去当铺问" },
        ],
        伏笔: [],
      });

    const 结果 = await runInit(s);
    expect(结果.跳过.线索, "同名线索没被计进跳过数").toBe(1);
    const 线 = await readThreads(s);
    expect(线, "台账里出现了两条同名线索").toHaveLength(2);
    const 原卡 = 线.find((t) => t.id === 已有.id)!;
    expect(原卡, "同名覆盖把原卡弄丢了").toBeDefined();
    expect(原卡.状态, "已有生效卡不该被初始化改成待核").toBe("生效");
    expect(原卡.线索状态, "已有卡的剧情态不该被初始化改动").toBe("爆发");
    expect(原卡.最近变化).toHaveLength(1);
  });

  it("4. 一次模型调用里的同名条目也只建一张（批内去重）", async () => {
    const s = sid("init-intra-batch");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () =>
      正常负载({
        线索: [
          { 名称: "桥下的硬币", 关联角色: [角色], 线索状态: "升温", 下一步可能: "蹲守" },
          { 名称: "桥下的硬币", 关联角色: [角色], 线索状态: "爆发", 下一步可能: "换个说法" },
        ],
        伏笔: [
          { 内容: "多余的钥匙", 关联线索名称: "桥下的硬币" },
          { 内容: "多余的钥匙", 关联线索名称: "桥下的硬币" },
        ],
      });

    const 结果 = await runInit(s);
    expect(await readThreads(s)).toHaveLength(1);
    expect(await readForeshadows(s)).toHaveLength(1);
    expect(结果.跳过).toEqual({ 线索: 1, 伏笔: 1 });
  });
});

// ════════════════════════════════════════════════════════════
// 二、字段裁剪与人物名单（代码说了算，不信模型）
// ════════════════════════════════════════════════════════════
describe("台账冷启动 · 字段截断与人物名单", () => {
  it("5. 超长字段由代码截断，空名称丢弃", async () => {
    const s = sid("init-truncate");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () =>
      正常负载({
        线索: [
          {
            名称: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十",
            关联角色: [角色],
            线索状态: "升温",
            下一步可能: "把这句话一直写下去一直到超过三十个字为止，多出来的那些字全部都要被截掉才对",
          },
          { 名称: "   ", 关联角色: [角色], 线索状态: "潜伏", 下一步可能: "不该入库" },
        ],
        伏笔: [
          { 内容: "伏笔内容也应该有个上限，超过四十字的那部分同样要被截掉，留下的部分要能读懂才行呢", 关联线索名称: "" },
        ],
      });

    await runInit(s);
    const 线 = await readThreads(s);
    expect(线, "空名称的线索没被丢弃").toHaveLength(1);
    expect(线[0].名称.length, `线索名截到 ${线[0].名称.length} 字，上限不是 20`).toBeLessThanOrEqual(20);
    expect(线[0].下一步可能.length).toBeLessThanOrEqual(30);
    const 伏 = await readForeshadows(s);
    expect(伏[0].内容.length).toBeLessThanOrEqual(40);
    expect(伏[0].关联线索名称, "空的关联线索不该被写成空字符串占位").toBeFalsy();
  });

  it("6. 关联角色只认原名：名单外且大纲里没出现过的名字丢弃，丢光为空数组", async () => {
    const s = sid("init-roles");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () =>
      正常负载({
        线索: [
          { 名称: "桥洞的指纹锁", 关联角色: [角色, "神秘人甲", "周聿"], 线索状态: "升温", 下一步可能: "查" },
          { 名称: "谁也没见过的访客", 关联角色: ["神秘人乙"], 线索状态: "潜伏", 下一步可能: "查" },
        ],
        伏笔: [],
      });

    await runInit(s);
    const 线 = await readThreads(s);
    const 甲 = 线.find((t) => t.名称 === "桥洞的指纹锁")!;
    expect(甲.关联角色, "自造人物名没被丢掉").toEqual([角色, "周聿"]);
    const 乙 = 线.find((t) => t.名称 === "谁也没见过的访客")!;
    expect(乙.关联角色, "全是不认识的人时该留空数组，而不是留着假名字").toEqual([]);
  });

  it("7. 提示词只要求四件事，且短；素材里没有待核卡标题", async () => {
    const s = sid("init-prompt");
    await seedHierarchy(s, 大纲);
    await seedMemories(s, [
      mkMemory("生效卡应当进素材"),
      mkMemory("待核卡不该进素材", { 状态: "待核" }),
    ]);
    llmMock.respond = () => 正常负载();

    await runInit(s);
    expect(llmMock.calls).toBe(1);
    const 请求 = llmMock.requests[0];
    const 系统 = 请求.system;
    expect(系统.length, `初始化提示词写太长了（${系统.length} 字）`).toBeLessThanOrEqual(600);
    expect(系统, "没说要只挑真正悬着的事").toMatch(/悬|没收回/);
    expect(系统, "没禁止虚构").toMatch(/不虚构|不得虚构|只写.*出现/);
    expect(系统, "没禁止写已经解决的事").toMatch(/解决|收过/);
    expect(系统, "没要求关联角色使用原名").toMatch(/原名/);
    expect(系统, "不该让模型自己写审核态").not.toMatch(/待核|生效/);

    // 素材：大纲全文 + 最近 2 条 L2 + 生效卡标题；待核卡一层都不许传下去
    const 任务 = 请求.content;
    expect(任务).toContain("老桥下的硬币——");
    expect(任务, "已生效记忆卡标题没进素材").toContain("生效卡应当进素材");
    expect(任务, "待核卡标题混进素材了，未确认内容会被层层传下去").not.toContain("待核卡不该进素材");
    const 条数 = L2.slice(-2).map((l) => l.summary);
    expect(任务).toContain(条数[0]);
    expect(任务, "更早的 L2 摘要不该整包塞进素材").not.toContain(L2[0].summary);
  });

  it("8. 任务文本超上限时先砍卡标题，大纲一个字不砍", async () => {
    const build = (await needFn("buildLedgerInitTask")) as NonNullable<LedgerApi["buildLedgerInitTask"]>;
    const api = await ledgerApi();
    const 上限 = api.LEDGER_TASK_MAX_CHARS ?? 3600;
    const 标题 = Array.from({ length: 40 }, (_, i) => `第${i}张记忆卡的标题内容会很长很长很长`);
    const 长大纲 = 大纲.repeat(4);

    const 文本 = build({
      大纲: 长大纲,
      L2摘要: L2.slice(-2).map((l) => l.summary),
      记忆卡标题: 标题,
      已有线索名称: [],
      已有伏笔名称: [],
      当前角色名: 角色,
      玩家名: 玩家,
      人物名单: 大纲人物,
      当前轮次: 128,
    });
    expect(文本.length, `任务文本 ${文本.length} 字，超过上限 ${上限}`).toBeLessThanOrEqual(上限);
    expect(文本, "砍素材先砍了大纲，大纲是唯一不可再生的输入").toContain("周聿的抽屉钥匙");
    expect(文本, "卡标题一条都没砍").not.toContain(标题[39]);
  });
});

// ════════════════════════════════════════════════════════════
// 三、失败路径：无大纲、解析废、连点、超时
// ════════════════════════════════════════════════════════════
describe("台账冷启动 · 失败与防连点", () => {
  it("9. 没有大纲：不调用模型，只提示先整理记忆", async () => {
    const s = sid("init-no-outline");
    llmMock.respond = () => 正常负载();

    // 从没整理过（hierarchy 不存在）
    const 结果 = await runInit(s);
    expect(llmMock.calls, "无大纲时一次模型都不该调").toBe(0);
    expect(结果.调用次数).toBe(0);
    expect(结果.提示, "没提示先整理记忆").toContain("请先整理记忆");
    expect(await readThreads(s)).toHaveLength(0);

    // 整理过但大纲是空串，同样算没有
    await seedHierarchy(s, "   ");
    const 结果2 = await runInit(s);
    expect(llmMock.calls).toBe(0);
    expect(结果2.提示).toContain("请先整理记忆");
  });

  it("10. 模型返回非 JSON / 围栏包裹 / 空响应：不抛错、不入库、给中文提示", async () => {
    const 坏负载 = [
      "我看了看这段剧情，觉得线索大概有三条，第一条是老桥下的硬币……",
      "```json\n" + 正常负载() + "\n```",
      "",
    ];
    for (const [i, 负载] of 坏负载.entries()) {
      const s = sid(`init-bad-${i}`);
      await seedHierarchy(s, 大纲);
      llmMock.respond = () => 负载;
      await expect(runInit(s), `负载 ${i} 让初始化抛错了`).resolves.toBeDefined();
      const 结果 = await runInit(s);
      if (i === 1) {
        // 围栏包住的合法 JSON 该照样收下，不该因为多了三行反引号就作废
        expect(结果.线索.length, "围栏里的 JSON 没被解析").toBeGreaterThan(0);
      } else {
        expect(await readThreads(s), `负载 ${i} 竟然入了库`).toHaveLength(0);
        expect(结果.失败, `负载 ${i} 没标记失败`).toBe(true);
        expect(结果.提示, `负载 ${i} 的提示不是中文`).toMatch(/[\u4e00-\u9fa5]/);
      }
    }
  });

  it("11. 防连点：第二次立刻被拒，且不多调模型", async () => {
    const s = sid("init-mutex");
    await seedHierarchy(s, 大纲);
    let 放开: () => void = () => {};
    llmMock.respond = () =>
      new Promise<string>((resolve) => {
        放开 = () => resolve(正常负载());
      });

    const 第一次 = runInit(s);
    // 先挂一个 catch，避免"还没 await 的那次"在测试中途变成未处理的 rejection；
    // 真正的断言在下面 await 处，失败照样红。
    第一次.catch(() => {});
    const 第二次 = await runInit(s);
    expect(第二次.调用次数, "被连点拒掉的那次不该算调用").toBe(0);
    expect(第二次.提示, "第二次没给出「正在进行」之类的提示").toMatch(/正在/);
    expect(llmMock.calls, "连点导致多调了一次模型").toBe(1);

    放开();
    const 第一次结果 = await 第一次;
    expect(第一次结果.线索.length).toBeGreaterThan(0);
    expect(llmMock.calls).toBe(1);

    // 结束后可再次初始化（互斥标志必须被释放，否则按钮永久死掉）
    llmMock.respond = () => 正常负载({ 线索: [], 伏笔: [] });
    const 第三次 = await runInit(s);
    expect(第三次.调用次数, "上一次结束后按钮该能再按").toBe(1);
  });

  it("12. 超时 60 秒：给中文提示、不入库、不自动重试", async () => {
    const s = sid("init-timeout");
    await seedHierarchy(s, 大纲);
    const api = await ledgerApi();
    const 超时 = api.LEDGER_TIMEOUT_MS ?? 60_000;
    llmMock.respond = () => new Promise<string>(() => {});

    vi.useFakeTimers();
    const 进行中 = runInit(s);
    进行中.catch(() => {});
    await vi.advanceTimersByTimeAsync(超时 + 1000);
    const 结果 = await 进行中;
    vi.useRealTimers();

    expect(结果.失败, "超时没被标记成失败").toBe(true);
    expect(结果.提示, "超时提示里没有「超时」二字").toMatch(/超时/);
    expect(await readThreads(s)).toHaveLength(0);
    expect(llmMock.calls, "超时后自动重试了").toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
// 四、手动新增（#36）与初始化的实际效果
// ════════════════════════════════════════════════════════════
describe("台账冷启动 · 手动新增与走向卡分配", () => {
  it("13. 手动新增线索/伏笔保存为生效，空名称与同名被拒", async () => {
    const s = sid("manual-add");
    const 建线 = (await needFn("createManualThread")) as NonNullable<LedgerApi["createManualThread"]>;
    const 建伏 = (await needFn("createManualForeshadow")) as NonNullable<LedgerApi["createManualForeshadow"]>;

    const 线 = await 建线({
      sessionId: s,
      名称: "灯塔顶上的第二盏灯",
      关联角色: [角色],
      下一步可能: "问物业为什么备了两盏",
    });
    expect(线.ok).toBe(true);
    const 库 = await readThreads(s);
    expect(库).toHaveLength(1);
    expect(库[0].状态, "手动新增该直接生效，她填的就是结论").toBe("生效");
    expect(库[0].来源消息ID).toBeUndefined();

    const 伏 = await 建伏({ sessionId: s, 内容: "备用的那串钥匙", 关联线索名称: "灯塔顶上的第二盏灯" });
    expect(伏.ok).toBe(true);
    expect((await readForeshadows(s))[0].状态).toBe("生效");

    const 空 = await 建线({ sessionId: s, 名称: "   ", 关联角色: [] });
    expect(空.ok, "空名称也该保存").toBe(false);
    expect(空.提示).toMatch(/[\u4e00-\u9fa5]/);
    expect(await readThreads(s)).toHaveLength(1);

    const 重 = await 建线({ sessionId: s, 名称: "灯塔顶上的第二盏灯", 关联角色: [] });
    expect(重.ok, "同名的手动新增不该被接受").toBe(false);
    expect(await readThreads(s)).toHaveLength(1);
  });

  it("14. 初始化之后，主线与伏笔回收真的能分到对象", async () => {
    const s = sid("init-then-plan");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () => 正常负载();
    await runInit(s);

    const 线 = await readThreads(s);
    const 伏 = await readForeshadows(s);
    expect(线.some((t) => t.线索状态 === "爆发" || t.线索状态 === "升温"), "夹具没交出升温/爆发线").toBe(true);

    const 分配 = assignBannerPlan({
      sessionId: s,
      threads: 线,
      foreshadows: 伏,
      memories: [],
      emotions: [],
      waterLevels: {},
      当前角色: 角色,
      当前轮次: 128,
      批次序号: 0,
      最近走向类型: [],
    } as never);
    const 主线 = 分配.find((c) => c.类型 === "主线")!;
    expect(主线, "第一批没有主线卡").toBeDefined();
    expect(主线.已替换, "有升温/爆发线了还被迫替补").toBe(false);
    expect(主线.目标?.名称, "主线没绑上台账里的线").toBeTruthy();
    expect(["老桥下的硬币", "维修单上的第二个签名"]).toContain(主线.目标?.名称);

    const 分配1 = assignBannerPlan({
      sessionId: s,
      threads: 线,
      foreshadows: 伏,
      memories: [],
      emotions: [],
      waterLevels: {},
      当前角色: 角色,
      当前轮次: 128,
      批次序号: 1,
      最近走向类型: [],
    } as never);
    const 回收 = 分配1.find((c) => c.类型 === "伏笔回收")!;
    expect(回收, "第二批没有伏笔回收卡").toBeDefined();
    expect(回收.目标?.名称, "伏笔回收没绑上伏笔").toBeTruthy();
  });

  it("15. 模型只给潜伏线时：主线仍走替补，绝不退绑潜伏线", async () => {
    const s = sid("init-all-latent");
    await seedHierarchy(s, 大纲);
    llmMock.respond = () =>
      正常负载({
        线索: [
          { 名称: "桥洞的指纹锁", 关联角色: [角色], 线索状态: "潜伏", 下一步可能: "查" },
          { 名称: "多余的钥匙", 关联角色: ["周聿"], 线索状态: "潜伏", 下一步可能: "问" },
        ],
        伏笔: [{ 内容: "锁上只录过一个手指", 关联线索名称: "桥洞的指纹锁" }],
      });
    await runInit(s);

    const 分配 = assignBannerPlan({
      sessionId: s,
      threads: await readThreads(s),
      foreshadows: await readForeshadows(s),
      memories: [],
      emotions: [],
      waterLevels: {},
      当前角色: 角色,
      当前轮次: 128,
      批次序号: 0,
      最近走向类型: [],
    } as never);
    const 主线格 = 分配[0];
    expect(主线格.计划类型).toBe("主线");
    expect(主线格.类型, "没有爆发/升温线却仍按主线出卡").not.toBe("主线");
    expect(主线格.已替换, "替补没留痕").toBe(true);
  });
});
