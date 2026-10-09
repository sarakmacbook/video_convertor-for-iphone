"use client";

/**
 * The Settings page.
 *
 * Everything an operator needs to see at a glance: which database is in use, whether storage
 * works, whether ffmpeg is there and whether workers are running — plus the settings that can
 * be changed without a redeploy, and the Telegram webhook buttons.
 */

import { useCallback, useEffect, useState } from "react";

import { parseBotToken, parseUserId } from "@/lib/telegram/connect";

interface SettingEntry {
  value: string;
  source: "database" | "environment" | "default";
  isSecret: boolean;
  label: string;
}

interface ConfigResponse {
  ok: boolean;
  settings: Record<string, SettingEntry>;
  env: {
    nodeEnv: string;
    appUrl: string | null;
    storageDriver: string;
    storageDir: string;
    databaseUrlSet: boolean;
    isVercel: boolean;
    ffmpegPath: string | null;
    ffmpegUrl: string | null;
    appPasswordSet: boolean;
    appSecretSet: boolean;
    workerSecretSet: boolean;
    tmpDir: string;
  };
  envProblems: string[];
  databaseConfigured: boolean;
  storageDriver: string;
  limits: { maxUploadMb: number };
  effective: Record<string, string | number | boolean>;
}

interface HealthResponse {
  database: { connected: boolean; dialect?: string; label?: string; display?: string; serverVersion?: string; tables: { name: string; rows: number | null }[]; error?: string };
  storage: { driver: string; ok: boolean; detail: string };
  ffmpeg: { available: boolean; path: string | null; version: string | null; hasX265: boolean; source: string; ffprobe: string | null };
  telegram: { configured: boolean; webhook: string | null; delivery: string; localMode: boolean; error?: string };
  workers: { online: number; total: number; list: { id: string; name: string; status: string; online: boolean; jobsDone: number; jobsFailed: number }[] };
  jobs: Record<string, number>;
  inline: { available: boolean; maxInputMb: number; budgetSeconds: number };
}

const ENCODING_KEYS = ["crf", "preset", "max_input_mb", "inline_max_input_mb", "inline_max_seconds", "inline_speed_factor", "worker_max_attempts", "job_retention_days"];
const TELEGRAM_KEYS = ["telegram_bot_token", "telegram_api_url", "telegram_local_mode", "telegram_delivery", "telegram_webhook_secret"];
const ACCESS_KEYS = ["allowed_user_ids"];
const OTHER_KEYS = ["log_level"];

const SELECT_OPTIONS: Record<string, string[]> = {
  preset: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
  telegram_local_mode: ["false", "true"],
  telegram_delivery: ["server", "worker", "off"],
  log_level: ["DEBUG", "INFO", "WARNING", "ERROR"],
};

const HELP: Record<string, string> = {
  crf: "Quality, 0–51. Lower is closer to the original and bigger. 18–22 is the useful range.",
  preset: "Encoder speed. Slower presets make slightly smaller files and take much longer.",
  max_input_mb: "Largest video accepted from the web UI and from Telegram. Increase this value and save to allow larger files. For Telegram, the public Bot API still caps downloads at 20 MB; larger videos need a local Bot API server.",
  inline_max_input_mb: "Files up to this size may be converted inside the deployment (no worker).",
  inline_max_seconds: "Time budget for an inline conversion; longer jobs wait for a worker.",
  inline_speed_factor: "How fast the encoder is expected to run, as a multiple of real time (0.4 ≈ 2.5× longer than the video).",
  worker_max_attempts: "How many times a job may be retried before it is marked as failed.",
  job_retention_days: "How long finished jobs are kept before cleanup (0 keeps them forever).",
  allowed_user_ids: "Comma-separated Telegram user IDs allowed to use the bot. Empty means anyone.",
  telegram_bot_token: "Token from @BotFather. Stored in your database; leave empty to use the BOT_TOKEN environment variable.",
  telegram_api_url: "Only change this for a self-hosted Bot API server (e.g. http://127.0.0.1:8081).",
  telegram_local_mode: "Set to true only when the bot token is talking to a local Bot API server started with --local.",
  telegram_delivery: "Who sends the converted video to Telegram: this deployment, or the worker (needed in local mode).",
  telegram_webhook_secret: "Secret in the webhook URL. Generated automatically by the button above.",
  log_level: "How much the deployment logs.",
};

export function SettingsForm() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testChatId, setTestChatId] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [connectToken, setConnectToken] = useState("");
  const [connectUserId, setConnectUserId] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    const [configResponse, healthResponse] = await Promise.all([
      fetch("/api/config", { cache: "no-store" }),
      fetch("/api/health", { cache: "no-store" }),
    ]);
    if (configResponse.status === 401) {
      setNeedsLogin(true);
      return;
    }
    setConfig((await configResponse.json()) as ConfigResponse);
    setHealth((await healthResponse.json()) as HealthResponse);
    setNeedsLogin(false);
    if (!publicUrl) setPublicUrl(window.location.origin);
  }, [publicUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const login = useCallback(async () => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (body.ok) {
      setPassword("");
      await load();
    } else {
      setMessage({ tone: "bad", text: body.error ?? "could not sign in" });
    }
  }, [password, load]);

  const save = useCallback(async () => {
    setBusy("save");
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: draft }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; saved?: Record<string, string> };
      if (!body.ok) setMessage({ tone: "bad", text: body.error ?? "could not save" });
      else {
        setMessage({ tone: "good", text: `Saved ${Object.keys(body.saved ?? {}).length} setting(s).` });
        setDraft({});
        await load();
      }
    } finally {
      setBusy(null);
    }
  }, [draft, load]);

  const clearKey = useCallback(
    async (key: string) => {
      setBusy(key);
      try {
        await fetch(`/api/config?key=${encodeURIComponent(key)}`, { method: "DELETE" });
        await load();
        setMessage({ tone: "good", text: `${key} now uses the environment value again.` });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const test = useCallback(async (target: "database" | "storage" | "ffmpeg" | "telegram") => {
    setBusy(`test:${target}`);
    try {
      const response = await fetch("/api/config/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, chatId: target === "telegram" && testChatId ? Number(testChatId) : undefined }),
      });
      const body = (await response.json()) as { ok: boolean; detail?: string; error?: string };
      setMessage({ tone: body.ok ? "good" : "bad", text: `${target}: ${body.detail ?? body.error ?? "no answer"}` });
      await load();
    } finally {
      setBusy(null);
    }
  }, [testChatId, load]);

  const webhook = useCallback(
    async (action: "set" | "delete" | "info") => {
      setBusy(`webhook:${action}`);
      try {
        const response = await fetch("/api/telegram/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, publicUrl: publicUrl || undefined }),
        });
        const body = (await response.json()) as { ok: boolean; url?: string; error?: string; webhook?: { url?: string; pending_update_count?: number; last_error_message?: string } };
        if (body.ok) {
          setMessage({
            tone: "good",
            text:
              action === "delete"
                ? "Webhook removed. Telegram will not send updates until you set it again."
                : `Webhook is ${body.webhook?.url ?? body.url ?? "set"}${body.webhook?.last_error_message ? ` — last error: ${body.webhook.last_error_message}` : ""}`,
          });
        } else {
          setMessage({ tone: "bad", text: body.error ?? "the webhook call failed" });
        }
        await load();
      } finally {
        setBusy(null);
      }
    },
    [publicUrl, load],
  );

  const connect = useCallback(async () => {
    const token = parseBotToken(connectToken);
    if (!token) {
      setMessage({
        tone: "bad",
        text: "the bot API key looks wrong. Copy the whole token from @BotFather, e.g. 123456789:AAH…",
      });
      return;
    }
    const userId = parseUserId(connectUserId);
    if (userId === null) {
      setMessage({
        tone: "bad",
        text: "the user ID must be a whole number, e.g. 123456789. Ask @userinfobot for yours.",
      });
      return;
    }
    setBusy("connect");
    try {
      const response = await fetch("/api/telegram/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, userId }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        error?: string;
        bot?: { username: string | null; name: string | null };
        warning?: string | null;
      };
      if (!body.ok) {
        setMessage({ tone: "bad", text: body.error ?? "could not connect the bot" });
        return;
      }
      // The key is saved: forget it in the page, then point Telegram at this deployment.
      setConnectToken("");
      const botName = body.bot?.username ? `@${body.bot.username}` : "the bot";
      const hookResponse = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", publicUrl: publicUrl || undefined }),
      });
      const hook = (await hookResponse.json()) as { ok: boolean; error?: string };
      if (!hook.ok) {
        setMessage({
          tone: "warn",
          text: `Connected ${botName}, but the webhook was not set: ${hook.error ?? "unknown error"}. Fix the public URL below and press Set the webhook.`,
        });
      } else {
        setMessage({
          tone: body.warning ? "warn" : "good",
          text: `Connected ${botName} for user ${userId}. The webhook is set.${body.warning ? ` ${body.warning}` : ""}`,
        });
      }
      await load();
    } finally {
      setBusy(null);
    }
  }, [connectToken, connectUserId, publicUrl, load]);

  if (needsLogin) {
    return (
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>Sign in</h2>
        <p className="dim">This deployment is protected by APP_PASSWORD.</p>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
          />
        </div>
        <button className="btn primary" onClick={() => void login()}>
          Sign in
        </button>
        {message && <div className={`banner ${message.tone}`} style={{ marginTop: 14, marginBottom: 0 }}>{message.text}</div>}
      </div>
    );
  }

  if (!config) return <p className="dim">Loading…</p>;

  const field = (key: string) => {
    const entry = config.settings[key];
    if (!entry) return null;
    const value = draft[key] ?? entry.value;
    const options = SELECT_OPTIONS[key];
    return (
      <div className="field" key={key}>
        <label htmlFor={`setting-${key}`}>
          {entry.label}{" "}
          {entry.source === "database" ? (
            <span className="pill info">database</span>
          ) : entry.source === "environment" ? (
            <span className="pill">environment</span>
          ) : (
            <span className="pill">default</span>
          )}
        </label>
        {options ? (
          <select
            id={`setting-${key}`}
            value={value}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`setting-${key}`}
            type={entry.isSecret ? "password" : key === "max_input_mb" ? "number" : "text"}
            inputMode={key === "max_input_mb" ? "numeric" : undefined}
            min={key === "max_input_mb" ? 1 : undefined}
            max={key === "max_input_mb" ? config.limits.maxUploadMb : undefined}
            step={key === "max_input_mb" ? 1 : undefined}
            autoComplete={entry.isSecret ? "new-password" : undefined}
            spellCheck={false}
            value={entry.isSecret && draft[key] === undefined ? "" : value}
            placeholder={entry.isSecret ? (entry.value ? "saved — type a new key to replace it" : "not set") : ""}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          />
        )}
        {HELP[key] && (
          <div className="help">
            {HELP[key]}
            {key === "max_input_mb" && ` Maximum supported size: ${config.limits.maxUploadMb} MB.`}
          </div>
        )}
        {entry.source === "database" && (
          <button className="btn small ghost" style={{ marginTop: 6 }} onClick={() => void clearKey(key)} disabled={busy === key}>
            Use the environment value instead
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      {message && <div className={`banner ${message.tone}`}>{message.text}</div>}
      {config.envProblems.length > 0 && (
        <div className="banner warn">
          <strong>Environment problems</strong>
          <ul>
            {config.envProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <h2>Status</h2>
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <div className="grid two">
          <div>
            <h3>Database</h3>
            <dl className="kv">
              <dt>State</dt>
              <dd>
                {health?.database.connected ? (
                  <span className="pill good">
                    <span className="dot" /> connected
                  </span>
                ) : (
                  <span className="pill bad">
                    <span className="dot" /> {config.databaseConfigured ? "unreachable" : "not configured"}
                  </span>
                )}
              </dd>
              <dt>Engine</dt>
              <dd>
                {health?.database.dialect ?? "—"} {health?.database.serverVersion ? <span className="faint">· {health.database.serverVersion.slice(0, 40)}</span> : null}
              </dd>
              <dt>Host</dt>
              <dd className="mono">{health?.database.label ?? "—"}</dd>
              <dt>Tables</dt>
              <dd>
                {health?.database.tables.map((table) => `${table.name} (${table.rows ?? "?"})`).join(", ") || "—"}
              </dd>
            </dl>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => void test("database")} disabled={busy === "test:database"}>
                Test connection
              </button>
            </div>
          </div>

          <div>
            <h3>Storage</h3>
            <dl className="kv">
              <dt>Driver</dt>
              <dd>{config.storageDriver}</dd>
              <dt>State</dt>
              <dd>
                {health?.storage.ok ? (
                  <span className="pill good">
                    <span className="dot" /> read and write
                  </span>
                ) : (
                  <span className="pill warn">
                    <span className="dot" /> {health?.storage.detail ?? "unknown"}
                  </span>
                )}
              </dd>
            </dl>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => void test("storage")} disabled={busy === "test:storage"}>
                Test storage
              </button>
            </div>
          </div>

          <div>
            <h3>ffmpeg</h3>
            <dl className="kv">
              <dt>State</dt>
              <dd>
                {health?.ffmpeg.available ? (
                  <span className="pill good">
                    <span className="dot" /> ready
                  </span>
                ) : (
                  <span className="pill warn">
                    <span className="dot" /> not available
                  </span>
                )}
              </dd>
              <dt>Version</dt>
              <dd className="mono">{health?.ffmpeg.version ?? "—"}</dd>
              <dt>Path</dt>
              <dd className="mono">{health?.ffmpeg.path ?? "—"}</dd>
              <dt>ffprobe</dt>
              <dd className="mono">{health?.ffmpeg.ffprobe ?? "not present (files are inspected with ffmpeg -i)"}</dd>
            </dl>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={() => void test("ffmpeg")} disabled={busy === "test:ffmpeg"}>
                Test ffmpeg
              </button>
            </div>
          </div>

          <div>
            <h3>Workers</h3>
            <dl className="kv">
              <dt>Online</dt>
              <dd>
                {health?.workers.online ? (
                  <span className="pill good">
                    <span className="dot" /> {health.workers.online}
                  </span>
                ) : (
                  <span className="pill warn">
                    <span className="dot" /> none (inline only)
                  </span>
                )}
              </dd>
              <dt>Queue</dt>
              <dd>
                {health?.jobs.queued ?? 0} waiting · {health?.jobs.running ?? 0} converting
              </dd>
              <dt>Done / failed</dt>
              <dd>
                {health?.jobs.done ?? 0} / {health?.jobs.failed ?? 0}
              </dd>
            </dl>
            {health?.workers.list?.length ? (
              <ul className="dim" style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: "0.85rem" }}>
                {health.workers.list.map((worker) => (
                  <li key={worker.id}>
                    {worker.name} — {worker.online ? worker.status : "offline"} ({worker.jobsDone} done
                    {worker.jobsFailed ? `, ${worker.jobsFailed} failed` : ""})
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dim" style={{ marginTop: 8, fontSize: "0.85rem" }}>
                Start one with <code className="mono">npm run worker</code> on any machine that can reach this
                deployment, or with the Python worker in <code className="mono">worker/</code>.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Encoding</h2>
          <div className="spacer" />
          <span className="pill">
            {String(config.effective.crf)} · {String(config.effective.preset)} · {String(config.effective.maxInputMb)} MB
          </span>
          <button className="btn primary small" onClick={() => void save()} disabled={busy === "save" || Object.keys(draft).length === 0}>
            Save
          </button>
        </div>
        <div className="grid two">
          {ENCODING_KEYS.map((key) => field(key))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Connect your bot</h2>
          <div className="spacer" />
          <span className={`pill ${health?.telegram.configured ? "good" : "warn"}`}>
            <span className="dot" /> {health?.telegram.configured ? "connected" : "not connected"}
          </span>
        </div>
        <p className="dim" style={{ marginTop: 0 }}>
          Paste the bot API key from @BotFather (the whole message is fine) and your Telegram user ID. The key is
          checked with Telegram, saved, and the webhook is set. Only that user will be allowed to use the bot. Open
          your bot in Telegram and press Start first, or the confirmation message cannot be delivered.
        </p>
        <div className="grid two">
          <div className="field">
            <label htmlFor="connect-token">Bot API key</label>
            <input
              id="connect-token"
              name="telegram-bot-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={connectToken}
              onChange={(event) => setConnectToken(event.target.value)}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                const token = parseBotToken(text);
                if (token && token !== text.trim()) {
                  event.preventDefault();
                  setConnectToken(token);
                }
              }}
              placeholder="123456789:AAH…"
            />
          </div>
          <div className="field">
            <label htmlFor="connect-user-id">Your Telegram user ID</label>
            <input
              id="connect-user-id"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={connectUserId}
              onChange={(event) => setConnectUserId(event.target.value)}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                const id = parseUserId(text);
                if (id !== null && String(id) !== text.trim()) {
                  event.preventDefault();
                  setConnectUserId(String(id));
                }
              }}
              placeholder="123456789"
            />
            <div className="help">
              Ask @userinfobot on Telegram for your ID. Connecting replaces the allowed user IDs below with this one.
            </div>
          </div>
        </div>
        <div className="btn-row">
          <button
            className="btn primary small"
            onClick={() => void connect()}
            disabled={busy === "connect" || !connectToken.trim() || !connectUserId.trim()}
            title={
              !connectToken.trim()
                ? "Paste the bot API key first"
                : !connectUserId.trim()
                  ? "Paste your Telegram user ID too"
                  : undefined
            }
          >
            {busy === "connect" ? "Connecting…" : "Connect bot"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Telegram</h2>
          <div className="spacer" />
          <span className={`pill ${health?.telegram.configured ? "good" : "warn"}`}>
            <span className="dot" /> {health?.telegram.configured ? "bot configured" : "no bot token"}
          </span>
        </div>

        <div className="grid two">{TELEGRAM_KEYS.map((key) => field(key))}</div>

        <div className="field">
          <label htmlFor="public-url">Public URL for the webhook</label>
          <input
            id="public-url"
            type="text"
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
            placeholder="https://your-project.vercel.app"
          />
          <div className="help">
            Telegram must be able to reach this URL. Use your production domain (or a stable preview URL).
          </div>
        </div>

        <div className="btn-row">
          <button className="btn primary small" onClick={() => void webhook("set")} disabled={busy === "webhook:set"}>
            Set the webhook
          </button>
          <button className="btn small" onClick={() => void webhook("info")} disabled={busy === "webhook:info"}>
            Check the webhook
          </button>
          <button className="btn small ghost" onClick={() => void webhook("delete")} disabled={busy === "webhook:delete"}>
            Delete the webhook
          </button>
        </div>

        {health?.telegram.webhook && (
          <p className="dim" style={{ marginTop: 12, marginBottom: 0 }}>
            Current webhook: <span className="mono">{health.telegram.webhook}</span>
          </p>
        )}
        {health?.telegram.error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{health.telegram.error}</div>}

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="test-chat">Send a test message to a chat id</label>
          <div className="row">
            <input
              id="test-chat"
              type="text"
              value={testChatId}
              onChange={(event) => setTestChatId(event.target.value)}
              placeholder="123456789"
              style={{ maxWidth: 200 }}
            />
            <button className="btn small" onClick={() => void test("telegram")} disabled={busy === "test:telegram"}>
              Test the bot
            </button>
          </div>
          <div className="help">
            Message your bot on Telegram, then ask any &ldquo;my user ID&rdquo; bot for your ID. You can also add it
            to <code className="mono">allowed_user_ids</code> below to keep the bot private.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Access</h2>
          <div className="spacer" />
          <button className="btn primary small" onClick={() => void save()} disabled={busy === "save" || Object.keys(draft).length === 0}>
            Save
          </button>
        </div>
        <div className="grid two">
          {ACCESS_KEYS.map((key) => field(key))}
          {OTHER_KEYS.map((key) => field(key))}
        </div>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Web UI password</dt>
          <dd>{config.env.appPasswordSet ? <span className="pill good">APP_PASSWORD is set</span> : <span className="pill warn">open to anyone — set APP_PASSWORD</span>}</dd>
          <dt>Cookie signing</dt>
          <dd>{config.env.appSecretSet ? <span className="pill good">APP_SECRET is set</span> : <span className="pill warn">APP_SECRET missing: links break on restart</span>}</dd>
          <dt>Worker secret</dt>
          <dd>{config.env.workerSecretSet ? <span className="pill good">WORKER_SECRET is set</span> : <span className="pill warn">WORKER_SECRET missing: workers cannot connect</span>}</dd>
          <dt>Running on</dt>
          <dd>{config.env.isVercel ? "Vercel" : "a normal server"} · {config.env.nodeEnv}</dd>
        </dl>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Database and storage come from the environment</h2>
        </div>
        <p className="dim">
          The connection string has to be an environment variable: the app needs it before it can read any
          setting. Change <code className="mono">DATABASE_URL</code> in your Vercel project (or <code className="mono">.env</code>
          ) to point at PostgreSQL, MySQL, SQLite or Turso — no code changes. The schema is created automatically
          on the first request.
        </p>
        <dl className="kv">
          <dt>DATABASE_URL</dt>
          <dd>{config.env.databaseUrlSet ? <span className="pill good">set</span> : <span className="pill bad">missing</span>}</dd>
          <dt>STORAGE_DRIVER</dt>
          <dd>{config.env.storageDriver}</dd>
          <dt>Storage location</dt>
          <dd className="mono">{config.env.storageDir}</dd>
          <dt>Temporary files</dt>
          <dd className="mono">{config.env.tmpDir}</dd>
          <dt>FFMPEG_PATH</dt>
          <dd className="mono">{config.env.ffmpegPath ?? "not set"}</dd>
          <dt>FFMPEG_URL</dt>
          <dd className="mono">{config.env.ffmpegUrl ?? "not set"}</dd>
        </dl>
        <p className="dim" style={{ marginTop: 12, marginBottom: 0 }}>
          See <code className="mono">docs/VERCEL.md</code> for ready-made connection strings for Neon, Vercel Postgres,
          Supabase, PlanetScale and Turso.
        </p>
      </div>
    </div>
  );
}
