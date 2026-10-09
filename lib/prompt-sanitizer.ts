import { parseStateValues } from "./state-value-parser";

export function stripStateAndInnerForPrompt(text: string): string {
    if (!text) return "";
    const withoutState = parseStateValues(text).cleanText;
    return withoutState
        .replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/g, "")
        .replace(/\[内心\][\s\S]*?\[\/内心\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
