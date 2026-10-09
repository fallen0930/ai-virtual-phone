"use client";

import type { ReactNode } from "react";

/* ── Badge ── */
export type BadgeVariant = "default" | "success" | "danger" | "warning" | "muted";

export function Badge({
  variant = "default",
  children,
  className,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-badge"];
  if (variant !== "default") cls.push(`ui-badge-${variant}`);
  if (className) cls.push(className);
  return <span className={cls.join(" ")}>{children}</span>;
}

/* ── Tag ── */
export type TagVariant = "default" | "muted";

export function Tag({
  variant = "default",
  children,
  className,
}: {
  variant?: TagVariant;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-tag"];
  if (variant !== "default") cls.push(`ui-tag-${variant}`);
  if (className) cls.push(className);
  return <span className={cls.join(" ")}>{children}</span>;
}

/* ── Status Tag (compact label for entry cards) ── */
export type StatusTagVariant = "default" | "warning" | "action" | "success" | "purple";

export function StatusTag({
  variant = "default",
  children,
  className,
}: {
  variant?: StatusTagVariant;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-status-tag"];
  if (className) cls.push(className);
  return (
    <span className={cls.join(" ")} data-variant={variant !== "default" ? variant : undefined}>
      {children}
    </span>
  );
}

/* ── Icon Badge ── */
export type IconBadgeVariant = "action" | "success" | "warning" | "danger" | "teal";

export function IconBadge({
  variant,
  children,
  className,
}: {
  variant: IconBadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-icon-badge"];
  if (className) cls.push(className);
  return <span className={cls.join(" ")} data-variant={variant}>{children}</span>;
}
