import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvGet, kvRemove, kvSet } from "@/lib/kv-db";
import * as storageModule from "@/lib/narrative-writer/storage";
import {
  extractFromTurn,
} from "@/lib/narrative-writer/extractor";
import {
  getMemoryCards,
  getWaterLevelByScope,
  listEmotionCards,
  listMemoryCards,
  purgeNarrativeSessionData,
  saveEmotionCard,
  saveMemoryCard,
  saveWaterLevel,
  updateMemoryCard,
} from "@/lib/narrative-writer/storage";
import type {
  EmotionCard,
  MemoryCard,
} from "@/lib/narrative-writer/types";
import { createDefaultWaterLevel } from "@/lib/narrative-writer/types";
import { getMixSession, saveMixSession } from "@/lib/mixology/storage";
import type { MixSession, MixTurn } from "@/lib/mixology/types";

// 卡片来源与丢弃归档测试
//
// 覆盖什么：抽取落库的卡由代码盖上「来源消息ID / 来源轮次」（不信任模型给的值）、
// 被丢弃回复的卡改判「归档」并写明归档原因（不删）、来源未知的卡一律不被牵连、
// 竞态（抽取期间来源消息被删）落库不得生效、水位同样受来源检查约束、
// 归档卡可以恢复回生效并清除归档原因。
//
// 只 mock 一个东西：调用大模型的入口 sendLLMRequest。抽取、盖来源、落库、归档、
// 来源检查全部走真实实现。resolveMixApiConfig 也必须替掉——它住在 mixology/engine 里，
// 真模块会把整条引擎依赖图（含浏览器侧存储）拖进 Node，所以这里给一个假配置，
// 让 callExtractorLLM 能真的走到 sendLLMRequest 这个边界上。
//
// 「engine 的每个移除路径是否都调用了 onTurnsDiscarded」自动测试覆盖不到（不 import
// mixology/engine），标记为「未覆盖，需手动确认」，路径清单见 tests/MANUAL_CHECKLIST.md。
//
// 环境说明：Node 下 hydrateKvDb() 被 typeof window 守卫短路，
// 「落盘后重读 / 刷新后仍在」属于「未覆盖，需手动确认」。

const llmMock = vi.hoisted(() => ({
  calls: 0,
  // 由每个用例设置的返回内容与副作用（模拟「模型响应期间历史被改动」）
  respond: null as null | (() => string),
  beforeResolve: null as null | (() => void),
}));

vi.mock("@/lib/chat-engine", () => ({
  sendLLMRequest: async () => {
    llmMock.calls += 1;
    llmMock.beforeResolve?.();
    return llmMock.respond ? llmMock.respond() : "[]";
  },
}));

vi.mock("@/lib/mixology/engine", () => ({
  resolveMixApiConfig: () => ({ id: "test-config", apiKey: "x", baseUrl: "x" }),
}));

// 实现完成后这些函数出现在 storage.ts 里；用可选签名，让「还没实现」表现为断言失败，
// 而不是类型错误或模块解析错误。
type NarrativeLifecycleApi = {
  onTurnsDiscarded?: (
    sessionId: string,
    discardedTurnIds: string[],
    reason: string
  ) => { memories: number; emotions: number };
  isSourceMessageAlive?: (
    sessionId: string,
    messageId?: string | null
  ) => boolean;
};
const lifecycle = storageModule as unknown as NarrativeLifecycleApi;

/** 带新字段的卡片视图：新字段实现前也能写进对象（不依赖 types.ts 已改） */
type CardWithSource = MemoryCard & {
  来源消息ID?: string;
  归档原因?: string;
};
type EmotionWithSource = EmotionCard & {
  来源消息ID?: string;
  来源轮次?: number;
  归档原因?: string;
};
/** extractFromTurn 的第 4 参在实现前没有「来源」字段，用 unknown 断言绕开多余属性检查 */
type ExtractContextArg = Parameters<typeof extractFromTurn>[3];

const createdSessionIds = new Set<string>();
const touchedMixKeys = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testsrc_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  createdSessionIds.add(sid);
  return sid;
}

function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 造 rounds 轮「玩家一句 + 角色一句」，返回 turns（assistant 消息 id 可按下标取） */
function makeTurns(rounds: number): MixTurn[] {
  const base = 1_700_000_000_000;
  const turns: MixTurn[] = [];
  for (let i = 1; i <= rounds; i += 1) {
    turns.push({
      id: `src_u_${i}_${rand()}`,
      role: "user",
      text: `玩家第 ${i} 轮发言`,
      createdAt: base + i * 2,
    });
    turns.push({
      id: `src_a_${i}_${rand()}`,
      role: "assistant",
      text: `角色第 ${i} 轮回复，提到了一座灯塔。`,
      createdAt: base + i * 2 + 1,
    });
  }
  return turns;
}

function makeSession(id: string, turns: MixTurn[]): MixSession {
  const now = 1_700_000_000_000;
  return {
    id,
    recipe: {
      id: `recipe_${id}`,
      name: "来源测试配方",
      slots: {},
      createdAt: now,
      updatedAt: now,
    },
    charName: "测试角色",
    openingIndex: 0,
    turns,
    createdAt: now,
    updatedAt: now,
  };
}

/** 把会话写进 mixology 存储（同步 API，走 kv 内存缓存），供来源检查读取 */
function persistSession(session: MixSession): MixSession {
  saveMixSession(session);
  touchedMixKeys.add("mixology_sessions_v1");
  return session;
}

/** 删除会话里的某几条消息，模拟「重说/回溯」之后的历史 */
function removeTurns(sessionId: string, turnIds: string[]): MixSession {
  const current = getMixSession(sessionId);
  if (!current) throw new Error(`会话不存在：${sessionId}`);
  const cut = current.turns.findIndex((t) => turnIds.includes(t.id));
  const next = cut < 0 ? current : { ...current, turns: current.turns.slice(0, cut) };
  return persistSession({ ...next, updatedAt: Date.now() });
}

function memoryPayload(content: string, 来源轮次 = 99): Record<string, unknown> {
  return {
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: content,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    时间: "",
    证据: content,
    // 模型自己填的来源，实现后必须被代码写入的值覆盖
    来源轮次,
  };
}

function emotionPayload(content: string): Record<string, unknown> {
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
    证据: content,
  };
}

function waterPayload(目标水位 = "L2"): Record<string, unknown> {
  return { kind: "water", 作用域: "戏内层", 建议状态: "active", 目标水位 };
}

/** 让 mock 的大模型返回给定条目 */
function llmReturns(items: Array<Record<string, unknown>>): void {
  llmMock.respond = () => JSON.stringify(items);
}

function baseContext(extra: Record<string, unknown> = {}): ExtractContextArg {
  return {
    isPlotMode: true,
    existingCardsSummary: [],
    currentWaterLevels: {},
    ...extra,
  } as unknown as ExtractContextArg;
}

async function memoriesOf(sid: string): Promise<CardWithSource[]> {
  const list = await listMemoryCards(sid);
  return list as unknown as CardWithSource[];
}

async function emotionsOf(sid: string): Promise<EmotionWithSource[]> {
  const list = await listEmotionCards(sid);
  return list as unknown as EmotionWithSource[];
}

/** 直接按原始 JSON 读一张卡，确认字段真的落盘（也用于伪造旧数据） */
function rawMemory(sid: string, cardId: string): Record<string, unknown> | null {
  const raw = kvGet(`narrative:${sid}:memory:${cardId}`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function writeLegacyMemory(sid: string, cardId: string, content: string): void {
  kvSet(
    `narrative:${sid}:memory:${cardId}`,
    JSON.stringify({
      id: cardId,
      kind: "memory",
      主体: "角色",
      主类型: "经历节点",
      内容: content,
      作用域: "戏内层",
      置信档: "高",
      置信度: 0.9,
      状态: "生效",
      证据: content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // 旧数据：完全没有 来源消息ID / 来源轮次 这两个键
    })
  );
}

beforeEach(() => {
  llmMock.calls = 0;
  llmMock.respond = null;
  llmMock.beforeResolve = null;
});

afterEach(async () => {
  // 只清本用例自己创建的会话命名空间与自己的对局记录，不动其它键
  for (const sid of createdSessionIds) purgeNarrativeSessionData(sid);
  for (const key of touchedMixKeys) kvRemove(key);
  createdSessionIds.clear();
  touchedMixKeys.clear();
  await new Promise((r) => setTimeout(r, 5));
});

describe("卡片来源：抽取时由代码盖写", () => {
  it("1. 抽出的卡带代码写入的来源消息ID与来源轮次，模型给的同名字段被丢弃；情感卡同样带上", async () => {
    const sid = makeSessionId("stamp");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 消息ID = turns[1].id;
    llmReturns([memoryPayload("角色第一次提到灯塔"), emotionPayload("角色感到好奇")]);

    await extractFromTurn(sid, "角色写下的正文", ["上一轮"], baseContext({
      来源: { 消息ID, 轮次: 2 },
    }));

    const memories = await memoriesOf(sid);
    expect(memories.length).toBe(1);
    expect(memories[0].来源消息ID).toBe(消息ID);
    // 模型填的是 99，必须被代码写入的 2 覆盖
    expect(memories[0].来源轮次).toBe(2);

    const emotions = await emotionsOf(sid);
    expect(emotions.length).toBe(1);
    expect(emotions[0].来源消息ID).toBe(消息ID);
    expect(emotions[0].来源轮次).toBe(2);
    expect(memories.length + emotions.length).toBeGreaterThan(0);
  });
});

describe("卡片来源：回复被丢弃时归档", () => {
  it("2. 重说场景：旧回复的卡归档、新回复的卡生效，生效集合里不留重复来源", async () => {
    const sid = makeSessionId("reroll");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 旧回复ID = turns[1].id;

    llmReturns([memoryPayload("旧回复抽出的卡")]);
    await extractFromTurn(sid, "旧正文", [], baseContext({
      来源: { 消息ID: 旧回复ID, 轮次: 1 },
    }));

    // 重说：旧回复从会话里消失，新回复带新 id 追加进来
    const trimmed = removeTurns(sid, [旧回复ID]);
    const 新回复: MixTurn = {
      id: `src_a_new_${rand()}`,
      role: "assistant",
      text: "换一种写法的新回复。",
      createdAt: Date.now(),
    };
    persistSession({ ...trimmed, turns: [...trimmed.turns, 新回复] });

    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    const result = lifecycle.onTurnsDiscarded!(
      sid,
      [旧回复ID],
      "来源回复已被丢弃（重说）"
    );
    expect(result.memories).toBe(1);

    llmReturns([memoryPayload("新回复抽出的卡")]);
    await extractFromTurn(sid, "新正文", [], baseContext({
      来源: { 消息ID: 新回复.id, 轮次: 1 },
    }));

    const all = await memoriesOf(sid);
    const 生效 = all.filter((c) => c.状态 === "生效");
    const 归档 = all.filter((c) => c.状态 === "归档");
    expect(生效.map((c) => c.内容)).toEqual(["新回复抽出的卡"]);
    expect(生效.map((c) => c.来源消息ID)).toEqual([新回复.id]);
    expect(归档.length).toBe(1);
    expect(归档[0].来源消息ID).toBe(旧回复ID);
    expect(归档[0].归档原因).toContain("重说");
    // 同一主题不该两张生效卡并存
    expect(new Set(生效.map((c) => c.内容)).size).toBe(生效.length);
  });

  it("3. 继续生成（纯追加）：一张卡都不归档", async () => {
    const sid = makeSessionId("append");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 已有回复ID = turns[1].id;
    llmReturns([memoryPayload("已有回复抽出的卡")]);
    await extractFromTurn(sid, "已有正文", [], baseContext({
      来源: { 消息ID: 已有回复ID, 轮次: 1 },
    }));

    const current = getMixSession(sid)!;
    persistSession({
      ...current,
      turns: [...current.turns, makeTurns(1)[1]],
    });

    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    const result = lifecycle.onTurnsDiscarded!(sid, [], "纯追加，没有消息被丢弃");
    // 返回值扩到四类：线索卡/伏笔卡同样按来源归档（见 thread-foreshadow-cards 用例 14）。
    // 本用例只关心"纯追加一张都不归档"，四类数量全 0 即成立。
    expect(result).toEqual({
      memories: 0,
      emotions: 0,
      threads: 0,
      foreshadows: 0,
    });

    const after = await memoriesOf(sid);
    expect(after.length).toBe(1);
    expect(after[0].状态).toBe("生效");
  });

  it("4. 旧数据（卡里没有来源字段）：重说时不被批量归档", async () => {
    const sid = makeSessionId("legacy");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 被丢回复ID = turns[1].id;
    const 旧卡ID = `legacy_${rand()}`;
    writeLegacyMemory(sid, 旧卡ID, "隔离之前抽出的老卡");
    llmReturns([memoryPayload("有来源的新卡")]);
    await extractFromTurn(sid, "正文", [], baseContext({
      来源: { 消息ID: 被丢回复ID, 轮次: 1 },
    }));

    removeTurns(sid, [被丢回复ID]);
    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    lifecycle.onTurnsDiscarded!(sid, [被丢回复ID], "来源回复已被丢弃（重说）");

    const all = await memoriesOf(sid);
    const 旧卡 = all.find((c) => c.id === 旧卡ID);
    expect(旧卡).toBeTruthy();
    expect(旧卡!.状态).toBe("生效");
    expect(rawMemory(sid, 旧卡ID)).toBeTruthy();
    expect(rawMemory(sid, 旧卡ID)!.来源消息ID).toBeUndefined();
    // 有来源的那张照常归档
    expect(all.filter((c) => c.状态 === "归档").length).toBe(1);
  });

  it("5. 来源未知的卡（整理/补抽产的）不因同会话其它卡被归档而受牵连", async () => {
    const sid = makeSessionId("unknown-source");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 回复ID = turns[1].id;

    // 模拟 Map-Reduce 整理产的卡：有来源标签文案、没有任何来源字段
    const now = Date.now();
    await saveMemoryCard(sid, {
      id: `nw_chunk_${rand()}`,
      kind: "memory",
      主体: "世界",
      主类型: "世界变更",
      内容: "整理产出的全局大事",
      作用域: "共识层",
      置信档: "中",
      置信度: 0.7,
      状态: "待核",
      证据: "由记忆整理从全局剧情大纲提炼",
      createdAt: now,
      updatedAt: now,
    });
    await saveEmotionCard(sid, {
      id: `nw_emotion_${rand()}`,
      kind: "emotion",
      主体: "角色",
      类别: "瞬时情绪",
      标签: "平静",
      强度: 0.6,
      作用域: "戏内层",
      证据: "整理时补记",
      置信档: "中",
      置信度: 0.7,
      状态: "待核",
      createdAt: now,
      updatedAt: now,
    });
    llmReturns([memoryPayload("这一条回复才有来源")]);
    await extractFromTurn(sid, "正文", [], baseContext({
      来源: { 消息ID: 回复ID, 轮次: 1 },
    }));

    removeTurns(sid, [回复ID]);
    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    const result = lifecycle.onTurnsDiscarded!(sid, [回复ID], "来源回复已被丢弃（回溯）");
    expect(result.memories).toBe(1);
    expect(result.emotions).toBe(0);

    const 整理卡 = (await memoriesOf(sid)).find((c) => c.内容 === "整理产出的全局大事");
    expect(整理卡!.状态).toBe("待核");
    expect(整理卡!.归档原因).toBeUndefined();
    const 情感卡 = await emotionsOf(sid);
    expect(情感卡[0].状态).toBe("待核");
  });

  it("6. 非「生效/待核」状态的卡不被覆盖状态与归档原因", async () => {
    const sid = makeSessionId("other-status");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 回复ID = turns[1].id;
    const now = Date.now();

    const 冲突卡: CardWithSource = {
      id: `conflict_${rand()}`,
      kind: "memory",
      主体: "角色",
      主类型: "经历节点",
      内容: "已标冲突的卡",
      作用域: "戏内层",
      置信档: "中",
      置信度: 0.7,
      状态: "冲突",
      证据: "冲突",
      来源消息ID: 回复ID,
      来源轮次: 1,
      createdAt: now,
      updatedAt: now,
    };
    const 已归档卡: CardWithSource = {
      ...冲突卡,
      id: `archived_${rand()}`,
      内容: "早就归档的卡",
      状态: "归档",
      归档原因: "玩家手动归档",
    };
    await saveMemoryCard(sid, 冲突卡 as MemoryCard);
    await saveMemoryCard(sid, 已归档卡 as MemoryCard);

    removeTurns(sid, [回复ID]);
    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    const result = lifecycle.onTurnsDiscarded!(
      sid,
      [回复ID],
      "来源回复已被丢弃（重说）"
    );
    expect(result.memories).toBe(0);

    const all = await memoriesOf(sid);
    const 冲突 = all.find((c) => c.内容 === "已标冲突的卡");
    const 归档 = all.find((c) => c.内容 === "早就归档的卡");
    expect(冲突!.状态).toBe("冲突");
    expect(冲突!.归档原因).toBeUndefined();
    expect(归档!.状态).toBe("归档");
    expect(归档!.归档原因).toBe("玩家手动归档");
  });
});

describe("卡片来源：异步抽取竞态", () => {
  it("7. 抽取期间来源消息被删：落库的卡不得生效，改判归档并写明原因；水位不写", async () => {
    const sid = makeSessionId("race");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 回复ID = turns[1].id;
    await saveWaterLevel(sid, {
      ...createDefaultWaterLevel("戏内层"),
      水位: "L1",
      status: "active",
    });

    llmReturns([
      memoryPayload("抽取期间才落库的卡"),
      emotionPayload("抽取期间才落库的情绪"),
      waterPayload("L3"),
    ]);
    // 模型响应期间，玩家点了重说：来源消息从会话里消失
    llmMock.beforeResolve = () => removeTurns(sid, [回复ID]);

    await extractFromTurn(sid, "正文", [], baseContext({
      来源: { 消息ID: 回复ID, 轮次: 1 },
    }));

    const memories = await memoriesOf(sid);
    expect(memories.length).toBe(1);
    expect(memories[0].状态).toBe("归档");
    expect(memories[0].状态).not.toBe("生效");
    expect(memories[0].归档原因).toContain("来源消息已不存在");
    const emotions = await emotionsOf(sid);
    expect(emotions.length).toBe(1);
    expect(emotions[0].状态).toBe("归档");
    // 水位：来源都不在了，这次建议不该盖上去
    const water = await getWaterLevelByScope(sid, "戏内层");
    expect(water.水位).toBe("L1");
  });

  it("8. 抽取开始前来源消息就不在：跳过这次大模型调用，且不落任何卡", async () => {
    const sid = makeSessionId("skip");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 幽灵回复ID = `src_ghost_${rand()}`;
    llmReturns([memoryPayload("不该被抽出来的卡"), emotionPayload("不该被抽出来的情绪")]);

    expect(typeof lifecycle.isSourceMessageAlive).toBe("function");
    expect(lifecycle.isSourceMessageAlive!(sid, 幽灵回复ID)).toBe(false);

    await extractFromTurn(sid, "正文", [], baseContext({
      来源: { 消息ID: 幽灵回复ID, 轮次: 1 },
    }));

    expect(llmMock.calls).toBe(0);
    expect(await listMemoryCards(sid)).toEqual([]);
    expect(await listEmotionCards(sid)).toEqual([]);

    // 对照：来源未知（不带 来源）时不该被跳过，照常调用
    await extractFromTurn(sid, "正文", [], baseContext());
    expect(llmMock.calls).toBe(1);
  });
});

describe("卡片来源：归档可恢复", () => {
  it("9. 恢复生效：归档→生效，归档原因被清除", async () => {
    const sid = makeSessionId("restore");
    const turns = makeTurns(2);
    persistSession(makeSession(sid, turns));
    const 回复ID = turns[1].id;
    llmReturns([memoryPayload("被丢弃回复的卡")]);
    await extractFromTurn(sid, "正文", [], baseContext({
      来源: { 消息ID: 回复ID, 轮次: 1 },
    }));
    removeTurns(sid, [回复ID]);
    expect(typeof lifecycle.onTurnsDiscarded).toBe("function");
    lifecycle.onTurnsDiscarded!(sid, [回复ID], "来源回复已被丢弃（重说）");

    const 归档卡 = (await memoriesOf(sid))[0];
    expect(归档卡.状态).toBe("归档");
    const 原始归档原因 = 归档卡.归档原因;
    expect(原始归档原因).toBeTruthy();

    await updateMemoryCard(sid, 归档卡.id, {
      状态: "生效",
      归档原因: undefined,
    } as Partial<CardWithSource>);

    const 恢复后 = rawMemory(sid, 归档卡.id)!;
    expect(恢复后.状态).toBe("生效");
    expect("归档原因" in 恢复后).toBe(false);
    expect(恢复后.来源消息ID).toBe(回复ID);
    expect((await getMemoryCards(sid))[0].状态).toBe("生效");
  });
});
