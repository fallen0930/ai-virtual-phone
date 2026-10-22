import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "./theme-storage";
import type { ThemeAssetType } from "./theme-types";

// We can leverage the existing IndexedDB logic in theme-storage.ts by 
// just casting a custom type like "chat_bg" to ThemeAssetType to store chat assets.

export async function saveChatImageToIndexedDB(blob: Blob): Promise<string> {
    // "chat_bg" is not in ThemeAssetType strictly, but JS at runtime doesn't care.
    return saveThemeAssetFromBlob(blob, "chat_bg" as ThemeAssetType);
}

export async function getChatImageFromIndexedDB(id: string): Promise<string | null> {
    return getThemeAssetDataUrl(id);
}
