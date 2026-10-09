// 默认网易云 API 地址由部署方通过环境变量提供；留空时在线音乐功能自动隐藏，
// 用户也可在音乐 APP 设置里填自己的 API 地址。不要把具体实例地址写进源码。
export const DEFAULT_NETEASE_API_BASE =
    (process.env.NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE || "").replace(/\/+$/, "");

// Bases that used to be the built-in default. Treated as "default" so devices
// that stored an old default get auto-migrated to the current upstream.
// 逗号分隔，由部署方通过环境变量提供。
const LEGACY_DEFAULT_NETEASE_API_BASES = new Set(
    (process.env.NEXT_PUBLIC_LEGACY_NETEASE_API_BASES || "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
);

export function normalizeMusicApiBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, "");
}

export function isDefaultNeteaseApiBase(baseUrl: string): boolean {
    const normalized = normalizeMusicApiBaseUrl(baseUrl);
    if (!normalized) return false;
    return normalized === DEFAULT_NETEASE_API_BASE || LEGACY_DEFAULT_NETEASE_API_BASES.has(normalized);
}
