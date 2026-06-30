import React, { useState, useMemo, useEffect } from 'react'
import { Card, CompareChart, InfoTip } from '../components'
import { loadLgas, fmt, fmtFull, COLORS, monthLabel } from '../lib'

// per-driver multiplicative effect on cases, relative to the location's forecasted baseline.
// `audience` (0-1) scopes a subgroup-targeted intervention (e.g. under-5 LLIN coverage only
// protects under-5s) so its elasticity can't swing the WHOLE population's case count as if it
// reached every age group — without this, moving a narrow lever looked far more powerful than
// it can actually be. Drivers with no `audience` are population-wide (=1, unscoped).
function factor(meta, val, base) {
  if (meta.good === 'opt') {
    const opt = meta.optimum ?? 27
    const suit = v => 1 - Math.min(1, Math.abs(v - opt) / 12)
    const sb = Math.max(0.05, suit(base))
    return Math.max(0.2, Math.min(2, suit(val) / sb))
  }
  if (!base || base <= 0) return 1
  const frac = (val - base) / base
  const aud = meta.audience ?? 1
  return Math.max(0.2, Math.min(3, 1 + meta.elasticity * frac * aud))
}

export default function Simulator({ data, variant = 'after', disease = 'malaria' }) {
  const { national, states, geo, drivers } = data
  const stateNames = useMemo(() => Object.keys(geo).sort(), [geo])
  const [level, setLevel] = useState('National')   // National | <state>
  const [lga, setLga] = useState('')
  const [vals, setVals] = useState({})
  const [lgaData, setLgaData] = useState(null)
  const [driverPick, setDriverPick] = useState('rain')

  useEffect(() => { setLgaData(null); loadLgas(variant, disease).then(setLgaData) }, [variant, disease])

  // resolve baselines + case series for the current location
  const { baselines, baseSeries, traj, locLabel } = useMemo(() => {
    if (level === 'National')
      return { baselines: drivers.national, baseSeries: national, traj: drivers.national_traj, locLabel: 'Nigeria (national)' }
    if (lga && lgaData) {
      const key = `${level}|||${lga}`
      const series = (lgaData[key] || []).map(s => ({ date: s.d, cases: s.c, forecast: !!s.f }))
      return { baselines: drivers.lgas[key] || drivers.states[level], baseSeries: series, traj: null, locLabel: `${lga}, ${level}` }
    }
    return { baselines: drivers.states[level], baseSeries: states[level] || [], traj: drivers.state_traj[level], locLabel: level }
  }, [level, lga, lgaData, drivers, national, states])

  // reset levers to location baseline whenever location changes
  useEffect(() => {
    if (baselines) setVals(Object.fromEntries(Object.keys(drivers.meta).map(id => [id, baselines[id]?.base ?? 0])))
  }, [baselines, drivers.meta])

  const multiplier = useMemo(() => {
    let m = 1
    for (const id of Object.keys(drivers.meta)) {
      const base = baselines?.[id]?.base ?? 0
      m *= factor(drivers.meta[id], vals[id] ?? base, base)
    }
    return Math.max(0.1, Math.min(4, m))
  }, [vals, baselines, drivers.meta])

  const merged = useMemo(() => baseSeries.map(d => ({
    date: d.date, Baseline: Math.round(d.cases),
    Scenario: d.forecast ? Math.round(d.cases * multiplier) : Math.round(d.cases),
  })), [baseSeries, multiplier])

  const fc = baseSeries.filter(d => d.forecast)
  const baseTotal = fc.reduce((a, b) => a + b.cases, 0)
  const scenTotal = baseTotal * multiplier
  const averted = baseTotal - scenTotal

  const cats = [...new Set(Object.values(drivers.meta).map(m => m.cat))]
  const reset = () => setVals(Object.fromEntries(Object.keys(drivers.meta).map(id => [id, baselines[id]?.base ?? 0])))
  const setScenario = (mult) => setVals(v => {
    // scale protective drivers up / risk drivers per a quick scenario
    const nv = { ...v }
    for (const id of Object.keys(drivers.meta)) {
      const meta = drivers.meta[id], b = baselines[id]?.base ?? 0
      if (meta.good === 'down') nv[id] = Math.min(baselines[id].hi, b * mult)        // more coverage
      else if (meta.good === 'up') nv[id] = Math.max(baselines[id].lo, b * (2 - mult)) // less rain/humidity
    }
    return nv
  })

  const trajData = traj && traj[driverPick]
    ? traj[driverPick].map(p => ({ date: p.date, Driver: p.value, forecast: p.forecast }))
    : null
  const dm = drivers.meta[driverPick]

  return (
    <>
      <div className="view-head">
        <h2>What-If Scenario Simulator</h2>
        <p>Each lever starts at the <b>forecasted baseline</b> for the selected location — the value our driver model
          projects for 2026–2028 (not zero). Move a lever away from its baseline to condition the case forecast on a
          different intervention or climate path. Effects combine multiplicatively via per-driver elasticities.</p>
      </div>

      <div className="controls">
        <div className="select-wrap"><label>State / scope</label>
          <select value={level} onChange={e => { setLevel(e.target.value); setLga('') }} style={{ minWidth: 200 }}>
            <option value="National">Nigeria (national)</option>
            {stateNames.map(s => <option key={s} value={s}>{s}</option>)}
          </select></div>
        {level !== 'National' && (
          <div className="select-wrap"><label>LGA (optional)</label>
            <select value={lga} onChange={e => setLga(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">— whole state —</option>
              {(geo[level]?.lgas || []).map(l => <option key={l} value={l}>{l}</option>)}
            </select></div>
        )}
        <button className="btn" onClick={() => setScenario(1.4)}>Scale-up interventions</button>
        <button className="btn" onClick={() => setScenario(0.7)}>Funding cut</button>
        <button className="btn" onClick={reset}>↺ Reset to baseline</button>
      </div>

      <div className="row">
        <Card className="col" title="Driver levers" sub={`Baseline = forecasted 2026–28 value for ${locLabel}`} style={{ flex: 1, minWidth: 340, maxWidth: 470 }}>
          {cats.map(cat => (
            <div key={cat}>
              <div className="cat-label">{cat}</div>
              {Object.entries(drivers.meta).filter(([, m]) => m.cat === cat).map(([id, meta]) => {
                const b = baselines?.[id] || { base: 0, lo: 0, hi: 1 }
                const v = vals[id] ?? b.base
                const p = ((v - b.lo) / (b.hi - b.lo || 1)) * 100
                const step = meta.unit === '°C' ? 0.1 : (b.hi > 1000 ? 100 : (meta.unit === '%' ? 1 : 0.1))
                const f = factor(meta, v, b.base)
                return (
                  <div className="lever" key={id}>
                    <div className="lever-head">
                      <span className="name">{meta.label}
                        {meta.audience && (
                          <InfoTip title="Scoped to its target group" text={
                            `This only covers ${meta.audience_label}, so its effect on the TOTAL case count is scaled to ` +
                            `that group's share of confirmed cases (×${meta.audience.toFixed(2)}) — not applied as if it ` +
                            `protected everyone. That's why moving this lever changes the total graph more gently than a ` +
                            `population-wide lever like LLINs distributed.`} />
                        )}
                      </span>
                      <span className="val">{v >= 1000 ? fmt(v) : v.toFixed(meta.unit === '°C' || meta.unit === 'mm/d' ? 1 : 0)} {meta.unit}</span>
                    </div>
                    <input type="range" min={b.lo} max={b.hi} value={v} step={step}
                      style={{ '--pct': Math.max(0, Math.min(100, p)) + '%' }}
                      onChange={e => setVals(s => ({ ...s, [id]: +e.target.value }))} />
                    <div className="lever-base">
                      baseline {b.base >= 1000 ? fmt(b.base) : b.base} {meta.unit} ·
                      effect ×<b style={{ color: f <= 1 ? COLORS.green : COLORS.coral }}>{f.toFixed(2)}</b>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </Card>

        <div className="col" style={{ flex: 1.45, minWidth: 420, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="row">
            <Card className="col" style={{ minWidth: 0 }}>
              <div className="scenario-readout">
                <div className="lbl">Scenario cases · 2026–28</div>
                <div className="big" style={{ color: multiplier <= 1 ? COLORS.green : COLORS.coral }}>{fmt(scenTotal)}</div>
                <div className="muted" style={{ fontSize: '.8rem' }}>baseline {fmt(baseTotal)}</div>
              </div>
            </Card>
            <Card className="col" style={{ minWidth: 0 }}>
              <div className="scenario-readout">
                <div className="lbl">{averted >= 0 ? 'Cases averted' : 'Additional cases'}</div>
                <div className="big" style={{ color: averted >= 0 ? COLORS.green : COLORS.coral }}>{fmt(Math.abs(averted))}</div>
                <div className="muted" style={{ fontSize: '.8rem' }}>×{multiplier.toFixed(3)} vs baseline</div>
              </div>
            </Card>
          </div>
          <Card title={`${locLabel} — baseline vs scenario`} sub="Forecast period responds to the levers; history is fixed">
            <CompareChart data={merged} height={270} series={[
              { key: 'Baseline', name: 'Baseline forecast', color: COLORS.accent2, dashed: true },
              { key: 'Scenario', name: 'Scenario', color: multiplier <= 1 ? COLORS.accent : COLORS.coral },
            ]} />
          </Card>
          {trajData && (
            <Card title="Conditional driver outlook" sub="The driver model's own forecast — what the baseline assumes"
              right={<select value={driverPick} onChange={e => setDriverPick(e.target.value)}>
                {Object.entries(drivers.meta).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}</select>}>
              <CompareChart data={trajData.map(d => ({ date: d.date, [dm.label]: d.Driver }))} height={210}
                series={[{ key: dm.label, name: `${dm.label} (${dm.unit})`, color: COLORS.violet }]} unit={' ' + dm.unit} />
              <div className="muted" style={{ fontSize: '.74rem', marginTop: 6 }}>
                Forecast = monthly climatology + damped annual trend. This projected path sets each lever's starting
                baseline, so the scenario is conditioned on a realistic future for {locLabel}.
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
