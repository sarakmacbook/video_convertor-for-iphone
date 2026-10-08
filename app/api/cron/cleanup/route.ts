/**
 * Housekeeping: delete jobs (and their files) older than `job_retention_days`, plus worker
 * rows and log lines that are no longer useful.
 *
 * Called by a Vercel Cron job (see `vercel.json`), by any scheduler, or by hand with the
 * session cookie. Set `CRON_SECRET` to protect it — Vercel adds
 * `Authorization: Bearer $CRON_SECRET` to cron invocations automatically.
 */

import { baseUrl, checkWebhookSecret, fail, handleRouteError, isAuthorized, json } from "@/lib/http";
import { deleteJob, listJobs, reapStaleJobs } from "@/lib/jobs/service";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  try {
    const cronSecret = (process.env.CRON_SECRET ?? "").trim();
    const header = request.headers.get("authorization") ?? "";
    const fromCron = cronSecret
      ? header.toLowerCase() === `bearer ${cronSecret.toLowerCase()}` || checkWebhookSecret(header.replace(/^Bearer\s+/i, ""), cronSecret)
      : false;

    if (!fromCron && !isAuthorized(request)) {
      return fail("not allowed: send the session cookie, or set CRON_SECRET and pass it as a bearer token", 401);
    }

    const { values: settings } = await getSettings();
    const storage = getStorage({ baseUrl: baseUrl(request) });
    const db = getDb();

    const requeued = await reapStaleJobs(settings.workerMaxAttempts);

    // Workers that stopped reporting are removed from the list after a day.
    const staleWorkers = await db
      .deleteFrom("workers")
      .where("last_seen_at", "<", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .executeTakeFirst();

    let deletedJobs = 0;
    let deletedFiles = 0;

    if (settings.jobRetentionDays > 0) {
      const cutoff = new Date(Date.now() - settings.jobRetentionDays * 24 * 60 * 60 * 1000).toISOString();
      const { jobs } = await listJobs({ limit: 200, status: "all" });
      for (const job of jobs) {
        const finished = job.finished_at ?? job.created_at;
        if (finished >= cutoff) continue;
        if (job.status === "running") continue; // never delete a job mid-conversion
        for (const key of new Set([job.input_key, job.output_key ?? ""])) {
          if (!key) continue;
          await storage.deleteObject(key).catch((error) => log.warn(`cleanup: could not delete ${key}: ${(error as Error).message}`));
          deletedFiles += 1;
        }
        await deleteJob(job.id);
        deletedJobs += 1;
      }

      // Drop activity lines that belong to jobs which are long gone.
      await db
        .deleteFrom("job_events")
        .where("at", "<", cutoff)
        .where("job_id", "not in", db.selectFrom("jobs").select("id"))
        .execute()
        .catch(() => undefined);
    }

    return json({
      ok: true,
      requeued,
      deletedJobs,
      deletedFiles,
      deletedWorkers: Number(staleWorkers.numDeletedRows ?? 0),
      retentionDays: settings.jobRetentionDays,
    });
  } catch (error) {
    return handleRouteError(error, "GET /api/cron/cleanup");
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
