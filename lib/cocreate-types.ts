export const COCREATE_APP_ID = "cocreate" as const;

export type CoCreateMode = "write" | "discuss";

export type CoCreateMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  mode: CoCreateMode | "chapter";
  kind?: "tool" | "reasoning";
  content: string;
  authorName?: string;
  chapterId?: string;
  promptHidden?: boolean;
  rawResponseText?: string;
  nativeToolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  nativeToolResult?: { toolCallId: string; name: string; content: string };
  nativeToolReasoning?: string;
  nativeToolOpenRouterReasoningDetails?: unknown[];
  createdAt: string;
};

export type CoCreateCastMember = {
  id: string;
  name: string;
  nameEn: string;
  role: string;
  color: string;
  major: string;
  label: string;
  desc: string;
  secret?: string | null;
  secretHidden?: boolean;
  tags: string[];
};

export type CoCreateMemoryEntry = {
  text: string;
  archivedAt: string;
};

export type CoCreateChapter = {
  id: string;
  num: string;
  title: string;
  titleEn: string;
  words: number;
  content?: string;
  summary?: string;
  memoryEntries?: CoCreateMemoryEntry[];
  archiveNote?: string;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type CoCreateSettings = {
  recentFullTextChapters: number;
  disabledToolNames: string[];
  streamingEnabled: boolean;
  autoAccept: boolean;
  memorySummaryInterval: number;
};

export type CoCreateToolArtifactType = "index" | "fulltext" | "search" | "mutation" | "dossier" | "cast" | "notebook";

export type CoCreateToolArtifact = {
  id: string;
  toolName: string;
  resultType: CoCreateToolArtifactType;
  chapterId?: string;
  summary: string;
  rawResult?: string;
  createdTurn: number;
  expiresAfterTurns: number;
  createdAt: string;
};

export type CoCreateRevision = {
  id: string;
  chapterId: string;
  toolName: string;
  beforeTitle?: string;
  beforeTitleEn?: string;
  afterTitle?: string;
  afterTitleEn?: string;
  beforeContent?: string;
  afterContent?: string;
  summary: string;
  createdAt: string;
};

export type CoCreatePendingMutationOperation =
  | { type: "set_chapter"; chapterId: string; nextTitle?: string; nextTitleEn?: string; nextContent?: string }
  | { type: "create_chapter"; chapter: CoCreateChapter }
  | { type: "delete_chapter"; chapterId: string }
  | { type: "set_cast"; memberId: string; nextMember: CoCreateCastMember }
  | { type: "create_cast"; member: CoCreateCastMember }
  | { type: "delete_cast"; memberId: string }
  | { type: "set_dossier"; content: string }
  | { type: "set_notebook"; content: string };

export type CoCreatePendingMutation = {
  id: string;
  toolName: string;
  chapterId?: string;
  chapterNum?: string;
  chapterTitle?: string;
  summary: string;
  beforePreview?: string;
  afterPreview?: string;
  operation: CoCreatePendingMutationOperation;
  createdAt: string;
};

export type CoCreateBackendLog = {
  id: string;
  kind: "reply" | "archive";
  status: "success" | "error";
  title: string;
  mode?: CoCreateMode | "archive";
  chapterNum?: string;
  chapterTitle?: string;
  model?: string;
  presetName?: string;
  input?: string;
  output?: string;
  rawOutput?: string;
  rawOutputs?: string[];
  toolNotices?: string[];
  toolDebugs?: string[];
  error?: string;
  createdAt: string;
};

export type CoCreateSession = {
  id: string;
  title: string;
  subtitle: string;
  partnerCharacterId: string;
  activeChapterId: string;
  cast: CoCreateCastMember[];
  chapters: CoCreateChapter[];
  messages: CoCreateMessage[];
  rollingSummary?: string;
  turnsSinceSummary: number;
  lastMemorySummarizedAt?: string;
  settings: CoCreateSettings;
  toolTurn: number;
  toolArtifacts: CoCreateToolArtifact[];
  revisions: CoCreateRevision[];
  pendingMutations: CoCreatePendingMutation[];
  backendLogs: CoCreateBackendLog[];
  seenArchiveNoteChapterIds: string[];
  relationshipDossier?: string;
  writerNotebook?: string;
  createdAt: string;
  updatedAt: string;
};

export type CoCreateLibrary = {
  activeSessionId: string;
  sessions: CoCreateSession[];
  settings: CoCreateSettings;
};

export type CoCreateGenerationResult = {
  content: string;
  model: string;
  presetName: string;
  updatedSession?: CoCreateSession;
  toolNotices?: string[];
  toolDebugs?: string[];
  rawOutputs?: string[];
};
