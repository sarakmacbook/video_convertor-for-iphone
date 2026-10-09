/**
 * Sending a finished file to Telegram in the form each conversion calls for: a video, a GIF
 * (as an animation), audio, or the original as a document. Shared by the webhook and the
 * `npm run worker` CLI, so both send a result the same way.
 */

import type { Conversion } from "@/lib/conversions";

import type { TelegramClient } from "./api";

export interface SendResultOptions {
  chatId: number;
  filePath: string;
  conversion: Conversion;
  usedOriginal: boolean;
  caption: string;
  replyToMessageId?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export async function sendResult(client: TelegramClient, options: SendResultOptions): Promise<void> {
  const common = {
    caption: options.caption,
    replyToMessageId: options.replyToMessageId ?? undefined,
  };
  if (options.usedOriginal) {
    await client.sendDocument(options.chatId, options.filePath, common);
    return;
  }

  const { conversion } = options;
  if (conversion.kind === "gif") {
    await client.sendAnimation(options.chatId, options.filePath, {
      ...common,
      width: options.width,
      height: options.height,
      duration: options.duration,
    });
    return;
  }
  if (conversion.kind === "audio") {
    await client.sendAudio(options.chatId, options.filePath, {
      ...common,
      duration: options.duration,
      contentType: conversion.mimeType,
    });
    return;
  }
  await client.sendVideo(options.chatId, options.filePath, {
    ...common,
    width: options.width,
    height: options.height,
    duration: options.duration,
  });
}
