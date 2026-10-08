"""Worker that converts videos queued by the web app, using the bot's own pipeline.

Run it with:

    APP_URL=https://your-app.vercel.app WORKER_SECRET=… python -m worker

See `worker/README.md`.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.2.0"
