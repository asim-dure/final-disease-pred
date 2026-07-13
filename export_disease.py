"""
Generalized per-disease exporter: warehouse -> ui/public/data/after/<disease>/*.json.
Mirrors the file shapes export_ui_data.py/export_burden.py/export_data_view.py
already produce for malaria (read-only, additive sibling pipeline -- malaria's
own files/producers are never touched).

Usage:
    python export_disease.py --disease hiv
    python export_disease.py --disease hiv,tb,asthma
    python export_disease.py --all
"""
import argparse
import json
import os
import warnings

import numpy as np
import pandas as pd
from dotenv import load_dotenv

warnings.filterwarnings("ignore")
load_dotenv()

import disease_config as dc
import etl_warehouse_common as ewc
import population_data as popdata
import warehouse as wh
from api import run_sarimax, trim_trailing_zeros, future_dates  # reuse the proven SARIMAX engine

HORIZON = 18  # months ahead -- modest, honest horizon (not malaria's separate 5yr pipeline)
OUT_ROOT = os.path.join(os.path.dirname(__file__), "ui", "public", "data", "after")


def _date_col(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["date"] = df["year"].astype(int).astype(str) + "-" + df["month"].astype(int).astype(str).str.zfill(2)
    return df


def _agg_monthly(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    out = df.groupby(group_cols + ["year", "month"], as_index=False)["value"].sum()
    return _date_col(out).sort_values(group_cols + ["date"]).reset_index(drop=True)


def _complete_monthly(agg: pd.DataFrame) -> pd.DataFrame:
    """Reindexes [date, value] rows onto a gap-free monthly calendar (missing
    months -> NaN, filled later by run_sarimax's own interpolate/bfill).
    Warehouse fact rows have real reporting gaps (a missing month, not a
    zero month) -- SARIMAX assumes its row index IS consecutive months, so
    skipping a gappy month silently shifts the seasonal period and produces
    wildly wrong forecasts. This was caught by a first HIV run that
    forecast ~94M monthly cases nationally -- traced to exactly this gap."""
    agg = agg.sort_values("date")
    periods = pd.PeriodIndex(agg["date"], freq="M")
    full = pd.period_range(periods.min(), periods.max(), freq="M")
    s = pd.Series(agg["value"].values, index=periods).reindex(full)
    return pd.DataFrame({"date": [str(p) for p in full], "value": s.values})


def _clip_outliers(series: pd.Series) -> pd.Series:
    """This UAT warehouse has real one-off/bulk data-load artifacts (e.g.
    hypertension's national total briefly hitting 666,730,135 in 2023-09
    against a ~85,000 norm; HIV's PLHIV-on-ART metric sustaining an
    80-million-scale plateau for several months against a ~250,000-scale
    norm everywhere else). These are warehouse data defects, not real
    signal -- left in training data they wreck SARIMAX's extrapolation.
    Median-Absolute-Deviation outlier filter (global, not local-window, so
    it also catches multi-month anomalous plateaus): null out points beyond
    8x scaled-MAD from the series median, then let interpolation fill the
    gap -- same "don't fabricate, mark unreported/unreliable" principle
    used elsewhere, just applied to implausible readings instead of gaps."""
    s = series.copy()
    valid = s.dropna()
    if len(valid) < 8:
        return s
    med = valid.median()
    mad = (valid - med).abs().median()
    if mad == 0:
        return s
    threshold = med + 8 * 1.4826 * mad
    outliers = s > threshold
    s.loc[outliers] = np.nan
    return s


def _trim_underreported_tail(series: pd.Series) -> pd.Series:
    """Health-MIS reporting lag means the most recent 1-3 months are often
    still being collected and arrive far below the true level -- a real
    artifact, not a real decline. Left in training data, it reads as a sharp
    drop right before the forecast horizon and SARIMAX extrapolates that
    drop into an explosive trend (observed: a 94M-case national forecast for
    a series whose real peak was ~1.6M, traced to exactly this). Drop
    trailing months under 40% of the preceding 12-month median, the same
    spirit as trim_trailing_zeros but for "nearly zero", not just zero."""
    s = series.copy()
    while len(s.dropna()) > 12:
        recent12 = s.dropna().iloc[-13:-1]
        med = recent12.median()
        last_valid_idx = s.dropna().index[-1]
        last_val = s.loc[last_valid_idx]
        if med > 0 and last_val < 0.4 * med:
            s.loc[last_valid_idx] = np.nan
        else:
            break
    return s


def _forecast_one(agg: pd.DataFrame, horizon: int = HORIZON):
    """agg: a single series's rows with columns [date, value] (gaps allowed --
    completed onto a monthly calendar here before SARIMAX sees it).
    Returns (history_rows, forecast_rows) in malaria's national.json row shape
    (minus incidence, added by the caller)."""
    agg = _complete_monthly(agg).reset_index(drop=True)
    series = _trim_underreported_tail(_clip_outliers(agg["value"].copy()))
    series_trimmed, _ = trim_trailing_zeros(series, None)
    if series_trimmed.empty:
        return [], []
    last_date = agg.loc[series_trimmed.index[-1], "date"]
    hist_max = float(series.dropna().max()) if series.dropna().size else 0.0

    # History shows the real reported value even where it's an implausible
    # outlier (don't hide genuine -- if wrong -- warehouse records); only the
    # SARIMAX training series above uses the outlier-cleaned version.
    history = [
        {"date": row["date"], "year": int(row["date"][:4]), "month": int(row["date"][5:7]),
         "cases": max(0, int(round(row["value"]))), "forecast": False}
        for _, row in agg.iterrows()
        if pd.notna(row["value"]) and row["date"] <= last_date
    ]

    mean, lower, upper = run_sarimax(series, None, None, horizon)
    # Defensive bound: cap a degenerate/non-converged SARIMAX's runaway
    # extrapolation at a multiple of the real historical peak, rather than
    # silently shipping a forecast that's 1000x the actual data ever seen.
    cap = max(hist_max * 3, 10)
    mean = [min(int(v), int(cap)) for v in mean]
    fdates = future_dates(last_date, horizon)
    forecast_rows = [
        {"date": d, "year": int(d[:4]), "month": int(d[5:7]),
         "cases": max(0, int(v)), "forecast": True}
        for d, v in zip(fdates, mean)
    ]
    return history, forecast_rows


MIN_MONTHS_FOR_LGA_FORECAST = 12  # SARIMAX needs at least one full seasonal cycle


def _forecast_lga_panel(fact_lga: pd.DataFrame, horizon: int = HORIZON) -> pd.DataFrame:
    """Per-LGA SARIMAX forecast, reusing the exact same engine as the
    national/state forecasts above (_forecast_one -> api.run_sarimax).
    Returns one row per (state, lga, date) for EVERY actually-reported month
    PLUS a forecast tail -- with an explicit `forecast` boolean per row.
    LGAs with fewer than MIN_MONTHS_FOR_LGA_FORECAST real monthly points (after
    outlier/tail cleaning) get actual-only rows and no forecast tail -- too
    little signal to extrapolate honestly, so none is fabricated for them."""
    lga_agg = _agg_monthly(fact_lga, ["state", "lga"])
    rows = []
    n_fc, n_skip = 0, 0
    for (state_name, lga_name), grp in lga_agg.groupby(["state", "lga"]):
        agg = grp[["date", "value"]]
        for _, r in agg.iterrows():
            rows.append({"state": state_name, "lga": lga_name, "date": r["date"],
                         "value": float(r["value"]), "forecast": False})
        if agg["value"].dropna().shape[0] < MIN_MONTHS_FOR_LGA_FORECAST:
            n_skip += 1
            continue
        try:
            _, fc = _forecast_one(agg, horizon=horizon)
        except Exception:
            n_skip += 1
            continue
        if not fc:
            n_skip += 1
            continue
        n_fc += 1
        for r in fc:
            rows.append({"state": state_name, "lga": lga_name, "date": r["date"],
                         "value": float(r["cases"]), "forecast": True})
    print(f"  per-LGA SARIMAX: {n_fc} LGAs forecast, {n_skip} skipped (insufficient history)")
    return pd.DataFrame(rows, columns=["state", "lga", "date", "value", "forecast"])


def _national_population(year: int) -> float:
    return sum(popdata.state_population(s, year) for s in popdata.STATE_POP_2022)


def export_one(disease_id: str):
    cfg = dc.DISEASES[disease_id]
    out_dir = os.path.join(OUT_ROOT, disease_id)
    os.makedirs(out_dir, exist_ok=True)
    print(f"=== {disease_id} ({cfg['label']}) ===")

    capabilities = dict(cfg["capabilities"])
    capabilities["month_slider"] = dc.supports_month_slider(disease_id)
    capabilities["state_zone"] = dc.supports_state_zone(disease_id)

    # ── 1. national.json + states.json (forecastable diseases only) ─────────
    national_rows, states_rows, geo = [], {}, {}
    fact_lga = pd.DataFrame()
    if cfg.get("forecastable") and cfg.get("forecast_target"):
        target = cfg["forecast_target"]
        fetch_names = cfg.get("forecast_target_components", target)
        fact_lga = ewc.fetch_fact_series(disease_id, fetch_names, level="lga",
                                          system_id=cfg.get("forecast_target_system_id"))
        if fact_lga.empty:
            print(f"  ! no fact rows for target '{target}', skipping forecast export")
        else:
            fact_lga = fact_lga.dropna(subset=["state", "lga"])

            # national series
            nat_agg = _agg_monthly(fact_lga, [])
            hist, fc = _forecast_one(nat_agg[["date", "value"]])
            for r in hist + fc:
                pop = _national_population(r["year"])
                r["incidence"] = round(r["cases"] / pop * 1000, 3) if pop and pd.notna(pop) else None
            national_rows = sorted(hist + fc, key=lambda r: r["date"])

            # per-state series
            state_agg_all = _agg_monthly(fact_lga, ["state"])
            for state_name, grp in state_agg_all.groupby("state"):
                hist_s, fc_s = _forecast_one(grp[["date", "value"]])
                rows = []
                for r in hist_s + fc_s:
                    pop = popdata.state_population(state_name, r["year"])
                    rows.append({
                        "date": r["date"], "cases": r["cases"], "forecast": r["forecast"],
                        "incidence": round(r["cases"] / pop * 1000, 3) if pop and pd.notna(pop) else None,
                    })
                states_rows[state_name] = sorted(rows, key=lambda r: r["date"])
                geo[state_name] = {"lgas": sorted(fact_lga[fact_lga["state"] == state_name]["lga"].dropna().unique().tolist())}

            print(f"  national.json: {len(national_rows)} rows, states.json: {len(states_rows)} states")
    else:
        capabilities["forecast"] = False

    with open(os.path.join(out_dir, "national.json"), "w", encoding="utf-8") as f:
        json.dump(national_rows, f, ensure_ascii=False)
    with open(os.path.join(out_dir, "states.json"), "w", encoding="utf-8") as f:
        json.dump(states_rows, f, ensure_ascii=False)
    with open(os.path.join(out_dir, "geo.json"), "w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False)

    # ── 2. lgas.json: per-LGA monthly series, ACTUAL + SARIMAX forecast tail ──
    # (every disease except TB -- TB is already excluded above since its
    # forecastable flag is False, so fact_lga stays empty for it).
    lgas_rows = {}
    lga_panel = pd.DataFrame()
    if not fact_lga.empty:
        lga_panel = _forecast_lga_panel(fact_lga, horizon=HORIZON)
        for (state_name, lga_name), grp in lga_panel.groupby(["state", "lga"]):
            key = f"{state_name}|||{lga_name}"
            lgas_rows[key] = [
                {"d": row["date"], "c": max(0, int(round(row["value"]))), "f": bool(row["forecast"])}
                for _, row in grp.sort_values("date").iterrows()
            ]
    with open(os.path.join(out_dir, "lgas.json"), "w", encoding="utf-8") as f:
        json.dump(lgas_rows, f, ensure_ascii=False)

    # ── 3. hotspots.json + burden.json (precomputed hotspot table snapshot) ──
    # Diseases with no bespoke ML hotspot-prediction table (hotspot_table is
    # None/absent in disease_config.py -- true for every disease that has
    # ONLY a case-count target and nothing else) get a snapshot derived
    # directly from the same fact-table data already fetched for forecasting
    # above, instead of requiring a real hotspot table to exist: the LATEST
    # actually-reported month's case count per LGA. has_score/has_zone stay
    # False for these (set in disease_config.py), so no score/zone value is
    # fabricated here -- burden_score/zone_for_score below compute both
    # purely from case volume, same "volume_trend" formula every other
    # score/zone-less disease in this file already uses.
    if cfg.get("hotspot_table"):
        hot = ewc.fetch_hotspot(disease_id)
    elif not fact_lga.empty:
        lga_agg_all = _agg_monthly(fact_lga, ["state", "lga"])
        latest_per_lga = lga_agg_all.sort_values("date").groupby(["state", "lga"], as_index=False).last()
        hot = latest_per_lga.assign(
            year=latest_per_lga["date"].str[:4].astype(int),
            month=latest_per_lga["date"].str[5:7].astype(int),
            score=np.nan, zone=None,
        )[["state", "lga", "year", "month", "score", "zone", "value"]]
    else:
        hot = pd.DataFrame(columns=["state", "lga", "year", "month", "score", "zone", "value"])
    hot = ewc.join_population(hot, year_col="year")
    has_score = cfg["has_score"]
    rank_col = "score" if has_score else "value"
    hot_sorted = hot.copy()
    hot_sorted[rank_col] = pd.to_numeric(hot_sorted[rank_col], errors="coerce")

    # latest snapshot per LGA (max date if hotspot table has time grain, else as-is)
    if cfg["time_grain_hotspot"] == "month" and hot_sorted["year"].notna().any():
        latest_idx = hot_sorted.dropna(subset=["year"]).groupby(["state", "lga"])["year"].idxmax()
        snapshot = hot_sorted.loc[latest_idx]
    else:
        snapshot = hot_sorted.drop_duplicates(["state", "lga"], keep="last")

    burden_scores = ewc.burden_score(snapshot.assign(value=pd.to_numeric(snapshot["value"], errors="coerce")),
                                      tier="volume_trend", value_col="value", trend_col=None)
    snapshot = snapshot.assign(burden_score=burden_scores)
    # Prefer the hotspot table's own zone label when present (has_score diseases
    # mostly carry one); fall back to the derived burden-score band otherwise.
    snapshot["zone_label"] = snapshot["zone"]
    missing_zone = snapshot["zone_label"].isna()
    snapshot.loc[missing_zone, "zone_label"] = snapshot.loc[missing_zone, "burden_score"].map(ewc.zone_for_score)

    top40 = snapshot.sort_values(rank_col, ascending=False, na_position="last").head(40)
    hotspots_meta = [
        {"state": r["state"], "lga": r["lga"],
         "value": None if pd.isna(r["value"]) else round(float(r["value"]), 2),
         "score": None if pd.isna(r.get("score")) else round(float(r["score"]), 2)}
        for _, r in top40.iterrows()
    ]

    burden_json = {
        "rank_by": rank_col,
        "has_score": has_score,
        "lgas": {
            f"{r['state']}|||{r['lga']}": {
                "value": None if pd.isna(r["value"]) else round(float(r["value"]), 2),
                "score": None if pd.isna(r.get("score")) else round(float(r["score"]), 2),
                "burden_score": None if pd.isna(r["burden_score"]) else float(r["burden_score"]),
                "zone": r["zone_label"],
                "population": None if pd.isna(r.get("population")) else float(r["population"]),
                "population_match": bool(r.get("population_match", False)),
                "year": None if pd.isna(r.get("year")) else int(r["year"]),
                "month": None if pd.isna(r.get("month")) else int(r["month"]),
            }
            for _, r in snapshot.iterrows()
        },
    }
    # state-level snapshot rollup: SUM raw value/population per state (counts
    # are additive), then recompute burden_score fresh by ranking states
    # against each other -- never by averaging the LGA-level burden scores,
    # which would mix two different peer groups (LGA percentiles vs state
    # percentiles). Built unconditionally (not gated on supports_state_zone)
    # so it matches the same precedent already used for hist_lgas below,
    # which also computes a score regardless of the has_zone flag.
    state_val = snapshot.groupby("state", as_index=False)["value"].sum(min_count=1)
    state_pop = snapshot.groupby("state")["population"].sum(min_count=1).rename("population")
    state_snap = state_val.merge(state_pop, on="state", how="left")
    state_snap["value"] = pd.to_numeric(state_snap["value"], errors="coerce")
    state_snap["burden_score"] = ewc.burden_score(state_snap, tier="volume_trend", value_col="value", trend_col=None)
    state_snap["zone"] = state_snap["burden_score"].map(ewc.zone_for_score)
    burden_json["states"] = {
        r["state"]: {
            "value": None if pd.isna(r["value"]) else round(float(r["value"]), 2),
            "burden_score": None if pd.isna(r["burden_score"]) else float(r["burden_score"]),
            "zone": r["zone"],
            "population": None if pd.isna(r["population"]) else float(r["population"]),
        }
        for _, r in state_snap.iterrows()
    }
    # ── 3b. burden.json history: cross-sectional monthly burden_score, for
    # diseases with a real per-LGA monthly fact series -- ACTUAL reported
    # months plus the per-LGA SARIMAX forecast tail built above (lga_panel).
    # Each LGA-month carries its own `forecast` flag (some LGAs may still
    # have actual data for a calendar month while others, having stopped
    # reporting earlier, are already in their own forecast tail for that
    # same month -- ranking/scoring at each date only uses whichever LGAs
    # actually have a value then, same graceful-degradation as before).
    if dc.supports_month_slider(disease_id) and not lga_panel.empty:
        hist_agg = lga_panel.sort_values(["state", "lga", "date"]).copy()
        hist_agg["trend"] = hist_agg.groupby(["state", "lga"])["value"].diff().fillna(0.0)
        history_dates = sorted(hist_agg["date"].unique())
        date_idx = {d: i for i, d in enumerate(history_dates)}
        month_forecast_frac = hist_agg.groupby("date")["forecast"].mean()
        hist_months = [
            {"ym": d, "label": pd.Period(d, freq="M").strftime("%b %Y"),
             "forecast": bool(month_forecast_frac.get(d, 0) >= 0.5)}
            for d in history_dates
        ]
        hist_lgas = {}
        for d in history_dates:
            cross = hist_agg[hist_agg["date"] == d].copy()
            if cross.empty:
                continue
            cross["burden_score"] = ewc.burden_score(cross, tier="volume_trend", value_col="value", trend_col="trend")
            cross["zone"] = cross["burden_score"].map(ewc.zone_for_score)
            i = date_idx[d]
            for _, r in cross.iterrows():
                key = f"{r['state']}|||{r['lga']}"
                arr = hist_lgas.setdefault(key, {
                    "burden_score": [None] * len(history_dates),
                    "zone": [None] * len(history_dates),
                    "value": [None] * len(history_dates),
                    "forecast": [None] * len(history_dates),
                })
                arr["burden_score"][i] = round(float(r["burden_score"]), 2)
                arr["zone"][i] = r["zone"]
                # Raw case value per month, not just the derived burden_score --
                # needed so the frontend can recompute burden_score with a
                # lever-adjusted value (What-If levers) without re-fetching
                # anything, using the exact same volume_trend formula
                # (ewc.burden_score) ported to JS.
                arr["value"][i] = None if pd.isna(r["value"]) else round(float(r["value"]), 2)
                arr["forecast"][i] = bool(r["forecast"])

        # state-level history rollup: SUM each state's LGA values per date
        # (sum -- counts are additive), then diff the STATE'S OWN aggregated
        # series for trend (not an average of LGA-level trends), and recompute
        # burden_score by ranking states against states for that date -- the
        # same sum/recompute methodology as the snapshot rollup above, just
        # repeated across every date in history_dates so the time slider's
        # forecast-driven colour change works identically at state scope.
        # "first" (non-aggregable) fields like state/lga names use plain
        # groupby keys, never summed/averaged.
        state_panel = (hist_agg.groupby(["state", "date"], as_index=False)
                       .agg(value=("value", "sum"), forecast=("forecast", "mean")))
        state_panel["forecast"] = state_panel["forecast"] >= 0.5
        state_panel = state_panel.sort_values(["state", "date"])
        state_panel["trend"] = state_panel.groupby("state")["value"].diff().fillna(0.0)
        hist_states = {}
        for d in history_dates:
            cross = state_panel[state_panel["date"] == d].copy()
            if cross.empty:
                continue
            cross["burden_score"] = ewc.burden_score(cross, tier="volume_trend", value_col="value", trend_col="trend")
            cross["zone"] = cross["burden_score"].map(ewc.zone_for_score)
            i = date_idx[d]
            for _, r in cross.iterrows():
                arr = hist_states.setdefault(r["state"], {
                    "burden_score": [None] * len(history_dates),
                    "zone": [None] * len(history_dates),
                    "value": [None] * len(history_dates),
                    "forecast": [None] * len(history_dates),
                })
                arr["burden_score"][i] = round(float(r["burden_score"]), 2)
                arr["zone"][i] = r["zone"]
                arr["value"][i] = round(float(r["value"]), 2)
                arr["forecast"][i] = bool(r["forecast"])

        burden_json["history"] = {"months": hist_months, "lgas": hist_lgas, "states": hist_states}
        print(f"  burden.json history: {len(hist_months)} months x {len(hist_lgas)} LGAs, {len(hist_states)} states (incl. forecast tail)")

    with open(os.path.join(out_dir, "burden.json"), "w", encoding="utf-8") as f:
        json.dump(burden_json, f, ensure_ascii=False)

    # ── 4. dataset.json + data_dictionary.json (DataExplorer) ────────────────
    ds = snapshot[["state", "lga", "value", "burden_score", "zone_label", "population", "population_match", "year", "month"]].copy()
    ds = ds.rename(columns={"zone_label": "zone"})
    columns = list(ds.columns)
    rows = ds.where(pd.notna(ds), None).values.tolist()
    rows = [[(round(v, 3) if isinstance(v, float) else v) for v in row] for row in rows]
    dataset_json = {"columns": columns, "rows": rows, "n": len(rows),
                     "note": f"{cfg['label']} -- latest hotspot snapshot per LGA, joined to population (no fabrication: unmatched population left null)."}
    with open(os.path.join(out_dir, "dataset.json"), "w", encoding="utf-8") as f:
        json.dump(dataset_json, f, ensure_ascii=False)

    data_dict = [
        {"field": "state", "agg": "-", "desc": "State name"},
        {"field": "lga", "agg": "-", "desc": "LGA name"},
        {"field": "value", "agg": "sum/avg", "desc": f"Hotspot table value column ({cfg['hotspot_cols']['value']})"},
        {"field": "burden_score", "agg": "derived", "desc": "0-100 percentile blend of case volume (60%) + trend (40%), volume_trend tier"},
        {"field": "zone", "agg": "-", "desc": "Burden zone label (source zone column if present, else derived from burden_score)"},
        {"field": "population", "agg": "lookup", "desc": "Joined from agg_lga_pop.parquet by (state, lga, year); null if no match (2020-2026 coverage only)"},
        {"field": "population_match", "agg": "-", "desc": "True if population lookup found a match for this row's year"},
        {"field": "year", "agg": "-", "desc": "Year of this hotspot snapshot row"},
        {"field": "month", "agg": "-", "desc": "Month of this hotspot snapshot row (null if hotspot table has no month grain)"},
    ]
    with open(os.path.join(out_dir, "data_dictionary.json"), "w", encoding="utf-8") as f:
        json.dump(data_dict, f, ensure_ascii=False)

    # ── 5. meta.json ──────────────────────────────────────────────────────────
    ranking = [
        {"state": s, "value": float(g["value"].sum())}
        for s, g in snapshot.groupby("state") if pd.notna(g["value"]).any()
    ] if "value" in snapshot.columns else []
    ranking = sorted([r for r in ranking if not np.isnan(r["value"])], key=lambda r: -r["value"])

    # state-level burden zones: only for diseases whose LGA-level zone concept
    # is genuine (has_zone) -- diseases without one (hiv, elephantiasis) get no
    # fabricated state zone. Aggregates each state's LGA values, ranks states
    # against each other with the same volume_trend formula used at LGA level.
    state_zones = {}
    if dc.supports_state_zone(disease_id) and "burden_score" in snapshot.columns:
        state_agg = snapshot.groupby("state", as_index=False)["value"].sum()
        state_agg["value"] = pd.to_numeric(state_agg["value"], errors="coerce")
        state_agg["state_burden_score"] = ewc.burden_score(state_agg, tier="volume_trend", value_col="value", trend_col=None)
        for _, r in state_agg.iterrows():
            state_zones[r["state"]] = {
                "burden_score": float(r["state_burden_score"]),
                "zone": ewc.zone_for_score(r["state_burden_score"]),
            }

    meta_json = {
        "disease": disease_id,
        "label": cfg["label"],
        "capabilities": capabilities,
        "state_zones": state_zones,
        "summary": {
            "n_states": snapshot["state"].nunique(),
            "n_lgas": snapshot["lga"].nunique(),
            "rank_by": rank_col,
        },
        "ranking": ranking,
        "hotspots": hotspots_meta,
        "forecast_target": cfg.get("forecast_target"),
        "forecast_unavailable_reason": cfg.get("forecast_unavailable_reason"),
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta_json, f, ensure_ascii=False)

    print(f"  wrote -> {out_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--disease", type=str, default="")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    if args.all:
        ids = [k for k in dc.DISEASES if k != "malaria"]
    else:
        ids = [d.strip() for d in args.disease.split(",") if d.strip()]

    if not ids:
        raise SystemExit("Pass --disease <id>[,<id>...] or --all")

    for did in ids:
        if did not in dc.DISEASES:
            print(f"! unknown disease id: {did}")
            continue
        export_one(did)


if __name__ == "__main__":
    main()
