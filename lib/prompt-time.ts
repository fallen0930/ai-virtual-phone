import { loadChatAppSettings } from "./chat-storage";
import { formatZonedPromptTimestamp, getSystemTimeZone } from "./character-time";

const PROMPT_TIMESTAMP_PATTERN = "\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}";
const PROMPT_TIMESTAMP_WITH_ZONE_PATTERN = `${PROMPT_TIMESTAMP_PATTERN}(?:\\s+[^)）\\]]+)?`;
const PROMPT_EVENT_LABEL_PATTERN = [
  "私聊",
  "群聊「[^」]*」",
  "朋友圈",
  "事件",
  "跑团游戏",
  "小游戏",
  "便签墙",
  "小红书",
  "访谈",
  "共创",
  "小剧场",
  "查手机",
  "共读",
].join("|");

export type PromptTimestampOptions = {
  timeZone?: string;
  includeTimeZone?: boolean;
};

export function getPromptTimestampOptionsForTimeContext(
  context: { hasDifference: boolean; systemTimeZone: string },
): PromptTimestampOptions | undefined {
  return context.hasDifference
    ? { timeZone: context.systemTimeZone, includeTimeZone: true }
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolvePromptTimeAware(value?: boolean): boolean {
  if (typeof value === "boolean") return value;
  return loadChatAppSettings().timeAware !== false;
}

export function formatPromptTimestamp(isoStr: string, options?: PromptTimestampOptions): string {
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return "";
  if (options?.timeZone || options?.includeTimeZone) {
    const timeZone = options.timeZone || getSystemTimeZone();
    return `(${formatZonedPromptTimestamp(date, timeZone, options.includeTimeZone === true)})`;
  }
  const pad = (n: number) => n < 10 ? `0${n}` : `${n}`;
  return `(${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())})`;
}

export function formatPromptEventLabel(label: string, timestamp: string, timeAware?: boolean, timestampOptions?: PromptTimestampOptions): string {
  const enabled = resolvePromptTimeAware(timeAware);
  if (!enabled) return `[${label}]`;
  const formatted = formatPromptTimestamp(timestamp, timestampOptions);
  return formatted ? `[${label} ${formatted}]` : `[${label}]`;
}

export function stripPromptEventTimestamps(text: string): string {
  if (!text) return text;
  let next = text.replace(
    new RegExp(`(^|\\n)\\[(${PROMPT_EVENT_LABEL_PATTERN})\\s*[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\]`, "g"),
    "$1[$2]",
  );
  next = next.replace(
    new RegExp(`(^|\\n)(\\s*💬\\s*)[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\s*`, "g"),
    "$1$2",
  );
  next = next.replace(
    new RegExp(`(^|\\n)(\\s*↳\\s*)[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\s*`, "g"),
    "$1$2",
  );
  return next;
}

export function formatStoredPromptEventContent(
  content: string,
  options: { label: string; timestamp: string; timeAware?: boolean; timestampOptions?: PromptTimestampOptions },
): string {
  const enabled = resolvePromptTimeAware(options.timeAware);
  if (!enabled) return stripPromptEventTimestamps(content);

  const formatted = formatPromptTimestamp(options.timestamp, options.timestampOptions);
  if (!formatted) return content;

  const labelPattern = escapeRegExp(options.label);
  const timestampedHead = new RegExp(`^\\[${labelPattern}\\s*[（(]${PROMPT_TIMESTAMP_WITH_ZONE_PATTERN}[)）]\\]`);
  if (timestampedHead.test(content)) return content.replace(timestampedHead, `[${options.label} ${formatted}]`);

  return content.replace(new RegExp(`^\\[${labelPattern}\\]`), `[${options.label} ${formatted}]`);
}
