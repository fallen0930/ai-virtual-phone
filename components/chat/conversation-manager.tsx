// components/chat/conversation-manager.tsx
// 多会话管理面板：列出当前联系人的所有对话线程，支持切换 / 重命名 / 删除，
// 以及「直接新建对话」和「压缩总结后开新窗口」两种开新窗口方式。
// 同时展示每条会话的上下文用量，提醒用户何时该换窗口。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    getSessionsForContact,
    createChatSession,
    renameChatSession,
    deleteChatSession,
    pushChatMessage,
    updateChatSession,
    loadChatMessages,
    DEFAULT_SESSION_CONTEXT_TOKEN_BUDGET,
    type ChatSession,
} from "../../lib/chat-storage";
import { estimateSessionTokens, summarizeChatSession } from "../../lib/chat-conversation-utils";
import { loadCharacters } from "../../lib/character-storage";
import { resolveUserIdentity } from "../../lib/settings-storage";
import { X, MessageSquarePlus, Sparkles, Pencil, Trash2, ArrowRight } from "lucide-react";

type ConversationManagerProps = {
    currentSession: ChatSession;
    onClose: () => void;
    /** 切换到指定会话（父层负责把它挂载并设为 active） */
    onSelectSession: (sessionId: string) => void;
};

type RowInfo = {
    session: ChatSession;
    messageCount: number;
    tokenCount: number;
    budget: number;
};

function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
}

export function ConversationManager({ currentSession, onClose, onSelectSession }: ConversationManagerProps) {
    const contactId = currentSession.contactId;
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [rows, setRows] = useState<RowInfo[]>([]);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const refresh = useCallback(() => {
        const list = getSessionsForContact(contactId);
        const infos: RowInfo[] = list.map((s) => {
            const msgs = loadChatMessages(s.id);
            const budget = s.contextTokenBudget || DEFAULT_SESSION_CONTEXT_TOKEN_BUDGET;
            return {
                session: s,
                messageCount: msgs.length,
                tokenCount: estimateSessionTokens(msgs),
                budget,
            };
        });
        setSessions(list);
        setRows(infos);
    }, [contactId]);

    useEffect(() => {
        refresh();
    }, [refresh, currentSession.id]);

    // 当前会话标题兜底：传统单会话显示角色名
    const characterName = useMemo(() => {
        const chars = loadCharacters();
        return chars.find((c) => c.id === contactId)?.name || "AI 助手";
    }, [contactId]);

    const displayTitle = useCallback(
        (s: ChatSession): string => {
            if (s.title) return s.title;
            if (s.isGroup) return s.groupName || "群聊";
            return characterName;
        },
        [characterName],
    );

    const nextIndex = rows.length + 1;

    const handleSelect = (sessionId: string) => {
        if (sessionId === currentSession.id) {
            onClose();
            return;
        }
        onSelectSession(sessionId);
        onClose();
    };

    const startRename = (s: ChatSession) => {
        setRenamingId(s.id);
        setRenameValue(s.title || "");
    };

    const commitRename = () => {
        if (!renamingId) return;
        renameChatSession(renamingId, renameValue);
        setRenamingId(null);
        setRenameValue("");
        refresh();
    };

    const handleDelete = (s: ChatSession) => {
        if (s.isGroup) return; // 群聊不在本面板删除
        const label = displayTitle(s);
        if (!confirm(`确定删除对话「${label}」吗？\n该对话的历史消息会被一并清除，且无法恢复。`)) return;
        deleteChatSession(s.id);
        refresh();
        if (s.id === currentSession.id) {
            // 删的正是当前会话：回到会话列表
            onSelectSession(""); // 父层据此回到列表
        }
        setToast(`已删除对话「${label}」`);
        setTimeout(() => setToast(null), 2000);
    };

    const handleNewBlank = () => {
        if (busy) return;
        setBusy(true);
        try {
            const created = createChatSession(contactId, {
                title: `对话 ${nextIndex}`,
                rootSessionId: currentSession.rootSessionId || currentSession.id,
            });
            refresh();
            onSelectSession(created.id);
            onClose();
        } finally {
            setBusy(false);
        }
    };

    const handleCompressAndNew = () => {
        if (busy) return;
        setBusy(true);
        try {
            const userName = resolveUserIdentity()?.name || "用户";
            const summary = summarizeChatSession(currentSession.id, {
                characterName,
                userName,
            });
            const created = createChatSession(contactId, {
                title: `对话 ${nextIndex}（续）`,
                parentSessionId: currentSession.id,
                rootSessionId: currentSession.rootSessionId || currentSession.id,
            });
            // 把压缩摘要作为 system 上下文写入新会话，保证新窗口「记得」上一轮
            pushChatMessage({ sessionId: created.id, role: "system", content: summary.text });
            updateChatSession(created.id, { compressedSummary: summary.text });
            refresh();
            onSelectSession(created.id);
            onClose();
            setToast(`已压缩上一轮（约 ${formatCount(summary.tokenCount)} token）并开启新窗口`);
            setTimeout(() => setToast(null), 2600);
        } finally {
            setBusy(false);
        }
    };

    const currentUsed = rows.find((r) => r.session.id === currentSession.id)?.tokenCount ?? 0;
    const currentBudget = currentSession.contextTokenBudget || DEFAULT_SESSION_CONTEXT_TOKEN_BUDGET;
    const currentPct = Math.min(100, Math.round((currentUsed / currentBudget) * 100));
    const nearLimit = currentPct >= 80;

    return (
        <div
            className="conversation-manager-overlay"
            style={{
                position: "absolute",
                inset: 0,
                zIndex: 60,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                flexDirection: "column",
                padding: "calc(env(safe-area-inset-top,0px) + 12px) 12px 12px",
                boxSizing: "border-box",
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                style={{
                    margin: "auto",
                    width: "100%",
                    maxWidth: 520,
                    maxHeight: "92%",
                    background: "var(--c-bg, #fff)",
                    color: "var(--c-text, #111)",
                    borderRadius: 16,
                    boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    border: "1px solid var(--c-border, rgba(0,0,0,0.08))",
                }}
            >
                {/* 头部 */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "14px 16px",
                        borderBottom: "1px solid var(--c-border, rgba(0,0,0,0.08))",
                    }}
                >
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>
                            对话管理 · {characterName}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                            与同一个 AI 可开多条独立对话，互不干扰
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="关闭"
                        style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--c-text, #111)",
                            cursor: "pointer",
                            padding: 6,
                            borderRadius: 8,
                            display: "flex",
                        }}
                    >
                        <X size={22} strokeWidth={1.6} />
                    </button>
                </div>

                {/* 当前会话上下文用量 */}
                <div style={{ padding: "12px 16px", background: "var(--c-panel, rgba(0,0,0,0.03))" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                        <span style={{ opacity: 0.7 }}>当前会话上下文用量</span>
                        <span style={{ fontWeight: 600 }}>
                            {formatCount(currentUsed)} / {formatCount(currentBudget)} token（{currentPct}%）
                        </span>
                    </div>
                    <div
                        style={{
                            height: 8,
                            borderRadius: 999,
                            background: "var(--c-border, rgba(0,0,0,0.1))",
                            overflow: "hidden",
                        }}
                    >
                        <div
                            style={{
                                height: "100%",
                                width: `${currentPct}%`,
                                borderRadius: 999,
                                background: nearLimit ? "#e5484d" : currentPct >= 60 ? "#f5a524" : "#3b82f6",
                                transition: "width 0.3s ease",
                            }}
                        />
                    </div>
                    <div style={{ fontSize: 11.5, opacity: 0.65, marginTop: 6, lineHeight: 1.5 }}>
                        {nearLimit
                            ? "⚠️ 已接近上下文上限，前面的内容可能开始被「看不见」。建议点下方「压缩总结后开新窗口」继续聊。"
                            : "当用量接近 100% 时，越早的聊天内容会被模型遗忘。到上限前开个新窗口即可。"}
                    </div>
                </div>

                {/* 会话列表 */}
                <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px" }}>
                    {rows.length === 0 && (
                        <div style={{ padding: 24, textAlign: "center", opacity: 0.6, fontSize: 13 }}>
                            暂无其它对话
                        </div>
                    )}
                    {rows.map((r) => {
                        const isCurrent = r.session.id === currentSession.id;
                        const pct = Math.min(100, Math.round((r.tokenCount / r.budget) * 100));
                        const editing = renamingId === r.session.id;
                        return (
                            <div
                                key={r.session.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 10,
                                    padding: "10px 8px",
                                    borderRadius: 12,
                                    marginBottom: 4,
                                    background: isCurrent ? "var(--c-accent-soft, rgba(59,130,246,0.12))" : "transparent",
                                    border: isCurrent ? "1px solid var(--c-accent, #3b82f6)" : "1px solid transparent",
                                }}
                            >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    {editing ? (
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={(e) => setRenameValue(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") commitRename();
                                                if (e.key === "Escape") {
                                                    setRenamingId(null);
                                                    setRenameValue("");
                                                }
                                            }}
                                            onBlur={commitRename}
                                            style={{
                                                width: "100%",
                                                fontSize: 14,
                                                padding: "6px 8px",
                                                borderRadius: 8,
                                                border: "1px solid var(--c-accent, #3b82f6)",
                                                background: "var(--c-bg, #fff)",
                                                color: "var(--c-text, #111)",
                                            }}
                                        />
                                    ) : (
                                        <div
                                            style={{
                                                fontSize: 14.5,
                                                fontWeight: isCurrent ? 700 : 500,
                                                whiteSpace: "nowrap",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                            }}
                                        >
                                            {displayTitle(r.session)}
                                            {isCurrent && (
                                                <span
                                                    style={{
                                                        marginLeft: 8,
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        color: "var(--c-accent, #3b82f6)",
                                                    }}
                                                >
                                                    当前
                                                </span>
                                            )}
                                            {r.session.parentSessionId && (
                                                <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.55 }}>
                                                    ↳ 续聊
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 3 }}>
                                        {r.messageCount} 条消息 · {formatCount(r.tokenCount)} token（{pct}%）
                                    </div>
                                </div>

                                {!editing && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                        <button
                                            type="button"
                                            title="重命名"
                                            onClick={() => startRename(r.session)}
                                            style={iconBtnStyle}
                                        >
                                            <Pencil size={16} strokeWidth={1.6} />
                                        </button>
                                        {!isCurrent && (
                                            <>
                                                <button
                                                    type="button"
                                                    title="切换到此对话"
                                                    onClick={() => handleSelect(r.session.id)}
                                                    style={{ ...iconBtnStyle, color: "var(--c-accent, #3b82f6)" }}
                                                >
                                                    <ArrowRight size={17} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    type="button"
                                                    title="删除"
                                                    onClick={() => handleDelete(r.session)}
                                                    style={{ ...iconBtnStyle, color: "#e5484d" }}
                                                >
                                                    <Trash2 size={16} strokeWidth={1.6} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* 底部操作 */}
                <div style={{ padding: "12px 16px", borderTop: "1px solid var(--c-border, rgba(0,0,0,0.08))", display: "flex", flexDirection: "column", gap: 8 }}>
                    <button
                        type="button"
                        onClick={handleCompressAndNew}
                        disabled={busy}
                        style={{
                            ...actionBtnStyle,
                            background: "linear-gradient(135deg,#6366f1,#3b82f6)",
                            color: "#fff",
                            opacity: busy ? 0.6 : 1,
                        }}
                    >
                        <Sparkles size={18} strokeWidth={1.8} />
                        压缩总结后开新窗口
                    </button>
                    <button
                        type="button"
                        onClick={handleNewBlank}
                        disabled={busy}
                        style={{
                            ...actionBtnStyle,
                            background: "var(--c-panel, rgba(0,0,0,0.05))",
                            color: "var(--c-text, #111)",
                            border: "1px solid var(--c-border, rgba(0,0,0,0.12))",
                        }}
                    >
                        <MessageSquarePlus size={18} strokeWidth={1.8} />
                        直接新建对话（不压缩）
                    </button>
                    <div style={{ fontSize: 11, opacity: 0.55, textAlign: "center", lineHeight: 1.5 }}>
                        单会话上下文上限约 {formatCount(currentBudget)} token；「压缩总结」会把上一轮要点写进新窗口，避免内容丢失。
                    </div>
                </div>
            </div>

            {toast && (
                <div
                    style={{
                        position: "absolute",
                        left: "50%",
                        bottom: 28,
                        transform: "translateX(-50%)",
                        background: "rgba(0,0,0,0.82)",
                        color: "#fff",
                        fontSize: 13,
                        padding: "9px 16px",
                        borderRadius: 999,
                        zIndex: 70,
                        maxWidth: "86%",
                        textAlign: "center",
                    }}
                >
                    {toast}
                </div>
            )}
        </div>
    );
}

const iconBtnStyle: React.CSSProperties = {
    border: "none",
    background: "var(--c-panel, rgba(0,0,0,0.05))",
    color: "var(--c-text, #111)",
    width: 34,
    height: 34,
    borderRadius: 9,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
};

const actionBtnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    border: "none",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14.5,
    fontWeight: 600,
    cursor: "pointer",
};
