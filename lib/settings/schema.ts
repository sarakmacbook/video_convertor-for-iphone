/**
 * Settings come from two places:
 *
 *   1. environment variables — deployment-level and infrastructure (database URL, storage
 *      credentials, secrets). Read-only in the UI, shown for reference with secrets masked.
 *   2. the `app_settings` table — everything an operator may want to tune without a redeploy
 *      (quality, limits, the Telegram bot token, the webhook secret, allowed user IDs…).
 *      Edited on the Settings page.
 *
 * A value in the database always wins over the environment, so the same deployment can be
 * re-pointed at a different bot or quality level from the browser. Every value falls back to
 * the environment, then to a default, so an unconfigured installation still boots.
 */

import { z } from "zod";

import { parseBotToken } from "@/lib/telegram/connect";

export const X265_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

export const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const;

/** Telegram limits for the public cloud Bot API. */
export const CLOUD_DOWNLOAD_LIMIT_MB = 20;
export const CLOUD_UPLOAD_LIMIT_MB = 50;
/** A self-hosted Bot API server (--local) raises both to 2000 MB. */
export const LOCAL_SERVER_LIMIT_MB = 2000;
/** Hard cap on any uploaded video, whatever the settings say: 1 GB. */
export const MAX_UPLOAD_MB = 1000;
export const MB = 1_000_000;
export const DEFAULT_API_URL = "https://api.telegram.org";

export const DEFAULT_BOT_TOKEN_ENV = "BOT_TOKEN";

/** Keys that can be overridden in the database, with their validation rules. */
export const overridableSettings = {
  crf: z.coerce.number().int().min(0).max(51),
  preset: z.enum(X265_PRESETS),
  max_input_mb: z.coerce.number().int().min(1).max(MAX_UPLOAD_MB),
  allowed_user_ids: z.string().regex(/^[\d,\s]*$/, "comma-separated Telegram user IDs"),
  inline_max_input_mb: z.coerce.number().int().min(1).max(200),
  inline_max_seconds: z.coerce.number().int().min(5).max(900),
  inline_speed_factor: z.coerce.number().min(0.01).max(10),
  worker_max_attempts: z.coerce.number().int().min(1).max(10),
  job_retention_days: z.coerce.number().int().min(0).max(365),
  telegram_bot_token: z.string().max(200),
  telegram_webhook_secret: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _ only"),
  telegram_api_url: z.string().url(),
  telegram_local_mode: z.enum(["true", "false"]),
  telegram_delivery: z.enum(["server", "worker", "off"]),
  log_level: z.enum(LOG_LEVELS),
} as const;

export type OverridableKey = keyof typeof overridableSettings;

/** Keys the UI may write, in the order they appear on the Settings page. */
export const OVERRIDABLE_KEYS = Object.keys(overridableSettings) as OverridableKey[];

export const SECRET_KEYS: OverridableKey[] = ["telegram_bot_token", "telegram_webhook_secret"];

export const SETTING_LABELS: Record<OverridableKey, string> = {
  crf: "Quality (CRF)",
  preset: "x265 preset",
  max_input_mb: "Largest accepted video (MB)",
  allowed_user_ids: "Allowed Telegram user IDs",
  inline_max_input_mb: "Inline conversion: largest file (MB)",
  inline_max_seconds: "Inline conversion: time budget (seconds)",
  inline_speed_factor: "Inline conversion: assumed speed (× realtime)",
  worker_max_attempts: "Attempts per job before giving up",
  job_retention_days: "Keep finished jobs for (days, 0 = forever)",
  telegram_bot_token: "Telegram bot token",
  telegram_webhook_secret: "Telegram webhook secret",
  telegram_api_url: "Telegram API base URL",
  telegram_local_mode: "Telegram local Bot API mode",
  telegram_delivery: "Who sends the result to Telegram",
  log_level: "Log level",
};

export interface RuntimeSettings {
  crf: number;
  preset: (typeof X265_PRESETS)[number];
  maxInputMb: number;
  allowedUserIds: number[];
  inlineMaxInputMb: number;
  inlineMaxSeconds: number;
  inlineSpeedFactor: number;
  workerMaxAttempts: number;
  jobRetentionDays: number;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  telegramApiUrl: string;
  telegramLocalMode: boolean;
  telegramDelivery: "server" | "worker" | "off";
  logLevel: (typeof LOG_LEVELS)[number];
}

export interface EnvSettings {
  nodeEnv: string;
  appUrl: string | null;
  appPassword: string | null;
  appSecret: string | null;
  workerSecret: string | null;
  storageDriver: string;
  storageDir: string;
  logLevel: string;
  databaseUrlSet: boolean;
  tmpDir: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegUrl: string | null;
  source: "env" | "default";
  isVercel: boolean;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function loadEnvSettings(): EnvSettings {
  const isVercel = Boolean(process.env.VERCEL);
  return {
    nodeEnv: env("NODE_ENV") || "development",
    appUrl: env("APP_URL") || (env("VERCEL_URL") ? `https://${env("VERCEL_URL")}` : null),
    appPassword: env("APP_PASSWORD") || null,
    appSecret: env("APP_SECRET") || null,
    workerSecret: env("WORKER_SECRET") || null,
    storageDriver: env("STORAGE_DRIVER") || (isVercel ? "blob" : "local"),
    storageDir: env("STORAGE_DIR") || (isVercel ? "/tmp/storage" : "./.data/storage"),
    logLevel: env("LOG_LEVEL") || "INFO",
    databaseUrlSet: Boolean(env("DATABASE_URL")),
    tmpDir: env("WORK_DIR") || (isVercel ? "/tmp" : "./.data/tmp"),
    ffmpegPath: env("FFMPEG_PATH") || env("FFMPEG_BIN") || null,
    ffprobePath: env("FFPROBE_PATH") || env("FFPROBE_BIN") || null,
    ffmpegUrl: env("FFMPEG_URL") || null,
    source: env("DATABASE_URL") ? "env" : "default",
    isVercel,
  };
}

/** Defaults used when neither the database nor the environment says anything. */
export function defaultSettings(envSettings: EnvSettings = loadEnvSettings()): RuntimeSettings {
  const telegramLocalMode = env("TELEGRAM_LOCAL_MODE").toLowerCase() === "true";
  const telegramApiUrl = env("TELEGRAM_API_URL") || DEFAULT_API_URL;
  const localServer = telegramApiUrl !== DEFAULT_API_URL || telegramLocalMode;
  const rawLogLevel = env("LOG_LEVEL").toUpperCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLogLevel)
    ? (rawLogLevel as RuntimeSettings["logLevel"])
    : (envSettings.logLevel.toUpperCase() as RuntimeSettings["logLevel"]);
  const telegramDelivery = env("TELEGRAM_DELIVERY");
  return {
    crf: 20,
    preset: "medium",
    maxInputMb: localServer ? MAX_UPLOAD_MB : CLOUD_DOWNLOAD_LIMIT_MB,
    allowedUserIds: parseUserIds(env("ALLOWED_USER_IDS")),
    inlineMaxInputMb: 25,
    inlineMaxSeconds: 50,
    inlineSpeedFactor: 0.4,
    workerMaxAttempts: 3,
    jobRetentionDays: 7,
    telegramBotToken: parseBotToken(env(DEFAULT_BOT_TOKEN_ENV)) || env(DEFAULT_BOT_TOKEN_ENV),
    telegramWebhookSecret: env("TELEGRAM_WEBHOOK_SECRET") || "",
    telegramApiUrl,
    telegramLocalMode,
    telegramDelivery:
      telegramDelivery === "worker" || telegramDelivery === "off" ? telegramDelivery : "server",
    logLevel: (LOG_LEVELS as readonly string[]).includes(logLevel) ? logLevel : "INFO",
  };
}

/** The same defaults with every environment influence removed — used to show value sources. */
export function builtinSettings(): RuntimeSettings {
  return {
    crf: 20,
    preset: "medium",
    maxInputMb: CLOUD_DOWNLOAD_LIMIT_MB,
    allowedUserIds: [],
    inlineMaxInputMb: 25,
    inlineMaxSeconds: 50,
    inlineSpeedFactor: 0.4,
    workerMaxAttempts: 3,
    jobRetentionDays: 7,
    telegramBotToken: "",
    telegramWebhookSecret: "",
    telegramApiUrl: DEFAULT_API_URL,
    telegramLocalMode: false,
    telegramDelivery: "server",
    logLevel: "INFO",
  };
}


export function parseUserIds(value: string): number[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id));
}

/** Environment variables that are not overridable, validated so misconfiguration is loud. */
export function validateEnvSettings(settings: EnvSettings): string[] {
  const problems: string[] = [];
  if (settings.appPassword && !settings.appSecret) {
    problems.push(
      "APP_SECRET must be set when APP_PASSWORD is used: it signs the login cookie. Use a long random string.",
    );
  }
  if (settings.appSecret && settings.appSecret.length < 16) {
    problems.push("APP_SECRET should be at least 16 characters long.");
  }
  if (settings.workerSecret && settings.workerSecret.length < 16) {
    problems.push("WORKER_SECRET should be at least 16 characters long.");
  }
  if (settings.storageDriver === "blob" && !process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    problems.push(
      "STORAGE_DRIVER=blob needs a Vercel Blob store: connect one to the project (BLOB_READ_WRITE_TOKEN) or set STORAGE_DRIVER=s3.",
    );
  }
  if (settings.storageDriver === "s3") {
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!env(key)) problems.push(`STORAGE_DRIVER=s3 needs ${key}.`);
    }
  }
  return problems;
}

export interface ResolvedSettings {
  values: RuntimeSettings;
  /** Which keys came from the database rather than the environment/defaults. */
  overridden: OverridableKey[];
  env: EnvSettings;
  envProblems: string[];
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••••${value.slice(-4)}`;
}

/** Coerce one raw string (from the database) into the typed setting. */
export function coerceOverride(key: OverridableKey, raw: string): string | number {
  const cleaned = key === "telegram_bot_token" ? parseBotToken(raw) ?? raw.trim() : raw;
  if (key === "telegram_bot_token" && !parseBotToken(cleaned)) {
    throw new Error("Invalid value for telegram_bot_token: that does not look like a Telegram bot token");
  }
  const schema = overridableSettings[key];
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid value for ${key}: ${result.error.issues[0]?.message ?? "not valid"}`);
  }
  return result.data as string | number;
}

export function buildResolvedSettings(
  envSettings: EnvSettings,
  overrides: Partial<Record<OverridableKey, string>>,
): ResolvedSettings {
  const values = defaultSettings(envSettings);
  const overridden: OverridableKey[] = [];

  for (const [key, raw] of Object.entries(overrides) as [OverridableKey, string][]) {
    if (raw === undefined || raw === null || raw === "") continue;
    try {
      const value = coerceOverride(key, raw);
      applyOverride(values, key, value);
      overridden.push(key);
    } catch {
      // A bad row (hand-edited database, older version) must not take the whole app down.
      continue;
    }
  }

  return { values, overridden, env: envSettings, envProblems: validateEnvSettings(envSettings) };
}

function applyOverride(values: RuntimeSettings, key: OverridableKey, value: string | number): void {
  switch (key) {
    case "crf":
      values.crf = Number(value);
      break;
    case "preset":
      values.preset = value as RuntimeSettings["preset"];
      break;
    case "max_input_mb":
      values.maxInputMb = Math.min(Number(value), MAX_UPLOAD_MB);
      break;
    case "allowed_user_ids":
      values.allowedUserIds = parseUserIds(String(value));
      break;
    case "inline_max_input_mb":
      values.inlineMaxInputMb = Number(value);
      break;
    case "inline_max_seconds":
      values.inlineMaxSeconds = Number(value);
      break;
    case "inline_speed_factor":
      values.inlineSpeedFactor = Number(value);
      break;
    case "worker_max_attempts":
      values.workerMaxAttempts = Number(value);
      break;
    case "job_retention_days":
      values.jobRetentionDays = Number(value);
      break;
    case "telegram_bot_token":
      values.telegramBotToken = parseBotToken(String(value)) || String(value);
      break;
    case "telegram_webhook_secret":
      values.telegramWebhookSecret = String(value);
      break;
    case "telegram_api_url":
      values.telegramApiUrl = String(value).replace(/\/+$/, "");
      break;
    case "telegram_local_mode":
      values.telegramLocalMode = String(value) === "true";
      break;
    case "telegram_delivery":
      values.telegramDelivery = value as RuntimeSettings["telegramDelivery"];
      break;
    case "log_level":
      values.logLevel = value as RuntimeSettings["logLevel"];
      break;
  }
}

export function serializeSettingsValues(values: RuntimeSettings): Record<OverridableKey, string> {
  return {
    crf: String(values.crf),
    preset: values.preset,
    max_input_mb: String(values.maxInputMb),
    allowed_user_ids: values.allowedUserIds.join(","),
    inline_max_input_mb: String(values.inlineMaxInputMb),
    inline_max_seconds: String(values.inlineMaxSeconds),
    inline_speed_factor: String(values.inlineSpeedFactor),
    worker_max_attempts: String(values.workerMaxAttempts),
    job_retention_days: String(values.jobRetentionDays),
    telegram_bot_token: values.telegramBotToken,
    telegram_webhook_secret: values.telegramWebhookSecret,
    telegram_api_url: values.telegramApiUrl,
    telegram_local_mode: values.telegramLocalMode ? "true" : "false",
    telegram_delivery: values.telegramDelivery,
    log_level: values.logLevel,
  };
}

/** True when the value is still what the environment/defaults say (used to hide "clear"). */
export function isDefault(values: RuntimeSettings, key: OverridableKey, envSettings: EnvSettings): boolean {
  const defaults = serializeSettingsValues(defaultSettings(envSettings));
  return defaults[key] === serializeSettingsValues(values)[key];
}
