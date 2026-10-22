// 聊天记录导出图片 · 小手机聊天插件（apiVersion 1）
//
// 用法：进入任一聊天室 → 标题栏下方有常驻「导出图片」按钮 → 勾选多条消息 → 生成聊天卡片长图 → 下载/复制
//      也可在消息长按菜单里「导出这条为图片」单条快速导出
// 安装：聊天插件管理页 → 选择本 .js 文件（或把全文粘进代码框）→ 启用
//
// 实现说明：出图全部由 canvas 手工测量+绘制，不依赖 html2canvas，也不把 DOM 塞进
// SVG foreignObject，所以不受宿主样式/CSP/外部字体影响；超过像素或尺寸上限时自动
// 降清晰度并按段输出多张图。

// ═════════════════════════════════════════════════════════
// 一、纯函数区（无 DOM 依赖，可在 Node 下单测）
// ═════════════════════════════════════════════════════════

var WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// 这些符号后面允许断行（URL、路径、时间戳这类连续串）
var BREAK_AFTER = /[\/\\\-?=&%#:]/;

function isWideChar(ch) {
    if (!ch) return false;
    var cp = ch.codePointAt(0);
    if (cp > 0x2600) return true;      // emoji / 符号区
    return WIDE_RE.test(ch);
}

/** 断行单位：宽字符逐字成 token，拉丁按词成 token，空格独立 token */
function tokenize(str) {
    var chars = Array.from(String(str));
    var out = [];
    var buf = "";
    for (var i = 0; i < chars.length; i++) {
        var ch = chars[i];
        if (ch === " " || isWideChar(ch)) {
            if (buf) { out.push(buf); buf = ""; }
            out.push(ch);
        } else if (BREAK_AFTER.test(ch)) {
            // URL / 路径这类连续符号：允许在分隔符后断行，避免在单词中间硬切
            buf += ch;
            out.push(buf);
            buf = "";
        } else {
            buf += ch;
        }
    }
    if (buf) out.push(buf);
    return out;
}

/**
 * 换行。measure: (text)=>宽度像素。
 * 行宽用 token 宽度累加近似（比每行整段 measureText 快很多，CJK 下误差可忽略）。
 */
function wrapText(measure, text, maxWidth) {
    var lines = [];
    var limit = maxWidth > 0 ? maxWidth : 40;
    var paragraphs = String(text == null ? "" : text).split("\n");
    for (var p = 0; p < paragraphs.length; p++) {
        var para = paragraphs[p];
        if (para === "") { lines.push(""); continue; }
        var tokens = tokenize(para);
        var line = "";
        var lineW = 0;
        for (var i = 0; i < tokens.length; i++) {
            var tk = tokens[i];
            if (tk === " " && line === "") continue;
            var w = measure(tk);
            var pieces = Array.from(tk);
            // 超长 token（长链接、连续字母）硬切成单字符
            if (w > limit && pieces.length > 1) {
                Array.prototype.splice.apply(tokens, [i, 1].concat(pieces));
                i--;
                continue;
            }
            if (lineW + w > limit && line !== "") {
                lines.push(line.replace(/\s+$/, ""));
                line = "";
                lineW = 0;
                if (tk === " ") continue;
            }
            line += tk;
            lineW += w;
        }
        lines.push(line.replace(/\s+$/, ""));
    }
    return lines;
}

/** 气泡里存的是 markdown/HTML，导出成图片时压成纯文本 */
function plainText(raw) {
    var s = String(raw == null ? "" : raw);
    s = s.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, function (_, body) { return body; });
    s = s.replace(/`([^`\n]*)`/g, "$1");
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, function (_, alt) { return alt ? "[图:" + alt + "]" : "[图]"; });
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
    s = s.replace(/^\s{0,3}>\s?/gm, "");
    s = s.replace(/^\s*[-*+]\s+/gm, "• ");
    s = s.replace(/(\*\*|__)([\s\S]+?)\1/g, "$2");
    s = s.replace(/(\*|_)([^\n*_]+)\1/g, "$2");
    s = s.replace(/~~([\s\S]+?)~~/g, "$1");
    s = s.replace(/<[^>\n]{0,400}?>/g, "");
    s = s.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, function (_, n) {
        return { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[n];
    });
    s = s.replace(/[ \t]+\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

var SYS_MEDIA = {
    poke: 1, voice_call: 1, video_call: 1, accept_red_packet: 1, decline_red_packet: 1,
    accept_transfer: 1, decline_transfer: 1, accept_payment_request: 1, decline_payment_request: 1,
    group_admin_notice: 1, tool_notice: 1, music_notify: 1, system_instruction: 1,
};

function isSystemish(msg) {
    if (!msg) return false;
    if (msg.role === "system") return true;
    return !!msg.mediaType && SYS_MEDIA[msg.mediaType] === 1;
}

/** 非文本消息在图里的一行说明 */
function mediaLabel(msg) {
    var d = msg.mediaData || {};
    var t = msg.mediaType;
    if (!t) return "";
    if (t === "image") return "[图片]";
    if (t === "sticker") return d.label ? "[表情:" + d.label + "]" : "[表情]";
    if (t === "audio") return d.voiceDuration ? '[语音 ' + Math.round(d.voiceDuration) + '"]' : "[语音]";
    if (t === "video") return "[视频]";
    if (t === "media_file") return "[文件" + (d.fileName ? "：" + d.fileName : "") + "]";
    if (t === "red_packet") return "[红包]" + (d.label ? " " + d.label : "") + (d.amount ? " ￥" + d.amount : "");
    if (t === "transfer") return "[转账]" + (d.amount ? " ￥" + d.amount : "") + (d.label ? " " + d.label : "");
    if (t === "payment_request") return "[代付请求]" + (d.paymentRequestAmountLabel ? " " + d.paymentRequestAmountLabel : "");
    if (t === "location") return "[位置]" + (d.label ? " " + d.label : "");
    if (t === "poke") return "[拍一拍] " + (d.pokeSender ? d.pokeSender + " 拍了拍" : "") + (d.pokeTarget ? d.pokeTarget : "");
    if (t === "dice") return "[骰子] " + (d.diceFace || "?") + " 点";
    if (t === "voice_call") return "[语音通话]" + (d.callDuration ? " " + d.callDuration : "");
    if (t === "video_call") return "[视频通话]" + (d.callDuration ? " " + d.callDuration : "");
    if (t === "music" || t === "music_share") return "[音乐]" + (d.musicTitle ? " " + d.musicTitle : "") + (d.musicArtist ? " - " + d.musicArtist : "");
    if (t === "gift") return "[礼物]" + (d.giftName ? " " + d.giftName : "");
    if (t === "contact_card") return "[名片]" + (d.contactCardName ? " " + d.contactCardName : "");
    if (t === "app_card") return "[卡片]" + (d.appCardTitle ? " " + d.appCardTitle : "");
    if (t === "tool_call") return "[工具调用]";
    if (t === "tool_result") return "[工具结果]";
    if (t === "tool_notice") return "[工具提示]";
    if (t === "memory_write_request") return "[记忆写入请求]";
    if (t === "reading_discuss") return "[阅读讨论]";
    if (t === "quote") return "[引用]";
    if (t.indexOf("plugin:") === 0) return "[插件卡片 " + t.slice(7) + "]";
    return "[" + t + "]";
}

var TAG_ONLY_RE = /^(\[[^\]]{1,12}\]|•?\s*)+$/;

/** 正文（含引用行、媒体说明）；图片真的嵌进图后不再打 [图片]/[表情] 前缀 */
function bodyTextOf(msg, dropMediaTag) {
    var d = msg.mediaData || {};
    var body = plainText(msg.content);
    if (!body) {
        if (msg.mediaType === "image" && d.label) body = plainText(d.label);
        else if (msg.mediaType === "audio" && d.synthesizedFromText) body = plainText(d.synthesizedFromText);
        else if (msg.isRetracted) body = "（该消息已撤回）";
    }
    if (d.quotePreview) body = "引用「" + plainText(d.quotePreview) + "」" + (body ? "\n" + body : "");
    var label = mediaLabel(msg);
    var embedded = dropMediaTag && (msg.mediaType === "image" || msg.mediaType === "sticker"
        || (msg.mediaType === "media_file" && d.fileType === "image"));
    if (label && !(embedded && body)) body = body ? label + " " + body : label;
    if (!body) body = msg.isRetracted ? "（该消息已撤回）" : "(空消息)";
    if (dropMediaTag && TAG_ONLY_RE.test(body)) body = "";
    return body;
}

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function fmtClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmtDay(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + WEEKDAYS[d.getDay()];
}

function dayKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "?";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function hashStr(s) {
    var h = 0;
    var str = String(s || "");
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

var AVATAR_COLORS = ["#4c7dff", "#20a06a", "#d4763b", "#8b5cf6", "#c2415f", "#0f9bb3", "#7a8a99", "#b58900"];

function avatarColor(name) {
    return AVATAR_COLORS[hashStr(name || "?") % AVATAR_COLORS.length];
}

function sanitizeFileBase(s) {
    var t = String(s || "chat").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "_").slice(0, 48);
    return t || "chat";
}

/** 显示顺序：全部带 order 时按 order，否则按时间；同值保持原数组次序 */
function sortMessages(list) {
    var arr = (list || []).slice();
    var boxed = arr.map(function (m, i) { return { m: m, i: i }; });
    var allOrdered = arr.length > 0 && arr.every(function (m) {
        return typeof m.order === "number" && isFinite(m.order);
    });
    if (allOrdered) {
        boxed.sort(function (a, b) { return (a.m.order - b.m.order) || (a.i - b.i); });
    } else {
        boxed.sort(function (a, b) {
            var ta = Date.parse(a.m.createdAt || "") || 0;
            var tb = Date.parse(b.m.createdAt || "") || 0;
            return (ta - tb) || (a.i - b.i);
        });
    }
    return boxed.map(function (x) { return x.m; });
}

/**
 * 显示层 id → 存储层 id。
 * 长回复会被拆成多条存储消息、再按 part 投影，投影出来的 id 形如
 * `${batch[0].id}__display_3` / `__display_meta`；直接砍后缀会一律落到 batch[0]，
 * 这里按 responseBatchId+rawResponseText 复原批次，找回宿主真正选中的那条。
 * 批次字段缺失（旧数据）时退化成砍后缀。
 */
function resolveDisplayIds(rawIds, pool) {
    var byId = {};
    var groups = {};
    (pool || []).forEach(function (m) { byId[m.id] = m; });
    (pool || []).forEach(function (m) {
        if (m.role !== "assistant" || !m.responseBatchId) return;
        var raw = (m.rawResponseText || "").trim();
        if (!raw) return;
        var k = (m.responseRoundId || "") + "\u001f" + m.responseBatchId + "\u001f" + raw;
        (groups[k] = groups[k] || []).push(m);
    });
    var groupOf = {};
    Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        for (var i = 0; i < g.length; i++) if (!groupOf[g[i].id]) groupOf[g[i].id] = g;
    });

    var out = [];
    var seen = {};
    function push(id) { if (id && !seen[id] && byId[id]) { seen[id] = 1; out.push(id); } }

    (rawIds || []).forEach(function (rawId) {
        var mt = /^(.*)__display_(meta|\d+)$/.exec(String(rawId));
        if (!mt) { push(rawId); return; }
        var base = mt[1];
        var g = groupOf[base];
        if (!g) { push(base); return; }
        if (mt[2] === "meta") {
            var carrier = null;
            for (var i = 0; i < g.length; i++) {
                var m = g[i];
                if (m.statusPanel || m.innerMonologue || m.reasoningText || (m.stateValues && m.stateValues.length)) { carrier = m; break; }
            }
            push(carrier ? carrier.id : base);
        } else {
            // part 序号超出存储条数时，宿主一律把内容挂在批次最后一条上
            push(g[g.length - 1].id);
        }
    });
    return out;
}

// ═════════════════════════════════════════════════════════
// 二、主题
// ═════════════════════════════════════════════════════════

var THEMES = {
    paper: {
        label: "浅灰纸感",
        pageBg: "#f2f4f7", cardBg: "#ffffff",
        title: "#1c2130", sub: "#8b93a3", text: "#1f2430", meta: "#98a0af",
        sysBg: "rgba(30,36,50,.05)", sysText: "#8b93a3",
        bubbleUser: "#d7e6ff", bubbleOther: "#ffffff", bubbleBorder: "rgba(20,26,38,.05)",
        hairline: "rgba(20,26,38,.08)", watermark: "#aab2c0",
    },
    wechat: {
        label: "微信绿",
        pageBg: "#ededed", cardBg: "#ededed",
        title: "#191919", sub: "#9b9b9b", text: "#191919", meta: "#9b9b9b",
        sysBg: "rgba(0,0,0,.06)", sysText: "#9b9b9b",
        bubbleUser: "#95ec69", bubbleOther: "#ffffff", bubbleBorder: "rgba(0,0,0,.04)",
        hairline: "rgba(0,0,0,.07)", watermark: "#b2b2b2",
    },
    dark: {
        label: "深色",
        pageBg: "#131519", cardBg: "#1b1e25",
        title: "#eef1f7", sub: "#8d96a8", text: "#e6e9f0", meta: "#8d96a8",
        sysBg: "rgba(255,255,255,.07)", sysText: "#8d96a8",
        bubbleUser: "#3f6fb5", bubbleOther: "#262b34", bubbleBorder: "rgba(255,255,255,.06)",
        hairline: "rgba(255,255,255,.08)", watermark: "#6e7686",
    },
};

var FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

function fontStr(px, weight) { return (weight ? weight + " " : "") + px + "px " + FONT_STACK; }

// ═════════════════════════════════════════════════════════
// 二·五、采样「我自己调好的气泡」（跟随我的气泡样式）
//   数据来源只有 DOM：气泡元素 + ::before 的九宫格 border-image
// ═════════════════════════════════════════════════════════

function numPx(v, def) {
    var n = parseFloat(String(v == null ? "" : v));
    return isFinite(n) && n >= 0 ? n : def;
}

function cssUrlValue(v) {
    if (!v || v === "none") return "";
    var m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/.exec(String(v));
    if (!m) return "";
    return String(m[1] || m[2] || m[3] || "").trim();
}

function transparentish(color) {
    if (!color) return true;
    var c = String(color).trim().toLowerCase();
    if (c === "transparent" || c === "none" || c === "") return true;
    var m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(c);
    if (m) return m[4] !== undefined ? Number(m[4]) <= 0.01 : false;
    return false;
}

function parseColor(v) {
    var c = String(v == null ? "" : v).trim().toLowerCase();
    if (!c || c === "transparent" || c === "none") return null;
    var m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))) };
    var h = /^#([0-9a-f]{3,8})$/.exec(c);
    if (h) {
        var s = h[1];
        if (s.length === 3 || s.length === 4) s = s.split("").map(function (x) { return x + x; }).join("");
        return {
            r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16),
            a: s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1,
        };
    }
    return null;
}

/** 半透明底色直接铺进画布会导出带 alpha 的 PNG（换个查看器就变颜色），压平成不透明 */
function toOpaque(color, base) {
    var p = parseColor(color);
    if (!p) return String(base || "#ffffff");
    if (p.a >= 0.999) return "rgb(" + p.r + "," + p.g + "," + p.b + ")";
    var b = parseColor(base) || { r: 255, g: 255, b: 255, a: 1 };
    var a = p.a;
    return "rgb(" + Math.round(p.r * a + b.r * (1 - a)) + "," + Math.round(p.g * a + b.g * (1 - a)) + "," + Math.round(p.b * a + b.b * (1 - a)) + ")";
}

function firstOpaqueBg(el) {
    var n = el;
    while (n && n !== document.documentElement) {
        var c = getComputedStyle(n).backgroundColor;
        var p = parseColor(c);
        if (p && p.a >= 0.999) return c;
        n = n.parentElement;
    }
    return "";
}

function splitTopLevelCommas(v) {
    var out = [];
    var depth = 0;
    var cur = "";
    for (var i = 0; i < v.length; i++) {
        var ch = v[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

function parseShadow(v) {
    if (!v || v === "none") return null;
    var seg = splitTopLevelCommas(String(v))[0];
    if (!seg || /inset/.test(seg)) return null;
    var color = "";
    seg = seg.replace(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/, function (m) { color = m; return " "; });
    var nums = (seg.match(/-?\d*\.?\d+(?:px|em|rem)?/g) || []).map(parseFloat).filter(function (n) { return isFinite(n); });
    if (nums.length < 3) return null;
    var blur = Math.abs(nums[2]);
    if (blur < 0.5 && Math.abs(nums[1]) < 0.5) return null;
    return { color: color || "rgba(0,0,0,.18)", dx: nums[0], dy: nums[1], blur: blur };
}

function minRadius(s) {
    var rs = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]
        .map(function (v) { return numPx(String(v).split(" ")[0], 0); });
    var min = Math.min.apply(null, rs);
    return min > 0 ? min : 0;
}

/** border-image-slice 是源图像素（或百分比），display 宽度取 ::before 的 border-width */
function parseNineSlice(raw, imgW, imgH) {
    if (!raw) return null;
    var fill = /\bfill\b/.test(raw);
    var tokens = String(raw).replace(/\bfill\b/, "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    var v = [];
    for (var i = 0; i < tokens.length && i < 4; i++) {
        var t = tokens[i];
        var isPct = /%$/.test(t);
        var n = parseFloat(t);
        if (!isFinite(n)) return null;
        if (isPct) n = n / 100 * ((i === 1 || i === 3) ? imgW : imgH);
        v.push(Math.max(0, n));
    }
    // CSS 简写展开：1→四边同值；2→上下/左右；3→上、左右同值、下
    if (v.length === 1) v = [v[0], v[0], v[0], v[0]];
    else if (v.length === 2) v = [v[0], v[1], v[0], v[1]];
    else if (v.length === 3) v = [v[0], v[1], v[2], v[1]];
    if (!(v[0] > 0) || !(v[1] > 0) || !(v[2] > 0) || !(v[3] > 0)) return null;
    // 中间区可以为 0（整张图都是圆角的贴纸气泡），但不能越过源图
    if (v[0] + v[2] > imgH || v[1] + v[3] > imgW) return null;
    return { slice: v, fill: fill };
}

function taintSafe(img) {
    try {
        var cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        var g = cv.getContext("2d");
        g.drawImage(img, 0, 0);
        g.getImageData(0, 0, 1, 1);
        return true;
    } catch (e) { return false; }
}

function loadSampledImage(src) {
    return new Promise(function (resolve) {
        if (!src) { resolve(null); return; }
        var img = new Image();
        var settled = false;
        function finish(v) { if (settled) return; settled = true; resolve(v ? img : null); }
        img.onload = function () { finish(taintSafe(img)); };
        img.onerror = function () { finish(false); };
        if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
        setTimeout(function () { finish(false); }, 3500);
        img.src = src;
    });
}

function ancestorBg(el) {
    var n = el;
    while (n && n !== document.documentElement) {
        var s = getComputedStyle(n);
        var url = cssUrlValue(s.backgroundImage);
        if (url || !transparentish(s.backgroundColor)) {
            return {
                color: transparentish(s.backgroundColor) ? "" : s.backgroundColor,
                url: url,
                raw: String(s.backgroundImage || ""),
            };
        }
        n = n.parentElement;
    }
    return { color: "", url: "", raw: "" };
}

function sampleAvatarRadius(el, k) {
    var box = el && (el.querySelector(".chat-msg-avatar > *") || el.querySelector(".chat-msg-avatar"));
    if (!box) return 8;
    var s = getComputedStyle(box);
    var r = minRadius(s);
    var w = box.clientWidth || 40;
    if (!r || r >= w / 2 - 0.5) return Math.round(Math.min(G.avatar, w * k) / 2);
    return Math.round(Math.min(G.avatar / 2, r * k));
}

async function sampleSide(el, k) {
    var s = getComputedStyle(el);
    var before = null;
    try { before = getComputedStyle(el, "::before"); } catch (e) { before = null; }

    var metrics = {
        padL: Math.round(numPx(s.paddingLeft, G.bubblePadX) * k),
        padR: Math.round(numPx(s.paddingRight, G.bubblePadX) * k),
        padT: Math.round(numPx(s.paddingTop, G.bubblePadY) * k),
        padB: Math.round(numPx(s.paddingBottom, G.bubblePadY) * k),
        radius: Math.round(minRadius(s) * k),
        fontPx: Math.round(numPx(s.fontSize, G.fontPx) * k * 10) / 10,
        lineH: 0,
        minW: Math.round(numPx(s.minWidth, 0) * k),
        minH: Math.round(numPx(s.minHeight, 0) * k),
        imgRadius: 8,
        textColor: transparentish(s.color) ? "" : s.color,
    };
    var lh = parseFloat(String(s.lineHeight || ""));
    metrics.lineH = isFinite(lh) && lh > 4 ? Math.round(lh * k * 10) / 10 : Math.round(metrics.fontPx * 1.53 * 10) / 10;

    var art = {
        color: transparentish(s.backgroundColor) ? "" : s.backgroundColor,
        borderWidth: Math.max(numPx(s.borderTopWidth, 0), numPx(s.borderRightWidth, 0), numPx(s.borderBottomWidth, 0), numPx(s.borderLeftWidth, 0)) * k,
        borderColor: transparentish(s.borderTopColor) ? (s.borderTopColor || "") : s.borderTopColor,
        shadow: parseShadow(s.boxShadow),
        nine: null,
        bg: null,
    };

    var nineUrl = before ? cssUrlValue(before.borderImageSource || before.webkitBorderImageSource || "") : "";
    if (nineUrl) {
        var img = await loadSampledImage(nineUrl);
        if (img) {
            var iw = img.naturalWidth, ih = img.naturalHeight;
            var parsed = parseNineSlice(before.borderImageSlice, iw, ih);
            if (parsed) {
                var bw = [
                    numPx(before.borderTopWidth, 0), numPx(before.borderRightWidth, 0),
                    numPx(before.borderBottomWidth, 0), numPx(before.borderLeftWidth, 0),
                ];
                var hasBw = bw.some(function (v) { return v > 0; });
                art.nine = {
                    img: img,
                    slice: parsed.slice,
                    fill: parsed.fill,
                    display: hasBw ? [bw[0] * k, bw[1] * k, bw[2] * k, bw[3] * k] : parsed.slice.slice(),
                };
            }
        }
    }
    if (!art.nine) {
        var bgUrl = cssUrlValue(s.backgroundImage);
        if (bgUrl && !/gradient/i.test(s.backgroundImage)) {
            var bimg = await loadSampledImage(bgUrl);
            if (bimg) art.bg = { img: bimg };
        }
    }
    return { metrics: metrics, art: art };
}

/** 读取当前会话里真实渲染的气泡，导出成与屏幕上成比例的样式；读不到返回 null */
async function sampleMyTheme(targetWidth) {
    var userEl = document.querySelector('.chat-msg-wrapper [data-ui="bubble-user"]');
    var botEl = document.querySelector('.chat-msg-wrapper [data-ui="bubble-bot"]');
    var any = userEl || botEl;
    if (!any) return null;

    var wrapper = any.closest(".chat-msg-wrapper") || any;
    var wrapParent = wrapper.parentElement;
    // 比例基准取消息列表实际列宽；宿主没挂 .chat-room-main-pane 时也有兜底
    var column = (wrapParent && wrapParent.clientWidth > 200 ? wrapParent : null)
        || any.closest(".chat-room-main-pane") || document.documentElement;
    var viewW = Math.max(240, column.clientWidth || window.innerWidth || 390);
    var k = Math.max(1, Math.min(2.5, targetWidth / viewW));

    var rootCS = getComputedStyle(any);
    function v(name, def) { var got = String(rootCS.getPropertyValue(name) || "").trim(); return got || def; }

    var u = userEl ? await sampleSide(userEl, k) : null;
    var o = botEl ? await sampleSide(botEl, k) : null;
    if (!u && !o) return null;

    // 从消息列表容器往上找底色：选中态会给 wrapper 加高亮底色，不能当成聊天背景
    var bgStart = wrapParent || wrapper;
    var bg = ancestorBg(bgStart);
    var bgImg = (bg.url && !/gradient/i.test(bg.raw)) ? await loadSampledImage(bg.url) : null;
    var opaqueBase = firstOpaqueBg(bgStart) || v("--c-page-body-bg", "#f2f4f7");
    var pageBg = toOpaque(bg.color || opaqueBase, opaqueBase);

    var theme = {
        label: "跟随我的气泡",
        pageBg: pageBg,
        cardBg: v("--c-card-bg", pageBg),
        title: v("--c-text-title", "#1c2130"),
        sub: v("--c-muted", "#8b93a3"),
        text: v("--c-text", "#1f2430"),
        meta: v("--c-muted", "#98a0af"),
        sysBg: "rgba(128,138,155,.16)",
        sysText: v("--c-muted", "#8b93a3"),
        bubbleUser: (u && u.art.color) || v("--c-bubble-self", "#d7e6ff"),
        bubbleOther: (o && o.art.color) || v("--c-bubble-other", "#ffffff"),
        bubbleBorder: v("--c-border", "rgba(20,26,38,.08)"),
        hairline: v("--c-border", "rgba(20,26,38,.08)"),
        watermark: v("--c-muted", "#aab2c0"),
        avatarRadius: sampleAvatarRadius(wrapper, k),
        pageBgImg: bgImg ? { img: bgImg, cover: true } : null,
        art: { user: u ? u.art : null, other: o ? o.art : null },
        sampled: true,
    };
    var metrics = {
        user: u ? u.metrics : null,
        other: o ? o.metrics : null,
    };
    // 缺某一边时用另一边兜底，保证布局常量齐全
    if (!metrics.user && metrics.other) metrics.user = Object.assign({}, metrics.other);
    if (!metrics.other && metrics.user) metrics.other = Object.assign({}, metrics.user);
    return { theme: theme, metrics: metrics, k: k };
}

// ═════════════════════════════════════════════════════════
// 三、布局：先量（buildBlocks/paginate），后画
// ═════════════════════════════════════════════════════════

var G = {
    padX: 18, padTop: 16, padBottom: 18,
    headerH: 74, footerH: 44, dayH: 34, moreH: 30,
    metaH: 20, rowGap: 14,
    avatar: 34, avatarGap: 9,
    bubblePadX: 13, bubblePadY: 9, bubbleRadius: 12, imgGap: 9,
    fontPx: 15, metaPx: 11, lineH: 23,
};

var DEFAULT_METRICS = {
    padL: G.bubblePadX, padR: G.bubblePadX, padT: G.bubblePadY, padB: G.bubblePadY,
    radius: G.bubbleRadius, fontPx: G.fontPx, lineH: G.lineH,
    minW: 0, minH: 0, imgRadius: 8,
};

function metricsFor(cfg, side) {
    var m = cfg.bubbleMetrics && cfg.bubbleMetrics[side === "right" ? "user" : "other"];
    return m || DEFAULT_METRICS;
}

function wrapAt(measure, text, maxW, px) {
    return wrapText(function (s) { return measure(s, px); }, text, maxW);
}

/**
 * items: [{ msg, name, time, text, side, img:{el,w,h}|null }]
 * cfg:   { width, style, showTime, showAvatar, showName, title, subtitle, watermark, bubbleMetrics }
 */
function buildBlocks(measure, items, cfg) {
    var blocks = [];
    var contentW = cfg.width - G.padX * 2;
    blocks.push({ type: "header", h: G.headerH, title: cfg.title, subtitle: cfg.subtitle });

    var lastDay = "";
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (cfg.showTime) {
            var dk = dayKey(it.msg && it.msg.createdAt);
            if (dk !== lastDay) {
                lastDay = dk;
                blocks.push({ type: "day", h: G.dayH, text: fmtDay(it.msg && it.msg.createdAt) });
            }
        }

        if (it.side === "center") {
            var maxSysW = Math.min(contentW * 0.86, contentW);
            var sysLines = wrapAt(measure, it.text, maxSysW - G.bubblePadX * 2, G.fontPx);
            var sysBodyH = sysLines.length * G.lineH + G.bubblePadY * 2;
            var sysTextW = 0;
            for (var a = 0; a < sysLines.length; a++) sysTextW = Math.max(sysTextW, measure(sysLines[a], G.fontPx));
            blocks.push({
                type: "sys", h: G.rowGap + sysBodyH, lines: sysLines, bodyH: sysBodyH,
                w: Math.min(maxSysW, Math.max(48, sysTextW + G.bubblePadX * 2)),
            });
            continue;
        }

        if (cfg.style === "transcript") {
            var tLines = wrapAt(measure, it.text, contentW, G.fontPx);
            var showMetaT = (cfg.showName && it.name) || (cfg.showTime && it.time);
            blocks.push({
                type: "tline",
                h: (showMetaT ? G.metaH : 0) + tLines.length * G.lineH + G.rowGap,
                lines: tLines, name: it.name, time: it.time, showMeta: !!showMetaT, side: it.side,
            });
            continue;
        }

        var mm = metricsFor(cfg, it.side);
        var padW = mm.padL + mm.padR, padH = mm.padT + mm.padB;
        var avatarW = cfg.showAvatar ? G.avatar + G.avatarGap : 0;
        var showMeta = (cfg.showName && it.name) || (cfg.showTime && it.time);
        var maxBubbleW = Math.min(contentW - avatarW, contentW * 0.78);
        var bLines = wrapAt(measure, it.text, Math.max(20, maxBubbleW - padW), mm.fontPx);
        var textW = 0;
        for (var b2 = 0; b2 < bLines.length; b2++) textW = Math.max(textW, measure(bLines[b2], mm.fontPx));
        var bubbleW = Math.min(maxBubbleW, Math.max(mm.minW || 48, textW + padW));
        var imgW = 0, imgH = 0;
        if (it.img) {
            imgW = Math.min(it.img.w, Math.max(20, maxBubbleW - padW));
            imgH = Math.max(1, Math.round(it.img.h * (imgW / it.img.w)));
            bubbleW = Math.max(bubbleW, imgW + padW);
        }
        var bubbleH = bLines.length * mm.lineH + padH + (it.img ? imgH + (bLines.length ? G.imgGap : 0) : 0);
        if (mm.minH) bubbleH = Math.max(bubbleH, mm.minH);
        var bodyH = Math.max(bubbleH, cfg.showAvatar ? G.avatar : 0);
        blocks.push({
            type: "msg",
            h: (showMeta ? G.metaH : 0) + bodyH + G.rowGap,
            lines: bLines, name: it.name, time: it.time, showMeta: !!showMeta, side: it.side,
            avatar: it.avatarName || it.name || (it.side === "right" ? "我" : "TA"),
            bubbleW: bubbleW, bubbleH: bubbleH, bodyH: bodyH, m: mm,
            img: it.img ? { el: it.img.el, w: imgW, h: imgH } : null,
        });
    }

    blocks.push({ type: "footer", h: G.footerH, text: cfg.watermark });
    return blocks;
}

/** 按页高上限打包成多页；header 恒在第 1 页，footer 恒在最后一页 */
function paginate(blocks, maxPageH) {
    var limit = maxPageH > 120 ? maxPageH : 120;
    var head = [];
    var body = blocks.slice();
    if (body.length && body[0].type === "header") { head.push(body.shift()); }
    var foot = [];
    if (body.length && body[body.length - 1].type === "footer") { foot.push(body.pop()); }

    var pages = [];
    var cur = head.slice();
    var curH = sumH(head);
    for (var i = 0; i < body.length; i++) {
        var b = body[i];
        if (cur.length > head.length && curH + b.h > limit) {
            pages.push(cur);
            cur = [];
            curH = 0;
        }
        cur.push(b);
        curH += b.h;
    }
    if (cur.length || !pages.length) pages.push(cur);

    for (var p = 1; p < pages.length; p++) pages[p].unshift({ type: "more", h: G.moreH, text: "接下段 " + (p + 1) + "/" + pages.length });
    // 「接下段」提示自身也占高，超限时把它所在块顺延到下一页，简单处理：仅在允许误差内保留
    pages[pages.length - 1] = pages[pages.length - 1].concat(foot);
    return pages;
}

function sumH(list) {
    var h = 0;
    for (var i = 0; i < list.length; i++) h += list[i].h;
    return h;
}

// ═════════════════════════════════════════════════════════
// 四、绘制
// ═════════════════════════════════════════════════════════

function roundRect(c, x, y, w, h, r) {
    var rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y);
    c.quadraticCurveTo(x + w, y, x + w, y + rr);
    c.lineTo(x + w, y + h - rr);
    c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c.lineTo(x + rr, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - rr);
    c.lineTo(x, y + rr);
    c.quadraticCurveTo(x, y, x + rr, y);
    c.closePath();
}

function fitTo(c, text, maxW) {
    var s = String(text == null ? "" : text);
    if (c.measureText(s).width <= maxW) return s;
    var chars = Array.from(s);
    var acc = "";
    for (var i = 0; i < chars.length; i++) {
        if (c.measureText(acc + chars[i] + "…").width > maxW) return acc + "…";
        acc += chars[i];
    }
    return acc;
}

function drawAvatar(c, x, y, size, name, radius) {
    var chars = Array.from(name || "?");
    c.fillStyle = avatarColor(name);
    roundRect(c, x, y, size, size, radius === undefined ? 8 : radius);
    c.fill();
    c.fillStyle = "#ffffff";
    c.font = fontStr(Math.round(size * 0.4), "600");
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(chars[0] || "?", x + size / 2, y + size / 2 + 1);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
}

/** border-image 九宫格：slice=源图像素切片，display=四边显示宽度 */
function drawNineSlice(c, nine, x, y, w, h) {
    var img = nine.img;
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih || w <= 0 || h <= 0) return false;
    var s = nine.slice, d = nine.display;
    // 显示宽度过大时按比例缩，保证中间区不为负
    var kx = (d[3] + d[1]) > w ? w / (d[3] + d[1]) : 1;
    var ky = (d[0] + d[2]) > h ? h / (d[0] + d[2]) : 1;
    var dl = d[3] * kx, dr = d[1] * kx, dt = d[0] * ky, db = d[2] * ky;
    var sx = [0, s[3], iw - s[1]];
    var sw = [s[3], iw - s[1] - s[3], s[1]];
    var sy = [0, s[0], ih - s[2]];
    var sh = [s[0], ih - s[0] - s[2], s[2]];
    var dx = [x, x + dl, x + w - dr];
    var dw = [dl, w - dl - dr, dr];
    var dy = [y, y + dt, y + h - db];
    var dh = [dt, h - dt - db, db];
    var painted = 0;
    for (var r = 0; r < 3; r++) {
        for (var col = 0; col < 3; col++) {
            if (r === 1 && col === 1 && !nine.fill) continue;
            if (sw[col] <= 0 || sh[r] <= 0 || dw[col] <= 0 || dh[r] <= 0) continue;
            try { c.drawImage(img, sx[col], sy[r], sw[col], sh[r], dx[col], dy[r], dw[col], dh[r]); painted++; } catch (e) { return false; }
        }
    }
    return painted > 0;
}

/** art 存在时优先用九宫格/背景图，否则纯色圆角；两者都会画描边与阴影 */
function drawBubbleBg(c, x, y, w, h, art, fill, radius) {
    var drawn = false;
    if (art && art.nine && art.nine.img) drawn = drawNineSlice(c, art.nine, x, y, w, h);
    if (!drawn && art && art.bg && art.bg.img) {
        c.save();
        roundRect(c, x, y, w, h, radius);
        c.clip();
        try { c.drawImage(art.bg.img, x, y, w, h); drawn = true; } catch (e) { drawn = false; }
        c.restore();
    }
    if (!drawn) {
        c.save();
        if (art && art.shadow) {
            c.shadowColor = art.shadow.color;
            c.shadowBlur = art.shadow.blur;
            c.shadowOffsetX = art.shadow.dx;
            c.shadowOffsetY = art.shadow.dy;
        }
        c.fillStyle = (art && art.color) || fill;
        roundRect(c, x, y, w, h, radius);
        c.fill();
        c.restore();
    }
    var bw = art ? art.borderWidth : 0;
    if (bw > 0 && !(art && art.nine && art.nine.img)) {
        c.save();
        c.strokeStyle = art.borderColor || "rgba(0,0,0,.08)";
        c.lineWidth = bw;
        roundRect(c, x + bw / 2, y + bw / 2, Math.max(0, w - bw), Math.max(0, h - bw), radius);
        c.stroke();
        c.restore();
    }
    return drawn;
}

function renderPage(pageBlocks, cfg, theme, scale) {
    var width = cfg.width;
    var height = G.padTop + G.padBottom + sumH(pageBlocks);
    var cv = document.createElement("canvas");
    cv.width = Math.round(width * scale);
    cv.height = Math.max(1, Math.round(height * scale));
    var c = cv.getContext("2d");
    c.scale(scale, scale);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = theme.pageBg;
    c.fillRect(0, 0, width, height);
    if (theme.pageBgImg && theme.pageBgImg.img) {
        var bi = theme.pageBgImg;
        var scale0 = Math.max(width / bi.img.naturalWidth, height / bi.img.naturalHeight) * (bi.cover ? 1 : 1);
        var bw2 = bi.img.naturalWidth * scale0, bh2 = bi.img.naturalHeight * scale0;
        try { c.drawImage(bi.img, (width - bw2) / 2, (height - bh2) / 2, bw2, bh2); } catch (e) { /* 背景图不可用则只留底色 */ }
    }

    var contentW = width - G.padX * 2;
    var y = G.padTop;

    for (var i = 0; i < pageBlocks.length; i++) {
        var blk = pageBlocks[i];

        if (blk.type === "header") {
            c.fillStyle = theme.cardBg;
            c.fillRect(0, 0, width, y + blk.h);
            c.fillStyle = theme.title;
            c.font = fontStr(19, "600");
            c.fillText(fitTo(c, blk.title, contentW), G.padX, y + 30);
            c.fillStyle = theme.sub;
            c.font = fontStr(12, "400");
            c.fillText(fitTo(c, blk.subtitle, contentW), G.padX, y + 54);
            c.strokeStyle = theme.hairline;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(G.padX, y + blk.h - 0.5);
            c.lineTo(width - G.padX, y + blk.h - 0.5);
            c.stroke();
            y += blk.h;
            continue;
        }

        if (blk.type === "day" || blk.type === "more") {
            c.font = fontStr(G.metaPx, "500");
            var pw = c.measureText(String(blk.text)).width + 22;
            c.fillStyle = theme.sysBg;
            roundRect(c, (width - pw) / 2, y + (blk.h - 22) / 2, pw, 22, 11);
            c.fill();
            c.fillStyle = theme.sysText;
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(String(blk.text), width / 2, y + blk.h / 2);
            c.textAlign = "left";
            c.textBaseline = "alphabetic";
            y += blk.h;
            continue;
        }

        if (blk.type === "sys") {
            var sx = (width - blk.w) / 2;
            c.fillStyle = theme.sysBg;
            roundRect(c, sx, y, blk.w, blk.bodyH, G.bubbleRadius);
            c.fill();
            c.fillStyle = theme.sysText;
            c.font = fontStr(G.fontPx, "400");
            c.textBaseline = "middle";
            for (var s = 0; s < blk.lines.length; s++) {
                c.fillText(blk.lines[s], sx + G.bubblePadX, y + G.bubblePadY + s * G.lineH + G.lineH / 2);
            }
            c.textBaseline = "alphabetic";
            y += blk.h;
            continue;
        }

        if (blk.type === "tline") {
            if (blk.showMeta) {
                c.textBaseline = "middle";
                if (blk.name) {
                    c.font = fontStr(G.metaPx + 1, "600");
                    c.fillStyle = blk.side === "right" ? theme.meta : avatarColor(blk.name);
                    c.fillText(fitTo(c, blk.name, contentW * 0.5), G.padX, y + G.metaH / 2);
                }
                if (blk.time) {
                    c.font = fontStr(G.metaPx, "400");
                    c.fillStyle = theme.meta;
                    c.textAlign = "right";
                    c.fillText(blk.time, width - G.padX, y + G.metaH / 2);
                    c.textAlign = "left";
                }
                c.textBaseline = "alphabetic";
                y += G.metaH;
            }
            c.fillStyle = theme.text;
            c.font = fontStr(G.fontPx, "400");
            c.textBaseline = "middle";
            for (var t = 0; t < blk.lines.length; t++) {
                c.fillText(blk.lines[t], G.padX, y + t * G.lineH + G.lineH / 2);
            }
            c.textBaseline = "alphabetic";
            y += blk.lines.length * G.lineH;
            c.strokeStyle = theme.hairline;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(G.padX, y + G.rowGap / 2);
            c.lineTo(width - G.padX, y + G.rowGap / 2);
            c.stroke();
            y += G.rowGap;
            continue;
        }

        if (blk.type === "msg") {
            var right = blk.side === "right";
            var avatarW = cfg.showAvatar ? G.avatar + G.avatarGap : 0;
            var bodyTop = y + (blk.showMeta ? G.metaH : 0);

            if (blk.showMeta) {
                c.font = fontStr(G.metaPx, "500");
                c.fillStyle = theme.meta;
                c.textBaseline = "middle";
                if (blk.name) {
                    var nameX = right ? (width - G.padX - avatarW - (blk.time ? 46 : 0)) : (G.padX + avatarW);
                    nameX = Math.max(G.padX, Math.min(nameX, width - G.padX - 20));
                    if (right) {
                        c.textAlign = "right";
                        c.fillText(fitTo(c, blk.name, contentW * 0.5), nameX, y + G.metaH / 2);
                        c.textAlign = "left";
                    } else {
                        c.fillText(fitTo(c, blk.name, contentW * 0.5), nameX, y + G.metaH / 2);
                    }
                }
                if (blk.time) {
                    c.textAlign = right ? "left" : "right";
                    var timeX = right ? (width - G.padX - avatarW) : (width - G.padX);
                    if (right) timeX = width - G.padX - avatarW - c.measureText(blk.time).width - 0;
                    c.fillText(blk.time, right ? timeX : width - G.padX, y + G.metaH / 2);
                    c.textAlign = "left";
                }
                c.textBaseline = "alphabetic";
            }

            var bubbleTop = bodyTop + (blk.bodyH - blk.bubbleH);
            var bubbleX = right ? (width - G.padX - avatarW - blk.bubbleW) : (G.padX + avatarW);
            bubbleX = Math.max(G.padX, Math.min(bubbleX, width - G.padX - blk.bubbleW));
            var mm = blk.m || DEFAULT_METRICS;

            if (cfg.showAvatar) {
                drawAvatar(c, right ? (width - G.padX - G.avatar) : G.padX, bubbleTop, G.avatar, blk.avatar, theme.avatarRadius);
            }

            drawBubbleBg(c, bubbleX, bubbleTop, blk.bubbleW, blk.bubbleH,
                right ? (theme.art && theme.art.user) : (theme.art && theme.art.other),
                right ? theme.bubbleUser : theme.bubbleOther,
                mm.radius);

            var textTop = bubbleTop + mm.padT;
            var textLeft = bubbleX + mm.padL;
            if (blk.img) {
                c.save();
                roundRect(c, textLeft, textTop, blk.img.w, blk.img.h, mm.imgRadius);
                c.clip();
                try { c.drawImage(blk.img.el, textLeft, textTop, blk.img.w, blk.img.h); } catch (e) { /* 图片失效则留白 */ }
                c.restore();
                textTop += blk.img.h + (blk.lines.length ? G.imgGap : 0);
            }
            c.fillStyle = mm.textColor || theme.text;
            c.font = fontStr(mm.fontPx, "400");
            c.textBaseline = "middle";
            for (var m = 0; m < blk.lines.length; m++) {
                c.fillText(blk.lines[m], textLeft, textTop + m * mm.lineH + mm.lineH / 2);
            }
            c.textBaseline = "alphabetic";
            y += blk.h;
            continue;
        }

        if (blk.type === "footer") {
            c.fillStyle = theme.watermark;
            c.font = fontStr(11, "400");
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(fitTo(c, blk.text, contentW), width / 2, y + blk.h / 2);
            c.textAlign = "left";
            c.textBaseline = "alphabetic";
            y += blk.h;
            continue;
        }

        y += blk.h;
    }

    return cv;
}

// ═════════════════════════════════════════════════════════
// 五、插件
// ═════════════════════════════════════════════════════════

var CSS = [
    // 多选栏内注入的导出按钮（与宿主删除按钮同款尺寸，避免撑破栏高）
    ".cei-ms-btn{flex:0 0 auto;border:0;min-height:44px;border-radius:14px;padding:0 16px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:calc(14px*var(--app-text-scale,1));font-weight:600;background:color-mix(in srgb,var(--c-primary,#3b82f6) 14%,transparent);color:var(--c-primary,#3b82f6);}",
    ".cei-ms-btn:disabled{opacity:.45;cursor:not-allowed;}",
    // 输入栏「+」面板里的入口：网格与图标盒跟宿主 .chat-plus-menu 同款参数
    ".cei-plus-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:16px;}",
    ".cei-plus-item{display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;-webkit-user-select:none;user-select:none;}",
    ".cei-plus-box{width:44px;height:44px;border-radius:12px;border:1px solid transparent;background:var(--c-panel);display:flex;align-items:center;justify-content:center;color:var(--c-icon);box-shadow:0 1px 3px rgba(0,0,0,.05);}",
    ".cei-plus-label{font-size:calc(11px*var(--app-text-scale,1));color:var(--c-text);text-align:center;}",
    ".cei-modal{display:flex;flex-direction:column;height:min(76vh,620px);font-size:14px;color:var(--c-text,#1f2430);}",
    ".cei-head{padding:14px 16px 10px;border-bottom:1px solid rgba(128,138,155,.18);}",
    ".cei-h-title{font-size:16px;font-weight:600;}",
    ".cei-h-sub{margin-top:4px;font-size:11px;opacity:.6;}",
    ".cei-tools{display:flex;gap:8px;padding:10px 16px 8px;flex-wrap:wrap;align-items:center;}",
    ".cei-search{flex:1 1 140px;min-width:120px;border:1px solid rgba(128,138,155,.3);background:transparent;color:inherit;border-radius:8px;padding:7px 9px;font-size:13px;}",
    ".cei-chip{border:1px solid rgba(128,138,155,.3);background:transparent;color:inherit;border-radius:999px;padding:5px 11px;font-size:12px;cursor:pointer;}",
    ".cei-chip[data-on=\"1\"]{background:#3b82f6;border-color:#3b82f6;color:#fff;}",
    ".cei-quick{display:flex;gap:6px;padding:0 16px 8px;flex-wrap:wrap;}",
    ".cei-quick .cei-chip{padding:4px 9px;font-size:11px;}",
    ".cei-list{flex:1 1 auto;overflow-y:auto;border-top:1px solid rgba(128,138,155,.14);}",
    ".cei-row{display:flex;gap:10px;align-items:flex-start;padding:9px 16px;border-bottom:1px solid rgba(128,138,155,.1);cursor:pointer;}",
    ".cei-row[data-sel=\"1\"]{background:rgba(59,130,246,.1);}",
    ".cei-row input{margin-top:2px;width:17px;height:17px;accent-color:#3b82f6;flex:0 0 auto;}",
    ".cei-row-main{flex:1 1 auto;min-width:0;}",
    ".cei-row-meta{display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:.62;}",
    ".cei-row-text{margin-top:3px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}",
    ".cei-empty{padding:26px 16px;text-align:center;font-size:13px;opacity:.55;}",
    ".cei-foot{display:flex;gap:8px;align-items:center;padding:10px 16px 14px;border-top:1px solid rgba(128,138,155,.18);flex-wrap:wrap;}",
    ".cei-count{flex:1 1 100%;font-size:12px;opacity:.75;}",
    ".cei-sel{border:1px solid rgba(128,138,155,.3);background:transparent;color:inherit;border-radius:8px;padding:6px 8px;font-size:12px;}",
    ".cei-go{border:0;background:#3b82f6;color:#fff;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;}",
    ".cei-go:disabled{opacity:.5;}",
    ".cei-res{display:flex;flex-direction:column;gap:14px;padding:14px 16px;}",
    ".cei-res-title{font-size:16px;font-weight:600;}",
    ".cei-card{border:1px solid rgba(128,138,155,.2);border-radius:12px;overflow:hidden;}",
    ".cei-card img{display:block;width:100%;height:auto;background:#fff;}",
    ".cei-card-ops{display:flex;gap:8px;padding:9px 10px;align-items:center;flex-wrap:wrap;}",
    ".cei-mini{border:1px solid rgba(128,138,155,.34);background:transparent;color:inherit;border-radius:8px;padding:6px 11px;font-size:12px;cursor:pointer;}",
    ".cei-note{font-size:11px;opacity:.6;line-height:1.5;}",
].join("\n");

var DEFAULTS = {
    style: "bubble", theme: "paper", width: 720, scale: 2, format: "png",
    showTime: true, showAvatar: true, showName: true, includeMedia: true,
    maxImages: 30, maxPixels: 1200, showWatermark: true,
};

var MAX_DIM = 8192;

export default {
    manifest: {
        id: "chat-export-image",
        name: "聊天记录导出图片",
        apiVersion: 1,
        version: "1.1.0",
        author: "Qoder",
        description: "长按消息进多选后，多选栏直接出图；「+」面板可选全部消息；支持跟随你自己调好的气泡（含九宫格背景）导出长图",
        permissions: ["chat.read", "ui"],
        settings: [
            { key: "style", label: "默认样式", type: "select", default: "bubble", options: [{ value: "bubble", label: "气泡卡片" }, { value: "mine", label: "跟随我的气泡" }, { value: "transcript", label: "文字稿" }] },
            { key: "theme", label: "默认配色", type: "select", default: "paper", options: [{ value: "paper", label: "浅灰纸感" }, { value: "wechat", label: "微信绿" }, { value: "dark", label: "深色" }] },
            { key: "width", label: "图片宽度(px)", type: "number", default: 720, description: "360~1440；手机端 640~760 较合适" },
            { key: "scale", label: "清晰度倍数", type: "number", default: 2, description: "1~3；超出像素上限会自动降倍数并分段" },
            { key: "format", label: "图片格式", type: "select", default: "png", options: [{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }] },
            { key: "showTime", label: "显示时间", type: "boolean", default: true },
            { key: "showAvatar", label: "显示头像", type: "boolean", default: true },
            { key: "showName", label: "显示发送者", type: "boolean", default: true },
            { key: "includeMedia", label: "内嵌图片消息的真实图片", type: "boolean", default: true },
            { key: "maxImages", label: "一次最多内嵌几张图", type: "number", default: 30 },
            { key: "maxPixels", label: "单图像素上限(万像素)", type: "number", default: 1200, description: "WebView/旧机型画布上限低，默认 1200 万" },
            { key: "showWatermark", label: "底部生成说明", type: "boolean", default: true },
        ],
    },

    setup: function (ctx) {
        ctx.ui.injectCSS(CSS);

        var currentSessionId = null;
        var busy = false;
        var singleMsgCache = {};

        function setting(key) {
            var v = ctx.system.settings.get(key);
            return v === undefined || v === null ? DEFAULTS[key] : v;
        }

        function clampNum(v, lo, hi, def) {
            var n = Number(v);
            if (!isFinite(n)) return def;
            return Math.max(lo, Math.min(hi, n));
        }

        function cfgFrom(overrides) {
            var o = overrides || {};
            var pick = function (key) { return o[key] !== undefined ? o[key] : setting(key); };
            return {
                style: o.style || setting("style"),
                theme: o.theme || setting("theme"),
                format: o.format || setting("format"),
                width: clampNum(o.width || setting("width"), 360, 1440, 720),
                scale: clampNum(o.scale || setting("scale"), 1, 3, 2),
                showTime: pick("showTime") !== false,
                showAvatar: pick("showAvatar") !== false,
                showName: pick("showName") !== false,
                includeMedia: pick("includeMedia") !== false,
                maxImages: clampNum(pick("maxImages"), 0, 200, 30),
                maxPixels: clampNum(pick("maxPixels"), 100, 6000, 1200) * 10000,
                showWatermark: pick("showWatermark") !== false,
            };
        }

        // ── 会话与发言人名字 ─────────────────────────────
        function sessionNames(sessionId) {
            var res = { title: "聊天记录", partner: "", isGroup: false, found: false };
            try {
                var s = sessionId ? ctx.data.sessions.get(sessionId) : null;
                if (!s) return res;
                res.found = true;
                res.isGroup = !!s.isGroup;
                if (!s.isGroup) {
                    var contacts = ctx.data.contacts.list() || [];
                    for (var i = 0; i < contacts.length; i++) {
                        if (contacts[i].id === s.contactId) {
                            res.partner = contacts[i].nickname || "";
                            if (!res.partner) {
                                var ch = ctx.data.characters.get(contacts[i].characterId);
                                res.partner = (ch && (ch.name || ch.title)) || "";
                            }
                            break;
                        }
                    }
                }
                res.title = s.title || s.groupName || (res.partner || "聊天记录");
            } catch (e) { ctx.system.log("会话名解析失败", String(e)); }
            return res;
        }

        function senderOf(msg, names) {
            if (isSystemish(msg)) return "";
            var d = msg.mediaData || {};
            if (msg.role === "user") return "我";
            return msg.senderName || d.senderName || names.partner || "TA";
        }

        function sideOf(msg) {
            if (isSystemish(msg)) return "center";
            return msg.role === "user" ? "right" : "left";
        }

        // ── 选择浮层 ────────────────────────────────────
        function openPicker(sessionId) {
            var all = sortMessages(ctx.data.messages.list(sessionId) || []);
            if (!all.length) { ctx.ui.toast("这个会话还没有消息"); return; }
            var names = sessionNames(sessionId);
            var byId = {};
            all.forEach(function (m) { byId[m.id] = m; });

            var selected = {};
            var selCount = 0;
            var filterText = "";
            var filterRole = "all";
            var filtered = all.slice();
            var rowsById = {};

            var apiRef = null;
            ctx.ui.openModal(function (el, api) {
                apiRef = api;
                el.style.cssText = "background:var(--c-card-bg,#fff);color:var(--c-text,#111);border-radius:16px;width:min(560px,100%);max-height:88vh;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28)";

                var root = document.createElement("div");
                root.className = "cei-modal";
                el.appendChild(root);

                var head = document.createElement("div");
                head.className = "cei-head";
                head.appendChild(textDiv("cei-h-title", "选择要导出的消息"));
                head.appendChild(textDiv("cei-h-sub", names.title + " · 本会话共 " + all.length + " 条"));
                root.appendChild(head);

                var tools = document.createElement("div");
                tools.className = "cei-tools";
                var search = document.createElement("input");
                search.className = "cei-search";
                search.type = "search";
                search.placeholder = "搜索内容或名字";
                tools.appendChild(search);
                var chips = {};
                [["all", "全部"], ["user", "我"], ["other", "TA"], ["system", "系统"]].forEach(function (r) {
                    var b = chip(r[1], r[0] === "all", function () {
                        filterRole = r[0];
                        Object.keys(chips).forEach(function (k) { chips[k].setAttribute("data-on", k === filterRole ? "1" : "0"); });
                        recompute();
                    });
                    chips[r[0]] = b;
                    tools.appendChild(b);
                });
                root.appendChild(tools);

                var quick = document.createElement("div");
                quick.className = "cei-quick";
                quick.appendChild(chip("全选当前筛选", false, function () { setMany(filtered, true); }));
                quick.appendChild(chip("反选", false, function () { filtered.forEach(function (m) { toggle(m.id, !selected[m.id]); }); }));
                quick.appendChild(chip("清空", false, function () { Object.keys(selected).forEach(function (id) { toggle(id, false); }); }));
                [20, 50, 100].forEach(function (n) {
                    quick.appendChild(chip("最近" + n + "条", false, function () {
                        setMany(filtered.slice(-n), true);
                        scrollToEnd();
                    }));
                });
                root.appendChild(quick);

                var list = document.createElement("div");
                list.className = "cei-list";
                var sentinel = document.createElement("div");
                list.appendChild(sentinel);
                root.appendChild(list);

                var foot = document.createElement("div");
                foot.className = "cei-foot";
                var count = textDiv("cei-count", "");
                var hint = textDiv("cei-note", "");
                hint.style.flex = "1 1 100%";
                foot.appendChild(count);
                var selStyle = mkSelect([["bubble", "气泡卡片"], ["mine", "跟随我的气泡"], ["transcript", "文字稿"]], setting("style"));
                var selTheme = mkSelect([["paper", "浅灰"], ["wechat", "微信绿"], ["dark", "深色"]], setting("theme"));
                var syncThemeVisible = function () {
                    selTheme.style.display = selStyle.value === "mine" ? "none" : "";
                    if (hint.parentNode) hint.textContent = selStyle.value === "mine"
                        ? "「跟随我的气泡」直接读取屏幕上你调好的气泡（含九宫格背景），配色档位对它无效。"
                        : "";
                };
                selStyle.onchange = syncThemeVisible;
                foot.appendChild(selStyle);
                foot.appendChild(selTheme);
                foot.appendChild(hint);
                syncThemeVisible();
                var go = document.createElement("button");
                go.type = "button";
                go.className = "cei-go";
                go.textContent = "生成图片";
                go.onclick = function () {
                    var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
                    if (!ids.length) { ctx.ui.toast("先勾选至少一条消息"); return; }
                    if (busy) return;
                    go.disabled = true;
                    go.textContent = "生成中…";
                    runExport(ids, { style: selStyle.value, theme: selTheme.value })
                        .then(function () { if (apiRef) apiRef.close(); })
                        .catch(function (e) { ctx.ui.toast("生成失败：" + msgOf(e)); })
                        .then(function () { go.disabled = false; go.textContent = "生成图片"; });
                };
                foot.appendChild(go);
                root.appendChild(foot);

                // 分块增量渲染：几千条消息的会话也能秒开
                var rendered = 0;
                var io = null;
                try {
                    io = new IntersectionObserver(function (entries) {
                        if (entries[0].isIntersecting) renderChunk();
                    }, { root: list, rootMargin: "320px" });
                } catch (e) { io = null; }

                function matches(m) {
                    if (filterRole === "user" && m.role !== "user") return false;
                    if (filterRole === "other" && m.role !== "assistant" && m.role !== "tool") return false;
                    if (filterRole === "system" && !isSystemish(m)) return false;
                    if (!filterText) return true;
                    var q = filterText.toLowerCase();
                    return (previewOf(m) + " " + senderOf(m, names)).toLowerCase().indexOf(q) >= 0;
                }

                function buildRow(m) {
                    var row = document.createElement("label");
                    row.className = "cei-row";
                    row.setAttribute("data-sel", selected[m.id] ? "1" : "0");
                    var cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = !!selected[m.id];
                    cb.onchange = function () { toggle(m.id, cb.checked); };
                    row.appendChild(cb);
                    var main = document.createElement("div");
                    main.className = "cei-row-main";
                    var meta = document.createElement("div");
                    meta.className = "cei-row-meta";
                    meta.appendChild(textDiv("", senderOf(m, names) || "系统"));
                    meta.appendChild(textDiv("", fmtClock(m.createdAt)));
                    main.appendChild(meta);
                    var bodyTxt = previewOf(m);
                    main.appendChild(textDiv("cei-row-text", bodyTxt.length > 180 ? bodyTxt.slice(0, 180) + "…" : bodyTxt));
                    row.appendChild(main);
                    rowsById[m.id] = row;
                    return row;
                }

                function renderChunk() {
                    if (rendered >= filtered.length) return;
                    var frag = document.createDocumentFragment();
                    var stop = Math.min(filtered.length, rendered + 100);
                    for (var i = rendered; i < stop; i++) frag.appendChild(buildRow(filtered[i]));
                    rendered = stop;
                    list.insertBefore(frag, sentinel);
                    if (rendered >= filtered.length) { if (io) io.disconnect(); }
                    else if (io) io.observe(sentinel);
                }

                function recompute() {
                    filtered = all.filter(matches);
                    rowsById = {};
                    rendered = 0;
                    list.replaceChildren(sentinel);
                    if (!filtered.length) {
                        list.appendChild(textDiv("cei-empty", "没有匹配的消息"));
                    } else {
                        renderChunk();
                        scrollToEnd();
                    }
                    updateCount();
                }

                function scrollToEnd() {
                    try { list.scrollTop = list.scrollHeight; } catch (e) { /* ignore */ }
                }

                function toggle(id, on) {
                    if (!id) return;
                    if (on && !selected[id]) { selected[id] = true; selCount++; }
                    else if (!on && selected[id]) { delete selected[id]; selCount--; }
                    var row = rowsById[id];
                    if (row) {
                        row.setAttribute("data-sel", on ? "1" : "0");
                        var box = row.querySelector("input");
                        if (box) box.checked = !!on;
                    }
                    updateCount();
                }

                function setMany(msgs, on) {
                    (msgs || []).forEach(function (m) { if (m && m.id) toggle(m.id, on); });
                }

                function updateCount() {
                    count.textContent = "已选 " + selCount + " 条 · 当前筛选 " + filtered.length + " 条";
                }

                function previewOf(m) { return bodyTextOf(m, false); }

                search.oninput = function () { filterText = String(search.value || "").trim(); recompute(); };

                recompute();

                return function () { if (io) io.disconnect(); };
            });
        }

        function textDiv(cls, txt) {
            var d = document.createElement("div");
            if (cls) d.className = cls;
            d.textContent = txt;
            return d;
        }

        function chip(label, on, fn) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "cei-chip";
            b.textContent = label;
            b.setAttribute("data-on", on ? "1" : "0");
            b.onclick = fn;
            return b;
        }

        function mkSelect(opts, def) {
            var sel = document.createElement("select");
            sel.className = "cei-sel";
            opts.forEach(function (o) {
                var op = document.createElement("option");
                op.value = o[0];
                op.textContent = o[1];
                sel.appendChild(op);
            });
            sel.value = def;
            return sel;
        }

        function msgOf(e) { return e && e.message ? e.message : String(e); }

        // ── 生成 ────────────────────────────────────────
        function loadImage(dataURL) {
            return new Promise(function (resolve) {
                var img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = function () { resolve(null); };
                img.src = dataURL;
            });
        }

        async function runExport(ids, overrides) {
            if (busy) return;
            busy = true;
            var toast = ctx.ui.toast("正在准备…", { durationMs: 0 });
            try {
                var cfg = cfgFrom(overrides);

                // 汇集消息：优先当前会话池，单条长按导出走缓存
                var pool = sortMessages(ctx.data.messages.list(currentSessionId || "") || []);
                var byId = {};
                pool.forEach(function (m) { byId[m.id] = m; });
                var msgs = [];
                var seen = {};
                ids.forEach(function (id) {
                    var m = byId[id] || singleMsgCache[id];
                    if (m && !seen[m.id]) { seen[m.id] = 1; msgs.push(m); }
                });
                if (!msgs.length) { ctx.ui.toast("这些消息已不在当前会话中"); return; }
                msgs.sort(function (a, b) {
                    var oa = typeof a.order === "number" ? a.order : -1;
                    var ob = typeof b.order === "number" ? b.order : -1;
                    if (oa >= 0 && ob >= 0 && oa !== ob) return oa - ob;
                    return (Date.parse(a.createdAt || "") || 0) - (Date.parse(b.createdAt || "") || 0);
                });

                var names = sessionNames(msgs[0].sessionId || currentSessionId);

                // 「跟随我的气泡」：先从真实渲染的气泡采样，再决定布局常量
                var theme = THEMES[cfg.theme] || THEMES.paper;
                var bubbleMetrics = null;
                if (cfg.style === "mine") {
                    toast.close();
                    toast = ctx.ui.toast("读取你的气泡样式…", { durationMs: 0 });
                    var sampled = await sampleMyTheme(cfg.width);
                    if (!sampled) {
                        cfg.style = "bubble";
                        ctx.ui.toast("屏幕上看不到已渲染的气泡，本次改用默认气泡卡片导出");
                    } else {
                        theme = sampled.theme;
                        bubbleMetrics = sampled.metrics;
                    }
                }

                var showNames = cfg.showName && (cfg.style === "transcript" || names.isGroup || msgs.some(function (m) { return !!m.senderName; }));

                // 只有气泡样式会把图片画进气泡；文字稿样式保留 [图片] 标记即可，省掉解析开销
                var embedImages = cfg.includeMedia && cfg.style !== "transcript";
                var imgBudget = embedImages ? cfg.maxImages : 0;
                var imgUsed = 0;
                var items = [];
                for (var i = 0; i < msgs.length; i++) {
                    var m = msgs[i];
                    var d = m.mediaData || {};
                    var wantImage = m.mediaType === "image"
                        || (m.mediaType === "media_file" && d.fileType === "image")
                        || m.mediaType === "sticker";
                    var img = null;
                    if (wantImage && imgUsed < imgBudget) {
                        imgUsed++;
                        toast.close();
                        toast = ctx.ui.toast("读取图片 " + imgUsed + "…", { durationMs: 0 });
                        var r = null;
                        try { r = await ctx.data.messages.resolveMedia(m); } catch (e) { r = null; }
                        if (r && r.dataURL) {
                            var el = await loadImage(r.dataURL);
                            if (el && el.naturalWidth > 0) {
                                var maxW = Math.min(Math.max(300, cfg.width * 0.42), cfg.width * 0.62);
                                var maxH = Math.round(maxW * 1.2);
                                var k = Math.min(maxW / el.naturalWidth, maxH / el.naturalHeight, 1);
                                img = { el: el, w: Math.round(el.naturalWidth * k), h: Math.round(el.naturalHeight * k) };
                            }
                        }
                    }
                    items.push({
                        msg: m,
                        name: showNames ? senderOf(m, names) : "",
                        avatarName: senderOf(m, names) || (m.role === "user" ? "我" : (names.partner || "TA")),
                        time: cfg.showTime ? fmtClock(m.createdAt) : "",
                        text: bodyTextOf(m, !!img),
                        side: sideOf(m),
                        img: img,
                    });
                }

                var now = new Date();
                var stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + "-" + pad2(now.getHours()) + pad2(now.getMinutes());
                var layoutCfg = {
                    width: cfg.width,
                    style: cfg.style,
                    showTime: cfg.showTime,
                    showAvatar: cfg.showAvatar && cfg.style !== "transcript",
                    showName: showNames,
                    bubbleMetrics: bubbleMetrics,
                    title: names.title,
                    subtitle: items.length + " 条记录 · " + fmtDay(now.toISOString()) ,
                    watermark: cfg.showWatermark ? "由「聊天记录导出图片」插件生成 · " + stamp : " ",
                };

                var measCv = document.createElement("canvas");
                var meas = measCv.getContext("2d");
                var measPx = G.fontPx;
                meas.font = fontStr(measPx, "400");
                var measure = function (s, px) {
                    var p = px || G.fontPx;
                    if (p !== measPx) { measPx = p; meas.font = fontStr(p, "400"); }
                    return meas.measureText(String(s)).width;
                };
                var blocks = buildBlocks(measure, items, layoutCfg);

                var scale = cfg.scale;
                var maxPageH = 0;
                for (var guard = 0; guard < 8; guard++) {
                    maxPageH = Math.floor(Math.min(MAX_DIM / scale, cfg.maxPixels / (layoutCfg.width * scale * scale)));
                    if (maxPageH >= 520 || scale <= 1) break;
                    scale = Math.max(1, scale - 0.5);
                }
                // 预留上下内边距与"接下段"提示的高度，保证每页实际高度都不超上限，
                // 从而各段用同一个清晰度倍数（否则多段图宽度会不一致）
                var pageLimit = Math.max(200, maxPageH - (G.padTop + G.padBottom) - G.moreH);
                var pages = paginate(blocks, pageLimit);
                if (pages.length > 1) ctx.system.log("内容超出单张上限，已分为 " + pages.length + " 段");

                var canvases = [];
                for (var pg = 0; pg < pages.length; pg++) {
                    var ph = G.padTop + G.padBottom + sumH(pages[pg]);
                    var pscale = Math.max(1, Math.min(scale, Math.floor((MAX_DIM / ph) * 100) / 100));
                    canvases.push(renderPage(pages[pg], layoutCfg, theme, pscale));
                }

                showResult(canvases, sanitizeFileBase(names.title) + "_" + stamp, cfg, function (newStyle) {
                    return runExport(ids.slice(), { style: newStyle });
                });
            } finally {
                toast.close();
                busy = false;
            }
        }

        // ── 结果浮层：预览 + 下载 + 复制 +（不重选消息）换样式重画 ─────
        function showResult(canvases, fileBase, cfg, restyle) {
            var urls = [];
            var blobs = new Array(canvases.length);
            var ext = cfg.format === "jpeg" ? ".jpg" : ".png";

            ctx.ui.openModal(function (el, api) {
                el.style.cssText = "background:var(--c-card-bg,#fff);color:var(--c-text,#111);border-radius:16px;width:min(560px,100%);max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.28)";
                var root = document.createElement("div");
                root.className = "cei-res";
                el.appendChild(root);

                root.appendChild(textDiv("cei-res-title",
                    canvases.length > 1 ? "已生成 " + canvases.length + " 段长图" : "已生成图片"));
                root.appendChild(textDiv("cei-note",
                    "下载走浏览器/WebView 的下载通道。若「下载」没反应：用「复制」到别处粘贴，或「新窗口打开」后长按图片保存。"));

                if (typeof restyle === "function") {
                    var row = document.createElement("div");
                    row.className = "cei-tools";
                    row.style.paddingLeft = "0";
                    row.style.paddingRight = "0";
                    row.appendChild(textDiv("cei-note", "换样式重画（还是刚才那些消息）："));
                    [["bubble", "气泡卡片"], ["mine", "跟随我的气泡"], ["transcript", "文字稿"]].forEach(function (r) {
                        row.appendChild(chip(r[1], cfg.style === r[0], function () {
                            if (cfg.style === r[0] || busy) return;
                            // 顺手记成默认值：下次从多选栏直接导出就沿用这个样式
                            try { ctx.system.settings.set("style", r[0]); } catch (e) { /* ignore */ }
                            api.close();
                            Promise.resolve(restyle(r[0])).catch(function (e) { ctx.ui.toast("生成失败：" + msgOf(e)); });
                        }));
                    });
                    root.appendChild(row);
                }

                var done = 0;
                canvases.forEach(function (cv, idx) {
                    var card = document.createElement("div");
                    card.className = "cei-card";
                    var img = document.createElement("img");
                    img.alt = "第" + (idx + 1) + "张";
                    card.appendChild(img);

                    var ops = document.createElement("div");
                    ops.className = "cei-card-ops";
                    ops.appendChild(textDiv("cei-note", (canvases.length > 1 ? "第 " + (idx + 1) + "/" + canvases.length + " 段 · " : "") + cv.width + "×" + cv.height + "px"));
                    var spacer = document.createElement("span");
                    spacer.style.flex = "1";
                    ops.appendChild(spacer);
                    ops.appendChild(miniBtn("下载", function () { withBlob(idx, function (b) { downloadBlob(b, fileBase + (canvases.length > 1 ? "_" + (idx + 1) : "") + ext); }); }));
                    ops.appendChild(miniBtn("复制", function () {
                        copyImage(cv).then(function () { ctx.ui.toast("已复制到剪贴板"); }, function (e) { ctx.ui.toast("复制失败：" + msgOf(e)); });
                    }));
                    ops.appendChild(miniBtn("新窗口打开", function () {
                        withBlob(idx, function (b) {
                            var u = URL.createObjectURL(b);
                            urls.push(u);
                            var w = window.open(u, "_blank");
                            if (!w) ctx.ui.toast("被拦截了，改用「下载」");
                        });
                    }));
                    card.appendChild(ops);
                    root.appendChild(card);

                    toBlob(cv, cfg.format).then(function (b) {
                        blobs[idx] = b;
                        if (b) {
                            var u = URL.createObjectURL(b);
                            urls.push(u);
                            img.src = u;
                        } else {
                            img.alt = "生成失败";
                        }
                        done++;
                        if (done === canvases.length) finish();
                    });
                });

                function finish() {
                    if (canvases.length > 1) {
                        var all = miniBtn("全部下载", function () {
                            blobs.forEach(function (b, j) {
                                if (b) setTimeout(function () { downloadBlob(b, fileBase + "_" + (j + 1) + ext); }, j * 400);
                            });
                        });
                        root.appendChild(all);
                    }
                    var close = miniBtn("关闭", function () { api.close(); });
                    close.style.alignSelf = "flex-start";
                    root.appendChild(close);
                }

                function withBlob(idx, fn) {
                    var b = blobs[idx];
                    if (!b) { ctx.ui.toast("这张还在编码，稍等再点"); return; }
                    fn(b);
                }

                return function () {
                    urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
                };
            });
        }

        function miniBtn(text, fn) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "cei-mini";
            b.textContent = text;
            b.onclick = fn;
            return b;
        }

        function toBlob(cv, format) {
            return new Promise(function (resolve) {
                try {
                    cv.toBlob(function (b) { resolve(b); }, format === "jpeg" ? "image/jpeg" : "image/png", 0.92);
                } catch (e) { resolve(null); }
            });
        }

        function downloadBlob(blob, name) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.rel = "noopener";
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
            setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 90000);
        }

        function copyImage(cv) {
            return toBlob(cv, "png").then(function (b) {
                if (!b) throw new Error("无法编码 PNG");
                if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === "undefined") {
                    throw new Error("当前环境不支持写入剪贴板图片");
                }
                return navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
            });
        }

        // ── 入口一：输入栏「+」面板（与图片墙/文字图片/系统指令等同级） ──
        var PLUS_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" '
            + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M7 14l3-3 2.5 2.5L16 10l4 4"/>'
            + '<circle cx="8.5" cy="8.5" r="1.3"/><path d="M12 18v4M9.5 19.5L12 22l2.5-2.5"/></svg>';

        function domMessageIds() {
            var nodes = document.querySelectorAll('.chat-msg-wrapper[id^="message-"]');
            var ids = [];
            for (var i = Math.max(0, nodes.length - 12); i < nodes.length; i++) {
                ids.push(String(nodes[i].id).slice("message-".length).replace(/__display_(meta|\d+)$/, ""));
            }
            return ids;
        }

        async function openEntry() {
            if (busy) { ctx.ui.toast("上一张还在生成，稍等一下"); return; }
            var sid = currentSessionId || await ensureSessionId(domMessageIds());
            if (!sid) { ctx.ui.toast("没拿到当前会话 id，请重进聊天室"); return; }
            currentSessionId = sid;
            openPicker(sid);
        }

        var offPlus = ctx.ui.slot("chat.inputToolbar", function (el) {
            var grid = document.createElement("div");
            grid.className = "cei-plus-grid";
            var item = document.createElement("div");
            item.className = "cei-plus-item";
            item.setAttribute("role", "button");
            item.setAttribute("tabindex", "0");
            var box = document.createElement("div");
            box.className = "cei-plus-box";
            box.innerHTML = PLUS_SVG;
            var label = document.createElement("span");
            label.className = "cei-plus-label";
            label.textContent = "导出图片";
            item.appendChild(box);
            item.appendChild(label);
            item.onclick = function () { openEntry().catch(function (e) { ctx.ui.toast("打不开选择面板：" + msgOf(e)); }); };
            item.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEntry(); } };
            grid.appendChild(item);
            el.appendChild(grid);
            return function () { el.replaceChildren(); };
        });

        // ── 入口二：宿主多选栏里的「导出图片」，导出即所选、不再二次选择 ──
        // 多选栏没有插件坑位，只能往 [data-ui="multi-select"] 里注入；
        // 注入的元素不能带 data-ui，否则底部预留高度(use-chat-bottom-reserve)会认错栏。
        var msBtnLabelCache = "";
        var msDisabledCache = null;

        function selectionSnapshot() {
            var nodes = document.querySelectorAll('[data-multi-select][data-selected]');
            var ids = [];
            for (var i = 0; i < nodes.length; i++) {
                var raw = "";
                var n = nodes[i];
                if (typeof n.id === "string" && n.id.indexOf("message-") === 0) raw = n.id.slice("message-".length);
                if (!raw) {
                    var b = n.querySelector("[data-msg-id]");
                    if (b) raw = b.getAttribute("data-msg-id") || "";
                }
                if (raw) ids.push(raw);
            }
            return ids;
        }

        /** 显示层 id → 存储层 id 见顶层 resolveDisplayIds */
        async function ensureSessionId(ids) {
            if (currentSessionId && ctx.data.messages.list(currentSessionId || "").length) return currentSessionId;
            try {
                var sessions = ctx.data.sessions.list() || [];
                for (var i = 0; i < sessions.length; i++) {
                    var list = ctx.data.messages.list(sessions[i].id) || [];
                    var hit = list.some(function (m) { return ids.indexOf(m.id) >= 0; });
                    if (hit) { currentSessionId = sessions[i].id; return currentSessionId; }
                }
            } catch (e) { ctx.system.log("会话兜底查找失败", String(e)); }
            return currentSessionId;
        }

        async function exportFromMultiSelect() {
            if (busy) { ctx.ui.toast("上一张还在生成，稍等一下"); return; }
            var rawIds = selectionSnapshot();
            if (!rawIds.length) { ctx.ui.toast("先勾选要导出的消息"); return; }
            var sid = await ensureSessionId(rawIds);
            var pool = sortMessages(ctx.data.messages.list(sid || "") || []);
            var ids = resolveDisplayIds(rawIds, pool);
            if (!ids.length) { ctx.ui.toast("这些消息不在当前会话里，请重进聊天室后再导出"); return; }
            await runExport(ids, {});
        }

        function syncMultiSelectBar() {
            var bar = document.querySelector('[data-ui="multi-select"]');
            if (!bar) return;
            var btn = bar.querySelector(".cei-ms-btn");
            if (!btn) {
                btn = document.createElement("button");
                btn.type = "button";
                btn.className = "cei-ms-btn";
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
                    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                    + '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M7 14l3-3 2.5 2.5L16 10l4 4"/></svg>';
                var sp = document.createElement("span");
                sp.textContent = "导出图片";
                btn.appendChild(sp);
                btn.onclick = function () { exportFromMultiSelect().catch(function (e) { ctx.ui.toast("生成失败：" + msgOf(e)); }); };
                var del = bar.querySelector(".chat-multi-select-delete-btn");
                if (del && del.parentNode === bar) bar.insertBefore(btn, del);
                else bar.appendChild(btn);
                msBtnLabelCache = "";
                msDisabledCache = null;
            }
            var count = selectionSnapshot().length;
            var label = count ? "导出图片（" + count + "）" : "导出图片";
            if (label !== msBtnLabelCache) {
                var span = btn.querySelector("span");
                if (span) span.textContent = label;
                msBtnLabelCache = label;
            }
            var disabled = count === 0;
            if (disabled !== msDisabledCache) { btn.disabled = disabled; msDisabledCache = disabled; }
        }

        var msScheduled = false;
        var msObserver = null;
        function scheduleSync() {
            if (msScheduled) return;
            msScheduled = true;
            var run = function () { msScheduled = false; try { syncMultiSelectBar(); } catch (e) { /* ignore */ } };
            // 不用 requestAnimationFrame 单独驱动：页面不可见时 rAF 不回调，注入会一直不发生
            setTimeout(run, 80);
        }
        try {
            msObserver = new MutationObserver(scheduleSync);
            msObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-selected", "data-multi-select", "class"] });
        } catch (e) {
            msObserver = null;
            ctx.system.log("多选栏注入监听不可用，导出入口仅保留在「+」面板");
        }
        scheduleSync();

        var offAction = ctx.ui.messageAction({
            id: "export-this-one",
            label: "导出这条为图片",
            onSelect: function (msg, helpers) {
                if (!msg || !msg.id) return;
                if (msg.sessionId) currentSessionId = msg.sessionId;
                singleMsgCache[msg.id] = msg;
                runExport([msg.id], {}).catch(function (e) { helpers.toast("生成失败：" + msgOf(e)); });
            },
        });

        var offOpened = ctx.hooks.on("session.opened", function (p) {
            if (p && p.sessionId) currentSessionId = p.sessionId;
            msBtnLabelCache = "";
            msDisabledCache = null;
            scheduleSync();
        });

        return function () {
            offPlus();
            offAction();
            offOpened();
            if (msObserver) msObserver.disconnect();
            var bar = document.querySelector('[data-ui="multi-select"] .cei-ms-btn');
            if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        };
    },
};

// 供 Node 侧验证纯函数；宿主只读 default 导出，具名导出不影响运行
export const __internals = {
    isWideChar: isWideChar,
    tokenize: tokenize,
    wrapText: wrapText,
    plainText: plainText,
    mediaLabel: mediaLabel,
    bodyTextOf: bodyTextOf,
    isSystemish: isSystemish,
    sortMessages: sortMessages,
    resolveDisplayIds: resolveDisplayIds,
    parseNineSlice: parseNineSlice,
    parseShadow: parseShadow,
    cssUrlValue: cssUrlValue,
    transparentish: transparentish,
    splitTopLevelCommas: splitTopLevelCommas,
    numPx: numPx,
    minRadius: minRadius,
    DEFAULT_METRICS: DEFAULT_METRICS,
    buildBlocks: buildBlocks,
    paginate: paginate,
    sumH: sumH,
    fmtDay: fmtDay,
    fmtClock: fmtClock,
    sanitizeFileBase: sanitizeFileBase,
    THEMES: THEMES,
    G: G,
};
