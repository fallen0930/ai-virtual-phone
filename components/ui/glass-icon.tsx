"use client";

import { GLASS_ICONS } from "./glass-icon-data";

/**
 * 玻璃图标（Nucleo glass 套装，授权见 NOTICE）。
 *
 * SVG 直接内联，不走 /public 静态资源：原先 29 个图标是 29 个独立请求，进页面那一刻才开始下载，
 * 于是图标一个个往外蹦；内联后跟页面代码一起到，零额外请求。
 * 颜色已按各入口的强调色烘进 SVG 渐变里，不需要 currentColor。
 *
 * 内容来自构建期生成的常量表（scripts/build-glass-icons.mjs），非用户输入，故 innerHTML 安全。
 */
export function GlassIcon({ name, className }: { name: string; className?: string }) {
  const markup = GLASS_ICONS[name];
  if (!markup) return null;
  return (
    <span
      className={`glass-icon ${className ?? ""}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
