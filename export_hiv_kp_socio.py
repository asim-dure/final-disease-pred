"""
HIV What-If & Budget tab -- Key Population + socioeconomic lever data.
ui/public/data/after/hiv/kp_socio.json (national + state grain only --
key-population counts are too sparse per-LGA to support an honest slider
at that grain; state/national is the defensible scope).

STANDING CONSTRAINT: NDARS (system_id=7) only. Verified live: Nigeria's
NDARS reports Key Population testing/PrEP-uptake broken out by MSM, PWID
(Injecting Drug Users), SW (Sex Workers) and TG (Transgender) -- but the
MSM breakout is reported under the label "SDC" (Sexual and Gender-Diverse
Community), NASCP's official euphemism for MSM in Nigeria's public-health
reporting (Nigeria criminalises same-sex relations, so program data avoids
the literal term). A SEPARATE, more granular MSM-labelled indicator family
does exist in the warehouse (age-banded "No of KP who tested HIV +/-ve &
R.Results/<age>/MSM") but it is exclusively system_id=2 (ENNRIMS), not
NDARS -- per the standing NDARS-only constraint, that family is NOT used
here. "SDC" is the correct, current, NDARS-native (system_id=7) MSM proxy.

Real NDARS coverage confirmed live per group (PrEP-eligibility indicator,
national, 2025-2026): SDC ~530 distinct LGAs reporting, Sex Workers ~660,
Injecting Drug Users ~590, Transgender ~540 -- current through the same
month range as every other indicator in this build. PWID/SW/TG additionally
have real "tested for HIV" + "tested HIV positive" NDARS indicators
(SDC/MSM does not -- PrEP-eligibility is the only NDARS-native SDC series),
giving PWID/SW/TG a real testing-volume + positivity-rate baseline.

Socioeconomic factors (poverty / literacy proxy) are NOT a warehouse
indicator -- reused from agg_lga_pop.parquet's real OPHI/NBS Multidimensional
Poverty Index 2019 columns (poverty_mpi_h, dep_schooling), the SAME
state-level survey dataset malaria's own model already trains on
(integrate_external2.py). dep_schooling ("deprivation: years of schooling")
is inverted to a 0-100 "literacy/education access" reading so raising the
slider = more education access = protective, matching every other lever's
"up = better" convention in this tab.

Key-population prevalence anchors (cited, not fitted -- see HivWhatIfBudget.jsx
info tooltips for the same citations shown to the user): Nigeria's 2020-2021
Integrated Biological & Behavioural Surveillance Survey (IBBSS), published in
PMC (HIV epidemic among key populations in Nigeria, IBBSS 2020-2021):
weighted HIV prevalence 25.0% (MSM), 15.5% (FSW/SW), 10.9% (PWID), 28.8%
(Transgender) -- vs Nigeria's national adult HIV prevalence ~1.3% (NAIIS
2018). Population-size estimates (NACA Key Population Size Estimation,
2023): ~600,000 MSM, ~740,000 FSW, ~441,500 PWID, ~94,000 Transgender.
"""
import json
import os
import numpy as np
import pandas as pd
from dotenv import load_dotenv
load_dotenv()

import etl_warehouse_common as ewc
import warehouse as wh

OUT_PATH = "ui/public/data/after/hiv/kp_socio.json"
DISEASE_ID = "hiv"

# ── Key Population indicator catalog -- NDARS (system_id=7) ONLY ───────────
KP_GROUPS = {
    "msm": {
        "display": "MSM", "male_only": True,
        "prep_eligible": "PREP.1. No. of individuals who were eligible and started PrEP in the reporting month, SDC, Total",
        "tested": None, "tested_pos": None,   # no NDARS-native "tested for HIV" series for SDC
        "prevalence_pct": 25.0, "pop_estimate": 600_000,
    },
    "pwid": {
        "display": "PWID (People who inject drugs)", "male_only": False,
        "prep_eligible": "PREP.1. No. of individuals who were eligible and started PrEP in the reporting month, Injecting Drug Users, Total",
        "tested": ["Total number of key population who tested for HIV and received results, PWID, Male",
                   "Total number of key population who tested for HIV and received results, PWID, Female"],
        "tested_pos": ["Total number of Key Population who tested HIV positive and received results, PWID, Male",
                       "Total number of Key Population who tested HIV positive and received results, PWID, Female"],
        "prevalence_pct": 10.9, "pop_estimate": 441_500,
    },
    "sw": {
        "display": "Sex Workers", "male_only": False,
        "prep_eligible": "PREP.1. No. of individuals who were eligible and started PrEP in the reporting month, Sex Workers, Total",
        "tested": ["Total number of key population who tested for HIV and received results, SW, Male",
                   "Total number of key population who tested for HIV and received results, SW, Female"],
        "tested_pos": ["Total number of Key Population who tested HIV positive and received results, SW, Male",
                       "Total number of Key Population who tested HIV positive and received results, SW, Female"],
        "prevalence_pct": 15.5, "pop_estimate": 740_000,
    },
    "tg": {
        "display": "Transgender", "male_only": False,
        "prep_eligible": "PREP.1. No. of individuals who were eligible and started PrEP in the reporting month, Transgender, Total",
        "tested": ["Total number of key population who tested for HIV and received results, TG, Male",
                   "Total number of key population who tested for HIV and received results, TG, Female"],
        "tested_pos": ["Total number of Key Population who tested HIV positive and received results, TG, Male",
                       "Total number of Key Population who tested HIV positive and received results, TG, Female"],
        "prevalence_pct": 28.8, "pop_estimate": 94_000,
    },
}
NATIONAL_ADULT_PREVALENCE_PCT = 1.3   # NAIIS 2018, cited above

def _recent_total(names, level="state"):
    """Real NDARS monthly series -> {state: recent-12mo-avg} plus a national total."""
    df = ewc.fetch_fact_series(DISEASE_ID, names, level=level, system_id=7)
    df["ym"] = df["year"] * 12 + df["month"] - 1
    last_ym = df["ym"].max()
    recent = df[df["ym"] >= last_ym - 11]
    by_state = recent.groupby("state")["value"].mean().round(1).to_dict()
    national = float(recent.groupby("ym")["value"].sum().mean())
    return by_state, round(national, 1), int(last_ym)


def _national_monthly_series(names):
    """Real NDARS national monthly total, EVERY reported month (not just a
    recent-12mo average) -- {ym_int: value}. Used to build a real trend chart
    for KP levers in the dashboard, matching every other real-data chart in
    this build instead of a single snapshot number."""
    df = ewc.fetch_fact_series(DISEASE_ID, names, level="state", system_id=7)
    df["ym"] = df["year"] * 12 + df["month"] - 1
    return df.groupby("ym")["value"].sum().to_dict()


# ── real monthly series aligned to burden_rich.json's own month window, so
# the dashboard's KP chart shares the exact same x-axis/forecast-tail logic
# as every other real chart -- reads that file directly rather than
# recomputing FIRST_REAL_YM/FCAST independently, so the two can never drift.
def _kp_series_aligned():
    with open("ui/public/data/after/hiv/burden_rich.json") as f:
        br = json.load(f)
    months = br["months"]
    out_months = [{"ym": m["ym"], "label": m["label"], "forecast": m["forecast"]} for m in months]
    ym_ints = [int(m["ym"].split("-")[0]) * 12 + int(m["ym"].split("-")[1]) - 1 for m in months]
    series = {}
    for gid, g in KP_GROUPS.items():
        raw = _national_monthly_series(g["prep_eligible"])
        real_vals = {ym: v for ym, v in raw.items() if ym in ym_ints}
        # calendar-month climatology for the forecast tail -- same honest
        # fallback method used throughout this build (no HIV-specific ML
        # forecast model exists for KP levers).
        by_cal = {}
        for ym, v in real_vals.items():
            by_cal.setdefault(ym % 12, []).append(v)
        clim = {cal: (sum(vs) / len(vs)) for cal, vs in by_cal.items()}
        vals = []
        for ym, m in zip(ym_ints, months):
            if not m["forecast"] and ym in real_vals:
                vals.append(round(real_vals[ym], 1))
            elif not m["forecast"]:
                vals.append(0.0)
            else:
                vals.append(round(clim.get(ym % 12, sum(real_vals.values()) / max(1, len(real_vals))), 1))
        series[gid] = vals
    return {"months": out_months, "series": series}


kp_out = {}
for gid, g in KP_GROUPS.items():
    prep_by_state, prep_national, last_ym = _recent_total(g["prep_eligible"])
    entry = {
        "display": g["display"], "male_only": g["male_only"],
        "prevalence_pct": g["prevalence_pct"], "pop_estimate": g["pop_estimate"],
        "prep_eligible_monthly_national": prep_national,
        "prep_eligible_monthly_by_state": prep_by_state,
        "last_ym": last_ym,
    }
    if g["tested"]:
        tested_by_state, tested_national, _ = _recent_total(g["tested"])
        pos_by_state, pos_national, _ = _recent_total(g["tested_pos"])
        entry["tested_monthly_national"] = tested_national
        entry["tested_pos_monthly_national"] = pos_national
        entry["positivity_pct"] = round(100 * pos_national / tested_national, 2) if tested_national else None
    else:
        entry["tested_monthly_national"] = None
        entry["tested_pos_monthly_national"] = None
        entry["positivity_pct"] = None
    kp_out[gid] = entry
    testing_note = "testing n/a (SDC not NDARS-tracked for testing)" if not g["tested"] else f"tested/mo {entry['tested_monthly_national']}, positivity {entry['positivity_pct']}%"
    print(f"{gid}: PrEP-eligible/mo {prep_national} (national), {testing_note}")

# ── audience weight: each group's modelled share of Nigeria's total PLHIV,
# derived from real cited pop_estimate x prevalence_pct (see module note) --
# a formula-driven, disclosed estimate, not a fabricated number.
NIGERIA_TOTAL_PLHIV = 1_900_000   # UNAIDS/NASCP commonly-cited Nigeria PLHIV estimate, all ages
for gid, e in kp_out.items():
    kp_plhiv = e["pop_estimate"] * e["prevalence_pct"] / 100.0
    e["audience"] = round(kp_plhiv / NIGERIA_TOTAL_PLHIV, 4)
    e["kp_plhiv_estimate"] = round(kp_plhiv)

# ── socioeconomic: reuse agg_lga_pop.parquet's real OPHI/NBS MPI 2019 columns.
# poverty_mpi_h / dep_schooling are RATE (%) fields, state-broadcast onto every
# LGA row -- national must average the 37 STATE-level values, not the raw LGA
# rows (states have unequal LGA counts, so averaging LGA rows would silently
# over-weight states with more LGAs). Real counts get summed elsewhere in this
# build; this is the average-the-%-columns half of that same rule.
pop = pd.read_parquet("agg_lga_pop.parquet", columns=["state", "year", "poverty_mpi_h", "dep_schooling"])
pop = pop.dropna(subset=["state"])
latest_year = pop["year"].max()
soc = pop[pop["year"] == latest_year].groupby("state")[["poverty_mpi_h", "dep_schooling"]].mean()
soc_national = {
    "poverty_mpi_h": round(float(soc["poverty_mpi_h"].mean()), 1),
    "literacy_access": round(100 - float(soc["dep_schooling"].mean()), 1),
}
soc_by_state = {
    s: {"poverty_mpi_h": round(float(r["poverty_mpi_h"]), 1) if pd.notna(r["poverty_mpi_h"]) else None,
        "literacy_access": round(100 - float(r["dep_schooling"]), 1) if pd.notna(r["dep_schooling"]) else None}
    for s, r in soc.iterrows()
}

kp_series = _kp_series_aligned()

out = {
    "source_note": "Key Population: NDARS (system_id=7) only, recent-12mo monthly average. "
                    "Socioeconomic: OPHI/NBS Multidimensional Poverty Index 2019 (state-level survey, same dataset malaria's model trains on). "
                    "Prevalence/population-estimate citations: Nigeria IBBSS 2020-2021 (PMC) + NACA Key Population Size Estimation 2023.",
    "national_adult_prevalence_pct": NATIONAL_ADULT_PREVALENCE_PCT,
    "nigeria_total_plhiv_estimate": NIGERIA_TOTAL_PLHIV,
    "kp": kp_out,
    "kp_series": kp_series,
    "socioeconomic": {"national": soc_national, "states": soc_by_state, "survey_year": int(latest_year)},
}
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
with open(OUT_PATH, "w") as f:
    json.dump(out, f, indent=2)
print(f"\nWrote {OUT_PATH}")
print("Audience weights (share of national PLHIV):", {k: v["audience"] for k, v in kp_out.items()})
print("kp_series months:", len(kp_series["months"]), "  last 3 msm vals:", kp_series["series"]["msm"][-3:])
