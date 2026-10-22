// lib/token-counter.ts
// Lightweight token estimation — zero external dependencies.
// CJK characters ~ 1.5 char/token, Latin ~ 4 char/token, +4 overhead per message.

const CJK_RANGE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkMatches = text.match(CJK_RANGE);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const latinCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 1.5 + latinCount / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content) + 4; // per-message overhead
    }
    return total + 2; // conversation overhead
}

export function remainingTokenBudget(
    maxContext: number,
    currentTokens: number,
    reserveForGeneration: number = 500
): number {
    return Math.max(0, maxContext - currentTokens - reserveForGeneration);
}
