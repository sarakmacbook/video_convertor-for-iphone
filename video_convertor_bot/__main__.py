"""Run with: python -m video_convertor_bot  (or: python -m video_convertor_bot connect)"""

import sys

from video_convertor_bot.bot import main

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "connect":
        from video_convertor_bot.connect import run_cli

        sys.exit(run_cli(sys.argv[2:]))
    main()
