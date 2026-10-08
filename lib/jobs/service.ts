/**
 * Jobs: create, queue, claim, report progress, finish.
 *
 * The same table serves the web UI, the Telegram webhook and remote workers, and a job is
 * claimed with a conditional UPDATE, which is atomic on all four supported databases without
 * needing `SELECT … FOR UPDATE SKIP LOCKED`.
 */

import { randomBytes } from "node:crypto";

import { getDb, migrateToLatest, type Db } from "@/lib/db";
import {
  boolToInt,
  intToBool,
  isoAfter,
  nowIso,
  type JobsTable,
  type JobSource,
  type JobStatus,
} from "@/lib/db/schema";
import { log } from "@/lib/log";

export const DEFAULT_LEASE_SECONDS = 120;
export const STAGES = ["queued", "downloading", "converting", "uploading", "delivering", "finished"] as const;
export type Stage = (typeof STAGES)[number];

export interface Job extends JobsTable {}

export function newId(prefix: string): string {
  // Short, sortable enough, and readable in logs: job_ab12cd34ef56
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export async function db(): Promise<Db> {
  const handle = getDb();
  await migrateToLatest(handle);
  return handle;
}

export interface CreateJobInput {
  source: JobSource;
  inputKey: string;
  inputName: string;
  inputBytes: number;
  inputContentType?: string | null;
  crf: number;
  preset: string;
  telegram?: {
    chatId?: number | null;
    messageId?: number | null;
    statusMessageId?: number | null;
    fileId?: string | null;
    userId?: number | null;
  };
  inputProbe?: { width?: number | null; height?: number | null; duration?: number | null };
  meta?: Record<string, unknown> | null;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  const handle = await db();
  const now = nowIso();
  const row: JobsTable = {
    id: newId("job"),
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Waiting for a converter",
    error: null,
    source: input.source,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    claimed_by: null,
    lease_expires_at: null,
    attempts: 0,
    input_key: input.inputKey,
    input_name: input.inputName,
    input_bytes: input.inputBytes,
    input_content_type: input.inputContentType ?? null,
    input_duration: input.inputProbe?.duration ?? null,
    input_width: input.inputProbe?.width ?? null,
    input_height: input.inputProbe?.height ?? null,
    input_codec: null,
    input_is_hdr: null,
    output_key: null,
    output_name: null,
    output_bytes: null,
    output_width: null,
    output_height: null,
    output_codec: null,
    used_original: null,
    saved_percent: null,
    crf: input.crf,
    preset: input.preset,
    telegram_chat_id: input.telegram?.chatId ?? null,
    telegram_message_id: input.telegram?.messageId ?? null,
    telegram_status_message_id: input.telegram?.statusMessageId ?? null,
    telegram_file_id: input.telegram?.fileId ?? null,
    telegram_user_id: input.telegram?.userId ?? null,
    delivery_status: input.telegram?.chatId ? "pending" : "none",
    delivery_error: null,
    worker_name: null,
    ffmpeg_version: null,
    log_tail: null,
    meta: input.meta ? JSON.stringify(input.meta) : null,
  };

  await handle.insertInto("jobs").values(row).execute();
  await addEvent(row.id, "info", `job created from ${input.source}, ${input.inputBytes} bytes`);
  return row;
}

export async function getJob(id: string): Promise<Job | null> {
  const handle = await db();
  const job = await handle.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
  return job ?? null;
}

export interface JobQuery {
  status?: JobStatus | "active" | "all";
  source?: JobSource;
  limit?: number;
  offset?: number;
  telegramChatId?: number;
}

export async function listJobs(query: JobQuery = {}): Promise<{ jobs: Job[]; total: number }> {
  const handle = await db();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const status = query.status ?? "all";

  const base = () => {
    let builder = handle.selectFrom("jobs");
    if (status === "active") builder = builder.where("status", "in", ["queued", "running"]);
    else if (status !== "all") builder = builder.where("status", "=", status);
    if (query.source) builder = builder.where("source", "=", query.source);
    if (query.telegramChatId !== undefined) builder = builder.where("telegram_chat_id", "=", query.telegramChatId);
    return builder;
  };

  const jobs = await base()
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  const counted = await base()
    .select((eb) => eb.fn.countAll<number | string>().as("count"))
    .executeTakeFirst();

  return { jobs, total: Number(counted?.count ?? 0) };
}

export async function countJobsByStatus(): Promise<Record<string, number>> {
  const handle = await db();
  const rows = await handle
    .selectFrom("jobs")
    .select(["status", (eb) => eb.fn.countAll<number | string>().as("count")])
    .groupBy("status")
    .execute();
  const result: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

// --------------------------------------------------------------------------- //
// Claiming and progress
// --------------------------------------------------------------------------- //

export interface ClaimOptions {
  claimedBy: string;
  leaseSeconds?: number;
  maxAttempts: number;
  /** Only claim jobs from these sources (a worker that can reach Telegram, for example). */
  sources?: JobSource[];
  /** Prefer jobs for a chat the worker can serve. */
  onlyJobId?: string;
}

/**
 * Take one queued job. Returns null when there is nothing to do.
 *
 * A conditional UPDATE is the lock: only the process whose UPDATE changed a row owns the job.
 */
export async function claimJob(options: ClaimOptions): Promise<Job | null> {
  const handle = await db();
  if (options.onlyJobId) {
    const claimed = await tryClaim(handle, options.onlyJobId, options);
    return claimed;
  }

  const candidates = await handle
    .selectFrom("jobs")
    .select("id")
    .where("status", "=", "queued")
    .where("attempts", "<", options.maxAttempts)
    .$if(Boolean(options.sources?.length), (qb) => qb.where("source", "in", options.sources!))
    .orderBy("created_at", "asc")
    .limit(5)
    .execute();

  for (const candidate of candidates) {
    const claimed = await tryClaim(handle, candidate.id, options);
    if (claimed) return claimed;
  }
  return null;
}

async function tryClaim(handle: Db, id: string, options: ClaimOptions): Promise<Job | null> {
  const now = nowIso();
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const result = await handle
    .updateTable("jobs")
    .set({
      status: "running",
      stage: "downloading",
      claimed_by: options.claimedBy,
      lease_expires_at: isoAfter(leaseSeconds),
      started_at: now,
      progress: 0,
      message: "Starting",
      updated_at: now,
      attempts: (eb) => eb("attempts", "+", 1),
    })
    .where("id", "=", id)
    .where("status", "=", "queued")
    .executeTakeFirst();

  if (Number(result?.numUpdatedRows ?? 0) === 0) return null;
  const job = await getJob(id);
  if (job) await addEvent(id, "info", `claimed by ${options.claimedBy}`);
  return job;
}

export interface ProgressInput {
  progress?: number;
  message?: string | null;
  stage?: Stage;
  leaseSeconds?: number;
  claimedBy?: string;
}

export async function updateProgress(jobId: string, input: ProgressInput): Promise<boolean> {
  const handle = await db();
  const update: Record<string, unknown> = { updated_at: nowIso() };
  if (typeof input.progress === "number") update.progress = Math.max(0, Math.min(1, input.progress));
  if (input.message !== undefined) update.message = input.message;
  if (input.stage) update.stage = input.stage;
  if (input.leaseSeconds) update.lease_expires_at = isoAfter(input.leaseSeconds);

  let query = handle.updateTable("jobs").set(update).where("id", "=", jobId);
  if (input.claimedBy) query = query.where("claimed_by", "=", input.claimedBy);
  const result = await query.executeTakeFirst();
  return Number(result?.numUpdatedRows ?? 0) > 0;
}

export interface CompleteInput {
  outputKey?: string | null;
  outputName?: string | null;
  outputBytes: number;
  usedOriginal: boolean;
  sourceBytes?: number | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputCodec?: string | null;
  savedPercent?: number | null;
  workerName?: string | null;
  ffmpegVersion?: string | null;
  logTail?: string | null;
  message?: string | null;
}

export async function completeJob(jobId: string, input: CompleteInput): Promise<Job | null> {
  const handle = await db();
  const now = nowIso();
  await handle
    .updateTable("jobs")
    .set({
      status: "done",
      stage: "finished",
      progress: 1,
      message: input.message ?? null,
      error: null,
      updated_at: now,
      finished_at: now,
      lease_expires_at: null,
      output_key: input.outputKey ?? null,
      output_name: input.outputName ?? null,
      output_bytes: input.outputBytes,
      output_width: input.outputWidth ?? null,
      output_height: input.outputHeight ?? null,
      output_codec: input.outputCodec ?? null,
      used_original: boolToInt(input.usedOriginal),
      saved_percent: input.savedPercent ?? null,
      worker_name: input.workerName ?? null,
      ffmpeg_version: input.ffmpegVersion ?? null,
      log_tail: input.logTail ? input.logTail.slice(0, 4000) : null,
    })
    .where("id", "=", jobId)
    .execute();

  await addEvent(
    jobId,
    "info",
    input.usedOriginal
      ? "finished: the original is smaller or the conversion was not worth sending"
      : `finished: ${input.outputBytes} bytes delivered`,
  );
  return getJob(jobId);
}

export async function failJob(
  jobId: string,
  options: { error: string; retryable?: boolean; maxAttempts?: number; claimedBy?: string | null },
): Promise<{ retried: boolean; job: Job | null }> {
  const handle = await db();
  const job = await getJob(jobId);
  if (!job) return { retried: false, job: null };

  const attempts = job.attempts;
  const maxAttempts = options.maxAttempts ?? 3;
  if (options.retryable && attempts < maxAttempts) {
    await handle
      .updateTable("jobs")
      .set({
        status: "queued",
        stage: "queued",
        claimed_by: null,
        lease_expires_at: null,
        message: `Trying again after: ${options.error}`,
        updated_at: nowIso(),
      })
      .where("id", "=", jobId)
      .execute();
    await addEvent(jobId, "warn", `attempt ${attempts} failed, requeued: ${options.error}`);
    return { retried: true, job: await getJob(jobId) };
  }

  await handle
    .updateTable("jobs")
    .set({
      status: "failed",
      stage: "finished",
      error: options.error.slice(0, 4000),
      message: "Conversion failed",
      updated_at: nowIso(),
      finished_at: nowIso(),
      lease_expires_at: null,
    })
    .where("id", "=", jobId)
    .execute();
  await addEvent(jobId, "error", options.error);
  return { retried: false, job: await getJob(jobId) };
}

export async function cancelJob(jobId: string): Promise<Job | null> {
  const handle = await db();
  await handle
    .updateTable("jobs")
    .set({
      status: "canceled",
      stage: "finished",
      message: "Canceled",
      updated_at: nowIso(),
      finished_at: nowIso(),
      lease_expires_at: null,
    })
    .where("id", "=", jobId)
    .where("status", "in", ["queued", "running"])
    .execute();
  await addEvent(jobId, "warn", "canceled");
  return getJob(jobId);
}

/** Put a finished job back in the queue (used by the "Try again" button). */
export async function requeueJob(jobId: string): Promise<Job | null> {
  const handle = await db();
  await handle
    .updateTable("jobs")
    .set({
      status: "queued",
      stage: "queued",
      progress: 0,
      message: "Waiting for a converter",
      error: null,
      claimed_by: null,
      lease_expires_at: null,
      attempts: 0,
      updated_at: nowIso(),
      finished_at: null,
    })
    .where("id", "=", jobId)
    .execute();
  await addEvent(jobId, "info", "queued again");
  return getJob(jobId);
}

export async function deleteJob(jobId: string): Promise<void> {
  const handle = await db();
  await handle.deleteFrom("job_events").where("job_id", "=", jobId).execute();
  await handle.deleteFrom("jobs").where("id", "=", jobId).execute();
}

export async function setDelivery(
  jobId: string,
  status: "none" | "pending" | "sent" | "failed",
  error?: string | null,
): Promise<void> {
  const handle = await db();
  await handle
    .updateTable("jobs")
    .set({ delivery_status: status, delivery_error: error ?? null, updated_at: nowIso() })
    .where("id", "=", jobId)
    .execute();
}

export async function setJobMeta(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const handle = await db();
  const job = await getJob(jobId);
  if (!job) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = job.meta ? (JSON.parse(job.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  await handle
    .updateTable("jobs")
    .set({ meta: JSON.stringify({ ...meta, ...patch }), updated_at: nowIso() })
    .where("id", "=", jobId)
    .execute();
}

/** Store what the probe found about the input, so the UI can show it while converting. */
export async function setInputProbe(
  jobId: string,
  probe: { width: number; height: number; duration: number; codec: string | null; isHdr: boolean },
): Promise<void> {
  const handle = await db();
  await handle
    .updateTable("jobs")
    .set({
      input_width: probe.width,
      input_height: probe.height,
      input_duration: probe.duration,
      input_codec: probe.codec,
      input_is_hdr: boolToInt(probe.isHdr),
      updated_at: nowIso(),
    })
    .where("id", "=", jobId)
    .execute();
}

/**
 * Jobs whose worker disappeared (a serverless function that ran out of time, a crashed
 * machine) go back to the queue until they run out of attempts.
 */
export async function reapStaleJobs(maxAttempts = 3): Promise<number> {
  const handle = await db();
  const stale = await handle
    .selectFrom("jobs")
    .select(["id", "claimed_by", "attempts"])
    .where("status", "=", "running")
    .where("lease_expires_at", "is not", null)
    .where("lease_expires_at", "<", nowIso())
    .limit(20)
    .execute();

  let reaped = 0;
  for (const job of stale) {
    const reason = `the converter (${job.claimed_by ?? "unknown"}) stopped responding`;
    await failJob(job.id, { error: reason, retryable: true, maxAttempts });
    reaped += 1;
  }
  return reaped;
}

// --------------------------------------------------------------------------- //
// Activity log
// --------------------------------------------------------------------------- //

export async function addEvent(jobId: string, level: "info" | "warn" | "error", message: string): Promise<void> {
  try {
    const handle = await getDb();
    await handle
      .insertInto("job_events")
      .values({ id: newId("ev"), job_id: jobId, at: nowIso(), level, message: message.slice(0, 4000) })
      .execute();
  } catch (error) {
    log.warn(`could not record job event: ${(error as Error).message}`);
  }
}

export async function listEvents(jobId: string, limit = 100) {
  const handle = await db();
  return handle
    .selectFrom("job_events")
    .selectAll()
    .where("job_id", "=", jobId)
    .orderBy("at", "asc")
    .limit(limit)
    .execute();
}

// --------------------------------------------------------------------------- //
// Workers
// --------------------------------------------------------------------------- //

export interface WorkerInfo {
  id: string;
  name: string;
  version?: string | null;
  status?: string;
  currentJobId?: string | null;
  info?: string | null;
}

export async function registerWorker(info: WorkerInfo): Promise<void> {
  const handle = await db();
  const now = nowIso();
  const existing = await handle.selectFrom("workers").select("id").where("id", "=", info.id).executeTakeFirst();
  if (existing) {
    await handle
      .updateTable("workers")
      .set({ last_seen_at: now, status: info.status ?? "idle", name: info.name })
      .where("id", "=", info.id)
      .execute();
    return;
  }
  await handle
    .insertInto("workers")
    .values({
      id: info.id,
      name: info.name,
      version: info.version ?? null,
      started_at: now,
      last_seen_at: now,
      status: info.status ?? "idle",
      jobs_done: 0,
      jobs_failed: 0,
      current_job_id: null,
      info: info.info ?? null,
    })
    .execute();
}

export async function touchWorker(
  id: string,
  patch: { status?: string; currentJobId?: string | null; jobsDoneDelta?: number; jobsFailedDelta?: number },
): Promise<void> {
  const handle = await db();
  await handle
    .updateTable("workers")
    .set({
      last_seen_at: nowIso(),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.currentJobId !== undefined ? { current_job_id: patch.currentJobId } : {}),
    })
    .where("id", "=", id)
    .execute();

  if (patch.jobsDoneDelta) {
    await handle
      .updateTable("workers")
      .set({ jobs_done: (eb) => eb("jobs_done", "+", patch.jobsDoneDelta ?? 0) })
      .where("id", "=", id)
      .execute();
  }
  if (patch.jobsFailedDelta) {
    await handle
      .updateTable("workers")
      .set({ jobs_failed: (eb) => eb("jobs_failed", "+", patch.jobsFailedDelta ?? 0) })
      .where("id", "=", id)
      .execute();
  }
}

export interface WorkerRow {
  id: string;
  name: string;
  version: string | null;
  started_at: string;
  last_seen_at: string;
  status: string;
  jobs_done: number;
  jobs_failed: number;
  current_job_id: string | null;
  info: string | null;
  online: boolean;
}

export async function listWorkers(): Promise<WorkerRow[]> {
  const handle = await db();
  const rows = await handle.selectFrom("workers").selectAll().orderBy("last_seen_at", "desc").limit(50).execute();
  const threshold = Date.now() - 60_000;
  return rows.map((row) => ({
    ...row,
    online: new Date(row.last_seen_at).getTime() > threshold,
  }));
}

/** Input in, result out — the shape both workers (Node and Python) use. */
export function jobSummary(job: Job) {
  return {
    id: job.id,
    status: job.status as JobStatus,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    source: job.source as JobSource,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    attempts: job.attempts,
    input: {
      key: job.input_key,
      name: job.input_name,
      bytes: job.input_bytes,
      contentType: job.input_content_type,
      duration: job.input_duration,
      width: job.input_width,
      height: job.input_height,
      codec: job.input_codec,
      isHdr: job.input_is_hdr === null ? null : intToBool(job.input_is_hdr),
    },
    output: {
      key: job.output_key,
      name: job.output_name,
      bytes: job.output_bytes,
      width: job.output_width,
      height: job.output_height,
      codec: job.output_codec,
      usedOriginal: job.used_original === null ? null : intToBool(job.used_original),
      savedPercent: job.saved_percent,
    },
    telegram: {
      chatId: job.telegram_chat_id,
      messageId: job.telegram_message_id,
      status: job.delivery_status,
      error: job.delivery_error,
    },
    worker: job.worker_name,
    ffmpegVersion: job.ffmpeg_version,
  };
}

export type JobSummary = ReturnType<typeof jobSummary>;
