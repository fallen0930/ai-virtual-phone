// lib/mixology/session-runtime.ts
// 独家特调 · 对局运行时：管理多对局并行生成状态
//
// 核心能力：
// 1. 追踪所有正在生成/排队中的对局
// 2. 最大并发数限制（默认 3），超出自动排队
// 3. 组件卸载不打断生成 —— 生成由本 store 持有，UI 只是订阅者
// 4. 提供 useSyncExternalStore 兼容的订阅接口
// 5. 流式文本按帧批量更新，避免高频 token 回调引发的渲染风暴

export type MixGenStatus = "generating" | "queued" | "done" | "error";

export type MixRunningSession = {
    sessionId: string;
    status: MixGenStatus;
    /** 当前流式输出的文本（生成中时持续更新） */
    liveText: string;
    /** 错误信息（status === "error" 时有值） */
    error?: string;
    /** 开始时间戳 */
    startedAt: number;
};

export type MixSessionRuntimeState = {
    /** sessionId -> 运行时状态 */
    running: Record<string, MixRunningSession>;
    /** 最大并发生成数 */
    maxConcurrent: number;
};

const MAX_CONCURRENT = 3;

let _state: MixSessionRuntimeState = {
    running: {},
    maxConcurrent: MAX_CONCURRENT,
};

const _listeners = new Set<() => void>();

/** 排队中的任务队列 */
type QueuedTask = {
    sessionId: string;
    generator: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<void>;
};
const _queue: QueuedTask[] = [];

/** 运行中任务的 AbortController 映射 */
const _controllers = new Map<string, AbortController>();

/**
 * 每对局待刷新的文本缓冲：流式回调高频涌入时，
 * 先往缓冲里累加，下一帧统一 flush 进 state，
 * 避免一个 token 触发一次 notify + React 重渲染的风暴。
 */
const _pendingDeltas = new Map<string, string>();
let _flushRaf = 0;

function notifyListeners() {
    _listeners.forEach((fn) => fn());
}

/** 把所有待刷新的文本一次性写入 state 并通知 UI（每帧最多一次） */
function flushPendingDeltas() {
    _flushRaf = 0;
    if (_pendingDeltas.size === 0) return;

    // 批量合并：只 notify 一次
    let changed = false;
    const nextRunning = { ..._state.running };
    for (const [sessionId, delta] of _pendingDeltas) {
        const existing = nextRunning[sessionId];
        if (!existing) continue;
        if (!delta) continue;
        nextRunning[sessionId] = { ...existing, liveText: existing.liveText + delta };
        changed = true;
    }
    _pendingDeltas.clear();

    if (changed) {
        _state = { ..._state, running: nextRunning };
        notifyListeners();
    }
}

/** 调度一次帧末批量刷新 */
function scheduleFlush() {
    if (_flushRaf) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        // 非浏览器环境（SSR）直接同步 flush
        flushPendingDeltas();
        return;
    }
    _flushRaf = window.requestAnimationFrame(flushPendingDeltas);
}

/** 向某对局的文本缓冲追加增量 */
function appendLiveDelta(sessionId: string, chunk: string) {
    if (!chunk) return;
    _pendingDeltas.set(sessionId, (_pendingDeltas.get(sessionId) || "") + chunk);
    scheduleFlush();
}

// ── 订阅 API ──────────────────────────────────────────────

export function getMixSessionRuntimeState(): MixSessionRuntimeState {
    // 如果有未刷新的增量，先同步刷新一次，确保订阅者拿到最新值
    if (_pendingDeltas.size > 0) {
        flushPendingDeltas();
    }
    return _state;
}

export function subscribeMixSessionRuntime(fn: () => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}

// ── 查询 API ──────────────────────────────────────────────

export function isMixSessionGenerating(sessionId: string): boolean {
    const entry = _state.running[sessionId];
    return !!entry && (entry.status === "generating" || entry.status === "queued");
}

export function getMixSessionLiveText(sessionId: string): string {
    const base = _state.running[sessionId]?.liveText || "";
    // 加上还没 flush 的缓冲，确保读取方拿到最新值
    const pending = _pendingDeltas.get(sessionId);
    return pending ? base + pending : base;
}

export function getMixSessionGenStatus(sessionId: string): MixGenStatus | null {
    return _state.running[sessionId]?.status || null;
}

/** 当前正在生成（不含排队）的对局数量 */
export function getActiveMixGenerationCount(): number {
    return Object.values(_state.running).filter((s) => s.status === "generating").length;
}

// ── 内部工具 ──────────────────────────────────────────────

function updateEntry(sessionId: string, patch: Partial<MixRunningSession>) {
    const existing = _state.running[sessionId];
    if (!existing) return;
    // 状态变更前先把缓冲里的文本刷进去，避免丢字
    const pending = _pendingDeltas.get(sessionId);
    const mergedLive = pending && patch.liveText === undefined
        ? existing.liveText + pending
        : patch.liveText ?? existing.liveText;
    if (pending) _pendingDeltas.delete(sessionId);

    _state = {
        ..._state,
        running: {
            ..._state.running,
            [sessionId]: { ...existing, ...patch, liveText: mergedLive },
        },
    };
    notifyListeners();
}

function removeEntry(sessionId: string) {
    if (!_state.running[sessionId]) return;
    _pendingDeltas.delete(sessionId);
    const next = { ..._state.running };
    delete next[sessionId];
    _state = { ..._state, running: next };
    notifyListeners();
}

/**
 * 真正启动一个生成任务（立即开始分支与 pumpQueue 共用这一套）。
 * 调用前必须确保并发槽有空位、session 已在 running 里、controller 已创建。
 */
function startGeneration(
    sessionId: string,
    controller: AbortController,
    generator: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<void>,
) {
    const onDelta = (chunk: string) => {
        // 入缓冲，按帧批量刷新 —— 多对局并行时互不阻塞
        appendLiveDelta(sessionId, chunk);
    };

    generator(controller.signal, onDelta)
        .then(() => {
            // 生成结束：先把剩下的缓冲刷干净
            flushPendingDeltas();
            updateEntry(sessionId, { status: "done" });
            // 立刻尝试启动下一个排队任务（不要等 UI 的 1.5 秒延迟）
            pumpQueue();
            // 短暂保留 done 状态供 UI 展示，延迟清理
            setTimeout(() => {
                removeEntry(sessionId);
                _controllers.delete(sessionId);
            }, 1500);
        })
        .catch((err) => {
            flushPendingDeltas();
            if (controller.signal.aborted) {
                // 主动取消，直接移除
                removeEntry(sessionId);
                _controllers.delete(sessionId);
            } else {
                updateEntry(sessionId, {
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                });
                // 错误状态保留久一点，让用户看到
                setTimeout(() => {
                    removeEntry(sessionId);
                    _controllers.delete(sessionId);
                }, 4000);
            }
            pumpQueue();
        });
}

/** 尝试从队列取下一个任务运行 */
function pumpQueue() {
    // 先把所有缓冲刷新掉，确保计数基于最新状态
    if (_pendingDeltas.size > 0) flushPendingDeltas();

    const activeCount = getActiveMixGenerationCount();
    if (activeCount >= _state.maxConcurrent) return;
    if (_queue.length === 0) return;

    const next = _queue.shift();
    if (!next) return;

    const entry = _state.running[next.sessionId];
    if (!entry) {
        // 条目可能已被取消，跳过
        pumpQueue();
        return;
    }

    const controller = new AbortController();
    _controllers.set(next.sessionId, controller);

    updateEntry(next.sessionId, { status: "generating", liveText: "" });

    startGeneration(next.sessionId, controller, next.generator);

    // 可能还有空位，继续填（比如并发上限从 1 调到 3 时一次性起 3 个）
    pumpQueue();
}

// ── 操作 API ──────────────────────────────────────────────

/**
 * 提交一个生成任务到运行时。
 * 如果当前并发数未达上限，立即开始；否则进入排队。
 *
 * @param sessionId 对局 ID
 * @param generator 实际的生成函数，接收 signal 和 onDelta 回调
 */
export function enqueueMixGeneration(
    sessionId: string,
    generator: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<void>
): void {
    // 如果已经在运行或排队，忽略重复提交
    if (_state.running[sessionId]) return;

    const now = Date.now();
    const activeCount = getActiveMixGenerationCount();

    if (activeCount < _state.maxConcurrent) {
        // 立即开始
        const controller = new AbortController();
        _controllers.set(sessionId, controller);

        _state = {
            ..._state,
            running: {
                ..._state.running,
                [sessionId]: {
                    sessionId,
                    status: "generating",
                    liveText: "",
                    startedAt: now,
                },
            },
        };
        notifyListeners();

        startGeneration(sessionId, controller, generator);
    } else {
        // 进入排队
        _queue.push({ sessionId, generator });
        _state = {
            ..._state,
            running: {
                ..._state.running,
                [sessionId]: {
                    sessionId,
                    status: "queued",
                    liveText: "",
                    startedAt: now,
                },
            },
        };
        notifyListeners();
    }
}

/**
 * 取消某个对局的生成（无论正在生成还是排队中）。
 */
export function cancelMixGeneration(sessionId: string): void {
    const entry = _state.running[sessionId];
    if (!entry) return;

    if (entry.status === "queued") {
        // 从排队队列中移除
        const idx = _queue.findIndex((q) => q.sessionId === sessionId);
        if (idx >= 0) _queue.splice(idx, 1);
        removeEntry(sessionId);
    } else if (entry.status === "generating") {
        // 中止正在进行的生成
        const controller = _controllers.get(sessionId);
        if (controller) {
            controller.abort();
        }
        // abort 会触发 generator 的 catch 分支，那里会清理 entry
    }
}

/**
 * 取消所有正在进行和排队中的生成。
 */
export function cancelAllMixGenerations(): void {
    // 先清队列
    _queue.length = 0;

    // 中止所有正在生成的
    for (const [sessionId, controller] of _controllers.entries()) {
        const entry = _state.running[sessionId];
        if (entry?.status === "generating") {
            controller.abort();
        }
    }

    // 清理所有 queued 状态的 entry（generating 状态由 abort 回调清理）
    const queuedIds = Object.entries(_state.running)
        .filter(([, v]) => v.status === "queued")
        .map(([k]) => k);
    if (queuedIds.length > 0) {
        const next = { ..._state.running };
        queuedIds.forEach((id) => delete next[id]);
        _state = { ..._state, running: next };
        notifyListeners();
    }
}

/**
 * 修改最大并发数（运行时可调）。
 * 调大后会自动从队列取任务补充。
 */
export function setMaxMixConcurrent(max: number): void {
    if (max < 1) max = 1;
    _state = { ..._state, maxConcurrent: max };
    notifyListeners();
    // 如果并发上限提高了，尝试填充（pumpQueue 内部会递归直到填满或队列空）
    pumpQueue();
}
