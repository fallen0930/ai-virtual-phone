import { getMascotContext, type MascotPageContext } from "./mascot-context";
import { mascotFillField } from "./mascot-events";
import {
    mascotChatWithTools,
    type MascotMsg,
} from "./mascot-engine";
import { PAGE_GREETINGS } from "./mascot-prompts";
import {
    autoExpandMixologyPackage,
    clearExpandedPackages,
    executeMascotToolCall,
    findPackageByLabel,
    getMascotNativeLoaderName,
    loadExpandedPackages,
    saveExpandedPackages,
    touchExpandedPackage,
    type MascotToolContext,
} from "./mascot-tools";
import { isMascotPanelOpen } from "./mascot-state";
import {
    markWaitStart,
    nowMono,
    rollingPaceMs,
    splitWaitGap,
    type MascotWaitStart,
} from "./mascot-waiting-pace";
import { buildMascotSessionSummary } from "./mascot-conversation-utils";
import { getMascotMaxOutputTokens, getMascotMaxRounds } from "./mascot-prefs";
import {
    MASCOT_AUTO_CONTINUE_PROMPT,
    MASCOT_AUTO_CONTINUE_VISIBLE_HINT,
    MASCOT_MAX_AUTO_CONTINUES,
    MASCOT_MAX_NUDGES,
    MASCOT_MAX_STALL_RETRIES,
    MASCOT_ROUNDS_EXHAUSTED_NOTICE,
    MASCOT_STALL_RETRY_VISIBLE_HINT,
    MASCOT_TRUNCATED_EXHAUSTED_NOTICE,
    buildMascotNudgePrompt,
    buildMascotProgressDigest,
    extractMascotActionDetail,
    isMascotStallError,
    looksLikeWrapUp,
    type MascotExecutedAction,
    type MascotProgressDigestReason,
} from "./mascot-agent-policy";
import { resetMascotTaskLedger, summarizeTaskLedger } from "./mascot-task-ledger";
import { resetMixCraftSpecBoard } from "./mixology/spec-board";
import { resetMixMaterialBoard } from "./mixology/material-board";
import { accountIdForConfig, beginTaskBilling, cancelTaskBilling, endTaskBilling, isTaskBillingActive, isTaskBillingEnabled, settleTaskBilling } from "./api-accounts";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { beginMascotDiagTask, type MascotDiagRoundRecorder } from "./mascot-diag";
import { nativeToolProtocolForConfig } from "./llm-provider-adapter";

const MASCOT_DB_NAME = "AiPhoneMascotDB";
const MASCOT_DB_VERSION = 2;
const MASCOT_CHAT_STORE = "chat";
const MASCOT_MESSAGES_KEY = "messages"; // 旧版单会话键，仅用于迁移
const MASCOT_STATE_KEY = "state";
// 单会话保留的消息条数。早期为 50，聊久了前面的内容就「看不见」——
// 提到 400 让一个窗口能撑很久，同时靠上下文用量提示引导用户主动换窗口。
const MAX_STORED_MASCOT_MESSAGES = 400;
const MAX_MASCOT_SESSIONS = 30;

// 上下文预算按字符估算（中文 ≈ 1 字符/token 量级），用于「上下文 NN%」提示。
// 可用 localStorage 键覆盖（调参用）。
const MASCOT_CONTEXT_BUDGET_KEY = "ai_phone_mascot_context_budget_chars";
export const MASCOT_DEFAULT_CONTEXT_BUDGET_CHARS = 32_000;
export const MASCOT_CONTEXT_BUDGET_MIN = 2_000;
export const MASCOT_CONTEXT_BUDGET_MAX = 2_000_000;

export type MascotSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: MascotMsg[];
    /** 抽屉里置顶显示；只影响排序，不动 updatedAt */
    isPinned?: boolean;
};

type PersistedMascotState = {
    sessions: MascotSession[];
    activeSessionId: string | null;
};

/**
 * 卷宝这一轮正在等什么。两个起点时钟都要带：界面每秒用 `measureWait` 现算，
 * 挂起的那一段（墙上 − 单调）不能算成「小卷想了很久」。
 */
export type MascotThinkingProgress = MascotWaitStart & {
    /** 第几轮（1 起） */
    round: number;
    maxRounds: number;
    /** 本轮已开始执行的动作中文名；null = 还在等模型回话 */
    toolName: string | null;
    /** 前几轮前台耗时均值（毫秒）；null = 样本还不够，不给参照 */
    paceMs: number | null;
};

export type MascotChatSnapshot = {
    messages: MascotMsg[];
    sessions: MascotSession[];
    activeSessionId: string | null;
    hydrated: boolean;
    isThinking: boolean;
    /** isThinking 为真时才有；停止 / 收尾时与 isThinking 一起清掉 */
    thinkingProgress: MascotThinkingProgress | null;
    /** 当前会话上下文用量（0–1+，达到 1 附近即建议开新窗口） */
    contextUsage: number;
};

const listeners = new Set<() => void>();
let messages: MascotMsg[] = [];
let sessions: MascotSession[] = [];
let activeSessionId: string | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let isThinking = false;
let thinkingProgress: MascotThinkingProgress | null = null;
let abortRequested = false;
let abortController: AbortController | null = null;
let snapshot: MascotChatSnapshot = { messages, sessions, activeSessionId, hydrated, isThinking, thinkingProgress, contextUsage: 0 };

function openMascotDb(): IDBOpenDBRequest {
    const request = indexedDB.open(MASCOT_DB_NAME, MASCOT_DB_VERSION);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) {
            request.result.createObjectStore(MASCOT_CHAT_STORE);
        }
    };
    return request;
}

function getContextBudget(): number {
    try {
        const raw = Number(localStorage.getItem(MASCOT_CONTEXT_BUDGET_KEY));
        if (Number.isFinite(raw) && raw >= MASCOT_CONTEXT_BUDGET_MIN && raw <= MASCOT_CONTEXT_BUDGET_MAX) {
            return Math.floor(raw);
        }
    } catch {
        // ignore
    }
    return MASCOT_DEFAULT_CONTEXT_BUDGET_CHARS;
}

export function getMascotContextBudgetChars(): number {
    return getContextBudget();
}

/** 设置上下文预算（null = 恢复默认）；立即刷新用量提示 */
export function setMascotContextBudgetChars(chars: number | null): void {
    try {
        if (chars == null) {
            localStorage.removeItem(MASCOT_CONTEXT_BUDGET_KEY);
        } else {
            const clamped = Math.min(MASCOT_CONTEXT_BUDGET_MAX, Math.max(MASCOT_CONTEXT_BUDGET_MIN, Math.floor(chars)));
            localStorage.setItem(MASCOT_CONTEXT_BUDGET_KEY, String(clamped));
        }
    } catch {
        // ignore
    }
    emit();
}

function mascotMessageChars(msg: MascotMsg): number {
    const text = (msg.text || "").length;
    const display = (msg.displayText || "").length;
    // 图片按固定权重近似计入（无法精确换算 token，但足以反映占用增长）
    return Math.max(text, display) + (msg.images?.length ?? 0) * 96;
}

export function getMascotSessionChars(session: MascotSession | null): number {
    if (!session) return 0;
    return session.messages.reduce((sum, msg) => sum + mascotMessageChars(msg), 0);
}

/** 当前会话已用的上下文字符数 */
export function getMascotActiveContextChars(): number {
    return getMascotSessionChars(getActiveMascotSession());
}

function computeContextUsage(): number {
    const session = getActiveMascotSession();
    if (!session) return 0;
    return getMascotSessionChars(session) / getContextBudget();
}

function emit() {
    snapshot = { messages, sessions, activeSessionId, hydrated, isThinking, thinkingProgress, contextUsage: computeContextUsage() };
    for (const listener of listeners) listener();
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("mascot-chat-updated", { detail: snapshot }));
    }
}

function persistState() {
    if (typeof indexedDB === "undefined") return;
    try {
        const req = openMascotDb();
        req.onsuccess = () => {
            try {
                if (!req.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) return;
                const tx = req.result.transaction(MASCOT_CHAT_STORE, "readwrite");
                const state: PersistedMascotState = { sessions, activeSessionId };
                tx.objectStore(MASCOT_CHAT_STORE).put(state, MASCOT_STATE_KEY);
                tx.oncomplete = () => req.result.close();
                tx.onerror = () => req.result.close();
            } catch {
                // Keep in-memory chat usable even if persistence fails.
            }
        };
    } catch {
        // Ignore IndexedDB availability issues.
    }
}

function withTimestamp(msg: MascotMsg): MascotMsg {
    return msg.createdAt ? msg : { ...msg, createdAt: new Date().toISOString() };
}

function normalizeMessages(nextMessages: MascotMsg[]): MascotMsg[] {
    return nextMessages.map(withTimestamp).slice(-MAX_STORED_MASCOT_MESSAGES);
}

export type ClearMascotToolHistoryResult = {
    messages: MascotMsg[];
    deletedMessages: number;
    cleanedMessages: number;
};

export type DeleteMascotMessageWithLinkedToolsResult = {
    messages: MascotMsg[];
    deletedMessages: number;
    cleanedMessages: number;
};

export function isMascotToolHistoryMessage(msg: MascotMsg): boolean {
    return msg.role === "tool";
}

export function hasMascotNativeToolReplayMetadata(msg: MascotMsg): boolean {
    return msg.toolCalls !== undefined
        || msg.reasoning !== undefined
        || msg.openRouterReasoningDetails !== undefined;
}

function hasVisibleMascotPayload(msg: MascotMsg): boolean {
    const display = (msg.displayText || "").trim();
    return !!msg.text.trim()
        || (!!display && display !== "（调用工具中...）" && display !== "（无内容）")
        || !!msg.images?.length;
}

export function hasMascotToolHistoryMessages(nextMessages: MascotMsg[]): boolean {
    return nextMessages.some((msg) => (
        isMascotToolHistoryMessage(msg) || hasMascotNativeToolReplayMetadata(msg)
    ));
}

export function clearMascotToolHistoryMessages(nextMessages: MascotMsg[]): ClearMascotToolHistoryResult {
    let deletedMessages = 0;
    let cleanedMessages = 0;
    const cleanedMessagesList: MascotMsg[] = [];

    for (const msg of nextMessages) {
        if (isMascotToolHistoryMessage(msg)) {
            deletedMessages += 1;
            continue;
        }

        if (!hasMascotNativeToolReplayMetadata(msg)) {
            cleanedMessagesList.push(msg);
            continue;
        }

        const cleaned: MascotMsg = { ...msg };
        delete cleaned.toolCalls;
        delete cleaned.reasoning;
        delete cleaned.openRouterReasoningDetails;

        if (msg.role === "mascot" && !hasVisibleMascotPayload(cleaned)) {
            deletedMessages += 1;
            continue;
        }

        cleanedMessages += 1;
        cleanedMessagesList.push(cleaned);
    }

    return { messages: cleanedMessagesList, deletedMessages, cleanedMessages };
}

function collectMascotToolCallIds(msg: MascotMsg): Set<string> {
    const ids = new Set<string>();
    if (msg.toolCallId) ids.add(msg.toolCallId);
    for (const call of msg.toolCalls || []) {
        if (call.id) ids.add(call.id);
    }
    return ids;
}

function removeToolCallsFromMascotMessage(msg: MascotMsg, idsToRemove: Set<string>): {
    message: MascotMsg | null;
    cleaned: boolean;
} {
    if (!msg.toolCalls?.length) return { message: msg, cleaned: false };

    const keptToolCalls = msg.toolCalls.filter((call) => !idsToRemove.has(call.id));
    if (keptToolCalls.length === msg.toolCalls.length) return { message: msg, cleaned: false };

    const cleaned: MascotMsg = { ...msg };
    if (keptToolCalls.length > 0) {
        cleaned.toolCalls = keptToolCalls;
    } else {
        delete cleaned.toolCalls;
    }

    if (!hasVisibleMascotPayload(cleaned) && !cleaned.toolCalls?.length) {
        return { message: null, cleaned: true };
    }

    return { message: cleaned, cleaned: true };
}

export function deleteMascotMessageWithLinkedTools(
    nextMessages: MascotMsg[],
    rawIndex: number,
): DeleteMascotMessageWithLinkedToolsResult {
    const target = nextMessages[rawIndex];
    if (!target) return { messages: nextMessages, deletedMessages: 0, cleanedMessages: 0 };

    const idsToRemove = collectMascotToolCallIds(target);
    const indexesToDelete = new Set<number>([rawIndex]);
    const replacements = new Map<number, MascotMsg>();
    let cleanedMessages = 0;

    if (idsToRemove.size > 0) {
        nextMessages.forEach((msg, index) => {
            if (index !== rawIndex && msg.role === "tool" && msg.toolCallId && idsToRemove.has(msg.toolCallId)) {
                indexesToDelete.add(index);
                return;
            }

            if (index !== rawIndex && msg.role === "mascot" && msg.toolCalls?.length) {
                const result = removeToolCallsFromMascotMessage(msg, idsToRemove);
                if (!result.cleaned) return;
                cleanedMessages += 1;
                if (result.message) {
                    replacements.set(index, result.message);
                } else {
                    indexesToDelete.add(index);
                }
            }
        });
    } else if (target.role === "mascot") {
        for (let i = rawIndex + 1; i < nextMessages.length; i += 1) {
            const msg = nextMessages[i];
            if (msg.role !== "tool") break;
            if (msg.toolCallId) break;
            indexesToDelete.add(i);
        }
    } else if (target.role === "tool") {
        for (let i = rawIndex - 1; i >= 0; i -= 1) {
            const msg = nextMessages[i];
            if (msg.role === "tool") continue;
            if (msg.role === "mascot" && !hasVisibleMascotPayload(msg)) indexesToDelete.add(i);
            break;
        }
    }

    let deletedMessages = 0;
    const messagesAfterDelete: MascotMsg[] = [];
    nextMessages.forEach((msg, index) => {
        if (indexesToDelete.has(index)) {
            deletedMessages += 1;
            return;
        }
        messagesAfterDelete.push(replacements.get(index) || msg);
    });

    return { messages: messagesAfterDelete, deletedMessages, cleanedMessages };
}

function makeMascotSessionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function autoMascotSessionTitle(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact || "新对话";
}

function getActiveMascotSession(): MascotSession | null {
    return sessions.find((session) => session.id === activeSessionId) ?? null;
}

function publishMessages(nextMessages: MascotMsg[], options: { persist?: boolean } = {}) {
    messages = normalizeMessages(nextMessages);
    const active = getActiveMascotSession();
    if (active) {
        const now = Date.now();
        sessions = sessions
            .map((session) => session.id === active.id
                ? { ...session, messages, updatedAt: now }
                : session)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (options.persist !== false) persistState();
    emit();
}

function setThinking(next: boolean) {
    isThinking = next;
    // 停止与收尾必须把进度一起清掉：留着旧进度，界面上会挂着一句「第 3 / 8 步 · 正在保存配方」
    // 而小卷其实已经不跑了。
    if (!next) thinkingProgress = null;
    emit();
}

/** 本轮进度：第几步 / 正在做哪个动作 / 两个时钟的起点。只在 isThinking 期间有值 */
function publishThinkingProgress(progress: MascotThinkingProgress | null) {
    thinkingProgress = progress;
    emit();
}

export function getMascotThinkingProgress(): MascotThinkingProgress | null {
    return isThinking ? thinkingProgress : null;
}

export function subscribeMascotChat(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getMascotChatSnapshot(): MascotChatSnapshot {
    return snapshot;
}

export function setMascotMessages(updater: MascotMsg[] | ((prev: MascotMsg[]) => MascotMsg[])) {
    const next = typeof updater === "function" ? updater(messages) : updater;
    publishMessages(next);
}

export function createMascotSession(options: { seedMessages?: MascotMsg[]; title?: string } = {}): string | null {
    if (!hydrated || isThinking) return null;
    clearExpandedPackages();
    const now = Date.now();
    const greeting = defaultGreetingMessage();
    const seeded = options.seedMessages && options.seedMessages.length > 0;
    const session: MascotSession = {
        id: makeMascotSessionId(),
        title: options.title || "新对话",
        createdAt: now,
        updatedAt: now,
        messages: seeded ? options.seedMessages! : (greeting ? [greeting] : []),
    };
    sessions = [session, ...sessions].slice(0, MAX_MASCOT_SESSIONS);
    activeSessionId = session.id;
    messages = session.messages;
    persistState();
    emit();
    return session.id;
}

/**
 * 「压缩总结后开新窗口」：把当前会话压成一段摘要，作为新会话的开场上下文，
 * 再切到新会话。这样新窗口既干净，又不丢前文的主题与结论。
 * @returns 新会话 id；当前会话没有可总结内容时返回 null（调用方应退回普通新建）
 */
export function createMascotSessionWithSummary(): string | null {
    if (!hydrated || isThinking) return null;
    const current = getActiveMascotSession();
    const summary = current ? buildMascotSessionSummary(current.messages) : "";
    if (!summary) return null;
    const seed: MascotMsg = {
        role: "mascot",
        text: summary,
        displayText: summary,
        createdAt: new Date().toISOString(),
    };
    return createMascotSession({ seedMessages: [seed], title: "接续对话（已压缩）" });
}

export function toggleMascotSessionPin(sessionId: string): boolean {
    if (!hydrated || !sessions.some((session) => session.id === sessionId)) return false;
    sessions = sessions.map((session) => session.id === sessionId
        ? { ...session, isPinned: !session.isPinned }
        : session);
    persistState();
    emit();
    return true;
}

export function switchMascotSession(sessionId: string): boolean {
    if (!hydrated || isThinking) return false;
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return false;
    activeSessionId = session.id;
    messages = normalizeMessages(session.messages);
    persistState();
    emit();
    return true;
}

export function renameMascotSession(sessionId: string, title: string): boolean {
    const nextTitle = title.replace(/\s+/g, " ").trim();
    if (!nextTitle || !hydrated || isThinking || !sessions.some((session) => session.id === sessionId)) return false;
    sessions = sessions.map((session) => session.id === sessionId ? { ...session, title: nextTitle } : session);
    persistState();
    emit();
    return true;
}

export function deleteMascotSession(sessionId: string): boolean {
    if (!hydrated || isThinking || !sessions.some((session) => session.id === sessionId)) return false;
    sessions = sessions.filter((session) => session.id !== sessionId);
    if (activeSessionId === sessionId) {
        activeSessionId = sessions[0]?.id ?? null;
        messages = sessions[0]?.messages ?? [];
    }
    if (sessions.length === 0) {
        const now = Date.now();
        const greeting = defaultGreetingMessage();
        const replacement: MascotSession = {
            id: makeMascotSessionId(),
            title: "新对话",
            createdAt: now,
            updatedAt: now,
            messages: greeting ? [greeting] : [],
        };
        sessions = [replacement];
        activeSessionId = replacement.id;
        messages = replacement.messages;
    }
    persistState();
    emit();
    return true;
}

function defaultGreetingMessage(): MascotMsg | null {
    const greeting = PAGE_GREETINGS["desktop"];
    return greeting ? { role: "mascot", text: greeting, createdAt: new Date().toISOString() } : null;
}

export function resetMascotConversation(options: { withGreeting?: boolean } = {}) {
    const withGreeting = options.withGreeting !== false;
    clearExpandedPackages();
    const greeting = withGreeting ? defaultGreetingMessage() : null;
    publishMessages(greeting ? [greeting] : []);
}

export async function hydrateMascotChat(): Promise<void> {
    if (hydrated) return;
    if (hydratePromise) return hydratePromise;
    hydratePromise = new Promise<void>((resolve) => {
        const finishWithMessages = (loaded: MascotMsg[], migrated: boolean) => {
            const greeting = loaded.length > 0 ? null : defaultGreetingMessage();
            messages = greeting ? [greeting] : loaded;
            const now = Date.now();
            const session: MascotSession = {
                id: makeMascotSessionId(),
                title: migrated && loaded.length > 0 ? "之前的对话" : "新对话",
                createdAt: now,
                updatedAt: now,
                messages,
            };
            sessions = [session];
            activeSessionId = session.id;
            hydrated = true;
            persistState();
            emit();
            resolve();
        };

        if (typeof indexedDB === "undefined") {
            finishWithMessages([], false);
            return;
        }
        const req = openMascotDb();
        req.onsuccess = () => {
            try {
                if (!req.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) {
                    req.result.close();
                    finishWithMessages([], false);
                    return;
                }
                const tx = req.result.transaction(MASCOT_CHAT_STORE, "readonly");
                const store = tx.objectStore(MASCOT_CHAT_STORE);
                const stateGet = store.get(MASCOT_STATE_KEY);
                stateGet.onsuccess = () => {
                    const state = stateGet.result as PersistedMascotState | undefined;
                    if (state && Array.isArray(state.sessions) && state.sessions.length > 0) {
                        sessions = state.sessions
                            .filter((session) => session && typeof session.id === "string" && Array.isArray(session.messages))
                            .map((session) => ({ ...session, messages: normalizeMessages(session.messages) }))
                            .sort((a, b) => b.updatedAt - a.updatedAt)
                            .slice(0, MAX_MASCOT_SESSIONS);
                        activeSessionId = state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId)
                            ? state.activeSessionId
                            : sessions[0]?.id ?? null;
                        messages = sessions.find((session) => session.id === activeSessionId)?.messages ?? [];
                        hydrated = true;
                        emit();
                        req.result.close();
                        resolve();
                        return;
                    }

                    // 首次升级：保留旧键，并将旧版单会话记录复制进多会话 state。
                    const legacyGet = store.get(MASCOT_MESSAGES_KEY);
                    legacyGet.onsuccess = () => {
                        const loaded = Array.isArray(legacyGet.result) ? normalizeMessages(legacyGet.result) : [];
                        req.result.close();
                        finishWithMessages(loaded, loaded.length > 0);
                    };
                    legacyGet.onerror = () => {
                        req.result.close();
                        finishWithMessages([], false);
                    };
                };
                stateGet.onerror = () => {
                    req.result.close();
                    finishWithMessages([], false);
                };
            } catch {
                try { req.result.close(); } catch {}
                finishWithMessages([], false);
            }
        };
        req.onerror = () => finishWithMessages([], false);
    });
    return hydratePromise;
}

export function stopMascotGeneration() {
    abortRequested = true;
    abortController?.abort();
}

export async function appendMascotMessage({
    text,
    images = [],
    displayText,
}: {
    text: string;
    images?: string[];
    /** 只影响 UI 显示，不影响发给模型的 text —— 给「文件卡」这类
     *  「正文很长但气泡只该显示一行摘要」的场景用。 */
    displayText?: string;
}): Promise<boolean> {
    await hydrateMascotChat();
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || isThinking) return false;

    const shown = typeof displayText === "string" ? displayText.trim() : "";
    const userMsg: MascotMsg = images.length > 0
        ? { role: "user", text: trimmed, images, ...(shown ? { displayText: shown } : {}), createdAt: new Date().toISOString() }
        : { role: "user", text: trimmed, ...(shown ? { displayText: shown } : {}), createdAt: new Date().toISOString() };
    const shouldAutoTitle = !messages.some((msg) => msg.role === "user");
    const workingMessages = normalizeMessages([...messages, userMsg]);
    if (shouldAutoTitle && activeSessionId) {
        sessions = sessions.map((session) => session.id === activeSessionId
            ? { ...session, title: autoMascotSessionTitle(shown || trimmed || "（图片）") }
            : session);
    }
    publishMessages(workingMessages);
    return true;
}

export async function generateMascotReply({
    context = getMascotContext(),
}: {
    context?: MascotPageContext;
} = {}): Promise<void> {
    await hydrateMascotChat();
    if (isThinking) return;
    const latestVisibleMessage = [...messages].reverse().find((msg) => !msg.hidden && msg.role !== "tool");
    if (latestVisibleMessage?.role !== "user") return;

    let workingMessages = normalizeMessages(messages);
    setThinking(true);
    // 一条用户消息 = 一轮任务：台账清空，本轮建过的对象（材料/角色/预设/配方）从这里开始记
    resetMascotTaskLedger();
    // 制作规格常驻板同样是任务级状态：上一轮读过的规格不带进新任务
    resetMixCraftSpecBoard();
    // 材料正文常驻板也是任务级：上一轮读过的材料不带进新任务
    resetMixMaterialBoard();
    /**
     * 记账口径由「卷宝用的那本账」决定：
     * - 默认 `per_call`：**每次真实调用各记一笔** —— 内部调 5 次就是 5 笔，账本贴近中转站的真实消耗；
     * - `per_task`：把单价当「任务包价」用，整段 agent loop 挂起计费、结束只结算一笔
     *   （账本会比真实消耗宽松，用户要自己清楚这点）。
     */
    const mascotBillingConfig = resolveAuxiliaryApiConfig("mascotApiConfigId");
    const deferBilling = isTaskBillingEnabled(accountIdForConfig(mascotBillingConfig));
    if (deferBilling) beginTaskBilling();

    const MAX_ROUNDS = getMascotMaxRounds();
    /**
     * 诊断日志：开关没打开时返回 null，整条链路零开销。
     * 一次提问一个 task，每轮模型调用一个 round；记录里只留判定所需的事实。
     */
    const diagTask = beginMascotDiagTask({
        protocol: mascotBillingConfig && nativeToolProtocolForConfig(mascotBillingConfig) ? "native" : "text",
        providerKind: mascotBillingConfig?.provider,
        model: mascotBillingConfig?.defaultModel,
        baseUrl: mascotBillingConfig?.baseUrl,
        maxTokens: getMascotMaxOutputTokens(),
        maxRounds: MAX_ROUNDS,
        streaming: mascotBillingConfig ? mascotBillingConfig.enableStreaming !== false : true,
        historyMessages: workingMessages.length,
        historyChars: workingMessages.reduce((sum, msg) => sum + (msg.text?.length ?? 0), 0),
        imageCount: workingMessages.reduce((sum, msg) => sum + (msg.images?.length ?? 0), 0),
        contextUsage: snapshot.contextUsage,
        userText: latestVisibleMessage.text,
    });
    let taskErrorMessage: string | undefined;
    /** 任务没做完却不再输出动作时，允许「提醒重试」的次数（文本协议下模型偶尔会写错动作格式） */
    let nudges = 0;
    /** 输出被 max_tokens 截断后，允许自动续写的次数 */
    let autoContinues = 0;
    /** 本次任务真实执行过的动作，收尾兜底小结靠它拼「做了什么」 */
    const ranActions: MascotExecutedAction[] = [];
    /** 实际跑了几轮：等于 MAX_ROUNDS 说明是被上限截断的，不是自然结束 */
    let roundsRun = 0;
    /** 最后一轮留下的可见文字：空着就得补一条进度小结，不能让她对着「（无内容）」发呆 */
    let lastVisibleReply = "";
    /** 循环为什么结束：null = 模型自己收尾了，不需要额外说明 */
    let digestReason: MascotProgressDigestReason | null = null;
    let brokeOut = false;
    /** 本次任务是否以报错收场：per_task 口径下这种时候不按包价结算（见 finally） */
    let taskFailed = false;
    abortRequested = false;
    const controller = new AbortController();
    abortController = controller;
    let expandedPackageIds = loadExpandedPackages();
    // 特调意图自动展开：用户原话明显要做特调时直接记入已展开集合，
    // 省掉「模型先花一轮展开套件」；返回原引用 = 没变化，不触发持久化写入。
    const autoExpandedIds = autoExpandMixologyPackage(expandedPackageIds, latestVisibleMessage?.text ?? "");
    if (autoExpandedIds !== expandedPackageIds) {
        expandedPackageIds = autoExpandedIds;
        saveExpandedPackages(expandedPackageIds);
    }
    // 每次用户发送消息就是一次独立任务；最多 8 轮工具调用共享同一备份集合。
    const toolCtx: MascotToolContext = {
        pageContext: context,
        history: workingMessages,
        characterBackupIds: new Set<string>(),
    };

    /**
     * 输出被 max_tokens 切断时向模型要一次续写：残缺的那条动作没有执行，任务并没有做完。
     * 返回 false = 自动续写次数用完，调用方要把「为什么停了」写进会话，不能默默收场。
     */
    const requestAutoContinue = (): boolean => {
        if (autoContinues >= MASCOT_MAX_AUTO_CONTINUES) return false;
        autoContinues += 1;
        workingMessages = normalizeMessages([...workingMessages,
            {
                role: "mascot",
                text: MASCOT_AUTO_CONTINUE_VISIBLE_HINT,
                createdAt: new Date().toISOString(),
            },
            {
                role: "user",
                text: MASCOT_AUTO_CONTINUE_PROMPT,
                hidden: true,
                displayText: "（系统提示：输出被截断，自动续写）",
                createdAt: new Date().toISOString(),
            },
        ]);
        publishMessages(workingMessages);
        return true;
    };

    /**
     * 本轮前台耗时样本（毫秒，已剔除挂起段）：给「前几轮通常 X」当参照。
     * 只留最近 8 个，均值取最近 3 个 —— 冷启动那一轮最慢，取全局均值会把参照抬虚。
     */
    const foregroundSamples: number[] = [];
    /** 正在跑的那一轮：报错时循环会直接跳到外层 catch，得在这儿留个把手才量得到挂起段 */
    let inFlightDiagRound: MascotDiagRoundRecorder | null = null;
    let inFlightWaitStart: MascotWaitStart | null = null;

    /** 墙上 / 单调两个时钟各量一遍，拆出「前台真等」与「页面被挂起」 */
    const measureRoundWait = (start: MascotWaitStart) => {
        const wallMs = Date.now() - start.startedWallAt;
        const monoMs = Math.max(0, Math.round(nowMono() - start.startedMonoAt));
        return { wallMs, monoMs, ...splitWaitGap(wallMs, monoMs) };
    };

    try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
            roundsRun = round + 1;
            if (abortRequested) break;

            const diagRound: MascotDiagRoundRecorder | undefined = diagTask?.startRound(round + 1);
            /** 这一轮的两个时钟起点：墙上时间会跨过挂起，单调时间不会 */
            const roundWaitStart = markWaitStart();
            inFlightDiagRound = diagRound ?? null;
            inFlightWaitStart = roundWaitStart;
            publishThinkingProgress({
                ...roundWaitStart,
                round: round + 1,
                maxRounds: MAX_ROUNDS,
                toolName: null,
                paceMs: rollingPaceMs(foregroundSamples),
            });
            let streamedDisplay = "";
            let lastStreamPaintAt = 0;
            let lastStreamPaintLength = 0;
            /** 诊断：流式期间实际画到屏幕上的字数（最后一次成功绘制时的长度） */
            let paintedDuringStream = 0;
            let maxPaintGapMs = 0;
            let maxRafWaitMs = 0;
            let hiddenDuringStream = typeof document !== "undefined" && document.visibilityState === "hidden";
            const streamToolIds = new Set<string>();
            const streamToolMessages: MascotMsg[] = [];
            const paintStream = async (force = false) => {
                const now = Date.now();
                if (!force && streamedDisplay.length - lastStreamPaintLength < 12 && now - lastStreamPaintAt < 50) return;
                if (lastStreamPaintAt > 0) maxPaintGapMs = Math.max(maxPaintGapMs, now - lastStreamPaintAt);
                lastStreamPaintAt = now;
                lastStreamPaintLength = streamedDisplay.length;
                if (typeof document !== "undefined" && document.visibilityState === "hidden") hiddenDuringStream = true;
                const liveItems: MascotMsg[] = [];
                if (streamedDisplay.trim()) {
                    liveItems.push({
                        role: "mascot",
                        text: streamedDisplay,
                        displayText: streamedDisplay,
                        createdAt: new Date().toISOString(),
                    });
                }
                liveItems.push(...streamToolMessages.map(withTimestamp));
                publishMessages([...workingMessages, ...liveItems], { persist: false });
                const rafStart = Date.now();
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                maxRafWaitMs = Math.max(maxRafWaitMs, Date.now() - rafStart);
                // rAF 真的回调了，才算这一版画到屏幕上
                paintedDuringStream = streamedDisplay.length;
            };

            const requestRound = () => mascotChatWithTools(
                context,
                workingMessages,
                expandedPackageIds,
                {
                    signal: controller.signal,
                    diag: diagRound,
                    callbacks: {
                        async onAssistantDelta(delta) {
                            if (!delta) return;
                            streamedDisplay += delta;
                            await paintStream(false);
                        },
                        async onToolCallStart(info) {
                            if (streamToolIds.has(info.id)) return;
                            streamToolIds.add(info.id);
                            // 「正在做什么」直接写进等待提示，她不用猜小卷是在等模型还是在动手
                            if (thinkingProgress) publishThinkingProgress({ ...thinkingProgress, toolName: info.name });
                            streamToolMessages.push({
                                role: "tool",
                                text: "",
                                hidden: false,
                                displayText: `正在调用 ${info.name}…`,
                                toolName: info.name,
                                toolDisplayName: info.name,
                                createdAt: new Date().toISOString(),
                            });
                            await paintStream(true);
                        },
                        async onStreamFallback(reason) {
                            console.warn("[Mascot] 流式输出不可用，已切换普通生成:", reason);
                        },
                    },
                },
            );
            /**
             * 断流轮级重试（诊断 mascot-diag-20261112-1221：第 5 轮挂死 17.8 分钟、整个任务超时收场）——
             * 看门狗判死/网络挂断这类错误里，这一轮的内容一个字都没落地，原地重试同一轮比让她整条重发便宜得多。
             * 但只重试 MASCOT_MAX_STALL_RETRIES 次：中转要是死了，重试也白搭，报错让她喊「继续」才是正解；
             * 「空内容」「4xx/额度」这类确定性错误不在列——重试只会再烧一次钱。
             */
            let response: Awaited<ReturnType<typeof mascotChatWithTools>>;
            try {
                response = await requestRound();
            } catch (roundError) {
                if (
                    MASCOT_MAX_STALL_RETRIES < 1
                    || controller.signal.aborted
                    || !isMascotStallError(roundError)
                ) {
                    throw roundError;
                }
                diagRound?.markLoop("stall_retry");
                // 断掉那半截不算数：续接缓冲清空，重试的回复重新流
                streamedDisplay = "";
                workingMessages = normalizeMessages([...workingMessages, {
                    role: "mascot",
                    text: MASCOT_STALL_RETRY_VISIBLE_HINT,
                    createdAt: new Date().toISOString(),
                }]);
                publishMessages(workingMessages, { persist: false });
                response = await requestRound();
            }
            // 诊断：先按「流式期间真正画出来多少」记一版，再强制补画。
            // 后台 rAF 被挂起时补画会卡住，这一版就是唯一能留下的现场；
            // 补画后的字数不能回填，否则会把「当时没画出来」擦干净。
            /**
             * 这一轮到底等了多久：墙上时间与单调时间各算一遍，差值就是页面被挂起的那一段。
             * 必须每轮都记 —— 工具轮一个字都没吐，`ui` 那套统计对它是空的，
             * 而「52 分钟里只有 9 秒在前台」这条证据恰恰只在这种轮次里出现。
             */
            const roundWait = measureRoundWait(roundWaitStart);
            inFlightWaitStart = null;
            inFlightDiagRound = null;
            if (roundWait.foregroundMs > 0) {
                foregroundSamples.push(roundWait.foregroundMs);
                if (foregroundSamples.length > 8) foregroundSamples.shift();
            }
            diagRound?.markTiming(roundWait);
            if (streamedDisplay) {
                const paintedBeforeFinal = paintedDuringStream;
                const uiStats = {
                    engineChars: streamedDisplay.length,
                    paintedChars: paintedBeforeFinal,
                    maxPaintGapMs,
                    maxRafWaitMs,
                    hiddenDuringStream,
                };
                diagRound?.markUi(uiStats);
                await paintStream(true);
            }

            const displayReply = response.reply.join("\n");
            if (displayReply.trim()) lastVisibleReply = displayReply;
            const assistantMsg: MascotMsg = {
                role: "mascot",
                text: response.rawAssistant,
                displayText: displayReply || (response.toolCalls.length > 0 || response.toolFetches.length > 0 ? "（调用工具中...）" : "（无内容）"),
                createdAt: new Date().toISOString(),
            };
            if (response.protocol === "native" && response.nativeToolCalls && response.nativeToolCalls.length > 0) {
                assistantMsg.toolCalls = response.nativeToolCalls;
            }
            if (response.protocol === "native" && response.reasoning) {
                assistantMsg.reasoning = response.reasoning;
            }
            if (response.protocol === "native" && response.openRouterReasoningDetails?.length) {
                assistantMsg.openRouterReasoningDetails = response.openRouterReasoningDetails;
            }
            workingMessages = normalizeMessages([...workingMessages, assistantMsg]);
            publishMessages(workingMessages);

            if (response.toolFetches.length > 0) {
                for (const fetch of response.toolFetches) {
                    const pkg = findPackageByLabel(fetch.name);
                    if (!pkg) continue;
                    expandedPackageIds = touchExpandedPackage(expandedPackageIds, pkg.id);
                    saveExpandedPackages(expandedPackageIds);

                    // 动作说明不再整段塞进历史：历史只带最近 40 条，长任务里说明会被挤出窗口，
                    // 模型于是凭记忆编动作名或反复展开。说明现在常驻系统提示，这里只留一行回执。
                    const guideContent = `「${pkg.label}」已展开，动作说明已写进本轮系统提示，不用再展开一次。`;

                    if (response.protocol === "native") {
                        const loaderName = getMascotNativeLoaderName(pkg.id);
                        const loaderCall = response.nativeToolCalls?.find((call) => call.name === loaderName);
                        workingMessages = normalizeMessages([...workingMessages, {
                            role: "tool",
                            text: guideContent,
                            hidden: false,
                            displayText: `展开「${pkg.label}」工具集`,
                            toolCallId: loaderCall?.id || "",
                            toolName: loaderCall?.name || loaderName,
                            toolDisplayName: `展开${pkg.label}`,
                            toolSuccess: true,
                            createdAt: new Date().toISOString(),
                        }]);
                    } else {
                        workingMessages = normalizeMessages([...workingMessages, {
                            role: "tool",
                            text: guideContent,
                            hidden: false,
                            displayText: `展开「${pkg.label}」工具集`,
                            toolName: `展开${pkg.label}`,
                            toolDisplayName: `展开${pkg.label}`,
                            toolSuccess: true,
                            createdAt: new Date().toISOString(),
                        }]);
                    }
                    publishMessages(workingMessages);
                }
                if (response.truncated && !requestAutoContinue()) {
                    diagRound?.markLoop("truncated");
                    digestReason = "truncated";
                    brokeOut = true;
                    break;
                }
                diagRound?.markLoop(response.truncated ? "auto_continue" : "tool_fetch");
                continue;
            }

            if (response.toolCalls.length > 0) {
                for (let i = 0; i < response.toolCalls.length; i += 1) {
                    const call = response.toolCalls[i];
                    const nativeCall = response.protocol === "native"
                        ? response.nativeToolCalls?.[i]
                        : undefined;
                    const displayName = call.name;
                    const protocolName = nativeCall?.name || call.name;

                    const runningMessage: MascotMsg = {
                        role: "tool",
                        text: "",
                        hidden: false,
                        displayText: `正在调用 ${displayName}…`,
                        toolName: protocolName,
                        toolDisplayName: displayName,
                        createdAt: new Date().toISOString(),
                    };
                    workingMessages = normalizeMessages([...workingMessages, runningMessage]);
                    const runningIdx = workingMessages.length - 1;
                    publishMessages(workingMessages);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

                    // 复用同一上下文，确保多轮工具调用共享角色备份状态。
                    toolCtx.history = workingMessages;
                    const result = await executeMascotToolCall(call, toolCtx);
                    if (result.success) mascotFillField({ field: call.name, value: result.data || "" });

                    const resultText = result.success ? (result.data || "完成") : (result.error || "未知错误");
                    ranActions.push({
                        name: displayName,
                        success: result.success,
                        detail: result.success ? extractMascotActionDetail(resultText) : undefined,
                    });
                    const updated = [...workingMessages];
                    updated[runningIdx] = {
                        role: "tool",
                        text: resultText,
                        hidden: false,
                        displayText: resultText,
                        images: result.mediaAttachments?.filter((attachment) => attachment.type === "image").map((attachment) => attachment.url),
                        toolCallId: nativeCall?.id || "",
                        toolName: protocolName,
                        toolDisplayName: displayName,
                        toolSuccess: result.success,
                        createdAt: updated[runningIdx]?.createdAt || new Date().toISOString(),
                    };
                    workingMessages = normalizeMessages(updated);
                    publishMessages(workingMessages);
                }
                // 同一条回复里完整的动作照常执行了，但被切断的那半条没跑：不能当完工
                if (response.truncated && !requestAutoContinue()) {
                    diagRound?.markLoop("truncated");
                    digestReason = "truncated";
                    brokeOut = true;
                    break;
                }
                diagRound?.markLoop(response.truncated ? "auto_continue" : "actions");
                continue;
            }

            /**
             * 走到这里 = 模型这一轮既没要求展开套件、也没给出可执行动作。
             * 三种可能：真的做完了（写了一份收尾报告）；输出被截断（残缺动作没执行，任务没做完）；
             * 或者它把动作格式写错了（文本协议下很常见，parseToolCalls 会静默跳过解析不出来的动作）。
             * 后两种都不能收工——旧版只靠 /已完成/i 命中回复任意位置就 break，
             * 「已完成一半，接下来…」也会被当成完工，这正是「没做几个任务就中断」的成因。
             */
            if (response.truncated) {
                if (!requestAutoContinue()) {
                    diagRound?.markLoop("truncated");
                    digestReason = "truncated";
                    brokeOut = true;
                    break;
                }
                diagRound?.markLoop("auto_continue");
                continue;
            }

            if (looksLikeWrapUp(displayReply)) {
                diagRound?.markLoop("wrapup");
                digestReason = null;
                brokeOut = true;
                break;
            }

            // 只在「任务确实动过手」或「这轮什么都没写」时催它继续；纯闲聊直接收场，
            // 免得问一句用法也被推着去乱点按钮。
            const wroteNothing = !displayReply.trim();
            if ((ranActions.length > 0 || wroteNothing) && nudges < MASCOT_MAX_NUDGES) {
                nudges += 1;
                diagRound?.markLoop("nudge");
                workingMessages = normalizeMessages([...workingMessages, {
                    role: "user",
                    text: buildMascotNudgePrompt(),
                    hidden: true,
                    displayText: "（系统提醒：继续执行）",
                    createdAt: new Date().toISOString(),
                }]);
                publishMessages(workingMessages);
                continue;
            }

            digestReason = "silent";
            diagRound?.markLoop("silent");
            brokeOut = true;
            break;
        }

        // 循环自然跑完 = 轮数预算用尽，不是模型收尾
        if (!brokeOut && !abortRequested && roundsRun >= MAX_ROUNDS) digestReason = "rounds";
        if (abortRequested) digestReason = "abort";

        // 收尾兜底：非正常结束时，会话里必须留下「做了什么 / 还差什么」，
        // 而不是只有一条飘过就消失的通知条（面板开着时以前连通知条都没有）。
        const closingNotice = digestReason === "rounds"
            ? MASCOT_ROUNDS_EXHAUSTED_NOTICE
            : digestReason === "truncated"
                ? MASCOT_TRUNCATED_EXHAUSTED_NOTICE
                : "";
        const needDigest = digestReason !== null
            && ranActions.length > 0
            && !looksLikeWrapUp(lastVisibleReply);
        const digestText = needDigest && digestReason
            ? buildMascotProgressDigest(ranActions, digestReason)
            : "";
        const closingText = [
            closingNotice,
            digestText,
        ].filter(Boolean).join("\n\n");
        if (closingText) {
            workingMessages = normalizeMessages([...workingMessages, {
                role: "mascot",
                text: closingText,
                createdAt: new Date().toISOString(),
            }]);
            publishMessages(workingMessages);
        }

        if (abortRequested) {
            publishMessages([...workingMessages, { role: "user", text: "[用户中止了操作]", hidden: false, createdAt: new Date().toISOString() }]);
        }
        const hitRoundLimit = !abortRequested && digestReason === "rounds";
        if (!isMascotPanelOpen() && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("global-notice", {
                detail: abortRequested
                    ? "操作已中止"
                    : hitRoundLimit
                        ? "卷宝已达轮数上限，任务可能没做完 —— 再说一句「继续」就能接着做"
                        : "AI助手已完成操作 ✓",
            }));
        }
    } catch (err) {
        // 报错那一轮同样要留下 timing：502 / 断流的轮次恰好就是她觉得「一直在思考」的那几轮，
        // 循环直接跳到这儿，正常收尾的 markTiming 已经轮不到了。
        if (inFlightDiagRound && inFlightWaitStart) {
            inFlightDiagRound.markTiming(measureRoundWait(inFlightWaitStart));
            inFlightDiagRound = null;
            inFlightWaitStart = null;
        }
        if ((err as Error).name !== "AbortError" && !abortRequested) {
            taskFailed = true;
            taskErrorMessage = (err as Error).message;
            publishMessages([...workingMessages, { role: "mascot", text: `出错了...${(err as Error).message}`, createdAt: new Date().toISOString() }]);
            if (!isMascotPanelOpen() && typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("global-notice", { detail: "AI助手生成失败了..." }));
            }
        }
    } finally {
        // 诊断日志收尾：单独一行，任何分支都要留下「这次为什么停」
        if (diagTask) {
            void diagTask.finish({
                reason: abortRequested ? "abort" : (digestReason ?? (taskFailed ? "error" : "wrapup")),
                rounds: roundsRun,
                actions: ranActions.map((action) => ({ name: action.name, success: action.success })),
                digestReason: digestReason ?? undefined,
                error: taskErrorMessage,
            });
        }
        // per_task 口径才需要收尾结算；per_call 的账在每次调用时就已经记过了
        if (deferBilling) {
            endTaskBilling();
            if (!isTaskBillingActive()) {
                try {
                    // 报错收场的任务没交付，不按「任务包价」结算；她按停的那次照结 ——
                    // 那几轮请求真的发出去了，钱也真的从中转站扣走了。
                    if (taskFailed) cancelTaskBilling();
                    else settleTaskBilling(mascotBillingConfig, summarizeTaskLedger());
                } catch (error) {
                    console.warn("[Mascot] 任务结算失败（不影响对话）", error);
                }
            }
        }
        setThinking(false);
        abortController = null;
    }
}

export async function sendMascotMessage({
    text,
    images = [],
    displayText,
    context = getMascotContext(),
}: {
    text: string;
    images?: string[];
    /** 只影响 UI 显示的摘要（见 appendMascotMessage） */
    displayText?: string;
    context?: MascotPageContext;
}): Promise<void> {
    const accepted = await appendMascotMessage({ text, images, displayText });
    if (accepted) await generateMascotReply({ context });
}

export function getMascotLastPreview(): string {
    const latest = [...messages].reverse().find((msg) => {
        if (msg.hidden || msg.role === "tool") return false;
        const text = (msg.displayText || msg.text || "").trim();
        return !!text && text !== "（调用工具中...）" && text !== "（无内容）";
    });
    if (!latest) return "可以帮你创建角色、预设、正则和 CSS";
    if (latest.role === "user") return latest.images?.length ? "[图片] " + latest.text : latest.text;
    return latest.displayText || latest.text;
}
