// lib/music-action-queue.ts — Queue user music operations, flush as system messages when chat is active

type MusicAction = {
    type: "playing" | "paused" | "skipped";
    trackTitle: string;
    trackArtist?: string;
    timestamp: number;
};

let _queue: MusicAction[] = [];
let _chatActive = false;
let _flushCallback: ((text: string) => void) | null = null;

/** Set whether the chat is currently visible (messages will be injected) */
export function setChatActive(active: boolean, flush?: (text: string) => void) {
    _chatActive = active;
    _flushCallback = flush ?? null;
    if (active && _queue.length > 0) {
        flushQueue();
    }
}

/** Push a music operation to the queue */
export function pushMusicAction(action: Omit<MusicAction, "timestamp">) {
    const entry: MusicAction = { ...action, timestamp: Date.now() };

    // Dedupe: replace consecutive same-type actions
    if (_queue.length > 0 && _queue[_queue.length - 1].type === entry.type) {
        _queue[_queue.length - 1] = entry;
    } else {
        _queue.push(entry);
    }

    // If chat is active, flush immediately
    if (_chatActive && _flushCallback) {
        flushQueue();
    }
}

/** Flush queued actions as system messages */
function flushQueue() {
    if (!_flushCallback || _queue.length === 0) return;

    for (const action of _queue) {
        const artist = action.trackArtist ? `-${action.trackArtist}` : "";
        let text = "";
        switch (action.type) {
            case "playing":
                text = `[用户正在听:${action.trackTitle}${artist}]`;
                break;
            case "paused":
                text = `[用户暂停了音乐]`;
                break;
            case "skipped":
                text = `[用户切歌到:${action.trackTitle}${artist}]`;
                break;
        }
        if (text) _flushCallback(text);
    }
    _queue = [];
}

/** Clear all pending actions */
export function clearMusicQueue() {
    _queue = [];
}
