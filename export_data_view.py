"""
Write population-enriched aggregate CSVs and a compact monthly LGA dataset
(JSON) for the in-app Data Explorer, plus a data dictionary.
"""
import pandas as pd, numpy as np, json, os
TARGET = "MAL - Malaria cases confirmed (number)"
OUT = f"ui/public/data/{os.environ.get('MAL_VARIANT','after')}"; os.makedirs(OUT, exist_ok=True)

lga = pd.read_parquet("agg_lga_pop.parquet")
state = pd.read_parquet("agg_state_pop.parquet")

# population-enriched CSV deliverables
lga.to_csv("agg_lga_pop.csv", index=False)
state.to_csv("agg_state_pop.csv", index=False)

VIEW = {
    "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
    TARGET: "Confirmed cases",
    "MAL - Total reported malaria cases (confirmed + presumed)": "Total reported",
    "MAL - Malaria cases tested with RDT": "RDT tested",
    "ACT Given - Total": "ACT given",
    "LLIN given – Total": "LLINs given",
    "% of Fever cases Tested with RDT": "Fever RDT %",
    "rainfall_mm_day": "Rainfall (mm/d)",
    "temperature_mean_c": "Temp (°C)",
    "humidity_pct": "Humidity %",
    "population": "Population",
    "incidence_per_1000": "Incidence/1k",
    "n_facilities": "Facilities",
}
cols = [c for c in VIEW if c in lga.columns]
d = lga[lga.year.between(2023, 2026)][cols].copy()
# round
for c in d.columns:
    if d[c].dtype.kind == "f":
        d[c] = d[c].round(2)
d = d.sort_values(["state", "lga", "year", "month"])

# compact records with short keys (NaN -> null for valid JSON)
recs = d.astype(object).where(pd.notna(d), None).values.tolist()
json.dump({"columns": [VIEW[c] for c in cols], "rows": recs,
           "n": len(recs),
           "note": "Facility-level DHIS2 data aggregated to LGA-month. Population is an NPC-projection split to LGAs by facility share; incidence = confirmed cases ÷ population × 1,000."},
          open(f"{OUT}/dataset.json", "w"), allow_nan=False)

# data dictionary
dd = [
    {"field": "Confirmed cases", "agg": "SUM", "desc": "MAL - Malaria cases confirmed (number) — the target"},
    {"field": "Total reported", "agg": "SUM", "desc": "Confirmed + presumed malaria cases"},
    {"field": "RDT tested", "agg": "SUM", "desc": "Malaria cases tested with rapid diagnostic test"},
    {"field": "ACT given", "agg": "SUM", "desc": "Artemisinin-based combination therapy courses dispensed"},
    {"field": "LLINs given", "agg": "SUM", "desc": "Long-lasting insecticidal nets distributed"},
    {"field": "Fever RDT %", "agg": "MEAN", "desc": "Share of fever cases tested with RDT"},
    {"field": "Rainfall (mm/d)", "agg": "MEAN", "desc": "Monthly mean daily rainfall"},
    {"field": "Temp (°C)", "agg": "MEAN", "desc": "Mean temperature"},
    {"field": "Humidity %", "agg": "MEAN", "desc": "Relative humidity"},
    {"field": "Population", "agg": "derived", "desc": "NPC-projected state population split to LGA by facility share"},
    {"field": "Incidence/1k", "agg": "derived", "desc": "Confirmed cases ÷ population × 1,000 (monthly)"},
    {"field": "Facilities", "agg": "COUNT", "desc": "Number of reporting facilities aggregated"},
]
json.dump(dd, open(f"{OUT}/data_dictionary.json", "w"), indent=1, ensure_ascii=False)

print(f"agg_lga_pop.csv rows={len(lga):,}  dataset.json rows={len(recs):,} "
      f"({os.path.getsize(OUT+'/dataset.json')/1024/1024:.1f} MB)")
