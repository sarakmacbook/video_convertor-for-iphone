"""Turn one downloaded video into the file the user asked for, and check it before it is sent."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

from .conversions import DEFAULT_CONVERSION, Conversion, effective_seconds
from .media import (
    EncodeError,
    EncodeOptions,
    NotAVideoError,
    ProbeError,
    ProgressCallback,
    VideoInfo,
    build_convert_command,
    probe,
    run_encode,
    verify_output,
)

logger = logging.getLogger(__name__)

ENCODE_LOG_NAME = "ffmpeg.log"


@dataclass(frozen=True)
class ConversionResult:
    source: VideoInfo
    source_bytes: int
    output_path: Path  # the file to deliver: the converted one, or the untouched original
    output_bytes: int  # the converted file's size, or 0 when it was not used
    used_original: bool
    reason: str
    output: VideoInfo | None = None  # probe of the converted file, when one was made
    conversion: Conversion = field(default=DEFAULT_CONVERSION)

    @property
    def delivered_bytes(self) -> int:
        return self.source_bytes if self.used_original else self.output_bytes

    @property
    def saved_percent(self) -> float:
        if self.used_original or self.source_bytes <= 0:
            return 0.0
        return (1 - self.output_bytes / self.source_bytes) * 100


def decide(source_bytes: int, output_bytes: int, problems: list[str]) -> tuple[bool, str]:
    """Return (use_original, short reason for the user). The original is always a safe fallback."""
    if problems:
        return True, "a safety check failed"
    if output_bytes <= 0:
        return True, "the converter produced no output"
    if output_bytes >= source_bytes:
        return True, "re-encoding would not make this file smaller"
    return False, "converted"


async def convert_video(
    src: Path,
    work_dir: Path,
    out_name: str,
    opts: EncodeOptions,
    progress: ProgressCallback | None = None,
    conversion: Conversion = DEFAULT_CONVERSION,
) -> ConversionResult:
    """Convert `src` into `work_dir/out/<out_name>` and check the result.

    Raises ProbeError / NotAVideoError / NoAudioError / EncodeError for problems the user should
    hear about.

    For the smaller-file conversions, if the result is not clearly better (bigger, or it fails the
    checks) the original is returned instead, so the user never gets something worse than what
    they sent. Format conversions (MP4 for any device, GIF, audio) always return the converted
    file, or raise EncodeError when it fails its checks, because the user asked for that format.
    """
    source = await probe(src, opts)
    if not source.has_video:
        raise NotAVideoError("no video track found in this file")

    source_bytes = src.stat().st_size
    out_dir = work_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / out_name

    logger.info(
        "converting %dx%d %s %.1fs (%s-bit, %s, audio=%s) to %s, crf=%d preset=%s",
        source.display_width,
        source.display_height,
        source.codec,
        source.duration,
        source.bit_depth,
        "HDR" if source.is_hdr else "SDR",
        source.audio_codec,
        conversion.key,
        opts.crf,
        opts.preset,
    )
    await run_encode(
        build_convert_command(src, dst, source, opts, conversion),
        duration=effective_seconds(conversion, source.duration),
        timeout_seconds=opts.timeout_seconds,
        log_path=out_dir / ENCODE_LOG_NAME,
        on_progress=progress,
    )

    output_bytes = dst.stat().st_size if dst.exists() else 0
    output_info: VideoInfo | None = None
    problems: list[str] = []
    if output_bytes == 0:
        problems = ["no output file was written"]
    else:
        try:
            output_info = await probe(dst, opts)
            problems = verify_output(source, output_info, conversion)
        except ProbeError as exc:
            problems = [f"converted file could not be read ({exc})"]

    if problems:
        logger.warning("converted file failed checks: %s", "; ".join(problems))

    if not conversion.keeps_original_if_larger:
        if problems:
            raise EncodeError(f"the converted file failed its checks: {'; '.join(problems)}")
        logger.info("converted %d -> %d bytes as %s", source_bytes, output_bytes, conversion.key)
        return ConversionResult(
            source=source,
            source_bytes=source_bytes,
            output_path=dst,
            output_bytes=output_bytes,
            used_original=False,
            reason="converted",
            output=output_info,
            conversion=conversion,
        )

    use_original, reason = decide(source_bytes, output_bytes, problems)
    if use_original:
        logger.info("sending original: %s", reason)
        if dst.exists():
            dst.unlink()
        return ConversionResult(
            source=source,
            source_bytes=source_bytes,
            output_path=src,
            output_bytes=0,
            used_original=True,
            reason=reason,
            output=output_info,
            conversion=conversion,
        )

    logger.info(
        "converted %d -> %d bytes (%.0f%% smaller)",
        source_bytes,
        output_bytes,
        (1 - output_bytes / source_bytes) * 100 if source_bytes else 0,
    )
    return ConversionResult(
        source=source,
        source_bytes=source_bytes,
        output_path=dst,
        output_bytes=output_bytes,
        used_original=False,
        reason=reason,
        output=output_info,
        conversion=conversion,
    )
