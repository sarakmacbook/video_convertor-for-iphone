/**
 * The local storage driver's endpoint: `/api/storage/local/<key>?token=…`
 *
 * It behaves like a presigned S3 URL, so the same client code works for every driver. It is
 * only reachable with a valid signature, and it exists for development, Docker and
 * self-hosting — on Vercel the filesystem is ephemeral, use Blob or S3 there.
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { fail, handleRouteError, json } from "@/lib/http";
import { LocalStorage, objectPath, safeKey, storageRoot, verifyLocalToken } from "@/lib/storage/local";
import { storageDriverName } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

function keyFrom(context: { key: string[] }): string {
  return safeKey(context.key.map((part) => decodeURIComponent(part)).join("/"));
}

function requireLocalDriver(): Response | null {
  if (storageDriverName() !== "local") {
    return fail("this deployment does not use local storage", 404);
  }
  return null;
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const wrongDriver = requireLocalDriver();
    if (wrongDriver) return wrongDriver;

    const { key: parts } = await context.params;
    const key = keyFrom({ key: parts });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const payload = verifyLocalToken(token, "put");
    if (!payload || payload.key !== key) return fail("this upload link is invalid or has expired", 403);

    const declared = Number(request.headers.get("content-length") ?? 0);
    const maxBytes = payload.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (declared > maxBytes) return fail(`this file is over the limit of ${maxBytes} bytes`, 413);
    if (!request.body) return fail("the request has no body", 400);

    const target = objectPath(storageRoot(), key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target));
    const info = await stat(target);
    if (info.size > maxBytes) {
      const { rm } = await import("node:fs/promises");
      await rm(target, { force: true });
      return fail(`this file is over the limit of ${maxBytes} bytes`, 413);
    }

    return json({ ok: true, key, bytes: info.size });
  } catch (error) {
    return handleRouteError(error, "PUT /api/storage/local");
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const wrongDriver = requireLocalDriver();
    if (wrongDriver) return wrongDriver;

    const { key: parts } = await context.params;
    const key = keyFrom({ key: parts });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const payload = verifyLocalToken(token, "get");
    if (!payload || payload.key !== key) return fail("this download link is invalid or has expired", 403);

    const storage = new LocalStorage({ baseUrl: "" });
    const object = await storage.getObject(key);
    if (!object?.body) return fail("no such file", 404);

    const headers = new Headers({
      "content-type": object.contentType ?? guessType(key),
      "cache-control": "private, max-age=60",
    });
    if (object.size) headers.set("content-length", String(object.size));
    if (payload.name) {
      headers.set("content-disposition", `attachment; filename="${payload.name.replace(/"/g, "")}"`);
    }
    return new Response(object.body, { headers });
  } catch (error) {
    return handleRouteError(error, "GET /api/storage/local");
  }
}

export async function HEAD(request: Request, context: RouteContext) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}

function guessType(key: string): string {
  const extension = key.toLowerCase().split(".").pop() ?? "";
  switch (extension) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}
