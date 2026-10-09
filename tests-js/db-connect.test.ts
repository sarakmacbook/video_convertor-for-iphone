/**
 * "Connect database": URL cleaning, provider auto-detection, testing, and saving.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as configTestPost } from "@/app/api/config/test/route";
import { POST as dbConnectPost } from "@/app/api/db/connect/route";
import { detectedDatabaseSource, resetDbCache, testDatabaseConnection } from "@/lib/db";
import { cleanDatabaseUrl, parseDatabaseUrl, redactUrl } from "@/lib/db/url";
import { saveDatabaseUrlToEnv, updateEnvText } from "@/lib/env-file";

const BASE = "http://localhost:3000";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cleaning connection strings", () => {
  it("trims spaces and invisible unicode characters", () => {
    expect(cleanDatabaseUrl("  postgres://user:pass@host/db  ")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("\u200Bpostgres://user:pass@host/db\u00A0")).toBe("postgres://user:pass@host/db");
  });

  it("strips wrapping quotes and angle brackets", () => {
    expect(cleanDatabaseUrl('"postgres://user:pass@host/db"')).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("'postgres://user:pass@host/db'")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("`postgres://user:pass@host/db`")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("<postgres://user:pass@host/db>")).toBe("postgres://user:pass@host/db");
  });

  it("strips variable assignment prefixes from .env files", () => {
    expect(cleanDatabaseUrl("DATABASE_URL=postgres://user:pass@host/db")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl('export DATABASE_URL="postgres://user:pass@host/db"')).toBe(
      "postgres://user:pass@host/db",
    );
    expect(cleanDatabaseUrl("POSTGRES_URL=postgres://user:pass@host/db")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("TURSO_DATABASE_URL=libsql://db.turso.io")).toBe("libsql://db.turso.io");
  });

  it("strips psql command snippets copied from Neon / Supabase dashboards", () => {
    expect(cleanDatabaseUrl("psql 'postgres://user:pass@host/db?sslmode=require'")).toBe(
      "postgres://user:pass@host/db?sslmode=require",
    );
    expect(cleanDatabaseUrl('psql "postgres://user:pass@host/db"')).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("psql postgres://user:pass@host/db")).toBe("postgres://user:pass@host/db");
  });

  it("normalises prisma prefixes", () => {
    expect(cleanDatabaseUrl("prisma+postgres://user:pass@host/db")).toBe("postgres://user:pass@host/db");
    expect(cleanDatabaseUrl("prisma+postgresql://user:pass@host/db")).toBe("postgresql://user:pass@host/db");
  });
});

describe("parsing database targets", () => {
  it("identifies PostgreSQL targets and redacts secrets", () => {
    const target = parseDatabaseUrl("postgres://myuser:secretpass@db.example.com:5432/production?sslmode=require");
    expect(target.dialect).toBe("postgres");
    expect(target.host).toBe("db.example.com:5432");
    expect(target.database).toBe("production");
    expect(target.display).not.toContain("secretpass");
    expect(target.display).toContain("***");
  });

  it("identifies MySQL targets", () => {
    const target = parseDatabaseUrl("mysql://root:secret@localhost:3306/mydb");
    expect(target.dialect).toBe("mysql");
    expect(target.database).toBe("mydb");
    expect(target.isLocalFile).toBe(false);
  });

  it("identifies Turso and libSQL endpoints with auth tokens", () => {
    const target = parseDatabaseUrl("libsql://my-db.turso.io?authToken=superSecretJwtToken");
    expect(target.dialect).toBe("libsql");
    expect(target.host).toBe("my-db.turso.io");
    expect(target.display).not.toContain("superSecretJwtToken");
  });

  it("identifies SQLite files and strips schemes", () => {
    expect(parseDatabaseUrl("file:./.data/app.db").dialect).toBe("sqlite");
    expect(parseDatabaseUrl("sqlite:./.data/app.db").dialect).toBe("sqlite");
    expect(parseDatabaseUrl("sqlite:///var/data/app.db").host).toBe("/var/data/app.db");
    expect(parseDatabaseUrl("./.data/app.db").isLocalFile).toBe(true);
  });
});

describe("auto-detecting database source", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PRISMA_URL;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.MYSQL_URL;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("uses DATABASE_URL when set", () => {
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    const detected = detectedDatabaseSource();
    expect(detected?.source).toBe("DATABASE_URL");
    expect(detected?.dialect).toBe("postgres");
  });

  it("detects POSTGRES_URL from Vercel Postgres or Neon", () => {
    process.env.POSTGRES_URL = "postgres://default:pass@ep-pooler.postgres.vercel-storage.com:5432/verceldb";
    const detected = detectedDatabaseSource();
    expect(detected?.source).toBe("POSTGRES_URL");
    expect(detected?.dialect).toBe("postgres");
  });

  it("detects TURSO_DATABASE_URL and combines TURSO_AUTH_TOKEN", () => {
    process.env.TURSO_DATABASE_URL = "libsql://my-db.turso.io";
    process.env.TURSO_AUTH_TOKEN = "my-secret-token";
    const detected = detectedDatabaseSource();
    expect(detected?.source).toBe("TURSO_DATABASE_URL");
    expect(detected?.dialect).toBe("libsql");
    expect(detected?.url).toContain("authToken=my-secret-token");
  });

  it("detects MYSQL_URL", () => {
    process.env.MYSQL_URL = "mysql://user:pass@host:3306/db";
    const detected = detectedDatabaseSource();
    expect(detected?.source).toBe("MYSQL_URL");
    expect(detected?.dialect).toBe("mysql");
  });

  it("defaults to local SQLite when outside Vercel and no variable is set", () => {
    delete process.env.VERCEL;
    const detected = detectedDatabaseSource();
    expect(detected?.source).toBe("default");
    expect(detected?.url).toBe("file:./.data/app.db");
    expect(detected?.dialect).toBe("sqlite");
  });

  it("returns null on Vercel when no database variable is set", () => {
    process.env.VERCEL = "1";
    const detected = detectedDatabaseSource();
    expect(detected).toBeNull();
  });
});

describe("updating .env text and files", () => {
  it("replaces existing DATABASE_URL line", () => {
    const original = "PORT=3000\nDATABASE_URL=postgres://old\nNODE_ENV=development\n";
    const updated = updateEnvText(original, { DATABASE_URL: "file:./.data/app.db" });
    expect(updated).toContain("DATABASE_URL=file:./.data/app.db");
    expect(updated).not.toContain("postgres://old");
    expect(updated).toContain("PORT=3000");
  });

  it("replaces commented placeholder # DATABASE_URL=...", () => {
    const original = "# Database configuration\n# DATABASE_URL=postgres://...\nSTORAGE_DRIVER=local\n";
    const updated = updateEnvText(original, { DATABASE_URL: "file:./.data/app.db" });
    expect(updated).toContain("DATABASE_URL=file:./.data/app.db");
    expect(updated).not.toContain("# DATABASE_URL=postgres://...");
  });

  it("quotes values that contain special characters like &", () => {
    const original = "PORT=3000\n";
    const updated = updateEnvText(original, {
      DATABASE_URL: "postgres://user:pass@host/db?sslmode=require&connect_timeout=10",
    });
    expect(updated).toContain('DATABASE_URL="postgres://user:pass@host/db?sslmode=require&connect_timeout=10"');
  });

  it("saves DATABASE_URL to a file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "env-test-"));
    const envFile = path.join(tmpDir, ".env");
    await fs.writeFile(envFile, "EXISTING=123\n# DATABASE_URL=placeholder\n");

    const result = await saveDatabaseUrlToEnv("file:./.data/test.db", envFile);
    expect(result.created).toBe(false);

    const content = await fs.readFile(envFile, "utf-8");
    expect(content).toContain("DATABASE_URL=file:./.data/test.db");
    expect(content).toContain("EXISTING=123");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("testing and connecting database through API", () => {
  it("tests an arbitrary SQLite database URL", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-test-"));
    const dbPath = path.join(tmpDir, "custom.db");
    const testResult = await testDatabaseConnection(`file:${dbPath}`);

    expect(testResult.ok).toBe(true);
    expect(testResult.dialect).toBe("sqlite");
    expect(testResult.serverVersion).toBeDefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/config/test tests a provided database URL", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-test-"));
    const dbPath = path.join(tmpDir, "api-test.db");

    const response = await configTestPost(jsonRequest("/api/config/test", { target: "database", url: `file:${dbPath}` }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toContain("sqlite reachable");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/db/connect verifies, migrates, and connects a database", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-connect-test-"));
    const dbPath = path.join(tmpDir, "connected.db");

    const response = await dbConnectPost(jsonRequest("/api/db/connect", { url: `file:${dbPath}` }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      status: { connected: boolean; tables: { name: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.status.connected).toBe(true);
    const tableNames = body.status.tables.map((t) => t.name);
    expect(tableNames).toContain("jobs");
    expect(tableNames).toContain("app_settings");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/db/connect rejects an empty URL", async () => {
    const response = await dbConnectPost(jsonRequest("/api/db/connect", { url: "" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("required");
  });
});
