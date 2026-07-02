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


# ── multi-factor facility burden ────────────────────────────────────────────
# An ABSOLUTE clinical burden score (0-100), comparable across every facility in
# the country, built only from indicators the DHIS2 facility feed actually
# carries. This replaces the earlier "LGA burden × caseload ratio" which
# saturated at 100 for any busy facility (a tiny within-LGA mean made ratios
# explode) — so every LGA looked like a wall of identical "100 Red" facilities,
# useless for deciding which facility to prioritise. Being absolute + multi-
# factor, scores differentiate, rarely hit 100, and a low-volume LGA's
# facilities stay low without any artificial anchoring.
#
# Weights (renormalised over whichever indicators a facility actually reports):
#   volume 45  · test-positivity 25  · treatment-gap 18  · diagnostic-gap 12
# LLIN/net data is far too sparse at facility grain (~4% of rows) to score on.
_VOL_CAP_LOG = float(np.log1p(865.0))   # national P99 of positive facility-month confirmed cases
_POS_LO, _POS_HI = 0.40, 1.00           # observed positivity spans ~0.4-1.0; stretch it to 0-1
_FACTOR_META = {
    "volume":        {"weight": 45.0, "label": "Case volume",     "help": "Confirmed cases, log-scaled vs the national P99 (~865/mo)"},
    "positivity":    {"weight": 25.0, "label": "Test positivity", "help": "Confirmed ÷ RDT tested, stretched over the 40-100% range"},
    "treatment_gap": {"weight": 18.0, "label": "Treatment gap",   "help": "Confirmed cases not covered by an ACT course"},
    "diagnostic_gap":{"weight": 12.0, "label": "Diagnostic gap",  "help": "Presumed (unconfirmed) share of total reported cases"},
}


def _num(v):
    try:
        f = float(v)
        return None if np.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _fac_score(cases, posr, tg, pf):
    """Absolute 0-100 burden + per-factor breakdown. posr/tg/pf are None when the
    facility didn't report the underlying indicator; their weight is dropped and
    the rest renormalised, so a score is never penalised for missing data."""
    c = max(0.0, cases or 0.0)
    comps = [("volume", 45.0, min(1.0, float(np.log1p(c)) / _VOL_CAP_LOG))]
    if posr is not None:
        comps.append(("positivity", 25.0, min(1.0, max(0.0, (min(1.0, posr) - _POS_LO) / (_POS_HI - _POS_LO)))))
    if tg is not None:
        comps.append(("treatment_gap", 18.0, min(1.0, max(0.0, tg))))
    if pf is not None:
        comps.append(("diagnostic_gap", 12.0, min(1.0, max(0.0, pf))))
    W = sum(w for _, w, _ in comps) or 1.0
    raw = 100.0 * sum(w * s for _, w, s in comps) / W
    factors = {name: {"sub": round(s, 3), "points": round(100.0 * w * s / W, 1), "weight": round(100.0 * w / W, 1)}
               for name, w, s in comps}
    return round(raw, 1), factors


@facility_router.get("/api/facilities")
def list_facilities(disease: str = "malaria", state: str = "", lga: str = ""):
    """Facilities in one LGA with a per-month caseload AND an absolute, multi-
    factor clinical burden score (see _fac_score). Caseloads still sum exactly to
    the LGA (the forecast tail is the LGA's SARIMAX trajectory disaggregated by
    each facility's trailing-12-month share). On forecast months the burden uses
    the facility's trailing structural profile (positivity / treatment / diagnostic
    mix) applied to its projected volume — so it stays meaningful ahead of time.
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
             "n_facilities": 0, "months": [], "facilities": [], "lga_cases": [], "factor_meta": _FACTOR_META}
    if sub.empty:
        return empty

    # real reporting months for this LGA (DHIS2 leaves empty tail rows)
    rep = sub.groupby("ym")["cases"].sum(min_count=1)
    actual_yms = sorted([ym for ym, v in rep.items() if pd.notna(v) and v > 0])[-_ACTUAL_WINDOW:]
    if not actual_yms:
        return empty
    last_real = actual_yms[-1]

    a = sub[sub["ym"].isin(actual_yms)]

    def _mat(col):
        return (a.groupby(["facility", "ym"])[col].sum(min_count=1).unstack("ym").reindex(columns=actual_yms)
                if col in a.columns else pd.DataFrame(index=a["facility"].unique(), columns=actual_yms, dtype=float))
    casesM, totalM, actM, rdtM = _mat("cases"), _mat("total"), _mat("act"), _mat("rdt_tested")
    facilities = list(casesM.index)

    # trailing-12-month structural profile per facility (used for forecast months)
    last12 = actual_yms[-12:]
    Csum, Rsum, Asum, Tsum = (casesM[last12].sum(axis=1), rdtM[last12].sum(axis=1),
                              actM[last12].sum(axis=1), totalM[last12].sum(axis=1))
    posr_str = {f: (Csum[f] / Rsum[f]) if Rsum.get(f, 0) and Rsum[f] > 0 else None for f in facilities}
    tg_str = {f: max(0.0, (Csum[f] - (Asum[f] or 0)) / Csum[f]) if Csum.get(f, 0) and Csum[f] > 0 else None for f in facilities}
    pf_str = {f: (Tsum[f] - Csum[f]) / Tsum[f] if Tsum.get(f, 0) and Tsum[f] > 0 else None for f in facilities}

    # forecast: disaggregate the LGA's SARIMAX forecast by facility share (cases
    # still sum to the LGA forecast exactly).
    fc_yms, fc_mat = [], None
    fclga = _fc_lga()
    if fclga is not None:
        lg = fclga[(fclga["state"] == state) & (fclga["lga"] == lga) & (fclga["ym"] > last_real)].sort_values("ym")
        if not lg.empty:
            fc_yms = lg["ym"].tolist()
            lga_fc = dict(zip(lg["ym"], pd.to_numeric(lg["cases_pred"], errors="coerce").fillna(0.0)))
            denom = Csum.sum()
            share = (Csum / denom) if denom > 0 else pd.Series(1.0 / max(1, len(facilities)), index=facilities)
            fc_mat = pd.DataFrame({ym: share * lga_fc[ym] for ym in fc_yms})

    full = casesM if fc_mat is None or fc_mat.empty else pd.concat([casesM, fc_mat], axis=1)
    full = full.loc[:, ~full.columns.duplicated()]
    yms = list(full.columns)
    fc_set = set(fc_yms)

    ward_of = sub.groupby("facility")["ward"].agg(lambda s: s.dropna().iloc[0] if s.dropna().size else None).to_dict()

    def ctx12(fac):
        return {"cases": _num(Csum.get(fac)), "act": _num(Asum.get(fac)),
                "rdt_tested": _num(Rsum.get(fac)), "total": _num(Tsum.get(fac))}

    out_fac = []
    for fac in facilities:
        series = []
        for ym in yms:
            forecast = ym in fc_set
            cval = full.at[fac, ym] if fac in full.index else np.nan
            c = None if pd.isna(cval) else float(cval)
            pt = {"ym": ym, "label": _label(ym), "forecast": forecast,
                  "cases": None if c is None else round(c)}
            if forecast:
                if c is not None:
                    b, fdet = _fac_score(c, posr_str[fac], tg_str[fac], pf_str[fac])
                    pt.update(burden=b, zone=_zone(b), factors=fdet,
                              inputs={"positivity": _clip01(posr_str[fac]), "treatment_gap": _clip01(tg_str[fac]),
                                      "diagnostic_gap": _clip01(pf_str[fac]), "structural": True,
                                      "rdt_tested": _num(Rsum.get(fac)), "act": _num(Asum.get(fac)), "total": _num(Tsum.get(fac))})
            else:
                rdt = _num(rdtM.at[fac, ym]) if fac in rdtM.index else None
                act = _num(actM.at[fac, ym]) if fac in actM.index else None
                tot = _num(totalM.at[fac, ym]) if fac in totalM.index else None
                cc = c or 0.0
                posr = (cc / rdt) if (rdt and rdt > 0) else None
                tg = max(0.0, (cc - act) / cc) if (cc > 0 and act is not None) else None
                pf = ((tot - cc) / tot) if (tot and tot > 0) else None
                if cc > 0:
                    b, fdet = _fac_score(cc, posr, tg, pf)
                    pt.update(burden=b, zone=_zone(b), factors=fdet,
                              inputs={"positivity": _clip01(posr), "treatment_gap": _clip01(tg),
                                      "diagnostic_gap": _clip01(pf), "structural": False,
                                      "rdt_tested": rdt, "act": act, "total": tot})
                else:
                    pt.update(burden=0.0, zone=_zone(0.0))
            series.append(pt)
        latest = next((p for p in reversed(series) if not p["forecast"] and p.get("cases")), None)
        out_fac.append({"facility": fac, "ward": ward_of.get(fac),
                        "latest_actual_ym": last_real,
                        "latest_cases": latest["cases"] if latest else None,
                        "latest_burden": latest.get("burden") if latest else None,
                        "context_12m": ctx12(fac), "series": series})
    out_fac.sort(key=lambda f: (f["latest_burden"] if f["latest_burden"] is not None else -1), reverse=True)

    # LGA total caseload per month — facilities sum to this, by construction.
    lga_cases = [{"ym": ym, "label": _label(ym), "forecast": ym in fc_set,
                  "cases": None if full[ym].isna().all() else round(float(full[ym].sum()))} for ym in yms]
    months = [{"ym": ym, "label": _label(ym), "forecast": ym in fc_set} for ym in yms]
    return {"available": True, "disease": disease, "state": state, "lga": lga,
            "n_facilities": len(facilities), "months": months, "factor_meta": _FACTOR_META,
            "facilities": out_fac, "lga_cases": lga_cases}


def _round(v, nd=3):
    v = _num(v)
    return None if v is None else round(v, nd)


def _clip01(v, nd=3):
    """Clamp a display ratio to [0,1] (positivity can exceed 1 and gaps can go
    negative when confirmed cases come via microscopy rather than RDT/total)."""
    v = _num(v)
    return None if v is None else round(max(0.0, min(1.0, v)), nd)


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
    factors: Optional[dict] = None       # per-factor breakdown {name:{sub,points,weight}}
    inputs: Optional[dict] = None        # raw indicator values {positivity, treatment_gap, ...}


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
               f"RDT tests done: {round(c['rdt_tested']) if c.get('rdt_tested') is not None else 'n/a'}, "
               f"total reported (confirmed+presumed): {round(c['total']) if c.get('total') is not None else 'n/a'}.")

    inp = req.inputs or {}
    def _pct(x): return f"{round(x * 100)}%" if isinstance(x, (int, float)) else "n/a"
    drivers_txt = (f"Burden drivers for this facility — test positivity: {_pct(inp.get('positivity'))}, "
                   f"treatment gap (confirmed cases without an ACT course): {_pct(inp.get('treatment_gap'))}, "
                   f"diagnostic gap (presumed share of reported cases): {_pct(inp.get('diagnostic_gap'))}.")

    prompt = f"""You are a malaria surveillance officer at Nigeria's National Malaria Elimination Programme.
Write a concise, decision-ready RISK ASSESSMENT for a single health facility for a FORECAST (future) month.

Facility: {req.facility}{f' (ward: {req.ward})' if req.ward else ''}
Location: {req.lga} LGA, {req.state} State, Nigeria
Forecast month being assessed: {req.label or req.ym}
Projected confirmed malaria cases that month: {round(req.cases) if req.cases is not None else 'n/a'}
Facility burden score (0-100, an ABSOLUTE clinical score comparable across all Nigerian facilities — blends case volume, test positivity, treatment gap and diagnostic gap): {req.burden if req.burden is not None else 'n/a'} -> zone "{req.zone or 'n/a'}"{f', ranked {req.lga_rank} among its LGA facilities' if req.lga_rank else ''}
{drivers_txt}
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
