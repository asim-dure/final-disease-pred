"""
Smart Search orchestrator for ODC's Power BI dashboards.

NOT the old keyword search (console-react/src/pages/search/SearchEngine.js) --
that stays untouched. This is a new, separate service: a user types a plain-
language question ("show me age wise distribution of HIV in male and
female") and a Groq LLM (llama-3.3-70b-versatile -- Groq's current "70B
versatile" model; the older llama-3.1-70b-versatile id was retired) picks the
single best-matching chart out of a metadata catalog, rather than requiring
an exact title match.

Two data sources feed the catalog (see metadata.py):
  1. `dim_dashboard_mapping` in the FMOH Postgres DB -- the master list of
     Power BI dashboards/reports (queried live, read-only).
  2. A metadata parquet file (CHART_METADATA_PARQUET, same folder by
     default) with one row per CHART/VISUAL inside those reports -- title,
     which page/report it lives on, chart type. This repo does not generate
     that file yet (crawling live inside an embedded Power BI report needs a
     real browser + embed token, which this backend doesn't have) -- it's
     expected to be produced separately and dropped in next to this file.
     Until then, the orchestrator degrades honestly to dashboard-level
     matches only (see metadata.py's docstring).

Usage:
    pip install -r requirements.txt
    cp .env.example .env   # fill in GROQ_API_KEY + WAREHOUSE_DATABASE_URL
    uvicorn main:app --host 0.0.0.0 --port 8600 --reload
"""
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

load_dotenv()

from metadata import get_catalog, refresh_catalog, get_full_dashboard_row, append_chart_metadata, load_dashboard_metadata

app = FastAPI(title="ODC Smart Search Orchestrator")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
THUMBNAIL_DIR = os.path.join(BASE_DIR, "thumbnails")
VISUAL_THUMB_DIR = os.path.join(BASE_DIR, "thumbnails_visual")
os.makedirs(THUMBNAIL_DIR, exist_ok=True)
os.makedirs(VISUAL_THUMB_DIR, exist_ok=True)


def _powerbi_service_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    """AAD client-credentials grant for the PowerBI API -- shared by the
    embed-token and thumbnail endpoints. Same call ODC's own core backend
    makes (core/src/api/powerbiTokenGeneration.js)."""
    import requests
    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "resource": "https://analysis.windows.net/powerbi/api",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )
    if not resp.ok:
        raise HTTPException(502, "Failed to authenticate with PowerBI")
    return resp.json()["access_token"]


def _dashboard_powerbi_creds(report_id: str) -> dict:
    row = get_full_dashboard_row(report_id)
    if not row:
        raise HTTPException(404, "No dashboard found for that report_id")
    creds = {
        "tenant_id": row.get("tenant_id"),
        "workspace_id": row.get("workspace_id"),
        "client_id": row.get("application_id"),
        "client_secret": row.get("secret_value"),
        "report_id": row.get("report_id"),
    }
    if not all(creds.values()):
        raise HTTPException(502, "Dashboard row is missing PowerBI credentials/IDs needed for this operation")
    return creds

# Wide open by default -- this sits behind ODC's own auth/gateway in
# deployment; tighten via ALLOWED_ORIGINS if this is ever exposed directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

GROQ_MODEL = os.getenv("SEARCH_ORCHESTRATOR_MODEL", "llama-3.3-70b-versatile")

# Maps a disease/subject the user might mention to the dashboard-name
# fragments that are valid answers for it. Used to HARD-filter the catalog by
# subject before the LLM sees it, so an HIV question can never be answered
# from a malaria dashboard just because the wording matched better. Diseases
# that live inside a grouped dashboard (e.g. hypertension is a page in
# "FMOH NCDs") list both their own name and the group's, so grouped rows stay
# eligible. Keys are (regex, [dashboard-name substrings]).
import re as _re

_SUBJECT_RULES = [
    (r"\bhiv\b|aids", ["hiv"]),
    (r"malaria", ["malaria"]),
    (r"\btb\b|tuberculosis|tuberc", ["tb", "tuberc"]),
    (r"hypertension|blood pressure", ["hypertension", "ncd"]),
    (r"diabetes|diabetic", ["diabetes", "ncd"]),
    (r"asthma", ["asthma", "ncd"]),
    (r"cervical", ["cervical", "ncd"]),
    (r"breast\s*cancer", ["ncd"]),
    (r"depression|mental health", ["ncd"]),
    (r"arthritis", ["ncd"]),
    (r"coronary|heart disease", ["ncd"]),
    (r"elephantiasis|lymphatic filariasis|\blf\b", ["elephantiasis", "ntd"]),
    (r"yaws", ["yaws", "ntd"]),
    (r"snake", ["ntd", "snake"]),
    (r"sickle", ["sickle", "ntd", "ncd"]),
    (r"\bncd\b|non-communicable|noncommunicable", ["ncd"]),
    (r"\bntd\b|neglected tropical", ["ntd"]),
]


def _subject_filter(catalog: list[dict], query: str) -> list[dict]:
    """If the query names a disease/subject, restrict the catalog to rows
    whose dashboard is about that subject. Returns the full catalog unchanged
    if no subject is recognized, or if filtering would leave nothing."""
    q = query.lower()
    wanted = set()
    for pattern, hints in _SUBJECT_RULES:
        if _re.search(pattern, q):
            wanted.update(hints)
    if not wanted:
        return catalog
    filtered = [
        r for r in catalog
        if any(h in str(r.get("dashboard", "")).lower() for h in wanted)
    ]
    return filtered or catalog


class SearchReq(BaseModel):
    query: str
    # Session conversation context (recent turns + a summary of older ones),
    # built client-side, so follow-up questions resolve. Cleared on reload.
    context: str = ""


class SearchResult(BaseModel):
    available: bool
    message: str
    matches: list[dict] = []
    # The user can always fall back to building a fresh chart from the
    # warehouse when the found options aren't what they wanted.
    can_create: bool = True


class CreateInterpretReq(BaseModel):
    query: str
    context: str = ""
    # The last chart the user successfully built this session, so a follow-up
    # like "now by state" or "make it a bar chart" reuses the same indicator
    # instead of re-asking which one they meant.
    last_spec: dict | None = None


class CreateRunReq(BaseModel):
    spec: dict


class EmbedTokenReq(BaseModel):
    report_id: str


class EmbedTokenResult(BaseModel):
    report_id: str
    embed_url: str
    access_token: str


class ChartCrawlEntry(BaseModel):
    report_id: str
    dashboard: str
    page_name: str
    page_display_name: str
    visual_name: str
    chart_title: str
    chart_type: str


class ChartCrawlIngestReq(BaseModel):
    entries: list[ChartCrawlEntry]


@app.get("/health")
def health():
    catalog = get_catalog()
    return {
        "ok": True,
        "catalog_rows": len(catalog),
        "chart_metadata_loaded": any(r.get("level") == "chart" for r in catalog),
    }


@app.post("/search/refresh")
def refresh():
    """Re-reads dim_dashboard_mapping + the metadata parquet from disk --
    call this after dropping in a new/updated parquet file, no restart
    needed."""
    catalog = refresh_catalog()
    return {"ok": True, "catalog_rows": len(catalog)}


@app.post("/search/orchestrate", response_model=SearchResult)
def orchestrate(req: SearchReq):
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(400, "query is required")

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")

    catalog = get_catalog()
    if not catalog:
        return SearchResult(
            available=False,
            message="No dashboard/chart catalog is loaded yet -- dim_dashboard_mapping "
                    "returned nothing and no metadata parquet file was found.",
            matches=[],
        )

    from groq import Groq
    client = Groq(api_key=api_key)

    # Hard subject filter first: if the question names a disease, the model
    # only ever sees rows from that disease's dashboards -- structurally
    # impossible to answer an HIV question with a malaria page.
    catalog = _subject_filter(catalog, query)

    # Compact, numbered catalog so the model can answer with just an index --
    # cheaper and far more reliable than asking it to reproduce titles/paths
    # verbatim. Capped to keep the prompt a sane size; a real deployment with
    # thousands of charts should pre-filter with a cheap keyword/embedding
    # pass before this LLM call, not send the whole catalog every time.
    MAX_ROWS = 400
    rows = catalog[:MAX_ROWS]
    catalog_lines = []
    for i, r in enumerate(rows):
        parts = [f"[{i}]", f"level={r.get('level', 'dashboard')}"]
        if r.get("dashboard"):
            parts.append(f"dashboard={r['dashboard']}")
        if r.get("report_heading"):
            parts.append(f"heading={r['report_heading']}")
        if r.get("report_description"):
            parts.append(f"description=\"{r['report_description']}\"")
        if r.get("page_display_name"):
            parts.append(f"page={r['page_display_name']}")
        if r.get("chart_title"):
            parts.append(f"chart=\"{r['chart_title']}\"")
        if r.get("chart_type"):
            parts.append(f"type={r['chart_type']}")
        catalog_lines.append(" ".join(parts))
    catalog_text = "\n".join(catalog_lines)

    prompt = f"""You are a search assistant over a catalog of Power BI dashboards, the pages
inside them, and the individual charts on those pages. A user asked a
plain-language question. Return the BEST-MATCHING rows (up to 6), ranked most
relevant first, so the user can pick which one they meant.

SUBJECT ANCHOR (most important rule): identify the main subject of the
question -- usually a disease or program (HIV, malaria, TB, hypertension,
diabetes, an NTD, etc.). Every row you return MUST belong to a dashboard
about that same subject. NEVER return a malaria row for an HIV question, or
an NCD row for a TB question, and so on.

Prefer the MOST SPECIFIC rows: individual charts (level=chart) whose titles
match what was asked come first, then relevant pages (level=page), then the
whole dashboard (level=dashboard) as a fallback. Include several genuinely
relevant charts when the question could map to more than one -- e.g. a
question about "HIV testing" might return both a "People tested for HIV"
chart and a "Tested & Got Results" chart. Do not pad the list with weak
matches; quality over quantity, 1 to 6 rows.

Match on meaning, not just exact words. Only return an empty list if the
catalog has nothing about that subject at all. Never invent an index that
isn't listed below.

{("CONVERSATION SO FAR (use it to resolve follow-ups like 'show the male one' or 'what about HIV' -- carry over the subject/context from earlier turns if the new question is a follow-up):" + chr(10) + req.context + chr(10)) if req.context else ""}
CATALOG (index, then real fields for that row):
{catalog_text}

USER QUESTION: "{query}"

Respond with ONLY a JSON object, no other text, in exactly this shape:
{{"matches": [{{"index": <int>, "confidence": "high"|"medium"|"low", "reason": "<one short sentence why this matches>"}}, ...]}}
If nothing genuinely matches, return {{"matches": []}}.
"""

    resp = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=700,
        temperature=0.1,
        response_format={"type": "json_object"},
    )

    import json
    try:
        parsed = json.loads(resp.choices[0].message.content)
    except (json.JSONDecodeError, AttributeError):
        raise HTTPException(502, "Orchestrator model returned a non-JSON response")

    raw_matches = parsed.get("matches") or []
    results = []
    seen_idx = set()
    seen_label = set()
    for m in raw_matches:
        idx = m.get("index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(rows) or idx in seen_idx:
            continue
        row = dict(rows[idx])
        # Collapse the same-named chart that appears on several pages into a
        # single option -- the user doesn't want "Tested & Got Results" x3.
        label = (str(row.get("dashboard", "")).lower(),
                 str(row.get("chart_title") or row.get("page_display_name") or "").lower())
        if label in seen_label:
            continue
        seen_idx.add(idx)
        seen_label.add(label)
        row["confidence"] = m.get("confidence")
        row["reason"] = m.get("reason")
        results.append(row)

    if not results:
        return SearchResult(
            available=False,
            message="Not available -- no matching chart, page, or dashboard was found for that question.",
            matches=[],
        )

    plural = "option" if len(results) == 1 else "options"
    return SearchResult(
        available=True,
        message=f"Found {len(results)} {plural} -- pick the one you want.",
        matches=results,
    )


@app.get("/search/crawlable-dashboards")
def crawlable_dashboards():
    """Lists every dashboard the chart crawler (console-react's
    smartsearch/ChartCrawler.js) needs to walk -- report_id + display name
    only, no credentials. The crawler embeds each one via /search/embed-token,
    walks its pages/visuals in the browser with the powerbi-client SDK, and
    posts the results to /search/chart-metadata/ingest."""
    rows = load_dashboard_metadata()
    return {
        "dashboards": [
            {"report_id": r["report_id"], "dashboard": r["dashboard"]}
            for r in rows
            if r.get("report_id")
        ]
    }


@app.post("/search/chart-metadata/ingest")
def ingest_chart_metadata(req: ChartCrawlIngestReq):
    """Receives chart/visual rows crawled in the browser (see ChartCrawler.js)
    and merges them into chart_metadata.parquet, then reloads the in-memory
    catalog so new searches see them immediately."""
    rows = [e.model_dump() for e in req.entries]
    total = append_chart_metadata(rows)
    catalog = refresh_catalog()
    return {"ok": True, "parquet_rows": total, "catalog_rows": len(catalog)}


@app.post("/search/crawl-pages")
def crawl_pages():
    """Server-side crawl of every dashboard's PAGES via PowerBI's REST API
    (GET /reports/{id}/pages) -- no browser needed, unlike visual-level
    crawling. Populates page-level rows in chart_metadata.parquet so
    'inside the dashboard' matches work immediately; the browser crawler at
    /search/smart/crawl still adds finer visual-level rows on top."""
    import requests

    dashboards = load_dashboard_metadata()
    entries = []
    failures = []
    token_cache: dict[tuple, str] = {}

    for d in dashboards:
        rid = d.get("report_id")
        if not rid:
            continue
        try:
            creds = _dashboard_powerbi_creds(rid)
        except HTTPException as e:
            failures.append({"dashboard": d.get("dashboard"), "error": e.detail})
            continue
        tkey = (creds["tenant_id"], creds["client_id"])
        try:
            if tkey not in token_cache:
                token_cache[tkey] = _powerbi_service_token(creds["tenant_id"], creds["client_id"], creds["client_secret"])
            resp = requests.get(
                f"https://api.powerbi.com/v1.0/myorg/groups/{creds['workspace_id']}/reports/{rid}/pages",
                headers={"Authorization": f"Bearer {token_cache[tkey]}"},
                timeout=15,
            )
            if not resp.ok:
                failures.append({"dashboard": d.get("dashboard"), "error": f"pages HTTP {resp.status_code}"})
                continue
            for p in resp.json().get("value", []):
                disp = (p.get("displayName") or "").strip()
                # Tooltip/drillthrough helper pages aren't user-facing
                # destinations -- they only render inside another visual's
                # hover. Skip them so they don't pollute search results.
                low = disp.lower()
                if "tooltip" in low or low in ("glossary",) or not disp:
                    continue
                entries.append({
                    "report_id": rid,
                    "dashboard": d.get("dashboard"),
                    "page_name": p.get("name"),
                    "page_display_name": p.get("displayName"),
                    "visual_name": "",
                    "chart_title": "",
                    "chart_type": "",
                })
        except Exception as e:
            failures.append({"dashboard": d.get("dashboard"), "error": str(e)})

    total = append_chart_metadata(entries)
    catalog = refresh_catalog()
    return {"ok": True, "pages_found": len(entries), "parquet_rows": total, "catalog_rows": len(catalog), "failures": failures}


@app.post("/search/embed-token", response_model=EmbedTokenResult)
def embed_token(req: EmbedTokenReq):
    """Generates a short-lived PowerBI embed token for a matched dashboard,
    server-side, using the AAD app-registration credentials stored in
    dim_dashboard_mapping (application_id as client_id, secret_value as
    client_secret, tenant_id, workspace_id). Same 3-step flow as ODC's own
    core backend (core/src/api/powerbiTokenGeneration.js): client-credentials
    grant -> GET report -> GenerateToken. The credentials never leave this
    function; only the resulting embedUrl + embed token (which by design are
    scoped to View access and expire) are returned to the frontend."""
    creds = _dashboard_powerbi_creds(req.report_id)
    workspace_id, report_id = creds["workspace_id"], creds["report_id"]

    import requests

    access_token = _powerbi_service_token(creds["tenant_id"], creds["client_id"], creds["client_secret"])
    headers = {"Authorization": f"Bearer {access_token}"}

    report_resp = requests.get(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}",
        headers=headers,
        timeout=15,
    )
    if not report_resp.ok:
        raise HTTPException(502, "Failed to look up the report on PowerBI")
    embed_url = report_resp.json()["embedUrl"]

    gen_resp = requests.post(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}/GenerateToken",
        json={"accessLevel": "View", "allowSaveAs": False},
        headers=headers,
        timeout=15,
    )
    if not gen_resp.ok:
        raise HTTPException(502, "Failed to generate an embed token")
    embed_token_value = gen_resp.json()["token"]

    return EmbedTokenResult(report_id=report_id, embed_url=embed_url, access_token=embed_token_value)


@app.get("/search/thumbnail/{report_id}")
def thumbnail(report_id: str, page: str | None = None, visual: str | None = None):
    """Real image preview for a match card -- not a text blurb.

    For a chart-level match (visual given), serves a pixel-perfect image of
    just that one chart, pre-rendered by snap_visuals.py (single-visual
    embed) into thumbnails_visual/. If that image doesn't exist yet, or the
    match is page/dashboard level, falls back to a PowerBI ExportTo render of
    the whole page/report (cached in thumbnails/)."""
    if visual:
        vpath = os.path.join(VISUAL_THUMB_DIR, f"{report_id}__{visual}.png".replace("/", "_"))
        if os.path.exists(vpath):
            return FileResponse(vpath, media_type="image/png")

    cache_name = f"{report_id}__{page or 'default'}.png".replace("/", "_")
    cache_path = os.path.join(THUMBNAIL_DIR, cache_name)
    if os.path.exists(cache_path):
        return FileResponse(cache_path, media_type="image/png")

    creds = _dashboard_powerbi_creds(report_id)
    workspace_id, rid = creds["workspace_id"], creds["report_id"]

    import requests

    access_token = _powerbi_service_token(creds["tenant_id"], creds["client_id"], creds["client_secret"])
    headers = {"Authorization": f"Bearer {access_token}"}

    export_body = {"format": "PNG"}
    if page:
        export_body["powerBIReportConfiguration"] = {"pages": [{"pageName": page}]}

    start_resp = requests.post(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{rid}/ExportTo",
        json=export_body,
        headers=headers,
        timeout=15,
    )
    if not start_resp.ok:
        raise HTTPException(502, "Failed to start thumbnail export")
    export_id = start_resp.json()["id"]
    status_url = f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{rid}/exports/{export_id}"

    for _ in range(30):  # ~30s max wait
        status_resp = requests.get(status_url, headers=headers, timeout=15)
        if not status_resp.ok:
            raise HTTPException(502, "Failed to poll thumbnail export status")
        status = status_resp.json()
        if status["status"] == "Succeeded":
            break
        if status["status"] == "Failed":
            raise HTTPException(502, "Thumbnail export failed on PowerBI's side")
        time.sleep(1)
    else:
        raise HTTPException(504, "Thumbnail export timed out")

    file_resp = requests.get(f"{status_url}/file", headers=headers, timeout=30)
    if not file_resp.ok:
        raise HTTPException(502, "Failed to download the rendered thumbnail")

    with open(cache_path, "wb") as f:
        f.write(file_resp.content)
    return FileResponse(cache_path, media_type="image/png")


@app.post("/create/interpret")
def create_interpret(req: CreateInterpretReq):
    """Step 1 of 'create your own chart': turn the plain-language request into
    a structured spec. May come back needing a human pick between several
    matching indicators (e.g. the many malaria 'cases' indicators)."""
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(400, "query is required")
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    import create_chart
    return create_chart.interpret(query, Groq(api_key=api_key), GROQ_MODEL,
                                  context=req.context, last_spec=req.last_spec)


@app.post("/create/run")
def create_run(req: CreateRunReq):
    """Step 2: with a fully-resolved spec (indicator picked), run the
    templated SQL and return the data shaped for the React/ECharts chart."""
    import create_chart
    return create_chart.run_chart(req.spec)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8600")), reload=True)
