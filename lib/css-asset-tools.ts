import type { ToolResult } from "./tool-executor";
import type { CssAssetKind, CssAssetRecord } from "./css-asset-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "./image-generation-service";
import { loadImageGenerationSettings } from "./settings-storage";
import { loadMediaBlob, storeMediaBlob } from "./media-cache-storage";
import {
    getCssAssetRecord,
    loadCssAssetRecords,
    saveCssAssetRecord,
    updateCssAssetRecord,
} from "./css-asset-storage";

type CropMode = "coordinates" | "auto_trim";
type CropUnit = "pixel" | "percent";
type ConvertFormat = "webp" | "png" | "jpeg";
type TransparentFormat = "png" | "webp";

type ImageDimensions = {
    width: number;
    height: number;
};

type LoadedImage = ImageDimensions & {
    image: HTMLImageElement;
};

export type CssAssetUserImageHistoryMessage = {
    role?: string;
    text?: string;
    images?: string[];
};

type UserImageEntry = {
    sourceImageId: string;
    messageOffset: number;
    imageIndex: number;
    ref: string;
    messageText: string;
};

type BoundingBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type NineSliceValues = {
    selector: string;
    sliceTop: number;
    sliceRight: number;
    sliceBottom: number;
    sliceLeft: number;
    displayTop: number;
    displayRight: number;
    displayBottom: number;
    displayLeft: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
    minWidth?: number;
    minHeight?: number;
};

export type NineSliceCalibrationRequest = {
    assetId: string;
    label: string;
    mediaRef: string;
    width: number;
    height: number;
    publicUrl?: string;
    initial: NineSliceValues;
};

export type NineSliceCalibrationEventDetail = {
    request: NineSliceCalibrationRequest;
    handled: boolean;
    resolve: (values: NineSliceValues) => void;
    reject: (error: Error) => void;
};

export const NINE_SLICE_CALIBRATION_EVENT = "mascot:nine-slice-calibration";

const KIND_LABELS: Record<CssAssetKind, string> = {
    bubble: "气泡",
    icon: "图标",
    texture: "纹理",
    background: "背景",
    misc: "其他",
};

const FORMAT_MIME: Record<ConvertFormat, string> = {
    webp: "image/webp",
    png: "image/png",
    jpeg: "image/jpeg",
};

function ensureBrowserCanvas(): void {
    if (typeof window === "undefined" || typeof document === "undefined") {
        throw new Error("图像素材工具只能在浏览器里使用。");
    }
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function normalizeKind(value: unknown): CssAssetKind {
    if (value === "bubble" || value === "icon" || value === "texture" || value === "background" || value === "misc") {
        return value;
    }
    return "misc";
}

function extensionFromMime(mimeType: string): string {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    return "png";
}

function sanitizeFilename(value: string, fallback: string): string {
    const safe = value
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9._-]+/g, "")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return safe || fallback;
}

function parseHexColor(value: string | undefined): [number, number, number, number] | null {
    const raw = value?.trim().replace(/^#/, "");
    if (!raw) return null;
    if (raw.length === 3) {
        const r = Number.parseInt(raw[0] + raw[0], 16);
        const g = Number.parseInt(raw[1] + raw[1], 16);
        const b = Number.parseInt(raw[2] + raw[2], 16);
        if ([r, g, b].every(Number.isFinite)) return [r, g, b, 255];
    }
    if (raw.length === 6 || raw.length === 8) {
        const r = Number.parseInt(raw.slice(0, 2), 16);
        const g = Number.parseInt(raw.slice(2, 4), 16);
        const b = Number.parseInt(raw.slice(4, 6), 16);
        const a = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) : 255;
        if ([r, g, b, a].every(Number.isFinite)) return [r, g, b, a];
    }
    return null;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
    const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
    if (!match) return null;
    const mimeType = match[1] || "image/png";
    return { blob: base64ToBlob(match[2], mimeType), mimeType };
}

function blobToObjectUrl(blob: Blob): string {
    return URL.createObjectURL(blob);
}

async function loadImageFromBlob(blob: Blob): Promise<LoadedImage> {
    ensureBrowserCanvas();
    const url = blobToObjectUrl(blob);
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("图片解码失败"));
            img.src = url;
        });
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error("无法读取图片尺寸。");
        return { image, width, height };
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("图片导出失败。"));
                return;
            }
            resolve(blob);
        }, mimeType, quality);
    });
}

async function readDimensions(blob: Blob): Promise<ImageDimensions> {
    const loaded = await loadImageFromBlob(blob);
    return { width: loaded.width, height: loaded.height };
}

async function drawBlobToCanvas(blob: Blob): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
    const loaded = await loadImageFromBlob(blob);
    const canvas = document.createElement("canvas");
    canvas.width = loaded.width;
    canvas.height = loaded.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建图片画布。");
    context.drawImage(loaded.image, 0, 0, loaded.width, loaded.height);
    return { canvas, width: loaded.width, height: loaded.height };
}

function distanceToColor(data: Uint8ClampedArray, offset: number, color: [number, number, number, number]): number {
    return Math.max(
        Math.abs(data[offset] - color[0]),
        Math.abs(data[offset + 1] - color[1]),
        Math.abs(data[offset + 2] - color[2]),
        Math.abs(data[offset + 3] - color[3]),
    );
}

function averageCornerColor(data: Uint8ClampedArray, width: number, height: number): [number, number, number, number] {
    const sampleSize = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) / 10)));
    const points: Array<[number, number]> = [];
    for (let y = 0; y < sampleSize; y += 1) {
        for (let x = 0; x < sampleSize; x += 1) {
            points.push([x, y], [width - 1 - x, y], [x, height - 1 - y], [width - 1 - x, height - 1 - y]);
        }
    }
    const sums = [0, 0, 0, 0];
    for (const [x, y] of points) {
        const offset = (y * width + x) * 4;
        sums[0] += data[offset];
        sums[1] += data[offset + 1];
        sums[2] += data[offset + 2];
        sums[3] += data[offset + 3];
    }
    return [
        Math.round(sums[0] / points.length),
        Math.round(sums[1] / points.length),
        Math.round(sums[2] / points.length),
        Math.round(sums[3] / points.length),
    ];
}

function detectTrimBox(canvas: HTMLCanvasElement, tolerance: number): BoundingBox {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法读取图片像素。");
    const { width, height } = canvas;
    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    const corner = averageCornerColor(data, width, height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const alpha = data[offset + 3];
            const differsFromEdge = distanceToColor(data, offset, corner) > tolerance;
            const visible = alpha > 8 && (corner[3] < 16 || differsFromEdge);
            if (!visible) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (maxX < minX || maxY < minY) {
        return { x: 0, y: 0, width, height };
    }
    return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
    };
}

function pixelMatchesColor(data: Uint8ClampedArray, offset: number, color: [number, number, number, number], tolerance: number): boolean {
    if (data[offset + 3] <= 8) return true;
    return Math.max(
        Math.abs(data[offset] - color[0]),
        Math.abs(data[offset + 1] - color[1]),
        Math.abs(data[offset + 2] - color[2]),
    ) <= tolerance;
}

function removeConnectedEdgeBackground(canvas: HTMLCanvasElement, options: {
    backgroundColor?: [number, number, number, number];
    tolerance: number;
    feather: number;
}): { removedPixels: number; color: [number, number, number, number] } {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法读取图片像素。");
    const { width, height } = canvas;
    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    const color = options.backgroundColor || averageCornerColor(data, width, height);
    const tolerance = clamp(options.tolerance, 0, 255);
    const marked = new Uint8Array(width * height);
    const queue: number[] = [];

    const enqueue = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const index = y * width + x;
        if (marked[index]) return;
        const offset = index * 4;
        if (!pixelMatchesColor(data, offset, color, tolerance)) return;
        marked[index] = 1;
        queue.push(index);
    };

    for (let x = 0; x < width; x += 1) {
        enqueue(x, 0);
        enqueue(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
        enqueue(0, y);
        enqueue(width - 1, y);
    }

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        const x = index % width;
        const y = Math.floor(index / width);
        enqueue(x + 1, y);
        enqueue(x - 1, y);
        enqueue(x, y + 1);
        enqueue(x, y - 1);
    }

    for (let index = 0; index < marked.length; index += 1) {
        if (marked[index]) data[index * 4 + 3] = 0;
    }

    const featherRadius = Math.max(0, Math.min(4, Math.round(options.feather)));
    if (featherRadius > 0) {
        const featherTolerance = tolerance + featherRadius * 12;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                if (marked[index]) continue;
                let touchesBackground = false;
                for (let dy = -featherRadius; dy <= featherRadius && !touchesBackground; dy += 1) {
                    for (let dx = -featherRadius; dx <= featherRadius; dx += 1) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (marked[ny * width + nx]) {
                            touchesBackground = true;
                            break;
                        }
                    }
                }
                if (!touchesBackground) continue;
                const offset = index * 4;
                const distance = Math.max(
                    Math.abs(data[offset] - color[0]),
                    Math.abs(data[offset + 1] - color[1]),
                    Math.abs(data[offset + 2] - color[2]),
                );
                if (distance > featherTolerance) continue;
                const keepRatio = clamp((distance - tolerance) / Math.max(1, featherTolerance - tolerance), 0, 1);
                data[offset + 3] = Math.round(data[offset + 3] * keepRatio);
            }
        }
    }

    context.putImageData(imageData, 0, 0);
    return { removedPixels: queue.length, color };
}

function cropBoxFromArgs(args: {
    unit: CropUnit;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}, imageWidth: number, imageHeight: number): BoundingBox {
    const unit = args.unit;
    const scaleX = unit === "percent" ? imageWidth / 100 : 1;
    const scaleY = unit === "percent" ? imageHeight / 100 : 1;
    const x = clamp(Math.round((args.x ?? 0) * scaleX), 0, imageWidth - 1);
    const y = clamp(Math.round((args.y ?? 0) * scaleY), 0, imageHeight - 1);
    const width = clamp(Math.round((args.width ?? imageWidth) * scaleX), 1, imageWidth - x);
    const height = clamp(Math.round((args.height ?? imageHeight) * scaleY), 1, imageHeight - y);
    return { x, y, width, height };
}

function sizeLine(record: Pick<CssAssetRecord, "width" | "height" | "size" | "mimeType">): string {
    const dimensions = record.width && record.height ? `${record.width}x${record.height}` : "未知尺寸";
    const kb = record.size ? `${Math.max(1, Math.round(record.size / 1024))}KB` : "未知大小";
    return `${dimensions} / ${record.mimeType} / ${kb}`;
}

export function formatCssAssetRecord(record: CssAssetRecord): string {
    const parts = [
        `id: ${record.id}`,
        `名称: ${record.label}`,
        `类型: ${KIND_LABELS[record.kind]}`,
        `规格: ${sizeLine(record)}`,
    ];
    if (record.publicUrl) parts.push(`图床URL: ${record.publicUrl}`);
    if (record.prompt) parts.push(`提示词: ${record.prompt.slice(0, 240)}${record.prompt.length > 240 ? "..." : ""}`);
    return parts.join("\n");
}

function buildNineSliceSnippet(options: {
    selector: string;
    url: string;
    sliceTop: number;
    sliceRight: number;
    sliceBottom: number;
    sliceLeft: number;
    displayTop: number;
    displayRight: number;
    displayBottom: number;
    displayLeft: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
    minWidth?: number;
    minHeight?: number;
}): string {
    const {
        selector,
        url,
        sliceTop,
        sliceRight,
        sliceBottom,
        sliceLeft,
        displayTop,
        displayRight,
        displayBottom,
        displayLeft,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        minWidth,
        minHeight,
    } = options;
    const targetSelector = `${selector}:not(.chat-bubble-media)`;
    const minSizeLines = [
        typeof minWidth === "number" && minWidth > 0 ? `  min-width: ${Math.round(minWidth)}px;` : "",
        typeof minHeight === "number" && minHeight > 0 ? `  min-height: ${Math.round(minHeight)}px;` : "",
    ].filter(Boolean);
    return [
        `/* slice 是源图切片像素；border-width 是图片保护区显示宽度；padding 只控制文字留白，可进入保护区。 */`,
        `${targetSelector} {`,
        `  position: relative;`,
        `  isolation: isolate;`,
        `  overflow: visible !important;`,
        `  background: transparent !important;`,
        `  border: 0 !important;`,
        `  box-shadow: none;`,
        `  padding: ${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px;`,
        ...minSizeLines,
        `  box-sizing: border-box;`,
        `}`,
        `${targetSelector}::before {`,
        `  content: "";`,
        `  position: absolute;`,
        `  inset: 0;`,
        `  z-index: -1;`,
        `  pointer-events: none;`,
        `  border-style: solid;`,
        `  border-width: ${displayTop}px ${displayRight}px ${displayBottom}px ${displayLeft}px;`,
        `  border-image-source: url("${url}");`,
        `  border-image-slice: ${sliceTop} ${sliceRight} ${sliceBottom} ${sliceLeft} fill;`,
        `  border-image-width: 1;`,
        `  border-image-repeat: stretch;`,
        `  box-sizing: border-box;`,
        `}`,
        `${targetSelector} > * {`,
        `  position: relative;`,
        `  z-index: 1;`,
        `}`,
    ].join("\n");
}

function nineSliceCssFromValues(values: NineSliceValues, url: string): string {
    return buildNineSliceSnippet({ ...values, url });
}

function defaultDisplayWidth(sourceSlice: number, side: "top" | "right" | "bottom" | "left"): number {
    const max = side === "top" ? 64 : side === "bottom" ? 56 : 48;
    const min = side === "top" || side === "bottom" ? 14 : 12;
    const ratio = side === "left" || side === "right" ? 0.55 : 0.42;
    return Math.round(clamp(sourceSlice * ratio, min, max));
}

function defaultNineSliceNumbers(record: Pick<CssAssetRecord, "width" | "height">): {
    sliceTop: number;
    sliceRight: number;
    sliceBottom: number;
    sliceLeft: number;
    displayTop: number;
    displayRight: number;
    displayBottom: number;
    displayLeft: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
} {
    const width = record.width || 480;
    const height = record.height || 220;
    const sliceTop = Math.max(24, Math.round(height * 0.32));
    const sliceRight = Math.max(24, Math.round(width * 0.16));
    const sliceBottom = Math.max(22, Math.round(height * 0.24));
    const sliceLeft = Math.max(28, Math.round(width * 0.22));
    const displayTop = defaultDisplayWidth(sliceTop, "top");
    const displayRight = defaultDisplayWidth(sliceRight, "right");
    const displayBottom = defaultDisplayWidth(sliceBottom, "bottom");
    const displayLeft = defaultDisplayWidth(sliceLeft, "left");
    return {
        sliceTop,
        sliceRight,
        sliceBottom,
        sliceLeft,
        displayTop,
        displayRight,
        displayBottom,
        displayLeft,
        paddingTop: 4,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 8,
    };
}

function defaultCalibrationValues(record: Pick<CssAssetRecord, "width" | "height">, selector = ".chat-bubble-role-assistant"): NineSliceValues {
    const values = defaultNineSliceNumbers(record);
    return { selector, ...values };
}

function formatNineSliceValues(values: NineSliceValues): string {
    const lines = [
        `selector: ${values.selector}`,
        `sliceTop: ${values.sliceTop}`,
        `sliceRight: ${values.sliceRight}`,
        `sliceBottom: ${values.sliceBottom}`,
        `sliceLeft: ${values.sliceLeft}`,
        `displayTop: ${values.displayTop}`,
        `displayRight: ${values.displayRight}`,
        `displayBottom: ${values.displayBottom}`,
        `displayLeft: ${values.displayLeft}`,
        `paddingTop: ${values.paddingTop}`,
        `paddingRight: ${values.paddingRight}`,
        `paddingBottom: ${values.paddingBottom}`,
        `paddingLeft: ${values.paddingLeft}`,
    ];
    if (typeof values.minWidth === "number") lines.push(`minWidth: ${values.minWidth}`);
    if (typeof values.minHeight === "number") lines.push(`minHeight: ${values.minHeight}`);
    return lines.join("\n");
}

function requestNineSliceCalibration(request: NineSliceCalibrationRequest): Promise<NineSliceValues> {
    ensureBrowserCanvas();
    return new Promise((resolve, reject) => {
        const detail: NineSliceCalibrationEventDetail = {
            request,
            handled: false,
            resolve,
            reject,
        };
        window.dispatchEvent(new CustomEvent<NineSliceCalibrationEventDetail>(NINE_SLICE_CALIBRATION_EVENT, { detail }));
        if (!detail.handled) {
            reject(new Error("九宫格校准弹窗没有可用的前端处理器。"));
        }
    });
}

function resultWithPreview(name: string, data: string, record: CssAssetRecord): ToolResult {
    return {
        name,
        success: true,
        data,
        mediaAttachments: [{ type: "image", url: record.mediaRef, title: record.label }],
    };
}

function collectUserImageEntries(history: CssAssetUserImageHistoryMessage[] | undefined, limit = 20): UserImageEntry[] {
    if (!Array.isArray(history)) return [];
    const entries: UserImageEntry[] = [];
    let imageCounter = 1;
    let messageOffset = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message.role !== "user" || !Array.isArray(message.images) || message.images.length === 0) continue;
        const text = typeof message.text === "string" ? message.text.trim() : "";
        for (let imageIndex = 0; imageIndex < message.images.length; imageIndex += 1) {
            const ref = message.images[imageIndex];
            if (!ref) continue;
            entries.push({
                sourceImageId: `user_image_${imageCounter}`,
                messageOffset,
                imageIndex,
                ref,
                messageText: text,
            });
            imageCounter += 1;
            if (entries.length >= limit) return entries;
        }
        messageOffset += 1;
    }
    return entries;
}

async function resolveUserImageBlob(ref: string): Promise<{ blob: Blob; mimeType: string }> {
    if (ref.startsWith("data:")) {
        const converted = dataUrlToBlob(ref);
        if (!converted) throw new Error("用户图片 data URL 格式无效。");
        return converted;
    }
    const media = await loadMediaBlob(ref);
    if (!media || media.category !== "image") throw new Error("找不到这张用户图片，可能历史已被清理。");
    return { blob: media.blob, mimeType: media.mimeType };
}

function summarizeUserImageEntry(entry: UserImageEntry): string {
    const summary = entry.messageText
        ? entry.messageText.replace(/\s+/g, " ").slice(0, 48)
        : "（该消息没有文字）";
    return `· ${entry.sourceImageId} — 第 ${entry.messageOffset + 1} 条带图用户消息 / 第 ${entry.imageIndex + 1} 张 / ${summary}`;
}

export async function listUserUploadedImages(args: {
    history?: CssAssetUserImageHistoryMessage[];
    limit?: number;
}): Promise<ToolResult> {
    const limit = Math.max(1, Math.min(20, Math.round(args.limit || 12)));
    const entries = collectUserImageEntries(args.history, limit);
    if (entries.length === 0) {
        return { name: "列出用户图片", success: true, data: "最近的小卷对话里没有用户上传图片。" };
    }
    return {
        name: "列出用户图片",
        success: true,
        data: [
            `找到 ${entries.length} 张最近用户图片：`,
            ...entries.map(summarizeUserImageEntry),
            "",
            "需要加工哪张图时，把 sourceImageId 传给「导入用户图片为素材」。不传 sourceImageId 默认导入 user_image_1。",
        ].join("\n"),
        mediaAttachments: entries.slice(0, 4).map(entry => ({ type: "image", url: entry.ref, title: entry.sourceImageId })),
    };
}

export async function importUserImageAsCssAsset(args: {
    history?: CssAssetUserImageHistoryMessage[];
    sourceImageId?: string;
    messageOffset?: number;
    imageIndex?: number;
    kind?: unknown;
    label?: string;
}): Promise<ToolResult> {
    const entries = collectUserImageEntries(args.history, 40);
    if (entries.length === 0) {
        return { name: "导入用户图片为素材", success: false, error: "最近的小卷对话里没有可导入的用户图片。" };
    }
    const sourceImageId = args.sourceImageId?.trim();
    const entry = sourceImageId
        ? entries.find(item => item.sourceImageId === sourceImageId)
        : typeof args.messageOffset === "number"
            ? entries.find(item => item.messageOffset === Math.max(0, Math.floor(args.messageOffset || 0)) && item.imageIndex === Math.max(0, Math.floor(args.imageIndex || 0)))
            : entries[0];
    if (!entry) {
        return {
            name: "导入用户图片为素材",
            success: false,
            error: `找不到用户图片：${sourceImageId || `messageOffset=${args.messageOffset}, imageIndex=${args.imageIndex || 0}`}。请先调用「列出用户图片」。`,
        };
    }

    const media = await resolveUserImageBlob(entry.ref);
    const dimensions = await readDimensions(media.blob).catch(() => ({ width: undefined, height: undefined }));
    const mediaRef = await storeMediaBlob(media.blob, media.mimeType || media.blob.type || "image/png", "image");
    const kind = normalizeKind(args.kind);
    const label = args.label?.trim() || `${entry.sourceImageId}-用户素材`;
    const record = saveCssAssetRecord({
        label,
        kind,
        mediaRef,
        mimeType: media.mimeType || media.blob.type || "image/png",
        size: media.blob.size,
        width: dimensions.width,
        height: dimensions.height,
        prompt: `用户上传图片：${entry.messageText || entry.sourceImageId}`,
    });
    const data = [
        "已把用户上传图片导入 CSS 素材库。",
        `来源: ${summarizeUserImageEntry(entry).replace(/^· /, "")}`,
        formatCssAssetRecord(record),
        "后续可以继续调用「去底透明」「裁切素材」「压缩转换素材」「上传图床」或「生成九宫格CSS」。",
    ].join("\n");
    return resultWithPreview("导入用户图片为素材", data, record);
}

export async function createCssAssetFromGeneratedImage(args: {
    description: string;
    kind?: unknown;
    label?: string;
    characterId?: string;
    useReferenceImage?: boolean;
}): Promise<ToolResult> {
    const description = args.description.trim();
    if (!description) return { name: "生成图像素材", success: false, error: "description 不能为空。" };

    const settings = loadImageGenerationSettings();
    const result = await generateImageFromConfiguredApi({
        description,
        characterId: args.characterId,
        useReferenceImage: args.useReferenceImage === true,
        settings: { ...settings, enabled: true, extraPrompt: "" },
    });
    if (!result) {
        return { name: "生成图像素材", success: false, error: "生图配置不完整，请先在 Image Generation 里填写 API、Base URL 和模型名。" };
    }
    const dimensions = await readDimensions(result.blob).catch(() => ({ width: undefined, height: undefined }));
    const kind = normalizeKind(args.kind);
    const label = args.label?.trim() || generatedImageFilename(description, result.mimeType).replace(/\.[^.]+$/, "");
    const record = saveCssAssetRecord({
        label,
        kind,
        mediaRef: result.mediaRef,
        mimeType: result.mimeType,
        size: result.blob.size,
        width: dimensions.width,
        height: dimensions.height,
        prompt: result.prompt,
    });
    const data = [
        "已生成图像素材。",
        formatCssAssetRecord(record),
        result.revisedPrompt ? `模型改写提示词: ${result.revisedPrompt}` : "",
        "下一步可以用「裁切素材」自动裁边，或用「压缩转换素材」转成 WebP，再用「上传图床」拿 CSS URL。",
    ].filter(Boolean).join("\n");
    return resultWithPreview("生成图像素材", data, record);
}

export async function cropCssAsset(args: {
    assetId: string;
    cropMode?: CropMode;
    unit?: CropUnit;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    padding?: number;
    tolerance?: number;
    outputWidth?: number;
    outputHeight?: number;
    label?: string;
}): Promise<ToolResult> {
    ensureBrowserCanvas();
    const source = getCssAssetRecord(args.assetId);
    if (!source) return { name: "裁切素材", success: false, error: `找不到素材：${args.assetId}` };
    const media = await loadMediaBlob(source.mediaRef);
    if (!media) return { name: "裁切素材", success: false, error: `素材图片丢失：${args.assetId}` };

    const { canvas, width: imageWidth, height: imageHeight } = await drawBlobToCanvas(media.blob);
    const mode = args.cropMode === "auto_trim" ? "auto_trim" : "coordinates";
    const tolerance = clamp(args.tolerance ?? 18, 0, 255);
    let cropBox = mode === "auto_trim"
        ? detectTrimBox(canvas, tolerance)
        : cropBoxFromArgs({
            unit: args.unit === "percent" ? "percent" : "pixel",
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
        }, imageWidth, imageHeight);
    const padding = Math.round(args.padding ?? 0);
    if (padding !== 0) {
        const nextX = clamp(cropBox.x - padding, 0, imageWidth - 1);
        const nextY = clamp(cropBox.y - padding, 0, imageHeight - 1);
        const nextRight = clamp(cropBox.x + cropBox.width + padding, nextX + 1, imageWidth);
        const nextBottom = clamp(cropBox.y + cropBox.height + padding, nextY + 1, imageHeight);
        cropBox = { x: nextX, y: nextY, width: nextRight - nextX, height: nextBottom - nextY };
    }

    const outputWidth = Math.max(1, Math.floor(args.outputWidth || cropBox.width));
    const outputHeight = Math.max(1, Math.floor(args.outputHeight || cropBox.height));
    const output = document.createElement("canvas");
    output.width = outputWidth;
    output.height = outputHeight;
    const context = output.getContext("2d");
    if (!context) throw new Error("无法创建裁剪画布。");
    context.drawImage(
        canvas,
        cropBox.x,
        cropBox.y,
        cropBox.width,
        cropBox.height,
        0,
        0,
        outputWidth,
        outputHeight,
    );

    const outputMimeType = media.mimeType === "image/webp"
        ? "image/webp"
        : media.mimeType === "image/jpeg"
            ? "image/jpeg"
            : "image/png";
    const blob = await canvasToBlob(output, outputMimeType, outputMimeType === "image/png" ? undefined : 0.92);
    const mediaRef = await storeMediaBlob(blob, blob.type || "image/png", "image");
    const record = saveCssAssetRecord({
        label: args.label?.trim() || `${source.label}-裁切`,
        kind: source.kind,
        mediaRef,
        mimeType: blob.type || "image/png",
        size: blob.size,
        width: outputWidth,
        height: outputHeight,
        prompt: source.prompt,
        sourceAssetId: source.id,
    });
    const data = [
        mode === "auto_trim" ? "已自动裁掉透明/近似纯色边缘。" : "已按坐标裁切素材。",
        `原图: ${source.id} (${imageWidth}x${imageHeight})`,
        `裁剪框: x=${cropBox.x}, y=${cropBox.y}, width=${cropBox.width}, height=${cropBox.height}`,
        formatCssAssetRecord(record),
    ].join("\n");
    return resultWithPreview("裁切素材", data, record);
}

export async function removeCssAssetBackground(args: {
    assetId: string;
    tolerance?: number;
    feather?: number;
    backgroundColor?: string;
    format?: TransparentFormat;
    label?: string;
}): Promise<ToolResult> {
    ensureBrowserCanvas();
    const source = getCssAssetRecord(args.assetId);
    if (!source) return { name: "去底透明", success: false, error: `找不到素材：${args.assetId}` };
    const media = await loadMediaBlob(source.mediaRef);
    if (!media) return { name: "去底透明", success: false, error: `素材图片丢失：${args.assetId}` };

    const { canvas, width, height } = await drawBlobToCanvas(media.blob);
    const backgroundColor = parseHexColor(args.backgroundColor);
    const removed = removeConnectedEdgeBackground(canvas, {
        backgroundColor: backgroundColor || undefined,
        tolerance: clamp(args.tolerance ?? 36, 0, 255),
        feather: clamp(args.feather ?? 2, 0, 4),
    });
    const format = args.format === "webp" ? "webp" : "png";
    const mimeType = format === "webp" ? "image/webp" : "image/png";
    const blob = await canvasToBlob(canvas, mimeType, format === "webp" ? 0.9 : undefined);
    const mediaRef = await storeMediaBlob(blob, blob.type || mimeType, "image");
    const record = saveCssAssetRecord({
        label: args.label?.trim() || `${source.label}-透明底`,
        kind: source.kind,
        mediaRef,
        mimeType: blob.type || mimeType,
        size: blob.size,
        width,
        height,
        prompt: source.prompt,
        sourceAssetId: source.id,
    });
    const data = [
        "已把与图片外缘连通的白底/纯色底转为透明。",
        `背景采样色: rgba(${removed.color.join(", ")})`,
        `处理像素: ${removed.removedPixels}`,
        "说明: 只删除从边缘连通进来的底色，气泡内部封闭区域会保留；如果边缘仍有白边，可提高 tolerance 或 feather 后再试。",
        formatCssAssetRecord(record),
    ].join("\n");
    return resultWithPreview("去底透明", data, record);
}

export async function convertCssAsset(args: {
    assetId: string;
    format?: ConvertFormat;
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    label?: string;
}): Promise<ToolResult> {
    ensureBrowserCanvas();
    const source = getCssAssetRecord(args.assetId);
    if (!source) return { name: "压缩转换素材", success: false, error: `找不到素材：${args.assetId}` };
    const media = await loadMediaBlob(source.mediaRef);
    if (!media) return { name: "压缩转换素材", success: false, error: `素材图片丢失：${args.assetId}` };

    const loaded = await loadImageFromBlob(media.blob);
    const maxWidth = args.maxWidth && args.maxWidth > 0 ? args.maxWidth : loaded.width;
    const maxHeight = args.maxHeight && args.maxHeight > 0 ? args.maxHeight : loaded.height;
    const scale = Math.min(1, maxWidth / loaded.width, maxHeight / loaded.height);
    const width = Math.max(1, Math.round(loaded.width * scale));
    const height = Math.max(1, Math.round(loaded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建转换画布。");
    context.drawImage(loaded.image, 0, 0, width, height);

    const format = args.format === "png" || args.format === "jpeg" || args.format === "webp" ? args.format : "webp";
    const quality = clamp(args.quality ?? 0.82, 0.1, 1);
    const mimeType = FORMAT_MIME[format];
    const blob = await canvasToBlob(canvas, mimeType, format === "png" ? undefined : quality);
    const mediaRef = await storeMediaBlob(blob, blob.type || mimeType, "image");
    const record = saveCssAssetRecord({
        label: args.label?.trim() || `${source.label}-${format}`,
        kind: source.kind,
        mediaRef,
        mimeType: blob.type || mimeType,
        size: blob.size,
        width,
        height,
        prompt: source.prompt,
        sourceAssetId: source.id,
    });
    const beforeKb = Math.max(1, Math.round(source.size / 1024));
    const afterKb = Math.max(1, Math.round(blob.size / 1024));
    const data = [
        `已转换为 ${format.toUpperCase()}。`,
        `体积: ${beforeKb}KB -> ${afterKb}KB`,
        `尺寸: ${loaded.width}x${loaded.height} -> ${width}x${height}`,
        formatCssAssetRecord(record),
    ].join("\n");
    return resultWithPreview("压缩转换素材", data, record);
}

export async function listOrReadCssAssets(args: { assetId?: string }): Promise<ToolResult> {
    const assetId = args.assetId?.trim();
    if (assetId) {
        const record = getCssAssetRecord(assetId);
        if (!record) return { name: "列出读取素材", success: false, error: `找不到素材：${assetId}` };
        return resultWithPreview("列出读取素材", formatCssAssetRecord(record), record);
    }

    const records = loadCssAssetRecords().slice(0, 20);
    if (records.length === 0) {
        return { name: "列出读取素材", success: true, data: "还没有 CSS 图片素材。可以先调用「生成图像素材」。" };
    }
    const lines = records.map(record => [
        `· ${record.id}`,
        `  名称: ${record.label}`,
        `  类型: ${KIND_LABELS[record.kind]} / ${sizeLine(record)}${record.publicUrl ? " / 已上传" : ""}`,
    ].join("\n"));
    return { name: "列出读取素材", success: true, data: `最近 ${records.length} 个素材：\n${lines.join("\n")}` };
}

export function buildCssAssetNineSliceCss(args: {
    assetId?: string;
    url?: string;
    selector?: string;
    sliceTop?: number;
    sliceRight?: number;
    sliceBottom?: number;
    sliceLeft?: number;
    displayTop?: number;
    displayRight?: number;
    displayBottom?: number;
    displayLeft?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    minWidth?: number;
    minHeight?: number;
}): ToolResult {
    const record = args.assetId ? getCssAssetRecord(args.assetId) : null;
    const url = args.url || record?.publicUrl || "";
    if (!url) {
        return { name: "生成九宫格CSS", success: false, error: "请先上传素材拿到 publicUrl，或直接传 url 参数。" };
    }
    const required: Array<keyof Omit<NineSliceValues, "selector">> = [
        "sliceTop",
        "sliceRight",
        "sliceBottom",
        "sliceLeft",
        "displayTop",
        "displayRight",
        "displayBottom",
        "displayLeft",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
    ];
    const missing = required.filter((key) => typeof args[key] !== "number");
    if (missing.length > 0) {
        return {
            name: "生成九宫格CSS",
            success: false,
            error: `缺少九宫格参数：${missing.join(", ")}。请先调用「校准九宫格」让用户手动确认切线和显示尺寸，不要自动猜参数。`,
        };
    }
    const values: NineSliceValues = {
        selector: args.selector?.trim() || ".chat-bubble-role-assistant",
        sliceTop: Math.max(1, Math.round(args.sliceTop || 1)),
        sliceRight: Math.max(1, Math.round(args.sliceRight || 1)),
        sliceBottom: Math.max(1, Math.round(args.sliceBottom || 1)),
        sliceLeft: Math.max(1, Math.round(args.sliceLeft || 1)),
        displayTop: Math.max(1, Math.round(args.displayTop || 1)),
        displayRight: Math.max(1, Math.round(args.displayRight || 1)),
        displayBottom: Math.max(1, Math.round(args.displayBottom || 1)),
        displayLeft: Math.max(1, Math.round(args.displayLeft || 1)),
        paddingTop: Math.max(0, Math.round(args.paddingTop || 0)),
        paddingRight: Math.max(0, Math.round(args.paddingRight || 0)),
        paddingBottom: Math.max(0, Math.round(args.paddingBottom || 0)),
        paddingLeft: Math.max(0, Math.round(args.paddingLeft || 0)),
        minWidth: typeof args.minWidth === "number" ? Math.max(1, Math.round(args.minWidth)) : undefined,
        minHeight: typeof args.minHeight === "number" ? Math.max(1, Math.round(args.minHeight)) : undefined,
    };
    const snippet = nineSliceCssFromValues(values, url);
    const data = [
        "已生成伪元素九宫格 CSS。把这段写入 CSS，不要再给同一气泡叠加 background-size: 100% 100% 或 background-size: cover。",
        "这些参数来自用户校准；不要用系统自动猜的参数覆盖它们。",
        "",
        snippet,
    ].join("\n");
    return { name: "生成九宫格CSS", success: true, data };
}

export async function calibrateCssAssetNineSlice(args: {
    assetId: string;
    selector?: string;
}): Promise<ToolResult> {
    ensureBrowserCanvas();
    const record = getCssAssetRecord(args.assetId);
    if (!record) return { name: "校准九宫格", success: false, error: `找不到素材：${args.assetId}` };
    const media = await loadMediaBlob(record.mediaRef);
    if (!media) return { name: "校准九宫格", success: false, error: `素材图片丢失：${args.assetId}` };
    const dimensions = record.width && record.height
        ? { width: record.width, height: record.height }
        : await readDimensions(media.blob);
    const initial = defaultCalibrationValues(dimensions, args.selector?.trim() || ".chat-bubble-role-assistant");
    const values = await requestNineSliceCalibration({
        assetId: record.id,
        label: record.label,
        mediaRef: record.mediaRef,
        width: dimensions.width,
        height: dimensions.height,
        publicUrl: record.publicUrl,
        initial,
    });
    const css = record.publicUrl ? nineSliceCssFromValues(values, record.publicUrl) : "";
    const data = [
        "九宫格校准完成。",
        formatNineSliceValues(values),
        "",
        css
            ? `CSS:\n${css}`
            : "该素材还没有图床URL。请先调用「上传图床」，再用以上参数调用「生成九宫格CSS」。",
    ].join("\n");
    return { name: "校准九宫格", success: true, data };
}

async function convertBlobForUpload(record: CssAssetRecord, blob: Blob, mimeType: string): Promise<{ blob: Blob; mimeType: string; converted: boolean }> {
    const settings = loadImageGenerationSettings();
    if (!settings.imageHosting.autoConvertToWebp || mimeType === "image/webp" || mimeType === "image/gif") {
        return { blob, mimeType, converted: false };
    }
    try {
        ensureBrowserCanvas();
        const loaded = await loadImageFromBlob(blob);
        const canvas = document.createElement("canvas");
        canvas.width = loaded.width;
        canvas.height = loaded.height;
        const context = canvas.getContext("2d");
        if (!context) return { blob, mimeType, converted: false };
        context.drawImage(loaded.image, 0, 0, loaded.width, loaded.height);
        const converted = await canvasToBlob(canvas, "image/webp", 0.82);
        return { blob: converted, mimeType: converted.type || "image/webp", converted: true };
    } catch {
        return { blob, mimeType, converted: false };
    }
}

export async function uploadCssAssetToImageHost(args: {
    assetId: string;
    filename?: string;
    expirationSeconds?: number;
}): Promise<ToolResult> {
    const settings = loadImageGenerationSettings();
    const hosting = settings.imageHosting;
    if (!hosting.allowMascotUpload) {
        return { name: "上传图床", success: false, error: "当前未允许小卷上传图床。请到 Image Generation 设置里开启「允许小卷上传图床」。" };
    }
    if (hosting.provider !== "imgbb") {
        return { name: "上传图床", success: false, error: "图床提供方还没有选择 ImgBB。" };
    }
    if (!hosting.imgbbApiKey.trim()) {
        return { name: "上传图床", success: false, error: "请先填写 ImgBB API Key。" };
    }

    const record = getCssAssetRecord(args.assetId);
    if (!record) return { name: "上传图床", success: false, error: `找不到素材：${args.assetId}` };
    const media = await loadMediaBlob(record.mediaRef);
    if (!media) return { name: "上传图床", success: false, error: `素材图片丢失：${args.assetId}` };
    const prepared = await convertBlobForUpload(record, media.blob, media.mimeType);
    if (prepared.blob.size > hosting.maxUploadBytes) {
        const currentKb = Math.round(prepared.blob.size / 1024);
        const maxKb = Math.round(hosting.maxUploadBytes / 1024);
        return {
            name: "上传图床",
            success: false,
            error: `素材仍然太大：${currentKb}KB，当前上限 ${maxKb}KB。请先用「压缩转换素材」缩小尺寸或降低质量。`,
        };
    }

    const expiration = args.expirationSeconds ?? hosting.defaultExpirationSeconds;
    const normalizedExpiration = expiration > 0 ? Math.max(60, Math.min(15552000, Math.floor(expiration))) : 0;
    const fallbackName = `${record.label}.${extensionFromMime(prepared.mimeType)}`;
    const filename = sanitizeFilename(args.filename || fallbackName, fallbackName);
    const file = new File([prepared.blob], filename, { type: prepared.mimeType });
    const form = new FormData();
    form.set("apiKey", hosting.imgbbApiKey);
    form.set("expiration", String(normalizedExpiration));
    form.set("name", filename.replace(/\.[^.]+$/, ""));
    form.set("file", file);

    const response = await fetch("/api/image-hosting/imgbb", {
        method: "POST",
        body: form,
    });
    const data = await response.json().catch(() => ({})) as {
        url?: string;
        displayUrl?: string;
        deleteUrl?: string;
        width?: number;
        height?: number;
        size?: number;
        error?: string;
    };
    if (!response.ok || data.error || !data.url) {
        return { name: "上传图床", success: false, error: data.error || `ImgBB 上传失败 ${response.status}` };
    }

    const updated = updateCssAssetRecord(record.id, {
        publicUrl: data.url,
        deleteUrl: data.deleteUrl,
        width: data.width || record.width,
        height: data.height || record.height,
    }) || record;
    const resultData = [
        "已上传图床。",
        prepared.converted ? "上传前已自动转为 WebP 副本。" : "",
        formatCssAssetRecord(updated),
    ].filter(Boolean).join("\n");
    return { name: "上传图床", success: true, data: resultData };
}
