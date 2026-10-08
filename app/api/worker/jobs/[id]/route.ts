/**
 * A worker reporting on the job it holds: progress, completion or failure.
 *
 * Completion is checked before it is trusted — the size of the uploaded result is read back
 * from storage — so a worker cannot make a job "done" with a file that does not exist.
 */

import { background } from "@/lib/background";
import { baseUrl, checkWorkerSecret, fail, handleRouteError, json, readJson } from "@/lib/http";
import { addEvent, completeJob, failJob, getJob, setDelivery, touchWorker, updateProgress } from "@/lib/jobs/service";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { deliverToTelegram, telegramConfigured } from "@/lib/telegram/delivery";
import type { CompleteRequest, FailRequest, WorkerReport } from "@/lib/worker/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface WorkerJobRequest {
  action?: "progress" | "complete" | "fail" | "lease";
  workerId?: string;
  report?: WorkerReport;
  complete?: CompleteRequest;
  failure?: FailRequest;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    if (!checkWorkerSecret(request)) return fail("wrong or missing WORKER_SECRET", 401);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);

    const body = await readJson<WorkerJobRequest>(request);
    const workerId = (body.workerId ?? job.claimed_by ?? "").toString();
    const { values: settings } = await getSettings();

    switch (body.action) {
      case "progress":
      case "lease": {
        const report = body.report ?? {};
        await updateProgress(job.id, {
          progress: report.progress,
          message: report.message,
          stage: report.stage,
          leaseSeconds: 120,
          claimedBy: workerId || undefined,
        });
        await touchWorker(workerId, { status: report.status ?? "busy", currentJobId: job.id });
        return json({ ok: true });
      }

      case "complete": {
        const complete = body.complete;
        if (!complete) return fail("complete payload is missing");
        const storage = getStorage({ baseUrl: baseUrl(request) });

        let outputBytes = Number(complete.outputBytes ?? 0);
        let outputKey = complete.outputKey ?? null;
        if (!complete.usedOriginal) {
          if (!outputKey) return fail("usedOriginal is false but no outputKey was given");
          const head = await storage.headObject(outputKey);
          if (!head || head.size <= 0) {
            return fail("the converted file is not in storage: upload it to the signed URL first", 409);
          }
          outputBytes = head.size;
        } else {
          outputKey = job.input_key;
          outputBytes = complete.sourceBytes ?? job.input_bytes;
        }

        const savedPercent =
          complete.savedPercent ??
          (complete.usedOriginal || job.input_bytes <= 0
            ? 0
            : (1 - outputBytes / job.input_bytes) * 100);

        await completeJob(job.id, {
          outputKey,
          outputName: complete.outputName ?? job.input_name,
          outputBytes,
          usedOriginal: Boolean(complete.usedOriginal),
          sourceBytes: job.input_bytes,
          outputWidth: complete.outputWidth ?? job.input_width,
          outputHeight: complete.outputHeight ?? job.input_height,
          outputCodec: complete.outputCodec ?? "hevc",
          savedPercent,
          workerName: workerId || job.claimed_by,
          ffmpegVersion: complete.ffmpegVersion ?? null,
          logTail: complete.logTail ?? null,
          message: complete.message ?? null,
        });
        await touchWorker(workerId, { status: "idle", currentJobId: null, jobsDoneDelta: 1 });

        const updated = await getJob(job.id);
        if (updated?.telegram_chat_id) {
          if (complete.deliveredToTelegram) {
            await setDelivery(job.id, "sent");
          } else if (telegramConfigured(settings) && settings.telegramDelivery === "server") {
            // The app sends it: the worker only had to convert.
            background(
              deliverToTelegram({ jobId: job.id, settings, storage }),
              `telegram delivery for ${job.id}`,
            );
          }
        }
        return json({ ok: true, job: updated ? { id: updated.id, status: updated.status } : null });
      }

      case "fail": {
        const failure = body.failure;
        if (!failure?.error) return fail("failure.error is required");
        const result = await failJob(job.id, {
          error: String(failure.error),
          retryable: Boolean(failure.retryable),
          maxAttempts: settings.workerMaxAttempts,
        });
        await touchWorker(workerId, {
          status: "idle",
          currentJobId: null,
          jobsFailedDelta: result.retried ? 0 : 1,
        });
        log.warn(`worker ${workerId} failed job ${job.id}: ${failure.error}`);
        return json({ ok: true, retried: result.retried });
      }

      default:
        return fail("action must be progress, complete, fail or lease");
    }
  } catch (error) {
    return handleRouteError(error, "POST /api/worker/jobs/[id]");
  }
}

/** The worker tells us it exists and what it can do (used by the status page). */
export async function GET(request: Request, context: RouteContext) {
  try {
    if (!checkWorkerSecret(request)) return fail("wrong or missing WORKER_SECRET", 401);
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) return fail("no such job", 404);
    await addEvent(job.id, "info", "a worker asked about this job");
    return json({ ok: true, job: { id: job.id, status: job.status, progress: job.progress } });
  } catch (error) {
    return handleRouteError(error, "GET /api/worker/jobs/[id]");
  }
}
