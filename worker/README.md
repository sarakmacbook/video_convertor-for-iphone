# The conversion worker

The web app converts short clips inside a serverless function and queues everything else. This
worker picks those queued jobs up and converts them here, on a machine that has ffmpeg — a Mac
mini, a VPS, a Raspberry Pi, or the same machine that runs your Telegram bot.

It reuses the Telegram bot's pipeline (`video_convertor_bot/pipeline.py`), so a video converted
by the worker is the same as one converted by the bot, and it shares the bot's tests.

## What it needs

- Python 3.10+ and ffmpeg (with `libx265`)
- The URL of your deployment and its `WORKER_SECRET`
- Nothing else: the app hands out signed URLs for the input and the output, so there are no
  database credentials and no storage keys on this machine

## Run it

```bash
pip install -r requirements.txt

APP_URL=https://your-app.vercel.app \
WORKER_SECRET=the-value-from-your-deployment \
python -m worker
```

Useful flags:

| Flag | What it does |
|---|---|
| `--once` | Convert at most one job and exit — handy from cron |
| `--status` | Check the connection and print the queue, then exit |
| `--name` | The name shown on the deployment's Settings page (default: the hostname) |
| `--concurrency` | Jobs at once (default 1 — x265 is CPU-bound) |
| `--poll` | Seconds between polls when the queue is empty (default 5) |
| `--ffmpeg` / `--ffprobe` | Paths to the binaries, if they are not on `PATH` |

Environment variables are the same, in `WORKER_*` form: `WORKER_NAME`,
`WORKER_CONCURRENCY`, `WORKER_POLL_SECONDS`, plus `APP_URL`, `WORKER_SECRET`, `LOG_LEVEL`,
`FFMPEG_BIN`, `FFPROBE_BIN`, `FFMPEG_TIMEOUT_SECONDS`.

## Keeping it running

**launchd (macOS)** — save as `~/Library/LaunchAgents/com.example.convertor-worker.plist` and
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.convertor-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/video_convertor-for-iphone/.venv/bin/python</string>
    <string>-m</string>
    <string>worker</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/video_convertor-for-iphone</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APP_URL</key><string>https://your-app.vercel.app</string>
    <key>WORKER_SECRET</key><string>…</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

**systemd (Linux)** — `/etc/systemd/system/convertor-worker.service`:

```ini
[Unit]
Description=Video converter worker
After=network-online.target

[Service]
WorkingDirectory=/opt/video_convertor-for-iphone
Environment=APP_URL=https://your-app.vercel.app
Environment=WORKER_SECRET=…
ExecStart=/opt/video_convertor-for-iphone/.venv/bin/python -m worker
Restart=always
RestartSec=10
User=convertor

[Install]
WantedBy=multi-user.target
```

**Docker** — `docker compose up --build` starts the app, SQLite and this worker together; see
`docker-compose.yml`.

## Videos over 20 MB (local Bot API server)

With a [local Bot API server](../../README.md#size-limits-and-the-local-server) the app on Vercel
cannot reach Telegram, so the worker does the delivery:

1. On the deployment: `TELEGRAM_API_URL=http://…`, `TELEGRAM_LOCAL_MODE=true`,
   `TELEGRAM_DELIVERY=worker`.
2. On the worker: the same two variables, plus `BOT_TOKEN` — that is the only secret this worker
   ever needs, and only in this mode.

The claim response then contains the incoming video's `file_id`; the worker downloads it from
your local server, converts it, sends the result to the chat, and reports back.

## What it does with a job

1. `POST /api/worker/claim` — asks for work; the answer contains signed URLs and the encoding
   settings for this job.
2. Downloads the original (from storage, or from Telegram in local mode).
3. Converts it with the bot's pipeline — same `libx265` command, same HDR and metadata handling.
4. Uploads the result to the signed upload URL (or keeps your original when re-encoding would
   make it bigger).
5. Reports progress as it goes (`progress` every 2%) and the outcome at the end. While it works
   it re-registers every 90 seconds so the deployment knows it is alive.

If the worker is killed mid-job, the deployment notices when the job's lease expires (2 minutes),
puts the job back in the queue and another worker — or the next start of this one — finishes it.
