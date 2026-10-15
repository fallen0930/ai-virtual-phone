"use client";

import React, { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SlidersHorizontal, MessageSquare, FileText, Network, Type, Layers, Settings2, LayoutGrid, ChevronRight, Cat, MoveVertical, Compass, Cpu, ArrowLeftRight, StickyNote } from "lucide-react";
import {
    CONTROL_DEFS,
    CONTROL_LABELS,
    ControlId,
    getControlDockState,
    subscribeControlDockState,
    toggleControlDockExpanded,
    setControlDockExpanded,
    isControlPinned,
    toggleControlPin,
    moveControl,
    setDockY,
    toggleDockSide,
    activateControl,
    setDockAnchorByControl,
} from "@/lib/floating-controls-store";

const ICONS: Record<ControlId, React.ReactNode> = {
    "quick-action": <SlidersHorizontal size={22} strokeWidth={1.9} />,
    "mini-chat": <MessageSquare size={21} strokeWidth={1.9} />,
    "prompt-viewer": <FileText size={21} strokeWidth={1.9} />,
    "mascot": <Cat size={21} strokeWidth={1.9} />,
    "quick-note": <StickyNote size={21} strokeWidth={1.9} />,
    "mix-tree": <Network size={21} strokeWidth={1.8} />,
    "mix-word-count": <Type size={21} strokeWidth={1.9} />,
    "mix-session-switcher": <Layers size={21} strokeWidth={1.9} />,
    "mix-story-rail": <MoveVertical size={21} strokeWidth={1.9} />,
    "mix-story-compass": <Compass size={21} strokeWidth={1.9} />,
    "mix-model-badge": <Cpu size={21} strokeWidth={1.9} />,
};

type Props = {
    activeApp: string | null;
};

function isInScope(scope: "global" | "mixology", activeApp: string | null): boolean {
    if (scope === "global") return true;
    return activeApp === "mixology";
}

export function FloatingControlDock({ activeApp }: Props) {
    const [state, setState] = useState(getControlDockState());
    const [manageOpen, setManageOpen] = useState(false);
    const [activeControl, setActiveControl] = useState<ControlId | null>(null);
    const [draggingDock, setDraggingDock] = useState(false);
    const dockRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ startY: number; startDockY: number; moved: boolean } | null>(null);
    const suppressHandleClickRef = useRef(false);

    useEffect(() => {
        return subscribeControlDockState(() => setState(getControlDockState()));
    }, []);

    const visibleControls = state.order.filter(id => {
        const def = CONTROL_DEFS.find(d => d.id === id);
        if (!def) return false;
        if (!isInScope(def.scope, activeApp)) return false;
        return isControlPinned(id);
    });

    const handleActivate = useCallback(
        (id: ControlId) => {
            // 记录被点按钮相对 phone-shell 的坐标，供受管控件把面板贴着坞按钮弹出
            const shell = document.querySelector(".phone-shell") as HTMLElement | null;
            const btn = dockRef.current?.querySelector<HTMLElement>(`[data-control="${id}"]`);
            if (shell && btn) {
                const b = btn.getBoundingClientRect();
                const s = shell.getBoundingClientRect();
                const anchor = { left: b.left - s.left, top: b.top - s.top };
                const merged = { ...getControlDockState().anchorByControl, [id]: anchor };
                setDockAnchorByControl(merged);
            }
            setActiveControl(id);
            activateControl(id);
        },
        [],
    );

    // 拖拽逻辑对「展开态抓手/坞空白」和「收起态手柄」通用：都能上下拖动整坞
    const onDockDragPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
        e.preventDefault();
        const shell = document.querySelector(".phone-shell") as HTMLElement | null;
        const maxTop = shell ? Math.max(12, shell.getBoundingClientRect().height - 120) : 600;
        dragRef.current = { startY: e.clientY, startDockY: Math.min(Math.max(state.dockY, 12), maxTop), moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onDockDragPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const shell = document.querySelector(".phone-shell") as HTMLElement | null;
        const maxTop = shell ? Math.max(12, shell.getBoundingClientRect().height - 120) : 600;
        const delta = e.clientY - drag.startY;
        if (!drag.moved && Math.abs(delta) > 3) drag.moved = true;
        if (!drag.moved) return;
        const next = Math.min(Math.max(drag.startDockY + delta, 12), maxTop);
        setDockY(next);
    };
    const onDockDragPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (drag?.moved) {
            // 拖完松手会紧跟一次 click，抑制掉，避免收起态一拖就误展开
            suppressHandleClickRef.current = true;
        }
        dragRef.current = null;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
    };

    const onHandleClick = () => {
        if (suppressHandleClickRef.current) {
            suppressHandleClickRef.current = false;
            return;
        }
        toggleControlDockExpanded();
    };

    return (
        <div
            className="fcd-dock"
            ref={dockRef}
            style={{ top: state.dockY }}
            data-side={state.dockSide}
            data-dragging={draggingDock ? "" : undefined}
            onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                // 按钮 / 管理弹层里的东西不参与拖动，其它位置（抓手条、按钮之间的空隙）都能拖整坞
                if (target.closest("button") || target.closest(".fcd-manage-panel")) return;
                onDockDragPointerDown(e);
                setDraggingDock(true);
            }}
            onPointerMove={onDockDragPointerMove}
            onPointerUp={(e) => { onDockDragPointerEnd(e); setDraggingDock(false); }}
            onPointerCancel={(e) => { onDockDragPointerEnd(e); setDraggingDock(false); }}
        >
            {!state.expanded && (
                <button
                    type="button"
                    className="fcd-handle"
                    title="展开控制坞（按住可上下拖动）"
                    aria-label="展开控制坞"
                    onPointerDown={onDockDragPointerDown}
                    onPointerMove={onDockDragPointerMove}
                    onPointerUp={onDockDragPointerEnd}
                    onPointerCancel={onDockDragPointerEnd}
                    onClick={onHandleClick}
                >
                    <LayoutGrid size={20} strokeWidth={1.9} />
                </button>
            )}

            {state.expanded && (
                <>
                    <div className="fcd-drag-grip" title="按住上下拖动整坞（按在按钮之间的空隙也能拖）" />

                    <button
                        type="button"
                        className="fcd-side-btn"
                        title={`整坞挪到${state.dockSide === "right" ? "左" : "右"}边`}
                        aria-label="控制坞换边"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={toggleDockSide}
                    >
                        <ArrowLeftRight size={15} strokeWidth={1.9} />
                    </button>

                    {visibleControls.map(id => (
                        <button
                            key={id}
                            type="button"
                            data-control={id}
                            className="fcd-btn"
                            title={CONTROL_LABELS[id]}
                            aria-label={CONTROL_LABELS[id]}
                            data-active={activeControl === id ? "true" : undefined}
                            onClick={() => handleActivate(id)}
                        >
                            {ICONS[id]}
                        </button>
                    ))}

                    <button
                        type="button"
                        className="fcd-btn fcd-manage"
                        title="管理控件"
                        aria-label="管理控件"
                        data-active={manageOpen ? "true" : undefined}
                        onClick={() => setManageOpen(o => !o)}
                    >
                        <Settings2 size={18} strokeWidth={1.9} />
                    </button>

                    <button
                        type="button"
                        className="fcd-btn fcd-collapse"
                        title="收起整个控制坞"
                        aria-label="收起整个控制坞"
                        onClick={() => {
                            setManageOpen(false);
                            setControlDockExpanded(false);
                        }}
                    >
                        <ChevronRight size={18} strokeWidth={2} />
                    </button>

                    {manageOpen && (
                        <div className="fcd-manage-panel" onPointerDown={e => e.stopPropagation()}>
                            <h4>控制坞管理</h4>
                            <p className="fcd-manage-hint">
                                取消勾选 = 该控件彻底隐藏，不会再退回原来的悬浮状态。
                                对局类控件仅在打开调酒 / 对局 App 时出现在坞里。
                            </p>
                            {state.order.map((id, idx) => {
                                const def = CONTROL_DEFS.find(d => d.id === id);
                                if (!def) return null;
                                const pinned = isControlPinned(id);
                                const scopeNote = def.scope === "mixology" ? "（对局页）" : "";
                                return (
                                    <div className="fcd-manage-row" key={id}>
                                        <label className="fcd-manage-label">
                                            <input
                                                type="checkbox"
                                                checked={pinned}
                                                onChange={() => toggleControlPin(id)}
                                            />
                                            <span className="fcd-ico">{ICONS[id]}</span>
                                            <span>{CONTROL_LABELS[id]}{scopeNote}</span>
                                        </label>
                                        <span className="fcd-order">
                                            <button
                                                type="button"
                                                aria-label="上移"
                                                disabled={idx === 0}
                                                onClick={() => moveControl(id, -1)}
                                            >
                                                ▲
                                            </button>
                                            <button
                                                type="button"
                                                aria-label="下移"
                                                disabled={idx === state.order.length - 1}
                                                onClick={() => moveControl(id, 1)}
                                            >
                                                ▼
                                            </button>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
