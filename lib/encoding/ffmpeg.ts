/**
 * ffmpeg: finding it, inspecting a file with it, and re-encoding to HEVC.
 *
 * This is a port of `video_convertor_bot/media.py` — same arguments, same checks, same
 * progress protocol — so a video converted by the web app and one converted by the Telegram
 * bot come out the same.
 *
 * Nothing here imports from Next.js, so the same code runs inside a serverless function, in
 * the `npm run worker` CLI and in tests.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const PROBE_TIMEOUT_SECONDS = 120;
export const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]); // HLG and PQ (HDR10)

export class MediaError extends Error {}
export class NotAVideoError extends MediaError {}
export class ProbeError extends MediaError {}
export class EncodeError extends MediaError {}
export class EncodeTimeoutError extends EncodeError {}

export interface EncodeOptions {
  ffmpeg: string;
  ffprobe?: string | null;
  crf: number;
  preset: string;
  timeoutSeconds: number;
  audioBitrate?: string;
}

export interface VideoInfo {
  codec: string | null;
  width: number;
  height: number;
  rotation: number;
  duration: number;
  fps: number | null;
  pixFmt: string | null;
  bitDepth: number;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  colorRange: string | null;
  audioCodec: string | null;
}

export const emptyVideoInfo: VideoInfo = {
  codec: null,
  width: 0,
  height: 0,
  rotation: 0,
  duration: 0,
  fps: null,
  pixFmt: null,
  bitDepth: 8,
  colorPrimaries: null,
  colorTransfer: null,
  colorSpace: null,
  colorRange: null,
  audioCodec: null,
};

export function hasVideo(info: VideoInfo): boolean {
  return Boolean(info.codec) && info.width > 0 && info.height > 0;
}

export function isRotated(info: VideoInfo): boolean {
  return info.rotation === 90 || info.rotation === 270;
}

export function displayWidth(info: VideoInfo): number {
  return isRotated(info) ? info.height : info.width;
}

export function displayHeight(info: VideoInfo): number {
  return isRotated(info) ? info.width : info.height;
}

export function isHdr(info: VideoInfo): boolean {
  return Boolean(info.colorTransfer && HDR_TRANSFERS.has(info.colorTransfer));
}

// --------------------------------------------------------------------------- //
// Finding the binaries
// --------------------------------------------------------------------------- //

interface Tool {
  path: string;
  version: string;
  hasX265?: boolean;
}

let ffmpegTool: Promise<Tool | null> | null = null;
let ffprobePath: Promise<string | null> | null = null;

function envPath(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  return value || null;
}

function runnable(bin: string, args: string[] = ["-version"]): string | null {
  if (bin.includes("/") && !existsSync(bin)) return null;
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status === null) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** `ffmpeg-static` / `ffprobe-static` are optional dependencies — use them when installed. */
function optionalPackagePath(pkg: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require(pkg) as string | { path?: string };
    const value = typeof resolved === "string" ? resolved : resolved?.path;
    return value && existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Download a static ffmpeg build once per instance into the temporary directory.
 * `FFMPEG_URL` may point at a plain binary, a `.gz`-compressed binary, or a `.tar`/`.tar.gz`
 * archive (ffmpeg and ffprobe are both extracted when present).
 */
async function downloadFfmpeg(url: string): Promise<Tool | null> {
  const dir = path.join(process.env.WORK_DIR?.trim() || "/tmp", "ffmpeg-static");
  const name = path.basename(new URL(url).pathname) || "ffmpeg";
  const target = path.join(dir, name.replace(/\.(gz|tar|tgz)$/i, ""));
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(target)) {
      const output = runnable(target);
      if (output) return { path: target, version: firstLine(output) };
    }

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    const temp = `${target}.download`;
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    if (url.endsWith(".gz") || url.endsWith(".tgz")) {
      await pipeline(nodeStream, createGunzip(), createWriteStream(temp));
    } else {
      await pipeline(nodeStream, createWriteStream(temp));
    }

    if (name.includes(".tar")) {
      // A tar archive: extract ffmpeg and ffprobe (decompression already handled above).
      extractFromTar(temp, dir);
      await rm(temp, { force: true });
      const extracted = path.join(dir, "ffmpeg");
      if (!existsSync(extracted)) throw new Error("the archive did not contain an ffmpeg binary");
      chmodSync(extracted, 0o755);
      const probe = path.join(dir, "ffprobe");
      if (existsSync(probe)) {
        chmodSync(probe, 0o755);
        // Let resolveFfprobe() find it next to the ffmpeg binary.
        process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || probe;
      }
      const output = runnable(extracted);
      if (!output) throw new Error("the downloaded ffmpeg binary did not run");
      return { path: extracted, version: firstLine(output) };
    }

    chmodSync(temp, 0o755);
    await rm(target, { force: true });
    renameSync(temp, target);
    const output = runnable(target);
    if (!output) throw new Error("the downloaded ffmpeg binary did not run");
    return { path: target, version: firstLine(output) };
  } catch (error) {
    console.warn(`could not prepare ffmpeg from FFMPEG_URL: ${(error as Error).message}`);
    return null;
  }
}

/** Minimal tar reader: enough for release archives that hold flat files. */
function extractFromTar(archive: string, dir: string): void {
  const data = readFileSync(archive);
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!rawName) break;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const base = path.basename(rawName);
    if (base === "ffmpeg" || base === "ffprobe") {
      const content = data.subarray(offset + 512, offset + 512 + size);
      writeFileSync(path.join(dir, base), content, { mode: 0o755 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

export interface FfmpegStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  hasX265: boolean;
  source: "env" | "url" | "package" | "path" | "none";
  ffprobePath: string | null;
  problems: string[];
}

export async function resolveFfmpeg(): Promise<Tool | null> {
  if (!ffmpegTool) {
    ffmpegTool = (async () => {
      const explicit = envPath("FFMPEG_PATH") ?? envPath("FFMPEG_BIN");
      if (explicit) {
        const output = runnable(explicit);
        if (output) return { path: explicit, version: firstLine(output) };
        console.warn(`FFMPEG_PATH=${explicit} could not be run; falling back to other sources`);
      }

      const url = envPath("FFMPEG_URL");
      if (url) {
        const downloaded = await downloadFfmpeg(url);
        if (downloaded) return downloaded;
      }

      const packaged = optionalPackagePath("ffmpeg-static");
      if (packaged) {
        const output = runnable(packaged);
        if (output) return { path: packaged, version: firstLine(output) };
      }

      const onPath = runnable("ffmpeg");
      if (onPath) return { path: "ffmpeg", version: firstLine(onPath) };
      return null;
    })();
  }
  return ffmpegTool;
}

export async function resolveFfprobe(ffmpegPath?: string | null): Promise<string | null> {
  if (!ffprobePath) {
    ffprobePath = (async () => {
      const explicit = envPath("FFPROBE_PATH") ?? envPath("FFPROBE_BIN");
      if (explicit && runnable(explicit)) return explicit;
      const packaged = optionalPackagePath("ffprobe-static");
      if (packaged && runnable(packaged)) return packaged;
      // A downloaded archive may have shipped ffprobe next to ffmpeg.
      if (ffmpegPath && ffmpegPath.includes("/")) {
        const sibling = path.join(path.dirname(ffmpegPath), "ffprobe");
        if (existsSync(sibling) && runnable(sibling)) return sibling;
      }
      if (runnable("ffprobe")) return "ffprobe";
      return null;
    })();
  }
  return ffprobePath;
}

export async function ffmpegStatus(): Promise<FfmpegStatus> {
  const problems: string[] = [];
  let tool: Tool | null = null;
  try {
    tool = await resolveFfmpeg();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (!tool) {
    problems.push(
      "ffmpeg was not found. On Vercel add FFMPEG_URL pointing at a static build, or install the ffmpeg-static package; locally install ffmpeg or set FFMPEG_PATH.",
    );
    return {
      available: false,
      path: null,
      version: null,
      hasX265: false,
      source: "none",
      ffprobePath: null,
      problems,
    };
  }

  const encoders = runnable(tool.path, ["-hide_banner", "-encoders"]) ?? "";
  const hasX265 = encoders.includes("libx265");
  if (!hasX265) {
    problems.push(
      "this ffmpeg build has no libx265 (HEVC) encoder, so videos cannot be converted to H.265. Install a full build (Homebrew's, or a static build with libx265).",
    );
  }

  const probe = await resolveFfprobe(tool.path);
  const source: FfmpegStatus["source"] = envPath("FFMPEG_PATH") || envPath("FFMPEG_BIN")
    ? "env"
    : envPath("FFMPEG_URL")
      ? "url"
      : tool.path.includes("node_modules")
        ? "package"
        : "path";

  return {
    available: hasX265,
    path: tool.path,
    version: tool.version,
    hasX265,
    source,
    ffprobePath: probe,
    problems,
  };
}

export function resetToolCacheForTests(): void {
  ffmpegTool = null;
  ffprobePath = null;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

// --------------------------------------------------------------------------- //
// Probing
// --------------------------------------------------------------------------- //

export interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string | number;
  bits_per_raw_sample?: string;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

export interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string | number };
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanTag(value: unknown): string | null {
  if (typeof value !== "string" || !value || value === "unknown") return null;
  return value;
}

export function parseProbeJson(data: RawProbe): VideoInfo {
  const streams = (data.streams ?? []).filter((s) => s && typeof s === "object");
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = asNumber(data.format?.duration) ?? 0;

  if (!video) {
    return { ...emptyVideoInfo, duration, audioCodec: cleanTag(audio?.codec_name) };
  }

  const pixFmt = cleanTag(video.pix_fmt);
  return {
    codec: cleanTag(video.codec_name),
    width: Math.round(asNumber(video.width) ?? 0),
    height: Math.round(asNumber(video.height) ?? 0),
    rotation: rotationFrom(video),
    duration: duration || asNumber(video.duration) || 0,
    fps: frameRateFrom(video),
    pixFmt,
    bitDepth: bitDepthFrom(video.bits_per_raw_sample, pixFmt),
    colorPrimaries: cleanTag(video.color_primaries),
    colorTransfer: cleanTag(video.color_transfer),
    colorSpace: cleanTag(video.color_space),
    colorRange: cleanTag(video.color_range),
    audioCodec: cleanTag(audio?.codec_name),
  };
}

function rotationFrom(stream: RawStream): number {
  let angle: unknown = stream.side_data_list?.find((s) => s && "rotation" in s)?.rotation;
  if (angle === undefined || angle === null) angle = stream.tags?.rotate;
  const value = asNumber(angle);
  if (value === null) return 0;
  const normalized = ((Math.round(value) % 360) + 360) % 360; // -90 (iPhone portrait) -> 270
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function frameRateFrom(stream: RawStream): number | null {
  for (const key of ["avg_frame_rate", "r_frame_rate"] as const) {
    const raw = stream[key];
    if (!raw) continue;
    const [num, den] = String(raw).split("/").map((part) => Number.parseFloat(part));
    if (!Number.isFinite(num)) continue;
    const value = den === undefined || den === 0 ? num : num / den;
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function bitDepthFrom(bitsPerRawSample: unknown, pixFmt: string | null): number {
  const raw = asNumber(bitsPerRawSample);
  if (raw) return Math.round(raw);
  const match = /p(\d+)(?:le|be)$/.exec(pixFmt ?? "");
  return match ? Number(match[1]) : 8;
}

/**
 * Parse the report `ffmpeg -i` writes to stderr. Used when no ffprobe binary is available —
 * several static builds (including the one `ffmpeg-static` downloads) ship ffmpeg only.
 */
export function parseProbeText(text: string): VideoInfo {
  const info: VideoInfo = { ...emptyVideoInfo };

  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (duration) {
    info.duration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  }

  for (const line of text.split("\n")) {
    if (!line.includes("Stream #") || !line.includes(": Video:")) continue;
    if (line.includes("attached pic")) continue;
    const codec = /Video:\s*([A-Za-z0-9_]+)/.exec(line);
    info.codec = cleanTag(codec?.[1]);
    const size = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(line);
    if (size) {
      info.width = Number(size[1]);
      info.height = Number(size[2]);
    }
    // `yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive)`
    const pixWithDetails = /,\s*([a-z0-9]+(?:p\d+(?:le|be)?)?)\s*\(([^)]*)\)/.exec(line);
    if (pixWithDetails) {
      info.pixFmt = pixWithDetails[1];
      info.bitDepth = bitDepthFrom(null, info.pixFmt);
      applyColorDetails(info, pixWithDetails[2]);
    } else {
      const pixFmt = /,\s*(yuv[a-z0-9]*p\d*(?:le|be)?|nv12|nv21|p010le|p012le|gbrp\d*(?:le|be)?|rgb[a-z0-9]*)\s*[,\[]/.exec(line);
      if (pixFmt) {
        info.pixFmt = pixFmt[1];
        info.bitDepth = bitDepthFrom(null, info.pixFmt);
      }
    }
    const fps = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(line);
    if (fps) info.fps = Number(fps[1]);
  }

  // Rotation: ffmpeg 6+ prints a display matrix, older builds a `rotate` tag.
  const sideData = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text);
  const rotateTag = /rotate\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text);
  const angle = asNumber(sideData?.[1] ?? rotateTag?.[1]);
  if (angle !== null) {
    const normalized = ((Math.round(angle) % 360) + 360) % 360;
    info.rotation = [0, 90, 180, 270].includes(normalized) ? normalized : 0;
  }

  const audio = /Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(text);
  if (audio) info.audioCodec = cleanTag(audio[1]);

  return info;
}

/**
 * The text inside the pix_fmt parentheses, e.g. `tv, bt2020nc/bt2020/arib-std-b67, progressive`:
 * an optional range, then `space/primaries/transfer`, then flags such as `progressive`.
 */
function applyColorDetails(info: VideoInfo, details: string): void {
  for (const part of details.split(",").map((item) => item.trim())) {
    if (!part) continue;
    if (["tv", "pc", "limited", "full"].includes(part)) {
      info.colorRange = part;
      continue;
    }
    const groups = part.split("/").filter(Boolean);
    if (groups.length >= 2 && groups.length <= 3) {
      info.colorSpace = cleanTag(groups[0]);
      info.colorPrimaries = cleanTag(groups[1]);
      info.colorTransfer = cleanTag(groups[2]);
    }
  }
}

export async function probe(file: string, ffmpeg: string, ffprobe?: string | null): Promise<VideoInfo> {
  if (ffprobe) {
    const result = await runCapture(
      [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file,
      ],
      PROBE_TIMEOUT_SECONDS,
    );
    if (result.code === 0) {
      try {
        return parseProbeJson(JSON.parse(result.stdout || "{}") as RawProbe);
      } catch {
        throw new ProbeError("ffprobe returned unreadable output");
      }
    }
    // Fall through to the ffmpeg parser: a broken ffprobe should not lose the job.
  }

  const result = await runCapture([ffmpeg, "-hide_banner", "-nostdin", "-i", file], PROBE_TIMEOUT_SECONDS);
  const text = `${result.stderr}${result.stdout}`;
  if (!text.includes("Stream #")) {
    const detail = text.trim().split("\n").filter(Boolean).pop() ?? "could not read the file";
    throw new ProbeError(detail);
  }
  return parseProbeText(text);
}

async function runCapture(cmd: string[], timeoutSeconds: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProbeError(`probe timed out after ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProbeError(`could not run ${cmd[0]}: ${(error as Error).message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

// --------------------------------------------------------------------------- //
// Encoding
// --------------------------------------------------------------------------- //

/** Keep 10-bit for 10-bit sources (iPhone HDR); chroma stays 4:2:0. */
export function outputPixFmt(info: VideoInfo): string {
  return info.bitDepth >= 10 ? "yuv420p10le" : "yuv420p";
}

export function buildEncodeCommand(
  src: string,
  dst: string,
  info: VideoInfo,
  opts: Pick<EncodeOptions, "ffmpeg" | "crf" | "preset" | "audioBitrate">,
): string[] {
  if (!hasVideo(info)) throw new NotAVideoError("no video track to encode");

  const cmd = [
    opts.ffmpeg,
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    src,
    "-map",
    "0:V:0",
    "-map",
    "0:a:0?",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-c:v",
    "libx265",
    "-preset",
    opts.preset,
    "-crf",
    String(opts.crf),
    "-pix_fmt",
    outputPixFmt(info),
    "-tag:v",
    "hvc1",
    "-x265-params",
    "log-level=error",
    "-fps_mode",
    "passthrough",
  ];

  for (const [flag, value] of [
    ["-color_primaries", info.colorPrimaries],
    ["-color_trc", info.colorTransfer],
    ["-colorspace", info.colorSpace],
    ["-color_range", info.colorRange],
  ] as const) {
    if (value) cmd.push(flag, value);
  }

  if (info.audioCodec === "aac") {
    cmd.push("-c:a", "copy");
  } else if (info.audioCodec) {
    cmd.push("-c:a", "aac", "-b:a", opts.audioBitrate ?? "256k");
  }

  cmd.push("-movflags", "+faststart+use_metadata_tags", "-progress", "pipe:1", "-nostats", dst);
  return cmd;
}

export function parseProgressFraction(line: string, duration: number): number | null {
  const [key, value] = line.trim().split("=");
  if (!value || (key !== "out_time_us" && key !== "out_time_ms") || duration <= 0) return null;
  if (!/^\d+$/.test(value)) return null; // ffmpeg prints N/A at the very start
  return Math.min(1, Number(value) / 1_000_000 / duration);
}

export interface RunEncodeOptions {
  duration: number;
  timeoutSeconds: number;
  logPath?: string;
  onProgress?: (fraction: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function runEncode(cmd: string[], options: RunEncodeOptions): Promise<void> {
  const logPath = options.logPath ?? path.join(process.env.WORK_DIR?.trim() || "/tmp", `ffmpeg-${Date.now()}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "w" });
  logStream.write(`${cmd.join(" ")}\n\n`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let lastReported = -1;
    let pending = Promise.resolve();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.end();
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new EncodeTimeoutError(`conversion stopped after ${Math.round(options.timeoutSeconds)} seconds`));
    }, options.timeoutSeconds * 1000);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new EncodeError("conversion was canceled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const fraction = parseProgressFraction(line, options.duration);
        if (fraction === null || !options.onProgress) continue;
        if (fraction - lastReported < 0.01) continue;
        lastReported = fraction;
        const value = fraction;
        pending = pending.then(() => options.onProgress?.(value)).catch(() => undefined);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));

    child.on("error", (error) => {
      finish(new EncodeError(`could not run ${cmd[0]}: ${(error as Error).message}`));
    });
    child.on("close", (code) => {
      pending.finally(() => {
        options.signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          finish(new EncodeError(`ffmpeg exited with code ${code}: ${logTail(logPath)}`));
        } else {
          finish();
        }
      });
    });
  });
}

export function logTail(logPath: string, lines = 12): string {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").slice(-lines).join(" | ");
  } catch {
    return "";
  }
}

/** Compare the converted file with the original. An empty list means it looks right. */
export function verifyOutput(source: VideoInfo, output: VideoInfo): string[] {
  if (!hasVideo(output)) return ["converted file has no video"];

  const problems: string[] = [];
  if (output.codec !== "hevc") problems.push(`codec is ${output.codec}, expected hevc`);
  if (displayWidth(output) !== displayWidth(source) || displayHeight(output) !== displayHeight(source)) {
    problems.push(
      `resolution changed from ${displayWidth(source)}x${displayHeight(source)} to ${displayWidth(output)}x${displayHeight(output)}`,
    );
  }
  if (source.duration > 0 && Math.abs(output.duration - source.duration) > Math.max(0.25, source.duration * 0.01)) {
    problems.push("duration changed");
  }
  if (source.fps && output.fps && Math.abs(source.fps - output.fps) > 0.01) problems.push("frame rate changed");
  if (output.bitDepth < Math.min(source.bitDepth, 10)) problems.push("bit depth dropped");
  if (source.colorTransfer && output.colorTransfer !== source.colorTransfer) problems.push("colour transfer changed");
  if (source.audioCodec && !output.audioCodec) problems.push("audio track missing");
  return problems;
}

/**
 * Rough guess at how long an encode will take, used to decide whether a job can be finished
 * inside a serverless function or should wait for a worker.
 */
export function estimateEncodeSeconds(info: VideoInfo, opts: { speedFactor: number; crf?: number; preset?: string }): number {
  const duration = info.duration > 0 ? info.duration : 60;
  const presetFactor = PRESET_SPEED_FACTORS[opts.preset ?? "medium"] ?? 1;
  const pixels = Math.max(1, displayWidth(info) * displayHeight(info));
  const resolutionFactor = Math.max(0.5, Math.min(4, pixels / (1920 * 1080)));
  const factor = Math.max(0.05, opts.speedFactor);
  return (duration / factor) * presetFactor * resolutionFactor;
}

/** Relative encoding cost of each x265 preset, with `medium` as the reference. */
export const PRESET_SPEED_FACTORS: Record<string, number> = {
  ultrafast: 0.15,
  superfast: 0.2,
  veryfast: 0.3,
  faster: 0.45,
  fast: 0.6,
  medium: 1,
  slow: 1.6,
  slower: 2.4,
  veryslow: 4,
};
