"""
Global recursive gradient-boosting forecaster for monthly confirmed malaria
cases at LGA level (774 LGAs across Nigeria).

Design (leakage-free forecasting):
  - Target            : log1p(confirmed cases)
  - Predictors        : target lags (1,2,3,12), rolling means/std, seasonal
                        harmonics + month, trend, log-population, weather
                        (rainfall/temp/humidity/solar incl. 1-month lag),
                        and a train-only LGA/state historical level encoding.
  - NO contemporaneous operational counts (RDT/ACT/total reported) -> those are
    co-determined with the target and unknown for future months.
  - Model             : XGBoost (non-linear), log-target.
  - Validation        : train 2023-01..2025-12, recursively predict 2026 Q1
                        (the only out-of-sample months with actuals).
  - Forecast          : recursive monthly to 2028-12, feeding predictions back
                        as lags; future weather = per-LGA monthly climatology.
  - Baseline          : seasonal-naive (same month prior year) for comparison.

Outputs: forecast_lga.parquet/csv, forecast_state.csv, forecast_national.csv,
         model_metrics.json, feature_importance.csv, malaria_xgb.json
"""
import pandas as pd, numpy as np, json, warnings
import xgboost as xgb
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from population_data import state_population
warnings.filterwarnings("ignore")

TARGET = "MAL - Malaria cases confirmed (number)"
WEATHER = ["rainfall_mm_day", "temperature_mean_c", "humidity_pct", "solar_kwh_m2_day"]
TRAIN_END = 2025 * 12 + 11      # 2025-12
VAL_MONTHS = [2026 * 12 + 0, 2026 * 12 + 1, 2026 * 12 + 2]  # 2026 Q1
FC_END = 2028 * 12 + 11         # 2028-12

# ---------------------------------------------------------------- load + panel
df = pd.read_parquet("agg_lga_pop.parquet")
df = df[df.year.between(2023, 2026)].copy()
df["ym"] = df.year * 12 + (df.month - 1)
keys = ["state", "lga"]

# facility share (for future population projection)
_fac = df.groupby(keys)["n_facilities"].max().reset_index()
_stot = _fac.groupby("state")["n_facilities"].transform("sum")
_fac["fac_share"] = _fac["n_facilities"] / _stot
fac_share = _fac[["state", "lga", "fac_share"]]

# climatology weather per LGA-month (2023-2025 actuals)
clim = (df[df.ym <= TRAIN_END].groupby(keys + ["month"])[WEATHER].mean().reset_index())

# build complete LGA x month panel from 2023-01 .. 2028-12
lgas = df[keys].drop_duplicates().reset_index(drop=True)
months = list(range(2023 * 12, FC_END + 1))
panel = lgas.merge(pd.DataFrame({"ym": months}), how="cross")
panel["year"] = panel.ym // 12
panel["month"] = panel.ym % 12 + 1

# bring actual cases + weather where available
panel = panel.merge(df[keys + ["ym", TARGET] + WEATHER], on=keys + ["ym"], how="left")
panel = panel.rename(columns={TARGET: "cases"})
panel = panel.merge(fac_share, on=keys, how="left")

# fill future weather with climatology
panel = panel.merge(clim, on=keys + ["month"], how="left", suffixes=("", "_clim"))
for w in WEATHER:
    panel[w] = panel[w].fillna(panel[w + "_clim"])
    panel.drop(columns=[w + "_clim"], inplace=True)
    # any remaining gaps -> global month mean
    panel[w] = panel.groupby("month")[w].transform(lambda s: s.fillna(s.mean()))

# population per LGA-year (projected)
panel["state_pop"] = [state_population(s, y) for s, y in zip(panel["state"], panel["year"])]
panel["population"] = panel["state_pop"] * panel["fac_share"].fillna(panel["fac_share"].mean())
panel["log_pop"] = np.log1p(panel["population"])

# train-only LGA & state level encodings (mean log1p cases over train window)
tr = panel[(panel.ym <= TRAIN_END) & panel["cases"].notna()].copy()
tr["logc"] = np.log1p(tr["cases"].clip(lower=0))
lga_enc = tr.groupby(keys)["logc"].mean().rename("lga_level")
state_enc = tr.groupby("state")["logc"].mean().rename("state_level")
glob_level = tr["logc"].mean()
panel = panel.merge(lga_enc, on=keys, how="left").merge(state_enc, on="state", how="left")
panel["lga_level"] = panel["lga_level"].fillna(glob_level)
panel["state_level"] = panel["state_level"].fillna(glob_level)

panel = panel.sort_values(keys + ["ym"]).reset_index(drop=True)

# seasonal-naive baseline (same month last year)
panel["snaive"] = panel.groupby(keys)["cases"].shift(12)

FEATURES = ["lag1", "lag2", "lag3", "lag12", "roll3", "roll6", "roll12", "roll3_std",
            "mom_sin", "mom_cos", "mom_sin2", "mom_cos2", "month", "trend",
            "log_pop", "lga_level", "state_level",
            "rainfall_mm_day", "temperature_mean_c", "humidity_pct", "solar_kwh_m2_day",
            "rain_lag1", "temp_lag1"]


def build_features(p):
    """Compute lag/rolling/seasonal features from current 'logc' values."""
    p = p.copy()
    p["logc"] = np.log1p(p["cases"].clip(lower=0))
    g = p.groupby(keys)["logc"]
    p["lag1"] = g.shift(1); p["lag2"] = g.shift(2); p["lag3"] = g.shift(3); p["lag12"] = g.shift(12)
    gl = p.groupby(keys)["lag1"]
    p["roll3"] = gl.transform(lambda s: s.rolling(3, min_periods=1).mean())
    p["roll6"] = gl.transform(lambda s: s.rolling(6, min_periods=1).mean())
    p["roll12"] = gl.transform(lambda s: s.rolling(12, min_periods=1).mean())
    p["roll3_std"] = gl.transform(lambda s: s.rolling(3, min_periods=2).std())
    m = p["month"]
    p["mom_sin"] = np.sin(2 * np.pi * m / 12); p["mom_cos"] = np.cos(2 * np.pi * m / 12)
    p["mom_sin2"] = np.sin(4 * np.pi * m / 12); p["mom_cos2"] = np.cos(4 * np.pi * m / 12)
    p["trend"] = p["ym"] - 2023 * 12
    gw = p.groupby(keys)
    p["rain_lag1"] = gw["rainfall_mm_day"].shift(1)
    p["temp_lag1"] = gw["temperature_mean_c"].shift(1)
    return p


PARAMS = dict(n_estimators=700, max_depth=6, learning_rate=0.03,
              subsample=0.85, colsample_bytree=0.8, min_child_weight=5,
              reg_lambda=1.5, reg_alpha=0.2, objective="reg:squarederror",
              tree_method="hist", random_state=42, n_jobs=0)


def fit_model(train_df):
    X = train_df[FEATURES]; y = np.log1p(train_df["cases"].clip(lower=0))
    model = xgb.XGBRegressor(**PARAMS)
    model.fit(X, y)
    return model


def metrics(actual, pred, label):
    a, p = np.asarray(actual, float), np.asarray(pred, float)
    mask = ~np.isnan(a) & ~np.isnan(p)
    a, p = a[mask], p[mask]
    mae = mean_absolute_error(a, p)
    rmse = np.sqrt(mean_squared_error(a, p))
    nz = a > 0
    mape = float(np.mean(np.abs((a[nz] - p[nz]) / a[nz])) * 100) if nz.any() else None
    r2 = r2_score(a, p) if len(a) > 1 else None
    return {"label": label, "n": int(len(a)), "MAE": round(mae, 1),
            "RMSE": round(rmse, 1), "MAPE_%": round(mape, 1) if mape else None,
            "R2": round(float(r2), 4) if r2 is not None else None}


# ============================ STEP 1: validation on 2026 Q1 ====================
feat = build_features(panel)
train = feat[(feat.ym <= TRAIN_END) & feat["cases"].notna()].dropna(subset=["lag12"]).copy()
val_model = fit_model(train)

# recursive prediction for validation months
work = panel.copy()
val_rows = []
for vm in VAL_MONTHS:
    fwork = build_features(work)
    rows = fwork[fwork.ym == vm].copy()
    pred = np.expm1(val_model.predict(rows[FEATURES])).clip(min=0)
    rows["pred"] = pred
    val_rows.append(rows[keys + ["ym", "year", "month", "cases", "pred", "snaive"]])
    # do NOT overwrite actuals for validation (we have them); keep actuals as lag source
val_df = pd.concat(val_rows)

m_xgb = metrics(val_df["cases"], val_df["pred"], "XGBoost LGA-level 2026Q1")
m_base = metrics(val_df["cases"], val_df["snaive"], "Seasonal-naive LGA-level 2026Q1")
# national aggregate validation
natv = val_df.groupby("ym").agg(actual=("cases", "sum"), pred=("pred", "sum"),
                                snaive=("snaive", "sum")).reset_index()
m_nat = metrics(natv["actual"], natv["pred"], "XGBoost national 2026Q1")
m_nat_b = metrics(natv["actual"], natv["snaive"], "Seasonal-naive national 2026Q1")
print("VALIDATION (2026 Q1):")
for mm in [m_xgb, m_base, m_nat, m_nat_b]:
    print(" ", mm)
print("\nNational 2026Q1 actual vs pred:")
print(natv.round(0).to_string(index=False))

# ============================ STEP 2: final fit + recursive forecast ===========
feat_all = build_features(panel)
train_all = feat_all[(feat_all.ym <= VAL_MONTHS[-1]) & feat_all["cases"].notna()].dropna(subset=["lag12"]).copy()
final_model = fit_model(train_all)

work = panel.copy()
future_start = VAL_MONTHS[-1] + 1  # 2026-04
for fm in range(future_start, FC_END + 1):
    fwork = build_features(work)
    rows = fwork[fwork.ym == fm]
    pred = np.expm1(final_model.predict(rows[FEATURES])).clip(min=0)
    work.loc[work.ym == fm, "cases"] = pred

# assemble output: actual where known, forecast where predicted
out = work[keys + ["ym", "year", "month", "cases", "population"]].copy()
out["is_forecast"] = out["ym"] > VAL_MONTHS[-1]
out = out.rename(columns={"cases": "cases_pred"})
# attach true actuals
act = panel[keys + ["ym"]].copy()
act = act.merge(df[keys + ["ym", TARGET]], on=keys + ["ym"], how="left").rename(columns={TARGET: "cases_actual"})
out = out.merge(act, on=keys + ["ym"], how="left")
out["cases"] = np.where(out["is_forecast"], out["cases_pred"], out["cases_actual"])
out.to_parquet("forecast_lga.parquet", index=False)
out.to_csv("forecast_lga.csv", index=False)

# state + national rollups
st = out.groupby(["state", "ym", "year", "month", "is_forecast"], as_index=False).agg(
    cases=("cases", "sum"), cases_pred=("cases_pred", "sum"),
    cases_actual=("cases_actual", "sum"), population=("population", "sum"))
st.to_csv("forecast_state.csv", index=False)
nat = out.groupby(["ym", "year", "month", "is_forecast"], as_index=False).agg(
    cases=("cases", "sum"), population=("population", "sum"))
nat.to_csv("forecast_national.csv", index=False)

print("\nNATIONAL ANNUAL (actual 2023-25, forecast 2026-28):")
ann = out.groupby("year")["cases"].sum()
print(ann.round(0).to_string())

# feature importance
fi = pd.DataFrame({"feature": FEATURES, "importance": final_model.feature_importances_})
fi = fi.sort_values("importance", ascending=False)
fi.to_csv("feature_importance.csv", index=False)
print("\nTOP FEATURES:")
print(fi.head(12).to_string(index=False))

final_model.save_model("malaria_xgb.json")
with open("model_metrics.json", "w") as f:
    json.dump({"validation": [m_xgb, m_base, m_nat, m_nat_b],
               "national_q1": natv.round(1).to_dict(orient="records"),
               "national_annual": {int(k): float(v) for k, v in ann.items()},
               "features": FEATURES,
               "train_window": "2023-01..2025-12 (val), ..2026-03 (final)",
               "n_lgas": int(out.groupby(keys).ngroups)}, f, indent=2)
print("\nSaved forecast_lga/state/national, model_metrics.json, feature_importance.csv")
