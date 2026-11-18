// lib/mixology/material-board.ts
// 重点材料内容常驻板（任务级）。
//
// 为什么需要它：工具回执 >900 字就会被 compactToolHistory 折叠成 160 字摘要。
// 材料正文动辄 2000~8000 字，读完一轮下一轮就只剩摘要，模型想改第二段就得重读——
// 重读又是新一轮 LLM 调用。34 次调用里至少一半是这么来的。
//
// 现在读取/创建/更新材料时，把正文 pin 进这块板，引擎每轮注入系统提示词：
// 不折叠、不占历史窗口，历史里只留一行短回执。板有总预算，超了按 LRU 淘汰。
//
// 与 spec-board 的区别：spec-board 放的是「制作规格」（字段地图 + 校验规则），
// 本模块放的是「材料正文」（用户实际在改的内容）。两者独立、互不干扰。
//
// 装配工作副本：
// - 装配工作副本：一次性把配方里所有材料加载到常驻板
// - 修改通过现有工具（改材料片段、更新材料）实时写回，这些工具已经自动更新板
// 这样避免了"解析结构化文本回字段"的复杂问题。

import { MIX_KIND_LABELS, type MixMaterialKind } from "./types";

/** 常驻板总预算（字符）：材料正文比规格更长，但系统提示词也不能无限塞。
 *  实测单件材料 2000~8000 字，3~4 件同时编辑是常见场景，25K 能容纳更多材料 */
export const MIX_MATERIAL_BOARD_BUDGET = 25000;

type PinnedMaterial = {
    id: string;
    kind: MixMaterialKind;
    name: string;
    content: string;
};

/** Map 的迭代顺序 = 插入顺序：最旧在前。重读同一件会 delete+set 续期（LRU）。 */
const pinnedMaterials = new Map<string, PinnedMaterial>();

/** 把材料钉进常驻板。已存在则续期（移到队尾），不存在则新增。超预算时淘汰最旧。 */
export function pinMixMaterial(id: string, kind: MixMaterialKind, name: string, content: string): { pinned: boolean; evicted: string[] } {
    const evicted: string[] = [];
    const key = String(id || "").trim();
    if (!key) return { pinned: false, evicted };

    // 已存在则先删除（后面 re-set 到队尾 = 续期）
    pinnedMaterials.delete(key);
    pinnedMaterials.set(key, { id: key, kind, name, content });

    // 超预算按 LRU 淘汰，至少留一件
    let total = 0;
    for (const mat of pinnedMaterials.values()) total += mat.content.length;
    while (total > MIX_MATERIAL_BOARD_BUDGET && pinnedMaterials.size > 1) {
        const oldest = pinnedMaterials.keys().next().value as string;
        const removed = pinnedMaterials.get(oldest);
        total -= removed?.content.length ?? 0;
        pinnedMaterials.delete(oldest);
        if (removed) evicted.push(`${MIX_KIND_LABELS[removed.kind]}「${removed.name}」`);
    }
    return { pinned: true, evicted };
}

/** 从常驻板移除指定材料（删除/不再编辑时调用） */
export function unpinMixMaterial(id: string): void {
    pinnedMaterials.delete(String(id || "").trim());
}

/** 任务开始：清空整块板 */
export function resetMixMaterialBoard(): void {
    pinnedMaterials.clear();
}

/** 生成注入系统提示词的文本。空板返回空串。 */
export function buildMixMaterialBoardPrompt(): string {
    if (pinnedMaterials.size === 0) return "";
    const blocks = [...pinnedMaterials.values()].map(
        (mat) => `【${MIX_KIND_LABELS[mat.kind]}「${mat.name}」（id: ${mat.id}）】\n${mat.content}`,
    );
    return `===== 本轮正在编辑的材料（常驻，改内容直接照此修改，不用重读） =====\n\n${blocks.join("\n\n")}`;
}

/** 当前钉在板上的材料 id 列表（调试 / 测试用） */
export function listPinnedMaterialIds(): string[] {
    return [...pinnedMaterials.keys()];
}

/** 获取板上指定 id 的材料（用于读取当前板上的内容） */
export function getPinnedMaterial(id: string): { id: string; kind: MixMaterialKind; name: string; content: string } | null {
    const mat = pinnedMaterials.get(String(id || "").trim());
    return mat ? { id: mat.id, kind: mat.kind, name: mat.name, content: mat.content } : null;
}
