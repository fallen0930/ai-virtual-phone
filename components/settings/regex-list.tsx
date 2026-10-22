"use strict";

import { useState } from "react";
import type { RegexConfig } from "@/lib/settings-types";

interface RegexListProps {
    data: RegexConfig;
}

export function RegexList({ data }: RegexListProps) {
    const [expandedId, setExpandedId] = useState<string | null>(null);

    if (!data || !data.rules || data.rules.length === 0) {
        return <div className="p-4 text-center" style={{ color: "var(--c-text)" }}>暂无正则脚本</div>;
    }

    return (
        <div className="space-y-3 p-4 pb-20">
            {data.rules.map((script) => (
                <div
                    key={script.id}
                    className="ui-list-card-expandable"
                >
                    <div
                        className="p-4 flex flex-col gap-2 cursor-pointer transition-colors"
                        onClick={() => setExpandedId(expandedId === script.id ? null : script.id)}
                    >
                        <div className="flex justify-between items-start gap-2">
                            <div className="font-medium line-clamp-1 break-all" style={{ color: "var(--c-text)" }}>
                                {script.scriptName || "未命名脚本"}
                            </div>
                            <span className="ui-badge shrink-0" data-variant={script.disabled ? "muted" : "success"}>
                                {script.disabled ? "已禁用" : "启用"}
                            </span>
                        </div>

                        <div className="flex gap-2 ts-12" style={{ color: "var(--c-icon)" }}>
                            <span>Placement: {script.placement.join(", ")}</span>
                        </div>
                    </div>

                    {expandedId === script.id && (
                        <div className="ui-collapsible-body">
                            <div className="mt-3 space-y-3">
                                <div>
                                    <div className="ts-12 mb-1" style={{ color: "var(--c-icon)" }}>Find Regex</div>
                                    <div className="p-2 rounded font-mono ts-12 break-all" style={{ background: "var(--c-card)", border: "1px solid var(--c-panel-border)", color: "var(--c-danger)" }}>
                                        {script.findRegex}
                                    </div>
                                </div>
                                <div>
                                    <div className="ts-12 mb-1" style={{ color: "var(--c-icon)" }}>Replace String</div>
                                    <div className="p-2 rounded font-mono ts-12 break-all whitespace-pre-wrap" style={{ background: "var(--c-card)", border: "1px solid var(--c-panel-border)", color: "var(--c-success)" }}>
                                        {script.replaceString || "(empty)"}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
