import { beforeEach, describe, expect, it, vi } from "vitest";

// 引擎接线：断流看门狗参数与兜底直连超时（2026-11-12 真机诊断驱动）
//
// 诊断日志 mascot-diag-20261112-1221 的第 5 轮：流在首块之后 17.8 分钟没有任何字节，
// 但链路上只有「总时长 500 秒」的粗闸，且原生流式失败后的兜底直连 fetch 干脆没挂超时——
// 一轮吃掉 18 分钟。本文件走**真实 mascot-engine**（只 mock 配置、网络与 chat-engine），
// 钉三件事：
//   ① 原生协议把 240 秒断流阈值 + 总闸显式传给 sendLLMToolStreamRequest；
//   ② 原生流式中断后的兜底直连 fetch 必须带超时信号（旧代码只挂外部信号，能跟着中转一起挂死）；
//   ③ 文本协议的非流式请求同样带超时信号。
// 循环层的「断流自动重试一次」在 tests/mascot-stall-retry.test.ts，看门狗本体的假时钟用例在同文件 Part A。

import { mascotChatWithTools, type MascotMsg } from "@/lib/mascot-engine";

const captured = vi.hoisted(() => ({
    requests: [] as Record<string, unknown>[],
    fetchInits: [] as { signal?: AbortSignal }[],
    nativeOptions: [] as Record<string, unknown>[],
    rawToReturn: "",
    useNative: false,
    throwNativeStream: false,
    streamingOff: false,
}));

const TEXT_CONFIG = {
    id: "cfg-text",
    provider: "OpenAI",
    apiKey: "sk-test",
    defaultModel: "gpt-test",
    enableImageRecognition: false,
    enableImageGeneration: false,
    enableNativeTools: false,
};

vi.mock("@/lib/settings-storage", () => ({
    resolveAuxiliaryApiConfig: () => {
        const base = captured.useNative
            ? { ...TEXT_CONFIG, id: "cfg-native", enableNativeTools: true, enableStreaming: true }
            : captured.streamingOff
                ? { ...TEXT_CONFIG, enableStreaming: false }
                : TEXT_CONFIG;
        return base;
    },
}));

vi.mock("@/lib/api-accounts", () => ({
    recordLlmSpend: vi.fn(),
    accountIdForConfig: () => "acct-test",
    beginTaskBilling: vi.fn(),
    cancelTaskBilling: vi.fn(),
    endTaskBilling: vi.fn(),
    isTaskBillingActive: () => false,
    isTaskBillingEnabled: () => false,
    settleTaskBilling: vi.fn(),
}));

vi.mock("@/lib/chat-engine", () => ({
    sendLLMToolStreamRequest: vi.fn(async (...args: unknown[]) => {
        const options = args[6] as Record<string, unknown> | undefined;
        captured.nativeOptions.push(options ?? {});
        if (captured.throwNativeStream) {
            throw new Error("AI 原生动作流式回复中断（240 秒没有收到数据），请重试。");
        }
        return {
            content: captured.rawToReturn,
            reasoning: "",
            openRouterReasoningDetails: undefined,
            toolCalls: [],
            rawResponse: "",
            providerKind: "openai-compatible",
            usage: undefined,
        };
    }),
}));

vi.mock("@/lib/mascot-tools", () => ({
    MASCOT_TOOL_PACKAGES: [],
    MASCOT_MAX_EXPANDED: 3,
    buildMascotPackageSchemaPrompt: () => "（套件动作说明）",
    buildExpandedPackageGuidePrompt: () => "",
    buildMascotNativeNameMap: () => new Map<string, string>(),
    buildMascotToolsListPrompt: () => "===== 可用工具 =====",
    findPackageByLabel: () => undefined,
    getMascotNativeToolDefinitions: () => [],
    getMascotNativeLoaderName: (id: string) => `_loader:${id}`,
}));

const MASCOT_CONTEXT = { page: "mixology", mode: "editing", label: "独家特调 · 探针", fields: {} };

function engineHistory(count: number): MascotMsg[] {
    const history: MascotMsg[] = [{
        role: "user",
        text: "建一套荒岛综艺的特调副本",
        createdAt: new Date().toISOString(),
    }];
    while (history.length < count) {
        history.push({ role: "tool", text: "上一步执行成功", toolName: "创建材料", toolSuccess: true });
    }
    return history;
}

type FakeResponse = {
    ok: boolean;
    status: number;
    body: unknown;
    text: () => Promise<string>;
    json?: () => Promise<unknown>;
};

describe("引擎接线：看门狗参数真的传下去，兜底直连不再是无限等", () => {
    beforeEach(() => {
        captured.requests = [];
        captured.fetchInits = [];
        captured.nativeOptions = [];
        captured.rawToReturn = "好的。";
        captured.useNative = false;
        captured.throwNativeStream = false;
        captured.streamingOff = false;
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string; signal?: AbortSignal }): Promise<FakeResponse> => {
            const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
            captured.requests.push(body);
            captured.fetchInits.push(init ?? {});
            return {
                ok: true,
                status: 200,
                body: null,
                text: async () => "",
                json: async () => ({ choices: [{ message: { content: captured.rawToReturn } }] }),
            };
        }));
    });

    it("原生协议：把 240 秒断流阈值与总闸传给 sendLLMToolStreamRequest", async () => {
        captured.useNative = true;
        await mascotChatWithTools(MASCOT_CONTEXT, engineHistory(4), []);

        const options = captured.nativeOptions[captured.nativeOptions.length - 1];
        expect(options.streamIdleMs).toBe(240_000);
        expect(options.timeoutMs).toBeGreaterThanOrEqual(500_000);
    });

    it("原生流式被中断后，兜底直连 fetch 带超时信号（旧代码只挂外部信号，能挂死）", async () => {
        captured.useNative = true;
        captured.throwNativeStream = true;
        const result = await mascotChatWithTools(MASCOT_CONTEXT, engineHistory(4), []);

        expect(captured.requests.length).toBe(1);
        expect(captured.fetchInits[0].signal).toBeTruthy();
        expect(result.reply.join("")).toContain("好的");
    });

    it("文本协议非流式请求同样带超时信号", async () => {
        captured.streamingOff = true;
        await mascotChatWithTools(MASCOT_CONTEXT, engineHistory(4), []);

        expect(captured.fetchInits.length).toBe(1);
        expect(captured.fetchInits[0].signal).toBeTruthy();
    });
});
