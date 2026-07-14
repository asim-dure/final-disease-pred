# Smart Search — integration guide (for an AI agent)

You are integrating the **Smart Search** feature into an ODC `console-react`
app that does NOT have it yet. This bundle lives on a branch of a *different*
repo; copy its files into the ODC repo and apply 3 small edits. Do not push
to any shared branch — work on a feature branch and open a PR.

## What it is
Natural-language search over the FMOH Power BI dashboards (finds the matching
dashboard / page / individual chart), plus a "create your own chart" fallback
(NL → SQL → an ECharts chart) when nothing matches. It's a NEW, separate
feature — the existing keyword `SearchEngine` stays untouched.

Two parts:
- `search_orchestrator/` — a standalone Python FastAPI + Groq backend (port 8600).
- `console-react/src/pages/smartsearch/` — React UI that calls it.

## Step 0 — get the bundle
```bash
git clone --branch smart-search --depth 1 https://github.com/asim-dure/final-disease-pred.git /tmp/ss
ls /tmp/ss/smart_search        # -> search_orchestrator/  console-react/  HANDOFF.md
```
Let `$ODC` = the root of the ODC repo (the folder containing `console-react/`).

## Step 1 — copy files (no edits needed to these)
```bash
cp -r /tmp/ss/smart_search/search_orchestrator "$ODC/search_orchestrator"
mkdir -p "$ODC/console-react/src/pages/smartsearch"
cp /tmp/ss/smart_search/console-react/src/pages/smartsearch/* "$ODC/console-react/src/pages/smartsearch/"
```

## Step 2 — check frontend deps
The UI imports `echarts`, `echarts-for-react`, `powerbi-client`,
`powerbi-client-react`. Confirm they're in `console-react/package.json`; if any
is missing, install it (match existing versions if pinned):
```bash
cd "$ODC/console-react" && npm i echarts echarts-for-react powerbi-client powerbi-client-react
```

## Step 3 — 3 small edits (ADD only; never overwrite these files)

**`console-react/src/routes/routes.js`** — near the other `lazy(...)` imports:
```js
const SmartSearch = lazy(() => import("../pages/smartsearch/SmartSearch"));
const ChartCrawler = lazy(() => import("../pages/smartsearch/ChartCrawler"));
```
…and in the routes array, right after the existing `{ path: "/search", ... }`:
```js
{ path: "/search/smart", name: "Smart Search", key: "smartsearch", element: <SmartSearch /> },
{ path: "/search/smart/crawl", name: "Chart Metadata Crawler", key: "smartsearchcrawl", element: <ChartCrawler /> },
```

**`console-react/src/utils/localFeatureAdditions.js`** — add the const (above
`function findByKey`) and the push (inside `injectLocalFeatureAdditions`,
after the existing `ml_predictive` block):
```js
const SMART_SEARCH_ITEM = {
  label: "Smart Search", key: "smartsearch", icon: "SearchOutlined",
  path: "/search/smart", section: "situationRoom", isCustom: true, disable: false,
};
```
```js
if (!findByKey(cloned, "smartsearch")) {
  cloned.push(JSON.parse(JSON.stringify(SMART_SEARCH_ITEM)));
}
```

**`console-react/src/utils/devSidebarFixture.js`** — add after the `"Search"` entry:
```js
{
  label: "Smart Search", key: "smartsearch", icon: "SearchOutlined",
  path: "/search/smart", section: "situationRoom",
  isAuditor: true, isCoAdmin: true, isCustom: true, disable: false,
},
```
If this ODC uses a Mongo-driven sidebar instead of these files, add the same
`{ label:"Smart Search", key:"smartsearch", path:"/search/smart", ... }` item
to the relevant role's menu document — the route is what matters.

> If any of the 3 files don't exist / differ in this ODC, just ensure the
> route `/search/smart → <SmartSearch/>` is registered and a sidebar entry
> points to it. Everything else is self-contained.

## Step 4 — run the backend
```bash
cd "$ODC/search_orchestrator"
pip install -r requirements.txt
cp .env.example .env     # then fill GROQ_API_KEY and WAREHOUSE_DATABASE_URL
python -m uvicorn main:app --host 0.0.0.0 --port 8600
```
`GROQ_API_KEY` = a Groq API key. `WAREHOUSE_DATABASE_URL` = read-only
SQLAlchemy URL to the FMOH Postgres that has `dim_dashboard_mapping` and the
`fact_indicator_data_*` tables, e.g.
`postgresql+psycopg2://user:pass@host:5432/db`.

Point the frontend at it with env var `REACT_APP_SEARCH_ORCHESTRATOR_URL`
(defaults to `http://localhost:8600`).

## Step 5 — build the metadata layer (once, then when Power BI content changes)
The search catalog needs chart titles + preview images crawled from live
Power BI. Run these from `search_orchestrator/` (headless Chromium):
```bash
python -m playwright install chromium   # first time only
python crawl_visuals.py                 # dashboards -> pages/charts -> chart_metadata.parquet
python snap_visuals.py                  # per-chart preview PNGs -> thumbnails_visual/
```
Until this runs, search still works at dashboard level only. These outputs and
`.env` are git-ignored — regenerate per environment, don't commit them.

## Step 6 — verify
```bash
curl http://localhost:8600/health
# -> {"ok":true,"catalog_rows":<n>,"chart_metadata_loaded":true|false}
curl -s -X POST http://localhost:8600/search/orchestrate \
  -H "Content-Type: application/json" -d '{"query":"malaria testing"}'
# -> {"available":true,"matches":[...],...}
```
In the app, open `/search/smart`, ask "malaria testing", click a result (it
embeds that chart), then try "Create your own chart" → a data question like
"malaria cases over time".

## Ground rules
- New feature only; do NOT modify the existing `SearchEngine` / old search.
- Work on a new branch + PR. Never force-push a shared branch.
- Never commit `.env`, `chart_metadata.parquet`, or `thumbnails*/`.
- The backend `create your own chart` flow builds SQL from templates with
  bound params (no raw LLM SQL) — keep it that way.
