/**
 * The conversion catalogue, the menu, the captions and the command for each conversion.
 * Pure functions only: no ffmpeg, no Telegram, no database.
 */

import { describe, expect, it } from "vitest";

import {
  CHOICE_LAYOUT,
  CONVERSIONS,
  DEFAULT_CONVERSION,
  callbackData,
  conversionOfMeta,
  effectiveSeconds,
  getConversion,
  keyFromCallback,
} from "@/lib/conversions";
import { buildConvertCommand, buildEncodeCommand, EncodeOptions, emptyVideoInfo, NoAudioError, verifyOutput, type VideoInfo } from "@/lib/encoding/ffmpeg";
import { describeResult } from "@/lib/telegram/texts";
import { choiceKeyboard } from "@/lib/telegram/menu";
import { parseUpdate } from "@/lib/telegram/update";

const OPTS: EncodeOptions = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", crf: 20, preset: "medium", timeoutSeconds: 600 };

/** An iPhone HDR clip, portrait (rotated 90°), 1080p as stored. */
const HDR_PORTRAIT: VideoInfo = {
  ...emptyVideoInfo,
  codec: "hevc",
  width: 1920,
  height: 1080,
  rotation: 90,
  duration: 12,
  fps: 30,
  pixFmt: "yuv420p10le",
  bitDepth: 10,
  colorPrimaries: "bt2020",
  colorTransfer: "arib-std-b67",
  colorSpace: "bt2020nc",
  colorRange: "tv",
  audioCodec: "aac",
};

const SDR_AAC: VideoInfo = { ...HDR_PORTRAIT, bitDepth: 8, colorPrimaries: "bt709", colorTransfer: "bt709", colorSpace: "bt709", rotation: 0, width: 1280, height: 720, codec: "h264" };

function value(cmd: string[], flag: string): string | undefined {
  const index = cmd.indexOf(flag);
  return index >= 0 ? cmd[index + 1] : undefined;
}

describe("the catalogue", () => {
  it("has one button per conversion, and every button is in the menu layout", () => {
    const inMenu = CHOICE_LAYOUT.flat();
    expect([...inMenu].sort()).toEqual(CONVERSIONS.map((c) => c.key).sort());
    expect(new Set(inMenu).size).toBe(inMenu.length);
  });

  it("keeps every button's data well under Telegram's 64-byte limit", () => {
    for (const conversion of CONVERSIONS) {
      expect(Buffer.byteLength(callbackData(conversion.key))).toBeLessThanOrEqual(64);
    }
  });

  it("round-trips keys through button data and rejects anything else", () => {
    for (const conversion of CONVERSIONS) {
      expect(keyFromCallback(callbackData(conversion.key))).toBe(conversion.key);
    }
    expect(keyFromCallback("conv:nope")).toBeNull();
    expect(keyFromCallback("other:hevc")).toBeNull();
    expect(keyFromCallback(null)).toBeNull();
  });

  it("uses the smaller HEVC file when a job names no conversion, and rejects unknown keys", () => {
    expect(getConversion(undefined)).toBe(DEFAULT_CONVERSION);
    expect(DEFAULT_CONVERSION.key).toBe("hevc");
    expect(() => getConversion("bogus")).toThrow();
  });

  it("reads the conversion a job was created for from its meta, defaulting safely", () => {
    expect(conversionOfMeta(JSON.stringify({ conversion: "gif" })).key).toBe("gif");
    expect(conversionOfMeta(JSON.stringify({ inputSource: "telegram" })).key).toBe("hevc");
    expect(conversionOfMeta(JSON.stringify({ conversion: "bogus" })).key).toBe("hevc");
    expect(conversionOfMeta("not json").key).toBe("hevc");
    expect(conversionOfMeta(null).key).toBe("hevc");
  });

  it("limits a GIF to its first ten seconds and leaves other conversions alone", () => {
    expect(effectiveSeconds(getConversion("gif"), 60)).toBe(10);
    expect(effectiveSeconds(getConversion("gif"), 4)).toBe(4);
    expect(effectiveSeconds(getConversion("h264"), 60)).toBe(60);
  });
});

describe("the menu", () => {
  it("builds the keyboard from the layout, with each conversion's label and data", () => {
    const keyboard = choiceKeyboard();
    expect(keyboard.inline_keyboard.map((row) => row.length)).toEqual(CHOICE_LAYOUT.map((row) => row.length));
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === "conv:hevc")?.text).toBe("🗜 Smaller (HEVC)");
    expect(buttons.find((b) => b.callback_data === "conv:m4a")?.text).toBe("🎵 Audio (M4A)");
  });
});

describe("parsing a button press", () => {
  const upload = {
    message_id: 77,
    chat: { id: 555, type: "private" },
    from: { id: 555, is_bot: false },
    document: { file_id: "file_abc", file_name: "IMG_1.MOV", file_size: 1234, mime_type: "video/quicktime" },
  };

  it("finds the video the menu is about, and who sent it", () => {
    const parsed = parseUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-9",
        from: { id: 555 },
        data: "conv:gif",
        message: {
          message_id: 900,
          chat: { id: 555, type: "private" },
          from: { id: 424242, is_bot: true },
          reply_to_message: upload,
        },
      },
    });
    expect(parsed.kind).toBe("callback");
    expect(parsed.chatId).toBe(555);
    expect(parsed.callback).toMatchObject({
      id: "cb-9",
      data: "conv:gif",
      fromId: 555,
      menuMessageId: 900,
      uploadMessageId: 77,
      uploadFromId: 555,
    });
    expect(parsed.callback?.upload?.fileId).toBe("file_abc");
  });

  it("notices when Telegram no longer links the menu to a video", () => {
    const parsed = parseUpdate({
      callback_query: { id: "cb-10", from: { id: 555 }, data: "conv:hevc", message: { message_id: 900, chat: { id: 555, type: "private" } } },
    });
    expect(parsed.callback?.upload).toBeNull();
    expect(parsed.callback?.uploadMessageId).toBeNull();
  });

  it("still reads a video sent as a message", () => {
    const parsed = parseUpdate({ message: { ...upload, chat: { id: 555, type: "private" } } });
    expect(parsed.kind).toBe("media");
    expect(parsed.media?.fileId).toBe("file_abc");
    expect(parsed.callback).toBeNull();
  });
});

describe("captions", () => {
  const base = {
    usedOriginal: false,
    reason: "converted",
    sourceBytes: 20_000_000,
    outputBytes: 8_000_000,
    savedPercent: 60,
    width: 1080,
    height: 1920,
    duration: 75,
    isHdr: false,
  };

  it("names a smaller HEVC file with its size, saving and length", () => {
    const caption = describeResult({ ...base, conversion: getConversion("hevc") });
    expect(caption).toBe("✅ 8.0 MB (was 20.0 MB, 60% smaller)\n1080×1920 · 1:15 · HEVC");
  });

  it("says when H.264 has tone-mapped an HDR source", () => {
    const caption = describeResult({ ...base, conversion: getConversion("h264"), isHdr: true, savedPercent: -5 });
    expect(caption).toContain("5% bigger");
    expect(caption).toContain("H.264 8-bit · HDR converted to SDR");
  });

  it("describes a GIF as the whole video when it is short, otherwise its first ten seconds", () => {
    const gif = getConversion("gif");
    expect(describeResult({ ...base, conversion: gif, duration: 6 })).toContain("Whole video · up to 480px");
    expect(describeResult({ ...base, conversion: gif, duration: 60 })).toContain("First 10 seconds · up to 480px");
  });

  it("describes audio by its codec title and length", () => {
    const caption = describeResult({ ...base, conversion: getConversion("m4a"), outputBytes: 500_000 });
    expect(caption).toBe("✅ M4A audio, 0.5 MB (video was 20.0 MB)\n1:15");
  });

  it("explains why the original is sent instead", () => {
    const caption = describeResult({ ...base, conversion: getConversion("hevc"), usedOriginal: true, reason: "re-encoding would not make this file smaller" });
    expect(caption).toBe("ℹ️ Sending your original (20.0 MB): re-encoding would not make this file smaller.\n1080×1920 · 1:15");
  });
});

describe("the ffmpeg command for each conversion", () => {
  it("keeps the smaller HEVC command exactly as the encoder has always built it", () => {
    const cmd = buildConvertCommand("in.mov", "out.mp4", HDR_PORTRAIT, OPTS, getConversion("hevc"));
    expect(cmd).toEqual(buildEncodeCommand("in.mov", "out.mp4", HDR_PORTRAIT, OPTS));
    expect(cmd).not.toContain("-vf");
    expect(value(cmd, "-c:v")).toBe("libx265");
  });

  it("scales the shorter side for 720p and 480p, and never upscales", () => {
    for (const [key, side] of [["hevc720", 720], ["hevc480", 480]] as const) {
      const scale = value(buildConvertCommand("in.mov", "out.mp4", HDR_PORTRAIT, OPTS, getConversion(key)), "-vf");
      expect(scale).toContain(`min(iw,${side})`);
      expect(scale).toContain(`min(ih,${side})`);
    }
  });

  it("makes an 8-bit H.264 file, tone-mapping an HDR source", () => {
    const cmd = buildConvertCommand("in.mov", "out.mp4", HDR_PORTRAIT, OPTS, getConversion("h264"));
    expect(value(cmd, "-c:v")).toBe("libx264");
    expect(value(cmd, "-pix_fmt")).toBe("yuv420p");
    expect(value(cmd, "-vf")).toContain("tonemap");
    expect(value(cmd, "-color_trc")).toBe("bt709");
    expect(cmd).not.toContain("-tag:v");
  });

  it("makes a palette GIF of the first ten seconds, without sound", () => {
    const cmd = buildConvertCommand("in.mov", "out.gif", HDR_PORTRAIT, OPTS, getConversion("gif"));
    expect(value(cmd, "-filter_complex")).toContain("palettegen");
    expect(value(cmd, "-t")).toBe("10");
    expect(cmd).toContain("-an");
  });

  it("copies AAC sound to M4A, and encodes MP3 with LAME", () => {
    const m4a = buildConvertCommand("in.mov", "out.m4a", HDR_PORTRAIT, OPTS, getConversion("m4a"));
    expect(cmdHas(m4a, ["-vn", "-c:a", "copy"])).toBe(true);
    const mp3 = buildConvertCommand("in.mov", "out.mp3", HDR_PORTRAIT, OPTS, getConversion("mp3"));
    expect(value(mp3, "-c:a")).toBe("libmp3lame");
  });

  it("refuses to save audio from a video with no sound", () => {
    expect(() => buildConvertCommand("in.mov", "out.m4a", { ...HDR_PORTRAIT, audioCodec: null }, OPTS, getConversion("m4a"))).toThrow(NoAudioError);
  });
});

function cmdHas(cmd: string[], pieces: string[]): boolean {
  const joined = cmd.join(" ");
  return pieces.every((piece) => joined.includes(piece));
}

describe("checks on each conversion's result", () => {
  it("accepts a correct MP4 H.264 result and rejects one that is still HEVC", () => {
    const h264 = getConversion("h264");
    const good: VideoInfo = { ...SDR_AAC, codec: "h264", bitDepth: 8, width: 1080, height: 1920, rotation: 0 };
    expect(verifyOutput(HDR_PORTRAIT, good, h264)).toEqual([]);
    expect(verifyOutput(HDR_PORTRAIT, { ...good, codec: "hevc" }, h264)).toContain("codec is hevc, expected h264");
  });

  it("checks GIF size and codec, and audio codec and length", () => {
    expect(verifyOutput(HDR_PORTRAIT, { ...emptyVideoInfo, codec: "gif", width: 480, height: 270 }, getConversion("gif"))).toEqual([]);
    expect(verifyOutput(HDR_PORTRAIT, { ...emptyVideoInfo, codec: "gif", width: 1080, height: 1920 }, getConversion("gif")))
      .toEqual(["GIF is 1080x1920, larger than 480px"]);
    expect(verifyOutput(HDR_PORTRAIT, { ...emptyVideoInfo, audioCodec: "aac", duration: 12 }, getConversion("m4a"))).toEqual([]);
    expect(verifyOutput(HDR_PORTRAIT, { ...emptyVideoInfo, audioCodec: "aac", duration: 3 }, getConversion("m4a")))
      .toEqual(["duration changed"]);
  });
});
