// lib/mascot-waiting-pace.ts
// 卷宝等待提示的纯计算层：把「墙上时间」和「单调时间」分开算，再拼成一句她看得懂的话。
//
// 为什么非要两个时钟：她 2026-11-03 报「小卷一直提示在思考，不知道是不是真的在调用」。
// 本机诊断日志实测到一次提问的第 2 轮 wallMs = 3,151,895（52 分 31 秒），而该轮 chunk
// 最大空档 3,142,591 —— 整轮只有一收一发。手机息屏 / 切后台会把 JS 冻住：setTimeout 不触发、
// requestAnimationFrame 不跑，但 Date.now() 照走，回来才发现"等了 52 分钟"。
// `performance.now()` 这类单调时钟在挂起期间不走，所以
//   前台真正等了多久 = 单调时间差；被挂起多久 = 墙上时间差 − 单调时间差。
// 这一层不碰 DOM、不碰存储，方便单测；界面和诊断日志都引用同一套算法。

/** 墙上时间比单调时间多走出这么多毫秒，才认定中间发生过挂起（小于这个量当作调度抖动） */
export const MASCOT_SUSPEND_MIN_GAP_MS = 5_000;

/** 参照值（"前几轮通常 X"）超过这个时长就不给了：那说明这几轮本身不可信 */
export const MASCOT_PACE_CAP_MS = 180_000;

/** 参照取最近几轮，不是全部：冷启动那一轮最慢，用全局均值会把参照抬虚高 */
export const MASCOT_PACE_SAMPLE_COUNT = 3;

export type MascotWaitSplit = {
    /** 前台真正等待的毫秒数（不含挂起段） */
    foregroundMs: number;
    /** 判为「页面被挂起」的毫秒数 */
    suspendedMs: number;
};

function asMs(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * 把一段等待拆成「前台真等」与「挂起冻结」。
 * 传进来的两个数应当是同一轮里 `Date.now()` 差与 `performance.now()` 差。
 * 单调时间反而比墙上大（时钟不同源、或取反了）时按前台等待处理，不谎报挂起。
 */
export function splitWaitGap(wallMs: number, monoMs: number, thresholdMs: number = MASCOT_SUSPEND_MIN_GAP_MS): MascotWaitSplit {
    const wall = asMs(wallMs);
    const mono = asMs(monoMs);
    if (!wall || !mono) return { foregroundMs: 0, suspendedMs: 0 };
    const gap = wall - mono;
    const suspendedMs = gap >= thresholdMs ? gap : 0;
    return { foregroundMs: Math.min(wall, mono), suspendedMs };
}

export type MascotWaitStart = {
    /** 起点：`Date.now()` */
    startedWallAt: number;
    /** 起点：`performance.now()` */
    startedMonoAt: number;
};

/** 墙上时钟 */
export function nowWall(): number {
    return Date.now();
}

/**
 * 单调时钟：页面挂起期间它不走，所以能用来分辨「真在等」和「被冻住」。
 * 拿不到 performance 的环境（测试里没注入、老 WebView）退回墙上时间 ——
 * 结果是挂起恒为 0，宁可少说一次挂起，也不许把等待算成负的。
 */
export function nowMono(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

/** 起点快照：两个时钟一起取，差值才有意义 */
export function markWaitStart(): MascotWaitStart {
    return { startedWallAt: nowWall(), startedMonoAt: nowMono() };
}

/** 进行中的等待：用当前的两个 now 值算，界面每秒重算一次就用它 */
export function measureWait(
    start: MascotWaitStart,
    nowWall: number,
    nowMono: number,
    thresholdMs: number = MASCOT_SUSPEND_MIN_GAP_MS,
): MascotWaitSplit {
    if (!Number.isFinite(start.startedWallAt) || !Number.isFinite(start.startedMonoAt)) {
        return { foregroundMs: 0, suspendedMs: 0 };
    }
    return splitWaitGap(nowWall - start.startedWallAt, nowMono - start.startedMonoAt, thresholdMs);
}

/**
 * 参照时长：最近 N 个**前台**样本的均值（挂起段必须先剔掉再传进来）。
 * 样本不足用现有的；一个都没有、或均值高过上限时返回 null —— 宁可不给参照，也不编一个。
 */
export function rollingPaceMs(
    samples: number[],
    count: number = MASCOT_PACE_SAMPLE_COUNT,
    capMs: number = MASCOT_PACE_CAP_MS,
): number | null {
    const clean = samples.filter(s => Number.isFinite(s) && s > 0);
    if (!clean.length) return null;
    const take = Math.max(1, Math.floor(count));
    const window = clean.slice(-take);
    const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
    if (!Number.isFinite(mean) || mean <= 0 || mean > capMs) return null;
    return Math.round(mean);
}

/** 只有秒 / 分秒 / 小时三种写法，别在屏幕上写 ms、s、min */
export function formatMascotElapsed(ms: number): string {
    const totalSeconds = Math.floor(asMs(ms) / 1000);
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
}

export type MascotWaitingLabelInput = {
    /** 第几轮（从 1 起） */
    round: number;
    maxRounds: number;
    /** 本轮已经开始执行的动作中文名；没有就说明还在等模型回话 */
    toolName?: string | null;
    /** 前台已等毫秒（不含挂起） */
    foregroundMs: number;
    /** 最近几轮的前台均值，null = 不给参照 */
    paceMs?: number | null;
    /** 本轮已经吃掉的挂起时长 */
    suspendedMs?: number;
};

/** 超出参照这么多倍才提参照，否则正常等待也被写成"慢" */
const PACE_OVERTIME_RATIO = 1.5;

/**
 * 一句她下一步能看懂的话：第几步、在做什么、实际等了多久。
 * 挂起过的要说破 —— 不然她以为小卷想了 52 分钟，其实是手机把页面冻住了。
 */
export function formatMascotWaitingLabel(input: MascotWaitingLabelInput): string {
    const round = Math.max(1, Math.floor(input.round) || 1);
    const max = Math.max(round, Math.floor(input.maxRounds) || round);
    const foregroundMs = asMs(input.foregroundMs);
    const suspendedMs = asMs(input.suspendedMs ?? 0);
    const doing = input.toolName && input.toolName.trim()
        ? `正在${input.toolName.trim()}`
        : "正在等小卷回话";

    const parts = [`第 ${round} / ${max} 步 · ${doing}`, `已 ${formatMascotElapsed(foregroundMs)}`];

    const pace = input.paceMs;
    const slowEnough = typeof pace === "number" && pace > 0 && foregroundMs > pace * PACE_OVERTIME_RATIO;
    if (slowEnough && pace) parts.push(`（前几轮通常 ${formatMascotElapsed(pace)}）`);

    if (suspendedMs >= MASCOT_SUSPEND_MIN_GAP_MS) {
        parts.push(`其中 ${formatMascotElapsed(suspendedMs)} 是手机把页面挂起了，实际只等了 ${formatMascotElapsed(foregroundMs)}`);
    }

    return parts.join(" · ");
}

/**
 * 会话列表那一行的短版：整句在两行高的行里会被 `truncate` 剪掉，剪一半比不说还容易误读。
 * 只保留「第几步 · 在做什么 · 已等多久」；一旦发生过挂起，就把动作名让给挂起那段
 * —— 那一行最需要说破的是「这不是小卷想得慢」。
 */
export function formatMascotWaitingShortLabel(input: MascotWaitingLabelInput): string {
    const round = Math.max(1, Math.floor(input.round) || 1);
    const max = Math.max(round, Math.floor(input.maxRounds) || round);
    const foregroundMs = asMs(input.foregroundMs);
    const suspendedMs = asMs(input.suspendedMs ?? 0);

    const parts = [`第 ${round}/${max} 步`];
    if (suspendedMs < MASCOT_SUSPEND_MIN_GAP_MS) {
        parts.push(input.toolName && input.toolName.trim() ? `正在${input.toolName.trim()}` : "正在等小卷回话");
    }
    parts.push(`已 ${formatMascotElapsed(foregroundMs)}`);
    if (suspendedMs >= MASCOT_SUSPEND_MIN_GAP_MS) {
        parts.push(`页面挂起 ${formatMascotElapsed(suspendedMs)}`);
    }
    return parts.join(" · ");
}

export type MascotWaitTimingLike = {
    wallMs?: number;
    /** 原样带过来即可，这句文案只用得上拆好的前两项 */
    monoMs?: number;
    foregroundMs?: number;
    suspendedMs?: number;
} | null | undefined;

/**
 * 诊断日志里那一轮的「时间证据」。写这句的理由：日志原本只有一个墙上时长，
 * 挂起 52 分钟和模型真想了 52 分钟长得一模一样 —— 这正是她这次分不清的原因。
 * 两个时钟缺一个（老数据、取不到 performance）就返回 null，让界面什么都不加，
 * 不许拿 0 冒充「没挂起」。
 */
export function formatMascotWaitEvidence(timing: MascotWaitTimingLike): string | null {
    if (!timing) return null;
    const wall = asMs(timing.wallMs ?? 0);
    const foreground = asMs(timing.foregroundMs ?? 0);
    if (!wall && !foreground) return null;
    const suspended = asMs(timing.suspendedMs ?? 0);
    if (suspended >= MASCOT_SUSPEND_MIN_GAP_MS) {
        return `整轮 ${formatMascotElapsed(wall || foreground)} · 页面挂起 ${formatMascotElapsed(suspended)} · 前台真正等了 ${formatMascotElapsed(foreground)}`;
    }
    return `整轮 ${formatMascotElapsed(wall || foreground)} 都在前台等待`;
}
