/**
 * Signed links.
 *
 * Two things need a signature that survives across serverless instances without a session:
 *   - upload/download links for the local storage driver (development and self-hosting);
 *   - the "download this converted video" link the UI and the Telegram delivery use, which is
 *     handed out by the API and must stop working after a while.
 *
 * The signing key is `APP_SECRET` when set. Without it a random per-process key is used, which
 * is fine for local development but means links stop working after a restart — and would not
 * work behind a load balancer. `docs/VERCEL.md` asks for `APP_SECRET` in any real deployment.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const fallbackSecret = randomBytes(32).toString("base64url");

export function signingSecret(): string {
  return process.env.APP_SECRET?.trim() || fallbackSecret;
}

export function usingEphemeralSecret(): boolean {
  return !process.env.APP_SECRET?.trim();
}

export interface StorageTokenPayload {
  key: string;
  op: "put" | "get";
  exp: number; // ms since epoch
  maxBytes?: number;
  contentType?: string;
  name?: string;
}

function b64(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signPayload(payload: StorageTokenPayload, secret = signingSecret()): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyPayload(token: string, secret = signingSecret()): StorageTokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: StorageTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StorageTokenPayload;
  } catch {
    return null;
  }
  if (!payload?.key || !payload.op) return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

export function randomToken(bytes = 6): string {
  return randomBytes(bytes).toString("base64url").replace(/[-_]/g, "").toLowerCase();
}
