// lib/floating-controls-store.ts
// 统一控制坞：把界面上散落的悬浮控件（快捷切换 / 聊天小窗 / 世界树 / 字数统计 / 对局切换）
// 收进右侧一个可收拢、可拖拽、可逐个显隐/排序的竖排坞里。
//
// 这里只持久化"坞自身的 UI 状态"（展开/收拢、各控件是否可用 / 是否常驻、顺序、竖向位置、弹窗锚点）。
// 每个控件真正的开关由各自的组件监听 CONTROL_DOCK_ACTIVATE_EVENT 事件来切换，互不耦合。
//
// 每个控件有两个彼此独立的开关，别混淆：
//   enabled（可使用）= 该功能是否活着。关闭 = 坞按钮、更多列表项、各界面浮标/小窗全部消失。
//   pinned （常驻显示）= 坞条上是否占一个按钮。关闭但可用 = 收进坞底「更多」列表，随点随用。

export type ControlId =
    | "quick-action"
    | "mini-chat"
    | "quick-note"
    | "mix-tree"
    | "mix-word-count"
    | "mix-session-switcher"
    | "mix-story-rail"
    | "mix-story-compass"
    | "mix-model-badge"
    | "mix-token"
    | "narrative-writer";

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
    { id: "quick-note", label: "速记", scope: "global" },
    { id: "mix-tree", label: "世界树", scope: "mixology" },
    { id: "mix-word-count", label: "字数统计", scope: "mixology" },
    { id: "mix-token", label: "Token 用量", scope: "mixology" },
    { id: "mix-session-switcher", label: "对局切换", scope: "mixology" },
    { id: "mix-story-rail", label: "剧情侧轨", scope: "mixology" },
    { id: "mix-story-compass", label: "溯源罗盘", scope: "mixology" },
    { id: "mix-model-badge", label: "当前模型", scope: "mixology" },
    { id: "narrative-writer", label: "执笔", scope: "global" },
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

/** 首次使用（以及从旧版单选迁移过来）时，坞条上默认常驻的控件 */
export const DEFAULT_RESIDENT_CONTROL_IDS: ControlId[] = ["quick-action"];

export type ControlDockSide = "left" | "right";

export type ControlDockState = {
    /** 坞是否展开（false = 仅剩一个折叠手柄） */
    expanded: boolean;
    /** 用户是否启用某控件（未列出 = 默认可用）。关闭 = 彻底停用，坞和「更多」里都不出现 */
    enabled: Partial<Record<ControlId, boolean>>;
    /** 用户是否把某控件常驻显示在坞条上（未列出 = 取 DEFAULT_RESIDENT_CONTROL_IDS） */
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
        enabled: {},
        pinned: {},
        order: CONTROL_DEFS.map(def => def.id),
        dockY: 120,
        dockSide: "right",
        anchorByControl: {},
    };
}

/**
 * 把旧版（只有一个勾选框）的存档迁移成双开关模型。
 * 旧存档里 pinned=false 的含义是"彻底隐藏、宁可不入口"，所以迁移成 enabled=false；
 * 其余控件一律回到"可用但不常驻"（返回空 pinned = 只保留 DEFAULT_RESIDENT_CONTROL_IDS）。
 */
function migrateLegacyPinned(legacyPinned: Partial<Record<ControlId, boolean>>): {
    enabled: Partial<Record<ControlId, boolean>>;
    pinned: Partial<Record<ControlId, boolean>>;
} {
    const enabled: Partial<Record<ControlId, boolean>> = {};
    for (const def of CONTROL_DEFS) {
        if (legacyPinned[def.id] === false) enabled[def.id] = false;
    }
    return { enabled, pinned: {} };
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
        const isLegacy = !parsed.enabled || typeof parsed.enabled !== "object";
        const storedPinned = parsed.pinned && typeof parsed.pinned === "object" ? parsed.pinned : {};
        const { enabled, pinned } = isLegacy
            ? migrateLegacyPinned(storedPinned)
            : { enabled: parsed.enabled as Partial<Record<ControlId, boolean>>, pinned: storedPinned };
        return {
            expanded: typeof parsed.expanded === "boolean" ? parsed.expanded : base.expanded,
            enabled,
            pinned,
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
        const { expanded, enabled, pinned, order, dockY, dockSide } = _state;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, expanded, enabled, pinned, order, dockY, dockSide }));
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

/** 控件是否"可使用"。关闭 = 坞按钮、更多列表、各界面浮标/小窗全部不出现 */
export function isControlEnabled(id: ControlId): boolean {
    return _state.enabled[id] !== false;
}

/** 控件是否"常驻显示"在坞条上。可用但不常驻 = 收进坞底「更多」列表 */
export function isControlPinned(id: ControlId): boolean {
    return _state.pinned[id] ?? DEFAULT_RESIDENT_CONTROL_IDS.includes(id);
}

/**
 * 控件是否已被统一控制坞"接管"。
 * 接管后该控件自带的悬浮按钮不再出现——入口只有坞按钮（常驻）或「更多」列表项。
 * 注意与 isControlPinned 的区别：pinned 只决定坞条上有没有它的按钮，
 * 取消常驻绝不会退回原来的自由悬浮状态，也不会让功能失联。
 */
export function isDockManaged(id: ControlId): boolean {
    return CONTROL_LABELS[id] !== undefined;
}

export function toggleControlPin(id: ControlId): void {
    setState({ ..._state, pinned: { ..._state.pinned, [id]: !isControlPinned(id) } });
}

/**
 * 切换控件可用态。
 * 不动 pinned：停用期间坞和「更多」都不列它（渲染侧统一按 enabled 过滤），
 * 重新打开时回到它原来所在的位置（常驻的回到坞条，未常驻的回到「更多」），
 * 不会因为关一次可用就把用户的常驻设置悄悄降级。
 */
export function setControlEnabled(id: ControlId, enabled: boolean): void {
    if (isControlEnabled(id) === enabled) return;
    setState({ ..._state, enabled: { ..._state.enabled, [id]: enabled } });
}

export function toggleControlEnabled(id: ControlId): void {
    setControlEnabled(id, !isControlEnabled(id));
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

/** 通知某控件组件切换自己的面板/窗口；已停用的控件不响应（防止残留入口把功能"复活"） */
export function activateControl(id: ControlId): void {
    if (typeof window === "undefined") return;
    if (!isControlEnabled(id)) return;
    window.dispatchEvent(new CustomEvent(CONTROL_DOCK_ACTIVATE_EVENT, { detail: { control: id } }));
}
