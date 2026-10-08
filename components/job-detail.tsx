"use client";

/** One job in full: progress, the numbers, the activity log, and the buttons that act on it. */

import { useCallback, useEffect, useState } from "react";

import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatTime,
  STAGE_LABELS,
  STATUS_LABELS,
  statusTone,
} from "@/lib/format";

interface JobDetailResponse {
  job: {
    id: string;
    status: string;
    stage: string;
    progress: number;
    message: string | null;
    error: string | null;
    source: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    attempts: number;
    input: {
      key: string;
      name: string | null;
      bytes: number;
      duration: number | null;
      width: number | null;
      height: number | null;
      codec: string | null;
      isHdr: boolean | null;
    };
    output: {
      key: string | null;
      name: string | null;
      bytes: number | null;
      width: number | null;
      height: number | null;
      codec: string | null;
      usedOriginal: boolean | null;
      savedPercent: number | null;
    };
    telegram: { chatId: number | null; messageId: number | null; status: string; error: string | null };
    worker: string | null;
    ffmpegVersion: string | null;
  };
  download: { url: string; name: string; bytes: number; kind: string; expiresInSeconds: number } | null;
  events: { id: string; at: string; level: string; message: string }[];
  settings: { inlineMaxInputMb: number; inlineMaxSeconds: number; telegramConfigured: boolean; telegramDelivery: string };
}

export function JobDetail({ id }: { id: string }) {
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      const body = (await response.json()) as JobDetailResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "this job could not be loaded");
      setData(body);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (action: string) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/jobs/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await response.json()) as { ok: boolean; error?: string };
        if (!body.ok) setError(body.error ?? `could not ${action}`);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [id, load],
  );

  if (error && !data) return <div className="banner bad">{error}</div>;
  if (!data) return <p className="dim">Loading…</p>;

  const { job, download, events } = data;
  const active = job.status === "queued" || job.status === "running";

  return (
    <div>
      {error && <div className="banner bad">{error}</div>}

      <div className="card">
        <div className="card-title">
          <h2>{job.input.name ?? job.id}</h2>
          <div className="spacer" />
          <span className={`pill ${statusTone(job.status)}`}>
            <span className="dot" />
            {STATUS_LABELS[job.status] ?? job.status}
          </span>
          <span className="pill">{job.source}</span>
        </div>

        {active && (
          <>
            <div className="progress" style={{ marginBottom: 8 }}>
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <p className="dim" style={{ marginBottom: 0 }}>
              {STAGE_LABELS[job.stage] ?? job.stage}
              {job.message ? ` — ${job.message}` : ""} ({Math.round(job.progress * 100)}%)
            </p>
          </>
        )}

        {job.error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{job.error}</div>}

        <div className="grid two" style={{ marginTop: 16 }}>
          <div>
            <h3>Original</h3>
            <dl className="kv">
              <dt>Size</dt>
              <dd>{formatBytes(job.input.bytes)}</dd>
              <dt>Duration</dt>
              <dd>{formatDuration(job.input.duration)}</dd>
              <dt>Geometry</dt>
              <dd>{job.input.width && job.input.height ? `${job.input.width}×${job.input.height}` : "—"}</dd>
              <dt>Codec</dt>
              <dd>
                {job.input.codec ?? "—"}
                {job.input.isHdr ? " · HDR" : ""}
              </dd>
            </dl>
          </div>
          <div>
            <h3>Result</h3>
            <dl className="kv">
              <dt>Size</dt>
              <dd>
                {job.output.bytes ? formatBytes(job.output.bytes) : "—"}{" "}
                {job.output.usedOriginal ? <span className="dim">(original kept)</span> : null}
              </dd>
              <dt>Saved</dt>
              <dd className="save-positive">
                {job.output.usedOriginal ? "—" : formatPercent(job.output.savedPercent)}
              </dd>
              <dt>Geometry</dt>
              <dd>
                {job.output.width && job.output.height ? `${job.output.width}×${job.output.height}` : "—"}
              </dd>
              <dt>Converter</dt>
              <dd>
                {job.worker ?? "—"}
                {job.ffmpegVersion ? <span className="faint"> · {job.ffmpegVersion.split(" ").slice(0, 3).join(" ")}</span> : null}
              </dd>
            </dl>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          {download && (
            <a className="btn primary" href={download.url} download={download.name}>
              Download {download.name}
            </a>
          )}
          {job.status === "failed" && (
            <button className="btn" onClick={() => act("retry")} disabled={busy}>
              Try again
            </button>
          )}
          {job.status === "queued" && (
            <button className="btn" onClick={() => act("convert-here")} disabled={busy}>
              Convert here anyway
            </button>
          )}
          {job.telegram.chatId && job.telegram.status !== "sent" && job.status === "done" && (
            <button className="btn" onClick={() => act("deliver")} disabled={busy}>
              Send to Telegram again
            </button>
          )}
          {active && (
            <button className="btn ghost" onClick={() => act("cancel")} disabled={busy}>
              Cancel
            </button>
          )}
          <a className="btn ghost" href="/jobs">
            Back to history
          </a>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h3>Timeline</h3>
        </div>
        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>Created</dt>
          <dd>{formatTime(job.createdAt)}</dd>
          <dt>Started</dt>
          <dd>{formatTime(job.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{formatTime(job.finishedAt)}</dd>
          <dt>Attempts</dt>
          <dd>{job.attempts}</dd>
          <dt>Job id</dt>
          <dd className="mono">{job.id}</dd>
          {job.telegram.chatId ? (
            <>
              <dt>Telegram chat</dt>
              <dd className="mono">
                {job.telegram.chatId} · {job.telegram.status}
                {job.telegram.error ? ` · ${job.telegram.error}` : ""}
              </dd>
            </>
          ) : null}
        </dl>

        <pre className="log">
          {events.length === 0
            ? "no events recorded yet"
            : events
                .map((event) => `${event.at.slice(11, 19)}  ${event.level.padEnd(5)}  ${event.message}`)
                .join("\n")}
        </pre>
      </div>
    </div>
  );
}
