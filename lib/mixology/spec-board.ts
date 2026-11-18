// lib/mixology/spec-board.ts
// 制作规格常驻板（任务级）。
//
// 规格每类 500~8600 字，原来作为「读取制作说明」的回执进历史，下一轮就被
// compactToolHistory 折叠成 160 字摘要；长正文是分批 append 写的，写到一半规格
// 已从上下文消失，模型只好重读——重读又是新一轮 LLM 调用。
// 现在规格 pin 进这块板，由引擎每轮注入系统提示词：不折叠、不占历史窗口，
// 历史里只留一行短回执。板有总预算，超了按 LRU 淘汰最旧的一类。
//
// 纯模块：只依赖 crafting-guides 与 types，chat-store / 引擎 / 测试都可以直接引。
// 模块级状态 = 一轮任务的生命周期：chat-store 在每条用户消息开头 reset。

import { buildMixCraftSpec } from "./crafting-guides";
import { MIX_KIND_LABELS, type MixMaterialKind } from "./types";

/** 常驻板总预算（字符）：13 类实测共 17160 字，全 pin 会超；典型组合（角色卡+小票+机括≈12.5K）
 *  也贴近上限，超了按 LRU 淘汰最旧，别把系统提示词塞爆 */
export const MIX_SPEC_BOARD_BUDGET = 12000;

/** Map 的迭代顺序 = 插入顺序：最旧在前。重读同一类会 delete+set 续期（LRU）。 */
const pinnedSpecs = new Map<MixMaterialKind, string>();

export function pinMixCraftSpecs(kinds: MixMaterialKind[]): { pinned: MixMaterialKind[]; evicted: MixMaterialKind[] } {
    const evicted: MixMaterialKind[] = [];
    for (const kind of kinds) {
        pinnedSpecs.delete(kind);
        pinnedSpecs.set(kind, buildMixCraftSpec(kind));
    }
    let total = 0;
    for (const spec of pinnedSpecs.values()) total += spec.length;
    // 至少留一类：单类超预算时宁可超一点，也不能让板空着（模型会以为没读到）
    while (total > MIX_SPEC_BOARD_BUDGET && pinnedSpecs.size > 1) {
        const oldest = pinnedSpecs.keys().next().value as MixMaterialKind;
        total -= pinnedSpecs.get(oldest)?.length ?? 0;
        pinnedSpecs.delete(oldest);
        evicted.push(oldest);
    }
    const requested = [...new Set(kinds)];
    return { pinned: requested.filter((kind) => pinnedSpecs.has(kind)), evicted };
}

export function resetMixCraftSpecBoard(): void {
    pinnedSpecs.clear();
}

export function buildMixCraftSpecBoardPrompt(): string {
    if (pinnedSpecs.size === 0) return "";
    const blocks = [...pinnedSpecs.entries()].map(
        ([kind, spec]) => `【种类 ${kind}（${MIX_KIND_LABELS[kind]}）】\n${spec}`,
    );
    return `===== 制作规格（本轮常驻，写材料时直接照此执行，不用重读） =====\n\n${blocks.join("\n\n")}`;
}