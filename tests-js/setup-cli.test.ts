import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkRequirements, configureEnvironment } from "@/scripts/setup";

describe("setup requirements checker", () => {
  it("checks node version and ffmpeg status", async () => {
    const res = await checkRequirements();
    expect(res.nodeOk).toBe(true);
    expect(typeof res.nodeVersion).toBe("string");
    expect(res.ffmpeg).toBeDefined();
    expect(typeof res.ffmpeg.available).toBe("boolean");
  });
});

describe("setup environment configuration", () => {
  it("creates or updates .env with required keys and secrets", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-test-"));
    const envFile = path.join(tmpDir, ".env");

    const origCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const res = await configureEnvironment({
        databaseUrl: "file:./.data/test.db",
        storageDriver: "local",
        storageDir: "./.data/storage",
        jobRetentionDays: 3,
      });

      expect(res.envPath).toBe(envFile);
      const content = await fs.readFile(envFile, "utf-8");
      expect(content).toContain("DATABASE_URL=file:./.data/test.db");
      expect(content).toContain("STORAGE_DRIVER=local");
      expect(content).toContain("STORAGE_DIR=./.data/storage");
      expect(content).toContain("JOB_RETENTION_DAYS=3");
      expect(content).toContain("APP_SECRET=");
      expect(content).toContain("WORKER_SECRET=");
    } finally {
      process.chdir(origCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
