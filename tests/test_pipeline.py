"""Integration tests: real ffmpeg on iPhone-like clips. These check the properties the user cares about."""

import asyncio
from pathlib import Path

import pytest

from tests.helpers import CLIP_CREATED, CLIP_LOCATION, probe_json, psnr, run_ffmpeg
from video_convertor_bot.media import EncodeOptions, EncodeTimeoutError, NotAVideoError, ProbeError, VideoInfo, parse_probe
from video_convertor_bot.pipeline import ConversionResult, convert_video, decide


def _convert(opts, src: Path, work: Path, name="out_small.mp4", progress=None) -> ConversionResult:
    return asyncio.run(convert_video(src, work, name, opts, progress=progress))


# --- decision rules (no ffmpeg) ----------------------------------------------


def test_decide_prefers_a_smaller_good_conversion():
    assert decide(1000, 600, []) == (False, "converted")


def test_decide_sends_original_when_not_smaller():
    use_original, reason = decide(1000, 1000, [])
    assert use_original and "not make this file smaller" in reason


def test_decide_sends_original_when_checks_fail():
    use_original, reason = decide(1000, 600, ["resolution changed from 1x1 to 2x2"])
    assert use_original and reason == "a safety check failed"


def test_decide_sends_original_when_no_output():
    use_original, reason = decide(1000, 0, [])
    assert use_original and "no output" in reason


def test_saved_percent_for_converted_result():
    info = VideoInfo(codec="hevc", width=2, height=2)
    result = ConversionResult(info, 1000, Path("x"), 580, False, "converted")
    assert result.saved_percent == pytest.approx(42.0)
    assert result.delivered_bytes == 580


def test_saved_percent_is_zero_for_original():
    info = VideoInfo(codec="hevc", width=2, height=2)
    result = ConversionResult(info, 1000, Path("x"), 0, True, "not smaller")
    assert result.saved_percent == 0.0
    assert result.delivered_bytes == 1000


# --- real encodes --------------------------------------------------------------


def test_iphone_portrait_hdr_clip_keeps_what_matters(ffmpeg_opts, clips, tmp_path):
    src = clips["portrait"]
    result = _convert(ffmpeg_opts, src, tmp_path)

    assert result.used_original is False, result.reason
    assert result.output_bytes < result.source_bytes

    out_path = result.output_path
    assert out_path.suffix == ".mp4" and out_path.parent.name == "out"
    info = parse_probe(probe_json(ffmpeg_opts, out_path))
    source = parse_probe(probe_json(ffmpeg_opts, src))

    # Same picture shape, frame rate, duration and HDR description.
    assert info.codec == "hevc"
    assert (info.display_width, info.display_height) == (source.display_width, source.display_height) == (720, 1280)
    assert info.rotation == 0  # rotation was applied to the pixels, not left as a tag
    assert info.fps == pytest.approx(source.fps)
    assert info.duration == pytest.approx(source.duration, abs=0.1)
    assert info.bit_depth == 10
    assert info.is_hdr
    assert (info.color_primaries, info.color_transfer, info.color_space) == ("bt2020", "arib-std-b67", "bt2020nc")

    # Sound is copied, not re-encoded.
    assert info.audio_codec == "aac"

    # Capture date and GPS location survive.
    tags = probe_json(ffmpeg_opts, out_path)["format"].get("tags", {})
    assert tags.get("location") == CLIP_LOCATION
    assert tags.get("creation_time", "").startswith(CLIP_CREATED[:19])

    # Visually lossless-ish: high PSNR against the original recording (display orientation).
    assert psnr(ffmpeg_opts, src, out_path) > 38


def test_eight_bit_h264_source_becomes_hevc_at_same_size(ffmpeg_opts, clips, tmp_path):
    src = clips["h264"]
    result = _convert(ffmpeg_opts, src, tmp_path)
    assert result.used_original is False, result.reason
    info = parse_probe(probe_json(ffmpeg_opts, result.output_path))
    assert info.codec == "hevc"
    assert info.bit_depth == 8
    assert (info.width, info.height) == (640, 360)
    assert info.rotation == 0
    assert info.audio_codec == "aac"


def test_video_without_audio_is_converted(ffmpeg_opts, clips, tmp_path):
    result = _convert(ffmpeg_opts, clips["silent"], tmp_path)
    info = parse_probe(probe_json(ffmpeg_opts, result.output_path))
    assert info.has_video
    assert info.audio_codec is None


def test_already_compressed_video_is_returned_untouched(ffmpeg_opts, clips, tmp_path):
    src = clips["tiny"]
    result = _convert(ffmpeg_opts, src, tmp_path)
    assert result.used_original is True
    assert result.output_path == src
    assert "not make this file smaller" in result.reason
    assert not (tmp_path / "out" / "out_small.mp4").exists()  # the bigger file is discarded


def test_audio_only_file_is_rejected(ffmpeg_opts, clips, tmp_path):
    with pytest.raises(NotAVideoError):
        _convert(ffmpeg_opts, clips["audio_only"], tmp_path)


def test_text_file_is_rejected_as_unreadable(ffmpeg_opts, tmp_path):
    bogus = tmp_path / "notes.mov"
    bogus.write_text("this is not a video")
    with pytest.raises(ProbeError):
        _convert(ffmpeg_opts, bogus, tmp_path / "work")


def test_progress_is_reported_in_order(ffmpeg_opts, clips, tmp_path):
    seen: list[float] = []

    async def record(fraction: float) -> None:
        seen.append(fraction)

    asyncio.run(convert_video(clips["portrait"], tmp_path, "p.mp4", ffmpeg_opts, progress=record))
    assert seen, "expected at least one progress update"
    assert seen == sorted(seen)
    assert seen[-1] <= 1.0


def test_slow_encode_is_stopped_at_the_timeout(ffmpeg_opts, clips, tmp_path):
    tight = EncodeOptions(ffmpeg=ffmpeg_opts.ffmpeg, ffprobe=ffmpeg_opts.ffprobe, crf=20, preset="slow",
                          timeout_seconds=0.05)
    with pytest.raises(EncodeTimeoutError):
        _convert(tight, clips["portrait"], tmp_path)


def test_iphone_capture_tags_survive_the_conversion(ffmpeg_opts, tmp_path):
    """iPhones store the capture date (with its UTC offset) and location as QuickTime keys."""
    src = tmp_path / "IMG_0042.mp4"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
        "-f", "lavfi", "-i", "sine=duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-movflags", "+use_metadata_tags",
        "-metadata", "com.apple.quicktime.creationdate=2026-10-01T14:00:00+0200",
        "-metadata", "com.apple.quicktime.location.ISO6709=+37.7749-122.4194/",
        "-metadata", "com.apple.quicktime.make=Apple",
        "-metadata", "com.apple.quicktime.model=iPhone 16 Pro",
        str(src),
    )  # fmt: skip
    result = _convert(ffmpeg_opts, src, tmp_path / "work")
    assert result.used_original is False, result.reason
    tags = probe_json(ffmpeg_opts, result.output_path)["format"]["tags"]
    assert tags["com.apple.quicktime.creationdate"] == "2026-10-01T14:00:00+0200"
    assert tags["com.apple.quicktime.location.ISO6709"] == "+37.7749-122.4194/"
    assert tags["com.apple.quicktime.make"] == "Apple"
    assert tags["com.apple.quicktime.model"] == "iPhone 16 Pro"
