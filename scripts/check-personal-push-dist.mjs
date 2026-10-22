#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["supabase/functions/ai-phone-push/index.ts", "public/ai-phone-push/gateway.mjs"],
  ["supabase/functions/push-generate/index.ts", "public/ai-phone-push/push-generate.mjs"],
  ["supabase/functions/push-shortcut-result/index.ts", "public/ai-phone-push/push-shortcut-result.mjs"],
  ["supabase/functions/push-bridge/index.ts", "public/ai-phone-push/push-bridge.mjs"],
  ["supabase/functions/screen-chat/index.ts", "public/ai-phone-push/screen-chat.mjs"],
  ["docs/personal-push-supabase.sql", "public/ai-phone-push/schema.sql"],
];

// public/ai-phone-push 是 build-personal-push-dist.mjs 的生成物。
// 一旦该目录不进 Git（或 CI 在 npm run build 之前跑 check:push），文件会直接缺失，
// 这里给出可操作提示而不是裸 ENOENT 堆栈；故意不在本脚本里自动构建，
// 否则"源文件 == 部署包"的比对会永远为真，校验就失去意义。
function readRequired(file) {
  try {
    return readFileSync(resolve(root, file), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(
        `[personal-push-dist] 缺少 ${file}：先运行 npm run push:build-dist；` +
        "若该路径已被 .gitignore 排除，CI/pre-push 必须把 push:build-dist 排在 check:push 之前。"
      );
      process.exit(1);
    }
    throw error;
  }
}

const failures = [];
for (const [source, output] of pairs) {
  const sourceText = readRequired(source);
  const outputText = readRequired(output);
  if (sourceText !== outputText) failures.push(`${output} 与 ${source} 不一致`);
}

const forbiddenOrigin = "floatbubble.netlify.app";
for (const file of [...new Set(pairs.flat())]) {
  if (readRequired(file).includes(forbiddenOrigin)) {
    failures.push(`${file} 含有私有站点地址`);
  }
}

if (failures.length > 0) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  console.error("请运行 npm run push:build-dist 后重试。");
  process.exit(1);
}

console.log("[personal-push-dist] 源文件、公开部署包与通用站点配置一致。");
