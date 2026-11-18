// lib/llm-stream-diag-types.ts
// 流式诊断事件的中立类型：chat-engine 只负责在关键节点把事实抛出来，
// 由调用方（卷宝诊断日志）决定记多少。未传 sink 时整条链路零额外开销。

export type LlmStreamDiagEvent =
    | {
        type: "headers";
        at: number;
        status: number;
        requestId?: string;
    }
    | {
        type: "chunk";
        at: number;
        /** 原始解析后的 chunk（只在此刻读取 finishReason/usage，不长期持有） */
        data: unknown;
        /** 本 chunk 新增的正文字符数 */
        contentChars: number;
        /** 本 chunk 新增的思考字符数 */
        reasoningChars: number;
        sawDone: boolean;
        /** 最近若干事件的原文尾部，用于事后看 finishReason / 断流位置 */
        rawTail: string;
    }
    | {
        type: "end";
        at: number;
        sawDone: boolean;
        contentChars: number;
        reasoningChars: number;
        rawTail: string;
    }
    | {
        type: "error";
        at: number;
        message: string;
        aborted: boolean;
        timedOut: boolean;
        contentChars: number;
        reasoningChars: number;
        rawTail: string;
    };

export type LlmStreamDiagSink = (event: LlmStreamDiagEvent) => void;
