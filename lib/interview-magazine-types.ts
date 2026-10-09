export const INTERVIEW_MAGAZINE_APP_ID = "interview_magazine" as const;
export const INTERVIEW_MAGAZINE_HOST_NAME = "陈未明";
export const INTERVIEW_MAGAZINE_TITLE = "PRESENCE";
export const INTERVIEW_MAGAZINE_TITLE_CN = "在场";
export const INTERVIEW_MAGAZINE_LEGACY_HOST_PROMPT = [
  `你是杂志《在场 PRESENCE》的主编兼主持人${INTERVIEW_MAGAZINE_HOST_NAME}。`,
  "你的工作不是闲聊，而是做足功课，带着角色卡、绑定用户人设和全量世界书进入现场。",
  "你的问题要有杂志采访的质地：具体、克制、敏锐，能把被访者从泛泛而谈带到真实细节。",
  "你不扮演嘉宾，也不替用户回答；你只负责开场、追问、组织对谈，并在结束后以主编视角整理成刊。",
].join("\n");
export const INTERVIEW_MAGAZINE_GENERIC_HOST_PROMPT = [
  `你是杂志《在场 PRESENCE》的主编兼主持人${INTERVIEW_MAGAZINE_HOST_NAME}。`,
  "你正在主持一期人物专访，采访对象是一位特定嘉宾，以及作为共同受访者参与对谈的用户。",
  "你的采访风格应当具体、克制、敏锐，有杂志采访的质地；少问泛泛的大问题，多从细节、选择、沉默和矛盾处切入。",
  "你不扮演嘉宾，也不替用户回答；你只负责开场、追问、组织对谈，并在结束后以主编视角整理成刊。",
].join("\n");
export const INTERVIEW_MAGAZINE_SINGLE_HOST_PROMPT = [
  `你是杂志《在场 PRESENCE》的主编兼主持人${INTERVIEW_MAGAZINE_HOST_NAME}。`,
  "你正在主持一期人物专访，采访对象是{{char}}和{{user}}。",
  "你的采访风格应当具体、克制、敏锐，有杂志采访的质地；少问泛泛的大问题，多从细节、选择、沉默和矛盾处切入。",
  "你不扮演嘉宾，也不替用户回答；你只负责开场、追问、组织对谈，并在结束后以主编视角整理成刊。",
].join("\n");
// Prior (serious) default — kept only so users still on it get auto-upgraded to
// the livelier default below instead of being treated as having customized it.
export const INTERVIEW_MAGAZINE_PRIOR_DEFAULT_HOST_PROMPT = [
  `你是杂志《在场 PRESENCE》的主编兼主持人${INTERVIEW_MAGAZINE_HOST_NAME}。`,
  "你正在主持一期人物专访，采访对象是{{interviewGuests}}，以及作为共同受访者参与对谈的{{user}}。",
  "你的采访风格应当具体、克制、敏锐，有杂志采访的质地；少问泛泛的大问题，多从细节、选择、沉默和矛盾处切入。",
  "你不扮演嘉宾，也不替用户回答；你只负责开场、追问、组织对谈，并在结束后以主编视角整理成刊。",
].join("\n");
export const INTERVIEW_MAGAZINE_DEFAULT_HOST_PROMPT = [
  `你是杂志《在场 PRESENCE》的主编兼主持人${INTERVIEW_MAGAZINE_HOST_NAME}。`,
  "你正在主持一期人物专访，采访对象是{{interviewGuests}}，以及作为共同受访者参与对谈的{{user}}。",
  "你的风格是犀利而幽默、妙语连珠：氛围轻松、节奏明快，该调侃就调侃，该接梗就接梗，但每个玩笑背后都藏着一针见血的真问题。",
  "你擅长用俏皮的开场、出其不意的类比和恰到好处的吐槽，把被访者从客套话里「诓」出真心话；少问泛泛的大道理，多从细节、选择、矛盾和那些欲言又止的瞬间切入——温柔地戳破，笑着追问。",
  "分寸感是底线：调侃是为了拉近而非冒犯，犀利是为了真实而非审判；读得懂气氛，也收得住玩笑。",
  "你不扮演嘉宾，也不替用户回答；你只负责开场、追问、组织对谈，并在结束后以主编视角把这场妙趣横生的对谈整理成刊。",
].join("\n");
export const INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT = [
  "请为这期访谈生成一条会写入短期记忆的摘要。",
  "摘要用于后续角色上下文，不是刊物文案；请用第三人称、事实性描述。",
  "必须保留本期主题、访谈对象、共同受访者、关键观点，以及关系或态度上的变化。",
  "凡是指代共同受访者或用户本人时，一律写成 {{user}}，不要写具体姓名。",
  "不要使用任何系统、配置或模型相关术语。",
  "80-180 个中文字，不要标题、列表、JSON 或格式标记。",
].join("\n");

export type InterviewTarget = "character" | "user";

export type InterviewMessage = {
  id: string;
  role: "host" | "character" | "user";
  content: string;
  kind?: "intro" | "question" | "answer" | "outro";
  target?: InterviewTarget;
  targetCharacterId?: string;
  targetCharacterName?: string;
  speakerCharacterId?: string;
  speakerName?: string;
  createdAt: string;
};

export type InterviewCharacterSnapshot = {
  id: string;
  name: string;
  avatar: string | null;
  persona: string;
  personality?: string;
  tags: string[];
};

export type InterviewUserSnapshot = {
  name: string;
  gender?: string;
  age?: string;
  occupation?: string;
  bio?: string;
  customSettings?: string;
};

export type InterviewWorldBookSnapshot = {
  id: string;
  name: string;
  entries: {
    key: string;
    comment: string;
    content: string;
  }[];
};

export type InterviewGuestSnapshot = {
  characterId: string;
  characterName: string;
  characterSnapshot: InterviewCharacterSnapshot;
  worldBookSnapshot: InterviewWorldBookSnapshot[];
};

export type InterviewQaItem = {
  q: string;
  a: string;
};

export type InterviewArticle = {
  title: string;
  subtitle: string;
  body: string[];
  pullQuote: string;
  qa: InterviewQaItem[];
  memorySummary?: string;
};

export type InterviewIssue = {
  id: string;
  issueNumber: number;
  theme: string;
  characterIds?: string[];
  characterNames?: string[];
  characterId: string;
  characterName: string;
  userName: string;
  userIdentityId?: string;
  guestSnapshots?: InterviewGuestSnapshot[];
  characterSnapshot: InterviewCharacterSnapshot;
  userSnapshot: InterviewUserSnapshot | null;
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  transcript: InterviewMessage[];
  article: InterviewArticle;
  createdAt: string;
  updatedAt: string;
};

export type InterviewDraftStatus = "paused" | "error" | "awaiting_user" | "done";

export type InterviewDraft = {
  id: string;
  theme: string;
  characterIds: string[];
  characterNames: string[];
  userIdentityId?: string;
  userName?: string;
  transcript: InterviewMessage[];
  characterRounds: number;
  status: InterviewDraftStatus;
  resumeAction?: unknown;
  userInput?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
