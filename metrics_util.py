"""Full regression + classification metric batteries (the user wants everything)."""
import numpy as np
from sklearn.metrics import (mean_absolute_error, mean_squared_error, r2_score,
                             median_absolute_error, explained_variance_score,
                             accuracy_score, precision_score, recall_score, f1_score,
                             roc_auc_score, log_loss, brier_score_loss)


def reg_metrics(actual, pred):
    a = np.asarray(actual, float); p = np.asarray(pred, float)
    mask = np.isfinite(a) & np.isfinite(p)
    a, p = a[mask], p[mask]
    p = np.clip(p, 0, None)
    mae = mean_absolute_error(a, p)                       # L1 loss
    mse = mean_squared_error(a, p)                        # L2 loss
    rmse = float(np.sqrt(mse))
    nz = a > 0
    mape = float(np.mean(np.abs((a[nz] - p[nz]) / a[nz])) * 100) if nz.any() else None
    smape = float(np.mean(2 * np.abs(p - a) / (np.abs(a) + np.abs(p) + 1e-9)) * 100)
    rmsle = float(np.sqrt(np.mean((np.log1p(p) - np.log1p(np.clip(a, 0, None))) ** 2)))
    return {
        "MAE_L1": round(mae, 2), "MSE_L2": round(mse, 1), "RMSE": round(rmse, 1),
        "MedAE": round(median_absolute_error(a, p), 2), "MAPE_pct": round(mape, 2) if mape else None,
        "sMAPE_pct": round(smape, 2), "RMSLE": round(rmsle, 4),
        "R2": round(float(r2_score(a, p)), 4) if len(a) > 1 else None,
        "ExplVar": round(float(explained_variance_score(a, p)), 4) if len(a) > 1 else None,
        "n": int(len(a)),
    }


def clf_metrics(y_true, y_prob, thr=0.5):
    y = np.asarray(y_true, int)
    prob = np.clip(np.asarray(y_prob, float), 1e-6, 1 - 1e-6)
    pred = (prob >= thr).astype(int)
    try:
        auc = float(roc_auc_score(y, prob))
    except Exception:
        auc = None
    return {
        "Accuracy": round(accuracy_score(y, pred), 4),
        "Precision": round(precision_score(y, pred, zero_division=0), 4),
        "Recall": round(recall_score(y, pred, zero_division=0), 4),
        "F1": round(f1_score(y, pred, zero_division=0), 4),
        "ROC_AUC": round(auc, 4) if auc is not None else None,
        "Gini": round(2 * auc - 1, 4) if auc is not None else None,
        "LogLoss_Entropy": round(float(log_loss(y, prob, labels=[0, 1])), 4),
        "Brier": round(float(brier_score_loss(y, prob)), 4),
        "PosRate": round(float(y.mean()), 4), "n": int(len(y)),
    }
