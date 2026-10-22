const encoder = new TextEncoder();

function getGateSecret(): string {
  return (
    process.env.ACCOUNT_GATE_SECRET ||
    process.env.SITE_ACCESS_PASSWORD ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXTAUTH_SECRET ||
    ""
  ).trim();
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const array = new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return bytesToBase64Url(signature);
}

export async function createAccountGateCookieValue(
  sessionToken: string,
  maxAgeSeconds: number,
): Promise<string> {
  const secret = getGateSecret();
  if (!secret || !sessionToken) return "";
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, Math.floor(maxAgeSeconds));
  const sessionDigest = await hmacSha256(`session:${sessionToken}`, secret);
  const payload = `v1.${expiresAt}.${sessionDigest}`;
  const signature = await hmacSha256(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifyAccountGateCookieValue(
  value: string,
  sessionToken: string,
): Promise<boolean> {
  const secret = getGateSecret();
  if (!secret || !value || !sessionToken) return false;
  const [version, expiresAtRaw, sessionDigest, signature, ...rest] = value.split(".");
  if (rest.length > 0 || version !== "v1" || !expiresAtRaw || !sessionDigest || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expectedSessionDigest = await hmacSha256(`session:${sessionToken}`, secret);
  if (sessionDigest !== expectedSessionDigest) return false;
  const expectedSignature = await hmacSha256(`v1.${expiresAtRaw}.${sessionDigest}`, secret);
  return signature === expectedSignature;
}
