// Tracks in-flight check-phone refreshes by key (e.g. `${characterId}:weibo`)
// at module scope, so that navigating away mid-refresh and back still shows the
// spinning indicator and picks up the result when the background request lands.
// Page state alone can't do this: switching apps unmounts the page, dropping its
// local `loading` while the async generate keeps running.

import { useCallback, useEffect, useReducer, useRef, type Dispatch, type SetStateAction } from "react";

import type { CheckPhoneAppId, CheckPhoneSnapshot } from "./checkphone-config";
import { loadPhoneSnapshot } from "./checkphone-storage";

type Listener = () => void;

const inFlight = new Set<string>();
const listeners = new Set<Listener>();

export function isCheckPhoneRefreshing(key: string): boolean {
  return inFlight.has(key);
}

export function beginCheckPhoneRefresh(key: string): void {
  inFlight.add(key);
  emit();
}

export function endCheckPhoneRefresh(key: string): void {
  if (inFlight.delete(key)) emit();
}

export function subscribeCheckPhoneRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * Drop-in replacement for `useState(false)` driving a check-phone page's
 * `loading` flag, but backed by the module-level tracker keyed by
 * `${characterId}:${appId}`. Because the state lives outside the component:
 *   - re-entering a page mid-refresh keeps the spinner turning;
 *   - when a background refresh (possibly started by a now-unmounted instance)
 *     finishes, the freshly-saved snapshot is reloaded via `onSnapshot`.
 * `handleRefresh` keeps calling `setLoading(true/false)` exactly as before.
 */
export function useCheckPhoneRefresh<T>(
  characterId: string,
  appId: CheckPhoneAppId,
  onSnapshot: Dispatch<SetStateAction<CheckPhoneSnapshot<T> | null>>,
): [boolean, (loading: boolean) => void] {
  const key = `${characterId}:${appId}`;
  const [, force] = useReducer((count: number) => count + 1, 0);
  const loading = isCheckPhoneRefreshing(key);
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const wasLoading = useRef(loading);

  useEffect(() => subscribeCheckPhoneRefresh(() => force()), []);

  useEffect(() => {
    if (wasLoading.current && !loading) {
      // A refresh just ended (here or in another mount) → pull the latest snapshot.
      void loadPhoneSnapshot<T>(characterId, appId).then((latest) => onSnapshotRef.current(latest));
    }
    wasLoading.current = loading;
  }, [loading, characterId, appId]);

  const setLoading = useCallback(
    (next: boolean) => {
      if (next) beginCheckPhoneRefresh(key);
      else endCheckPhoneRefresh(key);
    },
    [key],
  );

  return [loading, setLoading];
}
