// components/music/listen-together-layer.tsx — 「一起听」实时互动层
// 挂在音乐播放器之上（非阻塞）：右下角浮起角色点评气泡（弹幕），按随机间隔自动冒泡；
// 角色也会自发斟酌切歌——按人数走动态阈值：
//   1人：不弹窗，弹幕内嵌「切歌」小按钮（软确认，超时自动消失）；
//   2人：1人想切即弹窗；3人+：≥2 票或 ≥60% 支持才弹窗，凑不齐票只在弹幕嘀咕。
// 用户拒绝弹窗后进入冷却，避免反复提议打扰。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    generateListenComment,
    decideListenSkip,
    appendListenHistory,
    loadListenHistory,
    markListenHeard,
    markSkipWanted,
    markSkipDenied,
    isListenDuplicate,
    resolveUserLabel,
    resolveUserAvatar,
    hasSeenListenNotice,
    markListenNoticeSeen,
    LISTEN_USER_ACTION_EVENT,
    type ListenSkipEvent,
    type ListenTogetherMessage,
    type ListenUserAction,
} from "@/lib/music-listen-together";

type Bubble = {
    key: number;
    character: Character;
    text: string;
    action: "comment" | "skip" | "propose";
};

type SkipProposal = { character: Character; reason: string };

type PendingSkip = {
    proposers: SkipProposal[];
};

type Props = {
    track: MusicTrack;
    currentTime: number;
    characterIds: string[];
    intervalMin: number;
    intervalMax: number;
    onSkip: () => void;
    onToast?: (text: string) => void;
    onStop: () => void;
};

const BUBBLE_TTL = 7000;
const PROPOSE_TTL = 15000;   // 切歌提议气泡留久一点，给用户点按钮的时间
const MAX_BUBBLES = 5;
const MIN_EVAL_PLAYED = 60;  // 至少听了1分钟才允许自动提议切歌
const AUTO_EVAL_GAP_MS = 45000; // 自动切歌评估最小间隔
const DENY_COOLDOWN_MS = 180000; // 用户拒绝提议后的冷却
const SKIP_PROBABILITY = 0.22; // 每次调度 tick 转为切歌评估的概率
const AUTO_SKIP_DENY_LIMIT = 3; // 同一会话被拒满3次，本次不再自动提议切歌
const NOTICE_TTL = 5000;     // 网易云样式通知条停留时长
const SUBTITLE_TTL = 8000;   // 头部下方灰字副标题停留时长
const ERROR_TTL = 5000;      // 错误提示自动收起，不该赖在屏幕上等用户手动关
const USER_ACTION_TTL = 90_000; // 用户操作可被角色引用的新鲜期
const SYNC_NOTICE_DESC = "一起听时，双方的切歌、暂停、快进等操作都会同步";

/** 失败原因直接取自异常本身，截断即可用；空 message 兜底成异常类型名 */
function briefError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e ?? "");
    const text = raw.trim() || e?.constructor?.name || "未知错误";
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function randomBetween(min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
}

/** 动态阈值：不同人数下，几票才值得打扰用户 */
function reachesConsensus(total: number, yesVotes: number): boolean {
    if (total <= 2) return yesVotes >= 1;
    return yesVotes >= 2 || yesVotes / total >= 0.6;
}

export default function ListenTogetherLayer({
    track,
    currentTime,
    characterIds,
    intervalMin,
    intervalMax,
    onSkip,
    onToast,
    onStop,
}: Props) {
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [pendingSkip, setPendingSkip] = useState<PendingSkip | null>(null);
    const [busyAll, setBusyAll] = useState(false);
    const [busySkip, setBusySkip] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 操作同步提示（网易云样式）：角色切歌后的顶部通知条 + 头部下灰字副标题 + 首次说明弹窗
    const [notice, setNotice] = useState<{ character: Character; title: string } | null>(null);
    const [subtitle, setSubtitle] = useState<string | null>(null);
    const [introOpen, setIntroOpen] = useState(false);

    // 最新值用 ref 暴露给随机调度器，避免闭包过期
    const charsRef = useRef<Character[]>([]);
    const trackRef = useRef<MusicTrack>(track);
    const currentTimeRef = useRef<number>(currentTime);
    const intervalRef = useRef({ min: intervalMin, max: intervalMax });
    const mountedRef = useRef(true);
    const speakingRef = useRef(false);
    const keyRef = useRef(0);
    const removeTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
    const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 切歌提议状态（按当前这首歌累计）
    const votesRef = useRef<Map<string, SkipProposal>>(new Map());
    const askedRef = useRef<Set<string>>(new Set());
    const lastAutoEvalRef = useRef(0);
    const cooldownUntilRef = useRef(0);
    const denyCountRef = useRef(0);
    const autoSkipDisabledRef = useRef(false);
    const proposalsRef = useRef<Map<number, SkipProposal>>(new Map());
    const pendingSkipRef = useRef<PendingSkip | null>(null);
    pendingSkipRef.current = pendingSkip;
    // 切歌连续性：真实发生过的切换（谁提议、从哪首切来），新歌头两句点评会带上它
    const lastSkipEventRef = useRef<ListenSkipEvent | null>(null);
    const skipEchoLeftRef = useRef(0);
    const firstSpeakerRef = useRef<string | null>(null);
    // 用户对播放器的操作（切歌/暂停/快进）：只攒上下文，随下一次 LLM 调用消费掉
    const userActionsRef = useRef<Array<{ action: ListenUserAction; at: number }>>([]);
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 通知条要摆"双方头像"：用户侧取主人身份设置的头像/称呼（与角色 prompt 同源）
    const userInfoRef = useRef<{ label: string; avatar: string | null } | null>(null);
    if (!userInfoRef.current) {
        const cid = characterIds[0] ?? "";
        userInfoRef.current = { label: resolveUserLabel(cid), avatar: resolveUserAvatar(cid) };
    }

    useEffect(() => {
        mountedRef.current = true;
        const chars = loadCharacters().filter(c => characterIds.includes(c.id));
        charsRef.current = chars;
        return () => { mountedRef.current = false; };
    }, [characterIds]);

    useEffect(() => { trackRef.current = track; }, [track]);
    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { intervalRef.current = { min: intervalMin, max: intervalMax }; }, [intervalMin, intervalMax]);

    // 切歌后清空弹幕与提议，重新计时；本首歌对所有参与者记一次"听过"。
    // 若这次换歌是角色提议切出来的：新歌头两句带上"刚才"块，且提议者优先开口。
    const prevTrackIdRef = useRef<string | null>(null);
    useEffect(() => {
        setBubbles([]);
        removeTimersRef.current.forEach(t => clearTimeout(t));
        removeTimersRef.current.clear();
        proposalsRef.current.clear();
        votesRef.current.clear();
        askedRef.current.clear();
        lastAutoEvalRef.current = 0;
        setPendingSkip(null);
        const trackChanged = prevTrackIdRef.current !== null && prevTrackIdRef.current !== track.id;
        prevTrackIdRef.current = track.id;
        if (trackChanged && lastSkipEventRef.current) {
            skipEchoLeftRef.current = 2;
            firstSpeakerRef.current = lastSkipEventRef.current.byId;
        } else if (trackChanged) {
            skipEchoLeftRef.current = 0;
            firstSpeakerRef.current = null;
        }
        markListenHeard(characterIds, track.id);
    }, [track.id, characterIds]);

    // 首次开一起听：弹一次"操作同步"说明（网易云同款 bottom sheet），本地记一次性标记
    useEffect(() => {
        if (!hasSeenListenNotice()) setIntroOpen(true);
    }, []);

    // 订阅播放器操作事件（music-player 在切歌/暂停/快进的按钮路径上派发）
    useEffect(() => {
        const onAction = (e: Event) => {
            const action = (e as CustomEvent<{ action: ListenUserAction }>).detail?.action;
            if (!action) return;
            const now = Date.now();
            userActionsRef.current = [...userActionsRef.current, { action, at: now }]
                .filter(a => now - a.at <= USER_ACTION_TTL)
                .slice(-5);
        };
        window.addEventListener(LISTEN_USER_ACTION_EVENT, onAction);
        return () => window.removeEventListener(LISTEN_USER_ACTION_EVENT, onAction);
    }, []);

    // 角色切歌 → 顶部通知条 + 副标题；用户自己的操作不弹条（会被动地让角色知道）
    const showSkipNotice = useCallback((character: Character) => {
        const title = `${character.name || "角色"}刚刚切歌了`;
        setNotice({ character, title });
        setSubtitle(title);
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current);
        noticeTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setNotice(null);
        }, NOTICE_TTL);
        subtitleTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setSubtitle(null);
        }, SUBTITLE_TTL);
    }, []);

    // 取走并清空待消费的用户操作（喂给马上要发起的 LLM 调用，不重放）
    const takeUserActions = useCallback(() => {
        const actions = userActionsRef.current.slice();
        userActionsRef.current = [];
        return actions;
    }, []);

    const pushBubble = useCallback((character: Character, text: string, action: Bubble["action"]): number => {
        const key = ++keyRef.current;
        setBubbles(prev => {
            const next = [...prev, { key, character, text, action }];
            return next.length > MAX_BUBBLES ? next.slice(next.length - MAX_BUBBLES) : next;
        });
        const timer = setTimeout(() => {
            setBubbles(prev => prev.filter(b => b.key !== key));
            removeTimersRef.current.delete(key);
            proposalsRef.current.delete(key);
        }, action === "propose" ? PROPOSE_TTL : BUBBLE_TTL);
        removeTimersRef.current.set(key, timer);
        return key;
    }, []);

    const recordHistory = useCallback((character: Character, action: "comment" | "skip", content: string) => {
        try {
            const message: ListenTogetherMessage = {
                characterId: character.id,
                characterName: character.name || "角色",
                characterAvatar: character.avatar ?? null,
                action,
                content,
                createdAt: new Date().toISOString(),
            };
            appendListenHistory(trackRef.current.id, message);
        } catch { /* ignore */ }
    }, []);

    // 生成一条点评并过出口相似度关：疑似复读就换稿重试一次，仍重复直接丢弃不发。
    // 语义换壳靠 prompt 黑名单拦，程序只兜"近原样重复"这一层（规范第七节的思路）。
    const generateUniqueComment = useCallback(async (character: Character): Promise<string | null> => {
        const recentMessages = loadListenHistory(trackRef.current.id);
        const recentTexts = recentMessages.slice(-6).map(m => m.content);
        let justSkipped: ListenSkipEvent | undefined;
        if (skipEchoLeftRef.current > 0 && lastSkipEventRef.current) {
            justSkipped = lastSkipEventRef.current;
            skipEchoLeftRef.current -= 1;
        }
        let avoid: string[] | undefined;
        const userActions = takeUserActions();
        for (let attempt = 0; attempt < 2; attempt++) {
            const text = await generateListenComment(character, trackRef.current, {
                recentMessages,
                elapsed: currentTimeRef.current,
                justSkipped,
                avoid,
                userActions,
            });
            if (!isListenDuplicate(text, recentTexts)) return text;
            avoid = [text];
        }
        return null;
    }, [takeUserActions]);

    // 收到一张"想切"票后按人数决定打扰方式：
    // manual（用户主动点按钮）必弹窗；自动则凑够阈值才弹窗，
    // 单人自动最特殊——只在弹幕里软提议，绝不弹窗打断。
    const applySkipVote = useCallback((character: Character, reason: string, manual: boolean) => {
        markSkipWanted(character.id, trackRef.current.id);
        votesRef.current.set(character.id, { character, reason });
        const total = charsRef.current.length;
        const yes = votesRef.current.size;
        if (!manual && total === 1) {
            const key = pushBubble(character, reason, "propose");
            proposalsRef.current.set(key, { character, reason });
            return;
        }
        if (manual || reachesConsensus(total, yes)) {
            setPendingSkip({ proposers: [...votesRef.current.values()] });
        } else {
            // 票没凑够：只在弹幕里嘀咕一句，不弹窗
            pushBubble(character, reason, "comment");
            recordHistory(character, "comment", reason);
        }
    }, [pushBubble, recordHistory]);

    // 错误提示只作瞬时反馈：5s 自动收起，不用手动关
    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), ERROR_TTL);
        return () => clearTimeout(t);
    }, [error]);

    // 问一个（本首歌还没问过的）角色想不想切歌
    const evaluateSkip = useCallback(async (manual: boolean) => {
        const chars = charsRef.current;
        if (chars.length === 0) return;
        const pool = manual ? chars : chars.filter(c => !askedRef.current.has(c.id));
        if (pool.length === 0) return;
        const character = pool[Math.floor(Math.random() * pool.length)];
        askedRef.current.add(character.id);
        try {
            const recentMessages = loadListenHistory(trackRef.current.id);
            const decision = await decideListenSkip(character, trackRef.current, {
                recentMessages,
                userActions: takeUserActions(),
            });
            if (!mountedRef.current) return;
            if (decision.skip) {
                applySkipVote(character, decision.reason || "想换一首", manual);
            } else if (manual) {
                onToast?.("TA 想继续听这首");
            }
        } catch (e) {
            // 把真实失败原因带出来（网络/额度/返回空等），别只甩"没配置人设"误导
            if (manual) setError(`问 ${character.name || "TA"} 没回应：${briefError(e)}`);
        }
    }, [applySkipVote, onToast, takeUserActions]);

    // 单个角色冒一句点评（自动调度用，失败静默）
    const speakOne = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || speakingRef.current) return;
        speakingRef.current = true;
        // 刚被切歌接手的：提议者优先开口，让"如愿/对比"有处安放
        let character = chars[Math.floor(Math.random() * chars.length)];
        if (firstSpeakerRef.current) {
            const preferred = chars.find(c => c.id === firstSpeakerRef.current);
            if (preferred) character = preferred;
            firstSpeakerRef.current = null;
        }
        try {
            const text = await generateUniqueComment(character);
            if (!mountedRef.current || !text) return;
            pushBubble(character, text, "comment");
            recordHistory(character, "comment", text);
        } catch {
            /* 自动模式下忽略失败，不打扰用户 */
        } finally {
            speakingRef.current = false;
        }
    }, [generateUniqueComment, pushBubble, recordHistory]);

    // 随机自动发言调度器：偶尔不点评，改成琢磨要不要切歌
    const scheduleNext = useCallback(() => {
        if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        const { min, max } = intervalRef.current;
        const delay = randomBetween(Math.max(3, min), Math.max(min + 2, max)) * 1000;
        scheduleTimerRef.current = setTimeout(() => {
            const now = Date.now();
            const canProposeSkip =
                !autoSkipDisabledRef.current &&
                !pendingSkipRef.current &&
                !speakingRef.current &&
                currentTimeRef.current >= MIN_EVAL_PLAYED &&
                now >= cooldownUntilRef.current &&
                now - lastAutoEvalRef.current >= AUTO_EVAL_GAP_MS &&
                charsRef.current.some(c => !askedRef.current.has(c.id)) &&
                Math.random() < SKIP_PROBABILITY;
            if (canProposeSkip) {
                lastAutoEvalRef.current = now;
                void evaluateSkip(false);
            } else {
                void speakOne();
            }
            scheduleNext();
        }, delay);
    }, [speakOne, evaluateSkip]);

    useEffect(() => {
        scheduleNext();
        return () => {
            if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
            if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current);
        };
    }, [scheduleNext, track.id]);

    // 手动：大家挨个评一句（串行执行，后面的角色能看到前面刚说的话，形成接话而非各说各的）
    const handleCommentAll = useCallback(async () => {
        const chars = charsRef.current;
        if (chars.length === 0 || busyAll) return;
        setBusyAll(true);
        setError(null);
        let failed = 0;
        let lastErr: unknown = null;
        for (const character of chars) {
            if (!mountedRef.current) break;
            try {
                const text = await generateUniqueComment(character);
                if (!text) continue; // 两次都判复读：宁可不发
                pushBubble(character, text, "comment");
                recordHistory(character, "comment", text);
            } catch (e) {
                failed += 1;
                lastErr = e;
            }
        }
        setBusyAll(false);
        if (failed === chars.length) {
            setError(`都没回应：${briefError(lastErr)}`);
        } else if (failed > 0) {
            onToast?.(`${failed} 位角色没回应`);
        }
    }, [busyAll, generateUniqueComment, pushBubble, recordHistory, onToast]);

    // 手动：问问谁想切歌（用户主动问的，问到就说，直接弹窗）
    const handleAskSkip = useCallback(async () => {
        if (charsRef.current.length === 0 || busySkip) return;
        setBusySkip(true);
        setError(null);
        await evaluateSkip(true);
        setBusySkip(false);
    }, [busySkip, evaluateSkip]);

    const handleAllowSkip = useCallback(() => {
        const ps = pendingSkipRef.current;
        if (!ps || ps.proposers.length === 0) return;
        const first = ps.proposers[0];
        lastSkipEventRef.current = {
            fromTitle: trackRef.current.title || "上一首",
            byId: first.character.id,
            byName: first.character.name || "角色",
            reason: ps.proposers.map(p => p.reason).join(" / "),
        };
        pushBubble(first.character, `（切歌）${ps.proposers.map(p => p.reason).join(" / ")}`, "skip");
        recordHistory(first.character, "skip", ps.proposers.map(p => p.reason).join(" / "));
        setPendingSkip(null);
        showSkipNotice(first.character);
        onSkip();
    }, [pushBubble, recordHistory, onSkip, showSkipNotice]);

    const handleDenySkip = useCallback(() => {
        // 被拒绝了就消停一会儿：3分钟冷却，本首歌的票作废
        cooldownUntilRef.current = Date.now() + DENY_COOLDOWN_MS;
        markSkipDenied([...votesRef.current.keys()], trackRef.current.id);
        denyCountRef.current += 1;
        // 同一次会话里连续拒3次：本层自动停用切歌提议，只保留点评
        if (denyCountRef.current >= AUTO_SKIP_DENY_LIMIT) {
            autoSkipDisabledRef.current = true;
            onToast?.("好吧，这次只听不切了");
        }
        votesRef.current.clear();
        askedRef.current.clear();
        setPendingSkip(null);
    }, [onToast]);

    // 单人模式的软确认：点弹幕气泡里的「切歌」小按钮才切，不点就自然超时消失
    const handleProposeAllow = useCallback((key: number) => {
        const proposal = proposalsRef.current.get(key);
        if (!proposal) return;
        proposalsRef.current.delete(key);
        const timer = removeTimersRef.current.get(key);
        if (timer) { clearTimeout(timer); removeTimersRef.current.delete(key); }
        setBubbles(prev => prev.filter(b => b.key !== key));
        lastSkipEventRef.current = {
            fromTitle: trackRef.current.title || "上一首",
            byId: proposal.character.id,
            byName: proposal.character.name || "角色",
            reason: proposal.reason,
        };
        pushBubble(proposal.character, `（切歌）${proposal.reason}`, "skip");
        recordHistory(proposal.character, "skip", proposal.reason);
        showSkipNotice(proposal.character);
        onSkip();
    }, [pushBubble, recordHistory, onSkip, showSkipNotice]);

    return (
        <div className="lt-layer">
            {/* 操作同步通知条（网易云样式，双方头像交叠+爱心；出现 5s 自动收起，可点掉） */}
            {notice && (
                <div className="lt-notice" onClick={() => setNotice(null)}>
                    <span className="lt-notice-avas">
                        <span className="lt-notice-ava">
                            {userInfoRef.current?.avatar
                                ? <img src={userInfoRef.current.avatar} alt="" />
                                : <i>{(userInfoRef.current?.label || "?").slice(0, 1)}</i>}
                        </span>
                        <span className="lt-notice-ava lt-notice-ava-char">
                            {notice.character.avatar
                                ? <img src={notice.character.avatar} alt="" />
                                : <i>{(notice.character.name || "?").slice(0, 1)}</i>}
                        </span>
                        <svg className="lt-notice-heart" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 21s-7.5-4.9-10-9.3C.4 8.6 2.4 5 6 5c2.2 0 3.8 1.2 6 3.5C14.2 6.2 15.8 5 18 5c3.6 0 5.6 3.6 4 6.7C19.5 16.1 12 21 12 21z" />
                        </svg>
                    </span>
                    <span className="lt-notice-body">
                        <b>{notice.title}</b>
                        <span>{SYNC_NOTICE_DESC}</span>
                    </span>
                </div>
            )}

            {/* 头部下灰字副标题：通知条收起后仍留一会儿"谁切的歌" */}
            {subtitle && !notice && <div className="lt-subtitle">{subtitle}</div>}

            {/* 实时控制条（左上，不挡播放器主体交互） */}
            <div className="lt-live-bar">
                <span className="lt-live-dot" />
                <span className="lt-live-label">一起听 · {charsRef.current.length}人</span>
                <button className="lt-live-btn" onClick={handleCommentAll} disabled={busyAll}>
                    {busyAll ? "…" : "一起评"}
                </button>
                <button className="lt-live-btn" onClick={handleAskSkip} disabled={busySkip}>
                    {busySkip ? "…" : "谁想切歌"}
                </button>
                <button className="lt-live-btn lt-live-stop" onClick={onStop}>
                    结束
                </button>
            </div>

            {/* 错误提示（瞬时） */}
            {error && <div className="lt-layer-error">{error}</div>}

            {/* 右下角弹幕气泡 */}
            <div className="lt-danmaku">
                {bubbles.map(b => (
                    <div key={b.key} className="lt-bubble" data-action={b.action}>
                        <span className="lt-bubble-ava">
                            {b.character.avatar
                                ? <img src={b.character.avatar} alt="" />
                                : <i>{(b.character.name || "?").slice(0, 1)}</i>}
                        </span>
                        <span className="lt-bubble-body">
                            <span className="lt-bubble-name">{b.character.name || "角色"}</span>
                            <span className="lt-bubble-text">{b.text}</span>
                            {b.action === "propose" && (
                                <button
                                    className="lt-bubble-skip-btn"
                                    onClick={() => handleProposeAllow(b.key)}
                                >
                                    切歌
                                </button>
                            )}
                        </span>
                    </div>
                ))}
            </div>

            {/* 切歌确认弹窗（凑够票才出现） */}
            {pendingSkip && pendingSkip.proposers.length > 0 && (
                <div className="lt-skip-mask" onClick={handleDenySkip}>
                    <div className="lt-skip-card" onClick={e => e.stopPropagation()}>
                        <div className="lt-skip-head">
                            <span className="lt-skip-ava">
                                {pendingSkip.proposers[0].character.avatar
                                    ? <img src={pendingSkip.proposers[0].character.avatar} alt="" />
                                    : <i>{(pendingSkip.proposers[0].character.name || "?").slice(0, 1)}</i>}
                            </span>
                            <div className="lt-skip-title">
                                <b>{pendingSkip.proposers.map(p => p.character.name || "角色").join("、")}</b>
                                <span>想切掉这首</span>
                            </div>
                        </div>
                        {pendingSkip.proposers.map(p => (
                            <p className="lt-skip-reason" key={p.character.id}>{p.reason}</p>
                        ))}
                        <div className="lt-skip-actions">
                            <button className="lt-skip-no" onClick={handleDenySkip}>不用了</button>
                            <button className="lt-skip-yes" onClick={handleAllowSkip}>允许切歌</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 首次说明弹窗（bottom sheet）：双头像 + 同步规则说明，点「知道了」记一次性标记 */}
            {introOpen && (() => {
                const introChar = notice?.character ?? charsRef.current[0] ?? null;
                return (
                <div className="lt-intro-mask" onClick={() => { markListenNoticeSeen(); setIntroOpen(false); }}>
                    <div className="lt-intro-card" onClick={e => e.stopPropagation()}>
                        <span className="lt-notice-avas lt-intro-avas">
                            <span className="lt-notice-ava">
                                {userInfoRef.current?.avatar
                                    ? <img src={userInfoRef.current.avatar} alt="" />
                                    : <i>{(userInfoRef.current?.label || "?").slice(0, 1)}</i>}
                            </span>
                            <span className="lt-notice-ava lt-notice-ava-char">
                                {introChar?.avatar
                                    ? <img src={introChar.avatar} alt="" />
                                    : <i>{(introChar?.name || "?").slice(0, 1)}</i>}
                            </span>
                            <svg className="lt-notice-heart" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M12 21s-7.5-4.9-10-9.3C.4 8.6 2.4 5 6 5c2.2 0 3.8 1.2 6 3.5C14.2 6.2 15.8 5 18 5c3.6 0 5.6 3.6 4 6.7C19.5 16.1 12 21 12 21z" />
                            </svg>
                        </span>
                        <div className="lt-intro-title">一起听</div>
                        <p className="lt-intro-desc">{SYNC_NOTICE_DESC}</p>
                        <button
                            className="lt-intro-btn"
                            onClick={() => { markListenNoticeSeen(); setIntroOpen(false); }}
                        >
                            知道了
                        </button>
                    </div>
                </div>
                );
            })()}
        </div>
    );
}
