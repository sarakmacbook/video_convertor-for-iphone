/**
 * Input checks for "connect the bot": the bot API key from @BotFather and the Telegram user ID
 * of the person allowed to use it. Kept separate from the route so the rules are easy to test.
 */

/** What @BotFather prints: the bot's numeric ID, a colon, then the secret part. */
export const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

/** Telegram user IDs are positive integers. 15 digits is far above any real account. */
export const USER_ID_PATTERN = /^[1-9]\d{0,14}$/;

export function parseBotToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return BOT_TOKEN_PATTERN.test(token) ? token : null;
}

export function parseUserId(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!USER_ID_PATTERN.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}
