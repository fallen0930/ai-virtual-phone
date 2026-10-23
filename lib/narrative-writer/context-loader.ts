// lib/narrative-writer/context-loader.ts
// 执笔插件 · 上下文加载器：从 mixology session 提取人设、世界观、约束等
//
// 数据源优先级：
// 1. 当前活跃的 mixology session（recipe 中的 materials）——只认 localStorage 里的 activeId
// 2. 执笔状态、关系水位按会话从 kv-db 读取，必须带上 sessionId

import { getMixSession } from "@/lib/mixology/storage";
import type { MixSession, MixCharacterCard, MixTextMaterial } from "@/lib/mixology/types";
import { resolveMixRecipeMaterials } from "@/lib/mixology/storage";
import { getWriterState, getWaterLevels, requireSessionId } from "./storage";
import type { NarrativeWriterState, WaterLevelState } from "./types";
import { createDefaultWriterState } from "./types";

/** 从 mixology session 提取的人设与世界观信息 */
export interface CharacterWorldContext {
  characterProfile: {
    charName: string;
    baseInfo?: string;
    personality?: string;
    appearance?: string;
    background?: string;
    worldview?: string; // 世界观
    cognition?: string;
    relations?: string;
    plot?: string;
    extra?: string;
    profileText?: string; // freeform 模式
    worldText?: string; // freeform 模式
  };
  userPersona?: {
    userName?: string;
    content: string;
  };
  preface?: string; // 序言
  basePrompts: string[]; // 基底（扮演总纲）
  flavorPrompts: string[]; // 风味（文风）
  glassPrompts: string[]; // 杯型（输出格式）
  strengthPrompts: string[]; // 苦精（尾部强化）
  recentDialogue: string; // 最近对话历史（用于上下文定位）
  sessionId: string;
}

/**
 * 获取当前活跃的 mixology session
 * 只认 localStorage 里当前打开的 session ID（由 mixology-game 写入）。
 * 记忆已按会话隔离，"猜一个最近的 session"会把 A 场的记忆读进 B 场，
 * 所以取消按 updatedAt 的兜底；拿不到就返回 null，由调用方提示先打开对局。
 */
export function getActiveMixSession(): MixSession | null {
  if (typeof window === "undefined") return null;
  try {
    const activeId = window.localStorage.getItem("mixology_active_session_id");
    if (activeId) {
      const session = getMixSession(activeId);
      if (session) return session;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 从 mixology session 提取角色与世界观
 */
export async function loadCharacterWorldFromSession(
  sessionId: string
): Promise<CharacterWorldContext | null> {
  const session = getMixSession(sessionId);
  if (!session) return null;

  const recipe = session.recipe;
  const { materials } = resolveMixRecipeMaterials(recipe);

  // 提取角色卡
  const characterCards = materials.character as MixCharacterCard[] | undefined;
  const characterCard = characterCards?.[0]; // 角色卡是 "first" 模式，只取第一张

  if (!characterCard) {
    console.warn("[NarrativeWriter] No character card found in session:", sessionId);
    return null;
  }

  // 提取面具（用户人设）
  const personaCards = materials.persona as any[] | undefined;
  const personaCard = personaCards?.[0];

  // 提取文本类材料
  const prefaceCards = materials.preface as MixTextMaterial[] | undefined;
  const baseCards = materials.base as MixTextMaterial[] | undefined;
  const flavorCards = materials.flavor as MixTextMaterial[] | undefined;
  const glassCards = materials.glass as MixTextMaterial[] | undefined;
  const strengthCards = materials.strength as MixTextMaterial[] | undefined;

  // 提取最近对话历史（最近10条，用于上下文定位）
  const recentTurns = session.turns?.slice(-10) || [];
  const recentDialogue = recentTurns
    .map(turn => {
      const roleLabel = turn.role === "user" ? (personaCard?.userName || "你") : characterCard.charName;
      return `${roleLabel}：${turn.text}`;
    })
    .join("\n");

  return {
    characterProfile: {
      charName: characterCard.charName,
      baseInfo: characterCard.baseInfo,
      personality: characterCard.personality,
      appearance: characterCard.appearance,
      background: characterCard.background,
      worldview: characterCard.worldview,
      cognition: characterCard.cognition,
      relations: characterCard.relations,
      plot: characterCard.plot,
      extra: characterCard.extra,
      profileText: characterCard.profileText,
      worldText: characterCard.worldText,
    },
    userPersona: personaCard
      ? {
          userName: personaCard.userName,
          content: personaCard.content,
        }
      : undefined,
    preface: prefaceCards?.[0]?.content,
    basePrompts: baseCards?.map((c) => c.content) || [],
    flavorPrompts: flavorCards?.map((c) => c.content) || [],
    glassPrompts: glassCards?.map((c) => c.content) || [],
    strengthPrompts: strengthCards?.map((c) => c.content) || [],
    recentDialogue,
    sessionId,
  };
}

/**
 * 加载完整的执笔上下文（人设 + 世界观 + 水位 + 执笔状态）
 * sessionId 必填：水位与执笔状态已按会话隔离，缺了就没法确定读哪一场
 */
export async function loadFullNarrativeContext(
  sessionId: string | null | undefined
): Promise<{
  characterWorld: CharacterWorldContext | null;
  waterLevels: Record<string, WaterLevelState>;
  writerState: NarrativeWriterState;
}> {
  const sid = requireSessionId(sessionId, "loadFullNarrativeContext");

  // 1. 人设与世界观
  const characterWorld = await loadCharacterWorldFromSession(sid);

  // 2. 加载水位
  const waterLevels = await getWaterLevels(sid);

  // 3. 加载执笔状态
  const writerState = await getWriterState(sid);

  return {
    characterWorld,
    waterLevels,
    writerState: writerState || createDefaultWriterState(sid),
  };
}

/**
 * 将角色与世界观信息格式化为 LLM 可读的字符串
 */
export function formatCharacterWorldForLLM(
  ctx: CharacterWorldContext
): string {
  const { characterProfile, userPersona, preface, basePrompts, flavorPrompts, glassPrompts, strengthPrompts } = ctx;

  const parts: string[] = [];

  // 角色资料
  if (characterProfile.profileText && characterProfile.worldText) {
    // freeform 模式：直接使用原文
    parts.push(`## 角色名\n${characterProfile.charName}`);
    parts.push(`## 角色资料\n${characterProfile.profileText}`);
    parts.push(`## 世界与剧情\n${characterProfile.worldText}`);
  } else {
    // form 模式：逐字段拼接
    parts.push(`## 角色名\n${characterProfile.charName}`);
    if (characterProfile.baseInfo) parts.push(`## 基础信息\n${characterProfile.baseInfo}`);
    if (characterProfile.personality) parts.push(`## 性格\n${characterProfile.personality}`);
    if (characterProfile.appearance) parts.push(`## 外貌\n${characterProfile.appearance}`);
    if (characterProfile.background) parts.push(`## 背景\n${characterProfile.background}`);
    if (characterProfile.worldview) parts.push(`## 世界观\n${characterProfile.worldview}`);
    if (characterProfile.cognition) parts.push(`## 对用户的认知\n${characterProfile.cognition}`);
    if (characterProfile.relations) parts.push(`## 关系与身份\n${characterProfile.relations}`);
    if (characterProfile.plot) parts.push(`## 当前剧情\n${characterProfile.plot}`);
    if (characterProfile.extra) parts.push(`## 附加设定\n${characterProfile.extra}`);
  }

  // 用户人设
  if (userPersona) {
    parts.push(`## 用户资料\n名字：${userPersona.userName || "你"}\n${userPersona.content}`);
  }

  // 序言
  if (preface) {
    parts.push(`## 开场说明\n${preface}`);
  }

  // 基底（扮演总纲）
  if (basePrompts.length > 0) {
    parts.push(`## 扮演总纲\n${basePrompts.join("\n\n")}`);
  }

  // 风味（文风）
  if (flavorPrompts.length > 0) {
    parts.push(`## 文风\n${flavorPrompts.join("\n\n")}`);
  }

  // 杯型（输出格式）
  if (glassPrompts.length > 0) {
    parts.push(`## 正文输出要求\n${glassPrompts.join("\n\n")}`);
  }

  // 苦精（尾部强化）
  if (strengthPrompts.length > 0) {
    parts.push(`## 最高优先级（尾部强化）\n${strengthPrompts.join("\n\n")}`);
  }

  return parts.join("\n\n");
}
