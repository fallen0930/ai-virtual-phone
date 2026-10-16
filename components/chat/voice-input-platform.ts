"use client";

// isAndroidBrowser 的单一实现已收到 lib/browser-platform.ts，这里保留 re-export
// （group-call / video-call / voice-call / rich-input-modals 都从本模块取它）。
export { isAndroidBrowser } from "@/lib/browser-platform";

export function isIOSDevice(): boolean {
    if (typeof navigator === "undefined") return false;
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
    // iPadOS 13+ 桌面模式 UA 伪装成 Mac，但 Mac 没有多点触控
    return /Macintosh/i.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}
