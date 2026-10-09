"""End-to-end bot tests: the real python-telegram-bot application talks to a fake Bot API server.

Each test sends an update to the bot exactly as Telegram would, then checks what the bot asked
Telegram to do (which messages it sent, which file it uploaded, and whether the file was smaller).
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest
from telegram import Update

from tests.fake_telegram import FakeBotApi
from tests.helpers import TEST_TOKEN, TEST_USER_ID
from tests.helpers import callback_update, message_update, probe_json
from video_convertor_bot.bot import (
    TEXT_CLOUD_HINT,
    TEXT_NOT_VIDEO,
    TEXT_PRIVATE,
    TEXT_UNREADABLE,
    build_application,
)
from video_convertor_bot.config import Settings
from video_convertor_bot.media import EncodeOptions, parse_probe

TOKEN = TEST_TOKEN
USER_ID = TEST_USER_ID


@pytest.fixture
def api():
    server = FakeBotApi(TOKEN)
    server.start()
    yield server
    server.stop()


def make_settings(api: FakeBotApi, ffmpeg_opts: EncodeOptions, **overrides) -> Settings:
    base = dict(
        bot_token=TOKEN,
        api_url=api.url,
        ffmpeg_bin=ffmpeg_opts.ffmpeg,
        ffprobe_bin=ffmpeg_opts.ffprobe,
        crf=20,
        preset="medium",
        max_input_mb=20,
    )
    return Settings(**{**base, **overrides})


def run_update(settings: Settings, payload: dict) -> None:
    async def go() -> None:
        app = build_application(settings)
        await app.initialize()
        try:
            await app.process_update(Update.de_json(payload, app.bot))
        finally:
            await app.shutdown()

    asyncio.run(go())


def send_and_choose(settings: Settings, update: dict, key: str = "hevc") -> None:
    """Send a video, then tap the conversion button: what a user does in the chat."""
    run_update(settings, update)
    run_update(settings, callback_update(update["message"], key))


def sent_texts(api: FakeBotApi) -> list[str]:
    texts = []
    for call in api.calls_to("sendMessage") + api.calls_to("editMessageText"):
        if "text" in call.fields:
            texts.append(call.fields["text"])
    return texts


def _probe_bytes(opts: EncodeOptions, data: bytes, tmp_path: Path):
    path = tmp_path / "received.mp4"
    path.write_bytes(data)
    return parse_probe(probe_json(opts, path))


def test_video_message_comes_back_smaller_and_still_looks_the_same(api, ffmpeg_opts, clips, tmp_path):
    original = clips["portrait"].read_bytes()
    api.serve_file("vid-1", original, file_path="videos/file_1.mov")
    video = {"file_id": "vid-1", "file_unique_id": "u1", "width": 1280, "height": 720,
             "duration": 2, "file_size": len(original)}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(video=video))

    sent = api.calls_to("sendVideo")
    assert len(sent) == 1, api.calls
    upload = sent[0].files["video"]
    # Message date 1_700_000_000 is 2023-11-14 22:13:20 UTC.
    assert upload["filename"] == "video_20231114_221320_small.mp4"
    assert len(upload["data"]) < len(original)

    info = _probe_bytes(ffmpeg_opts, upload["data"], tmp_path)
    assert info.codec == "hevc"
    assert (info.display_width, info.display_height) == (720, 1280)
    assert info.is_hdr and info.bit_depth == 10

    caption = sent[0].fields["caption"]
    assert "smaller" in caption and "HEVC" in caption
    assert sent_texts(api)[-1] == "✅ Done"


def test_document_from_iphone_files_app_is_accepted(api, ffmpeg_opts, clips, tmp_path):
    original = clips["portrait"].read_bytes()
    api.serve_file("doc-1", original, file_path="documents/file_7.MOV")
    document = {"file_id": "doc-1", "file_unique_id": "u2", "file_name": "IMG_0042.MOV",
                "mime_type": "video/quicktime", "file_size": len(original)}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(document=document))

    sent = api.calls_to("sendVideo")
    assert len(sent) == 1
    assert sent[0].files["video"]["filename"] == "IMG_0042_small.mp4"


def test_document_with_video_extension_but_generic_type_is_accepted(api, ffmpeg_opts, clips):
    original = clips["h264"].read_bytes()
    api.serve_file("doc-2", original, file_path="documents/file_8.bin")
    document = {"file_id": "doc-2", "file_unique_id": "u3", "file_name": "holiday.mp4",
                "mime_type": "application/octet-stream", "file_size": len(original)}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(document=document))

    assert len(api.calls_to("sendVideo")) == 1


def test_non_video_document_gets_a_hint_and_no_download(api, ffmpeg_opts):
    document = {"file_id": "pdf-1", "file_unique_id": "u4", "file_name": "report.pdf",
                "mime_type": "application/pdf", "file_size": 1000}

    run_update(make_settings(api, ffmpeg_opts), message_update(document=document))

    assert TEXT_NOT_VIDEO in sent_texts(api)
    assert api.calls_to("getFile") == []


def test_plain_text_gets_the_same_hint(api, ffmpeg_opts):
    run_update(make_settings(api, ffmpeg_opts), message_update(text="hello"))
    assert sent_texts(api) == [TEXT_NOT_VIDEO]


def test_start_explains_how_to_send_for_best_quality(api, ffmpeg_opts):
    run_update(make_settings(api, ffmpeg_opts), message_update(text="/start"))
    texts = sent_texts(api)
    assert len(texts) == 1
    assert "Send it as a File" in texts[0]


def test_video_over_the_limit_is_refused_before_downloading(api, ffmpeg_opts):
    video = {"file_id": "big-1", "file_unique_id": "u5", "width": 1920, "height": 1080,
             "duration": 60, "file_size": 25_000_000}

    run_update(make_settings(api, ffmpeg_opts), message_update(video=video))

    texts = sent_texts(api)
    assert any("over this bot's limit of 20 MB" in t for t in texts), texts
    assert api.calls_to("getFile") == []


def test_telegram_refusing_the_download_is_explained(api, ffmpeg_opts):
    # The file size is unknown to the bot, so it tries the download and Telegram says "too big".
    api.serve_file("huge-1", b"\0" * 21_000_000, file_path="videos/file_9.mov")
    video = {"file_id": "huge-1", "file_unique_id": "u6", "width": 1920, "height": 1080, "duration": 90}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(video=video))

    assert TEXT_CLOUD_HINT in sent_texts(api)
    assert api.calls_to("sendVideo") == []


def test_private_bot_ignores_strangers(api, ffmpeg_opts, clips):
    api.serve_file("vid-x", clips["portrait"].read_bytes(), file_path="videos/file_x.mov")
    video = {"file_id": "vid-x", "file_unique_id": "u7", "width": 1280, "height": 720, "duration": 2,
             "file_size": 1000}

    run_update(make_settings(api, ffmpeg_opts, allowed_user_ids=frozenset({999})), message_update(video=video))

    assert sent_texts(api) == [TEXT_PRIVATE]
    assert api.calls_to("getFile") == []


def test_allowed_user_gets_service(api, ffmpeg_opts, clips):
    original = clips["portrait"].read_bytes()
    api.serve_file("vid-ok", original, file_path="videos/file_ok.mov")
    video = {"file_id": "vid-ok", "file_unique_id": "u8", "width": 1280, "height": 720, "duration": 2,
             "file_size": len(original)}

    send_and_choose(make_settings(api, ffmpeg_opts, allowed_user_ids=frozenset({USER_ID})), message_update(video=video))

    assert len(api.calls_to("sendVideo")) == 1


def test_already_compressed_video_is_sent_back_as_the_original(api, ffmpeg_opts, clips):
    original = clips["tiny"].read_bytes()
    api.serve_file("tiny-1", original, file_path="videos/file_tiny.mp4")
    video = {"file_id": "tiny-1", "file_unique_id": "u9", "width": 640, "height": 360, "duration": 2,
             "file_size": len(original)}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(video=video))

    assert api.calls_to("sendVideo") == []
    documents = api.calls_to("sendDocument")
    assert len(documents) == 1
    assert documents[0].files["document"]["data"] == original  # byte-for-byte the original
    assert "original" in documents[0].fields["caption"]


def test_unreadable_file_is_reported(api, ffmpeg_opts):
    api.serve_file("junk-1", b"this is not a movie at all", file_path="videos/file_junk.mov")
    video = {"file_id": "junk-1", "file_unique_id": "u10", "width": 1, "height": 1, "duration": 1,
             "file_size": 27}

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(video=video))

    assert TEXT_UNREADABLE in sent_texts(api)
    assert api.calls_to("sendVideo") == []


def test_local_server_mode_reads_and_uploads_by_file_path(api, ffmpeg_opts, clips, tmp_path):
    """With `--local`, the Bot API server hands out absolute paths: no HTTP download, and uploads
    are sent as file:// references the server reads from its own disk."""
    server_dir = tmp_path / "server-files"
    server_dir.mkdir()
    local_copy = server_dir / "file_11.mov"
    shutil.copyfile(clips["portrait"], local_copy)
    api.serve_file("vid-local", data=None, file_path=str(local_copy), file_size=local_copy.stat().st_size)
    video = {"file_id": "vid-local", "file_unique_id": "u11", "width": 1280, "height": 720, "duration": 2,
             "file_size": local_copy.stat().st_size}

    settings = make_settings(api, ffmpeg_opts, local_mode=True, max_input_mb=2000)
    send_and_choose(settings, message_update(video=video))

    assert api.downloads == [], "a local file must not be fetched over HTTP"
    sent = api.calls_to("sendVideo")
    assert len(sent) == 1
    video_field = sent[0].fields["video"]
    assert video_field.startswith("file://"), video_field
    assert video_field.endswith("_small.mp4"), video_field


def test_converted_file_over_the_upload_limit_is_not_sent(api, ffmpeg_opts, clips, monkeypatch):
    original = clips["portrait"].read_bytes()
    api.serve_file("vid-big", original, file_path="videos/file_big.mov")
    video = {"file_id": "vid-big", "file_unique_id": "u12", "width": 1280, "height": 720, "duration": 2,
             "file_size": len(original)}
    monkeypatch.setattr(Settings, "upload_limit_bytes", property(lambda self: 1_000))

    send_and_choose(make_settings(api, ffmpeg_opts), message_update(video=video))

    assert api.calls_to("sendVideo") == []
    assert any("over the upload limit" in t for t in sent_texts(api)), sent_texts(api)
