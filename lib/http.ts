/**
 * Small helpers shared by the route handlers: absolute URLs, JSON responses, and the
 * credential checks for the API, the settings page and the worker endpoints.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { log } from "@/lib/log";

export function baseUrl(request?: Request): string {
  const configured = (process.env.APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel) return `https://${vercel}`;
  if (request) {
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const host = forwardedHost ?? request.headers.get("host") ?? url.host;
    const proto = forwardedProto ?? url.protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("the request body must be JSON", 400);
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function handleRouteError(error: unknown, context: string): Response {
  if (error instanceof HttpError) return fail(error.message, error.status);
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${context}: ${message}`);
  return fail(message, 500);
}

// --------------------------------------------------------------------------- //
// Authentication
// --------------------------------------------------------------------------- //

const SESSION_COOKIE = "vc_session";
const SESSION_DAYS = 30;

export function authRequired(): boolean {
  return Boolean(process.env.APP_PASSWORD?.trim());
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

function sign(value: string): string {
  const secret = process.env.APP_SECRET?.trim();
  if (!secret) throw new HttpError("APP_SECRET is not set, so logins cannot be signed", 500);
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSessionToken(): string {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token || !authRequired()) return !authRequired();
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return false;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD?.trim();
  if (!expected) return true;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** API routes accept either the session cookie or `Authorization: Bearer <APP_PASSWORD>`. */
export function isAuthorized(request: Request): boolean {
  if (!authRequired()) return true;
  if (verifySessionToken(readCookie(request, SESSION_COOKIE))) return true;
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return checkPassword(header.slice(7).trim());
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return checkPassword(apiKey);
  return false;
}

export function unauthorized(): Response {
  return fail("Sign in first (this deployment is protected by APP_PASSWORD)", 401);
}

/**
 * The webhook handler is protected by the secret Telegram is given in the URL, not by the
 * session cookie: Telegram cannot log in.
 */
export function checkWebhookSecret(candidate: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(candidate ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Worker endpoints use a separate shared secret so workers never see the admin password. */
export function checkWorkerSecret(request: Request): boolean {
  const expected = workerSecret();
  if (!expected) return false;
  const provided =
    request.headers.get("x-worker-secret") ??
    (request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
      ? request.headers.get("authorization")!.slice(7).trim()
      : null);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function workerSecret(): string | null {
  const value = (process.env.WORKER_SECRET ?? "").trim();
  return value || null;
}
