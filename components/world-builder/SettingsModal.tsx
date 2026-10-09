"use client";

import { useEffect, useState } from "react";
import { kvGet, kvSet } from "@/lib/kv-db";

export interface SceneSettings {
  shadows: boolean;
  hdri: boolean;
  doubleSide: boolean;
  snap: boolean;
  bloom: boolean;
  /** 角色化身漫步动画（弱机可关；同屏最多 3 个化身活动） */
  avatarMotion?: boolean;
  globalBrightness: number;
  globalWarmth: number;
  theme: string;
}

export const THEMES: { name: string; bg: string; light: boolean }[] = [
  { name: "奶白", bg: "radial-gradient(circle at 50% 50%, #fff 0%, #f5f0eb 50%, #e8e0d8 100%)", light: true },
  { name: "深空", bg: "radial-gradient(circle at 50% 50%, #706560 0%, #4a4540 40%, #353030 100%)", light: false },
];

export function isLightTheme(theme: string): boolean {
  return THEMES.find((t) => t.bg === theme)?.light ?? false;
}

const STORAGE_KEY = "wb-settings";

const DEFAULT_SETTINGS: SceneSettings = {
  // 默认关闭重负载选项（阴影/环境反射），弱机不闪退；想要画质的用户可在偏好设置开。
  // 双面渲染保持开：它不是显存大户，关了反而会让部分模型出现破面/空洞。
  shadows: false,
  hdri: false,
  doubleSide: true,
  snap: false,
  bloom: false,
  avatarMotion: true,
  globalBrightness: 1.0,
  globalWarmth: 0.3,
  theme: THEMES[1].bg,
};

export function useSceneSettings() {
  const [settings, setSettings] = useState<SceneSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const stored = kvGet(STORAGE_KEY);
      if (stored) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
    } catch {}
  }, []);

  function update(changes: Partial<SceneSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...changes };
      kvSet(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { settings, update };
}

interface Props {
  open: boolean;
  settings: SceneSettings;
  onUpdate: (changes: Partial<SceneSettings>) => void;
  onClose: () => void;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="wb-setting-row">
      <span>{label}</span>
      <button
        className={`wb-setting-toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
      >
        <span className="wb-setting-knob" />
      </button>
    </div>
  );
}

export default function SettingsModal({ open, settings, onUpdate, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>偏好设置</span>
          <button className="wb-float-close" onClick={onClose}>✕</button>
        </div>

        <div className="wb-modal-section">
          <label className="wb-modal-label">主题色</label>
          <div className="wb-theme-list">
            {THEMES.map((t) => (
              <button
                key={t.name}
                className={`wb-theme-btn ${settings.theme === t.bg ? "active" : ""}`}
                style={{ background: t.bg }}
                onClick={() => onUpdate({ theme: t.bg })}
                title={t.name}
              />
            ))}
          </div>
        </div>

        <Toggle label="阴影" value={settings.shadows} onChange={(v) => onUpdate({ shadows: v })} />
        <Toggle label="化身走动" value={settings.avatarMotion !== false} onChange={(v) => onUpdate({ avatarMotion: v })} />
        <Toggle label="环境反射" value={settings.hdri} onChange={(v) => onUpdate({ hdri: v })} />
        <Toggle label="双面渲染" value={settings.doubleSide} onChange={(v) => onUpdate({ doubleSide: v })} />
        <Toggle label="物体吸附" value={settings.snap} onChange={(v) => onUpdate({ snap: v })} />
        <Toggle label="光晕效果" value={settings.bloom} onChange={(v) => onUpdate({ bloom: v })} />

        <div className="wb-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span>亮度 {settings.globalBrightness.toFixed(1)}</span>
          <input type="range" className="wb-scale-slider" min={0.3} max={3} step="any"
            value={settings.globalBrightness}
            onChange={(e) => onUpdate({ globalBrightness: parseFloat(e.target.value) })}
          />
        </div>

        <div className="wb-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span>色温 {settings.globalWarmth > 0 ? "暖" : settings.globalWarmth < 0 ? "冷" : "中性"}</span>
          <input type="range" className="wb-scale-slider" min={-1} max={1} step="any"
            value={settings.globalWarmth}
            onChange={(e) => onUpdate({ globalWarmth: parseFloat(e.target.value) })}
          />
        </div>

        <div className="wb-modal-hint" style={{ marginTop: 12 }}>
          关闭选项可提升性能
        </div>
      </div>
    </div>
  );
}
