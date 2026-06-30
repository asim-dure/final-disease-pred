"""
Actual-vs-predicted export for the Model Lab.

Refits the ensemble champion (top-3: XGBoost + Extra Trees + Random Forest) on
the COMPLETE 2023-2025 training window and recursively predicts the held-out
2026 Q1 (Jan/Feb/Mar) — the only out-of-sample months with actuals. For every
location (national / each state / each LGA) we export:
  - the monthly ACTUAL series 2023-01 .. 2026-03 (train + test),
  - the ensemble PREDICTION for the 3 test months,
  - per-location test metrics (MAE / RMSE / MAPE).

Output: ui/public/data/avp.json
"""
import json, numpy as np, pandas as pd
import features as F
from features import KEYS, FEATURES, VAL_MONTHS, TRAIN_END
from metrics_util import reg_metrics
import xgboost as xgb
from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor

panel = F.load_panel()
hist_months = list(range(2023 * 12, VAL_MONTHS[-1] + 1))          # 2023-01 .. 2026-03
dates = [f"{m//12}-{m%12+1:02d}" for m in hist_months]
test_dates = [f"{m//12}-{m%12+1:02d}" for m in VAL_MONTHS]

# capture actuals BEFORE any recursion overwrite
actual_panel = panel[panel.ym.isin(hist_months)][KEYS + ["ym", "cases"]].copy()

# fit ensemble on full training window
feat = F.build_features(panel)
train = feat[(feat.ym <= TRAIN_END) & feat["cases"].notna()].dropna(subset=["lag12"]).copy()
X, y = train[FEATURES].fillna(0.0), np.log1p(train["cases"].clip(lower=0))
models = [
    xgb.XGBRegressor(n_estimators=700, max_depth=6, learning_rate=0.03, subsample=0.85,
                     colsample_bytree=0.8, min_child_weight=5, reg_lambda=1.5, reg_alpha=0.2,
                     tree_method="hist", random_state=42, n_jobs=0),
    ExtraTreesRegressor(n_estimators=200, max_depth=16, n_jobs=-1, random_state=42),
    RandomForestRegressor(n_estimators=200, max_depth=14, n_jobs=-1, random_state=42),
]
for m in models:
    m.fit(X, y)

# recursive ensemble prediction for 2026 Q1 (predictions feed forward as lags)
work = panel.copy()
pred_rows = []
for vm in VAL_MONTHS:
    fw = F.build_features(work)
    rows = fw[fw.ym == vm]
    p = np.mean([np.expm1(m.predict(rows[FEATURES].fillna(0.0))).clip(min=0) for m in models], axis=0)
    work.loc[work.ym == vm, "cases"] = p
    pred_rows.append(rows[KEYS].assign(ym=vm, pred=p))
pred = pd.concat(pred_rows)

# ----- assemble per-location series -----
def series_for(actual_sub, pred_sub):
    a = actual_sub.groupby("ym")["cases"].sum().reindex(hist_months)
    pr = pred_sub.groupby("ym")["pred"].sum().reindex(VAL_MONTHS)
    actual_arr = [None if pd.isna(v) else int(round(v)) for v in a.values]
    pred_arr = [None if pd.isna(v) else int(round(v)) for v in pr.values]
    av = a.reindex(VAL_MONTHS).values
    met = reg_metrics(av, pr.values)
    return {"actual": actual_arr, "pred": pred_arr,
            "metrics": {"MAE": met["MAE_L1"], "RMSE": met["RMSE"], "MAPE": met["MAPE_pct"]}}

out = {"dates": dates, "test_dates": test_dates,
       "members": ["XGBoost", "Extra Trees", "Random Forest"],
       "national": series_for(actual_panel, pred),
       "states": {}, "lgas": {}}

for s, asub in actual_panel.groupby("state"):
    psub = pred[pred.state == s]
    out["states"][s] = series_for(asub, psub)

pred_idx = pred.set_index(KEYS)
for (s, l), asub in actual_panel.groupby(KEYS):
    try:
        psub = pred[(pred.state == s) & (pred.lga == l)]
    except Exception:
        psub = pred.iloc[0:0]
    out["lgas"][f"{s}|||{l}"] = series_for(asub, psub)

json.dump(out, open("ui/public/data/avp.json", "w"), allow_nan=False)
import os
print("avp.json", round(os.path.getsize("ui/public/data/avp.json") / 1024), "KB")
print("National test metrics:", out["national"]["metrics"])
print("National Q1 actual vs pred:", out["national"]["actual"][-3:], "vs", out["national"]["pred"])
