"use client";

/**
 * The main page: drop a video, watch it upload, watch it convert, download the smaller file.
 *
 * Two upload strategies, chosen by the server:
 *   - `blob` / `s3`: the file goes straight from the browser to storage with a signed URL
 *     (nothing is capped by Vercel's 4.5 MB request body limit);
 *   - `local`: the file goes to this app's own `/api/storage/local/...` endpoint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatBytes, formatDuration, formatPercent, STAGE_LABELS, STATUS_LABELS, statusTone } from "@/lib/format";

interface UploadTarget {
  url: string;
  method: string;
  headers: Record<string, string>;
  key: string;
  driver: string;
}

interface JobView {
  id: string;
  status: string;
  stage: string;
  progress: number;
  message: string | null;
  error: string | null;
  source: string;
  createdAt: string;
  input: { name: string | null; bytes: number; duration: number | null; width: number | null; height: number | null };
  output: { bytes: number | null; usedOriginal: boolean | null; savedPercent: number | null; width: number | null; height: number | null; codec: string | null };
  telegram: { chatId: number | null; status: string; error: string | null };
}

interface JobDetail {
  job: JobView;
  download: { url: string; name: string; bytes: number; kind: string } | null;
  events: { at: string; level: string; message: string }[];
  settings: { inlineMaxInputMb: number; inlineMaxSeconds: number; telegramConfigured: boolean };
}

type Phase = "idle" | "uploading" | "working" | "done" | "failed";

interface MediaInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
}

/** Read duration and geometry in the browser, so the server can decide where to convert. */
async function readMediaInfo(file: File): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (info: MediaInfo) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(info);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      finish({
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    video.onerror = () => finish({ duration: null, width: null, height: null });
    setTimeout(() => finish({ duration: null, width: null, height: null }), 5000);
    video.src = url;
  });
}

function uploadWithProgress(
  target: UploadTarget,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(target.method || "PUT", target.url, true);
    for (const [header, value] of Object.entries(target.headers ?? {})) {
      try {
        request.setRequestHeader(header, value);
      } catch {
        // A header the browser refuses to set (e.g. content-type on a FormData) is not fatal.
      }
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve({ url: target.url });
      else
        reject(
          new Error(
            `the upload failed with HTTP ${request.status}${request.responseText ? `: ${request.responseText.slice(0, 200)}` : ""}`,
          ),
        );
    };
    request.onerror = () => reject(new Error("the upload failed: the browser could not reach storage"));
    request.onabort = () => reject(new Error("the upload was canceled"));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

export function Converter({ signedIn }: { signedIn: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadFraction, setUploadFraction] = useState(0);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const job = detail?.job ?? null;

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollJob = useCallback(
    (id: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
          if (!response.ok) return;
          const body = (await response.json()) as JobDetail;
          setDetail(body);
          if (body.job.status === "done") {
            setPhase("done");
            stopPolling();
          } else if (body.job.status === "failed" || body.job.status === "canceled") {
            setPhase("failed");
            setError(body.job.error ?? body.job.message ?? "the conversion did not finish");
            stopPolling();
          }
        } catch {
          // A dropped request is not a failed conversion; the next tick tries again.
        }
      };
      void tick();
      pollRef.current = window.setInterval(tick, 1500);
    },
    [stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(
    async (selected: File, options: { forceInline?: boolean } = {}) => {
      setError(null);
      setNotice(null);
      setDetail(null);
      setUploadFraction(0);
      setPhase("uploading");

      try {
        const media = await readMediaInfo(selected);

        const targetResponse = await fetch("/api/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fileName: selected.name,
            contentType: selected.type || "video/quicktime",
            bytes: selected.size,
          }),
        });
        const target = (await targetResponse.json()) as {
          ok: boolean;
          error?: string;
          upload?: UploadTarget;
          returnToken?: string;
          limits?: { maxInputMb: number };
        };
        if (!targetResponse.ok || !target.upload) {
          throw new Error(target.error ?? "the server would not accept this file");
        }

        await uploadWithProgress(target.upload, selected, setUploadFraction);
        setPhase("working");

        const jobResponse = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            returnToken: target.returnToken,
            bytes: selected.size,
            duration: media.duration,
            width: media.width,
            height: media.height,
            forceInline: options.forceInline,
          }),
        });
        const created = (await jobResponse.json()) as {
          ok: boolean;
          error?: string;
          job?: JobView;
          inline?: boolean;
          reason?: string;
          hint?: string;
        };
        if (!jobResponse.ok || !created.job) throw new Error(created.error ?? "the job could not be created");

        setDetail({ job: created.job, download: null, events: [], settings: { inlineMaxInputMb: 0, inlineMaxSeconds: 0, telegramConfigured: false } });
        if (created.inline === false) {
          setNotice(
            `Queued for a worker: ${created.reason ?? "it does not fit in a serverless function"}.${created.hint ? ` ${created.hint}` : ""}`,
          );
          pollJob(created.job.id);
        } else {
          pollJob(created.job.id);
        }
      } catch (caught) {
        setPhase("failed");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [pollJob],
  );

  const onPick = useCallback(
    (chosen: File | null | undefined) => {
      if (!chosen) return;
      setFile(chosen);
      void start(chosen);
    },
    [start],
  );

  const reset = useCallback(() => {
    stopPolling();
    setFile(null);
    setDetail(null);
    setPhase("idle");
    setError(null);
    setNotice(null);
    setUploadFraction(0);
  }, [stopPolling]);

  const act = useCallback(
    async (action: "cancel" | "retry" | "convert-here" | "deliver") => {
      if (!job) return;
      setError(null);
      const response = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? `could not ${action} this job`);
        return;
      }
      if (action === "convert-here") setNotice("Converting in this deployment — keep the tab open.");
      setPhase("working");
      pollJob(job.id);
    },
    [job, pollJob],
  );

  const progress = job?.progress ?? 0;
  const stageLabel = job ? (STAGE_LABELS[job.stage] ?? job.stage) : "";
  const isQueued = job?.status === "queued";
  const savedPercent = job?.output.savedPercent ?? null;
  const sourceBytes = job?.input.bytes ?? file?.size ?? 0;
  const outputBytes = job?.output.bytes ?? 0;

  const headline = useMemo(() => {
    if (phase === "uploading") return `Uploading ${Math.round(uploadFraction * 100)}%`;
    if (!job) return "Ready";
    if (job.status === "queued") return "Waiting for a converter";
    if (job.status === "running") return `${stageLabel}…`;
    if (job.status === "done") return job.output.usedOriginal ? "Original sent back" : "Converted";
    if (job.status === "failed") return "Could not convert this video";
    return STATUS_LABELS[job.status] ?? job.status;
  }, [job, phase, uploadFraction, stageLabel]);

  return (
    <div>
      {(error || notice) && (
        <div className={`banner ${error ? "bad" : "warn"}`}>{error ?? notice}</div>
      )}

      {!signedIn ? (
        <div className="card">
          <h2>Sign in first</h2>
          <p className="dim">
            This deployment is protected. Open the <a href="/settings">settings page</a> to sign in.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <div
              className="drop"
              data-over={dragOver}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                onPick(event.dataTransfer.files?.[0]);
              }}
            >
              <div className="big">
                {file ? file.name : "Drop an iPhone video here, or click to choose one"}
              </div>
              <div className="dim">
                {file ? formatBytes(file.size) : "MOV, MP4, M4V, MKV, WEBM — the original file, straight from the Files app"}
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mov,.mp4,.m4v,.mkv,.webm,.avi,.3gp"
                style={{ display: "none" }}
                onChange={(event) => onPick(event.target.files?.[0])}
              />
            </div>

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => inputRef.current?.click()} disabled={phase === "uploading"}>
                Choose a video
              </button>
              {phase !== "idle" && (
                <button className="btn ghost" onClick={reset}>
                  Start over
                </button>
              )}
              {phase === "working" && job?.status === "running" && (
                <button className="btn ghost" onClick={() => act("cancel")}>
                  Cancel conversion
                </button>
              )}
              {isQueued && (
                <button className="btn small" onClick={() => act("convert-here")} title="Convert inside this deployment instead of waiting for a worker">
                  Convert here anyway
                </button>
              )}
            </div>
          </div>

          {phase !== "idle" && (
            <div className="card">
              <div className="card-title">
                <h2>{headline}</h2>
                <div className="spacer" />
                {job && (
                  <span className={`pill ${statusTone(job.status)}`}>
                    <span className="dot" />
                    {STATUS_LABELS[job.status] ?? job.status}
                  </span>
                )}
              </div>

              <div className="progress" style={{ marginBottom: 10 }}>
                <span
                  style={{
                    width: `${Math.round((phase === "uploading" ? uploadFraction * 0.5 : 0.5 + progress * 0.5) * 100)}%`,
                  }}
                />
              </div>
              <div className="dim" style={{ fontSize: "0.85rem" }}>
                {phase === "uploading"
                  ? `${formatBytes(Math.round(sourceBytes * uploadFraction))} of ${formatBytes(sourceBytes)} uploaded`
                  : (job?.message ?? "starting")}
              </div>

              {job && (
                <dl className="kv" style={{ marginTop: 14 }}>
                  {job.input.duration ? (
                    <>
                      <dt>Original</dt>
                      <dd>
                        {formatBytes(sourceBytes)} · {formatDuration(job.input.duration)}
                        {job.input.width && job.input.height
                          ? ` · ${job.input.width}×${job.input.height}`
                          : ""}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Original</dt>
                      <dd>{formatBytes(sourceBytes)}</dd>
                    </>
                  )}
                  {job.output.bytes !== null && (
                    <>
                      <dt>Result</dt>
                      <dd>
                        {formatBytes(outputBytes)}{" "}
                        {savedPercent !== null && !job.output.usedOriginal ? (
                          <span className="save-positive">({formatPercent(savedPercent)} smaller)</span>
                        ) : null}
                        {job.output.usedOriginal ? <span className="dim"> — your original, kept as is</span> : null}
                      </dd>
                    </>
                  )}
                  {job.telegram.chatId ? (
                    <>
                      <dt>Telegram</dt>
                      <dd>
                        {job.telegram.status === "sent"
                          ? "sent back to the chat"
                          : job.telegram.status === "failed"
                            ? (job.telegram.error ?? "delivery failed")
                            : "waiting to be sent"}
                      </dd>
                    </>
                  ) : null}
                </dl>
              )}

              {phase === "done" && detail?.download && (
                <div className="btn-row" style={{ marginTop: 16 }}>
                  <a className="btn primary" href={detail.download.url} download={detail.download.name}>
                    Download {detail.download.name}
                  </a>
                  <a className="btn" href={`/jobs/${job?.id}`}>
                    Open in history
                  </a>
                  {job?.telegram.status === "failed" && detail.settings.telegramConfigured && (
                    <button className="btn small" onClick={() => act("deliver")}>
                      Send to Telegram again
                    </button>
                  )}
                </div>
              )}

              {phase === "failed" && job && (
                <div className="btn-row" style={{ marginTop: 16 }}>
                  <button className="btn" onClick={() => act("retry")}>
                    Try again
                  </button>
                  <a className="btn ghost" href={`/jobs/${job.id}`}>
                    See what happened
                  </a>
                </div>
              )}
            </div>
          )}

          <div className="card tight">
            <h3>How this works</h3>
            <p className="dim" style={{ marginBottom: 0 }}>
              The video is re-encoded to HEVC (H.265) at a visually lossless setting: the same resolution,
              frame rate, HDR colour, sound and capture metadata, in a much smaller file. Short clips are
              converted on the spot; longer ones are queued for a worker (see the README) so nothing times out.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
