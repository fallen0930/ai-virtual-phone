import { afterEach, describe, expect, it, vi } from "vitest";
import { kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "@/lib/kv-db";
import {
  backupLegacyNarrativeData,
  deferLegacyMigration,
  exportAllNarrativeDataForMigration,
  getMigrationState,
  hasLegacyNarrativeData,
  listMemoryCards,
  listNarrativeHistory,
  migrateLegacyToSession,
  purgeNarrativeSessionData,
  readLegacyNarrativeBackup,
} from "@/lib/narrative-writer/storage";
import type {
  EmotionCard,
  MemoryCard,
  NarrativeHistoryEntry,
} from "@/lib/narrative-writer/types";
import { createDefaultWriterState } from "@/lib/narrative-writer/types";

// 旧全局数据迁移测试。
//
// 环境说明：Node 下 hydrateKvDb() 被短路，读全部来自进程内内存缓存；
// “落盘后重读 / 刷新后仍在”属于“未覆盖，需手动确认”。
// 这里测的是备份、复制、幂等、历史归属、稍后状态与拒绝空会话。
//
// 备份失败通过测试内的 vi.mock 注入一次 kvSetAsync 抛错，不改生产代码。
// 所有用例使用随机会话 id，只清理自己写入的全局键与目标会话。

const failNextSet = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/kv-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kv-db")>();
  return {
    ...actual,
    kvSetAsync: async (key: string, value: string) => {
      if (failNextSet.value) {
        failNextSet.value = false;
        throw new Error("注入：备份写入失败");
      }
      return actual.kvSetAsync(key, value);
    },
  };
});

const BACKUP_KEY = "narrative:legacy_backup_v1";
const MIGRATION_STATE_KEY = "narrative:migration_state_v1";

const createdSessionIds = new Set<string>();
const createdGlobalKeys = new Set<string>();

function makeSessionId(tag: string): string {
  const sid = `testmig_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  createdSessionIds.add(sid);
  return sid;
}

function makeCardId(): string {
  return `tmig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

function makeHistory(
  id: string,
  output: string,
  sessionId?: string
): NarrativeHistoryEntry {
  const entry: NarrativeHistoryEntry = {
    id,
    timestamp: Date.now(),
    mode: "direct",
    playerTendency: "靠近",
    output: { banner: "夜谈", body: output },
    sessionId: sessionId ?? "placeholder",
    metadata: { beats: 2, isTurningPoint: false, directionAdjusted: false },
  };
  if (!sessionId) {
    delete (entry as Partial<NarrativeHistoryEntry>).sessionId;
  }
  return entry;
}

/** 写一条旧全局键，记录原始字符串用于“原样保留”断言与清理 */
function setLegacyRaw(key: string, value: unknown): string {
  const raw = JSON.stringify(value);
  kvSet(key, raw);
  createdGlobalKeys.add(key);
  return raw;
}

afterEach(async () => {
  failNextSet.value = false;
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
  expect(kvGet(BACKUP_KEY)).toBeNull();
  expect(kvGet(MIGRATION_STATE_KEY)).toBeNull();

  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe("migration: 旧全局执笔数据备份与归属", () => {
  it("迁移前先备份并写入已迁移标记；归属给 A 后 B 看不到", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    const card = makeMemory(makeCardId(), "旧全局：图书馆初见");
    const memoryKey = `narrative:memory:${card.id}`;
    const raw = setLegacyRaw(memoryKey, card);

    const state = await migrateLegacyToSession(sidA);
    expect(state.status).toBe("done");
    expect(state.chosenSessionId).toBe(sidA);
    expect(state.counts).toMatchObject({ memories: 1, skippedDuplicates: 0 });

    const backup = await readLegacyNarrativeBackup();
    expect(backup).not.toBeNull();
    // 实际备份里带 source，但 readLegacyNarrativeBackup 的返回类型没声明它，测试内窄化读取
    expect((backup as { source?: string }).source).toBe("global-narrative-keys");
    expect(backup?.entries.find((e) => e.key === memoryKey)?.value).toBe(raw);

    const saved = await getMigrationState();
    expect(saved?.status).toBe("done");
    expect(saved?.chosenSessionId).toBe(sidA);
    expect(saved?.backedUpAt).toBeTypeOf("number");

    expect((await listMemoryCards(sidA)).map((c) => c.id)).toEqual([card.id]);
    expect(await listMemoryCards(sidB)).toEqual([]);
    expect(kvGet(memoryKey)).toBe(raw);
  });

  it("备份失败时迁移不执行，旧数据原样保留且不写标记", async () => {
    const sidA = makeSessionId("a");
    const card = makeMemory(makeCardId(), "备份失败也不能丢");
    const memoryKey = `narrative:memory:${card.id}`;
    const raw = setLegacyRaw(memoryKey, card);

    failNextSet.value = true;
    await expect(migrateLegacyToSession(sidA)).rejects.toThrow(
      "注入：备份写入失败"
    );

    expect(kvGet(memoryKey)).toBe(raw);
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toEqual([]);
    expect(kvGet(BACKUP_KEY)).toBeNull();
    expect(await getMigrationState()).toBeNull();
  });

  it("只复制不删除：迁移后所有旧全局键仍原样存在", async () => {
    const sidA = makeSessionId("a");
    const card = makeMemory(makeCardId(), "旧记忆");
    const emotion = makeEmotion(makeCardId(), "旧情绪");
    const history = makeHistory(makeCardId(), "旧历史");
    const water = {
      戏内层: {
        作用域: "戏内层",
        水位: "L2",
        status: "active",
        准入证据: [],
        未解决冲突: [],
        冻结项: [],
        最后更新: "2026-01-01T00:00:00.000Z",
      },
    };
    const writerState = { ...createDefaultWriterState("legacy"), currentTurn: 7 };
    const hierarchy = {
      L2_章节摘要: [
        { turnRange: [1, 2] as [number, number], summary: "旧摘要", createdAt: 1 },
      ],
      L3_全局大纲: "旧大纲",
      lastCompressedAt: 1,
      lastCompressedTurn: 3,
    };

    const rawByKey = new Map<string, string>();
    rawByKey.set(
      `narrative:memory:${card.id}`,
      setLegacyRaw(`narrative:memory:${card.id}`, card)
    );
    rawByKey.set(
      `narrative:emotion:${emotion.id}`,
      setLegacyRaw(`narrative:emotion:${emotion.id}`, emotion)
    );
    rawByKey.set(
      `narrative:history:${history.id}`,
      setLegacyRaw(`narrative:history:${history.id}`, history)
    );
    rawByKey.set(
      "narrative:water_level",
      setLegacyRaw("narrative:water_level", water)
    );
    rawByKey.set(
      "narrative:writer_state",
      setLegacyRaw("narrative:writer_state", writerState)
    );
    rawByKey.set(
      "narrative:context_hierarchy",
      setLegacyRaw("narrative:context_hierarchy", hierarchy)
    );

    const state = await migrateLegacyToSession(sidA);
    expect(state.counts).toMatchObject({ memories: 1, emotions: 1, history: 1 });

    for (const [key, raw] of rawByKey) {
      expect(kvGet(key)).toBe(raw);
    }
    expect(kvGet(BACKUP_KEY)).not.toBeNull();

    expect(await listMemoryCards(sidA)).toHaveLength(1);
    expect((await exportAllNarrativeDataForMigration(sidA)).emotions).toHaveLength(
      1
    );
    expect((await getMigrationState())?.status).toBe("done");
  });

  it("幂等：连续迁移两次不重复，计数正确", async () => {
    const sidA = makeSessionId("a");
    const card = makeMemory(makeCardId(), "只应有一份");
    const emotion = makeEmotion(makeCardId(), "只应有一份情绪");
    const history = makeHistory(makeCardId(), "只应有一份历史");
    setLegacyRaw(`narrative:memory:${card.id}`, card);
    setLegacyRaw(`narrative:emotion:${emotion.id}`, emotion);
    setLegacyRaw(`narrative:history:${history.id}`, history);

    const first = await migrateLegacyToSession(sidA);
    expect(first.counts).toMatchObject({
      memories: 1,
      emotions: 1,
      history: 1,
      skippedDuplicates: 0,
    });

    const second = await migrateLegacyToSession(sidA);
    expect(second.counts).toMatchObject({
      memories: 0,
      emotions: 0,
      history: 0,
      skippedDuplicates: 3,
    });
    expect((await getMigrationState())?.status).toBe("done");

    expect(await listMemoryCards(sidA)).toHaveLength(1);
    expect((await exportAllNarrativeDataForMigration(sidA)).emotions).toHaveLength(
      1
    );
    expect(await listNarrativeHistory(sidA)).toHaveLength(1);
    expect(kvKeysWithPrefix(`narrative:${sidA}:memory:`)).toHaveLength(1);
    expect(kvKeysWithPrefix(`narrative:${sidA}:emotion:`)).toHaveLength(1);
    expect(kvKeysWithPrefix(`narrative:${sidA}:history:`)).toHaveLength(1);
  });

  it("history 按条目自带 sessionId 归属，没有 sessionId 的才进选中会话", async () => {
    const sidA = makeSessionId("a");
    const sidOther = makeSessionId("other");
    const ownHistory = makeHistory(makeCardId(), "本场历史", sidOther);
    const orphanHistory = makeHistory(makeCardId(), "无归属旧历史");

    setLegacyRaw(`narrative:history:${ownHistory.id}`, ownHistory);
    setLegacyRaw(`narrative:history:${orphanHistory.id}`, orphanHistory);

    const state = await migrateLegacyToSession(sidA);
    expect(state.counts).toMatchObject({ history: 2, skippedDuplicates: 0 });

    const historyA = await listNarrativeHistory(sidA);
    expect(historyA.map((e) => e.id)).toEqual([orphanHistory.id]);
    expect(historyA[0].sessionId).toBe(sidA);

    const historyOther = await listNarrativeHistory(sidOther);
    expect(historyOther.map((e) => e.id)).toEqual([ownHistory.id]);
    expect(historyOther[0].sessionId).toBe(sidOther);
    expect(kvKeysWithPrefix(`narrative:${sidA}:history:`)).toHaveLength(1);
    expect(kvKeysWithPrefix(`narrative:${sidOther}:history:`)).toHaveLength(1);
  });

  it("稍后：旧数据对任何会话不可见，也不参与读取", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    const card = makeMemory(makeCardId(), "暂不归属的旧记忆");
    const memoryKey = `narrative:memory:${card.id}`;
    setLegacyRaw(memoryKey, card);

    const state = await deferLegacyMigration();
    expect(state.status).toBe("deferred");
    expect(kvGet(memoryKey)).not.toBeNull();
    expect(await hasLegacyNarrativeData()).toBe(true);

    expect(await listMemoryCards(sidA)).toEqual([]);
    expect(await listMemoryCards(sidB)).toEqual([]);
    expect((await exportAllNarrativeDataForMigration(sidA)).memories).toEqual([]);
    expect((await getMigrationState())?.status).toBe("deferred");
    expect(kvGet(BACKUP_KEY)).not.toBeNull();
  });

  it("空 sessionId 拒绝迁移，且不写备份、不写标记、不动旧数据", async () => {
    const card = makeMemory(makeCardId(), "不能失去归属");
    const memoryKey = `narrative:memory:${card.id}`;
    const raw = setLegacyRaw(memoryKey, card);

    await expect(migrateLegacyToSession("")).rejects.toThrow(/sessionId/);
    await expect(migrateLegacyToSession("   ")).rejects.toThrow(/sessionId/);
    await expect(migrateLegacyToSession(null)).rejects.toThrow(/sessionId/);

    expect(kvGet(memoryKey)).toBe(raw);
    expect(kvGet(BACKUP_KEY)).toBeNull();
    expect(await getMigrationState()).toBeNull();
  });

  it("备份已存在时不覆盖首次快照", async () => {
    const card = makeMemory(makeCardId(), "第一次快照");
    setLegacyRaw(`narrative:memory:${card.id}`, card);

    const first = await backupLegacyNarrativeData();
    expect(first.alreadyBackedUp).toBe(false);
    const rawAfterFirst = kvGet(BACKUP_KEY);

    const card2 = makeMemory(makeCardId(), "第二次才出现的记忆");
    setLegacyRaw(`narrative:memory:${card2.id}`, card2);
    const second = await backupLegacyNarrativeData();
    expect(second).toMatchObject({ entries: 0, alreadyBackedUp: true });
    expect(kvGet(BACKUP_KEY)).toBe(rawAfterFirst);
  });
});
