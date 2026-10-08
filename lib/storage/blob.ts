/**
 * Vercel Blob.
 *
 * Uploads and downloads are presigned with `issueSignedToken` + `presignUrl`, which means the
 * browser uploads straight to the CDN with a short-lived URL and no read-write token ever
 * reaches the client. On Vercel the SDK authenticates with the project's OIDC token; locally
 * (or in a worker) set `BLOB_READ_WRITE_TOKEN`.
 */

import {
  del,
  get,
  head,
  issueSignedToken,
  presignUrl,
  put,
  type BlobAccessType,
  type IssuedSignedToken,
} from "@vercel/blob";

import { StorageError, type ObjectBody, type ObjectHead, type Storage, type UploadTarget } from "./types";

const MAX_DELEGATION_SECONDS = 7 * 24 * 60 * 60;

interface CachedToken {
  token: IssuedSignedToken;
  pathname: string;
}

export class BlobStorage implements Storage {
  readonly driver = "blob" as const;
  readonly label: string;
  readonly #access: BlobAccessType;
  readonly #tokens = new Map<string, CachedToken>();

  constructor(options?: { access?: BlobAccessType }) {
    this.#access = options?.access ?? ((process.env.BLOB_ACCESS as BlobAccessType) || "public");
    if (this.#access !== "public" && this.#access !== "private") {
      throw new StorageError("BLOB_ACCESS must be 'public' or 'private'");
    }
    this.label = `Vercel Blob · ${this.#access}`;
  }

  static configured(): boolean {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || process.env.VERCEL_OIDC_TOKEN);
  }

  async #token(key: string, operations: ("get" | "put" | "delete")[], maxBytes?: number, contentType?: string) {
    const cacheKey = `${key}:${operations.join("+")}:${maxBytes ?? ""}:${contentType ?? ""}`;
    const cached = this.#tokens.get(cacheKey);
    if (cached && cached.token.validUntil - Date.now() > 60_000) return cached.token;

    const token = await issueSignedToken({
      pathname: key,
      operations,
      validUntil: Date.now() + MAX_DELEGATION_SECONDS * 1000,
      maximumSizeInBytes: maxBytes,
      allowedContentTypes: contentType ? [contentType] : undefined,
    });
    this.#tokens.set(cacheKey, { token, pathname: key });
    return token;
  }

  async createUploadTarget(options: {
    key: string;
    contentType?: string;
    maxBytes?: number;
    expiresInSeconds?: number;
  }): Promise<UploadTarget> {
    const expiresInSeconds = options.expiresInSeconds ?? 3600;
    const token = await this.#token(options.key, ["put"], options.maxBytes, options.contentType);
    const { presignedUrl } = await presignUrl(token, {
      operation: "put",
      pathname: options.key,
      access: this.#access,
      validUntil: Math.min(Date.now() + expiresInSeconds * 1000, token.validUntil),
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    const headers: Record<string, string> = {};
    if (options.contentType) headers["content-type"] = options.contentType;
    return {
      url: presignedUrl,
      method: "PUT",
      headers,
      key: options.key,
      driver: "blob",
      expiresInSeconds,
      maxBytes: options.maxBytes,
    };
  }

  async createDownloadUrl(
    key: string,
    options?: { expiresInSeconds?: number; downloadName?: string },
  ): Promise<string> {
    const expiresInSeconds = options?.expiresInSeconds ?? 3600;
    const token = await this.#token(key, ["get"]);
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname: key,
      access: this.#access,
      validUntil: Math.min(Date.now() + expiresInSeconds * 1000, token.validUntil),
    });
    return presignedUrl;
  }

  async getObject(key: string): Promise<ObjectBody | null> {
    const result = await get(key, { access: this.#access });
    if (!result || !("stream" in result) || !result.stream) return null;
    return {
      body: result.stream as ReadableStream<Uint8Array>,
      size: result.blob?.size ?? undefined,
      contentType: result.blob?.contentType ?? undefined,
    };
  }

  async putObject(key: string, body: Uint8Array, contentType?: string): Promise<ObjectHead> {
    const result = await put(key, Buffer.from(body), {
      access: this.#access,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { size: body.byteLength, contentType: result.contentType ?? contentType ?? null };
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const result = await head(key);
      return { size: result.size, contentType: result.contentType };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await del(key);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const key = `_healthcheck/${Date.now()}.txt`;
    const payload = new TextEncoder().encode("video-convertor storage check");
    try {
      await this.putObject(key, payload, "text/plain");
      const object = await this.getObject(key);
      const text = object?.body ? await new Response(object.body).text() : "";
      await this.deleteObject(key);
      if (text !== "video-convertor storage check") {
        return { ok: false, detail: "wrote a test blob but read different content back" };
      }
      return { ok: true, detail: `blob store reachable (${this.#access} access)` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "BlobNotFoundError" || name === "BlobStoreNotFoundError";
}
