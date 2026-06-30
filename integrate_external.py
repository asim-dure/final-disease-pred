"""
Integrate REAL external data into the project dataset (agg_lga_pop.parquet):
  - NDVI  : FEWS NET / VAM dekadal vegetation index per LGA (nga-ndvi-subnat-full.csv),
            matched to our state/LGA names via the OCHA admin-2 PCODE crosswalk and
            aggregated dekadal -> monthly. Adds  ndvi  and  ndvi_anom  (% vs climatology).
  - ENSO  : NOAA Niño-3.4 ONI   (external_indices.json)  -> enso_oni  (national, by month)
  - IOD   : NOAA Dipole Mode Idx (external_indices.json)  -> iod_dmi   (national, by month)

NDVI is genuine LGA-level satellite data; ~96% of LGAs matched by name, the rest use
their state's mean NDVI. Columns are written back into agg_lga_pop.parquet so they flow
through the existing climatology / conditional-forecast machinery.
"""
import json, re, pandas as pd, numpy as np

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())

# ---- crosswalk: PCODE -> (state, lga) names ----
xw = pd.read_excel("nga_admin_boundaries.xlsx", "nga_admin2")[["adm2_pcode", "adm2_name", "adm1_name"]]
xw["adm2_pcode"] = xw["adm2_pcode"].astype(str)

# ---- NDVI: dekadal -> monthly per PCODE ----
nd = pd.read_csv("nga-ndvi-subnat-full.csv", usecols=["date", "adm_level", "PCODE", "vim", "viq"])
nd = nd[(nd.adm_level == 2)].copy()
nd["date"] = pd.to_datetime(nd["date"])
nd = nd[nd.date >= "2023-01-01"]
nd["ym"] = nd.date.dt.year * 12 + (nd.date.dt.month - 1)
ndm = nd.groupby(["PCODE", "ym"], as_index=False).agg(ndvi=("vim", "mean"), ndvi_anom=("viq", "mean"))
ndm["ndvi_anom"] = ndm["ndvi_anom"] - 100.0          # % deviation from climatology
ndm = ndm.merge(xw, left_on="PCODE", right_on="adm2_pcode", how="left")
ndm["kstate"] = ndm["adm1_name"].map(norm)
ndm["klga"] = ndm["adm1_name"].map(norm) + "|" + ndm["adm2_name"].map(norm)

# ---- our dataset keys ----
agg = pd.read_parquet("agg_lga_pop.parquet")
agg["ym"] = agg.year * 12 + agg.month - 1
mine = agg[["state", "lga"]].drop_duplicates().copy()
mine["kstate"] = mine.state.map(norm)
mine["klga"] = mine.state.map(norm) + "|" + mine.lga.map(norm)

# 1) direct LGA-name match
lga_match = ndm.merge(mine, on="klga", how="inner")[["state", "lga", "ym", "ndvi", "ndvi_anom"]]
matched_keys = set(zip(lga_match.state, lga_match.lga))
# 2) state-mean NDVI fallback for unmatched LGAs
state_ndvi = ndm.groupby(["kstate", "ym"], as_index=False).agg(ndvi=("ndvi", "mean"), ndvi_anom=("ndvi_anom", "mean"))
fill_rows = []
for _, r in mine.iterrows():
    if (r.state, r.lga) in matched_keys:
        continue
    sm = state_ndvi[state_ndvi.kstate == r.kstate]
    for _, s in sm.iterrows():
        fill_rows.append({"state": r.state, "lga": r.lga, "ym": int(s.ym), "ndvi": s.ndvi, "ndvi_anom": s.ndvi_anom})
ndvi_all = pd.concat([lga_match, pd.DataFrame(fill_rows)], ignore_index=True)
print(f"NDVI: {len(matched_keys)} LGAs name-matched, {mine.shape[0]-len(matched_keys)} via state-mean; "
      f"{ndvi_all.ym.nunique()} months {ndvi_all.ym.min()}..{ndvi_all.ym.max()}")

# ---- ENSO / IOD by ym (national) ----
ext = json.load(open("external_indices.json"))
ext_df = pd.DataFrame(ext)[["ym", "enso_oni", "iod_dmi"]]

# ---- merge into agg_lga_pop (drop any prior copies first) ----
for c in ["ndvi", "ndvi_anom", "enso_oni", "iod_dmi"]:
    if c in agg.columns:
        agg.drop(columns=c, inplace=True)
agg = agg.merge(ndvi_all, on=["state", "lga", "ym"], how="left")
agg = agg.merge(ext_df, on="ym", how="left")
agg.drop(columns="ym", inplace=True)
agg.to_parquet("agg_lga_pop.parquet", index=False)

cov = lambda c: f"{agg[c].notna().mean()*100:.0f}%"
print(f"Wrote agg_lga_pop.parquet (+ndvi {cov('ndvi')}, ndvi_anom {cov('ndvi_anom')}, "
      f"enso_oni {cov('enso_oni')}, iod_dmi {cov('iod_dmi')} non-null over all rows)")
samp = agg[(agg.year == 2024) & (agg.month == 8)][["state", "lga", "ndvi", "ndvi_anom", "enso_oni", "iod_dmi"]].head(4)
print(samp.to_string(index=False))
