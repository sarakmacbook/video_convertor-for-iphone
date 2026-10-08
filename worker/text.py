"""The caption a worker sends back to Telegram.

Kept separate from `video_convertor_bot.bot` so the worker can run without
`python-telegram-bot` installed when it is not delivering anything itself.
"""

from __future__ import annotations


def _mb(size_bytes: int) -> str:
    return f"{size_bytes / 1_000_000:.1f} MB"


def _duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def describe_result(result) -> str:
    """The same wording the Telegram bot uses, built from a ConversionResult."""
    info = result.source
    size = f"{info.display_width}×{info.display_height} · {_duration(info.duration)}"

    if result.used_original:
        return f"ℹ️ Sending your original ({_mb(result.source_bytes)}): {result.reason}.\n{size}"

    depth = "10-bit HDR" if info.is_hdr else ("10-bit" if info.bit_depth >= 10 else "8-bit")
    return (
        f"✅ {_mb(result.output_bytes)} (was {_mb(result.source_bytes)}, "
        f"{result.saved_percent:.0f}% smaller)\n{size} · HEVC {depth}"
    )
