# Disease Project Overview

A reference doc covering everything built to extend the malaria dashboard into a
multi-disease Nigeria risk-intelligence platform: architecture, per-disease
capabilities, data sources, and the budget/forecast features added on top.
Written so individual sections can be copied into per-disease project
dashboards elsewhere.

---

## 1. Architecture summary

- **Single source of truth**: `disease_config.py` (project root). One dict per
  disease (`DISEASES["hiv"]`, `DISEASES["tb"]`, ...) describing its warehouse
  table/columns, whether it's forecastable, whether it has intervention/driver
  data, its burden-score tier, and a `dataset_info` block (source, coverage,
  granularity, notes). Every backend route and ETL step reads from this file
  instead of hardcoding disease-specific logic.
- **Two data backends, one API surface**:
  - **Malaria** stays on its original file-based pipeline (`agg_lga_pop.parquet`,
    precomputed JSON under `ui/public/data/`). `source: "file"`.
  - **The other 8 diseases** (HIV, TB, hypertension, diabetes, cervical cancer,
    sickle cell, asthma, yaws, elephantiasis) are read live from the FMOH UAT
    warehouse (Postgres) through a read-only connector (`warehouse.py`,
    `safe_select()` — SELECT/WITH only, blocks INSERT/UPDATE/DELETE/DDL tokens).
    `source: "warehouse"`.
  - `get_df_for(disease)` / `get_elasticity_map(disease)` in `api.py` dispatch
    between the two backends transparently, so `/api/forecast` and `/api/whatif`
    work identically regardless of which disease is requested.
- **No model training anywhere in this expansion.** Every non-malaria disease's
  forecast is a single SARIMAX model fit on the fly against its warehouse time
  series (mirroring the existing `predictive.py` pattern) — no multi-model
  leaderboard, no trained artifacts. This is why "National Overview (ML
  experiments)" and "Model Lab" tabs are malaria-only (`capabilities.overview`,
  `capabilities.model_lab`).
- **No fabricated data, anywhere.** Where a disease has no per-LGA
  intervention/driver dataset in the warehouse, the UI shows an honest gap
  (no Simulator tab, no intervention levers, generic budget language) instead
  of inventing plausible-looking numbers. This rule governs nearly every
  capability flag below.
- **Capability flags drive the UI, not hardcoded disease names.** `GET
  /api/diseases` (`disease_config.public_disease_list()`) returns each
  disease's `capabilities` dict (`overview`, `hotspot_map`, `forecast`,
  `simulator`, `whatiflab`, `data_explorer`, `methodology`, `model_lab`, plus
  derived `month_slider`/`state_zone` flags). The frontend's nav/sidebar and
  every view component branch on these flags rather than on `disease === 'x'`
  checks, so adding a 10th disease later means editing `disease_config.py`,
  not every view file.

## 2. Per-disease capability matrix

| Disease | Source | Forecastable | Has score | Has zone | Driver/intervention data | Burden tier | Notable limitation |
|---|---|---|---|---|---|---|---|
| Malaria | file | Yes | Yes | — (incidence bands) | Yes (ACT, LLIN, RDT, IPTp) | full | None — reference implementation |
| HIV | warehouse | Yes | Yes | No | Yes (ART, linkage, PMTCT testing) | volume_trend | Hotspot snapshot ≠ forecast series; never sum the ~100 disaggregated breakdown columns, only the 2 Total-by-sex columns |
| TB | warehouse | **No** | No | Yes | No | volume_trend | Only 2 real annual data points nationally — no Forecast/What-If/Simulator tabs at all |
| Hypertension | warehouse | Yes | Yes | Yes | No | volume_trend | Treatment coverage (`txcov`) is national-only (4 rows) — shown as a national KPI only, never broadcast to LGAs |
| Diabetes | warehouse | Yes | Yes | Yes | No | volume_trend | Same national-only `txcov` limitation as hypertension |
| Cervical Cancer | warehouse | Yes | Yes | Yes | No | volume_trend | No screening/vaccination driver data |
| Sickle Cell Disease | warehouse | Yes | No | Yes | No | volume_trend | No risk score in source table — ranked by case volume ("Case Volume Rank") |
| Asthma | warehouse | Yes | No | Yes | No | volume_trend | Same — ranked by admission volume |
| Yaws | warehouse | Yes | Yes | Yes | No | volume_trend | Smallest dataset (558 rows); only 2/768 LGAs have enough history for per-LGA forecast |
| Elephantiasis (LF) | warehouse | Yes | No | No | No | volume_trend | Hotspot table is year-only (no month) — map shows annual trend only; only 13/768 LGAs forecastable per-LGA |

## 3. Per-disease data sources (`dataset_info`)

Pulled directly from `disease_config.py` — this is the canonical, verified-live
description of where each disease's numbers come from.

**Malaria** — Facility-level DHIS2 extract (`agg_lga_pop.parquet`), aggregated
to LGA-month, 2023–2026, 773 LGAs. Enriched with population, incidence/1,000,
and 10+ climate/geo/socioeconomic covariates. The only disease with real
per-LGA intervention/driver data, hence the only one with a live
lever-adjustable burden score and a grounded unit-cost budget table.

**HIV** — `hiv.fact_indicator_data` (NDARS, system_id=7) + `hiv_hotspot_predictions`.
Forecast series: 2014–2026, 69,881 fact rows across 4,343 distinct geo
locations. Hotspot table has 83 distinct reported months. Forecast target is
the sum of exactly the two Total-by-sex `HTS_TST_POS` columns — the ~100
disaggregated age/venue/sex-breakdown variants are deliberately never summed
in, to avoid double-counting.

**TB** — `tb_hotspot_predictions` + `tb.fact_indicator_data`. Only 2 real
annual data points nationally — insufficient for any statistical forecast.
Case counts use exactly one partition (Male+Female sex split, not
Adult+Children) to avoid double-counting the same population two ways.

**Hypertension** — `hypertension_hotspot_predictions` + `ncd.fact_indicator_data`,
2016–2026 monthly, 829,379 fact rows across 32,086 distinct geo locations.
Treatment coverage (`txcov`) is reported nationally only (4 rows total) — shown
as a national KPI only, never broadcast down to LGA rows as a fabricated
per-LGA figure.

**Diabetes** — `diabetes_hotspot_predictions` + `ncd.fact_indicator_data`,
2016–2026 monthly, 279,393 fact rows across 21,127 distinct geo locations.
Same national-only treatment-coverage limitation as hypertension.

**Cervical Cancer** — `cervical_cancer_hotspot` + `ncd.fact_indicator_data`,
2020–2026 monthly, 4,424 fact rows across 1,903 distinct geo locations. No
per-LGA screening/vaccination driver data exists, so no intervention levers
or unit-cost budget table — only case volume + trend.

**Sickle Cell Disease** — `sickle_cell_hotspots` + `ncd.fact_indicator_data`
(disease_name='Sickle Cell') — note: reported under the `ncd` schema, not
`ntd`, despite the NTD tab grouping (verified live: 0 rows under `ntd`,
117,552 rows under `ncd`). No risk score in the source hotspot table — areas
are ranked by case volume, labelled "Case Volume Rank" rather than implying a
modelled risk score.

**Asthma** — `asthma_hotspot_predictions` + `ncd.fact_indicator_data`,
2016–2026 monthly, 200,097 fact rows across 20,864 distinct geo locations. No
risk score in the source table — ranked by admission volume instead.

**Yaws** — `yaws_predictive_hotspot` + `ntd.fact_indicator_data`, 2020–2026
monthly, 558 fact rows across 403 distinct geo locations — the smallest
dataset of the 9. Most LGAs have too few reported months for SARIMAX (only
2 of 768 LGAs had enough history for a per-LGA forecast in the latest export
run), so the national/state forecast is far more reliable than any single LGA
trend shown on the map.

**Elephantiasis (LF)** — `elephantiasis_hotspot_predictions` +
`ntd.fact_indicator_data`. Hotspot table is year-only (no month column);
forecast series (fact table) is monthly, 2020–2026, 1,456 fact rows across
854 distinct geo locations. The hotspot map can only show an annual trend
because the source hotspot table has no month column — the Forecast tab is
monthly because it's built from the separate fact table. Only 13 of 768 LGAs
had enough history for a per-LGA forecast.

## 4. Budget planning & AI features (this round of work)

These features are disease-generic — they work for all 9 diseases, branching
on whether real intervention/unit-cost data exists for the selected one.

### 4.1 `/api/budget` — forward budget planning (interventions → cost)
Three prompt modes, chosen automatically per disease:
1. **Malaria (grounded)** — real unit costs (`UNIT_COSTS`) and real elasticities
   feed a Groq (`llama-3.1-8b-instant`) prompt that produces a fully costed
   plan with a disease-specific prevention section.
2. **Disease with configured interventions but no unit-cost table** (currently
   none beyond malaria use this path in practice — HIV has interventions
   configured but the budget endpoint treats it as indicative since it has no
   verified Naira unit-cost table) — literature-based *indicative* costs,
   clearly labelled, not presented as grounded.
3. **Disease with no driver/intervention data at all** (TB excluded entirely;
   the 7 remaining NCD/NTD diseases) — fully generic budget allocation
   (standard public-health programme categories: surveillance, case
   management, community outreach, supply chain) plus a generic prevention
   section, with an explicit "ABOUT {disease}" blurb sourced from
   `dataset_info.notes` so the report isn't entirely boilerplate.

Every response includes `"generic": true/false` so the frontend can show a
"GENERIC / INDICATIVE" badge when the report isn't grounded in real unit
costs. Reports always include a "PREVENTION & CONTROL MEASURES" section,
either disease-specific (malaria) or generic-but-labelled (everyone else).

### 4.2 `/api/budget-optimize` — reverse budget planning (cost → interventions)
Remains **malaria-only** — this direction genuinely requires a grounded
unit-cost table to solve "what mix of interventions fits this budget," and no
other disease has one yet. Returns a `400` for any other disease rather than
letting the LLM invent plausible-sounding but fabricated unit costs.

### 4.3 Forecast cap at May 2027
Both budget endpoints and the new compare endpoint cap any month-by-month
series and total they cite to **May 2027** (`FORECAST_CAP_DATE = "2027-05"`,
`_cap_to()` helper in `api.py`), even when the underlying SARIMAX horizon
or saved proposal data runs further. This fixes the bug where malaria's
budget report cited an implausible compounded multi-year total (the "174
million" issue) — the fix is in the prompt-construction layer itself (the
arrays fed to the LLM are trimmed before the prompt is built), not a
display-only patch.

### 4.4 `/api/compare-proposals` — AI-generated comparison of saved proposals
New endpoint. Takes ≥2 saved budget proposal IDs, builds a Groq prompt from
each proposal's capped forecast series, intervention/what-if settings, and
budget plan excerpt, and returns a narrative: what each proposal's forecast
showed during its time period, what it would cost, and a direct comparison
with a recommendation — all capped at May 2027 like the rest. Saved
proposals (`budget_proposals.json`, `Proposal` model) were extended with
`months`, `base_monthly`, `whatif_monthly` fields so this comparison has real
per-month data to work from, not just the summary text.

### 4.5 Frontend: `MarkdownLite` + AI Compare UI
`ui/src/components.jsx` gained a small dependency-free `MarkdownLite`
component (headers, bold, lists, and proper `---`-separator pipe tables
rendered as real HTML `<table>`s) since the project has no markdown library
installed. `WhatIfLab.jsx`'s Budget Planning card now works for any disease
(no longer hard-gated to malaria), shows the "GENERIC / INDICATIVE" badge
when applicable, and the Compare card has an "AI Compare" button that calls
`/api/compare-proposals` and renders the narrative through `MarkdownLite`.

## 5. Dataset transparency UI (this round of work)

- **`DataExplorer.jsx`**: header text is now disease-aware — malaria keeps its
  original DHIS2-specific copy; every other disease shows a paragraph built
  from `dataset_info.source`/`coverage`. A new "About {disease}'s dataset"
  card (source / coverage / granularity table + notes) renders above the data
  dictionary whenever `dataset_info` is present.
- **`DataNotes.jsx`** (Deep Dive view explaining absent panels): gained the
  same "Dataset: {disease}" card at the top (source/coverage/granularity +
  notes), so the explanation of *why* a panel is missing sits next to the
  explanation of *what the data actually is*.
- **`App.jsx`**: threads `datasetInfo={activeCfg?.dataset_info}` into both
  `DataExplorer` and `DataNotes`, sourced from the same `/api/diseases`
  response already used to build the nav/capabilities.

## 6. Known limitations / honest gaps (by design, not bugs)

- TB has no Forecast, What-If, or Simulator tab — 2 annual data points only.
- HIV, hypertension, diabetes, cervical cancer, sickle cell, asthma, yaws,
  elephantiasis have no per-LGA intervention levers in the hotspot map —
  burden score is volume+trend only (precomputed, not live-adjustable).
- Only malaria has a grounded Naira unit-cost table; every other disease's
  budget report is either indicative (literature-based) or fully generic,
  and is always labelled as such via the `generic` flag.
- Hypertension and diabetes' treatment-coverage figures are national-only
  (4 rows in the warehouse) — never shown as a per-LGA number.
- Elephantiasis' hotspot map is annual-only (no month column in its source
  table) even though its national Forecast tab is monthly (different table).
- No model training occurs anywhere in this expansion — every non-malaria
  forecast is a single on-the-fly SARIMAX fit, not a trained/compared model.
