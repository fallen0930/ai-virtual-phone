// lib/mixology/world-tree-intent.ts
// 独家特调 · 「进对局后把世界树展开」的一次性意图。
//
// 为什么要有这么个东西：对局列表上的「支线 N」角标点开就该是那棵世界树，
// 但世界树面板挂在详情页（mixology-game）里，列表页点角标时它还没挂载。
// 用一条内存里的意图传话：列表页请求 → 详情页的世界树挂载时消费并自动展开。
//
// 刻意用模块内存变量而不是 localStorage/sessionStorage：
// 这只是一个跳转意图，刷新就没了完全可以接受；写进存储反而留下没人清的脏键。

let pendingSessionId: string | null = null;

/** 请求：进入 sessionId 这场对局后，把世界树面板展开 */
export function requestMixWorldTreeOpen(sessionId: string): void {
    pendingSessionId = sessionId || null;
}

/** 消费：只有 id 对得上才算数，取到一次立即清掉，不影响下一场对局 */
export function consumeMixWorldTreeOpen(sessionId: string): boolean {
    if (!pendingSessionId || pendingSessionId !== sessionId) return false;
    pendingSessionId = null;
    return true;
}

/** 清空待展开意图（跳转失败、退出特调时用，免得意图挂到下一次进别的对局） */
export function resetMixWorldTreeOpen(): void {
    pendingSessionId = null;
}
