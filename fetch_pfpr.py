"""
Fetch REAL malaria prevalence (PfPR 2-10) per LGA from the Malaria Atlas Project
modelled raster, via WMS GetFeatureInfo at each LGA centroid (no raster library
needed). Layer 202406 = 2024 annual Pf parasite rate. Saved to pfpr_lga.csv.
"""
import pandas as pd, numpy as np, json, time, urllib.request, urllib.parse

LAYER = "Malaria:202406_Global_Pf_Parasite_Rate"
BASE = ("https://data.malariaatlas.org/geoserver/Malaria/wms?service=WMS&version=1.3.0"
        "&request=GetFeatureInfo&layers={L}&query_layers={L}&crs=EPSG:4326"
        "&bbox={bbox}&width=3&height=3&i=1&j=1&info_format=application/json")

g = pd.read_csv("geo_lga.csv")
g = g.dropna(subset=["center_lat", "center_lon"]).reset_index(drop=True)
vals = [None] * len(g)
d = 0.04
for k, r in enumerate(g.itertuples()):
    lat, lon = float(r.center_lat), float(r.center_lon)
    bbox = f"{lat-d},{lon-d},{lat+d},{lon+d}"          # 1.3.0 EPSG:4326 -> lat,lon order
    url = BASE.format(L=urllib.parse.quote(LAYER), bbox=bbox)
    for attempt in range(3):
        try:
            res = json.loads(urllib.request.urlopen(url, timeout=30).read())
            props = res["features"][0]["properties"] if res.get("features") else {}
            v = next((x for x in props.values() if isinstance(x, (int, float))), None)  # band name varies (GRAY_INDEX/jiffle)
            vals[k] = None if v is None else float(v)
            break
        except Exception:
            time.sleep(1.5)
    if k < 5 or k % 150 == 0:
        print(f"  {k+1}/{len(g)} {r.adm1_name if hasattr(r,'adm1_name') else ''} {r.lga_ocha}: PfPR={vals[k]}", flush=True)
    time.sleep(0.35)

g["pfpr"] = vals
g["pfpr"] = pd.to_numeric(g["pfpr"], errors="coerce")
# MAP PfPR rasters are 0-1 proportions; convert to %
if g["pfpr"].max() is not np.nan and g["pfpr"].max() <= 1.5:
    g["pfpr"] = g["pfpr"] * 100.0
g[["state_ocha", "lga_ocha", "adm2_pcode", "pfpr"]].to_csv("pfpr_lga.csv", index=False)
ok = g["pfpr"].notna().sum()
print(f"\npfpr_lga.csv saved · present {ok}/{len(g)} · range {g.pfpr.min():.1f}-{g.pfpr.max():.1f}% mean {g.pfpr.mean():.1f}%")
