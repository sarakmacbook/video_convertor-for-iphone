/**
 * "Connect database" from the Settings page: verifies connection, runs migrations,
 * updates process environment, and saves DATABASE_URL to .env (on non-Vercel environments).
 */

import { databaseStatus, migrateToLatest, resetDbCache, testDatabaseConnection } from "@/lib/db";
import { cleanDatabaseUrl } from "@/lib/db/url";
import { saveDatabaseUrlToEnv } from "@/lib/env-file";
import { fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { invalidateSettingsCache } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DbConnectRequest {
  url?: unknown;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();

    const body = await readJson<DbConnectRequest>(request);
    const raw = typeof body.url === "string" ? body.url : "";
    const cleaned = cleanDatabaseUrl(raw);

    if (!cleaned) {
      return fail("Database connection string is required", 400);
    }

    // 1. Verify credentials and connectivity first
    const testResult = await testDatabaseConnection(cleaned);
    if (!testResult.ok) {
      return fail(testResult.error || "Could not connect to the database", 400);
    }

    const isVercel = Boolean(process.env.VERCEL);
    let envSaved = false;
    let envPath: string | null = null;

    // 2. On writeable filesystems (local / VPS / Docker), persist to .env
    if (!isVercel) {
      try {
        const saved = await saveDatabaseUrlToEnv(cleaned);
        envSaved = true;
        envPath = saved.path;
      } catch (err) {
        console.warn("Could not save DATABASE_URL to .env file:", err);
      }
    }

    // 3. Update the running process environment & active Kysely instance
    process.env.DATABASE_URL = cleaned;
    resetDbCache();

    // 4. Ensure schema tables are created
    await migrateToLatest();
    invalidateSettingsCache();

    // 5. Query status of the freshly connected database
    const status = await databaseStatus();

    return json({
      ok: true,
      envSaved,
      envPath,
      isVercel,
      target: testResult.target,
      status,
      copySnippet: isVercel ? `DATABASE_URL="${cleaned}"` : undefined,
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/db/connect");
  }
}
