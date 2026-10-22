// components/music/mini-app-window.tsx — Draggable & resizable mini floating window
"use client";

import { useRef, useState, useCallback, useEffect, type ReactNode } from "react";

// Original phone screen dimensions — content renders at this size then scales down
const PHONE_W = 390;
const PHONE_H = 844;
const TITLEBAR_H = 28;

interface MiniAppWindowProps {
    children: ReactNode;
    onClose: () => void;
    onExpand?: () => void;
    title?: string;
    defaultWidth?: number;
    defaultHeight?: number;
    minWidth?: number;
    minHeight?: number;
    visible?: boolean;
}

export default function MiniAppWindow({
    children, onClose, onExpand, title,
    defaultWidth = 200,
    defaultHeight = 360,
    minWidth = 140,
    minHeight = 160,
    visible = true,
}: MiniAppWindowProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x: 20, y: 60 });
    const [size, setSize] = useState({ w: defaultWidth, h: defaultHeight });
    const dragState = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
    const resizeState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

    // Scale based on width only — height scrolls
    const scale = size.w / PHONE_W;
    const contentH = size.h - TITLEBAR_H;

    // Clamp position within the phone screen
    const clamp = useCallback((x: number, y: number, w: number, h: number) => {
        const bounds = (containerRef.current?.closest("[data-ui='phone-screen']") || containerRef.current?.parentElement) as HTMLElement | null;
        if (!bounds) return { x, y };
        const pw = bounds.clientWidth;
        const ph = bounds.clientHeight;
        return {
            x: Math.max(0, Math.min(x, pw - w)),
            y: Math.max(0, Math.min(y, ph - h)),
        };
    }, []);

    // ── Drag ──
    const onDragStart = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        dragState.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [pos]);

    const onDragMove = useCallback((e: React.PointerEvent) => {
        if (!dragState.current) return;
        const dx = e.clientX - dragState.current.startX;
        const dy = e.clientY - dragState.current.startY;
        const clamped = clamp(dragState.current.startPosX + dx, dragState.current.startPosY + dy, size.w, size.h);
        setPos(clamped);
    }, [size, clamp]);

    const onDragEnd = useCallback(() => { dragState.current = null; }, []);

    // ── Resize (bottom-right corner, free aspect ratio) ──
    const onResizeStart = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        resizeState.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [size]);

    const onResizeMove = useCallback((e: React.PointerEvent) => {
        if (!resizeState.current) return;
        const dx = e.clientX - resizeState.current.startX;
        const dy = e.clientY - resizeState.current.startY;
        const newW = Math.max(minWidth, resizeState.current.startW + dx);
        // Cap height: cannot be taller than original aspect ratio (w/h >= PHONE_W/PHONE_H)
        const maxH = newW * (PHONE_H / PHONE_W) + TITLEBAR_H;
        const newH = Math.min(maxH, Math.max(minHeight, resizeState.current.startH + dy));
        setSize({ w: newW, h: newH });
        const clamped = clamp(pos.x, pos.y, newW, newH);
        setPos(clamped);
    }, [pos, minWidth, minHeight, clamp]);

    const onResizeEnd = useCallback(() => { resizeState.current = null; }, []);

    // Initial clamp
    useEffect(() => {
        const clamped = clamp(pos.x, pos.y, size.w, size.h);
        if (clamped.x !== pos.x || clamped.y !== pos.y) setPos(clamped);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div
            ref={containerRef}
            className="mini-app-window"
            style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, display: visible ? undefined : "none" }}
        >
            {/* Title bar — draggable */}
            <div
                className="mini-app-titlebar"
                onPointerDown={onDragStart}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
            >
                {title && <span className="mini-app-title">{title}</span>}
                <div className="mini-app-titlebar-btns">
                    {onExpand && (
                        <button className="mini-app-btn" onClick={onExpand} title="展开">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                            </svg>
                        </button>
                    )}
                    <button className="mini-app-btn" onClick={onClose} title="关闭">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Content — render at full phone width, scale by width, internal scroll */}
            <div className="mini-app-content">
                <div
                    className="mini-app-inner"
                    style={{
                        width: PHONE_W,
                        height: contentH / scale,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                    }}
                >
                    {children}
                </div>
            </div>

            {/* Resize handle */}
            <div
                className="mini-app-resize"
                onPointerDown={onResizeStart}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeEnd}
                onPointerCancel={onResizeEnd}
            />
        </div>
    );
}
