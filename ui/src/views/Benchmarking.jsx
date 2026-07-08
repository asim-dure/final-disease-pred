import React, { useState, useEffect, useCallback } from 'react'
import { Card, MarkdownLite, CompareChart } from '../components'
import { COLORS, API_BASE } from '../lib'

// Multi-select peer picker — same searchable-list pattern as WhatIfLab's
// FeaturePicker, kept local here since this is the only other place it's
// needed. `itemNoun` names what's being searched/picked ("LGAs" / "states")
// so the search placeholder is never mislabeled when this list holds states
// instead of LGAs.
function PeerPicker({ label, all, selected, onToggle, color = COLORS.accent2, itemNoun = 'LGAs' }) {
  const [q, setQ] = useState('')
  const filtered = all.filter(c => c.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)' }}>{label}</span>
        <span style={{ fontSize: '.68rem', color: 'var(--txt-3)' }}>{selected.length} selected</span>
      </div>
      <input type="text" placeholder={`Search ${itemNoun}…`} value={q} onChange={e => setQ(e.target.value)}
        style={{ width: '100%', marginBottom: 8, fontSize: '.82rem' }} />
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        background: 'var(--bg-2)', padding: '6px 4px' }}>
        {filtered.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--txt-3)', fontSize: '.78rem' }}>No {itemNoun} match</div>}
        {filtered.map(lga => {
          const on = selected.includes(lga)
          return (
            <button key={lga} onClick={() => onToggle(lga)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none',
                background: on ? `${color}14` : 'transparent', cursor: 'pointer',
                padding: '5px 10px', borderRadius: 6, textAlign: 'left', marginBottom: 1,
                borderLeft: on ? `3px solid ${color}` : '3px solid transparent', transition: '.12s' }}>
              <span style={{ flex: 1, fontSize: '.78rem', color: on ? 'var(--txt-0)' : 'var(--txt-1)', fontWeight: on ? 600 : 400 }}>{lga}</span>
              {on && <span style={{ fontSize: '.7rem', color, fontWeight: 700 }}>✓</span>}
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
              {c}
              <span onClick={() => onToggle(c)} style={{ cursor: 'pointer', marginLeft: 2, fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Single-select state picker -- visually IDENTICAL to PeerPicker (same
// search box + list styling) so "Primary state" and "Compare against these
// states" read as two equal, parallel pickers side by side, instead of a
// plain native <select> sitting above a much taller custom list.
function SingleStatePicker({ label, all, value, onChange, color = COLORS.amber }) {
  const [q, setQ] = useState('')
  const filtered = all.filter(c => c.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)' }}>{label}</span>
      </div>
      <input type="text" placeholder="Search states…" value={q} onChange={e => setQ(e.target.value)}
        style={{ width: '100%', marginBottom: 8, fontSize: '.82rem' }} />
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        background: 'var(--bg-2)', padding: '6px 4px' }}>
        {filtered.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--txt-3)', fontSize: '.78rem' }}>No states match</div>}
        {filtered.map(st => {
          const on = st === value
          return (
            <button key={st} onClick={() => onChange(st)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none',
                background: on ? `${color}14` : 'transparent', cursor: 'pointer',
                padding: '5px 10px', borderRadius: 6, textAlign: 'left', marginBottom: 1,
                borderLeft: on ? `3px solid ${color}` : '3px solid transparent', transition: '.12s' }}>
              <span style={{ flex: 1, fontSize: '.78rem', color: on ? 'var(--txt-0)' : 'var(--txt-1)', fontWeight: on ? 600 : 400 }}>{st}</span>
              {on && <span style={{ fontSize: '.7rem', color, fontWeight: 700 }}>✓</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const SERIES_COLORS = [COLORS.accent2, COLORS.coral, COLORS.violet, COLORS.amber, COLORS.green]

// z-score of the latest REAL (non-forecast) value against that same series'
// own real-history mean/stddev -- a genuine "this LGA/state relative to its
// own normal pattern" spike, not just "highest raw value" (which would just
// re-surface the biggest place every time, spike or not). Feeds the AI
// Insight prompt (see generateInsight below) so the write-up calls out real
// anomalies instead of the LLM guessing at what looks unusual.
function spikeZScore(dates, vals, forecastStart) {
  const realIdx = forecastStart ? dates.findIndex(d => d >= forecastStart) : -1
  const realVals = (realIdx === -1 ? vals : vals.slice(0, realIdx)).filter(v => v != null && !isNaN(v))
  if (realVals.length < 4) return null   // too short a history to call anything a "spike"
  const latest = realVals[realVals.length - 1]
  const hist = realVals.slice(0, -1)
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length
  const sd = Math.sqrt(variance)
  if (sd === 0) return null
  return { z: (latest - mean) / sd, latest, mean, sd }
}
const SPIKE_Z = 2

export default function Benchmarking({ disease, label }) {
  const [states, setStates] = useState([])
  const [stateName, setStateName] = useState('')
  const [target, setTarget] = useState('')
  const [targets, setTargets] = useState([])
  const [lgaOptions, setLgaOptions] = useState([])
  const [selectedLgas, setSelectedLgas] = useState([])
  // 'lgas' = stateName's own peer LGAs vs state/national average (original mode).
  // 'states' = stateName vs one or more OTHER states, each state's own average
  // plotted as its own line -- added per request ("add state to state
  // selection option"), since the original mode could only ever look INSIDE
  // one state, never compare two states directly.
  const [compareMode, setCompareMode] = useState('lgas')
  const [compareStates, setCompareStates] = useState([])
  const [chart, setChart] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [insight, setInsight] = useState(null)
  const [insightLoading, setInsightLoading] = useState(false)
  const [insightErr, setInsightErr] = useState(null)

  // load states + default target list once per disease
  useEffect(() => {
    setStateName(''); setTarget(''); setTargets([]); setLgaOptions([]); setSelectedLgas([]); setCompareStates([]); setChart(null); setInsight(null)
    fetch(`${API_BASE}/meta?disease=${encodeURIComponent(disease)}`)
      .then(r => r.json())
      .then(m => { setStates(m.states || []); if (m.states?.length) setStateName(m.states[0]) })
      .catch(() => setStates([]))
  }, [disease])

  // load indicator options + LGA list whenever state changes
  useEffect(() => {
    if (!stateName) return
    fetch(`${API_BASE}/benchmark/options?disease=${encodeURIComponent(disease)}&state_name=${encodeURIComponent(stateName)}`)
      .then(r => r.json())
      .then(d => {
        setTargets(d.targets || [])
        setTarget(d.targets?.[0] || '')
        setLgaOptions(d.lgas || [])
        setSelectedLgas([])
      })
      .catch(() => { setTargets([]); setLgaOptions([]) })
    setCompareStates(s => s.filter(x => x !== stateName))
  }, [disease, stateName])

  const fetchStateBenchmark = useCallback((st) =>
    fetch(`${API_BASE}/benchmark`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disease, target, state_name: st, lgas: [], horizon_months: 12 }),
    }).then(r => (r.ok ? r.json() : r.json().then(e => Promise.reject(e.detail || 'API error')))),
    [disease, target])

  const runCompare = useCallback(() => {
    if (!target || !stateName) return
    setLoading(true); setErr(null); setInsight(null); setInsightErr(null)

    if (compareMode === 'lgas') {
      fetch(`${API_BASE}/benchmark`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disease, target, state_name: stateName, lgas: selectedLgas, horizon_months: 12 }),
      })
        .then(r => (r.ok ? r.json() : r.json().then(e => Promise.reject(e.detail || 'API error'))))
        .then(d => {
          const series = [
            { key: 'National Average', name: 'National Average', color: COLORS.axis, dashed: true },
            { key: 'State Average', name: `${stateName} Average`, color: COLORS.amber },
            ...selectedLgas.map((lga, i) => ({ key: lga, name: lga, color: SERIES_COLORS[i % SERIES_COLORS.length] })),
          ]
          setChart({ ...d, _series: series, _mode: 'lgas', _lgas: selectedLgas })
        })
        .catch(e => setErr(String(e)))
        .finally(() => setLoading(false))
      return
    }

    // State vs state: run the SAME real benchmark once per selected state
    // (no backend change needed -- /ews/api/benchmark already computes one
    // state's real average against the national average; this just calls it
    // once per state and merges each state's own "State Average" line into
    // one chart), then align every state's dates onto the union of all dates
    // returned (states can have slightly different real-data windows).
    const allStates = [stateName, ...compareStates]
    Promise.all(allStates.map(fetchStateBenchmark))
      .then(results => {
        const dateSet = new Set()
        results.forEach(r => r.dates.forEach(d => dateSet.add(d)))
        const dates = [...dateSet].sort()
        const pick = (r, seriesKey, d) => { const i = r.dates.indexOf(d); return i >= 0 ? r.series[seriesKey]?.[i] ?? null : null }
        const series = { 'National Average': dates.map(d => pick(results[0], 'National Average', d)) }
        allStates.forEach((st, i) => { series[st] = dates.map(d => pick(results[i], 'State Average', d)) })
        const forecastStarts = results.map(r => r.forecast_start).filter(Boolean).sort()
        const seriesMeta = [
          { key: 'National Average', name: 'National Average', color: COLORS.axis, dashed: true },
          ...allStates.map((st, i) => ({ key: st, name: `${st} (state average)`, color: i === 0 ? COLORS.amber : SERIES_COLORS[(i - 1) % SERIES_COLORS.length] })),
        ]
        setChart({ dates, series, forecast_start: forecastStarts[0] || null, _series: seriesMeta, _mode: 'states', _lgas: [] })
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [disease, target, stateName, selectedLgas, compareMode, compareStates, fetchStateBenchmark])

  // AI Insight: feeds real, computed spike detection (same z-score logic as
  // above) for whichever entities are ACTUALLY plotted right now -- the
  // individual LGA lines in 'lgas' mode, or the state-average lines in
  // 'states' mode -- so the generated write-up calls out genuine anomalies
  // by name instead of the LLM eyeballing the table for what looks unusual.
  const generateInsight = () => {
    if (!chart) return
    setInsightLoading(true); setInsightErr(null)
    const plottedKeys = chart._series.map(s => s.key).filter(k => k !== 'National Average' && k !== 'State Average')
    const found = plottedKeys
      .map(k => ({ name: k, s: spikeZScore(chart.dates, chart.series[k] || [], chart.forecast_start) }))
      .filter(x => x.s && x.s.z >= SPIKE_Z)
      .sort((a, b) => b.s.z - a.s.z)
    const spikeContext = found.length
      ? found.map(x => `${x.name}: latest ${x.s.latest.toFixed(1)} vs its own recent baseline avg ${x.s.mean.toFixed(1)} -- ${x.s.z.toFixed(1)} standard deviations above normal`).join('; ')
      : null
    fetch(`${API_BASE}/benchmark-insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disease, target, state_name: stateName, lgas: chart._mode === 'lgas' ? selectedLgas : [],
        dates: chart.dates, series: chart.series, spike_context: spikeContext,
      }),
    })
      .then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.detail || 'API error')); return r.json() })
      .then(d => setInsight(d.insight))
      .catch(e => setInsightErr(String(e)))
      .finally(() => setInsightLoading(false))
  }

  const chartData = chart
    ? chart.dates.map((d, i) => {
        const row = { date: d }
        Object.entries(chart.series).forEach(([k, vals]) => { row[k] = vals[i] })
        return row
      })
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Configure Comparison"
        sub={`Compare ${label}'s performance across peer LGAs within a state, or state vs state, against the national average.`}>
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, background: 'var(--bg-3)',
          border: '1px solid var(--border)', borderRadius: 10, padding: 3, width: 'fit-content' }}>
          {[['lgas', '🏘️ LGAs within a state'], ['states', '🗺️ State vs State']].map(([m, lbl]) => (
            <button key={m} onClick={() => { setCompareMode(m); setChart(null); setErr(null) }}
              style={{ border: 'none', cursor: 'pointer', padding: '7px 16px', borderRadius: 8,
                fontFamily: 'var(--font)', fontSize: '.82rem', fontWeight: 700, transition: '.15s',
                background: compareMode === m ? 'var(--bg-1)' : 'transparent',
                color: compareMode === m ? COLORS.accent : 'var(--txt-2)' }}>
              {lbl}
            </button>
          ))}
        </div>
        {compareMode === 'lgas' ? (
          <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
            <div className="col" style={{ flex: 1, minWidth: 220, maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="select-wrap">
                <label>State</label>
                <select value={stateName} onChange={e => setStateName(e.target.value)} style={{ width: '100%' }}>
                  {states.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="select-wrap">
                <label>Indicator for Comparison</label>
                <select value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%' }}>
                  {targets.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button onClick={runCompare} disabled={!target || loading}
                style={{ padding: '9px 18px', borderRadius: 8, border: 'none',
                  background: COLORS.accent, color: '#fff', fontWeight: 700, fontSize: '.84rem',
                  cursor: loading ? 'default' : 'pointer', opacity: loading ? .6 : 1 }}>
                {loading ? 'Comparing…' : 'Compare'}
              </button>
              {err && <div style={{ color: COLORS.coral, fontSize: '.8rem' }}>{err}</div>}
            </div>
            <div className="col" style={{ flex: 1.4, minWidth: 260 }}>
              <PeerPicker label={`Peer LGAs in ${stateName || '…'}`} all={lgaOptions} selected={selectedLgas}
                onToggle={lga => setSelectedLgas(s => s.includes(lga) ? s.filter(x => x !== lga) : [...s, lga])} />
            </div>
          </div>
        ) : (
          <>
            {/* Two EQUAL, side-by-side pickers -- same width, same searchable-list
                style -- so "Primary state" and "Compare against these states" read
                as parallel choices, not a small dropdown next to a much taller list. */}
            <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
              <div className="col" style={{ flex: 1, minWidth: 240 }}>
                <SingleStatePicker label="Primary state" all={states} value={stateName} onChange={setStateName} />
              </div>
              <div className="col" style={{ flex: 1, minWidth: 240 }}>
                <PeerPicker label="Compare against these states" all={states.filter(s => s !== stateName)} selected={compareStates}
                  onToggle={st => setCompareStates(s => s.includes(st) ? s.filter(x => x !== st) : [...s, st])}
                  color={COLORS.violet} itemNoun="states" />
              </div>
            </div>
            <div className="row" style={{ gap: 20, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
              <div className="select-wrap" style={{ minWidth: 220 }}>
                <label>Indicator for Comparison</label>
                <select value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%' }}>
                  {targets.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button onClick={runCompare} disabled={!target || loading || !compareStates.length}
                style={{ padding: '9px 18px', borderRadius: 8, border: 'none',
                  background: COLORS.accent, color: '#fff', fontWeight: 700, fontSize: '.84rem',
                  cursor: loading ? 'default' : 'pointer', opacity: loading ? .6 : 1 }}>
                {loading ? 'Comparing…' : 'Compare'}
              </button>
              {err && <div style={{ color: COLORS.coral, fontSize: '.8rem' }}>{err}</div>}
            </div>
          </>
        )}
      </Card>

      {chart && (
        <Card title="Comparative Benchmarking"
          sub={`${target} — ${chart.dates.length} months${chart.forecast_start ? ' · includes model forecast tail' : ''}`}>
          <CompareChart data={chartData} series={chart._series} height={340}
            splitDate={chart.forecast_start || undefined} splitLabel="Model forecast →" />
          <button onClick={generateInsight} disabled={insightLoading}
            style={{ marginTop: 14, padding: '9px 18px', borderRadius: 8, border: 'none',
              background: COLORS.violet, color: '#fff', fontWeight: 700, fontSize: '.84rem',
              cursor: insightLoading ? 'default' : 'pointer', opacity: insightLoading ? .6 : 1 }}>
            {insightLoading ? 'Generating AI Insight…' : '✨ Generate AI Insight'}
          </button>
          {insightErr && <div style={{ color: COLORS.coral, fontSize: '.8rem', marginTop: 10 }}>{insightErr}</div>}
          {insight && (
            <div style={{ marginTop: 16, padding: 16, borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
              <MarkdownLite text={insight} />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
