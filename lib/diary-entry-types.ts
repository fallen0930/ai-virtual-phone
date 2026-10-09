export type DiaryEntryTrigger = "manual" | "timer";

export type DiaryEntryTodoItem = {
  text: string;
  done: boolean;
};

export type DiaryEntryBlock =
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "correction"; text: string; replacement?: string }
  | { type: "todo"; title?: string; items: DiaryEntryTodoItem[] }
  | { type: "image"; caption?: string; description: string };

export type DiaryEntry = {
  id: string;
  characterId: string;
  characterName: string;
  title: string;
  dateLabel: string;
  mood: string;
  weather: string;
  tags: string[];
  body: string;
  blocks: DiaryEntryBlock[];
  trigger: DiaryEntryTrigger;
  createdAt: string;
  updatedAt: string;
};

export type DiaryEntryInput = {
  characterId: string;
  characterName: string;
  title: string;
  dateLabel?: string;
  mood?: string;
  weather?: string;
  tags?: string[];
  body: string;
  blocks: DiaryEntryBlock[];
  trigger?: DiaryEntryTrigger;
};

export type DiaryEntryTimerSettings = {
  enabled: boolean;
  intervalHours: number;
  characterIds: string[];
  lastRunAtByCharacter: Record<string, string>;
};

export const DEFAULT_DIARY_ENTRY_TIMER_SETTINGS: DiaryEntryTimerSettings = {
  enabled: false,
  intervalHours: 24,
  characterIds: [],
  lastRunAtByCharacter: {},
};
