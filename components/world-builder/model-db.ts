/**
 * 筑境 — 用户模型 IndexedDB 存储
 */

const DB_NAME = "world-builder-models";
const STORE_NAME = "models";

export interface UserModel {
  id: string;
  name: string;
  category: string;
  blob: Blob;
  blobUrl?: string; // runtime only, not stored
  createdAt: number;
  /** 角色化身模型：绑定的角色 id */
  characterId?: string;
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

export async function saveModel(model: Omit<UserModel, "id" | "createdAt">): Promise<string> {
  const db = await openDB();
  const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record: UserModel = { ...model, id, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllModels(): Promise<UserModel[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const models = req.result as UserModel[];
      // 生成 blobUrl
      for (const m of models) {
        m.blobUrl = URL.createObjectURL(m.blob);
      }
      resolve(models);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteModel(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getModelBlob(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** 获取所有用户自定义分类 */
export async function getUserCategories(): Promise<string[]> {
  const models = await getAllModels();
  const cats = new Set(models.map((m) => m.category));
  return [...cats];
}
