// tools/build-migration-doc.mjs
// 把「某个功能域的改动」组装成一份可供其他 AI 复现的迁移文档。
//
// 用法：node tools/build-migration-doc.mjs <源文件.md> <输出文件.md>
//
// 源文件里支持两条指令（各自独占一行）：
//   {{CODE:相对路径}}                      → 整文件原样塞进代码块（从磁盘读，绝不手抄）
//   {{HUNKS:diff路径|0,3,5}}               → 按序号抽出 diff 里的改动块，放进 diff 代码块
//
// 为什么用脚本生成而不是手写：
//   新增文件动辄几百行，手抄必错。这里所有代码都从仓库当前状态直接抽取，保证文档与真实代码一致。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function fail(msg) {
  console.error("[build-migration-doc] " + msg);
  process.exit(1);
}

const srcArg = process.argv[2];
const outArg = process.argv[3];
if (!srcArg || !outArg) fail("用法：node tools/build-migration-doc.mjs <源文件.md> <输出文件.md>");

const srcPath = path.isAbsolute(srcArg) ? srcArg : path.join(ROOT, srcArg);
const outPath = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
if (!fs.existsSync(srcPath)) fail("找不到源文件：" + srcPath);

/** 把 diff 切成改动块，返回 [{ header, body }]，body 含 @@ 行本身 */
function splitHunks(diffText) {
  const lines = diffText.split(/\r?\n/);
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (cur) hunks.push(cur);
      cur = { header: line, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** 决定围栏：文件里若出现 ``` 就把围栏加长一位 */
function fenceFor(text) {
  let n = 3;
  while (text.includes("`".repeat(n))) n += 1;
  return "`".repeat(n);
}

const LANG = {
  ".ts": "ts", ".tsx": "tsx", ".css": "css", ".mjs": "js", ".js": "js",
  ".json": "json", ".html": "html", ".md": "md", ".diff": "diff",
};

const problems = [];
const src = fs.readFileSync(srcPath, "utf8");
const outLines = [];

for (const line of src.split(/\r?\n/)) {
  const m = line.trim();
  const codeMatch = /^\{\{CODE:([^}]+)\}\}$/.exec(m);
  const hunkMatch = /^\{\{HUNKS:([^|}]+)\|([^}]+)\}\}$/.exec(m);

  if (codeMatch) {
    const rel = codeMatch[1].trim();
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      problems.push("缺文件 " + rel);
      outLines.push("> ⚠ 找不到文件 " + rel);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8").replace(/\s+$/, "");
    const lang = LANG[path.extname(rel)] || "";
    const fence = fenceFor(text);
    outLines.push(fence + lang);
    outLines.push(text);
    outLines.push(fence);
    outLines.push("");
    continue;
  }

  if (hunkMatch) {
    const relDiff = hunkMatch[1].trim();
    const indices = hunkMatch[2].split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    const absDiff = path.isAbsolute(relDiff) ? relDiff : path.join(ROOT, relDiff);
    if (!fs.existsSync(absDiff)) {
      problems.push("缺 diff " + relDiff);
      outLines.push("> ⚠ 找不到 diff " + relDiff);
      continue;
    }
    const hunks = splitHunks(fs.readFileSync(absDiff, "utf8"));
    for (const idx of indices) {
      const hunk = hunks[idx];
      if (!hunk) {
        problems.push(relDiff + " 没有第 " + idx + " 块");
        outLines.push("> ⚠ " + relDiff + " 缺少第 " + idx + " 块");
        continue;
      }
      const body = hunk.lines.join("\n").replace(/\s+$/, "");
      const fence = fenceFor(body);
      outLines.push(fence + "diff");
      outLines.push(body);
      outLines.push(fence);
      outLines.push("");
    }
    continue;
  }

  outLines.push(line);
}

fs.writeFileSync(outPath, outLines.join("\n"));
const kb = (Buffer.byteLength(outLines.join("\n"), "utf8") / 1024).toFixed(1);
console.log("[build-migration-doc] 已生成 " + path.relative(ROOT, outPath).replace(/\\/g, "/") + "（" + kb + " KB，" + outLines.length + " 行）");
if (problems.length) {
  console.log("[build-migration-doc] 有 " + problems.length + " 处问题：");
  for (const p of problems) console.log("  ! " + p);
}
