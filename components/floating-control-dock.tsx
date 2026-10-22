"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SlidersHorizontal, MessageSquare, Network, Type, Layers, LayoutGrid, ChevronRight, MoveVertical, Compass, Cpu, ArrowLeftRight, StickyNote, MoreHorizontal, Settings2, Hash, Feather } from "lucide-react";
import {
    CONTROL_DEFS,
    CONTROL_LABELS,
    DEFAULT_RESIDENT_CONTROL_IDS,
    ControlId,
    getControlDockState,
    subscribeControlDockState,
    toggleControlDockExpanded,
    setControlDockExpanded,
    isControlEnabled,
    isControlPinned,
    toggleControlEnabled,
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
    "quick-note": <StickyNote size={21} strokeWidth={1.9} />,
    "mix-tree": <Network size={21} strokeWidth={1.8} />,
    "mix-word-count": <Type size={21} strokeWidth={1.9} />,
    "mix-token": <Hash size={21} strokeWidth={1.9} />,
    "mix-session-switcher": <Layers size={21} strokeWidth={1.9} />,
    "mix-story-rail": <MoveVertical size={21} strokeWidth={1.9} />,
    "mix-story-compass": <Compass size={21} strokeWidth={1.9} />,
    "mix-model-badge": <Cpu size={21} strokeWidth={1.9} />,
    "narrative-writer": <Feather size={21} strokeWidth={1.9} />,
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
    const [moreOpen, setMoreOpen] = useState(false);
    const [activeControl, setActiveControl] = useState<ControlId | null>(null);
    const [draggingDock, setDraggingDock] = useState(false);
    const dockRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ startY: number; startDockY: number; moved: boolean } | null>(null);
    const suppressHandleClickRef = useRef(false);

    useEffect(() => {
        return subscribeControlDockState(() => setState(getControlDockState()));
    }, []);

    // 一次性算出坞条按钮（可使用 + 常驻显示）与「更多」列表项（可使用但不常驻）。
    // 判定直接读订阅态里的 enabled/pinned，而不是调 store 的 getter，
    // 否则 useMemo 依赖里看不出数据源，勾选变化时容易漏刷新。
    const { residentControls, overflowControls } = useMemo(() => {
        const enabledList = state.order.filter(id => {
            const def = CONTROL_DEFS.find(d => d.id === id);
            if (!def) return false;
            if (!isInScope(def.scope, activeApp)) return false;
            return state.enabled[id] !== false;
        });
        const isResident = (id: ControlId) => state.pinned[id] ?? DEFAULT_RESIDENT_CONTROL_IDS.includes(id);
        return {
            residentControls: enabledList.filter(id => isResident(id)),
            overflowControls: enabledList.filter(id => !isResident(id)),
        };
    }, [state, activeApp]);

    // 场景切换 / 关掉可用后没有隐藏项了，别把「更多」弹层留在屏幕上
    useEffect(() => {
        if (!overflowControls.length) setMoreOpen(false);
    }, [overflowControls.length]);

    // 点坞外任意处收掉弹层（坞内按钮自己负责开合，不受影响）
    useEffect(() => {
        if (!manageOpen && !moreOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (dockRef.current?.contains(e.target as Node)) return;
            setManageOpen(false);
            setMoreOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [manageOpen, moreOpen]);

    const handleActivate = useCallback(
        (id: ControlId) => {
            // 记录被点按钮相对 phone-shell 的坐标，供受管控件把面板贴着坞按钮弹出
            // 「更多」列表项同样带 data-control，所以面板也能贴着「更多」按钮弹出
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
            /* 弹层展开时抬高整坞层级：否则会被速记小窗（z 63）等悬浮件盖住管理面板 */
            data-panel={manageOpen || moreOpen ? "open" : undefined}
            onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                // 按钮 / 管理弹层里的东西不参与拖动，其它位置（抓手条、按钮之间的空隙）都能拖整坞
                if (target.closest("button") || target.closest(".fcd-manage-panel") || target.closest(".fcd-more-panel")) return;
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

                    {residentControls.map(id => (
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

                    {overflowControls.length > 0 && (
                        <>
                            <button
                                type="button"
                                className="fcd-btn fcd-more"
                                title={`更多功能（${overflowControls.length} 项可用，未常驻）`}
                                aria-label="更多功能"
                                aria-expanded={moreOpen}
                                data-active={moreOpen ? "true" : undefined}
                                onClick={() => {
                                    setManageOpen(false);
                                    setMoreOpen(o => !o);
                                }}
                            >
                                <MoreHorizontal size={20} strokeWidth={2} />
                                <span className="fcd-more-count">{overflowControls.length}</span>
                            </button>

                            {moreOpen && (
                                <div className="fcd-more-panel" onPointerDown={e => e.stopPropagation()}>
                                    <h4>更多功能</h4>
                                    <p className="fcd-more-hint">这些功能随时可用，只是不占坞条位置；想让谁常驻，去管理控件勾「常驻」。</p>
                                    {overflowControls.map(id => (
                                        <button
                                            key={id}
                                            type="button"
                                            data-control={id}
                                            className="fcd-more-item"
                                            data-active={activeControl === id ? "true" : undefined}
                                            onClick={() => handleActivate(id)}
                                        >
                                            <span className="fcd-ico">{ICONS[id]}</span>
                                            <span className="fcd-more-name">{CONTROL_LABELS[id]}</span>
                                            <ChevronRight size={14} strokeWidth={2} />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    <button
                        type="button"
                        className="fcd-btn fcd-manage"
                        title="管理控件"
                        aria-label="管理控件"
                        data-active={manageOpen ? "true" : undefined}
                        onClick={() => {
                            setMoreOpen(false);
                            setManageOpen(o => !o);
                        }}
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
                            setMoreOpen(false);
                            setControlDockExpanded(false);
                        }}
                    >
                        <ChevronRight size={18} strokeWidth={2} />
                    </button>

                    {manageOpen && (
                        <div className="fcd-manage-panel" onPointerDown={e => e.stopPropagation()}>
                            <h4>控制坞管理</h4>
                            <p className="fcd-manage-hint">
                                <b>可使用</b>= 这个功能要不要开着；关掉后坞、「更多」、界面上的浮标小窗都不再出现。
                                <b>常驻</b>= 坞条上要不要给它留一个按钮；只关常驻不关可用 = 收进坞底「更多」，点开照样用。
                                对局类控件仅在打开调酒 / 对局 App 时出现。
                            </p>
                            <div className="fcd-manage-head">
                                <span>控件</span>
                                <span title="可使用">可用</span>
                                <span title="常驻显示在坞条上">常驻</span>
                                <span />
                            </div>
                            {state.order.map((id, idx) => {
                                const def = CONTROL_DEFS.find(d => d.id === id);
                                if (!def) return null;
                                const enabled = isControlEnabled(id);
                                const resident = isControlPinned(id);
                                return (
                                    <div className="fcd-manage-row" key={id} data-off={enabled ? undefined : "true"}>
                                        <span className="fcd-manage-name">
                                            <span className="fcd-ico">{ICONS[id]}</span>
                                            <span className="fcd-manage-text">{CONTROL_LABELS[id]}</span>
                                            {def.scope === "mixology" && <span className="fcd-scope" title="仅打开调酒 / 对局 App 时出现">对局</span>}
                                        </span>
                                        <label className="fcd-sw" title="可使用：关闭 = 彻底停用，坞和「更多」里都不出现">
                                            <input
                                                type="checkbox"
                                                checked={enabled}
                                                onChange={() => toggleControlEnabled(id)}
                                            />
                                        </label>
                                        <label className="fcd-sw" title="常驻显示：开启 = 坞条上有按钮；关闭 = 收进「更多」，仍可使用">
                                            <input
                                                type="checkbox"
                                                checked={enabled && resident}
                                                disabled={!enabled}
                                                onChange={() => toggleControlPin(id)}
                                            />
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
