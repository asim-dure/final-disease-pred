"""
One-time precompute: distil the 993MB facility-grain DHIS2 malaria CSV
(final_malaria_data.csv) down to a compact per-facility monthly index that
api.py can load into memory and filter by (state, lga) on each map click.

This is the SAME source aggregate.py rolls up to LGA/state -- we simply stop
one level lower (at the facility) and keep only the handful of indicators the
facility drill-down needs, so the flagship malaria map can go one level more
granular than the LGA burden it already shows.

Output: facility_malaria.parquet
  columns: state, lga, ward, facility, year, month, cases, total, act, llin, rdt_tested
  grain:   one row per (facility, year, month)
"""
import time
import pandas as pd

CSV = "final_malaria_data.csv"
OUT = "facility_malaria.parquet"
CHUNK = 300_000

# indicator source-name -> compact output name. Matched exactly against the
# CSV header; any that don't resolve are simply skipped (kept optional so a
# column rename upstream degrades gracefully instead of crashing the build).
WANT = {
    "MAL - Malaria cases confirmed (number)": "cases",
    "MAL - Total reported malaria cases (confirmed + presumed)": "total",
    "ACT Given - Total": "act",
    "LLIN given – Total": "llin",              # note: en-dash in source name
    "MAL - Malaria cases tested with RDT": "rdt_tested",
}
KEYS = ["state", "lga", "ward", "facility", "year", "month"]


def main():
    t0 = time.time()
    hdr = list(pd.read_csv(CSV, nrows=0).columns)
    ind = {src: dst for src, dst in WANT.items() if src in hdr}
    missing = [s for s in WANT if s not in hdr]
    if missing:
        print(f"[warn] {len(missing)} indicator(s) not in header, skipping: {missing}")
    usecols = KEYS + list(ind)
    print(f"reading {CSV} with {len(usecols)} cols, {len(ind)} indicators", flush=True)

    parts = []
    reader = pd.read_csv(CSV, usecols=usecols, chunksize=CHUNK, low_memory=False)
    nrows = 0
    for i, ch in enumerate(reader):
        for k in ("year", "month"):
            ch[k] = pd.to_numeric(ch[k], errors="coerce")
        ch = ch.dropna(subset=["state", "lga", "facility", "year", "month"])
        ch = ch[~ch["state"].astype(str).str.startswith(" '")]     # drop the profiling-junk state
        ch["year"] = ch["year"].astype(int)
        ch["month"] = ch["month"].astype(int)
        for src, dst in ind.items():
            ch[dst] = pd.to_numeric(ch[src], errors="coerce")
        g = ch.groupby(KEYS, dropna=False)[list(ind.values())].sum(min_count=1)
        parts.append(g)
        nrows += len(ch)
        if (i + 1) % 10 == 0:
            print(f"  chunk {i+1}  rows={nrows:,}  {time.time()-t0:.0f}s", flush=True)

    print(f"read done: {nrows:,} rows in {time.time()-t0:.0f}s -- combining", flush=True)
    big = pd.concat(parts)
    res = big.groupby(level=list(range(len(KEYS)))).sum(min_count=1).reset_index()
    res = res.sort_values(KEYS).reset_index(drop=True)
    res.to_parquet(OUT, index=False)
    print(f"[done] {len(res):,} facility-month rows -> {OUT}  "
          f"({res['facility'].nunique():,} facilities, {res['lga'].nunique():,} LGAs)  {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
