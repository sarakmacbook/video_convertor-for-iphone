/**
 * A worker introducing itself. Workers stay visible on the Settings page for a minute after
 * their last heartbeat, which is how the UI can say "1 worker online".
 */

import { checkWorkerSecret, fail, handleRouteError, json, readJson, workerSecret } from "@/lib/http";
import { countJobsByStatus, listWorkers, reapStaleJobs, registerWorker } from "@/lib/jobs/service";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RegisterRequest {
  workerId?: string;
  name?: string;
  version?: string;
  status?: "idle" | "busy";
  info?: string;
}

export async function POST(request: Request) {
  try {
    if (!checkWorkerSecret(request)) {
      return fail(workerSecret() ? "wrong or missing WORKER_SECRET" : "WORKER_SECRET is not set on the server", 401);
    }
    const body = await readJson<RegisterRequest>(request).catch(() => ({}) as RegisterRequest);
    const workerId = (body.workerId ?? "").trim();
    if (!workerId) return fail("workerId is required");

    const { values: settings } = await getSettings();
    await registerWorker({
      id: workerId,
      name: (body.name ?? workerId).slice(0, 60),
      version: body.version ?? null,
      status: body.status ?? "idle",
      info: body.info ?? null,
    });
    const reaped = await reapStaleJobs(settings.workerMaxAttempts);

    return json({
      ok: true,
      workerId,
      reaped,
      queue: await countJobsByStatus(),
      workers: (await listWorkers()).map((worker) => ({
        id: worker.id,
        name: worker.name,
        online: worker.online,
        status: worker.status,
      })),
      encodingDefaults: { crf: settings.crf, preset: settings.preset, maxInputMb: settings.maxInputMb },
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/worker/register");
  }
}
