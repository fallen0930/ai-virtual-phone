// lib/mixology/history.ts
// 独家特调 · 对局历史回传：轮次裁剪、块补发、消息组装。
//
// 从 engine.ts 拆出的纯逻辑层（不 import 大模型链路），职责单一：把对局的
// turns 变成发给模型的 LLMMessage 序列。聊天室（手机频道）进来后这里多了
// 三件事——msg 轮带【手机消息·会话名】标记进历史、msg 轮不占 scene 轮数
// （单独限流）、有 msg 轮时给系统提示词挂「手机消息说明」段。

import type { LLMMessage } from "../llm-prompt-assembler";
import {
    MIX_ENCORE_CLOSE,
    MIX_ENCORE_OPEN,
    MIX_TICKET_CLOSE,
    MIX_TICKET_OPEN,
    mixNamedOpen,
    type MixAssembledPrompt,
} from "./assembler";
import { mixTurnChannel } from "./chatroom-types";
import type { MixHookSection } from "./mechanism-protocol";
import { getMixMaterial } from "./storage";
import {
    mixTurnEncoreBlocks,
    mixTurnTicketBlocks,
    type MixSession,
    type MixTurn,
    type MixTurnBlock,
} from "./types";

/**
 * 一块壳内原文还原成带标记的整块。named = 这一轮不止一块，开标签要带名字
 * （名字按块的供稿材料 id 现取；材料被删就退回不具名的壳）。
 */
function blockText(open: string, close: string, block: MixTurnBlock, named: boolean): string {
    const name = named && block.id ? getMixMaterial(block.id)?.name?.trim() : undefined;
    return `${name ? mixNamedOpen(open, name) : open}\n${block.raw}\n${close}`;
}

/**
 * 一条消息的"原始输出"。存了真原文（rawText，新数据）就直接给——机括标记行、
 * 被滤网洗掉的字只存在于这一份里，拼装还原不出来。
 * 老数据没有 rawText，退回把剥掉的状态栏/小剧场块拼回去的近似还原。
 */
export function mixTurnRawText(turn: MixTurn): string {
    if (turn.role !== "assistant") return turn.text;
    if (turn.rawText !== undefined) return turn.rawText;
    // 顺序与输出要求一致：状态栏在正文前、小剧场在正文后——历史回放就是模型的"输出习惯"示范
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    return [
        ...tickets.map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

/** 历史回传裁决：这一块的壳内原文要不要回传给模型（按块的供稿材料各自定） */
export type MixFeedResolver = (kind: "ticket" | "encore", materialId: string | undefined) => "latest" | "all" | "none";

/**
 * 历史回放：默认只有最近一条 assistant 轮补回状态栏/小剧场块。
 * 模型需要的只有两样——最新状态的接续（契约的变化规则只依赖上一轮的值）
 * 和一份格式示范（防掉格式），最后一块两者都够；更旧的块随轮数线性膨胀，
 * 是纯 token 负担（按信息量基准每轮各两三百字，长局能省上万字符）。
 * 材料自己可改档（按块裁决，多块互不牵连）：all = 它的往期块逐轮回传；
 * none = 连最近一轮都不回传，一个字不占。存储不动：块原文原样留着，
 * 界面回放与编辑不受影响。
 */
export function turnToHistoryContent(turn: MixTurn, isLast: boolean, feedOf?: MixFeedResolver): string {
    if (turn.role !== "assistant") return turn.text;
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    const keep = (kind: "ticket" | "encore") => (b: MixTurnBlock) => {
        const feed = feedOf?.(kind, b.id) ?? "latest";
        return feed === "all" || (isLast && feed !== "none");
    };
    return [
        ...tickets.filter(keep("ticket")).map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.filter(keep("encore")).map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

/**
 * 对局进行了几轮：玩家发一句、模型回一句算一轮，按玩家发言数算。
 * 开场白不算轮；聊天室（msg）的消息不算轮——聊天再热闹也不改变"推过几轮剧情"。
 * 玩家刚发完还没等到回复的那一轮也算在内。列表页与删除确认用它计数。
 */
export function mixRoundCount(turns: MixTurn[]): number {
    return turns.reduce((n, t) => (t.role === "user" && mixTurnChannel(t) === "scene" ? n + 1 : n), 0);
}

/**
 * 回传轮数上限：只保留最近 limit 轮（一轮 = 一条 assistant 回复，连同它前面的
 * 玩家发言）。默认不裁——玩家在对局设置里调了才生效；只裁发给模型的消息，
 * 存储与界面回放永远完整。
 */
export function limitMixTurns(turns: MixTurn[], limit: number | undefined): MixTurn[] {
    if (!limit || limit <= 0) return turns;
    let count = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role !== "assistant") continue;
        count += 1;
        if (count > limit) return turns.slice(i + 1);
    }
    return turns;
}

/** 手机消息轮在历史里的回传上限：聊天条数再多也只带最近这些，防 token 失控 */
export const MIX_MSG_HISTORY_CAP = 40;

/**
 * 历史轮选择（buildMixMessages 用）：
 * - scene 轮沿用 limitMixTurns 的口径——找到倒数第 limit+1 个正文 assistant，
 *   从它后面整段截起（玩家的发言跟它点名的回复一起走，不拆对）；
 * - msg 轮不占 scene 轮数，散落在正文里也各归各的时间点，只裁条数：
 *   超过 MIX_MSG_HISTORY_CAP 的旧聊天直接不进请求。
 */
export function selectHistoryTurns(turns: MixTurn[], limit: number | undefined): MixTurn[] {
    let sceneStart = 0;
    if (limit && limit > 0) {
        let count = 0;
        for (let i = turns.length - 1; i >= 0; i -= 1) {
            const turn = turns[i];
            if (mixTurnChannel(turn) !== "msg" && turn.role === "assistant") {
                count += 1;
                if (count > limit) {
                    sceneStart = i + 1;
                    break;
                }
            }
        }
    }
    const scenePart = turns.slice(sceneStart);
    let msgCount = 0;
    const kept: MixTurn[] = [];
    for (let i = scenePart.length - 1; i >= 0; i -= 1) {
        const turn = scenePart[i];
        if (mixTurnChannel(turn) === "msg") {
            msgCount += 1;
            if (msgCount > MIX_MSG_HISTORY_CAP) continue;
        }
        kept.push(turn);
    }
    return kept.reverse();
}

/** msg 轮进历史的标记：【手机消息·会话名】（群名/私聊对象名，落轮时的名称快照） */
function msgTurnLabel(turn: MixTurn): string {
    return `【手机消息·${turn.threadLabel?.trim() || "手机"}】`;
}

/** 一轮的最终历史文本：scene 轮原样（带补发块），msg 轮加标记与说话人前缀 */
function turnHistoryText(turn: MixTurn, isFeedLast: boolean, feedOf?: MixFeedResolver): string {
    const base = turnToHistoryContent(turn, isFeedLast, feedOf);
    if (mixTurnChannel(turn) !== "msg") return base;
    const speaker = turn.speaker?.trim();
    return `${msgTurnLabel(turn)}${speaker ? `${speaker}：` : ""}${base}`;
}

export function buildMixMessages(
    session: MixSession,
    assembled: MixAssembledPrompt,
    extraUserNudge?: string,
    feedOf?: MixFeedResolver,
    lastReplyOverride?: string,
): LLMMessage[] {
    const messages: LLMMessage[] = [
        { role: "system", content: assembled.system, _debugMeta: { marker: "mixology_system" } },
    ];
    const turns = selectHistoryTurns(session.turns, session.historyLimit);
    // "最近一条 assistant"看的是 scene 轮：状态栏/小剧场的补发与机括改写都属于正文
    // 流水线，手机消息轮插在后面也不能把正文轮的接续与格式示范挤掉
    let lastSceneAssistantIdx = -1;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === "assistant" && mixTurnChannel(turns[i]) === "scene") {
            lastSceneAssistantIdx = i;
            break;
        }
    }
    for (const [i, turn] of turns.entries()) {
        const isFeedLast = i === lastSceneAssistantIdx;
        messages.push({
            role: turn.role,
            // 机括落杯前改写过最近一条 scene assistant：发给模型的整条换成它给的（只改请求，不落库）
            content: isFeedLast && typeof lastReplyOverride === "string"
                ? lastReplyOverride
                : turnHistoryText(turn, isFeedLast, feedOf),
            _debugMeta: { marker: "mixology_history", _fromHistory: true },
        });
    }
    if (assembled.postHistory) {
        messages.push({
            role: "system",
            content: assembled.postHistory,
            _debugMeta: { marker: "mixology_strength" },
        });
    }
    if (extraUserNudge) {
        messages.push({
            role: "user",
            content: extraUserNudge,
            _debugMeta: { marker: "mixology_nudge" },
        });
    }
    return messages;
}

/**
 * 系统提示词里的「手机消息说明」挂段：只在对局出现过 msg 轮时挂（纯正文老局
 * 一个字不多）。挂在「扮演总纲」段之后——它讲的是怎么理解历史，不是输出格式。
 */
export function phoneHistoryNoteSection(session: Pick<MixSession, "turns">): MixHookSection | null {
    const hasMsg = session.turns.some((t) => mixTurnChannel(t) === "msg");
    if (!hasMsg) return null;
    return {
        at: "base",
        text: [
            "手机消息说明：你们平时也会用手机聊天。",
            "历史里带【手机消息·…】标记的消息发生在手机上，不是当面对话——把它们当作你们已经知道的事实与往来，",
            "后续剧情要自然接住（比如回应手机里约好的事），但不要把这些消息复述成面对面的场景。",
        ].join(""),
    };
}
