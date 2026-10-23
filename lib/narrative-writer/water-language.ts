// lib/narrative-writer/water-language.ts
// 关系水位 → 一句话上限。纯函数，不读库、不调模型。
//
// 为什么要单独成模块：
// 「水位」这件事原来有两个说法——系统提示词里的 `L0→A｜L1→B…` 闸门速记（字母 A–E 在
// 规范 v1.5.1 §10.3 定义，代码里从没给出定义），和 recommender.ts 里的 WATER_LABELS 阶段名。
// 走向卡需要的是**能直接塞进提示词的一句人话**：既不能整包丢水位 JSON（模型会去数字段），
// 也不能只丢一个 L2（它不知道 L2 能做什么）。所以规则写死在这里，两处都从这里取。
//
// 口径来源：规范 v1.5.1 §10.4 水位上限表 + §10.5 突兀检测（冻结优先 / 戏外克制 / 降阶）。
// 一句话里只写"可出现什么、不宜什么"，不写 A–E 字母——字母在正文侧没有定义，写了就是黑话。

import type { WaterLevel, WaterLevelState } from "./types";

/** 阶段名（原 recommender.ts 里的 WATER_LABELS，抽到这里共用） */
export const WATER_LABELS: Record<string, string> = {
  L0: "刚认识",
  L1: "有点熟了",
  L2: "已经挺熟",
  L3: "关系不错",
  L4: "很亲密了",
  L5: "最亲密",
};

/**
 * 每一级"可以出现什么"。写法上刻意避开台账术语与字段名：
 * 这句话会进走向卡的任务文本，也会随卡片进正文提示词。
 */
const 可出现句: Record<WaterLevel, string> = {
  L0: "可出现问候、寒暄与信息交换，不宜任何暧昧试探",
  L1: "可出现主动帮忙与轻度关心，同一次会话最多 1 次，不宜碰私人话题",
  L2: "可出现玩笑、调侃与分享自己的事，不宜表白或定义关系",
  L3: "可出现邀约、制造独处与明确的在意，不宜承诺",
  L4: "可出现承诺与深度依赖的表达，须双向证据",
  L5: "可出现关系定义与共同承担的大事",
};

const 等级顺序: WaterLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];

/** 降一阶，已经到 L0 就停在 L0（不能再往下） */
function 降一阶(水位: WaterLevel): WaterLevel {
  const i = 等级顺序.indexOf(水位);
  if (i <= 0) return "L0";
  return 等级顺序[i - 1];
}

function 文本(值: unknown): string {
  return typeof 值 === "string" ? 值.trim() : "";
}

/** 最多列几条旧账 / 冻结项：再多就不是"一句话"了 */
const OVERLAY_ITEMS = 2;
/** 单条旧账 / 冻结项截到几字 */
const OVERLAY_CHARS = 12;

function 截断(值: string): string {
  return 值.length > OVERLAY_CHARS ? `${值.slice(0, OVERLAY_CHARS)}…` : 值;
}

/**
 * 一个作用域的水位 → 一句话上限。
 *
 * 叠加顺序固定：先给等级本身的上限，再叠降阶、冻结，最后才是旧账与别碰的项——
 * 越靠后越具体，模型读到的落点就越接近"这场不能做什么"。
 */
export function waterLevelGuidance(water: WaterLevelState): string {
  const 作用域 = 文本(water?.作用域) || "戏内层";
  const 原始水位 = (等级顺序.includes(water?.水位) ? water.水位 : "L0") as WaterLevel;
  const 状态 = 文本(water?.status) || "active";
  const 生效水位 = 状态 === "degraded" ? 降一阶(原始水位) : 原始水位;

  let 句子 = `${作用域} ${生效水位} ${WATER_LABELS[生效水位]}：${可出现句[生效水位]}`;
  if (状态 === "degraded" && 生效水位 !== 原始水位) {
    句子 += `（有越界记录，已降阶）`;
  }
  if (状态 === "frozen") {
    句子 += "；这一层此刻冻结，可出现的部分也先停在这里";
  }
  const 冲突 = (Array.isArray(water?.未解决冲突) ? water.未解决冲突 : [])
    .map(文本)
    .filter(Boolean)
    .slice(0, OVERLAY_ITEMS);
  if (冲突.length > 0) {
    句子 += `；旧账未了：${冲突.map(截断).join("、")}`;
  }
  const 冻结项 = (Array.isArray(water?.冻结项) ? water.冻结项 : [])
    .map(文本)
    .filter(Boolean)
    .slice(0, OVERLAY_ITEMS);
  if (冻结项.length > 0) {
    句子 += `；别碰：${冻结项.map(截断).join("、")}`;
  }
  return 句子;
}

/** 只有这两类卡会去比"戏外水位"：它们在演关系与内心，戏外的冷淡必须压着写 */
const 需要戏外克制 = new Set(["关系", "人物内心"]);

/**
 * 进走向卡的水位口径（栗子的拍板 4）：
 * - 戏内层：总是给；
 * - 共识层：只在 frozen 或有未解决冲突时给一句；
 * - 现实层：只在**低于戏内层**且卡类型是关系 / 人物内心时，给一句"戏外克制"。
 * 其余情况一个字都不加——三句水位全塞进任务文本，模型会开始逐条回应字段。
 */
export function planWaterGuidance(
  waterLevels: Record<string, WaterLevelState>,
  opts: { 类型: string }
): string {
  const 戏内 = waterLevels?.["戏内层"];
  const 句子: string[] = [];
  句子.push(
    戏内
      ? waterLevelGuidance(戏内)
      : `戏内层 L0 ${WATER_LABELS.L0}：${可出现句.L0}`
  );

  const 共识 = waterLevels?.["共识层"];
  const 共识有账 =
    Array.isArray(共识?.未解决冲突) && 共识.未解决冲突.map(文本).filter(Boolean).length > 0;
  if (共识 && (共识.status === "frozen" || 共识有账)) {
    const 账 = (共识.未解决冲突 ?? []).map(文本).filter(Boolean)[0];
    句子.push(
      共识.status === "frozen"
        ? `共识层 ${共识.水位} 已冻结`
        : `共识层 ${共识.水位} 旧账未了：${截断(账 ?? "")}`
    );
  }

  const 现实 = waterLevels?.["现实层"];
  const 戏内序号 = 等级顺序.indexOf(
    ((等级顺序.includes(戏内?.水位) ? 戏内.水位 : "L0") as WaterLevel)
  );
  const 现实序号 = 等级顺序.indexOf(
    (等级顺序.includes(现实?.水位) ? 现实.水位 : "L0") as WaterLevel
  );
  if (现实 && 需要戏外克制.has(opts?.类型 ?? "") && 现实序号 < 戏内序号) {
    句子.push("戏外克制：戏里再近，落在屏幕那头也要留出分寸");
  }

  return 句子.join("；");
}
