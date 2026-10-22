// 筑境 — 浏览器端模型优化（接替原服务端 npx gltf-transform 管线）。
// serverless 磁盘只读且响应上限 6MB，减面/缩贴图改在用户浏览器完成：
// 质量旋钮与原管线一致（同一个 meshoptimizer），且不消耗 Netlify 额度。

import { WebIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { weld, simplify } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

export type OptimizeOptions = {
  /** 重拓扑保留比例 0~1（与 UI 滑块一致）；0/1 或 undefined = 跳过减面 */
  ratio?: number;
  /** 贴图最长边，默认 512；0 = 不缩 */
  textureSize?: number;
  /** 含骨骼动画的模型：跳过几何操作（减面/焊接会破坏蒙皮），只缩贴图 */
  hasAnimation?: boolean;
  onProgress?: (label: string) => void;
};

async function resizeTextures(doc: Document, maxSize: number): Promise<void> {
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    const mime = texture.getMimeType();
    if (!image || !/^image\/(png|jpe?g|webp)$/.test(mime)) continue;
    try {
      const bitmap = await createImageBitmap(new Blob([image.slice().buffer], { type: mime }));
      const { width, height } = bitmap;
      if (Math.max(width, height) <= maxSize) { bitmap.close(); continue; }
      const scale = maxSize / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document_createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) { bitmap.close(); continue; }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const outBlob = await canvasToBlob(canvas, mime === "image/png" ? "image/png" : "image/jpeg", 0.9);
      if (!outBlob) continue;
      texture.setImage(new Uint8Array(await outBlob.arrayBuffer()));
      texture.setMimeType(outBlob.type);
    } catch {
      // 单张贴图失败不影响整体
    }
  }
}

function document_createCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob | null> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality }).catch(() => null);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 优化 GLB blob：减面（动画模型跳过）+ 贴图缩到 maxSize。失败时返回原 blob，不阻断流程。 */
export async function optimizeModelBlob(blob: Blob, options: OptimizeOptions = {}): Promise<Blob> {
  const { ratio, textureSize = 512, hasAnimation = false, onProgress } = options;
  try {
    onProgress?.("解析模型…");
    const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(new Uint8Array(await blob.arrayBuffer()));

    if (!hasAnimation && ratio && ratio > 0 && ratio < 1) {
      onProgress?.("减面中…");
      await MeshoptSimplifier.ready;
      await doc.transform(
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }),
      );
    }

    if (textureSize > 0) {
      onProgress?.("压缩贴图…");
      await resizeTextures(doc, textureSize);
    }

    onProgress?.("打包…");
    const out = await io.writeBinary(doc);
    // ArrayBuffer 拷贝，避免 SharedArrayBuffer 类型边界问题
    return new Blob([out.slice().buffer], { type: "model/gltf-binary" });
  } catch (err) {
    console.warn("[WorldBuilder] 浏览器端模型优化失败，使用原始模型:", err);
    return blob;
  }
}
