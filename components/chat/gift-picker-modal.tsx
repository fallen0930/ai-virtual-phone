"use client";

import { useMemo, useState } from "react";
import { Gift, PackageCheck, Search, UserRound, X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import type { ShoppingGiftCandidate } from "@/lib/shopping-gift-utils";

type GiftPickerModalProps = {
    gifts: ShoppingGiftCandidate[];
    isGroup?: boolean;
    recipients?: Character[];
    onSend: (gift: ShoppingGiftCandidate, recipient?: Character) => void;
    onClose: () => void;
};

function normalizeSearchText(value: string): string {
    return value.trim().toLowerCase();
}

export function GiftPickerModal({ gifts, isGroup, recipients = [], onSend, onClose }: GiftPickerModalProps) {
    const [query, setQuery] = useState("");
    const [selectedGiftId, setSelectedGiftId] = useState(gifts[0]?.id ?? "");
    const [selectedRecipientId, setSelectedRecipientId] = useState(recipients[0]?.id ?? "");

    const filteredGifts = useMemo(() => {
        const normalized = normalizeSearchText(query);
        if (!normalized) return gifts;
        return gifts.filter(gift => [
            gift.productName,
            gift.merchantLabel,
            gift.subtitle,
            gift.detail,
            gift.priceLabel,
        ].some(field => field.toLowerCase().includes(normalized)));
    }, [gifts, query]);

    const selectedGift = filteredGifts.find(gift => gift.id === selectedGiftId) ?? filteredGifts[0] ?? null;
    const selectedRecipient = recipients.find(recipient => recipient.id === selectedRecipientId);
    const canSend = Boolean(selectedGift && (!isGroup || selectedRecipient));

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="w-[340px] max-w-[calc(100vw-32px)] max-h-[78vh] rounded-[24px] text-[var(--c-text)] overflow-hidden flex flex-col"
                style={{
                    background: "linear-gradient(180deg, var(--c-card) 0%, color-mix(in srgb, var(--c-input) 42%, var(--c-card)) 100%)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.24)",
                }}
            >
                <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <div
                            className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ background: "color-mix(in srgb, var(--c-success) 14%, var(--c-input))" }}
                        >
                            <Gift size={19} strokeWidth={1.8} />
                        </div>
                        <div className="min-w-0">
                            <div className="ts-16 font-semibold">送出礼物</div>
                            <div className="ts-11 text-[var(--c-icon)] truncate">来自已到货购物订单</div>
                        </div>
                    </div>
                    <button
                        type="button"
                        aria-label="关闭"
                        onClick={onClose}
                        className="w-9 h-9 rounded-full bg-[var(--c-input)] flex items-center justify-center"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="p-4 flex flex-col gap-3 overflow-hidden">
                    {isGroup && (
                        <div className="flex flex-col gap-2">
                            <div className="ts-12 text-[var(--c-icon)]">送给</div>
                            <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
                                {recipients.map(recipient => {
                                    const selected = recipient.id === selectedRecipientId;
                                    return (
                                        <button
                                            key={recipient.id}
                                            type="button"
                                            onClick={() => setSelectedRecipientId(recipient.id)}
                                            className="h-9 px-3 rounded-full flex items-center gap-1.5 shrink-0 ts-12"
                                            style={{
                                                background: selected ? "color-mix(in srgb, var(--c-success) 18%, var(--c-input))" : "color-mix(in srgb, var(--c-input) 82%, transparent)",
                                                color: selected ? "var(--c-success)" : "var(--c-text)",
                                                boxShadow: selected ? "0 8px 18px color-mix(in srgb, var(--c-success) 14%, transparent)" : "none",
                                            }}
                                        >
                                            <UserRound size={14} />
                                            <span>{recipient.name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div
                        className="h-11 rounded-2xl bg-[var(--c-input)] px-3 flex items-center gap-2"
                        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)" }}
                    >
                        <Search size={15} className="text-[var(--c-icon)] shrink-0" />
                        <input
                            value={query}
                            onChange={event => setQuery(event.target.value)}
                            placeholder="搜索已到货商品"
                            className="flex-1 min-w-0 bg-transparent border-none outline-none ts-13 text-[var(--c-text)]"
                        />
                    </div>

                    <div className="overflow-y-auto hide-scrollbar flex flex-col gap-2 pr-0.5" style={{ maxHeight: "330px" }}>
                        {filteredGifts.length === 0 ? (
                            <div className="rounded-2xl bg-[var(--c-input)]/70 px-4 py-8 text-center">
                                <PackageCheck size={28} className="mx-auto mb-2 text-[var(--c-icon)]" />
                                <div className="ts-13 font-medium">暂无可送礼物</div>
                                <div className="ts-12 text-[var(--c-icon)] mt-1 leading-5">
                                    购物订单到货后会出现在这里。
                                </div>
                            </div>
                        ) : filteredGifts.map(gift => {
                            const selected = gift.id === selectedGift?.id;
                            return (
                                <button
                                    key={gift.id}
                                    type="button"
                                    onClick={() => setSelectedGiftId(gift.id)}
                                    className="w-full rounded-2xl p-3 text-left flex gap-3 transition-transform active:scale-[0.99]"
                                    style={{
                                        background: selected ? "color-mix(in srgb, var(--c-success) 16%, var(--c-input))" : "color-mix(in srgb, var(--c-input) 88%, var(--c-card))",
                                        boxShadow: selected
                                            ? "0 12px 26px color-mix(in srgb, var(--c-success) 16%, transparent)"
                                            : "0 8px 18px rgba(0,0,0,0.035)",
                                    }}
                                >
                                    <div
                                        className="w-14 h-14 rounded-2xl bg-[var(--c-card)] flex items-center justify-center ts-24 shrink-0"
                                        style={{ boxShadow: "0 6px 16px rgba(0,0,0,0.05)" }}
                                    >
                                        {gift.previewIcon || <Gift size={22} />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="ts-14 font-semibold truncate">{gift.productName}</div>
                                        <div className="ts-12 text-[var(--c-icon)] mt-1 truncate">
                                            {gift.merchantLabel} · {gift.quantityLabel}
                                        </div>
                                        <div className="ts-12 mt-2 flex items-center justify-between gap-2">
                                            <span className="font-semibold text-[var(--c-success)]">{gift.priceLabel}</span>
                                            <span className="text-[var(--c-icon)] truncate">{gift.deliveredTimeLabel || "已到货"}</span>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="px-4 pb-4 pt-2 flex gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-11 rounded-2xl flex-1 ts-14 font-semibold text-[var(--c-text)]"
                        style={{ background: "color-mix(in srgb, var(--c-input) 82%, transparent)" }}
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        disabled={!canSend}
                        onClick={() => {
                            if (!selectedGift) return;
                            onSend(selectedGift, selectedRecipient);
                        }}
                        className="h-11 rounded-2xl flex-1 ts-14 font-semibold text-white disabled:opacity-45"
                        style={{ background: "var(--c-success)" }}
                    >
                        送出
                    </button>
                </div>
            </div>
        </div>
    );
}
