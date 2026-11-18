import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 断流看门狗与轮级重试（2026-11-12 真机诊断驱动）
//
// 诊断日志 mascot-diag-20261112-1221：第 5 轮 build_recipe 的流在首块之后 **17.8 分钟没有任何字节**，
// 但内部只有「总时长 500 秒」的粗闸：流式先烧满 500 秒，兜底直连 fetch 干脆没超时（跟着中转一起挂），
// 一轮就吃掉 18 分钟，最后任务以超时收场。中转首包 130~190 秒是常态，所以看门狗必须看
// 「多久没数据」而不是只掐总时长：240 秒无字节即判死，中断后循环层自动重试同一轮一次。
//
// Part A 直接单测看门狗（假时钟）；Part B 走循环骨架，验证断流错误重试一次、非断流错误不重试、
// 连续断流不无限重试；Part C 源码守卫钉住 chat-engine / mascot-engine / chat-store 三处接线。
// 「看门狗参数真的从引擎传下去、兜底直连带超时信号」需要真实 mascot-engine，单独放在
// tests/mascot-stall-engine.test.ts —— 本文件必须把引擎整个 mock 掉才能脚本化循环行为，
// 两套用法共用一个文件会互相打架（引擎用例拿到的是脚本化 mock，断言不到真接线）。

import { StreamIdleWatchdog, withTimeoutSignal } from "@/lib/stream-idle-watchdog";
import {
    getMascotChatSnapshot,
    resetMascotConversation,
    sendMascotMessage,
} from "@/lib/mascot-chat-store";

// ── Part A：看门狗本体 ────────────────────────────────

describe("StreamIdleWatchdog：无数据即判死，有数据就续命", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("240 秒没有任何字节 → 中止并标记为断流", () => {
        const wd = new StreamIdleWatchdog({ totalMs: 500_000, idleMs: 240_000 });
        vi.advanceTimersByTime(239_000);
        expect(wd.signal.aborted).toBe(false);
        vi.advanceTimersByTime(2_000);
        expect(wd.signal.aborted).toBe(true);
        expect(wd.idleTimedOut).toBe(true);
        wd.dispose();
    });

    it("每个字节都续命：慢但持续输出的长生成不会被误杀（总闸 500 秒才收）", () => {
        const wd = new StreamIdleWatchdog({ totalMs: 500_000, idleMs: 240_000 });
        // 每 100 秒进一块数据（断流闸 240 秒永远够不着），累计 400 秒仍在活着
        for (let i = 0; i < 4; i += 1) {
            vi.advanceTimersByTime(100_000);
            expect(wd.signal.aborted).toBe(false);
            wd.touch();
        }
        // 再进 100 秒：断流闸到不了点，总闸在 500 秒收口
        vi.advanceTimersByTime(100_000);
        expect(wd.signal.aborted).toBe(true);
        expect(wd.idleTimedOut).toBe(false);
        wd.dispose();
    });

    it("dispose 之后时钟怎么推都不触发", () => {
        const wd = new StreamIdleWatchdog({ totalMs: 500_000, idleMs: 240_000 });
        wd.dispose();
        vi.advanceTimersByTime(1_000_000);
        expect(wd.signal.aborted).toBe(false);
    });

    it("withTimeoutSignal：外部信号与超时信号谁先到听谁的", () => {
        const external = new AbortController();
        const combined = withTimeoutSignal(external.signal, 600_000);
        expect(combined.aborted).toBe(false);
        external.abort("用户按停");
        expect(combined.aborted).toBe(true);
    });

    it("withTimeoutSignal：外部信号已中止时直接透传，不再包一层", () => {
        const external = new AbortController();
        external.abort("已经停了");
        expect(withTimeoutSignal(external.signal, 600_000)).toBe(external.signal);
    });
});

// ── Part B：循环层轮级重试 ───────────────────────────

const loop = vi.hoisted(() => ({
    calls: [] as { history: unknown[] }[],
    script: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/mascot-engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/mascot-engine")>();
    return {
        ...actual,
        mascotChatWithTools: vi.fn(async (_context: unknown, history: unknown[]) => {
            loop.calls.push({ history: [...history] });
            const next = loop.script.shift();
            if (!next) {
                return { reply: ["都完成了。"], rawAssistant: "都完成了。", toolFetches: [], toolCalls: [], protocol: "text", truncated: false };
            }
            if (next.__throw) throw new Error(String(next.__throw));
            return { reply: [], rawAssistant: "", toolFetches: [], toolCalls: [], protocol: "text", truncated: false, ...next };
        }),
    };
});

vi.mock("@/lib/mascot-tools", () => ({
    autoExpandMixologyPackage: (ids: string[]) => ids,
    buildMascotPackageSchemaPrompt: () => "（套件动作说明）",
    clearExpandedPackages: vi.fn(),
    executeMascotToolCall: vi.fn(async (call: { name: string }) => ({ success: true, data: `${call.name} 执行成功` })),
    findPackageByLabel: () => undefined,
    getMascotNativeLoaderName: (id: string) => `_loader:${id}`,
    loadExpandedPackages: () => [] as string[],
    saveExpandedPackages: vi.fn(),
    touchExpandedPackage: (ids: string[], id: string) => [...ids, id],
}));

vi.mock("@/lib/mascot-context", () => ({
    getMascotContext: () => ({ page: "desktop", mode: "idle", label: "桌面", fields: {} }),
}));

vi.mock("@/lib/mascot-events", () => ({ mascotFillField: vi.fn() }));

vi.mock("@/lib/mascot-state", () => ({ isMascotPanelOpen: () => true }));

vi.mock("@/lib/settings-storage", () => ({
    resolveAuxiliaryApiConfig: () => ({
        id: "cfg-test",
        provider: "OpenAI",
        apiKey: "sk-test",
        defaultModel: "gpt-test",
        enableImageRecognition: false,
        enableImageGeneration: false,
        enableNativeTools: false,
    }),
}));

vi.mock("@/lib/api-accounts", () => ({
    accountIdForConfig: () => "acct-test",
    beginTaskBilling: vi.fn(),
    cancelTaskBilling: vi.fn(),
    endTaskBilling: vi.fn(),
    isTaskBillingActive: () => false,
    isTaskBillingEnabled: () => false,
    settleTaskBilling: vi.fn(),
    recordLlmSpend: vi.fn(),
}));

function visibleTexts(): string[] {
    const messages = getMascotChatSnapshot().messages as { role: string; text?: string; displayText?: string; hidden?: boolean }[];
    return messages
        .filter((msg) => !msg.hidden && msg.role !== "tool")
        .map((msg) => (msg.displayText || msg.text || "").trim())
        .filter(Boolean);
}

describe("循环层：断流错误自动重试同一轮，别的错误不重试", () => {
    beforeEach(() => {
        loop.calls = [];
        loop.script = [];
        (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
            (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
        if (!(globalThis as { localStorage?: unknown }).localStorage) {
            const store = new Map<string, string>();
            (globalThis as { localStorage?: unknown }).localStorage = {
                getItem: (key: string) => store.get(key) ?? null,
                setItem: (key: string, value: string) => { store.set(key, value); },
                removeItem: (key: string) => { store.delete(key); },
                clear: () => store.clear(),
            } as unknown as Storage;
        }
        resetMascotConversation({ withGreeting: false });
    });

    it("流式中断一次 → 会话里留可见提示并自动重试，任务照常完成", async () => {
        loop.script = [
            { __throw: "AI 原生动作流式回复中断（240 秒没有收到数据），请重试。" },
            { reply: ["这次接上了：整套材料都建好了。"], rawAssistant: "这次接上了：整套材料都建好了。" },
        ];

        await sendMascotMessage({ text: "给我建一套特调副本" });

        expect(loop.calls.length).toBe(2);
        expect(visibleTexts().some((text) => /中断|重试/.test(text))).toBe(true);
        expect(visibleTexts().some((text) => text.includes("接上了"))).toBe(true);
    });

    it("连续两次都是断流 → 不再无限重试，如实报错收场", async () => {
        loop.script = [
            { __throw: "AI 原生动作流式回复中断（240 秒没有收到数据），请重试。" },
            { __throw: "AI 原生动作流式回复中断（240 秒没有收到数据），请重试。" },
        ];

        await sendMascotMessage({ text: "给我建一套特调副本" });

        // 只重试一次：总共 2 次调用，绝不出现第 3 次
        expect(loop.calls.length).toBe(2);
    });

    it("非断流错误（空内容）不触发重试，保持原有报错路径", async () => {
        loop.script = [{ __throw: "LLM 返回了空内容" }];

        await sendMascotMessage({ text: "随便聊聊" });

        expect(loop.calls.length).toBe(1);
    });
});

// ── Part C：源码守卫 ─────────────────────────────────

describe("接线守卫：三处看门狗接线改丢就红", () => {
    const CHAT_ENGINE_PATH = path.resolve(import.meta.dirname, "../lib/chat-engine.ts");
    const ENGINE_PATH = path.resolve(import.meta.dirname, "../lib/mascot-engine.ts");
    const CHAT_STORE_PATH = path.resolve(import.meta.dirname, "../lib/mascot-chat-store.ts");

    it("chat-engine 的原生工具流式出口按 streamIdleMs 挂看门狗", () => {
        const source = readFileSync(CHAT_ENGINE_PATH, "utf8");
        expect(source).toMatch(/streamIdleMs/);
        expect(source).toMatch(/StreamIdleWatchdog/);
    });

    it("mascot-engine 两条协议与兜底直连都用统一的断流/超时阈值", () => {
        const source = readFileSync(ENGINE_PATH, "utf8");
        expect(source).toMatch(/MASCOT_STREAM_IDLE_MS/);
        expect(source).toMatch(/MASCOT_FALLBACK_TIMEOUT_MS/);
        expect(source).toMatch(/withTimeoutSignal\(/);
    });

    it("chat-store 循环里有断流重试的记账", () => {
        const source = readFileSync(CHAT_STORE_PATH, "utf8");
        expect(source).toMatch(/MASCOT_MAX_STALL_RETRIES/);
    });
});
