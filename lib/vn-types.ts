export type VnFrame = {
  bg?: string;       // scene name (e.g. "教室走廊")
  sprite?: string;   // sprite key (e.g. "沈既川/微笑")
  speaker?: string;  // null = narration
  text: string;
  sourceMessageId?: string;
  sourceFrameIndex?: number;
  sourceRole?: VnMessage["role"];
  sourceCreatedAt?: string;
  voiceAudio?: VnFrameAudio;
};

export type VnOptions = { choices: string[] };

export type VnParsedResponse = {
  frames: VnFrame[];
  options: VnOptions | null;
  rawText: string;
};

export type VnBeat = {
  id: string;
  title: string;
  description?: string;
};

export type VnChapterMeta = {
  id: string;
  index: number;
  title: string;
  subtitle?: string;
  startMessageId: string;
  endMessageId?: string;   // null = active chapter
  archived: boolean;
  summaryContent?: string;
  summaryTimestamp?: string;
  beats?: VnBeat[];
  activeBeatIndex?: number;
};

export type VnLayoutPrefs = {
  dialogueY: number;
};

export type VnSession = {
  id: string;
  characterId: string;
  updatedAt: string;
  chapters: VnChapterMeta[];
  activeChapterIndex: number;
  lastMessageId?: string;
  lastMessagePreview?: string;
  layoutPrefs?: VnLayoutPrefs;
};

export type VnMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  rawContent: string;
  chapterIndex: number;
  createdAt: string;
  frameAudio?: Record<number, VnFrameAudio>;
};

export type VnFrameAudio = {
  audioDataUrl: string;
  synthesizedFromText: string;
  updatedAt: string;
};
