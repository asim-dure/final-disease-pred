import React, { useState, useEffect, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Treemap,
} from 'recharts'
import { LayoutDashboard, Users, MapPin, Activity, AlertTriangle, ShieldCheck, Target, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import {
  C, fmt, withForecastSplit, Card, KPICard, CustomTooltip, Select, MultiSelectDropdown, LocationTreeFilter,
  RiskMap, ZONE_ORDER, ZONE_COLORS, ZONE_LABELS, STATE_GRID, REGIONS_META, MONTH_ABBR,
} from './ManagerDashboard'

// Generic Command Overview for every "thin" disease -- one real target-
// variable indicator (a case-count forecast target) plus real Population/
// Population Density (same agg_lga_pop.parquet source, same rescale
// methodology as malaria/HIV, via export_ncd_ntd_drivers.py's drivers.json --
// so the same state/month reads the identical population figure on every
// disease's dashboard, not a different number each time).
// Same internal collapsible-sidebar shell + real TopBar filters (period
// mode, years, months, hotspot zone, location tree with north/south
// geopolitical-zone picking) as HivManagerDashboard.jsx -- there is no
// shared global stylesheet or filter component for these, so both are
// mirrored locally exactly like that file already does for HIV.
const BASE = import.meta.env.BASE_URL || '/'
const REGION_COLORS = { NW: '#38BDF8', NC: '#818CF8', NE: '#A78BFA', SW: '#F472B6', SE: '#FB923C', SS: '#34D399' }
const INK = '#0f2230'
const DEFAULT_FILTERS = { periodMode: 'month', monthIdx: null, years: [], months: [], locations: [], region: 'All', lgas: [], category: 'All' }

const sum = a => a.reduce((s, v) => s + (v || 0), 0)

function SourceLine({ children }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${C.border}`, fontSize: 10.5, color: C.textFaint, lineHeight: 1.5 }}>
      <b style={{ color: C.textDim }}>Source: </b>{children}
    </div>
  )
}

function Sidebar({ label, collapsed, onToggle }) {
  return (
    <div className={`sidebar ${collapsed ? 'sidebarCollapsed' : ''}`}>
      <div className="brand">
        <div className="brandMark" style={{ background: `linear-gradient(135deg, ${C.teal}, ${C.azure})` }}><LayoutDashboard size={17} color="#ffffff" strokeWidth={2.6} /></div>
        {!collapsed && <div style={{ flex: 1, minWidth: 0 }}><div className="brandTitle">{label}</div><div className="brandSub">Predictive Analytics</div></div>}
        <button className="sidebarToggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} color={C.textDim} /> : <PanelLeftClose size={16} color={C.textDim} />}
        </button>
      </div>
      <div className="navList">
        <button className="navItem navItemActive" title={collapsed ? 'Command Overview' : undefined}>
          <LayoutDashboard size={16} strokeWidth={2.1} color={C.teal} />
          {!collapsed && <span>Command Overview</span>}{!collapsed && <span className="navDot" />}
        </button>
      </div>
    </div>
  )
}

function useThinData(disease, variant) {
  const [burden, setBurden] = useState(null)
  const [national, setNational] = useState(null)
  const [states, setStates] = useState(null)
  const [drivers, setDrivers] = useState(null)
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    setBurden(null); setNational(null); setStates(null); setDrivers(null); setMeta(null)
    const j = f => fetch(`${BASE}data/${variant}/${disease}/${f}`).then(r => r.json())
    j('burden.json').then(setBurden).catch(() => setBurden({ history: null, states: {}, lgas: {} }))
    j('national.json').then(setNational).catch(() => setNational([]))
    j('states.json').then(setStates).catch(() => setStates({}))
    j('drivers.json').then(setDrivers).catch(() => setDrivers(null))
    j('meta.json').then(setMeta).catch(() => setMeta(null))
  }, [disease, variant])

  return { burden, national, states, drivers, meta }
}

// One real-value snapshot per state/LGA for the CURRENTLY selected month,
// built from burden.json's history (the same precomputed burden_score/zone/
// value arrays the What-If Simulation map reads) -- mirrors HIV's
// useHivModel exactly, just with ONE real field (`cases`) instead of HIV's
// dozens of NDARS indicators.
function useThinModel(burden, monthIdx) {
  return useMemo(() => {
    const months = burden?.history?.months
    if (!months?.length) return null
    const idx = Math.min(monthIdx ?? months.length - 1, months.length - 1)
    const fcIdx = months.findIndex(m => m.forecast)
    const lastIdx = fcIdx > 0 ? fcIdx - 1 : (fcIdx === 0 ? 0 : months.length - 1)
    const points = STATE_GRID.filter(s => burden.history.states[s.key]).map(s => {
      const st = burden.history.states[s.key]
      const zone = st.zone[idx] || 'Not a Hotspot'
      return { key: s.key, name: s.name, region: s.region, score: st.burden_score[idx], zone, dominant: zone, cases: st.value[idx] }
    })
    const lgaZones = {}
    Object.entries(burden.history.lgas || {}).forEach(([key, v]) => { lgaZones[key] = { zone: v.zone[idx], display: v.burden_score[idx] } })
    return { months, lastIdx, idx, points, lgaZones, selectedLabel: months[idx]?.label, selectedForecast: months[idx]?.forecast, latestLabel: months[lastIdx]?.label }
  }, [burden, monthIdx])
}

// Scoped monthly/yearly case-count series (location + zone + period-mode
// filtered) built from national.json/states.json -- the same real reported
// + SARIMAX-forecast rows the What-If Simulation tab's own chart reads.
function useThinScopedSeries(national, states, filters, M) {
  return useMemo(() => {
    if (!national) return { series: [], monthlySeries: [], label: 'Nigeria (national)' }
    const regionName = REGIONS_META.find(r => r.code === filters.region)?.name
    const catFilter = filters.category !== 'All' ? filters.category : null
    const sumStates = names => {
      const byDate = {}
      names.forEach(name => (states?.[name] || []).forEach(row => {
        byDate[row.date] = byDate[row.date] || { date: row.date, cases: 0, forecast: row.forecast }
        byDate[row.date].cases += row.cases || 0
      }))
      return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
    }

    let monthlySeries, label
    if (filters.locations.length) {
      monthlySeries = sumStates(filters.locations)
      label = filters.locations.join(', ')
    } else {
      const dominantByState = Object.fromEntries((M?.points || []).map(p => [p.name, p.dominant]))
      const matches = STATE_GRID.filter(s => (filters.region === 'All' || s.region === filters.region) && states?.[s.name] &&
        (!catFilter || dominantByState[s.name] === catFilter))
      if (filters.region !== 'All' || catFilter) {
        monthlySeries = sumStates(matches.map(s => s.name))
        label = catFilter ? `${catFilter}-zone states${filters.region !== 'All' ? ` in ${regionName}` : ''}` : regionName
      } else {
        monthlySeries = national
        label = 'Nigeria (national)'
      }
    }

    let series = monthlySeries
    if (filters.periodMode === 'year') {
      const allYears = [...new Set(monthlySeries.map(d => +d.date.split('-')[0]))].sort((a, b) => a - b)
      let yearsToUse = (filters.years?.length ? filters.years : allYears.slice(-1)).slice().sort((a, b) => a - b)
      if (yearsToUse.length === 1) {
        const y = yearsToUse[0], yi = allYears.indexOf(y)
        const neighbor = yi > 0 ? allYears[yi - 1] : allYears[yi + 1]
        if (neighbor != null) yearsToUse = [...yearsToUse, neighbor].sort((a, b) => a - b)
      }
      series = yearsToUse.map(y => {
        const rows = monthlySeries.filter(d => +d.date.split('-')[0] === y)
        return { date: String(y), cases: sum(rows.map(r => r.cases)), forecast: rows.some(r => r.forecast) }
      })
    } else if (filters.months?.length) {
      const dateSet = new Set(filters.months.map(i => M?.months?.[i]?.ym).filter(Boolean))
      series = monthlySeries.filter(d => dateSet.has(d.date))
    } else if (filters.years?.length) {
      series = monthlySeries.filter(d => filters.years.includes(+d.date.split('-')[0]))
    }
    return { series, monthlySeries, label }
  }, [national, states, filters.locations, filters.region, filters.category, filters.periodMode, filters.years, filters.months, M])
}

function SelectionBanner({ filters, months, lastIdx }) {
  const monthIdx = filters.monthIdx ?? lastIdx
  const cur = months[monthIdx]
  const monthRestrictLabel = filters.months.length
    ? `SHOWING ${filters.months.length} SELECTED MONTH${filters.months.length > 1 ? 'S' : ''} ONLY`
    : (filters.years.length ? `SHOWING ${filters.years.slice().sort((a, b) => a - b).join(', ')} ONLY` : '')
  const timeLabel = filters.periodMode === 'year'
    ? (filters.years.length ? `${filters.years.slice().sort((a, b) => a - b).join(', ')} (COMBINED)` : 'ALL YEARS')
    : ((cur ? cur.label.toUpperCase() + (cur.forecast ? ' (FORECAST)' : '') : '—') + (monthRestrictLabel ? ` · ${monthRestrictLabel}` : ''))
  const locLabel = filters.lgas.length === 1 ? `${filters.lgas[0].split('|||')[1]}, ${filters.lgas[0].split('|||')[0]}`
    : filters.lgas.length ? filters.lgas.map(k => k.split('|||')[1]).join(', ')
    : filters.locations.length ? filters.locations.join(', ')
    : filters.region !== 'All' ? (REGIONS_META.find(r => r.code === filters.region)?.name || filters.region)
    : 'NIGERIA (NATIONAL)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, fontWeight: 700, letterSpacing: '.3px', color: C.tealLight,
      background: `${C.teal}0f`, border: `1px solid ${C.teal}33`, borderRadius: 8, padding: '7px 12px', marginBottom: 16 }}>
      <Target size={13} strokeWidth={2.4} />
      <span>VIEWING: {locLabel.toUpperCase()}</span>
      <span style={{ color: C.border }}>·</span>
      <span>{timeLabel}</span>
      {filters.category !== 'All' && (<><span style={{ color: C.border }}>·</span><span>{filters.category.toUpperCase()} ZONE ONLY</span></>)}
    </div>
  )
}

function TopBar({ title, subtitle, filters, setFilters, burden, months, lastIdx }) {
  const years = [...new Set(months.map(m => +m.ym.split('-')[0]))].sort((a, b) => a - b)
  const isDefault = !filters.locations.length && filters.region === 'All' && !filters.lgas.length && filters.category === 'All' &&
    filters.periodMode === 'month' && filters.monthIdx === lastIdx && !filters.years.length && !filters.months.length
  const resetAll = () => setFilters({ ...DEFAULT_FILTERS, monthIdx: lastIdx })

  const monthOptions = months.map((m, i) => ({ i, y: +m.ym.split('-')[0], mo: +m.ym.split('-')[1] })).filter(m => !filters.years.length || filters.years.includes(m.y))

  const toggleYear = y => setFilters(f => {
    const has = f.years.includes(y)
    const next = has ? f.years.filter(x => x !== y) : [...f.years, y]
    const years2 = (f.periodMode === 'year' && !next.length) ? f.years : next
    if (f.periodMode === 'month' && years2.length) {
      const months2 = f.months.filter(i => years2.includes(+months[i].ym.split('-')[0]))
      const curY = months[f.monthIdx ?? lastIdx] ? +months[f.monthIdx ?? lastIdx].ym.split('-')[0] : null
      if (curY == null || !years2.includes(curY)) {
        const opts = months.map((m, i) => ({ i, y: +m.ym.split('-')[0] })).filter(m => years2.includes(m.y))
        if (opts.length) return { ...f, years: years2, months: months2, monthIdx: opts[opts.length - 1].i }
      }
      return { ...f, years: years2, months: months2 }
    }
    return { ...f, years: years2 }
  })
  const clearYears = () => setFilters(f => ({ ...f, years: [] }))
  const toggleMonth = i => setFilters(f => {
    const has = f.months.includes(i)
    const next = has ? f.months.filter(x => x !== i) : [...f.months, i]
    return { ...f, months: next, monthIdx: next.length ? Math.max(...next) : f.monthIdx }
  })
  const clearMonths = () => setFilters(f => ({ ...f, months: [] }))
  const switchMode = m => setFilters(f => ({ ...f, periodMode: m, years: (m === 'year' && !f.years.length) ? [years[years.length - 1]] : f.years }))

  return (
    <div className="topbar">
      <div><div className="topTitle">{title}</div>{subtitle && <div className="topSub">{subtitle}</div>}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button className="miqResetBtn" onClick={resetAll} disabled={isDefault} title="Reset every filter back to the national view, latest real month">↺ Reset</button>
        <label className="selectWrap">
          <span className="selectLabel">PERIOD MODE</span>
          <div style={{ display: 'inline-flex', background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 7, padding: 2 }}>
            {[['month', '📅 Month'], ['year', '🗓️ Year']].map(([m, lbl]) => (
              <button key={m} onClick={() => switchMode(m)} style={{ border: 'none', cursor: 'pointer', padding: '5px 9px', borderRadius: 5, fontSize: 11.5, fontWeight: 600,
                fontFamily: 'inherit', background: filters.periodMode === m ? C.panel : 'transparent', color: filters.periodMode === m ? C.teal : C.textDim }}>{lbl}</button>
            ))}
          </div>
        </label>
        {filters.periodMode === 'month' ? (
          <>
            <MultiSelectDropdown label="YEARS" options={years.map(y => ({ value: y, label: String(y) }))} selected={filters.years} onToggle={toggleYear} onClear={clearYears} />
            <MultiSelectDropdown label="MONTHS" searchable minWidth={110}
              options={monthOptions.map(m => ({ value: m.i, label: `${MONTH_ABBR[m.mo - 1]}${filters.years.length !== 1 ? ` '${String(m.y).slice(2)}` : ''}` }))}
              selected={filters.months} onToggle={toggleMonth} onClear={clearMonths} />
          </>
        ) : (
          <label className="selectWrap">
            <span className="selectLabel">YEARS (COMBINED)</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 280, padding: '2px 0' }}>
              {years.map(y => (
                <button key={y} onClick={() => toggleYear(y)} style={{ border: `1px solid ${filters.years.includes(y) ? C.teal : C.border}`, cursor: 'pointer', padding: '4px 9px', borderRadius: 20,
                  fontSize: 11, fontWeight: 700, fontFamily: 'inherit', background: filters.years.includes(y) ? `${C.teal}18` : C.panel, color: filters.years.includes(y) ? C.teal : C.textDim }}>{y}</button>
              ))}
            </div>
          </label>
        )}
        <Select label="HOTSPOT ZONE" value={filters.category} onChange={v => setFilters(f => ({ ...f, category: v }))} options={['All', ...ZONE_ORDER]} />
        <LocationTreeFilter filters={filters} setFilters={setFilters} burden={{ states: burden?.history?.states || {}, lgas: burden?.history?.lgas || {} }} />
      </div>
    </div>
  )
}

export default function ThinDiseaseDashboard({ disease, label, variant = 'after' }) {
  const [collapsed, setCollapsed] = useState(false)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const { burden, national, states, drivers, meta } = useThinData(disease, variant)

  useEffect(() => { setFilters(DEFAULT_FILTERS) }, [disease])

  const months = burden?.history?.months || []
  const fcIdx = months.findIndex(m => m.forecast)
  const lastIdx = fcIdx > 0 ? fcIdx - 1 : (fcIdx === 0 ? 0 : Math.max(0, months.length - 1))
  useEffect(() => { if (burden?.history && filters.monthIdx == null) setFilters(f => ({ ...f, monthIdx: lastIdx })) }, [burden])

  const effectiveMonthIdx = useMemo(() => {
    if (filters.periodMode === 'year') return lastIdx
    if (filters.months.length) return Math.max(...filters.months)
    if (filters.years.length) {
      const opts = months.map((m, i) => ({ i, y: +m.ym.split('-')[0] })).filter(m => filters.years.includes(m.y))
      return opts.length ? opts[opts.length - 1].i : lastIdx
    }
    return filters.monthIdx ?? lastIdx
  }, [filters.periodMode, filters.years, filters.months, filters.monthIdx, months, lastIdx])

  const M = useThinModel(burden, effectiveMonthIdx)
  const scoped = useThinScopedSeries(national, states, filters, M)

  const onMapSelect = name => setFilters(f => ({ ...f, locations: (f.locations.length === 1 && f.locations[0] === name) ? [] : [name], lgas: [] }))
  const onMapSelectLga = (stateName, lgaName) => setFilters(f => {
    const key = `${stateName}|||${lgaName}`
    return { ...f, lgas: (f.lgas.length === 1 && f.lgas[0] === key) ? [] : [key], locations: [] }
  })

  const trendSplit = useMemo(() => withForecastSplit(scoped.series, ['cases']), [scoped.series])
  const lastReal = [...scoped.series].reverse().find(r => !r.forecast) || {}

  // Real population/density for the current scope, from the SAME
  // drivers.json the What-If Simulation tab's levers use -- guarantees this
  // Dashboard and that tab always show the identical number for the same
  // state/month, and the identical number across every OTHER disease's own
  // dashboard too (all sourced from the same agg_lga_pop.parquet rescale).
  const popCtx = useMemo(() => {
    if (!drivers) return { population: null, density: null }
    if (filters.locations.length === 1) {
      const s = drivers.states[filters.locations[0]]
      return { population: s?.population?.base ?? null, density: s?.density?.base ?? null }
    }
    if (filters.locations.length > 1) {
      const pop = filters.locations.reduce((a, n) => a + (drivers.states[n]?.population?.base || 0), 0)
      return { population: pop, density: drivers.national?.density?.base ?? null }
    }
    return { population: drivers.national?.population?.base ?? null, density: drivers.national?.density?.base ?? null }
  }, [drivers, filters.locations])

  // Region treemap -- one tile per Nigeria geopolitical zone, sized by its
  // real hotspot state count for the selected month, same north/south
  // zonal pattern and click-to-filter behaviour as malaria/HIV's own region
  // treemap (ManagerDashboard/HivManagerDashboard don't export a shared
  // component for this, so it's mirrored locally like HIV's own copy is).
  const treeData = REGIONS_META.map(r => ({
    name: r.name, code: r.code,
    size: (M?.points || []).filter(p => p.region === r.code && p.zone && p.zone !== 'Not a Hotspot').length || 0.001,
    fill: REGION_COLORS[r.code],
  }))
  const scopedPoints = useMemo(() => (M?.points || []).filter(p =>
    (filters.region === 'All' || p.region === filters.region) && (!filters.locations.length || filters.locations.includes(p.name))
  ), [M, filters.region, filters.locations])

  // Real per-LGA zone counts for the current scope -- same "Red/Amber/
  // Yellow/Green Zone LGAs" KPI pattern malaria's own Command Overview uses
  // (ManagerDashboard.jsx's scopedRed/scopedAmber/scopedYellow/scopedGreen),
  // counting actual LGAs in each zone rather than just dominant STATE zones.
  const scopedZoneCounts = useMemo(() => {
    const counts = { Red: 0, Amber: 0, Yellow: 0, Green: 0 }
    if (!burden?.history?.lgas || M?.idx == null) return { ...counts, total: 0 }
    if (filters.lgas.length) {
      filters.lgas.forEach(key => {
        const z = burden.history.lgas[key]?.zone?.[M.idx]
        if (z && counts[z] != null) counts[z]++
      })
    } else {
      const stateSet = new Set(scopedPoints.map(p => p.name))
      Object.keys(burden.history.lgas).forEach(key => {
        if (!stateSet.has(key.split('|||')[0])) return
        const z = burden.history.lgas[key].zone?.[M.idx]
        if (z && counts[z] != null) counts[z]++
      })
    }
    return { ...counts, total: counts.Red + counts.Amber + counts.Yellow + counts.Green }
  }, [burden, M, filters.lgas, scopedPoints])

  // Cases by state -- the one location-wise breakdown this disease actually
  // has (no secondary indicator to chart), so it gets a full-width bar
  // instead of a small ranked list, sorted by the selected month's real
  // reported/forecast value.
  const stateBar = useMemo(() => [...(M?.points || [])].filter(p => p.cases != null).sort((a, b) => (b.cases || 0) - (a.cases || 0)), [M])

  // Same "Distribution of Hotspot LGAs by State & Zone" stacked bar malaria's
  // own Command Overview has -- per-state COUNT of LGAs in each hotspot zone
  // (Red/Amber/Yellow/Green) for the selected month, not case volume. Built
  // straight from burden.history.lgas' real per-LGA zone at the current
  // month index, grouped by state -- same source RiskMap/the region treemap
  // above already use, so this can never drift out of sync with the map.
  const stackData = useMemo(() => {
    if (!burden?.history?.lgas || M?.idx == null) return []
    const byState = {}
    Object.entries(burden.history.lgas).forEach(([key, v]) => {
      const stateName = key.split('|||')[0]
      byState[stateName] = byState[stateName] || { Red: 0, Amber: 0, Yellow: 0, Green: 0 }
      const z = v.zone?.[M.idx]
      if (z && byState[stateName][z] != null) byState[stateName][z]++
    })
    return Object.entries(byState)
      .map(([state, agg]) => ({ state, ...agg }))
      .filter(d => filters.category === 'All' || d[filters.category] > 0)
      .sort((a, b) => (b.Red - a.Red) || (b.Amber - a.Amber) || (b.Yellow - a.Yellow) || (b.Green - a.Green))
  }, [burden, M, filters.category])
  const zoneBars = filters.category === 'All'
    ? [['Red', C.red], ['Amber', C.amber], ['Yellow', C.yellow], ['Green', C.green]]
    : [[filters.category, ZONE_COLORS[filters.category]]]

  const meta_target = meta?.forecast_target || `${label} cases`

  if (!burden || !national || !states) {
    return <div className="loading"><div className="spinner" />Loading real {label} data…</div>
  }
  if (!M) {
    return (
      <div className="miq-root">
        <Sidebar label={label} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
        <div className="miqMain"><div style={{ padding: 60, textAlign: 'center', color: C.textDim }}>No monthly time series available for {label}.</div></div>
      </div>
    )
  }

  return (
    <div className="miq-root">
      <style>{`
        .miq-root { background: ${C.bg}; color: ${C.text}; font-family: 'IBM Plex Sans', system-ui, sans-serif; display: flex; height: calc(100vh - 132px); border-radius: 12px; overflow: hidden; }
        .miq-root * { box-sizing: border-box; }
        .miq-root button, .miq-root select, .miq-root input { font-family: inherit; }
        .miq-root .sidebar { width: 226px; flex-shrink: 0; background: ${C.panel2}; border-right: 1px solid ${C.border}; display: flex; flex-direction: column; padding: 18px 12px; transition: width 0.18s ease, padding 0.18s ease; }
        .miq-root .sidebarCollapsed { width: 62px; padding: 18px 8px; }
        .miq-root .sidebarCollapsed .brand { justify-content: center; padding: 6px 0 20px; }
        .miq-root .sidebarCollapsed .navItem { justify-content: center; padding: 9px 0; }
        .miq-root .sidebarToggle { margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: 1px solid ${C.border}; background: ${C.panel}; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
        .miq-root .sidebarCollapsed .sidebarToggle { margin-left: 0; }
        .miq-root .sidebarToggle:hover { background: ${C.panelAlt}; }
        .miq-root .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 20px; }
        .miq-root .brandMark { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .miq-root .brandTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
        .miq-root .brandSub { font-size: 10.5px; color: ${C.textFaint}; margin-top: 1px; }
        .miq-root .navList { display: flex; flex-direction: column; gap: 2px; flex: 1; }
        .miq-root .navItem { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; background: transparent; border: none; color: ${C.textDim}; font-size: 12.8px; text-align: left; cursor: pointer; position: relative; transition: background 0.15s; }
        .miq-root .navItem:hover { background: ${C.panelAlt}; color: ${C.text}; }
        .miq-root .navItemActive { background: linear-gradient(90deg, ${C.teal}33, transparent); color: ${C.text}; font-weight: 600; }
        .miq-root .navItemActive::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: ${C.tealLight}; }
        .miq-root .navDot { margin-left: auto; width: 5px; height: 5px; border-radius: 3px; background: ${C.tealLight}; }
        .miq-root .miqMain { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; }
        .miq-root .topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 26px; background: var(--miq-topbar-blur); backdrop-filter: blur(6px); border-bottom: 1px solid ${C.border}; flex-wrap: wrap; gap: 12px; }
        .miq-root .topTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; }
        .miq-root .topSub { font-size: 12px; color: ${C.textFaint}; margin-top: 2px; max-width: 560px; }
        .miq-root .content { padding: 20px 26px 40px; }
        .miq-root .selectWrap { display: flex; flex-direction: column; gap: 4px; }
        .miq-root .selectLabel { font-size: 9.5px; letter-spacing: 0.6px; color: ${C.textFaint}; font-weight: 600; }
        .miq-root .selectBox { display: flex; align-items: center; gap: 6px; background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 7px; padding: 6px 8px; }
        .miq-root .selectBox select { background: transparent; border: none; color: ${C.text}; font-size: 12px; appearance: none; cursor: pointer; max-width: 168px; }
        .miq-root .selectBox select option { background: ${C.panel}; }
        .miq-root .miqResetBtn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid ${C.teal}; background: ${C.teal}12; color: ${C.teal}; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
        .miq-root .miqResetBtn:hover:not(:disabled) { background: ${C.teal}22; }
        .miq-root .miqResetBtn:disabled { opacity: 0.4; cursor: default; border-color: ${C.border}; color: ${C.textFaint}; background: transparent; }
        .miq-root .miqChip { height: 26px; padding: 0 10px; border-radius: 20px; border: 1px solid ${C.teal}55; background: ${C.teal}14; color: ${C.tealLight}; font-size: 11px; font-weight: 700; cursor: pointer; }
        .miq-root .card { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .miq-root .cardHead { display: flex; justify-content: space-between; align-items: center; padding: 13px 18px; border-bottom: 1px solid ${C.border}; }
        .miq-root .cardTitle { font-size: 12.8px; font-weight: 600; letter-spacing: 0.1px; }
        .miq-root .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .miq-root .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .miq-root .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        .miq-root .grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; }
        @media (max-width: 1300px) { .miq-root .grid5 { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 1100px) { .miq-root .grid3, .miq-root .grid4 { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 800px) { .miq-root .grid2, .miq-root .grid3, .miq-root .grid4, .miq-root .grid5 { grid-template-columns: 1fr; } .miq-root .sidebar { display: none; } }
        .miq-root .kpi { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; padding: 14px 16px; }
        .miq-root .kpiTop { display: flex; justify-content: space-between; align-items: flex-start; }
        .miq-root .kpiLabel { font-size: 11px; color: ${C.textDim}; }
        .miq-root .kpiIconWrap { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
        .miq-root .kpiValue { font-family: 'Space Grotesk', sans-serif; font-size: 22px; font-weight: 700; margin-top: 8px; }
      `}</style>

      <Sidebar label={label} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
      <div className="miqMain">
        <TopBar title={`${label} — Command Overview`}
          subtitle={`One real warehouse indicator (${meta_target}), plus real population/density context -- no other fields exist for this disease to show.`}
          filters={filters} setFilters={setFilters} burden={burden} months={months} lastIdx={lastIdx} />

        <div className="content">
          <SelectionBanner filters={filters} months={months} lastIdx={lastIdx} />

          {/* Same "Hotspot LGAs / Red / Amber / Yellow / Green Zone LGAs" 5-card
              row malaria's own Command Overview leads with, in place of a
              single "Red+Amber zone states" rollup -- real per-LGA zone
              counts for the current scope, same source as the map/region
              treemap above. */}
          <div className="grid5" style={{ marginBottom: 16 }}>
            <KPICard label={`Hotspot LGAs (${scoped.label})`} value={scopedZoneCounts.total} icon={Activity} accent={C.azure} />
            <KPICard label="Red Zone LGAs" value={scopedZoneCounts.Red} icon={AlertTriangle} accent={C.red} />
            <KPICard label="Amber Zone LGAs" value={scopedZoneCounts.Amber} icon={AlertTriangle} accent={C.amber} />
            <KPICard label="Yellow Zone LGAs" value={scopedZoneCounts.Yellow} icon={AlertTriangle} accent={C.yellow} />
            <KPICard label="Green Zone LGAs" value={scopedZoneCounts.Green} icon={ShieldCheck} accent={C.green} />
          </div>

          <div className="grid3" style={{ marginBottom: 16 }}>
            <KPICard label={`${meta_target} (${lastReal.date || M.selectedLabel || '—'})`} value={fmt(lastReal.cases ?? scoped.series.at?.(-1)?.cases)} icon={Activity} accent={C.chartRed} />
            <KPICard label={`Population — ${scoped.label}`} value={popCtx.population != null ? fmt(popCtx.population) : '—'} icon={Users} accent={C.chartBlue} />
            <KPICard label="Population Density" value={popCtx.density != null ? `${fmt(popCtx.density)}/km²` : '—'} icon={MapPin} accent={C.chartPurple} />
          </div>

          <div className="grid2" style={{ marginBottom: 16 }}>
            <Card title="Hotspot States by Geographic Region — click a region to filter" icon={Target}
              info="Each tile is one of Nigeria's 6 geopolitical zones, sized by its real hotspot state count (Red+Amber+Yellow+Green) for the selected month. Click a tile to filter every KPI, chart and the map on this page down to that zone."
              right={filters.region !== 'All' && <button className="miqChip" onClick={() => setFilters(f => ({ ...f, region: 'All' }))}>✕ {REGIONS_META.find(r => r.code === filters.region)?.name}</button>}>
              <ResponsiveContainer width="100%" height={360}>
                <Treemap data={treeData} dataKey="size" stroke={C.bg} isAnimationActive={false}
                  content={({ x, y, width, height, name, code, size, fill }) => {
                    if (code == null) return null
                    if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null
                    const selected = filters.region === code
                    const onClick = () => setFilters(f => ({ ...f, region: f.region === code ? 'All' : code }))
                    const displaySize = Number.isFinite(size) ? Math.round(size) : 0
                    const big = width >= 70 && height >= 38
                    const rotated = !big && height > width * 1.3 && height >= 60
                    const clipId = `thin-tree-clip-${code}`
                    const bigNameSize = big ? Math.max(8, Math.min(12, (width - 18) / (String(name).length * 0.62))) : 12
                    return (
                      <g onClick={onClick} style={{ cursor: 'pointer' }}>
                        <defs><clipPath id={clipId}><rect x={x} y={y} width={width} height={height} /></clipPath></defs>
                        <rect x={x} y={y} width={width} height={height} fill={fill || C.teal} fillOpacity={selected ? 1 : 0.85}
                          stroke={selected ? C.text : C.bg} strokeWidth={selected ? 2.5 : 2} />
                        <g clipPath={`url(#${clipId})`}>
                          {big ? (<>
                            <text x={x + 9} y={y + 19} fill={INK} stroke="none" fontSize={bigNameSize} fontWeight="700" pointerEvents="none">{name}</text>
                            <text x={x + 9} y={y + height - 11} fill={INK} stroke="none" fontSize={17} fontWeight="800" fontFamily="IBM Plex Mono, monospace" pointerEvents="none">{displaySize}</text>
                          </>) : rotated ? (
                            <text x={x + width / 2 + 4} y={y + height / 2} textAnchor="middle" fill={INK} stroke="none"
                              fontSize={10.5} fontWeight="800" pointerEvents="none"
                              transform={`rotate(-90, ${x + width / 2}, ${y + height / 2})`}>{name} ({displaySize})</text>
                          ) : (<>
                            <text x={x + width / 2} y={y + height / 2 - 3} textAnchor="middle" fill={INK} stroke="none" fontSize={Math.min(10.5, width / 6)} fontWeight="700" pointerEvents="none">{name}</text>
                            <text x={x + width / 2} y={y + height / 2 + 12} textAnchor="middle" fill={INK} stroke="none" fontSize={13} fontWeight="800" fontFamily="IBM Plex Mono, monospace" pointerEvents="none">{displaySize}</text>
                          </>)}
                        </g>
                      </g>
                    )
                  }} />
              </ResponsiveContainer>
              <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 8 }}>Number = real hotspot state count in that region as of {M.selectedLabel}. Click a region to filter every KPI/chart on this page to it.</div>
              <SourceLine>Same computed burden score (case volume + trend, percentile-ranked) as the National Risk Map and the What-If Simulation tab, counted per Nigeria geopolitical zone.</SourceLine>
            </Card>
            <Card title="National Risk Map" icon={Target} info="Real burden score (case volume + trend, percentile-ranked against national peers) for the selected month -- the same score the What-If Simulation tab's map uses. Click a state or LGA to filter every KPI/chart on this page.">
              <RiskMap points={M.points} lgaZones={M.lgaZones} selected={filters.locations} selectedLga={filters.lgas}
                onSelect={onMapSelect} onSelectLga={onMapSelectLga} categoryFilter={filters.category} regionFilter={filters.region} />
              <SourceLine>volume_trend burden score (etl_warehouse_common.burden_score): 60% case-volume percentile + 40% month-over-month trend percentile, re-ranked.</SourceLine>
            </Card>
          </div>

          <Card title={`Distribution of Hotspot LGAs by State & Zone (${stackData.length} state${stackData.length !== 1 ? 's' : ''})`} icon={Activity}
            right={filters.category !== 'All' ? <span className="miqChip" style={{ cursor: 'default' }}>{ZONE_LABELS[filters.category]} only</span> : (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {zoneBars.map(([z, color]) => (
                  <div key={z} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
                    <span style={{ fontSize: 11.5, color: C.textDim }}>{ZONE_LABELS[z]}</span>
                  </div>
                ))}
              </div>
            )}
            info="Every matching state, sorted by hotspot LGA count. Filtered to the HOTSPOT ZONE picker above when one is set. Scroll inside the chart to see all of them -- nothing is truncated."
            style={{ marginBottom: 16 }}>
            <div style={{ height: 480, overflowY: 'auto' }}>
              <ResponsiveContainer width="100%" height={Math.max(480, stackData.length * 26)}>
                <BarChart data={stackData} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="3 4" horizontal={false} />
                  <XAxis type="number" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
                  <YAxis type="category" dataKey="state" width={90} tick={{ fill: C.textDim, fontSize: 11 }} axisLine={false} tickLine={false} interval={0} />
                  <Tooltip content={<CustomTooltip />} />
                  {zoneBars.map(([z, color], i) => (
                    <Bar key={z} dataKey={z} stackId="z" name={z} fill={color} radius={i === zoneBars.length - 1 ? [0, 4, 4, 0] : undefined} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <SourceLine>Real per-LGA hotspot zone (same volume_trend burden score as the map above), counted per state for {M.selectedLabel}.</SourceLine>
          </Card>

          <Card title={`${meta_target} by state — ${M.selectedLabel}`} icon={Activity}
            info="Every reporting state's real value for the selected month, sorted highest to lowest -- the only location-wise breakdown this disease has, since it carries just one real indicator."
            style={{ marginBottom: 16 }}>
            <ResponsiveContainer width="100%" height={420}>
              <BarChart data={stateBar} margin={{ top: 4, right: 10, left: 4, bottom: 60 }}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={{ stroke: C.border }} tickLine={false} interval={0} angle={-60} textAnchor="end" height={80} />
                <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="cases" name={meta_target} radius={[3, 3, 0, 0]}>
                  {stateBar.map((p, i) => <Cell key={i} fill={ZONE_COLORS[p.zone] || C.teal} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <SourceLine>Real reported/forecast value per state for {M.selectedLabel}. Bar colour = hotspot zone (same as the map above).</SourceLine>
          </Card>

          <Card title={`${meta_target} — ${scoped.label}`} icon={Activity}
            info="Real monthly reported cases (solid) plus a SARIMAX forecast tail (dashed), scoped to the current location/region/zone filter.">
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={trendSplit}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false}
                  interval={trendSplit.length > 24 ? 5 : (trendSplit.length > 12 ? 2 : 0)} angle={-35} textAnchor="end" height={48} />
                <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
                <Line type="monotone" dataKey="cases_actual" name="Reported" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
                <Line type="monotone" dataKey="cases_forecast" name="Forecast" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <SourceLine>This is the only real per-LGA/state indicator this disease has in the warehouse ({meta_target}).</SourceLine>
          </Card>
        </div>
      </div>
    </div>
  )
}
