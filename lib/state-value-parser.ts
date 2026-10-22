// lib/state-value-parser.ts

import type { StateValue } from "./chat-storage";

export type ParseStateResult = {
    cleanText: string;
    stateValues: StateValue[];
};

/** Rich media tag names that should NOT be treated as state values */
const RICH_MEDIA_NAMES = new Set([
    "红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐",
]);

/**
 * Extract [名称:数值] tags from text.
 * Supports full-width colon (：) and half-width colon (:).
 * Values are clamped to 0-100. Duplicate names keep the last occurrence.
 */
export function parseStateValues(text: string): ParseStateResult {
    if (!text) return { cleanText: "", stateValues: [] };

    const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
    const map = new Map<string, number>();
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        const name = match[1].trim();
        const value = parseFloat(match[2]);
        // Skip pure-number names (e.g. [20:33] is a timestamp, not a state value)
        // Skip known rich media tag names (e.g. [表情包:11])
        if (name && !isNaN(value) && !/^\d+$/.test(name) && !RICH_MEDIA_NAMES.has(name)) {
            map.set(name, Math.max(0, Math.min(100, value)));
        }
    }

    // Only strip tags that were recognized as valid state values
    const cleanText = text.replace(regex, (m, rawName) => {
        return map.has(rawName.trim()) ? "" : m;
    }).trim();
    const stateValues: StateValue[] = Array.from(map.entries()).map(([name, value]) => ({ name, value }));

    return { cleanText, stateValues };
}

/**
 * Merge current state values with previous ones.
 * - Current values overwrite previous values for the same name.
 * - Fields in previous but not in current are preserved (inherited).
 * - If current is empty, returns previous as-is.
 */
export function mergeStateValues(
    previous: StateValue[],
    current: StateValue[],
): StateValue[] {
    if (current.length === 0) return previous;

    const resultMap = new Map<string, number>();
    for (const sv of previous) {
        resultMap.set(sv.name, sv.value);
    }
    for (const sv of current) {
        resultMap.set(sv.name, sv.value);
    }

    return Array.from(resultMap.entries()).map(([name, value]) => ({ name, value }));
}
