/**
 * 筑境 — 场景存档 IndexedDB 存储
 * 保存时自动嵌入用户导入模型的 blob 数据
 */

import type { SceneObject } from "./scene-store";
import { getModelBlob } from "./model-db";

const DB_NAME = "world-builder-scenes";
const STORE_NAME = "scenes";

export interface SavedScene {
  id: string;
  name: string;
  objects: SceneObject[];
  /** 用户模型 blob 数据，key = 原始 modelUrl */
  blobs: Record<string, Blob>;
  createdAt: number;
  updatedAt: number;
}

function ensureStore(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.createObjectStore(STORE_NAME, { keyPath: "id" });
  }
}

function openDBVersion(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      ensureStore(req.result);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(req.error);
  });
}

async function openDB(): Promise<IDBDatabase> {
  const db = await openDBVersion();
  if (db.objectStoreNames.contains(STORE_NAME)) return db;

  const repairVersion = db.version + 1;
  db.close();
  return openDBVersion(repairVersion);
}

export async function saveScene(name: string, objects: SceneObject[], existingId?: string): Promise<string> {
  const db = await openDB();
  const id = existingId || `scene_${Date.now()}`;
  const now = Date.now();

  // 收集用户模型的 blob 数据
  const blobs: Record<string, Blob> = {};
  for (const obj of objects) {
    if (obj.modelUrl.startsWith("blob:")) {
      try {
        const res = await fetch(obj.modelUrl);
        blobs[obj.modelUrl] = await res.blob();
      } catch {}
    }
  }

  const existing = existingId ? await getScene(id) : null;
  const record: SavedScene = {
    id,
    name,
    objects,
    blobs,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

/** 加载场景，恢复 blob URL */
export async function loadScene(id: string): Promise<{ objects: SceneObject[]; name: string } | null> {
  const scene = await getScene(id);
  if (!scene) return null;

  // 重建 blob URL 映射
  const urlMap = new Map<string, string>();
  for (const [oldUrl, blob] of Object.entries(scene.blobs || {})) {
    urlMap.set(oldUrl, URL.createObjectURL(blob));
  }

  // 替换对象中的旧 blob URL
  const objects = scene.objects.map((obj) => {
    if (urlMap.has(obj.modelUrl)) {
      return { ...obj, modelUrl: urlMap.get(obj.modelUrl)! };
    }
    return obj;
  });

  return { objects, name: scene.name };
}

export async function getScene(id: string): Promise<SavedScene | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllScenes(): Promise<SavedScene[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as SavedScene[]);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteScene(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
