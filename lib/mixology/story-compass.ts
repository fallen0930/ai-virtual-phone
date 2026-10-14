// lib/mixology/story-compass.ts
// 剧情溯源罗盘的核心：把一局对话流「脱水」并配对成「第 1 轮 / 第 2 轮……」。
//
// · 成对扫描：玩家的一句发言 + 紧随其后的角色回复 = 一轮；开场的 AI 回复（还没有
//   玩家发言）单独成「序幕」，不计轮数——与引擎的 mixRoundCount（按玩家发言计数）对齐。
// · 自动脱水：玩家常把几百字的「自动注入指令」（禁止截断 / 严格承接 / 反注水 / 输出要求）
//   连同自己的发言一起打进输入框。这些机械套话不属于剧情，罗盘要在展示前滤掉，
//   只留玩家真正手打的那部分。
//
// 这里只做纯函数 + 一个极小的偏好存储，不碰 DOM、不 import 组件。

import type { MixTurn } from "./types";

/** 角色当轮正文的前情切片长度 */
export const COMPASS_PREVIEW_CHARS = 75;

// ─────────────────────────────────────────────
// 脱水：识别「这行是给模型看的指令，不是剧情」
// ─────────────────────────────────────────────

/**
 * 强指令词：几乎不会出现在玩家的剧情发言里，命中一个就给 2 分。
 * （区分大小写的地方特意保留了 OOC 的常见写法）
 */
const STRONG_META = [
    "禁止", "严禁", "不得", "请勿", "切勿", "切忌", "务必", "不得以", "不可以", "不允许",
    "绝对不要", "一定不要", "千万不要", "严格承接", "严格按", "务必严格", "请严格", "严格遵守",
    "提示词", "系统提示", "系统指令", "自动注入", "注入指令", "行动纲领", "附加要求",
    "崩人设", "OOC", "ooc", "注水", "车轱辘", "复读机", "灌水", "水文",
    "上文摘要", "剧情摘要", "前情提要", "承接上文", "接着上文", "紧接上文", "延续上文", "上文最后",
    "回复要求", "输出要求", "写作要求", "格式要求", "字数要求", "篇幅要求", "正文要求", "结尾要求",
    "不要复述", "不要总结", "不要改写", "不要删减", "不要缩写", "不要缺字", "不要省略号",
    "不要替我", "不要代替", "不要代写", "不要抢戏", "不要收尾", "不要自行", "不要擅自",
    "保持一致", "必须一致", "人设定", "性格设定", "世界观设定",
];

/** 弱指令词：可能出现在正常句子里，命中只给 1 分，要靠行数/结构化线索一起凑够。 */
const WEAK_META = [
    "必须", "需要", "应该", "应当", "注意", "要求", "规则", "约束", "限制", "规范", "标准", "细则",
    "避免", "防止", "记住", "遵守", "遵循", "确保", "切记", "沿用", "沿用上文",
    "截断", "截尾", "中止", "中断", "省略", "未完待续", "待续", "虎头蛇尾", "烂尾", "半截话",
    "视角", "人称", "时态", "文风", "风格", "口吻", "语气", "笔触", "行文",
    "字数", "篇幅", "段落", "分段", "留白", "不少于", "不超过", "至少写",
    "续写", "延续", "承接", "连续剧", "次回复", "这句话开始",
];

/** 「要求：」「格式：」这类小标题——标题部位命中就是明摆着的章节名称 */
const HEADER_WORDS = [
    "要求", "规则", "格式", "设定", "指令", "提示", "约束", "注意", "说明", "输出", "字数",
    "视角", "人称", "风格", "禁令", "禁忌", "规范", "细则", "条件", "前提", "目标", "开头", "结尾",
    "system", "role", "prompt", "PS", "ps", "附",
];

/** 结构化线索：列表符号 / 标题符，给 2 分 */
const STRUCTURAL = /^\s*(?:[#＃]{1,3}\s|[-—•·*＊]\s|\d{1,2}[.、)）]\s|[［【（(].{0,14}[］】)）]\s*[：:]?)/;

/** 整行就是一个括起来的块（【写了很长一段指令】） */
const BRACKETED_LINE = /^[【（《“][^】）》”]{2,}[】）》”]\s*[：:]?$/;

/**
 * 给一行打指令分。>=3 判定为套话；>=2 且该行较长（>=40 字）也判定为套话——
 * 长句里出现两条弱指令基本不会是剧情（角色的台词不会这么写）。
 */
function lineScore(line: string, extra: string[]): number {
    const t = line.trim();
    if (!t) return 0;
    let score = 0;
    for (const w of STRONG_META) if (t.includes(w)) score += 2;
    for (const w of WEAK_META) if (t.includes(w)) score += 1;
    for (const w of extra) {
        const k = w.trim();
        if (k && t.includes(k)) score += 3;
    }
    if (STRUCTURAL.test(t)) score += 2;
    const header = t.match(/^\s*([^\s：:]{1,12})\s*[：:]/);
    if (header && HEADER_WORDS.some((w) => header[1].includes(w))) score += 3;
    if (BRACKETED_LINE.test(t) && t.length >= 18) score += 2;
    return score;
}

/**
 * 脱掉「前置（也包括后置）套话」，只留玩家真正手打的内容。
 * 三步：① 分隔线直切 ② 逐行从头/从尾滤 ③ 抠掉混在正文里的【指令块】。
 * 全程只做减法，且结果为空时原样退回——宁可多显示，不可把正文滤没了。
 */
export function dehydrateText(raw: string, extraWords: string[] = []): string {
    const text = String(raw ?? "").replace(/\r\n?/g, "\n");
    if (!text.trim()) return "";

    // ① 「指令 --- 正文」的写法：分隔线之前集中写指令时，直接整段切掉
    const lines = text.split("\n");
    // `---` / `===` / `***` 这类分隔线；重复次数 >= 3 才算，避免误判普通破折号
    const hrAt = lines.findIndex((l, i) => i > 0 && i < lines.length - 1 && /^\s*([-—=_*＊])\s*(?:\1\s*){2,}$/.test(l));
    if (hrAt > 0) {
        const beforeScore = lines.slice(0, hrAt).reduce((s, l) => s + lineScore(l, extraWords), 0);
        const after = lines.slice(hrAt + 1).join("\n").trim();
        if (after.length >= 8 && beforeScore >= 2) return stripStrayBlocks(after, extraWords).trim();
    }

    return stripStrayBlocks(bodyLines(lines, extraWords).join("\n"), extraWords).trim() || text.trim();
}

/** 从头连续滤掉套话行；尾部用更严的门槛，避免误伤真实结尾。 */
function bodyLines(lines: string[], extra: string[]): string[] {
    let head = 0;
    while (head < lines.length) {
        const l = lines[head];
        if (!l.trim()) { head += 1; continue; }
        const s = lineScore(l, extra);
        if (s >= 3 || (s >= 2 && l.trim().length >= 40)) { head += 1; continue; }
        break;
    }
    const rest = lines.slice(head);
    let tail = rest.length;
    while (tail > 0) {
        const l = rest[tail - 1];
        if (!l.trim()) { tail -= 1; continue; }
        if (lineScore(l, extra) >= 5) { tail -= 1; continue; }
        break;
    }
    return rest.slice(0, tail);
}

/** 抠掉夹在正文中间的【指令】块（只有它自己够"指令"才抠，正文里的【道具名】不动） */
function stripStrayBlocks(text: string, extra: string[]): string {
    return text.replace(/[【][^】]{2,}[】]/g, (whole) => {
        const inner = whole.slice(1, -1);
        const s = lineScore(inner, extra);
        return s >= 3 || (s >= 2 && inner.length >= 60) ? "" : whole;
    });
}

/**
 * 前情切片：取正文前 n 个字，压平换行、去掉 markdown 强调符，紧凑一行。
 * 角色的**长回复**往往上千字，罗盘里只需要这一眼唤醒记忆的几十个字。
 */
export function headSlice(text: string, n = COMPASS_PREVIEW_CHARS): string {
    let s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!s) return "";
    s = s.replace(/[*_`#>]/g, "");
    s = s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─────────────────────────────────────────────
// 成对扫描：turns → 轮次
// ─────────────────────────────────────────────

export type CompassRound = {
    /** 轮次号；0 = 序幕（开场白，尚无玩家发言） */
    no: number;
    /** 轮次标题："序幕" / "第 N 轮" */
    label: string;
    /** 这一轮起点在 session.turns 里的下标（用于跳转与懒加载展开） */
    startIndex: number;
    userIndex?: number;
    assistantIndex?: number;
    userTurnId?: string;
    assistantTurnId?: string;
    /** 脱水后的玩家发言（正文也是这一份） */
    userText: string;
    /** 脱水前的原始发言（字数统计用原文，别因为滤掉了就说玩家没写） */
    userRaw: string;
    assistantText: string;
    /** 当轮正文的前 75 字切片 */
    assistantPreview: string;
    userChars: number;
    assistantChars: number;
    /** 玩家刚发完、还没等到回复 */
    pending: boolean;
    /** 同一轮里连着「继续生成」追加了几段回复 */
    extraReplies: number;
    /** 这一轮是否被脱水滤掉了内容（UI 上给个小提示） */
    filtered: boolean;
};

type Draft = {
    no: number;
    startIndex: number;
    userIndex?: number;
    assistantIndex?: number;
    userTurn?: MixTurn;
    assistantTurn?: MixTurn;
    extraReplies: number;
};

/**
 * 按发声顺序把对话流配对成轮次。
 * 开口前的 AI _reply 归「序幕」；一句玩家发言之后的所有连续角色回复都算同一轮
 * （「继续生成」出来的尾巴也算），直到下一个玩家发言为止。
 */
export function pairMixRounds(turns: MixTurn[], extraWords: string[] = [], keepInjection = false): CompassRound[] {
    const list = Array.isArray(turns) ? turns : [];
    const drafts: Draft[] = [];
    let current: Draft | null = null;
    let roundNo = 0;

    for (let i = 0; i < list.length; i += 1) {
        const turn = list[i];
        if (turn.role === "user") {
            roundNo += 1;
            current = { no: roundNo, startIndex: i, userIndex: i, userTurn: turn, extraReplies: 0 };
            drafts.push(current);
            continue;
        }
        if (!current) {
            // 开场白：还没有玩家发言就先开口的那段
            current = { no: 0, startIndex: i, extraReplies: 0 };
            drafts.push(current);
        }
        if (!current.assistantTurn) {
            current.assistantIndex = i;
            current.assistantTurn = turn;
        } else {
            current.extraReplies += 1;
        }
    }

    return drafts.map((d) => {
        const userRaw = d.userTurn?.text ?? "";
        const userText = keepInjection ? userRaw.trim() : dehydrateText(userRaw, extraWords);
        const assistantText = d.assistantTurn?.text ?? "";
        return {
            no: d.no,
            label: d.no === 0 ? "序幕" : `第 ${d.no} 轮`,
            startIndex: d.startIndex,
            userIndex: d.userIndex,
            assistantIndex: d.assistantIndex,
            userTurnId: d.userTurn?.id,
            assistantTurnId: d.assistantTurn?.id,
            userText,
            userRaw,
            assistantText,
            assistantPreview: headSlice(assistantText),
            userChars: userRaw.length,
            assistantChars: assistantText.length,
            pending: Boolean(d.userTurn) && !d.assistantTurn,
            extraReplies: d.extraReplies,
            filtered: userText.length < userRaw.trim().length,
        } satisfies CompassRound;
    });
}

/** 罗盘用来定位 DOM 的那个 id：一轮优先停在自己的发言上，序幕停在开场白上 */
export function compassAnchorId(round: CompassRound): string | undefined {
    return round.userTurnId ?? round.assistantTurnId;
}

// ─────────────────────────────────────────────
// 罗盘偏好（跟随模式 / 面板形态 / 自定义套话词）
// ─────────────────────────────────────────────

/**
 * 新一轮渲染要不要把视口拽到最后一行：
 * · always = 始终贴底（今天的默认行为，适合只想追最新的人）
 * · bottom = 只在你本来就停在底部时才跟着往下走（推荐）
 * · manual = 完全不动，你滑到哪就在哪（本次要求的默认）
 */
export type FollowMode = "always" | "bottom" | "manual";

export const FOLLOW_MODE_LABELS: Record<FollowMode, string> = {
    always: "跟随",
    bottom: "贴底",
    manual: "锁定",
};

export const FOLLOW_MODE_HINTS: Record<FollowMode, string> = {
    always: "任意时刻都跳到最新一行——不管你正在读哪一段。",
    bottom: "只在你的视口本来就已停在最新时才跟着往下走；正在翻旧剧情时绝不打断。",
    manual: "完全不移动：无论你发言还是 AI 回复，画面都停在你当前位置。",
};

export type CompassPrefs = {
    follow: FollowMode;
    /** 罗盘的展示形态：merged = 并入右侧侧栏，float = 独立浮窗（可拖动） */
    mode: "merged" | "float";
    /** 是否启用自动脱水 */
    dewater: boolean;
    /** 玩家自己登记的套话片段 */
    words: string[];
};

export const COMPASS_PREFS_KEY = "mix_story_compass_v1";

const DEFAULT_PREFS: CompassPrefs = {
    // 按本次要求：默认锁死视口，不自动跳到最后一行
    follow: "manual",
    mode: "merged",
    dewater: true,
    words: [],
};

export function readCompassPrefs(): CompassPrefs {
    if (typeof window === "undefined") return { ...DEFAULT_PREFS };
    try {
        const raw = window.localStorage.getItem(COMPASS_PREFS_KEY);
        if (!raw) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(raw) as Partial<CompassPrefs>;
        const follow: FollowMode =
            parsed.follow === "always" || parsed.follow === "bottom" || parsed.follow === "manual"
                ? parsed.follow
                : DEFAULT_PREFS.follow;
        const words = Array.isArray(parsed.words) ? parsed.words.filter((w): w is string => typeof w === "string" && Boolean(w.trim())) : [];
        return {
            follow,
            mode: parsed.mode === "float" ? "float" : "merged",
            dewater: typeof parsed.dewater === "boolean" ? parsed.dewater : true,
            words: words.slice(0, 40),
        };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

export function writeCompassPrefs(next: CompassPrefs): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(COMPASS_PREFS_KEY, JSON.stringify(next));
    } catch {
        /* localStorage 不可用时静默忽略 */
    }
}

/** 把"一行一个/逗号分隔"的词表文本解析成关键词数组 */
export function parseWordList(text: string): string[] {
    return text
        .split(/[\n,，、;；]+/)
        .map((w) => w.trim())
        .filter(Boolean)
        .slice(0, 40);
}
