"use client";

import { useEffect, useState } from "react";
import {
    formatMascotWaitingLabel,
    formatMascotWaitingShortLabel,
    measureWait,
    nowMono,
    nowWall,
} from "@/lib/mascot-waiting-pace";
import type { MascotThinkingProgress } from "@/lib/mascot-chat-store";

type Props = {
    /** store 快照里的本轮进度；null = 没在等，什么都不画 */
    progress: MascotThinkingProgress | null;
    /** 气泡里带省略点动画，紧凑处（小窗标题）用 plain */
    withDots?: boolean;
    /** full = 完整一句（气泡里）；short = 会话列表那一行的矮版 */
    variant?: "full" | "short";
};

/**
 * 卷宝等待时的那句提示。
 * 以前这里只有「思考中」三个字，她 2026-11-03 报「不知道是不是真的在思考调用」——
 * 三个字既没说在第几步、也没说在做什么，更把「手机息屏把页面冻了 52 分钟」
 * 说成像是小卷想了 52 分钟。现在这句话由 lib/mascot-waiting-pace.ts 统一拼，
 * 挂起段（墙上时间 − 单调时间）单独说破。
 */
export function MascotWaitingProgress({ progress, withDots = true, variant = "full" }: Props) {
    const [, setTick] = useState(0);

    // 只在真在等的时候每秒重算；停了就断开，别留个空转的计时器
    useEffect(() => {
        if (!progress) return;
        const timer = setInterval(() => setTick(v => v + 1), 1000);
        // 回到前台的那一刻是最需要刷新的一次：挂起期间计时器根本不跑
        const onVisible = () => setTick(v => v + 1);
        window.addEventListener("focus", onVisible);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", onVisible);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [progress]);

    if (!progress) return null;

    const wait = measureWait(progress, nowWall(), nowMono());
    const format = variant === "short" ? formatMascotWaitingShortLabel : formatMascotWaitingLabel;
    const label = format({
        round: progress.round,
        maxRounds: progress.maxRounds,
        toolName: progress.toolName,
        foregroundMs: wait.foregroundMs,
        paceMs: progress.paceMs,
        suspendedMs: wait.suspendedMs,
    });

    return (
        <span className="mascot-waiting-progress">
            {label}
            {withDots && variant === "full" && (
                <>
                    <span className="mascot-dot" />
                    <span className="mascot-dot" />
                    <span className="mascot-dot" />
                </>
            )}
        </span>
    );
}
