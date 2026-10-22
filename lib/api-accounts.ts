/**
 * API 账户与账目工具 —— 「一个 API 文件夹就是一本账」。
 *
 * 设计约定：
 * - 账户 id 直接用 ApiConfig.groupId（空串 = 未分组账户），所以「把 API 拖进文件夹」= 换成扣那个账户的钱。
 * - 余额与单价全部由用户手写，本模块不做任何价格推断，也不发任何网络请求。
 * - 删文件夹不会删账户、不会删流水：账目属于钱，不能因为整理目录而丢失。
 * - 所有写操作都会广播 API_ACCOUNTS_UPDATED_EVENT，方便快捷菜单 / 设置页 / 特调界面同步刷新。
 *
 * 组件一律走这里，不要自己去 load/save settings-storage 里的账户与流水键。
 */
import type { ApiAccount, ApiConfig, ApiGroup, ApiLedgerEntry, ApiPricing, ApiPricingMode } from "./settings-types";
import {
    loadApiAccounts,
    loadApiConfigs,
    loadApiGroups,
    loadApiLedger,
    loadBindingConfig,
    saveApiAccounts,
    saveApiLedger,
} from "./settings-storage";

/** 未分组账户 id（与 ApiConfig.groupId 的空值对齐） */
export const API_UNGROUPED_ACCOUNT_ID = "";
/** 流水保留上限（超出裁掉最旧的） */
export const API_LEDGER_LIMIT = 500;
/** 账户/流水变更广播事件名 */
export const API_ACCOUNTS_UPDATED_EVENT = "api-accounts-updated";
/**
 * 自动扣费提示事件。
 *
 * 比 global-notice 多带结构化数据，且专供「会挡住手机顶部全局提示」的界面使用
 * —— 桌宠小窗从右下往上展开、z-index 又高于全局提示，扣费时全局提示会被它盖住，
 * 所以小窗订阅这个事件、在自身面板内部就地渲染一条提示。
 */
export const LLM_SPEND_NOTICE_EVENT = "llm-spend-notice";

export type LlmSpendNoticeDetail = {
    /** 合并后的本次扣费金额 */
    amount: number;
    /** 触发扣费的 API 名 */
    configName: string;
    /** 扣完后的账户余额 */
    balance: number;
    /** 现成文案，可直接显示 */
    text: string;
};

export type ApiAccountSpend = {
    accountId: string;
    amount: number;
    configId?: string;
    configName?: string;
    note?: string;
};

function createLedgerId(): string {
    return `apiledger_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function roundAmount(value: number): number {
    return Math.round(value * 10000) / 10000;
}

/** 广播账户变更（跨组件刷新用） */
export function notifyApiAccountsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(API_ACCOUNTS_UPDATED_EVENT));
}

export function emptyApiAccount(id: string = API_UNGROUPED_ACCOUNT_ID): ApiAccount {
    return {
        id,
        balance: 0,
        autoCharge: true,
        billingMode: "per_call",
        updatedAt: Date.now(),
    };
}

export function loadAccounts(): ApiAccount[] {
    return loadApiAccounts();
}

/** 取账户；不存在时返回一份默认值（不落库，只有真正写入时才创建） */
export function getApiAccount(accountId?: string): ApiAccount {
    const id = typeof accountId === "string" ? accountId : API_UNGROUPED_ACCOUNT_ID;
    const found = loadApiAccounts().find(account => account.id === id);
    return found ? { ...found } : emptyApiAccount(id);
}

/** 账户是否存在（有余额记录或改过设置） */
export function hasApiAccount(accountId?: string): boolean {
    const id = typeof accountId === "string" ? accountId : API_UNGROUPED_ACCOUNT_ID;
    return loadApiAccounts().some(account => account.id === id);
}

function writeAccount(account: ApiAccount): ApiAccount {
    const accounts = loadApiAccounts();
    const index = accounts.findIndex(item => item.id === account.id);
    const next = { ...account, updatedAt: Date.now() };
    if (index >= 0) accounts[index] = next;
    else accounts.push(next);
    saveApiAccounts(accounts);
    notifyApiAccountsUpdated();
    return next;
}

function appendLedger(entries: ApiLedgerEntry[]): void {
    if (entries.length === 0) return;
    const next = [...entries, ...loadApiLedger()].slice(0, API_LEDGER_LIMIT);
    saveApiLedger(next);
}

/** 关联到某个配置的账户 id */
export function accountIdForConfig(config?: ApiConfig | null): string {
    return typeof config?.groupId === "string" ? config.groupId : API_UNGROUPED_ACCOUNT_ID;
}

/** 账户显示名：文件夹名；未分组显示「未分组」 */
export function accountLabel(accountId?: string, groups?: ApiGroup[]): string {
    const id = typeof accountId === "string" ? accountId : API_UNGROUPED_ACCOUNT_ID;
    if (!id) return "未分组";
    const list = groups ?? loadApiGroups();
    return list.find(group => group.id === id)?.name || "已删除的文件夹";
}

/** 按计价方式算钱 */
export function estimateCost(pricing: ApiPricing | undefined, quantity: number): number {
    if (!pricing || !Number.isFinite(pricing.amount)) return 0;
    const amount = Math.max(0, pricing.amount);
    const count = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
    if (pricing.mode === "per_1k_tokens") return roundAmount((amount * count) / 1000);
    return roundAmount(amount * count);
}

export function pricingLabel(pricing?: ApiPricing): string {
    if (!pricing || !Number.isFinite(pricing.amount) || pricing.amount <= 0) return "未设单价";
    const amount = roundAmount(pricing.amount);
    if (pricing.mode === "per_1k_tokens") return `${amount} / 1K tok`;
    if (pricing.mode === "manual") return `参考 ${amount}`;
    return `${amount} / 次`;
}

export function pricingModeLabel(mode: ApiPricingMode): string {
    if (mode === "per_1k_tokens") return "按量（每 1K token）";
    if (mode === "manual") return "仅参考（每次手填）";
    return "按次";
}

export function isAccountLow(account: ApiAccount): boolean {
    const threshold = Number(account.lowThreshold);
    return Number.isFinite(threshold) && threshold > 0 && account.balance <= threshold;
}

/** 直接设定余额（并记一条流水） */
export function setAccountBalance(
    accountId: string,
    balance: number,
    options?: { note?: string; kind?: "set" | "topup" }
): { account: ApiAccount; entry: ApiLedgerEntry } {
    const current = getApiAccount(accountId);
    const nextBalance = roundAmount(Number.isFinite(balance) ? balance : 0);
    const delta = roundAmount(nextBalance - current.balance);
    const kind = options?.kind ?? (delta >= 0 ? "topup" : "set");
    const account = writeAccount({ ...current, balance: nextBalance });
    const entry: ApiLedgerEntry = {
        id: createLedgerId(),
        accountId: account.id,
        kind,
        amount: Math.abs(delta),
        balanceAfter: nextBalance,
        note: options?.note,
        createdAt: Date.now(),
    };
    appendLedger([entry]);
    return { account, entry };
}

/** 充值：在现有余额上加 */
export function topUpAccount(accountId: string, amount: number, note?: string): { account: ApiAccount; entry: ApiLedgerEntry } {
    const current = getApiAccount(accountId);
    const add = Math.abs(roundAmount(Number.isFinite(amount) ? amount : 0));
    return setAccountBalance(accountId, roundAmount(current.balance + add), { note: note || "充值", kind: "topup" });
}

/** 扣费：余额减掉本次消耗（允许扣成负数，方便事后补记） */
export function spendFromAccount(input: ApiAccountSpend): { account: ApiAccount; entry: ApiLedgerEntry } {
    const current = getApiAccount(input.accountId);
    const amount = Math.abs(roundAmount(Number.isFinite(input.amount) ? input.amount : 0));
    const nextBalance = roundAmount(current.balance - amount);
    const account = writeAccount({ ...current, balance: nextBalance });
    const entry: ApiLedgerEntry = {
        id: createLedgerId(),
        accountId: account.id,
        configId: input.configId,
        configName: input.configName,
        kind: "spend",
        amount,
        balanceAfter: nextBalance,
        note: input.note,
        createdAt: Date.now(),
    };
    appendLedger([entry]);
    return { account, entry };
}

/** 改账户设置（阈值 / 备注 / 自动扣费开关 / 记账口径） */
export function updateAccountSettings(
    accountId: string,
    patch: { lowThreshold?: number; note?: string; autoCharge?: boolean; billingMode?: "per_call" | "per_task" }
): ApiAccount {
    const current = getApiAccount(accountId);
    const threshold = Number(patch.lowThreshold);
    return writeAccount({
        ...current,
        lowThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : undefined,
        note: typeof patch.note === "string" ? (patch.note.trim() || undefined) : current.note,
        autoCharge: typeof patch.autoCharge === "boolean" ? patch.autoCharge : current.autoCharge,
        billingMode: patch.billingMode === "per_task" || patch.billingMode === "per_call"
            ? patch.billingMode
            : current.billingMode,
    });
}

/**
 * 该账户是否启用「一个任务只算一笔」。
 * 默认 false（= per_call）：每次真实调用各记一笔，账本最贴近中转站的真实消耗。
 * 只有用户明确把单价当「任务包价」用时才该开。
 */
export function isTaskBillingEnabled(accountId?: string): boolean {
    return getApiAccount(accountId).billingMode === "per_task";
}

/** 流水查询（新→旧） */
export function listLedger(accountId?: string, limit = 30): ApiLedgerEntry[] {
    const entries = loadApiLedger();
    const filtered = typeof accountId === "string"
        ? entries.filter(entry => entry.accountId === accountId)
        : entries;
    return filtered.slice(0, Math.max(1, limit));
}

/** 指定时间窗内的消耗合计（只统计 spend） */
export function spentSince(accountId: string | undefined, sinceMs: number): number {
    const entries = loadApiLedger();
    let total = 0;
    for (const entry of entries) {
        if (entry.createdAt < sinceMs) break;
        if (entry.kind !== "spend") continue;
        if (typeof accountId === "string" && entry.accountId !== accountId) continue;
        total += entry.amount;
    }
    return roundAmount(total);
}

export function spentToday(accountId?: string): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return spentSince(accountId, start.getTime());
}

/** 重命名/删除文件夹不会动账户，但要能列出「有余额但文件夹已不在」的孤儿账户 */
export function listOrphanAccounts(): ApiAccount[] {
    const groupIds = new Set(loadApiGroups().map(group => group.id));
    return loadApiAccounts().filter(account => account.id && !groupIds.has(account.id));
}

/** 清空某个账户的流水（余额保留） */
export function clearLedger(accountId?: string): void {
    if (typeof accountId !== "string") {
        saveApiLedger([]);
        notifyApiAccountsUpdated();
        return;
    }
    saveApiLedger(loadApiLedger().filter(entry => entry.accountId !== accountId));
    notifyApiAccountsUpdated();
}

/** 给「按当前选中的 API」快速算一笔：返回账户与建议金额 */
export function quoteForConfig(config?: ApiConfig | null, quantity = 1): { accountId: string; pricing?: ApiPricing; amount: number } {
    const accountId = accountIdForConfig(config);
    const pricing = config?.pricing;
    return { accountId, pricing, amount: estimateCost(pricing, quantity) };
}

/** 当前全局默认 API 与它所属账户（特调等界面用来判断「现在花的是哪个账户的钱」） */
export function resolveDefaultAccount(): { accountId: string; configId?: string; configName?: string } {
    const bindings = loadBindingConfig();
    const configs = loadApiConfigs();
    const boundId = bindings.globalDefaults?.apiConfigId;
    const config = boundId ? configs.find(item => item.id === boundId) : undefined;
    if (!config) return { accountId: API_UNGROUPED_ACCOUNT_ID };
    return {
        accountId: accountIdForConfig(config),
        configId: config.id,
        configName: config.name || config.defaultModel || config.provider,
    };
}

/* ------------------------------------------------------------------
 * 自动扣费：一次成功的 LLM 调用 → 按该 API 的单价从所属账户扣一笔
 * ------------------------------------------------------------------ */

/** 各 provider 的 usage 形状（OpenAI / Anthropic / Gemini 已在上游统一成这套字段） */
export type LlmUsageLike = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
} | null | undefined;

export function usageTotalTokens(usage?: LlmUsageLike): number {
    if (!usage) return 0;
    const total = Number(usage.total_tokens);
    if (Number.isFinite(total) && total > 0) return total;
    const prompt = Number(usage.prompt_tokens);
    const completion = Number(usage.completion_tokens);
    const sum = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
    return sum > 0 ? sum : 0;
}

export type LlmSpendResult = {
    /** 是否真的扣了一笔 */
    recorded: boolean;
    amount: number;
    /** 没扣的原因（未设单价 / 仅参考 / 关闭自动扣费 / 没有用量…） */
    reason?: string;
    account?: ApiAccount;
};

/* ------------------------------------------------------------------
 * 扣费可见性：每次自动扣费往外播一条提示（节流合并，避免多轮调用刷屏）
 * ------------------------------------------------------------------ */

let spendNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSpendAmount = 0;
let pendingSpendConfig = "";
let pendingSpendBalance = 0;
/** 「没设单价」每个 API 10 分钟只唠叨一次 */
const pricingWarnedAt = new Map<string, number>();

/** 任务级计费挂起深度：>0 时 recordLlmSpend 只累计不扣，等任务结束一次性结算 */
let taskBillingDepth = 0;
let taskCallCount = 0;
let taskTokenTotal = 0;

function dispatchGlobalNotice(message: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
}

/** 一次对话常有多轮调用，1.2s 内的合并成一条 */
function queueSpendNotice(configName: string, amount: number, balance: number): void {
    if (typeof window === "undefined") return;
    pendingSpendAmount = roundAmount(pendingSpendAmount + amount);
    pendingSpendConfig = configName;
    pendingSpendBalance = balance;
    if (spendNoticeTimer) return;
    spendNoticeTimer = setTimeout(() => {
        spendNoticeTimer = null;
        const total = pendingSpendAmount;
        const configName = pendingSpendConfig;
        const balance = pendingSpendBalance;
        pendingSpendAmount = 0;
        const text = `已扣 ${total}（${configName}）· 剩 ${balance}`;
        // 结构化事件：桌宠小窗这类会遮住顶部全局提示的界面，自己就地渲染
        window.dispatchEvent(new CustomEvent<LlmSpendNoticeDetail>(LLM_SPEND_NOTICE_EVENT, {
            detail: { amount: total, configName, balance, text },
        }));
        dispatchGlobalNotice(text);
    }, 1200);
}

/** 「没设单价」是没记账的头号原因，点名提示一次，省得用户以为是功能坏了 */
export function warnMissingPricing(configName: string, configId: string): void {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const last = pricingWarnedAt.get(configId) ?? 0;
    if (now - last < 600000) return;
    pricingWarnedAt.set(configId, now);
    dispatchGlobalNotice(`「${configName}」没设单价，这次没记账 —— 去设置 → API 填「单价」`);
}

/**
 * 调用成功后自动记账。
 *
 * 口径：
 * - `per_call`：扣一次单价；
 * - `per_1k_tokens`：扣 单价 × total_tokens/1000（**拿不到用量就不扣**，宁可不记也不乱记）；
 * - `manual`：单价只是参考值，跳过（这种配置就该走「记一笔」手填）；
 * - 账户关掉了自动扣费、或配置没设单价：跳过。
 *
 * 本函数绝不应影响主流程 —— 调用方要把它包在 try/catch 里。
 */
export function recordLlmSpend(config: ApiConfig | null | undefined, usage?: LlmUsageLike): LlmSpendResult {
    if (!config) return { recorded: false, amount: 0, reason: "没有 API 配置" };
    // 任务级计费挂起中：只累计，不扣 —— 由 settleTaskBilling 在任务结束时按一次结算
    if (taskBillingDepth > 0) {
        taskCallCount += 1;
        taskTokenTotal += usageTotalTokens(usage);
        return { recorded: false, amount: 0, reason: "任务内调用（延后到任务结束结算）" };
    }
    const displayName = config.name || config.defaultModel || config.provider;
    const pricing = config.pricing;
    if (!pricing || !Number.isFinite(pricing.amount) || pricing.amount <= 0) {
        warnMissingPricing(displayName, config.id);
        return { recorded: false, amount: 0, reason: "未设单价" };
    }
    if (pricing.mode === "manual") {
        return { recorded: false, amount: 0, reason: "单价仅参考，不自动扣" };
    }
    const accountId = accountIdForConfig(config);
    const account = getApiAccount(accountId);
    if (account.autoCharge === false) {
        return { recorded: false, amount: 0, reason: "该账户已关闭自动扣费" };
    }
    let quantity = 1;
    let note = "自动扣费 · 按次";
    if (pricing.mode === "per_1k_tokens") {
        const tokens = usageTotalTokens(usage);
        if (tokens <= 0) return { recorded: false, amount: 0, reason: "本次没有用量数据" };
        // estimateCost 对 per_1k_tokens 的入参就是 token 数（内部再除 1000），这里不要自己先除
        quantity = tokens;
        note = `自动扣费 · ${tokens} tok`;
    }
    const amount = estimateCost(pricing, quantity);
    if (amount <= 0) return { recorded: false, amount: 0, reason: "算出金额为 0" };
    const result = spendFromAccount({
        accountId,
        amount,
        configId: config.id,
        configName: displayName,
        note,
    });
    queueSpendNotice(displayName, amount, result.account.balance);
    return { recorded: true, amount, account: result.account };
}

/* ------------------------------------------------------------------
 * 任务级计费：卷宝一次任务内的多轮调用先挂起，任务结束按「一次任务」结算
 * ------------------------------------------------------------------ */

/**
 * 开始一个「任务」的计费挂起区。
 *
 * 卷宝一个任务（用户发一句话触发的整段 agent loop）内部往往要调 3~6 次，
 * 逐次扣费等于让你为一句吩咐付好几份钱；挂起后改为任务结束时按一次单价结算。
 * 支持嵌套：内层结束不会提前把外层的账结掉。
 */
export function beginTaskBilling(): void {
    taskBillingDepth += 1;
    if (taskBillingDepth === 1) {
        taskCallCount = 0;
        taskTokenTotal = 0;
    }
}

export function endTaskBilling(): void {
    taskBillingDepth = Math.max(0, taskBillingDepth - 1);
}

/** 是否仍在某个任务的计费挂起区内（外层任务还没结束） */
export function isTaskBillingActive(): boolean {
    return taskBillingDepth > 0;
}

export function getTaskBillingStats(): { calls: number; tokens: number } {
    return { calls: taskCallCount, tokens: taskTokenTotal };
}

/**
 * 任务结束时结算。
 * - `per_call`：**只扣一次单价**，不管内部调了几轮 —— 这是「一个任务一笔钱」的实现；
 * - `per_1k_tokens`：按任务累计的真实 token 扣（本来就与轮数无关）；
 * - `manual` / 未设单价 / 关闭自动扣费：跳过。
 *
 * 先取数再清零，异常时也不会重复结算同一笔。
 */
export function settleTaskBilling(config: ApiConfig | null | undefined): LlmSpendResult {
    const calls = taskCallCount;
    const tokens = taskTokenTotal;
    taskCallCount = 0;
    taskTokenTotal = 0;
    if (!config || calls === 0) return { recorded: false, amount: 0, reason: "本次任务没有调用" };
    const displayName = config.name || config.defaultModel || config.provider;
    const pricing = config.pricing;
    if (!pricing || !Number.isFinite(pricing.amount) || pricing.amount <= 0) {
        warnMissingPricing(displayName, config.id);
        return { recorded: false, amount: 0, reason: "未设单价" };
    }
    if (pricing.mode === "manual") return { recorded: false, amount: 0, reason: "单价仅参考，不自动扣" };
    const accountId = accountIdForConfig(config);
    if (getApiAccount(accountId).autoCharge === false) {
        return { recorded: false, amount: 0, reason: "该账户已关闭自动扣费" };
    }
    const amount = pricing.mode === "per_1k_tokens"
        ? estimateCost(pricing, tokens)
        : estimateCost(pricing, 1);
    if (amount <= 0) return { recorded: false, amount: 0, reason: "算出金额为 0" };
    const result = spendFromAccount({
        accountId,
        amount,
        configId: config.id,
        configName: displayName,
        note: pricing.mode === "per_1k_tokens"
            ? `任务结算 · ${calls} 轮 / ${tokens} tok`
            : `任务结算 · ${calls} 轮调用按一次计费`,
    });
    queueSpendNotice(displayName, amount, result.account.balance);
    return { recorded: true, amount, account: result.account };
}
