/**
 * Schema migrations, written with Kysely's schema builder so one definition works on
 * PostgreSQL, MySQL, SQLite and libSQL.
 *
 * Migrations are applied on demand: the web app runs them on the first request that needs
 * the database (cheap after the first time — a SELECT against `_migrations`), and
 * `npm run db:migrate` applies them explicitly, which is what the deployment guide suggests.
 */

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { Database } from "./schema";

const SHORT = 120;
const ISO = 32;

async function createJobs(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("jobs")
    .addColumn("id", `varchar(64)`, (c) => c.primaryKey())
    .addColumn("status", `varchar(16)`, (c) => c.notNull()) // queued | running | done | failed | canceled
    .addColumn("stage", `varchar(16)`, (c) => c.notNull().defaultTo("queued"))
    .addColumn("progress", "double precision", (c) => c.notNull().defaultTo(0))
    .addColumn("message", "text")
    .addColumn("error", "text")
    .addColumn("source", `varchar(16)`, (c) => c.notNull()) // web | telegram | api

    .addColumn("created_at", `varchar(${ISO})`, (c) => c.notNull())
    .addColumn("updated_at", `varchar(${ISO})`, (c) => c.notNull())
    .addColumn("started_at", `varchar(${ISO})`)
    .addColumn("finished_at", `varchar(${ISO})`)

    .addColumn("claimed_by", `varchar(${SHORT})`)
    .addColumn("lease_expires_at", `varchar(${ISO})`)
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))

    .addColumn("input_key", `varchar(512)`, (c) => c.notNull())
    .addColumn("input_name", `varchar(255)`)
    .addColumn("input_bytes", "integer", (c) => c.notNull())
    .addColumn("input_content_type", `varchar(${SHORT})`)
    .addColumn("input_duration", "double precision")
    .addColumn("input_width", "integer")
    .addColumn("input_height", "integer")
    .addColumn("input_codec", `varchar(${SHORT})`)
    .addColumn("input_is_hdr", "integer")

    .addColumn("output_key", `varchar(512)`)
    .addColumn("output_name", `varchar(255)`)
    .addColumn("output_bytes", "integer")
    .addColumn("output_width", "integer")
    .addColumn("output_height", "integer")
    .addColumn("output_codec", `varchar(${SHORT})`)
    .addColumn("used_original", "integer")
    .addColumn("saved_percent", "double precision")

    .addColumn("crf", "integer")
    .addColumn("preset", `varchar(32)`)

    .addColumn("telegram_chat_id", "integer")
    .addColumn("telegram_message_id", "integer")
    .addColumn("telegram_status_message_id", "integer")
    .addColumn("telegram_file_id", "varchar(512)")
    .addColumn("telegram_user_id", "integer")
    .addColumn("delivery_status", `varchar(16)`, (c) => c.notNull().defaultTo("none"))
    .addColumn("delivery_error", "text")

    .addColumn("worker_name", `varchar(${SHORT})`)
    .addColumn("ffmpeg_version", `varchar(255)`)
    .addColumn("log_tail", `text`)
    .addColumn("meta", "text")
    .execute();

  await db.schema.createIndex("jobs_status_created").on("jobs").columns(["status", "created_at"]).execute();
  await db.schema.createIndex("jobs_created").on("jobs").columns(["created_at"]).execute();
  await db.schema.createIndex("jobs_lease").on("jobs").columns(["status", "lease_expires_at"]).execute();
  await db.schema.createIndex("jobs_chat").on("jobs").columns(["telegram_chat_id"]).execute();
}

async function createJobEvents(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("job_events")
    .addColumn("id", `varchar(64)`, (c) => c.primaryKey())
    .addColumn("job_id", `varchar(64)`, (c) => c.notNull())
    .addColumn("at", `varchar(${ISO})`, (c) => c.notNull())
    .addColumn("level", `varchar(16)`, (c) => c.notNull().defaultTo("info"))
    .addColumn("message", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("job_events_job").on("job_events").columns(["job_id", "at"]).execute();
}

async function createAppSettings(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("app_settings")
    .addColumn("key", `varchar(64)`, (c) => c.primaryKey())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("updated_at", `varchar(${ISO})`, (c) => c.notNull())
    .execute();
}

async function createWorkers(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("workers")
    .addColumn("id", `varchar(64)`, (c) => c.primaryKey())
    .addColumn("name", `varchar(${SHORT})`, (c) => c.notNull())
    .addColumn("version", `varchar(32)`)
    .addColumn("started_at", `varchar(${ISO})`, (c) => c.notNull())
    .addColumn("last_seen_at", `varchar(${ISO})`, (c) => c.notNull())
    .addColumn("status", `varchar(16)`, (c) => c.notNull().defaultTo("idle"))
    .addColumn("jobs_done", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("jobs_failed", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("current_job_id", `varchar(64)`)
    .addColumn("info", "text")
    .execute();
  await db.schema.createIndex("workers_last_seen").on("workers").columns(["last_seen_at"]).execute();
}

export const migrations: Record<string, Migration> = {
  "001_initial_schema": {
    async up(db: Kysely<Database>) {
      await createJobs(db);
      await createJobEvents(db);
      await createAppSettings(db);
      await createWorkers(db);
    },
    async down(db: Kysely<Database>) {
      await db.schema.dropTable("workers").ifExists().execute();
      await db.schema.dropTable("app_settings").ifExists().execute();
      await db.schema.dropTable("job_events").ifExists().execute();
      await db.schema.dropTable("jobs").ifExists().execute();
    },
  },
};

export const MIGRATION_NAMES = Object.keys(migrations);
