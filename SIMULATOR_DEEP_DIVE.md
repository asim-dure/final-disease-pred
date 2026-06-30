# What-If Simulator: Complete Deep Dive — Architecture, Logic, Graphs, Tech Stack

---

## 0. Executive Summary

The **What-If Simulator** (🎛️ tab) is a **pre-computed elasticity-based scenario analysis tool** that lets users:
1. Select a location (National | State | LGA)
2. Move 8 driver sliders (ACT, LLIN, rainfall, temperature, etc.)
3. See instant forecast adjustments based on elasticity coefficients
4. Visualize baseline vs scenario cases on an interactive chart

**No ML models are trained on-the-fly.** Everything is pre-computed via `drivers.py`, stored in `drivers.json`, and rendered via React + Recharts.

---

## 1. Complete Tech Stack

### 1.1 Frontend Stack

```
React 18+
├─ Language: JavaScript (JSX)
├─ Build tool: Vite (fast HMR, ES modules)
├─ Charting: Recharts 2.8+ (React wrapper around D3/NivoJS)
├─ Styling: CSS (custom variables, no CSS-in-JS)
├─ State management: React hooks (useState, useMemo, useEffect)
└─ HTTP: Fetch API (built-in browser)

Key libraries in ui/package.json:
- react, react-dom
- recharts (charts)
- vite, @vitejs/plugin-react (build)
```

### 1.2 Backend Stack

```
Python 3.11
├─ Framework: FastAPI (for What-If Lab, not used by Simulator)
├─ Data: pandas, numpy
├─ Statistics: statsmodels (SARIMAX)
├─ Time series: no pre-trained models (all pre-computed)
└─ Output: JSON (drivers.json)

Key script for Simulator:
- drivers.py (generates drivers.json)
```

### 1.3 Data Format

```
drivers.json (pre-computed, 100-500 KB)
├─ meta: elasticity coefficients, units, categories
├─ national: baseline values per driver (national level)
├─ states: baseline values per driver per state (37 states)
├─ lgas: baseline values per driver per LGA (768 LGAs)
├─ national_traj: historical + forecasted driver time series
└─ state_traj: historical + forecasted driver time series per state

JSON structure:
{
  "meta": {
    "act": {"label": "ACT treatment courses", "elasticity": -0.30, "good": "down", "unit": "/mo", "cat": "Treatment & Diagnostics"},
    "llin": {"label": "LLINs distributed", "elasticity": -0.40, "good": "down", "unit": "nets/mo", "cat": "Vector Control"},
    "rain": {"label": "Rainfall", "elasticity": 0.30, "good": "up", "unit": "mm/d", "cat": "Environmental"},
    ...
  },
  "national": {
    "act": {"base": 1216000, "hist": 1175000, "lo": 0, "hi": 2432000},
    "llin": {"base": 2500000, "hist": 2400000, "lo": 0, "hi": 5000000},
    ...
  },
  "states": {
    "Lagos": {
      "act": {"base": 188200, "hist": 175300, "lo": 0, "hi": 376400},
      ...
    },
    ...
  },
  "lgas": {
    "Lagos|||Ikeja": {"act": {"base": 4260, ...}, ...},
    ...
  },
  "national_traj": {
    "act": [
      {"date": "2024-01", "value": 1150000, "forecast": false},
      ...
      {"date": "2026-04", "value": 1216000, "forecast": true},
      ...
    ],
    ...
  },
  "state_traj": { ... }
}
```

---

## 2. How It Was Built: Complete Architecture

### 2.1 Phase 1: Pre-Computation (drivers.py)

**Purpose**: Generate `drivers.json` (one-time, offline computation)

**Executed once**: When you run `python drivers.py`

#### Step 1: Define Driver Metadata

```python
# File: drivers.py (lines 22–31)
DRIVER_META = {
    "llin": {
        "col": "LLIN given – Total",           # Column name in parquet
        "label": "LLINs distributed",          # UI label
        "unit": "nets/mo",                     # Display unit
        "agg": "sum",                          # Aggregation: sum (counts)
        "cat": "Vector Control",               # UI category
        "elasticity": -0.40,                   # COEFFICIENT (key!)
        "good": "down"                         # Semantics (more is better)
    },
    "act": {
        "col": "ACT Given - Total",
        "label": "ACT treatment courses",
        "unit": "/mo",
        "agg": "sum",
        "cat": "Treatment & Diagnostics",
        "elasticity": -0.30,                   # ACT: 30% weaker than LLIN
        "good": "down"
    },
    "rain": {
        "col": "rainfall_mm_day",
        "label": "Rainfall",
        "unit": "mm/d",
        "agg": "mean",                         # Aggregation: mean (rates/environment)
        "cat": "Environmental",
        "elasticity": 0.30,                    # POSITIVE (risk driver)
        "good": "up"                           # More rain = worse
    },
    "temp": {
        "col": "temperature_mean_c",
        "label": "Mean temperature",
        "unit": "°C",
        "agg": "mean",
        "cat": "Environmental",
        "elasticity": -0.06,
        "good": "opt",                         # Optimal (peaked function)
        "optimum": 27                          # Best at 27°C
    },
    # ... 3 more drivers (hum, u5llin, rdt, fevrdt)
}
```

**Key insight**: Elasticity is the **only** parameter users can't change — it's baked in by expert consensus or observational analysis.

#### Step 2: Aggregate Data to Each Level

```python
# File: drivers.py (lines 69–93)
def loc_drivers(sub):
    """Compute baseline + forecast per driver for one location (national/state/LGA)"""
    out = {}
    for did, meta in DRIVER_META.items():
        col = meta["col"]
        
        # 1. AGGREGATE
        if meta["agg"] == "sum":
            g = sub.groupby("ym")[col].sum()      # Sum across all LGAs
        else:
            g = sub.groupby("ym")[col].mean()     # Mean across all LGAs
        
        if "cap" in meta:
            g = g.clip(upper=meta["cap"])         # Cap percentages at 100%
        
        # 2. MEASURE BASELINE (last 12 months)
        hist = float(g.reindex(recent12).mean()) if not g.empty else np.nan
        
        # 3. FORECAST DRIVER FORWARD (climatology + trend)
        traj, fc_mean = forecast_driver(g.to_dict())
        
        if np.isnan(hist) and not np.isnan(fc_mean):
            hist = fc_mean
        base = fc_mean if not np.isnan(fc_mean) else hist
        
        # 4. DETERMINE SLIDER RANGE
        if meta["unit"] == "°C":
            lo, hi = round(base - 5, 1), round(base + 5, 1)
        elif meta["unit"] == "%":
            lo, hi = 0.0, float(meta.get("cap", 100))
        else:
            lo, hi = 0.0, round(max(base * 2.0, hist * 2.0, 1), 1)
        
        # 5. RETURN
        out[did] = {
            "base": round(float(base), 2),
            "hist": round(float(hist), 2),
            "lo": float(lo),
            "hi": float(hi)
        }
    return out

# Call for each level
nat = loc_drivers(df)                              # National
states = {s: loc_drivers(g) for s, g in df.groupby("state")}  # States
lgas = {f"{s}|||{l}": loc_drivers(g) for (s, l), g in df.groupby(["state", "lga"])}  # LGAs
```

#### Step 3: Forecast Each Driver Forward

```python
# File: drivers.py (lines 39–66)
def forecast_driver(series_by_ym):
    """
    Forecast driver using climatology + damped annual trend.
    
    Input: dict of {year-month: value}
    Output: dict of {future_ym: forecasted_value}
    """
    s = pd.Series(series_by_ym).dropna()
    
    if s.empty:
        return {}, np.nan
    
    # 1. CLIMATOLOGY (monthly average)
    months = (s.index % 12) + 1
    clim = s.groupby(months).mean()        # {1: Jan_avg, 2: Feb_avg, ..., 12: Dec_avg}
    overall = s.mean()
    
    # 2. ANNUAL TREND (damped)
    yrs = (s.index // 12)
    ann = s.groupby(yrs).mean()            # {2020: 0.85M, 2021: 0.92M, ..., 2025: 1.30M}
    
    if len(ann) >= 2:
        x = np.array(ann.index, float)
        y = ann.values
        slope = np.polyfit(x, y, 1)[0] * 0.4   # Fit line, then × 0.4 (damping)
    else:
        slope = 0.0
    
    base_year = max(yrs)
    
    # 3. FORECAST (climatology + damped trend)
    traj = {}
    for yr in [2026, 2027, 2028, 2029, 2030]:
        for m in range(1, 13):
            ym = yr * 12 + m - 1
            
            if ym <= LAST:
                continue
            
            base = clim.get(m, overall)
            traj[ym] = float(max(0.0, base + slope * (yr - base_year)))
    
    fc_mean = float(np.mean(list(traj.values()))) if traj else overall
    
    return traj, fc_mean
```

**Example: ACT at National Level**

```
Historical time series:
  2020: 0.85M/yr
  2021: 0.92M/yr
  2022: 1.05M/yr
  2023: 1.15M/yr
  2024: 1.25M/yr
  2025: 1.30M/yr
  Slope: (1.30 - 0.85) / 5 yrs = +90k/yr
  Damped: +90k × 0.4 = +36k/yr

Climatology by month:
  Jan: 1.10M
  Feb: 1.12M
  ...
  Apr: 1.20M (post-dry, pre-rainy season high)
  ...
  Dec: 0.95M

Forecast for 2026-04:
  Base (climatology): 1.20M
  Trend (damped): +36k × (2026 - 2025) = +36k
  Result: 1.236M ≈ 1.216M (rounded in drivers.json)
  Slider range: [0, 1.216M × 2] = [0, 2.432M]
```

#### Step 4: Export to JSON

```python
# File: drivers.py (lines 127–139)
payload = clean({
    "meta": meta_export,
    "national": nat,
    "states": states,
    "lgas": lgas,
    "national_traj": nat_traj,
    "state_traj": state_traj
})

json.dump(payload, open(f"{OUT}/drivers.json", "w"), allow_nan=False)
# Output: ui/public/data/after/drivers.json (or before/)
```

---

### 2.2 Phase 2: Frontend Rendering (Simulator.jsx)

**File**: `ui/src/views/Simulator.jsx` (180 lines)

**Purpose**: Load drivers.json, render UI, handle interactions, compute multiplier, update chart

#### Component Structure

```javascript
// File: ui/src/views/Simulator.jsx (lines 18–180)

export default function Simulator({ data, variant = 'after' }) {
  const { national, states, geo, drivers } = data    // Loaded via useData() hook
  const stateNames = useMemo(() => Object.keys(geo).sort(), [geo])
  
  // ─── STATE ───
  const [level, setLevel] = useState('National')     // Current location
  const [lga, setLga] = useState('')                 // Current LGA
  const [vals, setVals] = useState({})               // Current driver values
  const [lgaData, setLgaData] = useState(null)       // LGA case time series
  const [driverPick, setDriverPick] = useState('rain') // Which trajectory to show
  
  // ─── EFFECT: Load LGA data on variant change ───
  useEffect(() => {
    setLgaData(null)
    loadLgas(variant).then(setLgaData)              // Async load lgas.json
  }, [variant])
  
  // ─── EFFECT: Reset levers on location change ───
  useEffect(() => {
    if (baselines) {
      setVals(Object.fromEntries(
        Object.keys(drivers.meta).map(id => [id, baselines[id]?.base ?? 0])
      ))
    }
  }, [baselines, drivers.meta])
  
  // ─── RESOLVED BASELINES FOR CURRENT LOCATION ───
  const { baselines, baseSeries, traj, locLabel } = useMemo(() => {
    if (level === 'National') {
      return {
        baselines: drivers.national,        // From drivers.json
        baseSeries: national,               // From national.json (pre-computed cases)
        traj: drivers.national_traj,        // Driver trajectories
        locLabel: 'Nigeria (national)'
      }
    }
    if (lga && lgaData) {
      const key = `${level}|||${lga}`
      const series = (lgaData[key] || []).map(s => ({
        date: s.d,
        cases: s.c,
        forecast: !!s.f
      }))
      return {
        baselines: drivers.lgas[key] || drivers.states[level],
        baseSeries: series,
        traj: null,
        locLabel: `${lga}, ${level}`
      }
    }
    return {
      baselines: drivers.states[level],
      baseSeries: states[level] || [],
      traj: drivers.state_traj[level],
      locLabel: level
    }
  }, [level, lga, lgaData, drivers, national, states])
  
  // ─── COMPUTE MULTIPLIER ───
  const multiplier = useMemo(() => {
    let m = 1
    for (const id of Object.keys(drivers.meta)) {
      const base = baselines?.[id]?.base ?? 0
      m *= factor(drivers.meta[id], vals[id] ?? base, base)  // ← KEY FUNCTION
    }
    return Math.max(0.1, Math.min(4, m))           // Clamp to [0.1, 4]
  }, [vals, baselines, drivers.meta])
  
  // ─── CHART DATA ───
  const merged = useMemo(() =>
    baseSeries.map(d => ({
      date: d.date,
      Baseline: Math.round(d.cases),
      Scenario: d.forecast ? Math.round(d.cases * multiplier) : Math.round(d.cases)
    })),
    [baseSeries, multiplier]
  )
  
  // ─── IMPACT KPIs ───
  const fc = baseSeries.filter(d => d.forecast)
  const baseTotal = fc.reduce((a, b) => a + b.cases, 0)
  const scenTotal = baseTotal * multiplier
  const averted = baseTotal - scenTotal
  
  // ─── QUICK SCENARIOS ───
  const reset = () => setVals(...)
  const setScenario = (mult) => setVals(v => {
    const nv = { ...v }
    for (const id of Object.keys(drivers.meta)) {
      const meta = drivers.meta[id], b = baselines[id]?.base ?? 0
      if (meta.good === 'down') nv[id] = Math.min(baselines[id].hi, b * mult)  // Scale up
      else if (meta.good === 'up') nv[id] = Math.max(baselines[id].lo, b * (2 - mult))  // Scale down
    }
    return nv
  })
  
  return (
    <>
      {/* UI: controls, levers, chart, trajectory */}
    </>
  )
}
```

---

## 3. The Core Formula: Elasticity & Multiplier

### 3.1 Elasticity Definition

```
Elasticity (ε) = (% change in output) / (% change in input)
                = (ΔY / Y_base) / (ΔX / X_base)
```

**Example: ACT elasticity = −0.30**
```
If ACT increases by 10%:
  ε = −0.30
  Impact on cases = 10% × (−0.30) = −3% (3% reduction)

If ACT increases by 100% (doubles):
  Impact on cases = 100% × (−0.30) = −30%
```

### 3.2 Factor Function (Simulator.jsx:6–16)

```javascript
function factor(meta, val, base) {
  // Compute multiplicative effect on cases from driver change
  
  // SPECIAL CASE: Optimal value (temperature)
  if (meta.good === 'opt') {
    const opt = meta.optimum ?? 27              // Optimal is 27°C
    const suit = v => 1 - Math.min(1, Math.abs(v - opt) / 12)
    // suit = suitability; peaked at 27°C, = 0 at 15°C or 39°C
    
    const sb = Math.max(0.05, suit(base))       // Baseline suitability
    return Math.max(0.2, Math.min(2, suit(val) / sb))
    // ratio of suitabilities, clamped to [0.2, 2]
  }
  
  // LINEAR ELASTICITY CASE
  if (!base || base <= 0) return 1               // No baseline = no effect
  
  const frac = (val - base) / base               // Fractional change
  return Math.max(0.2, Math.min(3, 1 + meta.elasticity * frac))
  //     ↑ clamp    ↑ formula
}
```

**Derivation of formula**:

```
ε = (ΔY / Y_base) / (ΔX / X_base)

Rearrange for Y_new:
  ΔY / Y_base = ε × (ΔX / X_base)
  ΔY = ε × Y_base × (ΔX / X_base)
  Y_new = Y_base + ε × Y_base × (X_new - X_base) / X_base
  Y_new = Y_base × (1 + ε × (X_new - X_base) / X_base)
  Y_new = Y_base × (1 + ε × frac)

So: factor = (Y_new / Y_base) = 1 + ε × frac
```

### 3.3 Examples

**Example 1: ACT scale-up by 30%**
```
Base ACT: 1.0M doses/month
New ACT: 1.3M doses/month
frac = (1.3M - 1.0M) / 1.0M = 0.3
Elasticity: −0.30
factor = 1 + (−0.30) × 0.3 = 0.91
Cases multiplied by 0.91 → 9% reduction
```

**Example 2: LLIN scale-up by 50%**
```
Base LLIN: 2.5M nets/month
New LLIN: 3.75M nets/month
frac = (3.75M - 2.5M) / 2.5M = 0.5
Elasticity: −0.40
factor = 1 + (−0.40) × 0.5 = 0.8
Cases multiplied by 0.8 → 20% reduction
```

**Example 3: Rainfall increase by 20% (risk driver)**
```
Base rainfall: 100 mm/day
New rainfall: 120 mm/day
frac = (120 - 100) / 100 = 0.2
Elasticity: +0.30 (positive = risk)
factor = 1 + 0.30 × 0.2 = 1.06
Cases multiplied by 1.06 → 6% increase (more cases)
```

**Example 4: Temperature at optimum (27°C)**
```
Optimum: 27°C
Baseline: 27°C → suit(27) = 1 - |27 - 27| / 12 = 1.0
New: 30°C → suit(30) = 1 - |30 - 27| / 12 = 0.75
factor = 0.75 / 1.0 = 0.75 → cases reduced (too hot suppresses mosquitoes)
```

### 3.4 Combined Multiplier

```javascript
// Simulator.jsx:46–53
const multiplier = useMemo(() => {
  let m = 1
  for (const id of Object.keys(drivers.meta)) {
    const base = baselines?.[id]?.base ?? 0
    m *= factor(drivers.meta[id], vals[id] ?? base, base)
  }
  return Math.max(0.1, Math.min(4, m))
}, [vals, baselines, drivers.meta])
```

**All drivers are MULTIPLICATIVE**:
```
multiplier = factor_act × factor_llin × factor_rain × factor_temp × factor_hum × ...

Example:
  factor_act = 0.91 (ACT +30%)
  factor_llin = 0.80 (LLIN +50%)
  factor_rain = 1.06 (Rainfall +20%)
  multiplier = 0.91 × 0.80 × 1.06 = 0.77
  → Cases reduced by 23% (multiplicative, not additive)
```

---

## 4. Charting: Recharts Library

### 4.1 Recharts Overview

**Library**: Recharts (React components wrapping D3)

**Why Recharts?**
- ✅ Built for React (component-based, state-driven)
- ✅ Responsive (auto-scales to container)
- ✅ Customizable (colors, grid, tooltips)
- ✅ No D3 boilerplate (higher-level API)
- ✅ Small bundle (~50 KB gzipped)

**Homepage**: https://recharts.org/

### 4.2 CompareChart Component (components.jsx:94–112)

```javascript
export function CompareChart({ data, series, height = 320, unit, splitDate, splitLabel = 'Forecast →' }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        
        {/* Grid background */}
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        
        {/* Axes */}
        <XAxis dataKey="date" {...axPr} tickFormatter={monthLabel} minTickGap={32} />
        <YAxis {...axPr} tickFormatter={fmt} width={48} />
        
        {/* Tooltip (hover popup) */}
        <Tooltip content={<ChartTT unit={unit} />} />
        
        {/* Optional: vertical reference line marking forecast start */}
        {splitDate && <ReferenceLine x={splitDate} stroke="rgba(217,119,6,.55)" strokeDasharray="4 4"
          label={{ value: splitLabel, fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />}
        
        {/* Legend */}
        <Legend wrapperStyle={{ fontSize: '.78rem', color: '#3c5366' }} />
        
        {/* Multiple line series (user-selected) */}
        {series.map(s => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color}
            strokeWidth={2.2} strokeDasharray={s.dashed ? '6 4' : undefined} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
```

**Key Recharts concepts**:
- `ResponsiveContainer`: Scales to parent width, fixed height
- `LineChart`: Root component accepting data array
- `CartesianGrid`: Background grid lines
- `XAxis/YAxis`: Axis configuration (labels, ticks)
- `Tooltip`: Hover popup content
- `Line`: One series per line (dataKey = column name in data)
- `stroke`, `strokeWidth`, `strokeDasharray`: Line styling
- `connectNulls`: Connect across missing data

### 4.3 Data Structure for Chart

```javascript
// Input: baseSeries (pre-computed case time series)
baseSeries = [
  { date: "2024-01", cases: 1800000, forecast: false },
  { date: "2024-02", cases: 1850000, forecast: false },
  ...
  { date: "2026-04", cases: 2100000, forecast: true },  // Last actual
  { date: "2026-05", cases: 2150000, forecast: true },  // Forecasted
  ...
]

// Transform to chart data
merged = baseSeries.map(d => ({
  date: d.date,
  Baseline: Math.round(d.cases),                         // Historical or forecast baseline
  Scenario: d.forecast
    ? Math.round(d.cases * multiplier)                   // Apply multiplier to forecast
    : Math.round(d.cases)                                // Keep history as-is
}))

// Output
merged = [
  { date: "2024-01", Baseline: 1800000, Scenario: 1800000 },
  ...
  { date: "2026-04", Baseline: 2100000, Scenario: 1932000 }, // If multiplier = 0.92
  ...
]

// Pass to CompareChart
<CompareChart
  data={merged}
  series={[
    { key: 'Baseline', name: 'Baseline forecast', color: COLORS.accent2, dashed: true },
    { key: 'Scenario', name: 'Scenario', color: multiplier <= 1 ? COLORS.accent : COLORS.coral }
  ]}
  height={270}
/>
```

### 4.4 Tooltip Component (ChartTT)

```javascript
// File: components.jsx (lines 32–45)
const ChartTT = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null
  
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #d7e1e8',
      borderRadius: 10,
      padding: '10px 13px',
      fontSize: '.8rem',
      boxShadow: '0 8px 30px rgba(15,34,48,.12)'
    }}>
      {/* Header: date */}
      <div style={{ color: '#0f2230', fontWeight: 700, marginBottom: 6 }}>
        {monthLabel(label)}  {/* e.g., "Apr '26" */}
      </div>
      
      {/* Body: series values */}
      {payload.map((p, i) => (
        <div key={i} style={{
          color: p.color,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16
        }}>
          <span>{p.name}</span>
          <span className="mono" style={{ fontWeight: 600 }}>
            {fmtFull(p.value)}{unit || ''}  {/* e.g., "2,100,000 cases" */}
          </span>
        </div>
      ))}
    </div>
  )
}
```

**Tooltip usage**:
- Renders on mouse hover
- Recharts calls it with `{active, payload, label}`
- `payload` = array of all series values at that date
- `label` = x-axis value (date in our case)
- `monthLabel()` formats "2026-04" → "Apr '26"
- `fmtFull()` formats numbers with commas (2.1M → "2,100,000")

### 4.5 Color System (lib.js:62–65)

```javascript
export const COLORS = {
  accent: '#0d9488',      // Teal (main brand)
  accent2: '#2563eb',     // Blue (baseline)
  coral: '#e11d48',       // Red (risk)
  amber: '#d97706',       // Orange (forecast/alert)
  violet: '#7c3aed',      // Purple (tertiary)
  green: '#16a34a',       // Green (success/averted)
  grid: 'rgba(15,34,48,0.07)',  // Subtle grid
  axis: '#64798a',        // Dark gray (text)
}
```

**Applied in Simulator**:
```javascript
<CompareChart
  data={merged}
  series={[
    { key: 'Baseline', color: COLORS.accent2, dashed: true },  // Blue, dashed
    { key: 'Scenario', color: multiplier <= 1 ? COLORS.accent : COLORS.coral }
    // Green (teal) if cases ↓, red if cases ↑
  ]}
/>
```

---

## 5. State Management & Reactivity

### 5.1 State Variables

```javascript
const [level, setLevel] = useState('National')
// Current geographic level (national | state | LGA)

const [lga, setLga] = useState('')
// Current LGA name (if state selected)

const [vals, setVals] = useState({})
// Current driver values: { act: 1.2M, llin: 2.5M, rain: 100, ... }
// Initialized to baselines on location change (useEffect)

const [lgaData, setLgaData] = useState(null)
// LGA case time series (async loaded)

const [driverPick, setDriverPick] = useState('rain')
// Which driver to show trajectory for (selector dropdown)
```

### 5.2 Derived State (useMemo)

```javascript
// Resolved baselines + time series for current location
const { baselines, baseSeries, traj, locLabel } = useMemo(() => {
  // Computes which data to use based on level + lga
  // Recomputes only if dependencies change: [level, lga, lgaData, drivers, national, states]
}, [level, lga, lgaData, drivers, national, states])

// Multiplier: combined elasticity effect
const multiplier = useMemo(() => {
  // Computes ∏ factor per driver
  // Recomputes only if vals or baselines change
}, [vals, baselines, drivers.meta])

// Chart data: transformed for Recharts
const merged = useMemo(() => {
  // Maps baseSeries + multiplier → chart format
  // Recomputes only if baseSeries or multiplier change
}, [baseSeries, multiplier])
```

### 5.3 Event Handlers

```javascript
// User moves slider: update vals[id]
onChange={e => setVals(s => ({ ...s, [id]: +e.target.value }))}

// User clicks "Scale-up interventions": multiply protective, divide risk
const setScenario = (mult) => setVals(v => {
  const nv = { ...v }
  for (const id of Object.keys(drivers.meta)) {
    const meta = drivers.meta[id], b = baselines[id]?.base ?? 0
    if (meta.good === 'down') nv[id] = Math.min(baselines[id].hi, b * mult)
    else if (meta.good === 'up') nv[id] = Math.max(baselines[id].lo, b * (2 - mult))
  }
  return nv
})

// User clicks "Reset": return all to baseline
const reset = () => setVals(Object.fromEntries(
  Object.keys(drivers.meta).map(id => [id, baselines[id]?.base ?? 0])
))
```

---

## 6. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      agg_lga_pop.parquet                        │
│  64k rows × 139 cols (DHIS2 + external + derivations)           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ↓
          ┌────────────────────────────────────┐
          │      python drivers.py             │
          │  (Pre-compute, one-time offline)   │
          │                                    │
          │  1. Define DRIVER_META             │
          │  2. Aggregate to national/state    │
          │  3. Forecast each driver           │
          │  4. Export to JSON                 │
          └────────────────────────────────────┘
                           │
                           ↓
        ┌──────────────────────────────────┐
        │   ui/public/data/*/drivers.json  │
        │   (100-500 KB per variant)       │
        └──────────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          │                                 │
          ↓                                 ↓
   ┌─────────────────┐           ┌──────────────────┐
   │  Simulator.jsx  │           │ national.json    │
   │  (React)        │           │ (pre-computed    │
   │                 │           │  case forecast)  │
   │ 1. Load JSON    │           │                  │
   │ 2. Display UI   │           │ {date, cases}    │
   │ 3. Slider       │           │                  │
   │    events       │           └──────────────────┘
   │ 4. Compute      │                   │
   │    multiplier   │                   ↓
   │ 5. Transform    │           ┌──────────────────┐
   │    data         │           │   Recharts       │
   │ 6. Render       │           │   (chart render) │
   │    chart        │           │                  │
   └─────────────────┘           │ baseline line    │
          │                       │ scenario line    │
          │                       └──────────────────┘
          └───────────────────────→ Screen 🖥️
```

---

## 7. Complete User Interaction Flow

### 7.1 Scenario: National ACT Scale-up

**Step 1: User loads platform**
```
→ App.jsx fetches data via useData() hook
→ Loads: national.json, drivers.json, states.json, geo.json
→ Simulator.jsx renders with level='National'
→ UI shows: National dropdown selected, ACT slider at baseline (1.216M)
```

**Step 2: User selects National level**
```
→ setLevel('National')
→ useMemo re-runs, resolves baselines = drivers.national
→ useEffect resets vals to all baselines
→ Chart shows national.json case time series + baseline forecast
```

**Step 3: User slides ACT from 1.216M to 1.58M (+30%)**
```
→ setVals(s => ({ ...s, act: 1.58M }))
→ Re-render with new value displayed: "1,580,000 /mo"
→ multiplier useMemo re-runs:
  factor_act = 1 + (−0.30) × (1.58M - 1.216M) / 1.216M
            = 1 + (−0.30) × 0.3
            = 0.91
  multiplier = 0.91 × 1.0 × ... (other drivers at baseline)
            = 0.91
→ merged useMemo transforms data: Scenario = baseline × 0.91
→ Chart re-renders with new scenario line
→ KPIs update:
  Scenario cases (2026–28): 76M × 0.91 = 69.2M
  Cases averted: 6.8M
```

**Step 4: User moves another slider (rainfall −20%)**
```
→ setVals(s => ({ ...s, rain: 76 mm/day }))  // From 95 baseline
→ factor_rain = 1 + 0.30 × (76 - 95) / 95 = 0.94 (fewer cases)
→ multiplier = 0.91 × 0.94 × ... = 0.86
→ Chart updates: scenario line drops further
→ Cases averted: 76M × (1 - 0.86) = 10.6M
```

**Step 5: User clicks "Scale-up interventions"**
```
→ setScenario(1.4) called
→ For each driver:
  if good === 'down': new_val = baseline × 1.4  // ACT, LLIN, RDT: scale up
  if good === 'up': new_val = baseline × 0.6    // Rain, humidity: scale down
→ ACT: 1.216M × 1.4 = 1.7M
→ LLIN: 2.5M × 1.4 = 3.5M
→ Rain: 95 × 0.6 = 57 mm/day
→ multiplier = 0.84 × 0.78 × 0.81 × ... = 0.52
→ Cases averted: 76M × (1 - 0.52) = 36.5M (52% reduction)
```

**Step 6: User clicks "Reset to baseline"**
```
→ reset() called
→ vals = all baselines again
→ multiplier = 1.0 (no change)
→ Chart back to: baseline = scenario
```

---

## 8. CSS & Styling

### 8.1 Global Styles (styles.css)

```css
/* Design system (CSS variables) */
:root {
  --bg-0: #f4f7fa;           /* Page background */
  --bg-1: #ffffff;           /* Card background */
  --accent: #0d9488;         /* Primary brand (teal) */
  --accent-2: #2563eb;       /* Secondary (blue) */
  --coral: #e11d48;          /* Error/risk (red) */
  --amber: #d97706;          /* Warning/forecast (orange) */
  --txt-0: #0f2230;          /* Heading text */
  --txt-1: #3c5366;          /* Body text */
  --txt-2: #64798a;          /* Muted text */
  --border: #e2e9ef;         /* Border color */
  --glow: 0 6px 24px rgba(15,34,48,0.06);  /* Shadow */
  --r: 16px;                 /* Border radius */
  --font: 'DM Sans', system-ui, sans-serif;
  --mono: 'DM Mono', monospace;
}

/* Card (reusable container) */
.card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 22px;
  box-shadow: var(--glow);
}

/* Slider (range input) */
input[type=range] {
  -webkit-appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--accent) var(--pct, 50%), #dde6ec var(--pct, 50%));
  /* ↑ --pct CSS variable set by JavaScript: --pct: Math.max(0, Math.min(100, p)) + '%' */
}

/* Slider thumb */
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
  box-shadow: 0 0 0 3px var(--accent), 0 1px 4px rgba(0,0,0,.2);
}

/* Lever (driver slider card) */
.lever {
  padding: 13px 0;
  border-bottom: 1px solid var(--border-2);
}

.lever-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.lever-head .name {
  font-size: .85rem;
  font-weight: 600;
  color: var(--txt-0);
}

.lever-head .val {
  font-family: var(--mono);
  font-size: .82rem;
  color: var(--accent);
  font-weight: 500;
}

.lever-base {
  font-size: .68rem;
  color: var(--txt-2);
  margin-top: 3px;
}
```

### 8.2 Dynamic Styling (JavaScript)

```javascript
// Slider gradient: fill changes as user moves
const p = ((v - b.lo) / (b.hi - b.lo || 1)) * 100
<input type="range" ... style={{ '--pct': Math.max(0, Math.min(100, p)) + '%' }} />

// Text color based on impact
style={{
  color: f <= 1 ? COLORS.green : COLORS.coral
  // ↑ Green if factor ≤ 1 (cases ↓), red if > 1 (cases ↑)
}}

// Chart title color
style={{
  color: multiplier <= 1 ? COLORS.green : COLORS.coral
}}
```

---

## 9. Libraries & Dependencies (package.json)

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "recharts": "^2.8.0",        // ← Charts
    "vite": "^4.4.0",            // ← Build tool
    "@vitejs/plugin-react": "^4.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0"
  }
}
```

---

## 10. Performance Optimizations

### 10.1 useMemo Hooks

```javascript
// Prevent unnecessary recomputes
const multiplier = useMemo(() => { ... }, [vals, baselines, drivers.meta])
const merged = useMemo(() => { ... }, [baseSeries, multiplier])
const { baselines, ... } = useMemo(() => { ... }, [level, lga, ...])
```

**Why**: Chart rendering is expensive. Only recompute when inputs change.

### 10.2 Conditional Rendering

```javascript
{level !== 'National' && (
  <div className="select-wrap">
    <label>LGA (optional)</label>
    <select>...</select>
  </div>
)}
```

**Why**: Don't render LGA selector if national is chosen.

### 10.3 JSON Pre-Computation

```
drivers.py runs ONCE offline
→ drivers.json is static, served as static file (no backend needed)
→ No live fitting in Simulator (unlike What-If Lab)
→ Instant load, instant interactions
```

---

## 11. Complete Code Walkthrough: Single Slider Interaction

### 11.1 User moves ACT slider from 1.216M to 1.3M

**HTML Event**:
```html
<input type="range" min="0" max="2432000" value="1216000" 
  onChange={e => setVals(s => ({ ...s, act: +e.target.value }))} />
```

**Step 1: Event Handler**
```javascript
// User drags, browser fires onChange
// e.target.value = "1300000" (string)
setVals(s => ({ ...s, act: 1300000 }))  // Update state
```

**Step 2: State Update Triggers Renders**
```javascript
// React detects vals changed
// Components depending on vals re-render

// Display updated value
<span className="val">{v.toFixed(0)}</span>
// → "1,300,000"
```

**Step 3: Multiplier Recalculation**
```javascript
const multiplier = useMemo(() => {
  let m = 1
  
  // For ACT driver:
  const id = "act"
  const meta = drivers.meta.act     // { elasticity: -0.30, good: "down", ... }
  const base = baselines.act.base   // 1.216M
  const val = vals.act              // 1.3M
  
  const factor_act = factor(meta, val, base)
    // factor(meta, 1.3M, 1.216M)
    // frac = (1.3M - 1.216M) / 1.216M = 0.0691
    // factor = 1 + (-0.30) × 0.0691 = 0.979
  
  m *= factor_act  // m = 1 * 0.979 = 0.979
  
  // For other drivers (at baseline):
  for other drivers:
    const factor_other = factor(meta_other, vals[id] ?? baseline, baseline)
    // Since vals not changed, factor_other = 1.0
    m *= 1.0
  
  return Math.max(0.1, Math.min(4, m))  // 0.979
}, [vals, baselines, drivers.meta])

// Result: multiplier = 0.979
```

**Step 4: Chart Data Transform**
```javascript
const merged = useMemo(() =>
  baseSeries.map(d => ({
    date: d.date,
    Baseline: Math.round(d.cases),
    Scenario: d.forecast
      ? Math.round(d.cases * multiplier)   // Apply 0.979
      : Math.round(d.cases)
  })),
  [baseSeries, multiplier]
)

// Example: 2026-06 (forecast month, baseline cases 3.2M)
{
  date: "2026-06",
  Baseline: 3200000,
  Scenario: Math.round(3200000 * 0.979) = 3132800
}
```

**Step 5: Chart Re-Render**
```javascript
<CompareChart
  data={merged}
  series={[
    { key: 'Baseline', name: 'Baseline forecast', color: '#2563eb', dashed: true },
    { key: 'Scenario', name: 'Scenario', color: '#0d9488' }  // Green (multiplier < 1)
  ]}
  height={270}
/>

// Recharts detects data changed
// Re-renders with new Scenario line (slightly lower than Baseline)
```

**Step 6: KPI Update**
```javascript
const fc = baseSeries.filter(d => d.forecast)
const baseTotal = fc.reduce((a, b) => a + b.cases, 0)     // Sum of forecasted months
const scenTotal = baseTotal * multiplier                   // Apply multiplier
const averted = baseTotal - scenTotal

// Example (12-month forecast, 2026-04 to 2026-12):
baseTotal = 3.2M + 3.5M + 3.8M + ... = 38.5M
scenTotal = 38.5M * 0.979 = 37.7M
averted = 38.5M - 37.7M = 0.8M

// Display:
<div className="big">{fmt(37700000)} cases</div>  // "37.7M"
<div className="big">{fmt(800000)} cases</div>     // "800K"
```

---

## 12. Summary Table: Architecture Components

| Component | Technology | Purpose | File |
|-----------|-----------|---------|------|
| **Pre-computation** | Python, pandas, NumPy | Compute drivers.json offline | `drivers.py` |
| **Elasticity metadata** | JSON | Define DRIVER_META + store in drivers.json | `drivers.py` + `drivers.json` |
| **Frontend framework** | React 18+ | Component-based UI | `Simulator.jsx`, `App.jsx` |
| **State management** | React hooks (useState, useMemo) | Track slider values, location, computed multiplier | `Simulator.jsx` |
| **Charting** | Recharts | Render baseline vs scenario line chart | `components.jsx`, `Simulator.jsx` |
| **Styling** | CSS custom properties (variables) | Design system, sliders, cards | `styles.css` |
| **Build tool** | Vite | Fast HMR, ES modules, dev server | `vite.config.js` |
| **Data serving** | Static JSON files | drivers.json, national.json, states.json, lgas.json | `ui/public/data/` |

---

## 13. Key Formulas Reference Sheet

```
Elasticity (ε) definition:
  ε = (% change in Y) / (% change in X)

Factor formula (derived from elasticity):
  factor = 1 + ε × (X_new - X_base) / X_base

Multiplier (combined effect):
  multiplier = ∏ factor_i for all drivers i

Scenario forecast:
  cases_scenario = cases_baseline × multiplier

Cases averted:
  averted = cases_baseline × (1 - multiplier)

Climatology-based driver forecast:
  driver_forecasted = climatology[month] + damped_trend × (forecast_year - last_year)
  where damped_trend = original_trend × 0.4

Suitability (temperature optimal):
  suit(t) = 1 - min(1, |t - optimum| / 12)
  factor_temp = suit(t_new) / suit(t_baseline)
```

---

## 14. Why This Architecture

### Advantages ✅
- **Speed**: Pre-computed drivers.json → instant UI interactions, no backend needed
- **Transparency**: Users see elasticity coefficients → understand assumptions
- **Scalability**: Works at 3 levels (national/state/LGA) without code changes
- **Offline**: Simulator works entirely client-side (except data load)
- **Responsive**: React + useMemo minimize re-renders; Recharts auto-scales

### Tradeoffs ❌
- **Flexibility**: Fixed 8 drivers; can't add custom covariates on the fly
- **Accuracy**: Elasticities are pre-fitted; can't adapt to location-specific data
- **Updates**: Requires re-running drivers.py to change coefficients
- **No uncertainty**: Pre-computed baseline has no confidence bounds

---

## 15. Future Enhancements

1. **Dynamic elasticities**: Fit location-specific ε coefficients
2. **Uncertainty bands**: Show 95% CI on baseline case forecast
3. **More drivers**: Add 5+ more (IPTp, behavior change, IRS, etc.)
4. **Cascade effects**: Model interdependencies (e.g., more tests → more treatment)
5. **Cost integration**: Link driver changes to budget (like What-If Lab does)

---

**This is the complete architecture, logic, formulas, and tech stack of the What-If Simulator.**

You now have enough knowledge to:
- Modify elasticity coefficients in `drivers.py`
- Add new drivers
- Customize UI styling
- Understand how every interaction flows through the system
- Extend the chart rendering

