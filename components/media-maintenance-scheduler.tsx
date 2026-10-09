"use client";

import { useEffect } from "react";
import { runScheduledMediaMaintenance } from "@/lib/media-maintenance";

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function MediaMaintenanceScheduler() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let timeoutHandle: number | null = null;
    let idleHandle: number | null = null;

    const run = () => {
      if (cancelled) return;
      void runScheduledMediaMaintenance().catch((error) => {
        console.warn("[MediaMaintenanceScheduler] scheduled run failed:", error);
      });
    };

    timeoutHandle = window.setTimeout(() => {
      if (cancelled) return;
      const idleWindow = window as WindowWithIdleCallback;
      if (typeof idleWindow.requestIdleCallback === "function") {
        idleHandle = idleWindow.requestIdleCallback(run, { timeout: 5000 });
        return;
      }
      run();
    }, 45000);

    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) {
        (window as WindowWithIdleCallback).cancelIdleCallback?.(idleHandle);
      }
    };
  }, []);

  return null;
}
