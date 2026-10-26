// lib/mixology/chatroom-storage.ts
// 独家特调 · 聊天室存储：世界 / 会话 / 独立世界消息，全部走 kv-db。
//
// 绑定世界的消息**不存这里**——它们是对局 turns 里的 msg 轮（单一事实源），
// loadThreadMessages 只是投影。本模块不 import storage.ts（避免环：
// deleteMixSession 的级联在 storage.ts 侧 import 本模块完成）。

import { kvGet, kvRemove, kvSet, registerKvMigration } from "../kv-db";
import { createMixId, type MixTurn } from "./types";
import {
    MIX_PHONE_SETTINGS_DEFAULTS,
    mixTurnChannel,
    mixTurnToPhoneMessage,
    normalizeMixChatThread,
    normalizeMixPhoneWorld,
    type MixChatThread,
    type MixPhoneMessage,
    type MixPhoneWorld,
} from "./chatroom-types";

const WORLDS_KEY = "mixology_phone_worlds_v1";
const THREADS_KEY = "mixology_phone_threads_v1";
const STANDALONE_MSGS_PREFIX = "mixology_phone_msgs:";

registerKvMigration(WORLDS_KEY);
registerKvMigration(THREADS_KEY);

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        return (JSON.parse(raw) ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
}

// ---------- 世界 ----------

export function loadMixPhoneWorlds(): MixPhoneWorld[] {
    const stored = readJson<unknown[]>(WORLDS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .map(normalizeMixPhoneWorld)
        .filter((w) => w.id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixPhoneWorld(id: string): MixPhoneWorld | null {
    return loadMixPhoneWorlds().find((w) => w.id === id) ?? null;
}

/** 一场对局至多一个绑定世界：按 sessionId 命中它 */
export function findMixPhoneWorldBySession(sessionId: string): MixPhoneWorld | null {
    return loadMixPhoneWorlds().find((w) => w.sessionId === sessionId) ?? null;
}

export function saveMixPhoneWorld(world: MixPhoneWorld): void {
    const list = loadMixPhoneWorlds().map((w) => ({ ...w }));
    const idx = list.findIndex((w) => w.id === world.id);
    const stamped = { ...world, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(WORLDS_KEY, list);
}

export function createMixPhoneWorld(input: {
    name?: string;
    sessionId?: string;
    memberIds: string[];
    personaId?: string;
}): MixPhoneWorld {
    const now = Date.now();
    const world: MixPhoneWorld = {
        id: createMixId("phone"),
        name: input.name?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        sessionId: input.sessionId,
        memberIds: [...input.memberIds],
        personaId: input.personaId,
        settings: { ...MIX_PHONE_SETTINGS_DEFAULTS },
    };
    saveMixPhoneWorld(world);
    return world;
}

/** 删世界：名下会话与独立消息键一并清理，不留孤儿 */
export function deleteMixPhoneWorld(id: string): void {
    for (const thread of loadMixChatThreads(id)) {
        deleteMixChatThread(thread.id);
    }
    writeJson(WORLDS_KEY, loadMixPhoneWorlds().filter((w) => w.id !== id));
}

/** 删对局的级联入口：清掉绑在这场对局名下的世界（连带会话/独立消息）。返回删掉的世界数 */
export function deletePhoneDataBySession(sessionId: string): number {
    const worlds = loadMixPhoneWorlds().filter((w) => w.sessionId === sessionId);
    for (const world of worlds) {
        deleteMixPhoneWorld(world.id);
    }
    return worlds.length;
}

// ---------- 会话（thread） ----------

export function loadMixChatThreads(worldId?: string): MixChatThread[] {
    const stored = readJson<unknown[]>(THREADS_KEY, []);
    const all = (Array.isArray(stored) ? stored : [])
        .map(normalizeMixChatThread)
        .filter((t) => t.id && t.worldId);
    const filtered = worldId ? all.filter((t) => t.worldId === worldId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export function getMixChatThread(id: string): MixChatThread | null {
    return loadMixChatThreads().find((t) => t.id === id) ?? null;
}

/** 私聊会话按 (worldId, memberId) 惰性查找：第一条消息之前列表项从成员推导，落库从这里开始 */
export function findDirectThread(worldId: string, memberId: string): MixChatThread | null {
    return (
        loadMixChatThreads(worldId).find((t) => t.kind === "direct" && t.memberId === memberId) ??
        null
    );
}

export function saveMixChatThread(thread: MixChatThread): void {
    const list = loadMixChatThreads().map((t) => ({ ...t }));
    const idx = list.findIndex((t) => t.id === thread.id);
    if (idx >= 0) list[idx] = thread;
    else list.push(thread);
    writeJson(THREADS_KEY, list);
}

export function createDirectThread(worldId: string, memberId: string): MixChatThread {
    const thread: MixChatThread = {
        id: createMixId("th"),
        worldId,
        kind: "direct",
        memberId,
        createdAt: Date.now(),
    };
    saveMixChatThread(thread);
    return thread;
}

export function createGroupThread(worldId: string, memberIds: string[], name: string): MixChatThread {
    const thread: MixChatThread = {
        id: createMixId("th"),
        worldId,
        kind: "group",
        memberIds: [...memberIds],
        name: name.trim() || "群聊",
        createdAt: Date.now(),
    };
    saveMixChatThread(thread);
    return thread;
}

/** 删会话（私聊/群聊）：独立消息键一并清；绑定世界已写回对局的 msg 轮保留（历史不改写） */
export function deleteMixChatThread(id: string): void {
    kvRemove(STANDALONE_MSGS_PREFIX + id);
    const list = loadMixChatThreads().filter((t) => t.id !== id);
    writeJson(THREADS_KEY, list);
}

// ---------- 消息 ----------

/** 独立世界的消息（绑定世界不走这里，见 loadThreadMessages） */
export function loadStandaloneThreadMessages(threadId: string): MixPhoneMessage[] {
    const stored = readJson<MixPhoneMessage[]>(STANDALONE_MSGS_PREFIX + threadId, []);
    return Array.isArray(stored)
        ? stored.filter((m) => m && typeof m.text === "string" && typeof m.id === "string")
        : [];
}

export function saveStandaloneThreadMessages(threadId: string, msgs: MixPhoneMessage[]): void {
    writeJson(STANDALONE_MSGS_PREFIX + threadId, msgs);
}

export function appendStandaloneThreadMessages(threadId: string, msgs: MixPhoneMessage[]): void {
    saveStandaloneThreadMessages(threadId, [...loadStandaloneThreadMessages(threadId), ...msgs]);
}

/**
 * 会话消息的统一读出口。
 * - 绑定世界：调用方传入对局 turns，按 threadId 投影 msg 轮（scene 轮与别家会话的轮不漏进来）；
 * - 独立世界：不传 turns，读独立键。
 */
export function loadThreadMessages(
    thread: MixChatThread | Pick<MixChatThread, "id">,
    sessionTurns?: MixTurn[],
): MixPhoneMessage[] {
    if (sessionTurns) {
        return sessionTurns
            .filter((t) => mixTurnChannel(t) === "msg" && t.threadId === thread.id)
            .map(mixTurnToPhoneMessage);
    }
    return loadStandaloneThreadMessages(thread.id);
}
