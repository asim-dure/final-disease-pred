import React, { useState, useEffect, useRef } from 'react'
import {
  ResponsiveContainer, LineChart, Line, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts'
import { Card, MarkdownLite } from '../components'
import { fmt, fmtFull, monthLabel, COLORS, API_BASE } from '../lib'

// ── API helpers ──────────────────────────────────────────────────────────────
// Callers still pass the familiar '/api/...' path -- rewritten to this app's
// real deployed base (/ews/api/... when embedded) in one place here, so none
// of the many api('/api/...', ...) call sites below needed to change.
const api = (path, body) =>
  fetch(path.replace(/^\/api/, API_BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(e.detail || 'API error'))
    return r.json()
  })

// ── tooltip ──────────────────────────────────────────────────────────────────
const ChartTT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 13px', fontSize: '.8rem', boxShadow: '0 8px 30px rgba(15,34,48,.12)' }}>
      <div style={{ fontWeight: 700, color: 'var(--txt-0)', marginBottom: 5 }}>{monthLabel(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

const axPr = { tick: { fill: 'var(--txt-2)', fontSize: 11 }, tickLine: false, axisLine: { stroke: 'rgba(13,148,136,.12)' } }

// ── searchable multi-select ───────────────────────────────────────────────────
function FeaturePicker({ label, all, selected, onToggle, locked = false, color = COLORS.accent }) {
  const [q, setQ] = useState('')
  const filtered = all.filter(c => c.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)' }}>{label}</span>
        <span style={{ fontSize: '.68rem', color: 'var(--txt-3)' }}>{selected.length} selected</span>
      </div>
      {!locked && (
        <input
          type="text" placeholder="Search features…" value={q} onChange={e => setQ(e.target.value)}
          style={{ width: '100%', marginBottom: 8, fontSize: '.82rem' }}
        />
      )}
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        background: 'var(--bg-2)', padding: '6px 4px' }}>
        {filtered.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--txt-3)', fontSize: '.78rem' }}>No features match</div>}
        {filtered.map(col => {
          const on = selected.includes(col)
          return (
            <button key={col} onClick={() => !locked && onToggle(col)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none',
                background: on ? `${color}14` : 'transparent', cursor: locked ? 'default' : 'pointer',
                padding: '5px 10px', borderRadius: 6, textAlign: 'left', marginBottom: 1,
                borderLeft: on ? `3px solid ${color}` : '3px solid transparent', transition: '.12s' }}>
              <span style={{ flex: 1, fontSize: '.78rem', color: on ? 'var(--txt-0)' : 'var(--txt-1)',
                fontWeight: on ? 600 : 400, lineHeight: 1.3 }}>{col}</span>
              {locked && on && <span style={{ fontSize: '.65rem', color, fontWeight: 700, flexShrink: 0 }}>LOCKED</span>}
              {!locked && on && <span style={{ fontSize: '.7rem', color, fontWeight: 700 }}>✓</span>}
            </button>
          )
        })}
      </div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
          {selected.map(c => (
            <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
              background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 20,
              padding: '2px 9px', fontSize: '.68rem', fontWeight: 600, color }}>
              {c.length > 28 ? c.slice(0, 28) + '…' : c}
              {!locked && (
                <span onClick={() => onToggle(c)} style={{ cursor: 'pointer', marginLeft: 2, fontWeight: 700 }}>×</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── intervention slider card ─────────────────────────────────────────────────
function InterventionCard({ col, pct, onChange, onRemove }) {
  const short = col.length > 40 ? col.slice(0, 40) + '…' : col
  const color = pct >= 0 ? COLORS.green : COLORS.coral
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--txt-0)', flex: 1, lineHeight: 1.3 }} title={col}>{short}</span>
        <button onClick={onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer',
          color: 'var(--txt-3)', fontSize: '.9rem', padding: '0 0 0 8px', flexShrink: 0 }}>×</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="range" min={-80} max={200} value={pct} step={5}
          style={{ flex: 1, '--pct': `${((pct + 80) / 280) * 100}%` }}
          onChange={e => onChange(+e.target.value)} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: '.85rem', fontWeight: 700,
          color, width: 56, textAlign: 'right', flexShrink: 0 }}>
          {pct >= 0 ? '+' : ''}{pct}%
        </span>
      </div>
      <div style={{ fontSize: '.68rem', color: 'var(--txt-3)', marginTop: 3 }}>
        {pct > 0 ? `Scale up by ${pct}% relative to current baseline` : pct < 0 ? `Scale down by ${Math.abs(pct)}%` : 'No change from baseline'}
      </div>
    </div>
  )
}

// ── KPI tile ─────────────────────────────────────────────────────────────────
function KTile({ label, value, sub, color = COLORS.accent }) {
  return (
    <div className="card kpi" style={{ flex: 1, minWidth: 0 }}>
      <div className="accent-bar" style={{ background: color }} />
      <div className="label">{label}</div>
      <div className="value" style={{ color, fontSize: '1.6rem' }}>{value}</div>
      {sub && <div style={{ fontSize: '.72rem', color: 'var(--txt-2)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────
export default function WhatIfLab({ disease = 'malaria' }) {
  const [meta, setMeta] = useState(null)
  const [metaErr, setMetaErr] = useState(null)

  // controls
  const [level, setLevel] = useState('national')
  const [stateName, setStateName] = useState('')
  const [target, setTarget] = useState('MAL - Malaria cases confirmed (number)')
  const [horizon, setHorizon] = useState(12)
  const [mode, setMode] = useState('plugplay')   // 'plugplay' | 'whatif'

  // plug & play covariates
  const [covariates, setCovariates] = useState([])

  // what-if interventions: { col: pct }
  const [interventions, setInterventions] = useState({})
  const [intPickerOpen, setIntPickerOpen] = useState(false)

  // results
  const [running, setRunning] = useState(false)
  const [runErr, setRunErr] = useState(null)
  const [result, setResult] = useState(null)   // { history, forecast, base, whatif, population }

  // budget
  const [budgeting, setBudgeting] = useState(false)
  const [budgetErr, setBudgetErr] = useState(null)
  const [budgetPlan, setBudgetPlan] = useState(null)
  const [budgetMode, setBudgetMode] = useState('forward')   // 'forward' | 'reverse'
  const [budgetNgn, setBudgetNgn] = useState(5000000000)    // reverse-mode budget input
  const [lastBudgetNgn, setLastBudgetNgn] = useState(null)  // budget tied to current plan (for saving)
  const [budgetGeneric, setBudgetGeneric] = useState(false) // true when this disease has no unit-cost table

  // proposals (versioned, persisted server-side)
  const [proposals, setProposals] = useState([])
  const [compareIds, setCompareIds] = useState([])
  const [viewProposal, setViewProposal] = useState(null)
  const [savedNote, setSavedNote] = useState(null)
  const USD_NGN = 1600

  // AI-generated narrative comparison across selected proposals
  const [aiCompare, setAiCompare] = useState(null)
  const [aiComparing, setAiComparing] = useState(false)
  const [aiCompareErr, setAiCompareErr] = useState(null)

  const loadProposals = () => fetch(`${API_BASE}/proposals?disease=${encodeURIComponent(disease)}`).then(r => r.json()).then(setProposals).catch(() => {})

  // load meta + proposals on mount (re-fetch meta when the selected disease changes)
  useEffect(() => {
    setMeta(null); setMetaErr(null)
    fetch(`${API_BASE}/meta?disease=${encodeURIComponent(disease)}`).then(r => r.json()).then(setMeta).catch(e => setMetaErr(String(e)))
    loadProposals()
  }, [disease])

  // keep target/covariates/interventions valid whenever meta changes (e.g. disease switch)
  useEffect(() => {
    if (!meta) return
    if (!meta.targets.includes(target)) setTarget(meta.targets[0] || '')
    setCovariates([])
    setInterventions({})
    setResult(null)
  }, [meta])

  // Removing a covariate that's currently an active intervention lever drops
  // that lever too -- interventions are only ever a SUBSET of the chosen
  // covariates (see intCandidates below), so a lever can't outlive the
  // covariate selection that made it available.
  const toggleCov = col => setCovariates(s => {
    const next = s.includes(col) ? s.filter(x => x !== col) : [...s, col]
    if (!next.includes(col)) setInterventions(iv => { if (!(col in iv)) return iv; const n = { ...iv }; delete n[col]; return n })
    return next
  })
  const toggleInt = col => setInterventions(s => col in s ? (() => { const n = { ...s }; delete n[col]; return n })() : { ...s, [col]: 10 })
  const setIntPct = (col, pct) => setInterventions(s => ({ ...s, [col]: pct }))
  const removeInt = col => setInterventions(s => { const n = { ...s }; delete n[col]; return n })

  const run = async () => {
    setRunning(true); setRunErr(null); setResult(null); setBudgetPlan(null); setBudgetErr(null)
    try {
      const body = { level, state_name: level === 'state' ? stateName : null, target, horizon, covariates, disease }
      if (mode === 'plugplay') {
        const r = await api('/api/forecast', body)
        setResult({ history: r.history, forecast: r.forecast, population: r.population })
      } else {
        const r = await api('/api/whatif', { ...body, interventions: Object.fromEntries(Object.entries(interventions).map(([k, v]) => [k, v])) })
        setResult({ history: r.history, base: r.base, whatif: r.whatif, population: r.population })
      }
    } catch (e) {
      setRunErr(String(e))
    }
    setRunning(false)
  }

  // FORWARD: interventions → detailed month-wise budget plan (or, for diseases
  // with no unit-cost table, a generic indicative budget + prevention report)
  const generateBudget = async () => {
    if (!result) return
    setBudgeting(true); setBudgetErr(null); setBudgetPlan(null); setLastBudgetNgn(null)
    try {
      const fc = result.whatif || result.forecast
      const baseArr = result.base || result.forecast || []
      const baseMean = baseArr.length ? baseArr.reduce((a, b) => a + b.cases, 0) / baseArr.length : 0
      const wiMean = fc ? fc.reduce((a, b) => a + b.cases, 0) / fc.length : 0
      const r = await api('/api/budget', {
        level, state_name: level === 'state' ? stateName : null,
        target, interventions,
        base_monthly_cases: baseMean, whatif_monthly_cases: wiMean,
        population: result.population, horizon,
        months: (fc || []).map(d => d.date),
        base_monthly: baseArr.map(d => d.cases),
        whatif_monthly: (fc || []).map(d => d.cases),
        disease,
      })
      setBudgetPlan(r.plan)
      setBudgetGeneric(!!r.generic)
    } catch (e) { setBudgetErr(String(e)) }
    setBudgeting(false)
  }

  // REVERSE: budget → AI picks interventions, then closed-loop SARIMAX on the chart
  const optimizeBudget = async () => {
    setBudgeting(true); setBudgetErr(null); setBudgetPlan(null); setRunErr(null)
    try {
      const r = await api('/api/budget-optimize', {
        level, state_name: level === 'state' ? stateName : null,
        target, horizon, budget_ngn: budgetNgn, disease,
      })
      setInterventions(r.interventions || {})
      setMode('whatif')
      setResult({ history: r.history, base: r.base, whatif: r.whatif, population: r.population })
      setBudgetPlan(r.plan)
      setLastBudgetNgn(budgetNgn)
    } catch (e) { setBudgetErr(String(e)) }
    setBudgeting(false)
  }

  const saveProposal = async () => {
    if (!budgetPlan || !result) return
    const baseArr = result.base || result.forecast || []
    const fc = result.whatif || result.forecast || []
    const bt = baseArr.reduce((a, b) => a + b.cases, 0)
    const wt = fc.reduce((a, b) => a + b.cases, 0)
    const averted = bt - wt
    const rec = {
      mode: budgetMode,
      level, state_name: level === 'state' ? stateName : null, horizon,
      interventions,
      budget_ngn: lastBudgetNgn,
      summary: { base_total: Math.round(bt), whatif_total: Math.round(wt), averted: Math.round(averted),
        cost_per_case: lastBudgetNgn && averted > 0 ? Math.round(lastBudgetNgn / averted) : null },
      plan: budgetPlan,
      disease,
      // saved so a later AI Compare can re-cite real per-month figures (capped server-side)
      months: fc.map(d => d.date),
      base_monthly: baseArr.map(d => d.cases),
      whatif_monthly: fc.map(d => d.cases),
    }
    const saved = await api('/api/proposals', rec)
    setSavedNote(`Saved as v${saved.version}`)
    setTimeout(() => setSavedNote(null), 2500)
    loadProposals()
  }

  // AI-generated narrative comparison across 2+ selected proposals
  const runAiCompare = async () => {
    setAiComparing(true); setAiCompareErr(null); setAiCompare(null)
    try {
      const r = await api('/api/compare-proposals', { proposal_ids: compareIds, disease })
      setAiCompare(r.comparison)
    } catch (e) { setAiCompareErr(String(e)) }
    setAiComparing(false)
  }

  const deleteProposal = async (id) => {
    await fetch(`${API_BASE}/proposals/${id}`, { method: 'DELETE' })
    setCompareIds(s => s.filter(x => x !== id))
    if (viewProposal?.id === id) setViewProposal(null)
    loadProposals()
  }
  const fmtNgn = v => v == null ? '—' : '₦' + Number(v).toLocaleString()
  const fmtUsd = v => v == null ? '—' : '$' + Math.round(Number(v) / USD_NGN).toLocaleString()

  // chart data: merge history + forecast into one array
  const chartData = (() => {
    if (!result) return []
    const rows = {}
    ;(result.history || []).forEach(d => { rows[d.date] = { date: d.date, Historical: d.cases } })
    if (result.forecast) {
      result.forecast.forEach(d => {
        rows[d.date] = { ...(rows[d.date] || { date: d.date }), Forecast: d.cases, FLower: d.lower, FUpper: d.upper }
      })
    }
    if (result.base) {
      result.base.forEach(d => {
        rows[d.date] = { ...(rows[d.date] || { date: d.date }), 'Base Forecast': d.cases }
      })
    }
    if (result.whatif) {
      result.whatif.forEach(d => {
        rows[d.date] = { ...(rows[d.date] || { date: d.date }), 'What-If': d.cases }
      })
    }
    // bridge: last history point seeds forecast lines
    const sorted = Object.values(rows).sort((a, b) => a.date.localeCompare(b.date))
    const lastHist = sorted.filter(d => d.Historical != null).pop()
    if (lastHist) {
      if (result.forecast) lastHist.Forecast = lastHist.Historical
      if (result.base) lastHist['Base Forecast'] = lastHist.Historical
      if (result.whatif) lastHist['What-If'] = lastHist.Historical
    }
    return sorted
  })()

  const splitDate = result ? (result.history || []).slice(-1)[0]?.date : null

  // summary numbers
  const baseCases = result?.base ? result.base.reduce((a, b) => a + b.cases, 0) : 0
  const wiCases = result?.whatif ? result.whatif.reduce((a, b) => a + b.cases, 0) : 0
  const averted = baseCases - wiCases
  const fcCases = result?.forecast ? result.forecast.reduce((a, b) => a + b.cases, 0) : 0

  if (metaErr) return (
    <div className="loading" style={{ color: COLORS.coral, flexDirection: 'column', gap: 8 }}>
      <b>Could not connect to the forecast API.</b>
      <span style={{ fontSize: '.82rem' }}>Start the backend: <code>python api.py</code> in the project root.</span>
      <span style={{ fontSize: '.75rem', color: 'var(--txt-3)' }}>{metaErr}</span>
    </div>
  )

  if (!meta) return <div className="loading"><div className="spinner" />Connecting to forecast API…</div>

  return (
    <>
      <div className="view-head">
        <h2>Budget Planning</h2>
        <p>
          Run SARIMAX forecasts at national or state level using any combination of covariates.
          In What-If mode, scale intervention levers to see how malaria cases respond — then generate
          a value-for-money budget plan with Groq AI.
        </p>
      </div>

      {/* ── mode tabs ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, background: 'var(--bg-3)',
        border: '1px solid var(--border)', borderRadius: 12, padding: 4, width: 'fit-content' }}>
        {[['plugplay', '🔌 Plug & Play'], ['whatif', '🎯 What-If']].map(([m, lbl]) => (
          <button key={m} onClick={() => setMode(m)}
            style={{ border: 'none', cursor: 'pointer', padding: '8px 20px', borderRadius: 9,
              fontFamily: 'var(--font)', fontSize: '.9rem', fontWeight: 700, transition: '.15s',
              background: mode === m ? 'var(--bg-1)' : 'transparent',
              color: mode === m ? 'var(--accent)' : 'var(--txt-2)',
              boxShadow: mode === m ? '0 1px 6px rgba(0,0,0,.2)' : 'none' }}>
            {lbl}
          </button>
        ))}
      </div>

      {/* ── top controls ── */}
      <div className="controls" style={{ marginBottom: 22 }}>
        <div className="select-wrap">
          <label>Level</label>
          <select value={level} onChange={e => { setLevel(e.target.value); setStateName('') }} style={{ minWidth: 150 }}>
            <option value="national">Nigeria (National)</option>
            <option value="state">State</option>
          </select>
        </div>
        {level === 'state' && (
          <div className="select-wrap">
            <label>State</label>
            <select value={stateName} onChange={e => setStateName(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">— select —</option>
              {meta.states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        <div className="select-wrap">
          <label>Target indicator</label>
          <select value={target} onChange={e => setTarget(e.target.value)} style={{ minWidth: 260 }}>
            {meta.targets.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="select-wrap">
          <label>Horizon (months)</label>
          <select value={horizon} onChange={e => setHorizon(+e.target.value)}>
            {[6, 12, 18, 24].map(h => <option key={h} value={h}>{h} months</option>)}
          </select>
        </div>
        <button className="btn" onClick={run} disabled={running || (level === 'state' && !stateName)}
          style={{ background: 'var(--accent)', color: '#fff', fontWeight: 700, borderColor: 'var(--accent)',
            opacity: running ? .6 : 1, cursor: running ? 'not-allowed' : 'pointer' }}>
          {running ? '⏳ Running…' : '▶ Run SARIMAX'}
        </button>
      </div>

      {runErr && (
        <div style={{ background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 10,
          padding: '12px 16px', color: COLORS.coral, fontSize: '.84rem', marginBottom: 16 }}>
          <b>Error:</b> {runErr}
        </div>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {/* ── left panel ── */}
        <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* plug & play covariate picker */}
          <Card title="Covariates" sub="Add any features as SARIMAX exogenous inputs">
            <FeaturePicker
              label="All available features"
              all={meta.all_numeric}
              selected={covariates}
              onToggle={toggleCov}
              color={COLORS.accent2}
            />
          </Card>

          {/* what-if intervention panel */}
          {mode === 'whatif' && (() => {
            // Only covariates the user actually picked above (as SARIMAX
            // dependencies) that are ALSO programmatic/actionable are offered
            // as intervention levers -- pick the factors that matter first,
            // then adjust weights only for those, so the lever list can never
            // drift out of sync with what the model is actually conditioned on.
            const intCandidates = covariates.filter(c => meta.intervention_cols.includes(c))
            return (
            <Card title="Intervention Levers"
              sub="Only covariates selected above (left) that are programmatic/actionable show up here.">

              {/* locked baseline notice */}
              <div style={{ background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.35)', borderRadius: 8,
                padding: '9px 12px', fontSize: '.75rem', color: 'var(--green)', marginBottom: 12 }}>
                🔒 Baseline parameters (climate, geography, poverty, NDVI, ENSO) are locked —
                only health-system supply features can be intervened on.
              </div>

              {intCandidates.length === 0 ? (
                <div style={{ color: 'var(--txt-3)', fontSize: '.78rem', textAlign: 'center', padding: '12px 0', lineHeight: 1.6 }}>
                  No actionable covariates selected yet. Add one or more programmatic features
                  (e.g. ACT, LLIN, RDT, IPTp) in the <b>Covariates</b> picker above first — they'll
                  appear here to turn into intervention levers.
                </div>
              ) : (
                <>
                  {/* add intervention button */}
                  <button onClick={() => setIntPickerOpen(p => !p)}
                    style={{ width: '100%', padding: '8px 12px', background: `${COLORS.accent}12`,
                      border: `1px dashed ${COLORS.accent}60`, borderRadius: 8, cursor: 'pointer',
                      color: COLORS.accent, fontWeight: 700, fontSize: '.84rem', marginBottom: 10 }}>
                    {intPickerOpen ? '▲ Close picker' : '＋ Add intervention'}
                  </button>

                  {intPickerOpen && (
                    <div style={{ marginBottom: 12 }}>
                      <FeaturePicker
                        label="Actionable features (from your selected covariates)"
                        all={intCandidates}
                        selected={Object.keys(interventions)}
                        onToggle={toggleInt}
                        color={COLORS.accent}
                      />
                    </div>
                  )}

                  {Object.keys(interventions).length === 0 && !intPickerOpen && (
                    <div style={{ color: 'var(--txt-3)', fontSize: '.78rem', textAlign: 'center', padding: '12px 0' }}>
                      No interventions added yet. Click above to add.
                    </div>
                  )}
                </>
              )}

              {Object.entries(interventions).map(([col, pct]) => (
                <InterventionCard key={col} col={col} pct={pct}
                  onChange={v => setIntPct(col, v)}
                  onRemove={() => removeInt(col)} />
              ))}
            </Card>
            )
          })()}
        </div>

        {/* ── right panel ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* empty state */}
          {!result && !running && (
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 16,
              padding: '48px 32px', textAlign: 'center', color: 'var(--txt-3)' }}>
              <div style={{ fontSize: '2.4rem', marginBottom: 12 }}>📈</div>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--txt-1)', marginBottom: 6 }}>
                Configure and run a forecast
              </div>
              <div style={{ fontSize: '.84rem', maxWidth: 380, margin: '0 auto', lineHeight: 1.55 }}>
                {mode === 'plugplay'
                  ? 'Select a level, target, and optional covariates, then click Run SARIMAX to see the forecast.'
                  : 'Select a level + target, add intervention levers on the left, then run to compare base vs what-if.'}
              </div>
            </div>
          )}

          {/* loading skeleton */}
          {running && (
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 16,
              padding: '60px 32px', textAlign: 'center', color: 'var(--txt-2)' }}>
              <div className="spinner" style={{ margin: '0 auto 14px', width: 28, height: 28, borderWidth: 3 }} />
              <div style={{ fontWeight: 600 }}>Fitting SARIMAX model…</div>
              <div style={{ fontSize: '.78rem', marginTop: 6, color: 'var(--txt-3)' }}>This may take 5–15 seconds depending on data size.</div>
            </div>
          )}

          {/* results */}
          {result && !running && (
            <>
              {/* KPIs */}
              <div style={{ display: 'flex', gap: 14 }}>
                {mode === 'plugplay' && (
                  <KTile label={`Forecast total · ${horizon}mo`} value={fmt(fcCases)}
                    sub={`${horizon}-month projected cases`} color={COLORS.amber} />
                )}
                {mode === 'whatif' && <>
                  <KTile label="Base forecast total" value={fmt(baseCases)}
                    sub="Without interventions" color={COLORS.accent2} />
                  <KTile label="What-If forecast total" value={fmt(wiCases)}
                    sub="With interventions" color={averted >= 0 ? COLORS.green : COLORS.coral} />
                  <KTile label={averted >= 0 ? 'Cases averted' : 'Extra cases'} value={fmt(Math.abs(averted))}
                    sub={`${averted >= 0 ? '−' : '+'}${Math.abs(((baseCases - wiCases) / (baseCases || 1)) * 100).toFixed(1)}% vs base`}
                    color={averted >= 0 ? COLORS.green : COLORS.coral} />
                </>}
              </div>

              {/* chart */}
              <Card title={`SARIMAX Forecast — ${level === 'national' ? 'Nigeria (National)' : stateName}`}
                sub={`Target: ${target} · Horizon: ${horizon} months${covariates.length ? ` · ${covariates.length} covariate${covariates.length > 1 ? 's' : ''}` : ' · univariate'}`}>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={chartData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                    <XAxis dataKey="date" {...axPr} tickFormatter={monthLabel} minTickGap={36} />
                    <YAxis {...axPr} tickFormatter={fmt} width={52} />
                    <Tooltip content={<ChartTT />} />
                    {splitDate && (
                      <ReferenceLine x={splitDate} stroke="rgba(217,119,6,.5)" strokeDasharray="4 4"
                        label={{ value: 'Forecast →', fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />
                    )}
                    <Legend wrapperStyle={{ fontSize: '.78rem', color: 'var(--txt-1)' }} />
                    <Line type="monotone" dataKey="Historical" name="Historical" stroke={COLORS.accent}
                      strokeWidth={2.4} dot={false} connectNulls />
                    {result.forecast && (
                      <Line type="monotone" dataKey="Forecast" name="SARIMAX Forecast" stroke={COLORS.amber}
                        strokeWidth={2.2} strokeDasharray="6 4" dot={false} connectNulls />
                    )}
                    {result.base && (
                      <Line type="monotone" dataKey="Base Forecast" name="Base (no intervention)" stroke={COLORS.accent2}
                        strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                    )}
                    {result.whatif && (
                      <Line type="monotone" dataKey="What-If" name={`What-If (${Object.keys(interventions).length} intervention${Object.keys(interventions).length !== 1 ? 's' : ''})`}
                        stroke={averted >= 0 ? COLORS.green : COLORS.coral}
                        strokeWidth={2.6} dot={false} connectNulls />
                    )}
                  </LineChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '.72rem', color: 'var(--txt-2)' }}>
                    Solid teal = historical. Dashed = baseline SARIMAX projection.
                    {mode === 'whatif' ? ' Solid coloured = What-If scenario.' : ''}
                  </span>
                </div>
              </Card>

              {/* confidence band table */}
              {(result.forecast || result.base) && (
                <Card title="Forecast detail" sub="Monthly point estimate with 95% confidence interval">
                  <div className="tbl-scroll" style={{ maxHeight: 240 }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Month</th>
                          {result.forecast && <><th className="num">Forecast</th><th className="num">Lower 95%</th><th className="num">Upper 95%</th></>}
                          {result.base && <><th className="num">Base</th><th className="num">What-If</th><th className="num">Δ Cases</th></>}
                        </tr>
                      </thead>
                      <tbody>
                        {(result.forecast || result.base || []).map((r, i) => {
                          const wi = result.whatif?.[i]
                          const delta = wi ? r.cases - wi.cases : null
                          return (
                            <tr key={r.date}>
                              <td>{monthLabel(r.date)}</td>
                              {result.forecast && <>
                                <td className="num">{fmtFull(r.cases)}</td>
                                <td className="num" style={{ color: 'var(--txt-2)' }}>{fmtFull(r.lower)}</td>
                                <td className="num" style={{ color: 'var(--txt-2)' }}>{fmtFull(r.upper)}</td>
                              </>}
                              {result.base && <>
                                <td className="num">{fmtFull(r.cases)}</td>
                                <td className="num" style={{ color: averted >= 0 ? COLORS.green : COLORS.coral }}>{fmtFull(wi?.cases)}</td>
                                <td className="num" style={{ color: delta >= 0 ? COLORS.green : COLORS.coral }}>
                                  {delta != null ? (delta >= 0 ? '−' : '+') + fmtFull(Math.abs(delta)) : '—'}
                                </td>
                              </>}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

            </>
          )}
        </div>
      </div>

      {/* ═══ BUDGET PLANNING (forward + reverse) + SAVED PROPOSALS ═══ */}
      <div className="row" style={{ marginTop: 18, alignItems: 'flex-start' }}>
        <Card className="col" style={{ flex: 2, minWidth: 460 }}
          title="Budget Planning"
          sub="Detailed month-wise plan via Groq llama-3.1-8b-instant — in both ₦ and USD"
          right={
            <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
              {[['forward', 'Interventions → Budget'], ['reverse', 'Budget → Interventions']].map(([k, lbl]) => (
                <button key={k} onClick={() => setBudgetMode(k)} style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
                  fontSize: '.76rem', fontWeight: 600, fontFamily: 'var(--font)', background: budgetMode === k ? 'var(--bg-1)' : 'transparent',
                  color: budgetMode === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>
              ))}
            </div>
          }>

          {/* FORWARD */}
          {budgetMode === 'forward' && (
            <div style={{ marginBottom: 12 }}>
              {!result ? (
                <div style={{ color: 'var(--txt-2)', fontSize: '.84rem', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                  Run a forecast above first, then generate a budget &amp; prevention plan from it.
                </div>
              ) : disease === 'malaria' && (mode !== 'whatif' || Object.keys(interventions).length === 0) ? (
                <div style={{ color: 'var(--txt-2)', fontSize: '.84rem', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                  Run a <b>What-If</b> forecast with at least one intervention above, then generate a full
                  month-by-month budget for all {horizon} forecast months (units, ₦/USD cost, cumulative spend, cases averted).
                </div>
              ) : (
                <>
                  {disease !== 'malaria' && (
                    <div style={{ fontSize: '.74rem', color: 'var(--txt-3)', marginBottom: 8 }}>
                      {Object.keys(interventions).length > 0
                        ? 'No ₦ unit-cost table exists for this disease yet — the report below will be disease-specific but cost figures are literature-based estimates, clearly labeled.'
                        : 'No driver/intervention dataset exists for this disease — the report below will be a generic, clearly-labeled budget + prevention framework, not fabricated as disease-specific.'}
                    </div>
                  )}
                  <button onClick={generateBudget} disabled={budgeting}
                    style={{ padding: '10px 22px', background: COLORS.violet, color: '#fff', border: 'none', borderRadius: 10,
                      cursor: budgeting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.88rem', fontFamily: 'var(--font)', opacity: budgeting ? .6 : 1 }}>
                    💰 Generate {disease === 'malaria' ? 'month-wise budget plan' : 'budget & prevention report'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* REVERSE — requires a real grounded unit-cost table; malaria only today */}
          {budgetMode === 'reverse' && (
            disease !== 'malaria' ? (
              <div style={{ color: 'var(--txt-2)', fontSize: '.84rem', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                Budget → Interventions optimisation requires a grounded ₦ unit-cost table to allocate spend against,
                which is not yet configured for this disease. Only malaria has one today. Use "Interventions → Budget"
                above for a generic/indicative report instead.
              </div>
            ) : (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--txt-2)', fontSize: '.84rem', marginBottom: 10, lineHeight: 1.55 }}>
                Enter a total budget — the AI picks the best intervention mix within it, then we run SARIMAX to project the actual impact.
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="select-wrap">
                  <label>Total budget (₦)</label>
                  <input type="text" value={budgetNgn.toLocaleString()} onChange={e => setBudgetNgn(Math.max(0, +e.target.value.replace(/[^0-9]/g, '') || 0))}
                    style={{ minWidth: 200, fontFamily: 'var(--mono)' }} />
                </div>
                <div style={{ fontSize: '.82rem', color: 'var(--txt-2)', paddingBottom: 9 }}>= <b>{fmtUsd(budgetNgn)}</b> <span className="muted">(at ₦{USD_NGN.toLocaleString()}/$)</span></div>
                <button onClick={optimizeBudget} disabled={budgeting || (level === 'state' && !stateName)}
                  style={{ padding: '9px 20px', background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 10,
                    cursor: budgeting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.86rem', fontFamily: 'var(--font)', opacity: budgeting ? .6 : 1 }}>
                  🎯 Optimize within budget
                </button>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1e9, 5e9, 2e10].map(v => (
                    <button key={v} className="btn" onClick={() => setBudgetNgn(v)} style={{ padding: '6px 10px', fontSize: '.74rem' }}>{fmt(v).replace('B', 'B').replace('K', 'K')}</button>
                  ))}
                </div>
              </div>
            </div>
            )
          )}

          {budgeting && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--txt-2)' }}>
              <div className="spinner" style={{ margin: '0 auto 10px', borderTopColor: COLORS.violet }} />
              <div style={{ fontWeight: 600 }}>{budgetMode === 'reverse' ? 'AI optimizing interventions for your budget…' : 'Generating budget & prevention report…'}</div>
            </div>
          )}
          {budgetErr && (
            <div style={{ color: COLORS.coral, fontSize: '.82rem', background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 8, padding: '10px 14px' }}>
              <b>Budget error:</b> {budgetErr}
              <div style={{ marginTop: 6, color: 'var(--txt-3)', fontSize: '.75rem' }}>Make sure GROQ_API_KEY is set in your .env file.</div>
            </div>
          )}

          {budgetPlan && !budgeting && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: '.72rem', color: 'var(--txt-3)' }}>Generated by llama-3.1-8b-instant via Groq</span>
                  {budgetGeneric && (
                    <span style={{ fontSize: '.66rem', fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'rgba(217,119,6,.14)', color: COLORS.amber }}>
                      GENERIC / INDICATIVE
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {savedNote && <span style={{ fontSize: '.74rem', color: COLORS.green, fontWeight: 700 }}>✓ {savedNote}</span>}
                  <button onClick={saveProposal} style={{ padding: '6px 14px', background: COLORS.accent2, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '.76rem' }}>
                    💾 Save as Proposal v{(proposals.reduce((m, p) => Math.max(m, p.version || 0), 0)) + 1}
                  </button>
                </div>
              </div>
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px',
                maxHeight: 620, overflowY: 'auto' }}>
                <MarkdownLite text={budgetPlan} />
              </div>
            </>
          )}
        </Card>

        {/* SAVED PROPOSALS — always on the side */}
        <Card className="col" style={{ flex: 1, minWidth: 280 }}
          title={`Saved Proposals (${proposals.length})`}
          sub="Each generation is versioned — view, compare or delete">
          {proposals.length === 0 && <div style={{ color: 'var(--txt-3)', fontSize: '.82rem', padding: '8px 0' }}>No proposals yet. Generate a plan and click <b>Save</b>.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
            {[...proposals].sort((a, b) => b.version - a.version).map(p => {
              const inCmp = compareIds.includes(p.id)
              return (
                <div key={p.id} style={{ border: `1px solid ${inCmp ? COLORS.accent : 'var(--border)'}`, borderRadius: 9, padding: '10px 12px', background: 'var(--bg-1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <b style={{ fontSize: '.84rem', color: 'var(--txt-0)' }}>Proposal v{p.version}</b>
                    <span style={{ fontSize: '.64rem', fontWeight: 700, padding: '2px 7px', borderRadius: 12,
                      background: p.mode === 'reverse' ? 'rgba(13,148,136,.14)' : 'rgba(124,58,237,.14)',
                      color: p.mode === 'reverse' ? COLORS.accent : COLORS.violet }}>{p.mode === 'reverse' ? 'Budget→Plan' : 'Plan→Budget'}</span>
                  </div>
                  <div style={{ fontSize: '.7rem', color: 'var(--txt-2)', marginTop: 3 }}>
                    {p.budget_ngn ? `Budget ${fmtNgn(p.budget_ngn)}` : `${Object.keys(p.interventions || {}).length} interventions`}
                    {p.summary?.averted != null && <> · averts <b style={{ color: COLORS.green }}>{fmt(p.summary.averted)}</b></>}
                  </div>
                  <div style={{ fontSize: '.64rem', color: 'var(--txt-3)', marginTop: 2 }}>{(p.created || '').replace('T', ' ').replace('+00:00', ' UTC')}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button onClick={() => setViewProposal(p)} className="btn" style={{ padding: '4px 10px', fontSize: '.72rem' }}>View</button>
                    <button onClick={() => { setCompareIds(s => inCmp ? s.filter(x => x !== p.id) : [...s, p.id]); setAiCompare(null); setAiCompareErr(null) }} className="btn"
                      style={{ padding: '4px 10px', fontSize: '.72rem', borderColor: inCmp ? COLORS.accent : 'var(--border)', color: inCmp ? COLORS.accent : 'var(--txt-1)' }}>
                      {inCmp ? '✓ Compare' : 'Compare'}
                    </button>
                    <button onClick={() => deleteProposal(p.id)} className="btn" style={{ padding: '4px 10px', fontSize: '.72rem', marginLeft: 'auto', color: COLORS.coral, borderColor: 'rgba(251,113,133,.4)' }}>✕</button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      {/* COMPARE selected proposals */}
      {compareIds.length >= 2 && (
        <Card style={{ marginTop: 18 }} title={`Compare ${compareIds.length} proposals`}
          sub="Side-by-side — see how a changed budget reshapes the plan"
          right={<button className="btn" onClick={() => { setCompareIds([]); setAiCompare(null); setAiCompareErr(null) }}>Clear</button>}>
          <div className="tbl-scroll" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead><tr><th>Metric</th>{compareIds.map(id => { const p = proposals.find(x => x.id === id); return <th key={id} className="num">v{p?.version}</th> })}</tr></thead>
              <tbody>
                {[
                  ['Mode', p => p.mode === 'reverse' ? 'Budget→Plan' : 'Plan→Budget'],
                  ['Budget (₦)', p => p.budget_ngn ? fmtNgn(p.budget_ngn) : '—'],
                  ['Budget ($)', p => p.budget_ngn ? fmtUsd(p.budget_ngn) : '—'],
                  ['Horizon (mo)', p => p.horizon],
                  ['Interventions', p => Object.entries(p.interventions || {}).map(([k, v]) => `${k.split(' ')[0]} ${v > 0 ? '+' : ''}${v}%`).join(', ') || '—'],
                  ['Cases averted', p => p.summary?.averted != null ? fmt(p.summary.averted) : '—'],
                  ['Cost per case (₦)', p => p.summary?.cost_per_case ? fmtNgn(p.summary.cost_per_case) : '—'],
                ].map(([label, fn]) => (
                  <tr key={label}><td><b>{label}</b></td>{compareIds.map(id => { const p = proposals.find(x => x.id === id); return <td key={id} className="num" style={{ fontSize: '.78rem' }}>{p ? fn(p) : '—'}</td> })}</tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <button onClick={runAiCompare} disabled={aiComparing}
              style={{ padding: '9px 18px', background: COLORS.violet, color: '#fff', border: 'none', borderRadius: 10,
                cursor: aiComparing ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.84rem', fontFamily: 'var(--font)', opacity: aiComparing ? .6 : 1 }}>
              🤖 {aiComparing ? 'Comparing…' : 'AI Compare'}
            </button>
            <span style={{ fontSize: '.72rem', color: 'var(--txt-3)', marginLeft: 10 }}>
              What each forecast showed and what its budget was — only through {/* cap label */}May 2027.
            </span>

            {aiComparing && (
              <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--txt-2)' }}>
                <div className="spinner" style={{ margin: '0 auto 8px', borderTopColor: COLORS.violet }} />
                AI is comparing the forecasts and budgets…
              </div>
            )}
            {aiCompareErr && (
              <div style={{ color: COLORS.coral, fontSize: '.82rem', background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 8, padding: '10px 14px', marginTop: 10 }}>
                <b>Compare error:</b> {aiCompareErr}
              </div>
            )}
            {aiCompare && !aiComparing && (
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginTop: 12, maxHeight: 520, overflowY: 'auto' }}>
                <MarkdownLite text={aiCompare} />
              </div>
            )}
          </div>
        </Card>
      )}

      {/* VIEW a saved proposal */}
      {viewProposal && (
        <Card style={{ marginTop: 18 }} title={`Proposal v${viewProposal.version} · ${viewProposal.mode === 'reverse' ? 'Budget → Interventions' : 'Interventions → Budget'}`}
          sub={`${viewProposal.budget_ngn ? `Budget ${fmtNgn(viewProposal.budget_ngn)} (${fmtUsd(viewProposal.budget_ngn)}) · ` : ''}${(viewProposal.created || '').replace('T', ' ').replace('+00:00', ' UTC')}`}
          right={<button className="btn" onClick={() => setViewProposal(null)}>Close</button>}>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px',
            maxHeight: 560, overflowY: 'auto' }}>
            <MarkdownLite text={viewProposal.plan} />
          </div>
        </Card>
      )}
    </>
  )
}
