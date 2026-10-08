"""Converting jobs claimed from the web app.

The actual encoding is done by the bot's existing, tested pipeline
(`video_convertor_bot.pipeline.convert_video`), so a video converted by the worker and one
converted by the Telegram bot come out identical.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from video_convertor_bot.media import EncodeOptions, missing_tools
from video_convertor_bot.pipeline import convert_video

from .client import ClaimedJob, WorkerApiError, WorkerClient

logger = logging.getLogger(__name__)

PROGRESS_STEP = 0.02  # report at most every 2% so the UI moves without flooding the API


@dataclass
class JobOutcome:
    used_original: bool
    output_bytes: int
    output_key: str | None
    output_path: Path
    source_bytes: int
    saved_percent: float
    output_width: int | None
    output_height: int | None
    output_codec: str | None
    delivered_to_telegram: bool
    message: str | None


class TelegramDelivery:
    """Downloads the incoming video and sends the result back, in local Bot API mode."""

    def __init__(self, token: str | None, api_url: str | None, local_mode: bool) -> None:
        self.token = token
        self.api_url = api_url
        self.local_mode = local_mode

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _bot(self):
        from telegram import Bot
        from telegram.request import HTTPXRequest

        request = HTTPXRequest(connect_timeout=30, read_timeout=120, write_timeout=1800)
        builder = {"token": self.token, "request": request}
        if self.api_url:
            builder["base_url"] = f"{self.api_url.rstrip('/')}/bot"
            builder["base_file_url"] = f"{self.api_url.rstrip('/')}/file/bot"
        bot = Bot(**builder)
        bot._worker_local_mode = self.local_mode  # noqa: SLF001 - python-telegram-bot reads this flag
        return bot

    async def download(self, file_id: str, target: Path) -> int:
        bot = self._bot()
        try:
            await bot.initialize()
            telegram_file = await bot.get_file(file_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            await telegram_file.download_to_drive(custom_path=target)
            return target.stat().st_size
        finally:
            await bot.shutdown()

    async def send_result(self, job: ClaimedJob, path: Path, caption: str, info) -> None:
        telegram = job.telegram or {}
        chat_id = int(telegram.get("chat_id") or telegram.get("chatId") or 0)
        status_message_id = telegram.get("status_message_id") or telegram.get("statusMessageId")
        bot = self._bot()
        try:
            await bot.initialize()
            with path.open("rb") as file:
                if job.delivery_mode == "worker" and getattr(info, "used_original", False):
                    await bot.send_document(chat_id=chat_id, document=file, caption=caption)
                else:
                    await bot.send_video(
                        chat_id=chat_id,
                        video=file,
                        caption=caption,
                        width=getattr(info, "width", None) or None,
                        height=getattr(info, "height", None) or None,
                        duration=int(getattr(info, "duration", 0) or 0) or None,
                        supports_streaming=True,
                    )
            if status_message_id:
                try:
                    await bot.edit_message_text(chat_id=chat_id, message_id=int(status_message_id), text="✅ Done")
                except Exception as exc:  # pragma: no cover - cosmetic
                    logger.debug("could not update the status message: %s", exc)
        finally:
            await bot.shutdown()


async def run_one(client: WorkerClient, job: ClaimedJob, options: EncodeOptions, telegram: TelegramDelivery) -> JobOutcome:
    """Download, convert, upload and (in local mode) deliver one job."""
    work_dir = Path(tempfile.mkdtemp(prefix=f"worker-{job.id[:12]}-"))
    try:
        source = work_dir / (job.input_name or "input.mov")
        if job.needs_telegram_download:
            if not telegram.configured:
                raise WorkerApiError(
                    "this job has to be fetched from Telegram, but BOT_TOKEN is not set on the worker"
                )
            logger.info("downloading %s from Telegram", job.id)
            client.progress(job.id, stage="downloading", message="Downloading from Telegram", progress=0.02)
            await telegram.download(str((job.telegram or {}).get("file_id")), source)
        else:
            client.progress(job.id, stage="downloading", message="Downloading", progress=0.02)
            client.download(job.input_download_url, source)
        logger.info("downloaded %s (%d bytes)", job.id, source.stat().st_size)

        last_reported = [-1.0]

        async def on_progress(fraction: float) -> None:
            if fraction - last_reported[0] < PROGRESS_STEP and fraction < 1.0:
                return
            last_reported[0] = fraction
            client.progress(
                job.id,
                stage="converting",
                message=f"Converting… {int(fraction * 100)}%",
                progress=0.05 + fraction * 0.85,
            )

        client.progress(job.id, stage="converting", message="Converting", progress=0.05)
        result = await convert_video(
            source,
            work_dir,
            out_name=job.output_name,
            opts=EncodeOptions(
                ffmpeg=options.ffmpeg,
                ffprobe=options.ffprobe,
                crf=job.crf,
                preset=job.preset,
                timeout_seconds=min(job.timeout_seconds, int(options.timeout_seconds)),
                audio_bitrate=options.audio_bitrate,
            ),
            progress=on_progress,
        )

        delivered = False
        if job.delivery_mode == "worker" and job.telegram:
            if telegram.configured:
                from worker.text import describe_result

                client.progress(job.id, stage="delivering", message="Sending to Telegram", progress=0.95)
                caption = describe_result(result)
                await telegram.send_result(job, result.output_path, caption, _DeliveryInfo.from_result(result))
                delivered = True
            else:
                logger.warning("job %s should be delivered by the worker, but BOT_TOKEN is missing", job.id)

        output_key: str | None = None
        output_bytes = result.source_bytes if result.used_original else result.output_bytes
        if not result.used_original:
            client.progress(job.id, stage="uploading", message="Uploading the result", progress=0.92)
            client.upload(job.output_upload_url, job.output_upload_method, job.output_upload_headers, result.output_path)
            output_key = job.output_key

        info = result.output or result.source
        saved = 0.0 if result.used_original or result.source_bytes <= 0 else (1 - output_bytes / result.source_bytes) * 100
        return JobOutcome(
            used_original=result.used_original,
            output_bytes=output_bytes,
            output_key=output_key,
            output_path=result.output_path,
            source_bytes=result.source_bytes,
            saved_percent=saved,
            output_width=info.width,
            output_height=info.height,
            output_codec=info.codec,
            delivered_to_telegram=delivered,
            message=None if not result.used_original else f"the original is smaller ({result.reason})",
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@dataclass
class _DeliveryInfo:
    """Just enough of a VideoInfo for the caption and the upload metadata."""

    used_original: bool
    width: int | None
    height: int | None
    duration: float
    is_hdr: bool

    @classmethod
    def from_result(cls, result) -> "_DeliveryInfo":
        info = result.output or result.source
        return cls(
            used_original=result.used_original,
            width=info.display_width,
            height=info.display_height,
            duration=info.duration,
            is_hdr=info.is_hdr,
        )


def check_ffmpeg(options: EncodeOptions) -> list[str]:
    """Return human-readable problems with the local ffmpeg install."""
    return missing_tools(options)


__all__ = ["JobOutcome", "TelegramDelivery", "check_ffmpeg", "run_one", "asyncio"]
