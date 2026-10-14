import type { MascotMsg } from "./mascot-engine";

// ── AI助手（小卷）会话工具：离线抽取式摘要 ──────────────
// 纯本地、不调模型、不产生费用：把一段对话压成「主题 / 关注点 / 最近进展」的
// 可读摘要，用于「压缩总结后开新窗口」，让新窗口不丢前文脉络。

const MAX_POINTS = 10;
const POINT_CHARS = 70;
const RECENT_CHARS = 90;
const RECENT_COUNT = 4;

function compact(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function isPlaceholder(msg: MascotMsg): boolean {
    if (msg.role !== "mascot") return false;
    const display = msg.displayText || "";
    return /^（(调用工具中|无内容)/.test(display);
}

/** 可展示、可作为对话摘要来源的消息（去掉隐藏项、工具行与占位气泡） */
export function mascotSummarySourceMessages(messages: MascotMsg[]): MascotMsg[] {
    return messages.filter((msg) => !msg.hidden && msg.role !== "tool" && !isPlaceholder(msg));
}

/** 消息的展示文本（优先 displayText），已压平空白 */
export function mascotMessagePlainText(msg: MascotMsg): string {
    return compact(msg.displayText || msg.text || "");
}

function firstSentence(text: string, cap: number): string {
    const compacted = compact(text);
    if (!compacted) return "";
    const match = compacted.match(/^[^。！？!?\n]{1,200}[。！？!?]?/);
    const sentence = (match?.[0] || compacted).trim();
    return sentence.length > cap ? `${sentence.slice(0, cap)}…` : sentence;
}

/**
 * 把一段对话构建为可读的压缩摘要。
 * @param messages 该会话的消息（含隐藏/工具行亦可，内部会过滤）
 * @returns 摘要文本；若没有可总结的用户内容则返回空串
 */
export function buildMascotSessionSummary(messages: MascotMsg[]): string {
    const visible = mascotSummarySourceMessages(messages);
    const userTexts = visible
        .filter((msg) => msg.role === "user")
        .map((msg) => mascotMessagePlainText(msg))
        .filter((text) => !!text);

    if (userTexts.length === 0) return "";

    const topic = userTexts[0].length > 50 ? `${userTexts[0].slice(0, 50)}…` : userTexts[0];

    const points: string[] = [];
    const seen = new Set<string>();
    for (const text of userTexts) {
        const point = firstSentence(text, POINT_CHARS);
        if (!point) continue;
        const key = point.slice(0, 12);
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
        if (points.length >= MAX_POINTS) break;
    }

    const recent = visible
        .slice(-RECENT_COUNT)
        .map((msg) => {
            const text = mascotMessagePlainText(msg);
            if (!text) return "";
            const clipped = text.length > RECENT_CHARS ? `${text.slice(0, RECENT_CHARS)}…` : text;
            return `${msg.role === "user" ? "我" : "AI"}：${clipped}`;
        })
        .filter((line) => !!line);

    const lines: string[] = [];
    lines.push("【上一段对话的压缩摘要 · 自动生成】");
    lines.push(`主题：${topic || "（未命名）"}`);
    lines.push(`共 ${userTexts.length} 轮交流，已于新窗口延续。`);
    if (points.length > 0) {
        lines.push("");
        lines.push("**关注点 / 需求**");
        for (const point of points) lines.push(`- ${point}`);
    }
    if (recent.length > 0) {
        lines.push("");
        lines.push("**最近的进展**");
        for (const line of recent) lines.push(`- ${line}`);
    }
    lines.push("");
    lines.push("（若需要更早的细节，直接问我，我会重新确认。）");
    return lines.join("\n");
}
