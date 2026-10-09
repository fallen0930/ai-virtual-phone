"use client";

import { useMemo, useState, useRef } from "react";
import { ArrowLeft, ChevronDown, ImagePlus, MoreHorizontal } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { DEFAULT_VN_SUMMARY_PROMPT } from "@/lib/vn-engine";
import { DEFAULT_VN_BILINGUAL_PROMPT } from "@/lib/bilingual-prompt-defaults";
import { loadMemoryConfig, saveMemoryConfig } from "@/lib/memory-storage";
import { loadVnConfig, saveVnConfig } from "@/lib/vn-storage";
import { Toggle } from "@/components/ui/form";

interface VnSelectProps {
  onClose: () => void;
  onSelect: (characterId: string) => void;
  vnTheme?: string;
  onThemeChange?: (theme: string) => void;
  onOpenAssets?: () => void;
}

// Per-theme gradient params: [saturation1, lightness1, saturation2, lightness2]
const THEME_GRADIENT: Record<string, [number, number, number, number]> = {
  default: [30, 18, 25, 8],   // 紫夜：深沉
  noir:    [5, 12, 5, 5],     // 黑白：近乎灰阶
  azure:   [35, 20, 30, 10],  // 深蓝：冷调深色
  ivory:   [20, 82, 15, 75],  // 象牙：暖淡彩
  sakura:  [25, 80, 20, 72],  // 樱：粉淡彩
  moss:    [20, 78, 18, 70],  // 青苔：绿淡彩
};

type VnPromptPanel = "summary" | "bilingual";

function hashGradient(id: string, theme: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const h1 = ((hash >>> 0) % 360);
  const h2 = (h1 + 40) % 360;
  const [s1, l1, s2, l2] = THEME_GRADIENT[theme] || THEME_GRADIENT.default;
  return `linear-gradient(180deg, hsl(${h1}, ${s1}%, ${l1}%) 0%, hsl(${h2}, ${s2}%, ${l2}%) 100%)`;
}

export function VnSelect({ onClose, onSelect, vnTheme, onThemeChange, onOpenAssets }: VnSelectProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState("");
  const [expandedPromptPanel, setExpandedPromptPanel] = useState<VnPromptPanel | null>(null);
  const [bilingualTranslationEnabled, setBilingualTranslationEnabled] = useState(() => loadVnConfig("bilingualTranslationEnabled") !== "0");
  const [collapseBilingualTranslation, setCollapseBilingualTranslation] = useState(() => loadVnConfig("collapseBilingualTranslation") !== "0");
  const [bilingualTranslationPrompt, setBilingualTranslationPrompt] = useState(() => loadVnConfig("bilingualTranslationPrompt") || DEFAULT_VN_BILINGUAL_PROMPT);

  const currentTheme = vnTheme || "default";
  const characters = useMemo(() => {
    return loadCharacters().map((c) => ({
      id: c.id,
      name: c.name,
      subtitle: c.personality?.slice(0, 20) || undefined,
      avatar: c.avatar || undefined,
      gradient: hashGradient(c.id, currentTheme),
    }));
  }, [currentTheme]);

  const handleSelect = (id: string) => {
    if (activeId === id) {
      onSelect(id);
    } else {
      setActiveId(id);
    }
  };

  const openSettings = () => {
    setEditingPrompt(loadMemoryConfig().vnSummaryPrompt?.trim() || DEFAULT_VN_SUMMARY_PROMPT);
    setExpandedPromptPanel(null);
    setShowSettings(true);
  };

  const resetCurrentPrompt = () => {
    if (expandedPromptPanel === "bilingual" && bilingualTranslationEnabled) {
      setBilingualTranslationPrompt(DEFAULT_VN_BILINGUAL_PROMPT);
      saveVnConfig("bilingualTranslationPrompt", DEFAULT_VN_BILINGUAL_PROMPT);
      return;
    }
    setEditingPrompt(DEFAULT_VN_SUMMARY_PROMPT);
  };

  const openAssetsPage = () => {
    setShowSettings(false);
    onOpenAssets?.();
  };

  return (
    <div className="vns-shell" data-vn-theme={vnTheme || "default"}>
      <style>{`
        .vns-shell {
          position: absolute;
          inset: 0;
          background: var(--vn-bg, #08060e);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif;
          -webkit-user-select: none;
          user-select: none;
        }

        /* ── Top Bar ── */
        .vns-topbar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10;
          display: flex;
          justify-content: space-between;
          align-items: center;
          height: var(--page-header-content-height, 42px);
          margin-top: var(--page-header-safe-top, 48px);
          padding: 1px 20px;
        }
        .vns-back {
          width: 36px;
          height: 36px;
          border: none;
          background: transparent;
          color: var(--vn-control-color);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        .vns-back:active {
          transform: scale(0.9);
          color: var(--vn-ui-text-bright);
        }
        .vns-title {
          font-size: calc(15px*var(--app-text-scale,1));
          font-weight: 500;
          letter-spacing: 0.12em;
          color: var(--vn-ui-text);
          font-weight: 400;
        }
        .vns-spacer { width: 40px; }

        /* ── Character Strip Container ── */
        .vns-strips {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: safe center;
          gap: 4px;
          padding: 80px 16px calc(env(safe-area-inset-bottom, 0px) + 20px);
          overflow-x: auto;
          overflow-y: hidden;
          scroll-snap-type: x proximity;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .vns-strips::-webkit-scrollbar { display: none; }

        /* ── Character Strip ── */
        .vns-strip {
          flex: 0 0 auto;
          width: 72px;
          height: 55%;
          border-radius: 0;
          overflow: hidden;
          position: relative;
          cursor: pointer;
          transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), height 0.4s ease, opacity 0.3s;
          scroll-snap-align: center;
          border: 1px solid var(--vn-ui-border);
        }
        .vns-strip:nth-child(odd) {
          margin-top: -8%;
        }
        .vns-strip:nth-child(even) {
          margin-top: 8%;
        }
        .vns-strip:nth-child(3n) {
          margin-top: -4%;
        }
        .vns-strip[data-active="true"] {
          width: min(220px, 50vw);
          height: 62%;
          border-color: var(--vn-ui-accent-dim);
          box-shadow: 0 0 20px var(--vn-ui-accent-bg);
        }
        .vns-strip-bg {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center;
          transition: transform 0.4s ease, filter 0.4s ease;
        }
        .vns-strip:not([data-active="true"]) .vns-strip-bg {
          filter: var(--vns-strip-filter, brightness(0.4) saturate(0.6));
        }
        .vns-strip[data-active="true"] .vns-strip-bg {
          filter: var(--vns-strip-filter-active, brightness(0.7) saturate(0.9));
        }

        /* ── Strip overlay gradient ── */
        .vns-strip::after {
          content: "";
          position: absolute;
          inset: 0;
          background: var(--vns-strip-overlay, linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.8) 100%));
          pointer-events: none;
          z-index: 1;
        }

        /* ── Character info ── */
        .vns-strip-info {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          z-index: 2;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          transition: opacity 0.3s;
        }
        .vns-strip:not([data-active="true"]) .vns-strip-info {
          writing-mode: vertical-rl;
          text-orientation: mixed;
          bottom: auto;
          top: 50%;
          left: 50%;
          right: auto;
          transform: translate(-50%, -50%);
          padding: 0;
          align-items: center;
        }
        .vns-strip-name {
          font-size: calc(16px*var(--app-text-scale,1));
          font-weight: 600;
          color: rgba(255,255,255,0.9);
          letter-spacing: 0.1em;
          transition: font-size 0.3s;
        }
        .vns-strip:not([data-active="true"]) .vns-strip-name {
          font-size: calc(14px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.6);
        }
        .vns-strip-sub {
          font-size: calc(11px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.45);
          letter-spacing: 0.08em;
        }
        .vns-strip:not([data-active="true"]) .vns-strip-sub {
          display: none;
        }

        /* ── Enter button (shown on active strip) ── */
        .vns-enter {
          position: absolute;
          bottom: 60px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 3;
          padding: 8px 28px;
          border: 1px solid var(--vn-ui-accent-dim);
          border-radius: 24px;
          background: var(--vn-ui-accent-bg);
          color: var(--vn-ui-text-bright);
          font-size: calc(13px*var(--app-text-scale,1));
          letter-spacing: 0.15em;
          cursor: pointer;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          transition: all 0.25s;
          white-space: nowrap;
          font-family: inherit;
          animation: vns-pulse 2s ease-in-out infinite;
        }
        .vns-enter:active {
          transform: translateX(-50%) scale(0.95);
          background: var(--vn-ui-accent-dim);
        }
        @keyframes vns-pulse {
          0%, 100% { box-shadow: 0 0 12px rgba(255,255,255,0.05); }
          50% { box-shadow: 0 0 20px rgba(255,255,255,0.12); }
        }

        /* ── Ambient particles ── */
        .vns-shell::before {
          content: "";
          position: absolute;
          top: -10%;
          left: -10%;
          width: 50%;
          height: 40%;
          background: radial-gradient(circle, rgba(100,80,160,0.08) 0%, transparent 70%);
          pointer-events: none;
          z-index: 0;
        }
        .vns-shell::after {
          content: "";
          position: absolute;
          bottom: -10%;
          right: -10%;
          width: 60%;
          height: 50%;
          background: radial-gradient(circle, rgba(60,80,160,0.06) 0%, transparent 70%);
          pointer-events: none;
          z-index: 0;
        }

        /* ── Empty state ── */
        .vns-empty {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--vn-ui-text-dim);
          font-size: calc(14px*var(--app-text-scale,1));
          letter-spacing: 0.1em;
        }

        /* ── Settings prompt accordions ── */
        .vns-prompt-stack {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .vns-prompt-card {
          border-radius: 10px;
          border: 1px solid var(--vn-ui-border);
          background: rgba(255,255,255,0.025);
          overflow: hidden;
        }
        .vns-prompt-card[data-open="true"] {
          border-color: var(--vn-ui-accent-dim);
          background: var(--vn-ui-accent-bg);
        }
        .vns-prompt-toggle {
          width: 100%;
          min-height: 44px;
          padding: 0 12px;
          border: none;
          background: transparent;
          color: var(--vn-ui-text);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          cursor: pointer;
          font-family: inherit;
        }
        .vns-prompt-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: calc(12px*var(--app-text-scale,1));
          font-weight: 600;
          letter-spacing: 0.04em;
        }
        .vns-prompt-chevron {
          flex-shrink: 0;
          color: var(--vn-ui-text-dim);
          transition: transform 180ms ease, color 180ms ease;
        }
        .vns-prompt-card[data-open="true"] .vns-prompt-toggle {
          color: var(--vn-ui-text-bright);
        }
        .vns-prompt-card[data-open="true"] .vns-prompt-chevron {
          color: var(--vn-ui-accent);
          transform: rotate(180deg);
        }
        .vns-prompt-body {
          padding: 0 10px 10px;
        }
        .vns-prompt-helper {
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(255,255,255,0.03);
          color: var(--vn-ui-text-dim);
          font-size: calc(10px*var(--app-text-scale,1));
          line-height: 1.6;
          margin-bottom: 8px;
        }
        .vns-settings-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-top: 10px;
          width: 100%;
        }
        .vns-settings-action {
          width: 100%;
          min-height: 36px;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: calc(12px*var(--app-text-scale,1));
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
          box-sizing: border-box;
        }
        .vns-settings-action-secondary {
          border: 1px solid var(--vn-ui-border);
          background: rgba(255,255,255,0.025);
          color: var(--vn-ui-text);
        }
        .vns-settings-action-primary {
          border: 1px solid var(--vn-ui-accent);
          background: var(--vn-ui-accent);
          color: #fff;
        }
        .vns-asset-entry {
          padding: 12px;
          border-radius: 10px;
          border: 1px solid var(--vn-ui-border);
          background: rgba(255,255,255,0.025);
          margin-bottom: 16px;
        }
        .vns-asset-entry-title {
          font-size: calc(14px*var(--app-text-scale,1));
          font-weight: 500;
          color: var(--vn-ui-text);
          letter-spacing: 0.05em;
          margin-bottom: 8px;
        }
        .vns-asset-entry-desc {
          font-size: calc(11px*var(--app-text-scale,1));
          color: var(--vn-ui-text-dim);
          line-height: 1.55;
          margin-bottom: 10px;
        }
        .vns-asset-entry-btn {
          width: 100%;
          min-height: 40px;
          border-radius: 8px;
          border: 1px solid var(--vn-ui-accent-dim);
          background: var(--vn-ui-accent-bg);
          color: var(--vn-ui-text-bright);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: calc(12px*var(--app-text-scale,1));
          font-family: inherit;
          font-weight: 500;
          cursor: pointer;
        }
      `}</style>

      {/* ── Top Bar ── */}
      <div className="vns-topbar">
        <button className="vns-back" onClick={onClose}>
          <ArrowLeft size={20} />
        </button>
        <div style={{ textAlign: "center" }}>
          <div className="vns-title">选择角色</div>
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--vn-ui-text-dim)", letterSpacing: "0.2em", textTransform: "uppercase" as const, marginTop: 2 }}>Select Character</div>
        </div>
        <div style={{ width: 40, display: "flex", justifyContent: "flex-end" }}>
          <button className="vns-back" onClick={openSettings} title="设置" aria-label="设置">
            <MoreHorizontal size={22} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      {/* ── Character Strips ── */}
      {characters.length === 0 ? (
        <div className="vns-empty">请先创建角色</div>
      ) : (
        <div className="vns-strips" ref={scrollRef}>
          {characters.map((char) => (
            <div
              key={char.id}
              className="vns-strip"
              data-active={activeId === char.id ? "true" : undefined}
              onClick={() => handleSelect(char.id)}
            >
              <div
                className="vns-strip-bg"
                style={{
                  background: char.avatar ? `url(${char.avatar}) center/cover` : char.gradient,
                }}
              />
              <div className="vns-strip-info">
                <span className="vns-strip-name">{char.name}</span>
                <span className="vns-strip-sub">{char.subtitle}</span>
              </div>
              {activeId === char.id && (
                <button className="vns-enter" onClick={(e) => { e.stopPropagation(); onSelect(char.id); }}>
                  开始
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowSettings(false)}>
          <div style={{ width: "100%", maxWidth: 320, maxHeight: "80vh", overflow: "auto", padding: 16, background: "var(--vn-ui-panel)", border: "1px solid var(--vn-ui-border)", borderRadius: 12 }} onClick={(e) => e.stopPropagation()}>

            <div className="vns-asset-entry">
              <div className="vns-asset-entry-title">立绘与场景</div>
              <div className="vns-asset-entry-desc">管理漫卷中可调用的角色立绘、场景图和显示位置。</div>
              <button type="button" className="vns-asset-entry-btn" onClick={openAssetsPage}>
                <ImagePlus size={15} strokeWidth={1.8} />
                传送到漫卷资源
              </button>
            </div>

            {/* ── 主题 ── */}
            <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, color: "var(--vn-ui-text)", marginBottom: 10, letterSpacing: "0.05em" }}>主题</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
              {([
                { id: "default", color: "#8878b0", name: "紫夜" },
                { id: "noir", color: "#606060", name: "黑白" },
                { id: "azure", color: "#6888b8", name: "深蓝" },
                { id: "ivory", color: "#c8b898", name: "象牙" },
                { id: "sakura", color: "#c89aaa", name: "樱" },
                { id: "moss", color: "#7aa878", name: "青苔" },
              ] as const).map(t => (
                <button
                  key={t.id}
                  onClick={() => onThemeChange?.(t.id)}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer" }}
                >
                  <div style={{
                    width: 30, height: 30, borderRadius: "50%",
                    background: t.color,
                    border: (vnTheme || "default") === t.id ? "2.5px solid var(--vn-ui-text-bright)" : "2.5px solid transparent",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                    transition: "all 0.2s",
                  }} />
                  <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--vn-ui-text-dim)" }}>{t.name}</span>
                </button>
              ))}
            </div>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--vn-ui-border)" }}>
              <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, color: "var(--vn-ui-text)", marginBottom: 8, letterSpacing: "0.05em" }}>双语翻译</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--vn-ui-text)" }}>对白双语翻译</div>
                  <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--vn-ui-text-dim)", lineHeight: 1.5 }}>外语对白自动附中文译文，旁白不翻译</div>
                </div>
                <Toggle checked={bilingualTranslationEnabled} onChange={(checked) => {
                  setBilingualTranslationEnabled(checked);
                  saveVnConfig("bilingualTranslationEnabled", checked ? "1" : "0");
                }} />
              </div>
              {bilingualTranslationEnabled && (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--vn-ui-text)" }}>折叠中文译文</div>
                      <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--vn-ui-text-dim)", lineHeight: 1.5 }}>关闭后默认直接展开中文</div>
                    </div>
                    <Toggle checked={collapseBilingualTranslation} onChange={(checked) => {
                      setCollapseBilingualTranslation(checked);
                      saveVnConfig("collapseBilingualTranslation", checked ? "1" : "0");
                    }} />
                  </div>
                </>
              )}
            </div>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--vn-ui-border)" }}>
              <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, color: "var(--vn-ui-text)", marginBottom: 8, letterSpacing: "0.05em" }}>提示词</div>
              <div className="vns-prompt-stack">
                <div className="vns-prompt-card" data-open={expandedPromptPanel === "summary" ? "true" : undefined}>
                  <button
                    type="button"
                    className="vns-prompt-toggle"
                    aria-expanded={expandedPromptPanel === "summary"}
                    onClick={() => setExpandedPromptPanel(prev => prev === "summary" ? null : "summary")}
                  >
                    <span className="vns-prompt-title">归档总结提示词</span>
                    <ChevronDown className="vns-prompt-chevron" size={15} strokeWidth={2} />
                  </button>
                  {expandedPromptPanel === "summary" && (
                    <div className="vns-prompt-body">
                      <div className="vns-prompt-helper">
                        漫卷章节归档时使用。可用变量：{"{{char}}"} 角色名、{"{{user}}"} 用户名。
                      </div>
                      <textarea
                        style={{
                          width: "100%", minHeight: 120, padding: 10, borderRadius: 6,
                          border: "1px solid var(--vn-ui-border)",
                          background: "var(--vn-ui-input)",
                          color: "var(--vn-ui-input-text)",
                          fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.6,
                          resize: "vertical", outline: "none", boxSizing: "border-box",
                        }}
                        value={editingPrompt}
                        onChange={(e) => setEditingPrompt(e.target.value)}
                      />
                    </div>
                  )}
                </div>

                {bilingualTranslationEnabled && (
                  <div className="vns-prompt-card" data-open={expandedPromptPanel === "bilingual" ? "true" : undefined}>
                    <button
                      type="button"
                      className="vns-prompt-toggle"
                      aria-expanded={expandedPromptPanel === "bilingual"}
                      onClick={() => setExpandedPromptPanel(prev => prev === "bilingual" ? null : "bilingual")}
                    >
                      <span className="vns-prompt-title">双语提示词</span>
                      <ChevronDown className="vns-prompt-chevron" size={15} strokeWidth={2} />
                    </button>
                    {expandedPromptPanel === "bilingual" && (
                      <div className="vns-prompt-body">
                        <div className="vns-prompt-helper">
                          对白需要双语翻译时使用，只影响对白译文，不影响旁白。
                        </div>
                        <textarea
                          rows={7}
                          style={{
                            width: "100%", minHeight: 112, padding: 10, borderRadius: 6,
                            border: "1px solid var(--vn-ui-border)",
                            background: "var(--vn-ui-input)",
                            color: "var(--vn-ui-input-text)",
                            fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: 1.5,
                            resize: "vertical", outline: "none", boxSizing: "border-box",
                          }}
                          value={bilingualTranslationPrompt}
                          onChange={(e) => {
                            setBilingualTranslationPrompt(e.target.value);
                            saveVnConfig("bilingualTranslationPrompt", e.target.value);
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="vns-settings-actions">
              <button
                type="button"
                className="vns-settings-action vns-settings-action-secondary"
                onClick={resetCurrentPrompt}
              >
                恢复默认提示词
              </button>
              <button type="button" className="vns-settings-action vns-settings-action-primary" onClick={() => {
                const config = loadMemoryConfig();
                saveMemoryConfig({ ...config, vnSummaryPrompt: editingPrompt.trim() });
                saveVnConfig("bilingualTranslationPrompt", bilingualTranslationPrompt.trim());
                setShowSettings(false);
              }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
