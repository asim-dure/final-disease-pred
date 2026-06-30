"""
Comprehensive forecasting model suite — ML + Deep Learning + classical
Time-Series — all validated on the held-out 2026 Q1, with full metric batteries.
A top-3 ensemble champion then produces the recursive forecast to 2028.

Outputs:
  model_leaderboard.json   (regression + DL + time-series + classification metrics,
                            feature list/doc, importances)
  forecast_lga.parquet/csv, forecast_state.csv, forecast_national.csv  (champion)
"""
import json, time, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import features as F
from features import KEYS, FEATURES, FEATURE_DOC, VAL_MONTHS, TRAIN_END, FC_END
from metrics_util import reg_metrics, clf_metrics

from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge, Lasso, ElasticNet, LogisticRegression, BayesianRidge
from sklearn.neighbors import KNeighborsRegressor
from sklearn.svm import SVR
from sklearn.ensemble import (RandomForestRegressor, ExtraTreesRegressor,
                              GradientBoostingRegressor, HistGradientBoostingRegressor,
                              RandomForestClassifier, HistGradientBoostingClassifier)
import xgboost as xgb
import lightgbm as lgb
from catboost import CatBoostRegressor, CatBoostClassifier
import torch, torch.nn as nn

t0 = time.time()
np.random.seed(42); torch.manual_seed(42)

panel = F.load_panel()
feat = F.build_features(panel)
train = feat[(feat.ym <= TRAIN_END) & feat["cases"].notna()].dropna(subset=["lag3"]).copy()
Xtr = F.Xmat(train); ytr = np.log1p(train["cases"].clip(lower=0))
print(f"train rows={len(train):,}  features={len(FEATURES)}  {time.time()-t0:.0f}s", flush=True)

# actuals for scoring 2026 Q1
actual = panel[panel.ym.isin(VAL_MONTHS)][KEYS + ["ym", "cases", "snaive"]].copy()


# ----------------------------------------------------------------- recursion
def recursive_validate(predict_month):
    """True multi-step recursion: predictions feed forward as lags."""
    work = panel.copy()
    preds = []
    for vm in VAL_MONTHS:
        pm = predict_month(work, vm)            # Series indexed like rows of work[ym==vm]
        idx = work.index[work.ym == vm]
        work.loc[idx, "cases"] = pm.values
        out = work.loc[idx, KEYS + ["ym"]].copy(); out["pred"] = pm.values
        preds.append(out)
    return pd.concat(preds)


def _cap(p):
    return np.clip(np.nan_to_num(p, nan=0.0, posinf=CAP, neginf=0.0), 0, CAP)


def tab_predict_fn(model):
    def f(work, ym):
        fw = F.build_features(work)
        rows = fw[fw.ym == ym]
        p = _cap(np.expm1(model.predict(F.Xmat(rows))))
        return pd.Series(p, index=rows.index)
    return f


def score(pred_df, name, kind):
    m = pred_df.merge(actual, on=KEYS + ["ym"])
    lga = reg_metrics(m["cases"], m["pred"])
    nat = m.groupby("ym").agg(a=("cases", "sum"), p=("pred", "sum"))
    natm = reg_metrics(nat["a"], nat["p"])
    return {"model": name, "kind": kind, "lga": lga, "national": natm}


results = []
preds_store = {}   # name -> pred_df (for ensembling)

# ----------------------------------------------------------------- ML models
CAP = 2_000_000   # per-LGA-month ceiling — keeps recursion numerically stable

# Linear models (Ridge/Lasso/ElasticNet) are excluded: with the full 114-indicator
# panel they are multicollinear and extrapolate explosively in log-space recursion.
TAB_MODELS = {
    "k-Nearest Neighbors":   make_pipeline(StandardScaler(), KNeighborsRegressor(n_neighbors=15)),
    "Random Forest":         RandomForestRegressor(n_estimators=200, max_depth=14, n_jobs=-1, random_state=42),
    "Extra Trees":           ExtraTreesRegressor(n_estimators=200, max_depth=16, n_jobs=-1, random_state=42),
    "Gradient Boosting":     GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.05, random_state=42),
    "HistGradientBoosting":  HistGradientBoostingRegressor(max_iter=500, learning_rate=0.05, max_depth=7, random_state=42),
    "XGBoost":               xgb.XGBRegressor(n_estimators=700, max_depth=6, learning_rate=0.03, subsample=0.85,
                                              colsample_bytree=0.8, min_child_weight=5, reg_lambda=1.5,
                                              reg_alpha=0.2, tree_method="hist", random_state=42, n_jobs=0),
    "LightGBM":              lgb.LGBMRegressor(n_estimators=700, max_depth=-1, num_leaves=48, learning_rate=0.03,
                                              subsample=0.85, colsample_bytree=0.8, reg_lambda=1.5,
                                              random_state=42, n_jobs=-1, verbose=-1),
    "CatBoost":              CatBoostRegressor(iterations=600, depth=7, learning_rate=0.04, l2_leaf_reg=3.0,
                                              random_seed=42, verbose=0),
    "Support Vector (RBF)":  make_pipeline(StandardScaler(), SVR(kernel="rbf", C=10.0, gamma="scale", epsilon=0.05, cache_size=600)),
    "Bayesian Ridge":        make_pipeline(StandardScaler(), BayesianRidge()),
}
SUBSAMPLE = {"Support Vector (RBF)": 9000}   # SVR is O(n^2); fit on a representative subsample
if not F.AFTER:                              # SVR + Bayesian Ridge are 'after'-only additions
    TAB_MODELS.pop("Support Vector (RBF)", None)
    TAB_MODELS.pop("Bayesian Ridge", None)

importances = {}
for name, model in TAB_MODELS.items():
    tt = time.time()
    if name in SUBSAMPLE and len(Xtr) > SUBSAMPLE[name]:
        si = np.random.RandomState(42).choice(len(Xtr), SUBSAMPLE[name], replace=False)
        model.fit(Xtr.iloc[si], ytr.iloc[si])
    else:
        model.fit(Xtr, ytr)
    pred_df = recursive_validate(tab_predict_fn(model))
    preds_store[name] = pred_df
    r = score(pred_df, name, "Machine Learning")
    results.append(r)
    # importances where available
    est = model.steps[-1][1] if hasattr(model, "steps") else model
    if hasattr(est, "feature_importances_"):
        imp = np.asarray(est.feature_importances_, float)
        importances[name] = {f: round(float(v), 5) for f, v in zip(FEATURES, imp / (imp.sum() + 1e-9))}
    elif hasattr(est, "coef_"):
        c = np.abs(np.asarray(est.coef_, float)).ravel()
        importances[name] = {f: round(float(v), 5) for f, v in zip(FEATURES, c / (c.sum() + 1e-9))}
    print(f"  [ML] {name:22s} LGA RMSE={r['lga']['RMSE']:.0f} MAPE={r['lga']['MAPE_pct']} ({time.time()-tt:.0f}s)", flush=True)


# ----------------------------------------------------------------- Deep Learning
dev = "cpu"
scaler_mean = Xtr.mean().values; scaler_std = Xtr.std().replace(0, 1).values


class MLP(nn.Module):
    def __init__(self, d):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d, 128), nn.ReLU(), nn.Dropout(0.1),
                                 nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))
    def forward(self, x): return self.net(x).squeeze(-1)


def train_mlp():
    Xs = ((Xtr.values - scaler_mean) / scaler_std).astype(np.float32)
    yt = ytr.values.astype(np.float32)
    Xt = torch.tensor(Xs); yy = torch.tensor(yt)
    net = MLP(Xtr.shape[1]); opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    lossf = nn.SmoothL1Loss()
    ds = torch.utils.data.TensorDataset(Xt, yy)
    dl = torch.utils.data.DataLoader(ds, batch_size=2048, shuffle=True)
    net.train()
    for ep in range(60):
        for xb, yb in dl:
            opt.zero_grad(); loss = lossf(net(xb), yb); loss.backward(); opt.step()
    net.eval(); return net


def mlp_predict_fn(net):
    def f(work, ym):
        fw = F.build_features(work); rows = fw[fw.ym == ym]
        Xs = ((F.Xmat(rows).values - scaler_mean) / scaler_std).astype(np.float32)
        with torch.no_grad():
            p = _cap(np.expm1(net(torch.tensor(Xs)).numpy()))
        return pd.Series(p, index=rows.index)
    return f


tt = time.time()
mlp = train_mlp()
pred_df = recursive_validate(mlp_predict_fn(mlp)); preds_store["MLP (PyTorch)"] = pred_df
results.append(score(pred_df, "MLP Neural Net (PyTorch)", "Deep Learning"))
print(f"  [DL] MLP                    LGA RMSE={results[-1]['lga']['RMSE']:.0f} ({time.time()-tt:.0f}s)", flush=True)

# --- sequence models: LSTM / GRU on per-LGA windows ---
SEQ_FEATS = ["logc", "rainfall_mm_day", "temperature_mean_c", "humidity_pct", "mom_sin", "mom_cos"]
WIN = 12


def make_seq_frame(work):
    p = work.copy()
    p["logc"] = np.log1p(p["cases"].clip(lower=0))
    p["mom_sin"] = np.sin(2 * np.pi * p["month"] / 12); p["mom_cos"] = np.cos(2 * np.pi * p["month"] / 12)
    return p


def build_seq_training():
    p = make_seq_frame(panel)
    p = p.sort_values(KEYS + ["ym"])
    Xs, ys = [], []
    arrs = {k: p.pivot_table(index=KEYS, columns="ym", values=k) for k in SEQ_FEATS}
    yms = sorted(p["ym"].unique())
    train_yms = [m for m in yms if m <= TRAIN_END]
    idx = arrs["logc"].index
    for tgt in train_yms:
        if tgt - WIN < min(yms): continue
        win_cols = list(range(tgt - WIN, tgt))
        if any(c not in arrs["logc"].columns for c in win_cols) or tgt not in arrs["logc"].columns:
            continue
        block = np.stack([arrs[k][win_cols].values for k in SEQ_FEATS], axis=-1)  # (n,WIN,C)
        y = arrs["logc"][tgt].values
        good = ~np.isnan(block).any(axis=(1, 2)) & ~np.isnan(y)
        Xs.append(block[good]); ys.append(y[good])
    return (np.concatenate(Xs).astype(np.float32), np.concatenate(ys).astype(np.float32), idx, arrs)


class RNN(nn.Module):
    def __init__(self, c, kind="lstm"):
        super().__init__()
        rnn = nn.LSTM if kind == "lstm" else nn.GRU
        self.rnn = rnn(c, 48, batch_first=True)
        self.head = nn.Sequential(nn.Linear(48, 24), nn.ReLU(), nn.Linear(24, 1))
    def forward(self, x):
        o, _ = self.rnn(x); return self.head(o[:, -1, :]).squeeze(-1)


Xseq, yseq, seq_idx, _ = build_seq_training()
sm = Xseq.reshape(-1, Xseq.shape[-1]).mean(0); ss = Xseq.reshape(-1, Xseq.shape[-1]).std(0); ss[ss == 0] = 1


def train_rnn(kind):
    Xn = ((Xseq - sm) / ss).astype(np.float32)
    net = RNN(Xseq.shape[-1], kind); opt = torch.optim.Adam(net.parameters(), lr=3e-3)
    lossf = nn.SmoothL1Loss()
    ds = torch.utils.data.TensorDataset(torch.tensor(Xn), torch.tensor(yseq))
    dl = torch.utils.data.DataLoader(ds, batch_size=1024, shuffle=True)
    net.train()
    for ep in range(25):
        for xb, yb in dl:
            opt.zero_grad(); loss = lossf(net(xb), yb); loss.backward(); opt.step()
    net.eval(); return net


def rnn_predict_fn(net):
    def f(work, ym):
        p = make_seq_frame(work)
        arrs = {k: p.pivot_table(index=KEYS, columns="ym", values=k) for k in SEQ_FEATS}
        win_cols = list(range(ym - WIN, ym))
        block = np.stack([arrs[k][win_cols].values for k in SEQ_FEATS], axis=-1).astype(np.float32)
        block = np.nan_to_num((block - sm) / ss)
        with torch.no_grad():
            out = _cap(np.expm1(net(torch.tensor(block)).numpy()))
        ser = pd.Series(out, index=arrs["logc"].index)  # index = (state,lga)
        rows = work[work.ym == ym]
        return pd.Series(ser.loc[list(zip(rows["state"], rows["lga"]))].values, index=rows.index)
    return f


for kind, label in [("lstm", "LSTM (PyTorch)"), ("gru", "GRU (PyTorch)")]:
    tt = time.time()
    net = train_rnn(kind)
    pred_df = recursive_validate(rnn_predict_fn(net)); preds_store[label] = pred_df
    results.append(score(pred_df, label, "Deep Learning"))
    print(f"  [DL] {label:22s} LGA RMSE={results[-1]['lga']['RMSE']:.0f} ({time.time()-tt:.0f}s)", flush=True)

# Transformer (self-attention over the 12-month window) — after-only addition
if F.AFTER:
    class TransformerSeq(nn.Module):
        def __init__(self, c, d=48, heads=4, layers=2):
            super().__init__()
            self.proj = nn.Linear(c, d)
            self.pos = nn.Parameter(torch.randn(1, WIN, d) * 0.02)
            enc = nn.TransformerEncoderLayer(d_model=d, nhead=heads, dim_feedforward=96,
                                             dropout=0.1, batch_first=True)
            self.tr = nn.TransformerEncoder(enc, num_layers=layers)
            self.head = nn.Sequential(nn.Linear(d, 24), nn.ReLU(), nn.Linear(24, 1))
        def forward(self, x):
            h = self.tr(self.proj(x) + self.pos)
            return self.head(h[:, -1, :]).squeeze(-1)

    def train_transformer():
        Xn = ((Xseq - sm) / ss).astype(np.float32)
        net = TransformerSeq(Xseq.shape[-1]); opt = torch.optim.Adam(net.parameters(), lr=2e-3)
        lossf = nn.SmoothL1Loss()
        dl = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(torch.tensor(Xn), torch.tensor(yseq)),
                                         batch_size=1024, shuffle=True)
        net.train()
        for ep in range(25):
            for xb, yb in dl:
                opt.zero_grad(); loss = lossf(net(xb), yb); loss.backward(); opt.step()
        net.eval(); return net

    tt = time.time()
    tnet = train_transformer()
    pred_df = recursive_validate(rnn_predict_fn(tnet)); preds_store["Transformer (PyTorch)"] = pred_df
    results.append(score(pred_df, "Transformer (PyTorch)", "Deep Learning"))
    print(f"  [DL] {'Transformer':22s} LGA RMSE={results[-1]['lga']['RMSE']:.0f} ({time.time()-tt:.0f}s)", flush=True)


# ----------------------------------------------------------------- Time-series (national)
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.holtwinters import ExponentialSmoothing

import ts_util
nat_hist = (panel[panel.ym <= TRAIN_END].groupby("ym")["cases"].sum())
nat_act = panel[panel.ym.isin(VAL_MONTHS)].groupby("ym")["cases"].sum()
ts_series = nat_hist.values.astype(float)

ts_results = []
# conditional SARIMAX-X / ARIMAX (use forecast-able drivers as exogenous regressors)
for nm, fc in ts_util.conditional_block(panel, list(VAL_MONTHS), TRAIN_END, include_arimax=True).items():
    ts_results.append({"model": nm, "kind": "Time Series", "national": reg_metrics(nat_act.values, fc)})
# conditional Prophet + semi-mechanistic SEIR/TSIR (after-only additions)
if F.AFTER:
    _pf = ts_util.prophet_forecast(nat_hist, ts_util.build_exog(panel), list(VAL_MONTHS))
    if _pf is not None:
        ts_results.append({"model": "Prophet (conditional)", "kind": "Time Series",
                           "national": reg_metrics(nat_act.values, _pf)})
    import seir
    for nm, fc in seir.seir_block(panel, list(VAL_MONTHS), TRAIN_END).items():
        ts_results.append({"model": nm, "kind": "Time Series", "national": reg_metrics(nat_act.values, fc)})
try:
    hw = ExponentialSmoothing(ts_series, trend="add", seasonal="add", seasonal_periods=12).fit()
    ts_results.append({"model": "Holt-Winters (ETS)", "kind": "Time Series",
                       "national": reg_metrics(nat_act.values, hw.forecast(3))})
except Exception as e:
    print("HW failed", e)
sn = panel[panel.ym.isin(VAL_MONTHS)].groupby("ym")["snaive"].sum()
ts_results.append({"model": "Seasonal Naive", "kind": "Time Series",
                   "national": reg_metrics(nat_act.values, sn.values)})
for r in ts_results:
    print(f"  [TS] {r['model']:26s} national RMSE={r['national']['RMSE']:.0f} MAPE={r['national']['MAPE_pct']}", flush=True)


# ----------------------------------------------------------------- Classification (hotspot)
# label: LGA-month is a HOTSPOT if monthly incidence/1000 is in the top tercile of the
# training distribution. Time-based holdout: train <=2025-09, test = 2025-10..2026-03.
panel["inc"] = panel["cases"] / panel["population"] * 1000
thr = panel[panel.ym <= TRAIN_END]["inc"].quantile(0.66)
cf = F.build_features(panel).copy()
cf["inc"] = panel["inc"].values
cf["hot"] = (cf["inc"] >= thr).astype(int)
clf_train = cf[(cf.ym <= 2025 * 12 + 8) & cf["cases"].notna()].dropna(subset=["lag3"])
clf_test = cf[(cf.ym >= 2025 * 12 + 9) & (cf.ym <= VAL_MONTHS[-1]) & cf["cases"].notna()].dropna(subset=["lag3"])
Xc, yc = F.Xmat(clf_train), clf_train["hot"]
Xct, yct = F.Xmat(clf_test), clf_test["hot"]

CLF = {
    "Logistic Regression":   make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, C=1.0)),
    "Random Forest":         RandomForestClassifier(n_estimators=250, max_depth=14, n_jobs=-1, random_state=42),
    "HistGradientBoosting":  HistGradientBoostingClassifier(max_iter=400, learning_rate=0.05, random_state=42),
    "XGBoost":               xgb.XGBClassifier(n_estimators=500, max_depth=6, learning_rate=0.04, subsample=0.85,
                                               colsample_bytree=0.8, eval_metric="logloss", random_state=42, n_jobs=0),
    "LightGBM":              lgb.LGBMClassifier(n_estimators=500, num_leaves=48, learning_rate=0.04,
                                               random_state=42, n_jobs=-1, verbose=-1),
    "CatBoost":              CatBoostClassifier(iterations=400, depth=6, learning_rate=0.05, random_seed=42, verbose=0),
}
clf_results = []
for name, m in CLF.items():
    m.fit(Xc, yc)
    prob = m.predict_proba(Xct)[:, 1]
    clf_results.append({"model": name, "metrics": clf_metrics(yct, prob)})
    print(f"  [CLF] {name:22s} AUC={clf_results[-1]['metrics']['ROC_AUC']} F1={clf_results[-1]['metrics']['F1']}", flush=True)


# ----------------------------------------------------------------- Ensemble champion
reg_sorted = sorted([r for r in results], key=lambda r: r["lga"]["RMSE"])
top3 = [r["model"] for r in reg_sorted[:3]]
# map display names back to preds_store keys
key_for = {"MLP Neural Net (PyTorch)": "MLP (PyTorch)"}
ens_keys = [key_for.get(n, n) for n in top3]
ens = preds_store[ens_keys[0]][KEYS + ["ym"]].copy()
ens["pred"] = np.mean([preds_store[k].set_index(KEYS + ["ym"]).loc[
    list(zip(ens["state"], ens["lga"], ens["ym"]))]["pred"].values for k in ens_keys], axis=0)
ens_score = score(ens, f"Ensemble (top-3: {', '.join(top3)})", "Ensemble")
results.append(ens_score)
print(f"\nTop-3 = {top3}  -> Ensemble LGA RMSE={ens_score['lga']['RMSE']:.0f} MAPE={ens_score['lga']['MAPE_pct']}", flush=True)

# dump every model's per-LGA 2026 Q1 predictions (for the Model Lab actual-vs-forecast)
ml_dl_dump = {"test_yms": list(VAL_MONTHS), "models": {}}
for nm, pdf in preds_store.items():
    kind = "Deep Learning" if "PyTorch" in nm else "Machine Learning"
    piv = {}
    for (s, l), g in pdf.groupby(KEYS):
        gg = g.set_index("ym")["pred"]
        piv[f"{s}|||{l}"] = [int(round(float(gg.get(vm, 0) or 0))) for vm in VAL_MONTHS]
    ml_dl_dump["models"][nm] = {"kind": kind, "lga": piv}
# ensemble too
piv = {}
for (s, l), g in ens.groupby(KEYS):
    gg = g.set_index("ym")["pred"]
    piv[f"{s}|||{l}"] = [int(round(float(gg.get(vm, 0) or 0))) for vm in VAL_MONTHS]
ml_dl_dump["models"][f"Ensemble (top-3)"] = {"kind": "Ensemble", "lga": piv}
json.dump(ml_dl_dump, open("avp_ml_dl.json", "w"))
print(f"Saved avp_ml_dl.json ({len(ml_dl_dump['models'])} models)", flush=True)


# ----------------------------------------------------------------- Recursive forecast to 2028 (ensemble of top-3 tabular)
# refit champions on train through 2026-03; recursive-average forecast
TAB_REFIT = {n: TAB_MODELS[n] for n in top3 if n in TAB_MODELS}
if not TAB_REFIT:   # ensure at least the best tabular
    best_tab = next(r["model"] for r in reg_sorted if r["model"] in TAB_MODELS)
    TAB_REFIT = {best_tab: TAB_MODELS[best_tab]}
feat_all = F.build_features(panel)
tr_all = feat_all[(feat_all.ym <= VAL_MONTHS[-1]) & feat_all["cases"].notna()].dropna(subset=["lag3"])
Xall, yall = F.Xmat(tr_all), np.log1p(tr_all["cases"].clip(lower=0))
fitted = []
for n, m in TAB_REFIT.items():
    m.fit(Xall, yall); fitted.append(m)

work = panel.copy()
for fm in range(VAL_MONTHS[-1] + 1, FC_END + 1):
    fw = F.build_features(work); rows = fw[fw.ym == fm]
    ps = np.mean([_cap(np.expm1(mm.predict(F.Xmat(rows)))) for mm in fitted], axis=0)
    work.loc[work.ym == fm, "cases"] = ps

out = work[KEYS + ["ym", "year", "month", "cases", "population"]].copy()
out["is_forecast"] = out["ym"] > VAL_MONTHS[-1]
out = out.rename(columns={"cases": "cases_pred"})
act2 = panel[KEYS + ["ym"]].merge(
    pd.read_parquet("agg_lga_pop.parquet").assign(ym=lambda d: d.year * 12 + d.month - 1)[KEYS + ["ym", F.TARGET]],
    on=KEYS + ["ym"], how="left").rename(columns={F.TARGET: "cases_actual"})
out = out.merge(act2, on=KEYS + ["ym"], how="left")
out["cases"] = np.where(out["is_forecast"], out["cases_pred"], out["cases_actual"])
out.to_parquet("forecast_lga.parquet", index=False)
out.to_csv("forecast_lga.csv", index=False)
out.groupby(["state", "ym", "year", "month", "is_forecast"], as_index=False).agg(
    cases=("cases", "sum"), cases_pred=("cases_pred", "sum"),
    cases_actual=("cases_actual", "sum"), population=("population", "sum")).to_csv("forecast_state.csv", index=False)
out.groupby(["ym", "year", "month", "is_forecast"], as_index=False).agg(
    cases=("cases", "sum"), population=("population", "sum")).to_csv("forecast_national.csv", index=False)

ann = out.groupby("year")["cases"].sum()
print("\nCHAMPION forecast national annual:\n", ann.round(0).to_string(), flush=True)

# ----------------------------------------------------------------- save leaderboard
leaderboard = {
    "regression": sorted(results, key=lambda r: r["lga"]["RMSE"] if "lga" in r else 1e18),
    "time_series": ts_results,
    "classification": {"label_threshold_inc_per_1000": round(float(thr), 2),
                       "test_window": "2025-10 .. 2026-03", "models": clf_results},
    "features": [{"name": f, "doc": FEATURE_DOC.get(f, "")} for f in FEATURES],
    "feature_selection": json.load(open("selected_features.json", encoding="utf-8")),
    "importances": importances,
    "champion": ens_score["model"],
    "champion_kind": "Ensemble (top-3 by validation RMSE)",
    "ensemble_members": top3,
    "validation_window": "2026-01 .. 2026-03 (recursive, held out)",
    "n_models": len(results) + len(ts_results) + len(clf_results),
    "national_annual": {int(k): int(v) for k, v in ann.items()},
}
json.dump(leaderboard, open("model_leaderboard.json", "w"), indent=2)
print(f"\nSaved model_leaderboard.json · {leaderboard['n_models']} models · {time.time()-t0:.0f}s total", flush=True)
