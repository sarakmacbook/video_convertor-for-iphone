"""Command line entry point: `python -m worker`.

Claims queued jobs from the deployment and converts them here, with the same ffmpeg pipeline
the Telegram bot uses. Nothing else is needed: the app hands out signed URLs for the input and
the output, so the worker holds no storage keys and no database credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import socket
import sys

from video_convertor_bot.media import EncodeOptions

from .client import WorkerApiError, WorkerClient
from .runner import TelegramDelivery, check_ffmpeg, run_one

VERSION = "0.2.0"
logger = logging.getLogger("worker")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m worker",
        description="Convert videos that were queued by the video converter web app.",
    )
    parser.add_argument("--app-url", default=os.environ.get("APP_URL", ""), help="base URL of the deployment")
    parser.add_argument("--secret", default=os.environ.get("WORKER_SECRET", ""), help="the deployment's WORKER_SECRET")
    parser.add_argument("--name", default=os.environ.get("WORKER_NAME", socket.gethostname()), help="name shown in the UI")
    parser.add_argument("--poll", type=float, default=float(os.environ.get("WORKER_POLL_SECONDS", "5")), help="idle poll interval in seconds")
    parser.add_argument("--concurrency", type=int, default=int(os.environ.get("WORKER_CONCURRENCY", "1")), help="jobs at once")
    parser.add_argument("--once", action="store_true", help="convert one job and exit (for cron)")
    parser.add_argument("--status", action="store_true", help="print the queue status and exit")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("FFPROBE_BIN", "ffprobe"))
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    return parser.parse_args(argv)


def encode_options(args: argparse.Namespace) -> EncodeOptions:
    # The app sends crf/preset per job; these are only the defaults and the binary paths.
    return EncodeOptions(
        ffmpeg=args.ffmpeg,
        ffprobe=args.ffprobe,
        crf=20,
        preset="medium",
        timeout_seconds=float(os.environ.get("FFMPEG_TIMEOUT_SECONDS", "21600")),
    )


async def work_one(client: WorkerClient, job, options: EncodeOptions, telegram: TelegramDelivery) -> None:
    logger.info("job %s: %s (%s)", job.id, job.input_name or "video", f"{job.input_bytes / 1_000_000:.1f} MB")
    try:
        outcome = await run_one(client, job, options, telegram)
        client.complete(
            job.id,
            used_original=outcome.used_original,
            output_bytes=outcome.output_bytes,
            output_key=outcome.output_key,
            output_name=job.output_name,
            output_width=outcome.output_width,
            output_height=outcome.output_height,
            output_codec=outcome.output_codec,
            source_bytes=outcome.source_bytes,
            saved_percent=outcome.saved_percent,
            ffmpeg_version=None,
            delivered_to_telegram=outcome.delivered_to_telegram,
            message=outcome.message,
        )
        if outcome.used_original:
            logger.info("job %s: kept the original", job.id)
        else:
            logger.info("job %s: %.0f%% smaller (%d bytes)", job.id, outcome.saved_percent, outcome.output_bytes)
    except Exception as exc:  # noqa: BLE001 - any failure has to be reported to the app
        logger.exception("job %s failed: %s", job.id, exc)
        retryable = not isinstance(exc, (ValueError,))
        try:
            client.fail(job.id, str(exc), retryable=retryable)
        except WorkerApiError as api_error:
            logger.error("could not report the failure: %s", api_error)


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not args.app_url:
        print("APP_URL is not set. Example: APP_URL=https://my-app.vercel.app python -m worker", file=sys.stderr)
        return 2
    if not args.secret:
        print("WORKER_SECRET is not set. Copy it from the deployment's environment variables.", file=sys.stderr)
        return 2

    options = encode_options(args)
    problems = check_ffmpeg(options)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 3

    client = WorkerClient(args.app_url, args.secret, args.name)
    telegram = TelegramDelivery(
        token=os.environ.get("BOT_TOKEN"),
        api_url=os.environ.get("TELEGRAM_API_URL"),
        local_mode=os.environ.get("TELEGRAM_LOCAL_MODE", "").lower() in ("1", "true", "yes"),
    )

    logger.info("worker %r v%s → %s", args.name, VERSION, args.app_url)
    if not telegram.configured:
        logger.info("BOT_TOKEN is not set: jobs that need delivery from here will be reported instead")

    try:
        registration = client.register(args.name, VERSION, info=f"python {sys.version.split()[0]}")
        if registration.get("reaped"):
            logger.info("the app requeued %s stale job(s)", registration["reaped"])
    except WorkerApiError as exc:
        logger.error("%s", exc)
        return 4

    if args.status:
        job = client.claim()
        print(f"queue: {'next job ' + job.id if job else 'empty'}")
        return 0

    running: set[asyncio.Task] = set()
    stopping = False

    while not stopping:
        if len(running) >= max(1, args.concurrency):
            done, running = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            continue

        try:
            job = client.claim()
        except WorkerApiError as exc:
            logger.error("could not reach the deployment: %s", exc)
            await asyncio.sleep(max(args.poll, 10))
            continue

        if job is None:
            if args.once:
                logger.info("queue is empty")
                return 0
            if running:
                done, running = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                continue
            await asyncio.sleep(args.poll)
            continue

        task = asyncio.create_task(work_one(client, job, options, telegram))
        running.add(task)
        if args.once:
            await asyncio.gather(*running)
            return 0

    if running:
        await asyncio.gather(*running)
    return 0


def run() -> None:
    """Synchronous wrapper, so `python -m worker` behaves like a normal command."""
    try:
        exit_code = asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("stopped by the user")
        exit_code = 0
    sys.exit(exit_code)


if __name__ == "__main__":
    run()


__all__ = ["encode_options", "main", "parse_args", "run", "work_one"]
