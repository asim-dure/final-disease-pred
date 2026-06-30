"""
Model Lab data builder (run AFTER model_suite.py).

1. Per-LGA time-series predictions for the held-out 2026 Q1
   (Seasonal-Naive, Holt-Winters/ETS, SARIMAX) so the Deep Learning & Time-Series
   and Actual-vs-Forecast tabs work at LGA / state / national level.
2. Merges them with the ML + DL + Ensemble per-LGA predictions dumped by
   model_suite (avp_ml_dl.json) into ui/public/data/avp.json — every model,
   aggregatable to any geography client-side.
3. Builds the hotspot-share trajectory to 2030 (ui/public/data/hotspots.json).
"""
import json, warnings, time, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.holtwinters import ExponentialSmoothing

import os as _os
OUT = f"ui/public/data/{_os.environ.get('MAL_VARIANT','after')}"; _os.makedirs(OUT, exist_ok=True)
TARGET = "MAL - Malaria cases confirmed (number)"
VAL_YMS = [2026 * 12 + 0, 2026 * 12 + 1, 2026 * 12 + 2]
HIST_YMS = list(range(2023 * 12, VAL_YMS[-1] + 1))         # 2023-01 .. 2026-03
TRAIN_YMS = list(range(2023 * 12, 2025 * 12 + 12))         # 2023-01 .. 2025-12
dates = [f"{m//12}-{m%12+1:02d}" for m in HIST_YMS]
test_dates = [f"{m//12}-{m%12+1:02d}" for m in VAL_YMS]
t0 = time.time()

lga = pd.read_parquet("agg_lga_pop.parquet")
lga["ym"] = lga.year * 12 + lga.month - 1
lga["key"] = lga["state"] + "|||" + lga["lga"]

# actual monthly per LGA (train + test)
piv = lga.pivot_table(index="key", columns="ym", values=TARGET, aggfunc="sum")
actual_lga = {k: [int(round(v)) if pd.notna(v) else None for v in piv.reindex(columns=HIST_YMS).loc[k].values]
              for k in piv.index}

# ---- per-LGA time-series predictions for 2026 Q1 ----
# Conditional SARIMAX-X / ARIMAX use forecast-able drivers as exogenous regressors
# (testing volume, treatment volume, rainfall, temperature); the 2026 Q1 exog is the
# observed value of those drivers, so the time-series models are no longer univariate.
import ts_util
ALL_YMS = TRAIN_YMS + VAL_YMS
exog_mats = {}
for col, agg in ts_util.EXOG_COLS:
    if col in lga.columns:
        exog_mats[col] = lga.pivot_table(index="key", columns="ym", values=col,
                                          aggfunc=("sum" if agg == "sum" else "mean")).reindex(columns=ALL_YMS)
train_mat = piv.reindex(columns=TRAIN_YMS)
snaive, ets, sarimax, arimax = {}, {}, {}, {}
n = 0
for k in piv.index:
    s = train_mat.loc[k].astype(float).fillna(0.0).values
    y = pd.Series(s, index=TRAIN_YMS)
    exog = pd.DataFrame({c: exog_mats[c].loc[k].values for c in exog_mats}, index=ALL_YMS)
    sn = piv.reindex(columns=[m - 12 for m in VAL_YMS]).loc[k].astype(float).fillna(0.0).values
    snaive[k] = [int(round(max(0, x))) for x in sn]
    try:
        fc = ExponentialSmoothing(s, trend="add", seasonal="add", seasonal_periods=12).fit().forecast(3)
        ets[k] = [int(round(max(0, x))) for x in fc]
    except Exception:
        ets[k] = snaive[k]
    sx = ts_util.fit_forecast(y, exog, VAL_YMS, (1, 1, 1), (1, 1, 0, 12))
    sarimax[k] = [int(round(max(0, x))) for x in sx] if sx is not None else ets[k]
    ax = ts_util.fit_forecast(y, exog, VAL_YMS, (2, 1, 2), (0, 0, 0, 0))
    arimax[k] = [int(round(max(0, x))) for x in ax] if ax is not None else sarimax[k]
    n += 1
    if n % 150 == 0:
        print(f"  TS fit {n}/{len(piv.index)}  {time.time()-t0:.0f}s", flush=True)
print(f"per-LGA TS done {time.time()-t0:.0f}s", flush=True)

# ---- merge with ML/DL/Ensemble predictions ----
mldl = json.load(open("avp_ml_dl.json"))
models_meta, pred_lga = [], {}
for nm, blk in mldl["models"].items():
    models_meta.append({"name": nm, "kind": blk["kind"]})
    pred_lga[nm] = blk["lga"]
for nm, d, kind in [("Seasonal Naive", snaive, "Time Series"),
                    ("Holt-Winters (ETS)", ets, "Time Series"),
                    ("SARIMAX-X (conditional)", sarimax, "Time Series"),
                    ("ARIMAX (conditional)", arimax, "Time Series")]:
    models_meta.append({"name": nm, "kind": kind})
    pred_lga[nm] = d

# order: ML, DL, Ensemble, Time Series
order = {"Machine Learning": 0, "Deep Learning": 1, "Ensemble": 2, "Time Series": 3}
models_meta.sort(key=lambda m: (order[m["kind"]], m["name"]))

avp = {"dates": dates, "test_dates": test_dates, "models": models_meta,
       "actual_lga": actual_lga, "pred_lga": pred_lga}
json.dump(avp, open(f"{OUT}/avp.json", "w"), allow_nan=False)
import os
print(f"avp.json {os.path.getsize(OUT+'/avp.json')//1024} KB · {len(models_meta)} models", flush=True)

# ---- hotspot trajectory to 2030 ----
lb = json.load(open("model_leaderboard.json"))
thr = lb["classification"]["label_threshold_inc_per_1000"]
fc = pd.read_parquet("forecast_lga.parquet")
fc["key"] = fc["state"] + "|||" + fc["lga"]
fc["inc"] = fc["cases"] / fc["population"] * 1000
fc["hot"] = (fc["inc"] >= thr).astype(int)
total_lgas = fc["key"].nunique()

def traj(df):
    g = df.groupby("ym").agg(count=("hot", "sum"), tot=("hot", "size"),
                             year=("year", "first"), month=("month", "first"),
                             isf=("is_forecast", "first")).reset_index()
    return [{"date": f"{int(r.year)}-{int(r.month):02d}", "count": int(r.count),
             "share": round(r.count / r.tot * 100, 1), "forecast": bool(r.isf)}
            for r in g.itertuples()]

hot = {"threshold": thr, "total_lgas": int(total_lgas),
       "national": traj(fc), "states": {s: traj(g) for s, g in fc.groupby("state")}}
json.dump(hot, open(f"{OUT}/hotspots.json", "w"), allow_nan=False)
print(f"hotspots.json done · threshold={thr}/1000 · {len(hot['national'])} months to 2030", flush=True)
print(f"TOTAL {time.time()-t0:.0f}s", flush=True)
