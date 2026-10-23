// lib/narrative-writer/types.ts
// 执笔插件 · 领域类型：记忆卡、情感卡、关系水位、执笔状态。
//
// 依据：《角色记忆与情感规范 v1.6》派生件 C（表结构）
// 一期范围：记忆卡六类全开，情感卡仅"瞬时情绪"，水位 L0-L4（L5 暂不开放）

/** 记忆卡主类型 */
export type MemoryCardType =
  | "稳定事实"
  | "经历节点"
  | "行为模式"
  | "自我认知"
  | "关系共识"
  | "世界变更";

/** 记忆卡主体 */
export type MemorySubject = "用户" | "角色" | "关系" | "世界";

/** 作用域 */
export type Scope = "现实层" | "戏内层" | "共识层" | "待确认";

/** 置信档 */
export type ConfidenceLevel = "高" | "中" | "低";

/** 卡片状态 */
export type CardStatus = "生效" | "待核" | "冲突" | "陈旧" | "归档";

/**
 * 知情范围：谁"知道"这条信息。
 *
 * 词表（写入侧入库前由 normalizeAudience 归一化，读侧按同一套词判断）：
 * - "all"      共同知晓（对话里公开说过、双方都经历过的）
 * - "user"     只有玩家知道（玩家内心独白、私下念头）
 * - "system"   系统预埋、尚未揭示（世界设定变更但角色没察觉）
 * - 其它字符串  具体角色标识：只有那个角色知道
 *
 * 旧别名（第一期数据里存在，读侧继续认，写侧不再产生）：
 * - "character" 的语义是「本会话主角」——谁在当前角色位上就算谁，不指向某个固定角色；
 *   写侧遇到它会被替换成当前角色名。
 * - "narrator" 等价于 "system"，写侧统一换成 "system"。
 *
 * 已知限制（有意接受，不做批量迁移）：角色改名后，老卡里写的还是旧角色名，
 * 读侧按名字匹配会失配 → 该卡对角色不可见、对导演仍可见。
 * 根因是执笔层只拿到角色名字符串，没有稳定 id；把 materialId 传到执笔层记为待办 #28。
 */
export type Audience = "all" | "user" | "system" | (string & Record<never, never>);

/** 写侧认识的旧别名与关键字 */
const AUDIENCE_KEYWORDS = ["all", "user", "system"] as const;

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * 写入侧规范化：不信模型给的 audience，逐元素清洗后才入库。
 * - 非数组（缺失 / 空 / 字符串 / 对象）→ ["all"]
 * - 逐项 trim；"all"/"user"/"system" 原样保留
 * - "narrator" → "system"
 * - "character" → 当前角色名（拿不到名字时退为 "all"，宁可多给也不错杀整张卡）
 * - 等于当前角色名的字符串 → 保留该角色名
 * - 其余元素（词表外的乱值、非字符串）→ 丢弃
 * - 全部丢完为空 → ["all"]
 *
 * 注意：丢弃词表外角色名只发生在写入这一刻。库里已有的老卡不会被重写，
 * 所以「角色名失配 → 角色看不到、导演看得到」那条限制依然成立。
 */
export function normalizeAudience(
  value: unknown,
  当前角色名?: string
): Audience[] {
  if (!Array.isArray(value)) return ["all"];
  const me = typeof 当前角色名 === "string" ? 当前角色名.trim() : "";
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item) continue;
    if ((AUDIENCE_KEYWORDS as readonly string[]).includes(item)) {
      pushUnique(out, item);
    } else if (item === "narrator") {
      pushUnique(out, "system");
    } else if (item === "character") {
      pushUnique(out, me || "all");
    } else if (me && item === me) {
      pushUnique(out, me);
    }
    // 其余：词表外的值，丢弃
  }
  return out.length > 0 ? (out as Audience[]) : ["all"];
}

/**
 * 读侧：这张卡对"当前这个角色"可见吗。
 * 保留条件：没有 audience（旧数据）、空数组、含 "all"、含旧别名 "character"（=本会话主角）、
 * 或含当前角色名。排除："user"、"system"/"narrator"、别人的角色名、词表外的乱值。
 */
export function visibleToCharacter<T extends { audience?: unknown }>(
  cards: T[],
  当前角色标识?: string
): T[] {
  const me = typeof 当前角色标识 === "string" ? 当前角色标识.trim() : "";
  return cards.filter((card) => {
    const raw = card.audience;
    if (!Array.isArray(raw) || raw.length === 0) return true; // 兼容旧数据：视为共同知晓
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const value = item.trim();
      if (!value) continue;
      if (value === "all") return true;
      // "character" 不是某个固定角色，指"当前坐在角色位上的那个人"，对谁都成立
      if (value === "character") return true;
      if (me && value === me) return true;
    }
    return false;
  });
}

/** 导演视角下每张卡的知情标注 */
export function audienceLabel(card: { audience?: unknown }): string {
  const raw = Array.isArray(card.audience) ? card.audience : [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    if (value === "all") pushUnique(tags, "共同知晓");
    else if (value === "user") pushUnique(tags, "仅玩家知情");
    else if (value === "system" || value === "narrator")
      pushUnique(tags, "系统预埋·未揭示");
    else if (value === "character") pushUnique(tags, "仅本会话主角知情");
    else pushUnique(tags, `仅${value}知情`);
  }
  // 旧数据没有 audience 字段、或整串都是乱值 → 按共同知晓处理，导演至少不会漏看
  if (tags.length === 0) tags.push("共同知晓");
  return `[${tags.join("、")}]`;
}


/** 记忆卡 */
export interface MemoryCard {
  id: string; // uuid
  kind: "memory";
  主体: MemorySubject;
  主类型: MemoryCardType;
  内容: string; // 第三人称可核验描述
  作用域: Scope;
  置信档: ConfidenceLevel;
  置信度: number; // 0-1
  状态: CardStatus;
  次标签?: string[];
  对象?: string;
  时间?: string;
  /** 来源轮次：由代码在落库那一刻按会话实际轮数盖写，不信模型给的值 */
  来源轮次?: number;
  /** 来源消息ID：这张卡是从会话里哪条回复抽出来的。缺失 = 来源未知（旧数据、整理/补抽/深度抽取产出） */
  来源消息ID?: string;
  /** 归档原因：仅在状态为「归档」时有意义，写明是谁、为什么把这张卡收起来的 */
  归档原因?: string;
  证据: string; // 原话或可观察行为
  关联ID?: string;
  audience?: Audience[]; // 新增：知情范围（防全知视角）
  merged_into_worldview?: boolean; // 仅世界变更卡确认后置 true
  createdAt: number; // timestamp
  updatedAt: number;
}

/** 情感卡类别（一期仅启用瞬时情绪） */
export type EmotionCategory = "瞬时情绪"; // | "稳定态度" | "情感触发" | "底层需要"

/** 瞬时情绪受控词表 */
export type InstantEmotionLabel =
  | "开心"
  | "平静"
  | "焦虑"
  | "低落"
  | "生气"
  | "兴奋"
  | "疲惫"
  | "中性";

/** 情感卡主体 */
export type EmotionSubject = "用户" | "角色";

/** 情感卡 */
export interface EmotionCard {
  id: string;
  kind: "emotion";
  主体: EmotionSubject;
  类别: EmotionCategory;
  标签: InstantEmotionLabel;
  强度: number; // 0-1
  对象?: string;
  作用域: Scope;
  证据: string;
  置信档: ConfidenceLevel;
  置信度: number;
  状态: CardStatus;
  时间?: string;
  /** 来源轮次 / 来源消息ID / 归档原因：与记忆卡同一套语义，缺失即来源未知 */
  来源轮次?: number;
  来源消息ID?: string;
  归档原因?: string;
  audience?: Audience[]; // 新增：知情范围（防全知视角）
  createdAt: number;
  updatedAt: number;
}

// ==================== 线索卡与伏笔卡（导演侧悬念资产） ====================
//
// 这两类卡与记忆卡/情感卡的根本区别：**永远不进正文上下文**。
// 它们是导演（走向卡）手里的悬念台账——"这条线走到哪了""那个伏笔还没收"，
// 角色读到它就会全知视角（角色不该知道自己是一条线索）。所以 buildContinuityContext
// 只在 视角==="导演" 时渲染 [未决线索] / [待收伏笔]，角色视角一条都不给。
//
// 两套状态互相正交，不要混用：
// - 状态（CardStatus）：审核态，谁来把关。新建一律"待核"，玩家核过才生效；
// - 线索状态 / 伏笔状态：剧情态，这条线/这个伏笔在戏里走到哪一步。
//   剧情态只能由「采纳走向卡的回写」或「玩家在面板上手动改」推进，抽取器改不了。

/** 线索的剧情态 */
export type ThreadPlotStatus = "潜伏" | "升温" | "爆发" | "收束";

/** 伏笔的剧情态 */
export type ForeshadowPlotStatus = "未收" | "已收";

/** 线索的一次进展记录（只保留最近 3 条，新在前） */
export interface ThreadChange {
  /** 一句话：这轮这条线发生了什么 */
  变化: string;
  /** 发生在第几轮（由代码按写入时的会话轮次盖写） */
  轮次?: number;
  /** 这条进展来自哪条回复；采纳回写时是新正文的 id，抽取同名更新时是抽取来源 */
  来源消息ID?: string;
  时间: number;
}

/** 线索卡：一条还没收的线 */
export interface ThreadCard {
  id: string;
  kind: "thread";
  /** 线索名：导演上下文列出的名字，报幕标记 [推进:名称→…] 按归一化名称完全匹配 */
  名称: string;
  线索状态: ThreadPlotStatus;
  /** 涉及的角色名（沿用执笔层只有名字、没有稳定 id 的现状，见待办 #28） */
  关联角色: string[];
  /** 上次推进这条线的轮次 */
  上次推进轮次: number;
  /** 一句"下一步可能"；渲染进导演上下文时截到 30 字 */
  下一步可能: string;
  /** 最近 3 条变化，新的在前 */
  最近变化: ThreadChange[];
  /** 审核态 */
  状态: CardStatus;
  来源消息ID?: string;
  来源轮次?: number;
  归档原因?: string;
  audience?: Audience[];
  createdAt: number;
  updatedAt: number;
}

/** 伏笔卡：一个埋下了、等着收的钩子 */
export interface ForeshadowCard {
  id: string;
  kind: "foreshadow";
  /** 一句话伏笔内容；报幕标记 [回收:内容] 按归一化后的同一套规则匹配 */
  内容: string;
  埋下轮次: number;
  /** 预期回收窗口（闭区间，单位：轮）。{起,止} */
  预期回收窗口: { 起: number; 止: number };
  伏笔状态: ForeshadowPlotStatus;
  /** 挂在哪条线索上（可空）；只存名称，线索改名后按名字失配同 #28 的限制 */
  关联线索名称?: string;
  /** 打算靠什么揭示（可空） */
  揭示条件?: string;
  /** 审核态 */
  状态: CardStatus;
  来源消息ID?: string;
  来源轮次?: number;
  归档原因?: string;
  audience?: Audience[];
  createdAt: number;
  updatedAt: number;
}


/** 关系水位等级 */
export type WaterLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

/** 水位状态（与卡片五态正交） */
export type WaterStatus = "active" | "frozen" | "degraded";

/** 关系水位状态 */
export interface WaterLevelState {
  作用域: "戏内层" | "现实层" | "共识层";
  水位: WaterLevel;
  status: WaterStatus;
  准入证据: string[]; // memory/emotion card IDs
  未解决冲突: string[];
  冻结项: string[];
  最后更新: string; // ISO date
}

/** 执笔基调 */
export type NarrativeTone = "日常" | "推进" | "转折" | "缓冲" | "高潮";

/** 执笔档位 */
export type NarrativeGear = "轻" | "中" | "重";

/** 执笔状态（每个会话一份） */
export interface NarrativeWriterState {
  /** 归属的会话 id。历史数据这里是字面量 "default"，读到时按旧全局数据对待。 */
  id: string;
  当前基调: NarrativeTone;
  本轮档位: NarrativeGear;
  连续同档: number;
  目标: string[];
  目标来源: string[]; // memory card IDs
  当前弧光: string;
  阶段进度: number; // 0-1
  /**
   * @deprecated 悬念数据现在由 ThreadCard 承担（见 lib/narrative-writer/threads.ts 的
   * migrateLooseThreadsToCards）。这里保留字段只为读旧数据时不丢内容：
   * 迁移由显式函数完成（不放在读取路径里），迁完清空，此后没有任何写入方。
   */
  散落线头: string[];
  最近一次重档?: string; // ISO date
  停滞天数: number;
  status: "active" | "stalled" | "archived";
  specVersion: "v1.6";
  最后更新: string; // ISO date
  // 全局轮次计数（任务 1.5 新增）
  currentTurn: number; // 当前已完成回合数（user+assistant 对）
  lastExtractedTurn: number; // 上次抽取完成时的回合数（用于检测新内容）
}

/** 置信档 ↔ 数值映射门槛 */
export const CONFIDENCE_THRESHOLDS = {
  memory: { high: 0.8, medium: 0.6 },
  emotion: { high: 0.85, medium: 0.65 },
};

/** 水位准入规则（一期替代版） */
export function checkWaterLevelEligibility(
  level: WaterLevel,
  cards: { memories: MemoryCard[]; emotions: EmotionCard[] }
): boolean {
  const { memories, emotions } = cards;
  const activeMemories = memories.filter((m) => m.状态 === "生效");
  const activeEmotions = emotions.filter((e) => e.状态 === "生效");

  switch (level) {
    case "L0":
      return true; // 陌生：无要求
    case "L1":
      // ≥1 条稳定事实卡 + 有初次互动
      return activeMemories.some(
        (m) => m.主类型 === "稳定事实" && m.置信档 === "高"
      );
    case "L2":
      // ≥1 条行为模式或偏好卡 + ≥2 次独立互动
      const hasBehavior = activeMemories.some(
        (m) => m.主类型 === "行为模式" || m.次标签?.includes("偏好")
      );
      const interactionCount = activeMemories.filter(
        (m) => m.主类型 === "经历节点"
      ).length;
      return hasBehavior && interactionCount >= 2;
    case "L3":
      // 一期替代：经历节点 + 关系共识
      const hasExperience = activeMemories.some(
        (m) => m.主类型 === "经历节点"
      );
      const hasConsensus = activeMemories.some(
        (m) => m.主类型 === "关系共识"
      );
      return hasExperience && hasConsensus;
    case "L4": {
      // 一期替代：关系共识 + 经历节点中的脆弱分享 + 无未解决冲突
      const l4HasConsensus = activeMemories.some(
        (m) => m.主类型 === "关系共识"
      );
      const hasVulnerableShare = activeMemories.some(
        (m) =>
          m.主类型 === "经历节点" &&
          (m.内容.includes("脆弱") ||
            m.内容.includes("秘密") ||
            m.内容.includes("创伤"))
      );
      return l4HasConsensus && hasVulnerableShare;
    }
    case "L5":
      return false; // 一期不开放
    default:
      return false;
  }
}

/** 创建默认水位状态 */
export function createDefaultWaterLevel(
  scope: "戏内层" | "现实层" | "共识层"
): WaterLevelState {
  return {
    作用域: scope,
    水位: "L0",
    status: "active",
    准入证据: [],
    未解决冲突: [],
    冻结项: [],
    最后更新: new Date().toISOString(),
  };
}

/** 创建默认执笔状态 */
export function createDefaultWriterState(sessionId = "default"): NarrativeWriterState {
  return {
    id: sessionId,
    当前基调: "缓冲",
    本轮档位: "轻",
    连续同档: 0,
    目标: [],
    目标来源: [],
    当前弧光: "",
    阶段进度: 0,
    散落线头: [],
    停滞天数: 0,
    status: "active",
    specVersion: "v1.6",
    最后更新: new Date().toISOString(),
    currentTurn: 0,
    lastExtractedTurn: 0,
  };
}

/** 上下文层级结构（L2/L3 压缩结果） */
export interface ContextHierarchy {
  L2_章节摘要: Array<{
    turnRange: [number, number]; // [起始轮次, 结束轮次]
    summary: string; // 约200字
    createdAt: number;
  }>;
  L3_全局大纲: string; // 约800-1000字主线大纲
  lastCompressedAt: number; // 上次压缩时间戳（Date.now()，只给界面看）
  // 上次压缩覆盖到第几个回合。用回合数而不是时间戳判断"隔了多少轮"，
  // 时间戳和轮次是两套量纲，混用会算出巨大负数。旧数据缺失按 0 处理。
  lastCompressedTurn?: number;
}

/** 执笔历史记录 */
export interface NarrativeHistoryEntry {
  id: string;
  timestamp: number;
  mode: "direct" | "select";
  playerTendency: string;
  selectedBanner?: string;
  annotation?: string;
  output: {
    banner: string;
    body: string;
  };
  sessionId: string;
  metadata: {
    beats: number;
    isTurningPoint: boolean;
    directionAdjusted: boolean;
  };
}

/** 抽取规则配置（外围参数，不含置信度阈值） */
export interface ExtractionRules {
  preset: "宽松" | "标准" | "严格";
  memoryInjectLimit: number; // 记忆卡注入上限（默认5）
  emotionInjectLimit: number; // 情感卡注入上限（默认3）
  minEmotionStrength: number; // 情感卡最小强度过滤（0-1，默认0.3）
  autoArchiveDays: number; // 自动归档天数（默认30）
  enableMemoryExtraction: boolean; // 记忆卡抽取开关
  enableEmotionExtraction: boolean; // 情感卡抽取开关
  enableWaterLevelUpdate: boolean; // 水位更新开关
  enableAutoCompression: boolean; // L2/L3自动压缩开关
}

/** 默认抽取规则 */
export function createDefaultExtractionRules(): ExtractionRules {
  return {
    preset: "标准",
    memoryInjectLimit: 5,
    emotionInjectLimit: 3,
    minEmotionStrength: 0.3,
    autoArchiveDays: 30,
    enableMemoryExtraction: true,
    enableEmotionExtraction: true,
    enableWaterLevelUpdate: true,
    enableAutoCompression: false, // 默认手动触发
  };
}

// ==================== 会话隔离迁移 ====================

/**
 * 旧版本所有 narrative:* 数据是全局共用的（键名里没有会话 id）。
 * 隔离改造后：先把旧数据整包备份，再询问用户"这批记忆属于哪场对局"。
 * 选中 → 复制到该会话名下（复制，不移动，旧键永不删除）；
 * 稍后 → 旧键留在原地，但因为所有读写入口都必须带 sessionId，它天然读不到、不参与生成。
 */
export interface NarrativeMigrationState {
  status: "pending" | "done" | "deferred";
  /** 用户选定的归属会话；status 为 done 时有值 */
  chosenSessionId?: string;
  /** 各阶段计数，方便界面向她解释"迁移了什么、有没有跳过重复" */
  counts?: {
    memories: number;
    emotions: number;
    history: number;
    skippedDuplicates: number;
  };
  /** 备份写入时间 */
  backedUpAt?: number;
  /** 归属完成/推迟时间 */
  at?: number;
}

/** 旧全局键的整包备份条目 */
export interface NarrativeLegacyBackupEntry {
  key: string;
  value: string;
}
