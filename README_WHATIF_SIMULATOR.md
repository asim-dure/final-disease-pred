# What-If Scenario Simulator — Build Logic & Elasticity Model

**Pre-trained driver elasticity layer for rapid scenario analysis at national/state/LGA level**

---

## 1. Overview

The **What-If Scenario Simulator** (🎛️ tab) is **distinct from the What-If Lab** (🔬 tab):

| Feature | Simulator (🎛️) | Lab (🔬) |
|---------|----------------|----------|
| **Basis** | Pre-trained elasticity model | SARIMAX fitted on-the-fly |
| **Forecasting method** | Pre-computed case forecast × driver multipliers | Directly fit SARIMAX with interventions as exog |
| **Driver handling** | 8 fixed drivers with pre-fitted elasticities | Any 156 columns as covariates |
| **Intervention mode** | Slide driver to any value in range | Percentage delta (−80% to +200%) |
| **Baseline projection** | Driver model forecasts the driver forward (climatology + trend) | Last 12-month seasonal mean |
| **LGA support** | Full LGA-level data + forecasts | National/State only |
| **Speed** | Instant (pre-computed) | ~10–15 sec per run |
| **Budget planning** | No | Yes (Groq LLM) |

---

## 2. Architecture

### 2.1 Data Flow

```
agg_lga_pop.parquet (64k × 139)
    ↓
drivers.py (compute elasticity baselines)
    ├─ Extract 8 drivers per location (national/state/LGA)
    ├─ Forecast each driver forward (2026–2030)
    ├─ Measure baseline value + slider range
    └─ → ui/public/data/drivers.json
         │
         └─ /api/meta (via lib.js useData)
              ↓
            Simulator.jsx (React component)
              ├─ User selects location (National | State | LGA)
              ├─ User moves sliders (adjust driver values)
              ├─ Compute multiplier = ∏(factor per driver)
              ├─ Apply multiplier to pre-computed case forecast
              └─ Display results
```

### 2.2 Key Files

| File | Role |
|------|------|
| `drivers.py` | Compute elasticity metadata + forecasted baselines per location; export JSON |
| `drivers.json` | Pre-computed driver baselines, slider ranges, elasticities, forecasts |
| `Simulator.jsx` | UI: location picker, sliders, multiplier calc, chart display |
| `forecast_national.csv`, `forecast_state.csv`, `forecast_lga.csv`, `forecast_lga.parquet` | Pre-computed case forecasts (history + 2026–2030) |
| `lgas.json` | LGA-level case time series (history + forecast) |

---

## 3. Driver Selection & Elasticity Coefficients

### 3.1 The 8 Drivers (DRIVER_META in drivers.py)

```python
{
  "llin":   {"col": "LLIN given – Total",          "elasticity": -0.40, "good": "down"},
  "u5llin": {"col": "% Under 5 receiving LLIN",    "elasticity": -0.30, "good": "down"},
  "act":    {"col": "ACT Given - Total",           "elasticity": -0.30, "good": "down"},
  "rdt":    {"col": "MAL - Malaria cases tested with RDT", "elasticity": -0.12, "good": "down"},
  "fevrdt": {"col": "% of Fever cases Tested with RDT",    "elasticity": -0.15, "good": "down"},
  "rain":   {"col": "rainfall_mm_day",             "elasticity": +0.30, "good": "up"},
  "temp":   {"col": "temperature_mean_c",          "elasticity": -0.06, "good": "opt"},
  "hum":    {"col": "humidity_pct",                "elasticity": +0.18, "good": "up"},
}
```

### 3.2 Elasticity Interpretation

**Elasticity = % change in cases per 100% change in driver, relative to baseline.**

**Example: ACT elasticity = −0.30**
- Baseline ACT: 1M doses/month → cases: 2M/month
- Intervention: ACT +100% → 2M doses/month
- Expected cases: 2M × (1 + (−0.30) × 1.0) = 2M × 0.7 = 1.4M
- Cases averted: 600k

**Good flag** (interpretation):
- `"good": "down"`: Higher value is better (more treatment/nets → fewer cases). Elasticity negative.
- `"good": "up"`: Higher value is worse (more rain/humidity → more cases). Elasticity positive.
- `"good": "opt"`: Optimal value (temperature ~27°C for *Anopheles* breeding; too hot/cold suppresses). Elasticity depends on distance from optimum.

### 3.3 Why These 8?

- **5 health system interventions** (LLIN, ACT, RDT, IPTp-like coverage):
  - Measured in DHIS2 surveillance
  - Directly actionable (policy-makers can scale up)
  - Elasticities estimated from observational data or expert consensus
  
- **3 environmental drivers** (rainfall, temperature, humidity):
  - Forecast from climatology (monthly average + damped trend)
  - Not directly actionable but inform scenario planning
  - Mechanistically linked to mosquito ecology

---

## 4. Driver Baseline & Forecasting Logic

### 4.1 Extracting Baselines (drivers.py:69–93)

For each location (national/state/LGA) and each driver:

```python
def loc_drivers(sub):  # sub = location's dataframe
    out = {}
    for did, meta in DRIVER_META.items():
        col = meta["col"]
        
        # 1. Aggregate: sum for counts, mean for rates/environment
        if meta["agg"] == "sum":
            g = sub.groupby("ym")[col].sum()      # e.g., LLIN = total across all LGAs
        else:
            g = sub.groupby("ym")[col].mean()     # e.g., rainfall = LGA mean
        
        # 2. Apply cap if needed (percentages max at 100%)
        if "cap" in meta:
            g = g.clip(upper=meta["cap"])
        
        # 3. Measure baseline from last 12 months (2025-04 to 2026-03)
        hist = g.reindex(recent12).mean()   # Average of recent 12 months
        
        # 4. Forecast driver to 2026–2030
        traj, fc_mean = forecast_driver(g.to_dict())
        
        # 5. Decide base value for slider:
        #    Use fc_mean (forecasted future) rather than hist (past)
        #    This gives the lever a *realistic forecasted baseline* 
        #    instead of anchoring to history
        if np.isnan(hist) and not np.isnan(fc_mean):
            hist = fc_mean
        base = fc_mean if not np.isnan(fc_mean) else hist
        
        # 6. Determine slider range [lo, hi]:
        #    - Temperature: ±5°C around base
        #    - Percentage: 0% to cap (100%)
        #    - Counts: 0 to 2× max(base, hist)
        if meta["unit"] == "°C":
            lo, hi = base - 5, base + 5
        elif meta["unit"] == "%":
            lo, hi = 0, meta.get("cap", 100)
        else:
            lo, hi = 0, max(base * 2.0, hist * 2.0, 1)
        
        out[did] = {
            "base": base,           # Baseline value (used in sliders initially)
            "hist": hist,           # Recent 12-month average (for reference)
            "lo": lo,               # Slider minimum
            "hi": hi,               # Slider maximum
        }
    return out
```

### 4.2 Driver Forecasting (drivers.py:39–66)

Each driver is forecasted using **monthly climatology + damped annual trend**:

```python
def forecast_driver(series_by_ym):
    """
    Input: time series of driver values by year-month (ym = year*12 + month - 1)
    Output: dict of forecasted values (ym → value) for 2026–2030, + mean
    """
    s = pd.Series(series_by_ym).dropna()  # Historical observations
    
    if s.empty:
        return {}, np.nan
    
    # 1. Monthly climatology: average value for each calendar month
    months = (s.index % 12) + 1          # Extract month (1–12)
    clim = s.groupby(months).mean()      # Mean for each Jan, Feb, ..., Dec
    overall = s.mean()                   # Fallback if month not in data
    
    # 2. Annual trend: slope across yearly means, damped by 40%
    yrs = (s.index // 12)                # Extract year
    ann = s.groupby(yrs).mean()          # Yearly average
    
    if len(ann) >= 2:
        x = np.array(ann.index, float)
        y = ann.values
        slope = np.polyfit(x, y, 1)[0] * 0.4   # Linear fit × 0.4 damping factor
    else:
        slope = 0.0
    
    # 3. Forecast each future month: climatology + damped trend
    base_year = max(yrs)
    traj = {}
    for yr in [2026, 2027, 2028, 2029, 2030]:
        for m in range(1, 13):
            ym = yr * 12 + m - 1
            
            # Skip if we already have actuals (shouldn't happen for future years)
            if ym <= LAST_ACTUAL:
                continue
            
            # Forecast = climatology + trend
            base = clim.get(m, overall)   # This month's climatology
            traj[ym] = max(0.0, base + slope * (yr - base_year))
    
    # 4. Mean of forecasted period
    fc_mean = np.mean(list(traj.values())) if traj else overall
    
    return traj, fc_mean
```

**Example: Rainfall at Lagos**
- Historical mean rainfall by month: Jan 50mm, ..., Jun 200mm, Jul 280mm, ..., Dec 60mm
- 2024 annual trend: declining at −5 mm/yr
- Damped trend: −5 × 0.4 = −2 mm/yr
- Forecast for Jul 2026: 280 + (−2) × 2 = 276 mm (slightly drier than climatology)

### 4.3 Why Climatology + Damped Trend?

- **Climatology**: Respects the seasonal cycle (Jun–Oct rainy season for Nigeria) — no point forecasting winter rain
- **Damped trend**: Acknowledges recent drift (warming, land-use change, climate shift) but limits extrapolation
- **Damping factor (0.4)**: Assumes trends regress toward climatology; 40% retention means trend decays ~50% per decade
- **Output**: Provides the UI with a realistic "baseline" driver value that is seasonally appropriate

---

## 5. Elasticity-Based Multiplier Computation

### 5.1 The `factor()` Function (Simulator.jsx:6–16)

```javascript
function factor(meta, val, base) {
  // Compute multiplicative effect on cases from driver change
  
  if (meta.good === 'opt') {
    // Optimal value case (temperature ~27°C)
    const opt = meta.optimum ?? 27
    const suit = v => 1 - Math.min(1, Math.abs(v - opt) / 12)  // Suitability
    const sb = Math.max(0.05, suit(base))
    return Math.max(0.2, Math.min(2, suit(val) / sb))
  }
  
  // Linear elasticity case (interventions, rain, humidity)
  if (!base || base <= 0) return 1
  
  const frac = (val - base) / base    // Fractional change: (new - old) / old
  return Math.max(0.2, Math.min(3, 1 + meta.elasticity * frac))
}
```

**For linear elasticity drivers** (most):
- `frac = (val − base) / base` → fractional change
- `factor = 1 + elasticity × frac`
- Clipped to [0.2, 3] (20% reduction, 3× increase in cases)

**Example: ACT elasticity = −0.30**
```
Base ACT: 1M doses/month
User sets: 1.2M doses (20% increase)
frac = (1.2M - 1M) / 1M = 0.2
factor = 1 + (−0.30) × 0.2 = 1 − 0.06 = 0.94
Result: Cases × 0.94 (6% reduction)
```

**For optimal-value drivers** (temperature):
- Suitability function: `suit(v) = 1 − |v − opt| / 12` (peaked at 27°C, ±12°C range)
- If temperature moves away from 27°C, suit decreases → fewer mosquitoes → lower cases
- Temperature too hot (>40°C) or too cold (<15°C) → suppresses transmission

### 5.2 Combined Multiplier (Simulator.jsx:46–53)

```javascript
const multiplier = useMemo(() => {
  let m = 1
  for (const id of Object.keys(drivers.meta)) {
    const base = baselines?.[id]?.base ?? 0
    m *= factor(drivers.meta[id], vals[id] ?? base, base)
  }
  return Math.max(0.1, Math.min(4, m))
}, [vals, baselines, drivers.meta])
```

**Effect combination**: **Multiplicative**
```
multiplier = factor_llin × factor_act × factor_rdt × factor_rain × factor_temp × factor_hum × ...
final_forecast = base_forecast × multiplier
```

**Example: Two interventions**
- LLIN +50% → factor 0.92 (4% case reduction)
- ACT +30% → factor 0.96 (4% case reduction)
- Combined: 0.92 × 0.96 = 0.8832 → **11.7% cases averted** (not 4% + 4%, multiplicative!)

---

## 6. UI Workflow (Simulator.jsx)

### 6.1 Location Selection
```
Level dropdown:
├─ "Nigeria (national)"
│   └─ Loads drivers.national, case forecast national
├─ <State name>
│   ├─ Loads drivers.states[state]
│   ├─ Loads case forecast for state
│   └─ "LGA (optional)" sub-dropdown
│       └─ Loads drivers.lgas["State|||LGA"], case forecast per LGA
```

### 6.2 Lever Categories (cat)
Drivers grouped by category for readability:
- **Vector Control**: LLIN, U5 LLIN coverage
- **Treatment & Diagnostics**: ACT, RDT, fever-RDT rate
- **Environmental**: Rainfall, temperature, humidity

### 6.3 Quick Scenario Buttons
```javascript
"Scale-up interventions" → multiplier 1.4
  For each driver:
    if good === 'down' (protective): new_val = baseline × 1.4
    if good === 'up' (risk): new_val = baseline × (2 − 1.4) = baseline × 0.6

"Funding cut" → multiplier 0.7
  For each driver:
    if good === 'down': new_val = baseline × 0.7
    if good === 'up': new_val = baseline × 1.3

"Reset to baseline" → all levers back to forecasted baseline value
```

### 6.4 Driver Trajectory Chart
**"Conditional driver outlook"**:
- Shows the chosen driver's own forecast (climatology + trend)
- Why? Educate user: "This is what baseline means — the driver is assumed to follow this path"
- User can override, but seeing the baseline trajectory is context

---

## 7. Data Flow: From drivers.json to UI

### 7.1 drivers.json Structure

```json
{
  "meta": {
    "llin": {"label": "LLINs distributed", "unit": "nets/mo", "cat": "Vector Control", "elasticity": -0.40, "good": "down"},
    "act": {...},
    ...
  },
  "national": {
    "llin": {"base": 2500000, "hist": 2400000, "lo": 0, "hi": 5000000},
    "act": {"base": 1200000, "hist": 1150000, "lo": 0, "hi": 2400000},
    ...
  },
  "states": {
    "Lagos": {
      "llin": {"base": 180000, "hist": 175000, "lo": 0, "hi": 360000},
      ...
    },
    ...
  },
  "lgas": {
    "Lagos|||Ikeja": {...},
    ...
  },
  "national_traj": {
    "llin": [
      {"date": "2024-01", "value": 2400000, "forecast": false},
      {"date": "2024-02", "value": 2410000, "forecast": false},
      ...,
      {"date": "2026-04", "value": 2520000, "forecast": true},
      ...
    ],
    ...
  },
  "state_traj": {
    "Lagos": {
      "llin": [...],
      ...
    },
    ...
  }
}
```

### 7.2 useData Hook (lib.js)

Loads `drivers.json` as part of overall app data:
```javascript
const [data, setData] = useState(null)
useEffect(() => {
  Promise.all([
    fetch(`data/${variant}/national.json`),
    fetch(`data/${variant}/drivers.json`),   // ← Here
    fetch(`data/${variant}/lgas.json`),
    ...
  ]).then(...).catch(...)
}, [variant])
```

### 7.3 React State Management (Simulator.jsx)

```javascript
const [level, setLevel] = useState('National')           // Current location
const [lga, setLga] = useState('')                       // Current LGA (if state selected)
const [vals, setVals] = useState({})                     // Driver values (user-set)
const [driverPick, setDriverPick] = useState('rain')     // Which trajectory to show

// Derived
const { baselines, baseSeries, traj } = useMemo(() => {
  if (level === 'National')
    return { baselines: drivers.national, baseSeries: national, traj: drivers.national_traj }
  if (level === 'State' && lga)
    return { baselines: drivers.lgas[`${level}|||${lga}`], baseSeries: lgaData[key], traj: null }
  else
    return { baselines: drivers.states[level], baseSeries: states[level], traj: drivers.state_traj[level] }
}, [level, lga, drivers, national, states, lgaData])
```

---

## 8. Pre-Computed Case Forecasts

### 8.1 Where They Come From

The Simulator assumes case forecasts are **pre-computed** (not fitted on-the-fly like What-If Lab).

**Files**:
- `forecast_national.csv` → national 2020–2030 monthly case forecast
- `forecast_state.csv` → all states 2020–2030
- `forecast_lga.parquet` → all LGAs 2020–2030
- `lgas.json` → LGA case time series in JSON (for fast UI load)

**How they were generated** (historical; `multimodel_forecast.py`):
```python
# Fit ensemble (RF, XGB, LightGBM) on 2020–2025 data
# Features: DHIS2 + external (NDVI, temp, rainfall, ENSO, elevation, poverty, etc.)
# Forecast to 2026–2030
# Output: point forecast + model ensemble disagreement (pseudo-CI)
```

### 8.2 Simulator Uses Them

```javascript
const merged = useMemo(() => baseSeries.map(d => ({
  date: d.date,
  Baseline: Math.round(d.cases),                         // From pre-computed forecast
  Scenario: d.forecast ? Math.round(d.cases * multiplier) : d.cases,  // Apply multiplier
})), [baseSeries, multiplier])
```

- **Historical rows** (`d.forecast=false`): Show actual reported cases, unmodified
- **Forecast rows** (`d.forecast=true`): Show `d.cases × multiplier`

**Why pre-computed?**
- Speed: No model training on each slider change
- Consistency: All users see same baseline (reproducible)
- Transparency: Baseline forecast is fixed; user only changes drivers, not model

---

## 9. Elasticity Coefficient Sources

### 9.1 Where Do Values Come From?

Elasticities typically derived from:

1. **Observational data**: Linear regression of log(cases) ~ log(driver)
   - E.g., `ln(cases) = a + β × ln(ACT) + ...`
   - β = elasticity (interpreted as % change in cases per 1% change in ACT)

2. **Expert consensus**: WHO, PMI, malaria programs' knowledge
   - E.g., "each additional LLIN distributed prevents ~0.4% of seasonal malaria burden"

3. **Mechanistic simulation**: SEIR model with parameter sweeps
   - E.g., "RDT scale-up from 30% to 60% → reduce transmission by 12%"

### 9.2 Typical Ranges

| Driver | Elasticity | Rationale |
|--------|-----------|-----------|
| LLIN (nets) | −0.30 to −0.50 | Strong protective effect, not 100% coverage → diminishing returns |
| ACT treatment | −0.20 to −0.40 | Effective but limited to confirmed cases; delays treatment reduces effectiveness |
| RDT testing | −0.10 to −0.20 | Indirect (enables ACT); benefits depend on treatment cascade |
| Rainfall | +0.20 to +0.50 | Creates breeding habitat; more rain = more transmission |
| Temperature | Variable | Peaked at 25–28°C; extreme heat/cold suppresses *Anopheles* |
| Humidity | +0.10 to +0.30 | Adult mosquito survival; higher humidity = longer lifespan |

---

## 10. Running & Updating the Simulator

### 10.1 Export drivers.json

```bash
export MAL_VARIANT=after    # or 'before'
python drivers.py
# Output: ui/public/data/after/drivers.json (or before/)
```

### 10.2 Customizing Elasticities

Edit `drivers.py:DRIVER_META`:
```python
DRIVER_META = {
    "act": {
        "col": "ACT Given - Total",
        "elasticity": -0.30,           # ← Change this to -0.25 for weaker effect
        "good": "down",
        ...
    },
    ...
}
python drivers.py  # Regenerate JSON
```

### 10.3 Adding New Drivers

1. Add entry to `DRIVER_META` with correct column name from parquet
2. Set elasticity, unit, category
3. Run `python drivers.py`

**Example: Add IPTp (ANC-based intervention)**
```python
DRIVER_META = {
    ...,
    "iptp": {
        "col": "IPTp1 Coverage (institutional)",   # Must exist in agg_lga_pop.parquet
        "label": "IPTp-1 coverage",
        "unit": "%",
        "agg": "mean",
        "cat": "Prevention (pregnancy)",
        "elasticity": -0.20,
        "good": "down",
        "cap": 100,   # Percentage can't exceed 100%
    }
}
```

---

## 11. Limitations & Comparison to What-If Lab

### 11.1 Simulator Limitations

1. **Fixed elasticity**: Assumes same slope everywhere (national elasticity = state = LGA)
   - Reality: Effect might differ by context (malaria burden, healthcare capacity)
   
2. **No exogenous uncertainty**: Driver forecasts are point estimates (climatology + trend)
   - Reality: Climate has natural variability; rainfall 2026 could be much wetter/drier
   
3. **Limited to 8 drivers**: Can't add novel features on the fly
   - Reality: User might want to model bed nets + education campaign + IRS together
   
4. **No uncertainty on intervention**: User sets ACT to exact value; no distribution
   - Reality: Implementation has variability; not all planned nets reach households

### 11.2 Why Both Exist?

- **Simulator**: Fast, reproducible, location-flexible (national/state/LGA), good for planning workshops
- **Lab**: Flexible (any covariates), accounts for data-driven interactions, budget-aware, slower

---

## 12. Technical Implementation Details

### 12.1 Elasticity Math

**General elasticity formula**:
```
Elasticity_x = (% change in output) / (% change in input)
            = (ΔY/Y) / (ΔX/X)
            = (ΔY/ΔX) × (X/Y)
```

**In our case**:
```
ε = (ΔCases / ΔDriver) × (Driver_base / Cases_base)

Rearranging:
ΔCases = ε × Cases_base × (ΔDriver / Driver_base)
       = Cases_base × ε × frac_change_driver
       = Cases_base × (1 + ε × frac_change)  [if ε constant]

So: Cases_new = Cases_base × (1 + ε × frac_change)
    factor = (1 + ε × frac_change)
```

This is exactly what the `factor()` function computes.

### 12.2 Slider Range Determination

```python
# In drivers.py:loc_drivers()
if meta["unit"] == "°C":
    lo, hi = round(base - 5, 1), round(base + 5, 1)
elif meta["unit"] == "%":
    lo, hi = 0.0, float(meta.get("cap", 100))
else:
    # Counts (nets, doses, tests):
    # 0 to 2× max observed (gives reasonable scenario space without being too permissive)
    lo, hi = 0.0, round(max(base * 2.0, hist * 2.0, 1), 1)
```

**Rationale**:
- **Temperature**: ±5°C is plausible climate variation
- **Percentages**: 0–100% (natural bounds)
- **Counts**: 0 to 2× current level (doubling ambition is challenging but not impossible)

---

## 13. Example Scenario: National Level

**Setup**: Nigeria national, What-If Scenario Simulator

**Baseline (from drivers.json):**
```
LLIN: 2.5M nets/month
ACT: 1.2M doses/month
RDT: 1.5M tests/month
Rainfall: 120 mm/month (climatological)
Temperature: 26.5°C (climatological)
Humidity: 72% (climatological)
```

**Forecast (pre-computed ensemble):**
- 2026 Q1 (dry season): 1.8M cases/month
- 2026 Q2–Q3 (rainy): 3.2M cases/month

**User Action: "Scale-up interventions"**

```
Multiplier 1.4 applied to protective drivers:
  LLIN: 2.5M × 1.4 = 3.5M nets
  ACT: 1.2M × 1.4 = 1.68M doses
  RDT: 1.5M × 1.4 = 2.1M tests

Multiplier 0.6 applied to risk drivers:
  Rainfall: 120 × 0.6 = 72 mm (drier assumptions)
  Temperature: 26.5 × (2 − 1.4) = 15.9°C (colder – unrealistic, but slider allows it)
  Humidity: 72 × 0.6 = 43% (much drier)
```

**Factor computation:**

```
frac_llin = (3.5M − 2.5M) / 2.5M = 0.4
factor_llin = 1 + (−0.40) × 0.4 = 0.84

frac_act = (1.68M − 1.2M) / 1.2M = 0.4
factor_act = 1 + (−0.30) × 0.4 = 0.88

frac_rain = (72 − 120) / 120 = −0.4
factor_rain = 1 + (0.30) × (−0.4) = 0.88

frac_hum = (43 − 72) / 72 = −0.403
factor_hum = 1 + (0.18) × (−0.403) = 0.927

factor_temp = suit(15.9°C) / suit(26.5°C) ≈ 0.8 / 1.0 = 0.8 [colder temps suppresses]

multiplier = 0.84 × 0.88 × 0.88 × 0.927 × 0.8 ≈ 0.50
```

**Result**:
```
Baseline 2026 Q2: 3.2M cases/month
Scenario 2026 Q2: 3.2M × 0.50 = 1.6M cases/month
Cases averted: 1.6M (50% reduction)
```

**UI Display**:
```
Scenario cases · 2026–28: 38M (baseline 76M)
Cases averted: 38M (×0.50 vs baseline)
```

---

## 14. JSON Manifest

### 14.1 Complete drivers.json Example (Excerpt)

```json
{
  "meta": {
    "llin": {
      "label": "LLINs distributed",
      "unit": "nets/mo",
      "cat": "Vector Control",
      "elasticity": -0.4,
      "good": "down",
      "col": "LLIN given – Total"
    },
    "temp": {
      "label": "Mean temperature",
      "unit": "°C",
      "cat": "Environmental",
      "elasticity": -0.06,
      "good": "opt",
      "optimum": 27,
      "col": "temperature_mean_c"
    }
  },
  "national": {
    "llin": {
      "base": 2500000,
      "hist": 2400000,
      "lo": 0,
      "hi": 5000000
    },
    "act": {
      "base": 1200000,
      "hist": 1150000,
      "lo": 0,
      "hi": 2400000
    }
  },
  "states": {
    "Lagos": {
      "llin": {"base": 180000, "hist": 175000, "lo": 0, "hi": 360000},
      "act": {"base": 95000, "hist": 92000, "lo": 0, "hi": 190000}
    }
  },
  "national_traj": {
    "llin": [
      {"date": "2024-01", "value": 2400000, "forecast": false},
      {"date": "2026-04", "value": 2520000, "forecast": true},
      {"date": "2026-05", "value": 2530000, "forecast": true}
    ],
    "temp": [
      {"date": "2024-01", "value": 26.1, "forecast": false},
      {"date": "2026-06", "value": 26.8, "forecast": true}
    ]
  }
}
```

---

## 15. Appendix: Full Elasticity Coefficient Estimation (Conceptual)

If you were to **re-fit** elasticities (not just use defaults):

```python
# Pseudo-code: estimate elasticity from observational data
import statsmodels.api as sm

# Panel data: (location, month) → cases, drivers
data = df[['state', 'month', 'cases', 'llin', 'act', 'rainfall', ...]].copy()
data['log_cases'] = np.log(data['cases'] + 1)
data['log_llin'] = np.log(data['llin'] + 1)

# Fixed effects model: log(cases) ~ log(llin) + ...
# (controls for unobserved state/month effects)
model = sm.OLS(
    data['log_cases'],
    sm.add_constant(data[['log_llin', 'log_act', 'log_rainfall', ...]])
)
result = model.fit()

# Coefficient on log_llin = elasticity
elasticity_llin = result.params['log_llin']  # e.g., −0.42

# Report with 95% CI
print(f"LLIN elasticity: {elasticity_llin:.3f} [{result.conf_int()[0, 'log_llin']:.3f}, {result.conf_int()[1, 'log_llin']:.3f}]")
```

In practice, these analyses are done separately (not in this codebase) and manually entered into `DRIVER_META`.

---

## 16. Summary

**What-If Scenario Simulator** is:
- ✅ Fast (instant; pre-computed)
- ✅ Interpretable (elasticity sliders are transparent)
- ✅ Multi-level (national, state, LGA)
- ✅ Driver-trajectory aware (shows baseline forecast for context)
- ❌ Not data-adaptable (fixed 8 drivers)
- ❌ Not budget-integrated
- ❌ No covariate flexibility

**Complementary to What-If Lab** (SARIMAX), which is:
- ✅ Flexible (any covariates)
- ✅ Budget-aware (Groq integration)
- ✅ Data-driven (fits to latest data)
- ❌ Slower (~10s per run)
- ❌ National/State only (no LGA)
- ❌ Requires backend API

Both serve different use cases in the platform.
