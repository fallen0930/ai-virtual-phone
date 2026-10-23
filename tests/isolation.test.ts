import { afterEach, describe, expect, it } from "vitest";
import { kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "@/lib/kv-db";
import {
  deleteMemoryCard,
  getContextHierarchy,
  getEmotionCard,
  getMemoryCard,
  getNarrativeHistoryEntry,
  getWaterLevelByScope,
  getWriterState,
  listEmotionCards,
  listMemoryCards,
  listNarrativeHistory,
  purgeNarrativeSessionData,
  requireSessionId,
  saveContextHierarchy,
  saveEmotionCard,
  saveMemoryCard,
  saveNarrativeHistoryEntry,
  saveWaterLevel,
  saveWriterState,
} from "@/lib/narrative-writer/storage";
import type {
  ContextHierarchy,
  EmotionCard,
  MemoryCard,
  NarrativeHistoryEntry,
} from "@/lib/narrative-writer/types";
import {
  createDefaultWaterLevel,
  createDefaultWriterState,
} from "@/lib/narrative-writer/types";

// 会话隔离测试：验证所有按会话存储的数据只在本会话可读，删一场不伤另一场。
//
// 环境说明：Node 下 `typeof window === "undefined"`，kv-db 的 hydrateKvDb() 被
// 短路，读全部来自进程内的内存缓存。“落盘后重读 / 刷新后仍在”没有被真正测到，
// 属于“未覆盖，需手动确认”；这里测的是命名空间隔离与清理边界本身。
//
// 每个用例使用本次运行内随机生成的会话 id，只清理自己写入的键；
// 不依赖网络、LLM 或真实浏览器存储（IndexedDB 由 fake-indexeddb 提供，进程结束即消失）。

const createdSessionIds = new Set<string>();
const createdGlobalKeys: string[] = [];

function makeSessionId(tag: string): string {
  const sid = `testiso_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  createdSessionIds.add(sid);
  return sid;
}

function makeCardId(): string {
  return `tcard_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

function makeHistory(id: string, output: string): NarrativeHistoryEntry {
  return {
    id,
    timestamp: Date.now(),
    mode: "direct",
    playerTendency: "靠近",
    output: { banner: "夜谈", body: output },
    sessionId: "spoofed_other_session",
    metadata: { beats: 2, isTurningPoint: false, directionAdjusted: false },
  };
}

afterEach(async () => {
  for (const sid of createdSessionIds) {
    purgeNarrativeSessionData(sid);
    // 只清理后立刻校验自己的命名空间为空，防止用例之间互相污染
    expect(kvKeysWithPrefix(`narrative:${sid}:`)).toEqual([]);
  }
  createdSessionIds.clear();

  for (const key of createdGlobalKeys) {
    kvRemove(key);
    expect(kvGet(key)).toBeNull();
  }
  createdGlobalKeys.length = 0;

  // 让 kvRemove 的 fire-and-forget IndexedDB 删除落定
  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe("isolation: 执笔数据按会话隔离", () => {
  it("同一张卡 id 在两场各自成立，读取与删除都只作用于本场", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    const cardId = makeCardId();

    await saveMemoryCard(sidA, makeMemory(cardId, "A 场：图书馆初见"));
    await saveMemoryCard(sidB, makeMemory(cardId, "B 场：天台夜谈"));

    const cardsA = await listMemoryCards(sidA);
    const cardsB = await listMemoryCards(sidB);
    expect(cardsA.map((c) => c.内容)).toEqual(["A 场：图书馆初见"]);
    expect(cardsB.map((c) => c.内容)).toEqual(["B 场：天台夜谈"]);

    expect((await getMemoryCard(sidA, cardId))?.内容).toBe("A 场：图书馆初见");
    expect((await getMemoryCard(sidB, cardId))?.内容).toBe("B 场：天台夜谈");

    // 原始键必须落在各自的会话段下
    expect(kvKeysWithPrefix(`narrative:${sidA}:memory:`)).toEqual([
      `narrative:${sidA}:memory:${cardId}`,
    ]);
    expect(kvKeysWithPrefix(`narrative:${sidB}:memory:`)).toEqual([
      `narrative:${sidB}:memory:${cardId}`,
    ]);

    // 删 A 的同 id 卡，不能把 B 的删掉
    await deleteMemoryCard(sidA, cardId);
    expect(await listMemoryCards(sidA)).toEqual([]);
    expect((await getMemoryCard(sidB, cardId))?.内容).toBe("B 场：天台夜谈");
  });

  it("情感卡、水位、执笔状态、层级、历史同样不跨场", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    const emotionId = makeCardId();
    const historyId = makeCardId();

    await saveEmotionCard(sidA, makeEmotion(emotionId, "A 场：她笑了一下"));
    expect(await listEmotionCards(sidB)).toEqual([]);
    expect(await getEmotionCard(sidB, emotionId)).toBeNull();
    expect((await getEmotionCard(sidA, emotionId))?.证据).toBe(
      "A 场：她笑了一下"
    );

    const waterA = { ...createDefaultWaterLevel("戏内层"), 水位: "L3" as const };
    await saveWaterLevel(sidA, waterA);
    expect((await getWaterLevelByScope(sidA, "戏内层")).水位).toBe("L3");
    expect((await getWaterLevelByScope(sidB, "戏内层")).水位).toBe("L0");

    await saveWriterState(sidA, {
      ...createDefaultWriterState(sidA),
      currentTurn: 9,
      当前弧光: "A 场的弧光",
    });
    const stateB = await getWriterState(sidB);
    expect(stateB.currentTurn).toBe(0);
    expect(stateB.当前弧光).toBe("");
    expect(stateB.id).toBe(sidB);
    expect((await getWriterState(sidA)).id).toBe(sidA);

    const hierarchyA: ContextHierarchy = {
      L2_章节摘要: [],
      L3_全局大纲: "A 场专属大纲",
      lastCompressedAt: 1,
      lastCompressedTurn: 2,
    };
    await saveContextHierarchy(sidA, hierarchyA);
    expect(await getContextHierarchy(sidB)).toBeNull();

    // 条目自带的 sessionId 是伪造的，存储层必须按传入会话盖章
    await saveNarrativeHistoryEntry(sidA, makeHistory(historyId, "A 场输出"));
    expect(await listNarrativeHistory(sidB)).toEqual([]);
    expect(await getNarrativeHistoryEntry(sidB, historyId)).toBeNull();
    const historyA = await listNarrativeHistory(sidA);
    expect(historyA).toHaveLength(1);
    expect(historyA[0].sessionId).toBe(sidA);
    expect(historyA[0].output.body).toBe("A 场输出");
  });

  it("purge 只清本会话，不碰另一场，也不碰旧全局键", async () => {
    const sidA = makeSessionId("a");
    const sidB = makeSessionId("b");
    const legacyKey = `narrative:memory:testiso_legacy_${Date.now().toString(
      36
    )}_${Math.random().toString(36).slice(2, 8)}`;
    kvSet(legacyKey, JSON.stringify(makeMemory(makeCardId(), "旧全局数据")));
    createdGlobalKeys.push(legacyKey);

    const cardId = makeCardId();
    const emotionId = makeCardId();
    const historyId = makeCardId();
    for (const sid of [sidA, sidB]) {
      await saveMemoryCard(sid, makeMemory(cardId, `${sid} 的记忆`));
      await saveEmotionCard(sid, makeEmotion(emotionId, `${sid} 的情绪`));
      await saveWaterLevel(sid, createDefaultWaterLevel("戏内层"));
      await saveWriterState(sid, createDefaultWriterState(sid));
      await saveContextHierarchy(sid, {
        L2_章节摘要: [],
        L3_全局大纲: `${sid} 的大纲`,
        lastCompressedAt: 0,
        lastCompressedTurn: 0,
      });
      await saveNarrativeHistoryEntry(sid, makeHistory(historyId, `${sid} 的输出`));
    }

    const keysA = kvKeysWithPrefix(`narrative:${sidA}:`).sort();
    expect(keysA).toEqual(
      [
        `narrative:${sidA}:emotion:${emotionId}`,
        `narrative:${sidA}:hierarchy`,
        `narrative:${sidA}:history:${historyId}`,
        `narrative:${sidA}:memory:${cardId}`,
        `narrative:${sidA}:water`,
        `narrative:${sidA}:writer_state`,
      ].sort()
    );

    expect(purgeNarrativeSessionData(sidA)).toBe(6);
    expect(kvKeysWithPrefix(`narrative:${sidA}:`)).toEqual([]);

    // B 的六类数据都还在
    expect((await getMemoryCard(sidB, cardId))?.内容).toBe(`${sidB} 的记忆`);
    expect((await getEmotionCard(sidB, emotionId))?.证据).toBe(`${sidB} 的情绪`);
    expect((await getWriterState(sidB)).id).toBe(sidB);
    expect((await getContextHierarchy(sidB))?.L3_全局大纲).toBe(`${sidB} 的大纲`);
    expect(await listNarrativeHistory(sidB)).toHaveLength(1);
    expect(kvKeysWithPrefix(`narrative:${sidB}:`)).toHaveLength(6);

    // 旧全局键不属于任何一场，purge 不得触碰
    expect(kvGet(legacyKey)).not.toBeNull();
  });

  it("空 sessionId 一律拒绝，不退回全局读取", async () => {
    expect(() => requireSessionId("", "test")).toThrow(/sessionId/);
    expect(() => requireSessionId("   ", "test")).toThrow(/sessionId/);
    expect(() => requireSessionId(null, "test")).toThrow(/sessionId/);
    expect(() => purgeNarrativeSessionData("")).toThrow(/sessionId/);

    await expect(listMemoryCards("")).rejects.toThrow(/sessionId/);
    await expect(listEmotionCards(null)).rejects.toThrow(/sessionId/);
    await expect(getWriterState(undefined)).rejects.toThrow(/sessionId/);
    await expect(
      saveMemoryCard("   ", makeMemory(makeCardId(), "不应写入"))
    ).rejects.toThrow(/sessionId/);
  });
});
