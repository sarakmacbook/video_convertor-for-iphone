/**
 * Sending a finished conversion back to Telegram.
 *
 * The app does this by default ("server" mode): it fetches the result from storage and calls
 * `sendVideo`. That keeps the bot token in one place. When the bot talks to a self-hosted Bot
 * API server on someone's Mac (`TELEGRAM_LOCAL_MODE=true`), a Vercel function cannot reach it,
 * so the job is marked for the worker to deliver instead.
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { log } from "@/lib/log";
import type { RuntimeSettings } from "@/lib/settings/schema";
import { CLOUD_UPLOAD_LIMIT_MB, LOCAL_SERVER_LIMIT_MB, MB } from "@/lib/settings/schema";
import { convertedName, type Storage } from "@/lib/storage";
import { getJob, setDelivery, type Job } from "@/lib/jobs/service";
import { deliveryKey } from "@/lib/jobs/downloads";
import { TelegramClient } from "./api";
import { describeResult, formatMb, TEXT_DONE, TEXT_TOO_LARGE_TO_SEND } from "./texts";

export function telegramConfigured(settings: RuntimeSettings): boolean {
  return Boolean(settings.telegramBotToken) && settings.telegramDelivery !== "off";
}

export function telegramClientFor(settings: RuntimeSettings): TelegramClient {
  return new TelegramClient({
    token: settings.telegramBotToken,
    apiUrl: settings.telegramApiUrl,
    localMode: settings.telegramLocalMode,
  });
}

export function uploadLimitBytes(settings: RuntimeSettings): number {
  const local = settings.telegramLocalMode || settings.telegramApiUrl !== "https://api.telegram.org";
  return (local ? LOCAL_SERVER_LIMIT_MB : CLOUD_UPLOAD_LIMIT_MB) * MB;
}

export interface DeliveryOptions {
  jobId: string;
  settings: RuntimeSettings;
  storage: Storage;
  /** A file already on this machine's disk (inline conversions have one). */
  localFilePath?: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  reason?: string;
}

export async function deliverToTelegram(options: DeliveryOptions): Promise<DeliveryResult> {
  const job = await getJob(options.jobId);
  if (!job) return { ok: false, reason: "job not found" };
  if (!job.telegram_chat_id) return { ok: false, reason: "this job did not come from Telegram" };
  if (!telegramConfigured(options.settings)) {
    await setDelivery(job.id, "failed", "no Telegram bot token is configured");
    return { ok: false, reason: "no Telegram bot token is configured" };
  }
  if (options.settings.telegramDelivery === "worker" && !options.localFilePath) {
    // A worker with access to the local Bot API server will send this one.
    return { ok: true, reason: "left for the worker to deliver" };
  }
  if (job.status !== "done") return { ok: false, reason: `job is ${job.status}` };

  const target = deliveryKey(job);
  if (!target) return { ok: false, reason: "the job has no result file" };

  const limit = uploadLimitBytes(options.settings);
  if (target.bytes > limit) {
    const text = TEXT_TOO_LARGE_TO_SEND.replace("{size}", formatMb(target.bytes)).replace(
      "{limit}",
      formatMb(limit),
    );
    await setDelivery(job.id, "failed", text);
    await safeSendMessage(options.settings, job.telegram_chat_id, `${text} You can download it from the web UI.`);
    return { ok: false, reason: text };
  }

  let workDir: string | null = null;
  try {
    let filePath = options.localFilePath ?? null;
    if (!filePath || !(await exists(filePath))) {
      workDir = await mkdtemp(path.join(process.env.WORK_DIR?.trim() || os.tmpdir(), "deliver-"));
      filePath = path.join(workDir, sanitize(target.name));
      const object = await options.storage.getObject(target.key);
      if (!object?.body) throw new Error("the result file is no longer in storage");
      await pipeline(
        Readable.fromWeb(object.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(filePath),
      );
    }

    const client = telegramClientFor(options.settings);
    const caption = describeResult({
      usedOriginal: target.kind === "original",
      reason: job.message ?? "",
      sourceBytes: job.input_bytes,
      outputBytes: target.bytes,
      savedPercent: job.saved_percent ?? 0,
      width: job.output_width ?? job.input_width,
      height: job.output_height ?? job.input_height,
      duration: job.input_duration,
      isHdr: job.input_is_hdr === 1,
    });

    if (target.kind === "original") {
      await client.sendDocument(job.telegram_chat_id, filePath, {
        caption,
        replyToMessageId: job.telegram_message_id ?? undefined,
      });
    } else {
      await client.sendVideo(job.telegram_chat_id, filePath, {
        caption,
        width: job.output_width ?? job.input_width,
        height: job.output_height ?? job.input_height,
        duration: job.input_duration,
        replyToMessageId: job.telegram_message_id ?? undefined,
      });
    }

    if (job.telegram_status_message_id) {
      await client
        .editMessageText(job.telegram_chat_id, job.telegram_status_message_id, TEXT_DONE)
        .catch(() => undefined);
    }
    await setDelivery(job.id, "sent");
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`could not deliver job ${job.id} to Telegram: ${reason}`);
    await setDelivery(job.id, "failed", reason);
    return { ok: false, reason };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function safeSendMessage(settings: RuntimeSettings, chatId: number, text: string): Promise<void> {
  try {
    await telegramClientFor(settings).sendMessage(chatId, text);
  } catch (error) {
    log.debug(`could not send a Telegram message: ${(error as Error).message}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "video.mp4";
}

export { convertedName };
