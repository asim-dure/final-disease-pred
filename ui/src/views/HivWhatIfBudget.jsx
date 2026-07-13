import React, { useState, useEffect, useMemo } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts'
import { Card, InfoTip, MarkdownLite } from '../components'
import { TrendingUp, ShieldCheck, TrendingDown, Activity, AlertTriangle, CircleOff } from 'lucide-react'
import { fmt, fmtFull, monthLabel, COLORS, API_BASE } from '../lib'
import { RiskMap, STATE_GRID, ZONE_COLORS, ZONE_LABELS, ZONE_ORDER } from './ManagerDashboard'
import { hivBuildZones, hivScoreDetail, scoreToZone } from '../hivBurdenScore'
import FacilityPanel from './FacilityPanel'

// HIV-only extension of malaria's shared 5-zone system with a 6th "No Data"
// bucket -- areas with zero real reported rows this month (see
// hivBuildZones' exclusion logic). Kept local to HIV rather than added to
// ManagerDashboard's own ZONE_ORDER/ZONE_COLORS/ZONE_LABELS so malaria's own
// zone-count cards/legend, which never produce this value, are untouched.
const HIV_ZONE_ORDER = [...ZONE_ORDER, 'No Data']
const HIV_ZONE_COLORS = { ...ZONE_COLORS, 'No Data': '#94a3b8' }
const HIV_ZONE_LABELS = { ...ZONE_LABELS, 'No Data': 'No Data' }

// HIV's real, single What-If Simulation + Budget Planning tab -- NDARS
// (system_id=7) only, no malaria content, no malaria wording. Same merged
// architecture as malaria's own VisualOverview.jsx: ONE shared `vals`
// control surface drives the map (recoloured live via hivBuildZones, the
// SAME scoring engine the Command Overview map uses -- so a state that
// reads Red there reads Red here too), the trend chart, and Budget
// Planning -- no separate "Run" step, everything updates as levers move.
//
// Data: burden_rich.json (export_burden_hiv.py -- real per-state monthly
// hts_tested/hts_pos/art_curr/art_vl_tested/population/pop_density, the
// SAME file the Command Overview map/charts use) + kp_socio.json
// (export_hiv_kp_socio.py -- key-population PrEP levers and OPHI/NBS MPI
// 2019 socioeconomic levers). See both export scripts' module notes for
// exact indicator names, aggregation rules and every literature citation
// (IBBSS 2020-21, NACA KP sizing 2023, PEPFAR/Nigeria unit-cost studies)
// backing the numbers shown here.

const api = (path, body) =>
  fetch(path.replace(/^\/api/, API_BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(e.detail || 'API error'))
    return r.json()
  })

const HIV_TARGET = 'HIV positive tests (HTS_TST_POS, NDARS Total Male+Female)'
const USD_NGN = 1600
const PUBLIC_BASE = import.meta.env.BASE_URL || '/'

// Same elasticity values as disease_config.py's DISEASES['hiv']['elasticity']
// (the server-side source of truth /api/whatif and the budget solver both
// read) -- mirrored here so the map/chart can react to every lever
// INSTANTLY, client-side, without a round trip per slider tick. msm/pwid/
// sw/tg are pre-scaled by each group's real, cited share of Nigeria's PLHIV
// (see export_hiv_kp_socio.py's audience-weight derivation) -- the SAME
// pre-scaling the backend uses, so a Budget Planning run and this live
// preview can never disagree.
const ELASTICITY = {
  art: -0.30, hts_testing: -0.15, pmtct_testing: -0.15, vl_monitoring: -0.12,
  msm: -0.0276, pwid: -0.0089, sw: -0.0211, tg: -0.0050,
  poverty: 0.10, literacy: -0.10,
}
// Malaria's own population lever uses weight 0.8 (sub-linear) because its
// transmission is vector-limited -- more people dilutes across the SAME
// fixed mosquito population ("shared vector pools"), so cases grow slower
// than population. That dilution mechanism doesn't exist for HIV
// (human-to-human transmission, no shared limiting vector) -- at a roughly
// constant prevalence rate, absolute case count scales close to linearly
// (weight 1.0) with population size. This was the actual bug behind
// "population feels weak": it was inheriting malaria's vector-dilution
// discount for a disease that has no vector to dilute across.
const POP_CASE_WEIGHT = 1.0
// Density was previously ONLY wired into the burden-score's density factor
// (applyLevers -> hivScoreDetail), with zero effect on the actual case
// count/chart -- the same class of bug population had. Denser areas mean
// more sexual/social network connectivity and generally higher STI/HIV
// transmission in the literature, so density gets a real (if more modest
// than population's) positive elasticity on cases too -- directional,
// literature-informed, same honesty bar as poverty/literacy.
const DENS_CASE_WEIGHT = 0.15

const LEVER_GROUPS = [
  {
    cat: 'Demographics', color: COLORS.violet,
    levers: [
      { id: 'popPct', label: 'Population', hint: 'Real per-state population (agg_lga_pop.parquet). Unlike malaria (vector-limited transmission), HIV has no shared-vector dilution effect -- at a roughly constant prevalence rate, absolute case count scales close to linearly (weight 1.0) with population size. Testing/ART/VL programme capacity is NOT auto-scaled with it, so growing population also widens the burden score\'s coverage-gap factors (same real capacity now covering more people) -- the strongest lever on the page for BOTH the chart and the map. Turn up the testing/ART levers below to offset it.', min: -30, max: 100 },
      { id: 'densPct', label: 'Population density', hint: 'Real per-state population density. Feeds the burden score\'s own density factor (higher density = more risk in the score, same role it plays in the Command Overview burden score) AND directly scales the case count/chart (weight 0.15, gentler than population -- denser areas mean more social/sexual network connectivity, generally higher transmission).', min: -50, max: 100 },
    ],
  },
  {
    cat: 'Testing & Case-Finding', color: COLORS.accent2,
    levers: [
      { id: 'hts_testing', label: 'HIV testing volume (general population)', hint: 'NDARS HTS_TST Total, Male+Female. More testing finds more cases earlier -> more linkage to treatment -> less onward transmission.', min: -80, max: 200 },
      { id: 'pmtct_testing', label: 'PMTCT testing volume', hint: 'NDARS pregnant & breastfeeding women tested. Same case-finding logic, scoped to that audience.', min: -80, max: 200 },
    ],
  },
  {
    cat: 'Treatment & Care', color: COLORS.accent,
    levers: [
      { id: 'art', label: 'PLHIV currently on ART', hint: 'NDARS ART Monthly_3. WHO/UNAIDS Treatment-as-Prevention -- sustained viral suppression cuts onward transmission. Strongest lever.', min: -80, max: 200 },
      { id: 'vl_monitoring', label: 'On ART with a viral-load result', hint: 'NDARS ART Monthly_6a. Routine VL monitoring catches treatment failure before it becomes a transmission risk again.', min: -80, max: 200 },
    ],
  },
  {
    cat: 'Socioeconomic (OPHI/NBS MPI 2019)', color: COLORS.amber,
    levers: [
      { id: 'poverty', label: 'Poverty (MPI headcount)', hint: 'Multidimensional Poverty Index headcount, state-level survey (same dataset the malaria model trains on). Higher poverty is modelled as raising risk -- directional, literature-informed, not a fitted coefficient.', min: -50, max: 50, risk: true },
      { id: 'literacy', label: 'Literacy / schooling access', hint: 'Inverse of MPI\'s "deprivation: years of schooling". Better education access is modelled as protective (health literacy / awareness), same modest directional magnitude as poverty.', min: -50, max: 50 },
    ],
  },
  {
    cat: 'Key Populations -- PrEP & Outreach', color: COLORS.violet,
    levers: [
      { id: 'msm', label: 'PrEP uptake -- MSM', hint: 'NDARS "SDC" (Sexual & Gender-Diverse Community) PrEP-eligibility -- NASCP\'s official NDARS-native MSM proxy. Male population only: this lever only ever scales the MSM-attributable share of cases (7.9% of national PLHIV, IBBSS 2020-21 x NACA 2023 sizing), it does not change the size of the MSM population itself.', min: -80, max: 200, maleOnly: true },
      { id: 'pwid', label: 'PrEP uptake -- PWID', hint: 'NDARS Injecting Drug Users PrEP-eligibility + real tested-for-HIV/positivity data. Globally ~22x general-population risk (UNAIDS key-population fact sheet); Nigeria IBBSS 2020-21 measured 10.9% prevalence in this group.', min: -80, max: 200 },
      { id: 'sw', label: 'PrEP uptake -- Sex Workers', hint: 'NDARS Sex Workers PrEP-eligibility + real tested-for-HIV/positivity data. IBBSS 2020-21: 15.5% prevalence.', min: -80, max: 200 },
      { id: 'tg', label: 'PrEP uptake -- Transgender', hint: 'NDARS Transgender PrEP-eligibility + real tested-for-HIV/positivity data. IBBSS 2020-21: 28.8% prevalence -- the highest of any group measured.', min: -80, max: 200 },
    ],
  },
]
const DEFAULT_VALS = Object.fromEntries(LEVER_GROUPS.flatMap(g => g.levers.map(l => [l.id, 0])))

function Lever({ meta, pct, baseline, unit, onChange }) {
  const { min, max } = meta
  return (
    <div className="lever">
      <div className="lever-head">
        <span className="name">{meta.label}
          {meta.maleOnly && <span style={{ marginLeft: 6, fontSize: '.62rem', fontWeight: 700, color: COLORS.violet, background: `${COLORS.violet}18`, padding: '1px 6px', borderRadius: 10 }}>MALE ONLY</span>}
          <InfoTip w={340} title={meta.label} text={meta.hint} />
        </span>
        <span className="val">{pct >= 0 ? '+' : ''}{pct}%</span>
      </div>
      <input type="range" min={min} max={max} value={pct} step={5}
        style={{ '--pct': `${((pct - min) / (max - min)) * 100}%` }}
        onChange={e => onChange(+e.target.value)} />
      <div className="lever-base">baseline {fmt(baseline)}{unit || ''}{meta.risk ? ' · risk factor (up = worse)' : ' · protective (up = better)'}</div>
    </div>
  )
}

const ChartTT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 13px', fontSize: '.8rem', boxShadow: '0 8px 30px rgba(15,34,48,.12)' }}>
      <div style={{ fontWeight: 700, color: 'var(--txt-0)', marginBottom: 5 }}>{monthLabel(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          <span>{p.name}</span><span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  )
}
const axPr = { tick: { fill: 'var(--txt-2)', fontSize: 11 }, tickLine: false, axisLine: { stroke: 'rgba(13,148,136,.12)' } }

// Self-contained colour card -- same visual language as the Command
// Overview dashboard's KPICard (icon in a tinted circle, bold value, colour
// accent) but inline-styled so it works standalone here without needing to
// wrap this whole page in the .miq-root theme (KPICard depends on CSS
// classes only defined inside that shell).
function ColorKPI({ label, value, sub, color = COLORS.accent, icon: Icon, info }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}17, ${color}06)`,
      border: `1.5px solid ${color}55`, borderLeft: `5px solid ${color}`,
      borderRadius: 12, padding: '14px 16px', flex: 1, minWidth: 0,
      boxShadow: `0 2px 10px ${color}1a`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '.72rem', color: 'var(--txt-2)', fontWeight: 700, display: 'flex', alignItems: 'center', textTransform: 'uppercase', letterSpacing: '.4px' }}>
          {label}{info && <InfoTip w={340} title={label} text={info} />}
        </span>
        {Icon && (
          <div style={{ width: 30, height: 30, borderRadius: 8, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: `0 2px 6px ${color}66` }}>
            <Icon size={15} color="#fff" strokeWidth={2.4} />
          </div>
        )}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '1.6rem', fontWeight: 800, color, marginTop: 8 }}>{value}</div>
      {sub && <div style={{ fontSize: '.7rem', color: 'var(--txt-3)', marginTop: 5, fontWeight: 600 }}>{sub}</div>}
    </div>
  )
}

function rowFrom(b, m, i) {
  if (!b) return { hts_tested: 0, hts_pos: 0, art_curr: 0, art_vl_tested: 0, pmtct_tested: 0, population: 0, pop_density: 0, reported: false, hts_reported: false, art_reported: false }
  return {
    hts_tested: b.hts_tested?.[i] ?? 0, hts_pos: b.hts_pos?.[i] ?? 0,
    art_curr: b.art_curr?.[i] ?? 0, art_vl_tested: b.art_vl_tested?.[i] ?? 0,
    pmtct_tested: b.pmtct_tested?.[i] ?? 0,
    population: b.population?.[i] ?? 0, pop_density: b.pop_density?.[i] ?? 0,
    // Real "did this area report ANYTHING this month" flags from
    // export_burden_hiv.py -- absent (older cached JSON) default to true
    // (reported), matching hivBuildZones'/hivScoreDetail's own `!== false`
    // fallbacks. reported = whole-row (any family); hts_reported/
    // art_reported = specifically the HTS/ART indicator families, which
    // can report independently of each other and of PMTCT (see
    // hivScoreDetail's comment for the real Niger example that required
    // this split, not just a blanket flag).
    reported: b.reported?.[i] ?? true,
    hts_reported: b.hts_reported?.[i] ?? true,
    art_reported: b.art_reported?.[i] ?? true,
  }
}
function caseMultiplier(vals) {
  let m = 1
  for (const id of Object.keys(ELASTICITY)) {
    const pct = vals[id] || 0
    if (!pct) continue
    m *= Math.max(0.2, Math.min(3, 1 + ELASTICITY[id] * (pct / 100)))
  }
  const popMult = Math.max(0.1, 1 + ((vals.popPct || 0) / 100) * POP_CASE_WEIGHT)
  const densMult = Math.max(0.1, 1 + ((vals.densPct || 0) / 100) * DENS_CASE_WEIGHT)
  return Math.max(0.1, Math.min(4, m)) * popMult * densMult
}
// Same "map and chart share ONE control surface" pattern as malaria's own
// applyLevers() -- each lever adjusts the specific real field it represents;
// hts_pos (the case-burden factor in the burden score) responds to the FULL
// scenario multiplier, so moving ANY lever repaints the map, not just its
// own field.
//
// Population is deliberately left to dilute the testing/ART coverage-gap
// factors (same real programme capacity ÷ more people), not rescaled
// alongside them. An earlier version scaled hts_tested/art_curr
// proportionally with population "to keep rates honest" -- that silently
// made population change ZERO states' zone/score (verified: 0/37 states
// moved even at +100%), because the burden score is entirely per-capita
// RATIOS, so scaling numerator and denominator together cancels out
// exactly. The dilution behaviour restored below is also the more
// intuitive reading of the lever anyway: "what if population grows" should
// mean the health system's real, unchanged capacity now covers a bigger
// population -- gaps widen unless the user ALSO turns up testing/ART to
// match, which they can, right below this lever.
function applyLevers(x, vals) {
  const y = { ...x }
  if (vals.popPct) y.population = Math.max(0, x.population * (1 + vals.popPct / 100))
  if (vals.hts_testing) y.hts_tested = Math.max(0, x.hts_tested * (1 + vals.hts_testing / 100))
  if (vals.art) y.art_curr = Math.max(0, x.art_curr * (1 + vals.art / 100))
  if (vals.vl_monitoring) y.art_vl_tested = Math.max(0, x.art_vl_tested * (1 + vals.vl_monitoring / 100))
  if (vals.densPct) y.pop_density = Math.max(0, x.pop_density * (1 + vals.densPct / 100))
  y.hts_pos = Math.max(0, x.hts_pos * caseMultiplier(vals))
  return y
}

export default function HivWhatIfBudget() {
  const [burden, setBurden] = useState(null)     // burden_rich.json -- real monthly panel, same file Command Overview uses
  const [kpSocio, setKpSocio] = useState(null)    // kp_socio.json
  const [selState, setSelState] = useState(null)  // clicking the map (or the dropdown) scopes levers/chart/budget to one state
  const [selLga, setSelLga] = useState(null)      // {state, lga} -- switch RiskMap to LGA view and click an LGA to drill into its facilities
  const [mapScope, setMapScope] = useState('states')  // page-level State view/LGA view toggle -- drives BOTH the map and the 5 zone-distribution cards, same pattern as malaria's VisualOverview.jsx
  const [vals, setVals] = useState(DEFAULT_VALS)
  const [horizon] = useState(12)

  const [budgeting, setBudgeting] = useState(false)
  const [budgetErr, setBudgetErr] = useState(null)
  const [budgetPlan, setBudgetPlan] = useState(null)
  const [budgetMode, setBudgetMode] = useState('forward')
  const [budgetNgn, setBudgetNgn] = useState(2_000_000_000)
  const [lastBudgetNgn, setLastBudgetNgn] = useState(null)

  const [proposals, setProposals] = useState([])
  const [compareIds, setCompareIds] = useState([])
  const [viewProposal, setViewProposal] = useState(null)
  const [savedNote, setSavedNote] = useState(null)
  const [aiCompare, setAiCompare] = useState(null)
  const [aiComparing, setAiComparing] = useState(false)
  const [aiCompareErr, setAiCompareErr] = useState(null)

  const loadProposals = () => fetch(`${API_BASE}/proposals?disease=hiv`).then(r => r.json()).then(setProposals).catch(() => {})

  useEffect(() => {
    fetch(`${PUBLIC_BASE}data/after/hiv/burden_rich.json`).then(r => r.json()).then(setBurden).catch(() => {})
    fetch(`${PUBLIC_BASE}data/after/hiv/kp_socio.json`).then(r => r.json()).then(setKpSocio).catch(() => {})
    loadProposals()
  }, [])

  const months = burden?.months || []
  const lastRealIdx = useMemo(() => {
    const i = months.findIndex(m => m.forecast)
    return i > 0 ? i - 1 : months.length - 1
  }, [months])

  // Time bar -- same "scrub through real + 12mo-forecast months, map/score
  // updates to that exact month" pattern as malaria's own merged What-If tab.
  // Defaults to the latest REAL month once data loads.
  const [monthIdx, setMonthIdx] = useState(null)
  useEffect(() => { if (burden && monthIdx == null) setMonthIdx(lastRealIdx) }, [burden])
  const effIdx = monthIdx ?? lastRealIdx
  const curMonth = months[effIdx] || { label: '—', forecast: false }
  // Levers condition a FORECAST month's projection -- testing "what if" on
  // real, already-reported history doesn't mean anything, same restriction
  // malaria's own merged tab applies.
  const showLevers = !!curMonth.forecast

  // Real per-state units at the TIME BAR's selected month -- the SAME
  // baseline the Command Overview map/burden score reads (that one is fixed
  // to the latest real month; this one is scrubbable).
  const stateUnits = useMemo(() => {
    if (!burden) return []
    return STATE_GRID.filter(s => burden.states[s.key]).map(s => ({
      key: s.key, name: s.name, region: s.region,
      x: rowFrom(burden.states[s.key], months[effIdx], effIdx),
    }))
  }, [burden, months, effIdx])

  const lgaUnits = useMemo(() => {
    if (!burden) return []
    return Object.keys(burden.lgas).map(key => ({ key, x: rowFrom(burden.lgas[key], months[effIdx], effIdx) }))
  }, [burden, months, effIdx])

  const peerAvg = useMemo(() => {
    const totPop = stateUnits.reduce((a, u) => a + (u.x.population || 0), 0) || 1
    return {
      posRate: stateUnits.reduce((a, u) => a + (u.x.hts_pos || 0), 0) / totPop,
      testRate: stateUnits.reduce((a, u) => a + (u.x.hts_tested || 0), 0) / totPop,
      artRate: stateUnits.reduce((a, u) => a + (u.x.art_curr || 0), 0) / totPop,
      maxDensity: Math.max(...stateUnits.map(u => u.x.pop_density || 0), 1),
    }
  }, [stateUnits])

  const rawRange = useMemo(() => {
    if (!stateUnits.length) return [0, 1]
    // reuse hivBuildZones' own raw-score derivation by building baseline
    // zones once and reading back each unit's raw score
    const z = hivBuildZones(stateUnits, peerAvg, null)
    const raws = Object.values(z).map(v => v.raw).filter(v => v != null)
    return [Math.min(...raws, 0), Math.max(...raws, 1)]
  }, [stateUnits, peerAvg])

  // Scenario zones fold the SAME lever %-changes into every state AND every
  // LGA's own burden score -- moving any lever repaints the map live, same
  // as malaria's own scenZ. Only applied on a FORECAST month (showLevers) --
  // on an actual month the map shows the real, unmodified baseline, same
  // restriction malaria's own dispZ = showLevers ? scenZ : baseZ applies.
  const scenStateZ = useMemo(() =>
    hivBuildZones(stateUnits.map(u => ({ key: u.key, x: showLevers ? applyLevers(u.x, vals) : u.x })), peerAvg, rawRange),
    [stateUnits, vals, peerAvg, rawRange, showLevers])
  const scenLgaZ = useMemo(() =>
    hivBuildZones(lgaUnits.map(u => ({ key: u.key, x: showLevers ? applyLevers(u.x, vals) : u.x })), peerAvg, rawRange),
    [lgaUnits, vals, peerAvg, rawRange, showLevers])
  // Always lever-free (unlike scenStateZ/scenLgaZ, which collapse to this
  // exact same thing when !showLevers) -- kept separately so the zone-count
  // cards can show a "+N vs base" delta on forecast months where a lever IS
  // moving zone composition, matching malaria's own dist.base/dist.scen split.
  const baseStateZ = useMemo(() => hivBuildZones(stateUnits, peerAvg, rawRange), [stateUnits, peerAvg, rawRange])
  const baseLgaZ = useMemo(() => hivBuildZones(lgaUnits, peerAvg, rawRange), [lgaUnits, peerAvg, rawRange])

  const points = useMemo(() => stateUnits.map(u => {
    const z = scenStateZ[u.key] || {}
    return { key: u.key, name: u.name, region: u.region, score: z.display, zone: z.zone, dominant: z.zone }
  }), [stateUnits, scenStateZ])

  // Driven by the page-level State view/LGA view toggle (mapScope), the SAME
  // toggle that controls the map below -- these 5 cards always describe
  // exactly what the map is currently showing, matching malaria's own
  // VisualOverview.jsx dist/scope logic exactly:
  //   State view           -> count all 37 states
  //   LGA view, no state   -> count ALL LGAs nationally (796)
  //   LGA view, state set  -> count only that state's own LGAs
  const zoneCounts = useMemo(() => {
    const scen = Object.fromEntries(HIV_ZONE_ORDER.map(z => [z, 0]))
    const base = Object.fromEntries(HIV_ZONE_ORDER.map(z => [z, 0]))
    if (mapScope === 'states') {
      Object.entries(scenStateZ).forEach(([, z]) => { if (z?.zone) scen[z.zone]++ })
      Object.entries(baseStateZ).forEach(([, z]) => { if (z?.zone) base[z.zone]++ })
    } else {
      const prefix = selState ? `${selState}|||` : null
      Object.entries(scenLgaZ).forEach(([key, z]) => { if ((!prefix || key.startsWith(prefix)) && z?.zone) scen[z.zone]++ })
      Object.entries(baseLgaZ).forEach(([key, z]) => { if ((!prefix || key.startsWith(prefix)) && z?.zone) base[z.zone]++ })
    }
    return { scen, base }
  }, [scenStateZ, baseStateZ, scenLgaZ, baseLgaZ, selState, mapScope])

  // ── transparent score breakdown for the selected area (or the national
  // aggregate when nothing's selected) -- exactly the factor-by-factor
  // formula + real substituted numbers hivScoreDetail computes, so "on what
  // basis was this zone calculated" always has a real, visible answer, live
  // as levers move. A national aggregate isn't itself one of the ranked
  // peer units, so it gets the same 5-factor raw breakdown/score but no
  // zone badge (zone is inherently a rank-among-states concept).
  const selectedUnit = useMemo(() => {
    if (selState) {
      const u = stateUnits.find(s => s.key === selState)
      return u ? { name: STATE_GRID.find(s => s.key === selState)?.name, x: showLevers ? applyLevers(u.x, vals) : u.x } : null
    }
    if (!stateUnits.length) return null
    const x = {
      hts_tested: stateUnits.reduce((a, u) => a + u.x.hts_tested, 0),
      hts_pos: stateUnits.reduce((a, u) => a + u.x.hts_pos, 0),
      art_curr: stateUnits.reduce((a, u) => a + u.x.art_curr, 0),
      art_vl_tested: stateUnits.reduce((a, u) => a + u.x.art_vl_tested, 0),
      population: stateUnits.reduce((a, u) => a + u.x.population, 0),
      pop_density: stateUnits.reduce((a, u) => a + u.x.pop_density, 0) / stateUnits.length,
    }
    return { name: 'Nigeria (National)', x: showLevers ? applyLevers(x, vals) : x }
  }, [stateUnits, selState, vals, showLevers])
  const selectedDetail = useMemo(() => selectedUnit ? hivScoreDetail(selectedUnit.x, peerAvg) : null, [selectedUnit, peerAvg])
  const selectedZoneInfo = selState ? scenStateZ[selState] : null

  // Real Population & Density context for the current scope (national sum /
  // state value) -- shown as plain KPI tiles, always visible regardless of
  // whether those levers have been touched.
  const scopeCtx = useMemo(() => {
    if (selState) {
      const u = stateUnits.find(s => s.key === selState)
      return u ? { population: u.x.population, pop_density: u.x.pop_density } : { population: 0, pop_density: 0 }
    }
    const pop = stateUnits.reduce((a, u) => a + (u.x.population || 0), 0)
    const dens = stateUnits.length ? stateUnits.reduce((a, u) => a + (u.x.pop_density || 0), 0) / stateUnits.length : 0
    return { population: pop, pop_density: dens }
  }, [stateUnits, selState])

  // Key-population + socioeconomic baselines (national-only -- too sparse
  // per-state for an honest slider baseline) plus the 4 real NDARS drivers'
  // baselines, read directly from the SAME burden_rich.json panel (national
  // sum across states, or the selected state's own value).
  const baselines = useMemo(() => {
    if (!burden || !kpSocio) return {}
    const scopeUnit = selState ? stateUnits.find(s => s.key === selState)?.x : null
    const x = scopeUnit || {
      hts_tested: stateUnits.reduce((a, u) => a + u.x.hts_tested, 0),
      art_curr: stateUnits.reduce((a, u) => a + u.x.art_curr, 0),
      art_vl_tested: stateUnits.reduce((a, u) => a + u.x.art_vl_tested, 0),
      pmtct_tested: stateUnits.reduce((a, u) => a + u.x.pmtct_tested, 0),
    }
    const socScope = selState ? kpSocio.socioeconomic.states[STATE_GRID.find(s => s.key === selState)?.name] : kpSocio.socioeconomic.national
    return {
      hts_testing: x.hts_tested || 0, art: x.art_curr || 0, vl_monitoring: x.art_vl_tested || 0,
      pmtct_testing: x.pmtct_tested || 0,
      poverty: socScope?.poverty_mpi_h ?? kpSocio.socioeconomic.national.poverty_mpi_h,
      literacy: socScope?.literacy_access ?? kpSocio.socioeconomic.national.literacy_access,
      msm: kpSocio.kp.msm?.prep_eligible_monthly_national ?? 0,
      pwid: kpSocio.kp.pwid?.prep_eligible_monthly_national ?? 0,
      sw: kpSocio.kp.sw?.prep_eligible_monthly_national ?? 0,
      tg: kpSocio.kp.tg?.prep_eligible_monthly_national ?? 0,
      popPct: scopeCtx.population, densPct: scopeCtx.pop_density,
    }
  }, [burden, kpSocio, stateUnits, selState, scopeCtx])

  // ── national/state real+forecast hts_pos trend -- SAME data + climatology
  // method the Command Overview dose-trend charts already use, scaled live
  // by the SAME caseMultiplier() driving the map, so map + chart never disagree.
  const baseSeries = useMemo(() => {
    if (!burden) return []
    const store = selState ? { [selState]: burden.states[selState] } : burden.states
    return months.map((m, i) => ({
      date: m.ym, month: m.label, forecast: m.forecast,
      cases: Object.values(store).reduce((a, b) => a + (b?.hts_pos?.[i] || 0), 0),
    }))
  }, [burden, months, selState])

  const mult = useMemo(() => caseMultiplier(vals), [vals])
  const chartData = useMemo(() => {
    const rows = baseSeries.map(d => ({
      date: d.date,
      Historical: !d.forecast ? d.cases : null,
      'Base Forecast': d.forecast ? d.cases : null,
      'What-If': d.forecast ? d.cases * mult : null,
    }))
    const lastHist = [...rows].reverse().find(d => d.Historical != null)
    if (lastHist) { lastHist['Base Forecast'] = lastHist.Historical; lastHist['What-If'] = lastHist.Historical }
    return rows
  }, [baseSeries, mult])
  const splitDate = baseSeries.find(d => d.forecast)?.date
  const fcRows = baseSeries.filter(d => d.forecast)
  const baseCases = fcRows.reduce((a, d) => a + d.cases, 0)
  const wiCases = baseCases * mult
  const averted = baseCases - wiCases
  const anyLeverMoved = Object.values(vals).some(v => v)

  const onMapSelect = name => {
    const key = STATE_GRID.find(s => s.name === name)?.key
    setSelState(s => (s === key ? null : key))
  }
  const onMapSelectLga = (stateName, lgaName) => {
    setSelLga(l => (l && l.state === stateName && l.lga === lgaName) ? null : { state: stateName, lga: lgaName })
  }
  const lastRealMonth = months[lastRealIdx] || null

  const generateBudget = async () => {
    setBudgeting(true); setBudgetErr(null); setBudgetPlan(null); setLastBudgetNgn(null)
    try {
      const population = scopeCtx.population
      const r = await api('/api/budget', {
        level: selState ? 'state' : 'national', state_name: selState ? STATE_GRID.find(s => s.key === selState)?.name : null,
        target: HIV_TARGET, interventions: vals,
        base_monthly_cases: baseCases / (fcRows.length || 1), whatif_monthly_cases: wiCases / (fcRows.length || 1),
        population, horizon,
        months: fcRows.map(d => d.date), base_monthly: fcRows.map(d => d.cases), whatif_monthly: fcRows.map(d => d.cases * mult),
        disease: 'hiv',
      })
      setBudgetPlan(r.plan)
    } catch (e) { setBudgetErr(String(e)) }
    setBudgeting(false)
  }

  const optimizeBudget = async () => {
    setBudgeting(true); setBudgetErr(null); setBudgetPlan(null)
    try {
      const r = await api('/api/budget-optimize', {
        level: selState ? 'state' : 'national', state_name: selState ? STATE_GRID.find(s => s.key === selState)?.name : null,
        target: HIV_TARGET, horizon, budget_ngn: budgetNgn, disease: 'hiv',
      })
      setVals(v => {
        const nv = { ...v }
        for (const [col, pct] of Object.entries(r.interventions || {})) if (col in nv) nv[col] = pct
        return nv
      })
      setBudgetPlan(r.plan)
      setLastBudgetNgn(budgetNgn)
    } catch (e) { setBudgetErr(String(e)) }
    setBudgeting(false)
  }

  const saveProposal = async () => {
    if (!budgetPlan) return
    const rec = {
      mode: budgetMode, level: selState ? 'state' : 'national', state_name: selState ? STATE_GRID.find(s => s.key === selState)?.name : null, horizon,
      interventions: vals, budget_ngn: lastBudgetNgn,
      summary: { base_total: Math.round(baseCases), whatif_total: Math.round(wiCases), averted: Math.round(averted),
        cost_per_case: lastBudgetNgn && averted > 0 ? Math.round(lastBudgetNgn / averted) : null },
      plan: budgetPlan, disease: 'hiv',
      months: fcRows.map(d => d.date), base_monthly: fcRows.map(d => d.cases), whatif_monthly: fcRows.map(d => d.cases * mult),
    }
    const saved = await api('/api/proposals', rec)
    setSavedNote(`Saved as v${saved.version}`)
    setTimeout(() => setSavedNote(null), 2500)
    loadProposals()
  }

  const runAiCompare = async () => {
    setAiComparing(true); setAiCompareErr(null); setAiCompare(null)
    try {
      const r = await api('/api/compare-proposals', { proposal_ids: compareIds, disease: 'hiv' })
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
  const scopeLabel = selState ? STATE_GRID.find(s => s.key === selState)?.name : 'Nigeria (National)'

  if (!burden || !kpSocio) return <div className="loading"><div className="spinner" />Loading real HIV data…</div>

  return (
    <>
      <div className="view-head">
        <h2>What If Simulation</h2>
        <p>
          Hotspot zones (🔴 Red · 🟠 Amber · 🟡 Yellow · 🟢 Green · ⚪ Not a Hotspot) come from a burden score built
          on case burden, testing gaps, ART coverage &amp; viral-load monitoring.
        </p>
      </div>

      <div className="controls" style={{ marginBottom: 18 }}>
        <div className="select-wrap"><label>Scope</label>
          <select value={selState || ''} onChange={e => setSelState(e.target.value || null)} style={{ minWidth: 200 }}>
            <option value="">Nigeria (national)</option>
            {STATE_GRID.filter(s => burden.states[s.key]).map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select></div>
        <button className="btn" onClick={() => setVals(DEFAULT_VALS)}>↺ Reset to baseline</button>
      </div>

      {/* ── Page-level State view/LGA view toggle -- drives BOTH the burden map ── */}
      {/* below AND the 5 zone-distribution cards, same placement/style as malaria's ── */}
      {/* own VisualOverview.jsx (top-of-page, not buried inside the map card). ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {[['states', 'State view'], ['lgas', 'LGA view']].map(([k, lbl]) => (
            <button key={k} onClick={() => setMapScope(k)}
              style={{ border: 'none', cursor: 'pointer', padding: '6px 14px', borderRadius: 6, fontSize: '.78rem', fontWeight: 600, fontFamily: 'var(--font)',
                background: mapScope === k ? 'var(--bg-1)' : 'transparent', color: mapScope === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>))}
        </div>
        {mapScope === 'lgas' && selState && (
          <button className="btn" onClick={() => setSelState(null)} style={{ padding: '6px 12px' }}>← {scopeLabel} (all states)</button>
        )}
      </div>

      {/* ── TIME BAR — monthly, actual vs forecast, same pattern as malaria's own merged tab ── */}
      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--txt-2)', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
              Time period
              <InfoTip w={300} title="Actual vs forecast" text="The data is monthly. This slider picks which month the map and levers apply to. Months up to the latest real report are ACTUAL NDARS data; the next 12 months are a FORECAST built from real calendar-month climatology. Levers only apply on forecast months -- testing a what-if against already-reported history doesn't mean anything." />
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
            <button className="btn" onClick={() => setMonthIdx(i => Math.max(0, (i ?? effIdx) - 1))} style={{ padding: '6px 11px' }}>‹</button>
            <input type="range" min={0} max={Math.max(0, months.length - 1)} step={1} value={effIdx}
              style={{ flex: 1, '--pct': (months.length > 1 ? effIdx / (months.length - 1) * 100 : 0) + '%' }}
              onChange={e => setMonthIdx(+e.target.value)} />
            <button className="btn" onClick={() => setMonthIdx(i => Math.min(months.length - 1, (i ?? effIdx) + 1))} style={{ padding: '6px 11px' }}>›</button>
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--txt-2)', maxWidth: 230, lineHeight: 1.5 }}>
            {curMonth.forecast
              ? 'Forecast month -- move levers below to condition this month\'s scenario.'
              : 'Actual reported month -- move the slider into 2026+ to test interventions.'}
          </div>
        </div>
      </Card>

      {/* ── Zone-distribution cards -- white/plain, same exact card style as ── */}
      {/* malaria's VisualOverview.jsx (className="card" + coloured label, dark ── */}
      {/* value), NOT the tinted ColorKPI style used elsewhere on this page. ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 18 }}>
        {HIV_ZONE_ORDER.map(zone => {
          const scenN = zoneCounts.scen[zone] || 0
          const baseN = zoneCounts.base[zone] || 0
          const delta = scenN - baseN
          const info = zone === 'No Data'
            ? `Count of ${mapScope === 'lgas' ? (selState ? `${scopeLabel}'s own LGAs` : 'LGAs nationally') : 'states nationally'} with ZERO real reported rows this month (no facility reported any HIV testing/ART/PMTCT activity at all) -- excluded from scoring rather than treated as a real 0, since "no data" and "confirmed zero activity" are not the same claim. Not counted toward any other zone's ranking either.`
            : `Count of ${mapScope === 'lgas' ? (selState ? `${scopeLabel}'s own LGAs` : 'LGAs nationally') : 'states nationally'} currently classified ${HIV_ZONE_LABELS[zone]} by the burden score (case burden, testing gap, ART coverage gap, VL-monitoring gap, population density -- same 5-factor formula as the map below), ranked only among areas that reported real data this month. Live and lever-responsive on forecast months: moving a lever recomputes every area's score and can move it into a different zone.`
          return (
            <div key={zone} className="card" style={{ flex: 1, minWidth: 92, padding: '12px 14px', position: 'relative', overflow: 'visible' }}>
              <div style={{ fontSize: '.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: HIV_ZONE_COLORS[zone], display: 'flex', alignItems: 'center' }}>
                {HIV_ZONE_LABELS[zone]}
                <InfoTip text={info} />
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', color: 'var(--txt-0)', marginTop: 4 }}>{scenN}</div>
              {delta !== 0 && (
                <div style={{ fontSize: '.68rem', fontWeight: 600, color: delta < 0 ? COLORS.green : COLORS.coral }}>
                  {delta > 0 ? '+' : ''}{delta} vs base
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Card className="col"
          title={<span style={{ display: 'flex', alignItems: 'center' }}>Levers<InfoTip w={360} title="How levers work" text="Each slider moves a real NDARS/MPI baseline by a percentage. Testing/ART/VL levers scale that field's real count directly. Population/Density scale demographic context AND dilute the testing/ART coverage-gap factors (more people, same real capacity = wider gap) unless you also move those levers to match. Poverty/Literacy are gentle directional risk/protective factors (OPHI/NBS MPI 2019). MSM/PWID/SW/TG scale real NDARS PrEP-eligibility, pre-weighted by each group's cited share of Nigeria's PLHIV so their effect on the total never overstates a small population's influence. Every lever recomputes the burden map AND the trend chart's What-If line instantly, client-side -- no server round trip -- using the exact same elasticity values the backend's /api/whatif and budget solver use, so this live preview and a real Budget Planning run can never disagree." /></span>}
          sub={showLevers ? `Baseline = real recent NDARS/MPI data for ${scopeLabel}, at ${curMonth.label}` : `Viewing ${curMonth.label} (actual)`}
          style={{ flex: 1, minWidth: 340, maxWidth: 470 }}>
          {!showLevers ? (
            <div style={{ fontSize: '.84rem', color: 'var(--txt-2)', lineHeight: 1.6, padding: '8px 2px' }}>
              <b>{curMonth.label}</b> is already-reported, actual NDARS data -- testing a "what if" against real
              history doesn't mean anything. Move the time-period slider above into a <b>🔮 forecast</b> month
              (past {months.find(m => m.forecast)?.label || 'the latest real month'}) to activate the levers below.
            </div>
          ) : LEVER_GROUPS.map(g => (
            <div key={g.cat}>
              <div className="cat-label">{g.cat}</div>
              {g.levers.map(l => (
                <Lever key={l.id} meta={l} pct={vals[l.id] || 0} baseline={baselines[l.id]}
                  unit={l.id === 'popPct' ? '' : l.id === 'densPct' ? '/km²' : '/mo'}
                  onChange={v => setVals(s => ({ ...s, [l.id]: v }))} />
              ))}
            </div>
          ))}
        </Card>

        <div className="col" style={{ flex: 1.45, minWidth: 420, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Card title={<span style={{ display: 'flex', alignItems: 'center' }}>Burden Map<InfoTip w={380} title="How the map is scored" text="Every state is scored 0-100 by hivScoreDetail (ui/src/hivBurdenScore.js): Case burden/positivity (weight 30, this area's positivity rate vs 2.5x the national peer average), Testing gap (20, shortfall vs peer average testing rate), ART coverage gap (20, shortfall vs peer average ART rate), VL-monitoring gap (20, this area's own on-ART-with-VL-result ÷ currently-on-ART ratio -- no peer needed), Population density (10, this area's density vs the national max). The displayed 0-100 score blends this raw score's RANK among all 37 states (60% weight) with the raw score itself normalised against the national spread (40% weight) -- same rank+raw blend malaria's own map uses, via scoreToZone's thresholds: <60 Not a Hotspot, <71 Green, <81 Yellow, <91 Amber, else Red. Colours recompute live as levers move (on forecast months only) using the SAME formula, so a lever's effect on the map is never a different calculation than what's shown in the Score Breakdown card below." /></span>}
            sub="Recolours live as levers move -- same scoring engine as Command Overview. Switch to LGA view to drill into facilities.">
            <RiskMap points={points} lgaZones={scenLgaZ} selected={selState ? [STATE_GRID.find(s => s.key === selState)?.name] : []}
              selectedLga={selLga ? [`${selLga.state}|||${selLga.lga}`] : []} onSelect={onMapSelect} onSelectLga={onMapSelectLga}
              categoryFilter="All" regionFilter="All" scope={mapScope} onScopeChange={setMapScope} />
          </Card>

          {selLga && (
            <FacilityPanel disease="hiv" stateName={selLga.state} lga={selLga.lga} selMonth={lastRealMonth}
              lgaBurden={scenLgaZ[`${selLga.state}|||${selLga.lga}`]?.display} lgaZone={scenLgaZ[`${selLga.state}|||${selLga.lga}`]?.zone} />
          )}

          {selectedUnit && (() => {
            // Hotspot ZONE colour (Red/Amber/Yellow/Green/Not-a-Hotspot) --
            // the SAME colours the map uses, not a generic brand palette.
            // National aggregate has no zone of its own (zone is a
            // rank-among-states concept), so it falls back to a neutral
            // "not a hotspot" grey rather than a fabricated colour.
            const zone = selState && selectedZoneInfo ? selectedZoneInfo.zone : 'Not a Hotspot'
            const zoneColor = HIV_ZONE_COLORS[zone] || '#94a3b8'
            const zoneLabel = HIV_ZONE_LABELS[zone] || 'No Data'
            return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 14px',
                background: `${zoneColor}14`, border: `1px solid ${zoneColor}55`, borderRadius: 10 }}>
                <span style={{ width: 12, height: 12, borderRadius: 4, background: zoneColor, flexShrink: 0 }} />
                <span style={{ fontWeight: 800, fontSize: '.92rem', color: zoneColor }}>{selectedUnit.name} — {zoneLabel}</span>
                {selState && selectedZoneInfo?.display != null && <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '.85rem', color: zoneColor, opacity: .85 }}>Score {selectedZoneInfo.display.toFixed(1)}</span>}
                <span style={{ fontSize: '.72rem', color: 'var(--txt-3)', marginLeft: 'auto' }}>at {curMonth.label}</span>
              </div>
              {zone === 'No Data' && (
                <div style={{ fontSize: '.78rem', color: 'var(--txt-2)', marginBottom: 12, padding: '8px 14px', background: 'var(--bg-2)', borderRadius: 8 }}>
                  {selectedUnit.name} has no real reported HIV testing/ART/PMTCT data for {curMonth.label} -- excluded from
                  zone scoring rather than shown as low-risk. The figures below (if any) are genuine reported counts for
                  other fields; a 0 here means truly zero rows, not a computed risk level.
                </div>
              )}
              <div className="grid4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                <ColorKPI label="HIV Tests Conducted" value={fmt(selectedUnit.x.hts_tested)} sub={selectedUnit.name} color={zoneColor} icon={TrendingUp}
                  info={`Real NDARS HTS_TST Total (Male+Female) for ${selectedUnit.name} at ${curMonth.label}${showLevers ? ' -- scaled live by the HIV testing volume lever below' : ' (actual reported figure)'}. This is the "testing gap" input to the burden score (weight 20): how far below the peer-average testing rate this area sits. Coloured by ${selectedUnit.name}'s current hotspot zone (${zoneLabel}) -- the same colour the map uses for this area.`} />
                <ColorKPI label="New HIV-Positive Diagnoses" value={fmt(selectedUnit.x.hts_pos)} sub={selectedUnit.name} color={zoneColor} icon={TrendingDown}
                  info={`Real NDARS HTS_TST_POS Total (Male+Female) for ${selectedUnit.name} at ${curMonth.label}. This is the forecast target itself and the "case burden" factor in the score (weight 30, the heaviest) -- scaled by the FULL combined lever multiplier when levers are active, same number the trend chart plots. Coloured by ${selectedUnit.name}'s current hotspot zone (${zoneLabel}).`} />
                <ColorKPI label="Currently on ART" value={fmt(selectedUnit.x.art_curr)} sub={selectedUnit.name} color={zoneColor} icon={ShieldCheck}
                  info={`Real NDARS ART Monthly_3 (Male+Female) for ${selectedUnit.name} at ${curMonth.label}${showLevers ? ' -- scaled live by the ART lever below' : ''}. Feeds the "ART coverage gap" factor (weight 20) and the "VL-monitoring gap" factor's denominator. Coloured by ${selectedUnit.name}'s current hotspot zone (${zoneLabel}).`} />
                <ColorKPI label="VL-Monitoring Coverage" value={selectedUnit.x.art_curr > 0 ? `${(100 * selectedUnit.x.art_vl_tested / selectedUnit.x.art_curr).toFixed(1)}%` : '—'} sub={selectedUnit.name} color={zoneColor} icon={Activity}
                  info={`On-ART-with-a-VL-result ÷ Currently-on-ART for ${selectedUnit.name} at ${curMonth.label} -- deliberately a monitoring-INTENSITY proxy (were patients checked at all), not the suppression-rate itself. A real NDARS "ART: Percentage Virally Suppressed" indicator does exist and is shown on the Treatment & Care tab, but it's reported as a facility-grain percentage with no paired raw count to weight by facility size -- kept out of this ranked, count-based score formula for that reason, shown separately instead of silently blended in. Self-contained factor (weight 20) -- doesn't need a peer average, just this area's own ratio. Coloured by ${selectedUnit.name}'s current hotspot zone (${zoneLabel}).`} />
              </div>
            </>
            )
          })()}

          {selectedDetail && (
            <Card title={<span style={{ display: 'flex', alignItems: 'center' }}>Score Breakdown — {selectedUnit.name}<InfoTip w={380} title="Reading this table" text="Each row is one of the 5 real factors in hivScoreDetail: its name, its formula in plain notation, the SAME formula with this area's actual numbers substituted in (so you can verify the math by hand), its weight out of 100, and the points it contributes (weight x sub-score, where sub-score is clamped 0-1). The Points column sums to the Raw score at the bottom -- that raw score then gets blended with this area's rank among its peers (see the note above the table) to produce the displayed 0-100/zone shown in the top-right and on the map." /></span>}
              sub="Every factor, its formula, and the real numbers behind it -- live, as levers move"
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '1.2rem', fontWeight: 800, color: 'var(--txt-0)' }}>
                    {(() => {
                      const v = selState ? selectedZoneInfo?.display : selectedDetail.raw
                      return v != null ? v.toFixed(1) : '—'
                    })()}
                  </span>
                  {selState && selectedZoneInfo && (
                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: '.72rem', fontWeight: 700,
                      background: (HIV_ZONE_COLORS[selectedZoneInfo.zone] || '#94a3b8') + '22', color: HIV_ZONE_COLORS[selectedZoneInfo.zone] || '#94a3b8',
                      border: `1px solid ${HIV_ZONE_COLORS[selectedZoneInfo.zone] || '#94a3b8'}66` }}>{HIV_ZONE_LABELS[selectedZoneInfo.zone] || 'No Data'}</span>
                  )}
                </div>
              }>
              {!selState && (
                <div style={{ fontSize: '.74rem', color: 'var(--txt-3)', marginBottom: 10, lineHeight: 1.5 }}>
                  National aggregate — shown as a raw 5-factor score (0-100 scale). Zone colours (Red/Amber/Yellow/Green)
                  are a rank-among-states concept, so they only apply once you select a state on the map above.
                </div>
              )}
              {selState && selectedZoneInfo && (
                <div style={{ fontSize: '.74rem', color: 'var(--txt-3)', marginBottom: 10, lineHeight: 1.5 }}>
                  Displayed score blends this state's rank among all 37 states (60% weight) with its raw score normalised
                  against the national spread (40% weight) — ranked <b>{selectedZoneInfo.rankPos}</b> of {selectedZoneInfo.n} nationally.
                  The raw 5-factor score below ({selectedDetail.raw.toFixed(1)}) is the input to that blend, not the same number.
                </div>
              )}
              <table className="data" style={{ width: '100%' }}>
                <thead><tr><th>Factor</th><th>Formula</th><th className="num">Weight</th><th className="num">Points</th></tr></thead>
                <tbody>
                  {selectedDetail.factors.map(f => (
                    <tr key={f.name}>
                      <td style={{ fontWeight: 600 }}>{f.name}</td>
                      <td style={{ fontSize: '.76rem', color: 'var(--txt-2)' }}>
                        {f.formula}<br /><span style={{ fontFamily: 'var(--mono)', color: 'var(--txt-1)' }}>{f.subst} = {f.sub.toFixed(2)}</span>
                      </td>
                      <td className="num">{f.w}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{f.points.toFixed(1)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'right', fontWeight: 700 }}>Raw score (sum of points)</td>
                    <td className="num" style={{ fontWeight: 800 }}>{selectedDetail.raw.toFixed(1)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          )}

          <Card title={<span style={{ display: 'flex', alignItems: 'center' }}>New HIV diagnoses — {scopeLabel}<InfoTip w={380} title="How this chart is built" text="Historical = real NDARS HTS_TST_POS Total (Male+Female), summed across the current scope, one point per real reported month. Base Forecast = calendar-month climatology (the average of each real calendar month across all real years, e.g. every real January averaged together) for the next 12 months -- the same honest fallback used everywhere in this build since no HIV-specific ML forecast model exists yet. What-If = Base Forecast x the combined lever multiplier (product of every moved lever's 1 + elasticity x %change term). The violet 'selected' line marks whichever month the time bar above is on; the amber 'Forecast ->' line marks where real data ends and the forecast begins." /></span>}
            sub="Solid teal = historical. Dashed = baseline forecast. Solid coloured = what-if scenario.">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="date" {...axPr} tickFormatter={monthLabel} minTickGap={36} />
                <YAxis {...axPr} tickFormatter={fmt} width={52} />
                <Tooltip content={<ChartTT />} />
                {splitDate && <ReferenceLine x={splitDate} stroke="rgba(217,119,6,.5)" strokeDasharray="4 4" label={{ value: 'Forecast →', fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />}
                <ReferenceLine x={curMonth.ym} stroke={COLORS.violet} strokeWidth={2} label={{ value: 'selected', fill: COLORS.violet, fontSize: 10, position: 'top' }} />
                <Legend wrapperStyle={{ fontSize: '.78rem', color: 'var(--txt-1)' }} />
                <Line type="monotone" dataKey="Historical" name="Historical" stroke={COLORS.accent} strokeWidth={2.4} dot={false} connectNulls />
                <Line type="monotone" dataKey="Base Forecast" name="Base (no new action)" stroke={COLORS.accent2} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                <Line type="monotone" dataKey="What-If" name="What-If (live)" stroke={averted >= 0 ? COLORS.green : COLORS.coral} strokeWidth={2.6} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </div>
      </div>

      {/* ═══ BUDGET PLANNING ═══ */}
      <div className="row" style={{ marginTop: 18, alignItems: 'flex-start' }}>
        <Card className="col" style={{ flex: 2, minWidth: 460 }}
          title={<span style={{ display: 'flex', alignItems: 'center' }}>Budget Planning<InfoTip w={400} title="Forward vs Reverse mode" text="Levers -> Budget (forward): prices out the EXACT scenario you've already built with the levers above -- sends your lever %-changes to the server, which writes a Groq-generated month-by-month deployment plan grounded in real literature-cited ₦ unit costs (ART ~$130/patient-year, HIV test ~$20, PMTCT test ~$18, VL test ~$20, PrEP ~$70/person-year -- see the README for full citations). Budget -> Levers (reverse): you name a total budget; a mathematical water-filling solver (NOT an AI guess -- the same provably-optimal concave-allocation algorithm malaria's own solver uses) decides the cost-effective spend mix across all 8 levers to maximise cases averted, then Groq only narrates the already-decided plan and the levers above move to match. Both modes save Proposals you can compare side-by-side." /></span>}
          sub="Detailed month-wise HIV plan via Groq llama-3.1-8b-instant — in both ₦ and USD"
          right={
            <div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
              {[['forward', 'Levers → Budget'], ['reverse', 'Budget → Levers']].map(([k, lbl]) => (
                <button key={k} onClick={() => setBudgetMode(k)} style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
                  fontSize: '.76rem', fontWeight: 600, fontFamily: 'var(--font)', background: budgetMode === k ? 'var(--bg-1)' : 'transparent',
                  color: budgetMode === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>
              ))}
            </div>
          }>
          {budgetMode === 'forward' && (
            <div style={{ marginBottom: 12 }}>
              {!anyLeverMoved ? (
                <div style={{ color: 'var(--txt-2)', fontSize: '.84rem', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                  Move at least one lever above -- this prices out the exact scenario you've already built on this page.
                </div>
              ) : (
                <button onClick={generateBudget} disabled={budgeting}
                  style={{ padding: '10px 22px', background: COLORS.violet, color: '#fff', border: 'none', borderRadius: 10,
                    cursor: budgeting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.88rem', fontFamily: 'var(--font)', opacity: budgeting ? .6 : 1 }}>
                  💰 Generate month-wise HIV budget plan
                </button>
              )}
            </div>
          )}
          {budgetMode === 'reverse' && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: 'var(--txt-2)', fontSize: '.84rem', marginBottom: 10, lineHeight: 1.55 }}>
                Enter a total budget — a mathematical solver picks the optimal HIV intervention mix (real ₦ unit costs: ART, HIV testing, PMTCT testing, VL monitoring, PrEP for MSM/PWID/Sex Workers/Transgender), then projects the real impact and moves the levers above to match.
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="select-wrap"><label>Total budget (₦)</label>
                  <input type="text" value={budgetNgn.toLocaleString()} onChange={e => setBudgetNgn(Math.max(0, +e.target.value.replace(/[^0-9]/g, '') || 0))}
                    style={{ minWidth: 200, fontFamily: 'var(--mono)' }} /></div>
                <div style={{ fontSize: '.82rem', color: 'var(--txt-2)', paddingBottom: 9 }}>= <b>{fmtUsd(budgetNgn)}</b> <span className="muted">(at ₦{USD_NGN.toLocaleString()}/$)</span></div>
                <button onClick={optimizeBudget} disabled={budgeting}
                  style={{ padding: '9px 20px', background: COLORS.accent, color: '#fff', border: 'none', borderRadius: 10,
                    cursor: budgeting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '.86rem', fontFamily: 'var(--font)', opacity: budgeting ? .6 : 1 }}>
                  🎯 Optimize within budget
                </button>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[5e8, 2e9, 1e10].map(v => (
                    <button key={v} className="btn" onClick={() => setBudgetNgn(v)} style={{ padding: '6px 10px', fontSize: '.74rem' }}>{fmt(v)}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {budgeting && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--txt-2)' }}>
              <div className="spinner" style={{ margin: '0 auto 10px', borderTopColor: COLORS.violet }} />
              <div style={{ fontWeight: 600 }}>{budgetMode === 'reverse' ? 'Solving optimal HIV allocation…' : 'Generating budget & prevention report…'}</div>
            </div>
          )}
          {budgetErr && (
            <div style={{ color: COLORS.coral, fontSize: '.82rem', background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 8, padding: '10px 14px' }}>
              <b>Budget error:</b> {budgetErr}
            </div>
          )}
          {budgetPlan && !budgeting && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 12px' }}>
                <span style={{ fontSize: '.72rem', color: 'var(--txt-3)' }}>Generated by llama-3.1-8b-instant via Groq</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {savedNote && <span style={{ fontSize: '.74rem', color: COLORS.green, fontWeight: 700 }}>✓ {savedNote}</span>}
                  <button onClick={saveProposal} style={{ padding: '6px 14px', background: COLORS.accent2, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '.76rem' }}>
                    💾 Save as Proposal v{(proposals.reduce((m, p) => Math.max(m, p.version || 0), 0)) + 1}
                  </button>
                </div>
              </div>
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', maxHeight: 620, overflowY: 'auto' }}>
                <MarkdownLite text={budgetPlan} />
              </div>
            </>
          )}
        </Card>

        <Card className="col" style={{ flex: 1, minWidth: 280 }} title={`Saved Proposals (${proposals.length})`} sub="Each generation is versioned — view, compare or delete">
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
                    {p.budget_ngn ? `Budget ${fmtNgn(p.budget_ngn)}` : `${Object.values(p.interventions || {}).filter(Boolean).length} levers`}
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

      {compareIds.length >= 2 && (
        <Card style={{ marginTop: 18 }} title={`Compare ${compareIds.length} proposals`} sub="Side-by-side — see how a changed budget reshapes the plan"
          right={<button className="btn" onClick={() => { setCompareIds([]); setAiCompare(null); setAiCompareErr(null) }}>Clear</button>}>
          <div className="tbl-scroll" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead><tr><th>Metric</th>{compareIds.map(id => { const p = proposals.find(x => x.id === id); return <th key={id} className="num">v{p?.version}</th> })}</tr></thead>
              <tbody>
                {[
                  ['Mode', p => p.mode === 'reverse' ? 'Budget→Plan' : 'Plan→Budget'],
                  ['Budget (₦)', p => p.budget_ngn ? fmtNgn(p.budget_ngn) : '—'],
                  ['Budget ($)', p => p.budget_ngn ? fmtUsd(p.budget_ngn) : '—'],
                  ['Levers', p => Object.entries(p.interventions || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}%`).join(', ') || '—'],
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
            {aiComparing && <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--txt-2)' }}><div className="spinner" style={{ margin: '0 auto 8px', borderTopColor: COLORS.violet }} />AI is comparing…</div>}
            {aiCompareErr && <div style={{ color: COLORS.coral, fontSize: '.82rem', background: 'rgba(251,113,133,.1)', border: '1px solid rgba(251,113,133,.35)', borderRadius: 8, padding: '10px 14px', marginTop: 10 }}><b>Compare error:</b> {aiCompareErr}</div>}
            {aiCompare && !aiComparing && <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginTop: 12, maxHeight: 520, overflowY: 'auto' }}><MarkdownLite text={aiCompare} /></div>}
          </div>
        </Card>
      )}

      {viewProposal && (
        <Card style={{ marginTop: 18 }} title={`Proposal v${viewProposal.version} · ${viewProposal.mode === 'reverse' ? 'Budget → Levers' : 'Levers → Budget'}`}
          sub={`${viewProposal.budget_ngn ? `Budget ${fmtNgn(viewProposal.budget_ngn)} (${fmtUsd(viewProposal.budget_ngn)}) · ` : ''}${(viewProposal.created || '').replace('T', ' ').replace('+00:00', ' UTC')}`}
          right={<button className="btn" onClick={() => setViewProposal(null)}>Close</button>}>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', maxHeight: 560, overflowY: 'auto' }}>
            <MarkdownLite text={viewProposal.plan} />
          </div>
        </Card>
      )}
    </>
  )
}
