"""
One-time precompute: distil the 993MB facility-grain DHIS2 malaria CSV
(final_malaria_data.csv) down to a compact per-facility monthly index that
api.py can load into memory and filter by (state, lga) on each map click.

This is the SAME source aggregate.py rolls up to LGA/state -- we simply stop
one level lower (at the facility) and keep only the handful of indicators the
facility drill-down needs, so the flagship malaria map can go one level more
granular than the LGA burden it already shows.

Output: facility_malaria.parquet
  columns: state, lga, ward, facility, year, month, cases, total, act, llin, rdt_tested, fever_testing_rate
  grain:   one row per (facility, year, month)

NOTE: "Fever Testing Rate" was added after the burden formula in facility_api.py
was refactored to use a testing-GAP factor (100% minus this rate) instead of the
old RDT-positivity approach -- see facility_api.py's module docstring for why.
It's aggregated by MEAN, not SUM, like the other four (it's a rate/percentage;
summing it across duplicate rows would inflate it same as any other rate field).
"""
import time
import pandas as pd

CSV = "final_malaria_data.csv"
OUT = "facility_malaria.parquet"
CHUNK = 300_000

# indicator source-name -> compact output name. Matched exactly against the
# CSV header; any that don't resolve are simply skipped (kept optional so a
# column rename upstream degrades gracefully instead of crashing the build).
WANT_SUM = {
    "MAL - Malaria cases confirmed (number)": "cases",
    "MAL - Total reported malaria cases (confirmed + presumed)": "total",
    "ACT Given - Total": "act",
    "LLIN given – Total": "llin",              # note: en-dash in source name
    "MAL - Malaria cases tested with RDT": "rdt_tested",
}
WANT_AVG = {
    "Fever Testing Rate": "fever_testing_rate",
}
KEYS = ["state", "lga", "ward", "facility", "year", "month"]


def main():
    t0 = time.time()
    hdr = list(pd.read_csv(CSV, nrows=0).columns)
    ind_sum = {src: dst for src, dst in WANT_SUM.items() if src in hdr}
    ind_avg = {src: dst for src, dst in WANT_AVG.items() if src in hdr}
    missing = [s for s in {**WANT_SUM, **WANT_AVG} if s not in hdr]
    if missing:
        print(f"[warn] {len(missing)} indicator(s) not in header, skipping: {missing}")
    ind = {**ind_sum, **ind_avg}
    usecols = KEYS + list(ind)
    # A given (facility, year, month) key can have its rows split across
    # DIFFERENT chunks (the CSV isn't sorted by facility), so an avg-type
    # indicator can't just take "mean" per chunk then "mean of those means"
    # at combine time -- that silently mis-weights chunks with fewer
    # contributing rows the same as chunks with more. Instead track a
    # sum/count pair per chunk (both correctly SUM across chunks) and only
    # divide once, at the very end, on the fully-combined totals.
    avg_sum_cols = {dst: f"{dst}__sum" for dst in ind_avg.values()}
    avg_cnt_cols = {dst: f"{dst}__cnt" for dst in ind_avg.values()}
    # min_count=1 on the TRUE sum indicators preserves "never reported"
    # (all-NaN group -> NaN) instead of silently turning it into a false 0 --
    # composes correctly across the two levels of summing below since
    # sum(min_count=1) already ignores NaN (skipna=True) when a real value
    # exists anywhere among the values being combined.
    def _sum_min1(s):
        return s.sum(min_count=1)
    chunk_agg_fn = {dst: _sum_min1 for dst in ind_sum.values()}
    chunk_agg_fn.update({dst: "sum" for dst in avg_sum_cols.values()})
    chunk_agg_fn.update({dst: "sum" for dst in avg_cnt_cols.values()})
    chunk_agg_cols = list(chunk_agg_fn.keys())
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
        for src, dst in ind_sum.items():
            ch[dst] = pd.to_numeric(ch[src], errors="coerce")
        for src, dst in ind_avg.items():
            v = pd.to_numeric(ch[src], errors="coerce")
            ch[avg_sum_cols[dst]] = v.fillna(0.0)
            ch[avg_cnt_cols[dst]] = v.notna().astype(float)
        g = ch.groupby(KEYS, dropna=False)[chunk_agg_cols].agg(chunk_agg_fn)
        parts.append(g)
        nrows += len(ch)
        if (i + 1) % 10 == 0:
            print(f"  chunk {i+1}  rows={nrows:,}  {time.time()-t0:.0f}s", flush=True)

    print(f"read done: {nrows:,} rows in {time.time()-t0:.0f}s -- combining", flush=True)
    big = pd.concat(parts)
    res = big.groupby(level=list(range(len(KEYS)))).agg(chunk_agg_fn).reset_index()
    for dst in ind_avg.values():
        cnt = res[avg_cnt_cols[dst]]
        res[dst] = (res[avg_sum_cols[dst]] / cnt).where(cnt > 0)
        res = res.drop(columns=[avg_sum_cols[dst], avg_cnt_cols[dst]])
    res = res.sort_values(KEYS).reset_index(drop=True)
    res.to_parquet(OUT, index=False)
    print(f"[done] {len(res):,} facility-month rows -> {OUT}  "
          f"({res['facility'].nunique():,} facilities, {res['lga'].nunique():,} LGAs)  {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
