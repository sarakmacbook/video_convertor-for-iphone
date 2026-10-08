"""Tests for the worker's HTTP client, against a stand-in for the web app."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from worker.client import ClaimedJob, WorkerApiError, WorkerClient


class FakeControlPlane(BaseHTTPRequestHandler):
    """Records what the worker sends and replies with a claimable job."""

    files: dict[str, bytes] = {}
    calls: list[dict] = []
    payload: dict = {}
    # HTTP status for the /api/worker/* endpoints, so tests can simulate a rejected call.
    api_status: int = 200

    def log_message(self, *args):  # keep the test output clean
        pass

    def _read(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            return {"raw": raw.decode("utf-8", "replace")}

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.startswith("/download/"):
            name = self.path.rsplit("/", 1)[-1]
            body = self.files.get(name)
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_PUT(self):  # noqa: N802
        body = self._read_bytes()
        self.__class__.calls.append(
            {
                "path": self.path,
                "headers": dict(self.headers),
                "bytes": len(body),
                "kind": "upload",
            }
        )
        self._json({"ok": True, "bytes": len(body)})

    def _read_bytes(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/api/worker/claim"):
            body = self._read()
            self.__class__.calls.append({"path": self.path, "body": body, "kind": "api", "headers": dict(self.headers)})
            if self.__class__.api_status != 200:
                self._json({"error": "nope"}, status=self.__class__.api_status)
                return
            self._json(self.__class__.payload)
            return
        if self.path.startswith("/api/worker/"):
            body = self._read()
            self.__class__.calls.append({"path": self.path, "body": body, "kind": "api", "headers": dict(self.headers)})
            if self.__class__.api_status != 200:
                self._json({"error": "nope"}, status=self.__class__.api_status)
                return
            self._json({"ok": True})
            return
        self.send_error(404)


@pytest.fixture()
def control_plane():
    FakeControlPlane.calls = []
    FakeControlPlane.api_status = 200
    FakeControlPlane.files = {"clip.mov": b"pretend this is a video" * 100}
    FakeControlPlane.payload = {
        "job": {
            "id": "job_test123",
            "source": "telegram",
            "input": {
                "key": "jobs/u_1/input/clip.mov",
                "name": "clip.mov",
                "bytes": 2300,
                "downloadUrl": "",
            },
            "output": {
                "uploadUrl": "",
                "method": "PUT",
                "headers": {"content-type": "video/mp4"},
                "key": "jobs/job_test123/output/clip_small.mp4",
                "name": "clip_small.mp4",
            },
            "encoding": {"crf": 20, "preset": "medium", "timeoutSeconds": 3600, "maxInputMb": 20},
            "delivery": {"mode": "server"},
        },
        "leaseSeconds": 120,
    }

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeControlPlane)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield base, FakeControlPlane
    finally:
        server.shutdown()
        server.server_close()


def test_claim_parses_the_payload(control_plane):
    base, plane = control_plane
    plane.files = {"clip.mov": b"x" * 10}
    plane.payload["job"]["input"]["downloadUrl"] = f"{base}/download/clip.mov"

    client = WorkerClient(base, "secret", "test-worker")
    job = client.claim()

    assert isinstance(job, ClaimedJob)
    assert job.id == "job_test123"
    assert job.input_name == "clip.mov"
    assert job.output_name == "clip_small.mp4"
    assert job.crf == 20
    assert job.preset == "medium"
    assert job.delivery_mode == "server"
    assert job.needs_telegram_download is False

    headers = {key.lower(): value for key, value in plane.calls[0]["headers"].items()}
    assert headers["x-worker-secret"] == "secret"
    assert plane.calls[0]["body"]["workerId"] == "test-worker"


def test_claim_without_a_download_url_needs_telegram(control_plane):
    base, plane = control_plane
    plane.payload["job"]["delivery"] = {
        "mode": "worker",
        "telegram": {"chatId": 555, "fileId": "file_abc", "apiUrl": base, "localMode": True},
    }
    job = WorkerClient(base, "secret", "worker").claim()
    assert job is not None
    assert job.needs_telegram_download is True
    assert job.delivery_mode == "worker"
    assert job.telegram["chat_id"] == 555
    assert job.telegram["file_id"] == "file_abc"
    assert job.telegram_chat_id == 555


def test_empty_queue_returns_none(control_plane):
    base, plane = control_plane
    plane.payload = {"job": None, "leaseSeconds": 120}
    assert WorkerClient(base, "secret", "worker").claim() is None


def test_download_and_upload_round_trip(control_plane, tmp_path: Path):
    base, plane = control_plane
    client = WorkerClient(base, "secret", "worker")

    target = tmp_path / "downloaded.mov"
    size = client.download(f"{base}/download/clip.mov", target)
    assert size == len(plane.files["clip.mov"])
    assert target.read_bytes() == plane.files["clip.mov"]

    result = tmp_path / "result.mp4"
    result.write_bytes(b"converted bytes" * 50)
    uploaded = client.upload(f"{base}/api/storage/local/out.mp4?token=x", "PUT", {}, result)
    assert uploaded == result.stat().st_size

    upload_calls = [call for call in plane.calls if call["kind"] == "upload"]
    assert len(upload_calls) == 1
    assert upload_calls[0]["bytes"] == result.stat().st_size
    headers = {key.lower(): value for key, value in upload_calls[0]["headers"].items()}
    assert headers["content-type"] == "video/mp4"
    assert headers["content-length"] == str(result.stat().st_size)


def test_progress_complete_and_fail_shapes(control_plane):
    base, plane = control_plane
    client = WorkerClient(base, "secret", "worker")

    client.progress("job_1", progress=0.5, message="Converting… 50%", stage="converting")
    client.complete(
        "job_1",
        used_original=False,
        output_bytes=1234,
        output_key="jobs/job_1/output/x.mp4",
        output_name="x.mp4",
        output_width=1080,
        output_height=1920,
        output_codec="hevc",
        source_bytes=5000,
        saved_percent=75.3,
        ffmpeg_version="ffmpeg version 7.0.2",
        delivered_to_telegram=True,
    )
    client.fail("job_1", "something broke", retryable=False)

    api_calls = [call for call in plane.calls if call["kind"] == "api"]
    progress = next(call for call in api_calls if call["body"].get("action") == "progress")
    assert progress["body"]["report"]["progress"] == 0.5
    assert progress["body"]["report"]["stage"] == "converting"

    complete = next(call for call in api_calls if call["body"].get("action") == "complete")
    assert complete["body"]["complete"]["outputBytes"] == 1234
    assert complete["body"]["complete"]["usedOriginal"] is False
    assert complete["body"]["complete"]["deliveredToTelegram"] is True

    failure = next(call for call in api_calls if call["body"].get("action") == "fail")
    assert failure["body"]["failure"] == {"error": "something broke", "retryable": False}


def test_http_errors_are_reported_clearly(control_plane):
    base, plane = control_plane
    plane.api_status = 401
    client = WorkerClient(base, "secret", "worker")
    with pytest.raises(WorkerApiError) as error:
        client.claim()
    assert "401" in str(error.value)

    # A server that is not listening at all is also reported, not crashed on.
    unreachable = WorkerClient("http://127.0.0.1:1", "secret", "worker")
    with pytest.raises(WorkerApiError):
        unreachable.claim()


def test_registration_reports_the_worker(control_plane):
    base, plane = control_plane
    WorkerClient(base, "secret", "worker-7").register("worker-7", "0.2.0", info="python 3.12")
    body = plane.calls[0]["body"]
    assert body["name"] == "worker-7"
    assert body["version"] == "0.2.0"
    assert body["workerId"] == "worker-7"
