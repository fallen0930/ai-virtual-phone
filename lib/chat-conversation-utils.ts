// lib/chat-conversation-utils.ts
// 多会话功能所需的纯工具：token 估算 + 本地「压缩总结」生成。
// 不依赖网络 / API key，离线可用，确保「开新窗口前压缩当前会话」永远能跑。

import { loadChatMessages, type ChatMessage } from "./chat-storage";

/**
 * 混合中英文的 token 估算。
 * 真实分词因模型而异，这里按字符类别给权重做近似：
 *  - CJK / 假名 / 谚文：每个字约 1.4~1.6 token
 *  - 拉丁字母 / 数字：约 0.5 token（≈2 字符/token）
 *  - 空格 / 标点 / 符号：约 0.3 token
 * 用于「本会话已用多少上下文」的提示，足够给出接近真实的占比。
 */
export function estimateTokens(text: string | null | undefined): number {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x4e00 && code <= 0x9fff) tokens += 1.6;        // CJK 统一表意
        else if (code >= 0x3040 && code <= 0x30ff) tokens += 1.4;  // 平假名 / 片假名
        else if (code >= 0xac00 && code <= 0xd7a3) tokens += 1.6;  // 谚文音节
        else if (code === 0x20 || code === 0x3000 || code === 0x0a || code === 0x0d) tokens += 0.25; // 空白
        else if (/[\p{P}\p{S}]/u.test(ch)) tokens += 0.3;          // 标点 / 符号
        else tokens += 0.5;                                        // 拉丁字母 / 数字 / 其它
    }
    return Math.ceil(tokens);
}

/** 估算一组消息占用的上下文 token（含角色开销的粗略补偿） */
export function estimateSessionTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
        if (m.role === "system") {
            total += estimateTokens(m.content) + 4;
        } else {
            // user/assistant/tool 各加一点角色与结构开销
            total += estimateTokens(m.content) + 4;
        }
    }
    return total;
}

const ELLIPSIS = "…";

function truncate(text: string, max: number): string {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + ELLIPSIS;
}

/** 取消息的纯文本（忽略纯媒体消息） */
function plainText(msg: ChatMessage): string {
    if (msg.content && msg.content.trim()) return msg.content.trim();
    const label = msg.mediaData?.label;
    if (label && label.trim()) return label.trim();
    return "";
}

/** 是否为「有实质文本」的对话消息（排除 system 与纯媒体/工具噪音） */
function isSubstantive(msg: ChatMessage): boolean {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    if (msg.isRetracted) return false;
    if (!plainText(msg)) return false;
    // 红包 / 转账 / 表情等媒体消息不计入话题
    if (msg.mediaType && msg.mediaType !== "quote" && msg.mediaType !== "reading_discuss") return false;
    return true;
}

const PREFERENCE_HINTS = ["喜欢", "想要", "需要", "希望", "我决定", "我的", "我打算", "偏好", "要求", "必须", "应该"];

export type ConversationSummary = {
    /** 可读的压缩摘要（中文），用于写入新会话作为 system 上下文 */
    text: string;
    /** 提取到的对话轮次（user→assistant 计数） */
    turnCount: number;
    /** 原会话估算 token 数 */
    tokenCount: number;
    /** 原会话消息条数 */
    messageCount: number;
};

/**
 * 本地抽取式压缩总结：不调用模型，离线即可生成。
 * 思路：抓首尾的用户问题定「主题」，取末尾助手回复定「结论」，扫描用户消息抽「偏好/需求」，
 * 若最后一条是用户消息则标记「待跟进」。输出结构化的可读摘要。
 */
export function summarizeChatSession(
    sessionId: string,
    opts?: { characterName?: string; userName?: string },
): ConversationSummary {
    const messages = loadChatMessages(sessionId);
    const tokenCount = estimateSessionTokens(messages);
    const substantive = messages.filter(isSubstantive);

    const userMsgs = substantive.filter(m => m.role === "user");
    const assistantMsgs = substantive.filter(m => m.role === "assistant");
    const turnCount = Math.min(userMsgs.length, assistantMsgs.length + (userMsgs.length > assistantMsgs.length ? 1 : 0));

    if (substantive.length === 0) {
        return {
            text: "【对话压缩总结】\n（该会话暂无可总结的文本内容）",
            turnCount: 0,
            tokenCount,
            messageCount: messages.length,
        };
    }

    const characterName = opts?.characterName || "AI 助手";
    const userName = opts?.userName || "用户";
    const firstTime = substantive[0].createdAt;
    const lastTime = substantive[substantive.length - 1].createdAt;
    const timeRange = firstTime && lastTime ? `${formatDate(firstTime)} → ${formatDate(lastTime)}` : "—";

    // 主题：首 2 条 + 尾 2 条用户问题（去重）
    const topicSources = [
        ...userMsgs.slice(0, 2),
        ...userMsgs.slice(-2),
    ];
    const seenTopics = new Set<string>();
    const topics: string[] = [];
    for (const m of topicSources) {
        const t = truncate(plainText(m), 140);
        const key = t.slice(0, 24);
        if (!seenTopics.has(key)) {
            seenTopics.add(key);
            topics.push(t);
        }
        if (topics.length >= 4) break;
    }

    // 结论：末 2 条助手回复（截到 220 字）
    const conclusions = assistantMsgs.slice(-2).map(m => truncate(plainText(m), 220));

    // 偏好 / 需求：扫描用户消息里含提示词的句子
    const preferences: string[] = [];
    for (const m of userMsgs) {
        if (preferences.length >= 3) break;
        const text = plainText(m);
        for (const hint of PREFERENCE_HINTS) {
            const idx = text.indexOf(hint);
            if (idx !== -1) {
                const start = Math.max(0, text.lastIndexOf("。", idx) + 1);
                const seg = truncate(text.slice(start, start + 160), 160);
                if (seg) preferences.push(seg);
                break;
            }
        }
    }

    // 待跟进：最后一条是用户消息且无后续助手回复
    const last = substantive[substantive.length - 1];
    const pending = last.role === "user" ? truncate(plainText(last), 160) : null;

    const lines: string[] = [];
    lines.push("【对话压缩总结】以下是从上一轮对话压缩得到的关键信息，请在此基础上继续帮助用户：");
    lines.push(`- 参与者：${characterName} · ${userName}`);
    lines.push(`- 时间：${timeRange}　·　共约 ${turnCount} 轮`);
    if (topics.length) {
        lines.push("- 主要话题：");
        topics.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
    }
    if (conclusions.length) {
        lines.push("- 关键结论 / 要点：");
        conclusions.forEach(c => lines.push(`  · ${c}`));
    }
    if (preferences.length) {
        lines.push("- 用户提到的偏好 / 需求：");
        preferences.forEach(p => lines.push(`  · ${p}`));
    }
    if (pending) {
        lines.push(`- 待跟进：用户最后的问题是「${pending}」，尚未得到回复。`);
    }

    return {
        text: lines.join("\n"),
        turnCount,
        tokenCount,
        messageCount: messages.length,
    };
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
