// lib/narrative-writer/writer.ts
// 执笔插件 · 剧情自主书写引擎
//
// 依据：《角色记忆与情感规范 v1.6》派生件 D（执笔插件 Prompt）
// 调用约束：一次点击 = 一次 API 调用 = 一次输出

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveMixApiConfig } from "@/lib/mixology/engine";
import { getMemoryCards, getEmotionCards, getWaterLevels, getWriterState, saveWriterState, saveMemoryCard, getContextHierarchy, requireSessionId } from "./storage";
import type { MemoryCard, EmotionCard, WaterLevelState, NarrativeWriterState, ContextHierarchy } from "./types";
import { createDefaultWriterState } from "./types";

const WRITER_SYSTEM_PROMPT = `你是「执笔」，一个独自完成剧情方向判断与正文书写的角色扮演 AI。玩家可能只给一句倾向，也可能什么都不给；方向、节奏、转折、正文全部由你判断和书写。你在同一次输出内完成全部工作，阶段过程不输出给用户，只输出最终结果。

# 输入
- 人设、世界观（最高优先级）
- [连续性上下文]（记忆 ≤5 + 情感 ≤3）
- [关系水位]（三作用域，含 status）
- [执笔状态]（基调、档位、连续同档、目标、弧光、散落线头、停滞天数）
- 玩家倾向（0–N 个自然语言片段，可选）
缺失水位按 L0 + active；缺失执笔状态按"无目标、中速"处理。

# 视角限制（最高优先级红线）
你的知识库包含上帝视角的设定，但你只能使用你所扮演角色能听到、看到、推测到的东西。
- 连续性上下文里的记忆卡/情感卡已经过 audience 过滤，只包含你的角色能知道的信息
- 如果某条信息标记为 audience=["user"]，你的角色不知道这件事
- 如果某条信息标记为 audience=["narrator"]，这是世界设定但你的角色尚未察觉
- 不要主动提及你的角色不可能知道的信息
- 如果剧情需要信息差，让角色通过对话/观察/推理逐步发现，不要直接"知道"

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
 * 防全知视角过滤：只保留当前角色能知道的信息
 * - audience 包含 "all" → 所有人都知道
 * - audience 包含 "character" → 当前角色知道
 * - audience 包含 "narrator" → 只有旁白知道（角色不知道，过滤掉）
 * - audience 包含 "user" → 只有用户知道（角色不知道，过滤掉）
 * - 没有 audience 字段 → 兼容旧数据，默认保留
 */
function filterByAudience<T extends { audience?: string[] }>(
  items: T[],
  currentCharacter: string
): T[] {
  return items.filter(item => {
    if (!item.audience || item.audience.length === 0) return true; // 兼容旧数据
    return item.audience.includes("all") || item.audience.includes("character");
  });
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
 * 构建连续性上下文字符串
 */
function buildContinuityContext(
  memories: MemoryCard[],
  emotions: EmotionCard[],
  waterLevels: Record<string, WaterLevelState>,
  writerState: NarrativeWriterState,
  hierarchy?: ContextHierarchy | null
): string {
  const parts: string[] = [];

  // 记忆卡 (最多5条)
  if (memories.length > 0) {
    parts.push("[连续性上下文]");
    memories.slice(0, 5).forEach((m) => {
      parts.push(`- ${m.主类型}：${m.内容}（${m.作用域}，${m.时间 || "未知"}）`);
    });
  }

  // 情感卡 (最多3条)
  if (emotions.length > 0) {
    emotions.slice(0, 3).forEach((e) => {
      parts.push(`- 瞬时情绪：${e.主体}${e.标签}(${e.强度})，对象${e.对象 || "无"}`);
    });
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

  // 执笔状态
  parts.push("[执笔状态]");
  parts.push(
    `- 当前基调：${writerState.当前基调}｜本轮档位：${writerState.本轮档位}｜连续同档：${writerState.连续同档}`
  );
  if (writerState.目标.length > 0) {
    parts.push(`- 目标：${writerState.目标.join("、")}（进度 ${writerState.阶段进度}`);
  }
  if (writerState.散落线头.length > 0) {
    parts.push(`- 散落线头：${writerState.散落线头.length} 条（${writerState.散落线头.join("、")}`);
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
  // 防全知视角过滤
  const memories = filterByAudience(allMemories, input.characterProfile.charName);
  const emotions = filterByAudience(allEmotions, input.characterProfile.charName);
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
  const banner = lines[0] || "（基调：自主｜场景：未知｜走向：待展开）"; // 兜底报幕
  const body = lines.slice(2).join("\n") || response; // 如果格式不对,直接用全文

  // 6. 元数据推断
  const metadata = inferMetadata(banner, body);

  // 这里不抽取：正文还没进对话，抽出来的卡没有消息可归属。
  // 抽取统一发生在 insertNarrativeTurn 落库之后（那时才有来源消息ID与轮次）。

  return { banner, body, metadata };
}

/**
 * 生成多个报幕选项供用户选择（选择模式第一步）
 */
export async function generateBannerOptions(input: WriterInput): Promise<string[]> {
  const allMemories = await getMemoryCards(input.sessionId, { status: "生效" });
  const allEmotions = await getEmotionCards(input.sessionId, { status: "生效" });
  // 防全知视角过滤
  const memories = filterByAudience(allMemories, input.characterProfile.charName);
  const emotions = filterByAudience(allEmotions, input.characterProfile.charName);
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
    任务: `请深度分析当前剧情状态后，生成4个不同的剧情发展方向报幕。

分析步骤（在内心完成，不输出）：
1. 从最近对话中提取：当前场景、在场人物、未解决的 tension/冲突点、角色情绪状态
2. 从连续性上下文中识别：散落线头、未解决冲突、水位状态、执笔目标
3. 思考3-5个可能的推进方向：日常缓冲 / 关系推进 / 冲突爆发 / 信息揭露 / 环境触发
4. 评估每个方向的有趣性、节奏合理性、与人设/水位的兼容性

生成4个报幕（每行一个，用括号包裹，≤40字）：
- 1-2个基于玩家倾向（如果有）
- 其余由你自主判断，优先选择能推动剧情或深化关系的选项
- 至少包含1个转折预告（用"注意："标记）
- 避免重复或相似的方向

格式示例：
（基调：X｜场景：Y｜走向：Z）
（基调：X｜场景：Y｜注意：这轮会有一个……）`,
  });

  const messages: LLMMessage[] = [
    { role: "system", content: WRITER_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await callNarrativeLLM(messages);
  
  // 解析报幕选项（每行一个）
  const lines = response.split("\n").filter(line => line.trim().startsWith("（") && line.trim().endsWith("）"));
  return lines.slice(0, 4).map(line => line.trim());
}

/**
 * 根据选中的报幕生成正文（选择模式第二步）
 */
export async function writeWithSelectedBanner(
  input: WriterInput,
  selectedBanner: string
): Promise<WriterOutput> {
  const allMemories = await getMemoryCards(input.sessionId, { status: "生效" });
  const allEmotions = await getEmotionCards(input.sessionId, { status: "生效" });
  // 防全知视角过滤
  const memories = filterByAudience(allMemories, input.characterProfile.charName);
  const emotions = filterByAudience(allEmotions, input.characterProfile.charName);
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
    任务: `请根据以下报幕方向生成正文内容：\n\n报幕：${selectedBanner}\n\n请严格按照执笔规范书写正文，确保内容与报幕方向一致。`,
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
  const banner = selectedBanner; // 使用选中的报幕
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
