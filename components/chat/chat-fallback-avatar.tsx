"use client";

export const CHAT_FALLBACK_AVATAR_SRC = "/images/default-moment-avatar.png";

export function ChatFallbackAvatar({ alt = "", className = "" }: { alt?: string; className?: string }) {
    return (
        <img
            src={CHAT_FALLBACK_AVATAR_SRC}
            alt={alt}
            draggable={false}
            className={`feed-default-avatar w-full h-full object-cover ${className}`.trim()}
        />
    );
}
