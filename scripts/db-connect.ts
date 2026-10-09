#!/usr/bin/env node
/**
 * Guided CLI to connect a database (`npm run db:connect`).
 *
 * Checks credentials, creates or updates the schema tables, and saves DATABASE_URL to .env.
 *
 * Usage:
 *   npm run db:connect
 *   npm run db:connect -- "postgres://user:password@host/db"
 *   npm run db:connect -- --sqlite
 */

import { loadEnvFile } from "@/cli/env";
import { testDatabaseConnection, migrateToLatest, getDb, resetDbCache } from "@/lib/db";
import { cleanDatabaseUrl, describeTarget, parseDatabaseUrl } from "@/lib/db/url";
import { saveDatabaseUrlToEnv } from "@/lib/env-file";
import * as readline from "node:readline";

loadEnvFile();

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let rawUrl = "";

  if (args.includes("--sqlite") || args.includes("-s")) {
    rawUrl = "file:./.data/app.db";
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    rawUrl = args[0];
  } else if (process.env.DATABASE_URL) {
    console.log(`Current DATABASE_URL: ${process.env.DATABASE_URL}`);
    const input = await prompt("Enter new DATABASE_URL (or press Enter to test current, or type 'sqlite'): ");
    if (!input) {
      rawUrl = process.env.DATABASE_URL;
    } else if (input.toLowerCase() === "sqlite") {
      rawUrl = "file:./.data/app.db";
    } else {
      rawUrl = input;
    }
  } else {
    console.log("Connect a database for video converter.");
    console.log("Options: paste a PostgreSQL, MySQL, Turso connection string, or press Enter for SQLite.\n");
    const input = await prompt("Database URL [file:./.data/app.db]: ");
    rawUrl = input || "file:./.data/app.db";
  }

  const cleaned = cleanDatabaseUrl(rawUrl);
  if (!cleaned) {
    console.error("No database URL provided.");
    process.exit(1);
  }

  const target = parseDatabaseUrl(cleaned);
  console.log(`\nTesting connection to ${describeTarget(target)}...`);

  const testResult = await testDatabaseConnection(cleaned);
  if (!testResult.ok) {
    console.error(`✗ Connection failed: ${testResult.error}`);
    process.exit(1);
  }

  console.log(`✓ Connected (${testResult.serverVersion ?? "ready"})`);

  const { path: envPath } = await saveDatabaseUrlToEnv(cleaned);
  console.log(`✓ Saved DATABASE_URL to ${envPath}`);

  process.env.DATABASE_URL = cleaned;
  resetDbCache();

  console.log("Applying schema migrations...");
  await migrateToLatest(getDb());
  console.log("✓ Schema up to date (jobs, job_events, workers, app_settings)");
  console.log("\nDatabase successfully connected! You're ready to run: npm run dev");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
