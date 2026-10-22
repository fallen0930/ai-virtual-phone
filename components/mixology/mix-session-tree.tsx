"use client";

// 独家特调 · 世界树面板
// 只展示「当前对局」内部的支线分岔：以当前对局的 rootId（没有则用自身 id）为根，
// 沿 parent→children 收集整棵子树后自动布局，画成可拖拽的节点树。
// 每个节点是一场可独立续玩的对局：显示支线名 / 第几轮 / 最新进度小总结 / 备注，
// 点节点跳过去续玩，可改名改备注、可从此节点快速分叉、可删除（子支线上提一级）。
//
// 悬浮按钮（🌳）开合面板；面板里也提供"从当前进度开新支线"。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { GitBranch, Network, Pencil, Plus, Trash2, X } from "lucide-react";
import {
    subscribeMixSessionRuntime,
    getMixSessionRuntimeState,
    type MixGenStatus,
} from "@/lib/mixology/session-runtime";
import {
    loadMixSessions,
    buildMixSessionForest,
    updateMixSessionTreeMeta,
    deleteMixSessionBranch,
    type MixSessionTreeNode,
} from "@/lib/mixology/storage";
import { forkMixSession, mixRoundCount } from "@/lib/mixology/engine";
import { mixSessionLatestSummary, mixSessionTitle, type MixSession } from "@/lib/mixology/types";
import {
    isDockManaged,
    CONTROL_DOCK_ACTIVATE_EVENT,
} from "@/lib/floating-controls-store";

const NODE_W = 188;
const NODE_H = 112;
const X_GAP = 224;
const Y_GAP = 156;
const PAD_X = 40;
const PAD_Y = 36;

type Pos = { x: number; y: number };

/** 给森林算一套初始坐标：叶子按出现顺序占 x，父节点取子节点 x 中点；y 按层级。 */
function computeForestLayout(roots: MixSessionTreeNode[]): Map<string, Pos> {
    const xByLeaf = new Map<string, number>();
    let cursor = 0;
    const assignX = (node: MixSessionTreeNode): number => {
        if (node.children.length === 0) {
            const x = cursor;
            cursor += 1;
            xByLeaf.set(node.session.id, x);
            return x;
        }
        const xs = node.children.map(assignX);
        const x = (Math.min(...xs) + Math.max(...xs)) / 2;
        xByLeaf.set(node.session.id, x);
        return x;
    };
    roots.forEach(assignX);

    const pos = new Map<string, Pos>();
    const assignY = (node: MixSessionTreeNode, depth: number) => {
        const x = (xByLeaf.get(node.session.id) ?? 0) * X_GAP + PAD_X;
        const y = depth * Y_GAP + PAD_Y;
        pos.set(node.session.id, { x, y });
        node.children.forEach((c) => assignY(c, depth + 1));
    };
    roots.forEach((r) => assignY(r, 0));
    return pos;
}

/** 把所有节点（含子节点）按 parentId 关系拍平成 id→session 表 */
function indexById(sessions: MixSession[]): Map<string, MixSession> {
    const m = new Map<string, MixSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
}

/**
 * 只取「当前对局」这棵子树：从 rootId（没有则用自身 id）出发，沿 parent→children
 * 收集整棵子树。这样世界树只反映当前这一局内部的支线分岔，不混入其它对局。
 */
function collectSubtree(all: MixSession[], rootId: string): MixSession[] {
    const byId = new Map(all.map((s) => [s.id, s] as const));
    const childrenOf = new Map<string, string[]>();
    for (const s of all) {
        if (s.parentId) {
            if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
            childrenOf.get(s.parentId)!.push(s.id);
        }
    }
    const out: MixSession[] = [];
    const visit = (id: string) => {
        const s = byId.get(id);
        if (!s) return;
        out.push(s);
        for (const c of childrenOf.get(id) ?? []) visit(c);
    };
    visit(rootId);
    return out;
}

function statusColor(status: MixGenStatus | null): string {
    switch (status) {
        case "generating": return "#8d7bf5";
        case "queued": return "#d9b06a";
        case "error": return "#e08080";
        default: return "rgba(242, 240, 247, 0.25)";
    }
}

type Props = {
    sessionId: string;
    onSwitch: (id: string) => void;
    onToast?: (msg: string) => void;
};

export function MixSessionTree({ sessionId, onSwitch, onToast }: Props) {
    const [open, setOpen] = useState(false);
    const [sessions, setSessions] = useState<MixSession[]>([]);
    const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
    const [dragId, setDragId] = useState<string | null>(null);
    const [edit, setEdit] = useState<{ id: string; name: string; note: string } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
    const layerRef = useRef<HTMLDivElement | null>(null);

    const runtimeState = useSyncExternalStore(
        subscribeMixSessionRuntime,
        getMixSessionRuntimeState,
        getMixSessionRuntimeState,
    );
    // 已由统一控制坞接管：自身悬浮按钮收起，入口是坞按钮（常驻）或坞底「更多」列表项
    const managedMixTree = isDockManaged("mix-tree");

    // 受统一控制坞驱动：坞里点「世界树」时切换本面板开合
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== "mix-tree") return;
            setOpen(prev => !prev);
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, []);

    const reload = useCallback(() => {
        const list = loadMixSessions();
        // 只取当前对局所在的子树（rootId 或自身 id 为根），不混入其它对局
        const current = list.find((s) => s.id === sessionId);
        const rootValue = current?.rootId ?? current?.id ?? sessionId;
        const scoped = collectSubtree(list, rootValue);
        setSessions(scoped);
        const roots = buildMixSessionForest(scoped);
        const layout = computeForestLayout(roots);
        const next = new Map<string, Pos>();
        for (const s of scoped) {
            if (typeof s.treeX === "number" && typeof s.treeY === "number") {
                next.set(s.id, { x: s.treeX, y: s.treeY });
            } else {
                const p = layout.get(s.id);
                if (p) next.set(s.id, p);
            }
        }
        setPositions(next);
    }, [sessionId]);

    useEffect(() => {
        if (open) reload();
    }, [open, reload]);

    const roots = useMemo(() => buildMixSessionForest(sessions), [sessions]);
    const byId = useMemo(() => indexById(sessions), [sessions]);

    // 画布尺寸：包住所有节点
    const bounds = useMemo(() => {
        let maxX = 0;
        let maxY = 0;
        positions.forEach((p) => {
            maxX = Math.max(maxX, p.x + NODE_W);
            maxY = Math.max(maxY, p.y + NODE_H);
        });
        return { w: Math.max(maxX + PAD_X, 600), h: Math.max(maxY + PAD_Y, 400) };
    }, [positions]);

    const handleSwitch = useCallback((id: string) => {
        onSwitch(id);
        setOpen(false);
    }, [onSwitch]);

    // ── 拖拽 ──
    const onNodePointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
        // 点按钮不算拖拽
        if ((e.target as HTMLElement).closest(".mix-tree-op")) return;
        const pos = positions.get(id);
        if (!pos) return;
        const rect = layerRef.current?.getBoundingClientRect();
        const originX = rect ? e.clientX - rect.left : e.clientX;
        const originY = rect ? e.clientY - rect.top : e.clientY;
        dragRef.current = { id, dx: originX - pos.x, dy: originY - pos.y, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onNodePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const rect = layerRef.current?.getBoundingClientRect();
        const cx = rect ? e.clientX - rect.left : e.clientX;
        const cy = rect ? e.clientY - rect.top : e.clientY;
        const nx = Math.max(0, cx - d.dx);
        const ny = Math.max(0, cy - d.dy);
        const cur = positions.get(d.id);
        const curX = cur ? cur.x : 0;
        const curY = cur ? cur.y : 0;
        if (!d.moved && (Math.abs(nx - curX) > 3 || Math.abs(ny - curY) > 3)) {
            d.moved = true;
            setDragId(d.id);
        }
        if (d.moved) {
            setPositions((prev) => {
                const next = new Map(prev);
                next.set(d.id, { x: nx, y: ny });
                return next;
            });
        }
    };
    const onNodePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        if (d.moved) {
            const p = positions.get(d.id);
            if (p) updateMixSessionTreeMeta(d.id, { treeX: Math.round(p.x), treeY: Math.round(p.y) });
            setDragId(null);
        }
        dragRef.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    };

    const quickFork = (node: MixSession) => {
        try {
            const child = forkMixSession(node.id, node.turns.length - 1, {
                branchName: node.branchName ? `${node.branchName} · 分支` : undefined,
            });
            onToast?.(`已开新支线「${mixSessionTitle(child)}」。当前对局不变，可在 🌳 世界树里点开继续玩。`);
            reload();
        } catch (err) {
            onToast?.(err instanceof Error ? err.message : "分叉失败");
        }
    };

    const doDelete = (id: string) => {
        deleteMixSessionBranch(id);
        setConfirmDelete(null);
        reload();
        onToast?.("已删除该支线，子支线上提一级。");
    };

    if (!open) {
        if (managedMixTree) return null;
        return (
            <button
                type="button"
                className="mix-tree-fab"
                aria-label="世界树"
                title="世界树 · 支线谱系"
                onClick={() => setOpen(true)}
            >
                <Network size={22} strokeWidth={1.8} />
            </button>
        );
    }

    return (
        <div className="mix-session-tree-layer" ref={layerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 90 } as CSSProperties}>
            <div className="mix-tree-panel" style={{ pointerEvents: "auto" } as CSSProperties}>
                <div className="mix-tree-head">
                    <div className="mix-tree-title">世界树</div>
                    <div className="mix-tree-sub">仅当前这一局的支线分岔 · 点节点续玩 · 拖拽排版</div>
                    <button type="button" className="mix-tree-op" style={{ flex: "none", padding: "6px 12px" } as CSSProperties} onClick={() => { const cur = sessions.find((s) => s.id === sessionId); if (cur) quickFork(cur); }}>
                        <Plus size={13} /> 当前开新支线
                    </button>
                    <button type="button" className="mix-modal-x" onClick={() => setOpen(false)} aria-label="关闭"><X size={18} /></button>
                </div>

                {sessions.length === 0 ? (
                    <div className="mix-tree-empty">还没有对局。</div>
                ) : (
                    <div className="mix-tree-canvas">
                        <svg className="mix-tree-svg" width={bounds.w} height={bounds.h}>
                            {sessions.map((s) => {
                                if (!s.parentId) return null;
                                const p = positions.get(s.id);
                                const par = positions.get(s.parentId);
                                if (!p || !par) return null;
                                const x1 = par.x + NODE_W / 2;
                                const y1 = par.y + NODE_H;
                                const x2 = p.x + NODE_W / 2;
                                const y2 = p.y;
                                return (
                                    <path
                                        key={`e-${s.id}`}
                                        d={`M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
                                        fill="none"
                                        stroke="rgba(255,255,255,0.14)"
                                        strokeWidth={1.5}
                                    />
                                );
                            })}
                        </svg>

                        {sessions.map((s) => {
                            const pos = positions.get(s.id);
                            if (!pos) return null;
                            const status = runtimeState.running[s.id]?.status ?? null;
                            const isCurrent = s.id === sessionId;
                            const isRoot = !s.parentId;
                            const summary = mixSessionLatestSummary(s);
                            return (
                                <div
                                    key={s.id}
                                    className="mix-tree-node"
                                    data-current={isCurrent ? "" : undefined}
                                    data-root={isRoot ? "" : undefined}
                                    data-dragging={dragId === s.id ? "" : undefined}
                                    style={{ left: pos.x, top: pos.y, width: NODE_W } as CSSProperties}
                                    onPointerDown={(e) => onNodePointerDown(e, s.id)}
                                    onPointerMove={onNodePointerMove}
                                    onPointerUp={onNodePointerUp}
                                    onPointerCancel={onNodePointerUp}
                                    onClick={() => { if (!dragRef.current?.moved) handleSwitch(s.id); }}
                                >
                                    <div className="mix-tree-node-head">
                                        <span className="mix-tree-dot" style={{ background: statusColor(status) }} />
                                        <span className="mix-tree-name" title={mixSessionTitle(s)}>{mixSessionTitle(s)}</span>
                                    </div>
                                    <div className="mix-tree-meta">
                                        {isRoot ? "根对局" : `第 ${mixRoundCount(s.turns)} 轮`}{s.depth ? ` · 第 ${s.depth} 层` : ""}
                                    </div>
                                    {summary ? <div className="mix-tree-summary">{summary}</div> : null}
                                    {s.branchNote ? <div className="mix-tree-note">{s.branchNote}</div> : null}
                                    <div className="mix-tree-ops" onClick={(e) => e.stopPropagation()}>
                                        <button type="button" className="mix-tree-op" onClick={() => setEdit({ id: s.id, name: s.branchName ?? "", note: s.branchNote ?? "" })}><Pencil size={12} /> 改名/备注</button>
                                        <button type="button" className="mix-tree-op" onClick={() => quickFork(s)}><GitBranch size={12} /> 分叉</button>
                                        <button type="button" className="mix-tree-op" data-tone="danger" onClick={() => setConfirmDelete(s.id)}><Trash2 size={12} /></button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {edit ? (
                <div className="mix-modal-mask" style={{ pointerEvents: "auto" } as CSSProperties} onClick={() => setEdit(null)}>
                    <div className="mix-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-modal-head">
                            <span>支线信息</span>
                            <button type="button" className="mix-modal-x" onClick={() => setEdit(null)} aria-label="关闭"><X size={16} /></button>
                        </div>
                        <div className="mix-modal-body">
                            <label className="mix-field">
                                <span>支线名</span>
                                <input className="mix-input" value={edit.name} maxLength={24} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="留空则显示「角色 · 配方」" />
                            </label>
                            <label className="mix-field">
                                <span>备注</span>
                                <textarea className="mix-textarea" value={edit.note} rows={3} maxLength={200} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="这条线在干嘛 / 为什么分叉 / 方便回退" />
                            </label>
                        </div>
                        <div className="mix-modal-foot">
                            <button type="button" className="mix-btn" onClick={() => setEdit(null)}>取消</button>
                            <button type="button" className="mix-btn mix-btn-primary" onClick={() => {
                                updateMixSessionTreeMeta(edit.id, { branchName: edit.name, branchNote: edit.note });
                                setEdit(null);
                                reload();
                                onToast?.("已保存支线信息");
                            }}>保存</button>
                        </div>
                    </div>
                </div>
            ) : null}

            {confirmDelete ? (
                <div className="mix-modal-mask" style={{ pointerEvents: "auto" } as CSSProperties} onClick={() => setConfirmDelete(null)}>
                    <div className="mix-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-modal-head"><span>删除这条支线？</span></div>
                        <div className="mix-modal-body">
                            <p className="mix-fork-from">它的子支线会<b>上提一级</b>挂到父节点（根被删则各自成根），进度不丢、树不散。</p>
                        </div>
                        <div className="mix-modal-foot">
                            <button type="button" className="mix-btn" onClick={() => setConfirmDelete(null)}>取消</button>
                            <button type="button" className="mix-btn mix-btn-primary" data-tone="danger" style={{ background: "rgba(198,96,96,0.9)" } as CSSProperties} onClick={() => doDelete(confirmDelete)}>删除</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
