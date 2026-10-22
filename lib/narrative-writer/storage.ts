// lib/narrative-writer/storage.ts
// 执笔插件 · 数据持久化层（基于 kv-db / IndexedDB）
//
// 存储组织：
// - memory:narrative:memory:{id} → MemoryCard
// - memory:narrative:emotion:{id} → EmotionCard
// - memory:narrative:water_level → Record<scope, WaterLevelState>
// - memory:narrative:writer_state → NarrativeWriterState

import { kvGet, kvSetAsync, kvRemove, kvKeysWithPrefix } from "@/lib/kv-db";
import type {
  MemoryCard,
  EmotionCard,
  WaterLevelState,
  NarrativeWriterState,
  ContextHierarchy,
  NarrativeHistoryEntry,
  ExtractionRules,
} from "./types";
import {
  createDefaultWaterLevel,
  createDefaultWriterState,
  createDefaultExtractionRules,
} from "./types";

const MEMORY_PREFIX = "narrative:memory:";
const EMOTION_PREFIX = "narrative:emotion:";
const WATER_LEVEL_KEY = "narrative:water_level";
const WRITER_STATE_KEY = "narrative:writer_state";
const CONTEXT_HIERARCHY_KEY = "narrative:context_hierarchy";
const HISTORY_PREFIX = "narrative:history:";
const EXTRACTION_RULES_KEY = "narrative:extraction_rules";

// ── JSON 序列化读写 ──
// kv-db 是同步字符串 API（kvGet 返回 string | null，kvSet 只收 string），
// 执笔的数据全是对象，必须统一走 JSON 序列化，否则存取全部失效。

async function nwGet<T>(key: string): Promise<T | null> {
  const raw = kvGet(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as unknown as T; // 容错：历史脏数据可能直接存了对象
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function nwSet(key: string, value: unknown): Promise<void> {
  await kvSetAsync(key, JSON.stringify(value));
}

// ==================== Memory Cards ====================

export async function saveMemoryCard(card: MemoryCard): Promise<void> {
  await nwSet(`${MEMORY_PREFIX}${card.id}`, card);
}

export async function getMemoryCard(id: string): Promise<MemoryCard | null> {
  return nwGet<MemoryCard>(`${MEMORY_PREFIX}${id}`);
}

export async function deleteMemoryCard(id: string): Promise<void> {
  kvRemove(`${MEMORY_PREFIX}${id}`);
}

export async function listMemoryCards(opts?: {
  status?: string;
  主类型?: string;
  主体?: string;
}): Promise<MemoryCard[]> {
  const keys = await kvKeysWithPrefix(MEMORY_PREFIX);
  const cards: MemoryCard[] = [];

  for (const key of keys) {
    const card = await nwGet<MemoryCard>(key);
    if (!card) continue;

    if (opts?.status && card.状态 !== opts.status) continue;
    if (opts?.主类型 && card.主类型 !== opts.主类型) continue;
    if (opts?.主体 && card.主体 !== opts.主体) continue;

    cards.push(card);
  }

  // 按更新时间降序
  return cards.sort((a, b) => b.updatedAt - a.updatedAt);
}

// 别名导出，保持API一致性
export const getMemoryCards = listMemoryCards;

export async function updateMemoryCardStatus(
  id: string,
  newStatus: MemoryCard["状态"]
): Promise<void> {
  const card = await getMemoryCard(id);
  if (!card) return;

  card.状态 = newStatus;
  card.updatedAt = Date.now();
  await saveMemoryCard(card);
}

// ==================== Emotion Cards ====================

export async function saveEmotionCard(card: EmotionCard): Promise<void> {
  await nwSet(`${EMOTION_PREFIX}${card.id}`, card);
}

export async function getEmotionCard(id: string): Promise<EmotionCard | null> {
  return nwGet<EmotionCard>(`${EMOTION_PREFIX}${id}`);
}

export async function deleteEmotionCard(id: string): Promise<void> {
  kvRemove(`${EMOTION_PREFIX}${id}`);
}

export async function listEmotionCards(opts?: {
  status?: string;
  类别?: string;
  主体?: string;
}): Promise<EmotionCard[]> {
  const keys = await kvKeysWithPrefix(EMOTION_PREFIX);
  const cards: EmotionCard[] = [];

  for (const key of keys) {
    const card = await nwGet<EmotionCard>(key);
    if (!card) continue;

    if (opts?.status && card.状态 !== opts.status) continue;
    if (opts?.类别 && card.类别 !== opts.类别) continue;
    if (opts?.主体 && card.主体 !== opts.主体) continue;

    cards.push(card);
  }

  return cards.sort((a, b) => b.updatedAt - a.updatedAt);
}

// 别名导出，保持API一致性
export const getEmotionCards = listEmotionCards;

// ==================== Water Levels ====================

export async function saveWaterLevel(water: WaterLevelState): Promise<void> {
  const existing =
    (await nwGet<Record<string, WaterLevelState>>(WATER_LEVEL_KEY)) || {};
  existing[water.作用域] = water;
  await nwSet(WATER_LEVEL_KEY, existing);
}

export async function getWaterLevels(): Promise<
  Record<"戏内层" | "现实层" | "共识层", WaterLevelState>
> {
  const existing =
    (await nwGet<Record<string, WaterLevelState>>(WATER_LEVEL_KEY)) || {};

  // 确保三个作用域都有默认值
  const defaults = {
    戏内层: createDefaultWaterLevel("戏内层"),
    现实层: createDefaultWaterLevel("现实层"),
    共识层: createDefaultWaterLevel("共识层"),
  };

  return {
    ...defaults,
    ...existing,
  };
}

export async function getWaterLevelByScope(
  scope: "戏内层" | "现实层" | "共识层"
): Promise<WaterLevelState> {
  const levels = await getWaterLevels();
  return levels[scope];
}

// ==================== Writer State ====================

export async function saveWriterState(
  state: NarrativeWriterState
): Promise<void> {
  await nwSet(WRITER_STATE_KEY, state);
}

export async function getWriterState(): Promise<NarrativeWriterState | null> {
  const state = await nwGet<NarrativeWriterState>(WRITER_STATE_KEY);
  return state || null;
}

export async function getOrCreateWriterState(): Promise<NarrativeWriterState> {
  const state = await getWriterState();
  if (state) return state;

  const defaultState = createDefaultWriterState();
  await saveWriterState(defaultState);
  return defaultState;
}

// ==================== Batch Operations ====================

/** 批量删除记忆卡（用于用户清理） */
export async function batchDeleteMemoryCards(ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteMemoryCard(id);
  }
}

/** 批量删除情感卡 */
export async function batchDeleteEmotionCards(ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteEmotionCard(id);
  }
}

/** 导出所有数据（用于备份） */
export async function exportAllNarrativeData(): Promise<{
  memories: MemoryCard[];
  emotions: EmotionCard[];
  waterLevels: Record<string, WaterLevelState>;
  writerState: NarrativeWriterState | null;
}> {
  const memories = await listMemoryCards();
  const emotions = await listEmotionCards();
  const waterLevels = await getWaterLevels();
  const writerState = await getWriterState();

  return { memories, emotions, waterLevels, writerState };
}

// ==================== Context Hierarchy (L2/L3) ====================

export async function saveContextHierarchy(
  hierarchy: ContextHierarchy
): Promise<void> {
  await nwSet(CONTEXT_HIERARCHY_KEY, hierarchy);
}

export async function getContextHierarchy(): Promise<ContextHierarchy | null> {
  return nwGet<ContextHierarchy>(CONTEXT_HIERARCHY_KEY);
}

export async function getOrCreateContextHierarchy(): Promise<ContextHierarchy> {
  const existing = await getContextHierarchy();
  if (existing) return existing;

  const defaultHierarchy: ContextHierarchy = {
    L2_章节摘要: [],
    L3_全局大纲: "",
    lastCompressedAt: 0,
  };
  await saveContextHierarchy(defaultHierarchy);
  return defaultHierarchy;
}

// ==================== Narrative History ====================

export async function saveNarrativeHistoryEntry(
  entry: NarrativeHistoryEntry
): Promise<void> {
  await nwSet(`${HISTORY_PREFIX}${entry.id}`, entry);
}

export async function getNarrativeHistoryEntry(
  id: string
): Promise<NarrativeHistoryEntry | null> {
  return nwGet<NarrativeHistoryEntry>(`${HISTORY_PREFIX}${id}`);
}

export async function deleteNarrativeHistoryEntry(id: string): Promise<void> {
  kvRemove(`${HISTORY_PREFIX}${id}`);
}

export async function listNarrativeHistory(opts?: {
  sessionId?: string;
  mode?: "direct" | "select";
  limit?: number;
}): Promise<NarrativeHistoryEntry[]> {
  const keys = await kvKeysWithPrefix(HISTORY_PREFIX);
  const entries: NarrativeHistoryEntry[] = [];

  for (const key of keys) {
    const entry = await nwGet<NarrativeHistoryEntry>(key);
    if (!entry) continue;

    if (opts?.sessionId && entry.sessionId !== opts.sessionId) continue;
    if (opts?.mode && entry.mode !== opts.mode) continue;

    entries.push(entry);
  }

  // 按时间倒序
  entries.sort((a, b) => b.timestamp - a.timestamp);

  const limit = opts?.limit ?? 50;
  return entries.slice(0, limit);
}

// ==================== Extraction Rules ====================

export async function saveExtractionRules(rules: ExtractionRules): Promise<void> {
  await nwSet(EXTRACTION_RULES_KEY, rules);
}

export async function getExtractionRules(): Promise<ExtractionRules> {
  const rules = await nwGet<ExtractionRules>(EXTRACTION_RULES_KEY);
  return rules || createDefaultExtractionRules();
}

export async function resetExtractionRules(): Promise<void> {
  await saveExtractionRules(createDefaultExtractionRules());
}

// ==================== Card Management Helpers ====================

/** 归档记忆卡（不删除，只改状态） */
export async function archiveMemoryCard(id: string): Promise<void> {
  const card = await getMemoryCard(id);
  if (!card) return;

  card.状态 = "归档";
  card.updatedAt = Date.now();
  await saveMemoryCard(card);
}

/** 归档情感卡 */
export async function archiveEmotionCard(id: string): Promise<void> {
  const card = await getEmotionCard(id);
  if (!card) return;

  card.状态 = "归档";
  card.updatedAt = Date.now();
  await saveEmotionCard(card);
}

/** 更新记忆卡字段 */
export async function updateMemoryCard(
  id: string,
  updates: Partial<Omit<MemoryCard, "id" | "kind" | "createdAt">>
): Promise<void> {
  const card = await getMemoryCard(id);
  if (!card) return;

  Object.assign(card, updates);
  card.updatedAt = Date.now();
  await saveMemoryCard(card);
}

/** 更新情感卡字段 */
export async function updateEmotionCard(
  id: string,
  updates: Partial<Omit<EmotionCard, "id" | "kind" | "createdAt">>
): Promise<void> {
  const card = await getEmotionCard(id);
  if (!card) return;

  Object.assign(card, updates);
  card.updatedAt = Date.now();
  await saveEmotionCard(card);
}

/** 批量归档记忆卡 */
export async function batchArchiveMemoryCards(ids: string[]): Promise<void> {
  for (const id of ids) {
    await archiveMemoryCard(id);
  }
}

/** 批量归档情感卡 */
export async function batchArchiveEmotionCards(ids: string[]): Promise<void> {
  for (const id of ids) {
    await archiveEmotionCard(id);
  }
}
