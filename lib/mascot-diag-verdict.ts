// lib/mascot-diag-verdict.ts
// 卷宝诊断日志 · 纯判定层。
// 只吃普通对象，不碰存储/网络，方便单测；界面和导出都引用同一套结论。

import { MASCOT_SUSPEND_MIN_GAP_MS, formatMascotElapsed } from "./mascot-waiting-pace";

export type MascotDiagUsage = {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    /** OpenAI 兼容的 completion_tokens_details.reasoning_tokens */
    reasoningTokens?: number;
    /** Gemini 的 thoughtsTokenCount */
    thoughtsTokens?: number;
};

export type MascotDiagRoundTimingLike = {
    wallMs?: number;
    foregroundMs?: number;
    suspendedMs?: number;
};

export type MascotDiagRoundLike = {
    protocol?: "native" | "text";
    finishReason?: string;
    sawDone?: boolean;
    endedNormally?: boolean;
    aborted?: "user" | "timeout" | "external";
    error?: string;
    contentChars?: number;
    reasoningChars?: number;
    toolCallCount?: number;
    toolFetchCount?: number;
    truncatedToolNames?: string[];
    textTruncated?: boolean;
    parseErrors?: number;
    engineChars?: number;
    paintedChars?: number;
    maxPaintGapMs?: number;
    hiddenDuringStream?: boolean;
    usage?: MascotDiagUsage;
    maxTokens?: number | null;
    fallbackUsed?: boolean;
    attemptError?: string;
    loopDecision?: string;
    /**
     * 这一轮的两种时长：墙上时间差与单调时间差拆出来的结果（见 lib/mascot-waiting-pace.ts）。
     * 手机息屏 / 切后台会把 JS 冻住、`Date.now()` 照走，只看墙上时间就会把挂起记成「模型想了很久」。
     */
    timing?: MascotDiagRoundTimingLike;
};

export type MascotDiagVerdictCode =
    | "normal"
    | "truncated_length"
    | "truncated_actions"
    | "stream_cut"
    | "text_parse_error"
    | "empty_response"
    | "thinking_only"
    | "ui_stall"
    | "suspended"
    | "timeout"
    | "aborted"
    | "error"
    | "unknown";

export type MascotDiagVerdict = {
    code: MascotDiagVerdictCode;
    /** 行上用的四五个字 */
    label: string;
    /** 详情里用的完整句子 */
    detail: string;
};

const TRUNCATION_REASONS = new Set([
    "length",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "max_token",
]);

export function isTruncationFinishReason(reason?: string): boolean {
    if (!reason) return false;
    return TRUNCATION_REASONS.has(String(reason).trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从任意一个流式 chunk / 非流式响应里取 finishReason */
export function extractDiagFinishReason(data: unknown): string | undefined {
    const d = asRecord(data);
    if (!d) return undefined;
    const firstChoice = asRecord(asArray(d.choices)[0]);
    const firstCandidate = asRecord(asArray(d.candidates)[0]);
    const delta = asRecord(d.delta);
    const message = asRecord(d.message);
    const output = asRecord(d.output);
    return str(firstChoice?.finish_reason)
        ?? str(d.stop_reason)
        ?? str(firstCandidate?.finishReason)
        ?? str(d.finish_reason)
        ?? str(output?.finish_reason)
        ?? str(delta?.stop_reason)
        ?? str(message?.stop_reason);
}

function normalizeUsage(raw: Record<string, unknown> | null): MascotDiagUsage | undefined {
    if (!raw) return undefined;
    const details = asRecord(raw.completion_tokens_details);
    const promptTokens = num(raw.prompt_tokens) ?? num(raw.input_tokens) ?? num(raw.promptTokenCount);
    const completionTokens = num(raw.completion_tokens) ?? num(raw.output_tokens) ?? num(raw.candidatesTokenCount);
    const totalTokens = num(raw.total_tokens) ?? num(raw.totalTokenCount);
    const reasoningTokens = num(details?.reasoning_tokens) ?? num(raw.reasoning_tokens);
    const thoughtsTokens = num(raw.thoughtsTokenCount) ?? num(raw.thoughts_token_count);
    if (promptTokens === undefined
        && completionTokens === undefined
        && totalTokens === undefined
        && reasoningTokens === undefined
        && thoughtsTokens === undefined) {
        return undefined;
    }
    return { promptTokens, completionTokens, totalTokens, reasoningTokens, thoughtsTokens };
}

/** 从 chunk 里取 usage；Gemini / Anthropic / OpenAI 兼容三种结构都认 */
export function extractDiagUsage(data: unknown): MascotDiagUsage | undefined {
    const d = asRecord(data);
    if (!d) return undefined;
    return normalizeUsage(asRecord(d.usage))
        ?? normalizeUsage(asRecord(asRecord(d.message)?.usage))
        ?? normalizeUsage(asRecord(d.usageMetadata));
}

/** Anthropic 会把 input/output 分两条事件下发，按字段合并而不是覆盖 */
export function mergeDiagUsage(
    previous?: MascotDiagUsage,
    next?: MascotDiagUsage,
): MascotDiagUsage | undefined {
    if (!previous) return next;
    if (!next) return previous;
    return {
        promptTokens: next.promptTokens ?? previous.promptTokens,
        completionTokens: next.completionTokens ?? previous.completionTokens,
        totalTokens: next.totalTokens ?? previous.totalTokens,
        reasoningTokens: next.reasoningTokens ?? previous.reasoningTokens,
        thoughtsTokens: next.thoughtsTokens ?? previous.thoughtsTokens,
    };
}

function thinkingBudgetDetail(usage?: MascotDiagUsage, maxTokens?: number | null): string {
    const thinking = usage?.thoughtsTokens ?? usage?.reasoningTokens;
    if (!thinking) return "";
    const completion = usage?.completionTokens;
    if (maxTokens && thinking >= maxTokens * 0.8) {
        return `；思考占 ${thinking} token，已接近单次上限 ${maxTokens}`;
    }
    if (completion && thinking / Math.max(1, completion + thinking) >= 0.5) {
        return `；思考占 ${thinking} token，超过输出的一半`;
    }
    return "";
}

/**
 * 单轮结论。顺序就是排查顺序：
 * 中止/超时 → 报错 → 文本协议丢块 → 输出上限 → 残缺动作 → 断流 → 界面停滞 → 空响应 → 正常。
 */
export function buildMascotDiagVerdict(round: MascotDiagRoundLike): MascotDiagVerdict {
    const contentChars = round.contentChars ?? 0;
    const reasoningChars = round.reasoningChars ?? 0;
    const toolCalls = round.toolCallCount ?? 0;
    const toolFetches = round.toolFetchCount ?? 0;
    const hasOutput = contentChars > 0 || reasoningChars > 0 || toolCalls > 0 || toolFetches > 0;
    const fallbackUsed = round.fallbackUsed === true;

    if (round.aborted === "user" || round.aborted === "external") {
        return { code: "aborted", label: "已停止", detail: "用户按了停止，这一轮按主动中止归因。" };
    }
    if (round.aborted === "timeout") {
        return { code: "timeout", label: "超时", detail: "请求超过内部 500 秒上限被中止。" };
    }
    if (round.error && !fallbackUsed) {
        return { code: "error", label: "报错", detail: round.error };
    }
    if (round.protocol === "text" && (round.parseErrors ?? 0) > 0) {
        return {
            code: "text_parse_error",
            label: "丢块",
            detail: `文本协议有 ${round.parseErrors} 个 SSE 分片解析失败，增量可能被吞掉。`,
        };
    }
    if (isTruncationFinishReason(round.finishReason)) {
        return {
            code: "truncated_length",
            label: "上限截断",
            detail: `输出被上限截断（finishReason=${round.finishReason}）${thinkingBudgetDetail(round.usage, round.maxTokens)}。`,
        };
    }
    if ((round.truncatedToolNames?.length ?? 0) > 0 || round.textTruncated) {
        const names = round.truncatedToolNames?.length
            ? `：${round.truncatedToolNames.join("、")}`
            : "";
        return {
            code: "truncated_actions",
            label: "动作残缺",
            detail: `有残缺动作被丢弃${names}，这一轮没有真正执行它。`,
        };
    }
    if (!round.finishReason && !fallbackUsed && (round.sawDone === false || round.endedNormally === false)) {
        const marks = [
            round.sawDone === false ? "没见 [DONE]" : "",
            round.endedNormally === false ? "流没有正常收尾" : "",
        ].filter(Boolean).join("、");
        return {
            code: "stream_cut",
            label: "断流",
            detail: `请求没有拿到收尾标记：${marks || "缺少 finishReason"}。更像中转/网络断开，不是模型主动收尾。`,
        };
    }
    if (typeof round.engineChars === "number" && typeof round.paintedChars === "number") {
        const lostChars = round.engineChars - round.paintedChars;
        const paintGap = round.maxPaintGapMs ?? 0;
        // 补画总会在流结束后把差量追平，所以「差量」只有配合「期间页面在后台」才算证据；
        // 前台也可能因为 rAF 被长任务阻塞而画不动，用超长绘制间隔兜住。
        const stalled = (round.hiddenDuringStream === true && (lostChars > 2 || paintGap >= 1500))
            || (paintGap >= 5000 && lostChars > 12);
        if (stalled) {
            return {
                code: "ui_stall",
                label: "界面停滞",
                detail: `引擎收到 ${round.engineChars} 字，界面只画了 ${round.paintedChars} 字（最大绘制间隔 ${Math.round(paintGap)}ms${round.hiddenDuringStream ? "，期间页面在后台" : ""}）。`,
            };
        }
    }
    // 「页面挂起」排在缺陷判定之后、空响应之前：它不是小卷出了问题，
    // 而是解释「这轮为什么看着等了半小时」—— 她 2026-11-03 那次就是这一档。
    if (typeof round.timing?.suspendedMs === "number" && round.timing.suspendedMs >= MASCOT_SUSPEND_MIN_GAP_MS) {
        const wall = round.timing.wallMs ?? round.timing.suspendedMs;
        const foreground = round.timing.foregroundMs ?? Math.max(0, wall - round.timing.suspendedMs);
        return {
            code: "suspended",
            label: "页面挂起",
            detail: `这一轮墙上时间 ${formatMascotElapsed(wall)}，其中 ${formatMascotElapsed(round.timing.suspendedMs)} 是息屏 / 切后台把页面冻住了，实际只等了 ${formatMascotElapsed(foreground)}。`,
        };
    }
    // 「只有思考」必须排在「空响应」前面：两者都是 content=0，
    // 区别只在 reasoning 有没有字；先判空会把思考型截断错记成空响应。
    if (contentChars === 0 && reasoningChars > 0 && toolCalls === 0 && toolFetches === 0) {
        return {
            code: "thinking_only",
            label: "只有思考",
            detail: `收到了 ${reasoningChars} 字思考，但没有正文或动作。`,
        };
    }
    if (!hasOutput) {
        return {
            code: "empty_response",
            label: "空响应",
            detail: "流正常结束，但没有解析出正文、思考或动作。",
        };
    }
    const fallbackNote = fallbackUsed
        ? `；流式失败后走了非流式兜底（${round.attemptError ? round.attemptError.slice(0, 120) : "原因未记录"}）`
        : "";
    if (round.finishReason || round.endedNormally !== false) {
        return {
            code: "normal",
            label: "正常",
            detail: `正常收尾${round.finishReason ? `（finishReason=${round.finishReason}）` : ""}${fallbackNote}。`,
        };
    }
    return { code: "unknown", label: "待查", detail: "这轮的收尾信息不完整，展开原始记录看。" };
}
