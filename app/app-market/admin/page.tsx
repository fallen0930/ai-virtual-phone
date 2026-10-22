"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, Store, X } from "lucide-react";

import {
  fetchCustomAppMarketAdminItems,
  reviewCustomAppMarketItem,
  type CustomAppMarketAdminView,
} from "@/lib/custom-app-market-client";
import type { CustomAppMarketItem } from "@/lib/custom-app-market-types";

import "./app-market-admin.css";

const ADMIN_KEY_STORAGE = "float_app_market_admin_key";

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(status: CustomAppMarketItem["reviewStatus"]): string {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  return "待审核";
}

export default function AppMarketAdminPage() {
  const [key, setKey] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [view, setView] = useState<CustomAppMarketAdminView>("pending");
  const [items, setItems] = useState<CustomAppMarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (adminKey: string, nextView: CustomAppMarketAdminView) => {
    setLoading(true);
    setError("");
    try {
      const apps = await fetchCustomAppMarketAdminItems({ adminKey, view: nextView });
      setItems(apps);
      setUnlocked(true);
      try { window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      if (!unlocked) setUnlocked(false);
    } finally {
      setLoading(false);
    }
  }, [unlocked]);

  useEffect(() => {
    document.title = "Float · 应用市场审核台";
    try {
      const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE) || "";
      if (saved) {
        setKey(saved);
        void refresh(saved, "pending");
      }
    } catch {
      // ignore storage failures
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchView(nextView: CustomAppMarketAdminView) {
    setView(nextView);
    if (unlocked && key.trim()) await refresh(key.trim(), nextView);
  }

  async function decide(item: CustomAppMarketItem, action: "approve" | "reject") {
    if (busyId) return;
    const message = action === "approve"
      ? `确认通过「${item.name}」并上架到公共市场？`
      : `确认拒绝「${item.name}」？`;
    if (!window.confirm(message)) return;
    setBusyId(item.id);
    setError("");
    try {
      await reviewCustomAppMarketItem({ adminKey: key.trim(), id: item.id, action });
      await refresh(key.trim(), view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="ama-root">
      <div className="ama-shell">
        <header className="ama-header">
          <span className="ama-logo">
            <Store size={24} />
          </span>
          <div>
            <strong>应用市场审核台</strong>
            <p>审核用户提交的自定义 APP</p>
          </div>
        </header>

        {!unlocked ? (
          <section className="ama-panel">
            <label className="ama-field">
              <span>管理密钥</span>
              <input
                type="text"
                value={key}
                onChange={event => setKey(event.target.value)}
                placeholder="APP_MARKET_ADMIN_KEY 或 VERIFY_ADMIN_KEY"
              />
            </label>
            {error ? <div className="ama-error">{error}</div> : null}
            <button type="button" className="ama-primary" disabled={loading || !key.trim()} onClick={() => refresh(key.trim(), view)}>
              {loading ? "验证中..." : "进入审核台"}
            </button>
          </section>
        ) : (
          <section className="ama-panel wide">
            <div className="ama-toolbar">
              <div className="ama-tabs">
                {(["pending", "approved", "rejected", "all"] as CustomAppMarketAdminView[]).map(item => (
                  <button
                    key={item}
                    type="button"
                    className="ama-tab"
                    data-active={view === item}
                    onClick={() => void switchView(item)}
                  >
                    {item === "pending" ? "待审核" : item === "approved" ? "已通过" : item === "rejected" ? "已拒绝" : "全部"}
                  </button>
                ))}
              </div>
              <button type="button" className="ama-refresh" disabled={loading} onClick={() => refresh(key.trim(), view)}>
                <RefreshCw size={17} />
                <span>{loading ? "刷新中" : "刷新"}</span>
              </button>
            </div>

            {error ? <div className="ama-error">{error}</div> : null}

            <div className="ama-list">
              {items.length === 0 && !loading ? (
                <div className="ama-empty">{view === "pending" ? "暂无待审核 APP。" : "暂无记录。"}</div>
              ) : null}
              {items.map(item => (
                <article className="ama-item" key={item.id}>
                  <div className="ama-item-main">
                    <span className="ama-app-icon">
                      {item.iconDataUrl ? <img src={item.iconDataUrl} alt="" /> : <Store size={22} />}
                    </span>
                    <div className="ama-item-copy">
                      <div className="ama-item-title">
                        <strong>{item.name}</strong>
                        <b data-status={item.reviewStatus}>{statusText(item.reviewStatus)}</b>
                      </div>
                      <p>{item.description || "无简介"}</p>
                      <span>
                        {item.authorName} · v{item.version} · {formatSize(item.packageSize)} · {formatTime(item.updatedAt)}
                      </span>
                    </div>
                  </div>

                  {item.permissions.length > 0 ? (
                    <div className="ama-permissions">
                      {item.permissions.map(permission => <em key={permission}>{permission}</em>)}
                    </div>
                  ) : null}

                  {item.reviewStatus === "pending" ? (
                    <div className="ama-actions">
                      <button type="button" className="ama-approve" disabled={busyId === item.id} onClick={() => void decide(item, "approve")}>
                        <Check size={17} />
                        <span>{busyId === item.id ? "处理中" : "通过"}</span>
                      </button>
                      <button type="button" className="ama-reject" disabled={busyId === item.id} onClick={() => void decide(item, "reject")}>
                        <X size={17} />
                        <span>拒绝</span>
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
