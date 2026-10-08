/**
 * Health and capability report.
 *
 * This is the answer to "why didn't my video convert?" — it reports the database, storage,
 * ffmpeg, Telegram webhook and worker state in one place, and the web UI shows it as a banner.
 */

import { databaseStatus, isDatabaseConfigured } from "@/lib/db";
import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { listJobs, listWorkers, reapStaleJobs } from "@/lib/jobs/service";
import { log } from "@/lib/log";
import { usingEphemeralSecret } from "@/lib/storage";
import { storageDriverName } from "@/lib/storage";
import { getSettings } from "@/lib/settings";
import { telegramConfigured, telegramClientFor, uploadLimitBytes } from "@/lib/telegram/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { values: settings, env, envProblems } = await getSettings();

  const database = await databaseStatus().catch((error) => ({
    configured: isDatabaseConfigured(),
    connected: false,
    tables: [],
    migrations: [],
    error: error instanceof Error ? error.message : String(error),
  }));

  const ffmpeg = await ffmpegStatus();
  let workers: Awaited<ReturnType<typeof listWorkers>> = [];
  let jobs: Record<string, number> = {};
  if (database.connected) {
    try {
      await reapStaleJobs(settings.workerMaxAttempts);
      workers = await listWorkers();
      const { jobs: recent } = await listJobs({ limit: 1 });
      void recent;
      const { countJobsByStatus } = await import("@/lib/jobs/service");
      jobs = await countJobsByStatus();
    } catch (error) {
      log.warn(`health: could not read the job tables: ${(error as Error).message}`);
    }
  }

  let storage: { driver: string; ok: boolean; detail: string } = {
    driver: env.storageDriver,
    ok: false,
    detail: "not checked",
  };
  try {
    const { getStorage } = await import("@/lib/storage");
    storage = { driver: storageDriverName(), ok: false, detail: "not checked" };
    if (database.connected) {
      const result = await getStorage({ baseUrl: "http://localhost" }).test();
      storage = { driver: storageDriverName(), ok: result.ok, detail: result.detail };
    }
  } catch (error) {
    storage = { driver: env.storageDriver, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  let telegram: { configured: boolean; webhook: string | null; error?: string } = {
    configured: telegramConfigured(settings),
    webhook: null,
  };
  if (telegram.configured) {
    try {
      const info = await telegramClientFor(settings).getWebhookInfo();
      telegram.webhook = info.url || null;
    } catch (error) {
      telegram.error = error instanceof Error ? error.message : String(error);
    }
  }

  const onlineWorkers = workers.filter((worker) => worker.online);
  const canConvertInline = ffmpeg.available;
  const canConvertAtAll = canConvertInline || onlineWorkers.length > 0;

  const problems: string[] = [...envProblems];
  if (!database.configured) problems.push("DATABASE_URL is not set: jobs and settings cannot be stored.");
  else if (!database.connected) problems.push(`the database could not be reached: ${database.error ?? "unknown error"}`);
  if (!storage.ok && storage.detail !== "not checked") problems.push(`storage is not usable: ${storage.detail}`);
  if (!ffmpeg.available) {
    problems.push(
      "ffmpeg is not available in this deployment, so videos can only be converted by a worker (`npm run worker`).",
    );
  }
  if (!env.appPassword) {
    problems.push("APP_PASSWORD is not set, so anyone with the URL can use this deployment.");
  }
  if (usingEphemeralSecret()) {
    problems.push(
      "APP_SECRET is not set: download links stop working when the deployment restarts and are not shared between instances.",
    );
  }

  return Response.json(
    {
      ok: problems.length === 0,
      version: process.env.npm_package_version ?? "0.2.0",
      time: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      database,
      storage,
      ffmpeg: {
        available: ffmpeg.available,
        path: ffmpeg.path,
        version: ffmpeg.version,
        hasX265: ffmpeg.hasX265,
        source: ffmpeg.source,
        ffprobe: ffmpeg.ffprobePath,
      },
      telegram: { ...telegram, delivery: settings.telegramDelivery, localMode: settings.telegramLocalMode, uploadLimitBytes: uploadLimitBytes(settings) },
      workers: { online: onlineWorkers.length, total: workers.length, list: workers },
      jobs,
      inline: {
        available: canConvertInline,
        maxInputMb: settings.inlineMaxInputMb,
        budgetSeconds: settings.inlineMaxSeconds,
        speedFactor: settings.inlineSpeedFactor,
      },
      canConvert: canConvertAtAll,
      authRequired: Boolean(env.appPassword),
      problems,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
