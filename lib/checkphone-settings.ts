import { kvGet, kvSet } from "./kv-db";
import { DEFAULT_CHECKPHONE_BILINGUAL_PROMPT } from "./bilingual-prompt-defaults";

const CHECKPHONE_SETTINGS_KEY = "checkphone-settings";

export type CheckPhoneSettings = {
  bilingualTranslationEnabled: boolean;
  collapseBilingualTranslation: boolean;
  bilingualTranslationPrompt: string;
};

const DEFAULT_CHECKPHONE_SETTINGS: CheckPhoneSettings = {
  bilingualTranslationEnabled: true,
  collapseBilingualTranslation: true,
  bilingualTranslationPrompt: DEFAULT_CHECKPHONE_BILINGUAL_PROMPT,
};

export const CHECKPHONE_SETTINGS_CHANGED_EVENT = "checkphone-settings-changed";

export function loadCheckPhoneSettings(): CheckPhoneSettings {
  try {
    const raw = kvGet(CHECKPHONE_SETTINGS_KEY);
    if (!raw) return DEFAULT_CHECKPHONE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CheckPhoneSettings>;
    return {
      ...DEFAULT_CHECKPHONE_SETTINGS,
      bilingualTranslationEnabled: parsed.bilingualTranslationEnabled !== false,
      collapseBilingualTranslation: parsed.collapseBilingualTranslation !== false,
      bilingualTranslationPrompt:
        typeof parsed.bilingualTranslationPrompt === "string"
          ? parsed.bilingualTranslationPrompt
          : DEFAULT_CHECKPHONE_BILINGUAL_PROMPT,
    };
  } catch {
    return DEFAULT_CHECKPHONE_SETTINGS;
  }
}

export function saveCheckPhoneSettings(settings: CheckPhoneSettings): void {
  kvSet(CHECKPHONE_SETTINGS_KEY, JSON.stringify(settings));
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CheckPhoneSettings>(CHECKPHONE_SETTINGS_CHANGED_EVENT, {
      detail: settings,
    }),
  );
}
