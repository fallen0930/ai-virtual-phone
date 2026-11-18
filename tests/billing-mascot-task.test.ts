import { beforeEach, describe, expect, it, vi } from "vitest";

// 记账时机：卷宝 per_task 口径下，任务以报错收场时不该结算那「一整个任务包价」。
//
// 账户 billingMode = per_task 时，一次任务的每轮调用先在 recordLlmSpend 里累计轮数，
// 循环结束由 settleTaskBilling 按一次单价扣一笔。lib/mascot-chat-store.ts 的收尾写在
// `finally` 里，catch 到「出错了...」也照结算 —— 于是她看到的是：任务失败、快捷栏弹出「已扣 5」。
// 中止（她按停）不算失败：那几轮调用真的发出去了，钱也真的从中转站扣走了，账要记。
//
// 这份用例用的是**真实**的 api-accounts（begin/end/settle 全走实现），只把它的存储底
// （settings-storage 的账户与流水读写）换成内存数组，所以「扣没扣」是看真实算出来的余额与流水。

import { getMascotChatSnapshot, resetMascotConversation, sendMascotMessage, stopMascotGeneration } from "@/lib/mascot-chat-store";
import { getApiAccount, listLedger, recordLlmSpend } from "@/lib/api-accounts";
import type { ApiAccount, ApiConfig, ApiLedgerEntry } from "@/lib/settings-types";

const GROUP_ID = "grp-bill-test";
const UNIT_PRICE = 5;

const CONFIG = {
    id: "cfg-bill-test",
    name: "计费探针站",
    provider: "Custom",
    baseUrl: "https://bill-probe.example.invalid/v1",
    apiKey: "sk-bill-probe-not-a-real-key",
    defaultModel: "probe-model",
    groupId: GROUP_ID,
    enableNativeTools: false,
    pricing: { mode: "per_call", amount: UNIT_PRICE },
} as unknown as ApiConfig;

/** settings-storage 的账户/流水换成的内存表 */
const tables = vi.hoisted(() => ({
    accounts: [] as unknown[],
    ledger: [] as unknown[],
}));

/** 脚本用完时给一个明确收尾；每条可以指定「这一轮成功记一笔」或「这一轮报错」 */
const engine = vi.hoisted(() => ({
    script: [] as { fail?: boolean; aborted?: boolean; action?: string }[],
    calls: 0,
    stop: null as (() => void) | null,
}));

vi.mock("@/lib/settings-storage", () => ({
    resolveAuxiliaryApiConfig: () => CONFIG,
    loadApiAccounts: () => tables.accounts,
    saveApiAccounts: (list: unknown[]) => { tables.accounts = list.map((row) => ({ ...(row as object) })); },
    loadApiLedger: () => tables.ledger,
    saveApiLedger: (list: unknown[]) => { tables.ledger = list.map((row) => ({ ...(row as object) })); },
    loadApiGroups: () => [],
    loadApiConfigs: () => [],
    loadBindingConfig: () => ({}),
}));

vi.mock("@/lib/mascot-engine", () => ({
    mascotChatWithTools: vi.fn(async () => {
        engine.calls += 1;
        const step = engine.script.shift();
        if (!step) {
            return {
                reply: ["都做完了。"],
                rawAssistant: "都做完了。",
                toolFetches: [],
                toolCalls: [],
                protocol: "text",
                truncated: false,
            };
        }
        // 真实引擎在每一轮请求成功后记一笔；per_task 下这里只累计轮数、不扣钱
        recordLlmSpend(CONFIG, undefined);
        if (step.aborted) {
            engine.stop?.();
            const err = new Error("aborted") as Error & { name: string };
            err.name = "AbortError";
            throw err;
        }
        if (step.fail) throw new Error("API 429: 上游限流");
        return {
            reply: [],
            rawAssistant: `[执行动作:${step.action}({"字段":"persona"})]`,
            toolFetches: [],
            toolCalls: [{ name: step.action, args: { 字段: "persona" } }],
            protocol: "text",
            truncated: false,
        };
    }),
}));

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

function visibleTexts(): string[] {
    return (getMascotChatSnapshot().messages as { role: string; text?: string; hidden?: boolean }[])
        .filter((msg) => !msg.hidden)
        .map((msg) => (msg.text || "").trim())
        .filter(Boolean);
}

function spendRows(): ApiLedgerEntry[] {
    return listLedger(GROUP_ID).filter((entry) => entry.kind === "spend");
}

async function runTask(script: { fail?: boolean; aborted?: boolean; action?: string }[]) {
    engine.script = script;
    engine.calls = 0;
    resetMascotConversation({ withGreeting: false });
    await sendMascotMessage({ text: "把 persona 和外貌都写完" });
}

describe("卷宝 per_task：任务失败不该结算", () => {
    beforeEach(() => {
        tables.accounts = [{ id: GROUP_ID, balance: 100, autoCharge: true, billingMode: "per_task", updatedAt: 0 } satisfies ApiAccount];
        tables.ledger = [];
        engine.calls = 0;
        engine.script = [];
        engine.stop = stopMascotGeneration;
        // Node 环境没有 rAF，store 的执行帧与 paintStream 依赖它（与 mascot-agent-loop 用例同款）
        (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
            (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
    });

    it("正常收尾：整段任务只结算一笔单价", async () => {
        await runTask([{ action: "更新角色字段" }]);

        expect(getApiAccount(GROUP_ID).balance).toBe(100 - UNIT_PRICE);
        expect(spendRows()).toHaveLength(1);
    });

    it("中途报错：本轮没做完就不结算，余额与流水都不动", async () => {
        await runTask([{ action: "更新角色字段" }, { fail: true }]);

        expect(visibleTexts().join("\n")).toContain("出错了");
        expect(getApiAccount(GROUP_ID).balance).toBe(100);
        expect(spendRows()).toHaveLength(0);
    });

    it("她按停：已发出的调用照实结算一笔", async () => {
        await runTask([{ action: "更新角色字段" }, { aborted: true }]);

        expect(getApiAccount(GROUP_ID).balance).toBe(100 - UNIT_PRICE);
        expect(spendRows()).toHaveLength(1);
    });
});
