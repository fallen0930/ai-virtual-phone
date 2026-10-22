// tools/build-core-patch-zip.mjs
// 把「核心代码改动」打成一份可搬运的补丁包。
//
// 注意：这套打包和 tools/build-custom-app-zip.mjs 完全不是一回事。
//   · build-custom-app-zip  → 产出「应用工坊 → 导入」可安装的自定义 App 包（srcdoc 沙盒单页应用）
//   · build-core-patch-zip  → 产出主程序自身源码的增量补丁，只能覆盖进另一份 ai-virtual-phone 源码树
// 核心 UI（设置页 / 世界书 / 聊天室这类）无法封装成 App 包，因为它跑在沙盒外、改不了宿主界面。
//
// 用法：node tools/build-core-patch-zip.mjs <输出zip名> <文件1> [文件2 ...]
//   路径均相对项目根目录；包内按仓库原始路径存放，方便直接覆盖。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function fail(message) {
  console.error("[build-core-patch-zip] " + message);
  process.exit(1);
}

const argv = process.argv.slice(2);
const outArg = argv[0];
const files = argv.slice(1);
if (!outArg || files.length === 0) {
  fail("用法：node tools/build-core-patch-zip.mjs <输出zip名> <文件1> [文件2 ...]");
}

const outPath = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);

const zip = new JSZip();
const missing = [];
for (const arg of files) {
  // 支持 SRC=DEST：磁盘路径 SRC 打成包内路径 DEST（用于把说明文档放在包根目录）
  const [srcRaw, destRaw] = arg.split("=");
  const srcRel = srcRaw.replace(/\\/g, "/");
  const dest = (destRaw || srcRel).replace(/\\/g, "/");
  const abs = path.isAbsolute(srcRaw) ? srcRaw : path.join(ROOT, srcRel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    missing.push(srcRel);
    continue;
  }
  zip.file(dest, fs.readFileSync(abs));
}
if (missing.length) fail("以下文件不存在：" + missing.join(", "));

const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
fs.writeFileSync(outPath, out);

console.log("[build-core-patch-zip] 已生成 " + path.relative(ROOT, outPath).replace(/\\/g, "/") + "（" + (out.length / 1024).toFixed(1) + " KB）");
for (const arg of files) {
  console.log("  · " + (arg.split("=")[1] || arg.split("=")[0]).replace(/\\/g, "/"));
}
