"use client";

import { useState, useEffect } from "react";
import { PRESET_MODELS } from "./scene-store";
import { getThumbnail } from "./thumbnail-generator";
import type { UserModel } from "./model-db";

interface ModelItem {
  url: string;
  name: string;
  category: string;
  characterId?: string;
}

// 预设 .glb 用预生成的静态缩略图（scripts/gen-model-thumbnails.mjs，命名规则需与脚本一致）。
// 打开素材库只下这些几 KB 的小图，完整模型仅在「放置」时才加载——避免"开库即下全部模型"。
const isPresetGlb = (url: string) => url.startsWith("/models/");
const presetThumbUrl = (url: string) =>
  "/models/_thumbs/" +
  url.replace(/^\/models\//, "").replace(/\.glb$/i, "").replace(/\//g, "__") +
  ".webp";

interface Props {
  userModels: UserModel[];
  onPlace: (modelUrl: string, name: string, characterId?: string) => void;
}

export default function ModelPalette({ userModels, onPlace }: Props) {
  const [category, setCategory] = useState<string>("全部");
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());

  // 仅为灯光/基础块这类无 .glb 的预设动态生成缩略图（程序生成的小球小方块，不走网络）；
  // .glb 预设走静态 webp，不在此加载模型。
  useEffect(() => {
    PRESET_MODELS.filter((m) => !isPresetGlb(m.url)).forEach(async (m) => {
      try {
        const url = await getThumbnail(m.url);
        setThumbs((prev) => new Map(prev).set(m.url, url));
      } catch {}
    });
  }, []);

  // 生成用户模型缩略图
  useEffect(() => {
    userModels.forEach(async (m) => {
      const key = m.blobUrl || m.id;
      if (thumbs.has(key)) return;
      try {
        const url = await getThumbnail(key);
        setThumbs((prev) => new Map(prev).set(key, url));
      } catch {}
    });
  }, [userModels]);

  // 合并预设 + 用户模型
  const allModels: ModelItem[] = [
    ...PRESET_MODELS.map((m) => ({ url: m.url, name: m.name, category: m.category })),
    ...userModels.map((m) => ({ url: m.blobUrl || m.id, name: m.name, category: m.category, characterId: m.characterId })),
  ];

  // 收集所有分类
  const allCategories = [...new Set(allModels.map((m) => m.category))];

  const filtered = category === "全部"
    ? allModels
    : allModels.filter((m) => m.category === category);

  return (
    <div className="wb-palette">
      <div className="wb-categories">
        {["全部", ...allCategories].map((c) => (
          <button
            key={c}
            className={category === c ? "active" : ""}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="wb-model-list">
        {filtered.map((m, i) => (
          <button
            key={m.url + i}
            className="wb-model-item"
            onClick={() => onPlace(m.url, m.name, m.characterId)}
          >
            <div className="wb-model-thumb">
              {isPresetGlb(m.url) ? (
                <img src={presetThumbUrl(m.url)} alt={m.name} loading="lazy" />
              ) : thumbs.has(m.url) ? (
                <img src={thumbs.get(m.url)} alt={m.name} />
              ) : (
                <span className="wb-thumb-loading" />
              )}
            </div>
            <span className="wb-model-name">{m.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
