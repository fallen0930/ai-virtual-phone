"use client";

import type { InstalledCustomApp } from "./custom-app-types";
import type { BindingSlot, PresetConfig, Prompt, RegexConfig, WorldBookConfig } from "./settings-types";
import { mergeCustomAppResourceTags } from "./custom-app-tags";
import {
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  parsePresetFromJson,
  parseRegexFromJson,
  parseWorldBookFromJson,
  ensureSettingsStorageHydrated,
  saveBindingConfig,
  savePresets,
  saveRegexes,
  saveWorldBooks,
} from "./settings-storage";

type JsonRecord = Record<string, unknown>;
type ImportKind = "regex" | "worldbook";

type ImportedPresets = {
  count: number;
  refs: Map<string, string>;
};

export type CustomAppRegistrationSummary = {
  presets: number;
  regexes: number;
  worldBooks: number;
  bindingUpdated: boolean;
  warnings: string[];
};

export type CustomAppRegistrationRemovalSummary = {
  presets: number;
  regexes: number;
  worldBooks: number;
  bindingRemoved: boolean;
};

const EMPTY_SUMMARY: CustomAppRegistrationSummary = {
  presets: 0,
  regexes: 0,
  worldBooks: 0,
  bindingUpdated: false,
  warnings: [],
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "";
  const header = dataUrl.slice(0, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  if (header.includes(";base64")) {
    try {
      return decodeURIComponent(escape(atob(payload)));
    } catch {
      return atob(payload);
    }
  }
  return decodeURIComponent(payload);
}

function readDeclarationText(app: InstalledCustomApp, filename: string): string {
  const direct = app.assets[filename]?.dataUrl;
  if (direct) return dataUrlToText(direct);
  const match = Object.values(app.assets).find(asset => asset.path.toLowerCase() === filename.toLowerCase());
  return match ? dataUrlToText(match.dataUrl) : "";
}

function parseJsonAsset(app: InstalledCustomApp, filename: string, warnings: string[]): unknown {
  const text = readDeclarationText(app, filename);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    warnings.push(`${filename} 不是有效 JSON，已跳过。`);
    return null;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function declarationItems(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (Array.isArray(record[key])) return record[key] as unknown[];
  if (Object.keys(record).length > 0) return [record];
  return [];
}

function sourceRef(raw: unknown, fallback: string, index: number): string {
  const record = asRecord(raw);
  return cleanText(record.id ?? record.identifier ?? record.name ?? fallback, 120) || `item-${index + 1}`;
}

function finalResourceId(app: InstalledCustomApp, kind: ImportKind, ref: string): string {
  return `custom_app_${cleanId(app.id)}_${kind}_${cleanId(ref) || "item"}`;
}

function customAppPromptPrefix(appId: string): string {
  return `custom_app_${cleanId(appId)}_prompt_`;
}

function customAppPromptIdentifier(app: InstalledCustomApp, ref: string, index: number): string {
  return `${customAppPromptPrefix(app.id)}${cleanId(ref) || `item_${index + 1}`}`;
}

function rememberRef(refMap: Map<string, string>, key: unknown, value: string): void {
  const text = cleanText(key, 160);
  if (text) refMap.set(text, value);
  const id = cleanId(text);
  if (id) refMap.set(id, value);
}

function upsertById<T extends { id: string }>(existing: T[], imported: T[]): T[] {
  if (imported.length === 0) return existing;
  const map = new Map(existing.map(item => [item.id, item]));
  for (const item of imported) map.set(item.id, item);
  return Array.from(map.values());
}

function promptFromDeclaration(entry: unknown, fallback: string, index: number): Prompt | null {
  const record = asRecord(entry);
  const content = cleanText(record.content ?? record.prompt ?? record.text, 20000);
  if (!content) return null;
  return {
    identifier: cleanText(record.identifier ?? record.id ?? record.name, 120) || `custom_app_prompt_${index + 1}`,
    name: cleanText(record.name ?? record.label ?? record.id, 80) || fallback,
    role: cleanText(record.role, 30) || "system",
    content,
    injection_depth: Number(record.injection_depth ?? record.depth ?? 0) || 0,
    enabled: record.enabled !== false,
    system_prompt: record.system_prompt === true ? true : undefined,
    marker: record.marker === true ? true : undefined,
    forbid_overrides: record.forbid_overrides === true ? true : undefined,
    injection_position: typeof record.injection_position === "number" ? record.injection_position : undefined,
    tags: Array.isArray(record.tags) ? record.tags.map(String) : undefined,
  };
}

function scopePromptForApp(
  app: InstalledCustomApp,
  prompt: Prompt,
  tags: unknown,
  identifier: string,
): Prompt {
  return {
    ...prompt,
    identifier,
    tags: mergeCustomAppResourceTags(app, prompt.tags ?? tags),
    featureTag: undefined,
    followUpOnly: undefined,
  };
}

function findBuiltInPreset(presets: PresetConfig[]): PresetConfig | null {
  return presets.find(item => item.builtIn) ?? presets[0] ?? null;
}

function attachPromptEntriesToBuiltInPreset(app: InstalledCustomApp, prompts: Prompt[]): number {
  if (prompts.length === 0) return 0;
  const presets = loadPresets();
  const builtIn = findBuiltInPreset(presets);
  if (!builtIn) return 0;
  const prefix = customAppPromptPrefix(app.id);
  const promptIds = new Set(prompts.map(prompt => prompt.identifier));
  const existingPrompts = (builtIn.prompts ?? []).filter(prompt => (
    !prompt.identifier.startsWith(prefix) && !promptIds.has(prompt.identifier)
  ));
  const existingOrder = (builtIn.prompt_order ?? []).filter(entry => (
    !entry.identifier.startsWith(prefix) && !promptIds.has(entry.identifier)
  ));
  const nextOrderEntries = prompts.map(prompt => ({
    identifier: prompt.identifier,
    enabled: prompt.enabled !== false,
  }));
  const dividerIndex = existingOrder.findIndex(entry => entry.identifier === "shortTermMemory" || entry.identifier === "chatHistory");
  const promptOrder = dividerIndex >= 0
    ? [
      ...existingOrder.slice(0, dividerIndex + 1),
      ...nextOrderEntries,
      ...existingOrder.slice(dividerIndex + 1),
    ]
    : [...existingOrder, ...nextOrderEntries];
  const nextBuiltIn: PresetConfig = {
    ...builtIn,
    prompts: [...existingPrompts, ...prompts],
    prompt_order: promptOrder,
    updatedAt: Date.now(),
  };
  savePresets(presets.map(item => item.id === builtIn.id ? nextBuiltIn : item));
  window.dispatchEvent(new CustomEvent("settings-presets-updated"));
  return prompts.length;
}

function removeAttachedPromptEntries(appId: string): number {
  const presets = loadPresets();
  const prefix = customAppPromptPrefix(appId);
  let removed = 0;
  const nextPresets = presets.map(preset => {
    const prompts = preset.prompts ?? [];
    const nextPrompts = prompts.filter(prompt => !prompt.identifier.startsWith(prefix));
    removed += prompts.length - nextPrompts.length;
    const nextOrder = (preset.prompt_order ?? []).filter(entry => !entry.identifier.startsWith(prefix));
    return nextPrompts.length === prompts.length && nextOrder.length === (preset.prompt_order ?? []).length
      ? preset
      : { ...preset, prompts: nextPrompts, prompt_order: nextOrder, updatedAt: Date.now() };
  });
  if (removed > 0) {
    savePresets(nextPresets);
    window.dispatchEvent(new CustomEvent("settings-presets-updated"));
  }
  return removed;
}

function importPresets(app: InstalledCustomApp, raw: unknown, warnings: string[]): ImportedPresets {
  const refs = new Map<string, string>();
  const prompts: Prompt[] = [];
  declarationItems(raw, "presets").forEach((entry, index) => {
    const fallback = `${app.name} 预设 ${index + 1}`;
    const rawRecord = asRecord(entry);
    const promptEntry = promptFromDeclaration(entry, fallback, index);
    if (promptEntry && !Array.isArray(rawRecord.prompts)) {
      const ref = sourceRef(entry, promptEntry.name, index);
      const identifier = customAppPromptIdentifier(app, ref, index);
      prompts.push({
        ...scopePromptForApp(app, promptEntry, rawRecord.tags, identifier),
        marker: false,
      });
      rememberRef(refs, ref, identifier);
      rememberRef(refs, promptEntry.identifier, identifier);
      rememberRef(refs, promptEntry.name, identifier);
      return;
    }

    const parsed = parsePresetFromJson(JSON.stringify(entry), fallback);
    if (!parsed || parsed.prompts.length === 0) {
      warnings.push(`presets.json 第 ${index + 1} 项无法解析，已跳过。`);
      return;
    }
    const ref = sourceRef(entry, parsed.name, index);
    let firstIdentifier = "";
    parsed.prompts.forEach((prompt, promptIndex) => {
      const promptRef = `${ref}_${prompt.identifier || prompt.name || promptIndex + 1}`;
      const identifier = customAppPromptIdentifier(app, promptRef, prompts.length + promptIndex);
      if (!firstIdentifier) firstIdentifier = identifier;
      prompts.push(scopePromptForApp(app, prompt, rawRecord.tags, identifier));
      rememberRef(refs, prompt.identifier, identifier);
      rememberRef(refs, prompt.name, identifier);
    });
    if (firstIdentifier) {
      rememberRef(refs, ref, firstIdentifier);
      rememberRef(refs, parsed.name, firstIdentifier);
    }
  });
  return {
    count: attachPromptEntriesToBuiltInPreset(app, prompts),
    refs,
  };
}

function scopeRegexGroupForApp(app: InstalledCustomApp, entry: unknown, group: RegexConfig): RegexConfig {
  const record = asRecord(entry);
  return {
    ...group,
    rules: (group.rules ?? []).map(rule => ({
      ...rule,
      tags: mergeCustomAppResourceTags(app, rule.tags ?? record.tags),
    })),
  };
}

function importRegexes(app: InstalledCustomApp, raw: unknown, warnings: string[]): {
  items: RegexConfig[];
  refs: Map<string, string>;
} {
  const refs = new Map<string, string>();
  const items: RegexConfig[] = [];
  declarationItems(raw, "regexes").forEach((entry, index) => {
    const fallback = `${app.name} 正则 ${index + 1}`;
    const parsed = parseRegexFromJson(JSON.stringify(entry), fallback);
    if (!parsed) {
      warnings.push(`regex.json 第 ${index + 1} 项无法解析，已跳过。`);
      return;
    }
    const ref = sourceRef(entry, parsed.name, index);
    const id = finalResourceId(app, "regex", ref);
    const now = Date.now();
    const record = asRecord(entry);
    const scoped = scopeRegexGroupForApp(app, entry, parsed);
    scoped.id = id;
    scoped.name = cleanText(record.name, 80) || scoped.name || fallback;
    scoped.description = cleanText(record.description, 500) || scoped.description || `来自 APP「${app.name}」`;
    scoped.builtIn = false;
    scoped.updatedAt = now;
    if (!scoped.createdAt) scoped.createdAt = now;
    items.push(scoped);
    rememberRef(refs, ref, id);
    rememberRef(refs, scoped.name, id);
    rememberRef(refs, id, id);
  });
  return { items, refs };
}

function importWorldBooks(app: InstalledCustomApp, raw: unknown, warnings: string[]): {
  items: WorldBookConfig[];
  refs: Map<string, string>;
} {
  const refs = new Map<string, string>();
  const items: WorldBookConfig[] = [];
  declarationItems(raw, "worldbooks").forEach((entry, index) => {
    const fallback = `${app.name} 世界书 ${index + 1}`;
    const parsed = parseWorldBookFromJson(JSON.stringify({ name: fallback, ...asRecord(entry) }));
    if (!parsed) {
      warnings.push(`worldbooks.json 第 ${index + 1} 项无法解析，已跳过。`);
      return;
    }
    const ref = sourceRef(entry, parsed.name, index);
    const id = finalResourceId(app, "worldbook", ref);
    const now = Date.now();
    const record = asRecord(entry);
    parsed.id = id;
    parsed.name = cleanText(record.name, 80) || parsed.name || fallback;
    parsed.description = cleanText(record.description, 500) || parsed.description || `来自 APP「${app.name}」`;
    parsed.updatedAt = now;
    if (!parsed.createdAt) parsed.createdAt = now;
    items.push(parsed);
    rememberRef(refs, ref, id);
    rememberRef(refs, parsed.name, id);
    rememberRef(refs, id, id);
  });
  return { items, refs };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 160)).filter(Boolean);
  const text = cleanText(value, 160);
  return text ? [text] : [];
}

function resolveRef(value: unknown, refs: Map<string, string>): string | undefined {
  const text = cleanText(value, 160);
  if (!text) return undefined;
  return refs.get(text) ?? refs.get(cleanId(text)) ?? text;
}

function normalizeDeclaredSlot(
  raw: unknown,
  refs: { presets: Map<string, string>; regexes: Map<string, string>; worldBooks: Map<string, string> },
): BindingSlot {
  const record = asRecord(raw);
  const slot: BindingSlot = {};
  const presetRef = record.presetId ?? record.preset ?? record.presetName;
  const presetId = resolveRef(presetRef, refs.presets);
  if (presetId) slot.presetId = presetId;
  const regexRefs = stringArray(record.regexIds ?? record.regexes ?? record.regex);
  const regexIds = regexRefs.map(item => resolveRef(item, refs.regexes)).filter(Boolean) as string[];
  if (regexIds.length > 0) slot.regexIds = regexIds;
  const worldBookRefs = stringArray(record.worldBookIds ?? record.worldBooks ?? record.worldbook ?? record.worldBook);
  const worldBookIds = worldBookRefs.map(item => resolveRef(item, refs.worldBooks)).filter(Boolean) as string[];
  if (worldBookIds.length > 0) slot.worldBookIds = worldBookIds;
  const apiConfigId = cleanText(record.apiConfigId, 160);
  if (apiConfigId) slot.apiConfigId = apiConfigId;
  const voiceConfigId = cleanText(record.voiceConfigId, 160);
  if (voiceConfigId) slot.voiceConfigId = voiceConfigId;
  const userIdentityId = cleanText(record.userIdentityId, 160);
  if (userIdentityId) slot.userIdentityId = userIdentityId;
  return slot;
}

function isEmptySlot(slot: BindingSlot): boolean {
  return !slot.apiConfigId
    && !slot.voiceConfigId
    && !slot.presetId
    && !slot.userIdentityId
    && (!slot.worldBookIds || slot.worldBookIds.length === 0)
    && (!slot.regexIds || slot.regexIds.length === 0);
}

function defaultImportedSlot(imported: {
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
}): BindingSlot {
  return {
    regexIds: imported.regexes.length > 0 ? imported.regexes.map(item => item.id) : undefined,
    worldBookIds: imported.worldBooks.length > 0 ? imported.worldBooks.map(item => item.id) : undefined,
  };
}

function applyAppDefaultBinding(app: InstalledCustomApp, slot: BindingSlot): boolean {
  if (isEmptySlot(slot)) return false;
  const appBindingId = `custom_app:${app.id}`;
  const config = loadBindingConfig();
  const appDefaults = { ...(config.appDefaults ?? {}) };
  appDefaults[appBindingId] = {
    ...(appDefaults[appBindingId] ?? {}),
    ...slot,
    regexIds: slot.regexIds ? [...slot.regexIds] : appDefaults[appBindingId]?.regexIds,
    worldBookIds: slot.worldBookIds ? [...slot.worldBookIds] : appDefaults[appBindingId]?.worldBookIds,
  };
  saveBindingConfig({ ...config, appDefaults });
  return true;
}

export function applyCustomAppRegistrations(app: InstalledCustomApp): CustomAppRegistrationSummary {
  if (typeof window === "undefined") return { ...EMPTY_SUMMARY };
  const warnings: string[] = [];
  const presetsRaw = parseJsonAsset(app, "presets.json", warnings);
  const regexRaw = parseJsonAsset(app, "regex.json", warnings);
  const worldBooksRaw = parseJsonAsset(app, "worldbooks.json", warnings);
  const bindingsRaw = parseJsonAsset(app, "bindings.json", warnings);

  const presets = importPresets(app, presetsRaw, warnings);
  const regexes = importRegexes(app, regexRaw, warnings);
  const worldBooks = importWorldBooks(app, worldBooksRaw, warnings);

  if (regexes.items.length > 0) {
    saveRegexes(upsertById(loadRegexes(), regexes.items));
  }
  if (worldBooks.items.length > 0) {
    saveWorldBooks(upsertById(loadWorldBooks(), worldBooks.items));
    window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
  }

  const bindingRecord = asRecord(bindingsRaw);
  const declaredSlot = normalizeDeclaredSlot(
    bindingRecord.app ?? bindingRecord.default ?? bindingRecord.slot ?? bindingRecord,
    { presets: presets.refs, regexes: regexes.refs, worldBooks: worldBooks.refs },
  );
  const fallbackSlot = defaultImportedSlot({
    regexes: regexes.items,
    worldBooks: worldBooks.items,
  });
  const bindingUpdated = applyAppDefaultBinding(app, isEmptySlot(declaredSlot) ? fallbackSlot : declaredSlot);

  return {
    presets: presets.count,
    regexes: regexes.items.length,
    worldBooks: worldBooks.items.length,
    bindingUpdated,
    warnings,
  };
}

export async function applyCustomAppRegistrationsAsync(app: InstalledCustomApp): Promise<CustomAppRegistrationSummary> {
  await ensureSettingsStorageHydrated();
  return applyCustomAppRegistrations(app);
}

export function formatCustomAppRegistrationSummary(summary: CustomAppRegistrationSummary): string {
  const parts: string[] = [];
  if (summary.presets > 0) parts.push(`${summary.presets} 个预设条目`);
  if (summary.regexes > 0) parts.push(`${summary.regexes} 个正则组`);
  if (summary.worldBooks > 0) parts.push(`${summary.worldBooks} 个世界书`);
  if (summary.bindingUpdated) parts.push("默认绑定");
  return parts.length > 0 ? `已导入 ${parts.join("、")}` : "";
}

function resourcePrefix(appId: string, kind: ImportKind): string {
  return `custom_app_${cleanId(appId)}_${kind}_`;
}

export function removeCustomAppRegistrations(
  appId: string,
  options: { deleteResources?: boolean } = {},
): CustomAppRegistrationRemovalSummary {
  if (typeof window === "undefined") {
    return { presets: 0, regexes: 0, worldBooks: 0, bindingRemoved: false };
  }
  const appBindingId = `custom_app:${appId}`;
  const config = loadBindingConfig();
  const appDefaults = { ...(config.appDefaults ?? {}) };
  const bindingRemoved = Boolean(appDefaults[appBindingId]);
  if (bindingRemoved) {
    delete appDefaults[appBindingId];
    saveBindingConfig({ ...config, appDefaults });
  }

  if (!options.deleteResources) {
    return { presets: 0, regexes: 0, worldBooks: 0, bindingRemoved };
  }

  const removedPrompts = removeAttachedPromptEntries(appId);
  const regexPrefix = resourcePrefix(appId, "regex");
  const worldBookPrefix = resourcePrefix(appId, "worldbook");

  const regexes = loadRegexes();
  const nextRegexes = regexes.filter(item => !item.id.startsWith(regexPrefix));
  if (nextRegexes.length !== regexes.length) saveRegexes(nextRegexes);

  const worldBooks = loadWorldBooks();
  const nextWorldBooks = worldBooks.filter(item => !item.id.startsWith(worldBookPrefix));
  if (nextWorldBooks.length !== worldBooks.length) {
    saveWorldBooks(nextWorldBooks);
    window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
  }

  return {
    presets: removedPrompts,
    regexes: regexes.length - nextRegexes.length,
    worldBooks: worldBooks.length - nextWorldBooks.length,
    bindingRemoved,
  };
}

export async function removeCustomAppRegistrationsAsync(
  appId: string,
  options: { deleteResources?: boolean } = {},
): Promise<CustomAppRegistrationRemovalSummary> {
  await ensureSettingsStorageHydrated();
  return removeCustomAppRegistrations(appId, options);
}

export function formatCustomAppRegistrationRemovalSummary(summary: CustomAppRegistrationRemovalSummary): string {
  const parts: string[] = [];
  if (summary.presets > 0) parts.push(`${summary.presets} 个预设条目`);
  if (summary.regexes > 0) parts.push(`${summary.regexes} 个正则组`);
  if (summary.worldBooks > 0) parts.push(`${summary.worldBooks} 个世界书`);
  if (summary.bindingRemoved) parts.push("默认绑定");
  return parts.length > 0 ? `已清理 ${parts.join("、")}` : "";
}
