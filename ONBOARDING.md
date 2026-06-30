# Malaria Risk Intelligence Platform — Complete Onboarding Guide

**For a completely new developer or AI unfamiliar with this codebase**

---

## 0. What Is This Project?

This is a **malaria forecasting and scenario planning platform for Nigeria** combining:
1. **Surveillance data** from health facilities (DHIS2)
2. **External data** (weather, vegetation, climate indices, poverty)
3. **Two forecasting engines**: 
   - **What-If Simulator**: Fast, pre-trained, multi-level (national/state/LGA)
   - **What-If Lab**: Flexible, SARIMAX on-demand, budget-aware
4. **Interactive web UI** for exploring scenarios and generating budget plans

**Users**: Nigeria's National Malaria Elimination Programme (NMEP), health planners, policy-makers

**Goal**: "If we scale ACT distribution by 30% + distribute 50% more LLINs, how many malaria cases can we avert? What's the budget?"

---

## 1. System Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (React/Vite)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ui/src/                                                  │   │
│  │  ├─ App.jsx (main router: Overview, Geo, Forecast, ...) │   │
│  │  ├─ views/                                               │   │
│  │  │  ├─ Simulator.jsx (🎛️ elasticity-based scenarios)    │   │
│  │  │  ├─ WhatIfLab.jsx (🔬 SARIMAX conditional forecast)  │   │
│  │  │  ├─ ModelLab.jsx (model info, data dictionary)       │   │
│  │  │  ├─ Overview.jsx, GeoExplorer.jsx, etc.              │   │
│  │  └─ glossary.js (data dictionary definitions)           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Runs on: http://localhost:5173 (Vite dev server)               │
│  Proxies /api/* → http://localhost:8000 (FastAPI)               │
└─────────────────────────────────────────────────────────────────┘
                              ↕ HTTP
┌─────────────────────────────────────────────────────────────────┐
│                   BACKEND (FastAPI/Python)                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ api.py                                                   │   │
│  │  ├─ GET /api/meta (list columns, targets, states)       │   │
│  │  ├─ POST /api/forecast (SARIMAX univariate/multivariate)│   │
│  │  ├─ POST /api/whatif (SARIMAX with interventions)       │   │
│  │  └─ POST /api/budget (Groq LLM budget plan)             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  Runs on: http://localhost:8000 (Uvicorn server)                │
│  Requires: agg_lga_pop.parquet (main dataset)                   │
│           .env file (GROQ_API_KEY)                              │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                     DATA & SCRIPTS (Python)                     │
│  ├─ agg_lga_pop.parquet (64k rows × 139 cols)                   │
│  ├─ drivers.json (pre-computed elasticity baselines)            │
│  ├─ drivers.py (generate drivers.json)                          │
│  ├─ aggregate.py (DHIS2 → LGA monthly)                          │
│  ├─ integrate_external.py (merge NDVI, ENSO, IOD)               │
│  ├─ fetch_geo.py, fetch_pfpr.py (external data sources)         │
│  └─ [other historical scripts]                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Two separate logical flows**:

### 1a. Simulator Flow (Pre-Computed)
```
agg_lga_pop.parquet
    ↓
drivers.py (compute elasticity baselines)
    ↓
drivers.json (stored in ui/public/data/)
    ↓
Simulator.jsx (load JSON, user moves sliders, multiply by elasticity factors)
```

### 1b. Lab Flow (On-Demand)
```
agg_lga_pop.parquet
    ↓
FastAPI api.py
    ├─ User hits /api/forecast with {level, target, covariates, horizon}
    ├─ Aggregate to that level
    ├─ Trim trailing zeros
    ├─ Fit SARIMAX (try 3 orders, pick best AIC)
    ├─ Return {history, forecast, CI bounds}
    │
    └─ User hits /api/whatif with interventions
        ├─ Fit baseline SARIMAX
        ├─ Override intervention features in future exog
        ├─ Refit + forecast
        ├─ Return {base, whatif forecasts}
        │
        └─ User hits /api/budget (once happy with what-if)
            ├─ Load .env (GROQ_API_KEY)
            ├─ Send scenario summary to Groq API
            ├─ Return LLM-generated budget plan in ₦ and USD
```

---

## 2. Directory Layout

```
final_disease_pred/
├── README_BUILD_LOGIC.md         ← Comprehensive methods (external data, formulas, SARIMAX)
├── README_WHATIF_SIMULATOR.md    ← How Simulator works (elasticity, drivers)
├── ONBOARDING.md                 ← THIS FILE
├── .env                          ← GROQ_API_KEY (created from .env.example)
├── .env.example                  ← Template for .env
│
├── api.py                        ← FastAPI backend (PORT 8000)
│   └─ Endpoints: /api/forecast, /api/whatif, /api/budget, /api/meta
│
├── drivers.py                    ← Generate drivers.json (elasticity metadata)
│ 
├── ui/                           ← React frontend (Vite, PORT 5173)
│   ├── vite.config.js            ← Vite config + /api proxy to localhost:8000
│   ├── src/
│   │   ├── App.jsx               ← Main router, variant toggle
│   │   ├── glossary.js           ← Data dictionary definitions
│   │   ├── lib.js                ← Helper functions (fmt, colors, useData hook)
│   │   ├── components.jsx        ← Reusable: Card, ForecastChart, CompareChart, etc.
│   │   ├── views/
│   │   │   ├── Simulator.jsx     ← 🎛️ What-If Scenario Simulator (elasticity-based)
│   │   │   ├── WhatIfLab.jsx     ← 🔬 What-If Lab (SARIMAX on-the-fly)
│   │   │   ├── Overview.jsx      ← 📊 National KPI dashboard
│   │   │   ├── GeoExplorer.jsx   ← 🗺️ State/LGA heatmaps
│   │   │   ├── Forecast.jsx      ← 📈 Baseline forecast to 2030
│   │   │   ├── ModelLab.jsx      ← 🧪 Feature importance + data dictionary
│   │   │   ├── DataExplorer.jsx  ← 🗄️ Raw data inspection
│   │   │   └── Methodology.jsx   ← 🧬 Methods documentation
│   │   └── styles.css            ← Global CSS (design system)
│   ├── public/
│   │   └── data/
│   │       ├── before/           ← Variant 1: DHIS2 only features
│   │       │   ├── national.json
│   │       │   ├── states.json
│   │       │   ├── geo.json
│   │       │   ├── drivers.json
│   │       │   ├── lgas.json
│   │       │   └── ...
│   │       └── after/            ← Variant 2: + climate, SEIR, spatial features
│   │           ├── national.json
│   │           └── ...
│   └── package.json              ← Dependencies (React, Recharts, Vite)
│
├── agg_lga_pop.parquet           ← MAIN DATASET (64,059 rows × 139 columns)
│                                   Covers: 37 states, 768 LGAs, 2020–2026 monthly
│
├── external_manifest.csv         ← Provenance of 14 external columns
│
├── [Historical scripts — can ignore for day-to-day]
│   ├── aggregate.py              ← DHIS2 CSV → LGA-month sums
│   ├── impute_gaps.py            ← Fill missing DHIS2 months
│   ├── fetch_geo.py              ← Query elevation, area, centroid
│   ├── fetch_pfpr.py             ← Get malaria prevalence from MAP WMS
│   ├── integrate_external.py     ← Merge NDVI, ENSO, IOD
│   ├── integrate_external2.py    ← Merge PfPR, MPI poverty
│   ├── consolidate_dataset.py    ← Final consolidation
│   ├── modeling.py               ← Old ensemble modeling (RF, XGB, LightGBM)
│   ├── multimodel_forecast.py    ← Generate pre-computed forecasts
│   ├── feature_selection.py      ← Feature importance analysis
│   └── ...
│
└── [Data files — referenced by scripts]
    ├── nga-ndvi-subnat-full.csv  ← FEWS NET NDVI (user-provided, 44 MB)
    ├── nga_admin_boundaries.xlsx ← OCHA LGA boundaries + centroids
    ├── nga_mpi_2019.xlsx         ← OPHI/NBS multidimensional poverty index
    ├── geo_lga.csv               ← Elevation, area, centroid per LGA
    ├── pfpr_lga.csv              ← Malaria prevalence per LGA (MAP WMS)
    ├── external_indices.json     ← ENSO ONI, IOD DMI (NOAA)
    ├── forecast_national.csv     ← Pre-computed case forecast (national)
    ├── forecast_state.csv        ← Pre-computed case forecast (states)
    └── ...
```

---

## 3. Key Dataset: `agg_lga_pop.parquet`

**Shape**: 64,059 rows × 139 columns

**What is it?**: Monthly time series aggregated to LGA level from 2020–2026

**Rows** (structure):
```
| country | state    | lga      | year | month | [100 DHIS2 indicators] | [14 external] | [derived] |
|---------|----------|----------|------|-------|----------------------|--------------|-----------|
| Nigeria | Lagos    | Ikeja    | 2020 | 1     | cases_confirmed=45   | ndvi=0.52    | pop=840k  |
| Nigeria | Lagos    | Ikeja    | 2020 | 2     | cases_confirmed=52   | ndvi=0.58    | pop=840k  |
| ...     | ...      | ...      | ...  | ...   | ...                  | ...          | ...       |
| Nigeria | Kano     | Kano     | 2026 | 3     | cases_confirmed=1201 | ndvi=0.61    | pop=3.4M  |
```

**Column categories**:

### 3a. Identifiers (5 columns)
```
country, state, lga, year, month
```

### 3b. DHIS2 Indicators (100+ columns)
From Nigeria's District Health Information System (facility-reported monthly):

**Malaria cases**:
- `MAL - Malaria cases confirmed (number)` ← **PRIMARY TARGET**
- `MAL - Total reported malaria cases (confirmed + presumed)`
- `MAL - Malaria inpatient admissions`
- `MAL - Malaria deaths inpatient(Under 5)`
- `Number of suspected malaria cases`

**Treatments**:
- `ACT Given - Total` (artemisinin-based combination therapy doses)
- `Number of malaria cases treated with artemisinin-based combinat`

**Prevention**:
- `LLIN given – Total` (long-lasting insecticide nets distributed)
- `Children <5 yrs who received LLIN`
- `IPTp1/2/3/>=4 Coverage (institutional)` (intermittent preventive therapy in pregnancy)

**Diagnosis**:
- `MAL - Malaria cases tested with RDT` (rapid diagnostic tests)
- `MAL - Malaria cases tested with microscopy`
- `MAL - Closing Balance - Rapid Diagnostic Test (RDT)`

**Plus ~80 more** (rates, percentages, hospital stats, etc.)

### 3c. External Data (14 columns)

**Source**: NOAA, FEWS NET, Malaria Atlas Project, OCHA, OpenTopoData, OPHI/NBS

```
| Column | Source | What it is | Type | Resolution |
|--------|--------|-----------|------|------------|
| ndvi | FEWS NET | Vegetation greenness (satellite) | 0–1 | LGA-month |
| ndvi_anom | FEWS NET | NDVI anomaly vs seasonal normal | Z-score | LGA-month |
| enso_oni | NOAA CPC | El Niño Southern Oscillation index | −3 to +3 | National-month |
| iod_dmi | NOAA PSL | Indian Ocean Dipole index | Continuous | National-month |
| elevation | SRTM (OpenTopoData) | Meters above sea level at LGA centroid | Meters | LGA-static |
| area_sqkm | OCHA | LGA surface area | km² | LGA-static |
| latitude | OCHA | Centroid latitude (north-south gradient) | Degrees N | LGA-static |
| pop_density | Derived | Population per km² | count/km² | LGA-year |
| pfpr | MAP WMS | *Plasmodium falciparum* parasite prevalence (2–10 yrs) | % [0,100] | LGA-static |
| poverty_mpi_h | OPHI/NBS | Multidimensional poverty headcount | % | State-static |
| dep_schooling | OPHI | Deprivation: years of schooling | % | State-static |
| dep_electricity | OPHI | Deprivation: electricity access | % | State-static |
| dep_water | OPHI | Deprivation: drinking water | % | State-static |
| dep_housing | OPHI | Deprivation: housing quality | % | State-static |
```

### 3d. Derived Columns (additional computed)
```
population          = state_population × fac_share
fac_share           = LGA facility count / state facility count
incidence_per_1000  = (confirmed_cases / population) × 1000
pop_density         = population / area_sqkm
temperature_mean_c  = ERA5 monthly average 2m temperature
temperature_max_c   = ERA5 monthly mean daily maximum
temperature_min_c   = ERA5 monthly mean daily minimum
humidity_pct        = ERA5 monthly relative humidity
rainfall_mm_day     = ERA5 monthly precipitation (mm/day average)
wind_speed_ms       = ERA5 wind speed
solar_kwh_m2_day    = ERA5 solar radiation
```

---

## 4. How to Run Everything

### 4.1 Prerequisites
```bash
# Python 3.11
python --version

# Node 18+
npm --version

# Packages installed? Check:
python -m pip list | grep "fastapi\|uvicorn\|pandas\|statsmodels\|groq"
npm list -g | grep pnpm
```

### 4.2 Install Missing Packages

**Backend (Python)**:
```bash
cd /path/to/final_disease_pred
pip install fastapi uvicorn pandas statsmodels groq python-dotenv
```

**Frontend (Node)**:
```bash
cd ui
npm install
```

### 4.3 Setup .env

```bash
# Copy template
cp .env.example .env

# Edit .env and add your Groq API key
nano .env
# or
code .env
```

Should look like:
```
GROQ_API_KEY=gsk_your_groq_api_key_here
```

Get key from: https://console.groq.com/keys

### 4.4 Start Both Servers

**Terminal 1 — FastAPI backend**:
```bash
cd /path/to/final_disease_pred
python api.py
# Output:
#   INFO:     Uvicorn running on http://0.0.0.0:8000
#   INFO:     Application startup complete
```

**Terminal 2 — React frontend**:
```bash
cd /path/to/final_disease_pred/ui
npm run dev
# Output:
#   ➜  Local:   http://localhost:5173/
#   ➜  Network: use --host to expose
```

Open http://localhost:5173 in browser → you're in!

---

## 5. The Two Forecasting Modes Explained

### 5.1 What-If Simulator (🎛️ tab)

**What it does**: Fast scenario analysis using pre-computed elasticity coefficients

**Workflow**:
1. Select location (National | State | LGA)
2. Move 8 driver sliders (LLINs, ACT, rainfall, temperature, etc.)
3. System computes: `multiplier = ∏ (1 + elasticity × fractional_change)`
4. Apply to pre-computed case forecast: `scenario_cases = base_cases × multiplier`
5. See result instantly

**Example**:
- User selects National
- Baseline forecast 2026: 2.5M cases/month
- User increases ACT by 30%
- Elasticity for ACT: −0.30
- Factor: 1 + (−0.30) × 0.30 = 0.91
- Scenario: 2.5M × 0.91 = 2.275M cases (7.5% reduction)

**Pros**: 
- ✅ Instant (no fitting)
- ✅ Works at LGA level
- ✅ All levels (national/state/LGA) pre-computed

**Cons**:
- ❌ Limited to 8 fixed drivers
- ❌ No budget planning
- ❌ Elasticity assumed same everywhere

**Data source**: `drivers.json` (pre-computed via `drivers.py`)

---

### 5.2 What-If Lab (🔬 tab)

**What it does**: Flexible on-demand SARIMAX forecasting with user-selected covariates

**Workflow**:
1. Select level (National | State)
2. Choose target indicator (MAL - Malaria cases confirmed, etc.)
3. (Optional) add covariates: pick from all 156 columns (rainfall, temperature, ACT, LLIN, etc.)
4. Select horizon (6/12/18/24 months)
5. Hit **Run SARIMAX**
   - API aggregates data to selected level
   - Trims trailing zeros (unreported months)
   - Fits SARIMAX: tries 3 order combos, picks best AIC
   - Returns forecast with 95% CI
6. In What-If mode: override intervention features (−80% to +200%), refit, compare

**Example**:
- User selects National, target = cases confirmed
- Covariates = [rainfall_mm_day, temperature_mean_c, ACT Given - Total]
- SARIMAX fits: `cases[t] = f(rainfall[t], temp[t], act[t], past_cases)`
- Forecast: 12 months with seasonal variation preserved
- Interventions: User sets ACT +30% for all future months
- What-If refit: Same model, but exogenous ACT values 1.3× baseline
- Compare: base forecast vs what-if forecast

**Pros**:
- ✅ Any covariates (all 156 columns)
- ✅ Data-driven (SARIMAX fits to actual data)
- ✅ Budget planning (Groq LLM generates plan)
- ✅ Seasonal variation in forecast (D=0 preserves amplitude)

**Cons**:
- ❌ Slower (~10–15 sec per run)
- ❌ National/State only (no LGA detail)
- ❌ Requires backend API

**Data source**: `agg_lga_pop.parquet` (live fitting, not pre-computed)

---

## 6. Key Files & What They Do

### 6.1 Backend

| File | Purpose | Key Functions |
|------|---------|---------------|
| **api.py** | FastAPI server | `GET /api/meta`, `POST /api/forecast`, `POST /api/whatif`, `POST /api/budget` |
| **drivers.py** | Generate Simulator metadata | `forecast_driver()`, `loc_drivers()` → writes `drivers.json` |

### 6.2 Frontend

| File | Purpose | Key Components |
|------|---------|-----------------|
| **App.jsx** | Main router | `useData()` hook, nav tabs, variant toggle (Before/After) |
| **Simulator.jsx** | Elasticity UI | `factor()` function, lever sliders, multiplier calc |
| **WhatIfLab.jsx** | SARIMAX UI | Covariate picker, intervention levers, SARIMAX API calls |
| **glossary.js** | Data dictionary | `SOURCES`, `DETAIL`, `meaningFor()`, `detailFor()` |
| **lib.js** | Shared utilities | `useData()`, `fmt()`, `COLORS`, `monthLabel()`, `loadDataset()` |
| **components.jsx** | Reusables | `Card`, `ForecastChart`, `CompareChart`, `HBars` |

### 6.3 Data Pipeline

| File | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| **aggregate.py** | Facility → LGA monthly | DHIS2 CSVs | `agg_lga.csv` |
| **impute_gaps.py** | Fill missing months | `agg_lga.csv` | Imputed version |
| **fetch_geo.py** | Get elevation, area | OCHA boundaries | `geo_lga.csv` |
| **fetch_pfpr.py** | Query MAP WMS | LGA centroids | `pfpr_lga.csv` |
| **integrate_external.py** | Merge NDVI, ENSO, IOD | DHIS2 + CSVs | Dataset + 8 cols |
| **integrate_external2.py** | Merge PfPR, MPI | Dataset + files | Dataset + 5 cols |
| **consolidate_dataset.py** | Final assembly | All + geo_lga.csv | `agg_lga_pop.parquet` |

---

## 7. Working With the Simulator

### 7.1 What Are "Elasticity Coefficients"?

An **elasticity coefficient** measures how sensitive an output (malaria cases) is to a change in an input (intervention or climate).

**Formula**: 
```
Elasticity = (% change in cases) / (% change in driver)
           = (ΔCases / Cases_base) / (ΔDriver / Driver_base)
```

**Example**: 
- Driver: LLIN (nets distributed)
- Elasticity: −0.40
- Baseline: 1M nets/month → 2M cases/month
- Scenario: 1.2M nets (+20%)
- Impact: Cases fall by 20% × (−0.40) = −8%
- New cases: 2M × (1 − 0.08) = 1.84M

**Interpretation**:
- Negative elasticity: increasing the driver *decreases* cases (protective)
- Positive elasticity: increasing the driver *increases* cases (risk)
- Larger magnitude: stronger effect

### 7.2 The 8 Simulator Drivers

All defined in `drivers.py:DRIVER_META`:

```python
{
  "llin": {
    "col": "LLIN given – Total",              # Column in parquet
    "label": "LLINs distributed",             # UI label
    "unit": "nets/mo",
    "elasticity": -0.40,                      # Coefficient
    "good": "down",                           # More is better
    "cat": "Vector Control",
    "agg": "sum"                              # Sum across LGAs
  },
  "act": {
    "col": "ACT Given - Total",
    "label": "ACT treatment courses",
    "unit": "/mo",
    "elasticity": -0.30,
    "good": "down",
    "cat": "Treatment & Diagnostics",
    "agg": "sum"
  },
  "rain": {
    "col": "rainfall_mm_day",
    "label": "Rainfall",
    "unit": "mm/d",
    "elasticity": 0.30,                       # Positive: more rain = more cases
    "good": "up",                             # Less is better
    "cat": "Environmental",
    "agg": "mean"                             # Mean across LGAs
  },
  "temp": {
    "col": "temperature_mean_c",
    "label": "Mean temperature",
    "unit": "°C",
    "elasticity": -0.06,
    "good": "opt",                            # Optimal value (not linear)
    "optimum": 27,                            # Best at 27°C
    "cat": "Environmental",
    "agg": "mean"
  },
  ...
}
```

### 7.3 How Simulator Baseline Works

**drivers.py extracts baseline for each location**:

```python
# For national level:
recent_12_months = last 12 months of data (2025-04 to 2026-03)
hist = average value across those 12 months

# Forecast the driver forward (climatology + trend):
climatology = average for each month (Jan avg, Feb avg, etc.)
trend = slope of yearly averages × 0.4 (damped)
forecast = climatology + trend for each future month

# Base value for sliders:
base = forecasted value (future-looking, not historical)
```

**Why forecast the driver?**
- User sees lever starting at a *realistic future value*
- Not anchored to past; reflects expected state in 2026–2028
- If user doesn't move lever, scenario still includes seasonal variation

**Example**: Rainfall at Lagos
- Jan–May (dry): 50 mm/day climatology
- Jun–Oct (rainy): 200 mm/day climatology
- 2025 trend: declining at −2 mm/yr (damped from −5)
- 2026-07 forecast: 200 − 2×1 = 198 mm/day baseline
- User can slide rainfall ±50 mm/day from that baseline

### 7.4 Customizing Elasticities

To change how responsive cases are to a driver:

**File**: `drivers.py`

**Step 1**: Edit coefficient
```python
DRIVER_META = {
    "act": {
        ...
        "elasticity": -0.25,  # Changed from -0.30 (weaker effect)
        ...
    }
}
```

**Step 2**: Regenerate drivers.json
```bash
export MAL_VARIANT=after
python drivers.py
# Writes: ui/public/data/after/drivers.json
```

**Step 3**: Reload browser (Vite auto-reloads if running)

---

## 8. Working With the What-If Lab

### 8.1 SARIMAX: What Is It?

**SARIMAX** = **S**easonal **ARIM**A with e**X**ogenous variables

**Breakdown**:
```
SARIMAX(p,d,q)(P,D,Q,s) with exog

p, d, q         = Non-seasonal: AR(p) + I(d) + MA(q)
P, D, Q, s      = Seasonal: AR(P) + seasonal diff I(D) + MA(Q) + period s (12 for monthly)
exog            = External variables (rainfall, temperature, ACT, etc.)
```

**In plain English**:
- **AR(p)**: "This month depends on previous p months"
- **I(d)**: "Difference d times to make stationary (remove trend)"
- **MA(q)**: "Shocks decay over q months"
- **Seasonal**: Same pattern but over 12-month cycle
- **Exog**: External drivers that affect cases

**This codebase uses**: `(1,1,1)(1,0,1,12)` — tries 3 candidates, picks best AIC

### 8.2 Why `D=0` (No Seasonal Differencing)?

**Problem with D=1** (seasonal differencing):
```
If you difference by 12 months, you remove seasonal amplitude.
Forecast becomes flat (no rainy-season spike).
```

**Solution: D=0** with `P=1` (seasonal AR):
```
"This month's level depends on same month last year"
Rainy season (Jun): forecast looks at Jun of previous year
Preserves seasonal shape: Jun spike, Jan trough
```

This is **critical for malaria** because seasonality is real and important.

### 8.3 How to Run a What-If Lab Forecast

**Via UI**:
1. Open http://localhost:5173 → 🔬 **What-If Lab** tab
2. Select Level: **National**
3. Target: **MAL - Malaria cases confirmed (number)**
4. Horizon: **12** months
5. Covariates (optional): Click search, add `rainfall_mm_day`, `temperature_mean_c`
6. Click **▶ Run SARIMAX**
7. Chart shows history (blue area) + forecast (amber dashed)
8. Table shows monthly values + 95% CI

**What's happening behind the scenes**:
```
API call to POST /api/forecast:
{
  "level": "national",
  "target": "MAL - Malaria cases confirmed (number)",
  "covariates": ["rainfall_mm_day", "temperature_mean_c"],
  "horizon": 12
}

Backend (api.py):
  1. Load parquet, aggregate nationally (sum all LGAs)
  2. Trim trailing zeros (last real data = 2026-03)
  3. Extract {cases, rainfall, temp} columns
  4. Fit SARIMAX with 3 order candidates:
     - (1,1,1)(1,0,1,12)
     - (2,1,1)(1,0,1,12)
     - (1,1,2)(1,0,1,12)
  5. Pick best AIC
  6. Forecast 12 months
  7. Return:
     {
       "history": [{date: "2025-01", cases: 1.8M}, ...],
       "forecast": [{date: "2026-04", cases: 2.1M, lower: 1.8M, upper: 2.4M}, ...]
     }

UI (WhatIfLab.jsx):
  1. Merge history + forecast into single chart
  2. Display with confidence intervals
  3. Show detail table
```

### 8.4 Running What-If (Conditional Forecast)

1. Same setup as above, but switch to **What-If mode** (toggle at top)
2. Add interventions: Click **+ Add intervention** in left panel
3. Select features like `ACT Given - Total`, `LLIN given – Total`
4. Slide each to desired change (e.g., +30%, +50%)
5. **Baseline features** (ENSO, elevation, NDVI, poverty) are **locked** — you can't change them
6. Click **▶ Run SARIMAX**
7. Chart now shows:
   - Historical (teal)
   - Base forecast (blue dashed)
   - What-If forecast (green solid if cases ↓, red if cases ↑)
8. KPIs show cases averted
9. (Optional) Click **💰 Generate Budget Plan** to get Groq-generated cost breakdown

**Example What-If Request**:
```json
POST /api/whatif:
{
  "level": "national",
  "target": "MAL - Malaria cases confirmed (number)",
  "covariates": ["rainfall_mm_day", "ACT Given - Total", "LLIN given – Total"],
  "interventions": {
    "ACT Given - Total": 30,        // +30%
    "LLIN given – Total": 50        // +50%
  },
  "horizon": 12
}
```

**Backend**:
```python
1. Fit baseline SARIMAX (same as /forecast)
2. Get future exogenous values (rainfall from climatology, ACT/LLIN baseline)
3. Override interventions: ACT_future *= 1.30, LLIN_future *= 1.50
4. Refit SARIMAX with modified exog
5. Return:
   {
     "history": [...],
     "base": [...],       # Forecast without intervention
     "whatif": [...]      # Forecast with intervention
   }
```

### 8.5 Budget Planning (Groq Integration)

**After running What-If**, click **Generate Budget Plan**:

1. UI computes case reduction: `base_cases − whatif_cases`
2. Sends to API: `POST /api/budget`
3. Backend:
   ```python
   - Load .env (re-read GROQ_API_KEY)
   - Craft prompt for Groq llama-3.1-8b-instant:
     "Scenario: Nigeria national, ACT +30%, LLIN +50%
      Base burden: 2.1M cases/month
      Forecast burden: 1.4M cases/month
      Cases averted: 700k/month
      Generate budget plan with costs in ₦ and USD"
   - Call Groq API
   - Return LLM-generated plan
   ```
4. UI displays in scrollable card with costs, prioritization, timeline, risks

**Example Output** (from LLM):
```
**1. INTERVENTION COST BREAKDOWN**

ACT Given - Total (30% increase):
- Current monthly: 1.2M doses
- Planned: 1.56M doses
- Cost per dose: ₦150 ($0.094)
- Monthly cost: ₦234M ($146.25k)
- 12-month cost: ₦2.8B ($1.755M)

LLIN given - Total (50% increase):
- Current monthly: 800k nets
- Planned: 1.2M nets
- Cost per net: ₦2,500 ($1.56)
- Monthly cost: ₦1B ($625k)
- 12-month cost: ₦12B ($7.5M)

**TOTAL BUDGET: ₦14.8B (~$9.255M)**

Cost per case averted: ₦1,752 ($1.10)

**2. GEOGRAPHIC PRIORITIZATION**

Top 5 states by malaria burden:
1. Lagos (23% of national burden) → allocate ₦3.4B
2. Kano (18%) → allocate ₦2.7B
...

**3. IMPLEMENTATION TIMELINE**

Months 1–2: Procurement + stakeholder meetings
Months 3–4: Training + facility readiness
Months 5–12: Rollout
...

**4. RISKS**

- ACT supply limited; pre-order 6 months ahead
- Absorption capacity: health workers may be overwhelmed
- LLIN storage: ensure proper warehouse conditions
...
```

---

## 9. Understanding Key Concepts

### 9.1 Aggregation Levels

- **National**: Sum/mean across all 768 LGAs
  - Counts (cases, nets distributed): **sum**
  - Rates, percentages, environment: **mean**

- **State**: Sum/mean across LGAs within that state
  - Same rule applies

- **LGA**: Single LGA (no aggregation)
  - Only Simulator supports; What-If Lab doesn't

### 9.2 Target Indicators

You can forecast any numeric column in parquet, but common targets:
```
MAL - Malaria cases confirmed (number)        ← Most common
MAL - Total reported malaria cases
MAL - Malaria inpatient admissions
MAL - Malaria deaths inpatient (Under 5)
Number of suspected malaria cases
```

### 9.3 Covariates (External Features)

**What**: Any column in parquet can be used as a covariate (driver) in SARIMAX

**Common choices**:
```
Supply-side (actionable):
  - ACT Given - Total
  - LLIN given – Total
  - MAL - Malaria cases tested with RDT
  - % of Fever cases Tested with RDT

Environment (forecasted):
  - rainfall_mm_day
  - temperature_mean_c
  - humidity_pct

Static (reference):
  - elevation
  - latitude
  - pfpr
```

### 9.4 Variants: Before vs After

**Before**: Baseline features only (DHIS2 health indicators)

**After**: Baseline + climate, satellite, socioeconomic, geospatial

Both variants have identical:
- Simulator (same drivers)
- Lab (same dataset, same API)
- Forecast results (computed separately)

Difference is in the training data / feature set used (if you were to retrain models).

---

## 10. Troubleshooting

### Problem: "API connection failed" (What-If Lab won't run)

**Check**:
```bash
# Is backend running?
curl http://localhost:8000/api/meta
# Should return JSON with states, targets, columns

# If not:
cd /path/to/final_disease_pred
python api.py
```

### Problem: "GROQ_API_KEY not set in .env"

**Check**:
```bash
cat .env
# Should have: GROQ_API_KEY=gsk_...

# If not:
cp .env.example .env
# Edit and add key
```

### Problem: Simulator sliders not showing

**Check**:
```bash
# Does drivers.json exist?
ls ui/public/data/after/drivers.json

# If not:
export MAL_VARIANT=after
python drivers.py
# Then reload browser
```

### Problem: "File has not been read yet" error in API

**Check**:
- Is `agg_lga_pop.parquet` in project root?
- Is it the right shape? Try:
  ```python
  import pandas as pd
  df = pd.read_parquet('agg_lga_pop.parquet')
  print(df.shape)  # Should be (64059, 139)
  ```

### Problem: SARIMAX fit takes too long or fails

**Reason**: Data fitting is slow for large datasets; some orders may not converge

**Already handled**: `api.py:run_sarimax()` tries 3 orders and picks best; falls back to naive seasonal if all fail

**To speed up**: Reduce `maxiter=400` in `api.py:run_sarimax()` line

---

## 11. Code Navigation: Quick Reference

### Frontend Changes

**To add a new view** (e.g., new dashboard):
1. Create `ui/src/views/NewView.jsx`
2. Import in `ui/src/App.jsx`
3. Add to `NAV` array with id, label, emoji
4. Add condition in main render: `{view === 'newview' && <NewView />}`

**To modify Simulator sliders**:
1. Edit `drivers.py:DRIVER_META` (coefficients, ranges)
2. Run `python drivers.py`
3. Browser reloads automatically

**To add data dictionary entries**:
1. Edit `ui/src/glossary.js`
2. Add/update `DETAIL[column]` with derivation, interpretation, source

### Backend Changes

**To add an API endpoint**:
1. Add function in `api.py` with `@app.post("/api/...")` decorator
2. Define Pydantic model for input (`class MyReq(BaseModel)`)
3. Return dict (auto-serialized to JSON)

**To change SARIMAX fitting**:
1. Edit `api.py:run_sarimax()` function
2. Change `order=` and `seasonal_order=` parameters
3. No server restart needed (auto-reload on file save)

**To add new external data**:
1. Write fetch script (e.g., `fetch_new_source.py`)
2. Call it in integration pipeline (e.g., `integrate_external.py`)
3. Merge result into `agg_lga_pop.parquet`
4. Regenerate `drivers.json` if needed

---

## 12. For the Next AI: Key Files to Read

**In order of importance**:

1. **README_BUILD_LOGIC.md** — Full methods, external data sources, SARIMAX theory
2. **README_WHATIF_SIMULATOR.md** — Elasticity model, driver forecasting, UI flow
3. **api.py** — Backend endpoints (SARIMAX, Groq integration)
4. **Simulator.jsx** — Elasticity UI (multiplier, sliders, chart)
5. **WhatIfLab.jsx** — SARIMAX UI (covariate picker, interventions)
6. **drivers.py** — Driver baseline + forecast computation
7. **glossary.js** — Data dictionary definitions

**If modifying data pipeline**:
8. `aggregate.py` → `impute_gaps.py` → `fetch_geo.py` → `integrate_external.py` → `consolidate_dataset.py`

---

## 13. Summary: What This Platform Does

```
INPUT
  ├─ Nigeria malaria surveillance (DHIS2, 100+ indicators, 64k rows)
  ├─ Weather (ERA5, 7 variables)
  ├─ Satellite (NDVI, FEWS NET)
  ├─ Climate indices (ENSO, IOD, NOAA)
  ├─ Health access (elevation, poverty, parasite prevalence)
  └─ Time period: 2020–2026 monthly, 37 states, 768 LGAs

COMPUTE
  ├─ Simulator: Elasticity model (8 drivers, pre-trained)
  ├─ Lab: SARIMAX (any covariates, on-demand)
  └─ Budget: Groq LLM (cost breakdown, prioritization)

OUTPUT
  ├─ "If we scale ACT +30%, how many cases averted?"
  ├─ Charts: historical + forecast + scenario comparison
  ├─ Confidence intervals: 95% bounds
  ├─ Budget plan: ₦ and USD, per-state allocation, timeline
  └─ Impact: cases averted, cost per case averted, value for money

USERS
  ├─ Nigeria NMEP (National Malaria Elimination Programme)
  ├─ State health offices
  ├─ Donors (Global Fund, PMI, GAVI)
  └─ Health economists planning interventions
```

**You now know everything needed to read, modify, and extend this codebase.**

Good luck! 🦟

