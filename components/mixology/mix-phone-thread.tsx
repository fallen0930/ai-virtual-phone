// components/mixology/mix-phone-thread.tsx
// 独家特调 · 聊天室 · 会话界面（私聊/群聊通用）。
//
// 数据口径：绑定世界的消息是对局 turns 里的 msg 轮（本组件只投影+追加），
// 独立世界的消息在自己的键里。发送 = 先把用户消息落库，再按回复策略给每个
// 回话者排一个生成任务（queued 入队，与对局推演串行；后回的能看到先回的）。
// 流式：订阅 session-runtime 的 liveText，只认 channel === "msg" 的条目。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, Send } from "lucide-react";
import {
    appendStandaloneThreadMessages,
    getMixChatThread,
    getMixPhoneWorld,
    loadStandaloneThreadMessages,
    loadThreadMessages,
    saveMixChatThread,
} from "@/lib/mixology/chatroom-storage";
import {
    assembleChatroomPrompt,
    buildChatroomPlotContext,
    capChatHistory,
    makeChatTurn,
    pickChatResponders,
    runChatroomReply,
    splitChatInnerVoice,
} from "@/lib/mixology/chatroom-engine";
import { enqueueMixGenerationQueued, getMixSessionRuntimeState, subscribeMixSessionRuntime } from "@/lib/mixology/session-runtime";
import { getMixMaterial, getMixSession, resolveMixRecipeMaterials, saveMixSession } from "@/lib/mixology/storage";
import { buildMixConditionContext, pickActiveMixMaterials } from "@/lib/mixology/state";
import { MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { createMixId, mixSlotFirstId, type MixCharacterCard, type MixPersonaMaterial, type MixTextMaterial, type MixTurn } from "@/lib/mixology/types";
import type { MixChatThread, MixPhoneMessage, MixPhoneWorld } from "@/lib/mixology/chatroom-types";

type MixPhoneThreadProps = {
    worldId: string;
    threadId: string;
    onBack: () => void;
    onToast?: (message: string) => void;
};

function isCharacter(m: ReturnType<typeof getMixMaterial>): m is MixCharacterCard {
    return m?.kind === "character";
}

function isPersona(m: ReturnType<typeof getMixMaterial>): m is MixPersonaMaterial {
    return m?.kind === "persona";
}

function isTextMaterial(kind: string) {
    return (m: ReturnType<typeof getMixMaterial>): m is MixTextMaterial => m?.kind === kind;
}

export function threadTitleOf(thread: MixChatThread | null, members: MixCharacterCard[]): string {
    if (!thread) return "聊天室";
    if (thread.kind === "group") return thread.name?.trim() || "群聊";
    const member = members.find((m) => m.id === thread.memberId);
    return member?.charName.trim() || member?.name.trim() || "私聊";
}

export function MixPhoneThread({ worldId, threadId, onBack, onToast }: MixPhoneThreadProps) {
    const [world, setWorld] = useState<MixPhoneWorld | null>(() => getMixPhoneWorld(worldId));
    const thread = useMemo(() => getMixChatThread(threadId), [threadId]);
    const [version, setVersion] = useState(0);
    const [input, setInput] = useState("");
    const listRef = useRef<HTMLDivElement | null>(null);
    const markedRef = useRef(false);

    const runtimeState = useSyncExternalStore(subscribeMixSessionRuntime, getMixSessionRuntimeState, getMixSessionRuntimeState);
    const queueKey = world?.sessionId ?? (world ? `world:${world.id}` : "");
    const runningEntry = runtimeState.running[queueKey];
    const msgBusy = !!runningEntry && (runningEntry.status === "generating" || runningEntry.status === "queued");
    const msgGenerating = !!runningEntry && runningEntry.status === "generating" && runningEntry.channel === "msg";
    const liveText = msgGenerating ? runningEntry.liveText : "";
    const msgError = runningEntry?.status === "error" && runningEntry.channel === "msg" ? runningEntry.error : null;

    const members = useMemo(
        () => (world?.memberIds ?? []).map((id) => getMixMaterial(id)).filter(isCharacter),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [world, version],
    );
    const persona = useMemo(() => {
        const found = world?.personaId ? getMixMaterial(world.personaId) : null;
        return isPersona(found) ? found : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [world]);
    const userName = persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    const title = threadTitleOf(thread, members);

    // 世界设定来源卡：绑定局 = 该局主演；独立世界 = 第一位成员
    const worldCard = useMemo(() => {
        if (!world) return null;
        if (world.sessionId) {
            const session = getMixSession(world.sessionId);
            const leadId = session ? mixSlotFirstId(session.recipe.slots, "character") : null;
            const lead = leadId ? getMixMaterial(leadId) : null;
            if (isCharacter(lead)) return lead;
        }
        return members[0] ?? null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [world, members, version]);

    const messages = useMemo<MixPhoneMessage[]>(() => {
        if (!world || !thread) return [];
        if (world.sessionId) {
            const session = getMixSession(world.sessionId);
            return session ? loadThreadMessages(thread, session.turns) : [];
        }
        return loadStandaloneThreadMessages(thread.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [world, thread, version]);

    // 进会话即标已读
    useEffect(() => {
        if (!thread || markedRef.current) return;
        markedRef.current = true;
        saveMixChatThread({ ...thread, lastReadAt: Date.now() });
    }, [thread]);

    // 新消息/流式时滚到底
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, liveText]);

    /** 给一个回话者排生成任务（读最新数据装配，回复落库后刷新视图） */
    const enqueueReplyTask = useCallback((speakerId: string) => {
        if (!world || !thread) return;
        enqueueMixGenerationQueued(
            queueKey,
            async (signal, onDelta) => {
                const w = getMixPhoneWorld(worldId);
                if (!w) return;
                const speaker = getMixMaterial(speakerId);
                if (!isCharacter(speaker)) return;
                const speakerName = speaker.charName.trim() || speaker.name.trim() || "角色";
                const membersNow = w.memberIds.map((id) => getMixMaterial(id)).filter(isCharacter);
                const personaNow = w.personaId ? getMixMaterial(w.personaId) : null;
                const personaMat = isPersona(personaNow) ? personaNow : null;
                const userNameNow = personaMat?.userName?.trim() || MIX_DEFAULT_USER_NAME;

                let history: MixPhoneMessage[] = [];
                let baseMaterials: MixTextMaterial[] = [];
                let flavorMaterials: MixTextMaterial[] = [];
                let plotContext: string | null = null;
                let state: Record<string, string | number> | undefined;
                let worldCardNow: MixCharacterCard | null = null;
                if (w.sessionId) {
                    const session = getMixSession(w.sessionId);
                    if (session) {
                        history = capChatHistory(loadThreadMessages(thread, session.turns), w.settings.msgHistoryCap);
                        const { entries } = resolveMixRecipeMaterials(session.recipe);
                        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
                        baseMaterials = (active.base ?? []).filter(isTextMaterial("base"));
                        flavorMaterials = (active.flavor ?? []).filter(isTextMaterial("flavor"));
                        plotContext = buildChatroomPlotContext(session, w.settings);
                        state = session.state ?? {};
                        const leadId = mixSlotFirstId(session.recipe.slots, "character");
                        const lead = leadId ? getMixMaterial(leadId) : null;
                        worldCardNow = isCharacter(lead) ? lead : membersNow[0] ?? null;
                    }
                } else {
                    history = capChatHistory(loadStandaloneThreadMessages(thread.id), w.settings.msgHistoryCap);
                    worldCardNow = membersNow[0] ?? null;
                }

                const system = assembleChatroomPrompt({
                    speaker,
                    members: membersNow,
                    worldCard: worldCardNow,
                    persona: personaMat,
                    baseMaterials,
                    flavorMaterials,
                    plotContext,
                    state,
                    innerVoice: w.settings.innerVoice,
                });
                const result = await runChatroomReply({
                    system,
                    history,
                    // 发言已先一步落库、随历史进来，这里不再追加 userMessage
                    labelSpeakers: membersNow.length > 1,
                    userName: userNameNow,
                    characterName: speakerName,
                    signal,
                    onDelta,
                });
                const text = result.text.trim();
                if (!text) return;
                if (w.sessionId) {
                    const session = getMixSession(w.sessionId);
                    if (!session) return;
                    const replyTurn: MixTurn = makeChatTurn({
                        role: "assistant",
                        text,
                        speaker: speakerName,
                        threadId: thread.id,
                        threadLabel: threadTitleOf(thread, membersNow),
                        baseTurns: session.turns,
                    });
                    saveMixSession({ ...session, turns: [...session.turns, replyTurn] });
                } else {
                    appendStandaloneThreadMessages(thread.id, [
                        { id: createMixId("m"), role: "assistant", speaker: speakerName, text, createdAt: Date.now() },
                    ]);
                }
                setVersion((v) => v + 1);
            },
            { channel: "msg" },
        );
    }, [world, thread, queueKey]);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || !world || !thread) return;
        if (msgBusy) {
            onToast?.("上一条还在路上，等它说完…");
            return;
        }
        const label = threadTitleOf(thread, members);
        if (world.sessionId) {
            const session = getMixSession(world.sessionId);
            if (!session) {
                onToast?.("这场对局已删除，聊天世界没了剧情可依");
                return;
            }
            const userTurn = makeChatTurn({
                role: "user",
                text,
                threadId: thread.id,
                threadLabel: label,
                baseTurns: session.turns,
            });
            saveMixSession({ ...session, turns: [...session.turns, userTurn] });
        } else {
            appendStandaloneThreadMessages(thread.id, [
                { id: createMixId("m"), role: "user", text, createdAt: Date.now() },
            ]);
        }
        setInput("");
        setVersion((v) => v + 1);

        // 回复策略：点名优先（未点名回落轮流）/ 轮流 / 全员
        const membersNow = world.memberIds.map((id) => getMixMaterial(id)).filter(isCharacter);
        const lastSpeaker = [...messages].reverse().find((m) => m.role === "assistant")?.speaker ?? null;
        const responders = pickChatResponders({
            message: text,
            members: membersNow,
            lastSpeakerName: lastSpeaker,
            policy: world.settings.replyPolicy,
        });
        for (const responder of responders) enqueueReplyTask(responder.id);
    }, [input, world, thread, members, messages, msgBusy, enqueueReplyTask, onToast]);

    if (!world || !thread) {
        return (
            <div className="mix-phone-thread">
                <div className="mix-phone-toolbar">
                    <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                    <div className="mix-phone-toolbar-title">聊天室</div>
                </div>
                <div className="mix-phone-empty">会话不存在或已被删除。</div>
            </div>
        );
    }

    return (
        <div className="mix-phone-thread">
                <div className="mix-phone-toolbar">
                    <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                    <div className="mix-phone-toolbar-title">
                        {title}
                        <em>{world.sessionId ? "绑定对局 · 双向联动" : "独立世界"}</em>
                    </div>
                </div>
                <div className="mix-phone-list-body" ref={listRef}>
                    {messages.map((msg) => (
                        <div className="mix-msg-turn" data-side={msg.role === "user" ? "right" : "left"} key={msg.id}>
                            {msg.role === "assistant" && msg.speaker ? <div className="mix-msg-sender">{msg.speaker}</div> : null}
                            <div className="mix-msg-bubble">
                                {splitChatInnerVoice(msg.text).map((bubble, bubbleIdx) => bubble.kind === "voice" ? (
                                    <div className="mix-msg-voice" key={bubbleIdx}>心声 · {bubble.text}</div>
                                ) : (
                                    <div key={bubbleIdx}>{bubble.text}</div>
                                ))}
                            </div>
                        </div>
                    ))}
                    {msgGenerating && liveText ? (
                        <div className="mix-msg-turn" data-side="left">
                            {msgGenerating ? <div className="mix-msg-sender">正在输入…</div> : null}
                            <div className="mix-msg-bubble" data-streaming="true">
                                {splitChatInnerVoice(liveText).map((bubble, bubbleIdx) => bubble.kind === "voice" ? (
                                    <div className="mix-msg-voice" key={bubbleIdx}>心声 · {bubble.text}</div>
                                ) : (
                                    <div key={bubbleIdx}>{bubble.text}</div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {msgGenerating && !liveText ? (
                        <div className="mix-msg-turn" data-side="left">
                            <div className="mix-game-thinking" aria-label="正在输入"><span /><span /><span /></div>
                        </div>
                    ) : null}
                    {msgError ? <div className="mix-msg-error">发送失败：{msgError}</div> : null}
                </div>
                <div className="mix-phone-inputbar">
                    <textarea
                        className="mix-phone-input"
                        rows={1}
                        value={input}
                        placeholder={msgBusy ? "生成中…" : `给 ${title} 发消息…（群里点名谁，谁就回）`}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                    />
                    <button type="button" className="mix-icon-btn" onClick={handleSend} disabled={msgBusy || !input.trim()} aria-label="发送">
                        <Send size={18} />
                    </button>
                </div>
            </div>
    );
}
