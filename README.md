# video_convertor-for-iphone

A Telegram bot that makes iPhone videos smaller while keeping them looking the same as the original recording.

Send the bot a video. It re-encodes it to HEVC (H.265), the codec iPhones record in by default, and sends back a smaller file with:

- the same resolution, orientation and frame rate
- the same 10-bit colour and HDR tags (HLG or HDR10)
- the same sound (AAC audio is copied without re-encoding)
- the same capture date and GPS location

The reply shows the before and after sizes. If re-encoding would not make a file smaller, the bot sends your original back.

> **Status:** the converter and the bot are tested with ffmpeg 7.0 and python-telegram-bot 22.8 on Linux. Talking to real Telegram (and to Telegram's local server) has **not** been tested from the environment this was built in. Try it with your own bot token first. The macOS steps below use Homebrew and have not been run on a Mac.

---

## Send videos as a File

Telegram compresses a video that is sent as **Photo or Video** before the bot ever sees it. To send the original:

1. In the bot's chat, tap the 📎 attachment button.
2. Choose **File** (not Photo or Video) and pick the video.

The bot receives the untouched recording, so the output is only as good as the original.

The bot works in private chats only.

---

## Quality

**What is kept:** resolution, frame rate, orientation, 10-bit depth, HDR colour description, audio (copied bit-for-bit when it is AAC, which iPhones record), and the container metadata (capture date and GPS location).

**What is not kept exactly:** the pictures. A smaller file is always a re-encode, so it can never be bit-for-bit identical to the original. The default setting (CRF 20, preset `medium`) aims for a difference you cannot see when watching. On the test clip below it scores in the range generally considered visually transparent, and I have not compared it by eye on real footage.

Measured on a synthetic 6-second 1080p portrait HDR clip (noisy, so it is harder to compress than most real footage):

| Setting | Size vs original | PSNR | SSIM | VMAF |
|---|---|---|---|---|
| `CRF=18` | 26% smaller | 47.5 dB | 0.9912 | 98.1 |
| **`CRF=20` (default)** | **42% smaller** | **46.3 dB** | **0.9901** | **97.5** |
| `CRF=22` | 53% smaller | 45.0 dB | 0.9891 | 96.8 |
| `CRF=24` | 61% smaller | 43.6 dB | 0.9879 | 95.7 |

Real footage will save a different amount. Busy, noisy footage saves less, and a clip that is already heavily compressed may come back unchanged. To check any pair of files yourself, see [Checking quality](#checking-quality).

Limitations to know about:

- **Dolby Vision:** the Dolby Vision enhancement layer is not carried over. The HDR base picture is kept. I could not test with a real Dolby Vision file.
- **ProRes and other 4:2:2 sources:** converted to 4:2:0, the format iPhones and most players decode in hardware. This slightly reduces colour detail.

---

## Setup

### 1. Create the bot

In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts. It gives you a token that looks like `123456789:AA...`. Keep it private.

### 2. Install ffmpeg

On macOS with Homebrew:

```bash
brew install ffmpeg
```

Homebrew's ffmpeg includes the `libx265` HEVC encoder and `ffprobe`. On Linux, any ffmpeg build with `libx265` works.

### 3. Install the bot

Requires Python 3.10 or newer.

```bash
cd video_convertor-for-iphone
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Open `.env` and set `BOT_TOKEN` to the token from BotFather.

### 4. Run it

```bash
python -m video_convertor_bot
```

Open your bot in Telegram, send `/start`, then send it a video as a File.

Set `ALLOWED_USER_IDS` in `.env` to your own Telegram user ID (any "my user ID" bot on Telegram will tell you it). Without it, anyone who finds the bot can use it, and each conversion uses your computer's CPU.

---

## Size limits and the local server

Telegram's public bot server limits what a bot can handle:

| | Public Telegram server (default) | Local Bot API server (`--local`) |
|---|---|---|
| Videos the bot can receive | up to **20 MB** | no Telegram limit (the bot allows 2000 MB by default, see `MAX_INPUT_MB`) |
| Files the bot can send | up to **50 MB** | up to **2000 MB** |

Most iPhone clips are bigger than 20 MB, so for real use you need the local server. It is Telegram's open-source Bot API server, run on the same Mac as the bot. The bot then copies the video from the server's disk instead of downloading it over the network.

1. **Get an API ID and hash.** Log in at [my.telegram.org](https://my.telegram.org), open *API development tools*, and create an application. You get an `api_id` and an `api_hash`. See [Telegram's guide](https://core.telegram.org/api/obtaining_api_id).
2. **Build the server** from the [official build instructions](https://tdlib.github.io/telegram-bot-api/build.html). Choose macOS on that page. It is compiled from source and takes a while.
3. **Stop the bot**, then log the bot out of the public server once. This makes sure the local server gets all of the bot's updates:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/logOut"
   ```
   After this, the bot cannot use `api.telegram.org` for 10 minutes. This only matters if you switch back.
4. **Start the server** and leave it running:
   ```bash
   telegram-bot-api --api-id=<api_id> --api-hash=<api_hash> --local --http-port=8081
   ```
   The server saves the files it downloads in its working directory, in a folder for each bot. Clear old files there if disk space gets low.
5. **Point the bot at it** by adding these lines to `.env`:
   ```ini
   TELEGRAM_API_URL=http://127.0.0.1:8081
   TELEGRAM_LOCAL_MODE=true
   ```
6. **Start the bot** again with `python -m video_convertor_bot`.

Keep the bot and the server on the same machine. Local mode needs both to see the same files.

---

## Settings

All settings are environment variables, or lines in `.env`. See `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `BOT_TOKEN` | *(required)* | Token from @BotFather. |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Use `http://127.0.0.1:8081` for the local server. |
| `TELEGRAM_LOCAL_MODE` | `false` | Set `true` only with a local server started with `--local`. |
| `ALLOWED_USER_IDS` | *(empty: anyone)* | Comma-separated Telegram user IDs allowed to use the bot. |
| `CRF` | `20` | Quality, 0 to 51. Lower is closer to the original and bigger. 18 to 22 is the useful range. |
| `X265_PRESET` | `medium` | Encoder speed. Slower presets give slightly smaller files and take much longer. |
| `MAX_INPUT_MB` | `20`, or `2000` in local mode | Largest video the bot accepts. |
| `MAX_CONCURRENT_JOBS` | `1` | Conversions running at once. Others wait in a queue. |
| `FFMPEG_TIMEOUT_SECONDS` | `7200` | Stop a conversion that runs longer than this. |
| `FFMPEG_BIN`, `FFPROBE_BIN` | `ffmpeg`, `ffprobe` | Paths to the binaries, if they are not on `PATH`. |
| `WORK_DIR` | system temp folder | Where temporary files go. Each job's files are deleted afterwards. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR`. |

Encoding is CPU-heavy. I measured about 0.3 to 0.4 times real time at 1080p with the `medium` preset on a small 2-core Linux machine. Your Mac will differ. Expect a few minutes for a long clip, and watch the progress percentage in the chat.

---

## Checking quality

`scripts/compare_quality.sh` compares a converted file with your original:

```bash
scripts/compare_quality.sh IMG_1234.MOV IMG_1234_small.mp4
```

It prints the sizes, PSNR, SSIM and, if your ffmpeg has `libvmaf` (Homebrew's does), VMAF. As rough rules of thumb, PSNR above about 40 dB, SSIM above about 0.98 and VMAF above about 93 are hard to tell apart from the original.

---

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest
```

The tests need `ffmpeg` and `ffprobe` on your `PATH`. Tests that need them are skipped if they are missing.

- **Unit tests** cover settings, ffprobe parsing, the encode command, progress parsing and the output checks.
- **Integration tests** generate small iPhone-style clips with ffmpeg and run real encodes. They check the orientation, colour tags, audio, metadata and quality of the output.
- **End-to-end tests** run the real bot against a fake Telegram Bot API server in `tests/fake_telegram.py`. They send it updates, check the messages and uploads it produces, and run the actual `python -m video_convertor_bot` polling loop. They need no internet access and no bot token.

Not covered by the tests: live Telegram traffic and Telegram's own local server. Those need a real bot and a real iPhone video.

---

## Troubleshooting

- **"ffmpeg was not found"**: install it (`brew install ffmpeg`), or set `FFMPEG_BIN` and `FFPROBE_BIN`.
- **"this ffmpeg build has no libx265 (HEVC) encoder"**: install a full ffmpeg build, such as Homebrew's.
- **"Telegram's standard bot server only lets bots download files up to 20 MB"**: set up the [local server](#size-limits-and-the-local-server).
- **"Converting this video took too long"**: raise `FFMPEG_TIMEOUT_SECONDS`, or try `X265_PRESET=fast` (files will be a little bigger).
- **"Something went wrong while converting"**: the details are in the log. Run with `LOG_LEVEL=DEBUG` to see more.

The bot does not log the bot token at the default log level.

---

## Project layout

```
video_convertor_bot/
  config.py     settings from environment variables and .env
  media.py      ffprobe, the ffmpeg command, progress and output checks
  pipeline.py   converts one video, then decides whether to send the converted or the original file
  bot.py        Telegram handlers, the application and the entry point
tests/          unit, ffmpeg integration and fake Bot API end-to-end tests
scripts/compare_quality.sh   compares a converted file with the original
```
