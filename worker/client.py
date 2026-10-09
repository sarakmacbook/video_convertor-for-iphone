"""Talks to the web app's worker API.

Deliberately dependency-free (only the standard library), so the worker can run anywhere
Python 3.10+ runs — the same machine as your Telegram bot, a Raspberry Pi, a NAS or a VPS.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60.0
UPLOAD_TIMEOUT = 3600.0


class WorkerApiError(RuntimeError):
    """The deployment refused a request or could not be reached."""


def _telegram_details(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """The app sends camelCase; workers are easier to read with snake_case."""
    if not payload:
        return None
    def first(*keys: str):
        for key in keys:
            if payload.get(key) is not None:
                return payload[key]
        return None

    return {
        "chat_id": first("chatId", "chat_id"),
        "status_message_id": first("statusMessageId", "status_message_id"),
        "file_id": first("fileId", "file_id"),
        "api_url": first("apiUrl", "api_url"),
        "local_mode": bool(first("localMode", "local_mode") or False),
    }


@dataclass(frozen=True)
class ClaimedJob:
    """One job, exactly as `/api/worker/claim` describes it."""

    id: str
    source: str
    input_key: str
    input_name: str | None
    input_bytes: int
    input_download_url: str
    output_upload_url: str
    output_upload_method: str
    output_upload_headers: dict[str, str]
    output_key: str
    output_name: str
    output_content_type: str
    crf: int
    preset: str
    conversion_key: str
    timeout_seconds: int
    delivery_mode: str
    telegram: dict[str, Any] | None
    raw: dict[str, Any]

    @property
    def needs_telegram_download(self) -> bool:
        """True when the video has to be fetched from Telegram instead of storage."""
        return not self.input_download_url and bool((self.telegram or {}).get("file_id"))

    @property
    def telegram_chat_id(self) -> int | None:
        value = (self.telegram or {}).get("chat_id")
        return int(value) if value is not None else None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> ClaimedJob:
        encoding = payload.get("encoding") or {}
        output = payload.get("output") or {}
        source = payload.get("input") or {}
        delivery = payload.get("delivery") or {}
        return cls(
            id=str(payload.get("id")),
            source=str(payload.get("source") or "api"),
            input_key=str(source.get("key") or ""),
            input_name=source.get("name"),
            input_bytes=int(source.get("bytes") or 0),
            input_download_url=str(source.get("downloadUrl") or ""),
            output_upload_url=str(output.get("uploadUrl") or ""),
            output_upload_method=str(output.get("method") or "PUT"),
            output_upload_headers=dict(output.get("headers") or {}),
            output_key=str(output.get("key") or ""),
            output_name=str(output.get("name") or "video_small.mp4"),
            output_content_type=str(output.get("contentType") or "video/mp4"),
            crf=int(encoding.get("crf") or 20),
            preset=str(encoding.get("preset") or "medium"),
            conversion_key=str(encoding.get("conversion") or "hevc"),
            timeout_seconds=int(encoding.get("timeoutSeconds") or 21600),
            delivery_mode=str(delivery.get("mode") or "server"),
            telegram=_telegram_details(delivery.get("telegram")),
            raw=payload,
        )


class WorkerClient:
    """A thin wrapper over the four endpoints a worker needs."""

    def __init__(self, app_url: str, secret: str, worker_id: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.app_url = app_url.rstrip("/")
        self.secret = secret
        self.worker_id = worker_id
        self.timeout = timeout

    # ------------------------------------------------------------------ helpers

    def _post(self, path: str, payload: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        body = json.dumps({**payload, "workerId": self.worker_id}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.app_url}{path}",
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-worker-secret": self.secret,
                "x-worker-id": self.worker_id,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise WorkerApiError(f"{path} failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise WorkerApiError(f"could not reach {self.app_url}{path}: {exc.reason}") from exc

    # ------------------------------------------------------------------- public

    def register(self, name: str, version: str, info: str | None = None) -> dict[str, Any]:
        return self._post("/api/worker/register", {"name": name, "version": version, "info": info})

    def claim(self) -> ClaimedJob | None:
        payload = self._post("/api/worker/claim", {"name": self.worker_id})
        job = payload.get("job")
        return ClaimedJob.from_payload(job) if job else None

    def progress(self, job_id: str, *, progress: float | None = None, message: str | None = None, stage: str | None = None) -> None:
        try:
            self._post(
                f"/api/worker/jobs/{job_id}",
                {"action": "progress", "report": {"progress": progress, "message": message, "stage": stage, "status": "busy"}},
            )
        except WorkerApiError as exc:
            # Progress is a nicety; never let it stop a conversion.
            logger.debug("could not report progress: %s", exc)

    def complete(
        self,
        job_id: str,
        *,
        used_original: bool,
        output_bytes: int,
        output_key: str | None,
        output_name: str | None,
        output_width: int | None,
        output_height: int | None,
        output_codec: str | None,
        source_bytes: int,
        saved_percent: float,
        ffmpeg_version: str | None,
        delivered_to_telegram: bool,
        message: str | None = None,
        log_tail: str | None = None,
    ) -> dict[str, Any]:
        return self._post(
            f"/api/worker/jobs/{job_id}",
            {
                "action": "complete",
                "complete": {
                    "usedOriginal": used_original,
                    "outputKey": output_key,
                    "outputName": output_name,
                    "outputBytes": output_bytes,
                    "outputWidth": output_width,
                    "outputHeight": output_height,
                    "outputCodec": output_codec,
                    "sourceBytes": source_bytes,
                    "savedPercent": saved_percent,
                    "ffmpegVersion": ffmpeg_version,
                    "deliveredToTelegram": delivered_to_telegram,
                    "message": message,
                    "logTail": log_tail,
                },
            },
        )

    def fail(self, job_id: str, error: str, *, retryable: bool = True) -> dict[str, Any]:
        return self._post(
            f"/api/worker/jobs/{job_id}",
            {"action": "fail", "failure": {"error": error[:2000], "retryable": retryable}},
        )

    # -------------------------------------------------------- file transfer

    def download(self, url: str, target: Path) -> int:
        target.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url)
        with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT) as response, target.open("wb") as file:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                file.write(chunk)
        return target.stat().st_size

    def upload(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        source: Path,
        content_type: str = "video/mp4",
    ) -> int:
        size = source.stat().st_size
        with source.open("rb") as file:
            request = urllib.request.Request(url, data=file, method=method or "PUT")
            for key, value in (headers or {}).items():
                request.add_header(key, value)
            if "content-type" not in {key.lower() for key in (headers or {})}:
                request.add_header("content-type", content_type)
            request.add_header("content-length", str(size))
            try:
                with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT) as response:
                    response.read()
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300]
                raise WorkerApiError(f"upload failed with HTTP {exc.code}: {detail}") from exc
        return size
