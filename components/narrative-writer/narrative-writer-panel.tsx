"use client";

// 执笔插件 · 宿主面板
//
// 归统一控制坞管理：坞里点「执笔」按钮 → 弹出这个可拖动的浮窗，
// 在任意界面都能用。用于剧情自主书写。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { X, Feather, Loader2 } from "lucide-react";
import {
    CONTROL_DOCK_ACTIVATE_EVENT,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import { loadCharacterWorldFromSession, getActiveMixSession } from "@/lib/narrative-writer/context-loader";
import { writeNarrative, generateBannerOptions, writeWithSelectedBanner, compressNarrativeMemory, extractMemoriesFromCompression, NARRATIVE_CHUNK_SIZE } from "@/lib/narrative-writer/writer";
import { insertNarrativeTurn } from "@/lib/mixology/engine";
import { backfillExtraction, hotExtractFromNarrativeBody, deepExtractFromNarrativeBody } from "@/lib/narrative-writer/extractor";
import { generateSmartRecommendations, type SceneRecommendation } from "@/lib/narrative-writer/recommender";
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
} from "@/lib/narrative-writer/storage";
import type { MemoryCard, EmotionCard, WaterLevelState, NarrativeWriterState, ContextHierarchy, ExtractionRules } from "@/lib/narrative-writer/types";

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
    const [bannerOptions, setBannerOptions] = useState<Array<{ text: string; note?: string }>>([]);
    const [selectedBannerIndex, setSelectedBannerIndex] = useState<number | null>(null);
    const [generatingBanners, setGeneratingBanners] = useState(false);
    
    // 报幕缓冲区：用户勾选后暂存的报幕（可编辑、可批量生成）
    const [buffer, setBuffer] = useState<Array<{ text: string; note?: string; id: string }>>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = window.localStorage.getItem("narrative_writer_buffer");
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });
    const [showBuffer, setShowBuffer] = useState(false); // 是否展开缓冲区面板
    
    // 数据面板相关状态
    const [activeTab, setActiveTab] = useState<"write" | "data">("write");
    const [memories, setMemories] = useState<MemoryCard[]>([]);
    const [emotions, setEmotions] = useState<EmotionCard[]>([]);
    const [waterLevels, setWaterLevels] = useState<Record<string, WaterLevelState>>({});
    const [writerState, setWriterState] = useState<NarrativeWriterState | null>(null);
    const [contextHierarchy, setContextHierarchy] = useState<ContextHierarchy | null>(null);
    const [extractionRules, setExtractionRules] = useState<ExtractionRules | null>(null);
    const [dataLoading, setDataLoading] = useState(false);
    
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
    // ETA 用最近 N 步的滚动均值，避免第1步冷启动把整体预估拉高
    const [recentStepTimes, setRecentStepTimes] = useState<number[]>([]);
    const ETA_ROLLING_WINDOW = 3; // 取最近 3 步的均值
    const ETA_CAP_MS = 30 * 60 * 1000; // 预估上限 30 分钟，避免吓人

    // 场景推荐相关状态
    const [sceneRecommendations, setSceneRecommendations] = useState<SceneRecommendation[]>([]);
    const [loadingRecommendations, setLoadingRecommendations] = useState(false);
    const [selectedScene, setSelectedScene] = useState<string | null>(null);
    const [editingScene, setEditingScene] = useState<SceneRecommendation | null>(null);
    
    // 加载场景推荐
    const loadRecommendations = useCallback(async () => {
        setLoadingRecommendations(true);
        try {
            const activeSession = getActiveMixSession();
            if (!activeSession) return;
            
            const memories = await getMemoryCards({ status: "生效" });
            const pendingMemories = await getMemoryCards({ status: "待核" });
            const emotions = await getEmotionCards({ status: "生效" });
            const waterLevels = await getWaterLevels();
            const writerState = await getWriterState();
            const hierarchy = await getContextHierarchy();
            const context = await loadCharacterWorldFromSession(activeSession.id);
            
            const currentWaterLevel = waterLevels['戏内层']?.水位 || 'L0';
            
            const recommendations = generateSmartRecommendations({
                memories,
                pendingMemories,
                emotions,
                waterLevel: currentWaterLevel,
                writerState,
                hierarchy,
                characterName: context?.characterProfile?.charName || "角色",
                worldText: context?.characterProfile?.worldText || "",
            });
            
            setSceneRecommendations(recommendations);
        } catch (err) {
            console.error("[NarrativeWriter] Failed to load recommendations:", err);
        } finally {
            setLoadingRecommendations(false);
        }
    }, []);
    
    // 打开面板时加载推荐
    useEffect(() => {
        if (open) {
            loadRecommendations();
        }
    }, [open, loadRecommendations]);
    
    // 选择场景
    const handleSelectScene = useCallback((scene: SceneRecommendation) => {
        setSelectedScene(scene.id);
        // 将场景参数转换为倾向文本
        const parts = [];
        if (scene.params.tone) parts.push(`基调:${scene.params.tone}`);
        if (scene.params.pace) parts.push(`节奏:${scene.params.pace}`);
        if (scene.params.focus) parts.push(`焦点:${scene.params.focus}`);
        if (scene.params.relationship) parts.push(`关系:${scene.params.relationship}`);
        if (scene.params.trigger) parts.push(`触发:${scene.params.trigger}`);
        if (scene.params.theme) parts.push(`主题:${scene.params.theme}`);
        if (scene.params.taboo) parts.push(`禁忌:${scene.params.taboo}`);
        if (scene.params.density) parts.push(`密度:${scene.params.density}`);
        
        const sceneText = parts.length > 0 ? parts.join(",") : scene.name;
        setTendency(sceneText);
    }, []);
    
    // 编辑场景
    const handleEditScene = useCallback((scene: SceneRecommendation) => {
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
            const [mems, emos, waters, state, hierarchy, rules] = await Promise.all([
                getMemoryCards(),
                getEmotionCards(),
                getWaterLevels(),
                getWriterState(),
                getContextHierarchy(),
                getExtractionRules(),
            ]);
            setMemories(mems);
            setEmotions(emos);
            setWaterLevels(waters);
            setWriterState(state);
            setContextHierarchy(hierarchy);
            setExtractionRules(rules);
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

    // 拖动逻辑
    const onDragPointerDown = (e: ReactPointerEvent) => {
        e.preventDefault();
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
    
    // 生成报幕选项（选择模式第一步）
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

            const options = await generateBannerOptions({
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

            if (options.length === 0) {
                setError("未能生成报幕选项，请重试");
                return;
            }

            // 转换为可编辑格式
            setBannerOptions(options.map(text => ({ text, note: "" })));
        } catch (err: any) {
            console.error("[NarrativeWriter] Generate banners failed:", err);
            setError(err.message || "生成报幕失败，请重试");
        } finally {
            setGeneratingBanners(false);
        }
    }, [tendency]);
    
    // 更新报幕文本
    const updateBannerText = useCallback((index: number, newText: string) => {
        setBannerOptions(prev => prev.map((opt, i) => 
            i === index ? { ...opt, text: newText } : opt
        ));
    }, []);
    
    // 更新报幕批注
    const updateBannerNote = useCallback((index: number, newNote: string) => {
        setBannerOptions(prev => prev.map((opt, i) => 
            i === index ? { ...opt, note: newNote } : opt
        ));
    }, []);
    
    // 将报幕加入/移出缓冲区
    const toggleBuffer = useCallback((option: { text: string; note?: string }) => {
        setBuffer(prev => {
            const exists = prev.find(b => b.text === option.text);
            if (exists) {
                return prev.filter(b => b.text !== option.text);
            }
            return [...prev, { ...option, id: Date.now().toString() + Math.random().toString(36).slice(2, 9) }];
        });
    }, []);
    
    // 从缓冲区移除
    const removeFromBuffer = useCallback((id: string) => {
        setBuffer(prev => prev.filter(b => b.id !== id));
    }, []);
    
    // 更新缓冲区中的报幕文本
    const updateBufferText = useCallback((id: string, newText: string) => {
        setBuffer(prev => prev.map(b => b.id === id ? { ...b, text: newText } : b));
    }, []);
    
    // 更新缓冲区中的批注
    const updateBufferNote = useCallback((id: string, newNote: string) => {
        setBuffer(prev => prev.map(b => b.id === id ? { ...b, note: newNote } : b));
    }, []);
    
    // 根据缓冲区中的一个报幕生成正文
    const handleWriteFromBuffer = useCallback(async (bufferItem: { text: string; note?: string }) => {
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
            }, bufferItem.text);

            await insertNarrativeTurn(activeSession.id, result.body, result.banner);
        } catch (err: any) {
            console.error("[NarrativeWriter] Write from buffer failed:", err);
            setError(err.message || "执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency]);
    
    // 批量生成缓冲区所有报幕
    const handleBatchWriteFromBuffer = useCallback(async () => {
        if (buffer.length === 0) return;
        
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

            // 逐个生成
            for (const item of buffer) {
                const enhancedTendency = item.note 
                    ? `${tendency.trim()}。特别说明：${item.note}`
                    : tendency.trim();

                const result = await writeWithSelectedBanner({
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
                }, item.text);

                await insertNarrativeTurn(activeSession.id, result.body, result.banner);
            }
        } catch (err: any) {
            console.error("[NarrativeWriter] Batch write failed:", err);
            setError(err.message || "批量执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency, buffer]);
    
    // 打开编辑模态框
    const handleOpenEdit = useCallback((type: "memory" | "emotion", card: MemoryCard | EmotionCard) => {
        setEditingCard({ type, card });
        // EmotionCard 没有"内容"字段，用标签+强度作为编辑初值
        setEditContent(type === "memory" ? (card as MemoryCard).内容 ?? "" : `${(card as EmotionCard).标签}(${(card as EmotionCard).强度})`);
    }, []);
    
    // 保存编辑
    const handleSaveEdit = useCallback(async () => {
        if (!editingCard) return;
        
        try {
            if (editingCard.type === "memory") {
                await updateMemoryCard(editingCard.card.id, { 内容: editContent });
            } else {
                await updateEmotionCard(editingCard.card.id, { 内容: editContent } as any);
            }
            setEditingCard(null);
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Save edit failed:", err);
        }
    }, [editingCard, editContent, loadData]);
    
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
            const hierarchy = await getContextHierarchy() || {
                L2_章节摘要: [],
                L3_全局大纲: "",
                lastCompressedAt: 0,
            };
            hierarchy.L2_章节摘要 = L2_章节摘要;
            hierarchy.L3_全局大纲 = L3_全局大纲;
            hierarchy.lastCompressedAt = Date.now();
            await saveContextHierarchy(hierarchy);
            
            // 阶段二：分片提炼记忆卡（先成"待核"，在记忆审核里确认后置为生效）
            let savedCount = 0;
            try {
                savedCount = await extractMemoriesFromCompression(
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
            
            loadData();
        } catch (err) {
            console.error("[NarrativeWriter] Compress failed:", err);
            setError(err instanceof Error ? err.message : "记忆整理失败");
        } finally {
            setCompressing(false);
            setCompressProgress(null);
        }
    }, [loadData]);
    
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
                lastTurn.text,
                recentTurns,
                {
                    sessionId: activeSession.id,
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
            }, selected.text);

            setOutput({ banner: result.banner, body: result.body });
            await insertNarrativeTurn(activeSession.id, result.body, result.banner);
            
            // 重置选择状态
            setBannerOptions([]);
            setSelectedBannerIndex(null);
        } catch (err: any) {
            console.error("[NarrativeWriter] Write with banner failed:", err);
            setError(err.message || "执笔失败，请重试");
        } finally {
            setLoading(false);
        }
    }, [tendency, selectedBannerIndex, bannerOptions]);

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
                        
                        {/* 场景推荐卡片 */}
                        <div>
                            <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span>📖 接下来可以这样发展（基于记忆库）</span>
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
                                    暂无推荐，试试手动输入或让 AI 决定
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
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                                            <div style={{ display: "flex", gap: "6px", alignItems: "center", flex: 1 }}>
                                                <span style={{ fontSize: "16px" }}>{scene.emoji}</span>
                                                <span style={{ fontSize: "12px", color: "#e5e7eb", fontWeight: 600 }}>{scene.name}</span>
                                            </div>
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
                                                title="编辑参数"
                                            >
                                                ✏️
                                            </button>
                                        </div>
                                        <div style={{ fontSize: "10px", color: "#9ca3af", marginBottom: "2px" }}>
                                            {scene.reason}
                                        </div>
                                        {scene.detail && (
                                            <div style={{ fontSize: "10px", color: "#6b7280", fontStyle: "italic" }}>
                                                "{scene.detail.slice(0, 40)}{scene.detail.length > 40 ? '...' : ''}"
                                            </div>
                                        )}
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
                        
                        {/* 选择模式：报幕选项列表 */}
                        {mode === "select" && bannerOptions.length > 0 && (
                            <div style={{ marginTop: "8px" }}>
                                <label style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px", display: "block" }}>
                                    选择一个剧情方向（可编辑报幕文字，添加批注说明你的想法）
                                </label>
                                {selectedBannerIndex === null && (
                                    <div style={{ fontSize: "11px", color: "#a78bfa", marginBottom: "8px", padding: "6px 8px", background: "rgba(167, 139, 250, 0.1)", borderRadius: "4px" }}>
                                        💡 点击任意报幕卡片选中它，下方会出现「根据选中报幕生成正文」按钮
                                    </div>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    {bannerOptions.map((option, idx) => {
                                        const inBuffer = buffer.some(b => b.text === option.text);
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
                                            
                                            {/* 报幕文本编辑框 */}
                                            <textarea
                                                value={option.text}
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
                                    已暂存 {buffer.length} 个报幕，可编辑后逐个或批量生成
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "12px" }}>
                                    {buffer.map((item) => (
                                        <div key={item.id} style={{
                                            padding: "10px",
                                            background: "rgba(255, 255, 255, 0.03)",
                                            border: "1px solid rgba(255, 255, 255, 0.1)",
                                            borderRadius: "6px",
                                        }}>
                                            {/* 报幕编辑 */}
                                            <textarea
                                                value={item.text}
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
                        ) : (
                            <>
                                {/* 第一层：记忆健康度仪表盘 */}
                                <div style={{ marginBottom: "12px" }}>
                                    {/* 卡片统计 */}
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "6px", marginBottom: "10px" }}>
                                        {[
                                            { label: "生效中", value: memories.filter(m => m.状态 === "生效").length + emotions.filter(e => e.状态 === "生效").length, color: "#10b981" },
                                            { label: "已归档", value: memories.filter(m => m.状态 === "归档").length + emotions.filter(e => e.状态 === "归档").length, color: "#6b7280" },
                                            { label: "待核实", value: memories.filter(m => m.状态 === "待核").length, color: "#f59e0b", warn: true },
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
                                            ⚠️ 待核实 ({memories.filter(m => m.状态 === "待核").length + emotions.filter(e => e.状态 === "待核").length})
                                        </button>
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
                                                    <div key={card.id} style={{
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
                                                            <div style={{ display: "flex", gap: "4px" }}>
                                                                {card.状态 === "待核" && (
                                                                    <button
                                                                        onClick={() => updateMemoryCard(card.id, { 状态: "生效" }).then(() => loadData())}
                                                                        title="确认生效"
                                                                        style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: "2px", fontSize: "12px", fontWeight: 600 }}
                                                                    >
                                                                        ✅
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => handleOpenEdit("memory", card)}
                                                                    title="编辑"
                                                                    style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    ✏️
                                                                </button>
                                                                <button
                                                                    onClick={() => archiveMemoryCard(card.id).then(() => loadData())}
                                                                    title="归档"
                                                                    style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    📦
                                                                </button>
                                                                <button
                                                                    onClick={() => deleteMemoryCard(card.id).then(() => loadData())}
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
                                                    <div key={card.id} style={{
                                                        padding: "8px",
                                                        background: "rgba(255, 255, 255, 0.03)",
                                                        borderRadius: "6px",
                                                    }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                            <div style={{ fontSize: "11px", color: "#6b7280" }}>
                                                                {card.主体} · {card.标签}({card.强度}) · {card.状态}
                                                            </div>
                                                            <div style={{ display: "flex", gap: "4px" }}>
                                                                {card.状态 === "待核" && (
                                                                    <button
                                                                        onClick={() => updateEmotionCard(card.id, { 状态: "生效" } as any).then(() => loadData())}
                                                                        title="确认生效"
                                                                        style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: "2px", fontSize: "12px", fontWeight: 600 }}
                                                                    >
                                                                        ✅
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => handleOpenEdit("emotion", card)}
                                                                    title="编辑"
                                                                    style={{ background: "none", border: "none", color: "#a78bfa", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    ✏️
                                                                </button>
                                                                <button
                                                                    onClick={() => archiveEmotionCard(card.id).then(() => loadData())}
                                                                    title="归档"
                                                                    style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", padding: "2px", fontSize: "12px" }}
                                                                >
                                                                    📦
                                                                </button>
                                                                <button
                                                                    onClick={() => deleteEmotionCard(card.id).then(() => loadData())}
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
