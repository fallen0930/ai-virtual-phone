"use client";

// 独家特调 · 「当前模型」指示器：常驻显示这一局实际会调用的接口与模型名，
// 免得在快捷面板里切完就忘了自己切到哪一个。
//
// 归统一控制坞管理：勾选 = 正常显示（坞按钮可再临时收起），取消勾选 = 彻底隐藏。
// 显示的是 resolveMixApiResolution 的结果——特调对局只读全局默认接口，
// 角色级绑定不参与，所以这里不跟着绑定面板的当前 tab 走。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Cpu, SlidersHorizontal } from "lucide-react";
import { resolveMixApiResolution, type MixApiSource } from "@/lib/mixology/engine";
import { determineBaseUrl } from "@/lib/api-helpers";
import {
    CONTROL_DOCK_ACTIVATE_EVENT,
    activateControl,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import type { ApiConfig } from "@/lib/settings-types";

const BADGE_UI_KEY = "mix-model-badge-ui";

type Resolved = {
    config: ApiConfig | null;
    source: MixApiSource;
};

/** 收起态一行能放下的字符数，超了截断——完整名在展开的详情里 */
const SHORT_LIMIT = 22;

function shorten(text: string): string {
    const t = text.trim();
    if (!t) return "未填模型";
    return t.length > SHORT_LIMIT ? `${t.slice(0, SHORT_LIMIT - 1)}…` : t;
}

export function MixModelBadge() {
    const [resolved, setResolved] = useState<Resolved | null>(null);
    const [open, setOpen] = useState(false);
    /** 切换完闪一下，提示"刚刚变过了" */
    const [flash, setFlash] = useState(false);
    const [userHidden, setUserHidden] = useState(false);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = window.localStorage.getItem(BADGE_UI_KEY);
            const p = raw ? JSON.parse(raw).pos : null;
            return p && typeof p.x === "number" && typeof p.y === "number" ? p : null;
        } catch {
            return null;
        }
    });
    const ref = useRef<HTMLDivElement>(null);

    const refresh = useCallback((flashIt: boolean) => {
        setResolved(resolveMixApiResolution());
        if (!flashIt) return;
        setFlash(true);
        window.setTimeout(() => setFlash(false), 2200);
    }, []);

    // 首帧不在渲染期读存储（SSR 安全），挂载后再解析
    useEffect(() => {
        refresh(false);
    }, [refresh]);

    // 快捷面板里切了默认接口 → 刷新并高亮
    useEffect(() => {
        const onBindings = () => refresh(true);
        window.addEventListener("settings-bindings-updated", onBindings);
        return () => window.removeEventListener("settings-bindings-updated", onBindings);
    }, [refresh]);

    // 在设置页改了模型名/地址回来时也要跟上（改配置列表没有专门事件，靠回到本页补一次）
    useEffect(() => {
        const onFocus = () => refresh(false);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onFocus);
        };
    }, [refresh]);

    // 坞里的按钮点一下 = 临时收起/放回来
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== "mix-model-badge") return;
            setUserHidden(prev => !prev);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    // 必须走订阅态，否则在坞里勾上时不会实时出现
    const controlDockState = useSyncExternalStore(subscribeControlDockState, getControlDockState, getControlDockState);
    const managed = controlDockState.pinned["mix-model-badge"] !== false;

    const persistPos = (next: { x: number; y: number }) => {
        try {
            const cur = JSON.parse(window.localStorage.getItem(BADGE_UI_KEY) || "{}");
            window.localStorage.setItem(BADGE_UI_KEY, JSON.stringify({ ...cur, pos: next }));
        } catch {
            /* localStorage 不可用时静默忽略 */
        }
    };

    const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = el.offsetLeft;
        const startTop = el.offsetTop;
        const move = (ev: PointerEvent) => {
            setPos({
                x: Math.max(0, startLeft + (ev.clientX - startX)),
                y: Math.max(0, startTop + (ev.clientY - startY)),
            });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (ref.current) persistPos({ x: ref.current.offsetLeft, y: ref.current.offsetTop });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    if (!managed || userHidden) return null;

    const config = resolved?.config ?? null;
    const source = resolved?.source ?? "none";
    // 还没解析出来（首帧）时先不画，避免闪一个空壳
    if (!resolved) return null;

    const title = config?.name?.trim() || "";
    const model = config?.defaultModel?.trim() || "";
    const endpoint = config ? determineBaseUrl(config) : "";
    const shortLabel = config ? shorten(model || title || config.provider) : "未配置 API";

    return (
        <div
            className="mix-model-badge"
            ref={ref}
            data-open={open ? "true" : undefined}
            data-flash={flash ? "true" : undefined}
            data-source={source}
            style={pos ? ({ left: pos.x, top: pos.y, right: "auto", bottom: "auto" } as CSSProperties) : undefined}
            title="本局实际调用的接口与模型"
        >
            <div className="mix-mb-head" onPointerDown={onDragStart}>
                <Cpu size={13} strokeWidth={2} />
                <span className="mix-mb-short">{shortLabel}</span>
                <button
                    type="button"
                    className="mix-mb-toggle"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setOpen(v => !v)}
                >
                    {open ? "收起" : "详情"}
                </button>
            </div>
            {open ? (
                <div className="mix-mb-body">
                    {config ? (
                        <>
                            <div className="mix-mb-row">
                                <span>接口</span>
                                <b>{title || "（未命名）"}</b>
                            </div>
                            <div className="mix-mb-row">
                                <span>厂商</span>
                                <b>{config.provider}</b>
                            </div>
                            <div className="mix-mb-row mix-mb-model">
                                <span>模型</span>
                                <b>{model || "（未填）"}</b>
                            </div>
                            <div className="mix-mb-row">
                                <span>地址</span>
                                <b>{endpoint}</b>
                            </div>
                        </>
                    ) : null}
                    {source === "fallback" ? (
                        <p className="mix-mb-note">没有指定默认接口，当前用的是配置列表第一个。</p>
                    ) : null}
                    {source === "none" ? (
                        <p className="mix-mb-note">还没有任何 API 配置，出杯会失败。</p>
                    ) : null}
                    <p className="mix-mb-hint">特调对局只认全局默认接口，角色级切换不影响这里。</p>
                    <button
                        type="button"
                        className="mix-mb-switch"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => activateControl("quick-action")}
                    >
                        <SlidersHorizontal size={13} strokeWidth={2} />
                        去快捷面板切换
                    </button>
                </div>
            ) : null}
        </div>
    );
}
