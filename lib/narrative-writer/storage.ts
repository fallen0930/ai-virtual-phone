// lib/narrative-writer/storage.ts
// 执笔插件 · 数据持久化层（基于 kv-db / IndexedDB）
//
// 存储组织（按会话隔离）：
// - narrative:{sessionId}:memory:{id}          → MemoryCard
// - narrative:{sessionId}:emotion:{id}         → EmotionCard
// - narrative:{sessionId}:water                → Record<作用域, WaterLevelState>
// - narrative:{sessionId}:writer_state         → NarrativeWriterState
// - narrative:{sessionId}:hierarchy            → ContextHierarchy
// - narrative:{sessionId}:history:{id}         → NarrativeHistoryEntry
// - narrative:extraction_rules                 → ExtractionRules（规则，全局共用）
// - narrative:legacy_backup_v1                 → 旧全局数据整包备份（迁移前写入）
// - narrative:migration_state_v1               → 迁移状态（pending / done / deferred）
//
// 为什么隔离：记忆卡、情感卡、水位、执笔状态、整理结果讲的都是"这一场剧情里发生的事"。
// 过去它们全挤在无前缀的全局键里，A 对局抽出的卡会原样出现在 B 对局的连续性上下文中，
// currentTurn 也被两场来回覆盖。现在所有读写一律必须带 sessionId。
//
// 为什么不放 sessionId 到键的中间段（narrative:{sessionId}:memory:）而不是末尾：
// kvKeysWithPrefix 是对内存 Map 的线性 startsWith 扫描（kv-db.ts:247），复杂度只跟
// 总键条数有关、跟键名怎么分段无关，所以这个布局不损性能；而会话段在前能让
// "列出本会话全部卡"和"删除本会话全部数据"都用一次前缀扫描完成，
// 也天然保证任何读取入口都绕不开 sessionId。

import { kvGet, kvSet, kvSetAsync, kvRemove, kvKeysWithPrefix } from "@/lib/kv-db";
// 来源检查要读对局的当前消息列表。这里构成 storage ↔ mixology/storage 的模块环
// （mixology/storage 为了删对局时清理执笔数据，早就 import 了本模块）。
// 两边的调用都只发生在函数体里，ESM 的函数声明在链接阶段就已就绪，
// 模块求值顺序不会让 getMixSession 变成 undefined——但别再往这两个模块的顶层加互相调用的逻辑。
import { getMixSession } from "@/lib/mixology/storage";
import type {
  MemoryCard,
  EmotionCard,
  WaterLevelState,
  NarrativeWriterState,
  ContextHierarchy,
  NarrativeHistoryEntry,
  ExtractionRules,
  NarrativeMigrationState,
  NarrativeLegacyBackupEntry,
} from "./types";
import {
  createDefaultWaterLevel,
  createDefaultWriterState,
  createDefaultExtractionRules,
} from "./types";

// ==================== 键名 ====================

/** 会话内数据的前缀工厂 */
function sessionRoot(sessionId: string): string {
  return `narrative:${sessionId}:`;
}
function memoryPrefix(sessionId: string): string {
  return `${sessionRoot(sessionId)}memory:`;
}
function emotionPrefix(sessionId: string): string {
  return `${sessionRoot(sessionId)}emotion:`;
}
function historyPrefix(sessionId: string): string {
  return `${sessionRoot(sessionId)}history:`;
}
function waterKey(sessionId: string): string {
  return `${sessionRoot(sessionId)}water`;
}
function writerStateKey(sessionId: string): string {
  return `${sessionRoot(sessionId)}writer_state`;
}
function hierarchyKey(sessionId: string): string {
  return `${sessionRoot(sessionId)}hierarchy`;
}

/** 规则类数据：外围参数与开关，不含任何剧情内容，保持全局共用 */
const EXTRACTION_RULES_KEY = "narrative:extraction_rules";

/** 旧版全局键（键名里没有 sessionId）。只允许迁移与备份代码触碰。 */
const LEGACY = {
  memoryPrefix: "narrative:memory:",
  emotionPrefix: "narrative:emotion:",
  historyPrefix: "narrative:history:",
  water: "narrative:water_level",
  writerState: "narrative:writer_state",
  hierarchy: "narrative:context_hierarchy",
} as const;

const LEGACY_BACKUP_KEY = "narrative:legacy_backup_v1";
const MIGRATION_STATE_KEY = "narrative:migration_state_v1";

/**
 * 会话 id 校验。
 * 这一层是"不允许存在不带 sessionId 就能读到全部"的入口的守门人：
 * 漏传一律直接抛错，绝不悄悄退回全局读取——退回全局等于把串数据的坑
 * 重新挖回来，而且比崩溃更难发现。
 */
export function requireSessionId(
  sessionId: string | null | undefined,
  caller: string
): string {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!trimmed) {
    throw new Error(
      `[NarrativeWriter] ${caller} 缺少 sessionId：拒绝读写，避免跨会话串数据。`
    );
  }
  return trimmed;
}

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

/** 轮次字段归一化：必须是有限非负整数。
 *  缺失值参与减法会得到 NaN，NaN 做阈值比较永远为 false，抽取会被永久跳过（且不报错）。 */
function normalizeTurn(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ==================== Memory Cards ====================

export async function saveMemoryCard(
  sessionId: string | null | undefined,
  card: MemoryCard
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveMemoryCard");
  await nwSet(`${memoryPrefix(sid)}${card.id}`, card);
}

export async function getMemoryCard(
  sessionId: string | null | undefined,
  id: string
): Promise<MemoryCard | null> {
  const sid = requireSessionId(sessionId, "getMemoryCard");
  return nwGet<MemoryCard>(`${memoryPrefix(sid)}${id}`);
}

export async function deleteMemoryCard(
  sessionId: string | null | undefined,
  id: string
): Promise<void> {
  const sid = requireSessionId(sessionId, "deleteMemoryCard");
  kvRemove(`${memoryPrefix(sid)}${id}`);
}

export async function listMemoryCards(
  sessionId: string | null | undefined,
  opts?: {
    status?: string;
    主类型?: string;
    主体?: string;
  }
): Promise<MemoryCard[]> {
  const sid = requireSessionId(sessionId, "listMemoryCards");
  const keys = await kvKeysWithPrefix(memoryPrefix(sid));
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
  sessionId: string | null | undefined,
  id: string,
  newStatus: MemoryCard["状态"]
): Promise<void> {
  const sid = requireSessionId(sessionId, "updateMemoryCardStatus");
  const card = await getMemoryCard(sid, id);
  if (!card) return;

  card.状态 = newStatus;
  card.updatedAt = Date.now();
  await saveMemoryCard(sid, card);
}

// ==================== Emotion Cards ====================

export async function saveEmotionCard(
  sessionId: string | null | undefined,
  card: EmotionCard
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveEmotionCard");
  await nwSet(`${emotionPrefix(sid)}${card.id}`, card);
}

export async function getEmotionCard(
  sessionId: string | null | undefined,
  id: string
): Promise<EmotionCard | null> {
  const sid = requireSessionId(sessionId, "getEmotionCard");
  return nwGet<EmotionCard>(`${emotionPrefix(sid)}${id}`);
}

export async function deleteEmotionCard(
  sessionId: string | null | undefined,
  id: string
): Promise<void> {
  const sid = requireSessionId(sessionId, "deleteEmotionCard");
  kvRemove(`${emotionPrefix(sid)}${id}`);
}

export async function listEmotionCards(
  sessionId: string | null | undefined,
  opts?: {
    status?: string;
    类别?: string;
    主体?: string;
  }
): Promise<EmotionCard[]> {
  const sid = requireSessionId(sessionId, "listEmotionCards");
  const keys = await kvKeysWithPrefix(emotionPrefix(sid));
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

export async function saveWaterLevel(
  sessionId: string | null | undefined,
  water: WaterLevelState
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveWaterLevel");
  const existing =
    (await nwGet<Record<string, WaterLevelState>>(waterKey(sid))) || {};
  existing[water.作用域] = water;
  await nwSet(waterKey(sid), existing);
}

export async function getWaterLevels(
  sessionId: string | null | undefined
): Promise<Record<"戏内层" | "现实层" | "共识层", WaterLevelState>> {
  const sid = requireSessionId(sessionId, "getWaterLevels");
  const existing =
    (await nwGet<Record<string, WaterLevelState>>(waterKey(sid))) || {};

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
  sessionId: string | null | undefined,
  scope: "戏内层" | "现实层" | "共识层"
): Promise<WaterLevelState> {
  const sid = requireSessionId(sessionId, "getWaterLevelByScope");
  const levels = await getWaterLevels(sid);
  return levels[scope];
}

// ==================== Writer State ====================

export async function saveWriterState(
  sessionId: string | null | undefined,
  state: NarrativeWriterState
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveWriterState");
  // id 与键名保持一致：这份状态归属哪一场，写死在数据里，方便备份与排查
  await nwSet(writerStateKey(sid), { ...state, id: sid });
}

export async function getWriterState(
  sessionId: string | null | undefined
): Promise<NarrativeWriterState> {
  const sid = requireSessionId(sessionId, "getWriterState");
  const saved = await nwGet<NarrativeWriterState>(writerStateKey(sid));
  if (!saved) return createDefaultWriterState(sid);

  // 默认值 + 已存数据合并：新字段缺失时回落默认，不报错
  const state: NarrativeWriterState = { ...createDefaultWriterState(sid), ...saved };
  state.id = sid;
  state.currentTurn = normalizeTurn(state.currentTurn);
  state.lastExtractedTurn = normalizeTurn(state.lastExtractedTurn);
  if (state.lastExtractedTurn > state.currentTurn) {
    state.lastExtractedTurn = state.currentTurn;
  }
  return state;
}

export async function getOrCreateWriterState(
  sessionId: string | null | undefined
): Promise<NarrativeWriterState> {
  const sid = requireSessionId(sessionId, "getOrCreateWriterState");
  const saved = await nwGet<NarrativeWriterState>(writerStateKey(sid));
  if (saved) return getWriterState(sid);

  const defaultState = createDefaultWriterState(sid);
  await saveWriterState(sid, defaultState);
  return defaultState;
}

// ==================== Batch Operations ====================

/** 批量删除记忆卡（用于用户清理） */
export async function batchDeleteMemoryCards(
  sessionId: string | null | undefined,
  ids: string[]
): Promise<void> {
  const sid = requireSessionId(sessionId, "batchDeleteMemoryCards");
  for (const id of ids) {
    await deleteMemoryCard(sid, id);
  }
}

/** 批量删除情感卡 */
export async function batchDeleteEmotionCards(
  sessionId: string | null | undefined,
  ids: string[]
): Promise<void> {
  const sid = requireSessionId(sessionId, "batchDeleteEmotionCards");
  for (const id of ids) {
    await deleteEmotionCard(sid, id);
  }
}

/**
 * 导出某一场对局的全部执笔数据。
 * 名字里带 ForMigration 是为了醒目：这是备份/迁移用的跨阶段入口，
 * 不得接进任何生成链路（生成链路只能读本会话，用 listMemoryCards 等）。
 */
export async function exportAllNarrativeDataForMigration(
  sessionId: string | null | undefined
): Promise<{
  sessionId: string;
  memories: MemoryCard[];
  emotions: EmotionCard[];
  waterLevels: Record<string, WaterLevelState>;
  writerState: NarrativeWriterState;
  hierarchy: ContextHierarchy | null;
  history: NarrativeHistoryEntry[];
}> {
  const sid = requireSessionId(sessionId, "exportAllNarrativeDataForMigration");
  return {
    sessionId: sid,
    memories: await listMemoryCards(sid),
    emotions: await listEmotionCards(sid),
    waterLevels: await nwGet<Record<string, WaterLevelState>>(waterKey(sid)) || {},
    writerState: await getWriterState(sid),
    hierarchy: await getContextHierarchy(sid),
    history: await listNarrativeHistory(sid),
  };
}

// ==================== Context Hierarchy (L2/L3) ====================

export async function saveContextHierarchy(
  sessionId: string | null | undefined,
  hierarchy: ContextHierarchy
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveContextHierarchy");
  await nwSet(hierarchyKey(sid), hierarchy);
}

export async function getContextHierarchy(
  sessionId: string | null | undefined
): Promise<ContextHierarchy | null> {
  const sid = requireSessionId(sessionId, "getContextHierarchy");
  const saved = await nwGet<ContextHierarchy>(hierarchyKey(sid));
  if (!saved) return null;
  // 旧存档没有 lastCompressedTurn，统一归一为 0（= 从没按回合压缩过），
  // 调用方可以直接做减法，不会出现 undefined / NaN。
  return { ...saved, lastCompressedTurn: normalizeTurn(saved.lastCompressedTurn) };
}

export async function getOrCreateContextHierarchy(
  sessionId: string | null | undefined
): Promise<ContextHierarchy> {
  const sid = requireSessionId(sessionId, "getOrCreateContextHierarchy");
  const existing = await getContextHierarchy(sid);
  if (existing) return existing;

  const defaultHierarchy: ContextHierarchy = {
    L2_章节摘要: [],
    L3_全局大纲: "",
    lastCompressedAt: 0,
    lastCompressedTurn: 0,
  };
  await saveContextHierarchy(sid, defaultHierarchy);
  return defaultHierarchy;
}

// ==================== Narrative History ====================

export async function saveNarrativeHistoryEntry(
  sessionId: string | null | undefined,
  entry: NarrativeHistoryEntry
): Promise<void> {
  const sid = requireSessionId(sessionId, "saveNarrativeHistoryEntry");
  await nwSet(`${historyPrefix(sid)}${entry.id}`, { ...entry, sessionId: sid });
}

export async function getNarrativeHistoryEntry(
  sessionId: string | null | undefined,
  id: string
): Promise<NarrativeHistoryEntry | null> {
  const sid = requireSessionId(sessionId, "getNarrativeHistoryEntry");
  return nwGet<NarrativeHistoryEntry>(`${historyPrefix(sid)}${id}`);
}

export async function deleteNarrativeHistoryEntry(
  sessionId: string | null | undefined,
  id: string
): Promise<void> {
  const sid = requireSessionId(sessionId, "deleteNarrativeHistoryEntry");
  kvRemove(`${historyPrefix(sid)}${id}`);
}

export async function listNarrativeHistory(
  sessionId: string | null | undefined,
  opts?: {
    mode?: "direct" | "select";
    limit?: number;
  }
): Promise<NarrativeHistoryEntry[]> {
  const sid = requireSessionId(sessionId, "listNarrativeHistory");
  const keys = await kvKeysWithPrefix(historyPrefix(sid));
  const entries: NarrativeHistoryEntry[] = [];

  for (const key of keys) {
    const entry = await nwGet<NarrativeHistoryEntry>(key);
    if (!entry) continue;
    if (opts?.mode && entry.mode !== opts.mode) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);

  const limit = opts?.limit ?? 50;
  return entries.slice(0, limit);
}

// ==================== Extraction Rules（全局，不隔离） ====================

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
export async function archiveMemoryCard(
  sessionId: string | null | undefined,
  id: string
): Promise<void> {
  const sid = requireSessionId(sessionId, "archiveMemoryCard");
  const card = await getMemoryCard(sid, id);
  if (!card) return;

  card.状态 = "归档";
  card.updatedAt = Date.now();
  await saveMemoryCard(sid, card);
}

/** 归档情感卡 */
export async function archiveEmotionCard(
  sessionId: string | null | undefined,
  id: string
): Promise<void> {
  const sid = requireSessionId(sessionId, "archiveEmotionCard");
  const card = await getEmotionCard(sid, id);
  if (!card) return;

  card.状态 = "归档";
  card.updatedAt = Date.now();
  await saveEmotionCard(sid, card);
}

/** 更新记忆卡字段 */
export async function updateMemoryCard(
  sessionId: string | null | undefined,
  id: string,
  updates: Partial<Omit<MemoryCard, "id" | "kind" | "createdAt">>
): Promise<void> {
  const sid = requireSessionId(sessionId, "updateMemoryCard");
  const card = await getMemoryCard(sid, id);
  if (!card) return;

  Object.assign(card, updates);
  card.updatedAt = Date.now();
  await saveMemoryCard(sid, card);
}

/** 更新情感卡字段 */
export async function updateEmotionCard(
  sessionId: string | null | undefined,
  id: string,
  updates: Partial<Omit<EmotionCard, "id" | "kind" | "createdAt">>
): Promise<void> {
  const sid = requireSessionId(sessionId, "updateEmotionCard");
  const card = await getEmotionCard(sid, id);
  if (!card) return;

  Object.assign(card, updates);
  card.updatedAt = Date.now();
  await saveEmotionCard(sid, card);
}

/** 批量归档记忆卡 */
export async function batchArchiveMemoryCards(
  sessionId: string | null | undefined,
  ids: string[]
): Promise<void> {
  const sid = requireSessionId(sessionId, "batchArchiveMemoryCards");
  for (const id of ids) {
    await archiveMemoryCard(sid, id);
  }
}

/** 批量归档情感卡 */
export async function batchArchiveEmotionCards(
  sessionId: string | null | undefined,
  ids: string[]
): Promise<void> {
  const sid = requireSessionId(sessionId, "batchArchiveEmotionCards");
  for (const id of ids) {
    await archiveEmotionCard(sid, id);
  }
}

// ==================== 会话删除清理 ====================

/**
 * 清除某场对局的全部执笔数据（记忆卡、情感卡、水位、执笔状态、整理结果、历史）。
 *
 * 同步实现：kvRemove 本身就是同步 API，这样删除对局那条同步链路
 * （mixology/storage.ts 的 deleteMixSession）不用改成 async，
 * 和它已有的"顺手摘文件夹 / 作废待发消息"两类清理保持同构。
 *
 * 不动旧全局键与备份键——那些不属于任何一场，删对局不该碰到它们。
 */
export function purgeNarrativeSessionData(sessionId: string | null | undefined): number {
  const sid = requireSessionId(sessionId, "purgeNarrativeSessionData");
  const prefix = sessionRoot(sid);
  let removed = 0;
  for (const key of kvKeysWithPrefix(prefix)) {
    kvRemove(key);
    removed++;
  }
  return removed;
}

// ==================== 来源检查与丢弃归档 ====================

/** 同步读一份 JSON。消息移除都发生在同步链路里，归档必须当场做完，不能留一个飘着的 Promise */
function nwGetSync<T>(key: string): T | null {
  const raw = kvGet(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 同步写：先更新内存缓存，落盘 fire-and-forget（与 kv-db 的同步写入口同一行为） */
function nwSetSync(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

/** 带来源字段的卡的窄视图：记忆卡与情感卡在这里同构，不必各自走一遍类型 */
type SourceBearingCard = {
  id: string;
  状态?: string;
  来源消息ID?: string;
  归档原因?: string;
};

/**
 * 来源消息还在不在这场对局里。
 *
 * 两个一律回答"在"的分支是有意为之：
 * - 没有来源消息ID = 来源未知（旧数据、记忆整理、补抽历史、深度抽取的产出），
 *   这些卡不归丢弃逻辑管，宁可留着也不凭猜测收起来；
 * - 会话本身读不到（还没建好、或整局已删）时判断不了，也不能把整场卡误归档。
 */
export function isSourceMessageAlive(
  sessionId: string | null | undefined,
  messageId?: string | null
): boolean {
  const sid = requireSessionId(sessionId, "isSourceMessageAlive");
  if (!messageId) return true;
  const session = getMixSession(sid);
  if (!session) return true;
  return session.turns.some((t) => t.id === messageId);
}

/** 按前缀把「来源命中且状态还允许动」的卡改成归档，返回改动条数 */
function archiveBySource(
  prefix: string,
  targets: Set<string>,
  原因: string
): number {
  let changed = 0;
  for (const key of kvKeysWithPrefix(prefix)) {
    const card = nwGetSync<SourceBearingCard>(key);
    if (!card) continue;
    // 只动生效/待核。冲突/陈旧/已归档的卡状态与归档原因都保持原样——
    // 它们各自已经有自己的说法（谁标的冲突、为什么陈旧、谁手动归档的），不该被这里覆盖。
    if (card.状态 !== "生效" && card.状态 !== "待核") continue;
    // 来源未知（没有来源消息ID）的卡直接跳过
    if (!card.来源消息ID || !targets.has(card.来源消息ID)) continue;
    nwSetSync(key, {
      ...card,
      状态: "归档",
      归档原因: 原因,
      updatedAt: Date.now(),
    });
    changed += 1;
  }
  return changed;
}

/**
 * 消息被丢弃之后该做的事：把来源正是这批消息的卡**归档**（不删）。
 *
 * 为什么归档而不是删：卡片内容可能仍然可用（玩家事后觉得那段剧情确实发生过），
 * 删了就找不回来；而"来源已消失的卡绝不能以生效身份进上下文"这条硬规则，
 * 归档同样满足。恢复入口在面板的「已归档」筛选里，恢复时清除归档原因。
 *
 * 为什么同步：重说 / 回溯 / 撤回 / 编辑截断四条路径都是同步函数，
 * 它们只该调用这一个入口，不该在引擎里铺业务逻辑，也不该留下"归档还没跑完就开始生成"的窗口。
 */
export function onTurnsDiscarded(
  sessionId: string | null | undefined,
  discardedTurnIds: string[],
  原因: string
): { memories: number; emotions: number } {
  const sid = requireSessionId(sessionId, "onTurnsDiscarded");
  const targets = new Set(
    discardedTurnIds.filter((id) => typeof id === "string" && id.length > 0)
  );
  if (targets.size === 0) return { memories: 0, emotions: 0 };
  return {
    memories: archiveBySource(memoryPrefix(sid), targets, 原因),
    emotions: archiveBySource(emotionPrefix(sid), targets, 原因),
  };
}

// ==================== 旧全局数据：备份与归属迁移 ====================

export async function getMigrationState(): Promise<NarrativeMigrationState | null> {
  return nwGet<NarrativeMigrationState>(MIGRATION_STATE_KEY);
}

export async function saveMigrationState(
  state: NarrativeMigrationState
): Promise<void> {
  await nwSet(MIGRATION_STATE_KEY, state);
}

/** 旧全局键里是否还躺着没归属的数据 */
export async function hasLegacyNarrativeData(): Promise<boolean> {
  const keys = [
    ...kvKeysWithPrefix(LEGACY.memoryPrefix),
    ...kvKeysWithPrefix(LEGACY.emotionPrefix),
    ...kvKeysWithPrefix(LEGACY.water),
    ...kvKeysWithPrefix(LEGACY.historyPrefix),
  ];
  if (keys.length > 0) return true;
  return (
    kvGet(LEGACY.writerState) !== null ||
    kvGet(LEGACY.hierarchy) !== null ||
    kvGet(LEGACY.water) !== null
  );
}

/** 旧全局数据的条数统计，供界面说明"有多少还没归属" */
export async function getLegacyNarrativeCounts(): Promise<{
  memories: number;
  emotions: number;
  history: number;
  hasWriterState: boolean;
  hasHierarchy: boolean;
  hasWater: boolean;
}> {
  return {
    memories: kvKeysWithPrefix(LEGACY.memoryPrefix).length,
    emotions: kvKeysWithPrefix(LEGACY.emotionPrefix).length,
    history: kvKeysWithPrefix(LEGACY.historyPrefix).length,
    hasWriterState: kvGet(LEGACY.writerState) !== null,
    hasHierarchy: kvGet(LEGACY.hierarchy) !== null,
    hasWater: kvGet(LEGACY.water) !== null,
  };
}

/**
 * 把旧全局键整包原样导出进 narrative:legacy_backup_v1。
 * 幂等：已经备份过就不重复覆盖，避免第二次跑时把首次的原始快照替换掉。
 */
export async function backupLegacyNarrativeData(): Promise<{
  entries: number;
  alreadyBackedUp: boolean;
}> {
  if (kvGet(LEGACY_BACKUP_KEY) !== null) {
    return { entries: 0, alreadyBackedUp: true };
  }

  const keys = [
    ...kvKeysWithPrefix("narrative:memory:"),
    ...kvKeysWithPrefix("narrative:emotion:"),
    ...kvKeysWithPrefix("narrative:history:"),
  ];
  for (const single of [LEGACY.water, LEGACY.writerState, LEGACY.hierarchy]) {
    if (kvGet(single) !== null && !keys.includes(single)) keys.push(single);
  }

  const entries: NarrativeLegacyBackupEntry[] = [];
  for (const key of keys) {
    const value = kvGet(key);
    if (value === null) continue;
    entries.push({ key, value });
  }

  await nwSet(LEGACY_BACKUP_KEY, {
    createdAt: Date.now(),
    source: "global-narrative-keys",
    entries,
  });

  const state = (await getMigrationState()) || { status: "pending" as const };
  await saveMigrationState({ ...state, backedUpAt: Date.now() });

  return { entries: entries.length, alreadyBackedUp: false };
}

export async function readLegacyNarrativeBackup(): Promise<{
  createdAt: number;
  source: string;
  entries: NarrativeLegacyBackupEntry[];
} | null> {
  return nwGet<{
    createdAt: number;
    source: string;
    entries: NarrativeLegacyBackupEntry[];
  }>(LEGACY_BACKUP_KEY);
}

/**
 * 把旧全局数据复制进指定会话名下。
 *
 * 只做复制：不移动、不删除旧键、不改写旧键内容。
 * 也不复制到所有会话——那等于给每场凭空塞进别人的剧情。
 * 幂等：目标会话里已有同 id 的卡就跳过并计数，重复点"归属"不会翻倍。
 */
export async function migrateLegacyToSession(
  sessionId: string | null | undefined
): Promise<NarrativeMigrationState> {
  const sid = requireSessionId(sessionId, "migrateLegacyToSession");

  // 先保证有备份，再动手复制
  await backupLegacyNarrativeData();

  let memories = 0;
  let emotions = 0;
  let history = 0;
  let skippedDuplicates = 0;

  for (const key of kvKeysWithPrefix(LEGACY.memoryPrefix)) {
    const card = await nwGet<MemoryCard>(key);
    if (!card) continue;
    if (await getMemoryCard(sid, card.id)) {
      skippedDuplicates++;
      continue;
    }
    await saveMemoryCard(sid, card);
    memories++;
  }

  for (const key of kvKeysWithPrefix(LEGACY.emotionPrefix)) {
    const card = await nwGet<EmotionCard>(key);
    if (!card) continue;
    if (await getEmotionCard(sid, card.id)) {
      skippedDuplicates++;
      continue;
    }
    await saveEmotionCard(sid, card);
    emotions++;
  }

  for (const key of kvKeysWithPrefix(LEGACY.historyPrefix)) {
    const entry = await nwGet<NarrativeHistoryEntry>(key);
    if (!entry) continue;
    // 条目自带 sessionId 的，按条目自己的归属落进那一场，而不是全塞给用户选中的会话——
    // 生成历史本来就是某一场里点出来的，认错了场就串了。没有 sessionId 的旧条目才归到选中会话。
    // 目标会话可能已被删除：这种拷贝只是静静躺在 narrative:{那id}: 命名空间里，没有任何生成链路
    // 会读它，等该会话被清理时一并 purge，不会崩、也不会污染别的会话。
    const targetSid = typeof entry.sessionId === "string" && entry.sessionId.trim() ? entry.sessionId.trim() : sid;
    if (await getNarrativeHistoryEntry(targetSid, entry.id)) {
      skippedDuplicates++;
      continue;
    }
    await saveNarrativeHistoryEntry(targetSid, entry);
    history++;
  }

  // 水位：会话里没有才搬，有就以会话自己的为准
  if (!(await nwGet<Record<string, WaterLevelState>>(waterKey(sid)))) {
    const legacyWater = await nwGet<Record<string, WaterLevelState>>(LEGACY.water);
    if (legacyWater) await nwSet(waterKey(sid), legacyWater);
  }

  // 执笔状态：同上。id 由 saveWriterState 统一盖成 sessionId
  if (!(await nwGet<NarrativeWriterState>(writerStateKey(sid)))) {
    const legacyState = await nwGet<NarrativeWriterState>(LEGACY.writerState);
    if (legacyState) await saveWriterState(sid, legacyState);
  }

  // 整理结果（L2/L3）：同上
  if (!(await nwGet<ContextHierarchy>(hierarchyKey(sid)))) {
    const legacyHierarchy = await nwGet<ContextHierarchy>(LEGACY.hierarchy);
    if (legacyHierarchy) await saveContextHierarchy(sid, legacyHierarchy);
  }

  const state: NarrativeMigrationState = {
    status: "done",
    chosenSessionId: sid,
    counts: { memories, emotions, history, skippedDuplicates },
    backedUpAt: (await getMigrationState())?.backedUpAt ?? Date.now(),
    at: Date.now(),
  };
  await saveMigrationState(state);
  return state;
}

/** 用户选"稍后"：记下决定。旧键原地保留，因为读不到所以不参与任何生成。 */
export async function deferLegacyMigration(): Promise<NarrativeMigrationState> {
  await backupLegacyNarrativeData();
  const state: NarrativeMigrationState = {
    status: "deferred",
    at: Date.now(),
    backedUpAt: (await getMigrationState())?.backedUpAt ?? Date.now(),
  };
  await saveMigrationState(state);
  return state;
}
