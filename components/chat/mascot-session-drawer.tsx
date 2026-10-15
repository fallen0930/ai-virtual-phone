"use client";

import { useEffect, useMemo, useState } from "react";
import { MoreVertical, Pencil, Pin, PinOff, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { MascotSession } from "@/lib/mascot-chat-store";

// ── 「对话记录」抽屉 ──────────────────────────────────
// 对标工坊（phone-qa-app）的会话抽屉：右侧白底、列表（标题 + 相对时间 + ⋯ 菜单），
// 底部两个动作——「压缩总结并新开」与「新对话」。用于替代原来塞在
// AI助手信息里的扁平会话列表。

function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    const date = new Date(ts);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

const DRAWER_STYLES = `
.mascot-drawer-layer {
    position: absolute;
    inset: 0;
    z-index: 120;
    display: flex;
    justify-content: flex-end;
    background: rgba(0, 0, 0, 0.28);
    animation: mascot-drawer-fade 0.16s ease;
}
@keyframes mascot-drawer-fade { from { opacity: 0; } to { opacity: 1; } }
.mascot-drawer {
    width: min(330px, 84%);
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--c-panel, #fff);
    border-left: 1px solid var(--c-panel-border, rgba(0,0,0,0.08));
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.14);
    animation: mascot-drawer-slide 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes mascot-drawer-slide { from { transform: translateX(100%); } to { transform: translateX(0); } }
.mascot-drawer-head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(env(safe-area-inset-top, 0px) + 14px) 16px 6px;
}
.mascot-drawer-title {
    font-size: 15.5px;
    font-weight: 600;
    color: var(--c-text-title, #111);
    letter-spacing: 0.2px;
}
.mascot-drawer-close {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--c-text, #797E85);
    cursor: pointer;
}
.mascot-drawer-close:hover { background: color-mix(in srgb, var(--c-text) 10%, transparent); }
.mascot-drawer-usage {
    flex-shrink: 0;
    padding: 4px 16px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.mascot-drawer-usage-bar {
    height: 5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-text) 14%, transparent);
    overflow: hidden;
}
.mascot-drawer-usage-bar > i {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--c-action-blue, #246bfd);
    transition: width 0.25s ease;
}
.mascot-drawer-usage-text {
    font-size: 11.5px;
    color: var(--c-text, #797E85);
}
.mascot-drawer-usage-text[data-warn="true"] { color: #e5484d; }
.mascot-drawer-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 2px 8px 8px;
}
.mascot-drawer-empty {
    padding: 28px 0;
    text-align: center;
    font-size: 13px;
    color: var(--c-text, #797E85);
}
.mascot-drawer-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 6px 10px 14px;
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.15s ease;
}
.mascot-drawer-item:hover { background: color-mix(in srgb, var(--c-text) 6%, transparent); }
.mascot-drawer-item.is-active { background: color-mix(in srgb, var(--c-text) 10%, transparent); }
.mascot-drawer-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
}
.mascot-drawer-item-title {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    color: var(--c-text-title, #111);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.mascot-drawer-pin-mark { color: var(--c-action-blue, #246bfd); flex-shrink: 0; }
.mascot-drawer-item-time { font-size: 11.5px; color: var(--c-text, #797E85); }
.mascot-drawer-item-more {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--c-text, #797E85);
    opacity: 0.6;
    cursor: pointer;
}
.mascot-drawer-item-more:hover { opacity: 1; background: color-mix(in srgb, var(--c-text) 10%, transparent); }
.mascot-drawer-item-menu {
    position: absolute;
    top: 40px;
    right: 8px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-width: 118px;
    padding: 4px;
    border-radius: 10px;
    border: 1px solid var(--c-panel-border, rgba(0,0,0,0.08));
    background: var(--c-panel, #fff);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.mascot-drawer-menu-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--c-text-title, #111);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
}
.mascot-drawer-menu-btn:hover { background: color-mix(in srgb, var(--c-text) 9%, transparent); }
.mascot-drawer-menu-btn.is-danger { color: var(--c-danger, #FF3B30); }
.mascot-drawer-foot {
    flex-shrink: 0;
    display: flex;
    gap: 8px;
    padding: 10px 14px calc(env(safe-area-inset-bottom, 0px) + 14px);
    border-top: 1px solid color-mix(in srgb, var(--c-text) 10%, transparent);
}
.mascot-drawer-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 11px 10px;
    border: none;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 500;
    cursor: pointer;
    transition: filter 0.16s ease, transform 0.16s ease, opacity 0.16s ease;
}
.mascot-drawer-btn:active { transform: scale(0.97); }
.mascot-drawer-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mascot-drawer-btn.is-primary {
    background: var(--c-action-blue, #246bfd);
    color: #fff;
    box-shadow: 0 2px 10px color-mix(in srgb, var(--c-action-blue, #246bfd) 35%, transparent);
}
.mascot-drawer-btn.is-primary:hover:not(:disabled) { filter: brightness(1.06); }
.mascot-drawer-btn.is-ghost {
    background: color-mix(in srgb, var(--c-text) 9%, transparent);
    color: var(--c-text-title, #111);
}
.mascot-drawer-btn.is-ghost:hover:not(:disabled) { filter: brightness(0.97); }
`;

export function MascotSessionDrawer({
    sessions,
    activeId,
    busy,
    usedChars,
    budgetChars,
    onSelect,
    onDelete,
    onRenameRequest,
    onTogglePin,
    onCreate,
    onCompressAndCreate,
    onClose,
}: {
    sessions: MascotSession[];
    activeId: string | null;
    busy: boolean;
    usedChars: number;
    budgetChars: number;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onRenameRequest: (id: string, title: string) => void;
    onTogglePin: (id: string) => void;
    onCreate: () => void;
    onCompressAndCreate: () => void;
    onClose: () => void;
}) {
    const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    // 置顶的排最前，其余保持时间序。只在渲染层排，存储顺序不动。
    const sortedSessions = useMemo(
        () => [...sessions].sort((a, b) => {
            if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
            return b.updatedAt - a.updatedAt;
        }),
        [sessions],
    );

    const pct = budgetChars > 0 ? Math.min(999, Math.round((usedChars / budgetChars) * 100)) : 0;
    const warn = pct >= 80;

    return (
        <div className="mascot-drawer-layer" onClick={onClose} role="presentation">
            <style>{DRAWER_STYLES}</style>
            <aside className="mascot-drawer" onClick={(event) => event.stopPropagation()} aria-label="对话记录">
                <div className="mascot-drawer-head">
                    <span className="mascot-drawer-title">对话记录</span>
                    <button type="button" className="mascot-drawer-close" onClick={onClose} aria-label="关闭">
                        <X size={18} strokeWidth={1.75} />
                    </button>
                </div>

                <div className="mascot-drawer-usage">
                    <div className="mascot-drawer-usage-bar">
                        <i style={{ width: `${Math.min(100, pct)}%`, background: warn ? "#e5484d" : undefined }} />
                    </div>
                    <span className="mascot-drawer-usage-text" data-warn={warn}>
                        当前会话上下文 {pct}%（约 {usedChars.toLocaleString()} / {budgetChars.toLocaleString()} 字）
                    </span>
                </div>

                <div
                    className="mascot-drawer-list hide-scrollbar"
                    onClick={() => { if (menuOpenId) setMenuOpenId(null); }}
                >
                    {sortedSessions.length === 0 && <div className="mascot-drawer-empty">还没有对话</div>}
                    {sortedSessions.map((session) => {
                        const active = session.id === activeId;
                        return (
                            <div
                                key={session.id}
                                className={`mascot-drawer-item ${active ? "is-active" : ""}`}
                                onClick={() => onSelect(session.id)}
                            >
                                <button
                                    type="button"
                                    className="mascot-drawer-item-main"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onSelect(session.id);
                                    }}
                                >
                                    <span className="mascot-drawer-item-title">
                                        {session.isPinned && <Pin size={12} className="mascot-drawer-pin-mark" aria-label="已置顶" />}
                                        {session.title}
                                        {active ? "（当前）" : ""}
                                    </span>
                                    <span className="mascot-drawer-item-time">{formatRelativeTime(session.updatedAt)}</span>
                                </button>

                                <button
                                    type="button"
                                    className="mascot-drawer-item-more"
                                    aria-label="更多操作"
                                    aria-expanded={menuOpenId === session.id}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setMenuOpenId(menuOpenId === session.id ? null : session.id);
                                    }}
                                >
                                    <MoreVertical size={15} />
                                </button>

                                {menuOpenId === session.id && (
                                    <div className="mascot-drawer-item-menu" role="menu">
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="mascot-drawer-menu-btn"
                                            disabled={busy}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onTogglePin(session.id);
                                                setMenuOpenId(null);
                                            }}
                                        >
                                            {session.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                                            {session.isPinned ? "取消置顶" : "置顶"}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="mascot-drawer-menu-btn"
                                            disabled={busy}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onRenameRequest(session.id, session.title);
                                                setMenuOpenId(null);
                                            }}
                                        >
                                            <Pencil size={14} /> 重命名
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="mascot-drawer-menu-btn is-danger"
                                            disabled={busy}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onDelete(session.id);
                                                setMenuOpenId(null);
                                            }}
                                        >
                                            <Trash2 size={14} /> 删除
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <div className="mascot-drawer-foot">
                    <button
                        type="button"
                        className="mascot-drawer-btn is-ghost"
                        disabled={busy}
                        onClick={onCompressAndCreate}
                        title="把当前会话压成摘要，作为新窗口的开场上下文"
                    >
                        <Sparkles size={15} strokeWidth={1.75} />
                        <span>压缩总结并新开</span>
                    </button>
                    <button
                        type="button"
                        className="mascot-drawer-btn is-primary"
                        disabled={busy}
                        onClick={onCreate}
                    >
                        <Plus size={16} strokeWidth={2} />
                        <span>新对话</span>
                    </button>
                </div>
            </aside>
        </div>
    );
}
