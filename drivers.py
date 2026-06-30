"""
Conditional-forecasting driver layer.

For every location (national / state / LGA) we:
  1. measure each driver's recent baseline (last 12 reported months),
  2. FORECAST the driver forward to 2028 (monthly climatology + damped annual
     trend) — this is the "forecast the driver too" step that gives the What-If
     levers a *forecasted* baseline rather than a fixed zero,
  3. derive a sensible slider range.

Output: ui/public/data/drivers.json
"""
import pandas as pd, numpy as np, json, os
from features import DRIVERS  # name -> short id

OUT = f"ui/public/data/{os.environ.get('MAL_VARIANT','after')}"; os.makedirs(OUT, exist_ok=True)
FC_YEARS = [2026, 2027, 2028, 2029, 2030]

# Driver display metadata. `agg` = how to combine across LGAs (sum for counts,
# mean for rates/environment). `elasticity` = fractional change in cases per
# +100% change in the driver relative to baseline. Protective drivers negative.
#
# `audience` = the fraction of TOTAL confirmed cases that this driver can
# plausibly influence, for interventions targeted at a subgroup rather than the
# whole population (e.g. under-5 children, pregnant women). Without this, a
# subgroup-only intervention's elasticity gets applied to the *entire* national
# case count, which makes the lever look wildly more powerful than it can
# actually be — moving "Under-5 LLIN coverage" shouldn't be able to swing total
# cases as if it protected every age group. Values are NMEP/WHO-cited Nigeria
# epidemiological shares (under-5 ≈ 35% of confirmed cases; pregnant women ≈ 8%)
# since the dataset has no per-LGA age/group case breakdown to derive them from
# directly. Drivers with no `audience` key are assumed population-wide (=1).
DRIVER_META = {
    "llin":  {"col": "LLIN given – Total",                   "label": "LLINs distributed",        "unit": "nets/mo", "agg": "sum",  "cat": "Vector Control",          "elasticity": -0.40, "good": "down"},
    "u5llin":{"col": "% Under 5 receiving LLIN",             "label": "Under-5 LLIN coverage",    "unit": "%",       "agg": "mean", "cat": "Vector Control",          "elasticity": -0.30, "good": "down", "cap": 100, "audience": 0.35, "audience_label": "under-5 children (~35% of confirmed cases)"},
    "act":   {"col": "ACT Given - Total",                    "label": "ACT treatment courses",    "unit": "/mo",     "agg": "sum",  "cat": "Treatment & Diagnostics", "elasticity": -0.30, "good": "down"},
    "treat": {"col": "% of Persons Clinically diagnosed with Malaria treated with ACT", "label": "Diagnosed patients treated with ACT", "unit": "%", "agg": "mean", "cat": "Treatment & Diagnostics", "elasticity": -0.18, "good": "down", "cap": 100},
    "rdt":   {"col": "MAL - Malaria cases tested with RDT",  "label": "RDT tests performed",      "unit": "/mo",     "agg": "sum",  "cat": "Treatment & Diagnostics", "elasticity": -0.12, "good": "down"},
    "fevrdt":{"col": "% of Fever cases Tested with RDT",     "label": "Fever-case RDT testing",   "unit": "%",       "agg": "mean", "cat": "Treatment & Diagnostics", "elasticity": -0.15, "good": "down", "cap": 100},
    "iptp":  {"col": "IPTp1 Coverage (institutional)",        "label": "IPTp coverage (pregnant women)", "unit": "%", "agg": "mean", "cat": "Maternal & Child Health", "elasticity": -0.20, "good": "down", "cap": 100, "audience": 0.08, "audience_label": "pregnant women (~8% of confirmed cases)"},
    "rain":  {"col": "rainfall_mm_day",                      "label": "Rainfall",                 "unit": "mm/d",    "agg": "mean", "cat": "Environmental",           "elasticity": 0.30,  "good": "up"},
    "temp":  {"col": "temperature_mean_c",                   "label": "Mean temperature",         "unit": "°C",      "agg": "mean", "cat": "Environmental",           "elasticity": -0.06, "good": "opt", "optimum": 27},
    "hum":   {"col": "humidity_pct",                         "label": "Relative humidity",        "unit": "%",       "agg": "mean", "cat": "Environmental",           "elasticity": 0.18,  "good": "up", "cap": 100},
}

df = pd.read_parquet("agg_lga_pop.parquet")
df["ym"] = df.year * 12 + df.month - 1
LAST = 2026 * 12 + 2          # 2026-03 last actual
recent12 = list(range(LAST - 11, LAST + 1))


def forecast_driver(series_by_ym):
    """series_by_ym: dict ym->value (actuals). Return monthly climatology + damped
    annual trend forecast for 2026-2028, plus the forecast-horizon mean."""
    s = pd.Series(series_by_ym).dropna()
    if s.empty:
        return {}, np.nan
    months = (s.index % 12) + 1
    clim = s.groupby(months).mean()
    overall = s.mean()
    # damped annual trend from yearly means
    yrs = (s.index // 12)
    ann = s.groupby(yrs).mean()
    if len(ann) >= 2:
        x = np.array(ann.index, float); y = ann.values
        slope = np.polyfit(x, y, 1)[0] * 0.4   # damp
    else:
        slope = 0.0
    base_year = max(yrs)
    traj = {}
    for yr in FC_YEARS:
        for m in range(1, 13):
            ym = yr * 12 + m - 1
            if ym <= LAST:   # keep actuals where present
                continue
            base = clim.get(m, overall)
            traj[ym] = float(max(0.0, base + slope * (yr - base_year)))
    fc_mean = float(np.mean(list(traj.values()))) if traj else overall
    return traj, fc_mean


def loc_drivers(sub):
    """Compute baseline + forecast per driver for an aggregated sub-frame."""
    out = {}
    for did, meta in DRIVER_META.items():
        col = meta["col"]
        if col not in sub.columns:
            continue
        # clip percentage-type columns BEFORE aggregating — some raw DHIS2 rows
        # have absurd outliers (e.g. IPTp coverage up to ~1e8 instead of 0-100),
        # which would otherwise drag the whole monthly mean far past the cap.
        s = sub[col].clip(lower=0, upper=meta["cap"]) if "cap" in meta else sub[col]
        g = s.groupby(sub["ym"]).sum() if meta["agg"] == "sum" else s.groupby(sub["ym"]).mean()
        hist = float(g.reindex(recent12).mean()) if not g.empty else np.nan
        traj, fc_mean = forecast_driver(g.to_dict())
        if np.isnan(hist) and not np.isnan(fc_mean):
            hist = fc_mean
        base = fc_mean if not np.isnan(fc_mean) else hist
        # slider range
        if meta["unit"] == "°C":
            lo, hi = round(base - 5, 1), round(base + 5, 1)
        elif meta["unit"] == "%":
            lo, hi = 0.0, float(meta.get("cap", 100))
        else:
            lo, hi = 0.0, round(max(base * 2.0, (hist or 0) * 2.0, 1), 1)
        out[did] = {"base": round(float(base), 2), "hist": round(float(hist), 2),
                    "lo": float(lo), "hi": float(hi)}
    return out


# national
nat = loc_drivers(df)
# states
states = {s: loc_drivers(g) for s, g in df.groupby("state")}
# lgas (baseline values only — keep file compact)
lgas = {}
for (s, l), g in df.groupby(["state", "lga"]):
    lgas[f"{s}|||{l}"] = loc_drivers(g)

# national + state driver forecast trajectories (for a driver chart)
def traj_export(sub):
    res = {}
    for did, meta in DRIVER_META.items():
        col = meta["col"]
        if col not in sub.columns: continue
        s = sub[col].clip(lower=0, upper=meta["cap"]) if "cap" in meta else sub[col]
        g = s.groupby(sub["ym"]).sum() if meta["agg"] == "sum" else s.groupby(sub["ym"]).mean()
        traj, _ = forecast_driver(g.to_dict())
        hist = {ym: float(v) for ym, v in g.items() if ym <= LAST and ym >= 2024 * 12}
        merged = {**hist, **traj}
        res[did] = [{"date": f"{ym//12}-{ym%12+1:02d}", "value": round(v, 2),
                     "forecast": ym > LAST} for ym, v in sorted(merged.items())]
    return res

nat_traj = traj_export(df)
state_traj = {s: traj_export(g) for s, g in df.groupby("state")}

meta_export = {did: {k: m[k] for k in ("label", "unit", "cat", "elasticity", "good")} | (
    {"optimum": m["optimum"]} if "optimum" in m else {}) | (
    {"audience": m["audience"], "audience_label": m["audience_label"]} if "audience" in m else {}) | (
    {"col": m["col"]}) for did, m in DRIVER_META.items()}

def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    if isinstance(o, float) and (np.isnan(o) or np.isinf(o)):
        return 0.0
    return o

payload = clean({"meta": meta_export, "national": nat, "states": states, "lgas": lgas,
                 "national_traj": nat_traj, "state_traj": state_traj})
json.dump(payload, open(f"{OUT}/drivers.json", "w"), allow_nan=False)
print("Wrote drivers.json:", round(os.path.getsize(f"{OUT}/drivers.json")/1024), "KB")
print("National baselines:", {k: v["base"] for k, v in nat.items()})
