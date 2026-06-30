"""
Fetch REAL geospatial covariates per LGA using the OCHA admin-2 centroids:
  - elevation (m)  : OpenTopoData SRTM 30m, queried at each LGA centroid
  - center_lat/lon : geographic position (north-south transmission gradient)
  - area_sqkm      : from the OCHA crosswalk (for population density downstream)
Saved to geo_lga.csv (one row per LGA). No auth required.
"""
import pandas as pd, numpy as np, json, time, urllib.request, urllib.parse

x = pd.read_excel("nga_admin_boundaries.xlsx", "nga_admin2")
g = x[["adm1_name", "adm2_name", "adm2_pcode", "area_sqkm", "center_lat", "center_lon"]].copy()
g = g.dropna(subset=["center_lat", "center_lon"]).reset_index(drop=True)
print(f"{len(g)} LGA centroids")

elev = [None] * len(g)
B = 100
for i in range(0, len(g), B):
    chunk = g.iloc[i:i + B]
    locs = "|".join(f"{r.center_lat:.5f},{r.center_lon:.5f}" for r in chunk.itertuples())
    url = "https://api.opentopodata.org/v1/srtm30m?locations=" + urllib.parse.quote(locs, safe="|,")
    for attempt in range(4):
        try:
            res = json.loads(urllib.request.urlopen(url, timeout=40).read())
            for j, rr in enumerate(res["results"]):
                elev[i + j] = rr.get("elevation")
            print(f"  batch {i//B+1}/{(len(g)+B-1)//B} ok", flush=True)
            break
        except Exception as e:
            print(f"  batch {i//B+1} retry {attempt} ({e})", flush=True); time.sleep(3)
    time.sleep(1.2)   # polite: <=1 req/s

g["elevation"] = elev
g["elevation"] = g["elevation"].astype(float)
g.rename(columns={"adm1_name": "state_ocha", "adm2_name": "lga_ocha"}, inplace=True)
g.to_csv("geo_lga.csv", index=False)
print("geo_lga.csv saved · elevation present:", g["elevation"].notna().sum(), "/", len(g))
print("elev range:", round(g.elevation.min(), 0), "-", round(g.elevation.max(), 0), "m  mean", round(g.elevation.mean(), 0))
