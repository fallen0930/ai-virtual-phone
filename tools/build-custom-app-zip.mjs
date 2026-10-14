// tools/build-custom-app-zip.mjs
// 把 custom-apps/<name>/ 打成可导入「应用工坊」的 zip 包（与官方 online-plaza.zip 同构）。
//
// 用法：node tools/build-custom-app-zip.mjs file-vault
//
// 打入内容：manifest.json + entry（默认 index.html）+ icon + README.md + 其余顶层资源。
// 自动排除：目录自身、构建脚本、以及上一次生成的 <name>.zip，避免把产物打进产物。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function fail(message) {
  console.error("[build-custom-app-zip] " + message);
  process.exit(1);
}

const name = process.argv[2];
if (!name) fail("用法：node tools/build-custom-app-zip.mjs <custom-apps 下的目录名>，例：file-vault");

const appDir = path.join(ROOT, "custom-apps", name);
if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
  fail("找不到目录 custom-apps/" + name);
}

const manifestPath = path.join(appDir, "manifest.json");
if (!fs.existsSync(manifestPath)) fail("缺少 manifest.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail("manifest.json 不是有效 JSON：" + err.message);
}
if (!manifest.id || !manifest.name || !manifest.version) fail("manifest 缺少 id / name / version");

const entry = String(manifest.entry || "index.html").replace(/\\/g, "/");
const entryPath = path.join(appDir, entry);
if (!fs.existsSync(entryPath)) fail("缺少入口文件：" + entry);

const icon = String(manifest.icon || "").replace(/\\/g, "/");
if (icon && !fs.existsSync(path.join(appDir, icon))) fail("manifest.icon 指向的文件不存在：" + icon);

const SKIP = new Set([name + ".zip", "build-zip.mjs", "node_modules", ".DS_Store"]);
const entries = [];
(function walk(dir, prefix) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(item.name)) continue;
    const abs = path.join(dir, item.name);
    const rel = prefix ? prefix + "/" + item.name : item.name;
    if (item.isDirectory()) walk(abs, rel);
    else entries.push({ rel, abs });
  }
})(appDir, "");

// manifest.json 放最前，方便人肉确认包结构
entries.sort((a, b) => (a.rel === "manifest.json" ? -1 : b.rel === "manifest.json" ? 1 : a.rel.localeCompare(b.rel)));

const zip = new JSZip();
for (const item of entries) {
  zip.file(item.rel, fs.readFileSync(item.abs));
}
const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
const outPath = path.join(appDir, name + ".zip");
fs.writeFileSync(outPath, out);

const sizeKb = (out.length / 1024).toFixed(1);
console.log("[build-custom-app-zip] 已生成 " + path.relative(ROOT, outPath).replace(/\\/g, "/") + "（" + sizeKb + " KB）");
for (const item of entries) {
  console.log("  · " + item.rel + "  " + (fs.statSync(item.abs).size / 1024).toFixed(1) + " KB");
}
