"""
Shared warehouse-ETL helpers used by export_disease.py for every non-malaria
disease. Mirrors the role agg_config.py/population_data.py play for
malaria's file-based pipeline, but reading live from the FMOH warehouse.

Verified live against the warehouse during implementation:
  - public.dim_geo_location_master: admin_level=2 -> state (37 rows incl FCT),
    admin_level=3 -> LGA (853 rows).
  - <schema>.fact_indicator_data (hiv/ncd/ntd/tb) joins to
    public.dim_indicator_master on indicator_key, and to
    public.dim_geo_location_master on geo_admin_location_key.
"""
import re
import numpy as np
import pandas as pd

import warehouse as wh
import disease_config as dc

NORM = wh.NORMALIZE_SQL  # "lower(regexp_replace({col}, '[^a-zA-Z0-9]', '', 'g'))"


def _norm(col: str) -> str:
    return NORM.format(col=col)


def fetch_hotspot(disease_id: str) -> pd.DataFrame:
    """Per-LGA snapshot/time-series rows from a disease's precomputed hotspot
    table, normalized to columns: state, lga, year, month, score, zone, value.
    Missing source columns come back as NaN/None, never KeyError."""
    cfg = dc.get_hotspot_config(disease_id)
    hc = cfg["hotspot_cols"]
    table = cfg["hotspot_table"]

    state_col, lga_col = hc["state"], hc["lga"]
    year_col, month_col = hc.get("year"), hc.get("month")
    date_col = hc.get("date")
    score_col, zone_col, value_col = hc.get("score"), hc.get("zone"), hc["value"]

    select_parts = [f'h."{state_col}" as state', f'h."{lga_col}" as lga']
    if date_col:
        select_parts.append(f'h."{date_col}" as _date')
        select_parts.append(f'extract(year from h."{date_col}")::int as year')
        select_parts.append(f'extract(month from h."{date_col}")::int as month')
    else:
        select_parts.append(f'h."{year_col}" as year' if year_col else "NULL::int as year")
        select_parts.append(f'h."{month_col}" as month' if month_col else "NULL::int as month")
    select_parts.append(f'h."{score_col}" as score' if score_col else "NULL::float as score")
    select_parts.append(f'h."{zone_col}" as zone' if zone_col else "NULL::text as zone")
    select_parts.append(f'h."{value_col}" as value')

    sql = f'select {", ".join(select_parts)} from public."{table}" h'
    df = wh.safe_select(sql)
    df["state_norm"] = df["state"].map(wh.normalize_lga_name)
    df["lga_norm"] = df["lga"].map(wh.normalize_lga_name)
    return df


def fetch_fact_series(disease_id: str, indicator_name, level: str = "lga",
                       system_id: int | None = None) -> pd.DataFrame:
    """Pulls one OR MORE indicators' monthly time series from
    <schema>.fact_indicator_data, joined to dim_indicator_master (sum-vs-average
    aggregation rule) and dim_geo_location_master, grouped to the requested
    geography level. Returns [state, lga?, year, month, value] -- the same
    shape api.py's agg_level()/run_sarimax() already expect.

    indicator_name may be a single string OR a list of indicator_names, in
    which case ALL of them are SUMMED into one derived target series (e.g.
    HIV's NDARS-only "HTS_TST_POS Total, Male" + "...Total, Female" -- see
    disease_config.DISEASES['hiv']['forecast_target_components']). When a
    list is given, every name must resolve to exactly one row in
    dim_indicator_master (optionally further restricted by system_id) --
    raises ValueError on any unmatched name rather than silently summing a
    partial/wrong set. system_id restricts to one dim_application_system_master
    source (e.g. 7 = NDARS) -- required whenever the same indicator_name could
    plausibly be reported by more than one system."""
    cfg = dc.DISEASES[disease_id]
    schema = cfg["fact_schema"]

    names = [indicator_name] if isinstance(indicator_name, str) else list(indicator_name)

    meta_sql = "select indicator_name, aggregationtype from public.dim_indicator_master where indicator_name = ANY(:names)"
    meta_params = {"names": names}
    if system_id is not None:
        meta_sql += " and system_id = :sysid"
        meta_params["sysid"] = system_id

    agg_meta = wh.safe_select(meta_sql, meta_params)
    missing = set(names) - set(agg_meta["indicator_name"])
    if missing:
        raise ValueError(
            f"Indicator(s) {sorted(missing)} not found in dim_indicator_master"
            + (f" with system_id={system_id}" if system_id is not None else "")
        )
    agg_fns = {("avg" if str(v).lower().startswith("av") else "sum") for v in agg_meta["aggregationtype"]}
    if len(agg_fns) > 1:
        raise ValueError(f"Mixed aggregation types across {names}: cannot safely sum into one target")
    agg_fn = agg_fns.pop()

    raw_cols = "g.geo_admin_level2_name"
    select_cols = "g.geo_admin_level2_name as state"
    if level == "lga":
        raw_cols += ", g.geo_admin_level3_name"
        select_cols += ", g.geo_admin_level3_name as lga"

    # Note: dim_geo_location_master's level2_name/level3_name (state/LGA) are
    # denormalized onto every row regardless of that row's own admin_level
    # (e.g. a facility-level admin_level=7 row still carries its parent
    # state/LGA names) -- so grouping by those columns directly, with NO
    # admin_level filter, is what actually rolls facility-level facts up to
    # state/LGA. Filtering by admin_level here would silently return zero
    # rows for facility-grain datasets like HIV's.
    where_sysid = " and f.system_id = :sysid" if system_id is not None else ""
    # dedup_f: some warehouse indicators have the exact same fact row loaded
    # multiple times under different indicator_txn_key surrogate ids but an
    # IDENTICAL hashkey (verified live: e.g. "ART PLHIV currently receiving
    # ART..." has the same hashkey repeated 66x per facility-month, inflating
    # a naive sum ~66x above Nigeria's actual PLHIV-on-ART population).
    # `distinct on (hashkey)` collapses these back to one row per hashkey
    # before aggregating -- a no-op for indicators that have no duplicates
    # (verified: HTS_TST_POS, Hypertension New Cases, all of TB are already
    # 1:1 row-to-hashkey and unaffected by this change).
    sql = f"""
        with dedup_f as (
            select distinct on (f.hashkey) f.*
            from {schema}.fact_indicator_data f
            join public.dim_indicator_master d on d.indicator_key = f.indicator_key
            where d.indicator_name = ANY(:names) and f.year is not null and f.month is not null{where_sysid}
        )
        select {select_cols}, f.year, f.month, {agg_fn}(f.indicator_value) as value
        from dedup_f f
        join public.dim_geo_location_master g on g.geo_admin_location_key = f.geo_admin_location_key
        where g.geo_admin_level2_name is not null
        group by {raw_cols}, f.year, f.month
    """
    params = {"names": names}
    if system_id is not None:
        params["sysid"] = system_id
    df = wh.safe_select(sql, params)
    df["value"] = pd.to_numeric(df["value"], errors="coerce").fillna(0.0)
    return df


_POP_LOOKUP_CACHE: pd.DataFrame | None = None


def fetch_population_lookup() -> pd.DataFrame:
    """Reuses agg_lga_pop.parquet's own [state, lga, year, population] columns
    as the population source for every disease (decision: reuse, don't re-derive)."""
    global _POP_LOOKUP_CACHE
    if _POP_LOOKUP_CACHE is None:
        df = pd.read_parquet("agg_lga_pop.parquet", columns=["state", "lga", "year", "population"])
        df = df.dropna(subset=["state", "lga", "year"]).drop_duplicates(["state", "lga", "year"])
        df["state_norm"] = df["state"].map(wh.normalize_lga_name)
        df["lga_norm"] = df["lga"].map(wh.normalize_lga_name)
        _POP_LOOKUP_CACHE = df
    return _POP_LOOKUP_CACHE


def join_population(df: pd.DataFrame, year_col: str = "year") -> pd.DataFrame:
    """Joins population onto df via normalized (state, lga, year). Adds
    population (float or NaN) and population_match (bool) columns. Never
    fabricates -- unmatched rows get NaN population, not 0 or a national avg."""
    pop = fetch_population_lookup()
    out = df.copy()
    out["state_norm"] = out["state"].map(wh.normalize_lga_name)
    out["lga_norm"] = out["lga"].map(wh.normalize_lga_name)
    merged = out.merge(
        pop[["state_norm", "lga_norm", "year", "population"]],
        left_on=["state_norm", "lga_norm", year_col],
        right_on=["state_norm", "lga_norm", "year"],
        how="left",
        suffixes=("", "_pop"),
    )
    merged["population_match"] = merged["population"].notna()
    return merged


TB_DOUBLE_COUNT_GUARD_NOTE = dc.DOUBLE_COUNT_GUARD_NOTE


def tb_safe_case_sum(male_series: pd.Series, female_series: pd.Series,
                      adult_series: pd.Series | None = None,
                      child_series: pd.Series | None = None) -> pd.Series:
    """Sums exactly ONE TB case partition per disease_config.TB_CASE_PARTITION.
    Raises if a caller tries to also sum the other partition (double-count guard)."""
    if dc.TB_CASE_PARTITION != "sex":
        raise AssertionError(dc.DOUBLE_COUNT_GUARD_NOTE)
    if adult_series is not None or child_series is not None:
        raise AssertionError(dc.DOUBLE_COUNT_GUARD_NOTE)
    return male_series.fillna(0) + female_series.fillna(0)


# ── burden score: generic 2-tier port of export_burden.py's formula ─────────
# "full" tier (malaria only) is NOT implemented here -- malaria keeps its own
# live client-side JS recomputation untouched. This module only implements
# "volume_trend", the tier every new disease in this pass uses.
ZONE_THRESHOLDS = [(18, "Not a Hotspot"), (38, "Green"), (58, "Yellow"), (78, "Amber")]


def zone_for_score(score: float) -> str:
    if score is None or (isinstance(score, float) and np.isnan(score)):
        return "Not a Hotspot"
    for threshold, label in ZONE_THRESHOLDS:
        if score < threshold:
            return label
    return "Red"


def burden_score(df: pd.DataFrame, tier: str, value_col: str = "value",
                  trend_col: str | None = "trend") -> pd.Series:
    """volume_trend tier: A1 case volume (60%) + A2 case trend (40%), each
    percentile-ranked 0-100 within the input frame, then blended 60/40
    rank/raw same as export_burden.py's percentile-blend approach."""
    if tier != "volume_trend":
        raise NotImplementedError(f"burden_score tier '{tier}' not implemented here")

    vol = pd.to_numeric(df[value_col], errors="coerce").fillna(0.0)
    vol_rank = vol.rank(pct=True) * 100

    if trend_col and trend_col in df.columns:
        trend = pd.to_numeric(df[trend_col], errors="coerce").fillna(0.0)
    else:
        trend = pd.Series(0.0, index=df.index)
    trend_rank = trend.rank(pct=True) * 100

    a1 = 0.60 * vol_rank
    a2 = 0.40 * trend_rank
    raw = a1 + a2
    raw_pct = raw.rank(pct=True) * 100
    blended = 0.60 * raw_pct + 0.40 * raw
    return blended.round(2)
