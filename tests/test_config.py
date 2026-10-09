import pytest

from video_convertor_bot.config import (
    CLOUD_DOWNLOAD_LIMIT_MB,
    LOCAL_SERVER_LIMIT_MB,
    MAX_UPLOAD_MB,
    ConfigError,
    Settings,
    load_settings,
)

TOKEN = "123456:ABC-def_123"


def env(**extra):
    return {"BOT_TOKEN": TOKEN, **extra}


def test_defaults_match_the_quality_target():
    s = load_settings(env())
    assert s.api_url == "https://api.telegram.org"
    assert s.crf == 20
    assert s.preset == "medium"
    assert s.max_input_mb == CLOUD_DOWNLOAD_LIMIT_MB
    assert s.max_concurrent_jobs == 1
    assert s.local_mode is False
    assert s.allowed_user_ids == frozenset()
    assert s.uses_local_server is False
    assert s.upload_limit_bytes == 50 * 1_000_000


def test_missing_token_is_explained():
    with pytest.raises(ConfigError, match="BOT_TOKEN is not set"):
        load_settings({})


@pytest.mark.parametrize("token", ["not-a-token", "123456", "12:has space"])
def test_malformed_token_is_rejected(token):
    with pytest.raises(ConfigError, match="does not look like"):
        load_settings({"BOT_TOKEN": token})


def test_a_bot_prefix_on_the_token_is_stripped():
    s = load_settings({"BOT_TOKEN": f"bot{TOKEN}"})
    assert s.bot_token == TOKEN


@pytest.mark.parametrize("value", ["99", "-1", "abc"])
def test_crf_must_be_a_valid_number(value):
    with pytest.raises(ConfigError, match="CRF"):
        load_settings(env(CRF=value))


def test_preset_is_validated_and_case_insensitive():
    assert load_settings(env(X265_PRESET="SLOW")).preset == "slow"
    with pytest.raises(ConfigError, match="X265_PRESET"):
        load_settings(env(X265_PRESET="turbo"))


def test_local_mode_requires_a_local_server_url():
    with pytest.raises(ConfigError, match="TELEGRAM_LOCAL_MODE"):
        load_settings(env(TELEGRAM_LOCAL_MODE="true"))


def test_local_server_raises_the_limits():
    s = load_settings(env(TELEGRAM_API_URL="http://127.0.0.1:8081/", TELEGRAM_LOCAL_MODE="yes"))
    assert s.api_url == "http://127.0.0.1:8081"  # trailing slash removed
    assert s.local_mode is True
    assert s.uses_local_server is True
    assert s.max_input_mb == MAX_UPLOAD_MB == 1000
    assert s.upload_limit_bytes == LOCAL_SERVER_LIMIT_MB * 1_000_000


def test_max_input_cannot_exceed_one_gigabyte():
    local = env(TELEGRAM_API_URL="http://127.0.0.1:8081", TELEGRAM_LOCAL_MODE="true")
    assert load_settings({**local, "MAX_INPUT_MB": "1000"}).max_input_mb == 1000
    with pytest.raises(ConfigError):
        load_settings({**local, "MAX_INPUT_MB": "1001"})
    # A Settings object built directly with a larger value still never accepts more than 1 GB.
    s = Settings(bot_token=TOKEN, max_input_mb=2000)
    assert s.max_input_bytes == MAX_UPLOAD_MB * 1_000_000


def test_local_server_without_local_mode_keeps_the_download_cap():
    s = load_settings(env(TELEGRAM_API_URL="http://127.0.0.1:8081"))
    assert s.max_input_mb == CLOUD_DOWNLOAD_LIMIT_MB
    assert s.upload_limit_bytes == LOCAL_SERVER_LIMIT_MB * 1_000_000


def test_api_url_must_be_http():
    with pytest.raises(ConfigError, match="http"):
        load_settings(env(TELEGRAM_API_URL="localhost:8081"))


def test_allowed_user_ids_are_parsed():
    s = load_settings(env(ALLOWED_USER_IDS=" 111, 222 ,333,"))
    assert s.allowed_user_ids == frozenset({111, 222, 333})


def test_allowed_user_ids_must_be_numbers():
    with pytest.raises(ConfigError, match="ALLOWED_USER_IDS"):
        load_settings(env(ALLOWED_USER_IDS="alice"))


@pytest.mark.parametrize("value,expected", [("true", True), ("0", False), ("OFF", False)])
def test_booleans(value, expected):
    s = load_settings(env(TELEGRAM_API_URL="http://127.0.0.1:8081", TELEGRAM_LOCAL_MODE=value))
    assert s.local_mode is expected


def test_bad_boolean_is_rejected():
    with pytest.raises(ConfigError, match="true or false"):
        load_settings(env(TELEGRAM_API_URL="http://127.0.0.1:8081", TELEGRAM_LOCAL_MODE="maybe"))


def test_log_level_is_validated():
    with pytest.raises(ConfigError, match="LOG_LEVEL"):
        load_settings(env(LOG_LEVEL="LOUD"))


def test_encode_options_follow_settings():
    s = load_settings(env(CRF="18", X265_PRESET="slow", FFMPEG_BIN="/opt/ff/ffmpeg", FFMPEG_TIMEOUT_SECONDS="900"))
    opts = s.encode_options
    assert (opts.crf, opts.preset, opts.ffmpeg, opts.timeout_seconds) == (18, "slow", "/opt/ff/ffmpeg", 900.0)
