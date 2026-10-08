#!/usr/bin/env node
/**
 * Create or update the schema (`npm run db:migrate`).
 *
 * The web app also migrates on its first request, so this is mostly useful before deploying,
 * or to see which database you are actually talking to.
 */

import { databaseStatus, isDatabaseConfigured, migrateToLatest, getDb, databaseUrl, resetDbCacheForTests } from "@/lib/db";
import { describeTarget, parseDatabaseUrl } from "@/lib/db/url";
import { loadEnvFile } from "@/cli/env";

loadEnvFile();

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set. Add it to .env or export it. See docs/VERCEL.md.");
    process.exit(2);
  }

  const target = parseDatabaseUrl(databaseUrl());
  console.log(`database: ${describeTarget(target)}`);
  console.log(`          ${target.display}`);

  if (target.isLocalFile) {
    const { mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.dirname(path.resolve(target.host)), { recursive: true });
  }

  await migrateToLatest(getDb());
  const status = await databaseStatus();
  if (!status.connected) {
    console.error(`could not connect: ${status.error}`);
    process.exit(1);
  }

  console.log(`server:   ${status.serverVersion ?? "unknown"}`);
  for (const table of status.tables) console.log(`table:    ${table.name} — ${table.rows ?? "?"} rows`);
  for (const migration of status.migrations) {
    console.log(`migration ${migration.applied ? "✓" : "✗"} ${migration.name}${migration.appliedAt ? ` (${migration.appliedAt})` : ""}`);
  }
  console.log("\nschema is up to date");
  resetDbCacheForTests();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
