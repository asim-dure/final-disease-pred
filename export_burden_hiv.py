"""
Export MONTHLY per-LGA and per-state HIV indicator inputs for a malaria-
ManagerDashboard-shaped burden.json (same per-field-array-aligned-to-a-
shared-month-index shape export_burden.py already produces for malaria),
so ui/src/views/HivManagerDashboard.jsx can reuse the exact same UI shell,
filters and chart components malaria's dashboard already has.

REAL DATA ONLY -- every field below is a live, verified warehouse indicator
(confirmed via direct SQL against public.fact_indicator_data_hiv +
dim_indicator_master). The vast majority of NDARS's ~393 indicators (Viral
Hepatitis, Cervical Cancer, DQA, most of TB_HIV) are >90% missing at
facility grain -- rolling up to LGA/state doesn't fix a genuine reporting
gap, it just hides it. Building charts on top of that would be fabricating
signal from noise, the exact mistake this whole project has been careful
to avoid for malaria. So this export covers the factor groups where real,
current, broadly-reported data exists:

  Testing      -- HTS_TST Total / NEG / POS (Male+Female), NDARS (system_id=7),
                  plus the same POS/NEG breakdown by age group (4 grouped
                  buckets from NDARS's 11 raw age bands -- see AGE_BANDS below)
  Treatment    -- ART currently on ART (M+F), NDARS (system_id=7);
                  ART currently-on-with-a-VL-result (M+F), NDARS (system_id=7)
                  -- a monitoring-intensity proxy, not a suppression % (no
                  single clean "viral suppression %" indicator exists in the
                  fact table at this grain)
  Intervention -- PMTCT pregnant/breastfeeding women tested (Incl. known
                  positive), NDARS (system_id=7)
  Population & population density -- agg_lga_pop.parquet (same source
                  malaria's own export_burden.py already uses)
  Socio-economic -- population DENSITY doubles as the socio-economic proxy
                  (urban/rural context) for the burden score; a separate
                  Key Population + national socio-economic survey snapshot
                  is exported by export_hiv_kp_socio.py.

Everything else the 12-category breakdown lists (Viral Hepatitis, Cervical
Cancer, most of TB_HIV, DQA) is a genuine, reportable data gap -- shown as
an explicit DataGapNote on the dashboard, never fabricated placeholder
charts (same policy as malaria's IRS/SMC gap treatment).
"""
import json
import os
import numpy as np
import pandas as pd
from dotenv import load_dotenv
load_dotenv()

import etl_warehouse_common as ewc
import warehouse as wh

OUT_PATH = "ui/public/data/after/hiv/burden_rich.json"
DISEASE_ID = "hiv"
MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

# ── indicator catalog: NDARS (system_id=7) ONLY, per explicit instruction --
# no cross-system mixing. This also incidentally fixes a real data-quality
# problem found during verification: the NHMIS-sourced "ART PLHIV currently
# receiving ART" indicator swings wildly (~1M one month, ~500 the next) for
# 14 straight months (Jan 2024-Jan 2025) -- NDARS's own "ART Monthly_3_
# Currently on ART" is smooth and consistent throughout the same window.
IND = {
    "hts_tested_f": ("HTS Monthly_1n_HTS_TST Total, Female", 7),
    "hts_tested_m": ("HTS Monthly_1n_HTS_TST Total, Male", 7),
    "hts_neg_f":    ("HTS Monthly_1n_HTS_TST_NEG Total, Female", 7),
    "hts_neg_m":    ("HTS Monthly_1n_HTS_TST_NEG Total, Male", 7),
    "hts_pos_f":    ("HTS Monthly_1n_HTS_TST_POS Total, Female", 7),
    "hts_pos_m":    ("HTS Monthly_1n_HTS_TST_POS Total, Male", 7),
    "art_curr_f":   ("ART Monthly_3_Currently on ART Female", 7),
    "art_curr_m":   ("ART Monthly_3_Currently on ART Male\xa0", 7),  # source data has a trailing NBSP on this one indicator only, confirmed live
    "art_vl_f":     ("ART Monthly_6a_Currently on ART with VL result Female", 7),
    "art_vl_m":     ("ART Monthly_6a_Currently on ART with VL result Male", 7),
    "pmtct_tested": ("PMTCT_HTS_Total. Number of pregnant & Breast-feeding women HIV tested and received results (Incl. known Positive)", 7),
    # Real viral-suppression % -- verified live: dim_indicator_master tags this
    # indicator's own aggregationtype as "Average" (not "Sum"), and
    # fetch_fact_series() already branches on that column to AVG instead of SUM
    # when rolling facility-grain rows up to LGA/state (see its own docstring/
    # comment) -- so no new aggregation code is needed here, this is safe to
    # treat exactly like every other IND entry. Source rows are per-facility
    # percentages (e.g. 96.86, 89.47, ...), 37 states, back to 2014.
    "art_vl_suppressed_pct": ("ART: Percentage Virally Suppressed", 7),
    # Cervical cancer screening cascade for Women Living With HIV on ART --
    # verified live: all 4 real, Sum-aggregated, 37-state coverage through
    # May 2026 (this category was previously assumed >90% missing across the
    # board; that was true for most of NDARS's ~393 indicators but NOT this
    # specific cascade, confirmed by direct re-query).
    "cacx_neg":       ("ART Monthly_23a_WLHIV on ART screened for cervical cancer (NEG)", 7),
    "cacx_pos":       ("ART Monthly_23b_WLHIV on ART screened for cervical cancer (POS)", 7),
    "cacx_suspected": ("ART Monthly_23c_WLHIV on ART screened for cervical cancer (Suspected Cancer)", 7),
    "cacx_referred":  ("ART Monthly_23d_WLHIV on ART screened for cervical cancer (Referred)", 7),
    # Key Population Hepatitis B/C testing -- verified live: 30-32 of 37
    # states reporting per indicator (thinner than the core fields, but
    # materially better than the DQA/treatment-uptake Hepatitis indicators,
    # which are 4-11 states and excluded as genuinely too sparse).
    "hepb_neg": ([f"Number of KP tested negative for Hepatitis B, {sex} Total" for sex in ("Male", "Female")], 7),
    "hepb_pos": ([f"Number of KP tested positive for Hepatitis B, {sex} Total" for sex in ("Male", "Female")], 7),
    "hepc_neg": ([f"Number of KP tested negative for Hepatitis C, {sex} Total" for sex in ("Male", "Female")], 7),
    "hepc_pos": ([f"Number of KP tested positive for Hepatitis C, {sex} Total" for sex in ("Male", "Female")], 7),
}

# ── age-band breakdown, requested explicitly: NDARS reports HTS_TST_NEG and
# HTS_TST_POS at 11 real age bands each (1-4, 5-9, 10-14, 15-19, 20-24,
# 25-29, 30-34, 35-39, 40-44, 45-49, "5O+" -- that's a literal capital-O
# typo in the source indicator name, not 50+, confirmed live), each split
# by Male/Female -- 44 real indicators total, verified live (system_id=7,
# 13-37 states reporting depending on band).
#
# Shown as NDARS's own 11 raw bands directly, not grouped into broader
# buckets -- an earlier version of this file grouped them into 4 (Under 15/
# 15-24/25-49/50+) to avoid thin lines on sparser bands, but per explicit
# instruction this dashboard uses the real column-wise segregation NDARS
# already provides rather than inventing its own aggregation. Each band's
# Male+Female name pair is still summed server-side in ONE query via
# fetch_fact_series' multi-name sum (11 bands x pos/neg = 22 queries, not
# 44). "Tested" per band is derived as positive + negative (no separate
# age-banded "HTS_TST Total" indicator exists), the same real-count-sum
# logic already used for the non-age-banded hts_tested field elsewhere in
# this project. Coverage still varies by band (13-37 of 37 states) --
# disclosed in the dashboard's chart tooltips rather than hidden by grouping.
AGE_BANDS = {
    "1_4": ["1-4"], "5_9": ["5-9"], "10_14": ["10-14"], "15_19": ["15-19"], "20_24": ["20-24"],
    "25_29": ["25-29"], "30_34": ["30-34"], "35_39": ["35-39"], "40_44": ["40-44"], "45_49": ["45-49"],
    "50plus": ["5O+"],
}
for band, sub_ages in AGE_BANDS.items():
    IND[f"hts_pos_{band}"] = ([f"HTS Monthly_1n_HTS_TST_POS Total {a}, {sex}" for a in sub_ages for sex in ("Male", "Female")], 7)
    IND[f"hts_neg_{band}"] = ([f"HTS Monthly_1n_HTS_TST_NEG Total {a}, {sex}" for a in sub_ages for sex in ("Male", "Female")], 7)


def fetch(field, level):
    name, sysid = IND[field]
    df = ewc.fetch_fact_series(DISEASE_ID, name, level=level, system_id=sysid)
    df["ym"] = df["year"] * 12 + df["month"] - 1
    return df


def build_panel(level):
    """One row per (state[,lga], ym) with every IND field summed in, 0 where unreported."""
    frames = []
    for field in IND:
        df = fetch(field, level)
        key = ["state", "lga", "ym"] if level == "lga" else ["state", "ym"]
        df = df.rename(columns={"value": field})[key + [field]]
        frames.append(df.set_index(key))
    concat_raw = pd.concat(frames, axis=1)
    # "reported"/"hts_reported"/"art_reported" -- did this (area, month) have
    # an actual fetched row, vs every field here being a fillna(0.0)
    # placeholder because NOTHING was reported. MUST be captured before
    # fillna(0.0) below, since after it a genuine reported-zero and "nothing
    # reported" are indistinguishable.
    #
    # This is split into HTS-family and ART-family flags, not one blanket
    # row-level flag, because real data shows areas that report SOME real
    # indicators but not others in a given month -- verified live (Niger
    # state, Apr 2024): 4 LGAs had hts_tested/hts_pos/art_curr all exactly 0
    # AND a real, substantial pmtct_tested count (1000-1700+ women) that
    # same month. That's a per-service-line reporting gap (the HTS Monthly
    # and ART Monthly forms weren't filed that month at that facility, even
    # though the PMTCT form was), not evidence those areas had zero testing/
    # treatment activity -- a row-level "was ANYTHING reported" flag would
    # have missed this and still scored them off fillna'd zeros. hts_reported
    # gates the case-burden/testing-gap factors; art_reported gates the
    # ART-coverage-gap factor (hivScoreDetail in hivBurdenScore.js).
    # "reported" (whole-row) is kept too, for hivBuildZones' No-Data
    # exclusion of areas with literally nothing reported at all.
    hts_raw_cols = ["hts_tested_f", "hts_tested_m", "hts_neg_f", "hts_neg_m", "hts_pos_f", "hts_pos_m"]
    art_raw_cols = ["art_curr_f", "art_curr_m", "art_vl_f", "art_vl_m"]
    core_raw_cols = hts_raw_cols + art_raw_cols + ["pmtct_tested"]
    has_hts = concat_raw[hts_raw_cols].notna().any(axis=1).to_numpy()
    has_art = concat_raw[art_raw_cols].notna().any(axis=1).to_numpy()
    has_report = concat_raw[core_raw_cols].notna().any(axis=1).to_numpy()
    panel = concat_raw.fillna(0.0).reset_index()
    panel["reported"] = has_report
    panel["hts_reported"] = has_hts
    panel["art_reported"] = has_art
    panel["hts_tested"] = panel["hts_tested_f"] + panel["hts_tested_m"]
    panel["hts_neg"] = panel["hts_neg_f"] + panel["hts_neg_m"]
    panel["hts_pos"] = panel["hts_pos_f"] + panel["hts_pos_m"]
    panel["art_curr"] = panel["art_curr_f"] + panel["art_curr_m"]
    panel["art_vl_tested"] = panel["art_vl_f"] + panel["art_vl_m"]
    for band in AGE_BANDS:
        panel[f"hts_tested_{band}"] = panel[f"hts_pos_{band}"] + panel[f"hts_neg_{band}"]
    drop_cols = ("hts_tested_f", "hts_tested_m", "hts_neg_f", "hts_neg_m", "hts_pos_f", "hts_pos_m",
                 "art_curr_f", "art_curr_m", "art_vl_f", "art_vl_m")
    return panel[[c for c in panel.columns if c not in drop_cols]]


print("Fetching real NDARS/NHMIS HIV indicators (state grain)...")
state_panel = build_panel("state")
print(f"  {len(state_panel)} state-month rows, {state_panel['state'].nunique()} states")

print("Fetching real NDARS/NHMIS HIV indicators (LGA grain)...")
lga_panel = build_panel("lga")
print(f"  {len(lga_panel)} lga-month rows, {lga_panel[['state', 'lga']].drop_duplicates().shape[0]} LGAs")

FIELDS = ["hts_tested", "hts_neg", "hts_pos", "art_curr", "art_vl_tested", "pmtct_tested"] + \
    [f"hts_{k}_{band}" for band in AGE_BANDS for k in ("pos", "neg", "tested")] + \
    ["cacx_neg", "cacx_pos", "cacx_suspected", "cacx_referred", "hepb_neg", "hepb_pos", "hepc_neg", "hepc_pos"]

# art_vl_suppressed_pct is a PERCENTAGE, not a count -- it must never be
# summed across areas the way every FIELDS entry above legitimately can be
# (summing two states' screening counts is a real total; summing two states'
# suppression PERCENTAGES is meaningless, the same class of bug already
# fixed once for population density in join_pop() below). Kept in its own
# list so it's carried through series_for()'s per-month output (and
# forecast climatology) exactly like a FIELDS entry, but flagged separately
# in the exported JSON so the frontend knows to average, never sum, it when
# combining multiple states/LGAs into one scope.
RATE_FIELDS = ["art_vl_suppressed_pct"]

# ── population + density, same reused source/join as malaria ────────────────
pop = pd.read_parquet("agg_lga_pop.parquet", columns=["state", "lga", "year", "population", "pop_density"])
pop = pop.dropna(subset=["state", "lga", "year"]).drop_duplicates(["state", "lga", "year"])

# Malaria's own export_burden.py rescales this SAME agg_lga_pop.parquet
# source uniformly to the official NBS/UN mid-year 2026 estimate (this
# dataset's own raw national total undercounts it -- verified live, the
# deduped 2026 total here sums to ~234.14M, matching malaria's own cited
# raw figure exactly, confirming both dashboards share this one source).
# Applying the IDENTICAL constant + method here (not just "a similar
# rescale") means a user cross-checking population between the malaria and
# HIV dashboards for the same state/period sees the SAME number, not two
# different undercounts of the same underlying data.
NIGERIA_2026_POPULATION = 242_431_832
_pop_latest_year = pop["year"].max()
_raw_latest_total = float(pop.loc[pop["year"] == _pop_latest_year, "population"].sum())
POP_SCALE = (NIGERIA_2026_POPULATION / _raw_latest_total) if _raw_latest_total > 0 else 1.0
pop["population"] = pop["population"] * POP_SCALE
pop["pop_density"] = pop["pop_density"] * POP_SCALE  # density = population / fixed area, scales identically
print(f"Population rescale: raw {_pop_latest_year} national total {_raw_latest_total:,.0f} -> {NIGERIA_2026_POPULATION:,} (scale {POP_SCALE:.4f})")

pop["state_norm"] = pop["state"].map(wh.normalize_lga_name)
pop["lga_norm"] = pop["lga"].map(wh.normalize_lga_name)


def join_pop(panel, has_lga):
    panel = panel.copy()
    panel["year"] = panel["ym"] // 12
    panel["state_norm"] = panel["state"].map(wh.normalize_lga_name)
    if has_lga:
        panel["lga_norm"] = panel["lga"].map(wh.normalize_lga_name)
        merged = panel.merge(pop[["state_norm", "lga_norm", "year", "population", "pop_density"]],
                              on=["state_norm", "lga_norm", "year"], how="left")
    else:
        # Density is NOT additive across LGAs -- summing it (an earlier bug
        # caught during verification: produced a "1.28 million/km2" national
        # figure) would be nonsense. Derive each LGA's own area from its own
        # population/density, sum area and population separately, and only
        # THEN divide -- the correct way to roll a density up to a bigger
        # region.
        pop_a = pop.copy()
        pop_a["area"] = pop_a["population"] / pop_a["pop_density"].replace(0, np.nan)
        state_pop = pop_a.groupby(["state_norm", "year"], as_index=False)[["population", "area"]].sum()
        state_pop["pop_density"] = state_pop["population"] / state_pop["area"]
        merged = panel.merge(state_pop[["state_norm", "year", "population", "pop_density"]],
                              on=["state_norm", "year"], how="left")
    return merged.drop(columns=["state_norm"] + (["lga_norm"] if has_lga else []))


state_panel = join_pop(state_panel, has_lga=False)
lga_panel = join_pop(lga_panel, has_lga=True)

# ── month window: real reported range across the 6 core fields, +12mo forecast ──
# Restricted to 2023+ per the EDA notebook's own explicit recommendation
# ("keep year >= 2023") -- earlier years have scattered pilot-only reporting
# that would otherwise drag the window back to 2014 and make every
# calendar-month climatology average in years of near-empty data.
#
# The LAST real month can't just be "latest month with any nonzero value" the
# way malaria's cases field allows -- verified live (diag query during
# implementation): reporting genuinely trickles in over 2-3 months per FIELD,
# at different rates (e.g. May 2026's ART indicator had exactly 1 reporting
# facility nationally vs 1500+ in a normal month, while PMTCT/HTS still
# looked fine that same month) -- an "ANY field reported" OR-check is too
# lenient, since one still-healthy field masks another field's collapse.
# Per-field, per-month, national VALUE (not LGA-report-count -- a low-volume
# field like hts_pos naturally has few reporting LGAs even in a genuinely
# complete month, which broke an earlier LGA-count version of this check)
# against its own trailing-3-month median, requiring at least 40% of it.
# Take the MOST conservative (earliest) cutoff across all 6 fields -- the
# real month where every field simultaneously still looks complete.
#
# The age-band HTS fields added below are deliberately EXCLUDED from this
# cutoff computation: the POS bands especially are much sparser/noisier at
# the tails (verified live -- e.g. POS 20-24 Female had only 27 of 37
# states reporting in one window) even in genuinely well-reported months,
# so feeding them into the same "40% of trailing median" check would drag
# the whole dashboard's real/forecast boundary backward on the strength of
# a thin age-band slice, not an actual reporting collapse in the core
# testing/treatment data. They're still exported with real counts (0 where
# truly unreported) across the exact same ACTUAL/FCAST window the 6 core
# fields already established.
CORE_FIELDS = ["hts_tested", "hts_neg", "hts_pos", "art_curr", "art_vl_tested", "pmtct_tested"]
_win = lga_panel[lga_panel["ym"] >= 2023 * 12]
_field_cutoffs = []
for f in CORE_FIELDS:
    tot = _win.groupby("ym")[f].sum().sort_index()
    last_ok = None
    for i, (ym, v) in enumerate(tot.items()):
        trailing = tot.iloc[max(0, i - 3):i]
        threshold = trailing.median() * 0.4 if len(trailing) else 0
        if v >= threshold and v > 0:
            last_ok = ym
        else:
            break
    if last_ok is not None:
        _field_cutoffs.append(last_ok)
FIRST_REAL_YM = 2023 * 12
LAST_REAL_YM = int(min(_field_cutoffs))
ACTUAL = list(range(FIRST_REAL_YM, LAST_REAL_YM + 1))
FCAST = list(range(LAST_REAL_YM + 1, LAST_REAL_YM + 13))
ALLYM = ACTUAL + FCAST


def ymlabel(ym): return f"{MONTH_ABBR[ym % 12]} {ym // 12}"


print(f"Last real reported month: {ymlabel(LAST_REAL_YM)} | actual {ymlabel(ACTUAL[0])}..{ymlabel(ACTUAL[-1])} | forecast {ymlabel(FCAST[0])}..{ymlabel(FCAST[-1])}")
MONTHS = [{"ym": f"{ym // 12}-{ym % 12 + 1:02d}", "label": ymlabel(ym), "forecast": ym in FCAST} for ym in ALLYM]


def rnd(v):
    if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))):
        return 0
    return int(round(v))


def series_for(panel_g):
    """panel_g: one area's rows indexed by ym. Real counts for ACTUAL months;
    calendar-month climatology (same method malaria's own lever fields use)
    for FCAST months -- no HIV-specific ML forecast model exists yet, so this
    is deliberately the same honest fallback malaria uses for its non-case
    lever fields, not a fabricated trend."""
    p = panel_g.set_index("ym").reindex(ACTUAL)
    cm = p.copy()
    cm["cal"] = [ym % 12 for ym in cm.index]

    def _clim_for(cols, reported_col):
        """Climatology mean per calendar month, over only the months this
        area actually reported that FAMILY of indicators -- a month with no
        report at all must not pull the forecast toward zero the same way a
        genuine reported zero would (the "no data isn't a 0" principle,
        applied to the forecast, not just the burden score). Falls back to
        using every month if this area NEVER reported that family (better
        than an empty groupby crashing)."""
        rep = cm[reported_col].astype(object).fillna(False).astype(bool) if reported_col in cm.columns else pd.Series(True, index=cm.index)
        sub = cm[rep]
        src = sub if len(sub) else cm
        return {f: src.groupby("cal")[f].mean() for f in cols}

    # Split by which real indicator family backs each field (see the
    # hts_reported/art_reported comment in build_panel) -- HTS fields and
    # ART fields have genuinely independent reporting gaps, verified live,
    # so averaging them over the SAME "reported" flag would still dilute one
    # family's forecast with the other's blank months. Everything else
    # (PMTCT, Cervical Cancer, Hepatitis) falls back to the whole-row flag,
    # since no per-family flag was captured for those categories.
    hts_field_cols = [f for f in FIELDS if f.startswith("hts_")]
    art_field_cols = ["art_curr", "art_vl_tested"]
    other_field_cols = [f for f in FIELDS if f not in hts_field_cols and f not in art_field_cols]
    clim = {}
    clim.update(_clim_for(hts_field_cols, "hts_reported"))
    clim.update(_clim_for(art_field_cols + [f for f in RATE_FIELDS if f.startswith("art_")], "art_reported"))
    clim.update(_clim_for(other_field_cols + [f for f in RATE_FIELDS if not f.startswith("art_")], "reported"))
    clim.update(_clim_for(["population", "pop_density"], "reported"))

    out = {f: [] for f in FIELDS + RATE_FIELDS + ["population", "pop_density"]}
    out["reported"] = []
    out["hts_reported"] = []
    out["art_reported"] = []
    last_pop, last_dens = None, None
    for ym in ACTUAL:
        row = p.loc[ym] if ym in p.index else None
        for f in FIELDS:
            out[f].append(rnd(row[f]) if row is not None and pd.notna(row.get(f)) else 0)
        for f in RATE_FIELDS:
            out[f].append(round(row[f], 1) if row is not None and pd.notna(row.get(f)) and row[f] > 0 else None)
        out["reported"].append(bool(row["reported"]) if row is not None and pd.notna(row.get("reported")) else False)
        out["hts_reported"].append(bool(row["hts_reported"]) if row is not None and pd.notna(row.get("hts_reported")) else False)
        out["art_reported"].append(bool(row["art_reported"]) if row is not None and pd.notna(row.get("art_reported")) else False)
        if row is not None and pd.notna(row.get("population")) and row["population"] > 0:
            last_pop, last_dens = row["population"], row["pop_density"]
        out["population"].append(rnd(last_pop) if last_pop else 0)
        out["pop_density"].append(round(last_dens, 1) if last_dens else 0)
    for ym in FCAST:
        out["reported"].append(None)  # not applicable -- MONTHS[i].forecast is the authoritative flag for forecast rows
        out["hts_reported"].append(None)
        out["art_reported"].append(None)
        cal = ym % 12
        for f in FIELDS:
            out[f].append(rnd(clim[f].get(cal, 0)))
        for f in RATE_FIELDS:
            v = clim[f].get(cal)
            out[f].append(round(v, 1) if pd.notna(v) else None)
        # population compounds forward at Nigeria's long-run ~2.5%/yr (same
        # fallback rate malaria's export_burden.py uses) rather than being
        # climatology-averaged back down
        if last_pop:
            months_fwd = ym - LAST_REAL_YM
            growth = (1.025) ** (1 / 12)
            last_pop = last_pop * growth
            out["population"].append(rnd(last_pop))
            out["pop_density"].append(round(last_dens * (last_pop / (last_pop / growth)) if last_dens else 0, 1))
        else:
            out["population"].append(0)
            out["pop_density"].append(0)
    return out


def build_areas(panel, group_cols):
    areas = {}
    for key, g in panel.groupby(group_cols):
        name = key if isinstance(key, str) else "|||".join(key)
        areas[name] = series_for(g)
    return areas


print("Building state series...")
states_out = build_areas(state_panel, "state")
print("Building LGA series...")
lga_panel["lga_key"] = lga_panel["state"] + "|||" + lga_panel["lga"]
lgas_out = build_areas(lga_panel, "lga_key")

AGE_BAND_DISPLAY = {
    "1_4": "1-4", "5_9": "5-9", "10_14": "10-14", "15_19": "15-19", "20_24": "20-24",
    "25_29": "25-29", "30_34": "30-34", "35_39": "35-39", "40_44": "40-44", "45_49": "45-49",
    "50plus": "50+",
}
age_band_labels = {}
for band, disp in AGE_BAND_DISPLAY.items():
    age_band_labels[f"hts_pos_{band}"] = f"New Diagnoses, {disp}"
    age_band_labels[f"hts_neg_{band}"] = f"HIV-Negative Results, {disp}"
    age_band_labels[f"hts_tested_{band}"] = f"HIV Tests Conducted, {disp}"

out = {"months": MONTHS, "states": states_out, "lgas": lgas_out,
       "fields": FIELDS + ["population", "pop_density"],
       "rate_fields": RATE_FIELDS,  # NEVER sum these across areas -- average only (see RATE_FIELDS comment above)
       "age_band_display": AGE_BAND_DISPLAY,
       "field_labels": {
           "hts_tested": "HIV Tests Conducted", "hts_neg": "HIV-Negative Results",
           "hts_pos": "HIV-Positive Results (new diagnoses)", "art_curr": "Currently on ART",
           "art_vl_tested": "On ART with a VL Result", "pmtct_tested": "PMTCT Women Tested",
           **age_band_labels,
           "art_vl_suppressed_pct": "Viral Load Suppression Rate (%)",
           "cacx_neg": "Cervical Cancer Screening, Negative", "cacx_pos": "Cervical Cancer Screening, Positive",
           "cacx_suspected": "Cervical Cancer Screening, Suspected Cancer", "cacx_referred": "Cervical Cancer Screening, Referred",
           "hepb_neg": "Hepatitis B (KP), Negative", "hepb_pos": "Hepatitis B (KP), Positive",
           "hepc_neg": "Hepatitis C (KP), Negative", "hepc_pos": "Hepatitis C (KP), Positive",
       }}
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
with open(OUT_PATH, "w") as f:
    json.dump(out, f)
print(f"Wrote {OUT_PATH}  ({len(states_out)} states, {len(lgas_out)} LGAs, {len(MONTHS)} months)")
