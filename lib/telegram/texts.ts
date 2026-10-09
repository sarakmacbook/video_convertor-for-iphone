/**
 * The words the bot uses. Kept in the same voice as `video_convertor_bot/bot.py` so the
 * Telegram bot behaves identically whether it runs as a polling process or as this webhook.
 */

import type { Conversion } from "@/lib/conversions";
import { CLOUD_DOWNLOAD_LIMIT_MB, CLOUD_UPLOAD_LIMIT_MB } from "@/lib/settings/schema";

export const TEXT_START = [
  "👋 Send me a video, then pick what to make from it:",
  "",
  "• 🗜 Smaller (HEVC): the same video in a smaller file.",
  "• 📐 720p or 480p: the same video, scaled down.",
  "• 📱 MP4 (H.264): for devices and apps that can't play HEVC.",
  "• 🎞 GIF: the first 10 seconds as an animation.",
  "• 🎵 Audio: just the sound, as M4A or MP3.",
  "",
  "• Send it as a File (📎 → File). A normal video is compressed by Telegram before it reaches me.",
  "• For the smaller file, resolution, frame rate, HDR colour, sound, capture date and location are kept.",
  "• The smaller file is re-encoded at a visually lossless setting. A re-encode can never be bit-for-bit identical to the original; the aim is a difference you can't see when watching.",
  "• If re-encoding would not make a file smaller, I send your original back.",
].join("\n");

/** Shown under the menu of buttons. Kept in step with `TEXT_CHOOSE` in `video_convertor_bot/bot.py`. */
export const TEXT_CHOOSE = [
  "What should I make from this video?",
  "",
  "🗜 Smaller: the same video, HEVC, looks the same.",
  "📐 720p / 480p: scaled down, never up.",
  "📱 MP4 (H.264): plays on almost any device.",
  "🎞 GIF: the first 10 seconds, up to 480 px.",
  "🎵 Audio: just the sound, as M4A or MP3.",
].join("\n");
export const TEXT_CHOICE_EXPIRED = "I can't find the video for this button any more. Send the video again.";
export const TEXT_BUSY = "This video is already being converted.";
export const TEXT_NO_AUDIO = "This video has no sound, so there is no audio to save.";

export const TEXT_CLOUD_LIMITS =
  `\n\nLimits on the standard Telegram server: I can receive files up to ${CLOUD_DOWNLOAD_LIMIT_MB} MB ` +
  `and send files up to ${CLOUD_UPLOAD_LIMIT_MB} MB.`;

export const TEXT_CLOUD_HINT =
  `Telegram's standard bot server only lets bots download files up to ${CLOUD_DOWNLOAD_LIMIT_MB} MB. ` +
  "Bigger videos need a local Telegram Bot API server (see the README).";

export const TEXT_PRIVATE = "Sorry, this bot is private.";
export const TEXT_NOT_VIDEO =
  "That doesn't look like a video. Send a video file, ideally as a File so Telegram doesn't compress it.";
export const TEXT_QUEUED = "⏳ Queued. A converter will pick this up shortly.";
export const TEXT_DOWNLOADING = "📥 Downloading…";
export const TEXT_CONVERTING = "⚙️ Converting… {pct}%";
export const TEXT_SENDING = "📤 Sending…";
export const TEXT_DONE = "✅ Done";
export const TEXT_FAILED_STATUS = "❌ Could not convert this video";
export const TEXT_UNREADABLE = "I couldn't read this video. Try sending it again as a File.";
export const TEXT_TIMEOUT = "Converting this video took too long, so I stopped it.";
export const TEXT_FAILED = "Something went wrong while converting this video. The bot owner can check the logs.";
export const TEXT_TOO_LARGE_TO_SEND = "The converted video is {size}, over this bot's upload limit of {limit}.";
export const TEXT_WORKER_NEEDED =
  "📥 Queued. This video is too big to convert on the server, so a converter worker will take it. " +
  "If nothing happens, the bot owner needs to start one (`npm run worker`).";

export function convertingText(percent: number): string {
  return TEXT_CONVERTING.replace("{pct}", String(percent));
}

export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export interface ResultTextInput {
  conversion: Conversion;
  usedOriginal: boolean;
  reason: string;
  sourceBytes: number;
  outputBytes: number;
  savedPercent: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  isHdr: boolean;
}

/**
 * The message shown under the file that is sent back. A port of `describe_result` in
 * `video_convertor_bot/captions.py`.
 */
export function describeResult(result: ResultTextInput): string {
  const conversion = result.conversion;
  const size =
    result.width && result.height
      ? `${result.width}×${result.height}${result.duration ? ` · ${formatDuration(result.duration)}` : ""}`
      : null;

  if (result.usedOriginal) {
    return `ℹ️ Sending your original (${formatMb(result.sourceBytes)}): ${result.reason}.${size ? `\n${size}` : ""}`;
  }

  if (conversion.kind === "gif") {
    const limit = conversion.maxSeconds ?? 0;
    const whole = (result.duration ?? 0) <= limit;
    const part = whole ? "Whole video" : `First ${Math.trunc(limit)} seconds`;
    return (
      `✅ GIF, ${formatMb(result.outputBytes)} (video was ${formatMb(result.sourceBytes)})\n` +
      `${part} · up to 480px`
    );
  }

  if (conversion.kind === "audio") {
    return (
      `✅ ${conversion.title}, ${formatMb(result.outputBytes)} ` +
      `(video was ${formatMb(result.sourceBytes)})\n${formatDuration(result.duration ?? 0)}`
    );
  }

  const change =
    result.savedPercent >= 0 ? `${Math.round(result.savedPercent)}% smaller` : `${Math.round(-result.savedPercent)}% bigger`;
  return (
    `✅ ${formatMb(result.outputBytes)} (was ${formatMb(result.sourceBytes)}, ${change})\n` +
    `${size ? `${size} · ` : ""}${videoDepth(conversion, result.isHdr)}`
  );
}

/**
 * How the sent file is encoded. The app does not record the output's bit depth, so HEVC is
 * described by its HDR flag alone, as it has always been.
 */
function videoDepth(conversion: Conversion, sourceIsHdr: boolean): string {
  if (conversion.codec === "h264") return "H.264 8-bit" + (sourceIsHdr ? " · HDR converted to SDR" : "");
  return sourceIsHdr ? "HEVC 10-bit HDR" : "HEVC";
}
