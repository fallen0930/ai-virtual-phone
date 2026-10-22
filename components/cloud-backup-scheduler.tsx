"use client";

import { useEffect } from "react";

import { isCloudBackupConfigured, loadCloudBackupConfig } from "@/lib/cloud-backup/config";
import { loadCloudBackupState, runCloudBackup } from "@/lib/cloud-backup/engine";

// Module-level guard so overlapping timers/mounts never run two backups at once.
let backupRunning = false;

/**
 * Invisible component that drives auto cloud backup. Mounted once at the app
 * root. It checks every few minutes whether a backup is due (per the user's
 * interval) and, when idle, runs an incremental backup in the background. The
 * engine skips when nothing changed and processes module-by-module with awaits,
 * so it stays off the critical path and doesn't freeze the UI.
 */
export function CloudBackupScheduler() {
  useEffect(() => {
    let cancelled = false;

    const runWhenIdle = (fn: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => fn(), { timeout: 4000 });
      } else {
        window.setTimeout(fn, 400);
      }
    };

    const tick = () => {
      if (cancelled || backupRunning) return;
      const config = loadCloudBackupConfig();
      if (!config.enabled || !isCloudBackupConfigured(config)) return;

      const state = loadCloudBackupState();
      const dueMs = config.intervalHours * 3600_000;
      const last = state.lastCreatedAt ? Date.parse(state.lastCreatedAt) : 0;
      if (Number.isFinite(last) && last > 0 && Date.now() - last < dueMs) return;

      runWhenIdle(async () => {
        if (cancelled || backupRunning) return;
        backupRunning = true;
        try {
          // Cloud uploads are chunked, so large media is fine — always back up in full.
          await runCloudBackup(config, { excludeMedia: false });
        } catch {
          /* silent — surfaced in the data page status on next open */
        } finally {
          backupRunning = false;
        }
      });
    };

    const interval = window.setInterval(tick, 5 * 60_000);
    const initial = window.setTimeout(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(initial);
    };
  }, []);

  return null;
}
