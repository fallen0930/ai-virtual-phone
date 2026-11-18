import { beforeEach, describe, expect, it, vi } from "vitest";

// 卷宝 agent 循环的收尾与截断判定（回归测试）
//
// 背景：卷宝「话说到一半直接停住 + 最后只说已完成」的四个根因——
//   ① 输出被 max_tokens 截断后，残缺动作被 parseToolCalls 静默丢弃，循环把「没有动作」当成完工；
//   ② 提醒文案写着「全部做完后再只回复：已完成」，模型照做，收尾总结没了；
//   ③ finishedHint 正则命中回复任意位置的「已完成」，「已完成一半，接下来…」也会被判定完工；
//   ④ 轮数用尽只在不显示的通知条里提示（面板开着时完全静默），用户只看到突然不说话了。
// 本文件锁定期望行为：截断自动续接、闲聊不被动着动手、中途话术不误判结束、
// 轮数用尽与收尾都在会话内留下可见的「做了什么 / 还差什么」。
//
// 只 mock LLM 入口 mascotChatWithTools 与工具执行 executeMascotToolCall，其余走真实实现。

import {
    getMascotChatSnapshot,
    resetMascotConversation,
    sendMascotMessage,
} from "@/lib/mascot-chat-store";

const engine = vi.hoisted(() => ({
    calls: [] as { history: unknown[] }[],
    script: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/mascot-engine", () => ({
    mascotChatWithTools: vi.fn(async (_context: unknown, history: unknown[]) => {
        engine.calls.push({ history: [...history] });
        const next = engine.script.shift();
        if (!next) {
            // 脚本用完：给一个明确收尾，避免测试里空转到轮数上限
            return {
                reply: ["已全部完成，persona 和外貌都写入好了。"],
                rawAssistant: "已全部完成，persona 和外貌都写入好了。",
                toolFetches: [],
                toolCalls: [],
                protocol: "text",
                truncated: false,
            };
        }
        return {
            reply: [],
            rawAssistant: "",
            toolFetches: [],
            toolCalls: [],
            protocol: "text",
            truncated: false,
            ...next,
        };
    }),
}));

const executed = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/mascot-tools", () => ({
    autoExpandMixologyPackage: (ids: string[]) => ids,
    buildMascotPackageSchemaPrompt: () => "（套件动作说明）",
    clearExpandedPackages: vi.fn(),
    executeMascotToolCall: vi.fn(async (call: { name: string }) => {
        executed.push(call.name);
        if (call.name === "创建材料") {
            // 特调类工具的回执里带「材料名」，小结应当把它带出来
            return { success: true, data: "已把面具「病弱少爷·云知砚」放进酒柜（id: mixmat_test）。" };
        }
        return { success: true, data: `${call.name} 执行成功` };
    }),
    findPackageByLabel: (label: string) => (label === "独家特调套件" ? { id: "mixology_pack", label } : undefined),
    getMascotNativeLoaderName: (id: string) => `_loader:${id}`,
    loadExpandedPackages: () => [] as string[],
    saveExpandedPackages: vi.fn(),
    touchExpandedPackage: (ids: string[], id: string) => [...ids, id],
}));

vi.mock("@/lib/mascot-context", () => ({
    getMascotContext: () => ({ page: "desktop", mode: "idle", label: "桌面", fields: {} }),
}));

vi.mock("@/lib/mascot-events", () => ({
    mascotFillField: vi.fn(),
}));

vi.mock("@/lib/mascot-state", () => ({
    // 面板是开着的：现网正是这种情况下「轮数用尽」一点提示都没有
    isMascotPanelOpen: () => true,
}));

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

type SnapshotMsg = { role: string; text?: string; displayText?: string; hidden?: boolean };

function messages(): SnapshotMsg[] {
    return getMascotChatSnapshot().messages as SnapshotMsg[];
}

function visibleTexts(): string[] {
    return messages()
        .filter((msg) => !msg.hidden)
        .map((msg) => (msg.displayText || msg.text || "").trim())
        .filter(Boolean);
}

/** 第 callIndex 次调用时喂给模型的历史全文（用来确认隐藏提醒有没有送到） */
function historyTextsAt(callIndex: number): string {
    const call = engine.calls[callIndex];
    if (!call) return "";
    return call.history
        .map((msg) => {
            const m = msg as { text?: string; displayText?: string };
            return `${m.text || ""}\n${m.displayText || ""}`;
        })
        .join("\n");
}

function action(name: string, reply: string[] = []) {
    return {
        reply,
        rawAssistant: `${reply.join("\n")}[执行动作:${name}({"字段":"persona"})]`,
        toolCalls: [{ name, args: { 字段: "persona" } }],
    };
}

function setPref(key: string, value: string | null): void {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
}

describe("卷宝 agent 循环：截断续接与收尾", () => {
    beforeEach(() => {
        engine.calls = [];
        engine.script = [];
        executed.length = 0;
        // Node 环境没有 rAF，store 的 paintStream 依赖它
        (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
            (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
        // 偏好走 localStorage 键覆盖（与工坊同款），没有浏览器存储时给一个内存版
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

    it("输出被截断时不判定完工：自动续写并在会话内留可见提示", async () => {
        engine.script = [
            {
                // 长内容写到一半被 max_tokens 切断：动作残缺、不会被执行
                reply: ["先把 persona 写好，再补外貌"],
                rawAssistant: '先把 persona 写好，再补外貌[执行动作:更新角色字段({"字段":"persona","内容":"一长段还没写完的人设',
                truncated: true,
            },
            action("更新角色字段", ["persona 写好了，接着补外貌"]),
            { reply: ["这次真的都做完了：persona 与外貌两个字段都已写入。"] },
        ];

        await sendMascotMessage({ text: "帮我写一个角色的 persona 和外貌" });

        // ① 截断那一轮之后循环没有停：至少 3 次调用
        expect(engine.calls.length).toBeGreaterThanOrEqual(3);
        // ② 续写指令喂回了模型（用户不可见）
        expect(historyTextsAt(1)).toContain("截断");
        // ③ 会话里留下可见线索，她不用猜为什么多等了一轮
        expect(visibleTexts().some((text) => /截断|续写/.test(text))).toBe(true);
        expect(executed).toContain("更新角色字段");
    });

    it("展开套件后历史里只留一行短回执，完整说明改由系统提示常驻", async () => {
        engine.script = [
            { reply: [], rawAssistant: "[获取指令:独家特调套件]", toolFetches: [{ name: "独家特调套件" }] },
            { reply: ["都办好了：材料与配方都已就位。"], rawAssistant: "都办好了：材料与配方都已就位。" },
        ];

        await sendMascotMessage({ text: "帮我建一杯特调" });

        const historyText = historyTextsAt(1);
        expect(historyText).toContain("独家特调套件");
        // 长说明不再塞进历史消息（那条会被 40 条窗口挤掉），只留一行指向系统提示的回执
        expect(historyText).not.toContain("（套件动作说明）");
        expect(historyText).toMatch(/系统提示/);
    });

    it("只是闲聊提问时，不会被「任务还没做完」推着去动手", async () => {
        engine.script = [
            { reply: ["这个功能在角色卡页面点「新建」就能用，很简单的。"], rawAssistant: "这个功能在角色卡页面点「新建」就能用，很简单的。" },
        ];

        await sendMascotMessage({ text: "小卷，这个功能怎么用？" });

        expect(engine.calls.length).toBe(1);
        expect(executed.length).toBe(0);
    });

    it("「已完成一半，接下来…」不能被当成完工直接收工", async () => {
        engine.script = [
            action("更新角色字段"),
            { reply: ["已完成一半，接下来我还要写外貌字段。"], rawAssistant: "已完成一半，接下来我还要写外貌字段。" },
            action("更新角色字段", ["外貌来了"]),
            { reply: ["全部做好了：persona、外貌两个字段都已写入，可以直接进游戏看效果。"] },
        ];

        await sendMascotMessage({ text: "把 persona 和外貌都改一下" });

        // 第二轮那句「已完成一半」必须触发一次重试提醒，而不是 break
        expect(engine.calls.length).toBeGreaterThanOrEqual(4);
        expect(historyTextsAt(2)).toContain("系统提醒");
        expect(executed.length).toBe(2);
    });

    it("轮数用尽时在会话内告知「回复继续」并给出做了什么/还差什么", async () => {
        setPref("ai_phone_mascot_max_rounds", "3");
        engine.script = [
            action("更新角色字段"),
            action("写入CSS"),
            action("创建预设"),
            action("创建角色"),
            action("更新角色字段"),
        ];

        await sendMascotMessage({ text: "把这个角色整套都建起来" });

        // 必须是一条 AI助手气泡（工具卡片本来就可见，拿它当提示等于没提示）
        const wrapUps = visibleTexts().filter((text) => /继续|没做完|还差/.test(text));
        expect(wrapUps.length).toBeGreaterThan(0);
        expect(messages().some((msg) => msg.role === "mascot"
            && /继续/.test(msg.text || "")
            && (msg.text || "").includes("更新角色字段"))).toBe(true);
        setPref("ai_phone_mascot_max_rounds", null);
    });

    it("任务做完却只留下占位气泡时，兜底补一条进度小结", async () => {
        engine.script = [
            action("更新角色字段"),
            action("写入CSS"),
            { reply: [], rawAssistant: "" },
            { reply: [], rawAssistant: "" },
            { reply: [], rawAssistant: "" },
        ];

        await sendMascotMessage({ text: "改人设再配个 CSS" });

        // 兜底小结要挂在 AI助手气泡上，不是靠工具卡片凑出来的
        expect(messages().some((msg) => msg.role === "mascot"
            && (msg.text || "").includes("更新角色字段")
            && (msg.text || "").includes("写入CSS"))).toBe(true);
    });

    it("进度小结要点名具体对象，而不是只列动作名", async () => {
        setPref("ai_phone_mascot_max_rounds", "1");
        engine.script = [
            action("创建材料"),
            action("创建材料"),
        ];

        await sendMascotMessage({ text: "给我建一杯特调" });

        // 她要照着回执继续改，所以「创建材料」后面必须跟上是哪张卡
        expect(messages().some((msg) => msg.role === "mascot"
            && (msg.text || "").includes("创建材料：病弱少爷·云知砚"))).toBe(true);
        setPref("ai_phone_mascot_max_rounds", null);
    });
});
