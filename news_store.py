"""
Persistence for the News & Intervention Alerts pipeline.

Mirrors the existing budget_proposals.json pattern (api.py's
_load_proposals/_save_proposals) rather than requiring MongoDB, since no
Mongo instance is provisioned for this project yet (same gap noted in
EWS_REAL_SYSTEM_PLAN.md for the threshold-rule EWS). The read/write surface
below is intentionally narrow (load_alerts/save_alerts/load_cursors/
save_cursors) so swapping to MongoDB later is a one-file change -- nothing
else in news_pipeline.py or api.py needs to know how alerts are stored.
"""
import json
import os
import threading

_LOCK = threading.Lock()
_ALERTS_FILE = os.path.join(os.path.dirname(__file__), "news_alerts.json")
_CURSORS_FILE = os.path.join(os.path.dirname(__file__), "news_cursors.json")
_OUTBREAKS_FILE = os.path.join(os.path.dirname(__file__), "news_outbreaks.json")
_PLAN_CACHE_FILE = os.path.join(os.path.dirname(__file__), "news_plan_cache.json")


def _load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _save_json(path, data):
    with _LOCK:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)


def load_alerts() -> list[dict]:
    if not os.path.exists(_ALERTS_FILE):
        return []
    try:
        with open(_ALERTS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_alerts(alerts: list[dict]) -> None:
    with _LOCK:
        with open(_ALERTS_FILE, "w", encoding="utf-8") as f:
            json.dump(alerts, f, indent=2, ensure_ascii=False)


def add_alerts(new_alerts: list[dict]) -> list[dict]:
    """Appends, de-duplicated by `id` (the source-prefixed WordPress post
    id), newest-first. Returns the full updated list."""
    if not new_alerts:
        return load_alerts()
    with _LOCK:
        existing = load_alerts()
        seen_ids = {a["id"] for a in existing if "id" in a}
        merged = [a for a in new_alerts if a["id"] not in seen_ids] + existing
        merged.sort(key=lambda a: a.get("published_at", ""), reverse=True)
        with open(_ALERTS_FILE, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
        return merged


def load_cursors() -> dict:
    if not os.path.exists(_CURSORS_FILE):
        return {}
    try:
        with open(_CURSORS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_cursors(cursors: dict) -> None:
    with _LOCK:
        with open(_CURSORS_FILE, "w", encoding="utf-8") as f:
            json.dump(cursors, f, indent=2, ensure_ascii=False)


# ── consolidated outbreaks + planning-brief cache ───────────────────────────
def load_outbreaks() -> list:
    return _load_json(_OUTBREAKS_FILE, [])


def save_outbreaks(outbreaks: list) -> None:
    _save_json(_OUTBREAKS_FILE, outbreaks)


def load_plan_cache() -> dict:
    return _load_json(_PLAN_CACHE_FILE, {})


def save_plan_cache(cache: dict) -> None:
    _save_json(_PLAN_CACHE_FILE, cache)
