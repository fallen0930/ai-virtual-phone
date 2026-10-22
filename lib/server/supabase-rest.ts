type SupabaseConfig = {
  url: string;
  key: string;
};

export type SupabaseRestResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

export function getSupabaseServerConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function formatSupabaseRestError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause ?? "") : "";
  const details = `${message} ${cause}`;
  if (/getaddrinfo|EAI_AGAIN|ENOTFOUND/i.test(details)) {
    return "Supabase 域名解析失败，请检查当前 Next 运行环境的网络/DNS。";
  }
  if (/fetch failed/i.test(message)) {
    return "无法连接 Supabase，请检查当前 Next 运行环境是否能访问 Supabase。";
  }
  return message;
}

export async function supabaseRestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<SupabaseRestResult<T>> {
  const config = getSupabaseServerConfig();
  if (!config) return { ok: false, error: "missing_supabase_env", status: 503 };

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message)
      : text || response.statusText;
    return { ok: false, error: message, status: response.status };
  }

  return { ok: true, data: data as T, status: response.status };
}

export function encodeSupabaseFilter(value: string): string {
  return encodeURIComponent(value);
}
