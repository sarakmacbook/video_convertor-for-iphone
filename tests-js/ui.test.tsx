// @vitest-environment jsdom
/**
 * The web UI itself, rendered in a DOM: the upload flow, the queue notice, saving settings and
 * the history table. `fetch`, `XMLHttpRequest` and the video element are stubbed, so nothing
 * here needs a server, a database or an encoder.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Converter } from "@/components/converter";
import { JobList } from "@/components/job-list";
import { SettingsForm } from "@/components/settings-form";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const originalCreateElement = document.createElement.bind(document);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A <video> that reports its metadata as soon as the component gives it a source. */
function stubVideoElement(): void {
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag !== "video") return originalCreateElement(tag);
    const element: Record<string, unknown> = {
      preload: "",
      duration: 12.5,
      videoWidth: 1080,
      videoHeight: 1920,
      onloadedmetadata: null,
      onerror: null,
    };
    Object.defineProperty(element, "src", {
      get: () => "blob:fake",
      set: () => queueMicrotask(() => (element.onloadedmetadata as (() => void) | null)?.()),
    });
    return element as unknown as HTMLVideoElement;
  });
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  status = 200;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(publicMethod: string, publicUrl: string): void {
    FakeXhr.instances.push(this);
    void publicMethod;
    void publicUrl;
  }

  setRequestHeader(): void {}

  addEventListener(): void {}

  abort(): void {
    this.onabort?.();
  }

  send(): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 });
    queueMicrotask(() => this.onload?.());
  }
}

const queuedJob = {
  id: "job_ui1",
  status: "queued",
  stage: "queued",
  progress: 0,
  message: "waiting for a converter",
  error: null,
  source: "web",
  createdAt: new Date().toISOString(),
  input: { name: "HOLIDAY.MOV", bytes: 4_445_049, duration: 12.5, width: 1080, height: 1920 },
  output: { bytes: null, usedOriginal: null, savedPercent: null, width: null, height: null, codec: null },
  telegram: { chatId: null, status: "none", error: null },
};

const doneJob = {
  ...queuedJob,
  id: "job_ui2",
  status: "done",
  stage: "finished",
  progress: 1,
  message: "finished: 3 639 378 bytes delivered",
  output: { bytes: 3_639_378, usedOriginal: false, savedPercent: 18.1, width: 1080, height: 1920, codec: "hevc" },
};

function detailFor(job: unknown) {
  return {
    ok: true,
    job,
    download: job === doneJob ? { url: "https://blob.example/download/HOLIDAY_small.mp4", name: "HOLIDAY_small.mp4", bytes: 3_639_378, kind: "converted" } : null,
    events: [],
    settings: { inlineMaxInputMb: 25, inlineMaxSeconds: 50, telegramConfigured: false },
  };
}

beforeEach(() => {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:fake", revokeObjectURL: () => undefined });
  stubVideoElement();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the convert page", () => {
  it("uploads the file, queues the job and offers the converted video when it is ready", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    let polls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

        if (url === "/api/uploads") {
          return jsonResponse({
            ok: true,
            upload: { url: "https://blob.example/put/HOLIDAY.MOV", method: "PUT", headers: { "content-type": "video/quicktime" }, key: "jobs/job_ui1/input/HOLIDAY.MOV", driver: "blob" },
            returnToken: "return-token",
            limits: { maxInputMb: 20 },
          });
        }
        if (url === "/api/jobs" && method === "POST") {
          return jsonResponse({ ok: true, job: queuedJob, inline: false, reason: "converting it would take about 1800s", hint: "Run a worker to convert it." });
        }
        if (url === "/api/jobs/job_ui1") {
          polls += 1;
          return jsonResponse(detailFor(polls === 1 ? queuedJob : doneJob));
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    const { container } = render(<Converter signedIn />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File([new Uint8Array(4_445_049)], "HOLIDAY.MOV", { type: "video/quicktime" });

    fireEvent.change(input, { target: { files: [file] } });

    // The browser told the server what it knows about the file, then uploaded straight to storage.
    await waitFor(() => expect(calls.some((call) => call.url === "/api/uploads")).toBe(true));
    const createCall = calls.find((call) => call.url === "/api/jobs");
    expect(createCall?.body).toMatchObject({ returnToken: "return-token", bytes: 4_445_049, duration: 12.5, width: 1080, height: 1920 });
    await waitFor(() => expect(FakeXhr.instances.length).toBe(1));

    // The job does not fit inline, so the page says so instead of pretending it is converting.
    expect(await screen.findByText(/Queued for a worker/)).toBeTruthy();
    expect(screen.getByText(/Run a worker to convert it\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Convert here anyway/ })).toBeTruthy();

    // Then the job finishes and the download link appears with the smaller file.
    expect(await screen.findByText("Converted", {}, { timeout: 6000 })).toBeTruthy();
    const link = await screen.findByRole("link", { name: /Download HOLIDAY_small\.mp4/ });
    expect(link.getAttribute("href")).toBe("https://blob.example/download/HOLIDAY_small.mp4");
    expect(screen.getByText(/18% smaller/)).toBeTruthy();
    expect(screen.getByText(/3\.6 MB/)).toBeTruthy();
  });

  it("lets a queued job be converted inside the deployment instead", async () => {
    const calls: { url: string; method: string; body?: { action?: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === "/api/uploads") {
          return jsonResponse({ ok: true, upload: { url: "https://blob.example/put", method: "PUT", headers: {}, key: "k", driver: "blob" }, returnToken: "t", limits: {} });
        }
        if (url === "/api/jobs" && method === "POST") return jsonResponse({ ok: true, job: queuedJob, inline: false, reason: "too long for a function" });
        if (url === "/api/jobs/job_ui1" && method === "PATCH") return jsonResponse({ ok: true });
        if (url === "/api/jobs/job_ui1") return jsonResponse(detailFor(queuedJob));
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    const { container } = render(<Converter signedIn />);
    fireEvent.change(container.querySelector("input[type=file]") as HTMLInputElement, {
      target: { files: [new File([new Uint8Array(10)], "clip.mov", { type: "video/quicktime" })] },
    });

    const convertHere = await screen.findByRole("button", { name: /Convert here anyway/ });
    fireEvent.click(convertHere);

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.body?.action === "convert-here")).toBe(true));
    expect(await screen.findByText(/Converting in this deployment/)).toBeTruthy();
  });

  it("shows an error when the deployment refuses the file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === "/api/uploads") return jsonResponse({ ok: false, error: "this file is 42 MB, over the 20 MB limit" }, 413);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const { container } = render(<Converter signedIn />);
    fireEvent.change(container.querySelector("input[type=file]") as HTMLInputElement, {
      target: { files: [new File([new Uint8Array(10)], "big.mov", { type: "video/quicktime" })] },
    });

    expect(await screen.findByText(/over the 20 MB limit/)).toBeTruthy();
  });
});

describe("the history page", () => {
  it("lists stored jobs and deletes one", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (method === "DELETE") return jsonResponse({ ok: true });
        return jsonResponse({ ok: true, total: 2, jobs: [queuedJob, doneJob] });
      }),
    );

    render(<JobList />);

    expect((await screen.findAllByText("HOLIDAY.MOV")).length).toBe(2); // one row per job
    expect(screen.getAllByText("2").length).toBeGreaterThan(0); // total jobs counter
    expect(screen.getByText(/3\.6 MB/)).toBeTruthy();
    expect(screen.getByText("18%")).toBeTruthy(); // saved in the table

    const deleteButton = screen.getAllByTitle("Delete this job and its files")[0];
    fireEvent.click(deleteButton);
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/jobs/job_ui1")).toBe(true));
  });
});

describe("the settings page", () => {
  const config = {
    ok: true,
    settings: {
      crf: { value: "20", source: "default", isSecret: false, label: "Quality (CRF)" },
      preset: { value: "medium", source: "environment", isSecret: false, label: "x265 preset" },
      max_input_mb: { value: "20", source: "default", isSecret: false, label: "Largest accepted video (MB)" },
      telegram_bot_token: { value: "1234••••••TING", source: "database", isSecret: true, label: "Telegram bot token" },
      telegram_delivery: { value: "server", source: "default", isSecret: false, label: "Who sends the result to Telegram" },
    },
    env: {
      nodeEnv: "production",
      appUrl: "https://example.vercel.app",
      storageDriver: "blob",
      storageDir: "/tmp/storage",
      databaseUrlSet: true,
      isVercel: true,
      ffmpegPath: null,
      ffmpegUrl: null,
      appPasswordSet: true,
      appSecretSet: true,
      workerSecretSet: true,
      tmpDir: "/tmp",
    },
    envProblems: [],
    databaseConfigured: true,
    storageDriver: "blob",
    limits: { maxUploadMb: 2000 },
    effective: { crf: 20, preset: "medium", maxInputMb: 20 },
  };

  const health = {
    database: { connected: true, dialect: "postgres", label: "neon", display: "postgres://…@ep-x.neon.tech/db", serverVersion: "17.2", tables: [{ name: "jobs", rows: 4 }] },
    storage: { driver: "blob", ok: true, detail: "wrote and read back a test blob" },
    ffmpeg: { available: true, path: "/var/task/node_modules/ffmpeg-static/ffmpeg", version: "ffmpeg version 7.0.2", hasX265: true, source: "package", ffprobe: null },
    telegram: { configured: true, webhook: "https://example.vercel.app/api/telegram/webhook/s3cret", delivery: "server", localMode: false },
    workers: { online: 1, total: 1, list: [{ id: "mac-mini", name: "mac-mini", status: "idle", online: true, jobsDone: 3, jobsFailed: 0 }] },
    jobs: { queued: 0, running: 0, done: 4, failed: 0, canceled: 0 },
    inline: { available: true, maxInputMb: 25, budgetSeconds: 50 },
  };

  it("shows the deployment status and saves a changed setting", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/config" && method === "GET") return jsonResponse(config);
        if (url === "/api/health") return jsonResponse(health);
        if (url === "/api/config" && method === "PATCH") {
          patches.push(JSON.parse(String(init?.body)));
          return jsonResponse({ ok: true, saved: { crf: "24", max_input_mb: "1500" }, settings: config.settings });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    render(<SettingsForm />);

    // What the operator needs to see about this deployment: the database it is really using,
    // the storage that answers, ffmpeg, and which workers are alive.
    expect(await screen.findByText("postgres")).toBeTruthy();
    expect(screen.getByText("neon")).toBeTruthy();
    expect(screen.getByText("read and write")).toBeTruthy();
    expect(screen.getByText(/ffmpeg version 7\.0\.2/)).toBeTruthy();
    expect(screen.getByText("mac-mini — idle (3 done)")).toBeTruthy();

    const uploadLimit = (await screen.findByLabelText(/Largest accepted video/)) as HTMLInputElement;
    expect(uploadLimit.type).toBe("number");
    expect(uploadLimit.max).toBe("2000");
    expect(screen.getByText(/Maximum supported size: 2000 MB/)).toBeTruthy();
    fireEvent.change(uploadLimit, { target: { value: "1500" } });

    const crf = (await screen.findByLabelText(/Quality \(CRF\)/)) as HTMLInputElement;
    expect(crf.value).toBe("20");
    fireEvent.change(crf, { target: { value: "24" } });

    const save = screen.getAllByRole("button", { name: "Save" })[0];
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toMatchObject({ values: { crf: "24", max_input_mb: "1500" } });
    expect(await screen.findByText(/Saved 2 setting\(s\)\./)).toBeTruthy();
  });

  it("connects the bot with its API key and user ID, then sets the webhook", async () => {
    const connects: unknown[] = [];
    const hooks: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/config" && method === "GET") return jsonResponse(config);
        if (url === "/api/health") return jsonResponse(health);
        if (url === "/api/telegram/connect" && method === "POST") {
          connects.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            ok: true,
            bot: { id: 1, username: "my_convertor_bot", name: "Converter" },
            userId: 555,
            messageSent: true,
            warning: null,
          });
        }
        if (url === "/api/telegram/setup" && method === "POST") {
          hooks.push(JSON.parse(String(init?.body)));
          return jsonResponse({ ok: true, url: "https://example.vercel.app/api/telegram/webhook/s", webhook: { url: "https://example.vercel.app/api/telegram/webhook/s" } });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    render(<SettingsForm />);
    await screen.findByText("postgres");

    const button = screen.getByRole("button", { name: "Connect bot" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // nothing to connect yet

    const token = screen.getByLabelText(/Bot API key/) as HTMLInputElement;
    expect(token.type).toBe("password"); // the key is hidden on screen
    fireEvent.change(token, { target: { value: "123456789:AAHsecret" } });
    fireEvent.change(screen.getByLabelText(/Your Telegram user ID/), { target: { value: "555" } });
    expect(button.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(await screen.findByText(/Connected @my_convertor_bot for user 555\. The webhook is set\./)).toBeTruthy();
    expect(connects).toEqual([{ token: "123456789:AAHsecret", userId: 555 }]);
    expect(hooks).toEqual([expect.objectContaining({ action: "set" })]);
    expect(token.value).toBe(""); // the key is not kept in the page after it is saved
  });

  it("tests and connects a database from the Settings page", async () => {
    const tests: unknown[] = [];
    const connects: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/config" && method === "GET") return jsonResponse(config);
        if (url === "/api/health") return jsonResponse(health);
        if (url === "/api/config/test" && method === "POST") {
          tests.push(JSON.parse(String(init?.body)));
          return jsonResponse({ ok: true, detail: "sqlite reachable · 3.45.1; jobs, app_settings" });
        }
        if (url === "/api/db/connect" && method === "POST") {
          connects.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            ok: true,
            isVercel: false,
            status: { dialect: "sqlite", label: "app.db", connected: true },
          });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );

    render(<SettingsForm />);
    await screen.findByText("postgres");

    // The Connect database card is present
    expect(screen.getByRole("heading", { name: "Connect database" })).toBeTruthy();

    const dbInput = screen.getByLabelText(/Database connection string/) as HTMLInputElement;
    const connectBtn = screen.getByRole("button", { name: "Connect database" }) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);

    // Use local SQLite preset
    const sqlitePreset = screen.getByRole("button", { name: "Use local SQLite" });
    fireEvent.click(sqlitePreset);
    expect(dbInput.value).toBe("file:./.data/app.db");
    expect(connectBtn.disabled).toBe(false);

    // Test connection button
    const testButtons = screen.getAllByRole("button", { name: "Test connection" });
    const testDbInputBtn = testButtons[testButtons.length - 1]; // the one in the Connect database card
    await act(async () => {
      fireEvent.click(testDbInputBtn);
    });

    expect(tests).toEqual([{ target: "database", url: "file:./.data/app.db" }]);
    expect(await screen.findByText(/Database test: sqlite reachable/)).toBeTruthy();

    // Connect database button
    await act(async () => {
      fireEvent.click(connectBtn);
    });

    expect(connects).toEqual([{ url: "file:./.data/app.db" }]);
    expect(await screen.findByText(/Connected to sqlite \(app\.db\)\. Saved to \.env and schema migrated\./)).toBeTruthy();
    expect(dbInput.value).toBe("");
  });

  it("asks for the password when the deployment is protected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        if (url === "/api/config" || url === "/api/health") return jsonResponse({ ok: false, error: "sign in first" }, 401);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    render(<SettingsForm />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });
});
