"use client";

import type { ReactNode } from "react";

export function EntryCard({
  active,
  disabled,
  onClick,
  icon,
  children,
  className,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["ui-entry-card"];
  if (className) cls.push(className);
  return (
    <div
      className={cls.join(" ")}
      data-ui="card"
      data-active={active ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {icon && <span className="ui-entry-icon">{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
