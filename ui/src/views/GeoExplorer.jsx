import React, { useState, useEffect, useMemo } from 'react'
import { Card, ForecastChart, HBars, ModelOverlay } from '../components'
import { loadLgas, loadMM, fmt, fmtFull, pct, COLORS, zoneFor, burdenZone } from '../lib'

export default function GeoExplorer({ data, variant = 'after', disease = 'malaria' }) {
  const { states, geo, meta } = data
  const stateNames = useMemo(() => Object.keys(geo).sort(), [geo])
  const [state, setState] = useState(meta.ranking[0].state)
  const [lgaData, setLgaData] = useState(null)
  const [lga, setLga] = useState('')
  const [mmStates, setMmStates] = useState(null)
  const [mmLgas, setMmLgas] = useState(null)

  useEffect(() => { setLgaData(null); setMmStates(null); setMmLgas(null); loadLgas(variant, disease).then(setLgaData); loadMM(variant, 'states', disease).then(setMmStates) }, [variant, disease])
  useEffect(() => { setLga('') }, [state])
  useEffect(() => { if (lga && !mmLgas) loadMM(variant, 'lgas', disease).then(setMmLgas) }, [lga, mmLgas, variant, disease])

  const mmLoc = lga
    ? (mmLgas ? { dates: mmLgas.dates, models: mmLgas.lgas[`${state}|||${lga}`] } : null)
    : (mmStates ? { dates: mmStates.dates, models: mmStates.states[state] } : null)

  const lgaList = geo[state]?.lgas || []
  const stateSeries = states[state] || []

  // LGA ranking within state (2025 totals from lgaData)
  const lgaRank = useMemo(() => {
    if (!lgaData) return []
    return lgaList.map(l => {
      const series = lgaData[`${state}|||${l}`] || []
      const c2025 = series.filter(s => s.d.startsWith('2025')).reduce((a, b) => a + b.c, 0)
      const c2028 = series.filter(s => s.d.startsWith('2028')).reduce((a, b) => a + b.c, 0)
      return { lga: l, c2025, c2028 }
    }).sort((a, b) => b.c2025 - a.c2025)
  }, [lgaData, state, lgaList])

  const lgaSeries = useMemo(() => {
    if (!lgaData || !lga) return null
    return (lgaData[`${state}|||${lga}`] || []).map(s => ({ date: s.d, cases: s.c, forecast: !!s.f }))
  }, [lgaData, state, lga])

  const stateRankRow = meta.ranking.find(r => r.state === state)
  // Malaria: its own incidence-banded zone() (zoneFor's malaria branch).
  // Other diseases: a genuine state-level burden zone exists only when the
  // disease's capability flag says so (export_disease.py only computes
  // state_zones for diseases whose LGA-level zone concept is meaningful --
  // see disease_config.supports_state_zone). No fabricated zone otherwise.
  const stateZone = meta.state_zones?.[state]
  const z = disease === 'malaria'
    ? zoneFor(disease, stateRankRow?.incidence_2025)
    : (stateZone ? burdenZone(stateZone.burden_score) : null)

  return (
    <>
      <div className="view-head">
        <h2>Geographic Explorer</h2>
        <p>Drill from state to LGA. {disease === 'malaria'
          ? 'Burden zones are derived from annualized confirmed-case incidence per 1,000 population.'
          : 'State and LGA series for the selected indicator.'}</p>
      </div>

      <div className="controls">
        <div className="select-wrap">
          <label>State</label>
          <select value={state} onChange={e => setState(e.target.value)} style={{ minWidth: 220 }}>
            {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="select-wrap">
          <label>LGA (optional)</label>
          <select value={lga} onChange={e => setLga(e.target.value)} style={{ minWidth: 220 }}>
            <option value="">— All LGAs (state view) —</option>
            {lgaList.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        {z && (
          <span className="chip" style={{ borderColor: z.color + '66', color: z.color, alignSelf: 'center' }}>
            {state} · {z.name} burden
          </span>
        )}
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <Card className="col" title={lga ? `${lga} — ${state}` : `${state} — all LGAs`}
          sub="Monthly confirmed cases · select models to overlay forecasts to 2030" style={{ flex: 2, minWidth: 420 }}>
          <ModelOverlay actualSeries={lga ? (lgaSeries || []) : stateSeries} mm={mmLoc} height={330} />
        </Card>
        <Card className="col" title="State indicators" sub="Reported & projected" style={{ flex: 1, minWidth: 280 }}>
          <table className="data">
            <tbody>
              <tr><td>Cases · 2025</td><td className="num">{fmtFull(stateRankRow?.cases_2025)}</td></tr>
              <tr><td>Projected · 2028</td><td className="num">{fmtFull(stateRankRow?.cases_2028)}</td></tr>
              <tr><td>Change 2025→28</td><td className="num" style={{ color: stateRankRow?.change_pct > 0 ? COLORS.coral : COLORS.accent }}>{pct(stateRankRow?.change_pct)}</td></tr>
              <tr><td>Incidence / 1,000 (2025)</td><td className="num">{stateRankRow?.incidence_2025}</td></tr>
              <tr><td>National rank</td><td className="num">#{meta.ranking.findIndex(r => r.state === state) + 1} / {meta.ranking.length}</td></tr>
              <tr><td>LGAs</td><td className="num">{lgaList.length}</td></tr>
            </tbody>
          </table>
        </Card>
      </div>

      <Card title={`LGA burden ranking — ${state}`} sub="Confirmed cases · 2025 (click a bar's LGA in the dropdown to drill in)">
        {lgaRank.length
          ? <HBars data={lgaRank.slice(0, 14).map(r => ({ label: r.lga, value: r.c2025 }))}
              max={lgaRank[0]?.c2025 || 1} color={COLORS.accent2} />
          : <Loading />}
      </Card>
    </>
  )
}

const Loading = () => <div className="loading" style={{ height: 200 }}><div className="spinner" />Loading LGA series…</div>
