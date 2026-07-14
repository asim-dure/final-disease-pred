# Search Orchestrator (Smart Search)

New natural-language search over Power BI dashboards/charts. Separate from,
and does not touch, the existing keyword search (`console-react/src/pages/search`).

## What it does

A user types something like "show me age wise distribution of HIV in male
and female". This service builds a catalog of known dashboards/charts and
asks a Groq LLM (`llama-3.3-70b-versatile`) to pick the single best match, or
say plainly that nothing is available -- it never invents a result.

## Data sources

1. **`dim_dashboard_mapping`** (FMOH warehouse Postgres) -- queried live on
   every catalog load. Gives dashboard/report-level rows. Set
   `WAREHOUSE_DATABASE_URL` in `.env` to enable this; if unset, this half of
   the catalog is just skipped (not an error).
2. **Chart-level metadata parquet** -- one row per chart/visual inside a
   dashboard, columns: `report_name` (or `dashboard`), `page_display_name`,
   `chart_title`, `chart_type`, and optionally `report_id`/`page_name`/
   `visual_name` for click-through. This file is **not included** -- drop it
   in next to `main.py` as `chart_metadata.parquet` (or point
   `CHART_METADATA_PARQUET` at a different path) and call
   `POST /search/refresh` to pick it up without restarting.

   Nothing in this repo currently generates that file. The only working
   chart-title crawler that already exists anywhere in `odc_new_ui` is
   `console-react/src/pages/situationreport/reportSearchIndexCrawl.js`,
   which uses the `powerbi-client` JS SDK against an *already-embedded*
   report in the browser (`report.getPages()` → `page.getVisuals()`). It's
   part of the old system this feature intentionally does not reuse, but the
   technique is the reference if/when a chart-level crawler is built for
   this parquet.

Until the parquet exists, Smart Search still works, just at dashboard level
only (it'll match "the HIV dashboard" but not "the age-by-sex chart inside
it").

## Setup

```bash
cd odc_new_ui/search_orchestrator
pip install -r requirements.txt
cp .env.example .env   # fill in GROQ_API_KEY, WAREHOUSE_DATABASE_URL
uvicorn main:app --host 0.0.0.0 --port 8600 --reload
```

## Endpoints

- `GET /health` -- catalog row count + whether chart-level data is loaded.
- `POST /search/refresh` -- re-reads the DB + parquet without restarting.
- `POST /search/orchestrate` -- `{"query": "..."}` →
  `{"available": bool, "message": str, "matches": [...]}`.

## Frontend

`console-react/src/pages/smartsearch/SmartSearch.js`, routed at
`/search/smart` (`console-react/src/routes/routes.js`), reachable from a new
"Smart Search" sidebar item (added in both `localFeatureAdditions.js` and
`devSidebarFixture.js`, next to the existing "Search" item). Calls this
backend via `REACT_APP_SEARCH_ORCHESTRATOR_URL` (default
`http://localhost:8600`, see `smartSearchApi.js`).

## Not yet done

- No click-through deep link is wired up beyond opening `match.embed_url` in
  a new tab -- depends on what `dim_dashboard_mapping` actually returns for
  a usable report URL/embed token, which hasn't been inspected yet (its
  exact columns are unknown until it's queried against a real DB).
- No chart-level parquet exists yet (see above) -- to be pushed separately.
