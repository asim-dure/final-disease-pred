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

const API = import.meta.env.VITE_API_BASE || '/api'
const ZONE_C = { Red: '#dc2626', Amber: '#ea580c', Yellow: '#ca8a04', Green: '#16a34a', 'Not a Hotspot': '#64748b' }
const zoneOf = (b) => b == null ? 'Not a Hotspot' : b < 18 ? 'Not a Hotspot' : b < 38 ? 'Green' : b < 58 ? 'Yellow' : b < 78 ? 'Amber' : 'Red'

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
          contentStyle={{ fontSize: '.78rem', borderRadius: 8, border: '1px solid #d7e1e8' }} />
        {firstF && <ReferenceLine x={rows.find(r => r.ym === firstF)?.label} stroke="rgba(217,119,6,.45)" strokeDasharray="4 4" />}
        {selYm && <ReferenceLine x={rows.find(r => r.ym === selYm)?.label} stroke={COLORS.violet} strokeWidth={2}
          label={{ value: 'selected', fill: COLORS.violet, fontSize: 10, position: 'top' }} />}
        <Area type="monotone" dataKey="actual" stroke={COLORS.accent} strokeWidth={2.2} fill="url(#fA)" connectNulls dot={false} />
        <Area type="monotone" dataKey="forecast" stroke={COLORS.amber} strokeWidth={2.2} strokeDasharray="5 4" fill="url(#fF)" connectNulls dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
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

  const selYm = selMonth?.ym
  const isForecastMonth = !!selMonth?.forecast

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

  // mean facility caseload for the selected month → anchors the burden scaling
  const meanCases = useMemo(() => {
    const fs = data?.facilities || []
    if (!fs.length) return 0
    const cs = fs.map(f => pointAt(f)?.cases ?? 0)
    return cs.reduce((a, b) => a + b, 0) / cs.length
  }, [data, selYm])

  // burden_f = lgaBurden × (cases_f / mean_cases)  → averages up to lgaBurden
  const burdenOf = (fac) => {
    if (lgaBurden == null || !meanCases) return null
    const c = pointAt(fac)?.cases ?? 0
    return Math.min(100, Math.max(0, lgaBurden * (c / meanCases)))
  }

  const facilities = useMemo(() => {
    if (!data?.facilities) return []
    return [...data.facilities].sort((a, b) => ((burdenOf(b) ?? (pointAt(b)?.cases ?? -1)) - (burdenOf(a) ?? (pointAt(a)?.cases ?? -1))))
  }, [data, selYm, lgaBurden, meanCases])

  useEffect(() => {
    if (facilities.length && (!selFac || !facilities.find(f => f.facility === selFac))) setSelFac(facilities[0].facility)
  }, [facilities])

  const sel = facilities.find(f => f.facility === selFac) || null
  const selPoint = sel ? pointAt(sel) : null
  const selBurden = sel ? burdenOf(sel) : null
  const selZone = zoneOf(selBurden)
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
      }),
    })
      .then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e.detail || `HTTP ${r.status}`)); return r.json() })
      .then(setRisk).catch(e => setRiskErr(String(e))).finally(() => setRiskLoading(false))
  }

  if (!stateName || !lga) return null
  const lgaZoneName = lgaZone || zoneOf(lgaBurden)

  return (
    <Card style={{ marginTop: 18 }}
      title={<span>🏥 Health facilities in {lga}
        <InfoTip w={340} title="Consistent with the LGA above" text="Each facility's caseload is disaggregated from this LGA (they sum to the LGA total), and each facility's burden is the LGA's own burden score scaled by that facility's share of the caseload — so the facilities average up to the LGA's zone. A facility only exceeds the LGA's zone where its caseload runs above the LGA average." /></span>}
      sub={data?.available === false ? 'Facility drill-down' : `Burden anchored to ${lga}'s LGA score for ${selMonth?.label || 'the selected month'} · click a facility`}
      right={data?.n_facilities ? <span className="chip dot">{data.n_facilities} facilities</span> : null}>

      {loading && <div className="loading" style={{ height: 120 }}><div className="spinner" />Loading facilities…</div>}
      {err && <div style={{ color: COLORS.coral, fontSize: '.82rem' }}>Couldn’t load facilities: {err}. Is the backend (port 8001) running?</div>}

      {data && data.available === false && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', background: 'var(--bg-3)', borderRadius: 10, fontSize: '.86rem', color: '#3c5366', lineHeight: 1.6 }}>
          <span style={{ fontSize: '1.1rem' }}>ℹ️</span><div>{data.reason}</div>
        </div>
      )}

      {data && data.available && facilities.length === 0 && (
        <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No facility-level records found for this LGA.</div>
      )}

      {data && data.available && facilities.length > 0 && (
        <>
          {/* consistency banner — shows the facilities really do roll up to the LGA */}
          {lgaBurden != null && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 13px', marginBottom: 14, borderRadius: 10,
              background: (ZONE_C[lgaZoneName] || '#64748b') + '12', border: `1px solid ${(ZONE_C[lgaZoneName] || '#64748b')}44`, fontSize: '.82rem', color: '#25404f' }}>
              <span style={{ fontSize: '1rem' }}>🔗</span>
              <div>Each facility is scored relative to <b>{lga}</b>’s LGA burden of{' '}
                <b style={{ color: ZONE_C[lgaZoneName] }}>{lgaBurden.toFixed(1)}</b> <ZoneChip zone={lgaZoneName} /> for {selMonth?.label}, by its share of the LGA caseload — most sit at or below it. The few that score higher are the facilities <b>driving this LGA’s caseload</b>, and are where to target resources first.</div>
            </div>
          )}

          <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
            {/* ── facility list ── */}
            <div className="col" style={{ flex: 1, minWidth: 260, maxWidth: 330 }}>
              <div style={{ maxHeight: 430, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {facilities.map((f, i) => {
                  const b = burdenOf(f); const z = zoneOf(b)
                  const on = f.facility === selFac
                  const c = ZONE_C[z] || '#64748b'
                  const p = pointAt(f)
                  return (
                    <div key={f.facility} onClick={() => setSelFac(f.facility)} style={{ cursor: 'pointer',
                      border: on ? `2px solid ${c}` : '1px solid var(--border)', borderLeft: `4px solid ${c}`,
                      borderRadius: 10, padding: '9px 12px', background: on ? c + '10' : 'var(--bg-1)', transition: '.12s' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: '.8rem', color: '#0f2230', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.facility}</span>
                        <span style={{ fontSize: '.66rem', color: '#94a8b6', fontWeight: 700 }}>#{i + 1}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 6 }}>
                        <span style={{ fontSize: '.68rem', color: '#64798a' }}>{p?.cases != null ? `${fmt(p.cases)} cases` : '—'}</span>
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
                      <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f2230' }}>{sel.facility}</div>
                      <div style={{ fontSize: '.76rem', color: '#64798a', marginTop: 2 }}>{sel.ward ? `${sel.ward} · ` : ''}{lga}, {stateName}</div>
                    </div>
                    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: '.68rem', fontWeight: 700,
                      background: isForecastMonth ? 'rgba(217,119,6,.14)' : 'rgba(13,148,136,.14)',
                      color: isForecastMonth ? '#b45309' : COLORS.accent, border: `1px solid ${isForecastMonth ? '#d97706' : COLORS.accent}55` }}>
                      {isForecastMonth ? '🔮 Forecast' : '✓ Actual'} · {selMonth?.label || '—'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 18, alignItems: 'center', margin: '14px 0 6px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: '#64798a', fontWeight: 700 }}>Facility burden</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: ZONE_C[selZone] || '#0f2230' }}>{selBurden != null ? selBurden.toFixed(1) : '—'}</span>
                        <ZoneChip zone={selZone} />
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: '#64798a', fontWeight: 700 }}>{isForecastMonth ? 'Projected cases' : 'Confirmed cases'}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: '#0f2230' }}>{selPoint?.cases != null ? fmt(selPoint.cases) : '—'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.6px', color: '#64798a', fontWeight: 700 }}>Caseload rank</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '2rem', fontWeight: 600, color: '#0f2230' }}>{selRank} <span style={{ fontSize: '.9rem', color: '#94a8b6' }}>/ {facilities.length}</span></div>
                    </div>
                  </div>

                  <FacilityTrajectory series={sel.series} selYm={selYm} />

                  {isForecastMonth ? (
                    <div style={{ marginTop: 12 }}>
                      <button onClick={generateRisk} disabled={riskLoading || selPoint?.cases == null}
                        style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: COLORS.violet, color: '#fff',
                          fontWeight: 700, fontSize: '.86rem', cursor: riskLoading ? 'default' : 'pointer', opacity: riskLoading ? .6 : 1, fontFamily: 'var(--font)' }}>
                        {riskLoading ? 'Assessing risk…' : `⚡ Generate AI Risk Assessment · ${selMonth?.label}`}
                      </button>
                      {riskErr && <div style={{ color: COLORS.coral, fontSize: '.8rem', marginTop: 8 }}>{riskErr}</div>}
                      {risk && (
                        <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 10, background: '#f8fbfd', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: '.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: '#64798a' }}>Risk level</span>
                            <span style={{ padding: '2px 11px', borderRadius: 20, fontSize: '.74rem', fontWeight: 800, color: '#fff',
                              background: risk.risk_level === 'Critical' ? '#dc2626' : risk.risk_level === 'High' ? '#ea580c' : risk.risk_level === 'Moderate' ? '#ca8a04' : '#0d9488' }}>{risk.risk_level}</span>
                          </div>
                          <MarkdownLite text={risk.risk_assessment} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', background: 'rgba(13,148,136,.06)', border: '1px solid rgba(13,148,136,.25)', borderRadius: 10, fontSize: '.82rem', color: '#25404f', lineHeight: 1.55 }}>
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
  )
}
