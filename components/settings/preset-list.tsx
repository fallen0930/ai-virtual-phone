"use strict";

import { useState } from "react";
import type { PresetConfig } from "@/lib/settings-types";

interface PresetListProps {
    data: PresetConfig;
}

export function PresetList({ data }: PresetListProps) {
    const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);

    if (!data) return (
        <div className="ui-empty">
            <span className="menu-desc">暂无预设配置</span>
        </div>
    );

    return (
        <div className="flex flex-col gap-6 p-4 pb-20">
            {/* Global Settings Card */}
            <div className="ui-list-card" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <p className="card-section-label m-0">生成参数</p>
                <div className="grid grid-cols-2 gap-4">
                    <SettingItem label="Temperature" value={data.temperature} />
                    <SettingItem label="Top P" value={data.top_p} />
                    <SettingItem label="Top K" value={data.top_k} />
                    <SettingItem label="Frequency Penalty" value={data.frequency_penalty} />
                    <SettingItem label="Presence Penalty" value={data.presence_penalty} />
                    <SettingItem label="Repetition Penalty" value={data.repetition_penalty} />
                    <SettingItem label="Max Tokens" value={data.openai_max_tokens} />
                    <SettingItem label="Context Window" value={data.openai_max_context} />
                </div>
            </div>

            {/* Prompts List */}
            <div className="flex flex-col gap-3">
                <p className="card-section-label m-0 mx-1">提示词 (Prompts)</p>
                {data.prompts.map((prompt) => (
                    <div key={prompt.identifier} className="ui-list-card-expandable">
                        <div
                            className="p-4 flex flex-col gap-2 cursor-pointer"
                            onClick={() => setExpandedPromptId(
                                expandedPromptId === prompt.identifier ? null : prompt.identifier
                            )}
                        >
                            <div className="flex justify-between items-center">
                                <span className="menu-label font-medium">{prompt.name}</span>
                                <span className="ui-badge" data-variant={prompt.enabled ? "success" : "muted"}>
                                    {prompt.enabled ? "启用" : "禁用"}
                                </span>
                            </div>
                            <div className="menu-desc flex gap-3">
                                <span>Role: {prompt.role}</span>
                                <span>Depth: {prompt.injection_depth}</span>
                            </div>
                        </div>

                        {expandedPromptId === prompt.identifier && (
                            <div className="ui-collapsible-body">
                                <div className="mt-3">
                                    <pre className="ui-code-block max-h-60 m-0">
                                        {prompt.content}
                                    </pre>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function SettingItem({ label, value }: { label: string; value: string | number | boolean }) {
    return (
        <div className="flex flex-col">
            <span className="menu-desc !mt-0">{label}</span>
            <span className="menu-label font-mono">{String(value)}</span>
        </div>
    );
}
