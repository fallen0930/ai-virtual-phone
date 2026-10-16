// 体积格式化的单一来源。
// 此前 lib/data-management/backup.ts 导出了一份（0 B / B / KB / MB / GB，≥10 时取整、
// 否则一位小数），lib/qa-agent-tools.ts 又私有了一份只到 KB/MB/GB 的实现，
// 且 0 字节会显示成 "0 KB"、小于 1 KB 会四舍五入成 "0 KB"。统一取 backup.ts 口径。

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
