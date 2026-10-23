// lib/mixology/storage.ts
// 独家特调 · 本地存取：酒柜（材料）/ 特调方案 / 对局，全部走 kv-db。
// 官方出厂件（基底/杯型）不落酒柜：按 id 从出厂工厂直读（人人可用、永远最新），
// 在酒材页作为官方条目展示，吧台槽位选择时与酒柜材料并排可选。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { dropMixPendingForSession } from "./pending-queue";
import { purgeNarrativeSessionData } from "../narrative-writer/storage";
import type {
    MixConnector,
    MixFavoritePreset,
    MixMaterial,
    MixMaterialKind,
    MixRecipe,
    MixRecipeFolder,
    MixSession,
    MixSessionFolder,
    MixSlotEntry,
} from "./types";
import { MIX_CONNECTOR_NAME_RE, MIX_SLOT_ORDER, mixSlotEntries, normalizeMixSlots } from "./types";
import {
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_CHECKLIST_ID,
    MIX_BUILTIN_GLASS_ID,
    MIX_BUILTIN_PREFACE_ID,
    MIX_BUILTIN_READER_ID,
    createBuiltinBase,
    createBuiltinChecklist,
    createBuiltinGlass,
    createBuiltinPreface,
    createBuiltinReader,
} from "./builtin";

const CABINET_KEY = "mixology_cabinet_v1";
const RECIPES_KEY = "mixology_recipes_v1";
const SESSIONS_KEY = "mixology_sessions_v1";
const BUILTIN_VERSION_KEY = "mixology_builtin_version_v1";
const PROFILE_KEY = "mixology_profile_v1";
const CONNECTORS_KEY = "mixology_connectors_v1";
const FAVORITES_KEY = "mixology_favorites_v1";
const FOLDERS_KEY = "mixology_folders_v1";
const SESSION_FOLDERS_KEY = "mixology_session_folders_v1";

registerKvMigration(CABINET_KEY);
registerKvMigration(RECIPES_KEY);
registerKvMigration(SESSIONS_KEY);
registerKvMigration(BUILTIN_VERSION_KEY);
registerKvMigration(PROFILE_KEY);
registerKvMigration(CONNECTORS_KEY);
registerKvMigration(FAVORITES_KEY);
registerKvMigration(FOLDERS_KEY);

/**
 * 酒柜被外部改写（小卷工具）后的广播事件：已打开的特调 App 据此重读列表。
 * App 自己的操作不用它——那些路径本来就会调 refresh。
 */
export const MIX_CABINET_UPDATED_EVENT = "mix-cabinet-updated";

/** 官方件不可删除、不可改名（内容永远是当前出厂版） */
export const MIX_BUILTIN_IDS: readonly string[] = [
    MIX_BUILTIN_PREFACE_ID,
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
    MIX_BUILTIN_CHECKLIST_ID,
    MIX_BUILTIN_READER_ID,
];

export function isMixBuiltinId(id: string): boolean {
    return MIX_BUILTIN_IDS.includes(id);
}

/** 出厂件工厂直读：不落库，每次现造，天然随版本更新 */
export function listMixBuiltins(kind?: MixMaterialKind): MixMaterial[] {
    const factory: MixMaterial[] = [createBuiltinPreface(), createBuiltinBase(), createBuiltinGlass(), createBuiltinChecklist(), createBuiltinReader()];
    return kind ? factory.filter((m) => m.kind === kind) : factory;
}

export function getMixBuiltin(id: string): MixMaterial | null {
    if (!isMixBuiltinId(id)) return null;
    return listMixBuiltins().find((m) => m.id === id) ?? null;
}

/**
 * JSON 读取备忘（raw 串 → 已 parse 的对象）
 *
 * 为什么要它：`mixology_sessions_v1` 整包 14MB（实测 31 场对局、14267kb），
 * 而 `getMixSession()` 是 `loadMixSessions()` 的 find，等于每次取一场对局都要把
 * 14MB 整串 parse 一遍。实测（dev 页、同一条数据、JSON.parse 挂钩计数）：
 * 进一场**只有 1 轮**的对局，一个同步任务里 parse 了 22 次、共 756ms，整段长任务 818ms；
 * 193 轮那场 parse 14 次共 958ms，长任务 3863ms。轮数无关的那 ~750ms 全是重复解析，
 * 真机 WebView 上还要再放大数倍——这就是"打开特调对局卡好几秒"的固定地板。
 *
 * 失效口径（刻意做窄，不赌调用方不改对象）：
 * 1. 命中要求 `hit.raw === kvGet(key)`——kv-db 的内存缓存在被覆写前返回同一个字符串引用，
 *    所以备份导入等"从外面写这个 key"的路径会让引用变化，自动落回重新 parse；
 * 2. `writeJson` 写完立即删除条目：本模块内存里的对象可能正是缓存里那一份，
 *    调用方先改再写、或改了没写，都不该让缓存和磁盘对不上号；
 * 3. 交给调用方的一律是**新数组 / 新顶层对象**（`freshCopy`），缓存里那份永不外流：
 *    `loadMixSessions` 本来就 `.map` 出新的对局对象，`setSession(getMixSession(id))`
 *    依赖"每次拿到新引用"才会重渲染，这里不能省。
 *
 * 共享的只有更深层（turns 数组、state、mechanismStore 的引用）。全仓 grep 过：
 * 对局写路径清一色 `{ ...session, turns }` / `turns.slice()`，唯一的 `turns.push`
 * 在 engine.ts:264，对象是当场新建的、不来自缓存。
 */
const jsonMemo = new Map<string, { raw: string; value: unknown }>();
const JSON_MEMO_MAX = 8;

function freshCopy<T>(value: T): T {
    if (Array.isArray(value)) return value.slice() as unknown as T;
    if (value && typeof value === "object") return { ...(value as object) } as T;
    return value;
}

function readJson<T>(key: string, fallback: T): T {
    const raw = kvGet(key);
    if (!raw) {
        jsonMemo.delete(key);
        return fallback;
    }
    const hit = jsonMemo.get(key);
    if (hit && hit.raw === raw) return freshCopy(hit.value as T);
    try {
        const parsed = (JSON.parse(raw) ?? fallback) as T;
        // 超出上限时按插入顺序丢最旧的（Map 迭代顺序即插入顺序）
        if (jsonMemo.size >= JSON_MEMO_MAX && !jsonMemo.has(key)) {
            const oldest = jsonMemo.keys().next().value as string | undefined;
            if (oldest !== undefined) jsonMemo.delete(oldest);
        }
        jsonMemo.set(key, { raw, value: parsed });
        return freshCopy(parsed);
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
    jsonMemo.delete(key);
}

// ---------- 创作者资料 ----------

/** 发布到酒材/配方页时用的署名与头像（都选填；名字留空时线上回退到账号昵称） */
export type MixProfile = {
    name?: string;
    /** 头像 dataURL（压缩后的小图） */
    avatar?: string;
};

export function loadMixProfile(): MixProfile {
    const stored = readJson<MixProfile>(PROFILE_KEY, {});
    if (!stored || typeof stored !== "object") return {};
    return {
        name: typeof stored.name === "string" && stored.name.trim() ? stored.name.trim() : undefined,
        avatar: typeof stored.avatar === "string" && stored.avatar ? stored.avatar : undefined,
    };
}

export function saveMixProfile(profile: MixProfile): void {
    writeJson(PROFILE_KEY, {
        name: profile.name?.trim() || undefined,
        avatar: profile.avatar || undefined,
    });
}

// ---------- 连接器 ----------
// 玩家自己的外部接口配置（地址与密钥）。不是材料：不进酒柜列表、不导出、不上大厅。

export const MIX_CONNECTORS_UPDATED_EVENT = "mix-connectors-updated";

export function loadMixConnectors(): MixConnector[] {
    const stored = readJson<MixConnector[]>(CONNECTORS_KEY, []);
    if (!Array.isArray(stored)) return [];
    return stored
        .filter((c): c is MixConnector => Boolean(c) && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string")
        .map((c): MixConnector => ({
            ...c,
            name: c.name.trim().toLowerCase(),
            url: typeof c.url === "string" ? c.url : "",
            method: c.method === "GET" ? "GET" : "POST",
            headers: c.headers && typeof c.headers === "object" ? c.headers : {},
            body: typeof c.body === "string" ? c.body : "",
            response: c.response === "text" || c.response === "blob" ? c.response : "json",
        }))
        .filter((c) => MIX_CONNECTOR_NAME_RE.test(c.name))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** 机括按名字找连接器；同名只会有一件（保存时按名字去重） */
export function findMixConnector(name: string): MixConnector | null {
    const key = name.trim().toLowerCase();
    return loadMixConnectors().find((c) => c.name === key) ?? null;
}

function broadcastConnectors(): void {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(MIX_CONNECTORS_UPDATED_EVENT));
}

/** 新增或覆盖（id 相同即覆盖；改成已有的名字会顶掉同名那件） */
export function saveMixConnector(connector: MixConnector): void {
    const name = connector.name.trim().toLowerCase();
    const list = loadMixConnectors().filter((c) => c.id !== connector.id && c.name !== name);
    list.push({ ...connector, name, updatedAt: Date.now() });
    writeJson(CONNECTORS_KEY, list);
    broadcastConnectors();
}

export function deleteMixConnector(id: string): void {
    writeJson(CONNECTORS_KEY, loadMixConnectors().filter((c) => c.id !== id));
    broadcastConnectors();
}

// ---------- 酒柜（材料） ----------

export function loadMixCabinet(): MixMaterial[] {
    const stored = readJson<MixMaterial[]>(CABINET_KEY, []);
    const list = Array.isArray(stored) ? stored : [];
    // 迁移：老版本把出厂件种进了酒柜——现在出厂件工厂直读、酒材页展示，从柜里剔掉
    const next = list.filter((m) => !isMixBuiltinId(m.id));
    if (next.length !== list.length) writeJson(CABINET_KEY, next);
    return next;
}

export function listMixMaterials(kind: MixMaterialKind): MixMaterial[] {
    return loadMixCabinet()
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 吧台/对局的槽位候选：官方出厂件在前 + 酒柜材料在后 */
export function listMixPickables(kind: MixMaterialKind): MixMaterial[] {
    return [...listMixBuiltins(kind), ...listMixMaterials(kind)];
}

export function getMixMaterial(id: string): MixMaterial | null {
    return getMixBuiltin(id) ?? loadMixCabinet().find((m) => m.id === id) ?? null;
}

/** 新增或整体覆盖一件材料（id 相同即覆盖） */
export function saveMixMaterial(material: MixMaterial): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === material.id);
    const stamped = { ...material, updatedAt: Date.now() };
    // 只有角色卡收封面：其余种类的列表海报由渲染缩样自动生成，
    // 老材料/导入文件残留的 cover 在落库这道总闸口洗掉，不再跟着材料到处走
    if (stamped.kind !== "character") delete (stamped as { cover?: string }).cover;
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(CABINET_KEY, list);
}

/**
 * 云端同步成功后的记账：写 publishedId 并把 publishedAt 对齐当前 updatedAt。
 * 不能走 saveMixMaterial（它会重打 updatedAt，材料就永远显示"有未上架修改"）。
 */
export function markMixMaterialSynced(id: string, publishedId: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(CABINET_KEY, list);
}

/**
 * 按云端条目 id 反查本地件。
 * 用在「把自己发布的作品拉回本地」：柜里已经有关联着这条云端条目的原件时，
 * 直接用那一件，不要再拉一份出来变成两件同名材料。
 */
export function findMixMaterialByPublishedId(cloudId: string): MixMaterial | null {
    return loadMixCabinet().find((m) => m.publishedId === cloudId) ?? null;
}

/** 云端条目已下架/丢失时清掉本地的发布关联，回到"未上架"态 */
export function clearMixMaterialPublished(id: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixMaterial;
    writeJson(CABINET_KEY, list);
}

/** 删除材料（官方件拒删）。返回是否真的删了。 */
export function deleteMixMaterial(id: string): boolean {
    if (isMixBuiltinId(id)) return false;
    const list = loadMixCabinet();
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    writeJson(CABINET_KEY, next);
    return true;
}

// ---------- 特调方案 ----------

/** 早期一格只放一件、槽位存的是材料 id 字符串；读盘时统一成新形状（有序清单） */
function migrateRecipeSlots<T extends { slots?: unknown }>(item: T): T {
    return { ...item, slots: normalizeMixSlots(item.slots as never) };
}

export function loadMixRecipes(): MixRecipe[] {
    const stored = readJson<MixRecipe[]>(RECIPES_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .map(migrateRecipeSlots)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixRecipe(id: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.id === id) ?? null;
}

export function saveMixRecipe(recipe: MixRecipe): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === recipe.id);
    const stamped = { ...recipe, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(RECIPES_KEY, list);
}

export function deleteMixRecipe(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    writeJson(RECIPES_KEY, list.filter((r) => r.id !== id));
}

/** 同 markMixMaterialSynced：配方云端同步成功后的记账 */
export function markMixRecipeSynced(id: string, publishedId: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(RECIPES_KEY, list);
}

/** 同 findMixMaterialByPublishedId：按云端条目 id 反查本地配方 */
export function findMixRecipeByPublishedId(cloudId: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.publishedId === cloudId) ?? null;
}

/** 云端配方条目已下架/丢失时清掉本地发布关联 */
export function clearMixRecipePublished(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixRecipe;
    writeJson(RECIPES_KEY, list);
}

/**
 * 按云端条目 id 反查本地件并清掉发布关联——在「我的发布」里下架成功后调用，
 * 让酒柜/配方列表的「已上架」徽章立刻消失，而不是等下次更新时撞 404。
 */
export function clearMixPublishedByCloudId(type: "material" | "recipe", cloudId: string): void {
    if (type === "material") {
        const material = loadMixCabinet().find((m) => m.publishedId === cloudId);
        if (material) clearMixMaterialPublished(material.id);
    } else {
        const recipe = readJson<MixRecipe[]>(RECIPES_KEY, []).find((r) => r.publishedId === cloudId);
        if (recipe) clearMixRecipePublished(recipe.id);
    }
}

// ---------- 对局 ----------

export function loadMixSessions(): MixSession[] {
    const stored = readJson<MixSession[]>(SESSIONS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        // 对局里存的是开局时的方案快照，同样要迁
        .map((session) => ({ ...session, recipe: migrateRecipeSlots(session.recipe) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixSession(id: string): MixSession | null {
    return loadMixSessions().find((s) => s.id === id) ?? null;
}

export function saveMixSession(session: MixSession): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === session.id);
    const stamped = { ...session, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(SESSIONS_KEY, list);
}

export function deleteMixSession(id: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    writeJson(SESSIONS_KEY, list.filter((s) => s.id !== id));
    // 顺手从所有对局文件夹里摘掉这场，文件夹的 sessionIds 不会越攒越脏
    const folders = loadMixSessionFolders();
    let changed = false;
    for (const f of folders) {
        const before = f.sessionIds.length;
        f.sessionIds = f.sessionIds.filter((sid) => sid !== id);
        if (f.sessionIds.length !== before) { f.updatedAt = Date.now(); changed = true; }
    }
    if (changed) writeJson(SESSION_FOLDERS_KEY, folders);
    // 缓冲发送区里这场的待发消息一并作废，不给孤儿数据留存档
    dropMixPendingForSession(id);
    // 这场对局的执笔记忆（记忆卡/情感卡/水位/执笔状态/大纲/历史）同步清理，
    // 不留 narrative:{id}:* 孤儿。purge 是同步 API，和上面两类清理同构。
    purgeNarrativeSessionData(id);
}

/**
 * 按方案槽位取材料实体（出厂件走工厂直读）。一格可能叠了多件，按顺序全部取出；
 * 取不到的（材料被删）静默跳过并记进 missing。这里不判生效条件——条件要看对局现场，
 * 由引擎在装配前逐条判定。
 */
export function resolveMixRecipeMaterials(
    recipe: MixRecipe,
): {
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>>;
    missing: MixMaterialKind[];
} {
    const cabinet = loadMixCabinet();
    const materials: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
    const entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>> = {};
    const missing: MixMaterialKind[] = [];
    for (const kind of MIX_SLOT_ORDER) {
        const slotEntries = mixSlotEntries(recipe.slots, kind);
        if (!slotEntries.length) continue;
        const resolved: { entry: MixSlotEntry; material: MixMaterial }[] = [];
        for (const entry of slotEntries) {
            const found = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
            if (found && found.kind === kind) resolved.push({ entry, material: found });
            else if (!missing.includes(kind)) missing.push(kind);
        }
        if (resolved.length) {
            entries[kind] = resolved;
            materials[kind] = resolved.map((r) => r.material);
        }
    }
    return { materials, entries, missing };
}

// ---------- 喜好配方（快捷搭配预设） ----------

export function loadMixFavorites(): MixFavoritePreset[] {
    const stored = readJson<MixFavoritePreset[]>(FAVORITES_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .filter((p): p is MixFavoritePreset => Boolean(p) && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string")
        .map((p) => ({ ...p, slots: normalizeMixSlots(p.slots) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixFavorite(id: string): MixFavoritePreset | null {
    return loadMixFavorites().find((p) => p.id === id) ?? null;
}

export function saveMixFavorite(preset: MixFavoritePreset): void {
    const list = loadMixFavorites();
    const idx = list.findIndex((p) => p.id === preset.id);
    const stamped = { ...preset, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(FAVORITES_KEY, list);
}

export function deleteMixFavorite(id: string): void {
    writeJson(FAVORITES_KEY, loadMixFavorites().filter((p) => p.id !== id));
}

// ---------- 配方收纳文件夹 ----------

export function loadMixFolders(): MixRecipeFolder[] {
    const stored = readJson<MixRecipeFolder[]>(FOLDERS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .filter((f): f is MixRecipeFolder => Boolean(f) && typeof f === "object" && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.recipeIds))
        .sort((a, b) => a.createdAt - b.createdAt);
}

export function getMixFolder(id: string): MixRecipeFolder | null {
    return loadMixFolders().find((f) => f.id === id) ?? null;
}

export function saveMixFolder(folder: MixRecipeFolder): void {
    const list = loadMixFolders();
    const idx = list.findIndex((f) => f.id === folder.id);
    const stamped = { ...folder, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(FOLDERS_KEY, list);
}

export function deleteMixFolder(id: string): void {
    writeJson(FOLDERS_KEY, loadMixFolders().filter((f) => f.id !== id));
}

/** 把配方加入指定文件夹；如果配方已在其他文件夹里，先从旧文件夹移除 */
export function addRecipeToFolder(recipeId: string, folderId: string): void {
    const folders = loadMixFolders();
    // 先从所有文件夹移除这个配方
    for (const f of folders) {
        f.recipeIds = f.recipeIds.filter((rid) => rid !== recipeId);
    }
    // 再加到目标文件夹
    const target = folders.find((f) => f.id === folderId);
    if (target) {
        if (!target.recipeIds.includes(recipeId)) {
            target.recipeIds.push(recipeId);
        }
        target.updatedAt = Date.now();
    }
    writeJson(FOLDERS_KEY, folders);
}

/** 把配方从文件夹移除（回到未分类） */
export function removeRecipeFromFolder(recipeId: string): void {
    const folders = loadMixFolders();
    for (const f of folders) {
        const before = f.recipeIds.length;
        f.recipeIds = f.recipeIds.filter((rid) => rid !== recipeId);
        if (f.recipeIds.length !== before) f.updatedAt = Date.now();
    }
    writeJson(FOLDERS_KEY, folders);
}

/** 查询配方所在的文件夹 id，不在任何文件夹则返回 null */
export function findRecipeFolderId(recipeId: string): string | null {
    const folders = loadMixFolders();
    for (const f of folders) {
        if (f.recipeIds.includes(recipeId)) return f.id;
    }
    return null;
}

// ---------- 对局收纳文件夹（与配方文件夹同一套范式） ----------

export function loadMixSessionFolders(): MixSessionFolder[] {
    const stored = readJson<MixSessionFolder[]>(SESSION_FOLDERS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .filter((f): f is MixSessionFolder => Boolean(f) && typeof f === "object" && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.sessionIds))
        .sort((a, b) => a.createdAt - b.createdAt);
}

export function getMixSessionFolder(id: string): MixSessionFolder | null {
    return loadMixSessionFolders().find((f) => f.id === id) ?? null;
}

export function saveMixSessionFolder(folder: MixSessionFolder): void {
    const list = loadMixSessionFolders();
    const idx = list.findIndex((f) => f.id === folder.id);
    const stamped = { ...folder, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(SESSION_FOLDERS_KEY, list);
}

export function deleteMixSessionFolder(id: string): void {
    writeJson(SESSION_FOLDERS_KEY, loadMixSessionFolders().filter((f) => f.id !== id));
}

/** 把对局加入指定文件夹；如果对局已在其他文件夹里，先从旧文件夹移除 */
export function addSessionToFolder(sessionId: string, folderId: string): void {
    const folders = loadMixSessionFolders();
    // 先从所有文件夹移除这场对局
    for (const f of folders) {
        f.sessionIds = f.sessionIds.filter((sid) => sid !== sessionId);
    }
    // 再加到目标文件夹
    const target = folders.find((f) => f.id === folderId);
    if (target) {
        if (!target.sessionIds.includes(sessionId)) {
            target.sessionIds.push(sessionId);
        }
        target.updatedAt = Date.now();
    }
    writeJson(SESSION_FOLDERS_KEY, folders);
}

/** 把对局从文件夹移除（回到未分类） */
export function removeSessionFromFolder(sessionId: string): void {
    const folders = loadMixSessionFolders();
    for (const f of folders) {
        const before = f.sessionIds.length;
        f.sessionIds = f.sessionIds.filter((sid) => sid !== sessionId);
        if (f.sessionIds.length !== before) f.updatedAt = Date.now();
    }
    writeJson(SESSION_FOLDERS_KEY, folders);
}

/** 查询对局所在的文件夹 id，不在任何文件夹则返回 null */
export function findSessionFolderId(sessionId: string): string | null {
    const folders = loadMixSessionFolders();
    for (const f of folders) {
        if (f.sessionIds.includes(sessionId)) return f.id;
    }
    return null;
}

// ---------- 重命名对局 ----------

/** 给一场对局改名（空串视为清除自定义名字，回到「角色名 · 配方名」兜底） */
export function renameMixSession(id: string, newName: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const trimmed = newName.trim();
    list[idx] = { ...list[idx], name: trimmed || undefined, updatedAt: Date.now() };
    writeJson(SESSIONS_KEY, list);
}

// ---------- 世界树 / 支线谱系 ----------

/** 支线元数据补丁：支线名、备注、树内摆放坐标、层级，按需局部更新 */
export type MixSessionTreeMetaPatch = {
    branchName?: string;
    branchNote?: string;
    treeX?: number;
    treeY?: number;
    depth?: number;
};

export function updateMixSessionTreeMeta(id: string, patch: MixSessionTreeMetaPatch): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const cur = list[idx];
    const next: MixSession = { ...cur };
    if (patch.branchName !== undefined) next.branchName = patch.branchName.trim() || undefined;
    if (patch.branchNote !== undefined) next.branchNote = patch.branchNote || undefined;
    if (patch.treeX !== undefined) next.treeX = patch.treeX;
    if (patch.treeY !== undefined) next.treeY = patch.treeY;
    if (patch.depth !== undefined) next.depth = patch.depth;
    next.updatedAt = Date.now();
    list[idx] = next;
    writeJson(SESSIONS_KEY, list);
}

/**
 * 删除一条支线：它的直接子支线"上提一级"挂到被删节点的父节点（根被删则子支线各自成根），
 * 整棵子树层级随之下移一层，进度不丢、树不散。然后才真正删掉该节点。
 */
export function deleteMixSessionBranch(id: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const node = list.find((s) => s.id === id);
    if (!node) return;

    const byId = new Map(list.map((s) => [s.id, s] as const));
    const children = list.filter((s) => s.parentId === id);

    // 递归把 subtree 重挂到 newParent（含根重置），并整体下移一层
    const reparent = (childId: string, newParentId: string | undefined, newRootId: string, newDepth: number) => {
        const child = byId.get(childId);
        if (!child) return;
        child.parentId = newParentId;
        child.rootId = newRootId;
        child.depth = newDepth;
        for (const grand of list.filter((s) => s.parentId === childId)) {
            reparent(grand.id, childId, newRootId, newDepth + 1);
        }
    };

    const grandParentId = node.parentId;
    const grandParent = grandParentId ? byId.get(grandParentId) : undefined;
    for (const child of children) {
        if (grandParent) {
            reparent(child.id, grandParentId, child.rootId ?? child.id, (grandParent.depth ?? 0) + 1);
        } else {
            reparent(child.id, undefined, child.id, 0);
        }
    }

    writeJson(SESSIONS_KEY, list);
    deleteMixSession(id);
}

/** 树节点：环绕一场对局，挂着它的子支线 */
export type MixSessionTreeNode = {
    session: MixSession;
    children: MixSessionTreeNode[];
};

/**
 * 把扁平对局列表按 parentId 拼成森林（多棵世界树）。
 * 根 = parentId 为空或指向了不存在的节点。返回前按 createdAt 稳定排序，
 * 方便自动布局时同一层的兄弟顺序固定。
 */
export function buildMixSessionForest(sessions: MixSession[]): MixSessionTreeNode[] {
    const byId = new Map(sessions.map((s) => [s.id, s] as const));
    const nodes = new Map<string, MixSessionTreeNode>();
    for (const s of sessions) nodes.set(s.id, { session: s, children: [] });

    const roots: MixSessionTreeNode[] = [];
    for (const s of sessions) {
        const node = nodes.get(s.id);
        if (!node) continue;
        if (s.parentId && byId.has(s.parentId) && nodes.has(s.parentId)) {
            nodes.get(s.parentId)!.children.push(node);
        } else {
            roots.push(node);
        }
    }

    const sortFn = (a: MixSessionTreeNode, b: MixSessionTreeNode) =>
        (a.session.createdAt ?? 0) - (b.session.createdAt ?? 0);
    const sortRec = (n: MixSessionTreeNode) => {
        n.children.sort(sortFn);
        n.children.forEach(sortRec);
    };
    roots.sort(sortFn);
    roots.forEach(sortRec);
    return roots;
}


// ---------- 重命名配方 ----------

export function renameMixRecipe(id: string, newName: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], name: newName, updatedAt: Date.now() };
    writeJson(RECIPES_KEY, list);
}
