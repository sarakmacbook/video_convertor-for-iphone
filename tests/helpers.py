"""Helpers shared by the test modules (kept out of conftest.py so they can be imported)."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from video_convertor_bot.media import EncodeOptions

CLIP_CREATED = "2026-10-01T12:00:00Z"
CLIP_LOCATION = "+37.7749-122.4194/"
TEST_TOKEN = "123456:TEST-token"
TEST_USER_ID = 555


def message_update(*, video=None, document=None, text=None, user_id=TEST_USER_ID, message_id=10) -> dict:
    message = {
        "message_id": message_id,
        "date": 1_700_000_000,
        "chat": {"id": user_id, "type": "private", "first_name": "Sam"},
        "from": {"id": user_id, "is_bot": False, "first_name": "Sam"},
    }
    if video is not None:
        message["video"] = video
    if document is not None:
        message["document"] = document
    if text is not None:
        message["text"] = text
        if text.startswith("/"):  # Telegram marks commands with a bot_command entity
            command_length = len(text.split()[0])
            message["entities"] = [{"type": "bot_command", "offset": 0, "length": command_length}]
    return {"update_id": 1, "message": message}





def probe_json(opts: EncodeOptions, path: Path) -> dict:
    """Raw ffprobe report (format + streams) for a file."""
    result = subprocess.run(
        [opts.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def psnr(opts: EncodeOptions, reference: Path, distorted: Path) -> float:
    """Average PSNR of the Y channel, comparing the two videos in display orientation."""
    result = subprocess.run(
        [
            opts.ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-i",
            str(distorted),
            "-i",
            str(reference),
            "-lavfi",
            "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]psnr",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    values = re.findall(r"average:([0-9.]+|inf)", result.stderr)
    assert values, f"psnr produced no result: {result.stderr[-300:]}"
    return float(values[-1])


def run_ffmpeg(opts: EncodeOptions, *args: str) -> None:
    """Run ffmpeg quietly and raise if it fails (used to build test clips)."""
    result = subprocess.run(
        [opts.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-500:]}")
