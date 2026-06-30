"""
Conditional time-series helpers — SARIMAX / ARIMA with EXOGENOUS regressors.

Instead of forecasting cases purely from their own past (univariate), these fit on
the target plus a small set of forecast-able drivers (testing volume, treatment
volume, rainfall, temperature) and forecast the future conditioned on those
drivers' own forecasts. This is what makes SARIMAX-X / ARIMAX differ from the
seasonal-naive baseline.
"""
import logging
import numpy as np, pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX
for _lg in ("prophet", "cmdstanpy", "prophet.models"):
    logging.getLogger(_lg).setLevel(logging.ERROR)


def _ymd(ym):
    return pd.Timestamp(year=ym // 12, month=ym % 12 + 1, day=1)


def prophet_forecast(y_by_ym, exog_by_ym, fc_yms):
    """Conditional Prophet: yearly-seasonal trend + the exogenous drivers added as
    extra regressors (so it forecasts conditioned on the driver forecasts)."""
    try:
        from prophet import Prophet
    except Exception:
        return None
    hist = sorted(pd.Index(y_by_ym.index))
    regs = [c for c in exog_by_ym.columns]
    dfh = pd.DataFrame({"ds": [_ymd(m) for m in hist],
                        "y": [float(pd.Series(y_by_ym).get(m, 0.0)) for m in hist]})
    Eh = exog_by_ym.reindex(hist)
    for c in regs:
        dfh[c] = Eh[c].astype(float).fillna(0.0).values
    try:
        m = Prophet(yearly_seasonality=True, weekly_seasonality=False, daily_seasonality=False,
                    uncertainty_samples=0)
        for c in regs:
            m.add_regressor(c)
        m.fit(dfh)
        dff = pd.DataFrame({"ds": [_ymd(ym) for ym in fc_yms]})
        Ef = exog_by_ym.reindex(fc_yms)
        for c in regs:
            dff[c] = Ef[c].astype(float).fillna(0.0).values
        fc = m.predict(dff)["yhat"].values
        return np.where(np.isfinite(fc), np.clip(fc, 0, None), 0.0)
    except Exception:
        return None

# exogenous drivers (column, how to aggregate across LGAs)
EXOG_COLS = [
    ("MAL - Malaria cases tested with RDT", "sum"),   # surveillance / testing volume
    ("ACT Given - Total", "sum"),                     # treatment volume
    ("rainfall_mm_day", "mean"),                       # climate driver
    ("temperature_mean_c", "mean"),                    # climate driver
]


def build_exog(df, cols=EXOG_COLS):
    """Exogenous matrix indexed by ym (sum for counts, mean for rates)."""
    parts = {}
    for c, agg in cols:
        if c in df.columns:
            g = df.groupby("ym")[c].sum() if agg == "sum" else df.groupby("ym")[c].mean()
            parts[c] = g
    return pd.DataFrame(parts)


def fit_forecast(y_by_ym, exog_by_ym, fc_yms, order, seasonal):
    """Fit SARIMAX/ARIMA with standardized exog and forecast over fc_yms.
    exog_by_ym must cover both the history and fc_yms (future exog forecasts)."""
    hist = sorted(pd.Index(y_by_ym.index))
    y = pd.Series(y_by_ym).reindex(hist).astype(float).fillna(0.0).values
    Eh = exog_by_ym.reindex(hist)
    Ef = exog_by_ym.reindex(fc_yms)
    mu, sd = Eh.mean(), Eh.std().replace(0, 1)
    Ehs = ((Eh - mu) / sd).fillna(0.0).values
    Efs = ((Ef - mu) / sd).fillna(0.0).values
    try:
        m = SARIMAX(y, exog=Ehs, order=order, seasonal_order=seasonal,
                    enforce_stationarity=False, enforce_invertibility=False).fit(disp=False)
        fc = np.asarray(m.forecast(len(fc_yms), exog=Efs), float)
        return np.where(np.isfinite(fc), np.clip(fc, 0, None), 0.0)
    except Exception:
        return None


def conditional_block(sub_panel, fc_yms, train_end, include_arimax=True):
    """Return {model_name: forecast_array} for a panel subset (one geography).
    sub_panel must contain ym, cases and the EXOG columns (history actual + future
    conditionally forecast)."""
    y_hist = sub_panel[sub_panel.ym <= train_end].groupby("ym")["cases"].sum()
    exog = build_exog(sub_panel)
    out = {}
    sx = fit_forecast(y_hist, exog, fc_yms, (1, 1, 1), (1, 1, 0, 12))
    if sx is not None:
        out["SARIMAX-X (conditional)"] = sx
    if include_arimax:
        ax = fit_forecast(y_hist, exog, fc_yms, (2, 1, 2), (0, 0, 0, 0))
        if ax is not None:
            out["ARIMAX (conditional)"] = ax
    return out
