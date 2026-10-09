/**
 * A very small Telegram Bot API client: just the methods this app needs, using `fetch`.
 *
 * Works against `https://api.telegram.org` and against a self-hosted Bot API server
 * (`TELEGRAM_API_URL`), including `--local` mode, where files are also served from that host.
 */

import { openAsBlob } from "node:fs";

import { log } from "@/lib/log";
import { DEFAULT_API_URL } from "@/lib/settings/schema";

export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;
  constructor(description: string, status = 0) {
    super(description);
    this.description = description;
    this.status = status;
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramClientOptions {
  token: string;
  apiUrl?: string;
  localMode?: boolean;
}

export class TelegramClient {
  readonly token: string;
  readonly apiUrl: string;
  readonly localMode: boolean;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    this.localMode = Boolean(options.localMode);
  }

  #methodUrl(method: string): string {
    return `${this.apiUrl}/bot${this.token}/${method}`;
  }

  /** Local Bot API server file downloads do not go through the token-guarded /file route. */
  fileUrl(filePath: string): string {
    return `${this.apiUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, "")}`;
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.#methodUrl(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!payload.ok) {
      const retryAfter = payload.parameters?.retry_after;
      const description = payload.description ?? `HTTP ${response.status}`;
      // Rate limits are normal when editing progress messages; callers decide what to do.
      log.debug(`Telegram ${method} failed: ${description}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
      throw new TelegramError(description, response.status);
    }
    return payload.result as T;
  }

  /** Upload a local file. Uses multipart/form-data, the only way Telegram accepts files. */
  async callWithFile<T = Record<string, unknown>>(
    method: string,
    fileField: string,
    filePath: string,
    params: Record<string, unknown> = {},
    contentType?: string,
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const blob = await openAsBlob(filePath, contentType ? { type: contentType } : undefined);
    form.set(fileField, blob, filePath.split("/").pop() ?? "video.mp4");

    const response = await fetch(this.#methodUrl(method), { method: "POST", body: form });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!payload.ok) {
      throw new TelegramError(payload.description ?? `HTTP ${response.status}`, response.status);
    }
    return payload.result as T;
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call("getMe");
  }

  async setWebhook(options: {
    url: string;
    secretToken: string;
    allowedUpdates?: string[];
    dropPendingUpdates?: boolean;
  }): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url: options.url,
      secret_token: options.secretToken,
      // callback_query carries the button presses of the conversion menu.
      allowed_updates: options.allowedUpdates ?? ["message", "callback_query"],
      drop_pending_updates: options.dropPendingUpdates ?? false,
    });
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  async getWebhookInfo(): Promise<{
    url?: string;
    has_custom_certificate?: boolean;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    max_connections?: number;
    ip_address?: string;
  }> {
    return this.call("getWebhookInfo");
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: { messageId?: number; threadId?: number; replyMarkup?: InlineKeyboardMarkup } = {},
  ) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(options.messageId ? { reply_to_message_id: options.messageId } : {}),
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  /**
   * Replace a message's text. Pass `replyMarkup` with no rows to remove its buttons, or leave
   * it out to keep them as they are.
   */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: { replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  /** Stops the spinner on a pressed button. With `text`, Telegram shows it as a popup (or an alert). */
  async answerCallbackQuery(callbackQueryId: string, options: { text?: string; showAlert?: boolean } = {}): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.showAlert ? { show_alert: true } : {}),
    });
  }

  async sendVideo(
    chatId: number,
    filePath: string,
    options: {
      caption?: string;
      width?: number | null;
      height?: number | null;
      duration?: number | null;
      replyToMessageId?: number;
      threadId?: number;
    } = {},
  ) {
    return this.callWithFile<{ message_id: number }>("sendVideo", "video", filePath, {
      chat_id: chatId,
      caption: options.caption,
      width: options.width ?? undefined,
      height: options.height ?? undefined,
      duration: options.duration ? Math.round(options.duration) : undefined,
      supports_streaming: true,
      reply_to_message_id: options.replyToMessageId,
      message_thread_id: options.threadId,
    });
  }

  async sendDocument(
    chatId: number,
    filePath: string,
    options: { caption?: string; replyToMessageId?: number; threadId?: number } = {},
  ) {
    return this.callWithFile<{ message_id: number }>("sendDocument", "document", filePath, {
      chat_id: chatId,
      caption: options.caption,
      reply_to_message_id: options.replyToMessageId,
      message_thread_id: options.threadId,
    });
  }

  /** A GIF sent as an animation: Telegram shows it looping, the way a GIF is meant to be seen. */
  async sendAnimation(
    chatId: number,
    filePath: string,
    options: {
      caption?: string;
      width?: number | null;
      height?: number | null;
      duration?: number | null;
      replyToMessageId?: number;
      threadId?: number;
    } = {},
  ) {
    return this.callWithFile<{ message_id: number }>(
      "sendAnimation",
      "animation",
      filePath,
      {
        chat_id: chatId,
        caption: options.caption,
        width: options.width ?? undefined,
        height: options.height ?? undefined,
        duration: options.duration ? Math.round(options.duration) : undefined,
        reply_to_message_id: options.replyToMessageId,
        message_thread_id: options.threadId,
      },
      "image/gif",
    );
  }

  async sendAudio(
    chatId: number,
    filePath: string,
    options: { caption?: string; duration?: number | null; replyToMessageId?: number; threadId?: number; contentType?: string } = {},
  ) {
    return this.callWithFile<{ message_id: number }>(
      "sendAudio",
      "audio",
      filePath,
      {
        chat_id: chatId,
        caption: options.caption,
        duration: options.duration ? Math.round(options.duration) : undefined,
        reply_to_message_id: options.replyToMessageId,
        message_thread_id: options.threadId,
      },
      options.contentType,
    );
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileId });
  }

  /** Download a file Telegram sent us (used by the worker in local Bot API mode). */
  async downloadFile(fileId: string, targetPath: string): Promise<number> {
    const file = await this.getFile(fileId);
    if (!file.file_path) throw new TelegramError("Telegram did not return a file path");
    const response = await fetch(this.fileUrl(file.file_path));
    if (!response.ok || !response.body) {
      throw new TelegramError(`could not download the file (HTTP ${response.status})`, response.status);
    }
    const { createWriteStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(targetPath),
    );
    return Number(response.headers.get("content-length") ?? 0);
  }
}

export function telegramClient(options: TelegramClientOptions): TelegramClient {
  return new TelegramClient(options);
}
