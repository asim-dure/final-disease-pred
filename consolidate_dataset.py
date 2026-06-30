"""
Consolidate ALL real external data into the final modelling dataset (agg_lga_pop.parquet)
and write a manifest. Adds the newly-fetched geospatial covariates:
  - elevation (m, SRTM via OpenTopoData)   - latitude (centroid)
  - area_sqkm (OCHA)                        - pop_density (population / area)
(ndvi, ndvi_anom, enso_oni, iod_dmi were merged earlier by integrate_external.py.)
DOES NOT touch features.py or train anything — just builds the dataset for review.
"""
import re, json, pandas as pd, numpy as np

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())

agg = pd.read_parquet("agg_lga_pop.parquet")
geo = pd.read_csv("geo_lga.csv")
geo["klga"] = geo.state_ocha.map(norm) + "|" + geo.lga_ocha.map(norm)
geo["kstate"] = geo.state_ocha.map(norm)

mine = agg[["state", "lga"]].drop_duplicates().copy()
mine["klga"] = mine.state.map(norm) + "|" + mine.lga.map(norm)
mine["kstate"] = mine.state.map(norm)

# direct LGA match, else state-mean fallback for elevation/area/lat
m = mine.merge(geo[["klga", "elevation", "area_sqkm", "center_lat"]], on="klga", how="left")
smean = geo.groupby("kstate")[["elevation", "area_sqkm", "center_lat"]].mean()
for c in ["elevation", "area_sqkm", "center_lat"]:
    m[c] = m[c].fillna(m["kstate"].map(smean[c]))
m = m.rename(columns={"center_lat": "latitude"})[["state", "lga", "elevation", "area_sqkm", "latitude"]]
matched = mine.merge(geo[["klga"]], on="klga", how="inner").shape[0]
print(f"elevation/area matched {matched}/{len(mine)} LGAs by name; rest via state-mean")

for c in ["elevation", "area_sqkm", "latitude", "pop_density"]:
    if c in agg.columns:
        agg.drop(columns=c, inplace=True)
agg = agg.merge(m, on=["state", "lga"], how="left")
agg["pop_density"] = agg["population"] / agg["area_sqkm"].replace(0, np.nan)

agg.to_parquet("agg_lga_pop.parquet", index=False)

EXTERNAL_MANIFEST = [
    ("ndvi", "FEWS NET satellite NDVI (per LGA, monthly)", "LGA-month", "fetched (your CSV + OCHA crosswalk)"),
    ("ndvi_anom", "NDVI anomaly vs LGA seasonal normal", "LGA-month", "fetched"),
    ("enso_oni", "NOAA Niño-3.4 ONI (ENSO)", "national-month", "fetched (NOAA CPC)"),
    ("iod_dmi", "NOAA Indian Ocean Dipole Mode Index", "national-month", "fetched (NOAA PSL)"),
    ("elevation", "SRTM 30m elevation at LGA centroid", "LGA-static", "fetched (OpenTopoData)"),
    ("area_sqkm", "LGA area", "LGA-static", "fetched (OCHA admin-2)"),
    ("latitude", "LGA centroid latitude (N–S gradient)", "LGA-static", "fetched (OCHA admin-2)"),
    ("pop_density", "Population per km² (population / area)", "LGA-year", "derived (population ÷ area)"),
]
man = pd.DataFrame(EXTERNAL_MANIFEST, columns=["column", "description", "resolution", "provenance"])
man["nonnull_pct_2023plus"] = [round(agg[agg.year >= 2023][c].notna().mean() * 100) if c in agg.columns else 0
                               for c in man["column"]]
man.to_csv("external_manifest.csv", index=False)
print(man.to_string(index=False))
print("\nElevation by region sanity check:")
chk = agg[(agg.year == 2025) & (agg.month == 1)].groupby("state")["elevation"].mean().sort_values()
print("  lowest:", chk.head(3).round(0).to_dict())
print("  highest:", chk.tail(3).round(0).to_dict())
