/**
 * Picking a storage driver from the environment, and the key layout jobs use.
 */

import { BlobStorage } from "./blob";
import { LocalStorage } from "./local";
import { S3Storage, s3ConfigFromEnv } from "./s3";
import { StorageError, type Storage, type StorageDriverName } from "./types";

export * from "./types";
export { signPayload, verifyPayload, usingEphemeralSecret } from "./signing";

export function storageDriverName(): StorageDriverName {
  const raw = (process.env.STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (raw === "blob" || raw === "s3" || raw === "local") return raw;
  if (!raw) return process.env.VERCEL ? "blob" : "local";
  throw new StorageError(`STORAGE_DRIVER must be blob, s3 or local (got "${raw}")`);
}

export interface StorageOptions {
  /** Absolute base URL of this deployment, needed by the local driver to hand back links. */
  baseUrl: string;
  driver?: StorageDriverName;
}

export function getStorage(options: StorageOptions): Storage {
  const driver = options.driver ?? storageDriverName();
  switch (driver) {
    case "blob":
      return new BlobStorage();
    case "s3":
      return new S3Storage(s3ConfigFromEnv());
    case "local":
      return new LocalStorage({ baseUrl: options.baseUrl });
    default:
      throw new StorageError(`unknown storage driver: ${driver}`);
  }
}

/**
 * Object keys. The job id keeps everything for one conversion together, which makes the
 * "delete this job" button able to remove input and output in one go.
 */
export function inputKey(jobId: string, fileName: string): string {
  return `jobs/${jobId}/input/${sanitizeName(fileName)}`;
}

export function outputKey(jobId: string, fileName: string): string {
  return `jobs/${jobId}/output/${sanitizeName(fileName)}`;
}

export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 120);
  return cleaned || "video.mp4";
}

/** `IMG_1234.MOV` → `IMG_1234_small.mp4`, mirroring the Telegram bot's naming. */
export function convertedName(inputName: string | null | undefined): string {
  const base = sanitizeName(inputName ?? "video.mp4");
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "video";
  return `${stem}_small.mp4`;
}
