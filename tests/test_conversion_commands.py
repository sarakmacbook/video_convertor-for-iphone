"""The ffmpeg command for each conversion, and the checks on each result (no ffmpeg needed)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from video_convertor_bot.conversions import GIF_MAX_SECONDS, get_conversion
from video_convertor_bot.media import (
    EncodeOptions,
    NoAudioError,
    VideoInfo,
    build_convert_command,
    parse_probe,
    verify_output,
)

FIXTURES = Path(__file__).parent / "fixtures"
OPTS = EncodeOptions(ffmpeg="ffmpeg", ffprobe="ffprobe", crf=20, preset="medium")


@pytest.fixture
def iphone_info():
    return parse_probe(json.loads((FIXTURES / "iphone_like_portrait_probe.json").read_text()))


def _cmd(info: VideoInfo, key: str) -> list[str]:
    return build_convert_command(Path("in.mov"), Path("/tmp/out/out.mp4"), info, OPTS, get_conversion(key))


def _value(cmd: list[str], flag: str) -> str:
    return cmd[cmd.index(flag) + 1]


def _sdr(info: VideoInfo) -> VideoInfo:
    return replace(info, bit_depth=8, color_primaries="bt709", color_transfer="bt709", color_space="bt709")


# --- commands ---------------------------------------------------------------


def test_default_conversion_is_the_unchanged_hevc_command(iphone_info):
    cmd = _cmd(iphone_info, "hevc")
    assert _value(cmd, "-c:v") == "libx265"
    assert _value(cmd, "-tag:v") == "hvc1"
    assert "-vf" not in cmd  # full resolution: nothing is scaled
    assert _value(cmd, "-pix_fmt") == "yuv420p10le"


@pytest.mark.parametrize("key, short", [("hevc720", 720), ("hevc480", 480)])
def test_resize_limits_the_shorter_side_and_keeps_hevc(iphone_info, key, short):
    cmd = _cmd(iphone_info, key)
    assert _value(cmd, "-c:v") == "libx265"
    scale = _value(cmd, "-vf")
    assert scale.startswith("scale=") and f"min(iw,{short})" in scale and f"min(ih,{short})" in scale
    assert "-fps_mode" in cmd and _value(cmd, "-fps_mode") == "passthrough"


def test_h264_is_8_bit_yuv420p_without_the_hevc_tag(iphone_info):
    cmd = _cmd(iphone_info, "h264")
    assert _value(cmd, "-c:v") == "libx264"
    assert _value(cmd, "-pix_fmt") == "yuv420p"
    assert "-tag:v" not in cmd and "-x265-params" not in cmd


def test_h264_tone_maps_an_hdr_source_and_labels_it_sdr(iphone_info):
    cmd = _cmd(iphone_info, "h264")
    chain = _value(cmd, "-vf")
    assert "tonemap" in chain and "zscale" in chain
    assert _value(cmd, "-color_trc") == "bt709"
    assert _value(cmd, "-color_primaries") == "bt709"


def test_h264_of_an_sdr_source_is_not_tone_mapped():
    info = _sdr(parse_probe(json.loads((FIXTURES / "iphone_like_portrait_probe.json").read_text())))
    cmd = _cmd(info, "h264")
    assert "-vf" not in cmd  # no scaling and no tone mapping needed


def test_gif_is_palette_based_short_and_without_audio(iphone_info):
    cmd = _cmd(iphone_info, "gif")
    graph = _value(cmd, "-filter_complex")
    assert "palettegen" in graph and "paletteuse" in graph
    assert "min(iw,480)" in graph or "min(ih,480)" in graph
    assert _value(cmd, "-t") == str(GIF_MAX_SECONDS)
    assert "-an" in cmd
    assert "-map" not in cmd  # the graph provides the only output


def test_m4a_copies_aac_and_drops_the_picture(iphone_info):
    cmd = _cmd(iphone_info, "m4a")
    assert "-vn" in cmd
    assert _value(cmd, "-c:a") == "copy"  # iPhone audio is AAC: no quality loss at all
    assert _value(cmd, "-map") == "0:a:0"


def test_m4a_reencodes_other_audio_to_aac(iphone_info):
    cmd = _cmd(replace(iphone_info, audio_codec="opus"), "m4a")
    assert _value(cmd, "-c:a") == "aac"


def test_mp3_uses_libmp3lame(iphone_info):
    cmd = _cmd(iphone_info, "mp3")
    assert "-vn" in cmd
    assert _value(cmd, "-c:a") == "libmp3lame"


def test_audio_needs_a_sound_track(iphone_info):
    with pytest.raises(NoAudioError):
        _cmd(replace(iphone_info, audio_codec=None), "m4a")


# --- checks -----------------------------------------------------------------


def test_resize_passes_when_the_shorter_side_is_the_limit(iphone_info):
    # The portrait clip is 720x1280 displayed. 480p means 480x854.
    out = replace(iphone_info, width=854, height=480, rotation=90, codec="hevc")
    assert verify_output(iphone_info, out, get_conversion("hevc480")) == []


def test_resize_detects_a_wrong_size_or_a_changed_shape(iphone_info):
    too_big = replace(iphone_info, width=1280, height=720, rotation=90, codec="hevc")
    problems = verify_output(iphone_info, too_big, get_conversion("hevc480"))
    assert any("shorter side" in p for p in problems)

    squashed = replace(iphone_info, width=480, height=480, rotation=0, codec="hevc")
    problems = verify_output(iphone_info, squashed, get_conversion("hevc480"))
    assert any("picture shape changed" in p for p in problems)


def test_h264_check_expects_h264_and_allows_the_colour_change(iphone_info):
    out = _sdr(replace(iphone_info, codec="h264", pix_fmt="yuv420p"))
    assert verify_output(iphone_info, out, get_conversion("h264")) == []
    assert any("expected h264" in p for p in verify_output(iphone_info, replace(out, codec="hevc"), get_conversion("h264")))


def test_gif_check_wants_a_gif_within_the_size_limit():
    gif = VideoInfo(codec="gif", width=270, height=480, duration=10.0)
    assert verify_output(VideoInfo(duration=20), gif, get_conversion("gif")) == []
    assert any("expected gif" in p for p in verify_output(VideoInfo(duration=20), VideoInfo(codec="hevc", width=270, height=480), get_conversion("gif")))
    assert any("larger than" in p for p in verify_output(VideoInfo(duration=20), replace(gif, width=1080, height=1920), get_conversion("gif")))


def test_audio_check_wants_the_right_codec_and_length():
    source = VideoInfo(duration=60.0, audio_codec="aac")
    m4a = VideoInfo(duration=60.1, audio_codec="aac")
    assert verify_output(source, m4a, get_conversion("m4a")) == []
    assert any("expected mp3" in p for p in verify_output(source, m4a, get_conversion("mp3")))
    assert any("duration changed" in p for p in verify_output(source, VideoInfo(duration=30, audio_codec="aac"), get_conversion("m4a")))
