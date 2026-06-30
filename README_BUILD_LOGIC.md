# Malaria Risk Intelligence Platform — Build Logic & Methodology

**Nigeria facility-level malaria surveillance system → actionable forecasts + budget planning**

---

## 1. Project Architecture Overview

### 1.1 Stack
- **Frontend**: React (Vite, TypeScript-ready)
- **Backend**: FastAPI (Python 3.11)
- **Time Series Modeling**: SARIMAX (statsmodels)
- **LLM Integration**: Groq `llama-3.1-8b-instant` for budget planning
- **Data**: Parquet (pandas), JSON for export

### 1.2 Directory Structure
```
final_disease_pred/
├── ui/                           # React frontend (Vite)
│   └── src/
│       ├── views/
│       │   ├── Overview.jsx       # National KPI dashboard
│       │   ├── GeoExplorer.jsx    # State/LGA heatmaps
│       │   ├── Forecast.jsx       # Baseline forecast to 2030
│       │   ├── Simulator.jsx      # Legacy what-if with pre-trained models
│       │   ├── WhatIfLab.jsx      # ← NEW: SARIMAX conditional forecasting
│       │   ├── ModelLab.jsx       # Feature importance, data dictionary
│       │   ├── DataExplorer.jsx   # Raw data inspection
│       │   └── Methodology.jsx    # Methods documentation
│       ├── App.jsx                # Main router + variant toggle
│       └── glossary.js            # Data dictionary definitions
├── api.py                         # ← FastAPI backend (SARIMAX + Groq budget)
├── agg_lga_pop.parquet            # Final dataset (64k rows × 139 cols)
├── external_manifest.csv          # Provenance of 14 external columns
├── .env.example                   # Template for GROQ_API_KEY
└── [feature_selection.py, modeling.py, etc.]  # Historical training scripts
```

---

## 2. Data Pipeline & Feature Engineering

### 2.1 Core Dataset: `agg_lga_pop.parquet`
**Shape**: 64,059 rows × 139 columns | **Coverage**: 37 states, 768 LGAs, 2020–2026 monthly

**Column groups**:
1. **Identifiers** (5): country, state, lga, year, month
2. **DHIS2 indicators** (100): malaria cases, tests, ACT given, LLIN, IPTp, mortality, etc.
3. **Derived aggregates** (14): percentages, case fatality rates, test positivity, etc.
4. **Population estimates** (4): state_pop, fac_share (facility share), population, incidence_per_1000
5. **Weather/climate** (7): temperature (mean/max/min), humidity, rainfall, wind, solar
6. **External indices** (4): ENSO ONI, IOD DMI, NDVI, NDVI anomaly
7. **Geospatial** (5): elevation, area_sqkm, latitude, pop_density, pfpr
8. **Socioeconomic** (5): poverty_mpi_h, dep_schooling, dep_electricity, dep_water, dep_housing

---

### 2.2 Data Sources & Methodology

#### **DHIS2 Facility-Level Surveillance** (100 indicators)
- **Source**: Nigeria's District Health Information System (DHIS2)
- **Collection**: Facility reports → LGA monthly aggregation
- **Coverage**: ~1,350 facilities across 768 LGAs
- **Quality**: Imputation of gaps via `impute_gaps.py`; reporting completeness tracked
- **Key malaria indicators**:
  - `MAL - Malaria cases confirmed (number)`: RDT + microscopy
  - `MAL - Total reported malaria cases`: confirmed + presumed
  - `ACT Given - Total`: artemisinin-based combination therapy doses
  - `LLIN given – Total`: long-lasting insecticide-treated nets distributed
  - `IPTp1/2/3/>=4 Coverage`: intermittent preventive therapy in pregnancy
  - `MAL - Malaria inpatient admissions`, `MAL - Malaria deaths inpatient`

#### **Population & Facility Density** (fac_share derivation)
- **Base**: State population (census estimates)
- **LGA allocation**: 
  ```
  LGA population = State population × fac_share
  where fac_share = LGA facility count / State facility count
  ```
- **Rationale**: DHIS2 doesn't report LGA population; facilities proxy distribution
- **Formula location**: `features.py:191–192`, `modeling.py:44–45`

#### **Weather Data** (7 columns) — ECMWF ERA5
- **Source**: Copernicus Climate Data Store (ERA5 reanalysis)
- **Resolution**: LGA-level, monthly aggregation
- **Variables**:
  - `temperature_mean_c`: monthly average 2m air temperature
  - `temperature_max_c`: monthly mean daily maximum
  - `temperature_min_c`: monthly mean daily minimum
  - `humidity_pct`: 2m relative humidity
  - `rainfall_mm_day`: precipitation (mm/day averaged over month)
  - `wind_speed_ms`: 10m wind speed
  - `solar_kwh_m2_day`: downwelling solar radiation
- **Mechanism**: Temperature drives parasite development rate; humidity → vector survival
- **Processing**: `integrate_external.py` merges via OCHA crosswalk

#### **ENSO/IOD Teleconnections** (2 indices) — NOAA
- **Source**: 
  - NOAA Climate Prediction Center: Oceanic Niño Index (ONI) — <https://origin.cpc.ncep.noaa.gov/data/indices/oni_v5.php>
  - NOAA Physical Sciences Laboratory: Indian Ocean Dipole Mode Index (DMI) — <https://psl.noaa.gov/data/correlation/dmi.data>

- **`enso_oni`**: 3-month running mean of Niño-3.4 region (5°N–5°S, 120°–170°W) SST anomalies vs 30-yr baseline
  - **Interpretation**: ≥+0.5°C sustained = El Niño (warmer, drier W. Africa, ↑ malaria); ≤−0.5 = La Niña
  - **Application**: Same value broadcast to all LGAs (global teleconnection)
  
- **`iod_dmi`**: Indian Ocean Dipole SST gradient (Western − Eastern pole)
  - **Interpretation**: Positive phase = warm western IO, affects monsoon rainfall
  - **Application**: National-level index, broadcast to all locations

- **Data update**: Manual download from NOAA CPC; integrated via `integrate_external.py`

#### **NDVI (Vegetation Health)** (2 columns) — FEWS NET
- **Source**: FEWS NET Normalised Difference Vegetation Index (MODIS-based)
- **Resolution**: LGA-level, 10-day composites → monthly mean
- **File**: `nga-ndvi-subnat-full.csv` (user-provided, 44MB)
- **Columns**:
  - `ndvi`: Raw vegetation index (0–1 range)
  - `ndvi_anom`: Anomaly vs LGA-specific seasonal normal (Z-score style)
- **Mechanism**: Higher NDVI (green vegetation) → ↑ water bodies → ↑ breeding habitat → potential malaria risk
- **Processing**: 
  - Loaded via `integrate_external.py`
  - LGA matching via OCHA administrative crosswalk
  - Anomalies computed per LGA, per month-of-year, vs 10-yr baseline

#### **Parasite Prevalence (PfPR)** (1 column) — Malaria Atlas Project
- **Source**: MAP WMS raster service, 2024 global modelled *Plasmodium falciparum* parasite rate
- **URL**: `https://data.malariaatlas.org/geoserver/Malaria/wms` layer `202406_Global_Pf_Parasite_Rate`
- **Resolution**: 1km gridded, queried at LGA centroid via GetFeatureInfo
- **Range**: 0–100% (children 2–10 yrs)
- **Static**: LGA-level, constant across months (reflects intrinsic endemicity)
- **Script**: `fetch_pfpr.py` → `pfpr_lga.csv`
- **Handling**: Fallback to state-mean if LGA query returns null

#### **Elevation & Area** (3 columns) — SRTM + OCHA
- **Elevation**:
  - **Source**: SRTM 30m (OpenTopoData API)
  - **Script**: `fetch_geo.py` → `geo_lga.csv`
  - **Resolution**: LGA centroid elevation (meters)
  - **Mechanism**: Lower elevation (swamps, wetlands) → warmer, wetter → ↑ transmission

- **Area** & **Latitude**:
  - **Source**: OCHA FTS-style admin-2 boundaries (`nga_admin_boundaries.xlsx`)
  - **Columns**: area_sqkm (LGA surface), center_lat (north-south gradient)
  - **Mechanism**: Latitude → temperature gradient; area → normalization for density metrics

#### **Multidimensional Poverty (MPI)** (5 columns) — OPHI/NBS
- **Source**: Oxford Poverty & Human Development Initiative + Nigeria Bureau of Statistics
- **File**: `nga_mpi_2019.xlsx` (OPHI HDX release, 2019 survey year)
- **Resolution**: State-level snapshot → broadcast to all LGAs in state
- **Columns**:
  - `poverty_mpi_h`: Multidimensional poverty headcount (% of population in poverty)
  - `dep_schooling`: Deprivation in years of schooling (% of population)
  - `dep_electricity`: Lack of electricity access (%)
  - `dep_water`: No access to safe drinking water (%)
  - `dep_housing`: Inadequate housing (%)
- **Mechanism**: Poverty ↔ limited healthcare access, malaria prevention adherence, housing quality (open structures → mosquito exposure)
- **Parsing**: `integrate_external2.py` extracts from sheets "5.1 MPI Region" and "5.2 Censored Headcounts Region"
- **Caveat**: State-level only; doesn't vary within state; updated once per ~5 years

---

### 2.3 Feature Consolidation Workflow

```
1. DHIS2 aggregation (aggregate.py)
   ├─ Facility reports → LGA month totals
   ├─ Imputation for missing months (impute_gaps.py)
   └─ Output: agg_lga_pop.csv (DHIS2 + population only)

2. First wave of external data (integrate_external.py)
   ├─ Load nga_admin_boundaries.xlsx (OCHA crosswalk)
   ├─ Merge NDVI (monthly per LGA)
   ├─ Merge ENSO/IOD (monthly national, broadcast)
   └─ Output: dataset with 8 external columns

3. Second wave of external data (integrate_external2.py)
   ├─ Fetch PfPR (via fetch_pfpr.py, LGA-level static)
   ├─ Merge MPI poverty + deprivations (state → LGA broadcast)
   └─ Output: +5 columns

4. Geospatial consolidation (consolidate_dataset.py + fetch_geo.py)
   ├─ Query elevation, area, centroid lat (OpenTopoData + OCHA)
   ├─ Derive pop_density = population / area_sqkm
   └─ Final output: agg_lga_pop.parquet (64k × 139)

5. Manifest generation (integrate_external2.py tail)
   └─ external_manifest.csv: provenance, resolution, % non-null
```

---

## 3. The What-If Lab: Conditional SARIMAX Forecasting

### 3.1 Overview
The **What-If Lab** (`🔬` tab in UI) enables:
1. **Plug & Play**: Univariate or multivariate SARIMAX fitted on-the-fly at national/state level
2. **Conditional Forecasting**: Override intervention-side features (ACT, LLIN, IPTp…) and recast
3. **Budget Planning**: Groq LLM generates ₦/USD cost breakdown + geographic prioritization

### 3.2 Frontend Architecture (`WhatIfLab.jsx`)

#### **Mode Toggle**: Plug & Play vs What-If
- **Plug & Play**: 
  - Select level (National | State) → target indicator → optional covariates
  - Run univariate or multivariate SARIMAX
  - Output: history + forecast + 95% CI
  
- **What-If**: 
  - Same setup + intervention sliders for actionable features
  - Baseline (climate, geography, poverty) features locked (read-only badges)
  - User scales intervention features (−80% to +200%) and re-runs
  - Output: base forecast + what-if forecast side-by-side, cases averted

#### **Covariate Picker** (`FeaturePicker` component)
- **Searchable list** of all 156 numeric columns
- User selects covariates to include in SARIMAX exog matrix
- Chip-based UI for quick add/remove; selected count display

#### **Intervention Levers** (`InterventionCard` component)
- **Locked baseline features** (ENSO, elevation, NDVI, poverty, etc.) shown as read-only
- **Actionable features** (ACT, LLIN, RDT, IPTp, ANC, etc.) have range sliders
- **Slider range**: −80% to +200% (relative change from current projection)
- **Live readout**: Shows % delta and interpretation (e.g., "Scale up by 30%")

#### **Visualization**: CompareChart + ChartTT (tooltip)
- **Series**:
  - Historical (teal, solid)
  - Forecast or Base Forecast (amber/blue, dashed)
  - What-If (green if cases ↓, red if cases ↑, solid)
- **Last historical point bridges forecast lines** (no discontinuity)
- **KPI tiles**: Cases averted, cost per case averted (computed from Groq plan)

#### **Detail Table**
- Monthly breakdown: forecast mean, lower/upper CI bounds
- What-If comparison: base vs what-if side-by-side, monthly delta

---

### 3.3 Backend: SARIMAX Model (`api.py`)

#### **Endpoint: `/api/forecast` (univariate or multivariate)**

```python
POST /api/forecast
{
  "level": "national" | "state",
  "state_name": "Lagos" | null,
  "target": "MAL - Malaria cases confirmed (number)",
  "covariates": ["rainfall_mm_day", "temperature_mean_c"],
  "horizon": 12
}
```

**Processing**:
1. **Aggregate to level**: 
   - National: sum/mean across all LGAs by (year, month)
   - State: filter state + sum/mean across LGAs by (year, month)
   - Mean applied to: rates, percentages, environmental variables (temperature, NDVI, ENSO, poverty)
   - Sum applied to: counts (cases, tests, treatments, populations)

2. **Trim trailing zeros**:
   ```python
   trim_trailing_zeros(series) → finds last non-zero month, drops unreported tail
   ```
   - Reason: Dataset has placeholder zeros for future months; SARIMAX can't fit when tail is flat
   - Example: Last real data 2026-03, zeros from 2026-04 onward → trim to 2026-03

3. **Fill NaNs**:
   - Interpolate missing interior values (linear)
   - Back-fill any remaining NaNs (last-observation-carried-forward)
   - Fill final NaNs with 0

4. **Fit SARIMAX** (try 3 candidates, pick best AIC):
   ```
   Candidate orders:
   ├─ (1, 1, 1)(1, 0, 1, 12)  ← AR(1), I(1), MA(1) + seasonal AR(1), no seasonal diff, MA(1), 12-month cycle
   ├─ (2, 1, 1)(1, 0, 1, 12)
   └─ (1, 1, 2)(1, 0, 1, 12)
   
   Key insight: D=0 (no seasonal differencing) preserves seasonal amplitude
   → Forecast inherits repeating seasonal shape from history instead of collapsing flat
   ```

   - **Parameters**:
     - `order=(p,d,q)`: AR(p) + integration I(d) + MA(q) for level & trend
     - `seasonal_order=(P,D,Q,s)`: Seasonal AR(P), seasonal differencing D, seasonal MA(Q), period s=12
     - `P=1`: Current month's level influenced by same month last year
     - `D=0`: Don't difference away seasonal pattern; let P and Q model it
     - `trend='c'`: Constant (intercept) allowed

   - **Fit method**: L-BFGS optimization, max 400 iterations, suppress display

   - **Exogenous variables** (covariates):
     - User-provided columns merged into model as `exog` matrix
     - Future values projected using **last 12-month seasonal mean** per column
     - Missing future exog values backfilled via historical column mean

5. **Forecast**:
   - `res.get_forecast(steps=horizon, exog=exog_future)` → mean + 95% CI (default)
   - Clip all values to [0, ∞) and round to int

6. **Return**:
   ```json
   {
     "history": [{"date": "2026-01", "cases": 2212112}, ...],
     "forecast": [{"date": "2026-04", "cases": 2483027, "lower": 1912626, "upper": 3053427}, ...],
     "population": 220000000
   }
   ```

#### **Endpoint: `/api/whatif` (conditional forecast)**

```python
POST /api/whatif
{
  "level": "national",
  "target": "MAL - Malaria cases confirmed (number)",
  "covariates": ["rainfall_mm_day", "temperature_mean_c", "ACT Given - Total"],
  "interventions": {"ACT Given - Total": 30},  # 30% increase
  "horizon": 12
}
```

**Processing**:
1. Fit baseline SARIMAX (same as `/api/forecast`)
2. **Create what-if exog matrix**:
   - Start with baseline future exog (last 12-month seasonal means)
   - For each intervention `{column: pct_delta}`:
     - Scale future values: `exog_future[column] *= (1 + pct / 100)`
   - Example: ACT Given +30% → all future ACT values 1.3× baseline

3. **Refit on modified exog** and forecast
4. **Return**:
   ```json
   {
     "history": [...],
     "base": [{...forecast without intervention...}],
     "whatif": [{...forecast with intervention...}],
     "population": 220000000
   }
   ```

#### **Fallback (if SARIMAX fails)**:
- Naive seasonal repeat: take last 12 months, repeat pattern for horizon
- Apply 75%/125% bounds as dummy CI

---

### 3.4 Seasonal Behavior: Why D=0?

**Before** (D=1, seasonal differencing):
```
Year 1 seasonal pattern: Jan 2M, Feb 2.3M, ..., Jun 2.7M, ..., Dec 2.6M
Diff by 12:            Jan ΔΔ, Feb ΔΔ, ..., Jun ΔΔ, ..., Dec ΔΔ
Fit SARIMAX on diffs   → model assumes diffs are ~stationary
Forecast diffs         → diffs ≈ constant (trend removed)
Inverse diff           → forecast becomes flat line (no seasonal shape)
```

**After** (D=0, no seasonal differencing):
```
Year 1: Jan 2M, ..., Jun 2.7M, ..., Dec 2.6M
Year 2: Jan 2.1M, ..., Jun 2.9M, ..., Dec 2.5M   ← seasonal pattern repeats
Fit SARIMAX with P=1  → AR(P=1) captures "same month last year" dependence
Forecast:             → Jan ~ Jan-12, Jun ~ Jun-12, Dec ~ Dec-12, etc.
Result:               → Repeating seasonal shape in forecast ✓
```

This is **essential for malaria** because:
- Rainy season (Jun–Oct) → ↑ breeding habitats → ↑ cases (genuine physical seasonality)
- Dry season (Jan–May) → ↓ water availability → ↓ transmission
- Covariates (rainfall, temperature, NDVI) amplify or dampen this, but don't replace it

---

### 3.5 Budget Planning: Groq LLM Integration

#### **Endpoint: `/api/budget`**

```python
POST /api/budget
{
  "level": "national",
  "state_name": null,
  "target": "MAL - Malaria cases confirmed (number)",
  "interventions": {"ACT Given - Total": 30, "LLIN given – Total": 50},
  "base_monthly_cases": 2100000,
  "whatif_monthly_cases": 1400000,
  "population": 220000000,
  "horizon": 12
}
```

**Processing**:
1. **Load .env on every call** (override=True) → re-read GROQ_API_KEY without server restart
2. **Compute impact**:
   - Case reduction: 2100k − 1400k = 700k/month
   - Pct reduction: 700k / 2100k ≈ 33%
   - Total averted (12mo): 700k × 12 = 8.4M cases

3. **Craft prompt** for Groq llama-3.1-8b-instant:
   ```
   [System context: Nigeria health economics advisor]
   
   SITUATION:
   - Scope: Nigeria (national)
   - Population: 220M
   - Current malaria burden: 2.1M cases/month
   - Forecast with interventions: 1.4M cases/month
   - Expected reduction: 700k cases/month (33%)
   - Horizon: 12 months
   
   PLANNED INTERVENTIONS:
   - ACT Given - Total: +30%
   - LLIN given – Total: +50%
   
   YOUR TASK:
   1. Cost breakdown (Nigerian ₦ + USD):
      - Estimated units needed per intervention
      - Unit cost (realistic 2024 Nigeria supply chain)
      - Monthly + total cost (12-month horizon)
   
   2. Total budget summary
      - Cost per case averted
      - Value-for-money assessment
   
   3. Geographic prioritization:
      - Top 5–6 states by burden (name specifically)
      - Expected impact in each
   
   4. Implementation timeline (12-month rollout plan)
   
   5. Risk flags (supply chain, capacity, caveats)
   ```

4. **Groq response** (max 2000 tokens):
   - Streams structured plan with costs in ₦ and USD
   - Example output structure:
     ```
     **INTERVENTION COST BREAKDOWN**
     
     ACT Given - Total (30% increase):
     - Baseline monthly: 1.2M doses
     - Planned increase: 1.56M doses (+360k)
     - Unit cost: ₦150/dose ($0.094/dose)
     - Monthly cost: ₦54M ($33.75k)
     - 12-month cost: ₦648M ($405k)
     
     LLIN given – Total (50% increase):
     - Baseline monthly: 800k nets
     - Planned: 1.2M nets (+400k)
     - Unit cost: ₦2,500/net ($1.56/net)
     - Monthly cost: ₦1B ($625k)
     - 12-month cost: ₦12B ($7.5M)
     
     TOTAL BUDGET: ₦12.648B (~$7.905M)
     Cost per case averted: ₦1,506 ($0.94)
     
     GEOGRAPHIC PRIORITIZATION:
     1. Lagos (23% of national burden) → ₦2.9B allocation
     2. Kano (18%) → ₦2.3B allocation
     ...
     
     IMPLEMENTATION TIMELINE:
     - Months 1–2: Procurement + training
     - Months 3–4: Facility sensitization
     - Months 5–12: Full-scale rollout
     
     RISKS:
     - Supply chain: ACT availability may be limited; pre-order 6 months ahead
     - Absorption: Health workers' ability to distribute; stagger rollout if capacity limited
     ```

5. **Return to UI**: Display plan in scrollable card with regenerate button

---

## 4. External Data Summary

| Column | Source | Resolution | Type | Update Frequency | Provenance Script |
|--------|--------|-----------|------|------------------|------------------|
| ndvi | FEWS NET | LGA-month | Continuous [0,1] | Weekly | `integrate_external.py` |
| ndvi_anom | FEWS NET | LGA-month | Z-score vs seasonal | Weekly | `` |
| enso_oni | NOAA CPC | National-month | Index [-3, +3] | Monthly | `integrate_external.py` |
| iod_dmi | NOAA PSL | National-month | Index | Monthly | `` |
| elevation | SRTM (OpenTopoData) | LGA-static | Meters | Once (2024) | `fetch_geo.py` |
| area_sqkm | OCHA | LGA-static | km² | Once (OCHA 2023) | `consolidate_dataset.py` |
| latitude | OCHA | LGA-static | Degrees N | Once | `` |
| pop_density | Derived | LGA-year | pop/km² | Annual | `consolidate_dataset.py` |
| pfpr | MAP WMS | LGA-static | % [0,100] | 2024 snapshot | `fetch_pfpr.py` |
| poverty_mpi_h | OPHI/NBS | State-year | % | 2019 survey | `integrate_external2.py` |
| dep_schooling | OPHI | State-year | % | 2019 | `` |
| dep_electricity | OPHI | State-year | % | 2019 | `` |
| dep_water | OPHI | State-year | % | 2019 | `` |
| dep_housing | OPHI | State-year | % | 2019 | `` |

---

## 5. Derivations & Formulas

### 5.1 `fac_share` (Facility Share)
```python
_fac["fac_share"] = _fac["n_facilities"] / _fac.groupby("state")["n_facilities"].transform("sum")
# Each LGA's fraction of state's total facilities
```
**Purpose**: Proxy for LGA population when census-level LGA data unavailable
```python
population = state_population * fac_share
```

### 5.2 `incidence_per_1000`
```python
incidence_per_1000 = (confirmed_cases / population) * 1000
```
**Purpose**: Standardize cases per 1,000 population for cross-LGA comparison

### 5.3 `ndvi_anom` (NDVI Anomaly)
```python
# Per LGA + month-of-year:
ndvi_anom = (ndvi[month] - mean_ndvi_seasonal[month]) / std_ndvi_seasonal[month]
# Deviation from LGA's typical green-ness for that month (in units of seasonal std)
```
**Purpose**: Detect abnormal vegetation patterns (drought, unusual rains)

### 5.4 `pop_density`
```python
pop_density = population / area_sqkm
```
**Purpose**: Urbanization proxy; denser areas → better healthcare access or higher contact rates

### 5.5 Lags & Rolling Aggregates (runtime-derived, NOT in parquet)
```python
act_lag1 = ACT[t-1]
act_roll3 = mean(ACT[t-3:t-1])
cases_anomaly = (cases[t] - mean(cases[t-12:t-3])) / std(cases[t-12:t-3])
spatial_lag1 = mean(cases in neighboring LGAs at time t)
```
**Location**: `features.py:build_features()` (called at runtime by model pipeline)
**Purpose**: Capture auto-correlation, smooth noise, capture spatial spillover

---

## 6. Running the Platform

### 6.1 Prerequisites
```bash
# Python 3.11
pip install fastapi uvicorn pandas statsmodels groq python-dotenv

# Node 18+
npm install -g pnpm
cd ui && npm install
```

### 6.2 Setup
```bash
# Copy template, fill in key from https://console.groq.com/keys
cp .env.example .env
# Edit .env: GROQ_API_KEY=gsk_...
```

### 6.3 Run Both Servers (in separate terminals)

**Terminal 1 — FastAPI backend**:
```bash
python api.py
# Listens on http://0.0.0.0:8000
# Auto-reloads on file changes
```

**Terminal 2 — Frontend dev server**:
```bash
cd ui
npm run dev
# Listens on http://localhost:5173
# Opens browser automatically
# Proxies /api/* to http://localhost:8000
```

### 6.4 Workflow
1. Open http://localhost:5173
2. Toggle variant (Before/After) in top bar
3. Navigate to **🔬 What-If Lab**
4. **Plug & Play mode**:
   - Select National
   - Pick target indicator (default: `MAL - Malaria cases confirmed (number)`)
   - Optionally add covariates (temperature, rainfall, NDVI, etc.)
   - Hit **Run SARIMAX**
   - Chart shows history + 12-month univariate forecast with seasonal variation

5. **What-If mode**:
   - Select interventions (ACT +30%, LLIN +50%, etc.)
   - **Baseline features are locked** (environment, poverty, geography)
   - Hit **Run SARIMAX**
   - Chart shows base vs what-if forecast
   - KPIs show cases averted (base − what-if)

6. **Budget Planning** (What-If only):
   - Ensure `.env` has valid `GROQ_API_KEY`
   - Click **💰 Generate Budget Plan**
   - Groq LLM returns ₦/USD breakdown + geographic priority + implementation timeline

---

## 7. Key Methodological Choices

### 7.1 Why SARIMAX (not ML ensemble)?
- **On-the-fly fitting**: No pre-trained models → supports any covariate combination at any level
- **Seasonal structure**: D=0 + P=1 preserves real malaria seasonality (rainy vs dry)
- **Interpretability**: Coefficients for exog variables are explicit
- **CI bands**: Native confidence intervals (not bootstrap)
- **Real-time conditioning**: User-set intervention values immediately affect forecast

### 7.2 Why `(1,1,1)(1,0,1,12)` base order?
- **p=1, d=1, q=1**: Minimal—sufficient for first-differenced series (trend-stationary)
- **P=1**: Same month last year matters (strong seasonal memory)
- **D=0**: Don't erase seasonal amplitude (critical for malaria)
- **Q=1**: Minimal seasonal MA to absorb shocks
- **Candidates**: Try p=2, q=2 variants; pick best AIC to adapt to data

### 7.3 Why broadcast state-level indices to LGAs?
- **MPI poverty**, **elevation**, **area**: LGA-level; used as-is
- **ENSO, IOD**: Global teleconnections → same value all LGAs nationally; all states same value
- **NDVI**: Already LGA-monthly; no broadcast needed
- **Temperature**: LGA-level derived from ERA5 centroid; no broadcast

### 7.4 Why `fac_share` for population?
- Nigeria's LGA census data incomplete; DHIS2 doesn't report LGA population
- Facilities distributed roughly with population (health systems follow demand)
- `fac_share` is a reasonable population proxy; better than no LGA breakdown
- **Caveat**: Not perfect (e.g., rural/urban facility density varies)

### 7.5 Why trim trailing zeros before fitting?
- Dataset extends to 2026 but last real report was 2026-03
- SARIMAX can't infer seasonality if tail is flat zeros
- Trimming to last non-zero observation ensures model learns from actual signal

### 7.6 Why Groq (not GPT-4, Claude, local LLM)?
- **Speed**: Groq's inference optimized for low latency (~200–500ms)
- **Cost**: Pay-per-token; budget endpoint uses ~500 tokens typical
- **Model**: `llama-3.1-8b-instant` capable of structured output (cost breakdown, tables)
- **No local GPU needed**: Cloud API; no model weights to manage
- **Integration**: Simple REST API; HTTP calls from FastAPI

---

## 8. Data Dictionary & Column Meanings

See **📋 Model Lab → Data Dictionary** in UI for all 139 columns with:
- **Meaning**: Plain-language definition
- **Derivation**: How computed (formula or source)
- **Interpretation**: What values mean (e.g., "higher = better")
- **Source**: Link to original data provider
- **Feature importance**: % contribution to ensemble model (in Before/After variants)

Key abbreviations:
- **ACT**: Artemisinin-based combination therapy
- **LLIN**: Long-lasting insecticide-treated net
- **ITN**: Insecticide-treated net
- **IPTp**: Intermittent preventive therapy in pregnancy
- **RDT**: Rapid diagnostic test
- **ENSO/ONI**: El Niño Southern Oscillation / Oceanic Niño Index
- **IOD/DMI**: Indian Ocean Dipole / Dipole Mode Index
- **NDVI**: Normalised Difference Vegetation Index
- **PfPR**: *Plasmodium falciparum* parasite rate
- **MPI**: Multidimensional poverty index

---

## 9. Limitations & Future Work

### 9.1 Known Limitations
1. **LGA population proxy**: `fac_share` is imperfect; true census-LGA data would improve per-capita rates
2. **MPI static**: 2019 snapshot; doesn't capture economic changes 2020–2026
3. **Exog projection**: Future covariates use last-12-month seasonal mean (assumes climatology repeats)
4. **No uncertainty on exog**: We don't forecast climate/rainfall; user-set interventions are deterministic
5. **SARIMAX lag order**: Grid search over 3 candidates; full ACF/PACF analysis could refine further
6. **Supply-side only**: Model doesn't endogenize demand-side factors (e.g., public education campaigns)

### 9.2 Future Extensions
- **Multi-step interventions**: Model interactions (e.g., ACT + RDT coverage affects effectiveness)
- **Uncertainty on exog**: Sample from climate model ensembles for stochastic rainfall
- **Causal inference**: Propensity matching or IV regression to isolate ACT → cases relationship
- **Real-time data**: Auto-fetch latest DHIS2 reports, ENSO index, NDVI to keep forecast current
- **Sub-national optimization**: Linear programming to allocate budget across states for max impact
- **Demand-side**: Integrate education campaign data, vaccination uptake, behavior change

---

## 10. Technical Stack & Dependencies

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend | FastAPI | 0.137+ |
| Server | Uvicorn | 0.49+ |
| Time series | statsmodels | 0.13+ |
| Data | pandas | 1.5+ |
| Numerics | numpy | 1.23+ |
| LLM API | Groq | 1.4+ |
| Frontend | React | 18+ (Vite) |
| Charts | Recharts | 2.8+ |
| Styling | CSS variables | (custom theme) |

---

## 11. Appendix: Key Scripts

| Script | Purpose | Inputs | Outputs |
|--------|---------|--------|---------|
| `aggregate.py` | DHIS2 → LGA-month sums | Raw DHIS2 CSV | `agg_lga_pop.csv` |
| `impute_gaps.py` | Fill missing DHIS2 months | `agg_lga_pop.csv` | Imputed version |
| `fetch_geo.py` | Query elevation, area, centroid | OCHA boundaries | `geo_lga.csv` |
| `fetch_pfpr.py` | Get PfPR from MAP WMS | LGA centroids | `pfpr_lga.csv` |
| `integrate_external.py` | Merge NDVI, ENSO, IOD | DHIS2 + NDVI CSV + external indices | Dataset + 8 cols |
| `integrate_external2.py` | Merge PfPR, MPI poverty | Dataset + CSV/Excel | Final parquet + manifest |
| `consolidate_dataset.py` | Add elevation, area, derive pop_density | `geo_lga.csv` + dataset | Final parquet |
| `api.py` | FastAPI backend | `agg_lga_pop.parquet` + .env | /api/* endpoints |
| `ui/src/views/WhatIfLab.jsx` | React What-If Lab | API endpoints | Interactive UI |

---

## 12. Contact & Attribution

**Built by**: Claude Code (Anthropic)  
**Data sources**: DHIS2 Nigeria, NOAA CPC, FEWS NET, OCHA, MAP, OPHI/NBS, Copernicus ERA5  
**Model framework**: statsmodels (SARIMAX), Groq (budget planning)  
**Geography**: Nigeria, 37 states, 768 LGAs, 2020–2026 monthly

---

**Last updated**: June 2026  
**Version**: 1.0 (What-If Lab release)
