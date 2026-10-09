// 把 assets/glass-icons/*.svg 打成一个 TS 模块，供 <GlassIcon> 内联渲染。
// 图标改动后跑：node scripts/build-glass-icons.mjs
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve("assets/glass-icons");
const OUT = path.resolve("components/ui/glass-icon-data.ts");

const files = (await readdir(SRC)).filter(f => f.endsWith(".svg")).sort();
const entries = await Promise.all(files.map(async (file) => {
    const svg = (await readFile(path.join(SRC, file), "utf8"))
        .replace(/\r?\n/g, "")
        .replace(/>\s+</g, "><")
        .trim();
    return [path.basename(file, ".svg"), svg];
}));

const body = entries
    .map(([name, svg]) => `  ${JSON.stringify(name)}: ${JSON.stringify(svg)},`)
    .join("\n");

await writeFile(OUT, `// 此文件由 scripts/build-glass-icons.mjs 生成，请勿手改。
// 源文件在 assets/glass-icons/（不进 public/，避免既内联又当静态资源发一份）。
// 内联的原因：这些图标原先是 ${entries.length} 个独立 svg 请求，进页面才开始下载，
// 会看到图标一个个蹦出来；内联后跟页面代码一起到，没有额外请求。
export const GLASS_ICONS: Record<string, string> = {
${body}
};
`, "utf8");

console.log("生成", OUT, "共", entries.length, "个图标");
