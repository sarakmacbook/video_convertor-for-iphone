/**
 * A worker asks for the next job.
 *
 * The response contains everything needed to work without any further credentials: a signed
 * URL to download the original, a signed URL to upload the result, the encoding settings, and
 * (when the worker has to do it) how to send the video back to Telegram.
 */

import { baseUrl, checkWorkerSecret, fail, handleRouteError, json, readJson, workerSecret } from "@/lib/http";
import { conversionOfMeta } from "@/lib/conversions";
import { claimJob, reapStaleJobs, touchWorker } from "@/lib/jobs/service";
import { getSettings } from "@/lib/settings";
import { conversionName, getStorage, outputKey } from "@/lib/storage";
import { claimLeaseSeconds, telegramDeliveryMode, type ClaimJobPayload } from "@/lib/worker/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ClaimRequest {
  workerId?: string;
  name?: string;
  sources?: string[];
}

export async function POST(request: Request) {
  try {
    if (!checkWorkerSecret(request)) {
      return fail(workerSecret() ? "wrong or missing WORKER_SECRET" : "WORKER_SECRET is not set on the server", 401);
    }
    const body = await readJson<ClaimRequest>(request).catch(() => ({}) as ClaimRequest);
    const workerId = (body.workerId ?? "").trim() || "worker";
    const name = (body.name ?? workerId).slice(0, 60);
    const { values: settings } = await getSettings();

    await reapStaleJobs(settings.workerMaxAttempts);
    const leaseSeconds = claimLeaseSeconds();
    const job = await claimJob({
      claimedBy: workerId,
      maxAttempts: settings.workerMaxAttempts,
      leaseSeconds,
      sources: body.sources as never,
    });

    if (!job) {
      await touchWorker(workerId, { status: "idle", currentJobId: null });
      return json({ job: null, leaseSeconds, problem: null });
    }

    await touchWorker(workerId, { status: "busy", currentJobId: job.id });
    const storage = getStorage({ baseUrl: baseUrl(request) });

    let inputDownloadUrl = "";
    const inputFromTelegram = Boolean(job.meta?.includes("telegram-local"));
    if (!inputFromTelegram) {
      try {
        inputDownloadUrl = await storage.createDownloadUrl(job.input_key, { expiresInSeconds: leaseSeconds * 4 });
      } catch (error) {
        return fail(`could not sign a download URL: ${(error as Error).message}`, 500);
      }
    }

    // The Telegram bot records what the user picked in the job; web jobs get the smaller HEVC file.
    const conversion = conversionOfMeta(job.meta);
    const outName = conversionName(job.input_name, conversion);
    const outKey = outputKey(job.id, outName);
    const outputUpload = await storage.createUploadTarget({
      key: outKey,
      contentType: conversion.mimeType,
      expiresInSeconds: leaseSeconds * 8,
    });

    const deliveryMode = telegramDeliveryMode(job, settings.telegramLocalMode);
    const payload: ClaimJobPayload = {
      id: job.id,
      source: job.source,
      attempts: job.attempts,
      createdAt: job.created_at,
      input: {
        key: job.input_key,
        name: job.input_name,
        bytes: job.input_bytes,
        contentType: job.input_content_type,
        downloadUrl: inputDownloadUrl,
        duration: job.input_duration,
        width: job.input_width,
        height: job.input_height,
      },
      output: {
        uploadUrl: outputUpload.url,
        method: outputUpload.method,
        headers: outputUpload.headers,
        key: outKey,
        name: outName,
        contentType: conversion.mimeType,
      },
      encoding: {
        conversion: conversion.key,
        crf: job.crf ?? settings.crf,
        preset: job.preset ?? settings.preset,
        timeoutSeconds: 6 * 60 * 60,
        maxInputMb: settings.maxInputMb,
      },
      delivery: {
        mode: job.telegram_chat_id ? deliveryMode : "server",
        telegram: job.telegram_chat_id
          ? {
              chatId: job.telegram_chat_id,
              statusMessageId: job.telegram_status_message_id,
              fileId: job.telegram_file_id,
              apiUrl: settings.telegramApiUrl,
              localMode: settings.telegramLocalMode,
            }
          : undefined,
      },
    };

    return json({
      job: payload,
      leaseSeconds,
      problem: null,
      // The worker can tell the user it started, without needing to know about storage.
      note: inputFromTelegram
        ? "the original is on Telegram (local Bot API server): download it with the file id in delivery.telegram"
        : null,
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/worker/claim");
  }
}
