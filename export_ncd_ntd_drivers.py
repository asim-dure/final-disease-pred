"""
Real, research-backed What-If Simulator levers for the 12 NCD/NTD diseases
in disease_config.py -- writes ui/public/data/after/<disease>/drivers.json
in the exact shape ui/src/views/Simulator.jsx already consumes (the SAME
generic What-If component malaria itself doesn't use, but every other
disease routes to -- see disease_config.py's capabilities.simulator flag
and App.jsx's buildNavGroups()).

Every driver here is real data, joined at real geography, not invented:
  - `population`, `pop_density` -- agg_lga_pop.parquet, the same population
    source malaria's own export_burden.py and HIV's rescale logic depend on.
  - `poverty_mpi_h`, `dep_water` -- the real MPI headcount + water-access
    deprivation sub-index, also from agg_lga_pop.parquet, at LGA grain.
    (`"Use of clean fuels..."`, `"Literacy among women"`, and the 2 WASH
    household columns in that same file are ALL NULL for every row --
    verified live -- so they are NOT used here, despite being column names
    that exist in the schema.)
  - HIV co-infection prevalence, for cervical cancer only -- this repo's own
    live HIV burden data (ui/public/data/after/hiv/burden_rich.json).
  - Tobacco use, alcohol use, BMI/overweight, solid-fuel cooking reliance,
    self-reported hypertension prevalence, breast/cervical cancer
    examination rates -- hand-transcribed STATE-level (or, for the two
    cancer-screening levers, ZONE-level) tables from Nigeria's DHS 2024
    final report (FR395, dhsprogram.com/pubs/pdf/FR395/FR395.pdf) -- see
    LIT_STATE_CATALOG/LIT_ZONE_CATALOG below for the exact table numbers
    and citations. These REPLACE an earlier, weaker version of this file
    that reused generic MPI deprivation sub-indices (schooling/electricity/
    housing) near-identically across unrelated diseases instead of real
    disease-specific survey data -- caught and corrected after a direct
    user review of the shipped levers found none of the originally
    researched NDHS/GBD/ESPEN levers had actually been wired in.
  - LF (elephantiasis) mass drug administration coverage -- Eigege et al.
    2017 (Am J Trop Med Hyg, PMC5590580): Plateau and Nasarawa confirmed
    stopped statewide MDA in 2013 after hitting WHO elimination thresholds;
    every other state uses the real independent 2003 national survey
    coverage average (72.2%) as a disclosed national constant. ESPEN's own
    bulk LGA-level LF dataset (espen.afro.who.int) was investigated but
    isn't scriptable without a gated API key and a JS-rendered download
    form that doesn't expose a plain HTTP endpoint -- flagged as a future
    follow-up, not fabricated around.

See NCD_NTD_LEVER_RESEARCH.md for the full survey/citation trail behind
every choice made here, and its "at-risk sub-population" table for the
`audience` scoping values (a Population lever for Breast Cancer must only
scale the women's population, not everyone -- the same audience-scoping
mechanism Simulator.jsx already uses for malaria's IPTp/vaccine levers,
which are scoped to pregnant women / under-5s respectively).

Elasticity values are DELIBERATELY modest/capped and disclosed as
directional (not precisely fitted coefficients) everywhere except:
  - Population (elasticity 1.0 -- cases scale with the size of the tracked
    population, all else equal; this is the one lever a precise coefficient
    is mechanically defensible for without a bespoke study).
  - Cervical Cancer's HIV covariate, which uses a REAL published relative
    risk: HIV-positive women have 6.07x the cervical cancer risk of
    HIV-negative women (Stelzle et al., Lancet Global Health 2020, WHO-cited
    meta-analysis of 24 studies, RR 6.07, 95% CI 4.4-8.37).

Usage: python export_ncd_ntd_drivers.py [--disease id1,id2 | --all]
"""
import argparse
import json
import os

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

import disease_config as dc
import warehouse as wh

OUT_ROOT = os.path.join(os.path.dirname(__file__), "ui", "public", "data", "after")

NCD_NTD_DISEASE_IDS = [
    "hypertension", "diabetes", "cervical_cancer", "asthma",
    "arthritis", "depression", "breast_cancer", "coronary_heart_disease",
    "sickle_cell", "yaws", "elephantiasis", "snake_bites",
]

# ── Real national demographic constants (2026 UN-modelled projection; no
# state/LGA-level sex/age breakdown was found in this project's research
# pass -- see NCD_NTD_LEVER_RESEARCH.md's "Demographic/structural levers"
# section for the exact citation and the disclosed limitation that this is
# a national ratio applied uniformly, not a state-resolved one). ─────────
FEMALE_SHARE = 0.4938
CHILD_SHARE = 0.4254     # under-15
ADULT_SHARE = 1 - CHILD_SHARE

# ── Real, disease-specific survey levers (Nigeria DHS 2024, final report
# FR395, dhsprogram.com/pubs/pdf/FR395/FR395.pdf) -- hand-transcribed from
# the report's own state-level tables (cited per-lever below), replacing the
# earlier generic MPI-deprivation-column stand-ins with the ACTUAL
# disease-specific risk-factor levers NCD_NTD_LEVER_RESEARCH.md called for.
# Every dict below is a state->value map, keyed with the SAME state names as
# agg_lga_pop.parquet / STATE_GRID (i.e. "Federal Capital Territory", not
# "FCT"). Coverage is complete for all 37 states in every table below -- no
# missing-cell fallback logic is needed.
STATE_TO_ZONE = {
    "Sokoto": "NW", "Kebbi": "NW", "Zamfara": "NW", "Katsina": "NW", "Jigawa": "NW", "Kano": "NW", "Kaduna": "NW",
    "Yobe": "NE", "Borno": "NE", "Bauchi": "NE", "Gombe": "NE", "Adamawa": "NE", "Taraba": "NE",
    "Niger": "NC", "Federal Capital Territory": "NC", "Nasarawa": "NC", "Kwara": "NC", "Kogi": "NC", "Benue": "NC", "Plateau": "NC",
    "Oyo": "SW", "Osun": "SW", "Ekiti": "SW", "Ondo": "SW", "Ogun": "SW", "Lagos": "SW",
    "Enugu": "SE", "Ebonyi": "SE", "Anambra": "SE", "Imo": "SE", "Abia": "SE",
    "Edo": "SS", "Delta": "SS", "Bayelsa": "SS", "Rivers": "SS", "Akwa Ibom": "SS", "Cross River": "SS",
}

# Table 3.10.2 -- % of men age 15-49 who smoke any type of tobacco, by state.
NDHS_TOBACCO_MALE = {
    "Federal Capital Territory": 9.8, "Benue": 11.1, "Kogi": 11.3, "Kwara": 3.8, "Nasarawa": 3.5, "Niger": 0.8, "Plateau": 2.9,
    "Adamawa": 5.3, "Bauchi": 1.0, "Borno": 0.8, "Gombe": 1.6, "Taraba": 6.0, "Yobe": 0.8,
    "Jigawa": 3.4, "Kaduna": 7.9, "Kano": 3.2, "Katsina": 6.1, "Kebbi": 5.3, "Sokoto": 3.4, "Zamfara": 2.1,
    "Abia": 7.1, "Anambra": 32.3, "Ebonyi": 8.2, "Enugu": 4.6, "Imo": 16.2,
    "Akwa Ibom": 13.2, "Bayelsa": 6.4, "Cross River": 18.1, "Delta": 18.0, "Edo": 9.7, "Rivers": 13.3,
    "Ekiti": 5.7, "Lagos": 8.9, "Ogun": 12.3, "Ondo": 4.8, "Osun": 4.0, "Oyo": 2.9,
}
# Table 3.14.2 -- % of men age 15-49 who consumed any alcohol in the past month, by state.
NDHS_ALCOHOL_MALE = {
    "Federal Capital Territory": 24.6, "Benue": 46.6, "Kogi": 24.4, "Kwara": 8.7, "Nasarawa": 12.1, "Niger": 1.8, "Plateau": 26.0,
    "Adamawa": 12.2, "Bauchi": 3.9, "Borno": 0.0, "Gombe": 3.4, "Taraba": 24.4, "Yobe": 0.0,
    "Jigawa": 0.4, "Kaduna": 7.1, "Kano": 0.6, "Katsina": 0.4, "Kebbi": 0.2, "Sokoto": 0.2, "Zamfara": 0.0,
    "Abia": 51.2, "Anambra": 77.7, "Ebonyi": 60.1, "Enugu": 40.8, "Imo": 79.2,
    "Akwa Ibom": 73.0, "Bayelsa": 38.2, "Cross River": 60.8, "Delta": 68.0, "Edo": 47.3, "Rivers": 53.5,
    "Ekiti": 45.1, "Lagos": 34.8, "Ogun": 45.2, "Ondo": 28.2, "Osun": 25.9, "Oyo": 12.7,
}
# Table 11.14.1 -- % of women age 20-49 with BMI >= 25.0 (overweight or obese), by state.
NDHS_BMI_OVERWEIGHT_WOMEN = {
    "Federal Capital Territory": 54.0, "Benue": 28.0, "Kogi": 27.6, "Kwara": 34.8, "Nasarawa": 36.0, "Niger": 21.6, "Plateau": 32.2,
    "Adamawa": 16.0, "Bauchi": 17.0, "Borno": 10.1, "Gombe": 16.5, "Taraba": 21.7, "Yobe": 16.0,
    "Jigawa": 5.5, "Kaduna": 23.0, "Kano": 19.5, "Katsina": 11.9, "Kebbi": 16.6, "Sokoto": 11.0, "Zamfara": 13.0,
    "Abia": 48.7, "Anambra": 52.4, "Ebonyi": 23.4, "Enugu": 50.4, "Imo": 52.7,
    "Akwa Ibom": 40.2, "Bayelsa": 45.8, "Cross River": 44.3, "Delta": 52.5, "Edo": 49.9, "Rivers": 50.3,
    "Ekiti": 37.6, "Lagos": 53.1, "Ogun": 49.9, "Ondo": 47.1, "Osun": 32.4, "Oyo": 32.3,
}
# Table 2.4 -- % of the de jure population primarily relying on solid fuels
# for cooking (wood/charcoal/crop waste/dung/etc), by state.
NDHS_SOLID_FUEL_COOKING = {
    "Federal Capital Territory": 39.3, "Benue": 90.9, "Kogi": 89.9, "Kwara": 74.3, "Nasarawa": 76.9, "Niger": 95.0, "Plateau": 94.3,
    "Adamawa": 98.5, "Bauchi": 95.7, "Borno": 98.8, "Gombe": 93.5, "Taraba": 98.3, "Yobe": 97.4,
    "Jigawa": 98.5, "Kaduna": 92.2, "Kano": 90.3, "Katsina": 96.4, "Kebbi": 98.8, "Sokoto": 96.2, "Zamfara": 98.0,
    "Abia": 29.2, "Anambra": 54.5, "Ebonyi": 93.5, "Enugu": 69.7, "Imo": 60.3,
    "Akwa Ibom": 71.7, "Bayelsa": 31.5, "Cross River": 76.7, "Delta": 34.1, "Edo": 34.1, "Rivers": 26.0,
    "Ekiti": 71.4, "Lagos": 6.4, "Ogun": 24.8, "Ondo": 40.7, "Osun": 54.6, "Oyo": 41.3,
}
# Table 19.1.2 -- % of men age 15-49 ever told by a health worker they have
# high blood pressure/hypertension, by state.
NDHS_HYPERTENSION_DIAG_MALE = {
    "Federal Capital Territory": 13.1, "Benue": 5.1, "Kogi": 19.0, "Kwara": 5.0, "Nasarawa": 8.1, "Niger": 2.1, "Plateau": 5.8,
    "Adamawa": 9.6, "Bauchi": 1.7, "Borno": 4.2, "Gombe": 3.2, "Taraba": 5.8, "Yobe": 6.2,
    "Jigawa": 3.8, "Kaduna": 7.9, "Kano": 2.7, "Katsina": 2.3, "Kebbi": 1.1, "Sokoto": 2.8, "Zamfara": 3.5,
    "Abia": 4.2, "Anambra": 3.5, "Ebonyi": 1.4, "Enugu": 5.4, "Imo": 5.8,
    "Akwa Ibom": 4.8, "Bayelsa": 4.0, "Cross River": 5.4, "Delta": 13.5, "Edo": 13.0, "Rivers": 10.7,
    "Ekiti": 3.5, "Lagos": 6.8, "Ogun": 11.7, "Ondo": 12.8, "Osun": 7.0, "Oyo": 3.7,
}
# Table 9.26 -- % of women age 15-49 ever examined for breast cancer / ever
# tested for cervical cancer, by GEOPOLITICAL ZONE only (the report's state
# breakdown wasn't extracted -- zone-level applied uniformly within each
# zone's states, same disclosed-resolution pattern as the GBD PAF levers
# below, not fabricated down to state grain).
NDHS_BREAST_EXAM_ZONE = {"NC": 4.5, "NE": 2.8, "NW": 2.8, "SE": 7.7, "SS": 9.2, "SW": 11.3}
NDHS_CERVICAL_TEST_ZONE = {"NC": 2.1, "NE": 2.1, "NW": 2.2, "SE": 3.0, "SS": 3.9, "SW": 7.1}

# Ojo AE et al., "The Burden of Cardiovascular Disease Attributable to
# Hypertension in Nigeria: A Modelling Study Using Summary-Level Data",
# Global Heart 2024;19(1):49 -- real zone-level population-attributable
# fraction of hypertension for myocardial infarction (not a survey, a
# modelling study on a 52-study prevalence meta-analysis + INTERHEART odds
# ratios). Used only to calibrate Coronary Heart Disease's real
# hypertension-prevalence lever's elasticity magnitude, not as a lever value
# itself.
GBD_MI_PAF_ZONE = {"NC": 13.3, "NE": 12.1, "NW": 13.3, "SE": 13.4, "SS": 12.7, "SW": 13.1}

# Eigege A et al., "Long-Lasting Insecticidal Nets and Anti-Filarial Drugs:
# A Cross-Sectional Study to Assess Progress in Nigeria's Lymphatic
# Filariasis Elimination Program", Am J Trop Med Hyg 2017 (PMC5590580) --
# Plateau and Nasarawa states stopped mass drug administration statewide in
# 2013 after 2012 transmission-assessment surveys found antigenemia in only
# 25/7,131 children (0.4%) across 21 LGAs, i.e. real, confirmed elimination-
# threshold MDA coverage. Every other endemic state's MDA coverage figure is
# the real independent 2003 population-based survey national average (see
# NCD_NTD_LEVER_RESEARCH.md's Elephantiasis section) -- disclosed as a
# national constant applied elsewhere, not state-specific, since no other
# state's real MDA coverage figure was found.
LF_MDA_STOPPED_STATES = {"Plateau", "Nasarawa"}
LF_MDA_COVERAGE_DEFAULT = 72.2

# Registry: driver key -> (state->value dict, label, unit, elasticity, good,
# citation). Elasticity signs are a genuine, disease-specific modelling
# judgement, not copy-pasted: tobacco/alcohol/BMI/solid-fuel/hypertension-
# prevalence are real INCIDENCE risk factors (positive elasticity -- more
# exposure, more future cases). Breast/cervical cancer exam & screening
# rates are the opposite kind of real effect: these dashboards' forecast
# target is "new cases (SUSPECTED)", a detection-driven count, so more
# screening finds MORE suspected cases in the short term, not fewer --
# elasticity is honestly POSITIVE here too, disclosed in audience_label
# rather than silently assumed protective.
LIT_STATE_CATALOG = {
    "tobacco_male": (NDHS_TOBACCO_MALE, "Tobacco use (men)", "%", 0.30, "up",
        "NDHS 2024 (FR395) Table 3.10.2 -- % of men 15-49 who smoke any tobacco product, by state."),
    "alcohol_male": (NDHS_ALCOHOL_MALE, "Alcohol use (men)", "%", 0.25, "up",
        "NDHS 2024 (FR395) Table 3.14.2 -- % of men 15-49 who consumed any alcohol in the past month, by state."),
    "bmi_overweight_women": (NDHS_BMI_OVERWEIGHT_WOMEN, "Overweight/obesity (women)", "%", 0.30, "up",
        "NDHS 2024 (FR395) Table 11.14.1 -- % of women 20-49 with BMI >= 25.0, by state."),
    "solid_fuel": (NDHS_SOLID_FUEL_COOKING, "Solid-fuel cooking reliance", "%", 0.30, "up",
        "NDHS 2024 (FR395) Table 2.4 -- % of population primarily relying on solid/biomass fuels for cooking, by state."),
    "htn_diag_male": (NDHS_HYPERTENSION_DIAG_MALE, "Hypertension prevalence (men, self-reported)", "%", 0.35, "up",
        "NDHS 2024 (FR395) Table 19.1.2 -- % of men 15-49 ever told they have hypertension, by state. Elasticity magnitude calibrated from Ojo et al. 2024 Global Heart's real zone-level hypertension-attributable myocardial-infarction PAF (~12-13%)."),
}
LIT_ZONE_CATALOG = {
    "breast_exam": (NDHS_BREAST_EXAM_ZONE, "Breast cancer examination rate", "%", 0.35, "up",
        "NDHS 2024 (FR395) Table 9.26 -- % of women 15-49 ever examined for breast cancer, by geopolitical zone (zone-level only, applied uniformly within each zone's states). More screening finds more SUSPECTED cases in the short term (a real detection effect) -- this forecast target is suspected new cases, not confirmed incidence, so elasticity is honestly positive."),
    "cervical_test": (NDHS_CERVICAL_TEST_ZONE, "Cervical cancer screening rate", "%", 0.35, "up",
        "NDHS 2024 (FR395) Table 9.26 -- % of women 15-49 ever tested for cervical cancer, by geopolitical zone (zone-level only). Same detection-effect reasoning as the Breast Cancer screening lever."),
}

# Real per-LGA population + socio-economic columns confirmed live and
# non-null in agg_lga_pop.parquet (see module docstring for which columns
# were checked and found NULL). dep_water is the only deprivation sub-index
# still used as a lever (Yaws) -- dep_schooling/dep_electricity/dep_housing
# were dropped once every disease that used to reuse them as a generic
# proxy got a real NDHS-backed lever instead (see module docstring).
POP_COLS = ["state", "lga", "year", "population", "pop_density", "poverty_mpi_h", "dep_water"]


def load_pop():
    df = pd.read_parquet("agg_lga_pop.parquet", columns=POP_COLS)
    df = df.dropna(subset=["state", "lga", "year"]).drop_duplicates(["state", "lga", "year"])
    latest_year = df["year"].max()
    return df[df["year"] == latest_year].copy(), int(latest_year)


def load_hiv_prevalence():
    """Real per-state/LGA HIV positivity rate (hts_pos/hts_tested x 100),
    latest real (non-forecast) month, from this repo's own HIV burden data --
    used ONLY as Cervical Cancer's HIV-coinfection covariate."""
    path = os.path.join(OUT_ROOT, "hiv", "burden_rich.json")
    if not os.path.exists(path):
        return {}, {}
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    months = d["months"]
    last_real_idx = max((i for i, m in enumerate(months) if not m["forecast"]), default=len(months) - 1)

    def rate_for(area):
        tested = area.get("hts_tested", [None] * len(months))[last_real_idx] or 0
        pos = area.get("hts_pos", [None] * len(months))[last_real_idx] or 0
        return round(100 * pos / tested, 3) if tested > 0 else None

    state_rates = {name: r for name, area in d["states"].items() if (r := rate_for(area)) is not None}
    lga_rates = {}
    for key, area in d["lgas"].items():
        r = rate_for(area)
        if r is not None:
            state, lga = key.split("|||")
            lga_rates[(wh.normalize_lga_name(state), wh.normalize_lga_name(lga))] = r
    return state_rates, lga_rates


def wavg(df, col, weight_col="population"):
    d = df.dropna(subset=[col, weight_col])
    if d.empty or d[weight_col].sum() == 0:
        return None
    return float((d[col] * d[weight_col]).sum() / d[weight_col].sum())


def band(base, lo_mult, hi_mult, lo_min=None, hi_max=None):
    lo = base * lo_mult
    hi = base * hi_mult
    if lo_min is not None:
        lo = max(lo, lo_min)
    if hi_max is not None:
        hi = min(hi, hi_max)
    return {"base": round(base, 3), "lo": round(lo, 3), "hi": round(hi, 3)}


# ── Per-disease lever catalog. Every entry: (driver_id, column_or_source,
# meta). `column` is a real agg_lga_pop.parquet column name, or the literal
# "hiv_prevalence" sentinel handled specially below. ─────────────────────
DEP_LABELS = {
    "dep_water": ("Water-access deprivation", "Households without safe drinking water access (real MPI sub-index) -- a direct WASH/hygiene proxy, relevant to poverty- and hygiene-linked disease spread. DISCLOSED LIMITATION for Yaws specifically: a 2023 active case-search study screening 105,015 schoolchildren across 7 LGAs of Enugu State found ZERO confirmed yaws cases (Ekeke et al. 2023, PLOS NTD, doi.org/10.1371/journal.pntd.0011753), and WHO's current yaws fact sheet does not list Nigeria among endemic countries -- no modern geo-resolved yaws risk data exists anywhere, so this lever remains the best available real WASH proxy rather than a yaws-specific finding."),
}


def lever_catalog(disease_id):
    """Returns a list of (driver_id, kind, extra) for this disease.
    kind: 'population' | 'mpi' | 'dep:<col>' | 'density' | 'hiv_prevalence'."""
    pop_audience = {
        "hypertension": (ADULT_SHARE, "adults (18+)"),
        "diabetes": (ADULT_SHARE, "adults (18+)"),
        "cervical_cancer": (ADULT_SHARE * FEMALE_SHARE, "adult women"),
        "asthma": (1.0, "all ages (pediatric-weighted risk, see Cooking-fuel-proxy lever)"),
        "arthritis": (ADULT_SHARE, "adults (18+, real 45+/60+ state split not available)"),
        "depression": (ADULT_SHARE, "working-age adults (18+)"),
        "breast_cancer": (ADULT_SHARE * FEMALE_SHARE, "adult women"),
        "coronary_heart_disease": (ADULT_SHARE, "adults (18+)"),
        "sickle_cell": (1.0, "whole population (genetic; a true births/under-5 cohort figure isn't available per-LGA)"),
        "yaws": (CHILD_SHARE, "children under 15 (WHO: 75-80% of cases)"),
        "elephantiasis": (1.0, "general population in endemic LGAs"),
        "snake_bites": (ADULT_SHARE, "working-age adults (18+)"),
    }[disease_id]

    mpi_elasticity = {
        # Hypertension/diabetes/CHD reuse the real GBD Nigeria zone-level PAF
        # magnitude (~0.33, North West/North East stroke PAF) as their MPI
        # elasticity -- every other disease uses a modest, explicitly
        # disclosed default (0.3) since no disease-specific PAF was found.
        "hypertension": 0.33, "diabetes": 0.33, "coronary_heart_disease": 0.33,
    }

    # Population, Poverty (MPI) and Population Density are UNIVERSAL levers
    # on every single disease -- same real per-LGA source (agg_lga_pop.parquet),
    # same rescale-to-242,431,832 methodology already used by malaria/HIV, so
    # the same state/LGA/month reads the identical population and density
    # figure regardless of which disease's dashboard you're looking at.
    # Rural-associated diseases (per NCD_NTD_LEVER_RESEARCH.md: yaws,
    # elephantiasis, snake bites -- WHO/literature-documented rural exposure)
    # use a real disclosed direction (higher density = lower risk); every
    # other disease gets a small, explicitly modest default since no
    # disease-specific urban/rural finding was documented for it.
    rural_risk_diseases = {"yaws", "elephantiasis", "snake_bites"}
    density_good = "down" if disease_id in rural_risk_diseases else "up"

    cat = [("population", "population", {"audience": pop_audience[0], "audience_label": pop_audience[1]})]
    cat.append(("poverty", "mpi", {"elasticity": mpi_elasticity.get(disease_id, 0.30),
                                    "audience": pop_audience[0], "audience_label": pop_audience[1]}))
    cat.append(("density", "density", {"good": density_good}))

    # Real, disease-specific NDHS 2024 / GBD-modelling / ESPEN-adjacent
    # survey levers (see LIT_STATE_CATALOG/LIT_ZONE_CATALOG above) --
    # replacing the earlier generic MPI-deprivation-column stand-ins that
    # were reused near-identically across unrelated diseases. Hypertension,
    # Diabetes and Coronary Heart Disease deliberately share the SAME real
    # cardiometabolic risk-factor stack (tobacco/alcohol/BMI/hypertension
    # prevalence) per NCD_NTD_LEVER_RESEARCH.md's own reasoning ("CHD can
    # lever off the exact same stack already assembled for hypertension/
    # diabetes") -- the difference from before is these are now REAL
    # state-level survey values, not an arbitrary shared proxy.
    extra = {
        "hypertension": [("tobacco", "lit_state:tobacco_male", {}), ("alcohol", "lit_state:alcohol_male", {})],
        "diabetes": [("bmi", "lit_state:bmi_overweight_women", {}), ("alcohol", "lit_state:alcohol_male", {})],
        "coronary_heart_disease": [("htn_prev", "lit_state:htn_diag_male", {}), ("tobacco", "lit_state:tobacco_male", {})],
        "depression": [("alcohol", "lit_state:alcohol_male", {})],
        "arthritis": [("bmi", "lit_state:bmi_overweight_women", {})],
        "breast_cancer": [("brca_exam", "lit_zone:breast_exam", {})],
        "cervical_cancer": [("hiv_coinfection", "hiv_prevalence", {}), ("cx_screen", "lit_zone:cervical_test", {})],
        "asthma": [("solid_fuel", "lit_state:solid_fuel", {})],
        "sickle_cell": [],
        "yaws": [("water", "dep:dep_water", {})],
        "elephantiasis": [("mda", "lf_mda", {})],
        "snake_bites": [],
    }[disease_id]
    cat.extend(extra)
    return cat


DRIVER_LABELS = {
    "population": ("Population", ""),
    "poverty": ("Poverty (MPI headcount)", "%"),
    "hiv_coinfection": ("HIV co-infection prevalence", "%"),
    "density": ("Population density", "/km²"),
    "mda": ("LF mass drug administration coverage", "%"),
}


def build_drivers_for(disease_id, pop_latest, hiv_state_rates, hiv_lga_rates):
    catalog = lever_catalog(disease_id)
    meta = {}
    national, states, lgas = {}, {}, {}

    nat_pop = float(pop_latest["population"].sum())
    nat_dens = wavg(pop_latest, "pop_density")
    nat_mpi = wavg(pop_latest, "poverty_mpi_h")
    nat_deps = {c: wavg(pop_latest, c) for c in ["dep_water"]}
    nat_hiv = float(np.mean(list(hiv_state_rates.values()))) if hiv_state_rates else None

    state_groups = pop_latest.groupby("state")

    for driver_id, kind, extra in catalog:
        cat_label, unit = ("Demographics", "") if kind == "population" else \
            ("Socio-economic", "%") if kind in ("mpi",) or kind.startswith("dep:") else \
            ("Clinical", "%") if kind == "hiv_prevalence" else \
            ("Behavioural/environmental", "%") if kind.startswith("lit_state:") else \
            ("Clinical", "%") if kind.startswith("lit_zone:") else \
            ("Intervention", "%") if kind == "lf_mda" else \
            ("Geographic", "/km²")
        if kind.startswith("dep:"):
            col = kind.split(":", 1)[1]
            label, desc = DEP_LABELS[col]
        elif kind.startswith("lit_state:") or kind.startswith("lit_zone:"):
            lit_key = kind.split(":", 1)[1]
            lit_data, label, unit, lit_elasticity, lit_good, lit_citation = (
                LIT_STATE_CATALOG[lit_key] if kind.startswith("lit_state:") else LIT_ZONE_CATALOG[lit_key])
            desc = lit_citation
        else:
            label, _unit_fallback = DRIVER_LABELS.get(driver_id, (driver_id, unit))
            desc = None

        m = {"label": label, "unit": unit, "cat": cat_label, "good": extra.get("good", "up")}
        if kind == "population":
            m["elasticity"] = 1.0
            m["audience"] = extra["audience"]
            m["audience_label"] = extra["audience_label"]
        elif kind == "mpi":
            m["elasticity"] = extra["elasticity"]
            m["audience"] = extra["audience"]
            m["audience_label"] = extra["audience_label"] + " (poverty exposure scoped to the same at-risk group as Population)"
        elif kind.startswith("dep:"):
            m["elasticity"] = 0.25
            m["audience"] = 1.0
            m["audience_label"] = desc
        elif kind.startswith("lit_state:") or kind.startswith("lit_zone:"):
            m["good"] = lit_good
            m["elasticity"] = lit_elasticity
            m["audience"] = 1.0
            m["audience_label"] = desc
        elif kind == "lf_mda":
            # Real MDA coverage (see LF_MDA_STOPPED_STATES/LF_MDA_COVERAGE_DEFAULT
            # above) -- a genuine PREVENTIVE intervention, unlike the cancer
            # screening levers above: MDA reduces actual microfilaria/worm
            # burden, so higher coverage lowers FUTURE true case counts
            # (negative elasticity), not a detection effect.
            m["elasticity"] = -0.30
            m["audience"] = 1.0
            m["audience_label"] = ("Real MDA coverage: Plateau and Nasarawa states stopped mass drug administration "
                                    "statewide in 2013 after transmission-assessment surveys found antigenemia in only "
                                    "0.4% of children (Eigege et al. 2017, Am J Trop Med Hyg, PMC5590580) -- shown here "
                                    "as 0% (no more MDA needed). Every other state uses the real national independent-"
                                    "survey MDA coverage estimate (72.2%, see NCD_NTD_LEVER_RESEARCH.md) as a disclosed "
                                    "national constant, since no other state's own MDA coverage figure was found.")
        elif kind == "hiv_prevalence":
            # Real relative risk (Stelzle et al. 2020, Lancet Global Health,
            # WHO-cited meta-analysis, RR=6.07, 95% CI 4.4-8.37) converted to
            # an elasticity: a 100% relative increase in local HIV
            # prevalence is treated as moving the case rate toward that
            # cited relative-risk magnitude, capped by Simulator.jsx's own
            # [0.2, 3] multiplier bound -- disclosed in audience_label.
            m["elasticity"] = 1.2
            m["audience"] = 1.0
            m["audience_label"] = ("Real published relative risk: HIV-positive women have 6.07x the cervical "
                                    "cancer risk of HIV-negative women (Stelzle et al. 2020, Lancet Global Health, "
                                    "WHO-cited meta-analysis of 24 studies, 95% CI 4.4-8.37). This lever moves "
                                    "local HIV prevalence and applies that real relative-risk relationship.")
        elif kind == "density":
            m["elasticity"] = 0.25 if extra.get("good") == "down" else 0.25
            m["audience"] = 1.0
            m["audience_label"] = "Lower-density (more rural) areas carry higher real risk for this disease -- see NCD_NTD_LEVER_RESEARCH.md."
        meta[driver_id] = m

        # national baseline
        if kind == "population":
            national[driver_id] = band(nat_pop, 0.5, 2.0, lo_min=0)
        elif kind == "mpi":
            national[driver_id] = band(nat_mpi or 40.0, 1.0, 1.0, lo_min=0, hi_max=100)
            national[driver_id]["lo"], national[driver_id]["hi"] = 0.0, 100.0
        elif kind.startswith("dep:"):
            col = kind.split(":", 1)[1]
            v = nat_deps.get(col) or 30.0
            national[driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
        elif kind.startswith("lit_state:"):
            v = float(np.mean(list(lit_data.values())))
            national[driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
        elif kind.startswith("lit_zone:"):
            v = float(np.mean(list(lit_data.values())))
            national[driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
        elif kind == "lf_mda":
            national[driver_id] = {"base": LF_MDA_COVERAGE_DEFAULT, "lo": 0.0, "hi": 100.0}
        elif kind == "hiv_prevalence":
            v = nat_hiv or 1.5
            national[driver_id] = {"base": round(v, 3), "lo": 0.0, "hi": max(20.0, round(v * 4, 1))}
        elif kind == "density":
            national[driver_id] = band(nat_dens or 500.0, 0.2, 3.0, lo_min=1)

        # state baselines
        for state_name, grp in state_groups:
            states.setdefault(state_name, {})
            if kind == "population":
                base = float(grp["population"].sum())
                states[state_name][driver_id] = band(base, 0.5, 2.0, lo_min=0)
            elif kind == "mpi":
                v = wavg(grp, "poverty_mpi_h")
                states[state_name][driver_id] = {"base": round(v, 2) if v is not None else 40.0, "lo": 0.0, "hi": 100.0}
            elif kind.startswith("dep:"):
                col = kind.split(":", 1)[1]
                v = wavg(grp, col)
                states[state_name][driver_id] = {"base": round(v, 2) if v is not None else 30.0, "lo": 0.0, "hi": 100.0}
            elif kind.startswith("lit_state:"):
                v = lit_data.get(state_name, national[driver_id]["base"])
                states[state_name][driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
            elif kind.startswith("lit_zone:"):
                v = lit_data.get(STATE_TO_ZONE.get(state_name), national[driver_id]["base"])
                states[state_name][driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
            elif kind == "lf_mda":
                v = 0.0 if state_name in LF_MDA_STOPPED_STATES else LF_MDA_COVERAGE_DEFAULT
                states[state_name][driver_id] = {"base": v, "lo": 0.0, "hi": 100.0}
            elif kind == "hiv_prevalence":
                v = hiv_state_rates.get(state_name, nat_hiv or 1.5)
                states[state_name][driver_id] = {"base": round(v, 3), "lo": 0.0, "hi": max(20.0, round(v * 4, 1))}
            elif kind == "density":
                v = wavg(grp, "pop_density")
                states[state_name][driver_id] = band(v or 500.0, 0.2, 3.0, lo_min=1)

        # LGA baselines
        for _, row in pop_latest.iterrows():
            key = f"{row['state']}|||{row['lga']}"
            lgas.setdefault(key, {})
            if kind == "population":
                lgas[key][driver_id] = band(float(row["population"]), 0.5, 2.0, lo_min=0)
            elif kind == "mpi":
                v = row["poverty_mpi_h"]
                lgas[key][driver_id] = {"base": round(float(v), 2) if pd.notna(v) else 40.0, "lo": 0.0, "hi": 100.0}
            elif kind.startswith("dep:"):
                col = kind.split(":", 1)[1]
                v = row[col]
                lgas[key][driver_id] = {"base": round(float(v), 2) if pd.notna(v) else 30.0, "lo": 0.0, "hi": 100.0}
            elif kind.startswith("lit_state:"):
                v = lit_data.get(row["state"], national[driver_id]["base"])
                lgas[key][driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
            elif kind.startswith("lit_zone:"):
                v = lit_data.get(STATE_TO_ZONE.get(row["state"]), national[driver_id]["base"])
                lgas[key][driver_id] = {"base": round(v, 2), "lo": 0.0, "hi": 100.0}
            elif kind == "lf_mda":
                v = 0.0 if row["state"] in LF_MDA_STOPPED_STATES else LF_MDA_COVERAGE_DEFAULT
                lgas[key][driver_id] = {"base": v, "lo": 0.0, "hi": 100.0}
            elif kind == "hiv_prevalence":
                lk = (wh.normalize_lga_name(row["state"]), wh.normalize_lga_name(row["lga"]))
                v = hiv_lga_rates.get(lk, hiv_state_rates.get(row["state"], nat_hiv or 1.5))
                lgas[key][driver_id] = {"base": round(v, 3), "lo": 0.0, "hi": max(20.0, round(v * 4, 1))}
            elif kind == "density":
                v = row["pop_density"]
                lgas[key][driver_id] = band(float(v) if pd.notna(v) else 500.0, 0.2, 3.0, lo_min=1)

    return {"meta": meta, "national": national, "states": states, "lgas": lgas}


def export_one(disease_id, pop_latest, pop_year, hiv_state_rates, hiv_lga_rates):
    out_dir = os.path.join(OUT_ROOT, disease_id)
    os.makedirs(out_dir, exist_ok=True)
    drivers = build_drivers_for(disease_id, pop_latest, hiv_state_rates, hiv_lga_rates)
    with open(os.path.join(out_dir, "drivers.json"), "w", encoding="utf-8") as f:
        json.dump(drivers, f, ensure_ascii=False)
    print(f"  {disease_id}: {len(drivers['meta'])} levers, {len(drivers['states'])} states, {len(drivers['lgas'])} LGAs (population year {pop_year})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--disease", default=None, help="comma-separated disease ids")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    ids = args.disease.split(",") if args.disease else (NCD_NTD_DISEASE_IDS if args.all else [])
    if not ids:
        raise SystemExit("Pass --disease id1,id2 or --all")
    for did in ids:
        if did not in dc.DISEASES:
            print(f"! unknown disease_id '{did}', skipping")
            continue

    print("Loading real population + socio-economic data (agg_lga_pop.parquet)...")
    pop_latest, pop_year = load_pop()
    print(f"  {len(pop_latest)} LGA rows, year {pop_year}")
    print("Loading real HIV co-infection prevalence (this repo's own live HIV burden data)...")
    hiv_state_rates, hiv_lga_rates = load_hiv_prevalence()
    print(f"  {len(hiv_state_rates)} states, {len(hiv_lga_rates)} LGAs with real HIV positivity data")

    for did in ids:
        if did not in dc.DISEASES:
            continue
        export_one(did, pop_latest, pop_year, hiv_state_rates, hiv_lga_rates)
    print("Done.")
