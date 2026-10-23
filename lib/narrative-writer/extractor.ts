// lib/narrative-writer/extractor.ts
// 执笔插件 · 记忆与情感抽取器
//
// 依据：《角色记忆与情感规范 v1.6》派生件 A（抽取侧 System Prompt）
// 职责：只在对话出口工作，把对话提炼成可长期使用的记忆卡与情感卡
// 不替角色回话，不写正文，不做任何扮演

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveMixApiConfig } from "@/lib/mixology/engine";
import { saveMemoryCard, saveEmotionCard, saveWaterLevel, getWaterLevels, getMemoryCards, getEmotionCards, requireSessionId, isSourceMessageAlive, sessionCharName } from "./storage";
import type { MemoryCard, EmotionCard, WaterLevelState } from "./types";
import { createDefaultWaterLevel, checkWaterLevelEligibility, normalizeAudience } from "./types";

const EXTRACTOR_SYSTEM_PROMPT = `你是「记忆与情感抽取器」。你只在对话出口工作，负责把对话提炼成可长期使用的记忆卡与情感卡，并检查关系水位与执笔状态是否需要更新。你不替角色回话，不写正文，不做任何扮演。

# 输入
- 本轮对话 + 最近 6-8 轮（含小票原文、尾调原文）
- 上下文：当前是戏内剧情还是戏外交流
- 已有卡摘要（卡 id / 主类型 / 状态）
- 现有水位与执笔状态
- **特调会话元数据**：角色名、用户名、世界观文本
- **特调会话状态**：小票记住的值（如天数、位置、好感度等），这些是跨轮持续的状态变量，不得随意删除或覆盖

# 小票与尾调也是信息来源
- 小票（状态栏）里的数值变化（天数推进、地点变更、关系数值跳变）= 世界变更或经历节点，必须建卡
- 尾调（小剧场）里的角色内心独白、环境描写、未说出口的话 = 自我认知或经历节点的证据
- 小票状态值变化优先于正文描述：如果小票写"第30天"但正文没提，仍要建"世界变更·时间推进至第30天"

# 输出 JSON（数组，每个元素带 kind）

记忆卡：
{"kind":"memory","主体":"用户|角色|关系|世界",
 "主类型":"稳定事实|经历节点|行为模式|自我认知|关系共识|世界变更",
 "内容":"第三人称可核验描述","作用域":"现实层|戏内层|共识层|待确认",
 "置信档":"高|中|低","置信度":0.0,"状态":"生效|待核|冲突|陈旧|归档",
 "次标签":[],"对象":"","时间":"","来源轮次":0,
 "证据":"原话或可观察行为","关联ID":"","audience":["all"],"merged_into_worldview":false}

情感卡（一期仅输出"瞬时情绪"；主体只能是"用户"或"角色"）：
{"kind":"emotion","主体":"用户|角色","类别":"瞬时情绪","标签":"受控词表",
 "强度":0.0,"对象":"","作用域":"现实层|戏内层|共识层|待确认",
 "证据":"必填","置信档":"高|中|低","置信度":0.0,"状态":"生效|待核|冲突|陈旧|归档","时间":"","audience":["all"]}

水位更新建议：
{"kind":"water","作用域":"戏内层|现实层|共识层",
 "建议状态":"active|frozen|degraded","目标水位":"L0|L1|L2|L3|L4|L5",
 "准入证据":[],"理由":""}

执笔状态更新建议：
{"kind":"drive","当前基调":"","本轮档位":"轻|中|重","连续同档":0,
 "目标":[],"当前弧光":"","阶段进度":0.0,
 "散落线头":[],"停滞天数":0,"status":"active|stalled|archived","理由":""}

# 主类型裁决（先匹配先定）
世界变更 → 关系共识 → 经历节点 → 自我认知 → 稳定事实 → 行为模式

判定树：
1 世界观/设定层的新增或修订提案？→ 世界变更（作用域默认戏内层；跨层共识确认标共识层）
2 双方共同确立的约定/边界/里程碑？→ 关系共识
3 发生过的事/剧情节点/关键决定？→ 经历节点
4 主观自我评价/心理状态描述？→ 自我认知（客观身份/职业/居住地/拥有物/日期归稳定事实）
5 静态属性（姓名/身份/职业/关系/居住地/拥有物/偏好/日期）？→ 稳定事实
6 重复出现的行为/习惯/固定反应？→ 行为模式

情感色彩不改记忆主类型。一句话既有记忆又有情感时，拆成两卡并用关联 ID 挂钩。

# 作用域判定（必填，四选一）
- 用户以本人身份说现实信息 → 现实层
- 角色在剧情里说的话/发生的事 → 戏内层（不得记为用户的现实记忆）
- 双方共同确认的设定 → 共识层
- 分不清 → 作用域标"待确认"，状态标"待核"

# 知情范围 audience 判定（防全知视角，必填）
数组，只允许这四个值："all" 双方都知道 / "user" 只有玩家知道（玩家内心、私下念头） / "character" 只有当前角色知道（角色内心、私下行动、未说出口的话） / "narrator" 谁都还没察觉（未揭露的世界设定）。
公开交流→all，角色内心→character，玩家内心→user，世界变更但角色没察觉→narrator，拿不准就 ["all"]。
入库前代码会再规范化一次：别名换成实际角色名，词表外的值丢弃，缺失一律 all。

# 硬规则
1 无证据不建卡。记忆卡"稳定事实/经历节点"的证据必填；情感卡证据全部必填。
2 情感不诊断：只记录表达与可观察反应，不做心理疾病判断、不贴病理标签、不推测创伤诊断。
3 不抽为长期记忆卡：玩笑/反讽/假设句；日常寒暄、重复信息、无延续价值的碎片；纯情绪往来若无新事实且未新增情感信息（此时不建长期记忆卡，但瞬时情绪卡仍要输出，类别=瞬时情绪，会话级，会话结束归档）；不构成节点的角色普通台词；无证据的推断与脑补；隐私敏感与用户明确说"别记"的内容。
4 一卡一主题；正文用第三人称可核验描述；只写发生了什么，不写主观评语、不替主体下结论、不做情绪化描写。
5 不虚构；记录不清晰标"记录不明确"。
6 世界变更卡一律先成"待核"，须创作者/管理员确认。你不得自行置为生效，也不参与证据计数自动升。

# 置信档与置信度（诚实打分，禁止虚高；二者必须一致）
- 高：记忆 置信度 ≥0.8 / 情感 置信度 ≥0.85 → 状态"生效"
- 中：记忆 0.6–<0.8 / 情感 0.65–<0.85 → 状态"待核"
- 低：< 中档下限 → 不输出为长期卡
状态"生效"与置信"高档"是两个独立条件。

# 入库与冲突
- 同一主体同一主题重复出现：不新建卡，输出"更新"动作并携带原卡 id。
- 新内容与现存生效卡矛盾：旧卡保持生效，新卡状态标"冲突"，写明与哪张卡冲突。你不得自动解决冲突。
- 自动升档：≥2 条独立证据时，"待核"卡可升为"生效"，但须按全部证据重估置信度且达到门槛（记忆 0.8 / 情感 0.85）；未达则维持待核。原值保留，不覆盖。

# 隐私
- 绝对不记：密码、验证码、支付凭证、他人未公开隐私、用户明确说"别记"的内容、法律敏感信息。
- 默认不记：精确 GPS、通讯录全量、与角色连续性无关的敏感身份信息。
- 命中即不输出。结构化敏感信息另有入库前程序化过滤兜底。
- 用户说"别记"：立即停止该实体/话题新增，并在输出里标注需询问是否删除已有相关卡。

# 水位（每次入库后检查一次）
L0 陌生｜L1 初识：≥1 稳定事实卡 + 有初次互动
L2 熟悉：≥1 行为模式或偏好卡 + ≥2 次独立互动
L3 亲近：≥1 经历节点 + ≥1 稳定态度卡
L4 信任：≥1 关系共识卡 + ≥1 次脆弱分享或情感触发 + 无未解决冲突
L5 亲密：双方明确确认的关系共识 + 长期稳定态度 + 无未解决冲突
一期替代：L3 = 经历节点 + 关系共识；L4 = 关系共识 + 经历节点中的脆弱分享 + 无未解决冲突；L5 一期不开放。
逐阶升，不可跳级；冲突/伤害/明确拒绝 → frozen 或 degraded。

# 执笔状态（每轮后检查一次）
- 更新本轮档位、连续同档计数、散落线头；
- 新目标只能来自人设明示、世界观约束、经历节点、关系共识，须带来源卡 id；新目标先成"待核"；
- 弧光阶段推进须有记忆卡证据；
- 连续 3 轮无实质推进 → 建议升档；连续 3 轮重档 → 建议缓冲；
- 停滞 ≥3 天标 stalled，≥7 天触发目标复核。

# 最后
只输出 JSON，不要解释、不要寒暄。无内容可抽时输出 []。`;

export interface ExtractResult {
  memories: MemoryCard[];
  emotions: EmotionCard[];
  waterLevelUpdates?: Array<{ 作用域: string; 建议状态: string; 目标水位: string }>;
}

/**
 * 简化的抽取LLM调用
 */
async function callExtractorLLM(messages: LLMMessage[]): Promise<string> {
  const apiConfig = resolveMixApiConfig();
  if (!apiConfig) {
    console.warn("[NarrativeWriter] No API config for extraction");
    return "[]";
  }

  try {
    const result = await sendLLMRequest(
      apiConfig,
      null,
      messages,
      [],
      { characterName: "Extractor" },
      { appId: "narrative-extractor" }
    );
    return result;
  } catch (err) {
    console.error("[NarrativeWriter] Extraction LLM call failed:", err);
    return "[]";
  }
}

/**
 * 从对话轮次中提取记忆卡与情感卡
 * sessionId 必填：卡一律落在这一场的命名空间里，不留全局写入入口
 *
 * context.来源 = 这次抽取是对会话里哪条回复做的：
 * - 来源消息ID / 来源轮次 由这里传入，落库前由代码盖到每张卡上，
 *   模型自己填的同名字段一律丢弃（它没见过 turns，报上来的轮次没有依据）；
 * - 不传（补抽历史、深度抽取、记忆整理、执笔正文入库前就抽的那次）= 来源未知，
 *   卡片不带这两个字段，永不被丢弃归档与竞态检查触碰。
 */
export async function extractFromTurn(
  sessionId: string | null | undefined,
  currentTurn: string,
  recentTurns: string[], // 最近6-8轮
  context: {
    isPlotMode: boolean; // 戏内还是戏外
    existingCardsSummary: Array<{ id: string; 主类型: string; 状态: string }>;
    currentWaterLevels: Record<string, WaterLevelState>;
    // 新增：特调会话元数据
    characterName?: string;
    userName?: string;
    worldText?: string;
    currentState?: any; // MixState - 包含天数等小票状态
    recentTurnsWithTicket?: Array<{ role: string; text: string; ticketRaw?: string }>;
    来源?: { 消息ID?: string; 轮次?: number };
  }
): Promise<ExtractResult> {
  const sid = requireSessionId(sessionId, "extractFromTurn");
  const 来源消息ID = context.来源?.消息ID;
  const 来源轮次 = context.来源?.轮次;
  // 抽取开始前的第一道检查：来源消息已经不在会话里（多半在等待期间被重说/回溯丢掉了），
  // 这一次抽取没有任何意义，连大模型都不该调——省一次请求，也不会产出一批来源已失效的卡。
  if (来源消息ID && !isSourceMessageAlive(sid, 来源消息ID)) {
    console.log(
      `[NarrativeWriter] 抽取跳过：来源消息 ${来源消息ID} 已不在对局 ${sid} 中`
    );
    return { memories: [], emotions: [] };
  }
  const messages: LLMMessage[] = [
    { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        currentTurn,
        recentTurns,
        context: {
          isPlotMode: context.isPlotMode,
          existingCardsSummary: context.existingCardsSummary,
          currentWaterLevels: context.currentWaterLevels,
          // 新增字段
          characterName: context.characterName,
          userName: context.userName,
          worldText: context.worldText,
          currentState: context.currentState, // 包含天数等状态
          recentTurnsWithTicket: context.recentTurnsWithTicket,
        },
      }),
    },
  ];

  const response = await callExtractorLLM(messages);

  // 解析JSON数组
  try {
    const results = JSON.parse(response);
    if (!Array.isArray(results)) {
      console.warn("[NarrativeWriter] Extraction returned non-array:", response);
      return { memories: [], emotions: [] };
    }

    const memories: MemoryCard[] = [];
    const emotions: EmotionCard[] = [];
    const waterLevelUpdates: Array<{ 作用域: string; 建议状态: string; 目标水位: string }> = [];

    // 落库时再查一次来源：模型响应这几秒里玩家可能已经点了重说。
    // 这一次抽取的结果属于一条已经不存在的话，卡可以留（内容也许还有用），
    // 但绝不能以"生效"的身份进上下文——一律归档，并写明为什么。
    const 来源已失效 =
      !!来源消息ID && !isSourceMessageAlive(sid, 来源消息ID);
    const 失效归档原因 = "抽取落库时来源消息已不存在";

    // audience 里的旧别名 "character" 指"本会话主角"，得知道主角是谁才能换成实际标识。
    // 调用方传了 characterName（精抽/深度抽取）就用它；热轨没传，就从对局本身读；
    // 两头都拿不到就留空，normalizeAudience 会把 "character" 退成 "all"。
    const 当前角色标识 =
      (context.characterName ?? "").trim() || sessionCharName(sid);

    for (const item of results) {
      if (item.kind === "memory") {
        const card: MemoryCard = {
          ...item,
          id: generateId(),
          // 知情范围同样以代码为准：模型给的值先归一化（别名换成当前角色名、
          // 词表外丢弃、缺失退 all），不接受它自由发挥
          audience: normalizeAudience(item.audience, 当前角色标识),
          // 来源以代码为准，丢弃模型填的值
          来源消息ID: 来源消息ID,
          来源轮次: 来源轮次,
          ...(来源已失效
            ? { 状态: "归档" as const, 归档原因: 失效归档原因 }
            : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await saveMemoryCard(sid, card);
        memories.push(card);
      } else if (item.kind === "emotion") {
        const card: EmotionCard = {
          ...item,
          id: generateId(),
          // 情感卡的知情范围与记忆卡同一套规则：角色的内心不能让玩家的角色看到，反之亦然
          audience: normalizeAudience(item.audience, 当前角色标识),
          来源消息ID: 来源消息ID,
          来源轮次: 来源轮次,
          ...(来源已失效
            ? { 状态: "归档" as const, 归档原因: 失效归档原因 }
            : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await saveEmotionCard(sid, card);
        emotions.push(card);
      } else if (item.kind === "water") {
        waterLevelUpdates.push(item);
      }
    }

    // 处理水位更新：同一道来源检查——来源都没了，它建议的水位也不该盖上去。
    // 注意这里只"跳过本次写入"，不回退历史水位（水位变更不带来源快照，见待办 #24）。
    if (waterLevelUpdates.length > 0 && !来源已失效) {
      await applyWaterLevelUpdates(sid, waterLevelUpdates, context.currentWaterLevels);
    }

    return { memories, emotions, waterLevelUpdates };
  } catch (e) {
    console.error("[NarrativeWriter] Extraction parse failed:", e);
    return { memories: [], emotions: [] };
  }
}

/**
 * 应用水位更新
 */
async function applyWaterLevelUpdates(
  sessionId: string | null | undefined,
  updates: Array<{ 作用域: string; 建议状态: string; 目标水位: string }>,
  currentLevels: Record<string, WaterLevelState>
): Promise<void> {
  const sid = requireSessionId(sessionId, "applyWaterLevelUpdates");
  for (const update of updates) {
    const scope = update.作用域 as "戏内层" | "现实层" | "共识层";
    if (!currentLevels[scope]) continue;

    const newLevel: WaterLevelState = {
      ...currentLevels[scope],
      status: update.建议状态 as WaterLevelState["status"],
      水位: update.目标水位 as WaterLevelState["水位"],
      最后更新: new Date().toISOString(),
    };

    await saveWaterLevel(sid, newLevel);
  }
}

/**
 * 生成UUID
 */
function generateId(): string {
  return `nw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 热轨抽取（Hot Extractor）：快速版，<3 秒
 * 只传正文 + 最近 3 轮，不传小票/尾调/状态快照
 * 用于执笔生成后立即出基线记忆卡
 *
 * 来源：这次抽取归属到哪条回复（消息ID + 轮次）。特调正常回复那条路径由引擎传进来；
 * 执笔面板"生成正文"那一路暂时传不了——正文此刻还没插进对局、没有消息 id（已知缺口 #25），
 * 不传即来源未知，卡片不参与丢弃归档与竞态检查。
 */
export async function hotExtractFromNarrativeBody(
    sessionId: string | null | undefined,
    body: string,
    recentTurns: string[], // 最近 3 轮正文
    来源?: { 消息ID?: string; 轮次?: number }
): Promise<ExtractResult> {
    const sid = requireSessionId(sessionId, "hotExtractFromNarrativeBody");
    const start = Date.now();
    console.log(`[HotTrack:Probe] Start - body length: ${body.length}, recent turns: ${recentTurns.length}`);
    
    // 超时保护：5 秒后强制返回空结果
    const timeoutPromise = new Promise<ExtractResult>((resolve) => {
        setTimeout(() => {
            console.log(`[HotTrack:Probe] Timeout after 5000ms`);
            resolve({ memories: [], emotions: [] });
        }, 5000);
    });
    
    const extractPromise = (async () => {
        const memories = await import("./storage").then(m => m.getMemoryCards(sid, { status: "生效" }));
        const emotions = await import("./storage").then(m => m.getEmotionCards(sid, { status: "生效" }));
        const waterLevels = await getWaterLevels(sid);
        
        const existingCardsSummary = [
            ...memories.map(m => ({ id: m.id, 主类型: m.主类型, 状态: m.状态 })),
            ...emotions.map(e => ({ id: e.id, 主类型: "瞬时情绪", 状态: e.状态 })),
        ];

        const result = await extractFromTurn(sid, body, recentTurns, {
            isPlotMode: true,
            existingCardsSummary,
            currentWaterLevels: waterLevels,
            来源,
        });
        
        const elapsed = Date.now() - start;
        console.log(`[HotTrack:Probe] End - ${elapsed}ms, +${result.memories.length} memories, +${result.emotions.length} emotions`);
        return result;
    })();
    
    return Promise.race([extractPromise, timeoutPromise]);
}

/**
 * 深度抽取（Cold Extractor）：完整版，异步后台
 * 传小票 + 尾调 + 状态快照 + 完整上下文
 * 用于深度抽取，补充热轨遗漏的细节
 */
export async function deepExtractFromNarrativeBody(
    sessionId: string | null | undefined,
    body: string,
    recentTurns: Array<{ role: string; text: string; ticketRaw?: string }>,
    context: {
        characterName: string;
        userName: string;
        worldText: string;
        currentState: any;
        mechanismStore?: Record<string, any>;
    }
): Promise<ExtractResult> {
    const sid = requireSessionId(sessionId, "deepExtractFromNarrativeBody");
    const logs: string[] = [];
    const log = (msg: string) => {
        logs.push(msg);
        console.log(`[DeepTrack:Probe] ${msg}`);
        // 持久化到 localStorage
        try {
            const existing = JSON.parse(localStorage.getItem('deepExtractLogs') || '[]');
            existing.push({ ts: Date.now(), msg });
            localStorage.setItem('deepExtractLogs', JSON.stringify(existing.slice(-100))); // 保留最近 100 条
        } catch {}
    };
    
    log(`Start - body length: ${body.length}, recent turns: ${recentTurns.length}, has state: ${!!context.currentState}`);
    
    log('Loading existing cards...');
    const memories = await import("./storage").then(m => m.getMemoryCards(sid, { status: "生效" }));
    const emotions = await import("./storage").then(m => m.getEmotionCards(sid, { status: "生效" }));
    const waterLevels = await getWaterLevels(sid);
    log(`Loaded ${memories.length} memories, ${emotions.length} emotions`);
    
    const existingCardsSummary = [
        ...memories.map(m => ({ id: m.id, 主类型: m.主类型, 状态: m.状态 })),
        ...emotions.map(e => ({ id: e.id, 主类型: "瞬时情绪", 状态: e.状态 })),
    ];

    const fullContext = {
        isPlotMode: true,
        existingCardsSummary,
        currentWaterLevels: waterLevels,
        characterName: context.characterName,
        userName: context.userName,
        worldText: context.worldText,
        currentState: context.currentState,
        recentTurnsWithTicket: recentTurns,
    };

    log('Calling LLM...');
    
    // 超时保护：60 秒后强制返回空结果
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<ExtractResult>((resolve) => {
        timeoutId = setTimeout(() => {
            log('Timeout after 60000ms - returning empty result');
            resolve({ memories: [], emotions: [] });
        }, 60000);
    });
    
    const extractPromise = extractFromTurn(sid, body, recentTurns.map(t => t.text), fullContext);
    const result = await Promise.race([extractPromise, timeoutPromise]);
    
    // 清理超时定时器
    if (timeoutId) clearTimeout(timeoutId);
    
    log(`End - +${result.memories.length} memories, +${result.emotions.length} emotions`);
    return result;
}

/**
 * 补抽历史：把整局对话按每 4 轮一批喂给逐轮抽取器，
 * 恢复抽取通道损坏/未启用期间丢失的细颗粒记忆（带证据、带情感卡）。
 * 一次性工具，由玩家主动触发；每批前重读已有卡摘要做批间去重。
 */
export async function backfillExtraction(
  sessionId: string | null | undefined,
  turns: Array<{ role: string; text: string }>,
  context: {
    characterName: string;
    userName: string;
    worldText: string;
    currentState?: Record<string, unknown>;
  },
  onProgress?: (done: number, total: number) => void
): Promise<{ memories: number; emotions: number }> {
  const sid = requireSessionId(sessionId, "backfillExtraction");
  const BATCH = 4;
  const batches: Array<Array<{ role: string; text: string }>> = [];
  for (let i = 0; i < turns.length; i += BATCH) {
    batches.push(turns.slice(i, i + BATCH));
  }

  let memories = 0;
  let emotions = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    // 本批整段作为"本轮对话"（玩家/角色前缀便于抽取器分辨主体）
    const currentTurn = batch
      .map(t => `${t.role === "user" ? "玩家" : "角色"}：${t.text}`)
      .join("\n");
    // 之前 6 轮正文作为近期上下文
    const recentTurns = turns.slice(0, bi * BATCH).slice(-6).map(t => t.text);

    // 每批重读已有卡：上一批新建的卡要进摘要，避免本批重复建
    const existingMemories = await getMemoryCards(sid, { status: "生效" });
    const existingEmotions = await getEmotionCards(sid, { status: "生效" });
    const waterLevels = await getWaterLevels(sid);

    const result = await extractFromTurn(sid, currentTurn, recentTurns, {
      isPlotMode: true,
      existingCardsSummary: [
        ...existingMemories.map(m => ({ id: m.id, 主类型: m.主类型, 状态: m.状态 })),
        ...existingEmotions.map(e => ({ id: e.id, 主类型: "瞬时情绪", 状态: e.状态 })),
      ],
      currentWaterLevels: waterLevels,
      characterName: context.characterName,
      userName: context.userName,
      worldText: context.worldText,
      currentState: context.currentState,
    });

    memories += result.memories.length;
    emotions += result.emotions.length;
    onProgress?.(bi + 1, batches.length);
  }

  console.log(`[NarrativeWriter] Backfill done: +${memories} memories, +${emotions} emotions`);
  return { memories, emotions };
}
