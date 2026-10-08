/**
 * Helpers shared by the upload endpoint and the job-creation endpoint.
 *
 * The flow is: `POST /api/uploads` → the browser PUTs to storage → `POST /api/jobs` with the
 * `returnToken` from the first call, which proves the key was issued by us and carries the
 * original file name and the size we allowed.
 */

import { sanitizeName } from "@/lib/storage";
import { verifyPayload } from "@/lib/storage/signing";

export const UPLOAD_TTL_SECONDS = 60 * 60 * 6;

export interface UploadToken {
  key: string;
  name?: string;
  maxBytes?: number;
  contentType?: string;
}

export function verifyUploadToken(token: string | undefined | null): UploadToken | null {
  if (!token) return null;
  const payload = verifyPayload(token);
  if (!payload || payload.op !== "put") return null;
  return { key: payload.key, name: payload.name, maxBytes: payload.maxBytes, contentType: payload.contentType };
}

export function cleanFileName(name: string | undefined | null): string {
  return sanitizeName((name ?? "video.mov").split("/").pop() ?? "video.mov");
}
