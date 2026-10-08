/** Shared helpers for the JavaScript tests: building small iPhone-style clips with ffmpeg. */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { ffmpegStatus, type VideoInfo } from "@/lib/encoding/ffmpeg";

export interface ClipOptions {
  seconds?: number;
  width?: number;
  height?: number;
  rate?: number;
  rotation?: number;
  hdr?: boolean;
  /** Existing file to reuse as a template (keeps tests fast). */
  source?: string;
  name: string;
}

export async function ffmpegBinaries(): Promise<{ ffmpeg: string; ffprobe: string | null } | null> {
  const status = await ffmpegStatus();
  if (!status.available || !status.path) return null;
  return { ffmpeg: status.path, ffprobe: status.ffprobePath };
}

export function runFfmpeg(ffmpeg: string, args: string[]): void {
  execFileSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A small clip with the characteristics of an iPhone recording: 10-bit HEVC, HLG colour tags,
 * AAC audio, and a rotation matrix for portrait video.
 */
export function makeIphoneClip(
  ffmpeg: string,
  dir: string,
  options: ClipOptions,
): { path: string; bytes: number } {
  mkdirSync(dir, { recursive: true });
  const seconds = options.seconds ?? 2;
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const rate = options.rate ?? 30;
  const target = path.join(dir, `${options.name}.mov`);

  const noisy = "[0:v]noise=alls=6:allf=t+u,format=yuv420p10le[v]";
  const colorArgs = options.hdr
    ? ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc"]
    : [];

  const base = options.source && existsSync(options.source) ? options.source : path.join(dir, `${options.name}_base.mov`);
  if (base !== options.source) {
    runFfmpeg(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${width}x${height}:rate=${rate}:duration=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-filter_complex",
      noisy,
      "-map",
      "[v]",
      "-map",
      "1:a",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-x265-params",
      "log-level=error",
      "-tag:v",
      "hvc1",
      ...colorArgs,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      base,
    ]);
  }

  if (options.rotation) {
    runFfmpeg(ffmpeg, [
      "-display_rotation:v:0",
      String(options.rotation),
      "-i",
      base,
      "-c",
      "copy",
      "-metadata",
      "creation_time=2026-10-01T12:00:00Z",
      "-metadata",
      "location=+37.7749-122.4194/",
      target,
    ]);
  } else {
    runFfmpeg(ffmpeg, ["-i", base, "-c", "copy", target]);
  }

  return { path: target, bytes: statSync(target).size };
}

/** Average PSNR between two files, compared in display orientation (like scripts/compare_quality.sh). */
export function psnr(ffmpeg: string, reference: string, distorted: string): number {
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      distorted,
      "-i",
      reference,
      "-lavfi",
      "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]psnr",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  const stderr = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  const match = /average:([0-9.]+|inf)/.exec(stderr);
  if (!match) {
    throw new Error(`psnr produced no result (exit ${result.status}):\n${stderr.split("\n").slice(-6).join("\n")}`);
  }
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

export function describeInfo(info: VideoInfo): string {
  return `${info.codec} ${info.width}x${info.height} rot=${info.rotation} ${info.bitDepth}-bit ${info.colorTransfer ?? "sdr"} audio=${info.audioCodec ?? "none"}`;
}
