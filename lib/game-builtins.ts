import { DOUDIZHU_GAME_HTML, TRUTH_OR_DARE_GAME_HTML } from "./game-builtin-html";
import type { GameTemplate } from "./game-types";

const now = "2026-06-06T00:00:00.000Z";

const EMPTY_PICKER_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body></body></html>";

function template(input: Omit<GameTemplate, "playNote" | "authorId" | "authorName" | "authorAvatar" | "source" | "version" | "purchaseCount" | "rating" | "likeCount" | "favoriteCount" | "commentCount" | "createdAt" | "updatedAt"> & Partial<Pick<GameTemplate, "playNote" | "version">>): GameTemplate {
  return {
    ...input,
    playNote: input.playNote || "系统内置小游戏，可直接安装试玩。",
    authorId: "builtin",
    authorName: "系统内置",
    authorAvatar: "",
    source: "builtin",
    version: input.version ?? 1,
    purchaseCount: 0,
    rating: 5,
    likeCount: 0,
    favoriteCount: 0,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export const GAME_BUILTIN_TEMPLATES: GameTemplate[] = [
  template({
    id: "builtin_game_doudizhu",
    title: "欢乐斗地主",
    codeName: "DOUDIZHU",
    subtitle: "AI 角色陪玩的经典牌局",
    synopsis: "选择小手机里的角色一起入座，叫地主、出牌、记牌，在一局斗地主里和角色自然互动。",
    playNote: "内置斗地主小游戏。游戏自带选人页，会读取可选角色、保存牌局进度，并可在关键节点写入小游戏记忆。",
    coverImage: "/game-covers/doudizhu.webp",
    tags: ["休闲", "互动"],
    roleSlots: [],
    pickerHtml: EMPTY_PICKER_HTML,
    gameHtml: DOUDIZHU_GAME_HTML,
    allowExternalControl: true,
  }),
  template({
    id: "builtin_game_truth_or_dare",
    title: "真心话大冒险",
    codeName: "TRUTH_OR_DARE",
    subtitle: "夜色派对问答互动",
    synopsis: "选择几位角色围坐一桌，让真心话和大冒险推动暧昧、玩笑、试探和临场反应。",
    playNote: "内置真心话大冒险小游戏。游戏自带选人页，会调用角色轻量包、生成题目和回应，并可记录本局重要事件。",
    coverImage: "/game-covers/truth-or-dare.webp",
    tags: ["剧情", "互动"],
    roleSlots: [],
    pickerHtml: EMPTY_PICKER_HTML,
    gameHtml: TRUTH_OR_DARE_GAME_HTML,
    allowExternalControl: true,
  }),
];

export function getGameBuiltinTemplate(id: string): GameTemplate | undefined {
  return GAME_BUILTIN_TEMPLATES.find(game => game.id === id);
}
