// lib/narrative-writer/writer.ts
// 执笔插件 · 剧情自主书写引擎
//
// 依据：《角色记忆与情感规范 v1.6》派生件 D（执笔插件 Prompt）
// 调用约束：一次点击 = 一次 API 调用 = 一次输出

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveMixApiConfig } from "@/lib/mixology/engine";
import { getMemoryCards, getEmotionCards, getWaterLevels, getWriterState, saveWriterState, saveMemoryCard, getContextHierarchy, requireSessionId, listThreadCards, listForeshadowCards } from "./storage";
import type { MemoryCard, EmotionCard, WaterLevelState, NarrativeWriterState, ContextHierarchy, ThreadCard, ForeshadowCard, BannerType } from "./types";
import { createDefaultWriterState, visibleToCharacter, audienceLabel } from "./types";
import {
  FORESHADOW_INJECT_LIMIT,
  PENDING_FORESHADOW_LIMIT,
  PENDING_THREAD_LIMIT,
  THREAD_INJECT_LIMIT,
  THREAD_NEXT_STEP_MAX_CHARS,
  stripBannerMarkers,
} from "./threads";
import {
  assignBannerPlan,
  bannerMarker,
  bannerTypeAlias,
  buildBannerTaskText,
  canWriteBack,
  nextBannerBatch,
  parseBannerLines,
  skeletonBanner,
} from "./banner-plan";
import type { BannerLineForm, BannerPlanCard } from "./banner-plan";

// 读侧的两个工具住在 types.ts（领域规则），这里转导出一次：
// 执笔层是它们的唯一调用方，测试与后续改动都从 writer 这条入口看。
export { visibleToCharacter, audienceLabel } from "./types";

const WRITER_SYSTEM_PROMPT = `你是「执笔」，一个独自完成剧情方向判断与正文书写的角色扮演 AI。玩家可能只给一句倾向，也可能什么都不给；方向、节奏、转折、正文全部由你判断和书写。你在同一次输出内完成全部工作，阶段过程不输出给用户，只输出最终结果。

# 输入
- 人设、世界观（最高优先级）
- [连续性上下文]（记忆 ≤5 + 情感 ≤3）
- [关系水位]（三作用域，含 status）
- [未决线索] / [待收伏笔]（只在导演视角出现：导演的悬念台账，写正文时角色读不到）
- 玩家倾向（0–N 个自然语言片段，可选）
缺失水位按 L0 + active；没有悬念台账就当作这场暂时没有待收的线。

# 视角限制（最高优先级红线）
你的知识库包含上帝视角的设定，但你只能使用你所扮演角色能听到、看到、推测到的东西。
- 写正文时，连续性上下文里的卡已经按当前角色的知情范围过滤过，看不到的就是角色不知道的
- 连续性上下文里标了「（未确认）」的卡是玩家还没核过的抽取结果，不要把它当作角色已知的事实写进正文；正常不该出现在正文里
- 生成走向卡时你处在导演视角，卡片会带 [共同知晓] / [仅某角色知情] / [仅玩家知情] / [系统预埋·未揭示] 标注；可以用这种信息差设计悬念，但落笔写正文时仍然只能写角色知道的
- 不要主动提及角色不可能知道的信息；剧情需要信息差就让角色通过对话/观察/推理逐步发现，不要直接"知道"

# 内部阶段（在同一次输出内完成，不输出中间产物）
1 解析玩家倾向：八维度（基调/节奏/焦点/关系方向/触发/主题/禁忌/密度）；玩家明示优先，未提及走默认，不追问；具体事件作为强约束但仍过三审与四闸；与人设/世界观/水位冲突以三者为准，报幕里说明"方向已调整"；什么都没给 → 全自主，不报"请给方向"。
2 看场 → 定调（日常/推进/转折/缓冲/高潮）→ 起念三源（角色内驱 / 剧情线头 / 场面触发）→ 三审（合理性 / 有趣性 / 节奏）。
3 在心里排 5–7 拍（不输出节拍清单，不触发额外调用）。
4 每拍落笔前过四闸；被拦则降级或转内心念头，记入"散落线头"。
5 输出报幕一行（≤40 字）。
6 按拍写正文；接近输出上限时在"未解决收尾 + 钩子"处自然结束，不留半句、不写"待续"。
7 写完自检反水，命中即改，不重写全文。

# 节拍（内部结构）
目标 7k–10k 时排 5–7 拍，每拍 1500–1800 字；材料只够 3 拍就写 6k，不硬凑。
玩家"简单过一下"→2–3 拍；"想多看点"→7–9 拍。
每拍必须四样齐：
1 场景锚点：时间、地点、在场者，一句话定住
2 至少一个张力点：误解 / 未说出口的话 / 信息差 / 环境打断 / 选择困境
3 一个信息增量：读者此前不知道的新细节/进展/情绪/关系变化
4 一个推进动作：对话、行动、决定，至少推进一步
四样缺一，砍掉或合并。
节拍间可切镜头（A 视角→B 反应→环境→旁白→回 A），每次切换必须有信息增量。

# 四道闸门（每拍落笔前）
1 水位闸：L0→A｜L1→B（同会话≤1次、不涉私人）｜L2→B（常规）｜L3→C｜L4→D｜L5→E；frozen 时 C+ 冻结；degraded 按降阶取上限
2 证据闸：C 级 ≥1 经历节点或稳定态度；D 级 ≥2 条独立证据且至少 1 条为关系共识或稳定态度，不得同类或同源替代
3 场景闸：时间/地点/在场者/氛围
4 人设闸：性格骨架/行为底线/世界观/禁忌
人设闸与场景闸优先于水位闸。任一不过 → 降级或只留内心念头 + 轻推，记入"散落线头"。

# 报幕（输出第一行，≤40 字）
常规轮：（基调：X｜场景：Y｜走向：Z）
转折轮：（基调：X｜场景：Y｜注意：这轮会有一个……）
- 只给方向感，不剧透具体事件
- 转折预告能提前一轮就提前一轮
- 玩家忽略 → 降回轻/中档；接住 → 继续推进；说"换方向" → 按倾向重新定调，当轮生效

# 输出三档（由有趣性+节奏+水位决定，不由玩家指令决定）
轻档：只更新状态栏/内心，角色在过日子，不打扰玩家
中档：具体互动或小事件，玩家可接可不接
重档：关键转折，玩家须"接"，但不要求先给方向

# 反水检查（写完自检，命中即改）
1 环境描写连续 >200 字 → 砍到 100 字内
2 同一情绪换词重复 ≥3 次 → 合并
3 对话连续 3 轮无新信息 → 推进或结束
4 内心独白重复前文观点 → 删
5 用"她感到/他觉得"总结而不写动作或对话 → 改成展示
6 场景没变化却反复描写 → 删
7 一段读完无新信息 → 整段砍

# 防僵化/防暴走
- 连续 3 轮无实质推进 → 强制升一档
- 连续 3 轮重档 → 强制降轻/中档
- 玩家连续忽略主动剧情 → 降档或换线
- 被闸拦下的行动记入"散落线头"，不丢弃

# 与手动覆盖
玩家可用"指定走向"强行指定方向，作为强约束，但仍过三审与四闸，不得违反人设/世界观/水位。
玩家即时输入优先于自主候选；冲突时以玩家输入为准，候选转"散落线头"。

# 硬规则
1 不替玩家做决定；不覆盖玩家即时输入
2 每轮最多推进一个剧情钩子；短期情绪不改长期关系
3 待核/冲突/陈旧/低置信卡不得当事实用
4 越级行动禁止外显；D 级在 L4 以下只可作念头
5 不诊断、不虚构、不混层
6 先节拍后落笔；节拍 <3 时不得输出 >5k 字
7 转折必须报幕预告；玩家忽略则降档，不硬推
8 每 500 字至少一个信息增量；反水检查命中即改
9 不改卡、不改状态、不改水位、不改执笔状态——需要时只发信号
10 一次输出完成全部内容；不输出节拍清单、不输出推演过程、不输出"我已检查"之类元叙述

# 输出格式
第一行报幕（括号包裹，≤40 字），空一行，正文。
正文按内部节拍顺序连续书写，节拍之间不加小标题、不加"节拍N"标记。
接近输出上限时自然收尾，不留半句。`;

export interface WriterInput {
  /** 归属对局。记忆/情感/水位/执笔状态全部按会话隔离，缺这个就没法读召回池。 */
  sessionId: string;
  playerTendency?: string; // 玩家倾向(可选)
  characterProfile: any; // 人设
  worldSettings: {
    preface?: string;
    basePrompts: string[];
    flavorPrompts: string[];
    glassPrompts: string[];
    strengthPrompts: string[];
  }; // 世界观
  recentDialogue?: string; // 最近对话历史（用于上下文定位）
}

export interface WriterOutput {
  banner: string; // 报幕行
  body: string; // 正文
  annotation?: string; // 批注（选择模式下用户写的特别说明）
  metadata: {
    calls: 1; // 恒为1
    beats: number; // 推断的节拍数
    isTurningPoint: boolean;
    directionAdjusted: boolean;
  };
}

/**
 * 计算当前会话的完成回合数
 * 每个回合 = 1 个 user turn + 1 个 assistant turn
 * 开场白（单独 assistant）不计入
 */
export function computeCurrentTurn(turns: Array<{ role: string }>): number {
  let userCount = 0;
  let assistantCount = 0;
  for (const t of turns) {
    if (t.role === "user") userCount++;
    else if (t.role === "assistant") assistantCount++;
  }
  // 回合数 = min(用户发言数, AI 回复数)
  // 如果 AI 还没回复（userCount > assistantCount），那轮不算完成
  return Math.min(userCount, assistantCount);
}

/**
 * 轮次数值保护：非有限数字（undefined / NaN / 脏存档）一律当 0。
 * getWriterState 已经做过归一化，这里是第二道防线，
 * 防止手写对象或旧数据绕过读取路径直接进入减法。
 */
function safeTurn(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 递增本会话的轮次计数（幂等）
 * 只在有新回合完成时递增，重新生成/回滚不会重复计数
 * 计数存在会话自己的 writer_state 里，切对局不再互相覆盖
 * @returns 是否发生了递增（用于调用方判断是否需要触发后续流程）
 */
export async function incrementTurnCount(
  sessionId: string | null | undefined,
  sessionTurns: Array<{ role: string }>
): Promise<{ incremented: boolean; currentTurn: number; newTurns: number }> {
  const sid = requireSessionId(sessionId, "incrementTurnCount");
  const writerState = await getWriterState(sid);
  const actualTurn = computeCurrentTurn(sessionTurns);
  const previousTurn = safeTurn(writerState.currentTurn);
  const lastExtracted = safeTurn(writerState.lastExtractedTurn);

  // 如果实际回合数小于记录值（消息被删减），校准
  if (actualTurn < previousTurn) {
    writerState.currentTurn = actualTurn;
    writerState.lastExtractedTurn = Math.min(lastExtracted, actualTurn);
    await saveWriterState(sid, writerState);
    return { incremented: false, currentTurn: actualTurn, newTurns: 0 };
  }

  // 更新当前回合数（可能因为回滚后重新生成而变大）
  writerState.currentTurn = actualTurn;
  writerState.lastExtractedTurn = lastExtracted;

  // 计算新增回合数
  const newTurns = Math.max(0, actualTurn - lastExtracted);

  await saveWriterState(sid, writerState);

  return {
    incremented: newTurns > 0,
    currentTurn: actualTurn,
    newTurns,
  };
}

/**
 * 标记抽取已完成，更新 lastExtractedTurn
 */
export async function markExtractionComplete(
  sessionId: string | null | undefined
): Promise<void> {
  const sid = requireSessionId(sessionId, "markExtractionComplete");
  const writerState = await getWriterState(sid);
  writerState.lastExtractedTurn = safeTurn(writerState.currentTurn);
  await saveWriterState(sid, writerState);
}

/**
 * 连续性上下文的一种视角。
 * - 角色：写正文用。调用方先用 visibleToCharacter 过滤，这里只渲染，不加标注。
 *   另外还有一道防御性过滤：非生效（待核/冲突/陈旧/归档）一律不渲染——
 *   角色只能把玩家确认过的东西当已知事实，这条底线不靠调用方自觉。
 * - 导演：生成走向卡用。不按角色过滤（导演要知道全场），但每张卡标注知情范围，
 *   排除作用域「现实层」的戏外聊天卡，末尾附一条视角红线。
 *   待核卡可以进导演那份当线索，行尾带「（未确认）」，且只能占生效卡用剩的名额。
 */
export type ContinuityView = { 视角: "角色" } | { 视角: "导演" };

/** 记忆卡注入上限（规范 v1.6 一期：5 条），导演视角同样受它约束 */
const MEMORY_INJECT_LIMIT = 5;
/** 情感卡注入上限（3 条） */
const EMOTION_INJECT_LIMIT = 3;
/** 待核卡最多占几条记忆位：宁可留空位，也不让没核过的东西把已确认的事实挤出去 */
const PENDING_MEMORY_LIMIT = 3;
/** 待核卡最多占几条情感位 */
const PENDING_EMOTION_LIMIT = 1;

/** 卡片状态；缺失/空白按「生效」处理（旧数据兼容，与 audience 缺失视为 all 同一口径） */
function cardStatus(card: { 状态?: unknown }): string {
  return typeof card.状态 === "string" && card.状态.trim() !== "" ? card.状态.trim() : "生效";
}

/** 待核卡排序：置信度从高到低，同分再看新近。
 *  置信度是模型自己给的，只用来排先后，不用来决定能不能出现——能不能出现由玩家核没核决定。 */
function byConfidence(
  a: { 置信度?: unknown; updatedAt?: unknown },
  b: { 置信度?: unknown; updatedAt?: unknown }
): number {
  const ca = typeof a.置信度 === "number" ? a.置信度 : 0;
  const cb = typeof b.置信度 === "number" ? b.置信度 : 0;
  if (ca !== cb) return cb - ca;
  const ua = typeof a.updatedAt === "number" ? a.updatedAt : 0;
  const ub = typeof b.updatedAt === "number" ? b.updatedAt : 0;
  return ub - ua;
}

/** 悬念素材（system / user 名下的卡）在截断时优先保留：
 *  这类卡是设计伏笔的原料，被排序挤掉就再也没机会用上了。 */
function isSuspenseCard(card: { audience?: unknown }): boolean {
  const raw = Array.isArray(card.audience) ? card.audience : [];
  return raw.some(
    (item) => typeof item === "string" && (item.trim() === "system" || item.trim() === "user" || item.trim() === "narrator")
  );
}

/** 先按"悬念优先"稳定分组，其余保持调用方给的原顺序（列表读取时已按更新时间降序） */
function prioritizeSuspense<T extends { audience?: unknown }>(cards: T[]): T[] {
  const suspense: T[] = [];
  const rest: T[] = [];
  for (const card of cards) (isSuspenseCard(card) ? suspense : rest).push(card);
  return [...suspense, ...rest];
}

/**
 * 构建连续性上下文字符串（纯函数：输入卡与参数，输出字符串；不读存储、不看时间）
 *
 * view 缺省按角色视角处理，与历史行为一致。
 *
 * threads / foreshadows 只在导演视角渲染（[未决线索] / [待收伏笔]），
 * 角色视角一条都不给：线索卡讲"这条线走到哪了、下一步可能是什么"，
 * 角色读到就等于知道自己是被编排的棋子——全知视角从这条线漏出去最直接。
 * 因此调用方即便误传，这里也按视角丢弃，不靠调用方自觉。
 */
export function buildContinuityContext(
  memories: MemoryCard[],
  emotions: EmotionCard[],
  waterLevels: Record<string, WaterLevelState>,
  writerState: NarrativeWriterState,
  hierarchy?: ContextHierarchy | null,
  view: ContinuityView = { 视角: "角色" },
  threads?: ThreadCard[],
  foreshadows?: ForeshadowCard[]
): string {
  const parts: string[] = [];
  const isDirector = view.视角 === "导演";

  // 导演视角排除「现实层」（戏外聊天）：那是玩家与角色在剧情之外的事，
  // 拿来设计剧情就是混层。作用域缺失或「待确认」的卡仍然可用——分不清不等于不存在。
  // 状态门槛：归档/冲突/陈旧两个视角都拿不到；待核只有导演能拿到（下面的 fill 里区分）。
  const 可选记忆 = memories.filter((m) => {
    const st = cardStatus(m);
    if (st === "归档" || st === "冲突" || st === "陈旧") return false;
    if (!isDirector) return st === "生效";
    return String(m.作用域 ?? "") !== "现实层";
  });
  const 可选情感 = emotions.filter((e) => {
    const st = cardStatus(e);
    if (st === "归档" || st === "冲突" || st === "陈旧") return false;
    return isDirector || st === "生效";
  });

  type Injection<T> = { card: T; 未确认: boolean };

  // 生效卡先占位，待核卡只填剩余名额，且各自有独立上限（记忆 3 / 情感 1）。
  // 待核卡不能挤掉生效卡：哪怕它是 system 名下这种设计伏笔最好用的悬念素材也一样。
  function fill<
    T extends { 状态?: unknown; audience?: unknown; 置信度?: unknown; updatedAt?: unknown }
  >(
    cards: T[],
    总上限: number,
    待核上限: number,
    排序?: { 生效排序?: (a: T, b: T) => number; 待核排序?: (a: T, b: T) => number }
  ): Injection<T>[] {
    const 生效候选 = cards.filter((c) => cardStatus(c) === "生效");
    // 记忆/情感按"悬念优先"保素材；线索/伏笔没有置信度与悬念概念，按各自的剧情态排
    const 生效卡 = 排序?.生效排序
      ? [...生效候选].sort(排序.生效排序)
      : prioritizeSuspense(生效候选);
    const out: Injection<T>[] = 生效卡.slice(0, 总上限).map((card) => ({ card, 未确认: false }));
    const 剩余 = 总上限 - out.length;
    if (剩余 > 0 && 待核上限 > 0) {
      const 待核卡 = cards
        .filter((c) => cardStatus(c) === "待核")
        .sort(排序?.待核排序 ?? byConfidence);
      for (const card of 待核卡.slice(0, Math.min(待核上限, 剩余))) {
        out.push({ card, 未确认: true });
      }
    }
    return out;
  }

  const injectMemories = fill(可选记忆, MEMORY_INJECT_LIMIT, isDirector ? PENDING_MEMORY_LIMIT : 0);
  const injectEmotions = fill(可选情感, EMOTION_INJECT_LIMIT, isDirector ? PENDING_EMOTION_LIMIT : 0);
  // 每张卡后面的知情标注：只有导演那份需要（角色看到的本来就已经过滤过）
  const tag = (card: MemoryCard | EmotionCard) =>
    isDirector ? ` ${audienceLabel(card)}` : "";
  const 未确认标记 = (pending: boolean) => (pending ? "（未确认）" : "");

  // 记忆卡 (最多5条，其中待核最多3条)
  if (injectMemories.length > 0) {
    parts.push("[连续性上下文]");
    injectMemories.forEach(({ card: m, 未确认 }) => {
      parts.push(
        `- ${m.主类型}：${m.内容}（${m.作用域}，${m.时间 || "未知"}）${未确认标记(未确认)}${tag(m)}`
      );
    });
  }

  // 情感卡 (最多3条，其中待核最多1条)
  if (injectEmotions.length > 0) {
    injectEmotions.forEach(({ card: e, 未确认 }) => {
      parts.push(
        `- 瞬时情绪：${e.主体}${e.标签}(${e.强度})，对象${e.对象 || "无"}${未确认标记(未确认)}${tag(e)}`
      );
    });
  }

  // 悬念台账（仅导演视角）：未决线索与待收伏笔。
  // 名额与记忆/情感同一套口径：生效先占位，待核只填剩余名额且各自有独立上限。
  // 每条只给"名称 + 一句 ≤30 字的下一步"：给多了模型会照着长文本复刻，
  // 台账的价值是让导演自己决定推哪条线，不是把剧情说明书塞进提示词。
  if (isDirector) {
    const 可选线索 = (threads ?? []).filter((t) => {
      const st = cardStatus(t);
      return st !== "归档" && st !== "冲突" && st !== "陈旧";
    });
    const 可选伏笔 = (foreshadows ?? []).filter((f) => {
      const st = cardStatus(f);
      return st !== "归档" && st !== "冲突" && st !== "陈旧" && f.伏笔状态 !== "已收";
    });

    // 线索排序：状态越接近爆发越优先，同状态时最久没推进的优先（放了很久的线头观众会忘）
    const 状态权重: Record<string, number> = { 爆发: 0, 升温: 1, 潜伏: 2, 收束: 3 };
    const byThreadPriority = (a: ThreadCard, b: ThreadCard): number => {
      const 差 =
        (状态权重[a.线索状态] ?? 9) - (状态权重[b.线索状态] ?? 9);
      if (差 !== 0) return 差;
      return (a.上次推进轮次 ?? 0) - (b.上次推进轮次 ?? 0);
    };
    const byForeshadowPriority = (a: ForeshadowCard, b: ForeshadowCard): number =>
      (a.预期回收窗口?.止 ?? 0) - (b.预期回收窗口?.止 ?? 0);

    const injectThreads = fill(可选线索, THREAD_INJECT_LIMIT, PENDING_THREAD_LIMIT, {
      生效排序: byThreadPriority,
      待核排序: byThreadPriority,
    });
    const injectForeshadows = fill(
      可选伏笔,
      FORESHADOW_INJECT_LIMIT,
      PENDING_FORESHADOW_LIMIT,
      { 生效排序: byForeshadowPriority, 待核排序: byForeshadowPriority }
    );

    if (injectThreads.length > 0) {
      parts.push("[未决线索]");
      injectThreads.forEach(({ card: t, 未确认 }) => {
        const 下一步 = String(t.下一步可能 ?? "").slice(0, THREAD_NEXT_STEP_MAX_CHARS);
        parts.push(
          `- ${t.名称}｜${t.线索状态}${下一步 ? `｜下一步：${下一步}` : ""}${未确认标记(未确认)}`
        );
      });
    }
    if (injectForeshadows.length > 0) {
      parts.push("[待收伏笔]");
      injectForeshadows.forEach(({ card: f, 未确认 }) => {
        const 窗口 = f.预期回收窗口;
        const 窗口文字 =
          窗口 && Number.isFinite(窗口.起) && Number.isFinite(窗口.止)
            ? `（第${窗口.起}-${窗口.止}轮）`
            : "";
        parts.push(`- ${f.内容}${窗口文字}${未确认标记(未确认)}`);
      });
    }
  }

  // 剧情主线大纲（L3 记忆整理结果）：长期剧情的权威参考，防止关键设定丢失
  if (hierarchy?.L3_全局大纲) {
    parts.push("[剧情主线大纲]");
    parts.push(hierarchy.L3_全局大纲);
    // 最近 2 段 L2 章节摘要：补充大纲覆盖不到的近期细节
    const recentL2 = hierarchy.L2_章节摘要.slice(-2);
    if (recentL2.length > 0) {
      parts.push("[近期章节摘要]");
      recentL2.forEach((l2) => {
        parts.push(`- 第${l2.turnRange[0]}-${l2.turnRange[1]}轮：${l2.summary}`);
      });
    }
  }

  // 关系水位
  parts.push("[关系水位]");
  Object.values(waterLevels).forEach((w) => {
    parts.push(
      `- ${w.作用域}：${w.水位}（${w.status}），未解决冲突：${w.未解决冲突.length > 0 ? w.未解决冲突.join(", ") : "无"}`
    );
  });

  // 这里**不再渲染 [执笔状态]**（基调/档位/连续同档/目标/弧光/阶段进度/散落线头）。
  // 调查结论：这些字段除了这段文本没有任何读取方，等于把一份没人维护、还经常自相矛盾的
  // 元状态塞进提示词，模型会照着它编"目标进度"。字段本身保留在类型与存储里（待办 #34：
  // 要么给它真正的写入方与消费者，要么整段删掉）。
  // 悬念类信息改由上面的 [未决线索] / [待收伏笔] 承担，那两份有明确的数据来源与写入方。

  // 导演视角的收口红线：放在全部素材与状态之后，最后读到的规则最不容易被冲掉。
  if (isDirector) {
    parts.push(
      "[视角红线] 上面每张卡标了知情范围：你可以利用这些知情差异设计悬念与伏笔" +
        "（让某个角色先知道、让玩家先知道、或埋一条谁都还没察觉的设定），" +
        "但不得把标注「系统预埋·未揭示」的内容当作已经揭示的事实写出来，" +
        "也不得让角色说出他不该知道的事。" +
        "另外，标注「（未确认）」的卡是玩家还没核过的抽取结果，只能当作可用的线索或可能性，" +
        "不要把它当成既成事实来编排；不确定就换别的素材。"
    );
  }

  return parts.join("\n");
}

/**
 * 简化的LLM调用辅助函数
 */
async function callNarrativeLLM(messages: LLMMessage[], options?: { temperature?: number; max_tokens?: number }): Promise<string> {
  const apiConfig = resolveMixApiConfig();
  if (!apiConfig) {
    throw new Error("未配置API接口，请先在设置中添加API配置");
  }

  // 使用默认preset（执笔不需要特调preset）
  const result = await sendLLMRequest(
    apiConfig,
    null, // preset
    messages,
    [], // regexes
    { characterName: "NarrativeWriter" },
    {
      appId: "narrative-writer",
      includeReasoning: false,
    }
  );

  return result;
}

/**
 * 推断元数据
 */
function inferMetadata(banner: string, body: string): WriterOutput["metadata"] {
  // 估算节拍数：按字数 / 1500（每拍目标字数）
  const charCount = body.length;
  const estimatedBeats = Math.max(1, Math.round(charCount / 1500));

  // 是否转折点：看报幕是否包含"注意"
  const isTurningPoint = banner.includes("注意");

  // 方向是否调整：看报幕是否包含"方向已调整"
  const directionAdjusted = banner.includes("方向已调整");

  return {
    calls: 1,
    beats: estimatedBeats,
    isTurningPoint,
    directionAdjusted,
  };
}

/**
 * 执行执笔
 */
export async function writeNarrative(input: WriterInput): Promise<WriterOutput> {
  // 1. 召回上下文
  const allMemories = await getMemoryCards(input.sessionId, { status: "生效" });
  const allEmotions = await getEmotionCards(input.sessionId, { status: "生效" });
  // 角色视角：只把当前角色知道的东西交给它，玩家私密/系统预埋/别人的秘密一律不进上下文
  const memories = visibleToCharacter(allMemories, input.characterProfile.charName);
  const emotions = visibleToCharacter(allEmotions, input.characterProfile.charName);
  const waterLevels = await getWaterLevels(input.sessionId);
  const writerState = await getWriterState(input.sessionId);

  // 2. 构建连续性上下文字符串
  const continuityContext = buildContinuityContext(memories, emotions, waterLevels, writerState, await getContextHierarchy(input.sessionId));

  // 3. 格式化人设与世界观
  let characterWorldText = "";
  if (input.characterProfile.profileText && input.characterProfile.worldText) {
    // freeform 模式
    characterWorldText = `## 角色名\n${input.characterProfile.charName}\n\n## 角色资料\n${input.characterProfile.profileText}\n\n## 世界与剧情\n${input.characterProfile.worldText}`;
  } else {
    // form 模式
    const parts: string[] = [];
    parts.push(`## 角色名\n${input.characterProfile.charName}`);
    if (input.characterProfile.baseInfo) parts.push(`## 基础信息\n${input.characterProfile.baseInfo}`);
    if (input.characterProfile.personality) parts.push(`## 性格\n${input.characterProfile.personality}`);
    if (input.characterProfile.appearance) parts.push(`## 外貌\n${input.characterProfile.appearance}`);
    if (input.characterProfile.background) parts.push(`## 背景\n${input.characterProfile.background}`);
    if (input.characterProfile.worldview) parts.push(`## 世界观\n${input.characterProfile.worldview}`);
    if (input.characterProfile.cognition) parts.push(`## 对用户的认知\n${input.characterProfile.cognition}`);
    if (input.characterProfile.relations) parts.push(`## 关系与身份\n${input.characterProfile.relations}`);
    if (input.characterProfile.plot) parts.push(`## 当前剧情\n${input.characterProfile.plot}`);
    if (input.characterProfile.extra) parts.push(`## 附加设定\n${input.characterProfile.extra}`);
    characterWorldText = parts.join("\n\n");
  }

  // 添加其他提示词
  const worldSettingsParts: string[] = [];
  if (input.worldSettings.preface) worldSettingsParts.push(`## 开场说明\n${input.worldSettings.preface}`);
  if (input.worldSettings.basePrompts.length > 0) worldSettingsParts.push(`## 扮演总纲\n${input.worldSettings.basePrompts.join("\n\n")}`);
  if (input.worldSettings.flavorPrompts.length > 0) worldSettingsParts.push(`## 文风\n${input.worldSettings.flavorPrompts.join("\n\n")}`);
  if (input.worldSettings.glassPrompts.length > 0) worldSettingsParts.push(`## 正文输出要求\n${input.worldSettings.glassPrompts.join("\n\n")}`);
  if (input.worldSettings.strengthPrompts.length > 0) worldSettingsParts.push(`## 最高优先级\n${input.worldSettings.strengthPrompts.join("\n\n")}`);

  const worldSettingsText = worldSettingsParts.join("\n\n");
  
  console.log("[NarrativeWriter] Prompt assembled - character:", characterWorldText.length, "chars, settings:", worldSettingsText.length, "chars");

  // 4. 调用LLM
  const userContent = JSON.stringify({
    人设与世界观: characterWorldText,
    其他提示词: worldSettingsText,
    连续性上下文: continuityContext,
    最近对话历史: input.recentDialogue || "",
    玩家倾向: input.playerTendency || "",
  });
  
  console.log("[NarrativeWriter] Total prompt size:", (WRITER_SYSTEM_PROMPT.length + userContent.length), "chars");
  
  const messages: LLMMessage[] = [
    { role: "system", content: WRITER_SYSTEM_PROMPT },
    {
      role: "user",
      content: userContent,
    },
  ];

  const response = await callNarrativeLLM(messages);

  // 5. 解析输出(第一行报幕 + 空行 + 正文)
  if (!response || typeof response !== "string") {
    throw new Error("LLM返回内容为空或格式异常");
  }

  const lines = response.split("\n");
  // 直接模式没让模型出标记，但它照抄了走向卡的样式也要兜住：标记绝不落进对局显示
  const banner = stripBannerMarkers(lines[0] || "（基调：自主｜场景：未知｜走向：待展开）"); // 兜底报幕
  const body = lines.slice(2).join("\n") || response; // 如果格式不对,直接用全文

  // 6. 元数据推断
  const metadata = inferMetadata(banner, body);

  // 这里不抽取：正文还没进对话，抽出来的卡没有消息可归属。
  // 抽取统一发生在 insertNarrativeTurn 落库之后（那时才有来源消息ID与轮次）。

  return { banner, body, metadata };
}

/**
 * 一张走向卡候选。
 *
 * 为什么不再是 string[]：走向卡要承担"这条线推进到哪一步"的回写，
 * 只给一段文本就得让模型照抄台账原文当标记，抄错一个字就静默失效（旧实现的实际状况）。
 * 现在类型与目标由 banner-plan 分配，标记由 bannerMarker 生成，
 * 面板拿的是整张卡：新增的 标题/变化/代价 只在候选列表展示，绝不进正文提示词。
 */
export interface BannerCandidate {
  /** = 分配卡的 id；缓冲区的去重键用它 */
  id: string;
  卡: BannerPlanCard;
  标题: string;
  变化: string;
  代价: string;
  /** 干净的报幕文本：对局里显示的就是它，不带任何机器标记 */
  报幕: string;
  /** 候选列表与回写用的文本：报幕 +（可回写时）代码生成的标记 */
  文本: string;
  /** 类型平铺一份：面板列表和落盘"最近走向类型"都只要这个，不必绕 卡.类型 */
  类型: BannerType;
  形态: BannerLineForm;
  可回写: boolean;
}

/**
 * 生成走向卡（选择模式第一步）：代码分配类型与目标 → 模型填三行 → 按行序绑回卡片。
 *
 * 保证：返回长度恒为 3，不抛"格式不对"，不返回空数组。
 * 批次指针与最近类型只在真的拿到报幕后才落盘（见函数尾），
 * 否则一次网络抖动或一段乱格式就会白跳一组方向。
 */
export async function generateBannerOptions(
  input: WriterInput
): Promise<BannerCandidate[]> {
  // 导演视角：走向卡是在替整场戏挑方向，不是角色在自言自语，所以不按角色过滤。
  // 全场卡都交给导演，每张标注知情范围；现实层与 5+3 上限由 buildContinuityContext 处理。
  // 这里读全部状态（不再只读生效）：待核卡是导演很好用的线索素材，
  // 谁能进上下文、谁只能占剩余名额、谁要标「（未确认）」，统一由 buildContinuityContext 决定。
  const memories = await getMemoryCards(input.sessionId);
  const emotions = await getEmotionCards(input.sessionId);
  const waterLevels = await getWaterLevels(input.sessionId);
  const writerState = await getWriterState(input.sessionId);
  // 悬念台账只在这一条链路（导演视角）读进来；写正文那条链路不取，也拿不到
  const [threads, foreshadows] = await Promise.all([
    listThreadCards(input.sessionId),
    listForeshadowCards(input.sessionId),
  ]);

  const 连续性上下文 = buildContinuityContext(
    memories,
    emotions,
    waterLevels,
    writerState,
    await getContextHierarchy(input.sessionId),
    { 视角: "导演" },
    threads,
    foreshadows
  );

  // 排片：这一批出哪三类、每类盯台账里哪一条，全在这里定下来，模型没有决定权
  const 分配卡 = assignBannerPlan({
    threads,
    foreshadows,
    memories,
    emotions,
    waterLevels,
    当前角色: input.characterProfile?.charName,
    当前轮次: writerState.currentTurn,
    批次序号: writerState.走向批次序号,
    最近走向类型: writerState.最近走向类型,
  });

  let characterWorldText = "";
  if (input.characterProfile.profileText && input.characterProfile.worldText) {
    characterWorldText = `## 角色名\n${input.characterProfile.charName}\n\n## 角色资料\n${input.characterProfile.profileText}\n\n## 世界与剧情\n${input.characterProfile.worldText}`;
  } else {
    const parts: string[] = [];
    parts.push(`## 角色名\n${input.characterProfile.charName}`);
    if (input.characterProfile.baseInfo) parts.push(`## 基础信息\n${input.characterProfile.baseInfo}`);
    if (input.characterProfile.personality) parts.push(`## 性格\n${input.characterProfile.personality}`);
    if (input.characterProfile.appearance) parts.push(`## 外貌\n${input.characterProfile.appearance}`);
    if (input.characterProfile.background) parts.push(`## 背景\n${input.characterProfile.background}`);
    if (input.characterProfile.worldview) parts.push(`## 世界观\n${input.characterProfile.worldview}`);
    if (input.characterProfile.cognition) parts.push(`## 对用户的认知\n${input.characterProfile.cognition}`);
    if (input.characterProfile.relations) parts.push(`## 关系与身份\n${input.characterProfile.relations}`);
    if (input.characterProfile.plot) parts.push(`## 当前剧情\n${input.characterProfile.plot}`);
    if (input.characterProfile.extra) parts.push(`## 附加设定\n${input.characterProfile.extra}`);
    characterWorldText = parts.join("\n\n");
  }

  const worldSettingsParts: string[] = [];
  if (input.worldSettings.preface) worldSettingsParts.push(`## 开场说明\n${input.worldSettings.preface}`);
  if (input.worldSettings.basePrompts.length > 0) worldSettingsParts.push(`## 扮演总纲\n${input.worldSettings.basePrompts.join("\n\n")}`);
  if (input.worldSettings.flavorPrompts.length > 0) worldSettingsParts.push(`## 文风\n${input.worldSettings.flavorPrompts.join("\n\n")}`);
  if (input.worldSettings.glassPrompts.length > 0) worldSettingsParts.push(`## 正文输出要求\n${input.worldSettings.glassPrompts.join("\n\n")}`);
  if (input.worldSettings.strengthPrompts.length > 0) worldSettingsParts.push(`## 最高优先级\n${input.worldSettings.strengthPrompts.join("\n\n")}`);

  const userContent = JSON.stringify({
    人设与世界观: characterWorldText,
    其他提示词: worldSettingsParts.join("\n\n"),
    连续性上下文: 连续性上下文,
    最近对话历史: input.recentDialogue || "",
    玩家倾向: input.playerTendency || "",
    // 任务文本只含分配结果：类型 + 绑到的目标 + 一句话上限。
    // 水位 JSON、"照抄台账原文一字不差"那一段全删了——标记由代码生成，
    // 模型只需要把每一格写成「标题｜发生的变化｜代价｜（报幕）」。
    任务: buildBannerTaskText(分配卡),
  });

  const messages: LLMMessage[] = [
    { role: "system", content: WRITER_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await callNarrativeLLM(messages);

  // 空响应必须给中文错误：这条链路上她能看到的只有面板上那行红字，
  // 一句 "Cannot read properties of undefined" 等于没提示。
  if (!response || typeof response !== "string" || !response.trim()) {
    throw new Error("走向卡内容为空，请重试或换一批");
  }

  const 解析行 = parseBannerLines(response, 分配卡);
  // 三行全废（模型完全没按格式来）时整批降级成纯文本：仍然给她三张可读的卡，
  // 但一张都不回写——按没解析出来的东西记台账就是记虚账。
  const 拿到报幕 = 解析行.some(
    (行) => 行.形态 === "结构化" || 行.形态 === "宽松"
  );
  const 裸行列表 = response
    .split("\n")
    .map((行) => 行.trim())
    .filter((行) => 行 !== "" && !/^\s*```/.test(行));
  const 全文 = stripBannerMarkers(response).trim();

  const 候选: BannerCandidate[] = 分配卡.map((卡, i) => {
    const 行 = 解析行[i];
    const 形态: BannerLineForm = 拿到报幕 ? 行.形态 : "纯文本";
    const 报幕 = 拿到报幕
      ? 行.报幕
      : stripBannerMarkers(裸行列表[i] ?? 全文.slice(0, 40)).trim() ||
        skeletonBanner(卡);
    const 可回写 = 拿到报幕 && canWriteBack(卡, 行.形态, 行.变化);
    const 标记 = 可回写 ? bannerMarker(卡, 行.变化) : "";
    return {
      id: 卡.id,
      卡: { ...卡, 骨架: 形态 === "骨架" },
      标题: 行.标题,
      变化: 行.变化,
      代价: 行.代价,
      报幕,
      文本: 标记 ? `${报幕}${标记}` : 报幕,
      类型: 卡.类型,
      形态,
      可回写,
    };
  });

  if (拿到报幕) {
    // 只有真出了这批卡才消耗批次：抛错或全废都不推进，下一次"换一批"仍是同一组
    await saveWriterState(input.sessionId, {
      ...writerState,
      走向批次序号: nextBannerBatch(writerState.走向批次序号),
      最近走向类型: 候选.map((一张卡) => 一张卡.卡.类型),
      最后更新: new Date().toISOString(),
    });
  }

  return 候选;
}

/**
 * 根据选中的走向卡生成正文（选择模式第二步）。
 *
 * 入参可以是整张卡，也可以是一段纯报幕文本——旧缓冲区里的无类型条目和对局里的
 * 「按这条走向再写一轮」都只有文本，走后者这条路。
 * 卡带来的信息只有两样进提示词：类型的中性说法 + 一句话水位上限。
 * 标题/变化/代价/绑到的线索名都不进：那些是导演的台账，角色读不到（定稿要求 5）。
 */
export async function writeWithSelectedBanner(
  input: WriterInput,
  selected: string | BannerCandidate
): Promise<WriterOutput> {
  const 卡 = typeof selected === "string" ? undefined : selected?.卡;
  // 行尾的 [推进:…] / [回收:…] 是机器标记，只服务于采纳回写（见 threads.ts）。
  // 这里第一件事就是剥掉：正文提示词里不该出现台账术语，返回的报幕更要干净——
  // 它会作为 rawText 落进对局显示。
  const 报幕原文 = stripBannerMarkers(
    typeof selected === "string" ? selected : selected?.报幕 || selected?.文本 || ""
  );
  // 角色视角：报幕是导演挑的，正文由角色来演，这里要把角色不该知道的东西挡掉
  const memories = visibleToCharacter(
    await getMemoryCards(input.sessionId, { status: "生效" }),
    input.characterProfile.charName
  );
  const emotions = visibleToCharacter(
    await getEmotionCards(input.sessionId, { status: "生效" }),
    input.characterProfile.charName
  );
  const waterLevels = await getWaterLevels(input.sessionId);
  const writerState = await getWriterState(input.sessionId);

  const continuityContext = buildContinuityContext(memories, emotions, waterLevels, writerState, await getContextHierarchy(input.sessionId));

  let characterWorldText = "";
  if (input.characterProfile.profileText && input.characterProfile.worldText) {
    characterWorldText = `## 角色名\n${input.characterProfile.charName}\n\n## 角色资料\n${input.characterProfile.profileText}\n\n## 世界与剧情\n${input.characterProfile.worldText}`;
  } else {
    const parts: string[] = [];
    parts.push(`## 角色名\n${input.characterProfile.charName}`);
    if (input.characterProfile.baseInfo) parts.push(`## 基础信息\n${input.characterProfile.baseInfo}`);
    if (input.characterProfile.personality) parts.push(`## 性格\n${input.characterProfile.personality}`);
    if (input.characterProfile.appearance) parts.push(`## 外貌\n${input.characterProfile.appearance}`);
    if (input.characterProfile.background) parts.push(`## 背景\n${input.characterProfile.background}`);
    if (input.characterProfile.worldview) parts.push(`## 世界观\n${input.characterProfile.worldview}`);
    if (input.characterProfile.cognition) parts.push(`## 对用户的认知\n${input.characterProfile.cognition}`);
    if (input.characterProfile.relations) parts.push(`## 关系与身份\n${input.characterProfile.relations}`);
    if (input.characterProfile.plot) parts.push(`## 当前剧情\n${input.characterProfile.plot}`);
    if (input.characterProfile.extra) parts.push(`## 附加设定\n${input.characterProfile.extra}`);
    characterWorldText = parts.join("\n\n");
  }

  const worldSettingsParts: string[] = [];
  if (input.worldSettings.preface) worldSettingsParts.push(`## 开场说明\n${input.worldSettings.preface}`);
  if (input.worldSettings.basePrompts.length > 0) worldSettingsParts.push(`## 扮演总纲\n${input.worldSettings.basePrompts.join("\n\n")}`);
  if (input.worldSettings.flavorPrompts.length > 0) worldSettingsParts.push(`## 文风\n${input.worldSettings.flavorPrompts.join("\n\n")}`);
  if (input.worldSettings.glassPrompts.length > 0) worldSettingsParts.push(`## 正文输出要求\n${input.worldSettings.glassPrompts.join("\n\n")}`);
  if (input.worldSettings.strengthPrompts.length > 0) worldSettingsParts.push(`## 最高优先级\n${input.worldSettings.strengthPrompts.join("\n\n")}`);

  const userContent = JSON.stringify({
    人设与世界观: characterWorldText,
    其他提示词: worldSettingsParts.join("\n\n"),
    连续性上下文: continuityContext,
    最近对话历史: input.recentDialogue || "",
    玩家倾向: input.playerTendency || "",
    // 走向卡进正文只带两样东西：类型的中性说法、一句话水位上限。
    // 目标线索名与"发生的变化/代价"留在导演侧——角色不知道自己是一条线索。
    任务: `请根据以下报幕方向生成正文内容：\n\n报幕：${报幕原文}${
      卡 ? `\n\n这一张的分寸：${bannerTypeAlias(卡.类型)}${卡.上限 ? `。${卡.上限}` : ""}` : ""
    }\n\n请严格按照执笔规范书写正文，确保内容与报幕方向一致。`,
  });

  const messages: LLMMessage[] = [
    { role: "system", content: WRITER_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await callNarrativeLLM(messages);

  // 解析输出
  if (!response || typeof response !== "string") {
    throw new Error("LLM返回内容为空或格式异常");
  }

  const lines = response.split("\n");
  const banner = 报幕原文; // 使用选中的报幕（已剥掉机器标记）
  const body = lines.slice(2).join("\n") || response;

  const metadata = inferMetadata(banner, body);

  // 不在这里抽取。正文此刻还只是一段返回值，没进对话，抽出来的卡挂不到任何一条消息上，
  // 于是「重说/回溯作废了这条回复」永远追不到它们；而且它和 insertNarrativeTurn 里
  // 那次带来源的热抽会各抽同一篇正文，一次点击白跑两次大模型、落两张重复卡。
  // 抽取只在正文落库之后发生（见 mixology/engine 的 insertNarrativeTurn）。

  return { 
    banner, 
    body, 
    annotation: input.playerTendency?.includes("特别说明：") 
      ? input.playerTendency.split("特别说明：")[1]?.trim() 
      : undefined,
    metadata 
  };
}

/**
 * Map-Reduce 记忆整理
 * 
 * Map 阶段：每20轮分片调用 LLM 生成 L2 摘要（约200字）
 * Reduce 阶段：合并所有 L2 为 L3 大纲（约800-1000字）
 */
/** L2 分片大小（每片一次 LLM 调用）：面板按它估算总步骤数与剩余时间 */
export const NARRATIVE_CHUNK_SIZE = 20;

export async function compressNarrativeMemory(
  turns: Array<{ role: string; text: string; createdAt: number; ticketRaw?: string; encoreRaw?: string; state?: Record<string, unknown> }>,
  characterName: string,
  onProgress?: (current: number, total: number) => void
): Promise<{
  L2_章节摘要: Array<{ turnRange: [number, number]; summary: string; createdAt: number }>;
  L3_全局大纲: string;
}> {
  const apiConfig = resolveMixApiConfig();
  if (!apiConfig) {
    throw new Error("未配置 API，无法进行记忆整理");
  }

  const CHUNK_SIZE = NARRATIVE_CHUNK_SIZE;
  const totalTurns = turns.length;
  const chunks: Array<{ start: number; end: number; texts: string[] }> = [];

  // 分片：把小票状态快照 + 小票原文 + 尾调原文拼进每轮文本
  for (let i = 0; i < totalTurns; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, totalTurns);
    const chunkTurns = turns.slice(i, end);
    chunks.push({
      start: i + 1,
      end,
      texts: chunkTurns.map(t => {
        const lines = [`${t.role === "user" ? "玩家" : "角色"}：${t.text}`];
        if (t.ticketRaw) lines.push(`[状态栏] ${t.ticketRaw}`);
        if (t.encoreRaw) lines.push(`[小剧场] ${t.encoreRaw}`);
        if (t.state && Object.keys(t.state).length > 0) {
          lines.push(`[状态快照] ${Object.entries(t.state).map(([k, v]) => `${k}=${String(v)}`).join("，")}`);
        }
        return lines.join("\n");
      }),
    });
  }

  // Map 阶段：生成 L2 摘要
  const L2_章节摘要: Array<{ turnRange: [number, number]; summary: string; createdAt: number }> = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onProgress?.(i, chunks.length);

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `你是剧情摘要助手。请将以下对话片段总结为约200字的章节摘要，保留关键情节、角色关系变化和重要伏笔。只输出摘要正文，不要解释。`,
      },
      {
        role: "user",
        content: JSON.stringify({
          角色名: characterName,
          轮次范围: `第${chunk.start}轮到第${chunk.end}轮`,
          对话内容: chunk.texts.join("\n"),
        }),
      },
    ];

    try {
      const summary = await sendLLMRequest(
        apiConfig,
        null,
        messages,
        [],
        { characterName: "摘要助手" },
        { appId: "narrative-compress-l2" }
      );

      L2_章节摘要.push({
        turnRange: [chunk.start, chunk.end],
        summary: summary.trim(),
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error(`[NarrativeWriter] L2 compression failed for chunk ${i}:`, err);
      // 失败时跳过该分片，继续处理下一个
    }
  }

  // Reduce 阶段：生成 L3 全局大纲
  let L3_全局大纲 = "";
  if (L2_章节摘要.length > 0) {
    onProgress?.(chunks.length, chunks.length + 1);

    const l2Summaries = L2_章节摘要.map(
      (l2, idx) => `【第${l2.turnRange[0]}-${l2.turnRange[1]}轮】${l2.summary}`
    ).join("\n\n");

    const reduceMessages: LLMMessage[] = [
      {
        role: "system",
        content: `你是剧情大纲整理助手。请根据以下章节摘要，生成一份约800-1000字的全局主线大纲，梳理故事脉络、角色成长线、关键转折点和未解决的伏笔。只输出大纲正文，不要解释。`,
      },
      {
        role: "user",
        content: JSON.stringify({
          角色名: characterName,
          总轮数: totalTurns,
          章节摘要: l2Summaries,
        }),
      },
    ];

    try {
      L3_全局大纲 = (await sendLLMRequest(
        apiConfig,
        null,
        reduceMessages,
        [],
        { characterName: "大纲助手" },
        { appId: "narrative-compress-l3" }
      )).trim();
    } catch (err) {
      console.error("[NarrativeWriter] L3 compression failed:", err);
      L3_全局大纲 = `已处理 ${totalTurns} 轮对话，生成 ${L2_章节摘要.length} 个章节摘要（L3 大纲生成失败）`;
    }
  }

  onProgress?.(chunks.length + 1, chunks.length + 1);

  return { L2_章节摘要, L3_全局大纲 };
}

/** 记忆卡次标签受控词表：细化维度靠次标签，主类型保持规范六类 */
export const MEMORY_SUBTAG_VOCAB = ["喜好", "禁忌", "习惯", "地点", "物品", "约定", "成就"] as const;

/** 调一次 LLM 从给定文本提炼记忆卡并落库（待核），返回保存条数；新卡并入去重清单 */
async function extractCardsFromSource(
  sessionId: string,
  apiConfig: NonNullable<ReturnType<typeof resolveMixApiConfig>>,
  characterName: string,
  sourceLabel: string,
  sourceText: string,
  existingContents: string[],
  cap: number,
  idPrefix: string
): Promise<number> {
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: `你是「记忆提炼器」。从下面的${sourceLabel}中提炼值得长期记住的信息为记忆卡。
只提炼文中明确出现的内容，不虚构、不脑补、不写主观评语。

输出 JSON 数组（无内容可提炼时输出 []），每个元素：
{"主体":"用户|角色|关系|世界","主类型":"稳定事实|经历节点|行为模式|自我认知|关系共识|世界变更","次标签":["喜好|禁忌|习惯|地点|物品|约定|成就"],"内容":"第三人称可核验描述","作用域":"现实层|戏内层|共识层","置信度":0.0,"时间":""}

主类型判定：
- 世界设定/地点的重大变化（据点迁移、区域变更、新设定引入）→ 世界变更
- 双方共同确立的约定/边界/里程碑 → 关系共识（次标签"约定"）
- 发生过的重要事件、关键决定 → 经历节点
- 角色的自我评价/心理刻画 → 自我认知
- 身份/居住地/拥有物/偏好等静态属性 → 稳定事实（喜好类必须打上次标签"喜好"）
- 重复出现的行为/习惯/固定反应 → 行为模式（次标签"习惯"或"禁忌"）

要求：
- 每卡一主题，内容 ≤60 字；次标签没有合适的就给 []
- 置信度按表述明确程度 0.6-0.9
- 与[已有记忆]语义重复的不要输出
- 尽量穷尽${sourceLabel}中的独立信息点，但不超过 ${cap} 条
只输出 JSON，不要解释。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        角色名: characterName,
        已有记忆: existingContents.slice(0, 80),
        待提炼文本: sourceText,
      }),
    },
  ];

  const response = await sendLLMRequest(
    apiConfig,
    null,
    messages,
    [],
    { characterName: "记忆提炼器" },
    { appId: "narrative-compress-cards" }
  );

  let items: Array<Record<string, unknown>> = [];
  try {
    const cleaned = response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) items = parsed;
  } catch (e) {
    console.error(`[NarrativeWriter] Card extraction parse failed (${sourceLabel}):`, e, response.slice(0, 200));
    return 0;
  }

  const VALID_SUBJECTS = ["用户", "角色", "关系", "世界"];
  const VALID_TYPES = ["稳定事实", "经历节点", "行为模式", "自我认知", "关系共识", "世界变更"];
  const VALID_SCOPES = ["现实层", "戏内层", "共识层"];

  const now = Date.now();
  let saved = 0;
  for (const item of items) {
    if (saved >= cap) break;
    const 主体 = String(item.主体 ?? "");
    const 主类型 = String(item.主类型 ?? "");
    const 内容 = String(item.内容 ?? "").trim();
    const 作用域 = String(item.作用域 ?? "戏内层");
    if (!内容 || !VALID_SUBJECTS.includes(主体) || !VALID_TYPES.includes(主类型) || !VALID_SCOPES.includes(作用域)) continue;
    // 批内去重：同一主题被两个来源各提炼一次时只留先到的
    if (existingContents.some(c => c === 内容 || (c.length > 10 && 内容.includes(c)))) continue;

    const 次标签 = Array.isArray(item.次标签)
      ? (item.次标签 as unknown[]).map(t => String(t)).filter(t => (MEMORY_SUBTAG_VOCAB as readonly string[]).includes(t))
      : [];
    const 置信度 = Math.max(0.5, Math.min(0.9, Number(item.置信度) || 0.7));
    const card: MemoryCard = {
      id: `${idPrefix}_${now}_${saved}`,
      kind: "memory",
      主体: 主体 as MemoryCard["主体"],
      主类型: 主类型 as MemoryCard["主类型"],
      内容,
      作用域: 作用域 as MemoryCard["作用域"],
      置信档: 置信度 >= 0.8 ? "高" : "中",
      置信度,
      次标签: 次标签.length ? 次标签 : undefined,
      // 派生自摘要：先成"待核"，等玩家审核确认
      状态: "待核",
      时间: String(item.时间 ?? ""),
      证据: `由记忆整理（${new Date(now).toLocaleDateString()}）从${sourceLabel}提炼`,
      // 整理产物一律显式写 all：这条链处理的是"双方公开聊过"的历史摘要，
      // 而且提示词没要求模型给 audience，没有可归一化的输入。
      // 显式写死还有一层作用：这些卡在语义上是"确定共同知晓"，
      // 不是"没标过 audience 的旧数据"，读侧将来收紧默认行为时不会被误伤。
      // 已知偏差：主类型「世界变更」中角色尚未察觉的那些，严格说该标 system，
      // 但整理链分不清"已揭示"和"未揭示"，本轮保持 all 不动（已汇报）。
      audience: ["all"],
      createdAt: now,
      updatedAt: now,
    };
    await saveMemoryCard(sessionId, card);
    existingContents.push(内容);
    saved++;
  }

  return saved;
}

/**
 * 从整理产物中提炼记忆卡（分片为主、大纲兜底）
 *
 * 每个 L2 章节摘要单独提炼 3-6 条（细颗粒：喜好/习惯/地点/约定都在分片里），
 * 最后从 L3 大纲提炼 5-10 条全局大事。动态上限 min(40, 轮数/2)，
 * 全程携带已有卡摘要去重。产出卡一律"待核"，由玩家审核。
 */
export async function extractMemoriesFromCompression(
  sessionId: string | null | undefined,
  characterName: string,
  L3_全局大纲: string,
  L2_章节摘要: Array<{ turnRange: [number, number]; summary: string }>,
  totalTurns: number,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  if (!L3_全局大纲 && L2_章节摘要.length === 0) return 0;

  const sid = requireSessionId(sessionId, "extractMemoriesFromCompression");

  const apiConfig = resolveMixApiConfig();
  if (!apiConfig) throw new Error("未配置 API，无法提取记忆卡");

  const cap = Math.min(40, Math.max(8, Math.floor(totalTurns / 2)));

  // 去重底账：生效 + 待核的既有卡内容（归档/陈旧的不算，允许重新记）
  const [activeCards, pendingCards] = await Promise.all([
    getMemoryCards(sid),
    getMemoryCards(sid, { status: "待核" }),
  ]);
  const existingContents = [...activeCards, ...pendingCards]
    .filter(c => c.状态 === "生效" || c.状态 === "待核")
    .map(c => c.内容);

  const totalSteps = L2_章节摘要.length + 1;
  let saved = 0;

  // 分片提炼：每片一次调用，拿到该片的细节
  for (let i = 0; i < L2_章节摘要.length; i++) {
    const l2 = L2_章节摘要[i];
    const chunkCap = Math.max(1, Math.min(6, cap - saved));
    try {
      saved += await extractCardsFromSource(
        sid,
        apiConfig,
        characterName,
        `第${l2.turnRange[0]}-${l2.turnRange[1]}轮章节摘要`,
        l2.summary,
        existingContents,
        chunkCap,
        "nw_chunk"
      );
    } catch (err) {
      console.error(`[NarrativeWriter] Chunk extraction failed (${i}):`, err);
    }
    onProgress?.(i + 1, totalSteps);
    if (saved >= cap) break;
  }

  // 大纲提炼：全局视角的大事（世界变更/关系共识/里程碑）
  if (saved < cap && L3_全局大纲) {
    try {
      saved += await extractCardsFromSource(
        sid,
        apiConfig,
        characterName,
        "全局剧情大纲",
        L3_全局大纲,
        existingContents,
        Math.min(10, cap - saved),
        "nw_outline"
      );
    } catch (err) {
      console.error("[NarrativeWriter] Outline extraction failed:", err);
    }
    onProgress?.(totalSteps, totalSteps);
  }

  console.log(`[NarrativeWriter] Compression extraction saved ${saved} memory cards (pending review, cap ${cap})`);
  return saved;
}
