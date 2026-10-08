/**
 * Finishing work after the response has been sent.
 *
 * On Vercel `waitUntil` keeps the function alive until the promise settles (up to the
 * configured `maxDuration`), which is how a webhook can answer Telegram immediately and
 * still convert a video. Locally (and in `next start`) there is no such helper, so the
 * promise simply runs on — the process is long-lived there.
 */

import { log } from "@/lib/log";

const pending = new Set<Promise<unknown>>();

export function background<T>(work: Promise<T> | (() => Promise<T>), label: string): void {
  const promise = (typeof work === "function" ? work() : work).catch((error) => {
    log.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  pending.add(promise);
  void promise.finally(() => pending.delete(promise));

  void keepAlive(promise);
}

async function keepAlive(promise: Promise<unknown>): Promise<void> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(promise);
  } catch {
    // Not on Vercel, or outside a request context (CLI, tests): the promise simply runs on.
  }
}

/** Await everything that was started with `background()` — used by tests. */
export async function settleBackgroundWork(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
