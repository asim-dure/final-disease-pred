"""
Optional continuous-loop runner for news_pipeline.run_once(), for environments
without OS-level cron/Task Scheduler access. Runs as its own standalone
process, separate from `python api.py` -- never embed this in the FastAPI
app's request cycle.

Usage:
    python run_news_scheduler.py                  # default: every 6 hours
    NEWS_POLL_INTERVAL_HOURS=12 python run_news_scheduler.py

Prefer real OS cron/Task Scheduler calling `python news_pipeline.py` once
per invocation where available -- it survives machine reboots without
needing this process to also be relaunched, and is the more standard
operational pattern for a job that genuinely has no user-facing trigger.
"""
import logging
import os
import time

from news_pipeline import run_once

log = logging.getLogger("run_news_scheduler")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

POLL_INTERVAL_SECONDS = float(os.getenv("NEWS_POLL_INTERVAL_HOURS", "6")) * 3600


def main():
    log.info(f"News & Intervention Alerts scheduler starting -- polling every {POLL_INTERVAL_SECONDS / 3600:.1f}h")
    while True:
        try:
            run_once()
        except Exception:
            log.exception("Unhandled error during news_pipeline.run_once() -- will retry next cycle")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
