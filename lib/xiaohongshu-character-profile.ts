import type { Character } from "./character-types";
import type { CheckPhoneXiaohongshuPayload } from "./checkphone-config";
import { readPhoneSnapshotCache } from "./checkphone-storage";

export function resolveCharacterXiaohongshuDisplayName(character: Pick<Character, "id" | "name">): string {
  const snapshot = readPhoneSnapshotCache<CheckPhoneXiaohongshuPayload>(character.id, "xiaohongshu");
  const profileName = snapshot?.payload?.profile?.name?.trim();
  return profileName || character.name;
}
