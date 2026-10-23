import path from "node:path";
import { defineConfig } from "vitest/config";

// Node 环境（不是 jsdom）：让所有 `typeof window === "undefined"` 分支生效，
// 从而只走 kv-db 的内存缓存层，永不连真实浏览器存储。
export default defineConfig({
  resolve: {
    alias: {
      // 与 tsconfig 的 "@/*": ["./*"] 对齐
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup/indexeddb.ts"],
    // 每个测试文件独立进程/线程，模块级单例（kv-db 内存缓存）不跨文件泄漏
    isolate: true,
  },
});
