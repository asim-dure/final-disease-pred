"""
Facility drill-down API — one level more granular than the LGA burden the
Visual Overview map already shows. Click an LGA -> list its health facilities;
click a facility -> its per-month burden score; on a FORECAST month, generate an
AI risk assessment.

Data source (malaria): facility_malaria.parquet (built by build_facility_index.py
from the same 993MB DHIS2 facility CSV that aggregate.py rolls up to LGA/state).
Facility burden is computed with the SAME volume+trend, percentile-blended logic
the rest of the app uses (etl_warehouse_common.burden_score), but ranked WITHIN
each LGA's own facilities per month — so a facility's colour means "how it ranks
against its LGA peers", the natural read at this grain.

Facility forecast is a top-down disaggregation: the LGA's own SARIMAX forecast
(forecast_lga.parquet) split across facilities by each facility's trailing-12-month
share of the LGA's confirmed cases. Standard, transparent, and consistent with the
LGA trajectory the map already trusts — no fragile per-facility model on sparse data.

Mounted on the existing FastAPI app (no new port/process), same pattern as ews_nlp.
Malaria is fully supported; other diseases return available:false with a reason so
the UI degrades honestly rather than breaking.
"""
import os
import logging

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from dotenv import load_dotenv

log = logging.getLogger("facility_api")
facility_router = APIRouter()

_HERE = os.path.dirname(__file__)
_FAC_PARQUET = os.path.join(_HERE, "facility_malaria.parquet")
_FC_LGA_PARQUET = os.path.join(_HERE, "forecast_lga.parquet")

_FAC_DF: pd.DataFrame | None = None
_FC_LGA: pd.DataFrame | None = None

# months the map actually shows for malaria (burden.json) start at 2024-01;
# keep a generous trailing window so the panel aligns without bloating payloads.
_ACTUAL_WINDOW = 48

_ZONE_THRESHOLDS = [(18, "Not a Hotspot"), (38, "Green"), (58, "Yellow"), (78, "Amber")]
_ZONE_COLORS = {"Red": "#dc2626", "Amber": "#ea580c", "Yellow": "#ca8a04", "Green": "#16a34a", "Not a Hotspot": "#64748b"}
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _zone(score: float) -> str:
    if score is None or (isinstance(score, float) and np.isnan(score)):
        return "Not a Hotspot"
    for t, label in _ZONE_THRESHOLDS:
        if score < t:
            return label
    return "Red"


def _fac_df() -> pd.DataFrame:
    global _FAC_DF
    if _FAC_DF is None:
        if not os.path.exists(_FAC_PARQUET):
            raise HTTPException(503, "facility_malaria.parquet not built yet (run build_facility_index.py)")
        df = pd.read_parquet(_FAC_PARQUET)
        df["ym"] = df["year"].astype(int).astype(str) + "-" + df["month"].astype(int).astype(str).str.zfill(2)
        _FAC_DF = df
    return _FAC_DF


def _fc_lga() -> pd.DataFrame | None:
    global _FC_LGA
    if _FC_LGA is None:
        try:
            df = pd.read_parquet(_FC_LGA_PARQUET)
            df["ym"] = df["year"].astype(int).astype(str) + "-" + df["month"].astype(int).astype(str).str.zfill(2)
            _FC_LGA = df
        except Exception as e:
            log.warning(f"forecast_lga.parquet unavailable: {e}")
            _FC_LGA = False
    return _FC_LGA if _FC_LGA is not False else None


def _label(ym: str) -> str:
    y, m = ym.split("-")
    return f"{_MONTHS[int(m) - 1]} {y}"


@facility_router.get("/api/facilities")
def list_facilities(disease: str = "malaria", state: str = "", lga: str = ""):
    """Facilities in one LGA with a per-month CASELOAD series (actual + forecast).

    Caseloads sum EXACTLY to the LGA: the forecast tail is the LGA's own SARIMAX
    trajectory (forecast_lga) disaggregated across facilities by each facility's
    trailing-12-month share, so the facility layer aggregates up to the LGA by
    construction. Burden is deliberately NOT scored here — the frontend anchors
    each facility's burden to the LGA's OWN burden score (the exact value the map
    shows for the selected month) via caseload share, so the facilities average
    up to that LGA score and a "Not a Hotspot" LGA can never be full of red
    facilities. Only a facility whose caseload runs well above its LGA average
    can exceed the LGA's zone — which is exactly the signal worth surfacing.
    """
    if not state or not lga:
        raise HTTPException(400, "state and lga are required")
    if disease != "malaria":
        return {"available": False, "disease": disease, "state": state, "lga": lga,
                "reason": "Facility-level drill-down is currently available for malaria "
                          "(the only disease with a facility-grain source loaded). Other "
                          "diseases are aggregated at LGA level in this build."}

    df = _fac_df()
    sub = df[(df["state"] == state) & (df["lga"] == lga)].copy()
    empty = {"available": True, "disease": disease, "state": state, "lga": lga,
             "n_facilities": 0, "months": [], "facilities": [], "lga_cases": []}
    if sub.empty:
        return empty

    # real reporting months for this LGA (DHIS2 leaves empty tail rows)
    rep = sub.groupby("ym")["cases"].sum(min_count=1)
    actual_yms = sorted([ym for ym, v in rep.items() if pd.notna(v) and v > 0])[-_ACTUAL_WINDOW:]
    if not actual_yms:
        return empty
    last_real = actual_yms[-1]

    a = sub[sub["ym"].isin(actual_yms)]
    cases = (a.groupby(["facility", "ym"])["cases"].sum(min_count=1)
             .unstack("ym").reindex(columns=actual_yms))
    facilities = list(cases.index)

    # forecast: disaggregate the LGA's SARIMAX forecast by facility share so the
    # facility forecasts SUM to the LGA forecast exactly.
    fc_yms, fc_mat = [], None
    fclga = _fc_lga()
    if fclga is not None:
        lg = fclga[(fclga["state"] == state) & (fclga["lga"] == lga) & (fclga["ym"] > last_real)].sort_values("ym")
        if not lg.empty:
            fc_yms = lg["ym"].tolist()
            lga_fc = dict(zip(lg["ym"], pd.to_numeric(lg["cases_pred"], errors="coerce").fillna(0.0)))
            last12 = cases[actual_yms[-12:]].sum(axis=1)
            denom = last12.sum()
            share = (last12 / denom) if denom > 0 else pd.Series(1.0 / max(1, len(facilities)), index=facilities)
            fc_mat = pd.DataFrame({ym: share * lga_fc[ym] for ym in fc_yms})

    full = cases if fc_mat is None or fc_mat.empty else pd.concat([cases, fc_mat], axis=1)
    full = full.loc[:, ~full.columns.duplicated()]
    yms = list(full.columns)
    forecast_flag = {ym: (ym in set(fc_yms)) for ym in yms}

    ward_of = sub.groupby("facility")["ward"].agg(lambda s: s.dropna().iloc[0] if s.dropna().size else None).to_dict()

    def ctx12(fac):
        r = sub[(sub["facility"] == fac) & (sub["ym"].isin(actual_yms[-12:]))]
        g = lambda c: float(pd.to_numeric(r[c], errors="coerce").sum()) if c in r.columns else None
        return {"cases": g("cases"), "act": g("act"), "llin": g("llin"), "rdt_tested": g("rdt_tested")}

    out_fac = []
    for fac in facilities:
        series = [{"ym": ym, "label": _label(ym), "forecast": forecast_flag[ym],
                   "cases": None if pd.isna(full.at[fac, ym]) else round(float(full.at[fac, ym]))} for ym in yms]
        out_fac.append({"facility": fac, "ward": ward_of.get(fac),
                        "latest_actual_ym": last_real,
                        "latest_cases": None if pd.isna(full.at[fac, last_real]) else round(float(full.at[fac, last_real])),
                        "context_12m": ctx12(fac), "series": series})
    out_fac.sort(key=lambda f: (f["latest_cases"] if f["latest_cases"] is not None else -1), reverse=True)

    # LGA total caseload per month — facilities sum to this, by construction.
    lga_cases = [{"ym": ym, "label": _label(ym), "forecast": forecast_flag[ym],
                  "cases": None if full[ym].isna().all() else round(float(full[ym].sum()))} for ym in yms]
    months = [{"ym": ym, "label": _label(ym), "forecast": forecast_flag[ym]} for ym in yms]
    return {"available": True, "disease": disease, "state": state, "lga": lga,
            "n_facilities": len(facilities), "months": months,
            "facilities": out_fac, "lga_cases": lga_cases}


class FacilityRiskReq(BaseModel):
    disease: str = "malaria"
    state: str
    lga: str
    facility: str
    ward: Optional[str] = None
    ym: str                      # the selected month (must be a forecast month)
    label: Optional[str] = None
    burden: Optional[float] = None
    zone: Optional[str] = None
    cases: Optional[float] = None
    lga_rank: Optional[str] = None       # e.g. "3 of 18"
    recent: Optional[List[dict]] = None  # last few months [{label, cases, forecast}]
    context_12m: Optional[dict] = None


def _risk_level(burden: Optional[float], zone: Optional[str]) -> str:
    if zone in ("Red",):
        return "Critical"
    if zone in ("Amber",):
        return "High"
    if zone in ("Yellow",):
        return "Moderate"
    if burden is not None and burden >= 78:
        return "Critical"
    return "Elevated" if (burden or 0) >= 38 else "Low"


@facility_router.post("/api/facility-risk")
def facility_risk(req: FacilityRiskReq):
    """AI risk assessment for one facility at a FORECAST month. Deterministic
    risk_level from the burden/zone, plus a Groq-written planning narrative."""
    load_dotenv(override=True)
    level = _risk_level(req.burden, req.zone)

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    client = Groq(api_key=api_key)

    recent_txt = "\n".join(
        f"  {r.get('label')}: {round(r.get('cases')) if r.get('cases') is not None else 'n/a'} confirmed cases"
        f"{' (forecast)' if r.get('forecast') else ''}"
        for r in (req.recent or [])
    ) or "  (no recent series provided)"
    c = req.context_12m or {}
    ctx_txt = (f"Trailing 12 months at this facility — confirmed cases: {round(c['cases']) if c.get('cases') is not None else 'n/a'}, "
               f"ACT courses given: {round(c['act']) if c.get('act') is not None else 'n/a'}, "
               f"LLINs distributed: {round(c['llin']) if c.get('llin') is not None else 'n/a'}, "
               f"RDT tests done: {round(c['rdt_tested']) if c.get('rdt_tested') is not None else 'n/a'}.")

    prompt = f"""You are a malaria surveillance officer at Nigeria's National Malaria Elimination Programme.
Write a concise, decision-ready RISK ASSESSMENT for a single health facility for a FORECAST (future) month.

Facility: {req.facility}{f' (ward: {req.ward})' if req.ward else ''}
Location: {req.lga} LGA, {req.state} State, Nigeria
Forecast month being assessed: {req.label or req.ym}
Projected confirmed malaria cases that month: {round(req.cases) if req.cases is not None else 'n/a'}
Facility burden score (0-100, ranked against the {req.lga} LGA's own facilities): {req.burden if req.burden is not None else 'n/a'} -> zone "{req.zone or 'n/a'}"{f', ranked {req.lga_rank} in its LGA' if req.lga_rank else ''}
Recent & projected trajectory:
{recent_txt}
{ctx_txt}

Write in markdown with these short sections:
## Risk Outlook
One paragraph: what the forecast implies for THIS facility that month, referencing the projected case number and how it ranks within its LGA. Be specific and numeric.
## Why (drivers)
2-3 bullets on the likely drivers, grounded ONLY in the numbers above (case trajectory, testing/ACT/LLIN context, seasonality of the month). Never invent figures.
## Recommended Actions (pre-positioning)
3-4 bullets of concrete, facility-level actions to take in the 4-6 weeks BEFORE this month (commodities: RDTs, ACTs, LLINs; staffing; supervision), sized to a single facility — not a national plan.
## Monitoring Triggers
1-2 numeric triggers that should escalate the response.

Keep it under 260 words. This is a forward-looking planning brief, so frame everything as "prepare for", not "responded to"."""

    resp = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=700,
        temperature=0.3,
    )
    return {"risk_level": level, "zone": req.zone, "burden": req.burden,
            "risk_assessment": resp.choices[0].message.content}
