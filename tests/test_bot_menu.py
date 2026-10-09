"""The conversion menu: what the bot offers after a video, and what each button produces.

Same setup as test_bot_flow: the real python-telegram-bot application against the fake Bot API.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from telegram import Update

from tests.fake_telegram import FakeBotApi
from tests.helpers import TEST_TOKEN, TEST_USER_ID, callback_update, message_update, probe_json
from video_convertor_bot.bot import (
    ALLOWED_UPDATES,
    CHOICE_LAYOUT,
    TEXT_CHOICE_EXPIRED,
    TEXT_NO_AUDIO,
    TEXT_PRIVATE,
    build_application,
)
from video_convertor_bot.conversions import CONVERSIONS, callback_data, key_from_callback
from video_convertor_bot.config import Settings
from video_convertor_bot.media import EncodeOptions, parse_probe


@pytest.fixture
def api():
    server = FakeBotApi(TEST_TOKEN)
    server.start()
    yield server
    server.stop()


def make_settings(api: FakeBotApi, ffmpeg_opts: EncodeOptions, **overrides) -> Settings:
    base = dict(
        bot_token=TEST_TOKEN,
        api_url=api.url,
        ffmpeg_bin=ffmpeg_opts.ffmpeg,
        ffprobe_bin=ffmpeg_opts.ffprobe,
        crf=20,
        preset="medium",
        max_input_mb=20,
    )
    return Settings(**{**base, **overrides})


def run_updates(settings: Settings, *payloads: dict) -> None:
    async def go() -> None:
        app = build_application(settings)
        await app.initialize()
        try:
            for payload in payloads:
                await app.process_update(Update.de_json(payload, app.bot))
        finally:
            await app.shutdown()

    asyncio.run(go())


def _field(value):
    """Telegram fields arrive as JSON values or as JSON text inside form data; read both."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _buttons(markup) -> list[dict]:
    return [button for row in _field(markup)["inline_keyboard"] for button in row]


def _video(api: FakeBotApi, file_id: str, path: str, data: bytes | None = None, **extra) -> dict:
    if data is not None:
        api.serve_file(file_id, data, file_path=path)
    return {"file_id": file_id, "file_unique_id": f"u-{file_id}", "width": 1280, "height": 720,
            "duration": 2, "file_size": len(data) if data is not None else 1000, **extra}


def _menu_message(api: FakeBotApi) -> dict:
    menus = [c for c in api.calls_to("sendMessage") if "reply_markup" in c.fields]
    assert len(menus) == 1, [c.fields for c in api.calls_to("sendMessage")]
    return menus[0].fields


# --------------------------------------------------------------------------- #
# The menu itself
# --------------------------------------------------------------------------- #


def test_a_video_gets_the_menu_as_a_reply_and_nothing_is_downloaded(api, ffmpeg_opts, clips):
    video = _video(api, "menu-1", "videos/menu.mov", clips["portrait"].read_bytes())

    run_updates(make_settings(api, ffmpeg_opts), message_update(video=video))

    menu = _menu_message(api)
    assert "What should I make from this video?" in menu["text"]
    assert _field(menu["reply_parameters"])["message_id"] == 10  # quoted: the menu replies to the video
    offered = [key_from_callback(button["callback_data"]) for button in _buttons(menu["reply_markup"])]
    assert sorted(offered) == sorted(c.key for c in CONVERSIONS)
    assert api.calls_to("getFile") == [], "nothing is fetched until a button is tapped"
    assert api.calls_to("sendVideo") == []


def test_menu_keeps_each_button_within_telegrams_data_limit():
    for conversion in CONVERSIONS:
        assert len(callback_data(conversion.key).encode()) <= 64


def test_every_conversion_has_exactly_one_button():
    keys = [key for row in CHOICE_LAYOUT for key in row]
    assert sorted(keys) == sorted(c.key for c in CONVERSIONS)
    assert len(keys) == len(set(keys))


def test_the_bot_asks_for_the_callback_updates_it_needs():
    assert Update.CALLBACK_QUERY in ALLOWED_UPDATES
    assert Update.MESSAGE in ALLOWED_UPDATES


# --------------------------------------------------------------------------- #
# What each button produces
# --------------------------------------------------------------------------- #


def test_smaller_hevc_button_sends_a_video(api, ffmpeg_opts, clips, tmp_path):
    original = clips["portrait"].read_bytes()
    video = _video(api, "hevc-1", "videos/hevc.mov", original)
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "hevc"))

    sent = api.calls_to("sendVideo")
    assert len(sent) == 1
    assert sent[0].files["video"]["filename"] == "video_20231114_221320_small.mp4"
    assert len(sent[0].files["video"]["data"]) < len(original)


def test_menu_is_removed_once_a_button_is_tapped(api, ffmpeg_opts, clips):
    video = _video(api, "edit-1", "videos/edit.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "hevc", menu_id=2000))

    edits = [c for c in api.calls_to("editMessageText") if c.fields.get("message_id") in (2000, "2000", 2000)]
    assert edits, api.calls
    assert "reply_markup" not in edits[0].fields, "the menu must lose its buttons so it cannot be tapped twice"


def test_mp4_for_any_device_sends_h264_video(api, ffmpeg_opts, clips, tmp_path):
    video = _video(api, "h264-1", "videos/h264.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "h264"))

    sent = api.calls_to("sendVideo")
    assert len(sent) == 1
    info = parse_probe(probe_json(ffmpeg_opts, _write(tmp_path, sent[0].files["video"]["data"])))
    assert info.codec == "h264"
    assert info.bit_depth == 8
    assert "H.264" in sent[0].fields["caption"]


def test_720p_and_480p_send_scaled_videos_with_the_shorter_side_limited(api, ffmpeg_opts, clips, tmp_path):
    original = clips["portrait"].read_bytes()  # display 720x1280: the shorter side is already 720
    video = _video(api, "scale-1", "videos/scale.mov", original)
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "hevc480"))

    sent = api.calls_to("sendVideo")
    assert len(sent) == 1
    assert sent[0].files["video"]["filename"].endswith("_480p.mp4")
    info = parse_probe(probe_json(ffmpeg_opts, _write(tmp_path, sent[0].files["video"]["data"])))
    assert info.codec == "hevc"
    assert (info.display_width, info.display_height) == (480, 854)
    assert info.rotation == 0


def test_gif_button_sends_an_animation(api, ffmpeg_opts, clips):
    video = _video(api, "gif-1", "videos/gif.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "gif"))

    sent = api.calls_to("sendAnimation")
    assert len(sent) == 1, api.calls
    gif = sent[0].files["animation"]
    assert gif["filename"].endswith("_gif.gif")
    assert gif["data"].startswith(b"GIF8")
    assert api.calls_to("sendVideo") == []


@pytest.mark.parametrize(("key", "extension"), [("m4a", ".m4a"), ("mp3", ".mp3")])
def test_audio_buttons_send_only_the_sound(api, ffmpeg_opts, clips, key, extension):
    video = _video(api, f"audio-{key}", f"videos/audio-{key}.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], key))

    sent = api.calls_to("sendAudio")
    assert len(sent) == 1, api.calls
    assert sent[0].files["audio"]["filename"].endswith(f"_audio{extension}")
    assert sent[0].files["audio"]["data"]
    assert api.calls_to("sendVideo") == []


def test_video_without_sound_says_so_for_the_audio_buttons(api, ffmpeg_opts, clips):
    video = _video(api, "silent-1", "videos/silent.mov", clips["silent"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "m4a"))

    texts = [c.fields.get("text", "") for c in api.calls_to("sendMessage") + api.calls_to("editMessageText")]
    assert TEXT_NO_AUDIO in texts
    assert api.calls_to("sendAudio") == []


# --------------------------------------------------------------------------- #
# Buttons that no longer match a video, or that a stranger presses
# --------------------------------------------------------------------------- #


def test_expired_button_asks_for_the_video_again(api, ffmpeg_opts):
    upload = message_update(video=_video(api, "gone-1", "videos/gone.mov", None))

    run_updates(make_settings(api, ffmpeg_opts), callback_update(upload["message"], "hevc", menu_replies_to_upload=False))

    answers = api.calls_to("answerCallbackQuery")
    assert answers and answers[0].fields.get("text") == TEXT_CHOICE_EXPIRED
    assert api.calls_to("getFile") == []


def test_unknown_button_data_is_treated_as_expired(api, ffmpeg_opts, clips):
    video = _video(api, "bogus-1", "videos/bogus.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    run_updates(make_settings(api, ffmpeg_opts), upload, callback_update(upload["message"], "x", data="conv:nope"))

    answers = api.calls_to("answerCallbackQuery")
    assert answers and answers[0].fields.get("text") == TEXT_CHOICE_EXPIRED
    assert api.calls_to("getFile") == []


def test_strangers_cannot_use_someone_elses_menu(api, ffmpeg_opts, clips):
    video = _video(api, "stranger-1", "videos/stranger.mov", clips["portrait"].read_bytes())
    upload = message_update(video=video)

    settings = make_settings(api, ffmpeg_opts, allowed_user_ids=frozenset({TEST_USER_ID}))
    run_updates(settings, upload, callback_update(upload["message"], "hevc", user_id=999))

    answers = api.calls_to("answerCallbackQuery")
    assert answers and answers[0].fields.get("text") == TEXT_PRIVATE
    assert api.calls_to("getFile") == []
    assert api.calls_to("sendVideo") == []


def _write(tmp_path, data: bytes):
    path = tmp_path / "received.mp4"
    path.write_bytes(data)
    return path
