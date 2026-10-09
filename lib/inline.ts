/**
 * Converting inside the app itself.
 *
 * A serverless function can do this for a short clip: download the original from storage,
 * run ffmpeg in the function's temporary directory, and put the result back. Long or large
 * videos are left in the queue for a worker, because a function has a time limit
 * (`maxDuration`) and a fixed amount of memory.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { conversionOfMeta } from "@/lib/conversions";
import {
  type FfmpegStatus,
  EncodeTimeoutError,
  estimateEncodeSeconds,
  ffmpegStatus,
  MediaError,
  NoAudioError,
  probe,
} from "@/lib/encoding/ffmpeg";
import { convertFile, savedPercent } from "@/lib/encoding/pipeline";
import { log } from "@/lib/log";
import type { RuntimeSettings } from "@/lib/settings/schema";
import { MB } from "@/lib/settings/schema";
import { conversionName, type Storage } from "@/lib/storage";
import { outputKey as buildOutputKey } from "@/lib/storage";
import {
  addEvent,
  completeJob,
  failJob,
  getJob,
  setDelivery,
  setInputProbe,
  updateProgress,
  type Job,
} from "@/lib/jobs/service";
import { deliverToTelegram, telegramConfigured } from "@/lib/telegram/delivery";

export const INLINE_CLAIM_PREFIX = "inline:";

export interface EligibilityInput {
  inputBytes: number;
  durationSeconds: number | null;
  /** Video geometry when it is known (the browser reports it while uploading). */
  width?: number | null;
  height?: number | null;
  settings: RuntimeSettings;
  ffmpeg: FfmpegStatus | null;
  /** Seconds left in the function before Vercel kills it. */
  budgetSeconds?: number;
}

export interface Eligibility {
  ok: boolean;
  reason: string;
  estimatedSeconds: number | null;
  budgetSeconds: number;
}

/**
 * Can this job finish inside a function call? The answer must be honest: guessing wrong
 * means a job that is killed halfway, which looks like a stuck conversion to the user.
 */
export function inlineEligibility(input: EligibilityInput): Eligibility {
  const budgetSeconds = input.budgetSeconds ?? input.settings.inlineMaxSeconds;

  if (!input.ffmpeg?.available) {
    return { ok: false, reason: "ffmpeg is not available in this deployment", estimatedSeconds: null, budgetSeconds };
  }
  if (input.inputBytes > input.settings.inlineMaxInputMb * MB) {
    return {
      ok: false,
      reason: `the file is larger than the inline limit of ${input.settings.inlineMaxInputMb} MB`,
      estimatedSeconds: null,
      budgetSeconds,
    };
  }
  if (!input.durationSeconds || input.durationSeconds <= 0) {
    // Without a duration the only guard left is the size limit above.
    return { ok: true, reason: "size is within the inline limit", estimatedSeconds: null, budgetSeconds };
  }

  const estimated = estimateEncodeSeconds(
    {
      codec: "hevc",
      width: input.width && input.width > 0 ? input.width : 1920,
      height: input.height && input.height > 0 ? input.height : 1080,
      rotation: 0,
      duration: input.durationSeconds,
      fps: null,
      pixFmt: null,
      bitDepth: 8,
      colorPrimaries: null,
      colorTransfer: null,
      colorSpace: null,
      colorRange: null,
      audioCodec: null,
    },
    { speedFactor: input.settings.inlineSpeedFactor, preset: input.settings.preset },
  );
  if (estimated > budgetSeconds) {
    return {
      ok: false,
      reason: `converting this video would take about ${Math.round(estimated)}s, over the ${Math.round(budgetSeconds)}s a serverless function is allowed`,
      estimatedSeconds: estimated,
      budgetSeconds,
    };
  }
  return { ok: true, reason: "fits in the inline time budget", estimatedSeconds: estimated, budgetSeconds };
}

export interface RunInlineOptions {
  jobId: string;
  settings: RuntimeSettings;
  storage: Storage;
  ffmpeg?: FfmpegStatus;
  /** Set to false when Telegram delivery is done by the worker instead. */
  deliver?: boolean;
}

export interface InlineOutcome {
  status: "done" | "failed" | "skipped";
  message: string;
}

export async function runInlineJob(options: RunInlineOptions): Promise<InlineOutcome> {
  const job = await getJob(options.jobId);
  if (!job) return { status: "skipped", message: "job not found" };
  if (job.status !== "running") return { status: "skipped", message: `job is ${job.status}` };

  const status = options.ffmpeg ?? (await ffmpegStatus());
  if (!status.available || !status.path) {
    const message = status.problems[0] ?? "ffmpeg is not available";
    await failJob(job.id, { error: message, retryable: false });
    return { status: "failed", message };
  }

  const workRoot = process.env.WORK_DIR?.trim() || os.tmpdir();
  await mkdir(workRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(workRoot, "convert-"));
  const timeoutSeconds = Math.max(30, Math.round(options.settings.inlineMaxSeconds));
  const leaseSeconds = timeoutSeconds + 60;
  const claimedBy = `${INLINE_CLAIM_PREFIX}${process.env.VERCEL_REGION ?? os.hostname()}`;

  try {
    await updateProgress(job.id, {
      stage: "downloading",
      message: "Downloading the original",
      progress: 0.01,
      leaseSeconds,
      claimedBy,
    });

    const inputPath = path.join(workDir, sanitizeFileName(job.input_name ?? "input.mov"));
    const downloaded = await downloadToFile(options.storage, job.input_key, inputPath);
    await addEvent(job.id, "info", `downloaded ${downloaded} bytes`);

    const source = await probe(inputPath, status.path, status.ffprobePath);
    await setInputProbe(job.id, {
      width: source.width,
      height: source.height,
      duration: source.duration,
      codec: source.codec,
      isHdr: Boolean(source.colorTransfer && ["arib-std-b67", "smpte2084"].includes(source.colorTransfer)),
    });

    const conversion = conversionOfMeta(job.meta);
    const outName = conversionName(job.input_name, conversion);
    let lastReport = 0;
    let lastTelegramEdit = 0;
    const result = await convertFile(inputPath, {
      workDir: path.join(workDir, "out"),
      outName,
      conversion,
      crf: job.crf ?? options.settings.crf,
      preset: job.preset ?? options.settings.preset,
      timeoutSeconds,
      ffmpeg: status.path,
      ffprobe: status.ffprobePath,
      onProgress: async (fraction, message) => {
        const now = Date.now();
        if (now - lastReport < 1_500 && fraction < 1) return;
        lastReport = now;
        await jobProgress(job, fraction, message, leaseSeconds, claimedBy);
        if (options.deliver !== false && job.telegram_chat_id && now - lastTelegramEdit > 5_000 && fraction < 0.99) {
          lastTelegramEdit = now;
          await telegramProgress(options, job, fraction);
        }
      },
    });

    await updateProgress(job.id, {
      stage: "uploading",
      message: "Uploading the result",
      progress: 0.98,
      leaseSeconds,
      claimedBy,
    });

    let outputStoredKey: string | null = null;
    let outputBytes = result.outputBytes;
    if (result.usedOriginal) {
      outputStoredKey = job.input_key;
      outputBytes = job.input_bytes;
      await addEvent(job.id, "info", `keeping the original: ${result.reason}`);
    } else {
      outputStoredKey = buildOutputKey(job.id, outName);
      const buffer = await readFile(result.outputPath);
      await options.storage.putObject(outputStoredKey, buffer, conversion.mimeType);
      await addEvent(job.id, "info", `uploaded ${buffer.byteLength} bytes to storage`);
    }

    const percent = savedPercent(result.sourceBytes, outputBytes, result.usedOriginal);
    await completeJob(job.id, {
      outputKey: outputStoredKey,
      outputName: outName,
      outputBytes,
      usedOriginal: result.usedOriginal,
      sourceBytes: result.sourceBytes,
      outputWidth: result.output?.width ?? result.source.width,
      outputHeight: result.output?.height ?? result.source.height,
      outputCodec: result.output?.codec ?? conversion.codec,
      savedPercent: percent,
      workerName: "inline",
      ffmpegVersion: status.version,
      message: result.usedOriginal ? result.reason : `${Math.round(percent)}% smaller`,
    });

    if (options.deliver !== false && job.telegram_chat_id && telegramConfigured(options.settings)) {
      const delivered = await deliverToTelegram({
        jobId: job.id,
        settings: options.settings,
        storage: options.storage,
        localFilePath: result.usedOriginal ? inputPath : result.outputPath,
      });
      if (!delivered.ok && delivered.reason) {
        log.warn(`Telegram delivery failed for ${job.id}: ${delivered.reason}`);
      }
    }

    return { status: "done", message: `converted ${result.sourceBytes} → ${outputBytes} bytes` };
  } catch (error) {
    const message = describeError(error);
    // A file we cannot read will not read any better on a second try; a crash might.
    const retryable = !(error instanceof MediaError);
    await failJob(job.id, { error: message, retryable, maxAttempts: options.settings.workerMaxAttempts });
    if (job.telegram_chat_id) {
      await setDelivery(job.id, "failed", message);
      if (options.settings.telegramDelivery !== "off" && telegramConfigured(options.settings)) {
        await telegramFailure(options, job, message, error instanceof NoAudioError);
      }
    }
    return { status: "failed", message };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadToFile(storage: Storage, key: string, target: string): Promise<number> {
  const object = await storage.getObject(key);
  if (!object?.body) throw new MediaError(`the uploaded file (${key}) is no longer in storage`);
  await pipeline(
    Readable.fromWeb(object.body as Parameters<typeof Readable.fromWeb>[0]),
    (await import("node:fs")).createWriteStream(target),
  );
  const info = await stat(target);
  return info.size;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "input.mov";
}

async function jobProgress(
  job: Job,
  fraction: number,
  _message: string | undefined,
  leaseSeconds: number,
  claimedBy: string,
): Promise<void> {
  await updateProgress(job.id, {
    stage: "converting",
    progress: Math.min(0.97, fraction * 0.95 + 0.02),
    message: `Converting… ${Math.round(fraction * 100)}%`,
    leaseSeconds,
    claimedBy,
  });
}

async function telegramProgress(options: RunInlineOptions, job: Job, fraction: number): Promise<void> {
  if (!job.telegram_chat_id || !job.telegram_status_message_id) return;
  if (options.settings.telegramDelivery === "off" || !telegramConfigured(options.settings)) return;
  const { TelegramClient } = await import("@/lib/telegram/api");
  const client = new TelegramClient({
    token: options.settings.telegramBotToken,
    apiUrl: options.settings.telegramApiUrl,
    localMode: options.settings.telegramLocalMode,
  });
  const { convertingText } = await import("@/lib/telegram/texts");
  // Telegram rate-limits edits; failures here are cosmetic and must never fail the job.
  await client
    .editMessageText(job.telegram_chat_id, job.telegram_status_message_id, convertingText(Math.round(fraction * 100)))
    .catch(() => undefined);
}

async function telegramFailure(options: RunInlineOptions, job: Job, message: string, noSound: boolean): Promise<void> {
  const { TelegramClient } = await import("@/lib/telegram/api");
  const client = new TelegramClient({
    token: options.settings.telegramBotToken,
    apiUrl: options.settings.telegramApiUrl,
    localMode: options.settings.telegramLocalMode,
  });
  const { TEXT_FAILED, TEXT_NO_AUDIO } = await import("@/lib/telegram/texts");
  if (job.telegram_status_message_id) {
    await client
      .editMessageText(job.telegram_chat_id!, job.telegram_status_message_id, "❌ Could not convert this video")
      .catch(() => undefined);
  }
  const headline = noSound ? TEXT_NO_AUDIO : TEXT_FAILED;
  await client.sendMessage(job.telegram_chat_id!, `${headline}\n\nDetails: ${message}`).catch(() => undefined);
}

function describeError(error: unknown): string {
  if (error instanceof EncodeTimeoutError) {
    return "converting this video took longer than the function is allowed to run. Start a worker (`npm run worker`) and try again.";
  }
  if (error instanceof MediaError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
