"""Every conversion, run for real through ffmpeg on the sample clips."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tests.helpers import run_ffmpeg
from video_convertor_bot.conversions import get_conversion
from video_convertor_bot.media import EncodeOptions, NoAudioError, probe
from video_convertor_bot.pipeline import convert_video


def _convert(opts: EncodeOptions, src: Path, work: Path, key: str):
    conversion = get_conversion(key)
    out_name = f"out{conversion.name_suffix}{conversion.extension}"
    return asyncio.run(convert_video(src, work, out_name, opts, conversion=conversion))


@pytest.fixture(scope="session")
def fhd_clip(ffmpeg_opts: EncodeOptions, tmp_path_factory) -> Path:
    """A 1080p landscape clip, so that the 720p and 480p limits have something to do."""
    path = tmp_path_factory.mktemp("fhd") / "fhd.mp4"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(path),
    )  # fmt: skip
    return path


def test_720p_scales_a_1080p_clip_down_to_720_lines(ffmpeg_opts, fhd_clip, tmp_path):
    result = _convert(ffmpeg_opts, fhd_clip, tmp_path, "hevc720")
    assert not result.used_original
    assert (result.output.display_width, result.output.display_height) == (1280, 720)
    assert result.output.codec == "hevc"


def test_480p_scales_a_1080p_clip_down_to_480_lines(ffmpeg_opts, fhd_clip, tmp_path):
    result = _convert(ffmpeg_opts, fhd_clip, tmp_path, "hevc480")
    assert (result.output.display_width, result.output.display_height) == (854, 480)


def test_720p_never_upscales_a_smaller_clip(ffmpeg_opts, clips, tmp_path):
    # The portrait clip's shorter side is already 720, so 720p changes nothing about its size.
    result = _convert(ffmpeg_opts, clips["portrait"], tmp_path, "hevc720")
    assert (result.output.display_width, result.output.display_height) == (720, 1280)


def test_mp4_for_any_device_is_8_bit_h264(ffmpeg_opts, clips, tmp_path):
    result = _convert(ffmpeg_opts, clips["portrait"], tmp_path, "h264")
    assert not result.used_original  # the user asked for this format: it is always sent
    assert result.output.codec == "h264"
    assert result.output.bit_depth == 8
    assert (result.output.display_width, result.output.display_height) == (720, 1280)
    assert result.output.rotation == 0
    assert result.output_path.suffix == ".mp4"


def test_gif_is_an_animated_gif_of_at_most_ten_seconds(ffmpeg_opts, clips, tmp_path):
    result = _convert(ffmpeg_opts, clips["portrait"], tmp_path, "gif")
    assert result.output_path.suffix == ".gif"
    assert result.output_path.read_bytes().startswith(b"GIF8")
    assert result.output.codec == "gif"
    assert max(result.output.width, result.output.height) <= 480


@pytest.mark.parametrize(("key", "codec"), [("m4a", "aac"), ("mp3", "mp3")])
def test_audio_is_saved_without_any_picture(ffmpeg_opts, clips, tmp_path, key, codec):
    result = _convert(ffmpeg_opts, clips["portrait"], tmp_path, key)
    assert result.output_path.suffix == f".{key}"
    assert result.output.audio_codec == codec
    assert result.output.codec is None  # no video stream
    assert abs(result.output.duration - result.source.duration) < 0.5


def test_a_video_without_sound_cannot_be_saved_as_audio(ffmpeg_opts, clips, tmp_path):
    with pytest.raises(NoAudioError):
        _convert(ffmpeg_opts, clips["silent"], tmp_path, "m4a")


def test_smaller_hevc_keeps_the_iphone_tags_at_each_size(ffmpeg_opts, fhd_clip, tmp_path):
    result = _convert(ffmpeg_opts, fhd_clip, tmp_path, "hevc480")
    info = asyncio.run(probe(result.output_path, ffmpeg_opts))
    assert info.audio_codec == "aac"
