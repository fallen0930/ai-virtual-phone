import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const dirArgIndex = process.argv.indexOf("--dir");
const explicitDir = dirArgIndex >= 0 ? process.argv[dirArgIndex + 1] : "";

// 目录解析优先级与 next.config.mjs 的 resolveDistDir() 对齐：
// 显式 --dir（直接指向 CSS 目录）> NEXT_DIST_DIR（distDir，自动补 static/css）> .next/static/css。
// 注意 next.config 还有一条 "Windows 且 projectRoot 以 \\wsl$\ 开头时落到 os.tmpdir()" 的分支，
// 那条只在 Next 侧生效；仓库路径为 UNC 时本脚本会解析不到产物，属于可接受的差异（构建机不是 WSL UNC 路径）。
function resolveCssRoot() {
  if (explicitDir) {
    return { dir: path.resolve(process.cwd(), explicitDir), source: "--dir" };
  }
  const distDir = process.env.NEXT_DIST_DIR;
  if (distDir) {
    const resolved = path.basename(path.resolve(distDir)) === "css"
      ? path.resolve(distDir)
      : path.resolve(distDir, "static", "css");
    return { dir: resolved, source: `NEXT_DIST_DIR=${distDir}` };
  }
  return { dir: path.resolve(process.cwd(), ".next", "static", "css"), source: "default .next" };
}

const { dir: cssRoot, source: cssRootSource } = resolveCssRoot();

async function listCssFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listCssFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push(fullPath);
    }
  }

  return files;
}

function hasStandardBackdropFilter(block) {
  return /(^|[;{])\s*backdrop-filter\s*:/i.test(block);
}

function getWebkitBackdropValue(block) {
  const pattern = /(^|;)\s*-webkit-backdrop-filter\s*:\s*([^;{}]+?)\s*(?=;|$)/gi;
  let match;

  while ((match = pattern.exec(block)) !== null) {
    const value = match[2]?.trim();
    if (!value) continue;
    if (/^none(?:\s*!important)?$/i.test(value)) continue;
    return value;
  }

  return null;
}

function restoreBackdropFilter(css) {
  const insertions = [];
  const stack = [];
  let skippedNone = 0;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];

    if (char === "{") {
      stack.push(index);
      continue;
    }

    if (char !== "}") continue;

    const openIndex = stack.pop();
    if (openIndex === undefined) continue;

    const block = css.slice(openIndex + 1, index);
    if (!block.includes("-webkit-backdrop-filter")) continue;
    if (block.includes("{") || block.includes("}")) continue;
    if (hasStandardBackdropFilter(block)) continue;

    const value = getWebkitBackdropValue(block);
    if (!value) {
      skippedNone += 1;
      continue;
    }

    const separator = block.trimEnd().endsWith(";") ? "" : ";";
    insertions.push({
      index,
      text: `${separator}backdrop-filter:${value};`
    });
  }

  if (insertions.length === 0) {
    return { css, insertions: 0, skippedNone };
  }

  let nextCss = css;
  for (let i = insertions.length - 1; i >= 0; i -= 1) {
    const insertion = insertions[i];
    nextCss = `${nextCss.slice(0, insertion.index)}${insertion.text}${nextCss.slice(insertion.index)}`;
  }

  return { css: nextCss, insertions: insertions.length, skippedNone };
}

async function main() {
  try {
    await stat(cssRoot);
  } catch {
    throw new Error(
      `CSS build directory does not exist: ${cssRoot} (来源: ${cssRootSource}; 目录解析优先级 --dir > NEXT_DIST_DIR > .next)`
    );
  }

  const files = await listCssFiles(cssRoot);
  let touchedFiles = 0;
  let totalInsertions = 0;
  let totalSkippedNone = 0;

  for (const file of files) {
    const original = await readFile(file, "utf8");
    const result = restoreBackdropFilter(original);

    totalSkippedNone += result.skippedNone;

    if (result.insertions === 0) continue;

    touchedFiles += 1;
    totalInsertions += result.insertions;

    const relative = path.relative(process.cwd(), file);
    console.log(
      `[restore-backdrop-filter] ${dryRun ? "would update" : "updated"} ${relative}: +${result.insertions}`
    );

    if (!dryRun) {
      await writeFile(file, result.css);
    }
  }

  console.log(
    `[restore-backdrop-filter] ${dryRun ? "dry-run " : ""}css root: ${path.relative(process.cwd(), cssRoot) || cssRoot} (${cssRootSource}); scanned ${files.length} css files, ${dryRun ? "would update" : "updated"} ${touchedFiles} files, inserted ${totalInsertions} standard backdrop-filter declarations, skipped ${totalSkippedNone} none-only blocks.`
  );
}

main().catch((error) => {
  console.error("[restore-backdrop-filter] failed:", error);
  process.exit(1);
});
