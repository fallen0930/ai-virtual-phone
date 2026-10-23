// lib/narrative-writer/banner-plan.ts
// 执笔插件 · 走向卡的"排片表"：类型由代码分配，目标由代码从悬念台账绑定。
//
// 为什么要把这一步从模型手里拿走（栗子的定稿）：
// 旧实现让模型自由发挥 4 个报幕，再让它照抄台账原文写 [推进:…] 标记。结果是
// 一次点击出什么方向全看模型心情，同一条线一会儿叫"老桥下的硬币"一会儿叫"硬币"，
// 标记照抄错一个字回写就静默失效。现在**方向类型与针对对象由代码决定**，模型只负责
// 把分配给它的那一格写成"标题｜发生的变化｜代价｜（报幕）"，标记也由代码生成。
//
// 三条边界：
// 1. 本模块是纯函数：不读库、不调模型、不碰 storage。输入是调用方读好的卡池与水位。
// 2. 走向卡是唯一的方向候选出口：剧情预告（现素材库）只喂倾向输入，不再自称推荐方向。
// 3. 类型换成语义邻近的类型时必须留痕（计划类型 ≠ 类型 → 已替换），不能假装按原计划出了卡。
//
// 两条硬规则（栗子拍板）：
// - 主线只绑"醒着的线"（爆发 / 升温）。一条都没有时按替补表换类型并标注，绝不退到潜伏线：
//   潜伏线是还没启动的线，把它当主线推进等于硬凑剧情，而且会让"该收的伏笔"被提前用掉。
// - 同一批里一条线最多绑一张卡。目标被占时，能换兜底（伏笔 / 环境）的换兜底；
//   关系卡不硬塞第二条线，改为不绑目标、只靠水位上限演分寸。

import {
  BANNER_BATCH_COUNT,
  BANNER_RECENT_TYPES_KEEP,
  normalizeBannerBatch,
  normalizeRecentBannerTypes,
} from "./types";
import type {
  BannerType,
  EmotionCard,
  ForeshadowCard,
  MemoryCard,
  ThreadCard,
  ThreadPlotStatus,
  WaterLevelState,
} from "./types";
import { normalizeThreadName, stripBannerMarkers } from "./threads";
import { planWaterGuidance } from "./water-language";

/** 三组轮换的默认排片（栗子给定的顺序，不再由模型自由出方向） */
export const BANNER_GROUPS: BannerType[][] = [
  ["主线", "关系", "变数"],
  ["世界动向", "伏笔回收", "人物内心"],
  ["升支线", "缓冲日常带暗线", "意外转折带因果"],
];

/** 最近几次的类型要避开（3 张一批 → 大约两批） */
export const RECENT_TYPES_KEEP = BANNER_RECENT_TYPES_KEEP;

/** 任务文本长度上限：提示词必须短，超了就是设计跑偏 */
export const BANNER_TASK_MAX_CHARS = 600;

/** 报幕字数上限（沿用执笔规范里报幕的 ≤40 字） */
export const BANNER_CHARS_MAX = 40;

/** 目标种类：线索 / 伏笔 / 记忆卡 / 情感卡 / 环境兜底 */
export type BannerTargetKind = "thread" | "foreshadow" | "memory" | "emotion" | "environment";

export interface BannerTarget {
  kind: BannerTargetKind;
  /** 台账卡 id：环境兜底没有 id */
  id?: string;
  /** 展示与匹配用的名字（线索名 / 伏笔内容 / 卡片内容摘要） */
  名称: string;
}

/** 采纳这张卡时要回写什么；没有这个字段 = 这张卡永不回写台账 */
export interface BannerWriteBack {
  类型: "推进" | "回收";
  /** 推进：线索名（与台账同一份原文，代码生成标记所以不会再照抄错） */
  名称?: string;
  /** 回收：伏笔内容 */
  内容?: string;
  /** 推进后的剧情态：代码算好的"最多升一级"，模型无权改 */
  新状态?: ThreadPlotStatus;
}

export interface BannerPlanCard {
  /** 卡片 id：缓冲区的去重键用它（不再拿报幕文本比对） */
  id: string;
  /** 实际出的类型 */
  类型: BannerType;
  /** 这一格的排片类型；与 类型 不同就是被替补过 */
  计划类型: BannerType;
  已替换: boolean;
  /** 绑到的台账对象；关系卡没有合适的线时可以为空（仍出卡） */
  目标?: BannerTarget;
  /** 一句话水位上限，由 water-language 生成；这是唯一进正文提示词的水位形式 */
  上限: string;
  /** 这张卡的报幕是不是代码兜底出来的（缺行时由 writer 置 true） */
  骨架: boolean;
  回写?: BannerWriteBack;
}

export interface BannerPlanInput {
  threads?: ThreadCard[];
  foreshadows?: ForeshadowCard[];
  memories?: MemoryCard[];
  emotions?: EmotionCard[];
  waterLevels?: Record<string, WaterLevelState>;
  当前角色?: string;
  当前轮次?: number;
  批次序号?: number;
  最近走向类型?: unknown;
}

/** 行解析结果：形态只有四种，缺行与全废的降级路径不同 */
export type BannerLineForm = "结构化" | "宽松" | "骨架" | "纯文本";

export interface ParsedBannerLine {
  标题: string;
  变化: string;
  代价: string;
  报幕: string;
  形态: BannerLineForm;
}

/**
 * 类型的中性说法。
 *
 * 这是正文侧唯一能看到的"方向说明"：走向卡的类型名里有台账术语（伏笔回收），
 * 而台账术语永远不该出现在正文提示词里（角色不知道自己是一条伏笔）。
 * 所以正文只拿到这句中性话 + 一句话上限。
 */
const 中性说法: Record<BannerType, string> = {
  主线: "把手头那件事往前推一步",
  关系: "让这段关系靠近一点",
  变数: "放进一个新变量",
  世界动向: "外界传来新动静",
  伏笔回收: "一件旧事有了下文",
  人物内心: "角色心里过一道坎",
  升支线: "开一条新的支线",
  缓冲日常带暗线: "日常场面里留一条暗线",
  意外转折带因果: "一个有来由的意外",
};

/** 拿不到类型名时的兜底说法（旧缓冲区里的无类型卡走这里） */
export function bannerTypeAlias(类型: unknown): string {
  return 中性说法[类型 as BannerType] ?? "顺着当前场面自然往下走";
}

/**
 * 替补表：这一格的对象不存在时，按顺序往后换类型。
 *
 * 表头是栗子在测试 10 里钉死的三条（主线→伏笔回收、关系→人物内心、变数→世界动向），
 * 其余位置按"语义邻近"排：都还在说同一件事，只是换了着眼点。
 * 恒可用的三类（关系 / 变数 / 世界动向）保证任何一批都能出满三张——
 * 宁可换方向，也不给空卡、不抛错。
 */
const 替补表: Record<BannerType, BannerType[]> = {
  主线: ["伏笔回收", "意外转折带因果", "世界动向", "人物内心", "升支线", "缓冲日常带暗线", "变数", "关系"],
  关系: ["人物内心", "缓冲日常带暗线", "变数", "世界动向", "伏笔回收", "意外转折带因果", "升支线", "主线"],
  变数: ["世界动向", "缓冲日常带暗线", "升支线", "人物内心", "伏笔回收", "意外转折带因果", "主线", "关系"],
  世界动向: ["变数", "缓冲日常带暗线", "人物内心", "升支线", "伏笔回收", "意外转折带因果", "主线", "关系"],
  伏笔回收: ["主线", "意外转折带因果", "世界动向", "缓冲日常带暗线", "升支线", "人物内心", "变数", "关系"],
  人物内心: ["关系", "缓冲日常带暗线", "变数", "世界动向", "伏笔回收", "意外转折带因果", "升支线", "主线"],
  升支线: ["世界动向", "变数", "缓冲日常带暗线", "人物内心", "伏笔回收", "意外转折带因果", "主线", "关系"],
  缓冲日常带暗线: ["人物内心", "变数", "世界动向", "关系", "伏笔回收", "意外转折带因果", "升支线", "主线"],
  意外转折带因果: ["世界动向", "主线", "伏笔回收", "缓冲日常带暗线", "升支线", "人物内心", "变数", "关系"],
};

/** 这三类永远能出卡：它们不要求台账里存在特定对象 */
const 恒可用: BannerType[] = ["关系", "变数", "世界动向"];

/** 会回写台账的类型：只有"确实推进了某条线 / 收了某个伏笔"的才写 */
const 回写类型: BannerType[] = ["主线", "关系", "伏笔回收", "升支线", "意外转折带因果"];

/** 剧情态只升一级，收束永远不由自动回写产生 */
const 推进一级: Partial<Record<ThreadPlotStatus, ThreadPlotStatus>> = {
  潜伏: "升温",
  升温: "爆发",
  爆发: "爆发",
};

// ── 卡池清洗：与导演上下文用同一套"还可用"的口径 ──

function 文本(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function 可用线索池(threads: ThreadCard[]): ThreadCard[] {
  return (Array.isArray(threads) ? threads : []).filter(
    (t) =>
      t &&
      typeof t === "object" &&
      t.状态 !== "归档" &&
      t.状态 !== "冲突" &&
      t.状态 !== "陈旧" &&
      t.线索状态 !== "收束" &&
      文本(t.名称) !== ""
  );
}

function 可用伏笔池(foreshadows: ForeshadowCard[]): ForeshadowCard[] {
  return (Array.isArray(foreshadows) ? foreshadows : []).filter(
    (f) =>
      f &&
      typeof f === "object" &&
      f.状态 !== "归档" &&
      f.状态 !== "冲突" &&
      f.状态 !== "陈旧" &&
      f.伏笔状态 !== "已收" &&
      文本(f.内容) !== ""
  );
}

/** 线索排序：越接近爆发越优先，同状态时最久没推进的优先 */
function 线索权重(t: ThreadCard): number {
  return t.线索状态 === "爆发" ? 0 : t.线索状态 === "升温" ? 1 : t.线索状态 === "潜伏" ? 2 : 9;
}

function 线索优先(a: ThreadCard, b: ThreadCard): number {
  const 差 = 线索权重(a) - 线索权重(b);
  if (差 !== 0) return 差;
  return (a.上次推进轮次 ?? 0) - (b.上次推进轮次 ?? 0);
}

/** 伏笔排序：已超期的优先，其次窗口最临近的 */
function 伏笔优先(当前轮次: number) {
  return (a: ForeshadowCard, b: ForeshadowCard): number => {
    const 超期A = a.预期回收窗口?.止 !== undefined && a.预期回收窗口.止 < 当前轮次 ? 0 : 1;
    const 超期B = b.预期回收窗口?.止 !== undefined && b.预期回收窗口.止 < 当前轮次 ? 0 : 1;
    if (超期A !== 超期B) return 超期A - 超期B;
    return (a.预期回收窗口?.止 ?? 0) - (b.预期回收窗口?.止 ?? 0);
  };
}

function 是待核(状态: unknown): boolean {
  return 状态 === "待核";
}

/** 角色侧的内心素材：自我认知 / 行为模式 / 关系共识，或角色的一条情感 */
function 内心素材池(memories: MemoryCard[], emotions: EmotionCard[]): (MemoryCard | EmotionCard)[] {
  const 记忆 = (Array.isArray(memories) ? memories : []).filter(
    (m) =>
      m &&
      typeof m === "object" &&
      m.状态 !== "归档" &&
      m.主体 === "角色" &&
      (m.主类型 === "自我认知" || m.主类型 === "行为模式" || m.主类型 === "关系共识")
  );
  const 情感 = (Array.isArray(emotions) ? emotions : []).filter(
    (e) => e && typeof e === "object" && e.状态 !== "归档" && e.主体 === "角色"
  );
  return [...记忆, ...情感];
}

function 世界变更池(memories: MemoryCard[]): MemoryCard[] {
  return (Array.isArray(memories) ? memories : []).filter(
    (m) => m && typeof m === "object" && m.状态 !== "归档" && m.主类型 === "世界变更"
  );
}

function 待核池(memories: MemoryCard[]): MemoryCard[] {
  return (Array.isArray(memories) ? memories : []).filter(
    (m) => m && typeof m === "object" && 是待核(m.状态) && 文本(m.内容) !== ""
  );
}

/** 记忆卡进任务文本时只取内容前若干字，避免整段卡文塞进提示词 */
const 名称摘要字数 = 20;
function 卡名(内容: string): string {
  return 内容.length > 名称摘要字数 ? `${内容.slice(0, 名称摘要字数)}…` : 内容;
}

interface 绑定结果 {
  目标?: BannerTarget;
  回写?: BannerWriteBack;
}

/** 排片要看的四个池子：两类悬念资产 + 两类素材 */
interface 卡池 {
  线索: ThreadCard[];
  伏笔: ForeshadowCard[];
  记忆: MemoryCard[];
  情感: EmotionCard[];
  内心: (MemoryCard | EmotionCard)[];
  变更: MemoryCard[];
}

/**
 * 素材池：判断"这一格有没有对象可绑"。
 * 可用判定只看池子里有没有这类对象，不看是否已被同批占用——
 * 占用只影响能不能绑到，不影响能不能出这类卡；被占满时由绑定阶段退兜底或不绑。
 */
function 有素材(类型: BannerType, 池: 卡池): boolean {
  switch (类型) {
    case "主线":
      // 只有爆发/升温才算"醒着的线"；潜伏线交给升支线，不拿来顶主线
      return 池.线索.some((t) => t.线索状态 === "爆发" || t.线索状态 === "升温");
    case "升支线":
      return 池.线索.some((t) => t.线索状态 === "潜伏");
    case "伏笔回收":
      return 池.伏笔.length > 0;
    case "缓冲日常带暗线":
    case "意外转折带因果":
      return 池.线索.length + 池.伏笔.length > 0;
    case "人物内心":
      return 池.内心.length > 0;
    default:
      // 关系 / 变数 / 世界动向：恒可用
      return true;
  }
}

// ── 主函数：分配一批三张 ──

export function assignBannerPlan(input: BannerPlanInput): BannerPlanCard[] {
  const 记忆 = Array.isArray(input.memories) ? input.memories : [];
  const 情感 = Array.isArray(input.emotions) ? input.emotions : [];
  const 线索 = 可用线索池(input.threads ?? []);
  const 伏笔 = 可用伏笔池(input.foreshadows ?? []);
  const 池: 卡池 = {
    线索,
    伏笔,
    记忆,
    情感,
    内心: 内心素材池(记忆, 情感),
    变更: 世界变更池(记忆),
  };
  const 待核 = 待核池(记忆);

  const 当前轮次 = Number.isFinite(input.当前轮次) ? Math.floor(input.当前轮次 ?? 0) : 0;
  const 当前角色 = 文本(input.当前角色);
  const 批次序号 = 归一批次(input.批次序号);
  const 最近 = 归一最近类型(input.最近走向类型);
  const 组 = BANNER_GROUPS[批次序号] ?? BANNER_GROUPS[0];

  const 已用类型 = new Set<BannerType>();
  const 已占目标 = new Set<string>();
  const cards: BannerPlanCard[] = [];

  组.forEach((计划类型, slot) => {
    const 被占 = (类型: BannerType) =>
      !恒可用.includes(类型) && !有素材(类型, 池);
    let 类型 = 计划类型;
    let 已替换 = false;

    // 两种情况要换类型：这一格根本没有对象，或这个类型刚出过（最近 6 条里出现过）
    if (被占(计划类型) || 最近.includes(计划类型)) {
      const 候选 = 替补表[计划类型] ?? [];
      const 换上 = 候选.find(
        (候补) => !被占(候补) && !已用类型.has(候补) && !最近.includes(候补)
      );
      if (换上) {
        类型 = 换上;
        已替换 = true;
      }
      // 一个候选都没剩下（九种类型被占满）时保持原类型：宁可不换，也不出空卡
    }
    已用类型.add(类型);

    const 绑定 = 绑定目标(类型, {
      池,
      待核,
      当前角色,
      当前轮次,
      已占目标,
    });
    if (绑定.目标?.id) 已占目标.add(绑定.目标.id);

    cards.push({
      id: `bc_${批次序号}_${slot}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      类型,
      计划类型,
      已替换,
      ...(绑定.目标 ? { 目标: 绑定.目标 } : {}),
      上限: planWaterGuidance(input.waterLevels ?? {}, { 类型 }),
      骨架: false,
      ...(绑定.回写 ? { 回写: 绑定.回写 } : {}),
    });
  });

  return cards;
}

function 绑定目标(
  类型: BannerType,
  ctx: {
    池: 卡池;
    待核: MemoryCard[];
    当前角色: string;
    当前轮次: number;
    已占目标: Set<string>;
  }
): 绑定结果 {
  const { 池, 已占目标 } = ctx;
  // 同一批里一条线 / 一张素材最多绑一张卡：全被占用时宁可退兜底，也不复用。
  // 三张卡盯同一个对象，看起来有三个方向，其实只是在同一件事上换三种说法。
  const 未占用 = <T extends { id?: string }>(list: T[]): T[] =>
    list.filter((item) => !item.id || !已占目标.has(item.id));

  const 推进回写 = (t: ThreadCard): BannerWriteBack => ({
    类型: "推进",
    名称: t.名称,
    新状态: 推进一级[t.线索状态] ?? t.线索状态,
  });

  switch (类型) {
    case "主线": {
      // 只绑爆发/升温；一条醒着的线都没有时，assignBannerPlan 已按替补表换过类型
      const 线 = 未占用(
        [...池.线索]
          .filter((t) => t.线索状态 === "爆发" || t.线索状态 === "升温")
          .sort(线索优先)
      )[0];
      if (!线) return {};
      return {
        目标: { kind: "thread", id: 线.id, 名称: 线.名称 },
        回写: 推进回写(线),
      };
    }
    case "关系": {
      const 我的 = 未占用(
        [...池.线索]
          .filter(
            (t) =>
              Array.isArray(t.关联角色) &&
              ctx.当前角色 !== "" &&
              t.关联角色.some((r) => 文本(r) === ctx.当前角色)
          )
          .sort(线索优先)
      );
      const 线 = 我的[0];
      // 没有本角色的线、或那条线已被同批主线绑走：不硬绑，照样出卡，靠一句话上限演关系
      return 线
        ? {
            目标: { kind: "thread", id: 线.id, 名称: 线.名称 },
            回写: 推进回写(线),
          }
        : {};
    }
    case "变数": {
      // 待核卡 → 未收伏笔 → 环境；永不绑线索（变数不该让台账里某条线"被推进"）
      const 卡 = 未占用(ctx.待核)[0];
      if (卡) return { 目标: { kind: "memory", id: 卡.id, 名称: 卡名(卡.内容) } };
      const 伏 = 未占用([...池.伏笔].sort(伏笔优先(ctx.当前轮次)))[0];
      if (伏) return { 目标: { kind: "foreshadow", id: 伏.id, 名称: 伏.内容 } };
      return { 目标: { kind: "environment", 名称: "在场的人与周围的环境" } };
    }
    case "世界动向": {
      const 变更 = 未占用(池.变更)[0];
      return 变更
        ? { 目标: { kind: "memory", id: 变更.id, 名称: 卡名(变更.内容) } }
        : { 目标: { kind: "environment", 名称: "外面的动静" } };
    }
    case "伏笔回收": {
      const 伏 = 未占用([...池.伏笔].sort(伏笔优先(ctx.当前轮次)))[0];
      if (!伏) return {};
      return {
        目标: { kind: "foreshadow", id: 伏.id, 名称: 伏.内容 },
        回写: { 类型: "回收", 内容: 伏.内容 },
      };
    }
    case "人物内心": {
      // 记忆卡取内容，情感卡取标签：两类素材在任务文本里都只是"一个名字"
      const 内心 = 未占用(
        池.内心 as Array<{ id?: string; 内容?: string; 标签?: string }>
      )[0];
      if (!内心) return {};
      const 名称 = 内心.内容 ? 卡名(内心.内容) : 文本(内心.标签) || "角色心里的事";
      return {
        目标: { kind: 内心.内容 ? "memory" : "emotion", id: 内心.id, 名称 },
      };
    }
    case "升支线": {
      const 潜伏 = 未占用(
        池.线索.filter((t) => t.线索状态 === "潜伏").sort(线索优先)
      )[0];
      if (!潜伏) return {};
      return {
        目标: { kind: "thread", id: 潜伏.id, 名称: 潜伏.名称 },
        回写: 推进回写(潜伏),
      };
    }
    case "缓冲日常带暗线":
    case "意外转折带因果": {
      // 两类都要"有东西可挂"，但都不该把线推到下一个剧情态：
      // 缓冲日常带暗线不推进台账；意外转折带因果只有绑到线索时才回写。
      const 线 = 未占用([...池.线索].sort(线索优先))[0];
      if (线) {
        return {
          目标: { kind: "thread", id: 线.id, 名称: 线.名称 },
          ...(类型 === "意外转折带因果" ? { 回写: 推进回写(线) } : {}),
        };
      }
      const 伏 = 未占用([...池.伏笔].sort(伏笔优先(ctx.当前轮次)))[0];
      if (伏) return { 目标: { kind: "foreshadow", id: 伏.id, 名称: 伏.内容 } };
      return { 目标: { kind: "environment", 名称: "当下这个场面" } };
    }
    default:
      return {};
  }
}

/**
 * 批次与最近类型的归一化住在 types.ts（领域词表旁边），因为 storage 读旧存档时
 * 要用同一套规则；这里只取别名，避免两份实现漂移。
 */
const 归一批次 = normalizeBannerBatch;
const 归一最近类型 = normalizeRecentBannerTypes;

/** 下一批的指针：三组轮换，用完回到第一组 */
export function nextBannerBatch(当前: unknown): number {
  return (归一批次(当前) + 1) % BANNER_BATCH_COUNT;
}

// ── 任务提示词：只含分配结果，不含水位 JSON ──

/** 提示词里给模型看的数量用中文数字，"只输出这3行"这种混排模型更容易看漏 */
const 中文数字 = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function 数量词(n: number): string {
  return 中文数字[n] ?? String(n);
}

/**
 * 超长时要砍的水位附加句，按"越不伤分寸越先砍"的顺序：
 * 戏外克制只是一句提醒 → 冻结项/旧账是具体禁区，可以最后再丢。
 * 基础句（等级 + 可出现/不宜）永远保留：那是这张卡的分寸本身。
 */
const 水位附加句: RegExp[] = [
  /；?戏外克制：[^；]*/g,
  /；?别碰：[^；]*/g,
  /；?旧账未了：[^；]*/g,
];

function 压缩上限(上限: string, 阶段: number): string {
  let 句 = 上限;
  for (let i = 0; i < 阶段 && i < 水位附加句.length; i += 1) {
    句 = 句.replace(水位附加句[i], "");
  }
  return 句.replace(/；{2,}/g, "；").replace(/；$/, "").trim();
}

export function buildBannerTaskText(cards: BannerPlanCard[]): string {
  const 卡 = Array.isArray(cards) ? cards : [];
  const 拼 = (阶段: number, 留回写说明: boolean): string => {
    const 行 = 卡.map((card, i) => {
      const 目标 = card.目标
        ? `目标：${card.目标.名称}`
        : "目标：没有具体对象，按当前场面自由发挥";
      const 换 = card.已替换
        ? `（本批没有${card.计划类型}可用的素材，已改为${card.类型}）`
        : "";
      return `${i + 1} ${card.类型}${换}（${中性说法[card.类型] ?? ""}）｜${目标}｜${压缩上限(
        card.上限,
        阶段
      )}`;
    });
    const 块 = [
      `按上面的顺序写${数量词(行.length)}张走向卡，一张一行，字段用｜分隔且顺序固定：`,
      `标题｜发生的变化｜代价｜（报幕：括号包裹，不超过${BANNER_CHARS_MAX}字）`,
      ...行,
      `只输出这${数量词(行.length)}行，不要输出分析过程、不要额外说明。`,
      `报幕里的"注意："只允许出现在变数与意外转折带因果这两类，其余类型不要用。`,
    ];
    if (留回写说明) 块.push(`不要自己写 [推进:…] 或 [回收:…]，回写标记由代码按卡片生成。`);
    return 块.join("\n");
  };

  // 上限是设计约束：超限先压水位句，三张卡的类型/目标/分寸一句不砍；
  // 全压完还超，才去掉最后一条"不要自己写标记"的说明。绝不在行中间硬截。
  for (let 阶段 = 0; 阶段 <= 水位附加句.length; 阶段 += 1) {
    const 文本 = 拼(阶段, true);
    if (文本.length <= BANNER_TASK_MAX_CHARS) return 文本;
  }
  return 拼(水位附加句.length, false);
}

// ── 解析：按行序与类型绑定，宽松到不会为一行格式作废整批 ──

/** 行首的序号与列表符：`1. ` / `3) ` / `- ` / `* ` / `• ` / `3、` */
const 行首序号 = /^\s*(?:[-*•]|\d+\s*[.)、])\s*/;

/** 代码块围栏：模型很爱把三行包进 ``` 里，围栏不该让行作废 */
const 围栏 = /^\s*```.*$/;

function 清理行(raw: string): string {
  const 去围栏 = raw.replace(/```[a-zA-Z]*/g, "");
  const 一行 = 去围栏.split("\n").join(" ").trim();
  return stripBannerMarkers(一行.replace(行首序号, "")).trim();
}

/**
 * 把模型返回的文本按行序绑到分配好的卡上。
 *
 * 返回长度恒等于 cards.length：某一行缺了就用代码骨架报幕补上，
 * 三张是硬要求——面板上少一张，她就少一个方向可挑，而这是这一版最不该发生的事。
 */
export function parseBannerLines(raw: string, cards: BannerPlanCard[]): ParsedBannerLine[] {
  const 原始行 = typeof raw === "string" ? raw.split("\n").map((line) => line.trim()) : [];
  // 只去掉围栏行；空行必须保留——它代表"模型这一行没写"，去掉会让后面的行前移，
  // 三张卡就全绑错类型了。开头的空行例外：那是响应的前导换行，不是缺行。
  const 有效行 = 原始行.filter((line) => !围栏.test(line));
  while (有效行.length > 0 && 有效行[0] === "") 有效行.shift();
  const 结果: ParsedBannerLine[] = [];
  for (let i = 0; i < (Array.isArray(cards) ? cards.length : 0); i += 1) {
    const 行 = 有效行[i] ?? "";
    结果.push(解析一行(行, cards[i]));
  }
  return 结果;
}

function 解析一行(行: string, card: BannerPlanCard): ParsedBannerLine {
  const 清理 = 清理行(行);
  const 起 = 清理.indexOf("（");
  const 止 = 清理.lastIndexOf("）");
  if (起 === -1 || 止 <= 起) {
    // 找不到括号对 = 这一行没有报幕 = 缺行，用代码骨架补一条
    const 骨架 = skeletonBanner(card);
    return { 标题: "", 变化: "", 代价: "", 报幕: 骨架, 形态: "骨架" };
  }
  const 报幕 = 清理.slice(起, 止 + 1);
  const 前后 = `${清理.slice(0, 起)} ${清理.slice(止 + 1)}`.trim();
  const 段 = 前后
    .split(/[｜|]/)
    .map((s) => s.replace(/^[\s:：]+|[\s:：]+$/g, "").trim())
    .filter((s) => s !== "");
  if (段.length >= 3) {
    return {
      标题: 段[0],
      变化: 段[1],
      // 第四段以后仍然属于"代价"：模型偶尔会把代价写成两句
      代价: 段.slice(2).join("，"),
      报幕,
      形态: "结构化",
    };
  }
  return { 标题: 前后, 变化: "", 代价: "", 报幕, 形态: "宽松" };
}

/**
 * 代码骨架报幕：格式合法、字数合规、不含台账术语。
 *
 * 这是"模型没写这一行"时的兜底，故意写得像占位符而不像成品：
 * 一眼看得出是代码补的，她才不会被一条看起来很漂亮的报幕骗过去。
 */
export function skeletonBanner(card: BannerPlanCard): string {
  const 说法 = (中性说法[card?.类型 as BannerType] ?? "顺着当前场面").slice(0, 14);
  const 骨架 = `（走向：${说法}｜细节待补）`;
  return 骨架.length > BANNER_CHARS_MAX ? `${骨架.slice(0, BANNER_CHARS_MAX - 1)}）` : 骨架;
}

/**
 * 标记由代码生成：目标与状态取自卡（都是台账原文），"变化"文本取自模型那一句。
 *
 * 旧实现让模型照抄线索名，一个标点不符就静默失配；现在模型根本不需要知道标记长什么样。
 * 不推进台账的类型（变数 / 世界动向 / 人物内心 / 缓冲日常带暗线）返回空串。
 */
export function bannerMarker(card: BannerPlanCard | undefined, 变化: string): string {
  const 回写 = card?.回写;
  if (!回写) return "";
  if (回写.类型 === "回收") {
    const 内容 = normalizeThreadName(回写.内容 ?? "") ? 回写.内容!.trim() : "";
    return 内容 ? `[回收:${内容}]` : "";
  }
  const 名称 = 文本(回写.名称);
  if (!名称) return "";
  const 新状态 = 文本(回写.新状态);
  if (!新状态) return "";
  const 变化文本 = 文本(变化) || 名称;
  return `[推进:${名称}→${新状态}:${变化文本}]`;
}

/** 这张卡能不能回写台账：类型允许 + 行是模型真写的（骨架与纯文本都不算） */
export function 可回写(card: BannerPlanCard, 形态: BannerLineForm, 变化: string): boolean {
  if (!回写类型.includes(card.类型)) return false;
  if (card.骨架) return false;
  if (形态 !== "结构化" && 形态 !== "宽松") return false;
  // 回收标记不需要"变化"文本；推进标记没有变化内容就没什么可记
  if (card.回写?.类型 === "回收") return 文本(card.回写.内容) !== "";
  return 文本(变化) !== "" && 文本(card.回写?.名称) !== "";
}
export const canWriteBack = 可回写;
