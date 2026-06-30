import React, { useMemo, useState, useEffect } from 'react'
import { Card, KPI, ForecastChart, CompareChart, ModelOverlay } from '../components'
import { fmt, fmtFull, pct, COLORS, MONTHS, loadMM } from '../lib'

export default function Forecast({ data, variant = 'after', disease = 'malaria' }) {
  const { national, states, meta } = data
  const [scope, setScope] = useState('National')
  const stateNames = useMemo(() => ['National', ...Object.keys(states).sort()], [states])
  const [mmNat, setMmNat] = useState(null)
  const [mmStates, setMmStates] = useState(null)
  useEffect(() => { setMmNat(null); setMmStates(null); loadMM(variant, 'national', disease).then(setMmNat); loadMM(variant, 'states', disease).then(setMmStates) }, [variant, disease])
  const mmLoc = scope === 'National' ? mmNat
    : (mmStates ? { dates: mmStates.dates, models: mmStates.states[scope] } : null)

  const series = scope === 'National' ? national
    : (states[scope] || []).map(d => ({ date: d.date, cases: d.cases, forecast: d.forecast, incidence: d.incidence }))

  // seasonal profile: average by calendar month across forecast years (2026-28)
  const seasonal = useMemo(() => {
    const fc = series.filter(d => d.forecast)
    const byM = {}
    fc.forEach(d => { const m = +d.date.split('-')[1]; (byM[m] = byM[m] || []).push(d.cases) })
    return MONTHS.map((name, i) => {
      const arr = byM[i + 1] || []
      return { date: `2027-${String(i + 1).padStart(2, '0')}`, month: name,
        value: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }
    })
  }, [series])

  const fcRows = series.filter(d => d.forecast)
  const annual = useMemo(() => {
    const by = {}
    series.forEach(d => { const y = d.date.slice(0, 4); by[y] = (by[y] || 0) + d.cases })
    return by
  }, [series])

  // A year is "forecast" if any of its rows are forecast===true — derived from
  // the data rather than a hardcoded "2026" cutoff, so this works for diseases
  // whose actual/forecast boundary year differs from malaria's (identical
  // result for malaria itself, since its first forecast row is also 2026).
  const forecastYearSet = useMemo(() => new Set(fcRows.map(d => d.date.slice(0, 4))), [fcRows])
  const forecastYears = useMemo(() => [...forecastYearSet].sort(), [forecastYearSet])

  const peak = fcRows.reduce((a, b) => b.cases > a.cases ? b : a, fcRows[0] || {})
  const trough = fcRows.reduce((a, b) => b.cases < a.cases ? b : a, fcRows[0] || {})

  // monthly seasonal comparison chart data (forecast horizon only, aligned)
  return (
    <>
      <div className="view-head">
        <h2>Forecast to 2030</h2>
        <p>Recursive monthly projection of confirmed cases. The model feeds its own predictions back as lagged
          inputs, with future climate set to each area's monthly climatological normal — producing a seasonal,
          non-linear trajectory rather than a straight-line extrapolation.</p>
      </div>

      <div className="controls">
        <div className="select-wrap">
          <label>Scope</label>
          <select value={scope} onChange={e => setScope(e.target.value)} style={{ minWidth: 220 }}>
            {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid kpis">
        {forecastYears.slice(0, 3).map(y => {
          const prevY = String(+y - 1)
          const cur = annual[y], prev = annual[prevY]
          const delta = (prev != null && prev !== 0) ? pct((cur - prev) / prev * 100) + ` vs ${prevY}` : '—'
          return <KPI key={y} label={`${y} projection`} value={fmt(cur)} delta={delta} deltaClass={prev != null && cur > prev ? 'up' : 'down'} color={COLORS.amber} />
        })}
        <KPI label="Peak transmission month" value={peak?.date?.split('-') ? MONTHS[+peak.date.split('-')[1] - 1] : '—'} delta={`${fmt(peak?.cases)} cases`} deltaClass="flat" color={COLORS.coral} />
      </div>

      <Card title={`${scope} — full trajectory to 2030`} sub="Actual through Mar 2026 · select one or more models to overlay their forecasts" style={{ marginBottom: 18 }}>
        <ModelOverlay actualSeries={series} mm={mmLoc} height={370} />
      </Card>

      <div className="row">
        <Card className="col" title="Seasonal profile of forecast" sub="Mean projected cases by calendar month (2026–2030)" style={{ flex: 1, minWidth: 360 }}>
          <CompareChart data={seasonal.map(s => ({ date: s.date, Cases: Math.round(s.value) }))}
            series={[{ key: 'Cases', name: 'Avg projected cases', color: COLORS.accent2 }]} height={280} />
          <div className="muted" style={{ fontSize: '.78rem', marginTop: 8 }}>
            Peak: <b style={{ color: COLORS.coral }}>{MONTHS[+peak?.date?.split('-')[1] - 1]}</b> ·
            Trough: <b style={{ color: COLORS.accent }}>{MONTHS[+trough?.date?.split('-')[1] - 1]}</b> ·
            Seasonal amplitude {fmt(peak?.cases - trough?.cases)} cases/mo
          </div>
        </Card>
        <Card className="col" title="Annual outlook" sub="Projected totals" style={{ flex: 1, minWidth: 300 }}>
          <table className="data">
            <thead><tr><th>Year</th><th className="num">Cases</th><th className="num">YoY</th><th>Type</th></tr></thead>
            <tbody>
              {Object.entries(annual).map(([y, c], i, arr) => {
                const prev = i > 0 ? arr[i - 1][1] : null
                const yoy = prev ? (c - prev) / prev * 100 : null
                const isF = forecastYearSet.has(y)
                return <tr key={y}>
                  <td>{y}</td>
                  <td className="num">{fmtFull(c)}</td>
                  <td className="num" style={{ color: yoy == null ? '#7d97ab' : yoy > 0 ? COLORS.coral : COLORS.accent }}>{yoy == null ? '—' : pct(yoy)}</td>
                  <td><span className="badge-soft" style={{ background: isF ? 'rgba(255,209,102,.12)' : 'rgba(0,201,167,.12)', color: isF ? COLORS.amber : COLORS.accent }}>{isF ? 'Forecast' : 'Actual'}</span></td>
                </tr>
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}
