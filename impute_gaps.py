"""
Reporting-gap imputation. December 2023 has a total surveillance gap (national
confirmed-cases = 0; no facility reported that month), an obvious outlier next to
~2-3M in every neighbouring month. We impute it per-LGA by linear interpolation
between Nov-2023 and Jan-2024 for the target and every reported indicator, then
recompute incidence. Run after enrich_pop.py, before the modelling steps.
"""
import json, pandas as pd, numpy as np
TARGET = "MAL - Malaria cases confirmed (number)"
mp = json.load(open("aggregation_map.json", encoding="utf-8"))
REPORT_COLS = [TARGET] + mp["sum"] + mp["mean"]

DEC23 = (2023, 12)
NOV23 = (2023, 11)
JAN24 = (2024, 1)

for path in ["agg_lga_pop.parquet", "agg_state_pop.parquet"]:
    d = pd.read_parquet(path)
    keys = ["state", "lga"] if "lga" in d.columns else ["state"]
    d["_k"] = d[keys].astype(str).agg("|".join, axis=1)
    nov = d[(d.year == NOV23[0]) & (d.month == NOV23[1])].set_index("_k")
    jan = d[(d.year == JAN24[0]) & (d.month == JAN24[1])].set_index("_k")
    mask = (d.year == DEC23[0]) & (d.month == DEC23[1])
    n_before = float(d.loc[mask, TARGET].sum())
    cols = [c for c in REPORT_COLS if c in d.columns]
    for c in cols:
        interp = ((nov[c] + jan[c]) / 2.0)
        d.loc[mask, c] = d.loc[mask, "_k"].map(interp).astype(float).values
    if "population" in d.columns and "incidence_per_1000" in d.columns:
        d["incidence_per_1000"] = d[TARGET] / d["population"] * 1000
    n_after = float(d.loc[mask, TARGET].sum())
    d.drop(columns="_k").to_parquet(path, index=False)
    print(f"{path}: Dec-2023 target {n_before:,.0f} -> {n_after:,.0f} ({mask.sum()} rows, {len(cols)} cols imputed)")
