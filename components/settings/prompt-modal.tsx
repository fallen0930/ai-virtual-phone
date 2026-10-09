import { useState, useEffect } from "react";

type PromptModalProps = {
    isOpen: boolean;
    title: string;
    description?: string;
    placeholder?: string;
    initialValue?: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
    confirmText?: string;
    cancelText?: string;
};

export function PromptModal({
    isOpen,
    title,
    description,
    placeholder = "",
    initialValue = "",
    onConfirm,
    onCancel,
    confirmText = "确定",
    cancelText = "取消"
}: PromptModalProps) {
    const [value, setValue] = useState(initialValue);

    useEffect(() => {
        if (isOpen) {
            setValue(initialValue);
        }
    }, [isOpen, initialValue]);

    if (!isOpen) return null;

    return (
        <div className="modal-overlay">
            <div
                className="rounded-[14px] w-[270px] flex flex-col"
                style={{
                    backgroundColor: "var(--c-input)",
                    padding: "20px 16px 0",
                    boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
                    animation: "scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
                }}
            >
                <div className="text-center mb-4">
                    <h3 className="m-0 ts-17 font-semibold" style={{ color: "var(--c-text)" }}>{title}</h3>
                    {description && <p className="ts-13" style={{ margin: "4px 0 0", color: "var(--c-text)" }}>{description}</p>}
                </div>

                <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={placeholder}
                    className="ui-input mb-4"
                    style={{ padding: "6px 8px", fontSize: "calc(14px*var(--app-text-scale,1))" }}
                    autoFocus
                />

                <div
                    className="flex"
                    style={{
                        borderTop: "0.5px solid var(--c-panel-border)",
                        margin: "0 -16px"
                    }}
                >
                    <button
                        onClick={onCancel}
                        className="flex-1 bg-none border-none ts-17 cursor-pointer font-normal"
                        style={{
                            padding: "12px 0",
                            borderRight: "0.5px solid var(--c-panel-border)",
                            color: "var(--c-icon-active)"
                        }}
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={() => { onConfirm(value); onCancel(); }}
                        className="flex-1 bg-none border-none ts-17 cursor-pointer font-semibold"
                        style={{ padding: "12px 0", color: "var(--c-icon-active)" }}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
            <style>{`
                @keyframes scaleIn { from { transform: scale(1.1); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            `}</style>
        </div>
    );
}
