"""`python -m video_convertor_bot connect`: checks the key, saves .env, confirms with the user.

No real Telegram account is needed: Telegram's answers are simulated with httpx.MockTransport,
and one test runs the command against the fake Bot API server over real HTTP.
"""

import io
import json
import os
from pathlib import Path

import httpx
import pytest
from dotenv import dotenv_values

from tests.fake_telegram import FakeBotApi
from video_convertor_bot import connect
from video_convertor_bot.config import load_settings
from video_convertor_bot.connect import (
    ConnectError,
    parse_token,
    parse_user_id,
    run_cli,
    update_env_text,
    write_env_file,
)

TOKEN = "123456:ABC-def_123"
ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"


def _reply(ok: bool, payload) -> httpx.Response:
    body = {"ok": True, "result": payload} if ok else payload
    return httpx.Response(200 if ok else 401, json=body)


def fake_telegram(
    *,
    token: str = TOKEN,
    webhook: str | None = None,
    delivered: bool = True,
    seen: list[tuple[str, dict]] | None = None,
) -> httpx.MockTransport:
    """Telegram's answers for the three calls the command makes."""

    def handle(request: httpx.Request) -> httpx.Response:
        prefix = f"/bot{token}/"
        if not request.url.path.startswith(prefix):
            return _reply(False, {"ok": False, "error_code": 401, "description": "Unauthorized"})
        method = request.url.path[len(prefix) :]
        fields = json.loads(request.content or b"{}")
        if seen is not None:
            seen.append((method, fields))
        if method == "getMe":
            return _reply(True, {"id": 42, "is_bot": True, "first_name": "Converter", "username": "test_convertor_bot"})
        if method == "getWebhookInfo":
            return _reply(True, {"url": webhook or "", "pending_update_count": 0})
        if method == "sendMessage":
            if not delivered:
                return _reply(False, {"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation with a user"})
            return _reply(True, {"message_id": 1, "chat": {"id": fields["chat_id"]}})
        return _reply(True, True)

    return httpx.MockTransport(handle)


@pytest.fixture(autouse=True)
def _no_api_url_override(monkeypatch):
    monkeypatch.delenv("TELEGRAM_API_URL", raising=False)


def _run(env_file: Path, argv: list[str], transport, prompts=None, secrets=None):
    """Run the command with scripted answers. Returns (exit code, printed lines)."""
    lines: list[str] = []
    secret_answers = iter(secrets or [TOKEN])
    prompt_answers = iter(prompts or [])
    code = run_cli(
        ["--env-file", str(env_file), *argv],
        prompt_secret=lambda _: next(secret_answers),
        prompt=lambda _: next(prompt_answers),
        transport=transport,
        out=lambda text="": lines.append(str(text)),
    )
    return code, "\n".join(lines)


# --- parsing -----------------------------------------------------------------


@pytest.mark.parametrize("raw", [f"  {TOKEN}\n", "7:abc"])
def test_a_token_in_the_botfather_format_is_accepted(raw):
    assert parse_token(raw) == raw.strip()


@pytest.mark.parametrize("raw", ["", "not-a-token", "123456", "12:has space", "abc:def"])
def test_a_bad_token_is_refused(raw):
    with pytest.raises(ConnectError, match="does not look like a bot API key"):
        parse_token(raw)


@pytest.mark.parametrize("raw,expected", [("123456789", 123456789), (" 42 ", 42)])
def test_a_user_id_is_a_positive_number(raw, expected):
    assert parse_user_id(raw) == expected


@pytest.mark.parametrize("raw", ["", "0", "-5", "12.5", "alice", "@alice", "0123", "1" * 16])
def test_a_bad_user_id_is_refused(raw):
    with pytest.raises(ConnectError, match="whole number"):
        parse_user_id(raw)


# --- .env editing ------------------------------------------------------------


def test_the_template_placeholders_become_real_settings_and_the_rest_is_kept():
    template = ENV_EXAMPLE.read_text(encoding="utf-8")
    updated = update_env_text(template, {"BOT_TOKEN": TOKEN, "ALLOWED_USER_IDS": "555"})

    assert f"\nBOT_TOKEN={TOKEN}\n" in updated
    assert "\nALLOWED_USER_IDS=555\n" in updated
    assert "# ALLOWED_USER_IDS=" not in updated  # the placeholder was replaced, not duplicated
    # Everything else in the template is still there, line for line.
    assert "# TELEGRAM_API_URL=http://127.0.0.1:8081" in updated
    assert "# Who sends the converted file back to Telegram" in updated
    # And the result is a valid bot configuration.
    values = {key: value for key, value in dotenv_values(stream=io.StringIO(updated)).items() if value}
    settings = load_settings(values)
    assert settings.bot_token == TOKEN
    assert settings.allowed_user_ids == frozenset({555})


def test_duplicate_assignments_are_collapsed_into_one():
    text = "BOT_TOKEN=old\nLOG_LEVEL=INFO\nBOT_TOKEN=older\n"
    updated = update_env_text(text, {"BOT_TOKEN": TOKEN})
    assert updated.count("BOT_TOKEN=") == 1
    assert f"BOT_TOKEN={TOKEN}" in updated
    assert "LOG_LEVEL=INFO" in updated


def test_a_missing_key_is_appended():
    updated = update_env_text("LOG_LEVEL=INFO\n", {"ALLOWED_USER_IDS": "7"})
    assert updated == "LOG_LEVEL=INFO\n\nALLOWED_USER_IDS=7\n"


def test_updating_twice_gives_the_same_file():
    once = update_env_text(ENV_EXAMPLE.read_text(encoding="utf-8"), {"BOT_TOKEN": TOKEN, "ALLOWED_USER_IDS": "9"})
    twice = update_env_text(once, {"BOT_TOKEN": TOKEN, "ALLOWED_USER_IDS": "9"})
    assert once == twice


def test_a_new_env_file_is_created_from_the_template_and_is_private(tmp_path):
    (tmp_path / ".env.example").write_text("# template\nLOG_LEVEL=INFO\n", encoding="utf-8")
    target = tmp_path / ".env"
    write_env_file(target, {"BOT_TOKEN": TOKEN, "ALLOWED_USER_IDS": "1"})

    assert target.read_text(encoding="utf-8").startswith("# template\nLOG_LEVEL=INFO\n")
    assert f"BOT_TOKEN={TOKEN}" in target.read_text(encoding="utf-8")
    assert (os.stat(target).st_mode & 0o777) == 0o600
    assert not (tmp_path / ".env.tmp").exists()


# --- the command -------------------------------------------------------------


def test_connect_saves_the_key_and_user_and_confirms(tmp_path):
    env_file = tmp_path / ".env"
    seen: list[tuple[str, dict]] = []
    code, output = _run(env_file, ["--user-id", "555"], fake_telegram(seen=seen))

    assert code == 0
    saved = env_file.read_text(encoding="utf-8")
    assert f"BOT_TOKEN={TOKEN}" in saved
    assert "ALLOWED_USER_IDS=555" in saved
    assert "@test_convertor_bot" in output
    assert "Sent you a confirmation message" in output
    assert TOKEN not in output  # the key is never printed
    confirmations = [fields for method, fields in seen if method == "sendMessage"]
    assert confirmations == [{"chat_id": 555, "text": connect.CONFIRMATION}]


def test_the_user_id_and_key_are_asked_for_when_not_given(tmp_path):
    env_file = tmp_path / ".env"
    code, _ = _run(env_file, [], fake_telegram(), prompts=["not-a-number", "777"], secrets=["bad-key", TOKEN])
    assert code == 0
    assert "ALLOWED_USER_IDS=777" in env_file.read_text(encoding="utf-8")


def test_a_key_telegram_rejects_saves_nothing(tmp_path):
    env_file = tmp_path / ".env"
    code, output = _run(env_file, ["--user-id", "555"], fake_telegram(token="999:OTHER"))

    assert code == 1
    assert "did not accept this API key" in output
    assert not env_file.exists()


def test_a_warning_is_shown_when_a_webhook_is_set(tmp_path):
    env_file = tmp_path / ".env"
    code, output = _run(env_file, ["--user-id", "555"], fake_telegram(webhook="https://example.test/api/telegram/webhook/s"))
    assert code == 0
    assert "webhook" in output and "cannot poll" in output
    assert env_file.exists()  # saved anyway: the person may still want this key


def test_an_undelivered_confirmation_is_explained_not_fatal(tmp_path):
    env_file = tmp_path / ".env"
    code, output = _run(env_file, ["--user-id", "555"], fake_telegram(delivered=False))
    assert code == 0
    assert "press Start" in output
    assert "ALLOWED_USER_IDS=555" in env_file.read_text(encoding="utf-8")


def test_an_unreachable_telegram_is_reported_without_the_token(tmp_path):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"refused: {request.url}")

    env_file = tmp_path / ".env"
    code, output = _run(env_file, ["--user-id", "555"], httpx.MockTransport(refuse))
    assert code == 1
    assert "could not reach Telegram" in output
    assert "ConnectError" in output
    assert TOKEN not in output
    assert not env_file.exists()


def test_the_command_works_end_to_end_against_a_bot_api_server(tmp_path, monkeypatch):
    server = FakeBotApi(TOKEN)
    server.start()
    try:
        monkeypatch.setenv("TELEGRAM_API_URL", server.url)
        env_file = tmp_path / ".env"
        code, output = _run(env_file, ["--user-id", "4242"], None)
        assert code == 0, output
        assert f"BOT_TOKEN={TOKEN}" in env_file.read_text(encoding="utf-8")
        sent = server.calls_to("sendMessage")
        assert sent and sent[0].fields["chat_id"] == 4242
    finally:
        server.stop()
