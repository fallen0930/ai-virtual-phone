"use client";
/**
 * API 配置「拖到文件夹」的通用拖拽 hook。
 *
 * 为什么不用 HTML5 drag & drop：宿主是手机形态 UI，触屏上 HTML5 DnD 完全不触发。
 * 这里统一用 pointer events：
 *  - 鼠标：移动超过 5px 即进入拖拽（不干扰点击）；
 *  - 触屏：长按 260ms 才进入拖拽（手指划动 = 正常滚动列表，不会误拖）。
 *
 * 约定：放置目标元素带 `data-api-drop-group="<groupId>"`（空串 = 未分组），
 * 拖拽经过时自动加 `is-drop-target` 类做高亮；拖拽中 body 加 `api-drag-active`。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ApiConfig } from "./settings-types";

export const API_DROP_ATTR = "data-api-drop-group";

export type ApiDragOverlay = {
    label: string;
    x: number;
    y: number;
    targetGroupId: string | null;
};

type PendingDrag = {
    configId: string;
    label: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    active: boolean;
    longPressTimer: number | null;
};

const MOUSE_START_DISTANCE = 5;
const TOUCH_SCROLL_TOLERANCE = 12;
const LONG_PRESS_MS = 260;

function resolveDropZone(x: number, y: number): HTMLElement | null {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    return element?.closest(`[${API_DROP_ATTR}]`) as HTMLElement | null;
}

function clearDropHighlights(): void {
    document.querySelectorAll<HTMLElement>(`[${API_DROP_ATTR}].is-drop-target`)
        .forEach(element => element.classList.remove("is-drop-target"));
}

export function apiConfigLabel(config: ApiConfig): string {
    return config.name || config.defaultModel || config.provider || "API 配置";
}

export function useApiDrag(onDrop: (configId: string, groupId: string) => void) {
    const [overlay, setOverlay] = useState<ApiDragOverlay | null>(null);
    const pendingRef = useRef<PendingDrag | null>(null);
    const suppressClickRef = useRef(false);
    const onDropRef = useRef(onDrop);
    onDropRef.current = onDrop;

    const beginDrag = useCallback((pending: PendingDrag, x: number, y: number) => {
        pending.active = true;
        if (pending.longPressTimer) {
            window.clearTimeout(pending.longPressTimer);
            pending.longPressTimer = null;
        }
        document.body.classList.add("api-drag-active");
        const zone = resolveDropZone(x, y);
        setOverlay({ label: pending.label, x, y, targetGroupId: zone ? (zone.getAttribute(API_DROP_ATTR) ?? "") : null });
    }, []);

    const finishDrag = useCallback((x: number, y: number, commit: boolean) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending?.longPressTimer) window.clearTimeout(pending.longPressTimer);
        const zone = commit ? resolveDropZone(x, y) : null;
        clearDropHighlights();
        document.body.classList.remove("api-drag-active");
        setOverlay(null);
        if (!pending?.active || !zone) return;
        // 只有真正落到放置区才算一次拖拽成功：吞掉浏览器随后补发的 click，
        // 避免「拖进文件夹」的同时又把这次点击当成切换 API / 打开编辑
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 120);
        onDropRef.current(pending.configId, zone.getAttribute(API_DROP_ATTR) ?? "");
    }, []);

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const pending = pendingRef.current;
            if (!pending || event.pointerId !== pending.pointerId) return;

            if (!pending.active) {
                const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
                if (pending.pointerType === "mouse") {
                    if (distance <= MOUSE_START_DISTANCE) return;
                    beginDrag(pending, event.clientX, event.clientY);
                } else {
                    // 手指在开始拖拽前就滑开了 → 判定为滚动列表，放弃这次拖拽
                    if (distance > TOUCH_SCROLL_TOLERANCE) {
                        if (pending.longPressTimer) window.clearTimeout(pending.longPressTimer);
                        pendingRef.current = null;
                    }
                    return;
                }
            }

            if (event.cancelable) event.preventDefault();
            const zone = resolveDropZone(event.clientX, event.clientY);
            document.querySelectorAll<HTMLElement>(`[${API_DROP_ATTR}]`).forEach(element => {
                element.classList.toggle("is-drop-target", element === zone);
            });
            setOverlay({
                label: pending.label,
                x: event.clientX,
                y: event.clientY,
                targetGroupId: zone ? (zone.getAttribute(API_DROP_ATTR) ?? "") : null,
            });
        };

        const handleUp = (event: PointerEvent) => {
            const pending = pendingRef.current;
            if (!pending || event.pointerId !== pending.pointerId) return;
            if (!pending.active) {
                // 只是普通点击：清掉长按计时器，交给 onClick 处理
                if (pending.longPressTimer) window.clearTimeout(pending.longPressTimer);
                pendingRef.current = null;
                return;
            }
            finishDrag(event.clientX, event.clientY, true);
        };

        const handleCancel = (event: PointerEvent) => {
            const pending = pendingRef.current;
            if (!pending || event.pointerId !== pending.pointerId) return;
            finishDrag(event.clientX, event.clientY, false);
        };

        window.addEventListener("pointermove", handleMove, { passive: false });
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleCancel);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleCancel);
        };
    }, [beginDrag, finishDrag]);

    /** 拖拽源元素的 onPointerDown */
    const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, config: ApiConfig) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const pending: PendingDrag = {
            configId: config.id,
            label: apiConfigLabel(config),
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            longPressTimer: null,
        };
        if (event.pointerType !== "mouse") {
            pending.longPressTimer = window.setTimeout(() => {
                if (pendingRef.current === pending && !pending.active) {
                    beginDrag(pending, pending.startX, pending.startY);
                }
            }, LONG_PRESS_MS);
        }
        pendingRef.current = pending;
    }, [beginDrag]);

    /** 在 onClick 开头调用：返回 true 表示这次点击是拖拽的尾巴，应当忽略 */
    const consumeSuppressedClick = useCallback((): boolean => {
        if (!suppressClickRef.current) return false;
        suppressClickRef.current = false;
        return true;
    }, []);

    return { overlay, handleDragPointerDown, consumeSuppressedClick };
}
