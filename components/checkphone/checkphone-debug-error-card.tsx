"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type CheckPhoneDebugErrorCardProps = {
  title?: string;
  error: string;
  debugParseMode?: "raw" | "sanitized" | "failed" | null;
  debugParseError?: string | null;
  debugNormalizeError?: string | null;
  debugRawOutput?: string | null;
  debugSanitizedOutput?: string | null;
};

export function CheckPhoneDebugErrorCard({
  title,
  error,
  debugParseError,
  debugNormalizeError,
  debugRawOutput,
  debugSanitizedOutput,
}: CheckPhoneDebugErrorCardProps) {
  const [open, setOpen] = useState(true);
  const [showReason, setShowReason] = useState(false);
  const [copied, setCopied] = useState(false);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  const reasonText = useMemo(() => {
    const rawOutput = debugRawOutput?.trim() || debugSanitizedOutput?.trim() || "";
    const normalizedError = error.replace(/\r\n/g, "\n").trim();
    const detailParts = [debugParseError, debugNormalizeError]
      .map((item) => item?.replace(/\r\n/g, "\n").trim() ?? "")
      .filter((item, index, items) => item && item !== normalizedError && items.indexOf(item) === index);
    const detail = detailParts.join("\n");
    const errorText = detail ? `${normalizedError}\n${detail}` : normalizedError;

    return `错误信息：${errorText}\nAI原始输出：${rawOutput}`;
  }, [debugNormalizeError, debugParseError, debugRawOutput, debugSanitizedOutput, error]);

  useEffect(() => {
    setOpen(true);
    setShowReason(false);
    setCopied(false);
  }, [error, reasonText]);

  useEffect(() => {
    const target =
      markerRef.current?.closest<HTMLElement>('[class*="-module"]') ??
      markerRef.current?.closest<HTMLElement>(".phone-shell") ??
      document.body;
    setPortalTarget(target);
  }, []);

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reasonText);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = reasonText;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copiedFallback = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copiedFallback) throw new Error("copy_failed");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const dialog = open ? (
    <div className="modal-overlay" data-ui="modal" onClick={() => setOpen(false)}>
      <div
        className="modal-dialog cp-sync-error-dialog"
        data-ui="modal-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-header-btn modal-header-btn-muted cp-sync-error-close"
          onClick={() => setOpen(false)}
          aria-label="关闭"
        >
          <X size={17} />
        </button>

        <div className="modal-header cp-sync-error-header" data-ui="modal-header">
          <h3 className="modal-title">{title || "哎呀，抱歉~同步数据失败了呢~"}</h3>
        </div>

        <div className="modal-body cp-sync-error-body" data-ui="modal-body">
          {!showReason ? (
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setShowReason(true)}>
              查看原因
            </button>
          ) : (
            <>
              <div className="cp-sync-error-raw" role="region" aria-label="AI 原始输出">
                <pre>{reasonText}</pre>
              </div>
              <button type="button" className="ui-btn ui-btn-outline cp-sync-error-copy" onClick={handleCopy}>
                {copied ? "已复制" : "复制"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <span ref={markerRef} hidden />
      {portalTarget && dialog ? createPortal(dialog, portalTarget) : null}
    </>
  );
}
