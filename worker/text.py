"""The caption a worker sends back to Telegram.

The wording lives in `video_convertor_bot.captions`, shared with the polling bot, so a file sent
by the worker and one sent by the bot read the same. That module has no Telegram imports, so the
worker can still run without `python-telegram-bot` when it is not delivering anything itself.
"""

from __future__ import annotations

from video_convertor_bot.captions import describe_result, format_duration, format_mb

__all__ = ["describe_result", "format_duration", "format_mb"]
