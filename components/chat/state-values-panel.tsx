// components/chat/state-values-panel.tsx

import type { StateValue } from "@/lib/chat-storage";

// Muted, warm palette to match the sticky-note / journal aesthetic
const KNOWN_COLORS: Record<string, string> = {
    "好感度": "var(--c-icon-rose)",
    "占有欲": "var(--c-icon-violet)",
    "焦虑值": "var(--c-icon-amber)",
    "信任":   "var(--c-icon-blue)",
    "愤怒":   "var(--c-icon-coral)",
    "嫉妒":   "var(--c-icon-green)",
    "依赖":   "var(--c-icon-lilac)",
    "安全感": "var(--c-icon-teal)",
};

function hashColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = ((hash % 360) + 360) % 360;
    return `hsl(${hue}, 35%, 60%)`;
}

function getColor(name: string): string {
    return KNOWN_COLORS[name] || hashColor(name);
}

type Props = {
    stateValues: StateValue[];
};

export function StateValuesPanel({ stateValues }: Props) {
    if (!stateValues || stateValues.length === 0) return null;

    return (
        <div className="state-panel">
            {stateValues.map((sv) => {
                const color = getColor(sv.name);
                const isHigh = sv.value > 80;
                return (
                    <div key={sv.name} className="flex items-center gap-1.5">
                        <span className="w-12 text-right ts-10 text-[var(--c-text)] font-medium shrink-0 leading-none">
                            {sv.name}
                        </span>
                        <div className="state-bar-track">
                            <div
                                className="state-bar-fill"
                                style={{
                                    width: `${sv.value}%`,
                                    background: `linear-gradient(90deg, color-mix(in srgb, ${color} 40%, transparent), color-mix(in srgb, ${color} 80%, transparent))`,
                                }}
                                {...(isHigh ? { "data-high": "" } : {})}
                            />
                        </div>
                        <span className="w-[22px] text-right ts-10 font-mono text-[var(--c-text)] font-semibold shrink-0 leading-none">
                            {Math.round(sv.value)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
