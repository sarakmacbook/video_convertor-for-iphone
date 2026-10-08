"use client";

/**
 * The "something is missing" banner: no database, no storage, no ffmpeg, no workers.
 * It only appears when there is something worth saying.
 */

import { useEffect, useState } from "react";

export interface HealthReport {
  ok: boolean;
  database: { configured: boolean; connected: boolean; dialect?: string; error?: string };
  storage: { driver: string; ok: boolean; detail: string };
  ffmpeg: { available: boolean; version: string | null; hasX265: boolean };
  telegram: { configured: boolean; webhook: string | null };
  workers: { online: number; total: number };
  canConvert: boolean;
  problems: string[];
}

export function useHealth(pollMs = 60_000): HealthReport | null {
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const body = (await response.json()) as HealthReport;
        if (!cancelled) setHealth(body);
      } catch {
        // Offline or the deployment is down: leave the last report in place.
      }
    };
    void load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return health;
}

export function StatusBanner() {
  const health = useHealth();
  if (!health || health.problems.length === 0) return null;

  const blocking = !health.database.connected || !health.storage.ok;

  return (
    <div className={`banner ${blocking ? "bad" : "warn"}`}>
      <strong>
        {blocking ? "This deployment needs configuration" : "Limited setup"}
      </strong>
      <ul>
        {health.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <div style={{ marginTop: 8 }}>
        {health.ffmpeg.available ? null : (
          <span className="pill warn">
            <span className="dot" /> no ffmpeg: conversions need a worker
          </span>
        )}{" "}
        {health.ok ? null : <a href="/settings">Open the settings page</a>}
      </div>
    </div>
  );
}
