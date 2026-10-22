"use client";

import { useState } from "react";
import { loadChatContacts } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { Character } from "@/lib/character-types";
import { Input } from "@/components/ui/form";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";

type GroupCreateModalProps = {
    onClose: () => void;
    onCreate: (groupName: string, participantIds: string[], isSpectator: boolean) => void;
};

export function GroupCreateModal({ onClose, onCreate }: GroupCreateModalProps) {
    const [step, setStep] = useState<"pick" | "name">("pick");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [groupName, setGroupName] = useState("");
    const [isSpectator, setIsSpectator] = useState(false);

    const contacts = loadChatContacts();
    const chars = loadCharacters();

    const enriched = contacts
        .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
        .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];

    const toggle = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const selectedChars = [...selectedIds]
        .map(id => chars.find(c => c.id === id))
        .filter(Boolean) as Character[];

    const userName = resolveUserIdentity(undefined, "group_chat")?.name || "我";
    const defaultName = isSpectator
        ? selectedChars.map(c => c.name).join("、")
        : [...selectedChars.map(c => c.name), userName].join("、");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                {step === "pick" ? (
                    <>
                        <span className="modal-header-title">选择群成员</span>
                        {enriched.length === 0 ? (
                            <span className="menu-desc">暂无联系人，请先添加好友</span>
                        ) : (
                            <div className="chat-contact-list">
                                {enriched.map(c => {
                                    const isSelected = selectedIds.has(c.characterId);
                                    return (
                                        <div
                                            key={c.characterId}
                                            className="chat-contact-item"
                                            onClick={() => toggle(c.characterId)}
                                        >
                                            <div className="chat-contact-avatar" style={isSelected ? { outline: "3px solid var(--c-success)", outlineOffset: "2px" } : undefined}>
                                                {c.char.avatar ? (
                                                    <img src={c.char.avatar} alt="" />
                                                ) : (
                                                    <ChatFallbackAvatar />
                                                )}
                                            </div>
                                            <span className="chat-contact-name">{c.char.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {selectedIds.size >= 2 && (
                            <button
                                onClick={() => setStep("name")}
                                className="ui-btn ui-btn-success w-full"
                            >
                                下一步 ({selectedIds.size} 人)
                            </button>
                        )}
                        {selectedIds.size === 1 && (
                            <p className="ts-12 text-[var(--c-icon)] text-center m-0">至少选择 2 位成员</p>
                        )}
                    </>
                ) : (
                    <>
                        <span className="modal-header-title">群聊名称</span>
                        <div className="w-full">
                            <Input
                                autoFocus
                                value={groupName}
                                onChange={e => setGroupName(e.target.value)}
                                placeholder={defaultName || "请输入群名"}
                                className="ui-input w-full"
                            />
                        </div>
                        <div className="chat-contact-list">
                            {selectedChars.map(c => (
                                <div key={c.id} className="chat-contact-item">
                                    <div className="chat-contact-avatar">
                                        {c.avatar ? (
                                            <img src={c.avatar} alt="" />
                                        ) : (
                                            <ChatFallbackAvatar />
                                        )}
                                    </div>
                                    <span className="chat-contact-name">{c.name}</span>
                                </div>
                            ))}
                        </div>
                        <label
                            className="flex items-start gap-2 w-full cursor-pointer select-none"
                            onClick={() => setIsSpectator(prev => !prev)}
                        >
                            <input
                                type="checkbox"
                                checked={isSpectator}
                                onChange={() => {}}
                                className="mt-[3px] shrink-0"
                            />
                            <span className="ts-13 text-[var(--c-text)]">
                                围观模式：我不加入群聊
                                <span className="block ts-12 text-[var(--c-icon)]">只围观他们自己聊天，你不能发言，群主是第一位成员</span>
                            </span>
                        </label>
                        <div className="flex gap-2 w-full">
                            <button
                                onClick={() => setStep("pick")}
                                className="ui-btn ui-btn-ghost flex-1"
                            >
                                返回
                            </button>
                            <button
                                onClick={() => onCreate(groupName.trim() || defaultName, [...selectedIds], isSpectator)}
                                className="ui-btn ui-btn-success flex-1"
                            >
                                创建
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
