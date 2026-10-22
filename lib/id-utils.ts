// 不透明 ID 生成的单一来源。
// 走查时全仓有 18 处模块私有的 createId/generateId/uid，随机段的进制和长度各不相同
// （Date.now() 十进制或 36 进制、随机 5/6/8 位、crypto.randomUUID 全量或截 12 位）。
// 已核对：没有任何调用方按 "_" 结构反解析这些 ID（只有展示用的 slice(0, 8) / slice(-8)
// 之类的截断），所以统一格式是安全的。
// 迁移处用 import 别名保留原函数名，调用行不动；原先不带前缀参数的两处
// （media-cache-storage 的 generateId、quick-note-bridge 的 uid）改为显式传前缀。

/**
 * 主族：`前缀_十进制时间戳_6位base36随机`。
 * 时间戳必须是十进制：lib/storage-space.ts 的 MEDIA_ID_RE = /mc_\d+_[a-z0-9]+/g
 * 会按这个形状从全存储内容里扫媒体引用（media-cache 与 moments 评论都用 mc_ 前缀）。
 * 改成 base36 时间戳会让正则失配，孤儿媒体判定会把仍被引用的缓存当孤儿删掉。
 */
export function createId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 需要跨端唯一性（写进云同步或作为服务端主键片段）时用完整 UUID，无 crypto 时回退主族。 */
export function createUuidId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return createId(prefix);
}

/** 中等熵：crypto.randomUUID 去横线取 12 位；无 crypto 时回退时间戳混合式。 */
export function createShortUuidId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    }
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
