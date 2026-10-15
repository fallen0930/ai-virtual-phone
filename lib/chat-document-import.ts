// lib/chat-document-import.ts
// 聊天室「文件导入」的解析与数据层。
//
// 目标：把用户手上的长篇材料（docx / doc / txt / md / pdf）在本地解析成纯文本，
// 再交给聊天输入框——要么直接塞进输入框继续编辑，要么作为一张「文件卡」附件随下一条
// 消息发出去（正文进模型上下文，气泡只显示一张卡，不刷屏）。
//
// 解析能力分工：
//   · txt / md / 未知后缀 —— decodeTxtArrayBuffer（已在 reading-parser 里做过编码探测）
//   · docx —— jszip 解包 + word/document.xml 抽段落（与 css-import-button 同款做法）
//   · doc  —— 尽力而为：其实是 docx / rtf / html 就按那几种走，真二进制走双解码启发式
//   · pdf  —— reading-parser 的 extractPdfPlainText（PDF.js）
// 另外提供「文件库」自定义应用（file.vault）的材料读取，供「从文件库导入」用。

import { decodeTxtArrayBuffer, extractPdfPlainText } from "./reading-parser";
import { hydrateKvDb } from "./kv-db";
import {
    loadInstalledCustomApps,
    readCustomAppCollection,
} from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

/** 「文件库」自定义应用的 manifest.id，聊天室靠它找到材料库 */
export const FILE_VAULT_MANIFEST_ID = "file.vault";
export const FILE_VAULT_COLLECTION = "documents";

/** 单个文档的正文上限（避免超长文档把上下文撑爆） */
export const MAX_DOC_CHARS = 400000;
/** 分章默认目标长度 */
const CHAPTER_TARGET_CHARS = 2600;
/** 输入框「插入全文」时的建议上限（再长就让用户走文件卡） */
export const INSERT_TEXT_WARN_CHARS = 20000;

export type ImportedChapter = {
    title: string;
    text: string;
    chars: number;
};

export type ImportedDocument = {
    id: string;
    /** 展示名（文件名去掉后缀，或材料标题） */
    title: string;
    ext: string;
    /** 全量正文 */
    text: string;
    charCount: number;
    tokenEstimate: number;
    /** 解析说明，例如「按 gb18030 解码」「旧版 .doc 尽力提取」 */
    sourceNote: string;
    source: "file" | "library";
    /** 文件库来源的元信息 */
    category?: string;
    tags?: string[];
    note?: string;
    originalName?: string;
    chapters: ImportedChapter[];
};

/** 输入框上方的待发附件 */
export type ChatDocAttachment = {
    docId: string;
    title: string;
    ext: string;
    source: ImportedDocument["source"];
    category?: string;
    tags?: string[];
    note?: string;
    chapters: ImportedChapter[];
    /** 选中的章节下标；空数组 = 全选 */
    selected: number[];
    /** 截断上限，0 = 不限 */
    capChars: number;
    charCount: number;
    tokenEstimate: number;
};

// ── 通用小工具 ──────────────────────────────────────────

function uid(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function countDocChars(text: string): number {
    return String(text || "").replace(/\s/g, "").length;
}

/** 粗略 token 估算：中文≈1 字 1 token，西文≈3.6 字符 1 token */
export function estimateDocTokens(text: string): number {
    const value = String(text || "");
    const cjk = (value.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    return Math.ceil(cjk + (value.length - cjk) / 3.6);
}

export function extOfName(name: string): string {
    const matched = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    return matched ? matched[1].toLowerCase() : "";
}

function decodeEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

function scoreText(text: string): number {
    const sample = String(text || "").slice(0, 24000);
    if (!sample.trim()) return -100000;
    const bad = (sample.match(/\uFFFD/g) || []).length;
    const nul = (sample.match(/\u0000/g) || []).length;
    const ctrl = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const common = (sample.match(/[\u4E00-\u9FA5]/g) || []).length;
    const rare = (sample.match(/[\u3400-\u4DBF\uF900-\uFAFF]/g) || []).length;
    const punct = (sample.match(/[，。！？；：“”‘’、（）《》…—]/g) || []).length;
    const ascii = (sample.match(/[A-Za-z0-9\s]/g) || []).length;
    return common * 3 + punct * 2 + ascii * 0.2 - bad * 80 - nul * 100 - ctrl * 20 - rare * 30;
}

function decodeLatin1(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
}

// ── docx ────────────────────────────────────────────────

function docxXmlToText(xml: string): string {
    const stripped = xml
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<w:cr\b[^>]*\/>/g, "\n")
        .replace(/<\/w:tc>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:tbl\b[^>]*>/g, "\n")
        .replace(/<\/w:tr>/g, "\n")
        .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "")
        .replace(/<[^>]*>/g, "");
    return decodeEntities(stripped)
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file("word/document.xml");
    if (!file) throw new Error("不是有效的 .docx（缺少 word/document.xml）");
    const text = docxXmlToText(await file.async("string"));
    if (!text.trim()) throw new Error("这个 .docx 里没有可提取的文字（可能是纯图片文档）");
    return text;
}

// ── html / rtf ──────────────────────────────────────────

function htmlToText(html: string): string {
    const stripped = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]*>/g, "");
    return decodeEntities(stripped).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function rtfToText(rtf: string): string {
    let text = String(rtf);
    // 先摘掉字体表 / 颜色表 / 样式表这类头部组（里面全是控制字，没有正文）
    const dropGroups = [
        "fonttbl", "colortbl", "stylesheet", "info", "listtable", "listoverridetable",
        "rsidtbl", "generator", "themedata", "latentstyles", "datastore", "xmlnstbl",
    ];
    let changed = true;
    let guard = 0;
    while (changed && guard < 12) {
        changed = false;
        guard += 1;
        for (const name of dropGroups) {
            const next = text.replace(new RegExp(`\\{\\\\${name}\\b[\\s\\S]*?\\}`, "g"), "");
            if (next !== text) {
                text = next;
                changed = true;
            }
        }
        const star = text.replace(/\{\\\*[\s\S]*?\}/g, "");
        if (star !== text) {
            text = star;
            changed = true;
        }
    }
    return text
        .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) => {
            try {
                return new TextDecoder("gb18030").decode(new Uint8Array([parseInt(hex, 16)]));
            } catch {
                return "";
            }
        })
        .replace(/\\u(-?\d+)\s?\??/g, (_, raw: string) => {
            let code = parseInt(raw, 10);
            if (code < 0) code += 65536;
            return String.fromCharCode(code);
        })
        .replace(/\\par[d]?\b/g, "\n")
        .replace(/\\line\b/g, "\n")
        .replace(/\\tab\b/g, "\t")
        .replace(/\\\{/g, "{")
        .replace(/\\\}/g, "}")
        .replace(/\\\\/g, "\\")
        .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
        .replace(/[{}]/g, "")
        .replace(/\{[^{}]*\}/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── 旧版 .doc（尽力而为）───────────────────────────────

const READABLE_RUN_SPLIT =
    /[^\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\u3400-\u4DBFA-Za-z0-9\s.,:;!?'"()\-—，。！？；：、“”‘’（）《》…\r\n]{4,}/;

function extractRunsByDecode(bytes: Uint8Array, decoder: string): string {
    let text = "";
    try {
        text = new TextDecoder(decoder, { fatal: false }).decode(bytes);
    } catch {
        return "";
    }
    const kept: string[] = [];
    for (const raw of text.split(READABLE_RUN_SPLIT)) {
        const run = raw.replace(/[ \t]+/g, " ").trim();
        if (run.length < 6) continue;
        if (scoreText(run) / Math.max(1, run.length) < 0.55) continue;
        kept.push(run);
    }
    return kept.join("\n");
}

async function extractLegacyDocText(buffer: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buffer);
    // ① 其实是 docx / 普通 zip
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return extractDocxText(buffer);
    // ② 伪装成 .doc 的 RTF（很常见）
    if (decodeLatin1(bytes.subarray(0, 8)).indexOf("{\\rtf") === 0) {
        return rtfToText(decodeLatin1(bytes));
    }
    // ③ 伪装成 .doc 的 HTML
    const head = decodeLatin1(bytes.subarray(0, 4096)).toLowerCase();
    if (head.indexOf("<html") >= 0 || head.indexOf("<body") >= 0 || head.indexOf("<?xml") >= 0) {
        return htmlToText(decodeTxtArrayBuffer(buffer, "utf-8").text);
    }
    // ④ 真·OLE 二进制：gb18030 与 utf-16le 各抽一遍，比信息量
    const gbk = extractRunsByDecode(bytes, "gb18030");
    const utf16 = extractRunsByDecode(bytes, "utf-16le");
    const winner = scoreText(utf16) > scoreText(gbk) ? utf16 : gbk;
    const cleaned = winner
        .replace(/Microsoft\s+(Word|Office)[^\n]{0,60}/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (cleaned.replace(/\s/g, "").length < 20) {
        throw new Error("旧版 .doc 是二进制格式，抽不出可读文字。请在 Word/WPS 里「另存为 .docx」后重新导入");
    }
    return cleaned;
}

// ── 分章 ────────────────────────────────────────────────

const HEADING_RE = new RegExp(
    "^(?:"
    + "#{1,6}\\s+\\S.{0,60}"                                  // markdown 标题
    + "|第[零一二三四五六七八九十百千万\\d]{1,8}[章节回卷篇部]\\s*.{0,40}" // 第X章
    + "|[零一二三四五六七八九十]{1,3}[、.．]\\s*\\S.{0,40}"     // 一、二、
    + "|【[^】]{1,30}】.{0,30}"                                // 【片段名】
    + "|(?:Part|Chapter|CHAPTER)\\s+\\d{1,3}.{0,40}"
    + ")$"
);

function splitIntoChapters(text: string): ImportedChapter[] {
    const lines = text.split("\n");
    const groups: Array<{ title: string; lines: string[] }> = [];
    let current: { title: string; lines: string[] } | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && trimmed.length <= 60 && HEADING_RE.test(trimmed)) {
            if (current) groups.push(current);
            current = { title: trimmed.replace(/^#{1,6}\s+/, "").slice(0, 40), lines: [] };
            continue;
        }
        if (!current) current = { title: "开头", lines: [] };
        current.lines.push(line);
    }
    if (current) groups.push(current);

    let chapters: ImportedChapter[] = groups
        .map((group) => {
            const body = group.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
            return { title: group.title, text: body, chars: countDocChars(body) };
        })
        .filter((chapter) => chapter.text.length > 0);

    // 标题切出来太少（说明这份文档没有规整标题）→ 退回按长度切
    if (chapters.length <= 1) {
        chapters = chunkByLength(text, CHAPTER_TARGET_CHARS);
        // 只有一块时别叫「第 1 段」，就叫全文
        if (chapters.length === 1) chapters[0].title = "全文";
    } else {
        // 过长的段落再按长度切碎，保证每张卡都不至于太大
        const refined: ImportedChapter[] = [];
        for (const chapter of chapters) {
            if (chapter.chars <= CHAPTER_TARGET_CHARS * 2.2) {
                refined.push(chapter);
                continue;
            }
            chunkByLength(chapter.text, CHAPTER_TARGET_CHARS).forEach((piece, index) => {
                refined.push({ ...piece, title: `${chapter.title}（${index + 1}）` });
            });
        }
        chapters = refined;
    }
    return chapters.length ? chapters : [{ title: "全文", text, chars: countDocChars(text) }];
}

function chunkByLength(text: string, targetChars: number): ImportedChapter[] {
    const paragraphs = text.split(/\n{2,}/);
    const out: ImportedChapter[] = [];
    let buffer: string[] = [];
    let bufferChars = 0;
    let index = 1;
    const flush = () => {
        const body = buffer.join("\n\n").trim();
        if (!body) return;
        out.push({ title: `第 ${index} 段`, text: body, chars: countDocChars(body) });
        index += 1;
        buffer = [];
        bufferChars = 0;
    };
    for (const paragraph of paragraphs) {
        const piece = paragraph.trim();
        if (!piece) continue;
        buffer.push(piece);
        bufferChars += piece.length;
        if (bufferChars >= targetChars) flush();
    }
    flush();
    return out;
}

// ── 对外：解析一个 File ─────────────────────────────────

export async function parseDocumentFile(
    file: File,
    onProgress?: (ratio: number) => void,
): Promise<ImportedDocument> {
    const ext = extOfName(file.name);
    const baseTitle = file.name.replace(/\.[^.]+$/, "") || file.name;
    let text = "";
    let sourceNote = "";

    if (ext === "docx") {
        text = await extractDocxText(await file.arrayBuffer());
    } else if (ext === "doc") {
        text = await extractLegacyDocText(await file.arrayBuffer());
        sourceNote = "旧版 .doc 二进制格式，尽力提取，建议另存为 .docx 后复核";
    } else if (ext === "pdf") {
        const result = await extractPdfPlainText(await file.arrayBuffer(), { onProgress });
        text = result.text;
        sourceNote = `PDF 共 ${result.totalPages} 页，已按文字层抽取`;
        if (countDocChars(text) < 10) {
            throw new Error("这个 PDF 是扫描件（没有文字层），抽不出正文");
        }
    } else if (ext === "rtf") {
        text = rtfToText(decodeLatin1(new Uint8Array(await file.arrayBuffer())));
    } else if (ext === "html" || ext === "htm") {
        const buffer = await file.arrayBuffer();
        text = htmlToText(decodeTxtArrayBuffer(buffer, "utf-8").text);
    } else {
        const decoded = decodeTxtArrayBuffer(await file.arrayBuffer());
        text = decoded.text;
        if (decoded.encoding && decoded.encoding !== "utf-8") sourceNote = `按 ${decoded.encoding} 解码`;
    }

    return buildImportedDocument({ title: baseTitle, ext, text, sourceNote, source: "file", originalName: file.name });
}

export function buildImportedDocument(input: {
    title: string;
    ext: string;
    text: string;
    sourceNote?: string;
    source: ImportedDocument["source"];
    category?: string;
    tags?: string[];
    note?: string;
    originalName?: string;
}): ImportedDocument {
    const text = String(input.text || "").replace(/\u0000/g, "").slice(0, MAX_DOC_CHARS);
    return {
        id: uid("doc"),
        title: input.title || "未命名材料",
        ext: input.ext || "txt",
        text,
        charCount: countDocChars(text),
        tokenEstimate: estimateDocTokens(text),
        sourceNote: input.sourceNote || "",
        source: input.source,
        category: input.category,
        tags: input.tags,
        note: input.note,
        originalName: input.originalName,
        chapters: splitIntoChapters(text),
    };
}

// ── 文件库（file.vault）读取 ────────────────────────────

export type FileVaultEntry = {
    id: string;
    title: string;
    category: string;
    tags: string[];
    note: string;
    text: string;
    charCount: number;
    updatedAt: string;
    sourceType: string;
};

export function findFileVaultApp(): InstalledCustomApp | null {
    try {
        const apps = loadInstalledCustomApps();
        return apps.find((app) => app.manifest?.id === FILE_VAULT_MANIFEST_ID)
            ?? apps.find((app) => app.name === "文件库")
            ?? null;
    } catch {
        return null;
    }
}

/** 读「文件库」里的全部材料；应用没装或还没数据时返回空数组 */
export async function loadFileVaultLibrary(): Promise<{ app: InstalledCustomApp | null; entries: FileVaultEntry[] }> {
    await hydrateKvDb();
    const app = findFileVaultApp();
    if (!app) return { app: null, entries: [] };
    const rows = readCustomAppCollection(app.id, FILE_VAULT_COLLECTION);
    const entries: FileVaultEntry[] = [];
    for (const row of rows) {
        const text = String((row as Record<string, unknown>).text ?? "");
        if (!text.trim()) continue;
        entries.push({
            id: String((row as Record<string, unknown>).id ?? uid("lib")),
            title: String((row as Record<string, unknown>).title ?? "未命名材料"),
            category: String((row as Record<string, unknown>).category ?? ""),
            tags: Array.isArray((row as Record<string, unknown>).tags)
                ? ((row as Record<string, unknown>).tags as unknown[]).map(String)
                : [],
            note: String((row as Record<string, unknown>).note ?? ""),
            text,
            charCount: Number((row as Record<string, unknown>).charCount ?? countDocChars(text)),
            updatedAt: String((row as Record<string, unknown>).updatedAt ?? ""),
            sourceType: String((row as Record<string, unknown>).sourceType ?? "paste"),
        });
    }
    entries.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return { app, entries };
}

export function fileVaultEntryToDocument(entry: FileVaultEntry): ImportedDocument {
    return buildImportedDocument({
        title: entry.title,
        ext: entry.sourceType || "txt",
        text: entry.text,
        sourceNote: "",
        source: "library",
        category: entry.category,
        tags: entry.tags,
        note: entry.note,
    });
}

// ── 附件（待发送）──

export function documentToAttachment(doc: ImportedDocument): ChatDocAttachment {
    return {
        docId: doc.id,
        title: doc.title,
        ext: doc.ext,
        source: doc.source,
        category: doc.category,
        tags: doc.tags,
        note: doc.note,
        chapters: doc.chapters,
        selected: [],
        capChars: 0,
        charCount: doc.charCount,
        tokenEstimate: doc.tokenEstimate,
    };
}

export function attachmentSelectedChapters(attachment: ChatDocAttachment): ImportedChapter[] {
    if (!attachment.selected.length) return attachment.chapters;
    const picked = attachment.selected
        .filter((index) => index >= 0 && index < attachment.chapters.length)
        .sort((a, b) => a - b)
        .map((index) => attachment.chapters[index]);
    return picked.length ? picked : attachment.chapters;
}

/** 附件最终要发出去的正文（带来源说明，便于模型理解这是「用户丢过来的材料」） */
export function resolveAttachmentText(attachment: ChatDocAttachment): string {
    const chapters = attachmentSelectedChapters(attachment);
    const head: string[] = [`【文件】${attachment.title}`];
    const meta: string[] = [];
    if (attachment.category) meta.push(`分类：${attachment.category}`);
    if (attachment.tags && attachment.tags.length) meta.push(`标签：${attachment.tags.join("、")}`);
    if (attachment.note) meta.push(`备注：${attachment.note}`);
    if (attachment.selected.length && attachment.selected.length !== attachment.chapters.length) {
        meta.push(`本次只发所选 ${attachment.selected.length}/${attachment.chapters.length} 章`);
    }
    if (meta.length) head.push(meta.join("；"));
    let body = chapters
        .map((chapter) => (chapters.length > 1 ? `【${chapter.title}】\n${chapter.text}` : chapter.text))
        .join("\n\n");
    const fullChars = countDocChars(body);
    if (attachment.capChars > 0 && body.length > attachment.capChars) {
        body = `${body.slice(0, attachment.capChars)}\n……（已按设置截断，完整正文约 ${fullChars} 字）`;
    }
    return `${head.join("\n")}\n────────\n${body}`;
}

export function attachmentPreviewText(attachment: ChatDocAttachment): string {
    const text = resolveAttachmentText(attachment);
    const limit = 1200;
    return text.length > limit ? `${text.slice(0, limit)}\n……` : text;
}

export function attachmentCharCount(attachment: ChatDocAttachment): number {
    return countDocChars(resolveAttachmentText(attachment));
}

/** 气泡卡片的标题：文件名 + 规模 */
export function attachmentCardLabel(attachment: ChatDocAttachment): string {
    const chapters = attachmentSelectedChapters(attachment);
    const chars = attachmentCharCount(attachment);
    const chapterNote = attachment.chapters.length > 1
        ? (attachment.selected.length ? `${chapters.length}/${attachment.chapters.length} 章 · ` : `${attachment.chapters.length} 章 · `)
        : "";
    return `${attachment.title}.${attachment.ext}（${chapterNote}${chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万` : chars} 字）`;
}
