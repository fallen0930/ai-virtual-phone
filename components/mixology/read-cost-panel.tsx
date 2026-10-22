"use client";

// 独家特调 · 读取清单 + token 成本
//
// 在配方编辑器（吧台）里，一眼看清「我这杯的每一味材料，AI 到底读没读、各占多少 token」。
//
// 读取口径（编辑器里没有正在进行的对局，条件只能按「有没有写条件」判断）：
//  - 不进提示词的几种（外观/滤网/机括）：永不占上下文，标「不进提示词」。
//  - 择一槽（角色卡/面具/序言）：只有第一件被读，其余标「未启用（择一·仅首件）」。
//  - 累加槽（基底/风味/杯型/苦精/小票/尾调/核对）：没设条件的「始终生效」，
//    设了条件的「条件生效时读取」（回合里的真实条件依赖轮数/变量/关键词，编辑期看不出）。
//
// token 用 lib/token-counter 的离线轻量估算（CJK≈1.5 字/token，Latin≈4 字/token）。

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Receipt } from "lucide-react";
import {
    MIX_KIND_LABELS,
    MIX_SLOT_ORDER,
    MIX_SLOT_STACK,
    type MixMaterial,
    type MixMaterialKind,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { describeMixCondition } from "@/lib/mixology/state";
import { estimateTokens } from "@/lib/token-counter";

/** 这几类不进提示词：只占界面 / 清洗正文 / 沙盒逻辑，不吃上下文 */
const NO_PROMPT_KINDS: MixMaterialKind[] = ["garnish", "filter", "mechanism"];

type ReadTone = "read" | "cond" | "off" | "none";

type ReadStatus = { tone: ReadTone; label: string };

function readStatusOf(kind: MixMaterialKind, index: number, entry: MixSlotEntry): ReadStatus {
    if (NO_PROMPT_KINDS.includes(kind)) return { tone: "none", label: "不进提示词" };
    if (MIX_SLOT_STACK[kind] === "first") {
        return index === 0
            ? { tone: "read", label: "已读取（择一·首件）" }
            : { tone: "off", label: "未启用（择一槽·仅首件生效）" };
    }
    // 累加槽
    if (!entry.when) return { tone: "read", label: "已读取（始终生效）" };
    return { tone: "cond", label: `条件生效时读取：${describeMixCondition(entry.when)}` };
}

/** 一件材料送进提示词的那段正文（用来估算 token；渲染代码 / CSS 不进提示词） */
function promptTextOf(material: MixMaterial): string {
    switch (material.kind) {
        case "character": {
            const parts: string[] = [];
            if (material.profileMode === "freeform") {
                parts.push(material.profileText ?? "", material.worldText ?? "");
            } else {
                parts.push(
                    material.baseInfo ?? "", material.personality ?? "", material.appearance ?? "",
                    material.background ?? "", material.worldview ?? "", material.cognition ?? "",
                    material.relations ?? "", material.plot ?? "", material.extra ?? "",
                );
            }
            parts.push((material.openings ?? []).join("\n"), (material.examples ?? []).map((e) => e.text).join("\n"));
            return parts.filter(Boolean).join("\n");
        }
        case "persona":
            return `${material.userName ?? ""}\n${material.content}`;
        case "preface":
        case "base":
        case "flavor":
        case "glass":
        case "strength":
        case "checklist":
            return (material as { content: string }).content;
        case "ticket":
            return material.contract; // 渲染代码不进提示词
        case "encore":
            return material.contract ?? ""; // 没契约 = 纯静态小品，不进提示词
        default:
            return ""; // 外观 / 滤网 / 机括
    }
}

/** 一件材料的提示词 token 估算（含一点段标题 / 壳标记的结构开销） */
function tokenOf(material: MixMaterial): number {
    const text = promptTextOf(material);
    if (!text.trim()) return 0;
    return estimateTokens(text) + 4;
}

type Row = {
    kind: MixMaterialKind;
    index: number;
    material: MixMaterial;
    status: ReadStatus;
    tokens: number;
};

export function MixReadCostPanel({
    slots,
    resolve,
}: {
    slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>>;
    resolve: (id: string) => MixMaterial | null;
}) {
    const [open, setOpen] = useState(true);

    const { rows, alwaysTokens, condTokens } = useMemo(() => {
        const list: Row[] = [];
        let always = 0;
        let cond = 0;
        for (const kind of MIX_SLOT_ORDER) {
            const entries = slots[kind] ?? [];
            entries.forEach((entry, index) => {
                const material = resolve(entry.materialId);
                if (!material) return;
                const status = readStatusOf(kind, index, entry);
                const tokens = tokenOf(material);
                if (status.tone === "read") always += tokens;
                else if (status.tone === "cond") cond += tokens;
                list.push({ kind, index, material, status, tokens });
            });
        }
        return { rows: list, alwaysTokens: always, condTokens: cond };
    }, [slots, resolve]);

    const totalAll = alwaysTokens + condTokens;
    const hasContent = rows.length > 0;

    return (
        <div className="mix-rc">
            <button type="button" className="mix-rc-head" onClick={() => setOpen((v) => !v)}>
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Receipt size={15} />
                <span className="mix-rc-title">读取清单 · token 成本</span>
                <span className="mix-rc-summary">
                    必读 ≈ {alwaysTokens}
                    {condTokens > 0 ? ` · 条件内 +${condTokens}` : ""}
                </span>
            </button>
            {open ? (
                <div className="mix-rc-body">
                    <div className="mix-rc-note">
                        离线轻量估算（CJK≈1.5 字/token）。「必读」= 无条件也一定进提示词的部分；「条件内」= 写了生效条件、按回合条件才上场的部分。
                    </div>
                    {!hasContent ? (
                        <div className="mix-rc-empty">吧台还空着，挑几味材料后这里会列出每味的读取情况与 token。</div>
                    ) : (
                        <div className="mix-rc-list">
                            {rows.map((row, i) => {
                                const tone = row.status.tone;
                                return (
                                    <div className="mix-rc-row" key={`${row.kind}-${row.index}-${i}`}>
                                        <div className="mix-rc-row-main">
                                            <span className="mix-rc-kind">{MIX_KIND_LABELS[row.kind]}</span>
                                            <span className="mix-rc-name">{row.material.name}</span>
                                            {row.tokens > 0 ? (
                                                <span className="mix-rc-tok">{row.tokens} tok</span>
                                            ) : (
                                                <span className="mix-rc-tok" data-zero="true">—</span>
                                            )}
                                        </div>
                                        <div className="mix-rc-status" data-tone={tone}>
                                            {tone === "read" ? <Eye size={13} /> : tone === "none" ? <EyeOff size={13} /> : null}
                                            {row.status.label}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <div className="mix-rc-foot">
                        <span>必读 ≈ <b>{alwaysTokens}</b></span>
                        {condTokens > 0 ? <span>条件内 ≈ <b>{condTokens}</b></span> : null}
                        <span>读满 ≈ <b>{totalAll}</b> token</span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
