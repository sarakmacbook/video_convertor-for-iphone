/**
 * The contract between this app and a converter worker (Node or Python).
 *
 * A worker only needs three things: the app's URL, `WORKER_SECRET`, and ffmpeg. It polls
 * `/api/worker/claim`, downloads the input through the signed URL it gets back, converts,
 * uploads the result to the signed URL it also got back, and reports the outcome. Nothing in
 * the worker needs database credentials or a storage token.
 */

import type { Job } from "@/lib/jobs/service";

export interface ClaimJobPayload {
  id: string;
  source: string;
  attempts: number;
  createdAt: string;
  input: {
    key: string;
    name: string | null;
    bytes: number;
    contentType: string | null;
    /** Signed GET URL: the worker downloads the original from here. */
    downloadUrl: string;
    duration: number | null;
    width: number | null;
    height: number | null;
  };
  output: {
    /** Where to PUT the converted file. */
    uploadUrl: string;
    method: "PUT" | "POST";
    headers: Record<string, string>;
    key: string;
    name: string;
    /** The MIME type the result is stored and sent with. */
    contentType: string;
  };
  encoding: {
    /** What to make from the video: a key of `lib/conversions.ts`, e.g. "hevc" or "gif". */
    conversion: string;
    crf: number;
    preset: string;
    /** How long the worker may spend on this job before it should give up. */
    timeoutSeconds: number;
    maxInputMb: number;
  };
  delivery: {
    mode: "server" | "worker";
    /** Present when the result must be sent to Telegram by the worker itself. */
    telegram?: {
      chatId: number;
      statusMessageId: number | null;
      /** The file_id of the video that was received, for `getFile` on a local Bot API server. */
      fileId: string | null;
      apiUrl: string;
      localMode: boolean;
    };
  };
}

export interface ClaimResponse {
  job: ClaimJobPayload | null;
  /** Seconds until the current job's lease expires, so a worker knows how often to ping. */
  leaseSeconds: number;
  /** Non-null when the app cannot hand out work right now (no storage, no ffmpeg…). */
  problem?: string;
}

export interface WorkerReport {
  progress?: number;
  message?: string | null;
  stage?: "downloading" | "converting" | "uploading" | "delivering" | "finished";
  status?: "idle" | "busy";
}

export interface CompleteRequest {
  outputBytes: number;
  outputKey?: string | null;
  outputName?: string | null;
  usedOriginal: boolean;
  sourceBytes?: number | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputCodec?: string | null;
  savedPercent?: number | null;
  ffmpegVersion?: string | null;
  logTail?: string | null;
  deliveredToTelegram?: boolean;
  message?: string | null;
}

export interface FailRequest {
  error: string;
  retryable?: boolean;
}

export const WORKER_HEADER = "x-worker-id";
export const WORKER_SECRET_HEADER = "x-worker-secret";

/** How long a worker may hold a job before the app assumes it died. */
export const WORKER_LEASE_SECONDS = 120;

export function claimLeaseSeconds(): number {
  return WORKER_LEASE_SECONDS;
}

export function telegramDeliveryMode(job: Job, localMode: boolean): "server" | "worker" {
  // With a self-hosted Bot API server the app (on Vercel) cannot reach Telegram, so the
  // worker on the same machine as that server has to do the sending.
  return localMode ? "worker" : "server";
}
