"""Inspect videos with ffprobe and re-encode them with ffmpeg.

The encode is a HEVC (H.265) re-encode that keeps everything a viewer can see:
resolution, frame rate, orientation, 10-bit depth, HDR colour tags, the audio
stream (copied bit-for-bit when it is AAC, as iPhones record it), and the
container metadata such as capture date and GPS location.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Sequence

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[float], Awaitable[None]]

PROBE_TIMEOUT_SECONDS = 120
HDR_TRANSFERS = frozenset({"arib-std-b67", "smpte2084"})  # HLG and PQ (HDR10)


class MediaError(Exception):
    """A problem with the media that can be explained to the user."""


class NotAVideoError(MediaError):
    """The file has no usable video track."""


class ProbeError(MediaError):
    """ffprobe could not read the file."""


class EncodeError(MediaError):
    """ffmpeg failed while converting."""


class EncodeTimeoutError(EncodeError):
    """ffmpeg ran longer than the allowed time and was stopped."""


@dataclass(frozen=True)
class EncodeOptions:
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    crf: int = 20
    preset: str = "medium"
    timeout_seconds: float = 7200.0
    audio_bitrate: str = "256k"  # only used if the source audio is not AAC


@dataclass(frozen=True)
class VideoInfo:
    """The parts of an ffprobe report the bot cares about."""

    codec: str | None = None
    width: int = 0  # coded width (before rotation)
    height: int = 0  # coded height (before rotation)
    rotation: int = 0  # display rotation in degrees: 0, 90, 180 or 270
    duration: float = 0.0
    fps: float | None = None
    pix_fmt: str | None = None
    bit_depth: int = 8
    color_primaries: str | None = None
    color_transfer: str | None = None
    color_space: str | None = None
    color_range: str | None = None
    audio_codec: str | None = None

    @property
    def has_video(self) -> bool:
        return self.codec is not None and self.width > 0 and self.height > 0

    @property
    def is_rotated(self) -> bool:
        return self.rotation in (90, 270)

    @property
    def display_width(self) -> int:
        return self.height if self.is_rotated else self.width

    @property
    def display_height(self) -> int:
        return self.width if self.is_rotated else self.height

    @property
    def is_hdr(self) -> bool:
        return self.color_transfer in HDR_TRANSFERS


# --------------------------------------------------------------------------- #
# ffprobe
# --------------------------------------------------------------------------- #


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _tag(stream: Mapping[str, Any], key: str) -> str | None:
    value = stream.get(key)
    if not value or value == "unknown":
        return None
    return str(value)


def _is_cover_art(stream: Mapping[str, Any]) -> bool:
    return (stream.get("disposition") or {}).get("attached_pic") == 1


def _rotation(stream: Mapping[str, Any]) -> int:
    angle: Any = None
    for side_data in stream.get("side_data_list") or []:
        if isinstance(side_data, dict) and "rotation" in side_data:
            angle = side_data["rotation"]
            break
    if angle is None:
        angle = (stream.get("tags") or {}).get("rotate")
    value = _as_float(angle)
    if value is None:
        return 0
    normalized = int(round(value)) % 360  # -90 (iPhone portrait) -> 270
    return normalized if normalized in (0, 90, 180, 270) else 0


def _frame_rate(stream: Mapping[str, Any]) -> float | None:
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = stream.get(key)
        if not raw:
            continue
        try:
            value = float(Fraction(str(raw)))
        except (ValueError, ZeroDivisionError):
            continue
        if value > 0:
            return value
    return None


def _bit_depth(stream: Mapping[str, Any], pix_fmt: str | None) -> int:
    raw = _as_int(stream.get("bits_per_raw_sample"))
    if raw:
        return raw
    match = re.search(r"p(\d+)(le|be)$", pix_fmt or "")  # yuv420p10le -> 10
    return int(match.group(1)) if match else 8


def parse_probe(data: Mapping[str, Any]) -> VideoInfo:
    """Turn the JSON printed by `ffprobe -print_format json` into a VideoInfo."""
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)]
    fmt = data.get("format") or {}
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not _is_cover_art(s)),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = _as_float(fmt.get("duration")) or 0.0
    audio_codec = audio.get("codec_name") if audio else None

    if video is None:
        return VideoInfo(duration=duration, audio_codec=audio_codec)

    pix_fmt = video.get("pix_fmt")
    if not duration:
        duration = _as_float(video.get("duration")) or 0.0
    return VideoInfo(
        codec=video.get("codec_name"),
        width=_as_int(video.get("width")) or 0,
        height=_as_int(video.get("height")) or 0,
        rotation=_rotation(video),
        duration=duration,
        fps=_frame_rate(video),
        pix_fmt=pix_fmt,
        bit_depth=_bit_depth(video, pix_fmt),
        color_primaries=_tag(video, "color_primaries"),
        color_transfer=_tag(video, "color_transfer"),
        color_space=_tag(video, "color_space"),
        color_range=_tag(video, "color_range"),
        audio_codec=audio_codec,
    )


async def _run_capture(cmd: Sequence[str], timeout: float) -> tuple[bytes, bytes, int]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise MediaError(f"executable not found: {cmd[0]}") from exc
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError as exc:
        await _kill(proc)
        raise ProbeError("ffprobe timed out") from exc
    except BaseException:
        await _kill(proc)
        raise
    return stdout, stderr, proc.returncode or 0


async def probe(path: Path, opts: EncodeOptions) -> VideoInfo:
    """Read the streams and format of a media file."""
    cmd = [
        opts.ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    stdout, stderr, returncode = await _run_capture(cmd, PROBE_TIMEOUT_SECONDS)
    if returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip().splitlines()
        raise ProbeError(detail[-1] if detail else "ffprobe could not read the file")
    try:
        data = json.loads(stdout.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe returned unreadable output") from exc
    return parse_probe(data)


# --------------------------------------------------------------------------- #
# Encoding
# --------------------------------------------------------------------------- #


def _output_pix_fmt(info: VideoInfo) -> str:
    # Keep 10-bit for 10-bit sources (iPhone HDR). Chroma stays 4:2:0, which is
    # what iPhones and most players decode in hardware.
    return "yuv420p10le" if info.bit_depth >= 10 else "yuv420p"


def build_encode_command(src: Path, dst: Path, info: VideoInfo, opts: EncodeOptions) -> list[str]:
    """Build the ffmpeg argument list for a quality-preserving HEVC encode."""
    if not info.has_video:
        raise NotAVideoError("no video track to encode")

    cmd = [
        opts.ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        # First real video track (skips cover art) and first audio track, if any.
        "-map",
        "0:V:0",
        "-map",
        "0:a:0?",
        # Keep capture date, GPS location and other container metadata.
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        # Video: HEVC at a constant-quality setting. Resolution and frame rate are not changed.
        "-c:v",
        "libx265",
        "-preset",
        opts.preset,
        "-crf",
        str(opts.crf),
        "-pix_fmt",
        _output_pix_fmt(info),
        "-tag:v",
        "hvc1",  # lets Apple devices play the HEVC stream
        "-x265-params",
        "log-level=error",
        "-fps_mode",
        "passthrough",  # never duplicate or drop frames
    ]

    # Carry the HDR / colour description across unchanged.
    for flag, value in (
        ("-color_primaries", info.color_primaries),
        ("-color_trc", info.color_transfer),
        ("-colorspace", info.color_space),
        ("-color_range", info.color_range),
    ):
        if value:
            cmd += [flag, value]

    if info.audio_codec == "aac":
        cmd += ["-c:a", "copy"]  # bit-for-bit identical sound
    elif info.audio_codec:
        cmd += ["-c:a", "aac", "-b:a", opts.audio_bitrate]

    cmd += [
        "-movflags",
        "+faststart+use_metadata_tags",
        "-progress",
        "pipe:1",
        "-nostats",
        str(dst),
    ]
    return cmd


def parse_progress_fraction(line: str, duration: float) -> float | None:
    """Return 0..1 progress for one line of `ffmpeg -progress` output, if it carries time."""
    key, sep, value = line.strip().partition("=")
    if not sep or key not in ("out_time_us", "out_time_ms") or duration <= 0:
        return None
    if not value.isdigit():  # ffmpeg prints N/A at the very start
        return None
    # Both keys are microseconds in current ffmpeg builds.
    return min(1.0, int(value) / 1_000_000 / duration)


async def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        proc.kill()
        await proc.wait()


def _log_tail(path: Path, lines: int = 12) -> str:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return ""
    return " | ".join(text.strip().splitlines()[-lines:])


async def _pump_progress(
    proc: asyncio.subprocess.Process,
    duration: float,
    on_progress: ProgressCallback | None,
) -> None:
    last_reported = -1.0
    if proc.stdout is not None:
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            fraction = parse_progress_fraction(raw.decode("utf-8", "replace"), duration)
            if fraction is None or on_progress is None:
                continue
            if fraction - last_reported >= 0.01:
                last_reported = fraction
                await on_progress(fraction)
    await proc.wait()


async def run_encode(
    cmd: Sequence[str],
    *,
    duration: float,
    timeout_seconds: float,
    log_path: Path,
    on_progress: ProgressCallback | None = None,
) -> None:
    """Run ffmpeg, reporting progress, and raise EncodeError if it fails."""
    with log_path.open("wb") as log_file:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=log_file,
            )
        except FileNotFoundError as exc:
            raise EncodeError(f"ffmpeg not found: {cmd[0]}") from exc
        try:
            await asyncio.wait_for(_pump_progress(proc, duration, on_progress), timeout_seconds)
        except asyncio.TimeoutError as exc:
            await _kill(proc)
            raise EncodeTimeoutError(f"conversion stopped after {int(timeout_seconds)} seconds") from exc
        except BaseException:
            await _kill(proc)
            raise

    if proc.returncode != 0:
        raise EncodeError(f"ffmpeg exited with code {proc.returncode}: {_log_tail(log_path)}")


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #


def verify_output(source: VideoInfo, output: VideoInfo) -> list[str]:
    """Compare the converted file with the original. An empty list means it looks right."""
    if not output.has_video:
        return ["converted file has no video"]

    problems: list[str] = []
    if output.codec != "hevc":
        problems.append(f"codec is {output.codec}, expected hevc")
    if (output.display_width, output.display_height) != (source.display_width, source.display_height):
        problems.append(
            f"resolution changed from {source.display_width}x{source.display_height} "
            f"to {output.display_width}x{output.display_height}"
        )
    if source.duration > 0 and abs(output.duration - source.duration) > max(0.25, source.duration * 0.01):
        problems.append("duration changed")
    if source.fps and output.fps and abs(source.fps - output.fps) > 0.01:
        problems.append("frame rate changed")
    if output.bit_depth < min(source.bit_depth, 10):
        problems.append("bit depth dropped")
    if source.color_transfer and output.color_transfer != source.color_transfer:
        problems.append("colour transfer changed")
    if source.audio_codec and not output.audio_codec:
        problems.append("audio track missing")
    return problems


def missing_tools(opts: EncodeOptions) -> list[str]:
    """Return human-readable problems with the ffmpeg install, or an empty list."""
    problems: list[str] = []
    for label, exe in (("ffmpeg", opts.ffmpeg), ("ffprobe", opts.ffprobe)):
        if shutil.which(exe) is None:
            problems.append(f"{label} was not found (looked for '{exe}'). Install ffmpeg, e.g. `brew install ffmpeg`.")
    if problems:
        return problems

    try:
        result = subprocess.run(
            [opts.ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [f"could not run {opts.ffmpeg}: {exc}"]
    if "libx265" not in result.stdout:
        problems.append(
            "this ffmpeg build has no libx265 (HEVC) encoder. Install a full build, e.g. `brew install ffmpeg`."
        )
    return problems
