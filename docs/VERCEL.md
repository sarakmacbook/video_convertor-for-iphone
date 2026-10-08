# Deploying the web app on Vercel

The repository stays the same project: the Telegram bot you already have, plus a web UI, an API
and a Telegram webhook that run on Vercel. Your database and your storage are your choice — the
app reads both from environment variables, and everything else can be changed from the Settings
page without a redeploy.

```
   browser ──upload──▶ Vercel Blob / S3  ◀──signed URL── worker (your Mac, a VPS, Docker)
      │                                            ▲
      ▼                                            │ claim / progress / complete
   Vercel:  web UI · API · Telegram webhook ────────┘
      │            │
      │            └── short clips are converted inside a function (ffmpeg in /tmp)
      └──▶ Postgres · MySQL · SQLite · Turso  (jobs, settings, workers)
```

There are two ways to convert:

- **Inline**, inside the Vercel function, for short clips. Only while a request can be held open
  (60 s on the Hobby plan, up to 300 s on Pro), and only while the result still fits in the
  function's memory and disk.
- **Queued**, for everything else. The job sits in the database until a worker claims it. A
  worker is `npm run worker` on any machine with ffmpeg, or `python -m worker` using the same
  Python pipeline as the Telegram bot.

Nothing times out silently: a job that is claimed and then abandoned by a crashed worker is
returned to the queue automatically.

---

## 1. Deploy the app

```bash
npm install
npx vercel            # link the folder, then deploy
npx vercel --prod     # promote it when the preview looks right
```

Or import the repository in the Vercel dashboard. Either way, set the environment variables
(section 3) before the first deploy — the app starts, but the Settings page will tell you what
is missing.

Requirements: **Node 20.9 or newer** (Node 22 is what Vercel gives you today; `engines` in
`package.json` says `>=20.9`). No build step beyond `next build`.

### First run

The database schema is created automatically the first time the app talks to the database. To do
it yourself — or to see which database you are actually connected to — run:

```bash
DATABASE_URL="postgres://…" npm run db:migrate
```

The migration is idempotent and safe to run repeatedly.

---

## 2. Choose a database and a storage driver

### Databases

`DATABASE_URL` decides. Four dialects are supported, chosen purely by the connection string:

| Service | `DATABASE_URL` |
|---|---|
| Neon | `postgres://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require` |
| Vercel Postgres | `postgres://…` — copy the URL from the Storage tab |
| Supabase | `postgres://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` |
| Any Postgres | `postgres://user:password@host:5432/dbname?sslmode=require` |
| PlanetScale | `mysql://user:password@aws.connect.psdb.cloud/dbname?ssl={"rejectUnauthorized":true}` |
| Any MySQL | `mysql://user:password@host:3306/dbname` |
| Turso | `libsql://db-name-yourname.turso.io?authToken=eyJ…` |
| Local SQLite (Docker, a VM, a mounted volume) | `file:./.data/app.db` or `/var/lib/convertor/app.db` |

Notes:

- Connection strings in `.env` need quotes when they contain `&` or `{`/`}`.
- Serverless Postgres/MySQL providers and poolers work; if your provider offers a pooled and a
  direct URL, the pooled one is the right choice for the app, and the direct one for
  `npm run db:migrate` if migrations fail through the pooler.
- SQLite is fine in Docker with a volume, but **not** on Vercel: functions have a read-only
  filesystem apart from `/tmp`, which disappears between requests.
- The password/token is masked everywhere it is displayed, including the Settings page.

### Storage

`STORAGE_DRIVER` decides. Uploads always go from the browser straight to storage with a signed
URL — never through a function — so the 4.5 MB request body limit does not apply.

**Vercel Blob** (default on Vercel):

1. In the Vercel dashboard: *Storage* → *Create Database* → *Blob* → connect it to the project.
2. `STORAGE_DRIVER=blob`. Vercel adds `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` +
   `VERCEL_OIDC_TOKEN`) for you.

**S3-compatible** (AWS S3, Cloudflare R2, Supabase Storage, MinIO, Backblaze B2):

```ini
STORAGE_DRIVER=s3
S3_BUCKET=my-videos
S3_REGION=auto                       # R2 uses "auto"
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true             # MinIO, some other services; AWS does not need it
```

The bucket needs a CORS rule that allows `PUT` from your deployment's origin, because the
browser uploads directly:

```json
[
  {
    "AllowedOrigins": ["https://your-app.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Local disk** (`STORAGE_DRIVER=local`): for development and Docker only. Files land in
`STORAGE_DIR` and are served by the app through signed, expiring links.

---

## 3. Environment variables

Minimum for a Vercel deployment:

```ini
DATABASE_URL=postgres://…              # anything in the table above
STORAGE_DRIVER=blob                    # or s3
APP_PASSWORD=…                         # protect the deployment
APP_SECRET=…                           # openssl rand -hex 32 (required with APP_PASSWORD)
```

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | Database. See the table above. Without it the app only reports that it is unconfigured. |
| `STORAGE_DRIVER` | `blob` on Vercel, `local` elsewhere | `blob`, `s3` or `local`. |
| `S3_*` | — | Only for `STORAGE_DRIVER=s3`. |
| `STORAGE_DIR` | `./.data/storage` | Only for `STORAGE_DRIVER=local`. |
| `APP_PASSWORD` | — | Password for the web UI. Without it anyone with the URL can use your deployment. |
| `APP_SECRET` | — | Required with `APP_PASSWORD`. Signs the session cookie. |
| `WORKER_SECRET` | — | Required for workers. They get signed URLs and nothing else. |
| `APP_URL` | `VERCEL_URL` | The public URL, used when registering the Telegram webhook. |
| `BOT_TOKEN` | — | The Telegram bot token. Can also be set on the Settings page instead. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | — | Paths to the binaries when they are not on `PATH`. |
| `FFMPEG_URL` | — | Download a static build at runtime (plain binary, `.gz`, `.tar` or `.tar.gz`). |
| `WORK_DIR` | `/tmp` on Vercel | Scratch space for downloads and conversions. |
| `ALLOWED_USER_IDS` | anyone | Comma-separated Telegram user IDs allowed to use the bot. |
| `CRON_SECRET` | — | Vercel sends it as a bearer token to `/api/cron/cleanup`. |
| `JOB_RETENTION_DAYS` | `7` | How long finished jobs (and their files) are kept. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`. |

Quality, limits, the Telegram token and the webhook secret can all be set from the Settings page
instead; a value saved there wins over the environment and is stored in your database (secrets
are masked in the UI, but they are stored as plain text — use environment variables if the
database is shared with other people).

---

## 4. ffmpeg on Vercel

There is no ffmpeg in a Vercel function by default. Three ways to give the app one, in the order
the app tries them:

1. **`FFMPEG_PATH` / `FFPROBE_PATH`** — point at a binary you baked into your own image.
2. **`FFMPEG_URL`** — a static build downloaded once per instance into `/tmp` (about 30 MB and a
   second or two on the first conversion). A plain binary, a gzipped binary, or a `.tar`/`.tar.gz`
   archive containing `ffmpeg` and `ffprobe` all work.
3. **The npm packages** `ffmpeg-static` and `ffprobe-static`, if you add them:
   ```bash
   npm install ffmpeg-static ffprobe-static
   ```
   Vercel downloads them during `npm install`. They are GPL builds — check the licence before
   shipping them in a closed product.

If no binary is available the app still works: jobs are queued and a worker converts them. The
Settings page shows exactly which ffmpeg was found, its version, and whether it has `libx265`
(without `libx265` the app will not pretend it can convert).

Both static builds ship `ffmpeg` only, so the app inspects files with `ffmpeg -i`. Install
`ffprobe-static` (or a full build) for the faster, more accurate probe.

---

## 5. Telegram webhook

1. Put your bot token in `BOT_TOKEN` (or on the Settings page).
2. Open `/settings` → **Telegram** → *Set webhook*. The app generates a secret, stores it, and
   registers `https://<your-domain>/api/telegram/webhook/<secret>` with Telegram. The URL must be
   HTTPS; Telegram rejects anything else.
3. Send your bot a video **as a File**. Short clips come back converted; longer ones are queued
   and converted by a worker.
4. *Webhook info* shows what Telegram thinks, including the last error. *Delete webhook* is how
   you go back to polling with `python -m video_convertor_bot` — running both at once is not
   possible, Telegram delivers updates to one place only.

Telegram's public Bot API caps downloads at **20 MB** and uploads at **50 MB**. Everything bigger
needs a [local Bot API server](../README.md#size-limits-and-the-local-server): point
`TELEGRAM_API_URL` at it, set `TELEGRAM_LOCAL_MODE=true`, and set
`TELEGRAM_DELIVERY=worker` — on Vercel the app cannot reach a server running on your Mac, so the
worker that converted the file sends it back.

User IDs in `ALLOWED_USER_IDS` (or the Settings page) are the only people the bot answers.
Empty means anyone.

---

## 6. Run a worker

A worker is anything that can reach your deployment over HTTPS and has ffmpeg. It needs no
database credentials and no storage keys — the app hands it a signed download URL and a signed
upload URL per job.

**Node** (same code as the app, so the output is identical):

```bash
APP_URL=https://your-app.vercel.app \
WORKER_SECRET=… \
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg \
npm run worker
```

**Python** (reuses the Telegram bot's pipeline and its tests):

```bash
pip install -r requirements.txt
APP_URL=https://your-app.vercel.app WORKER_SECRET=… python -m worker
```

**Docker**:

```bash
docker compose up --build      # app on :3000, plus a Python worker and ffmpeg
```

Useful flags for both workers: `--once` (convert one job and exit, for cron),
`--status`/`--dry-run` (check the connection without converting), `--concurrency N`,
`--poll SECONDS`.

A worker shows up on the Settings page within a minute of starting, with how many jobs it has
done. Stop it whenever you like; jobs it was holding are requeued and another worker (or the next
start of the same one) picks them up.

---

## 7. Tuning what converts inline

| Setting (Settings page) | Default | Effect |
|---|---|---|
| `inline_max_input_mb` | 25 | Files above this always wait for a worker. |
| `inline_max_seconds` | 50 | Estimated conversion time allowed inside a function. |
| `inline_speed_factor` | 0.4 | How fast the encoder is assumed to run (0.4 ≈ 2.5× the video length). |
| `worker_max_attempts` | 3 | Retries before a job is marked failed. |
| `job_retention_days` | 7 | How long finished jobs are kept by the cleanup cron. |

The estimate is video length ÷ speed factor, plus a fixed allowance for the upload/download. If
it does not fit, the job is queued — the UI says so, and offers *Convert here anyway* for the
impatient.

On a 512 MB function, a 25 MB 10-bit video from `/tmp` through `libx265` is comfortable. If you
see the function killed for memory, lower `inline_max_input_mb` or raise the function's memory in
the Vercel dashboard.

Function durations are per plan: `maxDuration = 60` works everywhere, including Hobby. On Pro or
Enterprise you can raise it in `vercel.json` and in the route files (the `maxDuration` exports),
together with `inline_max_seconds`.

---

## 8. Cleanup cron

`vercel.json` schedules `/api/cron/cleanup` once a day. It deletes jobs older than
`job_retention_days`, their stored files, and workers that have not called in for a day. Vercel
authenticates its own cron calls with `Authorization: Bearer $CRON_SECRET` when you set
`CRON_SECRET`; without it the route can only be called by a signed-in user.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Settings page says *DATABASE_URL is not set* | Set it — including on the Preview environment if you are testing a preview deployment. |
| *the database could not be reached* | Wrong password, or a pooled URL that wants `?sslmode=require`. Test it with `npm run db:migrate` from your laptop. |
| Upload fails with HTTP 403/400 in the browser console | The bucket's CORS rule does not allow `PUT` from your origin (S3), or the Blob store is not connected (Blob). |
| *ffmpeg was not found* | Install `ffmpeg-static`, or set `FFMPEG_PATH`/`FFMPEG_URL`. Jobs still queue without it. |
| *this ffmpeg build has no libx265* | The build lacks HEVC. Use the static build, Homebrew's, or any full build. |
| Jobs stay *queued* | No worker is running. `npm run worker` on a machine with ffmpeg; the UI shows workers that are online. |
| A job is *running* forever | The worker died. It is requeued automatically after the lease (2 minutes) and counts against `worker_max_attempts`. |
| Webhook returns 403 | `telegram_webhook_secret` does not match the URL Telegram is calling. Re-register it on the Settings page. |
| *This video is 24 MB, over this bot's limit of 20 MB* | Telegram's public server cap. Use a local Bot API server. |
| Everyone can use my deployment | Set `APP_PASSWORD` and `APP_SECRET`. |

Health check: `GET /api/health` (no secrets, safe to expose) reports the database, storage,
ffmpeg, Telegram, workers, the queue and any environment problems — the same information the
Settings page shows.
