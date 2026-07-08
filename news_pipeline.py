"""
Orchestrates one full pass of the autonomous News & Intervention Alerts
pipeline: fetch new posts from every source in news_sources.SOURCES, run LLM
extraction on each, persist results, advance per-source cursors.

Designed to be invoked by an external scheduler (OS cron / Windows Task
Scheduler / run_news_scheduler.py's loop) -- this file itself has no
scheduling logic, just `run_once()`. Per the design decision that users have
NO control over this pipeline (no rule builder, no manual per-post trigger
in the dashboard), run_once() is the single entry point, parameter-free.

Usage:
    python news_pipeline.py            # one pass, then exit (cron-friendly)
"""
import logging

from dotenv import load_dotenv

load_dotenv()  # GROQ_API_KEY must be loaded whether this runs standalone (cron) or via api.py

import news_store
from news_llm import extract
from news_scraper import fetch_all
from news_sources import SOURCES
from weather import get_weather_context, guess_location_from_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("news_pipeline")


def run_once() -> dict:
    cursors = news_store.load_cursors()
    raw_posts = fetch_all(SOURCES, cursors)

    # Sources without a server-side "only new since X" param (currently just
    # NCDC's sitrep listing, which re-returns its full current page every
    # run) would otherwise re-spend an LLM call on posts we've already
    # classified. Skip anything whose id is already in storage -- this is
    # the dedup mechanism for those sources; WordPress sources already avoid
    # re-fetching old posts via their `after` cursor, so this is a cheap
    # no-op for them (their ids are simply never already present).
    already_seen = {a["id"] for a in news_store.load_alerts() if "id" in a}
    new_posts = [p for p in raw_posts if p["id"] not in already_seen]
    skipped = len(raw_posts) - len(new_posts)
    if skipped:
        log.info(f"Skipping LLM extraction for {skipped} already-processed post(s)")

    processed = []
    for post in new_posts:
        # Cheap local guess (no LLM call) at which state the post concerns,
        # so weather can be fetched for a relevant location before the LLM
        # extraction step runs -- avoids a second round-trip just to learn
        # the location first. Falls back to a Nigeria-wide proxy (Abuja).
        guessed_location = guess_location_from_text(post.get("title", "") + " " + post.get("content_text", ""))
        weather = get_weather_context(guessed_location)
        extracted = extract(post, weather=weather)
        processed.append({**post, **extracted})

    alert_worthy = [p for p in processed if p["is_alert_worthy"]]
    all_alerts = news_store.add_alerts(processed)  # store everything seen, not just
    # alert-worthy -- lets ops audit what the LLM filtered out, without it cluttering
    # the dashboard (the dashboard route filters to is_alert_worthy=true by default).

    # Consolidate ALL stored alert-worthy items (not just this run's new ones) into
    # one outbreak-intelligence object per outbreak, with a stitched multi-week
    # trajectory + a single rich planning brief -- this is what the dashboard shows
    # instead of N repetitive weekly cards.
    from news_outbreaks import build_outbreaks
    outbreaks = build_outbreaks(all_alerts)
    news_store.save_outbreaks(outbreaks)

    new_cursors = dict(cursors)
    for src in SOURCES:
        src_posts = [p for p in raw_posts if p["source_id"] == src["id"]]
        if src_posts:
            dated = [p["published_at"] for p in src_posts if p["published_at"]]
            if dated:
                new_cursors[src["id"]] = max(dated)
    news_store.save_cursors(new_cursors)

    summary = {
        "sources_checked": len(SOURCES),
        "posts_fetched": len(raw_posts),
        "posts_processed": len(new_posts),
        "alert_worthy": len(alert_worthy),
        "outbreaks": len(outbreaks),
    }
    log.info(f"Run complete: {summary}")
    return summary


if __name__ == "__main__":
    run_once()
