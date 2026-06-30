"""
Fetch REAL external climate indices and align them to the project's monthly grid:
  - ENSO  : NOAA CPC Oceanic Niño Index (ONI)  — Niño 3.4 SST anomaly
  - IOD   : NOAA PSL Dipole Mode Index (DMI, HadISST)

Both are genuine national/global monthly series (same value across all LGAs in a
given month). Saved to external_indices.json as {ym: {enso_oni, iod_dmi}} for the
2023-01..2026-12 window (future months left null -> neutral in features).
"""
import json, urllib.request, numpy as np

ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
DMI_URL = "https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data"
SEAS_CENTER = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6,
               "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12}


def _get(url):
    return urllib.request.urlopen(url, timeout=30).read().decode("utf-8", "ignore")


def parse_oni(txt):
    out = {}
    for ln in txt.splitlines()[1:]:
        p = ln.split()
        if len(p) < 4 or p[0] not in SEAS_CENTER:
            continue
        yr = int(p[1]); anom = float(p[3]); m = SEAS_CENTER[p[0]]
        out[yr * 12 + (m - 1)] = anom
    return out


def parse_dmi(txt):
    lines = txt.splitlines()
    out = {}
    hdr = lines[0].split()
    y0, y1 = int(hdr[0]), int(hdr[1])
    miss = None
    for ln in lines[1:]:
        p = ln.split()
        if len(p) == 1:           # the missing-value sentinel line at the bottom
            try: miss = float(p[0])
            except Exception: pass
            continue
        if len(p) < 13:
            continue
        try:
            yr = int(p[0])
        except Exception:
            continue
        if yr < y0 or yr > y1:
            continue
        for m in range(12):
            v = float(p[1 + m])
            out[yr * 12 + m] = v
    if miss is not None:
        out = {k: (np.nan if abs(v - miss) < 1e-3 else v) for k, v in out.items()}
    return out


oni = parse_oni(_get(ONI_URL))
dmi = parse_dmi(_get(DMI_URL))

rows = []
for ym in range(2023 * 12, 2027 * 12):           # 2023-01 .. 2026-12
    e = oni.get(ym); i = dmi.get(ym)
    rows.append({"ym": ym,
                 "enso_oni": None if (e is None or np.isnan(e)) else round(e, 3),
                 "iod_dmi": None if (i is None or (isinstance(i, float) and np.isnan(i))) else round(i, 3)})

json.dump(rows, open("external_indices.json", "w"), indent=1)
have_e = sum(1 for r in rows if r["enso_oni"] is not None)
have_i = sum(1 for r in rows if r["iod_dmi"] is not None)
print(f"external_indices.json: {len(rows)} months · ENSO present {have_e} · IOD present {have_i}")
print("sample 2023-2024:", [(r["ym"] // 12, r["ym"] % 12 + 1, r["enso_oni"], r["iod_dmi"]) for r in rows[:6]])
print("latest:", [(r["ym"] // 12, r["ym"] % 12 + 1, r["enso_oni"], r["iod_dmi"]) for r in rows[-8:] if r["enso_oni"] is not None][-4:])
