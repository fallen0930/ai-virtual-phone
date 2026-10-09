import type { BlackMarketRenderRule, BlackMarketTheaterTemplate } from "./black-market-types";

const BUILTIN_AUTHOR_ID = "black_market_operator";
const BUILTIN_AUTHOR_NAME = "OPERATOR_03";
const BUILTIN_CREATED_AT = "2026-05-15T00:00:00.000Z";

// Each theater has its OWN per-turn "form": a distinct set of render rules +
// CSS skin + output contract, so they don't feel like recolors of one template.
// Across every theater the convention is: inline rules first, then single-line
// (delimiter-closed) blocks, then the greedy prose-style block last, and the
// contract pins a fixed output order so greedy blocks never swallow each other.

const RULE_ACT: BlackMarketRenderRule = {
  id: "act", name: "动作", pattern: "\\*([^*\\n]+)\\*", flags: "g",
  className: "bm-act", template: "<span class=\"bm-act\">$1</span>",
};
const RULE_LINE: BlackMarketRenderRule = {
  id: "line", name: "台词", pattern: "「([^」\\n]+)」", flags: "g",
  className: "bm-line", template: "<span class=\"bm-line\">「$1」</span>",
};

/** Optional full-canvas guidance. Kept free-form per theater so the AI improvises
 *  a different canvas each time instead of cloning one skeleton. */
function optionalCanvasNote(idea: string): string {
  return [
    "",
    "【可选 · 整屏画布】仅当 {{char}} 出现强烈情绪 / 失控边缘 / 明显口是心非时，才在所有文本块之后追加一个 ```html 代码块``` 作为整屏画布；普通推进不要输出，也别输出空代码块。",
    "画布是独立 iframe，可自带 <style>/<script>，高度控制在 320px 内，不依赖外部资源；要让玩家做选择就给元素加 data-action=\"一句玩家行动\"（点击即作为玩家行动回填）。代码里别用英文双引号和反斜杠。",
    "适合这一档案的画布方向（自由发挥、每次可不同，别照搬模板）：" + idea,
  ].join("\n");
}

// ── 吐真剂：测谎仪读数 + 脱口而出的真话 ──
const RULES_VERITAS: BlackMarketRenderRule[] = [
  RULE_ACT,
  RULE_LINE,
  {
    id: "blurt-inline", name: "没藏住", pattern: "〔([^〕]+)〕", flags: "g",
    className: "bm-blurt", template: "<span class=\"bm-blurt\">$1</span>",
  },
  {
    id: "poly", name: "测谎读数", pattern: "【测谎\\|([^|【】]*)\\|([^|【】]*)】", flags: "g",
    className: "bm-poly",
    template: "<div class=\"bm-poly\"><div class=\"bm-poly-top\"><span class=\"bm-poly-q\">$1</span><span class=\"bm-poly-v\">$2</span></div><div class=\"bm-poly-wave\"><i></i></div></div>",
  },
  {
    id: "prose", name: "正文", pattern: "【正文】\\s*([\\s\\S]*?)(?=\\n【|$)", flags: "g",
    className: "bm-prose", template: "<div class=\"bm-prose\">$1</div>",
  },
  {
    id: "blurt-box", name: "真话", pattern: "【真话】\\s*([\\s\\S]*?)(?=\\n【|$)", flags: "g",
    className: "bm-blurt-box",
    template: "<div class=\"bm-blurt-box\"><span class=\"bm-blurt-tag\">脱口而出</span>$1</div>",
  },
];
const CSS_VERITAS = [
  ".bm-prose{margin:10px 0;padding:4px 2px 4px 14px;border-left:2px solid rgba(101,240,164,.22);color:#d7e4df;font-size:calc(14px*var(--app-text-scale,1));line-height:1.95;white-space:pre-line;}",
  ".bm-act{color:#7e9a8c;font-style:italic;}",
  ".bm-line{color:#9ef0c4;font-weight:600;}",
  ".bm-blurt{color:#eafff3;font-weight:700;background:rgba(101,240,164,.16);padding:0 4px;border-radius:3px;}",
  ".bm-poly{margin:12px 0;padding:12px 14px;border:1px solid rgba(101,240,164,.2);border-radius:12px;background:linear-gradient(180deg,#0c1714,#08110d);}",
  ".bm-poly-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}",
  ".bm-poly-q{font-size:calc(12.5px*var(--app-text-scale,1));color:#cfe0d6;}",
  ".bm-poly-v{flex:0 0 auto;font-size:calc(12px*var(--app-text-scale,1));font-weight:700;color:#65f0a4;white-space:nowrap;}",
  ".bm-poly-wave{position:relative;height:26px;border-radius:6px;overflow:hidden;background:repeating-linear-gradient(90deg,rgba(101,240,164,.08) 0 1px,transparent 1px 14px),#06100c;}",
  ".bm-poly-wave i{position:absolute;top:50%;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#65f0a4,transparent);box-shadow:0 0 10px #65f0a4;animation:bm-poly-scan 2.4s linear infinite;}",
  "@keyframes bm-poly-scan{0%{transform:translateY(-7px) scaleY(1)}25%{transform:translateY(6px) scaleY(2.6)}50%{transform:translateY(-5px) scaleY(1.4)}75%{transform:translateY(8px) scaleY(3)}100%{transform:translateY(-7px) scaleY(1)}}",
  ".bm-blurt-box{position:relative;margin:12px 0;padding:14px;border:1px solid rgba(101,240,164,.32);border-radius:12px;background:rgba(101,240,164,.07);color:#eafff3;font-size:calc(13.5px*var(--app-text-scale,1));line-height:1.8;font-weight:600;box-shadow:inset 0 0 24px rgba(101,240,164,.12);}",
  ".bm-blurt-tag{display:inline-block;margin-right:8px;padding:1px 8px;border-radius:999px;background:#65f0a4;color:#06100c;font-size:calc(10px*var(--app-text-scale,1));font-weight:800;letter-spacing:.05em;vertical-align:middle;}",
].join("\n");
const CONTRACT_VERITAS = [
  "每轮严格按【固定顺序】输出，前面是纯文本（正则+CSS 渲染），最后一块可选：",
  "",
  "① 测谎读数（必出，一行）：【测谎|本轮被逼问或触发的核心问题|读数】",
  "  · 读数 = 真实度百分比 + 一个体征词，例：94% · 喉咙打结。会渲染成一台抖动的测谎仪。",
  "  · 示例：【测谎|你今晚到底要去见谁|94% · 喉咙打结】",
  "",
  "② 正文（必出）：【正文】 另起，承接玩家上一句，把「药效逼供」往前推一步。",
  "  · 第二人称「你」，不少于 600 字，2-4 段。动作用 *星号*、台词用「直角引号」。",
  "  · ta 最想藏却没藏住的半句用 〔尖括号〕标住（会高亮）。反应解读留白，别替 ta 定性。",
  "",
  "③ 真话（必出）：【真话】 另起，写 ta 这一轮不受控、脱口而出的一句完整真心话（会渲染成醒目卡片）。是真心，不是敷衍。",
  optionalCanvasNote("一台测谎仪——抖动的波形线配真实度读数，强节点时波形剧烈跳动甚至爆表。"),
].join("\n");

// ── 梦境录像带：电影胶片帧 + 梦境象征 + 宽银幕旁白 ──
const RULES_OPHIRA: BlackMarketRenderRule[] = [
  RULE_ACT,
  RULE_LINE,
  {
    id: "film", name: "胶片帧", pattern: "【胶片\\|([^|【】]*)\\|([^|【】]*)\\|([^|【】]*)】", flags: "g",
    className: "bm-film",
    template: "<div class=\"bm-film\"><div class=\"bm-film-cell\">$1</div><div class=\"bm-film-cell\">$2</div><div class=\"bm-film-cell\">$3</div></div>",
  },
  {
    id: "sym", name: "梦境象征", pattern: "【象征\\|([^|【】]*)\\|([^|【】]*)】", flags: "g",
    className: "bm-sym",
    template: "<span class=\"bm-sym\"><span class=\"bm-sym-i\">$1</span><span class=\"bm-sym-arrow\">→</span><span class=\"bm-sym-m\">$2</span></span>",
  },
  {
    id: "prose", name: "梦境旁白", pattern: "【正文】\\s*([\\s\\S]*?)(?=\\n【|$)", flags: "g",
    className: "bm-dream-prose", template: "<div class=\"bm-dream-prose\">$1</div>",
  },
];
const CSS_OPHIRA = [
  ".bm-dream-prose{margin:10px 0;padding:10px 14px;border-left:2px solid rgba(244,168,212,.22);color:#ece4f2;font-size:calc(14px*var(--app-text-scale,1));line-height:1.95;white-space:pre-line;font-style:italic;}",
  ".bm-act{color:#b48ac4;font-style:normal;}",
  ".bm-line{color:#f0a8d4;font-weight:600;font-style:normal;}",
  ".bm-film{display:flex;gap:6px;margin:12px 0;padding:8px 6px;border-radius:8px;background:#0a0710;border-top:3px dotted rgba(244,168,212,.4);border-bottom:3px dotted rgba(244,168,212,.4);}",
  ".bm-film-cell{flex:1;min-width:0;padding:16px 8px;border-radius:4px;background:radial-gradient(ellipse at 50% 30%,rgba(244,168,212,.14),transparent 70%),#14101c;border:1px solid rgba(244,168,212,.16);text-align:center;font-size:calc(11.5px*var(--app-text-scale,1));color:#e4d8ec;line-height:1.45;}",
  ".bm-sym{display:inline-flex;align-items:center;gap:6px;margin:6px 6px 2px 0;padding:5px 11px;border-radius:999px;background:rgba(240,168,212,.1);border:1px solid rgba(240,168,212,.24);font-size:calc(11.5px*var(--app-text-scale,1));}",
  ".bm-sym-i{color:#f0a8d4;font-weight:700;}",
  ".bm-sym-arrow{color:#8a5f92;}",
  ".bm-sym-m{color:#c8a8d4;}",
].join("\n");
const CONTRACT_OPHIRA = [
  "每轮严格按【固定顺序】输出：",
  "",
  "① 胶片帧（必出，一行）：【胶片|帧一|帧二|帧三】 三个梦境关键画面，各 4-10 字，会渲染成一条电影胶片。",
  "  · 示例：【胶片|空荡的走廊|没接的电话|背对你的人】",
  "",
  "② 象征（必出，1-2 个，各一行）：【象征|梦里的意象|它在暗示什么】 点出本轮梦的象征，但别替 {{char}} 把话挑明承认。",
  "  · 示例：【象征|那扇关不上的门|ta 怕你随时会走】",
  "",
  "③ 正文（必出）：【正文】 另起，一半是梦境旁白（朦胧、象征、宽银幕感），一半是 {{char}} 看着投影时的现实反应。",
  "  · 第二人称「你」，不少于 600 字，2-4 段。动作用 *星号*、台词用「直角引号」。梦不必合逻辑，但要有画面。",
  optionalCanvasNote("一卷正在放映的梦境胶片 / 流动的投影光斑——可点击某一帧把它「看清」。"),
].join("\n");

// ── 读心术：信号条 + 表层台词 + 故障噪点的未出口念头 ──
const RULES_NEURO: BlackMarketRenderRule[] = [
  RULE_ACT,
  RULE_LINE,
  {
    id: "signal", name: "信号", pattern: "【信号\\|([^|【】]*)\\|([^|【】]*)】", flags: "g",
    className: "bm-signal",
    template: "<div class=\"bm-signal\"><span class=\"bm-signal-k\">$1</span><span class=\"bm-signal-bars\"><i></i><i></i><i></i><i></i><i></i></span><span class=\"bm-signal-v\">$2</span></div>",
  },
  {
    id: "prose", name: "正文", pattern: "【正文】\\s*([\\s\\S]*?)(?=\\n【|$)", flags: "g",
    className: "bm-prose", template: "<div class=\"bm-prose\">$1</div>",
  },
  {
    id: "inner", name: "未出口", pattern: "【内层】\\s*([\\s\\S]*?)(?=\\n【|$)", flags: "g",
    className: "bm-inner", template: "<div class=\"bm-inner\">$1</div>",
  },
];
const CSS_NEURO = [
  ".bm-prose{margin:10px 0;padding:4px 2px 4px 14px;border-left:2px solid rgba(110,231,249,.22);color:#dbe7ef;font-size:calc(14px*var(--app-text-scale,1));line-height:1.95;white-space:pre-line;}",
  ".bm-act{color:#7a9aa8;font-style:italic;}",
  ".bm-line{color:#a8d8ff;font-weight:600;}",
  ".bm-signal{display:flex;align-items:center;gap:10px;margin:12px 0;padding:9px 13px;border:1px solid rgba(110,231,249,.2);border-radius:12px;background:#0a141a;}",
  ".bm-signal-k{font-size:calc(10px*var(--app-text-scale,1));letter-spacing:.12em;text-transform:uppercase;color:#8aa0b0;}",
  ".bm-signal-bars{display:inline-flex;align-items:flex-end;gap:3px;height:16px;}",
  ".bm-signal-bars i{width:4px;background:#6ee7f9;border-radius:1px;box-shadow:0 0 8px rgba(110,231,249,.5);animation:bm-eq 1.1s ease-in-out infinite;}",
  ".bm-signal-bars i:nth-child(1){height:40%;animation-delay:0s}",
  ".bm-signal-bars i:nth-child(2){height:70%;animation-delay:.15s}",
  ".bm-signal-bars i:nth-child(3){height:100%;animation-delay:.3s}",
  ".bm-signal-bars i:nth-child(4){height:60%;animation-delay:.45s}",
  ".bm-signal-bars i:nth-child(5){height:85%;animation-delay:.6s}",
  "@keyframes bm-eq{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1)}}",
  ".bm-signal-v{margin-left:auto;font-size:calc(12px*var(--app-text-scale,1));font-weight:700;color:#6ee7f9;}",
  ".bm-inner{position:relative;margin:14px 0 12px;padding:13px 14px;border:1px dashed rgba(110,231,249,.34);border-radius:12px;background:#06101a;color:#cdebf5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:calc(12.5px*var(--app-text-scale,1));line-height:1.85;white-space:pre-line;text-shadow:1.2px 0 rgba(255,0,80,.45),-1.2px 0 rgba(0,200,255,.45);}",
  ".bm-inner::before{content:\"未出口\";position:absolute;top:-9px;left:12px;padding:1px 8px;background:#06101a;color:#6ee7f9;font-size:calc(9px*var(--app-text-scale,1));letter-spacing:.18em;}",
  ".bm-inner::after{content:\"\";position:absolute;inset:0;pointer-events:none;border-radius:12px;background:repeating-linear-gradient(0deg,rgba(110,231,249,.05) 0 1px,transparent 1px 3px);}",
].join("\n");
const CONTRACT_NEURO = [
  "每轮严格按【固定顺序】输出：",
  "",
  "① 信号（必出，一行）：【信号|读心信号强度词|{{char}}的屏蔽状态】 会渲染成信号条。",
  "  · 示例：【信号|清晰|屏蔽失效】 或 【信号|时断时续|开始设防】",
  "",
  "② 正文（必出）：【正文】 另起，写 {{char}} 说出口的话与外在反应，把「读心 vs 设防」推进一步。",
  "  · 第二人称「你」，不少于 600 字，2-4 段。台词用「直角引号」、动作用 *星号*。",
  "",
  "③ 未出口（必出）：【内层】 另起，写 {{char}} 这一轮在心里真正闪过、绝不会说出口的 2-4 句（会渲染成故障噪点块）。必须是新的潜台词/顾虑/欲望，不能照抄台词。",
  optionalCanvasNote("视野边缘的念头噪点墙——错位的红蓝重影、扫描线，强节点时噪点暴涨刷屏。"),
].join("\n");

function makeTemplate(input: Omit<BlackMarketTheaterTemplate, "authorId" | "authorName" | "source" | "version" | "allowExternalControl" | "purchaseCount" | "rating" | "createdAt" | "updatedAt">): BlackMarketTheaterTemplate {
  return {
    ...input,
    authorId: BUILTIN_AUTHOR_ID,
    authorName: BUILTIN_AUTHOR_NAME,
    source: "builtin",
    version: 2,
    allowExternalControl: false,
    purchaseCount: 0,
    rating: 4.9,
    createdAt: BUILTIN_CREATED_AT,
    updatedAt: BUILTIN_CREATED_AT,
  };
}

// ───────────────────────── Opening canvases ─────────────────────────
// Each is a self-contained HTML doc. The app injects the Theater bridge and a
// resize observer before </body>, so we only call Theater.* and rely on it.

const OPENING_VERITAS = String.raw`<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600&family=Cinzel:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#050807;color:#d7e4df;font-family:"Noto Serif SC",serif;min-height:100vh;overflow-x:hidden;background-image:radial-gradient(ellipse at 50% 0%,#0c1a12 0%,transparent 55%),radial-gradient(ellipse at 80% 100%,#0a140e 0%,transparent 55%);padding-bottom:26px}
.wrap{max-width:600px;margin:0 auto;position:relative}
.scan{position:absolute;inset:0;pointer-events:none;z-index:1;background:repeating-linear-gradient(180deg,rgba(101,240,164,.05),rgba(101,240,164,.05) 1px,transparent 1px,transparent 4px);opacity:.5}
.head{text-align:center;padding:40px 22px 14px;position:relative;z-index:3}
.kick{font-family:"Cinzel",serif;font-size:.6rem;letter-spacing:.46em;color:#3f6b51;text-transform:uppercase;opacity:0;animation:rise 1s .2s both}
.name{font-weight:300;font-size:2.4rem;letter-spacing:.2em;color:#65f0a4;text-indent:.2em;text-shadow:0 0 30px rgba(101,240,164,.45);margin-top:12px;opacity:0;animation:rise 1.1s .45s both,flick 7s 2s infinite}
.latin{font-size:.82rem;font-style:italic;letter-spacing:.05em;color:#7a9a8a;margin-top:9px;opacity:0;animation:rise 1s .8s both}
.rule{width:0;height:1px;margin:18px auto 0;background:linear-gradient(90deg,transparent,#3f9a6a,transparent);animation:wide 1.3s 1s both}
@keyframes rise{from{opacity:0;transform:translateY(16px);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}
@keyframes wide{to{width:210px}}
@keyframes flick{0%,96%,100%{opacity:1}97%{opacity:.5}98%{opacity:.9}}
.tray{display:flex;justify-content:center;padding:14px 0 26px;position:relative;z-index:3}
.vial{width:120px;height:300px;border-radius:18px;background:linear-gradient(150deg,#0e1714,#070b09);border:1px solid #1d3328;padding:14px;position:relative;cursor:pointer;box-shadow:0 28px 56px -22px rgba(0,0,0,.9),inset 0 0 30px rgba(101,240,164,.05);transition:transform .4s}
.vial:active{transform:scale(.99)}
.tube{width:46px;height:100%;margin:0 auto;border-radius:24px;border:1px solid #214d38;position:relative;overflow:hidden;background:rgba(0,0,0,.4)}
.liq{position:absolute;left:0;right:0;bottom:0;height:62%;background:linear-gradient(180deg,rgba(101,240,164,.55),rgba(38,160,104,.85));box-shadow:0 0 24px rgba(101,240,164,.5);animation:slosh 4s ease-in-out infinite}
@keyframes slosh{0%,100%{height:60%}50%{height:66%}}
.gas{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.gas i{position:absolute;bottom:60%;width:10px;height:10px;border-radius:50%;background:radial-gradient(circle,rgba(101,240,164,.5),transparent 70%);animation:up linear infinite}
@keyframes up{to{transform:translateY(-220px) scale(2.4);opacity:0}}
.read{position:absolute;top:14px;right:-4px;transform:translateX(100%);width:118px;text-align:left;font-family:"Cinzel",serif}
.read div{font-size:.52rem;letter-spacing:.1em;color:#5a8a70;margin-bottom:8px;opacity:0;animation:rise .7s both}
.read div:nth-child(1){animation-delay:1.4s}.read div:nth-child(2){animation-delay:1.7s}.read div:nth-child(3){animation-delay:2s}
.read b{display:block;font-family:"Noto Serif SC";font-size:.86rem;color:#65f0a4;font-weight:600;margin-top:2px}
.hint{text-align:center;font-size:.6rem;letter-spacing:.2em;color:#4a7a60;animation:pulse 2s infinite;position:relative;z-index:3;margin-top:-6px}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.95}}
.scroll{max-height:0;overflow:hidden;opacity:0;transition:max-height 1.1s cubic-bezier(.19,1,.22,1),opacity .9s .2s;padding:0 22px;position:relative;z-index:3}
.scroll.show{max-height:1200px;opacity:1}
.card{border:1px solid #1d3328;border-radius:10px;padding:22px 20px;background:linear-gradient(135deg,rgba(20,40,28,.4),rgba(8,14,10,.5)),#0a120e;box-shadow:0 24px 60px -28px rgba(0,0,0,.9)}
.ch{font-family:"Cinzel",serif;font-size:.56rem;letter-spacing:.34em;color:#3f6b51;text-transform:uppercase;text-align:center}
.ct{font-size:1.16rem;letter-spacing:.1em;color:#65f0a4;text-align:center;margin:7px 0 16px}
.lead{font-style:italic;font-size:.95rem;line-height:1.6;color:#9fc4b0;text-align:center;padding-bottom:16px;border-bottom:1px solid #15291f;margin-bottom:16px}
.p{font-size:.9rem;line-height:1.9;color:#cfe0d6;margin-bottom:13px;text-align:justify}
.p .em{color:#65f0a4;font-weight:600}
.note{font-size:.76rem;line-height:1.7;color:#7a9a8a;border:1px dashed #214d38;border-radius:8px;padding:11px 13px;margin-top:16px;background:rgba(0,0,0,.2)}
.enter{display:block;width:100%;margin-top:16px;padding:14px;cursor:pointer;background:linear-gradient(180deg,rgba(101,240,164,.18),rgba(101,240,164,.06));border:1px solid #3f9a6a;border-radius:8px;color:#65f0a4;font-family:"Cinzel",serif;font-size:.78rem;letter-spacing:.26em;text-transform:uppercase;transition:.3s}
.enter:hover{background:linear-gradient(180deg,rgba(101,240,164,.3),rgba(101,240,164,.12));box-shadow:0 0 28px rgba(101,240,164,.25)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap">
<div class="scan"></div>
<div class="head">
  <div class="kick">Black Market · Sealed File X7-002</div>
  <div class="name">吐 真 剂</div>
  <div class="latin">it loosens the tongue before the mind can object</div>
  <div class="rule"></div>
</div>
<div class="tray">
  <div class="vial" id="vial" onclick="arm()">
    <div class="tube"><div class="liq"></div></div>
    <div class="gas" id="gas"></div>
    <div class="read">
      <div>AGENT<b>VERITAS_SERUM</b></div>
      <div>STATE<b id="st">封存中</b></div>
      <div>RISK<b>语言过滤失效</b></div>
    </div>
  </div>
</div>
<div class="hint" id="hint">轻触安瓿，扭开封蜡</div>
<div class="scroll" id="scroll"><div class="card">
  <div class="ch">Chapter Zero</div>
  <div class="ct">误触的那一下</div>
  <p class="lead">劣质喷头在你掌心轻轻一陷。<br>一小股幽绿，散在你和 {{char}} 之间。</p>
  <p class="p">你退弹口刚滑出这支安瓿，就在暗巷口撞见了 {{char}}。ta 皱着眉凑近盘问，你手一抖，喷头被误触——气体无声地弥散开。等你反应过来，{{char}} 已经吸进了一口。</p>
  <p class="p">说明书只剩一行字：<span class="em">服用者无法说谎，也来不及过滤念头</span>。此刻 {{char}} 神志清醒，却察觉到喉咙正不受自己控制——下一句话，ta 大概拦不住。</p>
  <p class="note">药效如何在 {{char}} 身上发作、ta 是慌乱遮掩还是干脆豁出去，全看 ta 的性格。你只要先开口问。</p>
  <button class="enter" onclick="go(this)">启 封 档 案</button>
</div></div>
</div>
<script>
(function(){var g=document.getElementById('gas');for(var i=0;i<10;i++){var d=document.createElement('i');d.style.left=(8+Math.random()*30)+'px';d.style.animationDuration=(2.4+Math.random()*2.2)+'s';d.style.animationDelay=(Math.random()*3)+'s';g.appendChild(d);}})();
function arm(){var v=document.getElementById('vial');v.style.boxShadow='0 28px 56px -22px rgba(0,0,0,.9),inset 0 0 50px rgba(101,240,164,.22)';document.getElementById('st').textContent='泄漏中';document.getElementById('hint').textContent='封蜡已开';setTimeout(function(){var s=document.getElementById('scroll');s.classList.add('show');setTimeout(function(){s.scrollIntoView({behavior:'smooth',block:'start'});},340);},260);}
function go(btn){if(window.__bmGo)return;window.__bmGo=true;if(btn){btn.disabled=true;btn.style.opacity=.6;btn.textContent='剧情已开始';}if(window.Theater&&window.Theater.sendUserAction){window.Theater.sendUserAction('*我挡在ta面前，盯着刚吸进那口药气、神色还没缓过来的ta* 「先别走——老实回答我一个问题。」');}}
</script></body></html>`;

const OPENING_DREAM = String.raw`<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600&family=Cinzel:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#070510;color:#ece4f2;font-family:"Noto Serif SC",serif;min-height:100vh;overflow-x:hidden;background-image:radial-gradient(ellipse at 50% 0%,#1a0f24 0%,transparent 55%),radial-gradient(ellipse at 20% 100%,#160a1e 0%,transparent 55%);padding-bottom:26px}
.wrap{max-width:600px;margin:0 auto;position:relative}
.grain{position:absolute;inset:0;pointer-events:none;z-index:1;opacity:.5;background:repeating-linear-gradient(0deg,rgba(244,168,212,.04),rgba(244,168,212,.04) 1px,transparent 1px,transparent 3px)}
.head{text-align:center;padding:40px 22px 14px;position:relative;z-index:3}
.kick{font-family:"Cinzel",serif;font-size:.6rem;letter-spacing:.44em;color:#7a4f7a;text-transform:uppercase;opacity:0;animation:rise 1s .2s both}
.name{font-weight:300;font-size:2.4rem;letter-spacing:.2em;color:#f0a8d4;text-indent:.2em;text-shadow:0 0 32px rgba(240,168,212,.5);margin-top:12px;opacity:0;animation:rise 1.1s .45s both}
.latin{font-size:.82rem;font-style:italic;color:#b48ac4;margin-top:9px;opacity:0;animation:rise 1s .8s both}
.rule{width:0;height:1px;margin:18px auto 0;background:linear-gradient(90deg,transparent,#a05fb0,transparent);animation:wide 1.3s 1s both}
@keyframes rise{from{opacity:0;transform:translateY(16px);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}
@keyframes wide{to{width:210px}}
.stage{display:flex;justify-content:center;padding:16px 0 24px;position:relative;z-index:3}
.tape{width:230px;height:148px;border-radius:12px;background:linear-gradient(150deg,#1a1320,#100b16);border:1px solid #34243c;padding:16px;position:relative;cursor:pointer;box-shadow:0 28px 56px -22px rgba(0,0,0,.9);transition:transform .4s}
.tape:active{transform:scale(.99)}
.reels{display:flex;justify-content:space-between;padding:0 14px}
.reel{width:60px;height:60px;border-radius:50%;border:2px solid #4a3352;position:relative;background:radial-gradient(circle,#251a2e 30%,#160f1c);animation:spin 2.4s linear infinite}
.reel:before{content:"";position:absolute;inset:24px;border-radius:50%;border:1px dashed #6a4a72}
@keyframes spin{to{transform:rotate(360deg)}}
.win{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:120px;height:30px;border-radius:5px;background:#06040a;border:1px solid #34243c;overflow:hidden}
.win i{position:absolute;top:0;bottom:0;width:36%;background:linear-gradient(90deg,transparent,rgba(240,168,212,.55),transparent);animation:sweep 1.8s linear infinite}
@keyframes sweep{from{left:-40%}to{left:110%}}
.lbl{position:absolute;top:14px;left:16px;font-family:"Cinzel";font-size:.5rem;letter-spacing:.16em;color:#8a5f92}
.hint{text-align:center;font-size:.6rem;letter-spacing:.2em;color:#7a4f7a;animation:pulse 2s infinite;position:relative;z-index:3;margin-top:-4px}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.95}}
.proj{max-height:0;overflow:hidden;opacity:0;transition:max-height 1.2s cubic-bezier(.19,1,.22,1),opacity .9s .2s;padding:0 22px;position:relative;z-index:3}
.proj.show{max-height:1200px;opacity:1}
.dream{border:1px solid #34243c;border-radius:10px;padding:22px 20px;background:linear-gradient(135deg,rgba(40,24,48,.45),rgba(12,8,18,.5)),#100b16;box-shadow:0 24px 60px -28px rgba(0,0,0,.9);position:relative;overflow:hidden}
.dream:before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 60% 0%,rgba(240,168,212,.12),transparent 60%);pointer-events:none}
.ch{font-family:"Cinzel";font-size:.56rem;letter-spacing:.34em;color:#7a4f7a;text-transform:uppercase;text-align:center}
.ct{font-size:1.16rem;letter-spacing:.1em;color:#f0a8d4;text-align:center;margin:7px 0 16px}
.lead{font-style:italic;font-size:.95rem;line-height:1.6;color:#c8a8d4;text-align:center;padding-bottom:16px;border-bottom:1px solid #281a30;margin-bottom:16px}
.p{font-size:.9rem;line-height:1.9;color:#e4d8ec;margin-bottom:13px;text-align:justify}
.p .em{color:#f0a8d4;font-weight:600}
.sym{display:flex;gap:10px;margin:16px 0 4px}
.sym div{flex:1;border:1px solid #281a30;border-radius:7px;padding:11px 6px;text-align:center;background:rgba(0,0,0,.25)}
.sym .ic{font-size:1.2rem;color:#f0a8d4}
.sym .nm{font-size:.54rem;letter-spacing:.1em;color:#b48ac4;margin-top:5px;text-transform:uppercase}
.note{font-size:.76rem;line-height:1.7;color:#b48ac4;border:1px dashed #4a3352;border-radius:8px;padding:11px 13px;margin-top:16px;background:rgba(0,0,0,.2)}
.enter{display:block;width:100%;margin-top:16px;padding:14px;cursor:pointer;background:linear-gradient(180deg,rgba(240,168,212,.18),rgba(240,168,212,.06));border:1px solid #a05fb0;border-radius:8px;color:#f0a8d4;font-family:"Cinzel";font-size:.78rem;letter-spacing:.26em;text-transform:uppercase;transition:.3s}
.enter:hover{background:linear-gradient(180deg,rgba(240,168,212,.3),rgba(240,168,212,.12));box-shadow:0 0 28px rgba(240,168,212,.25)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap">
<div class="grain"></div>
<div class="head">
  <div class="kick">Black Market · Sealed File M5-021</div>
  <div class="name">梦境录像带</div>
  <div class="latin">last night, played back without consent</div>
  <div class="rule"></div>
</div>
<div class="stage">
  <div class="tape" id="tape" onclick="arm()">
    <div class="lbl">OPHIRA · ▶ REW</div>
    <div class="reels"><div class="reel"></div><div class="reel"></div></div>
    <div class="win"><i></i></div>
  </div>
</div>
<div class="hint" id="hint">轻触磁带，按下倒带</div>
<div class="proj" id="proj"><div class="dream">
  <div class="ch">Reel One</div>
  <div class="ct">投到空气里的梦</div>
  <p class="lead">磁带自己倒带。<br>屏幕亮起时没有声音，只有画面，浮在你们之间。</p>
  <p class="p">外壳已经发白，贴纸上写着 OPHIRA。你把它插进终端，它没有播放到屏幕上，而是把 {{char}} 昨夜的梦，<span class="em">投影在你和 ta 之间的空气里</span>。</p>
  <p class="p">梦不是事实，却最诚实。门、雨、一只没接的电话、一个反复出现的背影——{{char}} 想伸手遮住投影，却发现自己根本关不掉它。</p>
  <div class="sym"><div><div class="ic">⌖</div><div class="nm">门</div></div><div><div class="ic">☂</div><div class="nm">雨</div></div><div><div class="ic">☎</div><div class="nm">未接</div></div></div>
  <p class="note">梦里的象征指向 {{char}} 没说出口的欲望或恐惧。ta 可以辩解梦不算数，但反应会出卖 ta 有多在意。</p>
  <button class="enter" onclick="go(this)">播 放 这 卷</button>
</div></div>
</div>
<script>
function arm(){var t=document.getElementById('tape');t.style.boxShadow='0 28px 56px -22px rgba(0,0,0,.9),0 0 40px rgba(240,168,212,.2)';document.getElementById('hint').textContent='投影已就绪';setTimeout(function(){var p=document.getElementById('proj');p.classList.add('show');setTimeout(function(){p.scrollIntoView({behavior:'smooth',block:'start'});},340);},260);}
function go(btn){if(window.__bmGo)return;window.__bmGo=true;if(btn){btn.disabled=true;btn.style.opacity=.6;btn.textContent='正在播放';}if(window.Theater&&window.Theater.sendUserAction){window.Theater.sendUserAction('*我没有关掉投影，反而往前凑近了些，看着空气里那场梦慢慢显形* 「这就是你昨晚做的梦？别急着否认。」');}}
</script></body></html>`;

const OPENING_NEURO = String.raw`<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600&family=Cinzel:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#04070a;color:#dbe7ef;font-family:"Noto Serif SC",serif;min-height:100vh;overflow-x:hidden;background-image:radial-gradient(ellipse at 50% 0%,#0a1620 0%,transparent 55%),radial-gradient(ellipse at 80% 100%,#081119 0%,transparent 55%);padding-bottom:26px}
.wrap{max-width:600px;margin:0 auto;position:relative}
.scan{position:absolute;inset:0;pointer-events:none;z-index:1;opacity:.5;background:repeating-linear-gradient(180deg,rgba(110,231,249,.05),rgba(110,231,249,.05) 1px,transparent 1px,transparent 4px)}
.head{text-align:center;padding:40px 22px 14px;position:relative;z-index:3}
.kick{font-family:"Cinzel",serif;font-size:.6rem;letter-spacing:.44em;color:#3a6a78;text-transform:uppercase;opacity:0;animation:rise 1s .2s both}
.name{font-weight:300;font-size:2.4rem;letter-spacing:.2em;color:#6ee7f9;text-indent:.2em;text-shadow:0 0 30px rgba(110,231,249,.45);margin-top:12px;opacity:0;animation:rise 1.1s .45s both,glitch 5s 2s infinite}
.latin{font-size:.82rem;font-style:italic;color:#7a9aa8;margin-top:9px;opacity:0;animation:rise 1s .8s both}
.rule{width:0;height:1px;margin:18px auto 0;background:linear-gradient(90deg,transparent,#3f8a9a,transparent);animation:wide 1.3s 1s both}
@keyframes rise{from{opacity:0;transform:translateY(16px);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}
@keyframes wide{to{width:210px}}
@keyframes glitch{0%,94%,100%{transform:none;opacity:1}95%{transform:translateX(-2px);opacity:.7}96%{transform:translateX(2px)}97%{transform:none}}
.stage{display:flex;justify-content:center;padding:16px 0 24px;position:relative;z-index:3}
.dev{width:200px;height:210px;border-radius:16px;background:linear-gradient(150deg,#0c151c,#070c11);border:1px solid #1c333d;position:relative;cursor:pointer;overflow:hidden;box-shadow:0 28px 56px -22px rgba(0,0,0,.9);transition:transform .4s}
.dev:active{transform:scale(.99)}
.sil{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:96px;height:150px;background:radial-gradient(ellipse at 50% 22%,#16323c 0 30%,transparent 70%),linear-gradient(180deg,#11262e,#0a161c);border-radius:48px 48px 0 0;opacity:.9}
.sil:before{content:"";position:absolute;top:18px;left:50%;transform:translateX(-50%);width:52px;height:52px;border-radius:50%;background:#0a161c;box-shadow:inset 0 0 18px rgba(110,231,249,.18)}
.retic{position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,#6ee7f9,transparent);box-shadow:0 0 14px #6ee7f9;animation:swp 2.6s ease-in-out infinite}
@keyframes swp{0%,100%{top:8%}50%{top:88%}}
.noise{position:absolute;inset:0;font-family:"Cinzel";pointer-events:none}
.noise b{position:absolute;color:#6ee7f9;font-size:.56rem;font-weight:400;opacity:0;animation:blip 3s infinite}
@keyframes blip{0%,100%{opacity:0}50%{opacity:.8}}
.tag{position:absolute;top:10px;left:12px;font-family:"Cinzel";font-size:.5rem;letter-spacing:.14em;color:#3f8a9a;z-index:2}
.hint{text-align:center;font-size:.6rem;letter-spacing:.2em;color:#3a6a78;animation:pulse 2s infinite;position:relative;z-index:3;margin-top:-4px}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.95}}
.scroll{max-height:0;overflow:hidden;opacity:0;transition:max-height 1.2s cubic-bezier(.19,1,.22,1),opacity .9s .2s;padding:0 22px;position:relative;z-index:3}
.scroll.show{max-height:1200px;opacity:1}
.card{border:1px solid #1c333d;border-radius:10px;padding:22px 20px;background:linear-gradient(135deg,rgba(18,40,48,.4),rgba(8,14,18,.5)),#0a141a;box-shadow:0 24px 60px -28px rgba(0,0,0,.9)}
.ch{font-family:"Cinzel";font-size:.56rem;letter-spacing:.34em;color:#3a6a78;text-transform:uppercase;text-align:center}
.ct{font-size:1.16rem;letter-spacing:.1em;color:#6ee7f9;text-align:center;margin:7px 0 16px}
.lead{font-style:italic;font-size:.95rem;line-height:1.6;color:#a8c4d0;text-align:center;padding-bottom:16px;border-bottom:1px solid #15282f;margin-bottom:16px}
.p{font-size:.9rem;line-height:1.9;color:#d6e2ea;margin-bottom:13px;text-align:justify}
.p .em{color:#6ee7f9;font-weight:600}
.bars{display:flex;gap:5px;align-items:flex-end;height:34px;margin:16px 0 6px;justify-content:center}
.bars i{width:7px;background:#6ee7f9;border-radius:2px;box-shadow:0 0 10px rgba(110,231,249,.5);animation:eq 1.1s ease-in-out infinite}
@keyframes eq{0%,100%{height:20%}50%{height:100%}}
.note{font-size:.76rem;line-height:1.7;color:#7a9aa8;border:1px dashed #1c333d;border-radius:8px;padding:11px 13px;margin-top:16px;background:rgba(0,0,0,.2)}
.enter{display:block;width:100%;margin-top:16px;padding:14px;cursor:pointer;background:linear-gradient(180deg,rgba(110,231,249,.18),rgba(110,231,249,.06));border:1px solid #3f8a9a;border-radius:8px;color:#6ee7f9;font-family:"Cinzel";font-size:.78rem;letter-spacing:.26em;text-transform:uppercase;transition:.3s}
.enter:hover{background:linear-gradient(180deg,rgba(110,231,249,.3),rgba(110,231,249,.12));box-shadow:0 0 28px rgba(110,231,249,.25)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap">
<div class="scan"></div>
<div class="head">
  <div class="kick">Black Market · Sealed File O1-666</div>
  <div class="name">读 心 术</div>
  <div class="latin">one scan. it reads back, too.</div>
  <div class="rule"></div>
</div>
<div class="stage">
  <div class="dev" id="dev" onclick="arm()">
    <div class="tag">NEUROSCAN</div>
    <div class="sil"></div>
    <div class="retic"></div>
    <div class="noise" id="noise"></div>
  </div>
</div>
<div class="hint" id="hint">轻触扫描，对准 ta</div>
<div class="scroll" id="scroll"><div class="card">
  <div class="ch">Scan Zero</div>
  <div class="ct">视野边缘的噪点</div>
  <p class="lead">掌心亮起一枚白色光标。<br>它跳了三下，然后消失。</p>
  <p class="p">黑市没给你实体，只在你掌心投下一枚会消失的光标。它跳动三次后，{{char}} <span class="em">没说出口的第一层念头</span>，开始以噪点的形式浮现在你视野边缘。</p>
  <p class="p">问题是——这道扫描是双向的。{{char}} 隐约感觉到自己正被读取，于是开始转移话题、压低情绪、用反问设防。你能读到，但读不久。</p>
  <div class="bars" id="bars"></div>
  <p class="note">每一轮 {{char}} 都会同时露出「说出口的话」与「没说出口的真实念头」，并随回合越来越警觉。</p>
  <button class="enter" onclick="go(this)">校 准 扫 描</button>
</div></div>
</div>
<script>
(function(){var n=document.getElementById('noise'),W=['？','他','别','删','只','我',':',';'];for(var i=0;i<9;i++){var b=document.createElement('b');b.textContent=W[i%W.length];b.style.left=(8+Math.random()*78)+'%';b.style.top=(8+Math.random()*78)+'%';b.style.animationDelay=(Math.random()*3)+'s';n.appendChild(b);}var bars=document.getElementById('bars');if(bars){for(var j=0;j<11;j++){var s=document.createElement('i');s.style.animationDelay=(Math.random()*1.1)+'s';bars.appendChild(s);}}})();
function arm(){var d=document.getElementById('dev');d.style.boxShadow='0 28px 56px -22px rgba(0,0,0,.9),0 0 40px rgba(110,231,249,.22)';document.getElementById('hint').textContent='信号已锁定';setTimeout(function(){var s=document.getElementById('scroll');s.classList.add('show');setTimeout(function(){s.scrollIntoView({behavior:'smooth',block:'start'});},340);},260);}
function go(btn){if(window.__bmGo)return;window.__bmGo=true;if(btn){btn.disabled=true;btn.style.opacity=.6;btn.textContent='扫描已开始';}if(window.Theater&&window.Theater.sendUserAction){window.Theater.sendUserAction('*我盯着ta，试着去接住那些在视野边缘浮起的、没说出口的念头* 「我想知道——你现在心里到底在想什么。」');}}
</script></body></html>`;

// ───────────────────────── Templates ─────────────────────────

export const BLACK_MARKET_BUILTIN_THEATERS: BlackMarketTheaterTemplate[] = [
  makeTemplate({
    id: "builtin_veritas_serum",
    title: "吐真剂",
    codeName: "VERITAS_SERUM",
    fileNumber: "X7-002",
    subtitle: "气体喷雾型 · 语言过滤器失效",
    synopsis: "一次误触泄漏，让 ta 在短时间内无法说谎，连还没过滤的念头都会脱口而出。",
    storyText: "退弹口滑出一支幽绿色微型喷雾。你刚把它塞进口袋，就在暗巷口撞见熟悉的人影。对方靠近盘问时，劣质喷头被误触，一小股气体在两人之间弥散。",
    tags: ["诚实", "失控", "情感逼问"],
    rarity: "common",
    glyph: "◆",
    price: 120,
    durationTurns: 8,
    openingHtml: OPENING_VERITAS,
    aiInstruction: [
      "【世界设定】{{user}} 刚在黑市买了「吐真剂（气体喷雾型）」。{{char}} 盘问 {{user}} 时，{{user}} 误触喷头，{{char}} 吸入了微量气体，药效已全面发作。",
      "【状态锁定】这次夜间通道里，{{char}} 无法说谎、无法敷衍、无法回避——必须回答内心最真实的答案；语言过滤器失效，会不受控地说出潜意识念头、真实情感与来不及修饰的判断。",
      "【演绎要点】{{char}} 主观意识清醒，所以会对自己的口不择言感到惊恐、羞耻、恼怒或慌乱，并不断用动作试图阻止自己开口却失败。具体是炸毛、嘴硬、破罐破摔还是慌张否认，由 {{char}} 自己的人设决定，不要套统一反应。",
      "【推进】回应 {{user}} 刚说的话或动作，把「药效逼出真话」的剧情往前推一步。第一轮要体现药效初次爆发的失控感。",
    ].join("\n"),
    outputContract: CONTRACT_VERITAS,
    renderRules: RULES_VERITAS,
    renderCss: CSS_VERITAS,
    memorySummaryPrompt: "请总结吐真剂档案中 {{char}} 被迫说出的关键真话、暴露的情感、{{user}} 的追问重点与关系变化，写成 1 条短期记忆。不要写系统信息。",
  }),
  makeTemplate({
    id: "builtin_ophira_tape",
    title: "梦境录像带",
    codeName: "OPHIRA_TAPE",
    fileNumber: "M5-021",
    subtitle: "昨夜梦境 · 非授权回放",
    synopsis: "一卷会自己倒带的录像带，把 ta 昨晚的梦投到空气里。梦不是事实，却总泄露欲望、恐惧和没说完的念头。",
    storyText: "磁带外壳已经发白，贴纸上写着 OPHIRA。插入终端后，屏幕没有播放画面，而是把梦境投到你们之间的空气里。",
    tags: ["梦境", "象征", "暧昧/恐惧"],
    rarity: "rare",
    glyph: "▣",
    price: 350,
    durationTurns: 10,
    openingHtml: OPENING_DREAM,
    aiInstruction: [
      "【世界设定】{{user}} 启封了「梦境录像带」。{{char}} 昨夜的梦被投影出来，{{char}} 无法阻止 {{user}} 观看，也关不掉投影。",
      "【状态锁定】{{char}} 必须围绕梦境推进：梦里有具体的象征画面（门、雨、未接来电、反复出现的背影等），并与 {{char}} 隐藏的欲望或恐惧、与 {{user}} 的关系有关。梦境随回合一段段显形，不要一次抖完。",
      "【演绎要点】{{char}} 可以辩解「梦不代表现实」，但反应必须暴露 ta 在意这场梦。不要把梦解释成纯随机内容，也不要替角色把象征点破。",
      "【推进】先让本轮的梦境画面继续显形，再写 {{char}} 试图遮挡或解释的反应，并回应 {{user}} 的话。",
    ].join("\n"),
    outputContract: CONTRACT_OPHIRA,
    renderRules: RULES_OPHIRA,
    renderCss: CSS_OPHIRA,
    memorySummaryPrompt: "请总结梦境录像带播放出的梦境内容、象征含义、{{char}} 暴露的欲望或恐惧，以及 {{user}} 的反应，写成 1 条短期记忆。",
  }),
  makeTemplate({
    id: "builtin_neuroscan",
    title: "读心术",
    codeName: "NEUROSCAN",
    fileNumber: "O1-666",
    subtitle: "阅后即焚 · 一次性扫描",
    synopsis: "你能看到 ta 没说出口的第一层念头。代价是：对方也会察觉被读取，并开始反向设防。",
    storyText: "黑市没有给你实体商品，只在你掌心投下一枚会消失的光标。光标跳动三次后，角色未出口的话以噪点形式浮现在你的视野边缘。",
    tags: ["读心", "攻防", "潜台词"],
    rarity: "legend",
    glyph: "◉",
    price: 500,
    durationTurns: 6,
    openingHtml: OPENING_NEURO,
    aiInstruction: [
      "【世界设定】{{user}} 启封了「读心术」。{{user}} 可以短暂读取 {{char}} 没说出口的第一层念头，{{char}} 能隐约感觉到自己正被读取。",
      "【状态锁定】每一轮都必须同时呈现两层：{{char}} 说出口的话，以及 {{char}} 没说出口的真实念头。未出口的念头不能只是重复台词，必须提供新的潜台词、顾虑或欲望。",
      "【演绎要点】{{char}} 会逐渐意识到被读取，并尝试转移话题、压低情绪、用反问设防，但无法取消读心效果。攻防的强度与方式由 {{char}} 人设决定。",
      "【推进】回应 {{user}}，把这场「读心 vs 设防」的拉扯推进一步；本档案剩余回合较少，节奏可以更紧。",
    ].join("\n"),
    outputContract: CONTRACT_NEURO,
    renderRules: RULES_NEURO,
    renderCss: CSS_NEURO,
    memorySummaryPrompt: "请总结读心术档案中 {{user}} 读到的关键未出口念头、{{char}} 的防守反应与关系变化，写成 1 条短期记忆。",
  }),
];

export function getBlackMarketBuiltinTheater(id: string): BlackMarketTheaterTemplate | undefined {
  return BLACK_MARKET_BUILTIN_THEATERS.find(theater => theater.id === id);
}
