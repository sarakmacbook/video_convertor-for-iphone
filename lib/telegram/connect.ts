/**
 * Input checks for "connect the bot": the bot API key from @BotFather and the Telegram user ID
 * of the person allowed to use it. Kept separate from the route so the rules are easy to test.
 *
 * People paste a lot more than the bare token — the whole BotFather message, a leading `bot`,
 * quotes, a trailing period, invisible characters from Telegram Desktop. The parsers accept
 * those and return the clean value, so a valid key is not rejected for being wrapped.
 */

/** What @BotFather prints: the bot's numeric ID, a colon, then the secret part. */
export const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

/** A token buried in other text. Real secrets are ~35 characters; 8 is enough to avoid noise. */
const BOT_TOKEN_IN_TEXT = /\d{3,}:[A-Za-z0-9_-]{8,}/g;

/** Telegram user IDs are positive integers. 15 digits is far above any real account. */
export const USER_ID_PATTERN = /^[1-9]\d{0,14}$/;

const INVISIBLE = /[\u200B-\u200D\uFEFF\u00A0]/g;

const USER_ID_LABEL =
  /\b(?:(?:user|chat)\s*id|id)\b[^0-9]{0,24}([1-9]\d{4,14})\b/i;

function unwrap(raw: string): string {
  let text = raw.replace(INVISIBLE, " ").trim();
  if (text.length >= 2) {
    const start = text[0];
    const end = text[text.length - 1];
    if ((start === end && (start === '"' || start === "'" || start === "`")) || (start === "<" && end === ">")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * The token Telegram should see: digits, a colon, then the secret. Returns null when nothing
 * in the input looks like one.
 */
export function parseBotToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = unwrap(raw);
  if (!text) return null;

  // Docs and some copy-paste include the `/bot` URL prefix.
  if (/^bot/i.test(text) && BOT_TOKEN_PATTERN.test(text.slice(3))) {
    text = text.slice(3);
  }

  if (BOT_TOKEN_PATTERN.test(text)) return text;

  const withoutPunct = text.replace(/[.,;]+$/u, "");
  if (BOT_TOKEN_PATTERN.test(withoutPunct)) return withoutPunct;

  const found = text.match(BOT_TOKEN_IN_TEXT);
  if (!found || found.length === 0) return null;
  found.sort((a, b) => b.length - a.length);
  return found[0];
}

export function parseUserId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const text = unwrap(raw);
  if (!text) return null;
  if (USER_ID_PATTERN.test(text)) {
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : null;
  }
  const labeled = USER_ID_LABEL.exec(text);
  if (labeled) {
    const id = Number(labeled[1]);
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

/** True when Telegram refused the key, regardless of whether the HTTP status was 401 or 200. */
export function isRejectedApiKey(status: number, description?: string | null): boolean {
  if (status === 401 || status === 404) return true;
  return typeof description === "string" && /unauthorized/i.test(description);
}
