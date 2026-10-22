// Board layout (drag positions + tilt) for the world-grouping "evidence board".
// Stored SEPARATELY from character-world-storage so it never touches the
// world/relation data that the moments engine relies on.
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const LAYOUT_KEY = "ai_phone_character_world_layout_v1";
registerKvMigration(LAYOUT_KEY);

export type BoardPos = { x: number; y: number; rot: number };
type LayoutMap = Record<string, Record<string, BoardPos>>; // worldId -> charId -> pos

function loadMap(): LayoutMap {
    try {
        const raw = kvGet(LAYOUT_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed as LayoutMap : {};
    } catch {
        return {};
    }
}

function saveMap(map: LayoutMap): void {
    if (typeof window === "undefined") return;
    kvSet(LAYOUT_KEY, JSON.stringify(map));
}

export function getWorldLayout(worldId: string): Record<string, BoardPos> {
    return loadMap()[worldId] ?? {};
}

export function setCharacterBoardPos(worldId: string, characterId: string, pos: BoardPos): void {
    const map = loadMap();
    if (!map[worldId]) map[worldId] = {};
    map[worldId][characterId] = pos;
    saveMap(map);
}

export function mergeWorldPositions(worldId: string, positions: Record<string, BoardPos>): void {
    const map = loadMap();
    map[worldId] = { ...(map[worldId] ?? {}), ...positions };
    saveMap(map);
}
