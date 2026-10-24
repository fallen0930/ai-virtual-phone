import { afterEach, describe, expect, it, vi } from "vitest";
import { kvKeysWithPrefix, kvRemove } from "@/lib/kv-db";
import * as storageModule from "@/lib/narrative-writer/storage";
import { saveMixSession } from "@/lib/mixology/storage";
import * as writerModule from "@/lib/narrative-writer/writer";
import type { MixSession, MixTurn } from "@/lib/mixology/types";
import type {
  EmotionCard,
  ForeshadowCard,
  MemoryCard,
  ThreadCard,
  WaterLevelState,
} from "@/lib/narrative-writer/types";

// 约束 4：真 import mixology/engine 的测试只有 narrative-generate-source.test.ts 一份。
// 本文件要用抽取入口（它 transitively 引 engine），所以照旧把引擎与大模型入口 mock 掉，
// 只统计"该不该调"，不调真模型。
const llmMock = vi.hoisted(() => ({
  calls: 0,
  /** 返回给抽取器的 JSON 文本；默认一张卡都不产，由用例按需改写 */
  respond: null as null | (() => string),
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

vi.mock("@/lib/chat-engine", () => ({
  sendLLMRequest: async () => {
    llmMock.calls += 1;
    return llmMock.respond ? llmMock.respond() : "[]";
  },
}));

// 番外 · 只读继承记忆（2026-10-24 她批准的口径）
//
// 她要的两件事：
//   1) 开番外不许再复制一份记忆——太吃存储，而且番外开多了会回头影响主线记忆；
//   2) 番外可以「继承记忆」，也可以「只有人设和世界书」从零开始。
//
// 落成的规则（本文件逐条钉住）：
//   A 番外（inherit）读卡 = 读**来源对局当前**的卡：记忆/情感/线索/伏笔/水位全部只读引用，零复制。
//   B 番外自己**一个 narrative 键都不产生**（这就是"省内存"的验收口径）。
//   C 番外（none）读不到任何记忆：只有人设与世界书（配方材料本来就是按 id 引用的）。
//   D 任何往卡与水位写的入口，对番外一律拒绝并说清原因；来源对局自己照写不误。
//   E 番外的执笔状态/上下文层级/整理历史照常可写——那是番外自己这一场的进度，不是记忆卡。
//   F 来源被删：读回落自己（空），不炸；写仍然被拒。
//   G 番外套番外：读到最上面那个正经节点（锚点）的记忆，不是空。
//   H 抽取入口在番外上直接返回，一次大模型都不调（省积分是她点名要的）。
//   I 「记忆整理」对番外**放开阶段一**（L2/L3 层级归这一场自己），
//     **阶段二的提炼一张卡都不产**（她批准的待办 #40：长篇番外要有大纲，但仍不进记忆卡）。
//
// 本文件不 import mixology/engine（约束 4：真 import 那份在 narrative-generate-source.test.ts），
// 番外对局用手写 saveMixSession 造，只测存储层的读重定向与写闸门。
// 「落盘后重读」「真机面板上的只读横幅」属未覆盖，见 MANUAL_CHECKLIST 番外段。

type SpinoffModule = {
  narrativeReadSessionId?: (sessionId: string) => string;
  isNarrativeReadOnlySession?: (sessionId: string) => boolean;
  assertNarrativeWritable?: (sessionId: string, caller: string) => void;
  spinoffSourceOf?: (
    sessionId: string
  ) => { id: string; name: string; memory: "inherit" | "none" } | null;
};

/**
 * 新模块还没实现：路径写成 `: string` 变量让 TS 不做模块解析（否则 TS2307 把红因
 * 变成类型错误），运行时解析失败被 catch 吞掉，由下面的断言报红。
 */
const SPINOFF_MODULE_PATH: string = "../lib/narrative-writer/spinoff";

async function spinoffModule(): Promise<SpinoffModule> {
  const mod = await import(SPINOFF_MODULE_PATH).catch(() => null);
  expect(mod, "@/lib/narrative-writer/spinoff 尚未实现").not.toBeNull();
  return mod as unknown as SpinoffModule;
}

function requireFn<K extends keyof SpinoffModule>(
  mod: SpinoffModule,
  name: K
): NonNullable<SpinoffModule[K]> {
  const fn = mod[name];
  expect(fn, `spinoff.${String(name)} 尚未实现`).toBeTypeOf("function");
  return fn as NonNullable<SpinoffModule[K]>;
}

const createdSessionIds = new Set<string>();
const BASE_TIME = 1_700_000_000_000;

function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function markOf(tag: string): string {
  return `【${tag}】`;
}

/** 造一场对局（只需要谱系字段，配方槽位留空就够存储层用） */
function seedSession(over: Partial<MixSession> & { id: string }): MixSession {
  const session = {
    recipe: {
      id: `recipe_${over.id}`,
      name: "番外测试配方",
      slots: {},
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    },
    charName: "番外测试角色",
    openingIndex: 0,
    turns: [],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...over,
  } as MixSession;
  createdSessionIds.add(session.id);
  saveMixSession(session);
  return session;
}

/**
 * 造一条真实存在的回复 id。
 * 抽取器进门先查「来源消息还在不在这场对局里」，不在就连模型都不调 ——
 * 不给它一条真回复，"番外不调模型"这条断言会因为别的原因通过，测不出闸门。
 */
function replyTag(): { turnId: string; turns: MixTurn[] } {
  const turnId = `turn_${rand()}`;
  return {
    turnId,
    turns: [{ id: turnId, role: "assistant", text: "她终于回到了灯塔。", createdAt: BASE_TIME }],
  };
}

function mkMemory(sid: string, tag: string, extra: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: `so_m_${sid}_${tag}_${rand()}`,
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: `${markOf(tag)}这条来自主线的记忆`,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    证据: "测试夹具",
    时间: "第1天",
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...extra,
  } as unknown as MemoryCard;
}

function mkEmotion(sid: string, tag: string): EmotionCard {
  return {
    id: `so_e_${sid}_${tag}_${rand()}`,
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "心动",
    强度: 0.6,
    对象: markOf(tag),
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    证据: markOf(tag),
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  } as unknown as EmotionCard;
}

function mkThread(sid: string, tag: string): ThreadCard {
  return {
    id: `so_t_${sid}_${tag}_${rand()}`,
    kind: "thread",
    名称: `${markOf(tag)}未还的钥匙`,
    线索状态: "潜伏",
    关联角色: [],
    上次推进轮次: 1,
    下一步可能: "让她发现钥匙不见了",
    最近变化: [],
    状态: "生效",
    来源轮次: 1,
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  } as unknown as ThreadCard;
}

function mkForeshadow(sid: string, tag: string): ForeshadowCard {
  return {
    id: `so_f_${sid}_${tag}_${rand()}`,
    kind: "foreshadow",
    内容: `${markOf(tag)}灯塔下的第二把钥匙`,
    埋下轮次: 1,
    预期回收窗口: { 起: 2, 止: 6 },
    伏笔状态: "未收",
    状态: "生效",
    audience: ["all"],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  } as unknown as ForeshadowCard;
}

/** 来源对局的四类卡 + 一条被抬高过的关系水位（水位表按 作用域 存，L1 不是默认值，能区分读到的是谁的） */
async function seedSourceMemory(sid: string, tag: string): Promise<void> {
  await storageModule.saveMemoryCard(sid, mkMemory(sid, tag));
  await storageModule.saveEmotionCard(sid, mkEmotion(sid, tag));
  await storageModule.saveThreadCard(sid, mkThread(sid, tag));
  await storageModule.saveForeshadowCard(sid, mkForeshadow(sid, tag));
  await storageModule.saveWaterLevel(sid, {
    作用域: "戏内层",
    水位: "L1",
    status: "active",
    准入证据: [markOf(tag)],
    未解决冲突: [],
    冻结项: [],
    最后更新: new Date(BASE_TIME).toISOString(),
  } satisfies WaterLevelState);
}

afterEach(() => {
  for (const sid of createdSessionIds) {
    for (const key of kvKeysWithPrefix(`narrative:${sid}:`)) kvRemove(key);
  }
  kvRemove("mixology_sessions_v1");
  createdSessionIds.clear();
});

describe("A/B · inherit 番外读来源的卡，自己不产生任何键", () => {
  it("A1 记忆/情感/线索/伏笔/水位全部读到来源当前内容", async () => {
    const source = seedSession({ id: `sof_src_${rand()}` });
    const spin = seedSession({
      id: `sof_inh_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "主线");

    const memories = await storageModule.listMemoryCards(spin.id);
    const emotions = await storageModule.listEmotionCards(spin.id);
    const threads = await storageModule.listThreadCards(spin.id);
    const foreshadows = await storageModule.listForeshadowCards(spin.id);
    const water = await storageModule.getWaterLevels(spin.id);

    expect(memories.map((c) => c.内容)).toContain(markOf("主线") + "这条来自主线的记忆");
    expect(emotions).toHaveLength(1);
    expect(threads).toHaveLength(1);
    expect(foreshadows).toHaveLength(1);
    // 水位表按 作用域 存，来源把戏内层抬到 L1（默认是 L0）——读到 L1 才证明读的是来源那一份
    expect(water["戏内层"].水位).toBe("L1");
  });

  it("A2 活引用不是快照：来源新增一张卡，番外当场就读得到", async () => {
    const source = seedSession({ id: `sof_src2_${rand()}` });
    const spin = seedSession({
      id: `sof_inh2_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "第一批");
    expect(await storageModule.listMemoryCards(spin.id)).toHaveLength(1);

    await storageModule.saveMemoryCard(source.id, mkMemory(source.id, "第二批"));
    const 来源全部 = await storageModule.listMemoryCards(source.id);
    expect(await storageModule.listMemoryCards(spin.id)).toHaveLength(2);
    // 番外读到的就是来源那一份，不是拷贝出来的第二套键
    for (const card of 来源全部) {
      expect(await storageModule.getMemoryCard(spin.id, card.id)).not.toBeNull();
    }
    expect(kvKeysWithPrefix(`narrative:${spin.id}:memory:`)).toEqual([]);
  });

  it("B1 番外自己的命名空间一个键都不产生", async () => {
    const source = seedSession({ id: `sof_src3_${rand()}` });
    const spin = seedSession({
      id: `sof_inh3_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "主线");
    // 读一遍全部入口，读不该写键
    await storageModule.listMemoryCards(spin.id);
    await storageModule.listEmotionCards(spin.id);
    await storageModule.listThreadCards(spin.id);
    await storageModule.listForeshadowCards(spin.id);
    await storageModule.getWaterLevels(spin.id);
    expect(kvKeysWithPrefix(`narrative:${spin.id}:`)).toEqual([]);
  });

  it("G1 番外套番外：读到最上面的正经锚点，不是空", async () => {
    const source = seedSession({ id: `sof_src4_${rand()}` });
    const spinA = seedSession({
      id: `sof_chain_a_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    const spinB = seedSession({
      id: `sof_chain_b_${rand()}`,
      spinoff: { sourceId: spinA.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "锚点");

    expect(await storageModule.listMemoryCards(spinB.id)).toHaveLength(1);
    const mod = await spinoffModule();
    expect(requireFn(mod, "narrativeReadSessionId")(spinB.id)).toBe(source.id);
  });

  it("G2 谱系数据成环时收手，返回自己的 id 而不是死循环", async () => {
    const x = seedSession({ id: `sof_loop_x_${rand()}`, spinoff: { sourceId: "sof_loop_y_placeholder", memory: "inherit" } });
    const y = seedSession({ id: `sof_loop_y_${rand()}`, spinoff: { sourceId: x.id, memory: "inherit" } });
    saveMixSession({ ...x, spinoff: { sourceId: y.id, memory: "inherit" } });

    const mod = await spinoffModule();
    expect(requireFn(mod, "narrativeReadSessionId")(x.id)).toBe(x.id);
  });
});

describe("C · none 番外只有人设和世界书", () => {
  it("C1 记忆/情感/线索/伏笔/水位全部读空", async () => {
    const source = seedSession({ id: `sof_src5_${rand()}` });
    const spin = seedSession({
      id: `sof_none_${rand()}`,
      spinoff: { sourceId: source.id, memory: "none" },
    });
    await seedSourceMemory(source.id, "主线");

    expect(await storageModule.listMemoryCards(spin.id)).toEqual([]);
    expect(await storageModule.listEmotionCards(spin.id)).toEqual([]);
    expect(await storageModule.listThreadCards(spin.id)).toEqual([]);
    expect(await storageModule.listForeshadowCards(spin.id)).toEqual([]);
    // 水位读不到来源那份被抬高的 L1，只有本场的默认值
    expect((await storageModule.getWaterLevels(spin.id))["戏内层"].水位).toBe("L0");
    expect(kvKeysWithPrefix(`narrative:${spin.id}:`)).toEqual([]);
  });
});

describe("D · 番外不写记忆卡", () => {
  it("D1 六种写入口在番外上全部拒绝，并说清是番外", async () => {
    const source = seedSession({ id: `sof_src6_${rand()}` });
    const spin = seedSession({
      id: `sof_ro_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    const none = seedSession({
      id: `sof_ro_none_${rand()}`,
      spinoff: { sourceId: source.id, memory: "none" },
    });
    await seedSourceMemory(source.id, "主线");
    const [oneMemory] = await storageModule.listMemoryCards(source.id);
    const 一条水位: WaterLevelState = {
      作用域: "戏内层",
      水位: "L3",
      status: "active",
      准入证据: [],
      未解决冲突: [],
      冻结项: [],
      最后更新: new Date(BASE_TIME).toISOString(),
    };

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["saveMemoryCard", () => storageModule.saveMemoryCard(spin.id, oneMemory)],
      ["saveEmotionCard", () => storageModule.saveEmotionCard(spin.id, mkEmotion(spin.id, "想写"))],
      ["saveThreadCard", () => storageModule.saveThreadCard(spin.id, mkThread(spin.id, "想写"))],
      ["saveForeshadowCard", () => storageModule.saveForeshadowCard(spin.id, mkForeshadow(spin.id, "想写"))],
      ["saveWaterLevel", () => storageModule.saveWaterLevel(spin.id, 一条水位)],
      ["updateMemoryCardStatus", () => storageModule.updateMemoryCardStatus(spin.id, oneMemory.id, "归档")],
      ["archiveMemoryCard", () => storageModule.archiveMemoryCard(spin.id, oneMemory.id)],
      ["deleteMemoryCard", () => storageModule.deleteMemoryCard(spin.id, oneMemory.id)],
    ];
    for (const [name, run] of attempts) {
      await expect(run(), `${name} 应该拒绝番外`).rejects.toThrow(/番外/);
    }
    // none 模式同样不许写
    await expect(storageModule.saveMemoryCard(none.id, oneMemory)).rejects.toThrow(/番外/);

    // 一张都没落进番外命名空间
    expect(kvKeysWithPrefix(`narrative:${spin.id}:`)).toEqual([]);
    expect(kvKeysWithPrefix(`narrative:${none.id}:`)).toEqual([]);
    // 来源的卡一张没少、状态没变
    expect(await storageModule.listMemoryCards(source.id)).toHaveLength(1);
    expect((await storageModule.listMemoryCards(source.id))[0].状态).toBe("生效");
  });

  it("D2 批量确认与归档类入口同样拒绝番外", async () => {
    const source = seedSession({ id: `sof_src7_${rand()}` });
    const spin = seedSession({
      id: `sof_ro2_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await storageModule.saveMemoryCard(source.id, mkMemory(source.id, "待核", { 状态: "待核" } as never));
    const pending = (await storageModule.listMemoryCards(source.id))[0];

    await expect(storageModule.confirmAllPendingCards(spin.id)).rejects.toThrow(/番外/);
    await expect(storageModule.archiveMemoryCard(spin.id, pending.id)).rejects.toThrow(/番外/);
    await expect(storageModule.updateMemoryCard(spin.id, pending.id, { 内容: "改掉主线记忆" } as never)).rejects.toThrow(/番外/);
    await expect(storageModule.batchArchiveMemoryCards(spin.id, [pending.id])).rejects.toThrow(/番外/);
    await expect(storageModule.batchDeleteMemoryCards(spin.id, [pending.id])).rejects.toThrow(/番外/);
    await expect(storageModule.deleteMemoryCard(spin.id, pending.id)).rejects.toThrow(/番外/);
    // 来源那张待核卡还是待核，没被番外的点击偷偷确认
    expect((await storageModule.listMemoryCards(source.id))[0].状态).toBe("待核");
  });

  it("D3 来源对局自己照写不误（闸门只拦番外，不拦主线）", async () => {
    const source = seedSession({ id: `sof_src8_${rand()}` });
    seedSession({
      id: `sof_ro3_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await storageModule.saveMemoryCard(source.id, mkMemory(source.id, "新记忆"));
    expect(await storageModule.listMemoryCards(source.id)).toHaveLength(1);
  });

  it("D4 抽取入口在番外上一次大模型都不调、不落键", async () => {
    const { hotExtractFromNarrativeBody } = await import("@/lib/narrative-writer/extractor");
    const source = seedSession({ id: `sof_src9_${rand()}` });
    const 正文 = replyTag();
    const spin = seedSession({
      id: `sof_extract_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
      turns: 正文.turns,
    });
    await seedSourceMemory(source.id, "主线");

    llmMock.calls = 0;
    await hotExtractFromNarrativeBody(
      spin.id,
      "她终于回到了灯塔，把钥匙还给了守塔人。",
      ["上一轮的正文"],
      { 消息ID: 正文.turnId, 轮次: 1 }
    );
    // 省积分是她点名要的：番外不许触发抽取
    expect(llmMock.calls).toBe(0);
    expect(kvKeysWithPrefix(`narrative:${spin.id}:`)).toEqual([]);
    // 来源的卡没被这次"番外抽取"改动
    expect(await storageModule.listMemoryCards(source.id)).toHaveLength(1);
  });

  it("D5 对照组：普通对局照常抽取（闸门不是把抽取整体关掉）", async () => {
    const { hotExtractFromNarrativeBody } = await import("@/lib/narrative-writer/extractor");
    const 正文 = replyTag();
    const plain = seedSession({ id: `sof_ctl_${rand()}`, turns: 正文.turns });

    llmMock.calls = 0;
    await hotExtractFromNarrativeBody(
      plain.id,
      "她把钥匙放在守塔人的掌心。",
      ["上一轮的正文"],
      { 消息ID: 正文.turnId, 轮次: 1 }
    );
    expect(llmMock.calls).toBeGreaterThan(0);
  });
});

describe("E · 番外自己的进度照写不误", () => {
  it("E1 执笔状态 / 上下文层级 / 整理历史不属于记忆卡，番外正常读写", async () => {
    const source = seedSession({ id: `sof_src10_${rand()}` });
    const spin = seedSession({
      id: `sof_own_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    const mod = await spinoffModule();
    expect(requireFn(mod, "isNarrativeReadOnlySession")(spin.id)).toBe(true);

    const { createDefaultWriterState } = await import("@/lib/narrative-writer/types");
    const state = createDefaultWriterState(spin.id);
    state.currentTurn = 3;
    await storageModule.saveWriterState(spin.id, state);
    expect((await storageModule.getWriterState(spin.id))?.currentTurn).toBe(3);

    await storageModule.saveContextHierarchy(spin.id, {
      L2_章节摘要: [{ turnRange: [1, 2], summary: "番外自己前两轮的摘要", createdAt: BASE_TIME }],
      L3_全局大纲: "番外自己这一场的大纲",
      lastCompressedAt: BASE_TIME,
      lastCompressedTurn: 2,
    });
    const hierarchy = await storageModule.getContextHierarchy(spin.id);
    expect(hierarchy?.L3_全局大纲).toBe("番外自己这一场的大纲");

    // 整理历史同样属于番外自己这一场
    await storageModule.saveNarrativeHistoryEntry(spin.id, {
      id: `so_h_${rand()}`,
      timestamp: BASE_TIME,
      mode: "direct",
      playerTendency: "番外自己的走向",
      output: { banner: "她把灯重新点亮", body: "灯塔亮了。" },
      sessionId: spin.id,
      metadata: { beats: 1, isTurningPoint: false, directionAdjusted: false },
    });
    expect(await storageModule.listNarrativeHistory(spin.id)).toHaveLength(1);
  });

  it("E2 普通对局（非番外）读写完全不受影响", async () => {
    const plain = seedSession({ id: `sof_plain_${rand()}` });
    const mod = await spinoffModule();
    expect(requireFn(mod, "narrativeReadSessionId")(plain.id)).toBe(plain.id);
    expect(requireFn(mod, "isNarrativeReadOnlySession")(plain.id)).toBe(false);
    await storageModule.saveMemoryCard(plain.id, mkMemory(plain.id, "本场"));
    expect(await storageModule.listMemoryCards(plain.id)).toHaveLength(1);
  });
});

describe("F · 来源被删之后", () => {
  it("F1 读回落自己（空）不炸，写仍然被拒", async () => {
    const source = seedSession({ id: `sof_src11_${rand()}` });
    const spin = seedSession({
      id: `sof_gone_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "主线");
    const mod = await spinoffModule();
    expect(requireFn(mod, "spinoffSourceOf")(spin.id)).not.toBeNull();

    kvRemove("mixology_sessions_v1");
    seedSession(spin);   // 只留番外，来源没了
    expect(await storageModule.listMemoryCards(spin.id)).toEqual([]);
    await expect(
      storageModule.saveMemoryCard(spin.id, mkMemory(spin.id, "想写"))
    ).rejects.toThrow(/番外/);
  });

  it("F2 来源还在时能报出「继承自哪一局」，供面板横幅用", async () => {
    const source = seedSession({ id: `sof_src12_${rand()}`, branchName: "主线·灯塔" });
    const spin = seedSession({
      id: `sof_named_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    const mod = await spinoffModule();
    const info = requireFn(mod, "spinoffSourceOf")(spin.id);
    expect(info?.id).toBe(source.id);
    expect(info?.name).toBe("主线·灯塔");
    expect(info?.memory).toBe("inherit");
  });
});

// I · 记忆整理（她批准的待办 #40）
//
// 整理分两段：阶段一 Map-Reduce 出 L2 章节摘要 + L3 全局大纲，写进**这一场自己的**
// 上下文层级；阶段二拿大纲与摘要去提炼记忆卡。番外的口径是"要大纲、不要卡"——
// 长篇番外没有大纲就没有走向卡素材，而卡一旦产出来就会回头影响记忆，正是要避开的。
// 闸门放在 writer 这一层（不只放面板按钮）：面板只是入口之一，别的调用方也得被挡住。
describe("I · 番外跑整理：大纲归自己，记忆卡一张不产", () => {
  it("I1 提炼阶段在番外返回 0、一次模型都不调、不碰来源的卡", async () => {
    const source = seedSession({ id: `sof_src13_${rand()}` });
    const spin = seedSession({
      id: `sof_compress_${rand()}`,
      spinoff: { sourceId: source.id, memory: "inherit" },
    });
    await seedSourceMemory(source.id, "整理前");
    const 来源卡数 = (await storageModule.listMemoryCards(source.id)).length;
    const 起始调用数 = llmMock.calls;

    const saved = await writerModule.extractMemoriesFromCompression(
      spin.id,
      "番外测试角色",
      "全局大纲：她终于回到了灯塔，但没有承认那是为什么。",
      [{ turnRange: [1, 4], summary: "前四轮的章节摘要" }],
      4,
      () => {}
    );

    expect(saved).toBe(0);
    expect(llmMock.calls - 起始调用数).toBe(0);
    // 番外的命名空间仍然只有进度类键（writer_state/hierarchy/history），没有 memory
    expect(
      kvKeysWithPrefix(`narrative:${spin.id}:`).filter((k) => /:memory(:|$)/.test(k))
    ).toEqual([]);
    // 来源那一场的一张卡都不该因为番外跑了整理而变化
    expect((await storageModule.listMemoryCards(source.id)).length).toBe(来源卡数);
  });

  it("I2 对照组：普通对局同样入参确实会调模型（I1 的 0 是闸门挡的）", async () => {
    const plain = seedSession({ id: `sof_plain_i2_${rand()}` });
    const 起始调用数 = llmMock.calls;

    await writerModule.extractMemoriesFromCompression(
      plain.id,
      "普通角色",
      "全局大纲：她回到了灯塔。",
      [{ turnRange: [1, 4], summary: "前四轮的章节摘要" }],
      4,
      () => {}
    );

    expect(llmMock.calls - 起始调用数).toBeGreaterThan(0);
  });
});
