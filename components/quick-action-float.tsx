"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, Code2, Folder, FolderPlus, Pencil, Receipt, SlidersHorizontal, UserRound, X } from "lucide-react";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";
import {
    getFloatingDockState,
    subscribeFloatingDockState,
    expandFloatingDock,
    collapseFloatingDock,
    setFloatingDockAnchor,
    setActiveFloatingTool,
    clampFloatingDockAnchor,
} from "@/lib/floating-dock-store";
import {
    isDockManaged,
    CONTROL_DOCK_ACTIVATE_EVENT,
    getControlDockState,
    subscribeControlDockState,
} from "@/lib/floating-controls-store";
import {
    getCharacterBinding,
    loadApiConfigs,
    loadApiGroups,
    loadBindingConfig,
    loadWorldBooks,
    saveBindingConfig,
    setCharacterBinding,
} from "@/lib/settings-storage";
import type { ApiAccount, ApiConfig, ApiGroup, BindingConfig, BindingSlot, WorldBookConfig } from "@/lib/settings-types";
import {
    addApiGroup,
    buildApiSections,
    moveApiConfigToGroup,
    renameApiGroup,
    type ApiSection,
} from "@/lib/api-groups";
import {
    API_ACCOUNTS_UPDATED_EVENT,
    accountIdForConfig,
    accountLabel,
    getApiAccount,
    isAccountLow,
    loadAccounts,
    pricingLabel,
} from "@/lib/api-accounts";
import { ApiAccountPanel } from "@/components/settings/api-account-panel";
import { useApiDrag } from "@/lib/use-api-drag";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type QuickScope = "global" | "character";
type FloatingPosition = { left: number; top: number };
type PopoverPosition = { left: number; top: number; width?: number };
type FloatingDragState = {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

const EMPTY_BINDING_CONFIG: BindingConfig = { globalDefaults: {}, characterBindings: [] };

function clampFloatingPosition(value: number, max: number): number {
    return Math.min(Math.max(12, value), max);
}

function itemName<T extends { id: string; name?: string }>(items: T[], id?: string): string {
    if (!id) return "";
    return items.find(item => item.id === id)?.name || "已删除的配置";
}

function getStatusSafeTop(element: HTMLElement): number {
    const raw = window.getComputedStyle(element).getPropertyValue("--safe-area-top");
    const safeAreaTop = Number.parseFloat(raw);
    return Math.max(72, (Number.isFinite(safeAreaTop) ? safeAreaTop : 48) + 18);
}

export function QuickActionFloat() {
    const [enabled, setEnabled] = useState(false);
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState<QuickScope>("global");
    const [selectedCharId, setSelectedCharId] = useState("");
    const [config, setConfig] = useState<BindingConfig>(EMPTY_BINDING_CONFIG);
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [apiGroups, setApiGroups] = useState<ApiGroup[]>([]);
    const [apiAccounts, setApiAccounts] = useState<ApiAccount[]>([]);
    // 面板内的账户视图：null = 看绑定列表；否则显示账户面板（记一笔 / 改余额 / 流水）
    const [accountView, setAccountView] = useState<null | { view: "overview" | "charge" }>(null);
    // 文件夹折叠状态是面板内的临时态：默认折叠，当前选中项所在文件夹自动展开
    const [groupCollapsedOverride, setGroupCollapsedOverride] = useState<Record<string, boolean>>({});
    const [renamingGroupId, setRenamingGroupId] = useState("");
    const [renamingGroupName, setRenamingGroupName] = useState("");
    const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const [floatingDockEnabled, setFloatingDockEnabled] = useState(false);
    const [promptViewerEnabled, setPromptViewerEnabled] = useState(false);
    const dockState = useSyncExternalStore(subscribeFloatingDockState, getFloatingDockState, getFloatingDockState);
    const controlDockState = useSyncExternalStore(subscribeControlDockState, getControlDockState, getControlDockState);
    // 已由统一控制坞接管：自身悬浮球收起，入口只有坞按钮（常驻显示）或坞底「更多」列表项
    // （关掉"常驻显示"不会退回自由悬浮，功能仍可从「更多」点开）
    const managedQuick = isDockManaged("quick-action");
    // 入口是否活着：坞的「可使用」开着就照常工作，不再被手机设置里那个旧开关单独掐死
    // （快捷切换已被坞接管，坞是它唯一入口；设置里关掉会连带把坞的可用一起关掉，见 phone-settings-app）
    const active = enabled || controlDockState.enabled["quick-action"] !== false;
    const layerRef = useRef<HTMLDivElement | null>(null);
    const floatingButtonRef = useRef<HTMLButtonElement | null>(null);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);

    const handleClose = useCallback(() => {
        setOpen(false);
        if (floatingDockEnabled) {
            collapseFloatingDock();
        }
    }, [floatingDockEnabled]);

    const reloadData = useCallback(() => {
        const nextCharacters = loadCharacters();
        setConfig(loadBindingConfig());
        setApiConfigs(loadApiConfigs());
        setApiGroups(loadApiGroups());
        setApiAccounts(loadAccounts());
        setWorldBooks(loadWorldBooks());
        setCharacters(nextCharacters);
        setSelectedCharId(prev => {
            if (prev && nextCharacters.some(character => character.id === prev)) return prev;
            return nextCharacters[0]?.id || "";
        });
    }, []);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const settings = loadChatAppSettings();
            const nextEnabled = typeof detail?.quickActionEnabled === "boolean"
                ? detail.quickActionEnabled
                : settings.quickActionEnabled === true;
            setEnabled(nextEnabled);
            setPromptViewerEnabled(typeof detail?.promptViewerEnabled === "boolean" ? detail.promptViewerEnabled : settings.promptViewerEnabled === true);
            setFloatingDockEnabled(typeof detail?.floatingDockEnabled === "boolean" ? detail.floatingDockEnabled : settings.floatingDockEnabled === true);
            if (!nextEnabled) setOpen(false);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (!active) return;
        reloadData();
        const handleBindingsUpdated = () => reloadData();
        const handleFocus = () => reloadData();
        window.addEventListener("settings-bindings-updated", handleBindingsUpdated);
        window.addEventListener("focus", handleFocus);
        return () => {
            window.removeEventListener("settings-bindings-updated", handleBindingsUpdated);
            window.removeEventListener("focus", handleFocus);
        };
    }, [active, reloadData]);

    // 受统一控制坞驱动：坞里点「快捷切换」时切换本面板开合
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ control?: string }>).detail;
            if (detail?.control !== "quick-action") return;
            setOpen(prev => !prev);
            setActiveFloatingTool("quick-action");
            reloadData();
        };
        window.addEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
        return () => window.removeEventListener(CONTROL_DOCK_ACTIVATE_EVENT, handler);
    }, [reloadData]);

    // 账户余额/流水变化（设置页、特调界面操作后）也要跟着刷新，否则面板里是旧数字
    useEffect(() => {
        const handler = () => setApiAccounts(loadAccounts());
        window.addEventListener(API_ACCOUNTS_UPDATED_EVENT, handler);
        return () => window.removeEventListener(API_ACCOUNTS_UPDATED_EVENT, handler);
    }, []);

    // 每次重新打开面板，文件夹折叠状态回到默认（只展开当前正在用的那个文件夹）
    useEffect(() => {
        if (!open) return;
        setGroupCollapsedOverride({});
        setRenamingGroupId("");
        setAccountView(null);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!layerRef.current?.contains(event.target as Node)) {
                handleClose();
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [open, handleClose]);

    useEffect(() => {
        if (!floatingDockEnabled || !dockState.isExpanded || open) return;
        const handleOutside = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target?.closest(".prompt-viewer-float-button")) {
                collapseFloatingDock();
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener("pointerdown", handleOutside);
        }, 60);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerdown", handleOutside);
        };
    }, [floatingDockEnabled, dockState.isExpanded, open]);

    // 贴边坐标是按像素持久化的，换了视口尺寸要先夹回屏幕内，否则球可能落在屏幕外碰不到
    useLayoutEffect(() => {
        if (!floatingDockEnabled) return;
        const layer = layerRef.current;
        if (!layer) return;
        const apply = () => {
            const rect = layer.getBoundingClientRect();
            clampFloatingDockAnchor(rect.width, rect.height);
        };
        apply();
        window.addEventListener("resize", apply);
        return () => window.removeEventListener("resize", apply);
    }, [floatingDockEnabled, active]);

    useLayoutEffect(() => {
        const layer = layerRef.current;
        const button = floatingButtonRef.current;
        if (!open || !layer) {
            setPopoverPosition(null);
            return;
        }
        const rect = layer.getBoundingClientRect();
        const buttonRect = button ? button.getBoundingClientRect() : null;
        // 受管模式：面板贴着坞里被点的按钮，而不是（已被隐藏的）自身球
        const dockAnchor = managedQuick ? controlDockState.anchorByControl["quick-action"] : undefined;
        const posAnchor = (draggingFloatingButton && floatingPosition)
            ? floatingPosition
            : dockAnchor
                ? dockAnchor
                : (dockState.anchorPosition)
                    ? dockState.anchorPosition
                    : (floatingPosition ?? (buttonRect
                        ? { left: buttonRect.left - rect.left, top: buttonRect.top - rect.top }
                        : { left: rect.width - 70, top: 120 }));
        const width = Math.min(344, rect.width - 32);
        const statusSafeTop = getStatusSafeTop(layer);
        const estimatedHeight = Math.min(520, Math.max(240, rect.height - statusSafeTop - 12));
        let panelWidth = width;
        let left = posAnchor.left - width - 8;
        // 受控模式下面板绝不能压在控制坞上：横向挪到坞条的另一侧，
        // 剩余空间放不下 344 就缩面板宽度（手机壳只有 390 宽，46 的坞条会吃掉一边）。
        // 自由悬浮球模式下仍按球的位置弹，不受坞影响。
        const dockEl = dockAnchor ? document.querySelector<HTMLElement>(".fcd-dock") : null;
        if (dockEl) {
            const dockRect = dockEl.getBoundingClientRect();
            const dockLeft = dockRect.left - rect.left;
            const dockRight = dockRect.right - rect.left;
            const dockOnLeft = dockLeft + dockRect.width / 2 < rect.width / 2;
            if (dockOnLeft) {
                const start = Math.min(Math.max(dockRight + 8, 12), rect.width - 240);
                panelWidth = Math.min(width, rect.width - 12 - start);
                left = start;
            } else {
                panelWidth = Math.min(width, Math.max(240, dockLeft - 20));
                left = dockLeft - 8 - panelWidth;
            }
        }
        const top = posAnchor.top - estimatedHeight - 8;
        const maxTop = Math.max(statusSafeTop, rect.height - estimatedHeight - 12);
        setPopoverPosition({
            left: Math.min(Math.max(12, left), Math.max(12, rect.width - panelWidth - 12)),
            top: Math.min(Math.max(statusSafeTop, top), maxTop),
            width: dockEl ? panelWidth : undefined,
        });
    }, [
        open,
        floatingPosition,
        dockState.anchorPosition,
        draggingFloatingButton,
        managedQuick,
        controlDockState.anchorByControl,
        controlDockState.dockSide,
        controlDockState.dockY,
    ]);

    const currentSlot: BindingSlot = useMemo(() => {
        if (scope === "global") return config.globalDefaults || {};
        if (!selectedCharId) return {};
        return getCharacterBinding(config, selectedCharId).defaults;
    }, [config, scope, selectedCharId]);

    const selectedCharacter = useMemo(
        () => characters.find(character => character.id === selectedCharId) || null,
        [characters, selectedCharId]
    );
    const selectedWorldBookIds = currentSlot.worldBookIds || [];
    const selectedWorldBookNames = selectedWorldBookIds.map(id => itemName(worldBooks, id)).filter(Boolean);
    const inheritedApiName = scope === "character" ? itemName(apiConfigs, config.globalDefaults.apiConfigId) : "";
    const apiSections = useMemo(() => buildApiSections(apiConfigs, apiGroups), [apiConfigs, apiGroups]);
    const hasApiGroups = apiGroups.length > 0;

    /* ---------- 账户（一个文件夹一本账） ---------- */
    /**
     * 实际生效的 API：当前作用域没显式选就落到全局默认那个（角色「继承全局」的情形）。
     * 不回退的话，角色视角下账户条会显示「未分组 · 未建账」，看着像账户体系没生效。
     */
    const effectiveApiConfigId = currentSlot.apiConfigId || config.globalDefaults.apiConfigId;
    const isInheritedApi = !currentSlot.apiConfigId && !!config.globalDefaults.apiConfigId;
    const currentApiConfig = useMemo(
        () => apiConfigs.find(api => api.id === effectiveApiConfigId) || null,
        [apiConfigs, effectiveApiConfigId]
    );
    const currentAccountId = accountIdForConfig(currentApiConfig);
    const currentAccount = useMemo<ApiAccount>(() => {
        const found = apiAccounts.find(item => item.id === currentAccountId);
        return found || { id: currentAccountId, balance: 0 };
    }, [apiAccounts, currentAccountId]);
    const balanceOf = useCallback((accountId: string): number | null => {
        const found = apiAccounts.find(item => item.id === accountId);
        return found ? found.balance : null;
    }, [apiAccounts]);
    const hasAccountRecord = useMemo(
        () => apiAccounts.some(item => item.id === currentAccountId),
        [apiAccounts, currentAccountId]
    );
    const formatAmount = useCallback((value: number, digits = 4) => {
        const fixed = value.toFixed(digits);
        return digits > 0 ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
    }, []);
    /** 记账结果播成全局提示：手机顶部弹一条，比面板里的小字明显得多 */
    const notifyGlobal = useCallback((message: string) => {
        window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
    }, []);

    // 默认折叠；当前正在用的 API 所在文件夹自动展开，让用户一眼看到选中项
    const isGroupCollapsed = useCallback((section: ApiSection): boolean => {
        const override = groupCollapsedOverride[section.id];
        if (typeof override === "boolean") return override;
        return !section.items.some(api => api.id === currentSlot.apiConfigId);
    }, [groupCollapsedOverride, currentSlot.apiConfigId]);

    const toggleGroupCollapsed = useCallback((section: ApiSection) => {
        setGroupCollapsedOverride(prev => ({ ...prev, [section.id]: !isGroupCollapsed(section) }));
    }, [isGroupCollapsed]);

    const commitGroupRename = useCallback((groupId: string) => {
        setApiGroups(renameApiGroup(groupId, renamingGroupName));
        setRenamingGroupId("");
    }, [renamingGroupName]);

    // 面板内直接新建文件夹（不必再跑去设置页），建完立刻进入改名状态
    const createGroupInPanel = useCallback(() => {
        const next = addApiGroup("新文件夹");
        setApiGroups(next);
        const created = next[next.length - 1];
        if (created) {
            setRenamingGroupId(created.id);
            setRenamingGroupName(created.name);
        }
    }, []);

    // 拖拽 API 到文件夹行 / 未分组行；落入后自动展开该文件夹，便于确认结果
    const handleDropApiToGroup = useCallback((configId: string, groupId: string) => {
        setApiConfigs(moveApiConfigToGroup(configId, groupId));
        if (groupId) setGroupCollapsedOverride(prev => ({ ...prev, [groupId]: false }));
    }, []);

    const { overlay: dragOverlay, handleDragPointerDown, consumeSuppressedClick } = useApiDrag(handleDropApiToGroup);
    const inheritedWorldBookNames = scope === "character"
        ? (config.globalDefaults.worldBookIds || []).map(id => itemName(worldBooks, id)).filter(Boolean)
        : [];

    const persistConfig = useCallback((next: BindingConfig) => {
        setConfig(next);
        saveBindingConfig(next);
    }, []);

    const updateApiConfig = useCallback((apiConfigId: string | undefined) => {
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, apiConfigId: apiConfigId || undefined } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, apiConfigId: apiConfigId || undefined },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const updateWorldBooks = useCallback((worldBookIds: string[]) => {
        const nextIds = worldBookIds.length > 0 ? worldBookIds : undefined;
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, worldBookIds: nextIds } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, worldBookIds: nextIds },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const toggleWorldBook = useCallback((worldBookId: string) => {
        const next = selectedWorldBookIds.includes(worldBookId)
            ? selectedWorldBookIds.filter(id => id !== worldBookId)
            : [...selectedWorldBookIds, worldBookId];
        updateWorldBooks(next);
    }, [selectedWorldBookIds, updateWorldBooks]);

    function getFloatingButtonBounds(button: HTMLButtonElement, currentPos: FloatingPosition | null) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        // 始终使用未变换的纯净布局坐标：优先使用 state 中的位置，若初始未拖拽则取 offsetLeft / offsetTop（不受 CSS transform 影响）
        const left = currentPos ? currentPos.left : button.offsetLeft;
        const top = currentPos ? currentPos.top : button.offsetTop;
        return {
            left,
            top,
            maxLeft: Math.max(12, parentRect.width - 56 - 12),
            maxTop: Math.max(12, parentRect.height - 56 - 12),
            parentWidth: parentRect.width,
            parentHeight: parentRect.height,
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        const isDual = floatingDockEnabled && promptViewerEnabled && active;
        const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
        if (dockState.isExpanded || (isDual && !isQuickPrimary)) {
            // 展开挑选模式、或并非当前停靠的主球时，不接受拖拽
            return;
        }
        event.stopPropagation();
        const button = event.currentTarget;
        const anchor = isDual ? dockState.anchorPosition : null;
        const bounds = getFloatingButtonBounds(button, (isDual && anchor) ? anchor : floatingPosition);
        floatingDragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        // 不在 pointerDown 立即 setDraggingFloatingButton(true)，避免普通点击时瞬间取消 is-docked 产生动画抖动
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (!drag.moved) {
            // 超过 3px 移动阈值才判定为拖拽，杜绝手指/鼠标微小震颤把贴边位移写入 floatingPosition
            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                drag.moved = true;
                setDraggingFloatingButton(true);
            } else {
                return;
            }
        }
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handleFloatingPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) {
            suppressFloatingClickRef.current = true;
            if (floatingDockEnabled) {
                // Auto-snap to closest edge (left or right)
                const bounds = getFloatingButtonBounds(event.currentTarget, floatingPosition);
                const midX = bounds.parentWidth / 2;
                const currentX = drag.left + (event.clientX - drag.startClientX);
                const currentTop = drag.top + (event.clientY - drag.startClientY);
                const isLeft = currentX < midX;
                const snappedLeft = isLeft ? 18 : Math.max(18, bounds.parentWidth - 56 - 18);
                const snappedTop = clampFloatingPosition(currentTop, bounds.maxTop);
                const newPos = { left: snappedLeft, top: snappedTop };
                setFloatingPosition(newPos);
                setFloatingDockAnchor({ ...newPos, dockSide: isLeft ? "left" : "right" });
                if (!open) {
                    collapseFloatingDock();
                }
            }
        }

        floatingDragRef.current = null;
        setDraggingFloatingButton(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleFloatingButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressFloatingClickRef.current) {
            suppressFloatingClickRef.current = false;
            return;
        }

        // If already open, clicking it collapses back to dock
        if (open) {
            handleClose();
            return;
        }

        if (floatingDockEnabled) {
            const isDual = promptViewerEnabled && active;
            const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
            // Dual-ball mode: if currently docked as primary and not expanded, clicking expands both balls!
            if (isDual && isQuickPrimary && dockState.isDocked && !dockState.isExpanded) {
                expandFloatingDock();
                return;
            }
            setActiveFloatingTool("quick-action");
        }

        reloadData();
        setOpen(true);
    }

    if (!active) return null;

    const characterDisabled = scope === "character" && characters.length === 0;
    const inheritApiLabel = scope === "global"
        ? "未设置"
        : inheritedApiName
            ? `继承全局：${inheritedApiName}`
            : "继承全局";
    const inheritWorldBookLabel = scope === "global"
        ? "未设置"
        : inheritedWorldBookNames.length > 0
            ? `继承全局：${inheritedWorldBookNames.join("、")}`
            : "继承全局";
    const popoverStyle: CSSProperties | undefined = popoverPosition
        ? { left: popoverPosition.left, top: popoverPosition.top, width: popoverPosition.width }
        : undefined;

    const isDual = floatingDockEnabled && promptViewerEnabled && active;
    const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
    const isPromptViewerActive = floatingDockEnabled && promptViewerEnabled && dockState.activeTool === "prompt-viewer";

    const renderApiOption = (api: ApiConfig) => (
        <button
            type="button"
            key={api.id}
            className="quick-action-option api-drag-source"
            data-selected={currentSlot.apiConfigId === api.id}
            disabled={characterDisabled}
            onPointerDown={(event) => handleDragPointerDown(event, api)}
            onClick={() => {
                if (consumeSuppressedClick()) return;
                updateApiConfig(api.id);
            }}
        >
            <span>{api.name || api.defaultModel || api.provider}</span>
            {api.pricing ? <em className="quick-action-option-price">{pricingLabel(api.pricing)}</em> : null}
            {currentSlot.apiConfigId === api.id ? <Check size={15} /> : null}
        </button>
    );

    const isHiddenBehind = isDual && !isQuickPrimary && !open && !dockState.isExpanded;
    const isDocked = floatingDockEnabled && !open && (
        isQuickPrimary ? (dockState.isDocked && !draggingFloatingButton) : false
    );
    const isOpen = open;
    const isExpanded = floatingDockEnabled && !open && dockState.isExpanded;
    const isPaired = isDual && !isQuickPrimary && !open && dockState.isExpanded;
    const dockSide = dockState.dockSide;
    const anchor = isDual ? dockState.anchorPosition : null;

    const buttonClass = [
        "prompt-viewer-float-button",
        "quick-action-float-button",
        isHiddenBehind ? "is-hidden-behind" : "",
        isDocked ? "is-docked" : "",
        isOpen ? "is-open" : "",
        isExpanded ? "is-expanded" : "",
        isPaired ? "is-paired" : "",
    ].filter(Boolean).join(" ");

    let buttonStyle: CSSProperties | undefined;
    if (draggingFloatingButton && floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual && anchor) {
        buttonStyle = { left: anchor.left, top: anchor.top };
    } else if (floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual) {
        buttonStyle = { bottom: 148, right: 18 };
    }
    if (isPromptViewerActive) {
        buttonStyle = { ...buttonStyle, display: "none" };
    }

    return (
        <div className="quick-action-layer" ref={layerRef}>
            {!managedQuick && (
            <button
                ref={floatingButtonRef}
                type="button"
                className={buttonClass}
                aria-label="打开快捷操作"
                data-positioned={(isDual ? !!anchor : !!floatingPosition) ? "" : undefined}
                data-dragging={draggingFloatingButton ? "" : undefined}
                data-dock-side={floatingDockEnabled ? dockSide : undefined}
                onPointerDown={handleFloatingPointerDown}
                onPointerMove={handleFloatingPointerMove}
                onPointerUp={handleFloatingPointerEnd}
                onPointerCancel={handleFloatingPointerEnd}
                onClick={handleFloatingButtonClick}
                style={buttonStyle}
            >
                <SlidersHorizontal size={24} strokeWidth={1.9} />
            </button>
            )}

            {open ? (
                <div
                    className="quick-action-popover"
                    data-positioned={popoverPosition ? "" : undefined}
                    style={popoverStyle}
                    role="dialog"
                    aria-label="快捷操作"
                    onClick={event => event.stopPropagation()}
                >
                    <div className="quick-action-header">
                        <div className="quick-action-title">
                            <span className="quick-action-title-icon"><SlidersHorizontal size={18} /></span>
                            <div>
                                <h3>快捷操作</h3>
                                <p>{scope === "global" ? "全局默认" : selectedCharacter?.name || "角色默认"}</p>
                            </div>
                        </div>
                        <button type="button" className="quick-action-icon-btn" onClick={handleClose} aria-label="关闭快捷操作">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="quick-action-body">
                        {accountView ? (
                            <ApiAccountPanel
                                accountId={currentAccountId}
                                initialView={accountView.view}
                                onClose={() => setAccountView(null)}
                                title={accountLabel(currentAccountId, apiGroups)}
                                onNotice={notifyGlobal}
                            />
                        ) : (
                        <>
                        <div className="quick-action-tabs" role="tablist" aria-label="绑定范围">
                            <button
                                type="button"
                                data-active={scope === "global"}
                                onClick={() => setScope("global")}
                            >
                                全局
                            </button>
                            <button
                                type="button"
                                data-active={scope === "character"}
                                onClick={() => setScope("character")}
                            >
                                角色
                            </button>
                        </div>

                        {scope === "character" ? (
                            <label className="quick-action-select-wrap">
                                <span><UserRound size={15} />角色</span>
                                <div className="quick-action-select-shell">
                                    <select
                                        value={selectedCharId}
                                        onChange={event => setSelectedCharId(event.target.value)}
                                        disabled={characters.length === 0}
                                    >
                                        {characters.length === 0 ? (
                                            <option value="">暂无角色</option>
                                        ) : characters.map(character => (
                                            <option key={character.id} value={character.id}>{character.name}</option>
                                        ))}
                                    </select>
                                    <ChevronDown size={16} />
                                </div>
                            </label>
                        ) : null}

                        <div className="quick-action-account-bar">
                            <div className="quick-action-account-bar-main">
                                <small>
                                    {accountLabel(currentAccountId, apiGroups)}
                                    {currentApiConfig ? ` · ${currentApiConfig.name || currentApiConfig.defaultModel || currentApiConfig.provider}` : " · 未选 API"}
                                    {isInheritedApi ? "（继承全局）" : ""}
                                </small>
                                {hasAccountRecord ? (
                                    <span>
                                        <b>{formatAmount(currentAccount.balance)}</b> 额度
                                        {isAccountLow(currentAccount)
                                            ? <em className="quick-action-account-warn">低于阈值 {formatAmount(currentAccount.lowThreshold || 0, 0)}</em>
                                            : null}
                                    </span>
                                ) : (
                                    <span className="quick-action-account-empty">这个账户还没建账，点右侧「记一笔」开始</span>
                                )}
                            </div>
                            <button
                                type="button"
                                className="api-bal-chip"
                                data-low={isAccountLow(currentAccount) ? "true" : undefined}
                                onClick={() => setAccountView({ view: "charge" })}
                                title="按当前 API 的单价扣一笔"
                            >
                                <Receipt size={12} />记一笔
                            </button>
                        </div>

                        <section className="quick-action-section" data-disabled={characterDisabled ? "" : undefined}>
                            <div className="quick-action-section-heading">
                                <span><Code2 size={16} />API</span>
                                <div className="quick-action-heading-right">
                                    {currentSlot.apiConfigId ? <small>{itemName(apiConfigs, currentSlot.apiConfigId)}</small> : <small>{scope === "global" ? "未设置" : "继承"}</small>}
                                    <button
                                        type="button"
                                        className="quick-action-heading-btn"
                                        disabled={characterDisabled}
                                        onClick={createGroupInPanel}
                                        title="新建 API 文件夹"
                                        aria-label="新建 API 文件夹"
                                    >
                                        <FolderPlus size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="quick-action-option-list">
                                <button
                                    type="button"
                                    className="quick-action-option"
                                    data-selected={!currentSlot.apiConfigId}
                                    disabled={characterDisabled}
                                    onClick={() => updateApiConfig(undefined)}
                                >
                                    <span>{inheritApiLabel}</span>
                                    {!currentSlot.apiConfigId ? <Check size={15} /> : null}
                                </button>
                                {apiConfigs.length === 0 ? (
                                    <div className="quick-action-empty">暂无 API 配置</div>
                                ) : !hasApiGroups ? (
                                    apiConfigs.map(api => renderApiOption(api))
                                ) : (
                                    apiSections.map(section => {
                                        if (section.kind === "ungrouped") {
                                            return (
                                                <div className="quick-action-group" key="__ungrouped__">
                                                    <div className="quick-action-ungrouped" data-api-drop-group="">
                                                        未分组
                                                    </div>
                                                    {section.items.map(api => renderApiOption(api))}
                                                </div>
                                            );
                                        }
                                        const collapsed = isGroupCollapsed(section);
                                        const selectedInside = section.items.some(api => api.id === currentSlot.apiConfigId);
                                        return (
                                            <div className="quick-action-group" key={section.id}>
                                                <div className="quick-action-folder-row" data-api-drop-group={section.id}>
                                                    {renamingGroupId === section.id ? (
                                                        <div className="quick-action-folder" data-renaming="true">
                                                            <Folder size={15} />
                                                            <input
                                                                className="quick-action-folder-rename"
                                                                value={renamingGroupName}
                                                                autoFocus
                                                                aria-label="文件夹名称"
                                                                onChange={event => setRenamingGroupName(event.target.value)}
                                                                onBlur={() => commitGroupRename(section.id)}
                                                                onKeyDown={event => {
                                                                    if (event.key === "Enter") {
                                                                        event.preventDefault();
                                                                        commitGroupRename(section.id);
                                                                    } else if (event.key === "Escape") {
                                                                        event.preventDefault();
                                                                        setRenamingGroupId("");
                                                                    }
                                                                }}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="quick-action-folder"
                                                                data-selected={selectedInside}
                                                                disabled={characterDisabled}
                                                                onClick={() => toggleGroupCollapsed(section)}
                                                            >
                                                                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                                                                <Folder size={15} />
                                                                <span>{section.name}</span>
                                                                <span className="quick-action-folder-count">{section.items.length}</span>
                                                                {balanceOf(section.id) !== null ? (
                                                                    <span className="quick-action-folder-bal">{formatAmount(balanceOf(section.id) as number)}</span>
                                                                ) : null}
                                                                {selectedInside ? <Check size={14} /> : null}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="quick-action-folder-btn"
                                                                aria-label="重命名文件夹"
                                                                disabled={characterDisabled}
                                                                onClick={() => {
                                                                    setRenamingGroupId(section.id);
                                                                    setRenamingGroupName(section.name);
                                                                }}
                                                            >
                                                                <Pencil size={13} />
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                                {collapsed ? null : section.items.length === 0 ? (
                                                    <div className="quick-action-empty">文件夹还是空的</div>
                                                ) : (
                                                    <div className="quick-action-sublist">
                                                        {section.items.map(api => renderApiOption(api))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </section>

                        <section className="quick-action-section" data-disabled={characterDisabled ? "" : undefined}>
                            <div className="quick-action-section-heading">
                                <span><BookOpen size={16} />世界书</span>
                                <button
                                    type="button"
                                    className="quick-action-clear-btn"
                                    disabled={characterDisabled || selectedWorldBookIds.length === 0}
                                    onClick={() => updateWorldBooks([])}
                                >
                                    清空
                                </button>
                            </div>
                            <button
                                type="button"
                                className="quick-action-option quick-action-inherit-option"
                                data-selected={selectedWorldBookIds.length === 0}
                                disabled={characterDisabled}
                                onClick={() => updateWorldBooks([])}
                            >
                                <span>{selectedWorldBookIds.length === 0 ? inheritWorldBookLabel : selectedWorldBookNames.join("、")}</span>
                                {selectedWorldBookIds.length === 0 ? <Check size={15} /> : null}
                            </button>
                            {worldBooks.length === 0 ? (
                                <div className="quick-action-empty">暂无世界书</div>
                            ) : (
                                <div className="quick-action-chip-grid">
                                    {worldBooks.map(book => {
                                        const selected = selectedWorldBookIds.includes(book.id);
                                        return (
                                            <button
                                                type="button"
                                                key={book.id}
                                                className="quick-action-chip"
                                                data-selected={selected}
                                                disabled={characterDisabled}
                                                onClick={() => toggleWorldBook(book.id)}
                                            >
                                                <span>{book.name}</span>
                                                {selected ? <Check size={14} /> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                        </>
                        )}
                    </div>
                </div>
            ) : null}

            {dragOverlay ? (
                <div
                    className="api-drag-ghost"
                    data-over-target={dragOverlay.targetGroupId !== null ? "true" : undefined}
                    style={{ left: dragOverlay.x, top: dragOverlay.y }}
                >
                    {dragOverlay.label}
                </div>
            ) : null}
        </div>
    );
}
