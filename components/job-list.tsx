"use client";

/** The history table: every job, newest first, with the numbers that matter. */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRelative,
  STATUS_LABELS,
  statusTone,
} from "@/lib/format";

interface JobView {
  id: string;
  status: string;
  stage: string;
  progress: number;
  message: string | null;
  source: string;
  createdAt: string;
  input: { name: string | null; bytes: number; duration: number | null };
  output: { bytes: number | null; usedOriginal: boolean | null; savedPercent: number | null };
  telegram: { chatId: number | null; status: string };
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

export function JobList() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs?status=${filter}&limit=100`, { cache: "no-store" });
      const body = (await response.json()) as { ok: boolean; jobs?: JobView[]; total?: number; error?: string };
      if (!body.ok) throw new Error(body.error ?? "the job list could not be read");
      setJobs(body.jobs ?? []);
      setTotal(body.total ?? 0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await fetch(`/api/jobs/${id}`, { method: "DELETE" });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const totals = jobs.reduce(
    (accumulator, job) => {
      if (job.status === "done" && !job.output.usedOriginal && job.output.bytes) {
        accumulator.saved += job.input.bytes - job.output.bytes;
        accumulator.converted += 1;
      }
      if (job.status === "failed") accumulator.failed += 1;
      if (job.status === "queued" || job.status === "running") accumulator.active += 1;
      return accumulator;
    },
    { saved: 0, converted: 0, failed: 0, active: 0 },
  );

  return (
    <div>
      <div className="grid stat" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="value">{total}</div>
          <div className="label">jobs</div>
        </div>
        <div className="stat">
          <div className="value">{totals.active}</div>
          <div className="label">in progress</div>
        </div>
        <div className="stat">
          <div className="value">{totals.converted}</div>
          <div className="label">converted</div>
        </div>
        <div className="stat">
          <div className="value">{formatBytes(totals.saved)}</div>
          <div className="label">space saved</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Job history</h2>
          <div className="spacer" />
          <div className="btn-row">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                className={`btn small ${filter === option.value ? "primary" : "ghost"}`}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
            <button className="btn small ghost" onClick={() => void load()} disabled={busy}>
              Refresh
            </button>
          </div>
        </div>

        {error && <div className="banner bad">{error}</div>}

        {jobs.length === 0 && !error ? (
          <p className="dim">Nothing here yet. Convert a video and it will show up in this list.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>File</th>
                  <th className="numeric hide-small">Original</th>
                  <th className="numeric">Result</th>
                  <th className="numeric hide-small">Saved</th>
                  <th className="hide-small">When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const saved =
                    job.status === "done" && !job.output.usedOriginal && job.output.bytes && job.input.bytes > 0
                      ? ((1 - job.output.bytes / job.input.bytes) * 100)
                      : null;
                  return (
                    <tr key={job.id}>
                      <td>
                        <span className={`pill ${statusTone(job.status)}`}>
                          <span className="dot" />
                          {STATUS_LABELS[job.status] ?? job.status}
                        </span>
                        {job.source === "telegram" && (
                          <>
                            {" "}
                            <span className="pill">Telegram</span>
                          </>
                        )}
                      </td>
                      <td>
                        <Link href={`/jobs/${job.id}`}>{job.input.name ?? job.id}</Link>
                        <div className="faint" style={{ fontSize: "0.78rem" }}>
                          {job.status === "running" ? `${Math.round(job.progress * 100)}%` : (job.message ?? "")}
                        </div>
                      </td>
                      <td className="numeric hide-small">
                        {formatBytes(job.input.bytes)}
                        <div className="faint" style={{ fontSize: "0.78rem" }}>
                          {formatDuration(job.input.duration)}
                        </div>
                      </td>
                      <td className="numeric">{job.output.bytes ? formatBytes(job.output.bytes) : "—"}</td>
                      <td className="numeric hide-small">
                        {job.output.usedOriginal ? (
                          <span className="dim">kept original</span>
                        ) : (
                          <span className="save-positive">{formatPercent(saved)}</span>
                        )}
                      </td>
                      <td className="hide-small dim">{formatRelative(job.createdAt)}</td>
                      <td className="numeric">
                        <button
                          className="btn small ghost"
                          onClick={() => void remove(job.id)}
                          disabled={busy}
                          title="Delete this job and its files"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
