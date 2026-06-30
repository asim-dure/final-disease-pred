"""
Multi-model forecast trajectories (2026-01 .. 2030-12) for the overlay pickers
in the National Overview, Geographic Explorer and Forecast views.

Each global model is trained on the complete 2023-2025 window and recursively
forecast month-by-month to 2030 at LGA level, then aggregated to national / state
/ LGA. Classical time-series models are fit on the aggregated national & state
series directly. Output: mm_national.json, mm_states.json, mm_lgas.json.
"""
import json, time, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
import features as F
from features import KEYS, FEATURES, TRAIN_END
import xgboost as xgb
import lightgbm as lgb
from catboost import CatBoostRegressor
from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.linear_model import Ridge, BayesianRidge
from sklearn.svm import SVR
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
import torch, torch.nn as nn
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.holtwinters import ExponentialSmoothing

t0 = time.time(); torch.manual_seed(42); np.random.seed(42)
FC_START = 2026 * 12 + 0
FC_END = 2030 * 12 + 11
FC_YMS = list(range(FC_START, FC_END + 1))               # 60 months
fc_dates = [f"{m//12}-{m%12+1:02d}" for m in FC_YMS]

panel = F.load_panel()
feat = F.build_features(panel)
train = feat[(feat.ym <= TRAIN_END) & feat["cases"].notna()].dropna(subset=["lag3"]).copy()
X, y = F.Xmat(train), np.log1p(train["cases"].clip(lower=0))
print(f"train {len(train):,} rows  {time.time()-t0:.0f}s", flush=True)

# ---- tabular models ----
TAB = {
    "XGBoost": xgb.XGBRegressor(n_estimators=700, max_depth=6, learning_rate=0.03, subsample=0.85,
                                colsample_bytree=0.8, min_child_weight=5, reg_lambda=1.5, reg_alpha=0.2,
                                tree_method="hist", random_state=42, n_jobs=0),
    "LightGBM": lgb.LGBMRegressor(n_estimators=700, num_leaves=48, learning_rate=0.03, subsample=0.85,
                                  colsample_bytree=0.8, reg_lambda=1.5, random_state=42, n_jobs=-1, verbose=-1),
    "CatBoost": CatBoostRegressor(iterations=600, depth=7, learning_rate=0.04, l2_leaf_reg=3.0, random_seed=42, verbose=0),
    "Random Forest": RandomForestRegressor(n_estimators=200, max_depth=14, n_jobs=-1, random_state=42),
    "Extra Trees": ExtraTreesRegressor(n_estimators=200, max_depth=16, n_jobs=-1, random_state=42),
    "HistGradientBoosting": HistGradientBoostingRegressor(max_iter=500, learning_rate=0.05, max_depth=7, random_state=42),
    "Support Vector (RBF)": make_pipeline(StandardScaler(), SVR(kernel="rbf", C=10.0, gamma="scale", epsilon=0.05, cache_size=600)),
    "Bayesian Ridge": make_pipeline(StandardScaler(), BayesianRidge()),
}
SUBSAMPLE = {"Support Vector (RBF)": 9000}
if not F.AFTER:
    TAB.pop("Support Vector (RBF)", None); TAB.pop("Bayesian Ridge", None)
for nm, m in TAB.items():
    if nm in SUBSAMPLE and len(X) > SUBSAMPLE[nm]:
        si = np.random.RandomState(42).choice(len(X), SUBSAMPLE[nm], replace=False)
        m.fit(X.iloc[si], y.iloc[si])
    else:
        m.fit(X, y)
print(f"tabular fit {time.time()-t0:.0f}s", flush=True)

# storage: model -> DataFrame[state,lga,ym,value]
traj = {}

CAP = 2_000_000   # per-LGA-month ceiling — prevents linear models exploding in recursion

def recursive_forecast(predict_month, name):
    work = panel.copy()
    rows_out = []
    for fm in FC_YMS:
        pm = predict_month(work, fm).replace([np.inf, -np.inf], np.nan).fillna(0).clip(0, CAP)
        idx = work.index[work.ym == fm]
        work.loc[idx, "cases"] = pm.values
        rows_out.append(work.loc[idx, KEYS + ["ym"]].assign(value=pm.values))
    traj[name] = pd.concat(rows_out)
    print(f"  forecast {name:22s} {time.time()-t0:.0f}s", flush=True)


def safe_ints(vals):
    out = []
    for v in vals:
        if v is None or not np.isfinite(v):
            out.append(0)
        else:
            out.append(int(round(min(max(v, 0), CAP * 1000))))
    return out

def tab_fn(model):
    def f(work, ym):
        fw = F.build_features(work); r = fw[fw.ym == ym]
        return pd.Series(np.expm1(model.predict(F.Xmat(r))).clip(min=0), index=r.index)
    return f

for nm, m in TAB.items():
    recursive_forecast(tab_fn(m), nm)

# ensemble (top-3 by the validation: XGBoost, Extra Trees, Random Forest)
ens_members = ["XGBoost", "Extra Trees", "Random Forest"]
e = traj[ens_members[0]][KEYS + ["ym"]].copy()
e["value"] = np.mean([traj[k].set_index(KEYS + ["ym"]).loc[list(zip(e.state, e.lga, e.ym))]["value"].values
                      for k in ens_members], axis=0)
traj["Ensemble (top-3)"] = e

# ---- deep learning ----
sm = X.mean().values; ss = X.std().replace(0, 1).values
class MLP(nn.Module):
    def __init__(s, d):
        super().__init__(); s.net = nn.Sequential(nn.Linear(d, 128), nn.ReLU(), nn.Dropout(0.1), nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))
    def forward(s, x): return s.net(x).squeeze(-1)
def train_mlp():
    Xs = ((X.values - sm) / ss).astype(np.float32)
    net = MLP(X.shape[1]); opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5); lf = nn.SmoothL1Loss()
    dl = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(torch.tensor(Xs), torch.tensor(y.values.astype(np.float32))), batch_size=2048, shuffle=True)
    net.train()
    for _ in range(60):
        for xb, yb in dl: opt.zero_grad(); lf(net(xb), yb).backward(); opt.step()
    net.eval(); return net
mlp = train_mlp()
def mlp_fn(net):
    def f(work, ym):
        fw = F.build_features(work); r = fw[fw.ym == ym]
        Xs = ((F.Xmat(r).values - sm) / ss).astype(np.float32)
        with torch.no_grad(): p = np.expm1(net(torch.tensor(Xs)).numpy()).clip(min=0)
        return pd.Series(p, index=r.index)
    return f
recursive_forecast(mlp_fn(mlp), "MLP (PyTorch)")

SEQF = ["logc", "rainfall_mm_day", "temperature_mean_c", "humidity_pct", "mom_sin", "mom_cos"]; WIN = 12
def seq_frame(w):
    p = w.copy(); p["logc"] = np.log1p(p["cases"].clip(lower=0))
    p["mom_sin"] = np.sin(2*np.pi*p["month"]/12); p["mom_cos"] = np.cos(2*np.pi*p["month"]/12); return p
def build_seq():
    p = seq_frame(panel).sort_values(KEYS + ["ym"]); arrs = {k: p.pivot_table(index=KEYS, columns="ym", values=k) for k in SEQF}
    Xs, ys = [], []; yms = sorted(p.ym.unique())
    for tgt in [m for m in yms if m <= TRAIN_END]:
        cols = list(range(tgt - WIN, tgt))
        if any(c not in arrs["logc"].columns for c in cols) or tgt not in arrs["logc"].columns: continue
        block = np.stack([arrs[k][cols].values for k in SEQF], axis=-1); yy = arrs["logc"][tgt].values
        good = ~np.isnan(block).any(axis=(1, 2)) & ~np.isnan(yy); Xs.append(block[good]); ys.append(yy[good])
    return np.concatenate(Xs).astype(np.float32), np.concatenate(ys).astype(np.float32)
Xseq, yseq = build_seq(); sqm = Xseq.reshape(-1, Xseq.shape[-1]).mean(0); sqs = Xseq.reshape(-1, Xseq.shape[-1]).std(0); sqs[sqs == 0] = 1
class RNN(nn.Module):
    def __init__(s, c, kind): super().__init__(); s.rnn = (nn.LSTM if kind == "lstm" else nn.GRU)(c, 48, batch_first=True); s.h = nn.Sequential(nn.Linear(48, 24), nn.ReLU(), nn.Linear(24, 1))
    def forward(s, x): o, _ = s.rnn(x); return s.h(o[:, -1, :]).squeeze(-1)
def train_rnn(kind):
    Xn = ((Xseq - sqm) / sqs).astype(np.float32); net = RNN(Xseq.shape[-1], kind); opt = torch.optim.Adam(net.parameters(), lr=3e-3); lf = nn.SmoothL1Loss()
    dl = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(torch.tensor(Xn), torch.tensor(yseq)), batch_size=1024, shuffle=True)
    net.train()
    for _ in range(25):
        for xb, yb in dl: opt.zero_grad(); lf(net(xb), yb).backward(); opt.step()
    net.eval(); return net
def rnn_fn(net):
    def f(work, ym):
        p = seq_frame(work); arrs = {k: p.pivot_table(index=KEYS, columns="ym", values=k) for k in SEQF}
        cols = list(range(ym - WIN, ym)); block = np.stack([arrs[k][cols].values for k in SEQF], axis=-1).astype(np.float32)
        block = np.nan_to_num((block - sqm) / sqs)
        with torch.no_grad(): out = np.expm1(net(torch.tensor(block)).numpy()).clip(min=0)
        ser = pd.Series(out, index=arrs["logc"].index); r = work[work.ym == ym]
        return pd.Series(ser.loc[list(zip(r.state, r.lga))].values, index=r.index)
    return f
for kind, label in [("gru", "GRU (PyTorch)"), ("lstm", "LSTM (PyTorch)")]:
    recursive_forecast(rnn_fn(train_rnn(kind)), label)

if F.AFTER:
    class TransformerSeq(nn.Module):
        def __init__(s, c, d=48, heads=4, layers=2):
            super().__init__(); s.proj = nn.Linear(c, d); s.pos = nn.Parameter(torch.randn(1, WIN, d) * 0.02)
            enc = nn.TransformerEncoderLayer(d_model=d, nhead=heads, dim_feedforward=96, dropout=0.1, batch_first=True)
            s.tr = nn.TransformerEncoder(enc, num_layers=layers); s.h = nn.Sequential(nn.Linear(d, 24), nn.ReLU(), nn.Linear(24, 1))
        def forward(s, x): return s.h(s.tr(s.proj(x) + s.pos)[:, -1, :]).squeeze(-1)
    def train_tr():
        Xn = ((Xseq - sqm) / sqs).astype(np.float32); net = TransformerSeq(Xseq.shape[-1]); opt = torch.optim.Adam(net.parameters(), lr=2e-3); lf = nn.SmoothL1Loss()
        dl = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(torch.tensor(Xn), torch.tensor(yseq)), batch_size=1024, shuffle=True)
        net.train()
        for _ in range(25):
            for xb, yb in dl: opt.zero_grad(); lf(net(xb), yb).backward(); opt.step()
        net.eval(); return net
    recursive_forecast(rnn_fn(train_tr()), "Transformer (PyTorch)")

# ---- aggregate to national / state / lga ----
GLOBAL_MODELS = list(traj.keys())
nat = {"dates": fc_dates, "models": {}}
states_out = {}
lgas_out = {}
for nm, df in traj.items():
    g = df.groupby("ym")["value"].sum().reindex(FC_YMS)
    nat["models"][nm] = safe_ints(g.values)
    for s, sg in df.groupby("state"):
        gg = sg.groupby("ym")["value"].sum().reindex(FC_YMS)
        states_out.setdefault(s, {})[nm] = safe_ints(gg.values)
    for (s, l), kg in df.groupby(KEYS):
        gg = kg.set_index("ym")["value"].reindex(FC_YMS)
        lgas_out.setdefault(f"{s}|||{l}", {})[nm] = safe_ints(gg.values)

# ---- time-series at national + state: conditional SARIMAX-X / ARIMAX + ETS + naive ----
import ts_util
def ts_block(sub_panel):
    out = dict(ts_util.conditional_block(sub_panel, FC_YMS, TRAIN_END, include_arimax=True))
    y_hist = sub_panel[sub_panel.ym <= TRAIN_END].groupby("ym")["cases"].sum()
    if F.AFTER:
        pf = ts_util.prophet_forecast(y_hist, ts_util.build_exog(sub_panel), FC_YMS)
        if pf is not None:
            out["Prophet (conditional)"] = pf
        import seir
        out.update(seir.seir_block(sub_panel, FC_YMS, TRAIN_END))
    s = sub_panel[sub_panel.ym <= TRAIN_END].groupby("ym")["cases"].sum().reindex(
        range(2023 * 12, TRAIN_END + 1)).astype(float).fillna(0.0).values
    try:
        out["Holt-Winters (ETS)"] = ExponentialSmoothing(s, trend="add", seasonal="add", seasonal_periods=12).fit().forecast(len(FC_YMS))
    except Exception:
        pass
    last12 = s[-12:]
    out["Seasonal Naive"] = np.array([last12[i % 12] for i in range(len(FC_YMS))])
    return out

for nm, arr in ts_block(panel).items():
    if arr is not None: nat["models"][nm] = safe_ints(arr)
for s, sg in panel.groupby("state"):
    for nm, arr in ts_block(sg).items():
        if arr is not None: states_out.setdefault(s, {})[nm] = safe_ints(arr)

import os as _os
OUT = f"ui/public/data/{_os.environ.get('MAL_VARIANT','after')}"; _os.makedirs(OUT, exist_ok=True)
json.dump(nat, open(f"{OUT}/mm_national.json", "w"), allow_nan=False)
json.dump({"dates": fc_dates, "states": states_out}, open(f"{OUT}/mm_states.json", "w"), allow_nan=False)
json.dump({"dates": fc_dates, "lgas": lgas_out}, open(f"{OUT}/mm_lgas.json", "w"), allow_nan=False)
import os
print("models:", list(nat["models"].keys()))
for fn in ["mm_national.json", "mm_states.json", "mm_lgas.json"]:
    print(f"  {fn}: {os.path.getsize(OUT+'/'+fn)//1024} KB")
print(f"TOTAL {time.time()-t0:.0f}s", flush=True)
