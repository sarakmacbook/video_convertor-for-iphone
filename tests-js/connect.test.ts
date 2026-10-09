/**
 * "Connect the bot" from the Settings page: the API key and user ID are checked, saved, and
 * a confirmation is sent. Runs against the fake Telegram server, so no token or internet is needed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetDbCacheForTests } from "@/lib/db";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { writeOverride } from "@/lib/settings/store";
import { parseBotToken, parseUserId } from "@/lib/telegram/connect";
import { POST as connectPost } from "@/app/api/telegram/connect/route";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";

const BASE = "http://localhost:3000";
const TOKEN = "123456789:AAHfakeTokenForTests_abc-def";
const USER_ID = 555111222;

function connectRequest(body: unknown): Request {
  return new Request(`${BASE}/api/telegram/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parsing the API key and user ID", () => {
  it("accepts the token format @BotFather prints, trimming spaces", () => {
    expect(parseBotToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  it.each([["not-a-token"], ["123456"], ["12:has space"], [""], [null], [42]])("rejects %j", (raw) => {
    expect(parseBotToken(raw)).toBeNull();
  });

  it("accepts a positive whole number as a user ID", () => {
    expect(parseUserId("123456789")).toBe(123456789);
    expect(parseUserId(" 42 ")).toBe(42);
    expect(parseUserId(42)).toBe(42);
  });

  it.each([["0"], ["-5"], ["12.5"], ["alice"], ["1,2"], [""], ["0123"], ["9999999999999999"]])(
    "rejects %j as a user ID",
    (raw) => {
      expect(parseUserId(raw)).toBeNull();
    },
  );
});

describe("POST /api/telegram/connect", () => {
  let fake: FakeTelegram;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    fake = await startFakeTelegram(new Map());
    // The route uses the API server from the settings, so point it at the fake one.
    await writeOverride("telegram_api_url", fake.url);
    invalidateSettingsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fake.calls.length = 0;
  });

  afterAll(async () => {
    await fake.close();
    resetDbCacheForTests();
  });

  it("refuses a malformed API key without calling Telegram", async () => {
    const response = await connectPost(connectRequest({ token: "not-a-token", userId: String(USER_ID) }));
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/API key/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a user ID that is not a number", async () => {
    const response = await connectPost(connectRequest({ token: TOKEN, userId: "@alice" }));
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/user ID/);
    expect(fake.calls).toHaveLength(0);
  });

  it("does not save anything when Telegram rejects the key", async () => {
    const rejecting = realFetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/bot999999999:")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return rejecting(input, init);
    });

    const response = await connectPost(connectRequest({ token: "999999999:WRONGKEY", userId: String(USER_ID) }));
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/did not accept this API key/);

    const { values } = await getSettings();
    expect(values.telegramBotToken).not.toBe("999999999:WRONGKEY");
  });

  it("saves the key and the one allowed user, then sends the confirmation", async () => {
    const response = await connectPost(connectRequest({ token: TOKEN, userId: USER_ID }));
    const body = (await response.json()) as {
      ok: boolean;
      bot: { username: string | null };
      userId: number;
      messageSent: boolean;
      warning: string | null;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, userId: USER_ID, messageSent: true, warning: null });
    expect(body.bot.username).toBe("test_converter_bot");

    const { values, overridden } = await getSettings();
    expect(values.telegramBotToken).toBe(TOKEN);
    expect(values.allowedUserIds).toEqual([USER_ID]);
    expect(overridden).toEqual(expect.arrayContaining(["telegram_bot_token", "allowed_user_ids"]));

    const sent = fake.lastCall("sendMessage");
    expect(sent?.body.chat_id).toBe(USER_ID);
    expect(String(sent?.body.text)).toMatch(/connected/);
  });

  it("still succeeds when the confirmation cannot be delivered, and says why", async () => {
    const rejecting = realFetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/sendMessage")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return rejecting(input, init);
    });

    const response = await connectPost(connectRequest({ token: TOKEN, userId: 777000111 }));
    const body = (await response.json()) as { ok: boolean; messageSent: boolean; warning: string };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.messageSent).toBe(false);
    expect(body.warning).toMatch(/press Start/);

    const { values } = await getSettings();
    expect(values.allowedUserIds).toEqual([777000111]);
  });
});
