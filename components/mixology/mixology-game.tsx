"use client";

// 独家特调 · 对局画面：角色封面打底 + 三段蒙版，AI 正文无气泡全宽、
// 玩家右侧气泡、小票全宽卡；全程无任何标签徽章，保沉浸。
// 装饰材料的 CSS 以 <style> 注入本画面容器（认 .mix-* 官方语义类）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, Copy, GitBranch, History, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Sun, WandSparkles, X } from "lucide-react";
import { continueMix, editMixTurn, forkMixSession, generateMixReply, canReplayMixFrom, MIX_STORE_SNAPSHOT_TURNS, mixRoundCount, mixTurnRawText, recordMixPanelStore, refreshMixOpening, regenerateMixTail, rerollMixReply, rerunMixFilters, runMixEditSync, runMixSessionEnd, truncateMixAfterTurn } from "@/lib/mixology/engine";
import { MixBalanceChip } from "./mix-balance-chip";
import { ApiAccountPanel } from "@/components/settings/api-account-panel";
import { accountLabel, getApiAccount } from "@/lib/api-accounts";
import { resolveMixAccountId, snapshotMixAccount } from "@/lib/mixology/account";
import { findMixConnector, getMixMaterial, getMixSession, isMixBuiltinId, listMixPickables, MIX_CABINET_UPDATED_EVENT, resolveMixRecipeMaterials, saveMixMaterial, saveMixSession } from "@/lib/mixology/storage";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { buildMixConditionContext, pickActiveMixMaterials } from "@/lib/mixology/state";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_KIND_LABELS, MIX_SLOT_ORDER, mixEncoreRenderHtml, mixPanelLayoutOf, mixPanelSlotOf, mixSessionTitle, mixSlotEntries, mixTurnEncoreBlocks, mixTurnTicketBlocks, type MixCharacterCard, type MixFilterRule, type MixMaterial, type MixMaterialKind, type MixMechanismMaterial, type MixPanelLayout, type MixSession, type MixSlotEntry, type MixState, type MixTicketMaterial, type MixTurn, type MixDialogueButton } from "@/lib/mixology/types";
import { applyMixFilterRules, mixStreamText } from "@/lib/mixology/prose";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { KindGlyph, MixConfirm } from "./mixology-shared";
import { MixTicketFrame } from "./ticket-frame";
import { audioToBlob, MixMechanismInline, MixMechanismPanel, sendMixDialogue } from "./mechanism-panel";
import { MixTrustedSlot } from "./trusted-slot";
import { disposeMixTrusted, disposeMixTrustedForMaterial, ensureMixTrusted, sendMixTrustedDialogue, type MixTrustedHost } from "@/lib/mixology/trusted-runtime";
import { normalizeMixConnectorParams, runMixConnector, takeMixConnectorQuota } from "@/lib/mixology/connectors";
import { playMixAudio, primeMixAudio, stopMixAudio } from "@/lib/mixology/audio-player";

import type { MixProseDialogue } from "./prose-view";
import { MixSlotEditor } from "./slot-editor";
import { MixMaterialEditor } from "./mixology-editor";
import { MixSessionSwitcher } from "./mix-session-switcher";
import { MixSessionTree } from "./mix-session-tree";
import { MixStoryRail } from "./mix-story-rail";
import { MixStoryCompass } from "./mix-story-compass";
import { MixModelBadge } from "./mix-model-badge";
import {
    FOLLOW_MODE_HINTS,
    FOLLOW_MODE_LABELS,
    compassAnchorId,
    pairMixRounds,
    readCompassPrefs,
    writeCompassPrefs,
    type CompassPrefs,
    type CompassRound,
    type FollowMode,
} from "@/lib/mixology/story-compass";
import {
    CONTROL_DOCK_ACTIVATE_EVENT,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import { disposeMixSandboxesForMaterial } from "@/lib/mixology/mechanism-runtime";
import {
    subscribeMixSessionRuntime,
    getMixSessionRuntimeState,
    enqueueMixGeneration,
    cancelMixGeneration,
    getMixSessionGenStatus,
} from "@/lib/mixology/session-runtime";
import {
    subscribeMixPending,
    getMixPendingState,
    getMixPendingQueue,
    isMixPendingPaused,
    setMixPendingPaused,
    pushMixPending,
    takeMixPending,
    removeMixPending,
    clearMixPending,
    MIX_PENDING_MAX,
    type MixPendingItem,
} from "@/lib/mixology/pending-queue";

/** 当前真正挂着的对局：严格模式的重复挂载靠它区分「真退出」与「假卸载」 */
const liveMixGames = new Set<string>();

/** 缓冲发送区空队列兜底：useSyncExternalStore 要求未变化时同引用，不能每次现造 [] */
const EMPTY_MIX_PENDING: MixPendingItem[] = [];

type GameProps = {
    sessionId: string;
    onBack: () => void;
    onToast: (message: string) => void;
    onSwitchSession?: (sessionId: string) => void;
};

/** 一轮里要渲染的一块（状态栏/小剧场）：皮 + 这一轮的原文 */
type TurnFrame = { key: string; html: string; raw: string };

/**
 * 旧轮次懒加载：进对局只渲染最近这么多条（一条 = 一句用户发言或一轮 AI 回复），
 * 更早的收起来，顶上一颗「查看更早」按钮按批展开。
 * 每轮 AI 回复的状态栏/小剧场都是带脚本的沙盒 iframe，几十轮全挂着是手机上内存超限闪退的主因。
 */
const MIX_INITIAL_TURNS = 12;
const MIX_LOAD_MORE_TURNS = 12;
/** 回溯把轮次砍短后至少还露着几条（不足就把收起数往回让） */
const MIX_MIN_VISIBLE_TURNS = 4;
/**
 * 跳转（罗盘 / 侧轨点某一轮）时一次只铺开这么多条。
 *
 * 以前跳旧剧情是把「目标那一轮一直到最新一条」整段铺出来：那一局 126 条 50 万字，
 * 从第 1 轮跳一下就是 126 行 DOM + 68 个沙盒 iframe，开发机实测首帧长任务 1973ms，
 * 真机 2.9~4.3 秒（见 docs/改动记录.md 第四份日志）。收成一个窗口后，
 * 往上翻页走「查看更早」，往下续读走「查看更新的」，两边各 12 条一批。
 */
const MIX_JUMP_WINDOW_TURNS = 12;
/** 跳转窗口给目标前面留几条，免得落点紧贴视口上沿看不出上下文 */
const MIX_JUMP_LEAD_TURNS = 2;

function AssistantTurn({ turn, ticketFrames, encoreFrames, filterRules, state, dialogue }: { turn: MixTurn; ticketFrames: TurnFrame[]; encoreFrames: TurnFrame[]; filterRules?: MixFilterRule[]; state?: MixState; dialogue?: MixProseDialogue }) {
    // 展示顺序：状态栏在正文前、小剧场在正文后（与模型的输出顺序一致，无需重排）；
    // 一轮多块时依次上下排开，各块各自的皮各渲染各的
    // 滤网「仅显示」模式在这里生效：存储不动，渲染前替换，历史消息也即时生效
    const shownText = applyMixFilterRules(turn.text, filterRules, "display");
    return (
        <>
            {ticketFrames.map((frame) => (
                <div className="mix-ticket-wrap" key={frame.key}>
                    <MixTicketFrame html={frame.html} raw={frame.raw} state={state} />
                </div>
            ))}
            {shownText ? <MixProseView text={shownText} dialogue={dialogue} /> : null}
            {encoreFrames.map((frame) => (
                <div className="mix-encore-turn" key={frame.key}>
                    <MixTicketFrame html={frame.html} raw={frame.raw} state={state} />
                </div>
            ))}
        </>
    );
}

/** 每条消息下方的操作行：复制 / 回溯到这里 / 开新支线 / 编辑 */
function TurnActions({
    align,
    disabled,
    canRewind,
    onCopy,
    onRewind,
    onFork,
    onEdit,
}: {
    align: "left" | "right";
    disabled: boolean;
    canRewind: boolean;
    onCopy: () => void;
    onRewind: () => void;
    onFork: () => void;
    onEdit: () => void;
}) {
    return (
        <div className="mix-turn-actions" data-align={align}>
            <button type="button" className="mix-turn-act" onClick={onCopy} disabled={disabled} aria-label="复制"><Copy size={13} /></button>
            {canRewind ? (
                <button type="button" className="mix-turn-act" onClick={onRewind} disabled={disabled} aria-label="回溯到这里"><History size={13} /></button>
            ) : null}
            <button type="button" className="mix-turn-act" onClick={onFork} disabled={disabled} aria-label="从此处开新支线" title="从此处开新支线"><GitBranch size={13} /></button>
            <button type="button" className="mix-turn-act" onClick={onEdit} disabled={disabled} aria-label="编辑"><Pencil size={13} /></button>
        </div>
    );
}

/** 开新支线弹层：从指定轮分叉，收集支线名 + 备注，确认后由调用方建支线并跳转 */
function MixForkDialog({
    fromTitle,
    fromTurnText,
    roundCount,
    defaultName,
    onCancel,
    onConfirm,
}: {
    fromTitle: string;
    fromTurnText?: string;
    roundCount: number;
    defaultName?: string;
    onCancel: () => void;
    onConfirm: (opts: { branchName: string; branchNote: string }) => void;
}) {
    const [name, setName] = useState(defaultName ?? "");
    const [note, setNote] = useState("");
    return (
        <div className="mix-modal-mask" onClick={onCancel}>
            <div className="mix-modal mix-fork-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="mix-modal-head">
                    <span>从此处开新支线</span>
                    <button type="button" className="mix-modal-x" onClick={onCancel} aria-label="关闭"><X size={16} /></button>
                </div>
                <div className="mix-modal-body">
                    <p className="mix-fork-from">
                        从「{fromTitle}」第 {roundCount} 轮之后分叉：新支线复制此前所有进度作为起点，从这一轮往后各自续写，<b>原对局不受影响</b>。
                    </p>
                    {fromTurnText ? <p className="mix-fork-summary">分叉点：{fromTurnText}</p> : null}
                    <label className="mix-field">
                        <span>支线名</span>
                        <input
                            className="mix-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="如：黑化路线 / 和平结局"
                            maxLength={24}
                            autoFocus
                        />
                    </label>
                    <label className="mix-field">
                        <span>备注</span>
                        <textarea
                            className="mix-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="随手记一句这条线在干嘛，方便以后回退 / 回忆"
                            rows={3}
                            maxLength={200}
                        />
                    </label>
                </div>
                <div className="mix-modal-foot">
                    <button type="button" className="mix-btn" onClick={onCancel}>取消</button>
                    <button type="button" className="mix-btn mix-btn-primary" onClick={() => onConfirm({ branchName: name, branchNote: note })}>创建支线</button>
                </div>
            </div>
        </div>
    );
}
/**
 * 记住的值：顶栏下的一条横条，点开看全部。
 * 没有任何值时整条不存在——没配小票的对局界面不变。
 */
function StateBar({ state }: { state: MixState }) {
    const [open, setOpen] = useState(false);
    const items = Object.entries(state);
    if (!items.length) return null;
    return (
        <div className="mix-state-bar" data-open={open ? "true" : undefined}>
            <button type="button" className="mix-state-strip" onClick={() => setOpen((v) => !v)}>
                {items.slice(0, 3).map(([name, value]) => (
                    <span className="mix-state-chip" key={name}>
                        <i>{name}</i>
                        <b>{String(value)}</b>
                    </span>
                ))}
                {items.length > 3 ? <span className="mix-state-more">+{items.length - 3}</span> : null}
            </button>
            {open ? (
                <div className="mix-state-panel">
                    {items.map(([name, value]) => (
                        <div className="mix-state-row" key={name}>
                            <span>{name}</span>
                            <b>{String(value)}</b>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function MixologyGame({ sessionId, onBack, onToast, onSwitchSession }: GameProps) {
    const [session, setSession] = useState<MixSession | null>(() => getMixSession(sessionId));
    const [input, setInput] = useState("");
    /**
     * 这局实际烧的是哪本账 = **快捷切换里选中的那个「全局模型」所属的文件夹**。
     * 解析交给共享的 lib/mixology/account.ts：它读的就是 binding.globalDefaults.apiConfigId
     * （角色级绑定不参与对局），全局没设时才退到配置列表第一个 —— 必须与对局实际取配置的口径一致，
     * 否则「显示的余额」和「真正扣费的账户」会是两本账。
     * 用户中途换模型也要跟着换账户；baseline 只在「换账户」时重取，以免本局消耗被清零。
     */
    const [mixAccount, setMixAccount] = useState(() => snapshotMixAccount());

    useEffect(() => {
        const sync = () => setMixAccount(prev => {
            const id = resolveMixAccountId();
            if (id === prev.id) return prev; // 同一本账：保留 baseline，免得「本局消耗」被清零
            return { id, baseline: getApiAccount(id).balance };
        });
        sync();
        window.addEventListener("settings-bindings-updated", sync);
        return () => window.removeEventListener("settings-bindings-updated", sync);
    }, []);
    const [accountOpen, setAccountOpen] = useState(false);
    /**
     * 订阅对局运行时：多对局并行生成不打断，生成状态由 runtime 统一管理。
     */
    const runtimeState = useSyncExternalStore(
        subscribeMixSessionRuntime,
        getMixSessionRuntimeState,
        getMixSessionRuntimeState
    );
    // 从订阅到的 runtimeState 派生当前对局的生成状态，
    // 而不是直接调全局 getters——确保渲染时取到的值与触发重渲染的那份快照一致，
    // 避免「notify 触发了重渲染，但派生值读到了更晚的状态」的时间差问题。
    const runningEntry = runtimeState.running[sessionId];
    const busy = runningEntry ? (runningEntry.status === "generating" || runningEntry.status === "queued") : false;
    const live = runningEntry?.liveText ?? "";
    const genStatus = runningEntry?.status ?? null;
    /**
     * 缓冲发送区：调制期间敲好的后续剧情按局排队（模块级 store，切界面/刷新都不丢），
     * 出杯后由下面的状态迁移效果逐条自动接话。
     */
    const pendingState = useSyncExternalStore(subscribeMixPending, getMixPendingState, getMixPendingState);
    const pendingQueue = pendingState.queues[sessionId] ?? EMPTY_MIX_PENDING;
    const pendingPaused = !!pendingState.paused[sessionId];
    /** 接话函数够不着声明位置（它在早退 return 之后才定义），状态迁移效果经由这个 ref 调它 */
    const pumpPendingRef = useRef<() => void>(() => {});
    /**
     * 当前正在显示的对局 id（ref 版）：生成是异步的，期间用户可能切去别的对局，
     * 旧闭包里的 commit 靠它判断自己是否已经过期，避免把旧对局数据刷进新界面。
     */
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;
    // 本组件无 key 复用，useState 初始化只在首次挂载跑——切对局时手动回读
    useEffect(() => {
        setSession(getMixSession(sessionId));
    }, [sessionId]);
    /**
     * 生成结束（生成/排队 → 完成/失败/条目清理）时回读存储刷新界面：
     * 引擎把新回合写进 localStorage 后不会主动喊组件，session state 不自重读；
     * 非流式下没有 live 文本兜底，不在这里刷的话界面会一直停在旧内容上。
     */
    const prevGenStatus = useRef(genStatus);
    useEffect(() => {
        const prev = prevGenStatus.current;
        prevGenStatus.current = genStatus;
        const wasActive = prev === "generating" || prev === "queued";
        const isActive = genStatus === "generating" || genStatus === "queued";
        if (wasActive && !isActive) setSession(getMixSession(sessionId));
        // 缓冲发送区自动接话的状态迁移口径：
        // · 正常出杯（→done）后 runtime 清掉条目（done→null）→ 取队首接话；
        // · 没走到 done 就结束（生成出错、被取消）→ 自动接话暂停。失败之后再把
        //   后文往坏掉的现场里灌没有意义，队列原样留着等玩家点「继续发送」。
        if (wasActive && !isActive && genStatus !== "done") setMixPendingPaused(sessionId, true);
        if (prev === "done" && genStatus === null) pumpPendingRef.current();
    }, [genStatus, sessionId]);
    // 带着队列回到一场此刻没有任何生成的对局：补接一棒。
    // 生成发生在界面外的话，done→null 那次迁移组件没挂着、捕捉不到，这里兜底；
    // pumpPending 自己会看 runtime 状态，残留态/暂停/空队列都会原样退回。
    useEffect(() => {
        if (!getMixPendingQueue(sessionId).length) return;
        const t = setTimeout(() => pumpPendingRef.current(), 300);
        return () => clearTimeout(t);
    }, [sessionId]);
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    /** 开新支线弹层状态：记录从哪条消息分叉（turnId + 绝对索引） */
    const [fork, setFork] = useState<{ turnId: string; idx: number } | null>(null);
    /**
     * 编辑弹层的键盘适配（iOS）：弹层高、输入框更高，键盘一出 WebKit 会滚动整页
     * 去追光标，把弹层标题顶出屏幕（偶发，取决于光标位置与时序）。两手处理：
     * ① 给遮罩垫 padding-bottom = 键盘高度，弹层整体抬到键盘上方（78% 上限
     *    按剩余高度算，整个弹层都在可视区里，iOS 就没有追光标的理由）；
     * ② 页面还是被蹭走的话（visualViewport 偏移/window 滚动），立刻拉回。
     */
    const editMaskRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!editing || typeof window === "undefined") return;
        const vv = window.visualViewport;
        let raf = 0;
        const sync = () => {
            raf = 0;
            const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
            const mask = editMaskRef.current;
            if (mask) mask.style.paddingBottom = inset > 40 ? `${inset}px` : "";
            if (window.scrollY || (vv && vv.offsetTop > 1)) window.scrollTo(0, 0);
        };
        const request = () => { if (!raf) raf = requestAnimationFrame(sync); };
        sync();
        vv?.addEventListener("resize", request);
        vv?.addEventListener("scroll", request);
        window.addEventListener("scroll", request);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            vv?.removeEventListener("resize", request);
            vv?.removeEventListener("scroll", request);
            window.removeEventListener("scroll", request);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 只关心开/关，别在每次敲字时重挂监听
    }, [Boolean(editing)]);
    const [confirm, setConfirm] = useState<{ type: "rewind" | "edit"; turnId: string } | { type: "refilter" } | null>(null);
    const [recipeOpen, setRecipeOpen] = useState(false);
    /** 局内的叠层编辑：排序 / 生效条件 / 移除，和吧台同一套编辑器 */
    const [slotEdit, setSlotEdit] = useState<MixMaterialKind | null>(null);
    const [slotPick, setSlotPick] = useState<MixMaterialKind | null>(null);
    /**
     * 局内材料编辑器：复用酒柜的创建弹窗（MixMaterialEditor），觉得哪里不对味
     * 不用退出对局回酒柜改。slot 有值 = 从某格的「+」新建，保存后顺手放进那一格。
     */
    const [matEditor, setMatEditor] = useState<{ kind: MixMaterialKind; initial?: MixMaterial; slot?: MixMaterialKind } | null>(null);
    const [wheelIndex, setWheelIndex] = useState(0);
    /**
     * 酒柜外部变更计数：小卷（吉祥物工具）改完材料会广播这个事件，对局里的
     * 画布/小票/装饰都是渲染时从酒柜现取的，靠它促使下面两个 useMemo 重取——
     * 否则开着的对局要退出重进才能看到小卷刚写的开场画布。
     */
    const [cabinetTick, setCabinetTick] = useState(0);
    useEffect(() => {
        const bump = () => setCabinetTick((t) => t + 1);
        window.addEventListener(MIX_CABINET_UPDATED_EVENT, bump);
        return () => window.removeEventListener(MIX_CABINET_UPDATED_EVENT, bump);
    }, []);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    /**
     * 滚动落点：还没开口的局停在扉页顶上（开场画布要从头看），聊过的局停在最新一条上。
     * free = 用户自己翻过了，别再拽他。
     */
    const stickRef = useRef<"top" | "bottom" | "free">("bottom");
    /**
     * 新一轮渲染要不要把视口拽到最后一行（三档）：
     * always = 始终贴底；bottom = 只在你本来就在底部时才跟着走；manual = 完全不动。
     * 由罗盘偏好驱动，applyStick 读它——放 ref 是为了让它们在同一帧里读到同一份值。
     */
    const followRef = useRef<FollowMode>("manual");
    /**
     * 懒加载：收起的更早轮次数（从头数）。记"收起几条"而不是"露出几条"：
     * 回溯把后面的轮次砍掉时，收起的那些不会因此从顶上冒出来把画面往下推——
     * 用户正停在被回溯的那一轮上，iOS 没有 scroll anchoring，顶上一长就跳走了。
     *
     * 初值必须在这里算好，不能留 0 等 layouteffect 去收：
     * `session.turns.slice(hiddenTurnCount, turns.length - tailHiddenCount)` 是渲染入口，
     * 头留 0 就是**首帧把整局全渲出来**（实测 415 轮那场首帧渲 415 行、每行还要挂
     * 沙盒 iframe），下一次 commit 才收到只剩 12 行——那 403 行白渲白拆，正是"进对局卡好几秒"
     * 里随轮数增长的那一块。开发机同一份真实数据：进那场 415 轮对局的长任务 3863ms（原始）
     * → 2227ms（先消掉重复 JSON.parse）→ **344ms**（本初值），渲染行数 415 → 12。
     * 下面 `useLayoutEffect([sessionId])` 里那次 setHiddenTurnCount 与本初值同式，
     * 数值相同 React 直接跳过重渲染，只保留它负责的另一半（定 stickRef / applyStick）。
     */
    const [hiddenTurnCount, setHiddenTurnCount] = useState(() => Math.max(0, (session?.turns.length ?? 0) - MIX_INITIAL_TURNS));
    /**
     * 收起的**更新**轮次数（从尾数）。平时一直是 0（人就停在最新那一截）；
     * 只有跳旧剧情时才非零——跳过去以后，这一截窗口的下面还压着没渲染的内容，
     * 底部给一颗「查看更新的」按钮按批放出来。渲染入口是
     * `session.turns.slice(hiddenTurnCount, turns.length - tailHiddenCount)`，
     * 两头都有闸门，跳转才不会把「目标到最新」整段铺出来（见 MIX_JUMP_WINDOW_TURNS 的实测数）。
     */
    const [tailHiddenCount, setTailHiddenCount] = useState(0);
    /**
     * 展开更早的轮次后，把原来最上面那条钉在屏幕上原来的位置：新插进来的轮次里
     * 小票/小剧场 iframe 是异步报高的，头一两秒内容会连着长高几次，每次报高都按锚点重落一次，
     * iOS Safari 没有 scroll anchoring，不这么做就会被推得乱跳。
     */
    const loadMoreAnchorRef = useRef<{ turnId: string; top: number; until: number } | null>(null);

    const handleWheelScroll = useCallback(() => {
        const el = wheelRef.current;
        if (!el) return;
        const center = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        Array.from(el.children).forEach((child, i) => {
            const c = child as HTMLElement;
            const mid = c.offsetLeft + c.offsetWidth / 2;
            const dist = Math.abs(mid - center);
            if (dist < bestDist) { bestDist = dist; best = i; }
        });
        setWheelIndex(best);
    }, []);

    // 封面 / 小票渲染代码 / 装饰 CSS：按方案槽位从酒柜现取
    const assets = useMemo(() => {
        if (!session) return { cover: "", tickets: [] as { id: string; html: string }[], garnishCss: "", aiEncores: [] as { id: string; html: string }[], encoreStatics: [] as { id: string; html: string }[], canvasHtml: "", filterRules: undefined as MixFilterRule[] | undefined };
        // 渲染侧同样吃生效条件：夜里才生效的装饰、到点才演的小剧场，靠的就是这一步
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        const character = active.character?.[0] ?? null;
        // 小票/尾调是多块并行：条件命中的全部在场，每件各自成块各渲染各的
        const tickets = (active.ticket ?? [])
            .filter((m): m is MixTicketMaterial => m.kind === "ticket")
            .map((m) => ({ id: m.id, html: m.renderHtml?.trim() ?? "" }))
            .filter((t) => t.html);
        const encoreMats = (active.encore ?? []).filter((m) => m.kind === "encore");
        // 写了契约 = AI 小剧场（按轮渲染）；没写契约 = 静态小品（挂在对话末尾）
        const aiEncores: { id: string; html: string }[] = [];
        const encoreStatics: { id: string; html: string }[] = [];
        for (const m of encoreMats) {
            if (m.kind !== "encore") continue;
            const html = mixEncoreRenderHtml(m).trim();
            if (!html) continue;
            (m.contract?.trim() ? aiEncores : encoreStatics).push({ id: m.id, html });
        }
        // 装饰与滤网是累加型：条件命中的几件按顺序叠加 / 串联
        const garnishCss = (active.garnish ?? [])
            .map((m) => (m.kind === "garnish" ? m.css.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
        const filterRules = (active.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        return {
            cover: character?.cover ?? "",
            tickets,
            garnishCss,
            filterRules: filterRules.length ? filterRules : undefined,
            aiEncores,
            encoreStatics,
            // 开场画布：对局里作为故事扉页躺在滚动区最顶上，往上翻可见
            // 开场画布：作者会在里面写 {{user}} / {{char}}，而画布是原样进 iframe 的，
            // 不经过提示词装配，所以在这里替换掉，否则玩家看到的是字面的「{{user}}」
            canvasHtml: character?.kind === "character"
                ? applyMixMacros(
                    (character as MixCharacterCard).canvas?.trim() ?? "",
                    session.charName,
                    session.userName || MIX_DEFAULT_USER_NAME,
                    session.state,
                    { escapeHtml: true },
                )
                : "",
        };
    }, [session, cabinetTick]);

    /**
     * 条件命中、且写了界面的机括：这些是要常驻在对局画面上的界面。
     * 不设数量上限——每件一个 iframe，多开吃内存是玩家自己的选择，
     * 真糊满屏幕还有「一键收起」的逃生口。
     * 摆放取材料自己写的那份；玩家在这一局里拖动过的，以拖过的为准。
     */
    /** 这一局生效的全部机括（沙盒的与信任模式的都在） */
    const activeMechanisms = useMemo(() => {
        if (!session) return [] as MixMechanismMaterial[];
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        return (active.mechanism ?? []).filter((m): m is MixMechanismMaterial => m.kind === "mechanism");
    }, [session, cabinetTick]); // eslint-disable-line react-hooks/exhaustive-deps
    /** 信任模式的机括：代码直接在页面里跑，坑位由 MixTrustedSlot 挂 */
    const trustedMechanisms = useMemo(() => activeMechanisms.filter((m) => m.trusted && m.script?.trim()), [activeMechanisms]);
    const panels = useMemo(() => {
        if (!session) return [] as { material: MixMechanismMaterial; layout: MixPanelLayout }[];
        return activeMechanisms
            .filter((m) => !m.trusted && Boolean(m.panelHtml?.trim()))
            .map((material) => {
                const base = mixPanelLayoutOf(material);
                if (!base) return null;
                const moved = session.panelBox?.[material.id];
                return { material, layout: moved ? { ...base, ...moved } : base };
            })
            .filter((item): item is { material: MixMechanismMaterial; layout: MixPanelLayout } => item !== null);
    }, [session, activeMechanisms]);

    // 机括声明了连接器而本机没配：进局时提醒一次（同一局只提一次），
    // 免得玩家点了半天按钮才在沙盒里看到一条报错
    const missingWarnedRef = useRef("");
    useEffect(() => {
        const missing = activeMechanisms.flatMap((material) =>
            (material.connectors ?? []).filter((name) => !findMixConnector(name)).map((name) => ({ material: material.name, name })));
        if (!missing.length) return;
        const key = missing.map((m) => `${m.material}:${m.name}`).join("|");
        if (missingWarnedRef.current === key) return;
        missingWarnedRef.current = key;
        const first = missing[0];
        onToast(`机括「${first.material}」需要连接器「${first.name}」，到酒柜的「连接器」里创建一个再来。`);
    }, [activeMechanisms, onToast]);

    /**
     * 按挂点分组：float 走悬浮层（老形态），header/inputbar-* 由宿主画按钮开合，
     * flow-* 作为内嵌卡进滚动流。按钮与容器都是宿主画的，沙盒只管格子里的内容。
     */
    const slotGroups = useMemo(() => {
        const groups = {
            float: [] as typeof panels,
            header: [] as typeof panels,
            "inputbar-left": [] as typeof panels,
            "inputbar-right": [] as typeof panels,
            "flow-top": [] as typeof panels,
            "flow-bottom": [] as typeof panels,
            hidden: [] as typeof panels,
        };
        for (const item of panels) groups[mixPanelSlotOf(item.layout)].push(item);
        return groups;
    }, [panels]);

    /**
     * 回传轮数：默认不限（全部历史都发给模型），玩家在修改方案弹窗里调了才裁。
     * 只裁请求内容，存储与界面回放完整；随对局保存。
     */
    const [histOpen, setHistOpen] = useState(false);
    const setHistoryLimit = useCallback((limit: number | undefined) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const next: MixSession = { ...current };
        if (limit && limit > 0) next.historyLimit = Math.floor(limit);
        else delete next.historyLimit;
        saveMixSession(next);
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 按钮位面板的开合，按局记忆；关着的不渲染（要留住的状态放机括存储桶） */
    const dockOpen = session?.panelOpen ?? {};
    const toggleDock = useCallback((materialId: string) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const next = { ...(current.panelOpen ?? {}) };
        next[materialId] = !next[materialId];
        saveMixSession({ ...current, panelOpen: next });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /**
     * 对白按钮：声明了 dialogueButton 的机括，宿主替它在每句「对白」后画一颗图标。
     * 点击把这句话递进它的界面（sendMixDialogue），界面用 mix.mark 回报状态改图标。
     * 按钮位（header/inputbar-*）的面板关着时收不到，先替玩家打开再递。
     */
    // 代码里登记的对白按钮（mix.dialogueButton）：materialId → 图标/提示。进局先拿上一次记住的，
    // 代码跑起来重新登记后覆盖；按钮位面板关着代码没跑时，靠记住的那份先把按钮画出来
    const [runtimeButtons, setRuntimeButtons] = useState<Record<string, MixDialogueButton>>(() => ({ ...(getMixSession(sessionId)?.dialogueButtons ?? {}) }));
    const handleDialogueButton = useCallback((materialId: string, button: MixDialogueButton | null) => {
        setRuntimeButtons((prev) => {
            const same = button ? prev[materialId]?.icon === button.icon && (prev[materialId]?.title ?? "") === (button.title ?? "") : !prev[materialId];
            if (same) return prev;
            const next = { ...prev };
            if (button) next[materialId] = button; else delete next[materialId];
            const current = getMixSession(sessionId);
            if (current) saveMixSession({ ...current, dialogueButtons: Object.keys(next).length ? next : undefined });
            return next;
        });
    }, [sessionId]);
    const dialogueActions = useMemo(
        () => activeMechanisms
            .map((material) => ({ material, button: runtimeButtons[material.id] ?? material.dialogueButton }))
            .filter(({ material, button }) => button?.icon && (material.trusted ? material.script?.trim() : material.panelHtml?.trim()))
            .map(({ material, button }) => ({ key: material.id, icon: button!.icon, title: button!.title || material.name })),
        [activeMechanisms, runtimeButtons],
    );
    const [dialogueStates, setDialogueStates] = useState<Record<string, string>>({});
    const handlePanelMark = useCallback((materialId: string, id: string, state: string) => {
        setDialogueStates((prev) => {
            const key = `${materialId}|${id}`;
            if ((prev[key] || "") === state) return prev;
            const next = { ...prev };
            if (state) next[key] = state;
            else delete next[key];
            return next;
        });
    }, []);
    const handleDialogueTap = useCallback((materialId: string, segmentId: string, text: string, turnId: string) => {
        // 这次点击是宿主拿到的唯一手势：趁现在把播放元素解锁，机括稍后 mix.play 才放得出声（iOS）
        primeMixAudio();
        if (trustedMechanisms.some((m) => m.id === materialId)) {
            sendMixTrustedDialogue(sessionId, materialId, { id: segmentId, text, turnId });
            return;
        }
        const item = panels.find(({ material }) => material.id === materialId);
        if (!item) return;
        const slot = mixPanelSlotOf(item.layout);
        if ((slot === "header" || slot === "inputbar-left" || slot === "inputbar-right") && !(getMixSession(sessionId)?.panelOpen?.[materialId])) {
            toggleDock(materialId);
        }
        sendMixDialogue(materialId, { id: segmentId, text, turnId });
    }, [panels, trustedMechanisms, sessionId, toggleDock]);
    const dialogueFor = useCallback((turnId: string): MixProseDialogue | undefined => {
        if (!dialogueActions.length) return undefined;
        return {
            actions: dialogueActions,
            states: dialogueStates,
            idPrefix: `${turnId}:`,
            onTap: (key, segmentId, text) => handleDialogueTap(key, segmentId, text, turnId),
        };
    }, [dialogueActions, dialogueStates, handleDialogueTap]);

    /**
     * 机括界面的逃生口。摆放完全交给创作者之后，理论上存在"一块面板糊满整个屏幕、
     * 连输入框都点不到"的材料——不靠限制排版来防，靠这里一键收掉、一键归位。
     */
    const [panelsHidden, setPanelsHidden] = useState(false);

    /** 把这一局里拖过的摆放全部丢掉，退回材料自己写的那份 */
    const resetPanelBoxes = useCallback(() => {
        const current = getMixSession(sessionId);
        if (!current?.panelBox) return;
        const next = { ...current };
        delete next.panelBox;
        saveMixSession(next);
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 玩家把面板拖过/拉过之后记在这一局里，不回写材料 */
    const handlePanelBox = useCallback((materialId: string, box: { x: number; y: number; w: number; h: number }) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const previous = current.panelBox?.[materialId];
        if (previous && previous.x === box.x && previous.y === box.y && previous.w === box.w && previous.h === box.h) return;
        saveMixSession({ ...current, panelBox: { ...(current.panelBox ?? {}), [materialId]: { ...(previous ?? {}), ...box } } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 界面写自己的存储 */
    const handlePanelStore = useCallback((materialId: string, store: Record<string, string>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        // 手改记在当前这一轮上：日后编辑早先某轮重画时，走到这里会再盖一次
        saveMixSession(recordMixPanelStore(current, materialId, store));
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 界面写记住的值 */
    const handlePanelState = useCallback((patch: Record<string, string | number>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        saveMixSession({ ...current, state: { ...(current.state ?? {}), ...patch } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /**
     * 把记住的值挂成对局根节点上的 CSS 变量，装饰里可以直接用：
     *   .mix-game { background: hsl(calc(var(--mix-state-好感度) * 2) 40% 12%); }
     * 变量名里的空白和引号会被换成下划线，避免拼出非法的自定义属性名。
     */
    const stateCssVars = useMemo(() => {
        const vars: Record<string, string> = {};
        for (const [name, value] of Object.entries(session?.state ?? {})) {
            const safe = name.trim().replace(/[\s"'\\;:{}()]/g, "_");
            if (safe) vars[`--mix-state-${safe}`] = String(value);
        }
        return vars as CSSProperties;
    }, [session?.state]);

    /** 上一次 scroll 事件时的位置：撒手判定靠它识别滚动方向 */
    const lastTopRef = useRef(0);

    /** 按当前落点滚一次。force = 进局 / 玩家显式操作，不受跟随档位限制 */
    const applyStick = useCallback((force = false) => {
        const el = scrollRef.current;
        if (!el) return;
        const mode = followRef.current;
        // manual：任何"内容长高了"都不许动视口，你滑到哪就在哪
        if (!force && mode === "manual") return;
        if (!force && mode === "bottom") {
            // bottom：只有你本来就已经停在最新的时候才跟着往下；正在翻旧剧情就撒手
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (gap > 24) return;
            if (stickRef.current === "free") stickRef.current = "bottom";
        }
        if (stickRef.current === "free") return;
        el.scrollTop = stickRef.current === "top" ? 0 : el.scrollHeight;
        lastTopRef.current = el.scrollTop;
    }, []);

    /**
     * 进对局定一次落点：没人开过口的局停在扉页顶上（开场画布要从头看），聊过的停在最新一条上。
     * 只认 sessionId——定完就撒手，后面翻页（free）和发言（bottom）都能改它，这里不再回头覆盖。
     * 以前这个 effect 还挂着 busy 和 turns.length：一发言 busy 先翻 true，而用户那一轮要等
     * 落杯前钩子跑完才落库，这一拍读到的还是「没人开过口」，于是把人拽回了扉页顶上。
     *
     * 用 useLayoutEffect 在首帧绘制前就把落点钉好，配合入场幕布（entering）：
     * 滚动区里的小票/小剧场/画布 iframe 都是异步量高的，头几百毫秒内容会连着长高几次，
     * 当着用户的面就是「点进去闪好几下」。幕布期间不可见、每次报高都在幕后重新落位，
     * 揭幕那一刻已经停在正确位置。
     */
    const [entering, setEntering] = useState(true);
    useLayoutEffect(() => {
        setEntering(true);
        loadMoreAnchorRef.current = null;
        const entered = getMixSession(sessionId);
        setHiddenTurnCount(Math.max(0, (entered?.turns.length ?? 0) - MIX_INITIAL_TURNS));
        // 换一局就是换了个窗口，上一局跳旧剧情留下的"尾部收起"不能带过来
        setTailHiddenCount(0);
        stickRef.current = (entered?.turns ?? []).some((turn) => turn.role === "user") ? "bottom" : "top";
        // 进局算一次定位，不算"内容长高了"——不受跟随档位影响，否则刚进来就不知道自己在哪儿
        applyStick(true);
        const timer = window.setTimeout(() => {
            applyStick(true);
            setEntering(false);
        }, 400);
        return () => window.clearTimeout(timer);
    }, [sessionId, applyStick]);

    /** 内容长高了（新一轮到达、生成态切换、流式又写出一段）按当前落点再落一次 */
    useEffect(() => {
        applyStick();
    }, [session?.turns.length, busy, live, applyStick]);

    /**
     * 滚动区里的沙盒 iframe——开场画布、每轮的小票与小剧场、末尾的静态小品——高度都是
     * 里面量好再 postMessage 报上来的：挂载那一刻它们只有几十像素，等报上真实高度，
     * 下面的内容整体被推下去。Chrome 有 scroll anchoring 会自己补偿，iOS Safari 没有，
     * 滚动位置原地不动，于是就停在中间——既不贴顶也不贴底。
     *
     * 这里直接听两种画布的高度消息，比给每个组件挂 onHeight 稳：
     * 一是小票/小剧场那几个框本来就没有回调，二是 RichFrame 的 onHeight 是在 setHeight
     * 之后同步调的，那一刻新高度还没提交进 DOM，落点会按旧的 scrollHeight 算，等于白落。
     * 隔两帧再落，确保 React 提交完、浏览器也重新布局过。
     */
    const restoreLoadMoreAnchor = useCallback((): boolean => {
        const anchor = loadMoreAnchorRef.current;
        const el = scrollRef.current;
        if (!anchor || !el) return false;
        if (Date.now() > anchor.until) { loadMoreAnchorRef.current = null; return false; }
        const target = el.querySelector<HTMLElement>(`[data-turn-id="${anchor.turnId}"]`);
        if (!target) return false;
        const now = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += now - anchor.top;
        lastTopRef.current = el.scrollTop;
        return true;
    }, []);

    useEffect(() => {
        const onFrameResize = (event: MessageEvent) => {
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.type !== "resize") return;
            if (data.source !== "mix-rich-frame" && data.source !== "mix-ticket-frame") return;
            requestAnimationFrame(() => requestAnimationFrame(() => { if (!restoreLoadMoreAnchor()) applyStick(); }));
        };
        window.addEventListener("message", onFrameResize);
        return () => window.removeEventListener("message", onFrameResize);
    }, [applyStick, restoreLoadMoreAnchor]);

    /** 展开更早的一批：先记下最上面那条在屏幕上的位置，展开后钉回去；同时撒手，不再跟底 */
    const loadMoreTurns = useCallback(() => {
        const el = scrollRef.current;
        const first = el?.querySelector<HTMLElement>("[data-turn-id]");
        if (el && first) {
            loadMoreAnchorRef.current = {
                turnId: first.dataset.turnId ?? "",
                top: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
                until: Date.now() + 2500,
            };
        }
        stickRef.current = "free";
        setHiddenTurnCount((count) => Math.max(0, count - MIX_LOAD_MORE_TURNS));
    }, []);
    useLayoutEffect(() => { restoreLoadMoreAnchor(); }, [hiddenTurnCount, restoreLoadMoreAnchor]);

    /**
     * 轮数变了跟着修正收起数：
     * · 变少（回溯/撤回）：只保证还露着几条，不多露——不然顶上冒出旧轮次把画面推下去；
     * · 变多（新一轮到了）且正贴着底：把顶上多出来的收掉，常驻的 iframe 数量不随长局增长。
     * 尾部收起（跳旧剧情留下的那一截）同样跟着修正：贴底时一律放开，
     * 回溯把后面的轮次砍掉时收起到还剩几条，避免出现"整段都被收起、屏幕空白"。
     */
    const turnCount = session?.turns.length ?? 0;
    useLayoutEffect(() => {
        setHiddenTurnCount((hidden) => {
            const maxHidden = Math.max(0, turnCount - MIX_MIN_VISIBLE_TURNS);
            if (hidden > maxHidden) return maxHidden;
            if (stickRef.current === "bottom") return Math.max(hidden, turnCount - MIX_INITIAL_TURNS);
            return hidden;
        });
        setTailHiddenCount((tail) => {
            if (stickRef.current === "bottom") return 0;
            const maxTail = Math.max(0, turnCount - MIX_MIN_VISIBLE_TURNS - hiddenTurnCount);
            return tail > maxTail ? maxTail : tail;
        });
    }, [turnCount, hiddenTurnCount]);

    /**
     * 用户自己翻页了就撒手，别在画布撑高时把他拽回去。
     * 「翻页」只认真实手势（滚轮/触摸/按压），不认 scroll 事件本身——
     * iframe 报高会让 scrollHeight 在钉底之后又变大，等 scroll 回调执行时
     * gapBottom 已经是新长出来的那截，按距离判定会把这误当成用户翻走，
     * 从此不再跟底，人就停在半路。没有手势的偏离一律视为内容重排，立刻拉回。
     */
    const gestureAtRef = useRef(0);
    const markGesture = useCallback(() => { gestureAtRef.current = Date.now(); }, []);
    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const prevTop = lastTopRef.current;
        lastTopRef.current = el.scrollTop;
        // 手动/贴底模式下积攒的新内容，滑回底部就消掉
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 60) setNewCount(0);
        if (stickRef.current === "free") return;
        const gapTop = el.scrollTop;
        const gapBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const stuck = stickRef.current === "top" ? gapTop <= 8 : gapBottom <= 8;
        if (stuck) return;
        // 用户意图两条通路缺一不可：
        // ① 手势（滚轮/触摸/按压，1.6s 覆盖惯性尾巴）——但手指落在小票/小剧场/画布的
        //    iframe 上时触摸事件被沙盒吃掉、不冒泡，外层什么都收不到；
        // ② 方向启发兜住 ① 的盲区：贴底时 scrollTop 变小（在往上挪）、贴顶时变大，
        //    只有用户滚动才会朝"背离锚点"的方向动——内容重排只会把落点甩远，不会反向。
        const movedAway = stickRef.current === "bottom"
            ? el.scrollTop < prevTop - 1
            : el.scrollTop > prevTop + 1;
        if (movedAway || Date.now() - gestureAtRef.current < 1600) stickRef.current = "free";
        else applyStick();
    }, [applyStick]);

    // 切换对局时（sessionId 变化），重新加载对局数据
    useEffect(() => {
        setSession(getMixSession(sessionId));
        stickRef.current = "bottom";
    }, [sessionId]);

    // 进对局：还没开口的局用当前角色卡重取开场白。
    // 开场白是建局时写死进 turns[0] 的一条消息，作者改完卡回来本来看不到新的那句；
    // 已经聊过的局不动（refreshMixOpening 自己判），那是真实历史。
    useEffect(() => {
        const res = refreshMixOpening(sessionId);
        if (res?.changed) {
            setSession(res.session);
            onToast("开场白已更新为角色卡最新的一版。");
        }
    }, [sessionId, onToast]);

    // 退出对局：跑一次收摊钩子并收掉这一局的全部沙盒，别让它们挂在页面上。
    // 延后一拍再判：开发期的严格模式会「挂载 → 立刻卸载 → 再挂载」，
    // 直接在清理函数里收摊会在刚进对局时就把这一局收掉。
    useEffect(() => {
        liveMixGames.add(sessionId);
        return () => {
            liveMixGames.delete(sessionId);
            window.setTimeout(() => {
                if (!liveMixGames.has(sessionId)) void runMixSessionEnd(sessionId);
            }, 0);
        };
    }, [sessionId]);

    /**
     * 界面以玩家身份发一句话：走的是和输入框一模一样的路径，不是特权通道。
     * 声明放在「对局不存在」的提前返回之前——Hook 的调用顺序不能随渲染变；
     * 真正的实现在下面挂到 sayRef 上，传给界面的这个函数身份始终不变。
     */
    const sayRef = useRef<(text: string) => void>(() => {});
    const handlePanelSay = useCallback((text: string) => { sayRef.current(text); }, []);

    /**
     * 信任模式机括的宿主能力：与沙盒面板同一套语义（存储、记住的值、发言、连接器、播放、
     * 对白按钮状态、提示），只是直接以函数递给页面里跑的代码。
     */
    const trustedHost = useMemo<MixTrustedHost>(() => ({
        getState: () => getMixSession(sessionId)?.state ?? {},
        getStore: (materialId) => getMixSession(sessionId)?.mechanismStore?.[materialId] ?? {},
        setStore: (materialId, store) => handlePanelStore(materialId, store),
        setState: (patch) => handlePanelState(patch),
        say: (text) => { const t = text.trim().slice(0, 2000); if (t) handlePanelSay(t); },
        toast: (text) => { const t = text.trim().slice(0, 120); if (t) onToast(t); },
        mark: (materialId, id, state) => handlePanelMark(materialId, id, state),
        dialogueButton: (materialId, button) => handleDialogueButton(materialId, button),
        call: async (materialId, name, params) => {
            const material = getMixMaterial(materialId);
            const declared = material?.kind === "mechanism" ? material.connectors ?? [] : [];
            const key = name.trim().toLowerCase();
            if (!declared.includes(key)) throw new Error(`这件机括没有声明连接器「${key}」。`);
            const connector = findMixConnector(key);
            if (!connector) { const err = new Error(`本机还没有叫「${key}」的连接器，到酒柜的「连接器」里创建一个。`); (err as Error & { missing?: boolean }).missing = true; throw err; }
            const normalized = normalizeMixConnectorParams(params);
            if ("err" in normalized) throw new Error(normalized.err);
            if (!takeMixConnectorQuota(materialId)) throw new Error("调用太频繁：每件机括每分钟最多 30 次。");
            const result = await runMixConnector(connector, normalized.params);
            if (!result.ok) throw new Error(result.error);
            return { status: result.status, data: result.data };
        },
        play: (materialId, id, audio, type) => {
            const blob = audioToBlob(audio, type);
            if (!blob) { onToast("机括递上来的音频格式不对（要 data: URL、ArrayBuffer 或 Blob，24MB 以内）。"); return; }
            playMixAudio(blob, {
                onStart: () => { if (id) handlePanelMark(materialId, id, "playing"); },
                onEnd: () => { if (id) handlePanelMark(materialId, id, ""); },
                onError: (message) => { if (id) handlePanelMark(materialId, id, ""); onToast(message); },
            });
        },
        stop: () => stopMixAudio(),
        charName: () => getMixSession(sessionId)?.charName ?? "",
        userName: () => getMixSession(sessionId)?.userName || MIX_DEFAULT_USER_NAME,
    }), [sessionId, handlePanelStore, handlePanelState, handlePanelSay, handlePanelMark, onToast, handleDialogueButton]);

    // 进对局建实例（材料改过会重建），离开时收掉
    useEffect(() => {
        for (const material of trustedMechanisms) ensureMixTrusted(sessionId, material, trustedHost);
    }, [sessionId, trustedMechanisms, trustedHost]);
    useEffect(() => () => disposeMixTrusted(sessionId), [sessionId]);

    /** 给坑位组件的公共参数 */
    const trustedBase = session
        ? { state: session.state ?? {}, charName: session.charName, userName: session.userName || MIX_DEFAULT_USER_NAME }
        : null;


    // ── 剧情侧轨 / 溯源罗盘 ──
    /** 偏好：跟随落位档位、面板形态（并入侧栏 / 独立浮窗）、脱水开关与自定义套话词 */
    const [compassPrefs, setCompassPrefs] = useState<CompassPrefs>(() => readCompassPrefs());
    followRef.current = compassPrefs.follow;
    const patchPrefs = useCallback((patch: Partial<CompassPrefs>) => {
        setCompassPrefs((prev) => {
            const next = { ...prev, ...patch };
            writeCompassPrefs(next);
            return next;
        });
    }, []);
    const [compassOpen, setCompassOpen] = useState(false);
    /** 侧轨在坞里被再点一次时的临时收起 */
    const [railHidden, setRailHidden] = useState(false);
    /** 跳转落地要点亮的那一轮（蓝色呼吸外发光） */
    const [flashId, setFlashId] = useState<string | null>(null);
    const flashTimer = useRef(0);
    /** 目标还在懒加载收起区时，先记着，展开完再跳 */
    const pendingJumpRef = useRef<string | null>(null);
    /** 锁定 / 贴底模式下累计的未读条数 */
    const [newCount, setNewCount] = useState(0);
    const prevTurnCountRef = useRef(0);
    const prevBusyRef = useRef(false);

    /** 这一局的轮次清单：成对 + 脱水，只在轮次或脱水设置变化时重算 */
    const rounds = useMemo(
        () => pairMixRounds(session?.turns ?? [], compassPrefs.words, !compassPrefs.dewater),
        [session?.turns, compassPrefs.words, compassPrefs.dewater],
    );

    /** 受统一控制坞驱动：坞里点「剧情侧轨 / 溯源罗盘」时切换自身显隐 */
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control === "mix-story-rail") setRailHidden((v) => !v);
            else if (detail?.control === "mix-story-compass") setCompassOpen((v) => !v);
            else if (detail?.control === "mix-token") setTokenUserHidden((v) => !v);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    /**
     * 锁定 / 贴底时，新内容是不声不响地来的：别让它悄没声漏掉，攒个数字挂在侧轨底部。
     * 跟随档位下永远不需要这个提示，直接清零。
     */
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const count = session?.turns.length ?? 0;
        const prev = prevTurnCountRef.current;
        prevTurnCountRef.current = count;
        const busyStarted = busy && !prevBusyRef.current;
        prevBusyRef.current = busy;
        if (followRef.current === "always") { setNewCount(0); return; }
        if (count <= prev && !busyStarted) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 60) setNewCount((n) => n + Math.max(1, count - prev));
        else setNewCount(0);
    }, [session?.turns.length, busy]);

    /** 视觉落点聚光灯：给目标那一轮打一枚 1.6 秒的蓝色呼吸外发光，提示「你找的剧情在这里」 */
    const flashTurn = useCallback((turnId: string) => {
        setFlashId(turnId);
        if (flashTimer.current) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashId(null), 1600);
    }, []);
    useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);

    /** 平滑电梯：把某一轮滑到视口顶部 */
    const scrollToTurn = useCallback((turnId: string) => {
        const el = scrollRef.current;
        if (!el) return;
        const node = el.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
        if (!node) return;
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        // 玩家亲手挪过的：先松开跟底，免得内容一长高就被拽回去。
        // 「跟随」档是玩家自己选的，那种情况下保留原落点，让它照旧追最新。
        if (followRef.current !== "always") stickRef.current = "free";
        el.scrollTo({ top: Math.max(0, top - 10), behavior: "smooth" });
        flashTurn(turnId);
    }, [flashTurn]);

    /**
     * 点罗盘/侧轨上的某一轮：面板先收，再把视口像电梯一样滑到那一轮。
     *
     * 目标不在已经渲染出来的这一截里时，**不再从目标一路铺到最新**，而是把窗口整体搬到目标那儿
     * （目标前留 MIX_JUMP_LEAD_TURNS 条、总共 MIX_JUMP_WINDOW_TURNS 条），
     * 下面没渲染的那一截记进 tailHiddenCount，由底部的「查看更新的」按批放开。
     * 以前这里只收头不收尾（setHiddenTurnCount(startIndex - 2) 之后尾巴全放开），
     * 126 条那一局从第 1 轮跳一下就是 126 行 + 68 个沙盒 iframe。
     */
    const jumpToRound = useCallback((round: CompassRound) => {
        const targetId = compassAnchorId(round);
        if (!targetId) return;
        setCompassOpen(false);
        if (round.startIndex >= hiddenTurnCount && round.startIndex < turnCount - tailHiddenCount) {
            // 就在渲染出来的这一截里：这是玩家亲手点的移动，不受跟随档位限制
            window.requestAnimationFrame(() => scrollToTurn(targetId));
            return;
        }
        // 撤离跟底，否则 layouteffect 会立刻把窗口收回去
        stickRef.current = "free";
        pendingJumpRef.current = targetId;
        const windowStart = Math.max(0, round.startIndex - MIX_JUMP_LEAD_TURNS);
        setHiddenTurnCount(windowStart);
        setTailHiddenCount(Math.max(0, turnCount - Math.min(turnCount, windowStart + MIX_JUMP_WINDOW_TURNS)));
    }, [hiddenTurnCount, tailHiddenCount, turnCount, scrollToTurn]);

    /** 往下续读：放开下面那一截被收起的新内容。新内容只长在视口下面，不用钉锚点 */
    const loadNewerTurns = useCallback(() => {
        setTailHiddenCount((count) => Math.max(0, count - MIX_LOAD_MORE_TURNS));
    }, []);

    /** 展开懒加载后，等 DOM 与沙盒高度落定，再把挂着的跳转落下 */
    useEffect(() => {
        const targetId = pendingJumpRef.current;
        if (!targetId) return;
        const timer = window.setTimeout(() => {
            pendingJumpRef.current = null;
            scrollToTurn(targetId);
        }, 260);
        return () => window.clearTimeout(timer);
    }, [hiddenTurnCount, tailHiddenCount, rounds.length, scrollToTurn]);

    /**
     * 滑回最新。跳旧剧情留下的那一截"尾部收起"要先放开——但**窗口整体搬到末尾**：
     * 只把 tail 清 0 而不动 head，等于把从旧剧情一直到最新的全部内容一次渲出来
     * （实测 415 轮那一局这么干会渲 415 行、2034ms 长任务）。
     * 落点等 DOM 真长出来再钉一次（直接对旧 scrollHeight 平滑滚动会停在半路）。
     */
    const toLatestRef = useRef(false);
    const scrollToLatest = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setNewCount(0);
        if (tailHiddenCount > 0) {
            toLatestRef.current = true;
            stickRef.current = "bottom";
            setTailHiddenCount(0);
            setHiddenTurnCount(Math.max(0, turnCount - MIX_INITIAL_TURNS));
            return;
        }
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }, [tailHiddenCount, turnCount]);
    useLayoutEffect(() => {
        if (!toLatestRef.current) return;
        toLatestRef.current = false;
        applyStick(true);
    }, [tailHiddenCount, applyStick]);

    /**
     * 罗盘里要标出"你正看着第几轮"。面板关着时不必算（那要跟着滚动逐帧刷），
     * 只在它开着的那段时间里跟一下。
     */
    const [activeRoundIndex, setActiveRoundIndex] = useState<number | undefined>(undefined);
    useEffect(() => {
        if (!compassOpen) return;
        const el = scrollRef.current;
        if (!el) return;
        const compute = () => {
            if (!rounds.length) return;
            const line = el.scrollTop + el.clientHeight * 0.34;
            const base = el.getBoundingClientRect().top;
            let picked = rounds[0].startIndex;
            for (const round of rounds) {
                const id = compassAnchorId(round);
                if (!id) continue;
                const node = el.querySelector<HTMLElement>(`[data-turn-id="${id}"]`);
                if (!node) continue;
                const top = node.getBoundingClientRect().top - base + el.scrollTop;
                if (top <= line) picked = round.startIndex;
            }
            setActiveRoundIndex(picked);
        };
        let raf = 0;
        const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; compute(); }); };
        compute();
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            if (raf) cancelAnimationFrame(raf);
            el.removeEventListener("scroll", onScroll);
        };
    }, [compassOpen, rounds, scrollRef]);

    if (!session) {
        return (
            <div className="mix-game">
                <div className="mix-game-header">
                    <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                    <div className="mix-game-title">对局不存在</div>
                    <span style={{ width: 32 }} />
                </div>
            </div>
        );
    }

    const run = (action: (signal: AbortSignal, commit: () => void, onDelta: (chunk: string) => void) => Promise<unknown>) => {
        if (busy) return;
        // 生成是异步的：期间用户可能已切去别的对局（组件复用、sessionId 变了），
        // 过期的 commit 必须沉默，否则会把旧对局数据刷进正在显示的新对局
        const commit = () => {
            if (sessionIdRef.current !== sessionId) return;
            setSession(getMixSession(sessionId));
        };
        enqueueMixGeneration(sessionId, async (signal, onDelta) => {
            try {
                await action(signal, commit, onDelta);
                // 生成成功后主动刷新一次：确保新回合立刻上屏，
                // 不依赖 useEffect 检测 genStatus 变化（流式收尾与状态切换之间可能有延迟，
                // 且极端情况下 useSyncExternalStore 的派生值读取可能落后一拍）。
                commit();
            } catch (error) {
                commit();
                const message = error instanceof Error ? error.message : "生成失败，请重试。";
                if (!signal.aborted) onToast(message);
                throw error; // 重新抛出让 runtime 知道出错了
            }
        });
        // 立即 commit 一次：重说/回溯等操作在第一个 await 之前就落库了
        commit();
    };

    /**
     * 缓冲发送区接一棒：队首那条此刻开口。
     * runtime 里还有任何状态的条目（generating/queued/done/error 残留）都不接 ——
     * done 残留期 enqueue 会被静默忽略，消息弹出来却没发就走，宁可交给下一次迁移。
     */
    const pumpPending = () => {
        if (getMixSessionGenStatus(sessionId)) return;
        if (isMixPendingPaused(sessionId)) return;
        const next = takeMixPending(sessionId);
        if (!next) return;
        stickRef.current = "bottom";
        run((signal, commit, onDelta) => generateMixReply(sessionId, next.text, signal, commit, onDelta));
    };
    pumpPendingRef.current = pumpPending;

    const handleSend = () => {
        const text = input.trim();
        if (!text) return;
        setInput("");
        // 调制中不拦笔：这句先进缓冲发送区，出杯后按序自动接话
        if (busy) {
            if (!pushMixPending(sessionId, text)) onToast(`缓冲发送区最多排 ${MIX_PENDING_MAX} 条，先处理一批再写。`);
            return;
        }
        // 一开口就把落点钉到底：用户那一轮要等落杯前钩子跑完才落库，
        // 这中间界面还是「没人开过口」的样子，不钉住就会被拽回扉页顶上
        stickRef.current = "bottom";
        run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    };

    sayRef.current = (text: string) => {
        // 机括开口和输入框同一套规矩：调制中转进缓冲，出杯后轮到它
        if (busy) {
            if (!pushMixPending(sessionId, text)) onToast(`缓冲发送区最多排 ${MIX_PENDING_MAX} 条，先处理一批再写。`);
            return;
        }
        stickRef.current = "bottom";
        run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    };

    const copyTurn = (turn: MixTurn) => {
        const done = () => onToast("已复制");
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(turn.text).then(done, () => onToast("复制失败"));
            return;
        }
        const ta = document.createElement("textarea");
        ta.value = turn.text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch { onToast("复制失败"); }
        document.body.removeChild(ta);
    };

    const laterCount = (turnId: string) => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        return idx < 0 ? 0 : session.turns.length - idx - 1;
    };

    /**
     * 回溯到某一轮时机括能退到什么程度：
     * exact = 那一轮留着快照，精确退回；oldest = 比保留窗口还早，只能退到现存最早的那份；
     * none = 一份快照都没有（更新前的老对局），机括不动。
     * 后两种要在弹窗里说明白，别让玩家以为机括也跟着回到了当时。
     */
    const mechanismRewindKind = (turnId: string): "exact" | "oldest" | "none" => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        if (idx < 0) return "exact";
        if (session.turns.slice(0, idx + 1).some((t) => t.mechanismStore)) return "exact";
        return session.turns.some((t) => t.mechanismStore) ? "oldest" : "none";
    };

    /** 本局有没有机括：没有就别拿这段说明打扰玩家 */
    const hasMechanism = () => mixSlotEntries(session.recipe.slots, "mechanism")
        .some((e) => getMixMaterial(e.materialId)?.kind === "mechanism");

    const mechanismRewindHint = (turnId: string) => {
        if (!hasMechanism()) return null;
        const kind = mechanismRewindKind(turnId);
        if (kind === "exact") return null;
        return (
            <>
                <br />
                {kind === "oldest"
                    ? `机括存档仅保留最近 ${MIX_STORE_SNAPSHOT_TURNS} 轮，此轮已超出，机括数据将回退至现存最早的存档。`
                    : "此轮无机括存档，机括数据不会回退。"}
            </>
        );
    };

    /**
     * 保存这一条编辑会不会连带删掉后文。
     * 玩家发言：后面的回复是冲着旧发言写的，要删掉重新生成。
     * 角色回复：后面每一轮都能按原文重画时一条不删；重画不了才截断
     *（它们的记住的值与机括存储都是从这一轮累积算出来的，重算不了就只能作废）。
     */
    const editWillTruncate = (turnId: string) => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        if (idx < 0 || idx === session.turns.length - 1) return false;
        if (session.turns[idx].role === "user") return true;
        return !canReplayMixFrom(session, idx);
    };

    const doRewind = (turnId: string) => {
        try {
            truncateMixAfterTurn(sessionId, turnId);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "回溯失败");
        }
    };

    const saveEdit = () => {
        if (!editing) return;
        const target = session.turns.find((t) => t.id === editing.id);
        setEditing(null);
        try {
            editMixTurn(sessionId, editing.id, editing.draft);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "保存失败");
            return;
        }
        // 编辑的是玩家发言：直接续生成新回复；编辑角色回复则到此为止
        if (target?.role === "user") {
            void run((signal, _commit, onDelta) => regenerateMixTail(sessionId, signal, onDelta));
            return;
        }
        // 编辑的是角色回复且本局带钩子机括：把新原文交给机括重新收数，不问、不弹窗。
        // 机括的标记行只有它自己的钩子认得，不重跑就会留在正文里裸奔；而"要不要重跑"
        // 从来不是玩家该决定的事——编辑完就该是编辑后的样子。
        // 回滚基准由引擎自己找（前一轮的快照），这里不做判断。
        if (target?.role === "assistant") doEditSync(editing.id);
    };

    const doEditSync = (turnId: string) => {
        void runMixEditSync(sessionId, turnId).then((mode) => {
            setSession(getMixSession(sessionId));
            // 追加要说一声：这一轮太旧、快照已不在，机括那儿会被记成两笔
            onToast(mode === "replayed" ? "已按编辑后的内容重跑这一轮及之后各轮。"
                : mode === "appended" ? "已重跑这一轮（这一轮太旧，重画不了后文，已截断）。"
                : "重跑失败，这一轮没有变化。");
        });
    };

    /**
     * 换料：改本局方案快照的槽位，下一轮装配时生效。
     * 生效条件仍然只在吧台改方案时设置，这里只管加进去和拿出来。
     */
    /**
     * 换装前给历史轮盖戳。小票/小剧场是「每轮存原文 + 渲染代码现取」，局中换件后
     * 新代码解析不了旧格式的原文——所以在换装这一刻，把还没盖过戳的旧轮标上
     * 现役件的 id，并把它的渲染皮快照进对局档案（retiredRender）。此后这些轮
     * 永远按当时的皮回放，旧件从酒柜删掉也不受影响；新轮不盖戳、跟当前件走。
     * 原地编辑材料不经过这里，「同一件改版全局换皮」的特性保留。
     */
    const stampRetiringSkin = (base: MixSession, kind: "ticket" | "encore"): MixSession => {
        const { entries } = resolveMixRecipeMaterials(base.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(base));
        const mats = (active[kind] ?? []).filter((m) => m.kind === kind);
        if (!mats.length) return base;
        // 老格式的轮（单块无归属、没盖过戳）这一刻盖上第一件的戳；多块格式的轮块自带归属，不用戳
        const first = mats[0];
        let touched = false;
        const turns = base.turns.map((t) => {
            if (t.role !== "assistant") return t;
            if (kind === "ticket") {
                if (t.ticketRaws?.length || !t.ticketRaw || t.ticketId) return t;
                touched = true;
                return { ...t, ticketId: first.id };
            }
            if (t.encoreRaws?.length || !t.encoreRaw || t.encoreId) return t;
            touched = true;
            return { ...t, encoreId: first.id };
        });
        // 只快照真被历史轮引用的件的皮——谁退役谁的旧轮都得有皮可回放，没被引用的不占档案
        const referenced = new Set<string>();
        for (const t of turns) {
            if (t.role !== "assistant") continue;
            const blocks = kind === "ticket" ? mixTurnTicketBlocks(t) : mixTurnEncoreBlocks(t);
            for (const block of blocks) {
                if (block.id) referenced.add(block.id);
            }
        }
        const retired: Record<string, string> = { ...base.retiredRender };
        let snapped = false;
        for (const mat of mats) {
            if (!referenced.has(mat.id)) continue;
            const html = kind === "ticket"
                ? (mat.kind === "ticket" ? mat.renderHtml?.trim() ?? "" : "")
                : (mat.kind === "encore" && mat.contract?.trim() ? mixEncoreRenderHtml(mat).trim() : "");
            if (!html) continue;
            retired[mat.id] = html;
            snapped = true;
        }
        if (!touched && !snapped) return base;
        return { ...base, turns: touched ? turns : base.turns, retiredRender: snapped ? retired : base.retiredRender };
    };

    /** 写回槽位；next 为空就把这一格清掉 */
    const writeSlot = (kind: MixMaterialKind, next: MixSlotEntry[]) => {
        const base = kind === "ticket" || kind === "encore" ? stampRetiringSkin(session, kind) : session;
        const slots = { ...base.recipe.slots };
        if (next.length) slots[kind] = next;
        else delete slots[kind];
        const updated: MixSession = { ...base, recipe: { ...base.recipe, slots }, updatedAt: Date.now() };
        saveMixSession(updated);
        setSession(getMixSession(sessionId));
    };

    /** 局内换材料：和吧台一样是「加进去 / 拿出来」，不是整格替换，免得一点就把叠好的几件压成一件 */
    const toggleSlotItem = (kind: MixMaterialKind, materialId: string) => {
        const entries = mixSlotEntries(session.recipe.slots, kind);
        const at = entries.findIndex((e) => e.materialId === materialId);
        if (at >= 0) {
            writeSlot(kind, entries.filter((_, i) => i !== at));
            onToast("已移出，下一轮生效。");
            return;
        }
        // 追加在末尾：叠放是按顺序依次生效的，新加的排在已有的后面
        writeSlot(kind, [...entries, { materialId }]);
        onToast("已加入，下一轮生效。");
    };

    const clearSlot = (kind: MixMaterialKind) => {
        writeSlot(kind, []);
        setSlotPick(null);
        onToast("已清空这一格，下一轮生效。");
    };

    // 本局小票里勾了「记住」的项：叠层编辑器里变量条件的可选项。
    // 每次渲染现算——小票就几件，比为它多背一个 memo 依赖划算
    const slotVarNames: string[] = [];
    for (const entry of mixSlotEntries(session.recipe.slots, "ticket")) {
        const mat = getMixMaterial(entry.materialId);
        if (mat?.kind !== "ticket") continue;
        for (const item of mat.vars ?? []) {
            const name = item.name.trim();
            if (name && !slotVarNames.includes(name)) slotVarNames.push(name);
        }
    }

    /**
     * 按块取皮：块的供稿材料还在场就用它现在的皮（原地改版全局换皮的特性保留）；
     * 不在场了优先用对局档案里的退役快照，档案缺失（老数据）再找酒柜里同 id 的
     * 材料，都没有才退回这一格现役第一件的皮。没归属的块直接用第一件。
     */
    const blockSkin = (
        kind: "ticket" | "encore",
        id: string | undefined,
        actives: { id: string; html: string }[],
    ): string | undefined => {
        const fallback = actives[0]?.html;
        if (!id) return fallback;
        const live = actives.find((a) => a.id === id);
        if (live) return live.html;
        const archived = session.retiredRender?.[id];
        if (archived) return archived;
        const mat = getMixMaterial(id);
        if (kind === "ticket" && mat?.kind === "ticket") {
            // 材料还在但明说没皮（契约型无渲染）：这块不上屏，不硬套别件的皮
            return mat.renderHtml?.trim() ? mat.renderHtml : undefined;
        }
        if (kind === "encore" && mat?.kind === "encore") {
            const html = mixEncoreRenderHtml(mat).trim();
            return html || undefined;
        }
        // 材料已删又没快照的老轮：退回第一件的皮，至少有得看
        return fallback;
    };
    const turnTicketFrames = (turn: MixTurn): TurnFrame[] =>
        mixTurnTicketBlocks(turn)
            .map((block, i) => ({ key: `t${i}`, html: blockSkin("ticket", block.id, assets.tickets) ?? "", raw: block.raw }))
            .filter((f) => f.html && f.raw);
    const turnEncoreFrames = (turn: MixTurn): TurnFrame[] =>
        mixTurnEncoreBlocks(turn)
            .map((block, i) => ({ key: `e${i}`, html: blockSkin("encore", block.id, assets.aiEncores) ?? "", raw: block.raw }))
            .filter((f) => f.html && f.raw);

    const lastTurn = session.turns[session.turns.length - 1];
    const canReroll = !busy && lastTurn?.role === "assistant" && session.turns.length > 1;

    /** 背景观感微调：蒙版提亮（0=原样，100=无蒙版）与封面模糊，按局保存 */
    const [bgTuneOpen, setBgTuneOpen] = useState(false);
    const bgTune = session.bgTune ?? { mask: 0, blur: 0 };
    const setBgTune = (next: { mask: number; blur: number }) => {
        const updated: MixSession = { ...session, bgTune: next };
        saveMixSession(updated);
        setSession(updated);
    };
    const bgStyle: CSSProperties & Record<string, string> = {
        ...(assets.cover ? { backgroundImage: `url(${assets.cover})` } : {}),
        "--mix-bg-mask": String(Math.max(0, 1 - bgTune.mask / 100)),
        // 负亮度 = 蒙版全开之外再压一层匀黑（-40 → 0.4），比默认三段蒙版更暗
        "--mix-bg-dim": String(Math.max(0, -bgTune.mask) / 100),
        "--mix-bg-blur": `${bgTune.blur}px`,
    };

    // —— 字数浮标（特调对局内显示 AI 已生成字数）——
    // 渲染在 .mix-garnish-scope 作用域之外（.mix-game 的兄弟节点），外观装饰 CSS 作用域够不到，
    // 不会被隐藏/改色/遮挡。位置/大小/模式都存 localStorage，拖拽缩放后下次还在。
    const WC_KEY = "mix-wc-ui";
    const [wcMode, setWcMode] = useState<"total" | "perRound">(() => {
        try {
            const raw = localStorage.getItem(WC_KEY);
            const m = raw ? JSON.parse(raw).mode : null;
            return m === "perRound" ? "perRound" : "total";
        } catch {
            return "total";
        }
    });
    const [wcPos, setWcPos] = useState<{ x: number; y: number } | null>(() => {
        try {
            const raw = localStorage.getItem(WC_KEY);
            const p = raw ? JSON.parse(raw).pos : null;
            return p && typeof p.x === "number" ? p : null;
        } catch {
            return null;
        }
    });
    // 整体缩放系数（含字体）：0.5 ~ 2.5。所有尺寸在 CSS 里用 calc(*var(--wc-scale)) 呈现，
    // 因此拖动缩放手柄时整个浮标（含字号、内边距、圆角、列表高度）会等比放大缩小。
    const [wcScale, setWcScale] = useState<number>(() => {
        try {
            const raw = localStorage.getItem(WC_KEY);
            const s = raw ? JSON.parse(raw).scale : null;
            return typeof s === "number" && s >= 0.5 && s <= 2.5 ? s : 1;
        } catch {
            return 1;
        }
    });
    const [wcPop, setWcPop] = useState(false);
    const wcRef = useRef<HTMLDivElement>(null);

    // 字数浮标 / 剧情侧轨 / 溯源罗盘吃"可使用"这一维：停用 = 界面上彻底不出现；
    // 只关"常驻显示" = 浮标照常，坞条不再占位，入口收进坞底「更多」。
    // 这里必须走订阅态而不是 isControlEnabled()，否则开关变化时浮标显隐不会实时刷新
    const controlDockState = useSyncExternalStore(subscribeControlDockState, getControlDockState, getControlDockState);
    const wcEnabled = controlDockState.enabled["mix-word-count"] !== false;
    // 侧轨与罗盘同样只关可用时才消失，不会退回自由悬浮
    const showRail = controlDockState.enabled["mix-story-rail"] !== false && !railHidden;
    const compassAllowed = controlDockState.enabled["mix-story-compass"] !== false;
    // Token 用量显示（顶栏余额胶囊的 extra）同样吃"可使用"这一维：关掉 = 不显示 token 读数
    const tokenEnabled = controlDockState.enabled["mix-token"] !== false;
    const [wcUserHidden, setWcUserHidden] = useState(false);
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== "mix-word-count") return;
            setWcUserHidden(prev => !prev);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    // Token 用量显示：坞按钮点一下切换显隐（与字数浮标一致），但前提是"可使用"开着
    const [tokenUserHidden, setTokenUserHidden] = useState(false);
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== "mix-token") return;
            setTokenUserHidden(prev => !prev);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    const persistWc = (next: Record<string, unknown>) => {
        try {
            const cur = JSON.parse(localStorage.getItem(WC_KEY) || "{}");
            localStorage.setItem(WC_KEY, JSON.stringify({ ...cur, ...next }));
        } catch {
            /* localStorage 不可用时静默忽略 */
        }
    };

    const wcAssistant = session.turns.filter((t) => t.role === "assistant");
    const wcTotal = wcAssistant.reduce((sum, t) => sum + (t.text?.length || 0), 0);
    const wcRounds = wcAssistant.map((t, i) => ({ round: i + 1, chars: t.text?.length || 0 }));
    const wcCurrent = wcRounds.length ? wcRounds[wcRounds.length - 1].chars : 0;

    // 本局 token 用量（来自大模型 API 返回的 usage；部分中转不回传 usage 时只统计有数据的轮）。
    // 关键：每一轮的 prompt_tokens 本身就含「整段历史上下文」，若把各轮 prompt_tokens 求和，
    // 重叠的历史会被重复累加，得到一个虚高的「合并」数字。因此：
    //   - 进 = 当前上下文大小 = 最近一次 assistant 调用的 prompt_tokens（此刻再发一句话模型要读多少 token）
    //   - 出 = 累计生成 = 各轮 completion_tokens 之和（每轮回覆互不重叠，可直接相加）
    const lastUsageTurn = [...session.turns].reverse().find(
        (t) => t.role === "assistant" && t.usage,
    );
    const tokenTotals = session.turns.reduce(
        (acc, t) => {
            if (t.role === "assistant" && t.usage) {
                acc.out += t.usage.completion_tokens ?? 0;
            }
            return acc;
        },
        { in: lastUsageTurn?.usage?.prompt_tokens ?? 0, out: 0, total: 0 },
    );
    const tokenHasData = session.turns.some((t) => t.role === "assistant" && t.usage);

    const onWcDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = wcRef.current;
        if (!el) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = el.offsetLeft;
        const startTop = el.offsetTop;
        const move = (ev: PointerEvent) => {
            setWcPos({ x: Math.max(0, startLeft + (ev.clientX - startX)), y: Math.max(0, startTop + (ev.clientY - startY)) });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (el) persistWc({ pos: { x: el.offsetLeft, y: el.offsetTop } });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const onWcResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startScale = wcScale;
        // 向右拖动放大，向左缩小；每拖动 160px 改变 1.0 倍，限制在 0.5~2.5
        const toScale = (clientX: number) =>
            Math.min(2.5, Math.max(0.5, startScale + (clientX - startX) / 160));
        const move = (ev: PointerEvent) => {
            setWcScale(toScale(ev.clientX));
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            persistWc({ scale: toScale(ev.clientX) });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const onWcMode = (m: "total" | "perRound") => {
        setWcMode(m);
        persistWc({ mode: m });
        setWcPop(false);
    };

    return (
        <>
            <MixModelBadge />
            {wcEnabled && !wcUserHidden && (
            <div
                className="mix-word-count-badge"
                id="mix-word-count-badge"
                ref={wcRef}
                style={{
                    ...(wcPos ? { left: wcPos.x, top: wcPos.y, right: "auto", bottom: "auto" } : {}),
                    "--wc-scale": wcScale,
                } as CSSProperties}
            >
                <div className="mix-wc-head" onPointerDown={onWcDragStart}>
                    <span className="mix-wc-title">字数统计</span>
                    <button
                        type="button"
                        className="mix-wc-gear"
                        aria-label="显示设置"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setWcPop((v) => !v)}
                    >
                        ⚙
                    </button>
                </div>
                <div className="mix-wc-body">
                    {wcMode === "total" ? (
                        <>
                            <div className="mix-wc-line mix-wc-total">
                                <span>已生成</span>
                                <span>{wcTotal.toLocaleString()} 字</span>
                            </div>
                            <div className="mix-wc-line">
                                <span>本轮</span>
                                <span>{wcCurrent.toLocaleString()} 字</span>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="mix-wc-line mix-wc-total">
                                <span>总计</span>
                                <span>{wcTotal.toLocaleString()} 字</span>
                            </div>
                            <ul className="mix-wc-list">
                                {wcRounds.length === 0 ? (
                                    <li>
                                        <span>暂无生成</span>
                                        <span>0 字</span>
                                    </li>
                                ) : (
                                    wcRounds.map((r) => (
                                        <li key={r.round}>
                                            <span>第{r.round}轮</span>
                                            <span>{r.chars.toLocaleString()} 字</span>
                                        </li>
                                    ))
                                )}
                            </ul>
                        </>
                    )}
                </div>
                {wcPop ? (
                    <div className="mix-wc-pop">
                        <label>
                            <input type="radio" name="wcmode" checked={wcMode === "total"} onChange={() => onWcMode("total")} />
                            总生成字数
                        </label>
                        <label>
                            <input type="radio" name="wcmode" checked={wcMode === "perRound"} onChange={() => onWcMode("perRound")} />
                            每轮对话生成
                        </label>
                    </div>
                ) : null}
                <div className="mix-wc-resize" onPointerDown={onWcResizeStart} />
            </div>
            )}
            <div className="mix-game mix-garnish-scope" style={stateCssVars}>
            {/* 装饰是可分享材料里唯一直接进主文档的代码，注入前先收口到本画面 */}
            {assets.garnishCss ? <style>{scopeMixCss(assets.garnishCss)}</style> : null}
            <div className="mix-game-bg" style={bgStyle} />
            <div className="mix-game-header">
                <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                <div className="mix-game-title">{session.name?.trim() || session.charName}</div>
                <MixBalanceChip
                    className="mix-game-token"
                    accountId={mixAccount.id || undefined}
                    baseline={mixAccount.baseline}
                    extra={tokenEnabled && !tokenUserHidden && tokenHasData ? `ctx ${tokenTotals.in} · 生成 ${tokenTotals.out}` : undefined}
                    onClick={() => setAccountOpen(true)}
                    title={tokenEnabled && !tokenUserHidden && tokenHasData
                        ? `当前上下文 ≈ ${tokenTotals.in} token（最近一次调用的输入，不再把各轮历史重复累加）· 累计生成 ≈ ${tokenTotals.out} token`
                        : "点开看余额明细"}
                />
                {slotGroups.header.map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button type="button" className="mix-icon-btn" onClick={() => setBgTuneOpen((v) => !v)} aria-label="背景观感" title="背景观感">
                    <Sun size={19} />
                </button>
                <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(true)} disabled={busy} aria-label="修改方案" title="修改方案">
                    <MoreHorizontal size={20} />
                </button>
            </div>
            {bgTuneOpen ? (
                <>
                    <div className="mix-bgtune-mask" onClick={() => setBgTuneOpen(false)} />
                    <div className="mix-bgtune">
                        <label className="mix-bgtune-row">
                            <span>蒙版亮度</span>
                            <input
                                type="range"
                                min={-40}
                                max={100}
                                step={1}
                                value={bgTune.mask}
                                onChange={(e) => setBgTune({ ...bgTune, mask: Number(e.target.value) })}
                            />
                        </label>
                        <label className="mix-bgtune-row">
                            <span>背景模糊</span>
                            <input
                                type="range"
                                min={0}
                                max={20}
                                step={1}
                                value={bgTune.blur}
                                onChange={(e) => setBgTune({ ...bgTune, blur: Number(e.target.value) })}
                            />
                        </label>
                        <button type="button" className="mix-bgtune-reset" onClick={() => setBgTune({ mask: 0, blur: 0 })}>恢复默认</button>
                    </div>
                </>
            ) : null}
            <StateBar state={session.state ?? {}} />
            {!panelsHidden && slotGroups.header.some(({ material }) => dockOpen[material.id]) ? (
                <div className="mix-dock-drop" data-from="header">
                    {slotGroups.header.filter(({ material }) => dockOpen[material.id]).map(({ material, layout }) => (
                        <MixMechanismInline
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                        />
                    ))}
                </div>
            ) : null}
            {/* 滚动区 + 剧情侧轨 + 溯源罗盘：侧轨要贴着滚动区定位，所以另起一层相对定位的壳 */}
            <div className="mix-game-body" data-rail={showRail ? "true" : undefined}>
            <div
                className="mix-game-scroll"
                ref={scrollRef}
                data-entering={entering ? "true" : undefined}
                onScroll={handleScroll}
                onWheel={markGesture}
                onTouchStart={markGesture}
                onTouchMove={markGesture}
                onPointerDown={markGesture}
            >
                {assets.canvasHtml ? (
                    <div className="mix-game-canvas">
                        <MixRichText text={assets.canvasHtml} />
                    </div>
                ) : null}
                {slotGroups["flow-top"].map(({ material, layout }) => (
                    <div className="mix-flow-panel" data-at="top" key={material.id}>
                        <MixMechanismInline
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                        />
                    </div>
                ))}
                {hiddenTurnCount > 0 ? (
                    <button type="button" className="mix-load-more" onClick={loadMoreTurns}>
                        查看更早的 {Math.min(MIX_LOAD_MORE_TURNS, hiddenTurnCount)} 条 · 还有 {hiddenTurnCount} 条
                    </button>
                ) : null}
                {session.turns.slice(hiddenTurnCount, session.turns.length - tailHiddenCount).map((turn, offset) => {
                    const idx = hiddenTurnCount + offset;
                    const isLast = idx === session.turns.length - 1;
                    const actions = (
                        <TurnActions
                            align={turn.role === "user" ? "right" : "left"}
                            disabled={busy}
                            canRewind={!isLast}
                            onCopy={() => copyTurn(turn)}
                            onRewind={() => setConfirm({ type: "rewind", turnId: turn.id })}
                            onFork={() => setFork({ turnId: turn.id, idx })}
                            onEdit={() => setEditing({ id: turn.id, draft: mixTurnRawText(turn) })}
                            key={`act-${turn.id}`}
                        />
                    );
                    return turn.role === "user" ? (
                        <div className="mix-user-turn" data-with-actions="true" data-turn-id={turn.id} data-flash={flashId === turn.id ? "true" : undefined} key={turn.id}>
                            <div className="mix-user-bubble">{turn.text}</div>
                            {actions}
                        </div>
                    ) : (
                        <div className="mix-assistant-turn" key={turn.id} data-turn={turn.id} data-turn-id={turn.id} data-flash={flashId === turn.id ? "true" : undefined}>
                            <AssistantTurn turn={turn} ticketFrames={turnTicketFrames(turn)} encoreFrames={turnEncoreFrames(turn)} filterRules={assets.filterRules} state={turn.state} dialogue={dialogueFor(turn.id)} />
                            {turn.usage ? (
                                <div className="mix-turn-token" title="本轮真实 token 用量（来自大模型 API 返回的 usage）：进=上下文输入，出=本轮回覆">
                                    进 {turn.usage.prompt_tokens ?? "?"} · 出 {turn.usage.completion_tokens ?? "?"}{turn.usage.total_tokens ? ` · 共 ${turn.usage.total_tokens}` : ""}
                                </div>
                            ) : null}
                            {/* 信任模式机括的坑位：prose 拿这一轮的正文容器本身，turn 在正文下方给一块 */}
                            {trustedBase ? trustedMechanisms.map((material) => {
                                const shownText = applyMixFilterRules(turn.text, assets.filterRules, "display");
                                const store = session.mechanismStore?.[material.id] ?? {};
                                return (
                                    <div key={material.id} className="mix-trusted-turn">
                                        <MixTrustedSlot sessionId={sessionId} materialId={material.id} slot="prose" turnId={turn.id} text={shownText} index={idx} store={store} {...trustedBase}
                                            target={() => document.querySelector<HTMLElement>(`.mix-game [data-turn="${turn.id}"] .mix-prose`)} />
                                        <MixTrustedSlot sessionId={sessionId} materialId={material.id} slot="turn" turnId={turn.id} text={shownText} index={idx} store={store} {...trustedBase} />
                                    </div>
                                );
                            }) : null}
                            {actions}
                        </div>
                    );
                })}
                {tailHiddenCount > 0 ? (
                    <button type="button" className="mix-load-more" onClick={loadNewerTurns}>
                        查看更新的 {Math.min(MIX_LOAD_MORE_TURNS, tailHiddenCount)} 条 · 还有 {tailHiddenCount} 条
                    </button>
                ) : null}
                {busy ? (() => {
                    // 流式过程中同样过一遍「仅显示」滤网，写出来的样子和落库后一致
                    const shown = applyMixFilterRules(mixStreamText(live), assets.filterRules, "display");
                    return shown ? (
                        <div className="mix-live-turn">
                            <MixProseView text={shown} streaming />
                        </div>
                    ) : (
                        <div className="mix-game-thinking" aria-label="生成中">
                            <span /><span /><span />
                        </div>
                    );
                })() : null}
                {trustedBase ? trustedMechanisms.map((material) => (
                    <MixTrustedSlot key={`b-${material.id}`} sessionId={sessionId} materialId={material.id} slot="bottom" store={session.mechanismStore?.[material.id] ?? {}} {...trustedBase} className="mix-trusted-slot mix-flow-panel" />
                )) : null}
                {slotGroups["flow-bottom"].map(({ material, layout }) => (
                    <div className="mix-flow-panel" data-at="bottom" key={material.id}>
                        <MixMechanismInline
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                        />
                    </div>
                ))}
                {assets.encoreStatics.map((item) => (
                    <div className="mix-encore-inline" key={item.id}>
                        <MixRichText text={item.html} />
                    </div>
                ))}
            </div>
            {showRail ? (
                <MixStoryRail
                    scrollRef={scrollRef}
                    rounds={rounds}
                    measureKey={`${sessionId}|${turnCount}|${hiddenTurnCount}|${tailHiddenCount}|${busy}|${rounds.length}`}
                    hiddenCount={hiddenTurnCount}
                    newCount={newCount}
                    onOpenCompass={() => setCompassOpen((v) => !v)}
                    onJumpRound={jumpToRound}
                    onLoadMore={loadMoreTurns}
                    onToLatest={scrollToLatest}
                />
            ) : null}
            {compassAllowed && compassOpen ? (
                <MixStoryCompass
                    rounds={rounds}
                    open
                    mode={compassPrefs.mode}
                    follow={compassPrefs.follow}
                    dewater={compassPrefs.dewater}
                    words={compassPrefs.words}
                    activeIndex={activeRoundIndex}
                    busy={busy}
                    charName={session.charName}
                    onClose={() => setCompassOpen(false)}
                    onMode={(mode) => patchPrefs({ mode })}
                    onFollow={(follow) => { followRef.current = follow; patchPrefs({ follow }); }}
                    onDewater={(dewater) => patchPrefs({ dewater })}
                    onWords={(words) => patchPrefs({ words })}
                    onJump={jumpToRound}
                />
            ) : null}
            </div>
            {/* 无界面的机括：沙盒照常挂着、照常收对白事件，只是什么都不画 */}
            {slotGroups.hidden.length ? (
                <div hidden aria-hidden="true">
                    {slotGroups.hidden.map(({ material }) => (
                        <MixMechanismInline
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                        />
                    ))}
                </div>
            ) : null}
            {trustedBase && trustedMechanisms.length && !panelsHidden ? (
                <div className="mix-panel-layer" data-trusted="true">
                    {trustedMechanisms.map((material) => (
                        <MixTrustedSlot key={`f-${material.id}`} sessionId={sessionId} materialId={material.id} slot="float" store={session.mechanismStore?.[material.id] ?? {}} {...trustedBase} className="mix-trusted-float" />
                    ))}
                </div>
            ) : null}
            {slotGroups.float.length && !panelsHidden ? (
                <div className="mix-panel-layer">
                    {slotGroups.float.map(({ material, layout }) => (
                        <MixMechanismPanel
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            layout={layout}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                            onBox={handlePanelBox}
                        />
                    ))}
                </div>
            ) : null}
            {!panelsHidden && [...slotGroups["inputbar-left"], ...slotGroups["inputbar-right"]].some(({ material }) => dockOpen[material.id]) ? (
                <div className="mix-dock-drop" data-from="input">
                    {[...slotGroups["inputbar-left"], ...slotGroups["inputbar-right"]].filter(({ material }) => dockOpen[material.id]).map(({ material, layout }) => (
                        <MixMechanismInline
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            connectors={material.connectors}
                            onMark={handlePanelMark}
                            onDialogueButton={handleDialogueButton}
                            onToast={onToast}
                        />
                    ))}
                </div>
            ) : null}
            {/* 缓冲发送区：调制中写好的后续剧情在这里排队，出杯一条接一条 */}
            {pendingQueue.length ? (
                <div className="mix-pending-bar">
                    <div className="mix-pending-head">
                        <span className="mix-pending-title">缓冲发送区 · {pendingQueue.length} 条</span>
                        <span className="mix-pending-hint">
                            {pendingPaused
                                ? "上一拍生成未正常完成，自动接话已暂停"
                                : busy
                                    ? "出杯后逐条自动发送"
                                    : "待发"}
                        </span>
                        <span className="mix-pending-ops">
                            {!busy ? (
                                <button type="button" className="mix-pending-btn" onClick={() => { setMixPendingPaused(sessionId, false); pumpPending(); }}>
                                    {pendingPaused ? "继续发送" : "立即发送"}
                                </button>
                            ) : null}
                            <button type="button" className="mix-pending-btn" onClick={() => clearMixPending(sessionId)}>清空</button>
                        </span>
                    </div>
                    <div className="mix-pending-list">
                        {pendingQueue.map((item, i) => (
                            <div className="mix-pending-item" key={item.id}>
                                <span className="mix-pending-idx">{i + 1}</span>
                                <span className="mix-pending-text">{item.text}</span>
                                <button
                                    type="button"
                                    className="mix-icon-btn mix-pending-act"
                                    aria-label="取回编辑"
                                    title="取回编辑"
                                    onClick={() => {
                                        removeMixPending(sessionId, item.id);
                                        setInput((prev) => (prev ? `${prev}\n${item.text}` : item.text));
                                    }}
                                >
                                    <Pencil size={13} />
                                </button>
                                <button
                                    type="button"
                                    className="mix-icon-btn mix-pending-act"
                                    aria-label="删除这条"
                                    title="删除这条"
                                    onClick={() => removeMixPending(sessionId, item.id)}
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
            <div className="mix-game-inputbar">
                {slotGroups["inputbar-left"].map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => rerollMixReply(sessionId, signal, onDelta))}
                    disabled={!canReroll}
                    aria-label="重说"
                    title="重说"
                >
                    <RotateCcw size={18} />
                </button>
                <textarea
                    className="mix-game-input"
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder={busy
                        ? (pendingQueue.length ? `调制中…已排 ${pendingQueue.length} 条，继续写接着排` : "调制中…现在写的会进缓冲发送区")
                        : "说点什么…"}
                />
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => continueMix(sessionId, signal, onDelta))}
                    disabled={busy}
                    aria-label="继续生成"
                    title="继续生成"
                >
                    <WandSparkles size={18} />
                </button>
                {slotGroups["inputbar-right"].map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button type="button" className="mix-send-btn" onClick={handleSend} disabled={!input.trim()} aria-label={busy ? "加入缓冲发送区" : "发送"}>
                    <Send size={16} />
                </button>
            </div>

            {/* 修改方案：换本局的槽位材料 */}
            {recipeOpen ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">修改方案</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(false)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-struct-note">只改这一局，下一轮生成时生效，已写出的内容不变；不影响吧台里保存的方案。</div>
                            <div className="mix-panel-ops">
                                {panels.length ? (
                                    <>
                                        <button type="button" className="mix-dock-chip" data-on={panelsHidden ? "true" : undefined} onClick={() => setPanelsHidden((v) => !v)}>
                                            {panelsHidden ? "显示机括界面" : "收起机括界面"}
                                        </button>
                                        <button type="button" className="mix-dock-chip" onClick={() => { resetPanelBoxes(); onToast("机括界面已归位。"); }}>
                                            界面归位
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    type="button"
                                    className="mix-dock-chip"
                                    data-on={session.historyLimit || histOpen ? "true" : undefined}
                                    onClick={() => setHistOpen((v) => !v)}
                                >
                                    {session.historyLimit ? `回传近 ${session.historyLimit} 轮` : "回传全部历史"}
                                </button>
                                {mixSlotEntries(session.recipe.slots, "filter").length ? (
                                    <button type="button" className="mix-dock-chip" disabled={busy} onClick={() => setConfirm({ type: "refilter" })}>
                                        对历史重跑滤网
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    className="mix-dock-chip"
                                    data-on={compassPrefs.follow !== "manual" ? "true" : undefined}
                                    title={`新一轮渲染完成后要不要把视口挪到最后一行。当前：${FOLLOW_MODE_LABELS[compassPrefs.follow]}（${FOLLOW_MODE_HINTS[compassPrefs.follow]}）点一下在三档之间切换。`}
                                    onClick={() => {
                                        const order: FollowMode[] = ["manual", "bottom", "always"];
                                        const next = order[(order.indexOf(compassPrefs.follow) + 1) % order.length];
                                        followRef.current = next;
                                        patchPrefs({ follow: next });
                                        onToast(`落位已切换为「${FOLLOW_MODE_LABELS[next]}」：${FOLLOW_MODE_HINTS[next]}`);
                                    }}
                                >
                                    落位：{FOLLOW_MODE_LABELS[compassPrefs.follow]}
                                </button>
                            </div>
                            {histOpen ? (
                                <div className="mix-histlimit">
                                    <span>回传轮数</span>
                                    <input
                                        type="range"
                                        min={2}
                                        max={60}
                                        step={1}
                                        value={session.historyLimit ?? 60}
                                        onChange={(e) => setHistoryLimit(Number(e.target.value))}
                                    />
                                    <b>{session.historyLimit ?? "不限"}</b>
                                    <button type="button" className="mix-dock-chip" onClick={() => setHistoryLimit(undefined)}>不限</button>
                                </div>
                            ) : null}
                            <div className="mix-bar-hint">左右滑动切换槽位 · 点击槽位整理材料、顺序与生效条件</div>
                            <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                                {MIX_SLOT_ORDER.map((kind) => {
                                    const stack = mixSlotEntries(session.recipe.slots, kind);
                                    const mat = stack[0] ? getMixMaterial(stack[0].materialId) : null;
                                    const extra = stack.length - 1;
                                    const locked = kind === "character";
                                    // 角色卡本局不可换，但原地编辑放行（与酒柜同一条准入线：
                                    // 官方出厂件、导入的别人的卡不给改）。引擎每轮从酒柜实时取卡，
                                    // 改完下一轮生效，「同一件改版全局换皮」照旧
                                    const charEditable = locked && mat ? !isMixBuiltinId(mat.id) && !mat.imported : false;
                                    return (
                                        <div
                                            className="mix-slot"
                                            data-filled={mat ? "true" : undefined}
                                            data-locked={locked && !charEditable ? "true" : undefined}
                                            key={kind}
                                            onClick={() => {
                                                if (!locked) { setSlotEdit(kind); return; }
                                                if (charEditable && mat) setMatEditor({ kind: "character", initial: mat });
                                                else if (mat) onToast("官方出厂件和导入的别人的角色卡不能编辑。");
                                            }}
                                        >
                                            <div className="mix-slot-kind">
                                                <b>{MIX_KIND_LABELS[kind]}</b>
                                                {locked ? <i>{charEditable ? "不可换 · 点击编辑" : "本局不可换"}</i> : <i>可留空</i>}
                                            </div>
                                            <div className="mix-slot-body">
                                                {mat ? (
                                                    <>
                                                        {mat.cover ? (
                                                            // eslint-disable-next-line @next/next/no-img-element
                                                            <img className="mix-slot-cover" src={mat.cover} alt={mat.name} />
                                                        ) : (
                                                            <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        )}
                                                        <div className="mix-slot-name">{mat.name}{extra > 0 ? ` +${extra}` : ""}</div>
                                                        {mat.hook ? <div className="mix-slot-hook">{mat.hook}</div> : null}
                                                    </>
                                                ) : locked ? (
                                                    <>
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        <div className="mix-slot-name">{session.charName}</div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div className="mix-slot-plus"><Plus size={26} /></div>
                                                        <div className="mix-slot-empty-text">从酒柜里挑一件{MIX_KIND_LABELS[kind]}</div>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="mix-wheel-dots">
                                {MIX_SLOT_ORDER.map((kind, i) => (
                                    <span className="mix-wheel-dot" data-active={i === wheelIndex ? "true" : undefined} key={kind} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 局内叠层编辑：与吧台同一套（排序 / 生效条件 / 移除），改动即存、下一轮生效 */}
            {slotEdit ? (
                <MixSlotEditor
                    kind={slotEdit}
                    entries={mixSlotEntries(session.recipe.slots, slotEdit)}
                    resolve={(id) => getMixMaterial(id)}
                    varNames={slotVarNames}
                    onChange={(next) => writeSlot(slotEdit, next)}
                    onPickMore={() => setSlotPick(slotEdit)}
                    onEdit={(material) => setMatEditor({ kind: material.kind, initial: material })}
                    onCreate={() => setMatEditor({ kind: slotEdit, slot: slotEdit })}
                    onClose={() => setSlotEdit(null)}
                />
            ) : null}

            {slotPick ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPick(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {MIX_KIND_LABELS[slotPick]} · 已放 {mixSlotEntries(session.recipe.slots, slotPick).length} 件
                            </div>
                            <button type="button" className="mix-icon-btn" onClick={() => setMatEditor({ kind: slotPick, slot: slotPick })} aria-label={`自建一件${MIX_KIND_LABELS[slotPick]}`} title={`自建一件${MIX_KIND_LABELS[slotPick]}`}><Plus size={18} /></button>
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPick(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-bar-hint">点一下加入或移出 · 叠了多件按从上到下的顺序依次生效</div>
                            <div className="mix-mat-list">
                                {mixSlotEntries(session.recipe.slots, slotPick).length ? (
                                    <div className="mix-mat-row" onClick={() => clearSlot(slotPick)}>
                                        <div className="mix-mat-row-glyph"><X size={18} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name"><span>不用这味 · 清空槽位</span></div>
                                        </div>
                                    </div>
                                ) : null}
                                {listMixPickables(slotPick).map((m) => (
                                    <div className="mix-mat-row" data-kind={m.kind} onClick={() => toggleSlotItem(slotPick, m.id)} key={m.id}>
                                        <div className="mix-mat-row-glyph"><KindGlyph kind={m.kind} size={22} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name">
                                                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                                                {(() => {
                                                    const at = mixSlotEntries(session.recipe.slots, slotPick).findIndex((e: MixSlotEntry) => e.materialId === m.id);
                                                    // 叠了多件时标出它排第几，顺序就是生效顺序
                                                    return at >= 0 ? <span className="mix-mat-badge">已放{mixSlotEntries(session.recipe.slots, slotPick).length > 1 ? ` · 第 ${at + 1} 件` : ""}</span> : null;
                                                })()}
                                            </div>
                                            {m.hook ? <div className="mix-mat-hook">{m.hook}</div> : null}
                                        </div>
                                        {/* 与酒柜同一条准入线：官方出厂件、从酒材页拿来的别人的材料都不给编辑 */}
                                        {!isMixBuiltinId(m.id) && !m.imported ? (
                                            <button
                                                type="button"
                                                className="mix-icon-btn"
                                                style={{ flex: "0 0 auto", alignSelf: "center" }}
                                                onClick={(e) => { e.stopPropagation(); setMatEditor({ kind: m.kind, initial: m }); }}
                                                aria-label="编辑"
                                            >
                                                <Pencil size={15} />
                                            </button>
                                        ) : null}
                                    </div>
                                ))}
                                {listMixPickables(slotPick).length === 0 ? (
                                    <div className="mix-comment-empty">酒柜里还没有{MIX_KIND_LABELS[slotPick]}——点右上角的「+」现场自建一件。</div>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 局内材料编辑/新建：复用酒柜的创建弹窗。保存逻辑与酒柜同款——
                保留云端发布关联、机括改完收掉旧沙盒；从「+」新建的顺手放进那一格 */}
            {matEditor ? (
                <div className="mix-sheet-mask">
                    <div className="mix-sheet" style={{ maxHeight: "92%" }} onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{matEditor.initial ? "编辑" : "自建"}{MIX_KIND_LABELS[matEditor.kind]}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setMatEditor(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <MixMaterialEditor
                                key={matEditor.initial?.id ?? "new"}
                                kind={matEditor.kind}
                                initial={matEditor.initial}
                                onSave={(material) => {
                                    // 编辑器不经手发布记账字段，保存时从原件带回来，别把云端关联弄丢
                                    saveMixMaterial(matEditor.initial?.publishedId
                                        ? { ...material, publishedId: matEditor.initial.publishedId, publishedAt: matEditor.initial.publishedAt }
                                        : material);
                                    // 机括改完，正在跑的沙盒里还是老代码——收掉，下次调用重建
                                    if (material.kind === "mechanism") { disposeMixSandboxesForMaterial(material.id); disposeMixTrustedForMaterial(material.id); }
                                    if (matEditor.slot && !matEditor.initial) {
                                        // 从「+」现场新建的就是为这一格建的：保存即入格，排在已有的后面
                                        writeSlot(matEditor.slot, [...mixSlotEntries(session.recipe.slots, matEditor.slot), { materialId: material.id }]);
                                        onToast(`「${material.name}」已入柜并放进本局，下一轮生效。`);
                                    } else {
                                        if (material.kind === "character" && material.id === mixSlotEntries(session.recipe.slots, "character")[0]?.materialId) {
                                            // 改的是本局这张角色卡：charName 快照要对齐——生成时的
                                            // meta 与机括钩子读的都是快照，不是酒柜里的实时卡；
                                            // 还没开口的局顺手把开场白换成新版（refreshMixOpening 自己判）
                                            const fresh = getMixSession(sessionId);
                                            const nextName = material.charName.trim() || material.name;
                                            if (fresh && nextName && nextName !== fresh.charName) saveMixSession({ ...fresh, charName: nextName });
                                            refreshMixOpening(sessionId);
                                        }
                                        setSession(getMixSession(sessionId));
                                        onToast(`「${material.name}」已更新，下一轮生效。`);
                                    }
                                    setMatEditor(null);
                                }}
                                onCancel={() => setMatEditor(null)}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 编辑消息：大弹窗，assistant 轮编辑的是含格式块的原始输出 */}
            {editing ? (() => {
                const editingTurn = session.turns.find((t) => t.id === editing.id);
                return (
                    <div className="mix-sheet-mask" ref={editMaskRef} onClick={() => setEditing(null)}>
                        <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                            <div className="mix-sheet-head">
                                <div className="mix-sheet-title">编辑消息</div>
                                <button type="button" className="mix-icon-btn" onClick={() => setEditing(null)} aria-label="关闭"><X size={18} /></button>
                            </div>
                            <div className="mix-sheet-body">
                                {editingTurn?.role === "assistant" ? (
                                    <div className="mix-struct-note">
                                        这里是这一轮的<b>原始输出</b>——[状态栏]/[小剧场] 块也在里面。
                                        模型输出掉了格式可以在这儿手动修，保存后会重新解析渲染。
                                    </div>
                                ) : null}
                                <textarea
                                    className="mix-textarea mix-edit-large"
                                    value={editing.draft}
                                    onChange={(e) => setEditing({ id: editing.id, draft: e.target.value })}
                                />
                                <div className="mix-turn-edit-actions">
                                    <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setEditing(null)}>取消</button>
                                    <button
                                        type="button"
                                        className="mix-pill-btn"
                                        onClick={() => {
                                            if (editWillTruncate(editing.id)) setConfirm({ type: "edit", turnId: editing.id });
                                            else saveEdit();
                                        }}
                                    >
                                        保存{editingTurn?.role === "user" ? "并重新生成" : ""}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })() : null}

            {confirm?.type === "refilter" ? (
                <MixConfirm
                    title="对历史重跑滤网？"
                    body={<>把本局每一条 AI 正文按当前生效的「进上下文」规则再洗一遍，存的和发回模型的历史都会改。<br />「仅显示」规则本来就对全部历史即时生效，不在此列。原始输出会保留，之后编辑看到的仍是模型原话。</>}
                    confirmText="重跑"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        setConfirm(null);
                        try {
                            const result = rerunMixFilters(sessionId);
                            setSession(getMixSession(sessionId));
                            if (!result.rules) onToast("当前方案里没有「进上下文」的滤网规则，历史没有改动。");
                            else if (!result.changed) onToast(`按 ${result.rules} 条规则重跑了 ${result.total} 条回复，没有需要改的。`);
                            else onToast(`按 ${result.rules} 条规则重跑了 ${result.total} 条回复，${result.changed} 条有改动。`);
                        } catch (error) {
                            onToast(error instanceof Error ? error.message : "重跑失败");
                        }
                    }}
                />
            ) : confirm ? (
                <MixConfirm
                    title={confirm.type === "rewind" ? "回溯到这条消息？" : "保存修改？"}
                    body={confirm.type === "rewind"
                        ? <>这条消息之后的 {laterCount(confirm.turnId)} 条内容将被删除。{mechanismRewindHint(confirm.turnId)}</>
                        : `保存后，这条消息之后的 ${laterCount(confirm.turnId)} 条内容将被删除${session.turns.find((t) => t.id === confirm.turnId)?.role === "user" ? "，并重新生成回复" : ""}。`}
                    confirmText={confirm.type === "rewind" ? "回溯" : "保存"}
                    tone="danger"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const target = confirm;
                        setConfirm(null);
                        if (target.type === "rewind") doRewind(target.turnId);
                        else saveEdit();
                    }}
                />
            ) : null}

            {fork && session ? (() => {
                const forkTurn = session.turns[fork.idx];
                const turnText = forkTurn?.text?.replace(/\s+/g, " ").trim().slice(0, 60) ?? "";
                return (
                    <MixForkDialog
                        fromTitle={mixSessionTitle(session)}
                        fromTurnText={turnText || undefined}
                        roundCount={mixRoundCount(session.turns.slice(0, fork.idx + 1))}
                        defaultName={session.branchName}
                        onCancel={() => setFork(null)}
                        onConfirm={({ branchName, branchNote }) => {
                            try {
                                const child = forkMixSession(sessionId, fork.idx, { branchName, branchNote });
                                setFork(null);
                                onToast(`已开新支线「${mixSessionTitle(child)}」。当前对局不变，可在 🌳 世界树里点开继续玩。`);
                            } catch (error) {
                                setFork(null);
                                onToast(error instanceof Error ? error.message : "分叉失败");
                            }
                        }}
                    />
                );
            })() : null}

            {onSwitchSession ? (
                <>
                    <MixSessionSwitcher sessionId={sessionId} onSwitch={onSwitchSession} />
                    <MixSessionTree sessionId={sessionId} onSwitch={onSwitchSession} onToast={onToast} />
                </>
            ) : null}

            {accountOpen ? (
                <div className="mix-account-overlay" onClick={() => setAccountOpen(false)}>
                    <div className="mix-account-sheet" onClick={(event) => event.stopPropagation()}>
                        <ApiAccountPanel
                            accountId={mixAccount.id}
                            onClose={() => setAccountOpen(false)}
                            title={accountLabel(mixAccount.id)}
                        />
                    </div>
                </div>
            ) : null}

        </div>
        </>
    );
}
