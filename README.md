# Malaria Risk Intelligence — Nigeria
### Complete technical specification (for rebuilding/recreating this exact application)

> **Read this entire document before touching the code.** It is written so a Claude session with **zero prior context** on this repository can understand, recreate, or extend the application exactly as it currently exists. It documents every formula, every color, every API contract, every file's role, and every piece of business logic — down to constants and edge cases. Nothing here is approximate; every number and snippet below was copied verbatim from the working source files.

---

## 0. What this project is, in one paragraph

A malaria forecasting and intervention-planning platform for Nigeria, built on real DHIS2 (District Health Information System 2) facility-level surveillance data (3,269,768 raw rows × 123 columns, aggregated up to ward → LGA → state → national). It has a **FastAPI backend** (`api.py`, port **8001**) serving pre-computed JSON exports plus live SARIMAX forecasting/what-if endpoints, and a **React + Vite frontend** (`ui/`, port **3000**) with a sidebar of views: an interactive deck.gl map with a 5-zone hotspot "burden score," a driver-elasticity what-if simulator, an AI-assisted (Groq LLM) budget-planning "What-If Lab," and a deep "Model Lab" benchmarking 18+ ML/DL/time-series/classification models.

**There is only one model build, "After"** — the WHO/SEIR-augmented build (real external climate/spatial data merged in, plus mechanistic-epidemiology derived features on top of the DHIS2 programme indicators). An earlier iteration of this app had a "Before" baseline build (DHIS2 indicators only, no climate/SEIR features) selectable via a toggle in the UI — **that toggle has been removed**; the app now always loads the After-variant data (`variant` is hardcoded to `'after'` in `App.jsx`, no `setVariant`/switcher rendered). The underlying data pipeline and JSON exports still physically support a `before` variant (env var `MAL_VARIANT`, a `ui/public/data/before/` folder) for anyone re-running the Python pipeline, but nothing in the running frontend ever requests or displays it anymore — treat "After" as the one and only real build going forward.

---

## 1. Tech stack — exact versions

### Frontend (`ui/package.json`)
```json
{
  "dependencies": {
    "@deck.gl/react": "^9.3.5",
    "deck.gl": "^9.3.5",
    "maplibre-gl": "^4.7.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-map-gl": "^7.1.9",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0"
  },
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" }
}
```
- **deck.gl 9.3.5** (`@deck.gl/react` + `deck.gl`) — WebGL map rendering, used only in `VisualOverview.jsx` via `<DeckGL>` + `GeoJsonLayer`.
- **react-map-gl 7.1.9**, imported from the **`react-map-gl/maplibre`** subpath (not the default Mapbox path) — paired with **maplibre-gl 4.7.1** as the underlying map engine (no Mapbox token needed).
- Basemap tiles: **CARTO Positron** style JSON at `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` (free, no API key).
- **recharts 2.12.7** — every chart in the app except the deck.gl map: `AreaChart`, `LineChart`, `BarChart`, used inside shared wrapper components (`ForecastChart`, `CompareChart`, `ModelOverlay`, `AnnualBars`, `HBars`) in `components.jsx`, plus a raw inline `LineChart` in `WhatIfLab.jsx`.
- **React 18.3.1**, mounted via `createRoot` + `<React.StrictMode>` in `main.jsx`.
- **Vite 5.4.0** — dev server + bundler, with `@vitejs/plugin-react` for JSX/Fast Refresh.
- No router library — navigation is plain `useState` view-switching in `App.jsx` (no URLs change per view).
- No CSS framework — one hand-written stylesheet, `ui/src/styles.css`, using CSS variables for theming.
- No state-management library — `useState`/`useMemo`/`useEffect` only, data fetched once per Before/After variant via a custom `useData()` hook.

### Backend (Python)
- **FastAPI** (`api.py`) with `CORSMiddleware(allow_origins=["*"])` (fully open CORS — local/dev posture).
- **uvicorn** — `uvicorn.run("api:app", host="0.0.0.0", port=8001, reload=True)` — a stray docstring comment elsewhere says "port 8000" but the actual running port is **8001**; the Vite proxy (below) points at 8001 and is authoritative.
- **pandas / numpy** — all aggregation, panel-building, feature engineering.
- **statsmodels** — `from statsmodels.tsa.statespace.sarimax import SARIMAX` for all forecasting (national/state/What-If Lab).
- **groq** Python SDK (`from groq import Groq`) — calls model **`llama-3.1-8b-instant`** for AI-generated budget plans (forward and reverse mode). Requires `GROQ_API_KEY` in a `.env` file in the project root; `api.py` calls `load_dotenv(override=True)` **on every request that needs Groq** (not just at startup), so changing the API key in `.env` takes effect without restarting the server. If the key is missing: `HTTPException(500, "GROQ_API_KEY not set in .env")`.
- **scikit-learn / xgboost / lightgbm / catboost / torch (PyTorch)** — used by the offline model-benchmarking scripts (`model_suite.py` etc.) that produce the static JSON the Model Lab view reads; not called live by the API.
- Data store: a single **parquet** file, `agg_lga_pop.parquet` (loaded once globally by `api.py`'s `get_df()`), the fully aggregated LGA×month panel including population.
- Proposal persistence: a flat JSON file, `budget_proposals.json`, read/written by `_load_proposals()` / `_save_proposals()` — no real database anywhere in this stack.

### Dev server wiring
`ui/vite.config.js`:
```js
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: { '/api': { target: 'http://localhost:8001', changeOrigin: true } },
  },
})
```
In dev, the frontend calls relative paths like `fetch('/api/forecast', ...)` and Vite transparently proxies them to FastAPI on 8001. `ui/index.html` sets the page title `"Malaria Risk Intelligence · Nigeria"`, an inline-SVG mosquito-emoji favicon, and mounts `<div id="root">` loaded by `/src/main.jsx`.

---

## 2. Repository layout (relevant parts)

```
final_disease_pred/
├── api.py                     # FastAPI backend — port 8001
├── features.py                # shared panel construction + feature engineering (used by all model scripts)
├── drivers.py                 # builds ui/public/data/<variant>/drivers.json (What-If Simulator baselines)
├── export_burden.py           # builds ui/public/data/<variant>/burden.json (Visual Overview hotspot inputs)
├── agg_lga_pop.parquet        # the master aggregated panel (LGA × month, with population)
├── budget_proposals.json      # flat-file persistence for saved What-If Lab budget proposals
├── .env                       # GROQ_API_KEY=...
├── aggregation_map.json       # which of the 114 DHIS2 indicator columns are SUM vs MEAN
├── selected_features.json     # {"selected": [...]} — top-K feature list chosen by importance ranking
├── (many pipeline scripts)    # aggregate.py, population_data.py, seir.py, model_suite.py,
│                               #  multimodel_forecast.py, modellab_data.py, export_ui_data.py,
│                               #  export_data_view.py, agg_config.py, enrich_pop.py, impute_gaps.py,
│                               #  validation_export.py, correlation.py, consolidate_dataset.py,
│                               #  fetch_external.py, fetch_geo.py, fetch_pfpr.py,
│                               #  integrate_external.py, integrate_external2.py,
│                               #  feature_selection.py, ts_util.py, metrics_util.py
└── ui/
    ├── package.json, vite.config.js, index.html
    ├── public/data/
    │   ├── geo/states.geojson, geo/lgas.geojson      # shared, variant-independent boundary files
    │   ├── before/  national.json states.json geo.json meta.json drivers.json
    │   │             leaderboard.json avp.json hotspots.json burden.json
    │   └── after/   (same filenames as above, "after"-variant content)
    └── src/
        ├── main.jsx, App.jsx, lib.js, components.jsx, styles.css
        ├── glossary.js          # data-dictionary text consumed by ModelLab.jsx (meaningFor/detailFor/SOURCES/ABBREV)
        ├── framework.js         # DHIS2-vs-non-DHIS2 catalogue consumed by Methodology.jsx (CATALOGUE/STATUS/MODELS_FRAMEWORK)
        └── views/
            ├── VisualOverview.jsx   # 🗺️ Visual Overview / 🌍 All-LGA Hotspot Map
            ├── Simulator.jsx        # 🎛️ What-If Simulator
            ├── WhatIfLab.jsx        # 🔬 What-If Lab (SARIMAX + Groq budget planning)
            ├── Overview.jsx         # 📊 National Overview (ML experiments) — Deep Dive
            ├── ModelLab.jsx         # 🧪 Model Lab — Deep Dive
            ├── DataExplorer.jsx     # 🗄️ Data Explorer — Deep Dive
            ├── Methodology.jsx      # 🧬 Model & Methodology — Deep Dive
            ├── GeoExplorer.jsx      # (not in nav anymore, still reachable if view state set to 'geo')
            └── Forecast.jsx         # (not in nav anymore, still reachable if view state set to 'forecast')
```

The Python pipeline scripts still support two **"variants"**, `before` and `after`, controlled by the env var `MAL_VARIANT` (`os.environ.get("MAL_VARIANT","after")`), and every static JSON export still physically exists twice — once under `ui/public/data/before/` and once under `ui/public/data/after/`, with identical filenames/schemas (only the GeoJSON boundary files, `data/geo/*.geojson`, are shared/variant-independent). **The frontend no longer exposes a toggle for this.** `App.jsx` hardcodes `const variant = 'after'` (no `useState`, no switcher UI) — every component still receives a `variant` prop (most default it to `'after'` anyway) and `lib.js`'s `useData(variant)` still fetches from `data/${variant}/...`, but in the running app `variant` is always `'after'`. If the `before` data folder is ever deleted, nothing in the live app would break; it is simply dead/unused output of the Python pipeline at this point.

---

## 3. Backend: `api.py` — full API contract

### Globals & setup
- `get_df()` — lazily loads `agg_lga_pop.parquet` once into a module-level dataframe.
- `BASELINE_KEYS` — set of environmental/demographic/static columns (population, rainfall, temperature, humidity, elevation, latitude, etc.) that are **locked** in What-If mode — you cannot treat the weather as an "intervention."
- `intervention_cols` — every other numeric column that isn't a baseline key: the actionable programme/intervention indicators (ACT given, LLINs distributed, RDTs tested, IPTp coverage, etc.).
- `DEFAULT_TARGETS` — list of 5 possible SARIMAX forecast targets (confirmed cases, total reported cases, RDT-tested, RDT-positive, deaths, etc. — the candidate dependent variables a user can forecast).
- `USD_NGN = 1600` — fixed USD→Naira conversion constant (also duplicated client-side in `WhatIfLab.jsx`).
- `UNIT_COSTS` — dict mapping intervention column → `(label, ₦cost_per_unit)`:

  | Intervention column | Label | Unit cost (₦) |
  |---|---|---|
  | ACT given | ACT course | 150 |
  | LLIN given | LLIN net | 2,500 |
  | RDT tested | RDT kit | 600 |
  | IPTp dose | IPTp-SP dose | 200 |
  | Anti-malarial treatment | Anti-malarial course | 180 |

- `PROPOSALS_FILE = "budget_proposals.json"` with `_load_proposals()` / `_save_proposals()` doing plain `json.load`/`json.dump`.

### Helper functions
- `agg_level(df, level, state_name)` — aggregates the LGA×month panel to **national** or a single **state**, monthly. Uses `MEAN_AGG_KEYS` to decide which columns get summed across LGAs (counts) vs averaged (rates/percentages/environmental).
- `project_exog(...)` — projects every exogenous covariate column forward into the forecast horizon using **that column's own last-12-actual-months seasonal mean** (a simple climatology projection — same spirit as `drivers.py`'s driver forecasting, but computed independently here).
- `trim_trailing_zeros(...)` — drops trailing rows that are entirely zero/NaN (months not yet reported), so the model doesn't train on artificial zeros at the end of the series.
- `run_sarimax(series, exog_train, exog_future, horizon)` — the core forecasting function, used everywhere SARIMAX is needed:
  - Tries **3 candidate `(order, seasonal_order)` pairs**, in order:
    1. `(1,1,1) x (1,0,1,12)`
    2. `(2,1,1) x (1,0,1,12)`
    3. `(1,1,2) x (1,0,1,12)`
  - For each, fits `SARIMAX(series, exog=exog_train, order=order, seasonal_order=seasonal_order, trend="c", enforce_stationarity=False, enforce_invertibility=False)`.
  - Picks whichever of the 3 successfully-fit models has the **lowest AIC**.
  - Forecasts `horizon` steps ahead using `exog_future`.
  - **Fallback**: if all 3 candidate fits fail (e.g. insufficient data), falls back to a **naive seasonal repeat** (repeats the last 12 actual values cyclically).

### Pydantic request models
- `ForecastReq` — base request: `level` ("national"/state name), `target` (one of `DEFAULT_TARGETS`), `exog_cols` (list of covariate columns to include), `horizon` (months ahead).
- `WhatIfReq(ForecastReq)` — adds `interventions: Dict[str, float]` — a map of intervention-column name → **percent change** (e.g. `{"ACT given": 50}` = +50% ACT distribution vs. baseline).
- `BudgetReq` — scope/level, population, the chosen interventions (with their percent changes), used to build the forward-mode Groq prompt.
- `OptimizeReq` — `budget_ngn` (total available budget in Naira) + `candidate_interventions` (optional list, defaults to all keys of `UNIT_COSTS`), used for the reverse-mode optimizer.
- `Proposal` — a savable budget plan: scope, interventions, generated plan text/breakdown, auto-incrementing `version`, `id` (`uuid.hex[:12]`), UTC `timestamp`.

### Endpoints

#### `GET /api/meta`
Returns `{ states: [...], targets: DEFAULT_TARGETS, baseline_cols: [...], intervention_cols: [...], all_numeric: [...] }` — drives the What-If Lab's scope/feature pickers.

#### `POST /api/forecast`
"Plug & play" SARIMAX: pick any level (national or a state), any target column, any subset of numeric columns as `exog_cols`, a horizon — and the backend fits SARIMAX live and returns historical + forecast series. No interventions involved; this is the "raw model exploration" mode of the What-If Lab.

#### `POST /api/whatif`
The intervention-scenario endpoint. Internally calls the shared `_compute_whatif()`:
1. Builds the **baseline SARIMAX forecast** using only the non-intervention/environmental covariates as exog (i.e. the model's natural forward path with no manual scaling).
2. Computes the combined **intervention multiplier** via `_intervention_mult(interventions)`.
3. Returns `whatif = base_forecast * multiplier` for every forecast month, alongside the unmodified `base` series, for the chart to show both lines.

`ELASTICITY` dict — **NOTE: this is a separate, slightly different table from `drivers.py`'s `DRIVER_META`** (different values/columns — the three what-if mechanisms in this app are NOT unified, see §8):

| Column (substring match) | Elasticity |
|---|---|
| ACT | -0.30 |
| "Number of malaria cases treated with artemisinin-based combinat..." | -0.30 |
| "Anti-Malarial treatment" | -0.18 |
| "...under 5 yrs" (treatment, under-5) | -0.20 |
| LLIN | -0.40 |
| "Children <5 yrs who received LLIN" | -0.30 |
| RDT tested | -0.12 |
| IPTp1 Coverage | -0.20 |
| IPTp2 Coverage | -0.18 |
| IPTp3 Coverage | -0.15 |

`_intervention_mult(interventions)`:
```python
mult = 1.0
for col, pct_change in interventions.items():
    elasticity = ELASTICITY.get(matching_key, 0)
    mult *= (1 + elasticity * (pct_change / 100))
mult = clamp(mult, 0.1, 3.0)
```
Each intervention's percent change is multiplied by its elasticity and combined multiplicatively across all interventions provided, then the whole product is clamped to `[0.1, 3.0]×` baseline.

#### `POST /api/budget` — forward mode (interventions → AI-generated budget plan)
1. Computes baseline/what-if forecasts as above.
2. Builds a detailed text prompt for Groq containing: the geographic scope, population, the chosen interventions and their percent changes, **grounded unit costs** (via `_costs_text()`, which renders the `UNIT_COSTS` table into prose so the LLM can't invent prices), and a **month-by-month forecast table**.
3. Asks the LLM (in the prompt) to produce, in order:
   1. A month-by-month deployment table (units needed per month).
   2. An intervention cost breakdown.
   3. A total budget summary.
   4. Geographic prioritisation guidance.
   5. A procurement/logistics timeline.
   6. Risk flags.
4. Calls Groq `llama-3.1-8b-instant`, `max_tokens=3500`, `temperature=0.3`.
5. Returns the raw LLM text (rendered as the "AI budget plan" in the UI) plus the underlying base/whatif numeric series.

#### `POST /api/budget-optimize` — reverse mode (budget → AI-picked interventions → closed-loop SARIMAX)
1. Takes a total `budget_ngn` and an optional candidate list (defaults to all `UNIT_COSTS` keys).
2. Prompts Groq to **pick an intervention mix that maximizes cases averted while staying within the budget**, instructing it to return its chosen percent-changes inside a tagged block: `<INTERVENTIONS_JSON>{ "ACT given": 35, "LLIN given": 60, ... }</INTERVENTIONS_JSON>`.
3. `_extract_json_block(text, tag="INTERVENTIONS_JSON")` — regex-extracts that tagged block from the LLM's free-text response; if the tag isn't found, falls back to grabbing the **first `{...}` substring** anywhere in the text (defensive parsing against an LLM that forgets the exact tag).
4. Each returned intervention percent is **clamped to `[-80, 200]`** (can't propose cutting an intervention more than 80% or scaling it more than 200%).
5. Runs `_compute_whatif()` **closed-loop** with the AI's chosen interventions — i.e. the AI's picks are fed back through the *real* SARIMAX model, not just trusted as numbers, so the resulting chart reflects an actual statistical forecast, not an LLM hallucination.
6. Returns the AI's chosen mix, the resulting base/whatif series, and the LLM's reasoning text.

#### `GET /api/proposals`, `POST /api/proposals`, `DELETE /api/proposals/{id}`
Simple CRUD over `budget_proposals.json`. POST auto-assigns `id = uuid.uuid4().hex[:12]`, `version` (increments if a proposal with the same scope/name already exists), and a UTC `timestamp`. Used by the "Save proposal" / "Compare proposals" UI in `WhatIfLab.jsx`.

---

## 4. Data pipeline scripts (Python)

### `features.py` — the shared feature-engineering module used by every model script
- `VARIANT = os.environ.get("MAL_VARIANT", "after")`; `AFTER = VARIANT == "after"` — the before/after switch lives here, at the root of feature construction.
- `TARGET = "MAL - Malaria cases confirmed (number)"` — the single dependent variable every model predicts.
- `TRAIN_END = 2025*12 + 11` (Dec 2025); `VAL_MONTHS` = Q1 2026 (held out for true validation); `FC_END = 2030*12 + 11` (forecast horizon runs to Dec 2030).
- `DRIVERS` dict — a small name→short-id mapping (`itn, llin, act, rdt, iptp, rain, temp, hum`). **Important nuance**: `drivers.py` imports the name `DRIVERS` from this module but does **not actually use it** for its driver list — it defines its own, richer `DRIVER_META` dict with 10 drivers (adding `u5llin`, `treat`, `fevrdt` and different source columns). The import is effectively vestigial; the real list of What-If Simulator drivers is `drivers.py`'s own `DRIVER_META` (§6 below).
- `INDICATOR_FEATURES` — the 114 DHIS2 programme-indicator columns, loaded from `aggregation_map.json`, split into 33 SUM-type and 82 MEAN-type indicators.
- `EXTERNAL_COLS` — real external datasets merged in by `integrate_external.py`: `ndvi`, `ndvi_anom` (vegetation index, FEWS NET/NDVI), `enso_oni` (El Niño index), `iod_dmi` (Indian Ocean Dipole index), `pfpr` (Malaria Atlas Project Plasmodium falciparum parasite rate), `elevation` (SRTM), `latitude`, `pop_density`, `poverty_mpi_h` and `dep_schooling`/`dep_electricity`/`dep_water`/`dep_housing` (Multidimensional Poverty Index deprivation components).
- `AFTER_DERIVED` — list of WHO/SEIR-aligned mechanistic features, **only computed when `AFTER=True`**:
  - Climate lags: `rain_lag1`, `rain_lag2`, `rain_cum3` (3-month cumulative rainfall), `rain_anom` (anomaly vs climatology), `temp_lag1`, `temp_suitability` (Gaussian suitability curve around an optimum), `dtr` (diurnal temp range), `temp_anom`, `hum_lag1`.
  - SEIR/transmission proxies: `eir_proxy` (entomological inoculation rate proxy), `recruitment_proxy`, `mortality_proxy`, `r0_proxy` (basic reproduction number proxy).
  - Surveillance-trend lags: `tpr_lag1` (test positivity rate lag), `lag6`, `lag12`, `roll3`, `roll6` (rolling means of cases), `yoy_change` (year-over-year change).
  - Spatial spillover: `spatial_lag1` (neighboring/state-level lagged signal).
  - Plus real external data already listed above (NDVI, ENSO/IOD, PfPR, elevation, MPI poverty).
- `BASE_FEATURES = ["lag1","lag2","lag3","population","year","month","state_level","lga_level"]`.
- `CANDIDATE_FEATURES = BASE_FEATURES + INDICATOR_FEATURES + (AFTER_DERIVED names if AFTER else [])` — **122 total candidates** before the AFTER-derived layer (8 base + 114 indicators); the headline "122 candidates" figure quoted across the UI refers to this base+indicator set.
- `FEATURES` — the actual model input list: loaded from `selected_features.json`'s `"selected"` key if that file exists, else falls back to the full `CANDIDATE_FEATURES`.
- `FEATURE_DOC` — a dict of plain-English documentation strings per feature name (consumed by the Model Lab's "Data dictionary" tab).
- `_san()` / `_safe_names()` — sanitize feature names to alphanumeric+underscore only (XGBoost/LightGBM raise errors on special characters like `%`, `(`, `)` in column names — DHIS2 indicator names are full of those).
- `Xmat_for(df, feats)` / `Xmat(df)` — build the final numeric feature matrix for a model.
- `load_panel()` — constructs the **complete LGA × month panel from 2023-01 through 2030-12**:
  1. Cross-joins every LGA with every month in range.
  2. Merges in the 114 DHIS2 indicators.
  3. **Blanks** (sets to NaN) all indicator columns beyond the last actual reporting month — `panel.loc[panel.ym > LAST_ACTUAL, EXO] = np.nan` — so the forecast horizon gets filled by **climatology projection**, not by inheriting whatever zero/placeholder value would otherwise sit there.
  4. Computes `fac_share` — each LGA's share of total health-facility count within its state — used to **split state-level population down to LGA level** proportionally.
  5. Computes a **damped per-LGA, per-feature trend forecast**: `DAMP = 0.5`, `MID = 2024` (the trend's anchor year), bounded to **±100% of climatology** so no feature's projected value can run away to an absurd extreme.
  6. Computes `state_level` / `lga_level` — train-only mean-log-cases encodings (a target-encoding style feature, computed strictly on the training window to avoid leakage).
  7. Computes `snaive` — the 12-month-shifted seasonal-naive value of cases (used as a baseline/feature for some models).
- `build_features(p)` — adds `lag1/2/3` (log-transformed lags of cases), and when `AFTER=True`, all the SEIR/climate/surveillance/spatial derived columns listed above, including exact formulas:
  - `temp_suitability = exp(-((temp - 25) / 7) ** 2)` — a Gaussian curve peaking at 25°C (the mosquito/parasite thermal optimum assumed here).
  - `mortality_proxy = clip(|temp - 25| / 15, 0, 1)`.
  - `eir_proxy = suitability * normalized_rain * normalized_humidity`.
  - `r0_proxy = (tpr_lag1 / 100) * (1 + clip(yoy_change, -1, 2))`.
  - `spatial_lag1` = the state-mean log-cases series, shifted by 1 month (a simple spatial-spillover proxy — a given LGA's risk is partly explained by its state's recent average, lagged).

### `export_burden.py` — builds `ui/public/data/<variant>/burden.json` (powers Visual Overview)
- Reads `agg_lga_pop.parquet` directly (not through `features.py`).
- `FIELD` dict maps 12 short keys to their exact DHIS2 source column names: `cases`, `total`, `rdt_done`, `rdt_pos`, `act`, `treated`, `itn`, `llin`, `ipt_cov`, `rain`, `temp`, `hum`.
- `COUNT = ["cases","total","rdt_done","rdt_pos","act","treated","itn","llin"]` (summed across LGAs when aggregating to state level) vs `RATE = ["ipt_cov","rain","temp","hum"]` (averaged).
- **Bug fix #1 (outlier clipping)**: `ipt_cov` is meant to be a 0–100% coverage rate but the raw DHIS2 export has outliers up to ~1×10⁸ in some rows — clipped to `[0, 100]` before any aggregation.
- **Bug fix #2 (NaN-vs-zero climatology)**: `rain`/`temp`/`hum` only have real weather-grid coverage for 2023–2025; 2020–2022 and 2026 are **entirely missing**, not zero. The code deliberately leaves these as `NaN` (does **not** `.fillna(0.0)` them like every other field) specifically so that `.groupby().mean()` **skips** the missing years when computing calendar-month climatology — filling with 0 would have silently dragged every month's seasonal average down by roughly 3× once averaged in. The exact code:
  ```python
  ENV_FIELDS = {"rain", "temp", "hum"}
  ...
  w[f] = raw if f in ENV_FIELDS else raw.fillna(0.0)
  ```
- **Data-quality flags**: `rdt_pos`, `treated`, `itn` are columns that exist in the schema but are **entirely zero across the whole dataset** (never actually collected/reported). The script detects this (`FLAGS = {"no_rdt_pos": ..., "no_treated": ..., "no_itn": ...}`) and ships the flags in the JSON so the frontend can substitute a **neutral assumption** (a flat 0.55 RDT-positivity rate) instead of treating a measured "0" as if it meant zero malaria.
- **Month windows**:
  - `ACTUAL = 2024-01 .. 2025-12` (24 months, `forecast: false`)
  - `FCAST = 2026-01 .. 2026-12` (12 months, `forecast: true`)
  - Combined `MONTHS` array of 36 entries: `{ym: "YYYY-MM", label: "Mon 'YY", forecast: bool}`.
- `series_for(panel)` — for one area (LGA or state), builds aligned arrays for every field across all 36 months:
  - Actual months use real values, falling back to that area's own calendar-month climatology if a specific month is missing.
  - Forecast months (2026) are **always** the calendar-month climatology (no SARIMAX here — this view's forecast is a simple seasonal-average projection, intentionally simpler/faster than the What-If Lab's SARIMAX).
  - Also computes a **`trend`** array: a 3-month-vs-prior-3-month rolling case trend, `clip((recent3 - prior3) / prior3, -1, 3)`, used as input factor A2 in the burden score (§5).
- Rounds counts to integers, rates to 2 decimals; replaces NaN/Inf with 0 on output.
- Per-LGA aggregation: `groupby(["state","lga"])`, mean per month. Per-state aggregation: counts summed across LGAs per month, rates averaged.
- Output written to **both** `ui/public/data/before/burden.json` and `ui/public/data/after/burden.json` if those directories exist.
- Logs a "rainy-season sanity check": prints which month the national mean rainfall peaks at, as a smoke test that the climatology computation is sane.

### `drivers.py` — builds `ui/public/data/<variant>/drivers.json` (powers the What-If Simulator)
This is the **second, independent** elasticity/lever system in the app (distinct from `export_burden.py`'s burden score and from `api.py`'s `ELASTICITY`/`UNIT_COSTS`). Three steps per location (national/state/LGA):
1. Measure each driver's **recent baseline** = mean of the **last 12 reported actual months** (`recent12`, ending at `LAST = 2026*12 + 2`, i.e. March 2026).
2. **Forecast the driver forward to 2028** via `forecast_driver()`: calendar-month climatology **plus a damped annual trend** — `slope = np.polyfit(year, yearly_mean, 1)[0] * 0.4` (the 0.4 factor damps the trend so it doesn't extrapolate too aggressively). This is exactly why sliders in the Simulator start at a **forecasted** baseline rather than the simple last-known value — "the model's own forecast — what the baseline assumes."
3. Derive a **slider range** `[lo, hi]`: temperature gets `base ± 5°C`; percentage-type drivers get `[0, cap]` (cap defaults to 100); count-type drivers get `[0, max(base*2, hist*2, 1)]`.

`DRIVER_META` — the **10 drivers** actually used by the Simulator (verbatim):

| id | Source column | Label | Unit | Agg | Category | Elasticity | good | Notes |
|---|---|---|---|---|---|---|---|---|
| `llin` | LLIN given – Total | LLINs distributed | nets/mo | sum | Vector Control | -0.40 | down | population-wide |
| `u5llin` | % Under 5 receiving LLIN | Under-5 LLIN coverage | % | mean | Vector Control | -0.30 | down | cap 100, **audience 0.35** (under-5 ≈35% of cases) |
| `act` | ACT Given - Total | ACT treatment courses | /mo | sum | Treatment & Diagnostics | -0.30 | down | population-wide |
| `treat` | % of Persons Clinically diagnosed treated with ACT | Diagnosed patients treated with ACT | % | mean | Treatment & Diagnostics | -0.18 | down | cap 100 |
| `rdt` | MAL - Malaria cases tested with RDT | RDT tests performed | /mo | sum | Treatment & Diagnostics | -0.12 | down | population-wide |
| `fevrdt` | % of Fever cases Tested with RDT | Fever-case RDT testing | % | mean | Treatment & Diagnostics | -0.15 | down | cap 100 |
| `iptp` | IPTp1 Coverage (institutional) | IPTp coverage (pregnant women) | % | mean | Maternal & Child Health | -0.20 | down | cap 100, **audience 0.08** (pregnant women ≈8% of cases) |
| `rain` | rainfall_mm_day | Rainfall | mm/d | mean | Environmental | +0.30 | up | risk factor |
| `temp` | temperature_mean_c | Mean temperature | °C | mean | Environmental | -0.06 | **opt** (optimum=27) | non-monotonic — see `factor()` below |
| `hum` | humidity_pct | Relative humidity | % | mean | Environmental | +0.18 | up | cap 100 |

- **"Audience" concept**: a 0–1 fraction representing what share of *total confirmed cases* a subgroup-targeted intervention can plausibly influence. Without this, e.g. moving "Under-5 LLIN coverage" would mathematically swing the *entire* national case count as if it protected every age group — wildly overstating its power. `u5llin` → 0.35 (NMEP/WHO-cited under-5 share), `iptp` → 0.08 (pregnant-women share). Drivers without an `audience` key are treated as population-wide (audience = 1).
- **Outlier clipping**: same `ipt_cov`-style clip applied here too — any column with a `"cap"` key gets `.clip(lower=0, upper=cap)` **before** aggregation, for the same reason as `export_burden.py` (raw DHIS2 percent columns sometimes contain outliers up to ~1e8).
- Exports: `meta` (the table above, serialized), `national`, `states` (per-state baselines), `lgas` (per-LGA baselines, kept compact — values only, no trajectory), `national_traj` and `state_traj` (full monthly forecast trajectories per driver, for the "Conditional driver outlook" chart).
- `clean()` — recursively replaces any NaN/Inf float with `0.0` before JSON serialization (since `json.dump(..., allow_nan=False)` is used, which would otherwise raise on NaN).

---

## 5. Visual Overview / All-LGA Hotspot Map (`VisualOverview.jsx`)

This is the **primary, minister-facing view** — the first thing in the sidebar, the only view using the deck.gl map. It exists in two modes from one component: **"Visual Overview"** (state drill-down: pick a state, see its LGAs) and **"All-LGA Hotspot Map"** (`allLgas` prop = true: every LGA nationwide shown flat, capped at 150 rendered cards, drill-down disabled).

### Data sources
Fetches `ui/public/data/geo/states.geojson` and `ui/public/data/geo/lgas.geojson` (shared, variant-independent boundary polygons) plus `ui/public/data/<variant>/burden.json` (the per-area monthly indicator arrays built by `export_burden.py`, §4).

### The 5-zone classification system
```js
const ZONES = {
  'Not a Hotspot': { c: '#64748b', fill: [148,163,184], a: 90  },
  'Green':         { c: '#16a34a', fill: [ 22,163, 74], a: 200 },
  'Yellow':        { c: '#ca8a04', t: '#a16207', fill: [234,179,  8], a: 205 },
  'Amber':         { c: '#ea580c', t: '#c2410c', fill: [234, 88, 12], a: 210 },
  'Red':           { c: '#dc2626', fill: [220, 38, 38], a: 215 },
}
const ZONE_ORDER = ['Red','Amber','Yellow','Green','Not a Hotspot']
```
`c` = border/primary text color, `t` = an alternate, slightly-darker text-only color used where the base color is too light against a white background (Yellow/Amber only), `fill` = RGB triplet for the deck.gl polygon fill, `a` = fill alpha (0–255).

`scoreToZone(score)` — score is a 0–100 "display burden score"; `s = score/100`:

| Threshold (on 0–1 scale `s`) | Zone |
|---|---|
| `s < 0.18` | Not a Hotspot |
| `s < 0.38` | Green |
| `s < 0.58` | Yellow |
| `s < 0.78` | Amber |
| else (`s ≥ 0.78`) | Red |

Equivalently on the 0–100 display scale: **Red ≥78, Amber 58–78, Yellow 38–58, Green 18–38, Not a Hotspot <18** (these exact thresholds are also spelled out in the `ZONE_INFO` plain-language descriptions shown in the UI's legend tooltips).

### The burden score formula — `scoreDetail(x, peerAvg, flags)`
A **weighted sum of 10 factors**, each independently normalized to roughly [0,1] then multiplied by a fixed weight (weights sum to 100):

| # | Factor | Weight | Formula | Notes |
|---|---|---|---|---|
| A1 | Case volume | 20 | `min(1, cases / (peerAvg × 3))` | `peerAvg` = average cases across this area's peer group (other LGAs in the state, or other states nationally) |
| A2 | Case trend | 15 | `(trend + 1) / 2` | `trend` is the −1..+3 clipped 3-vs-3-month rolling change from `export_burden.py` |
| B1 | RDT positivity | 12 | `positives / tests`, else `0.55` if `flags.no_rdt_pos` | the neutral-fallback flag described in §4 |
| B2 | Treatment gap | 13 | `(total − ACT − treated) / total` | share of total cases NOT covered by ACT or other treatment |
| C1 | Rainfall | 8 | `(mm/day − 3) / 27` | |
| C2 | Temperature | 6 | `1 − |°C − 27| / 12` | peaks at 27°C, same optimum as the Simulator's `temp` driver |
| C3 | Humidity | 6 | `(% − 40) / 55` | |
| D1 | Net gap | 10 | `1 − (ITN + LLIN) / (cases × 2.5)` | |
| D2 | IRS gap | 5 | always `1.0` | **no IRS (indoor residual spraying) data exists in this dataset** — this factor is a constant placeholder, always maxed out, by design (documented limitation, not a bug) |
| D3 | IPT gap | 5 | `1 − IPT_coverage / 100` | |

For each factor: `sub` = the formula's normalized output (clamped to [0,1] via the `cl()` helper), `points = weight × sub`. `raw = sum(all points)` (theoretical max 100, in practice rarely reaches it).

### Percentile blend → final display score — `buildZones(units, peerAvg, flags)`
The raw weighted score alone isn't used directly; it's blended with a **percentile rank** of that raw score among all peer areas, to keep the zone distribution stable and comparative rather than purely absolute:
```js
rankTerm = 0.60 * percentileRank(raw_among_peers)
rawTerm  = 0.40 * (raw / 100)
display  = clamp(rankTerm + rawTerm, 0, 1) * 100
zone     = scoreToZone(display)
```
`pctRanks(vals)` — computes percentile rank with **tie-averaging**: for a group of tied values spanning sorted-array indices `i..j`, every tied member gets rank `(i + j + 2) / 2 / n` (the standard "average rank" tie-handling method, scaled to a 0–1 percentile).

### What-If levers on this view — `LEVERS` (exactly 5)
Grouped under three category headers:
- **🌍 Environmental Risk**: 🌧️ Rainfall (`rain`, mm/day, mean-aggregated), 🌡️ Temperature (`temp`, °C, mean), 💧 Humidity (`hum`, %, mean).
- **💉 Treatment & Diagnostics**: 💊 ACT (`act`, sum).
- **🛡️ Vector Control**: 🛏️ LLINs (`llin`, sum).

Each lever has an `info` tooltip explaining its effect. `applyLevers(x, vals)` applies the lever's percent-change to the indicator value, with safety clamps: temperature clamped to `[15, 45]`°C, humidity to `[0, 100]`%, and every value floored at `Math.max(0, v)` (no negative counts/rates).

**Critical gating rule**: `showLevers = !!curMonth.forecast` — the lever panel (and all "what-if" semantics) is **only shown when the currently-selected month is a forecast month** (2026, per `export_burden.py`'s windows). For actual/historical months, the levers are hidden and replaced with a green explanatory banner — you cannot "what-if" the past, only the projected future.

### Map rendering
- `<DeckGL>` with a `GeoJsonLayer` over either `states.geojson` or `lgas.geojson` depending on the current `scope` (`'states'|'lgas'`).
- CARTO Positron basemap underneath.
- Default viewport `NIGERIA = { longitude: 8.7, latitude: 9.3, zoom: 5.2, pitch: 0, bearing: 0 }`.
- `bbox(geom)` — recursively walks GeoJSON coordinates to compute a bounding box, used to auto-fit the viewport when drilling into a state.
- Hover tooltip shows: zone color chip, numeric burden score, and the delta vs. the area's baseline (un-leveraged) score.
- Bottom-left legend showing all 5 zone colors with labels.

### "Calculation breakdown" panel
Shown when an area (`sel`) is clicked/selected. Three steps, with the **actual numbers for that area plugged into the formulas**, fully transparent:
- **Step 0**: indicator inputs table, baseline value → scenario (post-lever) value, for every relevant field.
- **Step 1**: the 10-factor weighted table — formula, substituted numbers, resulting sub-score, resulting points — for both baseline and scenario.
- **Step 2/3**: the percentile-blend-to-zone math, again with real numbers (`rankTerm`, `rawTerm`, `display`, resulting zone) shown for both baseline and scenario, so a user can see exactly why an area moved (or didn't move) zones.

### Bottom card grid
Every area rendered as a card showing its baseline zone → scenario zone transition and burden score, sortable by **"By burden"** (`cardSort='zone'`, severity order following `ZONE_ORDER`) or **"By change"** (`cardSort='change'`, biggest score movement first). `cardCap = allLgas ? 150 : 9999` — the All-LGA mode caps rendered cards at 150 (performance guard against rendering ~774 LGA cards at once); the state-drill-down mode has no practical cap.

---

## 6. What-If Simulator (`Simulator.jsx`)

A **second, separate** elasticity-based scenario tool — simpler and faster than the Visual Overview's levers, scoped to **national / state / LGA case-count forecasts** rather than the hotspot map.

### Location resolution
Three location modes via a `level` + optional `lga` selector:
- **National**: baselines = `drivers.national`, case series = `national.json`, trajectory = `drivers.national_traj`.
- **State only** (`lga=''`): baselines = `drivers.states[level]`, series = `states.json[level]`, trajectory = `drivers.state_traj[level]`.
- **State + specific LGA**: baselines = `drivers.lgas["State|||LGA"]` (falls back to the state's baselines if the LGA key is missing), series loaded from the lazily-cached per-LGA dataset (`loadLgas(variant)`), **no trajectory chart available at LGA granularity** (`traj: null` — `drivers.json` only stores LGA *baselines*, not full trajectories, to keep the file size compact, per `drivers.py`'s design note in §4).

On every location change, all lever values reset to that location's forecasted baseline: `setVals(Object.fromEntries(Object.keys(drivers.meta).map(id => [id, baselines[id]?.base ?? 0])))`.

### The elasticity multiplier function — `factor(meta, val, base)`
```js
function factor(meta, val, base) {
  if (meta.good === 'opt') {
    const opt = meta.optimum ?? 27
    const suit = v => 1 - Math.min(1, Math.abs(v - opt) / 12)
    const sb = Math.max(0.05, suit(base))
    return Math.max(0.2, Math.min(2, suit(val) / sb))
  }
  if (!base || base <= 0) return 1
  const frac = (val - base) / base
  const aud = meta.audience ?? 1
  return Math.max(0.2, Math.min(3, 1 + meta.elasticity * frac * aud))
}
```
- For the **non-monotonic temperature driver** (`good: 'opt'`): a triangular "suitability" curve peaking at `optimum` (27°C), `suit(v) = 1 - min(1, |v-optimum|/12)`. The factor is the ratio of suitability-at-new-value to suitability-at-baseline, clamped to `[0.2, 2]`. (This correctly captures that moving temperature *toward* the optimum from either side can *increase* risk if the baseline happened to be on the cold side of optimal — it is not a simple "up=bad" driver.)
- For all other drivers (`good: 'up'` or `'down'`): standard relative-elasticity multiplier, `1 + elasticity × (% change from baseline) × audience_fraction`, clamped to `[0.2, 3]`.

### Combined multiplier across all 10 drivers
```js
let m = 1
for (const id of Object.keys(drivers.meta)) {
  const base = baselines?.[id]?.base ?? 0
  m *= factor(drivers.meta[id], vals[id] ?? base, base)
}
m = clamp(m, 0.1, 4)
```
Each driver's individual factor is **multiplied together** (not summed), then the whole product clamped to `[0.1, 4]×`.

### Applying the multiplier to the case forecast
```js
merged = baseSeries.map(d => ({
  date: d.date,
  Baseline: round(d.cases),
  Scenario: d.forecast ? round(d.cases * multiplier) : round(d.cases),
}))
```
**Only forecast-period months are scaled** — historical/actual months always show their real recorded value in both lines (you cannot retroactively change history).

### UI features
- **Quick-scenario buttons**: "Scale-up interventions" (`setScenario(1.4)`) pushes every protective driver (`good:'down'`) up toward its baseline×1.4 (capped at slider max) and every risk driver (`good:'up'`) down toward baseline×(2−1.4)=0.6 (floored at slider min). "Funding cut" (`setScenario(0.7)`) does the inverse. "↺ Reset to baseline" snaps every lever back to its forecasted baseline.
- Levers grouped by category (`cats` = unique `drivers.meta[id].cat` values: Vector Control, Treatment & Diagnostics, Maternal & Child Health, Environmental).
- Each lever shows: label (with an `InfoTip` "ℹ️" explaining the audience-scoping if `meta.audience` is set), current value+unit, a styled `<input type="range">` (custom CSS-variable-driven fill, see §9), and a footer line: `baseline {b.base} {unit} · effect ×{factor.toFixed(2)}` colored green if ≤1 (beneficial) or coral if >1 (harmful).
- Two KPI tiles: "Scenario cases · 2026–28" (colored green/coral by whether multiplier ≤1) and "Cases averted" / "Additional cases" (sign-flipped label depending on direction), `averted = baseTotal - scenTotal` where `baseTotal` = sum of forecast-period baseline cases.
- Main chart: `CompareChart` (shared component) plotting `Baseline forecast` (dashed, accent-2 blue) vs `Scenario` (solid, green if helpful / coral if harmful).
- "Conditional driver outlook" chart: shows the **driver's own forecast trajectory** (the climatology+damped-trend projection from `drivers.py`) for whichever driver is selected in a dropdown — explicitly captioned "The driver model's own forecast — what the baseline assumes," reinforcing that lever baselines are not arbitrary zeros but a real forecast.

---

## 7. What-If Lab (`WhatIfLab.jsx`)

The **third, independent** what-if mechanism — this is the SARIMAX + Groq-LLM budget-planning workbench, talking directly to `api.py`'s live endpoints rather than reading pre-baked JSON.

### Core mechanics
- `api(path, body)` — a thin `fetch(path, {method:'POST', body: JSON.stringify(body)})` POST helper used for every backend call.
- `FeaturePicker` — a searchable multi-select for choosing which numeric columns are "locked" (baseline/environmental, can't be an intervention) vs "unlocked" (available as interventions), populated from `/api/meta`'s `baseline_cols`/`intervention_cols`.
- `InterventionCard` — one slider per chosen intervention, range **−80% to +200%** relative to its current baseline level.
- `KTile` — a small KPI tile component local to this view.
- Two top-level modes: **`plugplay`** (raw SARIMAX exploration, any covariates, no interventions — calls `/api/forecast`) and **`whatif`** (intervention-scenario mode — calls `/api/whatif`).
- `run()` — dispatches to whichever endpoint matches the current mode.
- `generateBudget()` — forward mode, calls `POST /api/budget` with the current scope + chosen interventions, renders the returned Groq-generated multi-section budget plan as text/markdown-ish blocks.
- `optimizeBudget()` — reverse mode, calls `POST /api/budget-optimize` with a target `budget_ngn`, renders the AI-chosen intervention mix plus the resulting closed-loop SARIMAX chart.
- `saveProposal()` / `deleteProposal()` — calls the `/api/proposals` CRUD endpoints; saved proposals appear in a comparison table so multiple budget scenarios can be compared side-by-side.
- `USD_NGN = 1600` — duplicated client-side constant (also present in `api.py`) for displaying costs in both currencies.

### Chart
Built with a **raw inline `recharts` `<LineChart>`** (not the shared `CompareChart` component used elsewhere) with four possible series — `Historical`, `Forecast`, `Base Forecast`, `What-If` — and a `<ReferenceLine>` marking the historical/forecast split date.

---

## 8. The three distinct, NON-unified what-if/elasticity systems

This is an important architectural fact to preserve if recreating the app: **there are three separate scenario-modeling mechanisms, each with its own elasticity table and its own math**, not one shared engine:

1. **Visual Overview** (`VisualOverview.jsx` + `export_burden.py`) — a **percent-of-current-month-baseline burden formula**: 10 weighted factors (case volume, trend, RDT positivity, treatment gap, 3 environmental, net gap, IRS gap [constant], IPT gap) combined into a 0–100 score, blended with a percentile rank, mapped to one of 5 zones. Levers here change the *underlying indicator values feeding the formula*, not a multiplier on cases directly.
2. **What-If Simulator** (`Simulator.jsx` + `drivers.py`) — an **elasticity-against-forecasted-baseline multiplier model**: 10 drivers (`DRIVER_META`), each with its own elasticity and optional audience-scoping, combined **multiplicatively** into a single factor applied to the forecast-period case series.
3. **What-If Lab** (`WhatIfLab.jsx` + `api.py`) — **SARIMAX exogenous-covariate scaling**: a separate `ELASTICITY` dict in `api.py` (different values and different column-matching rules than `drivers.py`'s `DRIVER_META`), applied as a multiplier on top of a *live-fitted SARIMAX forecast* (not a pre-baked climatology series), with the added Groq-LLM layer for cost/budget narrative on top.

If asked to "unify" or "fix" this, treat it as a deliberate (if perhaps historically accidental) design fact to confirm with the user before changing — collapsing them could change all three views' numeric outputs.

---

## 9. Shared frontend infrastructure

### `lib.js`
- `useData(variant)` — fetches, in parallel, `national.json`, `states.json`, `geo.json`, `meta.json`, `drivers.json`, `leaderboard.json`, `avp.json`, `hotspots.json` for the given variant. The last three (`leaderboard`, `avp`, `hotspots` — Model Lab data) are wrapped in `.catch(() => null)` so a missing file doesn't break the rest of the app.
- `loadLgas(variant)`, `loadDataset(variant)`, `loadMM(...)` — lazily-cached loaders using module-level cache objects (`_lgaCache`, `_dsCache`, `_mm`) so repeated view-switches don't refetch.
- `MODEL_PALETTE` — fixed 13-color array used consistently to color every named model series across `ModelOverlay` charts:
  ```js
  ['#2563eb','#e11d48','#d97706','#7c3aed','#0891b2','#65a30d',
   '#db2777','#0d9488','#ca8a04','#9333ea','#475569','#0ea5e9','#dc2626']
  ```
- `fmt(n)` — human-friendly number formatter with B/M/K suffixes (2 decimal places for B/M, 1 for K). `fmtFull(n)` — full comma-separated integer. `pct(n)` — percentage formatter.
- `COLORS` — the semantic color object used throughout charts:
  ```js
  { accent:'#0d9488', accent2:'#2563eb', coral:'#e11d48', amber:'#d97706',
    violet:'#7c3aed', green:'#16a34a', grid:'rgba(15,34,48,0.07)', axis:'#64798a' }
  ```
- `MONTHS` — array of month abbreviations; `monthLabel(d)` formats `"YYYY-MM"` → `"Mon 'YY"`.
- `zone(incidence)` — a **separate, simpler classification** (used only in `Overview.jsx`'s "zone chips" for top states), based on annual incidence per 1,000 population, distinct from the Visual Overview's 5-zone burden system:

  | Threshold (incidence/1000) | Zone | Color |
  |---|---|---|
  | ≥400 | Very High | `#dc2626` |
  | ≥250 | High | `#ea580c` |
  | ≥100 | Moderate | `#ca8a04` |
  | ≥25 | Low | `#16a34a` |
  | else | Very Low | `#475569` |

### `components.jsx`
- `InfoTip({text, title, w=260})` — a small circular "i" icon (background `rgba(13,148,136,.14)`, icon color `var(--accent)`) that shows a dark tooltip popup on hover/click (`#0f2230` background, `#e9f0f4` text, title highlighted in `#5eead4`). Used throughout for inline explanatory text (e.g. the Simulator's audience-scoping explanation).
- `Card({title, sub, right, children, style})` — the universal white rounded-card container used for every panel in the app.
- `KPI({label, value, delta, deltaClass, color})` — a single stat tile with an optional colored left accent bar and a delta line (colored via `up`/`down`/`flat` CSS classes — coral/green/gray respectively, see `styles.css`).
- `TT` — an internal (not exported) shared chart tooltip component. **Note**: `WhatIfLab.jsx` has its own separate `ChartTT` implementation rather than reusing this one — a minor duplication, not a bug, but worth knowing if refactoring tooltips.
- `ForecastChart({data, height, splitDate})` — an actual-vs-forecast area chart with two gradient defs: `gA` (teal, for the actual/historical segment) and `gF` (amber, for the forecast segment), with the line **bridged** at the split point (the last actual value is duplicated as the first forecast point so the line doesn't visually break).
- `CompareChart({data, series, height, unit, splitDate, splitLabel})` — the generic multi-line comparison chart used by `Simulator.jsx` and `Forecast.jsx`; takes an arbitrary `series` array of `{key, name, color, dashed?}`.
- `ModelOverlay({actualSeries, mm, defaultSelected=['Ensemble (top-3)'], height})` — a chart with toggleable chip buttons per model name, each colored from `MODEL_PALETTE`, letting users overlay/compare multiple models' forecasts against the actual series.
- `AnnualBars({data, height})` — a bar chart: amber bars for forecast years, teal bars for actual years.
- `HBars({data, max, valueKey, labelKey, color, fmtVal})` — horizontal ranked bar list (e.g. "top-10 states by burden"), each bar's fill-width proportional to `value/max`.

### `styles.css` — design system
- Google Font: **DM Sans** (weights 400–800, body/UI text) + **DM Mono** (monospace, used for all numeric values via `var(--mono)`).
- CSS variables (`:root`):
  ```css
  --bg-0:#f4f7fa; --bg-1:#ffffff; --bg-2:#ffffff; --bg-3:#eef3f7; --bg-elev:#e9f0f4;
  --accent:#0d9488; --accent-2:#2563eb; --coral:#e11d48; --amber:#d97706; --violet:#7c3aed; --green:#16a34a;
  --txt-0:#0f2230; --txt-1:#3c5366; --txt-2:#64798a; --txt-3:#94a8b6;
  --border:#e2e9ef; --border-2:#eef2f6;
  --glow:0 6px 24px rgba(15,34,48,0.06);
  --r:16px; --r-sm:10px;
  ```
- Page background: two soft radial gradients (teal top-left, blue top-right) over `--bg-0`, fixed attachment.
- Layout: flex `.app` → fixed-width `252px` sticky `.sidebar` (frosted-glass `backdrop-filter:blur(14px)` on `rgba(255,255,255,.82)`) + flexible `.main` (max-width 1520px, centered).
- Sidebar nav: two always-visible `.nav-group`s ("Malaria Overview", "Intervention Planning") plus a collapsible **"Deep Dive"** group (`.nav-deepdive-toggle` with a `▸`/`▾` chevron, items only rendered when `deepDiveOpen` state is true) — collapsed by default, since Deep Dive contains the technical/ML-internals views not meant for a minister-facing first impression.
- Active nav button: gradient background (`rgba(13,148,136,.14)` → `rgba(37,99,235,.06)`), teal text, inset box-shadow ring.
- Variant tab bar (`.variant-tabs`): pill-style toggle, active tab gets white background + shadow.
- `.view-head h2` — page titles use a **gradient text-fill** effect: `linear-gradient(110deg, var(--txt-0) 20%, var(--accent) 75%, var(--accent-2))` clipped to text (`-webkit-background-clip:text; -webkit-text-fill-color:transparent`).
- `.card` — white background, `1px solid var(--border)`, `16px` radius, soft drop shadow (`--glow`).
- `up`/`down`/`flat` utility classes: coral / green / gray text, used for any delta indicator app-wide.
- `.lever` / sliders — custom-styled `<input type="range">` using a CSS variable `--pct` (set inline per-slider via JS) to render a two-tone gradient track (teal filled : light-gray unfilled), with a white circular thumb ringed in teal.
- `.champion-banner`, `.medal`, `.kind-tag` (`.k-ml` teal, `.k-dl` violet, `.k-ts` amber, `.k-ens` blue) — used in `Methodology.jsx`/`ModelLab.jsx` to badge model types (Machine Learning / Deep Learning / Time-Series / Ensemble).
- Responsive: at `max-width:980px`, the sidebar is hidden entirely and `.main` padding shrinks (mobile is not a primary target, just doesn't break).

### `App.jsx` — top-level shell & navigation
- `NAV_GROUPS` (always visible):
  ```js
  [
    { id:'g-overview', label:'Malaria Overview', items:[
        {id:'visual', label:'Visual Overview', ico:'🗺️'},
        {id:'visuallga', label:'All-LGA Hotspot Map', ico:'🌍'} ]},
    { id:'g-intervention', label:'Intervention Planning', items:[
        {id:'simulator', label:'What-If Simulator', ico:'🎛️'},
        {id:'whatiflab', label:'What-If Lab', ico:'🔬'} ]},
  ]
  ```
- `DEEP_DIVE_ITEMS` (collapsed by default):
  ```js
  [
    {id:'overview',  label:'National Overview (ML experiments)', ico:'📊'},
    {id:'modellab',  label:'Model Lab', ico:'🧪'},
    {id:'data',      label:'Data Explorer', ico:'🗄️'},
    {id:'method',    label:'Model & Methodology', ico:'🧬'},
  ]
  ```
- **Note**: `geo` (Geographic Explorer) and `forecast` (Forecast to 2030) views are still imported and still have render branches in the view-switch (`{data && view === 'geo' && <GeoExplorer .../>}`, etc.) but have **no nav button anywhere** — they were intentionally hidden from navigation ("hide don't delete" per earlier project decision) while remaining reachable if `view` state were ever set to `'geo'`/`'forecast'` by other means.
- Brand header: 🦟 emoji logo, "Malaria Risk Intelligence" title, "Nigeria · DHIS2" subtitle.
- Sidebar footer (always visible): *"Facility-level surveillance aggregated to LGA / State. WHO/SEIR climate, spatial & mechanistic models."*
- **There is no Before/After toggle in the UI anymore** — `variant` is a hardcoded constant (`const variant = 'after'`), not a `useState`. The variant pill-bar that used to sit at the top of `.main` (`.variant-bar`/`.variant-tabs`/`.variant-hint` in `styles.css`) has been removed from both the JSX and the stylesheet.
- Loading/error states: spinner (`.spinner`, CSS `@keyframes spin`) while `!data`, red error text if `err` is set.
- `WhatIfLab` is the **one view that doesn't depend on `data`/variant** — it renders unconditionally (`{view === 'whatiflab' && <WhatIfLab />}`) since it talks directly to live API endpoints rather than the pre-baked variant JSON bundle.

---

## 10. Deep Dive views (technical/internal, collapsed nav group)

### `Overview.jsx` — "National Overview (ML experiments)"
National KPI row (current-year total cases, projected 2026–2028 with year-over-year deltas), a `ModelOverlay` chart of national monthly cases, `AnnualBars` for annual totals, `HBars` showing the top-10 states by burden, a surveillance-snapshot table, and zone chips (via `lib.js`'s `zone(incidence)`, the simpler 5-tier incidence classification — not the Visual Overview's burden zones) for the top-6 states.

### `GeoExplorer.jsx` — "Geographic Explorer" (hidden from nav, still rendered)
State → LGA drill-down: `ModelOverlay` chart, LGA ranking via `HBars`, and a state indicator table.

### `Forecast.jsx` — "Forecast to 2030" (hidden from nav, still rendered)
National/state scope selector, a seasonal-profile chart (mean projected cases per calendar month, 2026–2030), an annual outlook table with YoY deltas, and peak/trough transmission-month KPIs.

### `ModelLab.jsx` — "Model Lab"
The full ML/DL/time-series benchmarking UI. Key internals:
- Client-side `metrics(actual, predicted)` function computing a **full metric battery**: ME, MAE, MedAE, MSE, RMSE, StdErr, MaxAE, MAPE, sMAPE, RMSLE, R².
- **5 tabs**:
  1. `avf` — Actual vs Forecast.
  2. `regression` — leaderboard of regression models.
  3. `deeptime` — Deep Learning & Time-Series models.
  4. `classification` — hotspot detection (binary classifier).
  5. `features` — feature importance + the full data dictionary.
- Imports `meaningFor, detailFor, SOURCES, ABBREV` from `../glossary.js` (a supplementary lookup-table file providing plain-language meanings/abbreviation-expansions/source citations for every column — referenced extensively but its exact content wasn't re-transcribed into this README; treat it as a glossary data file to inspect directly if extending this view).
- Renders `leaderboard.feature_selection.ranking` as a searchable **"Data dictionary — all N columns explained"** table, with per-column RF/XGBoost/LightGBM importance-score breakdown and source citation links.
- Hotspot classification tab explains: the **incidence top-tercile threshold** definition of a "hotspot," the full classifier metric battery (Accuracy / Precision / Recall / F1 / ROC-AUC / Gini / LogLoss / Brier score), a hotspot-share trajectory chart out to 2030, and an auto-generated narrative comment (`hotComment`) summarizing the trend in plain language.
- Model roster benchmarked (documented in `Methodology.jsx`'s prose, consumed here): ML models (kNN, Random Forest, ExtraTrees, GBM, HistGBM, XGBoost, LightGBM, CatBoost — plus Ridge/Lasso/ElasticNet per the pipeline scripts), DL models (MLP, LSTM, GRU — via PyTorch), time-series models (SARIMAX, Holt-Winters/ETS, Seasonal-Naive), and classification models for hotspot detection — all validated on the held-out 2026 Q1 window via **true multi-step recursion** (not single-step "cheating" forecasts).

### `DataExplorer.jsx` — "Data Explorer"
A paginated (`PAGE = 50` rows), sortable, filterable (search box + state + year filters) table over the raw dataset (`ds.dataset.rows`/`columns`, loaded via `loadDataset(variant)` from `lib.js`), plus a "Data dictionary" card rendering `ds.dict` — field name, aggregation type (SUM/MEAN/derived, color-badged), and description, per column.

### `Methodology.jsx` — "Model & Methodology"
The most narrative-heavy view; imports `CATALOGUE, STATUS, MODELS_FRAMEWORK` from `../framework.js` (another supplementary lookup/catalogue data file — exact content not re-transcribed here, inspect directly if extending). Structure:
- **Champion banner** — a single "WHO/SEIR-augmented build" banner (🧬, violet/blue gradient) describing the real external data merged in (NDVI, ENSO/IOD) plus the SEIR mechanistic proxies and extra models, and how many features were used. There is no Before/After comparison copy anymore — the component's `isAfter` variable is still computed (`variant === 'after'`) and still gates the SEIR/Ross–Macdonald section further down, but since `variant` is now always `'after'` that gate is always true; it was left in place as harmless always-true code rather than refactored out.
- **KPI row** — models benchmarked count, champion model's RMSE/MAPE/R², hotspot-classifier AUC/Gini.
- **"Pipeline & methodology" card**, sections 1–6:
  1. Aggregation (facility → ward → LGA → state → national).
  2. Population enrichment.
  3. Leakage-free feature construction (train-only encodings, no future information).
  4. Reporting-gap imputation — notably a **December 2023 total reporting gap**, fixed via **linear interpolation**.
  5. Conditional forecasting (project the *features* forward, then run the *model* forward on those projected features — not a naive autoregressive case-only forecast).
  6. Model benchmark suite.
  7. What-If simulator description.
- **"Full technical deep-dive" card**, sections A–H:
  - **A. Source data & aggregation**: 3,269,768 rows × 123 columns raw; 37 states + FCT; 8,942 wards; 46,399 facilities.
  - **B. Train/test/forecast split**: train = 2023-01..2025-12; held-out test = 2026-01..2026-03; forecast horizon = 2026-04..2030-12.
  - **C. Feature engineering & selection**: 122 candidate features; importance-ranked by **averaging RF + XGBoost + LightGBM**; top-K selected (`K = leaderboard.feature_selection.k`, ≈40).
  - **D. Conditional feature forecasting formula** (exact, as displayed in the UI):
    ```
    forecast(lga, month, year) = seasonal_climatology(lga, month) + 0.5 × slope(lga, feature) × (year − 2024)
    ```
  - **E. Recursive case prediction** — each forecast month's predicted case count feeds back in as a lag feature for the next month, rather than predicting all future months independently from only 2025 data.
  - **F. Conditional SARIMAX-X / ARIMAX** — with exogenous regressors (the projected features from step D).
  - **G. Full model roster with exact hyperparameters**:
    - Random Forest: 200 trees, max depth 14.
    - XGBoost: 700 rounds, depth 6, learning rate 0.03, subsample 0.85.
    - LightGBM: 700 rounds, 48 leaves.
    - CatBoost: 600 iterations, depth 7.
    - MLP: 128 → 64 → 1 architecture, dropout 0.1.
    - LSTM / GRU: hidden size 48.
    - Classification test window: 2025-10..2026-03.
  - **H. Validation & champion selection** — the final "champion" forecast is an **ensemble of the top-3 regressors by mean**.
- **SEIR / Ross–Macdonald section** (AFTER variant only) — full differential-equation block:
  - Human SEIRS compartments (Susceptible–Exposed–Infectious–Recovered–Susceptible, with waning immunity back to S).
  - Mosquito SEI compartments (no "R" — mosquitoes don't recover in this model, they remain infectious until death).
  - The basic reproduction number formula, R₀, derived from the two-host (human+mosquito) system.
  - A **parameter → feature bridge table** mapping each mechanistic SEIR parameter to its corresponding engineered feature in `features.py` (e.g. the EIR parameter ↔ `eir_proxy`, mosquito mortality ↔ `mortality_proxy`, etc.) — this is the conceptual link between the formal epidemiological model and the actual ML feature set.
- **"Model architecture — built vs documented" table** — sourced from `MODELS_FRAMEWORK` (in `framework.js`), distinguishing models that are fully implemented/running vs. ones that are documented as a planned/future direction.
- **"Feature framework — DHIS2 vs non-DHIS2" catalogue table** — sourced from `CATALOGUE`/`STATUS` (in `framework.js`), categorizing every feature by whether it originates from DHIS2 facility reporting or from an external dataset (climate, spatial, poverty, etc.) and its implementation status.

---

## 11. Known data-quality issues identified and handled (deliberate workarounds, not residual bugs)

1. **`ipt_cov` outlier clipping** — raw DHIS2 IPTp coverage percentage column contains values up to ~1×10⁸ in places (a data-entry/export artifact, not a real percentage). Clipped to `[0, 100]` in both `export_burden.py` and `drivers.py` (any driver/field with a `cap` key gets the same treatment) **before** aggregation, so a single bad row can't blow up an entire monthly mean.
2. **Rain/temp/humidity NaN-vs-zero in climatology** — the weather grid only has real coverage for 2023–2025; years 2020–2022 and 2026 are missing entirely, not zero. Both `export_burden.py` and `drivers.py` deliberately leave these columns as `NaN` (rather than `fillna(0.0)`) specifically so `.groupby().mean()` correctly skips the missing years when computing calendar-month climatology, instead of having "no data" silently masquerade as "0mm of rain" and drag every average down.
3. **Always-zero columns** (`rdt_pos`, `treated`, `itn` in `export_burden.py`'s field set) — these DHIS2 columns exist in the schema but were never actually populated/collected across the entire dataset. Flagged explicitly (`FLAGS.no_rdt_pos` etc.) and the frontend (`VisualOverview.jsx`'s `scoreDetail()`) substitutes a neutral assumption (flat 0.55 RDT positivity) rather than letting a measured "0" be misread as "zero malaria positivity," which would have wrongly suppressed every area's burden score.
4. **December 2023 total reporting gap** — an entire month with no facility reporting at all nationwide; fixed via linear interpolation (documented in `Methodology.jsx`'s pipeline section 4, and in `impute_gaps.py`).
5. **The dead "treat" driver naming ambiguity / `features.py`'s vestigial `DRIVERS` import** — `drivers.py` imports `DRIVERS` from `features.py` but never actually uses it; the real driver list is `drivers.py`'s own locally-defined `DRIVER_META`. Not a functional bug (the import is simply unused dead weight), but worth knowing so a future maintainer doesn't assume `features.py`'s `DRIVERS` dict is the source of truth for Simulator levers — it isn't.
6. **IRS (indoor residual spraying) gap factor is a hardcoded constant** — `D2` in the Visual Overview's burden formula is always `1.0` because **no IRS data exists anywhere in the source dataset**. This is a known, permanent limitation of the underlying DHIS2 export, not something fixable in code — any future IRS data source would need to replace this constant with a real computed gap.

---

## 12. Regenerating the static data bundle

To rebuild a variant's JSON exports after a data or logic change, run with `MAL_VARIANT` set to `before` or `after` (Windows pyenv shim is broken — invoke the interpreter by full path, and set `PYTHONIOENCODING=utf-8` to avoid `UnicodeEncodeError` on the Windows console):

```bash
PY=~/.pyenv/pyenv-win/versions/3.11.9/python.exe
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" aggregate.py         # 1. facility -> ward/LGA/state/national
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" enrich_pop.py        # 2. add population + incidence/1,000
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" impute_gaps.py       # 2b. impute the Dec-2023 reporting gap
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" feature_selection.py # 3. rank candidates, write selected_features.json
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" model_suite.py       # 4. ML/DL/TS benchmark + ensemble forecast
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" drivers.py           # 5. -> ui/public/data/after/drivers.json
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" export_burden.py     # 6. -> ui/public/data/after/burden.json
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" export_ui_data.py    # 7. national/state/geo/meta JSON
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" export_data_view.py  # 8. Data Explorer dataset
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" modellab_data.py     # 9. per-model preds + hotspot trajectory
MAL_VARIANT=after PYTHONIOENCODING=utf-8 "$PY" multimodel_forecast.py # 10. multi-model overlay trajectories
```
The frontend only ever reads `ui/public/data/after/...` now (`variant` is hardcoded), so regenerating the `before` variant is optional/unnecessary unless you're keeping it for offline comparison purposes outside the app. Static files are read directly by Vite's dev server / production build — no rebuild of the React app is needed after a data-only change, just a browser refresh.

## 13. Running the stack locally

```bash
# Backend (port 8001)
python -m uvicorn api:app --host 0.0.0.0 --port 8001 --reload

# Frontend (port 3000, proxies /api -> :8001)
cd ui
npm install
npm run dev
```
Requires a `.env` file in the project root containing `GROQ_API_KEY=...` for the What-If Lab's budget-planning endpoints (`/api/budget`, `/api/budget-optimize`) to function; every other view/endpoint works without it.
