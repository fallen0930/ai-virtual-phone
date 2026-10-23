// lib/narrative-writer/threads.ts
// 执笔插件 · 线索卡与伏笔卡的"导演侧台账"逻辑
//
// 为什么单独成模块，而且刻意放在 mixology/engine 之外：
// 采纳回写要能在 Node 里直接用 fake-indexeddb 测（不 import 引擎），
// 所以这里只暴露一个"插入回调"——谁来把正文写进对局、写成功之后拿到哪条消息 id，
// 由调用方（执笔面板）决定；本模块只负责"剥标记 → 等插入成功 → 回写台账"。
//
// 三条硬规则（栗子的决定）：
// 1. 线索卡/伏笔卡永不进正文上下文，只进导演上下文；报幕行尾的机器标记必须在
//    正文生成之前剥掉，不能出现在正文提示词、对局显示或落库的报幕文本里。
// 2. 标记里的线索名必须与导演上下文列出的名称按同一归一化规则**完全匹配**；
//    匹配不上就忽略并 console.warn，绝不为它新建一张卡。
// 3. 剧情态（线索状态）的升级只能来自采纳回写或玩家在面板手动改；
//    抽取器同名输出只表示"本轮这条线有进展"，只更新 上次推进轮次 + 追加 最近变化。
//
// 已知限制（写在这里是为了下次读到的人不会再惊讶）：
// 采纳回写反映的是**报幕的计划**，不是正文实际写了什么。报幕说"这条线升温到爆发"，
// 正文可能因为模型发挥没写到那个程度，台账依然按报幕更新。见 MANUAL_CHECKLIST 第八节。

import {
  getWriterState,
  listForeshadowCards,
  listThreadCards,
  saveForeshadowCard,
  saveThreadCard,
  saveWriterState,
} from "./storage";
import type {
  ForeshadowCard,
  ThreadCard,
  ThreadChange,
  ThreadPlotStatus,
} from "./types";

/** 最近变化只留几条（新的在前） */
export const THREAD_CHANGE_KEEP = 3;

/** 导演上下文的名额：未决线索 ≤5（其中待核 ≤3），待收伏笔 ≤4（其中待核 ≤2） */
export const THREAD_INJECT_LIMIT = 5;
export const PENDING_THREAD_LIMIT = 3;
export const FORESHADOW_INJECT_LIMIT = 4;
export const PENDING_FORESHADOW_LIMIT = 2;

/** 渲染进导演上下文时，"下一步可能"截到几字 */
export const THREAD_NEXT_STEP_MAX_CHARS = 30;

const 线索状态词表: ThreadPlotStatus[] = ["潜伏", "升温", "爆发", "收束"];

/**
 * 线索名 / 伏笔内容的归一化：全角转半角 → 首尾标点与空白去掉 → 英文小写。
 *
 * 只归一化首尾，不动中间：名称里的空格和标点是有意义的（"第 3 号档案"不能变成"第3号档案"），
 * 但模型很爱在末尾加句号、用全角括号，不归一化就会"同一条线两张卡"。
 * 匹配一律用完全相等，不做模糊——模糊会把两条不同的线并成一条，那比多一张卡更糟。
 */
export function normalizeThreadName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // NFKC：全角字母数字与全角空格(U+3000)转半角；CJK 标点大多无兼容分解，保持原样
  const 半角 = raw.normalize("NFKC");
  // 首尾的标点与空白：\p{P} 标点、\p{S} 符号、空白
  const 去首尾 = 半角.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
  return 去首尾.trim().toLowerCase();
}

/** 推进标记：[推进:线索名→新状态:变化一句话] */
const ADVANCE_MARKER = /\[\s*推进\s*[:：]\s*([^\]→]+?)\s*→\s*([^:：\]]+?)\s*[:：]\s*([^\]]*?)\s*\]/g;
/** 回收标记：[回收:伏笔内容] */
const PAYOFF_MARKER = /\[\s*回收\s*[:：]\s*([^\]]*?)\s*\]/g;

export type ParsedAdvance = { 名称: string; 新状态: string; 变化: string };
export type BannerMarkers = {
  干净报幕: string;
  推进: ParsedAdvance[];
  回收: Array<{ 内容: string }>;
};

/**
 * 解析报幕行尾的机器标记，同时给出剥掉标记后的报幕。
 * 新状态不在词表内时仍原样返回（由回写那侧决定丢弃并 warn），这里不做二次猜测。
 */
export function parseBannerMarkers(banner: string): BannerMarkers {
  const 原文 = typeof banner === "string" ? banner : "";
  const 推进: ParsedAdvance[] = [];
  const 回收: Array<{ 内容: string }> = [];

  for (const match of 原文.matchAll(ADVANCE_MARKER)) {
    推进.push({
      名称: (match[1] ?? "").trim(),
      新状态: (match[2] ?? "").trim(),
      变化: (match[3] ?? "").trim(),
    });
  }
  for (const match of 原文.matchAll(PAYOFF_MARKER)) {
    回收.push({ 内容: (match[1] ?? "").trim() });
  }

  return { 干净报幕: stripBannerMarkers(原文), 推进, 回收 };
}

/**
 * 剥掉行尾机器标记。
 * 走向卡候选列表里保留带标记的原文（面板要拿它去回写），
 * 但正文提示词、对局显示、落库的报幕文本一律用这里的返回值。
 */
export function stripBannerMarkers(banner: string): string {
  const 原文 = typeof banner === "string" ? banner : "";
  return 原文
    .replace(ADVANCE_MARKER, "")
    .replace(PAYOFF_MARKER, "")
    .replace(/\s+$/g, "")
    .trim();
}

/** 这条线还进不进导演台账：归档的不算（冲突/陈旧仍是"有这条线"，只是审核状态不同） */
function 可采纳(thread: ThreadCard): boolean {
  return thread.状态 !== "归档";
}

function 可回收(foreshadow: ForeshadowCard): boolean {
  return foreshadow.状态 !== "归档" && foreshadow.伏笔状态 !== "已收";
}

/** 追加一条最近变化：新的在前，只留 THREAD_CHANGE_KEEP 条 */
function pushChange(最近变化: ThreadChange[], change: ThreadChange): ThreadChange[] {
  return [change, ...最近变化].slice(0, THREAD_CHANGE_KEEP);
}

/** 插入回调的返回值：允许调用方把新消息的归属信息带回来（面板就是这么用的）。 */
export type InsertResult = { 消息ID?: string; 轮次?: number } | void | unknown;

export interface AdoptedBannerInput {
  sessionId: string;
  /** 带机器标记的报幕原文（走向卡候选列表里那一条） */
  banner: string;
  /** 兜底来源：insert 没带回归属时使用 */
  来源消息ID?: string;
  来源轮次?: number;
  /** 真正把正文写进对局的那一步。抛错 = 插入失败 = 一律不回写。 */
  insert: (干净报幕: string) => Promise<InsertResult>;
}

export interface AdoptedBannerResult {
  干净报幕: string;
  推进数: number;
  回收数: number;
  忽略数: number;
}

/**
 * 采纳一条走向卡：先剥标记 → 等插入成功 → 按标记回写线索/伏笔台账。
 *
 * 为什么顺序不能换（栗子的补充 A）：正文没进对局就没有这条回复，
 * 台账却先记了"这条线推进了"，等于凭空多一段没发生的剧情。
 * 所以 insert 抛错时本函数直接向上抛，回写一行都不做。
 *
 * 来源归属优先用 insert 的返回值（新正文的消息 id 与轮次），拿不到才用传入的兜底值。
 */
export async function applyAdoptedBanner(
  input: AdoptedBannerInput
): Promise<AdoptedBannerResult> {
  const { 干净报幕, 推进, 回收 } = parseBannerMarkers(input.banner);

  // 插入失败 → 异常原样抛给调用方（面板按原有失败提示处理），下面这些一行都不执行
  const inserted = await input.insert(干净报幕);

  let 来源消息ID = input.来源消息ID;
  let 来源轮次 = input.来源轮次;
  if (inserted && typeof inserted === "object") {
    const 带来源 = inserted as { 消息ID?: unknown; 轮次?: unknown };
    if (typeof 带来源.消息ID === "string" && 带来源.消息ID) 来源消息ID = 带来源.消息ID;
    if (typeof 带来源.轮次 === "number" && Number.isFinite(带来源.轮次)) {
      来源轮次 = Math.floor(带来源.轮次);
    }
  }

  const threads = await listThreadCards(input.sessionId);
  const foreshadows = await listForeshadowCards(input.sessionId);
  let 推进数 = 0;
  let 回收数 = 0;
  let 忽略数 = 0;

  for (const 标记 of 推进) {
    const 目标名 = normalizeThreadName(标记.名称);
    const 命中 = 目标名
      ? threads.find((t) => normalizeThreadName(t.名称) === 目标名 && 可采纳(t))
      : undefined;
    if (!命中) {
      // 匹配不上就忽略：绝不替报幕新建一条线。新建只能来自抽取或玩家在面板上手写。
      忽略数 += 1;
      console.warn(
        `[NarrativeWriter] 采纳回写忽略一条 [推进] 标记：线索名"${标记.名称}"在导演台账里找不到（会话 ${input.sessionId}）`
      );
      continue;
    }
    const 新状态 = 线索状态词表.includes(标记.新状态 as ThreadPlotStatus)
      ? (标记.新状态 as ThreadPlotStatus)
      : undefined;
    if (!新状态) {
      console.warn(
        `[NarrativeWriter] 采纳回写：线索"${命中.名称}"的新状态"${标记.新状态}"不在词表（潜伏/升温/爆发/收束）里，保持原状态`
      );
    }
    await saveThreadCard(input.sessionId, {
      ...命中,
      // 剧情态只在这里升级：抽取器同名输出没有这个权力
      线索状态: 新状态 ?? 命中.线索状态,
      上次推进轮次: 来源轮次 ?? 命中.上次推进轮次,
      最近变化: pushChange(命中.最近变化 ?? [], {
        变化: 标记.变化 || 命中.名称,
        轮次: 来源轮次,
        来源消息ID,
        时间: Date.now(),
      }),
      updatedAt: Date.now(),
    });
    推进数 += 1;
  }

  for (const 标记 of 回收) {
    const 目标内容 = normalizeThreadName(标记.内容);
    const 命中 = 目标内容
      ? foreshadows.find(
          (f) => normalizeThreadName(f.内容) === 目标内容 && 可回收(f)
        )
      : undefined;
    if (!命中) {
      忽略数 += 1;
      console.warn(
        `[NarrativeWriter] 采纳回写忽略一条 [回收] 标记：伏笔"${标记.内容}"在台账里找不到或已收（会话 ${input.sessionId}）`
      );
      continue;
    }
    await saveForeshadowCard(input.sessionId, {
      ...命中,
      伏笔状态: "已收",
      updatedAt: Date.now(),
    });
    回收数 += 1;
  }

  return { 干净报幕, 推进数, 回收数, 忽略数 };
}

/**
 * 导演台账里"最该被用上的那条线"：给剧情预告的环境卡当钩子素材用。
 *
 * 优先级：爆发 > 升温 > 潜伏（收束中的线不再当新钩子）；
 * 同状态时，最久没推进的那条优先——放了很久没人管的线头才是观众会忘了的。
 * 没有可用线索时返回 null，调用方回退到原来的行为。
 */
export function pickPriorityThread(
  threads: ThreadCard[]
): ThreadCard | null {
  // 传进来的可能是面板读到的旧数据，甚至带 null：这里兜住，绝不因为素材脏就抛错
  const 可用 = (Array.isArray(threads) ? threads : [])
    .filter((t) => t && typeof t === "object")
    .filter(
      (t) =>
        t.状态 !== "归档" &&
        t.状态 !== "冲突" &&
        t.状态 !== "陈旧" &&
        t.线索状态 !== "收束"
    );
  if (可用.length === 0) return null;
  const 权重: Record<ThreadPlotStatus, number> = {
    爆发: 0,
    升温: 1,
    潜伏: 2,
    收束: 3,
  };
  return [...可用].sort((a, b) => {
    const 状态差 = (权重[a.线索状态] ?? 9) - (权重[b.线索状态] ?? 9);
    if (状态差 !== 0) return 状态差;
    return (a.上次推进轮次 ?? 0) - (b.上次推进轮次 ?? 0);
  })[0];
}

export interface MigrateLooseThreadsResult {
  新建: number;
  跳过: number;
}

/**
 * 把旧的「散落线头」（执笔状态里的纯文本数组）迁移成线索卡。
 *
 * 为什么是显式函数而不是"读取时顺手迁移"：读取路径里写库会让一次渲染变成两次 IO，
 * 而且分叉/删除/备份都可能触发读取，静默改写数据的时机就变得不可预测。
 * 调用入口在执笔面板（有旧数据时才提示一次），迁移幂等：
 * 同名已存在 → 跳过；批内重复 → 跳过；空白项 → 跳过；迁完把 散落线头 清空，
 * 于是第二次调用直接返回 {新建:0, 跳过:0}，也不会出现两套悬念数据。
 *
 * 内容不丢：原文直接做线索名。来源未知（旧数据没记是哪条消息），
 * 所以不写 来源消息ID/来源轮次——它们因此永不被丢弃归档触碰。
 */
export async function migrateLooseThreadsToCards(
  sessionId: string
): Promise<MigrateLooseThreadsResult> {
  const writerState = await getWriterState(sessionId);
  const 旧线头 = Array.isArray(writerState?.散落线头) ? writerState.散落线头 : [];
  if (旧线头.length === 0) return { 新建: 0, 跳过: 0 };

  const 已有 = await listThreadCards(sessionId);
  const 已用名称 = new Set(已有.map((t) => normalizeThreadName(t.名称)).filter(Boolean));
  const 当前轮次 = writerState?.currentTurn ?? 0;
  let 新建 = 0;
  let 跳过 = 0;

  for (const 原文 of 旧线头) {
    const 名称 = typeof 原文 === "string" ? 原文.trim() : "";
    const 归一 = normalizeThreadName(原文);
    if (!名称 || !归一 || 已用名称.has(归一)) {
      跳过 += 1;
      continue;
    }
    已用名称.add(归一);
    const now = Date.now();
    await saveThreadCard(sessionId, {
      id: `th_legacy_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "thread",
      名称,
      线索状态: "潜伏",
      关联角色: [],
      上次推进轮次: 当前轮次,
      下一步可能: "",
      最近变化: [],
      // 迁移来的线头没人核过，跟新抽的一样先待核
      状态: "待核",
      audience: ["all"],
      createdAt: now,
      updatedAt: now,
    });
    新建 += 1;
  }

  // 迁完清空：悬念数据只留 ThreadCard 这一套，不允许两份台账并存
  if (writerState) {
    await saveWriterState(sessionId, {
      ...writerState,
      散落线头: [],
      最后更新: new Date().toISOString(),
    });
  }

  return { 新建, 跳过 };
}

/**
 * 给抽取器用的"已有悬念名称列表"（#32 本轮范围：只给名称，不给内容摘要）。
 * 名称是同名判定唯一的依据，模型看得到名字才会用同名输出表达"这条线本轮有进展"。
 */
export async function listSuspenseNames(sessionId: string): Promise<{
  线索: string[];
  伏笔: string[];
}> {
  const [threads, foreshadows] = await Promise.all([
    listThreadCards(sessionId),
    listForeshadowCards(sessionId),
  ]);
  return {
    线索: threads
      .filter((t) => t.状态 !== "归档")
      .slice(0, 20)
      .map((t) => t.名称),
    伏笔: foreshadows
      .filter((f) => f.状态 !== "归档" && f.伏笔状态 !== "已收")
      .slice(0, 12)
      .map((f) => f.内容),
  };
}

/** 同名抽取更新：只动 上次推进轮次 与 最近变化，绝不动 线索状态 */
export async function recordThreadProgress(
  sessionId: string,
  已有: ThreadCard,
  变化: string,
  来源消息ID?: string,
  来源轮次?: number
): Promise<ThreadCard> {
  const 更新后: ThreadCard = {
    ...已有,
    上次推进轮次: 来源轮次 ?? 已有.上次推进轮次,
    最近变化: pushChange(已有.最近变化 ?? [], {
      变化: 变化 || 已有.名称,
      轮次: 来源轮次,
      来源消息ID,
      时间: Date.now(),
    }),
    updatedAt: Date.now(),
  };
  await saveThreadCard(sessionId, 更新后);
  return 更新后;
}
