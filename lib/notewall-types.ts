export const NOTE_WALL_BOARD_ID = "global";

export type NoteWallAuthorType = "user" | "character";
export type NoteWallSize = "small" | "medium" | "large";

export type NoteWallBoard = {
  id: string;
  title: string;
  width: number;
  height: number;
  createdAt?: string;
  updatedAt?: string;
};

export type NoteWallNote = {
  id: string;
  boardId: string;
  authorType: NoteWallAuthorType;
  authorId: string;
  authorName: string;
  isAnonymous: boolean;
  /** Stored as summary for compatibility, displayed and prompted as the note title. */
  summary: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: NoteWallSize;
  paper: string;
  tape: string;
  font: string;
  decoration: string;
  rawCss: string;
  safeStyle: Record<string, string>;
  commentCount: number;
  createdBy?: string;
  updatedBy?: string;
  deletedBy?: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteWallNoteInput = {
  boardId?: string;
  authorType: NoteWallAuthorType;
  authorId: string;
  authorName: string;
  /** Stored as summary for compatibility, displayed and prompted as the note title. */
  summary: string;
  body: string;
  x: number;
  y: number;
  size?: NoteWallSize;
  paper?: string;
  tape?: string;
  font?: string;
  decoration?: string;
  rawCss?: string;
  isAnonymous?: boolean;
  actorId?: string;
};

export type NoteWallNotePatch = Partial<Pick<
  NoteWallNoteInput,
  "summary" | "body" | "x" | "y" | "size" | "paper" | "tape" | "font" | "decoration" | "rawCss" | "isAnonymous" | "actorId"
>> & {
  id: string;
};

export type NoteWallComment = {
  id: string;
  noteId: string;
  authorId: string;
  authorName: string;
  body: string;
  isAnonymous: boolean;
  createdBy?: string;
  deletedBy?: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteWallCommentInput = {
  noteId: string;
  authorType?: NoteWallAuthorType;
  authorId: string;
  authorName: string;
  body: string;
  isAnonymous?: boolean;
  actorId?: string;
};

export type NoteWallTimerSettings = {
  enabled: boolean;
  intervalMinutes: number;
  characterIds: string[];
  lastRunAtByCharacter: Record<string, string>;
};

export const NOTE_WALL_SIZE_PRESETS: Record<NoteWallSize, { width: number; height: number }> = {
  small: { width: 164, height: 132 },
  medium: { width: 208, height: 164 },
  large: { width: 260, height: 206 },
};

export const DEFAULT_NOTE_WALL_BOARD: NoteWallBoard = {
  id: NOTE_WALL_BOARD_ID,
  title: "便签墙",
  width: 1600,
  height: 1200,
};
