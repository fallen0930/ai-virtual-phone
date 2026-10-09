"use client";

// 名片「现场建档」流程：AI 推荐了一个档案库里没有的人 → 弹窗确认 →
// 按名字+聊天语境生成人设 → 可编辑预览 → 确认写入（与角色 app 生成配角
// 共用 materializeSupportingCharacter 落库）。

import { useState } from "react";
import {
    generateNamedSupportingCharacter,
    materializeSupportingCharacter,
    type GeneratedSupportingCharacter,
} from "@/lib/npc-generator";
import { buildChatContextExcerpt, resolveContactCard } from "@/lib/contact-card";
import { Loader2 } from "lucide-react";

type FlowStep = "confirm" | "generating" | "preview";

export function ContactCardGenerateFlow({
    recommenderCharacterId,
    recommenderName,
    contactName,
    sessionId,
    messageId,
    onClose,
    onCreated,
}: {
    recommenderCharacterId: string;
    recommenderName: string;
    contactName: string;
    sessionId: string;
    messageId: string;
    onClose: () => void;
    /** 写入完成（或发现已存在档案）后回调，气泡借此刷新解析状态 */
    onCreated: () => void;
}) {
    const [step, setStep] = useState<FlowStep>("confirm");
    const [draft, setDraft] = useState<GeneratedSupportingCharacter | null>(null);
    const [error, setError] = useState("");

    const patch = (partial: Partial<GeneratedSupportingCharacter>) => {
        setDraft(prev => (prev ? { ...prev, ...partial } : prev));
    };

    async function handleGenerate() {
        setStep("generating");
        setError("");
        try {
            const chatContext = buildChatContextExcerpt(sessionId, messageId, recommenderName);
            const generated = await generateNamedSupportingCharacter(recommenderCharacterId, contactName, chatContext);
            setDraft(generated);
            setStep("preview");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStep(draft ? "preview" : "confirm");
        }
    }

    function handleConfirmWrite() {
        if (!draft) return;
        // 防重：写入前再查一次（用户可能刚好手动建了同名角色）
        const existing = resolveContactCard(recommenderCharacterId, contactName);
        if (!existing.character) {
            materializeSupportingCharacter(draft, recommenderCharacterId, { allowAutoPost: false });
        }
        onCreated();
        onClose();
    }

    return (
        <div className="modal-overlay" onClick={step === "generating" ? undefined : onClose}>
            <div className="modal-dialog contact-card-flow-dialog" onClick={e => e.stopPropagation()}>
                {step === "confirm" && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">生成角色档案</div>
                        <p className="ts-13 text-[var(--c-text)] opacity-80 leading-relaxed">
                            档案库里还没有「{contactName}」。要根据{recommenderName}的推荐语境，为 TA 生成人设档案吗？
                        </p>
                        <p className="ts-11 text-[var(--c-text)] opacity-50 leading-relaxed">
                            生成后可编辑确认；写入档案库后即可添加 TA 为好友。
                        </p>
                        {error && <p className="ts-12" style={{ color: "var(--c-danger, #d33)" }}>{error}</p>}
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={onClose}>取消</button>
                            <button className="ui-btn ui-btn-success flex-1" onClick={handleGenerate}>生成人设</button>
                        </div>
                    </>
                )}

                {step === "generating" && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">生成角色档案</div>
                        <div className="flex flex-col items-center gap-3 py-6">
                            <Loader2 size={26} className="animate-spin" style={{ color: "var(--c-icon)" }} />
                            <span className="ts-12 text-[var(--c-text)] opacity-60">正在根据聊天语境为「{contactName}」生成人设…</span>
                        </div>
                    </>
                )}

                {step === "preview" && draft && (
                    <>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)]">确认「{contactName}」的档案</div>
                        <div className="contact-card-flow-fields">
                            <label className="contact-card-flow-label">人设（完整角色卡）</label>
                            <textarea
                                className="ui-input contact-card-flow-textarea"
                                style={{ minHeight: 140 }}
                                value={draft.persona}
                                onChange={e => patch({ persona: e.target.value })}
                            />
                            <label className="contact-card-flow-label">性格</label>
                            <input
                                className="ui-input"
                                value={draft.personality}
                                onChange={e => patch({ personality: e.target.value })}
                            />
                            <label className="contact-card-flow-label">简量人设（注入给同世界角色）</label>
                            <textarea
                                className="ui-input contact-card-flow-textarea"
                                style={{ minHeight: 72 }}
                                value={draft.briefPersona}
                                onChange={e => patch({ briefPersona: e.target.value })}
                            />
                            <div className="flex gap-2">
                                <div className="flex-1 flex flex-col gap-1">
                                    <label className="contact-card-flow-label">TA 是{recommenderName}的</label>
                                    <input className="ui-input" value={draft.relationLabel} onChange={e => patch({ relationLabel: e.target.value })} />
                                </div>
                                <div className="flex-1 flex flex-col gap-1">
                                    <label className="contact-card-flow-label">{recommenderName}是 TA 的</label>
                                    <input className="ui-input" value={draft.reverseRelationLabel} onChange={e => patch({ reverseRelationLabel: e.target.value })} />
                                </div>
                            </div>
                        </div>
                        {error && <p className="ts-12" style={{ color: "var(--c-danger, #d33)" }}>{error}</p>}
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={onClose}>取消</button>
                            <button className="ui-btn ui-btn-outline flex-1" onClick={handleGenerate}>重新生成</button>
                            <button
                                className="ui-btn ui-btn-success flex-1"
                                disabled={!draft.persona.trim()}
                                onClick={handleConfirmWrite}
                            >
                                写入档案
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
