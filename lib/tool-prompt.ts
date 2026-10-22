import type { EnabledTool } from "./tool-storage";
import { MacroEngine, postProcessTrim } from "./macro-engine";

export type ToolSchemaFormatContext = {
    characterName?: string;
    userName?: string;
};

function expandToolMacros(text: string, context?: ToolSchemaFormatContext): string {
    if (!context) return text;
    const engine = new MacroEngine(context.characterName ?? "", context.userName ?? "用户");
    return postProcessTrim(engine.expand(text));
}

/**
 * Format enabled tools as compact list (name + description only, no params).
 * Returns empty string if no tools (TRIM removes the line).
 */
export function formatToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "下面是系统可自动处理的动作类别，只在需要时按格式输出动作指令，不需要时正常聊天即可：",
        "",
        toolList,
        "",
        "使用步骤：",
        "1. 需要系统处理某个动作类别时，先用 [获取指令:动作类别名] 获取可执行动作格式。",
        "2. 获取指令后，用 [执行动作:动作名(参数JSON)] 输出动作指令；不要编造动作，不需要动作时正常聊天即可。*如果上下文中已经获取过某个指令，则不要重复获取，需要时，直接执行前面获取过的指令即可*",
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format enabled tools for GROUP CHAT — includes actor name prefix in format.
 */
export function formatGroupToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "下面是系统可自动处理的动作类别，只在需要时按格式输出动作指令，不需要时正常聊天即可：",
        "",
        toolList,
        "",
        "使用步骤：",
        '1. 需要系统处理某个动作类别时，先用 ["角色名"获取指令:动作类别名] 获取可执行动作格式。',
        '2. 获取指令后，用 ["角色名"执行动作:动作名(参数JSON)] 输出动作指令；必须用引号标注是哪个角色在执行动作，同一次回复中只能有一个角色执行动作。不要编造动作，不需要动作时正常聊天即可。*如果上下文中已经获取过某个指令，则不要重复获取，需要时，直接执行前面获取过的指令即可*',
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format a single action's parameter schema for the "获取指令" response.
 */
export function formatToolSchema(tool: EnabledTool, context?: ToolSchemaFormatContext): string {
    if (tool.usageGuide) return expandToolMacros(tool.usageGuide, context);

    if (tool.source === "rest_package") {
        const lines: string[] = [];
        lines.push(`REST 工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.restTools || tool.restTools.length === 0) {
            lines.push("这个套件里没有已启用的 REST 子工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出套件名称本身。");
        for (const restTool of tool.restTools) {
            lines.push("");
            lines.push(`动作：${restTool.name}`);
            if (restTool.description) lines.push(`描述：${restTool.description}`);
            try {
                const schema = JSON.parse(restTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("参数：");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出 REST 工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "composite_package") {
        const lines: string[] = [];
        lines.push(`组合工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.compositeTools || tool.compositeTools.length === 0) {
            lines.push("这个套件里没有已启用的组合工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体组合工具如下。执行时必须使用具体组合工具名，不要输出套件名称本身。");
        for (const compositeTool of tool.compositeTools) {
            lines.push("");
            lines.push(`动作：${compositeTool.name}`);
            if (compositeTool.description) lines.push(`描述：${compositeTool.description}`);
            try {
                const schema = JSON.parse(compositeTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("参数：");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体组合工具，并使用格式：",
            "[执行动作:具体组合工具名({参数JSON})]",
            "禁止输出组合工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "mcp_server") {
        const lines: string[] = [];
        lines.push(`MCP：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.mcpTools || tool.mcpTools.length === 0) {
            lines.push("这个 MCP 还没有发现到具体动作，请先让用户在设置里点击“发现工具”。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出 MCP 名称本身。");
        for (const mcpTool of tool.mcpTools) {
            lines.push("");
            lines.push(`动作：${mcpTool.name}`);
            if (mcpTool.description) lines.push(`描述：${mcpTool.description}`);
            const schema = mcpTool.inputSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("参数：");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出 MCP 名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "custom_app_package") {
        const lines: string[] = [];
        lines.push(`自定义 APP 工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.customAppTools || tool.customAppTools.length === 0) {
            lines.push("这个 APP 当前没有可执行的子工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出工具套件名称本身。");
        for (const customAppTool of tool.customAppTools) {
            lines.push("");
            lines.push(`动作：${customAppTool.name}`);
            if (customAppTool.description) lines.push(`描述：${customAppTool.description}`);
            const schema = customAppTool.parameterSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("参数：");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    const lines: string[] = [];
    lines.push(`动作：${tool.name}`);
    lines.push(`描述：${tool.description}`);

    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const entries = Object.entries(props);
        if (entries.length > 0) {
            lines.push("参数：");
            for (const [key, val] of entries) {
                const v = val as Record<string, unknown>;
                const type = (v.type as string) || "string";
                const desc = (v.description as string) || "";
                lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
            }
        }
    } catch { /* ignore */ }

    // Build example call with placeholder values
    let exampleArgs = "{}";
    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const example: Record<string, string> = {};
        for (const [key] of Object.entries(props)) {
            example[key] = "...";
        }
        if (Object.keys(example).length > 0) exampleArgs = JSON.stringify(example);
    } catch { /* ignore */ }

    return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}\n请立即使用以下格式输出动作指令（将...替换为实际值）：\n[执行动作:${tool.name}(${exampleArgs})]\n禁止再次使用[获取指令]。不要重复之前说过的内容。!!!执行动作时，直接输出动作指令，禁止输出任何其他内容，包括任何[内心]、状态值、聊天内容、富媒体指令等。忽略chat_output_format里的所有指令，否则系统将出现重大错误`, context);
}
