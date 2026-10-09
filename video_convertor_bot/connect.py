"""Connect the bot from the terminal: ``python -m video_convertor_bot connect``.

It asks for the bot API key from @BotFather (typed without echoing) and for your Telegram user
ID, checks the key with Telegram, saves BOT_TOKEN and ALLOWED_USER_IDS in .env, and sends you
a confirmation message. Every other line of .env is kept as it is. The key is never printed.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
from pathlib import Path
from typing import Any, Callable

import httpx
from dotenv import dotenv_values, find_dotenv

from .config import DEFAULT_API_URL

TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
TOKEN_IN_TEXT_RE = re.compile(r"\d{3,}:[A-Za-z0-9_-]{8,}")
USER_ID_RE = re.compile(r"^[1-9]\d{0,14}$")
USER_ID_LABEL_RE = re.compile(r"(?:(?:user|chat)\s*id|id)\b[^0-9]{0,24}([1-9]\d{4,14})", re.IGNORECASE)
_INVISIBLE_RE = re.compile(r"[\u200b-\u200d\ufeff\u00a0]")
_ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
_COMMENTED_ASSIGNMENT_RE = re.compile(r"^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")

CONFIRMATION = (
    "✅ Your video converter is connected. Send me a video as a File and I'll make it smaller. "
    "Only your account can use this bot."
)
ATTEMPTS = 3
TIMEOUT_SECONDS = 15.0

_REPO_ROOT = Path(__file__).resolve().parent.parent


class ConnectError(Exception):
    """Something the person can fix: shown to them as-is, without a traceback."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _unwrap(raw: str) -> str:
    text = _INVISIBLE_RE.sub(" ", raw).strip()
    if len(text) >= 2 and (
        (text[0] == text[-1] and text[0] in "\"'`") or (text[0] == "<" and text[-1] == ">")
    ):
        text = text[1:-1].strip()
    return text


def parse_token(raw: str) -> str:
    """Accept the bare token, or the same token wrapped in BotFather's message / a `bot` prefix."""
    text = _unwrap(raw)
    if text.lower().startswith("bot") and TOKEN_RE.match(text[3:]):
        text = text[3:]
    if TOKEN_RE.match(text):
        return text
    trimmed = text.rstrip(".,;")
    if TOKEN_RE.match(trimmed):
        return trimmed
    found = TOKEN_IN_TEXT_RE.findall(text)
    if found:
        return max(found, key=len)
    raise ConnectError("That does not look like a bot API key. Copy the whole token from @BotFather, e.g. 123456789:AAH…")


def parse_user_id(raw: str) -> int:
    text = _unwrap(raw)
    if USER_ID_RE.match(text):
        return int(text)
    labeled = USER_ID_LABEL_RE.search(text)
    if labeled:
        return int(labeled.group(1))
    raise ConnectError("The user ID must be a whole number, e.g. 123456789. Ask @userinfobot on Telegram for yours.")


def _call(
    client: httpx.Client,
    api_url: str,
    token: str,
    method: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    url = f"{api_url}/bot{token}/{method}"
    try:
        response = client.post(url, json=payload or {})
    except httpx.HTTPError as exc:
        # Only the exception's class name: the message can contain the request URL, which holds the token.
        raise ConnectError(
            f"could not reach Telegram at {api_url} ({type(exc).__name__}). Check the internet connection and TELEGRAM_API_URL."
        ) from None
    try:
        data = response.json()
    except ValueError:
        data = {}
    if not isinstance(data, dict) or not data.get("ok"):
        description = data.get("description") if isinstance(data, dict) else None
        error_code = data.get("error_code") if isinstance(data, dict) else None
        try:
            status = int(error_code) if error_code else response.status_code
        except (TypeError, ValueError):
            status = response.status_code
        raise ConnectError(description or f"Telegram answered HTTP {response.status_code}", status)
    return data.get("result")


def _client(transport: httpx.BaseTransport | None) -> httpx.Client:
    return httpx.Client(timeout=TIMEOUT_SECONDS, transport=transport)


def check_token(token: str, api_url: str, *, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    """Ask Telegram who the bot is. Raises ConnectError if the key is not accepted."""
    with _client(transport) as client:
        try:
            me = _call(client, api_url, token, "getMe")
        except ConnectError as exc:
            # Telegram answers 401 for a wrong key (sometimes as HTTP 200 + error_code 401).
            # A local Bot API server may answer 404.
            if exc.status in (401, 404) or "unauthorized" in str(exc).lower():
                raise ConnectError("Telegram did not accept this API key. Check it in @BotFather (/token) and try again.") from None
            raise
    if not isinstance(me, dict):
        raise ConnectError("Telegram sent an unexpected answer to getMe.")
    return me


def webhook_url(token: str, api_url: str, *, transport: httpx.BaseTransport | None = None) -> str | None:
    """The URL the bot's webhook points at, or None. A webhook stops polling from receiving updates."""
    with _client(transport) as client:
        info = _call(client, api_url, token, "getWebhookInfo")
    if isinstance(info, dict):
        return info.get("url") or None
    return None


def send_confirmation(
    token: str, api_url: str, user_id: int, *, transport: httpx.BaseTransport | None = None
) -> str | None:
    """Message the user. Returns None when it was sent, otherwise why Telegram refused."""
    try:
        with _client(transport) as client:
            _call(client, api_url, token, "sendMessage", {"chat_id": user_id, "text": CONFIRMATION})
    except ConnectError as exc:
        return str(exc)
    return None


def update_env_text(text: str, updates: dict[str, str]) -> str:
    """Set KEY=value for each key, keeping every other line.

    An active ``KEY=`` line is replaced (duplicates are dropped). A commented placeholder such as
    ``# ALLOWED_USER_IDS=123456789`` is turned into the real line. A key with no line is appended.
    """
    result: list[str] = []
    written: set[str] = set()
    for line in text.splitlines():
        match = _ASSIGNMENT_RE.match(line)
        key = match.group(1) if match else None
        if key in updates:
            if key not in written:
                result.append(f"{key}={updates[key]}")
                written.add(key)
            continue
        result.append(line)

    for key, value in updates.items():
        if key in written:
            continue
        for index, line in enumerate(result):
            commented = _COMMENTED_ASSIGNMENT_RE.match(line)
            if commented and commented.group(1) == key:
                result[index] = f"{key}={value}"
                break
        else:
            if result and result[-1].strip():
                result.append("")
            result.append(f"{key}={value}")
        written.add(key)

    return "\n".join(result) + "\n"


def write_env_file(path: Path, updates: dict[str, str]) -> None:
    """Update .env in place (or create it from .env.example). The file is private: it holds the token."""
    if path.exists():
        current = path.read_text(encoding="utf-8")
    else:
        template = path.with_name(".env.example")
        current = template.read_text(encoding="utf-8") if template.exists() else ""
    new_text = update_env_text(current, updates)

    temporary = path.with_name(path.name + ".tmp")
    if temporary.exists():
        temporary.unlink()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(new_text)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def default_env_path() -> Path:
    """The .env the bot itself reads (the same search python-dotenv does), else the repository root."""
    found = find_dotenv()
    return Path(found) if found else _REPO_ROOT / ".env"


def _ask(prompt: Callable[[], str], parse: Callable[[str], Any], out: Callable[[str], Any]) -> Any:
    for _ in range(ATTEMPTS):
        try:
            return parse(prompt())
        except ConnectError as exc:
            out(f"  {exc}")
    raise ConnectError("too many invalid answers, nothing was saved")


def run_cli(
    argv: list[str],
    *,
    prompt_secret: Callable[[str], str] = getpass.getpass,
    prompt: Callable[[str], str] = input,
    transport: httpx.BaseTransport | None = None,
    out: Callable[[str], Any] = print,
) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m video_convertor_bot connect",
        description="Connect the bot: check its API key, allow one Telegram user, and save both to .env.",
    )
    parser.add_argument("--user-id", help="your Telegram user ID (asked for if omitted)")
    parser.add_argument("--env-file", help="the .env file to update (default: the one the bot reads)")
    args = parser.parse_args(argv)

    env_path = Path(args.env_file) if args.env_file else default_env_path()
    existing = dotenv_values(env_path) if env_path.exists() else {}
    api_url = (os.environ.get("TELEGRAM_API_URL") or existing.get("TELEGRAM_API_URL") or DEFAULT_API_URL).rstrip("/")

    try:
        user_id = parse_user_id(args.user_id) if args.user_id is not None else None
        out("Connect the bot. Get the API key from @BotFather (/newbot, or /token for an existing bot).")
        token = _ask(lambda: prompt_secret("Bot API key (hidden): "), parse_token, out)
        if user_id is None:
            out("Your Telegram user ID: ask @userinfobot on Telegram. Only this user will be allowed to use the bot.")
            user_id = _ask(lambda: prompt("Your Telegram user ID: "), parse_user_id, out)

        me = check_token(token, api_url, transport=transport)
        name = f"@{me['username']}" if me.get("username") else me.get("first_name", "the bot")
        out(f"Telegram accepted the key: {name}.")

        try:
            hook = webhook_url(token, api_url, transport=transport)
        except ConnectError:
            hook = None
        if hook:
            out(
                "Warning: this bot has a webhook set (the web app sets one). The bot cannot poll for messages "
                "while a webhook is set: run the web app, or delete the webhook in Settings → Telegram."
            )

        write_env_file(env_path, {"BOT_TOKEN": token, "ALLOWED_USER_IDS": str(user_id)})
        out(f"Saved BOT_TOKEN and ALLOWED_USER_IDS to {env_path}.")

        problem = send_confirmation(token, api_url, user_id, transport=transport)
        if problem is None:
            out("Sent you a confirmation message on Telegram.")
        else:
            out(
                f"Saved, but the confirmation message was not delivered ({problem}). "
                "Open the bot in Telegram and press Start, then send it a video."
            )
        out("Start the bot with: python -m video_convertor_bot")
        return 0
    except ConnectError as exc:
        out(f"error: {exc}")
        return 1
    except (EOFError, KeyboardInterrupt):
        out("\ncancelled, nothing was saved")
        return 1
    except OSError as exc:
        out(f"error: could not write {env_path}: {exc.strerror or exc}")
        return 1
