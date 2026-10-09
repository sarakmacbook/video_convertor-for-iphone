#!/usr/bin/env node
/**
 * The converter worker.
 *
 * Vercel functions cannot encode a long video — they have a time limit and little CPU — so
 * the heavy lifting belongs on a machine you already own: a Mac, a Raspberry Pi, a VPS or a
 * Docker container. This CLI claims jobs from the app, converts them with the exact same
 * pipeline the web UI uses, uploads the result and reports back. It needs no database
 * credentials and no storage keys: everything it touches is a signed URL.
 *
 * Usage:
 *   APP_URL=https://your-app.vercel.app WORKER_SECRET=… npm run worker
 *
 * Options:
 *   --name <name>        Name shown on the Settings page (default: hostname)
 *   --concurrency <n>    Jobs at once; x265 is CPU bound, so 1 is usually right
 *   --once               Convert one job and exit (handy for cron)
 *   --poll <seconds>     How long to wait between polls when idle (default 5)
 *   --status             Print the worker and queue status, then exit
 *   --ffmpeg <path>      Use a specific ffmpeg binary (or set FFMPEG_PATH)
 */

import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadEnvFile } from "./env";
import { getConversion, type Conversion } from "@/lib/conversions";
import { convertFile, savedPercent } from "@/lib/encoding/pipeline";
import { ffmpegStatus, type VideoInfo } from "@/lib/encoding/ffmpeg";
import { TelegramClient } from "@/lib/telegram/api";
import { sendResult } from "@/lib/telegram/send";
import { describeResult } from "@/lib/telegram/texts";
import type { ClaimJobPayload, ClaimResponse } from "@/lib/worker/protocol";

loadEnvFile();

const VERSION = "0.2.0";

interface Options {
  appUrl: string;
  secret: string;
  name: string;
  concurrency: number;
  pollSeconds: number;
  once: boolean;
  statusOnly: boolean;
  ffmpegPath: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    appUrl: (process.env.APP_URL ?? process.env.WORKER_APP_URL ?? "").replace(/\/+$/, ""),
    secret: process.env.WORKER_SECRET ?? "",
    name: process.env.WORKER_NAME ?? os.hostname(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1) || 1,
    pollSeconds: Number(process.env.WORKER_POLL_SECONDS ?? 5) || 5,
    once: false,
    statusOnly: false,
    ffmpegPath: process.env.FFMPEG_PATH ?? null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--name":
        options.name = argv[++index] ?? options.name;
        break;
      case "--concurrency":
        options.concurrency = Number(argv[++index] ?? 1) || 1;
        break;
      case "--poll":
        options.pollSeconds = Number(argv[++index] ?? 5) || 5;
        break;
      case "--once":
        options.once = true;
        break;
      case "--status":
        options.statusOnly = true;
        break;
      case "--ffmpeg":
        options.ffmpegPath = argv[++index] ?? null;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option: ${arg}`);
          printHelp();
          process.exit(2);
        }
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run worker -- [options]

Environment:
  APP_URL              Base URL of the deployment (required)
  WORKER_SECRET        Shared secret set on the deployment (required)
  WORKER_NAME          Name shown on the Settings page
  WORKER_CONCURRENCY   Jobs at once (default 1; x265 is CPU bound)
  WORKER_POLL_SECONDS  Idle poll interval (default 5)
  FFMPEG_PATH          Path to ffmpeg, when it is not on PATH
  BOT_TOKEN            Only needed when the deployment uses a local Bot API server

Options:
  --name <name>  --concurrency <n>  --poll <seconds>  --once  --status  --ffmpeg <path>`);
}

async function api<T>(options: Options, route: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${options.appUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": options.secret,
      "x-worker-id": options.name,
    },
    body: JSON.stringify({ ...body, workerId: options.name }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(`${route} failed with HTTP ${response.status}: ${payload.error ?? "unknown error"}`);
  }
  return payload;
}

async function download(url: string, target: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`could not download the original (HTTP ${response.status})`);
  const { Readable } = await import("node:stream");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(target),
  );
  return (await stat(target)).size;
}

async function upload(
  url: string,
  method: string,
  headers: Record<string, string>,
  file: string,
  contentType: string,
): Promise<void> {
  const blob = await openAsBlob(file, { type: contentType });
  const response = await fetch(url, {
    method: method || "PUT",
    headers: { "content-type": contentType, ...headers },
    body: blob,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    throw new Error(`could not upload the result (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
}

interface JobResult {
  usedOriginal: boolean;
  outputBytes: number;
  outputKey: string | null;
  outputName: string;
  output: VideoInfo | null;
  /** The codec of the result: the video's, or the audio or GIF codec the user asked for. */
  outputCodec: string;
  source: VideoInfo;
  sourceBytes: number;
  ffmpegVersion: string | null;
  logTail: string | null;
  deliveredToTelegram: boolean;
}

async function convertClaimed(options: Options, job: ClaimJobPayload, workDir: string, version: string | null): Promise<JobResult> {
  const inputPath = path.join(workDir, job.input.name ?? "input.mov");
  let deliveredFromTelegram = false;

  if (job.input.downloadUrl) {
    await download(job.input.downloadUrl, inputPath);
  } else if (job.delivery.telegram?.fileId) {
    // The deployment cannot reach the local Bot API server, so we fetch the video ourselves.
    const client = new TelegramClient({
      token: process.env.BOT_TOKEN ?? "",
      apiUrl: job.delivery.telegram.apiUrl,
      localMode: job.delivery.telegram.localMode,
    });
    if (!process.env.BOT_TOKEN) {
      throw new Error(
        "this job lives on a local Bot API server: set BOT_TOKEN on the worker so it can download the video",
      );
    }
    await client.downloadFile(job.delivery.telegram.fileId, inputPath);
    deliveredFromTelegram = true;
  } else {
    throw new Error("the claim had no way to fetch the original");
  }

  report(options, job, { stage: "converting", progress: 0.05, message: "Converting" });
  let lastReport = 0;
  const conversion = getConversion(job.encoding.conversion);

  const result = await convertFile(inputPath, {
    workDir: path.join(workDir, "out"),
    outName: job.output.name,
    conversion,
    crf: job.encoding.crf,
    preset: job.encoding.preset,
    timeoutSeconds: job.encoding.timeoutSeconds,
    ffmpeg: options.ffmpegPath ?? undefined,
    onProgress: (fraction) => {
      const now = Date.now();
      if (now - lastReport < 2000 && fraction < 1) return;
      lastReport = now;
      report(options, job, {
        stage: "converting",
        progress: 0.05 + fraction * 0.85,
        message: `Converting… ${Math.round(fraction * 100)}%`,
        status: "busy",
      });
    },
  });

  let outputKey: string | null = null;
  if (!result.usedOriginal) {
    report(options, job, { stage: "uploading", progress: 0.92, message: "Uploading the result" });
    await upload(job.output.uploadUrl, job.output.method, job.output.headers, result.outputPath, job.output.contentType);
    outputKey = job.output.key;
  }

  let deliveredToTelegram = false;
  if (job.delivery.mode === "worker" && job.delivery.telegram) {
    deliveredToTelegram = await deliver(options, job, result.usedOriginal ? inputPath : result.outputPath, {
      conversion,
      usedOriginal: result.usedOriginal,
      source: result.source,
      output: result.output,
      sourceBytes: result.sourceBytes,
      outputBytes: result.outputBytes,
      reason: result.reason,
    });
  }

  void deliveredFromTelegram;
  return {
    usedOriginal: result.usedOriginal,
    outputBytes: result.usedOriginal ? result.sourceBytes : result.outputBytes,
    outputKey,
    outputName: job.output.name,
    output: result.output,
    outputCodec: result.output?.codec ?? conversion.codec,
    source: result.source,
    sourceBytes: result.sourceBytes,
    ffmpegVersion: version,
    logTail: null,
    deliveredToTelegram,
  };
}

async function deliver(
  options: Options,
  job: ClaimJobPayload,
  filePath: string,
  result: {
    conversion: Conversion;
    usedOriginal: boolean;
    source: VideoInfo;
    output: VideoInfo | null;
    sourceBytes: number;
    outputBytes: number;
    reason: string;
  },
): Promise<boolean> {
  const telegram = job.delivery.telegram;
  if (!telegram) return false;
  const token = process.env.BOT_TOKEN ?? "";
  if (!token) {
    console.warn("this job should be delivered by the worker, but BOT_TOKEN is not set on the worker");
    return false;
  }

  const client = new TelegramClient({ token, apiUrl: telegram.apiUrl, localMode: telegram.localMode });
  const info = result.output ?? result.source;
  const caption = describeResult({
    conversion: result.conversion,
    usedOriginal: result.usedOriginal,
    reason: result.reason,
    sourceBytes: result.sourceBytes,
    outputBytes: result.outputBytes,
    savedPercent: savedPercent(result.sourceBytes, result.outputBytes, result.usedOriginal),
    width: info.width,
    height: info.height,
    duration: info.duration,
    isHdr: Boolean(info.colorTransfer && ["arib-std-b67", "smpte2084"].includes(info.colorTransfer)),
  });

  try {
    await sendResult(client, {
      chatId: telegram.chatId,
      filePath,
      conversion: result.conversion,
      usedOriginal: result.usedOriginal,
      caption,
      width: info.width,
      height: info.height,
      duration: info.duration,
    });
    if (telegram.statusMessageId) {
      await client.editMessageText(telegram.chatId, telegram.statusMessageId, "✅ Done").catch(() => undefined);
    }
    return true;
  } catch (error) {
    console.error(`could not deliver to Telegram: ${(error as Error).message}`);
    return false;
  }
}

async function report(
  options: Options,
  job: ClaimJobPayload,
  payload: { stage?: string; progress?: number; message?: string; status?: "idle" | "busy" },
): Promise<void> {
  try {
    await api(options, `/api/worker/jobs/${job.id}`, {
      action: "progress",
      report: {
        stage: payload.stage,
        progress: payload.progress,
        message: payload.message,
        status: payload.status ?? "busy",
      },
    });
  } catch (error) {
    console.warn(`could not report progress: ${(error as Error).message}`);
  }
}

async function runJob(options: Options, job: ClaimJobPayload, version: string | null): Promise<void> {
  const root = process.env.WORK_DIR?.trim() || os.tmpdir();
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(path.join(root, "worker-"));
  console.log(`→ ${job.id} ${job.input.name ?? ""} (${(job.input.bytes / 1_000_000).toFixed(1)} MB)`);

  // Keep the lease alive while a long encode runs.
  const heartbeat = setInterval(() => void report(options, job, { status: "busy" }), 90_000);

  try {
    const result = await convertClaimed(options, job, workDir, version);
    if (options.dryRun) {
      console.log(`↳ dry run: would finish ${job.id} (${result.outputBytes} bytes)`);
      return;
    }
    await api(options, `/api/worker/jobs/${job.id}`, {
      action: "complete",
      complete: {
        usedOriginal: result.usedOriginal,
        outputKey: result.outputKey,
        outputName: job.output.name,
        outputBytes: result.outputBytes,
        outputWidth: result.output?.width ?? result.source.width,
        outputHeight: result.output?.height ?? result.source.height,
        outputCodec: result.outputCodec,
        sourceBytes: result.sourceBytes,
        savedPercent: savedPercent(result.sourceBytes, result.outputBytes, result.usedOriginal),
        ffmpegVersion: result.ffmpegVersion,
        deliveredToTelegram: result.deliveredToTelegram,
        message: result.usedOriginal ? "the original was already smaller" : undefined,
      },
    });
    console.log(
      `✓ ${job.id} ${result.usedOriginal ? "kept the original" : `${(1 - result.outputBytes / result.sourceBytes) * 100 > 0 ? Math.round((1 - result.outputBytes / result.sourceBytes) * 100) : 0}% smaller`}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${job.id}: ${message}`);
    await api(options, `/api/worker/jobs/${job.id}`, {
      action: "fail",
      failure: { error: message, retryable: true },
    }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.appUrl) {
    console.error("APP_URL is not set. Example: APP_URL=https://my-app.vercel.app npm run worker");
    process.exit(2);
  }
  if (!options.secret) {
    console.error("WORKER_SECRET is not set. Copy the value from the deployment's environment variables.");
    process.exit(2);
  }
  const status = await ffmpegStatus();
  if (!status.available) {
    console.error(status.problems.join("\n"));
    process.exit(3);
  }
  if (status.problems.length) console.warn(status.problems.join("\n"));

  console.log(
    `worker "${options.name}" v${VERSION} → ${options.appUrl}\n${status.version}\nffprobe: ${status.ffprobePath ?? "not present (using ffmpeg to inspect files)"}\nconcurrency: ${options.concurrency}, poll: ${options.pollSeconds}s${options.once ? ", once" : ""}`,
  );

  const registration = await api<{
    workers: { id: string; name: string; online: boolean; status: string | null }[];
    queue: Record<string, number>;
    reaped: number;
  }>(options, "/api/worker/register", { name: options.name, version: VERSION, info: status.version });
  if (registration.reaped) console.log(`requeued ${registration.reaped} job(s) whose converter had stopped`);

  if (options.statusOnly) {
    const queue = registration.queue ?? {};
    const counts = Object.entries(queue)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => `${value} ${key}`)
      .join(", ");
    console.log(`queue: ${counts || "empty"}`);
    for (const worker of registration.workers ?? []) {
      console.log(`worker: ${worker.name} (${worker.id}) ${worker.online ? "online" : "offline"} ${worker.status ?? ""}`.trimEnd());
    }
    return;
  }

  let running = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\nfinishing the job in progress…");
    stopping = true;
  });

  while (!stopping) {
    if (running >= options.concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    let claimed: ClaimResponse;
    try {
      claimed = await api<ClaimResponse>(options, "/api/worker/claim", { name: options.name });
    } catch (error) {
      console.error(`could not reach the deployment: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, Math.max(options.pollSeconds, 10) * 1000));
      continue;
    }

    if (!claimed.job) {
      if (options.once) {
        console.log("queue is empty");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
      continue;
    }

    running += 1;
    void runJob(options, claimed.job, status.version)
      .catch((error) => console.error(`job crashed: ${(error as Error).message}`))
      .finally(() => {
        running -= 1;
        if (options.once) stopping = true;
      });

    if (options.once) {
      while (running > 0) await new Promise((resolve) => setTimeout(resolve, 200));
      return;
    }
  }

  while (running > 0) await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("worker stopped");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
