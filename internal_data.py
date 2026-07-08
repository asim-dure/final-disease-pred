"""
Bridges OUR internal surveillance/forecast data into the News & Intervention
Alerts pipeline, so each outbreak's planning brief combines (a) the scraped
news/sitrep trajectory with (b) our own real per-state disease burden -- not
just news in isolation.

Concretely: for the states an outbreak names as most-affected, this pulls our
real malaria burden from the local agg_lga_pop.parquet (the same file api.py
serves the malaria dashboards from). Malaria is always included because it is
both the dominant fever-presenting disease (clinically confusable with Lassa,
typhoid, dengue, etc.) and the disease we hold the richest per-LGA data for --
so "Lassa surging in Edo" can be set directly against "our data shows Edo also
carries ~38k confirmed malaria cases/month", which is exactly the combined
health-system-load picture a planner needs.

Standalone + import-safe: loads the parquet itself (cached), so the cron
pipeline can use it without importing api.py.
"""
import logging
import os

import pandas as pd

log = logging.getLogger("internal_data")

_PARQUET = os.path.join(os.path.dirname(__file__), "agg_lga_pop.parquet")
_FORECAST_CSV = os.path.join(os.path.dirname(__file__), "forecast_state.csv")
_MALARIA_TARGET = "MAL - Malaria cases confirmed (number)"
_DF = None
_FC = None


def _df() -> pd.DataFrame | None:
    global _DF
    if _DF is None:
        try:
            _DF = pd.read_parquet(_PARQUET)
            _DF["date"] = _DF["year"].astype(str) + "-" + _DF["month"].astype(str).str.zfill(2)
        except Exception as e:
            log.warning(f"Could not load internal malaria data ({_PARQUET}): {e}")
            _DF = False  # sentinel: tried and failed, don't retry every call
    return _DF if _DF is not False else None


def _fc() -> pd.DataFrame | None:
    global _FC
    if _FC is None:
        try:
            f = pd.read_csv(_FORECAST_CSV)
            f["date"] = f["year"].astype(str) + "-" + f["month"].astype(str).str.zfill(2)
            _FC = f
        except Exception as e:
            log.warning(f"Could not load malaria forecast ({_FORECAST_CSV}): {e}")
            _FC = False
    return _FC if _FC is not False else None


def malaria_forecast_for_states(states: list[str], months: int = 4) -> dict[str, dict]:
    """{state: {from_month, to_month, start_pred, end_pred, direction}} -- our
    OWN precomputed SARIMAX malaria forecast (forecast_state.csv) for the next
    `months` forecast months, per affected state. This is the forward-looking
    'our data's forecast' the combined brief contrasts the news/weather
    against. Empty dict if unavailable."""
    f = _fc()
    if f is None or not states:
        return {}
    out = {}
    for state in states:
        fc = f[(f["state"] == state) & (f["is_forecast"] == True)].sort_values("date")  # noqa: E712
        if fc.empty:
            continue
        window = fc.head(months)
        start, end = float(window["cases_pred"].iloc[0]), float(window["cases_pred"].iloc[-1])
        direction = "rising" if end > start * 1.05 else "falling" if end < start * 0.95 else "flat"
        out[state] = {
            "from_month": window["date"].iloc[0], "to_month": window["date"].iloc[-1],
            "start_pred": start, "end_pred": end, "direction": direction,
        }
    return out


def malaria_burden_for_states(states: list[str]) -> dict[str, dict]:
    """{state: {latest_month, latest_value, trend}} of our real confirmed
    malaria caseload for each requested state. Empty dict if data
    unavailable. trend compares the latest month to the mean of the prior
    3 months."""
    df = _df()
    if df is None or _MALARIA_TARGET not in df.columns or not states:
        return {}
    out = {}
    for state in states:
        sub = df[df["state"] == state]
        if sub.empty:
            continue
        g = sub.groupby("date")[_MALARIA_TARGET].sum()
        g = g[g > 0]
        if g.empty:
            continue
        latest_val = float(g.iloc[-1])
        prior = g.iloc[-4:-1]
        trend = "stable"
        if len(prior) >= 1:
            base = float(prior.mean())
            if base > 0:
                if latest_val > base * 1.1:
                    trend = "rising"
                elif latest_val < base * 0.9:
                    trend = "falling"
        out[state] = {"latest_month": g.index[-1], "latest_value": latest_val, "trend": trend}
    return out


def internal_context_text(outbreak_disease: str, states: list[str]) -> str:
    """Human/LLM-readable block combining our internal data for the affected
    states, to inject into the outbreak planning prompt. Returns "" if we
    have nothing real to add (so the prompt simply omits the section)."""
    burden = malaria_burden_for_states(states or [])
    forecast = malaria_forecast_for_states(states or [])
    if not burden and not forecast:
        return ""
    lines = [
        "OUR INTERNAL SURVEILLANCE & FORECAST DATA (from FMOH's own per-LGA malaria "
        "warehouse + our SARIMAX forecast, for the SAME states this outbreak is hitting "
        "-- use this to quantify combined health-system load and the FORWARD outlook, "
        "since malaria and this outbreak's fever presentation compete for the same "
        "diagnostic and clinical capacity):"
    ]
    for state in (states or []):
        b = burden.get(state)
        fc = forecast.get(state)
        if not b and not fc:
            continue
        parts = [f"  - {state}:"]
        if b:
            parts.append(f"~{int(b['latest_value']):,} confirmed malaria cases in {b['latest_month']} "
                         f"(our latest actual data), recent trend {b['trend']};")
        if fc:
            parts.append(f"our forecast projects {int(fc['start_pred']):,} -> {int(fc['end_pred']):,} "
                         f"cases/month from {fc['from_month']} to {fc['to_month']} ({fc['direction']}).")
        lines.append(" ".join(parts))
    lines.append(
        "Note: we ALSO hold per-state/LGA forecasting dashboards for HIV, TB, hypertension, "
        "diabetes and several NTDs -- reference pulling those for these states for a fuller picture."
    )
    return "\n".join(lines)
