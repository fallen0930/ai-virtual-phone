// 离线推送的弹窗预览分条：复刻 rich-message-parser.parseAIResponse 的
// 状态值剥离 → [状态栏]/[内心] 剥离 → 双空行分条 三步（纯文本层面）。
// 只用于推送横幅文案；聊天记录的正式落账仍由客户端走完整 parseAIResponse。
// 保持零浏览器依赖：Netlify Function 与客户端共享 import。
//
// 现状（2026-10-16 走查）：本文件全仓零 import，真正的线上实现内联在
// supabase/functions/{push-generate,push-bridge,screen-chat}/index.ts 三处自包含副本里
// （Edge Function 按单文件粘贴部署，不能 import @/lib）。收敛到 _shared 之前要先解决
// scripts/build-personal-push-dist.mjs 的 copyFileSync + check:push 全文件比对链路，
// 否则 public/ai-phone-push 交付的单文件会带未解析的 import。
// 空白口径已统一：三处内联实现与本文件都用 \s+（段内换行压成空格）。
// screen-chat 原先用 [ \t]+ 保留段内换行，2026-10-16 收敛掉；
// 若要恢复该差异，需连同另两处内联点与 public/ai-phone-push 部署包一起改。

import { parseStateValues } from "./state-value-parser";

function stripBracketBlock(text: string, tag: string): string {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

/** 常见富媒体标记 → 弹窗友好文案；与 parseAndSaveResponse 的横幅口径对齐。 */
function humanizeSegment(segment: string): string {
    const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
    if (!marker) return segment;
    const kind = marker[1];
    if (/表情包/.test(kind)) return "[表情包]";
    if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
    // 通话类判断必须在 /语音/ 之前，否则 "语音通话" 会被下面的分支吞成 "[语音]"。
    // Edge Function 三份内联实现（push-generate / push-bridge / screen-chat）都是这个顺序。
    if (/语音通话/.test(kind)) return "发起了语音通话";
    if (/视频通话/.test(kind)) return "发起了视频通话";
    if (/语音/.test(kind)) return "[语音]";
    if (/红包/.test(kind)) return "[红包]";
    if (/转账/.test(kind)) return "[转账]";
    if (/位置/.test(kind)) return "[位置]";
    if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
    return segment;
}

/** 拆出推送弹窗用的每条文案（已剥状态栏/内心/状态值，双空行分条）。 */
export function splitResponseForPushPreview(rawText: string): string[] {
    let text = parseStateValues(rawText).cleanText;
    text = stripBracketBlock(text, "状态栏");
    text = stripBracketBlock(text, "内心");
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text
        .split(/\n\n+/)
        .map(segment => humanizeSegment(segment.trim()))
        .map(segment => segment.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}
