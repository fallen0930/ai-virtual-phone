"use client";

import { useState, useEffect, useCallback, useContext, useRef } from "react";
import { Plus, RefreshCw, Rss, AlertCircle, FileEdit, Trash2, X, Check, Download, Upload, Loader2 } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { ApiConfig } from "@/lib/settings-types";
import { loadApiConfigs, removeApiConfigReferences, saveApiConfigs } from "@/lib/settings-storage";
import { generateEmbedding, isEmbeddingModelName } from "@/lib/memory-embedding";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { determineBaseUrl, simpleLLMCall } from "@/lib/api-helpers";
import { downloadFile, isIOSBrowser, isAndroidBrowser } from "@/lib/download-utils";

const DEFAULT_CONFIGS: ApiConfig[] = [
    {
        id: "default-openai",
        name: "OpenAI 官方",
        provider: "OpenAI",
        apiKey: "",
        defaultModel: "gpt-4o",
        enableNativeTools: true,
        enableImageRecognition: true,
        enableImageGeneration: true,
        preventEmptyGenerateRambling: true,
        enableStreaming: true,
    }
];

function getNativeToolProtocolLabel(config: ApiConfig): string {
    if (config.provider === "Anthropic" && !config.baseUrl) return "Anthropic";
    if (config.provider === "Google") return "Gemini";
    return "OpenAI-compatible";
}

export function ApiSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Testing and Fetching states
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    const [isTesting, setIsTesting] = useState<Record<string, boolean>>({});
    const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({});

    // Import / Export states
    const [importPending, setImportPending] = useState<{ file: File; presets: ApiConfig[]; presetCount: number } | null>(null);
    const [importMode, setImportMode] = useState<"overwrite" | "append">("append");
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);

    // Load from localStorage on mount
    useEffect(() => {
        const loaded = loadApiConfigs();
        if (loaded.length > 0) {
            setConfigs(loaded);
        } else {
            setConfigs(DEFAULT_CONFIGS);
            saveApiConfigs(DEFAULT_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: ApiConfig[]) => {
        setConfigs(newConfigs);
        saveApiConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: ApiConfig = {
            id: `config-${Date.now()}`,
            name: "新配置",
            provider: "Custom",
            apiKey: "",
            defaultModel: "",
            enableNativeTools: true,
            enableImageRecognition: false,
            enableImageGeneration: false,
            preventEmptyGenerateRambling: true,
            enableStreaming: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        setSubpageRightAction("api",
            <button
                onClick={addConfig}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>新增API方案</span>
            </button>
        );
        return () => setSubpageRightAction("api", null);
    }, [addConfig, setSubpageRightAction]);

    const updateConfig = (id: string, updates: Partial<ApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));
        removeApiConfigReferences(id);
        const newFetchedModels = { ...fetchedModels };
        delete newFetchedModels[id];
        setFetchedModels(newFetchedModels);

        const newTestResults = { ...testResult };
        delete newTestResults[id];
        setTestResult(newTestResults);
    };

    // --- Export / Import API Presets ---

    const handleExport = useCallback(async () => {
        if (configs.length === 0) {
            setImportResult({ success: false, message: "没有可导出的 API 配置" });
            return;
        }
        setIsExporting(true);
        setImportResult(null);
        try {
            const exportData = {
                _exportTime: new Date().toISOString(),
                _type: "apiPresets",
                _version: "1.0",
                presets: configs.map(config => ({
                    name: config.name || config.provider,
                    baseUrl: config.baseUrl || "",
                    apiKey: config.apiKey,
                    modelName: config.defaultModel,
                    provider: config.provider,
                    enableNativeTools: config.enableNativeTools,
                    enableImageRecognition: config.enableImageRecognition,
                    enableImageGeneration: config.enableImageGeneration,
                    preventEmptyGenerateRambling: config.preventEmptyGenerateRambling,
                    enableStreaming: config.enableStreaming,
                    createdAt: new Date().toISOString(),
                })),
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = `api-presets-${dateStr}.json`;

            if (isIOSBrowser() || isAndroidBrowser()) {
                await downloadFile(blob, filename, { disableNativeShare: true });
            } else {
                await downloadFile(blob, filename, { disableNativeShare: true });
            }

            setImportResult({ success: true, message: `已导出 ${configs.length} 个 API 配置` });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setImportResult({ success: false, message: `导出失败: ${msg}` });
        } finally {
            setIsExporting(false);
        }
    }, [configs]);

    const parseImportFile = useCallback(async (file: File): Promise<ApiConfig[]> => {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data || !Array.isArray(data.presets)) {
            throw new Error("文件格式不正确：缺少 presets 数组");
        }

        const presets: ApiConfig[] = data.presets.map((preset: any, index: number) => {
            const provider = preset.provider || "Custom";
            return {
                id: `imported-${Date.now()}-${index}`,
                name: preset.name || `导入配置 ${index + 1}`,
                provider: provider,
                apiKey: preset.apiKey || "",
                baseUrl: preset.baseUrl || undefined,
                defaultModel: preset.modelName || "",
                enableNativeTools: preset.enableNativeTools !== undefined ? preset.enableNativeTools : true,
                enableImageRecognition: preset.enableImageRecognition || false,
                enableImageGeneration: preset.enableImageGeneration || false,
                preventEmptyGenerateRambling: preset.preventEmptyGenerateRambling !== undefined ? preset.preventEmptyGenerateRambling : true,
                enableStreaming: preset.enableStreaming !== undefined ? preset.enableStreaming : true,
            };
        });

        return presets;
    }, []);

    const handleFileSelected = useCallback(async (file: File | undefined) => {
        if (!file) return;
        setImportResult(null);
        try {
            const presets = await parseImportFile(file);
            setImportPending({ file, presets, presetCount: presets.length });
            setImportMode("append");
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setImportResult({ success: false, message: `文件解析失败: ${msg}` });
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
    }, [parseImportFile]);

    const executeImport = useCallback(async () => {
        if (!importPending) return;
        setIsImporting(true);
        setImportResult(null);
        try {
            let newConfigs: ApiConfig[];
            let addedCount = 0;
            let skippedCount = 0;

            if (importMode === "overwrite") {
                // 覆盖模式：清空现有配置，用导入的替换
                newConfigs = importPending.presets;
                addedCount = importPending.presets.length;
                // 移除旧配置的引用
                configs.forEach(c => removeApiConfigReferences(c.id));
            } else {
                // 追加模式：按 name + baseUrl 去重
                const existingKeys = new Set(
                    configs.map(c => `${(c.name || c.provider).toLowerCase()}|${(c.baseUrl || "").toLowerCase()}`)
                );
                const newPresets = importPending.presets.filter(preset => {
                    const key = `${(preset.name || preset.provider).toLowerCase()}|${(preset.baseUrl || "").toLowerCase()}`;
                    if (existingKeys.has(key)) {
                        skippedCount++;
                        return false;
                    }
                    existingKeys.add(key);
                    return true;
                });
                newConfigs = [...configs, ...newPresets];
                addedCount = newPresets.length;
            }

            persist(newConfigs);
            setImportPending(null);

            const modeLabel = importMode === "overwrite" ? "覆盖" : "追加";
            const skipNote = skippedCount > 0 ? `，跳过 ${skippedCount} 个重复项` : "";
            setImportResult({ success: true, message: `${modeLabel}导入成功：新增 ${addedCount} 个配置${skipNote}` });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setImportResult({ success: false, message: `导入失败: ${msg}` });
        } finally {
            setIsImporting(false);
        }
    }, [importPending, importMode, configs, persist]);

    // Use unified determineBaseUrl from api-helpers

    const fetchModels = async (config: ApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            const baseUrl = determineBaseUrl(config);
            if (!baseUrl) throw new Error("缺少 Base URL");
            if (!config.apiKey) throw new Error("缺少 API Key");

            // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
            // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
            const isGoogleNative = config.provider === "Google";
            // 用户常把完整端点填进 Base URL（如 .../v1/embeddings、.../v1/chat/completions），
            // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
            const modelsBase = baseUrl
                .replace(/\/$/, "")
                .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
            const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
            const url = isGoogleNative
                ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
                : modelsUrl;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

            const response = await fetch(url, { method: "GET", headers });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            let modelNames: string[] = [];
            if (isGoogleNative && Array.isArray(data?.models)) {
                // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
                modelNames = data.models.map((m: { name: string }) => (m.name || "").replace(/^models\//, ""));
            } else if (Array.isArray(data?.data)) {
                modelNames = data.data.map((m: { id: string }) => m.id);
            } else {
                throw new Error("返回数据格式不符合预期");
            }
            setFetchedModels(prev => ({ ...prev, [config.id]: modelNames }));
            setTestResult(prev => ({ ...prev, [config.id]: { success: true, message: `成功获取 ${modelNames.length} 个模型` } }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `拉取失败: ${msg}` } }));
            setFetchedModels(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const testConnection = async (config: ApiConfig) => {
        if (!config.defaultModel) {
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "请先输入或选择默认模型" } }));
            return;
        }

        setIsTesting(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            // 向量模型配置：测 /embeddings 端点。原来一律测 /chat/completions，
            // 导致 embedding 配置永远 404「测试失败」。
            if (isEmbeddingModelName(config.defaultModel)) {
                const embedding = await generateEmbedding("你好", config, { throwOnError: true });
                if (!embedding) throw new Error("接口未返回向量数据");
                setTestResult(prev => ({
                    ...prev,
                    [config.id]: { success: true, message: `测试成功! 向量模型可用，维度 ${embedding.length}` },
                }));
                return;
            }
            const result = await simpleLLMCall(
                config,
                [{ role: "user", content: "你好" }],
                // Cap (not spend): reasoning models (deepseek-reasoner / gemini-pro 等) burn
                // tokens on hidden reasoning first, so a tiny cap leaves the visible
                // content empty and the test falsely fails (finishReason=length).
                // 4096 covers heavy thinkers; a "你好" reply still stops well before it.
                { temperature: 0.2, max_tokens: 4096 },
            );
            if (result.error || !result.content) {
                throw new Error(result.error || "模型返回了空内容");
            }
            const reply = result.content.replace(/\s+/g, " ").trim();
            const preview = reply.length > 80 ? `${reply.slice(0, 80)}...` : reply;
            setTestResult(prev => ({
                ...prev,
                [config.id]: { success: true, message: `测试成功! 模型回复: ${preview}` },
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `测试失败: ${msg}` } }));
        } finally {
            setIsTesting(prev => ({ ...prev, [config.id]: false }));
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">API Settings</h2>
            </div>

            {/* Import / Export Actions */}
            <div className="flex gap-2 mx-2 flex-wrap">
                <button
                    type="button"
                    onClick={handleExport}
                    disabled={isExporting || configs.length === 0}
                    className="ui-btn ui-btn-outline"
                >
                    {isExporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    导出API配置
                </button>
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isImporting}
                    className="ui-btn ui-btn-outline"
                >
                    {isImporting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    导入API配置
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(event) => void handleFileSelected(event.target.files?.[0])}
                />
            </div>

            {importResult && (
                <Alert variant={importResult.success ? "success" : "danger"} className="mx-2">
                    <AlertCircle size={16} className="mt-[2px] shrink-0" />
                    <span className="break-all leading-[1.5]">{importResult.message}</span>
                </Alert>
            )}

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <AlertCircle size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有 API 配置</span>
                    <span className="menu-desc max-w-[240px]">
                        配置 API 密钥和模型以连接到 AI 服务。
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加配置
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map(config => (
                        <div
                            key={config.id}
                            className="ui-config-card min-w-0 cursor-pointer"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`编辑 ${config.name || config.provider}`}
                            onClick={() => setEditingId(config.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(config.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{config.name || config.provider}</span>
                                <span className="menu-desc truncate">{config.defaultModel || config.provider || "未设置模型"}</span>
                            </div>
                            <div className="flex gap-2 shrink-0 items-center justify-end">
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setEditingId(config.id);
                                    }}
                                    className="ui-link-btn"
                                >
                                    <FileEdit size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmDeleteId(config.id);
                                    }}
                                    className="ui-link-btn"
                                    data-variant="danger"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加配置" : "编辑配置"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的 OpenAI"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={config.provider}
                                                onChange={(e) => updateConfig(config.id, { provider: e.target.value })}
                                                className="ui-select"
                                            >
                                                <option value="OpenAI">OpenAI</option>
                                                <option value="Anthropic">Anthropic</option>
                                                <option value="Google">Google Gemini</option>
                                                <option value="DeepSeek">DeepSeek</option>
                                                <option value="Groq">Groq</option>
                                                <option value="OpenRouter">OpenRouter</option>
                                                <option value="Moonshot">Kimi (Moonshot)</option>
                                                <option value="Zhipu">Zhipu (GLM)</option>
                                                <option value="SiliconFlow">SiliconFlow</option>
                                                <option value="TogetherAI">Together AI</option>
                                                <option value="Custom">自定义 (Custom)</option>
                                            </select>
                                        </div>

                                        {/* Custom 必填 Base URL；其他 provider 可选填中转站地址 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">
                                                Base URL {config.provider === "Custom" ? "（必填）" : "（可选，留空用官方端点）"}
                                                {config.provider === "Google" && (
                                                    <span style={{ color: "#888", marginLeft: 6, fontSize: "0.85em" }}>
                                                        中转站填 https://xxx/v1beta 走原生协议
                                                    </span>
                                                )}
                                            </label>
                                            <Input
                                                type="url"
                                                value={config.baseUrl || ""}
                                                onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                placeholder={
                                                    config.provider === "Custom"
                                                        ? "https://api.example.com/v1"
                                                        : config.provider === "Google"
                                                            ? "https://your-proxy.example.com/v1beta"
                                                            : "默认用官方端点，留空即可"
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="sk-..."
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">默认模型 (Default Model)</label>
                                            <div className="flex gap-2">
                                                {fetchedModels[config.id] && fetchedModels[config.id].length > 0 ? (
                                                    <select
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        className="ui-select flex-1"
                                                    >
                                                        <option value="">请选择模型...</option>
                                                        {fetchedModels[config.id].map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input
                                                        type="text"
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        placeholder="gpt-4o, claude-3-opus..."
                                                        className="ui-input flex-1"
                                                    />
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex gap-3 mt-1">
                                            <button
                                                onClick={() => fetchModels(config)}
                                                disabled={isFetching[config.id]}
                                                className="ui-btn ui-btn ui-btn-soft-action flex-1"
                                            >
                                                <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                {isFetching[config.id] ? "拉取中..." : "拉取模型列表"}
                                            </button>

                                            <button
                                                onClick={() => testConnection(config)}
                                                disabled={isTesting[config.id]}
                                                className="ui-btn ui-btn ui-btn-success flex-1"
                                            >
                                                <Rss size={16} className={isTesting[config.id] ? "animate-spin" : ""} />
                                                {isTesting[config.id] ? "测试中..." : "测试连接"}
                                            </button>
                                        </div>

                                        {testResult[config.id] && testResult[config.id].message && (
                                            <Alert variant={testResult[config.id].success ? "success" : "danger"}>
                                                <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                                <span className="break-all leading-[1.5]">{testResult[config.id].message}</span>
                                            </Alert>
                                        )}

                                        <div
                                            className="ui-toggle-row mt-2 overflow-visible"
                                            style={{ display: "block", position: "relative", height: "auto", flexShrink: 0, padding: "14px 76px 14px 16px" }}
                                        >
                                            <span className="menu-label font-medium">启用原生工具调用</span>
                                            <span className="menu-desc whitespace-normal break-words leading-[1.45]">
                                                开启后自动选择该服务商可用的原生工具格式（当前：{getNativeToolProtocolLabel(config)}）；关闭后使用文本动作协议。
                                            </span>
                                            <span style={{ position: "absolute", top: 0, bottom: 0, right: 16, display: "flex", alignItems: "center" }}>
                                                <Toggle
                                                    checked={config.enableNativeTools !== false}
                                                    onChange={(v) => updateConfig(config.id, { enableNativeTools: v })}
                                                />
                                            </span>
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="menu-label font-medium">启用图像识别</span>
                                            <Toggle checked={config.enableImageRecognition} onChange={(v) => updateConfig(config.id, { enableImageRecognition: v })} />
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="flex min-w-0 flex-col">
                                                <span className="menu-label font-medium">防胡言乱语</span>
                                                <span className="menu-desc">防止没有用户输入时胡言乱语</span>
                                            </span>
                                            <Toggle
                                                checked={config.preventEmptyGenerateRambling === true}
                                                onChange={(v) => updateConfig(config.id, { preventEmptyGenerateRambling: v })}
                                            />
                                        </div>

                                        <div className="ui-toggle-row mt-2">
                                            <span className="flex min-w-0 flex-col">
                                                <span className="menu-label font-medium">启用流式调用</span>
                                                <span className="menu-desc">开启后 AI 回复边生成边显示；关闭后等待完整回复后再显示（适合不支持 SSE 的接口）</span>
                                            </span>
                                            <Toggle
                                                checked={config.enableStreaming !== false}
                                                onChange={(v) => updateConfig(config.id, { enableStreaming: v })}
                                            />
                                        </div>

                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}

            {/* Import Confirmation Modal */}
            {importPending && (
                <div className="modal-overlay" data-ui="modal" onClick={() => { if (!isImporting) setImportPending(null); }}>
                    <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">导入API配置</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
                            <p className="menu-desc" style={{ marginBottom: 12 }}>
                                文件：{importPending.file.name}
                            </p>
                            <p className="menu-desc" style={{ marginBottom: 16 }}>
                                共 {importPending.presetCount} 个API配置待导入
                            </p>
                            <p className="menu-label font-medium" style={{ marginBottom: 10 }}>请选择导入方式：</p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <button
                                    type="button"
                                    className={`ui-btn ${importMode === "append" ? "ui-btn-primary" : "ui-btn-outline"}`}
                                    style={{ width: "100%", justifyContent: "space-between", whiteSpace: "nowrap", textAlign: "left" }}
                                    onClick={() => setImportMode("append")}
                                >
                                    <span>追加导入</span>
                                    <span className="ts-12" style={{ opacity: 0.7 }}>合并到现有配置，重复项自动跳过</span>
                                </button>
                                <button
                                    type="button"
                                    className={`ui-btn ${importMode === "overwrite" ? "ui-btn-danger" : "ui-btn-outline"}`}
                                    style={{ width: "100%", justifyContent: "space-between", whiteSpace: "nowrap", textAlign: "left" }}
                                    onClick={() => setImportMode("overwrite")}
                                >
                                    <span>全部覆盖</span>
                                    <span className="ts-12" style={{ opacity: 0.7 }}>删除现有所有配置后导入</span>
                                </button>
                            </div>
                        </div>
                        <div className="modal-footer" data-ui="modal-footer" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button
                                type="button"
                                className={`ui-btn ${importMode === "overwrite" ? "ui-btn-danger" : "ui-btn-primary"}`}
                                style={{ width: "100%", whiteSpace: "nowrap" }}
                                onClick={() => void executeImport()}
                                disabled={isImporting}
                            >
                                {isImporting
                                    ? <><Loader2 size={16} className="animate-spin" /> 导入中…</>
                                    : importMode === "overwrite"
                                        ? "确认全部覆盖"
                                        : "确认追加导入"}
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline"
                                style={{ width: "100%", whiteSpace: "nowrap" }}
                                onClick={() => setImportPending(null)}
                                disabled={isImporting}
                            >
                                取消
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
