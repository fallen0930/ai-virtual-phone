// lib/mixology/session-runtime.ts
// 独家特调 · 对局运行时：管理多对局并行生成状态
//
// 核心能力：
// 1. 追踪所有正在生成/排队中的对局
// 2. 最大并发数限制（默认 3），超出自动排队
// 3. 组件卸载不打断生成 —— 生成由本 store 持有，UI 只是订阅者
// 4. 提供 useSyncExternalStore 兼容的订阅接口

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

function notifyListeners() {
    _listeners.forEach((fn) => fn());
}

// ── 订阅 API ──────────────────────────────────────────────

export function getMixSessionRuntimeState(): MixSessionRuntimeState {
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
    return _state.running[sessionId]?.liveText || "";
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
    _state = {
        ..._state,
        running: {
            ..._state.running,
            [sessionId]: { ...existing, ...patch },
        },
    };
    notifyListeners();
}

function removeEntry(sessionId: string) {
    if (!_state.running[sessionId]) return;
    const next = { ..._state.running };
    delete next[sessionId];
    _state = { ..._state, running: next };
    notifyListeners();
}

/** 尝试从队列取下一个任务运行 */
function pumpQueue() {
    const activeCount = getActiveMixGenerationCount();
    if (activeCount >= _state.maxConcurrent) return;
    if (_queue.length === 0) return;

    const next = _queue.shift();
    if (!next) return;

    // 从 queued 升级为 generating
    const entry = _state.running[next.sessionId];
    if (!entry) {
        // 条目可能已被取消，跳过
        pumpQueue();
        return;
    }

    const controller = new AbortController();
    _controllers.set(next.sessionId, controller);

    updateEntry(next.sessionId, { status: "generating", liveText: "" });

    const onDelta = (chunk: string) => {
        const current = _state.running[next.sessionId];
        if (!current) return;
        updateEntry(next.sessionId, { liveText: current.liveText + chunk });
    };

    next
        .generator(controller.signal, onDelta)
        .then(() => {
            updateEntry(next.sessionId, { status: "done" });
            // 短暂保留 done 状态供 UI 展示，延迟清理
            setTimeout(() => {
                removeEntry(next.sessionId);
                _controllers.delete(next.sessionId);
                pumpQueue();
            }, 1500);
        })
        .catch((err) => {
            if (controller.signal.aborted) {
                // 主动取消，直接移除
                removeEntry(next.sessionId);
                _controllers.delete(next.sessionId);
            } else {
                updateEntry(next.sessionId, {
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                });
                // 错误状态保留久一点，让用户看到
                setTimeout(() => {
                    removeEntry(next.sessionId);
                    _controllers.delete(next.sessionId);
                }, 4000);
            }
            pumpQueue();
        });
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

        const onDelta = (chunk: string) => {
            const current = _state.running[sessionId];
            if (!current) return;
            updateEntry(sessionId, { liveText: current.liveText + chunk });
        };

        generator(controller.signal, onDelta)
            .then(() => {
                updateEntry(sessionId, { status: "done" });
                setTimeout(() => {
                    removeEntry(sessionId);
                    _controllers.delete(sessionId);
                    pumpQueue();
                }, 1500);
            })
            .catch((err) => {
                if (controller.signal.aborted) {
                    removeEntry(sessionId);
                    _controllers.delete(sessionId);
                } else {
                    updateEntry(sessionId, {
                        status: "error",
                        error: err instanceof Error ? err.message : String(err),
                    });
                    setTimeout(() => {
                        removeEntry(sessionId);
                        _controllers.delete(sessionId);
                    }, 4000);
                }
                pumpQueue();
            });
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
    // 如果并发上限提高了，尝试填充
    for (let i = 0; i < max; i++) {
        pumpQueue();
    }
}
