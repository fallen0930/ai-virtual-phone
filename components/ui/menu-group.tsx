"use client";

import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

/* ── Menu item definition ── */
export type MenuItem = {
  icon?: LucideIcon;
  iconColor?: string;
  label: string;
  desc?: string;
  right?: ReactNode;
  onClick?: () => void;
};

/* ── Menu group (list of items with optional description) ── */
export function MenuGroup({ items, desc }: { items: MenuItem[]; desc?: string }) {
  return (
    <div className="menu-group" data-ui="menu">
      {items.map((item, i) => (
        <button
          key={i}
          className="menu-item"
          type="button"
          onClick={item.onClick}
          disabled={!item.onClick}
        >
          {item.icon && (
            <span className="menu-icon" style={item.iconColor ? { color: item.iconColor } : undefined}>
              <item.icon size={20} strokeWidth={1.5} />
            </span>
          )}
          <div className="menu-label-group">
            <span className="menu-label">{item.label}</span>
            {item.desc && <span className="menu-desc">{item.desc}</span>}
          </div>
          <span className="menu-right">
            {item.right ?? (item.onClick ? <ChevronRight size={16} /> : null)}
          </span>
        </button>
      ))}
      {desc && <p className="menu-group-desc">{desc}</p>}
    </div>
  );
}

/* ── Toggle row ── */
export function MenuToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="menu-group">
      <div className="menu-item">
        <div className="menu-label-group">
          <span className="menu-label">{label}</span>
          {desc && <span className="menu-desc">{desc}</span>}
        </div>
        <button
          className="ui-toggle"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          data-checked={checked ? "" : undefined}
        >
          <span className="ui-toggle-knob" />
        </button>
      </div>
    </div>
  );
}
