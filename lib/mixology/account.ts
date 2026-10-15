/**
 * 「特调 / 对局这杯正在烧哪本账」的唯一解析入口。
 *
 * 语义（与用户心智对齐）：**快捷切换里选中的那个「全局模型」所属的文件夹**。
 * 依据是 `resolveMixApiConfig()` —— 它对局/特调只读 `binding.globalDefaults.apiConfigId`，
 * 角色级绑定不参与；全局没设时才退到配置列表第一个（这一点必须和它对局实际用法一致，
 * 否则「显示的余额」和「真正扣费的账户」会是两本账）。
 *
 * 单独放一个小模块，是为了避开 `lib/api-accounts` ↔ `lib/mixology/engine` 的循环依赖。
 */
import { accountIdForConfig, getApiAccount } from "@/lib/api-accounts";
import { resolveMixApiConfig } from "./engine";

/** 当前对局/特调会扣的那个账户 id（空串 = 未分组账户） */
export function resolveMixAccountId(): string {
    try {
        const config = resolveMixApiConfig();
        return config ? accountIdForConfig(config) : "";
    } catch {
        // 配置异常也不该把对局界面搞崩，退回未分组账户
        return "";
    }
}

/** 账户 id + 当前余额（用作「本局花了多少」的基准） */
export function snapshotMixAccount(): { id: string; baseline: number } {
    const id = resolveMixAccountId();
    return { id, baseline: getApiAccount(id).balance };
}
