// lib/contact-card.ts
// 「推荐联系人」名片的解析辅助：名字 → 推荐人同世界角色的实时解析、
// 好友状态、生成档案所需的聊天语境摘录。
// 名片消息只存名字（contactCardName），渲染时实时解析——这样未建档的
// 名片在用户现场生成档案后，所有同名旧名片自动变为可添加状态。

import { loadCharacters } from "./character-storage";
import { loadChatContacts, loadChatMessages, type ChatMessage } from "./chat-storage";
import { loadCharacterWorldGroups } from "./character-world-storage";
import type { Character } from "./character-types";

export function normalizeContactName(name: string): string {
    return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export type ResolvedContactCard = {
    /** 同世界按名匹配到的角色；null = 未建档 */
    character: Character | null;
    /** 已是用户好友（在联系人列表里） */
    isContact: boolean;
};

/** 按推荐人所在世界解析名片名字（别的世界允许同名，不跨界匹配）。 */
export function resolveContactCard(recommenderCharacterId: string, contactName: string): ResolvedContactCard {
    const normalized = normalizeContactName(contactName);
    if (!normalized) return { character: null, isContact: false };

    const characters = loadCharacters();
    const group = loadCharacterWorldGroups().find(g => g.memberIds.includes(recommenderCharacterId));
    const memberIds = new Set(group?.memberIds ?? []);
    const character = characters.find(c =>
        memberIds.has(c.id) && normalizeContactName(c.name || "") === normalized
    ) ?? null;

    if (!character) return { character: null, isContact: false };
    const isContact = loadChatContacts().some(contact => contact.characterId === character.id);
    return { character, isContact };
}

function messageHistoryLine(msg: ChatMessage, recommenderName: string): string | null {
    if (msg.role !== "user" && msg.role !== "assistant") return null;
    const speaker = msg.role === "user" ? "用户" : recommenderName;
    const text = (msg.content || msg.mediaData?.label || "").trim();
    if (!text) return null;
    return `${speaker}：${text.slice(0, 200)}`;
}

/** 截取名片消息前后的对话摘录，作为生成该角色人设的语境素材。 */
export function buildChatContextExcerpt(
    sessionId: string,
    cardMessageId: string,
    recommenderName: string,
    maxMessages = 12,
    maxChars = 1400,
): string {
    const messages = loadChatMessages(sessionId);
    if (messages.length === 0) return "";
    const cardIndex = messages.findIndex(m => m.id === cardMessageId);
    // 名片消息之前的对话（含名片后紧跟的一两条，推荐语常拆在名片前后）
    const end = cardIndex === -1 ? messages.length : Math.min(messages.length, cardIndex + 3);
    const start = Math.max(0, end - maxMessages);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
        const line = messageHistoryLine(messages[i], recommenderName);
        if (line) lines.push(line);
    }
    let excerpt = lines.join("\n");
    if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
    return excerpt;
}
