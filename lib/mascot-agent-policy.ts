// lib/mascot-agent-policy.ts
// 卷宝 agent 循环的判定规则与文案（纯函数，无副作用，方便单测）。
//
// 这些规则原本散落在 lib/mascot-chat-store.ts 与 lib/mascot-engine.ts 里，其中三条造成了
// 「话说到一半直接停住 + 最后只说已完成」：
//   · 没有截断识别：被 max_tokens 切断的残缺动作被 parseToolCalls 静默丢弃，循环把「这一轮没动作」
//     当成完工（工坊 lib/qa-agent-engine.ts 早就有这套检测，卷宝这条路径没接）；
//   · 收尾指令写成「全部做完后再只回复：已完成」，直接把完成报告掐掉了；
//   · 完工判定用 /已完成/i 命中回复任意位置，「已完成一半，接下来…」也会被判定结束。
// 收尾判定后来暴露出反向问题（见下面 WRAP_UP_STEMS / SELF_PENDING 的注释）：词表太死 + 把给
// 用户的使用指引当成自己的欠账，真机的两份完成报告（第 9 / 38 轮）都被判没做完，白白催了两轮活。

export const MASCOT_MAX_AUTO_CONTINUES = 3;
export const MASCOT_MAX_NUDGES = 2;

// ── 断流看门狗与轮级重试（2026-11-12 真机诊断 mascot-diag-20261112-1221）──────
// 中转站首包 130~190 秒是常态，第 5 轮首块之后 17.8 分钟没收到一个字节。
// 断流阈值必须显著高于首包常态（240s），又不能让人等到天荒地老；
// 总闸维持 500 秒不变——慢而不断的长生成靠它收口，改小会误杀正常长文。

/** 流式断流阈值：连续这么久没有任何字节即判死（lib/stream-idle-watchdog.ts） */
export const MASCOT_STREAM_IDLE_MS = 240_000;
/** 流式总时长闸：与 chat-engine 旧口径一致，卷宝链路显式传下去 */
export const MASCOT_STREAM_TOTAL_MS = 500_000;
/** 非流式一次性请求（兜底直连 / 关闭流式）超时：旧代码根本没挂超时 */
export const MASCOT_FALLBACK_TIMEOUT_MS = 300_000;
/** 同一轮因断流自动重试的次数上限 */
export const MASCOT_MAX_STALL_RETRIES = 1;

// 哪些错误值得原地重试同一轮：链路挂死/被掐断类。
// 「空内容」「4xx」「API 500: quota」这类确定性错误不在其列——重试只会再烧一次钱。
// 503 / overloaded：中转站临时过载，等几秒再试通常能好。
const MASCOT_STALL_ERROR_RE = /中断|超时|timed out|abort|network|fetch failed|socket|econn|etimedout|overloaded|503/i;

/** 这个错误是不是「流断/挂死」类：断流看门狗、总时长闸、网络层抛的都算 */
export function isMascotStallError(error: unknown): boolean {
    const message = error instanceof Error
        ? `${error.name} ${error.message}`
        : String(error ?? "");
    return MASCOT_STALL_ERROR_RE.test(message);
}

/** 断流自动重试时的会话内可见提示：她在等，得知道发生了什么 */
export const MASCOT_STALL_RETRY_VISIBLE_HINT = "（刚才这轮连接断了，中转站没把话送完，我自动重试这一轮；如果经常这样，多半是线路的问题）";

/** 未闭合的动作指令起始片段：与工坊同一套识别口径 */
const MASCOT_DIRECTIVE_START = /\[[^\[\]\n]{0,60}?(?:执行动作|工具调用|获取指令)/;
const MASCOT_THINK_BLOCK = /<\s*(?:think|thinking)\b[\s\S]*?(?:<\/\s*(?:think|thinking)\s*>|$)/gi;

/** 正文末尾残留未闭合的 [执行动作:… 指令 —— 输出被 max_tokens 截断的典型特征 */
export function hasTruncatedDirective(content: string): boolean {
    const text = (content || "").replace(MASCOT_THINK_BLOCK, "");
    let start = -1;
    let from = 0;
    for (;;) {
        const match = MASCOT_DIRECTIVE_START.exec(text.slice(from));
        if (!match) break;
        start = from + match.index;
        from = start + 1;
    }
    if (start === -1) return false;
    return !/[)）]\s*\]/.test(text.slice(start));
}

// 收尾词与「话没说完」的线索：两者同时出现时按「没做完」处理，不能让它蒙混收工。
//
// 完成态的写法比旧词表宽得多。「全部搞定啦」「配置完毕啦」「都已就绪」「也已保存」都是真机里
// 出现过的完成报告原话（mascot-diag-20261029-1428.json 第 9 / 38 轮），旧版只列了带「了」的
// 十来个死板词，报告写得越自然越判不出来，于是被催活、继续做无意义的动作。
const WRAP_UP_STEMS = /完成|完毕|做完|做好|写好|写完|建好|配好|装好|设置好|调整好|就绪|搞定|弄好|保存|落地/;

// 「没说完」的线索只盯**它自己还没做完**的表述。旧版把「下一步 / 然后 / 继续」也算线索，
// 而收尾指令又明确要求报告里写「建议用户下一步确认什么」——两份规则对着干：
// 第 9 轮那句「建议与下一步：宝可以直接前往吧台开局」是给她的使用指引，不是小卷的欠账，
// 却触发了否决，被催了两轮活。
const SELF_PENDING = /还差|还没|没做完|没写完|没配|没传|没补|一半|尚未|还未|未完|剩下|剩余|还需(?:要|得)|待(?:补|写|做|上传)|(?:我|接下来|下面|稍后)[^。\n]{0,6}(?:要|得|来|准备|打算)[^。\n]{0,6}(?:写|做|补|配|改|上传|调整|处理)|还要(?:写|做|补|配|改|上传|调整|处理)/;

/** 问句式回复：她在被征求意见，不是完工报告 */
function endsWithQuestion(text: string): boolean {
    const lastLine = text.split("\n").map((line) => line.trim()).filter(Boolean).pop() || "";
    return /[?？][)）」』]*$/.test(lastLine);
}

/** 这段回复是不是「任务收尾报告」：说了完成，且没有暴露出还有后续 */
export function looksLikeWrapUp(text: string): boolean {
    const value = (text || "").trim();
    if (!value) return false;
    if (SELF_PENDING.test(value)) return false;
    if (endsWithQuestion(value)) return false;
    return WRAP_UP_STEMS.test(value);
}

export type MascotExecutedAction = {
    name: string;
    success: boolean;
    /** 回执里的对象名（「…」里的内容），让小结从「创建材料 ✓」变成「创建材料：林野 ✓」 */
    detail?: string;
};

/**
 * 从工具回执里抠出对象名。特调/角色卡这些工具的回执习惯把名字写在「」里，
 * 没有就不用硬凑——只列动作名也比编一个假名字强。
 */
export function extractMascotActionDetail(text: string): string | undefined {
    const match = (text || "").match(/「([^「」\n]{1,40})」/);
    return match ? match[1] : undefined;
}

export type MascotProgressDigestReason = "rounds" | "abort" | "silent" | "truncated";

const DIGEST_TAIL: Record<MascotProgressDigestReason, string> = {
    rounds: "还差：动作还没跑完，回复「继续」我就接着做。",
    abort: "还差：这轮被中止了，剩下的想说一声让我接着做，或回复「继续」。",
    silent: "以上是我这轮做完的。要是还有没覆盖到的，直接说，我补上。",
    truncated: "还差：内容太长被输出上限截断了，回复「继续」我把剩下的补完。",
};

/**
 * 兜底进度小结：当循环结束时，AI助手自己没有留下可见的收尾文本（被截断、只写了动作、
 * 或轮数用尽），就用本次真实执行过的动作拼一条「做了什么 / 还差什么」，
 * 避免出现「突然不说话了」的静默中断。
 */
export function buildMascotProgressDigest(
    actions: MascotExecutedAction[],
    reason: MascotProgressDigestReason,
): string {
    if (actions.length === 0) {
        return reason === "silent"
            ? "这轮没有实际写入任何东西。你想让我做什么，直接说一句就行。"
            : `这轮还没执行到动作就停了。${DIGEST_TAIL[reason]}`;
    }
    const done = actions.filter((action) => action.success);
    const failed = actions.filter((action) => !action.success);
    const label = (action: MascotExecutedAction) => `${action.name}${action.detail ? `：${action.detail}` : ""}`;
    const lines = [
        `（本轮小结）我做了 ${done.length} 件事${failed.length ? `，有 ${failed.length} 件没成功` : ""}：`,
        ...done.map((action) => `· ${label(action)} ✓`),
        ...failed.map((action) => `· ${label(action)} ✗（这步没成功）`),
        DIGEST_TAIL[reason],
    ];
    return lines.join("\n");
}

/** 可见的一行提示：自动续写时让她知道为什么多等了一轮 */
export const MASCOT_AUTO_CONTINUE_VISIBLE_HINT = "（刚才那条输出被长度上限截断，残缺的动作没有执行，我自动接着写）";

/** 隐藏接力提示：告诉模型从断点重新完整输出那一个动作 */
export const MASCOT_AUTO_CONTINUE_PROMPT = "（系统提示）你上一条输出到达单次输出上限被截断，未闭合的动作残缺、已被安全丢弃，没有执行。请从中断处重新完整输出那一个动作（一次只写一个字段/一份文件，别把长内容塞进一条动作），不要重写已经执行成功的部分；已经执行成功的写入不用回读确认，成功回执和本轮台账已经把 id 和改了哪些字段告诉你了。";

/** 轮数/截断用尽时的会话内可见提示（回复「继续」即可接力） */
export const MASCOT_ROUNDS_EXHAUSTED_NOTICE = "（这一轮的工具调用次数用完了，还有动作没执行——回复「继续」我就接着完成。）";
export const MASCOT_TRUNCATED_EXHAUSTED_NOTICE = "（回复被输出长度上限截断，自动续写的次数也用完了——回复「继续」我接着写；经常出现的话，可以在 AI助手设置里调大「单次输出上限」。）";

/** 收尾指令：完成报告取代旧版的「只回复：已完成」 */
export function buildMascotFinishInstruction(): string {
    return [
        "请继续用动作把它做完；不要凭空宣布结束。",
        "确认全部做完时，用 3-6 行写一份完成报告：先说完成了什么，再逐项点名改了哪个对象、哪个字段、结果如何。",
        "最后一行可以给宝一句「接下来可以做什么」的使用指引——那是给她的，不是你的欠账。",
        "报告里不要出现「我还没 / 还差 / 剩下 / 接下来我要」这类自己没做完的表述：",
        "真有没做完的，就别写报告，直接输出下一个动作。",
    ].join("");
}

/** 无动作但任务显然未完时的重试提醒 */
export function buildMascotNudgePrompt(): string {
    return `（系统提醒）上一个回复里没有可执行的动作，而任务还没做完。请继续输出下一个动作，格式为 [执行动作:动作名({"参数":"值"})]；一次只写一个动作，长内容拆成多轮。${buildMascotFinishInstruction()}`;
}

/** 输出预算与分段纪律：让模型知道护栏在哪，被截断后该怎么做 */
export function buildMascotOutputBudgetPrompt(budget: number | null): string {
    const lines: string[] = ["===== 输出预算与分段写入 ====="];
    if (budget) {
        lines.push(
            `你单次回复的输出上限被设置为 ${budget.toLocaleString()} token（约 ${Math.round(budget * 0.75).toLocaleString()}–${budget.toLocaleString()} 个汉字），写超会被服务端安全截断；截断后系统会自动让你续写，已经执行成功的动作不会丢。`,
        );
    } else {
        lines.push("模型单次回复有输出长度上限（max_tokens），一次写太长会被截断；截断后系统会自动让你续写，已经执行成功的动作不会丢。");
    }
    lines.push("① 一条动作只写一个字段/一份内容——长人设按板块拆成多轮（先 persona，再外貌，再性格），别把七个板块塞进同一条动作；");
    lines.push("② 收到「被截断」提示时，从中断处重新完整输出那一个动作，不要重写已成功的部分，也不要为了显得完整而提前收尾；");
    lines.push("③ 写完不用回读确认：成功回执会带 id 和改了哪些字段，本轮建过的对象系统也记着（同名再建会被拒、并把已有 id 还给你）；只有要把内容念给宝看时才用「读取」类动作。");
    return lines.join("\n");
}
