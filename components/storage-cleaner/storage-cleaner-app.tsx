"use client";

import { useEffect, useState, useCallback } from "react";
import {
  HardDrive,
  Trash2,
  RefreshCw,
  Image as ImageIcon,
  Music,
  Mic,
  Film,
  BookOpen,
  Home,
  Palette,
  FileQuestion,
  Sparkles,
  X,
  ChevronRight,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import {
  scanStorageSpace,
  clearStorageCategory,
  type StorageCategoryId,
  type StorageCategoryStat,
} from "@/lib/storage-space";
import { formatBytes } from "@/lib/data-management/backup";
import { ConfirmDialog } from "@/components/ui/modal";

type StorageCleanerProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type ClearOption = {
  keepDays?: number;
  label: string;
  note: string;
};

function getCategoryIcon(id: StorageCategoryId) {
  switch (id) {
    case "chat_images": return ImageIcon;
    case "chat_voice": return Mic;
    case "chat_media_files": return Film;
    case "moments_images": return ImageIcon;
    case "xiaohongshu_images": return ImageIcon;
    case "local_music": return Music;
    case "dwelling_images": return Home;
    case "theme_assets": return Palette;
    case "reading_raw_files": return BookOpen;
    case "orphan_media": return FileQuestion;
  }
}

function getCategoryAccent(id: StorageCategoryId): string {
  switch (id) {
    case "chat_images": return "#4ade80";
    case "chat_voice": return "#f472b6";
    case "chat_media_files": return "#60a5fa";
    case "moments_images": return "#a78bfa";
    case "xiaohongshu_images": return "#f87171";
    case "local_music": return "#fb923c";
    case "dwelling_images": return "#f472b6";
    case "theme_assets": return "#c084fc";
    case "reading_raw_files": return "#fbbf24";
    case "orphan_media": return "#94a3b8";
  }
}

function getClearOptions(stat: StorageCategoryStat): ClearOption[] {
  if (!stat.supportsKeepDays) {
    return [{ keepDays: undefined, label: "全部清理", note: stat.description }];
  }
  return [
    { keepDays: 30, label: "清理 30 天前的", note: "最近 30 天的内容保留" },
    { keepDays: 7, label: "清理 7 天前的", note: "最近 7 天的内容保留" },
    { keepDays: 0, label: "全部清理", note: "该类内容全部删除" },
  ];
}

export function StorageCleanerApp({ onClose, onNotice }: StorageCleanerProps) {
  const [stats, setStats] = useState<StorageCategoryStat[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanDetail, setScanDetail] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<StorageCategoryId | null>(null);
  const [pendingClear, setPendingClear] = useState<StorageCategoryStat | null>(null);
  const [clearOption, setClearOption] = useState<number>(0);
  const [quickCleanRunning, setQuickCleanRunning] = useState(false);

  const totalBytes = stats?.reduce((sum, s) => sum + s.bytes, 0) ?? 0;
  const totalCount = stats?.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const orphanStat = stats?.find((s) => s.id === "orphan_media");

  const runScan = useCallback(async (silent = false) => {
    if (scanning) return;
    setScanning(true);
    if (!silent) setStats(null);
    try {
      const result = await scanStorageSpace((detail) => setScanDetail(detail));
      setStats(result);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setScanning(false);
      setScanDetail(null);
    }
  }, [scanning, onNotice]);

  useEffect(() => {
    void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClear = async (stat: StorageCategoryStat, option: ClearOption) => {
    setClearingId(stat.id);
    setPendingClear(null);
    try {
      const result = await clearStorageCategory(stat.id, { keepDays: option.keepDays });
      onNotice?.(`已清理「${stat.label}」${result.cleared} 项，释放约 ${formatBytes(result.freedBytes)}。`);
      // 清理完刷新
      void runScan(true);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "清理失败");
    } finally {
      setClearingId(null);
    }
  };

  const handleQuickClean = async () => {
    if (quickCleanRunning || !orphanStat || orphanStat.bytes === 0) return;
    setQuickCleanRunning(true);
    try {
      const result = await clearStorageCategory("orphan_media");
      onNotice?.(`一键清理完成：删除残留媒体 ${result.cleared} 项，释放 ${formatBytes(result.freedBytes)}。`);
      void runScan(true);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "清理失败");
    } finally {
      setQuickCleanRunning(false);
    }
  };

  const clearOptions = pendingClear ? getClearOptions(pendingClear) : [];

  return (
    <div className="phone-app storage-cleaner-app" data-ui="phone-app">
      <header className="phone-app-header">
        <button
          type="button"
          className="phone-app-close-btn"
          onClick={onClose}
          aria-label="关闭"
        >
          <X size={20} strokeWidth={2} />
        </button>
        <div className="phone-app-title">
          <HardDrive size={18} strokeWidth={1.8} />
          <span>存储空间</span>
        </div>
        <button
          type="button"
          className="phone-app-action-btn"
          onClick={() => void runScan()}
          disabled={scanning}
          aria-label="刷新"
        >
          <RefreshCw size={18} strokeWidth={1.8} className={scanning ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="storage-cleaner-body">
        {/* 总览卡片 */}
        <div className="storage-overview-card">
          <div className="storage-overview-icon">
            <HardDrive size={28} strokeWidth={1.5} />
          </div>
          <div className="storage-overview-info">
            <div className="storage-overview-size">
              {stats ? formatBytes(totalBytes) : "—"}
            </div>
            <div className="storage-overview-desc">
              {scanning
                ? (scanDetail ?? "扫描中…")
                : stats
                  ? `共 ${totalCount} 项内容`
                  : "点击下方按钮开始扫描"}
            </div>
          </div>
        </div>

        {/* 一键清理残留 */}
        {orphanStat && orphanStat.bytes > 0 && (
          <button
            type="button"
            className="quick-clean-btn"
            onClick={() => void handleQuickClean()}
            disabled={quickCleanRunning || scanning}
          >
            <Sparkles size={18} />
            <span>一键清理残留</span>
            <span className="quick-clean-size">可释放 {formatBytes(orphanStat.bytes)}</span>
            {quickCleanRunning && <Loader2 size={16} className="animate-spin" />}
          </button>
        )}

        {/* 分类列表 */}
        <div className="storage-category-list">
          {stats?.length === 0 && !scanning && (
            <div className="storage-empty">
              <CheckCircle2 size={40} strokeWidth={1.5} />
              <p>存储空间很干净</p>
            </div>
          )}
          {!stats && !scanning && (
            <div className="storage-scan-hint">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                onClick={() => void runScan()}
              >
                <HardDrive size={16} /> 扫描存储空间
              </button>
            </div>
          )}
          {stats?.map((stat) => {
            const Icon = getCategoryIcon(stat.id);
            const accent = getCategoryAccent(stat.id);
            const percent = totalBytes > 0 ? (stat.bytes / totalBytes) * 100 : 0;
            const isClearing = clearingId === stat.id;
            return (
              <div key={stat.id} className="storage-category-item">
                <div className="storage-category-icon" style={{ background: `${accent}20`, color: accent }}>
                  <Icon size={20} strokeWidth={1.8} />
                </div>
                <div className="storage-category-info">
                  <div className="storage-category-top">
                    <span className="storage-category-name">{stat.label}</span>
                    <span className="storage-category-size">{formatBytes(stat.bytes)}</span>
                  </div>
                  <div className="storage-category-bar">
                    <div
                      className="storage-category-bar-fill"
                      style={{ width: `${Math.max(2, percent)}%`, background: accent }}
                    />
                  </div>
                  <div className="storage-category-bottom">
                    <span className="storage-category-count">
                      {stat.count > 0 ? `${stat.count} 项` : "暂无占用"}
                    </span>
                    <span className="storage-category-desc">{stat.description}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="storage-category-clean-btn"
                  onClick={() => {
                    setPendingClear(stat);
                    setClearOption(0);
                  }}
                  disabled={isClearing || (stat.bytes === 0 && stat.count === 0)}
                >
                  {isClearing ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                </button>
              </div>
            );
          })}
        </div>

        {/* 底部提示 */}
        {stats && stats.length > 0 && (
          <div className="storage-footer-tip">
            <p>💡 清理只会删除内容文件，文字记录和设置都会保留</p>
          </div>
        )}
      </div>

      {/* 清理确认弹窗 */}
      {pendingClear && (
        <div
          className="modal-overlay"
          data-ui="modal"
          onClick={() => { if (!clearingId) setPendingClear(null); }}
        >
          <div
            className="modal-dialog storage-clean-modal"
            data-ui="modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header" data-ui="modal-header">
              <h3 className="modal-title">清理 {pendingClear.label}</h3>
            </div>
            <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
              <p className="storage-clear-summary">
                当前占用 <b>{formatBytes(pendingClear.bytes)}</b>
                {pendingClear.count > 0 && `（${pendingClear.count} 项）`}。
              </p>
              <p className="storage-clear-desc">{pendingClear.description}</p>
              <div className="storage-clear-options">
                {clearOptions.map((option, index) => (
                  <button
                    key={index}
                    type="button"
                    className={`storage-clear-option ${clearOption === index ? "is-selected" : ""}`}
                    onClick={() => setClearOption(index)}
                    disabled={Boolean(clearingId)}
                  >
                    <span className="storage-clear-option-label">{option.label}</span>
                    <span className="storage-clear-option-note">{option.note}</span>
                    <ChevronRight size={16} className="storage-clear-option-arrow" />
                  </button>
                ))}
              </div>
            </div>
            <div
              className="modal-footer"
              data-ui="modal-footer"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <button
                type="button"
                className="ui-btn ui-btn-danger"
                style={{ width: "100%" }}
                onClick={() => {
                  const stat = pendingClear;
                  const option = clearOptions[clearOption];
                  if (stat && option) void handleClear(stat, option);
                }}
                disabled={Boolean(clearingId)}
              >
                {clearingId ? (
                  <><Loader2 size={16} className="animate-spin" /> 清理中…</>
                ) : (
                  <><Trash2 size={16} /> 确认清理</>
                )}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                style={{ width: "100%" }}
                onClick={() => setPendingClear(null)}
                disabled={Boolean(clearingId)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
