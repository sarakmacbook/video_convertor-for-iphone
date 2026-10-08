/**
 * Small numbers for the dashboard header: how many jobs are waiting, running, done or failed.
 */

import { isDatabaseConfigured } from "@/lib/db";
import { fail, handleRouteError, isAuthorized, json, unauthorized } from "@/lib/http";
import { countJobsByStatus, listWorkers, reapStaleJobs } from "@/lib/jobs/service";
import { getSettings } from "@/lib/settings";
import { storageDriverName } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    if (!isDatabaseConfigured()) return fail("DATABASE_URL is not set", 400);

    const { values: settings } = await getSettings();
    await reapStaleJobs(settings.workerMaxAttempts);
    const [jobs, workers] = await Promise.all([countJobsByStatus(), listWorkers()]);

    return json({
      ok: true,
      jobs,
      workers: {
        online: workers.filter((worker) => worker.online).length,
        total: workers.length,
        list: workers.map((worker) => ({
          id: worker.id,
          name: worker.name,
          status: worker.status,
          online: worker.online,
          lastSeenAt: worker.last_seen_at,
          currentJobId: worker.current_job_id,
          jobsDone: worker.jobs_done,
          jobsFailed: worker.jobs_failed,
        })),
      },
      storage: { driver: storageDriverName() },
      encoding: { crf: settings.crf, preset: settings.preset, maxInputMb: settings.maxInputMb },
    });
  } catch (error) {
    return handleRouteError(error, "GET /api/stats");
  }
}
