import { afterEach, describe, expect, it } from "vitest";
import { kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "@/lib/kv-db";
import * as purgeStorage from "@/lib/narrative-writer/storage";
import {
  deleteMixSession,
  deleteMixSessionBranch,
  getMixSession,
  saveMixSession,
} from "@/lib/mixology/storage";
import type { MixSession, MixTurn } from "@/lib/mixology/types";
import {
  getContextHierarchy,
  getEmotionCard,
  getMemoryCard,
  getWriterState,
  listNarrativeHistory,
  purgeNarrativeSessionData,
  saveContextHierarchy,
  saveEmotionCard,
  saveMemoryCard,
  saveNarrativeHistoryEntry,
  saveWaterLevel,
  saveWriterState,
} from "@/lib/narrative-writer/storage";
import type {
  EmotionCard,
  MemoryCard,
  NarrativeHistoryEntry,
} from "@/lib/narrative-writer/types";
import {
  createDefaultWaterLevel,
  createDefaultWriterState,
} from "@/lib/narrative-writer/types";

// 删除清理测试：删除对局 / 删除支线时必须只清掉该会话的 narrative 数据，
// 不碰其它会话，也不碰旧全局键、迁移标记与旧数据备份。
//
// 环境说明：Node 下 hydrateKvDb() 被短路，“落盘后重读 / 刷新后仍在”属于
// “未覆盖，需手动确认”。这里测的是删除路径的清理边界。
// 所有会话 id 随机生成，用例内自清理。

const BACKUP_KEY = "narrative:legacy_backup_v1";
const MIGRATION_STATE_KEY = "narrative:migration_state_v1";

const createdSessionIds = new Set<string>();
const createdGlobalKeys = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testdel_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  createdSessionIds.add(sid);
  return sid;
}

function makeCardId(): string {
  return `tdel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    turns: makeTurns(1),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
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

function makeEmotion(id: string, evidence: string): EmotionCard {
  const now = Date.now();
  return {
    id,
    kind: "emotion",
    主体: "角色",
    类别: "瞬时情绪",
    标签: "平静",
    强度: 0.5,
    作用域: "戏内层",
    证据: evidence,
    置信档: "高",
    置信度: 0.9,
    状态: "生效",
    createdAt: now,
    updatedAt: now,
  };
}

function makeHistory(id: string, sessionId: string): NarrativeHistoryEntry {
  return {
    id,
    timestamp: Date.now(),
    mode: "direct",
    playerTendency: "靠近",
    output: { banner: "夜谈", body: `${sessionId} 的输出` },
    sessionId,
    metadata: { beats: 2, isTurningPoint: false, directionAdjusted: false },
  };
}

/** 给会话写满六类执笔数据，返回卡片 id 便于断言 */
async function seedNarrative(sessionId: string) {
  const memoryId = `${sessionId}_m`;
  const emotionId = `${sessionId}_e`;
  const historyId = `${sessionId}_h`;
  await saveMemoryCard(sessionId, makeMemory(memoryId, `${sessionId} 记忆`));
  await saveEmotionCard(sessionId, makeEmotion(emotionId, `${sessionId} 情绪`));
  await saveWaterLevel(sessionId, {
    ...createDefaultWaterLevel("戏内层"),
    水位: "L3",
  });
  await saveWriterState(sessionId, {
    ...createDefaultWriterState(sessionId),
    currentTurn: 1,
  });
  await saveContextHierarchy(sessionId, {
    L2_章节摘要: [],
    L3_全局大纲: `${sessionId} 大纲`,
    lastCompressedAt: 1,
    lastCompressedTurn: 1,
  });
  await saveNarrativeHistoryEntry(
    sessionId,
    makeHistory(historyId, sessionId)
  );
  return { memoryId, emotionId, historyId };
}

// 线索卡/伏笔卡是本轮新增的数据种类：还没实现的函数用命名空间导入 + 可选签名访问，
// 让「还没实现」表现为断言失败，而不是模块解析错误。
type PurgeCardLike = Record<string, unknown>;
type PurgeStorageApi = {
  saveThreadCard?: (sessionId: string, card: PurgeCardLike) => Promise<void>;
  saveForeshadowCard?: (
    sessionId: string,
    card: PurgeCardLike
  ) => Promise<void>;
};
const purgeApi = purgeStorage as unknown as PurgeStorageApi;

function requirePurgeFn<K extends keyof PurgeStorageApi>(
  name: K
): NonNullable<PurgeStorageApi[K]> {
  const fn = purgeApi[name];
  expect(fn, `storage.${String(name)} 尚未实现`).toBeTypeOf("function");
  return fn as NonNullable<PurgeStorageApi[K]>;
}

function setGlobalRaw(key: string, value: unknown): string {
  const raw = JSON.stringify(value);
  kvSet(key, raw);
  createdGlobalKeys.add(key);
  return raw;
}

afterEach(async () => {
  for (const sid of createdSessionIds) {
    purgeNarrativeSessionData(sid);
    expect(kvKeysWithPrefix(`narrative:${sid}:`)).toEqual([]);
  }
  createdSessionIds.clear();

  for (const key of createdGlobalKeys) {
    kvRemove(key);
    expect(kvGet(key)).toBeNull();
  }
  createdGlobalKeys.clear();

  kvRemove(BACKUP_KEY);
  kvRemove(MIGRATION_STATE_KEY);
  kvRemove("mixology_sessions_v1");
  kvRemove("mixology_session_folders_v1");
  kvRemove("mixology_pending_queue_v1");

  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe("delete-purge: 删除对局时只清理本会话的执笔数据", () => {  it("删除会话 B：B 的 narrative 键全空，A 不受影响", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    saveMixSession(makeSession(sidA));
    saveMixSession(makeSession(sidB));
    await seedNarrative(sidA);
    await seedNarrative(sidB);

    deleteMixSession(sidB);

    expect(getMixSession(sidB)).toBeNull();
    expect(getMixSession(sidA)?.id).toBe(sidA);
    expect(kvKeysWithPrefix(`narrative:${sidB}:`)).toEqual([]);
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toHaveLength(6);
    expect((await getMemoryCard(sidA, `${sidA}_m`))?.内容).toBe(
      `${sidA} 记忆`
    );
    expect(await listNarrativeHistory(sidA)).toHaveLength(1);
  });

  it("删除分支只清理该分支，父会话与其它分支的记忆保留", async () => {
    const parentId = makeSessionId("parent");
    const branch1Id = makeSessionId("branch1");
    const branch2Id = makeSessionId("branch2");
    saveMixSession(makeSession(parentId));
    saveMixSession(
      makeSession(branch1Id, {
        parentId,
        rootId: parentId,
        forkTurnIndex: 1,
        depth: 1,
      })
    );
    saveMixSession(
      makeSession(branch2Id, {
        parentId,
        rootId: parentId,
        forkTurnIndex: 1,
        depth: 1,
      })
    );
    await seedNarrative(parentId);
    await seedNarrative(branch1Id);
    await seedNarrative(branch2Id);

    deleteMixSessionBranch(branch1Id);

    expect(getMixSession(branch1Id)).toBeNull();
    expect(getMixSession(parentId)?.id).toBe(parentId);
    expect(getMixSession(branch2Id)?.id).toBe(branch2Id);
    expect(kvKeysWithPrefix(`narrative:${branch1Id}:`)).toEqual([]);
    expect(kvKeysWithPrefix(`narrative:${parentId}:`)).toHaveLength(6);
    expect(kvKeysWithPrefix(`narrative:${branch2Id}:`)).toHaveLength(6);
    expect((await getMemoryCard(parentId, `${parentId}_m`))?.内容).toBe(
      `${parentId} 记忆`
    );
    expect((await getMemoryCard(branch2Id, `${branch2Id}_m`))?.内容).toBe(
      `${branch2Id} 记忆`
    );
  });

  it("删除不存在的会话 id 不报错，也不误删其他会话数据", async () => {
    const sidA = makeSessionId("a");
    saveMixSession(makeSession(sidA));
    await seedNarrative(sidA);
    const missing = makeSessionId("missing");

    expect(() => deleteMixSession(missing)).not.toThrow();
    expect(() => deleteMixSessionBranch(missing)).not.toThrow();

    expect(getMixSession(sidA)?.id).toBe(sidA);
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toHaveLength(6);
    expect((await getMemoryCard(sidA, `${sidA}_m`))?.内容).toBe(
      `${sidA} 记忆`
    );
    expect(kvKeysWithPrefix(`narrative:${missing}:`)).toEqual([]);
  });

  it("旧全局键、migration_state、legacy_backup 不被误删", async () => {
    const sidA = makeSessionId("a");
    saveMixSession(makeSession(sidA));
    await seedNarrative(sidA);

    const rawByKey = new Map<string, string>();
    const memoryKey = `narrative:memory:legacy_${makeCardId()}`;
    rawByKey.set(
      memoryKey,
      setGlobalRaw(memoryKey, makeMemory(makeCardId(), "旧全局记忆"))
    );
    const emotionKey = `narrative:emotion:legacy_${makeCardId()}`;
    rawByKey.set(
      emotionKey,
      setGlobalRaw(emotionKey, makeEmotion(makeCardId(), "旧全局情绪"))
    );
    const historyKey = `narrative:history:legacy_${makeCardId()}`;
    rawByKey.set(
      historyKey,
      setGlobalRaw(historyKey, makeHistory(makeCardId(), "legacy"))
    );
    rawByKey.set(
      "narrative:water_level",
      setGlobalRaw("narrative:water_level", {
        戏内层: createDefaultWaterLevel("戏内层"),
      })
    );
    rawByKey.set(
      "narrative:writer_state",
      setGlobalRaw(
        "narrative:writer_state",
        createDefaultWriterState("legacy")
      )
    );
    rawByKey.set(
      "narrative:context_hierarchy",
      setGlobalRaw("narrative:context_hierarchy", {
        L2_章节摘要: [],
        L3_全局大纲: "旧大纲",
        lastCompressedAt: 1,
        lastCompressedTurn: 1,
      })
    );
    rawByKey.set(
      BACKUP_KEY,
      setGlobalRaw(BACKUP_KEY, { createdAt: 1, entries: [] })
    );
    rawByKey.set(
      MIGRATION_STATE_KEY,
      setGlobalRaw(MIGRATION_STATE_KEY, {
        status: "deferred",
        at: 1,
      })
    );

    deleteMixSession(sidA);

    for (const [key, raw] of rawByKey) {
      expect(kvGet(key)).toBe(raw);
    }
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toEqual([]);
    expect(await getEmotionCard(sidA, `${sidA}_e`)).toBeNull();
    expect(await getWriterState(sidA)).toMatchObject({
      id: sidA,
      currentTurn: 0,
    });
    expect(await getContextHierarchy(sidA)).toBeNull();
    expect(await listNarrativeHistory(sidA)).toEqual([]);
  });

  it("线索卡与伏笔卡随会话删除一起清掉，别的会话不动", async () => {
    const sidA = makeSessionId("threads-a");
    const sidB = makeSessionId("threads-b");
    saveMixSession(makeSession(sidA));
    saveMixSession(makeSession(sidB));
    await seedNarrative(sidA);
    await seedNarrative(sidB);

    const threadId = `${sidB}_t`;
    const foreshadowId = `${sidB}_f`;
    await requirePurgeFn("saveThreadCard")(sidB, {
      id: threadId,
      kind: "thread",
      名称: "老桥下的硬币",
      线索状态: "潜伏",
      关联角色: [],
      上次推进轮次: 1,
      下一步可能: "去当铺问来路",
      最近变化: [],
      状态: "生效",
      audience: ["all"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await requirePurgeFn("saveForeshadowCard")(sidB, {
      id: foreshadowId,
      kind: "foreshadow",
      内容: "雨夜未接的电话",
      埋下轮次: 1,
      预期回收窗口: { 起: 3, 止: 6 },
      伏笔状态: "未收",
      状态: "生效",
      audience: ["all"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 键落在本会话命名空间里：narrative:{sid}:thread:{id} / :foreshadow:{id}
    expect(kvGet(`narrative:${sidB}:thread:${threadId}`)).not.toBeNull();
    expect(kvGet(`narrative:${sidB}:foreshadow:${foreshadowId}`)).not.toBeNull();
    expect(kvKeysWithPrefix(`narrative:${sidB}:`)).toHaveLength(8);
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toHaveLength(6);

    deleteMixSession(sidB);

    expect(getMixSession(sidB)).toBeNull();
    expect(kvKeysWithPrefix(`narrative:${sidB}:`)).toEqual([]);
    expect(kvGet(`narrative:${sidB}:thread:${threadId}`)).toBeNull();
    expect(kvGet(`narrative:${sidB}:foreshadow:${foreshadowId}`)).toBeNull();
    // A 场一张不少
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toHaveLength(6);
  });
});
