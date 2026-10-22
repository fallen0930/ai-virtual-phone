// lib/narrative-writer/recommender.ts
// 基于记忆库的智能场景推荐

import type { MemoryCard, EmotionCard, WaterLevelState, NarrativeWriterState, ContextHierarchy } from "./types";

export interface SceneRecommendation {
  id: string;
  name: string;
  emoji: string;
  reason: string; // 为什么推荐这个
  detail?: string; // 具体的记忆/线索内容
  params: {
    tone?: string;
    pace?: string;
    focus?: string;
    relationship?: string;
    trigger?: string;
    theme?: string;
    taboo?: string;
    density?: string;
  };
}

export interface RecommendationContext {
  memories: MemoryCard[];
  pendingMemories: MemoryCard[];
  emotions: EmotionCard[];
  waterLevel: string;
  writerState: NarrativeWriterState | null;
  hierarchy: ContextHierarchy | null;
  characterName: string;
  worldText: string;
}

/**
 * 基于记忆库生成智能场景推荐
 */
export function generateSmartRecommendations(context: RecommendationContext): SceneRecommendation[] {
  const recommendations: SceneRecommendation[] = [];
  
  // 1. 从散落线头生成推荐（未解决的伏笔）
  if (context.writerState?.散落线头 && context.writerState.散落线头.length > 0) {
    recommendations.push({
      id: 'resolve_thread',
      name: '解决伏笔',
      emoji: '🔍',
      reason: `还有 ${context.writerState.散落线头.length} 条未解决的线索`,
      detail: context.writerState.散落线头[0],
      params: { tone: '悬疑', focus: '线索', pace: '中' }
    });
  }
  
  // 2. 从待核记忆卡生成推荐（需要确认的信息）
  const pendingWorldChanges = context.pendingMemories.filter(
    m => m.主类型 === '世界变更' && m.状态 === '待核'
  );
  if (pendingWorldChanges.length > 0) {
    recommendations.push({
      id: 'confirm_change',
      name: '确认变化',
      emoji: '🌍',
      reason: `${pendingWorldChanges.length} 个世界变更待确认`,
      detail: pendingWorldChanges[0].内容,
      params: { tone: '紧张', focus: '事件', pace: '快' }
    });
  }
  
  // 3. 从情感卡生成推荐（情绪需要释放或转化）
  const recentEmotion = context.emotions[0];
  if (recentEmotion) {
    if (recentEmotion.标签 === '低落' || recentEmotion.标签 === '焦虑' || recentEmotion.标签 === '生气') {
      recommendations.push({
        id: 'emotional_release',
        name: '情绪释放',
        emoji: '💥',
        reason: `${recentEmotion.主体}最近情绪${recentEmotion.标签}`,
        detail: recentEmotion.证据,
        params: { tone: '紧张', pace: '快', density: '高' }
      });
    } else if (recentEmotion.标签 === '开心' || recentEmotion.标签 === '兴奋') {
      recommendations.push({
        id: 'maintain_joy',
        name: '延续快乐',
        emoji: '✨',
        reason: `${recentEmotion.主体}情绪${recentEmotion.标签}，适合延续`,
        detail: recentEmotion.证据,
        params: { tone: '轻松', pace: '中', density: '低' }
      });
    }
  }
  
  // 4. 从关系水位生成推荐
  if (context.waterLevel === 'L2' && context.emotions.some(e => e.标签 === '开心')) {
    recommendations.push({
      id: 'relationship_advance',
      name: '关系推进',
      emoji: '💕',
      reason: '关系水位 L2，适合推进',
      params: { tone: '甜蜜', relationship: '推进', pace: '中' }
    });
  } else if (context.waterLevel === 'L3' || context.waterLevel === 'L4') {
    recommendations.push({
      id: 'deep_bond',
      name: '深度羁绊',
      emoji: '',
      reason: `关系水位${context.waterLevel}，可以深入`,
      params: { tone: '甜蜜', relationship: '稳定', pace: '慢', density: '中' }
    });
  }
  
  // 5. 从 L2 摘要生成推荐（章节之间的衔接）
  if (context.hierarchy?.L2_章节摘要 && context.hierarchy.L2_章节摘要.length > 0) {
    const lastSummary = context.hierarchy.L2_章节摘要[context.hierarchy.L2_章节摘要.length - 1];
    recommendations.push({
      id: 'continue_plot',
      name: '延续剧情',
      emoji: '',
      reason: '承接上一章',
      detail: lastSummary.summary.slice(0, 50) + '...',
      params: { tone: '中', pace: '中' }
    });
  }
  
  // 6. 从世界观生成推荐（世界观里的未探索元素）
  // 简单实现：检查世界观文本中的关键词是否在记忆卡中出现过
  const worldKeywords = extractWorldKeywords(context.worldText);
  const exploredTopics = context.memories
    .filter(m => m.主类型 === '经历节点' || m.主类型 === '世界变更')
    .map(m => m.内容);
  
  const unexplored = worldKeywords.filter(k => 
    !exploredTopics.some(exp => exp.includes(k))
  );
  
  if (unexplored.length > 0) {
    recommendations.push({
      id: 'explore_world',
      name: '探索世界',
      emoji: '🗺️',
      reason: `${unexplored.length} 个世界观元素未探索`,
      detail: unexplored[0],
      params: { tone: '悬疑', focus: '线索', pace: '中' }
    });
  }
  
  // 7. 默认推荐（如果上面都没生成）
  if (recommendations.length === 0) {
    recommendations.push({
      id: 'daily_life',
      name: '日常相处',
      emoji: '🌸',
      reason: '轻松一下，积累感情',
      params: { tone: '轻松', pace: '慢', density: '低' }
    });
    recommendations.push({
      id: 'plot_advance',
      name: '推进剧情',
      emoji: '⚡',
      reason: '推动故事发展',
      params: { tone: '中', pace: '中', density: '中' }
    });
  }
  
  return recommendations.slice(0, 4); // 最多 4 个推荐
}

/**
 * 从世界观文本提取关键词
 */
function extractWorldKeywords(worldText: string): string[] {
  // 简单实现：提取名词短语
  // 实际可以用 NLP 库，这里先用正则
  const keywords: string[] = [];
  
  // 匹配"XX 的 YY"结构
  const matches = worldText.match(/[\u4e00-\u9fa5]{2,4}的[\u4e00-\u9fa5]{2,6}/g);
  if (matches) {
    keywords.push(...matches);
  }
  
  // 匹配地名/组织名（ capitalized words or specific patterns）
  const places = worldText.match(/[\u4e00-\u9fa5]{2,4}(?:基地 | 实验室 | 学院 | 公司 | 家族)/g);
  if (places) {
    keywords.push(...places);
  }
  
  return [...new Set(keywords)].slice(0, 10); // 去重，最多 10 个
}
