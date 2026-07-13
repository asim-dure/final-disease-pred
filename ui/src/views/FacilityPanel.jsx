import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import { Card, InfoTip, MarkdownLite } from '../components'
import { COLORS, fmt } from '../lib'

// ────────────────────────────────────────────────────────────────────────────
// Facility drill-down — one level below the LGA the map shows. When an LGA is
// selected, this lists its health facilities (right side) with a per-month
// caseload and burden. Click a facility for its actual→forecast trajectory; on a
// FORECAST month, generate an AI risk assessment. On ACTUAL months it's purely
// descriptive (no risk button), as requested.
//
// MATH THAT STAYS CONNECTED (the important part):
//  • Caseloads come from the backend and SUM EXACTLY to the LGA (the forecast is
//    the LGA's own SARIMAX trajectory disaggregated by facility share).
//  • Facility burden is NOT an independent ranking (that produced red facilities
//    inside "Not a Hotspot" LGAs). Instead each facility's burden is the LGA's
//    OWN burden score (the exact number the map shows for the selected month),
//    scaled by that facility's caseload share:
//        burden_f = lgaBurden × (cases_f / mean_cases_in_lga)
//    The average of the facility burdens therefore EQUALS the LGA burden, so a
//    low-burden LGA has low-burden facilities; only a facility whose caseload
//    runs well above the LGA average can exceed the LGA's zone.
// ────────────────────────────────────────────────────────────────────────────

const API = import.meta.env.VITE_API_BASE || '/ews/api'
const ZONE_C = { Red: '#dc2626', Amber: '#ea580c', Yellow: '#ca8a04', Green: '#16a34a', 'Not a Hotspot': '#64748b' }
const zoneOf = (b) => b == null ? 'Not a Hotspot' : b < 60 ? 'Not a Hotspot' : b < 71 ? 'Green' : b < 81 ? 'Yellow' : b < 91 ? 'Amber' : 'Red'

function ZoneChip({ zone, score }) {
  const c = ZONE_C[zone] || '#64748b'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 20,
      fontSize: '.7rem', fontWeight: 700, background: c + '1e', color: c, border: `1px solid ${c}55`, whiteSpace: 'nowrap' }}>
      {zone}{score != null && <span style={{ fontFamily: 'var(--mono)', opacity: .85 }}>{score.toFixed(0)}</span>}
    </span>
  )
}

function FacilityTrajectory({ series, selYm }) {
  const rows = useMemo(() => {
    const r = (series || []).map(s => ({
      ym: s.ym, label: s.label,
      actual: s.forecast ? null : s.cases,
      forecast: s.forecast ? s.cases : null,
    }))
    for (let i = 1; i < r.length; i++) if (r[i].forecast != null && r[i - 1].actual != null) r[i - 1].forecast = r[i - 1].actual
    return r
  }, [series])
  const firstF = (series || []).find(s => s.forecast)?.ym
  return (
    <ResponsiveContainer width="100%" height={190}>
      <ComposedChart data={rows} margin={{ top: 8, right: 10, left: 2, bottom: 2 }}>
        <defs>
          <linearGradient id="fA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.3} /><stop offset="100%" stopColor={COLORS.accent} stopOpacity={0.02} /></linearGradient>
          <linearGradient id="fF" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.amber} stopOpacity={0.24} /><stop offset="100%" stopColor={COLORS.amber} stopOpacity={0.02} /></linearGradient>
        </defs>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: COLORS.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'rgba(0,0,0,.08)' }} minTickGap={40} />
        <YAxis tick={{ fill: COLORS.axis, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={fmt} width={38} />
        <Tooltip formatter={(v, n) => [v == null ? '—' : Math.round(v), n === 'actual' ? 'Actual cases' : 'Forecast cases']}
          contentStyle={{ fontSize: '.78rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)' }} />
        {firstF && <ReferenceLine x={rows.find(r => r.ym === firstF)?.label} stroke="rgba(217,119,6,.45)" strokeDasharray="4 4" />}
        {selYm && <ReferenceLine x={rows.find(r => r.ym === selYm)?.label} stroke={COLORS.violet} strokeWidth={2}
          label={{ value: 'selected', fill: COLORS.violet, fontSize: 10, position: 'top' }} />}
        <Area type="monotone" dataKey="actual" stroke={COLORS.accent} strokeWidth={2.2} fill="url(#fA)" connectNulls dot={false} />
        <Area type="monotone" dataKey="forecast" stroke={COLORS.amber} strokeWidth={2.2} strokeDasharray="5 4" fill="url(#fF)" connectNulls dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—')

// "Why this score" — the per-factor breakdown, mirroring the LGA burden
// explainer. Shows the EXACT warehouse indicator column behind each factor,
// what it means, and the analyst rationale for its weight -- per manager
// request, this needs to answer "on what basis, and why only this?" for a
// non-technical reader, not just show numbers. Every value here comes
// straight from the backend's real computation (facility_api.py's
// _FACTOR_META/_SOURCE_META) -- nothing here is a placeholder or estimate.
function FactorBreakdown({ point, meta, scoringNote, source }) {
  const f = point?.factors
  if (!f) return null
  const order = ['volume', 'testing_gap', 'treatment_gap', 'diagnostic_gap']
  const inp = point.inputs || {}
  const detail = {
    volume: `${fmt(point.cases || 0)} confirmed cases${point.forecast ? ' (projected)' : ''}`,
    testing_gap: inp.testing_gap != null ? `${pct(inp.testing_gap)} of fever cases NOT given a parasitological test${inp.rdt_tested ? ` · ${fmt(Math.round(inp.rdt_tested))} RDTs done (trailing 12mo)` : ''}` : 'no fever-testing data reported',
    treatment_gap: inp.treatment_gap != null ? `${pct(inp.treatment_gap)} of confirmed cases with no recorded ACT course` : 'no treatment data reported',
    diagnostic_gap: inp.diagnostic_gap != null ? `${pct(inp.diagnostic_gap)} of reported cases treated on presumption (never lab-confirmed)` : 'no diagnostic-mix data reported',
  }
  return (
    <div style={{ marginTop: 12, borderTop: '1px dashed var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: '.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--txt-2)', marginBottom: 4 }}>
        Why this score{point.inputs?.structural ? ' · uses this facility’s trailing profile on its projected volume' : ''}
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--txt-1)', lineHeight: 1.6, marginBottom: 10 }}>
        This is an <b>absolute</b> 0–100 clinical burden score, not a rank within {point.forecast ? 'this LGA' : 'a list'} — the identical formula and weights are applied to every facility in Nigeria, so a score of 70 means the same thing here as it does anywhere else in the country. It's built from four real, warehouse-reported indicators, each converted to a 0–1 "gap" (how far this facility is from the best-case value on that indicator), then combined using the fixed, disclosed weights below. These weights are an explicit analyst judgment call, not a fitted/machine-learned model — there's no per-facility ground truth to train one against — and they renormalise over whichever indicators this facility actually reports, so a facility is never penalised for a gap in reporting.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {order.filter(k => f[k]).map(k => {
          const m = meta[k] || {}; const fc = f[k]
          return (
            <div key={k}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', marginBottom: 3 }}>
                <span style={{ color: 'var(--txt-1)' }}><b>{m.label || k}</b> <span style={{ color: 'var(--txt-2)' }}>· {detail[k]}</span></span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--txt-1)', whiteSpace: 'nowrap' }}>{fc.points?.toFixed(1)} / {fc.weight?.toFixed(0)} pts</span>
              </div>
              <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-3)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, (fc.sub || 0) * 100)}%`, background: COLORS.accent, borderRadius: 4 }} />
              </div>
              {m.indicator && (
                <div style={{ fontSize: '.68rem', color: 'var(--txt-3)', marginTop: 5, lineHeight: 1.6 }}>
                  <div><b style={{ color: 'var(--txt-2)' }}>Warehouse indicator:</b> <code style={{ fontFamily: 'var(--mono)' }}>{m.indicator}</code></div>
                  {m.help && <div style={{ marginTop: 2 }}>{m.help}</div>}
                  {m.why_weight && <div style={{ marginTop: 2 }}><b style={{ color: 'var(--txt-2)' }}>Why {m.weight?.toFixed(0)}%:</b> {m.why_weight}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {scoringNote && <div style={{ fontSize: '.68rem', color: 'var(--txt-2)', marginTop: 12, lineHeight: 1.6 }}>{scoringNote}</div>}
      {point.inputs?.structural && (
        <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(217,119,6,.06)', border: '1px solid rgba(217,119,6,.25)', borderRadius: 8, fontSize: '.7rem', color: 'var(--txt-1)', lineHeight: 1.65 }}>
          <b>🔮 How this forecast number was built:</b> {fmt(point.cases || 0)} projected cases for this facility come from splitting {point.forecast ? 'the LGA' : 'this area'}'s own SARIMAX case forecast by this facility's real trailing-12-month share of the LGA's total case volume{inp.disagg_share != null ? ` (${pct(inp.disagg_share)} of the LGA total)` : ''} — so every facility's forecast in this LGA sums exactly to the LGA's own published forecast, nothing is independently modelled per facility. Future testing/treatment/diagnostic rates don't exist yet to measure directly, so the gap factors above instead use this facility's own <b>real</b> trailing 12-month totals, held constant into the projection: {inp.rdt_tested != null ? `${fmt(Math.round(inp.rdt_tested))} RDT tests done` : 'no RDT data'}, {inp.act != null ? `${fmt(Math.round(inp.act))} ACT courses given` : 'no ACT data'}, {inp.total != null ? `${fmt(Math.round(inp.total))} total reported cases` : 'no total-case data'}. These are this facility's actual reported figures for the last 12 real months, not placeholders.
        </div>
      )}
      {source && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-3)', borderRadius: 8, fontSize: '.68rem', color: 'var(--txt-2)', lineHeight: 1.65 }}>
          <b style={{ color: 'var(--txt-1)' }}>Data source:</b> live query against <code style={{ fontFamily: 'var(--mono)' }}>{source.warehouse_table}</code> ({source.grain}), joined to <code style={{ fontFamily: 'var(--mono)' }}>{source.geo_table}</code> for facility/ward names and <code style={{ fontFamily: 'var(--mono)' }}>{source.indicator_table}</code> for indicator names, restricted to {source.min_year} onward (this indicator has no meaningful signal before then). {source.query_mode}
          {source.indicators?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {source.indicators.map(ind => (
                <li key={ind.name} style={{ marginBottom: 2 }}><code style={{ fontFamily: 'var(--mono)' }}>{ind.name}</code> — {ind.role}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export default function FacilityPanel({ disease, stateName, lga, selMonth, lgaBurden, lgaZone }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [selFac, setSelFac] = useState(null)
  const [risk, setRisk] = useState(null)
  const [riskLoading, setRiskLoading] = useState(false)
  const [riskErr, setRiskErr] = useState(null)
  const reqSeq = useRef(0)
  const rootRef = useRef(null)
  const scrolledFor = useRef(null)

  const selYm = selMonth?.ym
  const isForecastMonth = !!selMonth?.forecast

  // Auto-scroll the panel into view when a NEW LGA is opened, so the facility
  // list isn't hidden below the fold (manager ask). Only fires once per LGA
  // selection, and only once its content has actually rendered.
  useEffect(() => {
    const key = `${stateName}|||${lga}`
    if (rootRef.current && data && scrolledFor.current !== key) {
      scrolledFor.current = key
      setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    }
  }, [data, stateName, lga])

  useEffect(() => {
    if (!stateName || !lga) return
    const seq = ++reqSeq.current
    setLoading(true); setErr(null); setData(null); setSelFac(null); setRisk(null)
    fetch(`${API}/facilities?disease=${encodeURIComponent(disease)}&state=${encodeURIComponent(stateName)}&lga=${encodeURIComponent(lga)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { if (seq === reqSeq.current) setData(d) })
      .catch(e => { if (seq === reqSeq.current) setErr(String(e)) })
      .finally(() => { if (seq === reqSeq.current) setLoading(false) })
  }, [disease, stateName, lga])

  useEffect(() => { setRisk(null); setRiskErr(null) }, [selYm, selFac])

  const pointAt = (fac) => (fac.series || []).find(s => s.ym === selYm) || null
  // burden now comes straight from the backend (absolute, multi-factor); no
  // client-side scaling. Missing (zero-case actual month) → null.
  const burdenOf = (fac) => { const b = pointAt(fac)?.burden; return b == null ? null : b }
  const factorMeta = data?.factor_meta || {}

  const facilities = useMemo(() => {
    if (!data?.facilities) return []
    return [...data.facilities].sort((a, b) => ((burdenOf(b) ?? -1) - (burdenOf(a) ?? -1)))
  }, [data, selYm])

  useEffect(() => {
    if (facilities.length && (!selFac || !facilities.find(f => f.facility === selFac))) setSelFac(facilities[0].facility)
  }, [facilities])

  const sel = facilities.find(f => f.facility === selFac) || null
  const selPoint = sel ? pointAt(sel) : null
  const selBurden = selPoint?.burden ?? null
  const selZone = selPoint?.zone || zoneOf(selBurden)
  const selRank = sel ? facilities.findIndex(f => f.facility === sel.facility) + 1 : null

  const generateRisk = () => {
    if (!sel || !selPoint) return
    setRiskLoading(true); setRiskErr(null); setRisk(null)
    const around = (sel.series || []).filter(s => s.ym <= selYm).slice(-4)
      .map(s => ({ label: s.label, cases: s.cases, forecast: s.forecast }))
    fetch(`${API}/facility-risk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disease, state: stateName, lga, facility: sel.facility, ward: sel.ward,
        ym: selYm, label: selPoint.label, burden: selBurden, zone: selZone,
        cases: selPoint.cases, lga_rank: `${selRank} of ${facilities.length}`,
        recent: around, context_12m: sel.context_12m,
        factors: selPoint.factors, inputs: selPoint.inputs,
      }),
    })
      .then(async (r) => {
        // Read as text first, then parse — a 500/502 error page is NOT JSON, and
        // calling r.json() on it throws the cryptic "Unexpected token … is not
        // valid JSON" the user sees. This surfaces a clean message instead.
        const text = await r.text()
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
        if (!r.ok) throw new Error((data && data.detail) || `AI risk service error (HTTP ${r.status}). Please try again in a moment.`)
        if (!data || !data.risk_assessment) throw new Error('The AI risk service returned an unexpected response. Please try again.')
        return data
      })
      .then(setRisk).catch(e => setRiskErr(e.message || String(e))).finally(() => setRiskLoading(false))
  }

  if (!stateName || !lga) return null
  const lgaZoneName = lgaZone || zoneOf(lgaBurden)

  return (
    <div ref={rootRef} style={{ scrollMarginTop: 12 }}>
    <Card style={{ marginTop: 18 }}
      title={<span>🏥 Health facilities in {lga}
        <InfoTip w={360} title="How facility burden is scored" text="An absolute 0–100 clinical burden, comparable across every facility in Nigeria. It blends case volume (log-scaled vs the national P99), testing gap (fever cases not parasitologically tested), treatment gap (cases without an ACT course) and diagnostic gap (presumed share of reported cases). Weights renormalise over whatever a facility reports. Higher = prioritise first. Caseloads still sum to the LGA total; on forecast months the facility's trailing clinical profile is applied to its projected volume. Click a facility below for the full indicator-by-indicator breakdown and data source." /></span>}
      sub={data?.available === false ? 'Facility drill-down' : `Ranked by clinical burden for ${selMonth?.label || 'the selected month'} · click a facility for the breakdown`}
      right={data?.n_facilities ? <span className="chip dot">{data.n_facilities} facilities</span> : null}>

      {loading && <div className="loading" style={{ height: 120 }}><div className="spinner" />Loading facilities… first open of a new LGA queries the warehouse live and can take up to a minute; repeat views of the same LGA are instant.</div>}
      {err && <div style={{ color: COLORS.coral, fontSize: '.82rem' }}>Couldn’t load facilities: {err}. Is the backend running?</div>}

      {data && data.available === false && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', background: 'var(--bg-3)', borderRadius: 10, fontSize: '.86rem', color: 'var(--txt-1)', lineHeight: 1.6 }}>
          <span style={{ fontSize: '1.1rem' }}>ℹ️</span><div>{data.reason}</div>
        </div>
      )}

      {data && data.available && facilities.length === 0 && (
        <div className="muted" style={{ padding: 20, textAlign: 'center' }}>{data.note || 'No facility-level records found for this LGA.'}</div>
      )}

      {data && data.available && facilities.length > 0 && (
        <>
          {/* LGA context — orientation only; facility scores are absolute, not derived from this */}
          {lgaBurden != null && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 13px', marginBottom: 14, borderRadius: 10,
              background: 'var(--bg-3)', border: '1px solid var(--border)', fontSize: '.82rem', color: 'var(--txt-1)' }}>
              <span style={{ fontSize: '1rem' }}>🧭</span>
              <div>For context, <b>{lga}</b> as a whole scores <b style={{ color: ZONE_C[lgaZoneName] }}>{lgaBurden.toFixed(1)}</b> <ZoneChip zone={lgaZoneName} /> on the LGA map. The facility scores below are <b>independent clinical burden scores</b> comparable to facilities anywhere in Nigeria — a low-burden LGA simply won’t contain high-burden facilities, so the top of this list tells you where to focus <i>within</i> {lga}.</div>
            </div>
          )}

          <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
            {/* ── facility list ── */}
            <div className="col" style={{ flex: 1, minWidth: 260, maxWidth: 330 }}>
              <div style={{ maxHeight: 430, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {facilities.map((f, i) => {
                  const p = pointAt(f)
                  const b = p?.burden ?? null; const z = p?.zone || zoneOf(b)
                  const on = f.facility === selFac
                  const c = ZONE_C[z] || '#64748b'
                  return (
                    <div key={f.facility} onClick={() => setSelFac(f.facility)} style={{ cursor: 'pointer',
                      border: on ? `2px solid ${c}` : '1px solid var(--border)', borderLeft: `4px solid ${c}`,
                      borderRadius: 10, padding: '9px 12px', background: on ? c + '10' : 'var(--bg-1)', transition: '.12s' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: '.8rem', color: 'var(--txt-0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.facility}</span>
                        <span style={{ fontSize: '.66rem', color: 'var(--txt-3)', fontWeight: 700 }}>#{i + 1}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 6 }}>
                        <span style={{ fontSize: '.68rem', color: 'var(--txt-2)' }}>{p?.cases != null ? `${fmt(p.cases)} cases` : '—'}</span>
                        <ZoneChip zone={z} score={b} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── selected facility detail ── */}
            <div className="col" style={{ flex: 1.5, minWidth: 340 }}>
              {sel && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', background: 'var(--bg-1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--txt-0)' }}>{sel.facility}</div>
                      <div style={{ fontSize: '.76rem', color: 'var(--txt-2)', marginTop: 2 }}>{sel.ward ? `${sel.ward} · ` : ''}{lga}, {stateName}</div>
                    </div>
                    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: '.68rem', fontWeight: 700,
                      background: isForecastMonth ? 'rgba(217,119,6,.14)' : 'rgba(13,148,136,.14)',
                      color: isForecastMonth ? '#b45309' : COLORS.accent, border: `1px solid ${isForecastMonth ? '#d97706' : COLORS.accent}55` }}>
                      {isForecastMonth ? '🔮 Forecast' : '✓ Actual'} · {selMonth?.label || '—'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 18, alignItems: 'center', margin: '14px 0 6px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--txt-2)', fontWeight: 700 }}>Facility burden</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: ZONE_C[selZone] || 'var(--txt-0)' }}>{selBurden != null ? selBurden.toFixed(1) : '—'}</span>
                        <ZoneChip zone={selZone} />
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--txt-2)', fontWeight: 700 }}>{isForecastMonth ? 'Projected cases' : 'Confirmed cases'}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: 'var(--txt-0)' }}>{selPoint?.cases != null ? fmt(selPoint.cases) : '—'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--txt-2)', fontWeight: 700 }}>Priority rank</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: 'var(--txt-0)' }}>{selRank} <span style={{ fontSize: '.9rem', color: 'var(--txt-3)' }}>/ {facilities.length}</span></div>
                    </div>
                    {selPoint?.inputs?.testing_gap != null && (
                      <div>
                        <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--txt-2)', fontWeight: 700 }}>Testing gap</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: 'var(--txt-0)' }}>{pct(selPoint.inputs.testing_gap)}</div>
                      </div>
                    )}
                  </div>

                  <FacilityTrajectory series={sel.series} selYm={selYm} />
                  <FactorBreakdown point={selPoint} meta={factorMeta} scoringNote={data?.scoring_method_note} source={data?.source} />

                  {isForecastMonth ? (
                    (selPoint?.cases ?? 0) >= 1 ? (
                    <div style={{ marginTop: 12 }}>
                      <button onClick={generateRisk} disabled={riskLoading || !selPoint?.cases}
                        style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: COLORS.violet, color: '#fff',
                          fontWeight: 700, fontSize: '.86rem', cursor: riskLoading ? 'default' : 'pointer', opacity: riskLoading ? .6 : 1, fontFamily: 'var(--font)' }}>
                        {riskLoading ? 'Assessing risk…' : `⚡ Generate AI Risk Assessment · ${selMonth?.label}`}
                      </button>
                      {riskErr && <div style={{ color: COLORS.coral, fontSize: '.8rem', marginTop: 8 }}>{riskErr}</div>}
                      {risk && (
                        <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: '.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--txt-2)' }}>Risk level</span>
                            <span style={{ padding: '2px 11px', borderRadius: 20, fontSize: '.74rem', fontWeight: 800, color: '#fff',
                              background: risk.risk_level === 'Critical' ? '#dc2626' : risk.risk_level === 'High' ? '#ea580c' : risk.risk_level === 'Moderate' ? '#ca8a04' : risk.risk_level === 'None' ? '#64748b' : '#0d9488' }}>{risk.risk_level}</span>
                          </div>
                          <MarkdownLite text={risk.risk_assessment} />
                        </div>
                      )}
                    </div>
                    ) : (
                    /* forecast month, but 0 projected cases → nothing to assess */
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 10, fontSize: '.82rem', color: 'var(--txt-1)', lineHeight: 1.55 }}>
                      <span style={{ fontSize: '1rem' }}>∅</span>
                      <div><b>No malaria cases projected</b> here for {selMonth?.label}, so there's nothing to pre-position for — a risk assessment isn't applicable. It becomes available at facilities/months with at least one projected case.</div>
                    </div>
                    )
                  ) : (
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', background: 'rgba(13,148,136,.06)', border: '1px solid rgba(13,148,136,.25)', borderRadius: 10, fontSize: '.82rem', color: 'var(--txt-1)', lineHeight: 1.55 }}>
                      <span style={{ fontSize: '1rem' }}>✓</span>
                      <div>Showing <b>actual reported data</b> for {selMonth?.label}. Risk assessment is a forward-looking planning tool — move the month slider above to a <b>🔮 forecast</b> month to generate an AI risk assessment for this facility.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
    </div>
  )
}
