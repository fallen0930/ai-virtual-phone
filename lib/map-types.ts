// lib/map-types.ts
// RPG Map Mode — all type definitions

// ── Character Stats (CoC-style, 1-100) ──
export type StatKey = "str" | "con" | "dex" | "int" | "per" | "cha" | "lck";
export type CharStats = Record<StatKey, number>;
export const STAT_LABELS: Record<StatKey, string> = {
  str: "力量", con: "体质", dex: "敏捷", int: "智力", per: "感知", cha: "魅力", lck: "运气",
};
export const ALL_STATS: StatKey[] = ["str", "con", "dex", "int", "per", "cha", "lck"];

// ── Node Content (NPC + quest + encounter bound to specific node) ──
export type NodeContent = {
  name: string;
  npc?: { name: string; personality: string; role: string };
  quest?: { id: string; title: string; brief: string };
  encounter?: { id: string; brief: string; mood: string };
};

// ── World Generation Input (sent to map engine for rendering) ──
export type MapRegionInput = {
  id: string;
  l1_name_cn: string;
  l1_name_en: string;
  geography: "mountainous" | "plains" | "canyon";
  river_count: number;
  adjacent_to: string[];
  l2_nodes: string[];  // name-only for map engine
  l3_nodes: string[];  // name-only for map engine
};

export type WorldSkeletonInput = {
  map_settings: { header: string; title: string };
  regions: MapRegionInput[];
  seed?: number;
};

// ── Rich Region Data (LLM output — nodes with content) ──
export type RichRegion = {
  id: string;
  l1_name_cn: string;
  l1_name_en: string;
  geography: "mountainous" | "plains" | "canyon";
  river_count: number;
  adjacent_to: string[];
  l1_npc?: { name: string; personality: string; role: string };
  l1_quest?: { id: string; title: string; brief: string };
  l2_nodes: NodeContent[];
  l3_nodes: NodeContent[];
};

// ── World Skeleton (LLM output) ──
export type QuestStage = {
  locationHint: string;       // specific node name
  brief: string;
  unlockHint?: string;
};

export type QuestLine = {
  id: string;
  title: string;
  type: "main" | "side";
  synopsis: string;
  triggerRegion: string;
  stages: QuestStage[];
};

// Legacy types kept for compatibility
export type WorldNPC = {
  id: string;
  name: string;
  personality: string;
  locationRegion: string;
  locationNode?: string;      // specific node name
  role: "quest" | "merchant" | "info" | "ambient" | "rival";
  relatedQuestIds: string[];
};

export type EncounterSeed = {
  id: string;
  brief: string;
  mood: "tense" | "warm" | "mysterious" | "humorous" | "romantic";
  locationTypes: string[];
  locationNode?: string;      // specific node name
};

export type WorldSkeleton = {
  world: {
    name: string;
    lore: string;
  };
  mapInput: WorldSkeletonInput;
  richRegions: RichRegion[];     // full node content (NPC/quest/encounter per node)
  mainQuest: QuestLine;
  sideQuests: QuestLine[];
  npcs: WorldNPC[];
  encounterPool: EncounterSeed[];
  partyStats: Record<string, CharStats>;
  dmDossier?: DMDossier;
};

// ── DM (Dungeon Master) System ──

/** DM's secret knowledge — the full truth behind the world */
export type DMDossier = {
  hiddenTruth: string;           // the big secret/twist of the main quest
  npcSecrets: Record<string, string>;  // npcId → their hidden agenda/secret
  foreshadowing: string[];       // clues to plant early
  plotTwist: string;             // what happens at the midpoint
  endgame: string;               // how the story can end
};

/** The living state of the story — grows as events happen */
export type StoryDirector = {
  // Main quest progress
  mainArc: {
    currentStage: number;
    stageResults: { stage: number; outcome: string; itemsGained: string[]; npcsInvolved: string[] }[];
  };
  // Side quest progress
  sideArcResults: Record<string, { status: "active" | "completed" | "failed"; outcome: string }>;
  // Accumulated state
  keyItems: string[];            // items/info the player has collected
  keyNpcsMet: string[];          // important NPCs the player has interacted with
  worldChanges: string[];        // things the player's actions have changed in the world
  // Narrative memory
  plantedClues: string[];        // foreshadowing clues that have been delivered
  unrevealedSecrets: string[];   // secrets not yet discovered
};

// ── Rendered Map Data (from map-engine.ts) ──
// Re-export from map-engine
export type { MapGenerationOutput } from "./map-engine";

// ── Game State ──
export type NodeInteraction = {
  type: "quest" | "sidequest" | "encounter" | "search" | "rest" | "shop" | "talk";
  label: string;
  questId?: string;
  available: boolean;
  icon: string;
};

export type JournalEntry = {
  id: string;
  timestamp: string;     // game time
  realTime: string;      // real timestamp
  locationName: string;
  text: string;
  type: "main" | "side" | "encounter" | "discovery" | "choice";
};

export type GameSave = {
  id: string;
  worldId: string;
  timestamp: string;

  // User (player) state
  currentNodeId: string;
  currentNodeType: "l1" | "l2" | "l3";
  discoveredNodes: string[];
  visitedNodes: string[];
  hp: number;
  maxHp: number;
  playerStats: CharStats;

  // Companion agents — each moves independently
  agents: CharacterAgent[];

  // World-level progress
  mainQuestStage: number;
  usedEncounterIds: string[];
  // DM story director — the living narrative state
  director: StoryDirector;
  gameDay: number;
  gameTime: "morning" | "afternoon" | "evening" | "night";

  // Shared history
  journal: JournalEntry[];       // combined log (user + all agents)
  keyChoices: string[];
  searchedNodes: Record<string, number>;
  checkedStats?: StatKey[];      // stats successfully used this event (for growth roll)
  streamLog?: StreamMessage[];   // text stream history (last 200)
  pendingEvent?: {               // restore event state on re-entry
    inEvent: boolean;
    choices?: EventChoice[];
    eventContext?: string;
    eventMeta?: { type: string; questId?: string };
    lastAction?: string;         // last player action (for retry on reload)
    interruptedPhase?: "companions" | "dm";
    completedCompanions?: string[];  // character IDs that already replied this round
  };
  checkpoint?: string;           // JSON snapshot of GameSave at save point (for death rollback)
  pacing?: "relaxed" | "normal" | "fast";  // narrative pacing preference
  completed?: boolean;           // main quest finished
};

// ── MapWorld (stored in IndexedDB) — world is independent of characters ──
export type MapWorld = {
  id: string;
  skeleton: WorldSkeleton;
  renderedMap: import("./map-engine").MapGenerationOutput;
  createdAt: string;
  updatedAt: string;
  status?: "generating" | "failed";
  statusMessage?: string;  // failure reason
  failureRaw?: string;     // raw LLM output on failure, for the failure dialog
};

// ── Character Agent State (per character in a world) ──
export type CharacterAgent = {
  characterId: string;
  currentNodeId: string;
  currentNodeType: "l1" | "l2" | "l3";
  discoveredNodes: string[];
  visitedNodes: string[];
  activeSideQuests: string[];
  completedSideQuests: string[];
  hp: number;
  maxHp: number;
  journal: JournalEntry[];
  affinity: number;            // towards user, 0-100
  stats: CharStats;
};

// ── Agent Skill System (like 小卷's skills) ──
export type AgentAction =
  | { type: "move"; targetNodeId: string }
  | { type: "search" }
  | { type: "rest" }
  | { type: "accept_quest"; questId: string }
  | { type: "talk_npc"; npcId: string }
  | { type: "contact_user"; message: string }
  | { type: "contact_agent"; targetCharacterId: string; message: string }
  | { type: "wait" }
  | { type: "join_user" }
  | { type: "leave_user" };

export type AgentDecision = {
  action: AgentAction;
  reasoning: string;           // why the agent chose this (for journal)
};

// ── Event Scene (LLM-expanded dialogue) ──
export type EventChoice = {
  label: string;
  statCheck?: { stat: StatKey; who?: string };  // who: "你"/角色名 = 指定掷骰人; 省略 = 随机
  requires?: string;           // item name required (e.g. "古老钥匙")
  consequence?: string;        // brief hint for journal
};

export type EventDialogue = {
  speaker: string;             // character name, NPC name, or "narrator"
  text: string;
  emotion?: string;            // for sprite selection
};

export type EventScene = {
  background?: string;         // scene description (for atmosphere)
  dialogues: EventDialogue[];
  choices?: EventChoice[];
  affinityDelta?: Record<string, number>;  // character affinity changes
  journalEntry?: string;       // auto-added to journal
  unlocks?: string[];          // node IDs to unlock/discover
  apCost?: number;
  advanceMainQuest?: boolean;
  completeSideQuest?: string;
};

export type StreamMessage = {
  id: string;
  type: "narration" | "npc" | "player" | "character" | "system" | "location" | "roll";
  speaker?: string;
  text: string;
  emotion?: string;
};

// Collect-Resolve-Narrate: a player or companion's declared action+speech per round
export type Declaration = {
  speaker: string;    // display name
  speech: string;     // what they say (to player/NPC/companion)
  action: string;     // what they do (physical action description)
  emotion?: string;   // for display
  affinityDelta?: number;  // -3 to +3, how the character's affinity toward user changed
  failed?: boolean;        // true if LLM call failed (not a deliberate silence)
};
