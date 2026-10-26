// components/mixology/mix-phone-list.tsx
// 独家特调 · 聊天室 · 首页：世界切换、私聊列表（每成员一条）、群聊卡片、
// 发起群聊、世界设置、新建世界（从对局 / 空白）。
// 私聊会话在点进那一刻惰性落库（createDirectThread，记录很小，省得列表满屏空壳）。
// 打开绑定了对局的世界时兜底补判一次主动消息（防对局页队列忙时漏判）。

import { useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, Settings, Users } from "lucide-react";
import {
    createDirectThread,
    createGroupThread,
    createMixPhoneWorld,
    findDirectThread,
    getMixPhoneWorld,
    loadMixChatThreads,
    loadMixPhoneWorlds,
    loadThreadMessages,
} from "@/lib/mixology/chatroom-storage";
import type { MixChatThread, MixPhoneWorld } from "@/lib/mixology/chatroom-types";
import { maybeEnqueueProactiveCheck } from "@/lib/mixology/chatroom-proactive";
import { getMixMaterial, getMixSession, listMixMaterials } from "@/lib/mixology/storage";
import { mixSlotFirstId, type MixCharacterCard, type MixTurn } from "@/lib/mixology/types";
import { MixPhoneWorldSettings } from "./mix-phone-world-settings";

type MixPhoneListProps = {
    initialWorldId?: string;
    onOpenThread: (worldId: string, threadId: string) => void;
    onToast?: (message: string) => void;
};

function isCharacterCard(m: ReturnType<typeof getMixMaterial>): m is MixCharacterCard {
    return m?.kind === "character";
}

function worldTitle(world: MixPhoneWorld | null): string {
    if (!world) return "聊天室";
    if (world.name?.trim()) return world.name;
    if (world.sessionId) {
        const session = getMixSession(world.sessionId);
        return session ? session.name?.trim() || session.charName : "已删除的对局";
    }
    return "独立世界";
}

function activeSessionId(): string | null {
    try {
        return localStorage.getItem("mixology_active_session_id") || null;
    } catch {
        return null;
    }
}

export function MixPhoneList({ initialWorldId, onOpenThread, onToast }: MixPhoneListProps) {
    const [worlds, setWorlds] = useState<MixPhoneWorld[]>(() => loadMixPhoneWorlds());
    const [activeWorldId, setActiveWorldId] = useState<string | null>(() => {
        const all = loadMixPhoneWorlds();
        if (initialWorldId) return initialWorldId;
        const bound = activeSessionId() ? all.find((w) => w.sessionId === activeSessionId()) : null;
        return bound?.id ?? all[0]?.id ?? null;
    });
    const [version, setVersion] = useState(0);
    const [switcherOpen, setSwitcherOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [groupOpen, setGroupOpen] = useState(false);
    const [creatingBlank, setCreatingBlank] = useState(false);

    const world = useMemo(
        () => worlds.find((w) => w.id === activeWorldId) ?? worlds[0] ?? null,
        [worlds, activeWorldId],
    );

    const refresh = () => {
        setWorlds(loadMixPhoneWorlds());
        setVersion((v) => v + 1);
    };

    // 兜底主动消息：打开绑定世界时补判一次（对局页每轮已判，这里防漏）
    useEffect(() => {
        if (!world?.sessionId) return;
        const session = getMixSession(world.sessionId);
        if (session) maybeEnqueueProactiveCheck({ world, session });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [world?.id, version]);

    const members = useMemo(
        () => (world?.memberIds ?? []).map((id) => getMixMaterial(id)).filter(isCharacterCard),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [world, version],
    );

    const turns = useMemo(() => {
        if (!world?.sessionId) return null;
        return getMixSession(world.sessionId)?.turns ?? null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [world, version]);

    const lastMessageOf = (thread: MixChatThread) => {
        const msgs = loadThreadMessages(thread, turns ?? undefined);
        return msgs.length ? msgs[msgs.length - 1] : null;
    };

    const unreadOf = (thread: MixChatThread) => {
        const last = lastMessageOf(thread);
        if (!last) return false;
        return thread.lastReadAt === undefined || last.createdAt > thread.lastReadAt;
    };

    const openDirect = (memberId: string) => {
        if (!world) return;
        const thread = findDirectThread(world.id, memberId) ?? createDirectThread(world.id, memberId);
        onOpenThread(world.id, thread.id);
    };

    const createFromSession = () => {
        const sessionId = activeSessionId();
        const session = sessionId ? getMixSession(sessionId) : null;
        if (!session) {
            onToast?.("先去「对局」里开一场对局，或用空白创建");
            return;
        }
        const existing = loadMixPhoneWorlds().find((w) => w.sessionId === session.id);
        if (existing) {
            setActiveWorldId(existing.id);
            refresh();
            return;
        }
        const leadId = mixSlotFirstId(session.recipe.slots, "character");
        const lead = leadId ? getMixMaterial(leadId) : null;
        const created = createMixPhoneWorld({
            sessionId: session.id,
            memberIds: lead?.kind === "character" ? [lead.id] : [],
        });
        setActiveWorldId(created.id);
        refresh();
    };

    const createBlank = (memberIds: string[]) => {
        const created = createMixPhoneWorld({ memberIds });
        setActiveWorldId(created.id);
        setCreatingBlank(false);
        refresh();
        onToast?.("独立世界已建好");
    };

    if (!world) {
        return (
            <div className="mix-phone-list">
                <div className="mix-phone-empty">
                    <div className="mix-phone-empty-title">还没有聊天世界</div>
                    <div className="mix-phone-empty-sub">
                        从对局创建会自动带入那一局的世界和角色（双向联动）；空白创建是不绑对局的独立小剧场。
                    </div>
                    <div className="mix-phone-empty-actions">
                        <button type="button" className="mix-btn" data-primary="true" onClick={createFromSession}>从当前对局创建</button>
                        <button type="button" className="mix-btn" onClick={() => setCreatingBlank(true)}>空白创建</button>
                    </div>
                    {creatingBlank ? <BlankWorldPicker onConfirm={createBlank} onClose={() => setCreatingBlank(false)} /> : null}
                </div>
            </div>
        );
    }

    const groupThreads = loadMixChatThreads(world.id).filter((t) => t.kind === "group");

    return (
        <div className="mix-phone-list">
            <div className="mix-phone-toolbar">
                <button type="button" className="mix-phone-world-btn" onClick={() => setSwitcherOpen(true)}>
                    <span className="mix-phone-world-name">{worldTitle(world)}</span>
                    <span className="mix-phone-world-kind">{world.sessionId ? "绑定对局" : "独立世界"} ▾</span>
                </button>
                <div className="mix-phone-toolbar-actions">
                    <button type="button" className="mix-icon-btn" onClick={() => setGroupOpen(true)} aria-label="发起群聊" title="发起群聊"><Users size={19} /></button>
                    <button type="button" className="mix-icon-btn" onClick={() => setSettingsOpen(true)} aria-label="世界设置" title="世界设置"><Settings size={19} /></button>
                </div>
            </div>

            <div className="mix-phone-list-body">
                {members.length === 0 ? (
                    <div className="mix-phone-empty">
                        <div className="mix-phone-empty-sub">世界里还没有成员：点右上角「世界设置」从酒柜加人。</div>
                    </div>
                ) : (
                    members.map((member) => {
                        const name = member.charName.trim() || member.name.trim();
                        const thread = findDirectThread(world.id, member.id);
                        const last = thread ? lastMessageOf(thread) : null;
                        const unread = thread ? unreadOf(thread) : false;
                        return (
                            <button type="button" className="mix-phone-row" key={member.id} onClick={() => openDirect(member.id)}>
                                <span
                                    className="mix-phone-avatar"
                                    data-cover={member.cover ? "true" : undefined}
                                    style={member.cover ? { backgroundImage: `url(${member.cover})` } : undefined}
                                >
                                    {name[0] ?? "?"}
                                </span>
                                <span className="mix-phone-row-main">
                                    <span className="mix-phone-row-name">{name}</span>
                                    <span className="mix-phone-row-preview">{last ? last.text.replace(/\s+/g, " ").slice(0, 40) : "说点什么吧…"}</span>
                                </span>
                                {unread ? <span className="mix-phone-unread" /> : null}
                            </button>
                        );
                    })
                )}

                {groupThreads.length ? (
                    <>
                        <div className="mix-phone-group-label">群聊</div>
                        {groupThreads.map((thread) => {
                            const last = lastMessageOf(thread);
                            return (
                                <button type="button" className="mix-phone-row" key={thread.id} onClick={() => onOpenThread(world.id, thread.id)}>
                                    <span className="mix-phone-avatar" data-group="true"><Users size={16} /></span>
                                    <span className="mix-phone-row-main">
                                        <span className="mix-phone-row-name">{thread.name?.trim() || "群聊"}</span>
                                        <span className="mix-phone-row-preview">{last ? last.text.replace(/\s+/g, " ").slice(0, 40) : "还没有人说话"}</span>
                                    </span>
                                    {unreadOf(thread) ? <span className="mix-phone-unread" /> : null}
                                </button>
                            );
                        })}
                    </>
                ) : null}

                <button type="button" className="mix-phone-newgroup" onClick={() => setGroupOpen(true)}>
                    <MessageSquarePlus size={15} />发起群聊（选 2 人以上）
                </button>
            </div>

            {switcherOpen ? (
                <div className="mix-sheet-mask" onClick={() => setSwitcherOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-title">切换世界</div>
                        {worlds.map((w) => (
                            <button
                                type="button"
                                className="mix-phone-row"
                                key={w.id}
                                data-on={w.id === world.id ? "true" : undefined}
                                onClick={() => { setActiveWorldId(w.id); setSwitcherOpen(false); refresh(); }}
                            >
                                <span className="mix-phone-row-main">
                                    <span className="mix-phone-row-name">{worldTitle(w)}</span>
                                    <span className="mix-phone-row-preview">{w.sessionId ? "绑定对局" : "独立世界"} · {w.memberIds.length} 位成员</span>
                                </span>
                            </button>
                        ))}
                        <div className="mix-sheet-actions">
                            <button type="button" className="mix-btn" onClick={() => { setSwitcherOpen(false); createFromSession(); }}>从当前对局新建</button>
                            <button type="button" className="mix-btn" onClick={() => { setSwitcherOpen(false); setCreatingBlank(true); }}>空白新建</button>
                        </div>
                    </div>
                </div>
            ) : null}

            {groupOpen ? (
                <GroupPicker
                    members={members}
                    onClose={() => setGroupOpen(false)}
                    onCreate={(memberIds, name) => {
                        const thread = createGroupThread(world.id, memberIds, name);
                        setGroupOpen(false);
                        refresh();
                        onOpenThread(world.id, thread.id);
                    }}
                />
            ) : null}

            {settingsOpen ? (
                <MixPhoneWorldSettings
                    world={getMixPhoneWorld(world.id) ?? world}
                    onClose={() => { setSettingsOpen(false); refresh(); }}
                    onSaved={() => refresh()}
                />
            ) : null}

            {creatingBlank ? <BlankWorldPicker onConfirm={createBlank} onClose={() => setCreatingBlank(false)} /> : null}
        </div>
    );
}

/** 群聊发起：选 ≥2 位成员 + 群名 */
function GroupPicker({ members, onClose, onCreate }: {
    members: MixCharacterCard[];
    onClose: () => void;
    onCreate: (memberIds: string[], name: string) => void;
}) {
    const [picked, setPicked] = useState<string[]>([]);
    const [name, setName] = useState("");
    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-title">发起群聊</div>
                <input
                    className="mix-phone-input mix-phone-group-name"
                    value={name}
                    placeholder="群名（可留空）"
                    onChange={(e) => setName(e.target.value)}
                />
                <div className="mix-phone-member-pick" data-static="true">
                    {members.map((m) => (
                        <button
                            type="button"
                            key={m.id}
                            className="mix-phone-pick-item"
                            data-on={picked.includes(m.id) ? "true" : undefined}
                            onClick={() => setPicked((prev) => prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id])}
                        >
                            {m.charName.trim() || m.name.trim()}
                        </button>
                    ))}
                </div>
                {members.length < 2 ? <div className="mix-phone-set-hint">世界里成员不足 2 位：先去世界设置加人</div> : null}
                <div className="mix-sheet-actions">
                    <button type="button" className="mix-btn" onClick={onClose}>取消</button>
                    <button type="button" className="mix-btn" data-primary="true" disabled={picked.length < 2} onClick={() => onCreate(picked, name)}>
                        建群（{picked.length} 人）
                    </button>
                </div>
            </div>
        </div>
    );
}

/** 空白建世界：从酒柜挑 ≥1 位成员 */
function BlankWorldPicker({ onConfirm, onClose }: {
    onConfirm: (memberIds: string[]) => void;
    onClose: () => void;
}) {
    const [picked, setPicked] = useState<string[]>([]);
    const candidates = useMemo(
        () => listMixMaterials("character").filter(isCharacterCard),
        [],
    );
    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-title">空白创建（独立世界）</div>
                <div className="mix-phone-member-pick" data-static="true">
                    {candidates.map((m) => (
                        <button
                            type="button"
                            key={m.id}
                            className="mix-phone-pick-item"
                            data-on={picked.includes(m.id) ? "true" : undefined}
                            onClick={() => setPicked((prev) => prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id])}
                        >
                            {m.charName.trim() || m.name.trim()}
                        </button>
                    ))}
                </div>
                {candidates.length === 0 ? <div className="mix-phone-set-hint">酒柜里还没有角色卡：先去酒柜或酒材页入柜</div> : null}
                <div className="mix-sheet-actions">
                    <button type="button" className="mix-btn" onClick={onClose}>取消</button>
                    <button type="button" className="mix-btn" data-primary="true" disabled={picked.length < 1} onClick={() => onConfirm(picked)}>
                        创建（{picked.length} 位成员）
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * 导航红点的粗信号：任何一个会话的最后一条消息比 lastReadAt 新（或从没读过）。
 * 调用方在 tab/会话切换时取一次，不进渲染热路径——绑定局的消息要扫 turns，
 * 每帧都算就浪费了。
 */
export function phoneHasUnread(): boolean {
    const worlds = loadMixPhoneWorlds();
    const turnsBySession = new Map<string, MixTurn[]>();
    for (const world of worlds) {
        for (const thread of loadMixChatThreads(world.id)) {
            let msgs: ReturnType<typeof loadThreadMessages>;
            if (world.sessionId) {
                if (!turnsBySession.has(world.sessionId)) {
                    turnsBySession.set(world.sessionId, getMixSession(world.sessionId)?.turns ?? []);
                }
                msgs = loadThreadMessages(thread, turnsBySession.get(world.sessionId)!);
            } else {
                msgs = loadThreadMessages(thread);
            }
            if (!msgs.length) continue;
            const last = msgs[msgs.length - 1];
            if (thread.lastReadAt === undefined || last.createdAt > thread.lastReadAt) return true;
        }
    }
    return false;
}
