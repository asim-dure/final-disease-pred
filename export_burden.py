"""
Export MONTHLY per-LGA and per-state indicator inputs for the 5-zone hotspot
burden score. Stored as per-field arrays aligned to a shared month index so the
frontend can scrub through time and watch hotspots rise in the rainy season.

Window:
  • Actual  : 2024-01 .. 2025-12 (weather + cases both present)  -> forecast=false
  • Forecast: 2026-01 .. 2026-12 via calendar-month climatology  -> forecast=true

The burden math + percentile blend + zones are computed client-side so they react
live to the What-If levers. Output: ui/public/data/<before|after>/burden.json
"""
import re, json, os
import numpy as np
import pandas as pd

MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
df = pd.read_parquet("agg_lga_pop.parquet")

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())
COLS = {norm(c): c for c in df.columns}
def col(name):
    c = COLS.get(norm(name))
    return df[c] if c is not None else pd.Series(0.0, index=df.index)

FIELD = {
    "cases":   "MAL - Malaria cases confirmed (number)",
    "total":   "MAL - Total reported malaria cases (confirmed + presumed)",
    "rdt_done":"MAL - Malaria cases tested with RDT",
    "rdt_pos": "Number of malaria positive cases by rapid diagnostic test (RDT)",
    "act":     "ACT Given - Total",
    "treated": "Anti-Malarial treatment",
    "itn":     "Access to an ITN",
    "llin":    "LLIN given – Total",
    "ipt_cov": "IPTp1 Coverage (institutional)",
    "rain":    "rainfall_mm_day",
    "temp":    "temperature_mean_c",
    "hum":     "humidity_pct",
}
FIELDS = list(FIELD)                      # order matters (arrays align to this)
COUNT  = ["cases","total","rdt_done","rdt_pos","act","treated","itn","llin"]
RATE   = ["ipt_cov","rain","temp","hum"]

# rain/temp/hum only have real readings for 2023-2025 — 2020-2022 and 2026 are
# entirely missing in the source (weather grid doesn't cover those years yet).
# Filling that gap with 0 would make "no data" look like "0mm of rain", which
# silently drags every month's seasonal climatology down by ~3x once averaged
# in below. Leave them as NaN so groupby().mean() skips the missing years —
# same approach drivers.py already uses for the Simulator's driver model.
ENV_FIELDS = {"rain", "temp", "hum"}

w = df[["state","lga","year","month"]].copy()
for f, c in FIELD.items():
    raw = pd.to_numeric(col(c), errors="coerce")
    if f == "ipt_cov":
        # source column is meant to be a 0-100% coverage rate, but has bad
        # outliers up to ~1e8 in the raw DHIS2 export — clip to a sane range
        raw = raw.clip(lower=0, upper=100)
    w[f] = raw if f in ENV_FIELDS else raw.fillna(0.0)
w["ym"] = w.year * 12 + w.month - 1

# rdt_pos / treated / itn are present as columns but are entirely zero across
# the whole dataset (not collected) — flag this so the frontend can fall back
# to a neutral assumption instead of treating "0" as a real measured value.
FLAGS = {
    "no_rdt_pos": bool((w["rdt_pos"] == 0).all()),
    "no_treated": bool((w["treated"] == 0).all()),
    "no_itn":     bool((w["itn"] == 0).all()),
}

# ── month windows ────────────────────────────────────────────────────────────
ACTUAL = [2024*12 + m for m in range(0, 24)]      # 2024-01 .. 2025-12
FCAST  = [2026*12 + m for m in range(0, 12)]      # 2026-01 .. 2026-12
ALLYM  = ACTUAL + FCAST
def ymlabel(ym): return f"{MONTH_ABBR[ym % 12]} {ym // 12}"
MONTHS = [{"ym": f"{ym//12}-{ym%12+1:02d}", "label": ymlabel(ym), "forecast": ym in FCAST} for ym in ALLYM]

def rnd(f, v):
    if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))): return 0
    return int(round(v)) if f in COUNT else round(float(v), 2)

def series_for(panel):
    """panel: monthly frame for ONE area, indexed by ym, with FIELDS columns.
       Returns {field: [values aligned to ACTUAL+FCAST]} incl. climatology forecast + rolling trend."""
    p = panel.reindex(ACTUAL)                          # actual window rows
    # calendar-month climatology from actual window
    clim = {}
    cm = panel.copy(); cm["cal"] = [ym % 12 for ym in cm.index]
    for f in FIELDS:
        clim[f] = cm.groupby("cal")[f].mean()
    out = {}
    for f in FIELDS:
        vals = []
        for ym in ALLYM:
            if ym in ACTUAL:
                v = p.at[ym, f] if ym in p.index else np.nan
                if np.isnan(v): v = clim[f].get(ym % 12, 0.0)
            else:
                v = clim[f].get(ym % 12, 0.0)           # forecast = climatology
            vals.append(rnd(f, v))
        out[f] = vals
    # rolling 3-vs-3 trend on cases across full timeline
    cseries = pd.Series({ym: (panel.at[ym, "cases"] if ym in panel.index else np.nan) for ym in ALLYM}).astype(float)
    # fill forecast cases with climatology already in out['cases']
    cfull = pd.Series(out["cases"], index=ALLYM).astype(float)
    tr = []
    for i, ym in enumerate(ALLYM):
        if i < 6:
            tr.append(0.0); continue
        recent = cfull.iloc[i-2:i+1].mean()
        prior = cfull.iloc[i-5:i-2].mean()
        tr.append(round(float(np.clip((recent-prior)/prior, -1, 3)), 3) if prior > 0 else (1.0 if recent > 0 else 0.0))
    out["trend"] = tr
    return out

# ── per-LGA ──────────────────────────────────────────────────────────────────
lgas = {}
for (st, lg), g in w.groupby(["state", "lga"]):
    panel = g.groupby("ym")[FIELDS].mean()             # one row per month
    lgas[f"{st}|||{lg}"] = series_for(panel)

# ── per-state (counts summed across LGAs per month, rates mean) ───────────────
states = {}
for st, g in w.groupby("state"):
    gm = g.groupby("ym")
    panel = pd.DataFrame({**{f: gm[f].sum() for f in COUNT}, **{f: gm[f].mean() for f in RATE}})
    states[st] = series_for(panel)

payload = {"months": MONTHS, "fields": FIELDS + ["trend"], "lgas": lgas, "states": states, "flags": FLAGS,
           "note": "monthly indicator inputs; burden score + percentile blend computed client-side"}

for variant in ["after", "before"]:
    d = f"ui/public/data/{variant}"
    if os.path.isdir(d):
        json.dump(payload, open(f"{d}/burden.json", "w"), allow_nan=False)
        print(f"wrote {d}/burden.json  ({round(os.path.getsize(d+'/burden.json')/1024)} KB)")

print(f"\nmonths: {MONTHS[0]['label']} … {MONTHS[-1]['label']}  ({len(MONTHS)} = {len(ACTUAL)} actual + {len(FCAST)} forecast)")
# rainy-season sanity: national mean rain by month index
nat_rain = [np.mean([states[s]['rain'][i] for s in states]) for i in range(len(ALLYM))]
peak = int(np.argmax(nat_rain[:24]))
print(f"actual rain peaks at {MONTHS[peak]['label']} ({nat_rain[peak]:.1f} mm/day)")
