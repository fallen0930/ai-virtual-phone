"use client";

import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

/* ── Button variants ── */
export type ButtonVariant =
  | "primary"
  | "success"
  | "danger"
  | "ghost"
  | "outline"
  | "soft-action"
  | "soft-danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

export function Button({ variant, className, children, ...rest }: ButtonProps) {
  const cls = ["ui-btn"];
  if (variant) cls.push(`ui-btn-${variant}`);
  if (className) cls.push(className);
  return (
    <button type="button" className={cls.join(" ")} {...rest}>
      {children}
    </button>
  );
}

/* ── Link Button (bare text + optional icon) ── */
type LinkButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "muted" | "danger";
  icon?: LucideIcon;
  children: ReactNode;
};

export function LinkButton({ variant = "default", icon: Icon, className, children, ...rest }: LinkButtonProps) {
  const cls = ["ui-link-btn"];
  if (variant !== "default") cls.push(`ui-link-btn-${variant}`);
  if (className) cls.push(className);
  return (
    <button type="button" className={cls.join(" ")} {...rest}>
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

/* ── Icon Button (square, for play/pause etc.) ── */
type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  active?: boolean;
  size?: number;
};

export function IconButton({ icon: Icon, active, className, size = 20, ...rest }: IconButtonProps) {
  const cls = ["ui-icon-btn"];
  if (className) cls.push(className);
  return (
    <button
      type="button"
      className={cls.join(" ")}
      data-active={active ? "true" : undefined}
      {...rest}
    >
      <Icon size={size} />
    </button>
  );
}
