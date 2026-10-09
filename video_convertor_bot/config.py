"""Runtime settings, read from environment variables (a .env file is loaded by the entry point)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Mapping

from .media import EncodeOptions

DEFAULT_API_URL = "https://api.telegram.org"

# Telegram limits for the public cloud Bot API.
CLOUD_DOWNLOAD_LIMIT_MB = 20  # bots can only download files up to 20 MB
CLOUD_UPLOAD_LIMIT_MB = 50  # bots can upload files up to 50 MB
# A self-hosted Bot API server (github.com/tdlib/telegram-bot-api) raises both to 2000 MB.
LOCAL_SERVER_LIMIT_MB = 2000
# Hard cap on any uploaded video, whatever MAX_INPUT_MB says: 1 GB.
MAX_UPLOAD_MB = 1000

MB = 1_000_000  # decimal megabytes, the same units iPhone and Telegram show users

# x265 presets, from fastest/biggest to slowest/smallest.
X265_PRESETS = (
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
)
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

_TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
_INVISIBLE_RE = re.compile(r"[\u200b-\u200d\ufeff\u00a0]")


class ConfigError(ValueError):
    """A setting is missing or invalid. The message is shown to the operator."""


@dataclass(frozen=True)
class Settings:
    bot_token: str
    api_url: str = DEFAULT_API_URL
    local_mode: bool = False
    allowed_user_ids: frozenset[int] = field(default_factory=frozenset)
    crf: int = 20
    preset: str = "medium"
    max_input_mb: int = CLOUD_DOWNLOAD_LIMIT_MB
    max_concurrent_jobs: int = 1
    ffmpeg_timeout_seconds: int = 7200
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    work_dir: str | None = None
    log_level: str = "INFO"

    @property
    def uses_local_server(self) -> bool:
        return self.api_url != DEFAULT_API_URL

    @property
    def max_input_bytes(self) -> int:
        return min(self.max_input_mb, MAX_UPLOAD_MB) * MB

    @property
    def upload_limit_bytes(self) -> int:
        limit_mb = LOCAL_SERVER_LIMIT_MB if self.uses_local_server else CLOUD_UPLOAD_LIMIT_MB
        return limit_mb * MB

    @property
    def encode_options(self) -> EncodeOptions:
        return EncodeOptions(
            ffmpeg=self.ffmpeg_bin,
            ffprobe=self.ffprobe_bin,
            crf=self.crf,
            preset=self.preset,
            timeout_seconds=float(self.ffmpeg_timeout_seconds),
        )


def _text(env: Mapping[str, str], key: str, default: str = "") -> str:
    return (env.get(key) or default).strip()


def _int(env: Mapping[str, str], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = _text(env, key)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a whole number, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{key} must be between {minimum} and {maximum}, got {value}")
    return value


def _bool(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = _text(env, key).lower()
    if not raw:
        return default
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{key} must be true or false, got {raw!r}")


def _user_ids(env: Mapping[str, str], key: str) -> frozenset[int]:
    ids: set[int] = set()
    for part in _text(env, key).split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            raise ConfigError(f"{key} must be comma-separated Telegram user IDs, got {part!r}")
        ids.add(int(part))
    return frozenset(ids)


def load_settings(env: Mapping[str, str]) -> Settings:
    """Build and validate Settings from an environment-like mapping."""
    token = _INVISIBLE_RE.sub("", _text(env, "BOT_TOKEN"))
    if token.lower().startswith("bot") and _TOKEN_RE.match(token[3:]):
        token = token[3:]
    if not token:
        raise ConfigError("BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env")
    if not _TOKEN_RE.match(token):
        raise ConfigError("BOT_TOKEN does not look like a Telegram bot token (expected 123456:ABC...)")

    api_url = _text(env, "TELEGRAM_API_URL", DEFAULT_API_URL).rstrip("/")
    if not api_url.startswith(("http://", "https://")):
        raise ConfigError("TELEGRAM_API_URL must start with http:// or https://")

    local_mode = _bool(env, "TELEGRAM_LOCAL_MODE", False)
    if local_mode and api_url == DEFAULT_API_URL:
        raise ConfigError(
            "TELEGRAM_LOCAL_MODE=true needs TELEGRAM_API_URL to point at your local Bot API server"
        )

    preset = _text(env, "X265_PRESET", "medium").lower()
    if preset not in X265_PRESETS:
        raise ConfigError(f"X265_PRESET must be one of: {', '.join(X265_PRESETS)}")

    log_level = _text(env, "LOG_LEVEL", "INFO").upper()
    if log_level not in LOG_LEVELS:
        raise ConfigError(f"LOG_LEVEL must be one of: {', '.join(LOG_LEVELS)}")

    # Download limit: unlimited only in --local mode; otherwise Telegram's 20 MB cap applies.
    default_max_input = MAX_UPLOAD_MB if local_mode else CLOUD_DOWNLOAD_LIMIT_MB

    return Settings(
        bot_token=token,
        api_url=api_url,
        local_mode=local_mode,
        allowed_user_ids=_user_ids(env, "ALLOWED_USER_IDS"),
        crf=_int(env, "CRF", 20, minimum=0, maximum=51),
        preset=preset,
        max_input_mb=_int(env, "MAX_INPUT_MB", default_max_input, minimum=1, maximum=MAX_UPLOAD_MB),
        max_concurrent_jobs=_int(env, "MAX_CONCURRENT_JOBS", 1, minimum=1, maximum=16),
        ffmpeg_timeout_seconds=_int(env, "FFMPEG_TIMEOUT_SECONDS", 7200, minimum=60, maximum=86400),
        ffmpeg_bin=_text(env, "FFMPEG_BIN", "ffmpeg"),
        ffprobe_bin=_text(env, "FFPROBE_BIN", "ffprobe"),
        work_dir=_text(env, "WORK_DIR") or None,
        log_level=log_level,
    )
