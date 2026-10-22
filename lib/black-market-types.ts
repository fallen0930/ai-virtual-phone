export type BlackMarketTheaterSource = "builtin" | "community" | "local";

export type BlackMarketTheaterRarity = "common" | "rare" | "legend" | "encrypted";

export type BlackMarketTheaterStatus = "unused" | "active" | "used";

export type BlackMarketTransactionType =
  | "initial_grant"
  | "daily_checkin"
  | "purchase"
  | "creator_income"
  | "manual_adjust";

export type BlackMarketRenderRule = {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  className: string;
  template: string;
};

export type BlackMarketTheaterTemplate = {
  id: string;
  title: string;
  codeName: string;
  fileNumber?: string;
  subtitle: string;
  synopsis: string;
  storyText: string;
  tags: string[];
  rarity: BlackMarketTheaterRarity;
  glyph: string;
  price: number;
  authorId: string;
  authorName: string;
  source: BlackMarketTheaterSource;
  version: number;
  durationTurns: number;
  allowExternalControl: boolean;
  openingHtml: string;
  aiInstruction: string;
  outputContract: string;
  renderRules: BlackMarketRenderRule[];
  renderCss: string;
  memorySummaryPrompt: string;
  purchaseCount: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
};

export type BlackMarketOwnedTheater = {
  localId: string;
  remoteTemplateId: string;
  purchasedAt: string;
  templateSnapshot: BlackMarketTheaterTemplate;
  status: BlackMarketTheaterStatus;
  useCount: number;
  lastActivatedAt?: string;
  lastUsedAt?: string;
};

export type BlackMarketSceneMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type BlackMarketSceneSessionStatus = "active" | "ended";

export type BlackMarketSceneSession = {
  id: string;
  localTheaterId: string;
  templateId: string;
  title: string;
  characterId: string;
  characterName: string;
  userName: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  status: BlackMarketSceneSessionStatus;
  messages: BlackMarketSceneMessage[];
  summary?: string;
  summaryWrittenAt?: string;
};

export type BlackMarketTheaterProjectionEntry = {
  id: string;
  sessionId: string;
  characterId: string;
  timestamp: string;
  content: string;
  theaterTitle: string;
};

export type ActiveBlackMarketTheater = {
  instanceId: string;
  localTheaterId: string;
  templateId: string;
  title: string;
  targetCharacterId?: string;
  targetCharacterName?: string;
  chatId: string;
  startedAtMessageId?: string;
  startedAt: string;
  aiInstruction: string;
  outputContract: string;
  renderRules: BlackMarketRenderRule[];
  renderCss: string;
  memorySummaryPrompt: string;
  remainingTurns: number;
  status: "active" | "ending";
};

export type BlackMarketTransaction = {
  id: string;
  type: BlackMarketTransactionType;
  amount: number;
  title: string;
  detail: string;
  theaterId?: string;
  theaterTitle?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  balanceAfter: number;
  createdAt: string;
};

export type BlackMarketWalletState = {
  userId: string;
  displayName: string;
  balance: number;
  lastCheckinDate?: string;
  transactions: BlackMarketTransaction[];
  updatedAt: string;
};

export type BlackMarketState = {
  wallet: BlackMarketWalletState;
  ownedTheaters: BlackMarketOwnedTheater[];
  activeTheaters: ActiveBlackMarketTheater[];
  updatedAt: string;
};

export type BlackMarketPurchaseResult = {
  ok: boolean;
  state: BlackMarketState;
  ownedTheater?: BlackMarketOwnedTheater;
  transaction?: BlackMarketTransaction;
  error?: string;
};

export type BlackMarketCheckinResult = {
  ok: boolean;
  state: BlackMarketState;
  transaction?: BlackMarketTransaction;
  error?: string;
};
