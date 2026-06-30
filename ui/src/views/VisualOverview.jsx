import React, { useState, useEffect, useMemo } from 'react'
import DeckGL from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { Map } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Card, InfoTip } from '../components'
import { fmt, COLORS } from '../lib'

const BASE = import.meta.env.BASE_URL || '/'
const CARTO = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const NIGERIA = { longitude: 8.7, latitude: 9.3, zoom: 5.2, pitch: 0, bearing: 0 }

const ZONES = {
  'Not a Hotspot': { c: '#64748b', t: '#64748b', fill: [148, 163, 184], a: 90 },
  'Green':         { c: '#16a34a', t: '#16a34a', fill: [22, 163, 74],  a: 200 },
  'Yellow':        { c: '#ca8a04', t: '#a16207', fill: [234, 179, 8],  a: 205 },
  'Amber':         { c: '#ea580c', t: '#c2410c', fill: [234, 88, 12],  a: 210 },
  'Red':           { c: '#dc2626', t: '#dc2626', fill: [220, 38, 38],  a: 215 },
}
const ZONE_ORDER = ['Red', 'Amber', 'Yellow', 'Green', 'Not a Hotspot']
const ZONE_INFO = {
  'Red': 'Severe hotspot (burden ≥ 78). Highest priority for interventions.',
  'Amber': 'High burden (58–78). Needs attention.',
  'Yellow': 'Moderate burden (38–58). Watch closely.',
  'Green': 'Low burden (18–38). Under control.',
  'Not a Hotspot': 'Minimal burden (< 18). Not currently a concern.',
}
function scoreToZone(d) {
  const s = d / 100
  if (s < 0.18) return 'Not a Hotspot'
  if (s < 0.38) return 'Green'
  if (s < 0.58) return 'Yellow'
  if (s < 0.78) return 'Amber'
  return 'Red'
}

const LEVERS = [
  { id: 'rain', field: 'rain', label: '🌧️ Rainfall',             cat: '🌍 Environmental Risk',     unit: 'mm/day', agg: 'mean', info: 'Average rainfall. More rain creates more mosquito breeding pools, so the vector-environment part of the score goes up.' },
  { id: 'temp', field: 'temp', label: '🌡️ Temperature',          cat: '🌍 Environmental Risk',     unit: '°C',     agg: 'mean', info: 'Average temperature. Malaria risk peaks around 27 °C; much hotter or colder slows the parasite and lowers the score.' },
  { id: 'hum',  field: 'hum',  label: '💧 Humidity',              cat: '🌍 Environmental Risk',     unit: '%',      agg: 'mean', info: 'Humidity. Higher humidity lets mosquitoes live longer, raising the score.' },
  { id: 'act',  field: 'act',  label: '💊 ACT treatment courses', cat: '💉 Treatment & Diagnostics', unit: 'doses/mo', agg: 'sum', info: 'Malaria treatment courses given. More treatment shrinks the “treatment gap”, lowering the burden score.' },
  { id: 'llin', field: 'llin', label: '🛏️ LLIN nets distributed', cat: '🛡️ Vector Control',        unit: 'nets/mo',  agg: 'sum', info: 'Insecticide-treated nets distributed. More nets shrink the “protection gap”, lowering the burden score.' },
]

const cl = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const n0 = v => (v == null ? '0' : (Math.abs(v) >= 1000 ? fmt(v) : (Math.abs(v) >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1))))

function scoreDetail(x, peerAvg, flags = {}) {
  const cases = x.cases || 0
  const total = (x.total || 0) || cases
  const vol = peerAvg > 0 ? cl(cases / (peerAvg * 3)) : (cases > 0 ? 1 : 0)
  const trend = cl(((x.trend || 0) + 1) / 2)
  const rd = x.rdt_done || 0
  // RDT-positive counts aren't collected in this dataset (always 0) — treat that
  // as missing data and fall back to the same neutral assumption used when no
  // RDT testing happened at all, instead of silently scoring "0% positivity"
  // everywhere and uniformly deflating every area's burden score.
  const haveRdtPos = !flags.no_rdt_pos
  const pos = (haveRdtPos && rd > 0) ? cl((x.rdt_pos || 0) / rd) : (total > 0 ? 0.55 : 0)
  const gap = total > 0 ? cl((total - (x.act || 0) - (x.treated || 0)) / total) : 0
  const rain_s = cl(((x.rain || 0) - 3) / 27)
  const temp_s = 1 - cl(Math.abs((x.temp ?? 27) - 27) / 12)
  const hum_s = cl(((x.hum ?? 60) - 40) / 55)
  const nets = (x.itn || 0) + (x.llin || 0)
  const ref = Math.max(1, cases * 2.5)
  const net_s = 1 - cl(nets / ref)
  const ipt_s = 1 - cl((x.ipt_cov || 0) / 100)
  const F = [
    { name: 'A1 · Case volume',   w: 20, sub: vol,    formula: 'min(1, cases ÷ (peer_avg × 3))',  subst: `min(1, ${n0(cases)} ÷ (${n0(peerAvg)} × 3))` },
    { name: 'A2 · Case trend',    w: 15, sub: trend,  formula: '(trend_ratio + 1) ÷ 2',            subst: `(${(x.trend || 0).toFixed(2)} + 1) ÷ 2` },
    { name: 'B1 · RDT positivity',w: 12, sub: pos,    formula: 'positives ÷ tests (else 0.55)',     subst: (haveRdtPos && rd > 0) ? `${n0(x.rdt_pos || 0)} ÷ ${n0(rd)}` : 'no RDT+ data → 0.55' },
    { name: 'B2 · Treatment gap', w: 13, sub: gap,    formula: '(total − ACT − treated) ÷ total',   subst: total > 0 ? `(${n0(total)} − ${n0(x.act || 0)} − ${n0(x.treated || 0)}) ÷ ${n0(total)}` : 'no cases → 0' },
    { name: 'C1 · Rainfall',      w: 8,  sub: rain_s, formula: '(mm/day − 3) ÷ 27',                 subst: `(${(x.rain || 0).toFixed(1)} − 3) ÷ 27` },
    { name: 'C2 · Temperature',   w: 6,  sub: temp_s, formula: '1 − |°C − 27| ÷ 12',                subst: `1 − |${(x.temp ?? 27).toFixed(1)} − 27| ÷ 12` },
    { name: 'C3 · Humidity',      w: 6,  sub: hum_s,  formula: '(% − 40) ÷ 55',                     subst: `(${(x.hum ?? 60).toFixed(0)} − 40) ÷ 55` },
    { name: 'D1 · Net gap',       w: 10, sub: net_s,  formula: '1 − (ITN + LLIN) ÷ (cases × 2.5)',  subst: `1 − ${n0(nets)} ÷ ${n0(ref)}` },
    { name: 'D2 · IRS gap',       w: 5,  sub: 1.0,    formula: '1 − sprayed ÷ (total × 0.5)',       subst: 'no IRS data → 1.0' },
    { name: 'D3 · IPT gap',       w: 5,  sub: ipt_s,  formula: '1 − IPT_coverage ÷ 100',            subst: `1 − ${n0(x.ipt_cov || 0)} ÷ 100` },
  ]
  F.forEach(r => { r.points = r.w * r.sub })
  return { factors: F, raw: F.reduce((a, r) => a + r.points, 0) }
}

function pctRanks(vals) {
  const n = vals.length
  if (n === 0) return []
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const out = new Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg / n
    i = j + 1
  }
  return out
}

function buildZones(units, peerAvg, flags) {
  const raws = units.map(u => scoreDetail(u.x, peerAvg, flags).raw)
  const ranks = pctRanks(raws)
  const order = raws.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])
  const pos = {}; order.forEach(([, i], r) => { pos[i] = r + 1 })
  const res = {}
  units.forEach((u, i) => {
    const rankTerm = 0.60 * ranks[i], rawTerm = 0.40 * (raws[i] / 100)
    const display = cl(rankTerm + rawTerm, 0, 1) * 100
    res[u.key] = { raw: raws[i], rankPct: ranks[i], rankPos: pos[i], rankTerm, rawTerm, display, zone: scoreToZone(display), n: units.length }
  })
  return res
}

function applyLevers(x, vals) {
  const y = { ...x }
  for (const L of LEVERS) {
    const pct = vals[L.id] || 0
    if (!pct) continue
    let v = (x[L.field] || 0) * (1 + pct / 100)
    if (L.field === 'temp') v = cl(v, 15, 45)
    if (L.field === 'hum') v = cl(v, 0, 100)
    y[L.field] = Math.max(0, v)
  }
  return y
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

// Non-malaria diseases: burden score is precomputed Python-side (etl_warehouse_common.burden_score)
// and read directly from burden.json's flat per-LGA snapshot — no live client-side recomputation,
// no levers (no driver data exists to lever), no time slider (one latest snapshot per LGA, not a
// monthly series). Source "zone" labels vary by disease ("Safe Zone", "Red Zone", canonical
// "Amber", etc.) so the map/legend colour always derives from the canonical burden_score via
// scoreToZone() instead, keeping every disease's colouring consistent.
function StaticZoneMap({ disease, label, variant = 'after', rankByLabel }) {
  const [statesGeo, setStatesGeo] = useState(null)
  const [lgasGeo, setLgasGeo] = useState(null)
  const [burden, setBurden] = useState(null)
  const [hover, setHover] = useState(null)
  const [view, setView] = useState(NIGERIA)
  const [cardSort, setCardSort] = useState('zone')
  const [scope, setScope] = useState('states')
  const [selState, setSelState] = useState(null)
  const [selKey, setSelKey] = useState(null)
  const [monthIdx, setMonthIdx] = useState(0)

  useEffect(() => {
    fetch(`${BASE}data/geo/states.geojson`).then(r => r.json()).then(setStatesGeo).catch(() => {})
    fetch(`${BASE}data/geo/lgas.geojson`).then(r => r.json()).then(setLgasGeo).catch(() => {})
  }, [])
  useEffect(() => {
    setBurden(null)
    fetch(`${BASE}data/${variant}/${disease}/burden.json`).then(r => r.json()).then(setBurden).catch(() => setBurden({ lgas: {}, states: {} }))
  }, [variant, disease])

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
  // default to the most recent ACTUAL month (mirrors malaria's own pattern
  // below) -- forecast months are there to step into, not the default view.
  useEffect(() => {
    if (hasHistory) { let i = months.length - 1; while (i > 0 && months[i].forecast) i--; setMonthIdx(i) }
  }, [hasHistory, months.length])
  const curMonth = months[monthIdx] || null

  const scoreFor = key => {
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
        updateTriggers: { getFillColor: monthIdx },
        onClick: info => info.object && drillInto(info.object.properties.st),
        onHover: info => setHover(info.object ? { ...info, kind: 'state' } : null) })]
    }
    if (!lgasGeo) return []
    const dat = selState ? { ...lgasGeo, features: lgasGeo.features.filter(f => f.properties.st === selState) } : lgasGeo
    const fillFor = key => { const z = ZONES[zoneFor(key)]; return [...z.fill, z.a] }
    return [new GeoJsonLayer({ id: 'lgas-static', data: dat, pickable: true, stroked: true, filled: true,
      getFillColor: f => fillFor(`${f.properties.st}|||${f.properties.lga}`), getLineColor: [255, 255, 255], lineWidthMinPixels: 0.4,
      updateTriggers: { getFillColor: monthIdx },
      onClick: info => info.object && setSelKey(`${info.object.properties.st}|||${info.object.properties.lga}`),
      onHover: info => setHover(info.object ? { ...info, kind: 'lga' } : null) })]
  }, [scope, statesGeo, lgasGeo, selState, lgaMap, stateMap, monthIdx])

  const dist = useMemo(() => {
    const d = {}; ZONE_ORDER.forEach(z => { d[z] = 0 })
    if (scope === 'states') {
      Object.keys(stateMap).forEach(k => { d[zoneFor(k)]++ })
    } else {
      Object.keys(lgaMap).filter(k => !selState || k.split('|||')[0] === selState).forEach(k => { d[zoneFor(k)]++ })
    }
    return d
  }, [lgaMap, stateMap, scope, selState, monthIdx])

  const cards = useMemo(() => {
    if (scope === 'states') {
      const arr = Object.entries(stateMap).map(([key, v]) => {
        const score = scoreFor(key)
        return { key, state: key, lga: null, ...v, burden_score: score, canonZone: scoreToZone(score ?? 0) }
      })
      if (cardSort === 'value') arr.sort((a, b) => (b.value || 0) - (a.value || 0))
      else arr.sort((a, b) => (b.burden_score || 0) - (a.burden_score || 0))
      return arr
    }
    const arr = Object.entries(lgaMap).filter(([key]) => !selState || key.split('|||')[0] === selState).map(([key, v]) => {
      const [state, lga] = key.split('|||')
      const score = scoreFor(key)
      return { key, state, lga, ...v, burden_score: score, canonZone: scoreToZone(score ?? 0) }
    })
    if (cardSort === 'value') arr.sort((a, b) => (b.value || 0) - (a.value || 0))
    else arr.sort((a, b) => (b.burden_score || 0) - (a.burden_score || 0))
    return arr
  }, [lgaMap, stateMap, cardSort, scope, selState, monthIdx])

  const ready = scope === 'states' ? !!statesGeo : !!lgasGeo
  const sel = selKey ? (scope === 'states' ? stateMap[selKey] : lgaMap[selKey]) : null
  const hasStateHistory = !!(history && history.states && Object.keys(history.states).length)
  const hotCount = (dist['Red'] || 0) + (dist['Amber'] || 0)
  const unitCount = scope === 'states' ? Object.keys(stateMap).length : Object.keys(lgaMap).filter(k => !selState || k.split('|||')[0] === selState).length

  return (
    <>
      <div className="view-head">
        <h2>{label} — Hotspot Map
          <InfoTip w={320} title="What this map shows" text={`Every Nigerian ${scope === 'states' ? 'state' : 'LGA'} coloured by ${label.toLowerCase()} burden, from the latest available reported snapshot in the warehouse. This is a precomputed score (no live levers — no driver/intervention data exists yet for this disease).`} />
        </h2>
        <p>Zones come from a precomputed burden score (case volume + trend). Ranked by <b>{rankByLabel || (hasScore ? 'Hotspot Score' : 'Case Volume Rank')}</b>{!hasScore && ' — this disease has no modelled risk score, so areas are ranked by reported case volume instead.'}</p>
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
              <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '1px', color: '#64798a', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
                Time period
                <InfoTip w={300} title="Actual + forecast months" text="Steps through actually-reported months in the warehouse, plus a SARIMAX-forecast tail computed per LGA from that LGA's own monthly history. LGAs with too little real history (under 12 reported months) are left out of the forecast tail rather than extrapolated from too little signal." />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '1.3rem', fontWeight: 600, color: '#0f2230' }}>{curMonth?.label || '—'}</span>
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

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 16 }}>
        {ZONE_ORDER.map(z => (
          <div key={z} className="card" style={{ flex: 1, minWidth: 92, padding: '12px 14px', position: 'relative', overflow: 'visible' }}>
            <div className="accent-bar" style={{ background: ZONES[z].c, borderRadius: 'var(--r) 0 0 var(--r)' }} />
            <div style={{ fontSize: '.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: ZONES[z].t, display: 'flex', alignItems: 'center' }}>
              {z}<InfoTip text={ZONE_INFO[z]} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', color: '#0f2230', marginTop: 4 }}>{dist[z] || 0}</div>
          </div>
        ))}
      </div>

      <Card title={<span>Nigeria — {label} hotspot zones, {scope === 'states' ? 'all states' : (selState ? `${selState} LGAs` : 'all LGAs')}<InfoTip w={300} text={`Click any ${scope === 'states' ? 'state to drill into its LGAs' : 'LGA to see its precomputed score and source data below'}.`} /></span>}
        sub={`Hotspots (Red+Amber): ${hotCount} of ${unitCount} ${scope === 'states' ? 'states' : 'LGAs'}`}
        right={<span className="chip dot">{unitCount} {scope === 'states' ? 'states' : 'LGAs'}</span>}>
        <div style={{ position: 'relative', height: 520, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {!ready && <div className="loading" style={{ height: '100%' }}><div className="spinner" />Loading map…</div>}
          {ready && (
            <DeckGL viewState={view} controller={true} layers={layers} onViewStateChange={e => setView(e.viewState)} style={{ position: 'absolute', inset: 0 }}>
              <Map mapStyle={CARTO} />
            </DeckGL>
          )}
          {hover?.object && (() => {
            if (hover.kind === 'state') {
              const key = hover.object.properties.st
              const v = stateMap[key]; if (!v) return null
              const z = zoneFor(key)
              const score = scoreFor(key)
              return (
                <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: '#fff', border: '1px solid #d7e1e8',
                  borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, color: '#0f2230', marginBottom: 4 }}>{key}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <ZoneChip zone={z} /><span style={{ fontFamily: 'var(--mono)', color: '#3c5366' }}>{(score ?? 0).toFixed(1)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: '.68rem' }}>value {n0(v.value)} (summed across LGAs){hasHistory && curMonth ? ` · ${curMonth.label}` : ''}</div>
                </div>
              )
            }
            const key = `${hover.object.properties.st}|||${hover.object.properties.lga}`
            const v = lgaMap[key]; if (!v) return null
            const z = zoneFor(key)
            const score = scoreFor(key)
            return (
              <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: '#fff', border: '1px solid #d7e1e8',
                borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                <div style={{ fontWeight: 700, color: '#0f2230', marginBottom: 4 }}>{hover.object.properties.lga}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <ZoneChip zone={z} /><span style={{ fontFamily: 'var(--mono)', color: '#3c5366' }}>{(score ?? 0).toFixed(1)}</span>
                </div>
                <div className="muted" style={{ fontSize: '.68rem' }}>value {n0(v.value)} · source zone "{v.zone || '—'}"{hasHistory && curMonth ? ` · ${curMonth.label}` : ''}</div>
              </div>
            )
          })()}
          <div style={{ position: 'absolute', left: 12, bottom: 12, background: 'rgba(255,255,255,.93)', borderRadius: 8, padding: '8px 11px', fontSize: '.68rem', color: '#3c5366', boxShadow: '0 2px 10px rgba(0,0,0,.08)' }}>
            <div style={{ fontWeight: 700, marginBottom: 5 }}>Hotspot zone</div>
            {ZONE_ORDER.map(z => (<div key={z} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: ZONES[z].c }} />{z}</div>))}
          </div>
        </div>
      </Card>

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

      <Card style={{ marginTop: 18 }} title={scope === 'states' ? 'States — by burden' : 'LGAs — by burden'}
        right={<div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {[['zone', 'By burden'], ['value', 'By value']].map(([k, lbl]) => (
            <button key={k} onClick={() => setCardSort(k)} style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 6, fontSize: '.76rem', fontWeight: 600, fontFamily: 'var(--font)',
              background: cardSort === k ? 'var(--bg-1)' : 'transparent', color: cardSort === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>))}
        </div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
          {cards.slice(0, 200).map(c => (
            <div key={c.key} onClick={() => setSelKey(c.key)} style={{ cursor: 'pointer',
              border: selKey === c.key ? `2px solid ${ZONES[c.canonZone].c}` : '1px solid var(--border)', borderRadius: 10, padding: '11px 13px',
              borderLeft: `4px solid ${ZONES[c.canonZone].c}`, background: 'var(--bg-1)' }}>
              <div style={{ fontWeight: 700, fontSize: '.84rem', color: '#0f2230', marginBottom: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lga || c.state}</div>
              {c.lga && <div style={{ fontSize: '.7rem', color: '#64798a', marginBottom: 6 }}>{c.state}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><ZoneChip zone={c.canonZone} /></div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '.78rem', color: '#3c5366', marginTop: 8 }}>
                value {n0(c.value)} · burden <b style={{ color: ZONES[c.canonZone].t }}>{(c.burden_score ?? 0).toFixed(1)}</b>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

export default function VisualOverview({ data, variant = 'after', allLgas = false, disease = 'malaria' }) {
  if (disease !== 'malaria') {
    const label = data?.meta?.label || disease
    return <StaticZoneMap disease={disease} label={label} variant={variant} />
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
  const [cardSort, setCardSort] = useState('zone')
  const [selKey, setSelKey] = useState(null)

  useEffect(() => {
    fetch(`${BASE}data/geo/states.geojson`).then(r => r.json()).then(setStatesGeo).catch(() => {})
    fetch(`${BASE}data/geo/lgas.geojson`).then(r => r.json()).then(setLgasGeo).catch(() => {})
  }, [])
  useEffect(() => { setBurden(null); fetch(`${BASE}data/${variant}/burden.json`).then(r => r.json()).then(setBurden).catch(() => {}) }, [variant])

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
      return fs.map(f => { const k = `${f.properties.st}|||${f.properties.lga}`; return { key: k, name: f.properties.lga, st: f.properties.st, x: inputsFor(burden.lgas, k) } }).filter(u => u.x)
    }
    return []
  }, [burden, scope, statesGeo, lgasGeo, selState, monthIdx])

  const unitMap = useMemo(() => Object.fromEntries(units.map(u => [u.key, u])), [units])
  const peerAvg = useMemo(() => units.length ? units.reduce((a, u) => a + (u.x.cases || 0), 0) / units.length : 0, [units])
  const flags = burden?.flags || {}
  const baseZ = useMemo(() => buildZones(units, peerAvg, flags), [units, peerAvg, flags])
  const scenZ = useMemo(() => buildZones(units.map(u => ({ key: u.key, x: applyLevers(u.x, vals) })), peerAvg, flags), [units, peerAvg, vals, flags])
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
    return o
  }, [burden, scope, selState, monthIdx, statesGeo])

  const colorVer = useMemo(() => JSON.stringify(vals) + scope + (selState || '') + monthIdx, [vals, scope, selState, monthIdx])

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
        getFillColor: f => fillFor(`${f.properties.st}|||${f.properties.lga}`), getLineColor: [255,255,255], lineWidthMinPixels: 0.4,
        updateTriggers: { getFillColor: colorVer },
        onClick: info => info.object && setSelKey(`${info.object.properties.st}|||${info.object.properties.lga}`),
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
  const reset = () => setVals(Object.fromEntries(LEVERS.map(l => [l.id, 0])))
  const scaleUp = () => setVals({ rain: -30, temp: 0, hum: -20, act: 60, llin: 80 })

  const dist = useMemo(() => {
    const d = { base: {}, scen: {} }; ZONE_ORDER.forEach(z => { d.base[z] = 0; d.scen[z] = 0 })
    units.forEach(u => { d.base[baseZ[u.key]?.zone]++; d.scen[dispZ[u.key]?.zone]++ })
    return d
  }, [units, baseZ, dispZ])

  const cards = useMemo(() => {
    const arr = units.map(u => {
      const b = baseZ[u.key] || { display: 0, zone: 'Not a Hotspot' }
      const s = dispZ[u.key] || { display: 0, zone: 'Not a Hotspot' }
      return { name: u.name, key: u.key, base: b, scen: s, delta: s.display - b.display }
    })
    if (cardSort === 'change') arr.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.scen.display - a.scen.display)
    else arr.sort((a, b) => b.scen.display - a.scen.display)
    return arr
  }, [units, baseZ, dispZ, cardSort])

  useEffect(() => { if (cards.length && (!selKey || !unitMap[selKey])) setSelKey(cards[0].key) }, [cards, unitMap])

  const hotBase = (dist.base['Red'] || 0) + (dist.base['Amber'] || 0)
  const hotScen = (dist.scen['Red'] || 0) + (dist.scen['Amber'] || 0)
  const ready = (scope === 'states' && statesGeo) || (scope === 'lgas' && lgasGeo)
  const cats = [...new Set(LEVERS.map(l => l.cat))]
  const cardCap = allLgas ? 150 : 9999

  const sel = selKey && unitMap[selKey] ? unitMap[selKey] : null
  const selScenX = sel ? (showLevers ? applyLevers(sel.x, vals) : sel.x) : null
  const selDetail = sel ? scoreDetail(selScenX, peerAvg, flags) : null
  const selZ = sel ? dispZ[sel.key] : null
  const selBaseZ = sel ? baseZ[sel.key] : null

  return (
    <>
      <div className="view-head">
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
            <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '1px', color: '#64798a', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
              Time period
              <InfoTip w={300} title="Actual vs forecast"
                text="The data is monthly. This slider picks which month the map shows. Months up to Dec 2025 are ACTUAL reported data; 2026 months are a FORECAST built from the typical seasonal pattern. Notice how the hotspots grow in the rainy season (Jun–Oct) and ease in the dry months." />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: '1.3rem', fontWeight: 600, color: '#0f2230' }}>{curMonth.label}</span>
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
          <div style={{ fontSize: '.72rem', color: '#64798a', maxWidth: 230, lineHeight: 1.5 }}>
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
            {cats.map(cat => (
              <div key={cat}>
                <div className="cat-label">{cat}</div>
                {LEVERS.filter(l => l.cat === cat).map(l => {
                  const pct = vals[l.id] || 0
                  const baseV = scopeBaseline[l.field] || 0
                  let scenV = baseV * (1 + pct / 100)
                  if (l.field === 'temp') scenV = cl(scenV, 15, 45)
                  if (l.field === 'hum') scenV = cl(scenV, 0, 100)
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
          </Card>
        )}

        {/* ── map + KPIs ── */}
        <div className="col" style={{ flex: showLevers ? 2 : 1, minWidth: 460, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!showLevers && (
            <Card style={{ background: 'rgba(13,148,136,.07)', border: '1px solid rgba(13,148,136,.3)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '.84rem', color: '#0f2230', lineHeight: 1.6 }}>
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
                <div style={{ fontFamily: 'var(--mono)', fontSize: '1.5rem', color: '#0f2230', marginTop: 4 }}>{dist.scen[z] || 0}</div>
                {(dist.scen[z] || 0) !== (dist.base[z] || 0) && (
                  <div style={{ fontSize: '.68rem', fontWeight: 600, color: (dist.scen[z] - dist.base[z]) < 0 ? COLORS.green : COLORS.coral }}>
                    {(dist.scen[z] - dist.base[z]) > 0 ? '+' : ''}{dist.scen[z] - dist.base[z]} vs base
                  </div>
                )}
              </div>
            ))}
          </div>

          <Card
            title={<span>{scope === 'states' ? 'Nigeria — hotspot zones by state' : (allLgas ? 'Nigeria — all LGAs' : `${selState} — hotspot zones by LGA`)} · {curMonth.label}
              <InfoTip w={300} text={scope === 'states' ? 'Click a state to drill into its LGAs. Hover any area for its score.' : 'Click any LGA to see exactly how its score was calculated, in the panel below.'} /></span>}
            sub={`Hotspots (Red+Amber): ${hotScen} of ${units.length}${hotScen !== hotBase ? `  ·  was ${hotBase} before levers` : ''}`}
            right={(scope === 'lgas' && !allLgas) ? <button className="btn" onClick={backToStates}>← All states</button> : <span className="chip dot">{allLgas ? `${units.length} LGAs` : '37 states'}</span>}>
            <div style={{ position: 'relative', height: 520, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)' }}>
              {!ready && <div className="loading" style={{ height: '100%' }}><div className="spinner" />Loading map…</div>}
              {ready && (
                <DeckGL viewState={view} controller={true} layers={layers} onViewStateChange={e => setView(e.viewState)} style={{ position: 'absolute', inset: 0 }}>
                  <Map mapStyle={CARTO} />
                </DeckGL>
              )}
              {hover?.object && (() => {
                const key = hover.kind === 'state' ? hover.object.properties.st : `${hover.object.properties.st}|||${hover.object.properties.lga}`
                const b = baseZ[key], s = dispZ[key]; if (!s) return null
                return (
                  <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: '#fff', border: '1px solid #d7e1e8',
                    borderRadius: 8, padding: '9px 12px', fontSize: '.76rem', boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 160 }}>
                    <div style={{ fontWeight: 700, color: '#0f2230', marginBottom: 4 }}>{hover.kind === 'state' ? hover.object.properties.st : hover.object.properties.lga}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <ZoneChip zone={s.zone} /><span style={{ fontFamily: 'var(--mono)', color: '#3c5366' }}>{s.display.toFixed(1)}</span>
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
              <div style={{ position: 'absolute', left: 12, bottom: 12, background: 'rgba(255,255,255,.93)', borderRadius: 8, padding: '8px 11px', fontSize: '.68rem', color: '#3c5366', boxShadow: '0 2px 10px rgba(0,0,0,.08)' }}>
                <div style={{ fontWeight: 700, marginBottom: 5, display: 'flex', alignItems: 'center' }}>Hotspot zone<InfoTip text="Colour = severity. Red is worst, grey means not a hotspot. Based on the burden score for the selected month." /></div>
                {ZONE_ORDER.map(z => (<div key={z} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: ZONES[z].c }} />{z}</div>))}
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* ── CALCULATION BREAKDOWN ── */}
      {sel && selDetail && selZ && (
        <Card style={{ marginTop: 18 }}
          title={<span>How {sel.name}'s burden score was calculated · {curMonth.label}
            <InfoTip w={320} title="Plain English" text="The score (0–100) adds up weighted points from disease load, transmission risk, weather and protection gaps. Then it’s rank-blended against all other areas and turned into a colour zone. Everything below is that exact maths, using this area’s numbers for the selected month." /></span>}
          sub={`${curMonth.forecast ? 'Forecast month' : 'Actual data'} · scenario inputs (after levers) feed the same formula`}>
          <div className="row" style={{ gap: 16 }}>
            <div className="col" style={{ minWidth: 260, flex: 1 }}>
              <div className="cat-label">Step 0 · Indicator inputs (baseline → scenario)<InfoTip text="The raw monthly numbers for this area. If you moved a lever, the arrow shows the new value." /></div>
              <table className="data" style={{ fontSize: '.8rem' }}>
                <tbody>
                  {[['Confirmed cases/mo', 'cases'], ['Total reported/mo', 'total'], ['Case trend ratio', 'trend'], ['Rainfall (mm/day)', 'rain'],
                    ['Temperature (°C)', 'temp'], ['Humidity (%)', 'hum'], ['ACT given/mo', 'act'], ['LLIN nets/mo', 'llin']].map(([lbl, f]) => {
                    const bv = sel.x[f] || 0, sv = selScenX[f] || 0, chg = Math.abs(sv - bv) > 1e-6
                    return (<tr key={f}><td>{lbl}</td><td className="num">{f === 'trend' ? bv.toFixed(2) : n0(bv)}</td>
                      <td className="num" style={{ color: chg ? COLORS.accent : '#94a8b6' }}>{chg ? '→ ' + (f === 'trend' ? sv.toFixed(2) : n0(sv)) : ''}</td></tr>)
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
                      <td className="mono" style={{ fontSize: '.7rem', color: '#64798a' }}>{r.subst}</td>
                      <td className="num">{r.sub.toFixed(2)}</td>
                      <td className="num" style={{ color: COLORS.accent }}>{r.points.toFixed(1)}<span className="muted" style={{ fontSize: '.62rem' }}>/{r.w}</span></td></tr>
                  ))}
                  <tr style={{ background: '#f3f9f8' }}><td colSpan={3}><b>Raw burden = sum of points</b></td><td className="num"><b>{selDetail.raw.toFixed(1)}</b></td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="method-section" style={{ marginTop: 14, background: '#f8fbfd', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
            <div className="cat-label" style={{ marginTop: 0 }}>Step 2 · Percentile blend vs all {selZ.n} {scope === 'states' ? 'states' : 'LGAs'} → Step 3 · Zone
              <InfoTip w={320} text="A high raw score isn’t enough on its own — we also rank this area against all others (60% weight) and blend with its own raw score (40%). That spread-out number is matched to a colour zone." /></div>
            <p style={{ fontSize: '.82rem', lineHeight: 1.8, margin: '6px 0 0' }}>
              Ranked <b>#{selZ.rankPos} of {selZ.n}</b> by raw burden → rank_pct = <b>{(selZ.rankPct).toFixed(3)}</b><br />
              <code>rank_term = 0.60 × {(selZ.rankPct).toFixed(3)} = {selZ.rankTerm.toFixed(3)}</code><br />
              <code>raw_term&nbsp; = 0.40 × ({selDetail.raw.toFixed(1)} ÷ 100) = {selZ.rawTerm.toFixed(3)}</code><br />
              <code>display&nbsp;&nbsp; = (rank_term + raw_term) × 100 = <b style={{ color: ZONES[selZ.zone].t }}>{selZ.display.toFixed(1)}</b></code><br />
              <span style={{ marginTop: 4, display: 'inline-block' }}>Thresholds: &lt;18 None · &lt;38 Green · &lt;58 Yellow · &lt;78 Amber · ≥78 Red →{' '}
                <b style={{ color: ZONES[selZ.zone].t }}>{selZ.display.toFixed(1)} → {selZ.zone}</b>
                {selBaseZ && selBaseZ.zone !== selZ.zone && <> (baseline was <ZoneChip zone={selBaseZ.zone} /> at {selBaseZ.display.toFixed(1)})</>}
              </span>
            </p>
          </div>
        </Card>
      )}

      {/* ── cards ── */}
      <Card style={{ marginTop: 18 }}
        title={<span>{scope === 'states' ? 'States' : (allLgas ? 'All LGAs' : selState + ' LGAs')} — click any to see its calculation
          <InfoTip text="Each card shows an area’s zone before → after your levers, and its burden number. Click one to load its full maths above." /></span>}
        sub={`Baseline zone → scenario zone · ${curMonth.label}${allLgas && cards.length > cardCap ? ` · showing top ${cardCap} of ${cards.length}` : ''}`}
        right={<div style={{ display: 'inline-flex', background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {[['zone', 'By burden'], ['change', 'By change']].map(([k, lbl]) => (
            <button key={k} onClick={() => setCardSort(k)} style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 6, fontSize: '.76rem', fontWeight: 600, fontFamily: 'var(--font)',
              background: cardSort === k ? 'var(--bg-1)' : 'transparent', color: cardSort === k ? 'var(--accent)' : 'var(--txt-2)' }}>{lbl}</button>))}
        </div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
          {cards.slice(0, cardCap).map(c => (
            <div key={c.key} onClick={() => setSelKey(c.key)} style={{ cursor: 'pointer',
              border: selKey === c.key ? `2px solid ${ZONES[c.scen.zone].c}` : '1px solid var(--border)', borderRadius: 10, padding: '11px 13px',
              borderLeft: `4px solid ${ZONES[c.scen.zone].c}`, background: 'var(--bg-1)' }}>
              <div style={{ fontWeight: 700, fontSize: '.84rem', color: '#0f2230', marginBottom: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <ZoneChip zone={c.base.zone} /><span style={{ color: '#94a8b6' }}>→</span><ZoneChip zone={c.scen.zone} />
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '.78rem', color: '#3c5366', marginTop: 8 }}>
                burden {c.base.display.toFixed(1)} → <b style={{ color: ZONES[c.scen.zone].t }}>{c.scen.display.toFixed(1)}</b>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}
