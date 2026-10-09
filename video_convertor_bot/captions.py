"""The words used to describe a finished conversion, shared by the bot and the worker.

Kept free of Telegram imports so the worker can use it without python-telegram-bot installed.
"""

from __future__ import annotations

from .conversions import GIF_MAX_SIDE, Conversion
from .media import VideoInfo
from .pipeline import ConversionResult


def format_mb(size_bytes: int) -> str:
    return f"{size_bytes / 1_000_000:.1f} MB"


def format_duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _size_line(info: VideoInfo) -> str:
    return f"{info.display_width}×{info.display_height} · {format_duration(info.duration)}"


def _video_depth(shown: VideoInfo, source: VideoInfo, conversion: Conversion) -> str:
    """How the file that is sent is encoded. `shown` is the output; `source` says whether it was HDR."""
    if conversion.codec == "h264":
        return "H.264 8-bit" + (" · HDR converted to SDR" if source.is_hdr else "")
    if shown.is_hdr:
        return "HEVC 10-bit HDR"
    return "HEVC 10-bit" if shown.bit_depth >= 10 else "HEVC 8-bit"


def describe_result(result: ConversionResult) -> str:
    """The message shown under the file that is sent back."""
    conversion = result.conversion
    source = result.source

    if result.used_original:
        return f"ℹ️ Sending your original ({format_mb(result.source_bytes)}): {result.reason}.\n{_size_line(source)}"

    if conversion.kind == "gif":
        limit = conversion.max_seconds or 0
        part = "Whole video" if source.duration <= limit else f"First {int(limit)} seconds"
        return (
            f"✅ GIF, {format_mb(result.output_bytes)} (video was {format_mb(result.source_bytes)})\n"
            f"{part} · up to {GIF_MAX_SIDE}px"
        )

    if conversion.kind == "audio":
        return (
            f"✅ {conversion.title}, {format_mb(result.output_bytes)} "
            f"(video was {format_mb(result.source_bytes)})\n{format_duration(source.duration)}"
        )

    shown = result.output or source
    change = (
        f"{result.saved_percent:.0f}% smaller"
        if result.saved_percent >= 0
        else f"{-result.saved_percent:.0f}% bigger"
    )
    return (
        f"✅ {format_mb(result.output_bytes)} (was {format_mb(result.source_bytes)}, {change})\n"
        f"{_size_line(shown)} · {_video_depth(shown, source, conversion)}"
    )
