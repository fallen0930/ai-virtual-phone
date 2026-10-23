// lib/narrative-writer/recommender.ts
// 剧情预告生成器：强制三张卡（社交拉扯/外界驱动/环境催化）+ 具体钩子画面 + 可切换维度
// 所有 hook 从记忆库/世界观抓真实细节填充，不调用 LLM（保证速度）

import type { MemoryCard, EmotionCard, NarrativeWriterState, ContextHierarchy, ThreadCard } from "./types";
import { pickPriorityThread } from "./threads";

export type InteractionType = 'social' | 'external' | 'ambient';
export type PlotFunction = 'twist' | 'advance' | 'flirt' | 'buffer';

/** 每张卡可切换的维度选项 */
export interface DimensionOptions {
  focus?: string[];      // 焦点：聚焦角色/聚焦主控/双向交织
  intensity?: string[];  // 张力：暗流涌动/正面碰撞/情绪爆发
  tempo?: string[];      // 时间跨度：即时/几小时后/几天后
}

export interface PlotPreview {
  id: string;
  interactionType: InteractionType;
  plotFunction: PlotFunction;
  title: string;
  description: string;
  hook: string;            // 具体画面感描写（从记忆库抓细节）
  expectedOutcome: string;
  style: { tone: string; pace: string; density: string };
  dimensions: DimensionOptions;
  defaultDimension: { focus?: string; intensity?: string; tempo?: string };
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
  /** 导演台账里的线索卡（可选：没传就退回旧的「散落线头」） */
  threads?: ThreadCard[];
}

const WATER_LABELS: Record<string, string> = {
  'L0': '刚认识', 'L1': '有点熟了', 'L2': '已经挺熟',
  'L3': '关系不错', 'L4': '很亲密了', 'L5': '最亲密',
};

const FUNCTION_LABELS: Record<PlotFunction, string> = {
  twist: '转折', advance: '推进', flirt: '升温', buffer: '缓冲',
};

const TYPE_LABELS: Record<InteractionType, string> = {
  social: '角色与主控', external: '主控与外界', ambient: '环境与日常',
};

export function generatePlotPreviews(context: RecommendationContext): PlotPreview[] {
  const waterLabel = WATER_LABELS[context.waterLevel] || '普通';
  return [
    buildSocialCard(context, waterLabel),
    buildExternalCard(context),
    buildAmbientCard(context),
  ];
}

/** 社交拉扯：角色 vs 主控，抓情感卡/关系共识的细节做反差钩子 */
function buildSocialCard(context: RecommendationContext, waterLabel: string): PlotPreview {
  const charName = context.characterName || '角色';
  const recentEmotion = context.emotions[0];
  const relationMemory = context.memories.find(m => m.主类型 === '关系共识');
  const selfMemory = context.memories.find(m => m.主类型 === '自我认知' && m.主体 === '角色');
  const behaviorMemory = context.memories.find(m => m.主类型 === '行为模式' && m.主体 === '角色');

  // 根据水位+情绪决定功能
  let func: PlotFunction = 'flirt';
  if (context.waterLevel === 'L0' || context.waterLevel === 'L1') func = 'advance';
  else if (recentEmotion && (recentEmotion.标签 === '低落' || recentEmotion.标签 === '生气')) func = 'buffer';

  // 钩子：从记忆抓具体细节做反差，按功能选不同套路
  let hook = '';
  if (func === 'flirt') {
    if (behaviorMemory) {
      hook = `${charName}平时${behaviorMemory.内容.slice(0, 15)}，这次却${recentEmotion ? '在你面前卸下了伪装' : '主动靠近了一步'}`;
    } else if (selfMemory) {
      hook = `平时${selfMemory.内容.slice(0, 15)}的${charName}，指尖在你手背多停了一秒`;
    } else if (relationMemory) {
      hook = `借着"${relationMemory.内容.slice(0, 20)}"的由头，${charName}第一次没躲开你的视线`;
    } else {
      hook = `${charName}递东西给你时，指尖故意多停留了一秒`;
    }
  } else if (func === 'buffer') {
    if (recentEmotion) {
      hook = `${charName}${recentEmotion.标签}的时候${recentEmotion.证据.slice(0, 20)}，你没说话，只是把外套披了上去`;
    } else {
      hook = `${charName}沉默了很久，你也没催，两人就那样坐着`;
    }
  } else {
    if (relationMemory) {
      hook = `从"${relationMemory.内容.slice(0, 15)}"到现在的${waterLabel}，${charName}主动提起了一个从没聊过的话题`;
    } else {
      hook = `${charName}第一次主动问你"今天过得怎么样"`;
    }
  }

  return {
    id: 'social',
    interactionType: 'social',
    plotFunction: func,
    title: `${TYPE_LABELS.social} · ${FUNCTION_LABELS[func]}`,
    description: func === 'flirt' ? '在现有关系上往前踏一步，用细节制造心跳' : func === 'buffer' ? '接住情绪，让关系在低谷里更近' : '多聊几句，把关系从陌生推向熟悉',
    hook,
    expectedOutcome: func === 'flirt' ? `关系从"${waterLabel}"再推一格` : func === 'buffer' ? '在脆弱时建立信任' : '打破陌生感',
    style: { tone: func === 'buffer' ? '温柔' : '甜蜜', pace: '慢', density: '中' },
    dimensions: {
      focus: ['聚焦角色', '聚焦主控', '双向交织'],
      intensity: ['暗流涌动', '正面碰撞'],
      tempo: ['即时', '几小时后'],
    },
    defaultDimension: { focus: '双向交织', intensity: '暗流涌动', tempo: '即时' },
  };
}

/** 外界驱动：主控 vs 外界，抓世界变更/未探索元素做新变量钩子 */
function buildExternalCard(context: RecommendationContext): PlotPreview {
  const worldChange = context.memories.find(m => m.主类型 === '世界变更');
  const pendingChange = context.pendingMemories.find(m => m.主类型 === '世界变更');
  const unexplored = extractWorldKeywords(context.worldText)
    .filter(k => !context.memories.some(m => m.内容.includes(k)));
  const npcMemory = context.memories.find(m => m.主体 === '角色' && m.次标签?.includes('地点'));

  let hook = '';
  let desc = '';
  if (pendingChange) {
    hook = `${pendingChange.内容.slice(0, 25)}——这个消息今天会传到你们耳朵里，带来的人你从未见过`;
    desc = '把还没坐实的设定抛进剧情，制造悬念';
  } else if (worldChange) {
    hook = `${worldChange.内容.slice(0, 25)}的后续影响开始显现，有人带着目的找上门来`;
    desc = '让之前的世界变更产生连锁反应';
  } else if (unexplored.length > 0) {
    hook = `${unexplored[0]}那边传来动静，打破了现在的平静，${npcMemory ? '而那里恰好是' + npcMemory.内容.slice(0, 10) : '一个你从没去过的地方'}`;
    desc = '引入世界观里还没用过的新变量';
  } else {
    hook = '门外传来敲门声，三短一长——不是你们约好的暗号';
    desc = '引入一个外部危机，推动主线';
  }

  return {
    id: 'external',
    interactionType: 'external',
    plotFunction: 'twist',
    title: `${TYPE_LABELS.external} · ${FUNCTION_LABELS.twist}`,
    description: desc,
    hook,
    expectedOutcome: '开启一条新支线或打破当前僵局',
    style: { tone: '紧张', pace: '快', density: '高' },
    dimensions: {
      focus: ['聚焦主控', '聚焦角色', '群像视角'],
      intensity: ['暗流涌动', '正面碰撞', '情绪爆发'],
      tempo: ['即时', '几小时后', '几天后'],
    },
    defaultDimension: { focus: '聚焦主控', intensity: '暗流涌动', tempo: '即时' },
  };
}

/** 环境催化：角色 vs 环境/配角，抓未决线索/上一章摘要做氛围钩子 */
function buildAmbientCard(context: RecommendationContext): PlotPreview {
  // 先取导演台账里优先级最高的那条线（爆发 > 升温 > 潜伏，同状态取最久没推进的）。
  // 台账为空时回退到旧的「散落线头」，再没有就用摘要/天气兜底——无线索可抓时本函数不得抛错。
  const 优先线索 = pickPriorityThread(context.threads ?? [])?.名称?.trim();
  const thread = 优先线索 || context.writerState?.散落线头?.[0];
  const lastSummary = context.hierarchy?.L2_章节摘要?.slice(-1)[0];
  const charName = context.characterName || '角色';

  let hook = '';
  let desc = '';
  let func: PlotFunction = 'buffer';
  if (thread) {
    hook = `收拾东西时翻出了"${thread.slice(0, 15)}"相关的旧物，${charName}的动作停了一下，气氛突然安静下来`;
    desc = '用日常场景自然带出未解决的线索';
    func = 'advance';
  } else if (lastSummary) {
    hook = `接着上次的场景收尾：${lastSummary.summary.slice(0, 25)}……之后的第一个清晨，${charName}比平时起得早`;
    desc = '承接上一章，用日常过渡深化羁绊';
  } else {
    hook = '下雨了，你们被困在同一个屋檐下，谁都没先开口，只有雨声';
    desc = '用天气或共同任务打破僵局';
  }

  return {
    id: 'ambient',
    interactionType: 'ambient',
    plotFunction: func,
    title: `${TYPE_LABELS.ambient} · ${FUNCTION_LABELS[func]}`,
    description: desc,
    hook,
    expectedOutcome: func === 'advance' ? '在日常里悄悄推进线索' : '大战后舔舐伤口，加深羁绊',
    style: { tone: func === 'advance' ? '中' : '轻松', pace: '慢', density: '低' },
    dimensions: {
      focus: ['聚焦角色', '聚焦主控', '环境为主'],
      intensity: ['暗流涌动'],
      tempo: ['即时', '几小时后', '几天后'],
    },
    defaultDimension: { focus: '聚焦角色', intensity: '暗流涌动', tempo: '即时' },
  };
}

function extractWorldKeywords(worldText: string): string[] {
  const keywords: string[] = [];
  const matches = worldText.match(/[\u4e00-\u9fa5]{2,4}的[\u4e00-\u9fa5]{2,6}/g);
  if (matches) keywords.push(...matches);
  const places = worldText.match(/[\u4e00-\u9fa5]{2,4}(?:基地|实验室|学院|公司|家族|地堡|温室)/g);
  if (places) keywords.push(...places);
  return [...new Set(keywords)].slice(0, 10);
}
