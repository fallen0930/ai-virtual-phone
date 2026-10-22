"use client";

const CALL_STT_WARNING_HIDDEN_KEY = "ai_phone_call_stt_warning_hidden_v1";

export function isCallSttWarningHidden(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(CALL_STT_WARNING_HIDDEN_KEY) === "1";
    } catch {
        return false;
    }
}

export function hideCallSttWarningPermanently() {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CALL_STT_WARNING_HIDDEN_KEY, "1");
    } catch {
        // Ignore storage failures; the prompt can still be closed for this session.
    }
}

type CallSttWarningDialogProps = {
    title?: string;
    message?: string;
    onClose: () => void;
    onNeverShow: () => void;
};

export function CallSttWarningDialog({
    title = "语音识别提示",
    message = "未检测到可识别的语音，可能当前浏览器不支持语音识别、系统麦克风权限未开启，或麦克风没有输入，可点击中间麦克风按钮切换到文字输入模式以继续通话。",
    onClose,
    onNeverShow,
}: CallSttWarningDialogProps) {
    return (
        <div className="modal-overlay" role="presentation" onClick={onClose}>
            <div
                className="modal-dialog call-stt-warning-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="call-stt-warning-title"
                onClick={event => event.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="call-stt-warning-title" className="modal-title">{title}</h3>
                </div>
                <div className="modal-body">
                    <p>{message}</p>
                </div>
                <div className="modal-footer">
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose}>我知道了</button>
                    <button type="button" className="ui-btn ui-btn-primary" onClick={onNeverShow}>以后不再提示我</button>
                </div>
            </div>
        </div>
    );
}
