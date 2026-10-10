#!/usr/bin/env node
/**
 * First-time guided setup and requirements checker (`npm run setup`).
 *
 * Verifies dependencies (FFmpeg with libx265, FFprobe, Node.js), creates required
 * directories, configures .env with secrets and database/storage defaults, and
 * runs migrations so the application is immediately fully functional.
 *
 * Usage:
 *   npm run setup
 *   npm run setup -- --check     # only check requirements without modifying files
 *   npm run setup -- --yes       # accept defaults non-interactively
 */

import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

import { loadEnvFile } from "@/cli/env";
import { getDb, migrateToLatest, resetDbCache, testDatabaseConnection } from "@/lib/db";
import { describeTarget, parseDatabaseUrl } from "@/lib/db/url";
import { ffmpegStatus } from "@/lib/encoding/ffmpeg";
import { updateEnvText } from "@/lib/env-file";

loadEnvFile();

interface SetupOptions {
  checkOnly: boolean;
  nonInteractive: boolean;
  databaseUrl?: string;
  storageDriver?: "local" | "s3" | "blob";
}

function parseCliArgs(argv: string[]): SetupOptions {
  const args = argv.slice(2);
  const checkOnly = args.includes("--check") || args.includes("-c");
  const nonInteractive = args.includes("--yes") || args.includes("-y") || args.includes("--quick");

  let databaseUrl: string | undefined;
  const dbIndex = args.indexOf("--db");
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    databaseUrl = args[dbIndex + 1];
  }

  return { checkOnly, nonInteractive, databaseUrl };
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export async function checkRequirements(): Promise<{
  nodeOk: boolean;
  nodeVersion: string;
  ffmpeg: Awaited<ReturnType<typeof ffmpegStatus>>;
}> {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  const nodeOk = major >= 20;

  const ffmpeg = await ffmpegStatus();

  return { nodeOk, nodeVersion, ffmpeg };
}

export async function configureEnvironment(options: {
  databaseUrl: string;
  storageDriver: "local" | "s3" | "blob";
  storageDir: string;
  jobRetentionDays?: number;
}): Promise<{ envPath: string; created: boolean; generatedSecrets: boolean }> {
  const root = process.cwd();
  const envPath = path.resolve(root, ".env");
  const examplePath = path.resolve(root, ".env.example");

  let existing = "";
  let created = false;

  try {
    existing = await fs.readFile(envPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      created = true;
      try {
        existing = await fs.readFile(examplePath, "utf-8");
      } catch {
        existing = "";
      }
    } else {
      throw err;
    }
  }

  const updates: Record<string, string> = {
    DATABASE_URL: options.databaseUrl,
    STORAGE_DRIVER: options.storageDriver,
  };

  if (options.storageDriver === "local") {
    updates.STORAGE_DIR = options.storageDir;
  }

  let generatedSecrets = false;

  // Auto-generate secrets if not already present in the target env file
  if (!existing.includes("APP_SECRET=") || existing.match(/^\s*APP_SECRET=\s*$/m)) {
    updates.APP_SECRET = generateSecret(32);
    generatedSecrets = true;
  }

  if (!existing.includes("WORKER_SECRET=") || existing.match(/^\s*WORKER_SECRET=\s*$/m)) {
    updates.WORKER_SECRET = generateSecret(32);
    generatedSecrets = true;
  }

  if (!existing.includes("APP_URL=") || existing.match(/^\s*APP_URL=\s*$/m)) {
    updates.APP_URL = "http://localhost:3000";
  }

  if (options.jobRetentionDays !== undefined) {
    updates.JOB_RETENTION_DAYS = String(options.jobRetentionDays);
  }

  const updatedText = updateEnvText(existing, updates);
  const tempPath = `${envPath}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, updatedText, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, envPath);

  // Update in-memory process.env so subsequent steps in the same run see them
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }

  return { envPath, created, generatedSecrets };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv);

  console.log("==================================================");
  console.log(" video_convertor-for-iphone — First-time Setup");
  console.log("==================================================\n");

  // Step 1: Check requirements
  console.log("1. Checking system requirements...");
  const { nodeOk, nodeVersion, ffmpeg } = await checkRequirements();

  if (nodeOk) {
    console.log(`   ✓ Node.js: ${nodeVersion} (>=20.9 required)`);
  } else {
    console.warn(`   ⚠ Node.js: ${nodeVersion} (>=20.9 recommended)`);
  }

  if (ffmpeg.available) {
    console.log(`   ✓ FFmpeg: ${ffmpeg.path} (${ffmpeg.hasX265 ? "libx265 HEVC supported" : "no libx265"})`);
    if (ffmpeg.ffprobePath) {
      console.log(`   ✓ FFprobe: ${ffmpeg.ffprobePath}`);
    } else {
      console.warn("   ⚠ FFprobe: not found (will fall back to ffmpeg -i parsing)");
    }
  } else {
    console.warn("   ✗ FFmpeg: not found on PATH or in environment.");
    console.warn("     Install ffmpeg 5.1+ with libx265, or set FFMPEG_PATH in .env.");
  }

  if (options.checkOnly) {
    console.log("\nRequirements check complete (--check specified).");
    process.exit(ffmpeg.available ? 0 : 1);
  }

  // Step 2: Configure directories and storage
  console.log("\n2. Setting up directories & storage...");
  const defaultStorageDir = "./.data/storage";
  const defaultDataDir = "./.data";

  await fs.mkdir(defaultDataDir, { recursive: true });
  await fs.mkdir(defaultStorageDir, { recursive: true });
  console.log(`   ✓ Created local data & storage directories (${defaultStorageDir})`);

  // Step 3: Determine Database URL & environment configuration
  console.log("\n3. Configuring environment & credentials (.env)...");
  let dbUrl = options.databaseUrl || process.env.DATABASE_URL || "file:./.data/app.db";

  if (!options.nonInteractive && !options.databaseUrl && !process.env.DATABASE_URL) {
    console.log("   Choose database:");
    console.log("     1. Local SQLite file (default, no server needed)");
    console.log("     2. Custom PostgreSQL / MySQL / Turso URL");
    const choice = await prompt("   Select [1]: ");
    if (choice === "2") {
      const customUrl = await prompt("   Enter database connection string: ");
      if (customUrl) dbUrl = customUrl;
    }
  }

  const { envPath, generatedSecrets } = await configureEnvironment({
    databaseUrl: dbUrl,
    storageDriver: "local",
    storageDir: defaultStorageDir,
    jobRetentionDays: 1,
  });

  console.log(`   ✓ Configuration written to ${envPath}`);
  if (generatedSecrets) {
    console.log("   ✓ Generated secure random keys for APP_SECRET and WORKER_SECRET");
  }

  // Step 4: Test DB and run migrations
  console.log("\n4. Testing database connection and running migrations...");
  const target = parseDatabaseUrl(dbUrl);
  console.log(`   Testing connection to ${describeTarget(target)}...`);

  resetDbCache();
  const testRes = await testDatabaseConnection(dbUrl);
  if (!testRes.ok) {
    console.error(`   ✗ Connection failed: ${testRes.error}`);
    process.exit(1);
  }

  console.log(`   ✓ Connected (${testRes.serverVersion ?? "ready"})`);
  console.log("   Applying database schema migrations...");
  await migrateToLatest(getDb());
  console.log("   ✓ Schema up to date (jobs, job_events, workers, app_settings tables ready)");

  // Step 5: Summary
  console.log("\n==================================================");
  console.log(" Setup Complete! System is fully functional.");
  console.log("==================================================");
  console.log(" Next steps to run the stack:");
  console.log("   • Start web server:     npm run dev");
  console.log("   • Start worker:         npm run worker");
  console.log("   • Check health:         curl http://localhost:3000/api/health\n");
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("\nSetup error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
