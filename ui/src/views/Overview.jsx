import React, { useMemo, useState, useEffect } from 'react'
import { Card, KPI, ForecastChart, AnnualBars, HBars, ModelOverlay } from '../components'
import { fmt, fmtFull, pct, COLORS, zone, loadMM } from '../lib'

export default function Overview({ data, variant = 'after' }) {
  const { national, meta } = data
  const ann = meta.summary.national_annual
  const [mm, setMm] = useState(null)
  useEffect(() => { setMm(null); loadMM(variant, 'national').then(setMm) }, [variant])

  const annData = useMemo(() => Object.entries(ann).map(([y, c]) => ({
    year: +y, cases: c, forecast: +y >= 2026,
  })), [ann])

  const c2025 = ann['2025'], c2028 = ann['2028']
  const peakMonth = useMemo(() => {
    const fc = national.filter(d => d.forecast)
    return fc.reduce((a, b) => b.cases > a.cases ? b : a, fc[0])
  }, [national])

  const topStates = meta.ranking.slice(0, 10).map(r => ({ label: r.state, value: r.cases_2025 }))
  const maxState = topStates[0]?.value || 1

  const lastActual = national.filter(d => !d.forecast).slice(-1)[0]

  return (
    <>
      <div className="view-head">
        <h2>National Malaria Surveillance & Outlook</h2>
        <p>Confirmed malaria cases across {meta.summary.n_states} states and {meta.summary.n_lgas} LGAs of Nigeria.
          Actuals run Jan 2023 – Mar 2026; a recursive ensemble of benchmarked models projects the trajectory through Dec 2030.</p>
      </div>

      <div className="grid kpis">
        <KPI label="Confirmed cases · 2025" value={fmt(c2025)} delta={pct((c2025 - ann['2024']) / ann['2024'] * 100) + ' vs 2024'}
          deltaClass={c2025 > ann['2024'] ? 'up' : 'down'} color={COLORS.accent} />
        {['2026', '2027', '2028'].map((yr, i) => {
          const prev = String(+yr - 1)
          return <KPI key={yr} label={`Projected · ${yr}`} value={fmt(ann[yr])}
            delta={ann[prev] ? pct((ann[yr] - ann[prev]) / ann[prev] * 100) + ` vs ${prev}` : ''}
            deltaClass={ann[yr] > ann[prev] ? 'up' : 'down'} color={COLORS.amber} />
        })}
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <Card className="col" title="National monthly confirmed cases" sub="Actual vs model forecasts to 2030 · toggle models to overlay" style={{ flex: 2, minWidth: 420 }}>
          <ModelOverlay actualSeries={national} mm={mm} height={330} />
        </Card>
        <Card className="col" title="Annual totals" sub="2023–25 reported · 2026–28 projected" style={{ flex: 1, minWidth: 300 }}>
          <AnnualBars data={annData} />
        </Card>
      </div>

      <div className="row">
        <Card className="col" title="Top 10 states by burden" sub="Confirmed cases · 2025" style={{ flex: 1, minWidth: 360 }}>
          <HBars data={topStates} max={maxState} color={COLORS.accent} />
        </Card>
        <Card className="col" title="Surveillance snapshot" sub={`Latest reported month · ${lastActual?.date}`} style={{ flex: 1, minWidth: 320 }}>
          <table className="data">
            <tbody>
              <tr><td>Latest reported cases</td><td className="num">{fmtFull(lastActual?.cases)}</td></tr>
              <tr><td>National incidence / 1,000</td><td className="num">{lastActual?.incidence?.toFixed(2)}</td></tr>
              <tr><td>Highest-burden state (2025)</td><td className="num">{meta.ranking[0].state}</td></tr>
              <tr><td>Peak forecast year</td><td className="num">{meta.summary.peak_year}</td></tr>
              <tr><td>Total 2023 → 2028 (Σ)</td><td className="num">{fmt(Object.values(ann).reduce((a, b) => a + b, 0))}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 14 }} className="tag-list">
            {meta.ranking.slice(0, 6).map(r => {
              const z = zone(r.incidence_2025)
              return <span key={r.state} className="chip" style={{ borderColor: z.color + '66', color: z.color }}>
                {r.state} · {z.name}</span>
            })}
          </div>
        </Card>
      </div>
    </>
  )
}
