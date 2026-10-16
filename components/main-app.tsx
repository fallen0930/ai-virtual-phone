"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import { AccountGate } from "@/components/auth/account-gate";
import { CloudBackupScheduler } from "@/components/cloud-backup-scheduler";
import { RealityBridgeScheduler } from "@/components/reality-bridge-scheduler";
import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { DesktopShell } from "./desktop-shell";
import { OfflinePushRevampAnnouncement } from "./offline-push-revamp-announcement";
import { SplashAnimation } from "./splash-animation";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb, isKvHydrated } from "@/lib/kv-db";
import { getThemeAssetMap, readThemeProfile } from "@/lib/theme-storage";
import { resolveActiveIconSkins, type ThemeProfile } from "@/lib/theme-types";
import { hasPendingMcpOAuthCallback } from "@/lib/tool-executor";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

/**
 * 首屏真正会用到的字体（开机动画用的 Inter / Instrument Serif /
 * JetBrains Mono 等，均为本地 woff2，命中缓存后几乎零成本）。
 *
 * ── 背景（这次要复盘的那件事）──
 * 这里原本有一版「把 35 个内置字体 URL 全部 fetch 预热 + 35 条
 * document.fonts.load」的无差别预热（BUILTIN_FONT_URLS / warmBuiltinFonts）。
 * 后来这个环节被整段摘掉了——函数体还留在文件里，但已经没有任何调用点，
 * 也就是说开机阶段不再等字体。代价是：首屏先用系统兜底字体排版，等主题字体
 * 到位后再整页重排一次，用户感知就是「进桌面闪一下 + 卡一下」。
 *
 * 现在恢复「预热」这件事本身，但只预热首屏必需的几条，并且带超时上限：
 * 超时就直接放行，绝不拿字体拖慢开机。
 */
const FIRST_PAINT_FONT_SPECS = [
  '300 1em "Inter"',
  '400 1em "Inter"',
  '500 1em "Inter"',
  '400 1em "Instrument Serif"',
  'italic 400 1em "Instrument Serif"',
  '300 1em "JetBrains Mono"',
  '400 1em "JetBrains Mono"',
  '400 1em "Major Mono Display"',
] as const;

/** 字体预热的最长等待时间；到点无条件放行。 */
const FONT_WARM_TIMEOUT_MS = 1500;

async function warmFirstPaintFonts(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.fonts) {
    return;
  }

  const loads = FIRST_PAINT_FONT_SPECS.map((spec) => document.fonts.load(spec).catch(() => []));
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WARM_TIMEOUT_MS));

  await Promise.race([Promise.all(loads).then(() => undefined), timeout]);
}

/** 主题自带字体（dataURL）预热：让桌面首帧直接就是最终排版。 */
function preloadFontFace(dataUrl: string | null | undefined): Promise<void> {
  if (!dataUrl || typeof window === "undefined") {
    return Promise.resolve();
  }

  const FontFaceCtor = (window as Window & { FontFace?: typeof FontFace }).FontFace;
  if (typeof FontFaceCtor !== "function") {
    return Promise.resolve();
  }

  try {
    const face = new FontFaceCtor("AIVirtualPhoneUserFont", `url(${dataUrl})`);
    return face.load().then(() => undefined).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

function SplashScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
  return (
    <main className="app-root splash-root">
      <section
        className="phone-shell-wrap splash-shell-wrap"
        aria-label={TEXT.loading}
      >
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              <SplashAnimation />
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                onClick={onEnter}
                disabled={!ready}
                aria-label="Enter"
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function collectFirstPaintThemeAssetIds(profile: ThemeProfile): string[] {
  const ids = [
    profile.wallpaperAssetId,
    profile.fontAssetId,
    profile.dockSkinAssetId,
    ...Object.values(resolveActiveIconSkins(profile))
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids));
}

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  const fontDataUrl = profile.fontAssetId ? assets[profile.fontAssetId] : null;
  // 壁纸解码与主题字体预热并行：字体先就位，桌面首帧就是最终排版，
  // 不会再出现「先兜底字体、再整页重排」的二次布局。
  await Promise.all([
    ...Object.values(assets).map(preloadImageDataUrl),
    preloadFontFace(fontDataUrl)
  ]);
  return { profile, assets };
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [kvHydrateFailed, setKvHydrateFailed] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // 申请持久化存储：批准后 iOS/安卓不会再因存储压力擅自回收 IndexedDB
    // （摊主钥匙、聊天记录等都存在里面）。静默尽力而为，被拒也无碍。
    void navigator.storage?.persist?.().catch(() => {});

    void (async () => {
      // 字体预热与 KV 水合并行：两者互不依赖，串行只会白白拉长开机等待。
      await Promise.all([hydrateKvDb(), warmFirstPaintFonts()]);
      if (cancelled) return;
      // 水合失败绝不放行：此时所有 KV 数据（设置/绑定/线下记录等）在内存里都是
      // 空的，进入后任何一次保存都会拿空数据整包覆盖 IndexedDB 里的真实历史。
      if (!isKvHydrated()) {
        setKvHydrateFailed(true);
        return;
      }
      setKvHydrateFailed(false);

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      if (hasPendingMcpOAuthCallback()) {
        setSplashDismissed(true);
      }
    })();

    // 安卓全屏兜底。是否请求全屏在每次点击时读取，设置切换后无需重载。
    const isMobile = window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)").matches;
    if (!isMobile) return () => {
      cancelled = true;
    };

    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    document.addEventListener("click", tryFullscreen);
    return () => {
      cancelled = true;
      document.removeEventListener("click", tryFullscreen);
    };
  }, [initAttempt]);

  if (kvHydrateFailed) {
    return (
      <main className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", padding: "0 28px", background: "#0c0c12", color: "#e8e8ef" }}>
        <div style={{ maxWidth: 340, textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>本机数据暂时读取失败</div>
          <div style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.75, marginBottom: 20 }}>
            浏览器的本地数据库（IndexedDB）没能打开。数据本身还在，为了避免在读不到数据的状态下继续使用把历史记录覆盖掉，应用先暂停进入。
            <br />可以先重试；仍然不行的话，试试关掉本站的其他标签页、重启浏览器，或确认没有开无痕/隐私模式。
          </div>
          <button
            type="button"
            onClick={() => { setKvHydrateFailed(false); setInitAttempt((n) => n + 1); }}
            style={{ padding: "10px 32px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  return (
    <AccountGate>
      {!splashDismissed ? (
        <SplashScreen ready={hydrated} onEnter={() => setSplashDismissed(true)} />
      ) : (
        <main className="app-root">
          <MusicProvider>
            <DesktopShell
              initialThemeProfile={preparedDesktopTheme?.profile}
              initialThemeAssets={preparedDesktopTheme?.assets}
            />
            <OfflinePushRevampAnnouncement />
            <CloudBackupScheduler />
            <RealityBridgeScheduler />
            <MediaMaintenanceScheduler />
          </MusicProvider>
        </main>
      )}
    </AccountGate>
  );
}
