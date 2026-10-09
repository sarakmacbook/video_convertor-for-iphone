/**
 * What a user can ask for after sending a video, and how each choice is named and sent.
 *
 * A port of `video_convertor_bot/conversions.py`. The keys travel inside Telegram button data
 * (`conv:<key>`) and inside job records, so both bots and the worker must agree on them. Keep
 * the two lists in step.
 */

export const CALLBACK_PREFIX = "conv:"; // button data is "conv:<key>", well under Telegram's 64-byte limit

export const GIF_MAX_SECONDS = 10; // only the first few seconds of a clip become a GIF
export const GIF_MAX_SIDE = 480; // longest side of a GIF, in pixels

export type ConversionKind = "video" | "gif" | "audio";

export interface Conversion {
  key: string;
  /** The label on the button. */
  button: string;
  /** How the caption names the result, e.g. "HEVC" or "GIF". */
  title: string;
  /** Decides how Telegram receives the file. */
  kind: ConversionKind;
  /** The codec written to the file: hevc, h264, gif, aac or mp3. */
  codec: string;
  extension: string;
  mimeType: string;
  /** Added to the file name, e.g. IMG_1234_small.mp4. */
  nameSuffix: string;
  /** Video only: the shorter side is limited to this (never upscaled). */
  shortSide?: number;
  /** GIF only: only this much of the video is used. */
  maxSeconds?: number;
  /**
   * Smaller-file conversions fall back to the original when the result is not smaller. Format
   * conversions always deliver what was asked for, because the user chose the format.
   */
  keepsOriginalIfLarger: boolean;
}

export const CONVERSIONS: readonly Conversion[] = [
  {
    key: "hevc",
    button: "🗜 Smaller (HEVC)",
    title: "HEVC",
    kind: "video",
    codec: "hevc",
    extension: ".mp4",
    mimeType: "video/mp4",
    nameSuffix: "_small",
    keepsOriginalIfLarger: true,
  },
  {
    key: "hevc720",
    button: "📐 720p",
    title: "HEVC 720p",
    kind: "video",
    codec: "hevc",
    extension: ".mp4",
    mimeType: "video/mp4",
    nameSuffix: "_720p",
    shortSide: 720,
    keepsOriginalIfLarger: true,
  },
  {
    key: "hevc480",
    button: "📐 480p",
    title: "HEVC 480p",
    kind: "video",
    codec: "hevc",
    extension: ".mp4",
    mimeType: "video/mp4",
    nameSuffix: "_480p",
    shortSide: 480,
    keepsOriginalIfLarger: true,
  },
  {
    key: "h264",
    button: "📱 MP4 (H.264)",
    title: "H.264",
    kind: "video",
    codec: "h264",
    extension: ".mp4",
    mimeType: "video/mp4",
    nameSuffix: "_h264",
    keepsOriginalIfLarger: false,
  },
  {
    key: "gif",
    button: "🎞 GIF",
    title: "GIF",
    kind: "gif",
    codec: "gif",
    extension: ".gif",
    mimeType: "image/gif",
    nameSuffix: "_gif",
    maxSeconds: GIF_MAX_SECONDS,
    keepsOriginalIfLarger: false,
  },
  {
    key: "m4a",
    button: "🎵 Audio (M4A)",
    title: "M4A audio",
    kind: "audio",
    codec: "aac",
    extension: ".m4a",
    mimeType: "audio/mp4",
    nameSuffix: "_audio",
    keepsOriginalIfLarger: false,
  },
  {
    key: "mp3",
    button: "🎵 Audio (MP3)",
    title: "MP3 audio",
    kind: "audio",
    codec: "mp3",
    extension: ".mp3",
    mimeType: "audio/mpeg",
    nameSuffix: "_audio",
    keepsOriginalIfLarger: false,
  },
];

export const DEFAULT_CONVERSION_KEY = "hevc";

const BY_KEY = new Map(CONVERSIONS.map((conversion) => [conversion.key, conversion]));

export const DEFAULT_CONVERSION: Conversion = BY_KEY.get(DEFAULT_CONVERSION_KEY)!;

/** Keyboard layout of the menu: each inner array is one row of buttons. */
export const CHOICE_LAYOUT: readonly (readonly string[])[] = [
  ["hevc", "h264"],
  ["hevc720", "hevc480"],
  ["gif"],
  ["m4a", "mp3"],
];

/** The conversion for a key; an unknown or missing key means the default (smaller HEVC). */
export function getConversion(key: string | null | undefined): Conversion {
  if (!key) return DEFAULT_CONVERSION;
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`unknown conversion "${key}"`);
  return found;
}

export function callbackData(key: string): string {
  return `${CALLBACK_PREFIX}${key}`;
}

/** The conversion key in a button's data, or null if the button is not one of ours. */
export function keyFromCallback(data: string | null | undefined): string | null {
  if (!data || !data.startsWith(CALLBACK_PREFIX)) return null;
  const key = data.slice(CALLBACK_PREFIX.length);
  return BY_KEY.has(key) ? key : null;
}

/** How much of the source ends up in the output (used for progress and checks). */
export function effectiveSeconds(conversion: Conversion, duration: number): number {
  if (conversion.maxSeconds !== undefined) return Math.min(duration, conversion.maxSeconds);
  return duration;
}

/** The conversion a job was created for, read from its `meta` JSON. Jobs without one get the default. */
export function conversionOfMeta(meta: string | null | undefined): Conversion {
  if (!meta) return DEFAULT_CONVERSION;
  try {
    const parsed = JSON.parse(meta) as { conversion?: unknown };
    return typeof parsed.conversion === "string" && BY_KEY.has(parsed.conversion)
      ? getConversion(parsed.conversion)
      : DEFAULT_CONVERSION;
  } catch {
    return DEFAULT_CONVERSION;
  }
}
