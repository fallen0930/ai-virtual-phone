import { beforeEach, describe, expect, it, vi } from "vitest";

// 制作规格常驻板（2026-11-12 设计优化 · 机制二）
//
// 规格每类 500~8600 字，原来作为工具回执进历史，下一轮就被 compactToolHistory 折叠成
// 160 字摘要。长正文是分批 append 写的，写到一半规格已从上下文消失，模型只好重读——
// 建一整套副本要 6~10 类规格，每类一轮，加重读，是创建流程最大的 token 黑洞。
// 现在「读取制作说明」把规格写进任务级常驻板（注入系统提示词，不折叠、不占历史窗口），
// 历史里只留一行短回执；支持 kinds 一次读多类；板有总预算，超了淘汰最旧。
// 本文件只 mock 存储层，规格文本走真实 crafting-guides。

import { mixToolReadCraftSpec } from "@/lib/mixology/mascot-tools";
import { buildMixCraftSpecBoardPrompt, pinMixCraftSpecs, resetMixCraftSpecBoard } from "@/lib/mixology/spec-board";
import { buildMixCraftSpec } from "@/lib/mixology/crafting-guides";
import { resetMascotTaskLedger } from "@/lib/mascot-task-ledger";
import type { MixMaterialKind } from "@/lib/mixology/types";

vi.mock("@/lib/mixology/storage", () => ({
    MIX_CABINET_UPDATED_EVENT: "mix-cabinet-updated",
    getMixMaterial: () => null,
    isMixBuiltinId: (id: string) => String(id || "").startsWith("mixbuiltin"),
    listMixBuiltins: () => [],
    loadMixCabinet: () => [],
    loadMixRecipes: () => [],
    saveMixMaterial: () => undefined,
    saveMixRecipe: () => undefined,
    findMixConnector: () => null,
    loadMixConnectors: () => [],
    saveMixConnector: () => undefined,
    deleteMixConnector: () => undefined,
}));

const ALL_KINDS: MixMaterialKind[] = [
    "mechanism", "character", "ticket", "encore", "garnish", "persona", "preface",
    "base", "flavor", "glass", "strength", "checklist", "filter",
];

/** 从真实规格里取一段探针：回执里不该有它，常驻板里必须有它 */
function probeOf(kind: MixMaterialKind): string {
    const spec = buildMixCraftSpec(kind);
    return spec.slice(100, 180);
}

describe("读取制作说明：pin 进常驻板，回执只留一行", () => {
    beforeEach(() => {
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("单类：回执短、不含规格正文；规格全文进常驻板", () => {
        const result = mixToolReadCraftSpec({ kind: "ticket" });
        expect(result.success, String(result.error ?? "")).toBe(true);
        const receipt = String(result.data ?? "");
        expect(receipt.length).toBeLessThan(400);
        expect(receipt).toContain("常驻");
        expect(receipt).toMatch(/不用重读|不必重读|无需重读/);
        expect(receipt).not.toContain(probeOf("ticket"));

        const board = buildMixCraftSpecBoardPrompt();
        expect(board).toContain(buildMixCraftSpec("ticket"));
        expect(board).toContain("本轮常驻");
    });

    it("kinds 一次读多类：一轮拿齐，不用每类各调一次", () => {
        const result = mixToolReadCraftSpec({ kinds: ["character", "ticket"] });
        expect(result.success, String(result.error ?? "")).toBe(true);
        const board = buildMixCraftSpecBoardPrompt();
        expect(board).toContain(probeOf("character"));
        expect(board).toContain(probeOf("ticket"));
    });

    it("同一类重读不重复堆叠，常驻板里只有一份", () => {
        mixToolReadCraftSpec({ kind: "ticket" });
        mixToolReadCraftSpec({ kind: "ticket" });
        const board = buildMixCraftSpecBoardPrompt();
        const probe = probeOf("ticket");
        expect(board.split(probe).length - 1).toBe(1);
    });

    it("缺 kind/kinds 或种类非法时报错并列出可选项，不 pin 任何东西", () => {
        expect(mixToolReadCraftSpec({}).success).toBe(false);
        expect(mixToolReadCraftSpec({ kind: "nope" }).success).toBe(false);
        const bad = mixToolReadCraftSpec({ kinds: ["ticket", "nope"] });
        expect(bad.success).toBe(false);
        expect(String(bad.error ?? "")).toContain("ticket");
        expect(buildMixCraftSpecBoardPrompt()).toBe("");
    });

    it("reset 清空常驻板（每条用户消息 = 一轮新任务）", () => {
        mixToolReadCraftSpec({ kind: "ticket" });
        expect(buildMixCraftSpecBoardPrompt()).not.toBe("");
        resetMixCraftSpecBoard();
        expect(buildMixCraftSpecBoardPrompt()).toBe("");
    });
});

describe("常驻板预算：超了淘汰最旧，别把系统提示词塞爆", () => {
    beforeEach(() => {
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("13 类全 pin 也不会超过预算，最后 pin 的保留", () => {
        const { evicted } = pinMixCraftSpecs(ALL_KINDS);
        expect(evicted.length).toBeGreaterThan(0);
        const board = buildMixCraftSpecBoardPrompt();
        // 预算 12000 + 段落标题/种类标签的少量开销
        expect(board.length).toBeLessThanOrEqual(12000 + 600);
        expect(board).toContain(probeOf("filter"));
    });

    it("重读已淘汰的旧类会把它救回来，挤掉的是此刻最旧的（LRU）", () => {
        pinMixCraftSpecs(ALL_KINDS);
        // mechanism 最先 pin、最大，第一轮被淘汰；重读它应当回来
        const before = buildMixCraftSpecBoardPrompt();
        expect(before).not.toContain(probeOf("mechanism"));

        mixToolReadCraftSpec({ kind: "mechanism" });
        const after = buildMixCraftSpecBoardPrompt();
        expect(after).toContain(probeOf("mechanism"));
        // character 是此时最旧的，应当被挤出去
        expect(after).not.toContain(probeOf("character"));
        expect(after.length).toBeLessThanOrEqual(12000 + 600);
    });

    it("淘汰发生时回执要明说，别让模型以为规格还在", () => {
        const result = mixToolReadCraftSpec({ kinds: ALL_KINDS });
        expect(result.success).toBe(true);
        expect(String(result.data ?? "")).toMatch(/挤出|淘汰/);
    });
});