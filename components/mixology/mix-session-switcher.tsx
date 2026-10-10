"use client";

// 独家特调 · 对局悬浮切换器
// 只在对局画面内显示的悬浮球，点击展开对局列表，支持快速切换对局。
// 切换对局不打断正在生成的回复（生成由 session-runtime 统一管理）。
//
// 交互：
// - 拖拽移动，松手自动贴边（左/右）
// - 点击展开/收起对局列表面板
// - 列表项前的圆点标识生成状态（生成中/排队/完成/错误）

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { GlassWater, X } from "lucide-react";
import {
    subscribeMixSessionRuntime,
    getMixSessionRuntimeState,
    getMixSessionGenStatus,
    type MixGenStatus,
} from "@/lib/mixology/session-runtime";
import { loadMixSessions, type MixSession } from "@/lib/mixology/storage";
import { mixRoundCount } from "@/lib/mixology/engine";
import { mixSlotFirstId, getMixMaterial, type MixCharacterCard } from "@/lib/mixology/types";

type FloatingPosition = { left: number; top: number };
type PopoverPosition = { left: number; top: number };
type DockSide = "left" | "right";

type FloatingDragState = {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

const ANCHOR_STORAGE_KEY = "mix_session_switcher_anchor";

function clampFloatingPosition(value: number, max: number): number {
    return Math.min(Math.max(12, value), max);
}

function getInitialAnchor(): { left: number; top: number; dockSide: DockSide } | null {
    if (typeof window === "undefined") return null;
    try {
        const stored = localStorage.getItem(ANCHOR_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (typeof parsed?.left === "number" && typeof parsed?.top === "number") {
                return {
                    left: parsed.left,
                    top: parsed.top,
                    dockSide: parsed.dockSide === "left" ? "left" : "right",
                };
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function saveAnchor(pos: { left: number; top: number; dockSide: DockSide }) {
    try {
        localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(pos));
    } catch {
        // ignore
    }
}

/** 状态圆点颜色映射 */
function statusDotColor(status: MixGenStatus | null): string {
    switch (status) {
        case "generating":
            return "#8d7bf5"; // 紫罗兰色 — 生成中
        case "queued":
            return "#d9b06a"; // 金色 — 排队中
        case "done":
            return "#4ade80"; // 绿色 — 已完成
        case "error":
            return "#f87171"; // 红色 — 出错
        default:
            return "rgba(242, 240, 247, 0.2)"; // 灰色 — 空闲
    }
}

function statusDotTitle(status: MixGenStatus | null): string {
    switch (status) {
        case "generating":
            return "生成中";
        case "queued":
            return "排队中";
        case "done":
            return "已完成";
        case "error":
            return "生成出错";
        default:
            return "";
    }
}

type Props = {
    sessionId: string;
    onSwitch: (sessionId: string) => void;
};

export function MixSessionSwitcher({ sessionId, onSwitch }: Props) {
    const [open, setOpen] = useState(false);
    const [sessions, setSessions] = useState<MixSession[]>(() => loadMixSessions());
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(() => {
        const anchor = getInitialAnchor();
        return anchor ? { left: anchor.left, top: anchor.top } : null;
    });
    const [dockSide, setDockSide] = useState<DockSide>(() => getInitialAnchor()?.dockSide ?? "right");
    const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<FloatingDragState | null>(null);
    const suppressClickRef = useRef(false);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    // 订阅运行时状态，用于更新每个对局的状态圆点
    const runtimeState = useSyncExternalStore(
        subscribeMixSessionRuntime,
        getMixSessionRuntimeState,
        getMixSessionRuntimeState
    );

    // 是否有对局正在生成（用于悬浮球上的呼吸提示）
    const anyGenerating = Object.values(runtimeState.running).some(
        (s) => s.status === "generating" || s.status === "queued"
    );

    const refreshSessions = useCallback(() => {
        setSessions(loadMixSessions());
    }, []);

    // 点击外部关闭
    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!layerRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [open]);

    // 视口尺寸变化时，把坐标夹回屏幕内
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        const apply = () => {
            const rect = layer.getBoundingClientRect();
            const size = 48;
            const edge = 16;
            setFloatingPosition((prev) => {
                if (!prev) return prev;
                const maxLeft = Math.max(edge, rect.width - size - edge);
                const maxTop = Math.max(edge, rect.height - size - edge);
                const nextLeft = clampFloatingPosition(prev.left, maxLeft);
                const nextTop = clampFloatingPosition(prev.top, maxTop);
                if (nextLeft === prev.left && nextTop === prev.top) return prev;
                return { left: nextLeft, top: nextTop };
            });
        };
        apply();
        window.addEventListener("resize", apply);
        return () => window.removeEventListener("resize", apply);
    }, []);

    // 计算弹出面板位置
    useLayoutEffect(() => {
        const layer = layerRef.current;
        const button = buttonRef.current;
        if (!open || !layer || !button) {
            setPopoverPosition(null);
            return;
        }
        const rect = layer.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const posAnchor = dragging && floatingPosition
            ? floatingPosition
            : floatingPosition ?? {
                  left: buttonRect.left - rect.left,
                  top: buttonRect.top - rect.top,
              };

        const width = Math.min(280, rect.width - 32);
        const estimatedHeight = Math.min(360, Math.max(200, rect.height - 120));
        // 面板出现在悬浮球的对侧（靠左就出右边，靠右就出左边）
        const isLeftSide = dockSide === "left";
        const left = isLeftSide
            ? posAnchor.left + 48 + 8 // 球在左，面板在球右边
            : posAnchor.left - width - 8; // 球在右，面板在球左边
        const top = posAnchor.top - estimatedHeight / 2 + 24;
        const maxTop = Math.max(60, rect.height - estimatedHeight - 16);

        setPopoverPosition({
            left: Math.min(Math.max(16, left), Math.max(16, rect.width - width - 16)),
            top: Math.min(Math.max(60, top), maxTop),
        });
    }, [open, floatingPosition, dragging, dockSide]);

    function getButtonBounds(button: HTMLButtonElement, currentPos: FloatingPosition | null) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const left = currentPos ? currentPos.left : button.offsetLeft;
        const top = currentPos ? currentPos.top : button.offsetTop;
        return {
            left,
            top,
            maxLeft: Math.max(16, parentRect.width - 48 - 16),
            maxTop: Math.max(16, parentRect.height - 48 - 16),
            parentWidth: parentRect.width,
            parentHeight: parentRect.height,
        };
    }

    function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        if (open) {
            // 展开时不允许拖拽，避免干扰
            return;
        }
        event.stopPropagation();
        const button = event.currentTarget;
        const bounds = getButtonBounds(button, floatingPosition);
        dragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        button.setPointerCapture(event.pointerId);
    }

    function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (!drag.moved) {
            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                drag.moved = true;
                setDragging(true);
            } else {
                return;
            }
        }
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handlePointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) {
            suppressClickRef.current = true;
            // 贴边吸附
            const bounds = getButtonBounds(event.currentTarget, floatingPosition);
            const midX = bounds.parentWidth / 2;
            const currentX = drag.left + (event.clientX - drag.startClientX);
            const currentTop = drag.top + (event.clientY - drag.startClientY);
            const isLeft = currentX < midX;
            const size = 48;
            const edge = 16;
            const snappedLeft = isLeft ? edge : Math.max(edge, bounds.parentWidth - size - edge);
            const snappedTop = clampFloatingPosition(currentTop, bounds.maxTop);
            const newPos = { left: snappedLeft, top: snappedTop };
            setFloatingPosition(newPos);
            setDockSide(isLeft ? "left" : "right");
            saveAnchor({ ...newPos, dockSide: isLeft ? "left" : "right" });
        }

        dragRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        if (open) {
            setOpen(false);
            return;
        }
        // 展开前刷新一下对局列表
        refreshSessions();
        setOpen(true);
    }

    function handleSwitchSession(targetId: string) {
        if (targetId === sessionId) {
            setOpen(false);
            return;
        }
        onSwitch(targetId);
        setOpen(false);
    }

    // 取对局显示名：角色名 · 配方名
    function sessionDisplayName(session: MixSession): string {
        return `${session.charName} · ${session.recipe.name}`;
    }

    // 取对局封面图
    function sessionCover(session: MixSession): string | null {
        const charId = mixSlotFirstId(session.recipe.slots, "character");
        if (!charId) return null;
        const mat = getMixMaterial(charId);
        if (mat?.kind === "character") {
            return (mat as MixCharacterCard).cover || null;
        }
        return null;
    }

    const popoverStyle: CSSProperties | undefined = popoverPosition
        ? { left: popoverPosition.left, top: popoverPosition.top }
        : undefined;

    const buttonStyle: CSSProperties | undefined = floatingPosition
        ? { left: floatingPosition.left, top: floatingPosition.top }
        : { right: 16, bottom: 140 };

    return (
        <div className="mix-session-switcher-layer" ref={layerRef}>
            <button
                ref={buttonRef}
                type="button"
                className="mix-session-switcher-btn"
                aria-label="切换对局"
                data-dragging={dragging ? "" : undefined}
                data-dock-side={dockSide}
                data-generating={anyGenerating ? "" : undefined}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                onClick={handleButtonClick}
                style={buttonStyle}
            >
                <GlassWater size={22} strokeWidth={1.8} />
                {anyGenerating ? <span className="mix-switcher-dot-pulse" /> : null}
            </button>

            {open ? (
                <div
                    className="mix-session-switcher-panel"
                    style={popoverStyle}
                    role="dialog"
                    aria-label="对局列表"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="mix-switcher-header">
                        <div className="mix-switcher-title">
                            <GlassWater size={16} />
                            <span>切换对局</span>
                        </div>
                        <button
                            type="button"
                            className="mix-switcher-close"
                            onClick={() => setOpen(false)}
                            aria-label="关闭"
                        >
                            <X size={16} />
                        </button>
                    </div>

                    <div className="mix-switcher-list">
                        {sessions.length === 0 ? (
                            <div className="mix-switcher-empty">还没有对局</div>
                        ) : (
                            sessions
                                .sort((a, b) => b.updatedAt - a.updatedAt)
                                .map((s) => {
                                    const status = getMixSessionGenStatus(s.id);
                                    const isActive = s.id === sessionId;
                                    const cover = sessionCover(s);
                                    return (
                                        <button
                                            type="button"
                                            key={s.id}
                                            className="mix-switcher-item"
                                            data-active={isActive ? "" : undefined}
                                            onClick={() => handleSwitchSession(s.id)}
                                            title={statusDotTitle(status)}
                                        >
                                            <span
                                                className="mix-switcher-status-dot"
                                                style={{ background: statusDotColor(status) }}
                                                data-generating={status === "generating" ? "" : undefined}
                                            />
                                            {cover ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img
                                                    className="mix-switcher-ava"
                                                    src={cover}
                                                    alt=""
                                                />
                                            ) : (
                                                <div className="mix-switcher-ava-fallback">
                                                    {s.charName.slice(0, 1)}
                                                </div>
                                            )}
                                            <div className="mix-switcher-item-info">
                                                <div className="mix-switcher-item-name">
                                                    {sessionDisplayName(s)}
                                                </div>
                                                <div className="mix-switcher-item-sub">
                                                    {mixRoundCount(s.turns)} 轮
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
