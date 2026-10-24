import { afterEach, describe, expect, it } from "vitest";
import { kvRemove } from "@/lib/kv-db";
import {
    buildMixSessionTreeStats,
    collectMixSessionSubtreeIds,
    deleteMixSession,
    deleteMixSessionBranch,
    filterMixSessionRoots,
    listMixOrphanSpinoffs,
    listMixSpinoffs,
    loadMixSessions,
    saveMixSession,
} from "@/lib/mixology/storage";
import {
    consumeMixWorldTreeOpen,
    requestMixWorldTreeOpen,
    resetMixWorldTreeOpen,
} from "@/lib/mixology/world-tree-intent";
import type { MixSession } from "@/lib/mixology/types";

// 对局列表里的「一眼看见支线数」（2026-10-24 她批准的口径）
//
// 覆盖什么：
//   A 支线数按**全部后代**算（孙子支线也算进来，不用逐层点）；番外**不混进**支线数，单独计一个数。
//   B 番外按来源节点计，并沿父链上贡献到根——从支线开的番外在这一棵树的行上照样看得见。
//   C 酒局列表只列门面局：根对局 + 无谱系老对局，支线与番外都不单独占一行。
//   D 来源对局已被删除的番外不能变成看不见的孤儿数据，单独成组返回。
//   E 谱系数据脏了（父子互指成环、父级缺失）时，计数有限、不死循环、不丢节点。
//   F 列表角标 → 进对局 → 世界树自动展开：意图一次性，消费即清。
//
// 这些计数只依赖 sessions 这一个 JSON  blob 里的 parentId/rootId/spinoff 字段，
// 不新增存储键；界面渲染（角标、抽屉、世界树番外一节）属于目视项，见 MANUAL_CHECKLIST 新增段。

const touchedKeys = new Set<string>();
const createdSids = new Set<string>();

function rand(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function makeSession(over: Partial<MixSession> & { id: string }): MixSession {
    const now = 1_700_000_000_000;
    return {
        recipe: { id: `recipe_${over.id}`, name: "计数测试配方", slots: {}, createdAt: now, updatedAt: now },
        charName: "计数角色",
        openingIndex: 0,
        turns: [],
        createdAt: now,
        updatedAt: now,
        ...over,
    } as MixSession;
}

/** 造一场对局并落进真实的 mixology_sessions_v1（列表口径要用 loadMixSessions 复核） */
function seed(over: Partial<MixSession> & { id: string }): MixSession {
    const session = makeSession(over);
    createdSids.add(session.id);
    saveMixSession(session);
    touchedKeys.add("mixology_sessions_v1");
    return session;
}

afterEach(() => {
    // 所有用例都挤在 mixology_sessions_v1 一个键里，整键清掉最干净
    createdSids.clear();
    for (const key of touchedKeys) kvRemove(key);
    touchedKeys.clear();
    consumeMixWorldTreeOpen("__reset__");
});

describe("A · 支线数按全部后代算，番外单独计", () => {
    it("A1 根行上的支线数 = 整棵子树里除自己以外的节点数", () => {
        const a = seed({ id: `cnt_a_${rand()}` });
        const b = seed({ id: `cnt_b_${rand()}`, parentId: a.id, rootId: a.id, depth: 1 });
        seed({ id: `cnt_c_${rand()}`, parentId: a.id, rootId: a.id, depth: 1 });
        // 孙子支线：点进世界树要再下一层才看得见，列表口径必须把她算进来
        seed({ id: `cnt_d_${rand()}`, parentId: b.id, rootId: a.id, depth: 2 });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(a.id)?.branches).toBe(3);
    });

    it("A2 中间节点只数自己树下的后代，不含兄弟支线", () => {
        const a = seed({ id: `cnt2_a_${rand()}` });
        const b = seed({ id: `cnt2_b_${rand()}`, parentId: a.id, rootId: a.id });
        const c = seed({ id: `cnt2_c_${rand()}`, parentId: a.id, rootId: a.id });
        seed({ id: `cnt2_d_${rand()}`, parentId: b.id, rootId: a.id });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(b.id)?.branches).toBe(1);
        expect(stats.get(c.id)?.branches).toBe(0);
    });

    it("A3 无子支线的对局支线数为 0（角标不该显示成「0 条支线」）", () => {
        const solo = seed({ id: `cnt3_${rand()}` });
        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(solo.id)).toEqual({ branches: 0, spinoffs: 0 });
    });
});

describe("B · 番外计在来源节点，并沿父链上贡献到根", () => {
    it("B1 从支线开的番外：支线行与根行都看得见，兄弟支线看不见", () => {
        const a = seed({ id: `sp_a_${rand()}` });
        const b = seed({ id: `sp_b_${rand()}`, parentId: a.id, rootId: a.id });
        const c = seed({ id: `sp_c_${rand()}`, parentId: a.id, rootId: a.id });
        seed({
            id: `sp_x_${rand()}`,
            spinoff: { sourceId: b.id, memory: "inherit" },
        });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(b.id)).toEqual({ branches: 0, spinoffs: 1 });
        expect(stats.get(a.id)?.spinoffs).toBe(1);
        expect(stats.get(c.id)?.spinoffs).toBe(0);
        // 番外永远不进支线数——她说的是"支线"和"番外"两件事
        expect(stats.get(a.id)?.branches).toBe(2);
    });

    it("B2 同一来源开两个番外：计数相加，两种记忆模式都算番外", () => {
        const a = seed({ id: `sp2_a_${rand()}` });
        seed({ id: `sp2_x_${rand()}`, spinoff: { sourceId: a.id, memory: "inherit" } });
        seed({ id: `sp2_y_${rand()}`, spinoff: { sourceId: a.id, memory: "none" } });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(a.id)).toEqual({ branches: 0, spinoffs: 2 });
    });

    it("B3 列表行的番外抽屉按创建先后列出本棵树的番外", () => {
        const a = seed({ id: `sp3_a_${rand()}` });
        const b = seed({ id: `sp3_b_${rand()}`, parentId: a.id, rootId: a.id });
        seed({ id: `sp3_x_${rand()}`, spinoff: { sourceId: a.id, memory: "none" }, createdAt: 1_700_000_000_300 });
        seed({ id: `sp3_y_${rand()}`, spinoff: { sourceId: b.id, memory: "inherit" }, createdAt: 1_700_000_000_100 });
        seed({ id: `sp3_z_${rand()}`, spinoff: { sourceId: a.id, memory: "none" }, createdAt: 1_700_000_000_200 });

        const ids = listMixSpinoffs(loadMixSessions(), b.id).map((s) => s.id);
        // b 在树里 → 挂在 a 上的两个番外 + 挂在 b 上的一个，同属这一棵树
        expect(ids).toHaveLength(3);
        // 升序：y(100) → z(200) → x(300)
        expect(ids[0]).toContain("y");
        expect(ids[1]).toContain("z");
        expect(ids[2]).toContain("x");
    });
});

describe("C · 酒局列表只列门面局", () => {
    it("C1 支线与番外都不单独占一行，老对局照旧可见", () => {
        const root = seed({ id: `list_a_${rand()}` });
        seed({ id: `list_b_${rand()}`, parentId: root.id, rootId: root.id });
        seed({ id: `list_x_${rand()}`, spinoff: { sourceId: root.id, memory: "inherit" } });
        const legacy = seed({ id: `list_legacy_${rand()}` });

        const ids = filterMixSessionRoots(loadMixSessions()).map((s) => s.id);
        expect(ids).toHaveLength(2);
        expect(ids).toContain(root.id);
        expect(ids).toContain(legacy.id);
    });
});

describe("D · 来源已删除的番外不成为隐形数据", () => {
    it("D1 来源对局不存在时，番外归到游离组，且不计进任何行", () => {
        const a = seed({ id: `orph_a_${rand()}` });
        seed({ id: `orph_x_${rand()}`, spinoff: { sourceId: "mixsess_已被删除", memory: "inherit" } });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(a.id)?.spinoffs).toBe(0);
        const orphans = listMixOrphanSpinoffs(loadMixSessions());
        expect(orphans).toHaveLength(1);
        expect(orphans[0].spinoff?.sourceId).toBe("mixsess_已被删除");
    });
});

describe("E · 谱系数据脏了也要收敛", () => {
    it("E1 父子互指成环：计数有限、不死循环", () => {
        // 正常入口造不出环，这里模拟旧数据/外部改写
        const a = seed({ id: `loop_a_${rand()}`, parentId: `loop_b_placeholder` });
        const b = seed({ id: `loop_b_${rand()}`, parentId: a.id });
        saveMixSession({ ...a, parentId: b.id });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect((stats.get(a.id)?.branches ?? 0)).toBeLessThan(3);
        expect((stats.get(b.id)?.branches ?? 0)).toBeLessThan(3);
    });

    it("E2 番外来源互相指向另一个番外：不炸、仍算一个树里的番外", () => {
        const a = seed({ id: `chain_a_${rand()}` });
        const x = seed({ id: `chain_x_${rand()}`, spinoff: { sourceId: a.id, memory: "none" } });
        seed({ id: `chain_y_${rand()}`, spinoff: { sourceId: x.id, memory: "inherit" } });

        const stats = buildMixSessionTreeStats(loadMixSessions());
        expect(stats.get(a.id)?.spinoffs).toBe(2);
        expect(stats.get(x.id)?.spinoffs).toBe(1);
    });

    it("E3 collectMixSessionSubtreeIds 只收支线子树，不把番外算进树", () => {
        const a = seed({ id: `sub_a_${rand()}` });
        const b = seed({ id: `sub_b_${rand()}`, parentId: a.id, rootId: a.id });
        seed({ id: `sub_x_${rand()}`, spinoff: { sourceId: a.id, memory: "none" } });

        const ids = collectMixSessionSubtreeIds(loadMixSessions(), a.id);
        expect(ids.sort()).toEqual([a.id, b.id].sort());
    });
});

describe("F · 角标进对局后世界树自动展开", () => {
    it("F1 请求一次、消费一次，第二次拿不到", () => {
        const sid = `intent_${rand()}`;
        requestMixWorldTreeOpen(sid);
        expect(consumeMixWorldTreeOpen(sid)).toBe(true);
        expect(consumeMixWorldTreeOpen(sid)).toBe(false);
    });

    it("F2 请求的是别的对局时不误消费", () => {
        const sid = `intent_a_${rand()}`;
        requestMixWorldTreeOpen(sid);
        expect(consumeMixWorldTreeOpen(`intent_b_${rand()}`)).toBe(false);
        expect(consumeMixWorldTreeOpen(sid)).toBe(true);
    });

    it("F3 进不去对局时（开局失败）意图可被清掉，不会挂到下一场", () => {
        const sid = `intent_c_${rand()}`;
        requestMixWorldTreeOpen(sid);
        resetMixWorldTreeOpen();
        expect(consumeMixWorldTreeOpen(sid)).toBe(false);
    });
});

// G · 删除父支线不能让子支线消失（她批准的待办 #39）
//
// 症状：列表上的删除走 deleteMixSession，只把自己从 blob 里摘掉，孩子的 parentId
// 还指着已经不存在的父节点。世界树把"父不在"当根来画，所以树里看得见；
// 酒局列表只把 parentId 为空的当门面局，于是这局**既不在树上也不在列表里**，
// 等于玩家辛苦分出来的支线被上一级的删除弄丢了。
// 两条都要钉住：删除本身要像世界树那样把子级上提（不再制造断链）；
// 已经存在的断链（老数据）也要按根显示出来，不然她那边的孤儿支线回不来。
describe("G · 删除父支线：子上提、断链不再隐形", () => {
    it("G1 列表路径删中间节点：子支线上提挂到祖父，孙子层级下移一层", () => {
        const root = seed({ id: `del1_root_${rand()}`, depth: 0 });
        const mid = seed({ id: `del1_mid_${rand()}`, parentId: root.id, rootId: root.id, depth: 1 });
        const leaf = seed({ id: `del1_leaf_${rand()}`, parentId: mid.id, rootId: root.id, depth: 2 });

        deleteMixSession(mid.id);

        const 剩 = loadMixSessions();
        const 提上来的 = 剩.find((s) => s.id === leaf.id);
        expect(提上来的?.parentId).toBe(root.id);
        expect(提上来的?.depth).toBe(1);
        // 上提之后 leaf 回到 root 那一棵树上，列表按根只列 root 一行
        expect(filterMixSessionRoots(剩).map((s) => s.id)).toEqual([root.id]);
        expect(buildMixSessionTreeStats(剩).get(root.id)?.branches).toBe(1);
        expect(剩.some((s) => s.id === mid.id)).toBe(false);
    });

    it("G2 删的是根支线：子支线各自成根，全都回到列表门面", () => {
        const root = seed({ id: `del2_root_${rand()}` });
        const a = seed({ id: `del2_a_${rand()}`, parentId: root.id, rootId: root.id, depth: 1 });
        const b = seed({ id: `del2_b_${rand()}`, parentId: a.id, rootId: root.id, depth: 2 });

        deleteMixSession(root.id);

        const 剩 = loadMixSessions();
        // 上提一级的口径：只有被删节点的**直接子级**各自成根，孙子仍挂在自己父级下面
        // （世界树原来就是这个行为，列表路径现在与它同构）。
        expect(filterMixSessionRoots(剩).map((s) => s.id)).toEqual([a.id]);
        // a 成根后不该留着指向已删除对局的 parentId；b 跟着上提一级挂到 a
        expect(剩.find((s) => s.id === a.id)?.parentId).toBeUndefined();
        expect(剩.find((s) => s.id === a.id)?.depth).toBe(0);
        expect(剩.find((s) => s.id === b.id)?.parentId).toBe(a.id);
        expect(剩.find((s) => s.id === b.id)?.depth).toBe(1);
        // rootId 也要跟着换：原来两棵树的根就是现在这场被删掉的
        expect(剩.find((s) => s.id === a.id)?.rootId).toBe(a.id);
        expect(剩.find((s) => s.id === b.id)?.rootId).toBe(a.id);
    });

    it("G3 老数据里的断链（父早已不存在）按根显示，不再隐形", () => {
        const 早删掉的父 = `del3_gone_${rand()}`;
        const 孤儿 = seed({ id: `del3_orphan_${rand()}`, parentId: 早删掉的父, rootId: 早删掉的父 });
        seed({ id: `del3_normal_${rand()}` });

        const 门面 = filterMixSessionRoots(loadMixSessions()).map((s) => s.id);
        expect(门面).toContain(孤儿.id);
    });

    it("G4 世界树那条删除路径行为与列表一致（同一套上提逻辑）", () => {
        const root = seed({ id: `del4_root_${rand()}` });
        const mid = seed({ id: `del4_mid_${rand()}`, parentId: root.id, rootId: root.id, depth: 1 });
        const leaf = seed({ id: `del4_leaf_${rand()}`, parentId: mid.id, rootId: root.id, depth: 2 });

        deleteMixSessionBranch(mid.id);

        const 剩 = loadMixSessions();
        expect(剩.find((s) => s.id === leaf.id)?.parentId).toBe(root.id);
        expect(剩.find((s) => s.id === leaf.id)?.depth).toBe(1);
        expect(filterMixSessionRoots(剩).map((s) => s.id)).toEqual([root.id]);
    });

    it("G5 删除番外不牵连来源：来源的谱系与另一个番外都不动", () => {
        const root = seed({ id: `del5_root_${rand()}` });
        const branch = seed({ id: `del5_branch_${rand()}`, parentId: root.id, rootId: root.id });
        const spin = seed({ id: `del5_spin_${rand()}`, spinoff: { sourceId: root.id, memory: "inherit" } });
        seed({ id: `del5_spin2_${rand()}`, spinoff: { sourceId: branch.id, memory: "none" } });

        deleteMixSession(spin.id);

        const 剩 = loadMixSessions();
        expect(剩.find((s) => s.id === root.id)?.parentId).toBeUndefined();
        expect(剩.find((s) => s.id === branch.id)?.parentId).toBe(root.id);
        expect(剩.filter((s) => s.spinoff).map((s) => s.id)).toEqual([
            expect.stringContaining("del5_spin2_"),
        ]);
        expect(filterMixSessionRoots(剩).map((s) => s.id)).toEqual([root.id]);
    });
});
