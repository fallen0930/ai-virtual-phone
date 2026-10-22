"use client";

import type { CustomAppChatScene, InstalledCustomApp } from "./custom-app-types";

type TagCarrier = {
  appTags?: unknown;
  tags?: unknown;
  sceneTag?: unknown;
  sceneTags?: unknown;
  sceneId?: unknown;
  scene?: unknown;
  slot?: unknown;
  directiveId?: unknown;
  actionId?: unknown;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringArray(value: unknown, maxLength = 120, limit = 80): string[] {
  if (Array.isArray(value)) {
    return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, limit);
  }
  const text = cleanText(value, maxLength);
  return text ? [text] : [];
}

function addTags(target: Set<string>, tags: unknown): void {
  for (const tag of stringArray(tags)) {
    target.add(tag);
  }
}

export function getCustomAppBasePromptTags(_app: Pick<InstalledCustomApp, "id" | "name" | "manifest">): string[] {
  return [];
}

export function getCustomAppDeclaredScenes(app: Pick<InstalledCustomApp, "manifest">): CustomAppChatScene[] {
  return app.manifest.extensions?.chat?.scenes
    ?? app.manifest.chatExtensions?.scenes
    ?? [];
}

export function getCustomAppSceneDefaultTag(
  _app: Pick<InstalledCustomApp, "name">,
  scene: Pick<CustomAppChatScene, "id" | "label" | "tag" | "tags">,
): string {
  const explicit = cleanText(scene.tag, 120) || stringArray(scene.tags, 120, 1)[0];
  if (explicit) return explicit;
  return cleanText(scene.id, 120);
}

function sceneMatches(scene: CustomAppChatScene, refs: Set<string>): boolean {
  if (refs.size === 0) return false;
  const candidates = [
    scene.id,
    scene.label,
    scene.tag,
    scene.directiveId,
    scene.actionId,
    ...stringArray(scene.tags),
  ];
  return candidates.some(candidate => {
    const text = cleanText(candidate, 120);
    const id = cleanId(text);
    return text && (refs.has(text) || Boolean(id && refs.has(id)));
  });
}

export function buildCustomAppChatTags(
  app: Pick<InstalledCustomApp, "id" | "name" | "manifest">,
  input?: TagCarrier | null,
): string[] {
  const tags = new Set(getCustomAppBasePromptTags(app));
  if (!input) return Array.from(tags);

  addTags(tags, input.appTags);
  addTags(tags, input.tags);
  addTags(tags, input.sceneTag);
  addTags(tags, input.sceneTags);

  const refs = new Set<string>();
  for (const value of [input.sceneId, input.scene, input.slot, input.directiveId, input.actionId]) {
    const text = cleanText(value, 120);
    if (!text) continue;
    refs.add(text);
    const id = cleanId(text);
    if (id) refs.add(id);
  }

  for (const scene of getCustomAppDeclaredScenes(app)) {
    if (!sceneMatches(scene, refs)) continue;
    const defaultTag = getCustomAppSceneDefaultTag(app, scene);
    if (defaultTag) tags.add(defaultTag);
    addTags(tags, scene.tags);
    addTags(tags, scene.appTags);
    if (scene.id) tags.add(scene.id);
  }

  return Array.from(tags);
}

export function mergeCustomAppResourceTags(
  _app: Pick<InstalledCustomApp, "id" | "name" | "manifest">,
  tags: unknown,
): string[] | undefined {
  const normalized = Array.from(new Set(stringArray(tags).map(tag => cleanText(tag, 120)).filter(Boolean)));
  return normalized.length > 0 ? normalized : undefined;
}
