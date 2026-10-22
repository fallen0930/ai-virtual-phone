import { DOCK_DEFAULT, type DesktopIconId, type IconPosition } from "@/lib/desktop-config";
import {
  appendMissingCustomAppIcons,
  createDefaultDesktopIconLayout,
  getDesktopIconLayoutItems,
  ICON_LAYOUT_STORAGE_KEY,
  loadDesktopFolders,
  loadDockLayout,
  normalizeDesktopFolders,
  normalizeDesktopIconLayout,
  normalizeDock,
  writeDesktopIconLayout,
  writeDockLayout,
  type DesktopFolderMap,
  type DesktopIconLayout
} from "@/lib/desktop-layout-storage";
import { DEFAULT_THEME_PROFILE, normalizeThemeProfile, type ThemeAssetType, type ThemeProfile } from "@/lib/theme-types";
import {
  collectThemeAssetIds,
  deleteThemeAsset,
  readThemeAssetRecords,
  readThemeProfile,
  writeThemeAssetRecords,
  writeThemeProfile,
  type ThemeAssetRecord
} from "@/lib/theme-storage";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, type DIYTemplateSlot, type DIYWidgetTemplate, type WidgetInstance, type WidgetSize } from "@/lib/widget-types";
import { createDefaultWidgets, loadDIYTemplates, loadWidgets, saveDIYTemplates, saveWidgets } from "@/lib/widget-storage";
import { kvGet } from "@/lib/kv-db";
import type JSZip from "jszip";

const PACKAGE_SCHEMA = "ai-phone-theme-package";
const PACKAGE_VERSION = 1;

const ASSET_TYPES = new Set<ThemeAssetType>([
  "wallpaper",
  "icon_skin",
  "dock_skin",
  "font",
  "bg",
  "chat_bg",
  "sticker",
  "vn_scene",
  "vn_sprite"
]);

type ThemePackageAssetEntry = {
  id: string;
  type: ThemeAssetType;
  mimeType: string;
  path: string;
  updatedAt: string;
};

type ThemePackageManifest = {
  schema: typeof PACKAGE_SCHEMA;
  version: typeof PACKAGE_VERSION;
  exportedAt: string;
  themeProfile: ThemeProfile;
  desktop: {
    iconLayout: DesktopIconLayout;
    widgets: WidgetInstance[];
    diyTemplates: DIYWidgetTemplate[];
    /** v1 后补的可选字段（旧包没有）：dock 与文件夹随包走，导入不再丢 */
    dock?: DesktopIconId[];
    folders?: DesktopFolderMap;
  };
  assets: ThemePackageAssetEntry[];
};

export type ThemePackageSummary = {
  assetCount: number;
  widgetCount: number;
  diyTemplateCount: number;
  iconCount: number;
  hasWallpaper: boolean;
  hasFont: boolean;
};

export type InstalledThemePackage = {
  themeProfile: ThemeProfile;
  iconLayout: DesktopIconLayout;
  widgets: WidgetInstance[];
  diyTemplates: DIYWidgetTemplate[];
  summary: ThemePackageSummary;
  /** 恢复默认时重置后的 dock；旧主题包不含 dock（保留用户当前 dock）时为 undefined */
  dock?: DesktopIconId[];
  /** 包里带的文件夹表；旧包没有时为 undefined（桌面按无文件夹处理） */
  folders?: DesktopFolderMap;
};

export type CreateThemePackageInput = {
  themeProfile: ThemeProfile;
  iconLayout: DesktopIconLayout;
  widgets: WidgetInstance[];
};

export type CreatedThemePackage = {
  blob: Blob;
  fileName: string;
  summary: ThemePackageSummary;
};

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("主题包清单格式无效");
  }
}

function normalizeAssetType(value: unknown): ThemeAssetType | null {
  if (typeof value !== "string") {
    return null;
  }
  return ASSET_TYPES.has(value as ThemeAssetType) ? (value as ThemeAssetType) : null;
}

function normalizeAssetEntries(raw: unknown): ThemePackageAssetEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): ThemePackageAssetEntry[] => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const type = normalizeAssetType(candidate.type);
    if (
      typeof candidate.id !== "string" ||
      !type ||
      typeof candidate.mimeType !== "string" ||
      typeof candidate.path !== "string"
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      type,
      mimeType: candidate.mimeType,
      path: candidate.path,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString()
    }];
  });
}

function normalizeWidgetSize(value: unknown): WidgetSize | null {
  if (typeof value !== "string") {
    return null;
  }
  return value in WIDGET_SIZE_CELLS ? (value as WidgetSize) : null;
}

function normalizeWidgets(raw: unknown): WidgetInstance[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): WidgetInstance[] => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const size = normalizeWidgetSize(candidate.size);
    const page = typeof candidate.page === "number" && Number.isInteger(candidate.page) && candidate.page >= 1
      ? candidate.page
      : null;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.type !== "string" ||
      !size ||
      !page ||
      typeof candidate.row !== "number" ||
      typeof candidate.col !== "number"
    ) {
      return [];
    }

    const [rows, cols] = WIDGET_SIZE_CELLS[size];
    if (
      candidate.row < 1 ||
      candidate.col < 1 ||
      candidate.row + rows - 1 > GRID_ROWS ||
      candidate.col + cols - 1 > GRID_COLS
    ) {
      return [];
    }

    const config = candidate.config && typeof candidate.config === "object" && !Array.isArray(candidate.config)
      ? (candidate.config as Record<string, unknown>)
      : undefined;

    return [{
      id: candidate.id,
      type: candidate.type,
      size,
      page,
      row: candidate.row,
      col: candidate.col,
      ...(config ? { config } : {})
    }];
  });
}

function normalizeSlots(raw: unknown): DIYTemplateSlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): DIYTemplateSlot[] => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.top !== "number" ||
      typeof candidate.bottom !== "number" ||
      typeof candidate.left !== "number" ||
      typeof candidate.right !== "number"
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      top: candidate.top,
      bottom: candidate.bottom,
      left: candidate.left,
      right: candidate.right
    }];
  });
}

function normalizeDIYTemplates(raw: unknown): DIYWidgetTemplate[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): DIYWidgetTemplate[] => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const size = normalizeWidgetSize(candidate.size);
    const mode = candidate.mode === "code" ? "code" : candidate.mode === "image" ? "image" : null;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !size || !mode) {
      return [];
    }

    const template: DIYWidgetTemplate = {
      id: candidate.id,
      name: candidate.name,
      size,
      mode
    };

    if (mode === "image") {
      if (typeof candidate.bgAssetId === "string") {
        template.bgAssetId = candidate.bgAssetId;
      }
      template.slots = normalizeSlots(candidate.slots);
    } else if (typeof candidate.htmlString === "string") {
      template.htmlString = candidate.htmlString;
    }

    return [template];
  });
}

function normalizeManifest(raw: unknown): ThemePackageManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("主题包清单缺失");
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.schema !== PACKAGE_SCHEMA || candidate.version !== PACKAGE_VERSION) {
    throw new Error("不支持的主题包版本");
  }

  const desktop = candidate.desktop && typeof candidate.desktop === "object"
    ? (candidate.desktop as Record<string, unknown>)
    : {};
  // 文件夹先归一（成员按本机已装过滤），布局归一时放行它们的 tile——
  // 否则 folder tile 会被当成不认识的图标丢掉，整夹内容随之蒸发
  const folders = desktop.folders !== undefined ? normalizeDesktopFolders(desktop.folders) : undefined;
  const iconLayout = normalizeDesktopIconLayout(desktop.iconLayout, folders ? new Set(Object.keys(folders)) : undefined);
  const dock = desktop.dock !== undefined ? normalizeDock(desktop.dock) : undefined;
  const widgets = normalizeWidgets(desktop.widgets);
  const diyTemplates = normalizeDIYTemplates(desktop.diyTemplates);
  const themeProfile = normalizeThemeProfile(candidate.themeProfile);

  return {
    schema: PACKAGE_SCHEMA,
    version: PACKAGE_VERSION,
    exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : new Date().toISOString(),
    themeProfile,
    desktop: {
      iconLayout,
      widgets,
      diyTemplates,
      dock,
      folders
    },
    assets: normalizeAssetEntries(candidate.assets)
  };
}
function collectDIYTemplateAssetIds(templates: DIYWidgetTemplate[]): string[] {
  return templates.map((template) => template.bgAssetId).filter((id): id is string => Boolean(id));
}

function collectPackageAssetIds(themeProfile: ThemeProfile, diyTemplates: DIYWidgetTemplate[]): string[] {
  return Array.from(new Set([
    ...collectThemeAssetIds(themeProfile),
    ...collectDIYTemplateAssetIds(diyTemplates)
  ]));
}

function collectResetDeleteAssetIds(themeProfile: ThemeProfile): string[] {
  const wallpaperLibrary = new Set(themeProfile.wallpaperLibrary);
  const iconIds = Object.values(themeProfile.iconSkins).filter((value): value is string => Boolean(value));
  const iconSchemeIds = themeProfile.iconSchemes.flatMap((scheme) =>
    Object.values(scheme.iconSkins).filter((value): value is string => Boolean(value))
  );
  return Array.from(new Set([
    themeProfile.wallpaperAssetId && !wallpaperLibrary.has(themeProfile.wallpaperAssetId)
      ? themeProfile.wallpaperAssetId
      : "",
    themeProfile.fontAssetId ?? "",
    themeProfile.dockSkinAssetId ?? "",
    ...iconIds,
    ...iconSchemeIds
  ].filter(Boolean)));
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "font/ttf") return "ttf";
  if (mimeType === "font/otf") return "otf";
  if (mimeType === "font/woff") return "woff";
  if (mimeType === "font/woff2") return "woff2";
  return "bin";
}

function assetPath(record: ThemeAssetRecord, index: number): string {
  const safeId = record.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "asset";
  return `assets/${String(index + 1).padStart(3, "0")}-${safeId}.${extensionForMimeType(record.mimeType)}`;
}

function dataUrlBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function makeSummary(manifest: ThemePackageManifest): ThemePackageSummary {
  const iconCount = getDesktopIconLayoutItems(manifest.desktop.iconLayout)
    .filter((item): item is IconPosition => Boolean(item)).length;

  return {
    assetCount: manifest.assets.length,
    widgetCount: manifest.desktop.widgets.length,
    diyTemplateCount: manifest.desktop.diyTemplates.length,
    iconCount,
    hasWallpaper: Boolean(manifest.themeProfile.wallpaperAssetId || manifest.themeProfile.wallpaperLibrary.length > 0),
    hasFont: Boolean(manifest.themeProfile.fontAssetId)
  };
}

function packageFileName(themeProfile: ThemeProfile): string {
  const name = (themeProfile.name || "theme").replace(/[\\/:*?"<>|]+/g, "-").trim() || "theme";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  // 用标准 .zip 后缀：iOS/桌面都原生识别，选择器不置灰。导入端按包内
  // manifest.json 校验内容，旧的 .ai-theme 文件仍可正常导入。
  return `${name}-${stamp}.zip`;
}

async function loadZip(file: File) {
  const zip = await openZip(file);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    throw new Error("主题包缺少 manifest.json");
  }

  const rawManifest = safeJsonParse(await manifestFile.async("text"));
  return { zip, manifest: normalizeManifest(rawManifest) };
}

async function openZip(file: File): Promise<JSZip> {
  const JSZipCtor = (await import("jszip")).default;
  return JSZipCtor.loadAsync(await file.arrayBuffer());
}

/* ═══════════════════════════════════════════
   美化包预览（内存态，不落盘）
   - 标准包：manifest.json + assets/，与导出格式一致
   - 社区 css 包：无 manifest 也能进——zip 里的 *.css 合并进
     globalCustomCSS，url() 相对引用改写为包内文件的 dataURL
   - 预览只读 zip、只产内存对象；应用（commit）才写存储
   ═══════════════════════════════════════════ */

const CSS_FILE_MAX_BYTES = 1024 * 1024;      // 单个 .css 上限 1MB
const CSS_URL_FILE_MAX_BYTES = 12 * 1024 * 1024; // url() 内联的单个文件上限 12MB
const CSS_FILE_MAX_COUNT = 8;

const MIME_BY_EXT: Record<string, string> = {
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2"
};

function mimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function normalizeRelPath(dir: string, ref: string): string {
  const clean = ref.replace(/[?#].*$/, "").replace(/^["']|["']$/g, "").trim();
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//") || clean.startsWith("data:") || clean.startsWith("/")) {
    return "";
  }
  const parts = (dir ? `${dir}/` : "") + clean;
  const out: string[] = [];
  for (const seg of parts.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** 在 zip 里找一个引用路径：先精确相对路径，再退化到全包同名文件 */
function findZipFile(zip: JSZip, dir: string, ref: string): { path: string; file: JSZip.JSZipObject } | null {
  const normalized = normalizeRelPath(dir, ref);
  if (!normalized) return null;
  const direct = zip.file(normalized);
  if (direct) return { path: normalized, file: direct };
  const base = normalized.split("/").pop() ?? normalized;
  let fallback: { path: string; file: JSZip.JSZipObject } | null = null;
  zip.forEach((path, entry) => {
    if (!fallback && !entry.dir && path.split("/").pop() === base) fallback = { path, file: entry };
  });
  return fallback;
}

async function inlineCssUrls(css: string, cssPath: string, zip: JSZip): Promise<string> {
  const dir = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/")) : "";
  // 先收集全部可解析引用，再并行取 base64
  const refs = new Map<string, string>();
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const raw = (match[2] ?? "").trim();
    if (!raw || refs.has(raw)) continue;
    const found = findZipFile(zip, dir, raw);
    if (found) refs.set(raw, found.path);
  }
  if (refs.size === 0) return css;

  const dataUrls = new Map<string, string>();
  await Promise.all([...refs.entries()].map(async ([raw, path]) => {
    const file = zip.file(path);
    if (!file) return;
    const content = await file.async("uint8array");
    if (content.byteLength > CSS_URL_FILE_MAX_BYTES) return;
    const base64 = await file.async("base64");
    dataUrls.set(raw, `data:${mimeForPath(path)};base64,${base64}`);
  }));

  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote: string | undefined, raw: string) => {
    const dataUrl = dataUrls.get((raw ?? "").trim());
    return dataUrl ? `url("${dataUrl}")` : full;
  });
}

async function collectPackCss(zip: JSZip): Promise<string> {
  const cssEntries: { path: string; file: JSZip.JSZipObject }[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir || !/\.css$/i.test(path) || path === "manifest.json") return;
    if (cssEntries.length >= CSS_FILE_MAX_COUNT) return;
    cssEntries.push({ path, file: entry });
  });
  cssEntries.sort((a, b) => a.path.localeCompare(b.path));

  const chunks: string[] = [];
  for (const { path, file } of cssEntries) {
    const text = await file.async("string");
    if (!text.trim()) continue;
    if (new TextEncoder().encode(text).byteLength > CSS_FILE_MAX_BYTES) {
      throw new Error(`美化包 CSS 超过 1MB：${path}`);
    }
    chunks.push(`/* ${path} */\n${await inlineCssUrls(text, path, zip)}`);
  }
  return chunks.join("\n\n");
}

function currentDesktopSnapshot(): ThemePackagePreview["desktop"] {
  const folders = loadDesktopFolders();
  let layout: DesktopIconLayout;
  try {
    const raw = kvGet(ICON_LAYOUT_STORAGE_KEY);
    layout = raw ? normalizeDesktopIconLayout(JSON.parse(raw), new Set(Object.keys(folders))) : createDefaultDesktopIconLayout();
  } catch {
    layout = createDefaultDesktopIconLayout();
  }
  return {
    iconLayout: layout,
    widgets: loadWidgets(),
    diyTemplates: loadDIYTemplates(),
    dock: loadDockLayout(),
    folders
  };
}

export type ThemePackagePreview = {
  /** package：标准主题包；css-pack：无 manifest 的纯美化 css 包 */
  kind: "package" | "css-pack";
  name: string;
  exportedAt?: string;
  themeProfile: ThemeProfile;
  /** css-pack 也带当前桌面快照，应用时原样回写，不动布局 */
  desktop: ThemePackagePreviewDesktop;
  assets: ThemeAssetRecord[];
  /** 从 zip 内 .css 文件合并进来的字节数（0 = 没合） */
  mergedCssBytes: number;
  summary: ThemePackageSummary;
};

type ThemePackagePreviewDesktop = {
  iconLayout: DesktopIconLayout;
  widgets: WidgetInstance[];
  diyTemplates: DIYWidgetTemplate[];
  dock?: DesktopIconId[];
  folders?: DesktopFolderMap;
};

export async function previewThemePackageFile(file: File): Promise<ThemePackagePreview> {
  const zip = await openZip(file);
  const manifestFile = zip.file("manifest.json");
  const fallbackName = file.name.replace(/\.(zip|ai-theme|aiphone)$/i, "") || "未命名美化包";

  if (!manifestFile) {
    // 纯 css 美化包：只换 CSS，不动桌面/资产
    const mergedCss = await collectPackCss(zip);
    if (!mergedCss) {
      throw new Error("不是可识别的主题包：缺少 manifest.json，也没有 .css 文件");
    }
    const current = normalizeThemeProfile(readThemeProfile());
    const themeProfile = normalizeThemeProfile({
      ...current,
      name: current.name || fallbackName,
      globalCustomCSS: current.globalCustomCSS
        ? `${current.globalCustomCSS}\n\n/* 美化包：${fallbackName} */\n${mergedCss}`
        : mergedCss
    });
    const desktop = currentDesktopSnapshot();
    return {
      kind: "css-pack",
      name: fallbackName,
      themeProfile,
      desktop,
      assets: [],
      mergedCssBytes: mergedCss.length,
      summary: makeSummary({
        schema: PACKAGE_SCHEMA,
        version: PACKAGE_VERSION,
        exportedAt: new Date().toISOString(),
        themeProfile,
        desktop,
        assets: []
      })
    };
  }

  const manifest = normalizeManifest(safeJsonParse(await manifestFile.async("text")));

  const assets: ThemeAssetRecord[] = [];
  for (const asset of manifest.assets) {
    const assetFile = zip.file(asset.path);
    if (!assetFile) {
      throw new Error(`主题包缺少资源：${asset.path}`);
    }
    const base64 = await assetFile.async("base64");
    assets.push({
      id: asset.id,
      type: asset.type,
      mimeType: asset.mimeType,
      dataUrl: `data:${asset.mimeType};base64,${base64}`,
      updatedAt: asset.updatedAt
    });
  }

  // 包里附带 .css 且档案本身没写 globalCustomCSS 时合并进来；
  // 档案自带 CSS 的（我们的导出）以档案为准，避免导出再导入时翻倍
  let themeProfile = manifest.themeProfile;
  let mergedCssBytes = 0;
  if (!themeProfile.globalCustomCSS.trim()) {
    const merged = await collectPackCss(zip);
    if (merged) {
      themeProfile = normalizeThemeProfile({ ...themeProfile, globalCustomCSS: merged });
      mergedCssBytes = merged.length;
    }
  }

  // 主题包布局不含本机安装的自定义 app 图标，补回空位，避免导入后 app 从桌面消失
  const packageDock = manifest.desktop.dock ?? loadDockLayout();
  const packageFolderIds = manifest.desktop.folders ? new Set(Object.keys(manifest.desktop.folders)) : undefined;
  const folderMembers = Object.values(manifest.desktop.folders ?? {}).flatMap((f) => f.icons);
  const iconLayout = appendMissingCustomAppIcons(
    manifest.desktop.iconLayout,
    manifest.desktop.widgets,
    [...packageDock, ...folderMembers]
  );

  const previewManifest = { ...manifest, themeProfile, desktop: { ...manifest.desktop, iconLayout } };
  return {
    kind: "package",
    name: themeProfile.name || fallbackName,
    exportedAt: manifest.exportedAt,
    themeProfile,
    desktop: {
      iconLayout,
      widgets: manifest.desktop.widgets,
      diyTemplates: manifest.desktop.diyTemplates,
      dock: manifest.desktop.dock,
      folders: manifest.desktop.folders
    },
    assets,
    mergedCssBytes,
    summary: makeSummary(previewManifest)
  };
}

/** 预览确认后落盘：资产进 IndexedDB、DIY 模板入库，返回给桌面做持久化替换。
 *  主题档案与桌面布局的落盘由调用方（applyTheme / handleThemeDesktopChange）完成。
 *  css-pack 的 desktop 只是解析当刻的现状快照，绝不能反写 DIY 模板——
 *  预览期间用户可能又编辑了模板，以存储里的最新值为准。 */
export async function commitThemePackagePreview(preview: ThemePackagePreview): Promise<InstalledThemePackage> {
  await writeThemeAssetRecords(preview.assets);
  if (preview.kind === "package") {
    saveDIYTemplates(preview.desktop.diyTemplates);
  }
  return {
    themeProfile: preview.themeProfile,
    iconLayout: preview.desktop.iconLayout,
    widgets: preview.desktop.widgets,
    diyTemplates: preview.desktop.diyTemplates,
    dock: preview.desktop.dock,
    folders: preview.desktop.folders,
    summary: preview.summary
  };
}

export async function createThemePackageBlob(input: CreateThemePackageInput): Promise<CreatedThemePackage> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const themeProfile = normalizeThemeProfile(input.themeProfile);
  const diyTemplates = loadDIYTemplates();
  const assetRecords = await readThemeAssetRecords(collectPackageAssetIds(themeProfile, diyTemplates));
  const assets = assetRecords.map((record, index) => ({
    id: record.id,
    type: record.type,
    mimeType: record.mimeType,
    path: assetPath(record, index),
    updatedAt: record.updatedAt
  }));

  assetRecords.forEach((record, index) => {
    zip.file(assets[index].path, dataUrlBase64(record.dataUrl), { base64: true });
  });

  // dock 与文件夹随包走：布局里的 folder tile 要靠文件夹表才放得行，
  // 不带的话导出即丢（tile 被归一化过滤、成员没处可查）
  const exportFolders = loadDesktopFolders();
  const manifest: ThemePackageManifest = {
    schema: PACKAGE_SCHEMA,
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    themeProfile,
    desktop: {
      iconLayout: normalizeDesktopIconLayout(input.iconLayout, new Set(Object.keys(exportFolders))),
      widgets: normalizeWidgets(input.widgets),
      diyTemplates,
      dock: loadDockLayout(),
      folders: exportFolders
    },
    assets
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });

  return {
    blob,
    fileName: packageFileName(themeProfile),
    summary: makeSummary(manifest)
  };
}

export async function inspectThemePackageFile(file: File): Promise<ThemePackageSummary> {
  const { manifest } = await loadZip(file);
  return makeSummary(manifest);
}

/**
 * 主题包已装好、请桌面刷新（detail 带 installThemePackageFile 的返回值）。
 * 资源集市在 lib 里够不着外观页那两个 React 回调，改派这个事件，
 * 桌面 shell 走与外观页导入完全相同的落地路径。
 * 2026-10-20 起集市改派 PREVIEW_REQUESTED 走"先预览再应用"；
 * 本事件保留给仍想直接落地的调用方。
 */
export const THEME_PACKAGE_INSTALLED_EVENT = "ai-phone-theme-package-installed";

/** 请桌面进入美化包预览态（detail 带 previewThemePackageFile 的返回值），未确认前不落盘 */
export const THEME_PACKAGE_PREVIEW_REQUESTED_EVENT = "ai-phone-theme-package-preview-requested";

export async function installThemePackageFile(file: File): Promise<InstalledThemePackage> {
  const preview = await previewThemePackageFile(file);
  const installed = await commitThemePackagePreview(preview);
  writeThemeProfile(installed.themeProfile);
  saveWidgets(installed.widgets);
  const packageFolderIds = installed.folders ? new Set(Object.keys(installed.folders)) : undefined;
  const iconLayout = writeDesktopIconLayout(installed.iconLayout, packageFolderIds);
  if (installed.dock) writeDockLayout(installed.dock);
  return { ...installed, iconLayout };
}

export async function resetThemePackageState(): Promise<InstalledThemePackage> {
  const previousProfile = readThemeProfile();
  const previousTemplates = loadDIYTemplates();
  const assetIds = collectResetDeleteAssetIds(previousProfile);
  await Promise.all(assetIds.map((id) => deleteThemeAsset(id)));

  const themeProfile = writeThemeProfile({
    ...DEFAULT_THEME_PROFILE,
    wallpaperAssetId: null,
    wallpaperLibrary: previousProfile.wallpaperLibrary
  });
  const widgets = createDefaultWidgets();
  // dock 一并恢复出厂，否则被拖出 dock 的默认图标（如设置）会在重置后彻底丢失
  const dock = writeDockLayout([...DOCK_DEFAULT]);
  // 出厂布局只含内置图标，把已安装的自定义 app 图标补回空位，避免重置后 app 从桌面消失
  const iconLayout = writeDesktopIconLayout(
    appendMissingCustomAppIcons(createDefaultDesktopIconLayout(widgets), widgets, dock)
  );
  saveDIYTemplates(previousTemplates);
  saveWidgets(widgets);

  return {
    themeProfile,
    iconLayout,
    widgets,
    dock,
    folders: {},
    diyTemplates: previousTemplates,
    summary: {
      assetCount: previousProfile.wallpaperLibrary.length + collectDIYTemplateAssetIds(previousTemplates).length,
      widgetCount: widgets.length,
      diyTemplateCount: previousTemplates.length,
      iconCount: getDesktopIconLayoutItems(iconLayout).length,
      hasWallpaper: previousProfile.wallpaperLibrary.length > 0,
      hasFont: false
    }
  };
}
