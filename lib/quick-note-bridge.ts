"use client";

// 宿主侧的「随想笔记」桥接层。
//
// 速记小窗与「随想笔记」自定义 APP 共用同一份 IndexedDB 集合：
// APP 数据落在 ai_phone_custom_app_data_v1:<runtimeAppId>/notes（见 custom-app-storage），
// 所以只要按 manifest.id 找到已安装 APP 的运行时 id，宿主就能直接读/写它的 notes 集合，
// 两边天然同步、无需另开桥接口。

import { loadInstalledCustomApps, readCustomAppCollection, writeCustomAppCollection } from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

export const QUICK_NOTES_MANIFEST_ID = "quick.notes";
export const QUICK_NOTES_COLLECTION = "notes";
export const QUICK_NOTES_ANALYSES_COLLECTION = "analyses";
/** 宿主写入后广播，供小窗/其它宿主界面刷新 */
export const QUICK_NOTES_UPDATED_EVENT = "quick-notes-updated";

export type QuickNoteStatus = "inbox" | "sorted" | "archived";

export type QuickNote = {
    id: string;
    title: string;
    text: string;
    category: string;
    tags: string[];
    status: QuickNoteStatus;
    source: "app" | "float";
    aiSummary: string;
    createdAt: string;
    updatedAt: string;
};

function uid(): string {
    return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStatus(value: unknown): QuickNoteStatus {
    return value === "sorted" || value === "archived" ? value : "inbox";
}

function normalize(raw: Record<string, unknown>): QuickNote {
    const createdAt = String(raw.createdAt || new Date().toISOString());
    return {
        id: String(raw.id || uid()),
        title: String(raw.title || ""),
        text: String(raw.text || ""),
        category: String(raw.category || ""),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 20) : [],
        status: normalizeStatus(raw.status),
        source: raw.source === "float" ? "float" : "app",
        aiSummary: String(raw.aiSummary || ""),
        createdAt,
        updatedAt: String(raw.updatedAt || createdAt),
    };
}

/** 找已安装的「随想笔记」APP（按 manifest.id，运行时 id 每次安装都会变） */
export function findQuickNotesApp(): InstalledCustomApp | null {
    try {
        const apps = loadInstalledCustomApps();
        return apps.find(app => app.manifest?.id === QUICK_NOTES_MANIFEST_ID) || null;
    } catch {
        return null;
    }
}

export function isQuickNotesInstalled(): boolean {
    return !!findQuickNotesApp();
}

/** 读全部笔记（与 APP 同源） */
export function loadHostQuickNotes(): QuickNote[] {
    const app = findQuickNotesApp();
    if (!app) return [];
    try {
        return readCustomAppCollection(app.id, QUICK_NOTES_COLLECTION).map(normalize);
    } catch {
        return [];
    }
}

export type NewQuickNote = {
    title?: string;
    text: string;
    category?: string;
    tags?: string[];
    status?: QuickNoteStatus;
    aiSummary?: string;
};

/** 追加一条速记；返回新笔记，未安装 APP 时返回 null */
export function addHostQuickNote(input: NewQuickNote): QuickNote | null {
    const app = findQuickNotesApp();
    if (!app) return null;
    const text = String(input.text || "").replace(/\u0000/g, "").slice(0, 20000);
    const now = new Date().toISOString();
    const note: QuickNote = {
        id: uid(),
        title: String(input.title || "").trim().slice(0, 120),
        text,
        category: String(input.category || "").trim().slice(0, 40),
        tags: Array.isArray(input.tags) ? input.tags.map(String).map(t => t.trim()).filter(Boolean).slice(0, 20) : [],
        status: normalizeStatus(input.status),
        source: "float",
        aiSummary: String(input.aiSummary || "").trim().slice(0, 400),
        createdAt: now,
        updatedAt: now,
    };
    try {
        const rows = readCustomAppCollection(app.id, QUICK_NOTES_COLLECTION);
        rows.push(note as unknown as Record<string, unknown>);
        writeCustomAppCollection(app.id, QUICK_NOTES_COLLECTION, rows);
    } catch {
        return null;
    }
    emitQuickNotesUpdated();
    return note;
}

export function emitQuickNotesUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(QUICK_NOTES_UPDATED_EVENT));
}

export type NewQuickAnalysis = {
    title: string;
    text: string;
    characterId?: string;
    characterName?: string;
    mode?: string;
    noteIds?: string[];
    noteTitles?: string[];
};

/** 追加一条分析记录（与 APP 的「分析」页同源）；未安装 APP 时返回 false */
export function appendHostAnalysis(input: NewQuickAnalysis): boolean {
    const app = findQuickNotesApp();
    if (!app) return false;
    const now = new Date().toISOString();
    const rec = {
        id: `ana_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title: String(input.title || "分析").slice(0, 200),
        text: String(input.text || "").slice(0, 40000),
        characterId: String(input.characterId || ""),
        characterName: String(input.characterName || "AI"),
        mode: String(input.mode || "character"),
        noteIds: Array.isArray(input.noteIds) ? input.noteIds.map(String) : [],
        noteTitles: Array.isArray(input.noteTitles) ? input.noteTitles.map(String) : [],
        sentToChat: false,
        createdAt: now,
    };
    try {
        const rows = readCustomAppCollection(app.id, QUICK_NOTES_ANALYSES_COLLECTION);
        rows.push(rec);
        writeCustomAppCollection(app.id, QUICK_NOTES_ANALYSES_COLLECTION, rows);
    } catch {
        return false;
    }
    emitQuickNotesUpdated();
    return true;
}

/** 打开「随想笔记」APP（借宿主的 open-app 事件） */
export function openQuickNotesApp(): boolean {
    const app = findQuickNotesApp();
    if (!app) return false;
    if (typeof window === "undefined") return false;
    try {
        window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: `custom_app:${app.id}` } }));
        return true;
    } catch {
        return false;
    }
}

/** 从已有笔记里汇总出分类清单（给小窗的候选分类用） */
export function collectQuickNoteCategories(): string[] {
    const set = new Set<string>();
    for (const note of loadHostQuickNotes()) {
        if (note.category) set.add(note.category);
    }
    return Array.from(set).slice(0, 30);
}
