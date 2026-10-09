// lib/vn-asset-storage.ts
// VN scene/sprite asset management.
// Metadata in localStorage, binary data in IndexedDB via theme-storage.

import { saveThemeAssetFromBlob, deleteThemeAsset, getThemeAssetMap } from "./theme-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const SCENES_KEY = "ai_phone_vn_scenes_v1";
const SPRITES_KEY = "ai_phone_vn_sprites_v1";
registerKvMigration(SCENES_KEY);
registerKvMigration(SPRITES_KEY);

// ── Types ──

export interface VnAssetLayout {
  scale?: number;  // % (default 100)
  x?: number;      // % (default 50 for sprite, 50 for scene)
  y?: number;      // % (default 100 for sprite bottom, 50 for scene center)
}

export interface VnSceneAsset {
  id: string;
  characterId: string;
  name: string;
  assetId: string;
  layout?: VnAssetLayout;
}

export interface VnSpriteAsset {
  id: string;
  characterId: string;
  key: string;
  assetId: string;
  layout?: VnAssetLayout;
}

// ── localStorage helpers ──

function readScenes(): VnSceneAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(SCENES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeScenes(scenes: VnSceneAsset[]): void {
  if (typeof window === "undefined") return;
  kvSet(SCENES_KEY, JSON.stringify(scenes));
}

function readSprites(): VnSpriteAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(SPRITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeSprites(sprites: VnSpriteAsset[]): void {
  if (typeof window === "undefined") return;
  kvSet(SPRITES_KEY, JSON.stringify(sprites));
}

// ── Scene CRUD ──

export function loadVnScenes(characterId?: string): VnSceneAsset[] {
  const all = readScenes();
  if (!characterId) return all;
  return all.filter((s) => s.characterId === characterId || s.characterId === "");
}

export async function addVnScene(characterId: string, name: string, blob: Blob): Promise<VnSceneAsset> {
  const assetId = await saveThemeAssetFromBlob(blob, "vn_scene");
  const scene: VnSceneAsset = {
    id: `vn_scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    characterId,
    name,
    assetId,
  };
  const scenes = readScenes();
  scenes.push(scene);
  writeScenes(scenes);
  return scene;
}

export async function deleteVnScene(id: string): Promise<void> {
  const scenes = readScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = scenes.splice(idx, 1);
  writeScenes(scenes);
  await deleteThemeAsset(removed.assetId);
}

// ── Sprite CRUD ──

export function loadVnSprites(characterId?: string): VnSpriteAsset[] {
  const all = readSprites();
  if (!characterId) return all;
  return all.filter((s) => s.characterId === characterId || s.characterId === "");
}

export async function addVnSprite(characterId: string, key: string, blob: Blob): Promise<VnSpriteAsset> {
  const assetId = await saveThemeAssetFromBlob(blob, "vn_sprite");
  const sprite: VnSpriteAsset = {
    id: `vn_sprite_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    characterId,
    key,
    assetId,
  };
  const sprites = readSprites();
  sprites.push(sprite);
  writeSprites(sprites);
  return sprite;
}

export async function deleteVnSprite(id: string): Promise<void> {
  const sprites = readSprites();
  const idx = sprites.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = sprites.splice(idx, 1);
  writeSprites(sprites);
  await deleteThemeAsset(removed.assetId);
}

// ── Layout update ──

export function updateVnSceneLayout(id: string, layout: VnAssetLayout): void {
  const scenes = readScenes();
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  scenes[idx] = { ...scenes[idx], layout };
  writeScenes(scenes);
}

export function updateVnSpriteLayout(id: string, layout: VnAssetLayout): void {
  const sprites = readSprites();
  const idx = sprites.findIndex((s) => s.id === id);
  if (idx === -1) return;
  sprites[idx] = { ...sprites[idx], layout };
  writeSprites(sprites);
}

// ── Layout lookup for rendering ──

function findSpriteAsset(sprites: VnSpriteAsset[], key: string, characterId?: string): VnSpriteAsset | undefined {
  const nameAfterSlash = key.includes("/") ? key.split("/").pop()! : key;
  const candidates = characterId
    ? sprites.filter((s) => s.characterId === characterId || s.characterId === "")
    : sprites;

  return (
    (characterId ? candidates.find((s) => s.characterId === characterId && s.key === key) : undefined) ||
    (characterId ? candidates.find((s) => s.characterId === characterId && s.key === nameAfterSlash) : undefined) ||
    candidates.find((s) => s.key === key) ||
    candidates.find((s) => s.key === nameAfterSlash)
  );
}

export function getVnSceneLayout(name: string): VnAssetLayout {
  const scene = readScenes().find((s) => s.name === name);
  return scene?.layout ?? {};
}

export function getVnSpriteLayout(key: string, characterId?: string): VnAssetLayout {
  const sprites = readSprites();
  const sprite = findSpriteAsset(sprites, key, characterId);
  return sprite?.layout ?? {};
}

// ── Prompt injection helpers ──

export function getVnSceneNames(characterId: string): string {
  const scenes = loadVnScenes(characterId);
  if (scenes.length === 0) return "暂无";
  return scenes.map((s) => s.name).join("，");
}

export function getVnSpriteNames(characterId: string): string {
  const sprites = loadVnSprites(characterId);
  if (sprites.length === 0) return "暂无";
  return sprites.map((s) => s.key).join("，");
}

// ── Rendering helpers ──

export async function resolveVnAssetMap(
  names: string[],
  type: "scene" | "sprite",
  characterId?: string
): Promise<Record<string, string>> {
  if (names.length === 0) return {};

  const items = type === "scene"
    ? (characterId ? loadVnScenes(characterId) : readScenes())
    : (characterId ? loadVnSprites(characterId) : readSprites());
  const matched: { name: string; assetId: string }[] = [];
  for (const name of names) {
    let item;
    if (type === "scene") {
      item = (items as VnSceneAsset[]).find((i) => i.name === name);
    } else {
      // Match exact key, or strip "角色名/" prefix from AI output
      item = findSpriteAsset(items as VnSpriteAsset[], name, characterId);
    }
    if (item) matched.push({ name, assetId: item.assetId });
  }

  if (matched.length === 0) return {};

  const assetIds = matched.map((m) => m.assetId);
  const assetMap = await getThemeAssetMap(assetIds);

  const result: Record<string, string> = {};
  for (const m of matched) {
    if (assetMap[m.assetId]) {
      result[m.name] = assetMap[m.assetId];
    }
  }
  return result;
}
