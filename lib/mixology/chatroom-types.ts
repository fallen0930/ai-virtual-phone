// lib/mixology/chatroom-types.ts
// 独家特调 · 聊天室（手机频道）类型：世界 / 会话 / 消息。
//
// 心智模型：一个「世界」= 一部手机的通讯录。绑定对局的世界跟那场对局共享剧情
// 事实（消息写回对局 turns 的 msg 轮，双向联动），独立世界自娱自乐（消息落
// 自己的键）。会话分两种：direct 私聊（每成员一条，1 对 1）与 group 群聊
// （用户主动拉 ≥2 人）。消息里允许角色带心声（内心独白），壳标记见
// chatroom-engine 的 MIX_INNER_VOICE_*。

import { createMixId, type MixTurn } from "./types";

/** 世界设置（读写都经 normalize 补齐，缺项用默认值，旧数据不炸） */
export type MixPhoneWorldSettings = {
    /** 前情提要带几个 scene 轮（对局最近 N 轮正文）；0 = 不带 */
    plotContextTurns: number;
    /** 前情是否附「当前状态」行（对局 state 的键值快照） */
    includeState: boolean;
    /** 心声开关：关 = 提示词不要求输出内心独白 */
    innerVoice: boolean;
    /** 发给模型的聊天历史条数上限（防 token 失控） */
    msgHistoryCap: number;
    /** 主动消息开关：对局推演后判定角色要不要来找你 */
    proactive: boolean;
    /** 主动消息冷却：距上次主动消息不足 N 个 scene 轮不再判定 */
    proactiveCooldown: number;
    /** 每几个 scene 轮判定一次 */
    proactiveEveryRounds: number;
};

export const MIX_PHONE_SETTINGS_DEFAULTS: MixPhoneWorldSettings = {
    plotContextTurns: 6,
    includeState: true,
    innerVoice: true,
    msgHistoryCap: 40,
    proactive: true,
    proactiveCooldown: 3,
    proactiveEveryRounds: 1,
};

export type MixPhoneWorld = {
    id: string;
    name?: string;
    createdAt: number;
    updatedAt: number;
    /** 绑定的对局；无 = 独立世界 */
    sessionId?: string;
    /** 成员角色卡（酒柜 id）。绑定世界默认含该局主演，可加人 */
    memberIds: string[];
    /** 面具材料（用户人设）id */
    personaId?: string;
    settings: MixPhoneWorldSettings;
};

export type MixChatThreadKind = "direct" | "group";

export type MixChatThread = {
    id: string;
    worldId: string;
    kind: MixChatThreadKind;
    /** direct：对方角色卡 id */
    memberId?: string;
    /** group：参与者角色卡 id（≥2） */
    memberIds?: string[];
    /** 群名 */
    name?: string;
    createdAt: number;
    lastReadAt?: number;
};

/** 聊天室消息的统一形状（绑定世界从 MixTurn 投影，独立世界直接存这个） */
export type MixPhoneMessage = {
    id: string;
    role: "user" | "assistant";
    /** assistant 侧的说话角色名 */
    speaker?: string;
    text: string;
    createdAt: number;
    /** 绑定世界：来源 MixTurn.id */
    turnId?: string;
};

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function normalizeMixPhoneSettings(raw: unknown): MixPhoneWorldSettings {
    const r = (raw ?? {}) as Partial<Record<keyof MixPhoneWorldSettings, unknown>>;
    return {
        plotContextTurns: num(r.plotContextTurns, MIX_PHONE_SETTINGS_DEFAULTS.plotContextTurns),
        includeState: bool(r.includeState, MIX_PHONE_SETTINGS_DEFAULTS.includeState),
        innerVoice: bool(r.innerVoice, MIX_PHONE_SETTINGS_DEFAULTS.innerVoice),
        msgHistoryCap: num(r.msgHistoryCap, MIX_PHONE_SETTINGS_DEFAULTS.msgHistoryCap),
        proactive: bool(r.proactive, MIX_PHONE_SETTINGS_DEFAULTS.proactive),
        proactiveCooldown: num(r.proactiveCooldown, MIX_PHONE_SETTINGS_DEFAULTS.proactiveCooldown),
        proactiveEveryRounds: num(r.proactiveEveryRounds, MIX_PHONE_SETTINGS_DEFAULTS.proactiveEveryRounds),
    };
}

/** 旧数据/脏数据归一：缺 settings 补默认，memberIds 保证是字符串数组 */
export function normalizeMixPhoneWorld(raw: unknown): MixPhoneWorld {
    const r = (raw ?? {}) as Partial<MixPhoneWorld> & Record<string, unknown>;
    return {
        id: typeof r.id === "string" ? r.id : "",
        name: typeof r.name === "string" && r.name.trim() ? r.name : undefined,
        createdAt: num(r.createdAt, Date.now()),
        updatedAt: num(r.updatedAt, Date.now()),
        sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
        memberIds: Array.isArray(r.memberIds)
            ? r.memberIds.filter((m): m is string => typeof m === "string")
            : [],
        personaId: typeof r.personaId === "string" ? r.personaId : undefined,
        settings: normalizeMixPhoneSettings(r.settings),
    };
}

/** 会话归一：kind 只认 direct/group，其余字段按形状收敛 */
export function normalizeMixChatThread(raw: unknown): MixChatThread {
    const r = (raw ?? {}) as Partial<MixChatThread> & Record<string, unknown>;
    return {
        id: typeof r.id === "string" ? r.id : "",
        worldId: typeof r.worldId === "string" ? r.worldId : "",
        kind: r.kind === "group" ? "group" : "direct",
        memberId: typeof r.memberId === "string" ? r.memberId : undefined,
        memberIds: Array.isArray(r.memberIds)
            ? r.memberIds.filter((m): m is string => typeof m === "string")
            : undefined,
        name: typeof r.name === "string" && r.name.trim() ? r.name : undefined,
        createdAt: num(r.createdAt, Date.now()),
        lastReadAt: typeof r.lastReadAt === "number" ? r.lastReadAt : undefined,
    };
}

/** 这一轮属于哪条频道：缺省 = scene（旧数据全是正文轮） */
export function mixTurnChannel(turn: Pick<MixTurn, "channel">): "scene" | "msg" {
    return turn.channel === "msg" ? "msg" : "scene";
}

/** 对局 msg 轮 → 聊天室统一消息形状 */
export function mixTurnToPhoneMessage(turn: MixTurn): MixPhoneMessage {
    return {
        id: turn.id,
        role: turn.role,
        speaker: turn.speaker,
        text: turn.text,
        createdAt: turn.createdAt,
        turnId: turn.id,
    };
}
