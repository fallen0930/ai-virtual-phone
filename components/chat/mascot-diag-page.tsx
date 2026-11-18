"use client";

// components/chat/mascot-diag-page.tsx
// 卷宝诊断日志（临时排查用）：看「哪一次提问/哪一轮断在哪」并把脱敏日志导出。
// 只在 AI助手 → 信息面板里进入；不注册数据管理模块，不进云端备份。

import { useCallback, useEffect, useState } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { downloadFile } from "@/lib/download-utils";
import {
    MASCOT_DIAG_RETENTION_DAYS,
    clearMascotDiag,
    deleteMascotDiagTask,
    exportMascotDiag,
    getMascotDiagFullCaptureRemaining,
    getMascotDiagSummary,
    isMascotDiagEnabled,
    listMascotDiagTasks,
    requestMascotDiagFullCapture,
    setMascotDiagEnabled,
    type MascotDiagSummary,
    type MascotDiagTaskView,
} from "@/lib/mascot-diag";
import type { MascotDiagVerdict, MascotDiagVerdictCode } from "@/lib/mascot-diag-verdict";
import { formatMascotWaitEvidence } from "@/lib/mascot-waiting-pace";

function notice(detail: string): void {
    window.dispatchEvent(new CustomEvent("global-notice", { detail }));
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSeconds(ms?: number): string {
    if (!ms || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)} 毫秒`;
    return `${(ms / 1000).toFixed(1)} 秒`;
}

/** 结束原因说人话：她不需要知道 finish_reason 这个字段名 */
function explainFinishReason(reason?: string): string {
    if (!reason) return "没有收到结束标记";
    const normalized = reason.trim().toLowerCase();
    if (["length", "max_tokens", "max_output_tokens", "max_completion_tokens", "max_token"].includes(normalized)) {
        return "达到输出上限";
    }
    if (["stop", "end_turn", "stop_sequence", "stopsequence"].includes(normalized)) return "模型正常结束";
    if (["content_filter", "safety", "blocked", "recitation"].includes(normalized)) return "被安全策略拦下";
    return reason;
}

const VERDICT_TONE: Record<MascotDiagVerdictCode, string> = {
    normal: "ok",
    aborted: "muted",
    unknown: "muted",
    thinking_only: "warn",
    empty_response: "warn",
    truncated_length: "warn",
    truncated_actions: "warn",
    text_parse_error: "warn",
    stream_cut: "bad",
    ui_stall: "info",
    suspended: "info",
    timeout: "bad",
    error: "bad",
};

function VerdictBadge({ verdict }: { verdict: MascotDiagVerdict }) {
    return (
        <span className={`mascot-diag-badge is-${VERDICT_TONE[verdict.code] ?? "muted"}`}>{verdict.label}</span>
    );
}

function RoundCard({ roundIndex, verdict, round, protocol, maxTokens }: {
    roundIndex: number;
    verdict: MascotDiagVerdict;
    round: MascotDiagTaskView["rounds"][number];
    protocol: "native" | "text";
    maxTokens?: number | null;
}) {
    const usage = round.stream.usage;
    const thinking = usage?.thoughtsTokens ?? usage?.reasoningTokens;
    const duration = round.endedAt ? round.endedAt - round.startedAt : undefined;
    // 两个时钟分开记之后，这一行能说清「整轮多久」里有几小时是手机把页面冻住了。
    // 老记录没有 timing，退回原来的墙上时长。
    const waitEvidence = formatMascotWaitEvidence(round.timing);
    const facts = [
        `结束原因：${explainFinishReason(round.stream.finishReason)}`,
        round.stream.firstChunkMs !== undefined ? `首字 ${formatSeconds(round.stream.firstChunkMs)}` : "",
        waitEvidence ?? `整轮 ${formatSeconds(duration)}`,
        `正文 ${round.output.contentChars} 字`,
        round.output.reasoningChars > 0 ? `思考 ${round.output.reasoningChars} 字` : "",
        round.output.toolCalls.length > 0 ? `动作 ${round.output.toolCalls.length} 个` : "",
        round.loop?.decision ? `循环判定：${explainLoop(round.loop.decision)}` : "",
    ].filter(Boolean);

    const tokenLine = usage
        ? [
            usage.promptTokens !== undefined ? `输入 ${usage.promptTokens}` : "",
            usage.completionTokens !== undefined ? `输出 ${usage.completionTokens}` : "",
            thinking !== undefined ? `其中思考 ${thinking}` : "",
            maxTokens ? `单次上限 ${maxTokens}` : "",
        ].filter(Boolean).join(" · ")
        : "";

    return (
        <div className="mascot-diag-round">
            <div className="mascot-diag-round-head">
                <span className="mascot-diag-round-title">第 {roundIndex} 轮</span>
                <VerdictBadge verdict={verdict} />
            </div>
            <div className="mascot-diag-round-verdict">{verdict.detail}</div>
            <div className="mascot-diag-facts">{facts.join(" · ")}</div>
            {tokenLine ? <div className="mascot-diag-facts">{tokenLine} token</div> : null}
            {protocol === "text" && (round.output.parseErrors ?? 0) > 0 ? (
                <div className="mascot-diag-facts is-warn">有 {round.output.parseErrors} 个分片没解析出来（文本协议）</div>
            ) : null}
            {round.output.truncatedToolNames?.length ? (
                <div className="mascot-diag-facts is-warn">被丢弃的残缺动作：{round.output.truncatedToolNames.join("、")}</div>
            ) : null}
            {round.fallback?.used ? (
                <div className="mascot-diag-facts">流式失败后改走普通请求：{round.fallback.attemptError}</div>
            ) : null}
            {round.ui ? (
                <div className="mascot-diag-facts">
                    界面：引擎收到 {round.ui.engineChars} 字，画了 {round.ui.paintedChars} 字
                    {round.ui.maxPaintGapMs ? `，最长 ${formatSeconds(round.ui.maxPaintGapMs)} 没刷新` : ""}
                    {round.ui.hiddenDuringStream ? "（期间页面在后台）" : ""}
                </div>
            ) : null}
            {round.output.contentHead ? (
                <>
                    <div className="mascot-diag-label">正文开头</div>
                    <pre className="mascot-diag-pre">{round.output.contentHead}</pre>
                </>
            ) : null}
            {round.output.contentTail ? (
                <>
                    <div className="mascot-diag-label">正文结尾（断在哪）</div>
                    <pre className="mascot-diag-pre">{round.output.contentTail}</pre>
                </>
            ) : null}
            {round.output.contentFull ? (
                <>
                    <div className="mascot-diag-label">完整正文</div>
                    <pre className="mascot-diag-pre">{round.output.contentFull}</pre>
                </>
            ) : null}
            {round.output.reasoningHead ? (
                <>
                    <div className="mascot-diag-label">思考开头</div>
                    <pre className="mascot-diag-pre">{round.output.reasoningHead}</pre>
                </>
            ) : null}
            {round.output.reasoningTail ? (
                <>
                    <div className="mascot-diag-label">思考结尾</div>
                    <pre className="mascot-diag-pre">{round.output.reasoningTail}</pre>
                </>
            ) : null}
        </div>
    );
}

function explainLoop(decision: string): string {
    switch (decision) {
        case "truncated": return "被截断，收工";
        case "auto_continue": return "自动续写";
        case "tool_fetch": return "展开工具集";
        case "actions": return "执行动作";
        case "wrapup": return "模型收尾";
        case "nudge": return "提醒继续";
        case "silent": return "没有动作也没收尾";
        default: return decision;
    }
}

export function MascotDiagPage({ onClose }: { onClose: () => void }) {
    const [enabled, setEnabled] = useState(false);
    const [summary, setSummary] = useState<MascotDiagSummary | null>(null);
    const [tasks, setTasks] = useState<MascotDiagTaskView[]>([]);
    const [fullCaptureLeft, setFullCaptureLeft] = useState(0);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<"" | "export" | "copy" | "clear">("");
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    const refresh = useCallback(async () => {
        const [nextSummary, nextTasks] = await Promise.all([
            getMascotDiagSummary(),
            listMascotDiagTasks(60),
        ]);
        setEnabled(isMascotDiagEnabled());
        setSummary(nextSummary);
        setTasks(nextTasks);
        setFullCaptureLeft(getMascotDiagFullCaptureRemaining());
        setLoading(false);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleToggle = () => {
        const next = !enabled;
        setMascotDiagEnabled(next);
        setEnabled(next);
        notice(next
            ? "已开始记录卷宝诊断日志（只存本机，不会进云端备份）。"
            : "已暂停记录；已有日志还在，可以继续导出。");
    };

    const handleFullCapture = () => {
        const left = requestMascotDiagFullCapture(3);
        setFullCaptureLeft(left);
        notice(`接下来 ${left} 次提问会记录完整正文。`);
    };

    const buildExport = async () => exportMascotDiag({ days: MASCOT_DIAG_RETENTION_DAYS });

    const handleExport = async () => {
        setBusy("export");
        try {
            const result = await buildExport();
            if (result.taskCount === 0) {
                notice("还没有可导出的记录。");
                return;
            }
            if (result.blob) {
                try {
                    await downloadFile(result.blob, result.filename);
                    notice(`已导出 ${result.taskCount} 次提问、${result.roundCount} 轮调用。`);
                    return;
                } catch (error) {
                    console.warn("[MascotDiag] 下载失败，改走复制", error);
                }
            }
            await navigator.clipboard.writeText(result.json);
            notice("浏览器没能直接下载，日志内容已复制到剪贴板。");
        } catch (error) {
            notice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy("");
        }
    };

    const handleCopy = async () => {
        setBusy("copy");
        try {
            const result = await buildExport();
            if (result.taskCount === 0) {
                notice("还没有可复制的记录。");
                return;
            }
            await navigator.clipboard.writeText(result.json);
            notice(`已复制 ${result.taskCount} 次提问的记录。`);
        } catch (error) {
            notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy("");
        }
    };

    const handleClear = async () => {
        setBusy("clear");
        try {
            await clearMascotDiag();
            setShowClearConfirm(false);
            setExpandedId(null);
            await refresh();
            notice("诊断日志已清空。");
        } finally {
            setBusy("");
        }
    };

    const handleDeleteTask = async (id: string) => {
        await deleteMascotDiagTask(id);
        await refresh();
    };

    const abnormal = summary?.abnormalRounds ?? 0;

    return (
        <PageShell title="诊断日志" onBack={onClose} className="absolute inset-0 z-[9999]">
            <div className="mascot-diag-page">
                <div className="mascot-diag-card">
                    <div className="mascot-diag-switch-row">
                        <div>
                            <div className="mascot-diag-switch-title">记录卷宝的运行日志</div>
                            <div className="mascot-diag-switch-desc">
                                默认开启，平时照常用卷宝就行。记录只存在这台手机上，不会进云端备份；保留 {MASCOT_DIAG_RETENTION_DAYS} 天。
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            className={`mascot-diag-switch${enabled ? " is-on" : ""}`}
                            onClick={handleToggle}
                        >
                            <span />
                        </button>
                    </div>
                    <div className="mascot-diag-stat-line">
                        {loading
                            ? "正在读取…"
                            : summary && summary.tasks > 0
                                ? `已记录 ${summary.tasks} 次提问、${summary.rounds} 轮调用${abnormal > 0 ? `，其中 ${abnormal} 轮异常` : ""}`
                                : "还没有记录。正常用卷宝就行，出问题再回来导出。"}
                    </div>
                    <div className="mascot-diag-actions">
                        <button type="button" className="ui-btn ui-btn-soft-action flex-1" disabled={busy !== ""} onClick={() => void handleExport()}>
                            {busy === "export" ? "导出中…" : "导出日志"}
                        </button>
                        <button type="button" className="ui-btn ui-btn-ghost flex-1" disabled={busy !== ""} onClick={() => void handleCopy()}>
                            {busy === "copy" ? "复制中…" : "复制内容"}
                        </button>
                    </div>
                    <div className="mascot-diag-actions">
                        <button type="button" className="ui-btn ui-btn-ghost flex-1" onClick={handleFullCapture}>
                            {fullCaptureLeft > 0 ? `完整记录（还剩 ${fullCaptureLeft} 次）` : "完整记录接下来 3 次"}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-ghost flex-1 text-[var(--c-danger)]"
                            disabled={busy !== "" || (summary?.tasks ?? 0) === 0}
                            onClick={() => setShowClearConfirm(true)}
                        >
                            清空日志
                        </button>
                    </div>
                    <div className="mascot-diag-hint">
                        导出文件已自动去掉网址里的 key、sk- 开头的密钥和 Bearer 令牌；正文只留开头和结尾。
                        「完整记录」会额外保存接下来几次的全文，方便通读被切断的地方。
                    </div>
                </div>

                {tasks.length === 0 ? null : (
                    <div className="mascot-diag-list">
                        {tasks.map((item) => {
                            const isOpen = expandedId === item.task.id;
                            const config = item.task.config;
                            return (
                                <div key={item.task.id} className="mascot-diag-task">
                                    <button
                                        type="button"
                                        className="mascot-diag-task-head"
                                        onClick={() => setExpandedId(isOpen ? null : item.task.id)}
                                    >
                                        <div className="mascot-diag-task-main">
                                            <div className="mascot-diag-task-time">
                                                {formatTime(item.task.createdAt)}
                                                <span className="mascot-diag-meta-sep">·</span>
                                                {item.rounds.length} 轮
                                                <span className="mascot-diag-meta-sep">·</span>
                                                {config.protocol === "native" ? "原生动作" : "文本协议"}
                                                {config.model ? <><span className="mascot-diag-meta-sep">·</span>{config.model}</> : null}
                                            </div>
                                            <div className="mascot-diag-task-text">
                                                {item.task.userText?.head || "（没有记录提问内容）"}
                                                {item.task.userText && item.task.userText.chars > (item.task.userText.head?.length ?? 0) ? "…" : ""}
                                            </div>
                                        </div>
                                        <VerdictBadge verdict={item.taskVerdict} />
                                        <span className="mascot-diag-chevron">{isOpen ? "▾" : "▸"}</span>
                                    </button>
                                    {isOpen && (
                                        <div className="mascot-diag-task-body">
                                            <div className="mascot-diag-facts">
                                                接口：{config.host || "未记录"}
                                                {config.maxTokens ? ` · 单次上限 ${config.maxTokens} token` : ""}
                                                {config.maxRounds ? ` · 最多 ${config.maxRounds} 轮` : ""}
                                                {config.streaming ? "" : " · 未开流式"}
                                            </div>
                                            <div className="mascot-diag-facts">
                                                上下文：{item.task.context.historyMessages} 条消息 / {item.task.context.historyChars} 字
                                                {item.task.context.imageCount > 0 ? ` / ${item.task.context.imageCount} 张图` : ""}
                                                {item.task.context.contextUsage > 0 ? ` · 窗口用量约 ${Math.round(item.task.context.contextUsage * 100)}%` : ""}
                                            </div>
                                            {item.task.end ? (
                                                <div className="mascot-diag-facts">
                                                    收场：{explainTaskEnd(item.task.end.reason)}
                                                    {item.task.end.actions && item.task.end.actions.length > 0
                                                        ? ` · 执行了 ${item.task.end.actions.filter((action) => action.success).length}/${item.task.end.actions.length} 个动作`
                                                        : ""}
                                                    {item.task.end.error ? ` · ${item.task.end.error}` : ""}
                                                </div>
                                            ) : (
                                                <div className="mascot-diag-facts is-warn">这次提问没有留下收场记录（可能还卡在某一步，或应用被系统关掉）。</div>
                                            )}
                                            {item.task.end?.actions && item.task.end.actions.length > 0 ? (
                                                <div className="mascot-diag-facts">
                                                    动作：{item.task.end.actions.map((action) => `${action.name}${action.success ? "✓" : "✗"}`).join("、")}
                                                </div>
                                            ) : null}
                                            {item.rounds.map((round, index) => (
                                                <RoundCard
                                                    key={`${item.task.id}-${round.index}-${index}`}
                                                    roundIndex={round.index}
                                                    verdict={item.verdicts[index] ?? item.taskVerdict}
                                                    round={round}
                                                    protocol={config.protocol}
                                                    maxTokens={config.maxTokens}
                                                />
                                            ))}
                                            <button
                                                type="button"
                                                className="mascot-diag-delete"
                                                onClick={() => void handleDeleteTask(item.task.id)}
                                            >
                                                删除这一条
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {showClearConfirm && (
                <div className="modal-overlay">
                    <div className="modal-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">清空诊断日志？</div>
                        <div className="menu-desc text-left">
                            只清掉这一份排查用的运行记录（本机 {summary?.tasks ?? 0} 条）。
                            你和卷宝的聊天消息一条都不会少，也不影响云端备份。
                            正在查的问题建议先点「导出日志」再清。
                        </div>
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={() => setShowClearConfirm(false)}>取消</button>
                            <button className="ui-btn ui-btn-danger flex-1" disabled={busy === "clear"} onClick={() => void handleClear()}>
                                {busy === "clear" ? "清空中…" : "确认清空"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PageShell>
    );
}

function explainTaskEnd(reason?: string): string {
    switch (reason) {
        case "wrapup": return "模型自己收尾";
        case "truncated": return "输出被截断，没能做完";
        case "rounds": return "轮数用完";
        case "abort": return "你按了停止";
        case "silent": return "没有动作也没有收尾";
        case "error": return "报错结束";
        default: return reason || "未记录";
    }
}
