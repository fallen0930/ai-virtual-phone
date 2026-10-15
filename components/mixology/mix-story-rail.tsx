"use client";

// 独家特调 · 剧情进度侧轨
// 右侧一条常驻细轨：上面有每一轮的刻度、一条已读进度、一颗可拖的滑块，
// 再配一圈入口（罗盘 / 回到最新）。
//
// 为什么放侧面而不是放下面：
// · 剧情是纵向延伸的，纵向轴与阅读方向同构，拖动方向和手指滑动方向一致；
// · 底部已被输入框与系统会占用，再塞一条会挤压正文；
// · 细轨平时只有十几像素宽，几乎不遮正文，按住才变宽方便抓。
//
// 刻度的位置不是按"第几轮 / 共几轮"均分的——那样长回合和短回合看起来一样长，
// 会让"我读到哪儿了"失真。这里读每轮真实元素的 offsetTop 换算成滚动比，
// 惰性展开/沙盒 iframe 异步报高都会重测。

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, Compass } from "lucide-react";
import { compassAnchorId, type CompassRound } from "@/lib/mixology/story-compass";

type Props = {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    rounds: CompassRound[];
    /** 内容指纹：轮数 / 懒加载收起数 / 生成态变化时重新测量刻度 */
    measureKey: string;
    /** 还有几条更早的内容没展开 */
    hiddenCount: number;
    /** 锁定时累计的新内容条数 */
    newCount: number;
    onOpenCompass: () => void;
    onJumpRound: (round: CompassRound) => void;
    onLoadMore: () => void;
    onToLatest: () => void;
};

type Mark = { key: string; no: number; ratio: number };

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 标签什么时候该露面——**只看位移量，不看"有没有动"**。
 *
 * 阅读本来就是一屏一屏往下翻的，滑两下、微调一下进度条都算常规操作；
 * 这类动作要是每次都把「第 N 轮 · xx%」糊到正文上，只会打断阅读。
 * 所以这里给两条门槛：
 * · 拖动：指针离开按下点超过一定距离（轨道高度的 6%，至少 18px）才算"大幅拖动"；
 * · 滚动：一次连续滚动累计跨过 2.2 屏才提示一次，并进冷却——正常翻页远不到这个量，
 *   只有甩动/长距离跳转才会命中，而那时人确实需要知道自己落到哪儿了。
 */
const DRAG_PEEK_MIN_PX = 18;
const DRAG_PEEK_TRACK_RATIO = 0.06;
const SCROLL_PEEK_VIEWPORT_RATIO = 2.2;
const SCROLL_PEEK_COOLDOWN_MS = 1400;
/** 标签自身的刷新节流：拖动是逐帧的，没必要每帧都 setState */
const PEEK_REFRESH_MS = 240;

export function MixStoryRail({
    scrollRef,
    rounds,
    measureKey,
    hiddenCount,
    newCount,
    onOpenCompass,
    onJumpRound,
    onLoadMore,
    onToLatest,
}: Props) {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
    const [marks, setMarks] = useState<Mark[]>([]);
    const [thumb, setThumb] = useState({ top: 0, height: 0.24 });
    const [progress, setProgress] = useState(0);
    const [percent, setPercent] = useState(0);
    const [current, setCurrent] = useState<{ no: number; label: string }>({ no: 0, label: "序幕" });
    const [touching, setTouching] = useState(false);
    const [peekAt, setPeekAt] = useState(0);
    const peekTimer = useRef(0);
    const peekStamp = useRef(0);
    /** 拖动是否正在进行；进行中由拖动逻辑独占标签，不让滚动阈值插一脚 */
    const draggingRef = useRef(false);
    const dragOriginRef = useRef(0);
    const dragLimitRef = useRef(DRAG_PEEK_MIN_PX);
    const dragFarRef = useRef(false);
    /** 滚动累计：上一帧的 scrollTop、累计位移、冷却截止时间戳 */
    const scrollLastRef = useRef(0);
    const scrollAccRef = useRef(0);
    const scrollCoolRef = useRef(0);

    const total = rounds.length;

    /** 量一遍：滑块的尺寸、位置，以及每一轮落在哪个滚动比例上 */
    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const height = el.scrollHeight;
        const client = el.clientHeight;
        if (client <= 0) return;
        const max = Math.max(1, height - client);
        const base = el.getBoundingClientRect().top;
        const next: Mark[] = [];
        for (const round of rounds) {
            const id = compassAnchorId(round);
            if (!id) continue;
            const node = el.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
            if (!node) continue; // 被懒加载收起来的轮次暂时没有 DOM
            const top = node.getBoundingClientRect().top - base + el.scrollTop;
            next.push({ key: `${round.no}-${id}`, no: round.no, ratio: clamp01(top / max) });
        }
        setMarks(next);
        setThumb({ top: clamp01(el.scrollTop / max), height: clamp01(client / Math.max(1, height)) });
        setProgress(clamp01(el.scrollTop / max));
    }, [rounds, scrollRef]);

    /** 当前读到第几轮：取越过视口顶部三分之一、且位置最靠下的那一轮 */
    const syncCurrent = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const height = el.scrollHeight;
        const client = el.clientHeight;
        const max = Math.max(1, height - client);
        const at = el.scrollTop;
        const ratio = clamp01(at / max);
        const thumbH = clamp01(client / Math.max(1, height));
        // 逐帧滚的时候别拿新对象去喂 setState——值没变就原样退回，省掉整棵树的重渲染
        setThumb((prev) => (prev.top === ratio && prev.height === thumbH ? prev : { top: ratio, height: thumbH }));
        setProgress(ratio);
        setPercent(Math.round(ratio * 100));
        const line = el.scrollTop + el.clientHeight * 0.34;
        let picked: { no: number; label: string } = rounds.length && rounds[0].no === 0 ? { no: 0, label: rounds[0].label } : { no: 0, label: "—" };
        for (const round of rounds) {
            const id = compassAnchorId(round);
            if (!id) continue;
            const node = el.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
            if (!node) continue;
            const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
            if (top <= line) picked = { no: round.no, label: round.label };
        }
        setCurrent((prev) => (prev.no === picked.no && prev.label === picked.label ? prev : picked));
    }, [rounds, scrollRef]);

    /**
     * 让「第 N 轮 · x%」标签亮出来一小会儿。
     * 调用方自己负责判断"够不够格"（见上面的位移门槛），这里只管亮灯与退场。
     * 逐帧场景（拖动）会高频调用，所以刷新做了节流，但退场倒计时每次都续上。
     */
    const flashPeek = useCallback(() => {
        const now = Date.now();
        if (!peekStamp.current || now - peekStamp.current >= PEEK_REFRESH_MS) {
            peekStamp.current = now;
            setPeekAt(now);
        }
        if (peekTimer.current) window.clearTimeout(peekTimer.current);
        peekTimer.current = window.setTimeout(() => {
            peekStamp.current = 0;
            setPeekAt(0);
        }, 1400);
    }, []);

    useEffect(() => () => { if (peekTimer.current) window.clearTimeout(peekTimer.current); }, []);

    // 滚动时刷新位置与"读到第几轮"。
    // 标签不再一滚就冒头：要一次连续滚动累计跨过 2.2 屏才提示一次，
    // 中间停顿超过 400ms 就算换了一次手势、累计清零——慢慢翻着读永远不会被打断，
    // 只有甩动或长距离跳转这类"确实需要重新定位"的动作才会叫它出来。
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        let raf = 0;
        let lastTs = 0;
        scrollLastRef.current = el.scrollTop;
        scrollAccRef.current = 0;
        const onScroll = () => {
            const at = el.scrollTop;
            const delta = Math.abs(at - scrollLastRef.current);
            scrollLastRef.current = at;
            const now = Date.now();
            if (draggingRef.current) {
                // 拖动中由拖动逻辑自己决定是否显示，别让两套阈值互相打架
                lastTs = now;
            } else if (now - lastTs > 400) {
                lastTs = now;
                scrollAccRef.current = 0;
            } else {
                lastTs = now;
                if (now < scrollCoolRef.current) {
                    scrollAccRef.current = 0;
                } else {
                    scrollAccRef.current += delta;
                    if (scrollAccRef.current >= el.clientHeight * SCROLL_PEEK_VIEWPORT_RATIO) {
                        scrollAccRef.current = 0;
                        scrollCoolRef.current = now + SCROLL_PEEK_COOLDOWN_MS;
                        flashPeek();
                    }
                }
            }
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; syncCurrent(); });
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        syncCurrent();
        return () => {
            if (raf) cancelAnimationFrame(raf);
            el.removeEventListener("scroll", onScroll);
        };
    }, [scrollRef, syncCurrent, flashPeek]);

    /**
     * 高度会长的内容（沙盒 iframe 异步报高、图片加载、新轮到达）都要重测刻度。
     * 直接给滚动区的一级子元素挂 ResizeObserver：是小票 / 小剧场 / 画布撑高时，
     * 它们的宿主容器高度会跟着变，一网打尽。
     */
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === "undefined") { measure(); return; }
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; measure(); syncCurrent(); });
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(el);
        Array.from(el.children).forEach((child) => ro.observe(child));
        measure();
        return () => {
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [measure, scrollRef, syncCurrent, measureKey]);

    /** 按下就开拖；同时张开一点宽度，手指容易捏住。注意：按下这一下不叫标签 */
    const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        const track = trackRef.current;
        if (!el || !track) return;
        e.preventDefault();
        const rect = track.getBoundingClientRect();
        setTouching(true);
        draggingRef.current = true;
        dragOriginRef.current = e.clientY;
        dragFarRef.current = false;
        dragLimitRef.current = Math.max(DRAG_PEEK_MIN_PX, rect.height * DRAG_PEEK_TRACK_RATIO);
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        const apply = (clientY: number) => {
            const usable = Math.max(1, rect.height * (1 - thumb.height));
            const raw = (clientY - rect.top - (thumb.height * rect.height) / 2) / usable;
            el.scrollTop = clamp01(raw) * max;
            syncCurrent();
            // 挪够了才认这是"大幅拖动"，此时开始亮标签；之后一直拖就一直续着亮
            if (!dragFarRef.current && Math.abs(clientY - dragOriginRef.current) >= dragLimitRef.current) {
                dragFarRef.current = true;
            }
            if (dragFarRef.current) flashPeek();
        };
        apply(e.clientY);
        const move = (ev: PointerEvent) => apply(ev.clientY);
        const up = () => {
            setTouching(false);
            draggingRef.current = false;
            // 大幅拖动过的话，松手后再留一会儿给人确认落点
            if (dragFarRef.current) flashPeek();
            dragFarRef.current = false;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            dragRef.current = null;
        };
        dragRef.current = { move, up };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    };

    useEffect(() => () => {
        const drag = dragRef.current;
        if (drag) {
            window.removeEventListener("pointermove", drag.move);
            window.removeEventListener("pointerup", drag.up);
            window.removeEventListener("pointercancel", drag.up);
        }
    }, []);

    const railLabel = useMemo(() => (current.no > 0 ? current.label : current.label === "序幕" ? "序幕" : "—"), [current]);
    const atTopZone = hiddenCount > 0;
    // 大幅拖动 / 甩动跳转 / 点刻度直达才会露面，停手约 1.4 秒后自己退场——
    // 常驻着会一直压住正文，影响阅读
    const showPeek = Boolean(peekAt);

    return (
        <div className="mix-rail" data-touching={touching ? "true" : undefined}>
            {atTopZone ? (
                <button type="button" className="mix-rail-older" title={`上面还有 ${hiddenCount} 条更早的内容，点一下展开`} onClick={onLoadMore}>
                    ⋯
                </button>
            ) : null}

            <button type="button" className="mix-rail-cap" onClick={onOpenCompass} title="剧情溯源罗盘 · 按轮跳转" aria-label="剧情溯源罗盘">
                <Compass size={13} strokeWidth={1.9} />
            </button>

            <div className="mix-rail-track" ref={trackRef} onPointerDown={onTrackDown} role="slider" aria-label="剧情进度"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} tabIndex={-1}>
                <div className="mix-rail-line" />
                <div className="mix-rail-done" style={{ transform: `scaleY(${progress})` }} />
                {marks.map((m) => {
                    const round = rounds.find((r) => `${r.no}-${compassAnchorId(r)}` === m.key);
                    return (
                        <button
                            type="button"
                            className="mix-rail-tick"
                            key={m.key}
                            data-current={m.no === current.no ? "true" : undefined}
                            style={{ top: `${m.ratio * 100}%` }}
                            title={round ? `${round.label} · 直达` : "直达"}
                            aria-label={round ? `${round.label} · 直达` : "直达"}
                            onPointerDown={(e) => { e.stopPropagation(); }}
                            onClick={(e) => { e.stopPropagation(); if (round) { flashPeek(); onJumpRound(round); } }}
                        />
                    );
                })}
                <div className="mix-rail-thumb" style={{ top: `${thumb.top * 100}%`, height: `${Math.max(0.06, thumb.height) * 100}%` }} />
            </div>

            <button type="button" className="mix-rail-latest" data-new={newCount > 0 ? "true" : undefined} onClick={onToLatest}
                title={newCount > 0 ? `有 ${newCount} 条新内容，回到最新` : "回到最新"} aria-label="回到最新">
                {newCount > 0 ? <span className="mix-rail-badge">{newCount > 99 ? "99+" : newCount}</span> : <ArrowDown size={13} strokeWidth={2} />}
            </button>

            {/*
                当前轮次标签：两种出场——
                ① 正在拖/点的时候显亮，告诉人在第几轮；
                ② 没停在最新（正读到半路）时安静常驻，随时知道身处第几轮。
            */}
            <div className="mix-rail-peek" data-on={showPeek ? "true" : undefined}>
                <b>{railLabel}</b>
                <span>{percent}% · 共 {total} 轮</span>
            </div>
        </div>
    );
}
