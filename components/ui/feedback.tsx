"use client";

import type { ReactNode } from "react";

/* ── Alert ── */
export type AlertVariant = "default" | "success" | "danger" | "warning" | "info";

export function Alert({
  variant = "default",
  children,
  className,
}: {
  variant?: AlertVariant;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-alert"];
  if (className) cls.push(className);
  return (
    <div className={cls.join(" ")} data-variant={variant !== "default" ? variant : undefined}>
      {children}
    </div>
  );
}

/* ── Progress Bar ── */
export function ProgressBar({
  value,
  max = 100,
  className,
  color,
}: {
  value: number;
  max?: number;
  className?: string;
  color?: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={`ui-progress-track ${className ?? ""}`} data-ui="progress">
      <div
        className="ui-progress-fill"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}
