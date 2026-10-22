/**
 * API 文件夹（ApiGroup）的装配/变更工具。
 *
 * 设计约定：
 * - 文件夹本身只存 { id, name, collapsed }，不存 API 列表；归属关系写在 ApiConfig.groupId 上。
 * - 因此「删文件夹」绝不能删 API —— 释放到未分组（groupId 清空）后再删文件夹。
 * - 所有写库函数都返回新的列表，方便调用方直接 setState。
 */
import type { ApiConfig, ApiGroup } from "./settings-types";
import { loadApiConfigs, loadApiGroups, saveApiConfigs, saveApiGroups } from "./settings-storage";

/** 未分组的 groupId 取值（空串 / undefined 都视为未分组） */
export const API_UNGROUPED_ID = "";

export type ApiSection = {
    kind: "group" | "ungrouped";
    id: string;
    name: string;
    collapsed: boolean;
    items: ApiConfig[];
};

export function createApiGroupId(): string {
    return `apigroup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeGroupId(groupId?: string): string {
    return typeof groupId === "string" ? groupId : API_UNGROUPED_ID;
}

/** 新建文件夹并落库，返回更新后的完整列表 */
export function addApiGroup(name: string): ApiGroup[] {
    const trimmed = name.trim() || "新文件夹";
    const group: ApiGroup = {
        id: createApiGroupId(),
        name: trimmed,
        collapsed: false,
        createdAt: Date.now(),
    };
    const next = [...loadApiGroups(), group];
    saveApiGroups(next);
    return next;
}

/** 文件夹改名并落库，返回更新后的完整列表 */
export function renameApiGroup(groupId: string, name: string): ApiGroup[] {
    const trimmed = name.trim();
    const next = loadApiGroups().map(group => (
        group.id === groupId
            ? { ...group, name: trimmed || group.name }
            : group
    ));
    saveApiGroups(next);
    return next;
}

/** 折叠/展开并落库，返回更新后的完整列表 */
export function setApiGroupCollapsed(groupId: string, collapsed: boolean): ApiGroup[] {
    const next = loadApiGroups().map(group => (
        group.id === groupId ? { ...group, collapsed } : group
    ));
    saveApiGroups(next);
    return next;
}

/**
 * 删除文件夹：组内 API 一律释放到未分组（绝不删除 API 本体）。
 * 返回 { groups, configs } 两份最新列表。
 */
export function deleteApiGroup(groupId: string): { groups: ApiGroup[]; configs: ApiConfig[] } {
    const groups = loadApiGroups().filter(group => group.id !== groupId);
    const configs = loadApiConfigs().map(config => (
        normalizeGroupId(config.groupId) === groupId
            ? { ...config, groupId: API_UNGROUPED_ID }
            : config
    ));
    saveApiConfigs(configs);
    saveApiGroups(groups);
    return { groups, configs };
}

/** 把某个 API 配置移动到指定文件夹（传空串 = 未分组），返回更新后的配置列表 */
export function moveApiConfigToGroup(configId: string, groupId: string): ApiConfig[] {
    const target = normalizeGroupId(groupId);
    const configs = loadApiConfigs().map(config => (
        config.id === configId ? { ...config, groupId: target } : config
    ));
    saveApiConfigs(configs);
    return configs;
}

/**
 * 按文件夹切分 API 列表：文件夹保持存储顺序，未分组永远排在最后。
 * 引用了已删除文件夹的 API 会自动退回未分组。
 */
export function buildApiSections(configs: ApiConfig[], groups: ApiGroup[]): ApiSection[] {
    const validIds = new Set(groups.map(group => group.id));
    const buckets = new Map<string, ApiConfig[]>();
    const ungrouped: ApiConfig[] = [];

    for (const config of configs) {
        const gid = normalizeGroupId(config.groupId);
        if (gid && validIds.has(gid)) {
            const bucket = buckets.get(gid);
            if (bucket) bucket.push(config);
            else buckets.set(gid, [config]);
        } else {
            ungrouped.push(config);
        }
    }

    const sections: ApiSection[] = groups.map(group => ({
        kind: "group" as const,
        id: group.id,
        name: group.name,
        collapsed: group.collapsed === true,
        items: buckets.get(group.id) ?? [],
    }));

    sections.push({
        kind: "ungrouped",
        id: API_UNGROUPED_ID,
        name: "未分组",
        collapsed: false,
        items: ungrouped,
    });

    return sections;
}

/** 该 API 当前所属文件夹名（未分组返回空串） */
export function findApiGroupName(groups: ApiGroup[], groupId?: string): string {
    const gid = normalizeGroupId(groupId);
    if (!gid) return "";
    return groups.find(group => group.id === gid)?.name || "";
}
