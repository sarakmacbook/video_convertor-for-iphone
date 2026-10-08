/**
 * The database connection: one Kysely instance per process, built from `DATABASE_URL`.
 *
 * Everything the app stores lives here — jobs, their progress, the settings you can edit in
 * the web UI, and the worker registry. Swapping between PostgreSQL, MySQL, SQLite and Turso
 * is a change of `DATABASE_URL` and nothing else.
 */

import { Kysely, type Dialect, MysqlDialect, PostgresDialect, sql } from "kysely";
import { createPool as createMysqlPool } from "mysql2";
import { Pool as PgPool } from "pg";

import { LibsqlDialect } from "./libsql-dialect";
import { migrations } from "./migrations";
import type { Database } from "./schema";
import { libsqlConfig, parseDatabaseUrl, type DatabaseTarget, type Dialect as DbDialect } from "./url";

export type Db = Kysely<Database>;

let cached: { db: Db; target: DatabaseTarget } | null = null;
let migrated: Promise<void> | null = null;

export class DatabaseNotConfiguredError extends Error {}

export function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

export function isDatabaseConfigured(): boolean {
  return databaseUrl().length > 0;
}

function createDialect(url: string, target: DatabaseTarget): Dialect {
  switch (target.dialect) {
    case "postgres":
      return new PostgresDialect({
        pool: new PgPool({
          connectionString: url,
          max: 5,
          // Serverless functions are short-lived; keep connections few and idle time short.
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 10_000,
          ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
        }),
      });
    case "mysql":
      return new MysqlDialect({
        pool: createMysqlPool({
          uri: url.replace(/^mysql2:\/\//i, "mysql://"),
          connectionLimit: 5,
          connectTimeout: 10_000,
          timezone: "Z",
        }),
      });
    case "libsql": {
      return new LibsqlDialect(libsqlConfig(url));
    }
    default: {
      const config = libsqlConfig(url);
      return new LibsqlDialect(config);
    }
  }
}

function needsSsl(url: string): boolean {
  // Managed providers (Neon, Supabase, RDS…) require TLS; local Postgres usually has none.
  if (/sslmode=require|ssl=true/i.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    return !["localhost", "127.0.0.1", "::1", "host.docker.internal", "db"].includes(host);
  } catch {
    return false;
  }
}

export function getDb(): Db {
  if (cached) return cached.db;
  const url = databaseUrl();
  if (!url) {
    throw new DatabaseNotConfiguredError(
      "DATABASE_URL is not set, so jobs and settings cannot be stored. Set it in the Vercel project (or .env) — see docs/VERCEL.md.",
    );
  }
  const target = parseDatabaseUrl(url);
  const db = new Kysely<Database>({ dialect: createDialect(url, target) });
  cached = { db, target };
  return db;
}

export function databaseTarget(): DatabaseTarget {
  const url = databaseUrl();
  if (!url) throw new DatabaseNotConfiguredError("DATABASE_URL is not set");
  return parseDatabaseUrl(url);
}

/** Apply every migration that has not run yet. Safe to call concurrently. */
export async function migrateToLatest(db: Db = getDb()): Promise<void> {
  if (migrated) return migrated;
  migrated = (async () => {
    await db.schema
      .createTable("_migrations")
      .ifNotExists()
      .addColumn("name", "varchar(64)", (c) => c.primaryKey())
      .addColumn("applied_at", "varchar(32)", (c) => c.notNull())
      .execute();

    const applied = new Set(
      (await db.selectFrom("_migrations").select("name").execute()).map((row) => row.name),
    );

    for (const [name, migration] of Object.entries(migrations)) {
      if (applied.has(name)) continue;
      await migration.up(db);
      // A second instance may have migrated between our SELECT and here; the primary key on
      // `name` makes that visible as a duplicate-key error, which is fine to ignore.
      try {
        await db.insertInto("_migrations").values({ name, applied_at: new Date().toISOString() }).execute();
      } catch (error) {
        const already = await db
          .selectFrom("_migrations")
          .select("name")
          .where("name", "=", name)
          .executeTakeFirst()
          .catch(() => undefined);
        if (!already) throw error;
      }
    }
  })().catch((error) => {
    migrated = null; // let the next request try again
    throw error;
  });
  return migrated;
}

export function resetDbCacheForTests(): void {
  cached = null;
  migrated = null;
}

async function serverVersion(db: Db, dialect: DbDialect): Promise<string | undefined> {
  try {
    if (dialect === "postgres") {
      const result = await sql<{ version: string }>`select version() as version`.execute(db);
      return result.rows[0]?.version;
    }
    if (dialect === "mysql") {
      const result = await sql<{ version: string }>`select version() as version`.execute(db);
      return result.rows[0]?.version;
    }
    const result = await sql<{ version: string }>`select sqlite_version() as version`.execute(db);
    return result.rows[0]?.version;
  } catch {
    return undefined;
  }
}

export interface DatabaseStatus {  configured: boolean;
  dialect?: DbDialect;
  label?: string;
  display?: string;
  connected: boolean;
  serverVersion?: string;
  tables: { name: string; rows: number | null }[];
  migrations: { name: string; applied: boolean; appliedAt: string | null }[];
  error?: string;
}

/** A thorough health check for the settings page and `/api/health`. */
export async function databaseStatus(): Promise<DatabaseStatus> {
  if (!isDatabaseConfigured()) {
    return {
      configured: false,
      connected: false,
      tables: [],
      migrations: [],
      error: "DATABASE_URL is not set",
    };
  }

  const target = parseDatabaseUrl(databaseUrl());
  const status: DatabaseStatus = {
    configured: true,
    dialect: target.dialect,
    label: target.host,
    display: target.display,
    connected: false,
    tables: [],
    migrations: [],
  };

  try {
    const db = getDb();
    await migrateToLatest(db);
    status.serverVersion = await serverVersion(db, target.dialect);
    status.connected = true;

    for (const name of ["jobs", "job_events", "workers", "app_settings"] as const) {
      const count = await db
        .selectFrom(name)
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .executeTakeFirst()
        .catch(() => null);
      status.tables.push({ name, rows: count ? Number(count.count) : null });
    }

    const applied = new Map(
      (await db.selectFrom("_migrations").select(["name", "applied_at"]).execute()).map((row) => [
        row.name,
        row.applied_at,
      ]),
    );
    status.migrations = Object.keys(migrations).map((name) => ({
      name,
      applied: applied.has(name),
      appliedAt: applied.get(name) ?? null,
    }));
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }

  return status;
}
