"""
Integrate the second wave of REAL external data into agg_lga_pop.parquet:
  - pfpr          : Malaria Atlas Project PfPR 2-10 (modelled prevalence) per LGA centroid
  - poverty_mpi_h : OPHI/NBS MPI 2019 multidimensional-poverty headcount (state, broadcast)
  - dep_schooling / dep_electricity / dep_water / dep_housing :
                    MPI deprivation rates (state-level living-standard indicators)
Plus refresh the manifest. No training here.
"""
import re, pandas as pd, numpy as np

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())

agg = pd.read_parquet("agg_lga_pop.parquet")
mine = agg[["state", "lga"]].drop_duplicates().copy()
mine["klga"] = mine.state.map(norm) + "|" + mine.lga.map(norm)
mine["kstate"] = mine.state.map(norm)

# ---- PfPR (LGA) ----
pf = pd.read_csv("pfpr_lga.csv")
pf["klga"] = pf.state_ocha.map(norm) + "|" + pf.lga_ocha.map(norm)
pf["kstate"] = pf.state_ocha.map(norm)
m = mine.merge(pf[["klga", "pfpr"]], on="klga", how="left")
smean = pf.groupby("kstate")["pfpr"].mean()
m["pfpr"] = m["pfpr"].fillna(m["kstate"].map(smean))
pfpr_matched = mine.merge(pf[["klga"]], on="klga", how="inner").shape[0]

# ---- MPI socioeconomic (state -> broadcast) ----
mpi1 = pd.read_excel("nga_mpi_2019.xlsx", "5.1 MPI Region", header=None)
mpi1 = mpi1[mpi1[1] == "NGA"][[6, 9]].rename(columns={6: "region", 9: "poverty_mpi_h"})
mpi2 = pd.read_excel("nga_mpi_2019.xlsx", "5.2 Censored Headcounts Region", header=None)
mpi2 = mpi2[mpi2[1] == "NGA"][[6, 11, 16, 15, 17]].rename(
    columns={6: "region", 11: "dep_schooling", 16: "dep_electricity", 15: "dep_water", 17: "dep_housing"})
soc = mpi1.merge(mpi2, on="region", how="outer")
soc["kstate"] = soc.region.map(norm)
soc_cols = ["poverty_mpi_h", "dep_schooling", "dep_electricity", "dep_water", "dep_housing"]
for c in soc_cols:
    soc[c] = pd.to_numeric(soc[c], errors="coerce")
STATE_ALIAS = {"federalcapitalterritory": "fct"}    # my name -> MPI region name
m["kstate_soc"] = m["kstate"].replace(STATE_ALIAS)
m = m.merge(soc[["kstate"] + soc_cols].rename(columns={"kstate": "kstate_soc"}), on="kstate_soc", how="left")
m.drop(columns="kstate_soc", inplace=True)
soc_matched = len(set(mine.kstate.replace(STATE_ALIAS)) & set(soc.kstate))

addcols = ["pfpr"] + soc_cols
new = m[["state", "lga"] + addcols]
for c in addcols:
    if c in agg.columns:
        agg.drop(columns=c, inplace=True)
agg = agg.merge(new, on=["state", "lga"], how="left")
agg.to_parquet("agg_lga_pop.parquet", index=False)

print(f"PfPR matched {pfpr_matched}/{len(mine)} LGAs by name; socioeconomic {soc_matched}/37 states")
print("PfPR %: ", round(agg.pfpr.min(), 1), "-", round(agg.pfpr.max(), 1), "mean", round(agg.pfpr.mean(), 1))
for c in soc_cols:
    print(f"  {c}: {agg[c].min():.1f} - {agg[c].max():.1f}%  (state-level, broadcast to LGA)")

# refresh manifest
man = pd.read_csv("external_manifest.csv")
new_rows = pd.DataFrame([
    ("pfpr", "Malaria Atlas Project PfPR 2-10 (modelled prevalence)", "LGA-static", "fetched (MAP WMS, 2024)"),
    ("poverty_mpi_h", "MPI multidimensional poverty headcount", "state→LGA", "fetched (OPHI/NBS MPI 2019)"),
    ("dep_schooling", "Deprivation: years of schooling (education)", "state→LGA", "fetched (OPHI MPI)"),
    ("dep_electricity", "Deprivation: electricity access", "state→LGA", "fetched (OPHI MPI)"),
    ("dep_water", "Deprivation: drinking water", "state→LGA", "fetched (OPHI MPI)"),
    ("dep_housing", "Deprivation: housing quality", "state→LGA", "fetched (OPHI MPI)"),
], columns=["column", "description", "resolution", "provenance"])
new_rows["nonnull_pct_2023plus"] = [round(agg[agg.year >= 2023][c].notna().mean() * 100) for c in new_rows.column]
man = pd.concat([man, new_rows], ignore_index=True)
man.to_csv("external_manifest.csv", index=False)
print("\nmanifest now has", len(man), "external columns")
