// lib/mascot-task-ledger.ts
// 本轮任务台账：一条用户消息触发的整轮任务里，小卷实际创建过的对象（scope + kind + 名字 → id）。
//
// 为什么需要它：工具回执里的 id 只在那一条消息里出现一次，模型下一轮就想不起来。
// 2026-10-29 真机日志（mascot-diag-20261029-1428.json）里那条建特调的任务就是这么绕圈的：
// 第 24 / 26 / 32 / 35 / 39 轮连着「创建材料」，中间夹一圈「列出酒柜」重新找对象，
// 于是同名的东西酒柜里躺着好几件，再按名字读又被「重名歧义」挡回去，继续绕。
// 台账只做三件事：① 创建类工具把 id 记下来；② 同类同名再建直接拒、并把已有 id 交回去；
// ③ 按名字找不到对象时，把本轮建过的东西一起当候选列出来。
//
// 内存态、不落库：任务开始（或用户发下一条消息）就重置，别让长会话越攒越多。

export type MascotTaskLedgerEntry = {
    /** 对象域：mixmat（特调材料）/ character（角色）/ preset（预设）/ recipe（特调配方） */
    scope: string;
    /** 材料种类等细分：同 scope 下不同 kind 的同名对象是两件东西 */
    kind?: string;
    id: string;
    name: string;
    /** 给人和模型看的描述，如「基底「纯白造物交互准则」」 */
    label: string;
};

const MAX_LEDGER_ENTRIES = 200;

let entries: MascotTaskLedgerEntry[] = [];

/** 名字的比较键：首尾空格与大小写不参与比较（ latin 名字常见 Zero / zero 混写） */
export function mascotNameKey(name: string): string {
    return String(name || "").trim().toLowerCase();
}

/** 新一轮任务开始：清空台账 */
export function resetMascotTaskLedger(): void {
    entries = [];
}

/** 记一笔「本轮动过这个对象」。同 scope + kind + 名字重复记录时覆盖旧条目 */
export function recordMascotTaskLedger(entry: MascotTaskLedgerEntry): void {
    const name = String(entry.name || "").trim();
    const id = String(entry.id || "").trim();
    const scope = String(entry.scope || "").trim();
    if (!scope || !name || !id) return;
    const key = mascotNameKey(name);
    const existing = entries.findIndex((item) => item.scope === scope
        && (entry.kind === undefined || item.kind === entry.kind)
        && mascotNameKey(item.name) === key);
    if (existing >= 0) entries.splice(existing, 1);
    entries.push({ ...entry, scope, kind: entry.kind, id, name });
    if (entries.length > MAX_LEDGER_ENTRIES) entries.splice(0, entries.length - MAX_LEDGER_ENTRIES);
}

/** 按 scope（可选 kind）+ 名字找回本轮记过的对象 */
export function findInMascotTaskLedger(match: { scope: string; kind?: string; name: string }): MascotTaskLedgerEntry | undefined {
    const key = mascotNameKey(match.name);
    if (!key) return undefined;
    return entries.find((entry) => entry.scope === match.scope
        && (match.kind === undefined || entry.kind === match.kind)
        && mascotNameKey(entry.name) === key);
}

/** 本轮记过的对象；给「找不到」的回执当候选用 */
export function listMascotTaskLedger(scope?: string): MascotTaskLedgerEntry[] {
    return scope ? entries.filter((entry) => entry.scope === scope) : entries.slice();
}

/**
 * 把本轮台账浓缩成一句话摘要，给计费流水的 note 用。
 *
 * 口径：按 scope 分组计数（不展开具体名字，note 字段有长度压力）。
 * 例："动过 3 件材料、1 个配方"。空台账返回空串，调用方直接拼即可。
 */
export function summarizeTaskLedger(): string {
    if (!entries.length) return "";
    const scopeLabels: Record<string, { singular: string; plural: string }> = {
        mixmat: { singular: "件材料", plural: "件材料" },
        recipe: { singular: "个配方", plural: "个配方" },
        character: { singular: "个角色", plural: "个角色" },
        preset: { singular: "个预设", plural: "个预设" },
    };
    const counts = new Map<string, number>();
    for (const entry of entries) {
        counts.set(entry.scope, (counts.get(entry.scope) || 0) + 1);
    }
    const parts: string[] = [];
    for (const [scope, count] of counts) {
        const label = scopeLabels[scope] || { singular: "个对象", plural: "个对象" };
        parts.push(`${count} ${count > 1 ? label.plural : label.singular}`);
    }
    return `动过 ${parts.join("、")}`;
}
