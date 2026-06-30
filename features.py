"""
Shared panel construction + feature engineering for all models (ML, DL, TS).

Feature set (as specified):
  - target lags    : lag1, lag2, lag3
  - population      : population (raw persons, no transform)
  - geography       : state, lga  (mean-encoded as state_level / lga_level)
  - time            : year, month
  - ALL malaria programme indicators from the aggregated dataset (115 columns:
    33 SUM counts + 82 MEAN rates/coverage/environment), used at their monthly
    value. Future months (2026-04 .. 2030) are filled with each LGA's monthly
    climatological normal, since the indicators are not yet observed there.

NOTE ON LEAKAGE: several indicators (RDTs performed, ACT given, total reported
cases, positives) are co-determined with the confirmed-case target in the same
month, so in-sample / validation fit is optimistic and the forward forecast leans
on the climatological projection of those indicators. This is intentional per the
project owner's request to use the full indicator panel; metrics are reported as-is.
"""
import re, json, os
import pandas as pd, numpy as np
import pyarrow.parquet as pq
from population_data import state_population

# variant: 'after' adds the WHO/SEIR-derived climate, surveillance & spatial features;
# 'before' is the original 8-base + indicator panel (kept frozen for comparison).
VARIANT = os.environ.get("MAL_VARIANT", "after")
AFTER = VARIANT == "after"

TARGET = "MAL - Malaria cases confirmed (number)"
WEATHER = ["rainfall_mm_day", "temperature_mean_c", "humidity_pct", "solar_kwh_m2_day"]
KEYS = ["state", "lga"]
TRAIN_END = 2025 * 12 + 11          # 2025-12
VAL_MONTHS = [2026 * 12 + 0, 2026 * 12 + 1, 2026 * 12 + 2]   # 2026 Q1 (held out)
FC_END = 2030 * 12 + 11             # 2030-12

# Driver indicators used by the What-If simulator (drivers.py)
DRIVERS = {
    "Access to an ITN": "itn", "Children <5 yrs who received LLIN": "llin",
    "ACT Given - Total": "act", "MAL - Malaria cases tested with RDT": "rdt",
    "IPTp2 Coverage (institutional)": "iptp", "rainfall_mm_day": "rain",
    "temperature_mean_c": "temp", "humidity_pct": "hum",
}

# ---- full indicator panel from the aggregation map (all SUM + MEAN columns) ----
_AGG = "agg_lga_pop.parquet"
_AGG_COLS = set(pq.ParquetFile(_AGG).schema.names)
_MAP = json.load(open("aggregation_map.json", encoding="utf-8"))
_SUM = [c for c in _MAP["sum"] if c in _AGG_COLS and c != TARGET]
_MEAN = [c for c in _MAP["mean"] if c in _AGG_COLS and c != TARGET]
INDICATOR_FEATURES = _SUM + _MEAN                      # 114 programme indicators
_IND_KIND = {**{c: "count" for c in _SUM}, **{c: "rate" for c in _MEAN}}

# REAL external data merged into agg_lga_pop by integrate_external.py (if present):
#   ndvi / ndvi_anom = FEWS NET satellite vegetation index per LGA-month
#   enso_oni / iod_dmi = NOAA Niño-3.4 ONI & Indian Ocean Dipole (national, monthly)
EXTERNAL_COLS = [c for c in ["ndvi", "ndvi_anom", "enso_oni", "iod_dmi",
                             "pfpr", "elevation", "latitude", "pop_density",
                             "poverty_mpi_h", "dep_schooling", "dep_electricity", "dep_water", "dep_housing"]
                 if c in _AGG_COLS]

# ---- AFTER: WHO/SEIR-aligned derived features (computed from existing columns) ----
# Each maps to a step in the malaria transmission chain (climate -> vector/parasite
# biology -> EIR -> intervention -> incidence). Source tag: 'climate' (reanalysis,
# already in dataset), 'seir' (mechanistic proxy), 'dhis2' (from surveillance), 'spatial'.
_TPR = "MAL - Test positivity rate (RDT)"
AFTER_DERIVED = [
    # climate lag structure (rainfall→breeding, temp→sporogony, humidity→survival)
    ("rain_lag1", "Rainfall 1 month ago — breeding-habitat lag (top global predictor)", "climate"),
    ("rain_lag2", "Rainfall 2 months ago — sustained breeding lag", "climate"),
    ("rain_cum3", "3-month cumulative rainfall — sustained habitat availability", "climate"),
    ("rain_anom", "Rainfall anomaly (z-score vs LGA monthly normal) — above-normal breeding", "climate"),
    ("temp_lag1", "Temperature 1 month ago — extrinsic incubation lag", "climate"),
    ("temp_suitability", "Thermal suitability index (Mordecai) — peaks at 25°C, ~0 outside 16–40°C", "seir"),
    ("dtr", "Diurnal temperature range (max−min) — wide range = vector thermal stress", "climate"),
    ("temp_anom", "Temperature anomaly (z-score) — anomalous warming events", "climate"),
    ("hum_lag1", "Humidity 1 month ago — adult-vector survival lag", "climate"),
    # SEIR-derived mechanistic proxies (Ross–Macdonald parameter mappings)
    ("eir_proxy", "Climate-driven EIR proxy = suitability × rainfall × humidity (transmission pressure)", "seir"),
    ("recruitment_proxy", "Mosquito recruitment φ(T,R) = rainfall_lag2 × thermal suitability", "seir"),
    ("mortality_proxy", "Mosquito mortality μᵥ(T) proxy — rises away from 25°C optimum", "seir"),
    ("r0_proxy", "R₀ proxy = test-positivity × case-growth (intrinsic transmission potential)", "seir"),
    # surveillance temporal structure (disease's own history)
    ("tpr_lag1", "Test positivity rate 1 month ago — leading indicator of incidence change", "dhis2"),
    ("lag6", "Confirmed cases 6 months ago (log) — semi-annual pattern", "dhis2"),
    ("lag12", "Confirmed cases 12 months ago (log) — year-on-year", "dhis2"),
    ("roll3", "Rolling 3-month mean of cases (log) — smoothed trend", "dhis2"),
    ("roll6", "Rolling 6-month mean of cases (log) — medium-term trend", "dhis2"),
    ("yoy_change", "Year-over-year change (log ratio) — growth/decline trajectory", "dhis2"),
    # spatial spillover (neighbouring-area transmission)
    ("spatial_lag1", "Spatial lag — state mean log-cases last month (cross-LGA spillover)", "spatial"),
]
# REAL external satellite / climate-index features (only if the data was integrated)
_EXT_DERIVED = []
if "ndvi" in EXTERNAL_COLS:
    _EXT_DERIVED += [
        ("ndvi", "NDVI — FEWS NET satellite vegetation index per LGA (vector habitat: shade, humidity, resting sites)", "satellite"),
        ("ndvi_anom", "NDVI anomaly — % deviation from the LGA's seasonal normal (above-normal greening)", "satellite"),
        ("ndvi_lag1", "NDVI 1 month ago — vegetation→habitat lag (literature lag 2–3 months)", "satellite"),
    ]
if "enso_oni" in EXTERNAL_COLS:
    _EXT_DERIVED.append(("enso_oni", "ENSO — NOAA Niño-3.4 ONI SST anomaly (El Niño → rainfall anomalies, inter-annual)", "climate-index"))
if "iod_dmi" in EXTERNAL_COLS:
    _EXT_DERIVED.append(("iod_dmi", "IOD — Indian Ocean Dipole Mode Index (drives African rainfall anomalies)", "climate-index"))
for _c, _doc, _s in [
    ("pfpr", "Malaria prevalence (PfPR 2-10, Malaria Atlas Project) per LGA — population transmission intensity", "satellite"),
    ("elevation", "Ground elevation (SRTM) at LGA centroid — transmission ceiling above ~1600–2000 m", "satellite"),
    ("latitude", "LGA centroid latitude — Nigeria's north–south transmission gradient", "satellite"),
    ("pop_density", "Population per km² (population ÷ area)", "satellite"),
    ("poverty_mpi_h", "Multidimensional poverty headcount (OPHI/NBS MPI, by state)", "socioeconomic"),
    ("dep_schooling", "Education deprivation rate (MPI, by state)", "socioeconomic"),
    ("dep_electricity", "Electricity-access deprivation rate (MPI, by state)", "socioeconomic"),
    ("dep_water", "Safe-water deprivation rate (MPI, by state)", "socioeconomic"),
    ("dep_housing", "Housing-quality deprivation rate (MPI, by state)", "socioeconomic"),
]:
    if _c in EXTERNAL_COLS:
        _EXT_DERIVED.append((_c, _doc, _s))
AFTER_DERIVED += _EXT_DERIVED
AFTER_DERIVED_NAMES = [n for n, *_ in AFTER_DERIVED]
AFTER_DERIVED_SRC = {n: s for n, _, s in AFTER_DERIVED}

BASE_FEATURES = ["lag1", "lag2", "lag3", "population", "year", "month", "state_level", "lga_level"]
# all candidates considered for selection (8 base + 114 indicators [+ derived if AFTER])
CANDIDATE_FEATURES = BASE_FEATURES + INDICATOR_FEATURES + (AFTER_DERIVED_NAMES if AFTER else [])

# Selected feature subset (best practice): produced by feature_selection.py. The 8
# base features are always kept; the top indicators by importance fill out to K.
# Until selection has run, fall back to the full candidate set.
try:
    _SEL = json.load(open("selected_features.json", encoding="utf-8"))["selected"]
    FEATURES = [f for f in _SEL if f in CANDIDATE_FEATURES] or CANDIDATE_FEATURES
except Exception:
    FEATURES = CANDIDATE_FEATURES

FEATURE_DOC = {
    "lag1": "Confirmed cases 1 month ago (log)",
    "lag2": "Confirmed cases 2 months ago (log)",
    "lag3": "Confirmed cases 3 months ago (log)",
    "population": "Population (persons) — exposure / catchment size (NPC projection, used as-is, no transform)",
    "year": "Calendar year (long-run trend)",
    "month": "Calendar month 1-12 (seasonality)",
    "state_level": "State identity — mean log-cases of the state (train-only encoding)",
    "lga_level": "LGA identity — mean log-cases of the LGA (train-only encoding)",
}
for _c in INDICATOR_FEATURES:
    _k = "monthly count, summed across facilities" if _IND_KIND[_c] == "count" else "monthly rate/%, averaged across facilities"
    FEATURE_DOC[_c] = f"Programme indicator — {_c} ({_k}; future months = seasonal normal)"
for _n, _doc, _src in AFTER_DERIVED:
    FEATURE_DOC[_n] = f"[{_src.upper()}] {_doc}"

# safe (alphanumeric) names so XGBoost/LightGBM don't choke on '[', '<', '%', etc.
def _san(s):
    return re.sub(r"[^0-9a-zA-Z]+", "_", s).strip("_") or "f"


def _safe_names(feats):
    out, seen = [], {}
    for f in feats:
        s = _san(f)
        if s in seen:
            seen[s] += 1; s = f"{s}_{seen[s]}"
        else:
            seen[s] = 0
        out.append(s)
    return out


SAFE_FEATURES = _safe_names(FEATURES)


def Xmat_for(df, feats):
    """Feature matrix for an arbitrary feature list, with model-safe names + NaNs filled."""
    X = df[feats].copy()
    X.columns = _safe_names(feats)
    return X.fillna(0.0)


def Xmat(df):
    """Feature matrix over the SELECTED features (model-safe names, NaNs filled)."""
    return Xmat_for(df, FEATURES)


def load_panel():
    """Complete LGA x month panel (2023-01..2030-12): target, population,
    geography encodings, and the full indicator panel (climatology-filled forward)."""
    df = pd.read_parquet(_AGG)
    df = df[df.year.between(2023, 2026)].copy()
    df["ym"] = df.year * 12 + (df.month - 1)

    _fac = df.groupby(KEYS)["n_facilities"].max().reset_index()
    _fac["fac_share"] = _fac["n_facilities"] / _fac.groupby("state")["n_facilities"].transform("sum")
    fac_share = _fac[["state", "lga", "fac_share"]]

    EXO = list(dict.fromkeys(INDICATOR_FEATURES + (EXTERNAL_COLS if AFTER else [])))  # indicators + real external data
    clim = df[df.ym <= TRAIN_END].groupby(KEYS + ["month"])[EXO].mean().reset_index()

    lgas = df[KEYS].drop_duplicates().reset_index(drop=True)
    months = list(range(2023 * 12, FC_END + 1))
    panel = lgas.merge(pd.DataFrame({"ym": months}), how="cross")
    panel["year"] = panel.ym // 12
    panel["month"] = panel.ym % 12 + 1

    keep = list(dict.fromkeys(KEYS + ["ym", TARGET] + EXO))
    panel = panel.merge(df[[c for c in keep if c in df.columns]], on=KEYS + ["ym"], how="left")
    panel = panel.rename(columns={TARGET: "cases"})
    panel = panel.merge(fac_share, on=KEYS, how="left")

    # Indicators are only genuinely observed through the last actual month (2026-03).
    # The aggregated file carries 0-placeholders for 2026-04..12 (no reporting yet);
    # blank the whole forecast horizon so it is filled with climatology below — else
    # those zeros would drive indicator-heavy models to predict ~0 in 2026.
    LAST_ACTUAL = VAL_MONTHS[-1]
    panel.loc[panel.ym > LAST_ACTUAL, EXO] = np.nan

    # fill indicators: actual where present, else per-LGA monthly climatology, else month-mean, else 0
    panel = panel.merge(clim, on=KEYS + ["month"], how="left", suffixes=("", "_clim"))
    for c in EXO:
        panel[c] = panel[c].fillna(panel[c + "_clim"])
        panel.drop(columns=[c + "_clim"], inplace=True)
        panel[c] = panel.groupby("month")[c].transform(lambda s: s.fillna(s.mean()))
        panel[c] = panel[c].fillna(0.0)

    # ---- conditional feature forecasting --------------------------------------
    # Each exogenous feature is forecast forward, not held at a flat average:
    #   forecast(lga, month, year) = seasonal_climatology(lga, month)
    #                                + DAMP * per-LGA annual slope * (year - mid)
    # The slope is the 2023->2025 trend of that feature in that LGA (damped, and
    # bounded so a feature can't more than double or go below its 2025 level), so
    # the 2026+ horizon tracks each indicator's recent growth path rather than the
    # lower multi-year mean. These forecast features then drive the case models.
    fut = panel["ym"] > LAST_ACTUAL
    if fut.any():
        DAMP, MID = 0.5, 2024
        act = df[df.ym <= LAST_ACTUAL]
        m23 = act[act.year == 2023].groupby(KEYS)[EXO].mean()
        m25 = act[act.year == 2025].groupby(KEYS)[EXO].mean()
        slope = ((m25 - m23) / 2.0).reindex(panel[KEYS].drop_duplicates().set_index(KEYS).index)
        slope = slope.fillna(0.0)
        slp = slope.reset_index().rename(columns={c: c + "__slp" for c in EXO})
        panel = panel.merge(slp, on=KEYS, how="left")
        yr_off = (panel["year"] - MID)
        for c in EXO:
            add = (panel[c + "__slp"].fillna(0.0) * DAMP * yr_off)
            add = add.clip(lower=-panel[c], upper=panel[c])     # bound: within ±100% of climatology
            panel.loc[fut, c] = (panel.loc[fut, c] + add[fut]).clip(lower=0)
            panel.drop(columns=[c + "__slp"], inplace=True)

    panel["state_pop"] = [state_population(s, y) for s, y in zip(panel["state"], panel["year"])]
    panel["population"] = panel["state_pop"] * panel["fac_share"].fillna(panel["fac_share"].mean())

    tr = panel[(panel.ym <= TRAIN_END) & panel["cases"].notna()].copy()
    tr["logc"] = np.log1p(tr["cases"].clip(lower=0))
    glob = tr["logc"].mean()
    panel = panel.merge(tr.groupby(KEYS)["logc"].mean().rename("lga_level"), on=KEYS, how="left")
    panel = panel.merge(tr.groupby("state")["logc"].mean().rename("state_level"), on="state", how="left")
    panel["lga_level"] = panel["lga_level"].fillna(glob)
    panel["state_level"] = panel["state_level"].fillna(glob)

    panel = panel.sort_values(KEYS + ["ym"]).reset_index(drop=True)
    panel["snaive"] = panel.groupby(KEYS)["cases"].shift(12)
    return panel


def build_features(p):
    """Add target lags 1-3 (log). Indicators / geo / time are already columns.
    When AFTER, also add the WHO/SEIR-derived climate, surveillance & spatial features."""
    p = p.copy()
    p["logc"] = np.log1p(p["cases"].clip(lower=0))
    g = p.groupby(KEYS)["logc"]
    p["lag1"] = g.shift(1)
    p["lag2"] = g.shift(2)
    p["lag3"] = g.shift(3)
    if not AFTER:
        return p

    rain, temp = "rainfall_mm_day", "temperature_mean_c"
    tmax, tmin, hum = "temperature_max_c", "temperature_min_c", "humidity_pct"

    def gshift(col, k):
        return p.groupby(KEYS)[col].shift(k) if col in p.columns else 0.0

    def anom(col):
        if col not in p.columns:
            return 0.0
        mu = p.groupby(KEYS + ["month"])[col].transform("mean")
        sd = p.groupby(KEYS + ["month"])[col].transform("std").replace(0, np.nan)
        return ((p[col] - mu) / sd).fillna(0.0)

    # climate lag structure
    p["rain_lag1"] = gshift(rain, 1)
    p["rain_lag2"] = gshift(rain, 2)
    p["rain_cum3"] = p.groupby(KEYS)[rain].transform(lambda s: s.rolling(3, min_periods=1).sum()) if rain in p.columns else 0.0
    p["rain_anom"] = anom(rain)
    p["temp_lag1"] = gshift(temp, 1)
    p["temp_suitability"] = np.exp(-((p[temp] - 25.0) / 7.0) ** 2) if temp in p.columns else 0.0
    p["dtr"] = (p[tmax] - p[tmin]).clip(lower=0) if tmax in p.columns and tmin in p.columns else 0.0
    p["temp_anom"] = anom(temp)
    p["hum_lag1"] = gshift(hum, 1)

    # SEIR mechanistic proxies (Ross–Macdonald mappings)
    rain_n = (p[rain] / (p[rain] + 5.0)) if rain in p.columns else 0.0
    hum_n = (p[hum] / 100.0).clip(0, 1) if hum in p.columns else 0.0
    suit = p["temp_suitability"]
    p["eir_proxy"] = suit * rain_n * hum_n
    r2 = p["rain_lag2"].fillna(p[rain]) if rain in p.columns else 0.0
    p["recruitment_proxy"] = (r2 / (r2 + 5.0)) * suit
    p["mortality_proxy"] = (np.abs(p[temp] - 25.0) / 15.0).clip(0, 1) if temp in p.columns else 0.0

    # surveillance temporal structure
    p["tpr_lag1"] = gshift(_TPR, 1)
    p["lag6"] = g.shift(6)
    p["lag12"] = g.shift(12)
    gl1 = p.groupby(KEYS)["lag1"]
    p["roll3"] = gl1.transform(lambda s: s.rolling(3, min_periods=1).mean())
    p["roll6"] = gl1.transform(lambda s: s.rolling(6, min_periods=1).mean())
    p["yoy_change"] = (p["lag1"] - g.shift(13)).fillna(0.0)
    tpr1 = p["tpr_lag1"] if not np.isscalar(p["tpr_lag1"]) else 0.0
    p["r0_proxy"] = (p["tpr_lag1"].fillna(0) / 100.0) * (1.0 + p["yoy_change"].clip(-1, 2))

    # spatial spillover — state mean log-cases last month
    p["_smean"] = p.groupby(["state", "ym"])["logc"].transform("mean")
    p["spatial_lag1"] = p.groupby(KEYS)["_smean"].shift(1)
    p.drop(columns=["_smean"], inplace=True)

    # real-external satellite lag (NDVI literature lag is 2–3 months)
    if "ndvi" in p.columns:
        p["ndvi_lag1"] = p.groupby(KEYS)["ndvi"].shift(1)
    return p
