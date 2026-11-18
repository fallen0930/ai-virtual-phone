import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 回执可见性：工具卡一键跳到酒柜里的这张材料（2026-11-12 她真机反馈驱动）
//
// 她的原话：「具体的内容我是看不见的，只能看见这样半截」。三机制让轮数省下来了，
// 但她看完执 still 摸不到成果：工具回执里明明写着（id: mixmat_xxx），界面却没有入口。
// 方案（她选的「回执可见性改进」）：工具卡上加「在酒柜查看」，一点即跳特调 App 并直接
// 打开那张材料的编辑页。跳转跨两个挂载时序（特调 App 可能还没 mount），所以走
// sessionStorage 桥 + CustomEvent 双通道，消费一次即清，绝不重复弹窗。

import {
    MIXOLOGY_OPEN_MATERIAL_EVENT,
    MIX_MATERIAL_JUMP_KEY,
    consumePendingMixMaterialJump,
    extractMixMaterialIds,
    requestOpenMixMaterial,
} from "@/lib/mascot-material-jump";

// ── Part A：纯抽取 ───────────────────────────────────

describe("extractMixMaterialIds：三种回执格式都要认", () => {
    it("创建回执「（id: mixmat_xxx）」", () => {
        expect(extractMixMaterialIds("已把基底「海雾」放进酒柜（id: mixmat_m9k2abc123）。照这个 id 接着改就行。")).toEqual(["mixmat_m9k2abc123"]);
    });

    it("列表头「[mixmat_xxx] 种类「名」」、同名提醒与台账「kind:mixmat_xxx」混在同一条里", () => {
        const text = [
            "[mixmat_aaa111] 基底「海雾」（本地）",
            "（注意：酒柜里另有一件同名基底，id: mix_builtin_base，官方件不可改）",
            "【本轮材料台账】base:mixmat_bbb222、garnish:mixmat_ccc333",
        ].join("\n");
        // 顺序 = 出现顺序，去重
        expect(extractMixMaterialIds(text)).toEqual(["mixmat_aaa111", "mix_builtin_base", "mixmat_bbb222", "mixmat_ccc333"]);
    });

    it("重复 id 只留一次；配方 id 与中文语境不误伤", () => {
        expect(extractMixMaterialIds("mixmat_x1、mixmat_x1、mixmat_x1")).toEqual(["mixmat_x1"]);
        // 配方/会话/预设 id 不是材料，跳编辑页会跳错地方
        expect(extractMixMaterialIds("配方 mixrec_abc123 会话 mixses_zzz 材料 id 暂缺")).toEqual([]);
        expect(extractMixMaterialIds("")).toEqual([]);
        expect(extractMixMaterialIds("今天天气不错，mixmat 后面没跟 id 也算不上")).toEqual([]);
    });
});

// ── Part B：sessionStorage 桥 + 事件双通道 ───────────

type Handler = (event: Event) => void;

function installDomStub() {
    const events: { name: string; detail?: unknown }[] = [];
    const listeners = new Map<string, Set<Handler>>();
    const store = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    } as unknown as Storage;
    (globalThis as { window?: unknown }).window = {
        addEventListener: (name: string, handler: Handler) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(handler);
        },
        removeEventListener: (name: string, handler: Handler) => { listeners.get(name)?.delete(handler); },
        dispatchEvent: (event: Event) => {
            const name = event.type;
            events.push({ name, detail: (event as CustomEvent).detail });
            for (const handler of listeners.get(name) ?? []) handler(event);
            return true;
        },
    } as unknown as Window & typeof globalThis;
    return { events, store, listeners };
}

describe("跳转桥：写入→事件→消费一次即清", () => {
    let dom: ReturnType<typeof installDomStub>;

    beforeEach(() => {
        if (typeof globalThis.CustomEvent === "undefined") {
            (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
                type: string;
                detail: unknown;
                constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; }
            };
        }
        dom = installDomStub();
    });

    afterEach(() => {
        delete (globalThis as { window?: unknown }).window;
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    });

    it("requestOpenMixMaterial 先写桥再派事件，监听方从桥里拿到同一个 id", () => {
        const received: string[] = [];
        dom.listeners.set(MIXOLOGY_OPEN_MATERIAL_EVENT, new Set([() => {
            const id = consumePendingMixMaterialJump();
            if (id) received.push(id);
        }]));

        requestOpenMixMaterial("mixmat_jump01");

        expect(received).toEqual(["mixmat_jump01"]);
        expect(dom.events[0]?.name).toBe(MIXOLOGY_OPEN_MATERIAL_EVENT);
        expect(dom.events[0]?.detail).toEqual({ id: "mixmat_jump01" });
    });

    it("消费即清：第二次读是空的，不会重复弹编辑页", () => {
        requestOpenMixMaterial("mixmat_jump02");
        expect(consumePendingMixMaterialJump()).toBe("mixmat_jump02");
        expect(consumePendingMixMaterialJump()).toBeNull();
    });

    it("空 id 不写桥也不派事件", () => {
        requestOpenMixMaterial("");
        expect(dom.events.length).toBe(0);
        expect(dom.store.size).toBe(0);
    });

    it("没有 window/sessionStorage 的环境不炸（SSR/单测兜底）", () => {
        delete (globalThis as { window?: unknown }).window;
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
        expect(() => requestOpenMixMaterial("mixmat_jump03")).not.toThrow();
        expect(consumePendingMixMaterialJump()).toBeNull();
    });

    it("桥键名钉死：跨文件约定改个名就全断", () => {
        expect(MIX_MATERIAL_JUMP_KEY).toBe("mixology-open-material-pending");
        expect(MIXOLOGY_OPEN_MATERIAL_EVENT).toBe("mixology-open-material");
    });
});

// ── Part C：两端接线守卫 ─────────────────────────────

describe("接线守卫：聊天室出口与特调 App 入口都挂在", () => {
    const ROOM_PATH = path.resolve(import.meta.dirname, "../components/chat/mascot-chat-room.tsx");
    const APP_PATH = path.resolve(import.meta.dirname, "../components/mixology/mixology-app.tsx");

    it("聊天室工具卡：抽取 id、跳特调 App、带「在酒柜查看」出口", () => {
        const source = readFileSync(ROOM_PATH, "utf8");
        expect(source).toMatch(/extractMixMaterialIds/);
        expect(source).toMatch(/requestOpenMixMaterial/);
        expect(source).toMatch(/mascotNavigate\("mixology"\)/);
        expect(source).toMatch(/在酒柜查看/);
    });

    it("特调 App：监听事件 + 挂载时消费 sessionStorage 桥（时序两头都接住）", () => {
        const source = readFileSync(APP_PATH, "utf8");
        expect(source).toMatch(/MIXOLOGY_OPEN_MATERIAL_EVENT/);
        expect(source).toMatch(/consumePendingMixMaterialJump/);
        expect(source).toMatch(/openLocalEditor/);
    });
});
