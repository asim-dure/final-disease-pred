import React, { useMemo, useState, useEffect, useRef } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea, ReferenceLine,
} from 'recharts'
import { Card, InfoTip } from '../components'
import { fmt, fmtFull, pct, COLORS, MONTHS, monthLabel, loadMM } from '../lib'

// ────────────────────────────────────────────────────────────────────────────
// Forecastive Dashboard — a predictive command centre that sits ABOVE the
// (descriptive) Visual Overview. Everything here is about what's COMING, not
// what is: next-12-month projections, momentum, seasonal risk windows, and
// which states are about to worsen. It derives its intelligence from the same
// national/state/meta series the rest of the app already loads — no new data
// files — but reshapes them into forward-looking metrics rather than dumping
// raw rows on screen. Fully disease-agnostic and degrades cleanly for diseases
// with no forecast tail (e.g. TB), showing an honest banner instead of blanks.
// ────────────────────────────────────────────────────────────────────────────

const sum = a => a.reduce((x, y) => x + (y || 0), 0)
const avg = a => (a.length ? sum(a) / a.length : 0)

// diverging ramp for projected change: improving (green) → neutral (slate) → worsening (red)
function diverge(change) {
  if (change == null || isNaN(change)) return '#cbd5e1'
  const t = Math.max(-1, Math.min(1, change / 40))
  const mix = (a, b, f) => `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`
  const slate = [203, 213, 225]
  if (t <= 0) return mix([22, 163, 74], slate, 1 + t)        // green → slate
  return mix(slate, [220, 38, 38], t)                         // slate → red
}
// sequential heat ramp for seasonal intensity: cool → hot
function heat(t) {
  const x = Math.max(0, Math.min(1, t)) * 2
  const i = Math.min(1, Math.floor(x)), f = x - i
  const stops = [[59, 130, 176], [217, 119, 6], [220, 38, 38]]
  const a = stops[i], b = stops[i + 1]
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`
}

// Turn the raw series into a forward-looking model once, memoised.
function useForecastModel(national, states, meta) {
  return useMemo(() => {
    const nat = Array.isArray(national) ? national : []
    const actuals = nat.filter(d => !d.forecast)
    const fcast = nat.filter(d => d.forecast)
    const hasForecast = fcast.length > 0
    const lastActual = actuals[actuals.length - 1] || null
    const horizonEnd = fcast[fcast.length - 1] || null

    const next12 = fcast.slice(0, 12)
    const next12Sum = sum(next12.map(d => d.cases))
    const prev12 = actuals.slice(-12)
    const prev12Sum = sum(prev12.map(d => d.cases))
    const yoy = prev12Sum > 0 && hasForecast ? (next12Sum - prev12Sum) / prev12Sum * 100 : null

    const peak = hasForecast ? fcast.reduce((a, b) => (b.cases > a.cases ? b : a), fcast[0]) : null
    const trough = hasForecast ? fcast.reduce((a, b) => (b.cases < a.cases ? b : a), fcast[0]) : null
    const momentum = hasForecast && fcast[0].cases ? (fcast[fcast.length - 1].cases - fcast[0].cases) / fcast[0].cases * 100 : null

    // seasonal profile: mean projected value per calendar month across the horizon
    const byM = {}
    fcast.forEach(d => { (byM[d.month] = byM[d.month] || []).push(d.cases) })
    const seasonal = MONTHS.map((name, i) => ({ month: name, mIdx: i + 1, value: avg(byM[i + 1] || []) }))
    const sMax = Math.max(1, ...seasonal.map(s => s.value))
    const sMin = Math.min(...seasonal.map(s => s.value))

    // per-state movers: next-12 vs prior-12 projected change
    const movers = Object.entries(states || {}).map(([st, rows]) => {
      const a = rows.filter(d => !d.forecast), f = rows.filter(d => d.forecast)
      const p = sum(a.slice(-12).map(d => d.cases)), n = sum(f.slice(0, 12).map(d => d.cases))
      const latest = a[a.length - 1]?.cases ?? 0
      const change = p > 0 && f.length ? (n - p) / p * 100 : null
      return { state: st, prev12: p, next12: n, change, latest, hasF: f.length > 0 }
    }).filter(m => m.latest > 0 || m.next12 > 0)

    const worsening = movers.filter(m => m.change != null && m.change > 2).length
    const improving = movers.filter(m => m.change != null && m.change < -2).length

    // model accuracy → confidence band width, from meta.metrics validation (malaria carries this)
    let mape = null
    const val = meta?.metrics?.validation
    if (Array.isArray(val)) {
      const lga = val.find(v => /LGA/i.test(v.label) && /XGB|forecast|model/i.test(v.label)) || val[0]
      if (lga && lga['MAPE_%'] != null) mape = lga['MAPE_%']
    }
    return {
      nat, actuals, fcast, hasForecast, lastActual, horizonEnd,
      next12Sum, prev12Sum, yoy, peak, trough, momentum,
      seasonal, sMax, sMin, movers, worsening, improving, mape,
      nStates: meta?.summary?.n_states, nLgas: meta?.summary?.n_lgas,
    }
  }, [national, states, meta])
}

function Trend({ v, invert = false }) {
  if (v == null) return <span className="muted">—</span>
  const bad = invert ? v < 0 : v > 0
  const c = v === 0 ? COLORS.axis : bad ? COLORS.coral : COLORS.green
  const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '■'
  return <span style={{ color: c, fontWeight: 700 }}>{arrow} {pct(v)}</span>
}

// Hero metric tile
function Metric({ label, value, sub, accent = COLORS.accent, info }) {
  return (
    <div className="card" style={{ position: 'relative', overflow: 'visible', padding: '15px 17px', flex: 1, minWidth: 168 }}>
      <div className="accent-bar" style={{ background: accent, borderRadius: 'var(--r) 0 0 var(--r)' }} />
      <div style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--txt-2)', display: 'flex', alignItems: 'center' }}>
        {label}{info && <InfoTip text={info} />}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '1.7rem', fontWeight: 600, color: 'var(--txt-0)', marginTop: 5, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: '.74rem', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

const ChartTip = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 13px', fontSize: '.8rem', boxShadow: '0 8px 30px rgba(15,34,48,.12)' }}>
      <div style={{ color: 'var(--txt-0)', fontWeight: 700, marginBottom: 6 }}>{monthLabel(label)}</div>
      {payload.filter(p => p.value != null && p.name && !p.name.startsWith('_')).map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{p.name}</span><span className="mono" style={{ fontWeight: 600 }}>{fmtFull(Array.isArray(p.value) ? p.value[1] : p.value)}{unit || ''}</span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard({ data, disease = 'malaria', label = 'Malaria', variant = 'after' }) {
  const { national, states, meta } = data
  const M = useForecastModel(national, states, meta)
  const chartRef = useRef(null)

  const [scope, setScope] = useState('National')
  const [metric, setMetric] = useState('cases')     // 'cases' | 'incidence'
  const [moverMode, setMoverMode] = useState('rising')
  const [hoverTile, setHoverTile] = useState(null)

  const stateNames = useMemo(() => ['National', ...Object.keys(states || {}).sort()], [states])

  // multi-model ensemble → uncertainty envelope (min/max across models per month)
  const [mmNat, setMmNat] = useState(null)
  const [mmStates, setMmStates] = useState(null)
  useEffect(() => { setMmNat(null); setMmStates(null); loadMM(variant, 'national', disease).then(setMmNat); loadMM(variant, 'states', disease).then(setMmStates) }, [variant, disease])
  const mmLoc = scope === 'National' ? mmNat : (mmStates?.states ? { dates: mmStates.dates, models: mmStates.states[scope] } : null)

  // series for the selected scope
  const scopeSeries = scope === 'National' ? (M.nat || []) : (states?.[scope] || [])
  const key = metric === 'incidence' ? 'incidence' : 'cases'

  // build the trajectory rows with actual / forecast split + ensemble band
  const traj = useMemo(() => {
    const band = {}
    if (mmLoc?.models) {
      const names = Object.keys(mmLoc.models)
      mmLoc.dates.forEach((dt, i) => {
        const vals = names.map(n => mmLoc.models[n][i]).filter(v => v != null)
        if (vals.length) band[dt] = [Math.min(...vals), Math.max(...vals)]
      })
    }
    const rows = scopeSeries.map(d => ({
      date: d.date,
      actual: d.forecast ? null : d[key],
      forecast: d.forecast ? d[key] : null,
      band: metric === 'cases' ? band[d.date] || null : null,
    }))
    for (let i = 1; i < rows.length; i++) if (rows[i].forecast != null && rows[i - 1].actual != null) rows[i - 1].forecast = rows[i - 1].actual
    return rows
  }, [scopeSeries, key, metric, mmLoc])

  const firstForecast = scopeSeries.find(d => d.forecast)?.date
  const hasBand = traj.some(r => r.band)

  const movers = useMemo(() => {
    const arr = [...M.movers]
    if (moverMode === 'rising') arr.sort((a, b) => (b.change ?? -1e9) - (a.change ?? -1e9))
    else if (moverMode === 'falling') arr.sort((a, b) => (a.change ?? 1e9) - (b.change ?? 1e9))
    else arr.sort((a, b) => (b.next12 || 0) - (a.next12 || 0))
    return arr
  }, [M.movers, moverMode])
  const moverMax = Math.max(1, ...M.movers.map(m => Math.abs(m.change ?? 0)))

  // grid ordered by projected volume so the biggest burdens read first
  const grid = useMemo(() => [...M.movers].sort((a, b) => (b.next12 || b.latest) - (a.next12 || a.latest)), [M.movers])

  const focusState = (st) => { setScope(st); chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }

  // deterministic executive briefing generated from the computed numbers
  const briefing = useMemo(() => {
    if (!M.hasForecast) return null
    const out = []
    const dir = M.yoy == null ? null : M.yoy > 1 ? 'rise' : M.yoy < -1 ? 'decline' : 'hold roughly steady'
    if (dir) out.push(`Over the next 12 months, **${label}** cases are projected to ${dir === 'hold roughly steady' ? dir : dir + ' ' + Math.abs(M.yoy).toFixed(1) + '%'} — about **${fmtFull(M.next12Sum)}** cases versus **${fmtFull(M.prev12Sum)}** in the prior year.`)
    if (M.peak) out.push(`Transmission is expected to **peak in ${MONTHS[M.peak.month - 1]}** (${fmt(M.peak.cases)} cases), with the lowest load around ${M.trough ? MONTHS[M.trough.month - 1] : '—'}.`)
    const rising = movers.length && movers[0].change != null ? [...M.movers].sort((a, b) => (b.change ?? -1e9) - (a.change ?? -1e9))[0] : null
    const falling = [...M.movers].sort((a, b) => (a.change ?? 1e9) - (b.change ?? 1e9))[0]
    if (rising && rising.change > 0) out.push(`**${rising.state}** shows the steepest projected increase (**+${rising.change.toFixed(1)}%**)${falling && falling.change < 0 ? `, while **${falling.state}** is projected to improve (${falling.change.toFixed(1)}%)` : ''}.`)
    if (M.nStates) out.push(`**${M.worsening} of ${M.movers.length}** reporting states are on a rising trajectory; ${M.improving} are projected to improve — prioritise the rising cohort for pre-positioning of commodities ahead of the ${M.peak ? MONTHS[M.peak.month - 1] : 'peak'} window.`)
    return out
  }, [M, movers, label])

  return (
    <>
      <div className="view-head">
        <h2>{label} — Forecast Dashboard
          <InfoTip w={340} title="A forward-looking command centre"
            text="Unlike the Visual Overview (which maps today's burden), this dashboard is entirely predictive: 12-month projections, seasonal risk windows, and which states are about to worsen — all derived live from the model's forecast trajectory." />
        </h2>
        <p>Where this disease is <b>heading</b>: projected caseloads, the coming peak, and the states gaining momentum — a
          decision surface for pre-positioning resources <i>before</i> the next transmission wave, not after.</p>
      </div>

      {!M.hasForecast && (
        <Card style={{ marginBottom: 16, background: 'rgba(217,119,6,.07)', border: '1px solid rgba(217,119,6,.3)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '.86rem', color: 'var(--txt-1)', lineHeight: 1.6 }}>
            <span style={{ fontSize: '1.1rem' }}>🔮</span>
            <div><b>No forecast model is available for {label} yet.</b> {meta?.forecast_unavailable_reason || 'This disease does not carry enough continuous monthly history to project a reliable trajectory.'} The panels below fall back to the latest reported figures where possible.</div>
          </div>
        </Card>
      )}

      {/* ── HERO METRIC BAND ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <Metric label="Next 12-mo projection" accent={COLORS.amber}
          value={M.hasForecast ? fmt(M.next12Sum) : '—'}
          sub={M.yoy != null ? <Trend v={M.yoy} /> : <span className="muted">no forecast</span>}
          info="Sum of the next 12 projected months, compared with the last 12 months of actual reported data (year-on-year)." />
        <Metric label="Projected peak" accent={COLORS.coral}
          value={M.peak ? MONTHS[M.peak.month - 1] + " '" + String(M.peak.year).slice(2) : '—'}
          sub={M.peak ? <span style={{ color: COLORS.coral, fontWeight: 700 }}>{fmt(M.peak.cases)} cases/mo</span> : null}
          info="The single highest-caseload month anywhere in the forecast horizon — the wave to plan around." />
        <Metric label="Forecast horizon" accent={COLORS.accent2}
          value={M.horizonEnd ? monthLabel(M.horizonEnd.date) : '—'}
          sub={M.lastActual ? <span className="muted">from {monthLabel(M.lastActual.date)} actuals</span> : null}
          info="How far ahead the model projects, and the last month of real reported data it was anchored on." />
        <Metric label="Horizon momentum" accent={M.momentum > 0 ? COLORS.coral : COLORS.green}
          value={M.momentum != null ? <Trend v={M.momentum} /> : '—'}
          sub={<span className="muted">start → end of horizon</span>}
          info="Net direction of the trajectory across the whole forecast window — is the curve climbing or easing overall?" />
        <Metric label="States worsening" accent={COLORS.violet}
          value={M.movers.length ? `${M.worsening} / ${M.movers.length}` : '—'}
          sub={<span style={{ color: COLORS.green, fontWeight: 700 }}>{M.improving} improving</span>}
          info="States whose next-12-month projection is more than 2% above their prior year — i.e. gaining momentum." />
        <Metric label="Model accuracy" accent={COLORS.accent}
          value={M.mape != null ? `±${M.mape.toFixed(0)}%` : '—'}
          sub={<span className="muted">{M.mape != null ? 'validation MAPE' : 'not benchmarked'}</span>}
          info="Mean absolute percentage error from back-testing the model on held-out recent data. Lower = tighter forecasts." />
      </div>

      {/* ── MAIN TRAJECTORY + SEASONAL CALENDAR ── */}
      <div className="row" style={{ alignItems: 'stretch' }} ref={chartRef}>
        <Card className="col" style={{ flex: 2, minWidth: 480 }}
          title={<span>{scope} — projected trajectory
            <InfoTip w={320} text="Solid = actual reported data; dashed/amber = model forecast. The shaded envelope (where available) is the spread across an ensemble of models — a live uncertainty band." /></span>}
          sub={`Monthly ${metric === 'cases' ? 'confirmed cases' : 'incidence / 1,000'} · actual → forecast${hasBand ? ' · shaded = model ensemble range' : ''}`}
          right={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div className="select-wrap" style={{ margin: 0 }}>
                <select value={scope} onChange={e => setScope(e.target.value)} style={{ minWidth: 150 }}>
                  {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3, height: 'fit-content' }}>
                {[['cases', 'Cases'], ['incidence', 'Incidence']].map(([k, l]) => (
                  <button key={k} onClick={() => setMetric(k)} style={{ border: 'none', cursor: 'pointer', padding: '6px 12px', borderRadius: 6, fontSize: '.76rem', fontWeight: 600, fontFamily: 'var(--font)',
                    background: metric === k ? 'var(--bg-1)' : 'transparent', color: metric === k ? 'var(--accent)' : 'var(--txt-2)' }}>{l}</button>))}
              </div>
            </div>}>
          {traj.length < 2 ? <div className="muted" style={{ padding: 40, textAlign: 'center' }}>No time series available for this scope.</div> : (
            <ResponsiveContainer width="100%" height={360}>
              <ComposedChart data={traj} margin={{ top: 10, right: 14, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="dActual" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.32} /><stop offset="100%" stopColor={COLORS.accent} stopOpacity={0.02} /></linearGradient>
                  <linearGradient id="dFore" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.amber} stopOpacity={0.24} /><stop offset="100%" stopColor={COLORS.amber} stopOpacity={0.02} /></linearGradient>
                </defs>
                <CartesianGrid stroke={COLORS.grid} vertical={false} />
                <XAxis dataKey="date" tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(0,0,0,.08)' }} tickFormatter={monthLabel} minTickGap={34} />
                <YAxis tick={{ fill: COLORS.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={metric === 'cases' ? fmt : (v => v.toFixed(1))} width={48} />
                <Tooltip content={<ChartTip unit={metric === 'incidence' ? '' : ''} />} />
                {firstForecast && <ReferenceArea x1={firstForecast} x2={traj[traj.length - 1].date} fill={COLORS.amber} fillOpacity={0.05} />}
                {firstForecast && <ReferenceLine x={firstForecast} stroke="rgba(217,119,6,.5)" strokeDasharray="4 4" label={{ value: 'Forecast →', fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />}
                {hasBand && <Area type="monotone" dataKey="band" name="_band" stroke="none" fill={COLORS.amber} fillOpacity={0.14} connectNulls isAnimationActive={false} />}
                <Area type="monotone" dataKey="actual" name="Actual" stroke={COLORS.accent} strokeWidth={2.4} fill="url(#dActual)" connectNulls dot={false} />
                <Area type="monotone" dataKey="forecast" name="Forecast" stroke={COLORS.amber} strokeWidth={2.4} strokeDasharray="6 4" fill="url(#dFore)" connectNulls dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Seasonal risk calendar */}
        <Card className="col" style={{ flex: 1, minWidth: 300 }}
          title={<span>Seasonal risk calendar
            <InfoTip w={310} text="Average projected caseload for each calendar month across the whole forecast horizon. Hotter tiles = the months this disease is projected to hit hardest. Use it to time campaigns ahead of the red band." /></span>}
          sub="Mean projected load by month — plan campaigns before the hot months">
          {M.hasForecast ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 4 }}>
                {M.seasonal.map(s => {
                  const t = M.sMax > M.sMin ? (s.value - M.sMin) / (M.sMax - M.sMin) : 0
                  const isPeak = M.peak && s.mIdx === M.peak.month
                  return (
                    <div key={s.month} title={`${s.month}: ${fmtFull(s.value)} avg projected`}
                      style={{ background: heat(t), borderRadius: 9, padding: '12px 8px', color: t > 0.45 ? '#fff' : '#0f2230',
                        border: isPeak ? '2px solid #0f2230' : '1px solid rgba(0,0,0,.06)', position: 'relative', cursor: 'default' }}>
                      <div style={{ fontSize: '.72rem', fontWeight: 700, opacity: .9 }}>{s.month}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '.86rem', fontWeight: 600, marginTop: 2 }}>{fmt(s.value)}</div>
                      {isPeak && <div style={{ position: 'absolute', top: 4, right: 5, fontSize: '.7rem' }}>🔴</div>}
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: '.72rem', color: 'var(--txt-2)' }}>
                <span>Low</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${heat(0)}, ${heat(.5)}, ${heat(1)})` }} />
                <span>High</span>
              </div>
              <div className="muted" style={{ fontSize: '.74rem', marginTop: 10, lineHeight: 1.5 }}>
                Hottest window: <b style={{ color: COLORS.coral }}>{[...M.seasonal].sort((a, b) => b.value - a.value).slice(0, 3).map(s => s.month).join(' · ')}</b>. Pre-position nets, RDTs & ACTs in the 4–6 weeks prior.
              </div>
            </>
          ) : <div className="muted" style={{ padding: 30, textAlign: 'center' }}>Needs a forecast horizon to build a seasonal profile.</div>}
        </Card>
      </div>

      {/* ── STATE MOVERS + MOMENTUM GRID ── */}
      <div className="row" style={{ alignItems: 'stretch', marginTop: 18 }}>
        <Card className="col" style={{ flex: 1, minWidth: 360 }}
          title={<span>State forecast leaderboard
            <InfoTip w={310} text="States ranked by their projected 12-month change (next year vs last year). Red bars are worsening; green are improving. Click any state to load its trajectory in the chart above." /></span>}
          sub="Projected 12-month change · click a state to inspect"
          right={<div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
            {[['rising', 'Rising'], ['falling', 'Improving'], ['volume', 'Volume']].map(([k, l]) => (
              <button key={k} onClick={() => setMoverMode(k)} style={{ border: 'none', cursor: 'pointer', padding: '5px 11px', borderRadius: 6, fontSize: '.74rem', fontWeight: 600, fontFamily: 'var(--font)',
                background: moverMode === k ? 'var(--bg-1)' : 'transparent', color: moverMode === k ? 'var(--accent)' : 'var(--txt-2)' }}>{l}</button>))}
          </div>}>
          <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {movers.slice(0, 15).map(m => {
              const w = m.change == null ? 0 : Math.abs(m.change) / moverMax * 100
              const c = m.change == null ? '#cbd5e1' : m.change > 0 ? COLORS.coral : COLORS.green
              return (
                <div key={m.state} onClick={() => focusState(m.state)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '4px 6px', borderRadius: 8 }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-3)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <div style={{ width: 96, fontSize: '.8rem', fontWeight: 600, color: 'var(--txt-0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.state}</div>
                  <div style={{ flex: 1, background: 'var(--bg-3)', borderRadius: 6, height: 20, position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(2, w)}%`, background: c, borderRadius: 6, transition: 'width .4s' }} />
                  </div>
                  <div className="mono" style={{ width: 70, textAlign: 'right', fontSize: '.78rem', fontWeight: 700, color: c }}>
                    {m.change == null ? '—' : (m.change > 0 ? '+' : '') + m.change.toFixed(1) + '%'}
                  </div>
                </div>
              )
            })}
            {!movers.length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>No per-state projections available.</div>}
          </div>
        </Card>

        {/* Momentum grid — a compact heat-tile "cartogram" of every state */}
        <Card className="col" style={{ flex: 1, minWidth: 360 }}
          title={<span>State momentum grid
            <InfoTip w={320} text="Every reporting state as a tile, coloured by its projected 12-month change — a map-like read of where momentum is building (red) or easing (green), independent of the choropleth below. Hover for detail, click to inspect." /></span>}
          sub="Projected change per state · red = building, green = easing">
          {grid.length ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))', gap: 7, position: 'relative' }}>
                {grid.map(m => (
                  <div key={m.state} onClick={() => focusState(m.state)}
                    onMouseEnter={() => setHoverTile(m)} onMouseLeave={() => setHoverTile(null)}
                    style={{ background: diverge(m.change), borderRadius: 8, padding: '9px 7px', cursor: 'pointer', minHeight: 54,
                      color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.35)', border: '1px solid rgba(0,0,0,.05)', transition: 'transform .12s' }}
                    onMouseOver={e => e.currentTarget.style.transform = 'scale(1.05)'} onMouseOut={e => e.currentTarget.style.transform = 'scale(1)'}>
                    <div style={{ fontSize: '.68rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.state}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: '.76rem', fontWeight: 700, marginTop: 3 }}>{m.change == null ? '—' : (m.change > 0 ? '+' : '') + m.change.toFixed(0) + '%'}</div>
                  </div>
                ))}
              </div>
              {hoverTile && (
                <div style={{ marginTop: 12, padding: '10px 13px', background: 'var(--bg-3)', borderRadius: 9, border: '1px solid var(--border)', fontSize: '.8rem' }}>
                  <b style={{ color: 'var(--txt-0)' }}>{hoverTile.state}</b> — projected <b style={{ color: hoverTile.change > 0 ? COLORS.coral : COLORS.green }}>{hoverTile.change == null ? '—' : (hoverTile.change > 0 ? '+' : '') + hoverTile.change.toFixed(1) + '%'}</b> over 12 mo ·
                  <span className="mono"> {fmt(hoverTile.prev12)} → {fmt(hoverTile.next12)}</span> cases
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: '.72rem', color: 'var(--txt-2)' }}>
                <span>Easing</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${diverge(-40)}, ${diverge(0)}, ${diverge(40)})` }} />
                <span>Building</span>
              </div>
            </>
          ) : <div className="muted" style={{ padding: 30, textAlign: 'center' }}>No per-state projections available.</div>}
        </Card>
      </div>

      {/* ── AUTO-GENERATED FORECAST BRIEFING ── */}
      {briefing && (
        <Card style={{ marginTop: 18, background: 'linear-gradient(135deg,var(--bg-2) 0%,var(--bg-elev) 100%)' }}
          title={<span>🧭 Forecast briefing
            <InfoTip w={320} text="An automatically-generated executive read of the projections above — synthesised directly from the model's own numbers (not a language model), so it always matches the charts exactly." /></span>}
          sub={`Auto-generated from the ${label} forecast · updates with the data`}>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {briefing.map((b, i) => (
              <li key={i} style={{ fontSize: '.9rem', lineHeight: 1.6, color: 'var(--txt-1)' }}>
                {b.split(/(\*\*[^*]+\*\*)/g).map((p, k) => p.startsWith('**') && p.endsWith('**')
                  ? <b key={k} style={{ color: 'var(--txt-0)' }}>{p.slice(2, -2)}</b>
                  : <React.Fragment key={k}>{p}</React.Fragment>)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
