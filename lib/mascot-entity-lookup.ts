// lib/mascot-entity-lookup.ts
// 小卷按名字找对象的统一口径：找不到就说清楚「没有」以及「相近的是哪些（带 id）」，
// 重名冲突时把已有 id 交回去。
//
// 旧写法各工具各说各话，且都不给 id：
//   · 特调材料「酒柜里没有叫「X」的材料。可先用 列出酒柜 查看。」→ 模型真去列一遍酒柜；
//   · 角色「找不到角色：X」→ 它不知道是名字错了还是根本没建；
//   · 预设「找不到预设 id：X」→ 名字传进去也白给，只有 id 能用；
//   · 读取预设用 `p.name === name || p.name.includes(name)` 取第一个命中，
//     「剧情」会静默命中排在前面的「剧情·加长版」，改错对象还看不出来。
// 于是「找不到 → 列表 → 再找不到 → 干脆新建一件」成了循环（见 2026-10-29 真机日志）。
// 这里把回执统一成一条能直接接上下文的句子：有没有、相近的是谁、id 是多少。

import { listMascotTaskLedger, mascotNameKey } from "./mascot-task-ledger";

export type MascotNameCandidate = { id: string; text: string };

const MAX_CANDIDATES = 6;

function dedupeById(candidates: MascotNameCandidate[]): MascotNameCandidate[] {
    const seen = new Set<string>();
    const out: MascotNameCandidate[] = [];
    for (const candidate of candidates) {
        if (!candidate.id || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        out.push(candidate);
        if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
}

/**
 * 名字 → 候选对象：先收精确同名（这就是重名歧义），再收互相包含的近似名，最后补本轮台账。
 * 只列，不替模型做决定——近似命中不自动采用，免得把「阿零」的改动写进「阿零·改」。
 * 一个相近的都没有时，把整个池子前几条作为「现有的是这些」端出来：
 * 与其让它再去跑一遍列表工具，不如一次把候选给全。
 */
export function pickMascotNameCandidates<T extends { id: string; name: string }>(
    pool: T[],
    name: string,
    labelOf: (item: T) => string,
): MascotNameCandidate[] {
    const key = mascotNameKey(name);
    if (!key) return [];
    const exact: MascotNameCandidate[] = [];
    const near: MascotNameCandidate[] = [];
    for (const item of pool) {
        const itemKey = mascotNameKey(item.name);
        if (!itemKey) continue;
        const text = labelOf(item);
        if (itemKey === key) exact.push({ id: item.id, text });
        else if (itemKey.includes(key) || key.includes(itemKey)) near.push({ id: item.id, text });
    }
    const fromLedger = listMascotTaskLedger()
        .filter((entry) => !pool.some((item) => item.id === entry.id))
        .filter((entry) => {
            const entryKey = mascotNameKey(entry.name);
            return entryKey === key || entryKey.includes(key) || key.includes(entryKey);
        })
        .map((entry) => ({ id: entry.id, text: entry.label }));
    const picked = dedupeById([...exact, ...near, ...fromLedger]);
    if (picked.length) return picked;
    return dedupeById(pool.map((item) => ({ id: item.id, text: labelOf(item) })));
}

/** 按名字找不到的回执：把候选连 id 一起给出去，别让它再跑一遍列表工具 */
export function describeMascotNameMiss(options: {
    label: string;
    name: string;
    candidates: MascotNameCandidate[];
    listTool?: string;
    createTool?: string;
}): string {
    const head = `没有叫「${options.name}」的${options.label}。`;
    const listNote = options.listTool ? `不用先 ${options.listTool}` : "不用先列一遍";
    if (!options.candidates.length) {
        const create = options.createTool ? `，或直接新建一件` : "";
        return `${head}一个能对上号的对象都没有——别凭猜的名字反复试${create}（${listNote}）。`;
    }
    const lines = options.candidates.map((candidate) => `[${candidate.id}] ${candidate.text}`).join("、");
    return `${head}可选的对象是：${lines}。带 id 再调用就行（${listNote}）。`;
}

/** 名字冲突的回执：已有对象的 id 直接给回去，堵住「再建一件同名」 */
export function describeMascotNameConflict(options: {
    label: string;
    name: string;
    id: string;
    updateTool: string;
    where?: string;
}): string {
    const where = options.where ? `${options.where}的` : "";
    return `${where}${options.label}「${options.name}」已经存在（id: ${options.id}）。别重复创建：`
        + `要改它就带这个 id 用 ${options.updateTool}，想做另一件请换个名字。`;
}
