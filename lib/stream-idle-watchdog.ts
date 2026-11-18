// lib/stream-idle-watchdog.ts
// SSE 流式请求的「断流看门狗」：盯多久没字节，而不是只掐总时长。
//
// 动机（诊断日志 mascot-diag-20261112-1221）：中转站首包 130~190 秒是常态，第 5 轮
// 更是在首块之后 17.8 分钟一个字节都没有。旧链路只有「总时长 500 秒」的粗闸，
// 一轮挂死就烧满 500 秒再走无超时的兜底直连，用户看到的是「小卷突然不说话了」。
//
// 两个闸并存：
//   · 断流闸 idleMs —— 每收到一块数据 touch() 续命，连续 idleMs 没动静即判死；
//   · 总闸 totalMs —— 续命续到天亮也有上限，慢而不断的长生成照样在 totalMs 收口。
// 判死方式统一走 AbortController：fetch/reader 收到 abort 后自然抛出，调用方按错误分类。
// idleTimedOut 让上层区分「断流」与「总时长到点」，前者才值得自动重试。

export type StreamIdleWatchdogOptions = {
    /** 总时长闸（毫秒） */
    totalMs: number;
    /** 断流闸：连续多少毫秒没有任何字节就判死 */
    idleMs: number;
    /** 外部中止信号（用户按停等）：透传，且不算超时 */
    signal?: AbortSignal | null;
};

export class StreamIdleWatchdog {
    readonly signal: AbortSignal;
    /** 断流闸到点为真；总闸到点或外部中止为假 */
    idleTimedOut = false;
    /** 任一内部计时器到点（区别于外部中止），供 diag 的 timedOut 用 */
    timedOut = false;

    private readonly controller = new AbortController();
    private readonly totalMs: number;
    private readonly idleMs: number;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private totalTimer: ReturnType<typeof setTimeout> | null = null;
    private detachExternal: (() => void) | null = null;
    private disposed = false;

    constructor(options: StreamIdleWatchdogOptions) {
        this.totalMs = options.totalMs;
        this.idleMs = options.idleMs;
        this.signal = this.controller.signal;

        if (options.signal) {
            if (options.signal.aborted) {
                // 外部已经停了：直接透传，不再挂任何计时器
                this.controller.abort(options.signal.reason);
                this.disposed = true;
                return;
            }
            const onExternalAbort = () => this.controller.abort(options.signal?.reason);
            options.signal.addEventListener("abort", onExternalAbort, { once: true });
            this.detachExternal = () => options.signal?.removeEventListener("abort", onExternalAbort);
        }

        this.armIdle();
        this.totalTimer = setTimeout(() => {
            this.timedOut = true;
            this.controller.abort(new Error(`流式回复超过总时长上限（${Math.round(this.totalMs / 1000)} 秒）`));
        }, options.totalMs);
    }

    /** 收到数据就续命：断流闸重新计时 */
    touch(): void {
        if (this.disposed || this.controller.signal.aborted) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.armIdle();
    }

    /** 收工清理：清掉两个计时器与外部监听，之后 touch 全部失效 */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (this.totalTimer) { clearTimeout(this.totalTimer); this.totalTimer = null; }
        if (this.detachExternal) { this.detachExternal(); this.detachExternal = null; }
    }

    private armIdle(): void {
        this.idleTimer = setTimeout(() => {
            this.timedOut = true;
            this.idleTimedOut = true;
            this.controller.abort(new Error(`${Math.round(this.idleMs / 1000)} 秒没有收到任何数据，流式回复中断`));
        }, this.idleMs);
    }
}

/**
 * 给一次性 fetch 挂「超时 + 外部中止」的组合信号。
 * 旧写法 `signal: options?.signal` 在外部没给信号时等于裸奔——兜底直连就这样跟着中转一起挂死过。
 * 外部信号已中止时直接透传原信号（调用方语义不变）。
 */
export function withTimeoutSignal(external: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
    if (external?.aborted) return external;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    if (external) {
        external.addEventListener("abort", () => {
            clearTimeout(timer);
            controller.abort(external.reason);
        }, { once: true });
    }
    return controller.signal;
}
