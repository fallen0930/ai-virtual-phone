import { beforeEach, describe, expect, it, vi } from "vitest";

// 本轮任务台账（2026-10-29 真机日志驱动）
//
// 14:00 那条建特调的任务里，小卷第 24 / 26 / 32 / 35 / 39 轮连着「创建材料」，中间夹一圈
// 「列出酒柜」——因为工具回执里的 id 只在那一条消息里出现一次，下一轮它就想不起来，
// 只能重新列表、甚至重新建一件同名的。而 创建材料 / 保存配方 都不查重名，
// 于是酒柜里躺着几件一样的东西，它再按名字读的时候又被「重名歧义」挡回去，继续绕圈。
// 台账做的事：本轮建过什么（scope + kind + 名字 → id）记下来，
// ① 回执里把 id 交回去，② 同类同名再建直接拒并给已有 id，③ 查找失败时能当候选。

import {
    findInMascotTaskLedger,
    listMascotTaskLedger,
    recordMascotTaskLedger,
    resetMascotTaskLedger,
    summarizeTaskLedger,
} from "@/lib/mascot-task-ledger";
import { mixToolCreateMaterial, mixToolSaveRecipe } from "@/lib/mixology/mascot-tools";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ materials: [] as Row[], recipes: [] as Row[] }));

vi.mock("@/lib/mixology/storage", () => ({
    MIX_CABINET_UPDATED_EVENT: "mix-cabinet-updated",
    getMixMaterial: (id: string) => db.materials.find((m) => m.id === id) ?? null,
    isMixBuiltinId: (id: string) => String(id || "").startsWith("mixbuiltin"),
    listMixBuiltins: (kind?: string) => db.materials.filter((m) => String(m.id).startsWith("mixbuiltin") && (!kind || m.kind === kind)),
    loadMixCabinet: () => db.materials.filter((m) => !String(m.id).startsWith("mixbuiltin")),
    loadMixRecipes: () => db.recipes.slice(),
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

function dataOf(result: { data?: unknown }): string {
    return String(result.data ?? "");
}

function idOf(result: { data?: unknown }): string {
    const match = dataOf(result).match(/id: (\S+?)[）\s]/);
    expect(match, `回执里没找到 id：${dataOf(result)}`).toBeTruthy();
    return String(match?.[1]);
}

function createBase(name: string, content = "一整套交互准则，够长的一段正文。"): Row {
    const result = mixToolCreateMaterial({ kind: "base", name, content });
    expect(result.success, String(result.error ?? "")).toBe(true);
    return result;
}

describe("卷宝本轮任务台账", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
    });

    it("同类同名的材料不能在一轮里建两遍：第二次被拒并把已有 id 交回去", () => {
        const first = createBase("纯白造物交互准则");
        const second = mixToolCreateMaterial({ kind: "base", name: "纯白造物交互准则", content: "又写了一遍。" });

        expect(second.success).toBe(false);
        expect(String(second.error)).toContain(idOf(first));
        expect(String(second.error)).toMatch(/更新|换名/);
        expect(db.materials.filter((m) => m.kind === "base" && m.name === "纯白造物交互准则")).toHaveLength(1);
    });

    it("同名不同类是两件东西，不该互相拦", () => {
        createBase("纯白造物");
        const flavor = mixToolCreateMaterial({ kind: "flavor", name: "纯白造物", content: "另一种正文。" });
        expect(flavor.success, String(flavor.error ?? "")).toBe(true);
    });

    it("建过的对象进本轮台账，不用「列出酒柜」也想得起 id", () => {
        const created = createBase("纯白造物交互准则");
        const hit = findInMascotTaskLedger({ scope: "mixmat", kind: "base", name: "纯白造物交互准则" });
        expect(hit?.id).toBe(idOf(created));
    });

    it("新一轮开始，台账清空", () => {
        createBase("纯白造物交互准则");
        expect(listMascotTaskLedger("mixmat").length).toBeGreaterThan(0);
        resetMascotTaskLedger();
        expect(listMascotTaskLedger()).toHaveLength(0);
    });

    it("台账清空也不影响防重：酒柜里已有的同类同名材料照样拦", () => {
        const first = createBase("纯白造物交互准则");
        resetMascotTaskLedger();
        const again = mixToolCreateMaterial({ kind: "base", name: "纯白造物交互准则", content: "第三次。" });
        expect(again.success).toBe(false);
        expect(String(again.error)).toContain(idOf(first));
    });

    it("配方保存的回执带 id；同名再保存点明是覆盖，不是又调了一杯", () => {
        const card = mixToolCreateMaterial({ kind: "character", name: "阿零", openings: ["一条开场白。"] });
        expect(card.success, String(card.error ?? "")).toBe(true);

        const slots = [{ kind: "character", material: "阿零" }];
        const first = mixToolSaveRecipe({ name: "独占初号机", slots });
        expect(first.success, String(first.error ?? "")).toBe(true);
        expect(dataOf(first)).toMatch(/id: \S+/);

        const again = mixToolSaveRecipe({ name: "独占初号机", slots });
        expect(again.success, String(again.error ?? "")).toBe(true);
        expect(dataOf(again)).toMatch(/覆盖|同一杯|已有/);
        expect(db.recipes).toHaveLength(1);
    });

    it("手工记的台账条目按名字查得到，且名字比较忽略首尾空格与大小写", () => {
        recordMascotTaskLedger({ scope: "character", id: "char_1", name: "Zero", label: "角色「Zero」" });
        expect(findInMascotTaskLedger({ scope: "character", name: "  zero " })?.id).toBe("char_1");
        expect(findInMascotTaskLedger({ scope: "preset", name: "Zero" })).toBeUndefined();
    });

    it("台账摘要按 scope 分组计数，空台账返回空串", () => {
        expect(summarizeTaskLedger()).toBe("");
        createBase("纯白造物交互准则");
        mixToolCreateMaterial({ kind: "flavor", name: "薄荷", content: "正文" });
        recordMascotTaskLedger({ scope: "character", id: "char_1", name: "阿零", label: "角色「阿零」" });
        const summary = summarizeTaskLedger();
        expect(summary).toContain("2 件材料");
        expect(summary).toContain("1 个角色");
    });
});
