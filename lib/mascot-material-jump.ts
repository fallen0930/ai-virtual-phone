// lib/mascot-material-jump.ts
// 卷宝工具回执 → 独家特调酒柜的一键跳转桥。
//
// 她真机的原话：「具体的内容我是看不见的，只能看见这样半截」——回执里明明写着
// （id: mixmat_xxx）/[mixmat_xxx]/台账 kind:mixmat_xxx，界面上却没有任何入口能到那张卡。
//
// 为什么是「sessionStorage 桥 + CustomEvent」双通道：点按钮时特调 App 可能还没挂载
// （事件派了没人听），也可能已经挂着（等不到 mount 时的消费）。所以出口先把 id 写进
// 桥再派事件，入口两头都调 consumePendingMixMaterialJump()——**消费一次即清**，
// 两条路径谁先抢到算谁，绝不会重复弹编辑页。纯函数无框架依赖，node 测试直接跑。

export const MIXOLOGY_OPEN_MATERIAL_EVENT = "mixology-open-material";
/** sessionStorage 桥键：与组件侧的跨文件约定，改名两头一起断，测试里钉死 */
export const MIX_MATERIAL_JUMP_KEY = "mixology-open-material-pending";

/** 材料 id 形态：用户/导入件 mixmat_xxx、官方出厂件 mix_builtin_xxx（base36 小写） */
const MIX_MATERIAL_ID_RE = /\b(?:mixmat|mix_builtin)_[a-z0-9]+\b/gi;

/**
 * 从工具回执文本里抠出材料 id（出现顺序去重）。
 * 只认材料 id：配方 mixrec_/会话 mixses_ 跳的是编辑材料页，混进来会跳错地方。
 */
export function extractMixMaterialIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const source = text || "";
    MIX_MATERIAL_ID_RE.lastIndex = 0;
    let match = MIX_MATERIAL_ID_RE.exec(source);
    while (match) {
        const id = match[0];
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
        match = MIX_MATERIAL_ID_RE.exec(source);
    }
    return ids;
}

function sessionStore(): Storage | null {
    try {
        return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
        return null;
    }
}

/** 出口：写桥（给还没挂载的 App 留话）→ 派事件（给已挂载的 App 即时响应） */
export function requestOpenMixMaterial(id: string): void {
    if (!id) return;
    try {
        sessionStore()?.setItem(MIX_MATERIAL_JUMP_KEY, id);
    } catch {
        // 隐私模式/配额：事件通道仍能覆盖 App 已挂载的情况
    }
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent(MIXOLOGY_OPEN_MATERIAL_EVENT, { detail: { id } }));
    }
}

/** 入口：读桥并立即清除——消费一次即清，重复调用拿不到第二次 */
export function consumePendingMixMaterialJump(): string | null {
    const store = sessionStore();
    if (!store) return null;
    let id: string | null = null;
    try {
        id = store.getItem(MIX_MATERIAL_JUMP_KEY);
        if (id) store.removeItem(MIX_MATERIAL_JUMP_KEY);
    } catch {
        return null;
    }
    return id;
}
