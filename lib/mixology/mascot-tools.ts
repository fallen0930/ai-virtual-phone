// lib/mixology/mascot-tools.ts
// 独家特调 · 小卷工具执行器：桌面助手直写酒柜与配方。
//
// 与酒柜界面同一套存储与规矩：官方出厂件与入柜导入的别人的作品不可修改，
// 导入的角色卡正文封存（工具也只回元信息）；删除刻意不提供——小卷只建不拆，
// 拆东西让用户自己在酒柜里做（那里有确认弹窗）。
// 每类材料的写作规格通过「读取制作说明」按需取（与人用的委托词同源派生），
// 这里只做字段校验：校验口径向导入器（transfer.ts）与编辑器看齐，报错给到能改的粒度。

import type { ToolResult } from "../tool-executor";
import {
    MIX_KIND_LABELS,
    MIX_SLOT_ORDER,
    createMixId,
    mixPanelLayoutSummary,
    normalizeMixPanelLayout,
    normalizeMixTags,
    type MixCharacterCard,
    type MixCondition,
    type MixFilterRule,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    type MixSlotEntry,
    type MixTicketVar,
    mixSlotEntries,
    normalizeMixConnectorNames,
    normalizeMixDialogueButton,
    MIX_CONNECTOR_NAME_RE,
} from "./types";
import {
    MIX_CABINET_UPDATED_EVENT,
    getMixMaterial,
    isMixBuiltinId,
    listMixBuiltins,
    loadMixCabinet,
    loadMixRecipes,
    saveMixMaterial,
    saveMixRecipe,
    findMixConnector,
    loadMixConnectors,
    saveMixConnector,
    deleteMixConnector,
} from "./storage";
import { MIX_CONNECTOR_KEY_PLACEHOLDER, MIX_CONNECTOR_PRESETS, parseMixConnectorHeaders } from "./connectors";

import { buildMixCraftSpecBoardPrompt, pinMixCraftSpecs } from "./spec-board";
import { buildMixMaterialBoardPrompt, pinMixMaterial, resetMixMaterialBoard, listPinnedMaterialIds, getPinnedMaterial } from "./material-board";
import { isMixCardFreeform, MIX_CARD_FIELD_KEYS, normalizeMixCardProfile } from "./card-freeform";
import { normalizePartCondition } from "./hall-parts";
import { describeMascotNameConflict, describeMascotNameMiss, pickMascotNameCandidates } from "../mascot-entity-lookup";
import { findInMascotTaskLedger, listMascotTaskLedger, recordMascotTaskLedger } from "../mascot-task-ledger";

/** 写库成功后通知已打开的特调 App 重读列表，否则界面要等用户自己操作才刷新 */
function broadcastCabinetUpdated(): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MIX_CABINET_UPDATED_EVENT));
}

/** 是否封存：与酒柜界面的 isSealedMaterial（mixology-shared.tsx）同一条规矩——
 *  只有「从酒材页拿来的别人的角色卡」藏正文。不从组件层 import，免得把 UI 拖进 lib。 */
function isSealed(material: MixMaterial): boolean {
    return Boolean(material.imported) && material.kind === "character";
}

const KIND_SET = new Set<string>(MIX_SLOT_ORDER);

function asKind(value: unknown): MixMaterialKind | null {
    return typeof value === "string" && KIND_SET.has(value) ? (value as MixMaterialKind) : null;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** 来源标注：官方出厂 / 入柜导入 / 自建 */
function originOf(material: MixMaterial): string {
    if (isMixBuiltinId(material.id)) return "官方";
    return material.imported ? "导入（他人作品，不可修改）" : "自建";
}

// ── 列出酒柜 ─────────────────────────────────────────

export function mixToolListCabinet(args: Record<string, unknown>): ToolResult {
    const NAME = "列出酒柜";
    const kindArg = args.kind === undefined || args.kind === "" ? null : asKind(args.kind);
    if (args.kind !== undefined && args.kind !== "" && !kindArg) {
        return { name: NAME, success: false, error: `未知材料种类：${String(args.kind)}。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    }
    const cabinet = loadMixCabinet().filter((m) => !kindArg || m.kind === kindArg);
    const builtins = (kindArg ? listMixBuiltins(kindArg) : listMixBuiltins()).slice();
    const lines: string[] = [];
    lines.push(`酒柜共 ${cabinet.length} 件${kindArg ? `「${MIX_KIND_LABELS[kindArg]}」` : "材料"}，官方出厂件 ${builtins.length} 件。`);
    for (const m of [...cabinet].sort((a, b) => b.updatedAt - a.updatedAt)) {
        lines.push(`· [${m.id}] ${MIX_KIND_LABELS[m.kind]}「${m.name}」（${originOf(m)}）${m.hook ? ` — ${m.hook.slice(0, 40)}` : ""}`);
    }
    for (const m of builtins) {
        lines.push(`· [${m.id}] ${MIX_KIND_LABELS[m.kind]}「${m.name}」（官方）`);
    }
    const recipes = loadMixRecipes();
    if (!kindArg && recipes.length) {
        lines.push(`已有配方 ${recipes.length} 杯：${recipes.map((r) => `「${r.name}」`).join("、")}`);
    }
    return { name: NAME, success: true, data: lines.join("\n") };
}

// ── 读取材料 ─────────────────────────────────────────

/** 按 id 或名字找材料；名字重名或写不准时，回执直接把候选连 id 一起给出去 */
function findMaterial(args: Record<string, unknown>): { ok?: MixMaterial; err?: string } {
    const id = text(args.id).trim();
    if (id) {
        const m = getMixMaterial(id);
        if (m) return { ok: m };
        const mine = listMascotTaskLedger("mixmat").map((entry) => `[${entry.id}] ${entry.label}`).join("、");
        return { err: `没有 id 为 ${id} 的材料（id 记错了，或这件已被删除）。${mine ? `本轮建过的是：${mine}。` : ""}不确定就 列出酒柜 看一遍。` };
    }
    const name = text(args.name).trim();
    if (!name) return { err: "请传 id 或 name 之一。" };
    const all = [...loadMixCabinet(), ...listMixBuiltins()];
    const hits = all.filter((m) => m.name === name);
    if (hits.length === 0) {
        return {
            err: describeMascotNameMiss({
                label: "材料",
                name,
                candidates: pickMascotNameCandidates(all, name, (m) => `${MIX_KIND_LABELS[m.kind]}「${m.name}」`),
                listTool: "列出酒柜",
                createTool: "创建材料",
            }),
        };
    }
    if (hits.length > 1) return { err: `有 ${hits.length} 件材料都叫「${name}」：${hits.map((m) => `[${m.id}] ${MIX_KIND_LABELS[m.kind]}`).join("、")}。请带 id 再调用。` };
    return { ok: hits[0] };
}

function describeMaterial(material: MixMaterial): string {
    const lines: string[] = [];
    lines.push(`[${material.id}] ${MIX_KIND_LABELS[material.kind]}「${material.name}」（${originOf(material)}）`);
    if (material.hook) lines.push(`一句话介绍：${material.hook}`);
    if (material.tags?.length) lines.push(`标签：${material.tags.join("、")}`);
    const field = (label: string, value: string | undefined) => {
        if (value?.trim()) lines.push(`【${label}】\n${value}`);
    };
    switch (material.kind) {
        case "character": {
            const c = material as MixCharacterCard;
            if (isMixCardFreeform(c)) {
                // 一框式：两段正文原样给出（## 小节是作者自己排的），改它要用 profileText / worldText
                lines.push("资料写法：一框式（profileMode = freeform；改资料请传 profileText / worldText 整段正文）");
                field("角色资料", c.profileText); field("世界与剧情", c.worldText);
            } else {
                field("基础信息", c.baseInfo); field("性格", c.personality); field("外貌", c.appearance);
                field("背景", c.background); field("世界观", c.worldview); field("初始认知", c.cognition);
                field("关系与身份", c.relations); field("当前剧情", c.plot); field("附加设定", c.extra);
            }
            c.openings.forEach((o, i) => field(`开场白${i + 1}`, o));
            if (c.examples?.length) field("示例对话", c.examples.map((e) => `${e.role}：${e.text}`).join("\n"));
            field("开场画布", c.canvas);
            break;
        }
        case "persona":
            field("你的名字", material.userName); field("用户人设", material.content);
            break;
        case "ticket":
            field("输出契约", material.contract); field("渲染代码", material.renderHtml);
            field("预览示例数据", material.previewRaw);
            field("历史回传", material.historyFeed === "all" ? "all（全部轮次回传）" : material.historyFeed === "none" ? "none（完全不回传）" : undefined);
            if (material.vars?.length) field("记住的变量", material.vars.map((v) => `${v.name}${v.initial ? `＝${v.initial}` : ""}`).join("、"));
            break;
        case "garnish":
            field("外观 CSS", material.css);
            break;
        case "encore":
            field("输出契约", material.contract); field("渲染代码", material.renderHtml ?? material.html);
            field("预览示例数据", material.previewRaw);
            field("历史回传", material.historyFeed === "all" ? "all（全部轮次回传）" : material.historyFeed === "none" ? "none（完全不回传）" : undefined);
            break;
        case "filter":
            field("清洗规则", material.rules.map((r, i) => `${i + 1}. /${r.find}/ → ${r.replace || "（删除）"}（${r.mode === "display" ? "仅显示" : "进上下文"}）`).join("\n"));
            break;
        case "mechanism":
            if (material.trusted) lines.push("运行方式：信任模式（trusted = true，代码直接在对局页面里执行，用 mix.slot / mix.on 登记坑位与钩子）");
            field(material.trusted ? "代码" : "钩子逻辑", material.script); field("界面代码", material.panelHtml);
            field("摆放", material.layout ? mixPanelLayoutSummary(material.layout) : undefined);
            if (material.dialogueButton?.icon) field("对白按钮", `${material.dialogueButton.icon}${material.dialogueButton.title ? ` ${material.dialogueButton.title}` : ""}`);
            if (material.connectors?.length) {
                field("需要的连接器", material.connectors.map((n) => `${n}${findMixConnector(n) ? "（用户本机已配）" : "（用户本机未配，需到酒柜「连接器」里创建）"}`).join("\n"));
            }
            break;
        default:
            field(`${MIX_KIND_LABELS[material.kind]}内容`, (material as { content?: string }).content);
    }
    return lines.join("\n");
}

// ── 字段地图 / 定点编辑底座 ───────────────────────────
// 以前「改一句话」只有一条路：读取材料（把整件材料所有正文吐出来）→ 更新材料（把整段
// 字符串重新输出一遍）。角色卡实测 9454 字、开场画布 6000+ 字符，一次输出很容易撞
// max_tokens 被截断，截断 == 这次修改整笔丢掉；而读回来的全文又作为 tool 回执留在历史里、
// 之后每轮请求重发一遍。这里给一套按 (材料 id, 字段路径) 定点修改的底座：模型只输出
// 改动片段，宿主内部完成「取原文 → 定位 → 替换 → 校验 → 一次性落盘」。

type FieldPath = { top: string; segments: string[]; label: string };

/** 字段路径：content / profileText / openings.0 / examples.2.text */
function parseFieldPath(raw: unknown): FieldPath | null {
    if (typeof raw !== "string") return null;
    const parts = raw.trim().split(".").map((p) => p.trim()).filter(Boolean);
    if (!parts.length || parts.some((p) => !/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(p))) return null;
    return { top: parts[0], segments: parts.slice(1), label: parts.join(".") };
}

function fieldSpecFor(kind: MixMaterialKind, top: string): FieldSpec | undefined {
    return CONTENT_FIELDS.find((spec) => spec.key === top && spec.kinds.includes(kind));
}

function readAtPath(root: Record<string, unknown>, path: FieldPath): unknown {
    let cur: unknown = root;
    for (const seg of [path.top, ...path.segments]) {
        if (Array.isArray(cur)) {
            const index = Number(seg);
            if (!Number.isInteger(index) || index < 0 || index >= cur.length) return undefined;
            cur = cur[index];
        } else if (cur && typeof cur === "object") {
            cur = (cur as Record<string, unknown>)[seg];
        } else return undefined;
    }
    return cur;
}

function writeAtPath(root: Record<string, unknown>, path: FieldPath, value: unknown): boolean {
    const segments = [path.top, ...path.segments];
    const set = (node: unknown, rest: string[]): boolean => {
        const [head, ...tail] = rest;
        if (Array.isArray(node)) {
            const index = Number(head);
            if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
            if (!tail.length) { node[index] = value; return true; }
            return set(node[index], tail);
        }
        if (!node || typeof node !== "object") return false;
        const obj = node as Record<string, unknown>;
        if (!tail.length) { obj[head] = value; return true; }
        return set(obj[head], tail);
    };
    return set(root, segments);
}

/** 字段地图：字段名 + 字数 + 开头锚点。让模型不读全文也能写出准确的 find 片段。 */
function describeFieldMap(material: MixMaterial): string {
    const rows: string[] = [];
    const source = material as unknown as Record<string, unknown>;
    const push = (path: string, value: unknown) => {
        if (typeof value !== "string") return;
        const head = value.replace(/\s+/g, " ").trim().slice(0, 36);
        rows.push(`· ${path}（${value.length} 字）${head ? `｜开头：${head}…` : "｜（空）"}`);
    };
    for (const spec of CONTENT_FIELDS) {
        if (!spec.kinds.includes(material.kind)) continue;
        const value = source[spec.key];
        if (typeof value === "string") { push(spec.key, value); continue; }
        if (!Array.isArray(value)) continue;
        value.forEach((item, index) => {
            if (spec.key === "openings" && typeof item === "string") push(`${spec.key}.${index}`, item);
            else if (spec.key === "examples" && item && typeof item === "object") {
                push(`${spec.key}.${index}.text`, (item as Record<string, unknown>).text);
            }
        });
    }
    return rows.length ? rows.join("\n") : "（这件材料还没有可编辑的正文字段）";
}

/** 找不到 find 片段时，就地给一小段原文，别让模型再回头扫一遍全文 */
function excerptAround(source: string, probe: string, radius = 200): string {
    if (!source.trim()) return "（这个字段目前是空的；要新增内容请用 append）";
    let at = probe ? source.indexOf(probe) : -1;
    if (at < 0 && probe) {
        for (const len of [12, 8, 4]) {
            const chunk = probe.slice(0, len);
            if (!chunk) break;
            at = source.indexOf(chunk);
            if (at >= 0) break;
        }
    }
    if (at < 0) return `原文开头：\n${source.slice(0, radius)}${source.length > radius ? "…" : ""}`;
    const start = Math.max(0, at - Math.floor(radius / 2));
    const end = Math.min(source.length, at + Math.ceil(radius / 2));
    return `原文第 ${start}~${end} 字：\n${source.slice(start, end)}`;
}

function materialHead(material: MixMaterial): string {
    return `[${material.id}] ${MIX_KIND_LABELS[material.kind]}「${material.name}」（${originOf(material)}）`;
}

/** 本轮动过的材料 id 清单。每次写回执都带上，模型照 id 接着改，不必再「列出酒柜」。 */
function ledgerDigest(): string {
    const list = listMascotTaskLedger("mixmat");
    if (!list.length) return "";
    return `\n【本轮材料台账（照 id 直接用，别再列酒柜 / 别按名字重找）】${list.map((e) => `${e.kind}:${e.id}`).join("、")}`;
}

export function mixToolReadMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "读取材料";
    const r = findMaterial(args);
    if (!r.ok) return { name: NAME, success: false, error: r.err };
    if (isSealed(r.ok)) {
        return {
            name: NAME, success: true,
            data: `[${r.ok.id}] 角色卡「${r.ok.name}」是从酒材页入柜的他人作品，正文封存（与酒柜界面同规矩），不可读取或修改。${r.ok.hook ? `\n一句话介绍：${r.ok.hook}` : ""}`,
        };
    }
    const material = r.ok;
    const mode = text(args.mode).trim() || "full";

    // 防循环：材料已在常驻板时，提醒模型直接改，不要重读全文。
    // 但 fields 指定（只要某字段）和 window/outline 模式不算重读全文，放行。
    const alreadyPinned = getPinnedMaterial(material.id);
    const hasFields = Array.isArray(args.fields) && (args.fields as unknown[]).length > 0;
    if (alreadyPinned && mode === "full" && !hasFields) {
        return {
            name: NAME, success: true,
            data: `⚠️ 这件材料已经在常驻板里了（${MIX_KIND_LABELS[material.kind]}「${material.name}」，id: ${material.id}），系统提示词里就有它的完整正文，不用重读。直接用「改材料片段」按 id + field 改就行。`,
        };
    }

    const head = materialHead(material);
    const fieldMap = describeFieldMap(material);
    const hint = `\n字段路径（改材料片段 / 局部读取都按它填 field）：\n${fieldMap}`;

    // 结构视图：只有字段地图，不回任何正文。改几个字之前的默认选择。
    if (mode === "outline") {
        return {
            name: NAME, success: true,
            data: `${head}\n${hint}\n要看某处原文：mode:"window" 配 anchor，或 fields:["字段路径"] 只取一个字段。改文本直接用「改材料片段」，不必先读全文。`,
        };
    }

    // 只取指定字段的全文
    const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).filter((f): f is string => typeof f === "string") : [];
    if (fields.length) {
        const lines: string[] = [head];
        for (const raw of fields) {
            const path = parseFieldPath(raw);
            if (!path || !fieldSpecFor(material.kind, path.top)) {
                lines.push(`【${raw}】不是这件材料可编辑的字段。可用路径见下面字段地图。`);
                continue;
            }
            const value = readAtPath(material as unknown as Record<string, unknown>, path);
            lines.push(`【${path.label}】\n${typeof value === "string" ? value : "（不是文本字段或路径不存在）"}`);
        }
        return { name: NAME, success: true, data: `${lines.join("\n")}\n${hint}` };
    }

    // 窗口视图：只回锚点附近的一小段，find 片段从里面抄就行
    if (mode === "window") {
        const anchor = text(args.anchor).trim();
        if (!anchor) return { name: NAME, success: false, error: 'mode:"window" 需要 anchor（原文里的一小段已知文字）。' };
        const radius = Math.min(1200, Math.max(120, Number(args.radius) || 320));
        const body = describeMaterial(material);
        return {
            name: NAME, success: true,
            data: `${head}\n【${anchor} 附近原文】\n${excerptAround(body, anchor, radius)}\n${hint}`,
        };
    }

    // 兼容旧行为：完整全文。全文回执由 agent loop 的历史折叠负责不再每轮重发。
    // 同时把正文 pin 进常驻板：下一轮模型想改内容时，板里还有，不必重读。
    pinMixMaterial(material.id, material.kind, material.name, describeMaterial(material));
    return { name: NAME, success: true, data: `${describeMaterial(material)}\n${hint}\n（正文已常驻本轮系统提示词，接着改不用再读）` };
}

// ── 读取制作说明 ─────────────────────────────────────

/**
 * 规格不再整段当回执塞进历史（下一轮就被折叠成 160 字摘要，长正文写到一半只好重读）。
 * 现在 pin 进任务级常驻板，由引擎每轮注入系统提示词；历史里只留一行短回执。
 * 支持 kinds 一次读多类：建一整套副本要 6~10 类规格，一轮拿齐，不用每类各调一次。
 */
export function mixToolReadCraftSpec(args: Record<string, unknown>): ToolResult {
    const NAME = "读取制作说明";
    const kindsRaw: unknown[] = Array.isArray(args.kinds)
        ? (args.kinds as unknown[])
        : args.kind !== undefined ? [args.kind] : [];
    if (!kindsRaw.length) {
        return { name: NAME, success: false, error: `请传材料种类 kind，或 kinds 一次读多类。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    }
    // 先整体校验再 pin：任何一类写错就整次报错，不 pin 任何东西
    const kinds: MixMaterialKind[] = [];
    for (const raw of kindsRaw) {
        const kind = asKind(raw);
        if (!kind) return { name: NAME, success: false, error: `未知材料种类：${String(raw)}。可选：${MIX_SLOT_ORDER.join(" / ")}` };
        if (!kinds.includes(kind)) kinds.push(kind);
    }
    const { pinned, evicted } = pinMixCraftSpecs(kinds);
    const lines = [`制作规格已常驻本轮系统提示词：${pinned.map((k) => MIX_KIND_LABELS[k]).join("、")}。写材料时直接照规格执行，不用重读。`];
    if (evicted.length) {
        lines.push(`注意：常驻板有总预算，${evicted.map((k) => MIX_KIND_LABELS[k]).join("、")} 的规格被挤出，写到那类时再读一次即可。`);
    }
    return { name: NAME, success: true, data: lines.join("\n") };
}

// ── 酒柜快照（宿主侧上下文注入） ─────────────────────

/** 快照总量上限：配方映射与焦点字段地图优先，材料清单装不下就明说裁掉了多少 */
const MIX_SNAPSHOT_BUDGET = 9000;

function recipeSlotDigest(recipe: MixRecipe, byId: Map<string, MixMaterial>): string {
    const parts: string[] = [];
    for (const kind of MIX_SLOT_ORDER) {
        const entries = mixSlotEntries(recipe.slots, kind);
        if (!entries.length) continue;
        const cells = entries.map((entry) => {
            const material = byId.get(entry.materialId);
            if (!material) return `${entry.materialId}（失效：材料已不存在）`;
            return `${material.id}（${material.name}）`;
        });
        parts.push(`${MIX_KIND_LABELS[kind]}=${cells.join("+")}`);
    }
    return parts.length ? parts.join("，") : "（空杯，还没放材料）";
}

/**
 * 从内存酒柜同步算一份索引，供引擎每轮注入系统提示词。
 * 改已有副本不再盲改：配方→槽位→材料 id 的映射直接可见；
 * 用户点名的材料附字段地图（路径/字数/开头锚点），改片段不用再读 outline。
 */
export function buildMixCabinetSnapshot(focusText: string): string {
    const cabinet = loadMixCabinet();
    const builtins = listMixBuiltins();
    const recipes = loadMixRecipes();
    const all = [...cabinet, ...builtins];
    const byId = new Map(all.map((m) => [m.id, m]));

    const header = [
        "===== 特调酒柜快照（宿主每轮生成的当前事实） =====",
        `自建材料 ${cabinet.length} 件、官方出厂件 ${builtins.length} 件、配方 ${recipes.length} 杯。`,
        "照下面的 id 直接用，不必再「列出酒柜」确认；要看某件正文用「读取材料」，改文本用「改材料片段」。",
    ].join("\n");

    const recipeLines = recipes.map((recipe) => {
        const mark = recipe.imported ? "（导入，不可改）" : "";
        return `· [${recipe.id}]「${recipe.name}」${mark}：${recipeSlotDigest(recipe, byId)}`;
    });
    const recipeBlock = recipeLines.length ? `【配方 → 材料映射】\n${recipeLines.join("\n")}` : "";

    // 焦点：用户原话里点名的材料/配方。配方命中时展开它槽位里的材料。
    const focus = focusText.trim();
    const focused: MixMaterial[] = [];
    const pushFocus = (material: MixMaterial | undefined) => {
        if (!material || isSealed(material)) return;
        if (!focused.some((m) => m.id === material.id)) focused.push(material);
    };
    if (focus) {
        for (const material of all) {
            if (material.name.length >= 2 && focus.includes(material.name)) pushFocus(material);
        }
        for (const recipe of recipes) {
            if (recipe.name.length < 2 || !focus.includes(recipe.name)) continue;
            for (const kind of MIX_SLOT_ORDER) {
                for (const entry of mixSlotEntries(recipe.slots, kind)) pushFocus(byId.get(entry.materialId));
            }
        }
    }
    const focusBlock = focused.length
        ? `【字段地图 · 用户点名的材料（改片段按这些路径填 field，不必先读全文）】\n${focused.slice(0, 3).map((m) => `◆ [${m.id}]「${m.name}」\n${describeFieldMap(m)}`).join("\n")}`
        : "";

    // 预算分配：头 + 配方映射 + 焦点地图优先保留，材料清单用剩余额度
    const priority = [header, recipeBlock, focusBlock].filter(Boolean).join("\n\n");
    const noteReserve = 80;
    let room = Math.max(0, MIX_SNAPSHOT_BUDGET - priority.length - noteReserve);
    const materialLines: string[] = [];
    let omitted = 0;
    const sorted = [...cabinet].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const material of [...sorted, ...builtins]) {
        const line = `· ${materialHead(material)}`;
        if (line.length + 1 <= room) {
            materialLines.push(line);
            room -= line.length + 1;
        } else {
            omitted += 1;
        }
    }
    const materialBlock = materialLines.length ? `【材料清单】\n${materialLines.join("\n")}` : "";
    const omitNote = omitted > 0 ? `…另有 ${omitted} 件材料未列出，需要时按种类「列出酒柜」查看。` : "";
    const snapshot = [priority, materialBlock, omitNote].filter(Boolean).join("\n\n");
    // 极端情况（配方多到优先段本身就超预算）硬截断兜底，绝不撑爆系统提示词
    return snapshot.length <= MIX_SNAPSHOT_BUDGET ? snapshot : `${snapshot.slice(0, MIX_SNAPSHOT_BUDGET - 20)}\n…（快照超长已截断）`;
}

/** 特调任务上下文段落 = 酒柜快照 + 常驻规格板 + 材料正文常驻板（板为空时只有快照）。引擎每轮注入系统提示词。 */
export function buildMixTaskContext(opts: { focusText?: string }): string {
    const snapshot = buildMixCabinetSnapshot(opts.focusText ?? "");
    const specBoard = buildMixCraftSpecBoardPrompt();
    const materialBoard = buildMixMaterialBoardPrompt();
    const parts = [snapshot];
    if (specBoard) parts.push(specBoard);
    if (materialBoard) parts.push(materialBoard);
    return parts.join("\n\n");
}

// ── 创建 / 更新材料 ──────────────────────────────────

type FieldSpec = { key: string; kinds: MixMaterialKind[] };
/** 各 kind 允许写入的正文字段（元信息 name/hook/tags 全类通用，单独处理） */
const CONTENT_FIELDS: FieldSpec[] = [
    { key: "content", kinds: ["persona", "preface", "base", "flavor", "glass", "strength", "checklist"] },
    // 序言可整套覆写各分段标题（对象 {base:"…",character:"…",…}，留空键用默认）
    { key: "sectionTitles", kinds: ["preface"] },
    { key: "userName", kinds: ["persona"] },
    { key: "baseInfo", kinds: ["character"] },
    { key: "personality", kinds: ["character"] },
    { key: "appearance", kinds: ["character"] },
    { key: "background", kinds: ["character"] },
    { key: "worldview", kinds: ["character"] },
    { key: "cognition", kinds: ["character"] },
    { key: "relations", kinds: ["character"] },
    { key: "plot", kinds: ["character"] },
    { key: "extra", kinds: ["character"] },
    // 一框式资料：profileMode="freeform" 时两段正文各一个字段，上面九个分框字段不再使用
    { key: "profileMode", kinds: ["character"] },
    { key: "profileText", kinds: ["character"] },
    { key: "worldText", kinds: ["character"] },
    { key: "canvas", kinds: ["character"] },
    { key: "openings", kinds: ["character"] },
    { key: "examples", kinds: ["character"] },
    { key: "contract", kinds: ["ticket", "encore"] },
    { key: "renderHtml", kinds: ["ticket", "encore"] },
    { key: "previewRaw", kinds: ["ticket", "encore"] },
    { key: "historyFeed", kinds: ["ticket", "encore"] },
    { key: "vars", kinds: ["ticket"] },
    { key: "css", kinds: ["garnish"] },
    { key: "rules", kinds: ["filter"] },
    { key: "script", kinds: ["mechanism"] },
    { key: "panelHtml", kinds: ["mechanism"] },
    { key: "layout", kinds: ["mechanism"] },
    // 界面要用的连接器名字（字符串数组）；mix.call 只放行声明过的
    { key: "connectors", kinds: ["mechanism"] },
    // 对白按钮（旧写法，仍认）：{icon, title}。新写法是界面代码里 window.mix.dialogueButton({icon,title}) 登记
    { key: "dialogueButton", kinds: ["mechanism"] },
    // 信任模式：代码直接在页面里跑（不进沙盒）
    { key: "trusted", kinds: ["mechanism"] },
];

function normalizeOpenings(value: unknown): string[] | { err: string } {
    if (!Array.isArray(value)) return { err: "openings 必须是字符串数组，每个元素一条开场白。" };
    const list = value.filter((o): o is string => typeof o === "string" && Boolean(o.trim())).map((o) => o.trim());
    return list;
}

function normalizeExamples(value: unknown): { role: "user" | "char"; text: string }[] | { err: string } {
    if (!Array.isArray(value)) return { err: 'examples 必须是数组，元素形如 {"role":"user"|"char","text":"…"}。' };
    const out: { role: "user" | "char"; text: string }[] = [];
    for (const item of value) {
        const role = (item as Record<string, unknown>)?.role;
        const t = (item as Record<string, unknown>)?.text;
        if ((role !== "user" && role !== "char") || typeof t !== "string" || !t.trim()) {
            return { err: 'examples 里有不合法的元素：role 只能是 "user" 或 "char"，text 不能为空。' };
        }
        out.push({ role, text: t.trim() });
    }
    return out;
}

function normalizeVars(value: unknown): MixTicketVar[] | { err: string } {
    if (!Array.isArray(value)) return { err: 'vars 必须是数组，元素形如 {"name":"好感度","initial":"50"}。' };
    const out: MixTicketVar[] = [];
    for (const item of value) {
        const name = text((item as Record<string, unknown>)?.name).trim();
        if (!name) return { err: "vars 里有缺 name 的元素。" };
        const initial = text((item as Record<string, unknown>)?.initial).trim();
        out.push(initial ? { name, initial } : { name });
    }
    return out;
}

function normalizeRules(value: unknown): MixFilterRule[] | { err: string } {
    if (!Array.isArray(value) || value.length === 0) return { err: 'rules 必须是非空数组，元素形如 {"find":"…","replace":"…","mode":"display"|"context"}。' };
    const out: MixFilterRule[] = [];
    for (const [i, item] of value.entries()) {
        const record = item as Record<string, unknown>;
        const find = text(record?.find);
        const mode = record?.mode;
        if (!find.trim()) return { err: `第 ${i + 1} 条规则缺 find。` };
        if (mode !== "display" && mode !== "context") return { err: `第 ${i + 1} 条规则的 mode 必须是 "display"（仅显示）或 "context"（进上下文）。` };
        try {
            new RegExp(find, "g");
        } catch {
            return { err: `第 ${i + 1} 条规则的正则编译失败：${find}（不要带斜杠定界符或反引号）。` };
        }
        out.push({ find, replace: text(record?.replace), mode });
    }
    return out;
}

/** 把工具参数里的正文字段并进材料对象；返回错误信息或 null */
function applyContentFields(target: Record<string, unknown>, kind: MixMaterialKind, args: Record<string, unknown>): string | null {
    for (const spec of CONTENT_FIELDS) {
        if (args[spec.key] === undefined) continue;
        if (!spec.kinds.includes(kind)) {
            return `字段 ${spec.key} 不属于${MIX_KIND_LABELS[kind]}（它属于：${spec.kinds.map((k) => MIX_KIND_LABELS[k]).join("/")}）。`;
        }
        switch (spec.key) {
            case "openings": {
                const r = normalizeOpenings(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.openings = r;
                break;
            }
            case "examples": {
                const r = normalizeExamples(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.examples = r;
                break;
            }
            case "vars": {
                const r = normalizeVars(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.vars = r;
                break;
            }
            case "rules": {
                const r = normalizeRules(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.rules = r;
                break;
            }
            case "layout": {
                const normalized = normalizeMixPanelLayout(args[spec.key]);
                if (!normalized) return 'layout 必须是摆放对象，如 {"slot":"inputbar-left","icon":"🎲","autoHeight":true}。';
                target.layout = normalized;
                break;
            }
            case "trusted": {
                const v = args[spec.key];
                if (v !== true && v !== false) return "trusted 只能是 true（信任模式：代码直接在页面里运行）或 false（沙盒）。";
                if (v) target.trusted = true; else delete target.trusted;
                break;
            }
            case "dialogueButton": {
                const raw = args[spec.key];
                if (raw === null || raw === "" || raw === false) { delete target.dialogueButton; break; }
                const button = normalizeMixDialogueButton(raw);
                if (!button) return 'dialogueButton 必须是 {"icon":"🔊","title":"朗读这句"}（icon 必填，一两个 emoji 或单字）；传 null 取消。';
                target.dialogueButton = button;
                break;
            }
            case "connectors": {
                const names = normalizeMixConnectorNames(args[spec.key]);
                if (Array.isArray(args[spec.key]) && (args[spec.key] as unknown[]).length && !names.length) {
                    return "connectors 必须是名字数组，名字只能用小写字母、数字、-、_（如 [\"tts\"]）。";
                }
                if (names.length) target.connectors = names;
                else delete target.connectors;
                break;
            }
            case "historyFeed": {
                const v = args[spec.key];
                if (v !== "latest" && v !== "all" && v !== "none") return 'historyFeed 只能是 "latest"（只回传最近一轮，默认）、"all"（全部轮次回传）或 "none"（完全不回传）。';
                if (v === "latest") delete target.historyFeed;
                else target.historyFeed = v;
                break;
            }
            case "profileMode": {
                const v = args[spec.key];
                if (v !== "form" && v !== "freeform") return 'profileMode 只能是 "form"（分框填写，默认）或 "freeform"（一框式：角色资料 / 世界与剧情各一段正文）。';
                target.profileMode = v;
                break;
            }
            default: {
                const value = args[spec.key];
                if (typeof value !== "string") return `字段 ${spec.key} 必须是字符串。`;
                target[spec.key] = value;
            }
        }
    }
    if (kind === "character") {
        // 资料模式归一：传了整段正文而没说模式，就视为改用一框式；
        // 一框式的卡再传分框字段会被静默忽略，所以直接拒绝并指路。
        const gaveText = args.profileText !== undefined || args.worldText !== undefined;
        if (gaveText && args.profileMode === undefined && target.profileMode !== "freeform") target.profileMode = "freeform";
        const gaveFields = MIX_CARD_FIELD_KEYS.filter((key) => args[key] !== undefined);
        if (target.profileMode === "freeform" && gaveFields.length) {
            return `这张卡的资料是一框式的，${gaveFields.join("/")} 这些分框字段不会生效。请改传 profileText（角色资料整段）/ worldText（世界与剧情整段），或先传 profileMode:"form" 切回分框再改。`;
        }
        Object.assign(target, normalizeMixCardProfile(target as unknown as MixCharacterCard));
        for (const key of [...MIX_CARD_FIELD_KEYS, "profileMode", "profileText", "worldText"] as const) {
            if (target[key] === undefined) delete target[key];
        }
    }
    return null;
}

/** 封面来源校验：图床/远端 URL 或 dataURL，别的（本地路径、编造的短串）拒收 */
function normalizeCover(value: unknown): string | { err: string } {
    const cover = text(value).trim();
    if (/^https?:\/\//.test(cover) || cover.startsWith("data:image/")) return cover;
    return { err: "cover 必须是 http(s) 图片地址（可用图像处理套件上传图床取得）或 data:image/ 开头的 dataURL。" };
}

/**
 * 质量提示：不拦保存，但把偏薄的地方点出来写进成功返回——
 * 使用指南要求小卷看到质量提示跟进补足，这是防偷懒的软引导侧。
 *
 * 但同一份欠账不能每次回执都重列。2026-10-29 真机日志里那条建特调的任务跑了 40 轮，
 * 十几轮在「读取材料 ↔ 更新材料」之间空转，引信就是这里：每写一笔都回一整版待办清单，
 * 其中「开场画布不足 6000 字符」这种阈值一条动作根本写不满，模型于是永远看到「还没做完」。
 * 现在按材料 id 记台账：同一件材料的同一个检查项只提醒一次，之后闭嘴。
 */
type QualityHint = { key: string; text: string };

const hintedQualityKeys = new Map<string, Set<string>>();

function collectQualityHints(material: Record<string, unknown>, kind: MixMaterialKind): QualityHint[] {
    const contractLen = typeof material.contract === "string" ? material.contract.trim().length : 0;
    if (kind === "ticket") {
        if (contractLen > 0 && contractLen < 300) {
            return [{ key: "contract", text: `输出契约只有 ${contractLen} 字，撑不起有血肉的状态栏——整卡通常 6~10 项、描述项要求带细节的完整句、配一两个长文小节（见制作说明的信息量要求）` }];
        }
        return [];
    }
    if (kind === "encore") {
        if (contractLen > 0 && contractLen < 300) {
            return [{ key: "contract", text: `输出契约只有 ${contractLen} 字——小剧场是玩家等生成时读的加餐，契约要把每轮的内容量逼到微型作品级（成篇的社交帖楼层/完整一幕短剧，十来行两三百字起步，见制作说明），三五行的加演等于没演` }];
        }
        return [];
    }
    if (kind !== "character") return [];

    const hints: QualityHint[] = [];
    const len = (key: string) => (typeof material[key] === "string" ? (material[key] as string).trim().length : 0);
    const openings = Array.isArray(material.openings) ? material.openings.length : 0;
    if (openings < 2) hints.push({ key: "openings.count", text: "开场白只有一条，按规格写 2~3 条不同切入供玩家挑选" });
    if (Array.isArray(material.openings)) {
        const thin = (material.openings as unknown[]).filter((o) => typeof o === "string" && o.trim().length > 0 && o.trim().length < 300).length;
        if (thin > 0) hints.push({ key: "openings.thin", text: `有 ${thin} 条开场白不足 300 字——每条四五百字起步，场景、动作、对白、内心铺成完整一幕，并用正文标记（「」对白、*…*心声、【】场景行）书写` });
    }
    const examples = Array.isArray(material.examples) ? material.examples.length : 0;
    if (examples < 6) hints.push({ key: "examples", text: `示例对话只有 ${Math.floor(examples / 2)} 轮，建议补到 3~5 轮锚定文风` });
    const canvas = len("canvas");
    if (!canvas) hints.push({ key: "canvas.missing", text: "没有开场画布——按「画布制作规格」补一份完整门面页" });
    else if (canvas < 6000) hints.push({ key: "canvas.thin", text: `开场画布只有 ${canvas} 字符，体量不够——画布是一整页好几屏长的门面长页（通常 4~5 个模块，模块内可用折叠/点击交互收纳内容），把每个模块做深做厚，别缩水成一张信息卡` });
    if (material.profileMode === "freeform") {
        // 一框式看整段：两段各自的体量约等于分框时四五个框的总和
        for (const [key, label] of [["profileText", "角色资料"], ["worldText", "世界与剧情"]] as const) {
            if (len(key) === 0) hints.push({ key: `freeform.${key}.empty`, text: `${label}还空着` });
            else if (len(key) < 240) hints.push({ key: `freeform.${key}.thin`, text: `${label}偏薄（${len(key)} 字），用 ## 小节分开写性格/背景/世界观/关系等，各自用具体细节撑起来` });
        }
    } else {
        for (const [key, label] of [["personality", "性格"], ["background", "背景"], ["worldview", "世界观"], ["relations", "关系与身份"]] as const) {
            if (len(key) === 0) hints.push({ key: `field.${key}.empty`, text: `${label}还空着` });
            else if (len(key) < 60) hints.push({ key: `field.${key}.thin`, text: `${label}偏薄（${len(key)} 字），用具体行为细节撑起来` });
        }
    }
    return hints;
}

/** 取这一件材料**还没提醒过**的欠账；一条都不剩就返回空串 */
function qualityHints(material: Record<string, unknown>, kind: MixMaterialKind, id: string): string {
    const materialId = String(id || "").trim();
    if (!materialId) return "";
    const seen = hintedQualityKeys.get(materialId) ?? new Set<string>();
    const fresh = collectQualityHints(material, kind).filter((hint) => !seen.has(hint.key));
    if (!fresh.length) return "";
    for (const hint of fresh) seen.add(hint.key);
    // 会话内的台账只用来防重复提示，别让长会话无限攒材料 id
    if (hintedQualityKeys.size > 300) hintedQualityKeys.clear();
    hintedQualityKeys.set(materialId, seen);
    return `\n质量提示（同一项只提醒一次，之后不再重复列出；要不要补由你和宝定，不是收工前必须清完的清单）：\n- ${fresh.map((hint) => hint.text).join("\n- ")}`;
}

/** 成品校验：与导入器/编辑器同口径，缺什么说什么 */
function validateMaterial(material: Record<string, unknown>, kind: MixMaterialKind): string | null {
    const has = (key: string) => typeof material[key] === "string" && (material[key] as string).trim().length > 0;
    switch (kind) {
        case "character":
            if (!Array.isArray(material.openings) || material.openings.length === 0) return "角色卡至少要有一条开场白（openings），否则开不了局。";
            return null;
        case "persona": case "preface": case "base": case "flavor": case "glass": case "strength": case "checklist":
            if (!has("content")) return `${MIX_KIND_LABELS[kind]}缺正文（content）。`;
            return null;
        case "ticket":
            if (!has("contract")) return "小票缺输出契约（contract）。";
            if (!has("renderHtml")) return "小票缺渲染代码（renderHtml）。";
            return null;
        case "garnish":
            if (!has("css")) return "外观缺 CSS（css）。";
            return null;
        case "encore":
            if (!has("renderHtml")) return "尾调缺渲染代码（renderHtml）。";
            return null;
        case "filter":
            if (!Array.isArray(material.rules) || material.rules.length === 0) return "滤网至少要有一条规则（rules）。";
            return null;
        case "mechanism":
            if (material.trusted === true && !has("script")) return "信任模式的机括必须有 script（代码在页面里执行，用 mix.slot / mix.on 登记坑位与钩子）。";
            if (!has("script") && !has("panelHtml")) return "机括的钩子逻辑（script）与界面代码（panelHtml）至少要写一样。";
            return null;
    }
}

export function mixToolCreateMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "创建材料";
    const kind = asKind(args.kind);
    if (!kind) return { name: NAME, success: false, error: `请传材料种类 kind。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    const name = text(args.name).trim();
    if (!name) return { name: NAME, success: false, error: "请传材料名 name。" };

    // 防重：同类同名先拦下来，把已有 id 交回去。真机日志里「建完再建一遍同名」是空转的主要来源
    // ——同名件一多，后面按名字读还会撞上「重名歧义」，于是更确信自己没建过，继续建。
    const inThisTask = findInMascotTaskLedger({ scope: "mixmat", kind, name });
    if (inThisTask) {
        return { name: NAME, success: false, error: describeMascotNameConflict({ label: MIX_KIND_LABELS[kind], name, id: inThisTask.id, updateTool: "更新材料", where: "本轮" }) };
    }
    const ownSameName = loadMixCabinet().find((m) => m.kind === kind && m.name === name && !m.imported);
    if (ownSameName) {
        return { name: NAME, success: false, error: describeMascotNameConflict({ label: MIX_KIND_LABELS[kind], name, id: ownSameName.id, updateTool: "更新材料" }) };
    }
    // 官方同名件与导入的他人作品不拦：那是「参考着另建一件」的正常用法，只在回执里提醒 id 更靠谱

    const now = Date.now();
    const material: Record<string, unknown> = { id: createMixId("mixmat"), kind, name, createdAt: now, updatedAt: now };
    if (kind === "character") {
        material.charName = text(args.charName).trim() || name;
        material.openings = [];
    }
    const hook = text(args.hook).trim();
    if (hook) material.hook = hook;
    const tags = normalizeMixTags(args.tags);
    if (tags.length) material.tags = tags;
    if (args.cover !== undefined) {
        // 封面只有角色卡收：其余种类的列表封面由渲染效果自动生成，不落库、也不上传
        if (kind !== "character") return { name: NAME, success: false, error: "只有角色卡需要 cover——小票/装饰/尾调的列表封面由渲染效果自动生成，不接受封面图。" };
        const cover = normalizeCover(args.cover);
        if (typeof cover !== "string") return { name: NAME, success: false, error: cover.err };
        material.cover = cover;
    }

    const fieldErr = applyContentFields(material, kind, args);
    if (fieldErr) return { name: NAME, success: false, error: fieldErr };
    const invalid = validateMaterial(material, kind);
    if (invalid) return { name: NAME, success: false, error: invalid };

    saveMixMaterial(material as unknown as MixMaterial);
    broadcastCabinetUpdated();
    recordMascotTaskLedger({ scope: "mixmat", kind, id: String(material.id), name, label: `${MIX_KIND_LABELS[kind]}「${name}」` });
    // 新建的材料正文 pin 进常驻板：接着改不用再读
    pinMixMaterial(String(material.id), kind, name, describeMaterial(material as unknown as MixMaterial));
    // 官方同名件与导入的他人作品不拦，但必须提醒：以后按名字找会歧义
    const twin = [...listMixBuiltins(kind), ...loadMixCabinet()].find((m) => m.kind === kind && m.name === name && m.id !== material.id);
    const twinNote = twin ? `（注意：酒柜里另有一件同名${MIX_KIND_LABELS[kind]}，id: ${twin.id}${isMixBuiltinId(twin.id) ? "，官方件不可改" : ""}——以后一律带 id 操作。）` : "";
    return {
        name: NAME, success: true,
        data: `已把${MIX_KIND_LABELS[kind]}「${name}」放进酒柜（id: ${material.id}）。${twinNote}照这个 id 接着改就行，不用回读、不用列酒柜。（正文已常驻本轮系统提示词）${ledgerDigest()}${qualityHints(material, kind, String(material.id))}`,
    };
}

/** 把字段值格式化为人可读的短文本，用于变更明细的 old→new 展示 */
function formatDiffValue(value: unknown): string {
    if (value === undefined || value === null) return "（空）";
    if (typeof value === "boolean") return value ? "是" : "否";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return "（空）";
        return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return "（空数组）";
        const joined = value.map(v => typeof v === "string" ? v : JSON.stringify(v)).join("、");
        return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
    }
    // 对象：JSON 序列化后截断
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

export function mixToolUpdateMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "更新材料";
    const r = findMaterial(args);
    if (!r.ok) return { name: NAME, success: false, error: r.err };
    const existing = r.ok;
    if (isMixBuiltinId(existing.id)) return { name: NAME, success: false, error: "官方出厂件不可修改。可以参考它另建一件新材料。" };
    if (existing.imported) return { name: NAME, success: false, error: "入柜导入的他人作品不可修改（与酒柜界面同规矩）。可以另建一件自己的材料。" };
    if (args.kind !== undefined && asKind(args.kind) !== existing.kind) {
        return { name: NAME, success: false, error: `材料种类不能改（这件是${MIX_KIND_LABELS[existing.kind]}）。要换类请另建。` };
    }

    const next: Record<string, unknown> = { ...existing };
    const changed: string[] = [];
    const newName = text(args.name).trim();
    if (newName && newName !== existing.name) {
        next.name = newName;
        if (existing.kind === "character") next.charName = text(args.charName).trim() || newName;
        changed.push("name");
    } else if (existing.kind === "character" && text(args.charName).trim()) {
        next.charName = text(args.charName).trim();
        changed.push("charName");
    }
    if (args.hook !== undefined) { next.hook = text(args.hook).trim(); changed.push("hook"); }
    if (args.tags !== undefined) { next.tags = normalizeMixTags(args.tags); changed.push("tags"); }
    if (args.cover !== undefined) {
        if (existing.kind !== "character") return { name: NAME, success: false, error: "只有角色卡需要 cover——小票/装饰/尾调的列表封面由渲染效果自动生成，不接受封面图。" };
        const cover = normalizeCover(args.cover);
        if (typeof cover !== "string") return { name: NAME, success: false, error: cover.err };
        next.cover = cover;
        changed.push("cover");
    }

    const before = JSON.stringify(next);
    const fieldErr = applyContentFields(next, existing.kind, args);
    if (fieldErr) return { name: NAME, success: false, error: fieldErr };
    for (const spec of CONTENT_FIELDS) {
        if (args[spec.key] !== undefined && spec.kinds.includes(existing.kind)) changed.push(spec.key);
    }
    if (!changed.length && before === JSON.stringify(next)) {
        return { name: NAME, success: false, error: "没有传任何要修改的字段。" };
    }
    const invalid = validateMaterial(next, existing.kind);
    if (invalid) return { name: NAME, success: false, error: invalid };

    saveMixMaterial(next as unknown as MixMaterial);
    broadcastCabinetUpdated();
    recordMascotTaskLedger({ scope: "mixmat", kind: existing.kind, id: String(existing.id), name: String(next.name), label: `${MIX_KIND_LABELS[existing.kind]}「${next.name}」` });
    // 更新后的材料正文 pin 进常驻板（续期或新增）：接着改不用再读
    pinMixMaterial(existing.id, existing.kind, String(next.name), describeMaterial(next as unknown as MixMaterial));

    // 构建具体变更明细：旧值→新值，让用户展开工具卡片就能看到改了什么
    const uniqueChanged = [...new Set(changed)];
    const diffLines: string[] = [];
    for (const key of uniqueChanged) {
        const oldVal = (existing as Record<string, unknown>)[key];
        const newVal = next[key];
        if (key === "cover") {
            diffLines.push(`· cover：已更换封面图`);
        } else {
            diffLines.push(`· ${key}：${formatDiffValue(oldVal)} → ${formatDiffValue(newVal)}`);
        }
    }
    const diffText = diffLines.length ? `\n${diffLines.join("\n")}` : "";
    return { name: NAME, success: true, data: `已更新${MIX_KIND_LABELS[existing.kind]}「${next.name}」的：${uniqueChanged.join("、")}。${diffText}（正文已常驻本轮系统提示词）${ledgerDigest()}${qualityHints(next, existing.kind, String(existing.id))}` };
}

// ── 定点片段编辑 ─────────────────────────────────────
// 一次调用可以带多条 edits，全部在内存副本上跑通才落盘（原子提交）：中途模型断联或
// 第 N 条写错，不会留下「改了一半的材料」。回执只给变更摘要 + 字段地图，不回全文。

type PatchEdit = {
    field?: unknown; find?: unknown; replace?: unknown; all?: unknown;
    append?: unknown; prepend?: unknown; sep?: unknown;
    insertAfter?: unknown; insertBefore?: unknown; text?: unknown;
    content?: unknown;
};

function patchOperation(edit: PatchEdit): string | null {
    const ops = ["find", "insertAfter", "insertBefore", "append", "prepend", "content"]
        .filter((key) => edit[key as keyof PatchEdit] !== undefined);
    if (ops.length === 0) return "没有指定操作（find / append / prepend / insertAfter / insertBefore / content 任选一种）";
    if (ops.length > 1) return `一次只能做一种操作，你同时给了：${ops.join("、")}`;
    return null;
}

export function mixToolPatchMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "改材料片段";
    const r = findMaterial(args);
    if (!r.ok) return { name: NAME, success: false, error: r.err };
    const existing = r.ok;
    if (isMixBuiltinId(existing.id)) return { name: NAME, success: false, error: "官方出厂件不可修改。可以参考它另建一件新材料。" };
    if (existing.imported) return { name: NAME, success: false, error: "入柜导入的他人作品不可修改（与酒柜界面同规矩）。可以另建一件自己的材料。" };
    if (isSealed(existing)) return { name: NAME, success: false, error: "导入的他人角色卡正文封存，不可修改。" };

    // 兼容单条写法：直接把 field/find/... 放在参数里；批量写法用 edits:[…]
    const rawEdits: unknown[] = Array.isArray(args.edits)
        ? args.edits as unknown[]
        : (args.field !== undefined ? [args] : []);
    if (!rawEdits.length) {
        return { name: NAME, success: false, error: "请传 edits 数组（或单条的 field + 一个操作）。改完不需要回读确认。" };
    }
    if (rawEdits.length > 20) return { name: NAME, success: false, error: "一次最多 20 条 edits；多的拆成下一次调用。" };

    const kind = existing.kind;
    const fieldMap = describeFieldMap(existing);
    // 深拷贝：绝不能就地改到存储层的缓存对象，万一校验失败就脏了内存里的原件
    const next = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
    const summary: string[] = [];

    for (const [index, raw] of rawEdits.entries()) {
        const edit = (raw && typeof raw === "object" ? raw : {}) as PatchEdit;
        const prefix = `第 ${index + 1} 条`;
        const opError = patchOperation(edit);
        if (opError) return { name: NAME, success: false, error: `${prefix}：${opError}。\n字段地图：\n${fieldMap}` };
        const path = parseFieldPath(edit.field);
        if (!path || !fieldSpecFor(kind, path.top)) {
            return { name: NAME, success: false, error: `${prefix}：field「${String(edit.field ?? "")}」不是这件${MIX_KIND_LABELS[kind]}可编辑的字段。\n字段地图：\n${fieldMap}` };
        }
        const current = readAtPath(next, path);
        const before = typeof current === "string" ? current : "";
        const canStartEmpty = edit.append !== undefined || edit.prepend !== undefined || edit.content !== undefined;
        if (typeof current !== "string" && !canStartEmpty) {
            return { name: NAME, success: false, error: `${prefix}：${path.label} 不是文本字段（或路径不存在）。只有 append / prepend / content 能往空字段里写。\n字段地图：\n${fieldMap}` };
        }

        let after = before;
        let opLabel = "";
        if (edit.find !== undefined) {
            const find = text(edit.find);
            const replace = text(edit.replace);
            if (!find) return { name: NAME, success: false, error: `${prefix}：find 不能为空。` };
            const count = before.split(find).length - 1;
            if (count === 0) {
                return {
                    name: NAME, success: false,
                    error: `${prefix}：在 ${path.label} 里找不到 find 片段（空格、换行、标点要完全一致）。${excerptAround(before, find)}\n改法：抄上面原文里的一小段做 find，或改用 append 追加，别重读整篇。`,
                };
            }
            if (count > 1 && edit.all !== true) {
                return { name: NAME, success: false, error: `${prefix}：find 匹配了 ${count} 处。加长片段让它唯一，或传 all:true 全部替换。` };
            }
            after = edit.all === true ? before.split(find).join(replace) : before.replace(find, replace);
            opLabel = `替换 ${edit.all === true ? count : 1} 处`;
        } else if (edit.insertAfter !== undefined || edit.insertBefore !== undefined) {
            const anchor = text(edit.insertAfter !== undefined ? edit.insertAfter : edit.insertBefore);
            const inserted = text(edit.text);
            if (!anchor) return { name: NAME, success: false, error: `${prefix}：锚点不能为空。` };
            const at = before.indexOf(anchor);
            if (at < 0) {
                return { name: NAME, success: false, error: `${prefix}：在 ${path.label} 里找不到锚点。${excerptAround(before, anchor)}` };
            }
            const pos = edit.insertAfter !== undefined ? at + anchor.length : at;
            after = before.slice(0, pos) + inserted + before.slice(pos);
            opLabel = edit.insertAfter !== undefined ? "锚点后插入" : "锚点前插入";
        } else if (edit.append !== undefined) {
            const sep = typeof edit.sep === "string" ? edit.sep : "\n";
            const chunk = text(edit.append);
            after = before ? before + sep + chunk : chunk;
            opLabel = "分段追加";
        } else if (edit.prepend !== undefined) {
            const sep = typeof edit.sep === "string" ? edit.sep : "\n";
            const chunk = text(edit.prepend);
            after = before ? chunk + sep + before : chunk;
            opLabel = "开头插入";
        } else {
            after = text(edit.content);
            opLabel = "整段覆写";
        }

        if (!writeAtPath(next, path, after)) {
            return { name: NAME, success: false, error: `${prefix}：写不进 ${path.label}（数组下标越界或路径不存在）。\n字段地图：\n${fieldMap}` };
        }
        summary.push(`· ${path.label}：${before.length} → ${after.length} 字（${opLabel}）`);
    }

    if (kind === "character") {
        Object.assign(next, normalizeMixCardProfile(next as unknown as MixCharacterCard));
        for (const key of [...MIX_CARD_FIELD_KEYS, "profileMode", "profileText", "worldText"] as const) {
            if (next[key] === undefined) delete next[key];
        }
    }
    const invalid = validateMaterial(next, kind);
    if (invalid) return { name: NAME, success: false, error: `这批改动会让材料不合格：${invalid}（整批已撤销，一件都没写）。` };

    next.updatedAt = Date.now();
    saveMixMaterial(next as unknown as MixMaterial);
    broadcastCabinetUpdated();
    recordMascotTaskLedger({ scope: "mixmat", kind, id: String(existing.id), name: String(next.name), label: `${MIX_KIND_LABELS[kind]}「${next.name}」` });
    // 定点修改后的材料正文 pin 进常驻板（续期或新增）：接着改不用再读
    pinMixMaterial(existing.id, kind, String(next.name), describeMaterial(next as unknown as MixMaterial));
    return {
        name: NAME, success: true,
        data: `已定点修改 ${materialHead(existing)} 的 ${summary.length} 处（原子提交，全部校验通过才落盘）：\n${summary.join("\n")}\n字段地图（改完直接照它接着改，不用回读全文）：\n${describeFieldMap(next as unknown as MixMaterial)}（正文已常驻本轮系统提示词）${ledgerDigest()}${qualityHints(next, kind, String(existing.id))}`,
    };
}

// ── 批量建副本 ───────────────────────────────────────
// 建一整套特调以前要「读规格 → 建材料 → 列酒柜 → 再建」来回十几轮，模型还记不住
// 已经建过哪些、id 是什么。这里一次调用批量建一批材料；finish:true 时按本轮台账
// 自动装槽并保存配方，模型完全不用记 id、不用扫酒柜。正文太长就分批 append 补，
// 每批照常落盘，中途断联也不会把已建好的部分弄丢。

/** 每杯副本各自攒的材料 id；finish 时只装自己这杯的，不误收本轮顺手建的别的东西 */
const recipeDrafts = new Map<string, string[]>();

export function mixToolBuildRecipe(args: Record<string, unknown>): ToolResult {
    const NAME = "新建副本";
    const recipeName = text(args.name).trim();
    if (!recipeName) return { name: NAME, success: false, error: "请传特调名 name。" };
    const materials = Array.isArray(args.materials) ? args.materials as unknown[] : [];
    const finish = args.finish === true;
    if (!materials.length && !finish) {
        return { name: NAME, success: false, error: '请传 materials 数组，元素形如 {"kind":"base","name":"…","content":"…"}。一次可带多件；长正文之后用「改材料片段」的 append 分批补。' };
    }

    const created: string[] = [];
    const failures: string[] = [];
    for (const [index, raw] of materials.entries()) {
        const one = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const result = mixToolCreateMaterial(one);
        if (!result.success) {
            failures.push(`第 ${index + 1} 件「${String(one.name ?? "")}」：${result.error}`);
            continue;
        }
        const kind = text(one.kind).trim();
        const entry = findInMascotTaskLedger({ scope: "mixmat", kind, name: text(one.name).trim() });
        created.push(`${kind}「${text(one.name).trim()}」→ ${entry?.id ?? "（见创建回执）"}`);
        if (entry?.id) {
            const draft = recipeDrafts.get(recipeName) ?? [];
            if (!draft.includes(entry.id)) draft.push(entry.id);
            if (recipeDrafts.size > 50) {
                const oldest = recipeDrafts.keys().next().value;
                if (oldest) recipeDrafts.delete(oldest);
            }
            recipeDrafts.set(recipeName, draft);
        }
    }

    const lines: string[] = [`本批新建 ${created.length} 件${failures.length ? `，${failures.length} 件没建成` : ""}。`];
    if (created.length) lines.push(...created.map((line) => `· ${line}`));
    if (failures.length) lines.push(...failures.map((line) => `✗ ${line}`));
    lines.push(ledgerDigest().trim() || "【本轮材料台账】还是空的");

    if (!finish) {
        lines.push(`配方「${recipeName}」还没收尾：继续补正文（长文本用「改材料片段」的 append 分几轮写），材料齐了再调一次「新建副本」带 name + finish:true 自动装槽成杯。同名材料再建会被拒并把已有 id 还给你，重试是安全的。`);
        return { name: NAME, success: true, data: lines.join("\n") };
    }

    // 只装这杯副本攒下的材料；没走过批量工具（一路用「创建材料」单件建的）才退回本轮台账
    const byKind = new Map<string, string[]>();
    const add = (kind: string, id: string) => {
        const ids = byKind.get(kind) ?? [];
        if (!ids.includes(id)) ids.push(id);
        byKind.set(kind, ids);
    };
    const draftIds = recipeDrafts.get(recipeName) ?? [];
    if (draftIds.length) {
        for (const id of draftIds) {
            const material = getMixMaterial(id);
            if (material) add(material.kind, id);
        }
    } else {
        for (const entry of listMascotTaskLedger("mixmat")) {
            if (entry.kind) add(entry.kind, entry.id);
        }
    }
    // 单件类各 1 件，其余每类最多 3 件
    const slots: { kind: string; material: string }[] = [];
    for (const kind of MIX_SLOT_ORDER) {
        const ids = byKind.get(kind) ?? [];
        const limit = SINGLE_KINDS.includes(kind) ? 1 : 3;
        for (const id of ids.slice(0, limit)) slots.push({ kind, material: id });
    }
    const recipe = mixToolSaveRecipe({ name: recipeName, slots });
    if (!recipe.success) {
        lines.push(`自动装槽没成：${recipe.error}。材料都已入柜，补上缺的那类后带 finish:true 再收一次尾即可。`);
        return { name: NAME, success: true, data: lines.join("\n") };
    }
    lines.push(`已自动装槽并保存配方：${recipe.data}`);
    recipeDrafts.delete(recipeName);
    return { name: NAME, success: true, data: lines.join("\n") };
}

// ── 保存配方 ─────────────────────────────────────────

const SINGLE_KINDS: MixMaterialKind[] = ["character", "persona", "preface"];

export function mixToolSaveRecipe(args: Record<string, unknown>): ToolResult {
    const NAME = "保存配方";
    const name = text(args.name).trim();
    if (!name) return { name: NAME, success: false, error: "请给这杯特调起个名（name）。" };
    const slotsArg = args.slots;
    if (!Array.isArray(slotsArg) || slotsArg.length === 0) {
        return { name: NAME, success: false, error: 'slots 必须是非空数组，元素形如 {"kind":"character","material":"材料名或id","when":{…可选生效条件}}。' };
    }

    const slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
    const picked: string[] = [];
    for (const [i, item] of slotsArg.entries()) {
        const record = item as Record<string, unknown>;
        const kind = asKind(record?.kind);
        if (!kind) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位的 kind 不合法。可选：${MIX_SLOT_ORDER.join(" / ")}` };
        const ref = text(record?.material).trim();
        if (!ref) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位缺 material（材料名或 id）。` };
        const found = findMaterial({ id: ref, name: ref });
        const material = found.ok ?? findMaterial({ name: ref }).ok;
        if (!material) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位：${found.err ?? `找不到「${ref}」`}` };
        if (material.kind !== kind) {
            return { name: NAME, success: false, error: `第 ${i + 1} 个槽位：「${material.name}」是${MIX_KIND_LABELS[material.kind]}，不是${MIX_KIND_LABELS[kind]}。` };
        }
        const entries = slots[kind] ?? (slots[kind] = []);
        if (SINGLE_KINDS.includes(kind) && entries.length >= 1) {
            return { name: NAME, success: false, error: `${MIX_KIND_LABELS[kind]}槽位只放 1 件。` };
        }
        const entry: MixSlotEntry = { materialId: material.id };
        if (record?.when !== undefined && !SINGLE_KINDS.includes(kind)) {
            const when = normalizePartCondition(record.when);
            if (!when) {
                return { name: NAME, success: false, error: `第 ${i + 1} 个槽位的生效条件不合法。支持：{"type":"turn","after":N} / {"type":"var","name":"…","op":">=","value":"…"} / {"type":"keyword","words":["…"],"within":N} / {"type":"chance","percent":N}。` };
            }
            entry.when = when as MixCondition;
        }
        entries.push(entry);
        picked.push(`${MIX_KIND_LABELS[kind]}「${material.name}」`);
    }
    if (!slots.character?.length) return { name: NAME, success: false, error: "配方必须有一张角色卡，否则开不了局。" };

    const existing = loadMixRecipes().find((r) => r.name === name && !r.imported);
    const now = Date.now();
    const recipeId = String(existing?.id ?? createMixId("mixrec"));
    saveMixRecipe({
        ...(existing ?? { id: recipeId, createdAt: now, updatedAt: now }),
        name,
        slots,
        imported: undefined,
    });
    broadcastCabinetUpdated();
    recordMascotTaskLedger({ scope: "recipe", id: recipeId, name, label: `特调「${name}」` });
    return {
        name: NAME, success: true,
        data: `${existing
            ? `「${name}」这杯已经调过一回了，这次是覆盖更新（id: ${recipeId}）`
            : `已调好特调「${name}」（id: ${recipeId}）`}：${picked.join(" + ")}。用户在独家特调 App 的吧台就能选它开局。`,
    };
}

// ── 工作副本装配 ───────────────────────────────────
// 整套工作副本机制：一次性读取配方里所有材料到常驻板，供模型参考。
// 修改还是通过现有工具（改材料片段、更新材料）实时写回，这些工具已经自动更新板。
// 这样避免了"解析结构化文本回字段"的复杂问题。

/**
 * 装配工作副本：把指定配方（或酒柜全部）的所有材料一次性加载到常驻板。
 * 所有正文常驻本轮系统提示词，模型可以直接参考。
 * 修改通过现有工具（改材料片段、更新材料）实时写回，这些工具已经自动更新板。
 */
export function mixToolAssembleWorkingCopy(args: Record<string, unknown>): ToolResult {
    const NAME = "装配工作副本";
    const recipeRef = text(args.recipe).trim();

    // 收集要加载的材料 id
    const materialIds: string[] = [];

    if (recipeRef) {
        // 按配方加载：找配方，取所有槽位里的材料 id
        const recipes = loadMixRecipes();
        const recipe = recipes.find((r) => (r.id === recipeRef || r.name === recipeRef) && !r.imported);
        if (!recipe) return { name: NAME, success: false, error: `找不到配方「${recipeRef}」。` };
        for (const kind of MIX_SLOT_ORDER) {
            const entries = recipe.slots[kind] ?? [];
            for (const entry of entries) materialIds.push(entry.materialId);
        }
    } else {
        // 没指定配方：加载酒柜全部（慎用，材料多会撑爆常驻板）
        const cabinet = loadMixCabinet();
        for (const m of cabinet) materialIds.push(m.id);
    }

    if (!materialIds.length) {
        return { name: NAME, success: false, error: "没有材料可加载。" };
    }

    const loaded: string[] = [];
    const missing: string[] = [];
    for (const id of materialIds) {
        const material = getMixMaterial(id);
        if (!material) {
            missing.push(id);
            continue;
        }
        if (isSealed(material)) continue; // 封存的角色卡不回正文，也不 pin
        const content = describeMaterial(material);
        pinMixMaterial(material.id, material.kind, material.name, content);
        loaded.push(`${MIX_KIND_LABELS[material.kind]}「${material.name}」`);
    }

    const loadedSummary = loaded.length ? `已加载 ${loaded.length} 件到常驻板：${loaded.join("、")}` : "没有可加载的材料";
    const missingSummary = missing.length ? `（${missing.length} 件找不到：${missing.join("、")}）` : "";
    return {
        name: NAME, success: true,
        data: `${loadedSummary}${missingSummary}。所有材料正文已常驻本轮系统提示词，可以直接参考。修改用「改材料片段」或「更新材料」，会自动同步到板。`,
    };
}

// ── 连接器 ──────────────────────────────────────────
// 连接器是用户自己的外部接口配置（机括界面用 mix.call 请宿主代调）。
// 小卷可以替用户把连接器建好（预设一键、或自己写地址与模板），但密钥留占位——
// 密钥不该经过对话与模型，用户到酒柜「连接器」里粘上即可。

/** 请求头里的密钥打码：只告诉模型有没有、是不是还留着占位，不回真实值 */
function describeConnectorHeaders(headers: Record<string, string>): string {
    return Object.entries(headers)
        .map(([key, value]) => {
            const secret = /authorization|key|token|secret/i.test(key);
            if (!secret) return `${key}: ${value}`;
            return `${key}: ${value.includes(MIX_CONNECTOR_KEY_PLACEHOLDER) ? "（密钥还是占位，待用户填写）" : "（已填，不显示）"}`;
        })
        .join("；");
}

export function mixToolListConnectors(): ToolResult {
    const NAME = "列出连接器";
    const list = loadMixConnectors();
    const lines: string[] = [];
    lines.push(`本机连接器 ${list.length} 个。`);
    for (const c of list) {
        lines.push(`· ${c.name}${c.note ? `（${c.note}）` : ""} — ${c.method} ${c.url}，响应 ${c.response}${c.preset ? `，预设 ${c.preset}` : ""}`);
        if (Object.keys(c.headers).length) lines.push(`　请求头：${describeConnectorHeaders(c.headers)}`);
    }
    lines.push(`可用预设：${MIX_CONNECTOR_PRESETS.map((p) => `${p.id}（${p.label}）`).join("、")}。`);
    lines.push("官方机括「朗读」需要一个叫 tts 的连接器：装上它，对局里每句对白后面就有一颗喇叭，点一下念这句。");
    return { name: NAME, success: true, data: lines.join("\n") };
}

type HeadersArg = { headers: Record<string, string> } | { err: string };
function normalizeHeadersArg(value: unknown): HeadersArg {
    if (value === undefined) return { headers: {} };
    if (typeof value === "string") return { headers: parseMixConnectorHeaders(value) };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { err: 'headers 必须是对象 {"名字":"值"} 或一行一条「名字: 值」的文本。' };
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const name = key.trim();
        if (!name) continue;
        if (typeof raw !== "string") return { err: `请求头 ${name} 的值必须是字符串。` };
        out[name] = raw;
    }
    return { headers: out };
}

export function mixToolSaveConnector(args: Record<string, unknown>): ToolResult {
    const NAME = "创建连接器";
    const presetId = text(args.preset).trim();
    const preset = presetId ? MIX_CONNECTOR_PRESETS.find((p) => p.id === presetId) : null;
    if (presetId && !preset) {
        return { name: NAME, success: false, error: `没有叫 ${presetId} 的预设。可选：${MIX_CONNECTOR_PRESETS.map((p) => p.id).join(" / ")}` };
    }
    const built = preset?.build();
    const name = (text(args.name).trim() || built?.name || "").toLowerCase();
    if (!MIX_CONNECTOR_NAME_RE.test(name)) {
        return { name: NAME, success: false, error: "name 只能用小写字母、数字、-、_，以字母或数字开头，最长 32 位（如 tts）。" };
    }
    const url = text(args.url).trim() || built?.url || "";
    try {
        const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, "x"));
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad");
    } catch {
        return { name: NAME, success: false, error: "url 要是完整的 http(s) 地址（用预设可不传）。" };
    }
    const headersArg = normalizeHeadersArg(args.headers);
    if ("err" in headersArg) return { name: NAME, success: false, error: headersArg.err };
    const headers = Object.keys(headersArg.headers).length ? headersArg.headers : built?.headers ?? {};
    const method = args.method === "GET" ? "GET" : args.method === "POST" || args.method === undefined ? (built?.method ?? "POST") : null;
    if (!method) return { name: NAME, success: false, error: 'method 只能是 "POST" 或 "GET"。' };
    const response = args.response === undefined ? (built?.response ?? "json") : args.response;
    if (response !== "json" && response !== "text" && response !== "blob") {
        return { name: NAME, success: false, error: 'response 只能是 "json"（解析成对象）、"text" 或 "blob"（二进制转 data: URL）。' };
    }
    const body = args.body === undefined ? (built?.body ?? "") : text(args.body);
    if (method === "POST" && !body.trim() && !preset) {
        return { name: NAME, success: false, error: "POST 连接器需要 body 请求体模板（{{参数名}} 占位，可写 {{参数名|默认值}}）。" };
    }

    const existing = findMixConnector(name);
    if (existing && args.overwrite !== true) {
        return { name: NAME, success: false, error: `已经有叫「${name}」的连接器了。要覆盖请再传 overwrite: true；要保留就换个名字。` };
    }
    const note = text(args.note).trim() || built?.note;
    saveMixConnector({
        id: existing?.id ?? createMixId("mixconn"),
        name,
        note: note || undefined,
        url,
        method,
        headers,
        body,
        response,
        preset: preset?.id ?? existing?.preset,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
    });
    const placeholder = Object.values(headers).some((v) => v.includes(MIX_CONNECTOR_KEY_PLACEHOLDER));
    return {
        name: NAME, success: true,
        data: `连接器「${name}」已${existing ? "更新" : "创建"}（${method} ${url}）。`
            + (placeholder
                ? "\n密钥还是占位：请提醒用户到 独家特调 → 酒柜 → 右上角「连接器」→ 点开这一条，把请求头里的「你的密钥」换成自己的 API Key 并保存（可点「发一次试试」验证）。不要向用户索要密钥，密钥不经过对话。"
                : "\n用户可到 独家特调 → 酒柜 → 「连接器」里查看或试调用。"),
    };
}

export function mixToolDeleteConnector(args: Record<string, unknown>): ToolResult {
    const NAME = "删除连接器";
    const name = text(args.name).trim().toLowerCase();
    const existing = name ? findMixConnector(name) : null;
    if (!existing) return { name: NAME, success: false, error: `本机没有叫「${name || "（空）"}」的连接器。可先用 列出连接器 查看。` };
    deleteMixConnector(existing.id);
    return { name: NAME, success: true, data: `连接器「${name}」已删除。用到它的机括调用时会提示用户重新创建。` };
}
