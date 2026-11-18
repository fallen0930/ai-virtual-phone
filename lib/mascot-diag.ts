// lib/mascot-diag.ts
// 卷宝诊断日志（临时排查用）：一次提问 = 一个 task，每次模型调用 = 一个 round。
// 只记录「为什么断/为什么只思考/为什么界面没画出来」需要的事实：
// 请求参数、流的时间线、finishReason/usage、输出首尾、循环判定、界面绘制统计。
//
// 刻意独立于：
//   - lib/api-log-store.ts  现成的环只截 8000 字，且没有 finishReason/断流标记
//   - lib/data-management   不注册模块 → 不进云端备份、不跟账号走
// 数据只在本机 IndexedDB（AiPhoneMascotDiagDB），导出时统一脱敏。

import {
    buildMascotDiagVerdict,
    extractDiagFinishReason,
    extractDiagUsage,
    mergeDiagUsage,
    type MascotDiagRoundLike,
    type MascotDiagUsage,
    type MascotDiagVerdict,
} from "./mascot-diag-verdict";
import type { LlmStreamDiagEvent } from "./llm-stream-diag-types";

/** 记录结构改了就 +1，导出里带着它，回看旧包时才知道字段含义 */
export const MASCOT_DIAG_BUILD = "diag-1";

const DB_NAME = "AiPhoneMascotDiagDB";
const DB_VERSION = 1;
const STORE = "tasks";
const ENABLED_KEY = "ai_phone_mascot_diag_enabled";
const FULL_CAPTURE_KEY = "ai_phone_mascot_diag_full_capture";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 保留 7 天：够覆盖「这几天老是断」的排查窗口，又不至于把手机塞满 */
export const MASCOT_DIAG_RETENTION_DAYS = 7;
/** 最多留 200 次提问；超过就丢最旧的 */
export const MASCOT_DIAG_MAX_TASKS = 200;

// 单轮文本留多少。诊断「截断」要看头（说到哪）和尾（断在什么字上），
// 中间正文对归因没有额外价值，省体积也避免把整段隐私留在手机里。
const CONTENT_HEAD_CHARS = 400;
const CONTENT_TAIL_CHARS = 400;
const REASONING_HEAD_CHARS = 300;
const REASONING_TAIL_CHARS = 300;
const RAW_TAIL_CHARS = 1200;
const USER_TEXT_HEAD_CHARS = 300;
const USER_TEXT_TAIL_CHARS = 200;
/** 「下一次完整记录」时正文上限，够看清一次长输出的全貌 */
const FULL_CONTENT_CHARS = 4000;

export type MascotDiagTextPreview = {
    chars: number;
    head: string;
    tail?: string;
};

export type MascotDiagTaskInput = {
    protocol: "native" | "text";
    providerKind?: string;
    model?: string;
    baseUrl?: string;
    maxTokens?: number | null;
    maxRounds?: number;
    streaming?: boolean;
    historyMessages?: number;
    historyChars?: number;
    imageCount?: number;
    contextUsage?: number;
    userText?: string;
};

export type MascotDiagTaskConfig = {
    protocol: "native" | "text";
    providerKind?: string;
    model?: string;
    /** 只留域名，路径与查询串都不留（查询串里常有 key） */
    host?: string;
    path?: string;
    maxTokens?: number | null;
    maxRounds?: number;
    streaming: boolean;
};

export type MascotDiagToolCallRecord = {
    name: string;
    id?: string;
    /** 只记参数规模，不存参数原文（可能含用户隐私/长文本） */
    argChars: number;
    argKeys?: string[];
};

export type MascotDiagRoundStream = {
    sawHeaders: boolean;
    status?: number;
    requestId?: string;
    chunks: number;
    /** 从发请求到第一个 chunk 的毫秒数 */
    firstChunkMs?: number;
    /** 相邻 chunk 的最大间隔，用来区分「模型慢」和「中转卡死」 */
    maxChunkGapMs?: number;
    finishReason?: string;
    sawDone: boolean;
    endedNormally: boolean;
    contentChars: number;
    reasoningChars: number;
    rawTail?: string;
    usage?: MascotDiagUsage;
    aborted?: "user" | "timeout" | "external";
    error?: string;
};

export type MascotDiagRoundOutput = {
    contentChars: number;
    reasoningChars: number;
    toolCalls: MascotDiagToolCallRecord[];
    toolFetches?: number;
    truncatedToolNames?: string[];
    textTruncated?: boolean;
    parseErrors?: number;
    contentHead?: string;
    contentTail?: string;
    reasoningHead?: string;
    reasoningTail?: string;
    /** 完整记录模式下才有的全量正文 */
    contentFull?: string;
};

export type MascotDiagRoundUi = {
    engineChars: number;
    paintedChars: number;
    maxPaintGapMs: number;
    maxRafWaitMs?: number;
    hiddenDuringStream: boolean;
};

/**
 * 一轮的两种时长：墙上时间（Date.now 差）与单调时间（performance.now 差）。
 * 手机息屏 / 切后台会把 JS 冻住，墙上时间照走 —— 只看墙上时间就会把「页面被挂起」
 * 记成「模型想了 52 分钟」（她 2026-11-03 那次实测正是这个形状：wallMs 3151895、monoMs 9200）。
 * 所以每一轮都要留这一组数，**包括一个字都没吐的工具轮**（UI 统计只在有可见文字时才记，
 * 那些轮恰恰最需要这条证据）。
 */
export type MascotDiagRoundTiming = {
    wallMs: number;
    monoMs: number;
    /** 前台真正等待（= 两者取小） */
    foregroundMs: number;
    /** 判为挂起的那一段 */
    suspendedMs: number;
};

export type MascotDiagRoundRecord = {
    index: number;
    startedAt: number;
    endedAt?: number;
    stream: MascotDiagRoundStream;
    output: MascotDiagRoundOutput;
    ui?: MascotDiagRoundUi;
    timing?: MascotDiagRoundTiming;
    loop?: { decision?: string; at?: number };
    fallback?: { used: boolean; attemptError?: string };
};

export type MascotDiagTaskEnd = {
    reason?: string;
    rounds?: number;
    actions?: { name: string; success: boolean }[];
    digestReason?: string;
    error?: string;
};

export type MascotDiagTaskRecord = {
    id: string;
    build: string;
    createdAt: number;
    updatedAt: number;
    config: MascotDiagTaskConfig;
    context: {
        historyMessages: number;
        historyChars: number;
        imageCount: number;
        contextUsage: number;
    };
    userText?: MascotDiagTextPreview;
    /** 本次提问是否处于「完整记录」模式 */
    fullCapture?: boolean;
    roundCount: number;
    end?: MascotDiagTaskEnd;
};

export type StoredMascotDiagTask = {
    task: MascotDiagTaskRecord;
    rounds: MascotDiagRoundRecord[];
};

export type MascotDiagTaskView = StoredMascotDiagTask & {
    verdicts: MascotDiagVerdict[];
    /** 整次提问的结论：取最严重的那个非 normal 轮 */
    taskVerdict: MascotDiagVerdict;
};

export type MascotDiagRoundRecorder = {
    readonly index: number;
    ingest: (event: LlmStreamDiagEvent) => void;
    markOutput: (output: {
        content?: string;
        reasoning?: string;
        toolCalls?: { name?: string; id?: string; args?: unknown }[];
        toolFetches?: number;
        truncatedToolNames?: string[];
        textTruncated?: boolean;
        parseErrors?: number;
        finishReason?: string;
        sawDone?: boolean;
        endedNormally?: boolean;
    }) => void;
    markParseError: () => void;
    markUi: (ui: MascotDiagRoundUi) => void;
    markTiming: (timing: MascotDiagRoundTiming) => void;
    markLoop: (decision: string) => void;
    markFallback: (reason: string) => void;
    markAbort: (kind: "user" | "timeout" | "external") => void;
    markError: (message: string) => void;
    save: () => Promise<void>;
};

export type MascotDiagTaskHandle = {
    readonly id: string;
    startRound: (index?: number) => MascotDiagRoundRecorder;
    finish: (end: MascotDiagTaskEnd) => Promise<void>;
};

// ── 开关 ─────────────────────────────────────────────

function readFlag(key: string): string | null {
    try {
        return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

function writeFlag(key: string, value: string | null): void {
    try {
        if (typeof localStorage === "undefined") return;
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // ignore
    }
}

/**
 * 默认开启：这个功能的用途就是「日常用着用着才复现」，等想起来再打开就抓不到了。
 * 关闭写 "0" 而不是删键，避免与「还没设置过」混为一谈。
 */
export function isMascotDiagEnabled(): boolean {
    return readFlag(ENABLED_KEY) !== "0";
}

export function setMascotDiagEnabled(enabled: boolean): void {
    writeFlag(ENABLED_KEY, enabled ? "1" : "0");
}

/**
 * 让接下来的 N 次提问记录完整正文（默认 3 次）。
 * 「头尾各 400 字」平时够用，但遇到「说得好好的突然没了」想通读一遍时，
 * 打开这个开关再复现一次，就能拿到完整全文。
 */
export function requestMascotDiagFullCapture(count = 3): number {
    const next = Math.max(0, Math.floor(count));
    writeFlag(FULL_CAPTURE_KEY, next > 0 ? String(next) : null);
    return next;
}

export function getMascotDiagFullCaptureRemaining(): number {
    const raw = Number(readFlag(FULL_CAPTURE_KEY));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function consumeFullCapture(): boolean {
    const remaining = getMascotDiagFullCaptureRemaining();
    if (remaining <= 0) return false;
    writeFlag(FULL_CAPTURE_KEY, remaining > 1 ? String(remaining - 1) : null);
    return true;
}

// ── IndexedDB ────────────────────────────────────────

function hasIndexedDb(): boolean {
    return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: "task.id" });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error ?? new Error("诊断日志数据库打开失败"));
            request.onblocked = () => reject(new Error("诊断日志数据库被其他页面占用"));
        }).catch((error) => {
            dbPromise = null;
            throw error;
        });
    }
    return dbPromise;
}

const TASKS = new Map<string, StoredMascotDiagTask>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function ensureHydrated(): Promise<void> {
    if (hydrated) return Promise.resolve();
    if (!hydratePromise) {
        hydratePromise = (async () => {
            if (hasIndexedDb()) {
                try {
                    const db = await getDb();
                    const loaded = await new Promise<StoredMascotDiagTask[]>((resolve, reject) => {
                        const tx = db.transaction(STORE, "readonly");
                        const request = tx.objectStore(STORE).getAll();
                        request.onsuccess = () => resolve((request.result || []) as StoredMascotDiagTask[]);
                        request.onerror = () => reject(request.error);
                    });
                    for (const record of loaded) {
                        const id = record?.task?.id;
                        if (!id) continue;
                        const existing = TASKS.get(id);
                        // 内存里可能是刚写的新版本（先于 hydration 产生），按 updatedAt 取新
                        if (!existing || (record.task.updatedAt ?? 0) > (existing.task.updatedAt ?? 0)) {
                            TASKS.set(id, record);
                        }
                    }
                } catch {
                    // 数据库不可用也保持可用：本次会话退化成纯内存
                }
            }
            hydrated = true;
        })().finally(() => {
            hydratePromise = null;
        });
    }
    return hydratePromise;
}

async function persistRecord(record: StoredMascotDiagTask): Promise<void> {
    if (!hasIndexedDb()) return;
    try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch {
        // 日志落盘失败绝不能影响聊天主流程
    }
}

async function deleteRecords(ids: string[]): Promise<void> {
    if (ids.length === 0 || !hasIndexedDb()) return;
    try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            for (const id of ids) store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch {
        // ignore
    }
}

// ── 文本裁剪与脱敏 ───────────────────────────────────

function preview(text: string | undefined, headChars: number, tailChars?: number): MascotDiagTextPreview | undefined {
    if (!text) return undefined;
    if (text.length <= headChars) return { chars: text.length, head: text };
    const head = text.slice(0, headChars);
    if (!tailChars) return { chars: text.length, head };
    return { chars: text.length, head, tail: text.slice(-tailChars) };
}

function countChars(text: string | undefined): number {
    return text ? text.length : 0;
}

function describeUrl(baseUrl: string | undefined): { host?: string; path?: string } {
    if (!baseUrl) return {};
    try {
        const url = new URL(baseUrl);
        return { host: url.host, path: url.pathname };
    } catch {
        // 不是完整 URL（中转里有人只填域名）——只留去掉查询串的裸文本
        return { host: baseUrl.split(/[?#]/)[0].slice(0, 120) };
    }
}

const SECRET_KEY_PATTERN = /(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|authorization|cookie|signature)/i;

/**
 * 导出脱敏。注意顺序：Bearer 必须先于通用的 authorization/token 规则，
 * 否则通用规则会把 "Bearer" 当成值吃掉，真 token 反而留在后面。
 */
export function redactDiagText(value: string): string {
    let out = value;
    out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-****");
    out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ****");
    out = out.replace(
        /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization)\b(\s*[:=：]\s*)([^\s,;"'，。；）)]+)/gi,
        "$1$2****",
    );
    out = out.replace(/([?&](?:key|api_key|apikey|token|access_token|secret)=)[^&\s"']+/gi, "$1****");
    out = out.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s"']*@/g, "https://");
    out = out.replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image]");
    return out;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
    if (depth > 12) return "[depth-limit]";
    if (typeof value === "string") return redactDiagText(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            if (SECRET_KEY_PATTERN.test(key) && typeof val === "string") {
                out[key] = "****";
                continue;
            }
            out[key] = sanitizeValue(val, depth + 1);
        }
        return out;
    }
    return value;
}

// ── 记录器 ───────────────────────────────────────────

function describeToolCalls(calls: { name?: string; id?: string; args?: unknown }[] | undefined): MascotDiagToolCallRecord[] {
    if (!calls?.length) return [];
    return calls.map((call) => {
        const args = call.args;
        const argKeys = args && typeof args === "object" && !Array.isArray(args)
            ? Object.keys(args as Record<string, unknown>).slice(0, 20)
            : undefined;
        let argChars = 0;
        try {
            argChars = args === undefined ? 0 : JSON.stringify(args).length;
        } catch {
            argChars = -1;
        }
        return {
            name: call.name || "未命名动作",
            id: call.id,
            argChars,
            argKeys,
        };
    });
}

function createRoundRecorder(
    record: StoredMascotDiagTask,
    taskHandlePersist: () => Promise<void>,
    index: number,
    fullCapture: boolean,
): MascotDiagRoundRecorder {
    const round: MascotDiagRoundRecord = {
        index,
        startedAt: Date.now(),
        stream: {
            sawHeaders: false,
            chunks: 0,
            sawDone: false,
            endedNormally: false,
            contentChars: 0,
            reasoningChars: 0,
        },
        output: {
            contentChars: 0,
            reasoningChars: 0,
            toolCalls: [],
        },
    };
    record.rounds.push(round);
    record.task.roundCount = record.rounds.length;
    record.task.updatedAt = Date.now();

    let lastChunkAt: number | undefined;
    const touch = () => {
        record.task.updatedAt = Date.now();
        round.endedAt = Date.now();
    };
    const persistSoon = () => {
        touch();
        void taskHandlePersist();
    };

    return {
        index,
        ingest(event) {
            touch();
            const stream = round.stream;
            if (event.type === "headers") {
                stream.sawHeaders = true;
                stream.status = event.status;
                stream.requestId = event.requestId;
                return;
            }
            if (event.type === "chunk") {
                stream.chunks += 1;
                if (stream.firstChunkMs === undefined) {
                    stream.firstChunkMs = Math.max(0, event.at - round.startedAt);
                } else if (lastChunkAt !== undefined) {
                    const gap = event.at - lastChunkAt;
                    if (gap > (stream.maxChunkGapMs ?? 0)) stream.maxChunkGapMs = gap;
                }
                lastChunkAt = event.at;
                stream.contentChars = Math.max(stream.contentChars, event.contentChars || 0);
                stream.reasoningChars = Math.max(stream.reasoningChars, event.reasoningChars || 0);
                stream.sawDone = stream.sawDone || event.sawDone;
                const finishReason = extractDiagFinishReason(event.data);
                if (finishReason) stream.finishReason = finishReason;
                const usage = extractDiagUsage(event.data);
                if (usage) stream.usage = mergeDiagUsage(stream.usage, usage);
                if (event.rawTail) stream.rawTail = event.rawTail.slice(-RAW_TAIL_CHARS);
                return;
            }
            if (event.type === "end") {
                stream.sawDone = stream.sawDone || event.sawDone;
                stream.contentChars = Math.max(stream.contentChars, event.contentChars || 0);
                stream.reasoningChars = Math.max(stream.reasoningChars, event.reasoningChars || 0);
                // 「正常收尾」= 拿到了模型/协议的终态信号（[DONE] 或 finishReason）。
                // 仅仅 fetch 流结束不算：中转掐断时 body 也会 normal 地结束。
                stream.endedNormally = !!(stream.sawDone || stream.finishReason);
                if (event.rawTail) stream.rawTail = event.rawTail.slice(-RAW_TAIL_CHARS);
                persistSoon();
                return;
            }
            // error
            stream.contentChars = Math.max(stream.contentChars, event.contentChars || 0);
            stream.reasoningChars = Math.max(stream.reasoningChars, event.reasoningChars || 0);
            stream.error = event.message;
            if (event.timedOut) stream.aborted = "timeout";
            // 这里的「外部信号中止」只来自用户按停止（超时已单独标出）
            else if (event.aborted) stream.aborted = "user";
            if (event.rawTail) stream.rawTail = event.rawTail.slice(-RAW_TAIL_CHARS);
            persistSoon();
        },
        markOutput(output) {
            const content = output.content ?? "";
            const reasoning = output.reasoning ?? "";
            round.output.contentChars = Math.max(round.output.contentChars, countChars(content));
            round.output.reasoningChars = Math.max(round.output.reasoningChars, countChars(reasoning));
            round.output.toolCalls = describeToolCalls(output.toolCalls);
            if (output.toolFetches !== undefined) round.output.toolFetches = output.toolFetches;
            if (output.truncatedToolNames?.length) round.output.truncatedToolNames = output.truncatedToolNames;
            if (output.textTruncated) round.output.textTruncated = true;
            if (output.parseErrors !== undefined) round.output.parseErrors = output.parseErrors;
            if (output.finishReason) round.stream.finishReason = output.finishReason;
            if (output.sawDone !== undefined) round.stream.sawDone = round.stream.sawDone || output.sawDone;
            if (output.endedNormally !== undefined) {
                round.stream.endedNormally = round.stream.endedNormally || output.endedNormally;
            }
            if (fullCapture) {
                round.output.contentFull = content.slice(0, FULL_CONTENT_CHARS);
                if (reasoning) round.output.reasoningHead = reasoning.slice(0, CONTENT_HEAD_CHARS);
                round.output.contentHead = content.slice(0, CONTENT_HEAD_CHARS);
            } else {
                const contentPreview = preview(content, CONTENT_HEAD_CHARS, CONTENT_TAIL_CHARS);
                if (contentPreview) {
                    round.output.contentHead = contentPreview.head;
                    round.output.contentTail = contentPreview.tail;
                }
                const reasoningPreview = preview(reasoning, REASONING_HEAD_CHARS, REASONING_TAIL_CHARS);
                if (reasoningPreview) {
                    round.output.reasoningHead = reasoningPreview.head;
                    round.output.reasoningTail = reasoningPreview.tail;
                }
            }
            // 引擎自己的计数更新（流式时 UI 层拿到的字符数）
            round.stream.contentChars = Math.max(round.stream.contentChars, round.output.contentChars);
            round.stream.reasoningChars = Math.max(round.stream.reasoningChars, round.output.reasoningChars);
            persistSoon();
        },
        markParseError() {
            round.output.parseErrors = (round.output.parseErrors ?? 0) + 1;
            touch();
        },
        markUi(ui) {
            round.ui = { ...ui };
            // 只有「页面在后台」需要立刻落盘：随后的补画可能被挂起的 rAF 挡住。
            // 前台这版不写，交给紧随其后的 markLoop / markOutput 一起落，省 IndexedDB 写放大。
            if (ui.hiddenDuringStream) persistSoon();
            else touch();
        },
        markTiming(timing) {
            // 每轮都记，含一个字都没吐的工具轮 —— UI 统计只在有可见文字时才有，
            // 而那类轮次恰恰是她问「一直提示在思考，是不是真在调用」时唯一能看清的东西。
            round.timing = { ...timing };
            if (timing.suspendedMs > 0) persistSoon();
            else touch();
        },
        markLoop(decision) {
            round.loop = { decision, at: Date.now() };
            persistSoon();
        },
        markFallback(reason) {
            round.fallback = { used: true, attemptError: reason.slice(0, 500) };
            touch();
        },
        markAbort(kind) {
            round.stream.aborted = kind;
            persistSoon();
        },
        markError(message) {
            round.stream.error = message.slice(0, 800);
            persistSoon();
        },
        save: taskHandlePersist,
    };
}

// ── 对外：开始一次提问 ───────────────────────────────

function makeTaskId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function beginMascotDiagTask(input: MascotDiagTaskInput): MascotDiagTaskHandle | null {
    if (!isMascotDiagEnabled()) return null;

    void ensureHydrated();
    const now = Date.now();
    const fullCapture = consumeFullCapture();
    const { host, path } = describeUrl(input.baseUrl);
    const record: StoredMascotDiagTask = {
        task: {
            id: makeTaskId(),
            build: MASCOT_DIAG_BUILD,
            createdAt: now,
            updatedAt: now,
            config: {
                protocol: input.protocol,
                providerKind: input.providerKind,
                model: input.model,
                host,
                path,
                maxTokens: input.maxTokens,
                maxRounds: input.maxRounds,
                streaming: input.streaming !== false,
            },
            context: {
                historyMessages: input.historyMessages ?? 0,
                historyChars: input.historyChars ?? 0,
                imageCount: input.imageCount ?? 0,
                contextUsage: input.contextUsage ?? 0,
            },
            userText: preview(input.userText, USER_TEXT_HEAD_CHARS, USER_TEXT_TAIL_CHARS),
            fullCapture,
            roundCount: 0,
        },
        rounds: [],
    };
    TASKS.set(record.task.id, record);

    const persist = () => persistRecord(record);
    void persist();

    // 顺手裁剪：写新任务时清掉超期/超量的旧任务，避免只在打开面板时才回收
    void pruneMascotDiag();

    let roundIndex = 0;
    return {
        id: record.task.id,
        startRound(index) {
            const nextIndex = index ?? (roundIndex + 1);
            roundIndex = Math.max(roundIndex, nextIndex);
            return createRoundRecorder(record, persist, nextIndex, fullCapture);
        },
        async finish(end) {
            // 没有显式 end 的轮次补一个收尾时间，方便算总耗时
            const finishedAt = Date.now();
            for (const round of record.rounds) {
                if (!round.endedAt) round.endedAt = finishedAt;
            }
            record.task.end = {
                reason: end.reason,
                rounds: end.rounds ?? record.rounds.length,
                actions: end.actions?.slice(0, 30),
                digestReason: end.digestReason,
                error: end.error ? end.error.slice(0, 800) : undefined,
            };
            record.task.updatedAt = finishedAt;
            record.task.roundCount = record.rounds.length;
            await persist();
        },
    };
}

// ── 结论与视图 ───────────────────────────────────────

function roundChars(round: MascotDiagRoundRecord): { contentChars: number; reasoningChars: number } {
    return {
        contentChars: Math.max(round.output.contentChars, round.stream.contentChars),
        reasoningChars: Math.max(round.output.reasoningChars, round.stream.reasoningChars),
    };
}

export function buildVerdictForRound(
    round: MascotDiagRoundRecord,
    config: MascotDiagTaskConfig,
): MascotDiagVerdict {
    const chars = roundChars(round);
    const like: MascotDiagRoundLike = {
        protocol: config.protocol,
        finishReason: round.stream.finishReason,
        sawDone: round.stream.sawDone,
        endedNormally: round.stream.endedNormally,
        aborted: round.stream.aborted,
        error: round.stream.error,
        contentChars: chars.contentChars,
        reasoningChars: chars.reasoningChars,
        toolCallCount: round.output.toolCalls.length,
        toolFetchCount: round.output.toolFetches ?? 0,
        truncatedToolNames: round.output.truncatedToolNames,
        textTruncated: round.output.textTruncated,
        parseErrors: round.output.parseErrors,
        engineChars: round.ui?.engineChars,
        paintedChars: round.ui?.paintedChars,
        maxPaintGapMs: round.ui?.maxPaintGapMs,
        hiddenDuringStream: round.ui?.hiddenDuringStream,
        timing: round.timing,
        usage: round.stream.usage,
        maxTokens: config.maxTokens,
        fallbackUsed: round.fallback?.used,
        attemptError: round.fallback?.attemptError,
        loopDecision: round.loop?.decision,
    };
    return buildMascotDiagVerdict(like);
}

const VERDICT_PRIORITY: Record<string, number> = {
    error: 8,
    timeout: 8,
    stream_cut: 7,
    truncated_length: 7,
    truncated_actions: 6,
    text_parse_error: 6,
    ui_stall: 5,
    thinking_only: 4,
    empty_response: 4,
    /** 挂起不是缺陷，只是解释「为什么这轮看着等了很久」；压过 normal/aborted 让它当标题 */
    suspended: 2,
    unknown: 2,
    aborted: 1,
    normal: 0,
};

function mergeTaskVerdict(verdicts: MascotDiagVerdict[]): MascotDiagVerdict {
    if (verdicts.length === 0) return { code: "normal", label: "正常", detail: "这次提问没有记录到模型调用。" };
    return verdicts.reduce((worst, item) => (
        (VERDICT_PRIORITY[item.code] ?? 0) > (VERDICT_PRIORITY[worst.code] ?? 0) ? item : worst
    ), verdicts[0]);
}

function toView(record: StoredMascotDiagTask): MascotDiagTaskView {
    const verdicts = record.rounds.map((round) => buildVerdictForRound(round, record.task.config));
    return { ...record, verdicts, taskVerdict: mergeTaskVerdict(verdicts) };
}

function sortedRecords(): StoredMascotDiagTask[] {
    return [...TASKS.values()].sort((a, b) => b.task.createdAt - a.task.createdAt);
}

export async function listMascotDiagTasks(limit = MASCOT_DIAG_MAX_TASKS): Promise<MascotDiagTaskView[]> {
    await ensureHydrated();
    return sortedRecords().slice(0, limit).map(toView);
}

export async function getMascotDiagTask(id: string): Promise<MascotDiagTaskView | null> {
    await ensureHydrated();
    const record = TASKS.get(id);
    return record ? toView(record) : null;
}

export async function deleteMascotDiagTask(id: string): Promise<void> {
    await ensureHydrated();
    TASKS.delete(id);
    await deleteRecords([id]);
}

export type MascotDiagSummary = {
    enabled: boolean;
    tasks: number;
    rounds: number;
    oldestAt?: number;
    newestAt?: number;
    /** 异常轮次数量（结论不是 normal 的） */
    abnormalRounds: number;
};

export async function getMascotDiagSummary(): Promise<MascotDiagSummary> {
    await ensureHydrated();
    const records = sortedRecords();
    let rounds = 0;
    let abnormalRounds = 0;
    for (const record of records) {
        rounds += record.rounds.length;
        for (const round of record.rounds) {
            if (buildVerdictForRound(round, record.task.config).code !== "normal") abnormalRounds += 1;
        }
    }
    return {
        enabled: isMascotDiagEnabled(),
        tasks: records.length,
        rounds,
        oldestAt: records.length > 0 ? records[records.length - 1].task.createdAt : undefined,
        newestAt: records.length > 0 ? records[0].task.createdAt : undefined,
        abnormalRounds,
    };
}

// ── 导出 / 清理 ─────────────────────────────────────

export type MascotDiagExport = {
    json: string;
    filename: string;
    taskCount: number;
    roundCount: number;
    blob: Blob | null;
};

function formatStamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export async function exportMascotDiag(options: { days?: number } = {}): Promise<MascotDiagExport> {
    await ensureHydrated();
    const days = options.days ?? MASCOT_DIAG_RETENTION_DAYS;
    const since = Date.now() - Math.max(1, days) * DAY_MS;
    const records = sortedRecords().filter((record) => record.task.createdAt >= since);
    const views = records.map(toView);

    const payload = {
        build: MASCOT_DIAG_BUILD,
        exportedAt: new Date().toISOString(),
        days,
        note: "卷宝诊断日志：每次提问一个 task，每次模型调用一个 round。已自动去掉 URL 查询串、key/token 等凭据片段；正文只保留首尾。",
        taskCount: views.length,
        roundCount: views.reduce((sum, item) => sum + item.rounds.length, 0),
        tasks: views,
    };

    const json = JSON.stringify(sanitizeValue(payload), null, 2);
    let blob: Blob | null = null;
    try {
        blob = new Blob([json], { type: "application/json" });
    } catch {
        blob = null;
    }
    return {
        json,
        filename: `mascot-diag-${formatStamp(new Date())}.json`,
        taskCount: payload.taskCount,
        roundCount: payload.roundCount,
        blob,
    };
}

/** 清理超期/超量任务；now 可注入，便于测试 */
export async function pruneMascotDiag(now = Date.now()): Promise<number> {
    await ensureHydrated();
    const cutoff = now - MASCOT_DIAG_RETENTION_DAYS * DAY_MS;
    const sorted = sortedRecords();
    const removeIds: string[] = [];
    sorted.forEach((record, index) => {
        if (record.task.createdAt < cutoff || index >= MASCOT_DIAG_MAX_TASKS) {
            removeIds.push(record.task.id);
        }
    });
    if (removeIds.length === 0) return 0;
    for (const id of removeIds) TASKS.delete(id);
    await deleteRecords(removeIds);
    return removeIds.length;
}

export async function clearMascotDiag(): Promise<void> {
    TASKS.clear();
    hydrated = true;
    if (!hasIndexedDb()) return;
    try {
        const db = await getDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch {
        // ignore
    }
}
