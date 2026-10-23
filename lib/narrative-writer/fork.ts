// lib/narrative-writer/fork.ts
// 执笔插件 · 分叉时的记忆继承。
//
// 规则（栗子定）：
// - 末尾分叉（子会话保留了父会话的每一条消息）→ 全量深拷贝父记忆作为子会话起点。
// - 中间分叉（只保留到某一条消息为止）→ 一律不复制，子会话从空记忆开始，
//   由玩家在执笔面板用「补抽」从保留下来的对话重建。判断拿不准时也按中间分叉处理，宁可少给不能串。
//
// 深拷贝时卡片 id 保持不变（命名空间已按 sessionId 分开，同 id 不冲突），关联 ID 原样带过去。
// 但执笔状态与上下文层级不能照搬：id 改指子会话、轮次按子会话自己的消息重算、
// lastCompressedTurn 不得超过子会话 currentTurn。
//
// 失败处理：任何一步出错都清掉已经写进子会话命名空间的数据，绝不留半份；
// 且分叉本身照常成功（本函数只负责"要不要带记忆"，不阻断创建支线）。

import { getMixSession } from "@/lib/mixology/storage";
import type { MixSession } from "@/lib/mixology/types";
import { computeCurrentTurn } from "./writer";
import {
  exportAllNarrativeDataForMigration,
  purgeNarrativeSessionData,
  saveContextHierarchy,
  saveEmotionCard,
  saveMemoryCard,
  saveWaterLevel,
  saveWriterState,
} from "./storage";

export type ForkCopyResult = {
  /** 是否判定为末尾分叉（false = 中间分叉或拿不准，未复制） */
  endFork: boolean;
  /** 记忆是否成功复制进子会话 */
  copied: boolean;
  memories: number;
  emotions: number;
};

/** 判定末尾分叉：子会话留下了父会话的每一条消息，且父会话非空。其余一律当中间分叉。 */
function isEndFork(parent: MixSession | null, child: MixSession): boolean {
  if (!parent) return false;
  // 空父会话（只有开场白被删、或还没出过一轮）时无从判断，保守当作中间分叉。
  if (parent.turns.length === 0) return false;
  // forkMixSession 用 turns.slice(0, clamped+1) 造子会话，
  // 只有分叉点落在最后一条消息上，子会话才与父会话等长——即"末尾分叉"。
  return child.turns.length === parent.turns.length;
}

/**
 * 分叉后把父会话记忆复制进子会话命名空间。
 * 由两个分叉入口在 forkMixSession 之后 await 调用。
 */
export async function copyNarrativeOnFork(child: MixSession): Promise<ForkCopyResult> {
  const parentId = child.parentId;
  const childId = child.id;
  const parent = parentId ? getMixSession(parentId) : null;

  if (!isEndFork(parent, child) || !parent) {
    // 中间分叉 / 父级已不存在 / 判断拿不准：不复制，子会话空记忆起步。
    return { endFork: false, copied: false, memories: 0, emotions: 0 };
  }

  let memories = 0;
  let emotions = 0;
  try {
    const snapshot = await exportAllNarrativeDataForMigration(parent.id);

    // 记忆卡：整卡原样深拷贝（对象已是每次 parse 出来的独立副本），id 与关联 ID 不改。
    for (const card of snapshot.memories) {
      await saveMemoryCard(childId, card);
      memories++;
    }
    for (const card of snapshot.emotions) {
      await saveEmotionCard(childId, card);
      emotions++;
    }

    // 水位：父会话记录过的每个作用域原样带过去（未记录的交给子会话默认值）。
    for (const water of Object.values(snapshot.waterLevels)) {
      if (water) await saveWaterLevel(childId, water);
    }

    // 执笔状态：结构沿用父会话，但归属与轮次按子会话重算。
    const childCurrentTurn = computeCurrentTurn(child.turns);
    const writerState = {
      ...snapshot.writerState,
      id: childId,
      currentTurn: childCurrentTurn,
      lastExtractedTurn: Math.min(snapshot.writerState.lastExtractedTurn, childCurrentTurn),
    };
    await saveWriterState(childId, writerState);

    // 上下文层级：压缩进度沿用，但压缩过的回合不能比子会话实际回合数还大。
    if (snapshot.hierarchy) {
      await saveContextHierarchy(childId, {
        ...snapshot.hierarchy,
        lastCompressedTurn: Math.min(snapshot.hierarchy.lastCompressedTurn ?? 0, childCurrentTurn),
      });
    }

    console.log(`[NarrativeWriter] copyNarrativeOnFork: 父 ${parent.id} → 子 ${childId}，已复制 ${memories} 记忆卡 / ${emotions} 情感卡`);
    return { endFork: true, copied: true, memories, emotions };
  } catch (error) {
    // 复制中途失败：清掉已落进子会话命名空间的一切，不留半份；分叉本身不因此失败。
    console.error(`[NarrativeWriter] copyNarrativeOnFork 复制失败，正在清理子 ${childId} 的残留数据：`, error);
    try {
      purgeNarrativeSessionData(childId);
    } catch (cleanupError) {
      console.error("[NarrativeWriter] copyNarrativeOnFork 清理残留数据也失败：", cleanupError);
    }
    return { endFork: true, copied: false, memories: 0, emotions: 0 };
  }
}
