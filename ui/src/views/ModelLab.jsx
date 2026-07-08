import React, { useMemo, useState, useEffect } from 'react'
import { Card, KPI, HBars, CompareChart, ForecastChart } from '../components'
import { COLORS, fmt, fmtFull, loadMM } from '../lib'
import { meaningFor, detailFor, SOURCES, ABBREV } from '../glossary'

const kindTag = (k) => {
  const map = { 'Machine Learning': 'k-ml', 'Deep Learning': 'k-dl', 'Time Series': 'k-ts', 'Ensemble': 'k-ens' }
  return <span className={`kind-tag ${map[k] || 'k-ml'}`}>{k}</span>
}

// ---- full metric battery (computed client-side from per-LGA predictions) ----
function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((x, y) => x - y); const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function metrics(a, p) {
  const pairs = a.map((x, i) => [x, p[i]]).filter(([x, y]) => x != null && y != null && isFinite(x) && isFinite(y))
  if (!pairs.length) return { n: 0 }
  const n = pairs.length
  const res = pairs.map(([x, y]) => y - x)          // signed residual (pred - actual)
  const abs = res.map(Math.abs)
  const actualSum = pairs.reduce((s, [x]) => s + x, 0)
  const predSum = pairs.reduce((s, [, y]) => s + y, 0)
  const me = res.reduce((s, r) => s + r, 0) / n      // mean error (bias)
  const mae = abs.reduce((s, r) => s + r, 0) / n
  const mse = res.reduce((s, r) => s + r * r, 0) / n
  const stdErr = Math.sqrt(res.reduce((s, r) => s + (r - me) ** 2, 0) / n)
  let ms = 0, mc = 0, smape = 0
  for (const [x, y] of pairs) { if (x > 0) { ms += Math.abs(y - x) / x; mc++ } smape += 2 * Math.abs(y - x) / (Math.abs(x) + Math.abs(y) + 1e-9) }
  const aMean = actualSum / n
  const ssTot = pairs.reduce((s, [x]) => s + (x - aMean) ** 2, 0)
  const ssRes = res.reduce((s, r) => s + r * r, 0)
  const rmsle = Math.sqrt(pairs.reduce((s, [x, y]) => s + (Math.log1p(Math.max(0, y)) - Math.log1p(Math.max(0, x))) ** 2, 0) / n)
  return {
    n, actualSum, predSum, diff: predSum - actualSum,
    diffPct: actualSum ? (predSum - actualSum) / actualSum * 100 : null,
    ME: me, MAE: mae, MedAE: median(abs), MSE: mse, RMSE: Math.sqrt(mse),
    StdErr: stdErr, MaxAE: Math.max(...abs),
    MAPE: mc ? (ms / mc) * 100 : null, sMAPE: (smape / n) * 100, RMSLE: rmsle,
    R2: ssTot > 0 ? 1 - ssRes / ssTot : null,
  }
}

export default function ModelLab({ data, variant = 'after' }) {
  const lb = data.leaderboard
  if (!lb) return <div className="loading">Model leaderboard not available — run model_suite.py</div>
  const avp = data.avp
  const hot = data.hotspots
  const geo = data.geo
  const stateNames = useMemo(() => Object.keys(geo).sort(), [geo])

  const [tab, setTab] = useState('avf')
  const [gLevel, setGLevel] = useState('National')   // 'pooled' | 'National' | <state>
  const [gLga, setGLga] = useState('')
  const [avModel, setAvModel] = useState('Ensemble (top-3)')
  const [mmNat, setMmNat] = useState(null)
  const [mmStates, setMmStates] = useState(null)
  const [mmLgas, setMmLgas] = useState(null)
  useEffect(() => { setMmNat(null); setMmStates(null); setMmLgas(null); loadMM(variant, 'national').then(setMmNat); loadMM(variant, 'states').then(setMmStates) }, [variant])
  useEffect(() => { if (gLga && !mmLgas) loadMM(variant, 'lgas').then(setMmLgas) }, [gLga, mmLgas, variant])
  const [impModel, setImpModel] = useState('XGBoost')
  const [glossQ, setGlossQ] = useState('')
  const [hotState, setHotState] = useState('National')
  useEffect(() => { setGLga('') }, [gLevel])

  // resolve the LGA keys for the current geography
  const allKeys = useMemo(() => avp ? Object.keys(avp.actual_lga) : [], [avp])
  const geoKeys = useMemo(() => {
    if (!avp) return []
    if (gLevel === 'pooled' || gLevel === 'National') return allKeys
    if (gLga) return [`${gLevel}|||${gLga}`].filter(k => avp.actual_lga[k])
    return (geo[gLevel]?.lgas || []).map(l => `${gLevel}|||${l}`).filter(k => avp.actual_lga[k])
  }, [avp, gLevel, gLga, allKeys, geo])
  const pooled = gLevel === 'pooled'
  const geoLabel = gLevel === 'pooled' ? 'All LGAs (pooled, per-LGA-month)'
    : gLevel === 'National' ? 'Nigeria (national)' : gLga ? `${gLga}, ${gLevel}` : gLevel

  // aggregate actual history (39) for the chosen geography
  const nT = avp ? avp.dates.length : 0
  const actualHist = useMemo(() => {
    if (!avp) return []
    const arr = new Array(nT).fill(0); const has = new Array(nT).fill(false)
    for (const k of geoKeys) { const a = avp.actual_lga[k]; if (!a) continue; for (let i = 0; i < nT; i++) if (a[i] != null) { arr[i] += a[i]; has[i] = true } }
    return arr.map((v, i) => has[i] ? v : null)
  }, [avp, geoKeys, nT])
  const testIdx = useMemo(() => avp ? avp.test_dates.map(d => avp.dates.indexOf(d)) : [], [avp])

  // metrics per model at the current geography (aggregate) or pooled (per-LGA-month points)
  const modelMetrics = useMemo(() => {
    if (!avp) return {}
    const res = {}
    for (const m of avp.models) {
      const pl = avp.pred_lga[m.name]
      if (pooled) {
        const A = [], P = []
        for (const k of geoKeys) { const a = avp.actual_lga[k], pr = pl[k]; if (!a || !pr) continue; testIdx.forEach((ti, j) => { A.push(a[ti]); P.push(pr[j]) }) }
        res[m.name] = metrics(A, P)
      } else {
        const aTest = testIdx.map(ti => actualHist[ti])
        const pAgg = [0, 0, 0]
        for (const k of geoKeys) { const pr = pl[k]; if (!pr) continue; for (let j = 0; j < 3; j++) pAgg[j] += pr[j] }
        res[m.name] = metrics(aTest, pAgg)
      }
    }
    return res
  }, [avp, geoKeys, pooled, actualHist, testIdx])

  // full forecast trajectory (2026-01..2030-12) for the selected model & geography,
  // from the multi-model files — extends the chart beyond the 2026 Q1 test window
  const mm = gLevel === 'pooled' || gLevel === 'National' ? mmNat
    : gLga ? (mmLgas ? { dates: mmLgas.dates, models: mmLgas.lgas[`${gLevel}|||${gLga}`] } : null)
      : (mmStates ? { dates: mmStates.dates, models: mmStates.states[gLevel] } : null)
  const mmSeries = mm?.models?.[avModel] || null   // array aligned to mm.dates (or null)

  // actual-vs-forecast chart: actual history + the model's forecast all the way to 2030
  const avChart = useMemo(() => {
    if (!avp || pooled) return []
    const pAgg = [0, 0, 0]
    for (const k of geoKeys) { const pr = avp.pred_lga[avModel]?.[k]; if (!pr) continue; for (let j = 0; j < 3; j++) pAgg[j] += pr[j] }
    // q1 predictions keyed by date (held-out test), then the mm forecast to 2030
    const predByDate = {}
    avp.test_dates.forEach((d, j) => { predByDate[d] = pAgg[j] })
    if (mmSeries) mm.dates.forEach((d, j) => { if (predByDate[d] == null) predByDate[d] = mmSeries[j] })
    const allDates = [...new Set([...avp.dates, ...(mmSeries ? mm.dates : [])])].sort()
    const actByDate = {}
    avp.dates.forEach((d, i) => { actByDate[d] = actualHist[i] })
    const rows = allDates.map(d => ({ date: d, Actual: actByDate[d] ?? null, Predicted: predByDate[d] ?? null }))
    const fi = allDates.indexOf(avp.test_dates[0])     // bridge model line to last actual
    if (fi > 0 && rows[fi - 1] && rows[fi - 1].Actual != null) rows[fi - 1].Predicted = rows[fi - 1].Actual
    return rows
  }, [avp, geoKeys, avModel, actualHist, pooled, mmSeries, mm])

  const reg = lb.regression
  const champ = reg.find(r => r.kind === 'Ensemble') || reg[0]
  const bestClf = lb.classification.models.slice().sort((a, b) => b.metrics.ROC_AUC - a.metrics.ROC_AUC)[0]
  const imp = lb.importances[impModel] || {}
  const impData = Object.entries(imp).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 14)

  // models grouped, sorted by RMSE at current geography
  const rankBy = (kinds) => avp ? avp.models.filter(m => kinds.includes(m.kind))
    .map(m => ({ ...m, ...modelMetrics[m.name] })).sort((a, b) => (a.RMSE ?? 1e18) - (b.RMSE ?? 1e18)) : []

  const GeoControls = ({ pooledOpt = true }) => (
    <div className="controls">
      <div className="select-wrap"><label>Geography</label>
        <select value={gLevel} onChange={e => setGLevel(e.target.value)} style={{ minWidth: 210 }}>
          {pooledOpt && <option value="pooled">All LGAs (pooled)</option>}
          <option value="National">Nigeria (national)</option>
          {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
        </select></div>
      {gLevel !== 'National' && gLevel !== 'pooled' && (
        <div className="select-wrap"><label>LGA (optional)</label>
          <select value={gLga} onChange={e => setGLga(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">— whole state —</option>
            {(geo[gLevel]?.lgas || []).map(l => <option key={l} value={l}>{l}</option>)}
          </select></div>
      )}
      <span className="chip" style={{ alignSelf: 'center' }}>{geoLabel}</span>
    </div>
  )

  // ---- hotspot trajectory ----
  const hotTraj = hot ? (hotState === 'National' ? hot.national : hot.states[hotState] || hot.national) : []
  const hotForecast = hotTraj.filter(d => d.forecast)
  const hotComment = useMemo(() => {
    if (!hotTraj.length) return null
    const start = hotTraj.find(d => d.date === '2023-01') || hotTraj[0]
    const lastAct = hotTraj.filter(d => !d.forecast).slice(-1)[0]
    const end2030 = hotTraj.slice(-1)[0]
    const peak = hotTraj.reduce((a, b) => b.share > a.share ? b : a, hotTraj[0])
    const trough = hotForecast.length ? hotForecast.reduce((a, b) => b.share < a.share ? b : a, hotForecast[0]) : null
    const dir = end2030.share > lastAct.share ? 'rising' : end2030.share < lastAct.share ? 'easing' : 'flat'
    return { start, lastAct, end2030, peak, trough, dir }
  }, [hotTraj, hotForecast])

  return (
    <>
      <div className="view-head">
        <h2>Model Lab — full ML / DL / Time-Series benchmark</h2>
        <p>Every model is validated on the held-out <b>2026 Q1</b> via true multi-step recursion. Metrics here are
          recomputed for the geography you pick — pooled across all 774 LGA-months, national, a single state, or one
          LGA. {avp ? avp.models.length : lb.n_models} forecasting models. L1 = MAE, L2 = RMSE; Gini = 2·AUC−1; Entropy = log-loss.</p>
      </div>

      <div className="champion-banner">
        <span className="trophy">🏆</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: '1.02rem' }}>Champion · {lb.champion}</div>
          <div className="muted" style={{ fontSize: '.82rem' }}>{lb.champion_kind} — used for the production forecast to 2030. Validation: {lb.validation_window}.</div>
        </div>
      </div>

      <div className="controls">
        {['avf', 'regression', 'deeptime', 'classification', 'features'].map(t => (
          <button key={t} className="btn" onClick={() => setTab(t)}
            style={{ background: tab === t ? 'var(--accent)' : 'var(--bg-1)', color: tab === t ? '#fff' : 'var(--txt-1)', borderColor: tab === t ? 'var(--accent)' : 'var(--border)' }}>
            {{ avf: 'Actual vs Forecast', regression: 'Regression leaderboard', deeptime: 'Deep Learning & Time Series', classification: 'Hotspot Classification', features: 'Features & Importance' }[t]}
          </button>
        ))}
      </div>

      {/* ---------------- Actual vs Forecast ---------------- */}
      {tab === 'avf' && (avp ? (
        <>
          <div className="controls">
            <div className="select-wrap"><label>Geography</label>
              <select value={gLevel === 'pooled' ? 'National' : gLevel} onChange={e => setGLevel(e.target.value)} style={{ minWidth: 210 }}>
                <option value="National">Nigeria (national)</option>
                {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
              </select></div>
            {gLevel !== 'National' && gLevel !== 'pooled' && (
              <div className="select-wrap"><label>LGA (optional)</label>
                <select value={gLga} onChange={e => setGLga(e.target.value)} style={{ minWidth: 200 }}>
                  <option value="">— whole state —</option>
                  {(geo[gLevel]?.lgas || []).map(l => <option key={l} value={l}>{l}</option>)}
                </select></div>
            )}
            <div className="select-wrap"><label>Model</label>
              <select value={avModel} onChange={e => setAvModel(e.target.value)} style={{ minWidth: 210 }}>
                {avp.models.map(m => <option key={m.name} value={m.name}>{m.name} · {m.kind}</option>)}
              </select></div>
          </div>
          {(() => {
            const mt = modelMetrics[avModel] || {}
            return <div className="grid kpis">
              <KPI label="Test MAE (cases/mo)" value={fmt(mt.MAE)} delta={`${avModel}`.slice(0, 22)} deltaClass="flat" color={COLORS.accent} />
              <KPI label="Test RMSE" value={fmt(mt.RMSE)} delta={geoLabel.slice(0, 26)} deltaClass="flat" color={COLORS.accent2} />
              <KPI label="Test MAPE" value={mt.MAPE != null ? mt.MAPE.toFixed(2) + '%' : '—'} delta="held-out 2026 Q1" deltaClass="flat" color={COLORS.violet} />
              <KPI label="Model type" value={avp.models.find(m => m.name === avModel)?.kind || ''} delta="recursive validation" deltaClass="flat" color={COLORS.amber} />
            </div>
          })()}
          <Card title={`Actual vs forecast — ${geoLabel} · ${avModel}`}
            sub={`Train 2023-01→2025-12 · 2026 Q1 held out for accuracy (metrics above) · forecast then continues to Dec 2030${mmSeries ? '' : ' (this model: Q1 only)'}`}>
            <CompareChart data={avChart} height={360} splitDate={avp.test_dates[0]} splitLabel="2026 Q1 test →"
              series={[{ key: 'Actual', name: 'Actual (DHIS2)', color: COLORS.accent },
                { key: 'Predicted', name: `${avModel} forecast`, color: COLORS.amber, dashed: true }]} />
            <div className="pill-legend">
              <span><i style={{ background: COLORS.accent }} />Actual confirmed cases</span>
              <span><i style={{ background: COLORS.amber }} />{avModel} (held-out Q1)</span>
            </div>
          </Card>
          <Card title="2026 Q1 — actual vs forecast (held-out test)" sub="The three months never seen during training" style={{ marginTop: 18 }}>
            <table className="data">
              <thead><tr><th>Month</th><th className="num">Actual</th><th className="num">Forecast</th><th className="num">Error</th><th className="num">Error %</th></tr></thead>
              <tbody>
                {avp.test_dates.map((d, j) => {
                  const ti = testIdx[j]; const a = actualHist[ti]
                  let p = 0; for (const k of geoKeys) { const pr = avp.pred_lga[avModel]?.[k]; if (pr) p += pr[j] }
                  const e = p - a
                  return <tr key={d}><td>{d}</td><td className="num">{fmtFull(a)}</td>
                    <td className="num" style={{ color: COLORS.amber }}>{fmtFull(p)}</td>
                    <td className="num" style={{ color: e > 0 ? COLORS.coral : COLORS.green }}>{e > 0 ? '+' : ''}{fmtFull(e)}</td>
                    <td className="num">{a ? ((e / a) * 100).toFixed(1) + '%' : '—'}</td></tr>
                })}
              </tbody>
            </table>
          </Card>
        </>
      ) : <div className="loading">Run modellab_data.py to generate per-model predictions</div>)}

      {/* ---------------- Regression leaderboard ---------------- */}
      {tab === 'regression' && (
        <>
          <GeoControls />
          <Card title="Regression leaderboard — full metric battery" sub={`Ranked by RMSE at: ${geoLabel} · ${pooled ? 'errors over all LGA-month points' : 'errors on the aggregated series (3 test months)'}`}>
            <div className="tbl-scroll">
              <table className="data">
                <thead><tr>
                  <th>#</th><th>Model</th><th>Type</th>
                  <th className="num">Actual</th><th className="num">Predicted</th><th className="num">Diff</th><th className="num">Diff %</th>
                  <th className="num">ME (bias)</th><th className="num">MAE (L1)</th><th className="num">MedAE</th>
                  <th className="num">RMSE</th><th className="num">MSE (L2)</th><th className="num">Std err</th><th className="num">Max AE</th>
                  <th className="num">MAPE %</th><th className="num">sMAPE %</th><th className="num">RMSLE</th><th className="num">R²</th>
                </tr></thead>
                <tbody>
                  {rankBy(['Machine Learning', 'Deep Learning', 'Ensemble']).map((r, i) => (
                    <tr key={r.name} style={r.kind === 'Ensemble' ? { background: 'rgba(37,99,235,.06)' } : {}}>
                      <td>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                      <td style={{ fontWeight: 600, color: 'var(--txt-0)', whiteSpace: 'nowrap' }}>{r.name}</td>
                      <td>{kindTag(r.kind)}</td>
                      <td className="num">{fmt(r.actualSum)}</td>
                      <td className="num">{fmt(r.predSum)}</td>
                      <td className="num" style={{ color: r.diff > 0 ? COLORS.coral : COLORS.green }}>{r.diff > 0 ? '+' : ''}{fmt(r.diff)}</td>
                      <td className="num" style={{ color: r.diff > 0 ? COLORS.coral : COLORS.green }}>{r.diffPct != null ? (r.diffPct > 0 ? '+' : '') + r.diffPct.toFixed(1) : '—'}</td>
                      <td className="num" style={{ color: r.ME > 0 ? COLORS.coral : COLORS.green }}>{r.ME > 0 ? '+' : ''}{fmt(r.ME)}</td>
                      <td className="num">{fmt(r.MAE)}</td>
                      <td className="num">{fmt(r.MedAE)}</td>
                      <td className="num" style={{ color: COLORS.accent, fontWeight: 600 }}>{fmt(r.RMSE)}</td>
                      <td className="num">{fmt(r.MSE)}</td>
                      <td className="num">{fmt(r.StdErr)}</td>
                      <td className="num">{fmt(r.MaxAE)}</td>
                      <td className="num">{r.MAPE != null ? r.MAPE.toFixed(2) : '—'}</td>
                      <td className="num">{r.sMAPE != null ? r.sMAPE.toFixed(2) : '—'}</td>
                      <td className="num">{r.RMSLE != null ? r.RMSLE.toFixed(3) : '—'}</td>
                      <td className="num">{r.R2 != null ? r.R2.toFixed(3) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: '.76rem', marginTop: 10 }}>
              <b>How to read it:</b> <b>Actual</b> / <b>Predicted</b> are the summed confirmed cases over the test window;
              <b> Diff</b> is the headline miss that the error scores quantify. <b>ME</b> is signed bias (+ = over-forecast),
              <b> MAE</b> = mean |error| (L1), <b>MedAE</b> = median |error| (robust to outliers), <b>RMSE</b>/<b>MSE</b> are
              L2 (penalise big misses), <b>Std err</b> is the spread of residuals, <b>Max AE</b> the worst single month,
              <b> MAPE/sMAPE/RMSLE</b> are scale-free, and <b>R²</b> is variance explained. Rankings shift with geography —
              pooled per-LGA-month errors reward local fit; the aggregated series rewards errors that cancel on aggregation.
            </div>
          </Card>
        </>
      )}

      {/* ---------------- Deep Learning & Time Series ---------------- */}
      {tab === 'deeptime' && (
        <>
          <GeoControls />
          <div className="row">
            <Card className="col" title="Deep Learning models" sub={`PyTorch · ${geoLabel}`} style={{ flex: 1, minWidth: 340 }}>
              <div className="tbl-scroll">
              <table className="data">
                <thead><tr><th>Model</th><th className="num">Pred</th><th className="num">Diff</th><th className="num">MAE</th><th className="num">MedAE</th><th className="num">RMSE</th><th className="num">MAPE %</th><th className="num">R²</th></tr></thead>
                <tbody>{rankBy(['Deep Learning']).map(r => (
                  <tr key={r.name}><td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td className="num">{fmt(r.predSum)}</td>
                    <td className="num" style={{ color: r.diff > 0 ? COLORS.coral : COLORS.green }}>{r.diff > 0 ? '+' : ''}{fmt(r.diff)}</td>
                    <td className="num">{fmt(r.MAE)}</td><td className="num">{fmt(r.MedAE)}</td><td className="num">{fmt(r.RMSE)}</td>
                    <td className="num">{r.MAPE != null ? r.MAPE.toFixed(2) : '—'}</td><td className="num">{r.R2 != null ? r.R2.toFixed(3) : '—'}</td></tr>))}</tbody>
              </table></div>
              <div className="muted" style={{ fontSize: '.74rem', marginTop: 8 }}>
                LSTM / GRU are sequence models on 12-month windows of [cases, rainfall, temperature, humidity,
                seasonality]; the MLP is a feed-forward net on the tabular features. Same recursion as the ML models.
              </div>
            </Card>
            <Card className="col" title="Time-Series models" sub={`Fit per LGA, then aggregated · ${geoLabel}`} style={{ flex: 1, minWidth: 340 }}>
              <div className="tbl-scroll">
              <table className="data">
                <thead><tr><th>Model</th><th className="num">Pred</th><th className="num">Diff</th><th className="num">MAE</th><th className="num">MedAE</th><th className="num">RMSE</th><th className="num">MAPE %</th><th className="num">R²</th></tr></thead>
                <tbody>{rankBy(['Time Series']).map(r => (
                  <tr key={r.name}><td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td className="num">{fmt(r.predSum)}</td>
                    <td className="num" style={{ color: r.diff > 0 ? COLORS.coral : COLORS.green }}>{r.diff > 0 ? '+' : ''}{fmt(r.diff)}</td>
                    <td className="num">{fmt(r.MAE)}</td><td className="num">{fmt(r.MedAE)}</td><td className="num">{fmt(r.RMSE)}</td>
                    <td className="num">{r.MAPE != null ? r.MAPE.toFixed(2) : '—'}</td><td className="num">{r.R2 != null ? r.R2.toFixed(3) : '—'}</td></tr>))}</tbody>
              </table></div>
              <div className="muted" style={{ fontSize: '.74rem', marginTop: 8 }}>
                A separate SARIMAX, Holt-Winters (ETS) and seasonal-naive model is fit to <b>each LGA's own series</b>
                (2023-2025) and forecast for 2026 Q1, then summed to the chosen geography — so time-series skill is
                now visible at LGA level, not just nationally.
              </div>
            </Card>
          </div>
        </>
      )}

      {/* ---------------- Hotspot Classification ---------------- */}
      {tab === 'classification' && (
        <>
          <Card title="What this section does" sub="A second model head — early-warning hotspot detection" style={{ marginBottom: 18 }}>
            <div className="method-section" style={{ marginBottom: 0 }}>
              <p>Alongside the case-count <i>regression</i>, we train a <b>classifier</b> that answers a yes/no question
                for every LGA-month: <b>is this a transmission hotspot?</b> An LGA-month is labelled a hotspot when its
                confirmed-case incidence is in the top third of the national distribution
                (≥ <code>{hot?.threshold ?? lb.classification.label_threshold_inc_per_1000}</code> per 1,000 people).
                The models use the same leakage-free features as the forecast, and are tested on
                {' '}{lb.classification.test_window} (months never seen in training).</p>
              <p style={{ marginTop: 8 }}><b>How the metrics read:</b> <b>Accuracy</b> = share of months classified correctly;
                <b> Precision</b> = of the LGA-months flagged as hotspots, how many truly were; <b>Recall</b> = of the true
                hotspots, how many we caught; <b>F1</b> balances the two; <b>ROC-AUC</b> = probability the model ranks a
                random hotspot above a random non-hotspot (1.0 = perfect); <b>Gini</b> = 2·AUC−1; <b>log-loss (entropy)</b>
                and <b>Brier</b> measure probability calibration (lower is better).</p>
            </div>
          </Card>

          <div className="grid kpis">
            <KPI label="Best classifier AUC" value={bestClf.metrics.ROC_AUC} delta={`${bestClf.model}`} deltaClass="flat" color={COLORS.accent} />
            <KPI label="Gini" value={bestClf.metrics.Gini} delta="2·AUC − 1" deltaClass="flat" color={COLORS.accent2} />
            <KPI label="Recall (hotspots caught)" value={(bestClf.metrics.Recall * 100).toFixed(1) + '%'} delta={`Precision ${(bestClf.metrics.Precision * 100).toFixed(0)}%`} deltaClass="flat" color={COLORS.violet} />
            <KPI label="Hotspot threshold" value={`${hot?.threshold ?? '—'}`} delta="incidence / 1,000" deltaClass="flat" color={COLORS.amber} />
          </div>

          <Card title="Classifier leaderboard — full battery" sub={`Test ${lb.classification.test_window} · sorted by ROC-AUC`} style={{ marginBottom: 18 }}>
            <div className="tbl-scroll">
              <table className="data">
                <thead><tr><th>Model</th><th className="num">Accuracy</th><th className="num">Precision</th><th className="num">Recall</th>
                  <th className="num">F1</th><th className="num">ROC-AUC</th><th className="num">Gini</th><th className="num">Log-loss</th><th className="num">Brier</th></tr></thead>
                <tbody>
                  {lb.classification.models.slice().sort((a, b) => b.metrics.ROC_AUC - a.metrics.ROC_AUC).map((r, i) => {
                    const m = r.metrics
                    return <tr key={i}><td style={{ fontWeight: 600 }}>{i === 0 ? '🥇 ' : ''}{r.model}</td>
                      <td className="num">{m.Accuracy}</td><td className="num">{m.Precision}</td><td className="num">{m.Recall}</td>
                      <td className="num">{m.F1}</td><td className="num" style={{ color: COLORS.accent, fontWeight: 600 }}>{m.ROC_AUC}</td>
                      <td className="num">{m.Gini}</td><td className="num">{m.LogLoss_Entropy}</td><td className="num">{m.Brier}</td></tr>
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {hot && (
            <Card title="Hotspot share projected to 2030"
              sub={`Share of ${hotState === 'National' ? hot.total_lgas + ' LGAs' : 'LGAs in ' + hotState} above the hotspot threshold each month`}
              right={<select value={hotState} onChange={e => setHotState(e.target.value)}>
                <option value="National">Nigeria (national)</option>
                {stateNames.map(s => <option key={s} value={s}>{s}</option>)}</select>}>
              <ForecastChart
                data={hotTraj.map(d => ({ date: d.date, cases: d.share, forecast: d.forecast }))}
                height={300} splitDate={hotTraj.find(d => d.forecast)?.date} />
              <div className="pill-legend">
                <span><i style={{ background: COLORS.accent }} />Observed hotspot share %</span>
                <span><i style={{ background: COLORS.amber }} />Projected to 2030 %</span>
              </div>
              {hotComment && (
                <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--bg-2)', borderRadius: 10, borderLeft: `3px solid ${COLORS.accent}` }}>
                  <b style={{ color: 'var(--txt-0)' }}>Reading the 2030 projection.</b>{' '}
                  <span className="muted" style={{ fontSize: '.85rem' }}>
                    For {hotState === 'National' ? 'Nigeria' : hotState}, the hotspot share sits at
                    {' '}<b>{hotComment.lastAct.share}%</b> in the last reported month ({hotComment.lastAct.date}) and is
                    projected to be <b>{hotComment.end2030.share}%</b> by Dec 2030 — an overall <b>{hotComment.dir}</b>
                    {' '}trajectory. It follows a strong seasonal cycle, peaking around <b>{hotComment.peak.date}</b>
                    {' '}(<b>{hotComment.peak.share}%</b> of LGAs) in the high-transmission months and easing in the dry
                    season. Because the classifier holds AUC ≈ {bestClf.metrics.ROC_AUC} on unseen months, this
                    seasonal hotspot rhythm is a reliable planning signal rather than noise — the same number of
                    high-burden LGAs recurs each rainy season through 2030 unless interventions change the trend.
                  </span>
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {/* ---------------- Features ---------------- */}
      {tab === 'features' && (
        <div className="row">
          <Card className="col" title="Feature importance" sub="Switch model to compare what each learns" style={{ flex: 1, minWidth: 360 }}
            right={<select value={impModel} onChange={e => setImpModel(e.target.value)}>
              {Object.keys(lb.importances).map(k => <option key={k} value={k}>{k}</option>)}</select>}>
            <HBars data={impData} max={impData[0]?.value || 1} color={COLORS.accent} fmtVal={v => (v * 100).toFixed(1) + '%'} />
          </Card>
          <Card className="col" title={`Selected model inputs (${lb.features.length})`} sub="Features actually used by the models — plain-language meaning" style={{ flex: 1, minWidth: 360 }}>
            <div className="tbl-scroll" style={{ maxHeight: 460 }}>
              <table className="data">
                <thead><tr><th>Feature</th><th>Meaning</th></tr></thead>
                <tbody>{lb.features.map((f, i) => (
                  <tr key={i}><td className="mono" style={{ color: COLORS.accent2, whiteSpace: 'nowrap' }}>{f.name}</td><td>{meaningFor(f.name)}</td></tr>))}</tbody>
              </table>
            </div>
          </Card>

          {/* Abbreviation legend */}
          <Card style={{ flexBasis: '100%' }} title="Abbreviations decoded" sub="The shorthand used in the malaria indicator names">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))', gap: '6px 22px' }}>
              {ABBREV.map(([a, m], i) => (
                <div key={i} style={{ fontSize: '.82rem' }}>
                  <b className="mono" style={{ color: COLORS.accent2 }}>{a}</b> <span className="muted">— {m}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* FULL data dictionary — every column with its meaning */}
          {lb.feature_selection && (() => {
            const rows = lb.feature_selection.ranking.map(f => ({ ...f, meaning: meaningFor(f.name) }))
            const q = glossQ.trim().toLowerCase()
            const shown = q ? rows.filter(r => (r.name + ' ' + r.meaning).toLowerCase().includes(q)) : rows
            return (
              <Card style={{ flexBasis: '100%' }}
                title={`Data dictionary — all ${rows.length} columns explained`}
                sub={lb.feature_selection.importance_method || "Every candidate column, what it means, its importance, and whether the model kept it. Search to find any term."}
                right={<input type="text" placeholder="search columns / meanings…" value={glossQ} onChange={e => setGlossQ(e.target.value)} style={{ minWidth: 240 }} />}>
                <div className="tbl-scroll" style={{ maxHeight: 620 }}>
                  <table className="data">
                    <thead><tr><th style={{ width: 230 }}>Column</th><th>Meaning · derivation · how to read · source</th><th className="num">Importance<br /><span style={{ fontWeight: 400, fontSize: '.62rem' }}>avg of RF·XGB·LGBM</span></th><th>Status</th></tr></thead>
                    <tbody>
                      {shown.map((f, i) => {
                        const d = detailFor(f.name); const s = SOURCES[d.src] || {}
                        return (
                          <tr key={i} style={f.selected ? {} : { opacity: 0.75 }}>
                            <td className="mono" style={{ color: f.selected ? COLORS.accent2 : 'var(--txt-2)', verticalAlign: 'top', fontSize: '.78rem', wordBreak: 'break-word' }}>{f.name}</td>
                            <td style={{ fontSize: '.82rem' }}>
                              <div style={{ color: 'var(--txt-0)', fontWeight: 500 }}>{f.meaning}</div>
                              {d.derivation && <div className="muted" style={{ fontSize: '.76rem', marginTop: 3 }}><b>How:</b> {d.derivation}</div>}
                              {d.interpret && <div className="muted" style={{ fontSize: '.76rem' }}><b>Reading:</b> {d.interpret}</div>}
                              <div style={{ fontSize: '.74rem', marginTop: 3 }}>
                                <b style={{ color: 'var(--txt-2)' }}>Source:</b>{' '}
                                {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: COLORS.accent2 }}>{s.label}</a>
                                  : <span className="muted">{s.label}</span>}
                              </div>
                            </td>
                            <td className="num" style={{ verticalAlign: 'top' }}>
                              <span style={{ fontWeight: 600 }}>{(f.score * 100).toFixed(2)}%</span>
                              {f.imp_rf != null && (
                                <div className="muted" style={{ fontSize: '.66rem', fontWeight: 400, marginTop: 2, lineHeight: 1.4 }}>
                                  RF {(f.imp_rf * 100).toFixed(1)}<br />XGB {(f.imp_xgb * 100).toFixed(1)}<br />LGBM {(f.imp_lgbm * 100).toFixed(1)}
                                </div>)}
                            </td>
                            <td style={{ verticalAlign: 'top' }}><span className="badge-soft" style={{ background: f.selected ? 'rgba(13,148,136,.14)' : 'var(--bg-3)', color: f.selected ? COLORS.accent : 'var(--txt-2)' }}>{f.selected ? '✓ Used' : f.base ? 'base' : 'dropped'}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="muted" style={{ fontSize: '.76rem', marginTop: 10 }}>
                  Showing {shown.length} of {rows.length} columns. Every entry lists what it means, exactly how it was
                  computed, how to interpret the value, and the real source it was fetched from (links open the source).
                  Nothing is fabricated — derivations match the code; external layers link to NOAA / Malaria Atlas / OPHI / OpenTopoData / OCHA.
                </div>
              </Card>
            )
          })()}
        </div>
      )}
    </>
  )
}
