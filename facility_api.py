"""
Facility drill-down API — one level more granular than the LGA burden the
Visual Overview map already shows. Click an LGA -> list its health facilities;
click a facility -> its per-month burden score; on a FORECAST month, generate an
AI risk assessment.

Data source (malaria): a local pre-aggregated snapshot, facility_malaria.parquet,
built by build_facility_index.py from the same facility-grain DHIS2 export
(final_malaria_data.csv) the warehouse itself was loaded from. This used to be a
LIVE query against public.fact_indicator_data_malaria (admin_level=7) on every
request, but that table has no index on geo_admin_location_key or indicator_key
(confirmed via EXPLAIN), so every single facility-panel open forced a full
sequential scan of 24.5M+ rows -- 70-90+ seconds, even for a single LGA. Reading
the local parquet instead (loaded into memory once, then filtered per request)
is milliseconds. The tradeoff, stated plainly: this is a SNAPSHOT, not a live
read -- it only reflects the warehouse as of whenever build_facility_index.py
was last run (see the parquet's own mtime, surfaced in _SOURCE_META below), not
the current second. Re-run build_facility_index.py to refresh it. The fetched
rows are reshaped into the same long/row-wise shape (one row per facility x
month x indicator) the rest of this module already expects, so nothing
downstream of _fetch_facility_rows needed to change.

Facility burden is an absolute multi-factor clinical score (see _fac_score),
NOT re-ranked within the LGA, so a facility's colour is comparable nationally.

Facility forecast is a top-down disaggregation: the LGA's own SARIMAX forecast
(forecast_lga.parquet -- a derived model output, not raw source data, so it stays
file-based) split across facilities by each facility's trailing-12-month share of
the LGA's confirmed cases. Standard, transparent, and consistent with the LGA
trajectory the map already trusts -- no fragile per-facility model on sparse data.

Mounted on the existing FastAPI app (no new port/process), same pattern as ews_nlp.
Malaria is fully supported; other diseases return available:false with a reason so
the UI degrades honestly rather than breaking.
"""
import os
import json
import time
import logging

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from dotenv import load_dotenv

import warehouse as wh

log = logging.getLogger("facility_api")
facility_router = APIRouter()

# In-process response cache, keyed by (disease, state, lga). The live warehouse
# query this endpoint depends on (see _fetch_facility_rows) does a full
# sequential scan of public.fact_indicator_data_malaria (24.5M+ rows) on every
# call -- confirmed via EXPLAIN that neither geo_admin_location_key nor
# indicator_key is indexed on that table, so Postgres has no way to seek
# directly to one LGA's rows. That's a warehouse-side fix (an index the DB
# owner needs to add; this app's connection is read-only and cannot run DDL).
# Until then, caching the assembled response is the honest mitigation available
# here: it doesn't speed up the FIRST open of a given LGA, but every repeat
# open (same LGA, or a second user/session) is instant instead of re-paying
# the full scan. TTL is long because this is warehouse data that updates at
# most daily, not something that needs second-by-second freshness.
_FACILITY_CACHE: dict[tuple, tuple[float, dict]] = {}
_FACILITY_CACHE_TTL = 6 * 3600

_HERE = os.path.dirname(__file__)
_FC_LGA_PARQUET = os.path.join(_HERE, "forecast_lga.parquet")
_FACILITY_INDEX_PARQUET = os.path.join(_HERE, "facility_malaria.parquet")

_FC_LGA: pd.DataFrame | None = None
_FACILITY_INDEX: pd.DataFrame | None = None

# Warehouse indicator names (exact match against dim_indicator_master.indicator_name)
# used for the live facility query, mapped to short internal keys.
_MIN_YEAR = 2023  # MAL confirmed-cases target has no meaningful signal before this
_IND_CASES = "MAL - Malaria cases confirmed (number)"
_IND_TOTAL = "MAL - Total reported malaria cases (confirmed + presumed)"
_IND_ACT = "ACT Given - Total"
_IND_RDT = "MAL - Malaria cases tested with RDT"
_IND_TESTRATE = "Fever Testing Rate"  # replaces saturating RDT-positivity (see _fac_score)

def _facility_index_built_at() -> str | None:
    try:
        import datetime
        return datetime.datetime.fromtimestamp(os.path.getmtime(_FACILITY_INDEX_PARQUET)).isoformat(timespec="minutes")
    except Exception:
        return None


_SOURCE_META = {
    "warehouse_table": "public.fact_indicator_data_malaria (via a local snapshot, not a live read -- see query_mode)",
    "geo_table": "public.dim_geo_location_master",
    "indicator_table": "public.dim_indicator_master",
    "grain": "admin_level = 7 (health facility)",
    "min_year": _MIN_YEAR,
    "snapshot_built_at": _facility_index_built_at(),
    "query_mode": "Local snapshot (facility_malaria.parquet), NOT a live warehouse read -- "
                   "public.fact_indicator_data_malaria has no index on geo_admin_location_key or "
                   "indicator_key (confirmed via EXPLAIN), so a live per-request query was a "
                   "70-90+ second full scan of 24.5M+ rows. Run build_facility_index.py to refresh "
                   "this snapshot from the current warehouse export; see snapshot_built_at above "
                   "for how stale it currently is. The assembled response is additionally cached "
                   f"in-process for up to {_FACILITY_CACHE_TTL // 3600}h per (state, LGA).",
    "indicators": [
        {"name": _IND_CASES, "role": "Confirmed malaria cases (case volume)"},
        {"name": _IND_TOTAL, "role": "Total reported (confirmed + presumed) -- diagnostic gap"},
        {"name": _IND_ACT, "role": "ACT courses given -- treatment gap"},
        {"name": _IND_RDT, "role": "RDT tests done (context only)"},
        {"name": _IND_TESTRATE, "role": "Fever Testing Rate -- testing gap (replaces RDT positivity)"},
    ],
}

# months the map actually shows for malaria (burden.json) start at 2024-01;
# keep a generous trailing window so the panel aligns without bloating payloads.
_ACTUAL_WINDOW = 48

# Raised bar for what counts as a hotspot at all: most LGAs/facilities should
# read "Not a Hotspot" (0-59) rather than every area getting a colour. Only
# genuinely elevated burden (60+) earns a hotspot tier, spread across four
# 10-11 point bands (Green/Yellow/Amber/Red) so the map actually discriminates
# among true hotspots instead of clustering everything into Amber/Red.
_ZONE_THRESHOLDS = [(60, "Not a Hotspot"), (71, "Green"), (81, "Yellow"), (91, "Amber")]
_ZONE_COLORS = {"Red": "#dc2626", "Amber": "#ea580c", "Yellow": "#ca8a04", "Green": "#16a34a", "Not a Hotspot": "#64748b"}
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _zone(score: float) -> str:
    if score is None or (isinstance(score, float) and np.isnan(score)):
        return "Not a Hotspot"
    for t, label in _ZONE_THRESHOLDS:
        if score < t:
            return label
    return "Red"


# Wide-format facility_malaria.parquet column -> the warehouse indicator_name
# string the rest of this module (built for the old live-query row shape)
# already keys everything off of. "llin" exists in the parquet but isn't part
# of _fac_score's four factors, so it's intentionally not mapped here.
_INDEX_COL_TO_INDICATOR = {
    "cases": _IND_CASES,
    "total": _IND_TOTAL,
    "act": _IND_ACT,
    "rdt_tested": _IND_RDT,
    "fever_testing_rate": _IND_TESTRATE,
}


def _facility_index() -> pd.DataFrame | None:
    global _FACILITY_INDEX
    if _FACILITY_INDEX is None:
        try:
            df = pd.read_parquet(_FACILITY_INDEX_PARQUET)
            _FACILITY_INDEX = df
        except Exception as e:
            log.warning(f"facility_malaria.parquet unavailable: {e}")
            _FACILITY_INDEX = False
    return _FACILITY_INDEX if _FACILITY_INDEX is not False else None


def _fetch_facility_rows(state: str, lga: str) -> pd.DataFrame:
    """One LGA's facility-grain indicator rows, from the local
    facility_malaria.parquet snapshot (see the module docstring for why this
    isn't a live warehouse query anymore). Returns them reshaped into the same
    row-wise shape the rest of this module already expects (one row per
    facility x month x indicator) -- melting a wide snapshot row into 5
    long-format rows, mirroring exactly what the old SQL query returned, so
    _lookup() and everything downstream needed zero changes."""
    idx = _facility_index()
    if idx is None:
        raise HTTPException(503, "facility_malaria.parquet is missing -- run build_facility_index.py")
    sub = idx[(idx["state"] == state) & (idx["lga"] == lga) & (idx["year"] >= _MIN_YEAR)]
    empty_cols = ["ward", "facility", "year", "month", "indicator_name", "value", "ym"]
    if sub.empty:
        return pd.DataFrame(columns=empty_cols)
    parts = []
    for col, indicator_name in _INDEX_COL_TO_INDICATOR.items():
        if col not in sub.columns:
            continue
        part = sub[["ward", "facility", "year", "month", col]].rename(columns={col: "value"}).dropna(subset=["value"])
        if part.empty:
            continue
        part["indicator_name"] = indicator_name
        parts.append(part)
    if not parts:
        return pd.DataFrame(columns=empty_cols)
    rows = pd.concat(parts, ignore_index=True)
    rows["ym"] = rows["year"].astype(int).astype(str) + "-" + rows["month"].astype(int).astype(str).str.zfill(2)
    return rows


def _lookup(rows: pd.DataFrame, indicator_name: str) -> pd.Series:
    """(facility, ym) -> summed value for one indicator, straight off the
    row-wise fetch -- a lookup Series, not a reshaped/pivoted matrix."""
    sub = rows[rows["indicator_name"] == indicator_name]
    if sub.empty:
        return pd.Series(dtype=float)
    return sub.groupby(["facility", "ym"])["value"].sum()


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
# The "test positivity" factor (confirmed ÷ RDT tested) was flagged by the
# manager as reading too high almost everywhere: clinicians mostly test cases
# they already suspect are malaria, so the ratio clusters near 90-100% at most
# facilities and stops discriminating. It's replaced with a TESTING GAP factor
# built from the warehouse's own "Fever Testing Rate" indicator (% of fever
# cases actually given a parasitological test) -- a clean 0-100 signal that
# does NOT saturate, and captures a genuinely different risk: facilities that
# under-test are the ones most likely to be missing/mistreating real cases.
#
# Weights (renormalised over whichever indicators a facility actually reports):
#   volume 45  · testing-gap 25  · treatment-gap 18  · diagnostic-gap 12
# LLIN/net data is far too sparse at facility grain (~4% of rows) to score on.
_VOL_CAP_LOG = float(np.log1p(865.0))   # national P99 of positive facility-month confirmed cases

# Empirical stretch: sampling 671 real facilities across the country's worst
# LGAs (Kaduna North, Alimosho, Umunneochi, Bindawa, Takai, Abuja Municipal --
# chosen BECAUSE they're the highest-burden LGAs nationally, so this sample is
# already biased toward the worst facilities in Nigeria, not a random draw)
# found the single worst facility in the country scored only 86.9 raw, and the
# 90th percentile among these already-worst facilities was 52.7. Even a
# facility simultaneously near the national P99 case volume AND with poor
# testing/treatment/diagnostic gaps could not reach the 91+ Red band under the
# manager's raised thresholds -- because in practice most facilities (even
# busy ones) test and treat reasonably well, so the gap factors rarely all
# max out together the way the raw formula's theoretical ceiling assumes.
# This stretch maps that empirically-observed ceiling (~87) up to ~100, so
# the genuinely worst real facility in Nigeria actually reads Red, while
# median facilities (raw ~36 per the same sample) stay comfortably under the
# Not-a-Hotspot line. This is a FIXED constant (not recomputed per request),
# so the score stays absolute/comparable everywhere -- not a per-LGA or
# per-request rank, which was deliberately removed earlier (see note above).
_RAW_STRETCH = 100.0 / 87.0
# `indicator` = the exact dim_indicator_master.indicator_name this factor is
# computed from (so the UI can tell the user precisely which warehouse column
# drives each number, not just a plain-English label). `why_weight` is the
# analyst rationale for that specific weight -- these are NOT machine-learned
# weights (there's no per-facility ground-truth "correct priority" to fit
# against); they're an explicit, disclosed judgment call on how directly each
# indicator predicts where burden/missed-case risk concentrates.
_FACTOR_META = {
    "volume": {
        "weight": 45.0, "label": "Case volume", "indicator": _IND_CASES,
        "help": "Confirmed cases, log-scaled vs the national P99 (~865/mo).",
        "why_weight": "Weighted highest (45%) because raw case volume is the strongest available signal of where transmission is actually concentrated -- the other three factors refine that ranking, they don't replace it.",
    },
    "testing_gap": {
        "weight": 25.0, "label": "Testing gap", "indicator": _IND_TESTRATE,
        "help": "Share of fever cases NOT given a parasitological test = 100% minus Fever Testing Rate.",
        "why_weight": "Weighted 25% (2nd-highest) -- under-testing is the biggest driver of missed/mistreated cases after volume itself. This replaced an earlier 'RDT positivity' factor (confirmed ÷ RDT tested) that clustered near 90-100% at almost every facility (clinicians mostly test cases they already suspect) and stopped discriminating between facilities.",
    },
    "treatment_gap": {
        "weight": 18.0, "label": "Treatment gap", "indicator": _IND_ACT,
        "help": "Confirmed cases not covered by an ACT course (ACT Given - Total vs confirmed cases).",
        "why_weight": "Weighted 18% -- a real gap, but most confirmed cases in this dataset do get an ACT course, so it moves the score less than testing gaps do.",
    },
    "diagnostic_gap": {
        "weight": 12.0, "label": "Diagnostic gap", "indicator": _IND_TOTAL,
        "help": "Presumed (unconfirmed) share of total reported cases (Total reported vs confirmed).",
        "why_weight": "Weighted lowest (12%) -- a real data-quality signal, but the least clinically actionable of the four on its own.",
    },
}
_SCORING_METHOD_NOTE = (
    "These weights are an explicit analyst judgment call, not a fitted/machine-learned model -- "
    "there is no per-facility ground-truth 'correct priority' to train against. The 0-100 raw score "
    "is then multiplied by a fixed empirical stretch factor (100÷87 ≈ 1.15): sampling 671 real "
    "facilities across Nigeria's highest-burden LGAs found the single worst facility in the country "
    "scored only ~86.9 on the raw 0-100 formula, so without this stretch even the genuinely worst "
    "facility in Nigeria could never reach the Red band. The stretch is a fixed constant (not "
    "recomputed per request), so scores stay comparable across every facility and month."
)


# ── HIV facility drill-down ─────────────────────────────────────────────────
# Unlike malaria, no local facility-grain snapshot exists for HIV (that
# pipeline -- build_facility_index.py -- was built from a raw DHIS2 malaria
# export file that has no HIV equivalent), so this queries
# public.fact_indicator_data_hiv LIVE, per (state, LGA), on first open --
# same tradeoff malaria had before its snapshot existed (that table has the
# same missing geo_admin_location_key/indicator_key index), just accepted
# here rather than built around, since verified live this is single-digit
# seconds for one LGA's worth of rows (not malaria's 70-90s full-table
# scan), and the existing in-process cache (_FACILITY_CACHE) already makes
# every repeat open instant regardless.
#
# NDARS (system_id=7) ONLY, per the standing constraint for all HIV data in
# this build. Facility identity comes from dim_geo_location_master's
# location_name (== geo_admin_level7_name at admin_level=7) -- NOT
# geo_admin_level4_name, which is the WARD, a common mistake given malaria's
# own facility_malaria.parquet snapshot exposes a flat "facility" column
# that obscures this distinction.
#
# Facility score reuses the EXACT SAME 5-factor formula as the map/dashboard
# (ui/src/hivBurdenScore.js's hivScoreDetail), ported to Python, minus the
# population-density factor (not meaningful at facility grain) -- its 10
# points are redistributed proportionally across the other four so they
# still sum to 100. Unlike malaria's nationally-calibrated absolute score
# (which took sampling 671 real facilities to calibrate honestly), this is
# scored against the facility's OWN LGA peers (facilities within the same
# LGA), disclosed as such in _HIV_SOURCE_META -- no equivalent national
# facility-level calibration exists for HIV yet.
_HIV_MIN_YEAR = 2023  # matches export_burden_hiv.py's own real-data-window restriction
_HIV_IND = {
    "hts_tested": ["HTS Monthly_1n_HTS_TST Total, Male", "HTS Monthly_1n_HTS_TST Total, Female"],
    "hts_pos": ["HTS Monthly_1n_HTS_TST_POS Total, Male", "HTS Monthly_1n_HTS_TST_POS Total, Female"],
    "art_curr": ["ART Monthly_3_Currently on ART Female", "ART Monthly_3_Currently on ART Male\xa0"],
    "art_vl_tested": ["ART Monthly_6a_Currently on ART with VL result Female", "ART Monthly_6a_Currently on ART with VL result Male"],
}
# min forecastable-facility bar: at least this many real non-zero
# hts_tested-or-hts_pos months within the trailing window, so a facility
# that reported once in passing isn't shown as if it had a real trend --
# directly per the "only show facilities available for forecast" request.
_HIV_FORECASTABLE_MIN_MONTHS = 6

_HIV_FACTOR_META = {
    "case_burden": {
        "weight": 34.0, "label": "Case burden (positivity)", "indicator": "HTS_TST_POS ÷ HTS_TST (this facility vs its LGA peers)",
        "help": "This facility's HIV-positive share of tests, relative to the average positivity rate across facilities in the same LGA.",
        "why_weight": "Weighted highest -- the direct signal of where positive diagnoses are concentrated, same role it plays in the state/national map.",
    },
    "testing_gap": {
        "weight": 22.0, "label": "Testing gap", "indicator": "HTS_TST Total (this facility vs its LGA peers)",
        "help": "How far this facility's testing volume falls short of its LGA peers'.",
        "why_weight": "Under-testing is the biggest driver of missed diagnoses after case burden itself.",
    },
    "art_gap": {
        "weight": 22.0, "label": "ART coverage gap", "indicator": "ART Monthly_3 Currently on ART (this facility vs its LGA peers)",
        "help": "How far this facility's ART coverage falls short of its LGA peers'.",
        "why_weight": "WHO/UNAIDS Treatment-as-Prevention -- a facility whose ART coverage lags its peers is a priority for treatment scale-up.",
    },
    "vl_gap": {
        "weight": 22.0, "label": "VL-monitoring gap", "indicator": "ART Monthly_6a Currently on ART with VL result ÷ Currently on ART",
        "help": "Share of this facility's own ART patients NOT getting a routine viral-load check -- self-contained, no LGA peer needed.",
        "why_weight": "Routine VL monitoring catches treatment failure before it becomes a transmission risk again.",
    },
}
_HIV_SCORING_METHOD_NOTE = (
    "Scored against this facility's OWN LGA peers (facilities reporting in the same LGA), not a "
    "nationally-calibrated absolute scale -- unlike malaria's facility score (calibrated by sampling "
    "671 real facilities nationally), no equivalent national HIV facility-level calibration exists yet, "
    "so this is disclosed as LGA-relative rather than presented as a false absolute. Population-density "
    "(a factor in the state/national map) is dropped at facility grain -- not meaningful at this scale -- "
    "and its 10 points are redistributed proportionally across the other four factors."
)
_HIV_SOURCE_META = {
    "warehouse_table": "public.fact_indicator_data_hiv (LIVE query, system_id=7 / NDARS only)",
    "geo_table": "public.dim_geo_location_master",
    "indicator_table": "public.dim_indicator_master",
    "grain": "admin_level = 7 (health facility)",
    "min_year": _HIV_MIN_YEAR,
    "query_mode": f"Live warehouse read per (state, LGA) on first open -- no local snapshot exists for HIV "
                   f"(unlike malaria's facility_malaria.parquet). Cached in-process for up to "
                   f"{_FACILITY_CACHE_TTL // 3600}h per (state, LGA) after that, so repeat opens are instant.",
    "indicators": [{"name": " + ".join(v), "role": k} for k, v in _HIV_IND.items()],
}

_HIV_BURDEN_RICH_PATH = os.path.join(_HERE, "ui", "public", "data", "after", "hiv", "burden_rich.json")
_HIV_BURDEN_RICH: dict | None = None


def _hiv_burden_rich() -> dict | None:
    global _HIV_BURDEN_RICH
    if _HIV_BURDEN_RICH is None:
        try:
            with open(_HIV_BURDEN_RICH_PATH, encoding="utf-8") as f:
                _HIV_BURDEN_RICH = json.load(f)
        except Exception as e:
            log.warning(f"burden_rich.json unavailable: {e}")
            _HIV_BURDEN_RICH = False
    return _HIV_BURDEN_RICH if _HIV_BURDEN_RICH is not False else None


def _fetch_hiv_facility_rows(state: str, lga: str) -> pd.DataFrame:
    """LIVE facility-grain fetch for one LGA -- see module note above for why
    this isn't a cached local snapshot. Returns long-format rows: one row per
    (facility, field, year, month)."""
    names = [n for names in _HIV_IND.values() for n in names]
    sql = """
        select g.location_name as facility, im.indicator_name, f.year, f.month, f.indicator_value
        from public.fact_indicator_data_hiv f
        join public.dim_geo_location_master g on g.geo_admin_location_key = f.geo_admin_location_key
        join public.dim_indicator_master im on im.indicator_key = f.indicator_key
        where g.geo_admin_level2_name = :state and g.geo_admin_level3_name = :lga
          and g.admin_level = 7 and f.system_id = 7
          and im.indicator_name = ANY(:names) and f.year >= :min_year
          and g.location_name is not null
    """
    df = wh.safe_select(sql, {"state": state, "lga": lga, "names": names, "min_year": _HIV_MIN_YEAR})
    if df.empty:
        return df
    name_to_field = {n: field for field, names in _HIV_IND.items() for n in names}
    df["field"] = df["indicator_name"].map(name_to_field)
    df["ym"] = df["year"].astype(int).astype(str) + "-" + df["month"].astype(int).astype(str).str.zfill(2)
    df["indicator_value"] = pd.to_numeric(df["indicator_value"], errors="coerce").fillna(0.0)
    return df


def _hiv_lga_series(state: str, lga: str) -> tuple[list[dict], int | None]:
    """The LGA's own real+forecast hts_pos monthly series, straight from
    burden_rich.json (the SAME file the map/dashboard reads) -- reused here,
    not recomputed, so the facility forecast tail always sums to exactly
    what the map already shows for this LGA. Returns (months_used, last_real_ym_index)."""
    br = _hiv_burden_rich()
    if br is None:
        return [], None
    key = f"{state}|||{lga}"
    lg = br.get("lgas", {}).get(key)
    months = br.get("months", [])
    if not lg or not months:
        return [], None
    out = []
    last_real_i = None
    for i, m in enumerate(months):
        v = lg.get("hts_pos", [None] * len(months))[i] if i < len(lg.get("hts_pos", [])) else None
        out.append({"ym": m["ym"], "label": m["label"], "forecast": m["forecast"], "cases": v})
        if not m["forecast"]:
            last_real_i = i
    return out, last_real_i


def _hiv_fac_score(x: dict, peer: dict) -> tuple[float, dict]:
    """Direct Python port of hivScoreDetail's formula (ui/src/hivBurdenScore.js),
    minus the density factor (not meaningful at facility grain -- see module
    note). x/peer: {hts_tested, hts_pos, art_curr, art_vl_tested}."""
    def cl(v, lo=0.0, hi=1.0):
        return min(hi, max(lo, v))
    hts_tested = x.get("hts_tested") or 0.0
    hts_pos = x.get("hts_pos") or 0.0
    art_curr = x.get("art_curr") or 0.0
    art_vl = x.get("art_vl_tested") or 0.0
    p_tested = peer.get("hts_tested") or 0.0
    p_pos = peer.get("hts_pos") or 0.0
    p_art = peer.get("art_curr") or 0.0

    case_burden = cl(hts_pos / (p_pos * 2.5)) if p_pos > 0 else (1.0 if hts_pos > 0 else 0.0)
    testing_gap = cl(1.0 - hts_tested / p_tested) if p_tested > 0 else 0.3
    art_gap = cl(1.0 - art_curr / p_art) if p_art > 0 else 0.3
    vl_gap = cl(1.0 - art_vl / art_curr) if art_curr > 0 else 0.5

    comps = [("case_burden", 34.0, case_burden), ("testing_gap", 22.0, testing_gap),
             ("art_gap", 22.0, art_gap), ("vl_gap", 22.0, vl_gap)]
    W = sum(w for _, w, _ in comps)
    raw = min(100.0, 100.0 * sum(w * s for _, w, s in comps) / W)
    factors = {name: {"sub": round(s, 3), "points": round(100.0 * w * s / W, 1), "weight": round(w, 1)} for name, w, s in comps}
    return round(raw, 1), factors


def _build_hiv_facility_response(state: str, lga: str) -> dict:
    empty = {"available": True, "disease": "hiv", "state": state, "lga": lga,
             "n_facilities": 0, "months": [], "facilities": [], "lga_cases": [],
             "factor_meta": _HIV_FACTOR_META, "source": _HIV_SOURCE_META, "scoring_method_note": _HIV_SCORING_METHOD_NOTE}
    rows = _fetch_hiv_facility_rows(state, lga)
    if rows.empty:
        return empty

    def lookup(field):
        sub = rows[rows["field"] == field]
        if sub.empty:
            return pd.Series(dtype=float)
        return sub.groupby(["facility", "ym"])["indicator_value"].sum()

    series_by_field = {f: lookup(f) for f in _HIV_IND}
    all_facilities = sorted(rows["facility"].dropna().unique())
    all_yms = sorted(rows["ym"].unique())

    # forecastable-only filter -- at least N real non-zero hts_tested-or-hts_pos
    # months, per the explicit "only show facilities available for forecast" request.
    tested_s, pos_s = series_by_field["hts_tested"], series_by_field["hts_pos"]
    def n_real_months(fac):
        return sum(1 for ym in all_yms if (tested_s.get((fac, ym), 0) or 0) > 0 or (pos_s.get((fac, ym), 0) or 0) > 0)
    facilities = [f for f in all_facilities if n_real_months(f) >= _HIV_FORECASTABLE_MIN_MONTHS]
    if not facilities:
        return empty

    actual_yms = sorted([ym for ym in all_yms if (tested_s.groupby(level="ym").sum().get(ym, 0) or 0) > 0])[-_ACTUAL_WINDOW:]
    if not actual_yms:
        return empty
    last_real = actual_yms[-1]
    last12 = actual_yms[-12:]

    def sum12(s, fac):
        return sum(float(s.get((fac, ym), 0) or 0) for ym in last12)

    trailing = {fac: {f: sum12(series_by_field[f], fac) for f in _HIV_IND} for fac in facilities}
    denom_pos = sum(t["hts_pos"] for t in trailing.values()) or 1.0
    share = {fac: trailing[fac]["hts_pos"] / denom_pos for fac in facilities}

    # LGA peer average (facility-level trailing totals, averaged across this
    # LGA's own forecastable facilities) -- the reference every facility in
    # THIS LGA is compared against (see module note: LGA-relative, not a
    # nationally-calibrated absolute scale).
    peer = {f: (sum(trailing[fac][f] for fac in facilities) / len(facilities)) for f in _HIV_IND}

    lga_yms, _ = _hiv_lga_series(state, lga)
    fc_yms = [m["ym"] for m in lga_yms if m["forecast"]]
    # Per explicit request: only show facilities that have BOTH real data AND
    # forecast data. The forecast tail is disaggregated from this LGA's own
    # burden_rich.json series (see _hiv_lga_series) -- if that lookup comes
    # back empty (most likely an LGA-name mismatch between
    # dim_geo_location_master and burden_rich.json's own state/lga naming,
    # the same class of spelling mismatch ../lgaAlias.js exists to reconcile
    # for the map), every facility in this LGA would otherwise be shown with
    # real data but silently NO forecast tail -- an honest gap, not something
    # to paper over by showing them anyway.
    if not fc_yms:
        return {**empty, "note": f"Real facility-level HIV data exists for {lga}, but no LGA-level "
                                  f"forecast is available for it in this build, so no facility can meet "
                                  f"the \"real data AND forecast data\" bar. Not shown rather than shown "
                                  f"with a missing forecast."}
    lga_fc = {m["ym"]: (m["cases"] or 0.0) for m in lga_yms if m["forecast"]}
    fc_set = set(fc_yms)
    yms = actual_yms + fc_yms

    out_fac = []
    for fac in facilities:
        series = []
        for ym in yms:
            forecast = ym in fc_set
            if forecast:
                c = share.get(fac, 0.0) * lga_fc.get(ym, 0.0)
                x = {"hts_tested": trailing[fac]["hts_tested"] / 12.0, "hts_pos": c,
                     "art_curr": trailing[fac]["art_curr"] / 12.0, "art_vl_tested": trailing[fac]["art_vl_tested"] / 12.0}
            else:
                c = pos_s.get((fac, ym))
                x = {f: series_by_field[f].get((fac, ym), 0.0) for f in _HIV_IND}
            pt = {"ym": ym, "label": _label(ym), "forecast": forecast, "cases": None if c is None else round(c)}
            if c is not None and c >= 0:
                b, fdet = _hiv_fac_score(x, peer)
                pt.update(burden=b, zone=_zone(b), factors=fdet,
                          inputs={"hts_tested": _num(x["hts_tested"]), "art_curr": _num(x["art_curr"]),
                                  "art_vl_tested": _num(x["art_vl_tested"]), "structural": forecast,
                                  "disagg_share": _num(share.get(fac)) if forecast else None})
            series.append(pt)
        latest = next((p for p in reversed(series) if not p["forecast"] and p.get("cases")), None)
        out_fac.append({"facility": fac, "ward": None, "latest_actual_ym": last_real,
                        "latest_cases": latest["cases"] if latest else None,
                        "latest_burden": latest.get("burden") if latest else None,
                        "context_12m": {"cases": _num(trailing[fac]["hts_pos"]), "hts_tested": _num(trailing[fac]["hts_tested"]),
                                        "art_curr": _num(trailing[fac]["art_curr"]), "art_vl_tested": _num(trailing[fac]["art_vl_tested"])},
                        "series": series})
    out_fac.sort(key=lambda f: (f["latest_burden"] if f["latest_burden"] is not None else -1), reverse=True)

    lga_totals = {ym: 0.0 for ym in yms}
    for fac_out in out_fac:
        for pt in fac_out["series"]:
            if pt["cases"] is not None:
                lga_totals[pt["ym"]] += pt["cases"]
    lga_cases = [{"ym": ym, "label": _label(ym), "forecast": ym in fc_set, "cases": round(lga_totals[ym])} for ym in yms]
    months = [{"ym": ym, "label": _label(ym), "forecast": ym in fc_set} for ym in yms]
    return {"available": True, "disease": "hiv", "state": state, "lga": lga,
            "n_facilities": len(facilities), "months": months, "factor_meta": _HIV_FACTOR_META,
            "facilities": out_fac, "lga_cases": lga_cases, "source": _HIV_SOURCE_META,
            "scoring_method_note": _HIV_SCORING_METHOD_NOTE}


def _num(v):
    try:
        f = float(v)
        return None if np.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _fac_score(cases, test_gap, tg, pf):
    """Absolute 0-100 burden + per-factor breakdown. test_gap/tg/pf are None when
    the facility didn't report the underlying indicator; their weight is dropped
    and the rest renormalised, so a score is never penalised for missing data.
    The empirical _RAW_STRETCH factor (see above) is applied so the score
    actually spans the full Red-reachable range for real Nigerian facilities,
    not just its theoretical formula ceiling."""
    c = max(0.0, cases or 0.0)
    comps = [("volume", 45.0, min(1.0, float(np.log1p(c)) / _VOL_CAP_LOG))]
    if test_gap is not None:
        comps.append(("testing_gap", 25.0, min(1.0, max(0.0, test_gap))))
    if tg is not None:
        comps.append(("treatment_gap", 18.0, min(1.0, max(0.0, tg))))
    if pf is not None:
        comps.append(("diagnostic_gap", 12.0, min(1.0, max(0.0, pf))))
    W = sum(w for _, w, _ in comps) or 1.0
    raw = min(100.0, 100.0 * sum(w * s for _, w, s in comps) / W * _RAW_STRETCH)
    factors = {name: {"sub": round(s, 3), "points": round(100.0 * w * s / W * _RAW_STRETCH, 1), "weight": round(100.0 * w / W, 1)}
               for name, w, s in comps}
    return round(raw, 1), factors


@facility_router.get("/ews/api/facilities")
def list_facilities(disease: str = "malaria", state: str = "", lga: str = ""):
    """Facilities in one LGA with a per-month caseload AND an absolute, multi-
    factor clinical burden score (see _fac_score). Caseloads still sum exactly to
    the LGA (the forecast tail is the LGA's SARIMAX trajectory disaggregated by
    each facility's trailing-12-month share). On forecast months the burden uses
    the facility's trailing structural profile (testing gap / treatment / diagnostic
    mix) applied to its projected volume — so it stays meaningful ahead of time.

    Data comes from the local facility_malaria.parquet snapshot -- see
    _fetch_facility_rows -- not a live warehouse read (see the module docstring
    for why). The assembled response is additionally cached per (disease, state,
    lga) for _FACILITY_CACHE_TTL, so repeat opens skip even the in-memory filter.
    """
    if not state or not lga:
        raise HTTPException(400, "state and lga are required")
    if disease not in ("malaria", "hiv"):
        return {"available": False, "disease": disease, "state": state, "lga": lga,
                "reason": "Facility-level drill-down is currently available for malaria and HIV "
                          "(the only diseases with a facility-grain source loaded). Other "
                          "diseases are aggregated at LGA level in this build."}

    cache_key = (disease, state, lga)
    now = time.time()
    cached = _FACILITY_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _FACILITY_CACHE_TTL:
        return cached[1]

    result = _build_hiv_facility_response(state, lga) if disease == "hiv" else _build_facility_response(disease, state, lga)
    _FACILITY_CACHE[cache_key] = (now, result)
    return result


def _build_facility_response(disease: str, state: str, lga: str) -> dict:
    rows = _fetch_facility_rows(state, lga)
    empty = {"available": True, "disease": disease, "state": state, "lga": lga,
             "n_facilities": 0, "months": [], "facilities": [], "lga_cases": [],
             "factor_meta": _FACTOR_META, "source": _SOURCE_META, "scoring_method_note": _SCORING_METHOD_NOTE}
    if rows.empty:
        return empty

    cases_s = _lookup(rows, _IND_CASES)
    total_s = _lookup(rows, _IND_TOTAL)
    act_s = _lookup(rows, _IND_ACT)
    rdt_s = _lookup(rows, _IND_RDT)
    rate_s = _lookup(rows, _IND_TESTRATE)   # Fever Testing Rate, 0-100 scale

    # real reporting months for this LGA (DHIS2 leaves empty tail rows)
    cases_by_ym = cases_s.groupby(level="ym").sum() if not cases_s.empty else pd.Series(dtype=float)
    all_yms = sorted(rows["ym"].unique())
    actual_yms = sorted([ym for ym in all_yms if cases_by_ym.get(ym, 0) and cases_by_ym.get(ym, 0) > 0])[-_ACTUAL_WINDOW:]
    if not actual_yms:
        return empty
    last_real = actual_yms[-1]
    facilities = sorted(rows["facility"].unique())

    # trailing-12-month structural profile per facility (used for forecast months)
    last12 = actual_yms[-12:]

    def _sum12(s, fac):
        return sum(float(v) for ym in last12 if (v := s.get((fac, ym))) is not None and not pd.isna(v))

    def _avg12(s, fac):
        vals = [float(v) for ym in last12 if (v := s.get((fac, ym))) is not None and not pd.isna(v)]
        return (sum(vals) / len(vals)) if vals else None

    Csum = {f: _sum12(cases_s, f) for f in facilities}
    Rsum = {f: _sum12(rdt_s, f) for f in facilities}
    Asum = {f: _sum12(act_s, f) for f in facilities}
    Tsum = {f: _sum12(total_s, f) for f in facilities}
    RateAvg = {f: _avg12(rate_s, f) for f in facilities}   # trailing avg Fever Testing Rate

    def _gap_str(fac):
        r = RateAvg.get(fac)
        return None if r is None else max(0.0, 1.0 - r / 100.0)
    testgap_str = {f: _gap_str(f) for f in facilities}
    tg_str = {f: max(0.0, (Csum[f] - Asum.get(f, 0.0)) / Csum[f]) if Csum.get(f, 0) > 0 else None for f in facilities}
    pf_str = {f: (Tsum[f] - Csum[f]) / Tsum[f] if Tsum.get(f, 0) > 0 else None for f in facilities}

    # forecast: disaggregate the LGA's SARIMAX forecast by facility share (cases
    # still sum to the LGA forecast exactly). forecast_lga.parquet is a derived
    # model artifact, not raw source data, so it stays file-based.
    fc_yms, lga_fc, share = [], {}, {}
    fclga = _fc_lga()
    if fclga is not None:
        lg = fclga[(fclga["state"] == state) & (fclga["lga"] == lga) & (fclga["ym"] > last_real)].sort_values("ym")
        if not lg.empty:
            fc_yms = lg["ym"].tolist()
            lga_fc = dict(zip(lg["ym"], pd.to_numeric(lg["cases_pred"], errors="coerce").fillna(0.0)))
            denom = sum(Csum.values())
            share = {f: (Csum[f] / denom) if denom > 0 else (1.0 / max(1, len(facilities))) for f in facilities}

    yms = actual_yms + fc_yms
    fc_set = set(fc_yms)

    ward_of = rows.groupby("facility")["ward"].agg(lambda s: s.dropna().iloc[0] if s.dropna().size else None).to_dict()

    def ctx12(fac):
        return {"cases": _num(Csum.get(fac)), "act": _num(Asum.get(fac)),
                "rdt_tested": _num(Rsum.get(fac)), "total": _num(Tsum.get(fac))}

    lga_totals = {ym: 0.0 for ym in yms}
    lga_has_val = {ym: False for ym in yms}

    out_fac = []
    for fac in facilities:
        series = []
        for ym in yms:
            forecast = ym in fc_set
            if forecast:
                c = share.get(fac, 0.0) * lga_fc.get(ym, 0.0)
            else:
                v = cases_s.get((fac, ym))
                c = None if v is None or pd.isna(v) else float(v)
            if c is not None:
                lga_totals[ym] += c
                lga_has_val[ym] = True
            pt = {"ym": ym, "label": _label(ym), "forecast": forecast,
                  "cases": None if c is None else round(c)}
            if forecast:
                if c is not None:
                    b, fdet = _fac_score(c, testgap_str.get(fac), tg_str.get(fac), pf_str.get(fac))
                    pt.update(burden=b, zone=_zone(b), factors=fdet,
                              inputs={"testing_gap": _clip01(testgap_str.get(fac)), "treatment_gap": _clip01(tg_str.get(fac)),
                                      "diagnostic_gap": _clip01(pf_str.get(fac)), "structural": True,
                                      "rdt_tested": _num(Rsum.get(fac)), "act": _num(Asum.get(fac)), "total": _num(Tsum.get(fac)),
                                      "disagg_share": _num(share.get(fac))})
            else:
                rdt = _num(rdt_s.get((fac, ym)))
                act = _num(act_s.get((fac, ym)))
                tot = _num(total_s.get((fac, ym)))
                rate = _num(rate_s.get((fac, ym)))
                cc = c or 0.0
                tgap = max(0.0, 1.0 - rate / 100.0) if rate is not None else None
                tg = max(0.0, (cc - act) / cc) if (cc > 0 and act is not None) else None
                pf = ((tot - cc) / tot) if (tot and tot > 0) else None
                if cc > 0:
                    b, fdet = _fac_score(cc, tgap, tg, pf)
                    pt.update(burden=b, zone=_zone(b), factors=fdet,
                              inputs={"testing_gap": _clip01(tgap), "treatment_gap": _clip01(tg),
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
                  "cases": round(lga_totals[ym]) if lga_has_val[ym] else None} for ym in yms]
    months = [{"ym": ym, "label": _label(ym), "forecast": ym in fc_set} for ym in yms]
    return {"available": True, "disease": disease, "state": state, "lga": lga,
            "n_facilities": len(facilities), "months": months, "factor_meta": _FACTOR_META,
            "facilities": out_fac, "lga_cases": lga_cases, "source": _SOURCE_META,
            "scoring_method_note": _SCORING_METHOD_NOTE}


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
    inputs: Optional[dict] = None        # raw indicator values {testing_gap, treatment_gap, ...}


def _risk_level(burden: Optional[float], zone: Optional[str]) -> str:
    if zone in ("Red",):
        return "Critical"
    if zone in ("Amber",):
        return "High"
    if zone in ("Yellow",):
        return "Moderate"
    if burden is not None and burden >= 91:
        return "Critical"
    return "Elevated" if (burden or 0) >= 60 else "Low"


@facility_router.post("/ews/api/facility-risk")
def facility_risk(req: FacilityRiskReq):
    """AI risk assessment for one facility at a FORECAST month. Deterministic
    risk_level from the burden/zone, plus a Groq-written planning narrative."""
    load_dotenv(override=True)
    level = _risk_level(req.burden, req.zone)
    projected = round(req.cases) if req.cases is not None else 0

    is_hiv = req.disease == "hiv"
    metric_label = "new HIV-positive diagnoses" if is_hiv else "confirmed malaria cases"
    programme = "Nigeria's National AIDS & STIs Control Programme (NASCP)" if is_hiv else "Nigeria's National Malaria Elimination Programme"
    officer = "an HIV surveillance officer" if is_hiv else "a malaria surveillance officer"

    # No projected cases -> nothing to pre-position for. Return an honest,
    # deterministic note instead of billing an LLM call for a boilerplate
    # "prepare for 0 cases" brief (the UI also hides the button in this case).
    if projected < 1:
        routine_line = ("Keep routine HTS testing/ART/PrEP supply levels and continue monthly reporting." if is_hiv
                         else "Keep a routine RDT/ACT buffer stock and continue monthly reporting.")
        return {"risk_level": "None", "zone": req.zone, "burden": req.burden,
                "risk_assessment": (
                    f"## Risk Outlook\n**{req.facility}** has **no {metric_label} projected** for "
                    f"{req.label or req.ym}, so there is nothing to pre-position for at this facility this month.\n\n"
                    f"## Recommended Actions\n- {routine_line}\n"
                    f"- No facility-specific action is required this month.\n\n"
                    f"## Monitoring Triggers\n- Re-assess if any case is reported here, or if a later "
                    f"month projects above zero.")}

    # Scale the brief's depth to the actual burden: a near-empty facility must NOT
    # get the same full pre-positioning campaign as a red-zone hotspot.
    _scale = {
        "Low":      ("a LOW-burden facility with only ~{n} projected case(s): keep it SHORT and light-touch — routine readiness ONLY; do NOT recommend campaigns, extra staffing, supervisory visits or large commodity pre-positioning", 2, 130),
        "Elevated": ("a modest-burden facility (~{n} projected cases): lean, proportionate readiness only — no campaigns or large pre-positioning", 2, 150),
        "Moderate": ("a moderate-burden facility (~{n} projected cases): targeted, proportionate pre-positioning sized to this small caseload", 3, 190),
        "High":     ("a high-burden facility (~{n} projected cases): a fuller pre-positioning + staffing plan sized to this caseload", 4, 230),
        "Critical": ("a critical-burden facility (~{n} projected cases): comprehensive, urgent pre-positioning, staffing and supervision sized to this caseload", 4, 260),
    }
    scale_hint, n_actions, word_cap = _scale.get(level, _scale["Moderate"])
    scale_hint = scale_hint.format(n=projected)

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GROQ_API_KEY not set in .env")
    from groq import Groq
    client = Groq(api_key=api_key)

    recent_txt = "\n".join(
        f"  {r.get('label')}: {round(r.get('cases')) if r.get('cases') is not None else 'n/a'} {metric_label}"
        f"{' (forecast)' if r.get('forecast') else ''}"
        for r in (req.recent or [])
    ) or "  (no recent series provided)"
    c = req.context_12m or {}
    inp = req.inputs or {}
    fac = req.factors or {}
    def _pct(x): return f"{round(x * 100)}%" if isinstance(x, (int, float)) else "n/a"
    def _sub(name): return (fac.get(name) or {}).get("sub")

    if is_hiv:
        ctx_txt = (f"Trailing 12 months at this facility — new HIV-positive diagnoses: {round(c['cases']) if c.get('cases') is not None else 'n/a'}, "
                   f"HIV tests conducted: {round(c['hts_tested']) if c.get('hts_tested') is not None else 'n/a'}, "
                   f"currently on ART: {round(c['art_curr']) if c.get('art_curr') is not None else 'n/a'}, "
                   f"on ART with a viral-load result: {round(c['art_vl_tested']) if c.get('art_vl_tested') is not None else 'n/a'}.")
        drivers_txt = (f"Burden drivers for this facility (relative to its own LGA peers) — case burden (positivity): {_pct(_sub('case_burden'))}, "
                       f"testing gap: {_pct(_sub('testing_gap'))}, ART coverage gap: {_pct(_sub('art_gap'))}, "
                       f"VL-monitoring gap (share of this facility's own ART patients without a routine VL check): {_pct(_sub('vl_gap'))}.")
        burden_desc = "an LGA-relative score (this facility vs its own LGA peers -- blends case burden/positivity, testing gap, ART coverage gap and VL-monitoring gap)"
        factor_names = "case burden, testing gap, ART coverage gap, VL-monitoring gap"
        disease_rule = "Do NOT claim whether HIV transmission is seasonal, and do NOT invent behavioural, seasonal, or epidemiological facts that are not given above."
        supply_hint = "HTS test kits / ART refills / VL sample-collection capacity"
    else:
        ctx_txt = (f"Trailing 12 months at this facility — confirmed cases: {round(c['cases']) if c.get('cases') is not None else 'n/a'}, "
                   f"ACT courses given: {round(c['act']) if c.get('act') is not None else 'n/a'}, "
                   f"RDT tests done: {round(c['rdt_tested']) if c.get('rdt_tested') is not None else 'n/a'}, "
                   f"total reported (confirmed+presumed): {round(c['total']) if c.get('total') is not None else 'n/a'}.")
        drivers_txt = (f"Burden drivers for this facility — testing gap (fever cases NOT given a parasitological test): {_pct(inp.get('testing_gap'))}, "
                       f"treatment gap (confirmed cases without an ACT course): {_pct(inp.get('treatment_gap'))}, "
                       f"diagnostic gap (presumed share of reported cases): {_pct(inp.get('diagnostic_gap'))}.")
        burden_desc = "an ABSOLUTE clinical score comparable across all Nigerian facilities -- blends case volume, testing gap, treatment gap and diagnostic gap"
        factor_names = "case level, testing gap, treatment gap, diagnostic gap"
        disease_rule = "Do NOT claim whether the month is or isn't a malaria transmission season, and do NOT invent seasonal, climatic, or epidemiological facts that are not given above."
        supply_hint = "RDT/ACT buffer stock"

    prompt = f"""You are {officer} at {programme}.
Write a concise, decision-ready RISK ASSESSMENT for a single health facility for a FORECAST (future) month.
Match the DEPTH and SCALE of everything you write to this facility's actual numbers — this is {scale_hint}.
Stay entirely within this disease -- do not reference any other disease's programmes or interventions.

Facility: {req.facility}{f' (ward: {req.ward})' if req.ward else ''}
Location: {req.lga} LGA, {req.state} State, Nigeria
Forecast month being assessed: {req.label or req.ym}
Projected {metric_label} that month: {projected}
Facility burden score (0-100, {burden_desc}): {req.burden if req.burden is not None else 'n/a'} -> zone "{req.zone or 'n/a'}", risk level "{level}"{f', ranked {req.lga_rank} among its LGA facilities' if req.lga_rank else ''}
{drivers_txt}
Recent & projected trajectory:
{recent_txt}
{ctx_txt}

RULES (follow strictly):
- Be SPECIFIC to this facility's numbers ({projected} projected {metric_label}, burden {req.burden if req.burden is not None else 'n/a'}, zone {req.zone or 'n/a'}). Do NOT write generic boilerplate that would read the same for any facility.
- Keep everything PROPORTIONATE — this is {scale_hint}.
- {disease_rule}
- Never invent case numbers or figures.

Write in markdown with these short sections:
## Risk Outlook
1-2 sentences: what the forecast implies for THIS facility that month, referencing the {projected} projected {metric_label} and its burden/zone.
## Why (drivers)
{2 if n_actions <= 2 else 3} short bullets on the likely drivers, grounded ONLY in the numbers above ({factor_names}).
## Recommended Actions
{n_actions} PROPORTIONATE bullet(s) (e.g. {supply_hint} where relevant), each sized to ~{projected} projected {metric_label} — concrete and facility-level, for the 4-6 weeks before this month.
## Monitoring Triggers
1-2 numeric triggers that would escalate the response.

Keep the whole brief under {word_cap} words. Frame everything as "prepare for", not "responded to"."""

    # Groq calls occasionally fail transiently (rate-limit 429, timeout, brief
    # 5xx). Left unhandled they bubble up as a plain-text 500, which the frontend
    # then tries to JSON.parse -> "Unexpected token ... is not valid JSON". Retry
    # once, then surface a CLEAN JSON error (HTTPException serialises to JSON, and
    # the UI already reads e.detail) so the panel shows a readable message.
    import time
    last_err = None
    for attempt in range(2):
        try:
            resp = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=700,
                temperature=0.3,
            )
            content = (resp.choices[0].message.content or "").strip() if resp.choices else ""
            if not content:
                raise ValueError("empty response from model")
            return {"risk_level": level, "zone": req.zone, "burden": req.burden,
                    "risk_assessment": content}
        except Exception as e:
            last_err = e
            log.warning(f"facility-risk Groq call failed (attempt {attempt + 1}/2) for "
                        f"{req.facility}: {e.__class__.__name__}: {e}")
            if attempt == 0:
                time.sleep(1.2)
    raise HTTPException(503, f"AI risk service is temporarily unavailable "
                            f"({last_err.__class__.__name__}). Please try again in a moment.")
