"use client";

import type { BlackMarketTheaterTemplate, BlackMarketWalletState } from "./black-market-types";

type BlackMarketListResponse = {
  ok: boolean;
  theaters?: BlackMarketTheaterTemplate[];
  error?: string;
};

type BlackMarketMutationResponse = {
  ok: boolean;
  theater?: BlackMarketTheaterTemplate;
  id?: string;
  error?: string;
};

type BlackMarketWalletResponse = {
  ok: boolean;
  wallet?: BlackMarketWalletState;
  error?: string;
};

type BlackMarketPurchaseResponse = BlackMarketWalletResponse & {
  theater?: unknown;
};

type BlackMarketPurchasedResponse = {
  ok: boolean;
  theaters?: BlackMarketTheaterTemplate[];
  error?: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data as T;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(input, {
      ...init,
      credentials: "include",
      signal: controller.signal,
    });
    return await readJson<T>(response);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("请求超时，请检查 Supabase 网络连接。");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchBlackMarketTheaters(): Promise<BlackMarketTheaterTemplate[]> {
  const data = await fetchJson<BlackMarketListResponse>("/api/black-market/theaters", { cache: "no-store" });
  return data.theaters ?? [];
}

export async function fetchBlackMarketTheater(theaterId: string): Promise<BlackMarketTheaterTemplate> {
  const data = await fetchJson<BlackMarketMutationResponse>(`/api/black-market/theaters?id=${encodeURIComponent(theaterId)}`, { cache: "no-store" });
  if (!data.theater) throw new Error(data.error || "夜间档案详情加载失败");
  return data.theater;
}

export async function publishBlackMarketTheater(input: BlackMarketTheaterTemplate): Promise<BlackMarketTheaterTemplate> {
  const data = await fetchJson<BlackMarketMutationResponse>("/api/black-market/theaters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!data.theater) throw new Error(data.error || "夜间档案发布失败");
  return data.theater;
}

export async function updateBlackMarketTheater(input: BlackMarketTheaterTemplate): Promise<BlackMarketTheaterTemplate> {
  const data = await fetchJson<BlackMarketMutationResponse>("/api/black-market/theaters", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!data.theater) throw new Error(data.error || "夜间档案修改失败");
  return data.theater;
}

export async function deleteBlackMarketTheater(input: { id: string; authorId: string }): Promise<string> {
  const data = await fetchJson<BlackMarketMutationResponse>("/api/black-market/theaters", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.id || input.id;
}

export async function fetchBlackMarketWallet(): Promise<BlackMarketWalletState> {
  const data = await fetchJson<BlackMarketWalletResponse>("/api/black-market/wallet", { cache: "no-store" });
  if (!data.wallet) throw new Error(data.error || "黑市钱包读取失败");
  return data.wallet;
}

export async function checkInBlackMarketCloud(): Promise<BlackMarketWalletState> {
  const data = await fetchJson<BlackMarketWalletResponse>("/api/black-market/checkin", {
    method: "POST",
  });
  if (!data.wallet) throw new Error(data.error || "黑市签到失败");
  return data.wallet;
}

export async function purchaseBlackMarketTheaterCloud(theaterId: string): Promise<{
  wallet: BlackMarketWalletState;
  theater?: unknown;
}> {
  const data = await fetchJson<BlackMarketPurchaseResponse>("/api/black-market/purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId }),
  });
  if (!data.wallet) throw new Error(data.error || "夜间档案购买失败");
  return { wallet: data.wallet, theater: data.theater };
}

export async function fetchPurchasedBlackMarketTheatersCloud(): Promise<BlackMarketTheaterTemplate[]> {
  const data = await fetchJson<BlackMarketPurchasedResponse>("/api/black-market/purchase", { cache: "no-store" });
  return data.theaters ?? [];
}
