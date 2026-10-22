// lib/mixology/pending-queue.ts
// 独家特调 · 缓冲发送区：调制（生成回复）期间写好的后续剧情，先存进这条队列，
// 出杯后由对局画面按序逐条接话。
//
// 设计口径：
// ① 队列按 sessionId 挂在模块级 store 里，与 session-runtime 同一套路 ——
//   组件卸载/切对局不打断排队，UI 只是订阅者；
// ② 落 kv-db 持久化：玩家已经敲进去的稿子，刷新页面不能弄丢；
// ③ paused 标记：上一拍生成是出错或被取消（而非正常出杯）时置位，
//   自动接话停下来等人确认 —— 失败之后还把队列往坏掉的现场里灌，
//   等于拿玩家的后文去喂一个已经歪了的上下文，这不该自动发生。

import { isKvHydrated, kvGet, kvSet, registerKvMigration } from "../kv-db";

const PENDING_KEY = "mixology_pending_queue_v1";
registerKvMigration(PENDING_KEY);

/** 单局排队上限：缓冲是用来续写剧情的，不是拿来囤整本书的 */
export const MIX_PENDING_MAX = 50;

export type MixPendingItem = {
    id: string;
    text: string;
};

export type MixPendingState = {
    /** sessionId -> 待发送队列（下标 0 是下一个接话的） */
    queues: Record<string, MixPendingItem[]>;
    /** sessionId -> 自动接话是否因出错/取消而暂停 */
    paused: Record<string, boolean>;
};

const EMPTY_QUEUE: MixPendingItem[] = [];

let _state: MixPendingState = { queues: {}, paused: {} };
let _loaded = false;
const _listeners = new Set<() => void>();

function notifyListeners() {
    _listeners.forEach((fn) => fn());
}

/**
 * 懒加载：kv-db 水合完成前读到的是空缓存，这时候不能把"空"当真数据固化，
 * 标记保持未加载，下次访问再试（特调页面能进对局时早就水合完了，正常走不到重试）。
 */
function ensureLoaded() {
    if (_loaded) return;
    if (!isKvHydrated() && typeof window !== "undefined") return;
    _loaded = true;
    try {
        const raw = kvGet(PENDING_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<MixPendingState>;
            const queues: Record<string, MixPendingItem[]> = {};
            for (const [sid, list] of Object.entries(parsed.queues ?? {})) {
                if (!Array.isArray(list)) continue;
                const clean = list
                    .filter((it): it is MixPendingItem => !!it && typeof it.text === "string" && it.text.trim() !== "")
                    .slice(0, MIX_PENDING_MAX);
                if (clean.length) queues[sid] = clean;
            }
            _state = { queues, paused: { ...(parsed.paused ?? {}) } };
        }
    } catch {
        // 读坏了就当没有队列，绝不能让缓冲区把对局画面带崩
    }
}

function persist() {
    // 未加载成功前不反写，避免用水合前的空态盖掉库里真数据
    if (!_loaded) return;
    try {
        kvSet(PENDING_KEY, JSON.stringify(_state));
    } catch {
        // 存不下就只在内存里排队，本会话照常工作
    }
}

function setState(next: MixPendingState) {
    _state = next;
    persist();
    notifyListeners();
}

// ── 订阅 API ──────────────────────────────────────────────

export function getMixPendingState(): MixPendingState {
    ensureLoaded();
    // getSnapshot 契约：必须返回同引用，加载/变更之外不做任何修改
    return _state;
}

export function subscribeMixPending(fn: () => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}

// ── 查询 API ──────────────────────────────────────────────

export function getMixPendingQueue(sessionId: string): MixPendingItem[] {
    ensureLoaded();
    return _state.queues[sessionId] ?? EMPTY_QUEUE;
}

export function isMixPendingPaused(sessionId: string): boolean {
    ensureLoaded();
    return !!_state.paused[sessionId];
}

// ── 操作 API ──────────────────────────────────────────────

let _seq = 0;
function makePendingId(): string {
    _seq += 1;
    return `mixpending-${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/** 入队一条；返回 false 表示已满（调用方给玩家提示） */
export function pushMixPending(sessionId: string, text: string): boolean {
    ensureLoaded();
    const trimmed = text.trim();
    if (!trimmed) return false;
    const list = _state.queues[sessionId] ?? [];
    if (list.length >= MIX_PENDING_MAX) return false;
    setState({
        ..._state,
        queues: { ..._state.queues, [sessionId]: [...list, { id: makePendingId(), text: trimmed }] },
    });
    return true;
}

/** 取走队首（自动接话用）；空队列返回 null */
export function takeMixPending(sessionId: string): MixPendingItem | null {
    ensureLoaded();
    const list = _state.queues[sessionId];
    if (!list?.length) return null;
    const [head, ...rest] = list;
    const nextQueues = { ..._state.queues };
    if (rest.length) nextQueues[sessionId] = rest;
    else delete nextQueues[sessionId];
    setState({ ..._state, queues: nextQueues });
    return head;
}

export function removeMixPending(sessionId: string, itemId: string): void {
    ensureLoaded();
    const list = _state.queues[sessionId];
    if (!list?.length) return;
    const rest = list.filter((it) => it.id !== itemId);
    const nextQueues = { ..._state.queues };
    if (rest.length) nextQueues[sessionId] = rest;
    else delete nextQueues[sessionId];
    setState({ ..._state, queues: nextQueues });
}

/** 把队首某条捞回输入框（编辑）：等价于删除，插入文本由调用方处理 */
export function clearMixPending(sessionId: string): void {
    ensureLoaded();
    const hadQueue = !!_state.queues[sessionId];
    const wasPaused = !!_state.paused[sessionId];
    if (!hadQueue && !wasPaused) return;
    const nextQueues = { ..._state.queues };
    const nextPaused = { ..._state.paused };
    delete nextQueues[sessionId];
    delete nextPaused[sessionId];
    setState({ ..._state, queues: nextQueues, paused: nextPaused });
}

/** 暂停/恢复自动接话；恢复时一并通知 UI */
export function setMixPendingPaused(sessionId: string, paused: boolean): void {
    ensureLoaded();
    const now = !!_state.paused[sessionId];
    if (now === paused) return;
    const nextPaused = { ..._state.paused };
    if (paused) nextPaused[sessionId] = true;
    else delete nextPaused[sessionId];
    setState({ ..._state, paused: nextPaused });
}

/** 对局删除时顺手清掉它的队列 */
export function dropMixPendingForSession(sessionId: string): void {
    ensureLoaded();
    clearMixPending(sessionId);
}
