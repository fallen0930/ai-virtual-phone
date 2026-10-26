// lib/mixology/chatroom-engine.ts
// 独家特调 · 聊天室（手机频道）引擎：提示词装配、回复生成与写回。
//
// 与对局引擎（engine.ts）的关系：共享酒柜材料与全局 API 配置，但输出协议
// 完全不同——聊天是短消息（不输出状态栏/小剧场壳），心声用 〔心声〕…〔/心声〕
// 包裹。写回：每条消息以 channel:"msg" 的轮次追加进对局 turns（不走机括/
// 小票抽值/滤网/执笔抽取；state 快照沿用最近一轮现值，绝不重算）。
// runChatroomReply 只负责「一次模型调用」；队列串行与落库由调用方
// （session-runtime 队列 + 聊天室 UI）负责。

import { sendLLMRequest, sendLLMStreamRequest } from "../chat-engine";
import type { LLMMessage } from "../llm-prompt-assembler";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "./assembler";
import { mixCardProfileText, mixCardWorldText } from "./card-freeform";
import {
    mixTurnChannel,
    type MixPhoneMessage,
    type MixPhoneWorldSettings,
} from "./chatroom-types";
import { resolveMixApiConfig } from "./engine";
import {
    createMixId,
    type MixCharacterCard,
    type MixPersonaMaterial,
    type MixSession,
    type MixState,
    type MixTextMaterial,
    type MixTurn,
} from "./types";

// ── 心声壳 ──

export const MIX_INNER_VOICE_OPEN = "〔心声〕";
export const MIX_INNER_VOICE_CLOSE = "〔/心声〕";

export type MixChatBubble = { kind: "text" | "voice"; text: string };

/**
 * 把一条聊天消息拆成正文/心声气泡序列。模型忘了闭合时，开标记之后的全部按
 * 心声兜住——宁可把后半句当成内心戏，也不把壳标记漏给界面。
 */
export function splitChatInnerVoice(text: string): MixChatBubble[] {
    const bubbles: MixChatBubble[] = [];
    let rest = text ?? "";
    while (rest.length) {
        const openIdx = rest.indexOf(MIX_INNER_VOICE_OPEN);
        if (openIdx < 0) {
            bubbles.push({ kind: "text", text: rest.trim() });
            break;
        }
        if (openIdx > 0) bubbles.push({ kind: "text", text: rest.slice(0, openIdx).trim() });
        const from = openIdx + MIX_INNER_VOICE_OPEN.length;
        const closeIdx = rest.indexOf(MIX_INNER_VOICE_CLOSE, from);
        if (closeIdx < 0) {
            bubbles.push({ kind: "voice", text: rest.slice(from).trim() });
            break;
        }
        bubbles.push({ kind: "voice", text: rest.slice(from, closeIdx).trim() });
        rest = rest.slice(closeIdx + MIX_INNER_VOICE_CLOSE.length);
    }
    return bubbles.filter((b) => b.text);
}

// ── 提示词装配 ──

function stackTextMaterials(materials: MixTextMaterial[] | undefined, apply: (t: string) => string): string {
    return (materials ?? [])
        .map((m) => (m.content ?? "").trim())
        .filter(Boolean)
        .map(apply)
        .join("\n\n");
}

/** 成员简注：baseInfo/personality 里第一个非空行的前 60 字，够认人就好 */
function memberBriefLine(member: MixCharacterCard): string {
    const line = [member.baseInfo, member.personality]
        .map((t) => (t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "")
        .filter(Boolean)[0] ?? "";
    return line.slice(0, 60);
}

function sectionBlock(title: string, lines: (string | null)[]): string {
    return [title, ...lines.filter((l): l is string => Boolean(l))].join("\n\n");
}

function chatOutputSection(speakerName: string, innerVoice: boolean, isGroup: boolean): string {
    const lines = [
        "# 输出要求",
        `- 直接给出 ${speakerName} 发出的聊天消息本身：口语、简短、符合角色此刻的心情与两人的关系。不要旁白、不要他人视角的描写、不要输出状态栏/小剧场或任何壳标记。`,
        "- 一次回复就是一条消息，可以几句话自然成段；不要替对方说话或替对方做决定。",
    ];
    if (isGroup) {
        lines.push("- 这是一场群聊：历史里每条消息以「名字：」标注说话人。你只以自己的身份回话，其他成员的发言不由你代写。");
    }
    if (innerVoice) {
        lines.push(
            `- 需要表达 ${speakerName} 此刻的内心活动时，在消息末尾用 ${MIX_INNER_VOICE_OPEN}…${MIX_INNER_VOICE_CLOSE} ` +
            "包裹一句内心独白（心声是别人看不见的内心戏，不是第二条消息）；没有内心活动就不要输出这个标记。",
        );
    }
    return lines.join("\n");
}

export type ChatroomPromptInput = {
    /** 本次回话的角色（system 里的 {{char}} 就是它） */
    speaker: MixCharacterCard;
    /** 世界全部成员卡（按 memberIds 顺序）；>1 时按群聊措辞 */
    members: MixCharacterCard[];
    /** 世界设定来源卡（绑定局主演 / 独立世界首成员）；缺省用 speaker */
    worldCard?: MixCharacterCard | null;
    persona?: MixPersonaMaterial | null;
    /** 绑定局的条件命中基底/风味材料；独立世界一般不给 */
    baseMaterials?: MixTextMaterial[];
    flavorMaterials?: MixTextMaterial[];
    /** 前情提要正文（调用方用 buildChatroomPlotContext 拼好） */
    plotContext?: string | null;
    /** 绑定局的对局状态，供 {{状态.X}} 宏与前情措辞 */
    state?: MixState | null;
    innerVoice: boolean;
};

export function assembleChatroomPrompt(input: ChatroomPromptInput): string {
    const speakerName = input.speaker.charName.trim() || input.speaker.name.trim() || "角色";
    const userName = input.persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    const apply = (text: string) => applyMixMacros(text, speakerName, userName, input.state ?? undefined);

    const baseText = stackTextMaterials(input.baseMaterials, apply);
    const flavorText = stackTextMaterials(input.flavorMaterials, apply);
    const worldText = apply(mixCardWorldText(input.worldCard ?? input.speaker));
    const profileText = apply(mixCardProfileText(input.speaker));
    const others = input.members.filter((m) => m.id !== input.speaker.id);

    const sections: (string | null)[] = [
        baseText ? `# 扮演总纲\n${baseText}` : null,
        [
            "# 聊天室",
            `这是一场「即时聊天」：${userName} 和 ${speakerName} 在手机上互发消息。`,
            "这不是面对面的正文演出——你输出的每个字都是聊天气泡里打出来的消息，要像真人打字：口语、简短、带情绪。",
        ].join("\n"),
        sectionBlock("# 角色资料", [
            `## 名字\n${speakerName}`,
            profileText || null,
            others.length
                ? [
                    "## 同一场聊天里的其他人",
                    ...others.map((m) => {
                        const name = m.charName.trim() || m.name.trim() || "成员";
                        const brief = memberBriefLine(m);
                        return `- ${name}${brief ? `：${brief}` : ""}`;
                    }),
                ].join("\n")
                : null,
        ]),
        input.persona?.content?.trim()
            ? [
                "# 用户资料",
                input.persona.userName?.trim() ? `## 名字\n${userName}` : null,
                `## 用户人设\n${apply(input.persona.content.trim())}`,
            ]
                .filter(Boolean)
                .join("\n\n")
            : null,
        worldText ? `# 世界与剧情\n${worldText}` : null,
        flavorText ? `# 文风\n${flavorText}` : null,
        input.plotContext?.trim() ? `# 前情提要\n${input.plotContext.trim()}` : null,
        chatOutputSection(speakerName, input.innerVoice, input.members.length > 1),
    ];
    return sections.filter((s): s is string => Boolean(s)).join("\n\n");
}

// ── 消息组装 ──

export function buildChatroomMessages(input: {
    system: string;
    history: MixPhoneMessage[];
    /** 群聊 true：历史每条带「名字：」前缀，让模型分得清谁在说 */
    labelSpeakers: boolean;
    userName: string;
    userMessage: string;
}): LLMMessage[] {
    const messages: LLMMessage[] = [{ role: "system", content: input.system }];
    for (const msg of input.history) {
        const label = msg.role === "user" ? input.userName : msg.speaker?.trim() || "对方";
        messages.push({
            role: msg.role,
            content: input.labelSpeakers ? `${label}：${msg.text}` : msg.text,
        });
    }
    messages.push({ role: "user", content: input.userMessage });
    return messages;
}

/** 聊天历史回传上限：只留最近 cap 条；cap <= 0 视为不回传历史 */
export function capChatHistory(history: MixPhoneMessage[], cap: number): MixPhoneMessage[] {
    if (!cap || cap <= 0) return [];
    return history.length > cap ? history.slice(-cap) : history;
}

// ── 回复策略 ──

export type ChatReplyPolicy = "mention" | "roundrobin" | "all";

/**
 * 这一轮谁回话：
 * - mention：消息里点名的成员依次各回一条；一个都没点中就回落轮流；
 * - roundrobin：接在上一个说话人后面（认不出就从第一位开始）；
 * - all：全员按成员顺序依次各回一条。
 */
export function pickChatResponders(input: {
    message: string;
    members: MixCharacterCard[];
    lastSpeakerName?: string | null;
    policy: ChatReplyPolicy;
}): MixCharacterCard[] {
    const members = input.members.filter((m) => m.charName.trim() || m.name.trim());
    if (!members.length) return [];
    if (input.policy === "all") return members;
    const mentioned = input.message
        ? members.filter((m) => input.message.includes(m.charName.trim() || m.name.trim()))
        : [];
    if (mentioned.length) return mentioned;
    const nameOf = (m: MixCharacterCard) => m.charName.trim() || m.name.trim();
    const idx = input.lastSpeakerName
        ? members.findIndex((m) => nameOf(m) === input.lastSpeakerName!.trim())
        : -1;
    return [members[(idx + 1) % members.length]];
}

// ── 写回 ──

/**
 * 造一条 msg 轮。state 快照沿用 baseTurns 里最近一份现值——聊天轮不跑小票
 * 抽值，回溯/删除时直接拿这份快照还原，数字不会停在聊天制造的未来。
 */
export function makeChatTurn(input: {
    role: "user" | "assistant";
    text: string;
    speaker?: string;
    threadId: string;
    threadLabel?: string;
    baseTurns: MixTurn[];
}): MixTurn {
    let state: MixState | undefined;
    for (let i = input.baseTurns.length - 1; i >= 0; i -= 1) {
        if (input.baseTurns[i].state) {
            state = { ...input.baseTurns[i].state };
            break;
        }
    }
    return {
        id: createMixId("turn"),
        role: input.role,
        text: input.text,
        createdAt: Date.now(),
        channel: "msg",
        speaker: input.speaker,
        threadId: input.threadId,
        threadLabel: input.threadLabel,
        state,
    };
}

// ── 前情提要 ──

/**
 * 绑定世界的聊天前情：对局最近 N 个 scene 正文轮（手机消息轮不算剧情）+
 * 「当前状态」一行。总长掐尾 4000 字，防长局把聊天上下文挤爆。
 */
export function buildChatroomPlotContext(
    session: Pick<MixSession, "turns" | "state">,
    settings: Pick<MixPhoneWorldSettings, "plotContextTurns" | "includeState">,
): string | null {
    const parts: string[] = [];
    if (settings.includeState && session.state) {
        const entries = Object.entries(session.state)
            .filter(([, v]) => String(v ?? "").trim())
            .slice(0, 12);
        if (entries.length) {
            parts.push(`【当前状态】${entries.map(([k, v]) => `${k}：${String(v)}`).join("；")}`);
        }
    }
    const n = settings.plotContextTurns;
    if (n > 0) {
        const plot = session.turns
            .filter((t) => mixTurnChannel(t) === "scene" && t.role === "assistant" && t.text.trim())
            .slice(-n)
            .map((t) => t.text.trim())
            .join("\n\n")
            .slice(-4000);
        if (plot) parts.push(plot);
    }
    return parts.length ? parts.join("\n\n") : null;
}

// ── 生成 ──

const CHATROOM_APP_ID = "mixology";
const CHATROOM_PROMPT_TAGS = ["mixology", "chatroom"];

export type ChatroomReplyUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

/**
 * 聊天室的一次模型调用。与对局同一套全局接口配置（resolveMixApiConfig），
 * 同一套「所见即模型所写」口径（skipOutputRegex/skipTimestampStrip）；
 * 流式一个字没来就报错时退回一次性请求（与 runMixGeneration 同一兜底）。
 */
export async function runChatroomReply(options: {
    system: string;
    history: MixPhoneMessage[];
    labelSpeakers: boolean;
    userName: string;
    characterName?: string;
    userMessage: string;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
}): Promise<{ text: string; usage?: ChatroomReplyUsage }> {
    const apiConfig = resolveMixApiConfig();
    if (!apiConfig) {
        throw new Error("还没有配置 API 接口，请先到设置里添加。");
    }
    const messages = buildChatroomMessages({
        system: options.system,
        history: options.history,
        labelSpeakers: options.labelSpeakers,
        userName: options.userName,
        userMessage: options.userMessage,
    });
    const meta = { characterName: options.characterName, userName: options.userName };
    const llmOptions = {
        appId: CHATROOM_APP_ID,
        appTags: CHATROOM_PROMPT_TAGS,
        skipOutputRegex: true,
        skipTimestampStrip: true,
        signal: options.signal,
    };
    if (options.onDelta && apiConfig.enableStreaming !== false) {
        let got = false;
        try {
            const streamed = await sendLLMStreamRequest(apiConfig, null, messages, [], meta, llmOptions, {
                onDelta: (chunk) => {
                    got = true;
                    options.onDelta?.(chunk);
                },
            });
            return { text: streamed.content, usage: streamed.usage };
        } catch (error) {
            // 已经吐过字再断是真出错；一个字没来多半是接口不支持 SSE，退一次性请求重试
            if (got || (error instanceof Error && options.signal?.aborted)) throw error;
        }
    }
    const raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
    return { text: raw };
}
