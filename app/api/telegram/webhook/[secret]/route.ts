/**
 * The Telegram webhook.
 *
 * Telegram must get a 200 quickly, or it retries the update — so the answer is sent first and
 * the work continues in the background (`waitUntil` keeps the function alive on Vercel).
 *
 * The secret is part of the URL and is also sent back in the `X-Telegram-Bot-Api-Secret-Token`
 * header, which `setWebhook` configures. Both are checked.
 */

import { background } from "@/lib/background";
import { checkWebhookSecret, json } from "@/lib/http";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { handleTelegramUpdate } from "@/lib/telegram/jobs";
import { parseUpdate } from "@/lib/telegram/update";
import { baseUrl } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ secret: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { secret } = await context.params;
  const { values: settings } = await getSettings();

  const expected = settings.telegramWebhookSecret;
  const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
  const matches =
    checkWebhookSecret(secret, expected) || (headerSecret ? checkWebhookSecret(headerSecret, expected) : false);
  if (!matches) {
    // Never say why: the URL is public once it leaks.
    log.warn("rejected a Telegram webhook call with a wrong secret");
    return new Response("forbidden", { status: 403 });
  }

  if (!settings.telegramBotToken) {
    log.warn("a Telegram update arrived but no bot token is configured");
    return json({ ok: true, ignored: "no bot token" });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true, ignored: "unreadable body" });
  }

  const parsed = parseUpdate(update);
  if (parsed.chatId === null) return json({ ok: true, ignored: "no message" });

  const url = baseUrl(request);
  background(
    handleTelegramUpdate({ settings, baseUrl: url, update: parsed }),
    `telegram update ${parsed.messageId ?? "?"}`,
  );

  return json({ ok: true });
}

export async function GET() {
  // A quick sanity check when pasting the URL into a browser.
  return json({ ok: true, hint: "This endpoint accepts POST requests from Telegram." });
}
