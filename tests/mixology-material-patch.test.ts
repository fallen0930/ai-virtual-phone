import { beforeEach, describe, expect, it, vi } from "vitest";

// 小卷「改一句话」不该先读整篇、再把整篇重打一遍。
// 真机日志里建一套特调会跑 40 轮、读取材料 9 次 / 列出酒柜 9 次，角色卡正文 9454 字
// 还会作为 tool 回执每轮重发。这套测试锁住新的编辑协议：按 (id, 字段路径) 定点改、
// 原子落盘、失败自带原文窗口、读取可以只要结构。

import {
    mixToolBuildRecipe,
    mixToolCreateMaterial,
    mixToolPatchMaterial,
    mixToolReadMaterial,
} from "@/lib/mixology/mascot-tools";
import { resetMascotTaskLedger } from "@/lib/mascot-task-ledger";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
    materials: [] as Row[],
    recipes: [] as Row[],
}));

vi.mock("@/lib/mixology/storage", () => ({
    MIX_CABINET_UPDATED_EVENT: "mix-cabinet-updated",
    getMixMaterial: (id: string) => db.materials.find((m) => m.id === id) ?? null,
    isMixBuiltinId: (id: string) => String(id || "").startsWith("mixbuiltin"),
    listMixBuiltins: (kind?: string) => db.materials.filter((m) => String(m.id).startsWith("mixbuiltin") && (!kind || m.kind === kind)),
    loadMixCabinet: () => db.materials.filter((m) => !String(m.id).startsWith("mixbuiltin")),
    loadMixRecipes: () => db.recipes,
    saveMixMaterial: (material: Row) => {
        const index = db.materials.findIndex((m) => m.id === material.id);
        if (index >= 0) db.materials[index] = material;
        else db.materials.push(material);
    },
    saveMixRecipe: (recipe: Row) => {
        const index = db.recipes.findIndex((r) => r.id === recipe.id);
        if (index >= 0) db.recipes[index] = recipe;
        else db.recipes.push(recipe);
    },
    findMixConnector: () => null,
    loadMixConnectors: () => [],
    saveMixConnector: () => undefined,
    deleteMixConnector: () => undefined,
}));

const TAIL = "SENTINEL_TAIL_DO_NOT_LEAK_INTO_OUTLINE";

function createBase(): { id: string; content: string } {
    const content = `第一段：他总是迟到。\n第二段：他从不解释。\n${"铺陈".repeat(600)}${TAIL}`;
    const result = mixToolCreateMaterial({ kind: "base", name: "总纲", content });
    expect(result.success, String(result.error ?? "")).toBe(true);
    const match = String(result.data ?? "").match(/id: (\S+?)）/);
    expect(match).toBeTruthy();
    return { id: String(match?.[1]), content };
}

function materialOf(id: string): Row {
    return db.materials.find((m) => m.id === id) ?? {};
}

function dataOf(result: { data?: unknown }): string {
    return String(result.data ?? "");
}

describe("定点片段编辑", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
    });

    it("find/replace 只输出改动片段，落盘后回执不含整篇正文", () => {
        const { id } = createBase();
        const result = mixToolPatchMaterial({
            id,
            edits: [{ field: "content", find: "他总是迟到", replace: "他准时得像钟表" }],
        });
        expect(result.success, String(result.error ?? "")).toBe(true);
        expect(String(materialOf(id).content)).toContain("他准时得像钟表");
        // 原文 2400+ 字，回执只给摘要 + 字段地图
        expect(dataOf(result).length).toBeLessThan(600);
        expect(dataOf(result)).toContain("原子提交");
    });

    it("单条便捷写法 + append 可以分几轮把长正文续写完", () => {
        const { id } = createBase();
        expect(mixToolPatchMaterial({ id, field: "content", append: "第三段：他开始解释。" }).success).toBe(true);
        expect(mixToolPatchMaterial({ id, field: "content", append: "第四段：解释得很短。" }).success).toBe(true);
        const text = String(materialOf(id).content);
        expect(text).toContain("第三段：他开始解释。\n第四段：解释得很短。");
        // 前面写的内容没被覆盖
        expect(text).toContain("第一段：他总是迟到。");
    });

    it("一批 edits 里有一条失败，整批撤销、库里一个字都没改", () => {
        const { id, content } = createBase();
        const result = mixToolPatchMaterial({
            id,
            edits: [
                { field: "content", find: "第一段", replace: "首段" },
                { field: "content", find: "这句原文里根本不存在", replace: "X" },
            ],
        });
        expect(result.success).toBe(false);
        expect(materialOf(id).content).toBe(content);
        expect(String(result.error ?? "")).toMatch(/第 2 条|附近|原文开头/);
    });

    it("find 匹配多处时要求加长片段或 all:true，不悄悄改错地方", () => {
        const { id, content } = createBase();
        const ambiguous = mixToolPatchMaterial({ id, field: "content", find: "他", replace: "她" });
        expect(ambiguous.success).toBe(false);
        expect(String(ambiguous.error ?? "")).toContain("all:true");
        expect(materialOf(id).content).toBe(content);

        const all = mixToolPatchMaterial({ id, field: "content", find: "他", replace: "她", all: true });
        expect(all.success, String(all.error ?? "")).toBe(true);
        expect(String(materialOf(id).content)).not.toContain("他总是迟到");
    });

    it("失败回执直接给附近原文，不用再回头读全文", () => {
        const { id } = createBase();
        const result = mixToolPatchMaterial({ id, field: "content", find: "第二段：他从来不说", replace: "X" });
        expect(result.success).toBe(false);
        expect(String(result.error ?? "")).toContain("原文第");
        expect(String(result.error ?? "")).toContain("第二段");
    });

    it("锚点插入与字段路径寻址（openings.0）", () => {
        const result = mixToolCreateMaterial({
            kind: "character", name: "阿零", openings: ["原来的一号开场白。"],
        });
        expect(result.success, String(result.error ?? "")).toBe(true);
        const id = String(String(result.data ?? "").match(/id: (\S+?)）/)?.[1] ?? "");
        const inserted = mixToolPatchMaterial({
            id,
            edits: [
                { field: "openings.0", insertAfter: "原来的一号", text: "很长的" },
                { field: "openings.0", append: "补一段。", sep: "" },
            ],
        });
        expect(inserted.success, String(inserted.error ?? "")).toBe(true);
        expect((materialOf(id).openings as string[])[0]).toBe("原来的一号很长的开场白。补一段。");
    });
});

describe("轻量读取", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
    });

    it("mode:outline 只给字段地图，不把 2400 字正文灌进上下文", () => {
        const { id } = createBase();
        const result = mixToolReadMaterial({ id, mode: "outline" });
        expect(result.success, String(result.error ?? "")).toBe(true);
        expect(dataOf(result)).toContain("字段路径");
        expect(dataOf(result)).toContain("content（");
        expect(dataOf(result)).not.toContain(TAIL);
        expect(dataOf(result).length).toBeLessThan(700);
    });

    it("mode:window 只回锚点附近，fields 只取指定字段", () => {
        const { id } = createBase();
        const window = mixToolReadMaterial({ id, mode: "window", anchor: "第二段：他从不解释", radius: 120 });
        expect(dataOf(window)).toContain("第二段：他从不解释");
        expect(dataOf(window)).not.toContain(TAIL);

        const one = mixToolReadMaterial({ id, fields: ["content"] });
        expect(dataOf(one)).toContain(TAIL);
        expect(dataOf(one)).toContain("【content】");
    });
});

describe("批量建副本", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
    });

    it("一次建多件材料，finish:true 按台账自动装槽成杯，全程不用列酒柜", () => {
        const built = mixToolBuildRecipe({
            name: "盛夏暗涌",
            materials: [
                { kind: "character", name: "阿零", openings: ["一条开场白。"] },
                { kind: "base", name: "总纲", content: "扮演总纲。" },
                { kind: "flavor", name: "文风", content: "克制的文风。" },
            ],
        });
        expect(built.success, String(built.error ?? "")).toBe(true);
        expect(dataOf(built)).toContain("本批新建 3 件");
        expect(dataOf(built)).toContain("本轮材料台账");
        expect(db.materials).toHaveLength(3);

        const finished = mixToolBuildRecipe({ name: "盛夏暗涌", finish: true });
        expect(finished.success, String(finished.error ?? "")).toBe(true);
        expect(db.recipes).toHaveLength(1);
        const slots = db.recipes[0].slots as Record<string, { materialId: string }[]>;
        expect(slots.character).toHaveLength(1);
        expect(slots.base).toHaveLength(1);
        expect(slots.flavor).toHaveLength(1);
    });

    it("同名材料再建会被拒并还回已有 id，重试不会造出重复件", () => {
        mixToolBuildRecipe({ name: "另一杯副本", materials: [{ kind: "base", name: "总纲", content: "扮演总纲。" }] });
        const again = mixToolBuildRecipe({ name: "另一杯副本", materials: [{ kind: "base", name: "总纲", content: "另一版总纲。" }] });
        expect(again.success).toBe(true);
        expect(dataOf(again)).toContain("没建成");
        expect(db.materials).toHaveLength(1);
    });
});
