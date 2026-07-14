# Smart Search — handoff bundle

Everything needed to add **Smart Search** to `odc_new_ui/console-react`.
Smart Search is a new, natural-language search over the FMOH Power BI
dashboards (finds the matching dashboard / page / chart), with a
"create your own chart" fallback (NL → SQL → an ECharts chart) when no
existing chart fits. It is separate from the old keyword `SearchEngine` —
that stays untouched.

This folder is a **backup / handoff copy** kept in `final-disease-pred`. The
files actually run inside the `odc_new_ui` repo at the paths shown below.

## 1. New files — copy as-is

**Backend →** put the whole folder at `odc_new_ui/search_orchestrator/`:
- `search_orchestrator/main.py` — FastAPI + Groq orchestrator (search, embed
  token, thumbnails, create-chart endpoints)
- `search_orchestrator/metadata.py` — catalog from `dim_dashboard_mapping` +
  crawled page/chart parquet
- `search_orchestrator/create_chart.py` — NL → structured spec → templated SQL
- `search_orchestrator/crawl_visuals.py` — headless crawler for chart titles
- `search_orchestrator/snap_visuals.py` — headless per-chart preview images
- `search_orchestrator/requirements.txt`
- `search_orchestrator/.env.example`, `.gitignore`, `README.md`

**Frontend →** put these at `odc_new_ui/console-react/src/pages/smartsearch/`:
- `SmartSearch.js`, `SmartSearch.scss` — chat UI
- `smartSearchApi.js` — backend client
- `ChartRenderer.js` — ECharts renderer (glowing white line default)
- `chartCrawl.js`, `ChartCrawler.js` — in-browser chart-title crawler (admin)

## 2. Existing files — add these snippets (do NOT overwrite; they hold other changes)

### `console-react/src/routes/routes.js`
Near the other `lazy(...)` imports (after the `SearchEngine` import):
```js
const SmartSearch = lazy(() => import("../pages/smartsearch/SmartSearch"));
const ChartCrawler = lazy(() => import("../pages/smartsearch/ChartCrawler"));
```
In the routes array, right after the existing `{ path: "/search", ... }`:
```js
{ path: "/search/smart", name: "Smart Search", key: "smartsearch", element: <SmartSearch /> },
{ path: "/search/smart/crawl", name: "Chart Metadata Crawler", key: "smartsearchcrawl", element: <ChartCrawler /> },
```

### `console-react/src/utils/localFeatureAdditions.js`
Add the const (e.g. above `function findByKey`):
```js
const SMART_SEARCH_ITEM = {
  label: "Smart Search", key: "smartsearch", icon: "SearchOutlined",
  path: "/search/smart", section: "situationRoom", isCustom: true, disable: false,
};
```
Inside `injectLocalFeatureAdditions`, after the existing `ml_predictive` push:
```js
if (!findByKey(cloned, "smartsearch")) {
  cloned.push(JSON.parse(JSON.stringify(SMART_SEARCH_ITEM)));
}
```

### `console-react/src/utils/devSidebarFixture.js`
Add this object right after the existing `"Search"` entry:
```js
{
  label: "Smart Search", key: "smartsearch", icon: "SearchOutlined",
  path: "/search/smart", section: "situationRoom",
  isAuditor: true, isCoAdmin: true, isCustom: true, disable: false,
},
```

## 3. Backend setup (deployment box)

```bash
cd search_orchestrator
pip install -r requirements.txt
cp .env.example .env      # fill GROQ_API_KEY + WAREHOUSE_DATABASE_URL
uvicorn main:app --host 0.0.0.0 --port 8600
```

Then, once, build the metadata layer (embeds each dashboard headlessly):
```bash
python -m playwright install chromium   # first time only
python crawl_visuals.py                 # chart titles -> chart_metadata.parquet
python snap_visuals.py                  # per-chart preview images
```

The frontend reaches the backend via `REACT_APP_SEARCH_ORCHESTRATOR_URL`
(default `http://localhost:8600`).

**Not included on purpose** (secrets / generated, regenerate on the box):
`.env`, `chart_metadata.parquet`, `thumbnails/`, `thumbnails_visual/`, logs.
