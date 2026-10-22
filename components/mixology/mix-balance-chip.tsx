"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wallet } from "lucide-react";
import type { ApiAccount } from "@/lib/settings-types";
import {
    API_ACCOUNTS_UPDATED_EVENT,
    accountIdForConfig,
    accountLabel,
    getApiAccount,
    isAccountLow,
    resolveDefaultAccount,
} from "@/lib/api-accounts";

function fmt(value: number): string {
    const fixed = value.toFixed(2);
    const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
    return trimmed || "0";
}

/**
 * 余额胶囊：常驻显示「当前账户剩余额度」，扣费那一刻在**原地**闪一下「−5」。
 *
 * 设计取向（用户明确要求"明显但别挡内容"）：
 * - 不叠浮层、不占额外版面 —— 就挂在已有的信息行里（对局挂在本局 token 旁边），正文零侵入；
 * - 扣费不靠弹窗提示，而是让数字自己动：胶囊脉冲变色 + −Δ 淡出，读正文时眼角能捕捉到；
 * - 点一下可以打开账户面板看流水。
 */
export function MixBalanceChip({
    accountId,
    baseline,
    extra,
    onClick,
    title,
    className,
}: {
    /** 不传则跟随「全局默认 API 所属账户」 */
    accountId?: string;
    /** 传入进入对局时的余额，胶囊里会多显示「本局 −X」 */
    baseline?: number;
    /** 次要信息（如本局 token）；一旦开始消耗就让位给「本局 −X」 */
    extra?: string;
    onClick?: () => void;
    title?: string;
    className?: string;
}) {
    const [resolvedId, setResolvedId] = useState(accountId ?? "");
    const [account, setAccount] = useState<ApiAccount>(() => getApiAccount(accountId ?? ""));
    const [delta, setDelta] = useState<number | null>(null);
    const prevRef = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const sync = useCallback(() => {
        const id = accountId ?? resolveDefaultAccount().accountId;
        const next = getApiAccount(id);
        const prev = prevRef.current;
        if (prev !== null && next.balance < prev - 0.0001) {
            setDelta(prev - next.balance);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setDelta(null), 2600);
        }
        prevRef.current = next.balance;
        setResolvedId(id);
        setAccount(next);
    }, [accountId]);

    useEffect(() => {
        sync();
        window.addEventListener(API_ACCOUNTS_UPDATED_EVENT, sync);
        return () => {
            window.removeEventListener(API_ACCOUNTS_UPDATED_EVENT, sync);
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [sync]);

    const sessionSpent = typeof baseline === "number" && baseline > account.balance
        ? baseline - account.balance
        : null;
    const low = isAccountLow(account);

    return (
        <button
            type="button"
            className={(className ? className + " " : "") + "mix-balance-chip"}
            data-low={low ? "true" : undefined}
            data-spending={delta !== null ? "true" : undefined}
            onClick={onClick}
            title={title || `${accountLabel(resolvedId)}：点开看余额明细`}
        >
            <Wallet size={13} />
            <span>{fmt(account.balance)}</span>
            {delta !== null ? (
                <em className="mix-balance-delta">−{fmt(delta)}</em>
            ) : sessionSpent !== null ? (
                <small>本局 −{fmt(sessionSpent)}</small>
            ) : extra ? (
                <small>{extra}</small>
            ) : null}
        </button>
    );
}
