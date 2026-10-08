/**
 * One job: read it, act on it, delete it.
 *
 *   GET    → the job, its download link and its activity log (the UI polls this)
 *   PATCH  → actions: cancel, retry, convert-here, deliver
 *   DELETE → remove the job, its log and its files
 */

import { background } from "@/lib/background";
import { isDatabaseConfigured } from "@/lib/db";
import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { baseUrl, fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { inlineEligibility, runInlineJob, INLINE_CLAIM_PREFIX } from "@/lib/inline";
import { createDownloadLink } from "@/lib/jobs/downloads";
import {
  addEvent,
  cancelJob,
  claimJob,
  deleteJob,
  getJob,
  jobSummary,
  listEvents,
  requeueJob,
  setJobMeta,
} from "@/lib/jobs/service";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { deliverToTelegram } from "@/lib/telegram/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);

    const { values: settings } = await getSettings();
    const storage = getStorage({ baseUrl: baseUrl(request) });
    const download = await createDownloadLink(job, storage).catch((error) => {
      log.warn(`could not create a download link for ${job.id}: ${(error as Error).message}`);
      return null;
    });
    const events = await listEvents(job.id);

    return json({
      ok: true,
      job: jobSummary(job),
      download,
      events,
      settings: {
        inlineMaxInputMb: settings.inlineMaxInputMb,
        inlineMaxSeconds: settings.inlineMaxSeconds,
        telegramConfigured: Boolean(settings.telegramBotToken),
        telegramDelivery: settings.telegramDelivery,
      },
    });
  } catch (error) {
    return handleRouteError(error, "GET /api/jobs/[id]");
  }
}

interface ActionRequest {
  action?: "cancel" | "retry" | "convert-here" | "deliver" | "clear-error";
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);

    const body = await readJson<ActionRequest>(request);
    const { values: settings } = await getSettings();
    const storage = getStorage({ baseUrl: baseUrl(request) });

    switch (body.action) {
      case "cancel": {
        const updated = await cancelJob(job.id);
        return json({ ok: true, job: updated ? jobSummary(updated) : null });
      }
      case "retry": {
        const requeued = await requeueJob(job.id);
        const ffmpeg = await ffmpegStatus();
        const eligibility = inlineEligibility({
          inputBytes: job.input_bytes,
          durationSeconds: job.input_duration,
          width: job.input_width,
          height: job.input_height,
          settings,
          ffmpeg,
        });
        if (ffmpeg.available && eligibility.ok) {
          const claimed = await claimJob({
            claimedBy: `${INLINE_CLAIM_PREFIX}${process.env.VERCEL_REGION ?? "local"}`,
            onlyJobId: job.id,
            maxAttempts: settings.workerMaxAttempts,
            leaseSeconds: settings.inlineMaxSeconds + 60,
          });
          if (claimed) {
            background(runInlineJob({ jobId: claimed.id, settings, storage }), `retry job ${claimed.id}`);
            return json({ ok: true, job: jobSummary(claimed), inline: true });
          }
        }
        return json({ ok: true, job: requeued ? jobSummary(requeued) : null, inline: false, reason: eligibility.reason });
      }
      case "convert-here": {
        // An explicit "do it anyway": the function may run out of time, which the UI warns about.
        const claimed = await claimJob({
          claimedBy: `${INLINE_CLAIM_PREFIX}${process.env.VERCEL_REGION ?? "local"}`,
          onlyJobId: job.id,
          maxAttempts: settings.workerMaxAttempts,
          leaseSeconds: settings.inlineMaxSeconds + 60,
        });
        if (!claimed) return fail(`this job is ${job.status}, so it cannot be started here`, 409);
        background(runInlineJob({ jobId: claimed.id, settings, storage }), `manual inline job ${claimed.id}`);
        return json({ ok: true, job: jobSummary(claimed), inline: true });
      }
      case "deliver": {
        const result = await deliverToTelegram({ jobId: job.id, settings, storage });
        return result.ok
          ? json({ ok: true, job: jobSummary((await getJob(job.id))!) })
          : fail(result.reason ?? "delivery failed", 502);
      }
      case "clear-error": {
        await requeueJob(job.id);
        await cancelJob(job.id);
        await addEvent(job.id, "info", "error cleared");
        return json({ ok: true, job: jobSummary((await getJob(job.id))!) });
      }
      default:
        return fail("action must be cancel, retry, convert-here, deliver or clear-error");
    }
  } catch (error) {
    return handleRouteError(error, "PATCH /api/jobs/[id]");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);

    const url = new URL(request.url);
    const keepFiles = url.searchParams.get("keepFiles") === "true";
    if (!keepFiles) {
      const storage = getStorage({ baseUrl: baseUrl(request) });
      const keys = new Set<string>([job.input_key, job.output_key ?? ""]);
      for (const key of keys) {
        if (!key) continue;
        await storage.deleteObject(key).catch((error) => log.warn(`could not delete ${key}: ${(error as Error).message}`));
      }
    }
    await deleteJob(job.id);
    await setJobMeta(job.id, { deleted: true });
    return json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "DELETE /api/jobs/[id]");
  }
}
