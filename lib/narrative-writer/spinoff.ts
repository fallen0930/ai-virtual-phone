// lib/narrative-writer/spinoff.ts
// 执笔插件 · 番外的记忆口径（只读继承）
//
// 她要番外解决的是两件事（2026-10-24 确认）：
//   1) 开番外不许再复制一份记忆——分叉那种深拷贝太吃存储，番外开多了还会回头污染主线；
//   2) 番外可以「继承记忆」，也可以「只有人设和世界书」从零开始。
//
// 落成的口径：**引用，不复制**。
// 番外这一场在 storage 里几乎不占键：卡与水位一律去**来源对局当前那一份**读，
// 写则全部拒绝。于是三件事同时成立——
//   - 省存储：番外的 memory/emotion/thread/foreshadow/water 命名空间是空的；
//   - 不串味：番外无论怎么写正文都不产生卡，主线的记忆不会被番外的剧情改动；
//   - 活引用：来源后续推进新增的卡，番外当场就能读到（不是开番外那一刻的快照）。
//
// 换来的限制要如实说：
//   - 来源对局被删，番外的记忆跟着没了（读回来是空，不报错）；
//   - 番外里看不到"只有番外发生过"的记忆——它本来就只读。
// 这两条都在面板横幅上写明（见 narrative-writer-panel 的番外段）。
//
// 番外的**自己那一层**照旧可写：执笔状态、上下文层级（L2/L3）、整理历史。
// 那些是"这一场推到第几轮"的进度，不是记忆卡，混在只读闸门里会把番外的执笔流程整体锁死。

import { getMixSession } from "@/lib/mixology/storage";
import { mixSessionTitle, type MixSession, type MixSpinoffMemory } from "@/lib/mixology/types";

/** 面板横幅与提示语要用的来源信息 */
export type SpinoffSourceInfo = {
    /** 实际去读哪一场的记忆（= narrativeReadSessionId 的结果） */
    id: string;
    /** 那一场叫什么，给横幅显示 */
    name: string;
    /** 本番外的记忆模式（继承 / 不继承） */
    memory: MixSpinoffMemory;
};

/**
 * 顺链最多走这么多跳。
 * 谱系数据是人手编辑 + 旧版本写出来的，出现 A→B→A 这种环并不意外；
 * 没有上限的话读一次卡就把浏览器挂在 while 里。
 */
const MAX_HOPS = 64;

/** 这一场是不是番外（对局读不到时按"不是"处理：没谱系可谈，照普通对局走） */
export function isNarrativeSpinoffSession(sessionId: string | null | undefined): boolean {
    const sid = (sessionId ?? "").trim();
    if (!sid) return false;
    return Boolean(getMixSession(sid)?.spinoff);
}

/**
 * 这一场的记忆该去哪个命名空间读。
 *
 * - 普通对局 → 自己；
 * - 番外（不继承）→ 自己：那一层本来就是空的，"只有人设和世界书"就是这个意思；
 * - 番外（继承）→ 顺着 spinoff.sourceId 往上走，直到碰到第一个**不是番外的对局**（锚点）。
 *   番外套番外也只会读到一个锚点，不会读中间那层番外的空命名空间；
 *   链上任何一环是"不继承"，它没有锚点可上，就停在自己身上（读空）。
 * - 来源被删 / 谱系成环 / 跳数超限 → 回落自己，读空而不报错。
 *   回落自己还有个好处：番外自己的命名空间是空的，绝不可能误读到别的对局。
 */
export function narrativeReadSessionId(sessionId: string): string {
    const start = (sessionId ?? "").trim();
    if (!start) return start;

    const seen = new Set<string>([start]);
    let current = getMixSession(start);
    // 起点自己不是番外，直接返回
    while (current?.spinoff) {
        // 不继承：读自己（空的），不再往上走
        if (current.spinoff.memory !== "inherit") return start;
        const nextId = (current.spinoff.sourceId ?? "").trim();
        if (!nextId || seen.has(nextId) || seen.size >= MAX_HOPS) return start;
        seen.add(nextId);
        const next = getMixSession(nextId);
        if (!next) return start;   // 来源被删：回落自己，读空
        current = next;
    }
    return current?.id ?? start;
}

/**
 * 这一场的记忆卡/情感卡/线索伏笔/水位是不是只读。
 * 番外两种模式都算只读：不继承的番外同样不许往自己的命名空间写卡——
 * 那正是"番外开多了会影响记忆"的源头，关掉写入才是这条口径的另外半边。
 */
export function isNarrativeReadOnlySession(sessionId: string | null | undefined): boolean {
    return isNarrativeSpinoffSession(sessionId);
}

/**
 * 写入闸门：番外一律拒绝，并把话说清楚。
 *
 * 为什么抛错而不是静默返回：这些入口散在抽取器、面板按钮、报幕回写好几条链路里，
 * 静默失败会让人以为"卡存下了"，回头找不到更费解。抛出来让调用方决定怎么兜——
 * 抽取侧照例被 catch 掉（番外本来就不该抽），面板侧显示成一条提示。
 */
export function assertNarrativeWritable(
    sessionId: string,
    caller: string
): void {
    if (!isNarrativeReadOnlySession(sessionId)) return;
    throw new Error(
        `[NarrativeWriter] ${caller} 被拒绝：番外不写记忆。番外的记忆只读继承来源对局，` +
        `需要改记忆请回主线那一场操作。（对局 ${sessionId}）`
    );
}

/**
 * 给面板横幅用：这场番外继承自哪一场、什么模式。
 * 读不到来源（已删除）时返回 null，由界面显示"来源已删除，本场没有可继承的记忆"。
 */
export function spinoffSourceOf(
    sessionId: string | null | undefined
): SpinoffSourceInfo | null {
    const sid = (sessionId ?? "").trim();
    if (!sid) return null;
    const self = getMixSession(sid);
    if (!self?.spinoff) return null;

    const memory: MixSpinoffMemory = self.spinoff.memory === "inherit" ? "inherit" : "none";
    const anchorId = narrativeReadSessionId(sid);
    // 链断（回落自己）或本来就不继承：没有可报的来源
    if (anchorId === sid) return null;
    const anchor: MixSession | null = getMixSession(anchorId);
    if (!anchor) return null;
    return { id: anchor.id, name: mixSessionTitle(anchor), memory };
}
