"use client";

import type { ReactNode } from "react";

type ChatPageHeaderProps = {
    title: string;
    left?: ReactNode;
    right?: ReactNode;
    className?: string;
};

export function ChatPageHeader({ title, left, right, className }: ChatPageHeaderProps) {
    const slotPlaceholder = <span aria-hidden style={{ width: 40, height: 40, display: "block" }} />;

    return (
        <header className={`page-header z-10 ${className ?? ""}`.trim()} data-ui="header">
            <div className="page-header-safe-area" />
            <div className="page-header-content">
                {left ?? slotPlaceholder}
                <span className="page-title">{title}</span>
                <span className="page-header-right">{right ?? slotPlaceholder}</span>
            </div>
        </header>
    );
}
