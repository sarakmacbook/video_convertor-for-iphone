"""End-to-end test of the worker: claim → download → convert → upload → report.

Runs a real ffmpeg encode through the bot's pipeline, against a stand-in control plane, so it
checks the same code path a worker uses on a real deployment.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from tests.helpers import run_ffmpeg
from video_convertor_bot.media import EncodeOptions
from worker.client import WorkerApiError, WorkerClient
from worker.runner import TelegramDelivery, run_one
from worker.text import describe_result


class SimpleServer(BaseHTTPRequestHandler):
    """Serves a clip for download and accepts the worker's uploads and reports."""

    clip: bytes = b""
    uploaded: bytearray = bytearray()
    reports: list[dict] = []

    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        if self.path == "/clip.mov":
            self.send_response(200)
            self.send_header("content-length", str(len(self.clip)))
            self.end_headers()
            self.wfile.write(self.clip)
            return
        self.send_error(404)

    def do_PUT(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length)
        self.__class__.uploaded = bytearray(body)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        self.__class__.reports.append(json.loads(raw or b"{}"))
        if self.path.endswith("/claim"):
            payload = {
                "job": {
                    "id": "job_flow",
                    "source": "web",
                    "input": {
                        "key": "jobs/job_flow/input/clip.mov",
                        "name": "clip.mov",
                        "bytes": len(self.__class__.clip),
                        "downloadUrl": f"http://127.0.0.1:{self.server.server_address[1]}/clip.mov",
                    },
                    "output": {
                        "uploadUrl": f"http://127.0.0.1:{self.server.server_address[1]}/upload/clip_small.mp4",
                        "method": "PUT",
                        "headers": {},
                        "key": "jobs/job_flow/output/clip_small.mp4",
                        "name": "clip_small.mp4",
                    },
                    "encoding": {"crf": 40, "preset": "medium", "timeoutSeconds": 600, "maxInputMb": 20},
                    "delivery": {"mode": "server"},
                },
                "leaseSeconds": 120,
            }
            self.send_response(200)
            body = json.dumps(payload).encode()
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')


@pytest.fixture()
def server():
    SimpleServer.reports = []
    SimpleServer.uploaded = bytearray()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SimpleServer)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_worker_converts_a_job_and_reports_sizes(ffmpeg_opts: EncodeOptions, server, tmp_path: Path):
    clip = tmp_path / "clip.mov"
    # A noisy clip encoded at a high quality: re-encoding it at CRF 40 has to shrink it a lot.
    run_ffmpeg(
        ffmpeg_opts,
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2",
        "-vf", "noise=alls=40:allf=t+u",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "12", "-x265-params", "log-level=error",
        "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
        str(clip),
    )
    SimpleServer.clip = clip.read_bytes()

    base = f"http://127.0.0.1:{server.server_address[1]}"
    client = WorkerClient(base, "secret", "flow-worker")
    job = client.claim()
    assert job is not None

    telegram = TelegramDelivery(token=None, api_url=None, local_mode=False)
    assert telegram.configured is False

    outcome = asyncio.run(run_one(client, job, ffmpeg_opts, telegram))

    # The converted file went to the signed upload URL…
    assert outcome.used_original is False, "the clip should have been much smaller after CRF 40"
    assert len(SimpleServer.uploaded) > 0
    assert outcome.output_key == "jobs/job_flow/output/clip_small.mp4"
    assert outcome.output_bytes == len(SimpleServer.uploaded)
    # …and it really is a smaller HEVC file.
    assert outcome.output_codec == "hevc"
    assert outcome.output_bytes < outcome.source_bytes
    assert 0 < outcome.saved_percent < 100

    # Progress was reported while it worked.
    stages = [report.get("report", {}).get("stage") for report in SimpleServer.reports if report.get("action") == "progress"]
    assert "converting" in stages

    client.complete(
        job.id,
        used_original=outcome.used_original,
        output_bytes=outcome.output_bytes,
        output_key=outcome.output_key,
        output_name=job.output_name,
        output_width=outcome.output_width,
        output_height=outcome.output_height,
        output_codec=outcome.output_codec,
        source_bytes=outcome.source_bytes,
        saved_percent=outcome.saved_percent,
        ffmpeg_version=None,
        delivered_to_telegram=False,
    )
    complete = next(report for report in SimpleServer.reports if report.get("action") == "complete")
    assert complete["complete"]["outputBytes"] == outcome.output_bytes
    assert complete["complete"]["outputCodec"] == "hevc"
    assert complete["complete"]["usedOriginal"] is False


def test_a_job_that_lives_on_telegram_needs_a_token(server, tmp_path: Path):
    """In local Bot API mode the worker downloads from Telegram, so it must have the token."""
    base = f"http://127.0.0.1:{server.server_address[1]}"
    from worker.client import ClaimedJob

    job = ClaimedJob.from_payload(
        {
            "id": "job_local",
            "source": "telegram",
            "input": {"key": "tg/1/clip.mov", "name": "clip.mov", "bytes": 10, "downloadUrl": ""},
            "output": {"uploadUrl": f"{base}/upload/x.mp4", "method": "PUT", "headers": {}, "key": "t/x.mp4", "name": "x.mp4"},
            "encoding": {"crf": 20, "preset": "medium"},
            "delivery": {"mode": "worker", "telegram": {"chatId": 1, "fileId": "abc", "apiUrl": base, "localMode": True}},
        }
    )
    assert job.needs_telegram_download is True

    client = WorkerClient(base, "secret", "flow-worker")
    telegram = TelegramDelivery(token=None, api_url=base, local_mode=True)
    with pytest.raises(WorkerApiError) as error:
        asyncio.run(run_one(client, job, EncodeOptions(ffmpeg="ffmpeg", ffprobe="ffprobe"), telegram))
    assert "BOT_TOKEN" in str(error.value)


def test_caption_wording_matches_the_bot(ffmpeg_opts: EncodeOptions, tmp_path: Path):
    """The worker's caption uses the same wording as the polling bot's messages."""
    from video_convertor_bot.pipeline import ConversionResult
    from video_convertor_bot.media import VideoInfo

    info = VideoInfo(codec="hevc", width=1920, height=1080, duration=12.5, bit_depth=10, color_transfer="arib-std-b67")
    converted = ConversionResult(
        source=info,
        source_bytes=100_000_000,
        output_path=tmp_path / "out.mp4",
        output_bytes=42_000_000,
        used_original=False,
        reason="converted",
    )
    caption = describe_result(converted)
    assert "42.0 MB" in caption
    assert "100.0 MB" in caption
    assert "58% smaller" in caption
    assert "10-bit HDR" in caption
    assert "1920×1080" in caption

    kept = ConversionResult(
        source=info,
        source_bytes=1_000_000,
        output_path=tmp_path / "in.mov",
        output_bytes=0,
        used_original=True,
        reason="re-encoding would not make this file smaller",
    )
    kept_caption = describe_result(kept)
    assert "Sending your original" in kept_caption
    assert "re-encoding would not make this file smaller" in kept_caption
