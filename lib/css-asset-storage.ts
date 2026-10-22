import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type CssAssetKind = "bubble" | "icon" | "texture" | "background" | "misc";

export type CssAssetRecord = {
    id: string;
    label: string;
    kind: CssAssetKind;
    mediaRef: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    prompt?: string;
    publicUrl?: string;
    deleteUrl?: string;
    sourceAssetId?: string;
    createdAt: number;
    updatedAt: number;
};

export type SaveCssAssetRecordInput = Omit<CssAssetRecord, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
};

const CSS_ASSETS_KEY = "ai_phone_css_assets_v1";
const MAX_CSS_ASSET_RECORDS = 120;

registerKvMigration(CSS_ASSETS_KEY);

function createCssAssetId(): string {
    return `css_asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeKind(value: unknown): CssAssetKind {
    if (value === "bubble" || value === "icon" || value === "texture" || value === "background" || value === "misc") {
        return value;
    }
    return "misc";
}

function normalizeAssetRecord(value: unknown): CssAssetRecord | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Partial<CssAssetRecord>;
    if (typeof row.id !== "string" || !row.id.trim()) return null;
    if (typeof row.mediaRef !== "string" || !row.mediaRef.trim()) return null;
    const now = Date.now();
    return {
        id: row.id,
        label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : "未命名素材",
        kind: normalizeKind(row.kind),
        mediaRef: row.mediaRef,
        mimeType: typeof row.mimeType === "string" && row.mimeType.trim() ? row.mimeType : "image/png",
        size: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : 0,
        width: typeof row.width === "number" && Number.isFinite(row.width) ? row.width : undefined,
        height: typeof row.height === "number" && Number.isFinite(row.height) ? row.height : undefined,
        prompt: typeof row.prompt === "string" ? row.prompt : undefined,
        publicUrl: typeof row.publicUrl === "string" && row.publicUrl.trim() ? row.publicUrl.trim() : undefined,
        deleteUrl: typeof row.deleteUrl === "string" && row.deleteUrl.trim() ? row.deleteUrl.trim() : undefined,
        sourceAssetId: typeof row.sourceAssetId === "string" && row.sourceAssetId.trim() ? row.sourceAssetId.trim() : undefined,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : now,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : now,
    };
}

function persistCssAssetRecords(records: CssAssetRecord[]): void {
    const ordered = [...records]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CSS_ASSET_RECORDS);
    kvSet(CSS_ASSETS_KEY, JSON.stringify(ordered));
}

export function loadCssAssetRecords(): CssAssetRecord[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(CSS_ASSETS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeAssetRecord)
            .filter((record): record is CssAssetRecord => Boolean(record))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

export function getCssAssetRecord(assetId: string): CssAssetRecord | null {
    const id = assetId.trim();
    if (!id) return null;
    return loadCssAssetRecords().find(record => record.id === id) ?? null;
}

export function saveCssAssetRecord(input: SaveCssAssetRecordInput): CssAssetRecord {
    const now = Date.now();
    const records = loadCssAssetRecords();
    const id = input.id || createCssAssetId();
    const existing = records.find(record => record.id === id);
    const record: CssAssetRecord = {
        id,
        label: input.label.trim() || existing?.label || "未命名素材",
        kind: normalizeKind(input.kind),
        mediaRef: input.mediaRef,
        mimeType: input.mimeType || existing?.mimeType || "image/png",
        size: Number.isFinite(input.size) ? input.size : existing?.size || 0,
        width: input.width,
        height: input.height,
        prompt: input.prompt ?? existing?.prompt,
        publicUrl: input.publicUrl ?? existing?.publicUrl,
        deleteUrl: input.deleteUrl ?? existing?.deleteUrl,
        sourceAssetId: input.sourceAssetId ?? existing?.sourceAssetId,
        createdAt: input.createdAt ?? existing?.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
    };
    const next = [record, ...records.filter(item => item.id !== id)];
    persistCssAssetRecords(next);
    return record;
}

export function updateCssAssetRecord(assetId: string, patch: Partial<CssAssetRecord>): CssAssetRecord | null {
    const records = loadCssAssetRecords();
    const index = records.findIndex(record => record.id === assetId);
    if (index < 0) return null;
    const updated = normalizeAssetRecord({
        ...records[index],
        ...patch,
        id: records[index].id,
        updatedAt: Date.now(),
    });
    if (!updated) return null;
    records[index] = updated;
    persistCssAssetRecords(records);
    return updated;
}
