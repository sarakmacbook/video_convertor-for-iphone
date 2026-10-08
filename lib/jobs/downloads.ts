/**
 * Download links for a finished job.
 *
 * The browser and the Telegram delivery both need the bytes. For Vercel Blob and S3 a signed
 * URL goes straight to storage (so the file does not travel through a serverless function,
 * which would be slow and capped). The local driver serves the object from our own route with
 * the same kind of signature.
 */

import type { Storage } from "@/lib/storage";
import { convertedName } from "@/lib/storage";
import type { Job } from "./service";

export interface DownloadLink {
  url: string;
  name: string;
  bytes: number;
  kind: "converted" | "original";
  expiresInSeconds: number;
}

export function deliveryKey(job: Job): { key: string; name: string; bytes: number; kind: "converted" | "original" } | null {
  if (job.status !== "done") return null;
  const usedOriginal = job.used_original === 1 || !job.output_key;
  if (usedOriginal) {
    return {
      key: job.input_key,
      name: job.input_name ?? "original.mov",
      bytes: job.input_bytes,
      kind: "original",
    };
  }
  return {
    key: job.output_key!,
    name: job.output_name ?? convertedName(job.input_name),
    bytes: job.output_bytes ?? 0,
    kind: "converted",
  };
}

export async function createDownloadLink(
  job: Job,
  storage: Storage,
  options: { expiresInSeconds?: number } = {},
): Promise<DownloadLink | null> {
  const target = deliveryKey(job);
  if (!target) return null;
  const expiresInSeconds = options.expiresInSeconds ?? 900;
  const url = await storage.createDownloadUrl(target.key, {
    expiresInSeconds,
    downloadName: target.name,
  });
  return { url, name: target.name, bytes: target.bytes, kind: target.kind, expiresInSeconds };
}
