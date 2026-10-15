"use client";

// components/mixology/mix-file-vault.tsx
// 吧台 / 酒柜里的「从文件库加材料」两步弹层：
//   ① 选一篇材料（文件库里的文档，或当场挑一个本地 docx/txt/pdf 解析）
//   ② 选它进哪个槽（默认按分类/标签/标题猜）→ 预填材料编辑器
// 保存之后的自动入槽由父级负责（见 mixology-app 的 fvAutoSlotRef）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Search, Upload, X } from "lucide-react";
import { MIX_KIND_LABELS, MIX_KIND_SECTION_LABELS, type MixMaterial, type MixMaterialKind } from "@/lib/mixology/types";
import {
    MIX_FILE_VAULT_KINDS,
    MIX_FILE_VAULT_TARGET_HINT,
    materialFromDocument,
    suggestMixKindFromDocument,
} from "@/lib/mixology/file-vault";
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

export function MixFileVaultImport({
    open,
    onClose,
    onCreate,
    onNotice,
}: {
    open: boolean;
    onClose: () => void;
    /** 已经装配好的材料（含 kind），父级拿去预填编辑器 */
    onCreate: (material: MixMaterial) => void;
    onNotice?: (message: string) => void;
}) {
    const [tab, setTab] = useState<"library" | "file">("library");
    const [doc, setDoc] = useState<ImportedDocument | null>(null);
    const [kind, setKind] = useState<MixMaterialKind>("base");
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
        setKind(suggestMixKindFromDocument(next));
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

    if (!open) return null;

    const overlong = Boolean(doc && doc.charCount > 20000);
    const needsOpening = kind === "character";

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(event) => event.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">
                        {doc ? `把它放进哪个槽？` : "从文件库加材料"}
                    </div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
                </div>

                <div className="mix-sheet-body">
                    {error ? <div className="mix-fv-error">{error}</div> : null}

                    {!doc ? (
                        <>
                            <div className="mix-subtabs" style={{ marginBottom: 10 }}>
                                <button
                                    type="button"
                                    data-active={tab === "library" ? "true" : undefined}
                                    onClick={() => setTab("library")}
                                >
                                    文件库{library.entries.length ? ` · ${library.entries.length}` : ""}
                                </button>
                                <button
                                    type="button"
                                    data-active={tab === "file" ? "true" : undefined}
                                    onClick={() => setTab("file")}
                                >
                                    本地文件
                                </button>
                            </div>

                            {busy ? (
                                <div className="mix-fv-loading">
                                    <Loader2 size={16} className="mix-spin" />
                                    <span>{busy}</span>
                                </div>
                            ) : null}

                            {!busy && tab === "library" ? (
                                <>
                                    {!library.ready ? <div className="mix-fv-hint">正在读取文件库…</div> : null}
                                    {library.ready && !library.installed ? (
                                        <div className="mix-fv-hint">
                                            本机还没装「文件库」应用。装上它（应用工坊 → 导入 file-vault.zip），
                                            世界观 / 人设材料就能在这里一键变成材料。也可以先用右边「本地文件」。
                                        </div>
                                    ) : null}
                                    {library.ready && library.installed ? (
                                        <>
                                            <label className="mix-fv-search">
                                                <Search size={14} />
                                                <input
                                                    value={query}
                                                    onChange={(event) => setQuery(event.target.value)}
                                                    placeholder="搜材料标题 / 标签 / 正文"
                                                />
                                            </label>
                                            {filtered.length === 0 ? (
                                                <div className="mix-fv-hint">
                                                    {library.entries.length === 0
                                                        ? "文件库里还没有材料，去应用里导入几篇吧。"
                                                        : "没有匹配的材料。"}
                                                </div>
                                            ) : (
                                                <div className="mix-fv-list">
                                                    {filtered.slice(0, 200).map((entry) => (
                                                        <button
                                                            type="button"
                                                            className="mix-fv-item"
                                                            key={entry.id}
                                                            onClick={() => pickDocument(fileVaultEntryToDocument(entry))}
                                                        >
                                                            <FolderOpen size={15} strokeWidth={1.6} />
                                                            <span className="mix-fv-item-main">
                                                                <span className="mix-fv-item-title">{entry.title}</span>
                                                                <span className="mix-fv-item-meta">
                                                                    {entry.category || "未分类"}
                                                                    {entry.tags.length ? ` · ${entry.tags.join("、")}` : ""}
                                                                    {` · ${fmtChars(entry.charCount)} 字`}
                                                                </span>
                                                                {entry.note ? <span className="mix-fv-item-note">{entry.note}</span> : null}
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
                                    <button
                                        type="button"
                                        className="mix-fv-pick"
                                        onClick={() => fileRef.current?.click()}
                                    >
                                        <Upload size={17} />
                                        <span>选一个文件（docx / doc / txt / md / pdf）</span>
                                    </button>
                                    <div className="mix-fv-hint">
                                        解析只在这台设备上做，不会上传。旧版 .doc 只能尽力抽取，pdf 需要联网加载解析库。
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
                            <div className="mix-fv-doc">
                                <div className="mix-fv-doc-title">
                                    <FileText size={15} strokeWidth={1.7} />
                                    {doc.title}
                                </div>
                                <div className="mix-fv-doc-meta">
                                    {doc.source === "library" ? "来自文件库" : "本地文件"}
                                    {doc.category ? ` · ${doc.category}` : ""}
                                    {` · ${fmtChars(doc.charCount)} 字 · 约 ${fmtChars(Math.ceil(doc.tokenEstimate))} token`}
                                </div>
                            </div>

                            <div className="mix-fv-label">放进哪个槽</div>
                            <div className="mix-fv-kinds">
                                {MIX_FILE_VAULT_KINDS.map((item) => (
                                    <button
                                        type="button"
                                        className="mix-fv-kind"
                                        data-active={kind === item ? "true" : undefined}
                                        key={item}
                                        onClick={() => setKind(item)}
                                    >
                                        <b>{MIX_KIND_LABELS[item]}</b>
                                        <i>{MIX_KIND_SECTION_LABELS[item]}</i>
                                    </button>
                                ))}
                            </div>
                            <div className="mix-fv-hint">{MIX_FILE_VAULT_TARGET_HINT[kind]}</div>

                            {needsOpening ? (
                                <div className="mix-fv-warn">角色卡还差一段开场白，保存前记得在编辑器里补上。</div>
                            ) : null}
                            {overlong ? (
                                <div className="mix-fv-warn">
                                    这篇有 {fmtChars(doc.charCount)} 字，进配方后会一直占着上下文。
                                    建议在编辑器里删到够用为止，或改放进「基底」这类本身就该长的槽。
                                </div>
                            ) : null}
                        </>
                    )}
                </div>

                {doc ? (
                    <div className="mix-fv-foot">
                        <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setDoc(null)}>
                            换一篇
                        </button>
                        <button
                            type="button"
                            className="mix-pill-btn"
                            data-tone="gold"
                            onClick={() => {
                                onCreate(materialFromDocument(doc, kind));
                                onNotice?.(`已按「${doc.title}」预填${MIX_KIND_LABELS[kind]}，保存后直接进配方`);
                                onClose();
                            }}
                        >
                            填入编辑器
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
