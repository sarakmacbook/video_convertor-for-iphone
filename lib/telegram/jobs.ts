/**
 * Turning Telegram messages into jobs.
 *
 * A video gets a menu of what to make from it (see `choiceKeyboard`). Nothing is downloaded or
 * converted until a button is pressed. The press carries the video back with it (the menu is a
 * reply to the video), so no state has to survive between the two webhook calls.
 *
 * Cloud Bot API (the default): the app downloads the video from Telegram, stores it, and
 * either converts it in the function or leaves it for a worker.
 *
 * Local Bot API server (`TELEGRAM_LOCAL_MODE=true`): the app is on Vercel and cannot reach
 * that server, so it only records the file reference and queues the job — the worker, which
 * runs next to the local server, downloads the video and sends the result back.
 */

import { mkdir } from "node:fs/promises";

import { getConversion, keyFromCallback, type Conversion } from "@/lib/conversions";
import { ffmpegStatus, NoAudioError } from "@/lib/encoding/ffmpeg";
import { inlineEligibility, runInlineJob, INLINE_CLAIM_PREFIX } from "@/lib/inline";
import { addEvent, claimJob, createJob, findTelegramJob, setDelivery, setJobMeta } from "@/lib/jobs/service";
import { log } from "@/lib/log";
import type { RuntimeSettings } from "@/lib/settings/schema";
import { getStorage, inputKey, sanitizeName } from "@/lib/storage";
import { randomToken } from "@/lib/storage/signing";
import { TelegramClient, TelegramError, type InlineKeyboardMarkup } from "./api";
import { choiceKeyboard, NO_BUTTONS } from "./menu";
import { checkSizeLimit, isPrivateChat, type ParsedUpdate, type TelegramMedia } from "./update";
import {
  TEXT_BUSY,
  TEXT_CHOICE_EXPIRED,
  TEXT_CHOOSE,
  TEXT_CLOUD_HINT,
  TEXT_DOWNLOADING,
  TEXT_NO_AUDIO,
  TEXT_NOT_VIDEO,
  TEXT_PRIVATE,
  TEXT_QUEUED,
  TEXT_START,
  TEXT_CLOUD_LIMITS,
  TEXT_UNREADABLE,
  TEXT_WORKER_NEEDED,
  formatMb,
} from "./texts";

export interface HandleUpdateContext {
  settings: RuntimeSettings;
  baseUrl: string;
  update: ParsedUpdate;
}

/** Where a finished (or failed) conversion is reported: the video's message and its status message. */
interface JobTarget {
  chatId: number;
  /** The message that carried the video; results are sent as replies to it. */
  uploadMessageId: number | null;
  /** The message that shows progress: the menu, edited in place. */
  statusMessageId: number | null;
  userId: number | null;
}

/** Everything except the initial replies runs here, after Telegram has been answered. */
export async function handleTelegramUpdate(context: HandleUpdateContext): Promise<void> {
  const { settings, update } = context;
  if (!update.chatId) return;

  const isPrivate = isPrivateChat(update);
  if (!isPrivate) return; // the bot works in private chats, like the polling version

  const client = new TelegramClient({
    token: settings.telegramBotToken,
    apiUrl: settings.telegramApiUrl,
    localMode: settings.telegramLocalMode,
  });

  if (update.kind === "callback") {
    await handleChoice({ ...context, client });
    return;
  }

  if (update.kind === "start" || update.kind === "help") {
    await reply(client, update, settings.telegramLocalMode ? TEXT_START : TEXT_START + TEXT_CLOUD_LIMITS);
    return;
  }

  if (!isAllowed(settings, update.userId)) {
    await reply(client, update, TEXT_PRIVATE);
    return;
  }

  if (update.kind !== "media" || !update.media) {
    await reply(client, update, TEXT_NOT_VIDEO);
    return;
  }

  const media = update.media;
  const limit = checkSizeLimit(media.fileSize, settings);
  if (limit.tooLarge) {
    const message = `This video is ${formatMb(media.fileSize)}${limit.cloudLimit ? `, over Telegram's ${limit.limitMb} MB download limit for bots` : `, over this bot's limit of ${limit.limitMb} MB`}.${
      limit.cloudLimit ? ` ${TEXT_CLOUD_HINT}` : ""
    }`;
    await reply(client, update, message);
    return;
  }

  // Ask what to make from it. The menu replies to the video, so the button press can find it.
  await reply(client, update, TEXT_CHOOSE, { replyMarkup: choiceKeyboard() });
}

/** A conversion button was pressed: start that conversion of the video the menu is about. */
async function handleChoice(context: HandleUpdateContext & { client: TelegramClient }): Promise<void> {
  const { settings, update, client, baseUrl } = context;
  const press = update.callback;
  if (!press || !update.chatId) return;
  const chatId = update.chatId;

  const answer = (text?: string, showAlert = false) =>
    client.answerCallbackQuery(press.id, { text, showAlert }).catch(() => undefined);

  if (!isAllowed(settings, press.fromId)) {
    await answer(TEXT_PRIVATE, true);
    return;
  }

  const key = keyFromCallback(press.data);
  if (!key || !press.upload || press.uploadMessageId === null) {
    // Telegram no longer has the video this menu was attached to, or the button is not ours.
    await answer(TEXT_CHOICE_EXPIRED, true);
    return;
  }

  // A second tap, or a Telegram retry, of a menu that already started a job.
  if (await findTelegramJob(chatId, press.uploadMessageId)) {
    await answer(TEXT_BUSY);
    return;
  }

  await answer(); // stops the spinner on the button
  const conversion = getConversion(key);
  log.info(`telegram job from user ${press.fromId ?? "?"}: ${conversion.key}`);

  // The menu becomes the status message and loses its buttons.
  await client.editMessageText(chatId, press.menuMessageId, TEXT_QUEUED, { replyMarkup: NO_BUTTONS }).catch(() => undefined);

  const target: JobTarget = {
    chatId,
    uploadMessageId: press.uploadMessageId,
    statusMessageId: press.menuMessageId,
    userId: press.uploadFromId ?? press.fromId,
  };

  try {
    await prepareAndRun({ settings, baseUrl, client, media: press.upload, target, conversion });
  } catch (error) {
    const message = error instanceof TelegramError ? error.description : (error as Error).message;
    log.error(`telegram job failed: ${message}`);
    await client
      .editMessageText(chatId, press.menuMessageId, "❌ Could not convert this video")
      .catch(() => undefined);
    const text = error instanceof NoAudioError ? TEXT_NO_AUDIO : TEXT_UNREADABLE;
    await client
      .sendMessage(chatId, `${text}\n\nDetails: ${message}`, { messageId: press.uploadMessageId })
      .catch(() => undefined);
  }
}

async function prepareAndRun(context: {
  settings: RuntimeSettings;
  baseUrl: string;
  client: TelegramClient;
  media: TelegramMedia;
  target: JobTarget;
  conversion: Conversion;
}): Promise<void> {
  const { settings, client, media, target, baseUrl, conversion } = context;
  const { chatId, uploadMessageId, statusMessageId, userId } = target;

  const fileName = sanitizeName(media.fileName ?? `telegram_${uploadMessageId ?? "video"}.mp4`);
  const jobIdSeed = `t_${randomToken(10)}`;
  const key = inputKey(jobIdSeed, fileName);
  const telegram = {
    chatId,
    messageId: uploadMessageId,
    statusMessageId,
    fileId: media.fileId,
    userId,
  };

  if (settings.telegramLocalMode) {
    // The worker next to the local Bot API server fetches the file itself.
    const job = await createJob({
      source: "telegram",
      inputKey: key, // a label only: nothing is written here in local mode
      inputName: fileName,
      inputBytes: media.fileSize,
      inputContentType: media.contentType ?? "video/quicktime",
      crf: settings.crf,
      preset: settings.preset,
      inputProbe: { width: media.width, height: media.height, duration: media.duration },
      telegram,
      meta: { inputSource: "telegram-local", stored: false, conversion: conversion.key },
    });
    await addEvent(job.id, "info", "waiting for a worker with access to the local Bot API server");
    await setDelivery(job.id, "pending");
    return;
  }

  // Cloud mode: fetch the video now so any worker can pick the job up from storage.
  if (statusMessageId) {
    await client.editMessageText(chatId, statusMessageId, TEXT_DOWNLOADING, { replyMarkup: NO_BUTTONS }).catch(() => undefined);
  }
  const storage = getStorage({ baseUrl });
  const tmpBase = process.env.WORK_DIR?.trim() || "/tmp";
  await mkdir(tmpBase, { recursive: true });
  const tmpPath = `${tmpBase}/tg-${randomToken(8)}-${fileName}`;
  const bytes = await client.downloadFile(media.fileId, tmpPath);
  const { readFile, rm, stat } = await import("node:fs/promises");
  const info = await stat(tmpPath);
  const buffer = await readFile(tmpPath);
  await rm(tmpPath, { force: true });
  await storage.putObject(key, buffer, media.contentType ?? "video/quicktime");

  const job = await createJob({
    source: "telegram",
    inputKey: key,
    inputName: fileName,
    inputBytes: info.size || bytes || media.fileSize,
    inputContentType: media.contentType ?? "video/quicktime",
    crf: settings.crf,
    preset: settings.preset,
    inputProbe: { width: media.width, height: media.height, duration: media.duration },
    telegram,
    meta: { inputSource: "telegram", conversion: conversion.key },
  });
  await addEvent(job.id, "info", `received from Telegram (${formatMb(info.size)})`);

  const ffmpeg = await ffmpegStatus();
  const eligibility = inlineEligibility({
    inputBytes: info.size,
    durationSeconds: job.input_duration,
    width: job.input_width,
    height: job.input_height,
    settings,
    ffmpeg,
  });

  if (!ffmpeg.available || !eligibility.ok) {
    await setJobMeta(job.id, { queuedBecause: eligibility.reason });
    await addEvent(job.id, "info", `queued for a worker: ${eligibility.reason}`);
    if (statusMessageId) {
      await client.editMessageText(chatId, statusMessageId, TEXT_WORKER_NEEDED).catch(() => undefined);
    }
    return;
  }

  const claimed = await claimJob({
    claimedBy: `${INLINE_CLAIM_PREFIX}${process.env.VERCEL_REGION ?? "local"}`,
    onlyJobId: job.id,
    maxAttempts: settings.workerMaxAttempts,
    leaseSeconds: settings.inlineMaxSeconds + 60,
  });
  if (!claimed) return;

  await runInlineJob({ jobId: claimed.id, settings, storage });
}

export async function reply(
  client: TelegramClient,
  update: ParsedUpdate,
  text: string,
  options: { replyMarkup?: InlineKeyboardMarkup } = {},
): Promise<{ message_id: number } | null> {
  if (!update.chatId) return null;
  try {
    return await client.sendMessage(update.chatId, text, {
      messageId: update.messageId ?? undefined,
      replyMarkup: options.replyMarkup,
    });
  } catch (error) {
    log.warn(`could not reply on Telegram: ${(error as Error).message}`);
    return null;
  }
}

export function isAllowed(settings: RuntimeSettings, userId: number | null): boolean {
  if (settings.allowedUserIds.length === 0) return true;
  return userId !== null && settings.allowedUserIds.includes(userId);
}

