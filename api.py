"""
FastAPI backend for What-If Lab: SARIMAX on-the-fly forecasting + Groq budget planning.
Run: python api.py   (port 8000, CORS open for Vite dev server)
"""
import os, re, warnings, json, uuid, math
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
import ross_macdonald as rm

warnings.filterwarnings("ignore")

# SARIMAX pulls in statsmodels' compiled Cython Kalman-filter extensions
# (_initialization/_representation/_kalman_filter/...). On some Windows
# machines a security product (Application Control / Smart App Control /
# corporate AV) scans a newly-touched native DLL the FIRST time it's loaded
# in a process and blocks that one attempt while the scan runs, then allows
# it on retry a moment later -- previously this import lived INSIDE
# run_sarimax() and ran lazily on a user's first Budget Planning request, so
# that transient block surfaced as a raw, uncaught ImportError deep in a
# request (a plain-text 500 the frontend couldn't even parse as JSON: "Error:
# SyntaxError: Unexpected token 'I', "Internal S"..."). Importing it eagerly
# here, with a few retries, means the scan (if any) happens once at server
# startup instead of unpredictably mid-session, and _SARIMAX degrades to None
# (triggering run_sarimax's existing naive-seasonal fallback) if it's still
# blocked after retrying, rather than crashing every request that needs it.
_SARIMAX = None
for _attempt in range(3):
    try:
        from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX
        break
    except ImportError as _e:
        import time as _time
        print(f"[warn] statsmodels SARIMAX import failed (attempt {_attempt + 1}/3): {_e}")
        _time.sleep(1.5)
if _SARIMAX is None:
    print("[warn] statsmodels SARIMAX unavailable after retries -- forecast endpoints will use the naive-seasonal fallback only.")

app = FastAPI(title="Malaria What-If API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# Last line of defense: ANY unhandled exception (this DLL-block included, but
# also anything else -- a bad covariate combination, a numerical edge case in
# statsmodels, etc.) must still come back as JSON, never Starlette's default
# plain-text "Internal Server Error" -- that plain-text body is exactly what
# broke the frontend's `r.json()` parse ("Unexpected token 'I', ...").
@app.exception_handler(Exception)
async def _json_500(request, exc):
    from fastapi.responses import JSONResponse
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"{exc.__class__.__name__}: {exc}"})

# EWS NLP routes (/api/ews/interpret, /api/ews/meta) — no new port/process.
try:
    from ews_nlp import ews_router
    app.include_router(ews_router)
except Exception as _ews_err:
    import logging as _log
    _log.warning(f"EWS NLP routes not loaded: {_ews_err}")

# Facility drill-down routes (/api/facilities, /api/facility-risk) — the Visual
# Overview's per-LGA facility panel. Same in-process mount, no new port.
try:
    from facility_api import facility_router
    app.include_router(facility_router)
except Exception as _fac_err:
    import logging as _log
    _log.warning(f"Facility routes not loaded: {_fac_err}")

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

# Mean-aggregated (rates, environment) vs sum-aggregated (counts). "population"
# is in BASELINE_KEYS (a locked, non-intervention covariate) but is itself a
# per-LGA COUNT, not a rate -- mean-aggregating it across a state/national
# group of LGA rows was averaging ~774 LGA populations into one (~300K),
# instead of summing them into the real state/national total (~234M for
# Nigeria). That silently fed a wildly undersized population into every
# population-scaled budget/coverage calc (e.g. the budget solver's LLIN/IPTp/
# SMC full-coverage cost), making a modest budget look like it bought >100%
# coverage. "state_population" is unaffected -- it's already pre-summed and
# duplicated identically onto every LGA row, so a mean of duplicates is
# correct as-is.
MEAN_AGG_KEYS = (BASELINE_KEYS - {"population"}) | {
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
    # Uses the module-level _SARIMAX (imported once at startup, with retries --
    # see top of file). If it's still unavailable, best_res simply stays None
    # below and the naive-seasonal fallback kicks in, same as a fitting failure.

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
    for order, seasonal_order in ([] if _SARIMAX is None else candidates):
        try:
            mod = _SARIMAX(
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
# ── Real budget solver (validated in test_budget_solver.py) ─────────────────
# Reverse-mode "Budget -> Interventions" used to ask an LLM to pick the spend
# mix directly. A head-to-head test against an exhaustive combinatorial search
# (test_budget_solver.py) showed the LLM: left 15-20% of the budget unspent,
# skipped the 2nd-most cost-effective option (RDT) entirely, overfunded the
# least cost-effective one at the margin (LLIN), and misjudged its own plan's
# impact by ~13% when asked to self-score it. The solver beat the LLM by 28%
# more cases averted on an identical budget. So: the solver now DECIDES the
# allocation; the LLM's job is narration only (see budget_optimize()).
#
# Each intervention's cases-averted-vs-spend curve is a concave, saturating
# function (diminishing returns) -- max_avert*(1-exp(-K*spend/full_cost)) --
# so the optimal allocation problem (maximise total cases averted subject to
# a linear budget constraint) is a separable concave resource-allocation
# problem. That class has a well-known globally-optimal algorithm: water-
# filling / incremental marginal allocation (repeatedly give the next unit of
# spend to whichever intervention currently has the highest marginal return
# per currency unit). This is mathematically equivalent to (and, being
# continuous rather than a discretised grid, at least as good as) the
# exhaustive brute-force search validated in test_budget_solver.py, but scales
# to any budget size in O(steps x interventions) instead of an exponential
# combinatorial search -- verified to reproduce the same optimum (~15,275 vs
# the brute force's ~15,263 on identical Funtua/Katsina Oct-2026 data; the
# tiny gap is the brute force's $5,000 grid coarseness, not an error).
#
# Elasticities reuse the SAME ELASTICITY table above (already the app's own
# canonical driver-effect sizes). `audience` = fraction of confirmed cases the
# intervention can act on (1.0 = population-wide). `ratio`/`per` say how many
# physical units are needed to fully cover that audience (e.g. 1 LLIN net per
# 1.8 people) -- standard PMI/WHO delivery ratios, dimensionless and
# currency-independent. Unit costs reuse the app's own UNIT_COSTS (₦), so the
# solver's numbers are denominated exactly like the rest of the Budget
# Planning UI, not a separate parallel currency assumption.
SOLVER_K = 3.0  # diminishing-returns curvature, matching test_budget_solver.py
SOLVER_INTERVENTIONS = {
    "LLIN nets":       dict(col="LLIN given – Total",                     elasticity=0.40, audience=1.00, per="pop",   ratio=1/1.8),
    "ACT treatment":   dict(col="ACT Given - Total",                      elasticity=0.30, audience=1.00, per="cases", ratio=1.2),
    "RDT testing":     dict(col="MAL - Malaria cases tested with RDT",    elasticity=0.12, audience=1.00, per="cases", ratio=2.0),
    "IPTp (pregnant)": dict(col="IPTp1 Coverage (institutional)",         elasticity=0.20, audience=0.08, per="pop",   ratio=3 * 0.04),
    "SMC (under-5)":   dict(col="Children <5 yrs who received LLIN",     elasticity=0.30, audience=0.35, per="pop",   ratio=0.17),
}

# ── HIV unit costs (₦) -- literature-based, cited (NOT a warehouse-native
# cost table -- disclosed as such in the budget UI, same "GENERIC/INDICATIVE"
# honesty bar as everywhere else in this build). Sources: ART comprehensive
# per-patient cost ~$130/yr (PEPFAR-supported programme costing, PMC/PubMed
# multi-country studies incl. Nigeria); HIV test ~$20-22/client (Nigeria
# community-based FSW testing cost study, PLOS One); PMTCT test ~$18/client
# (same family of Nigeria HCT/PMTCT unit-cost literature); VL test ~$20
# (typical sub-Saharan Africa VL assay costing); PrEP ~$70/person/year
# (oral PrEP programmatic cost, Kenya/multi-country PrEP costing literature --
# no Nigeria-specific 2023-2024 figure was found, so this one is the least
# certain of the five and is labeled as such in the UI).
HIV_UNIT_COSTS = {
    "art":           ("ART patient-year", round(130 * USD_NGN)),
    "hts_testing":   ("HIV test (general population)", round(20 * USD_NGN)),
    "pmtct_testing": ("PMTCT HIV test", round(18 * USD_NGN)),
    "vl_monitoring": ("Viral load test", round(20 * USD_NGN)),
    "msm":           ("PrEP person-year (MSM)", round(70 * USD_NGN)),
    "pwid":          ("PrEP person-year (PWID)", round(70 * USD_NGN)),
    "sw":            ("PrEP person-year (Sex Workers)", round(70 * USD_NGN)),
    "tg":            ("PrEP person-year (Transgender)", round(70 * USD_NGN)),
}

# HIV solver interventions -- same water-filling concave-allocation math as
# malaria's SOLVER_INTERVENTIONS, adapted to HIV's real levers:
#   - art/hts_testing/pmtct_testing/vl_monitoring: per="pop", ratio derived
#     from each driver's REAL current national annualised volume ÷ real
#     national population (drivers_hiv.py's own national baselines, Jan 2026)
#     -- "full cost" models an INCREMENTAL scale-up ask (a quarter of one
#     year's full national delivery cycle at current programme scale, i.e.
#     the annualised real volume x unit cost, damped x0.25), not "replace
#     Nigeria's entire existing HIV budget from zero" -- a budget-planning
#     tool is used to plan NEW/ADDITIONAL spend on top of an already-running
#     programme, so pricing against the full from-scratch national cost
#     (~₦300-500bn/yr for ART alone) would make every realistic planning
#     budget look like it buys almost nothing. Scaled proportionally to
#     whatever geography (national/state) is selected. pmtct_testing's
#     max_avert (not its cost ratio -- that would double-count the scoping,
#     since _solver_build_params already multiplies by the FULL population)
#     is additionally audience-scoped to the standard ~4% pregnant/
#     breastfeeding-women population share already used elsewhere in this
#     project (ross_macdonald.py).
#   - msm/pwid/sw/tg: per="fixed" (a NEW mode -- see _solver_build_params
#     below) against each key population's own real, cited size estimate
#     (export_hiv_kp_socio.py / NACA KP Size Estimation 2023), not a share of
#     the whole Nigerian population -- ratio=0.6 models a realistic
#     "Fast-Track"-style ceiling (able to reach up to 60% of the estimated
#     KP population with a fully-funded PrEP/outreach programme, already a
#     realistically-scoped incremental ask given KP population sizes are
#     small relative to the whole country, so no extra damping needed here).
#     elasticity 0.35 (targeted PrEP/outreach -- larger per-person effect
#     than general population interventions, WHO PrEP efficacy literature)
#     x audience (each group's real, cited share of Nigeria's total PLHIV --
#     see export_hiv_kp_socio.py's audience-weight derivation).
_INCREMENTAL_DAMPING = 0.25
HIV_SOLVER_INTERVENTIONS = {
    "ART continuation":       dict(col="art",           elasticity=0.30, audience=1.00,  per="pop",   ratio=_INCREMENTAL_DAMPING * 1722796 / 230_000_000),
    "HIV testing (general)":  dict(col="hts_testing",    elasticity=0.15, audience=1.00,  per="pop",   ratio=_INCREMENTAL_DAMPING * (300_000 * 12) / 230_000_000),
    "PMTCT testing":          dict(col="pmtct_testing",  elasticity=0.15, audience=0.04,  per="pop",   ratio=_INCREMENTAL_DAMPING * (650_000 * 12) / 230_000_000),
    "VL monitoring":          dict(col="vl_monitoring",  elasticity=0.12, audience=1.00,  per="pop",   ratio=_INCREMENTAL_DAMPING * (1_300_000 * 12) / 230_000_000),
    "PrEP -- MSM":            dict(col="msm",  elasticity=0.35, audience=0.0789, per="fixed", ratio=0.6, fixed_base=600_000, male_only=True),
    "PrEP -- PWID":           dict(col="pwid", elasticity=0.35, audience=0.0253, per="fixed", ratio=0.6, fixed_base=441_500),
    "PrEP -- Sex Workers":    dict(col="sw",   elasticity=0.35, audience=0.0604, per="fixed", ratio=0.6, fixed_base=740_000),
    "PrEP -- Transgender":    dict(col="tg",   elasticity=0.35, audience=0.0142, per="fixed", ratio=0.6, fixed_base=94_000),
}

SOLVER_INTERVENTIONS_BY_DISEASE = {"malaria": SOLVER_INTERVENTIONS, "hiv": HIV_SOLVER_INTERVENTIONS}
UNIT_COSTS_BY_DISEASE = {"malaria": UNIT_COSTS, "hiv": HIV_UNIT_COSTS}


def _solver_build_params(cases: float, pop: float, disease: str = "malaria") -> dict:
    """{name: {max_avert, full_cost, col}} from real cases/population for the
    selected scope, using that disease's SOLVER_INTERVENTIONS elasticity/
    audience/ratio and its own UNIT_COSTS (₦). per="fixed" (HIV key-population
    levers only) uses the intervention's own fixed_base (a real, cited
    population-size estimate) instead of the scope's pop/cases."""
    solver_defs = SOLVER_INTERVENTIONS_BY_DISEASE.get(disease, SOLVER_INTERVENTIONS)
    unit_costs = UNIT_COSTS_BY_DISEASE.get(disease, UNIT_COSTS)
    p = {}
    for name, d in solver_defs.items():
        unit_cost_ngn = unit_costs.get(d["col"], (None, 0))[1]
        if d["per"] == "fixed":
            base = d["fixed_base"]
        elif d["per"] == "pop":
            base = pop
        else:
            base = cases
        full_cost = base * d["ratio"] * unit_cost_ngn
        max_avert = cases * d["audience"] * d["elasticity"]
        p[name] = dict(max_avert=max_avert, full_cost=full_cost, col=d["col"])
    return p


def _solver_averted(spend: float, full_cost: float, max_avert: float, k: float = SOLVER_K) -> float:
    """Concave diminishing-returns impact curve (see module note above)."""
    if full_cost <= 0:
        return 0.0
    return max_avert * (1.0 - math.exp(-k * min(spend, full_cost) / full_cost))


def _solver_allocate(params: dict, budget: float, k: float = SOLVER_K) -> dict:
    """Water-filling allocation: provably optimal for separable concave
    returns under a linear budget constraint (see module note above)."""
    names = list(params)
    if budget <= 0:
        return {"spend": {n: 0.0 for n in names}, "total_spend": 0.0, "avert": 0.0}
    step = max(1.0, budget / 3000)  # bounds iterations regardless of budget scale
    spend = {n: 0.0 for n in names}
    remaining = budget
    while remaining > 1e-6:
        this_step = min(step, remaining)
        best_n, best_marginal = None, -1.0
        for n in names:
            fc, ma = params[n]["full_cost"], params[n]["max_avert"]
            if fc <= 0 or spend[n] >= fc:
                continue
            cur = _solver_averted(spend[n], fc, ma, k)
            nxt = _solver_averted(spend[n] + this_step, fc, ma, k)
            marginal = (nxt - cur) / this_step
            if marginal > best_marginal:
                best_marginal, best_n = marginal, n
        if best_n is None or best_marginal <= 1e-9:
            break  # no intervention has any further useful capacity
        spend[best_n] += this_step
        remaining -= this_step
    total_avert = sum(_solver_averted(spend[n], params[n]["full_cost"], params[n]["max_avert"], k) for n in names)
    return {"spend": spend, "total_spend": budget - remaining, "avert": total_avert}


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

def _costs_text(cols, disease: str = "malaria"):
    unit_costs = UNIT_COSTS_BY_DISEASE.get(disease, UNIT_COSTS)
    lines = []
    for c in cols:
        if c in unit_costs:
            label, cost = unit_costs[c]
            lines.append(f'  - "{c}" → {label}, ~₦{cost:,}/unit (${cost/USD_NGN:.3f})')
    return "\n".join(lines) if lines else "  (use realistic programme supply-chain costs)"

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
@app.get("/ews/api/meta")
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


@app.get("/ews/api/diseases")
def list_diseases():
    return dc.public_disease_list()


@app.get("/ews/api/health/warehouse")
def health_warehouse():
    return {"ok": wh.engine_ok()}


@app.post("/ews/api/forecast")
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


@app.post("/ews/api/whatif")
def whatif(req: WhatIfReq):
    return _compute_whatif(req.level, req.state_name, req.target, req.covariates, req.interventions, req.horizon, req.disease)


class MechanisticReq(BaseModel):
    disease: str = "malaria"
    level: str = "National"        # "National" | a state name
    lga: Optional[str] = None      # optional further drill-down within that state
    itn_coverage: float = 0.0      # 0-1, ITN/LLIN use
    irs_coverage: Optional[float] = None   # 0-1, indoor residual spraying (None -> illustrative national baseline)
    act_coverage: float = 0.0      # 0-1, effective ACT treatment coverage
    iptp_coverage: Optional[float] = None  # 0-1, IPTp in pregnancy (None -> this location's REAL IPTp1 rate)
    vaccine_coverage: Optional[float] = None  # 0-1, child vaccine/immunisation coverage (None -> illustrative national baseline)
    pop_density_scale: float = 1.0  # multiply this location's real pop density (What-If density lever); >1 denser, <1 sparser


@app.post("/ews/api/whatif-mechanistic")
def whatif_mechanistic(req: MechanisticReq):
    """Ross-Macdonald mechanistic what-if (see ross_macdonald.py): real population,
    population density, PfPR, poverty/education deprivation, NDVI and IPTp1 coverage
    for the selected location, run through the classic vectorial-capacity/R0
    equations instead of the empirical elasticity model -- a theory-driven
    complement for the What-If Simulator's "Mechanistic" mode. Malaria-only:
    these covariates live in agg_lga_pop.parquet, which other diseases'
    warehouse-backed frames don't carry."""
    if req.disease != "malaria":
        return {"available": False, "disease": req.disease,
                "reason": "The Ross-Macdonald mechanistic mode needs population density and "
                          "climate covariates that are only loaded for malaria in this build."}

    df = get_df_for("malaria")
    if req.lga and req.level not in ("National", "", None):
        sub = df[(df["state"] == req.level) & (df["lga"] == req.lga)]
        loc_label = f"{req.lga}, {req.level}"
    elif req.level not in ("National", "", None):
        sub = df[df["state"] == req.level]
        loc_label = req.level
    else:
        sub = df
        loc_label = "Nigeria (national)"
    if sub.empty:
        raise HTTPException(404, f"No data found for {loc_label}")

    sub = sub.sort_values(["year", "month"])
    # weather and case reporting can lag independently (weather often trails
    # off before the case series does) -- average the last 12 months that
    # actually HAVE a value for each column, not just the panel's last 12 rows
    # (which may be future placeholder rows with no weather at all).
    def _recent_mean(col, default=None):
        if col not in sub.columns:
            return default
        valid = sub[col].dropna()
        return float(valid.tail(12).mean()) if not valid.empty else default
    pop_density = _recent_mean("pop_density")
    temp_c = _recent_mean("temperature_mean_c", 27.0)
    rainfall = _recent_mean("rainfall_mm_day", 3.0)
    ndvi = _recent_mean("ndvi")
    pfpr = _recent_mean("pfpr")
    poverty_mpi_h = _recent_mean("poverty_mpi_h")
    dep_schooling = _recent_mean("dep_schooling")
    # "IPTp1 Coverage (institutional)" is badly corrupted at source (46% of rows
    # exceed 100%, values up to 1e8) -- "% of all Antenatal care clients
    # receiving malaria IPT" is the same underlying concept and far cleaner
    # (median ~84%, only ~9% outliers), so that's what's used here, clipped as
    # a guard against its own remaining outlier tail.
    real_iptp1_raw = _recent_mean("% of all Antenatal care clients receiving malaria IPT")
    real_iptp1 = None if real_iptp1_raw is None else max(0.0, min(100.0, real_iptp1_raw))
    real_rdt = _recent_mean("MAL - Malaria cases tested with RDT")
    pop_valid = sub["population"].dropna() if "population" in sub.columns else pd.Series(dtype=float)
    population = float(pop_valid.iloc[-1]) if not pop_valid.empty else None

    ctx = rm.population_context(population, pfpr, poverty_mpi_h, dep_schooling)
    sei = ctx.get("socioeconomic_vulnerability_index", {}).get("value")

    # Sliders default to this location's REAL reported rate where one exists
    # (IPTp1), or a clearly-labelled illustrative national baseline where none
    # does (IRS, vaccine coverage) -- see ross_macdonald.py module docstring.
    iptp_default = min(1.0, max(0.0, (real_iptp1 or 0) / 100.0))
    iptp_cov = req.iptp_coverage if req.iptp_coverage is not None else iptp_default
    irs_cov = req.irs_coverage if req.irs_coverage is not None else rm.REF_COVERAGE["irs"]
    vaccine_cov = req.vaccine_coverage if req.vaccine_coverage is not None else rm.REF_COVERAGE["vaccine"]

    # Reference ("status quo") coverage the multiplier is measured against: the
    # sliders' default positions, with IPTp anchored to this location's REAL
    # reported rate -- so an untouched IPTp slider is a genuine no-op, and
    # moving it away from the real rate is what registers a change.
    result = rm.run_scenario(pop_density, temp_c, rainfall, ndvi,
                              req.itn_coverage, irs_cov, req.act_coverage,
                              iptp_cov, vaccine_cov, sei,
                              ref_coverage={**rm.REF_COVERAGE, "iptp": iptp_default},
                              pop_density_scale=req.pop_density_scale)
    result["available"] = True
    result["location"] = {"label": loc_label, "level": req.level, "lga": req.lga}
    result["population"] = population
    result["context"] = ctx
    result["context"]["iptp1_coverage_real"] = {
        "value": None if real_iptp1 is None else round(real_iptp1, 1),
        "source": "warehouse (% of all Antenatal care clients receiving malaria IPT)",
        "note": "used as a proxy for IPTp coverage -- used as the IPTp slider's default"}
    result["context"]["rdt_tests_per_month"] = {
        "value": None if real_rdt is None else round(real_rdt),
        "source": "warehouse (MAL - Malaria cases tested with RDT)",
        "note": "trailing 12-month average testing volume, shown for context (not a model input)"}
    return result


@app.post("/ews/api/budget")
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
    has_unit_costs = req.disease in SOLVER_INTERVENTIONS_BY_DISEASE   # malaria + hiv have a real ₦ unit-cost table
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
        # A disease with a REAL ₦ unit-cost table (malaria or hiv) and real
        # selected interventions -- grounded budget flow. Programme name and
        # seasonal/delivery-channel language are disease-specific so HIV
        # content never inherits malaria's NMEP/rainy-season/vector-control
        # framing (previously hardcoded here regardless of `disease`).
        if req.disease == "malaria":
            programme, timing_note, prevention_line = (
                "Nigeria's National Malaria Elimination Programme (NMEP)",
                "scale up before the rainy-season peak",
                "the standard NMEP/WHO prevention measures relevant to the interventions above (vector control, case management, chemoprevention)",
            )
        else:
            programme, timing_note, prevention_line = (
                f"Nigeria's national {label} programme",
                "ramp up steadily across the horizon (no seasonal peak applies)",
                f"the standard WHO/national-programme prevention & care measures relevant to the interventions above for {label}",
            )
        prompt = f"""You are a health economics advisor for {programme}.

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
{_costs_text(list(req.interventions.keys()), req.disease)}

MONTH-BY-MONTH MODEL FORECAST ({label} target series, through {FORECAST_CAP_DATE}):
{month_table}

YOUR TASK — produce a DETAILED, MONTH-BY-MONTH national budget & deployment plan covering ALL {capped_horizon} forecast months above:

1. MONTH-BY-MONTH DEPLOYMENT TABLE — one row per forecast month. For each month give:
   - units of each intervention to procure/deploy that month ({timing_note}),
   - that month's cost in ₦ and USD,
   - cumulative spend in ₦ and USD,
   - that month's expected cases averted.

2. INTERVENTION COST BREAKDOWN — per intervention: total units over the horizon, unit cost (₦ + USD), total cost (₦ + USD).

3. TOTAL BUDGET SUMMARY — grand total (₦ + USD), cost per case averted (₦ + USD), value-for-money verdict.

4. GEOGRAPHIC PRIORITISATION — top 5–6 highest-burden states to fund first, with an indicative share of budget each.

5. PROCUREMENT & LOGISTICS TIMELINE — lead times, pre-positioning, supply-chain/storage notes.

6. PREVENTION & CONTROL MEASURES — {prevention_line}, and how this budget operationalises them.

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


@app.post("/ews/api/budget-optimize")
def budget_optimize(req: OptimizeReq):
    """Reverse mode: given a budget, the SOLVER (see SOLVER_INTERVENTIONS /
    _solver_allocate above) computes the mathematically optimal intervention
    mix -- the LLM's job is now ONLY to write up the plan narrative around
    those real numbers, never to decide the allocation itself (see the module
    note above _solver_build_params for why: an LLM was shown to leave 15-20%
    of budget unspent, skip cost-effective options, and misjudge its own
    plan's impact by ~13%, versus the solver's provably-optimal allocation)."""
    if req.disease not in SOLVER_INTERVENTIONS_BY_DISEASE:
        raise HTTPException(400, f"Budget planning requires unit costs, not yet configured for '{req.disease}'")
    disease_solver = SOLVER_INTERVENTIONS_BY_DISEASE[req.disease]
    label = _disease_label(req.disease)

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

    # ── the actual decision: solved, not asked of the LLM ───────────────────
    params = _solver_build_params(base_avg, pop, req.disease)
    solved = _solver_allocate(params, req.budget_ngn)
    # % of current level, for the UI's existing sliders / for the user to
    # further hand-tune afterward through the normal elasticity mechanism --
    # derived from coverage achieved (spend / full-coverage cost), not a
    # re-fit, so it's an honest "how much of the addressable gap this budget
    # closes", not a fabricated number.
    interventions = {}
    for name, d in disease_solver.items():
        fc = params[name]["full_cost"]
        cov = (solved["spend"][name] / fc) if fc > 0 else 0.0
        pct = round(max(0.0, min(200.0, cov * 100.0)), 1)
        if pct > 0:
            interventions[d["col"]] = pct
    pct_reduction = min(95.0, 100.0 * solved["avert"] / base_avg) if base_avg > 0 else 0.0

    # whatif series = base scaled DIRECTLY by the solver's own computed
    # impact (not round-tripped through the pct/elasticity approximation
    # above, so the chart stays faithful to the validated model).
    frac = pct_reduction / 100.0
    whatif_monthly_full = [v * (1 - frac) for v in base_monthly_full]

    # ── LLM: narration only, from the solver's real numbers ────────────────
    load_dotenv(override=True)
    api_key = os.getenv("GROQ_API_KEY", "")
    plan = None
    if api_key:
        try:
            from groq import Groq
            client = Groq(api_key=api_key)
            alloc_lines = "\n".join(
                f'  - "{d["col"]}": ₦{solved["spend"][name]:,.0f} (${solved["spend"][name]/USD_NGN:,.0f}) '
                f'-> {100*solved["spend"][name]/params[name]["full_cost"] if params[name]["full_cost"] else 0:.0f}% of full coverage'
                for name, d in disease_solver.items()
            )
            programme = "Nigeria's National Malaria Elimination Programme (NMEP)" if req.disease == "malaria" else f"Nigeria's national {label} programme"
            metric_label = "confirmed malaria cases" if req.disease == "malaria" else f"{label} target metric"
            prompt = f"""You are writing up a {label} budget plan for {programme}. A mathematical
optimiser (an exhaustive concave-resource-allocation solver maximising cases
averted under the budget constraint) already DECIDED the intervention mix
below. Do NOT change, second-guess, or re-allocate it -- your only job is to
write the narrative plan around these already-optimal numbers. Stay entirely
within {label} -- do not reference any other disease's programmes, seasons, or interventions.

Geographic scope: {scope}
Total budget: ₦{req.budget_ngn:,.0f} (${req.budget_ngn/USD_NGN:,.0f})
Forecast horizon: {capped_horizon} months, through {FORECAST_CAP_DATE}
Population: {pop:,.0f}
Baseline forecast (no new action): ~{base_avg:,.0f} {metric_label}/month

OPTIMISER'S ALLOCATION (use exactly these figures verbatim):
{alloc_lines}
  TOTAL SPEND: ₦{solved['total_spend']:,.0f} (${solved['total_spend']/USD_NGN:,.0f}) of ₦{req.budget_ngn:,.0f} budget
  PROJECTED IMPACT: ~{solved['avert']:,.0f} cases averted/month ({pct_reduction:.1f}% reduction vs baseline), sustained across the {capped_horizon}-month horizon

Write, in this order: (1) one line stating this allocation comes from an exhaustive mathematical optimisation, not a discretionary AI choice; (2) month-by-month deployment table (partial ramp-up in month 1, full allocation from month 2 onward, through {capped_horizon} months); (3) cost breakdown per intervention in ₦ AND USD; (4) total spend vs budget with headroom; (5) expected cases averted per month and cumulative; (6) geographic prioritisation notes for {scope}; (7) risks. Use markdown tables with a header row and a `---` separator row."""
            resp = client.chat.completions.create(
                model="llama-3.1-8b-instant", messages=[{"role": "user", "content": prompt}],
                max_tokens=3000, temperature=0.3,
            )
            plan = resp.choices[0].message.content
        except Exception:
            plan = None
    if not plan:
        # The solver's numbers stand on their own even without AI narration.
        lines = "\n".join(
            f'- **{name}** (`{d["col"]}`): ₦{solved["spend"][name]:,.0f} (${solved["spend"][name]/USD_NGN:,.0f})'
            for name, d in disease_solver.items())
        plan = (f"**Optimiser-selected allocation** — ₦{solved['total_spend']:,.0f} "
                f"(${solved['total_spend']/USD_NGN:,.0f}) of the ₦{req.budget_ngn:,.0f} budget:\n\n{lines}\n\n"
                f"**Projected impact:** ~{solved['avert']:,.0f} cases averted/month "
                f"({pct_reduction:.1f}% reduction) over {capped_horizon} months.\n\n"
                f"_AI narrative unavailable (GROQ_API_KEY not set) -- showing the solver's raw output; "
                f"the allocation above is real, only the write-up is missing._")

    return {
        "plan": plan,
        "interventions": interventions,
        "history": base_run["history"],
        "base": [{"date": d, "cases": v} for d, v in zip(months_full, base_monthly_full)],
        "whatif": [{"date": d, "cases": v} for d, v in zip(months_full, whatif_monthly_full)],
        "population": pop,
        "budget_ngn": req.budget_ngn,
        "solver": {
            "method": "Water-filling / concave resource-allocation solver -- provably optimal for this problem "
                      "class, validated against exhaustive brute-force search (test_budget_solver.py).",
            "allocation_ngn": solved["spend"],
            "total_spend_ngn": round(solved["total_spend"], 2),
            "cases_averted_per_month": round(solved["avert"], 1),
            "pct_reduction": round(pct_reduction, 1),
        },
    }


# ── proposal persistence (versioned, deletable) ──────────────────────────────
@app.get("/ews/api/proposals")
def list_proposals(disease: str = "malaria"):
    items = _load_proposals()
    return [it for it in items if it.get("disease", "malaria") == disease]

@app.post("/ews/api/proposals")
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

@app.delete("/ews/api/proposals/{pid}")
def delete_proposal(pid: str):
    items = _load_proposals()
    new = [it for it in items if it.get("id") != pid]
    _save_proposals(new)
    return {"deleted": pid, "remaining": len(new)}


@app.post("/ews/api/compare-proposals")
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


# ── comparative benchmarking (LGA vs peers vs state vs national) ────────────
class BenchmarkReq(BaseModel):
    disease: str = "malaria"
    target: str
    state_name: str
    lgas: List[str] = []        # peer LGAs to compare (within state_name)
    horizon_months: int = 12
    self_lga: Optional[str] = None  # the "home" LGA the user is benchmarking, if any


_LGA_SERIES_CACHE: dict = {}


def _fetch_lga_series(disease: str, target: str) -> pd.DataFrame:
    """[state, lga, year, month, value] for every LGA nationally -- the
    common input both the chart data and the indicator-options list need.

    Cached per (disease, target) for the life of the process: this result is
    IDENTICAL regardless of state_name (state filtering happens client-side
    in Python after the fetch, both here and in benchmark_options below), so
    every state click / every disease switch was re-running the exact same
    live warehouse query from scratch -- 19-21s for a facility-level NCD
    indicator, easily long enough that the Comparative Benchmarking tab
    looked permanently blank/broken to anyone who didn't wait that long.
    Same cache-for-process-lifetime pattern already used by
    etl_warehouse_common._POP_LOOKUP_CACHE for the same reason."""
    cache_key = (disease, target)
    if cache_key in _LGA_SERIES_CACHE:
        return _LGA_SERIES_CACHE[cache_key]
    result = _fetch_lga_series_uncached(disease, target)
    _LGA_SERIES_CACHE[cache_key] = result
    return result


def _fetch_lga_series_uncached(disease: str, target: str) -> pd.DataFrame:
    if disease == "malaria":
        df = get_df()
        if target not in df.columns:
            raise HTTPException(400, f"Unknown target '{target}' for malaria")
        return df[["state", "lga", "year", "month", target]].rename(columns={target: "value"})
    cfg = dc.DISEASES.get(disease, {})
    # A disease's own forecast_target can be a DERIVED label (e.g. HIV's "HIV
    # positive tests (HTS_TST_POS, NDARS Total Male+Female)") that is never
    # itself a row in dim_indicator_master -- only its forecast_target_components
    # are real indicator names. Passing the derived label straight through
    # raised "Indicator(s) [...] not found", which silently emptied the
    # Comparative Benchmarking dropdown (the frontend's fetch .catch() swallowed
    # the error). Resolve to the real component names + system_id whenever the
    # requested target matches this disease's configured forecast_target.
    if target == cfg.get("forecast_target"):
        fetch_names = cfg.get("forecast_target_components", target)
        return ewc.fetch_fact_series(disease, fetch_names, level="lga", system_id=cfg.get("forecast_target_system_id"))
    return ewc.fetch_fact_series(disease, target, level="lga")


@app.get("/ews/api/benchmark/options")
def benchmark_options(disease: str = "malaria", state_name: str = ""):
    """Indicator choices + the LGA list for a given state, so the frontend's
    indicator dropdown and peer-LGA picker are populated from real data."""
    meta = get_meta(disease)
    targets = meta["targets"] or meta["all_numeric"][:1]
    if not targets:
        raise HTTPException(400, f"No comparable indicator available for '{disease}'")
    target = targets[0]
    lga_df = _fetch_lga_series(disease, target)
    lgas = sorted(lga_df[lga_df["state"] == state_name]["lga"].dropna().unique().tolist()) if state_name else []
    display_label = dc.DISEASES.get(disease, {}).get("target_display_label")
    return {"targets": targets, "lgas": lgas, "target_display_label": display_label}


def _reseasonalize(hist_dates, hist_vals, fc_dates, fc_vals):
    """Reshape a smoothed multi-step-ahead forecast so it follows the SAME
    calendar-month seasonal pattern already present in that exact series' own
    real history, while preserving the model's total predicted volume over the
    forecast horizon exactly (only WHEN cases happen is reshaped, not HOW MANY).

    Why this exists: the XGBoost forecast (forecast_lga.parquet) is a genuine
    conditional model with seasonal-harmonic features, and it DOES produce a
    real rainy-season hump at national/state grain. But a recursive multi-step
    forecast leans harder on lag/rolling-mean features with each month further
    out, so for a single noisier LGA the 12-month-ahead trajectory can come out
    far flatter than that LGA's own historical swings (e.g. a real 5,000-65,000
    historical range collapsing to a 13,000-24,000 forecast range) -- a known
    dampening effect of recursive tree-based forecasts on noisy series, not a
    seasonality the model failed to learn at all. Rescaling each forecast month
    by that SAME series' own historical seasonal index restores a believable
    cyclical shape grounded in real data, without changing the model's own
    total-volume prediction for the horizon.
    """
    hv = [float(v) for v in hist_vals if v is not None]
    if len(hist_vals) < 6 or sum(hv) <= 0 or not fc_vals:
        return fc_vals
    months_h = [int(d.split("-")[1]) for d in hist_dates]
    overall_mean = sum(hv) / len(hv)
    if overall_mean <= 0:
        return fc_vals
    month_sums, month_counts = {}, {}
    for m, v in zip(months_h, hist_vals):
        if v is None:
            continue
        month_sums[m] = month_sums.get(m, 0.0) + float(v)
        month_counts[m] = month_counts.get(m, 0) + 1
    seasonal_index = {m: (month_sums[m] / month_counts[m]) / overall_mean for m in month_sums}
    months_f = [int(d.split("-")[1]) for d in fc_dates]
    shaped = [float(v or 0) * seasonal_index.get(m, 1.0) for v, m in zip(fc_vals, months_f)]
    shaped_sum, orig_sum = sum(shaped), sum(float(v or 0) for v in fc_vals)
    if shaped_sum <= 0 or orig_sum <= 0:
        return fc_vals
    scale = orig_sum / shaped_sum
    return [v * scale for v in shaped]


@app.post("/ews/api/benchmark")
def benchmark(req: BenchmarkReq):
    lga_all = _fetch_lga_series(req.disease, req.target)
    lga_all = lga_all.dropna(subset=["value"])
    lga_all["date"] = lga_all["year"].astype(str) + "-" + lga_all["month"].astype(str).str.zfill(2)

    national_avg = (lga_all.groupby("date")["value"].mean()
                     .reset_index().rename(columns={"value": "National Average"}))
    state_sub = lga_all[lga_all["state"] == req.state_name]
    if state_sub.empty:
        raise HTTPException(400, f"No data for state '{req.state_name}' in disease '{req.disease}'")
    state_avg = (state_sub.groupby("date")["value"].mean()
                  .reset_index().rename(columns={"value": "State Average"}))

    out = national_avg.merge(state_avg, on="date", how="outer")
    for lga in req.lgas:
        s = (state_sub[state_sub["lga"] == lga].groupby("date")["value"].sum()
             .reset_index().rename(columns={"value": lga}))
        out = out.merge(s, on="date", how="outer")

    out = out.sort_values("date").reset_index(drop=True)
    # Trim trailing months with no real reported data (e.g. a parquet's date
    # range can extend past the last actually-reported month, leaving zero/NaN
    # placeholder rows) -- horizon should reflect the most recent REAL data,
    # not those placeholders. Mirrors trim_trailing_zeros()'s logic above.
    nonzero = out.index[out["State Average"].fillna(0) > 0]
    if len(nonzero):
        out = out.loc[: nonzero[-1]]
    out = out.fillna(0)
    if req.horizon_months:
        out = out.tail(req.horizon_months)

    # ── Model forecast continuation ────────────────────────────────────────
    # The benchmark chart previously stopped at the last reported month. For the
    # confirmed-case indicator -- the one our XGBoost model actually forecasts
    # (forecast_lga.parquet) -- extend every line (national avg, state avg, each
    # peer LGA) into the future with the model's projection, on the same
    # per-LGA-mean basis the historical lines use, so the chart shows where the
    # model expects each series to head. Other indicators have no forecast, so
    # they simply keep ending at the last real month. Each line is then
    # reseasonalized against ITS OWN real history (see _reseasonalize) so the
    # forecast carries a believable cyclical shape instead of the flatter
    # trajectory a recursive multi-step forecast produces for noisier series.
    forecast_start = None
    if req.disease == "malaria" and req.target == "MAL - Malaria cases confirmed (number)":
        try:
            fc = pd.read_parquet("forecast_lga.parquet")
            fc = fc[fc["is_forecast"] == True].copy()
            if not fc.empty:
                fc["date"] = (fc["ym"] // 12).astype(int).astype(str) + "-" + \
                             ((fc["ym"] % 12) + 1).astype(int).astype(str).str.zfill(2)
                nat_fc = fc.groupby("date")["cases_pred"].mean().reset_index().rename(columns={"cases_pred": "National Average"})
                st_fc_sub = fc[fc["state"] == req.state_name]
                st_fc = st_fc_sub.groupby("date")["cases_pred"].mean().reset_index().rename(columns={"cases_pred": "State Average"})
                fout = nat_fc.merge(st_fc, on="date", how="outer")
                for lga in req.lgas:
                    s = (st_fc_sub[st_fc_sub["lga"] == lga].groupby("date")["cases_pred"].sum()
                         .reset_index().rename(columns={"cases_pred": lga}))
                    fout = fout.merge(s, on="date", how="outer")
                last_hist = out["date"].max() if not out.empty else ""
                fout = fout[fout["date"] > last_hist].sort_values("date").reset_index(drop=True)
                if not fout.empty:
                    forecast_start = fout["date"].min()
                    fc_dates = fout["date"].tolist()

                    nat_hist = national_avg.sort_values("date")
                    fout["National Average"] = _reseasonalize(
                        nat_hist["date"].tolist(), nat_hist["National Average"].tolist(),
                        fc_dates, fout["National Average"].fillna(0).tolist())

                    st_hist = state_avg.sort_values("date")
                    fout["State Average"] = _reseasonalize(
                        st_hist["date"].tolist(), st_hist["State Average"].tolist(),
                        fc_dates, fout["State Average"].fillna(0).tolist())

                    for lga in req.lgas:
                        if lga not in fout.columns:
                            continue
                        lga_hist = (state_sub[state_sub["lga"] == lga].groupby("date")["value"].sum()
                                    .reset_index().sort_values("date"))
                        fout[lga] = _reseasonalize(
                            lga_hist["date"].tolist(), lga_hist["value"].tolist(),
                            fc_dates, fout[lga].fillna(0).tolist())

                    out = pd.concat([out, fout], ignore_index=True).fillna(0)
        except Exception:
            pass

    series_cols = [c for c in out.columns if c != "date"]
    return {
        "dates": out["date"].tolist(),
        "series": {c: [round(float(v), 2) for v in out[c].tolist()] for c in series_cols},
        "lga_options": sorted(state_sub["lga"].dropna().unique().tolist()),
        "forecast_start": forecast_start,
    }


class BenchmarkInsightReq(BaseModel):
    disease: str = "malaria"
    target: str
    state_name: str
    lgas: List[str]
    dates: List[str]
    series: Dict[str, List[float]]
    budget_context: Optional[str] = None  # free-text, e.g. a selected proposal's summary
    spike_context: Optional[str] = None  # free-text, real z-score spike/anomaly detection computed client-side from the same series above


def _fetch_influencing_factors(state_name: str, lgas: List[str], dates: List[str]) -> str:
    """Real monthly figures for a broad set of malaria-relevant covariates, for
    the same state (or its selected LGAs) and the same date range as the
    benchmark chart -- malaria only, since these live in agg_lga_pop.parquet.
    Without this, the LLM has nothing but a bare comparison table to reason
    from and can only guess at WHY a month moved -- this is the actual data it
    needs to ground a real, non-invented, granular explanation. Deliberately
    broader than just rain/temp: humidity, testing coverage, and IPTp coverage
    are all real drivers of confirmed-case counts, not just weather."""
    try:
        df = get_df()
    except Exception:
        return ""
    sub = df[df["state"] == state_name]
    if lgas:
        sub = sub[sub["lga"].isin(lgas)]
    if sub.empty:
        return ""
    sub = sub.copy()
    sub["date"] = sub["year"].astype(str) + "-" + sub["month"].astype(str).str.zfill(2)
    cols = {
        "rainfall_mm_day": ("rain_mm", "mean"), "temperature_mean_c": ("temp_c", "mean"),
        "humidity_pct": ("humidity_pct", "mean"),
        "ACT Given - Total": ("act_given", "sum"), "LLIN given – Total": ("llin_given", "sum"),
        "MAL - Malaria cases tested with RDT": ("rdt_tested", "sum"),
        "Fever Testing Rate": ("fever_testing_rate_pct", "mean"),
        "% of all Antenatal care clients receiving malaria IPT": ("iptp_coverage_pct", "mean"),
    }
    have = {c: alias for c, (alias, _) in cols.items() if c in sub.columns}
    if not have:
        return ""
    agg = {c: cols[c][1] for c in have}
    g = sub.groupby("date").agg(agg).reset_index()
    g = g[g["date"].isin(dates[-12:])]
    if g.empty:
        return ""
    # Classify each factor as LOW/MODERATE/HIGH relative to the terciles of
    # THIS period's own data, computed here in Python -- not left for the LLM
    # to eyeball. A small/fast model asked to judge "is 0.0mm high or low"
    # from a bare number alone was observed calling the exact same 0.0mm value
    # "relatively high" in one month and "relatively low" in another within
    # the SAME response -- a real, checkable error, not a style issue. Handing
    # over a precomputed, internally-consistent label removes that failure
    # mode entirely instead of hoping a bigger model gets it right.
    def _label(series):
        valid = series.dropna()
        if len(valid) < 3:
            return {i: "" for i in series.index}
        lo, hi = valid.quantile(1 / 3), valid.quantile(2 / 3)
        out = {}
        for i, v in series.items():
            if pd.isna(v):
                out[i] = ""
            elif v <= lo:
                out[i] = "LOW for this period"
            elif v >= hi:
                out[i] = "HIGH for this period"
            else:
                out[i] = "MODERATE for this period"
        return out
    labels = {c: _label(g[c]) for c in have}
    lines = []
    for idx, r in g.sort_values("date").iterrows():
        parts = [f"{have[c]}={r[c]:.1f} ({labels[c][idx]})" for c in have if pd.notna(r[c])]
        lines.append(f"{r['date']}: " + ", ".join(parts))
    return "\n".join(lines)


def _fetch_top_facilities(state_name: str, lgas: List[str], dates: List[str]) -> str:
    """Which SPECIFIC facilities actually drove an LGA's case count, for the
    last 2 real reported months -- live per-facility warehouse query (same
    source facility_api.py's drill-down panel uses). Without this, "Aba North
    reported 1919 cases" is an LGA-level abstraction with no ground truth
    underneath it; naming the 2-3 facilities that made up most of that total
    is what the user asked for ("this facility or these facilities... whatever
    recorded"). Malaria only, and capped to the first 3 LGAs and last 2 months
    to bound latency (each LGA is its own live warehouse round-trip)."""
    if not lgas:
        return ""
    try:
        import facility_api as fac
    except Exception:
        return ""
    recent_yms = dates[-2:] if len(dates) >= 2 else dates[-1:]
    lines = []
    for lga in lgas[:3]:
        try:
            rows = fac._fetch_facility_rows(state_name, lga)
        except Exception:
            continue
        if rows.empty:
            continue
        cases_s = fac._lookup(rows, fac._IND_CASES)
        if cases_s.empty:
            continue
        for ym in recent_yms:
            month_vals = [(f, v) for (f, y), v in cases_s.items() if y == ym and pd.notna(v) and v > 0]
            if not month_vals:
                continue
            month_vals.sort(key=lambda t: -t[1])
            total = sum(v for _, v in month_vals)
            top = month_vals[:3]
            top_txt = "; ".join(f"{name} ({v:.0f} cases, {100*v/total:.0f}% of {lga}'s total)" for name, v in top)
            lines.append(f"{lga}, {ym}: {len(month_vals)} reporting facilities, {total:.0f} total cases. Top facilities: {top_txt}")
    return "\n".join(lines)


def _fetch_forecast_tail(state_name: str, lgas: List[str]) -> str:
    """Full forward-looking summary from forecast_lga.parquet (the real
    conditional XGBoost forecast, ~12 months) -- only meaningful for the
    primary confirmed-cases target, since that's the only indicator this
    model forecasts. Each forecast month is paired with the HISTORICAL
    average rainfall/temperature for that same calendar month (from real past
    years) -- without this, there is no real seasonal data for future months
    at all, and the LLM was observed inventing claims like "expected increase
    in rainfall" for forecast months with no grounding whatsoever. This gives
    it an honest, real basis for seasonal reasoning about the forecast."""
    try:
        fc = pd.read_parquet("forecast_lga.parquet")
    except Exception:
        return ""
    sub = fc[fc["state"] == state_name]
    if lgas:
        sub = sub[sub["lga"].isin(lgas)]
    fc_sub = sub[sub["is_forecast"] == True]
    if fc_sub.empty:
        return ""
    g = fc_sub.groupby(["year", "month"])["cases_pred"].sum().reset_index().sort_values(["year", "month"])

    # historical (actual-only) same-calendar-month climatology for rain/temp
    clim = {}
    try:
        df = get_df()
        hist = df[df["state"] == state_name]
        if lgas:
            hist = hist[hist["lga"].isin(lgas)]
        for c, alias in (("rainfall_mm_day", "avg_rain_mm"), ("temperature_mean_c", "avg_temp_c")):
            if c in hist.columns:
                clim[alias] = hist.groupby("month")[c].mean()
    except Exception:
        pass

    lines = []
    for r in g.itertuples():
        extra = []
        for alias, series in clim.items():
            v = series.get(r.month)
            if pd.notna(v):
                extra.append(f"{alias}={v:.1f} (historical average for this calendar month across past years)")
        extra_txt = f" [{', '.join(extra)}]" if extra else ""
        lines.append(f"{int(r.year)}-{int(r.month):02d}: {r.cases_pred:,.0f} projected confirmed cases{extra_txt}")
    return "\n".join(lines)


@app.post("/ews/api/benchmark-insight")
def benchmark_insight(req: BenchmarkInsightReq):
    load_dotenv(override=True)
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    client = Groq(api_key=api_key)

    label = _disease_label(req.disease)
    cols = list(req.series.keys())
    rows = []
    for i, d in enumerate(req.dates[-12:], start=max(0, len(req.dates) - 12)):
        row = ", ".join(f"{c}={req.series[c][i]:.1f}" for c in cols if i < len(req.series.get(c, [])))
        rows.append(f"{d}: {row}")
    table_text = "\n".join(rows)
    budget_line = f"\nBudget context the user is planning against: {req.budget_context}" if req.budget_context else ""
    spike_line = (f"\n\nSTATISTICAL SPIKE DETECTION (computed directly from the comparison data above, real "
                  f"z-scores, not an LLM judgment call): {req.spike_context} -- when writing the sections below, "
                  f"explicitly call out any flagged spike by name and how many standard deviations above its own "
                  f"recent baseline it is; if none were flagged, don't mention spikes at all." if req.spike_context else "")
    lga_list = ", ".join(req.lgas) if req.lgas else "(none selected -- compare state vs national only)"

    factors_text = _fetch_influencing_factors(req.state_name, req.lgas, req.dates) if req.disease == "malaria" else ""
    factors_block = (f"\n\nReal monthly INFLUENCING FACTORS for the same period -- rainfall (mm/day), mean "
                      f"temperature (°C), humidity (%), ACT courses given, LLIN nets distributed, RDT tests "
                      f"done, Fever Testing Rate (% of fever cases actually tested), and IPTp coverage among "
                      f"pregnant women (%). Each figure already has a (LOW/MODERATE/HIGH for this period) label "
                      f"computed from the real data -- ALWAYS use that given label when describing whether a "
                      f"figure was high or low, do NOT independently judge a raw number yourself (a bare number "
                      f"like 0.0mm can be LOW in one dataset's range and unremarkable in another's -- the label "
                      f"is already correct for this dataset, trust it):\n{factors_text}" if factors_text else "")

    is_primary_target = (req.target == DEFAULT_TARGETS[0]) if req.disease == "malaria" else False
    forecast_text = _fetch_forecast_tail(req.state_name, req.lgas) if is_primary_target else ""
    n_fc_months = forecast_text.count("\n") + 1 if forecast_text else 0
    forecast_block = (f"\n\nReal forecast for the next {n_fc_months} months (from the conditional XGBoost "
                       f"model -- real projections, not a guess). Each month also lists the HISTORICAL average "
                       f"rainfall/temperature for that same calendar month across past years, in [brackets] -- "
                       f"there is no actual future weather data, so use ONLY this historical seasonal average "
                       f"to reason about seasonality, never invent a claim like \"rainfall is expected to "
                       f"increase\" that isn't grounded in the bracketed figures:\n{forecast_text}" if forecast_text else "")

    facility_text = _fetch_top_facilities(req.state_name, req.lgas, req.dates) if req.disease == "malaria" else ""
    facility_block = (f"\n\nREAL FACILITY-LEVEL detail for the most recent reported month(s) -- exactly which "
                       f"named health facilities reported the cases behind the LGA totals above, and what share "
                       f"of the LGA's total each one was responsible for:\n{facility_text}" if facility_text else "")

    n_hist_months = len(req.dates[-12:])
    prompt = f"""You are a public health advisor for Nigeria's FMOH, writing for a non-technical reader (a
programme manager, not a data scientist). Plain language, no jargon. Be THOROUGH, not brief -- this is a
detailed monthly review, not a summary. Do not compress or skip any month to save space.

Disease: {label}. Indicator: {req.target}. State: {req.state_name}.
Selected LGA(s) for comparison: {lga_list}
Monthly comparison data ({n_hist_months} months of real reported history, LGA value(s) vs State Average vs
National Average):
{table_text}{factors_block}{forecast_block}{facility_block}{budget_line}{spike_line}

Write a detailed, granular explanation with these sections:

## Month by month (the past {n_hist_months} months)
Give EVERY SINGLE MONTH its own short paragraph or bullet -- do NOT group months together, do NOT skip any
month, even if several months tell a similar story (in that case, still write each one out, briefly noting
"same pattern as last month" if genuinely repetitive, but never omit a month). For each month, state: (1) the
actual number and how it compares to the state/national average that month, (2) the specific real
influencing factor(s) from the data above that plausibly explain it (e.g. "rainfall was unusually high at
Xmm/day, which combined with only Y% Fever Testing Rate means many cases likely went undetected" or "IPTp
coverage rose to X%, coinciding with the dip in cases among pregnant women's risk group"). If no factors data
was given for a month, say the comparison plainly without inventing a reason. This section should be the
LONGEST part of your answer.
{("## Which facilities actually reported these cases" + chr(10) + "For the most recent month(s) listed in the FACILITY-LEVEL detail above, name the SPECIFIC facilities that made up the LGA's total -- do not just repeat the LGA-level number as an abstraction. State how many facilities reported, which 2-3 accounted for most of the cases, and what share of the LGA total each was responsible for. If one facility dominates the total, call that out explicitly (it may indicate a genuine local outbreak point, or a reporting concentration worth checking). If no facility-level data was given, skip this section.") if facility_text else ""}
{("## What the forecast shows (the next " + str(n_fc_months) + " months)" + chr(10) + "Walk through the forecast months with the same granularity -- do not just summarize the trend, explain WHY each stretch of months is projected higher or lower, grounded in seasonality (compare to the same calendar months in the historical data above) and recent momentum (the last few real months' trajectory). Never invent a reason not grounded in the data given.") if forecast_text else ""}
## What this means for {req.state_name}
2-3 plain-language takeaways comparing the selected LGA(s) to the state/national picture, synthesising the
month-by-month pattern AND the facility-level concentration above (e.g. is the burden spread across many
facilities or concentrated in one or two, and is the gap vs state/national widening, narrowing, or seasonal).
## Recommended next steps
Two to three concrete, actionable planning recommendations specific to these LGAs -- and where the facility
data supports it, name the SPECIFIC facility the recommendation should target, not just the LGA in general.

Reference only the actual figures given above -- never invent a cause, an intervention, a facility name, or a
number not shown. This should be a genuinely detailed, long-form review (expect 900-1300+ words) --
thoroughness matters more than brevity here. Plain conversational language throughout, but do not sacrifice
detail for length."""

    # llama-3.1-8b-instant (used elsewhere for speed) was observed making a
    # real reasoning error here: labelling the SAME 0.0mm rainfall value
    # "relatively high" in one month and "relatively low" in another within
    # one response. This prompt asks for real quantitative comparison across
    # 24 months of data, which needs a stronger model -- llama-3.3-70b-versatile
    # is already used elsewhere in this codebase for the equivalent-depth
    # outbreak-planning briefs.
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=4000,
        temperature=0.3,
    )
    return {"insight": resp.choices[0].message.content}


# ── News & Intervention Alerts (autonomous, no user-configured rules) ───────
# Read-only feed: posts are fetched/classified entirely by news_pipeline.py,
# run on a schedule external to this API process (run_news_scheduler.py or
# OS cron calling `python news_pipeline.py`). These routes only ever READ
# news_alerts.json and, for ops/testing, allow forcing one pipeline pass --
# there is deliberately no per-post/per-rule user configuration here.
@app.get("/ews/api/news-alerts")
def list_news_alerts(disease: Optional[str] = None, severity: Optional[str] = None,
                      alert_worthy_only: bool = True, limit: int = 50):
    import news_store
    items = news_store.load_alerts()
    if alert_worthy_only:
        items = [a for a in items if a.get("is_alert_worthy")]
    if disease:
        items = [a for a in items if a.get("disease") == disease]
    if severity:
        items = [a for a in items if a.get("severity") == severity]
    return items[:limit]


@app.get("/ews/api/news-outbreaks")
def list_news_outbreaks(disease: Optional[str] = None):
    """Consolidated outbreak-intelligence objects -- one per outbreak (not
    per weekly report), each with a stitched multi-week trajectory and a
    single rich AI planning brief. This is the primary view the dashboard
    renders; /api/news-alerts remains the raw per-report feed."""
    import news_store
    items = news_store.load_outbreaks()
    if disease:
        items = [o for o in items if o.get("disease") == disease]
    return items


# The news pipeline (scrape many sources -> re-extract NCDC PDFs -> one LLM call
# per new post) can take minutes on a first run, so it MUST NOT block the API
# request thread. run-now launches it in a daemon thread and returns immediately;
# the dashboard's Refresh button polls /status until it finishes, then reloads.
import threading as _threading

_news_run_state = {"running": False, "last_summary": None, "last_error": None,
                   "last_started": None, "last_finished": None}
_news_run_lock = _threading.Lock()


def _news_run_worker():
    from datetime import datetime, timezone
    try:
        from news_pipeline import run_once
        summary = run_once()
        _news_run_state["last_summary"] = summary
        _news_run_state["last_error"] = None
    except Exception as e:  # never let a pipeline failure wedge the flag
        _news_run_state["last_error"] = f"{e.__class__.__name__}: {e}"
    finally:
        _news_run_state["last_finished"] = datetime.now(timezone.utc).isoformat()
        _news_run_state["running"] = False


@app.post("/ews/api/news-alerts/run-now")
def run_news_pipeline_now():
    """Trigger one pipeline pass in the background. Returns immediately with
    {status}. If a run is already in flight, it is not duplicated. Poll
    /api/news-alerts/status for completion."""
    from datetime import datetime, timezone
    with _news_run_lock:
        if _news_run_state["running"]:
            return {"status": "already_running", **_news_run_state}
        _news_run_state["running"] = True
        _news_run_state["last_started"] = datetime.now(timezone.utc).isoformat()
    _threading.Thread(target=_news_run_worker, daemon=True).start()
    return {"status": "started", **_news_run_state}


@app.get("/ews/api/news-alerts/status")
def news_pipeline_status():
    """Current state of the background news pipeline run (for the dashboard's
    Refresh button to poll)."""
    return _news_run_state


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8001, reload=True)
