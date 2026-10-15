"use client";

// components/chat/chat-doc-import.tsx
// 聊天室「文件导入」的两个 UI 件：
//   · ChatDocImportSheet —— 选文件（本地 / 文件库）→ 解析预览 → 章节勾选 → 插入输入框 or 生成文件卡
//   · ChatDocAttachmentTray —— 输入框上方的待发文件卡条（仿引用条/图片待发托盘）
// 私聊联系人聊天室与卷宝聊天室共用。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, FolderOpen, Loader2, X } from "lucide-react";
import {
    INSERT_TEXT_WARN_CHARS,
    attachmentCardLabel,
    attachmentSelectedChapters,
    documentToAttachment,
    estimateDocTokens,
    fileVaultEntryToDocument,
    loadFileVaultLibrary,
    parseDocumentFile,
    resolveAttachmentText,
    type ChatDocAttachment,
    type FileVaultEntry,
    type ImportedDocument,
} from "@/lib/chat-document-import";

const CAP_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 0, label: "不限" },
    { value: 3000, label: "前 3 千字" },
    { value: 12000, label: "前 1.2 万字" },
    { value: 40000, label: "前 4 万字" },
];

function fmtChars(value: number): string {
    return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value);
}

type Draft = {
    doc: ImportedDocument;
    selected: number[];
    capChars: number;
};

export function ChatDocImportSheet({
    open,
    onClose,
    onInsertText,
    onAttach,
    onNotice,
}: {
    open: boolean;
    onClose: () => void;
    /** 把正文插进聊天输入框（追加，不覆盖已有内容） */
    onInsertText: (text: string) => void;
    /** 生成一张待发的文件卡 */
    onAttach: (attachment: ChatDocAttachment) => void;
    onNotice?: (message: string) => void;
}) {
    const [tab, setTab] = useState<"file" | "library">("file");
    const [draft, setDraft] = useState<Draft | null>(null);
    const [queue, setQueue] = useState<File[]>([]);
    const [busy, setBusy] = useState("");
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState("");
    const [library, setLibrary] = useState<{ ready: boolean; installed: boolean; entries: FileVaultEntry[] }>({
        ready: false,
        installed: false,
        entries: [],
    });
    const [libraryQuery, setLibraryQuery] = useState("");
    const inputRef = useRef<HTMLInputElement | null>(null);

    const notice = useCallback((message: string) => {
        if (onNotice) onNotice(message);
    }, [onNotice]);

    // 打开时重置
    useEffect(() => {
        if (!open) return;
        setDraft(null);
        setQueue([]);
        setError("");
        setBusy("");
        setProgress(0);
        setLibraryQuery("");
    }, [open]);

    // 拉一次文件库
    useEffect(() => {
        if (!open) return;
        let alive = true;
        void loadFileVaultLibrary().then((result) => {
            if (!alive) return;
            setLibrary({ ready: true, installed: Boolean(result.app), entries: result.entries });
        }).catch(() => {
            if (alive) setLibrary({ ready: true, installed: false, entries: [] });
        });
        return () => { alive = false; };
    }, [open]);

    const filteredLibrary = useMemo(() => {
        const keyword = libraryQuery.trim().toLowerCase();
        if (!keyword) return library.entries;
        return library.entries.filter((entry) => (
            `${entry.title}\n${entry.category}\n${entry.tags.join(" ")}\n${entry.note}\n${entry.text.slice(0, 4000)}`
                .toLowerCase()
                .includes(keyword)
        ));
    }, [library.entries, libraryQuery]);

    const startParse = useCallback(async (files: File[]) => {
        if (!files.length) return;
        setQueue(files.slice(1));
        setError("");
        setBusy(`正在解析 ${files[0].name}…`);
        setProgress(0);
        try {
            const doc = await parseDocumentFile(files[0], (ratio) => setProgress(ratio));
            setDraft({ doc, selected: [], capChars: 0 });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setDraft(null);
        } finally {
            setBusy("");
            setProgress(0);
        }
    }, []);

    const nextQueued = useCallback(() => {
        if (!queue.length) {
            setDraft(null);
            return;
        }
        const [head, ...rest] = queue;
        setQueue(rest);
        void startParse([head]);
    }, [queue, startParse]);

    const draftAttachment = useMemo<ChatDocAttachment | null>(() => {
        if (!draft) return null;
        return {
            ...documentToAttachment(draft.doc),
            selected: draft.selected,
            capChars: draft.capChars,
        };
    }, [draft]);

    const draftText = useMemo(() => (draftAttachment ? resolveAttachmentText(draftAttachment) : ""), [draftAttachment]);

    if (!open) return null;

    const selectedCount = draft ? attachmentSelectedChapters(draftAttachment!).length : 0;

    const content = (
        <div
            className="modal-overlay modal-overlay-bottom"
            role="dialog"
            aria-label="导入文件"
            onClick={onClose}
        >
            <div className="modal-sheet chat-docimp-panel" onClick={(event) => event.stopPropagation()}>
                <div className="chat-docimp-head">
                    <div className="chat-docimp-head-main">
                        <div className="chat-docimp-title">
                            {draft ? draft.doc.title : "导入文件"}
                        </div>
                        <div className="chat-docimp-sub">
                            {draft
                                ? `${draft.doc.source === "library" ? "来自文件库" : "本地文件"} · ${fmtChars(draft.doc.charCount)} 字 · 约 ${fmtChars(draft.doc.tokenEstimate)} token${draft.doc.sourceNote ? ` · ${draft.doc.sourceNote}` : ""}`
                                : "docx / doc / txt / md / pdf 都能进"}
                        </div>
                    </div>
                    <button type="button" className="chat-docimp-close" onClick={onClose} aria-label="关闭">
                        <X size={16} strokeWidth={2} />
                    </button>
                </div>

                <div className="chat-docimp-body">
                    {error && <div className="chat-docimp-error">{error}</div>}

                    {busy && (
                        <div className="chat-docimp-loading">
                            <Loader2 size={16} className="chat-docimp-spin" />
                            <span>{busy}</span>
                            {progress > 0 && (
                                <div className="chat-docimp-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                            )}
                        </div>
                    )}

                    {!draft && !busy && (
                        <>
                            <div className="chat-docimp-tabs">
                                <button
                                    type="button"
                                    className="chat-docimp-tab"
                                    data-active={tab === "file" ? "1" : undefined}
                                    onClick={() => setTab("file")}
                                >
                                    本地文件
                                </button>
                                <button
                                    type="button"
                                    className="chat-docimp-tab"
                                    data-active={tab === "library" ? "1" : undefined}
                                    onClick={() => setTab("library")}
                                >
                                    文件库
                                </button>
                            </div>

                            {tab === "file" ? (
                                <div className="chat-docimp-filebox">
                                    <button
                                        type="button"
                                        className="chat-docimp-pick"
                                        onClick={() => inputRef.current?.click()}
                                    >
                                        <FileText size={18} strokeWidth={1.7} />
                                        <span>选择文件（可多选）</span>
                                    </button>
                                    <div className="chat-docimp-hint">
                                        支持 .docx .doc .txt .md .pdf .rtf。
                                        pdf 需要联网加载解析库；扫描版 pdf（无文字层）抽不出文字。
                                    </div>
                                    <input
                                        ref={inputRef}
                                        type="file"
                                        multiple
                                        accept=".txt,.md,.markdown,.docx,.doc,.pdf,.rtf,.html,.htm"
                                        style={{ display: "none" }}
                                        onChange={(event) => {
                                            const files = Array.from(event.target.files || []);
                                            event.target.value = "";
                                            void startParse(files);
                                        }}
                                    />
                                </div>
                            ) : (
                                <div className="chat-docimp-library">
                                    {!library.ready && <div className="chat-docimp-hint">正在读取文件库…</div>}
                                    {library.ready && !library.installed && (
                                        <div className="chat-docimp-hint">
                                            本机还没安装「文件库」应用。装上它（应用工坊 → 导入 file-vault.zip）之后，
                                            世界观 / 人设材料就能在这里直接挑出来发。也可以先用左边「本地文件」。
                                        </div>
                                    )}
                                    {library.ready && library.installed && (
                                        <>
                                            <input
                                                className="chat-docimp-search"
                                                placeholder="搜材料标题 / 标签 / 正文"
                                                value={libraryQuery}
                                                onChange={(event) => setLibraryQuery(event.target.value)}
                                            />
                                            {filteredLibrary.length === 0 ? (
                                                <div className="chat-docimp-hint">
                                                    {library.entries.length === 0
                                                        ? "文件库里还没有材料，先去应用里导入几篇吧。"
                                                        : "没有匹配的材料。"}
                                                </div>
                                            ) : (
                                                <div className="chat-docimp-liblist">
                                                    {filteredLibrary.slice(0, 200).map((entry) => (
                                                        <button
                                                            key={entry.id}
                                                            type="button"
                                                            className="chat-docimp-libitem"
                                                            onClick={() => {
                                                                const doc = fileVaultEntryToDocument(entry);
                                                                setDraft({ doc, selected: [], capChars: 0 });
                                                                setError("");
                                                            }}
                                                        >
                                                            <FolderOpen size={15} strokeWidth={1.6} />
                                                            <span className="chat-docimp-libitem-main">
                                                                <span className="chat-docimp-libitem-title">{entry.title}</span>
                                                                <span className="chat-docimp-libitem-meta">
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
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {draft && draftAttachment && (
                        <>
                            {draft.doc.chapters.length > 1 && (
                                <div className="chat-docimp-section">
                                    <div className="chat-docimp-section-head">
                                        <span>发送范围（{selectedCount}/{draft.doc.chapters.length} 章）</span>
                                        <span className="chat-docimp-section-actions">
                                            <button
                                                type="button"
                                                onClick={() => setDraft({ ...draft, selected: [] })}
                                            >
                                                全选
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDraft({ ...draft, selected: draft.doc.chapters.map((_, index) => index) })}
                                            >
                                                全不选
                                            </button>
                                        </span>
                                    </div>
                                    <div className="chat-docimp-chapters">
                                        {draft.doc.chapters.map((chapter, index) => {
                                            const checked = !draft.selected.length || draft.selected.includes(index);
                                            return (
                                                <label key={`${chapter.title}-${index}`} className="chat-docimp-chapter">
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => {
                                                            const base = draft.selected.length
                                                                ? draft.selected.slice()
                                                                : draft.doc.chapters.map((_, i) => i);
                                                            const next = base.includes(index)
                                                                ? base.filter((i) => i !== index)
                                                                : [...base, index].sort((a, b) => a - b);
                                                            setDraft({
                                                                ...draft,
                                                                selected: next.length === draft.doc.chapters.length ? [] : next,
                                                            });
                                                        }}
                                                    />
                                                    <span className="chat-docimp-chapter-title">{chapter.title}</span>
                                                    <span className="chat-docimp-chapter-chars">{fmtChars(chapter.chars)} 字</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            <div className="chat-docimp-section">
                                <div className="chat-docimp-section-head"><span>长度上限</span></div>
                                <div className="chat-docimp-caps">
                                    {CAP_OPTIONS.map((option) => (
                                        <button
                                            key={option.value}
                                            type="button"
                                            className="chat-docimp-cap"
                                            data-active={draft.capChars === option.value ? "1" : undefined}
                                            onClick={() => setDraft({ ...draft, capChars: option.value })}
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="chat-docimp-section">
                                <div className="chat-docimp-section-head">
                                    <span>实际发送内容预览</span>
                                    <span>{fmtChars(draftAttachment ? estimateDocTokens(draftText) : 0)} token</span>
                                </div>
                                <textarea className="chat-docimp-preview" readOnly value={draftText} />
                            </div>
                        </>
                    )}
                </div>

                <div className="chat-docimp-foot">
                    {draft ? (
                        <>
                            <button
                                type="button"
                                className="chat-docimp-btn"
                                onClick={() => {
                                    if (queue.length) { nextQueued(); return; }
                                    setDraft(null);
                                }}
                            >
                                {queue.length ? `下一个（还有 ${queue.length} 个）` : "返回"}
                            </button>
                            <button
                                type="button"
                                className="chat-docimp-btn"
                                onClick={() => {
                                    if (draftText.length > INSERT_TEXT_WARN_CHARS) {
                                        const ok = window.confirm(
                                            `这段正文有约 ${fmtChars(draftText.length)} 字，插进输入框可能会卡。`
                                            + "建议改成「生成文件卡」直接发。仍要插入吗？",
                                        );
                                        if (!ok) return;
                                    }
                                    onInsertText(draftText);
                                    notice("已插入输入框");
                                    if (queue.length) nextQueued();
                                    else setDraft(null);
                                }}
                            >
                                插入输入框
                            </button>
                            <button
                                type="button"
                                className="chat-docimp-btn primary"
                                onClick={() => {
                                    onAttach(draftAttachment!);
                                    notice(`${draft.doc.title} 已加入待发送`);
                                    if (queue.length) nextQueued();
                                    else onClose();
                                }}
                            >
                                生成文件卡
                            </button>
                        </>
                    ) : (
                        <button type="button" className="chat-docimp-btn" onClick={onClose}>关闭</button>
                    )}
                </div>
            </div>
        </div>
    );

    if (typeof document === "undefined") return null;
    return createPortal(content, document.body);
}

export function ChatDocAttachmentTray({
    attachments,
    onRemove,
    onInsert,
    onOpenImport,
    disabled,
}: {
    attachments: ChatDocAttachment[];
    onRemove: (docId: string) => void;
    onInsert: (attachment: ChatDocAttachment) => void;
    onOpenImport: () => void;
    disabled?: boolean;
}) {
    if (!attachments.length) return null;
    return (
        <div className="chat-docimp-tray" data-ui="doc-attachments">
            {attachments.map((attachment) => (
                <div key={attachment.docId} className="chat-docimp-tray-item">
                    <FileText size={14} strokeWidth={1.7} />
                    <button
                        type="button"
                        className="chat-docimp-tray-label"
                        title="点一下把正文插进输入框"
                        onClick={() => { if (!disabled) onInsert(attachment); else onOpenImport(); }}
                    >
                        {attachmentCardLabel(attachment)}
                    </button>
                    <button
                        type="button"
                        className="chat-docimp-tray-x"
                        aria-label="移除这个附件"
                        onClick={() => onRemove(attachment.docId)}
                    >
                        <X size={13} strokeWidth={2.2} />
                    </button>
                </div>
            ))}
        </div>
    );
}