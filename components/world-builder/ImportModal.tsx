"use client";

import { useState, useRef } from "react";
import { saveModel } from "./model-db";

interface Props {
  open: boolean;
  categories: string[];
  onClose: () => void;
  onModelAdded: () => void;
}

export default function ImportModal({ open, categories, onClose, onModelAdded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [modelName, setModelName] = useState("");
  const [category, setCategory] = useState("导入");
  const [customCat, setCustomCat] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleImport() {
    if (!file) return;
    const cat = customCat.trim() || category;
    const blob = new Blob([await file.arrayBuffer()], { type: "model/gltf-binary" });
    await saveModel({ name: modelName || file.name.replace(/\.\w+$/, ""), category: cat, blob });
    onModelAdded();
    reset();
  }

  function reset() {
    setFile(null);
    setModelName("");
    setCategory("导入");
    setCustomCat("");
    onClose();
  }

  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={reset}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>导入模型</span>
          <button className="wb-float-close" onClick={reset}>✕</button>
        </div>

        <div className="wb-modal-section">
          <input
            ref={fileRef}
            type="file"
            accept=".glb,.gltf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFile(f);
                setModelName(f.name.replace(/\.\w+$/, ""));
              }
            }}
          />
          <button className="wb-modal-btn" onClick={() => fileRef.current?.click()}>
            {file ? file.name : "选择 GLB / GLTF 文件"}
          </button>
        </div>

        {file && (
          <>
            <div className="wb-modal-section">
              <label className="wb-modal-label">模型名称</label>
              <input
                className="wb-modal-input"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              />
            </div>

            <div className="wb-modal-section">
              <label className="wb-modal-label">分类</label>
              <div className="wb-modal-cat-list">
                {[...categories, "自定义"].map((c) => (
                  <button
                    key={c}
                    className={`wb-modal-cat ${category === c ? "active" : ""}`}
                    onClick={() => { setCategory(c); if (c !== "自定义") setCustomCat(""); }}
                  >{c}</button>
                ))}
              </div>
              {category === "自定义" && (
                <input
                  className="wb-modal-input"
                  placeholder="输入新分类名"
                  value={customCat}
                  onChange={(e) => setCustomCat(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              )}
            </div>

            <div className="wb-modal-actions">
              <button className="wb-modal-btn wb-modal-primary" onClick={handleImport}>添加到库</button>
              <button className="wb-modal-btn" onClick={reset}>取消</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
