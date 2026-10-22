// lib/music-listen-together.ts — 「一起听」核心逻辑
// 选角色陪听歌：角色按人设评价当前歌曲，并可自主决定是否切歌。
// LLM 调用沿用 brief-persona 的模式：simpleLLMCall + 角色聊天绑定解析 API 配置，
// 不走预设系统组装（角色扮演预设会污染这类结构化/短评任务）。

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { renderUserNameMacro } from "./user-macro";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { ApiConfig } from "./settings-types";
import type { Character } from "./character-types";
import type { MusicTrack } from "./music-storage";

// ── Types ──

export type ListenTogetherAction = "comment" | "skip" | "keep";

export type ListenTogetherMessage = {
    characterId: string;
    characterName: string;
    characterAvatar: string | null;
    action: ListenTogetherAction;
    content: string;
    createdAt: string; // ISO
};

const HISTORY_KEY = "music-listen-together-v1";
const SELECTED_KEY = "music-listen-together-selected-v1";
registerKvMigration(HISTORY_KEY);
registerKvMigration(SELECTED_KEY);

const PER_TRACK_CAP = 50; // 每首歌最多保留的条数
const TRACK_CAP = 30;     // 最多保留多少首歌的历史

// ── Persistence ──

type HistoryMap = Record<string, ListenTogetherMessage[]>;

function loadHistoryMap(): HistoryMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(HISTORY_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as HistoryMap;
    } catch {
        return {};
    }
}

function persistHistoryMap(map: HistoryMap): void {
    try {
        // 超出歌曲数上限时淘汰最早写入的（对象键序即插入序）
        const keys = Object.keys(map);
        const trimmed: HistoryMap = {};
        for (const key of keys.slice(-TRACK_CAP)) {
            trimmed[key] = map[key].slice(-PER_TRACK_CAP);
        }
        kvSet(HISTORY_KEY, JSON.stringify(trimmed));
    } catch { /* ignore */ }
}

/** 读取某首歌的评价历史（按时间正序） */
export function loadListenHistory(trackId: string): ListenTogetherMessage[] {
    const list = loadHistoryMap()[trackId];
    return Array.isArray(list) ? list : [];
}

/** 追加一条消息到某首歌的历史下 */
export function appendListenHistory(trackId: string, message: ListenTogetherMessage): void {
    const map = loadHistoryMap();
    const prev = Array.isArray(map[trackId]) ? map[trackId] : [];
    map[trackId] = [...prev, message].slice(-PER_TRACK_CAP);
    persistHistoryMap(map);
    // 点评同步进角色×歌的情绪记忆（保留最近两句，供下次做"缘分"回灌）
    if (message.action === "comment" && message.content?.trim()) {
        updateMoodEntry(message.characterId, trackId, m => ({
            ...m,
            lastComments: [...m.lastComments, message.content.trim()].slice(-MOOD_COMMENT_KEEP),
        }));
    }
}

/** 记住用户上次选择的角色，下次开面板自动勾上 */
export function loadSelectedCharacterIds(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(SELECTED_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
    } catch {
        return [];
    }
}

export function saveSelectedCharacterIds(ids: string[]): void {
    try { kvSet(SELECTED_KEY, JSON.stringify(ids.slice(0, 12))); } catch { /* ignore */ }
}

// ── 一起听会话设置（角色 + 随机发言间隔） ──

const SESSION_KEY = "music-listen-together-session-v1";
registerKvMigration(SESSION_KEY);

export type ListenSession = {
    active: boolean;
    characterIds: string[];
    /** 随机自动发言的最小间隔（秒） */
    intervalMin: number;
    /** 随机自动发言的最大间隔（秒） */
    intervalMax: number;
};

export const DEFAULT_LISTEN_SESSION: ListenSession = {
    active: false,
    characterIds: [],
    intervalMin: 8,
    intervalMax: 20,
};

export function loadListenSession(): ListenSession {
    if (typeof window === "undefined") return { ...DEFAULT_LISTEN_SESSION };
    try {
        const raw = kvGet(SESSION_KEY);
        if (!raw) return { ...DEFAULT_LISTEN_SESSION };
        const parsed = JSON.parse(raw) as Partial<ListenSession>;
        const min = Number(parsed.intervalMin);
        const max = Number(parsed.intervalMax);
        return {
            active: parsed.active === true,
            characterIds: Array.isArray(parsed.characterIds)
                ? parsed.characterIds.filter((v): v is string => typeof v === "string")
                : [],
            intervalMin: Number.isFinite(min) && min > 0 ? min : DEFAULT_LISTEN_SESSION.intervalMin,
            intervalMax: Number.isFinite(max) && max >= min ? max : DEFAULT_LISTEN_SESSION.intervalMax,
        };
    } catch {
        return { ...DEFAULT_LISTEN_SESSION };
    }
}

export function saveListenSession(session: ListenSession): void {
    try { kvSet(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

// ── 情绪记忆（只记可观测行为信号，不做主观情绪推断） ──
// 记录：这首歌一起听过几次 / 角色上次对它说过什么 / 角色提过几次切歌、被拒几次。
// 这些会喂回 prompt，让角色的态度有连续性，而不是每首都像第一次听。

const MOOD_KEY = "music-listen-together-mood-v1";
registerKvMigration(MOOD_KEY);

export type CharacterTrackMood = {
    listens: number;        // 一起听会话里听到这首歌的次数
    lastHeardAt: string;    // ISO
    lastComments: string[]; // 角色对这首歌最近两句点评
    skipWants: number;      // 角色对这首歌表达过想切的次数（含被拒的）
    deniedSkips: number;    // 其中被用户拒绝的次数
};

type MoodStore = Record<string, Record<string, CharacterTrackMood>>; // characterId -> trackId -> mood

const MOOD_ENTRY_CAP = 300;   // 全部角色的 角色×歌 条目上限
const MOOD_COMMENT_KEEP = 2;  // 每对 角色×歌 保留的点评条数

function loadMoodStore(): MoodStore {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(MOOD_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as MoodStore;
    } catch {
        return {};
    }
}

function saveMoodStore(store: MoodStore): void {
    try {
        // 展平后按 lastHeardAt 保留最新的 MOOD_ENTRY_CAP 条
        const flat: Array<{ cid: string; tid: string; mood: CharacterTrackMood }> = [];
        for (const [cid, byTrack] of Object.entries(store)) {
            for (const [tid, mood] of Object.entries(byTrack)) {
                flat.push({ cid, tid, mood });
            }
        }
        if (flat.length > MOOD_ENTRY_CAP) {
            flat.sort((a, b) => Date.parse(b.mood.lastHeardAt) - Date.parse(a.mood.lastHeardAt));
            flat.length = MOOD_ENTRY_CAP;
        }
        const trimmed: MoodStore = {};
        for (const { cid, tid, mood } of flat) {
            (trimmed[cid] ??= {})[tid] = mood;
        }
        kvSet(MOOD_KEY, JSON.stringify(trimmed));
    } catch { /* ignore */ }
}

function getMoodEntry(characterId: string, trackId: string): CharacterTrackMood | null {
    return loadMoodStore()[characterId]?.[trackId] ?? null;
}

function updateMoodEntry(
    characterId: string,
    trackId: string,
    patch: (mood: CharacterTrackMood) => CharacterTrackMood,
): void {
    const store = loadMoodStore();
    const now = new Date().toISOString();
    const prev = store[characterId]?.[trackId] ?? {
        listens: 0, lastHeardAt: now, lastComments: [], skipWants: 0, deniedSkips: 0,
    };
    const next = patch(prev);
    (store[characterId] ??= {})[trackId] = { ...next, lastHeardAt: now };
    saveMoodStore(store);
}

/** 一起听会话里听到这首歌（每个 角色×歌 在一次会话内只应记一次，由调用方去重） */
export function markListenHeard(characterIds: string[], trackId: string): void {
    for (const cid of characterIds) {
        updateMoodEntry(cid, trackId, m => ({ ...m, listens: m.listens + 1 }));
    }
}

/** 角色对这首歌表达了想切（无论最终切没切） */
export function markSkipWanted(characterId: string, trackId: string): void {
    updateMoodEntry(characterId, trackId, m => ({ ...m, skipWants: m.skipWants + 1 }));
}

/** 用户拒绝了切歌提议（对本轮所有提议者记账） */
export function markSkipDenied(characterIds: string[], trackId: string): void {
    for (const cid of characterIds) {
        updateMoodEntry(cid, trackId, m => ({ ...m, deniedSkips: m.deniedSkips + 1 }));
    }
}

/** 把角色的"缘分"组装成 prompt 片段；第一次听这首歌时不占 token，返回空串 */
function buildMoodBlock(character: Character, trackId: string, userLabel: string): string {
    const mood = getMoodEntry(character.id, trackId);
    if (!mood) return "";
    const lines: string[] = [];
    if (mood.listens > 1) {
        lines.push(`你和${userLabel}已经一起听过这首歌 ${mood.listens} 次了。`);
    }
    if (mood.deniedSkips > 0) {
        lines.push(`你这歌提过 ${mood.skipWants} 次想切，被${userLabel}拒了 ${mood.deniedSkips} 次——这次除非真的忍不了，别再主动提。`);
    }
    if (lines.length === 0) return "";
    return `【你和这首歌的缘分】\n${lines.join("\n")}`;
}

// ── 防复读：黑名单注入 + 出口相似度过滤 ──
// 对齐《角色记忆与情感规范 v1.2》第七节：prompt 规则之外必须有程序化兜底。
// 上次评论若当"素材"喂给模型，它只会换个壳复述，所以旧句一律改黑名单。

/** 常用繁体→简体对照（只覆盖弹幕短句高频字，作相似度比较用，不改展示文本） */
const T2S = new Map<string, string>([
    ["說","说"],["話","话"],["語","语"],["聽","听"],["點","点"],["麼","么"],["們","们"],
    ["這","这"],["後","后"],["過","过"],["還","还"],["從","从"],["裡","里"],["裏","里"],
    ["實","实"],["時","时"],["對","对"],["為","为"],["爲","为"],["専","专"],["業","业"],
    ["務","务"],["變","变"],["讓","让"],["記","记"],["學","学"],["問","问"],["題","题"],
    ["員","员"],["場","场"],["開","开"],["關","关"],["間","间"],["樣","样"],["發","发"],
    ["現","现"],["應","应"],["與","与"],["來","来"],["氣","气"],["單","单"],["號","号"],
    ["標","标"],["準","准"],["噓","嘘"],["於","于"],["萬","万"],["興","兴"],["聲","声"],
    ["響","响"],["顏","颜"],["樂","乐"],["視","视"],["親","亲"],["頭","头"],["東","东"],
    ["車","车"],["馬","马"],["鳥","鸟"],["龍","龙"],["風","风"],["雲","云"],["體","体"],
    ["髮","发"],["銀","银"],["鐵","铁"],["線","线"],["網","网"],["紅","红"],["綠","绿"],
    ["藍","蓝"],["黃","黄"],["臉","脸"],["腳","脚"],["夢","梦"],["憶","忆"],["緒","绪"],
    ["歡","欢"],["憂","忧"],["煩","烦"],["惱","恼"],["靜","静"],["閒","闲"],["悶","闷"],
    ["傷","伤"],["淚","泪"],["講","讲"],["談","谈"],["論","论"],["議","议"],["訴","诉"],
    ["誇","夸"],["騙","骗"],["覺","觉"],["識","识"],["曉","晓"],["誤","误"],["錯","错"],
    ["壞","坏"],["舊","旧"],["長","长"],["難","难"],["簡","简"],["複","复"],["雜","杂"],
    ["亂","乱"],["乾","干"],["濕","湿"],["熱","热"],["涼","凉"],
    ["別","别"],["説","说"],["請","请"],["謝","谢"],["隨","随"],["區","区"],["離","离"],
    ["係","系"],["類","类"],["緣","缘"],["麗","丽"],["續","续"],["結","结"],["給","给"],
    ["經","经"],["總","总"],["練","练"],["慣","惯"],
]);

/** 比较用归一化：小写、繁→简、去掉所有标点/符号/空白 */
export function normalizeListenText(t: string): string {
    let out = "";
    for (const ch of t.toLowerCase()) out += T2S.get(ch) ?? ch;
    return out.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigramsOf(s: string): Set<string> {
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
}

/**
 * 出口相似度判定：与最近几条弹幕（自己的或别人的）归一化后
 * 互为包含（≥4字）或字符 bigram Jaccard ≥ 0.3 即算复读。
 * 阈值刻意放低：真机翻过车的换壳复读（嘘……先别说话把这一段听完 / 嘘——先別說話聽這段）
 * 相似度只有 0.31，0.45 拦不住；误杀的代价只是多重试一次，漏放的代价是她看见复读机。
 */
export function isListenDuplicate(text: string, recentTexts: string[], threshold = 0.3): boolean {
    const a = normalizeListenText(text);
    if (a.length < 4) return false;
    const ga = bigramsOf(a);
    for (const r of recentTexts.slice(-6)) {
        const b = normalizeListenText(r);
        if (b.length < 4) continue;
        if (a.includes(b) || b.includes(a)) return true;
        const gb = bigramsOf(b);
        let inter = 0;
        for (const g of gb) if (ga.has(g)) inter++;
        const union = ga.size + gb.size - inter;
        if (union > 0 && inter / union >= threshold) return true;
    }
    return false;
}

/** 禁止复读清单：自己说过的旧句 + 刚才被判重复的稿子 */
function buildEchoBlock(selfSaid: string[], avoid: string[]): string {
    const items = [...new Set([...avoid, ...selfSaid])].filter(Boolean).slice(0, 5);
    if (items.length === 0) return "";
    return [
        "【禁止复读清单】下面这些话你已经说过或差点说出口：原样重复、换个标点、换繁体、换个壳说同一个意思，都不行。",
        ...items.map(s => `- ${s}`),
    ].join("\n");
}

/** 切歌决策的额外倾向提示（只调语气，不替角色做决定） */
function buildSkipBiasBlock(character: Character, trackId: string, userLabel: string): string {
    const mood = getMoodEntry(character.id, trackId);
    if (!mood) return "";
    const lines: string[] = [];
    if (mood.listens >= 3) {
        lines.push("听了这么多遍，腻了是正常的，想切不用不好意思。");
    }
    if (mood.deniedSkips > 0 && mood.deniedSkips >= mood.skipWants) {
        lines.push(`上次你提切歌被${userLabel}拒了，这次真没那么讨厌就别再提。`);
    }
    return lines.join("\n");
}

// ── API config resolution ──

/** 解析角色的 API 配置（沿用角色聊天绑定，取不到则抛可读错误） */
export function resolveCharacterApiConfig(characterId: string): ApiConfig {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "chat");
    if (!slot.apiConfigId) {
        throw new Error("尚未绑定 API 配置，请先在绑定设置中为角色配置");
    }
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) {
        throw new Error("绑定的 API 配置不存在，请检查绑定设置");
    }
    return apiConfig;
}

// ── Prompt helpers ──

/** 去掉 LRC 时间戳，截取前若干字作为歌词片段 */
export function extractLyricSnippet(lyrics: string | undefined, maxChars = 240): string {
    if (!lyrics?.trim()) return "";
    const plain = lyrics
        .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .join(" / ");
    return plain.length > maxChars ? `${plain.slice(0, maxChars)}…` : plain;
}

function buildTrackBrief(track: MusicTrack): string {
    const lines = [`歌名：${track.title}`];
    if (track.artist) lines.push(`歌手：${track.artist}`);
    if (track.album) lines.push(`专辑：${track.album}`);
    const snippet = extractLyricSnippet(track.lyrics);
    if (snippet) lines.push(`歌词片段：${snippet}`);
    return lines.join("\n");
}

/**
 * persona 智能截断：整段截前 N 字会把"说话方式"类小节切掉、留下通用客服内容，
 * 正是角色趋同的推手。改为按小节切：头部必留，说话风格类小节强制保留，
 * 剩余预算再按原顺序回填。
 */
const SPEAK_STYLE_RE = /(说话|口吻|语气|語氣|风格|風格|称呼|稱呼|口头禅|語言|语言|台词|表达方式|口癖|腔调)/;
function trimPersona(persona: string, budget = 1200): string {
    const t = persona.trim();
    if (t.length <= budget) return t;
    const parts = t.split(/\n(?=(?:#{1,6}\s|【[^】]{1,12}】))/);
    const style = parts.filter((p, i) => i > 0 && SPEAK_STYLE_RE.test(p.slice(0, 30)));
    let out = [parts[0], ...style].join("\n").slice(0, budget);
    for (const p of parts.slice(1)) {
        if (out.length >= budget || style.includes(p)) continue;
        out += "\n" + p.slice(0, budget - out.length);
    }
    return out;
}

/**
 * 组装「一起听」的扮演上下文：完整世界观+人物关系 + 角色人设 + 性格。
 * 与聊天引擎同源（formatCharacterRelationsForPrompt），之前只喂世界观名称+描述
 * 是角色退化成客服腔的根因。
 * 人设里的 {{user}} 宏必须像聊天引擎一样替换成真实称呼——留着占位符或
 * 由我们硬塞"主人"，都会让角色用出人设里根本不存在的叫法。
 */
function buildListenContext(character: Character, userLabel: string): string {
    const parts: string[] = [];
    const relations = renderUserNameMacro(formatCharacterRelationsForPrompt(character.id), userLabel);
    if (relations) parts.push(`【你的世界与身边人】\n${relations}`);
    // 人设截断：聊天人设动辄几千字且混着输出格式规则，全量注入既烧 token 又带偏格式
    const persona = trimPersona(renderUserNameMacro(character.persona?.trim() || "（暂无）", userLabel));
    parts.push(`【你是谁】\n${persona}`);
    if (character.personality?.trim()) {
        parts.push(`【你的性格】\n${renderUserNameMacro(character.personality.trim(), userLabel).slice(0, 300)}`);
    }
    parts.push(`注意：人设里若写了卡片、标签、markdown、括号动作、回复格式等聊天输出规则，在这里全部无效——此刻你不是在回消息，只是在听歌时随口说话。你身边的人叫「${userLabel}」；人设里没写过"主人"这种叫法，就绝对不要这么叫，按你和 TA 的关系来称呼。`);
    // 《角色记忆与情感规范 v1.2》第二节：四层优先级裁决
    parts.push("优先级：世界观 > 人设 > 你们之间的约定 > 记忆和情绪。记忆只能微调你此刻的语气，不能改写你是谁；任何记忆和人设冲突时，按人设说话。");
    return parts.join("\n\n");
}

/** 身边这个人叫什么：优先主人设定的真名；绝不使用"主人"这种人称谓 */
export function resolveUserLabel(characterId: string): string {
    return resolveUserIdentity(characterId, "chat")?.name?.trim() || "你身边的人";
}

/** 身边这个人的头像（一起听通知条要摆双方头像）；没设置则 null，UI 用首字兜底 */
export function resolveUserAvatar(characterId?: string): string | null {
    return resolveUserIdentity(characterId, "chat")?.avatarUrl?.trim() || null;
}

/** 和角色一起听歌的人是谁——评论是对 TA 说的，得知道对方是谁 */
function buildUserBlock(characterId: string, userLabel: string): string {
    const user = resolveUserIdentity(characterId, "chat");
    const name = user?.name?.trim();
    if (!user || (!name && !user.bio?.trim())) {
        return `【和你一起听歌的人】\n坐在你身边听歌的，是你最亲近的人，称呼：${userLabel}。`;
    }
    const lines: string[] = [`称呼：${userLabel}`];
    if (user.gender?.trim()) lines.push(`性别：${user.gender.trim()}`);
    if (user.occupation?.trim()) lines.push(`职业：${user.occupation.trim()}`);
    if (user.bio?.trim()) lines.push(`近况：${user.bio.trim().slice(0, 200)}`);
    return `【和你一起听歌的人】\n${lines.join("\n")}`;
}

const EMOTION_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
    { label: "悲伤低落", pattern: /(悲伤|哭泣|眼泪|泪|伤心|孤独|寂寞|离别|失去|再也)/ },
    { label: "欢快明亮", pattern: /(快乐|开心|欢笑|阳光|温暖|旅行|奔跑|恋爱|喜欢|心动)/ },
    { label: "热血激昂", pattern: /(愤怒|战斗|燃烧|冲破|反抗|不屈|梦想|征服|绝不)/ },
    { label: "温柔舒缓", pattern: /(温柔|轻抚|月光|星空|晚安|微风|宁静|守候)/ },
    { label: "迷茫沉思", pattern: /(迷茫|徘徊|寻找|追问|困惑|为什么|意义|归途)/ },
];

/** 从歌词提取情绪基调；纯音乐/无歌词时明确告知，避免模型瞎引歌词 */
function analyzeSongEmotion(track: MusicTrack): string {
    const plain = (track.lyrics ?? "")
        .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
        .trim();
    if (!plain) {
        return "没有歌词（纯音乐或歌词未加载），别引用歌词，凭曲名、歌手和旋律氛围来说感受。";
    }
    const hits = EMOTION_KEYWORDS
        .filter(e => e.pattern.test(plain))
        .map(e => e.label);
    const base = hits.length > 0
        ? `歌词整体透着${hits.join("、")}的情绪。`
        : "歌词情绪不明显，偏叙事或抽象。";
    const minutes = Math.max(1, Math.round((track.duration || 0) / 60));
    return `${base}整首大约 ${minutes} 分钟。`;
}

/** 把本首歌已发生的弹幕作为对话上下文，角色才能接话茬而不是各说各的 */
function buildRecentMessagesBlock(messages: ListenTogetherMessage[] | undefined, selfName: string): string {
    const recent = (messages ?? []).filter(m => m.content?.trim()).slice(-4);
    if (recent.length === 0) return "";
    const lines = recent.map(m =>
        m.characterName === selfName ? `你（刚才）：${m.content}` : `${m.characterName}：${m.content}`);
    return [
        `【刚才飘过的弹幕】`,
        ...lines,
        "你可以顺着谁的话茬接一句、抬个杠，也可以只管自己吐槽；",
        "但别人刚说过的意思别再说第二遍，自己说过的更不许换个说法再来一遍——没新东西就只发个语气词，或者哼半句。",
    ].join("\n");
}

/** 切歌事件的"刚才"块：让新歌里的角色知道上一首是怎么没了的 */
function buildJustSkippedBlock(js: ListenSkipEvent | undefined, selfName: string): string {
    if (!js) return "";
    const by = js.byName === selfName ? "是你自己" : (js.byName || "有人");
    return `【刚才】\n上一首《${js.fromTitle}》是${by}提议切掉的${js.reason ? `（理由是：${js.reason}）` : ""}，现在换成了这首。${by === "是你自己" ? "如愿了就用你的方式回应一下（满意、对比、或感慨半句都行）。" : "你可以对这次切换有句反应，也可以不提。"}`;
}

/** 触发语池：同一首歌下 system+user 逐字不变会把输出锁死在同一句上，情境措辞必须换 */
function pickListenTrigger(elapsedSec: number, recentCount: number, justSkipped: boolean): string {
    const pool: string[] = [];
    if (justSkipped) pool.push("刚切到这首，你有感而发");
    else if (elapsedSec > 0 && elapsedSec < 25) pool.push("前奏刚响", "刚放上这首");
    else if (recentCount === 0) pool.push("安静听了一会儿，你想开口了");
    else pool.push(
        "副歌刚过",
        "你跟着旋律轻轻点头",
        "你侧头看了眼身边这人",
        "你想起点别的什么",
        "你哼了半句又停下",
    );
    return `（${pool[Math.floor(Math.random() * pool.length)]}，你说一句。)`;
}

function ensureContent(result: { error?: string; content?: string | null }): string {
    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试");
    }
    const text = result.content.trim();
    if (!text) throw new Error("模型返回了空内容，请重试");
    return text;
}

const BUBBLE_MAX_CHARS = 80;

/**
 * 弹幕出口硬约束：剥掉卡片/富媒体标签与 markdown，压成一行短句。
 * prompt 约束挡不住被聊天格式带偏的模型，长度和格式必须在代码层兜底，
 * 否则一条气泡能刷满半屏挡住播放器。
 * 括号动作描写（（侧头笑了笑）…）和包裹引号也是聊天扮演格式——
 * 弹幕是"随口说的一句话"，这些必须在出口剥掉；剥空了才退回原文。
 */
export function sanitizeListenText(raw: string): string {
    let t = raw
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/^\s*#{1,6}\s*.*$/gm, " ")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/(\*\*|__)/g, "")
        .replace(/[*`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const stripped = t
        .replace(/[（(][^（()）]{1,60}[)）]/g, " ")
        .replace(/["“”『』「」]/g, "")
        .replace(/\s+/g, " ")
        .replace(/^[……，。,、·\-—\s]+/, "")
        .trim();
    if (stripped.length >= 4) t = stripped;
    if (t.length > BUBBLE_MAX_CHARS) {
        const cut = t.slice(0, BUBBLE_MAX_CHARS);
        const stop = Math.max(
            cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"),
            cut.lastIndexOf("；"), cut.lastIndexOf("…"),
        );
        t = stop >= 24 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
    }
    return t;
}

// ── LLM tasks ──

/** 一次真实发生的切歌（谁提议、从哪首切来、理由），供新歌点评接梗 */
export type ListenSkipEvent = {
    fromTitle: string;
    byId: string;
    byName: string;
    reason: string;
};

export type ListenCommentContext = {
    /** 本首歌已发生的一起听弹幕（含角色自己的和别人的），用于接话 */
    recentMessages?: ListenTogetherMessage[];
    /** 当前播放位置（秒），用于挑触发语情境 */
    elapsed?: number;
    /** 刚发生的切歌事件（只在换歌后头两句里传） */
    justSkipped?: ListenSkipEvent;
    /** 上一稿被判复读，重试时把这些也拉进黑名单 */
    avoid?: string[];
    /** 主人刚才对播放器的操作（切歌/暂停/快进），只喂上下文、不独立调 LLM */
    userActions?: Array<{ action: ListenUserAction; at: number }>;
};

// ── 用户操作事件：播放器 → 一起听层 ──
// 网易云式"操作同步"的本地映射：角色的操作弹通知条给用户；用户的操作只作为
// 事件记下来，喂进角色下一次发言/切歌评估的上下文，不为它单独花一次 token。

export type ListenUserAction = "skip" | "pause" | "play" | "seek";

export const LISTEN_USER_ACTION_EVENT = "ai-listen-user-action";

export function emitListenUserAction(action: ListenUserAction): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(LISTEN_USER_ACTION_EVENT, { detail: { action } }));
}

const USER_ACTION_LABEL: Record<ListenUserAction, string> = {
    skip: "切了歌", pause: "按了暂停", play: "点了继续播放", seek: "拖了进度条",
};

/** 把主人最近的操作组装成 prompt 片段；90 秒内最多三条，过期自动不占 token */
export function buildUserActionsBlock(
    actions?: Array<{ action: ListenUserAction; at: number }>,
): string {
    const fresh = (actions ?? []).filter(a => Date.now() - a.at < 90_000).slice(-3);
    if (fresh.length === 0) return "";
    const text = fresh.map(a => USER_ACTION_LABEL[a.action] ?? "动了动播放器").join("、");
    return `【身边这人刚才的小动作】\nTA刚才${text}。可以自然地接一句，别大惊小怪，也别假装看见你没看到的东西。`;
}

// ── 首次启动「操作同步」说明弹窗（一次性，本地标记） ──

const NOTICE_SEEN_KEY = "music-listen-together-notice-seen-v1";
registerKvMigration(NOTICE_SEEN_KEY);

export function hasSeenListenNotice(): boolean {
    if (typeof window === "undefined") return true;
    try { return kvGet(NOTICE_SEEN_KEY) === "1"; } catch { return true; }
}

export function markListenNoticeSeen(): void {
    try { kvSet(NOTICE_SEEN_KEY, "1"); } catch { /* ignore */ }
}

/** 角色对当前歌曲发表一句听感评价（沉浸扮演：完整世界观 + 人设 + 主人信息 + 弹幕上下文） */
export async function generateListenComment(
    character: Character,
    track: MusicTrack,
    ctx?: ListenCommentContext,
): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";
    const userLabel = resolveUserLabel(character.id);
    const recent = ctx?.recentMessages ?? [];
    const selfSaid = [
        ...recent.filter(m => m.characterName === name).slice(-2).map(m => m.content),
        ...(getMoodEntry(character.id, track.id)?.lastComments.slice(-1) ?? []),
    ];

    const systemPrompt = [
        `你是「${name}」，此刻正和${userLabel}一起窝着用这台小手机放歌听，这不是任务，就是你们俩的日常。`,
        "",
        buildListenContext(character, userLabel),
        "",
        buildUserBlock(character.id, userLabel),
        "",
        `【正在放的歌】\n${buildTrackBrief(track)}`,
        analyzeSongEmotion(track),
        buildMoodBlock(character, track.id, userLabel),
        buildJustSkippedBlock(ctx?.justSkipped, name),
        "",
        buildRecentMessagesBlock(recent, name),
        buildEchoBlock(selfSaid, ctx?.avoid ?? []),
        buildUserActionsBlock(ctx?.userActions),
        "",
        "想到什么就随口冒一句什么，1~2 句，像发弹幕一样短。",
        "只聊此刻正在放的这首歌、你听它的感受、或你和身边这个人的一句话；",
        "别编演出/舞台/海边这类此刻不存在的场景独白，别虚构不存在的歌词来引用，别把人设里的经历演成情景剧。",
        "可以哼半句旋律、可以只对身边这人说话、也可以懒得评价只是叹口气；",
        "别用「为您」「值得一听」这种乐评腔，别每句都在总结歌曲，更别反问对方「聊聊你的想法」这种客服式收尾。",
        "只输出这句话本身：不要角色名前缀、不要引号、不要（括号动作）——动作留在心里，弹幕里只留你说出口的那句。",
    ].filter(line => line !== null).join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: pickListenTrigger(ctx?.elapsed ?? 0, recent.length, !!ctx?.justSkipped) },
        ],
        // 思考模型会先烧隐藏思考 token，max_tokens 给足余量避免正文被截空
        { temperature: 0.95, max_tokens: 2048 },
    );
    return sanitizeListenText(ensureContent(result));
}

export type SkipDecision = {
    skip: boolean;
    reason: string;
};

/** 角色自主决定是否切歌（LLM 输出 JSON），reason 即切歌/留歌的理由评价 */
export async function decideListenSkip(
    character: Character,
    track: MusicTrack,
    ctx?: ListenCommentContext,
): Promise<SkipDecision> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设");
    }
    const apiConfig = resolveCharacterApiConfig(character.id);
    const name = character.name?.trim() || "该角色";
    const userLabel = resolveUserLabel(character.id);
    const recent = ctx?.recentMessages ?? [];
    const selfSaid = recent.filter(m => m.characterName === name).slice(-2).map(m => m.content);

    const systemPrompt = [
        `你是「${name}」，正和${userLabel}一起用这台小手机听歌，马上要放到下一首了。`,
        "",
        buildListenContext(character, userLabel),
        "",
        buildUserBlock(character.id, userLabel),
        "",
        `【正在放的歌】\n${buildTrackBrief(track)}`,
        analyzeSongEmotion(track),
        buildMoodBlock(character, track.id, userLabel),
        buildSkipBiasBlock(character, track.id, userLabel),
        "",
        buildRecentMessagesBlock(recent, name),
        buildEchoBlock(selfSaid, []),
        buildUserActionsBlock(ctx?.userActions),
        "",
        "按你自己的真实喜好决定：这首歌你还想继续听，还是想换下一首？别考虑「客观上」好不好听，就想你自己此刻想不想听。",
        `- 想切歌：{"skip": true, "reason": "你为什么想切，第一人称口语，2句以内"}`,
        `- 想继续听：{"skip": false, "reason": "你想留着它的理由，第一人称口语，2句以内"}`,
        "- 理由要像你自己会说的话，别复读禁止清单里的句子",
        "- 只输出 JSON 本身，不要输出任何其他内容",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: "（下一首要来了，切还是留？）" },
        ],
        { temperature: 0.8, max_tokens: 2048 },
    );
    const text = ensureContent(result);

    // 容错解析：直接 parse → 提取 {...} → 兜底按「不切」处理
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
        }
    }
    if (parsed && typeof parsed === "object") {
        const obj = parsed as { skip?: unknown; reason?: unknown };
        const reason = typeof obj.reason === "string" ? sanitizeListenText(obj.reason.trim()) : "";
        return { skip: obj.skip === true, reason };
    }
    // 模型没按 JSON 输出：把原文当理由，默认不切歌（避免误切）
    return { skip: false, reason: sanitizeListenText(text) };
}
