// 登录暴力破解限速：只按来源 IP 做内存滑动窗计数,阈值放得很宽。
// 账号本身没有敏感资产(API 密钥都在用户本地),不做按账号锁定,避免误伤
// 手滑输错的正常用户;这道防线针对的是单 IP 大规模撞库和激活码枚举。
//
// 注意这是"实例内"记忆——Netlify/Lambda 每个热实例各有一份计数,冷启动清零,
// 并发多实例时攻击者可能拿到数倍配额。但持续暴破恰恰会把同一实例保持热态,
// 配合 21 万次 PBKDF2 的单次验证成本,足以把在线爆破压到不可行;
// 若将来要求严格全局一致,再迁到 Supabase 计数表。

type AttemptEntry = {
  count: number;
  windowStartAt: number;
  lockedUntil: number;
};

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_IP = 50;
const MAX_ENTRIES = 2000;

const attempts = new Map<string, AttemptEntry>();

function pruneIfNeeded(now: number): void {
  if (attempts.size <= MAX_ENTRIES) return;
  for (const [key, entry] of attempts) {
    if (entry.lockedUntil < now && now - entry.windowStartAt > WINDOW_MS) attempts.delete(key);
  }
}

function getEntry(key: string, now: number): AttemptEntry {
  let entry = attempts.get(key);
  if (!entry || (entry.lockedUntil < now && now - entry.windowStartAt > WINDOW_MS)) {
    entry = { count: 0, windowStartAt: now, lockedUntil: 0 };
    attempts.set(key, entry);
  }
  return entry;
}

export function getLoginClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 已被锁定时返回剩余分钟数,否则返回 0。 */
export function loginLockedMinutes(ip: string): number {
  const now = Date.now();
  const lockedUntil = attempts.get(`ip:${ip}`)?.lockedUntil ?? 0;
  if (lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((lockedUntil - now) / 60_000));
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  pruneIfNeeded(now);
  const entry = getEntry(`ip:${ip}`, now);
  entry.count += 1;
  if (entry.count >= MAX_FAILURES_PER_IP) {
    entry.lockedUntil = now + LOCK_MS;
    entry.count = 0;
    entry.windowStartAt = now;
  }
}
