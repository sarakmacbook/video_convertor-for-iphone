/**
 * Reading Telegram updates: which kind of message arrived, and what to do with it.
 */

import { CLOUD_DOWNLOAD_LIMIT_MB, MB } from "@/lib/settings/schema";

export const VIDEO_EXTENSIONS = new Set([
  ".mov",
  ".mp4",
  ".m4v",
  ".hevc",
  ".3gp",
  ".mkv",
  ".webm",
  ".avi",
  ".mpg",
  ".mpeg",
  ".ts",
  ".mts",
  ".m2ts",
]);

export interface TelegramMedia {
  fileId: string;
  fileName: string | null;
  fileSize: number;
  contentType: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  isDocument: boolean;
}

export interface ParsedUpdate {
  kind: "start" | "help" | "media" | "callback" | "other";
  chatId: number | null;
  chatType: string | null;
  userId: number | null;
  messageId: number | null;
  text: string | null;
  media: TelegramMedia | null;
  /** True for messages sent as a compressed Photo/Video, which Telegram re-encoded. */
  compressed: boolean;
  /** Set for a press on a button of the conversion menu. */
  callback: CallbackPress | null;
}

/**
 * A press on a button of the conversion menu. The menu is a reply to the video it is about, so
 * the video comes back with the press (`message.reply_to_message`): nothing has to be stored
 * between the two updates, which matters on a serverless host.
 */
export interface CallbackPress {
  id: string;
  data: string | null;
  fromId: number | null;
  /** The menu message: the bot's own message with the buttons on it. */
  menuMessageId: number;
  /** The video that the menu is about, when Telegram still has it. */
  uploadMessageId: number | null;
  upload: TelegramMedia | null;
  uploadFromId: number | null;
}

interface RawFile {
  file_id?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface RawMessage {
  message_id?: number;
  date?: number;
  text?: string;
  chat?: { id?: number; type?: string };
  from?: { id?: number; is_bot?: boolean };
  video?: RawFile;
  document?: RawFile;
  animation?: RawFile;
  audio?: RawFile;
  voice?: RawFile;
  photo?: RawFile[];
  video_note?: RawFile;
  caption?: string;
  reply_to_message?: RawMessage;
}

interface RawCallbackQuery {
  id?: string;
  data?: string;
  from?: { id?: number };
  message?: RawMessage;
}

export function parseUpdate(update: unknown): ParsedUpdate {
  const raw = (update ?? {}) as {
    message?: RawMessage;
    edited_message?: RawMessage;
    callback_query?: RawCallbackQuery;
  };
  if (raw.callback_query) return parseCallback(raw.callback_query);

  const message = raw.message ?? raw.edited_message ?? null;

  const base: ParsedUpdate = {
    kind: "other",
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    userId: message?.from?.id ?? null,
    messageId: message?.message_id ?? null,
    text: message?.text ?? null,
    media: null,
    compressed: false,
    callback: null,
  };
  if (!message) return base;

  const text = (message.text ?? "").trim();
  if (text.startsWith("/start")) return { ...base, kind: "start" };
  if (text.startsWith("/help")) return { ...base, kind: "help" };

  const found = mediaFromMessage(message);
  if (found) return { ...base, kind: "media", media: found.media, compressed: found.compressed };
  return base;
}

/** The video in a message, if it has one we can convert. A photo is never the original video. */
function mediaFromMessage(message: RawMessage): { media: TelegramMedia; compressed: boolean } | null {
  if (message.video) {
    return wrapMedia(mediaFrom(message.video, false), true);
  }
  if (message.document && looksLikeVideo(message.document)) {
    return wrapMedia(mediaFrom(message.document, true), false);
  }
  if (message.animation) {
    return wrapMedia(mediaFrom(message.animation, false), true);
  }
  if (message.video_note) {
    return wrapMedia(mediaFrom(message.video_note, false), true);
  }
  return null;
}

function wrapMedia(media: TelegramMedia | null, compressed: boolean): { media: TelegramMedia; compressed: boolean } | null {
  return media ? { media, compressed } : null;
}

function parseCallback(query: RawCallbackQuery): ParsedUpdate {
  const menu = query.message ?? null;
  const upload = menu?.reply_to_message ?? null;
  const found = upload ? mediaFromMessage(upload) : null;
  return {
    kind: "callback",
    chatId: menu?.chat?.id ?? null,
    chatType: menu?.chat?.type ?? null,
    userId: query.from?.id ?? null,
    messageId: menu?.message_id ?? null,
    text: null,
    media: null,
    compressed: false,
    callback: query.id
      ? {
          id: query.id,
          data: query.data ?? null,
          fromId: query.from?.id ?? null,
          menuMessageId: menu?.message_id ?? 0,
          uploadMessageId: upload?.message_id ?? null,
          upload: found?.media ?? null,
          uploadFromId: upload?.from?.id ?? null,
        }
      : null,
  };
}

function mediaFrom(file: RawFile, isDocument: boolean): TelegramMedia | null {
  if (!file.file_id) return null;
  return {
    fileId: file.file_id,
    fileName: file.file_name ?? null,
    fileSize: file.file_size ?? 0,
    contentType: file.mime_type ?? null,
    width: file.width ?? null,
    height: file.height ?? null,
    duration: file.duration ?? null,
    isDocument,
  };
}

export function looksLikeVideo(document: RawFile): boolean {
  if ((document.mime_type ?? "").startsWith("video/")) return true;
  const name = document.file_name ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export interface LimitCheck {
  tooLarge: boolean;
  limitMb: number;
  /** True when the reason is Telegram's cloud limit rather than this bot's own setting. */
  cloudLimit: boolean;
}

export function checkSizeLimit(
  bytes: number,
  settings: { maxInputMb: number; telegramLocalMode: boolean; telegramApiUrl: string },
): LimitCheck {
  const cloud = settings.telegramApiUrl === "https://api.telegram.org" && !settings.telegramLocalMode;
  const limitMb = settings.maxInputMb;
  if (bytes > limitMb * MB) return { tooLarge: true, limitMb, cloudLimit: false };
  if (cloud && bytes > CLOUD_DOWNLOAD_LIMIT_MB * MB) return { tooLarge: true, limitMb: CLOUD_DOWNLOAD_LIMIT_MB, cloudLimit: true };
  return { tooLarge: false, limitMb, cloudLimit: false };
}

/** Telegram's own hints about who is talking to the bot. */
export function isPrivateChat(update: ParsedUpdate): boolean {
  return update.chatType === "private";
}

export function fallbackFileName(update: ParsedUpdate): string {
  const seconds = update.messageId ?? 0;
  return `video_${seconds || "telegram"}.mp4`;
}
