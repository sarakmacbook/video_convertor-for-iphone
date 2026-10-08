/**
 * Table typings for Kysely.
 *
 * Only portable column types are used so the same schema works on PostgreSQL, MySQL,
 * SQLite and libSQL/Turso:
 *   - `varchar(n)` for short strings, including indexed ones (MySQL cannot index a TEXT column);
 *   - `text` for long, unindexed strings (messages, logs);
 *   - `integer` for counts and byte sizes below 2 GB;
 *   - `double precision` for durations and progress;
 *   - timestamps are ISO-8601 UTC strings, so sorting and comparing are plain string compares.
 */

export const JOB_STATUSES = ["queued", "running", "done", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_SOURCES = ["web", "telegram", "api"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const DELIVERY_STATUSES = ["none", "pending", "sent", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface AppSettingsTable {
  key: string;
  value: string;
  updated_at: string;
}

export interface JobsTable {
  id: string;
  status: string; // JobStatus
  stage: string; // downloading | converting | uploading | delivering | finished
  progress: number; // 0..1
  message: string | null;
  error: string | null;
  source: string; // JobSource

  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;

  /** Who is converting this job right now (`inline:<host>` or a worker id). */
  claimed_by: string | null;
  lease_expires_at: string | null;
  attempts: number;

  // Input
  input_key: string;
  input_name: string | null;
  input_bytes: number;
  input_content_type: string | null;
  input_duration: number | null;
  input_width: number | null;
  input_height: number | null;
  input_codec: string | null;
  input_is_hdr: number | null; // 0/1

  // Output (the converted file, or the original when converting was not worth it)
  output_key: string | null;
  output_name: string | null;
  output_bytes: number | null;
  output_width: number | null;
  output_height: number | null;
  output_codec: string | null;
  used_original: number | null; // 0/1
  saved_percent: number | null;

  // Settings snapshot used for this job
  crf: number | null;
  preset: string | null;

  // Telegram
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  telegram_status_message_id: number | null;
  telegram_file_id: string | null;
  telegram_user_id: number | null;
  delivery_status: string; // DeliveryStatus
  delivery_error: string | null;

  worker_name: string | null;
  ffmpeg_version: string | null;
  log_tail: string | null;
  meta: string | null; // JSON blob for anything else
}

export interface JobEventsTable {
  id: string;
  job_id: string;
  at: string;
  level: string; // info | warn | error
  message: string;
}

export interface WorkersTable {
  id: string;
  name: string;
  version: string | null;
  started_at: string;
  last_seen_at: string;
  status: string; // idle | busy | stopped
  jobs_done: number;
  jobs_failed: number;
  current_job_id: string | null;
  info: string | null;
}

export interface MigrationsTable {
  name: string;
  applied_at: string;
}

export interface Database {
  app_settings: AppSettingsTable;
  jobs: JobsTable;
  job_events: JobEventsTable;
  workers: WorkersTable;
  _migrations: MigrationsTable;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 UTC with a fixed width, so string comparison and ORDER BY behave like timestamps. */
export function isoAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function intToBool(value: number | null | undefined): boolean {
  return value === 1;
}
