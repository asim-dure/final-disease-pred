import React, { useState, useMemo, useEffect } from 'react'
import { Card, CompareChart, InfoTip } from '../components'
import { loadLgas, fmt, fmtFull, COLORS, monthLabel, API_BASE } from '../lib'

// ── Mechanistic (Ross-Macdonald) panel ──────────────────────────────────────
// A theory-driven COMPLEMENT to the empirical elasticity levers above, not a
// replacement: instead of "% change in an indicator", the user tunes actual
// entomological/clinical coverage (ITN, IRS, ACT) and sees the classic
// vectorial-capacity / R0 equations respond, grounded in this location's REAL
// population density and recent climate (see backend ross_macdonald.py for
// the full derivation and literature parameter sources).
export function MechanisticPanel({ level, lga, locLabel, baseSeries }) {
  const [itn, setItn] = useState(40)
  const [act, setAct] = useState(45)
  // IRS / IPTp / vaccine start at `null` ("not yet touched") so the FIRST
  // response can seed the slider from the backend's own default -- this
  // location's REAL IPTp1 rate, and the illustrative IRS/vaccine national
  // baselines (see ross_macdonald.py) -- rather than an arbitrary guess.
  const [irs, setIrs] = useState(null)
  const [iptp, setIptp] = useState(null)
  const [vaccine, setVaccine] = useState(null)
  const [mech, setMech] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    const body = { level, lga: lga || null, itn_coverage: itn / 100, act_coverage: act / 100 }
    if (irs != null) body.irs_coverage = irs / 100
    if (iptp != null) body.iptp_coverage = iptp / 100
    if (vaccine != null) body.vaccine_coverage = vaccine / 100
    fetch(`${API_BASE}/whatif-mechanistic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      const d = await r.json().catch(() => null)
      // A non-2xx response (e.g. 404 "no data for this location") still
      // resolves fetch's promise -- it does NOT reject. Treating it as
      // success here was the bug: `d` would be an error body like
      // {"detail": "..."} with no `baseline`/`scenario`/`case_multiplier`,
      // and rendering those as if they existed crashed the whole panel
      // (the "not responding" report). Route non-ok responses to the error
      // state instead of ever setting `mech` from them.
      if (!r.ok) throw new Error((d && d.detail) || `HTTP ${r.status}`)
      return d
    }).then(d => {
      if (!live) return
      setMech(d); setErr(null)
      if (d.available !== false && d.inputs) {
        if (irs == null && d.inputs.irs_coverage != null) setIrs(Math.round(d.inputs.irs_coverage * 100))
        if (iptp == null && d.inputs.iptp_coverage != null) setIptp(Math.round(d.inputs.iptp_coverage * 100))
        if (vaccine == null && d.inputs.vaccine_coverage != null) setVaccine(Math.round(d.inputs.vaccine_coverage * 100))
      }
    }).catch(e => { if (live) { setErr(String(e.message || e)); setMech(null) } })
    return () => { live = false }
  }, [level, lga, itn, irs, act, iptp, vaccine])

  // reset the "not yet touched" sliders whenever the location changes, so a
  // new LGA's own real IPTp1 rate / baselines get picked up again.
  useEffect(() => { setIrs(null); setIptp(null); setVaccine(null) }, [level, lga])

  if (mech && mech.available === false) return null   // non-malaria disease -- silently hidden
  const mechValid = !!(mech && mech.baseline && mech.scenario)   // defensive: never render a malformed response

  const mult = mech?.case_multiplier ?? 1
  const fc = (baseSeries || []).filter(d => d.forecast)
  const baseTotal = fc.reduce((a, b) => a + b.cases, 0)
  const scenTotal = baseTotal * mult
  const merged = (baseSeries || []).map(d => ({
    date: d.date, Baseline: Math.round(d.cases),
    Mechanistic: d.forecast ? Math.round(d.cases * mult) : Math.round(d.cases),
  }))

  const lever = (label, val, setVal, hint) => {
    const v = val ?? 0
    return (
      <div className="lever">
        <div className="lever-head">
          <span className="name">{label}</span>
          <span className="val">{val == null ? '…' : `${v}%`}</span>
        </div>
        <input type="range" min={0} max={100} value={v} step={1}
          style={{ '--pct': v + '%' }} onChange={e => setVal(+e.target.value)} />
        <div className="lever-desc">{hint}</div>
      </div>
    )
  }

  const ctx = mech?.context || {}
  const ctxRow = (label, entry, fmtFn = fmt) => entry && (
    <tr>
      <td>{label}</td>
      <td className="num">{entry.value == null ? 'n/a' : fmtFn(entry.value)}</td>
    </tr>
  )

  return (
    <Card
      title={<span>🦟 Mechanistic (Ross-Macdonald)
        <InfoTip w={420} title="Theory-driven, not trained" text="This panel does NOT use statistical elasticities fit to historical correlations (that's the levers above). It runs the classic Ross-Macdonald vectorial-capacity / R0 equations for malaria transmission, using this location's REAL population density, PfPR, poverty/education deprivation, NDVI and IPTp1 coverage. Coverage sliders map to actual entomological/clinical effects -- ITN reduces biting rate AND kills mosquitoes; IRS kills mosquitoes indoors; ACT shortens the infectious period (discounted by socioeconomic access); IPTp and vaccine coverage are audience-scoped to pregnant women and under-5s respectively, not applied population-wide. Literature/WHO default parameters where no per-LGA data exists -- not fit to this dataset." /></span>}
      sub={mech?.population != null
        ? `${locLabel} — population ${fmt(mech.population)}, density ${mech.inputs?.pop_density ? Math.round(mech.inputs.pop_density).toLocaleString() + '/km²' : 'n/a'}`
        : 'Loading location context…'}
      style={{ marginTop: 18 }}>
      {err && <div className="muted" style={{ fontSize: '.82rem' }}>Mechanistic model unavailable: {err}</div>}
      {mechValid && (
        <>
          <div className="cat-label" style={{ marginTop: 0 }}>Location context
            <InfoTip w={360} title="Where each number comes from" text="Population/PfPR/poverty/education/IPTp1/RDT are real warehouse-sourced data for this location. Pregnant-women and under-5 population are NOT measured per-LGA -- Nigeria doesn't publish that -- so they're derived from population x standard national demographic shares. The socioeconomic index blends poverty (MPI) and education deprivation (literacy proxy) into one 0-100 vulnerability score." /></div>
          <table className="data" style={{ fontSize: '.8rem', marginBottom: 16 }}>
            <tbody>
              {ctxRow('Population', ctx.population)}
              {ctxRow('Population density', { value: mech.inputs?.pop_density }, v => `${Math.round(v).toLocaleString()}/km²`)}
              {ctxRow('Infected population (est.)', ctx.infected_population_estimate)}
              {ctxRow('Pregnant women (est.)', ctx.pregnant_women_population)}
              {ctxRow('Children under 5 (est.)', ctx.under5_population)}
              {ctxRow('Socioeconomic vulnerability', ctx.socioeconomic_vulnerability_index, v => `${v}/100`)}
              {ctxRow('IPTp coverage (reported)', ctx.iptp1_coverage_real, v => `${v}%`)}
              {ctxRow('RDT tests/month (reported)', ctx.rdt_tests_per_month)}
            </tbody>
          </table>

          <div className="row" style={{ gap: 24, alignItems: 'stretch' }}>
            <div className="col" style={{ flex: 1, minWidth: 260, maxWidth: 360 }}>
              <div className="cat-label" style={{ marginTop: 0 }}>Vector control &amp; treatment coverage</div>
              {lever('ITN / LLIN use', itn, setItn, 'Bednet use: deters biting and kills mosquitoes on contact')}
              {lever('IRS coverage', irs, setIrs, 'Indoor residual spraying: kills mosquitoes resting indoors (starts at an illustrative NMEP-consistent baseline -- no per-LGA IRS data exists)')}
              {lever('Effective ACT treatment', act, setAct, 'Shortens the human infectious period; discounted by this area’s socioeconomic access factor')}
              {lever('IPTp coverage (pregnant women)', iptp, setIptp, 'Starts at this LGA’s own reported rate. Scoped to pregnant women only (~4.4% of population) -- not a population-wide effect')}
              {lever('Vaccine / child immunisation', vaccine, setVaccine, 'Starts at an illustrative NDHS-consistent national baseline. Scoped to under-5 children only (~17.5% of population)')}
            </div>
            <div className="col" style={{ flex: 1, minWidth: 260 }}>
              <div className="row" style={{ gap: 12 }}>
                <div className="col scenario-readout" style={{ minWidth: 0 }}>
                  <div className="lbl">R0 (baseline → scenario)</div>
                  <div className="big" style={{ fontSize: '1.5rem' }}>
                    {mech.baseline.R0.toFixed(1)} → <span style={{ color: mech.scenario.R0 < mech.baseline.R0 ? COLORS.green : COLORS.coral }}>{mech.scenario.R0.toFixed(1)}</span>
                  </div>
                </div>
                <div className="col scenario-readout" style={{ minWidth: 0 }}>
                  <div className="lbl">Steady-state prevalence</div>
                  <div className="big" style={{ fontSize: '1.5rem' }}>
                    {(mech.baseline.steady_state_prevalence * 100).toFixed(0)}% → <span style={{ color: mech.scenario.steady_state_prevalence < mech.baseline.steady_state_prevalence ? COLORS.green : COLORS.coral }}>{(mech.scenario.steady_state_prevalence * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: '.76rem', marginTop: 10, lineHeight: 1.6 }}>
                Vectorial capacity: {mech.baseline.vectorial_capacity} → {mech.scenario.vectorial_capacity} infectious bites/day per infectious human.
                Extrinsic incubation ~{mech.derived.extrinsic_incubation_days}d at this location's recent temperature.
                Effective ACT coverage (after access discount): {(mech.derived.act_effective_coverage * 100).toFixed(0)}%.
                Case multiplier ×<b>{mult.toFixed(3)}</b> applied to the forecast below.
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <CompareChart data={merged} height={220} series={[
              { key: 'Baseline', name: 'Baseline forecast', color: COLORS.accent2, dashed: true },
              { key: 'Mechanistic', name: 'Mechanistic scenario', color: mult <= 1 ? COLORS.accent : COLORS.coral },
            ]} />
          </div>
        </>
      )}
    </Card>
  )
}

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

      <MechanisticPanel level={level} lga={lga} locLabel={locLabel} baseSeries={baseSeries} />
    </>
  )
}
