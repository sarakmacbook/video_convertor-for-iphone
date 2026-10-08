"""Unit tests for the bot's text, naming and progress helpers (no Telegram or ffmpeg needed)."""

from pathlib import Path

import pytest

import video_convertor_bot.bot as bot
from video_convertor_bot.config import Settings
from video_convertor_bot.media import VideoInfo
from video_convertor_bot.pipeline import ConversionResult


def _info(**kwargs) -> VideoInfo:
    base = dict(codec="hevc", width=1920, height=1080, rotation=90, duration=75.4, bit_depth=10,
                color_transfer="arib-std-b67")
    return VideoInfo(**{**base, **kwargs})


def test_caption_for_a_converted_file():
    result = ConversionResult(_info(), 12_800_000, Path("x.mp4"), 7_400_000, False, "converted")
    caption = bot.describe_result(result)
    assert caption.startswith("✅ 7.4 MB (was 12.8 MB, 42% smaller)")
    assert "1080×1920 · 1:15 · HEVC 10-bit HDR" in caption


def test_caption_for_an_original_explains_why():
    result = ConversionResult(_info(color_transfer=None, bit_depth=8), 5_000_000, Path("x.mov"), 0, True,
                              "re-encoding would not make this file smaller")
    caption = bot.describe_result(result)
    assert caption.startswith("ℹ️ Sending your original (5.0 MB): re-encoding would not make this file smaller.")


@pytest.mark.parametrize("seconds,expected", [(0, "0:00"), (9.6, "0:10"), (75, "1:15"), (3725, "1:02:05")])
def test_duration_formatting(seconds, expected):
    assert bot.format_duration(seconds) == expected


@pytest.mark.parametrize(
    "name,fallback,expected",
    [
        ("IMG 0042.MOV", "video", "IMG_0042"),
        ("../../etc/passwd.mov", "video", "passwd"),
        ("日本語.mp4", "video_20261008", "video_20261008"),
        (None, "video_20261008", "video_20261008"),
    ],
)
def test_file_names_are_made_safe(name, fallback, expected):
    assert bot.safe_stem(name, fallback) == expected


def test_extensions_are_sanitised():
    assert bot.safe_extension("CLIP.MOV") == ".mov"
    assert bot.safe_extension("weird.p/h p") == ""
    assert bot.safe_extension(None) == ""


def test_video_detection_by_type_or_extension():
    from telegram import Document

    def doc(name, mime):
        return Document(file_id="f", file_unique_id="u", file_name=name, mime_type=mime)

    assert bot.looks_like_video(doc("a.bin", "video/quicktime"))
    assert bot.looks_like_video(doc("IMG_1.MOV", None))
    assert not bot.looks_like_video(doc("notes.txt", "text/plain"))


def test_allowed_user_rules():
    open_bot = Settings(bot_token="1:x")
    closed_bot = Settings(bot_token="1:x", allowed_user_ids=frozenset({7}))
    assert bot.is_allowed(open_bot, None)
    assert bot.is_allowed(open_bot, 1)
    assert bot.is_allowed(closed_bot, 7)
    assert not bot.is_allowed(closed_bot, 8)
    assert not bot.is_allowed(closed_bot, None)


def test_cloud_hint_only_when_not_using_a_local_server():
    cloud = Settings(bot_token="1:x")
    local = Settings(bot_token="1:x", api_url="http://127.0.0.1:8081", local_mode=True, max_input_mb=2000)
    assert "local Telegram Bot API server" in bot.too_big_text(25_000_000, cloud)
    assert "local Telegram Bot API server" not in bot.too_big_text(25_000_000, local)
    assert "Limits on the standard Telegram server" in bot.start_text(cloud)
    assert "Limits on the standard Telegram server" not in bot.start_text(local)


class _FakeStatus:
    def __init__(self):
        self.texts = []

    async def edit_text(self, text):
        self.texts.append(text)


def test_progress_updates_are_throttled(monkeypatch):
    import asyncio

    clock = {"now": 1000.0}
    monkeypatch.setattr(bot.time, "monotonic", lambda: clock["now"])
    status = _FakeStatus()
    reporter = bot.ProgressReporter(status, min_interval=5.0)

    async def run():
        await reporter(0.00)  # first update goes out at once
        await reporter(0.01)  # too soon: skipped
        await reporter(0.02)  # still too soon: skipped
        clock["now"] += 6.0
        await reporter(0.30)  # 6 s later: sent
        await reporter(0.30)  # same percentage: skipped
        await reporter(1.00)  # 100% is always sent

    asyncio.run(run())
    assert status.texts == ["⚙️ Converting… 0%", "⚙️ Converting… 30%", "⚙️ Converting… 100%"]
