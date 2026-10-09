// lib/brief-persona.ts
// 简量版人设生成：把角色完整设定压缩成 100~200 字简介，
// 注入到同世界有关系角色的「角色关系」marker 中（见 character-world-storage）。
//
// 与生成配角同理，刻意不走预设系统组装（simpleLLMCall + 代码手动组提示词）：
// 这是结构化压缩任务，用户聊天预设的角色扮演指令/正则会污染输出。
// API 配置沿用角色的聊天绑定（只取 config，不取预设/正则）。
//
// 注意：本模块只负责「生成文本」，不直接写角色存储——角色编辑器把简介当作
// 普通表单字段随 SAVE 持久化，避免与编辑器内存状态互相覆写。

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import type { Character } from "./character-types";

/** 按传入的角色资料（可以是编辑器里未保存的表单态）生成简量人设文本。失败抛错（含用户可读信息）。 */
export async function generateBriefPersonaText(character: Character): Promise<string> {
    if (!character.persona?.trim() && !character.personality?.trim()) {
        throw new Error("角色还没有设定内容，先填写人设再生成简介。");
    }

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, character.id, "chat");
    if (!slot.apiConfigId) throw new Error("尚未绑定 API 配置，请先在绑定设置中配置。");
    const apiConfig = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!apiConfig) throw new Error("绑定的 API 配置不存在。");

    const name = character.name?.trim() || "该角色";
    const systemPrompt = [
        `你是角色档案助手。以下是角色「${name}」的完整设定，请为TA写一段「简量版人设」。`,
        "它会被注入到同一世界观中与TA有关系的其他角色的上下文里，帮助他们在提及、转述或与TA互动时保持TA的人设一致。",
        "",
        `【角色设定】\n${character.persona?.trim() || "（暂无）"}`,
        ...(character.personality?.trim() ? ["", `【性格】\n${character.personality.trim()}`] : []),
        "",
        "要求：",
        "- 第三人称，100~200 字",
        "- 概括：身份背景、性格核心、说话方式与外在气质、与人相处时的显著特征",
        "- 只写别人可感知的信息；不要泄露只有TA自己知道的秘密设定、内心隐情或剧情伏笔",
        "- 只输出简介正文，不要标题、引号或任何额外说明",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请为「${name}」生成简量版人设。` },
        ],
        // 思考模型（gemini-pro/deepseek-reasoner 等）会先烧隐藏思考 token 再写正文，
        // 上限给小了会 finishReason=length 且正文为空——给足余量
        { temperature: 0.6, max_tokens: 8192 },
    );

    if (result.error || !result.content) {
        throw new Error(result.error || "模型返回了空内容，请重试。");
    }
    const brief = result.content.trim();
    if (!brief) throw new Error("模型返回了空内容，请重试。");
    return brief;
}

/** 简介是否可能过期（角色设定在生成简介之后又被编辑过）。 */
export function isBriefPersonaStale(character: Character): boolean {
    if (!character.briefPersona || !character.briefPersonaUpdatedAt) return false;
    if (!character.updatedAt) return false;
    return Date.parse(character.updatedAt) > Date.parse(character.briefPersonaUpdatedAt);
}
