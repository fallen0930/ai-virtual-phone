// components/mixology/mix-phone-world-settings.tsx
// 独家特调 · 聊天室 · 世界设置弹层：成员（人设）增删排序、面具、前情与
// 主动消息参数、回复策略、聊天回传上限。「怎么对应世界和人设」就在这里定。

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { getMixMaterial, listMixMaterials } from "@/lib/mixology/storage";
import { saveMixPhoneWorld } from "@/lib/mixology/chatroom-storage";
import { normalizeMixPhoneWorld } from "@/lib/mixology/chatroom-types";
import type { MixCharacterCard, MixPersonaMaterial } from "@/lib/mixology/types";
import type { MixPhoneWorld } from "@/lib/mixology/chatroom-types";

type MixPhoneWorldSettingsProps = {
    world: MixPhoneWorld;
    onClose: () => void;
    onSaved: (world: MixPhoneWorld) => void;
};

export function MixPhoneWorldSettings({ world, onClose, onSaved }: MixPhoneWorldSettingsProps) {
    const [draft, setDraft] = useState<MixPhoneWorld>(() => normalizeMixPhoneWorld(JSON.parse(JSON.stringify(world))));
    const [adding, setAdding] = useState(false);

    const memberCards = useMemo(
        () => draft.memberIds.map((id) => getMixMaterial(id)).filter((m): m is MixCharacterCard => m?.kind === "character"),
        [draft.memberIds],
    );
    const candidates = useMemo(() => {
        if (!adding) return [];
        return listMixMaterials("character").filter((m) => !draft.memberIds.includes(m.id));
    }, [adding, draft.memberIds]);
    const personas = useMemo(() => listMixMaterials("persona").filter((m): m is MixPersonaMaterial => m?.kind === "persona"), []);

    const memberName = (id: string) => {
        const card = memberCards.find((m) => m.id === id);
        return card?.charName.trim() || card?.name.trim() || "未知成员";
    };

    const moveMember = (index: number, delta: number) => {
        const next = [...draft.memberIds];
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        setDraft({ ...draft, memberIds: next });
    };

    const save = () => {
        const fixed = normalizeMixPhoneWorld(JSON.parse(JSON.stringify(draft)));
        saveMixPhoneWorld(fixed);
        onSaved(fixed);
        onClose();
    };

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet mix-phone-settings" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-title">世界设置 · {world.sessionId ? "绑定对局" : "独立世界"}</div>

                <div className="mix-phone-set-section">
                    <div className="mix-phone-set-label">成员（私聊对象 + 群聊可选的人）</div>
                    {memberCards.map((card, index) => (
                        <div className="mix-phone-member-row" key={card.id}>
                            <span className="mix-phone-member-name">{index === 0 ? "★ " : ""}{card.charName.trim() || card.name}</span>
                            <span className="mix-phone-member-actions">
                                <button type="button" className="mix-icon-btn" onClick={() => moveMember(index, -1)} disabled={index === 0} aria-label="上移"><ChevronUp size={14} /></button>
                                <button type="button" className="mix-icon-btn" onClick={() => moveMember(index, 1)} disabled={index === memberCards.length - 1} aria-label="下移"><ChevronDown size={14} /></button>
                                <button type="button" className="mix-icon-btn" onClick={() => setDraft({ ...draft, memberIds: draft.memberIds.filter((id) => id !== card.id) })} aria-label="移出"><X size={14} /></button>
                            </span>
                        </div>
                    ))}
                    {candidates.length ? (
                        adding ? (
                            <div className="mix-phone-member-pick">
                                {candidates.map((m) => (
                                    <button
                                        type="button"
                                        key={m.id}
                                        className="mix-phone-pick-item"
                                        onClick={() => {
                                            setDraft({ ...draft, memberIds: [...draft.memberIds, m.id] });
                                            setAdding(false);
                                        }}
                                    >
                                        {m.kind === "character" ? m.charName.trim() || m.name : m.name}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <button type="button" className="mix-phone-add-btn" onClick={() => setAdding(true)}>
                                <Plus size={14} />从酒柜加成员
                            </button>
                        )
                    ) : (
                        <div className="mix-phone-set-hint">{draft.memberIds.length ? "酒柜里没有更多角色卡了" : "还没有成员：先去酒柜建角色卡，或从酒材页入柜"}</div>
                    )}
                </div>

                <div className="mix-phone-set-section">
                    <div className="mix-phone-set-label">{"面具（{{user}} 是谁，可不选）"}</div>
                    <div className="mix-phone-member-pick" data-static="true">
                        <button
                            type="button"
                            className="mix-phone-pick-item"
                            data-on={!draft.personaId ? "true" : undefined}
                            onClick={() => setDraft({ ...draft, personaId: undefined })}
                        >
                            不使用
                        </button>
                        {personas.map((p) => (
                            <button
                                type="button"
                                key={p.id}
                                className="mix-phone-pick-item"
                                data-on={draft.personaId === p.id ? "true" : undefined}
                                onClick={() => setDraft({ ...draft, personaId: p.id })}
                            >
                                {p.userName?.trim() || p.name}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="mix-phone-set-section">
                    <div className="mix-phone-set-label">联动与节奏</div>
                    <label className="mix-phone-set-row">
                        <span>前情提要轮数（0 = 不带对局剧情）</span>
                        <input
                            type="number"
                            min={0}
                            max={30}
                            value={draft.settings.plotContextTurns}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, plotContextTurns: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>前情附「当前状态」行</span>
                        <input
                            type="checkbox"
                            checked={draft.settings.includeState}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, includeState: e.target.checked } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>心声（角色回复带内心独白）</span>
                        <input
                            type="checkbox"
                            checked={draft.settings.innerVoice}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, innerVoice: e.target.checked } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>聊天历史回传条数上限</span>
                        <input
                            type="number"
                            min={5}
                            max={200}
                            value={draft.settings.msgHistoryCap}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, msgHistoryCap: Math.max(5, Math.floor(Number(e.target.value) || 40)) } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>回复策略（多人时）</span>
                        <select
                            value={draft.settings.replyPolicy}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, replyPolicy: e.target.value as MixPhoneWorld["settings"]["replyPolicy"] } })}
                        >
                            <option value="mention">点名优先（默认）</option>
                            <option value="roundrobin">轮流回</option>
                            <option value="all">全员依次回</option>
                        </select>
                    </label>
                </div>

                <div className="mix-phone-set-section">
                    <div className="mix-phone-set-label">主动消息（角色自己来找你）</div>
                    <label className="mix-phone-set-row">
                        <span>开启</span>
                        <input
                            type="checkbox"
                            checked={draft.settings.proactive}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, proactive: e.target.checked } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>每 N 轮剧情判一次</span>
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={draft.settings.proactiveEveryRounds}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, proactiveEveryRounds: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })}
                        />
                    </label>
                    <label className="mix-phone-set-row">
                        <span>两次主动消息最小间隔（轮）</span>
                        <input
                            type="number"
                            min={0}
                            max={50}
                            value={draft.settings.proactiveCooldown}
                            onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, proactiveCooldown: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })}
                        />
                    </label>
                    {world.sessionId ? null : <div className="mix-phone-set-hint">独立世界没有对局剧情可看，主动消息不会触发</div>}
                </div>

                <div className="mix-sheet-actions">
                    <button type="button" className="mix-btn" onClick={onClose}>取消</button>
                    <button type="button" className="mix-btn" data-primary="true" onClick={save}>保存</button>
                </div>
            </div>
        </div>
    );
}
