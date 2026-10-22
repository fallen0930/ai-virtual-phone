"use client";

// 随想笔记 · 宿主速记小窗
//
// 归统一控制坞管理：坞里点「速记」按钮 → 弹出这个可拖动 / 可缩放的浮窗，
// 在任意界面（含对局）都能用。写下的内容与「随想笔记」APP 共用同一份数据。
//
// 小窗里也能就地让 AI 归类、或指定角色读一遍给建议——不依赖 APP 是否打开。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { X, Sparkles, Save, Users, ArrowUpRight } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
    CONTROL_DOCK_ACTIVATE_EVENT,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import {
    QUICK_NOTES_UPDATED_EVENT,
    addHostQuickNote,
    appendHostAnalysis,
    collectQuickNoteCategories,
    isQuickNotesInstalled,
    loadHostQuickNotes,
    openQuickNotesApp,
} from "@/lib/quick-note-bridge";
import { QUICK_NOTE_DEFAULT_CATEGORIES, hostAskCharacter, hostOrganizeNote } from "@/lib/quick-note-ai";

const UI_KEY = "phone_quick_note_ui_v1";
const CONTROL_ID = "quick-note" as const;

type Rect = { x: number; y: number; w: number; h: number };
const DEFAULT_RECT: Rect = { x: 24, y: 92, w: 300, h: 380 };
const MIN_W = 220;
const MIN_H = 220;

function parseTags(raw: string): string[] {
    return raw.split(/[,，;；\n\t]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
}

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

export function QuickNoteFloat() {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState<Rect>(DEFAULT_RECT);
    const [title, setTitle] = useState("");
    const [text, setText] = useState("");
    const [category, setCategory] = useState("");
    const [tags, setTags] = useState("");
    const [summary, setSummary] = useState("");
    const [busy, setBusy] = useState("");
    const [count, setCount] = useState(0);
    const [cats, setCats] = useState<string[]>(QUICK_NOTE_DEFAULT_CATEGORIES);
    const [installed, setInstalled] = useState(true);
    const [chars, setChars] = useState<Array<{ id: string; name: string }>>([]);
    const [charId, setCharId] = useState("");
    const [result, setResult] = useState("");
    const [resultWho, setResultWho] = useState("");

    const ref = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
    const resizeRef = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

    // 随记小窗吃"可使用"：停用 = 小窗彻底不出现；只关常驻显示 = 小窗照常，坞按钮收进「更多」
    const controlDockState = useSyncExternalStore(subscribeControlDockState, getControlDockState, getControlDockState);
    const noteEnabled = controlDockState.enabled[CONTROL_ID] !== false;

    // 首次挂载再读持久化位置（SSR 安全）
    useEffect(() => { setRect(loadRect()); }, []);

    // 坞按钮 = 开合小窗
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== CONTROL_ID) return;
            setOpen(v => !v);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    const refreshMeta = useCallback(() => {
        setInstalled(isQuickNotesInstalled());
        setCount(loadHostQuickNotes().length);
        const extra = collectQuickNoteCategories();
        setCats(Array.from(new Set([...extra, ...QUICK_NOTE_DEFAULT_CATEGORIES])).slice(0, 30));
    }, []);

    useEffect(() => {
        if (!open) return;
        refreshMeta();
        try {
            const list = loadCharacters().map(c => ({ id: String(c.id), name: c.name || String(c.id) }));
            setChars(list);
            setCharId(prev => prev || list[0]?.id || "");
        } catch { setChars([]); }
        // 之后外部写入也刷新
        const onUpd = () => refreshMeta();
        window.addEventListener(QUICK_NOTES_UPDATED_EVENT, onUpd);
        return () => window.removeEventListener(QUICK_NOTES_UPDATED_EVENT, onUpd);
    }, [open, refreshMeta]);

    // ── 拖动（标题栏）──
    const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        e.preventDefault();
        dragRef.current = { sx: e.clientX, sy: e.clientY, ox: el.offsetLeft, oy: el.offsetTop };
        const move = (ev: PointerEvent) => {
            const d = dragRef.current;
            if (!d) return;
            const shell = el.closest(".phone-shell") as HTMLElement | null;
            const maxX = shell ? shell.clientWidth - el.offsetWidth : 9999;
            const maxY = shell ? shell.clientHeight - el.offsetHeight : 9999;
            setRect(prev => ({
                ...prev,
                x: Math.max(0, Math.min(maxX, d.ox + (ev.clientX - d.sx))),
                y: Math.max(0, Math.min(maxY, d.oy + (ev.clientY - d.sy))),
            }));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            dragRef.current = null;
            if (ref.current) {
                persistRect({ x: ref.current.offsetLeft, y: ref.current.offsetTop, w: ref.current.offsetWidth, h: ref.current.offsetHeight });
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    // ── 缩放（右下角）──
    const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: el.offsetWidth, oh: el.offsetHeight };
        const move = (ev: PointerEvent) => {
            const d = resizeRef.current;
            if (!d) return;
            setRect(prev => ({
                ...prev,
                w: Math.max(MIN_W, d.ow + (ev.clientX - d.sx)),
                h: Math.max(MIN_H, d.oh + (ev.clientY - d.sy)),
            }));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            resizeRef.current = null;
            if (ref.current) {
                persistRect({ x: ref.current.offsetLeft, y: ref.current.offsetTop, w: ref.current.offsetWidth, h: ref.current.offsetHeight });
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const onSave = () => {
        if (!text.trim() && !title.trim()) { setBusy(""); window.dispatchEvent(new CustomEvent("global-notice", { detail: { text: "先写点内容" } })); return; }
        if (!isQuickNotesInstalled()) {
            setBusy("请先在应用工坊导入「随想笔记」");
            return;
        }
        const note = addHostQuickNote({
            title,
            text,
            category,
            tags: parseTags(tags),
            aiSummary: summary,
            status: summary ? "sorted" : "inbox",
        });
        if (!note) { setBusy("保存失败"); return; }
        setTitle(""); setText(""); setCategory(""); setTags(""); setSummary(""); setResult(""); setResultWho("");
        setBusy("已记到随想笔记 ✓");
        window.setTimeout(() => setBusy(""), 1600);
        refreshMeta();
    };

    const onAiOrganize = async () => {
        if (!text.trim()) { setBusy("先写点内容再归类"); return; }
        setBusy("AI 正在归类…");
        try {
            const r = await hostOrganizeNote(text, cats);
            if (r.category) setCategory(r.category);
            if (r.tags.length) setTags(r.tags.join(", "));
            if (r.summary) setSummary(r.summary);
            setBusy("");
        } catch (err) {
            setBusy(String(err instanceof Error ? err.message : err));
        }
    };

    const onAsk = async () => {
        if (!text.trim()) { setBusy("先写点内容再问"); return; }
        if (!charId) { setBusy("还没有可用的角色卡"); return; }
        const who = chars.find(c => c.id === charId)?.name || "角色";
        setBusy(`${who} 正在读…`);
        setResult(""); setResultWho(who);
        try {
            const instruction = "下面是我刚随手记下的一条想法。请你以你的视角读一读并点评：值不值得做、可能踩的坑、可以怎么往前走。自然一点，别写成报告。";
            const out = await hostAskCharacter(charId, instruction, text);
            setResult(out);
            setBusy("");
        } catch (err) {
            setBusy(String(err instanceof Error ? err.message : err));
        }
    };

    const onSaveResult = () => {
        if (!result) return;
        if (!isQuickNotesInstalled()) { setBusy("请先导入「随想笔记」应用"); return; }
        const who = chars.find(c => c.id === charId)?.name || "AI";
        const ok = appendHostAnalysis({
            title: `${who} 的看法`,
            text: result,
            characterId: charId,
            characterName: who,
            mode: "single",
            noteTitles: [title || text.slice(0, 24)],
        });
        setBusy(ok ? "已存到「分析」✓" : "保存失败");
        window.setTimeout(() => setBusy(""), 1600);
    };

    if (!noteEnabled || !open) return null;

    return (
        <div
            ref={ref}
            className="qn-float"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h } as CSSProperties}
        >
            <div className="qn-float-bar" onPointerDown={onDragStart}>
                <Sparkles size={13} strokeWidth={2} />
                <span className="qn-float-name">速记</span>
                <span className="qn-float-count">{count} 条</span>
                <button
                    type="button"
                    className="qn-float-ico"
                    title="打开随想笔记"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => { if (!openQuickNotesApp()) setBusy("还没安装「随想笔记」应用"); }}
                >
                    <ArrowUpRight size={14} strokeWidth={2} />
                </button>
                <button
                    type="button"
                    className="qn-float-ico"
                    title="关闭"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => setOpen(false)}
                >
                    <X size={14} strokeWidth={2} />
                </button>
            </div>

            <div className="qn-float-body">
                {!installed && (
                    <div className="qn-float-warn">还没装「随想笔记」应用，先到「应用工坊 → 导入」装上，速记才会被保存。AI 归类与问角色不受影响。</div>
                )}
                <input
                    className="qn-float-input"
                    placeholder="标题（可留空）"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                />
                <textarea
                    className="qn-float-ta"
                    placeholder="把想法写下来…"
                    value={text}
                    onChange={e => setText(e.target.value)}
                />
                <div className="qn-float-row">
                    <input
                        className="qn-float-input"
                        list="qn-float-cats"
                        placeholder="分类"
                        value={category}
                        onChange={e => setCategory(e.target.value)}
                    />
                    <datalist id="qn-float-cats">
                        {cats.map(c => <option key={c} value={c} />)}
                    </datalist>
                    <input
                        className="qn-float-input"
                        placeholder="标签,逗号分隔"
                        value={tags}
                        onChange={e => setTags(e.target.value)}
                    />
                </div>
                {summary && <div className="qn-float-sum">AI：{summary}</div>}
                {busy && <div className="qn-float-busy">{busy}</div>}
                {result && (
                    <div className="qn-float-result">
                        <div className="who">{resultWho}</div>
                        <div className="txt">{result}</div>
                        <div className="racts">
                            <button type="button" onClick={onSaveResult}>
                                <Save size={12} strokeWidth={2} /> 存为分析
                            </button>
                        </div>
                    </div>
                )}
                <div className="qn-float-acts">
                    <button type="button" className="qn-fbtn primary" onClick={onSave}>保存</button>
                    <button type="button" className="qn-fbtn ai" onClick={onAiOrganize} disabled={!!busy}>
                        <Sparkles size={12} strokeWidth={2} /> AI 归类
                    </button>
                    <button type="button" className="qn-fbtn ai" onClick={onAsk} disabled={!!busy}>
                        <Users size={12} strokeWidth={2} /> 问角色
                    </button>
                </div>
                {chars.length > 0 && (
                    <select className="qn-float-select" value={charId} onChange={e => setCharId(e.target.value)}>
                        {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                )}
            </div>

            <div className="qn-float-resize" onPointerDown={onResizeStart} />
        </div>
    );
}

export default QuickNoteFloat;
