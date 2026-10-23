import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvRemove } from "@/lib/kv-db";
import { listMemoryCards, purgeNarrativeSessionData } from "@/lib/narrative-writer/storage";
import { writeWithSelectedBanner } from "@/lib/narrative-writer/writer";

// 引擎与对局/酒柜存储：本文件是**唯一**真 import `mixology/engine` 的测试文件（按约束 4）。
// 抽取、盖来源、落库、归档、重说、继续生成全部走真实实现。
// 只 mock 两处：① LLM 调用入口 sendLLMRequest；② settings-storage 的 API 配置读取
// （resolveMixApiConfig 在 Node 里被 typeof window 守卫短路恒为 null，不补这一处抽取根本不会发生）。
import { continueMix, insertNarrativeTurn, rerollMixReply } from "@/lib/mixology/engine";
import { getMixSession, saveMixMaterial, saveMixSession } from "@/lib/mixology/storage";
import type { MixMaterial, MixSession, MixTurn } from "@/lib/mixology/types";

// 「执笔生成的回复也带来源」（待办 #25）
//
// 覆盖什么：
//   A 一次「选定报幕生成正文」只触发一次抽取（按 LLM 调用次数断言）；
//   B 落库的每张卡都带这条回复的 来源消息ID / 来源轮次（一张都不许来源未知）；
//   C 对这条执笔回复点「重说」端到端：旧回复的卡全部归档并写明原因、生效集合里不留无源卡、
//     新回复的卡挂在新消息 id 上生效（顺带把"引擎重说路径是否调用 onTurnsDiscarded"也纳入自动覆盖）；
//   D 继续生成（纯追加）不归档任何卡——防回归，本条从一开始就应该是绿的。
//
// 红只能红在"一次点击抽了两次、多出来的那张没有来源"，不能红在环境没搭好：
// 所以 A 先断言正文生成与抽取确实各发生过，配置没接通时那里先炸，一眼能分假红与功能红。
//
// 落盘后重读、浏览器里真机点重说属「未覆盖，需手动确认」，见 tests/MANUAL_CHECKLIST.md 3.11。

const llm = vi.hoisted(() => ({
  byKind: {} as Record<string, number>,
  order: [] as string[],
  extractorSeq: 0,
}));

const CHAR_NAME = "探针角色";
const 报幕 = "（基调：自主｜场景：灯塔｜走向：靠近）";

/** 定长填充文本：把最近 4 轮的字数顶过 runMixGeneration 的 2000 字阈值，重说后必定触发一次抽取 */
function filler(tag: string, len: number): string {
  const unit = "海风把灯塔的光一遍遍扫过水面，";
  return (tag + "：" + unit.repeat(Math.ceil(len / unit.length) + 1)).slice(0, len);
}

vi.mock("@/lib/chat-engine", () => ({
  sendLLMRequest: async (_c: any, _p: any, _m: any, _r: any, meta?: any) => {
    const kind = meta?.characterName ?? "unknown";
    llm.order.push(kind);
    llm.byKind[kind] = (llm.byKind[kind] ?? 0) + 1;
    if (kind === "Extractor") {
      // 每次抽取给一条不同内容的卡，好把"哪张卡出自哪一次抽取"分清楚
      llm.extractorSeq += 1;
      return JSON.stringify([
        {
          kind: "memory",
          主体: "角色",
          主类型: "经历节点",
          内容: `第 ${llm.extractorSeq} 次抽取提到的灯塔`,
          作用域: "戏内层",
          置信档: "高",
          置信度: 0.9,
          状态: "生效",
          时间: "",
          证据: "角色望向灯塔",
        },
      ]);
    }
    if (kind === "NarrativeWriter") {
      return `${报幕}\n\n${filler("正文", 700)}`;
    }
    // 特调正常回复那条链（重说 / 继续生成）按角色名调用
    return filler("角色的新回复", 700);
  },
}));

vi.mock("@/lib/settings-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings-storage")>();
  return {
    ...actual,
    loadApiConfigs: () => [{ id: "probe-api", name: "探针接口", apiKey: "x", baseUrl: "x" } as any],
    loadBindingConfig: () => ({ globalDefaults: { apiConfigId: "probe-api" } } as any),
  };
});

const createdSids = new Set<string>();
const touchedKeys = new Set<string>();

function rand(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 两处热抽都是 setTimeout(0) 之后还要跑若干 await，给足时间让它们落地 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

function makeTurns(rounds: number): MixTurn[] {
  const base = 1_700_000_000_000;
  const turns: MixTurn[] = [];
  for (let i = 1; i <= rounds; i += 1) {
    turns.push({ id: `ge_u_${i}_${rand()}`, role: "user", text: filler(`玩家第 ${i} 轮`, 620), createdAt: base + i * 2 });
    turns.push({ id: `ge_a_${i}_${rand()}`, role: "assistant", text: filler(`角色第 ${i} 轮`, 620), createdAt: base + i * 2 + 1 });
  }
  return turns;
}

/** 搭一场「有角色材料、2 轮历史」的对局 */
async function seedSession(tag: string): Promise<MixSession> {
  const sid = `testgen_${tag}_${rand()}`;
  createdSids.add(sid);
  const now = 1_700_000_000_000;

  const character = {
    id: `gen_char_${rand()}`,
    kind: "character",
    name: CHAR_NAME,
    charName: CHAR_NAME,
    profileMode: "freeform",
    profileText: "## 性格\n沉默寡言的守塔人。",
    worldText: "## 当前剧情\n海边灯塔。",
    openings: ["海风把灯塔的光扫过来。"],
    builtin: false,
    createdAt: now,
    updatedAt: now,
  } as unknown as MixMaterial;
  saveMixMaterial(character);
  touchedKeys.add("mixology_cabinet_v1");

  const session: MixSession = {
    id: sid,
    recipe: {
      id: `recipe_${sid}`,
      name: "执笔来源测试配方",
      slots: { character: [{ materialId: character.id }] },
      createdAt: now,
      updatedAt: now,
    },
    charName: CHAR_NAME,
    openingIndex: 0,
    turns: makeTurns(2),
    createdAt: now,
    updatedAt: now,
  };
  saveMixSession(session);
  touchedKeys.add("mixology_sessions_v1");
  return session;
}

/** 复现面板「选定报幕生成正文」那条链：生成 → 插入对话 */
async function generateAndInsert(sid: string): Promise<MixSession> {
  const result = await writeWithSelectedBanner(
    {
      sessionId: sid,
      characterProfile: { charName: CHAR_NAME, profileText: "沉默寡言的守塔人。", worldText: "海边灯塔。" } as any,
      worldSettings: { preface: "", basePrompts: [], flavorPrompts: [], glassPrompts: [], strengthPrompts: [] },
      recentDialogue: "",
    },
    报幕
  );
  const updated = await insertNarrativeTurn(sid, result.body, result.banner);
  await settle();
  return updated;
}

async function cardsOf(sid: string): Promise<any[]> {
  return (await listMemoryCards(sid)) as any[];
}

/** 会话里最后一条 assistant 消息的 id（直读存储，不经引擎） */
function lastAssistantId(sid: string): string | null {
  const current = getMixSession(sid);
  if (!current) return null;
  const last = [...current.turns].reverse().find((t) => t.role === "assistant");
  return last?.id ?? null;
}

beforeEach(() => {
  llm.byKind = {};
  llm.order = [];
  llm.extractorSeq = 0;
});

afterEach(() => {
  for (const sid of createdSids) purgeNarrativeSessionData(sid);
  for (const key of touchedKeys) kvRemove(key);
  createdSids.clear();
  touchedKeys.clear();
});

describe("执笔生成的正文只抽一次，且带来源", () => {
  it("A. 一次「选定报幕生成」= 1 次正文生成 + 1 次抽取", async () => {
    const session = await seedSession("once");
    await generateAndInsert(session.id);

    // 前置：链路真的通了（环境性假红会先在这里炸，不会伪装成功能红）
    expect(llm.byKind.NarrativeWriter).toBe(1);
    expect(llm.byKind.Extractor).toBeGreaterThanOrEqual(1);
    // 本用例：抽取只许一次
    expect(llm.byKind.Extractor).toBe(1);
  });

  it("B. 落库的每张卡都带这条回复的来源消息ID与来源轮次", async () => {
    const session = await seedSession("source");
    const updated = await generateAndInsert(session.id);
    const 新消息ID = updated.turns[updated.turns.length - 1].id;
    const 轮次 = updated.turns.filter((t) => t.role === "assistant").length;
    expect(轮次).toBe(3);

    const cards = await cardsOf(session.id);
    // 一次抽取 → 一张卡；抽两次就会落两张同主题的卡进召回池
    expect(cards.length).toBe(1);
    const 没有正确来源的 = cards.filter((c) => c.来源消息ID !== 新消息ID);
    expect(没有正确来源的.map((c) => c.内容)).toEqual([]);
    expect(cards[0].来源轮次).toBe(轮次);
  });

  it("C. 对执笔回复点重说：旧回复的卡归档、新回复的卡生效", async () => {
    const session = await seedSession("reroll");
    const updated = await generateAndInsert(session.id);
    const 执笔回复ID = updated.turns[updated.turns.length - 1].id;
    const 执笔卡 = (await cardsOf(session.id)).filter((c) => c.来源消息ID === 执笔回复ID);
    // 前置：执笔回复至少留下一张带来源的卡，否则"C 归档了什么"无从谈起
    expect(执笔卡.length).toBeGreaterThanOrEqual(1);

    await rerollMixReply(session.id);
    await settle();

    const all = await cardsOf(session.id);
    const 生效 = all.filter((c) => c.状态 === "生效");
    const 归档 = all.filter((c) => c.状态 === "归档");
    const 新回复ID = lastAssistantId(session.id);

    // 引擎的重说路径确实把这条回复的卡作废了（不需要测试自己调 onTurnsDiscarded）
    expect(归档.length).toBeGreaterThanOrEqual(1);
    for (const c of 执笔卡) {
      const now = all.find((x) => x.id === c.id);
      expect(now!.状态).toBe("归档");
      expect(now!.归档原因).toContain("重说");
    }
    // 生效集合里一张"来源未知"的卡都不许留——那正是重说追不到的漏网卡
    expect(生效.filter((c) => !c.来源消息ID).map((c) => c.内容)).toEqual([]);
    // 新回复的卡照常生效，且挂在新的那条消息 id 上
    expect(新回复ID).toBeTruthy();
    expect(生效.length).toBeGreaterThanOrEqual(1);
    for (const c of 生效) expect(c.来源消息ID).toBe(新回复ID);
  });

  it("D. 继续生成（纯追加）不归档任何卡", async () => {
    const session = await seedSession("append");
    await generateAndInsert(session.id);
    const 之前 = await cardsOf(session.id);

    await continueMix(session.id);
    await settle();

    const 现在 = await cardsOf(session.id);
    for (const c of 之前) {
      expect(现在.find((x) => x.id === c.id)!.状态).toBe(c.状态);
    }
    expect(现在.filter((c) => c.状态 === "归档").length).toBe(0);
  });
});
