/**
 * The database connection: one Kysely instance per process, built from `DATABASE_URL`.
 *
 * Everything the app stores lives here — jobs, their progress, the settings you can edit in
 * the web UI, and the worker registry. Swapping between PostgreSQL, MySQL, SQLite and Turso
 * is a change of `DATABASE_URL` and nothing else.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Kysely, type Dialect, MysqlDialect, PostgresDialect, sql } from "kysely";
import { createPool as createMysqlPool } from "mysql2";
import { Pool as PgPool } from "pg";

import { LibsqlDialect } from "./libsql-dialect";
import { migrations } from "./migrations";
import type { Database } from "./schema";
import {
  cleanDatabaseUrl,
  libsqlConfig,
  parseDatabaseUrl,
  type DatabaseTarget,
  type Dialect as DbDialect,
} from "./url";

export type Db = Kysely<Database>;

let cached: { db: Db; target: DatabaseTarget } | null = null;
let migrated: Promise<void> | null = null;

export class DatabaseNotConfiguredError extends Error {}

/**
 * Detect the database connection from environment variables or local fallback.
 * Checks DATABASE_URL, cloud provider variables (POSTGRES_URL, TURSO_DATABASE_URL, MYSQL_URL),
 * and defaults to local SQLite outside Vercel.
 */
export function detectedDatabaseSource(): { url: string; source: string; dialect: DbDialect } | null {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) {
    const cleaned = cleanDatabaseUrl(direct);
    if (cleaned) {
      const target = parseDatabaseUrl(cleaned);
      return { url: cleaned, source: "DATABASE_URL", dialect: target.dialect };
    }
  }

  // Vercel Postgres, Neon integration, Supabase
  const postgres = (
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_DB_URL
  )?.trim();
  if (postgres) {
    const varName = process.env.POSTGRES_URL
      ? "POSTGRES_URL"
      : process.env.POSTGRES_PRISMA_URL
        ? "POSTGRES_PRISMA_URL"
        : process.env.POSTGRES_URL_NON_POOLING
          ? "POSTGRES_URL_NON_POOLING"
          : "SUPABASE_DB_URL";
    const cleaned = cleanDatabaseUrl(postgres);
    if (cleaned) {
      return { url: cleaned, source: varName, dialect: "postgres" };
    }
  }

  // Turso / libSQL
  const turso = (process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL)?.trim();
  if (turso) {
    const token = (process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN)?.trim();
    const varName = process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL" : "LIBSQL_URL";
    let url = cleanDatabaseUrl(turso);
    if (token && !url.includes("authToken=")) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}authToken=${encodeURIComponent(token)}`;
    }
    return { url, source: varName, dialect: "libsql" };
  }

  // MySQL / PlanetScale
  const mysql = (process.env.MYSQL_URL || process.env.PLANETSCALE_DATABASE_URL)?.trim();
  if (mysql) {
    const varName = process.env.MYSQL_URL ? "MYSQL_URL" : "PLANETSCALE_DATABASE_URL";
    const cleaned = cleanDatabaseUrl(mysql);
    if (cleaned) {
      return { url: cleaned, source: varName, dialect: "mysql" };
    }
  }

  // Outside Vercel, default to local SQLite file
  if (!process.env.VERCEL) {
    return { url: "file:./.data/app.db", source: "default", dialect: "sqlite" };
  }

  return null;
}

export function databaseUrl(): string {
  const detected = detectedDatabaseSource();
  return detected?.url ?? "";
}

export function isDatabaseConfigured(): boolean {
  return databaseUrl().length > 0;
}

function ensureLocalDbDir(target: DatabaseTarget): void {
  if (target.isLocalFile && typeof window === "undefined") {
    try {
      const filePath = target.host.replace(/^(?:file|sqlite|sqlite3):(?:\/\/)?/, "");
      const dir = path.dirname(path.resolve(filePath));
      mkdirSync(dir, { recursive: true });
    } catch {
      // directory creation is best-effort
    }
  }
}

function createDialect(url: string, target: DatabaseTarget): Dialect {
  ensureLocalDbDir(target);
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
  if (/sslmode=disable/i.test(url)) return false;
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
  ensureLocalDbDir(target);
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

export function resetDbCache(): void {
  if (cached) {
    cached.db.destroy().catch(() => {});
    cached = null;
  }
  migrated = null;
}

export function resetDbCacheForTests(): void {
  resetDbCache();
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

export function formatDatabaseError(error: unknown): string {
  if (!error) return "unknown error";
  const err = error as { code?: string; message?: string };
  const message = err.message || String(error);
  const code = err.code || "";

  if (code === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    return "Connection refused: database server is not reachable at that host and port.";
  }
  if (code === "ENOTFOUND" || message.includes("ENOTFOUND")) {
    return "Host not found: check the database host name in your connection string.";
  }
  if (code === "ETIMEDOUT" || message.includes("ETIMEDOUT") || message.includes("timeout")) {
    return "Connection timed out: the database server did not answer (check firewall / security group).";
  }
  if (code === "28P01" || message.includes("password authentication failed")) {
    return "Authentication failed: check your database username and password.";
  }
  if (code === "3D000" || (message.includes('database "') && message.includes('" does not exist'))) {
    return "Database does not exist: check the database name in your connection string.";
  }
  if (message.includes("self-signed certificate") || message.includes("SSL")) {
    return `SSL certificate error: ${message}`;
  }
  return message;
}

export interface DatabaseStatus {
  configured: boolean;
  dialect?: DbDialect;
  label?: string;
  display?: string;
  source?: string;
  connected: boolean;
  serverVersion?: string;
  tables: { name: string; rows: number | null }[];
  migrations: { name: string; applied: boolean; appliedAt: string | null }[];
  error?: string;
}

/** A thorough health check for the settings page and `/api/health`. */
export async function databaseStatus(): Promise<DatabaseStatus> {
  const detected = detectedDatabaseSource();
  if (!detected) {
    return {
      configured: false,
      connected: false,
      tables: [],
      migrations: [],
      error: "DATABASE_URL is not set",
    };
  }

  const target = parseDatabaseUrl(detected.url);
  const status: DatabaseStatus = {
    configured: true,
    dialect: target.dialect,
    label: target.host,
    display: target.display,
    source: detected.source,
    connected: false,
    tables: [],
    migrations: [],
  };

  try {
    ensureLocalDbDir(target);
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
    status.error = formatDatabaseError(error);
  }

  return status;
}

export interface DatabaseTestResult {
  ok: boolean;
  dialect?: DbDialect;
  host?: string;
  database?: string;
  serverVersion?: string;
  target?: DatabaseTarget;
  tables?: { name: string; rows: number | null }[];
  detail: string;
  error?: string;
}

/** Test an arbitrary database connection string without altering application state. */
export async function testDatabaseConnection(rawUrl: string): Promise<DatabaseTestResult> {
  const cleaned = cleanDatabaseUrl(rawUrl);
  if (!cleaned) {
    return { ok: false, detail: "Connection string is empty", error: "Connection string is empty" };
  }

  let target: DatabaseTarget;
  try {
    target = parseDatabaseUrl(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg, error: msg };
  }

  ensureLocalDbDir(target);

  const testDb = new Kysely<Database>({ dialect: createDialect(cleaned, target) });
  try {
    const version = await serverVersion(testDb, target.dialect);
    const tables: { name: string; rows: number | null }[] = [];

    for (const name of ["jobs", "job_events", "workers", "app_settings"] as const) {
      const count = await testDb
        .selectFrom(name)
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .executeTakeFirst()
        .catch(() => null);
      if (count && count.count !== undefined) {
        tables.push({ name, rows: Number(count.count) });
      }
    }

    const tableDesc =
      tables.length > 0
        ? tables.map((t) => `${t.name} (${t.rows ?? "?"})`).join(", ")
        : "no tables created yet";
    const detail = `${target.dialect} reachable${version ? ` · ${version}` : ""}; ${tableDesc}`;

    return {
      ok: true,
      dialect: target.dialect,
      host: target.host,
      database: target.database,
      serverVersion: version,
      target,
      tables,
      detail,
    };
  } catch (err) {
    const errorMsg = formatDatabaseError(err);
    return {
      ok: false,
      dialect: target.dialect,
      host: target.host,
      database: target.database,
      target,
      detail: errorMsg,
      error: errorMsg,
    };
  } finally {
    await testDb.destroy().catch(() => {});
  }
}
