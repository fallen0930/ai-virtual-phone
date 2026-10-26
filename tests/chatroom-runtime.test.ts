import { afterEach, describe, expect, it, vi } from "vitest";
import {
    cancelAllMixGenerations,
    enqueueMixGeneration,
    enqueueMixGenerationQueued,
    getMixSessionRuntimeState,
    isMixSessionGenerating,
} from "@/lib/mixology/session-runtime";

// 聊天室（手机频道）· 生成队列
//
// 钉住的规则：
//   A 已有任务在跑时，常规 enqueue 仍是"忽略重复提交"（对局 UI 靠它防连点）。
//   B enqueueMixGenerationQueued 忙时排队而非丢弃：绑定世界的聊天/主动消息
//     判定与对局推演串行互斥，谁也不会覆盖谁的 turns。
//   C 同一个 sessionId 的排队任务去重：连点只排一个。
//   D 运行条目带 channel 标记（scene/msg），供切换器区分展示。

afterEach(() => {
    cancelAllMixGenerations();
});

describe("chatroom: 生成队列串行", () => {
    it("忙时常规入队仍被忽略，queued 入队排队等位", async () => {
        let releaseA!: () => void;
        const gate = new Promise<void>((resolve) => { releaseA = resolve; });
        let aRan = false;
        enqueueMixGeneration("s1", async () => { aRan = true; await gate; });
        expect(isMixSessionGenerating("s1")).toBe(true);

        let bRan = false;
        enqueueMixGeneration("s1", async () => { bRan = true; });
        let cRan = false;
        enqueueMixGenerationQueued("s1", async () => { cRan = true; });

        releaseA();
        await vi.waitFor(() => expect(cRan).toBe(true));
        expect(aRan).toBe(true);
        expect(bRan).toBe(false);
    });

    it("同一 sessionId 的排队任务去重，连点只排一个", async () => {
        let releaseA!: () => void;
        const gate = new Promise<void>((resolve) => { releaseA = resolve; });
        enqueueMixGeneration("s2", async () => { await gate; });

        let ranCount = 0;
        const task = async () => { ranCount += 1; };
        enqueueMixGenerationQueued("s2", task);
        enqueueMixGenerationQueued("s2", task);
        enqueueMixGenerationQueued("s2", task);

        releaseA();
        await vi.waitFor(() => expect(ranCount).toBe(1));
    });

    it("空闲时 queued 入队立即执行，不进等待", async () => {
        let ran = false;
        enqueueMixGenerationQueued("s3", async () => { ran = true; });
        await vi.waitFor(() => expect(ran).toBe(true));
    });

    it("运行条目带 channel 标记", () => {
        enqueueMixGeneration("s4", async () => {}, { channel: "msg" });
        expect(getMixSessionRuntimeState().running["s4"]?.channel).toBe("msg");
        enqueueMixGeneration("s5", async () => {});
        expect(getMixSessionRuntimeState().running["s5"]?.channel ?? "scene").toBe("scene");
    });
});
