import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 特调意图自动展开 + 上下文注入链路（2026-11-12 设计优化 · 机制三 + 接线守卫）
//
// 机制一/二把快照和规格板做出来了，但还有两处"最后一公里"最容易静默失效：
//   ① 用户说「建个特调副本」时套件还没展开，模型要先花一轮展开套件才能看到动作——
//      宿主明明从用户原话就能判定意图，应当直接把 mixology_pack 记进已展开集合；
//   ② 引擎两条协议（文本/原生）的系统提示词都要真的拼上 buildMixContextSection，
//      漏接任何一条，快照就只存在于测试里、不存在于请求里。
// Part A 走真实 registry 纯函数；Part B 复用引擎请求测试的 mock 骨架，只 mock 外围，
// 快照/规格板走真实实现；Part C 用源码守卫钉住 chat-store / engine / 工具层的接线点。

import { mascotChatWithTools, type MascotMsg } from "@/lib/mascot-engine";
import {
    MASCOT_MAX_EXPANDED,
    autoExpandMixologyPackage,
    detectMixologyIntent,
} from "@/lib/mascot-tools";
import { mixToolReadCraftSpec } from "@/lib/mixology/mascot-tools";
import { buildMixCraftSpec } from "@/lib/mixology/crafting-guides";
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

// registry 用「真实实现 + 提示词桩」：autoExpand/detect/touch 必须是真的（Part A 在测它们），
// 只把引擎用到的提示词构造换成短桩，避免把整份工具清单塞进断言现场。
vi.mock("@/lib/mascot-tools", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/mascot-tools")>();
    return {
        ...actual,
        buildMascotToolsListPrompt: () => "===== 可用工具 =====\n更新角色字段、写入CSS",
        buildExpandedPackageGuidePrompt: (ids: string[]) => (ids.length ? `（已展开套件说明：${ids.join(",")}）` : ""),
        buildMascotNativeNameMap: () => new Map<string, string>(),
        findPackageByLabel: () => undefined,
        getMascotNativeToolDefinitions: () => [],
    };
});

const captured = vi.hoisted(() => ({
    requests: [] as Record<string, unknown>[],
    nativeMessages: [] as { role: string; content: unknown }[][],
    rawToReturn: "",
    useNative: false,
}));

const TEXT_CONFIG = {
    id: "cfg-text",
    provider: "OpenAI",
    apiKey: "sk-test",
    defaultModel: "gpt-test",
    enableImageRecognition: false,
    enableImageGeneration: false,
    enableNativeTools: false,
    // 关流式：文本协议只发一次普通请求，断言直接看这一份 body
    enableStreaming: false,
};

const NATIVE_CONFIG = { ...TEXT_CONFIG, id: "cfg-native", enableNativeTools: true, enableStreaming: true };

vi.mock("@/lib/settings-storage", () => ({
    resolveAuxiliaryApiConfig: () => (captured.useNative ? NATIVE_CONFIG : TEXT_CONFIG),
}));

vi.mock("@/lib/api-accounts", () => ({
    recordLlmSpend: vi.fn(),
}));

vi.mock("@/lib/chat-engine", () => ({
    sendLLMToolStreamRequest: vi.fn(async (...args: unknown[]) => {
        const messages = args[2] as { role: string; content: unknown }[];
        captured.nativeMessages.push(messages);
        return {
            content: captured.rawToReturn,
            reasoning: "",
            openRouterReasoningDetails: undefined,
            toolCalls: [],
            rawResponse: "",
            providerKind: "openai-compatible",
            usage: undefined,
            truncatedToolCalls: [],
        };
    }),
}));

const MASCOT_CONTEXT = { page: "mixology", mode: "editing", label: "独家特调 · 探针", fields: {} };

function seed() {
    db.materials = [
        {
            id: "mixmat_hero", kind: "character", name: "病弱少爷", charName: "病弱少爷",
            profileMode: "freeform", profileText: "苍白的少年，指尖总是凉的。", worldText: "旧宅与雨季。",
            openings: ["雨夜的第一幕。"], createdAt: 1, updatedAt: 2,
        },
        { id: "mixmat_base", kind: "base", name: "都市基底", content: "现代都市扮演总纲。", createdAt: 1, updatedAt: 1 },
    ];
    db.recipes = [
        {
            id: "mixrec_summer", name: "盛夏暗涌", createdAt: 1, updatedAt: 3,
            slots: { character: [{ materialId: "mixmat_hero" }], base: [{ materialId: "mixmat_base" }] },
        },
    ];
}

function historyWith(text: string): MascotMsg[] {
    return [
        { role: "user", text, createdAt: new Date().toISOString() },
        { role: "tool", text: "上一步执行成功", toolName: "更新材料", toolSuccess: true },
    ];
}

function systemContent(body: Record<string, unknown>): string {
    const list = body.messages as { role: string; content: unknown }[];
    const system = list.find((message) => message.role === "system");
    return typeof system?.content === "string" ? system.content : "";
}

type FakeResponse = {
    ok: boolean;
    status: number;
    body: unknown;
    text: () => Promise<string>;
    json?: () => Promise<unknown>;
};

beforeEach(() => {
    db.materials = [];
    db.recipes = [];
    captured.requests = [];
    captured.nativeMessages = [];
    captured.rawToReturn = "好的。";
    captured.useNative = false;
    resetMascotTaskLedger();
    resetMixCraftSpecBoard();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }): Promise<FakeResponse> => {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        captured.requests.push(body);
        return {
            ok: true,
            status: 200,
            body: null,
            text: async () => "",
            json: async () => ({ choices: [{ message: { content: captured.rawToReturn } }] }),
        };
    }));
});

describe("意图自动展开：用户原话里有特调意图就不用再花一轮展开套件", () => {
    it("特调相关的说法都判定为有意图", () => {
        for (const text of ["帮我建个特调副本", "改一下酒柜里的材料", "给这杯配方换个苦精", "小票的契约改一下", "机括要联网"]) {
            expect(detectMixologyIntent(text), text).toBe(true);
        }
    });

    it("无关请求不误判", () => {
        for (const text of ["帮我写张角色卡", "今天天气不错", "把桌面壁纸换成蓝色"]) {
            expect(detectMixologyIntent(text), text).toBe(false);
        }
    });

    it("有意图且未展开时，把 mixology_pack 记进已展开集合", () => {
        const next = autoExpandMixologyPackage([], "帮我建个特调副本");
        expect(next).toContain("mixology_pack");
    });

    it("没意图时原样返回（同一个引用，不触发持久化写入）", () => {
        const ids = ["css_pack"];
        expect(autoExpandMixologyPackage(ids, "帮我写张角色卡")).toBe(ids);
    });

    it("已经展开过时原样返回，不重复续期", () => {
        const ids = ["mixology_pack"];
        expect(autoExpandMixologyPackage(ids, "再改一下配方")).toBe(ids);
    });

    it("自动展开不挤掉别的套件", () => {
        const next = autoExpandMixologyPackage(["css_pack"], "建个特调副本");
        expect(next).toContain("css_pack");
        expect(next).toContain("mixology_pack");
    });

    it("套件满了也遵守上限，挤掉最旧的", () => {
        const next = autoExpandMixologyPackage(["css_pack", "image_pack", "character_pack"], "建个特调副本");
        expect(next).toHaveLength(MASCOT_MAX_EXPANDED);
        expect(next).toContain("mixology_pack");
        expect(next).not.toContain("css_pack");
    });
});

describe("引擎注入：两条协议的系统提示词都带上特调任务上下文", () => {
    it("文本协议 + 已展开特调套件：系统提示词里有酒柜快照和配方映射", async () => {
        seed();
        await mascotChatWithTools(MASCOT_CONTEXT, historyWith("看看我的酒柜"), ["mixology_pack"]);

        expect(captured.requests).toHaveLength(1);
        const system = systemContent(captured.requests[0]);
        expect(system).toContain("特调酒柜快照");
        expect(system).toContain("盛夏暗涌");
        expect(system).toContain("mixmat_hero");
    });

    it("没展开特调套件时不注入快照，别的任务不多付这份 token", async () => {
        seed();
        await mascotChatWithTools(MASCOT_CONTEXT, historyWith("帮我写张角色卡"), []);

        const system = systemContent(captured.requests[0]);
        expect(system).not.toContain("特调酒柜快照");
    });

    it("原生协议同样注入：sendLLMToolStreamRequest 的 system 消息里有快照", async () => {
        seed();
        captured.useNative = true;
        await mascotChatWithTools(MASCOT_CONTEXT, historyWith("看看我的酒柜"), ["mixology_pack"]);

        expect(captured.nativeMessages.length).toBeGreaterThanOrEqual(1);
        const system = captured.nativeMessages[0].find((message) => message.role === "system");
        const content = typeof system?.content === "string" ? system.content : "";
        expect(content).toContain("特调酒柜快照");
        expect(content).toContain("盛夏暗涌");
    });

    it("用户点名的材料，字段地图跟着进系统提示词（焦点取自最近一条用户消息）", async () => {
        seed();
        await mascotChatWithTools(
            MASCOT_CONTEXT,
            historyWith("改一下盛夏暗涌这杯的开场白，把病弱少爷的 openings 改得更有张力"),
            ["mixology_pack"],
        );

        const system = systemContent(captured.requests[0]);
        expect(system).toContain("字段地图");
        expect(system).toContain("openings.0");
    });

    it("读过的制作规格常驻系统提示词：下一轮不用重读", async () => {
        seed();
        const read = mixToolReadCraftSpec({ kind: "ticket" });
        expect(read.success, String(read.error ?? "")).toBe(true);

        await mascotChatWithTools(MASCOT_CONTEXT, historyWith("继续写小票"), ["mixology_pack"]);

        const system = systemContent(captured.requests[0]);
        expect(system).toContain("本轮常驻");
        expect(system).toContain(buildMixCraftSpec("ticket").slice(100, 180));
    });

    it("规格板只在特调套件展开时注入，不污染其它任务", async () => {
        seed();
        mixToolReadCraftSpec({ kind: "ticket" });
        await mascotChatWithTools(MASCOT_CONTEXT, historyWith("帮我写张角色卡"), []);

        const system = systemContent(captured.requests[0]);
        expect(system).not.toContain(buildMixCraftSpec("ticket").slice(100, 180));
    });
});

describe("接线守卫：三处调用点改丢就红", () => {
    const CHAT_STORE_PATH = path.resolve(import.meta.dirname, "../lib/mascot-chat-store.ts");
    const ENGINE_PATH = path.resolve(import.meta.dirname, "../lib/mascot-engine.ts");
    const MIX_TOOLS_PATH = path.resolve(import.meta.dirname, "../lib/mixology/mascot-tools.ts");

    it("chat-store：每条用户消息开轮时清空调规格板，并按意图自动展开", () => {
        const source = readFileSync(CHAT_STORE_PATH, "utf8");
        expect(source).toMatch(/resetMixCraftSpecBoard\(\)/);
        expect(source).toMatch(/autoExpandMixologyPackage\(/);
    });

    it("engine：buildMixContextSection 有定义且两条协议各接一处", () => {
        const source = readFileSync(ENGINE_PATH, "utf8");
        const occurrences = source.match(/buildMixContextSection\(/g) ?? [];
        // 1 处定义 + 文本/原生各 1 处调用
        expect(occurrences.length).toBeGreaterThanOrEqual(3);
    });

    it("mixology 工具层：读取制作说明真的把规格 pin 进常驻板", () => {
        const source = readFileSync(MIX_TOOLS_PATH, "utf8");
        expect(source).toMatch(/pinMixCraftSpecs\(/);
    });
});