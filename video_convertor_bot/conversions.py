"""What a user can ask for after sending a video, and how each choice is named and sent.

The list is shared by the Telegram bot and by the converter worker, and it is mirrored in
`lib/conversions.ts` for the Next.js webhook. Keep the two in step: the keys travel inside
Telegram button data and inside job records, so they must match on both sides.
"""

from __future__ import annotations

from dataclasses import dataclass

CALLBACK_PREFIX = "conv:"  # Telegram button data is "conv:<key>", well under the 64-byte limit

GIF_MAX_SECONDS = 10  # a GIF of a whole clip is huge; the first few seconds are what people share
GIF_MAX_SIDE = 480  # longest side of a GIF, in pixels


@dataclass(frozen=True)
class Conversion:
    key: str
    button: str  # the label on the button
    title: str  # how the caption names the result, e.g. "HEVC" or "GIF"
    kind: str  # "video", "gif" or "audio": decides how Telegram receives the file
    codec: str  # the codec written to the file: hevc, h264, gif, aac or mp3
    extension: str  # ".mp4", ".gif", ".m4a" or ".mp3"
    mime_type: str
    name_suffix: str  # added to the file name, e.g. IMG_1234_small.mp4
    short_side: int | None = None  # video only: the shorter side is limited to this (never upscaled)
    max_seconds: float | None = None  # GIF only: only this much of the video is used
    # Smaller-file conversions fall back to the original when the result is not smaller. Format
    # conversions always deliver what was asked for, because the user chose the format.
    keeps_original_if_larger: bool = False


CONVERSIONS: tuple[Conversion, ...] = (
    Conversion(
        key="hevc",
        button="🗜 Smaller (HEVC)",
        title="HEVC",
        kind="video",
        codec="hevc",
        extension=".mp4",
        mime_type="video/mp4",
        name_suffix="_small",
        keeps_original_if_larger=True,
    ),
    Conversion(
        key="hevc720",
        button="📐 720p",
        title="HEVC 720p",
        kind="video",
        codec="hevc",
        extension=".mp4",
        mime_type="video/mp4",
        name_suffix="_720p",
        short_side=720,
        keeps_original_if_larger=True,
    ),
    Conversion(
        key="hevc480",
        button="📐 480p",
        title="HEVC 480p",
        kind="video",
        codec="hevc",
        extension=".mp4",
        mime_type="video/mp4",
        name_suffix="_480p",
        short_side=480,
        keeps_original_if_larger=True,
    ),
    Conversion(
        key="h264",
        button="📱 MP4 (H.264)",
        title="H.264",
        kind="video",
        codec="h264",
        extension=".mp4",
        mime_type="video/mp4",
        name_suffix="_h264",
    ),
    Conversion(
        key="gif",
        button="🎞 GIF",
        title="GIF",
        kind="gif",
        codec="gif",
        extension=".gif",
        mime_type="image/gif",
        name_suffix="_gif",
        max_seconds=GIF_MAX_SECONDS,
    ),
    Conversion(
        key="m4a",
        button="🎵 Audio (M4A)",
        title="M4A audio",
        kind="audio",
        codec="aac",
        extension=".m4a",
        mime_type="audio/mp4",
        name_suffix="_audio",
    ),
    Conversion(
        key="mp3",
        button="🎵 Audio (MP3)",
        title="MP3 audio",
        kind="audio",
        codec="mp3",
        extension=".mp3",
        mime_type="audio/mpeg",
        name_suffix="_audio",
    ),
)

DEFAULT_CONVERSION_KEY = "hevc"
_BY_KEY = {conversion.key: conversion for conversion in CONVERSIONS}
DEFAULT_CONVERSION = _BY_KEY[DEFAULT_CONVERSION_KEY]


def get_conversion(key: str | None) -> Conversion:
    """The conversion for a key; an unknown or missing key means the default (smaller HEVC)."""
    if not key:
        return DEFAULT_CONVERSION
    try:
        return _BY_KEY[key]
    except KeyError as exc:
        raise ValueError(f"unknown conversion {key!r}") from exc


def callback_data(key: str) -> str:
    return f"{CALLBACK_PREFIX}{key}"


def key_from_callback(data: str | None) -> str | None:
    """The conversion key in a button's data, or None if the button is not one of ours."""
    if not data or not data.startswith(CALLBACK_PREFIX):
        return None
    key = data[len(CALLBACK_PREFIX) :]
    return key if key in _BY_KEY else None


def effective_seconds(conversion: Conversion, duration: float) -> float:
    """How much of the source ends up in the output (used for progress and checks)."""
    if conversion.max_seconds is not None:
        return min(duration, conversion.max_seconds)
    return duration
