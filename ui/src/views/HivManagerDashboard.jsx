import React, { useState, useEffect, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, ComposedChart, Area, PieChart, Pie, Cell, Treemap,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  LayoutDashboard, Syringe, ShieldCheck, Target, TestTube2, HeartPulse,
  ChevronDown, AlertTriangle, Activity, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import {
  C, fmt, withForecastSplit, MiqInfoTip, Card, KPICard, CustomTooltip, Select,
  MultiSelectDropdown, LocationTreeFilter, RiskMap, SplitLineChart, lastActual,
  ZONE_ORDER, ZONE_COLORS, ZONE_LABELS, STATE_GRID, REGIONS_META, lgaNamesForState, MONTH_ABBR,
} from './ManagerDashboard'
import { hivScoreDetail, hivBuildZones } from '../hivBurdenScore'

const BASE = import.meta.env.BASE_URL || '/'

// Same real-count fields the export script (export_burden_hiv.py) produces --
// see that file's own docstring for the full indicator catalog. Covers
// Testing/Treatment/Intervention/age-banded testing/Key Population PrEP+
// testing/Cervical Cancer screening/Key Population Hepatitis B+C testing --
// every NDARS category with genuinely usable coverage, found via repeated
// re-checks rather than assumed from one early pass. TB_HIV, DQA, and most
// of the broader Viral Hepatitis category (treatment-uptake indicators, not
// the KP testing ones covered here) remain a genuine, disclosed data gap.
// Age-band breakdown of HTS testing/positivity -- real NDARS indicators
// (system_id=7), NDARS's own 11 raw reported age bands, shown as-is rather
// than grouped into broader buckets (an earlier version of this dashboard
// grouped them; per explicit instruction, this dashboard now uses the real
// column-wise segregation NDARS already provides). See export_burden_hiv.py's
// AGE_BANDS comment for the exact indicator names and the "5O+" (capital-O,
// not 50) source quirk. Coverage varies by band (13-37 of 37 states) --
// disclosed in each chart's info tooltip rather than hidden by grouping.
const AGE_BANDS = ['1_4', '5_9', '10_14', '15_19', '20_24', '25_29', '30_34', '35_39', '40_44', '45_49', '50plus']
const AGE_BAND_LABEL = {
  '1_4': '1-4', '5_9': '5-9', '10_14': '10-14', '15_19': '15-19', '20_24': '20-24',
  '25_29': '25-29', '30_34': '30-34', '35_39': '35-39', '40_44': '40-44', '45_49': '45-49', '50plus': '50+',
}
const AGE_BAND_FIELDS = AGE_BANDS.flatMap(b => [`hts_pos_${b}`, `hts_neg_${b}`, `hts_tested_${b}`])

// Cervical cancer screening cascade (WLHIV on ART) and Key Population
// Hepatitis B/C testing -- both real, Sum-aggregated NDARS counts, safe to
// treat like any other FIELDS entry (see export_burden_hiv.py's IND dict
// comments for exact indicator names + live coverage verification).
const CACX_FIELDS = ['cacx_neg', 'cacx_pos', 'cacx_suspected', 'cacx_referred']
const HEP_FIELDS = ['hepb_neg', 'hepb_pos', 'hepc_neg', 'hepc_pos']

const FIELDS = ['hts_tested', 'hts_neg', 'hts_pos', 'art_curr', 'art_vl_tested', 'pmtct_tested', ...AGE_BAND_FIELDS, ...CACX_FIELDS, ...HEP_FIELDS]
const FIELD_LABEL = {
  hts_tested: 'HIV Tests Conducted', hts_neg: 'HIV-Negative Results', hts_pos: 'HIV-Positive Results (new diagnoses)',
  art_curr: 'Currently on ART', art_vl_tested: 'On ART with a VL Result', pmtct_tested: 'PMTCT Women Tested',
  ...Object.fromEntries(AGE_BANDS.flatMap(b => [
    [`hts_pos_${b}`, `New Diagnoses, ${AGE_BAND_LABEL[b]}`],
    [`hts_neg_${b}`, `HIV-Negative Results, ${AGE_BAND_LABEL[b]}`],
    [`hts_tested_${b}`, `HIV Tests Conducted, ${AGE_BAND_LABEL[b]}`],
  ])),
  cacx_neg: 'Cervical Cancer Screening, Negative', cacx_pos: 'Cervical Cancer Screening, Positive',
  cacx_suspected: 'Cervical Cancer Screening, Suspected Cancer', cacx_referred: 'Cervical Cancer Screening, Referred',
  hepb_neg: 'Hepatitis B (KP), Negative', hepb_pos: 'Hepatitis B (KP), Positive',
  hepc_neg: 'Hepatitis C (KP), Negative', hepc_pos: 'Hepatitis C (KP), Positive',
}

// art_vl_suppressed_pct is a PERCENTAGE (dim_indicator_master tags its own
// aggregationtype as "Average", not "Sum" -- see export_burden_hiv.py's
// RATE_FIELDS comment). It must be AVERAGED, never summed, when combining
// multiple states/LGAs into one scope -- kept out of FIELDS/sumRows'
// generic sum loop for exactly that reason, handled the same special way
// pop_density already is.
const RATE_FIELDS = ['art_vl_suppressed_pct']

const sum = a => a.reduce((s, v) => s + (v || 0), 0)
const avg = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null }

export const DEFAULT_FILTERS = { periodMode: 'month', monthIdx: null, years: [], months: [], locations: [], region: 'All', lgas: [], category: 'All' }

// Same region-identity palette and dark-on-colour text ink as malaria's own
// region treemap (ManagerDashboard.jsx) -- not exported from there, so
// duplicated locally rather than widening that file's export surface for
// two small constants.
const REGION_COLORS = { NW: '#38BDF8', NC: '#818CF8', NE: '#A78BFA', SW: '#F472B6', SE: '#FB923C', SS: '#34D399' }
const INK = '#0f2230'

function rowFrom(b, m, i) {
  const base = { month: m.label, ym: m.ym, forecast: m.forecast, population: b?.population?.[i] ?? 0, pop_density: b?.pop_density?.[i] ?? 0 }
  FIELDS.forEach(f => { base[f] = b?.[f]?.[i] ?? 0 })
  RATE_FIELDS.forEach(f => { base[f] = b?.[f]?.[i] ?? null })
  // Real "did this area report ANYTHING this month" flags -- see
  // export_burden_hiv.py's reported/hts_reported/art_reported columns,
  // hivBuildZones' no-data exclusion and hivScoreDetail's per-family
  // neutral-default gate in hivBurdenScore.js. Missing (older cached JSON)
  // defaults to true/reported.
  base.reported = b?.reported?.[i] ?? true
  base.hts_reported = b?.hts_reported?.[i] ?? true
  base.art_reported = b?.art_reported?.[i] ?? true
  return base
}
function sumRows(stores, m, i) {
  const base = { month: m.label, ym: m.ym, forecast: m.forecast,
    population: sum(stores.map(b => b?.population?.[i])), pop_density: avg(stores.map(b => b?.pop_density?.[i]).filter(v => v > 0)) }
  FIELDS.forEach(f => { base[f] = sum(stores.map(b => b?.[f]?.[i])) })
  RATE_FIELDS.forEach(f => { base[f] = avg(stores.map(b => b?.[f]?.[i]).filter(v => v != null && v > 0)) })
  return base
}

/* ============================== DATA MODEL ============================== */
function useHivModel(burden, monthIdx) {
  return useMemo(() => {
    if (!burden?.months?.length) return null
    const months = burden.months
    const idx = Math.min(monthIdx ?? months.length - 1, months.length - 1)
    const lastIdx = months.findIndex(m => m.forecast) - 1
    const realLastIdx = lastIdx >= 0 ? lastIdx : months.length - 1

    const stateKeys = Object.keys(burden.states)
    const stateRows = stateKeys.map(k => ({ key: k, x: rowFrom(burden.states[k], months[idx], idx) }))
    const totPop = sum(stateRows.map(r => r.x.population)) || 1
    const peerAvg = {
      posRate: sum(stateRows.map(r => r.x.hts_pos)) / totPop,
      testRate: sum(stateRows.map(r => r.x.hts_tested)) / totPop,
      artRate: sum(stateRows.map(r => r.x.art_curr)) / totPop,
      maxDensity: Math.max(...stateRows.map(r => r.x.pop_density || 0), 1),
    }
    const rawRange = (() => {
      const raws = stateRows.map(r => hivScoreDetail(r.x, peerAvg).raw)
      return [Math.min(...raws, 0), Math.max(...raws, 1)]
    })()
    const stateZones = hivBuildZones(stateRows, peerAvg, rawRange)

    const lgaKeys = Object.keys(burden.lgas)
    const lgaRows = lgaKeys.map(k => ({ key: k, x: rowFrom(burden.lgas[k], months[idx], idx) }))
    const lgaZones = hivBuildZones(lgaRows, peerAvg, rawRange)

    const points = STATE_GRID.filter(s => burden.states[s.key]).map(s => {
      const sz = stateZones[s.key] || {}
      const x = rowFrom(burden.states[s.key], months[idx], idx)
      return { key: s.key, name: s.name, region: s.region, score: sz.display, zone: sz.zone, dominant: sz.zone, ...x }
    })

    return { months, lastIdx: realLastIdx, idx, points, stateZones, lgaZones,
      selectedLabel: months[idx]?.label, selectedForecast: months[idx]?.forecast, latestLabel: months[realLastIdx]?.label }
  }, [burden, monthIdx])
}

function useHivScopedSeries(burden, filters, M) {
  return useMemo(() => {
    if (!burden?.months?.length) return null
    const months = burden.months
    const regionName = REGIONS_META.find(r => r.code === filters.region)?.name
    const catFilter = filters.category !== 'All' ? filters.category : null

    let monthlySeries, label
    if (filters.lgas.length) {
      const keys = filters.lgas.filter(key => !catFilter || M?.lgaZones?.[key]?.zone === catFilter)
      monthlySeries = months.map((m, i) => sumRows(keys.map(k => burden.lgas[k]), m, i))
      const names = filters.lgas.map(k => k.split('|||')[1])
      label = catFilter && keys.length < filters.lgas.length ? `${names.join(', ')} (${catFilter}-zone only)` : names.join(', ')
    } else if (filters.locations.length) {
      const stateKeys = filters.locations.map(name => STATE_GRID.find(s => s.name === name)?.key).filter(Boolean)
      if (catFilter && M?.lgaZones) {
        const prefixes = stateKeys.map(k => `${k}|||`)
        const lgaKeys = Object.keys(burden.lgas).filter(k => prefixes.some(p => k.startsWith(p)) && M.lgaZones[k]?.zone === catFilter)
        monthlySeries = months.map((m, i) => sumRows(lgaKeys.map(k => burden.lgas[k]), m, i))
      } else {
        monthlySeries = months.map((m, i) => sumRows(stateKeys.map(k => burden.states[k]), m, i))
      }
      label = catFilter ? `${filters.locations.join(', ')} (${catFilter}-zone LGAs)` : filters.locations.join(', ')
    } else {
      const dominantByState = Object.fromEntries((M?.points || []).map(p => [p.key, p.dominant]))
      const matches = STATE_GRID.filter(s => (filters.region === 'All' || s.region === filters.region) && burden.states[s.key] &&
        (!catFilter || dominantByState[s.key] === catFilter))
      const keys = matches.length ? matches.map(s => s.key) : (catFilter ? [] : Object.keys(burden.states))
      monthlySeries = months.map((m, i) => sumRows(keys.map(k => burden.states[k]), m, i))
      label = catFilter ? `${catFilter}-zone states` : (filters.region !== 'All' ? regionName : 'Nigeria (national)')
    }

    let series = monthlySeries
    if (filters.periodMode === 'year') {
      const allYears = [...new Set(monthlySeries.map(d => +d.ym.split('-')[0]))].sort((a, b) => a - b)
      let yearsToUse = (filters.years?.length ? filters.years : allYears.slice(-1)).slice().sort((a, b) => a - b)
      if (yearsToUse.length === 1) {
        const y = yearsToUse[0]
        const yi = allYears.indexOf(y)
        const neighbor = yi > 0 ? allYears[yi - 1] : allYears[yi + 1]
        if (neighbor != null) yearsToUse = [...yearsToUse, neighbor].sort((a, b) => a - b)
      }
      series = yearsToUse.map(y => {
        const rows = monthlySeries.filter(d => +d.ym.split('-')[0] === y)
        const out = { month: String(y), ym: `${y}-01`, forecast: rows.some(r => r.forecast) }
        FIELDS.forEach(f => { out[f] = sum(rows.map(r => r[f])) })
        RATE_FIELDS.forEach(f => { out[f] = avg(rows.map(r => r[f]).filter(v => v != null)) })
        out.population = sum(rows.map(r => r.population))
        out.pop_density = avg(rows.map(r => r.pop_density))
        return out
      })
    } else if (filters.months?.length) {
      const set = new Set(filters.months)
      series = monthlySeries.filter((d, i) => set.has(i))
    } else if (filters.years?.length) {
      series = monthlySeries.filter(d => filters.years.includes(+d.ym.split('-')[0]))
    }

    return { series, monthlySeries, label }
  }, [burden, filters.locations, filters.region, filters.lgas, filters.category, filters.periodMode, filters.years, filters.months, M])
}

// Key-population PrEP levers are NATIONAL-only (too sparse per-state/LGA for
// an honest series -- see export_hiv_kp_socio.py's module note), so this
// respects the TIME filter (same month-index alignment as burden.months,
// since kp_series.months is exported directly from that same file) but not
// the location filter -- disclosed via the chart's own info tooltip rather
// than silently pretending a location scope applies.
function useKpScopedSeries(kpSocio, filters) {
  return useMemo(() => {
    if (!kpSocio?.kp_series?.months?.length) return null
    const months = kpSocio.kp_series.months
    const S = kpSocio.kp_series.series
    const monthlySeries = months.map((m, i) => ({
      month: m.label, ym: m.ym, forecast: m.forecast,
      msm: S.msm[i], pwid: S.pwid[i], sw: S.sw[i], tg: S.tg[i],
    }))
    let series = monthlySeries
    if (filters.periodMode === 'year') {
      const allYears = [...new Set(monthlySeries.map(d => +d.ym.split('-')[0]))].sort((a, b) => a - b)
      let yearsToUse = (filters.years?.length ? filters.years : allYears.slice(-1)).slice().sort((a, b) => a - b)
      if (yearsToUse.length === 1) {
        const y = yearsToUse[0]
        const yi = allYears.indexOf(y)
        const neighbor = yi > 0 ? allYears[yi - 1] : allYears[yi + 1]
        if (neighbor != null) yearsToUse = [...yearsToUse, neighbor].sort((a, b) => a - b)
      }
      series = yearsToUse.map(y => {
        const rows = monthlySeries.filter(d => +d.ym.split('-')[0] === y)
        const out = { month: String(y), ym: `${y}-01`, forecast: rows.some(r => r.forecast) }
        ;['msm', 'pwid', 'sw', 'tg'].forEach(f => { out[f] = sum(rows.map(r => r[f])) })
        return out
      })
    } else if (filters.months?.length) {
      const set = new Set(filters.months)
      series = monthlySeries.filter((d, i) => set.has(i))
    } else if (filters.years?.length) {
      series = monthlySeries.filter(d => filters.years.includes(+d.ym.split('-')[0]))
    }
    return { series }
  }, [kpSocio, filters.periodMode, filters.years, filters.months])
}

/* ============================== SIDEBAR + TOPBAR ============================== */
const NAV = [
  { id: 'overview', label: 'Command Overview', icon: LayoutDashboard },
  { id: 'testing', label: 'Testing & Case-Finding', icon: TestTube2 },
  { id: 'treatment', label: 'Treatment & Care', icon: HeartPulse },
]

function Sidebar({ page, setPage, collapsed, onToggle }) {
  return (
    <div className={`sidebar ${collapsed ? 'sidebarCollapsed' : ''}`}>
      <div className="brand">
        <div className="brandMark" style={{ background: `linear-gradient(135deg, ${C.red}, ${C.purple})` }}><Activity size={17} color="#ffffff" strokeWidth={2.6} /></div>
        {!collapsed && <div style={{ flex: 1, minWidth: 0 }}><div className="brandTitle">HIV</div><div className="brandSub">Predictive Analytics</div></div>}
        <button className="sidebarToggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} color={C.textDim} /> : <PanelLeftClose size={16} color={C.textDim} />}
        </button>
      </div>
      <div className="navList">
        {NAV.map(item => {
          const Icon = item.icon, active = page === item.id
          return (
            <button key={item.id} className={`navItem ${active ? 'navItemActive' : ''}`} onClick={() => setPage(item.id)} title={collapsed ? item.label : undefined}>
              <Icon size={16} strokeWidth={2.1} color={active ? C.teal : C.textDim} />
              {!collapsed && <span>{item.label}</span>}{!collapsed && active && <span className="navDot" />}
            </button>
          )
        })}
      </div>
      {!collapsed && (
        <div className="sidebarFoot">
          <div style={{ fontSize: 10.5, color: C.textFaint, lineHeight: 1.5 }}>National AIDS &amp; STIs Control Programme<br />Nigeria · NDARS (system_id=7)</div>
        </div>
      )}
    </div>
  )
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
      {filters.category !== 'All' && (<><span style={{ color: C.border }}>·</span><span>{ZONE_LABELS[filters.category].toUpperCase()} ONLY</span></>)}
    </div>
  )
}

function TopBar({ title, subtitle, filters, setFilters, burden, months, lastIdx }) {
  const years = [...new Set(months.map(m => +m.ym.split('-')[0]))].sort((a, b) => a - b)
  const isDefault = !filters.locations.length && filters.region === 'All' && !filters.lgas.length && filters.category === 'All' &&
    filters.periodMode === 'month' && filters.monthIdx === lastIdx && !filters.years.length && !filters.months.length
  const resetAll = () => setFilters({ ...DEFAULT_FILTERS, monthIdx: lastIdx })

  const monthIdx = filters.monthIdx ?? lastIdx
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
        <LocationTreeFilter filters={filters} setFilters={setFilters} burden={burden} />
      </div>
    </div>
  )
}

/* ============================== PAGE: OVERVIEW ============================== */
function OverviewPage({ M, scoped, filters, setFilters }) {
  const scopedPoints = useMemo(() => M.points.filter(p =>
    (filters.region === 'All' || p.region === filters.region) &&
    (!filters.locations.length || filters.locations.includes(p.name))
  ), [M.points, filters.region, filters.locations])
  const cascadeSplit = useMemo(() => withForecastSplit(scoped.series, ['hts_pos', 'art_curr', 'art_vl_tested']), [scoped.series])
  const lastReal = lastActual(scoped.series) || {}

  // Treemap: one tile per Nigeria geopolitical zone, sized by its real
  // hotspot STATE count (Red+Amber+Yellow+Green, excluding Not-a-Hotspot
  // and the No-Data zone -- see hivBurdenScore.js), same region-identity
  // colours and click-to-filter behaviour as malaria's own region treemap.
  // Built from the FULL M.points (not scopedPoints) so all 6 regions stay
  // visible/sizeable even while one is selected -- it's a filter control
  // itself, not something that should shrink to only the filtered subset.
  const treeData = REGIONS_META.map(r => ({
    name: r.name, code: r.code,
    size: M.points.filter(p => p.region === r.code && p.zone && p.zone !== 'Not a Hotspot' && p.zone !== 'No Data').length || 0.001,
    fill: REGION_COLORS[r.code],
  }))
  const scopedRed = scopedPoints.filter(p => p.zone === 'Red').length
  const scopedAmber = scopedPoints.filter(p => p.zone === 'Amber').length
  const scopedYellow = scopedPoints.filter(p => p.zone === 'Yellow').length
  const scopedGreen = scopedPoints.filter(p => p.zone === 'Green').length

  const onMapSelect = name => setFilters(f => ({ ...f, locations: (f.locations.length === 1 && f.locations[0] === name) ? [] : [name], lgas: [] }))
  const onMapSelectLga = (stateName, lgaName) => setFilters(f => {
    const key = `${stateName}|||${lgaName}`
    return { ...f, lgas: (f.lgas.length === 1 && f.lgas[0] === key) ? [] : [key], locations: [] }
  })
  const topStates = scopedPoints.filter(p => p.zone !== 'No Data').sort((a, b) => b.score - a.score).slice(0, 5)

  return (
    <>
      <div className="grid4" style={{ marginTop: 16 }}>
        <KPICard label={`New HIV Diagnoses (${lastReal.month || '—'})`} value={fmt(lastReal.hts_pos)} icon={AlertTriangle} accent={C.chartRed || C.red} />
        <KPICard label="Red Zone States" value={scopedRed} icon={AlertTriangle} accent={C.red} />
        <KPICard label="Amber Zone States" value={scopedAmber} icon={AlertTriangle} accent={C.amber} />
        <KPICard label="Green Zone States" value={scopedGreen} icon={ShieldCheck} accent={C.green} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Hotspot States by Geographic Region — click a region to filter" icon={Target}
          info="Each tile is one of Nigeria's 6 geopolitical zones, sized by its real hotspot state count (Red+Amber+Yellow+Green, excluding Not-a-Hotspot and No-Data) as of the selected month. Click a tile to filter every KPI, chart and the map on this page down to that zone -- same treemap pattern as the malaria dashboard's own region view, sized by states here since this dashboard's own KPI strip above is state-grain, not LGA-grain."
          right={filters.region !== 'All' && <button className="miqChip" onClick={() => setFilters(f => ({ ...f, region: 'All' }))}>✕ {REGIONS_META.find(r => r.code === filters.region)?.name}</button>}>
          <ResponsiveContainer width="100%" height={430}>
            <Treemap data={treeData} dataKey="size" stroke={C.bg} isAnimationActive={false}
              content={({ x, y, width, height, name, code, size, fill }) => {
                if (code == null) return null
                if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null
                const selected = filters.region === code
                const onClick = () => setFilters(f => ({ ...f, region: f.region === code ? 'All' : code }))
                const displaySize = Number.isFinite(size) ? Math.round(size) : 0
                const big = width >= 70 && height >= 38
                const rotated = !big && height > width * 1.3 && height >= 60
                const clipId = `hiv-tree-clip-${code}`
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
                          transform={`rotate(-90, ${x + width / 2}, ${y + height / 2})`}>
                          {name} ({displaySize})
                        </text>
                      ) : (<>
                        <text x={x + width / 2} y={y + height / 2 - 3} textAnchor="middle" fill={INK} stroke="none" fontSize={Math.min(10.5, width / 6)} fontWeight="700" pointerEvents="none">{name}</text>
                        <text x={x + width / 2} y={y + height / 2 + 12} textAnchor="middle" fill={INK} stroke="none" fontSize={13} fontWeight="800" fontFamily="IBM Plex Mono, monospace" pointerEvents="none">{displaySize}</text>
                      </>)}
                    </g>
                  </g>
                )
              }} />
          </ResponsiveContainer>
          <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 8 }}>Number = real hotspot state count in that region as of {scoped.label}. Click a region to filter every KPI/chart on this page to it.</div>
          <SourceLine>Same computed burden score as the National Risk Map, counted per Nigeria geopolitical zone.</SourceLine>
        </Card>
        <Card title="National Risk Map" icon={Target} info="Real HIV hotspot burden score (5-factor: case burden, testing gap, ART coverage gap, VL-monitoring gap, population density), computed the same way malaria's own map is -- ranked + normalized against the national peer set. Click a state or LGA to filter every KPI/chart on this page to it.">
          <RiskMap points={M.points} lgaZones={M.lgaZones} selected={filters.locations} selectedLga={filters.lgas}
            onSelect={onMapSelect} onSelectLga={onMapSelectLga} categoryFilter={filters.category} regionFilter={filters.region} />
          <SourceLine>Computed burden score (ui/src/hivBurdenScore.js): case burden, testing gap, ART coverage gap, VL-monitoring gap and population density, each from the NDARS indicators cited on the other cards on this page.</SourceLine>
        </Card>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Top 5 Highest-Burden States" icon={AlertTriangle} info="Real burden score (0-100) as of the selected month.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {topStates.map((s, i) => (
              <div key={s.key} className="rankRow" style={{ padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
                <span className="rankNo">{i + 1}</span>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: ZONE_COLORS[s.zone] || '#94a3b8', display: 'inline-block', marginRight: 6 }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                <span className="tagRegion" style={{ color: C.textFaint }}>{s.region}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, fontWeight: 700, marginLeft: 8 }}>{s.score?.toFixed(0)}</span>
              </div>
            ))}
            {!topStates.length && <div style={{ fontSize: 12, color: C.textFaint }}>No states match the current filters.</div>}
          </div>
          <SourceLine>Same computed burden score as the National Risk Map, ranked highest to lowest.</SourceLine>
        </Card>
        <Card title="Data Coverage Note" icon={AlertTriangle} info="Which of NDARS's 12 reported factor groups feed this dashboard.">
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: C.textDim, background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', lineHeight: 1.6 }}>
            <AlertTriangle size={13} color={C.amber} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              This dashboard covers <strong>Testing (HTS, incl. age-banded)</strong>, <strong>Treatment (ART, VL-monitoring, viral suppression rate)</strong>, <strong>Intervention (PMTCT)</strong>, <strong>Key Population (PrEP, testing, Hepatitis B/C)</strong> and
              <strong> Cervical Cancer screening</strong> -- every NDARS factor group with real, current, broadly-reported data, re-checked more than once as new categories were requested. <strong>TB/HIV co-infection, DQA, and most of the broader Viral Hepatitis
              category</strong> (treatment-uptake indicators, distinct from the KP Hepatitis testing shown on the Testing tab) remain
              &gt;90% missing at facility grain -- rolling those up to state/LGA would fabricate signal from noise, so they're
              intentionally left out rather than shown as unreliable charts.
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={`New Diagnoses, ART & VL Monitoring — ${scoped.label}`} icon={Activity}
          info="Real monthly counts: new HIV-positive diagnoses (HTS_TST_POS), people currently on ART, and people on ART with a viral-load result. Solid = reported; dashed = model forecast.">
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={cascadeSplit} margin={{ top: 4, right: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={cascadeSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis yAxisId="l" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Line yAxisId="l" type="monotone" dataKey="hts_pos_actual" name="New diagnoses" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
              <Line yAxisId="l" type="monotone" dataKey="hts_pos_forecast" name="New diagnoses (forecast)" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls />
              <Area yAxisId="r" type="monotone" dataKey="art_curr_actual" name="Currently on ART" stroke={C.chartBlue} fill={C.chartBlue} fillOpacity={0.12} strokeWidth={2} connectNulls />
              <Area yAxisId="r" type="monotone" dataKey="art_curr_forecast" name="Currently on ART (forecast)" stroke={C.chartBlue} strokeDasharray="5 4" fill={C.chartBlue} fillOpacity={0.04} strokeWidth={2} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7): "HTS Monthly_1n_HTS_TST_POS Total" (M+F), "ART Monthly_3_Currently on ART" (M+F).</SourceLine>
        </Card>
      </div>
    </>
  )
}

/* ============================== PAGE: TESTING ============================== */
const KP_COLORS = { msm: C.chartPurple, pwid: C.chartRed, sw: C.chartAmber, tg: C.chartTeal }
const KP_LABELS = { msm: 'MSM (PrEP-eligible)', pwid: 'PWID (PrEP-eligible)', sw: 'Sex Workers (PrEP-eligible)', tg: 'Transgender (PrEP-eligible)' }
// 11 distinct hex colors, young (cool) -> old (warm), since the 6 named
// C.chart* colors aren't enough for 11 real age bands shown individually.
const AGE_BAND_COLORS = {
  '1_4': '#38bdf8', '5_9': '#22d3ee', '10_14': '#2dd4bf', '15_19': '#4ade80', '20_24': '#a3e635',
  '25_29': '#facc15', '30_34': '#fbbf24', '35_39': '#fb923c', '40_44': '#f87171', '45_49': '#f472b6', '50plus': '#a78bfa',
}

// Persistent, always-visible source line -- NOT behind the (i) hover tooltip.
// Added because a hover-only citation was not sufficient: the exact same
// sourcing is also in each Card's `info` tooltip, this is a second, unhidden
// copy directly under the chart.
function SourceLine({ children }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${C.border}`, fontSize: 10.5, color: C.textFaint, lineHeight: 1.5 }}>
      <b style={{ color: C.textDim }}>Source: </b>{children}
    </div>
  )
}

function TestingPage({ scoped, kpScoped, kpSocio }) {
  const lastReal = lastActual(scoped.series) || {}
  const testTrendSplit = useMemo(() => withForecastSplit(scoped.series, ['hts_tested', 'hts_neg', 'hts_pos']), [scoped.series])
  const positivity = lastReal.hts_tested > 0 ? (lastReal.hts_pos / lastReal.hts_tested * 100) : null
  const kpTrendSplit = useMemo(() => kpScoped ? withForecastSplit(kpScoped.series, ['msm', 'pwid', 'sw', 'tg']) : [], [kpScoped])
  const kpLastReal = kpScoped ? (lastActual(kpScoped.series) || {}) : {}
  const soc = kpSocio?.socioeconomic?.national
  const ageBandKeys = AGE_BANDS.map(b => `hts_pos_${b}`)
  const ageTrendSplit = useMemo(() => withForecastSplit(scoped.series, ageBandKeys), [scoped.series])
  const ageLastReal = lastActual(scoped.series) || {}
  const ageTestedTrendSplit = useMemo(() => withForecastSplit(scoped.series, AGE_BANDS.map(b => `hts_tested_${b}`)), [scoped.series])
  const hepbTrendSplit = useMemo(() => withForecastSplit(scoped.series, ['hepb_neg', 'hepb_pos']), [scoped.series])
  const hepcTrendSplit = useMemo(() => withForecastSplit(scoped.series, ['hepc_neg', 'hepc_pos']), [scoped.series])

  return (
    <>
      <div className="grid4" style={{ marginTop: 16 }}>
        <KPICard label={`Tests Conducted (${lastReal.month || '—'})`} value={fmt(lastReal.hts_tested)} icon={TestTube2} accent={C.chartBlue} />
        <KPICard label="HIV-Negative Results" value={fmt(lastReal.hts_neg)} icon={ShieldCheck} accent={C.chartGreen} />
        <KPICard label="HIV-Positive Results" value={fmt(lastReal.hts_pos)} icon={AlertTriangle} accent={C.chartRed} />
        <KPICard label="Positivity Rate" value={positivity != null ? `${positivity.toFixed(1)}%` : '—'} icon={Activity} accent={C.chartAmber} />
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`HIV Testing Volume & Results — ${scoped.label}`} icon={TestTube2} info="Real monthly HTS (HIV Testing Services) counts, NDARS Total (Female+Male). Solid = reported; dashed = model forecast.">
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={testTrendSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={testTrendSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              {[['hts_tested', 'Tested', C.chartBlue], ['hts_neg', 'Negative', C.chartGreen], ['hts_pos', 'Positive', C.chartRed]].map(([k, name, color]) => (
                <React.Fragment key={k}>
                  <Line type="monotone" dataKey={`${k}_actual`} name={name} stroke={color} strokeWidth={2.2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={`${k}_forecast`} name={`${name} (forecast)`} stroke={color} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                </React.Fragment>
              ))}
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), indicators "HTS Monthly_1n_HTS_TST/_NEG/_POS Total, Female" + "...Male" summed. Live warehouse query, updated on every dashboard refresh.</SourceLine>
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`PMTCT — Pregnant & Breastfeeding Women Tested — ${scoped.label}`} icon={TestTube2}
          info="Real monthly NDARS indicator PMTCT_HTS_Total (Number of pregnant & breastfeeding women HIV tested and received results, including known positive), system_id=7. PMTCT (Prevention of Mother-to-Child Transmission) is a maternal-health service by definition -- it exists specifically to test and treat pregnant/breastfeeding women so HIV isn't passed to their infant during pregnancy, birth, or breastfeeding. It is not measured for men because the intervention itself only applies to pregnancy/breastfeeding -- this is the nature of the programme, not a gap in the data. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="pmtct_tested" name="PMTCT women tested" color={C.chartPurple} />
          <SourceLine>NDARS (system_id=7), indicator "PMTCT_HTS_Total. Number of pregnant &amp; Breast-feeding women HIV tested and received results (Incl. known Positive)".</SourceLine>
        </Card>
      </div>

      {/* ── New diagnoses by age group (real NDARS age-banded HTS data) ── */}
      <div className="grid4" style={{ marginTop: 16 }}>
        {AGE_BANDS.map(b => (
          <KPICard key={b} label={`New Diagnoses, ${AGE_BAND_LABEL[b]} (${ageLastReal.month || '—'})`} value={fmt(ageLastReal[`hts_pos_${b}`])} icon={AlertTriangle} accent={AGE_BAND_COLORS[b]} />
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`New HIV Diagnoses by Age Group — ${scoped.label}`} icon={AlertTriangle}
          info="Real NDARS HTS_TST_POS (new positive diagnoses) broken out by NDARS's own 11 raw reported age bands (1-4, 5-9, 10-14, 15-19, 20-24, 25-29, 30-34, 35-39, 40-44, 45-49, 50+), Male+Female summed per band, system_id=7 -- shown as NDARS reports them, not regrouped into broader buckets. Coverage varies by band (13-37 of 37 states) and is generally sparser than the aggregate hts_pos total, especially at the youngest and oldest bands -- treat individual-band, individual-month spikes/dips as noisier signal than the all-ages total above; the overall shape across bands is still real. Solid = reported; dashed = calendar-month climatology forecast.">
          <ResponsiveContainer width="100%" height={520}>
            <LineChart data={ageTrendSplit} margin={{ right: 20 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={{ stroke: C.border }} tickLine={false} interval={ageTrendSplit.length > 24 ? 2 : 0} angle={-35} textAnchor="end" height={52} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.textDim }} />
              {AGE_BANDS.map(b => (
                <React.Fragment key={b}>
                  <Line type="monotone" dataKey={`hts_pos_${b}_actual`} name={AGE_BAND_LABEL[b]} stroke={AGE_BAND_COLORS[b]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line type="monotone" dataKey={`hts_pos_${b}_forecast`} name={`${AGE_BAND_LABEL[b]} (forecast)`} stroke={AGE_BAND_COLORS[b]} strokeWidth={2.4} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                </React.Fragment>
              ))}
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), "HTS Monthly_1n_HTS_TST_POS Total &lt;age&gt;, &lt;sex&gt;" summed per band (11 raw bands x Male/Female).</SourceLine>
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`HIV Tests Conducted by Age Group — ${scoped.label}`} icon={TestTube2}
          info="Real NDARS testing VOLUME (positive + negative results) broken out by the same 11 real NDARS age bands as the diagnoses chart above -- lets you compare how much testing an age group is getting against how many diagnoses it's producing. Same real-band coverage and sparser-at-the-edges caveat as the diagnoses chart. Solid = reported; dashed = calendar-month climatology forecast.">
          <ResponsiveContainer width="100%" height={520}>
            <LineChart data={ageTestedTrendSplit} margin={{ right: 20 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={{ stroke: C.border }} tickLine={false} interval={ageTestedTrendSplit.length > 24 ? 2 : 0} angle={-35} textAnchor="end" height={52} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.textDim }} />
              {AGE_BANDS.map(b => (
                <React.Fragment key={b}>
                  <Line type="monotone" dataKey={`hts_tested_${b}_actual`} name={AGE_BAND_LABEL[b]} stroke={AGE_BAND_COLORS[b]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line type="monotone" dataKey={`hts_tested_${b}_forecast`} name={`${AGE_BAND_LABEL[b]} (forecast)`} stroke={AGE_BAND_COLORS[b]} strokeWidth={2.4} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                </React.Fragment>
              ))}
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), "HTS Monthly_1n_HTS_TST_POS/_NEG Total &lt;age&gt;, &lt;sex&gt;" (pos+neg) summed per band.</SourceLine>
        </Card>
      </div>

      {/* ── Two derived views of the same age-band data: WHICH age group is riskiest ── */}
      {/* per test (positivity rate), and WHICH age group makes up the biggest share  ── */}
      {/* of new diagnoses (composition) -- neither is a re-plot of the trend lines    ── */}
      {/* above, both answer a different question a manager would actually ask.        ── */}
      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`Positivity Rate by Age Group — ${ageLastReal.month || '—'}`} icon={Activity}
          info="Derived: new diagnoses / tests conducted x 100, per age bucket, for the latest real month. This is NOT a raw NDARS field -- it's computed here from the same two real indicator families as the two charts above, the same way the dashboard's overall Positivity Rate KPI is computed for the all-ages total. A higher bar means a larger share of that age group's tests are coming back positive, which can point to where targeted testing would find the most undiagnosed cases -- independent of how many tests that group already gets (a small, high-positivity group can be just as important to act on as a large, low-positivity one).">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={AGE_BANDS.map(b => ({
              band: AGE_BAND_LABEL[b],
              rate: ageLastReal[`hts_tested_${b}`] > 0 ? +(ageLastReal[`hts_pos_${b}`] / ageLastReal[`hts_tested_${b}`] * 100).toFixed(1) : 0,
              color: AGE_BAND_COLORS[b],
            }))}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="band" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
              <Tooltip content={<CustomTooltip />} formatter={v => `${v}%`} />
              <Bar dataKey="rate" name="Positivity rate" radius={[6, 6, 0, 0]}>
                {AGE_BANDS.map(b => <Cell key={b} fill={AGE_BAND_COLORS[b]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <SourceLine>Derived from the same NDARS HTS_TST_POS/_NEG age-band indicators as the two charts above (positive ÷ (positive+negative) per bucket).</SourceLine>
        </Card>
        <Card title={`Share of New Diagnoses by Age Group — ${ageLastReal.month || '—'}`} icon={AlertTriangle}
          info="Derived: each age band's share of total new diagnoses in the latest real month (the 11 slices sum to the same hts_pos total shown elsewhere on this tab). Answers a different question than the rate chart beside it -- this shows WHERE volume is concentrated, not which group tests highest-risk per test. A group can have a small slice here but a high bar on the rate chart (few cases, but a high hit rate), or the reverse.">
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={AGE_BANDS.map(b => ({ name: AGE_BAND_LABEL[b], value: ageLastReal[`hts_pos_${b}`] || 0, band: b }))}
                dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}>
                {AGE_BANDS.map(b => <Cell key={b} fill={AGE_BAND_COLORS[b]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
            </PieChart>
          </ResponsiveContainer>
          <SourceLine>Derived from the same NDARS HTS_TST_POS age-band indicators as the diagnoses-by-age-group chart above.</SourceLine>
        </Card>
      </div>

      {/* ── Key Population interventions (PrEP) ── */}
      <div className="grid4" style={{ marginTop: 16 }}>
        {['msm', 'pwid', 'sw', 'tg'].map(g => (
          <KPICard key={g} label={KP_LABELS[g]} value={fmt(kpLastReal[g])} icon={ShieldCheck} accent={KP_COLORS[g]} />
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`Key Population PrEP Uptake — National`} icon={ShieldCheck}
          info="Real NDARS PrEP-eligibility counts for the 4 key-population groups (MSM tracked under NDARS's own 'SDC' label). National only -- too sparse per-state/LGA for an honest series, so this does not respond to the location filter, only the time filter. Solid = reported; dashed = calendar-month climatology forecast (no HIV-specific ML forecast exists for these levers yet).">
          {kpScoped ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={kpTrendSplit}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={kpTrendSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
                <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
                {['msm', 'pwid', 'sw', 'tg'].map(g => (
                  <React.Fragment key={g}>
                    <Line type="monotone" dataKey={`${g}_actual`} name={KP_LABELS[g]} stroke={KP_COLORS[g]} strokeWidth={2.2} dot={false} connectNulls />
                    <Line type="monotone" dataKey={`${g}_forecast`} name={`${KP_LABELS[g]} (forecast)`} stroke={KP_COLORS[g]} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                  </React.Fragment>
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : <div style={{ padding: 30, textAlign: 'center', color: C.textFaint, fontSize: 12 }}>Loading…</div>}
          <SourceLine>NDARS (system_id=7), indicator "PREP.1. No. of individuals who were eligible and started PrEP in the reporting month" filtered per group (SDC=MSM, Injecting Drug Users=PWID, Sex Workers, Transgender), Total column.</SourceLine>
        </Card>
      </div>

      {/* ── Key Population testing & positivity (real NDARS data, PWID/SW/TG only -- ── */}
      {/* SDC/MSM has no NDARS-native "tested for HIV" series, only PrEP-eligibility above) */}
      {kpSocio?.kp && (
        <div style={{ marginTop: 16 }}>
          <Card title="Key Population Testing & Positivity — National, recent 12mo average" icon={TestTube2}
            info="Real NDARS testing volume and positivity for PWID, Sex Workers and Transgender (MSM/SDC has no NDARS-native testing series -- PrEP-eligibility above is the only NDARS-tracked SDC metric). Recent-12-month snapshot, not a monthly trend -- disclosed as such rather than shown as a fake trend line.">
            <div className="grid3">
              {['pwid', 'sw', 'tg'].filter(g => kpSocio.kp[g]?.tested_monthly_national != null).map(g => (
                <div key={g} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: KP_COLORS[g] }}>{kpSocio.kp[g].display}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12 }}>
                    <span style={{ color: C.textFaint }}>Tested/mo</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700 }}>{fmt(kpSocio.kp[g].tested_monthly_national)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 12 }}>
                    <span style={{ color: C.textFaint }}>Positivity</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700, color: C.chartRed }}>{kpSocio.kp[g].positivity_pct}%</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 12 }}>
                    <span style={{ color: C.textFaint }}>IBBSS 2020-21 prevalence</span>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700 }}>{kpSocio.kp[g].prevalence_pct}%</span>
                  </div>
                </div>
              ))}
            </div>
            <SourceLine>Tested/positivity: NDARS (system_id=7), "Total number of key population who tested for HIV and received results, &lt;group&gt;, Male/Female" and the matching "...tested HIV positive..." indicator, recent-12-month average. IBBSS prevalence: Integrated Biological &amp; Behavioural Surveillance Survey 2020-21 (published survey, not a NDARS series).</SourceLine>
          </Card>
        </div>
      )}

      {/* ── Key Population Hepatitis B/C testing (real NDARS data, state/LGA-resolved -- ── */}
      {/* unlike the KP PrEP/testing cards above, this DOES respond to the location filter) ── */}
      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`Key Population Hepatitis B Testing — ${scoped.label}`} icon={Activity}
          info="Real NDARS Key Population Hepatitis B testing counts (system_id=7), Male+Female summed. Coverage is thinner than the core HTS fields (30-32 of 37 states report per indicator, vs 37 for the main HIV testing counts) but materially better than most of NDARS's Viral Hepatitis category (the DQA and treatment-uptake Hepatitis indicators are 4-11 states and stayed excluded as genuinely too sparse). Solid = reported; dashed = calendar-month climatology forecast.">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={hepbTrendSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={scoped.series.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Line type="monotone" dataKey="hepb_neg_actual" name="Negative" stroke={C.chartGreen} strokeWidth={2.2} dot={false} connectNulls />
              <Line type="monotone" dataKey="hepb_neg_forecast" name="Negative (forecast)" stroke={C.chartGreen} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
              <Line type="monotone" dataKey="hepb_pos_actual" name="Positive" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
              <Line type="monotone" dataKey="hepb_pos_forecast" name="Positive (forecast)" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), "Number of KP tested negative/positive for Hepatitis B, Male/Female Total".</SourceLine>
        </Card>
        <Card title={`Key Population Hepatitis C Testing — ${scoped.label}`} icon={Activity}
          info="Real NDARS Key Population Hepatitis C testing counts (system_id=7), Male+Female summed. Same coverage profile and caveats as the Hepatitis B chart alongside it. Solid = reported; dashed = calendar-month climatology forecast.">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={hepcTrendSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={scoped.series.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Line type="monotone" dataKey="hepc_neg_actual" name="Negative" stroke={C.chartGreen} strokeWidth={2.2} dot={false} connectNulls />
              <Line type="monotone" dataKey="hepc_neg_forecast" name="Negative (forecast)" stroke={C.chartGreen} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
              <Line type="monotone" dataKey="hepc_pos_actual" name="Positive" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
              <Line type="monotone" dataKey="hepc_pos_forecast" name="Positive (forecast)" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), "Number of KP tested negative/positive for Hepatitis C, Male/Female Total".</SourceLine>
        </Card>
      </div>

      {/* ── Socioeconomic context (static survey snapshot, not a monthly series) ── */}
      {soc && (
        <>
          <div className="grid2" style={{ marginTop: 16 }}>
            <KPICard label="Poverty (MPI headcount)" value={`${soc.poverty_mpi_h}%`} icon={AlertTriangle} accent={C.amber} />
            <KPICard label="Literacy / Schooling Access" value={`${soc.literacy_access}%`} icon={ShieldCheck} accent={C.chartGreen} />
          </div>
          <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 6 }}>
            <b style={{ color: C.textDim }}>Source: </b>Nigeria Multidimensional Poverty Index (National Bureau of Statistics / OPHI, 2022), national figures -- static survey snapshot, not a NDARS series and not state/LGA-resolved.
          </div>
        </>
      )}
    </>
  )
}

/* ============================== PAGE: TREATMENT ============================== */
const CACX_COLORS = { cacx_neg: C.chartGreen, cacx_pos: C.chartRed, cacx_suspected: C.chartAmber, cacx_referred: C.chartPurple }
const CACX_LABELS = { cacx_neg: 'Negative', cacx_pos: 'Positive', cacx_suspected: 'Suspected cancer', cacx_referred: 'Referred' }

function TreatmentPage({ scoped }) {
  const lastReal = lastActual(scoped.series) || {}
  const vlPct = lastReal.art_curr > 0 ? (lastReal.art_vl_tested / lastReal.art_curr * 100) : null
  // Real, latest reported month with an actual value -- art_vl_suppressed_pct
  // can be null for a given month if a scope's own facilities didn't report
  // it that month, so this walks back from the end of the ACTUAL portion of
  // the series rather than trusting lastActual() (which only checks forecast
  // flag, not per-field nullness).
  const lastSuppressed = [...scoped.series].reverse().find(r => !r.forecast && r.art_vl_suppressed_pct != null)
  const cacxTrendSplit = useMemo(() => withForecastSplit(scoped.series, CACX_FIELDS), [scoped.series])

  return (
    <>
      <div className="grid4" style={{ marginTop: 16 }}>
        <KPICard label={`Currently on ART (${lastReal.month || '—'})`} value={fmt(lastReal.art_curr)} icon={HeartPulse} accent={C.chartBlue} />
        <KPICard label="On ART with VL Result" value={fmt(lastReal.art_vl_tested)} icon={ShieldCheck} accent={C.chartTeal} />
        <KPICard label="VL-Monitoring Coverage" value={vlPct != null ? `${vlPct.toFixed(1)}%` : '—'} icon={Activity} accent={vlPct >= 80 ? C.chartGreen : C.chartAmber} />
        <KPICard label={`Viral Load Suppression Rate (${lastSuppressed?.month || '—'})`} value={lastSuppressed ? `${lastSuppressed.art_vl_suppressed_pct}%` : '—'} icon={ShieldCheck} accent={lastSuppressed?.art_vl_suppressed_pct >= 95 ? C.chartGreen : C.chartAmber} />
      </div>
      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`Currently on ART — ${scoped.label}`} icon={HeartPulse} info="Real monthly count of people currently receiving ART (NDARS ART Monthly_3, Female+Male). Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="art_curr" name="Currently on ART" color={C.chartBlue} />
          <SourceLine>NDARS (system_id=7), indicator "ART Monthly_3_Currently on ART", Female + Male.</SourceLine>
        </Card>
        <Card title={`On ART with a VL Result — ${scoped.label}`} icon={ShieldCheck} info="Real monthly count of ART patients who also received a viral-load test that month -- a monitoring-INTENSITY proxy (how many got checked), distinct from the suppression-RATE chart alongside it (of those checked, how many were actually suppressed).">
          <SplitLineChart data={scoped.series} dataKey="art_vl_tested" name="On ART w/ VL result" color={C.chartTeal} />
          <SourceLine>NDARS (system_id=7), indicator "ART Monthly_6a_Currently on ART with VL result", Female + Male.</SourceLine>
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`Viral Load Suppression Rate — ${scoped.label}`} icon={ShieldCheck}
          info="Real NDARS indicator 'ART: Percentage Virally Suppressed' (system_id=7) -- reported directly as a per-facility percentage (not a count), so this is AVERAGED across facilities/states when combining areas, never summed (summing percentages is meaningless). No paired raw suppressed/tested COUNT indicator exists in the warehouse to weight this by facility size, so a multi-facility/state scope's figure is an equal-weighted average across reporting facilities, not a patient-count-weighted true national rate -- disclosed here rather than presented as more precise than it is. Solid = reported; dashed = calendar-month climatology forecast. This is the field that fills the 'no clean suppression %' gap this dashboard previously disclosed -- found on a follow-up indicator sweep and added once confirmed real and well-covered (37 states, back to 2014).">
          <SplitLineChart data={scoped.series} dataKey="art_vl_suppressed_pct" name="VL suppression rate" color={C.chartGreen} yTickFmt={v => `${v}%`} />
          <SourceLine>NDARS (system_id=7), indicator "ART: Percentage Virally Suppressed" (facility-grain %, averaged up).</SourceLine>
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card title={`Cervical Cancer Screening (Women Living with HIV, on ART) — ${scoped.label}`} icon={Activity}
          info="Real NDARS cervical cancer screening cascade for women living with HIV who are on ART (system_id=7): Negative, Positive, Suspected Cancer, and Referred outcomes. This category was previously assumed too sparse to chart (>90% missing is true for most of NDARS's Viral Hepatitis/Cervical Cancer/DQA indicators), but this specific cascade turned out to have strong, genuine coverage (37 of 37 states) once re-checked -- added after that follow-up sweep rather than left out on the earlier, broader assumption. Solid = reported; dashed = calendar-month climatology forecast.">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={cacxTrendSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={cacxTrendSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              {CACX_FIELDS.map(f => (
                <React.Fragment key={f}>
                  <Line type="monotone" dataKey={`${f}_actual`} name={CACX_LABELS[f]} stroke={CACX_COLORS[f]} strokeWidth={2.2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={`${f}_forecast`} name={`${CACX_LABELS[f]} (forecast)`} stroke={CACX_COLORS[f]} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                </React.Fragment>
              ))}
            </LineChart>
          </ResponsiveContainer>
          <SourceLine>NDARS (system_id=7), "ART Monthly_23a-d_WLHIV on ART screened for cervical cancer" (NEG/POS/Suspected Cancer/Referred).</SourceLine>
        </Card>
      </div>
    </>
  )
}

/* ============================== ROOT ============================== */
export default function HivManagerDashboard() {
  const [burden, setBurden] = useState(null)
  const [kpSocio, setKpSocio] = useState(null)
  const [page, setPage] = useState('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  useEffect(() => {
    fetch(`${BASE}data/after/hiv/burden_rich.json`).then(r => r.json()).then(setBurden).catch(() => {})
    fetch(`${BASE}data/after/hiv/kp_socio.json`).then(r => r.json()).then(setKpSocio).catch(() => {})
  }, [])

  const months = burden?.months || []
  const lastIdx = Math.max(0, months.findIndex(m => m.forecast) - 1 >= 0 ? months.findIndex(m => m.forecast) - 1 : months.length - 1)
  useEffect(() => { if (burden && filters.monthIdx == null) setFilters(f => ({ ...f, monthIdx: lastIdx })) }, [burden])

  const effectiveMonthIdx = useMemo(() => {
    if (filters.periodMode === 'year') {
      const y = filters.years.length ? Math.max(...filters.years) : null
      if (y != null) {
        const opts = months.map((m, i) => ({ i, y: +m.ym.split('-')[0] })).filter(m => m.y === y)
        if (opts.length) return opts[opts.length - 1].i
      }
    }
    return filters.monthIdx ?? lastIdx
  }, [filters.periodMode, filters.years, filters.monthIdx, months, lastIdx])

  const M = useHivModel(burden, effectiveMonthIdx)
  const scoped = useHivScopedSeries(burden, filters, M)
  const kpScoped = useKpScopedSeries(kpSocio, filters)

  const metaTxt = {
    overview: { title: 'Command Overview', sub: 'National HIV summary — real NDARS testing, treatment & PMTCT data' },
    testing: { title: 'Testing & Case-Finding', sub: 'HTS testing volume, results & positivity' },
    treatment: { title: 'Treatment & Care', sub: 'ART coverage & viral-load monitoring' },
  }[page]

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
        .miq-root .sidebarFoot { padding: 12px 8px 4px; border-top: 1px solid ${C.border}; margin-top: 10px; }
        .miq-root .miqMain { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; }
        .miq-root .topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 26px; background: var(--miq-topbar-blur); backdrop-filter: blur(6px); border-bottom: 1px solid ${C.border}; flex-wrap: wrap; gap: 12px; }
        .miq-root .topTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; }
        .miq-root .topSub { font-size: 12px; color: ${C.textFaint}; margin-top: 2px; }
        .miq-root .content { padding: 20px 26px 40px; }
        .miq-root .selectWrap { display: flex; flex-direction: column; gap: 4px; }
        .miq-root .selectLabel { font-size: 9.5px; letter-spacing: 0.6px; color: ${C.textFaint}; font-weight: 600; }
        .miq-root .selectBox { display: flex; align-items: center; gap: 6px; background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 7px; padding: 6px 8px; }
        .miq-root .selectBox select { background: transparent; border: none; color: ${C.text}; font-size: 12px; appearance: none; cursor: pointer; max-width: 168px; }
        .miq-root .miqResetBtn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid ${C.teal}; background: ${C.teal}12; color: ${C.teal}; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
        .miq-root .miqResetBtn:hover:not(:disabled) { background: ${C.teal}22; }
        .miq-root .miqResetBtn:disabled { opacity: 0.4; cursor: default; border-color: ${C.border}; color: ${C.textFaint}; background: transparent; }
        .miq-root .card { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .miq-root .cardHead { display: flex; justify-content: space-between; align-items: center; padding: 13px 18px; border-bottom: 1px solid ${C.border}; }
        .miq-root .cardTitle { font-size: 12.8px; font-weight: 600; letter-spacing: 0.1px; }
        .miq-root .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .miq-root .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .miq-root .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        @media (max-width: 1100px) { .miq-root .grid3 { grid-template-columns: 1fr 1fr; } .miq-root .grid4 { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 800px) { .miq-root .grid2, .miq-root .grid3, .miq-root .grid4 { grid-template-columns: 1fr; } .miq-root .sidebar { display: none; } }
        .miq-root .kpi { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; padding: 14px 16px; }
        .miq-root .kpiTop { display: flex; justify-content: space-between; align-items: flex-start; }
        .miq-root .kpiLabel { font-size: 11px; color: ${C.textDim}; }
        .miq-root .kpiIconWrap { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
        .miq-root .kpiValue { font-family: 'Space Grotesk', sans-serif; font-size: 22px; font-weight: 700; margin-top: 8px; }
        .miq-root .kpiDelta { display: flex; align-items: center; gap: 3px; font-size: 11px; margin-top: 6px; }
        .miq-root .rankRow { display: flex; align-items: center; gap: 10px; }
        .miq-root .rankNo { width: 18px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: ${C.textFaint}; }
        .miq-root .tagRegion { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; }
      `}</style>

      <Sidebar page={page} setPage={setPage} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
      <div className="miqMain">
        <TopBar title={metaTxt.title} subtitle={metaTxt.sub} filters={filters} setFilters={setFilters} burden={burden} months={months} lastIdx={lastIdx} />
        <div className="content">
          {!M || !scoped ? (
            <div style={{ padding: 60, textAlign: 'center', color: C.textDim }}>Loading real HIV data…</div>
          ) : <>
            <SelectionBanner filters={filters} months={months} lastIdx={lastIdx} />
            {page === 'overview' && <OverviewPage M={M} scoped={scoped} filters={filters} setFilters={setFilters} />}
            {page === 'testing' && <TestingPage scoped={scoped} kpScoped={kpScoped} kpSocio={kpSocio} />}
            {page === 'treatment' && <TreatmentPage scoped={scoped} />}
          </>}
        </div>
      </div>
    </div>
  )
}
