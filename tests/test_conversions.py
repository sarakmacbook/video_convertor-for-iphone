"""The conversion catalogue: keys, buttons, and what each conversion promises."""

from __future__ import annotations

from pathlib import Path

import pytest

from video_convertor_bot.conversions import (
    CONVERSIONS,
    DEFAULT_CONVERSION,
    GIF_MAX_SECONDS,
    callback_data,
    effective_seconds,
    get_conversion,
    key_from_callback,
)
from video_convertor_bot.media import VideoInfo
from video_convertor_bot.pipeline import ConversionResult


def test_keys_are_unique_and_the_default_is_the_smaller_hevc_file():
    keys = [conversion.key for conversion in CONVERSIONS]
    assert len(keys) == len(set(keys))
    assert DEFAULT_CONVERSION.key == "hevc"
    assert DEFAULT_CONVERSION.codec == "hevc" and DEFAULT_CONVERSION.short_side is None


@pytest.mark.parametrize("conversion", CONVERSIONS, ids=lambda c: c.key)
def test_each_conversion_is_consistent_with_its_kind(conversion):
    if conversion.kind == "video":
        assert conversion.codec in ("hevc", "h264")
        assert conversion.extension == ".mp4" and conversion.mime_type == "video/mp4"
    elif conversion.kind == "gif":
        assert conversion.extension == ".gif" and conversion.mime_type == "image/gif"
        assert conversion.max_seconds == GIF_MAX_SECONDS
        assert not conversion.keeps_original_if_larger
    else:
        assert conversion.kind == "audio"
        assert conversion.codec in ("aac", "mp3")
        assert not conversion.keeps_original_if_larger


def test_only_smaller_file_conversions_fall_back_to_the_original():
    fallback = {c.key for c in CONVERSIONS if c.keeps_original_if_larger}
    assert fallback == {"hevc", "hevc720", "hevc480"}


def test_callback_data_round_trips_and_rejects_strangers():
    for conversion in CONVERSIONS:
        assert key_from_callback(callback_data(conversion.key)) == conversion.key
    assert key_from_callback("conv:unknown") is None
    assert key_from_callback("something-else") is None
    assert key_from_callback(None) is None


def test_get_conversion_defaults_when_no_key_is_given():
    assert get_conversion(None) is DEFAULT_CONVERSION
    assert get_conversion("") is DEFAULT_CONVERSION
    assert get_conversion("gif").kind == "gif"
    with pytest.raises(ValueError):
        get_conversion("bogus")


def test_effective_seconds_caps_only_the_gif():
    assert effective_seconds(get_conversion("gif"), 60) == GIF_MAX_SECONDS
    assert effective_seconds(get_conversion("gif"), 4) == 4
    assert effective_seconds(get_conversion("m4a"), 60) == 60


def _info(**kwargs) -> VideoInfo:
    base = dict(codec="hevc", width=1920, height=1080, rotation=0, duration=75.4, bit_depth=10)
    return VideoInfo(**{**base, **kwargs})


def test_caption_for_a_scaled_video_names_the_codec_and_the_size():
    from video_convertor_bot.captions import describe_result

    result = ConversionResult(_info(width=854, height=480), 12_800_000, Path("x.mp4"), 2_000_000, False,
                              "converted", output=_info(width=854, height=480, bit_depth=8),
                              conversion=get_conversion("hevc480"))
    caption = describe_result(result)
    assert caption.startswith("✅ 2.0 MB (was 12.8 MB, 84% smaller)")
    assert "854×480 · 1:15 · HEVC 8-bit" in caption


def test_caption_for_an_mp4_says_it_is_h264_and_that_hdr_was_converted():
    from video_convertor_bot.captions import describe_result

    hdr = _info(color_transfer="arib-std-b67")
    result = ConversionResult(hdr, 12_800_000, Path("x.mp4"), 15_000_000, False, "converted",
                              output=_info(codec="h264", bit_depth=8, color_transfer=None),
                              conversion=get_conversion("h264"))
    caption = describe_result(result)
    assert "17% bigger" in caption
    assert "H.264 8-bit · HDR converted to SDR" in caption


def test_caption_for_a_gif_and_for_audio():
    from video_convertor_bot.captions import describe_result

    gif = ConversionResult(_info(duration=60), 50_000_000, Path("x.gif"), 3_000_000, False, "converted",
                           output=None, conversion=get_conversion("gif"))
    assert describe_result(gif).startswith("✅ GIF, 3.0 MB (video was 50.0 MB)\nFirst 10 seconds")

    short = ConversionResult(_info(duration=4), 50_000_000, Path("x.gif"), 300_000, False, "converted",
                             output=None, conversion=get_conversion("gif"))
    assert "Whole video" in describe_result(short)

    audio = ConversionResult(_info(duration=75.4), 50_000_000, Path("x.m4a"), 1_200_000, False, "converted",
                             output=None, conversion=get_conversion("m4a"))
    caption = describe_result(audio)
    assert caption.startswith("✅ M4A audio, 1.2 MB (video was 50.0 MB)")
    assert "1:15" in caption
