// lib/mascot-prefs.ts
// 卷宝的两项可调护栏，与工坊（lib/qa-prefs.ts）同款口径：
// localStorage 键覆盖，取不到或越界即回默认值；Node/无存储环境下静默走默认。

const MAX_OUTPUT_TOKENS_KEY = "ai_phone_mascot_max_output_tokens";
const MAX_ROUNDS_KEY = "ai_phone_mascot_max_rounds";

// 单次最大输出 token（物理护栏）：设置后卷宝每次请求都带 max_tokens，超长输出被服务端
// 安全截断而不是拖垮整轮；引擎会把该预算写进系统提示，并在截断后自动续接。
// 存 "0" 表示显式不传该参数（兼容不支持 max_tokens 的模型/中转）。
export const MASCOT_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const MASCOT_MAX_OUTPUT_TOKENS_MIN = 256;
export const MASCOT_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

// 单轮工具调用上限：一次提问里卷宝最多连续执行多少轮动作，用完会在会话里提示「回复继续」。
export const MASCOT_DEFAULT_MAX_ROUNDS = 20;
export const MASCOT_MAX_ROUNDS_MIN = 1;
export const MASCOT_MAX_ROUNDS_MAX = 50;

export function getMascotMaxOutputTokens(): number | null {
    try {
        const stored = localStorage.getItem(MAX_OUTPUT_TOKENS_KEY);
        if (stored === "0") return null; // 显式不传
        const raw = Number(stored);
        if (Number.isFinite(raw) && raw >= MASCOT_MAX_OUTPUT_TOKENS_MIN && raw <= MASCOT_MAX_OUTPUT_TOKENS_MAX) {
            return Math.floor(raw);
        }
    } catch {
        // ignore
    }
    return MASCOT_DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 设置单次最大输出 token：null = 恢复默认；0 = 显式不传该参数 */
export function setMascotMaxOutputTokens(tokens: number | null): void {
    try {
        if (tokens === null) {
            localStorage.removeItem(MAX_OUTPUT_TOKENS_KEY);
        } else if (tokens === 0) {
            localStorage.setItem(MAX_OUTPUT_TOKENS_KEY, "0");
        } else {
            const clamped = Math.min(MASCOT_MAX_OUTPUT_TOKENS_MAX, Math.max(MASCOT_MAX_OUTPUT_TOKENS_MIN, Math.floor(tokens)));
            localStorage.setItem(MAX_OUTPUT_TOKENS_KEY, String(clamped));
        }
    } catch {
        // ignore
    }
}

export function getMascotMaxRounds(): number {
    try {
        const raw = Number(localStorage.getItem(MAX_ROUNDS_KEY));
        if (Number.isFinite(raw) && raw >= MASCOT_MAX_ROUNDS_MIN && raw <= MASCOT_MAX_ROUNDS_MAX) {
            return Math.floor(raw);
        }
    } catch {
        // ignore
    }
    return MASCOT_DEFAULT_MAX_ROUNDS;
}

/** 设置单轮工具调用上限（null = 恢复默认） */
export function setMascotMaxRounds(rounds: number | null): void {
    try {
        if (rounds === null) {
            localStorage.removeItem(MAX_ROUNDS_KEY);
        } else {
            const clamped = Math.min(MASCOT_MAX_ROUNDS_MAX, Math.max(MASCOT_MAX_ROUNDS_MIN, Math.floor(rounds)));
            localStorage.setItem(MAX_ROUNDS_KEY, String(clamped));
        }
    } catch {
        // ignore
    }
}
