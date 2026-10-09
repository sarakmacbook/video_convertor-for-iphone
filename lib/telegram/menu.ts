/**
 * The conversion menu: the buttons offered under a video, one per conversion.
 *
 * Button data is `conv:<key>` (see `lib/conversions.ts`), which is well under Telegram's 64-byte
 * limit, so no file id or token has to travel with a button.
 */

import { callbackData, CHOICE_LAYOUT, CONVERSIONS, getConversion } from "@/lib/conversions";

import type { InlineKeyboardMarkup } from "./api";

export function choiceKeyboard(): InlineKeyboardMarkup {
  const byKey = new Map(CONVERSIONS.map((conversion) => [conversion.key, conversion]));
  return {
    inline_keyboard: CHOICE_LAYOUT.map((row) =>
      row.map((key) => {
        const conversion = byKey.get(key) ?? getConversion(key);
        return { text: conversion.button, callback_data: callbackData(conversion.key) };
      }),
    ),
  };
}

/** No rows at all: removes the buttons from a message that is now a status message. */
export const NO_BUTTONS: InlineKeyboardMarkup = { inline_keyboard: [] };
