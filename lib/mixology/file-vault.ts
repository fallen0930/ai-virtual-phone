// lib/mixology/file-vault.ts
// 「独家特调」×「文件库」的桥。
//
// 为什么落在「材料」上而不是「配方」上：MixRecipe 只是 槽位 → 材料 id 的引用，
// 本身一个字正文都没有；正文住在材料里（角色卡 profileText/worldText、文本类 content、
// 面具 content）。所以「创建配方时读文件库」的正确做法是：
//   选一篇文档 → 选它进哪个槽 → 预填材料编辑器 → 保存后自动放进吧台那一格。
// 装配出来的材料立刻能在吧台被选进配方。

import { createMixId } from "./types";
import { MIX_SLOT_STACK, type MixCharacterCard, type MixMaterial, type MixMaterialKind, type MixPersonaMaterial, type MixTextMaterial } from "./types";
import type { ImportedDocument } from "@/lib/chat-document-import";

/**
 * 能用「纯文本」一键建成的槽位。
 * 其余种类（小票 / 外观 / 尾调 / 滤网 / 机括）本质是代码或结构化契约，塞一篇散文进去
 * 只会得到一件坏材料，所以不给它们开口子。
 */
export const MIX_FILE_VAULT_KINDS: MixMaterialKind[] = [
    "character", "persona", "preface", "base", "flavor", "glass", "strength", "checklist",
];

/** 每种槽位放进去以后，正文落在哪个框（给 UI 提示用） */
export const MIX_FILE_VAULT_TARGET_HINT: Record<string, string> = {
    character: "填进角色卡的「角色资料」（一框式）。角色卡还必须有一段开场白才能保存——保存前记得补上。",
    persona: "填进面具的「人设正文」。",
    preface: "填进「内容」，作为提示词最顶上的开场说明。",
    base: "填进「内容」，作为扮演总纲。世界观/设定类文档最常去这里。",
    flavor: "填进「内容」，作为文风要求。",
    glass: "填进「内容」，作为正文输出格式要求。",
    strength: "填进「内容」，作为尾部强化（离生成最近、优先级最高）。",
    checklist: "填进「内容」，作为输出格式检查清单。",
};

/** 关键词 → 槽位：按文档的分类 / 标签 / 标题猜一个默认落点，用户随时能改 */
const KIND_KEYWORDS: Array<{ kind: MixMaterialKind; re: RegExp }> = [
    { kind: "character", re: /人物|角色|人设|主角|配角|char|character|card/i },
    { kind: "persona", re: /面具|用户|玩家|我的人设|persona|user/i },
    { kind: "preface", re: /序言|开场|引子|前言|preface/i },
    { kind: "flavor", re: /文风|风格|语气|笔触|写作|flavor|style/i },
    { kind: "glass", re: /输出|格式|排版|正文要求|glass|format/i },
    { kind: "strength", re: /苦精|强化|强调|最高优先|strength/i },
    { kind: "checklist", re: /核对|检查|清单|checklist/i },
];

export function suggestMixKindFromDocument(doc: Pick<ImportedDocument, "title" | "category" | "tags">): MixMaterialKind {
    const haystack = `${doc.category ?? ""} ${(doc.tags ?? []).join(" ")} ${doc.title}`;
    for (const item of KIND_KEYWORDS) {
        if (item.re.test(haystack)) return item.kind;
    }
    // 兜底：世界观 / 设定 / 规则这类最常塞的是扮演总纲
    return "base";
}

function cleanName(value: string): string {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return (text || "文件库材料").slice(0, 40);
}

function buildHook(doc: ImportedDocument, chars: number): string {
    const bits: string[] = [];
    if (doc.category) bits.push(doc.category);
    if (doc.tags && doc.tags.length) bits.push(doc.tags.slice(0, 2).join("/"));
    bits.push(chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万字` : `${chars} 字`);
    if (doc.note) bits.push(doc.note.slice(0, 30));
    return `${doc.source === "library" ? "来自文件库" : "来自本地文件"} · ${bits.join(" · ")}`;
}

/**
 * 把一篇文档装配成一件材料（id / 时间戳都打好了）。
 * 只是「预填」用：交给 MixMaterialEditor 之后，用户还能改名字、钩子、正文再保存。
 */
export function materialFromDocument(doc: ImportedDocument, kind: MixMaterialKind): MixMaterial {
    const now = Date.now();
    const name = cleanName(doc.title);
    const chars = doc.charCount || String(doc.text || "").replace(/\s/g, "").length;
    const tags = Array.from(new Set([
        ...(doc.category ? [doc.category] : []),
        ...(doc.tags ?? []),
        "文件库",
    ])).slice(0, 6);
    const meta = {
        id: createMixId("mixmat"),
        name,
        hook: buildHook(doc, chars),
        tags: tags.length ? tags : undefined,
        createdAt: now,
        updatedAt: now,
    };

    if (kind === "character") {
        const card: MixCharacterCard = {
            ...meta,
            kind: "character",
            charName: name,
            // 一框式：正文原样进提示词，不做小节猜测。分框模式下 profileText 会被丢弃，
            // 所以这里必须显式指定 freeform，否则用户填的正文保存时会被洗掉。
            profileMode: "freeform",
            profileText: doc.text,
            openings: [],
        };
        return card;
    }
    if (kind === "persona") {
        const persona: MixPersonaMaterial = { ...meta, kind: "persona", content: doc.text };
        return persona;
    }
    const textMaterial: MixTextMaterial = {
        ...meta,
        kind: kind as MixTextMaterial["kind"],
        content: doc.text,
    };
    return textMaterial;
}

/** 这件材料进吧台那一格时，是「独占替换」还是「叠加」 */
export function mixSlotTakesOne(kind: MixMaterialKind): boolean {
    return MIX_SLOT_STACK[kind] === "first";
}
