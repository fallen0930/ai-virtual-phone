import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { MASCOT_PERSONA } from "./mascot-prompts";

export const MASCOT_SETTINGS_KEY = "ai_phone_mascot_settings_v1";
export const DEFAULT_MASCOT_DISPLAY_NAME = "AI助手";
export const DEFAULT_MASCOT_AVATAR = "/mascot.png";

export type MascotSettings = {
    nickname: string;
    avatarImage?: string;
    personaPrompt: string;
    chatEnabled: boolean;
    chatBackgroundImage?: string;
    chatCustomCSS?: string;
};

export const DEFAULT_MASCOT_SETTINGS: MascotSettings = {
    nickname: DEFAULT_MASCOT_DISPLAY_NAME,
    avatarImage: DEFAULT_MASCOT_AVATAR,
    personaPrompt: MASCOT_PERSONA,
    chatEnabled: true,
    chatBackgroundImage: "",
    chatCustomCSS: "",
};

registerKvMigration(MASCOT_SETTINGS_KEY);

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSettings: MascotSettings = DEFAULT_MASCOT_SETTINGS;

function normalizeMascotSettings(raw: unknown): MascotSettings {
    const src = (raw && typeof raw === "object") ? raw as Partial<MascotSettings> : {};
    const nickname = typeof src.nickname === "string" && src.nickname.trim()
        ? src.nickname.trim()
        : DEFAULT_MASCOT_DISPLAY_NAME;
    const personaPrompt = typeof src.personaPrompt === "string" && src.personaPrompt.trim()
        ? src.personaPrompt
        : MASCOT_PERSONA;
    return {
        ...DEFAULT_MASCOT_SETTINGS,
        ...src,
        nickname,
        personaPrompt,
        chatEnabled: src.chatEnabled !== false,
        avatarImage: typeof src.avatarImage === "string" && src.avatarImage.trim() ? src.avatarImage : DEFAULT_MASCOT_AVATAR,
        chatBackgroundImage: typeof src.chatBackgroundImage === "string" ? src.chatBackgroundImage : "",
        chatCustomCSS: typeof src.chatCustomCSS === "string" ? src.chatCustomCSS : "",
    };
}

export function loadMascotSettings(): MascotSettings {
    if (typeof window === "undefined") return DEFAULT_MASCOT_SETTINGS;
    const raw = kvGet(MASCOT_SETTINGS_KEY);
    if (raw === cachedRaw) return cachedSettings;
    cachedRaw = raw;
    if (!raw) {
        cachedSettings = DEFAULT_MASCOT_SETTINGS;
        return cachedSettings;
    }
    try {
        cachedSettings = normalizeMascotSettings(JSON.parse(raw));
    } catch {
        cachedSettings = DEFAULT_MASCOT_SETTINGS;
    }
    return cachedSettings;
}

export function getMascotSettingsSnapshot(): MascotSettings {
    return loadMascotSettings();
}

export function subscribeMascotSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function saveMascotSettings(settings: MascotSettings): MascotSettings {
    const normalized = normalizeMascotSettings(settings);
    cachedSettings = normalized;
    cachedRaw = JSON.stringify(normalized);
    if (typeof window !== "undefined") {
        kvSet(MASCOT_SETTINGS_KEY, cachedRaw);
        window.dispatchEvent(new CustomEvent("mascot-settings-updated", { detail: normalized }));
    }
    for (const listener of listeners) listener();
    return normalized;
}

export function updateMascotSettings(updates: Partial<MascotSettings>): MascotSettings {
    return saveMascotSettings({ ...loadMascotSettings(), ...updates });
}

export function getMascotPersonaPrompt(): string {
    const settings = loadMascotSettings();
    return settings.personaPrompt.trim() || MASCOT_PERSONA;
}

export async function resolveMascotImageRef(ref: string | undefined, fallback = DEFAULT_MASCOT_AVATAR): Promise<string> {
    const value = (ref || "").trim();
    if (!value) return fallback;
    if (
        value.startsWith("/")
        || value.startsWith("data:")
        || value.startsWith("http://")
        || value.startsWith("https://")
        || value.startsWith("blob:")
    ) {
        return value;
    }
    try {
        const { getChatImageFromIndexedDB } = await import("./chat-asset-storage");
        return await getChatImageFromIndexedDB(value) || fallback;
    } catch {
        return fallback;
    }
}
