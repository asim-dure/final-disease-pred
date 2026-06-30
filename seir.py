"""
Semi-mechanistic malaria transmission model (TSIR with climate forcing).

Derived from the Ross–Macdonald / SIR compartmental framework: for endemic malaria
the time-series-SIR (Finkenstädt & Grenfell) reconstruction reduces, under a roughly
constant endemic susceptible fraction, to

    log I_t = c + α·log I_{t-1} + β·log(suitability_t)

where suitability_t is the climate-driven transmission forcing (thermal suitability ×
rainfall factor) — a proxy for the Ross–Macdonald vectorial capacity / β(T,R). The
intercept c absorbs recovery + reporting; α is transmission persistence. It is fit by
least squares on the training window and forecast recursively (feeding predicted
incidence back), conditioned on the climate suitability forecast.
"""
import numpy as np


def suitability_series(sub_panel):
    """Monthly climate-transmission suitability per ym for a panel subset:
    mean over LGAs of thermal_suitability × rainfall-saturation factor."""
    p = sub_panel.copy()
    if "temp_suitability" in p.columns:
        suit = p["temp_suitability"]
    elif "temperature_mean_c" in p.columns:
        suit = np.exp(-((p["temperature_mean_c"] - 25.0) / 7.0) ** 2)
    else:
        suit = 1.0
    rain = p["rainfall_mm_day"] if "rainfall_mm_day" in p.columns else 0.0
    rain_f = rain / (rain + 5.0)
    p = p.assign(_suit=(suit * (0.3 + 0.7 * rain_f)))   # floor so suitability never 0
    return p.groupby("ym")["_suit"].mean().to_dict()


def tsir_forecast(cases_by_ym, suit_by_ym, fc_yms, train_end):
    """Fit log I_t = c + α·log I_{t-1} + β·log(suit_t) on the training window and
    forecast recursively over fc_yms."""
    hist = sorted([ym for ym in cases_by_ym if ym <= train_end])
    if len(hist) < 6:
        return None
    y = np.array([max(0.0, float(cases_by_ym[m])) for m in hist])
    ly = np.log1p(y)
    ls = np.log(np.clip([suit_by_ym.get(m, 1.0) for m in hist], 1e-3, None))
    Xr = np.column_stack([np.ones(len(hist) - 1), ly[:-1], ls[1:]])
    yr = ly[1:]
    try:
        coef, *_ = np.linalg.lstsq(Xr, yr, rcond=None)
    except Exception:
        return None
    c, a, b = coef
    a = float(np.clip(a, 0.0, 1.05))           # keep transmission persistence stable
    cap = np.log1p(5e6)
    out, prev = [], ly[-1]
    for ym in fc_yms:
        s = np.log(max(1e-3, suit_by_ym.get(ym, 1.0)))
        nxt = min(c + a * prev + b * s, cap)
        out.append(float(np.expm1(nxt)))
        prev = nxt
    return np.clip(np.asarray(out), 0, None)


def seir_block(sub_panel, fc_yms, train_end):
    """Return {'SEIR/TSIR (mechanistic)': forecast} for a panel subset, or {}."""
    y_hist = sub_panel[sub_panel.ym <= train_end].groupby("ym")["cases"].sum()
    suit = suitability_series(sub_panel)
    fc = tsir_forecast(y_hist.to_dict(), suit, fc_yms, train_end)
    return {"SEIR/TSIR (mechanistic)": fc} if fc is not None else {}
