// lib/floating-controls-store.ts
// 统一控制坞：把界面上散落的悬浮控件（快捷切换 / 聊天小窗 / 世界树 / 字数统计 / 对局切换）
// 收进右侧一个可收拢、可拖拽、可逐个显隐/排序的竖排坞里。
//
// 这里只持久化"坞自身的 UI 状态"（展开/收拢、各控件是否钉在坞里、顺序、竖向位置、弹窗锚点）。
// 每个控件真正的开关由各自的组件监听 CONTROL_DOCK_ACTIVATE_EVENT 事件来切换，互不耦合。

export type ControlId =
    | "quick-action"
    | "prompt-viewer"
    | "mini-chat"
    | "mascot"
    | "quick-note"
    | "mix-tree"
    | "mix-word-count"
    | "mix-session-switcher"
    | "mix-story-rail"
    | "mix-story-compass"
    | "mix-model-badge";

export type ControlScope = "global" | "mixology";

export type ControlDef = {
    id: ControlId;
    label: string;
    /** global = 任何界面都可能出现；mixology = 仅对局页出现 */
    scope: ControlScope;
};

export const CONTROL_DEFS: ControlDef[] = [
    { id: "quick-action", label: "快捷切换", scope: "global" },
    { id: "mini-chat", label: "聊天小窗", scope: "global" },
    { id: "prompt-viewer", label: "提示词", scope: "global" },
    { id: "mascot", label: "桌宠", scope: "global" },
    { id: "quick-note", label: "速记", scope: "global" },
    { id: "mix-tree", label: "世界树", scope: "mixology" },
    { id: "mix-word-count", label: "字数统计", scope: "mixology" },
    { id: "mix-session-switcher", label: "对局切换", scope: "mixology" },
    { id: "mix-story-rail", label: "剧情侧轨", scope: "mixology" },
    { id: "mix-story-compass", label: "溯源罗盘", scope: "mixology" },
    { id: "mix-model-badge", label: "当前模型", scope: "mixology" },
];

export const CONTROL_LABELS: Record<ControlId, string> = CONTROL_DEFS.reduce(
    (acc, def) => {
        acc[def.id] = def.label;
        return acc;
    },
    {} as Record<ControlId, string>,
);

/** 点击坞里某控件按钮时派发的事件；各控件组件监听 { detail: { control } } 来切换自身面板 */
export const CONTROL_DOCK_ACTIVATE_EVENT = "phone-control-dock:activate";

const STORAGE_KEY = "phone_control_dock_v1";

export type ControlDockSide = "left" | "right";

export type ControlDockState = {
    /** 坞是否展开（false = 仅剩一个折叠手柄） */
    expanded: boolean;
    /** 用户是否把某控件钉在坞里（未列出 = 默认显示） */
    pinned: Partial<Record<ControlId, boolean>>;
    /** 坞里按钮的顺序 */
    order: ControlId[];
    /** 坞顶部相对宿主容器的竖向偏移（px） */
    dockY: number;
    /** 坞贴哪一边：挡内容时可以直接整坞挪到另一边 */
    dockSide: ControlDockSide;
    /** 各控件按钮在宿主容器内的坐标，供其弹出面板定位（受管后 FAB 隐藏，面板需贴着坞按钮） */
    anchorByControl: Partial<Record<ControlId, { left: number; top: number }>>;
};

function getDefaultState(): ControlDockState {
    return {
        expanded: true,
        pinned: {},
        order: CONTROL_DEFS.map(def => def.id),
        dockY: 120,
        dockSide: "right",
        anchorByControl: {},
    };
}

function loadState(): ControlDockState {
    const base = getDefaultState();
    if (typeof window === "undefined") return base;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const parsed = JSON.parse(raw) as Partial<ControlDockState>;
        const order = Array.isArray(parsed.order)
            ? parsed.order.filter((id): id is ControlId => CONTROL_LABELS[id] !== undefined)
            : base.order;
        // 补齐新增/缺失的控件，保证顺序数组完整
        const mergedOrder = [...base.order];
        for (const id of order) {
            if (!mergedOrder.includes(id)) mergedOrder.push(id);
        }
        return {
            expanded: typeof parsed.expanded === "boolean" ? parsed.expanded : base.expanded,
            pinned: parsed.pinned && typeof parsed.pinned === "object" ? parsed.pinned : base.pinned,
            order: mergedOrder,
            dockY: typeof parsed.dockY === "number" ? parsed.dockY : base.dockY,
            dockSide: parsed.dockSide === "left" ? "left" : "right",
            anchorByControl: parsed.anchorByControl && typeof parsed.anchorByControl === "object" ? parsed.anchorByControl : base.anchorByControl,
        };
    } catch {
        return base;
    }
}

let _state: ControlDockState = loadState();
const _listeners = new Set<() => void>();

function persist() {
    try {
        const { expanded, pinned, order, dockY, dockSide } = _state;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ expanded, pinned, order, dockY, dockSide }));
    } catch {
        // ignore
    }
}

function notify() {
    _listeners.forEach(fn => fn());
}

function setState(next: ControlDockState) {
    _state = next;
    persist();
    notify();
}

export function getControlDockState(): ControlDockState {
    return _state;
}

export function subscribeControlDockState(fn: () => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}

export function setControlDockExpanded(expanded: boolean): void {
    if (_state.expanded === expanded) return;
    setState({ ..._state, expanded });
}

export function toggleControlDockExpanded(): void {
    setState({ ..._state, expanded: !_state.expanded });
}

export function isControlPinned(id: ControlId): boolean {
    return _state.pinned[id] !== false;
}

/**
 * 控件是否已被统一控制坞"接管"。
 * 接管后该控件自带的悬浮按钮永久不再出现——坞是它唯一的入口。
 * 注意与 isControlPinned 的区别：pinned 只决定它在坞里有没有按钮
 * （取消勾选 = 彻底隐藏，绝不能退回原来的自由悬浮状态）。
 */
export function isDockManaged(id: ControlId): boolean {
    return CONTROL_LABELS[id] !== undefined;
}

export function toggleControlPin(id: ControlId): void {
    setState({ ..._state, pinned: { ..._state.pinned, [id]: !isControlPinned(id) } });
}

export function setControlOrder(order: ControlId[]): void {
    setState({ ..._state, order });
}

export function moveControl(id: ControlId, dir: -1 | 1): void {
    const idx = _state.order.indexOf(id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= _state.order.length) return;
    const next = [..._state.order];
    [next[idx], next[target]] = [next[target], next[idx]];
    setState({ ..._state, order: next });
}

export function setDockY(y: number): void {
    if (_state.dockY === y) return;
    setState({ ..._state, dockY: y });
}

/** 整坞换边：左边 ↔ 右边（挡内容时最省事的解法） */
export function setDockSide(side: ControlDockSide): void {
    if (_state.dockSide === side) return;
    setState({ ..._state, dockSide: side });
}

export function toggleDockSide(): void {
    setDockSide(_state.dockSide === "right" ? "left" : "right");
}

export function setDockAnchorByControl(anchorByControl: Partial<Record<ControlId, { left: number; top: number }>>): void {
    setState({ ..._state, anchorByControl });
}

/** 通知某控件组件切换自己的面板/窗口 */
export function activateControl(id: ControlId): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CONTROL_DOCK_ACTIVATE_EVENT, { detail: { control: id } }));
}
