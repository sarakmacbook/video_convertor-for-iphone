/**
 * The sign-in form used when APP_PASSWORD is set.
 *
 * A deployment that can burn CPU on encoder work should not be open to the internet, so the
 * UI is protected by a password and a signed cookie. Without APP_PASSWORD everything stays
 * open (and the health report nags about it).
 */

import { checkPassword, clearSessionCookie, createSessionToken, json, readJson, sessionCookie } from "@/lib/http";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoginRequest {
  password?: string;
}

export async function POST(request: Request) {
  const body = await readJson<LoginRequest>(request).catch(() => ({}) as LoginRequest);
  const password = body.password ?? "";

  if (!process.env.APP_PASSWORD?.trim()) {
    return json({ ok: true, message: "this deployment is not password protected" });
  }
  if (!process.env.APP_SECRET?.trim()) {
    return json({ ok: false, error: "APP_SECRET is not set on the server, so logins cannot be signed" }, { status: 500 });
  }
  if (!checkPassword(password)) {
    log.warn("a sign-in attempt used the wrong password");
    return json({ ok: false, error: "wrong password" }, { status: 401 });
  }

  const token = createSessionToken();
  return json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

export async function DELETE() {
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}
