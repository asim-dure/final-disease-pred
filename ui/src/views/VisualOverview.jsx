import React, { useState, useEffect, useMemo } from 'react'
import DeckGL from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { Map } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Card, InfoTip, CompareChart, MarkdownLite } from '../components'
import { fmt, COLORS, API_BASE, loadLgas } from '../lib'
import FacilityPanel from './FacilityPanel'
import { ZONE_ORDER, scoreToZone, scoreDetail, buildZones, cl, n0, pctRanks } from '../burdenScore'
import { lgaKeyFor } from '../lgaAlias'
import { blankMapStyle } from '../mapStyle'

const BASE = import.meta.env.BASE_URL || '/'
const NIGERIA = { longitude: 8.7, latitude: 9.3, zoom: 5.2, pitch: 0, bearing: 0 }

// Deep Dive (technical/model-internals pages -- National Overview, Model Lab,
// Data Explorer, Model & Methodology) used to live as its own dropdown in the
// app's TOP nav bar. Per request it now lives ONLY here, as a self-contained
// heading in Visual Overview's own top-right -- a separate, clearly-labelled
// control, not merged into the map/levers/graph content around it.
function DeepDiveMenu({ items, activeView, onNavigate }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onDocClick = e => { if (!e.target.closest('.vo-deepdive-anchor')) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  if (!items?.length) return null
  return (
    <div className="topnav-deepdive vo-deepdive-anchor" style={{ flexShrink: 0 }}>
      <button className="nav-deepdive-toggle" onClick={() => setOpen(o => !o)}
        style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-1)' }}>
        <span className="ico">🧬</span>Deep Dive
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="nav-deepdive-items">
          {items.map(n => (
            <button key={n.id} className={activeView === n.id ? 'active' : ''}
              onClick={() => { onNavigate(n.id); setOpen(false) }}>
              <span className="ico">{n.ico}</span>{n.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const ZONES = {
  'Not a Hotspot': { c: '#64748b', t: '#64748b', fill: [148, 163, 184], a: 90 },
  'Green':         { c: '#16a34a', t: '#16a34a', fill: [22, 163, 74],  a: 200 },
  'Yellow':        { c: '#ca8a04', t: '#a16207', fill: [234, 179, 8],  a: 205 },
  'Amber':         { c: '#ea580c', t: '#c2410c', fill: [234, 88, 12],  a: 210 },
  'Red':           { c: '#dc2626', t: '#dc2626', fill: [220, 38, 38],  a: 215 },
}
// Raised bar for what counts as a hotspot: most LGAs should read "Not a
// Hotspot" rather than every area getting a colour. Only genuinely elevated
// burden (60+) earns a hotspot tier -- see facility_api.py's _ZONE_THRESHOLDS
// for the full rationale (kept identical here for one consistent scale).
// ZONE_ORDER/scoreToZone now live in ../burdenScore (shared with the
// MalariaIQ Dashboard) so the two views can never disagree on a zone again.
const ZONE_INFO = {
  'Red': 'Severe hotspot (burden ≥ 91). Highest priority for interventions.',
  'Amber': 'High burden (81–90). Needs attention.',
  'Yellow': 'Moderate burden (71–80). Watch closely.',
  'Green': 'Low burden (60–70). Under control.',
  'Not a Hotspot': 'Minimal burden (< 60). Not currently a concern.',
}

const LEVERS = [
  { id: 'rain', field: 'rain', label: '🌧️ Rainfall',             cat: '🌍 Environmental Risk',     unit: 'mm/day', agg: 'mean', info: 'Average rainfall. More rain creates more mosquito breeding pools, so the vector-environment part of the score goes up.' },
  { id: 'temp', field: 'temp', label: '🌡️ Temperature',          cat: '🌍 Environmental Risk',     unit: '°C',     agg: 'mean', info: 'Average temperature. Malaria risk peaks around 27 °C; much hotter or colder slows the parasite and lowers the score.' },
  { id: 'hum',  field: 'hum',  label: '💧 Humidity',              cat: '🌍 Environmental Risk',     unit: '%',      agg: 'mean', info: 'Humidity. Higher humidity lets mosquitoes live longer, raising the score.' },
  { id: 'act',  field: 'act',  label: '💊 ACT treatment courses', cat: '💉 Treatment & Diagnostics', unit: 'doses/mo', agg: 'sum', info: 'Malaria treatment courses given. More treatment shrinks the “treatment gap”, lowering the burden score.' },
  { id: 'rdt',  field: 'rdt_done', label: '🧪 RDT tests performed', cat: '💉 Treatment & Diagnostics', unit: 'tests/mo', agg: 'sum', info: 'Rapid diagnostic tests done. Affects the case-trend graph below via its empirical elasticity (more testing catches more real cases sooner); the map\'s own burden score is driven by Fever Testing Rate (testing gap) instead.' },
  { id: 'iptp', field: 'ipt_cov', label: '🤰 IPTp coverage (pregnant women)', cat: '💉 Treatment & Diagnostics', unit: '%', agg: 'mean', info: 'IPTp coverage among pregnant women. Higher coverage shrinks the "IPT gap", lowering the burden score.' },
  { id: 'llin', field: 'llin', label: '🛏️ LLIN nets distributed', cat: '🛡️ Vector Control',        unit: 'nets/mo',  agg: 'sum', info: 'Insecticide-treated nets distributed. More nets shrink the “protection gap”, lowering the burden score.' },
]

// Which of the levers above map onto a real, unit-costed warehouse column
// /ews/api/budget can price (only ACT/LLIN/RDT/IPTp have a ₦ unit-cost table --
// rain/temp/hum aren't actionable spend, and the Mechanistic/population
// sliders belong to a different model entirely with no cost table of its
// own). "Plan Budget" only ever prices THESE four, using whatever % the user
// already set on the lever panel -- no separate intervention picker.
const BUDGET_LEVER_COLS = {
  act: 'ACT Given - Total',
  llin: 'LLIN given – Total',
  rdt: 'MAL - Malaria cases tested with RDT',
  iptp: 'IPTp1 Coverage (institutional)',
}

// Small, always-derived-from-the-scenario-already-built-above budget section,
// living directly under the case-trend graph. Deliberately has NO level/
// state/target/horizon/covariate controls of its own -- it reuses exactly the
// scope (national/state) and lever percentages already set in the panel on
// the left, and stays disabled until at least one BUDGET-RELEVANT lever
// (ACT/LLIN/RDT/IPTp) has actually been moved, so it can never generate a
// "budget" for a scenario that's identical to doing nothing.
function fmtNgn(n) {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1e9) return '₦' + (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return '₦' + (n / 1e6).toFixed(1) + 'M'
  if (Math.abs(n) >= 1e3) return '₦' + (n / 1e3).toFixed(0) + 'K'
  return '₦' + Math.round(n).toLocaleString()
}
const BUDGET_QUICK_PICKS = [10e6, 50e6, 100e6, 500e6]

// "At a glance" summary tiles -- 3-4 plain numbers, no markdown reading
// required, shown ABOVE the full AI-written plan (which stays available but
// collapsed) so the headline answer ("what does this cost / what's the best
// mix") is legible in one glance instead of buried in a long report.
function PlanGlance({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 10, marginTop: 12 }}>
      {items.map(it => (
        <div key={it.label} style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: '.68rem', color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{it.label}</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: it.color || 'var(--txt-0)', marginTop: 2 }}>{it.value}</div>
        </div>
      ))}
    </div>
  )
}

// Two modes, one shared "Plan Budget" section under the trend chart:
//  - "Cost My Scenario": prices out the EXACT levers already set on this page
//    (unchanged forward-mode behaviour, only its result display simplified).
//  - "Optimize for a Budget": the reverse direction the manager asked for --
//    given a ₦ amount, /ews/api/budget-optimize's water-filling solver (see
//    api.py) computes the mathematically-optimal spend mix to MINIMISE cases
//    under that budget (not an LLM guess -- validated against exhaustive
//    brute-force search in test_budget_solver.py), and the AI's only job is
//    to narrate that already-decided allocation.
// Mechanistic sliders don't default to 0 (unlike the empirical LEVERS, which
// are all "0% = untouched") -- ITN/ACT-effectiveness/IRS/vaccine each start
// at a fixed neutral position, so detecting "the user actually moved this"
// means comparing against THESE defaults, not against zero.
const MECH_DEFAULTS = { itn: 40, actMech: 45, irs: 50, vaccine: 50 }

function PlanBudget({ scope, selState, vals, trendFc, population, disease, otherLevers = {} }) {
  const [mode, setMode] = useState('scenario')
  const [plan, setPlan] = useState(null)
  const [glance, setGlance] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [budgetNgn, setBudgetNgn] = useState(50e6)

  const { popPct = 0, densPct = 0, itn = MECH_DEFAULTS.itn, irs = MECH_DEFAULTS.irs,
    actMech = MECH_DEFAULTS.actMech, iptpMech, iptpMechSeed, vaccine = MECH_DEFAULTS.vaccine } = otherLevers

  // What actually has a real ₦ unit cost (ACT/LLIN/RDT/IPTp) -- costed EXACTLY
  // as the user set them, whenever they touched one directly.
  const costedInterventions = {}
  for (const [leverId, col] of Object.entries(BUDGET_LEVER_COLS)) {
    if (vals[leverId]) costedInterventions[col] = vals[leverId]
  }

  // Plan Budget now reacts to ANY lever on this page moving away from its
  // baseline -- empirical (rain/temp/hum/act/treat/rdt/iptp/llin), demographic
  // (population/density), or mechanistic (ITN use, ACT effectiveness, IRS,
  // real-vs-adjusted IPTp, vaccine) -- not just the 4 that happen to have a
  // real unit-cost column. A rainfall or population change still moves the
  // case forecast and still deserves a real, costed response below.
  const empiricalMoved = Object.values(vals || {}).some(v => v)
  const demographicMoved = popPct !== 0 || densPct !== 0
  const mechanisticMoved = itn !== MECH_DEFAULTS.itn || irs !== MECH_DEFAULTS.irs ||
    actMech !== MECH_DEFAULTS.actMech || vaccine !== MECH_DEFAULTS.vaccine ||
    (iptpMechSeed != null && iptpMech !== iptpMechSeed)
  const hasActionableChange = empiricalMoved || demographicMoved || mechanisticMoved

  const baseMean = trendFc.length ? trendFc.reduce((a, r) => a + (r.Baseline || 0), 0) / trendFc.length : 0
  const wiMean = trendFc.length ? trendFc.reduce((a, r) => a + (r.Scenario || 0), 0) / trendFc.length : 0
  const caseDeltaPct = baseMean > 0 ? (wiMean - baseMean) / baseMean * 100 : 0
  const level = scope === 'lgas' && selState ? 'state' : 'national'

  // Nothing directly costable was touched (only rainfall/population/vaccine/
  // mechanistic-only sliders) but the scenario still moves the case forecast
  // -- auto-size a real ACT+LLIN response proportional to that shift (capped
  // at 100%), so there's always something concrete priced instead of quietly
  // doing nothing just because the trigger wasn't one of the 4 costed levers.
  const autoSized = Object.keys(costedInterventions).length === 0 && Math.abs(caseDeltaPct) > 0.5
  const autoPct = Math.round(Math.min(100, Math.abs(caseDeltaPct) * 1.2))
  const effectiveInterventions = autoSized
    ? { [BUDGET_LEVER_COLS.act]: autoPct, [BUDGET_LEVER_COLS.llin]: autoPct }
    : costedInterventions

  const switchMode = m => { setMode(m); setPlan(null); setGlance(null); setErr(null) }

  const generateScenario = async () => {
    setLoading(true); setErr(null); setPlan(null); setGlance(null)
    try {
      const r = await fetch(`${API_BASE}/budget`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level, state_name: level === 'state' ? selState : null,
          target: 'MAL - Malaria cases confirmed (number)', interventions: effectiveInterventions,
          base_monthly_cases: baseMean, whatif_monthly_cases: wiMean,
          population, horizon: trendFc.length,
          months: trendFc.map(d => d.date), base_monthly: trendFc.map(d => d.Baseline),
          whatif_monthly: trendFc.map(d => d.Scenario), disease,
        }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) throw new Error((d && d.detail) || `HTTP ${r.status}`)
      setPlan(d.plan)
      const casesAverted = Math.max(0, baseMean - wiMean)
      setGlance([
        { label: 'Cases averted/mo', value: n0(casesAverted), color: COLORS.green },
        { label: 'Reduction', value: baseMean > 0 ? Math.round(casesAverted / baseMean * 100) + '%' : '—', color: COLORS.green },
        { label: 'Levers costed', value: Object.keys(effectiveInterventions).length },
      ])
    } catch (e) { setErr(String(e.message || e)) }
    setLoading(false)
  }

  const generateOptimized = async () => {
    setLoading(true); setErr(null); setPlan(null); setGlance(null)
    try {
      const r = await fetch(`${API_BASE}/budget-optimize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level, state_name: level === 'state' ? selState : null,
          target: 'MAL - Malaria cases confirmed (number)',
          horizon: trendFc.length || 12, budget_ngn: budgetNgn, disease,
        }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) throw new Error((d && d.detail) || `HTTP ${r.status}`)
      setPlan(d.plan)
      setGlance([
        { label: 'Cases averted/mo', value: n0(d.solver?.cases_averted_per_month || 0), color: COLORS.green },
        { label: 'Reduction', value: (d.solver?.pct_reduction ?? 0) + '%', color: COLORS.green },
        { label: 'Budget used', value: fmtNgn(d.solver?.total_spend_ngn), color: COLORS.accent },
      ])
    } catch (e) { setErr(String(e.message || e)) }
    setLoading(false)
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: '.86rem', color: 'var(--txt-0)' }}>💰 Plan Budget</span>
        <div style={{ display: 'flex', gap: 0, background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 9, padding: 2 }}>
          {[['scenario', '📊 Cost My Scenario'], ['optimize', '🎯 Optimize a Budget']].map(([m, lbl]) => (
            <button key={m} onClick={() => switchMode(m)}
              style={{ border: 'none', cursor: 'pointer', padding: '6px 12px', borderRadius: 7, fontFamily: 'var(--font)',
                fontSize: '.76rem', fontWeight: 700, background: mode === m ? 'var(--bg-1)' : 'transparent',
                color: mode === m ? COLORS.violet : 'var(--txt-2)' }}>{lbl}</button>
          ))}
        </div>
      </div>

      {mode === 'scenario' ? (
        !hasActionableChange ? (
          <div style={{ fontSize: '.8rem', color: 'var(--txt-3)', lineHeight: 1.6 }}>
            Move <b>any lever</b> above (empirical, demographic, or mechanistic) to price out this scenario — this uses the exact scenario you've built on this page, so there's nothing to cost until something changes.
          </div>
        ) : (
          <>
            <div style={{ fontSize: '.74rem', color: 'var(--txt-2)', marginBottom: 8 }}>
              {autoSized ? (
                <>You changed non-costable factors (rainfall/population/vaccine/mechanistic sliders) with no direct spend selected — auto-sizing a real <b>ACT +{autoPct}%, LLIN +{autoPct}%</b> response to offset the resulting {caseDeltaPct >= 0 ? '+' : ''}{caseDeltaPct.toFixed(1)}% case shift. Move ACT/LLIN/RDT/IPTp yourself for exact control.</>
              ) : (
                <>Costing what you've set: {Object.entries(costedInterventions).map(([c, p]) => `${c.split(' ')[0]} ${p > 0 ? '+' : ''}${p}%`).join(', ')}</>
              )}
            </div>
            <button onClick={generateScenario} disabled={loading}
              style={{ padding: '8px 18px', background: COLORS.violet, color: '#fff', border: 'none', borderRadius: 9,
                cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.82rem', fontFamily: 'var(--font)', opacity: loading ? .6 : 1 }}>
              {loading ? '⏳ Generating…' : '💰 Generate Budget Plan'}
            </button>
          </>
        )
      ) : (
        <div>
          <div style={{ fontSize: '.8rem', color: 'var(--txt-2)', marginBottom: 10, lineHeight: 1.6 }}>
            Tell us your budget — a mathematical optimiser (not an AI guess) works out the spend mix across ACT, LLIN, RDT and IPTp that <b>minimises cases</b> for that amount, then AI writes up the deployment plan.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input type="number" value={budgetNgn} min={0} step={1e6} onChange={e => setBudgetNgn(+e.target.value || 0)}
              style={{ width: 160, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', fontFamily: 'var(--font)', fontSize: '.85rem' }} />
            <span style={{ fontSize: '.78rem', color: 'var(--txt-3)' }}>₦ ({fmtNgn(budgetNgn)})</span>
            {BUDGET_QUICK_PICKS.map(v => (
              <button key={v} onClick={() => setBudgetNgn(v)}
                style={{ padding: '5px 11px', borderRadius: 20, border: `1px solid ${budgetNgn === v ? COLORS.violet : 'var(--border)'}`,
                  background: budgetNgn === v ? `${COLORS.violet}18` : 'transparent', color: budgetNgn === v ? COLORS.violet : 'var(--txt-2)',
                  fontSize: '.74rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)' }}>{fmtNgn(v)}</button>
            ))}
          </div>
          <button onClick={generateOptimized} disabled={loading || budgetNgn <= 0}
            style={{ padding: '8px 18px', background: COLORS.violet, color: '#fff', border: 'none', borderRadius: 9,
              cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.82rem', fontFamily: 'var(--font)', opacity: (loading || budgetNgn <= 0) ? .6 : 1 }}>
            {loading ? '⏳ Optimising…' : '🎯 Find Best Plan'}
          </button>
        </div>
      )}

      {err && (
        <div style={{ color: COLORS.coral, fontSize: '.8rem', marginTop: 10, background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 8, padding: '10px 14px' }}>
          <b>Error:</b> {err}
        </div>
      )}
      {glance && !loading && <PlanGlance items={glance} />}
      {plan && !loading && (
        <details style={{ marginTop: 12 }} open>
          <summary style={{ cursor: 'pointer', fontSize: '.8rem', fontWeight: 700, color: 'var(--txt-1)', marginBottom: 8 }}>
            📋 Full AI-written plan (month-by-month deployment, costs, risks)
          </summary>
          <div style={{ marginTop: 8, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', maxHeight: 420, overflowY: 'auto' }}>
            <MarkdownLite text={plan} />
          </div>
        </details>
      )}
    </div>
  )
}

// scoreDetail/pctRanks/buildZones/cl/n0 now live in ../burdenScore (imported
// above) -- shared with the MalariaIQ Dashboard so the two views can never
// disagree on a burden score, zone colour, or hotspot count again.

function applyLevers(x, vals) {
  const y = { ...x }
  for (const L of LEVERS) {
    const pct = vals[L.id] || 0
    if (!pct) continue
    let v = (x[L.field] || 0) * (1 + pct / 100)
    if (L.field === 'temp') v = cl(v, 15, 45)
    if (L.field === 'hum') v = cl(v, 0, 100)
    if (L.field === 'ipt_cov') v = cl(v, 0, 100)
    y[L.field] = Math.max(0, v)
  }
  return y
}

// Case-count multiplier from the SAME lever %-changes that already recolour the
// map, so the map and the case-trend chart respond to one shared control
// surface instead of being two disconnected what-if systems. Reuses the exact
// elasticity-multiplier shape from the What-If Simulator (drivers.py's
// DRIVER_META, via data.drivers.meta) -- rain/temp/hum/act/llin are the same 5
// driver ids in both places, so this is the identical model, not a new one.
function caseMultiplier(vals, baseline, driversMeta) {
  if (!driversMeta) return 1
  let m = 1
  for (const L of LEVERS) {
    const pct = vals[L.id] || 0
    if (!pct) continue
    const meta = driversMeta[L.id]
    if (!meta) continue
    const base = baseline[L.field] || 0
    let v = base * (1 + pct / 100)
    if (L.field === 'temp') v = cl(v, 15, 45)
    if (L.field === 'hum') v = cl(v, 0, 100)
    if (meta.good === 'opt') {
      const opt = meta.optimum ?? 27
      const suit = x => 1 - Math.min(1, Math.abs(x - opt) / 12)
      const sb = Math.max(0.05, suit(base))
      m *= Math.max(0.2, Math.min(2, suit(v) / sb))
    } else if (base > 0) {
      const frac = (v - base) / base
      const aud = meta.audience ?? 1   // e.g. IPTp only affects the ~8% of cases in pregnant women
      m *= Math.max(0.2, Math.min(3, 1 + meta.elasticity * frac * aud))
    }
  }
  return Math.max(0.1, Math.min(4, m))
}

function bbox(geom) {
  let mnx=180,mny=90,mxx=-180,mxy=-90
  const walk = a => { if (Array.isArray(a) && typeof a[0]==='number'){mnx=Math.min(mnx,a[0]);mxx=Math.max(mxx,a[0]);mny=Math.min(mny,a[1]);mxy=Math.max(mxy,a[1])} else if(Array.isArray(a)) a.forEach(walk) }
  walk(geom.coordinates); return [mnx,mny,mxx,mxy]
}

const ZoneChip = ({ zone }) => (
  <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: '.68rem', fontWeight: 700,
    background: ZONES[zone].c + '22', color: ZONES[zone].t, border: `1px solid ${ZONES[zone].c}66`, whiteSpace: 'nowrap' }}>{zone}</span>
)

// per-driver multiplicative effect on cases, relative to the selected scope's
// forecasted baseline -- identical math to Simulator.jsx's own factor(), which
// this replaces for the 12 "thin" diseases (Simulator.jsx's own tab is no
// longer routed to for them -- see App.jsx -- levers/chart/map now live in
// ONE tab here, same as malaria's own merged What If Simulation).
function thinFactor(meta, val, base) {
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

// Client-side port of etl_warehouse_common.burden_score's "volume_trend" tier
// (the ONLY tier the 12 thin diseases use) -- percentile-rank case volume
// (60%) + percentile-rank trend (40%), blended 60/40 rank/raw exactly like
// export_burden.py's own percentile-blend. Needed so a lever-adjusted
// forecast value can be re-ranked against its real peers and recoloured on
// the map, instead of only ever showing the static precomputed (no-lever)
// score. `valueByKey`/`trendByKey`: one cross-section (one month) each.
function volumeTrendScores(valueByKey, trendByKey) {
  const keys = Object.keys(valueByKey)
  if (!keys.length) return {}
  const vol = keys.map(k => valueByKey[k] ?? 0)
  const volRank = pctRanks(vol).map(r => r * 100)
  const trend = keys.map(k => trendByKey[k] ?? 0)
  const trendRank = pctRanks(trend).map(r => r * 100)
  const raw = keys.map((_, i) => 0.60 * volRank[i] + 0.40 * trendRank[i])
  const rawRank = pctRanks(raw).map(r => r * 100)
  const out = {}
  keys.forEach((k, i) => { out[k] = cl(0.60 * rawRank[i] + 0.40 * raw[i], 0, 100) })
  return out
}

// Non-malaria diseases: burden score is precomputed Python-side (etl_warehouse_common.burden_score)
// and read directly from burden.json's flat per-LGA snapshot, PLUS (for the 12 diseases with a real
// drivers.json -- see export_ncd_ntd_drivers.py) live client-side lever recomputation for forecast
// months, using the exact volume_trend formula above. Source "zone" labels vary by disease ("Safe
// Zone", "Red Zone", canonical "Amber", etc.) so the map/legend colour always derives from the
// canonical burden_score via scoreToZone() instead, keeping every disease's colouring consistent.
function StaticZoneMap({ disease, label, variant = 'after', data, rankByLabel, deepDiveItems, activeView, onNavigate }) {
  const [statesGeo, setStatesGeo] = useState(null)
  const [lgasGeo, setLgasGeo] = useState(null)
  const [burden, setBurden] = useState(null)
  const [hover, setHover] = useState(null)
  const [view, setView] = useState(NIGERIA)
  const [scope, setScope] = useState('states')
  const [selState, setSelState] = useState(null)
  const [selKey, setSelKey] = useState(null)
  const [monthIdx, setMonthIdx] = useState(0)
  // Real, research-backed levers (export_ncd_ntd_drivers.py) -- null for any
  // disease without a drivers.json (currently only TB), in which case every
  // lever/scenario-chart element below simply doesn't render (same honest
  // degrade `hasHistory` already uses for TB's missing time slider).
  const [drivers, setDrivers] = useState(null)
  const [vals, setVals] = useState({})
  const [lgaSeries, setLgaSeries] = useState(null)

  useEffect(() => {
    fetch(`${BASE}data/geo/states.geojson`).then(r => r.json()).then(setStatesGeo).catch(() => {})
    fetch(`${BASE}data/geo/lgas.geojson`).then(r => r.json()).then(setLgasGeo).catch(() => {})
  }, [])
  useEffect(() => {
    setBurden(null)
    fetch(`${BASE}data/${variant}/${disease}/burden.json`).then(r => r.json()).then(setBurden).catch(() => setBurden({ lgas: {}, states: {} }))
  }, [variant, disease])
  useEffect(() => {
    setDrivers(null)
    fetch(`${BASE}data/${variant}/${disease}/drivers.json`).then(r => r.json()).then(setDrivers).catch(() => setDrivers(null))
  }, [variant, disease])
  useEffect(() => { setLgaSeries(null); loadLgas(variant, disease).then(setLgaSeries).catch(() => setLgaSeries({})) }, [variant, disease])

  const lgaMap = burden?.lgas || {}
  const stateMap = burden?.states || {}
  const rankBy = burden?.rank_by || 'score'
  const hasScore = !!burden?.has_score

  // History: a real per-LGA / per-state monthly burden-score time series,
  // precomputed Python-side (etl_warehouse_common, export_disease.py) --
  // actually reported months PLUS, for every disease except TB, a forecast
  // tail. The state-level series is rolled up from the SAME per-LGA panel
  // by SUMming each state's LGA values per date (counts are additive) and
  // recomputing burden_score by ranking states against states -- never by
  // averaging the LGA-level scores. Diseases without this (e.g. HIV's
  // hotspot table is snapshot-only) simply have no `history` key, and the
  // map shows only the single latest snapshot, same as before.
  const history = burden?.history
  const hasHistory = !!(history && history.months?.length)
  const months = history?.months || []
  // Default to the FIRST forecast month, not the last actual one -- this is
  // the What-If Simulation tab, so it should open with levers already live
  // and the map already showing a scenario, not on inert reported history
  // that the user has to manually scrub past every time. Falls back to the
  // last month if a disease somehow has no forecast tail at all.
  useEffect(() => {
    if (hasHistory) {
      let i = months.findIndex(m => m.forecast)
      if (i === -1) i = months.length - 1
      setMonthIdx(i)
    }
  }, [hasHistory, months.length])
  const curMonth = months[monthIdx] || null

  // Lever baseline for whatever's currently selected (a specific LGA, a
  // whole state, or the national scope) -- same {base,lo,hi} shape
  // Simulator.jsx already used for these same drivers.json files.
  const driverBaseline = useMemo(() => {
    if (!drivers) return null
    if (scope === 'states') return selKey ? drivers.states[selKey] : drivers.national
    return selKey ? drivers.lgas[selKey] : (selState ? drivers.states[selState] : drivers.national)
  }, [drivers, scope, selKey, selState])

  useEffect(() => {
    if (drivers && driverBaseline) setVals(Object.fromEntries(Object.keys(drivers.meta).map(id => [id, driverBaseline[id]?.base ?? 0])))
  }, [drivers, driverBaseline])

  // A single scalar multiplier from the currently-selected scope's own
  // levers. Because every lever is stored/moved as a RELATIVE fraction of
  // its own baseline (frac = (val-base)/base), this same fraction applies
  // uniformly to every area's own real baseline when propagated to the map
  // below -- i.e. "move Poverty +20%" means +20% relative to each area's
  // OWN real poverty figure, not one number copied everywhere. That's why
  // one multiplier can safely recolour every LGA/state at once.
  const multiplier = useMemo(() => {
    if (!drivers || !driverBaseline) return 1
    let m = 1
    for (const id of Object.keys(drivers.meta)) {
      const base = driverBaseline[id]?.base ?? 0
      m *= thinFactor(drivers.meta[id], vals[id] ?? base, base)
    }
    return Math.max(0.1, Math.min(4, m))
  }, [vals, driverBaseline, drivers])

  // Re-ranked, lever-adjusted burden scores for the CURRENT month/scope --
  // only computed (and only used) when a lever has actually moved AND the
  // current month is a forecast month, exactly matching "moving a lever
  // only conditions the future, never rewrites already-reported history."
  // Falls back to the precomputed static score otherwise (identical to
  // before this change), so the default view is unaffected.
  const adjustedScores = useMemo(() => {
    if (!hasHistory || !drivers || Math.abs(multiplier - 1) < 1e-6 || !curMonth?.forecast) return null
    const store = scope === 'states' ? history.states : history.lgas
    if (!store) return null
    const valueByKey = {}, trendByKey = {}
    Object.entries(store).forEach(([key, arr]) => {
      const raw = arr.value?.[monthIdx]
      if (raw == null) return
      const adj = raw * multiplier
      const prev = arr.value?.[monthIdx - 1]
      valueByKey[key] = adj
      trendByKey[key] = prev != null ? adj - prev : 0
    })
    return volumeTrendScores(valueByKey, trendByKey)
  }, [hasHistory, drivers, multiplier, curMonth, scope, monthIdx, history])

  const scoreFor = key => {
    if (adjustedScores && adjustedScores[key] != null) return adjustedScores[key]
    if (scope === 'states') {
      if (hasHistory && history.states[key]) return history.states[key].burden_score[monthIdx]
      return stateMap[key]?.burden_score ?? 0
    }
    if (hasHistory) {
      const arr = history.lgas[key]?.burden_score
      return arr ? arr[monthIdx] : null
    }
    return lgaMap[key]?.burden_score ?? 0
  }
  const zoneFor = key => scoreToZone(scoreFor(key) ?? 0)

  function bboxFit(features) {
    let b = [180, 90, -180, -90]
    for (const f of features) { const x = bbox(f.geometry); b = [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] }
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, span = Math.max(b[2] - b[0], b[3] - b[1], 0.3)
    setView(v => ({ ...v, longitude: cx, latitude: cy, zoom: Math.min(9, Math.max(5, 7.6 - Math.log2(span))), transitionDuration: 600 }))
  }
  function drillInto(st) { setSelState(st); setScope('lgas'); setSelKey(null); if (lgasGeo) bboxFit(lgasGeo.features.filter(f => f.properties.st === st)) }
  function backToStates() { setSelState(null); setScope('states'); setSelKey(null); setView({ ...NIGERIA, transitionDuration: 600 }) }

  const layers = useMemo(() => {
    if (scope === 'states') {
      if (!statesGeo) return []
      const fillFor = key => { const z = ZONES[zoneFor(key)]; return [...z.fill, z.a] }
      return [new GeoJsonLayer({ id: 'states-static', data: statesGeo, pickable: true, stroked: true, filled: true,
        getFillColor: f => fillFor(f.properties.st), getLineColor: [255, 255, 255], lineWidthMinPixels: 1,
        updateTriggers: { getFillColor: [monthIdx, adjustedScores] },
        onClick: info => info.object && drillInto(info.object.properties.st),
        onHover: info => setHover(info.object ? { ...info, kind: 'state' } : null) })]
    }
    if (!lgasGeo) return []
    const dat = selState ? { ...lgasGeo, features: lgasGeo.features.filter(f => f.properties.st === selState) } : lgasGeo
    const fillFor = key => { const z = ZONES[zoneFor(key)]; return [...z.fill, z.a] }
    return [new GeoJsonLayer({ id: 'lgas-static', data: dat, pickable: true, stroked: true, filled: true,
      getFillColor: f => fillFor(lgaKeyFor(f.properties.st, f.properties.lga)), getLineColor: [255, 255, 255], lineWidthMinPixels: 0.4,
      updateTriggers: { getFillColor: [monthIdx, adjustedScores] },
      onClick: info => info.object && setSelKey(lgaKeyFor(info.object.properties.st, info.object.properties.lga)),
      onHover: info => setHover(info.object ? { ...info, kind: 'lga' } : null) })]
  }, [scope, statesGeo, lgasGeo, selState, lgaMap, stateMap, monthIdx, adjustedScores])

  const dist = useMemo(() => {
    const d = {}; ZONE_ORDER.forEach(z => { d[z] = 0 })
    if (scope === 'states') {
      Object.keys(stateMap).forEach(k => { d[zoneFor(k)]++ })
    } else {
      Object.keys(lgaMap).filter(k => !selState || k.split('|||')[0] === selState).forEach(k => { d[zoneFor(k)]++ })
    }
    return d
  }, [lgaMap, stateMap, scope, selState, monthIdx, adjustedScores])

  const ready = scope === 'states' ? !!statesGeo : !!lgasGeo
  const sel = selKey ? (scope === 'states' ? stateMap[selKey] : lgaMap[selKey]) : null
  const hasStateHistory = !!(history && history.states && Object.keys(history.states).length)
  const hotCount = (dist['Red'] || 0) + (dist['Amber'] || 0)
  const unitCount = scope === 'states' ? Object.keys(stateMap).length : Object.keys(lgaMap).filter(k => !selState || k.split('|||')[0] === selState).length

  // Real case-count series for the line graph -- same national/state/LGA
  // files (national.json/states.json/lgas.json) Simulator.jsx's own chart
  // already reads, scoped to whatever's currently selected on the map above
  // (so the map and the chart always describe the SAME place).
  const { baseSeries, locLabel } = useMemo(() => {
    if (scope === 'lgas' && selKey && lgaSeries) {
      const series = (lgaSeries[selKey] || []).map(s => ({ date: s.d, cases: s.c, forecast: !!s.f }))
      return { baseSeries: series, locLabel: selKey.replace('|||', ', ') }
    }
    if (scope === 'lgas' && selState) return { baseSeries: data?.states?.[selState] || [], locLabel: selState }
    if (scope === 'states' && selKey) return { baseSeries: data?.states?.[selKey] || [], locLabel: selKey }
    return { baseSeries: data?.national || [], locLabel: 'Nigeria (national)' }
  }, [scope, selKey, selState, lgaSeries, data])

  const scenarioMerged = useMemo(() => baseSeries.map(d => ({
    date: d.date, Baseline: Math.round(d.cases || 0),
    Scenario: d.forecast ? Math.round((d.cases || 0) * multiplier) : Math.round(d.cases || 0),
  })), [baseSeries, multiplier])

  const scenFc = baseSeries.filter(d => d.forecast)
  const scenBaseTotal = scenFc.reduce((a, b) => a + (b.cases || 0), 0)
  const scenTotal = scenBaseTotal * multiplier
  const scenAverted = scenBaseTotal - scenTotal
  const firstForecastDate = baseSeries.find(d => d.forecast)?.date

  const leverCats = drivers ? [...new Set(Object.values(drivers.meta).map(m => m.cat))] : []
  const resetLevers = () => { if (drivers && driverBaseline) setVals(Object.fromEntries(Object.keys(drivers.meta).map(id => [id, driverBaseline[id]?.base ?? 0]))) }
  // Mirrors malaria's own showLevers gate exactly: testing a what-if against
  // already-reported history doesn't mean anything, so the levers panel only
  // ever appears once the time slider is on a forecast month.
  const showLevers = !!(drivers && curMonth?.forecast)

  return (
    <>
      <div className="view-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
        <div>
          <h2>{label} — Hotspot Map
            <InfoTip w={320} title="What this map shows" text={`Every Nigerian ${scope === 'states' ? 'state' : 'LGA'} coloured by ${label.toLowerCase()} burden, from the latest available reported snapshot in the warehouse. This is a precomputed score (no live levers — no driver/intervention data exists yet for this disease).`} />
          </h2>
          <p>Zones come from a precomputed burden score (case volume + trend). Ranked by <b>{rankByLabel || (hasScore ? 'Hotspot Score' : 'Case Volume Rank')}</b>{!hasScore && ' — this disease has no modelled risk score, so areas are ranked by reported case volume instead.'}</p>
        </div>
        <DeepDiveMenu items={deepDiveItems} activeView={activeView} onNavigate={onNavigate} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {[['states', 'State view'], ['lgas', 'LGA view']].map(([k, lbl]) => (
            <button key={k} onClick={() => k === 'states' ? backToStates() : setScope('lgas')}
              style={{ border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 6, fontSize: '.78rem', fontWeight: 600, fontFamily: 'var(--font)',
                background: scope === k ? 'var(--bg-1)' : 'transparent', color: scope === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>))}
        </div>
        {scope === 'lgas' && selState && (
          <button className="btn" onClick={backToStates} style={{ padding: '6px 12px' }}>← {selState} (all states)</button>
        )}
        {!hasStateHistory && scope === 'states' && hasHistory && (
          <span className="muted" style={{ fontSize: '.72rem' }}>No state-level time series for this disease yet — showing latest snapshot only.</span>
        )}
      </div>

      {hasHistory && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 200 }}>
              <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
                Time period
                <InfoTip w={300} title="Actual + forecast months" text="Steps through actually-reported months in the warehouse, plus a SARIMAX-forecast tail computed per LGA from that LGA's own monthly history. LGAs with too little real history (under 12 reported months) are left out of the forecast tail rather than extrapolated from too little signal." />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--txt-0)' }}>{curMonth?.label || '—'}</span>
                <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: '.66rem', fontWeight: 700,
                  background: curMonth?.forecast ? 'rgba(217,119,6,.14)' : 'rgba(13,148,136,.14)',
                  color: curMonth?.forecast ? '#b45309' : COLORS.accent,
                  border: `1px solid ${curMonth?.forecast ? '#d97706' : COLORS.accent}55` }}>
                  {curMonth?.forecast ? '🔮 Forecast' : '✓ Actual data'}
                </span>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 280, display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="btn" onClick={() => setMonthIdx(i => Math.max(0, i - 1))} style={{ padding: '6px 11px' }}>‹</button>
              <input type="range" min={0} max={Math.max(0, months.length - 1)} step={1} value={monthIdx}
                style={{ flex: 1, '--pct': (months.length > 1 ? monthIdx / (months.length - 1) * 100 : 0) + '%' }}
                onChange={e => setMonthIdx(+e.target.value)} />
              <button className="btn" onClick={() => setMonthIdx(i => Math.min(months.length - 1, i + 1))} style={{ padding: '6px 11px' }}>›</button>
            </div>
          </div>
        </Card>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {/* ── levers — forecast months only; testing "what if" on real history doesn't mean anything, same gate malaria's own panel uses ── */}
        {showLevers && (
          <Card className="col" title={<span>Levers<InfoTip w={360} title="Real, research-backed levers" text="Each slider moves a real per-LGA baseline (population, poverty/MPI, population density, plus one disease-specific real covariate -- see NCD_NTD_LEVER_RESEARCH.md for every source/citation) by a relative percentage. Population and Poverty are scoped to this disease's real at-risk sub-population (e.g. adult women for breast/cervical cancer), not the whole population. The map and chart to the right both update instantly from the SAME multiplier." /></span>}
            sub={`Baseline = real recent data for ${locLabel}`}
            style={{ flex: 1, minWidth: 300, maxWidth: 390 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn" onClick={resetLevers}>↺ Reset to baseline</button>
            </div>
            {leverCats.map(cat => (
              <div key={cat}>
                <div className="cat-label">{cat}</div>
                {Object.entries(drivers.meta).filter(([, m]) => m.cat === cat).map(([id, meta]) => {
                  const b = driverBaseline?.[id] || { base: 0, lo: 0, hi: 1 }
                  const v = vals[id] ?? b.base
                  const p = ((v - b.lo) / (b.hi - b.lo || 1)) * 100
                  const step = b.hi > 1000 ? Math.max(1, Math.round((b.hi - b.lo) / 200)) : (meta.unit === '%' ? 0.5 : 0.1)
                  const f = thinFactor(meta, v, b.base)
                  return (
                    <div className="lever" key={id}>
                      <div className="lever-head">
                        <span className="name">{meta.label}
                          {meta.audience_label && <InfoTip title="What this lever really covers" text={meta.audience_label} />}
                        </span>
                        <span className="val">{v >= 1000 ? fmt(v) : v.toFixed(1)} {meta.unit}</span>
                      </div>
                      <input type="range" min={b.lo} max={b.hi} value={v} step={step}
                        style={{ '--pct': Math.max(0, Math.min(100, p)) + '%' }}
                        onChange={e => setVals(s => ({ ...s, [id]: +e.target.value }))} />
                      <div className="lever-base">
                        baseline {b.base >= 1000 ? fmt(b.base) : b.base.toFixed(1)} {meta.unit} ·
                        effect ×<b style={{ color: f <= 1 ? COLORS.green : COLORS.coral }}>{f.toFixed(2)}</b>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </Card>
        )}

        {/* ── map + chart, same lever state as the panel on the left ── */}
        <div className="col" style={{ flex: showLevers ? 2 : 1, minWidth: 460, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {drivers && !showLevers && (
            <Card style={{ background: 'rgba(13,148,136,.07)', border: '1px solid rgba(13,148,136,.3)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '.84rem', color: 'var(--txt-1)', lineHeight: 1.6 }}>
                <span style={{ fontSize: '1.1rem' }}>✓</span>
                <div>
                  <b>Showing actual reported data for {curMonth?.label || '—'}.</b> This already happened, so the intervention levers are hidden — there's nothing to simulate against real history.
                  <InfoTip w={300} title="Why no levers here" text="Intervention levers (population, poverty, density, etc.) only make sense when testing future scenarios. For months that already happened, the map simply shows the real reported numbers." />
                  {' '}Move the time slider above into a <b>🔮 Forecast</b> month to unlock the levers and test interventions.
                </div>
              </div>
            </Card>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {ZONE_ORDER.map(z => (
              <div key={z} className="card" style={{ flex: 1, minWidth: 92, padding: '12px 14px', position: 'relative', overflow: 'visible' }}>
                <div className="accent-bar" style={{ background: ZONES[z].c, borderRadius: 'var(--r) 0 0 var(--r)' }} />
                <div style={{ fontSize: '.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: ZONES[z].t, display: 'flex', alignItems: 'center' }}>
                  {z}<InfoTip text={ZONE_INFO[z]} />
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', color: 'var(--txt-0)', marginTop: 4 }}>{dist[z] || 0}</div>
              </div>
            ))}
          </div>

          <Card title={<span>Nigeria — {label} hotspot zones, {scope === 'states' ? 'all states' : (selState ? `${selState} LGAs` : 'all LGAs')}<InfoTip w={300} text={`Click any ${scope === 'states' ? 'state to drill into its LGAs' : 'LGA to see its precomputed score and source data below'}.`} /></span>}
            sub={`Hotspots (Red+Amber): ${hotCount} of ${unitCount} ${scope === 'states' ? 'states' : 'LGAs'}`}
            right={<span className="chip dot">{unitCount} {scope === 'states' ? 'states' : 'LGAs'}</span>}>
            <div style={{ position: 'relative', height: 520, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-3)' }}>
              {!ready && <div className="loading" style={{ height: '100%' }}><div className="spinner" />Loading map…</div>}
              {ready && (
                <DeckGL viewState={view} controller={true} layers={layers} onViewStateChange={e => setView(e.viewState)} style={{ position: 'absolute', inset: 0 }}>
                  <Map key={typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : 'light'} mapStyle={blankMapStyle()} />
                </DeckGL>
              )}
              {hover?.object && (() => {
                if (hover.kind === 'state') {
                  const key = hover.object.properties.st
                  const v = stateMap[key]; if (!v) return null
                  const z = zoneFor(key)
                  const score = scoreFor(key)
                  return (
                    <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: 'var(--bg-2)', border: '1px solid var(--border)',
                      borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                      <div style={{ fontWeight: 700, color: 'var(--txt-0)', marginBottom: 4 }}>{key}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <ZoneChip zone={z} /><span style={{ fontFamily: 'var(--mono)', color: 'var(--txt-1)' }}>{(score ?? 0).toFixed(1)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: '.68rem' }}>value {n0(v.value)} (summed across LGAs){hasHistory && curMonth ? ` · ${curMonth.label}` : ''}</div>
                    </div>
                  )
                }
                const key = lgaKeyFor(hover.object.properties.st, hover.object.properties.lga)
                const v = lgaMap[key]; if (!v) return null
                const z = zoneFor(key)
                const score = scoreFor(key)
                return (
                  <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: 'var(--bg-2)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                    <div style={{ fontWeight: 700, color: 'var(--txt-0)', marginBottom: 4 }}>{hover.object.properties.lga}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <ZoneChip zone={z} /><span style={{ fontFamily: 'var(--mono)', color: 'var(--txt-1)' }}>{(score ?? 0).toFixed(1)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: '.68rem' }}>value {n0(v.value)} · source zone "{v.zone || '—'}"{hasHistory && curMonth ? ` · ${curMonth.label}` : ''}</div>
                  </div>
                )
              })()}
              <div style={{ position: 'absolute', left: 12, bottom: 12, background: 'rgba(255,255,255,.93)', borderRadius: 8, padding: '8px 11px', fontSize: '.68rem', color: 'var(--txt-1)', boxShadow: '0 2px 10px rgba(0,0,0,.08)' }}>
                <div style={{ fontWeight: 700, marginBottom: 5 }}>Hotspot zone</div>
                {ZONE_ORDER.map(z => (<div key={z} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: ZONES[z].c }} />{z}</div>))}
              </div>
            </div>
          </Card>

          {baseSeries.length > 0 && (
            <Card title={`${locLabel} — baseline vs scenario`} sub={showLevers ? 'Forecast period responds to the levers; history is fixed' : 'Move the time slider to a forecast month to unlock levers'}>
              {showLevers && (
                <div className="row" style={{ marginBottom: 14 }}>
                  <Card className="col" style={{ minWidth: 0, background: 'var(--bg-2)' }}>
                    <div className="scenario-readout">
                      <div className="lbl">Scenario cases · forecast horizon</div>
                      <div className="big" style={{ color: multiplier <= 1 ? COLORS.green : COLORS.coral }}>{fmt(scenTotal)}</div>
                      <div className="muted" style={{ fontSize: '.8rem' }}>baseline {fmt(scenBaseTotal)}</div>
                    </div>
                  </Card>
                  <Card className="col" style={{ minWidth: 0, background: 'var(--bg-2)' }}>
                    <div className="scenario-readout">
                      <div className="lbl">{scenAverted >= 0 ? 'Cases averted' : 'Additional cases'}</div>
                      <div className="big" style={{ color: scenAverted >= 0 ? COLORS.green : COLORS.coral }}>{fmt(Math.abs(scenAverted))}</div>
                      <div className="muted" style={{ fontSize: '.8rem' }}>×{multiplier.toFixed(3)} vs baseline</div>
                    </div>
                  </Card>
                </div>
              )}
              <CompareChart data={scenarioMerged} height={270} splitDate={firstForecastDate} splitLabel="Forecast →" series={[
                { key: 'Baseline', name: 'Baseline forecast', color: COLORS.accent2, dashed: true },
                { key: 'Scenario', name: 'Scenario', color: multiplier <= 1 ? COLORS.accent : COLORS.coral },
              ]} />
            </Card>
          )}
        </div>
      </div>

      {scope === 'lgas' && selKey && selKey.includes('|||') && (
        <FacilityPanel disease={disease} stateName={selKey.split('|||')[0]} lga={selKey.split('|||')[1]} selMonth={curMonth}
          lgaBurden={scoreFor(selKey)} lgaZone={scoreToZone(scoreFor(selKey) ?? 0)} />
      )}

      {sel && (
        <Card style={{ marginTop: 18 }} title={`${scope === 'states' ? selKey : selKey.split('|||')[1]} — precomputed snapshot`}
          sub={hasHistory && curMonth ? curMonth.label : (sel.year && sel.month ? `${sel.year}-${String(sel.month).padStart(2, '0')}` : 'latest available')}>
          <table className="data" style={{ fontSize: '.8rem' }}>
            <tbody>
              <tr><td>Reported value{scope === 'states' && ' (summed across LGAs)'}</td><td className="num">{n0(sel.value)}</td></tr>
              {scope === 'lgas' && hasScore && <tr><td>Risk score (source)</td><td className="num">{sel.score ?? '—'}</td></tr>}
              <tr><td>Burden score (0–100)</td><td className="num">{(scoreFor(selKey) ?? 0).toFixed(1)}</td></tr>
              <tr><td>Zone{scope === 'lgas' && ' (source label)'}</td><td className="num">{sel.zone || '—'}</td></tr>
              <tr><td>Population</td><td className="num">{scope === 'states' ? n0(sel.population) : (sel.population_match ? n0(sel.population) : 'no data')}</td></tr>
            </tbody>
          </table>
        </Card>
      )}

    </>
  )
}

export default function VisualOverview({ data, variant = 'after', allLgas = false, disease = 'malaria', deepDiveItems, activeView, onNavigate }) {
  if (disease !== 'malaria') {
    const label = data?.meta?.label || disease
    return <StaticZoneMap disease={disease} label={label} variant={variant} data={data} deepDiveItems={deepDiveItems} activeView={activeView} onNavigate={onNavigate} />
  }
  const [statesGeo, setStatesGeo] = useState(null)
  const [lgasGeo, setLgasGeo] = useState(null)
  const [burden, setBurden] = useState(null)
  const [scope, setScope] = useState(allLgas ? 'lgas' : 'states')
  const [selState, setSelState] = useState(null)
  const [monthIdx, setMonthIdx] = useState(0)
  const [vals, setVals] = useState(Object.fromEntries(LEVERS.map(l => [l.id, 0])))
  const [hover, setHover] = useState(null)
  const [view, setView] = useState(NIGERIA)
  const [selKey, setSelKey] = useState(null)
  // The Mechanistic (Ross-Macdonald) factors are NOT a separate section -- they
  // are additional levers in the SAME "Intervention levers" panel below (one
  // list of levers, not two parallel systems). "Plan Budget" (see PlanBudget
  // above) sits directly under the case-trend chart further down this page --
  // a compact section that prices out whatever scenario is already built
  // here, not a separate SARIMAX-run tab -- Budget Planning no longer has its
  // own top-level nav tab.
  const [showBreakdown, setShowBreakdown] = useState(false)

  // Mechanistic sliders (0-100). IPTp starts `null` ("not yet touched") so the
  // first backend response seeds it from this location's REAL reported IPTp
  // rate. IRS and vaccine coverage have NO real per-LGA data anywhere (see
  // ross_macdonald.py) -- rather than seed them from an arbitrary illustrative
  // national baseline, they start at a neutral 50 (the middle of the slider)
  // and every increment/decrement still runs through the real Ross-Macdonald
  // equations -- a genuine "what if this were the coverage" assessment, built
  // logically from theory even though there's no measured number to anchor to.
  const [itn, setItn] = useState(40)
  const [actMech, setActMech] = useState(45)
  const [irs, setIrs] = useState(50)
  const [iptpMech, setIptpMech] = useState(null)
  // The value iptpMech was last SEEDED to (this location's real reported
  // rate) -- iptpMech itself changes the instant the user drags the slider,
  // so comparing iptpMech to this seed (not to a fixed constant) is the only
  // way to tell "user actually moved this" apart from "just loaded".
  const [iptpMechSeed, setIptpMechSeed] = useState(null)
  const [vaccine, setVaccine] = useState(50)
  const [mech, setMech] = useState(null)
  const [mechErr, setMechErr] = useState(null)
  // Demographic what-if levers (% change vs the area's real numbers). Population
  // scales cases roughly linearly (weighted 0.8 — more people, more infections,
  // but sub-linear once you account for shared vector pools). Density flows
  // through the mechanistic model: denser settlements DILUTE mosquitoes-per-
  // person (Ross-Macdonald density_dilution), so more density LOWERS per-person
  // transmission. Both start at 0 (= the real value, no change).
  const [popPct, setPopPct] = useState(0)
  const [densPct, setDensPct] = useState(0)

  useEffect(() => {
    fetch(`${BASE}data/geo/states.geojson`).then(r => r.json()).then(setStatesGeo).catch(() => {})
    fetch(`${BASE}data/geo/lgas.geojson`).then(r => r.json()).then(setLgasGeo).catch(() => {})
  }, [])
  // no-store: this is the same file the MalariaIQ Dashboard reads -- never
  // trust a stale browser cache of it, so the two views can't silently drift
  // apart after burden.json is regenerated.
  useEffect(() => { setBurden(null); fetch(`${BASE}data/${variant}/burden.json`, { cache: 'no-store' }).then(r => r.json()).then(setBurden).catch(() => {}) }, [variant])

  const months = burden?.months || []
  const fieldsAll = burden?.fields || []
  // default to most recent ACTUAL month
  useEffect(() => {
    if (burden && months.length) { let i = months.length - 1; while (i > 0 && months[i].forecast) i--; setMonthIdx(i) }
  }, [burden])
  const curMonth = months[monthIdx] || { label: '—', forecast: false }
  // Intervention levers only make sense for forecast months — testing "what if"
  // against real, already-happened history is meaningless, so the panel is
  // hidden for actual months and the map falls back to the unmodified baseline.
  const showLevers = !!curMonth.forecast

  // Mechanistic (Ross-Macdonald) location: whichever state/LGA the map is
  // currently focused on, mapped onto the same level/lga shape the backend
  // expects. Falls back to National when nothing is selected yet.
  const mechLevel = scope === 'lgas' ? (selState || (selKey ? selKey.split('|||')[0] : 'National')) : (selKey || 'National')
  const mechLga = scope === 'lgas' && selKey ? selKey.split('|||')[1] : null
  const mechLocLabel = mechLga ? `${mechLga}, ${mechLevel}` : (mechLevel === 'National' ? 'Nigeria (national)' : mechLevel)

  useEffect(() => {
    let live = true
    // IRS/vaccine always send an explicit value (fixed 50 default, or
    // wherever the user has moved them) -- never fall back to the backend's
    // own illustrative baseline, so the slider position is always the truth.
    const body = { level: mechLevel, lga: mechLga, itn_coverage: itn / 100, act_coverage: actMech / 100,
                   irs_coverage: irs / 100, vaccine_coverage: vaccine / 100,
                   pop_density_scale: 1 + densPct / 100 }
    if (iptpMech != null) body.iptp_coverage = iptpMech / 100
    fetch(`${API_BASE}/whatif-mechanistic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      const d = await r.json().catch(() => null)
      if (!r.ok) throw new Error((d && d.detail) || `HTTP ${r.status}`)
      return d
    }).then(d => {
      if (!live) return
      setMech(d); setMechErr(null)
      if (d.available !== false && d.inputs && iptpMech == null && d.inputs.iptp_coverage != null) {
        const seeded = Math.round(d.inputs.iptp_coverage * 100)
        setIptpMech(seeded); setIptpMechSeed(seeded)
      }
    }).catch(e => { if (live) { setMechErr(String(e.message || e)); setMech(null) } })
    return () => { live = false }
  }, [mechLevel, mechLga, itn, irs, actMech, iptpMech, vaccine, densPct])

  // reset ONLY the "not yet touched" real-data slider (IPTp) whenever the
  // location changes, so a new LGA's own real reported rate gets picked up
  // again. IRS/vaccine keep whatever position the user left them at -- they
  // have no per-LGA "real" value to re-seed from anyway.
  useEffect(() => { setIptpMech(null); setIptpMechSeed(null) }, [mechLevel, mechLga])

  const mechValid = !!(mech && mech.available !== false && mech.baseline && mech.scenario)
  const mechMult = mechValid ? mech.case_multiplier : 1
  // Population lever: direct case scaling (weight 0.8). Density's effect is
  // already inside mechMult (it changed pop_density in the mechanistic call).
  const popMult = Math.max(0.1, 1 + (popPct / 100) * 0.8)

  const inputsFor = (store, key) => {
    const a = store?.[key]; if (!a) return null
    const o = {}; for (const f of fieldsAll) o[f] = a[f] ? (a[f][monthIdx] ?? 0) : 0
    return o
  }

  const units = useMemo(() => {
    if (!burden) return []
    if (scope === 'states' && statesGeo)
      return statesGeo.features.map(f => ({ key: f.properties.st, name: f.properties.st, x: inputsFor(burden.states, f.properties.st) })).filter(u => u.x)
    if (scope === 'lgas' && lgasGeo) {
      const fs = lgasGeo.features.filter(f => !selState || f.properties.st === selState)
      // Dedupe by (aliased) key: ~32 LGAs are riverine/multi-part polygons
      // split into 2+ separate geojson features (e.g. Nembe, Yola North) --
      // without deduping, each polygon piece became its own scoring unit,
      // double-counting that LGA in every zone tally. lgaKeyFor() also
      // reconciles the ~30 LGAs whose geojson spelling differs from
      // burden.json's (see ../lgaAlias) so they actually join to their data
      // instead of silently dropping out.
      // (Plain object, not `new Map()` -- `Map` is shadowed in this file by
      // the react-map-gl <Map> component import.)
      const seen = {}
      fs.forEach(f => {
        const k = lgaKeyFor(f.properties.st, f.properties.lga)
        if (!seen[k]) seen[k] = { key: k, name: f.properties.lga, st: f.properties.st, x: inputsFor(burden.lgas, k) }
      })
      return Object.values(seen).filter(u => u.x)
    }
    return []
  }, [burden, scope, statesGeo, lgasGeo, selState, monthIdx])

  // ALL LGAs nationally, regardless of the current selState drill-down --
  // used ONLY as a stable, always-national reference for peer-average and
  // raw-score normalisation (see below). Without this, drilling into one
  // state would silently re-baseline "peer average" and "worst LGA" to just
  // THAT state's own ~10-30 LGAs, so even a genuinely low-burden state's
  // least-bad LGA could look like the worst in the country -- the same class
  // of bug the facility-level score was fixed for earlier (anchoring to a
  // local peer group makes relative severity look absolute).
  const allLgaUnits = useMemo(() => {
    if (!burden?.lgas || !lgasGeo) return []
    // Same dedupe + alias treatment as `units` above -- this feeds peerAvg and
    // rawRange, so double-counted/unmatched LGAs would otherwise skew the
    // national normalisation, not just the display counts. Plain object, not
    // `new Map()` -- `Map` is shadowed here by the react-map-gl <Map> import.
    const seen = {}
    lgasGeo.features.forEach(f => {
      const k = lgaKeyFor(f.properties.st, f.properties.lga)
      if (!seen[k]) seen[k] = { key: k, x: inputsFor(burden.lgas, k) }
    })
    return Object.values(seen).filter(u => u.x)
  }, [burden, lgasGeo, monthIdx])

  const unitMap = useMemo(() => Object.fromEntries(units.map(u => [u.key, u])), [units])
  // Peer average: for LGAs, ALWAYS the national LGA average (not just the
  // currently-drilled-into state's LGAs) -- "connected equally" across the
  // whole map, not re-baselined per state.
  const peerAvg = useMemo(() => {
    const src = scope === 'lgas' ? allLgaUnits : units
    return src.length ? src.reduce((a, u) => a + (u.x.cases || 0), 0) / src.length : 0
  }, [scope, units, allLgaUnits])
  const flags = burden?.flags || {}
  // Raw-score normalisation range: also always national for LGAs, so the
  // Red/Amber/Yellow bands reflect genuine nationwide severity, not "worst of
  // whichever subset happens to be on screen."
  const rawRange = useMemo(() => {
    const src = scope === 'lgas' ? allLgaUnits : units
    if (!src.length) return null
    const raws = src.map(u => scoreDetail(u.x, peerAvg, flags).raw)
    return [Math.min(...raws), Math.max(...raws)]
  }, [scope, units, allLgaUnits, peerAvg, flags])
  const baseZ = useMemo(() => buildZones(units, peerAvg, flags, rawRange), [units, peerAvg, flags, rawRange])
  // Scenario zones fold in BOTH lever systems: the empirical per-field changes
  // (applyLevers) AND the mechanistic + population case multiplier, applied to
  // each unit's case count. Because rawRange is anchored to the BASELINE range,
  // scaling scenario cases down/up genuinely shifts each area's normalised
  // score, so moving the Ross-Macdonald / population levers now repaints the
  // map, not just the selected-area breakdown.
  const scenZ = useMemo(() => buildZones(units.map(u => {
    const lx = applyLevers(u.x, vals)
    return { key: u.key, x: { ...lx, cases: (lx.cases || 0) * mechMult * popMult } }
  }), peerAvg, flags, rawRange), [units, peerAvg, vals, flags, rawRange, mechMult, popMult])
  // What's actually displayed: scenario zones on forecast months, plain baseline on actual months.
  const dispZ = showLevers ? scenZ : baseZ

  const scopeBaseline = useMemo(() => {
    if (!burden) return {}
    if (scope === 'lgas' && selState) return inputsFor(burden.states, selState) || {}
    const sts = statesGeo ? statesGeo.features.map(f => inputsFor(burden.states, f.properties.st)).filter(Boolean) : []
    const o = {}
    for (const L of LEVERS) {
      if (L.agg === 'sum') o[L.field] = sts.reduce((a, s) => a + (s[L.field] || 0), 0)
      else o[L.field] = sts.length ? sts.reduce((a, s) => a + (s[L.field] || 0), 0) / sts.length : 0
    }
    // population/density aren't levers (nothing to slide), but are shown as
    // location-baseline context per manager request -- population sums
    // across states (national total), density is the national average.
    o.population = sts.reduce((a, s) => a + (s.population || 0), 0)
    o.pop_density = sts.length ? sts.reduce((a, s) => a + (s.pop_density || 0), 0) / sts.length : 0
    return o
  }, [burden, scope, selState, monthIdx, statesGeo])

  // Include mechMult + popMult so the deck.gl layer's getFillColor actually
  // re-runs when the Ross-Macdonald / population levers move (they change scenZ
  // but not `vals`, so without this the map would keep its old colours).
  const colorVer = useMemo(() => JSON.stringify(vals) + scope + (selState || '') + monthIdx + ':' + mechMult.toFixed(3) + ':' + popMult.toFixed(3),
    [vals, scope, selState, monthIdx, mechMult, popMult])

  const layers = useMemo(() => {
    const fillFor = key => { const z = dispZ[key]; const Z = ZONES[z ? z.zone : 'Not a Hotspot']; return [...Z.fill, Z.a] }
    if (scope === 'states' && statesGeo) {
      return [new GeoJsonLayer({ id: 'states', data: statesGeo, pickable: true, stroked: true, filled: true,
        getFillColor: f => fillFor(f.properties.st), getLineColor: [255,255,255], lineWidthMinPixels: 1,
        updateTriggers: { getFillColor: colorVer },
        onClick: info => info.object && drillInto(info.object.properties.st),
        onHover: info => setHover(info.object ? { ...info, kind: 'state' } : null) })]
    }
    if (scope === 'lgas' && lgasGeo) {
      const dat = selState ? { ...lgasGeo, features: lgasGeo.features.filter(f => f.properties.st === selState) } : lgasGeo
      return [new GeoJsonLayer({ id: 'lgas', data: dat, pickable: true, stroked: true, filled: true,
        getFillColor: f => fillFor(lgaKeyFor(f.properties.st, f.properties.lga)), getLineColor: [255,255,255], lineWidthMinPixels: 0.4,
        updateTriggers: { getFillColor: colorVer },
        onClick: info => info.object && setSelKey(lgaKeyFor(info.object.properties.st, info.object.properties.lga)),
        onHover: info => setHover(info.object ? { ...info, kind: 'lga' } : null) })]
    }
    return []
  }, [scope, statesGeo, lgasGeo, selState, dispZ, colorVer])

  function fitTo(features) {
    let b = [180,90,-180,-90]
    for (const f of features) { const x = bbox(f.geometry); b = [Math.min(b[0],x[0]),Math.min(b[1],x[1]),Math.max(b[2],x[2]),Math.max(b[3],x[3])] }
    const cx=(b[0]+b[2])/2, cy=(b[1]+b[3])/2, span=Math.max(b[2]-b[0],b[3]-b[1],0.3)
    setView(v => ({ ...v, longitude: cx, latitude: cy, zoom: Math.min(9, Math.max(5, 7.6 - Math.log2(span))), transitionDuration: 600 }))
  }
  function drillInto(st) { if (allLgas) return; setSelState(st); setScope('lgas'); setSelKey(null); if (lgasGeo) fitTo(lgasGeo.features.filter(f => f.properties.st === st)) }
  function backToStates() { setSelState(null); setScope('states'); setSelKey(null); setView({ ...NIGERIA, transitionDuration: 600 }) }

  const setLever = (id, v) => setVals(s => ({ ...s, [id]: v }))
  // Was only resetting the empirical levers + population/density -- the 5
  // Mechanistic (Ross-Macdonald) sliders (ITN, IRS, ACT effectiveness, IPTp,
  // Vaccine) kept whatever position the user left them at, so the case-trend
  // line/numbers (which factor in mechMult from those sliders too) never
  // fully returned to baseline. Reset every lever on the page now.
  const reset = () => {
    setVals(Object.fromEntries(LEVERS.map(l => [l.id, 0])))
    setPopPct(0); setDensPct(0)
    setItn(40); setActMech(45); setIrs(50); setVaccine(50)
    setIptpMech(null); setIptpMechSeed(null)   // re-seeds from this location's real reported rate
  }
  const scaleUp = () => setVals({ rain: -30, temp: 0, hum: -20, act: 60, llin: 80 })

  const dist = useMemo(() => {
    const d = { base: {}, scen: {} }; ZONE_ORDER.forEach(z => { d.base[z] = 0; d.scen[z] = 0 })
    units.forEach(u => { d.base[baseZ[u.key]?.zone]++; d.scen[dispZ[u.key]?.zone]++ })
    return d
  }, [units, baseZ, dispZ])

  // No auto-selection: stay on the NATIONAL aggregate (map fully zoomed out,
  // no area highlighted) until the user explicitly clicks a state or LGA --
  // previously this silently jumped to whichever area ranked #1 by burden
  // (e.g. "Kaduna") the moment the tab opened, which read as an arbitrary,
  // unexplained default rather than "nothing selected yet".
  useEffect(() => { if (selKey && !unitMap[selKey]) setSelKey(null) }, [unitMap, selKey])

  const hotBase = (dist.base['Red'] || 0) + (dist.base['Amber'] || 0)
  const hotScen = (dist.scen['Red'] || 0) + (dist.scen['Amber'] || 0)
  const ready = (scope === 'states' && statesGeo) || (scope === 'lgas' && lgasGeo)
  const cats = [...new Set(LEVERS.map(l => l.cat))]

  const sel = selKey && unitMap[selKey] ? unitMap[selKey] : null
  // Mechanistic sliders scale the case input too, so the selected area's
  // score/calculation-breakdown responds to ALL levers in the one panel, not
  // just the empirical ones.
  const selScenX = sel ? (showLevers ? { ...applyLevers(sel.x, vals), cases: (sel.x.cases || 0) * mechMult * popMult } : sel.x) : null
  const selDetail = sel ? scoreDetail(selScenX, peerAvg, flags) : null
  const selZ = sel ? dispZ[sel.key] : null
  const selBaseZ = sel ? baseZ[sel.key] : null

  // ── Case-trend chart: NATIONAL aggregate until a state/LGA is explicitly
  // selected (no arbitrary "pick the #1 area" default), then the selected
  // area's own series. SAME lever state (`vals` + mechanistic sliders) that
  // recolours the map above also drives this chart's scenario line -- one
  // control surface, two live views (map + graph), combining the empirical
  // elasticity model AND the mechanistic Ross-Macdonald model multiplicatively.
  // Whatever is CURRENTLY IN VIEW, for the trend chart: an explicitly clicked
  // LGA/state if `selKey` is set; otherwise, if the map has been drilled into
  // a state (scope 'lgas' with `selState` but no specific LGA clicked yet),
  // that STATE's own aggregate -- NOT the national total. Previously this
  // fell through to the national series the moment you drilled into a state
  // (selKey stayed null), so the graph kept showing Nigeria-wide cases and the
  // lever multiplier got applied to the WRONG (much larger) base -- which is
  // also why "cases averted" read in the millions for a single state/LGA.
  const rawSel = selKey
    ? (scope === 'states' ? burden?.states?.[selKey] : burden?.lgas?.[selKey])
    : (scope === 'lgas' && selState ? burden?.states?.[selState] : null)
  const nationalCases = useMemo(() => {
    if (!burden?.states || !months.length) return null
    const sts = Object.values(burden.states)
    return months.map((_, i) => sts.reduce((a, s) => a + (typeof s.cases?.[i] === 'number' ? s.cases[i] : 0), 0))
  }, [burden, months.length])
  const trendMult = useMemo(() => caseMultiplier(vals, scopeBaseline, data?.drivers?.meta), [vals, scopeBaseline, data])
  const combinedMult = trendMult * mechMult * popMult
  const trendLabel = sel ? sel.name : (scope === 'lgas' && selState ? selState : 'Nigeria (national)')
  const trendData = useMemo(() => {
    const casesArr = rawSel?.cases || nationalCases
    if (!casesArr || !months.length) return []
    return months.map((m, i) => {
      const c = casesArr[i]
      const base = (typeof c === 'number') ? Math.round(c) : null
      return { date: m.ym, Baseline: base, Scenario: (m.forecast && base != null) ? Math.round(base * combinedMult) : base }
    })
  }, [rawSel, nationalCases, months, combinedMult])
  const firstForecastYm = months.find(m => m.forecast)?.ym
  const trendFc = trendData.filter((_, i) => months[i]?.forecast)
  const trendBaseTotal = trendFc.reduce((a, r) => a + (r.Baseline || 0), 0)
  const trendScenTotal = trendFc.reduce((a, r) => a + (r.Scenario || 0), 0)
  const trendAverted = trendBaseTotal - trendScenTotal

  return (
    <>
      <div className="view-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
        <div>
          <h2>{allLgas ? 'Visual Overview — All LGAs' : 'Visual Overview'}
            <InfoTip w={320} title="What this map shows"
              text={allLgas
                ? 'Every one of Nigeria’s 768 local government areas (LGAs) coloured by malaria hotspot zone, all at once. No need to click into a state. Use the month slider to watch hotspots grow in the rainy season, and the levers to test interventions.'
                : 'Nigeria coloured by malaria hotspot zone. Start with 37 states; click any state to drill into its LGAs. Use the month slider to move through time and the levers to test interventions.'} />
          </h2>
          <p>Hotspot zones (🔴 Red · 🟠 Amber · 🟡 Yellow · 🟢 Green · ⚪ Not a Hotspot) come from a burden score built on disease load,
            transmission risk, vector environment & protection gaps. {allLgas ? 'All LGAs are shown together.' : 'Click a state to drill into its LGAs.'} Move the
            levers — each area recomputes live and the map repaints.</p>
        </div>
        <DeepDiveMenu items={deepDiveItems} activeView={activeView} onNavigate={onNavigate} />
      </div>

      {!allLgas && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
            {[['states', 'State view'], ['lgas', 'LGA view']].map(([k, lbl]) => (
              <button key={k} onClick={() => k === 'states' ? backToStates() : setScope('lgas')}
                style={{ border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 6, fontSize: '.78rem', fontWeight: 600, fontFamily: 'var(--font)',
                  background: scope === k ? 'var(--bg-1)' : 'transparent', color: scope === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>))}
          </div>
          {scope === 'lgas' && selState && (
            <button className="btn" onClick={backToStates} style={{ padding: '6px 12px' }}>← {selState} (all states)</button>
          )}
        </div>
      )}

      {/* ── TIME PERIOD selector ── */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
              Time period
              <InfoTip w={300} title="Actual vs forecast"
                text="The data is monthly. This slider picks which month the map shows. Months up to Dec 2025 are ACTUAL reported data; 2026 months are a FORECAST built from the typical seasonal pattern. Notice how the hotspots grow in the rainy season (Jun–Oct) and ease in the dry months." />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--txt-0)' }}>{curMonth.label}</span>
              <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: '.66rem', fontWeight: 700,
                background: curMonth.forecast ? 'rgba(217,119,6,.14)' : 'rgba(13,148,136,.14)',
                color: curMonth.forecast ? COLORS.amber : COLORS.accent,
                border: `1px solid ${curMonth.forecast ? COLORS.amber : COLORS.accent}55` }}>
                {curMonth.forecast ? '🔮 Forecast' : '✓ Actual data'}
              </span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 280, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn" onClick={() => setMonthIdx(i => Math.max(0, i - 1))} style={{ padding: '6px 11px' }}>‹</button>
            <input type="range" min={0} max={Math.max(0, months.length - 1)} step={1} value={monthIdx}
              style={{ flex: 1, '--pct': (months.length > 1 ? monthIdx / (months.length - 1) * 100 : 0) + '%' }}
              onChange={e => setMonthIdx(+e.target.value)} />
            <button className="btn" onClick={() => setMonthIdx(i => Math.min(months.length - 1, i + 1))} style={{ padding: '6px 11px' }}>›</button>
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--txt-2)', maxWidth: 230, lineHeight: 1.5 }}>
            🌧️ Rainy season (Jun–Oct) → more breeding → more hotspots. Slide across the year to see it.
          </div>
        </div>
      </Card>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {/* ── levers — forecast months only; testing "what if" on real history doesn't mean anything ── */}
        {showLevers && (
          <Card className="col" style={{ flex: 1, minWidth: 300, maxWidth: 390 }}
            title={<span>Intervention levers <InfoTip w={300} title="What the levers do" text="Each slider changes an input by a percentage, for the month you’ve selected. The burden score is recomputed instantly and the map repaints. Baseline = the real value before any change." /></span>}
            sub="Baseline shown per lever; % change feeds the burden formula">
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button className="btn" onClick={scaleUp}>Scale-up interventions</button>
              <button className="btn" onClick={reset}>↺ Reset</button>
            </div>
            {(() => {
              // Population & density are now LEVERS (per request): the selected
              // area's OWN real numbers when one is picked, else the current
              // state/national aggregate, shown as the baseline that the % change
              // is applied to. Population scales cases directly (popMult, weight
              // 0.8); density feeds the Ross-Macdonald dilution term via the
              // mechanistic call, so denser -> lower per-person transmission.
              const pop = sel ? (sel.x.population || 0) : (scopeBaseline.population || 0)
              const dens = sel ? (sel.x.pop_density || 0) : (scopeBaseline.pop_density || 0)
              if (!(pop > 0 || dens > 0)) return null
              const demog = [
                { key: 'pop', emoji: '👥', label: 'Population', val: popPct, set: setPopPct, base: pop, unit: '', fmtV: fmt,
                  info: 'Change the number of people. More people → more cases (weighted ×0.8, sub-linear). Scales the case forecast and every area’s burden-score case-volume factor.' },
                { key: 'dens', emoji: '🏙️', label: 'Population density', val: densPct, set: setDensPct, base: dens, unit: '/km²', fmtV: n0,
                  info: 'Change how densely those people live. Denser settlements DILUTE mosquitoes-per-person in the Ross-Macdonald model, so higher density LOWERS per-person transmission — a genuinely different effect from raw population.' },
              ]
              return (
                <div style={{ marginBottom: 6 }}>
                  <div className="cat-label">👥 Population &amp; density</div>
                  {demog.map(d => {
                    const scenV = (d.base || 0) * (1 + d.val / 100)
                    return (
                      <div className="lever" key={d.key}>
                        <div className="lever-head">
                          <span className="name">{d.emoji} {d.label}<InfoTip text={d.info} /></span>
                          <span className="val">{d.val >= 0 ? '+' : ''}{d.val}%</span>
                        </div>
                        <input type="range" min={-80} max={200} step={5} value={d.val}
                          style={{ '--pct': ((d.val + 80) / 280 * 100) + '%' }}
                          onChange={e => d.set(+e.target.value)} />
                        <div className="lever-base">
                          baseline <b>{d.fmtV(d.base || 0)}</b>{d.unit}
                          {d.val !== 0 && <> → <b style={{ color: COLORS.accent }}>{d.fmtV(scenV)}</b>{d.unit}</>}
                          <span className="muted" style={{ marginLeft: 4 }}>({sel ? sel.name : (scope === 'states' ? 'national' : selState || 'all LGAs')})</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            {cats.map(cat => (
              <div key={cat}>
                <div className="cat-label">{cat}</div>
                {LEVERS.filter(l => l.cat === cat).map(l => {
                  const pct = vals[l.id] || 0
                  const baseV = scopeBaseline[l.field] || 0
                  let scenV = baseV * (1 + pct / 100)
                  if (l.field === 'temp') scenV = cl(scenV, 15, 45)
                  if (l.field === 'hum') scenV = cl(scenV, 0, 100)
                  if (l.field === 'ipt_cov') scenV = cl(scenV, 0, 100)
                  return (
                    <div className="lever" key={l.id}>
                      <div className="lever-head">
                        <span className="name">{l.label}<InfoTip text={l.info} /></span>
                        <span className="val">{pct >= 0 ? '+' : ''}{pct}%</span>
                      </div>
                      <input type="range" min={-80} max={200} step={5} value={pct}
                        style={{ '--pct': ((pct + 80) / 280 * 100) + '%' }}
                        onChange={e => setLever(l.id, +e.target.value)} />
                      <div className="lever-base">
                        baseline <b>{n0(baseV)}</b> {l.unit}
                        {pct !== 0 && <> → <b style={{ color: COLORS.accent }}>{n0(scenV)}</b> {l.unit}</>}
                        <span className="muted" style={{ marginLeft: 4 }}>({scope === 'states' ? 'national' : selState || 'all LGAs'})</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}

            {/* ── Mechanistic (Ross-Macdonald) factors -- SAME panel, not a separate
                 section: these are additional levers, driven by a theory-based
                 model (population density, PfPR, NDVI, etc.) instead of fitted
                 elasticities. Their effect is combined into the SAME map score
                 (selected area) and graph as the empirical levers above. ── */}
            <div className="cat-label">🦟 Mechanistic (Ross-Macdonald)
              <InfoTip w={400} title="A second, theory-driven model" text="These levers do NOT use statistical elasticities (that's everything above). They run the classic Ross-Macdonald vectorial-capacity / R0 equations for malaria transmission, using the SELECTED area's real population density, PfPR, poverty/education deprivation, NDVI and IPTp1 coverage. Their effect combines multiplicatively with the empirical levers above to scale the case forecast and the selected area's score. Literature/WHO default parameters where no per-LGA data exists -- not fit to this dataset." /></div>
            {mechErr && <div className="muted" style={{ fontSize: '.78rem', marginBottom: 10 }}>Mechanistic model unavailable: {mechErr}</div>}
            {[
              ['ITN / LLIN use', itn, setItn, 'Bednet use: deters biting and kills mosquitoes on contact'],
              ['IRS coverage', irs, setIrs, 'No per-LGA IRS data exists anywhere, so this starts at a neutral 50 (not a real baseline) -- move it to ask "what if IRS coverage were higher/lower here", still computed through the real Ross-Macdonald equations'],
              ['Effective ACT treatment', actMech, setActMech, 'Shortens the infectious period; discounted by this area’s socioeconomic access factor'],
              ['IPTp coverage (pregnant women)', iptpMech, setIptpMech, 'Starts at this area’s own reported rate (real data). Scoped to pregnant women only (~4.4% of population)'],
              ['Vaccine / child immunisation', vaccine, setVaccine, 'No per-LGA vaccine coverage data exists, so this starts at a neutral 50 (not a real baseline) -- a logical "what if" lever, not a measured one. Scoped to under-5 children only (~17.5% of population)'],
            ].map(([label, val, setVal, hint]) => {
              const v = val ?? 0
              return (
                <div className="lever" key={label}>
                  <div className="lever-head">
                    <span className="name">{label}</span>
                    <span className="val">{val == null ? '…' : `${v}%`}</span>
                  </div>
                  <input type="range" min={0} max={100} value={v} step={1}
                    style={{ '--pct': v + '%' }} onChange={e => setVal(+e.target.value)} />
                  <div className="lever-desc">{hint}</div>
                </div>
              )
            })}

            {mechValid && (
              <div style={{ marginTop: 10 }}>
                <div className="cat-label">Location context ({mechLocLabel})
                  <InfoTip w={360} title="Where each number comes from" text="Population/PfPR/poverty/education/IPTp1/RDT are real warehouse-sourced data for this location. Pregnant-women and under-5 population are NOT measured per-LGA -- Nigeria doesn't publish that -- so they're derived from population x standard national demographic shares." /></div>
                <table className="data" style={{ fontSize: '.76rem' }}>
                  <tbody>
                    {mech.context?.population && <tr><td>Population</td><td className="num">{fmt(mech.context.population.value)}</td></tr>}
                    <tr><td>Population density</td><td className="num">{mech.inputs?.pop_density ? `${Math.round(mech.inputs.pop_density).toLocaleString()}/km²` : 'n/a'}</td></tr>
                    {mech.context?.infected_population_estimate && <tr><td>Infected population (est.)</td><td className="num">{fmt(mech.context.infected_population_estimate.value)}</td></tr>}
                    {mech.context?.pregnant_women_population && <tr><td>Pregnant women (est.)</td><td className="num">{fmt(mech.context.pregnant_women_population.value)}</td></tr>}
                    {mech.context?.under5_population && <tr><td>Children under 5 (est.)</td><td className="num">{fmt(mech.context.under5_population.value)}</td></tr>}
                    {mech.context?.socioeconomic_vulnerability_index && <tr><td>Socioeconomic vulnerability</td><td className="num">{mech.context.socioeconomic_vulnerability_index.value}/100</td></tr>}
                    {mech.context?.iptp1_coverage_real && <tr><td>IPTp coverage (reported)</td><td className="num">{mech.context.iptp1_coverage_real.value}%</td></tr>}
                    {mech.context?.rdt_tests_per_month && <tr><td>RDT tests/month (reported)</td><td className="num">{fmt(mech.context.rdt_tests_per_month.value)}</td></tr>}
                  </tbody>
                </table>
                <div className="muted" style={{ fontSize: '.72rem', marginTop: 6, lineHeight: 1.6 }}>
                  Natural R₀ (no control): <b>{(mech.derived?.R0_natural_no_intervention ?? mech.baseline.R0).toFixed(1)}</b> ·
                  {' '}status-quo→scenario transmission ×<b style={{ color: (mech.derived?.R0_ratio ?? 1) <= 1 ? COLORS.green : COLORS.coral }}>{(mech.derived?.R0_ratio ?? 1).toFixed(2)}</b> ·
                  {' '}case multiplier ×<b style={{ color: mechMult <= 1 ? COLORS.green : COLORS.coral }}>{mechMult.toFixed(3)}</b>
                  <InfoTip w={340} text="Natural R₀ is this area's transmission potential with NO control (literature Ross-Macdonald parameters on its real density/temperature/rainfall). The multiplier compares your slider scenario to the sliders' status-quo starting positions — 1.0 means 'no change to the forecast', below 1 means fewer cases." />
                </div>
              </div>
            )}
          </Card>
        )}

        {/* ── map + KPIs ── */}
        <div className="col" style={{ flex: showLevers ? 2 : 1, minWidth: 460, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!showLevers && (
            <Card style={{ background: 'rgba(13,148,136,.07)', border: '1px solid rgba(13,148,136,.3)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '.84rem', color: 'var(--txt-1)', lineHeight: 1.6 }}>
                <span style={{ fontSize: '1.1rem' }}>✓</span>
                <div>
                  <b>Showing actual reported data for {curMonth.label}.</b> This already happened, so the intervention levers are hidden — there's nothing to simulate against real history.
                  <InfoTip w={300} title="Why no levers here" text="Intervention levers (rainfall, treatment, nets, etc.) only make sense when testing future scenarios. For months that already happened, the map simply shows the real reported numbers." />
                  {' '}Move the time slider above into a <b>🔮 Forecast</b> month (2026 onward) to unlock the levers and test interventions.
                </div>
              </div>
            </Card>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {ZONE_ORDER.map(z => (
              <div key={z} className="card" style={{ flex: 1, minWidth: 92, padding: '12px 14px', position: 'relative', overflow: 'visible' }}>
                <div className="accent-bar" style={{ background: ZONES[z].c, borderRadius: 'var(--r) 0 0 var(--r)' }} />
                <div style={{ fontSize: '.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: ZONES[z].t, display: 'flex', alignItems: 'center' }}>
                  {z}<InfoTip text={ZONE_INFO[z]} />
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', color: 'var(--txt-0)', marginTop: 4 }}>{dist.scen[z] || 0}</div>
                {(dist.scen[z] || 0) !== (dist.base[z] || 0) && (
                  <div style={{ fontSize: '.68rem', fontWeight: 600, color: (dist.scen[z] - dist.base[z]) < 0 ? COLORS.green : COLORS.coral }}>
                    {(dist.scen[z] - dist.base[z]) > 0 ? '+' : ''}{dist.scen[z] - dist.base[z]} vs base
                  </div>
                )}
              </div>
            ))}
          </div>

          <Card
            title={<span>{scope === 'states' ? 'Nigeria — hotspot zones by state' : (allLgas || !selState ? 'Nigeria — all LGAs' : `${selState} — hotspot zones by LGA`)} · {curMonth.label}
              <InfoTip w={300} text={scope === 'states' ? 'Click a state to drill into its LGAs. Hover any area for its score.' : 'Click any LGA to see exactly how its score was calculated, in the panel below.'} /></span>}
            sub={`Hotspots (Red+Amber): ${hotScen} of ${units.length}${hotScen !== hotBase ? `  ·  was ${hotBase} before levers` : ''}`}
            right={(scope === 'lgas' && !allLgas) ? <button className="btn" onClick={backToStates}>← All states</button> : <span className="chip dot">{allLgas ? `${units.length} LGAs` : '37 states'}</span>}>
            <div style={{ position: 'relative', height: 520, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-3)' }}>
              {!ready && <div className="loading" style={{ height: '100%' }}><div className="spinner" />Loading map…</div>}
              {ready && (
                <DeckGL viewState={view} controller={true} layers={layers} onViewStateChange={e => setView(e.viewState)} style={{ position: 'absolute', inset: 0 }}>
                  <Map key={typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : 'light'} mapStyle={blankMapStyle()} />
                </DeckGL>
              )}
              {hover?.object && (() => {
                const key = hover.kind === 'state' ? hover.object.properties.st : lgaKeyFor(hover.object.properties.st, hover.object.properties.lga)
                const b = baseZ[key], s = dispZ[key]; if (!s) return null
                return (
                  <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: 'var(--bg-2)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                    <div style={{ fontWeight: 700, color: 'var(--txt-0)', marginBottom: 4 }}>{hover.kind === 'state' ? hover.object.properties.st : hover.object.properties.lga}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <ZoneChip zone={s.zone} /><span style={{ fontFamily: 'var(--mono)', color: 'var(--txt-1)' }}>{s.display.toFixed(1)}</span>
                    </div>
                    {b && Math.abs(s.display - b.display) > 0.05 && (
                      <div style={{ fontSize: '.7rem', color: (s.display - b.display) < 0 ? COLORS.green : COLORS.coral }}>
                        {(s.display - b.display) > 0 ? '+' : ''}{(s.display - b.display).toFixed(1)} vs baseline ({b.zone})
                      </div>
                    )}
                    <div className="muted" style={{ marginTop: 3, fontSize: '.68rem' }}>click {hover.kind === 'state' ? 'to drill in →' : 'for maths →'}</div>
                  </div>
                )
              })()}
              <div style={{ position: 'absolute', left: 12, bottom: 12, background: 'rgba(255,255,255,.93)', borderRadius: 8, padding: '8px 11px', fontSize: '.68rem', color: 'var(--txt-1)', boxShadow: '0 2px 10px rgba(0,0,0,.08)' }}>
                <div style={{ fontWeight: 700, marginBottom: 5, display: 'flex', alignItems: 'center' }}>Hotspot zone<InfoTip text="Colour = severity. Red is worst, grey means not a hotspot. Based on the burden score for the selected month." /></div>
                {ZONE_ORDER.map(z => (<div key={z} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: ZONES[z].c }} />{z}</div>))}
              </div>
            </div>
          </Card>

          {/* ── CASE TREND: same lever state as the map above, same shared chart ── */}
          {/* Right column = map, then graph, stacked -- both react to the SAME levers on the left. */}
          {trendData.length > 0 && (
            <Card
              title={<span>{trendLabel} — case trend, baseline vs scenario
                <InfoTip w={360} title="One control surface" text="This chart uses the EXACT SAME levers as the map above — including the Mechanistic (Ross-Macdonald) factors — move any of them and both the map's colour AND this chart's scenario line update together. Empirical (elasticity) and Mechanistic (Ross-Macdonald) effects are combined multiplicatively: ×{empirical} × ×{mechanistic} = ×{combined}. Applied to forecast months only; history is fixed." /></span>}
              sub={showLevers ? `Forecast responds to your levers · empirical ×${trendMult.toFixed(3)} · mechanistic ×${mechMult.toFixed(3)} · population ×${popMult.toFixed(3)} · combined ×${combinedMult.toFixed(3)}` : 'Move the time slider to a forecast month to unlock levers'}>
              {showLevers && (
                <div className="row" style={{ marginBottom: 14 }}>
                  <Card className="col" style={{ minWidth: 0, background: 'var(--bg-2)' }}>
                    <div className="scenario-readout">
                      <div className="lbl">Scenario cases (forecast)</div>
                      <div className="big" style={{ fontSize: '1.7rem', color: combinedMult <= 1 ? COLORS.green : COLORS.coral }}>{fmt(trendScenTotal)}</div>
                      <div className="muted" style={{ fontSize: '.78rem' }}>baseline {fmt(trendBaseTotal)}</div>
                    </div>
                  </Card>
                  <Card className="col" style={{ minWidth: 0, background: 'var(--bg-2)' }}>
                    <div className="scenario-readout">
                      <div className="lbl">{trendAverted >= 0 ? 'Cases averted' : 'Additional cases'}</div>
                      <div className="big" style={{ fontSize: '1.7rem', color: trendAverted >= 0 ? COLORS.green : COLORS.coral }}>{fmt(Math.abs(trendAverted))}</div>
                      <div className="muted" style={{ fontSize: '.78rem' }}>×{combinedMult.toFixed(3)} vs baseline</div>
                    </div>
                  </Card>
                </div>
              )}
              <CompareChart data={trendData} height={250} splitDate={firstForecastYm} splitLabel="Forecast →" series={[
                { key: 'Baseline', name: 'Baseline forecast', color: COLORS.accent2, dashed: true },
                { key: 'Scenario', name: 'Scenario (with levers)', color: combinedMult <= 1 ? COLORS.accent : COLORS.coral },
              ]} />
              {/* ── PLAN BUDGET: small section directly under the line graph.
                   Reuses the EXACT scenario already built above (scope +
                   levers) -- no separate SARIMAX run, no separate
                   level/state/target picker -- and stays inert until a real,
                   budget-relevant lever has actually been moved. ── */}
              {showLevers && !allLgas && (
                <PlanBudget scope={scope} selState={selState} vals={vals} trendFc={trendFc}
                  population={sel ? (sel.x.population || 0) : (scopeBaseline.population || 0)} disease={disease}
                  otherLevers={{ popPct, densPct, itn, irs, actMech, iptpMech, iptpMechSeed, vaccine }} />
              )}
            </Card>
          )}
        </div>
      </div>

      {/* ── FACILITY DRILL-DOWN (one level below the selected LGA) ── */}
      {scope === 'lgas' && selKey && selKey.includes('|||') && (
        <FacilityPanel disease={disease} stateName={selKey.split('|||')[0]} lga={selKey.split('|||')[1]} selMonth={curMonth}
          lgaBurden={dispZ[selKey]?.display} lgaZone={dispZ[selKey]?.zone} />
      )}

      {/* ── CALCULATION BREAKDOWN (collapsed by default -- the exact numbers,
           for anyone who wants to audit the maths, not the primary view) ── */}
      {sel && selDetail && selZ && (
        <Card style={{ marginTop: 18 }}>
          <button className="btn" onClick={() => setShowBreakdown(o => !o)} style={{ width: '100%', textAlign: 'left' }}>
            {showBreakdown ? '▾' : '▸'} How {sel.name}'s burden score was calculated · {curMonth.label}
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: '.78rem' }}>
              {curMonth.forecast ? 'Forecast month' : 'Actual data'} · scenario inputs (after levers) feed the same formula
            </span>
          </button>
          {showBreakdown && (
          <>
          <div className="row" style={{ gap: 16, marginTop: 14 }}>
            <div className="col" style={{ minWidth: 260, flex: 1 }}>
              <div className="cat-label">Step 0 · Indicator inputs (baseline → scenario)<InfoTip text="The raw monthly numbers for this area. If you moved a lever, the arrow shows the new value." /></div>
              <table className="data" style={{ fontSize: '.8rem' }}>
                <tbody>
                  {[['Confirmed cases/mo', 'cases'], ['Total reported/mo', 'total'], ['Case trend ratio', 'trend'], ['Rainfall (mm/day)', 'rain'],
                    ['Temperature (°C)', 'temp'], ['Humidity (%)', 'hum'], ['ACT given/mo', 'act'], ['LLIN nets/mo', 'llin']].map(([lbl, f]) => {
                    const bv = sel.x[f] || 0, sv = selScenX[f] || 0, chg = Math.abs(sv - bv) > 1e-6
                    return (<tr key={f}><td>{lbl}</td><td className="num">{f === 'trend' ? bv.toFixed(2) : n0(bv)}</td>
                      <td className="num" style={{ color: chg ? COLORS.accent : 'var(--txt-3)' }}>{chg ? '→ ' + (f === 'trend' ? sv.toFixed(2) : n0(sv)) : ''}</td></tr>)
                  })}
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: '.7rem', marginTop: 6 }}>peer_avg cases (this view) = <b>{n0(peerAvg)}</b> · used in A1.</div>
            </div>
            <div className="col" style={{ minWidth: 360, flex: 1.6 }}>
              <div className="cat-label">Step 1 · Weighted factors (points = weight × sub-score)<InfoTip w={300} text="Each row scores one risk factor from 0–1, then multiplies by its importance weight to give points. A=disease load 35, B=transmission 25, C=weather 20, D=protection gaps 20." /></div>
              <table className="data" style={{ fontSize: '.78rem' }}>
                <thead><tr><th>Factor</th><th>Your numbers</th><th className="num">Sub</th><th className="num">Pts</th></tr></thead>
                <tbody>
                  {selDetail.factors.map((r, i) => (
                    <tr key={i}><td><b>{r.name}</b><div className="muted" style={{ fontSize: '.66rem' }}>{r.formula}</div></td>
                      <td className="mono" style={{ fontSize: '.7rem', color: 'var(--txt-2)' }}>{r.subst}</td>
                      <td className="num">{r.sub.toFixed(2)}</td>
                      <td className="num" style={{ color: COLORS.accent }}>{r.points.toFixed(1)}<span className="muted" style={{ fontSize: '.62rem' }}>/{r.w}</span></td></tr>
                  ))}
                  <tr style={{ background: 'var(--bg-3)' }}><td colSpan={3}><b>Raw burden = sum of points</b></td><td className="num"><b>{selDetail.raw.toFixed(1)}</b></td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="method-section" style={{ marginTop: 14, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
            <div className="cat-label" style={{ marginTop: 0 }}>Step 2 · Percentile blend vs all {scope === 'states' ? 'states nationally' : 'LGAs nationally'} → Step 3 · Zone
              <InfoTip w={340} text="A high raw score isn't enough on its own — we also rank this area against all others (60% weight) and blend with its raw score, MIN-MAX NORMALISED against the actual national range this month (40% weight). Normalising against the real observed range -- not a theoretical 0-100 -- is what lets the genuinely worst areas reach Red instead of capping out around Amber. Always compared to the FULL national set, even when you've drilled into one state, so severity stays comparable nationwide." /></div>
            <p style={{ fontSize: '.82rem', lineHeight: 1.8, margin: '6px 0 0' }}>
              Ranked <b>#{selZ.rankPos} of {selZ.n}</b> by raw burden → rank_pct = <b>{(selZ.rankPct).toFixed(3)}</b><br />
              <code>rank_term = 0.60 × {(selZ.rankPct).toFixed(3)} = {selZ.rankTerm.toFixed(3)}</code><br />
              <code>raw_scaled = ({selDetail.raw.toFixed(1)} − {rawRange ? rawRange[0].toFixed(1) : '0.0'}) ÷ ({rawRange ? (rawRange[1] - rawRange[0]).toFixed(1) : '100.0'}) [national range]</code><br />
              <code>raw_term&nbsp; = 0.40 × raw_scaled = {selZ.rawTerm.toFixed(3)}</code><br />
              <code>display&nbsp;&nbsp; = (rank_term + raw_term) × 100 = <b style={{ color: ZONES[selZ.zone].t }}>{selZ.display.toFixed(1)}</b></code><br />
              <span style={{ marginTop: 4, display: 'inline-block' }}>Thresholds: &lt;60 None · &lt;71 Green · &lt;81 Yellow · &lt;91 Amber · ≥91 Red →{' '}
                <b style={{ color: ZONES[selZ.zone].t }}>{selZ.display.toFixed(1)} → {selZ.zone}</b>
                {selBaseZ && selBaseZ.zone !== selZ.zone && <> (baseline was <ZoneChip zone={selBaseZ.zone} /> at {selBaseZ.display.toFixed(1)})</>}
              </span>
            </p>
          </div>
          </>
          )}
        </Card>
      )}

      {/* "Plan Budget" (small, scenario-priced budget section) is embedded
          directly under the case-trend graph above -- Budget Planning no
          longer has its own top-level nav tab or a separate SARIMAX run. The
          Mechanistic (Ross-Macdonald) factors remain here as levers in the
          SAME "Intervention levers" panel above. */}
    </>
  )
}
