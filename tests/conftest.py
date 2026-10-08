"""Shared fixtures: ffmpeg tools and small sample clips that look like iPhone recordings."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from tests.helpers import CLIP_CREATED, CLIP_LOCATION, run_ffmpeg
from video_convertor_bot.media import EncodeOptions, missing_tools



def _find(name: str, env_var: str) -> str | None:
    return os.environ.get(env_var) or shutil.which(name)


@pytest.fixture(scope="session")
def ffmpeg_opts() -> EncodeOptions:
    ffmpeg = _find("ffmpeg", "FFMPEG_BIN")
    ffprobe = _find("ffprobe", "FFPROBE_BIN")
    if not ffmpeg or not ffprobe:
        pytest.skip("ffmpeg and ffprobe are needed for these tests")
    opts = EncodeOptions(ffmpeg=ffmpeg, ffprobe=ffprobe, crf=20, preset="medium", timeout_seconds=600)
    problems = missing_tools(opts)
    if problems:
        pytest.skip("; ".join(problems))
    return opts


@pytest.fixture(scope="session")
def clips(ffmpeg_opts: EncodeOptions, tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """Sample videos. The encodes here use the fast preset: the source quality does not matter."""
    out = tmp_path_factory.mktemp("clips")
    testsrc = "testsrc2=size=1280x720:rate=30:duration=2"
    tone = "sine=frequency=440:sample_rate=48000:duration=2"
    noisy = "[0:v]noise=alls=6:allf=t+u,format=yuv420p10le[v]"

    # iPhone-style portrait HDR clip: 10-bit HEVC, HLG colour tags, AAC audio, GPS and date,
    # and a rotation matrix (portrait recordings are stored landscape + rotation).
    base = out / "base.mov"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", testsrc,
        "-f", "lavfi", "-i", tone,
        "-filter_complex", noisy,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "18", "-x265-params", "log-level=error",
        "-tag:v", "hvc1",
        "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
        "-c:a", "aac", "-b:a", "192k",
        str(base),
    )  # fmt: skip
    portrait = out / "iphone_portrait_hdr.mov"
    run_ffmpeg(
        ffmpeg_opts,
        "-display_rotation:v:0", "90", "-i", str(base),
        "-c", "copy",
        "-metadata", f"creation_time={CLIP_CREATED}",
        "-metadata", f"location={CLIP_LOCATION}",
        str(portrait),
    )  # fmt: skip

    # Older-style 8-bit H.264 landscape clip with AAC.
    h264 = out / "h264_landscape.mp4"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2",
        "-f", "lavfi", "-i", tone,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
        str(h264),
    )  # fmt: skip

    # Video with no audio track at all.
    silent = out / "silent_hevc.mov"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "20", "-x265-params", "log-level=error",
        "-an", str(silent),
    )  # fmt: skip

    # Audio only: not a video.
    audio_only = out / "audio_only.m4a"
    run_ffmpeg(ffmpeg_opts, "-f", "lavfi", "-i", tone, "-c:a", "aac", str(audio_only))

    # Already very compressed: re-encoding at CRF 20 would make this bigger, so the original should win.
    tiny = out / "already_tiny.mp4"
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "45", "-x265-params", "log-level=error",
        "-tag:v", "hvc1", "-an", str(tiny),
    )  # fmt: skip

    return {
        "portrait": portrait,
        "h264": h264,
        "silent": silent,
        "audio_only": audio_only,
        "tiny": tiny,
    }
