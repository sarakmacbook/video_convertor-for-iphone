/**
 * Turning a Telegram message into a job.
 *
 * Cloud Bot API (the default): the app downloads the video from Telegram, stores it, and
 * either converts it in the function or leaves it for a worker.
 *
 * Local Bot API server (`TELEGRAM_LOCAL_MODE=true`): the app is on Vercel and cannot reach
 * that server, so it only records the file reference and queues the job — the worker, which
 * runs next to the local server, downloads the video and sends the result back.
 */

import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { inlineEligibility, runInlineJob, INLINE_CLAIM_PREFIX } from "@/lib/inline";
import { addEvent, claimJob, createJob, setDelivery, setJobMeta } from "@/lib/jobs/service";
import { log } from "@/lib/log";
import type { RuntimeSettings } from "@/lib/settings/schema";
import { getStorage, inputKey, sanitizeName } from "@/lib/storage";
import { randomToken } from "@/lib/storage/signing";
import { TelegramClient, TelegramError } from "./api";
import { checkSizeLimit, isPrivateChat, type ParsedUpdate, type TelegramMedia } from "./update";
import {
  TEXT_CLOUD_HINT,
  TEXT_DOWNLOADING,
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

  const statusMessage = await reply(client, update, TEXT_QUEUED);
  const statusMessageId = statusMessage?.message_id ?? null;

  try {
    await prepareAndRun({ ...context, client, media, statusMessageId });
  } catch (error) {
    const message = error instanceof TelegramError ? error.description : (error as Error).message;
    log.error(`telegram job failed: ${message}`);
    if (statusMessageId) {
      await client
        .editMessageText(update.chatId, statusMessageId, "❌ Could not convert this video")
        .catch(() => undefined);
    }
    await client.sendMessage(update.chatId, `${TEXT_UNREADABLE}\n\nDetails: ${message}`).catch(() => undefined);
  }
}

async function prepareAndRun(
  context: HandleUpdateContext & { client: TelegramClient; media: TelegramMedia; statusMessageId: number | null },
): Promise<void> {
  const { settings, client, media, update, baseUrl, statusMessageId } = context;
  if (!update.chatId) return;

  const fileName = sanitizeName(media.fileName ?? `telegram_${update.messageId ?? "video"}.mp4`);
  const jobIdSeed = `t_${randomToken(10)}`;
  const key = inputKey(jobIdSeed, fileName);

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
      telegram: {
        chatId: update.chatId,
        messageId: update.messageId,
        statusMessageId,
        fileId: media.fileId,
        userId: update.userId,
      },
      meta: { inputSource: "telegram-local", stored: false },
    });
    await addEvent(job.id, "info", "waiting for a worker with access to the local Bot API server");
    await setDelivery(job.id, "pending");
    return;
  }

  // Cloud mode: fetch the video now so any worker can pick the job up from storage.
  if (statusMessageId) {
    await client.editMessageText(update.chatId, statusMessageId, TEXT_DOWNLOADING).catch(() => undefined);
  }
  const storage = getStorage({ baseUrl });
  const tmpBase = process.env.WORK_DIR?.trim() || "/tmp";
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
    telegram: {
      chatId: update.chatId,
      messageId: update.messageId,
      statusMessageId,
      fileId: media.fileId,
      userId: update.userId,
    },
    meta: { inputSource: "telegram" },
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
      await client.editMessageText(update.chatId, statusMessageId, TEXT_WORKER_NEEDED).catch(() => undefined);
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
): Promise<{ message_id: number } | null> {
  if (!update.chatId) return null;
  try {
    return await client.sendMessage(update.chatId, text, { messageId: update.messageId ?? undefined });
  } catch (error) {
    log.warn(`could not reply on Telegram: ${(error as Error).message}`);
    return null;
  }
}

export function isAllowed(settings: RuntimeSettings, userId: number | null): boolean {
  if (settings.allowedUserIds.length === 0) return true;
  return userId !== null && settings.allowedUserIds.includes(userId);
}
