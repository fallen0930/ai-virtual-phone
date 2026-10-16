export type SettingItemMeta = {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
    updatedAt: number;
};

// --- WorldBook ---
export type WorldBookEntry = {
    uid: string;
    key: string;
    content: string;
    comment: string;
    use_regex: boolean;
    disable: boolean;
    constant: boolean;
    position: "before_char" | "after_char" | "before_em" | "after_em" | "before_an" | "after_an" | number;
    depth?: number;
    probability?: number;
    useProbability?: boolean;
    role?: number;
    insertion_order: number;
};

export type WorldBookConfig = SettingItemMeta & {
    entries: WorldBookEntry[];
};

// --- Preset ---
export type PromptOrderEntry = {
    identifier: string;
    enabled: boolean;
};

export type GenerationParameterKey =
    | "temperature"
    | "top_p"
    | "top_k"
    | "min_p"
    | "top_a"
    | "repetition_penalty"
    | "frequency_penalty"
    | "presence_penalty"
    | "max_tokens";

export type Prompt = {
    identifier: string;
    name: string;
    role: "system" | "user" | "assistant" | string;
    content: string;
    injection_depth: number;
    /** @deprecated Prompt order is determined by prompt_order / array order when depth matches. */
    injection_order?: number;
    enabled: boolean;
    system_prompt?: boolean;
    marker?: boolean;
    forbid_overrides?: boolean;
    injection_position?: number;
    /** @deprecated Use `tags` instead. */
    featureTag?: string;
    /** @deprecated Use `tags: [..., "followup"]` instead. */
    followUpOnly?: boolean;
    /** Multi-tag filtering. Entry is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
};

export type PresetConfig = SettingItemMeta & {
    builtIn?: boolean;
    builtInVersion?: number;
    temperature: number;
    top_p: number;
    top_k: number;
    frequency_penalty: number;
    presence_penalty: number;
    repetition_penalty: number;
    openai_max_tokens: number;
    openai_max_context: number;
    /**
     * Explicit allow-list of generation parameters sent to model providers.
     * Undefined keeps legacy behavior so existing/imported presets remain compatible.
     */
    enabled_generation_parameters?: GenerationParameterKey[];
    top_a?: number;
    min_p?: number;
    wrap_in_quotes?: boolean;
    names_behavior?: number;
    send_if_empty?: string;
    impersonation_prompt?: string;
    new_chat_prompt?: string;
    new_group_chat_prompt?: string;
    new_example_chat_prompt?: string;
    continue_nudge_prompt?: string;
    group_nudge_prompt?: string;
    bias_preset_selected?: string;
    max_context_unlocked?: boolean;
    wi_format?: string;
    scenario_format?: string;
    personality_format?: string;
    story_summary_tag?: string;
    /** 线下/剧情模式的思维链标签名：从模型输出的 XML 里提取思考过程（默认 thinking，兼容 thought）。
     *  仅当 offline_thinking_enabled 开启时才启用标签解析；关闭时走模型原生 reasoning。 */
    thinking_tag?: string;
    /** 线上模式的思维链标签名：从模型输出的 XML 里提取思考过程（默认 thinking）。
     *  仅当 online_thinking_enabled 开启时才启用标签解析；关闭时走模型原生 reasoning。 */
    online_thinking_tag?: string;
    /** 线上模式是否启用思维链标签解析（默认关；关 = 走模型原生 reasoning） */
    online_thinking_enabled?: boolean;
    /** 线下模式是否启用思维链标签解析（默认关；关 = 走模型原生 reasoning） */
    offline_thinking_enabled?: boolean;
    /** 模型回复中直接剔除的文本片段列表（字面量删除，不走正则）：如 <思考结束> 等残留标签，
     *  生成时即删除，不进入消息、不进入发给模型的记录。 */
    strip_texts?: string[];
    prompt_order?: PromptOrderEntry[];
    prompts: Prompt[];
};

// --- Regex ---
// Regex rule config.
export type RegexRule = {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    /** Multi-tag filtering. Rule is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
    trimStrings?: string[];       // Strings to remove from each capture-group match before replacement
    disabled: boolean;
    placement: number[];          // 1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH_COMMAND, 5=WORLD_INFO, 6=REASONING
    markdownOnly?: boolean;       // true → only apply during display rendering (non-destructive)
    promptOnly?: boolean;         // true → only apply during prompt assembly (non-destructive)
    runOnEdit?: boolean;          // true → also apply when user edits an existing message
    historyOnly?: boolean;        // true → only apply to chat history message blocks, never to system prompts/preset/world book
    substituteRegex?: number;     // 0=NONE, 1=RAW macro substitution in findRegex, 2=ESCAPED
    minDepth?: number;            // Minimum message depth (-1 = unlimited)
    maxDepth?: number;            // Maximum message depth
};

export type RegexConfig = SettingItemMeta & {
    builtIn?: boolean;
    rules: RegexRule[];
};

// --- ApiConfig (migrated from api-settings.tsx) ---

/**
 * API 计价方式（单价由用户手写，本项目不做任何价格推断）：
 * - per_call      按次：每调用一次扣 amount
 * - per_1k_tokens 按量：每 1K token 扣 amount
 * - manual        仅参考：记一笔时只把 amount 当默认值带出来，实际金额由用户填
 */
export type ApiPricingMode = "per_call" | "per_1k_tokens" | "manual";

export type ApiPricing = {
    mode: ApiPricingMode;
    /** 单价（额度）：per_call 为每次；per_1k_tokens 为每 1K token；manual 为参考值 */
    amount: number;
};

export type ApiConfig = {
    id: string;
    name?: string;
    /** 所属 API 文件夹 id；为空表示「未分组」 */
    groupId?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
    enableNativeTools?: boolean;
    enableImageRecognition: boolean;
    enableImageGeneration: boolean;
    preventEmptyGenerateRambling?: boolean;
    /** 是否启用流式调用（默认 true；关闭后所有使用该配置的会话一律走非流式请求） */
    enableStreaming?: boolean;
    /** 手动填写的计价信息，用于「记一笔」时自动算钱 */
    pricing?: ApiPricing;
};

// --- ApiGroup：API 文件夹，用于把同一站点的多个配置收纳在一起 ---
export type ApiGroup = {
    id: string;
    name: string;
    /** 在列表里是否折叠（快捷菜单与设置页共用同一状态） */
    collapsed?: boolean;
    createdAt?: number;
};

// --- ApiAccount：一个 API 文件夹就是一本账（余额由用户手动维护） ---
export type ApiAccount = {
    /** 与 ApiConfig.groupId 对应；空串 = 未分组账户。删文件夹不会删账户，账目保留 */
    id: string;
    /** 剩余额度 */
    balance: number;
    /** 低额度提醒阈值（额度）；<=0 或缺省表示不提醒 */
    lowThreshold?: number;
    note?: string;
    /** 调用成功后按单价自动扣费（默认 true；关掉后只能用「记一笔」手动扣） */
    autoCharge?: boolean;
    /**
     * 自动扣费的记账口径：
     * - `per_call`（默认）：**每一次真实调用各记一笔** —— 账本最贴近中转站的真实消耗；
     * - `per_task`：一次任务（如卷宝一次 agent loop 内的多轮调用）只扣一次单价 ——
     *   这是把单价当「任务包价」用，账本会比真实消耗宽松，需要自己清楚这一点。
     */
    billingMode?: "per_call" | "per_task";
    updatedAt?: number;
};

export type ApiLedgerKind = "spend" | "topup" | "set";

/** 账目流水：一次扣费 / 一笔充值 / 一次手动改余额 */
export type ApiLedgerEntry = {
    id: string;
    /** 所属账户（= 文件夹 id，空串表示未分组账户） */
    accountId: string;
    /** 关联的 API 配置 */
    configId?: string;
    configName?: string;
    kind: ApiLedgerKind;
    /** 变动额度（恒为正数；kind 决定方向） */
    amount: number;
    /** 变动后的余额快照 */
    balanceAfter: number;
    note?: string;
    createdAt: number;
};

// --- VoiceApiConfig (migrated from voice-settings.tsx) ---
export type VoiceApiConfig = {
    id: string;
    name?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    region?: string;
    model?: string;
    sttModel?: string;
    defaultVoice: string;
    languageBoost?: string;
    /** Minimax voice_setting.speed. Missing values keep the legacy 1.0x behavior. */
    speechSpeed?: number;
    /** Minimax voice_setting.pitch（半音，±12）。缺省保持旧行为（0，原声）。 */
    speechPitch?: number;
    customVoices?: { id: string; name: string; createdAt?: number }[];
    enableSTT: boolean;
    enableTTS: boolean;
};

// --- Image Generation ---
export type ImageGenerationProvider = "openai" | "novelai";

export type ImageGenerationRequestMode = "server" | "direct";

export type OpenAiImagePreset = {
    id: string;
    name: string;
    requestMode: ImageGenerationRequestMode;
    apiKey: string;
    baseUrl: string;
    model: string;
    size: string;
    quality: string;
    extraPrompt: string;
};

export type ImageHostingProvider = "none" | "imgbb";

export type ImageHostingSettings = {
    provider: ImageHostingProvider;
    imgbbApiKey: string;
    defaultExpirationSeconds: number;
    maxUploadBytes: number;
    autoConvertToWebp: boolean;
    allowMascotUpload: boolean;
};

export type NovelAiPreset = {
    id: string;
    name: string;
    model: string;
    resolution: string; // e.g. "832x1216", "1216x832", "1024x1024", "1024x1536"
    steps: number;
    scale: number;
    sampler: string; // e.g. "k_euler", "k_dpmpp_2m", "k_euler_ancestral"
    noiseSchedule?: string; // e.g. "karras", "native", "exponential"
    positivePrompt: string; // 画师串 / 风格 / 质量正向词
    negativePrompt: string; // 负面提示词 / undesired content
    qualityToggle?: boolean;
    smea?: boolean;
    smeaDyn?: boolean;
};

export type NovelAiSettings = {
    apiKey: string;
    activePresetId: string;
    presets: NovelAiPreset[];
};

export type ImageGenerationSettings = {
    enabled: boolean;
    provider?: ImageGenerationProvider;
    requestMode: ImageGenerationRequestMode;
    // OpenAI 模式配置（旧字段保留用于兼容迁移）
    apiKey: string;
    baseUrl: string;
    model: string;
    size: string;
    quality: string;
    extraPrompt: string;
    openaiPresets?: OpenAiImagePreset[];
    activeOpenAiPresetId?: string;
    // NovelAI 模式配置
    novelai?: NovelAiSettings;
    characterReferences: Record<string, {
        assetId: string;
        updatedAt: number;
    }>;
    imageHosting: ImageHostingSettings;
};

// --- Configuration Binding System ---

// Content apps that can have per-character bindings.
export type ContentAppId =
    | "chat" | "diary" | "music" | "reading"
    | "forum" | "cocreate" | "story" | "game" | "xiaohongshu" | "dwelling"
    | "checkphone" | "shopping" | "calendar" | "interview_magazine"
    | "moments" | "group_chat" | "vn" | "adventure";

export const CONTENT_APP_IDS: ContentAppId[] = [
    "chat", "diary", "music", "reading",
    "cocreate", "story", "game", "xiaohongshu", "dwelling",
    "checkphone", "shopping", "calendar", "interview_magazine",
    "moments", "group_chat", "vn", "adventure"
];

export const CONTENT_APP_LABELS: Record<ContentAppId, string> = {
    chat: "聊天",
    diary: "手记",
    music: "音乐",
    reading: "阅读",
    forum: "论坛（旧）",
    cocreate: "共创",
    story: "剧情",
    game: "游戏",
    xiaohongshu: "小红书",
    dwelling: "栖所",
    checkphone: "查手机",
    shopping: "购物",
    calendar: "日历",
    interview_magazine: "在场",
    moments: "朋友圈",
    group_chat: "群聊",
    vn: "漫卷",
    adventure: "冒险",
};

// Binding slot — config selections for a given scope
export type BindingSlot = {
    apiConfigId?: string;
    voiceConfigId?: string;
    presetId?: string;
    userIdentityId?: string;
    worldBookIds?: string[];
    regexIds?: string[];
};

// Character binding: character defaults + per-app overrides
export type CharacterBinding = {
    characterId: string;
    defaults: BindingSlot;
    appOverrides: Partial<Record<string, BindingSlot>>;
};

// Overall binding configuration
export type BindingConfig = {
    globalDefaults: BindingSlot;
    /** App-level defaults shared by every character; character app overrides still win. */
    appDefaults?: Partial<Record<string, BindingSlot>>;
    characterBindings: CharacterBinding[];
    /** Auxiliary API: used for memory summarization (global, not per-character) */
    memorySummaryApiConfigId?: string;
    /** Auxiliary API: used for embedding/vector recall (global, not per-character) */
    embeddingApiConfigId?: string;
    /** Auxiliary API: used by the mascot assistant (global, not per-character) */
    mascotApiConfigId?: string;
    /** Auxiliary API: used by the QA workshop agent (global, not per-character) */
    qaApiConfigId?: string;
    /** Auxiliary API: used to translate reasoning/chain-of-thought text (global, not per-character) */
    reasoningTranslateApiConfigId?: string;
};

// --- Chat Toolbox ---
export type RestToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type RestToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    endpoint: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    bodyTemplate?: string;        // Optional JSON body template with {{param}} placeholders
    parameterSchema: string;       // JSON Schema for LLM-visible params only
    fixedParams?: Record<string, string>;  // auto-injected params (api_key etc), hidden from LLM
    enabled: boolean;
    builtIn?: boolean;
    directFetch?: boolean;         // true = browser direct fetch, false = server proxy
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolStep = {
    id: string;
    name?: string;
    toolType?: "auto" | "rest" | "internal" | "mcp" | "composite" | "script";
    toolId?: string;
    serverId?: string;
    toolName?: string;
    argsTemplate?: string;        // JSON object template. Supports {{input.xxx}}, {{steps.key.data}}, {{last.data}}
    script?: string;              // Arbitrary async JS for script steps. Receives input, steps, last, args, context.
    saveAs?: string;
};

export type CompositeToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    parameterSchema: string;
    steps: CompositeToolStep[];
    outputTemplate?: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type McpDiscoveredTool = {
    name: string;
    description: string;
    inputSchema: object;
};

export type McpServerConfig = {
    id: string;
    name: string;
    description?: string;
    url: string;
    enabled: boolean;
    /** 直连模式：浏览器直接请求（本机/内网 MCP 用），不走服务端代理 */
    directFetch?: boolean;
    headers?: Record<string, string>;
    discoveredTools?: McpDiscoveredTool[];
    // Session state (runtime, not persisted across page refresh)
    sessionId?: string;
    // OAuth tokens (persisted)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthTokenEndpoint?: string;
    oauthAuthorizationEndpoint?: string;
    oauthRegistrationEndpoint?: string;
    oauthAuthorizationServer?: string;
    oauthProtectedResourceMetadataUrl?: string;
    createdAt: number;
    updatedAt: number;
};

// --- Internal Capabilities ---
export type InternalCapabilityMode = "off" | "confirm" | "auto";

export type InternalCapabilityConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    mode: InternalCapabilityMode;
    createdAt: number;
    updatedAt: number;
};
