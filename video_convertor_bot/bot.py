"""Telegram front end: receive a video, convert it, send the smaller file back."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv
from telegram import Document, Message, Update, Video
from telegram.error import BadRequest, TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .config import (
    CLOUD_DOWNLOAD_LIMIT_MB,
    CLOUD_UPLOAD_LIMIT_MB,
    DEFAULT_API_URL,
    ConfigError,
    Settings,
    load_settings,
)
from .media import EncodeError, EncodeTimeoutError, MediaError, NotAVideoError, ProbeError, missing_tools
from .pipeline import ConversionResult, convert_video

logger = logging.getLogger("video_convertor_bot")

VIDEO_EXTENSIONS = frozenset(
    {".mov", ".mp4", ".m4v", ".hevc", ".3gp", ".mkv", ".webm", ".avi", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts"}
)

TEXT_START = (
    "👋 Send me a video and I'll make the file smaller without making it look any different.\n\n"
    "• Send it as a File (📎 → File). A normal video is compressed by Telegram before it reaches me.\n"
    "• Resolution, frame rate, HDR colour, sound, capture date and location are kept.\n"
    "• The video is re-encoded to HEVC (H.265) at a visually lossless setting. A re-encode can never be "
    "bit-for-bit identical to the original; the aim is a difference you can't see when watching.\n"
    "• If re-encoding would not make a file smaller, I send your original back."
)
TEXT_CLOUD_LIMITS = (
    f"\n\nLimits on the standard Telegram server: I can receive files up to {CLOUD_DOWNLOAD_LIMIT_MB} MB "
    f"and send files up to {CLOUD_UPLOAD_LIMIT_MB} MB."
)
TEXT_CLOUD_HINT = (
    f"Telegram's standard bot server only lets bots download files up to {CLOUD_DOWNLOAD_LIMIT_MB} MB. "
    "Bigger videos need a local Telegram Bot API server (see the README)."
)
TEXT_PRIVATE = "Sorry, this bot is private."
TEXT_NOT_VIDEO = "That doesn't look like a video. Send a video file, ideally as a File so Telegram doesn't compress it."
TEXT_QUEUED = "⏳ Queued. Another video is being converted."
TEXT_DOWNLOADING = "📥 Downloading…"
TEXT_CONVERTING = "⚙️ Converting… {pct}%"
TEXT_SENDING = "📤 Sending…"
TEXT_DONE = "✅ Done"
TEXT_FAILED_STATUS = "❌ Could not convert this video"
TEXT_UNREADABLE = "I couldn't read this video. Try sending it again as a File."
TEXT_TIMEOUT = "Converting this video took too long, so I stopped it."
TEXT_FAILED = "Something went wrong while converting this video. The bot owner can check the logs."
TEXT_TOO_LARGE_TO_SEND = "The converted video is {size}, which is over the upload limit of {limit} for this bot."


class TooLargeToSendError(MediaError):
    """The file to deliver is bigger than the Bot API upload limit."""

    def __init__(self, size: int, limit: int) -> None:
        super().__init__(f"{size} bytes is over the upload limit of {limit}")
        self.size = size
        self.limit = limit


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _user_id(update: Update) -> int | None:
    return update.effective_user.id if update.effective_user else None


def is_allowed(settings: Settings, user_id: int | None) -> bool:
    if not settings.allowed_user_ids:
        return True
    return user_id is not None and user_id in settings.allowed_user_ids


def looks_like_video(document: Document) -> bool:
    if (document.mime_type or "").startswith("video/"):
        return True
    return Path(document.file_name or "").suffix.lower() in VIDEO_EXTENSIONS


def pick_video(message: Message) -> Video | Document | None:
    if message.video is not None:
        return message.video
    if message.document is not None and looks_like_video(message.document):
        return message.document
    return None


def safe_stem(name: str | None, fallback: str) -> str:
    stem = Path(name).stem if name else ""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")[:80]
    return stem or fallback


def safe_extension(name: str | None) -> str:
    suffix = Path(name).suffix.lower() if name else ""
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ""


def format_mb(size_bytes: int) -> str:
    return f"{size_bytes / 1_000_000:.1f} MB"


def format_duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def describe_result(result: ConversionResult) -> str:
    info = result.source
    size = f"{info.display_width}×{info.display_height} · {format_duration(info.duration)}"
    if result.used_original:
        return f"ℹ️ Sending your original ({format_mb(result.source_bytes)}): {result.reason}.\n{size}"
    depth = "10-bit HDR" if info.is_hdr else ("10-bit" if info.bit_depth >= 10 else "8-bit")
    return (
        f"✅ {format_mb(result.output_bytes)} (was {format_mb(result.source_bytes)}, "
        f"{result.saved_percent:.0f}% smaller)\n"
        f"{size} · HEVC {depth}"
    )


def too_big_text(size: int, settings: Settings) -> str:
    text = f"This video is {format_mb(size)}, over this bot's limit of {settings.max_input_mb} MB."
    if settings.uses_local_server:
        return text
    return f"{text} {TEXT_CLOUD_HINT}"


def start_text(settings: Settings) -> str:
    return TEXT_START if settings.uses_local_server else TEXT_START + TEXT_CLOUD_LIMITS


async def _safe_edit(message: Message, text: str) -> None:
    try:
        await message.edit_text(text)
    except TelegramError as exc:  # deleted, unchanged, or rate limited: progress updates are best-effort
        logger.debug("could not update status message: %s", exc)


class ProgressReporter:
    """Edits the status message with the conversion percentage, at most every few seconds."""

    def __init__(self, status: Message, min_interval: float = 5.0) -> None:
        self._status = status
        self._min_interval = min_interval
        self._last_sent = float("-inf")
        self._last_pct = -1

    async def __call__(self, fraction: float) -> None:
        pct = int(fraction * 100)
        if pct == self._last_pct:
            return
        now = time.monotonic()
        if pct < 100 and now - self._last_sent < self._min_interval:
            return
        self._last_pct = pct
        self._last_sent = now
        await _safe_edit(self._status, TEXT_CONVERTING.format(pct=pct))


async def download_source(bot, media: Video | Document, fallback_stem: str, src_dir: Path) -> Path:
    """Fetch the file from Telegram into `src_dir`, keeping a readable name."""
    tg_file = await bot.get_file(media.file_id)
    original_name = media.file_name if isinstance(media, Document) else None
    ext = safe_extension(original_name) or safe_extension(tg_file.file_path) or ".mp4"
    stem = safe_stem(original_name, fallback=fallback_stem)
    src_dir.mkdir(parents=True, exist_ok=True)
    target = src_dir / f"{stem}{ext}"
    # With a local Bot API server, PTB copies the file from the server's disk instead of downloading it.
    await tg_file.download_to_drive(custom_path=target)
    return target


# --------------------------------------------------------------------------- #
# Handlers
# --------------------------------------------------------------------------- #


async def on_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if message is None:
        return
    settings: Settings = context.bot_data["settings"]
    if not is_allowed(settings, _user_id(update)):
        await message.reply_text(TEXT_PRIVATE)
        return
    await message.reply_text(start_text(settings))


async def on_other(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if message is None:
        return
    settings: Settings = context.bot_data["settings"]
    if not is_allowed(settings, _user_id(update)):
        await message.reply_text(TEXT_PRIVATE)
        return
    await message.reply_text(TEXT_NOT_VIDEO)


async def on_media(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if message is None:
        return
    settings: Settings = context.bot_data["settings"]
    user_id = _user_id(update)
    if not is_allowed(settings, user_id):
        await message.reply_text(TEXT_PRIVATE)
        return

    media = pick_video(message)
    if media is None:
        await message.reply_text(TEXT_NOT_VIDEO)
        return

    size = media.file_size or 0
    if size > settings.max_input_bytes:
        await message.reply_text(too_big_text(size, settings))
        return

    logger.info("job from user %s, %d bytes", user_id, size)
    status = await message.reply_text(TEXT_QUEUED)
    job_dir = Path(tempfile.mkdtemp(prefix="convert-", dir=settings.work_dir))
    try:
        await _convert_and_send(context, message, status, media, job_dir, settings)
    except TooLargeToSendError as exc:
        text = TEXT_TOO_LARGE_TO_SEND.format(size=format_mb(exc.size), limit=format_mb(exc.limit))
        await _fail(message, status, text)
    except NotAVideoError:
        await _fail(message, status, TEXT_NOT_VIDEO)
    except ProbeError:
        await _fail(message, status, TEXT_UNREADABLE)
    except EncodeTimeoutError:
        await _fail(message, status, TEXT_TIMEOUT)
    except EncodeError:
        logger.exception("conversion failed")
        await _fail(message, status, TEXT_FAILED)
    except MediaError:
        logger.exception("media error")
        await _fail(message, status, TEXT_FAILED)
    except BadRequest as exc:
        if "too big" in str(exc).lower():
            await _fail(message, status, TEXT_CLOUD_HINT)
        else:
            logger.exception("Telegram rejected a request")
            await _fail(message, status, TEXT_FAILED)
    except TelegramError:
        logger.exception("Telegram error during job")
        await _fail(message, status, TEXT_FAILED)
    except Exception:
        logger.exception("unexpected error during job")
        await _fail(message, status, TEXT_FAILED)
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


async def _convert_and_send(
    context: ContextTypes.DEFAULT_TYPE,
    message: Message,
    status: Message,
    media: Video | Document,
    job_dir: Path,
    settings: Settings,
) -> None:
    slots: asyncio.Semaphore = context.bot_data["slots"]
    async with slots:  # one encode at a time by default; other jobs wait here
        await _safe_edit(status, TEXT_DOWNLOADING)
        # Telegram does not keep the original name of a video sent as media, so use the send time.
        fallback = f"video_{message.date:%Y%m%d_%H%M%S}" if message.date else "video"
        source = await download_source(context.bot, media, fallback, job_dir / "src")
        await _safe_edit(status, TEXT_CONVERTING.format(pct=0))
        result = await convert_video(
            source,
            job_dir,
            out_name=f"{source.stem}_small.mp4",
            opts=settings.encode_options,
            progress=ProgressReporter(status),
        )

    await _safe_edit(status, TEXT_SENDING)
    if result.delivered_bytes > settings.upload_limit_bytes:
        raise TooLargeToSendError(result.delivered_bytes, settings.upload_limit_bytes)

    caption = describe_result(result)
    if result.used_original:
        await message.reply_document(document=str(result.output_path), caption=caption)
    else:
        info = result.output or result.source
        await message.reply_video(
            video=str(result.output_path),
            caption=caption,
            width=info.display_width,
            height=info.display_height,
            duration=round(info.duration),
            supports_streaming=True,
        )
    await _safe_edit(status, TEXT_DONE)


async def _fail(message: Message, status: Message, text: str) -> None:
    await _safe_edit(status, TEXT_FAILED_STATUS)
    try:
        await message.reply_text(text)
    except TelegramError:
        logger.exception("could not send failure message")


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("unhandled error", exc_info=context.error)


# --------------------------------------------------------------------------- #
# Application
# --------------------------------------------------------------------------- #


def build_application(settings: Settings) -> Application:
    builder = ApplicationBuilder().token(settings.bot_token)
    if settings.api_url != DEFAULT_API_URL:
        builder = builder.base_url(f"{settings.api_url}/bot").base_file_url(f"{settings.api_url}/file/bot")
    app = (
        builder.local_mode(settings.local_mode)
        .concurrent_updates(True)
        .connect_timeout(30)
        .read_timeout(120)
        .write_timeout(120)
        .pool_timeout(30)
        .media_write_timeout(1800)  # uploads of large videos can take a long time
        .build()
    )
    app.bot_data["settings"] = settings
    app.bot_data["slots"] = asyncio.Semaphore(settings.max_concurrent_jobs)

    private = filters.ChatType.PRIVATE
    app.add_handler(CommandHandler(["start", "help"], on_start, filters=private))
    app.add_handler(MessageHandler(private & (filters.VIDEO | filters.Document.ALL), on_media))
    app.add_handler(MessageHandler(private, on_other))
    app.add_error_handler(on_error)
    return app


def main() -> None:
    load_dotenv()
    try:
        settings = load_settings(os.environ)
    except ConfigError as exc:
        sys.exit(f"Configuration error: {exc}")

    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # httpx logs every request URL, and the URL contains the bot token. Keep it out of the logs.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    problems = missing_tools(settings.encode_options)
    if problems:
        sys.exit("\n".join(problems))

    if settings.work_dir:
        Path(settings.work_dir).mkdir(parents=True, exist_ok=True)
    if not settings.allowed_user_ids:
        logger.warning("ALLOWED_USER_IDS is not set, so anyone who finds this bot can use it")

    mode = "local Bot API server" if settings.uses_local_server else "Telegram cloud Bot API"
    logger.info(
        "starting with %s: crf=%d preset=%s, max input %d MB, %d concurrent job(s)",
        mode,
        settings.crf,
        settings.preset,
        settings.max_input_mb,
        settings.max_concurrent_jobs,
    )
    build_application(settings).run_polling(allowed_updates=Update.MESSAGE)
