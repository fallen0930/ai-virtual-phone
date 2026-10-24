"use client";

// 执笔插件 · 宿主面板
//
// 归统一控制坞管理：坞里点「执笔」按钮 → 弹出这个可拖动的浮窗，
// 在任意界面都能用。用于剧情自主书写。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { X, Feather, Loader2, Database } from "lucide-react";
import {
    CONTROL_DOCK_ACTIVATE_EVENT,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import { loadCharacterWorldFromSession, getActiveMixSession } from "@/lib/narrative-writer/context-loader";
import { writeNarrative, generateBannerOptions, writeWithSelectedBanner, compressNarrativeMemory, extractMemoriesFromCompression, computeCurrentTurn, NARRATIVE_CHUNK_SIZE, type BannerCandidate } from "@/lib/narrative-writer/writer";
import { insertNarrativeTurn } from "@/lib/mixology/engine";
import { backfillExtraction, deepExtractFromNarrativeBody } from "@/lib/narrative-writer/extractor";
import { generateMaterialCards, type MaterialCard } from "@/lib/narrative-writer/recommender";
import {
  getMemoryCards,
  getEmotionCards,
  getWaterLevels,
  getWriterState,
  getContextHierarchy,
  saveContextHierarchy,
  getExtractionRules,
  archiveMemoryCard,
  archiveEmotionCard,
  deleteMemoryCard,
  deleteEmotionCard,
  updateMemoryCard,
  updateEmotionCard,
  confirmAllPendingCards,
  listThreadCards,
  listForeshadowCards,
  updateThreadCard,
  updateForeshadowCard,
  archiveThreadCard,
  archiveForeshadowCard,
  deleteThreadCard,
  deleteForeshadowCard,
  hasLegacyNarrativeData,
  getMigrationState,
  deferLegacyMigration,
} from "@/lib/narrative-writer/storage";
import { applyAdoptedBanner, migrateLooseThreadsToCards, stripBannerMarkers } from "@/lib/narrative-writer/threads";
import {
    prepareLedgerTask,
    initThreadLedgerFromOutline,
    createManualThread,
    createManualForeshadow,
    isLedgerInitializing,
    LEDGER_SYSTEM_PROMPT_CHARS,
    THREAD_NAME_MAX,
    THREAD_NEXT_MAX,
    FORESHADOW_CONTENT_MAX,
    线索进度文案,
} from "@/lib/narrative-writer/ledger-init";
import { loadMixSessions } from "@/lib/mixology/storage";
import { mixSessionTitle } from "@/lib/mixology/types";
import { LegacyMigrationDialog } from "@/components/narrative-writer/legacy-migration-dialog";
import type { MemoryCard, EmotionCard, WaterLevelState, NarrativeWriterState, ContextHierarchy, ExtractionRules, ThreadCard, ForeshadowCard, ThreadPlotStatus } from "@/lib/narrative-writer/types";

const UI_KEY = "phone_narrative_writer_ui_v2"; // v2 强制重置默认尺寸
const CONTROL_ID = "narrative-writer" as const;

type Rect = { x: number; y: number; w: number; h: number };
const DEFAULT_RECT: Rect = { x: 40, y: 80, w: 360, h: 520 };
const MIN_W = 280;
const MIN_H = 400;
const MAX_W = 400; // 限制最大宽度

/** 八维度倾向的快捷选项 */
const TENDENCY_PRESETS: Record<string, string[]> = {
  基调: ["温柔", "压抑", "轻松", "紧张", "甜蜜", "悲伤"],
  节奏: ["慢慢来", "快进", "缓冲一下", "推进剧情"],
  焦点: ["多写写她", "多写写他", "群像", "独处场景", "环境描写"],
  关系方向: ["让她主动一点", "保持距离感", "靠近一些", "制造张力"],
  触发: ["下雨了", "今天是纪念日", "深夜", "清晨"],
  主题: ["聊过去", "碰那个秘密", "日常相处", "冲突爆发"],
  禁忌: ["今天不想看冲突", "别让某人出现", "别太虐"],
  密度: ["想多看点", "简单过一下"],
};

// 台账区里的手动新增表单：400px 小窗里三个字段竖排，样式抽出来免得每个 input 抄一遍
const LEDGER_FIELD_STYLE: CSSProperties = {
    width: "100%",
    padding: "5px 7px",
    fontSize: "11px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "5px",
    color: "#e5e7eb",
    boxSizing: "border-box",
};
const LEDGER_SUBMIT_STYLE: CSSProperties = {
    padding: "4px 8px",
    fontSize: "10px",
    background: "rgba(16,185,129,0.15)",
    border: "1px solid rgba(16,185,129,0.4)",
    borderRadius: "4px",
    color: "#10b981",
    cursor: "pointer",
};
const LEDGER_CANCEL_STYLE: CSSProperties = {
    padding: "4px 8px",
    fontSize: "10px",
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "4px",
    color: "#9ca3af",
    cursor: "pointer",
};

function loadRect(): Rect {
    if (typeof window === "undefined") return DEFAULT_RECT;
    try {
        const raw = window.localStorage.getItem(UI_KEY);
        const r = raw ? (JSON.parse(raw) as Partial<Rect>) : null;
        if (r && [r.x, r.y, r.w, r.h].every(v => typeof v === "number")) {
            return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
        }
    } catch { /* ignore */ }
    return DEFAULT_RECT;
}

function persistRect(rect: Rect): void {
    try { window.localStorage.setItem(UI_KEY, JSON.stringify(rect)); } catch { /* ignore */ }
}

/**
 * 归档卡的小字提示。
 *
 * 「归档」有两种来路：玩家自己点了归档，或者这张卡的来源回复被丢弃了
 * （重说／回溯／编辑后截断／抽取竞态）由代码改判。前者不用解释，
 * 后者必须在卡上说清楚——否则玩家只看到"归档"，不知道这条记忆为什么不能直接恢复生效。
 *
 * 只认归档原因里的这两类文案，其它原因（含未来手动归档的新文案）一律不显示。
 */
function discardedSourceHint(card: { 状态?: string; 归档原因?: string }): string | null {
    if (card.状态 !== "归档" || !card.归档原因) return null;
    const 因丢弃而归档 =
        card.归档原因.includes("来源回复已被丢弃") || card.归档原因.includes("来源消息已不存在");
    return 因丢弃而归档 ? "该卡来自已被丢弃的回复" : null;
}

/** 悬停在卡上时说明为什么被归档；没有原因就不加 title，免得空 tooltip */
function archiveTitle(card: { 状态?: string; 归档原因?: string }): string | undefined {
    if (card.状态 !== "归档") return undefined;
    return card.归档原因 ? `归档原因：${card.归档原因}` : "已归档";
}

/**
 * 走向卡在面板里的形状（候选列表与缓冲区共用）。
 *
 * 为什么不再是 { text }：一张卡要同时给出「可编辑的报幕」和「代码生成的回写标记」，
 * 合成一个 text 字段就会出现——她改一个字，标记跟着错位、台账静默记错。
 * 现在编辑只动 报幕，标记原样保留；采纳时再拼回去（带标记文本）。
 *
 * 旧缓冲区（narrative_writer_buffer）里的条目只有 text：按无类型卡处理，
 * 标记一律清空 → 不回写，也绝不删她存的东西（定稿要求 7）。
 */
type BannerCardItem = {
    /** = 分配卡 id，缓冲区的去重键 */
    id: string;
    /** 引擎返回的整张候选；旧缓冲条目没有它 */
    候选?: BannerCandidate;
    报幕: string;
    标记: string;
    note?: string;
};

/** 入对局与回写用的文本：编辑后的报幕 + 代码生成的标记 */
function 带标记文本(item: BannerCardItem): string {
    return `${item.报幕}${item.标记}`;
}

/** 交给 writeWithSelectedBanner 的入参：有卡就传整张卡，旧条目只传报幕文本 */
function 正文入参(item: BannerCardItem): string | BannerCandidate {
    if (!item.候选) return item.报幕;
    return { ...item.候选, 报幕: item.报幕, 文本: 带标记文本(item) };
}

/** 读旧 localStorage：兼容 { text } 与 { 报幕, 标记 } 两种条目 */
function 归一缓冲条目(raw: unknown): BannerCardItem | null {
    if (!raw || typeof raw !== "object") return null;
    const 条目 = raw as Record<string, unknown>;
    const 文本候选 = typeof 条目.报幕 === "string" ? 条目.报幕 : typeof 条目.text === "string" ? 条目.text : null;
    if (文本候选 === null) return null;
    const 候选 = 条目.候选 && typeof 条目.候选 === "object" ? (条目.候选 as BannerCandidate) : undefined;
    return {
        id: typeof 条目.id === "string" && 条目.id ? 条目.id : `legacy_${Math.random().toString(36).slice(2, 10)}`,
        ...(候选 ? { 候选 } : {}),
        // 旧条目可能把标记写进了 text，先剥干净；标记只有新条目（带候选）才认
        报幕: stripBannerMarkers(文本候选),
        标记: 候选 && typeof 条目.标记 === "string" ? 条目.标记 : "",
        note: typeof 条目.note === "string" ? 条目.note : undefined,
    };
}

export function NarrativeWriterPanel() {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState<Rect>(DEFAULT_RECT);
    const [tendency, setTendency] = useState("");
    const [output, setOutput] = useState<{ banner: string; body: string } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    // 执笔模式：direct = 直接生成，select = 先选报幕再生成
    const [mode, setMode] = useState<"direct" | "select">(() => {
        if (typeof window === "undefined") return "direct";
        try {
            return (window.localStorage.getItem("narrative_writer_mode") as "direct" | "select") || "direct";
        } catch {
            return "direct";
        }
    });
    
    // 选择模式相关状态
    const [bannerOptions, setBannerOptions] = useState<BannerCardItem[]>([]);
    const [selectedBannerIndex, setSelectedBannerIndex] = useState<number | null>(null);
    const [generatingBanners, setGeneratingBanners] = useState(false);
    
    // 报幕缓冲区：用户勾选后暂存的走向卡（可编辑、可批量生成）
    const [buffer, setBuffer] = useState<BannerCardItem[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = window.localStorage.getItem("narrative_writer_buffer");
            const 列表 = saved ? (JSON.parse(saved) as unknown[]) : [];
            return Array.isArray(列表) ? 列表.map(归一缓冲条目).filter((b): b is BannerCardItem => b !== null) : [];
        } catch {
            return [];
        }
    });
    const [showBuffer, setShowBuffer] = useState(false); // 是否展开缓冲区面板
    
    // 数据面板相关状态
    const [activeTab, setActiveTab] = useState<"write" | "data">("write");
    const [memories, setMemories] = useState<MemoryCard[]>([]);
    const [emotions, setEmotions] = useState<EmotionCard[]>([]);
    // 悬念台账（导演侧资产）：只在这里看和改，正文永远读不到它们
    const [threads, setThreads] = useState<ThreadCard[]>([]);
    const [foreshadows, setForeshadows] = useState<ForeshadowCard[]>([]);
    const [waterLevels, setWaterLevels] = useState<Record<string, WaterLevelState>>({});
    const [writerState, setWriterState] = useState<NarrativeWriterState | null>(null);
    const [contextHierarchy, setContextHierarchy] = useState<ContextHierarchy | null>(null);
    const [extractionRules, setExtractionRules] = useState<ExtractionRules | null>(null);
    const [dataLoading, setDataLoading] = useState(false);
    // 数据面板当前读的是哪一场的记忆。记忆已按会话隔离，面板必须在载入前拿到这个 id，
    // 后续所有卡片增删改都要用它，不能退回"读全部"。
    const [dataSessionId, setDataSessionId] = useState<string | null>(null);

    // 旧全局记忆归属迁移（任务 #20）
    const [migrationOpen, setMigrationOpen] = useState(false);
    const [legacyPending, setLegacyPending] = useState(false); // 有旧数据且尚未归属
    const [migrationSessions, setMigrationSessions] = useState<Array<{ id: string; title: string }>>([]);
    const [migrationHasActive, setMigrationHasActive] = useState(false);
    
    // 卡片管理状态
    const [editingCard, setEditingCard] = useState<{ type: "memory" | "emotion"; card: MemoryCard | EmotionCard } | null>(null);
    const [editContent, setEditContent] = useState("");
    const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
    const [cardFilter, setCardFilter] = useState<{ status?: string; subject?: string; 主类型?: string; 次标签?: string }>({});
    
    // 记忆整理状态（step=已完成步骤数，etaMs=按实测单步耗时推算的剩余时间）
    const [compressing, setCompressing] = useState(false);
    const [compressProgress, setCompressProgress] = useState<{ step: number; totalSteps: number; phase: string; etaMs: number } | null>(null);
    // 补抽历史状态（进度复用 compressProgress，与整理互斥）
    const [backfilling, setBackfilling] = useState(false);
    // 深度抽取状态
    const [deepExtracting, setDeepExtracting] = useState(false);
    const [lastDeepExtractAt, setLastDeepExtractAt] = useState<number | null>(null);
    // 批量确认待核卡状态（防重复点：确认会把卡片写进正文上下文，跑一半再点一次会重复写）
    const [confirmingPending, setConfirmingPending] = useState(false);
    // 台账冷启动：长篇对局里一条线索也没有，主线/伏笔回收永远没有素材。
    // 这里的状态只管三件事——按钮禁用、整理完成后的那一次提示、手动新增表单是否展开。
    const [ledgerBusy, setLedgerBusy] = useState(false);
    const [ledgerNotice, setLedgerNotice] = useState<{ text: string; bad: boolean } | null>(null);
    // 整理完提示"要不要按大纲初始化台账"：只出现一次，点掉/跑过一次就不再出现，绝不自动执行
    const [ledgerOffer, setLedgerOffer] = useState(false);
    const [manualForm, setManualForm] = useState<"thread" | "foreshadow" | null>(null);
    const [manualThreadName, setManualThreadName] = useState("");
    const [manualThreadRoles, setManualThreadRoles] = useState("");
    const [manualThreadNext, setManualThreadNext] = useState("");
    const [manualForeshadowContent, setManualForeshadowContent] = useState("");
    const [manualForeshadowThread, setManualForeshadowThread] = useState("");
    // 人名素材：初始化要拿它当白名单，手动新增的「关联角色」要预填当前角色
    const [currentCharName, setCurrentCharName] = useState("");
    const [currentPlayerName, setCurrentPlayerName] = useState("");
    // ETA 用最近 N 步的滚动均值，避免第1步冷启动把整体预估拉高
    const [recentStepTimes, setRecentStepTimes] = useState<number[]>([]);
    const ETA_ROLLING_WINDOW = 3; // 取最近 3 步的均值
    const ETA_CAP_MS = 30 * 60 * 1000; // 预估上限 30 分钟，避免吓人

    // 素材库（代码从记忆库拼的钩子，不是方向候选；方向候选只有走向卡）
    const [sceneRecommendations, setSceneRecommendations] = useState<MaterialCard[]>([]);
    const [loadingRecommendations, setLoadingRecommendations] = useState(false);
    const [selectedScene, setSelectedScene] = useState<string | null>(null);
    const [editingScene, setEditingScene] = useState<MaterialCard | null>(null);
    // 每张卡当前选中的维度
    const [selectedDimensions, setSelectedDimensions] = useState<Record<string, { focus?: string; intensity?: string; tempo?: string }>>({});
    
    // 切换维度选项
    const handleToggleDimension = useCallback((sceneId: string, dim: 'focus' | 'intensity' | 'tempo', value: string) => {
        setSelectedDimensions(prev => {
            const current = prev[sceneId] || {};
            const next = { ...current, [dim]: current[dim] === value ? undefined : value };
            return { ...prev, [sceneId]: next };
        });
    }, []);
    
    // 加载素材库卡片
    const loadRecommendations = useCallback(async () => {
        setLoadingRecommendations(true);
        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) return;
            
            const memories = await getMemoryCards(activeSession.id, { status: "生效" });
            const pendingMemories = await getMemoryCards(activeSession.id, { status: "待核" });
            const emotions = await getEmotionCards(activeSession.id, { status: "生效" });
            const waterLevels = await getWaterLevels(activeSession.id);
            const writerState = await getWriterState(activeSession.id);
            const hierarchy = await getContextHierarchy(activeSession.id);
            // 环境催化卡优先抓未决线索（导演台账），没有线索才退回旧的散落线头
            const threads = await listThreadCards(activeSession.id);
            const context = await loadCharacterWorldFromSession(activeSession.id);
            
            const currentWaterLevel = waterLevels['戏内层']?.水位 || 'L0';
            
            const previews = generateMaterialCards({
                memories,
                pendingMemories,
                emotions,
                waterLevel: currentWaterLevel,
                writerState,
                hierarchy,
                characterName: context?.characterProfile?.charName || "角色",
                worldText: context?.characterProfile?.worldText || "",
                threads,
            });
            
            setSceneRecommendations(previews);
        } catch (err) {
            console.error("[NarrativeWriter] Failed to load previews:", err);
        } finally {
            setLoadingRecommendations(false);
        }
    }, []);
    
    // 打开面板时加载预告
    useEffect(() => {
        if (open) {
            loadRecommendations();
        }
    }, [open, loadRecommendations]);
    
    // 选择预告：把功能+风格+钩子画面+维度拼进倾向文本
    const handleSelectScene = useCallback((scene: MaterialCard) => {
        setSelectedScene(scene.id);
        const dims = selectedDimensions[scene.id] || scene.defaultDimension || {};
        const parts = [
            `基调:${scene.style.tone}`,
            `节奏:${scene.style.pace}`,
            `密度:${scene.style.density}`,
            `剧情功能:${scene.plotFunction === 'twist' ? '转折' : scene.plotFunction === 'advance' ? '推进' : scene.plotFunction === 'flirt' ? '升温试探' : '缓冲日常'}`,
        ];
        if (dims.focus) parts.push(`焦点:${dims.focus}`);
        if (dims.intensity) parts.push(`张力:${dims.intensity}`);
        if (dims.tempo) parts.push(`时间:${dims.tempo}`);
        parts.push(`钩子画面:${scene.hook}`);
        setTendency(parts.join("，"));
    }, [selectedDimensions]);
    
    // 编辑预告
    const handleEditScene = useCallback((scene: MaterialCard) => {
        setEditingScene(scene);
    }, []);
    
    // 保存编辑的场景
    const handleSaveEditedScene = useCallback(() => {
        if (!editingScene) return;
        // 更新倾向文本
        handleSelectScene(editingScene);
        setEditingScene(null);
    }, [editingScene, handleSelectScene]);
    
    const ref = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

    // 执笔小窗吃"可使用"：停用 = 小窗彻底不出现
    const controlDockState = useSyncExternalStore(subscribeControlDockState, getControlDockState, getControlDockState);
    const writerEnabled = controlDockState.enabled[CONTROL_ID] !== false;

    // 加载初始位置
    useEffect(() => {
        setRect(loadRect());
    }, []);

    // 监听坞条激活事件
    useEffect(() => {
        if (!writerEnabled) {
            setOpen(false);
            return;
        }

        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { control: string } | undefined;
            if (detail?.control === CONTROL_ID) {
                setOpen(prev => !prev);
            }
        };

        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, [writerEnabled]);
    
    // 持久化模式选择
    useEffect(() => {
        try { window.localStorage.setItem("narrative_writer_mode", mode); } catch { /* ignore */ }
    }, [mode]);
    
    // 持久化缓冲区
    useEffect(() => {
        try { window.localStorage.setItem("narrative_writer_buffer", JSON.stringify(buffer)); } catch { /* ignore */ }
    }, [buffer]);
    
    // 加载数据面板数据（可复用）
    const loadData = useCallback(async () => {
        setDataLoading(true);
        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                // 没打开对局就没有归属会话，记忆/水位一律不读，避免跨场串数据
                setDataSessionId(null);
                setMemories([]);
                setEmotions([]);
                setThreads([]);
                setForeshadows([]);
                setWaterLevels({});
                setWriterState(null);
                setContextHierarchy(null);
                setExtractionRules(await getExtractionRules());
                setCurrentCharName("");
                setCurrentPlayerName("");
                return;
            }
            const sid = activeSession.id;
            setDataSessionId(sid);
            const [mems, emos, tds, fds, waters, state, hierarchy, rules, context] = await Promise.all([
                getMemoryCards(sid),
                getEmotionCards(sid),
                listThreadCards(sid),
                listForeshadowCards(sid),
                getWaterLevels(sid),
                getWriterState(sid),
                getContextHierarchy(sid),
                getExtractionRules(),
                loadCharacterWorldFromSession(sid),
            ]);
            setMemories(mems);
            setEmotions(emos);
            setThreads(tds);
            setForeshadows(fds);
            setWaterLevels(waters);
            setWriterState(state);
            setContextHierarchy(hierarchy);
            setExtractionRules(rules);
            setCurrentCharName(context?.characterProfile?.charName || "");
            setCurrentPlayerName(context?.userPersona?.userName || "");
        } catch (err) {
            console.error("[NarrativeWriter] Failed to load data:", err);
        } finally {
            setDataLoading(false);
        }
    }, []);
    
    // 切换到数据面板时加载数据
    useEffect(() => {
        if (activeTab !== "data" || !open) return;
        loadData();
    }, [activeTab, open, loadData]);

    // 刷新迁移提示所需的状态：是否有未归属旧数据、是否有活动会话、可选对局列表。
    const refreshMigrationContext = useCallback(async () => {
        const has = await hasLegacyNarrativeData();
        if (!has) { setLegacyPending(false); return false; }
        const st = await getMigrationState();
        const done = st?.status === "done";
        setLegacyPending(!done);
        const active = getActiveMixSession();
        setMigrationHasActive(!!active);
        setMigrationSessions(loadMixSessions().map((s) => ({ id: s.id, title: mixSessionTitle(s) })));
        return !done;
    }, []);

    // 进入执笔面板时：若存在未迁移旧数据、用户既没选过归属也没选过"稍后"、且当前有活动会话 → 自动弹一次。
    // 其余情况（无活动会话 / 已选稍后 / 已完成）不自动弹，只在面板顶部留常驻提示。
    useEffect(() => {
        if (!open) return;
        (async () => {
            try {
                const has = await hasLegacyNarrativeData();
                if (!has) { setLegacyPending(false); setMigrationOpen(false); return; }
                const st = await getMigrationState();
                const done = st?.status === "done";
                const deferred = st?.status === "deferred";
                setLegacyPending(!done);
                const active = getActiveMixSession();
                setMigrationHasActive(!!active);
                setMigrationSessions(loadMixSessions().map((s) => ({ id: s.id, title: mixSessionTitle(s) })));
                if (!done && !deferred && active) setMigrationOpen(true);
            } catch (err) {
                console.error("[NarrativeWriter] 检查旧记忆归属迁移条件失败:", err);
            }
        })();
    }, [open]);

    // 迁移成功：旧数据不再待归属；若在数据面板则重载以显示迁移进来的卡。弹窗留在"完成"页由用户手动关。
    const handleMigrationMigrated = useCallback(() => {
        setLegacyPending(false);
        if (activeTab === "data") void loadData();
    }, [activeTab, loadData]);

    // 关闭 / 稍后：迁移未完成就记 deferred（不删旧数据、不算已迁移）；已完成就只是关闭。
    const handleMigrationClose = useCallback(async () => {
        setMigrationOpen(false);
        try {
            const st = await getMigrationState();
            if (st?.status === "done") {
                setLegacyPending(false);
                if (activeTab === "data") void loadData();
            } else {
                await deferLegacyMigration();
                setLegacyPending(true);
            }
        } catch (err) {
            console.error("[NarrativeWriter] 处理旧记忆迁移弹窗关闭失败:", err);
        }
    }, [activeTab, loadData]);

    // 点常驻提示重新打开：没有活动会话时不弹（提示语会引导先开一局）。
    const openMigrationFromHint = useCallback(async () => {
        if (!migrationHasActive) return;
        await refreshMigrationContext();
        setMigrationOpen(true);
    }, [migrationHasActive, refreshMigrationContext]);

    // 拖动逻辑
    const onDragPointerDown = (e: ReactPointerEvent) => {        e.preventDefault();
        const current = rect;
        dragRef.current = { sx: e.clientX, sy: e.clientY, ox: current.x, oy: current.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onDragPointerMove = (e: ReactPointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        setRect(prev => ({ ...prev, x: drag.ox + dx, y: drag.oy + dy }));
    };

    const onDragPointerEnd = (e: ReactPointerEvent) => {
        dragRef.current = null;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
        persistRect(rect);
    };

    // 执行执笔（直接模式）
    const handleWrite = useCallback(async () => {
        setLoading(true);
        setError(null);
        setOutput(null);

        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局（特调 Session）");
                return;
            }

            const context = await loadCharacterWorldFromSession(activeSession.id);
            if (!context) {
                setError("无法从当前对局加载人设信息");
                return;
            }

            const result = await writeNarrative({
                sessionId: activeSession.id,
                playerTendency: tendency.trim() || undefined,
                characterProfile: context.characterProfile,
                worldSettings: {
                    preface: context.preface,
                    basePrompts: context.basePrompts,
                    flavorPrompts: context.flavorPrompts,
                    glassPrompts: context.glassPrompts,
                    strengthPrompts: context.strengthPrompts,
                },
                recentDialogue: context.recentDialogue,
            });

            setOutput({ banner: result.banner, body: result.body });
            await insertNarrativeTurn(activeSession.id, result.body, result.banner);
        } catch (err: any) {
            console.error("[NarrativeWriter] Write failed:", err);
            setError(err.message || "执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency]);
    
    // 生成走向卡（选择模式第一步）。换一批 = 再调一次：先清空旧卡，绝不累积（定稿要求 8）
    const handleGenerateBanners = useCallback(async () => {
        setGeneratingBanners(true);
        setError(null);
        setBannerOptions([]);
        setSelectedBannerIndex(null);

        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局（特调 Session）");
                return;
            }

            const context = await loadCharacterWorldFromSession(activeSession.id);
            if (!context) {
                setError("无法从当前对局加载人设信息");
                return;
            }

            const 候选 = await generateBannerOptions({
                sessionId: activeSession.id,
                playerTendency: tendency.trim() || undefined,
                characterProfile: context.characterProfile,
                worldSettings: {
                    preface: context.preface,
                    basePrompts: context.basePrompts,
                    flavorPrompts: context.flavorPrompts,
                    glassPrompts: context.glassPrompts,
                    strengthPrompts: context.strengthPrompts,
                },
                recentDialogue: context.recentDialogue,
            });

            if (候选.length === 0) {
                setError("未能生成走向卡，请重试");
                return;
            }

            setBannerOptions(候选.map((一张) => ({
                id: 一张.id,
                候选: 一张,
                报幕: 一张.报幕,
                // 标记由代码生成，跟着卡走；报幕后面那段就是它
                标记: 一张.文本.startsWith(一张.报幕) ? 一张.文本.slice(一张.报幕.length) : "",
                note: "",
            })));
        } catch (err: any) {
            console.error("[NarrativeWriter] Generate banners failed:", err);
            setError(err.message || "生成走向卡失败，请重试");
        } finally {
            setGeneratingBanners(false);
        }
    }, [tendency]);
    
    // 更新报幕文本（只动 报幕，标记原样保留）
    const updateBannerText = useCallback((index: number, newText: string) => {
        setBannerOptions(prev => prev.map((opt, i) => 
            i === index ? { ...opt, 报幕: newText } : opt
        ));
    }, []);
    
    // 更新报幕批注
    const updateBannerNote = useCallback((index: number, newNote: string) => {
        setBannerOptions(prev => prev.map((opt, i) => 
            i === index ? { ...opt, note: newNote } : opt
        ));
    }, []);
    
    // 将走向卡加入/移出缓冲区（去重键 = 卡 id，不再比文本）
    const toggleBuffer = useCallback((option: BannerCardItem) => {
        setBuffer(prev => {
            const exists = prev.some(b => b.id === option.id);
            if (exists) {
                return prev.filter(b => b.id !== option.id);
            }
            return [...prev, { ...option }];
        });
    }, []);
    
    // 从缓冲区移除
    const removeFromBuffer = useCallback((id: string) => {
        setBuffer(prev => prev.filter(b => b.id !== id));
    }, []);
    
    // 更新缓冲区中的报幕文本
    const updateBufferText = useCallback((id: string, newText: string) => {
        setBuffer(prev => prev.map(b => b.id === id ? { ...b, 报幕: newText } : b));
    }, []);
    
    // 更新缓冲区中的批注
    const updateBufferNote = useCallback((id: string, newNote: string) => {
        setBuffer(prev => prev.map(b => b.id === id ? { ...b, note: newNote } : b));
    }, []);
    
    /**
     * 采纳一条走向卡：正文入对局 + 按报幕行尾标记回写悬念台账。
     *
     * 顺序由 applyAdoptedBanner 保证：先剥标记 → insert 成功 → 才回写；插入抛错时
     * 台账一行都不动（否则凭空多出一段没发生的剧情）。
     * 来源用新插入那条 assistant 消息的 id 与轮次，与引擎热轨抽取同一口径，
     * 之后玩家重说这条回复时，这条线"因它而产生的记录"才找得回。
     *
     * 已知限制：回写反映的是**报幕的计划**，不是正文实际写了什么。
     */
    const handleAdoptBanner = useCallback(async (
        sessionId: string,
        body: string,
        带标记报幕: string
    ): Promise<{ 推进数: number; 回收数: number; 忽略数: number }> => {
        const 结果 = await applyAdoptedBanner({
            sessionId,
            banner: 带标记报幕,
            insert: async (干净报幕) => {
                const updated = await insertNarrativeTurn(sessionId, body, 干净报幕);
                const 最后一条 = updated.turns[updated.turns.length - 1];
                return {
                    消息ID: 最后一条?.id,
                    轮次: updated.turns.filter(t => t.role === "assistant").length,
                };
            },
        });
        // 台账真的动过才刷新数据面板，避免每次执笔都多读一遍库
        if (结果.推进数 + 结果.回收数 > 0) void loadData();
        return 结果;
    }, [loadData]);

    // 根据缓冲区中的一张走向卡生成正文
    const handleWriteFromBuffer = useCallback(async (bufferItem: BannerCardItem) => {
        setLoading(true);
        setError(null);

        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局（特调 Session）");
                return;
            }

            const context = await loadCharacterWorldFromSession(activeSession.id);
            if (!context) {
                setError("无法从当前对局加载人设信息");
                return;
            }

            const enhancedTendency = bufferItem.note 
                ? `${tendency.trim()}。特别说明：${bufferItem.note}`
                : tendency.trim();

            const result = await writeWithSelectedBanner({
                sessionId: activeSession.id,
                playerTendency: enhancedTendency || undefined,
                characterProfile: context.characterProfile,
                worldSettings: {
                    preface: context.preface,
                    basePrompts: context.basePrompts,
                    flavorPrompts: context.flavorPrompts,
                    glassPrompts: context.glassPrompts,
                    strengthPrompts: context.strengthPrompts,
                },
                recentDialogue: context.recentDialogue,
            }, 正文入参(bufferItem));

            // 带标记文本只用于回写台账，入对局的正文由 applyAdoptedBanner 剥净
            await handleAdoptBanner(activeSession.id, result.body, 带标记文本(bufferItem));
        } catch (err: any) {
            console.error("[NarrativeWriter] Write from buffer failed:", err);
            setError(err.message || "执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency, handleAdoptBanner, removeFromBuffer]);
    
    // 批量生成缓冲区所有走向卡
    const handleBatchWriteFromBuffer = useCallback(async () => {
        if (buffer.length === 0) return;
        
        setLoading(true);
        setError(null);

        // 中途失败仍是"停在这里"（她定的：是否继续只汇报现状，不改行为），
        // 但要把第几条报出来——否则她不知道是前面已经写进去了还是整批没跑。
        let 已完成 = 0;
        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局（特调 Session）");
                return;
            }

            const context = await loadCharacterWorldFromSession(activeSession.id);
            if (!context) {
                setError("无法从当前对局加载人设信息");
                return;
            }

            // 逐个生成
            for (let i = 0; i < buffer.length; i += 1) {
                const item = buffer[i];
                已完成 = i;
                const enhancedTendency = item.note 
                    ? `${tendency.trim()}。特别说明：${item.note}`
                    : tendency.trim();

                const result = await writeWithSelectedBanner({
                    sessionId: activeSession.id,
                    playerTendency: enhancedTendency || undefined,
                    characterProfile: context.characterProfile,
                    worldSettings: {
                        preface: context.preface,
                        basePrompts: context.basePrompts,
                        flavorPrompts: context.flavorPrompts,
                        glassPrompts: context.glassPrompts,
                        strengthPrompts: context.strengthPrompts,
                    },
                    recentDialogue: context.recentDialogue,
                }, 正文入参(item));

                await handleAdoptBanner(activeSession.id, result.body, 带标记文本(item));
                已完成 = i + 1;
            }
        } catch (err: any) {
            console.error("[NarrativeWriter] Batch write failed:", err);
            setError(
                `第 ${已完成 + 1} 条生成失败：${err.message || "执笔失败"}。已生成的 ${已完成} 条已入对局，后面的没跑。`
            );
        } finally {
            setLoading(false);
        }
    }, [tendency, buffer, handleAdoptBanner]);
    
    // 打开编辑模态框
    const handleOpenEdit = useCallback((type: "memory" | "emotion", card: MemoryCard | EmotionCard) => {
        setEditingCard({ type, card });
        // EmotionCard 没有"内容"字段，用标签+强度作为编辑初值
        setEditContent(type === "memory" ? (card as MemoryCard).内容 ?? "" : `${(card as EmotionCard).标签}(${(card as EmotionCard).强度})`);
    }, []);
    
    // 保存编辑
    const handleSaveEdit = useCallback(async () => {
        if (!editingCard) return;
        if (!dataSessionId) {
            console.warn("[NarrativeWriter] Save edit skipped: 当前没有归属会话");
            return;
        }
        
        try {
            if (editingCard.type === "memory") {
                await updateMemoryCard(dataSessionId, editingCard.card.id, { 内容: editContent });
            } else {
                await updateEmotionCard(dataSessionId, editingCard.card.id, { 内容: editContent } as any);
            }
            setEditingCard(null);
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Save edit failed:", err);
        }
    }, [editingCard, editContent, dataSessionId, loadData]);
    
    // 记忆整理（Map-Reduce 压缩 + 分片提炼记忆卡）：
    // 步骤 = L2 分片 + L3 大纲 + 每片提炼 + 大纲提炼，每步一次 LLM 调用；
    // 剩余时间用已完成步骤的实测均值推算
    const handleCompressMemory = useCallback(async () => {
        setCompressing(true);
        
        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局");
                return;
            }
            
            const turns = activeSession.turns || [];
            const totalTurns = turns.length;
            
            if (totalTurns === 0) {
                setError("当前对局没有对话记录，无法整理");
                return;
            }
            
            const chunks = Math.ceil(totalTurns / NARRATIVE_CHUNK_SIZE);
            const compressSteps = chunks + 1;          // L2 分片 + L3 大纲
            const extractSteps = chunks + 1;           // 每片提炼 + 大纲提炼
            const totalSteps = compressSteps + extractSteps;
            const startedAt = Date.now();
            
            const setPhase = (step: number, phase: string) => {
                // 用最近 N 步的滚动均值，避免第1步冷启动把整体预估拉高
                setRecentStepTimes(prev => {
                    const now = Date.now();
                    const lastTime = prev.length > 0 ? prev[prev.length - 1] : startedAt;
                    const stepTime = now - lastTime;
                    const newTimes = [...prev, stepTime].slice(-ETA_ROLLING_WINDOW);
                    const avgStepTime = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;
                    const etaMs = Math.min((totalSteps - step) * avgStepTime, ETA_CAP_MS);
                    setCompressProgress({ step, totalSteps, phase, etaMs });
                    return newTimes;
                });
            };
            setPhase(0, "准备中");
            
            // 从角色卡获取角色名
            const context = await loadCharacterWorldFromSession(activeSession.id);
            const characterName = context?.characterProfile?.charName || "角色";
            
            // 阶段一：Map-Reduce 压缩
            const { L2_章节摘要, L3_全局大纲 } = await compressNarrativeMemory(
                turns.map(t => ({ role: t.role, text: t.text || "", createdAt: t.createdAt })),
                characterName,
                (current) => setPhase(current, current >= chunks ? "梳理全局大纲" : "生成章节摘要")
            );
            
            // 保存压缩结果
            const hierarchy = await getContextHierarchy(activeSession.id) || {
                L2_章节摘要: [],
                L3_全局大纲: "",
                lastCompressedAt: 0,
                lastCompressedTurn: 0,
            };
            hierarchy.L2_章节摘要 = L2_章节摘要;
            hierarchy.L3_全局大纲 = L3_全局大纲;
            hierarchy.lastCompressedAt = Date.now();
            // 记录本次整理覆盖到第几回合（与引擎里的轮次计数同一量纲）。
            // lastCompressedAt 只用于界面显示时间，不能参与回合差计算。
            hierarchy.lastCompressedTurn = computeCurrentTurn(turns);
            await saveContextHierarchy(activeSession.id, hierarchy);
            
            // 阶段二：分片提炼记忆卡（先成"待核"，在记忆审核里确认后置为生效）
            let savedCount = 0;
            try {
                savedCount = await extractMemoriesFromCompression(
                    activeSession.id,
                    characterName,
                    L3_全局大纲,
                    L2_章节摘要,
                    totalTurns,
                    (done) => setPhase(compressSteps + done, "提炼记忆卡")
                );
                if (savedCount > 0) {
                    console.log(`[NarrativeWriter] 记忆整理产出 ${savedCount} 张待核记忆卡`);
                }
            } catch (extractErr) {
                // 提炼失败不影响压缩结果
                console.error("[NarrativeWriter] Outline memory extraction failed:", extractErr);
            }
            
            // 整理完只提示、不自动跑：初始化台账是新的一笔调用，要不要花由她点头。
            // 大纲为空时连提示都不给——没有可读的整局剧情，点了也只是浪费一次调用。
            setLedgerOffer(!!L3_全局大纲.trim());
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Compress failed:", err);
            setError(err instanceof Error ? err.message : "记忆整理失败");
        } finally {
            setCompressing(false);
            setCompressProgress(null);
        }
    }, [loadData]);

    // 悬念台账操作：剧情态只有两条升级路径——采纳回写，或这里手动改。
    // 抽取器同名输出没有这个权力（它只能记"这条线本轮有进展"）。
    const handleCycleThreadStatus = useCallback(async (card: ThreadCard) => {
        if (!dataSessionId) return;
        const 顺序: ThreadPlotStatus[] = ["潜伏", "升温", "爆发", "收束"];
        const 下一个 = 顺序[(顺序.indexOf(card.线索状态) + 1) % 顺序.length];
        await updateThreadCard(dataSessionId, card.id, { 线索状态: 下一个 });
        await loadData();
    }, [dataSessionId, loadData]);

    const handleEditThreadNextStep = useCallback(async (card: ThreadCard) => {
        if (!dataSessionId) return;
        const 新值 = window.prompt(`改「${card.名称}」的下一步可能（导演视角的一句提示，≤30 字最有效）`, card.下一步可能);
        if (新值 === null) return;
        await updateThreadCard(dataSessionId, card.id, { 下一步可能: 新值.trim() });
        await loadData();
    }, [dataSessionId, loadData]);

    const handleCycleForeshadowStatus = useCallback(async (card: ForeshadowCard) => {
        if (!dataSessionId) return;
        await updateForeshadowCard(dataSessionId, card.id, {
            伏笔状态: card.伏笔状态 === "已收" ? "未收" : "已收",
        });
        await loadData();
    }, [dataSessionId, loadData]);

    const handleConfirmThread = useCallback(async (card: ThreadCard) => {
        if (!dataSessionId) return;
        // 确认只改审核态：这张线进不进得了正文？——永远进不了，它只进导演上下文
        await updateThreadCard(dataSessionId, card.id, { 状态: "生效", 归档原因: undefined });
        await loadData();
    }, [dataSessionId, loadData]);

    const handleConfirmForeshadow = useCallback(async (card: ForeshadowCard) => {
        if (!dataSessionId) return;
        await updateForeshadowCard(dataSessionId, card.id, { 状态: "生效", 归档原因: undefined });
        await loadData();
    }, [dataSessionId, loadData]);

    const handleArchiveThread = useCallback(async (card: ThreadCard) => {
        if (!dataSessionId) return;
        await archiveThreadCard(dataSessionId, card.id, "玩家在面板手动归档");
        await loadData();
    }, [dataSessionId, loadData]);

    const handleArchiveForeshadow = useCallback(async (card: ForeshadowCard) => {
        if (!dataSessionId) return;
        await archiveForeshadowCard(dataSessionId, card.id, "玩家在面板手动归档");
        await loadData();
    }, [dataSessionId, loadData]);

    const handleDeleteThread = useCallback(async (card: ThreadCard) => {
        if (!dataSessionId) return;
        if (!window.confirm(`彻底删除线索「${card.名称}」？删除不可恢复（归档会留下记录）。\n注意：删除不会回滚它已经带来的剧情。`)) return;
        await deleteThreadCard(dataSessionId, card.id);
        await loadData();
    }, [dataSessionId, loadData]);

    const handleDeleteForeshadow = useCallback(async (card: ForeshadowCard) => {
        if (!dataSessionId) return;
        if (!window.confirm(`彻底删除伏笔「${card.内容}」？删除不可恢复（归档会留下记录）。`)) return;
        await deleteForeshadowCard(dataSessionId, card.id);
        await loadData();
    }, [dataSessionId, loadData]);

    // 旧「散落线头」→ 线索卡：显式入口，不做读取时静默迁移（那会让一次渲染变成两次 IO，
    // 而且分叉/删除/备份都可能触发读取，改写数据的时机就变得不可预测）。
    const 散落线头数量 = writerState?.散落线头?.length ?? 0;
    const handleMigrateLooseThreads = useCallback(async () => {
        if (!dataSessionId || 散落线头数量 === 0) return;
        if (!window.confirm(`把 ${散落线头数量} 条「散落线头」转成线索卡？\n原文直接做线索名，一律先成"待核"；同名或空白项会跳过。迁移完成后旧列表清空。`)) return;
        try {
            const 结果 = await migrateLooseThreadsToCards(dataSessionId);
            setError(null);
            alert(`迁移完成：新建 ${结果.新建} 张线索卡，跳过 ${结果.跳过} 条。`);
            await loadData();
        } catch (err) {
            console.error("[NarrativeWriter] 散落线头迁移失败:", err);
            setError("散落线头迁移失败，请稍后重试");
        }
    }, [dataSessionId, 散落线头数量, loadData]);

    // 台账冷启动：一次模型调用，把整局大纲读成"待核"的线索与伏笔。
    // 确认框里的字数不是约数——先用 prepareLedgerTask 把真正要发出去的文本拼一遍
    // （纯读、不调模型、不落盘），她点下去之前看到的就是实际会花的量。
    const handleInitLedger = useCallback(async () => {
        // 防连点走两道：面板 state 管这一处的按钮禁用，模块级互斥管"同一时间只允许一次付费调用"
        if (ledgerBusy || isLedgerInitializing()) return;
        const activeSession = getActiveMixSession();
        const sid = dataSessionId ?? activeSession?.id ?? null;
        if (!sid || !activeSession) {
            setError("请先打开一个对局");
            return;
        }
        const 轮次 = computeCurrentTurn(activeSession.turns || []);

        let 输入字数 = 0;
        try {
            const 准备 = await prepareLedgerTask({
                sessionId: sid,
                当前角色名: currentCharName,
                玩家名: currentPlayerName,
                当前轮次: 轮次,
            });
            if (!准备) {
                setLedgerNotice({ text: "还没有剧情大纲。先点「记忆整理」生成大纲，再初始化台账。", bad: true });
                return;
            }
            输入字数 = 准备.任务文本.length;
        } catch (err) {
            console.error("[NarrativeWriter] 台账素材拼装失败:", err);
            setLedgerNotice({ text: "台账素材读取失败，本次没有调用模型", bad: true });
            return;
        }

        if (!window.confirm(
            `将调用一次模型：输入约 ${输入字数} 字（另有 ${LEDGER_SYSTEM_PROMPT_CHARS} 字规则），输出最多 6 条线索、4 条伏笔。\n\n` +
            `产出的卡一律先标"待核"——会带着待核标注进走向卡当导演素材，但永远不进正文；\n` +
            `同名的已有卡不会被覆盖，已生效的卡与正文都不受影响。\n\n确认后立即发起。`
        )) return;

        setLedgerBusy(true);
        setLedgerNotice(null);
        setError(null);
        try {
            const 结果 = await initThreadLedgerFromOutline({
                sessionId: sid,
                当前角色名: currentCharName,
                玩家名: currentPlayerName,
                当前轮次: 轮次,
            });
            // 失败不自动重试：可能是超时（请求已经发出去了），要不要再花一次由她决定
            setLedgerNotice({
                text: 结果.提示 ?? (结果.失败 ? "台账初始化失败，本次没有写入台账" : "台账初始化完成"),
                bad: !!结果.失败,
            });
            setLedgerOffer(false);
            await loadData();
        } catch (err) {
            console.error("[NarrativeWriter] 台账初始化失败:", err);
            setLedgerNotice({ text: "台账初始化失败，本次没有写入台账", bad: true });
        } finally {
            setLedgerBusy(false);
        }
    }, [ledgerBusy, dataSessionId, currentCharName, currentPlayerName, loadData]);

    // 手动新增（#36 的最小表单）：她亲笔填的就是结论，保存即生效，
    // 不再压一层"待核"逼她去审核里多点一次。
    const openManualForm = useCallback((kind: "thread" | "foreshadow") => {
        setManualForm(prev => (prev === kind ? null : kind));
        setLedgerNotice(null);
        // 关联角色预填当前角色名、可清空：多数线头都挂在她正在面对的这个人身上
        if (kind === "thread") setManualThreadRoles(currentCharName);
    }, [currentCharName]);

    const handleAddManualThread = useCallback(async () => {
        if (!dataSessionId) return;
        const 结果 = await createManualThread({
            sessionId: dataSessionId,
            名称: manualThreadName,
            关联角色: manualThreadRoles.split(/[,，、;；\s]+/).filter(Boolean),
            下一步可能: manualThreadNext,
            当前轮次: computeCurrentTurn(getActiveMixSession()?.turns || []),
        });
        if (!结果.ok) {
            setLedgerNotice({ text: 结果.提示 ?? "新增线索失败", bad: true });
            return;
        }
        setManualForm(null);
        setManualThreadName("");
        setManualThreadNext("");
        setLedgerNotice({ text: `已新增线索「${结果.卡?.名称 ?? ""}」，直接生效`, bad: false });
        await loadData();
    }, [dataSessionId, manualThreadName, manualThreadRoles, manualThreadNext, loadData]);

    const handleAddManualForeshadow = useCallback(async () => {
        if (!dataSessionId) return;
        const 结果 = await createManualForeshadow({
            sessionId: dataSessionId,
            内容: manualForeshadowContent,
            关联线索名称: manualForeshadowThread,
            当前轮次: computeCurrentTurn(getActiveMixSession()?.turns || []),
        });
        if (!结果.ok) {
            setLedgerNotice({ text: 结果.提示 ?? "新增伏笔失败", bad: true });
            return;
        }
        setManualForm(null);
        setManualForeshadowContent("");
        setManualForeshadowThread("");
        setLedgerNotice({ text: `已新增伏笔「${结果.卡?.内容 ?? ""}」，直接生效`, bad: false });
        await loadData();
    }, [dataSessionId, manualForeshadowContent, manualForeshadowThread, loadData]);

    // 待核数量：四类分开算。按钮与弹窗都用同一份，改一处不会和另一处分叉。
    const 待核数量 = {
        记忆: memories.filter(m => m.状态 === "待核").length,
        情感: emotions.filter(e => e.状态 === "待核").length,
        线索: threads.filter(t => t.状态 === "待核").length,
        伏笔: foreshadows.filter(f => f.状态 === "待核").length,
    };
    const 待核合计 = 待核数量.记忆 + 待核数量.情感 + 待核数量.线索 + 待核数量.伏笔;

    // 批量确认待核卡：把当前会话所有"待核"一次性转为"生效"。
    // 后果必须在弹窗里写清楚——生效后这些卡就进正文上下文，角色会把它们当作已知事实使用；
    // 这不是"一键清空待办"，是替角色认领一批记忆。归档/冲突/陈旧一律不碰。
    const handleConfirmAllPending = useCallback(async () => {
        if (confirmingPending) return;

        const activeSession = getActiveMixSession();
        if (!activeSession) {
            setError("请先打开一个对局");
            return;
        }

        const { 记忆: 待核记忆, 情感: 待核情感, 线索: 待核线索, 伏笔: 待核伏笔 } = 待核数量;
        const 合计 = 待核合计;
        if (合计 === 0) return;

        // 四类数量分开写：记忆/情感进正文（角色会当作已知事实），线索/伏笔只进导演上下文
        // （确认它们不会让角色知道这条线存在）。混成一句"都会进正文"就是误导。
        if (!window.confirm(
            `确认这 ${合计} 张待核卡？\n` +
            `· 记忆 ${待核记忆} 张、情感 ${待核情感} 张 —— 确认后进入正文上下文，角色会把它们当作已知事实使用。\n` +
            `· 线索 ${待核线索} 张、伏笔 ${待核伏笔} 张 —— 确认后只进入导演上下文，角色永远读不到。\n` +
            `只处理当前对局；已归档 / 冲突 / 陈旧的卡不受影响。`
        )) return;

        setConfirmingPending(true);
        setError(null);
        try {
            const done = await confirmAllPendingCards(activeSession.id);
            console.log(`[NarrativeWriter] 批量确认待核卡：记忆 ${done.memories}、情感 ${done.emotions}、线索 ${done.threads}、伏笔 ${done.foreshadows} 转为生效`);
            await loadData();
            void loadRecommendations();
        } catch (err) {
            console.error("[NarrativeWriter] 批量确认待核卡失败:", err);
            setError("批量确认失败，请稍后重试");
        } finally {
            setConfirmingPending(false);
        }
    }, [confirmingPending, 待核数量, 待核合计, loadData, loadRecommendations]);

    // 补抽历史：整局按每4轮一批喂给逐轮抽取器，恢复抽取通道损坏期间丢失的记忆。
    // 一次性工具，会真实产生多次 LLM 调用，先确认再跑；与记忆整理互斥
    const handleBackfill = useCallback(async () => {
        if (compressing || backfilling) return;
        
        const activeSession = getActiveMixSession();
        if (!activeSession) {
            setError("请先打开一个对局");
            return;
        }
        
        const dialogueTurns = (activeSession.turns || []).filter(t => (t.role === "user" || t.role === "assistant") && (t.text || "").trim());
        if (dialogueTurns.length === 0) {
            setError("当前对局没有对话记录，无法补抽");
            return;
        }
        
        const batches = Math.ceil(dialogueTurns.length / 4);
        if (!window.confirm(`补抽历史：将整局 ${dialogueTurns.length} 轮对话按每4轮一批喂给抽取器，约 ${batches} 次 LLM 调用（预计 ${Math.max(1, Math.round(batches * 0.2))} 分钟起）。\n产出的记忆卡以"待核"入库，可审核后生效。继续？`)) {
            return;
        }
        
        setBackfilling(true);
        setError(null);
        const startedAt = Date.now();
        setCompressProgress({ step: 0, totalSteps: batches, phase: "补抽历史", etaMs: 0 });
        
        try {
            const context = await loadCharacterWorldFromSession(activeSession.id);
            const { memories, emotions } = await backfillExtraction(
                activeSession.id,
                dialogueTurns.map(t => ({ role: t.role, text: t.text || "" })),
                {
                    characterName: context?.characterProfile?.charName || "角色",
                    userName: activeSession.userName || "你",
                    worldText: context?.characterProfile?.worldText || "",
                    currentState: activeSession.state,
                },
                (done, total) => {
                    setRecentStepTimes(prev => {
                        const now = Date.now();
                        const lastTime = prev.length > 0 ? prev[prev.length - 1] : startedAt;
                        const stepTime = now - lastTime;
                        const newTimes = [...prev, stepTime].slice(-ETA_ROLLING_WINDOW);
                        const avgStepTime = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;
                        const etaMs = Math.min((total - done) * avgStepTime, ETA_CAP_MS);
                        setCompressProgress({
                            step: done,
                            totalSteps: total,
                            phase: "补抽历史",
                            etaMs,
                        });
                        return newTimes;
                    });
                }
            );
            console.log(`[NarrativeWriter] 补抽完成：新增记忆卡 ${memories} 张、情感卡 ${emotions} 张（待核）`);
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Backfill failed:", err);
            setError(err instanceof Error ? err.message : "补抽失败");
        } finally {
            setBackfilling(false);
            setCompressProgress(null);
        }
    }, [compressing, backfilling, loadData]);
    
    // 深度抽取：手动触发，用完整上下文（小票 + 尾调 + 状态）做深度分析
    const handleDeepExtract = useCallback(async () => {
        if (compressing || backfilling || deepExtracting) return;
        
        const activeSession = getActiveMixSession();
        if (!activeSession) {
            setError("请先打开一个对局");
            return;
        }
        
        const recentTurns = (activeSession.turns || []).slice(-20).map(t => ({
            role: t.role,
            text: t.text || "",
            ticketRaw: t.ticketRaws?.[0]?.raw,
        }));
        
        if (recentTurns.length === 0) {
            setError("当前对局没有对话记录");
            return;
        }
        
        setDeepExtracting(true);
        setError(null);
        const probeStart = Date.now();
        
        try {
            const context = await loadCharacterWorldFromSession(activeSession.id);
            const lastTurn = recentTurns[recentTurns.length - 1];
            
            await deepExtractFromNarrativeBody(
                activeSession.id,
                lastTurn.text,
                recentTurns,
                {
                    characterName: context?.characterProfile?.charName || "角色",
                    userName: activeSession.userName || "你",
                    worldText: context?.characterProfile?.worldText || "",
                    currentState: activeSession.state,
                }
            );
            
            const totalElapsed = Date.now() - probeStart;
            console.log(`[DeepTrack:Panel] Total UI time: ${totalElapsed}ms`);
            setLastDeepExtractAt(Date.now());
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Deep extraction failed:", err);
            setError(err instanceof Error ? err.message : "深度抽取失败");
        } finally {
            setDeepExtracting(false);
        }
    }, [compressing, backfilling, deepExtracting, loadData]);
    
    // 查看深度抽取日志
    const handleViewLogs = useCallback(() => {
        try {
            const logs = JSON.parse(localStorage.getItem('deepExtractLogs') || '[]');
            if (logs.length === 0) {
                alert('暂无深度抽取日志');
                return;
            }
            const logText = logs.map((l: any) => `${new Date(l.ts).toLocaleTimeString()} ${l.msg}`).join('\n');
            alert(`最近 ${logs.length} 条深度抽取日志：\n\n${logText.slice(-2000)}`); // 显示最后 2000 字符
        } catch {
            alert('读取日志失败');
        }
    }, []);
    
    // 根据选中的报幕生成正文（选择模式第二步）
    const handleWriteWithBanner = useCallback(async () => {
        if (selectedBannerIndex === null) return;
        
        const selected = bannerOptions[selectedBannerIndex];
        if (!selected) return;
        
        setLoading(true);
        setError(null);

        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) {
                setError("请先打开一个对局（特调 Session）");
                return;
            }

            const context = await loadCharacterWorldFromSession(activeSession.id);
            if (!context) {
                setError("无法从当前对局加载人设信息");
                return;
            }

            // 将批注追加到玩家倾向中
            const enhancedTendency = selected.note 
                ? `${tendency.trim()}。特别说明：${selected.note}`
                : tendency.trim();

            const result = await writeWithSelectedBanner({
                sessionId: activeSession.id,
                playerTendency: enhancedTendency || undefined,
                characterProfile: context.characterProfile,
                worldSettings: {
                    preface: context.preface,
                    basePrompts: context.basePrompts,
                    flavorPrompts: context.flavorPrompts,
                    glassPrompts: context.glassPrompts,
                    strengthPrompts: context.strengthPrompts,
                },
                recentDialogue: context.recentDialogue,
            }, 正文入参(selected));

            setOutput({ banner: result.banner, body: result.body });
            // 带标记文本：标记只用于回写台账，入对局的正文由 applyAdoptedBanner 剥净
            await handleAdoptBanner(activeSession.id, result.body, 带标记文本(selected));
            
            // 重置选择状态
            setBannerOptions([]);
            setSelectedBannerIndex(null);
        } catch (err: any) {
            console.error("[NarrativeWriter] Write with banner failed:", err);
            setError(err.message || "执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency, selectedBannerIndex, bannerOptions, handleAdoptBanner]);

    if (!writerEnabled) return null;

    return (
        <div
            ref={ref}
            className="narrative-writer-panel"
            style={{
                display: open ? "flex" : "none",
                position: "absolute",
                left: rect.x,
                top: rect.y,
                width: Math.min(rect.w, MAX_W),
                height: rect.h,
                maxWidth: MAX_W,
                zIndex: 9999,
                background: "rgba(20, 20, 30, 0.95)",
                backdropFilter: "blur(12px)",
                borderRadius: "12px",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
                flexDirection: "column",
                overflow: "hidden",
            }}
        >
            {/* 标题栏（可拖动） */}
            <div
                className="nwp-header"
                onPointerDown={onDragPointerDown}
                onPointerMove={onDragPointerMove}
                onPointerUp={onDragPointerEnd}
                style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                    cursor: "move",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    userSelect: "none",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Feather size={18} strokeWidth={1.8} color="#a78bfa" />
                    <span style={{ fontWeight: 600, fontSize: "14px", color: "#e5e7eb" }}>执笔</span>
                    
                    {/* 标签页切换 */}
                    <div style={{ display: "flex", gap: "4px", marginLeft: "12px" }}>
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { 
                                e.stopPropagation(); 
                                setActiveTab("write"); 
                            }}
                            style={{
                                padding: "2px 8px",
                                background: activeTab === "write" ? "rgba(167, 139, 250, 0.3)" : "transparent",
                                border: "none",
                                borderRadius: "4px",
                                color: activeTab === "write" ? "#c4b5fd" : "#6b7280",
                                fontSize: "11px",
                                cursor: "pointer",
                            }}
                        >
                            书写
                        </button>
                        <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { 
                                e.stopPropagation(); 
                                setActiveTab("data"); 
                            }}
                            style={{
                                padding: "2px 8px",
                                background: activeTab === "data" ? "rgba(167, 139, 250, 0.3)" : "transparent",
                                border: "none",
                                borderRadius: "4px",
                                color: activeTab === "data" ? "#c4b5fd" : "#6b7280",
                                fontSize: "11px",
                                cursor: "pointer",
                            }}
                        >
                            数据
                        </button>
                    </div>
                </div>
                <button
                    onClick={(e) => {
                        e.stopPropagation(); // 阻止拖拽事件冒泡
                        setOpen(false);
                    }}
                    onPointerDown={(e) => e.stopPropagation()} // 阻止拖拽捕获
                    style={{
                        background: "none",
                        border: "none",
                        color: "#9ca3af",
                        cursor: "pointer",
                        padding: "4px",
                        display: "flex",
                        alignItems: "center",
                    }}
                >
                    <X size={18} />
                </button>
            </div>

            {/* 常驻提示：有旧记忆待归属（选了"稍后"或当前无活动会话时不再自动弹，但一直留着入口） */}
            {legacyPending && !migrationOpen && (
                <div
                    onClick={() => void openMigrationFromHint()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openMigrationFromHint(); } }}
                    style={{
                        padding: "9px 14px",
                        background: "rgba(245, 158, 11, 0.12)",
                        borderBottom: "1px solid rgba(245, 158, 11, 0.25)",
                        color: "#fbbf24",
                        fontSize: "12px",
                        lineHeight: 1.5,
                        cursor: migrationHasActive ? "pointer" : "default",
                    }}
                >
                    {migrationHasActive ? (
                        <>有旧记忆待归属 →　点击选择它们属于哪场聊天</>
                    ) : (
                        <>有旧记忆待归属。请先在特调里打开或新建一场对局，再来选择它们属于哪个聊天。</>
                    )}
                </div>
            )}

            {/* 旧记忆归属迁移弹窗（任务 #20） */}
            {migrationOpen && (
                <LegacyMigrationDialog
                    sessions={migrationSessions}
                    onMigrated={handleMigrationMigrated}
                    onDeferred={() => void handleMigrationClose()}
                />
            )}

            {/* 内容区 */}
            <div
                style={{
                    flex: 1,
                    overflow: "auto",
                    padding: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                }}
            >
                {activeTab === "write" ? (
                    // 书写标签页
                    <>
                        {/* 模式切换 */}
                        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                            <button
                                onClick={() => { setMode("direct"); setBannerOptions([]); setSelectedBannerIndex(null); }}
                                style={{
                                    flex: 1,
                                    padding: "6px 12px",
                                    background: mode === "direct" ? "rgba(167, 139, 250, 0.3)" : "rgba(255, 255, 255, 0.05)",
                                    border: `1px solid ${mode === "direct" ? "rgba(167, 139, 250, 0.5)" : "rgba(255, 255, 255, 0.1)"}`,
                                    borderRadius: "6px",
                                    color: mode === "direct" ? "#c4b5fd" : "#6b7280",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                }}
                            >
                                直接生成
                            </button>
                            <button
                                onClick={() => { setMode("select"); setOutput(null); }}
                                style={{
                                    flex: 1,
                                    padding: "6px 12px",
                                    background: mode === "select" ? "rgba(167, 139, 250, 0.3)" : "rgba(255, 255, 255, 0.05)",
                                    border: `1px solid ${mode === "select" ? "rgba(167, 139, 250, 0.5)" : "rgba(255, 255, 255, 0.1)"}`,
                                    borderRadius: "6px",
                                    color: mode === "select" ? "#c4b5fd" : "#6b7280",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                }}
                            >
                                先选报幕
                            </button>
                        </div>
                        
                        {/* 素材库：代码从记忆库拼的钩子，点一下只往「自定义补充」里填一句话。
                            它不是方向候选——方向候选只有走向卡（先选报幕那一步）。 */}
                        <div>
                            <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span>🧩 素材库（代码从记忆库拼的画面，不是推荐方向）</span>
                                <button
                                    onClick={loadRecommendations}
                                    disabled={loadingRecommendations}
                                    style={{
                                        background: "none",
                                        border: "none",
                                        color: "#a78bfa",
                                        fontSize: "10px",
                                        cursor: loadingRecommendations ? "not-allowed" : "pointer",
                                        padding: "2px 6px",
                                    }}
                                >
                                    {loadingRecommendations ? "刷新中..." : "刷新"}
                                </button>
                            </label>
                            
                            {sceneRecommendations.length === 0 && !loadingRecommendations && (
                                <div style={{ fontSize: "11px", color: "#6b7280", padding: "8px", textAlign: "center" }}>
                                    暂无素材，直接手写补充，或者用上面的走向卡挑方向
                                </div>
                            )}
                            
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                {sceneRecommendations.map((scene) => (
                                    <div
                                        key={scene.id}
                                        style={{
                                            padding: "8px 10px",
                                            background: selectedScene === scene.id ? "rgba(167, 139, 250, 0.2)" : "rgba(255, 255, 255, 0.03)",
                                            border: `1px solid ${selectedScene === scene.id ? "rgba(167, 139, 250, 0.5)" : "rgba(255, 255, 255, 0.08)"}`,
                                            borderRadius: "6px",
                                            cursor: "pointer",
                                        }}
                                        onClick={() => handleSelectScene(scene)}
                                    >
                                        {/* 标题行：对象 · 功能 */}
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                                            <span style={{ fontSize: "12px", color: "#e5e7eb", fontWeight: 600 }}>
                                                {scene.interactionType === 'social' ? '💕' : scene.interactionType === 'external' ? '⚡' : '🌿'} {scene.title}
                                            </span>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleEditScene(scene);
                                                }}
                                                style={{
                                                    background: "none",
                                                    border: "none",
                                                    color: "#6b7280",
                                                    fontSize: "10px",
                                                    cursor: "pointer",
                                                    padding: "2px 4px",
                                                }}
                                                title="微调"
                                            >
                                                ✏️
                                            </button>
                                        </div>
                                        {/* 意图说明 */}
                                        <div style={{ fontSize: "10px", color: "#9ca3af", marginBottom: "4px" }}>
                                            {scene.description}
                                        </div>
                                        {/* 钩子画面：具体情境描写 */}
                                        <div style={{
                                            fontSize: "11px",
                                            color: "#c4b5fd",
                                            background: "rgba(167, 139, 250, 0.08)",
                                            borderLeft: "2px solid rgba(167, 139, 250, 0.4)",
                                            padding: "4px 8px",
                                            borderRadius: "0 4px 4px 0",
                                            marginBottom: "6px",
                                            lineHeight: "1.5",
                                        }}>
                                            {scene.hook}
                                        </div>
                                        {/* 维度切换：焦点/张力/时间 */}
                                        {scene.dimensions && (
                                            <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "6px" }}>
                                                {scene.dimensions.focus && scene.dimensions.focus.length > 1 && (
                                                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                                                        {scene.dimensions.focus.map(f => (
                                                            <button
                                                                key={f}
                                                                onClick={(e) => { e.stopPropagation(); handleToggleDimension(scene.id, 'focus', f); }}
                                                                style={{
                                                                    padding: "2px 6px",
                                                                    background: (selectedDimensions[scene.id]?.focus || scene.defaultDimension?.focus) === f ? "rgba(167, 139, 250, 0.3)" : "rgba(255,255,255,0.05)",
                                                                    border: `1px solid ${(selectedDimensions[scene.id]?.focus || scene.defaultDimension?.focus) === f ? "rgba(167, 139, 250, 0.6)" : "transparent"}`,
                                                                    borderRadius: "3px",
                                                                    color: (selectedDimensions[scene.id]?.focus || scene.defaultDimension?.focus) === f ? "#c4b5fd" : "#6b7280",
                                                                    fontSize: "9px",
                                                                    cursor: "pointer",
                                                                }}
                                                            >
                                                                {f}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {scene.dimensions.intensity && scene.dimensions.intensity.length > 1 && (
                                                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                                                        {scene.dimensions.intensity.map(i => (
                                                            <button
                                                                key={i}
                                                                onClick={(e) => { e.stopPropagation(); handleToggleDimension(scene.id, 'intensity', i); }}
                                                                style={{
                                                                    padding: "2px 6px",
                                                                    background: (selectedDimensions[scene.id]?.intensity || scene.defaultDimension?.intensity) === i ? "rgba(239, 68, 68, 0.3)" : "rgba(255,255,255,0.05)",
                                                                    border: `1px solid ${(selectedDimensions[scene.id]?.intensity || scene.defaultDimension?.intensity) === i ? "rgba(239, 68, 68, 0.6)" : "transparent"}`,
                                                                    borderRadius: "3px",
                                                                    color: (selectedDimensions[scene.id]?.intensity || scene.defaultDimension?.intensity) === i ? "#fca5a5" : "#6b7280",
                                                                    fontSize: "9px",
                                                                    cursor: "pointer",
                                                                }}
                                                            >
                                                                {i}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {scene.dimensions.tempo && scene.dimensions.tempo.length > 1 && (
                                                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                                                        {scene.dimensions.tempo.map(t => (
                                                            <button
                                                                key={t}
                                                                onClick={(e) => { e.stopPropagation(); handleToggleDimension(scene.id, 'tempo', t); }}
                                                                style={{
                                                                    padding: "2px 6px",
                                                                    background: (selectedDimensions[scene.id]?.tempo || scene.defaultDimension?.tempo) === t ? "rgba(59, 130, 246, 0.3)" : "rgba(255,255,255,0.05)",
                                                                    border: `1px solid ${(selectedDimensions[scene.id]?.tempo || scene.defaultDimension?.tempo) === t ? "rgba(59, 130, 246, 0.6)" : "transparent"}`,
                                                                    borderRadius: "3px",
                                                                    color: (selectedDimensions[scene.id]?.tempo || scene.defaultDimension?.tempo) === t ? "#93c5fd" : "#6b7280",
                                                                    fontSize: "9px",
                                                                    cursor: "pointer",
                                                                }}
                                                            >
                                                                {t}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {/* 预期效果 + 风格 */}
                                        <div style={{ fontSize: "10px", color: "#6b7280", display: "flex", justifyContent: "space-between" }}>
                                            <span>预期：{scene.expectedOutcome}</span>
                                            <span>{scene.style.tone} · {scene.style.pace}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 玩家倾向输入 */}
                        <div>
                            <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "4px", display: "block" }}>
                                自定义补充（可选）
                            </label>
                            <textarea
                                value={tendency}
                                onChange={(e) => setTendency(e.target.value)}
                                placeholder="上方按钮已填入的内容会显示在这里，你也可以手动补充..."
                                style={{
                                    width: "100%",
                                    minHeight: "50px",
                                    maxHeight: "80px",
                                    padding: "8px 10px",
                                    background: "rgba(255, 255, 255, 0.05)",
                                    border: "1px solid rgba(255, 255, 255, 0.1)",
                                    borderRadius: "6px",
                                    color: "#e5e7eb",
                                    fontSize: "12px",
                                    resize: "vertical",
                                    fontFamily: "inherit",
                                    lineHeight: "1.5",
                                }}
                            />
                        </div>

                        {/* 执笔按钮 / 报幕生成按钮 */}
                        {mode === "direct" ? (
                            <button
                                onClick={handleWrite}
                                disabled={loading}
                                style={{
                                    padding: "10px 16px",
                                    background: loading ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                    border: "none",
                                    borderRadius: "8px",
                                    color: "#fff",
                                    fontWeight: 600,
                                    fontSize: "14px",
                                    cursor: loading ? "not-allowed" : "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px",
                                }}
                            >
                                {loading ? (
                                    <>
                                        <Loader2 size={16} className="animate-spin" />
                                        书写中...
                                    </>
                                ) : (
                                    <>
                                        <Feather size={16} />
                                        执笔
                                    </>
                                )}
                            </button>
                        ) : (
                            // 选择模式：未生成报幕时显示"生成报幕选项"按钮
                            bannerOptions.length === 0 ? (
                                <button
                                    onClick={handleGenerateBanners}
                                    disabled={generatingBanners}
                                    style={{
                                        padding: "10px 16px",
                                        background: generatingBanners ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                        border: "none",
                                        borderRadius: "8px",
                                        color: "#fff",
                                        fontWeight: 600,
                                        fontSize: "14px",
                                        cursor: generatingBanners ? "not-allowed" : "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                    }}
                                >
                                    {generatingBanners ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            生成选项中...
                                        </>
                                    ) : (
                                        <>
                                            <Feather size={16} />
                                            生成报幕选项
                                        </>
                                    )}
                                </button>
                            ) : null
                        )}
                        
                        {/* 选择模式：走向卡列表。类型与目标由代码分配，报幕可编辑 */}
                        {mode === "select" && bannerOptions.length > 0 && (
                            <div style={{ marginTop: "8px" }}>
                                <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", display: "block" }}>
                                    走向卡（类型与目标由代码分配；报幕可改，批注写你想看到的细节）
                                </label>
                                {selectedBannerIndex === null && (
                                    <div style={{ fontSize: "11px", color: "#a78bfa", marginBottom: "8px", padding: "6px 8px", background: "rgba(167, 139, 250, 0.1)", borderRadius: "4px" }}>
                                        💡 点击任意报幕卡片选中它，下方会出现「根据选中报幕生成正文」按钮
                                    </div>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    {bannerOptions.map((option, idx) => {
                                        const inBuffer = buffer.some(b => b.id === option.id);
                                        const 卡 = option.候选?.卡;
                                        return (
                                            <div
                                                key={idx}
                                                onClick={() => setSelectedBannerIndex(idx)}
                                                style={{
                                                    padding: "12px",
                                                    background: selectedBannerIndex === idx ? "rgba(167, 139, 250, 0.15)" : "rgba(255, 255, 255, 0.03)",
                                                    border: `2px solid ${selectedBannerIndex === idx ? "rgba(167, 139, 250, 0.6)" : "rgba(255, 255, 255, 0.1)"}`,
                                                    borderRadius: "8px",
                                                    cursor: "pointer",
                                                    position: "relative",
                                                }}
                                            >
                                                {/* 缓冲区复选框 */}
                                                <button
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleBuffer(option);
                                                    }}
                                                    style={{
                                                        position: "absolute",
                                                        top: "-8px",
                                                        left: "-8px",
                                                        width: "24px",
                                                        height: "24px",
                                                        borderRadius: "50%",
                                                        background: inBuffer ? "#a78bfa" : "rgba(255, 255, 255, 0.1)",
                                                        border: `2px solid ${inBuffer ? "#a78bfa" : "rgba(255, 255, 255, 0.3)"}`,
                                                        color: "#fff",
                                                        fontSize: "14px",
                                                        fontWeight: 700,
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        cursor: "pointer",
                                                        boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
                                                        zIndex: 10,
                                                    }}
                                                    title={inBuffer ? "已从缓冲区移除" : "加入缓冲区"}
                                                >
                                                    {inBuffer ? "✓" : "+"}
                                                </button>
                                                
                                                {/* 选中标记 */}
                                            {selectedBannerIndex === idx && (
                                                <div style={{
                                                    position: "absolute",
                                                    top: "-8px",
                                                    right: "-8px",
                                                    background: "#a78bfa",
                                                    color: "#fff",
                                                    fontSize: "10px",
                                                    fontWeight: 600,
                                                    padding: "2px 8px",
                                                    borderRadius: "10px",
                                                    boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
                                                }}>
                                                    ✓ 已选中
                                                </div>
                                            )}
                                            
                                            {/* 卡的身份：类型/变化/代价/目标/分寸。
                                                这些都留在候选列表里，绝不进正文提示词（角色读不到台账）。 */}
                                            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "6px" }}>
                                                <span style={{
                                                    fontSize: "10px",
                                                    fontWeight: 700,
                                                    color: "#c4b5fd",
                                                    background: "rgba(167, 139, 250, 0.18)",
                                                    border: "1px solid rgba(167, 139, 250, 0.4)",
                                                    borderRadius: "4px",
                                                    padding: "1px 6px",
                                                }}>
                                                    {option.候选?.类型 ?? "无类型"}
                                                </span>
                                                {option.候选?.形态 === "骨架" && (
                                                    <span
                                                        title="模型没写这一行，报幕是代码补的占位；这张卡采纳时不会回写台账"
                                                        style={{ fontSize: "10px", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.5)", borderRadius: "4px", padding: "1px 6px" }}
                                                    >
                                                        骨架
                                                    </span>
                                                )}
                                                {option.候选?.形态 === "纯文本" && (
                                                    <span
                                                        title="模型完全没按格式写，整批只展示不回写"
                                                        style={{ fontSize: "10px", color: "#9ca3af", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px", padding: "1px 6px" }}
                                                    >
                                                        纯文本 · 不回写
                                                    </span>
                                                )}
                                                {option.候选?.可回写 && (
                                                    <span
                                                        title="采纳后这条线会往前推进一级（每次最多一级，永不自动收束）"
                                                        style={{ fontSize: "10px", color: "#34d399", border: "1px solid rgba(16,185,129,0.4)", borderRadius: "4px", padding: "1px 6px" }}
                                                    >
                                                        可回写
                                                    </span>
                                                )}
                                            </div>
                                            {卡 && (
                                                <div style={{ fontSize: "10px", color: "#9ca3af", lineHeight: 1.6, marginBottom: "6px" }}>
                                                    <div style={{ color: "#e5e7eb", fontWeight: 600 }}>{option.候选?.标题 || "（模型没给标题）"}</div>
                                                    {option.候选?.变化 ? <div>发生的变化：{option.候选.变化}</div> : null}
                                                    {option.候选?.代价 ? <div>代价：{option.候选.代价}</div> : null}
                                                    <div>
                                                        目标：{卡.目标?.名称 ?? "没有具体对象，按当前场面自由发挥"}
                                                        {卡.已替换 ? `（本批没有${卡.计划类型}的对象，已改为${卡.类型}）` : ""}
                                                    </div>
                                                    {卡.上限 ? <div>分寸：{卡.上限}</div> : null}
                                                </div>
                                            )}

                                            {/* 报幕文本编辑框 */}
                                            <textarea
                                                value={option.报幕}
                                                onChange={(e) => updateBannerText(idx, e.target.value)}
                                                onClick={(e) => e.stopPropagation()}
                                                placeholder="报幕内容..."
                                                style={{
                                                    width: "100%",
                                                    minHeight: "40px",
                                                    maxHeight: "80px",
                                                    padding: "8px 10px",
                                                    background: "rgba(255, 255, 255, 0.05)",
                                                    border: "1px solid rgba(255, 255, 255, 0.1)",
                                                    borderRadius: "6px",
                                                    color: selectedBannerIndex === idx ? "#c4b5fd" : "#9ca3af",
                                                    fontSize: "13px",
                                                    resize: "vertical",
                                                    fontFamily: "inherit",
                                                    lineHeight: "1.5",
                                                    marginBottom: "8px",
                                                }}
                                            />
                                            
                                            {/* 批注输入框 */}
                                            <textarea
                                                value={option.note || ""}
                                                onChange={(e) => updateBannerNote(idx, e.target.value)}
                                                onClick={(e) => e.stopPropagation()}
                                                placeholder="批注：告诉 AI 这个方向的具体要求、你想看到的内容、或者任何补充说明..."
                                                style={{
                                                    width: "100%",
                                                    minHeight: "36px",
                                                    maxHeight: "100px",
                                                    padding: "8px 10px",
                                                    background: "rgba(167, 139, 250, 0.08)",
                                                    border: "1px dashed rgba(167, 139, 250, 0.3)",
                                                    borderRadius: "6px",
                                                    color: "#d1d5db",
                                                    fontSize: "12px",
                                                    resize: "vertical",
                                                    fontFamily: "inherit",
                                                    lineHeight: "1.5",
                                                }}
                                            />
                                        </div>
                                    );
                                    })}
                                </div>
                                {/* 换一批：再调一次生成，按下一组类型重排；旧卡由 handleGenerateBanners 清空，不累积 */}
                                <button
                                    onClick={handleGenerateBanners}
                                    disabled={generatingBanners || loading}
                                    title="按下一组类型重新生成三张，旧的这一批会清掉（已放进缓冲区的保留）"
                                    style={{
                                        marginTop: "10px",
                                        width: "100%",
                                        padding: "8px 12px",
                                        background: "rgba(255, 255, 255, 0.05)",
                                        border: "1px solid rgba(255, 255, 255, 0.15)",
                                        borderRadius: "6px",
                                        color: generatingBanners ? "#6b7280" : "#c4b5fd",
                                        fontSize: "12px",
                                        cursor: generatingBanners || loading ? "not-allowed" : "pointer",
                                    }}
                                >
                                    {generatingBanners ? "换一批中..." : "🔄 换一批（下一组类型）"}
                                </button>
                            </div>
                        )}
                        
                        {/* 选择模式：选中报幕后显示生成按钮 */}
                        {mode === "select" && selectedBannerIndex !== null && bannerOptions.length > 0 && (
                            <button
                                onClick={handleWriteWithBanner}
                                disabled={loading}
                                style={{
                                    padding: "10px 16px",
                                    background: loading ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                    border: "none",
                                    borderRadius: "8px",
                                    color: "#fff",
                                    fontWeight: 600,
                                    fontSize: "14px",
                                    cursor: loading ? "not-allowed" : "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "8px",
                                    marginTop: "8px",
                                }}
                            >
                                {loading ? (
                                    <>
                                        <Loader2 size={16} className="animate-spin" />
                                        书写中...
                                    </>
                                ) : (
                                    <>
                                        <Feather size={16} />
                                        根据选中报幕生成正文
                                    </>
                                )}
                            </button>
                        )}
                        
                        {/* 缓冲区入口按钮 */}
                        {mode === "select" && buffer.length > 0 && (
                            <button
                                onClick={() => setShowBuffer(!showBuffer)}
                                style={{
                                    padding: "8px 12px",
                                    background: showBuffer ? "rgba(167, 139, 250, 0.2)" : "rgba(255, 255, 255, 0.05)",
                                    border: `1px solid ${showBuffer ? "rgba(167, 139, 250, 0.4)" : "rgba(255, 255, 255, 0.1)"}`,
                                    borderRadius: "6px",
                                    color: "#c4b5fd",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    marginTop: "8px",
                                }}
                            >
                                <span>📦 报幕缓冲区 ({buffer.length})</span>
                                <span>{showBuffer ? "收起" : "展开"}</span>
                            </button>
                        )}
                        
                        {/* 缓冲区面板 */}
                        {mode === "select" && showBuffer && buffer.length > 0 && (
                            <div style={{
                                marginTop: "8px",
                                padding: "12px",
                                background: "rgba(167, 139, 250, 0.05)",
                                border: "1px solid rgba(167, 139, 250, 0.2)",
                                borderRadius: "8px",
                            }}>
                                <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "8px" }}>
                                    已暂存 {buffer.length} 张走向卡，可编辑后逐个或批量生成
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "12px" }}>
                                    {buffer.map((item) => (
                                        <div key={item.id} style={{
                                            padding: "10px",
                                            background: "rgba(255, 255, 255, 0.03)",
                                            border: "1px solid rgba(255, 255, 255, 0.1)",
                                            borderRadius: "6px",
                                        }}>
                                            {/* 卡的类型/来源：旧缓冲区条目没有候选 → 无类型、不回写 */}
                                            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
                                                <span style={{
                                                    fontSize: "10px",
                                                    fontWeight: 700,
                                                    color: item.候选 ? "#c4b5fd" : "#6b7280",
                                                    background: item.候选 ? "rgba(167, 139, 250, 0.18)" : "rgba(255,255,255,0.05)",
                                                    border: `1px solid ${item.候选 ? "rgba(167, 139, 250, 0.4)" : "rgba(255,255,255,0.15)"}`,
                                                    borderRadius: "4px",
                                                    padding: "1px 6px",
                                                }}>
                                                    {item.候选?.类型 ?? "旧条目 · 无类型"}
                                                </span>
                                                {item.候选?.形态 === "骨架" && (
                                                    <span style={{ fontSize: "10px", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.5)", borderRadius: "4px", padding: "1px 6px" }}>骨架</span>
                                                )}
                                                {!item.候选 && (
                                                    <span style={{ fontSize: "10px", color: "#6b7280" }}>采纳时不回写台账</span>
                                                )}
                                            </div>
                                            {/* 报幕编辑 */}
                                            <textarea
                                                value={item.报幕}
                                                onChange={(e) => updateBufferText(item.id, e.target.value)}
                                                placeholder="报幕内容..."
                                                style={{
                                                    width: "100%",
                                                    minHeight: "36px",
                                                    maxHeight: "60px",
                                                    padding: "6px 8px",
                                                    background: "rgba(255, 255, 255, 0.05)",
                                                    border: "1px solid rgba(255, 255, 255, 0.1)",
                                                    borderRadius: "4px",
                                                    color: "#c4b5fd",
                                                    fontSize: "12px",
                                                    resize: "vertical",
                                                    fontFamily: "inherit",
                                                    lineHeight: "1.5",
                                                    marginBottom: "6px",
                                                }}
                                            />
                                            {/* 批注编辑 */}
                                            <textarea
                                                value={item.note || ""}
                                                onChange={(e) => updateBufferNote(item.id, e.target.value)}
                                                placeholder="批注（可选）..."
                                                style={{
                                                    width: "100%",
                                                    minHeight: "30px",
                                                    maxHeight: "60px",
                                                    padding: "6px 8px",
                                                    background: "rgba(167, 139, 250, 0.08)",
                                                    border: "1px dashed rgba(167, 139, 250, 0.3)",
                                                    borderRadius: "4px",
                                                    color: "#d1d5db",
                                                    fontSize: "11px",
                                                    resize: "vertical",
                                                    fontFamily: "inherit",
                                                    lineHeight: "1.5",
                                                    marginBottom: "8px",
                                                }}
                                            />
                                            {/* 操作按钮 */}
                                            <div style={{ display: "flex", gap: "6px" }}>
                                                <button
                                                    onClick={() => handleWriteFromBuffer(item)}
                                                    disabled={loading}
                                                    style={{
                                                        flex: 1,
                                                        padding: "6px 10px",
                                                        background: loading ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                                        border: "none",
                                                        borderRadius: "4px",
                                                        color: "#fff",
                                                        fontSize: "11px",
                                                        fontWeight: 600,
                                                        cursor: loading ? "not-allowed" : "pointer",
                                                    }}
                                                >
                                                    {loading ? "生成中..." : "生成正文"}
                                                </button>
                                                <button
                                                    onClick={() => removeFromBuffer(item.id)}
                                                    style={{
                                                        padding: "6px 10px",
                                                        background: "rgba(239, 68, 68, 0.2)",
                                                        border: "1px solid rgba(239, 68, 68, 0.3)",
                                                        borderRadius: "4px",
                                                        color: "#fca5a5",
                                                        fontSize: "11px",
                                                        cursor: "pointer",
                                                    }}
                                                >
                                                    移除
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {/* 批量生成按钮 */}
                                <button
                                    onClick={handleBatchWriteFromBuffer}
                                    disabled={loading || buffer.length === 0}
                                    style={{
                                        width: "100%",
                                        padding: "10px 16px",
                                        background: loading ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)",
                                        border: "none",
                                        borderRadius: "6px",
                                        color: "#fff",
                                        fontWeight: 600,
                                        fontSize: "13px",
                                        cursor: loading ? "not-allowed" : "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "8px",
                                    }}
                                >
                                    {loading ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            批量生成中...
                                        </>
                                    ) : (
                                        <>
                                            <Feather size={14} />
                                            批量生成全部 ({buffer.length} 个)
                                        </>
                                    )}
                                </button>
                            </div>
                        )}

                        {/* 错误提示 */}
                        {error && (
                            <div
                                style={{
                                    padding: "10px 12px",
                                    background: "rgba(239, 68, 68, 0.1)",
                                    border: "1px solid rgba(239, 68, 68, 0.3)",
                                    borderRadius: "6px",
                                    color: "#fca5a5",
                                    fontSize: "13px",
                                }}
                            >
                                {error}
                            </div>
                        )}
                    </>
                ) : (
                    // 数据标签页 - 三层架构
                    <>
                        {dataLoading ? (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 0", color: "#6b7280" }}>
                                <Loader2 size={20} className="animate-spin" style={{ marginRight: "8px" }} />
                                加载中...
                            </div>
                        ) : !dataSessionId ? (
                            // 记忆按会话隔离：没打开对局就没有归属会话，不能退回"读全部"显示 0 张，
                            // 那会让人以为数据丢了。明确提示先打开一场对局。
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", padding: "48px 16px", color: "#9ca3af", textAlign: "center" }}>
                                <Database size={28} style={{ opacity: 0.5 }} />
                                <div style={{ fontSize: "14px", fontWeight: 600, color: "#d1d5db" }}>请先打开一个对局</div>
                                <div style={{ fontSize: "12px", lineHeight: 1.6 }}>记忆、情感、关系水位与剧情大纲都按对局隔离存放。<br />在特调里进入一场对局后，这里会显示该对局专属的数据面板。</div>
                            </div>
                        ) : (
                            <>
                                {/* 第一层：记忆健康度仪表盘 */}
                                <div style={{ marginBottom: "12px" }}>
                                    {/* 卡片统计 */}
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "6px", marginBottom: "10px" }}>
                                        {[
                                            { label: "生效中", value: memories.filter(m => m.状态 === "生效").length + emotions.filter(e => e.状态 === "生效").length + threads.filter(t => t.状态 === "生效").length + foreshadows.filter(f => f.状态 === "生效").length, color: "#10b981" },
                                            { label: "已归档", value: memories.filter(m => m.状态 === "归档").length + emotions.filter(e => e.状态 === "归档").length + threads.filter(t => t.状态 === "归档").length + foreshadows.filter(f => f.状态 === "归档").length, color: "#6b7280" },
                                            // 四类待核一起算，才和下面"⚠️ 待核实 (n)"与批量确认按钮对得上
                                            { label: "待核实", value: 待核合计, color: "#f59e0b", warn: true },
                                            { label: "已删除", value: 0, color: "#ef4444" },
                                        ].map((stat) => (
                                            <div key={stat.label} style={{
                                                padding: "8px",
                                                background: "rgba(255, 255, 255, 0.03)",
                                                borderRadius: "6px",
                                                textAlign: "center",
                                                border: stat.warn && stat.value > 0 ? "1px solid rgba(245, 158, 11, 0.3)" : "none",
                                            }}>
                                                <div style={{ fontSize: "18px", fontWeight: 700, color: stat.color }}>{stat.value}</div>
                                                <div style={{ fontSize: "10px", color: "#6b7280", marginTop: "2px" }}>{stat.label}</div>
                                            </div>
                                        ))}
                                    </div>
                                    
                                    {/* 关系水位 */}
                                    <div style={{ marginBottom: "10px" }}>
                                        <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", fontWeight: 600 }}>关系水位</div>
                                        {Object.entries(waterLevels).map(([scope, level]) => {
                                            const levelNum = parseInt(level.水位.replace("L", ""));
                                            const pct = (levelNum / 5) * 100;
                                            const barColor = levelNum >= 3 ? "#10b981" : levelNum >= 1 ? "#3b82f6" : "#6b7280";
                                            return (
                                                <div key={scope} style={{ marginBottom: "6px" }}>
                                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#9ca3af", marginBottom: "2px" }}>
                                                        <span>{scope}</span>
                                                        <span>{level.水位} ({level.status}){level.未解决冲突.length > 0 ? ` · ⚠️${level.未解决冲突.length}冲突` : ""}</span>
                                                    </div>
                                                    <div style={{ height: "6px", background: "rgba(255,255,255,0.1)", borderRadius: "3px", overflow: "hidden" }}>
                                                        <div style={{ width: `${pct}%`, height: "100%", background: barColor, borderRadius: "3px", transition: "width 0.3s" }} />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    
                                    {/* 上下文压缩状态 */}
                                    {contextHierarchy && (
                                        <div style={{
                                            padding: "8px",
                                            background: contextHierarchy.L3_全局大纲 ? "rgba(16, 185, 129, 0.05)" : "rgba(245, 158, 11, 0.05)",
                                            border: `1px solid ${contextHierarchy.L3_全局大纲 ? "rgba(16, 185, 129, 0.2)" : "rgba(245, 158, 11, 0.2)"}`,
                                            borderRadius: "6px",
                                            fontSize: "11px",
                                        }}>
                                            <div style={{ color: contextHierarchy.L3_全局大纲 ? "#10b981" : "#f59e0b", fontWeight: 600, marginBottom: "4px" }}>
                                                {contextHierarchy.L3_全局大纲 ? "✅ 记忆已整理" : "⚠️ 首次执笔需梳理历史"}
                                            </div>
                                            <div style={{ color: "#9ca3af", lineHeight: "1.6" }}>
                                                L2摘要: {contextHierarchy.L2_章节摘要.length}段 · 
                                                L3大纲: {contextHierarchy.L3_全局大纲 ? `${contextHierarchy.L3_全局大纲.length}字` : "未生成"} · 
                                                上次: {contextHierarchy.lastCompressedAt ? new Date(contextHierarchy.lastCompressedAt).toLocaleTimeString() : "从未"}
                                            </div>
                                        </div>
                                    )}

                                    {/* 悬念台账：线索卡与伏笔卡。
                                        这一段是导演视角的东西——确认了也不会进正文，角色永远读不到。
                                        台账为空时也必须渲染：「初始化台账」「手动新增」这两个入口，
                                        恰恰只在一条线索也没有的冷启动对局里才用得上。 */}
                                    <div style={{ marginTop: "10px" }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", gap: "4px", flexWrap: "wrap" }}>
                                            <div style={{ fontSize: "11px", color: "#9ca3af", fontWeight: 600 }}>
                                                悬念台账 · 线索 {threads.filter(t => t.状态 !== "归档").length} / 伏笔 {foreshadows.filter(f => f.状态 !== "归档" && f.伏笔状态 !== "已收").length}
                                            </div>
                                            <div style={{ display: "flex", gap: "4px" }}>
                                                <button
                                                    onClick={handleInitLedger}
                                                    // 整理/补抽/精抽都在跑模型时不给点：那几个会改写大纲与台账素材，同一时刻只留一次付费调用
                                                    disabled={ledgerBusy || compressing || backfilling || deepExtracting}
                                                    title="读一遍剧情大纲，把还悬着的事写成待核的线索/伏笔（一次模型调用，最多 6 条线索 + 4 条伏笔）"
                                                    style={{ padding: "2px 6px", fontSize: "10px", background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.4)", borderRadius: "4px", color: "#c4b5fd", cursor: ledgerBusy || compressing || backfilling || deepExtracting ? "not-allowed" : "pointer", opacity: ledgerBusy || compressing || backfilling || deepExtracting ? 0.5 : 1 }}
                                                >
                                                    {ledgerBusy ? "初始化中…" : "初始化台账"}
                                                </button>
                                                <button
                                                    onClick={() => openManualForm("thread")}
                                                    title="手写一条线索（保存即生效，不经过待核）"
                                                    style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", color: "#9ca3af", cursor: "pointer" }}
                                                >
                                                    ＋线索
                                                </button>
                                                <button
                                                    onClick={() => openManualForm("foreshadow")}
                                                    title="手写一条伏笔（保存即生效，不经过待核）"
                                                    style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", color: "#9ca3af", cursor: "pointer" }}
                                                >
                                                    ＋伏笔
                                                </button>
                                            </div>
                                        </div>

                                        {ledgerNotice && (
                                            <div style={{ fontSize: "10px", lineHeight: 1.5, marginBottom: "6px", padding: "4px 6px", borderRadius: "4px", background: ledgerNotice.bad ? "rgba(239,68,68,0.1)" : "rgba(16,185,129,0.1)", border: `1px solid ${ledgerNotice.bad ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)"}`, color: ledgerNotice.bad ? "#f87171" : "#6ee7b7" }}>
                                                {ledgerNotice.text}
                                            </div>
                                        )}

                                        {manualForm === "thread" && (
                                            <div style={{ display: "flex", flexDirection: "column", gap: "5px", padding: "7px", marginBottom: "6px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", border: "1px solid rgba(167,139,250,0.25)" }}>
                                                <input
                                                    value={manualThreadName}
                                                    onChange={e => setManualThreadName(e.target.value)}
                                                    placeholder={`线索名（≤${THREAD_NAME_MAX}字，用名词短语）`}
                                                    maxLength={THREAD_NAME_MAX}
                                                    style={LEDGER_FIELD_STYLE}
                                                />
                                                <input
                                                    value={manualThreadRoles}
                                                    onChange={e => setManualThreadRoles(e.target.value)}
                                                    placeholder="关联角色，多个用逗号分隔（可清空）"
                                                    style={LEDGER_FIELD_STYLE}
                                                />
                                                <input
                                                    value={manualThreadNext}
                                                    onChange={e => setManualThreadNext(e.target.value)}
                                                    placeholder={`下一步可能（≤${THREAD_NEXT_MAX}字，可留空）`}
                                                    maxLength={THREAD_NEXT_MAX}
                                                    style={LEDGER_FIELD_STYLE}
                                                />
                                                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                                    <button onClick={handleAddManualThread} style={LEDGER_SUBMIT_STYLE}>保存为生效线索</button>
                                                    <button onClick={() => { setManualForm(null); setLedgerNotice(null); }} style={LEDGER_CANCEL_STYLE}>取消</button>
                                                    <span style={{ fontSize: "10px", color: "#6b7280" }}>线索状态默认潜伏，存好后可用「改状态」调整</span>
                                                </div>
                                            </div>
                                        )}

                                        {manualForm === "foreshadow" && (
                                            <div style={{ display: "flex", flexDirection: "column", gap: "5px", padding: "7px", marginBottom: "6px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", border: "1px solid rgba(245,158,11,0.25)" }}>
                                                <input
                                                    value={manualForeshadowContent}
                                                    onChange={e => setManualForeshadowContent(e.target.value)}
                                                    placeholder={`伏笔内容（≤${FORESHADOW_CONTENT_MAX}字，一句话）`}
                                                    maxLength={FORESHADOW_CONTENT_MAX}
                                                    style={LEDGER_FIELD_STYLE}
                                                />
                                                <input
                                                    value={manualForeshadowThread}
                                                    onChange={e => setManualForeshadowThread(e.target.value)}
                                                    placeholder="挂在哪条线索上（可留空）"
                                                    list="nw-ledger-thread-names"
                                                    style={LEDGER_FIELD_STYLE}
                                                />
                                                <datalist id="nw-ledger-thread-names">
                                                    {threads.filter(t => t.状态 !== "归档").map(t => <option key={t.id} value={t.名称} />)}
                                                </datalist>
                                                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                                    <button onClick={handleAddManualForeshadow} style={LEDGER_SUBMIT_STYLE}>保存为生效伏笔</button>
                                                    <button onClick={() => { setManualForm(null); setLedgerNotice(null); }} style={LEDGER_CANCEL_STYLE}>取消</button>
                                                    <span style={{ fontSize: "10px", color: "#6b7280" }}>默认未收，回收窗口按当前轮次往后 10 轮</span>
                                                </div>
                                            </div>
                                        )}

                                        {threads.length === 0 && foreshadows.length === 0 && 散落线头数量 === 0 && (
                                            <div style={{ fontSize: "10px", color: "#6b7280", lineHeight: 1.5, marginBottom: "6px" }}>
                                                台账还是空的。线索卡上线之前跑过的补抽、精抽、整理都不会补出线索，所以主线与伏笔回收一直缺素材。
                                                点「初始化台账」让模型读一遍大纲，或直接「＋线索」写第一条。
                                            </div>
                                        )}

                                        {散落线头数量 > 0 && (
                                            <button
                                                onClick={handleMigrateLooseThreads}
                                                title="把旧的「散落线头」文本转成线索卡（同名跳过，迁完清空）"
                                                style={{ padding: "2px 6px", fontSize: "10px", background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: "4px", color: "#fbbf24", cursor: "pointer", marginBottom: "6px" }}
                                            >
                                                迁移 {散落线头数量} 条散落线头
                                            </button>
                                        )}
                                        <div style={{ fontSize: "10px", color: "#6b7280", lineHeight: 1.5, marginBottom: "6px" }}>
                                            只进导演上下文，角色读不到；剧情态升级只来自采纳回写或这里手动改。
                                        </div>
                                        {threads
                                            .filter(t => !cardFilter.status || t.状态 === cardFilter.status)
                                            .map(t => (
                                                    <div key={t.id} style={{ padding: "6px", marginBottom: "4px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", border: t.状态 === "待核" ? "1px solid rgba(245,158,11,0.3)" : "1px solid transparent", opacity: t.状态 === "归档" ? 0.45 : 1 }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                                                            <span style={{ fontSize: "11px", color: "#e5e7eb", fontWeight: 600, wordBreak: "break-all" }}>{t.名称}</span>
                                                            <span style={{ fontSize: "10px", color: "#a78bfa", whiteSpace: "nowrap" }}>{t.线索状态}</span>
                                                        </div>
                                                        <div style={{ fontSize: "10px", color: "#9ca3af", lineHeight: 1.5, marginTop: "2px" }}>
                                                            {线索进度文案(t)}
                                                            {t.最近变化?.[0]?.变化 ? ` · 最近：${t.最近变化[0].计划 ? "（计划）" : ""}${t.最近变化[0].变化}` : ""}
                                                            {t.下一步可能 ? ` · 下一步：${t.下一步可能}` : " · 下一步：未填"}
                                                            {discardedSourceHint(t) ? ` · ${discardedSourceHint(t)}` : ""}
                                                        </div>
                                                        <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
                                                            <button onClick={() => handleCycleThreadStatus(t)} title="手动改线索状态（潜伏→升温→爆发→收束）" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(167,139,250,0.4)", borderRadius: "4px", color: "#c4b5fd", cursor: "pointer" }}>改状态</button>
                                                            <button onClick={() => handleEditThreadNextStep(t)} title="编辑下一步可能" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", color: "#9ca3af", cursor: "pointer" }}>改下一步</button>
                                                            {t.状态 === "待核" && (
                                                                <button onClick={() => handleConfirmThread(t)} title="确认这条线存在（只让它进导演上下文）" style={{ padding: "2px 6px", fontSize: "10px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: "4px", color: "#10b981", cursor: "pointer" }}>✅ 确认</button>
                                                            )}
                                                            {t.状态 !== "归档" && (
                                                                <button onClick={() => handleArchiveThread(t)} title="归档：留内容不进台账" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", color: "#6b7280", cursor: "pointer" }}>归档</button>
                                                            )}
                                                            <button onClick={() => handleDeleteThread(t)} title="彻底删除" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "4px", color: "#ef4444", cursor: "pointer" }}>删</button>
                                                        </div>
                                                    </div>
                                                ))}
                                            {foreshadows
                                                .filter(f => !cardFilter.status || f.状态 === cardFilter.status)
                                                .map(f => (
                                                    <div key={f.id} style={{ padding: "6px", marginBottom: "4px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", border: f.状态 === "待核" ? "1px solid rgba(245,158,11,0.3)" : "1px solid transparent", opacity: f.状态 === "归档" ? 0.45 : 1 }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                                                            <span style={{ fontSize: "11px", color: "#e5e7eb", fontWeight: 600, wordBreak: "break-all" }}>{f.内容}</span>
                                                            <span style={{ fontSize: "10px", color: f.伏笔状态 === "已收" ? "#6b7280" : "#f59e0b", whiteSpace: "nowrap" }}>{f.伏笔状态}</span>
                                                        </div>
                                                        <div style={{ fontSize: "10px", color: "#9ca3af", lineHeight: 1.5, marginTop: "2px" }}>
                                                            第 {f.埋下轮次} 轮埋下 · 预期第 {f.预期回收窗口.起}-{f.预期回收窗口.止} 轮收
                                                            {f.揭示条件 ? ` · 条件：${f.揭示条件}` : ""}
                                                            {discardedSourceHint(f) ? ` · ${discardedSourceHint(f)}` : ""}
                                                        </div>
                                                        <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
                                                            <button onClick={() => handleCycleForeshadowStatus(f)} title={f.伏笔状态 === "已收" ? "改回未收" : "标记为已收（采纳 [回收:] 标记也会做这件事）"} style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(167,139,250,0.4)", borderRadius: "4px", color: "#c4b5fd", cursor: "pointer" }}>{f.伏笔状态 === "已收" ? "改回未收" : "标为已收"}</button>
                                                            {f.状态 === "待核" && (
                                                                <button onClick={() => handleConfirmForeshadow(f)} title="确认这个伏笔存在（只让它进导演上下文）" style={{ padding: "2px 6px", fontSize: "10px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.4)", borderRadius: "4px", color: "#10b981", cursor: "pointer" }}>✅ 确认</button>
                                                            )}
                                                            {f.状态 !== "归档" && (
                                                                <button onClick={() => handleArchiveForeshadow(f)} title="归档：留内容不进台账" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", color: "#6b7280", cursor: "pointer" }}>归档</button>
                                                            )}
                                                            <button onClick={() => handleDeleteForeshadow(f)} title="彻底删除" style={{ padding: "2px 6px", fontSize: "10px", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "4px", color: "#ef4444", cursor: "pointer" }}>删</button>
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                </div>

                                {/* 第二层：可操作卡片列表 */}
                                <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "10px" }}>
                                    <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
                                        <button
                                            onClick={() => setCardFilter({})}
                                            style={{
                                                padding: "3px 8px",
                                                background: !cardFilter.status ? "rgba(167, 139, 250, 0.3)" : "transparent",
                                                border: "none",
                                                borderRadius: "4px",
                                                color: !cardFilter.status ? "#c4b5fd" : "#6b7280",
                                                fontSize: "11px",
                                                cursor: "pointer",
                                            }}
                                        >
                                            全部
                                        </button>
                                        <button
                                            onClick={() => setCardFilter({ status: "生效" })}
                                            style={{
                                                padding: "3px 8px",
                                                background: cardFilter.status === "生效" ? "rgba(167, 139, 250, 0.3)" : "transparent",
                                                border: "none",
                                                borderRadius: "4px",
                                                color: cardFilter.status === "生效" ? "#c4b5fd" : "#6b7280",
                                                fontSize: "11px",
                                                cursor: "pointer",
                                            }}
                                        >
                                            生效
                                        </button>
                                        <button
                                            onClick={() => setCardFilter({ status: "归档" })}
                                            style={{
                                                padding: "3px 8px",
                                                background: cardFilter.status === "归档" ? "rgba(167, 139, 250, 0.3)" : "transparent",
                                                border: "none",
                                                borderRadius: "4px",
                                                color: cardFilter.status === "归档" ? "#c4b5fd" : "#6b7280",
                                                fontSize: "11px",
                                                cursor: "pointer",
                                            }}
                                        >
                                            已归档
                                        </button>
                                        <button
                                            onClick={() => setCardFilter({ status: "待核" })}
                                            style={{
                                                padding: "3px 8px",
                                                background: cardFilter.status === "待核" ? "rgba(245, 158, 11, 0.3)" : "transparent",
                                                border: cardFilter.status === "待核" ? "1px solid rgba(245, 158, 11, 0.5)" : "none",
                                                borderRadius: "4px",
                                                color: cardFilter.status === "待核" ? "#fbbf24" : "#6b7280",
                                                fontSize: "11px",
                                                cursor: "pointer",
                                                fontWeight: cardFilter.status === "待核" ? 600 : 400,
                                            }}
                                        >
                                            ⚠️ 待核实 ({待核合计})
                                        </button>
                                        {/* 批量确认：入口贴着"待核实"这个动作发生处，没有待核卡时不占位置 */}
                                        {待核合计 > 0 && (
                                            <button
                                                onClick={handleConfirmAllPending}
                                                disabled={confirmingPending}
                                                title="把当前对局所有待核卡一次性转为生效：记忆/情感进正文，线索/伏笔只进导演上下文"
                                                style={{
                                                    padding: "3px 8px",
                                                    background: "rgba(16, 185, 129, 0.18)",
                                                    border: "1px solid rgba(16, 185, 129, 0.5)",
                                                    borderRadius: "4px",
                                                    color: "#6ee7b7",
                                                    fontSize: "11px",
                                                    cursor: confirmingPending ? "default" : "pointer",
                                                    opacity: confirmingPending ? 0.6 : 1,
                                                }}
                                            >
                                                {confirmingPending ? "确认中…" : `✅ 全部确认 (记忆 ${待核数量.记忆} / 情感 ${待核数量.情感} / 线索 ${待核数量.线索} / 伏笔 ${待核数量.伏笔})`}
                                            </button>
                                        )}
                                    </div>
                                    
                                    {/* 维度筛选：主类型 + 次标签（仅作用于记忆卡列表） */}
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
                                        {["稳定事实", "经历节点", "行为模式", "自我认知", "关系共识", "世界变更"].map(t => (
                                            <button
                                                key={t}
                                                onClick={() => setCardFilter(prev => ({ ...prev, 主类型: prev.主类型 === t ? undefined : t }))}
                                                style={{
                                                    padding: "2px 6px",
                                                    background: cardFilter.主类型 === t ? "rgba(96, 165, 250, 0.35)" : "rgba(255,255,255,0.05)",
                                                    border: cardFilter.主类型 === t ? "1px solid rgba(96, 165, 250, 0.6)" : "1px solid transparent",
                                                    borderRadius: "4px",
                                                    color: cardFilter.主类型 === t ? "#93c5fd" : "#6b7280",
                                                    fontSize: "10px",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "8px" }}>
                                        {(["喜好", "禁忌", "习惯", "地点", "物品", "约定", "成就"] as const).map(t => (
                                            <button
                                                key={t}
                                                onClick={() => setCardFilter(prev => ({ ...prev, 次标签: prev.次标签 === t ? undefined : t }))}
                                                style={{
                                                    padding: "2px 6px",
                                                    background: cardFilter.次标签 === t ? "rgba(52, 211, 153, 0.35)" : "rgba(255,255,255,0.05)",
                                                    border: cardFilter.次标签 === t ? "1px solid rgba(52, 211, 153, 0.6)" : "1px solid transparent",
                                                    borderRadius: "4px",
                                                    color: cardFilter.次标签 === t ? "#6ee7b7" : "#6b7280",
                                                    fontSize: "10px",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                #{t}
                                            </button>
                                        ))}
                                    </div>
                                    
                                    {/* 记忆卡列表 */}
                                    <div style={{ marginBottom: "10px" }}>
                                        <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", fontWeight: 600 }}>
                                            记忆卡 ({memories.filter(m =>
                                                (!cardFilter.status || m.状态 === cardFilter.status) &&
                                                (!cardFilter.主类型 || m.主类型 === cardFilter.主类型) &&
                                                (!cardFilter.次标签 || m.次标签?.includes(cardFilter.次标签))
                                            ).length})
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "400px", overflow: "auto" }}>
                                            {memories
                                                .filter(m =>
                                                    (!cardFilter.status || m.状态 === cardFilter.status) &&
                                                    (!cardFilter.主类型 || m.主类型 === cardFilter.主类型) &&
                                                    (!cardFilter.次标签 || m.次标签?.includes(cardFilter.次标签))
                                                )
                                                .slice(0, 50)
                                                .map((card) => (
                                                    <div key={card.id} title={archiveTitle(card)} style={{
                                                        padding: "8px",
                                                        background: "rgba(255, 255, 255, 0.03)",
                                                        borderRadius: "6px",
                                                        border: card.置信度 < 0.7 ? "1px solid rgba(245, 158, 11, 0.3)" : "1px solid transparent",
                                                    }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                                                            <div style={{ fontSize: "11px", color: "#6b7280" }}>
                                                                {card.主类型} · {card.主体} · {card.状态}
                                                                {card.次标签?.length ? ` · ${card.次标签.map(t => `#${t}`).join(" ")}` : ""}
                                                            </div>
                                                            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                                                {discardedSourceHint(card) && (
                                                                    <span style={{ fontSize: "10px", color: "#9ca3af" }}>
                                                                        {discardedSourceHint(card)}
                                                                    </span>
                                                                )}
                                                                {card.状态 === "待核" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && updateMemoryCard(dataSessionId, card.id, { 状态: "生效" }).then(() => loadData())}
                                                                        title="确认生效"
                                                                        style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: "2px", fontSize: "12px", fontWeight: 600 }}
                                                                    >
                                                                        ✅
                                                                    </button>
                                                                )}
                                                                {card.状态 === "归档" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && updateMemoryCard(dataSessionId, card.id, { 状态: "生效", 归档原因: undefined }).then(() => loadData())}
                                                                        title={card.归档原因 ? `恢复生效（归档原因：${card.归档原因}）` : "恢复生效"}
                                                                        style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", padding: "2px", fontSize: "10px", fontWeight: 600 }}
                                                                    >
                                                                        恢复生效
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => handleOpenEdit("memory", card)}
                                                                    title="编辑"
                                                                    style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    ✏️
                                                                </button>
                                                                {card.状态 !== "归档" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && archiveMemoryCard(dataSessionId, card.id).then(() => loadData())}
                                                                        title="归档"
                                                                        style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                    >
                                                                        📦
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => dataSessionId && deleteMemoryCard(dataSessionId, card.id).then(() => loadData())}
                                                                    title="删除"
                                                                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    🗑️
                                                                </button>
                                                            </div>
                                                        </div>
                                                        <div style={{ fontSize: "12px", color: "#d1d5db", lineHeight: "1.5" }}>
                                                            {card.内容.length > 60 ? card.内容.slice(0, 60) + "..." : card.内容}
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>
                                    
                                    {/* 情感卡列表 */}
                                    <div>
                                        <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", fontWeight: 600 }}>
                                            情感卡 ({emotions.filter(e => !cardFilter.status || e.状态 === cardFilter.status).length})
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "150px", overflow: "auto" }}>
                                            {emotions
                                                .filter(e => !cardFilter.status || e.状态 === cardFilter.status)
                                                .slice(0, 8)
                                                .map((card) => (
                                                    <div key={card.id} title={archiveTitle(card)} style={{
                                                        padding: "8px",
                                                        background: "rgba(255, 255, 255, 0.03)",
                                                        borderRadius: "6px",
                                                    }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                            <div style={{ fontSize: "11px", color: "#6b7280" }}>
                                                                {card.主体} · {card.标签}({card.强度}) · {card.状态}
                                                            </div>
                                                            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                                                {discardedSourceHint(card) && (
                                                                    <span style={{ fontSize: "10px", color: "#9ca3af" }}>
                                                                        {discardedSourceHint(card)}
                                                                    </span>
                                                                )}
                                                                {card.状态 === "待核" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && updateEmotionCard(dataSessionId, card.id, { 状态: "生效" } as any).then(() => loadData())}
                                                                        title="确认生效"
                                                                        style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: "2px", fontSize: "12px", fontWeight: 600 }}
                                                                    >
                                                                        ✅
                                                                    </button>
                                                                )}
                                                                {card.状态 === "归档" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && updateEmotionCard(dataSessionId, card.id, { 状态: "生效", 归档原因: undefined } as any).then(() => loadData())}
                                                                        title={card.归档原因 ? `恢复生效（归档原因：${card.归档原因}）` : "恢复生效"}
                                                                        style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", padding: "2px", fontSize: "10px", fontWeight: 600 }}
                                                                    >
                                                                        恢复生效
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => handleOpenEdit("emotion", card)}
                                                                    title="编辑"
                                                                    style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    ✏️
                                                                </button>
                                                                {card.状态 !== "归档" && (
                                                                    <button
                                                                        onClick={() => dataSessionId && archiveEmotionCard(dataSessionId, card.id).then(() => loadData())}
                                                                        title="归档"
                                                                        style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                    >
                                                                        📦
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => dataSessionId && deleteEmotionCard(dataSessionId, card.id).then(() => loadData())}
                                                                    title="删除"
                                                                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    🗑️
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>
                                </div>
                                
                                {/* 第三层：高级工具 */}
                                <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "10px", marginTop: "10px" }}>
                                    <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "8px", fontWeight: 600 }}>高级工具</div>
                                    
                                    {/* 记忆整理按钮 */}
                                    <button
                                        onClick={handleCompressMemory}
                                        disabled={compressing || backfilling}
                                        style={{
                                            width: "100%",
                                            padding: "10px 16px",
                                            background: compressing ? "rgba(167, 139, 250, 0.3)" : "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                            border: "none",
                                            borderRadius: "8px",
                                            color: "#fff",
                                            fontWeight: 600,
                                            fontSize: "13px",
                                            cursor: compressing || backfilling ? "not-allowed" : "pointer",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            gap: "8px",
                                            marginBottom: compressProgress ? "8px" : "8px",
                                        }}
                                    >
                                        {compressing ? (
                                            <>
                                                <Loader2 size={14} className="animate-spin" />
                                                {compressProgress
                                                    ? `整理中 ${compressProgress.step}/${compressProgress.totalSteps} · ${compressProgress.phase}${compressProgress.etaMs > 0 ? ` · 约剩${compressProgress.etaMs >= 60000 ? `${Math.round(compressProgress.etaMs / 60000)}分钟` : `${Math.max(1, Math.round(compressProgress.etaMs / 1000))}秒`}` : ""}`
                                                    : "整理中..."}
                                            </>
                                        ) : (
                                            <>
                                                 记忆整理
                                            </>
                                        )}
                                    </button>
                                    
                                    {/* 整理完成后只问一次：初始化台账是新增的一笔付费调用，
                                        要不要花由她点头；点「先不用」或跑过一次之后这条就不再出现。 */}
                                    {ledgerOffer && (
                                        <div style={{ padding: "7px 8px", marginBottom: "8px", borderRadius: "6px", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.3)" }}>
                                            <div style={{ fontSize: "11px", color: "#c4b5fd", lineHeight: 1.5, marginBottom: "5px" }}>
                                                大纲已生成。要不要按大纲初始化台账？一次模型调用，最多 6 条线索、4 条伏笔，全部先标"待核"，不会自动确认。
                                            </div>
                                            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                                <button
                                                    onClick={handleInitLedger}
                                                    disabled={ledgerBusy || backfilling || deepExtracting}
                                                    style={{ ...LEDGER_SUBMIT_STYLE, opacity: ledgerBusy || backfilling || deepExtracting ? 0.5 : 1, cursor: ledgerBusy || backfilling || deepExtracting ? "not-allowed" : "pointer" }}
                                                >
                                                    {ledgerBusy ? "初始化中…" : "现在初始化"}
                                                </button>
                                                <button onClick={() => setLedgerOffer(false)} style={LEDGER_CANCEL_STYLE}>先不用</button>
                                            </div>
                                        </div>
                                    )}

                                    {/* 全量补抽按钮：一次性回灌整局恢复逐轮记忆 */}
                                    <button
                                        onClick={handleBackfill}
                                        disabled={compressing || backfilling || deepExtracting}
                                        title="把整局对话按每4轮一批全部重跑抽取器，恢复抽取通道损坏/未启用期间的细颗粒记忆（一次性操作，耗时较长）"
                                        style={{
                                            width: "100%",
                                            padding: "8px 16px",
                                            background: backfilling ? "rgba(96, 165, 250, 0.3)" : "rgba(96, 165, 250, 0.12)",
                                            border: "1px solid rgba(96, 165, 250, 0.4)",
                                            borderRadius: "8px",
                                            color: backfilling ? "#93c5fd" : "#60a5fa",
                                            fontWeight: 600,
                                            fontSize: "12px",
                                            cursor: compressing || backfilling || deepExtracting ? "not-allowed" : "pointer",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            gap: "8px",
                                            marginBottom: "8px",
                                        }}
                                    >
                                        {backfilling ? (
                                            <>
                                                <Loader2 size={13} className="animate-spin" />
                                                {compressProgress
                                                    ? `全量补抽中 ${compressProgress.step}/${compressProgress.totalSteps} 批${compressProgress.etaMs > 0 ? ` · 约剩${compressProgress.etaMs >= 60000 ? `${Math.round(compressProgress.etaMs / 60000)}分钟` : `${Math.max(1, Math.round(compressProgress.etaMs / 1000))}秒`}` : ""}`
                                                    : "全量补抽中..."}
                                            </>
                                        ) : (
                                            <>
                                                📚 全量补抽（整局重跑，产出最多）
                                            </>
                                        )}
                                    </button>
                                    
                                    {/* 增量精抽按钮：手动触发，对最近 20 轮做精细分析 */}
                                    <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
                                        <button
                                            onClick={handleDeepExtract}
                                            disabled={compressing || backfilling || deepExtracting}
                                            title="对最近 20 轮对话做精细抽取，用完整上下文（小票 + 尾调 + 状态）补充细节（每次约 1 分钟）"
                                            style={{
                                                flex: 1,
                                                padding: "8px 16px",
                                                background: deepExtracting ? "rgba(16, 185, 129, 0.3)" : "rgba(16, 185, 129, 0.12)",
                                                border: "1px solid rgba(16, 185, 129, 0.4)",
                                                borderRadius: "8px",
                                                color: deepExtracting ? "#6ee7b7" : "#10b981",
                                                fontWeight: 600,
                                                fontSize: "12px",
                                                cursor: compressing || backfilling || deepExtracting ? "not-allowed" : "pointer",
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                gap: "8px",
                                            }}
                                        >
                                            {deepExtracting ? (
                                                <>
                                                    <Loader2 size={13} className="animate-spin" />
                                                    增量精抽中...
                                                </>
                                            ) : (
                                                <>
                                                    🔍 增量精抽（最近 20 轮）{lastDeepExtractAt ? `· ${Math.round((Date.now() - lastDeepExtractAt) / 60000)}分钟前` : ""}
                                                </>
                                            )}
                                        </button>
                                        
                                        <button
                                            onClick={handleViewLogs}
                                            title="查看深度抽取的探针日志（含耗时、步骤、错误）"
                                            style={{
                                                padding: "8px 12px",
                                                background: "rgba(255,255,255,0.05)",
                                                border: "1px solid rgba(255,255,255,0.1)",
                                                borderRadius: "8px",
                                                color: "#9ca3af",
                                                fontSize: "12px",
                                                cursor: "pointer",
                                            }}
                                        >
                                            📋 日志
                                        </button>
                                    </div>
                                    
                                    {compressProgress && (
                                        <div style={{ height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden", marginBottom: "8px" }}>
                                            <div
                                                style={{
                                                    // 起步给 2% 最小宽度，避免第一步完成前进度条看着是死的
                                                    width: `${Math.max(2, (compressProgress.step / compressProgress.totalSteps) * 100)}%`,
                                                    height: "100%",
                                                    background: "#a78bfa",
                                                    transition: "width 0.3s",
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>
            
            {/* 编辑模态框 */}
            {editingCard && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0.7)",
                        backdropFilter: "blur(4px)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 100,
                        borderRadius: "12px",
                    }}
                    onClick={() => setEditingCard(null)}
                >
                    <div
                        style={{
                            background: "rgba(30, 30, 45, 0.98)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            borderRadius: "12px",
                            padding: "20px",
                            width: "90%",
                            maxWidth: "360px",
                            maxHeight: "80%",
                            display: "flex",
                            flexDirection: "column",
                            gap: "12px",
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ fontSize: "14px", fontWeight: 600, color: "#e5e7eb" }}>
                            编辑{editingCard.type === "memory" ? "记忆卡" : "情感卡"}
                        </div>
                        <div style={{ fontSize: "11px", color: "#6b7280" }}>
                            {editingCard.type === "memory" 
                                ? `${(editingCard.card as MemoryCard).主类型} · ${(editingCard.card as MemoryCard).主体}`
                                : `${(editingCard.card as EmotionCard).标签} · ${(editingCard.card as EmotionCard).主体}`
                            }
                        </div>
                        <textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            style={{
                                flex: 1,
                                minHeight: "120px",
                                padding: "10px",
                                background: "rgba(255,255,255,0.05)",
                                border: "1px solid rgba(255,255,255,0.1)",
                                borderRadius: "6px",
                                color: "#e5e7eb",
                                fontSize: "13px",
                                lineHeight: "1.6",
                                resize: "vertical",
                                fontFamily: "inherit",
                            }}
                        />
                        <div style={{ display: "flex", gap: "8px" }}>
                            <button
                                onClick={handleSaveEdit}
                                style={{
                                    flex: 1,
                                    padding: "8px",
                                    background: "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
                                    border: "none",
                                    borderRadius: "6px",
                                    color: "#fff",
                                    fontWeight: 600,
                                    fontSize: "13px",
                                    cursor: "pointer",
                                }}
                            >
                                保存
                            </button>
                            <button
                                onClick={() => setEditingCard(null)}
                                style={{
                                    flex: 1,
                                    padding: "8px",
                                    background: "rgba(255,255,255,0.1)",
                                    border: "none",
                                    borderRadius: "6px",
                                    color: "#9ca3af",
                                    fontSize: "13px",
                                    cursor: "pointer",
                                }}
                            >
                                取消
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
