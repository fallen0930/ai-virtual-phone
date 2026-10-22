"use client";

// 独家特调 · 剧情溯源罗盘
//
// 做三件事：
// 1. 对局精准成对扫描——把「你的发言」和「AI 角色的长回复」自动配对成第 1 轮、第 2 轮……；
// 2. 自动脱水——自动注入的几百字指令套话（禁止截断 / 严格承接 / 反注水…）会被滤掉，
//    只展示你手打的真实剧情；
// 3. 穿梭直达——点某一轮，面板收起、视口像电梯一样平滑滑过去，落地那一轮亮起
//    1.5 秒的蓝色呼吸外发光。
//
// 两种形态：merged = 并入右侧侧栏（跟着侧轨一起）,float = 独立浮窗（可拖动）。
// 面板头部的开关随时切换，形态记在 localStorage 里。

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { Columns2, Search, Settings2, Square, X } from "lucide-react";
import {
    FOLLOW_MODE_HINTS,
    FOLLOW_MODE_LABELS,
    parseWordList,
    type CompassRound,
    type FollowMode,
} from "@/lib/mixology/story-compass";

type Props = {
    rounds: CompassRound[];
    open: boolean;
    mode: "merged" | "float";
    follow: FollowMode;
    dewater: boolean;
    words: string[];
    /** 视口当前所在的那一轮，列表里高亮 */
    activeIndex?: number;
    busy: boolean;
    charName: string;
    onClose: () => void;
    onMode: (mode: "merged" | "float") => void;
    onFollow: (mode: FollowMode) => void;
    onDewater: (value: boolean) => void;
    onWords: (words: string[]) => void;
    onJump: (round: CompassRound) => void;
};

export function MixStoryCompass({
    rounds,
    open,
    mode,
    follow,
    dewater,
    words,
    activeIndex,
    busy,
    charName,
    onClose,
    onMode,
    onFollow,
    onDewater,
    onWords,
    onJump,
}: Props) {
    const [query, setQuery] = useState("");
    const [setting, setSetting] = useState(false);
    const [wordDraft, setWordDraft] = useState(() => words.join("\n"));
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const dragRef = useRef<{ dx: number; dy: number } | null>(null);
    const listRef = useRef<HTMLUListElement | null>(null);

    useEffect(() => { setWordDraft(words.join("\n")); }, [words]);
    useEffect(() => { if (!open) { setSetting(false); setQuery(""); } }, [open]);

    // 打开时把"当前这一轮"滚进视野：几十轮的局里不用从头翻
    useEffect(() => {
        if (!open || !activeIndex) return;
        const node = listRef.current?.querySelector<HTMLElement>(`[data-i="${activeIndex}"]`);
        node?.scrollIntoView({ block: "center" });
    }, [open, activeIndex]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rounds;
        return rounds.filter((r) => {
            const hay = `${r.userRaw}\n${r.userText}\n${r.assistantPreview}\n${r.assistantText}`.toLowerCase();
            return hay.includes(q);
        });
    }, [rounds, query]);

    const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        const card = (e.currentTarget.parentElement) as HTMLElement | null;
        if (!card) return;
        dragRef.current = { dx: e.clientX - card.offsetLeft, dy: e.clientY - card.offsetTop };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onHeadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        setPos({ x: Math.max(0, e.clientX - drag.dx), y: Math.max(0, e.clientY - drag.dy) });
    };
    const onHeadUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
    };

    if (!open) return null;

    const cardStyle: CSSProperties = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : {};

    return (
        <>
            {/* 点面板以外的地方收起来：只有触达区，不挡底下内容的滚动手势之外的操作 */}
            <div className="mix-cmp-catch" onClick={onClose} />

            <div className="mix-cmp-panel" data-mode={mode} style={cardStyle}>
                <div
                    className="mix-cmp-head"
                    data-drag={mode === "float" ? "true" : undefined}
                    onPointerDown={mode === "float" ? onHeadDown : undefined}
                    onPointerMove={mode === "float" ? onHeadMove : undefined}
                    onPointerUp={mode === "float" ? onHeadUp : undefined}
                    onPointerCancel={mode === "float" ? onHeadUp : undefined}
                >
                    <div className="mix-cmp-title">
                        剧情溯源罗盘
                        <i>{rounds.length} 轮</i>
                    </div>
                    <div className="mix-cmp-head-ops">
                        <button
                            type="button"
                            className="mix-cmp-op"
                            title={mode === "merged" ? "拆成独立浮窗" : "并入右侧侧栏"}
                            aria-label={mode === "merged" ? "拆成独立浮窗" : "并入右侧侧栏"}
                            onClick={() => onMode(mode === "merged" ? "float" : "merged")}
                        >
                            {mode === "merged" ? <Square size={13} strokeWidth={1.9} /> : <Columns2 size={13} strokeWidth={1.9} />}
                        </button>
                        <button
                            type="button"
                            className="mix-cmp-op"
                            data-on={setting ? "true" : undefined}
                            onClick={() => setSetting((v) => !v)}
                            title="罗盘设置"
                            aria-label="罗盘设置"
                        >
                            <Settings2 size={13} strokeWidth={1.9} />
                        </button>
                        <button type="button" className="mix-cmp-op" onClick={onClose} title="关闭" aria-label="关闭">
                            <X size={15} strokeWidth={2} />
                        </button>
                    </div>
                </div>

                {setting ? (
                    <div className="mix-cmp-setting">
                        <label className="mix-cmp-switch">
                            <input type="checkbox" checked={dewater} onChange={(e) => onDewater(e.target.checked)} />
                            <span>自动脱水（滤掉注入的指令套话）</span>
                        </label>
                        <div className="mix-cmp-field-label">自定义套话关键词（一行一个或逗号分隔）</div>
                        <textarea
                            className="mix-cmp-words"
                            rows={3}
                            value={wordDraft}
                            placeholder={"例：\n严格承接上文\n不要总结上文\n按本提示词输出"}
                            onChange={(e) => setWordDraft(e.target.value)}
                            onBlur={() => onWords(parseWordList(wordDraft))}
                        />
                        <div className="mix-cmp-hint">
                            命中这些词的整行会被判成套话滤掉；宁可多显示、不会把正文滤没——滤完为空时原样保留。
                        </div>
                    </div>
                ) : null}

                <div className="mix-cmp-follow">
                    <span className="mix-cmp-follow-label">新一轮落位</span>
                    <div className="mix-cmp-seg">
                        {(["always", "bottom", "manual"] as FollowMode[]).map((m) => (
                            <button
                                key={m}
                                type="button"
                                data-on={follow === m ? "true" : undefined}
                                title={FOLLOW_MODE_HINTS[m]}
                                onClick={() => onFollow(m)}
                            >
                                {FOLLOW_MODE_LABELS[m]}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="mix-cmp-follow-hint">{FOLLOW_MODE_HINTS[follow]}</div>

                <div className="mix-cmp-search">
                    <Search size={12} strokeWidth={1.9} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="在这一局的剧情里找一句话…" />
                    {query ? <button type="button" onClick={() => setQuery("")} aria-label="清空"><X size={11} /></button> : null}
                </div>

                <ul className="mix-cmp-list" ref={listRef}>
                    {filtered.length === 0 ? (
                        <li className="mix-cmp-empty">这一局还没有可溯源的剧情。</li>
                    ) : filtered.map((round) => (
                        <li
                            className="mix-cmp-item"
                            key={`${round.no}-${round.startIndex}`}
                            data-i={round.startIndex}
                            data-active={round.startIndex === activeIndex ? "true" : undefined}
                            data-prologue={round.no === 0 ? "true" : undefined}
                            onClick={() => onJump(round)}
                        >
                            <div className="mix-cmp-item-head">
                                <b className="mix-cmp-no">{round.label}</b>
                                {round.pending ? <em className="mix-cmp-tag" data-tone="wait">等待回应</em> : null}
                                {round.extraReplies ? <em className="mix-cmp-tag">+{round.extraReplies} 段续写</em> : null}
                                {round.filtered && dewater ? <em className="mix-cmp-tag" data-tone="dew">已脱水</em> : null}
                                {round.pending ? null : <span className="mix-cmp-chars">{round.assistantChars} 字</span>}
                            </div>
                            {round.userText ? (
                                <div className="mix-cmp-bubble" data-role="user">
                                    <i className="mix-cmp-who">你</i>
                                    <p>{round.userText}</p>
                                </div>
                            ) : null}
                            {round.pending ? (
                                <div className="mix-cmp-bubble" data-role="wait">
                                    <i className="mix-cmp-who">{charName}</i>
                                    <p>{busy ? "正在调制这一杯…" : "还在等对方开口。"}</p>
                                </div>
                            ) : round.assistantPreview ? (
                                <div className="mix-cmp-bubble" data-role="char">
                                    <i className="mix-cmp-who">{charName}</i>
                                    <p>{round.assistantPreview}</p>
                                </div>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </div>
        </>
    );
}
