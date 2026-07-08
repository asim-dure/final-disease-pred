"""
Export MONTHLY per-LGA and per-state indicator inputs for the 5-zone hotspot
burden score. Stored as per-field arrays aligned to a shared month index so the
frontend can scrub through time and watch hotspots rise in the rainy season.

Window (auto-detected from the data's own extent, NOT hardcoded -- the window
used to be a fixed 2024-01..2025-12 actual / 2026 forecast, which went stale
the moment more real months arrived and started forecasting from a
three-month-old cutoff instead of the true most recent data):
  • Actual  : trailing ~24 months ending at the last month with real reported
              confirmed-case data (auto-detected, same rule as modeling.py)
  • Forecast: the 12 months immediately after that

Forecast method for the "cases"/"total" fields specifically -- the ones that
actually drive the burden score and the case-trend graph -- is NOT naive
calendar-month climatology. It's pulled directly from forecast_lga.parquet,
which modeling.py already produces via a proper CONDITIONAL forecast (XGBoost
with lag/rolling/seasonal-harmonic features, log-population, and weather
covariates including a 1-month lag), so the map and the case-trend chart both
reflect the same real, momentum-aware forecast rather than "the historical
average for this calendar month" reverting toward a seasonal mean regardless
of recent trend.

The auxiliary lever fields (rain, temp, humidity, ACT, LLIN, RDT, IPTp, etc.)
stay climatology-projected -- these are intentionally the user-ADJUSTABLE
starting points for the What-If levers, so "typical seasonal value" is the
right baseline for them to move away from, unlike the cases series itself.

The burden math + percentile blend + zones are computed client-side so they react
live to the What-If levers. Output: ui/public/data/<before|after>/burden.json
"""
import re, json, os
import numpy as np
import pandas as pd

MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
df = pd.read_parquet("agg_lga_pop.parquet")

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())
COLS = {norm(c): c for c in df.columns}
def col(name):
    c = COLS.get(norm(name))
    return df[c] if c is not None else pd.Series(0.0, index=df.index)

FIELD = {
    "cases":   "MAL - Malaria cases confirmed (number)",
    "total":   "MAL - Total reported malaria cases (confirmed + presumed)",
    "rdt_done":"MAL - Malaria cases tested with RDT",
    # "Number of malaria positive cases by rapid diagnostic test (RDT)" is
    # entirely zero across the whole dataset (never collected) -- it fed a
    # FIXED 0.55 into the burden formula for every single area, one of three
    # near-constant factors that compressed the score (see "Fever Testing
    # Rate" below and "ipt_cov" note). Replaced with the same clean, real
    # testing-coverage indicator already used for facility-level burden.
    "fever_testing": "Fever Testing Rate",
    "act":     "ACT Given - Total",
    "treated": "Anti-Malarial treatment",
    "itn":     "Access to an ITN",
    "llin":    "LLIN given – Total",
    # "IPTp1 Coverage (institutional)" is separately corrupted (median 0,
    # ~46% of rows exceed 100%, values up to 1e8) -- swapped for the same
    # clean proxy the Mechanistic panel already uses (median 84%, ~9.5%
    # outliers, real ANC-attendee IPTp uptake).
    "ipt_cov": "% of all Antenatal care clients receiving malaria IPT",
    "rain":    "rainfall_mm_day",
    "temp":    "temperature_mean_c",
    "hum":     "humidity_pct",
    # Context fields (population + density) -- NOT used in the burden score
    # itself, but shown as the lever panel's baseline context per manager
    # request; already computed and available at LGA grain.
    "population":  "population",
    "pop_density": "pop_density",
    # Dose-level IPTp counts. These columns are LABELLED "Coverage" in the
    # warehouse but are actually raw MONTHLY DOSE COUNTS, not percentages --
    # confirmed by (a) a monotonically decreasing scale IPTp1 > IPTp2 > IPTp3
    # > IPTp4 that exactly matches the real-world dose-completion dropoff, and
    # (b) medians in the hundreds/low-thousands, which is a plausible monthly
    # dose count for an LGA but nonsensical as a percentage. Earlier analysis
    # that flagged "IPTp1 Coverage (institutional)" as corrupted was reading
    # it as a percentage (46% of rows >100%) -- as a COUNT it isn't corrupted,
    # it just needs a name that says what it is. The single genuinely clean
    # PERCENTAGE field ("% of all Antenatal care clients receiving malaria
    # IPT", already used as ipt_cov above) remains the coverage-rate metric;
    # these four are the real dose-by-dose breakdown the cascade view needs.
    "iptp1_n": "IPTp1 Coverage (institutional)",
    "iptp2_n": "IPTp2 Coverage (institutional)",
    "iptp3_n": "IPTp3 Coverage (institutional)",
    "iptp4_n": "IPTp>=4 Coverage (institutional)",
    # Real facility count per LGA (constant per area, not a monthly-varying
    # metric, but exported through the same per-month pipeline so it needs no
    # separate endpoint) -- used by the dashboard's region-treemap panel to
    # show "N facilities" for whatever state/LGA is currently selected.
    "n_facilities": "n_facilities",
    # A genuinely available, real severe-malaria case-management indicator
    # (37.5% nonzero across the panel) -- distinct from routine ACT courses,
    # this is inpatient/severe-case treatment. IRS spray-coverage and SMC
    # (seasonal chemoprevention) were checked against the raw warehouse
    # columns and are NOT collected anywhere in this dataset (confirmed via
    # direct column inspection) -- shown as a data gap, not fabricated.
    "severe_treated": "Persons with Severe Malaria treated with Artesunate injection",
}
FIELDS = list(FIELD)                      # order matters (arrays align to this)
COUNT  = ["cases","total","rdt_done","act","treated","itn","llin","population",
          "iptp1_n","iptp2_n","iptp3_n","iptp4_n","n_facilities","severe_treated"]
RATE   = ["ipt_cov","rain","temp","hum","fever_testing","pop_density"]
IPTP_DOSE_FIELDS = ["iptp1_n", "iptp2_n", "iptp3_n", "iptp4_n"]

# rain/temp/hum/ipt_cov/fever_testing only have real readings for a subset of
# years -- filling the gap with 0 would make "not yet collected" look like a
# genuine "0% coverage"/"0mm of rain" reading, dragging down every calendar
# month's climatology once averaged in below (this is exactly what was
# happening: ipt_cov's real history runs ~77-83%, but three years of
# fabricated zeros from before the indicator existed pulled every FORECAST
# month's climatology down to ~34%; fever_testing -- which only starts in
# 2024 -- collapsed even harder, from a real ~71% to ~10%). Leave these as
# NaN so groupby().mean() skips the not-yet-collected years entirely instead
# of averaging them in as zeros -- same approach drivers.py uses for rain/
# temp/hum, now extended to the two rate indicators with the same gap.
ENV_FIELDS = {"rain", "temp", "hum", "ipt_cov", "fever_testing"}

# See the "population" branch below: this dataset's own raw population figures
# undercount Nigeria's real population -- rescale uniformly against the
# official NBS/UN mid-year 2026 estimate, anchored to the most recent
# (year, month) this raw data actually has population for.
NIGERIA_2026_POPULATION = 242_431_832
_pop_raw_col = pd.to_numeric(col("population"), errors="coerce")
_latest_ym_raw = int((df["year"] * 12 + df["month"]).max())
_latest_mask_raw = (df["year"] * 12 + df["month"]) == _latest_ym_raw
_raw_latest_pop_total = float(_pop_raw_col[_latest_mask_raw].sum())
POP_SCALE = (NIGERIA_2026_POPULATION / _raw_latest_pop_total) if _raw_latest_pop_total > 0 else 1.0

w = df[["state","lga","year","month"]].copy()
for f, c in FIELD.items():
    raw = pd.to_numeric(col(c), errors="coerce")
    if f == "ipt_cov":
        # clip the remaining ~9.5% outlier tail on the (much cleaner) proxy indicator
        raw = raw.clip(lower=0, upper=100)
    if f == "total":
        # "Total reported (confirmed+presumed)" must be >= confirmed cases by
        # definition, and the real total/confirmed ratio is tightly clustered
        # (median 1.49x, 99.9th percentile ~15.4x) -- but a handful of rows are
        # genuine data-entry errors, the worst being one LGA-month recorded at
        # 1,124,546 (134x its own 8,398 confirmed cases -- more than a full
        # order of magnitude past the 99.9th percentile). That single row alone
        # was enough to push its LGA's Treatment Gap burden factor to ~99% and
        # misclassify it Red regardless of its real burden. Capped at 20x
        # confirmed cases -- generous headroom above the legitimate 99.9th
        # percentile, but well below the true entry errors -- computed
        # row-wise since "cases" is already resolved earlier in FIELD's order.
        ratio_cap = 20.0
        bound = w["cases"] * ratio_cap
        raw = raw.where(raw.isna() | (raw <= bound), bound)
    if f in IPTP_DOSE_FIELDS:
        # As raw monthly dose counts these are mostly clean (see FIELD comment
        # above), but the true tail is still a genuine data-entry error (e.g. a
        # single IPTp1 row at 101 MILLION for one LGA-month). Clip each dose's
        # own 99.5th percentile of its nonzero values -- a guard against real
        # entry errors without flattening legitimate high-volume LGAs.
        nz = raw[raw > 0]
        cap = float(nz.quantile(0.995)) if len(nz) else None
        if cap:
            raw = raw.clip(lower=0, upper=cap)
    if f in ("population", "pop_density"):
        # This dataset's own raw population (census-projection based) undercounts
        # Nigeria's real 2026 population -- its own Mar 2026 national total sums
        # to ~234.14M, against the official NBS/UN mid-year 2026 estimate of
        # 242,431,832. Rescale uniformly (preserves each LGA's relative share and
        # the data's own year-over-year growth curve, just re-anchors the
        # absolute level to the real published figure) so the population lever's
        # baseline -- and every other population-driven reading (mechanistic
        # model, Location Context panel) -- reflects reality, not an undercount.
        # pop_density scales identically since density = population / fixed area.
        raw = raw * POP_SCALE
    w[f] = raw if (f in ENV_FIELDS or f in ("population", "pop_density")) else raw.fillna(0.0)
w["ym"] = w.year * 12 + w.month - 1

# treated / itn are present as columns but are entirely zero across the whole
# dataset (not collected) -- flag this so the frontend can fall back to a
# neutral assumption instead of treating "0" as a real measured value.
FLAGS = {
    "no_treated": bool((w["treated"] == 0).all()),
    "no_itn":     bool((w["itn"] == 0).all()),
}

# ── month windows: auto-detected from the data's own extent ─────────────────
# Same rule as modeling.py: first/last month with real (nonzero) reported
# cases, not a hardcoded cutoff -- so this export never goes stale as new
# months land. ACTUAL now covers the FULL real history (previously a fixed
# trailing 24 months) so the dashboard's time filter can span the whole
# reporting period (2023 onward) instead of just the last two years.
_monthly_cases = w.groupby("ym")["cases"].sum()
_real_ym = _monthly_cases[_monthly_cases > 0].index
FIRST_REAL_YM = int(_real_ym.min())
LAST_REAL_YM = int(_real_ym.max())
ACTUAL = list(range(FIRST_REAL_YM, LAST_REAL_YM + 1))       # full real history
FCAST  = list(range(LAST_REAL_YM + 1, LAST_REAL_YM + 13))   # 12 months forward
ALLYM  = ACTUAL + FCAST

# Population is a smooth monotonic trend, not a seasonal cycle -- the generic
# "climatology" fallback (calendar-month average across the actual window)
# used for every other lever baseline would average three-plus years of a
# GROWING series and under-project forecast months relative to the latest
# real value (e.g. Mar 2027 forecast landing below the real Mar 2026 figure).
# Extrapolate forward instead, compounding this data's own most recent
# year-over-year national growth rate from the last real month.
_nat_pop_by_ym = w.groupby("ym")["population"].sum()
_py_ym = LAST_REAL_YM - 12
if _py_ym in _nat_pop_by_ym.index and _nat_pop_by_ym.get(_py_ym, 0) > 0:
    POP_ANNUAL_GROWTH = _nat_pop_by_ym[LAST_REAL_YM] / _nat_pop_by_ym[_py_ym] - 1
else:
    POP_ANNUAL_GROWTH = 0.025  # fallback: Nigeria's long-run ~2.5%/yr rate
POP_MONTHLY_GROWTH = (1 + POP_ANNUAL_GROWTH) ** (1 / 12) - 1


def ymlabel(ym): return f"{MONTH_ABBR[ym % 12]} {ym // 12}"
MONTHS = [{"ym": f"{ym//12}-{ym%12+1:02d}", "label": ymlabel(ym), "forecast": ym in FCAST} for ym in ALLYM]
print(f"Last real reported month: {ymlabel(LAST_REAL_YM)}  |  "
      f"actual window {ymlabel(ACTUAL[0])}..{ymlabel(ACTUAL[-1])}  |  "
      f"forecast {ymlabel(FCAST[0])}..{ymlabel(FCAST[-1])}")

# ── real conditional forecast for cases/total (from modeling.py's XGBoost
# output, NOT climatology) ───────────────────────────────────────────────────
try:
    fc = pd.read_parquet("forecast_lga.parquet")
    fc_lga = {(r.state, r.lga, int(r.year * 12 + r.month - 1)): float(r.cases_pred)
               for r in fc.itertuples()}
except FileNotFoundError:
    fc_lga = {}
    print("[warn] forecast_lga.parquet not found -- falling back to climatology for cases too")


def rnd(f, v):
    if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))): return 0
    return int(round(v)) if f in COUNT else round(float(v), 2)


def series_for(panel, state=None, lga=None):
    """panel: monthly frame for ONE area, indexed by ym, with FIELDS columns.
       Returns {field: [values aligned to ACTUAL+FCAST]}. Forecast months use
       forecast_lga.parquet's conditional forecast for cases/total (scaled by
       this area's own historical total/cases ratio); climatology for the
       rest (the adjustable lever baselines)."""
    p = panel.reindex(ACTUAL)                          # actual window rows
    # calendar-month climatology from the ACTUAL window ONLY (not the raw
    # panel's full historical range) -- several lever fields (act/llin/
    # rdt_done/iptp1-4_n) only started being collected in 2023, and are
    # literal 0.0 (not NaN) for every month before that in the source
    # parquet. Averaging those genuine-zero pre-collection years in alongside
    # real 2023+ values was diluting every forecast month's climatology by
    # ~40-60%, producing an artificial cliff right at the actual/forecast
    # boundary (e.g. national IPTp1 doses: real ~1.9M/month through Mar 2026,
    # climatology-forecast ~0.76M for Apr 2026) even though the real trend is
    # flat-to-growing. Restricting to ACTUAL mirrors the NaN-preserving fix
    # already applied to ENV_FIELDS, for fields where the gap is zeros
    # instead of NaN.
    clim = {}
    cm = p.copy(); cm["cal"] = [ym % 12 for ym in cm.index]
    for f in FIELDS:
        clim[f] = cm.groupby("cal")[f].mean()

    # this area's own historical total/cases ratio, to project "total" (which
    # forecast_lga.parquet doesn't forecast) from the real cases_pred forecast
    hist_cases = panel.reindex(ACTUAL)["cases"].sum() if "cases" in panel.columns else 0
    hist_total = panel.reindex(ACTUAL)["total"].sum() if "total" in panel.columns else 0
    total_ratio = (hist_total / hist_cases) if hist_cases > 0 else 1.0
    # This area's own last real population/density reading, to compound
    # forward for forecast months (see POP_MONTHLY_GROWTH above) instead of
    # climatology-averaging a growing series back down.
    last_real_pop = {}
    for pf in ("population", "pop_density"):
        lv = p.at[LAST_REAL_YM, pf] if LAST_REAL_YM in p.index else np.nan
        last_real_pop[pf] = lv if not np.isnan(lv) else clim[pf].get(LAST_REAL_YM % 12, 0.0)

    out = {}
    for f in FIELDS:
        vals = []
        for ym in ALLYM:
            if ym in ACTUAL:
                v = p.at[ym, f] if ym in p.index else np.nan
                if np.isnan(v): v = clim[f].get(ym % 12, 0.0)
            elif f == "cases" and state is not None and (state, lga, ym) in fc_lga:
                v = fc_lga[(state, lga, ym)]
            elif f == "total" and state is not None and (state, lga, ym) in fc_lga:
                v = fc_lga[(state, lga, ym)] * total_ratio
            elif f in ("population", "pop_density"):
                v = last_real_pop[f] * ((1 + POP_MONTHLY_GROWTH) ** (ym - LAST_REAL_YM))
            else:
                v = clim[f].get(ym % 12, 0.0)           # lever baselines = climatology
            vals.append(rnd(f, v))
        out[f] = vals
    # rolling 3-vs-3 trend on cases across full timeline
    cfull = pd.Series(out["cases"], index=ALLYM).astype(float)
    tr = []
    for i, ym in enumerate(ALLYM):
        if i < 6:
            tr.append(0.0); continue
        recent = cfull.iloc[i-2:i+1].mean()
        prior = cfull.iloc[i-5:i-2].mean()
        tr.append(round(float(np.clip((recent-prior)/prior, -1, 3)), 3) if prior > 0 else (1.0 if recent > 0 else 0.0))
    out["trend"] = tr
    return out

# ── per-LGA ──────────────────────────────────────────────────────────────────
lgas = {}
for (st, lg), g in w.groupby(["state", "lga"]):
    panel = g.groupby("ym")[FIELDS].mean()             # one row per month
    lgas[f"{st}|||{lg}"] = series_for(panel, st, lg)

# ── per-state (counts summed across LGAs per month, rates mean; cases/total
# forecast = sum of each state's LGAs' own real conditional forecast) ────────
states = {}
for st, g in w.groupby("state"):
    gm = g.groupby("ym")
    panel = pd.DataFrame({**{f: gm[f].sum() for f in COUNT}, **{f: gm[f].mean() for f in RATE}})
    lgas_in_state = g["lga"].unique()

    def state_series(panel=panel, st=st, lgas_in_state=lgas_in_state):
        p = panel.reindex(ACTUAL)
        # see the matching comment in series_for() above: climatology must be
        # built from the ACTUAL window only, not panel's full raw range,
        # since pre-2023 rows are genuine (non-NaN) zeros for several fields.
        clim = {}
        cm = p.copy(); cm["cal"] = [ym % 12 for ym in cm.index]
        for f in FIELDS:
            clim[f] = cm.groupby("cal")[f].mean()
        hist_cases = panel.reindex(ACTUAL)["cases"].sum() if "cases" in panel.columns else 0
        hist_total = panel.reindex(ACTUAL)["total"].sum() if "total" in panel.columns else 0
        total_ratio = (hist_total / hist_cases) if hist_cases > 0 else 1.0
        # see the matching comment in series_for() above -- compound this
        # state's own last real population/density forward instead of
        # climatology-averaging a growing series back down.
        last_real_pop = {}
        for pf in ("population", "pop_density"):
            lv = p.at[LAST_REAL_YM, pf] if LAST_REAL_YM in p.index else np.nan
            last_real_pop[pf] = lv if not np.isnan(lv) else clim[pf].get(LAST_REAL_YM % 12, 0.0)
        out = {}
        for f in FIELDS:
            vals = []
            for ym in ALLYM:
                if ym in ACTUAL:
                    v = p.at[ym, f] if ym in p.index else np.nan
                    if np.isnan(v): v = clim[f].get(ym % 12, 0.0)
                elif f in ("cases", "total"):
                    total_cases_pred = sum(fc_lga.get((st, lg, ym), 0.0) for lg in lgas_in_state)
                    v = total_cases_pred * (total_ratio if f == "total" else 1.0)
                    if total_cases_pred == 0.0:
                        v = clim[f].get(ym % 12, 0.0)   # no forecast coverage for this state -> fall back
                elif f in ("population", "pop_density"):
                    v = last_real_pop[f] * ((1 + POP_MONTHLY_GROWTH) ** (ym - LAST_REAL_YM))
                else:
                    v = clim[f].get(ym % 12, 0.0)
                vals.append(rnd(f, v))
            out[f] = vals
        cfull = pd.Series(out["cases"], index=ALLYM).astype(float)
        tr = []
        for i, ym in enumerate(ALLYM):
            if i < 6:
                tr.append(0.0); continue
            recent = cfull.iloc[i-2:i+1].mean()
            prior = cfull.iloc[i-5:i-2].mean()
            tr.append(round(float(np.clip((recent-prior)/prior, -1, 3)), 3) if prior > 0 else (1.0 if recent > 0 else 0.0))
        out["trend"] = tr
        return out

    states[st] = state_series()

payload = {"months": MONTHS, "fields": FIELDS + ["trend"], "lgas": lgas, "states": states, "flags": FLAGS,
           "note": "monthly indicator inputs; cases/total forecast = forecast_lga.parquet's conditional "
                   "XGBoost forecast (NOT climatology); burden score + percentile blend computed client-side"}

for variant in ["after", "before"]:
    d = f"ui/public/data/{variant}"
    if os.path.isdir(d):
        json.dump(payload, open(f"{d}/burden.json", "w"), allow_nan=False)
        print(f"wrote {d}/burden.json  ({round(os.path.getsize(d+'/burden.json')/1024)} KB)")

print(f"\nmonths: {MONTHS[0]['label']} … {MONTHS[-1]['label']}  ({len(MONTHS)} = {len(ACTUAL)} actual + {len(FCAST)} forecast)")
# rainy-season sanity: national mean rain by month index
nat_rain = [np.mean([states[s]['rain'][i] for s in states]) for i in range(len(ALLYM))]
peak = int(np.argmax(nat_rain[:24]))
print(f"actual rain peaks at {MONTHS[peak]['label']} ({nat_rain[peak]:.1f} mm/day)")
