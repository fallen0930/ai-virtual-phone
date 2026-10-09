"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/* ── Glass Card ── */
export type GlassCardVariant = "default" | "section" | "dropdown";

const glassCardClass: Record<GlassCardVariant, string> = {
  default: "g-card",
  section: "g-section",
  dropdown: "g-dropdown",
};

export function GlassCard({
  variant = "default",
  children,
  className,
  style,
  onClick,
  active,
  disabled,
}: {
  variant?: GlassCardVariant;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={`${glassCardClass[variant]} ${className ?? ""}`}
      data-ui="card"
      data-active={active ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  );
}

/* ── Empty State ── */
export function EmptyState({
  icon: Icon,
  message,
  action,
}: {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      {Icon && <Icon size={40} strokeWidth={1} />}
      <p>{message}</p>
      {action}
    </div>
  );
}

/* ── Avatar ── */
export function Avatar({
  src,
  name,
  size = "md",
}: {
  src?: string;
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizeMap = { sm: 28, md: 40, lg: 56 };
  const px = sizeMap[size];
  return (
    <div
      className="ui-avatar"
      style={{ width: px, height: px, fontSize: px * 0.4 }}
    >
      {src ? (
        <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
      ) : (
        <span>{name.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}
