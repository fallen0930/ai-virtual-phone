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

/** 知情范围：谁"知道"这条信息 */
export type Audience = "all" | "user" | "character" | "narrator";

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
  来源轮次?: number;
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
  audience?: Audience[]; // 新增：知情范围（防全知视角）
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

/** 执笔状态 */
export interface NarrativeWriterState {
  id: "default";
  当前基调: NarrativeTone;
  本轮档位: NarrativeGear;
  连续同档: number;
  目标: string[];
  目标来源: string[]; // memory card IDs
  当前弧光: string;
  阶段进度: number; // 0-1
  散落线头: string[];
  最近一次重档?: string; // ISO date
  停滞天数: number;
  status: "active" | "stalled" | "archived";
  specVersion: "v1.6";
  最后更新: string; // ISO date
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
export function createDefaultWriterState(): NarrativeWriterState {
  return {
    id: "default",
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
  lastCompressedAt: number; // 上次压缩时间戳
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
