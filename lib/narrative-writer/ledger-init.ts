// lib/narrative-writer/ledger-init.ts
// 执笔插件 · 台账冷启动（一次模型调用把整局剧情读成线索/伏笔台账；手动新增的最小入口）
//
// 为什么需要它（栗子的原话：真机试玩那场对局"没有任何线索或伏笔"）：
// 线索卡功能上线比她跑补抽/整理晚了两小时，而热抽每次只喂"最后一条 assistant 正文"，
// 历史内容不会被重看；记忆整理（Map-Reduce）按设计只产出记忆卡。于是长篇对局的台账永远空着，
// 九类走向里主线与伏笔回收分不到对象。这个模块补的就是"一次把整局读成台账"的入口：
// 输入只有已经存在的 L3 大纲 + 最近 2 条 L2 摘要 + 已生效记忆卡标题，产出 ≤6 条线索、≤4 条伏笔。
//
// 四条不能改的规矩：
// 1. 一次点击只调一次模型。没有大纲就一次都不调，直接让她先整理记忆。
// 2. 素材只用"确认过的东西"：待核卡标题一律不进素材。未确认的内容层层传下去，
//    最后会变成"模型自己编的东西被当成设定写回台账"。
// 3. 字段长度与人名由代码说了算：模型给什么都有上限，超了截断；
//    关联角色只认原名（人物名单里、或大纲原文里出现过的），假名字丢弃，丢光就是空数组。
// 4. 初始化产物一律待核、来源未知（不写 来源消息ID/来源轮次）：
//    没有来源 = 永不被"丢弃即归档"和回溯误伤，也永远不会自己溜进正文。
//    手动新增反过来：她填的就是结论，直接生效。

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveMixApiConfig } from "@/lib/mixology/engine";
import {
  getContextHierarchy,
  listForeshadowCards,
  listMemoryCards,
  listThreadCards,
  requireSessionId,
  saveForeshadowCard,
  saveThreadCard,
} from "./storage";
import type {
  ForeshadowCard,
  ThreadCard,
  ThreadChange,
  ThreadPlotStatus,
} from "./types";
import { normalizeThreadName } from "./threads";

// ════════════════════════════════════════════════════════════
// 常量：上限全部集中在这一处，测试直接读它们，不写第二套数字
// ════════════════════════════════════════════════════════════

/** 线索名 ≤20 字：再长就不是"线头"而是一句话了，导演上下文也放不下 */
export const THREAD_NAME_MAX = 20;
/** 下一步可能 ≤30 字：与导演上下文里的截断长度（THREAD_NEXT_STEP_MAX_CHARS）对齐 */
export const THREAD_NEXT_MAX = 30;
/** 伏笔内容 ≤40 字 */
export const FORESHADOW_CONTENT_MAX = 40;

/** 任务文本上限：大纲是唯一不可再生的输入，超限先砍记忆卡标题，大纲一个字不砍 */
export const LEDGER_TASK_MAX_CHARS = 3600;
/** 模型响应超时：一次调用最多等 60 秒，超时就算失败，不自动重试 */
export const LEDGER_TIMEOUT_MS = 60_000;
/** 素材里的已生效记忆卡标题条数（每条再截 40 字） */
export const LEDGER_MEMORY_TITLES = 12;
/** 素材里的 L2 摘要条数：只取最近 2 条，更早的已经被大纲收进去了 */
export const LEDGER_L2_RECENT = 2;
/** 单次产出上限 */
export const LEDGER_THREAD_CAP = 6;
export const LEDGER_FORESHADOW_CAP = 4;

/**
 * 初始化留下的那条变化记录：让她在台账里一眼看出这张卡是谁、凭什么写的。
 * 面板的措辞判断也认它——只有这一条变化的线，等于"建了没推过"。
 */
export const LEDGER_INIT_NOTE = "由剧情大纲初始化，未经核对";

/** 线索状态词表：初始化只接受这三个，"收束"是导演判断，不该由一次冷启动交付 */
const 可交的线索状态: ThreadPlotStatus[] = ["潜伏", "升温", "爆发"];

// ════════════════════════════════════════════════════════════
// 提示词
// ════════════════════════════════════════════════════════════

/**
 * 初始化台账的系统提示词。
 *
 * 刻意不提"待核/生效"这类审核态：入库口径由代码决定，让模型写它只会写错，
 * 还会把两个概念的边界糊掉（它以为自己在选状态，其实只是在选措辞）。
 */
const LEDGER_SYSTEM_PROMPT = `你是「剧情台账初始化器」。输入是一份全局剧情大纲和最近的章节摘要，你要从中读出这局故事里真正还悬着的大线头，交出台账初始数据。你不写正文，不做扮演，不替角色说话。

只输出一个 JSON 对象，不要解释、不要代码围栏：
{"线索":[{"名称":"短名词组","关联角色":["人物原名"],"线索状态":"潜伏|升温|爆发","下一步可能":"一句话"}],"伏笔":[{"内容":"一句话","关联线索名称":"挂在哪条线索上","揭示条件":"靠什么揭示"}]}

规则：
- 线索最多 6 条，伏笔最多 4 条。只写大纲或摘要里出现过的、到今天还没解决也没收回的事；已经解决过的事不要再写成线头。
- 要故事级的大线头（一件悬着的事），不要环境细节（一句台词、一件摆设、一处天气）。宁少勿滥，拿不准就不写，不得虚构。
- 线索状态按此刻的紧迫感给：没人察觉=潜伏，已经摆到台面上=升温，正在正面冲突=爆发。不许写收束，收不收由导演判断。
- 关联角色必须使用人物名单或大纲里的原名，不得自造绰号、代号或简称；不确定是谁就留空数组。
- 名称不超过 20 字，下一步可能不超过 30 字，伏笔内容不超过 40 字。名称用名词短语，不要写成句子。`;

/** 这条提示词多长，汇报时要用；也让改词的人一眼看到有没有写飞 */
export const LEDGER_SYSTEM_PROMPT_CHARS = LEDGER_SYSTEM_PROMPT.length;

// ════════════════════════════════════════════════════════════
// 任务文本
// ════════════════════════════════════════════════════════════

export interface LedgerTaskInput {
  /** L3 全局大纲全文：唯一不可再生的输入 */
  大纲: string;
  /** 最近若干条 L2 章节摘要正文 */
  L2摘要: string[];
  /** 已生效记忆卡标题（代码侧已截到 40 字） */
  记忆卡标题: string[];
  /** 台账里已有的线索名，用于判重 */
  已有线索名称: string[];
  /** 台账里已有的伏笔内容，用于判重 */
  已有伏笔名称: string[];
  当前角色名: string;
  玩家名: string;
  /** 允许使用的人名原名名单 */
  人物名单: string[];
  当前轮次: number;
}

function 字符串列表(原始值: unknown): string[] {
  if (!Array.isArray(原始值)) return [];
  return 原始值
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function 截断(文本: unknown, 上限: number): string {
  return typeof 文本 === "string" ? 文本.trim().slice(0, 上限) : "";
}

/**
 * 拼任务文本。
 *
 * 超限时的砍法只有一种：从尾巴上一条条丢记忆卡标题。
 * 大纲是唯一不可再生的输入（它没了这次冷启动就没有意义），L2 摘要只有 2 条、
 * 人名名单几百字，都不值得为它们牺牲标题之外的东西；标题本来就是"锦上添花"的辅助素材。
 */
export function buildLedgerInitTask(input: LedgerTaskInput): string {
  const 大纲 = typeof input.大纲 === "string" ? input.大纲.trim() : "";
  const L2 = 字符串列表(input.L2摘要).slice(-LEDGER_L2_RECENT);
  const 名单 = 字符串列表(input.人物名单).slice(0, 20);

  // 标题先按条数上限收一遍，再按字符上限做"逐条丢弃"
  const 全部标题 = 字符串列表(input.记忆卡标题)
    .map((t) => t.slice(0, 40))
    .slice(0, LEDGER_MEMORY_TITLES);

  const 拼 = (标题: string[]) =>
    JSON.stringify({
      当前角色名: input.当前角色名 ?? "",
      玩家名: input.玩家名 ?? "",
      当前轮次: input.当前轮次 ?? 0,
      人物名单: 名单,
      全局剧情大纲: 大纲,
      最近章节摘要: L2,
      已确认的记忆卡标题: 标题,
      已有线索名称: 字符串列表(input.已有线索名称).slice(0, 20),
      已有伏笔名称: 字符串列表(input.已有伏笔名称).slice(0, 12),
    });

  let 标题 = 全部标题;
  let 文本 = 拼(标题);
  while (文本.length > LEDGER_TASK_MAX_CHARS && 标题.length > 0) {
    标题 = 标题.slice(0, -1);
    文本 = 拼(标题);
  }
  return 文本;
}

// ════════════════════════════════════════════════════════════
// 解析模型返回
// ════════════════════════════════════════════════════════════

type RawThread = {
  名称?: unknown;
  关联角色?: unknown;
  线索状态?: unknown;
  下一步可能?: unknown;
};
type RawForeshadow = {
  内容?: unknown;
  关联线索名称?: unknown;
  揭示条件?: unknown;
};

/**
 * 把模型输出读成 {线索, 伏笔}。读不出来就给空数组，绝不抛错——
 * 抛错会让"这一批一条都没入库"变成"整次初始化崩在半路"。
 */
export function parseLedgerInit(raw: unknown): {
  线索: RawThread[];
  伏笔: RawForeshadow[];
} {
  const 空 = { 线索: [] as RawThread[], 伏笔: [] as RawForeshadow[] };
  if (typeof raw !== "string" || !raw.trim()) return 空;

  // 去掉模型爱套的代码围栏：合法 JSON 只多了首尾两行反引号，不该因此作废
  const 净文 = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let 解析: unknown;
  try {
    解析 = JSON.parse(净文);
  } catch {
    return 空;
  }

  // 顶层写成数组（只有线索）也算收下，别把一次成功的调用浪费在格式上
  const 对象 = Array.isArray(解析) ? { 线索: 解析, 伏笔: [] } : 解析;
  if (!对象 || typeof 对象 !== "object") return 空;

  const 线索 = (Array.isArray((对象 as { 线索?: unknown }).线索)
    ? (对象 as { 线索: unknown[] }).线索
    : []
  ).filter((v): v is RawThread => !!v && typeof v === "object");
  const 伏笔 = (Array.isArray((对象 as { 伏笔?: unknown }).伏笔)
    ? (对象 as { 伏笔: unknown[] }).伏笔
    : []
  ).filter((v): v is RawForeshadow => !!v && typeof v === "object");

  return {
    线索: 线索.slice(0, LEDGER_THREAD_CAP),
    伏笔: 伏笔.slice(0, LEDGER_FORESHADOW_CAP),
  };
}

/** 线索状态：词表外（含"收束"和瞎写的）一律退回潜伏 */
function 合法线索状态(原始值: unknown): ThreadPlotStatus {
  return 可交的线索状态.includes(原始值 as ThreadPlotStatus)
    ? (原始值 as ThreadPlotStatus)
    : "潜伏";
}

// ════════════════════════════════════════════════════════════
// 初始化台账
// ════════════════════════════════════════════════════════════

export interface LedgerInitInput {
  sessionId: string;
  /** 当前角色名：素材里的人名名单与"关联角色"白名单都认它 */
  当前角色名?: string;
  玩家名?: string;
  /** 当前轮次，写进 上次推进轮次 与变化记录 */
  当前轮次?: number;
  /**
   * 这次调用最多等多久，默认 LEDGER_TIMEOUT_MS（60 秒）。
   * 留成参数是为了让"超时"这条分支在测试里真的能跑到（等 60 秒不现实），
   * 也是为了面板将来在慢模型上给它更多时间——不改默认值就不改产品口径。
   */
  超时Ms?: number;
}

export interface LedgerInitResult {
  /**
   * 本次模型输出对应的台账卡：新建的 + 同名命中的已有卡。
   * 带上已有卡是有意的——面板要能回答"这次读出来的东西对应台账里的哪几张"，
   * 同名不覆盖时那张旧卡就是答案；"到底新建了几张"看 提示 与 跳过。
   */
  线索: ThreadCard[];
  伏笔: ForeshadowCard[];
  /** 没新建的条目数：同名重复 + 空名称/空内容 */
  跳过: { 线索: number; 伏笔: number };
  /** 本次真正发出的模型请求数：无大纲、被连点拒掉时必须为 0 */
  调用次数: number;
  提示?: string;
  失败?: boolean;
}

/**
 * 模块级互斥：同一时间只允许一次初始化。
 * 不按 sessionId 分开，是因为付费调用是按"人点了几下"算钱的，
 * 她连点三次就是三次钱，跟点的是哪个会话无关。
 */
let 正在初始化 = false;

/** 给面板用的只读探针：按钮该不该禁用（面板的 state 与这里的互斥不一定同步） */
export function isLedgerInitializing(): boolean {
  return 正在初始化;
}

function 失败结果(提示: string, 调用次数 = 0): LedgerInitResult {
  return { 线索: [], 伏笔: [], 跳过: { 线索: 0, 伏笔: 0 }, 调用次数, 提示, 失败: true };
}

/** 一次调用 + 超时。超时不重试、不 cancel 后重发，直接算失败。 */
async function 调用模型(task: string, 超时Ms: number): Promise<string> {
  const apiConfig = resolveMixApiConfig();
  if (!apiConfig) {
    throw new Error("未配置API接口，请先在设置中添加API配置");
  }
  const messages: LLMMessage[] = [
    { role: "system", content: LEDGER_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  const 请求 = sendLLMRequest(
    apiConfig,
    null,
    messages,
    [],
    { characterName: "台账初始化器" },
    { appId: "narrative-ledger-init", includeReasoning: false }
  );
  const 超时 = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), 超时Ms);
  });
  try {
    return await Promise.race([请求, 超时]);
  } catch (err) {
    // 请求本身可能在超时之后才失败，挂个 catch 免得变成未处理的 rejection
    void Promise.resolve(请求).catch(() => {});
    throw err;
  }
}

/** 拼好的这次调用长什么样：面板要在点下去之前把真实字数告诉她 */
export interface LedgerPreparation {
  大纲: string;
  当前角色名: string;
  玩家名: string;
  当前轮次: number;
  任务文本: string;
  已有线索: ThreadCard[];
  已有伏笔: ForeshadowCard[];
  /** 人名白名单判定，入库时还要用它挡一次自造绰号 */
  认识这个人: (名: string) => boolean;
}

/**
 * 把"这次要给模型什么"拼出来。
 *
 * 初始化与面板的字数预估走同一个函数：确认框里写的字数就是真正发出去的字数，
 * 不是拍脑袋的约数。返回 null = 没有大纲，这一次根本不该调模型。
 */
export async function prepareLedgerTask(
  input: LedgerInitInput
): Promise<LedgerPreparation | null> {
  const sid = requireSessionId(input.sessionId, "prepareLedgerTask");
  const 当前角色名 = (input.当前角色名 ?? "").trim();
  const 玩家名 = (input.玩家名 ?? "").trim();
  const 当前轮次 =
    typeof input.当前轮次 === "number" && Number.isFinite(input.当前轮次)
      ? Math.max(0, Math.floor(input.当前轮次))
      : 0;

  const hierarchy = await getContextHierarchy(sid);
  const 大纲 = (hierarchy?.L3_全局大纲 ?? "").trim();
  if (!大纲) return null;

  const [生效卡, 已有线索, 已有伏笔] = await Promise.all([
    // 素材只用确认过的东西：待核卡一张都不进任务文本
    listMemoryCards(sid, { status: "生效" }),
    listThreadCards(sid),
    listForeshadowCards(sid),
  ]);

  // 人名白名单：角色名 + 玩家名 + 已有线索里用过的名字，
  // 再加"大纲原文里出现过的那串字"——冷启动没有稳定的人名标注，
  // 但要求模型用原名，它给的名字要么在名单里、要么在大纲里，两头都不是就是自造的。
  const 名单 = Array.from(
    new Set(
      [当前角色名, 玩家名, ...已有线索.flatMap((t) => t.关联角色 ?? [])]
        .map((n) => (n ?? "").trim())
        .filter(Boolean)
    )
  );
  const 认识这个人 = (名: string) =>
    名单.includes(名) || 大纲.includes(名);

  const 任务文本 = buildLedgerInitTask({
    大纲,
    L2摘要: (hierarchy?.L2_章节摘要 ?? []).map((l) => l.summary),
    记忆卡标题: 生效卡.map((c) => c.内容),
    已有线索名称: 已有线索.filter((t) => t.状态 !== "归档").map((t) => t.名称),
    已有伏笔名称: 已有伏笔
      .filter((f) => f.状态 !== "归档" && f.伏笔状态 !== "已收")
      .map((f) => f.内容),
    当前角色名,
    玩家名,
    人物名单: 名单,
    当前轮次,
  });

  return { 大纲, 当前角色名, 玩家名, 当前轮次, 任务文本, 已有线索, 已有伏笔, 认识这个人 };
}

/**
 * 一次 LLM 调用把整局剧情读成线索/伏笔台账。
 *
 * 流程：读大纲 → 没大纲直接返回"请先整理记忆"（不调模型）→ 拼素材 → 一次调用 →
 * 逐条校验（截断、人名白名单、判重）→ 以待核入库。
 * 全程不抛错：任何一步出问题都返回 {失败, 提示}，由面板显示中文提示。
 */
export async function initThreadLedgerFromOutline(
  input: LedgerInitInput
): Promise<LedgerInitResult> {
  // 互斥要在任何 await 之前置位，否则连点的那几次都来不及被拦住
  if (正在初始化) {
    return {
      线索: [],
      伏笔: [],
      跳过: { 线索: 0, 伏笔: 0 },
      调用次数: 0,
      提示: "上一次台账初始化正在进行，请等它结束再点",
    };
  }
  正在初始化 = true;

  try {
    const sid = requireSessionId(input.sessionId, "initThreadLedgerFromOutline");
    const 准备 = await prepareLedgerTask(input);
    if (!准备) {
      return {
        线索: [],
        伏笔: [],
        跳过: { 线索: 0, 伏笔: 0 },
        调用次数: 0,
        提示: "请先整理记忆，生成剧情大纲后再初始化台账",
      };
    }
    const { 当前轮次, 已有线索, 已有伏笔, 认识这个人 } = 准备;

    const 超时Ms =
      typeof input.超时Ms === "number" && Number.isFinite(input.超时Ms) && input.超时Ms > 0
        ? input.超时Ms
        : LEDGER_TIMEOUT_MS;

    let 原始输出: string;
    try {
      原始输出 = await 调用模型(准备.任务文本, 超时Ms);
    } catch (err) {
      const 消息 = err instanceof Error ? err.message : "";
      if (消息.includes("未配置API")) {
        // 请求根本没发出去，一次都不该记
        return 失败结果("未配置 API 接口，请先在设置里添加接口配置", 0);
      }
      // 请求已经发出去了，钱可能已经花了，次数照实记
      return 失败结果(
        消息 === "TIMEOUT"
          ? `模型响应超时（${Math.round(超时Ms / 1000)} 秒），本次没有写入台账，可以再点一次`
          : "模型调用失败，本次没有写入台账，可以再点一次",
        1
      );
    }

    const 解析 = parseLedgerInit(原始输出);
    if (解析.线索.length === 0 && 解析.伏笔.length === 0) {
      return 失败结果(
        "模型这次没有返回能读的台账数据，一条都没写入，可以再点一次",
        1
      );
    }

    const 现在 = Date.now();
    const 新建线索: ThreadCard[] = [];
    const 新建伏笔: ForeshadowCard[] = [];
    let 写入线索 = 0;
    let 写入伏笔 = 0;
    let 跳过线索 = 0;
    let 跳过伏笔 = 0;

    // 判重复用台账那套归一化名称规则，并且建一份内存索引：
    // 模型连着吐同名条目时，回库读会读到旧值，本地索引边写边更新才拦得住。
    const 线索索引 = new Map<string, ThreadCard>();
    for (const t of 已有线索) {
      if (t.状态 === "归档") continue;
      const key = normalizeThreadName(t.名称);
      if (key && !线索索引.has(key)) 线索索引.set(key, t);
    }
    const 伏笔索引 = new Map<string, ForeshadowCard>();
    for (const f of 已有伏笔) {
      if (f.状态 === "归档" || f.伏笔状态 === "已收") continue;
      const key = normalizeThreadName(f.内容);
      if (key && !伏笔索引.has(key)) 伏笔索引.set(key, f);
    }

    for (const 项 of 解析.线索) {
      const 名称 = 截断(项.名称, THREAD_NAME_MAX);
      const key = normalizeThreadName(名称);
      if (!名称 || !key) {
        // 空名称既进不了台账，也没法判重，只能丢
        跳过线索 += 1;
        continue;
      }
      const 已存在 = 线索索引.get(key);
      if (已存在) {
        // 同名不覆盖：已有卡的状态、剧情态、变化记录都是玩家或回写攒下来的，
        // 一次冷启动没有权力改它
        跳过线索 += 1;
        if (!新建线索.includes(已存在)) 新建线索.push(已存在);
        continue;
      }

      const 关联角色 = 字符串列表(项.关联角色)
        .map((n) => n.slice(0, 20))
        .filter(认识这个人);
      const 变化: ThreadChange = {
        变化: LEDGER_INIT_NOTE,
        轮次: 当前轮次,
        时间: 现在,
      };
      const card: ThreadCard = {
        id: `th_ledger_${现在.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "thread",
        名称,
        线索状态: 合法线索状态(项.线索状态),
        关联角色,
        上次推进轮次: 当前轮次,
        下一步可能: 截断(项.下一步可能, THREAD_NEXT_MAX),
        最近变化: [变化],
        // 待核：这条线是不是真的大线头，得她点头才算数；只进导演上下文，永不进正文
        状态: "待核",
        // 不写 来源消息ID / 来源轮次：来源未知才不会被回溯与"丢弃即归档"触碰
        audience: ["all"],
        createdAt: 现在,
        updatedAt: 现在,
      };
      await saveThreadCard(sid, card);
      线索索引.set(key, card);
      新建线索.push(card);
      写入线索 += 1;
    }

    for (const 项 of 解析.伏笔) {
      const 内容 = 截断(项.内容, FORESHADOW_CONTENT_MAX);
      const key = normalizeThreadName(内容);
      if (!内容 || !key) {
        跳过伏笔 += 1;
        continue;
      }
      const 已存在 = 伏笔索引.get(key);
      if (已存在) {
        跳过伏笔 += 1;
        if (!新建伏笔.includes(已存在)) 新建伏笔.push(已存在);
        continue;
      }

      const 关联线索名称 = 截断(项.关联线索名称, THREAD_NAME_MAX);
      const card: ForeshadowCard = {
        id: `fs_ledger_${现在.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "foreshadow",
        内容,
        埋下轮次: 当前轮次,
        预期回收窗口: { 起: 当前轮次, 止: 当前轮次 + 10 },
        伏笔状态: "未收",
        // 空的关联线索不写成空字符串：读侧会把它当成"挂了"再判一次空
        关联线索名称: 关联线索名称 || undefined,
        揭示条件: 截断(项.揭示条件, 40) || undefined,
        状态: "待核",
        audience: ["all"],
        createdAt: 现在,
        updatedAt: 现在,
      };
      await saveForeshadowCard(sid, card);
      伏笔索引.set(key, card);
      新建伏笔.push(card);
      写入伏笔 += 1;
    }

    const 提示 = `已写入 ${写入线索} 条线索、${写入伏笔} 条伏笔，都标为待核，请在记忆审核里核对${
      跳过线索 + 跳过伏笔 > 0
        ? `；另有 ${跳过线索 + 跳过伏笔} 条因为同名或没有名称被跳过`
        : ""
    }`;
    return {
      线索: 新建线索,
      伏笔: 新建伏笔,
      跳过: { 线索: 跳过线索, 伏笔: 跳过伏笔 },
      调用次数: 1,
      提示,
    };
  } catch (err) {
    console.error("[NarrativeWriter] 台账初始化失败:", err);
    return 失败结果("台账初始化失败，本次没有写入台账");
  } finally {
    正在初始化 = false;
  }
}

// ════════════════════════════════════════════════════════════
// 手动新增（待办 #36 的最小表单）
// ════════════════════════════════════════════════════════════

export interface ManualThreadInput {
  sessionId: string;
  名称: string;
  关联角色?: string[];
  下一步可能?: string;
  线索状态?: string;
  当前轮次?: number;
}

export interface ManualForeshadowInput {
  sessionId: string;
  内容: string;
  关联线索名称?: string;
  揭示条件?: string;
  当前轮次?: number;
}

export interface ManualResult<T> {
  ok: boolean;
  卡?: T;
  提示?: string;
}

/**
 * 手动新增一条线索：直接生效。
 *
 * 与初始化的区别是有意的——初始化是"模型猜的"，所以要待核；
 * 手动填的是她自己定的结论，再压一层待核只会变成"填完了还得去审核里点一次"。
 */
export async function createManualThread(
  input: ManualThreadInput
): Promise<ManualResult<ThreadCard>> {
  const sid = requireSessionId(input.sessionId, "createManualThread");
  const 名称 = 截断(input.名称, THREAD_NAME_MAX);
  const key = normalizeThreadName(名称);
  if (!名称 || !key) {
    return { ok: false, 提示: "线索名称不能为空" };
  }

  const 已有 = await listThreadCards(sid);
  if (
    已有.some((t) => t.状态 !== "归档" && normalizeThreadName(t.名称) === key)
  ) {
    return { ok: false, 提示: "台账里已经有一条同名线索了" };
  }

  const 现在 = Date.now();
  const 轮次 =
    typeof input.当前轮次 === "number" && Number.isFinite(input.当前轮次)
      ? Math.max(0, Math.floor(input.当前轮次))
      : 0;
  const card: ThreadCard = {
    id: `th_manual_${现在.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "thread",
    名称,
    线索状态: 合法线索状态(input.线索状态),
    关联角色: 字符串列表(input.关联角色)
      .map((n) => n.slice(0, 20))
      // 手填的名字不做白名单：这就是她写的原名
      .filter(Boolean),
    上次推进轮次: 轮次,
    下一步可能: 截断(input.下一步可能, THREAD_NEXT_MAX),
    最近变化: [],
    状态: "生效",
    audience: ["all"],
    createdAt: 现在,
    updatedAt: 现在,
  };
  await saveThreadCard(sid, card);
  return { ok: true, 卡: card, 提示: "已新增线索" };
}

/** 手动新增一条伏笔：同样直接生效 */
export async function createManualForeshadow(
  input: ManualForeshadowInput
): Promise<ManualResult<ForeshadowCard>> {
  const sid = requireSessionId(input.sessionId, "createManualForeshadow");
  const 内容 = 截断(input.内容, FORESHADOW_CONTENT_MAX);
  const key = normalizeThreadName(内容);
  if (!内容 || !key) {
    return { ok: false, 提示: "伏笔内容不能为空" };
  }

  const 已有 = await listForeshadowCards(sid);
  if (
    已有.some(
      (f) =>
        f.状态 !== "归档" &&
        f.伏笔状态 !== "已收" &&
        normalizeThreadName(f.内容) === key
    )
  ) {
    return { ok: false, 提示: "台账里已经有一个同名伏笔了" };
  }

  const 现在 = Date.now();
  const 轮次 =
    typeof input.当前轮次 === "number" && Number.isFinite(input.当前轮次)
      ? Math.max(0, Math.floor(input.当前轮次))
      : 0;
  const 关联线索名称 = 截断(input.关联线索名称, THREAD_NAME_MAX);
  const card: ForeshadowCard = {
    id: `fs_manual_${现在.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "foreshadow",
    内容,
    埋下轮次: 轮次,
    预期回收窗口: { 起: 轮次, 止: 轮次 + 10 },
    伏笔状态: "未收",
    关联线索名称: 关联线索名称 || undefined,
    揭示条件: 截断(input.揭示条件, 40) || undefined,
    状态: "生效",
    audience: ["all"],
    createdAt: 现在,
    updatedAt: 现在,
  };
  await saveForeshadowCard(sid, card);
  return { ok: true, 卡: card, 提示: "已新增伏笔" };
}

// ════════════════════════════════════════════════════════════
// 面板措辞（纯函数，只影响显示）
// ════════════════════════════════════════════════════════════

/**
 * 线索卡上那行轮次措辞。
 *
 * 为什么要单独判：初始化出来的线索，`上次推进轮次` 记的是**建立**它的那一轮，
 * 最近变化里只有「由剧情大纲初始化」一条——它压根没被推进过。面板照着这个数字
 * 写"第 N 轮推进"，看上去就像这条线已经走了 N 轮，是误导。
 *
 * 判据用"有没有一条不是初始化记录的变化"：初始化时写的那条本来就带这个原文，
 * 而任何真实推进（回写、手动升级）都是另一句话。手动新建的卡一条变化都没有，
 * 同样算"尚未推进"——这也符合事实。排序逻辑不读这里，仍然按 上次推进轮次 排。
 */
export function 线索进度文案(card: {
  上次推进轮次?: number;
  最近变化?: Array<{ 变化?: string }>;
}): string {
  const 推进过的变化 = (card.最近变化 ?? []).filter(
    (c) => (c?.变化 ?? "").trim() !== LEDGER_INIT_NOTE
  );
  const 轮次 = Number.isFinite(card.上次推进轮次)
    ? Math.max(0, Math.floor(card.上次推进轮次 ?? 0))
    : 0;
  return 推进过的变化.length > 0
    ? `第 ${轮次} 轮推进`
    : `建于第 ${轮次} 轮·尚未推进`;
}
