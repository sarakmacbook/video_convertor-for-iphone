# The conversion worker, in Python.
#
# It shares the Telegram bot's pipeline (`video_convertor_bot/`), so a video converted by the
# worker and one converted by the bot come out the same. Used by docker-compose; on a Mac or a
# VPS you can equally run `python -m worker` in a virtualenv.

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY video_convertor_bot ./video_convertor_bot
COPY worker ./worker

ENV PYTHONUNBUFFERED=1 \
    WORKER_NAME=docker-worker \
    WORKER_POLL_SECONDS=5

CMD ["python", "-m", "worker"]
