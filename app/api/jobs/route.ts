/**
 * Jobs.
 *
 *   GET  → the job list the History page shows
 *   POST → create a job for a file that is already in storage, and either convert it here
 *          (short clips, no worker needed) or leave it queued for a worker.
 */

import { background } from "@/lib/background";
import { isDatabaseConfigured } from "@/lib/db";
import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { baseUrl, fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { inlineEligibility, runInlineJob, INLINE_CLAIM_PREFIX } from "@/lib/inline";
import {
  claimJob,
  createJob,
  jobSummary,
  listJobs,
  reapStaleJobs,
  setJobMeta,
  STAGES,
} from "@/lib/jobs/service";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { MB } from "@/lib/settings/schema";
import { getStorage } from "@/lib/storage";
import { verifyUploadToken } from "@/lib/uploads";
import type { JobSource, JobStatus } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long enough for a short clip to be converted inline. 60s works on every Vercel plan; on
// Pro/Enterprise you can raise this (here and in vercel.json) together with the
// `inline_max_seconds` setting.
export const maxDuration = 60;

interface CreateJobRequest {
  returnToken?: string;
  bytes?: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  source?: JobSource;
  /** Set to true to convert in this function even when a worker would be the better choice. */
  forceInline?: boolean;
}

export async function GET(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set, so there is no job history", 400);

    const url = new URL(request.url);
    const status = (url.searchParams.get("status") ?? "all") as JobStatus | "active" | "all";
    const source = (url.searchParams.get("source") ?? undefined) as JobSource | undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const { values: settings } = await getSettings();
    await reapStaleJobs(settings.workerMaxAttempts);
    const { jobs, total } = await listJobs({ status, source, limit, offset });
    return json({ ok: true, total, jobs: jobs.map(jobSummary) });
  } catch (error) {
    return handleRouteError(error, "GET /api/jobs");
  }
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set, so jobs cannot be stored", 400);

    const body = await readJson<CreateJobRequest>(request);
    const token = verifyUploadToken(body.returnToken);
    if (!token) return fail("returnToken is missing or has expired; upload the file again", 400);

    const { values: settings, env } = await getSettings();
    const maxBytes = settings.maxInputMb * MB;

    const storage = getStorage({ baseUrl: baseUrl(request) });
    const head = await storage.headObject(token.key);
    if (!head) {
      return fail("the upload is not in storage — the browser upload may have failed", 400);
    }
    if (head.size <= 0) return fail("the uploaded file is empty", 400);
    if (head.size > maxBytes) {
      await storage.deleteObject(token.key).catch(() => undefined);
      return fail(
        `the uploaded file is ${(head.size / MB).toFixed(1)} MB, over this deployment's limit of ${settings.maxInputMb} MB`,
        413,
      );
    }

    const fileName = token.name ?? "video.mov";
    const job = await createJob({
      source: body.source ?? "web",
      inputKey: token.key,
      inputName: fileName,
      inputBytes: head.size,
      inputContentType: head.contentType ?? token.contentType ?? null,
      crf: settings.crf,
      preset: settings.preset,
      inputProbe: {
        width: clampNumber(body.width, 0, 20000),
        height: clampNumber(body.height, 0, 20000),
        duration: clampNumber(body.duration, 0, 100000),
      },
    });

    const ffmpeg = await ffmpegStatus();
    const eligibility = inlineEligibility({
      inputBytes: head.size,
      durationSeconds: job.input_duration,
      width: job.input_width,
      height: job.input_height,
      settings,
      ffmpeg,
    });

    const willRunInline = ffmpeg.available && (body.forceInline || eligibility.ok);
    if (!willRunInline) {
      await setJobMeta(job.id, { queuedBecause: eligibility.reason });
      return json({
        ok: true,
        job: jobSummary({ ...job, message: "Waiting for a converter worker" }),
        inline: false,
        reason: eligibility.reason,
        hint: ffmpeg.available
          ? "Start a worker with `npm run worker` (or convert it here anyway)."
          : "This deployment has no ffmpeg, so a worker has to do the conversion.",
      });
    }

    const claimed = await claimJob({
      claimedBy: `${INLINE_CLAIM_PREFIX}${process.env.VERCEL_REGION ?? "local"}`,
      onlyJobId: job.id,
      maxAttempts: settings.workerMaxAttempts,
      leaseSeconds: settings.inlineMaxSeconds + 60,
    });
    if (!claimed) return json({ ok: true, job: jobSummary(job), inline: false, reason: "another converter took it" });

    log.info(`converting ${claimed.id} inline (${head.size} bytes)`);
    background(runInlineJob({ jobId: claimed.id, settings, storage }), `inline job ${claimed.id}`);

    return json({
      ok: true,
      job: jobSummary(claimed),
      inline: true,
      budgetSeconds: Math.min(settings.inlineMaxSeconds, eligibility.budgetSeconds),
      environment: env.isVercel ? "vercel" : "local",
      stages: STAGES,
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/jobs");
  }
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(Math.max(number, min), max);
}
