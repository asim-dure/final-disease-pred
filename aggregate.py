"""
Chunked aggregation of the 1GB DHIS2 facility CSV into ward / LGA / state panels.

For every target level we accumulate, per group:
  - SUM columns  : running sum (skipna)
  - MEAN columns : running sum AND running non-null count -> mean = sum / count
  - n_facilities : distinct facility count (rolled-up FIRST dimension)

Outputs (parquet + csv):
  agg_ward.parquet, agg_lga.parquet, agg_state.parquet, agg_national.parquet
"""
import pandas as pd, numpy as np, json, time, sys
from agg_config import GROUP_KEYS, DROP_COLS, build_classification, TARGET

CSV = "final_malaria_data.csv"
CHUNK = 250_000

LEVELS = {
    "ward":     ["country", "state", "lga", "ward"],
    "lga":      ["country", "state", "lga"],
    "state":    ["country", "state"],
    "national": ["country"],
}

t0 = time.time()
hdr = pd.read_csv(CSV, nrows=0)
cols = list(hdr.columns)
cls = build_classification(cols)
sum_cols  = [c for c in cols if cls[c] == "sum"]
mean_cols = [c for c in cols if cls[c] == "mean"]
num_cols  = sum_cols + mean_cols
print(f"{len(sum_cols)} SUM cols, {len(mean_cols)} MEAN cols", flush=True)

# partial accumulators: level -> list of per-chunk aggregated frames
parts = {lv: [] for lv in LEVELS}

usecols = list(dict.fromkeys(GROUP_KEYS + num_cols))
reader = pd.read_csv(CSV, usecols=usecols, chunksize=CHUNK, low_memory=False)
nrows = 0
for i, ch in enumerate(reader):
    # clean keys / numerics
    for k in ["year", "month"]:
        ch[k] = pd.to_numeric(ch[k], errors="coerce")
    ch = ch.dropna(subset=["state", "lga", "year", "month"])
    ch["year"] = ch["year"].astype(int)
    ch["month"] = ch["month"].astype(int)
    # drop the junk state captured during profiling
    ch = ch[~ch["state"].str.startswith(" '", na=False)]
    for c in num_cols:
        ch[c] = pd.to_numeric(ch[c], errors="coerce")
    nrows += len(ch)

    for lv, geo in LEVELS.items():
        keys = geo + ["year", "month"]
        g = ch.groupby(keys, dropna=False)
        agg = {}
        for c in sum_cols:
            agg[c] = (c, "sum")
        for c in mean_cols:
            agg[c + "__s"] = (c, "sum")
            agg[c + "__n"] = (c, "count")
        out = g.agg(**agg)
        out["n_facilities"] = g["facility"].nunique()
        parts[lv].append(out.reset_index())
    if (i + 1) % 4 == 0:
        print(f"  chunk {i+1}  rows={nrows:,}  {time.time()-t0:.0f}s", flush=True)

print(f"read done: {nrows:,} rows in {time.time()-t0:.0f}s", flush=True)

# combine partials -> final aggregates
for lv, geo in LEVELS.items():
    keys = geo + ["year", "month"]
    big = pd.concat(parts[lv], ignore_index=True)
    sum_final  = {c: "sum" for c in sum_cols}
    mean_final = {}
    for c in mean_cols:
        mean_final[c + "__s"] = "sum"
        mean_final[c + "__n"] = "sum"
    agg_map = {**sum_final, **mean_final, "n_facilities": "sum"}
    res = big.groupby(keys, dropna=False).agg(agg_map).reset_index()
    # mean = sum / count
    for c in mean_cols:
        n = res[c + "__n"].replace(0, np.nan)
        res[c] = res[c + "__s"] / n
        res.drop(columns=[c + "__s", c + "__n"], inplace=True)
    res = res.sort_values(keys).reset_index(drop=True)
    res.to_parquet(f"agg_{lv}.parquet", index=False)
    res.to_csv(f"agg_{lv}.csv", index=False)
    tgt_total = res[TARGET].sum()
    print(f"[{lv}] rows={len(res):,} groups, target_total={tgt_total:,.0f} -> agg_{lv}.parquet", flush=True)

# save classification for transparency
with open("aggregation_map.json", "w", encoding="utf-8") as f:
    json.dump({"sum": sum_cols, "mean": mean_cols,
               "keys": GROUP_KEYS, "drop": DROP_COLS}, f, indent=1, ensure_ascii=False)
print(f"TOTAL {time.time()-t0:.0f}s", flush=True)
