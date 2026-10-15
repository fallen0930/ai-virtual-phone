"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Coins, Pencil, Receipt, Wallet, X } from "lucide-react";
import type { ApiAccount, ApiConfig, ApiGroup, ApiLedgerEntry, ApiPricingMode } from "@/lib/settings-types";
import {
    API_ACCOUNTS_UPDATED_EVENT,
    accountLabel,
    estimateCost,
    getApiAccount,
    isAccountLow,
    listLedger,
    pricingLabel,
    pricingModeLabel,
    setAccountBalance,
    spendFromAccount,
    spentToday,
    topUpAccount,
    updateAccountSettings,
} from "@/lib/api-accounts";
import { loadApiConfigs, loadApiGroups } from "@/lib/settings-storage";

type PanelView = "overview" | "charge" | "balance" | "settings";

function fmt(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return "0";
    const fixed = value.toFixed(digits);
    return digits > 0 ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function hhmm(ts: number): string {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(ts: number): string {
    const date = new Date(ts);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay ? "今天" : `${date.getMonth() + 1}/${date.getDate()}`;
}

function parseNumber(raw: string): number {
    const cleaned = String(raw ?? "").replace(/[,，\s]/g, "");
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : NaN;
}

/**
 * 账户面板：余额、充值、记一笔、流水。
 * 三个入口（快捷菜单 / 设置页 / 特调界面）共用这一份实现。
 */
export function ApiAccountPanel({
    accountId,
    onClose,
    initialView = "overview",
    title,
    onNotice,
}: {
    accountId: string;
    onClose?: () => void;
    initialView?: PanelView;
    title?: string;
    /** 记账结果往外播（快捷菜单接成全局提示，让「这一次扣了多少」一眼可见） */
    onNotice?: (message: string) => void;
}) {
    const [account, setAccount] = useState<ApiAccount>(() => getApiAccount(accountId));
    const [groups, setGroups] = useState<ApiGroup[]>([]);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [ledger, setLedger] = useState<ApiLedgerEntry[]>([]);
    const [view, setView] = useState<PanelView>(initialView);
    const [notice, setNotice] = useState("");
    const [draft, setDraft] = useState("");

    const sync = useCallback(() => {
        setAccount(getApiAccount(accountId));
        setGroups(loadApiGroups());
        setConfigs(loadApiConfigs());
        setLedger(listLedger(accountId, 20));
        setDraft(String(getApiAccount(accountId).balance));
    }, [accountId]);

    useEffect(() => {
        sync();
        const handler = () => sync();
        window.addEventListener(API_ACCOUNTS_UPDATED_EVENT, handler);
        return () => window.removeEventListener(API_ACCOUNTS_UPDATED_EVENT, handler);
    }, [sync]);

    useEffect(() => {
        setView(initialView);
    }, [initialView]);

    const accountName = accountLabel(accountId, groups);
    const todaySpent = useMemo(() => spentToday(accountId), [accountId, ledger]);
    const low = isAccountLow(account);

    /* ---- 记一笔表单 ---- */
    const accountConfigs = useMemo(
        () => configs.filter(config => (config.groupId || "") === (accountId || "")),
        [configs, accountId]
    );
    const [chargeConfigId, setChargeConfigId] = useState("");
    const [chargeMode, setChargeMode] = useState<ApiPricingMode>("per_call");
    const [chargeAmount, setChargeAmount] = useState("");
    const [chargeQty, setChargeQty] = useState("1");
    const [chargeNote, setChargeNote] = useState("");

    useEffect(() => {
        if (view !== "charge") return;
        const first = accountConfigs[0];
        setChargeConfigId(first?.id || "");
        setChargeMode(first?.pricing?.mode || "per_call");
        setChargeAmount(first?.pricing ? String(first.pricing.amount) : "");
        setChargeQty("1");
        setChargeNote("");
    }, [view, accountConfigs]);

    useEffect(() => {
        if (view !== "charge") return;
        const picked = accountConfigs.find(config => config.id === chargeConfigId);
        if (!picked) return;
        setChargeMode(picked.pricing?.mode || "per_call");
        setChargeAmount(picked.pricing ? String(picked.pricing.amount) : "");
    }, [chargeConfigId, view, accountConfigs]);

    const chargeUnitPrice = parseNumber(chargeAmount);
    const chargeQuantity = parseNumber(chargeQty);
    const suggestedCharge = Number.isFinite(chargeUnitPrice) && Number.isFinite(chargeQuantity)
        ? estimateCost({ mode: chargeMode, amount: chargeUnitPrice }, chargeQuantity)
        : 0;

    const showNotice = useCallback((text: string) => {
        setNotice(text);
        window.setTimeout(() => setNotice(""), 3600);
    }, []);

    /** 成功类反馈：面板内横幅 + 往外播一条全局提示（余额/流水变化本身由事件驱动自动刷新） */
    const announce = useCallback((text: string) => {
        showNotice(text);
        if (onNotice) onNotice(text);
    }, [onNotice, showNotice]);

    const commitCharge = useCallback(() => {
        const amount = suggestedCharge;
        if (!Number.isFinite(amount) || amount <= 0) {
            showNotice("先填单价和数量");
            return;
        }
        const picked = accountConfigs.find(config => config.id === chargeConfigId);
        const pickedName = picked ? (picked.name || picked.defaultModel || picked.provider) : undefined;
        const result = spendFromAccount({
            accountId,
            amount,
            configId: picked?.id,
            configName: pickedName,
            note: chargeNote.trim() || undefined,
        });
        setView("overview");
        announce(`已扣 ${fmt(amount)}${pickedName ? `（${pickedName}）` : ""}，${accountName} 剩 ${fmt(result.account.balance)}`);
    }, [accountConfigs, accountId, accountName, announce, chargeConfigId, chargeNote, showNotice, suggestedCharge]);

    const commitBalance = useCallback(() => {
        const value = parseNumber(draft);
        if (!Number.isFinite(value)) {
            showNotice("请填数字");
            return;
        }
        const result = setAccountBalance(accountId, value, { note: "手动设定余额" });
        setView("overview");
        announce(`${accountName} 余额已更新为 ${fmt(result.account.balance)}`);
    }, [accountId, accountName, announce, draft, showNotice]);

    const [thresholdDraft, setThresholdDraft] = useState(account.lowThreshold ? String(account.lowThreshold) : "");
    useEffect(() => {
        setThresholdDraft(account.lowThreshold ? String(account.lowThreshold) : "");
    }, [account.lowThreshold]);

    const commitSettings = useCallback(() => {
        const threshold = parseNumber(thresholdDraft);
        updateAccountSettings(accountId, {
            lowThreshold: Number.isFinite(threshold) ? threshold : 0,
        });
        setView("overview");
        announce(`${accountName} 账户设置已保存`);
    }, [accountId, accountName, announce, thresholdDraft]);

    return (
        <div className="apiacct" data-view={view}>
            <div className="apiacct-head">
                <div className="apiacct-head-main">
                    <span className="apiacct-head-icon"><Wallet size={16} /></span>
                    <div>
                        <strong>{title || accountName}</strong>
                        <small>{title ? accountName : "API 账户"}{account.note ? ` · ${account.note}` : ""}</small>
                    </div>
                </div>
                {onClose ? (
                    <button type="button" className="apiacct-icon-btn" onClick={onClose} aria-label="关闭">
                        <X size={16} />
                    </button>
                ) : null}
            </div>

            {view === "overview" ? (
                <>
                    <div className="apiacct-balance" data-low={low ? "true" : undefined}>
                        <div className="apiacct-balance-value">{fmt(account.balance)}</div>
                        <div className="apiacct-balance-sub">剩余额度{account.note ? ` · ${account.note}` : ""}</div>
                        {low ? <div className="apiacct-balance-warn">低于提醒阈值 {fmt(account.lowThreshold || 0, 0)}</div> : null}
                    </div>

                    <div className="apiacct-stats">
                        <div>
                            <span>今日消耗</span>
                            <b>{todaySpent > 0 ? fmt(todaySpent) : "—"}</b>
                        </div>
                        <div>
                            <span>累计流水</span>
                            <b>{ledger.length} 条</b>
                        </div>
                    </div>

                    {account.autoCharge === false ? (
                        <div className="apiacct-hint apiacct-hint-warn">自动扣费已关闭：调用后不会自动记账，得点「记一笔」手动扣。</div>
                    ) : null}

                    <div className="apiacct-actions">
                        <button type="button" className="apiacct-btn apiacct-btn-primary" onClick={() => setView("charge")}>
                            <Receipt size={14} />手动记一笔
                        </button>
                        <button type="button" className="apiacct-btn" onClick={() => { setDraft(String(account.balance)); setView("balance"); }}>
                            <Pencil size={14} />改余额
                        </button>
                        <button type="button" className="apiacct-btn" onClick={() => {
                            const result = topUpAccount(accountId, 100, "快捷充值 100");
                            announce(`${accountName} 已 +100，现 ${fmt(result.account.balance)}`);
                        }}>
                            <Coins size={14} />+100
                        </button>
                        <button type="button" className="apiacct-btn" onClick={() => setView("settings")}>
                            账户设置
                        </button>
                    </div>

                    <div className="apiacct-ledger-title">最近流水</div>
                    <div className="apiacct-ledger">
                        {ledger.length === 0 ? (
                            <div className="apiacct-empty">还没有账目：点「记一笔」扣一次，或「改余额」把当前余额写进来</div>
                        ) : ledger.map(entry => (
                            <div className="apiacct-row" key={entry.id} data-kind={entry.kind}>
                                <span className="apiacct-row-time">{dayLabel(entry.createdAt)} {hhmm(entry.createdAt)}</span>
                                <span className="apiacct-row-main">
                                    {entry.kind === "spend" ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
                                    <span className="apiacct-row-label">
                                        {entry.kind === "spend"
                                            ? (entry.configName || "消耗")
                                            : entry.kind === "topup" ? "充值" : "改余额"}
                                        {entry.note ? ` · ${entry.note}` : ""}
                                    </span>
                                </span>
                                <span className="apiacct-row-amount" data-kind={entry.kind}>
                                    {entry.kind === "spend" ? "-" : "+"}{fmt(entry.amount)}
                                </span>
                                <span className="apiacct-row-after">{fmt(entry.balanceAfter)}</span>
                            </div>
                        ))}
                    </div>
                </>
            ) : null}

            {view === "charge" ? (
                <div className="apiacct-form">
                    <label className="apiacct-field">
                        <span>哪个 API</span>
                        <select value={chargeConfigId} onChange={event => setChargeConfigId(event.target.value)}>
                            <option value="">不指定</option>
                            {accountConfigs.map(config => (
                                <option key={config.id} value={config.id}>
                                    {(config.name || config.defaultModel || config.provider)}（{pricingLabel(config.pricing)}）
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="apiacct-field">
                        <span>计价方式</span>
                        <select value={chargeMode} onChange={event => setChargeMode(event.target.value as ApiPricingMode)}>
                            {(["per_call", "per_1k_tokens", "manual"] as ApiPricingMode[]).map(mode => (
                                <option key={mode} value={mode}>{pricingModeLabel(mode)}</option>
                            ))}
                        </select>
                    </label>
                    <div className="apiacct-field-row">
                        <label className="apiacct-field">
                            <span>单价（额度）</span>
                            <input value={chargeAmount} inputMode="decimal" placeholder="0.5" onChange={event => setChargeAmount(event.target.value)} />
                        </label>
                        <label className="apiacct-field">
                            <span>{chargeMode === "per_1k_tokens" ? "token 数" : chargeMode === "manual" ? "次数（可忽略）" : "次数"}</span>
                            <input value={chargeQty} inputMode="decimal" onChange={event => setChargeQty(event.target.value)} />
                        </label>
                    </div>
                    <label className="apiacct-field">
                        <span>备注（可选）</span>
                        <input value={chargeNote} placeholder="比如：跑了一轮长对话" onChange={event => setChargeNote(event.target.value)} />
                    </label>
                    <div className="apiacct-summary">
                        本次扣 <b>{fmt(suggestedCharge)}</b> 额度
                        <span>（扣完剩 {fmt(account.balance - suggestedCharge)}）</span>
                    </div>
                    <div className="apiacct-form-btns">
                        <button type="button" className="apiacct-btn" onClick={() => setView("overview")}>取消</button>
                        <button type="button" className="apiacct-btn apiacct-btn-primary" onClick={commitCharge}>
                            <Check size={14} />确认扣费
                        </button>
                    </div>
                </div>
            ) : null}

            {view === "balance" ? (
                <div className="apiacct-form">
                    <label className="apiacct-field">
                        <span>当前剩余额度</span>
                        <input value={draft} inputMode="decimal" autoFocus onChange={event => setDraft(event.target.value)} />
                    </label>
                    <div className="apiacct-hint">把面板上看到的余额填进来，应用会记一条差额流水。</div>
                    <div className="apiacct-form-btns">
                        <button type="button" className="apiacct-btn" onClick={() => setView("overview")}>取消</button>
                        <button type="button" className="apiacct-btn apiacct-btn-primary" onClick={commitBalance}>
                            <Check size={14} />保存
                        </button>
                    </div>
                </div>
            ) : null}

            {view === "settings" ? (
                <div className="apiacct-form">
                    <label className="apiacct-field">
                        <span>低额度提醒阈值（0 = 不提醒）</span>
                        <input value={thresholdDraft} inputMode="decimal" placeholder="0" onChange={event => setThresholdDraft(event.target.value)} />
                    </label>
                    <label className="apiacct-check">
                        <input
                            type="checkbox"
                            checked={account.autoCharge !== false}
                            onChange={event => {
                                updateAccountSettings(accountId, { autoCharge: event.target.checked });
                                announce(event.target.checked ? "已开启：调用成功后自动扣费" : "已关闭自动扣费，之后只能手动记一笔");
                            }}
                        />
                        <span>
                            调用成功后自动扣费
                            <small>按每个 API 自己填的单价扣到本账户；关掉后只能用「记一笔」手动扣</small>
                        </span>
                    </label>
                    <label className="apiacct-field">
                        <span>记账口径</span>
                        <select
                            value={account.billingMode === "per_task" ? "per_task" : "per_call"}
                            onChange={event => {
                                const mode = event.target.value === "per_task" ? "per_task" : "per_call";
                                updateAccountSettings(accountId, { billingMode: mode });
                                announce(mode === "per_task"
                                    ? "已改为「一个任务只算一笔」——账本会比真实消耗偏松"
                                    : "已改为「每次调用各记一笔」——最贴近真实消耗");
                            }}
                        >
                            <option value="per_call">每次调用各记一笔（推荐）</option>
                            <option value="per_task">卷宝一个任务只算一笔</option>
                        </select>
                    </label>
                    <div className="apiacct-hint">
                        中转站是按每次调用真实扣钱的。选「每次调用」时，账本与真实余额的偏差最小；
                        选「一个任务」时，卷宝一次任务内部的多轮调用只记一笔 —— 那是把单价当成「任务包价」在用，余额会比实际消耗偏松。
                    </div>
                    <div className="apiacct-form-btns">
                        <button type="button" className="apiacct-btn" onClick={() => setView("overview")}>取消</button>
                        <button type="button" className="apiacct-btn apiacct-btn-primary" onClick={commitSettings}>
                            <Check size={14} />保存
                        </button>
                    </div>
                </div>
            ) : null}

            {notice ? <div className="apiacct-notice">{notice}</div> : null}
        </div>
    );
}
