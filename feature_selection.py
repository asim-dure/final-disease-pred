"""
Model-based feature selection (best practice).

Considers ALL 122 candidate features (8 base + 114 malaria indicators), ranks
them by importance averaged across three tree ensembles (Random Forest, XGBoost,
LightGBM) on the 2023-2025 training window, and selects a compact set:
  - the 8 base features are always kept (target lags, population, geography, time),
  - the top INDICATORS by averaged importance fill the set out to K = 40.

Writes selected_features.json with the chosen set AND the full ranking of every
candidate (score + selected flag) so reviewers can see all columns were evaluated
and only the strongest were kept.
"""
import json, warnings, numpy as np
warnings.filterwarnings("ignore")
import features as F
from features import (KEYS, BASE_FEATURES, INDICATOR_FEATURES, CANDIDATE_FEATURES, TRAIN_END,
                      FEATURE_DOC, AFTER)
import xgboost as xgb
import lightgbm as lgb
from sklearn.ensemble import RandomForestRegressor

K = 50 if AFTER else 40   # after has the richer derived-feature pool, so keep a few more

panel = F.load_panel()
feat = F.build_features(panel)
train = feat[(feat.ym <= TRAIN_END) & feat["cases"].notna()].dropna(subset=["lag3"]).copy()
X = F.Xmat_for(train, CANDIDATE_FEATURES)
y = np.log1p(train["cases"].clip(lower=0))
print(f"selection on {len(train):,} rows x {len(CANDIDATE_FEATURES)} candidate features", flush=True)

def norm_imp(imp):
    imp = np.asarray(imp, float); s = imp.sum()
    return imp / s if s > 0 else imp

per_model = {}   # model -> normalized importance vector (each sums to 1)
scores = np.zeros(len(CANDIDATE_FEATURES))
for name, mdl in [
    ("rf", RandomForestRegressor(n_estimators=200, max_depth=16, n_jobs=-1, random_state=42)),
    ("xgb", xgb.XGBRegressor(n_estimators=400, max_depth=6, learning_rate=0.05, subsample=0.85,
                             colsample_bytree=0.8, tree_method="hist", random_state=42, n_jobs=0)),
    ("lgbm", lgb.LGBMRegressor(n_estimators=400, num_leaves=48, learning_rate=0.05,
                               random_state=42, n_jobs=-1, verbose=-1)),
]:
    mdl.fit(X, y)
    per_model[name] = norm_imp(mdl.feature_importances_)
    scores += per_model[name]
    print(f"  fit {name}", flush=True)
scores /= 3.0   # importance = average of the three ensembles' normalized importances
score_by_feat = {f: float(s) for f, s in zip(CANDIDATE_FEATURES, scores)}
split_by_feat = {f: {k: round(float(per_model[k][i]), 5) for k in per_model}
                 for i, f in enumerate(CANDIDATE_FEATURES)}

# selection: base always in; top non-base (indicators + AFTER-derived) fill to K
non_base = [c for c in CANDIDATE_FEATURES if c not in BASE_FEATURES]
ranked_nb = sorted(non_base, key=lambda f: score_by_feat[f], reverse=True)
selected = BASE_FEATURES + ranked_nb[: max(0, K - len(BASE_FEATURES))]
selected_set = set(selected)

ranking = sorted(CANDIDATE_FEATURES, key=lambda f: score_by_feat[f], reverse=True)
ranking_out = [{
    "name": f, "score": round(score_by_feat[f], 5),
    "imp_rf": split_by_feat[f]["rf"], "imp_xgb": split_by_feat[f]["xgb"], "imp_lgbm": split_by_feat[f]["lgbm"],
    "selected": f in selected_set,
    "base": f in BASE_FEATURES,
    "doc": FEATURE_DOC.get(f, ""),
} for f in ranking]

json.dump({"k": K, "n_candidates": len(CANDIDATE_FEATURES),
           "importance_method": ("Importance = average of three tree ensembles' built-in importance: "
                                 "Random Forest (mean impurity / Gini decrease), XGBoost (total split gain), "
                                 "LightGBM (total split gain). Each model's importances are normalized to sum to "
                                 "100%, then the three are averaged. So a feature's % = (RF% + XGBoost% + LightGBM%) / 3."),
           "selected": selected, "ranking": ranking_out},
          open("selected_features.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print(f"\nSelected {len(selected)} of {len(CANDIDATE_FEATURES)} features (8 base + "
      f"{len(selected)-8} indicators).")
print("Top 15 by importance:")
for r in ranking_out[:15]:
    flag = "✓" if r["selected"] else " "
    print(f"  [{flag}] {r['score']*100:5.2f}%  {r['name']}")
