/**
 * The conversion menu through the Telegram webhook: upload → menu → button press → result.
 *
 * Runs the real route handler, real SQLite, real ffmpeg and a stand-in Telegram (`fake-telegram.ts`).
 * Each test uses its own upload, so the double-tap guard in the database is exercised honestly.
 */

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { settleBackgroundWork } from "@/lib/background";
import { getDb, migrateToLatest, resetDbCacheForTests } from "@/lib/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { TEXT_BUSY, TEXT_CHOICE_EXPIRED, TEXT_NO_AUDIO, TEXT_PRIVATE } from "@/lib/telegram/texts";

import { POST as telegramWebhook } from "@/app/api/telegram/webhook/[secret]/route";
import { POST as workerClaim } from "@/app/api/worker/claim/route";

import { ffmpegBinaries, makeIphoneClip, runFfmpeg } from "./helpers";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";

const SECRET = "webhook-secret";
const CHAT = 555;
const dir = mkdtempSync(path.join(os.tmpdir(), "video-convertor-menu-"));

let clipPath = "";
let silentPath = "";
let clipBytes = 0;
let fake: FakeTelegram | null = null;
let nextMessageId = 100;

function webhook(body: unknown): Promise<Response> {
  return telegramWebhook(
    new Request(`http://localhost:3000/api/telegram/webhook/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ secret: SECRET }) },
  );
}

/** A video sent as a File, as the menu is offered for. */
function uploadUpdate(fileId: string, name: string, options: { messageId?: number; bytes?: number } = {}) {
  const messageId = options.messageId ?? nextMessageId++;
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private", first_name: "Sam" },
      from: { id: CHAT, is_bot: false, first_name: "Sam" },
      document: {
        file_id: fileId,
        file_name: name,
        file_size: options.bytes ?? clipBytes,
        mime_type: "video/quicktime",
      },
    },
  };
}

/** A press on one of the menu's buttons. The menu is a reply to the upload, so the upload comes back with it. */
function pressUpdate(
  upload: { message: Record<string, unknown> } | null,
  data: string,
  options: { fromId?: number; menuId?: number; callbackId?: string } = {},
) {
  return {
    update_id: nextMessageId++,
    callback_query: {
      id: options.callbackId ?? `cb-${nextMessageId}`,
      from: { id: options.fromId ?? CHAT, is_bot: false, first_name: "Sam" },
      data,
      message: {
        message_id: options.menuId ?? nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT, type: "private", first_name: "Sam" },
        from: { id: 424242, is_bot: true, first_name: "Converter" },
        text: "What should I make from this video?",
        ...(upload ? { reply_to_message: upload.message } : {}),
      },
    },
  };
}

async function setSettings(values: Record<string, string>): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(values)) {
    await db.insertInto("app_settings").values({ key, value, updated_at: now }).execute();
  }
  invalidateSettingsCache();
}

async function jobCount(): Promise<number> {
  const rows = await getDb().selectFrom("jobs").select("id").execute();
  return rows.length;
}


beforeAll(async () => {
  await migrateToLatest(getDb());
  const bins = await ffmpegBinaries();
  if (!bins) return;
  const made = makeIphoneClip(bins.ffmpeg, dir, { name: "menu_clip", seconds: 1, width: 480, height: 270, hdr: false });
  clipPath = made.path;
  clipBytes = made.bytes;
  silentPath = path.join(dir, "menu_silent.mp4");
  runFfmpeg(bins.ffmpeg, [
    "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", silentPath,
  ]); // fmt: skip
});

beforeEach(async () => {
  if (!clipPath) return;
  // Telegram's file ids for the two videos these tests send.
  fake = await startFakeTelegram(
    new Map([
      ["file_menu", { path: clipPath, name: "clip.mov" }],
      ["file_silent", { path: silentPath, name: "silent.mp4" }],
    ]),
  );
  await setSettings({
    telegram_bot_token: "123456:SECRET-token",
    telegram_api_url: fake.url,
    telegram_webhook_secret: SECRET,
  });
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  await getDb().deleteFrom("app_settings").execute();
  invalidateSettingsCache();
});

afterAll(() => {
  resetDbCacheForTests();
});

describe("the conversion menu", () => {
  it("answers a video with the menu, and downloads nothing until a button is pressed", async () => {
    if (!clipPath || !fake) return;
    const before = await jobCount();
    const upload = uploadUpdate("file_menu", "clip.mov");
    expect((await webhook(upload)).status).toBe(200);
    await settleBackgroundWork();

    const menu = fake.lastCall("sendMessage");
    expect(menu?.body.reply_to_message_id).toBe(upload.message.message_id);
    const keyboard = JSON.stringify(menu?.body.reply_markup);
    for (const key of ["hevc", "hevc720", "hevc480", "h264", "gif", "m4a", "mp3"]) {
      expect(keyboard).toContain(`conv:${key}`);
    }
    expect(fake.callsTo("getFile")).toHaveLength(0);
    expect(await jobCount()).toBe(before);
  });

  it("does not offer the menu for a video over this bot's size limit", async () => {
    if (!clipPath || !fake) return;
    await setSettings({ max_input_mb: "1" });
    await webhook(uploadUpdate("file_menu", "big.mov", { bytes: 5_000_000 }));
    await settleBackgroundWork();
    const replies = fake.callsTo("sendMessage");
    expect(replies.some((call) => call.body.reply_markup)).toBe(false);
    expect(String(replies[0]?.body.text ?? "")).toContain("over this bot's limit");
  });

  // One row per conversion kind: the button, the Telegram method it must use, and what to check.
  const cases = [
    { key: "hevc", method: "sendVideo", extension: ".mp4", caption: "✅" },
    { key: "h264", method: "sendVideo", extension: ".mp4", caption: "H.264 8-bit" },
    { key: "gif", method: "sendAnimation", extension: ".gif", caption: "GIF," },
    { key: "m4a", method: "sendAudio", extension: ".m4a", caption: "M4A audio" },
    { key: "mp3", method: "sendAudio", extension: ".mp3", caption: "MP3 audio" },
  ] as const;

  it.each(cases)("the $key button sends the result with $method", async ({ key, method, extension, caption }) => {
    if (!clipPath || !fake) return;
    const upload = uploadUpdate("file_menu", "clip.mov");
    await webhook(upload);
    await settleBackgroundWork();
    await webhook(pressUpdate(upload, `conv:${key}`));
    await settleBackgroundWork();

    const sent = fake.lastCall(method);
    expect(sent, `${method} should have been used for ${key}`).toBeTruthy();
    expect(String(sent!.body.caption ?? "")).toContain(caption);
    expect(Number(sent!.body.reply_to_message_id)).toBe(upload.message.message_id);

    const field = { sendVideo: "video", sendAnimation: "animation", sendAudio: "audio" }[method];
    const delivered = String(sent!.body[field]);
    const deliveredPath = delivered.replace("FILE:", "");
    expect(statSync(deliveredPath).size).toBeGreaterThan(500);
    if (extension === ".gif") expect(readFileSync(deliveredPath).subarray(0, 4).toString()).toBe("GIF8");

    const job = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("telegram_message_id", "=", upload.message.message_id)
      .executeTakeFirst();
    expect(job?.status).toBe("done");
    expect(job?.output_name?.endsWith(extension)).toBe(true);

    // The menu message stops being a menu: its buttons are removed.
    const menuEdits = fake.callsTo("editMessageText");
    const markup = (call: { body: Record<string, unknown> }) =>
      call.body.reply_markup as { inline_keyboard?: unknown[] } | undefined;
    expect(menuEdits.some((call) => Array.isArray(markup(call)?.inline_keyboard) && markup(call)!.inline_keyboard!.length === 0)).toBe(true);
  });

  it("an audio button on a video with no sound says so, and sends nothing", async () => {
    if (!clipPath || !fake) return;
    const upload = uploadUpdate("file_silent", "silent.mp4");
    await webhook(upload);
    await settleBackgroundWork();
    await webhook(pressUpdate(upload, "conv:m4a"));
    await settleBackgroundWork();

    expect(fake.callsTo("sendAudio")).toHaveLength(0);
    const texts = fake.callsTo("sendMessage").map((call) => String(call.body.text ?? ""));
    expect(texts.some((text) => text.includes(TEXT_NO_AUDIO))).toBe(true);
  });

  it("a press whose video Telegram no longer links to is treated as expired", async () => {
    if (!clipPath || !fake) return;
    const before = await jobCount();
    await webhook(pressUpdate(null, "conv:hevc", { callbackId: "cb-expired" }));
    await settleBackgroundWork();

    const answer = fake.lastCall("answerCallbackQuery");
    expect(answer?.body.text).toBe(TEXT_CHOICE_EXPIRED);
    expect(answer?.body.show_alert).toBe(true);
    expect(fake.callsTo("getFile")).toHaveLength(0);
    expect(await jobCount()).toBe(before);
  });

  it("a button this bot does not know is treated as expired", async () => {
    if (!clipPath || !fake) return;
    const upload = uploadUpdate("file_menu", "clip.mov");
    await webhook(upload);
    await settleBackgroundWork();
    const before = await jobCount();
    await webhook(pressUpdate(upload, "conv:not-a-conversion"));
    await settleBackgroundWork();

    expect(fake.lastCall("answerCallbackQuery")?.body.text).toBe(TEXT_CHOICE_EXPIRED);
    expect(await jobCount()).toBe(before);
  });

  it("someone who is not allowed to use the bot cannot press the buttons", async () => {
    if (!clipPath || !fake) return;
    await setSettings({ allowed_user_ids: "999" });
    const upload = uploadUpdate("file_menu", "clip.mov");
    const before = await jobCount();
    await webhook(pressUpdate(upload, "conv:hevc", { fromId: CHAT }));
    await settleBackgroundWork();

    const answer = fake.lastCall("answerCallbackQuery");
    expect(answer?.body.text).toBe(TEXT_PRIVATE);
    expect(answer?.body.show_alert).toBe(true);
    expect(fake.callsTo("getFile")).toHaveLength(0);
    expect(await jobCount()).toBe(before);
  });

  it("in local Bot API mode, the worker is told which conversion to make and how to send it", async () => {
    if (!clipPath || !fake) return;
    await setSettings({ telegram_local_mode: "true" });
    const upload = uploadUpdate("file_menu", "clip.mov");
    await webhook(upload);
    await settleBackgroundWork();
    await webhook(pressUpdate(upload, "conv:m4a"));
    await settleBackgroundWork();

    const job = await getDb().selectFrom("jobs").selectAll().where("telegram_message_id", "=", upload.message.message_id).executeTakeFirst();
    expect(job?.status).toBe("queued");

    const response = await workerClaim(
      new Request("http://localhost:3000/api/worker/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SECRET! },
        body: JSON.stringify({ workerId: "menu-worker" }),
      }),
    );
    const { job: claimed } = (await response.json()) as {
      job: {
        id: string;
        encoding: { conversion: string };
        output: { name: string; contentType: string };
        delivery: { mode: string; telegram?: { fileId: string | null } };
      } | null;
    };
    expect(claimed?.id).toBe(job?.id);
    expect(claimed?.encoding.conversion).toBe("m4a");
    expect(claimed?.output.name.endsWith(".m4a")).toBe(true);
    expect(claimed?.output.contentType).toBe("audio/mp4");
    expect(claimed?.delivery.mode).toBe("worker");
    expect(claimed?.delivery.telegram?.fileId).toBe("file_menu");
  });

  it("a second press on the same menu does not start a second conversion", async () => {
    if (!clipPath || !fake) return;
    const upload = uploadUpdate("file_menu", "clip.mov");
    await webhook(upload);
    await settleBackgroundWork();
    const before = await jobCount();

    await webhook(pressUpdate(upload, "conv:gif", { menuId: 4242, callbackId: "cb-first" }));
    await settleBackgroundWork();
    await webhook(pressUpdate(upload, "conv:gif", { menuId: 4242, callbackId: "cb-second" }));
    await settleBackgroundWork();

    expect(await jobCount()).toBe(before + 1);
    expect(fake.callsTo("getFile")).toHaveLength(1);
    const second = fake.calls.find((call) => call.method === "answerCallbackQuery" && call.body.callback_query_id === "cb-second");
    expect(second?.body.text).toBe(TEXT_BUSY);
  });
});
