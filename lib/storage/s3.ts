/**
 * Any S3-compatible object store: AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage,
 * MinIO, DigitalOcean Spaces… Configure with S3_* environment variables.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { StorageError, type ObjectBody, type ObjectHead, type Storage, type UploadTarget } from "./types";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

export function s3ConfigFromEnv(): S3Config {
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new StorageError(
      "S3 storage needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (plus S3_REGION and, for R2/MinIO, S3_ENDPOINT).",
    );
  }
  return {
    bucket,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: ["1", "true", "yes"].includes((process.env.S3_FORCE_PATH_STYLE ?? "").toLowerCase()),
    prefix: process.env.S3_PREFIX?.trim() || undefined,
  };
}

export class S3Storage implements Storage {
  readonly driver = "s3" as const;
  readonly label: string;
  readonly #config: S3Config;
  readonly #client: S3Client;

  constructor(config: S3Config) {
    this.#config = config;
    this.#client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    this.label = `S3-compatible · ${config.bucket}${config.endpoint ? ` @ ${config.endpoint}` : ""}`;
  }

  #key(key: string): string {
    return this.#config.prefix ? `${this.#config.prefix.replace(/\/+$/, "")}/${key}` : key;
  }

  async createUploadTarget(options: {
    key: string;
    contentType?: string;
    maxBytes?: number;
    expiresInSeconds?: number;
  }): Promise<UploadTarget> {
    const expiresInSeconds = options.expiresInSeconds ?? 3600;
    const headers: Record<string, string> = {};
    if (options.contentType) headers["content-type"] = options.contentType;
    const url = await getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#config.bucket,
        Key: this.#key(options.key),
        ContentType: options.contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
    return {
      url,
      method: "PUT",
      headers,
      key: options.key,
      driver: "s3",
      expiresInSeconds,
      maxBytes: options.maxBytes,
    };
  }

  async createDownloadUrl(key: string, options?: { expiresInSeconds?: number; downloadName?: string }): Promise<string> {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#config.bucket,
        Key: this.#key(key),
        ResponseContentDisposition: options?.downloadName
          ? `attachment; filename="${options.downloadName.replace(/"/g, "")}"`
          : undefined,
      }),
      { expiresIn: options?.expiresInSeconds ?? 3600 },
    );
  }

  async getObject(key: string): Promise<ObjectBody | null> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#config.bucket, Key: this.#key(key) }),
      );
      return {
        body: (result.Body as ReadableStream<Uint8Array> | undefined) ?? null,
        size: result.ContentLength,
        contentType: result.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putObject(key: string, body: Uint8Array, contentType?: string): Promise<ObjectHead> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#config.bucket,
        Key: this.#key(key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
    return { size: body.byteLength, contentType: contentType ?? null };
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: this.#key(key) }),
      );
      return { size: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#config.bucket, Key: this.#key(key) }));
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const key = `_healthcheck/${Date.now()}.txt`;
    const payload = new TextEncoder().encode("video-convertor storage check");
    try {
      await this.putObject(key, payload, "text/plain");
      const head = await this.headObject(key);
      const read = await this.getObject(key);
      const text = read?.body ? await new Response(read.body).text() : "";
      await this.deleteObject(key);
      if (text !== "video-convertor storage check") {
        return { ok: false, detail: "wrote a test object but read different content back" };
      }
      return { ok: true, detail: `s3://${this.#config.bucket} (${head?.size ?? 0} bytes written and read)` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
