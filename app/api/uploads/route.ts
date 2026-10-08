/**
 * Uploads.
 *
 * A browser cannot post a 200 MB video to a Vercel function (request bodies are capped at
 * 4.5 MB), so the client asks for a signed target here and PUTs the file straight to storage.
 * The returned `returnToken` proves to `POST /api/jobs` that we handed out that key.
 */

import { baseUrl, fail, handleRouteError, isAuthorized, json, readJson, unauthorized } from "@/lib/http";
import { getSettings } from "@/lib/settings";
import { MB } from "@/lib/settings/schema";
import { getStorage, inputKey, sanitizeName } from "@/lib/storage";
import { randomToken, signPayload } from "@/lib/storage/signing";
import { cleanFileName, UPLOAD_TTL_SECONDS } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UploadRequest {
  fileName?: string;
  contentType?: string;
  bytes?: number;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) return unauthorized();
    const body = await readJson<UploadRequest>(request);
    const fileName = cleanFileName(body.fileName);
    const contentType = (body.contentType ?? "video/quicktime").slice(0, 100);
    const bytes = Number(body.bytes ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return fail("bytes must be a positive number");

    const { values: settings } = await getSettings();
    const maxBytes = settings.maxInputMb * MB;
    if (bytes > maxBytes) {
      return fail(
        `this file is ${(bytes / MB).toFixed(1)} MB, over this deployment's limit of ${settings.maxInputMb} MB (change it on the Settings page)`,
        413,
      );
    }

    const uploadId = randomToken(10);
    const key = inputKey(`u_${uploadId}`, sanitizeName(fileName));
    const storage = getStorage({ baseUrl: baseUrl(request) });
    const upload = await storage.createUploadTarget({
      key,
      contentType,
      maxBytes,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    });

    return json({
      ok: true,
      uploadId,
      key,
      fileName,
      contentType,
      maxBytes,
      driver: storage.driver,
      upload,
      returnToken: signPayload({
        key,
        op: "put",
        exp: Date.now() + UPLOAD_TTL_SECONDS * 1000,
        maxBytes,
        contentType,
        name: fileName,
      }),
      limits: { maxInputMb: settings.maxInputMb },
    });
  } catch (error) {
    return handleRouteError(error, "POST /api/uploads");
  }
}
