"""
Catalog loader for the smart-search orchestrator (see main.py).

Builds one flat in-memory list of dict rows, each either:
  - a DASHBOARD-level row (level="dashboard"), sourced live from the FMOH
    warehouse table `dim_dashboard_mapping`, or
  - a CHART-level row (level="chart"), sourced from a parquet file with one
    row per chart/visual inside a dashboard.

The chart parquet is expected to be pushed in later (per the user: "I'll
later push it as well"), so this module works fine with ZERO rows in it --
`load_chart_metadata()` returns [] if the file isn't there, and the
orchestrator just degrades to dashboard-level-only matches. It is read once
per process and cached; call refresh_catalog() to force a reload (e.g. after
dropping a new parquet in without restarting the service).

Expected columns:

  dim_dashboard_mapping (whatever the live table actually has; only the
  columns below are required, everything else is passed through untouched
  under its own key so nothing is silently dropped):
    - a dashboard/report name column (first match wins, in this order:
      dashboard_name, report_name, dashboard, name)
    - optionally a workspace/group and an embed URL/report ID for later
      click-through wiring

  CHART_METADATA_PARQUET (produced by whatever crawler generates it -- see
  reportSearchIndexCrawl.js in console-react for the JS-SDK-based pattern
  this project already uses elsewhere, kept only as a reference, not reused
  directly here):
    - report_name / dashboard   (str, which dashboard this chart belongs to)
    - page_display_name         (str, the report page/tab the chart is on)
    - chart_title                (str, the visual's title)
    - chart_type                 (str, e.g. "barChart", "lineChart")
    - report_id / page_name / visual_name  (optional, for deep-link click-through)
"""
import os
from functools import lru_cache

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

_CATALOG_CACHE = None


def _chart_metadata_path() -> str:
    return os.getenv("CHART_METADATA_PARQUET", os.path.join(BASE_DIR, "chart_metadata.parquet"))


def _first_present(row: dict, *candidates):
    for c in candidates:
        v = row.get(c)
        if v not in (None, ""):
            return v
    return None


def load_dashboard_metadata() -> list[dict]:
    """Queries dim_dashboard_mapping live. Returns [] (not an error) if no
    WAREHOUSE_DATABASE_URL is configured or the query fails -- a missing DB
    connection shouldn't take down the whole search feature, just the
    dashboard-level half of the catalog."""
    warehouse_url = os.getenv("WAREHOUSE_DATABASE_URL", "")
    if not warehouse_url:
        return []
    try:
        from sqlalchemy import create_engine, text
        engine = create_engine(warehouse_url)
        with engine.connect() as conn:
            df = pd.read_sql(text("select * from dim_dashboard_mapping"), conn)
    except Exception as e:
        print(f"[metadata] dim_dashboard_mapping query failed, continuing without it: {e}")
        return []

    # dim_dashboard_mapping also carries live PowerBI service credentials
    # (master_username/master_userpassword/secret_id/secret_value) -- those
    # must never leave this backend. Only an explicit allowlist of
    # display/navigation fields is passed through to the catalog (which the
    # LLM prompt reads from and which the API response returns to the
    # browser).
    rows = []
    for _, r in df.iterrows():
        r = r.to_dict()
        name = _first_present(r, "dashboard_name", "report_name", "dashboard", "name")
        if not name:
            continue
        rows.append({
            "level": "dashboard",
            "dashboard": name,
            "report_name": name,
            "report_heading": r.get("report_heading"),
            "report_description": r.get("report_description"),
            "workspace": _first_present(r, "workspace", "workspace_name", "group"),
            "report_id": _first_present(r, "report_id", "reportid"),
            "embed_url": _first_present(r, "embed_url", "url"),
            "icon": r.get("icon"),
            "is_active": r.get("isactive"),
        })
    return rows


# PowerBI's default per-visual-type names -- these show up as "titles" for
# visuals the author never gave a real title. They carry no search meaning,
# so a chart row whose title is only one of these is demoted to a plain
# page-level row instead of a named-chart option.
_GENERIC_TITLES = {
    "card", "multi-row card", "text box", "table", "matrix", "slicer",
    "line chart", "clustered column chart", "clustered bar chart",
    "stacked column chart", "stacked bar chart", "100% stacked column chart",
    "100% stacked bar chart", "line and stacked column chart",
    "line and clustered column chart", "html content", "pie chart",
    "donut chart", "gauge", "kpi", "map", "filled map", "azure map",
    "area chart", "stacked area chart", "ribbon chart", "waterfall chart",
    "funnel", "scatter chart", "treemap", "decomposition tree",
    "key influencers", "q&a", "smart narrative", "arcgis maps for power bi",
    "button", "image", "shape", "r script visual", "python visual",
}


def load_chart_metadata() -> list[dict]:
    """Reads the chart-level parquet if present. Returns [] otherwise --
    this file is expected to be dropped in later, not generated by this
    service."""
    parquet_path = _chart_metadata_path()
    if not os.path.exists(parquet_path):
        return []
    try:
        df = pd.read_parquet(parquet_path)
    except Exception as e:
        print(f"[metadata] failed to read {parquet_path}, continuing without it: {e}")
        return []

    rows = []
    for _, r in df.iterrows():
        r = r.to_dict()
        chart_title = r.get("chart_title") or r.get("title") or None
        if chart_title and chart_title.strip().lower() in _GENERIC_TITLES:
            chart_title = None  # untitled visual -> not a distinct named chart
        visual_name = r.get("visual_name") or None
        if not chart_title:
            visual_name = None  # without a real title, don't offer a lone visual
        rows.append({
            # Rows with a real visual/title are chart-level; rows from the
            # server-side page crawl (title-less) are page-level -- still
            # finer than a whole dashboard, and directly page-embeddable.
            "level": "chart" if (chart_title or visual_name) else "page",
            "dashboard": _first_present(r, "dashboard", "report_name"),
            "report_name": _first_present(r, "report_name", "dashboard"),
            "page_display_name": r.get("page_display_name"),
            "chart_title": chart_title,
            "chart_type": r.get("chart_type") or r.get("type") or None,
            "report_id": r.get("report_id"),
            "page_name": r.get("page_name"),
            "visual_name": visual_name,
        })

    # Collapse the many now-title-less rows on a page (untitled visuals) into
    # one page-level row per page, and keep chart rows unique per visual.
    deduped = []
    seen = set()
    for row in rows:
        if row["level"] == "page":
            k = ("page", row["report_id"], row["page_name"])
        else:
            k = ("chart", row["report_id"], row["page_name"], row["visual_name"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(row)
    return deduped


def get_full_dashboard_row(report_id: str) -> dict | None:
    """Re-queries dim_dashboard_mapping for ONE row, including its PowerBI
    service credentials (secret_value/master_username/etc). Used only by
    main.py's /search/embed-token endpoint, server-side, to generate a
    short-lived embed token the same way ODC's own core backend does
    (core/src/api/powerbiTokenGeneration.js: AAD client-credentials grant ->
    GenerateToken). The credentials themselves are never returned to the
    caller -- only main.py's endpoint result (embedUrl + embed token) is."""
    warehouse_url = os.getenv("WAREHOUSE_DATABASE_URL", "")
    if not warehouse_url:
        return None
    from sqlalchemy import create_engine, text
    engine = create_engine(warehouse_url)
    with engine.connect() as conn:
        df = pd.read_sql(
            text("select * from dim_dashboard_mapping where report_id = :rid"),
            conn,
            params={"rid": report_id},
        )
    if df.empty:
        return None
    return df.iloc[0].to_dict()


def append_chart_metadata(rows: list[dict]) -> int:
    """Appends crawled chart/visual rows (from the frontend crawler, see
    console-react's smartsearch/chartCrawler.js) into CHART_METADATA_PARQUET,
    de-duplicated on (report_id, page_name, visual_name). Returns the total
    row count in the file after the merge."""
    if not rows:
        return 0
    parquet_path = _chart_metadata_path()
    new_df = pd.DataFrame(rows)
    if os.path.exists(parquet_path):
        try:
            existing_df = pd.read_parquet(parquet_path)
            combined = pd.concat([existing_df, new_df], ignore_index=True)
        except Exception:
            combined = new_df
    else:
        combined = new_df
    dedupe_cols = [c for c in ["report_id", "page_name", "visual_name"] if c in combined.columns]
    if dedupe_cols:
        combined = combined.drop_duplicates(subset=dedupe_cols, keep="last")
    combined.to_parquet(parquet_path, index=False)
    return len(combined)


def refresh_catalog() -> list[dict]:
    global _CATALOG_CACHE
    _CATALOG_CACHE = load_dashboard_metadata() + load_chart_metadata()
    return _CATALOG_CACHE


def get_catalog() -> list[dict]:
    global _CATALOG_CACHE
    if _CATALOG_CACHE is None:
        _CATALOG_CACHE = refresh_catalog()
    return _CATALOG_CACHE
