// 浏览器平台判定的单一来源。
// 此前 lib/download-utils.ts 与 components/chat/voice-input-platform.ts 各有一份
// isAndroidBrowser（实现等价），现在两边只做 re-export，消费者 import 路径不变。
// iOS 判定没合并：isIOSBrowser（platform === "MacIntel"）与 isIOSDevice（UA 含 Macintosh）
// 对 iPadOS 桌面模式的覆盖面不同，需要单独定口径后再收。

/** UA 是否含 Android；SSR / Edge 运行时没有 navigator，返回 false。 */
export function isAndroidBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Android/i.test(navigator.userAgent || "");
}
