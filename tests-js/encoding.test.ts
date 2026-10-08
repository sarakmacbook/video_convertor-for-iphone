/**
 * Unit tests for the ffmpeg layer, plus a real encode of an iPhone-style clip.
 *
 * The integration part is skipped when ffmpeg (with libx265) is not installed, the same way
 * the Python integration tests behave.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, beforeAll } from "vitest";

import {
  buildEncodeCommand,
  displayHeight,
  displayWidth,
  estimateEncodeSeconds,
  ffmpegStatus,
  hasVideo,
  parseProgressFraction,
  parseProbeJson,
  parseProbeText,
  probe,
  verifyOutput,
  type VideoInfo,
} from "@/lib/encoding/ffmpeg";
import { convertFile, decide, savedPercent } from "@/lib/encoding/pipeline";
import { describeInfo, ffmpegBinaries, makeIphoneClip, psnr } from "./helpers";

const SAMPLE_FFMPEG_INFO = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mov':
  Metadata:
    major_brand     : qt
    creation_time   : 2026-10-01T12:00:00.000000Z
    com.apple.quicktime.location.ISO6709: +37.7749-122.4194/
  Duration: 00:00:06.01, start: 0.000000, bitrate: 18234 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 18122 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
`;

const PROBE_JSON = {
  streams: [
    {
      codec_type: "video",
      codec_name: "hevc",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p10le",
      avg_frame_rate: "2997/100",
      color_primaries: "bt2020",
      color_transfer: "arib-std-b67",
      color_space: "bt2020nc",
      color_range: "tv",
      side_data_list: [{ rotation: -90 }],
    },
    { codec_type: "audio", codec_name: "aac" },
    { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 }, width: 120, height: 120 },
  ],
  format: { duration: "6.01" },
};

describe("parseProbeJson", () => {
  it("reads geometry, rotation, colour and audio, and skips cover art", () => {
    const info = parseProbeJson(PROBE_JSON);
    expect(info.codec).toBe("hevc");
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.rotation).toBe(270); // -90 is stored as 270
    expect(info.bitDepth).toBe(10);
    expect(info.fps).toBeCloseTo(29.97, 2);
    expect(info.colorTransfer).toBe("arib-std-b67");
    expect(info.audioCodec).toBe("aac");
    expect(hasVideo(info)).toBe(true);
  });
});

describe("parseProbeText", () => {
  it("reads the same facts from `ffmpeg -i` output (for builds without ffprobe)", () => {
    const info = parseProbeText(SAMPLE_FFMPEG_INFO);
    expect(info.codec).toBe("hevc");
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.rotation).toBe(270);
    expect(info.bitDepth).toBe(10);
    expect(info.colorTransfer).toBe("arib-std-b67");
    expect(info.colorPrimaries).toBe("bt2020");
    expect(info.colorSpace).toBe("bt2020nc");
    expect(info.audioCodec).toBe("aac");
    expect(info.duration).toBeCloseTo(6.01, 2);
    expect(ffmpegStatus).toBeTypeOf("function"); // keeps the import honest
  });

  it("reports no video for an audio-only file", () => {
    const info = parseProbeText("  Duration: 00:00:03.00, bitrate: 128 kb/s\n  Stream #0:0: Audio: aac, 48000 Hz");
    expect(hasVideo(info)).toBe(false);
    expect(info.audioCodec).toBe("aac");
  });
});

describe("buildEncodeCommand", () => {
  const info = parseProbeJson(PROBE_JSON);

  it("keeps quality relevant settings and Apple playback", () => {
    const cmd = buildEncodeCommand("in.mov", "out.mp4", info, { ffmpeg: "ffmpeg", crf: 20, preset: "medium" });
    const joined = cmd.join(" ");
    expect(joined).toContain("-c:v libx265");
    expect(joined).toContain("-crf 20");
    expect(joined).toContain("-preset medium");
    expect(joined).toContain("-pix_fmt yuv420p10le");
    expect(joined).toContain("-tag:v hvc1");
    expect(joined).toContain("-fps_mode passthrough");
    expect(joined).toContain("-map 0:V:0");
    expect(joined).toContain("-map 0:a:0?");
    expect(joined).toContain("-map_metadata 0");
    // HDR tags are carried over untouched.
    expect(joined).toContain("-color_primaries bt2020");
    expect(joined).toContain("-color_trc arib-std-b67");
    expect(joined).toContain("-colorspace bt2020nc");
    // Audio is copied bit-for-bit when it is AAC, as iPhones record.
    expect(joined).toContain("-c:a copy");
    expect(cmd.at(-1)).toBe("out.mp4");
  });

  it("uses 8-bit output for 8-bit sources and re-encodes non-AAC audio", () => {
    const sdr: VideoInfo = { ...info, bitDepth: 8, pixFmt: "yuv420p", audioCodec: "pcm_s16le", colorTransfer: null };
    const joined = buildEncodeCommand("in.mov", "out.mp4", sdr, { ffmpeg: "ffmpeg", crf: 18, preset: "slow" }).join(" ");
    expect(joined).toContain("-pix_fmt yuv420p ");
    expect(joined).toContain("-c:a aac -b:a 256k");
    expect(joined).not.toContain("-color_trc");
  });
});

describe("progress parsing", () => {
  it("turns ffmpeg progress lines into a fraction", () => {
    expect(parseProgressFraction("out_time_us=2000000", 4)).toBeCloseTo(0.5, 5);
    expect(parseProgressFraction("out_time_ms=4000000", 4)).toBeCloseTo(1, 5);
    expect(parseProgressFraction("out_time_us=N/A", 4)).toBeNull();
    expect(parseProgressFraction("frame=12", 4)).toBeNull();
    expect(parseProgressFraction("out_time_us=8000000", 4)).toBe(1); // clamped
  });
});

describe("verifyOutput and decide", () => {
  const source = parseProbeJson(PROBE_JSON);
  const good: VideoInfo = { ...source, codec: "hevc" };

  it("accepts a faithful conversion", () => {
    expect(verifyOutput(source, good)).toEqual([]);
  });

  it("flags a resolution change, a missing audio track and a dropped bit depth", () => {
    const problems = verifyOutput(source, { ...good, width: 1280, audioCodec: null, bitDepth: 8, colorTransfer: null });
    expect(problems.join(" ")).toContain("resolution changed");
    expect(problems.join(" ")).toContain("audio track missing");
    expect(problems.join(" ")).toContain("bit depth dropped");
    expect(problems.join(" ")).toContain("colour transfer changed");
  });

  it("prefers the original when the encode saved nothing", () => {
    expect(decide(1000, 1200, [])).toEqual([true, "re-encoding would not make this file smaller"]);
    expect(decide(1000, 0, [])).toEqual([true, "the converter produced no output"]);
    expect(decide(1000, 500, ["a safety check failed"])).toEqual([true, "a safety check failed"]);
    expect(decide(1000, 500, [])).toEqual([false, "converted"]);
    expect(savedPercent(1000, 420, false)).toBeCloseTo(58, 5);
    expect(savedPercent(1000, 0, true)).toBe(0);
  });

  it("scales the time estimate with duration, preset and resolution", () => {
    const short = estimateEncodeSeconds({ ...source, duration: 10 }, { speedFactor: 0.4 });
    const long = estimateEncodeSeconds({ ...source, duration: 100 }, { speedFactor: 0.4 });
    const fast = estimateEncodeSeconds({ ...source, duration: 100 }, { speedFactor: 0.4, preset: "fast" });
    const uhd = estimateEncodeSeconds({ ...source, duration: 100, width: 3840, height: 2160, rotation: 0 }, { speedFactor: 0.4 });
    expect(long).toBeGreaterThan(short);
    expect(fast).toBeLessThan(long);
    expect(uhd).toBeGreaterThan(long);
  });
});

describe("converting a real clip", () => {
  let bins: { ffmpeg: string; ffprobe: string | null } | null = null;
  const dir = mkdtempSync(path.join(os.tmpdir(), "video-convertor-encode-"));

  beforeAll(async () => {
    bins = await ffmpegBinaries();
  });

  it("converts a portrait HDR iPhone clip and keeps everything that matters", async () => {
    if (!bins) {
      console.warn("skipping: ffmpeg with libx265 is not installed");
      return;
    }
    const clip = makeIphoneClip(bins.ffmpeg, dir, { name: "portrait", rotation: 90, hdr: true, seconds: 2 });
    const source = await probe(clip.path, bins.ffmpeg, bins.ffprobe);
    expect(source.rotation).toBe(90);
    expect(displayWidth(source)).toBe(source.height); // rotation makes it portrait to the viewer
    expect(source.bitDepth).toBe(10);
    expect(source.colorTransfer).toBe("arib-std-b67");
    expect(source.audioCodec).toBe("aac");
    console.log(`source: ${describeInfo(source)} (${clip.bytes} bytes)`);

    const progress: number[] = [];
    const result = await convertFile(clip.path, {
      workDir: path.join(dir, "out"),
      outName: "portrait_small.mp4",
      crf: 20,
      preset: "medium",
      timeoutSeconds: 300,
      onProgress: (fraction) => {
        progress.push(fraction);
      },
    });

    expect(result.usedOriginal).toBe(false);
    expect(result.outputBytes).toBeLessThan(result.sourceBytes);
    expect(result.output).not.toBeNull();
    expect(result.output!.codec).toBe("hevc");
    // ffmpeg applies the display matrix while decoding, so the output is physically portrait
    // (same as the Python pipeline): the viewer sees the same picture, without the tag.
    expect(displayWidth(result.output!)).toBe(displayWidth(source));
    expect(displayHeight(result.output!)).toBe(displayHeight(source));
    expect(result.output!.bitDepth).toBe(10);
    expect(result.output!.colorTransfer).toBe("arib-std-b67");
    expect(result.output!.audioCodec).toBe("aac");
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeGreaterThan(0.5);

    const quality = psnr(bins.ffmpeg, clip.path, result.outputPath);
    console.log(`converted: ${describeInfo(result.output!)} — PSNR ${quality.toFixed(1)} dB`);
    expect(quality).toBeGreaterThan(35);

    // The metadata that carries capture date and GPS location survives.
    const probeAgain = await probe(result.outputPath, bins.ffmpeg, bins.ffprobe);
    expect(probeAgain.duration).toBeCloseTo(source.duration, 1);
  });

  it("returns the original when a re-encode cannot make the file smaller", async () => {
    if (!bins) return;
    // crf 0 on a tiny file: the "converted" file is still valid but much bigger, so the
    // pipeline must deliver the original untouched.
    const clip = makeIphoneClip(bins.ffmpeg, dir, { name: "tiny", seconds: 1, width: 320, height: 180, hdr: false });
    const result = await convertFile(clip.path, {
      workDir: path.join(dir, "out2"),
      outName: "tiny_small.mp4",
      crf: 0,
      preset: "veryslow",
      timeoutSeconds: 300,
    });
    expect(result.usedOriginal).toBe(true);
    expect(result.reason).toMatch(/smaller|no output|safety check/);
    // The delivered file is the original, which is still there and unchanged.
    expect(result.outputPath).toBe(clip.path);
  });

  it("reports a clear error for a file that is not a video", async () => {
    if (!bins) return;
    const bogus = path.join(dir, "notes.txt");
    writeFileSync(bogus, "this is not a video");
    await expect(
      convertFile(bogus, {
        workDir: path.join(dir, "out3"),
        outName: "x.mp4",
        crf: 20,
        preset: "medium",
        timeoutSeconds: 60,
      }),
    ).rejects.toThrow();
  });
});
