/**
 * The storage contract.
 *
 * Uploads never pass through a serverless function: the browser asks the API for a target and
 * then PUTs the bytes straight to storage with a short-lived signature. That is what makes a
 * 200 MB iPhone clip possible on Vercel, where a request body is capped at 4.5 MB.
 */

export type StorageDriverName = "blob" | "s3" | "local";

export interface UploadTarget {
  /** Everything the client needs: fetch(url, { method, headers, body }). */
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  key: string;
  driver: StorageDriverName;
  expiresInSeconds: number;
  maxBytes?: number;
}

export interface ObjectHead {
  size: number;
  contentType?: string | null;
}

export interface ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  size?: number;
  contentType?: string | null;
}

export interface Storage {
  driver: StorageDriverName;
  /** Short description for the settings page, e.g. "Vercel Blob · private". */
  label: string;

  createUploadTarget(options: {
    key: string;
    contentType?: string;
    maxBytes?: number;
    expiresInSeconds?: number;
  }): Promise<UploadTarget>;

  /** A URL the browser (or a worker) can GET. May be presigned or point back at this app. */
  createDownloadUrl(key: string, options?: { expiresInSeconds?: number; downloadName?: string }): Promise<string>;

  /** Server-side read (inline conversion, Telegram delivery, worker downloads via our own proxy). */
  getObject(key: string): Promise<ObjectBody | null>;

  /** Server-side write. Used for converted files produced inside a function. */
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<ObjectHead>;

  headObject(key: string): Promise<ObjectHead | null>;

  deleteObject(key: string): Promise<void>;

  /** Write, read back, compare, delete. Powers the "Test storage" button. */
  test(): Promise<{ ok: boolean; detail: string }>;
}

export class StorageError extends Error {}
