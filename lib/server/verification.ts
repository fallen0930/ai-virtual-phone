// lib/server/verification.ts — 成年审核激活码申请：服务端共享工具。
// 表/桶见 docs/verify-supabase.sql；管理密钥来自环境变量 VERIFY_ADMIN_KEY。

import nodeCrypto from "crypto";

import { getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export const VERIFY_BUCKET = "verification-images";

export type VerificationRequestRow = {
  id: string;
  query_code: string;
  contact: string;
  image_path: string | null;
  status: "pending" | "approved" | "rejected";
  activation_code: string | null;
  note: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

// 去掉易混淆字符（0O1IL）的查询码，形如 VR-7XK2M9QA。
export function generateQueryCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return `VR-${out}`;
}

export function isValidQueryCode(value: string): boolean {
  return /^VR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(value);
}

// 只收 header 不收查询参数(?key= 会原文进访问日志);sha256 后比较避免时序侧信道
export function requireAdminKey(request: Request): boolean {
  const expected = (process.env.VERIFY_ADMIN_KEY || "").trim();
  if (!expected) return false;
  const provided = (request.headers.get("x-verify-admin-key") || "").trim();
  if (!provided) return false;
  const hash = (value: string) => nodeCrypto.createHash("sha256").update(value).digest();
  return nodeCrypto.timingSafeEqual(hash(provided), hash(expected));
}

export async function deleteVerificationImage(imagePath: string): Promise<void> {
  const config = getSupabaseServerConfig();
  if (!config || !imagePath) return;
  try {
    await fetch(`${config.url}/storage/v1/object/${VERIFY_BUCKET}/${imagePath}`, {
      method: "DELETE",
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
  } catch {
    // 删图失败不阻塞审核流程
  }
}
