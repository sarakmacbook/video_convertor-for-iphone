"""Runs the real entry point (`python -m video_convertor_bot`) with long polling against the fake server."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from tests.fake_telegram import FakeBotApi
from tests.helpers import TEST_TOKEN, callback_update, message_update

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_entry_point_polls_and_returns_a_converted_video(tmp_path, ffmpeg_opts, clips):
    original = clips["h264"].read_bytes()
    api = FakeBotApi(TEST_TOKEN)
    api.start()
    try:
        api.serve_file("poll-vid", original, file_path="videos/file_poll.mp4")
        video_update = message_update(
            video={
                "file_id": "poll-vid",
                "file_unique_id": "u-poll",
                "width": 640,
                "height": 360,
                "duration": 2,
                "file_size": len(original),
            }
        )
        api.queue_update(video_update)  # the video: the bot answers with the conversion menu
        api.queue_update(callback_update(video_update["message"], "hevc"))  # and the user taps "Smaller"

        env = {
            **os.environ,
            "BOT_TOKEN": TEST_TOKEN,
            "TELEGRAM_API_URL": api.url,
            "FFMPEG_BIN": ffmpeg_opts.ffmpeg,
            "FFPROBE_BIN": ffmpeg_opts.ffprobe,
            "LOG_LEVEL": "INFO",
            "PYTHONPATH": str(REPO_ROOT),
        }
        env.pop("ALLOWED_USER_IDS", None)
        env.pop("TELEGRAM_LOCAL_MODE", None)
        log_path = tmp_path / "bot.log"
        with log_path.open("wb") as log:
            proc = subprocess.Popen(
                [sys.executable, "-m", "video_convertor_bot"],
                cwd=REPO_ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if api.calls_to("sendVideo") or api.calls_to("sendDocument"):
                        break
                    if proc.poll() is not None:
                        break
                    time.sleep(0.5)
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)  # run_polling shuts down cleanly on SIGINT
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()

        log_text = log_path.read_text(errors="replace")
        assert api.calls_to("sendVideo"), f"no converted video was sent. Log tail:\n{log_text[-2000:]}"
        assert "bot123456" not in log_text and TEST_TOKEN not in log_text, "token leaked into logs"
        assert "starting with local Bot API server" in log_text  # the fake server URL is not api.telegram.org
        assert "Application.stop() complete" in log_text  # shut down cleanly on SIGINT
    finally:
        api.stop()
