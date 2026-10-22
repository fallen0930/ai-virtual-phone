"use client";

// Module-level tracker for in-flight diary generation. Generation survives the
// diary app unmounting (the async work keeps running), but component state does
// not — so re-entering the app showed no "generating" indicator. This keeps the
// in-flight set at module scope and lets the UI re-attach to it.

import { useEffect, useState } from "react";

const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => {
    try { listener(); } catch { /* ignore */ }
  });
}

export function beginDiaryGeneration(characterId: string): void {
  inFlight.add(characterId);
  emit();
}

export function endDiaryGeneration(characterId: string): void {
  inFlight.delete(characterId);
  emit();
}

export function useDiaryGenerating(): string[] {
  const [ids, setIds] = useState<string[]>(() => Array.from(inFlight));
  useEffect(() => {
    const handler = () => setIds(Array.from(inFlight));
    listeners.add(handler);
    handler();
    return () => { listeners.delete(handler); };
  }, []);
  return ids;
}
