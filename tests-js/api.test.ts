/**
 * End-to-end tests of the HTTP surface, run in-process against real SQLite, real local
 * storage and (when ffmpeg is installed) real conversions.
 *
 * These call the route handlers directly with `Request` objects, which is what Next does
 * after routing, so the code under test is exactly what runs in production.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { settleBackgroundWork } from "@/lib/background";
import { getDb, resetDbCacheForTests } from "@/lib/db";
import { ffmpegBinaries, makeIphoneClip } from "./helpers";
import { startFakeTelegram, type FakeTelegram } from "./fake-telegram";

import { POST as uploadsPost } from "@/app/api/uploads/route";
import { GET as jobsGet, POST as jobsPost } from "@/app/api/jobs/route";
import { GET as jobGet, PATCH as jobPatch } from "@/app/api/jobs/[id]/route";
import { PUT as localPut, GET as localGet } from "@/app/api/storage/local/[...key]/route";
import { POST as workerRegister } from "@/app/api/worker/register/route";
import { POST as workerClaim } from "@/app/api/worker/claim/route";
import { POST as workerJob } from "@/app/api/worker/jobs/[id]/route";
import { POST as telegramWebhook } from "@/app/api/telegram/webhook/[secret]/route";
import { GET as healthGet } from "@/app/api/health/route";

const dir = mkdtempSync(path.join(os.tmpdir(), "video-convertor-api-"));
const BASE = "http://localhost:3000";
let clip: { path: string; bytes: number } | null = null;

function request(pathname: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${pathname}`, init);
}

function jsonRequest(pathname: string, body: unknown, method = "POST"): Request {
  return request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A short screen recording, so the tests do not need a real iPhone video. */
async function makeClip(name: string) {
  const bins = await ffmpegBinaries();
  if (!bins) return null;
  return makeIphoneClip(bins.ffmpeg, dir, { name, seconds: 1, width: 480, height: 270, hdr: true });
}

describe("the web API", () => {
  beforeAll(async () => {
    clip = await makeClip("api_clip");
  });

  afterAll(() => {
    resetDbCacheForTests();
  });

  it("prints a health report that says what is and is not available", async () => {
    const response = await healthGet();
    const body = (await response.json()) as {
      ok: boolean;
      database: { connected: boolean; dialect?: string };
      storage: { driver: string };
      ffmpeg: { available: boolean; path: string | null };
      problems: string[];
    };
    expect(response.status).toBe(200);
    expect(body.database.connected).toBe(true);
    expect(body.database.dialect).toBe("sqlite");
    expect(body.storage.driver).toBe("local");
    expect(Array.isArray(body.problems)).toBe(true);
  });

  it("rejects an upload larger than the configured limit", async () => {
    const response = await uploadsPost(
      jsonRequest("/api/uploads", { fileName: "huge.mov", bytes: 500 * 1_000_000, contentType: "video/quicktime" }),
    );
    expect(response.status).toBe(413);
  });

  it("walks the whole path: upload → convert → download, without a worker", async () => {
    if (!clip) {
      console.warn("skipping: ffmpeg is not installed");
      return;
    }
    const bytes = readFileSync(clip.path);

    // 1. ask where to upload, then upload straight to storage (as the browser does)
    const uploadResponse = await uploadsPost(
      jsonRequest("/api/uploads", { fileName: "IMG_0001.MOV", bytes: bytes.byteLength, contentType: "video/quicktime" }),
    );
    expect(uploadResponse.status).toBe(200);
    const upload = (await uploadResponse.json()) as {
      upload: { url: string; method: string; key: string };
      returnToken: string;
      key: string;
    };
    expect(upload.key).toContain("IMG_0001.MOV");

    const putResponse = await localPut(
      request(new URL(upload.upload.url).pathname + new URL(upload.upload.url).search, {
        method: "PUT",
        headers: { "content-type": "video/quicktime" },
        body: bytes,
      }),
      { params: Promise.resolve({ key: upload.key.split("/") }) },
    );
    expect(putResponse.status).toBe(200);

    // 2. create the job; a one second clip is small enough to convert right here
    const createResponse = await jobsPost(
      jsonRequest("/api/jobs", {
        returnToken: upload.returnToken,
        bytes: bytes.byteLength,
        duration: 1,
        width: 270,
        height: 480,
      }),
    );
    const created = (await createResponse.json()) as { ok: boolean; job: { id: string }; inline: boolean };
    expect(created.ok).toBe(true);
    expect(created.inline).toBe(true);

    await settleBackgroundWork();

    // 3. read the job back
    const detailResponse = await jobGet(request(`/api/jobs/${created.job.id}`), {
      params: Promise.resolve({ id: created.job.id }),
    });
    const detail = (await detailResponse.json()) as {
      job: { status: string; output: { bytes: number; usedOriginal: boolean | null; savedPercent: number | null } };
      download: { url: string; name: string; kind: string } | null;
      events: { message: string }[];
    };
    expect(detail.job.status).toBe("done");
    expect(detail.job.output.bytes).toBeGreaterThan(0);
    expect(detail.download).not.toBeNull();
    expect(detail.download!.name).toBe("IMG_0001_small.mp4");
    expect(detail.events.length).toBeGreaterThan(1);

    // 4. download the result through the signed link
    const downloadUrl = new URL(detail.download!.url);
    const downloaded = await localGet(request(downloadUrl.pathname + downloadUrl.search), {
      params: Promise.resolve({ key: downloadUrl.pathname.split("/api/storage/local/")[1].split("/") }),
    });
    expect(downloaded.status).toBe(200);
    const output = Buffer.from(await downloaded.arrayBuffer());
    expect(output.byteLength).toBe(detail.job.output.bytes);
    expect(output.byteLength).toBeLessThan(bytes.byteLength);
    // HEVC output starts with an ftyp box; just check it is a real file of a sensible size.
    expect(output.byteLength).toBeGreaterThan(1000);

    // 5. the job appears in the list
    const listResponse = await jobsGet(request("/api/jobs?status=all"));
    const list = (await listResponse.json()) as { jobs: { id: string }[]; total: number };
    expect(list.total).toBeGreaterThan(0);
    expect(list.jobs.some((job) => job.id === created.job.id)).toBe(true);
  });

  it("queues a job that a worker has to take, and lets the worker finish it", async () => {
    if (!clip) return;
    const bytes = readFileSync(clip.path);

    const uploadResponse = await uploadsPost(
      jsonRequest("/api/uploads", { fileName: "big.mov", bytes: bytes.byteLength, contentType: "video/quicktime" }),
    );
    const upload = (await uploadResponse.json()) as { upload: { url: string }; returnToken: string; key: string };
    const putUrl = new URL(upload.upload.url);
    await localPut(
      request(putUrl.pathname + putUrl.search, { method: "PUT", body: bytes }),
      { params: Promise.resolve({ key: upload.key.split("/") }) },
    );

    // A long duration makes the job too slow for a function, so it is queued.
    const createResponse = await jobsPost(
      jsonRequest("/api/jobs", { returnToken: upload.returnToken, bytes: bytes.byteLength, duration: 3600 }),
    );
    const created = (await createResponse.json()) as { job: { id: string }; inline: boolean; reason: string };
    expect(created.inline).toBe(false);
    expect(created.reason).toMatch(/serverless|budget|worker/i);

    // The worker registers, claims, converts and reports back.
    const registerResponse = await workerRegister(
      request("/api/worker/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SECRET! },
        body: JSON.stringify({ workerId: "test-worker", name: "Test worker", version: "test" }),
      }),
    );
    expect(registerResponse.status).toBe(200);

    const claimResponse = await workerClaim(
      request("/api/worker/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SECRET! },
        body: JSON.stringify({ workerId: "test-worker" }),
      }),
    );
    const claimed = (await claimResponse.json()) as {
      job: {
        id: string;
        input: { downloadUrl: string; name: string };
        output: { uploadUrl: string; key: string; name: string };
        encoding: { crf: number; preset: string };
      } | null;
    };
    expect(claimed.job).not.toBeNull();
    expect(claimed.job!.id).toBe(created.job.id);
    expect(claimed.job!.input.downloadUrl).toContain("/api/storage/local/");

    // The worker downloads the original with the signed URL.
    const inputUrl = new URL(claimed.job!.input.downloadUrl);
    const inputResponse = await localGet(request(inputUrl.pathname + inputUrl.search), {
      params: Promise.resolve({ key: inputUrl.pathname.split("/api/storage/local/")[1].split("/") }),
    });
    expect(inputResponse.status).toBe(200);
    const workerInput = path.join(dir, "worker-input.mov");
    writeFileSync(workerInput, Buffer.from(await inputResponse.arrayBuffer()));
    expect(statSync(workerInput).size).toBe(bytes.byteLength);

    // The worker converts (the CLI does exactly this with the same code) and uploads.
    const { convertFile } = await import("@/lib/encoding/pipeline");
    const result = await convertFile(workerInput, {
      workDir: path.join(dir, "worker-out"),
      outName: claimed.job!.output.name,
      crf: claimed.job!.encoding.crf,
      preset: claimed.job!.encoding.preset,
      timeoutSeconds: 300,
    });
    expect(result.usedOriginal).toBe(false);

    const outputUrl = new URL(claimed.job!.output.uploadUrl);
    const uploadResult = await localPut(
      request(outputUrl.pathname + outputUrl.search, {
        method: "PUT",
        body: new Uint8Array(readFileSync(result.outputPath)),
      }),
      { params: Promise.resolve({ key: claimed.job!.output.key.split("/") }) },
    );
    expect(uploadResult.status).toBe(200);

    const completeResponse = await workerJob(
      request(`/api/worker/jobs/${claimed.job!.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SECRET! },
        body: JSON.stringify({
          action: "complete",
          workerId: "test-worker",
          complete: {
            usedOriginal: false,
            outputKey: claimed.job!.output.key,
            outputName: claimed.job!.output.name,
            outputBytes: result.outputBytes,
            outputWidth: result.output?.width,
            outputHeight: result.output?.height,
            outputCodec: result.output?.codec,
            sourceBytes: result.sourceBytes,
            savedPercent: 50,
          },
        }),
      }),
      { params: Promise.resolve({ id: claimed.job!.id }) },
    );
    expect((await completeResponse.json()) as object).toMatchObject({ ok: true });

    const detailResponse = await jobGet(request(`/api/jobs/${claimed.job!.id}`), {
      params: Promise.resolve({ id: claimed.job!.id }),
    });
    const detail = (await detailResponse.json()) as { job: { status: string; worker: string | null } };
    expect(detail.job.status).toBe("done");
    expect(detail.job.worker).toBe("test-worker");
  });

  it("refuses worker calls without the shared secret", async () => {
    const response = await workerClaim(
      request("/api/worker/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "stranger" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a Telegram update with the wrong secret", async () => {
    const response = await telegramWebhook(
      jsonRequest("/api/telegram/webhook/wrong-secret", { update_id: 1, message: { message_id: 1 } }),
      { params: Promise.resolve({ secret: "wrong-secret" }) },
    );
    expect(response.status).toBe(403);
  });

  it("converts a video that arrives through the Telegram webhook", async () => {
    if (!clip) return;
    let fake: FakeTelegram | null = null;
    try {
      const bins = await ffmpegBinaries();
      if (!bins) return;
      const source = readFileSync(clip.path);
      const fileId = "file_abc123";
      const fileName = "telegram-video.mov";
      fake = await startFakeTelegram(new Map([[fileId, { path: clip.path, name: fileName }]]));

      // Configure the bot through the settings table, the way the Settings page does.
      const db = getDb();
      const now = new Date().toISOString();
      for (const [key, value] of [
        ["telegram_bot_token", "123456:SECRET-token"],
        ["telegram_api_url", fake.url],
        ["telegram_webhook_secret", "webhook-secret"],
      ] as const) {
        await db.insertInto("app_settings").values({ key, value, updated_at: now }).execute();
      }
      const { invalidateSettingsCache } = await import("@/lib/settings");
      invalidateSettingsCache();

      const update = {
        update_id: 10,
        message: {
          message_id: 77,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 555, type: "private", first_name: "Sam" },
          from: { id: 555, is_bot: false, first_name: "Sam" },
          document: { file_id: fileId, file_name: fileName, file_size: source.byteLength, mime_type: "video/quicktime" },
        },
      };

      const response = await telegramWebhook(jsonRequest("/api/telegram/webhook/webhook-secret", update), {
        params: Promise.resolve({ secret: "webhook-secret" }),
      });
      expect(response.status).toBe(200);
      await settleBackgroundWork();

      // Diagnostics: what did the app record for the job, and what did Telegram see?
      const latest = await getDb().selectFrom("jobs").selectAll().orderBy("created_at", "desc").limit(1).executeTakeFirst();
      if (latest) {
        const events = await getDb().selectFrom("job_events").selectAll().where("job_id", "=", latest.id).execute();
        console.log(
          `job ${latest.id}: ${latest.status}/${latest.stage} ${latest.message ?? ""} ${latest.error ? `error=${latest.error}` : ""}`,
        );
        console.log(`events: ${events.map((event) => `${event.level}:${event.message}`).join(" | ")}`);
      } else {
        console.log("no job was created");
      }
      console.log(`telegram calls: ${fake.calls.map((call) => call.method).join(", ")}`);

      // The bot answered, converted, and sent the smaller file back.
      expect(fake.callsTo("sendMessage").length).toBeGreaterThan(0);
      const sentVideo = fake.lastCall("sendVideo");
      const sentDocument = fake.lastCall("sendDocument");
      const sent = sentVideo ?? sentDocument;
      expect(sent, "the result should have been sent back to Telegram").toBeTruthy();
      const caption = String(sent!.body.caption ?? "");
      expect(caption).toContain("MB");
      const deliveredPath = String(sent!.body.video ?? sent!.body.document ?? "").replace("FILE:", "");
      const deliveredBytes = statSync(deliveredPath).size;
      expect(deliveredBytes).toBeGreaterThan(1000);
      expect(deliveredBytes).toBeLessThan(source.byteLength);

      // Progress was reported by editing the status message.
      expect(fake.callsTo("editMessageText").length).toBeGreaterThan(0);
    } finally {
      await fake?.close();
      const db = getDb();
      await db.deleteFrom("app_settings").execute();
      const { invalidateSettingsCache } = await import("@/lib/settings");
      invalidateSettingsCache();
    }
  });

  it("lets an operator cancel a job", async () => {
    const job = await getDb()
      .insertInto("jobs")
      .values({
        id: "job_cancel_me",
        status: "queued",
        stage: "queued",
        progress: 0,
        source: "api",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        input_key: "jobs/x/input/a.mov",
        input_name: "a.mov",
        input_bytes: 10,
        attempts: 0,
        delivery_status: "none",
      })
      .executeTakeFirst();
    void job;

    const response = await jobPatch(jsonRequest("/api/jobs/job_cancel_me", { action: "cancel" }, "PATCH"), {
      params: Promise.resolve({ id: "job_cancel_me" }),
    });
    const body = (await response.json()) as { ok: boolean; job: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe("canceled");
  });
});
