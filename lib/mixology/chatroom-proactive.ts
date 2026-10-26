// lib/mixology/chatroom-proactive.ts
// 独家特调 · 聊天室 · 主动消息：对局推演后判定角色要不要主动来找你。
//
// 一次非流式严格 JSON 请求同时完成「判定 + 写消息」（省一次往返）；提示词
// 明确「无事可说必须返回 false」，杜绝硬凑。坏输出/超时/异常一律静默跳过，
// 绝不影响对局。节奏由世界设置控制：开关 / 每几轮判一次（everyRounds）/
// 两次主动消息最小间隔（cooldown，scene 轮数）。
//
// 触发入口：对局一轮落库后（对局页）与打开聊天室时的兜底补判，都走
// maybeEnqueueProactiveCheck —— 经 session-runtime 的 queued 入队与对局
// 推演串行互斥，绝不与正文生成并发写同一个 turns。

import { sendLLMRequest } from "../chat-engine";
import type { ApiConfig } from "../settings-types";
import { MIX_INNER_VOICE_CLOSE, MIX_INNER_VOICE_OPEN, buildChatroomPlotContext, makeChatTurn } from "./chatroom-engine";
import type { MixPhoneWorld } from "./chatroom-types";
import { createDirectThread, findDirectThread, getMixPhoneWorld, saveMixPhoneWorld } from "./chatroom-storage";
import { mixRoundCount } from "./history";
import { resolveMixApiConfig } from "./engine";
import { getMixMaterial, getMixSession, saveMixSession } from "./storage";
import { enqueueMixGenerationQueued } from "./session-runtime";
import {
    type MixCharacterCard,
    type MixPersonaMaterial,
    type MixSession,
} from "./types";
import { MIX_DEFAULT_USER_NAME } from "./assembler";

// ── 节奏（纯函数） ──

/**
 * 这一轮该不该跑判定：
 * - 开关关 = 永不；
 * - everyRounds：距上次判定不足 N 个 scene 轮不判（省 API 钱）；
 * - cooldown：距上次真发出主动消息不足 N 个 scene 轮不判（防轰炸）。
 * 首次（两个记忆都缺）放行。
 */
export function shouldJudgeProactive(world: MixPhoneWorld, sceneRounds: number): boolean {
    if (!world.settings.proactive) return false;
    const every = Math.max(1, Math.floor(world.settings.proactiveEveryRounds));
    const lastJudged = world.proactive?.lastJudgedRounds;
    if (lastJudged !== undefined && sceneRounds - lastJudged < every) return false;
    const cooldown = Math.max(0, Math.floor(world.settings.proactiveCooldown));
    const lastPing = world.proactive?.lastPingRounds;
    if (lastPing !== undefined && sceneRounds - lastPing < cooldown) return false;
    return true;
}

/** 判定跑过就记账（包括 trigger=false 的那次） */
export function markProactiveJudged(world: MixPhoneWorld, sceneRounds: number): MixPhoneWorld {
    return { ...world, proactive: { ...world.proactive, lastJudgedRounds: sceneRounds } };
}

/** 只有真发出主动消息才记冷却账 */
export function markProactivePing(world: MixPhoneWorld, sceneRounds: number): MixPhoneWorld {
    return { ...world, proactive: { ...world.proactive, lastPingRounds: sceneRounds } };
}

// ── 判定输出 ──

export type ProactiveVerdict =
    | { trigger: false }
    | { trigger: true; memberId: string; text: string; innerVoice?: string };

/**
 * 解析判定输出。模型可能裹 JSON 围栏或前后废话——取首个 { 到最后一个 } 之间
 * 解析；trigger=true 缺 memberId/text 一律视为坏输出（宁可不发，不可乱发）。
 */
export function parseProactiveVerdict(raw: string): ProactiveVerdict | null {
    const text = (raw ?? "").trim();
    if (!text) return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (o.trigger !== true) return o.trigger === false ? { trigger: false } : null;
    const memberId = typeof o.memberId === "string" ? o.memberId.trim() : "";
    const message = typeof o.text === "string" ? o.text.trim() : "";
    if (!memberId || !message) return null;
    const innerVoice =
        typeof o.innerVoice === "string" && o.innerVoice.trim() ? o.innerVoice.trim() : undefined;
    return { trigger: true, memberId, text: message, innerVoice };
}

// ── 提示词 ──

function memberBriefLine(member: MixCharacterCard): string {
    const line = [member.baseInfo, member.personality]
        .map((t) => (t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "")
        .filter(Boolean)[0] ?? "";
    return line.slice(0, 60);
}

export function buildProactivePrompt(input: {
    world: MixPhoneWorld;
    session: Pick<MixSession, "turns" | "state">;
    members: MixCharacterCard[];
    persona?: MixPersonaMaterial | null;
    userName: string;
}): { system: string; user: string } {
    const userName = input.persona?.userName?.trim() || input.userName || MIX_DEFAULT_USER_NAME;
    const plot = buildChatroomPlotContext(input.session, input.world.settings);
    const recentMsgs = input.session.turns
        .filter((t) => t.channel === "msg")
        .slice(-10)
        .map((t) => {
            const who = t.role === "user" ? userName : t.speaker?.trim() || "对方";
            return `${who}：${t.text.replace(/\s+/g, " ").slice(0, 80)}`;
        });
    const memberLines = input.members.map((m) => {
        const name = m.charName.trim() || m.name.trim() || "成员";
        const brief = memberBriefLine(m);
        return `- [${m.id}] ${name}${brief ? `：${brief}` : ""}`;
    });

    const system = [
        "你在为一款文字游戏判定：此刻有没有角色想**主动**给玩家发一条手机消息。",
        "",
        `## 玩家\n${userName}`,
        "",
        "## 世界成员（候选发信人，memberId 用方括号里的 id）",
        memberLines.length ? memberLines.join("\n") : "（没有成员，必然不触发）",
        "",
        "## 对局前情（最近剧情）",
        plot || "（还没有剧情推进）",
        "",
        "## 最近的手机往来（避免重复，不要复读这些内容）",
        recentMsgs.length ? recentMsgs.join("\n") : "（还没有手机往来）",
        "",
        "## 判定规则",
        "- 只有剧情自然引出某个角色此刻想主动联系玩家（有新话头、情绪推动、约定要兑现）才触发；",
        "- 无事可说、强行找话、重复手机往来里已有内容时，必须返回不触发；",
        "- 每次至多一个角色发一条消息，内容符合角色口吻与两人关系，简短口语，像真人发消息；",
        "- 你只写这条消息，不替玩家回复，也不推进对局剧情。",
    ].join("\n");

    const user = [
        "只输出一个 JSON 对象，不要任何多余文字：",
        '不触发 → {"trigger": false}',
        '触发 → {"trigger": true, "memberId": "<成员id>", "text": "<消息内容>", "innerVoice": "<可选：她发这条时的心声>"}',
    ].join("\n");

    return { system, user };
}

// ── 调用 ──

/** 一次判定调用。返回 null = 不触发或调用失败（调用失败静默，绝不影响对局） */
export async function runProactiveVerdict(options: {
    world: MixPhoneWorld;
    session: Pick<MixSession, "turns" | "state">;
    members: MixCharacterCard[];
    persona?: MixPersonaMaterial | null;
    userName: string;
    apiConfig?: ApiConfig;
}): Promise<ProactiveVerdict | null> {
    const apiConfig = options.apiConfig ?? resolveMixApiConfig();
    if (!apiConfig) return null;
    const { system, user } = buildProactivePrompt({
        world: options.world,
        session: options.session,
        members: options.members,
        persona: options.persona,
        userName: options.userName,
    });
    // 严格 JSON + 短超时（与台账冷启动同一口径）：判定是后台任务，卡住就放弃这一轮
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    // 与对局同一口径（engine.ts 的 llmOptions）：变量传递，流式/非流式共用
    const llmOptions = {
        appId: "mixology",
        appTags: ["mixology", "chatroom"],
        skipOutputRegex: true,
        skipTimestampStrip: true,
        signal: controller.signal,
    };
    try {
        const raw = await sendLLMRequest(
            apiConfig,
            null,
            [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            [],
            { userName: options.userName },
            llmOptions,
        );
        return parseProactiveVerdict(raw);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── 触发入口 ──

/**
 * 主动消息的总入口（对局一轮落库后 / 打开聊天室兜底时调用）。
 * 经 queued 入队与对局推演串行；命中后把消息写进该成员的私聊（msg 轮，
 * 心声以 〔心声〕 壳并进 text），并对 world 记判定账/冷却账。
 * 独立世界（没绑对局）没有剧情可看，不跑。
 */
export function maybeEnqueueProactiveCheck(options: { world: MixPhoneWorld; session: MixSession }): void {
    const { world, session } = options;
    if (!world.sessionId || !world.settings.proactive) return;
    const gateRounds = mixRoundCount(session.turns);
    if (!shouldJudgeProactive(world, gateRounds)) return;

    const key = world.sessionId;
    enqueueMixGenerationQueued(
        key,
        async () => {
            // 生成到这一步时对局可能又推进了：全部按当时最新数据重新取
            const currentWorld = getMixPhoneWorld(world.id) ?? world;
            const fresh = getMixSession(world.sessionId!) ?? session;
            const rounds = mixRoundCount(fresh.turns);
            if (!shouldJudgeProactive(currentWorld, rounds)) {
                saveMixPhoneWorld(markProactiveJudged(currentWorld, rounds));
                return;
            }
            const members = currentWorld.memberIds
                .map((id) => getMixMaterial(id))
                .filter((m): m is MixCharacterCard => m?.kind === "character");
            const persona = currentWorld.personaId
                ? getMixMaterial(currentWorld.personaId)
                : null;
            const personaMaterial = persona?.kind === "persona" ? persona : null;

            const verdict = await runProactiveVerdict({
                world: currentWorld,
                session: fresh,
                members,
                persona: personaMaterial,
                userName: personaMaterial?.userName?.trim() || MIX_DEFAULT_USER_NAME,
            });

            let nextWorld = markProactiveJudged(currentWorld, rounds);
            if (verdict?.trigger) {
                const member = members.find((m) => m.id === verdict.memberId);
                if (member) {
                    const speakerName = member.charName.trim() || member.name.trim() || "角色";
                    const thread =
                        findDirectThread(currentWorld.id, member.id) ??
                        createDirectThread(currentWorld.id, member.id);
                    const text = verdict.innerVoice
                        ? `${verdict.text}\n${MIX_INNER_VOICE_OPEN}${verdict.innerVoice}${MIX_INNER_VOICE_CLOSE}`
                        : verdict.text;
                    const turn = makeChatTurn({
                        role: "assistant",
                        text,
                        speaker: speakerName,
                        threadId: thread.id,
                        threadLabel: speakerName,
                        baseTurns: fresh.turns,
                    });
                    saveMixSession({ ...fresh, turns: [...fresh.turns, turn] });
                    nextWorld = markProactivePing(nextWorld, rounds);
                }
            }
            saveMixPhoneWorld(nextWorld);
        },
        { channel: "msg" },
    );
}
