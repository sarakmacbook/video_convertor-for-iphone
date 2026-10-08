/**
 * A tiny logger. Next.js already prints console output in the deployment logs, so this only
 * adds a level filter and a consistent prefix.
 */

import { LOG_LEVELS } from "@/lib/settings/schema";

type Level = (typeof LOG_LEVELS)[number];

const RANK: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

let threshold: Level = (process.env.LOG_LEVEL?.toUpperCase() as Level) || "INFO";

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase() as Level;
  if (LOG_LEVELS.includes(upper)) threshold = upper;
}

function write(level: Level, message: string, meta?: unknown): void {
  if (RANK[level] < RANK[threshold]) return;
  const line = `${new Date().toISOString()} ${level} video-convertor: ${message}`;
  if (level === "ERROR") console.error(line, meta ?? "");
  else if (level === "WARNING") console.warn(line, meta ?? "");
  else console.log(line, meta ?? "");
}

export const log = {
  debug: (message: string, meta?: unknown) => write("DEBUG", message, meta),
  info: (message: string, meta?: unknown) => write("INFO", message, meta),
  warn: (message: string, meta?: unknown) => write("WARNING", message, meta),
  error: (message: string, meta?: unknown) => write("ERROR", message, meta),
};
