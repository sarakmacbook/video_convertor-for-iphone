/**
 * Test environment.
 *
 * Tests never touch a real database, storage bucket or Telegram account. Each test file gets
 * its own SQLite file and storage directory under the OS temp folder, so tests can run in
 * parallel without interfering with each other.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "video-convertor-test-"));

// `NODE_ENV` is declared read-only in Next's types; tests still need to set it.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_DIR = path.join(tmp, "storage");
process.env.WORK_DIR = path.join(tmp, "work");
process.env.APP_SECRET = "test-secret-that-is-long-enough";
process.env.WORKER_SECRET = "test-worker-secret-long-enough";
delete env.APP_PASSWORD;
// Tests use the local Bot API path only when they opt in.
delete env.BOT_TOKEN;
delete env.TELEGRAM_WEBHOOK_SECRET;

export const testTmpDir = tmp;
