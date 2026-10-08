"""Unit tests for ffprobe parsing, the encode command, progress and output checks (no ffmpeg needed)."""

import copy
import json
from pathlib import Path

import pytest

from video_convertor_bot.media import (
    EncodeOptions,
    VideoInfo,
    build_encode_command,
    missing_tools,
    parse_probe,
    parse_progress_fraction,
    verify_output,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def iphone_probe():
    return json.loads((FIXTURES / "iphone_like_portrait_probe.json").read_text())


@pytest.fixture
def iphone_info(iphone_probe):
    return parse_probe(iphone_probe)


OPTS = EncodeOptions(ffmpeg="ffmpeg", ffprobe="ffprobe", crf=20, preset="medium")


# --- parse_probe ------------------------------------------------------------


def test_parses_an_iphone_style_probe(iphone_info):
    info = iphone_info
    assert info.has_video
    assert info.codec == "hevc"
    assert (info.width, info.height) == (1920, 1080)
    assert info.rotation == 90
    assert (info.display_width, info.display_height) == (1080, 1920)
    assert info.bit_depth == 10
    assert info.pix_fmt == "yuv420p10le"
    assert info.fps == 30.0
    assert info.duration == pytest.approx(6.0)
    assert info.audio_codec == "aac"
    assert info.is_hdr
    assert info.color_transfer == "arib-std-b67"
    assert info.color_primaries == "bt2020"
    assert info.color_space == "bt2020nc"
    assert info.color_range == "tv"


def test_negative_rotation_is_normalised(iphone_probe):
    data = copy.deepcopy(iphone_probe)
    data["streams"][0]["side_data_list"][0]["rotation"] = -90
    assert parse_probe(data).rotation == 270


def test_cover_art_is_not_mistaken_for_the_video(iphone_probe):
    data = copy.deepcopy(iphone_probe)
    cover = {"index": 0, "codec_type": "video", "codec_name": "mjpeg", "width": 300, "height": 300,
             "disposition": {"attached_pic": 1}}
    data["streams"].insert(0, cover)
    info = parse_probe(data)
    assert info.codec == "hevc"


def test_audio_only_file_has_no_video():
    info = parse_probe({"streams": [{"index": 0, "codec_type": "audio", "codec_name": "aac"}],
                        "format": {"duration": "3.0"}})
    assert not info.has_video
    assert info.audio_codec == "aac"


def test_bit_depth_falls_back_to_pixel_format():
    base = {"codec_type": "video", "codec_name": "hevc", "width": 2, "height": 2}
    ten = parse_probe({"streams": [{**base, "pix_fmt": "yuv420p10le"}]})
    eight = parse_probe({"streams": [{**base, "pix_fmt": "yuv420p"}]})
    assert ten.bit_depth == 10
    assert eight.bit_depth == 8


def test_frame_rate_handles_ntsc_and_unknown():
    base = {"codec_type": "video", "codec_name": "h264", "width": 2, "height": 2}
    ntsc = parse_probe({"streams": [{**base, "avg_frame_rate": "30000/1001"}]})
    unknown = parse_probe({"streams": [{**base, "avg_frame_rate": "0/0", "r_frame_rate": "0/0"}]})
    assert ntsc.fps == pytest.approx(29.97, abs=0.01)
    assert unknown.fps is None


def test_unknown_colour_tags_are_dropped():
    base = {"codec_type": "video", "codec_name": "h264", "width": 2, "height": 2,
            "color_space": "unknown", "color_transfer": "unknown"}
    info = parse_probe({"streams": [base]})
    assert info.color_space is None
    assert info.color_transfer is None
    assert not info.is_hdr


# --- build_encode_command ---------------------------------------------------


def _cmd(info: VideoInfo, opts=OPTS):
    return build_encode_command(Path("in.mov"), Path("/tmp/out/out.mp4"), info, opts)


def test_command_keeps_resolution_rate_depth_and_colour(iphone_info):
    cmd = _cmd(iphone_info)
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-c:v") + 1] == "libx265"
    assert cmd[cmd.index("-crf") + 1] == "20"
    assert cmd[cmd.index("-preset") + 1] == "medium"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p10le"
    assert cmd[cmd.index("-tag:v") + 1] == "hvc1"
    assert cmd[cmd.index("-fps_mode") + 1] == "passthrough"
    assert "-vf" not in cmd and "-r" not in cmd and "-s" not in cmd  # never scales or resamples
    assert cmd[cmd.index("-color_trc") + 1] == "arib-std-b67"
    assert cmd[cmd.index("-color_primaries") + 1] == "bt2020"
    assert cmd[cmd.index("-colorspace") + 1] == "bt2020nc"
    assert cmd[cmd.index("-color_range") + 1] == "tv"


def test_command_takes_the_real_video_and_first_audio_and_keeps_metadata(iphone_info):
    cmd = _cmd(iphone_info)
    maps = [cmd[i + 1] for i, token in enumerate(cmd) if token == "-map"]
    assert maps == ["0:V:0", "0:a:0?"]
    assert "-map_metadata" in cmd and cmd[cmd.index("-map_metadata") + 1] == "0"
    assert "+use_metadata_tags" in cmd[cmd.index("-movflags") + 1]
    assert cmd[-1] == "/tmp/out/out.mp4"


def test_aac_audio_is_copied_bit_for_bit(iphone_info):
    cmd = _cmd(iphone_info)
    assert cmd[cmd.index("-c:a") + 1] == "copy"


def test_non_aac_audio_is_reencoded_to_aac(iphone_info):
    info = VideoInfo(**{**iphone_info.__dict__, "audio_codec": "pcm_s16le"})
    cmd = _cmd(info)
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-b:a") + 1] == "256k"


def test_no_audio_means_no_audio_flags(iphone_info):
    info = VideoInfo(**{**iphone_info.__dict__, "audio_codec": None})
    assert "-c:a" not in _cmd(info)


def test_eight_bit_sources_stay_eight_bit(iphone_info):
    info = VideoInfo(**{**iphone_info.__dict__, "bit_depth": 8, "color_transfer": None})
    cmd = _cmd(info)
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert "-color_trc" not in cmd


def test_quality_setting_is_passed_through(iphone_info):
    cmd = _cmd(iphone_info, EncodeOptions(crf=18, preset="slow"))
    assert cmd[cmd.index("-crf") + 1] == "18"
    assert cmd[cmd.index("-preset") + 1] == "slow"


def test_command_refuses_a_file_without_video():
    with pytest.raises(Exception, match="no video"):
        _cmd(VideoInfo())


# --- progress ----------------------------------------------------------------


@pytest.mark.parametrize(
    "line,duration,expected",
    [
        ("out_time_us=3000000", 6.0, 0.5),
        ("out_time_ms=1500000", 6.0, 0.25),
        ("out_time_us=99000000", 6.0, 1.0),  # never above 100%
        ("out_time_us=N/A", 6.0, None),
        ("progress=continue", 6.0, None),
        ("out_time_us=1000", 0.0, None),  # unknown duration: no progress
        ("garbage", 6.0, None),
    ],
)
def test_progress_fraction(line, duration, expected):
    result = parse_progress_fraction(line, duration)
    if expected is None:
        assert result is None
    else:
        assert result == pytest.approx(expected)


# --- verify_output -----------------------------------------------------------


def test_identical_output_passes(iphone_info):
    assert verify_output(iphone_info, iphone_info) == []


def _changed(info, **kwargs):
    return VideoInfo(**{**info.__dict__, **kwargs})


def test_detects_resolution_change(iphone_info):
    problems = verify_output(iphone_info, _changed(iphone_info, width=1280, height=720))
    assert any("resolution changed" in p for p in problems)


def test_orientation_is_compared_as_displayed(iphone_info):
    # Same pixels but rotated to 0 degrees: display size is equal, so this must pass.
    rotated_out = _changed(iphone_info, width=1080, height=1920, rotation=0)
    assert verify_output(iphone_info, rotated_out) == []


def test_detects_wrong_codec_duration_fps_depth_colour_and_audio(iphone_info):
    cases = {
        "codec is": _changed(iphone_info, codec="h264"),
        "duration changed": _changed(iphone_info, duration=3.0),
        "frame rate changed": _changed(iphone_info, fps=25.0),
        "bit depth dropped": _changed(iphone_info, bit_depth=8),
        "colour transfer changed": _changed(iphone_info, color_transfer="bt709"),
        "audio track missing": _changed(iphone_info, audio_codec=None),
    }
    for expected, out in cases.items():
        problems = verify_output(iphone_info, out)
        assert any(expected in p for p in problems), (expected, problems)


def test_missing_video_in_output_is_a_problem(iphone_info):
    assert verify_output(iphone_info, VideoInfo()) == ["converted file has no video"]


# --- tools -------------------------------------------------------------------


def test_missing_ffmpeg_is_reported_with_install_hint():
    problems = missing_tools(EncodeOptions(ffmpeg="/nonexistent/ffmpeg-xyz", ffprobe="/nonexistent/ffprobe-xyz"))
    assert len(problems) == 2
    assert "brew install ffmpeg" in problems[0]


def test_missing_libx265_is_reported_at_startup(tmp_path):
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\necho ' V....D libx264  H.264 encoder'\n")
    fake.chmod(0o755)
    probe = tmp_path / "ffprobe"
    probe.write_text("#!/bin/sh\nexit 0\n")
    probe.chmod(0o755)
    problems = missing_tools(EncodeOptions(ffmpeg=str(fake), ffprobe=str(probe)))
    assert problems and "no libx265" in problems[0]


def test_failed_encode_reports_the_exit_code_and_log(tmp_path):
    import asyncio

    from video_convertor_bot.media import EncodeError, run_encode

    script = "echo 'Unknown encoder xyz' >&2; exit 3"
    with pytest.raises(EncodeError, match="exited with code 3: .*Unknown encoder xyz"):
        asyncio.run(
            run_encode(
                ["sh", "-c", script],
                duration=1.0,
                timeout_seconds=30,
                log_path=tmp_path / "ffmpeg.log",
            )
        )
