export const USER_NAME_MACRO = "{{user}}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderUserNameMacro(text: string, userName?: string | null): string {
  const resolvedName = userName?.trim() || "用户";
  return String(text ?? "").replace(/\{\{\s*user\s*\}\}/gi, resolvedName);
}

export function normalizeUserNameToMacro(text: string, userName?: string | null): string {
  const source = String(text ?? "");
  const resolvedName = userName?.trim();
  if (!resolvedName || resolvedName === USER_NAME_MACRO) return source;
  return source.replace(new RegExp(escapeRegExp(resolvedName), "g"), USER_NAME_MACRO);
}
