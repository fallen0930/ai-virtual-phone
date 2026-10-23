import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvKeysWithPrefix, kvRemove } from "@/lib/kv-db";
import { copyNarrativeOnFork } from "@/lib/narrative-writer/fork";
import * as storageNamespace from "@/lib/narrative-writer/storage";
import {
  deleteMemoryCard,
  getContextHierarchy,
  getWaterLevelByScope,
  getWriterState,
  listEmotionCards,
  listMemoryCards,
  purgeNarrativeSessionData,
  saveContextHierarchy,
  saveEmotionCard,
  saveMemoryCard,
  saveWaterLevel,
  saveWriterState,
  updateMemoryCard,
} from "@/lib/narrative-writer/storage";
import type { MemoryCard } from "@/lib/narrative-writer/types";
import { createDefaultWaterLevel, createDefaultWriterState } from "@/lib/narrative-writer/types";
import { saveMixSession } from "@/lib/mixology/storage";
import type { MixSession, MixTurn } from "@/lib/mixology/types";

// 分叉复制测试：手工构造父子会话，不调用 forkMixSession，也不 import mixology/engine。
//
// writer.ts 会顺带拖进 chat-engine / mixology-engine 的整条依赖图，这里只 mock 它的
// 纯函数 computeCurrentTurn（实现就是 min(用户条数, AI 条数)），避免 Node 里加载引擎。
// 存储层仍用真实实现，只在“复制中途失败”用例里由测试注入一次 saveMemoryCard 抛错。
//
// 环境说明：Node 下 hydrateKvDb() 被短路，“落盘后重读 / 刷新后仍在”属于
// “未覆盖，需手动确认”。这里测的是复制范围、轮次修正、判断条件与失败清理。

const saveControl = vi.hoisted(() => ({ failAt: 0, calls: 0 }));

vi.mock("@/lib/narrative-writer/writer", () => ({
  computeCurrentTurn: (turns: Array<{ role: string }>) => {
    const users = turns.filter((t) => t.role === "user").length;
    const assistants = turns.filter((t) => t.role === "assistant").length;
    return Math.min(users, assistants);
  },
}));

vi.mock("@/lib/narrative-writer/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/narrative-writer/storage")>();
  return {
    ...actual,
    saveMemoryCard: async (
      sessionId: string | null | undefined,
      card: MemoryCard
    ) => {
      saveControl.calls += 1;
      if (saveControl.failAt > 0 && saveControl.calls === saveControl.failAt) {
        throw new Error("注入：复制中途失败");
      }
      return actual.saveMemoryCard(sessionId, card);
    },
  };
});

const createdSessionIds = new Set<string>();

// 线索卡/伏笔卡的分叉复制是本轮新增范围。这些函数还没实现，用命名空间导入 + 可选签名访问，
// 让「还没实现」表现为断言失败而不是模块解析错误。
type ThreadLike = {
  id: string;
  kind: string;
  名称: string;
  线索状态: string;
  关联角色: string[];
  上次推进轮次: number;
  下一步可能: string;
  最近变化: Array<{ 变化: string; 轮次?: number; 来源消息ID?: string }>;
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
type ForkStorageApi = {
  saveThreadCard?: (sessionId: string, card: ThreadLike) => Promise<void>;
  listThreadCards?: (sessionId: string) => Promise<ThreadLike[]>;
  saveForeshadowCard?: (
    sessionId: string,
    card: ForeshadowLike
  ) => Promise<void>;
  listForeshadowCards?: (sessionId: string) => Promise<ForeshadowLike[]>;
};
const forkStorage = storageNamespace as unknown as ForkStorageApi;

function requireForkFn<K extends keyof ForkStorageApi>(
  name: K
): NonNullable<ForkStorageApi[K]> {
  const fn = forkStorage[name];
  expect(fn, `storage.${String(name)} 尚未实现`).toBeTypeOf("function");
  return fn as NonNullable<ForkStorageApi[K]>;
}

function mkThread(id: string, 名称: string): ThreadLike {
  const now = Date.now();
  return {
    id,
    kind: "thread",
    名称,
    线索状态: "升温",
    关联角色: ["角色A"],
    上次推进轮次: 2,
    下一步可能: "去当铺问来路",
    最近变化: [{ 变化: "父场推进", 轮次: 2 }],
    状态: "生效",
    来源轮次: 2,
    audience: ["all"],
    createdAt: now,
    updatedAt: now,
  };
}

function mkForeshadow(id: string, 内容: string): ForeshadowLike {
  const now = Date.now();
  return {
    id,
    kind: "foreshadow",
    内容,
    埋下轮次: 1,
    预期回收窗口: { 起: 3, 止: 6 },
    伏笔状态: "未收",
    状态: "生效",
    来源轮次: 1,
    audience: ["all"],
    createdAt: now,
    updatedAt: now,
  };
}

function makeSessionId(tag: string): string {
  const sid = `testfork_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  createdSessionIds.add(sid);
  return sid;
}

function makeCardId(): string {
  return `tfk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeTurns(rounds: number): MixTurn[] {
  const base = 1_700_000_000_000;
  const turns: MixTurn[] = [];
  for (let i = 1; i <= rounds; i += 1) {
    turns.push({
      id: `t_u_${i}_${makeCardId()}`,
      role: "user",
      text: `用户第 ${i} 轮`,
      createdAt: base + i * 2,
    });
    turns.push({
      id: `t_a_${i}_${makeCardId()}`,
      role: "assistant",
      text: `角色第 ${i} 轮`,
      createdAt: base + i * 2 + 1,
    });
  }
  return turns;
}

function makeSession(
  id: string,
  turns: MixTurn[],
  extra?: Partial<MixSession>
): MixSession {
  const now = 1_700_000_000_000;
  return {
    id,
    recipe: {
      id: `recipe_${id}`,
      name: "测试配方",
      slots: {},
      createdAt: now,
      updatedAt: now,
    },
    charName: "测试角色",
    openingIndex: 0,
    turns,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function makeChild(
  parent: MixSession,
  childId: string,
  keepTurns: number
): MixSession {
  return makeSession(childId, parent.turns.slice(0, keepTurns), {
    parentId: parent.id,
    rootId: parent.id,
    forkTurnIndex: Math.max(0, keepTurns - 1),
    depth: 1,
  });
}

function makeMemory(id: string, content: string): MemoryCard {
  const now = Date.now();
  return {
    id,
    kind: "memory",
    主体: "角色",
    主类型: "经历节点",
    内容: content,
    作用域: "戏内层",
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    证据: content,
    来源轮次: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeEmotion(id: string) {
  const now = Date.now();
  return {
    id,
    kind: "emotion" as const,
    主体: "角色" as const,
    类别: "瞬时情绪" as const,
    标签: "平静" as const,
    强度: 0.5,
    作用域: "戏内层" as const,
    证据: "父场情绪",
    置信档: "高" as const,
    置信度: 0.9,
    状态: "生效" as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedParentData(
  parentId: string,
  opts?: {
    writerCurrentTurn?: number;
    lastExtractedTurn?: number;
    compressedTurn?: number;
  }
) {
  const writerCurrentTurn = opts?.writerCurrentTurn ?? 5;
  const lastExtractedTurn = opts?.lastExtractedTurn ?? 5;
  const compressedTurn = opts?.compressedTurn ?? 9;
  await saveMemoryCard(parentId, makeMemory(`${parentId}_m1`, "父场记忆一"));
  await saveMemoryCard(parentId, makeMemory(`${parentId}_m2`, "父场记忆二"));
  await saveEmotionCard(parentId, makeEmotion(`${parentId}_e1`));
  await saveWaterLevel(parentId, {
    ...createDefaultWaterLevel("戏内层"),
    水位: "L3",
  });
  await saveWaterLevel(parentId, {
    ...createDefaultWaterLevel("现实层"),
    水位: "L1",
  });
  await saveWriterState(parentId, {
    ...createDefaultWriterState(parentId),
    currentTurn: writerCurrentTurn,
    lastExtractedTurn,
    当前弧光: "父场弧光",
  });
  await saveContextHierarchy(parentId, {
    L2_章节摘要: [{ turnRange: [1, 1], summary: "父场摘要", createdAt: 1 }],
    L3_全局大纲: "父场大纲",
    lastCompressedAt: 1,
    lastCompressedTurn: compressedTurn,
  });
}

beforeEach(() => {
  saveControl.failAt = 0;
  saveControl.calls = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  saveControl.failAt = 0;
  saveControl.calls = 0;
  vi.restoreAllMocks();

  for (const sid of createdSessionIds) {
    purgeNarrativeSessionData(sid);
    expect(kvKeysWithPrefix(`narrative:${sid}:`)).toEqual([]);
  }
  createdSessionIds.clear();
  kvRemove("mixology_sessions_v1");
  kvRemove("mixology_session_folders_v1");
  kvRemove("mixology_pending_queue_v1");

  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe("fork-copy: 分叉时继承父会话记忆", () => {
  it("末尾分叉复制卡片、水位与大纲，子场新增/父场删除互不影响", async () => {
    const parent = makeSession(makeSessionId("parent"), makeTurns(2));
    const childId = makeSessionId("child");
    const child = makeChild(parent, childId, parent.turns.length);
    saveMixSession(parent);
    await seedParentData(parent.id);
    saveControl.calls = 0;

    const result = await copyNarrativeOnFork(child);
    expect(result).toEqual({
      endFork: true,
      copied: true,
      memories: 2,
      emotions: 1,
      // 本轮新增：返回结构要能区分「判定为末尾分叉」与「线索/伏笔各复制了几张」
      threads: 0,
      foreshadows: 0,
    });

    const childMems = await listMemoryCards(childId);
    expect(childMems.map((c) => c.内容).sort()).toEqual([
      "父场记忆一",
      "父场记忆二",
    ]);
    expect(await listEmotionCards(childId)).toHaveLength(1);
    expect(await getWaterLevelByScope(childId, "戏内层")).toMatchObject({
      水位: "L3",
    });
    expect(await getWaterLevelByScope(childId, "现实层")).toMatchObject({
      水位: "L1",
    });
    expect(await getContextHierarchy(childId)).toMatchObject({
      L3_全局大纲: "父场大纲",
      lastCompressedTurn: 2,
    });

    // 子场改写不影响父场
    await updateMemoryCard(childId, `${parent.id}_m1`, { 内容: "子场改写" });
    const parentMems = await listMemoryCards(parent.id);
    expect(parentMems.find((c) => c.id === `${parent.id}_m1`)?.内容).toBe(
      "父场记忆一"
    );

    // 子场新增不影响父场数量
    await saveMemoryCard(childId, makeMemory("fork_child_extra", "子场新增"));
    expect(await listMemoryCards(parent.id)).toHaveLength(2);

    // 父场删除不影响子场
    await deleteMemoryCard(parent.id, `${parent.id}_m2`);
    expect((await listMemoryCards(childId)).map((c) => c.id)).toContain(
      `${parent.id}_m2`
    );
  });

  it("复制后的修正：id 指向子会话，轮次与压缩进度按子会话消息重算", async () => {
    const parent = makeSession(makeSessionId("parent"), makeTurns(1));
    const childId = makeSessionId("child");
    const child = makeChild(parent, childId, parent.turns.length);
    saveMixSession(parent);
    await seedParentData(parent.id, {
      writerCurrentTurn: 9,
      lastExtractedTurn: 9,
      compressedTurn: 9,
    });
    saveControl.calls = 0;

    const result = await copyNarrativeOnFork(child);
    expect(result.copied).toBe(true);

    const writer = await getWriterState(childId);
    expect(writer.id).toBe(childId);
    expect(writer.currentTurn).toBe(1);
    expect(writer.lastExtractedTurn).toBe(1);
    expect(writer.当前弧光).toBe("父场弧光");

    const hierarchy = await getContextHierarchy(childId);
    expect(hierarchy?.lastCompressedTurn).toBe(1);
    expect(hierarchy?.lastCompressedTurn).toBeLessThanOrEqual(writer.currentTurn);

    // 父会话自己的状态不被改写
    const parentWriter = await getWriterState(parent.id);
    expect(parentWriter.id).toBe(parent.id);
    expect(parentWriter.currentTurn).toBe(9);
  });

  it("中间分叉不复制，子会话空记忆，父会话不受影响", async () => {
    const parent = makeSession(makeSessionId("parent"), makeTurns(2));
    const childId = makeSessionId("child");
    const child = makeChild(parent, childId, 2);
    saveMixSession(parent);
    await seedParentData(parent.id);
    saveControl.calls = 0;

    const result = await copyNarrativeOnFork(child);
    // 这两个字段就是调用方提示语的依据：copied=false → “从空记忆开始”
    expect(result).toEqual({
      endFork: false,
      copied: false,
      memories: 0,
      emotions: 0,
      threads: 0,
      foreshadows: 0,
    });
    expect(kvKeysWithPrefix(`narrative:${childId}:`)).toEqual([]);
    expect(await listMemoryCards(parent.id)).toHaveLength(2);
    expect(await getWaterLevelByScope(parent.id, "戏内层")).toMatchObject({
      水位: "L3",
    });
  });

  it("判断边界：最后一条复制、倒数第二条不复制、空父会话不复制、只有开场白", async () => {
    // 最后一条消息分叉 → 复制
    {
      const parent = makeSession(makeSessionId("last_parent"), makeTurns(2));
      const childId = makeSessionId("last_child");
      const child = makeChild(parent, childId, parent.turns.length);
      saveMixSession(parent);
      await saveMemoryCard(parent.id, makeMemory(`${parent.id}_m`, "父场记忆"));
      saveControl.calls = 0;
      const result = await copyNarrativeOnFork(child);
      expect(result.endFork).toBe(true);
      expect(result.copied).toBe(true);
      expect(result.memories).toBe(1);
    }

    // 倒数第二条分叉 → 不复制
    {
      const parent = makeSession(makeSessionId("prev_parent"), makeTurns(2));
      const childId = makeSessionId("prev_child");
      const child = makeChild(parent, childId, parent.turns.length - 1);
      saveMixSession(parent);
      await saveMemoryCard(parent.id, makeMemory(`${parent.id}_m`, "父场记忆"));
      saveControl.calls = 0;
      const result = await copyNarrativeOnFork(child);
      expect(result.endFork).toBe(false);
      expect(result.copied).toBe(false);
      expect(kvKeysWithPrefix(`narrative:${childId}:`)).toEqual([]);
    }

    // 空父会话 → 不复制
    {
      const parent = makeSession(makeSessionId("empty_parent"), []);
      const childId = makeSessionId("empty_child");
      const child = makeChild(parent, childId, 0);
      saveMixSession(parent);
      saveControl.calls = 0;
      const result = await copyNarrativeOnFork(child);
      expect(result.endFork).toBe(false);
      expect(result.copied).toBe(false);
      expect(kvKeysWithPrefix(`narrative:${childId}:`)).toEqual([]);
    }

    // 只有开场白：当前实现按“消息条数相等”判定，开场白也算一条消息 → 视为末尾分叉。
    // 这里特意放一张父场手写记忆，锁住现状；若将来改成“没有完成回合不复制”，本断言会先变红。
    {
      const opening: MixTurn = {
        id: `t_open_${makeCardId()}`,
        role: "assistant",
        text: "开场白",
        createdAt: 1,
      };
      const parent = makeSession(makeSessionId("opening_parent"), [opening]);
      const childId = makeSessionId("opening_child");
      const child = makeChild(parent, childId, 1);
      saveMixSession(parent);
      await saveMemoryCard(
        parent.id,
        makeMemory(`${parent.id}_m`, "开场前手写记忆")
      );
      saveControl.calls = 0;
      const result = await copyNarrativeOnFork(child);
      expect(result.endFork).toBe(true);
      expect(result.copied).toBe(true);
      expect(result.memories).toBe(1);
      const writer = await getWriterState(childId);
      expect(writer.currentTurn).toBe(0);
      expect(writer.lastExtractedTurn).toBe(0);
    }
  });

  it("复制中途失败：不留半份数据，返回 copied:false，不向外抛错", async () => {
    const parent = makeSession(makeSessionId("fail_parent"), makeTurns(2));
    const childId = makeSessionId("fail_child");
    const child = makeChild(parent, childId, parent.turns.length);
    saveMixSession(parent);
    await seedParentData(parent.id);

    saveControl.calls = 0;
    saveControl.failAt = 2;
    const result = await copyNarrativeOnFork(child);
    saveControl.failAt = 0;

    expect(result).toEqual({
      endFork: true,
      copied: false,
      memories: 0,
      emotions: 0,
      threads: 0,
      foreshadows: 0,
    });
    expect(kvKeysWithPrefix(`narrative:${childId}:`)).toEqual([]);
    expect(await listMemoryCards(parent.id)).toHaveLength(2);
  });

  it("线索卡与伏笔卡：末尾分叉复制进子场且互不影响，中间分叉一张都不带", async () => {
    // 末尾分叉：悬念资产与记忆卡同属"这场戏的历史"，要一起带过去
    const parent = makeSession(makeSessionId("t_parent"), makeTurns(2));
    const childId = makeSessionId("t_child");
    const child = makeChild(parent, childId, parent.turns.length);
    saveMixSession(parent);
    await seedParentData(parent.id);
    await requireForkFn("saveThreadCard")(
      parent.id,
      mkThread(`${parent.id}_t1`, "父场线索")
    );
    await requireForkFn("saveForeshadowCard")(
      parent.id,
      mkForeshadow(`${parent.id}_f1`, "父场伏笔")
    );
    saveControl.calls = 0;

    const copied = await copyNarrativeOnFork(child);
    expect(copied).toMatchObject({ threads: 1, foreshadows: 1 });
    const childThreads = await requireForkFn("listThreadCards")(childId);
    expect(childThreads.map((t) => t.名称)).toEqual(["父场线索"]);
    // 卡片 id 与关联信息原样带过去（命名空间已按会话分开）
    expect(childThreads[0].id).toBe(`${parent.id}_t1`);
    expect(childThreads[0].线索状态).toBe("升温");
    expect(childThreads[0].最近变化).toHaveLength(1);
    const childForeshadows = await requireForkFn("listForeshadowCards")(childId);
    expect(childForeshadows.map((f) => f.内容)).toEqual(["父场伏笔"]);
    expect(childForeshadows[0].预期回收窗口).toEqual({ 起: 3, 止: 6 });

    // 子场改写不影响父场
    await requireForkFn("saveThreadCard")(
      childId,
      { ...childThreads[0], 名称: "子场改写" }
    );
    const parentThreads = await requireForkFn("listThreadCards")(parent.id);
    expect(parentThreads.map((t) => t.名称)).toEqual(["父场线索"]);

    // 中间分叉：子场空记忆起步，线索卡一张都不带（判定拿不准也按这里处理）
    const midParent = makeSession(makeSessionId("tm_parent"), makeTurns(2));
    const midChildId = makeSessionId("tm_child");
    const midChild = makeChild(midParent, midChildId, 2);
    saveMixSession(midParent);
    await requireForkFn("saveThreadCard")(
      midParent.id,
      mkThread(`${midParent.id}_t1`, "分叉点之后的线索")
    );
    saveControl.calls = 0;
    const midResult = await copyNarrativeOnFork(midChild);
    expect((midResult as unknown as { threads?: number }).threads).toBe(0);
    expect(await requireForkFn("listThreadCards")(midChildId)).toEqual([]);
    expect(kvKeysWithPrefix(`narrative:${midChildId}:`)).toEqual([]);
  });
});
