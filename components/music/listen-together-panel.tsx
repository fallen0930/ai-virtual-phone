// components/music/listen-together-panel.tsx — 「一起听」设置面板
// 选择陪听的角色（可多选）+ 设置随机自动发言间隔，然后开始。开始后由播放器上的
// 弹幕层负责实时互动，此面板关闭。
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    type ListenSession,
    DEFAULT_LISTEN_SESSION,
} from "@/lib/music-listen-together";

type Props = {
    initial?: ListenSession;
    onStart: (session: ListenSession) => void;
    onClose: () => void;
};

function clampInterval(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}

export default function ListenTogetherPanel({ initial, onStart, onClose }: Props) {
    const base = initial ?? DEFAULT_LISTEN_SESSION;
    const [characters, setCharacters] = useState<Character[]>([]);
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(base.characterIds),
    );
    const [intervalMin, setIntervalMin] = useState(base.intervalMin);
    const [intervalMax, setIntervalMax] = useState(base.intervalMax);

    const clampPair = useCallback((min: number, max: number) => {
        const lo = clampInterval(min, 3, 120);
        const hi = clampInterval(max, lo, 120);
        return { lo, hi };
    }, []);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        // 仅保留仍存在（未被删除）的角色
        setSelected(prev => new Set([...prev].filter(id => chars.some(c => c.id === id))));
    }, []);

    const selectedChars = useMemo(
        () => characters.filter(c => selected.has(c.id)),
        [characters, selected],
    );

    const toggleRole = useCallback((id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const adjustMin = useCallback((delta: number) => {
        const { lo, hi } = clampPair(intervalMin + delta, intervalMax);
        setIntervalMin(lo);
        setIntervalMax(hi);
    }, [intervalMin, intervalMax, clampPair]);

    const adjustMax = useCallback((delta: number) => {
        const { lo, hi } = clampPair(intervalMin, intervalMax + delta);
        setIntervalMin(lo);
        setIntervalMax(hi);
    }, [intervalMin, intervalMax, clampPair]);

    const canStart = selectedChars.length > 0;

    const handleStart = useCallback(() => {
        if (!canStart) return;
        onStart({
            active: true,
            characterIds: [...selected],
            intervalMin,
            intervalMax,
        });
    }, [canStart, onStart, selected, intervalMin, intervalMax]);

    return (
        <div className="lt-page">
            {/* Header */}
            <div className="lt-nav">
                <button className="music-player-close" onClick={onClose}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M15 19 8 12l7-7" />
                    </svg>
                </button>
                <b>一起听</b>
                <span className="lt-nav-sub">选角色陪你听歌</span>
            </div>

            {/* 说明 */}
            <div className="lt-intro">
                <p>选几个角色，让他们按自己的人设和世界观陪你听歌、随时吐槽，甚至可以提议切歌。</p>
            </div>

            {/* Role picker */}
            <div className="lt-section-label">陪听角色</div>
            <div className="lt-roles">
                {characters.length === 0 ? (
                    <span className="lt-roles-empty">还没有角色，先去创建一个吧</span>
                ) : (
                    characters.map(c => {
                        const on = selected.has(c.id);
                        return (
                            <button
                                key={c.id}
                                className="lt-role"
                                {...(on ? { "data-on": "" } : {})}
                                onClick={() => toggleRole(c.id)}
                            >
                                <span className="lt-role-ava">
                                    {c.avatar ? <img src={c.avatar} alt="" /> : <i>{(c.name || "?").slice(0, 1)}</i>}
                                </span>
                                <span className="lt-role-name">{c.name || "未命名"}</span>
                            </button>
                        );
                    })
                )}
            </div>

            {/* Random interval */}
            <div className="lt-section-label">随机发言间隔（秒）</div>
            <div className="lt-interval">
                <div className="lt-interval-row">
                    <span className="lt-interval-name">最短</span>
                    <div className="lt-stepper">
                        <button onClick={() => adjustMin(-2)} aria-label="减少最短">−</button>
                        <span>{intervalMin}</span>
                        <button onClick={() => adjustMin(2)} aria-label="增加最短">+</button>
                    </div>
                </div>
                <div className="lt-interval-row">
                    <span className="lt-interval-name">最长</span>
                    <div className="lt-stepper">
                        <button onClick={() => adjustMax(-2)} aria-label="减少最长">−</button>
                        <span>{intervalMax}</span>
                        <button onClick={() => adjustMax(2)} aria-label="增加最长">+</button>
                    </div>
                </div>
                <p className="lt-interval-hint">角色会在最长与最短之间随机挑个时间，自动冒出一句点评。</p>
            </div>

            {/* Start */}
            <div className="lt-actions lt-actions-bottom">
                <button
                    className="lt-action lt-action-comment"
                    onClick={handleStart}
                    disabled={!canStart}
                >
                    {canStart ? `开始一起听（${selectedChars.length}）` : "先选一个角色"}
                </button>
            </div>
        </div>
    );
}
