import { beforeEach, describe, expect, it, vi } from "vitest";

// 酒柜快照注入（2026-11-12 设计优化 · 机制一）
//
// 改已有副本时小卷是"盲改"：没有读取配方工具，列出酒柜只回配方名字不回槽位→材料映射，
// 系统提示词里也没有任何酒柜上下文。模型只能 展开套件→列柜→按名字猜→逐个读材料确认，
// 每一次确认都是一整轮 LLM 调用。宿主从内存 kv 同步算一份索引是零成本的，
// 这里把它每轮注入系统提示词：配方→材料 id 映射 + 材料清单 + 点名材料的字段地图。
// 本文件只 mock 存储层，快照构建走真实实现。

import { buildMixCabinetSnapshot, buildMixTaskContext } from "@/lib/mixology/mascot-tools";
import { resetMixCraftSpecBoard } from "@/lib/mixology/spec-board";
import { resetMascotTaskLedger } from "@/lib/mascot-task-ledger";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ materials: [] as Row[], recipes: [] as Row[] }));

vi.mock("@/lib/mixology/storage", () => ({
    MIX_CABINET_UPDATED_EVENT: "mix-cabinet-updated",
    getMixMaterial: (id: string) => db.materials.find((m) => m.id === id) ?? null,
    isMixBuiltinId: (id: string) => String(id || "").startsWith("mixbuiltin"),
    listMixBuiltins: (kind?: string) => db.materials.filter((m) => String(m.id).startsWith("mixbuiltin") && (!kind || m.kind === kind)),
    loadMixCabinet: () => db.materials.filter((m) => !String(m.id).startsWith("mixbuiltin")),
    loadMixRecipes: () => db.recipes,
    saveMixMaterial: () => undefined,
    saveMixRecipe: () => undefined,
    findMixConnector: () => null,
    loadMixConnectors: () => [],
    saveMixConnector: () => undefined,
    deleteMixConnector: () => undefined,
}));

function seed() {
    db.materials = [
        {
            id: "mixmat_hero", kind: "character", name: "病弱少爷", charName: "病弱少爷",
            profileMode: "freeform", profileText: "苍白的少年，指尖总是凉的。", worldText: "旧宅与雨季。",
            openings: ["雨夜的第一幕。"], createdAt: 1, updatedAt: 2,
        },
        { id: "mixmat_base", kind: "base", name: "都市基底", content: "现代都市扮演总纲。", createdAt: 1, updatedAt: 1 },
        { id: "mixbuiltin_base", kind: "base", name: "官方·经典基底", content: "官方出厂。", createdAt: 0, updatedAt: 0 },
    ];
    db.recipes = [
        {
            id: "mixrec_summer", name: "盛夏暗涌", createdAt: 1, updatedAt: 3,
            slots: { character: [{ materialId: "mixmat_hero" }], base: [{ materialId: "mixmat_base" }] },
        },
    ];
}

describe("酒柜快照：配方→材料映射", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("配方行带 id 和每个槽位的材料 id/名字，改副本不用再猜", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("");
        expect(snapshot).toContain("特调酒柜快照");
        const recipeLine = snapshot.split("\n").find((line) => line.includes("盛夏暗涌"));
        expect(recipeLine, snapshot).toBeTruthy();
        expect(recipeLine).toContain("mixrec_summer");
        expect(recipeLine).toContain("mixmat_hero");
        expect(recipeLine).toContain("病弱少爷");
        expect(recipeLine).toContain("mixmat_base");
        expect(recipeLine).toContain("都市基底");
    });

    it("材料行带 id/种类/名字/来源，官方件标官方", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("");
        expect(snapshot).toContain("[mixmat_hero] 角色卡「病弱少爷」（自建）");
        expect(snapshot).toContain("[mixbuiltin_base]");
        const builtinLine = snapshot.split("\n").find((line) => line.includes("mixbuiltin_base"));
        expect(builtinLine).toContain("官方");
    });

    it("快照声明自己是当前事实，照 id 直接用、不必再列酒柜", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("");
        expect(snapshot).toMatch(/不必|无需|不用/);
        expect(snapshot).toContain("列出酒柜");
    });

    it("槽位引用的材料已不存在时标失效，不崩", () => {
        seed();
        db.recipes[0].slots = { character: [{ materialId: "mixmat_gone" }] };
        const snapshot = buildMixCabinetSnapshot("");
        expect(snapshot).toContain("失效");
    });

    it("导入的配方标注不可改", () => {
        seed();
        db.recipes.push({
            id: "mixrec_imported", name: "别人的杯", imported: true, createdAt: 1, updatedAt: 4,
            slots: { character: [{ materialId: "mixmat_hero" }] },
        });
        const snapshot = buildMixCabinetSnapshot("");
        const line = snapshot.split("\n").find((l) => l.includes("别人的杯"));
        expect(line).toContain("导入");
        expect(line).toContain("不可改");
    });

    it("空酒柜也给出可读快照，不抛错", () => {
        const snapshot = buildMixCabinetSnapshot("");
        expect(snapshot).toContain("特调酒柜快照");
        expect(snapshot).toMatch(/空|0 件/);
    });
});

describe("酒柜快照：点名材料的字段地图（焦点）", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("用户点名材料时附字段地图（路径/字数/开头锚点），改片段不用再读 outline", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("把病弱少爷的开场白改得更有张力");
        expect(snapshot).toContain("字段地图");
        expect(snapshot).toContain("openings.0");
        expect(snapshot).toContain("profileText");
    });

    it("用户点名配方时，附这杯角色卡的字段地图", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("改一下盛夏暗涌这杯的开场");
        expect(snapshot).toContain("字段地图");
        expect(snapshot).toContain("mixmat_hero");
        expect(snapshot).toContain("openings.0");
    });

    it("没点名就不附字段地图，快照保持紧凑", () => {
        seed();
        const snapshot = buildMixCabinetSnapshot("今天天气不错");
        expect(snapshot).not.toContain("字段地图");
    });
});

describe("酒柜快照：体积上限", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("大酒柜不撑爆系统提示词：总量封顶，配方与焦点优先保留", () => {
        seed();
        for (let i = 0; i < 300; i += 1) {
            db.materials.push({
                id: `mixmat_bulk_${i}`, kind: "flavor", name: `风味${i}号`, content: "一段文风。",
                createdAt: 1, updatedAt: 1,
            });
        }
        const snapshot = buildMixCabinetSnapshot("改一下盛夏暗涌的开场");
        expect(snapshot.length).toBeLessThanOrEqual(9000);
        // 配方映射与焦点字段地图必须还在
        expect(snapshot).toContain("mixrec_summer");
        expect(snapshot).toContain("openings.0");
        // 被裁掉的材料要明说，并指路工具
        expect(snapshot).toContain("未列出");
        expect(snapshot).toContain("列出酒柜");
    });
});

describe("任务上下文段落：快照 + 规格板", () => {
    beforeEach(() => {
        db.materials = [];
        db.recipes = [];
        resetMascotTaskLedger();
        resetMixCraftSpecBoard();
    });

    it("buildMixTaskContext 把快照和常驻规格拼成一段（规格板为空时只有快照）", () => {
        seed();
        const section = buildMixTaskContext({ focusText: "" });
        expect(section).toContain("特调酒柜快照");
        expect(section).not.toContain("制作规格（本轮常驻");
    });
});