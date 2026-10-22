"use client";

// 宿主侧速记小窗用到的 AI 能力。
//
// 直接复用 custom-app-host-api 里的实现（ai.chat / ai.classify / ai.generate）——
// 这几个函数本身不做权限校验（权限由沙盒 runner 把关），所以宿主可以安全调用。
// 传一个「虚拟 APP 上下文」即可：配置解析会自然回退到全局默认接口，
// 于是「AI 归类 / 问角色」不依赖「随想笔记」APP 是否已安装。

import type { InstalledCustomApp } from "./custom-app-types";
import { generateCustomAppText, runCustomAppAiChat, runCustomAppAiClassify } from "./custom-app-host-api";

const HOST_CONTEXT_APP: InstalledCustomApp = {
    id: "host.quick_notes",
    name: "随想笔记",
    version: "1.0.0",
    entryHtml: "",
    permissions: [],
    manifest: { id: "quick.notes", name: "随想笔记", version: "1.0.0" },
    assets: {},
    installedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
};

const DEFAULT_CATEGORIES = ["产品想法", "交互/设计", "技术实现", "待办", "参考/灵感", "其他"];

export type OrganizeResult = { category: string; tags: string[]; summary: string };

const SYS_ORGANIZE = [
    "你是笔记整理助手。阅读用户的一条想法，输出严格的 JSON（不要任何解释、不要代码块围栏）：",
    '{"category":"分类","tags":["标签1","标签2"],"summary":"一句话摘要"}',
    "规则：category 必须从用户给出的分类清单里选一个；tags 给 2~5 个简短关键词；summary 用一句话概括核心，不超过 40 字。",
].join("\n");

function parseJsonLoose(text: string): Record<string, unknown> | null {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (m) t = m[0];
    try {
        const parsed = JSON.parse(t) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** 让通用模型把一条想法归类 + 打标签 + 写摘要 */
export async function hostOrganizeNote(text: string, categories: string[]): Promise<OrganizeResult> {
    const labels = categories && categories.length ? categories : DEFAULT_CATEGORIES;
    const res = await runCustomAppAiChat(HOST_CONTEXT_APP, {
        // 宿主在 messages 非空时不会单独读 system 字段 → 把 system 一起放进 messages。
        messages: [
            { role: "system", content: SYS_ORGANIZE },
            { role: "user", content: `分类清单：${labels.join("、")}\n\n想法：\n${text}` },
        ],
        temperature: 0.2,
        maxTokens: 500,
    });
    const out = String(res.text || "");
    const obj = parseJsonLoose(out);
    if (obj) {
        const category = String(obj.category ?? "").trim();
        const tags = Array.isArray(obj.tags) ? (obj.tags as unknown[]).map(String).filter(Boolean).slice(0, 6) : [];
        const summary = String(obj.summary ?? "").trim();
        if (category || tags.length || summary) return { category, tags, summary };
    }
    // JSON 解析失败 → 退到 classify 保底分类
    let category = "";
    try {
        const c = await runCustomAppAiClassify(HOST_CONTEXT_APP, { text, labels });
        category = String(c.label || "").trim();
    } catch {
        /* classify 不可用就放弃分类 */
    }
    return { category, tags: [], summary: out.replace(/\s+/g, " ").trim().slice(0, 40) };
}

/** 让指定角色读一段内容并给出点评（走角色完整人设 / 记忆 / 世界书链路，不写入聊天记录） */
export async function hostAskCharacter(characterId: string, instruction: string, input: string): Promise<string> {
    // 宿主只在 input 为对象时才拼接它，字符串正文必须并进 instruction。
    const full = `${instruction}${input ? `\n\n${input}` : ""}`;
    const res = await generateCustomAppText(HOST_CONTEXT_APP, { characterId, instruction: full });
    return String(res.text || "");
}

export const QUICK_NOTE_DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
