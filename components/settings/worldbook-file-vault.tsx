"use client";

// components/settings/worldbook-file-vault.tsx
// 「世界书 → 添加条目 → 从文件库导入」的两步弹层：
//   ① 选一篇材料（文件库里的文档，或当场挑本地 docx/txt/pdf 解析）
//   ② 选导入方式（整篇一条 / 按章节分条）→ 预览将产生哪几条、各自的触发词
// 只负责产出 drafts；落库由 worldbook-manager 走它自己的 sanitizeEntryImport（默认值一致）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Search, Upload } from "lucide-react";
import { BottomSheet } from "@/components/ui/modal";
import {
    describeEntryDrafts,
    entryDraftsFromDocument,
    type WorldBookEntryDraft,
    type WorldBookImportMode,
} from "@/lib/worldbook-file-vault";
import {
    fileVaultEntryToDocument,
    loadFileVaultLibrary,
    parseDocumentFile,
    type FileVaultEntry,
    type ImportedDocument,
} from "@/lib/chat-document-import";

function fmtChars(value: number): string {
    return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value);
}

export function WorldBookFileVaultImport({
    open,
    onClose,
    onImport,
}: {
    open: boolean;
    onClose: () => void;
    /** 用户确认后把要落的条目草稿交出去（由调用方补默认字段并入库） */
    onImport: (drafts: WorldBookEntryDraft[]) => void;
}) {
    const [tab, setTab] = useState<"library" | "file">("library");
    const [doc, setDoc] = useState<ImportedDocument | null>(null);
    const [mode, setMode] = useState<WorldBookImportMode>("chapters");
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [library, setLibrary] = useState<{ ready: boolean; installed: boolean; entries: FileVaultEntry[] }>({
        ready: false,
        installed: false,
        entries: [],
    });
    const fileRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!open) return;
        setDoc(null);
        setError("");
        setBusy("");
        setQuery("");
        setMode("chapters");
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let alive = true;
        void loadFileVaultLibrary()
            .then((result) => {
                if (!alive) return;
                setLibrary({ ready: true, installed: Boolean(result.app), entries: result.entries });
                if (!result.app) setTab("file");
            })
            .catch(() => {
                if (alive) setLibrary({ ready: true, installed: false, entries: [] });
            });
        return () => { alive = false; };
    }, [open]);

    const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return library.entries;
        return library.entries.filter((entry) => (
            `${entry.title}\n${entry.category}\n${entry.tags.join(" ")}\n${entry.note}\n${entry.text.slice(0, 4000)}`
                .toLowerCase()
                .includes(keyword)
        ));
    }, [library.entries, query]);

    const pickDocument = useCallback((next: ImportedDocument) => {
        setDoc(next);
        // 有真正的章节就默认分条，否则整篇一条
        const chapters = next.chapters ?? [];
        const meaningful = chapters.length > 1
            && chapters.some((chapter) => !/^第\s*\d+\s*段$/.test(chapter.title) && chapter.title !== "全文");
        setMode(meaningful ? "chapters" : "single");
        setError("");
    }, []);

    const handleLocalFile = useCallback(async (file: File) => {
        setError("");
        setBusy(`正在解析 ${file.name}…`);
        try {
            pickDocument(await parseDocumentFile(file));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    }, [pickDocument]);

    const drafts = useMemo(
        () => (doc ? entryDraftsFromDocument(doc, mode) : []),
        [doc, mode],
    );
    const plan = useMemo(() => describeEntryDrafts(drafts), [drafts]);
    const chapterCount = doc?.chapters?.length ?? 0;

    if (!open) return null;

    return (
        <BottomSheet
            title={doc ? "导入为世界书条目" : "从文件库导入"}
            onClose={onClose}
        >
            {error ? <div className="wb-fv-error">{error}</div> : null}

            {!doc ? (
                <>
                    <div className="wb-fv-tabs">
                        <button
                            type="button"
                            className="wb-fv-tab"
                            data-active={tab === "library" ? "1" : undefined}
                            onClick={() => setTab("library")}
                        >
                            文件库{library.entries.length ? ` · ${library.entries.length}` : ""}
                        </button>
                        <button
                            type="button"
                            className="wb-fv-tab"
                            data-active={tab === "file" ? "1" : undefined}
                            onClick={() => setTab("file")}
                        >
                            本地文件
                        </button>
                    </div>

                    {busy ? (
                        <div className="wb-fv-loading">
                            <Loader2 size={15} className="wb-fv-spin" />
                            <span>{busy}</span>
                        </div>
                    ) : null}

                    {!busy && tab === "library" ? (
                        <>
                            {!library.ready ? <div className="wb-fv-hint">正在读取文件库…</div> : null}
                            {library.ready && !library.installed ? (
                                <div className="wb-fv-hint">
                                    本机还没装「文件库」应用。装上它（应用工坊 → 导入 file-vault.zip）之后，
                                    世界观 / 人设材料就能一键变成世界书条目。也可以先用右边「本地文件」。
                                </div>
                            ) : null}
                            {library.ready && library.installed ? (
                                <>
                                    <div className="wb-fv-search">
                                        <Search size={14} />
                                        <input
                                            className="ui-input ui-input-inline"
                                            value={query}
                                            onChange={(event) => setQuery(event.target.value)}
                                            placeholder="搜材料标题 / 标签 / 正文"
                                        />
                                    </div>
                                    {filtered.length === 0 ? (
                                        <div className="wb-fv-hint">
                                            {library.entries.length === 0
                                                ? "文件库里还没有材料，去应用里导入几篇吧。"
                                                : "没有匹配的材料。"}
                                        </div>
                                    ) : (
                                        <div className="wb-fv-list">
                                            {filtered.slice(0, 200).map((entry) => (
                                                <button
                                                    type="button"
                                                    key={entry.id}
                                                    className="wb-fv-item"
                                                    onClick={() => pickDocument(fileVaultEntryToDocument(entry))}
                                                >
                                                    <FolderOpen size={15} strokeWidth={1.6} />
                                                    <span className="wb-fv-item-main">
                                                        <span className="wb-fv-item-title">{entry.title}</span>
                                                        <span className="wb-fv-item-meta">
                                                            {entry.category || "未分类"}
                                                            {entry.tags.length ? ` · ${entry.tags.join("、")}` : ""}
                                                            {` · ${fmtChars(entry.charCount)} 字`}
                                                        </span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : null}
                        </>
                    ) : null}

                    {!busy && tab === "file" ? (
                        <>
                            <button type="button" className="ui-btn ui-btn-outline w-full" onClick={() => fileRef.current?.click()}>
                                <Upload size={16} /> 选一个文件（docx / doc / txt / md / pdf）
                            </button>
                            <div className="wb-fv-hint" style={{ marginTop: 10 }}>
                                解析只在这台设备上做。旧版 .doc 只能尽力抽取，pdf 需要联网加载解析库。
                            </div>
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".txt,.md,.markdown,.docx,.doc,.pdf,.rtf"
                                style={{ display: "none" }}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void handleLocalFile(file);
                                }}
                            />
                        </>
                    ) : null}
                </>
            ) : (
                <>
                    <div className="wb-fv-doc">
                        <div className="wb-fv-doc-title">
                            <FileText size={15} strokeWidth={1.7} />
                            {doc.title}
                        </div>
                        <div className="wb-fv-doc-meta">
                            {doc.source === "library" ? "来自文件库" : "本地文件"}
                            {doc.category ? ` · ${doc.category}` : ""}
                            {` · ${fmtChars(doc.charCount)} 字`}
                        </div>
                    </div>

                    <div className="wb-fv-modes">
                        <button
                            type="button"
                            className="wb-fv-mode"
                            data-active={mode === "chapters" ? "1" : undefined}
                            disabled={chapterCount <= 1}
                            onClick={() => setMode("chapters")}
                        >
                            <b>按章节分条</b>
                            <i>{chapterCount > 1 ? `切成 ${chapterCount} 条，各带自己的触发词` : "这篇没有分章，不可用"}</i>
                        </button>
                        <button
                            type="button"
                            className="wb-fv-mode"
                            data-active={mode === "single" ? "1" : undefined}
                            onClick={() => setMode("single")}
                        >
                            <b>整篇一条</b>
                            <i>关键词命中时整篇注入</i>
                        </button>
                    </div>

                    <div className="wb-fv-plan">
                        将添加 <b>{plan.count}</b> 条 · 共 {fmtChars(plan.chars)} 字 · 约 {fmtChars(plan.tokens)} token
                    </div>

                    <div className="wb-fv-list">
                        {drafts.slice(0, 8).map((draft, index) => (
                            <div className="wb-fv-draft" key={index}>
                                <div className="wb-fv-draft-head">
                                    <span className="wb-fv-draft-comment">{draft.comment}</span>
                                    <span className="wb-fv-draft-chars">{fmtChars(draft.content.replace(/\s/g, "").length)} 字</span>
                                </div>
                                <div className="wb-fv-draft-keys">
                                    {draft.key ? `触发：${draft.key}` : "没有可用触发词，请导入后手动补"}
                                </div>
                            </div>
                        ))}
                        {drafts.length > 8 ? (
                            <div className="wb-fv-hint">…还有 {drafts.length - 8} 条</div>
                        ) : null}
                    </div>

                    {plan.tokens > 3000 && mode === "single" ? (
                        <div className="wb-fv-warn">
                            这一条约 {fmtChars(plan.tokens)} token，命中时会整段注入。文档有章节的话，
                            建议改用「按章节分条」。
                        </div>
                    ) : null}
                    {plan.missingKey > 0 ? (
                        <div className="wb-fv-warn">
                            有 {plan.missingKey} 条没猜出触发词，导入后请补一下关键词，否则永远不会被命中。
                        </div>
                    ) : null}

                    <div className="wb-fv-actions">
                        <button type="button" className="ui-btn ui-btn-outline" onClick={() => setDoc(null)}>换一篇</button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary"
                            onClick={() => onImport(drafts)}
                        >
                            导入 {plan.count} 条
                        </button>
                    </div>
                </>
            )}
        </BottomSheet>
    );
}
