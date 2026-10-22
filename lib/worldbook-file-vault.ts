// lib/worldbook-file-vault.ts
// 「世界书」×「文件库」：把一篇世界观 / 人设文档变成世界书条目。
//
// 世界书条目的实质是「**关键词命中 → 注入这段设定**」，所以这里的核心不是搬正文，
// 而是给每一段猜一组真能被聊天命中、又不至于到处乱触发的触发词。
// 猜不准也没关系：条目导入后依然可以在列表里逐条改关键词。

import type { ImportedDocument } from "@/lib/chat-document-import";
import { estimateDocTokens } from "@/lib/chat-document-import";

export type WorldBookEntryDraft = {
    /** 触发关键词，逗号分隔 */
    key: string;
    /** 命中后注入的正文 */
    content: string;
    /** 备注（列表里显示的名字） */
    comment: string;
};

export type WorldBookImportMode = "single" | "chapters";

/** 这些词做触发词等于没做（会出现得太频繁），一律不当关键词 */
const GENERIC_KEYWORDS = new Set([
    "世界观", "设定", "设定集", "材料", "文件库", "其他", "人物", "角色", "剧情", "规则",
    "未分类", "文档", "正文", "备注", "txt", "docx", "doc", "pdf",
]);

/** 按长度自动切出来的段落标题：没有语义，不能当触发词 */
const AUTO_CHAPTER_RE = /^第\s*\d+\s*段$/;

function cleanKey(value: string): string {
    return String(value || "")
        .replace(/^[#＃\s]+/, "")
        // 去掉「第一章」「第三回」这类序号前缀，留下真正的主题词
        .replace(/^第[零一二三四五六七八九十百千万\d]{1,8}[章节回卷篇部]\s*/, "")
        .replace(/[【】[\]()（）"'“”‘’《》<>]/g, "")
        .replace(/[，。！？；：、,.!?;:\-—]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 从标题 / 标签 / 分类里凑一组触发词。
 * 取舍：宁可少而准——长词优先（「海洋势力」盖掉「海洋」），通用词直接丢。
 */
export function guessEntryKeys(input: { title?: string; category?: string; tags?: string[] }): string {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
        const key = cleanKey(raw);
        if (!key || key.length > 18) return;
        if (GENERIC_KEYWORDS.has(key)) return;
        if (seen.has(key.toLowerCase())) return;
        // 已被更长的候选覆盖 / 反过来覆盖掉更短的
        if (out.some((item) => item.includes(key))) return;
        for (let i = out.length - 1; i >= 0; i -= 1) {
            if (key.includes(out[i])) out.splice(i, 1);
        }
        seen.add(key.toLowerCase());
        out.push(key);
    };
    push(input.title || "");
    for (const tag of input.tags ?? []) push(tag);
    push(input.category || "");
    return out.slice(0, 4).join(", ");
}

/** 整篇塞进一条 */
export function singleEntryDraft(doc: ImportedDocument): WorldBookEntryDraft {
    return {
        key: guessEntryKeys(doc),
        content: doc.text,
        comment: doc.category ? `${doc.title}（${doc.category}）` : doc.title,
    };
}

/**
 * 按章节切成多条：一条设定一个触发词，比整篇一条更好命中、也更省 token。
 * 段落标题是自动切的（「第 3 段」）时没有可用触发词，退回用文档名——总比空的关键词强。
 */
export function chapterEntryDrafts(doc: ImportedDocument): WorldBookEntryDraft[] {
    const chapters = doc.chapters ?? [];
    return chapters.map((chapter) => {
        const hasRealTitle = !AUTO_CHAPTER_RE.test(chapter.title) && chapter.title !== "全文";
        const titleKeys = hasRealTitle ? guessEntryKeys({ title: chapter.title, tags: doc.tags }) : "";
        return {
            key: titleKeys || guessEntryKeys(doc),
            content: chapter.text,
            comment: `${doc.title} · ${chapter.title}`,
        };
    });
}

export function entryDraftsFromDocument(doc: ImportedDocument, mode: WorldBookImportMode): WorldBookEntryDraft[] {
    if (mode === "chapters" && (doc.chapters?.length ?? 0) > 1) return chapterEntryDrafts(doc);
    return [singleEntryDraft(doc)];
}

/** 给 UI 展示「这将产生什么」用的概要 */
export function describeEntryDrafts(drafts: WorldBookEntryDraft[]): {
    count: number;
    chars: number;
    tokens: number;
    missingKey: number;
} {
    let chars = 0;
    let tokens = 0;
    let missingKey = 0;
    for (const draft of drafts) {
        const body = String(draft.content || "");
        chars += body.replace(/\s/g, "").length;
        tokens += estimateDocTokens(body);
        if (!draft.key.trim()) missingKey += 1;
    }
    return { count: drafts.length, chars, tokens, missingKey };
}
