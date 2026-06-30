"""
HIV's real, warehouse-backed driver layer for the What-If Simulator --
ui/public/data/after/hiv/drivers.json, same shape drivers.py already
produces for malaria (meta / national / states / lgas / national_traj /
state_traj), consumed unmodified by Simulator.jsx.

Every driver below is an ACTUAL reported HIV programmatic indicator
(verified live against hiv.fact_indicator_data + dim_indicator_master --
see _tmp_check_drivers.py's output during implementation: each name maps
to exactly ONE (system_id, indicator_name) pair, current through 2026-05,
reported across 580-790 LGAs). No fabricated indicator is invented --
this mirrors the no-fabrication rule already applied to HIV's forecast
target. What IS a literature-based judgment call (same as malaria's own
NMEP/WHO-cited elasticities in drivers.py) is the *magnitude/direction* of
each driver's effect on future HTS_TST_POS, since the warehouse has no
randomized/causal study to fit an elasticity from directly:

  - ART coverage ("currently receiving ART"): WHO/UNAIDS "Treatment as
    Prevention" -- sustained viral suppression on ART cuts onward
    transmission. Strongest protective driver (elasticity -0.30).
  - Linkage to care ("newly enrolled in clinical care"): earlier
    enrollment -> earlier ART start -> shorter window of high
    infectiousness. Protective (elasticity -0.20).
  - PMTCT testing volume (pregnant/breastfeeding women tested): more
    case-finding -> more linkage to treatment -> protective, same
    "testing reduces future transmission" logic malaria's RDT-testing
    driver already uses (elasticity -0.15, deliberately the gentlest of
    the three since the effect is one step further removed from the
    outcome -- finding cases doesn't itself treat them).

Indicators considered but excluded for staleness (verified, not silently
dropped): "Individuals HIV counseled, tested and received results" and
all 3 "Stock out of ... for 7 consecutive days" indicators last report in
2021/2022 respectively -- 4+ years stale relative to the live forecast
horizon, so no current baseline/slider could be derived honestly.
"""
import json
import os
import numpy as np
import pandas as pd

import etl_warehouse_common as ewc

OUT_DIR = "ui/public/data/after/hiv"
os.makedirs(OUT_DIR, exist_ok=True)
DISEASE_ID = "hiv"
FC_YEARS_AHEAD = 24  # months of forecast trajectory to export for the driver-outlook chart

DRIVER_META = {
    "art": {
        "indicator": "ART PLHIV currently receiving ART during the month (All regimen)",
        "system_id": 1,  # NHMIS
        "label": "PLHIV currently on ART", "unit": "/mo", "agg": "sum",
        "cat": "Treatment & Care", "elasticity": -0.30, "good": "down",
    },
    "linkage": {
        "indicator": "ART HIV-positive people newly enrolled in clinical care during the month",
        "system_id": 1,  # NHMIS
        "label": "Newly enrolled in HIV care", "unit": "/mo", "agg": "sum",
        "cat": "Treatment & Care", "elasticity": -0.20, "good": "down",
    },
    "pmtct_testing": {
        "indicator": "PMTCT_HTS_Total. Number of pregnant & Breast-feeding women HIV tested and received results (Incl. known Positive)",
        "system_id": 7,  # NDARS
        "label": "PMTCT testing volume", "unit": "/mo", "agg": "sum",
        "cat": "Testing & Case-Finding", "elasticity": -0.15, "good": "down",
    },
}


def _fetch(meta: dict, level: str) -> pd.DataFrame:
    df = ewc.fetch_fact_series(DISEASE_ID, meta["indicator"], level=level, system_id=meta.get("system_id"))
    df["ym"] = df["year"] * 12 + df["month"] - 1
    return df


def forecast_driver(series_by_ym: dict, last_ym: int, fc_years: list[int]):
    """Monthly climatology + damped annual trend -- identical method to
    malaria's drivers.py::forecast_driver, generalized to a caller-supplied
    `last_ym` (the data's own latest reported month) instead of a hardcoded
    constant, since this is new code with no excuse to go stale next month."""
    s = pd.Series(series_by_ym).dropna()
    if s.empty:
        return {}, np.nan
    months = (s.index % 12) + 1
    clim = s.groupby(months).mean()
    overall = s.mean()
    yrs = s.index // 12
    ann = s.groupby(yrs).mean()
    if len(ann) >= 2:
        x = np.array(ann.index, float)
        y = ann.values
        slope = np.polyfit(x, y, 1)[0] * 0.4
    else:
        slope = 0.0
    base_year = max(yrs)
    traj = {}
    for yr in fc_years:
        for m in range(1, 13):
            ym = yr * 12 + m - 1
            if ym <= last_ym:
                continue
            base = clim.get(m, overall)
            traj[ym] = float(max(0.0, base + slope * (yr - base_year)))
    fc_mean = float(np.mean(list(traj.values()))) if traj else overall
    return traj, fc_mean


def loc_baseline(g: pd.Series, recent12: list[int], last_ym: int, fc_years: list[int]) -> dict:
    hist = float(g.reindex(recent12).mean()) if not g.empty else np.nan
    traj, fc_mean = forecast_driver(g.to_dict(), last_ym, fc_years)
    if np.isnan(hist) and not np.isnan(fc_mean):
        hist = fc_mean
    base = fc_mean if not np.isnan(fc_mean) else hist
    if np.isnan(base):
        return None
    lo, hi = 0.0, round(max(base * 2.0, (hist or 0) * 2.0, 1), 1)
    return {"base": round(float(base), 2), "hist": round(float(hist if not np.isnan(hist) else base), 2),
            "lo": float(lo), "hi": float(hi)}


def build():
    print(f"=== HIV driver layer ({len(DRIVER_META)} real indicators) ===")
    per_driver_lga = {}
    max_ym_seen = 0
    for did, meta in DRIVER_META.items():
        df = _fetch(meta, level="lga")
        df = df.dropna(subset=["state", "lga"])
        per_driver_lga[did] = df
        if not df.empty:
            max_ym_seen = max(max_ym_seen, int(df["ym"].max()))
        print(f"  {did}: {len(df)} rows, {df[['state','lga']].drop_duplicates().shape[0]} LGAs, "
              f"max ym={df['ym'].max() if not df.empty else 'n/a'}")

    last_ym = max_ym_seen
    recent12 = list(range(last_ym - 11, last_ym + 1))
    last_year = last_ym // 12
    fc_years = list(range(last_year, last_year + 3))  # this year + next 2

    national, states, lgas = {}, {}, {}
    nat_traj, state_traj = {}, {}

    for did, meta in DRIVER_META.items():
        df = per_driver_lga[did]
        if df.empty:
            continue
        agg_fn = "sum" if meta["agg"] == "sum" else "mean"

        # national
        g_nat = df.groupby("ym")["value"].agg(agg_fn)
        b = loc_baseline(g_nat, recent12, last_ym, fc_years)
        if b:
            national[did] = b
        traj, _ = forecast_driver(g_nat.to_dict(), last_ym, fc_years)
        hist_pts = {ym: float(v) for ym, v in g_nat.items() if ym <= last_ym and ym >= (last_ym - 36)}
        merged = {**hist_pts, **traj}
        nat_traj[did] = [{"date": f"{ym // 12}-{ym % 12 + 1:02d}", "value": round(v, 2), "forecast": ym > last_ym}
                          for ym, v in sorted(merged.items())]

        # per state
        for state_name, grp in df.groupby("state"):
            g_s = grp.groupby("ym")["value"].agg(agg_fn)
            b = loc_baseline(g_s, recent12, last_ym, fc_years)
            if b:
                states.setdefault(state_name, {})[did] = b
            traj_s, _ = forecast_driver(g_s.to_dict(), last_ym, fc_years)
            hist_s = {ym: float(v) for ym, v in g_s.items() if ym <= last_ym and ym >= (last_ym - 36)}
            merged_s = {**hist_s, **traj_s}
            state_traj.setdefault(state_name, {})[did] = [
                {"date": f"{ym // 12}-{ym % 12 + 1:02d}", "value": round(v, 2), "forecast": ym > last_ym}
                for ym, v in sorted(merged_s.items())]

        # per LGA (baseline only, no trajectory -- keeps file compact, same as malaria's drivers.json)
        for (state_name, lga_name), grp in df.groupby(["state", "lga"]):
            g_l = grp.groupby("ym")["value"].agg(agg_fn)
            b = loc_baseline(g_l, recent12, last_ym, fc_years)
            if b:
                lgas.setdefault(f"{state_name}|||{lga_name}", {})[did] = b

    meta_export = {did: {"label": m["label"], "unit": m["unit"], "cat": m["cat"],
                          "elasticity": m["elasticity"], "good": m["good"]}
                   for did, m in DRIVER_META.items()}

    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, list):
            return [clean(v) for v in o]
        if isinstance(o, float) and (np.isnan(o) or np.isinf(o)):
            return 0.0
        return o

    payload = clean({"meta": meta_export, "national": national, "states": states, "lgas": lgas,
                      "national_traj": nat_traj, "state_traj": state_traj})
    out_path = os.path.join(OUT_DIR, "drivers.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, allow_nan=False)
    print(f"Wrote {out_path}: {round(os.path.getsize(out_path)/1024)} KB, "
          f"{len(national)} national drivers, {len(states)} states, {len(lgas)} LGAs")
    print("National baselines:", {k: v["base"] for k, v in national.items()})


if __name__ == "__main__":
    build()
