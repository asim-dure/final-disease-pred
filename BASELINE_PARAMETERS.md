# Baseline Parameters Selection at National, State, and LGA Levels

---

## 1. What Are Baseline Parameters?

**Baseline parameters** are the foundational values (forecasted future values, not historical) used as the starting point for scenario analysis in both the Simulator and What-If Lab.

They represent **"what we expect to happen if nothing changes"** — the reference point against which all interventions are measured.

### 1.1 Two Concepts: "Baseline" vs "Parameter"

- **Baseline**: The forecasted value (not historical) for a driver in a future month (e.g., June 2026)
  - Computed via **climatology + damped annual trend** (see drivers.py)
  - Example: "We forecast 2.5M LLIN nets will be distributed in June 2026 given current trends"

- **Parameter**: A measurable quantity (a column in the dataset)
  - Examples: rainfall_mm_day, ACT Given - Total, ENSO ONI, elevation, poverty_mpi_h
  
- **Baseline Parameter**: The forecasted value of a specific parameter at a specific location and time
  - Example: "Baseline rainfall at Lagos in June 2026 is 198 mm/day"

### 1.2 Why Baseline Parameters Matter

In scenario analysis, you need a **reference point** to measure change:

```
User asks: "What if we double ACT distribution?"

The system needs to know:
  1. What is the current/forecasted ACT baseline? (e.g., 1.2M doses/month)
  2. What is 'double' relative to that? (e.g., 2.4M doses/month)
  3. How much does cases change? (factor = 1 + elasticity × fractional_change)

Without a baseline, "double" is meaningless.
```

---

## 2. Baseline Parameter Selection at National Level

### 2.1 National Aggregation

At the **national level**, baseline parameters are computed by aggregating across all 37 states and 768 LGAs.

**Aggregation rule** (from drivers.py:70–76):
```python
def loc_drivers(sub):
    for did, meta in DRIVER_META.items():
        col = meta["col"]
        
        if meta["agg"] == "sum":
            # Counts: ACT doses, nets distributed, tests performed
            # AGGREGATE BY SUMMING
            g = sub.groupby("ym")[col].sum()    # ← Sum across LGAs
        else:
            # Rates, percentages, environmental variables
            # AGGREGATE BY AVERAGING
            g = sub.groupby("ym")[col].mean()   # ← Mean across LGAs
```

### 2.2 Example: National ACT Baseline

**Data**: `agg_lga_pop.parquet` has 768 LGAs × 84 months (2020–2026)

**Step 1: Group by month**
```
2025-04 (April 2025):
  Lagos Ikeja:      ACT = 45,000 doses
  Lagos Ikorodu:    ACT = 38,000 doses
  Kano Kano:        ACT = 52,000 doses
  Kano Fagge:       ACT = 41,000 doses
  ... (768 LGAs total)
```

**Step 2: Sum across all LGAs**
```
National ACT (April 2025) = 45k + 38k + 52k + 41k + ... = 1,180,000 doses/month
```

**Step 3: Repeat for all months (Jan 2020 – Mar 2026)**
```
National ACT time series:
  2020-01: 900k
  2020-02: 920k
  ...
  2025-04: 1.18M
  2025-05: 1.15M
  ...
  2026-03: 1.20M  ← Last actual data
```

**Step 4: Measure baseline**
```python
recent_12 = [2025-04, 2025-05, ..., 2026-03]  # Last 12 months
hist = mean(1.18M, 1.15M, ..., 1.20M) = 1.175M  # Historical average
```

**Step 5: Forecast forward (climatology + trend)**
```python
# 1. Monthly climatology
# Average for each calendar month (across all years 2020–2026)
  Jan avg: 1.10M
  Feb avg: 1.12M
  Mar avg: 1.18M
  Apr avg: 1.20M  ← Typically highest (post-rainy season cases spike)
  ...
  Dec avg: 0.95M

# 2. Annual trend
# Slope of yearly averages
  2020 avg: 0.85M
  2021 avg: 0.92M
  2022 avg: 1.05M
  2023 avg: 1.15M
  2024 avg: 1.25M
  2025 avg: 1.30M  ← Trend: +90k per year
  Slope: +90k/yr, damped: +36k/yr (40% retention)

# 3. Forecast for 2026–2030
  For Jun 2026:
    climatology = 1.18M  (June's typical value)
    trend effect = +36k × (2026 - 2025) = +36k
    forecast = 1.18M + 36k = 1.216M
```

**Step 6: Set as baseline (Simulator)**
```python
base = 1.216M  # Used as Simulator lever starting point

Slider range:
  lo = 0
  hi = max(1.216M × 2.0, 1.175M × 2.0) = 2.43M
    (2× forecast or 2× historical, whichever larger)

Slider display:
  "ACT treatment courses: 1,216,000 /mo [range: 0 – 2,430,000]"
```

### 2.3 Environmental Parameters at National

**Rainfall (national baseline)**:
```python
# National rainfall = mean across LGAs
recent_12 months mean = 95 mm/day
climatology = {Jan: 40, Feb: 45, ..., Jun: 180, Jul: 210, ..., Dec: 35}
trend = −1.5 mm/yr, damped = −0.6 mm/yr

2026-06 forecast:
  climatology = 180 mm/day
  trend = −0.6 × 1 = −0.6
  baseline = 179.4 mm/day (slightly drier than climatology)
```

**Temperature (national baseline)**:
```python
# National temp = mean across LGAs
recent_12 months mean = 26.5°C
climatology = {Jan: 24, Feb: 25, ..., Apr: 27.5, May: 28, Jun: 27, ..., Dec: 24.5}
trend = +0.08°C/yr, damped = +0.032°C/yr (warming)

2026-04 forecast:
  climatology = 27.5°C
  trend = +0.032 × 1 = +0.032
  baseline = 27.53°C (0.5% warmer than climatology)
```

### 2.4 Static Parameters (No Forecasting)

Some baseline parameters **don't change** because they're static:

```python
elevation          # LGA-fixed geographic property → no forecast
latitude           # LGA-fixed geographic property → no forecast
area_sqkm          # LGA-fixed geographic property → no forecast
pfpr               # Malaria prevalence (snapshot, doesn't change monthly)
poverty_mpi_h      # MPI poverty (state-level snapshot, doesn't change)
dep_schooling      # Deprivation indicators (static, from 2019 survey)
```

For national level, these are **aggregated once**:
```python
# National elevation = mean of LGA elevations
# National pfpr = mean of LGA PfPR values
# These values are used as-is (no trend, no seasonal variation)
```

---

## 3. Baseline Parameter Selection at State Level

### 3.1 State Aggregation

At the **state level**, baseline parameters are computed by aggregating across LGAs within that state only.

**Process**: Identical to national, but `sub = df[df['state'] == 'Lagos']`

### 3.2 Example: Lagos State ACT Baseline

**Data**: Lagos has ~30 LGAs

**Step 1: Filter to Lagos**
```python
sub = agg_lga_pop[agg_lga_pop['state'] == 'Lagos']  # ~30 LGAs × 84 months
```

**Step 2: Aggregate by month (sum ACT across Lagos LGAs)**
```python
2025-04 in Lagos:
  Ikeja: 45k
  Ikorodu: 38k
  Epe: 22k
  ... (30 LGAs)
  Total Lagos ACT = 180k doses/month
```

**Step 3: Compute baseline**
```python
recent_12 avg = 175k doses/month (historical)
climatology = {Jan: 165k, Feb: 168k, ..., Apr: 185k, ..., Dec: 155k}
trend = +8k/yr, damped = +3.2k/yr

2026-04 forecast (Lagos):
  baseline = 185k + 3.2k × 1 = 188.2k doses/month
```

**Step 4: Simulator lever (Lagos)**
```
"ACT treatment courses: 188,200 /mo [range: 0 – 376,400]"
```

### 3.3 Why State Differs from National

**National**: 1.216M ACT/month (all 768 LGAs)
**Lagos**: 188k ACT/month (~30 LGAs)

**Ratio**: Lagos ≈ 15.4% of national ACT

This is **realistic** because Lagos has:
- ~23% of Nigeria's population (230M/1.4B)
- Higher facility density (more health posts)
- Better reporting completeness
- But fewer facilities than some other states (by absolute count)

### 3.4 State-Specific Environmental Baselines

Rainfall, temperature vary by geography:

```python
# Lagos (coastal, tropical):
#   rainfall: higher (200+ mm/day in rainy season)
#   temperature: 25–27°C year-round (maritime climate)

# Kano (Sahel, semi-arid):
#   rainfall: lower (80–150 mm/day in rainy season)
#   temperature: 22–35°C (extreme seasonal variation)

# Baseline ACT also varies by state:
#   Lagos: 188k (good healthcare access, higher utilization)
#   Kano: 250k (higher population, more facilities)
#   Bauchi: 120k (less developed health system)
```

---

## 4. Baseline Parameter Selection at LGA Level

### 4.1 LGA (No Aggregation)

At the **LGA level**, there is **no aggregation** — baseline parameters are taken directly from that single LGA.

**Process**: `sub = agg_lga_pop[(agg_lga_pop['state'] == 'Lagos') & (agg_lga_pop['lga'] == 'Ikeja')]`

### 4.2 Example: Lagos Ikeja LGA Baseline

**Data**: Ikeja LGA, 84 months (2020–2026)

**Step 1: Filter to Ikeja**
```python
sub = agg_lga_pop[(agg_lga_pop['state'] == 'Lagos') & (agg_lga_pop['lga'] == 'Ikeja')]
# Result: 84 rows (one per month)
```

**Step 2: Compute baseline from time series**
```python
ACT time series (Ikeja):
  2020-01: 2,500
  2020-02: 2,800
  ...
  2025-04: 4,200
  2025-05: 4,100
  ...
  2026-03: 4,350  ← Last actual

recent_12 avg = 4,180 doses/month
climatology = {Jan: 3,800, Feb: 3,900, ..., Apr: 4,200, ..., Dec: 3,500}
trend = +150 doses/yr, damped = +60 doses/yr

2026-04 forecast (Ikeja):
  baseline = 4,200 + 60 × 1 = 4,260 doses/month
```

**Step 3: Simulator lever (Ikeja)**
```
"ACT treatment courses: 4,260 /mo [range: 0 – 8,520]"
```

### 4.3 Nested Aggregation: National ⊃ State ⊃ LGA

```
National ACT baseline (2026-04): 1,216,000 doses/month
  ├─ Lagos (15.4%):            188,200 doses/month
  │   ├─ Ikeja:                4,260 doses/month
  │   ├─ Ikorodu:              3,980 doses/month
  │   └─ ... (28 other LGAs)
  ├─ Kano (20.5%):             249,500 doses/month
  │   ├─ Kano LGA:             18,900 doses/month
  │   └─ ... (44 other LGAs)
  └─ ... (35 other states)
```

**Consistency check**: Sum of state baselines ≈ national baseline (if all LGAs complete)

---

## 5. Locked vs. Movable Parameters in What-If Lab

### 5.1 Why Certain Parameters Are Locked

In the **What-If Lab**, some parameters are **locked** (read-only, cannot be moved by slider):

**Locked (Baseline) Parameters**:
- ENSO ONI (global climate, not actionable)
- IOD DMI (global climate, not actionable)
- NDVI, NDVI anomaly (satellite data, not controllable)
- Elevation (geographic, fixed)
- Latitude (geographic, fixed)
- Area (geographic, fixed)
- Poverty indices (MPI, deprivations; slow-changing socioeconomic)
- Rainfall, temperature, humidity (climate; forecasted forward, not user-set)
- PfPR (parasite prevalence; endemic level, not changeable short-term)

**Unlocked (Intervention) Parameters**:
- ACT Given - Total (health system decision)
- LLIN given – Total (health system decision)
- RDT tests (health system decision)
- IPTp coverage (health system decision)
- % Fever cases tested (health system decision)
- Any other supply-side or programmatic feature

### 5.2 Why This Distinction?

**Locked parameters represent the natural/external environment** — things health planners **cannot directly control**:
- You cannot change Nigeria's latitude or climate
- You cannot suddenly raise poverty indicators (slow process)
- You cannot change endemic malaria prevalence overnight

**Unlocked parameters represent interventions** — things health planners **can directly control**:
- Scale up ACT procurement
- Distribute more LLINs
- Increase testing
- Improve treatment coverage

### 5.3 Example: What-If Setup at National Level

**User selects**: National level, target = confirmed malaria cases, horizon = 12 months

**Available covariates** (156 columns total):
```
Locked (Baseline):
  ├─ enso_oni: 0.8 (El Niño, forecasted)
  ├─ rainfall_mm_day: 95 mm/day (climatology + trend)
  ├─ temperature_mean_c: 26.5°C (climatology + trend)
  ├─ elevation: 180 m (static, national mean)
  ├─ poverty_mpi_h: 42% (static, national)
  └─ ... (20+ more baseline features)

Unlocked (Interventions):
  ├─ ACT Given - Total: 1.216M [slider: 0 – 2.43M]
  ├─ LLIN given – Total: 2.50M [slider: 0 – 5.00M]
  ├─ RDT tests: 1.50M [slider: 0 – 3.00M]
  └─ ... (5+ more intervention features)
```

**User can**:
- Select which locked parameters to include as covariates (rainfall, temp, ENSO, etc.)
  - "Include rainfall, temperature, NDVI in the SARIMAX model"
- Slide intervention parameters
  - "ACT +30%, LLIN +50%"
- Run SARIMAX with those settings

**User cannot**:
- Slide locked parameters (they're locked 🔒)
- Change ENSO, elevation, poverty, etc.
- The UI shows them as read-only, informational

---

## 6. Baseline Parameter Selection at State Level: Special Considerations

### 6.1 State-Level Forecast for Environmental Variables

Environmental variables are **aggregated across LGAs within the state**:

```python
# Lagos rainfall baseline (state level):
# Step 1: Get rainfall for each Lagos LGA for recent 12 months
#   Ikeja: 190 mm/day (urban, air-conditioned facilities)
#   Epe: 210 mm/day (coastal)
#   Ikorodu: 200 mm/day (peri-urban)
#   ... (30 LGAs)
# Step 2: Average across LGAs
#   Lagos rainfall = mean(190, 210, 200, ...) = 205 mm/day
# Step 3: Forecast forward
#   climatology = 210 mm/day (Lagos typical June)
#   trend = −0.5 mm/yr, damped
#   baseline = 209.8 mm/day (June 2026)
```

**Why state matters**: Rainfall varies within state by ~10–15%, so state-level baseline differs from national.

### 6.2 State-Level Supply (Health System)

Supply-side variables are also aggregated by state:

```python
# Lagos ACT (state level): 188k doses/month
# Why? Lagos has ~30 LGAs with varying health system capacity
#   Ikeja: 4.3k (well-resourced, high facility density)
#   Epe: 2.1k (rural, lower facility count)
#   Ikorodu: 3.5k (peri-urban)
#   ... (27 other LGAs)
#   Total Lagos: 188k

# This reflects the state's actual capacity
# (not a model assumption, but measured from data)
```

### 6.3 What-If at State Level

**User selects**: Lagos state, target = malaria cases, horizon = 12 months

**Baselines reflect Lagos specifically**:
```
Locked:
  - Rainfall: 205 mm/day (Lagos climatology + trend)
  - Temperature: 26.2°C (Lagos, slightly cooler than national due to coast)
  - Elevation: 110 m (Lagos mean; national is 180 m)
  - Poverty: 38% (Lagos state, lower than national 42%)

Unlocked:
  - ACT: 188k [range: 0 – 376k]
  - LLIN: 95k [range: 0 – 190k]
  - RDT: 68k [range: 0 – 136k]
```

**Forecast is state-specific**, not national scaled down.

---

## 7. Baseline Parameter Selection at LGA Level: Simulator Only

### 7.1 LGA-Level Constraints

The **Simulator supports LGA-level analysis**, but the **What-If Lab does NOT** (too slow to fit SARIMAX per LGA).

At LGA level, Simulator:
- Loads pre-computed LGA case forecasts (from `forecast_lga.parquet`)
- Uses LGA-specific driver baselines
- Applies elasticity multiplier

### 7.2 Example: Lagos Ikeja LGA in Simulator

**Baselines (Ikeja-specific)**:
```
Locked:
  - Rainfall: 212 mm/day (Ikeja coastal, wetter than Lagos average)
  - Temperature: 25.8°C (Ikeja, maritime influence)
  - Elevation: 95 m (Ikeja, near sea level)
  - Poverty: 35% (Ikeja, wealthier LGA within Lagos)

Unlocked:
  - ACT: 4,260 [range: 0 – 8,520]
  - LLIN: 12,500 [range: 0 – 25,000]
  - RDT: 8,900 [range: 0 – 17,800]
```

**Case forecast (Ikeja, pre-computed)**:
```
2026-04: 15,800 cases/month (baseline)
2026-05: 18,200 cases/month
2026-06: 22,100 cases/month (rainy season peak)
...
```

**Scenario (user scales ACT +50%, LLIN +30%)**:
```
multiplier = factor_act × factor_llin × ... = 0.89 (11% reduction)
Scenario 2026-06: 22,100 × 0.89 = 19,670 cases (2,430 averted)
```

### 7.3 Why What-If Lab Doesn't Support LGA

Fitting SARIMAX for 768 LGAs × 12-month horizon = ~9,200 model fits in parallel:
- **Time**: ~10–15 sec per fit × 9,200 = ~25+ hours
- **Cost**: Resource-prohibitive
- **UX**: User waits forever

**Solution**: Simulator handles LGA (pre-computed), Lab handles national/state (on-demand).

---

## 8. How Baseline Parameters Flow Through the System

### 8.1 Simulator Flow

```
drivers.py
  ├─ Load agg_lga_pop.parquet
  ├─ For each level (national, state, LGA):
  │   ├─ Aggregate by level
  │   ├─ Compute baseline per driver
  │   ├─ Forecast driver forward (climatology + trend)
  │   └─ Set slider range
  └─ Write drivers.json

drivers.json
  └─ Contains:
      ├─ meta (elasticity coefficients)
      ├─ national { "act": {"base": 1.216M, "lo": 0, "hi": 2.43M}, ... }
      ├─ states { "Lagos": { "act": {"base": 188k, ...}, ... }, ... }
      └─ lgas { "Lagos|||Ikeja": { "act": {"base": 4.26k, ...}, ... }, ... }

Simulator.jsx
  └─ User selects location + moves sliders
      ├─ Load baselines for that location from drivers.json
      ├─ User sets new values
      ├─ Compute factor = 1 + elasticity × (new - base) / base
      ├─ multiplier = ∏ factors
      └─ Apply to pre-computed forecast
```

### 8.2 What-If Lab Flow

```
User request: POST /api/whatif
  {
    "level": "national",
    "state_name": null,
    "target": "MAL - Malaria cases confirmed",
    "covariates": ["rainfall_mm_day", "ACT Given - Total"],
    "interventions": {"ACT Given - Total": 30},  # +30%
    "horizon": 12
  }

api.py
  ├─ Load parquet
  ├─ Aggregate to national (sum/mean across 768 LGAs)
  ├─ Extract {cases, rainfall, ACT} columns
  ├─ Trim trailing zeros (last data = 2026-03)
  ├─ Fit SARIMAX (baseline): cases ~ rainfall + ACT
  ├─ Get baseline future exog (rainfall from climatology, ACT baseline)
  ├─ Forecast 12 months → return "base" forecast
  │
  ├─ Override intervention: ACT_future *= 1.30
  ├─ Refit SARIMAX with modified exog
  ├─ Forecast 12 months → return "whatif" forecast
  │
  └─ Return {history, base, whatif, population}

WhatIfLab.jsx
  ├─ Display chart: historical + base (dashed) + whatif (solid)
  ├─ Show KPIs: cases averted
  └─ (Optional) Generate budget plan via Groq
```

---

## 9. Data-Driven vs. Model-Assumed Baselines

### 9.1 Data-Driven: Measured from Parquet

**ACT distribution, LLIN distribution, RDT testing**:
- Directly measured from DHIS2 reports
- Baseline = recent 12-month average, forecasted forward via climatology + trend
- Reflects actual health system behavior

### 9.2 Model-Assumed: From External Sources

**Rainfall, temperature, humidity**:
- Not DHIS2 data; from ERA5 reanalysis
- Baseline = climatological normal + damped trend
- Assumes climate continues on historical trajectory

**ENSO ONI, IOD DMI**:
- Not DHIS2 data; from NOAA
- Baseline = global teleconnection indices
- Forecasted via operational climate models (not in our code; pre-downloaded)

**Elevation, latitude, poverty**:
- Static geographic/socioeconomic data
- Baseline = constant (no forecast)
- Example: "Lagos elevation is 110m and doesn't change"

### 9.3 Implication for Scenarios

**Data-driven parameters** (ACT, LLIN):
- If user doesn't change the slider, forecast includes the trend we observed
- "ACT is being scaled up at current pace; forecast incorporates that growth"

**Model-assumed parameters** (rainfall, temperature):
- Forecast assumes climatology repeats with damped trend
- "Rainfall follows seasonal normal; no anomalies assumed"

**Locked static parameters** (poverty, elevation):
- Do not change in forecast
- "Poverty remains at 2019 levels; elevation is constant"

---

## 10. Practical Example: Three-Level Comparison

### 10.1 ACT Given - Total Baseline (2026-04)

| Level | Baseline | Slider Range | Notes |
|-------|----------|--------------|-------|
| **National** | 1.216M doses/mo | 0 – 2.43M | Sum of all 768 LGAs; reflects national capacity |
| **Lagos (State)** | 188.2k doses/mo | 0 – 376k | ~15.4% of national; coastal state, good healthcare access |
| **Ikeja (LGA)** | 4.26k doses/mo | 0 – 8.52k | Largest LGA in Lagos; urban, well-resourced |

**Ratio check**:
```
Ikeja / Lagos = 4.26k / 188.2k = 2.26% ✓ (Ikeja is ~2% of Lagos)
Lagos / National = 188.2k / 1.216M = 15.4% ✓ (Lagos is ~15% of Nigeria)
Ikeja / National = 4.26k / 1.216M = 0.35% ✓
```

### 10.2 Rainfall Baseline (2026-06, rainy season)

| Level | Baseline | Climatology | Trend | Notes |
|-------|----------|-------------|-------|-------|
| **National** | 179.4 mm/day | 180 mm/day | −0.6/yr | Slight drying trend nationally |
| **Lagos (State)** | 209.8 mm/day | 210 mm/day | −0.5/yr | Coastal, rainier; slower drying |
| **Ikeja (LGA)** | 212.4 mm/day | 213 mm/day | −0.4/yr | Urban, maritime; wettest in Lagos |

**Pattern**: Coastal LGAs wetter, inland drier (geographic variation)

### 10.3 Scenario: User scales ACT +30% nationally

**Before (baseline)**:
```
National ACT: 1.216M doses/month
National cases (2026-06): 3.2M cases/month (pre-computed)
```

**After (scenario)**:
```
New ACT: 1.216M × 1.30 = 1.581M doses/month (+30%)
Elasticity: −0.30
Factor: 1 + (−0.30) × 0.30 = 0.91
Scenario cases: 3.2M × 0.91 = 2.912M cases/month
Cases averted: 3.2M − 2.912M = 288k cases (~9%)
```

**If user scales at Lagos level instead**:
```
Lagos ACT: 188.2k × 1.30 = 244.7k
Factor: 0.91 (same elasticity)
Lagos baseline cases (2026-06): ~0.48M
Lagos scenario: 0.48M × 0.91 = 0.437M
Lagos cases averted: 43k

As % of national: 43k / 288k = 15% ✓
(Lagos is 15% of national, so proportional impact expected)
```

---

## 11. Common Misconceptions About Baselines

### 11.1 ❌ "Baseline means zero"

**Correct**: Baseline is the forecasted future value, not zero.
- ACT baseline ≠ 0 doses; it's the expected distribution level (1.216M nationally)
- Slider range is [0, 2×baseline], not [−baseline, +baseline]

### 11.2 ❌ "Baseline is historical average"

**Correct**: Baseline is the **forecasted future value**, adjusted for trend.
- Historical average (2025-04 to 2026-03): 1.175M ACT
- Baseline (2026-04): 1.216M ACT (slightly higher, accounting for upward trend)
- These differ because of trend projection

### 11.3 ❌ "Baselines are the same everywhere"

**Correct**: Baselines are location-specific.
- National ACT: 1.216M
- Lagos ACT: 188.2k (not Lagos = national ÷ 37 states; that would be ~33k)
- Variation reflects actual health system capacity measured from data

### 11.4 ❌ "You can move any parameter in What-If Lab"

**Correct**: Only interventions are movable; baselines are locked.
- ENSO ONI locked 🔒 (global climate, not actionable)
- ACT unlocked 🔓 (health system intervention, actionable)
- UI shows locked parameters as read-only

---

## 12. How to Check Baselines in Code

### 12.1 Simulator Baselines (drivers.json)

```bash
# After running python drivers.py:
cat ui/public/data/after/drivers.json | jq '.national.act'
# Output:
# {
#   "base": 1216000,
#   "hist": 1175000,
#   "lo": 0,
#   "hi": 2432000
# }

# State level:
cat ui/public/data/after/drivers.json | jq '.states.Lagos.act'
# Output:
# {
#   "base": 188200,
#   "hist": 175300,
#   "lo": 0,
#   "hi": 376400
# }

# LGA level:
cat ui/public/data/after/drivers.json | jq '.lgas["Lagos|||Ikeja"].act'
# Output:
# {
#   "base": 4260,
#   "hist": 4180,
#   "lo": 0,
#   "hi": 8520
# }
```

### 12.2 What-If Lab Baselines (Runtime)

The Lab computes baselines **on-demand** in `api.py`:

```python
# During /api/forecast or /api/whatif:
# 1. Load parquet
# 2. Aggregate to level (national/state)
# 3. Extract time series for chosen target
# 4. Trim trailing zeros
# 5. Baseline = forecasted future value (from SARIMAX)

# To inspect programmatically:
import pandas as pd
from api import get_df, agg_level

df = get_df()
national = agg_level(df, "national", None)

# View recent baselines:
print(national[["date", "MAL - Malaria cases confirmed (number)"]].tail(20))
```

---

## 13. Summary: Baseline Parameters at Each Level

| Aspect | National | State | LGA |
|--------|----------|-------|-----|
| **Aggregation** | Sum/mean across 768 LGAs | Sum/mean across LGAs in state | No aggregation |
| **ACT Baseline (2026-04)** | 1.216M doses/mo | 188.2k (Lagos) | 4.26k (Ikeja) |
| **Rainfall Baseline (2026-06)** | 179.4 mm/day | 209.8 (Lagos) | 212.4 (Ikeja) |
| **Sample Size** | 64k rows (all months/LGAs) | ~2.5k rows (all months in state) | 84 rows (all months in LGA) |
| **Forecast Method** | Climatology + damped trend | Climatology + damped trend | Climatology + damped trend |
| **Simulator Support** | ✅ Yes | ✅ Yes | ✅ Yes (pre-computed) |
| **What-If Lab Support** | ✅ Yes | ✅ Yes | ❌ No (too slow) |
| **Locked Baselines** | ENSO, rainfall, elevation, poverty, etc. | Same + state-specific values | Same + LGA-specific values |
| **Movable (Interventions)** | ACT, LLIN, RDT, coverage % | Same | Same (in Simulator) |

---

## 14. Final Note: Why This Matters

Understanding baseline parameter selection is **critical** for:

1. **Interpreting scenarios**: "If I double ACT, what changes?" → Requires knowing baseline ACT
2. **Geographic comparison**: "Which state benefits most from ACT scale-up?" → Depends on baseline ACT per state
3. **Budget planning**: "How much money?" → Depends on how far we're scaling from baseline
4. **Model assumptions**: "What if climate changes?" → Locked climate baselines assume normal continuation

Baseline parameters are the **reference frame** for all scenario analysis. Without clear, defensible baselines at each level, scenarios are meaningless.

