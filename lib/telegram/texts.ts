/**
 * The words the bot uses. Kept in the same voice as `video_convertor_bot/bot.py` so the
 * Telegram bot behaves identically whether it runs as a polling process or as this webhook.
 */

import { CLOUD_DOWNLOAD_LIMIT_MB, CLOUD_UPLOAD_LIMIT_MB } from "@/lib/settings/schema";

export const TEXT_START = [
  "👋 Send me a video and I'll make the file smaller without making it look any different.",
  "",
  "• Send it as a File (📎 → File). A normal video is compressed by Telegram before it reaches me.",
  "• Resolution, frame rate, HDR colour, sound, capture date and location are kept.",
  "• The video is re-encoded to HEVC (H.265) at a visually lossless setting.",
  "• If re-encoding would not make a file smaller, I send your original back.",
].join("\n");

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

export function describeResult(result: ResultTextInput): string {
  const size =
    result.width && result.height
      ? `${result.width}×${result.height}${result.duration ? ` · ${formatDuration(result.duration)}` : ""}`
      : null;

  if (result.usedOriginal) {
    return `ℹ️ Sending your original (${formatMb(result.sourceBytes)}): ${result.reason}.${size ? `\n${size}` : ""}`;
  }
  const depth = result.isHdr ? "10-bit HDR" : "HEVC";
  return (
    `✅ ${formatMb(result.outputBytes)} (was ${formatMb(result.sourceBytes)}, ` +
    `${Math.round(result.savedPercent)}% smaller)\n${size ? `${size} · ` : ""}HEVC ${depth}`
  );
}
