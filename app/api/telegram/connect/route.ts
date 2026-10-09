/**
 * "Connect the bot" from the Settings page: the bot API key from @BotFather and the Telegram
 * user ID allowed to use the bot.
 *
 *   1. checks the key with Telegram (getMe), so a typo is caught before anything is saved
 *   2. stores the key and sets allowed_user_ids to that one user
 *   3. sends that user a confirmation message (Telegram only lets a bot message someone who
 *      has already sent it a message, so a failure here is reported, not treated as an error)
 *
 * The webhook is set by the Settings page afterwards, through /api/telegram/setup.
 */

import { isDatabaseConfigured } from "@/lib/db";
import { fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { writeOverride } from "@/lib/settings/store";
import { TelegramClient, TelegramError } from "@/lib/telegram/api";
import { isRejectedApiKey, parseBotToken, parseUserId } from "@/lib/telegram/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ConnectRequest {
  token?: unknown;
  userId?: unknown;
}

const CONFIRMATION =
  "✅ Your video converter is connected. Send me a video as a File and I'll make it smaller. Only your account can use this bot.";

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();

    const body = await readJson<ConnectRequest>(request);
    const token = parseBotToken(body.token);
    if (!token) {
      return fail("the bot API key looks wrong. Copy the whole token from @BotFather, e.g. 123456789:AAH…", 400);
    }
    const userId = parseUserId(body.userId);
    if (userId === null) {
      return fail("the user ID must be a whole number, e.g. 123456789. Ask @userinfobot for yours.", 400);
    }
    if (!isDatabaseConfigured()) {
      return fail(
        "DATABASE_URL is not set, so the bot cannot be saved here. Set BOT_TOKEN and ALLOWED_USER_IDS in the environment instead.",
        400,
      );
    }

    // Use the API server already configured (the public one, or a local Bot API server).
    const { values: settings } = await getSettings();
    const client = new TelegramClient({
      token,
      apiUrl: settings.telegramApiUrl,
      localMode: settings.telegramLocalMode,
    });

    let bot: { id: number; username?: string; first_name?: string };
    try {
      bot = await client.getMe();
    } catch (error) {
      // Telegram (and local Bot API servers) reject a bad key as 401, 404, or HTTP 200
      // with `{ ok: false, error_code: 401 }`. All of those mean the key is wrong, not
      // that Telegram is unreachable.
      if (error instanceof TelegramError && (error.unauthorized || isRejectedApiKey(error.errorCode, error.description))) {
        return fail("Telegram did not accept this API key. Check it in @BotFather (/token) and try again.", 400);
      }
      const reason = error instanceof TelegramError ? error.description : "network error";
      return fail(`could not reach Telegram to check the key: ${reason}`, 502);
    }

    await writeOverride("telegram_bot_token", token);
    await writeOverride("allowed_user_ids", String(userId));
    invalidateSettingsCache();

    let messageSent = true;
    let warning: string | null = null;
    try {
      await client.sendMessage(userId, CONFIRMATION);
    } catch (error) {
      messageSent = false;
      const reason = error instanceof TelegramError ? error.description : "unknown error";
      warning = `saved, but the confirmation message was not delivered (${reason}). Open the bot in Telegram and press Start, then send a video.`;
    }

    return json({
      ok: true,
      bot: { id: bot.id, username: bot.username ?? null, name: bot.first_name ?? null },
      userId,
      messageSent,
      warning,
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/telegram/connect");
  }
}
