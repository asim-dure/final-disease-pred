"""
FastAPI backend for What-If Lab: SARIMAX on-the-fly forecasting + Groq budget planning.
Run: python api.py   (port 8000, CORS open for Vite dev server)
"""
import os, re, warnings, json, uuid
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional
from dotenv import load_dotenv

load_dotenv()  # WAREHOUSE_DATABASE_URL must be set before any warehouse-backed route runs

import disease_config as dc
import etl_warehouse_common as ewc
import warehouse as wh
import population_data as popdata

warnings.filterwarnings("ignore")

app = FastAPI(title="Malaria What-If API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# EWS NLP routes (/api/ews/interpret, /api/ews/meta) — no new port/process.
try:
    from ews_nlp import ews_router
    app.include_router(ews_router)
except Exception as _ews_err:
    import logging as _log
    _log.warning(f"EWS NLP routes not loaded: {_ews_err}")

# ── load dataset once ────────────────────────────────────────────────────────
_DF: pd.DataFrame = None

def get_df() -> pd.DataFrame:
    global _DF
    if _DF is None:
        path = os.path.join(os.path.dirname(__file__), "agg_lga_pop.parquet")
        _DF = pd.read_parquet(path)
    return _DF


# Per-disease warehouse frames for /api/forecast and /api/whatif, cached after
# first fetch (mirrors the _DF singleton pattern above, keyed by disease id).
# disease="malaria" always resolves to the existing get_df() path unchanged.
_DF_CACHE: Dict[str, pd.DataFrame] = {}

def get_df_for(disease: str) -> pd.DataFrame:
    if disease == "malaria":
        return get_df()
    if disease not in _DF_CACHE:
        cfg = dc.DISEASES.get(disease)
        if cfg is None or not cfg.get("forecastable") or not cfg.get("forecast_target"):
            raise HTTPException(400, f"Disease '{disease}' is not forecastable")
        target = cfg["forecast_target"]
        fetch_names = cfg.get("forecast_target_components", target)
        raw = ewc.fetch_fact_series(disease, fetch_names, level="state",
                                     system_id=cfg.get("forecast_target_system_id"))
        raw = raw.rename(columns={"value": target})
        raw["population"] = [
            popdata.state_population(s, int(y)) for s, y in zip(raw["state"], raw["year"])
        ]
        raw["population"] = raw["population"].fillna(0.0)
        _DF_CACHE[disease] = raw
    return _DF_CACHE[disease]


def get_elasticity_map(disease: str) -> dict:
    if disease == "malaria":
        return ELASTICITY
    return dc.DISEASES.get(disease, {}).get("elasticity", {})

# ── column taxonomy ──────────────────────────────────────────────────────────
ID_COLS = {"country", "state", "lga", "year", "month"}

BASELINE_KEYS = {
    "temperature_mean_c", "temperature_max_c", "temperature_min_c",
    "humidity_pct", "rainfall_mm_day", "wind_speed_ms", "solar_kwh_m2_day",
    "enso_oni", "iod_dmi", "ndvi", "ndvi_anom",
    "elevation", "latitude", "area_sqkm", "pop_density",
    "population", "state_population", "fac_share",
    "pfpr", "poverty_mpi_h", "dep_schooling", "dep_electricity",
    "dep_water", "dep_housing", "incidence_per_1000", "n_facilities",
}

DEFAULT_TARGETS = [
    "MAL - Malaria cases confirmed (number)",
    "MAL - Total reported malaria cases (confirmed + presumed)",
    "MAL - Malaria inpatient admissions",
    "MAL - Malaria deaths inpatient(Under 5)",
    "Number of suspected malaria cases",
]

# Mean-aggregated (rates, environment) vs sum-aggregated (counts)
MEAN_AGG_KEYS = BASELINE_KEYS | {
    "% Confirmed Malaria (RDT or Microscopy)", "% Confirmed uncomplicated Malaria",
    "Fever Testing Rate", "MAL - Case fatality rate (malaria admissions)",
    "MAL - % of all-admissions/all outpatients", "MAL - Percentage of malaria OPD cases",
    "MAL - Slide positivity rate (microscopy)", "MAL - Test positivity rate (RDT)",
    "Test Positivity Rate(TPR) (RDT)", "Test Positivity Rate(TPR) (Microscopy)",
    "% of clinically diagnosed malaria given ACT",
    "% of confirmed uncomplicated malaria given ACT",
}

# ── helpers ──────────────────────────────────────────────────────────────────
def agg_level(df: pd.DataFrame, level: str, state_name: Optional[str]) -> pd.DataFrame:
    if level == "state" and state_name:
        df = df[df["state"] == state_name].copy()
    elif level == "national":
        df = df.copy()

    num = [c for c in df.select_dtypes(include="number").columns if c not in {"year", "month"}]
    agg = {c: ("mean" if c in MEAN_AGG_KEYS else "sum") for c in num}
    out = df.groupby(["year", "month"]).agg(agg).reset_index()
    out["date"] = out["year"].astype(str) + "-" + out["month"].astype(str).str.zfill(2)
    return out.sort_values("date").reset_index(drop=True)


def project_exog(hist_exog: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Project each exog column forward using its last 12-month seasonal mean."""
    rows = []
    for h in range(1, horizon + 1):
        row = {}
        for col in hist_exog.columns:
            vals = hist_exog[col].dropna()
            if len(vals) >= 12:
                seasonal = vals.iloc[-12:].mean()
            else:
                seasonal = vals.mean() if len(vals) > 0 else 0.0
            row[col] = float(seasonal)
        rows.append(row)
    return pd.DataFrame(rows, columns=hist_exog.columns)


def future_dates(last_date: str, horizon: int) -> List[str]:
    y, m = int(last_date[:4]), int(last_date[5:7])
    dates = []
    for _ in range(horizon):
        m += 1
        if m > 12:
            m = 1; y += 1
        dates.append(f"{y}-{m:02d}")
    return dates


def trim_trailing_zeros(series: pd.Series, exog: Optional[pd.DataFrame]):
    """Drop trailing all-zero / NaN rows (unreported months at the end)."""
    s = series.copy()
    # find last index where series > 0
    nonzero = s[s > 0]
    if nonzero.empty:
        return s, exog
    last = nonzero.index[-1]
    s = s.loc[:last]
    e = exog.loc[:last] if exog is not None else None
    return s, e


def run_sarimax(series: pd.Series, exog_train: Optional[pd.DataFrame],
                exog_future: Optional[pd.DataFrame], horizon: int):
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    # drop trailing zero/NaN months (unreported future months in the dataset)
    series, exog_train = trim_trailing_zeros(series, exog_train)

    series = series.copy().interpolate(limit_direction="both").bfill().fillna(0)
    series = series.clip(lower=0)

    use_exog = exog_train is not None and len(exog_train.columns) > 0
    if use_exog:
        exog_train = exog_train.loc[series.index].fillna(exog_train.mean()).fillna(0)
        exog_future = exog_future.fillna(exog_train.mean()).fillna(0)

    # Candidate orders: D=0 (no seasonal differencing) + seasonal AR/MA so the
    # forecast inherits the repeating seasonal shape instead of collapsing flat.
    candidates = [
        ((1, 1, 1), (1, 0, 1, 12)),
        ((2, 1, 1), (1, 0, 1, 12)),
        ((1, 1, 2), (1, 0, 1, 12)),
    ]

    best_res, best_aic = None, np.inf
    for order, seasonal_order in candidates:
        try:
            mod = SARIMAX(
                series,
                exog=exog_train if use_exog else None,
                order=order,
                seasonal_order=seasonal_order,
                enforce_stationarity=False,
                enforce_invertibility=False,
                trend="c",
            )
            res = mod.fit(disp=False, maxiter=400, method="lbfgs")
            if res.aic < best_aic:
                best_aic = res.aic
                best_res = res
        except Exception:
            pass

    if best_res is None:
        # fallback: naive seasonal repeat
        tail = series.iloc[-12:].tolist()
        mean = [int(max(0, tail[i % 12])) for i in range(horizon)]
        return mean, [int(v * 0.75) for v in mean], [int(v * 1.25) for v in mean]

    fc = best_res.get_forecast(steps=horizon, exog=exog_future if use_exog else None)
    pm = fc.predicted_mean.replace([np.inf, -np.inf], np.nan).fillna(0)
    mean = pm.clip(lower=0).round().astype(int).tolist()
    ci = fc.conf_int().replace([np.inf, -np.inf], np.nan)
    ci.iloc[:, 0] = ci.iloc[:, 0].fillna(pm * 0.75)
    ci.iloc[:, 1] = ci.iloc[:, 1].fillna(pm * 1.25)
    lower = ci.iloc[:, 0].clip(lower=0).round().astype(int).tolist()
    upper = ci.iloc[:, 1].clip(lower=0).round().astype(int).tolist()
    return mean, lower, upper

# ── pydantic models ──────────────────────────────────────────────────────────
class ForecastReq(BaseModel):
    level: str = "national"           # "national" | "state"
    state_name: Optional[str] = None
    target: str = "MAL - Malaria cases confirmed (number)"
    covariates: List[str] = []
    horizon: int = 12
    disease: str = "malaria"

class WhatIfReq(ForecastReq):
    interventions: Dict[str, float] = {}   # col -> % change (e.g. 30 means +30%)

class BudgetReq(BaseModel):
    level: str = "national"
    state_name: Optional[str] = None
    target: str
    interventions: Dict[str, float]
    base_monthly_cases: float
    whatif_monthly_cases: float
    population: float
    horizon: int
    months: List[str] = []          # per-month dates (e.g. "2026-04")
    base_monthly: List[float] = []  # per-month base forecast
    whatif_monthly: List[float] = []  # per-month what-if forecast
    disease: str = "malaria"

class OptimizeReq(BaseModel):
    level: str = "national"
    state_name: Optional[str] = None
    target: str = "MAL - Malaria cases confirmed (number)"
    horizon: int = 12
    budget_ngn: float               # total budget in Naira
    candidate_interventions: List[str] = []
    disease: str = "malaria"

class Proposal(BaseModel):
    mode: str                       # "forward" | "reverse"
    title: Optional[str] = None
    level: str = "national"
    state_name: Optional[str] = None
    horizon: int = 12
    interventions: Dict[str, float] = {}
    budget_ngn: Optional[float] = None
    summary: Dict = {}              # totals, cases averted, cost/case
    plan: str = ""
    disease: str = "malaria"
    months: List[str] = []          # per-month dates, so AI Compare can re-cite real figures
    base_monthly: List[float] = []
    whatif_monthly: List[float] = []

class CompareReq(BaseModel):
    proposal_ids: List[str]
    disease: str = "malaria"

# Realistic 2024 Nigeria NMEP unit costs (Naira) the LLM is grounded on.
USD_NGN = 1600
UNIT_COSTS = {
    "ACT Given - Total":                          ("ACT treatment course", 150),
    "LLIN given – Total":                          ("LLIN net", 2500),
    "Children <5 yrs who received LLIN":           ("LLIN net (child)", 2500),
    "MAL - Malaria cases tested with RDT":         ("RDT test kit", 600),
    "Number of malaria cases treated with artemisinin-based combinat": ("ACT course", 150),
    "IPTp1 Coverage (institutional)":              ("IPTp-SP dose", 200),
    "IPTp2 Coverage (institutional)":              ("IPTp-SP dose", 200),
    "IPTp3 Coverage (institutional)":              ("IPTp-SP dose", 200),
    "Anti-Malarial treatment":                     ("anti-malarial course", 180),
}
DEFAULT_CANDIDATES = list(UNIT_COSTS.keys())

PROPOSALS_FILE = os.path.join(os.path.dirname(__file__), "budget_proposals.json")

def _load_proposals():
    if os.path.exists(PROPOSALS_FILE):
        try:
            return json.load(open(PROPOSALS_FILE, encoding="utf-8"))
        except Exception:
            return []
    return []

def _save_proposals(items):
    json.dump(items, open(PROPOSALS_FILE, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

def _costs_text(cols):
    lines = []
    for c in cols:
        if c in UNIT_COSTS:
            label, cost = UNIT_COSTS[c]
            lines.append(f'  - "{c}" → {label}, ~₦{cost:,}/unit (${cost/USD_NGN:.3f})')
    return "\n".join(lines) if lines else "  (use realistic NMEP supply-chain costs)"

# SARIMAX forecasts compound error the further out they project -- a sum
# across a 2030 horizon (Forecast.jsx's "Forecast to 2030") produces
# implausible AI-cited totals (e.g. malaria's reported "174M cases"). Every
# budget/compare prompt below caps month-indexed data to this date so the
# LLM only ever cites a realistic near-term total.
FORECAST_CAP_DATE = "2027-05"

def _cap_to(months, *series_lists, cap=FORECAST_CAP_DATE):
    """Trim parallel month-indexed lists to dates <= cap. Pass-through (no
    truncation) when months is empty, since some callers only have averages."""
    if not months:
        return (months,) + series_lists
    keep = [i for i, m in enumerate(months) if m <= cap]
    capped_months = [months[i] for i in keep]
    capped = tuple([s[i] for i in keep if i < len(s)] if s else s for s in series_lists)
    return (capped_months,) + capped


def _disease_label(disease: str) -> str:
    return dc.DISEASES.get(disease, {}).get("label", disease.replace("_", " ").title())


def _dataset_notes(disease: str) -> str:
    info = dc.DISEASES.get(disease, {}).get("dataset_info", {}) or {}
    return info.get("notes", "")

# ── routes ───────────────────────────────────────────────────────────────────
@app.get("/api/meta")
def get_meta(disease: str = "malaria"):
    df = get_df_for(disease)
    states = sorted(df["state"].dropna().unique().tolist())
    if disease == "malaria":
        num_cols = [c for c in df.select_dtypes(include="number").columns if c not in ID_COLS]
        intervention_cols = [c for c in num_cols if c not in BASELINE_KEYS]
        baseline_cols = [c for c in num_cols if c in BASELINE_KEYS]
        targets = [t for t in DEFAULT_TARGETS if t in df.columns]
    else:
        # Warehouse diseases currently expose exactly one fetched indicator
        # (forecast_target) and no separate intervention columns -- honest
        # empty lists rather than reusing malaria's, so WhatIfLab's feature
        # picker correctly shows "no interventions configured" instead of
        # malaria's unrelated columns.
        target = dc.DISEASES.get(disease, {}).get("forecast_target")
        targets = [target] if target else []
        baseline_cols, intervention_cols = [], []
        num_cols = targets
    return {
        "states": states,
        "targets": targets,
        "baseline_cols": sorted(baseline_cols),
        "intervention_cols": sorted(intervention_cols),
        "all_numeric": sorted(num_cols),
    }


@app.get("/api/diseases")
def list_diseases():
    return dc.public_disease_list()


@app.get("/api/health/warehouse")
def health_warehouse():
    return {"ok": wh.engine_ok()}


@app.post("/api/forecast")
def forecast(req: ForecastReq):
    df = get_df_for(req.disease)
    agg = agg_level(df, req.level, req.state_name)

    if req.target not in agg.columns:
        raise HTTPException(400, f"Target '{req.target}' not found")

    series = agg[req.target].copy()
    valid_covs = [c for c in req.covariates if c in agg.columns and c != req.target]

    exog_train = agg[valid_covs] if valid_covs else None
    # trim trailing zeros to get true last reporting date
    series_trimmed, exog_trimmed = trim_trailing_zeros(series, exog_train)
    last_date = agg.loc[series_trimmed.index[-1], "date"]

    exog_future = project_exog(exog_trimmed, req.horizon) if valid_covs else None

    mean, lower, upper = run_sarimax(series, exog_train, exog_future, req.horizon)
    fdates = future_dates(last_date, req.horizon)

    history = [
        {"date": row["date"], "cases": max(0, int(row[req.target]))}
        for _, row in agg.iterrows()
        if pd.notna(row[req.target]) and row["date"] <= last_date and row[req.target] > 0
    ]

    forecast_out = [
        {"date": d, "cases": v, "lower": lo, "upper": hi}
        for d, v, lo, hi in zip(fdates, mean, lower, upper)
    ]

    pop = float(agg["population"].iloc[-1]) if "population" in agg.columns else 0
    return {"history": history, "forecast": forecast_out, "population": pop}


# Protective elasticities (fractional change in cases per +100% in the intervention),
# matching the What-If Simulator's driver model. Used so scaling up a protective
# intervention REDUCES cases, instead of inheriting confounded SARIMAX correlations
# (historically: more cases → more treatment dispensed → positive coefficient).
ELASTICITY = {
    "ACT Given - Total": -0.30,
    "Number of malaria cases treated with artemisinin-based combinat": -0.30,
    "Anti-Malarial treatment": -0.18,
    "Anti-Malarial treatment among children under 5 yrs": -0.20,
    "LLIN given – Total": -0.40,
    "Children <5 yrs who received LLIN": -0.30,
    "MAL - Malaria cases tested with RDT": -0.12,
    "IPTp1 Coverage (institutional)": -0.20,
    "IPTp2 Coverage (institutional)": -0.18,
    "IPTp3 Coverage (institutional)": -0.15,
}

def _intervention_mult(interventions, elasticity_map=None):
    """Combined protective multiplier on cases from a set of {col: %change}."""
    elasticity_map = elasticity_map if elasticity_map is not None else ELASTICITY
    m = 1.0
    for col, pct in interventions.items():
        e = elasticity_map.get(col)
        if e is None:
            continue                       # unknown intervention → no modelled effect (avoid bad sign)
        m *= (1 + e * (pct / 100.0))
    return max(0.1, min(3.0, m))


def _compute_whatif(level, state_name, target, covariates, interventions, horizon, disease="malaria"):
    """Core what-if: returns history, per-month base & whatif forecasts, population.
    Base = SARIMAX (with any environmental covariates as exog). What-if = base scaled
    by the protective intervention multiplier. Reused by /api/whatif and the reverse
    budget optimizer (closed loop)."""
    df = get_df_for(disease)
    agg = agg_level(df, level, state_name)
    if target not in agg.columns:
        raise HTTPException(400, f"Target '{target}' not found")

    elasticity_map = get_elasticity_map(disease)
    series = agg[target].copy()
    # only NON-intervention covariates inform the SARIMAX base (climate, etc.)
    env_covs = [c for c in covariates if c in agg.columns and c != target and c not in elasticity_map]

    series_trimmed, _ = trim_trailing_zeros(series, None)
    last_date = agg.loc[series_trimmed.index[-1], "date"]

    exog_train = agg[env_covs] if env_covs else None
    exog_future = project_exog(exog_train, horizon) if env_covs else None
    base_mean, base_lo, base_hi = run_sarimax(series, exog_train, exog_future, horizon)

    mult = _intervention_mult(interventions, elasticity_map)
    whatif_mean = [int(round(v * mult)) for v in base_mean]
    whatif_lo = [int(round(v * mult)) for v in base_lo]
    whatif_hi = [int(round(v * mult)) for v in base_hi]

    fdates = future_dates(last_date, horizon)
    history = [
        {"date": row["date"], "cases": max(0, int(row[target]))}
        for _, row in agg.iterrows()
        if pd.notna(row[target]) and row["date"] <= last_date and row[target] > 0
    ]
    pop = float(agg["population"].iloc[-1]) if "population" in agg.columns else 0
    return {
        "history": history,
        "base": [{"date": d, "cases": v, "lower": lo, "upper": hi}
                 for d, v, lo, hi in zip(fdates, base_mean, base_lo, base_hi)],
        "whatif": [{"date": d, "cases": v, "lower": lo, "upper": hi}
                   for d, v, lo, hi in zip(fdates, whatif_mean, whatif_lo, whatif_hi)],
        "population": pop,
    }


@app.post("/api/whatif")
def whatif(req: WhatIfReq):
    return _compute_whatif(req.level, req.state_name, req.target, req.covariates, req.interventions, req.horizon, req.disease)


@app.post("/api/budget")
def budget(req: BudgetReq):
    load_dotenv(override=True)   # re-read .env on every call so key changes take effect without restart
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")

    from groq import Groq
    client = Groq(api_key=api_key)

    label = _disease_label(req.disease)
    cfg = dc.DISEASES.get(req.disease, {})
    configured_interventions = cfg.get("interventions", [])
    has_unit_costs = req.disease == "malaria"   # only malaria has a real ₦ unit-cost table
    notes = _dataset_notes(req.disease)

    case_reduction = req.base_monthly_cases - req.whatif_monthly_cases
    pct_reduction = (case_reduction / req.base_monthly_cases * 100) if req.base_monthly_cases > 0 else 0

    scope = req.state_name if req.level == "state" else "Nigeria (national)"
    interventions_text = "\n".join(
        f"  - {col}: {'increase' if pct > 0 else 'decrease'} by {abs(pct):.0f}%"
        for col, pct in req.interventions.items()
    ) or "  (none selected -- plug & play forecast only)"

    # cap to FORECAST_CAP_DATE before building the month table or any total,
    # so the LLM never sums/cites a multi-year compounded SARIMAX total.
    months_c, base_c, whatif_c = _cap_to(req.months, req.base_monthly, req.whatif_monthly)
    capped_horizon = len(months_c) if months_c else req.horizon

    if months_c and base_c and whatif_c:
        rows = []
        for i, m in enumerate(months_c):
            b = base_c[i] if i < len(base_c) else req.base_monthly_cases
            w = whatif_c[i] if i < len(whatif_c) else req.whatif_monthly_cases
            rows.append(f"  {m}: base {b:,.0f} → with interventions {w:,.0f} (averted {max(0, b-w):,.0f})")
        month_table = "\n".join(rows)
    else:
        month_table = f"  (avg) base {req.base_monthly_cases:,.0f} → {req.whatif_monthly_cases:,.0f}"

    cap_note = (f"IMPORTANT: only plan/total through {FORECAST_CAP_DATE}. Forecasts run further out than this "
                f"compound too much SARIMAX error to be a trustworthy budget basis -- do NOT sum or cite any "
                f"figure beyond {FORECAST_CAP_DATE}, even if asked about a longer horizon.")

    about_section = f"""ABOUT {label.upper()}:
{notes or f'{label} case data from the Nigeria warehouse, no further structured notes recorded.'}"""

    if has_unit_costs and req.interventions:
        # Malaria, with real selected interventions -- grounded ₦ unit-cost flow (unchanged behaviour).
        prompt = f"""You are a health economics advisor for Nigeria's National Malaria Elimination Programme (NMEP).

{about_section}

SITUATION:
- Geographic scope: {scope}
- Estimated population: {req.population:,.0f}
- Forecast horizon shown: {capped_horizon} months, capped at {FORECAST_CAP_DATE} (SARIMAX model)
- Currency: report EVERY figure in BOTH Nigerian Naira (₦) and USD (1 USD = ₦{USD_NGN:,}).
- {cap_note}

PLANNED INTERVENTIONS (changes to current levels):
{interventions_text}

GROUNDED UNIT COSTS:
{_costs_text(list(req.interventions.keys()))}

MONTH-BY-MONTH MODEL FORECAST (confirmed malaria cases, through {FORECAST_CAP_DATE}):
{month_table}

YOUR TASK — produce a DETAILED, MONTH-BY-MONTH national budget & deployment plan covering ALL {capped_horizon} forecast months above:

1. MONTH-BY-MONTH DEPLOYMENT TABLE — one row per forecast month. For each month give:
   - units of each intervention to procure/deploy that month (scale up before the rainy-season peak),
   - that month's cost in ₦ and USD,
   - cumulative spend in ₦ and USD,
   - that month's expected cases averted.

2. INTERVENTION COST BREAKDOWN — per intervention: total units over the horizon, unit cost (₦ + USD), total cost (₦ + USD).

3. TOTAL BUDGET SUMMARY — grand total (₦ + USD), cost per case averted (₦ + USD), value-for-money verdict.

4. GEOGRAPHIC PRIORITISATION — top 5–6 highest-burden states to fund first, with an indicative share of budget each.

5. PROCUREMENT & LOGISTICS TIMELINE — lead times, pre-positioning before rainy season (Jun–Oct), cold-chain/storage notes.

6. PREVENTION & CONTROL MEASURES — the standard NMEP/WHO prevention measures relevant to the interventions above (vector control, case management, chemoprevention), and how this budget operationalises them.

7. RISK FLAGS — supply chain, absorption capacity, financing gaps, caveats.

Be specific and numeric. Use markdown tables with a header row and a `---` separator row (proper GitHub-flavored markdown so the table renders). Program managers will act on this directly."""
    elif configured_interventions:
        # A disease with real warehouse indicators configured (e.g. HIV) but no
        # ₦ unit-cost table yet -- give disease-specific prevention guidance
        # grounded in those named indicators, and a clearly-labeled INDICATIVE
        # (literature-estimated, not warehouse-grounded) budget framework.
        prompt = f"""You are a health economics advisor supporting Nigeria's national {label} programme.

{about_section}

SITUATION:
- Geographic scope: {scope}
- Estimated population: {req.population:,.0f}
- Forecast horizon shown: {capped_horizon} months, capped at {FORECAST_CAP_DATE} (SARIMAX model)
- Currency: report EVERY figure in BOTH Nigerian Naira (₦) and USD (1 USD = ₦{USD_NGN:,}).
- {cap_note}
- This disease has these real warehouse-reported indicators: {', '.join(configured_interventions)}.
  No literal ₦ unit-cost table exists for {label} yet, so ALL cost figures below are clearly-labeled
  LITERATURE-BASED / INDICATIVE ESTIMATES (cite typical Nigeria/WHO programme cost ranges), never
  presented as warehouse-grounded numbers.

PLANNED INTERVENTIONS (changes to current levels, if any):
{interventions_text}

MONTH-BY-MONTH MODEL FORECAST (confirmed cases, through {FORECAST_CAP_DATE}):
{month_table}

YOUR TASK — produce a budget & prevention plan covering the {capped_horizon} forecast months above:

1. ABOUT {label.upper()} — 2-3 sentences on burden, transmission/risk pathway, and who is most affected in the Nigerian context.

2. PREVENTION & CONTROL MEASURES — disease-specific guidance grounded in the named indicators above (e.g. scale-up of {configured_interventions[0]}), citing WHO/national-programme standard practice.

3. INDICATIVE BUDGET FRAMEWORK (clearly labeled "indicative, literature-based, not warehouse-grounded") — a markdown table: line item, typical unit cost range (₦ + USD), estimated units for this scope/horizon, estimated cost (₦ + USD).

4. TOTAL INDICATIVE BUDGET — grand total range (₦ + USD), with an explicit caveat that this is a planning estimate, not an audited figure.

5. GEOGRAPHIC PRIORITISATION — which states/zones to prioritise first based on the forecast trend above.

6. RISK FLAGS & DATA CAVEATS — what data gaps exist for {label} (reference the dataset note above) and how that limits confidence in this plan.

Use markdown tables with a header row and a `---` separator row (proper GitHub-flavored markdown so the table renders)."""
    else:
        # No configured interventions/indicators at all for this disease --
        # fully generic budget + generic prevention guidance, explicitly
        # labeled as generic rather than fabricated as disease-specific.
        prompt = f"""You are a public-health budget advisor supporting Nigeria's national {label} response.

{about_section}

SITUATION:
- Geographic scope: {scope}
- Estimated population: {req.population:,.0f}
- Forecast horizon shown: {capped_horizon} months, capped at {FORECAST_CAP_DATE} (SARIMAX model)
- Currency: report EVERY figure in BOTH Nigerian Naira (₦) and USD (1 USD = ₦{USD_NGN:,}).
- {cap_note}
- IMPORTANT: the warehouse has NO per-LGA driver/intervention dataset for {label} -- only reported case
  volume and trend. There is nothing to ground a disease-specific costed plan on. Produce a GENERIC public-health
  budget framework and GENERIC prevention guidance for {label}, clearly labeled as generic/indicative, not
  fabricated as if it were grounded in {label}-specific Nigerian programme data.

MONTH-BY-MONTH MODEL FORECAST (confirmed cases, through {FORECAST_CAP_DATE}):
{month_table}

YOUR TASK:

1. ABOUT {label.upper()} — 2-3 sentences on what this disease is and its general burden/risk pathway.

2. GENERIC PREVENTION & CONTROL MEASURES — standard, widely-recognised (WHO/public-health) prevention measures for {label}, labeled "generic guidance -- no Nigeria-specific driver data available for {label}".

3. GENERIC BUDGET FRAMEWORK (clearly labeled "generic / indicative, not warehouse-grounded") — a markdown table of typical line items for a {label} response programme at this population/scope: line item, indicative unit cost range (₦ + USD), estimated total cost (₦ + USD) for the {capped_horizon}-month horizon shown above.

4. TOTAL INDICATIVE BUDGET — a single indicative range (₦ + USD), with an explicit caveat that no per-LGA driver/cost data exists for {label} so this is a generic planning estimate only.

5. GEOGRAPHIC PRIORITISATION — based only on the case-volume/trend forecast above (no driver data), which states/zones show the highest near-term burden.

6. DATA CAVEATS — state plainly that no intervention/driver dataset exists in the warehouse for {label}, so this plan cannot be more specific than shown.

Use markdown tables with a header row and a `---` separator row (proper GitHub-flavored markdown so the table renders)."""

    resp = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=3500,
        temperature=0.3,
    )
    return {"plan": resp.choices[0].message.content, "generic": not has_unit_costs}


def _extract_json_block(text, tag="INTERVENTIONS_JSON"):
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    raw = m.group(1) if m else None
    if raw is None:
        m = re.search(r"\{[^{}]*\}", text, re.DOTALL)   # fallback: first json object
        raw = m.group(0) if m else None
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return {k: float(v) for k, v in d.items() if isinstance(v, (int, float))}
    except Exception:
        return {}


@app.post("/api/budget-optimize")
def budget_optimize(req: OptimizeReq):
    """Reverse mode: given a budget, the LLM picks the best intervention mix,
    then we run SARIMAX to show the real projected impact (closed loop)."""
    if req.disease != "malaria":
        raise HTTPException(400, f"Budget planning requires unit costs, not yet configured for '{req.disease}'")
    load_dotenv(override=True)
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    client = Groq(api_key=api_key)

    cands = [c for c in (req.candidate_interventions or DEFAULT_CANDIDATES) if c in get_df().columns]
    if not cands:
        cands = [c for c in DEFAULT_CANDIDATES if c in get_df().columns]

    # baseline forecast (no interventions) for context -- capped at FORECAST_CAP_DATE
    # so the optimiser never plans/totals against an implausible multi-year sum.
    base_run = _compute_whatif(req.level, req.state_name, req.target, [], {}, req.horizon, req.disease)
    months_full = [d["date"] for d in base_run["base"]]
    base_monthly_full = [d["cases"] for d in base_run["base"]]
    months_c, base_monthly_c = _cap_to(months_full, base_monthly_full)
    base_monthly = base_monthly_c if base_monthly_c else base_monthly_full
    capped_horizon = len(months_c) if months_c else req.horizon
    base_avg = sum(base_monthly) / len(base_monthly) if base_monthly else 0
    pop = base_run["population"]
    scope = req.state_name if req.level == "state" else "Nigeria (national)"
    budget_usd = req.budget_ngn / USD_NGN

    prompt = f"""You are a health economics optimiser for Nigeria's NMEP.

GOAL: choose the intervention mix that averts the MOST malaria cases WITHIN a fixed budget.

CONSTRAINTS:
- Geographic scope: {scope}
- Total available budget: ₦{req.budget_ngn:,.0f} (= ${budget_usd:,.0f}, at ₦{USD_NGN:,}/USD)
- Forecast horizon: {capped_horizon} months, capped at {FORECAST_CAP_DATE} -- only plan/total through this date,
  even if the underlying model horizon runs longer (longer SARIMAX horizons compound too much error to budget against).
- Population: {pop:,.0f}
- Baseline forecast (no new action): ~{base_avg:,.0f} confirmed cases/month

INTERVENTIONS YOU MAY FUND (with unit costs):
{_costs_text(cands)}

DECIDE: for each intervention you choose, a percentage scale-up vs current levels (0–200%) that keeps TOTAL cost within the budget. Prioritise high-impact, cost-effective options (LLIN + ACT usually best value), pre-position before the rainy season.

OUTPUT, in this exact order:
1. A machine-readable block (percentages of current level, only the interventions you fund):
<INTERVENTIONS_JSON>
{{"ACT Given - Total": 40, "LLIN given – Total": 25}}
</INTERVENTIONS_JSON>
2. Then a detailed plan: month-by-month deployment over the {capped_horizon} months (through {FORECAST_CAP_DATE} only), cost breakdown per intervention in ₦ AND USD, total spend vs the ₦{req.budget_ngn:,.0f} budget (show headroom/overage), expected cases averted, geographic prioritisation (top states), and risks. Use markdown tables with a header row and a `---` separator row. Every figure in ₦ and USD."""

    resp = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=3500,
        temperature=0.3,
    )
    plan = resp.choices[0].message.content
    interventions = _extract_json_block(plan)
    # clamp to sane range
    interventions = {k: max(-80.0, min(200.0, v)) for k, v in interventions.items() if k in cands}

    # closed loop: run SARIMAX with the AI-chosen interventions
    sim = _compute_whatif(req.level, req.state_name, req.target, cands, interventions, req.horizon, req.disease)
    return {
        "plan": plan,
        "interventions": interventions,
        "history": sim["history"],
        "base": sim["base"],
        "whatif": sim["whatif"],
        "population": sim["population"],
        "budget_ngn": req.budget_ngn,
    }


# ── proposal persistence (versioned, deletable) ──────────────────────────────
@app.get("/api/proposals")
def list_proposals(disease: str = "malaria"):
    items = _load_proposals()
    return [it for it in items if it.get("disease", "malaria") == disease]

@app.post("/api/proposals")
def add_proposal(p: Proposal):
    items = _load_proposals()
    same_disease = [it for it in items if it.get("disease", "malaria") == p.disease]
    version = (max([it.get("version", 0) for it in same_disease]) + 1) if same_disease else 1
    rec = p.dict()
    rec.update({
        "id": uuid.uuid4().hex[:12],
        "version": version,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    items.append(rec)
    _save_proposals(items)
    return rec

@app.delete("/api/proposals/{pid}")
def delete_proposal(pid: str):
    items = _load_proposals()
    new = [it for it in items if it.get("id") != pid]
    _save_proposals(new)
    return {"deleted": pid, "remaining": len(new)}


@app.post("/api/compare-proposals")
def compare_proposals(req: CompareReq):
    """AI-generated comparison narrative across 2+ saved proposals: what the
    forecast showed during each proposal's horizon, and what the budget was
    according to that forecast -- not just a static numeric table."""
    load_dotenv(override=True)
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    client = Groq(api_key=api_key)

    items = _load_proposals()
    by_id = {it.get("id"): it for it in items}
    props = [by_id[pid] for pid in req.proposal_ids if pid in by_id]
    if len(props) < 2:
        raise HTTPException(400, "Need at least 2 valid saved proposals to compare")

    label = _disease_label(req.disease)
    blocks = []
    for i, p in enumerate(props, 1):
        months_c, base_c, whatif_c = _cap_to(p.get("months", []), p.get("base_monthly", []), p.get("whatif_monthly", []))
        if months_c and base_c and whatif_c:
            fc_lines = "\n".join(
                f"    {m}: base {base_c[j]:,.0f} → with interventions {whatif_c[j]:,.0f}"
                for j, m in enumerate(months_c) if j < len(base_c) and j < len(whatif_c)
            )
        else:
            fc_lines = "    (no month-by-month series saved for this proposal -- summary totals only)"
        summ = p.get("summary", {}) or {}
        scope = p.get("state_name") or "Nigeria (national)"
        interventions_text = ", ".join(f"{k} {v:+.0f}%" for k, v in (p.get("interventions") or {}).items()) or "none"
        plan_excerpt = (p.get("plan") or "")[:1200]
        blocks.append(f"""PROPOSAL {i} (v{p.get('version')}, {p.get('mode')} mode, saved {p.get('created')}):
  - Scope: {scope}, horizon: {p.get('horizon')} months
  - Interventions: {interventions_text}
  - Budget: ₦{(p.get('budget_ngn') or 0):,.0f}
  - Forecast shown (capped at {FORECAST_CAP_DATE}):
{fc_lines}
  - Saved summary: base total {summ.get('base_total', 'n/a')}, what-if total {summ.get('whatif_total', 'n/a')}, averted {summ.get('averted', 'n/a')}, cost/case {summ.get('cost_per_case', 'n/a')}
  - Excerpt of the original AI plan for this proposal: {plan_excerpt or '(none saved)'}""")

    prompt = f"""You are a health economics advisor comparing {len(props)} saved budget proposals for Nigeria's {label} programme.

{chr(10).join(blocks)}

YOUR TASK -- write a comparison narrative, NOT a generic recap:
1. For EACH proposal: state plainly what the forecast showed during its time period (through {FORECAST_CAP_DATE} only -- never sum or cite figures beyond that date even if a proposal's horizon runs longer), and what the budget was according to that forecast.
2. Then COMPARE them directly: which proposal averts more cases, which is more cost-effective (₦ per case averted), and which budget gives better value for money.
3. Give a clear recommendation: which proposal you'd advise adopting, and why -- or whether a hybrid of the two is better.
4. Flag any caveat (e.g. a proposal where no month-by-month series was saved, so the comparison relies on summary totals only).

Use markdown tables with a header row and a `---` separator row (proper GitHub-flavored markdown so the table renders). Be specific and numeric, not vague."""

    resp = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=2500,
        temperature=0.3,
    )
    return {"comparison": resp.choices[0].message.content}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8001, reload=True)
