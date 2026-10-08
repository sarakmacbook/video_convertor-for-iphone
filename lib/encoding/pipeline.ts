/**
 * One conversion: probe the input, re-encode it, check the result, and decide whether the
 * converted file is actually worth sending.
 *
 * A port of `video_convertor_bot/pipeline.py`, kept deliberately close to it: if a check
 * fails or the encode would not save anything, the original file is delivered instead, so the
 * user never gets something worse than what they uploaded.
 */

import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  buildEncodeCommand,
  estimateEncodeSeconds,
  ffmpegStatus,
  hasVideo,
  type EncodeOptions,
  EncodeError,
  NotAVideoError,
  probe,
  type ProbeError,
  runEncode,
  type VideoInfo,
  verifyOutput,
} from "./ffmpeg";

export interface ConversionResult {
  source: VideoInfo;
  sourceBytes: number;
  /** The file to deliver: the converted one, or the untouched original. */
  outputPath: string;
  outputBytes: number;
  usedOriginal: boolean;
  reason: string;
  output: VideoInfo | null;
  problems: string[];
  encodeSeconds: number;
}

export function decide(sourceBytes: number, outputBytes: number, problems: string[]): [boolean, string] {
  if (problems.length > 0) return [true, "a safety check failed"];
  if (outputBytes <= 0) return [true, "the converter produced no output"];
  if (outputBytes >= sourceBytes) return [true, "re-encoding would not make this file smaller"];
  return [false, "converted"];
}

export interface ConvertOptions {
  /** Directory the converted file is written into. */
  workDir: string;
  /** File name of the converted file inside `workDir`. */
  outName: string;
  crf: number;
  preset: string;
  timeoutSeconds: number;
  onProgress?: (fraction: number, message?: string) => void | Promise<void>;
  signal?: AbortSignal;
  ffmpeg?: string;
  ffprobe?: string | null;
}

export async function convertFile(inputPath: string, options: ConvertOptions): Promise<ConversionResult> {
  const status = options.ffmpeg ? null : await ffmpegStatus();
  const ffmpeg = options.ffmpeg ?? status?.path;
  if (!ffmpeg) {
    throw new EncodeError(status?.problems[0] ?? "ffmpeg is not available");
  }
  const ffprobe = options.ffprobe ?? status?.ffprobePath ?? null;

  const source = await probe(inputPath, ffmpeg, ffprobe);
  if (!hasVideo(source)) throw new NotAVideoError("no video track found in this file");

  const sourceBytes = (await stat(inputPath)).size;
  await mkdir(options.workDir, { recursive: true });
  const outputPath = path.join(options.workDir, options.outName);

  const encodeOptions: EncodeOptions = {
    ffmpeg,
    ffprobe,
    crf: options.crf,
    preset: options.preset,
    timeoutSeconds: options.timeoutSeconds,
  };

  await options.onProgress?.(0, "converting");
  const started = Date.now();
  await runEncode(buildEncodeCommand(inputPath, outputPath, source, encodeOptions), {
    duration: source.duration,
    timeoutSeconds: options.timeoutSeconds,
    logPath: path.join(options.workDir, "ffmpeg.log"),
    onProgress: (fraction) => options.onProgress?.(fraction),
    signal: options.signal,
  });
  const encodeSeconds = (Date.now() - started) / 1000;

  let outputBytes = 0;
  try {
    outputBytes = (await stat(outputPath)).size;
  } catch {
    outputBytes = 0;
  }

  let problems: string[] = [];
  let output: VideoInfo | null = null;
  if (outputBytes === 0) {
    problems = ["no output file was written"];
  } else {
    try {
      output = await probe(outputPath, ffmpeg, ffprobe);
      problems = verifyOutput(source, output);
    } catch (error) {
      problems = [`converted file could not be read (${(error as ProbeError).message})`];
    }
  }

  const [useOriginal, reason] = decide(sourceBytes, outputBytes, problems);
  if (useOriginal) {
    await unlink(outputPath).catch(() => undefined);
    return {
      source,
      sourceBytes,
      outputPath: inputPath,
      outputBytes: 0,
      usedOriginal: true,
      reason,
      output,
      problems,
      encodeSeconds,
    };
  }

  return {
    source,
    sourceBytes,
    outputPath,
    outputBytes,
    usedOriginal: false,
    reason,
    output,
    problems,
    encodeSeconds,
  };
}

export function savedPercent(sourceBytes: number, outputBytes: number, usedOriginal: boolean): number {
  if (usedOriginal || sourceBytes <= 0) return 0;
  return (1 - outputBytes / sourceBytes) * 100;
}

export { estimateEncodeSeconds };
