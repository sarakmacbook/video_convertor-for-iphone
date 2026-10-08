/**
 * Webhook management from the Settings page: connect the bot, disconnect it, check it, and
 * send a test message. The webhook secret is generated here and stored with the other
 * settings so the URL stays the same across restarts and deployments.
 */

import { fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { writeOverride } from "@/lib/settings/store";
import { randomToken } from "@/lib/storage/signing";
import { telegramClientFor, telegramConfigured, uploadLimitBytes } from "@/lib/telegram/delivery";
import { isDatabaseConfigured } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SetupRequest {
  action?: "info" | "set" | "delete" | "test";
  chatId?: number | null;
  dropPendingUpdates?: boolean;
  /** Where Telegram should send updates. Defaults to this deployment. */
  publicUrl?: string;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    const body = await readJson<SetupRequest>(request).catch(() => ({}) as SetupRequest);
    const { values: settings } = await getSettings();

    if (!telegramConfigured(settings)) {
      return fail("add a Telegram bot token first (Settings → Telegram)", 400);
    }
    const client = telegramClientFor(settings);

    switch (body.action) {
      case "info": {
        const [me, info] = await Promise.all([client.getMe(), client.getWebhookInfo()]);
        return json({
          ok: true,
          bot: me,
          webhook: info,
          uploadLimitBytes: uploadLimitBytes(settings),
          localMode: settings.telegramLocalMode,
          delivery: settings.telegramDelivery,
          secretConfigured: Boolean(settings.telegramWebhookSecret),
        });
      }

      case "set": {
        let secret = settings.telegramWebhookSecret;
        if (!secret) {
          secret = randomToken(16);
          if (!isDatabaseConfigured()) {
            return fail("DATABASE_URL is not set, so the webhook secret cannot be stored", 400);
          }
          await writeOverride("telegram_webhook_secret", secret);
          invalidateSettingsCache();
        }

        const origin = (body.publicUrl ?? deriveOrigin(request)).replace(/\/+$/, "");
        if (!origin.startsWith("https://") && !origin.includes("localhost")) {
          return fail("Telegram needs an https URL for the webhook (use a preview URL or your domain)", 400);
        }
        const url = `${origin}/api/telegram/webhook/${secret}`;
        await client.setWebhook({
          url,
          secretToken: secret,
          allowedUpdates: ["message"],
          dropPendingUpdates: Boolean(body.dropPendingUpdates),
        });
        const info = await client.getWebhookInfo();
        return json({ ok: true, url, webhook: info, secretCreated: !settings.telegramWebhookSecret });
      }

      case "delete": {
        await client.deleteWebhook(Boolean(body.dropPendingUpdates));
        const info = await client.getWebhookInfo();
        return json({ ok: true, webhook: info });
      }

      case "test": {
        if (!body.chatId) return fail("send the chat id to test with");
        await client.sendMessage(
          body.chatId,
          "✅ This is a test message from your video converter. Send me a video as a File and I'll shrink it.",
        );
        const info = await client.getWebhookInfo();
        return json({ ok: true, sent: true, webhook: info });
      }

      default:
        return fail("action must be info, set, delete or test");
    }
  } catch (error) {
    return handleRouteError(error, "POST /api/telegram/setup");
  }
}

function deriveOrigin(request: Request): string {
  const configured = (process.env.APP_URL ?? "").trim();
  if (configured) return configured;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${proto}://${forwardedHost}`;
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel) return `https://${vercel}`;
  return new URL(request.url).origin;
}
