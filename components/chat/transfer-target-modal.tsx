"use client";

import type { Character } from "@/lib/character-types";
import { User } from "lucide-react";

type TransferTargetModalProps = {
    participants: Character[];
    onSelect: (char: Character) => void;
    onClose: () => void;
};

export function TransferTargetModal({ participants, onSelect, onClose }: TransferTargetModalProps) {
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-dialog"
                onClick={e => e.stopPropagation()}
            >
                <div className="text-center ts-15 font-medium text-[var(--c-text-title)] mb-1">
                    选择收款人
                </div>
                <div className="flex flex-col gap-0.5 max-h-[40vh] overflow-y-auto -mx-2">
                    {participants.map(char => (
                        <button
                            key={char.id}
                            onClick={() => onSelect(char)}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[var(--c-input)] active:bg-[var(--c-input)] transition-colors text-left w-full"
                        >
                            <div className="w-[36px] h-[36px] rounded-full bg-[var(--c-input)] overflow-hidden shrink-0 flex items-center justify-center">
                                {char.avatar ? (
                                    <img src={char.avatar} className="w-full h-full object-cover" alt="" />
                                ) : (
                                    <User size={18} color="var(--c-icon)" />
                                )}
                            </div>
                            <span className="ts-15 text-[var(--c-text)]">{char.name}</span>
                        </button>
                    ))}
                </div>
                <button
                    onClick={onClose}
                    className="w-full py-2 rounded-xl bg-[var(--c-input)] text-[var(--c-text)] ts-14 mt-1"
                >
                    取消
                </button>
            </div>
        </div>
    );
}
