import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import DeckGL from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { Map as GLMap } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  LineChart, Line, Area, BarChart, Bar, ComposedChart,
  ScatterChart, Scatter, Treemap,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ZAxis
} from 'recharts'
import {
  LayoutDashboard, Map as MapIcon, Syringe, ShieldCheck, Target,
  ChevronDown, ArrowUpRight, ArrowDownRight, AlertTriangle,
  Droplets, CloudRain, Thermometer, Activity, Search, PanelLeftClose, PanelLeftOpen
} from 'lucide-react'
import { scoreDetail, buildZones } from '../burdenScore'
import { lgaKeyFor } from '../lgaAlias'
import { BLANK_MAP_STYLE } from '../mapStyle'

// ────────────────────────────────────────────────────────────────────────────
// "MalariaIQ" command console — visual design supplied by the FMOH programme
// lead (constellation-map dashboard, now in a light theme with a collapsible
// sidebar). Every number on screen is wired to real data: burden.json's real
// monthly indicators (now spanning Jan 2023 - Mar 2027, actual + forecast),
// the live forecast trajectory, and the model's own validation metrics.
// Hotspot colour/score uses the EXACT SAME scoring engine as Visual Overview
// (../burdenScore) so the two views can never disagree on a zone or count.
// ────────────────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL || '/'

/* ============================== DESIGN TOKENS (light) ============================== */
const C = {
  bg: '#f6f8fb', panel: '#ffffff', panelAlt: '#f1f5f9', panel2: '#f8fafc',
  border: '#e6ebf1', borderLight: '#cbd5e1', text: '#0f2230', textDim: '#51637a',
  textFaint: '#8496ad', teal: '#0d9488', tealLight: '#0e8a80', azure: '#2563eb',
  red: '#dc2626', amber: '#d97706', yellow: '#ca8a04', green: '#16a34a', purple: '#7c3aed',
  // Lighter, softer variants used specifically for chart series (lines/bars/
  // areas/funnel) -- kept SEPARATE from the tokens above so zone colours
  // (Red/Amber/Yellow/Green, which carry real severity meaning on the map
  // and legends) and UI chrome (buttons, icons, nav) stay at their original,
  // more assertive shades; only the graphs themselves get the lighter look.
  chartBlue: '#60a5fa', chartTeal: '#2dd4bf', chartPurple: '#a78bfa',
  chartAmber: '#fbbf24', chartRed: '#f87171', chartGreen: '#4ade80',
}
const INK = '#0f2230'   // dark text placed ON a coloured shape (map node, treemap cell)
// Zone keys match ../burdenScore's scoreToZone() output EXACTLY -- no lowercase
// re-keying, so a state's `dominant`/`zone` string can be used directly here.
const ZONE_ORDER = ['Red', 'Amber', 'Yellow', 'Green', 'Not a Hotspot']
const ZONE_COLORS = { 'Red': C.red, 'Amber': C.amber, 'Yellow': C.yellow, 'Green': C.green, 'Not a Hotspot': '#64748b' }
const ZONE_LABELS = { 'Red': 'Red Zone', 'Amber': 'Amber Zone', 'Yellow': 'Yellow Zone', 'Green': 'Green Zone', 'Not a Hotspot': 'Not a Hotspot' }
const REGION_COLORS = { NW: '#38BDF8', NC: '#818CF8', NE: '#A78BFA', SW: '#F472B6', SE: '#FB923C', SS: '#34D399' }

// Static geography only (hex-grid layout + geopolitical zone) — not data.
// `key` is how the name appears in burden.json; `name`/`code` are display-only.
const STATE_GRID = [
  { name: 'Sokoto', key: 'Sokoto', code: 'SK', region: 'NW', col: 2, row: 0 },
  { name: 'Kebbi', key: 'Kebbi', code: 'KB', region: 'NW', col: 1, row: 1 },
  { name: 'Zamfara', key: 'Zamfara', code: 'ZM', region: 'NW', col: 3, row: 1 },
  { name: 'Katsina', key: 'Katsina', code: 'KT', region: 'NW', col: 4, row: 0 },
  { name: 'Jigawa', key: 'Jigawa', code: 'JG', region: 'NW', col: 6, row: 0 },
  { name: 'Kano', key: 'Kano', code: 'KN', region: 'NW', col: 5, row: 1 },
  { name: 'Kaduna', key: 'Kaduna', code: 'KD', region: 'NW', col: 4, row: 2 },
  { name: 'Yobe', key: 'Yobe', code: 'YB', region: 'NE', col: 8, row: 0 },
  { name: 'Borno', key: 'Borno', code: 'BO', region: 'NE', col: 9, row: 1 },
  { name: 'Bauchi', key: 'Bauchi', code: 'BA', region: 'NE', col: 7, row: 2 },
  { name: 'Gombe', key: 'Gombe', code: 'GM', region: 'NE', col: 8, row: 2 },
  { name: 'Adamawa', key: 'Adamawa', code: 'AD', region: 'NE', col: 9, row: 3 },
  { name: 'Taraba', key: 'Taraba', code: 'TR', region: 'NE', col: 8, row: 4 },
  { name: 'Niger', key: 'Niger', code: 'NG', region: 'NC', col: 2, row: 3 },
  { name: 'FCT', key: 'Federal Capital Territory', code: 'FC', region: 'NC', col: 5, row: 3 },
  { name: 'Nasarawa', key: 'Nasarawa', code: 'NS', region: 'NC', col: 6, row: 3 },
  { name: 'Kwara', key: 'Kwara', code: 'KW', region: 'NC', col: 1, row: 4 },
  { name: 'Kogi', key: 'Kogi', code: 'KG', region: 'NC', col: 3, row: 4 },
  { name: 'Benue', key: 'Benue', code: 'BN', region: 'NC', col: 6, row: 4 },
  { name: 'Plateau', key: 'Plateau', code: 'PL', region: 'NC', col: 7, row: 3 },
  { name: 'Oyo', key: 'Oyo', code: 'OY', region: 'SW', col: 1, row: 5 },
  { name: 'Osun', key: 'Osun', code: 'OS', region: 'SW', col: 2, row: 5 },
  { name: 'Ekiti', key: 'Ekiti', code: 'EK', region: 'SW', col: 3, row: 5 },
  { name: 'Ondo', key: 'Ondo', code: 'ON', region: 'SW', col: 3, row: 6 },
  { name: 'Ogun', key: 'Ogun', code: 'OG', region: 'SW', col: 1, row: 6 },
  { name: 'Lagos', key: 'Lagos', code: 'LA', region: 'SW', col: 0, row: 6 },
  { name: 'Enugu', key: 'Enugu', code: 'EN', region: 'SE', col: 5, row: 5 },
  { name: 'Ebonyi', key: 'Ebonyi', code: 'EB', region: 'SE', col: 6, row: 5 },
  { name: 'Anambra', key: 'Anambra', code: 'AN', region: 'SE', col: 4, row: 6 },
  { name: 'Imo', key: 'Imo', code: 'IM', region: 'SE', col: 5, row: 6 },
  { name: 'Abia', key: 'Abia', code: 'AB', region: 'SE', col: 6, row: 6 },
  { name: 'Edo', key: 'Edo', code: 'ED', region: 'SS', col: 2, row: 7 },
  { name: 'Delta', key: 'Delta', code: 'DE', region: 'SS', col: 1, row: 7 },
  { name: 'Bayelsa', key: 'Bayelsa', code: 'BY', region: 'SS', col: 1, row: 8 },
  { name: 'Rivers', key: 'Rivers', code: 'RI', region: 'SS', col: 3, row: 8 },
  { name: 'Akwa Ibom', key: 'Akwa Ibom', code: 'AK', region: 'SS', col: 5, row: 8 },
  { name: 'Cross River', key: 'Cross River', code: 'CR', region: 'SS', col: 6, row: 7 },
]
const REGIONS_META = [
  { code: 'NW', name: 'North West' }, { code: 'NC', name: 'North Central' },
  { code: 'NE', name: 'North East' }, { code: 'SW', name: 'South West' },
  { code: 'SE', name: 'South East' }, { code: 'SS', name: 'South South' },
]
const FIELD_KEYS = ['cases', 'total', 'trend', 'fever_testing', 'act', 'treated', 'rain', 'temp', 'hum', 'itn', 'llin', 'ipt_cov']

/* ============================== HELPERS ============================== */
function fmt(n, opts = {}) {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(opts.d ?? 1) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(opts.d ?? 1) + 'K'
  return Math.round(n).toLocaleString()
}
function gridToXY(col, row) {
  const hexW = 62, hexH = 54
  const x = col * hexW + (row % 2 === 1 ? hexW / 2 : 0) + 40
  const y = row * hexH + 30
  return { x, y }
}
function lastIdxNonForecast(months) {
  let idx = -1
  months.forEach((m, i) => { if (!m.forecast) idx = i })
  return idx
}
function avg(a) { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null }
function sum(a) { return a.filter(x => x != null && !isNaN(x)).reduce((s, x) => s + x, 0) }
// Splits each of `keys` into `${key}_actual` (null once the forecast starts)
// and `${key}_forecast` (null before it) so a chart can draw the real portion
// solid and the forecast portion dashed. The last actual month is duplicated
// into BOTH fields (the "connector") so the dashed segment starts exactly
// where the solid one ends, instead of leaving a visible gap.
function withForecastSplit(series, keys) {
  const firstForecastIdx = series.findIndex(d => d.forecast)
  return series.map((d, i) => {
    const isConnector = firstForecastIdx > 0 && i === firstForecastIdx - 1
    const isForecastPart = firstForecastIdx !== -1 && i >= firstForecastIdx
    const out = { ...d }
    for (const key of keys) {
      const v = d[key]
      out[`${key}_actual`] = !isForecastPart ? v : null
      out[`${key}_forecast`] = (isForecastPart || isConnector) ? v : null
    }
    return out
  })
}
// One monthly row shaped identically whether it came from summing several
// states or reading a single LGA/state directly -- so every chart/KPI below
// can stay agnostic to which grain the current filter resolved to.
function rowFrom(b, m, i) {
  if (!b) return { month: m.label, ym: m.ym, forecast: m.forecast, cases: 0, total: 0, rain: null, act: 0, llin: 0, rdt: 0, severeTreated: 0, iptv: null, feverTest: null, iptp1: 0, iptp2: 0, iptp3: 0, iptp4: 0 }
  return {
    month: m.label, ym: m.ym, forecast: m.forecast,
    cases: b.cases?.[i] ?? 0, total: b.total?.[i] ?? 0, rain: b.rain?.[i] ?? null,
    act: b.act?.[i] ?? 0, llin: b.llin?.[i] ?? 0, rdt: b.rdt_done?.[i] ?? 0, severeTreated: b.severe_treated?.[i] ?? 0,
    iptv: b.ipt_cov?.[i] > 0 ? b.ipt_cov[i] : null, feverTest: b.fever_testing?.[i] > 0 ? b.fever_testing[i] : null,
    iptp1: b.iptp1_n?.[i] ?? 0, iptp2: b.iptp2_n?.[i] ?? 0, iptp3: b.iptp3_n?.[i] ?? 0, iptp4: b.iptp4_n?.[i] ?? 0,
  }
}
// Every LGA name (sorted) that burden.lgas actually has data for, within one state.
function lgaNamesForState(burden, stateName) {
  if (!burden?.lgas || !stateName || stateName === 'All') return []
  const prefix = `${stateName}|||`
  return Object.keys(burden.lgas).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)).sort()
}
function buildUnitsAt(store, idx) {
  return Object.keys(store || {}).map(key => {
    const a = store[key]
    const x = {}
    FIELD_KEYS.forEach(f => { x[f] = a[f] ? (a[f][idx] ?? 0) : 0 })
    return { key, x }
  })
}

/* ============================== SHARED UI ============================== */
// A working ⓘ tooltip, rendered through a PORTAL straight into <body> --
// every Card here sits inside a `.card` with `overflow:hidden` (needed to
// clip chart corners to the card's rounded edges), so a normal absolutely-
// positioned tooltip nested inside it gets silently clipped/invisible the
// moment it would extend past the card's own bounds. Rendering into a portal
// escapes that clipping entirely, and the position is computed from the
// icon's real screen coordinates (clamped to stay on-screen) so it never
// overflows the viewport either.
function MiqInfoTip({ text, title, w = 270 }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const place = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))
    setPos({ top: r.bottom + 8, left })
  }
  if (!text) return null
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
      onMouseEnter={() => { place(); setOpen(true) }} onMouseLeave={() => setOpen(false)}>
      <span onClick={e => { e.stopPropagation(); if (open) { setOpen(false) } else { place(); setOpen(true) } }}
        style={{ cursor: 'help', width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
          background: `${C.teal}20`, color: C.teal, fontSize: 10, fontWeight: 800,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontStyle: 'italic',
          border: `1px solid ${C.teal}55`, userSelect: 'none' }}>i</span>
      {open && pos && createPortal(
        <div style={{ position: 'fixed', zIndex: 9999, top: pos.top, left: pos.left, width: w,
          background: C.text, color: '#fff', borderRadius: 9, padding: '10px 12px', fontSize: 12,
          lineHeight: 1.55, fontWeight: 400, fontStyle: 'normal', textAlign: 'left',
          boxShadow: '0 10px 34px rgba(0,0,0,.32)', pointerEvents: 'none' }}>
          {title && <b style={{ display: 'block', color: C.tealLight, marginBottom: 3 }}>{title}</b>}
          {text}
        </div>, document.body
      )}
    </span>
  )
}
function Card({ title, icon: Icon, tag, right, info, children, style, bodyStyle }) {
  return (
    <div className="card" style={style}>
      {title && (
        <div className="cardHead">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {Icon && <Icon size={15} color={C.tealLight} strokeWidth={2.2} />}
            <span className="cardTitle">{title}</span>
            {tag && <span className="tag">{tag}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{right}{info && <MiqInfoTip text={info} />}</div>
        </div>
      )}
      <div style={{ padding: '14px 18px 18px', ...bodyStyle }}>{children}</div>
    </div>
  )
}
function KPICard({ label, value, delta, deltaGood, icon: Icon, accent, deltaLabel }) {
  const hasDelta = delta !== undefined && delta !== null
  const up = hasDelta && delta >= 0
  const goodColor = deltaGood ? C.green : C.red
  const badColor = deltaGood ? C.red : C.green
  return (
    <div className="kpi">
      <div className="kpiTop">
        <span className="kpiLabel">{label}</span>
        <div className="kpiIconWrap" style={{ background: (accent || C.teal) + '22' }}><Icon size={14} color={accent || C.tealLight} strokeWidth={2.2} /></div>
      </div>
      <div className="kpiValue">{value}</div>
      {hasDelta && (
        <div className="kpiDelta" style={{ color: up ? goodColor : badColor }}>
          {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          <span>{Math.abs(delta).toFixed(1)}% {deltaLabel || 'vs prior period'}</span>
        </div>
      )}
    </div>
  )
}
function ZoneLegend({ compact }) {
  return (
    <div style={{ display: 'flex', gap: compact ? 10 : 16, flexWrap: 'wrap' }}>
      {ZONE_ORDER.map(z => (
        <div key={z} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: ZONE_COLORS[z], display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: C.textDim }}>{ZONE_LABELS[z]}</span>
        </div>
      ))}
    </div>
  )
}
function CustomTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.borderLight}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, boxShadow: '0 8px 24px rgba(15,34,48,0.14)' }}>
      {label && <div style={{ color: C.textDim, marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', color: C.text }}>
          <span style={{ color: p.color || p.fill }}>{p.name}</span>
          <strong style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{typeof p.value === 'number' ? fmt(p.value) : p.value}{suffix || ''}</strong>
        </div>
      ))}
    </div>
  )
}
function Select({ value, onChange, options, label }) {
  return (
    <label className="selectWrap">
      <span className="selectLabel">{label}</span>
      <div className="selectBox">
        <select value={value} onChange={e => onChange(e.target.value)}>
          {options.map(o => {
            const opt = (o != null && typeof o === 'object') ? o : { value: o, label: o }
            return <option key={opt.value} value={opt.value}>{opt.label}</option>
          })}
        </select>
        <ChevronDown size={13} color={C.textDim} />
      </div>
    </label>
  )
}
// Combined ZONE -> STATE -> LGA hierarchy in ONE searchable dropdown (Power
// BI-style tree slicer) instead of 3 separate selects -- picking any node
// selects it (single-select, this app's filter model is one active
// location at a time) and closes the panel. Uses the same fixed-position
// createPortal pattern as MiqInfoTip above so the panel escapes the
// scrolling/`overflow:hidden` dashboard shell instead of getting clipped.
function Box({ checked }) {
  return (
    <span style={{
      width: 13, height: 13, borderRadius: 3, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: `1.5px solid ${checked ? C.teal : C.borderLight}`, background: checked ? C.teal : 'transparent',
    }}>
      {checked && <span style={{ color: '#fff', fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
    </span>
  )
}
// Generic flat multi-select dropdown (checkbox list + "All" + optional
// search), same portal/positioning mechanics as LocationTreeFilter but
// without the tree/expand levels -- used for YEARS and MONTHS so the topbar
// shows one compact trigger each instead of a permanently-open row of chips
// (which got unmanageable once MONTHS could show up to 51 options at once).
function MultiSelectDropdown({ label, options, selected, onToggle, onClear, searchable, minWidth = 90 }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    setPos({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 180) })
  }
  const toggle = () => { if (open) setOpen(false); else { place(); setOpen(true) } }

  const triggerLabel = !selected.length ? 'All'
    : selected.length <= 2 ? options.filter(o => selected.includes(o.value)).map(o => o.label).join(', ')
    : `${selected.length} selected`

  const q = search.trim().toLowerCase()
  const shown = options.filter(o => !q || o.label.toLowerCase().includes(q))

  return (
    <label className="selectWrap" style={{ position: 'relative' }}>
      <span className="selectLabel">{label}</span>
      <button ref={btnRef} onClick={toggle} className="selectBox"
        style={{ cursor: 'pointer', minWidth, justifyContent: 'space-between', width: '100%' }}>
        <span style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerLabel}</span>
        <ChevronDown size={13} color={C.textDim} style={{ flexShrink: 0 }} />
      </button>
      {open && pos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', zIndex: 9999, top: pos.top, left: pos.left, width: Math.max(pos.width, 170), maxHeight: 320,
            overflowY: 'auto', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
            boxShadow: '0 14px 40px rgba(0,0,0,.18)', padding: 8,
          }}>
            {searchable && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, borderRadius: 7, padding: '6px 8px', marginBottom: 6, background: C.panel2 }}>
                <Search size={13} color={C.textFaint} />
                <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                  style={{ border: 'none', outline: 'none', fontSize: 12.5, flex: 1, fontFamily: 'inherit', background: 'transparent', color: C.text }} />
              </div>
            )}
            <div onClick={onClear} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 8px', borderRadius: 6 }}>
              <Box checked={!selected.length} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>All</span>
            </div>
            {shown.map(o => (
              <div key={o.value} onClick={() => onToggle(o.value)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 8px', borderRadius: 6 }}>
                <Box checked={selected.includes(o.value)} />
                <span style={{ fontSize: 12, color: selected.includes(o.value) ? C.teal : C.text, fontWeight: selected.includes(o.value) ? 700 : 500 }}>{o.label}</span>
              </div>
            ))}
            {!shown.length && <div style={{ padding: '6px 8px', fontSize: 11.5, color: C.textFaint }}>No matches.</div>}
          </div>
        </>, document.body
      )}
    </label>
  )
}
function LocationTreeFilter({ filters, setFilters, burden }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [expZones, setExpZones] = useState(() => new Set())
  const [expStates, setExpStates] = useState(() => new Set())
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    setPos({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 300) })
  }
  const toggle = () => { if (open) setOpen(false); else { place(); setOpen(true) } }

  const label = filters.lgas.length ? (filters.lgas.length <= 2 ? filters.lgas.map(k => k.split('|||')[1]).join(', ') : `${filters.lgas.length} LGAs`)
    : filters.locations.length ? (filters.locations.length <= 2 ? filters.locations.join(', ') : `${filters.locations.length} States`)
    : filters.region !== 'All' ? (REGIONS_META.find(r => r.code === filters.region)?.name || filters.region)
    : 'All Locations'

  const q = search.trim().toLowerCase()

  // States and LGAs are multi-select but mutually exclusive -- picking either
  // kind clears the other, so the rest of the dashboard never has to reason
  // about a mixed state+LGA scope. A ZONE pick is still single-select and
  // resets both (a clean "just this zone" scope).
  const pickZone = z => { setFilters(f => ({ ...f, region: z, locations: [], lgas: [] })); setOpen(false) }
  const toggleState = st => setFilters(f => {
    const has = f.locations.includes(st)
    return { ...f, locations: has ? f.locations.filter(x => x !== st) : [...f.locations, st], lgas: [] }
  })
  const toggleLga = key => setFilters(f => {
    const has = f.lgas.includes(key)
    return { ...f, lgas: has ? f.lgas.filter(x => x !== key) : [...f.lgas, key], locations: [] }
  })
  const clearAll = () => { setFilters(f => ({ ...f, region: 'All', locations: [], lgas: [] })); setOpen(false) }

  return (
    <label className="selectWrap" style={{ position: 'relative' }}>
      <span className="selectLabel">LOCATION</span>
      <button ref={btnRef} onClick={toggle} className="selectBox"
        style={{ cursor: 'pointer', minWidth: 160, justifyContent: 'space-between', width: '100%' }}>
        <span style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronDown size={13} color={C.textDim} style={{ flexShrink: 0 }} />
      </button>
      {open && pos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'fixed', zIndex: 9999, top: pos.top, left: pos.left, width: pos.width, maxHeight: 420,
            overflowY: 'auto', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
            boxShadow: '0 14px 40px rgba(0,0,0,.18)', padding: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, borderRadius: 7, padding: '6px 8px', marginBottom: 6, background: C.panel2 }}>
              <Search size={13} color={C.textFaint} />
              <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search state or LGA…"
                style={{ border: 'none', outline: 'none', fontSize: 12.5, flex: 1, fontFamily: 'inherit', background: 'transparent', color: C.text }} />
            </div>
            {(!!filters.locations.length || !!filters.lgas.length) && (
              <div style={{ fontSize: 10.5, color: C.textFaint, padding: '2px 8px 6px' }}>
                {filters.lgas.length ? 'Multiple LGAs -- checking a state is disabled until these are cleared.' : 'Multiple states -- checking an LGA is disabled until these are cleared.'}
              </div>
            )}
            <div onClick={clearAll} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 8px', borderRadius: 6 }}>
              <Box checked={filters.region === 'All' && !filters.locations.length && !filters.lgas.length} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>All Locations (national)</span>
            </div>
            {REGIONS_META.map(r => {
              const statesInZone = STATE_GRID.filter(s => s.region === r.code).map(s => s.name).sort()
              const statesShown = statesInZone.filter(s => !q || s.toLowerCase().includes(q) || lgaNamesForState(burden, s).some(l => l.toLowerCase().includes(q)))
              if (q && !r.name.toLowerCase().includes(q) && !statesShown.length) return null
              const isExp = expZones.has(r.code) || !!q
              return (
                <div key={r.code}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6 }}>
                    <span onClick={() => setExpZones(s => { const n = new Set(s); n.has(r.code) ? n.delete(r.code) : n.add(r.code); return n })}
                      style={{ cursor: 'pointer', width: 14, display: 'inline-block', color: C.textFaint, userSelect: 'none' }}>{isExp ? '▾' : '▸'}</span>
                    <span onClick={() => pickZone(r.code)}
                      style={{ cursor: 'pointer', flex: 1, fontSize: 12.5, fontWeight: 700, color: filters.region === r.code && !filters.locations.length && !filters.lgas.length ? C.teal : C.text }}>{r.name}</span>
                  </div>
                  {isExp && (
                    <div style={{ marginLeft: 18 }}>
                      {(q ? statesShown : statesInZone).map(s => {
                        const lgas = lgaNamesForState(burden, s)
                        const lgasShown = lgas.filter(l => !q || l.toLowerCase().includes(q))
                        const stExp = expStates.has(s) || (!!q && lgasShown.length > 0 && lgasShown.length < lgas.length)
                        const stateDisabled = filters.lgas.length > 0
                        return (
                          <div key={s}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6 }}>
                              <span onClick={() => setExpStates(set => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n })}
                                style={{ cursor: 'pointer', width: 14, display: 'inline-block', color: C.textFaint, userSelect: 'none' }}>{stExp || (q && lgasShown.length) ? '▾' : '▸'}</span>
                              <span onClick={() => !stateDisabled && toggleState(s)}
                                style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1, cursor: stateDisabled ? 'not-allowed' : 'pointer', opacity: stateDisabled ? 0.4 : 1 }}>
                                <Box checked={filters.locations.includes(s)} />
                                <span style={{ fontSize: 12, fontWeight: 600, color: filters.locations.includes(s) ? C.teal : C.text }}>{s}</span>
                              </span>
                            </div>
                            {(stExp || (q && lgasShown.length > 0)) && (
                              <div style={{ marginLeft: 18 }}>
                                {lgasShown.map(l => {
                                  const key = `${s}|||${l}`
                                  const lgaDisabled = filters.locations.length > 0
                                  return (
                                    <div key={l} onClick={() => !lgaDisabled && toggleLga(key)}
                                      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 8px', cursor: lgaDisabled ? 'not-allowed' : 'pointer', borderRadius: 6, opacity: lgaDisabled ? 0.4 : 1 }}>
                                      <Box checked={filters.lgas.includes(key)} />
                                      <span style={{ fontSize: 11.5, color: filters.lgas.includes(key) ? C.teal : C.textDim, fontWeight: filters.lgas.includes(key) ? 700 : 400 }}>{l}</span>
                                    </div>
                                  )
                                })}
                                {!lgasShown.length && <div style={{ padding: '4px 8px', fontSize: 11.5, color: C.textFaint }}>No LGAs match.</div>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {q && !statesShown.length && <div style={{ padding: '4px 8px', fontSize: 11.5, color: C.textFaint }}>No matches.</div>}
                    </div>
                  )}
                </div>
              )
            })}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 6, marginTop: 4, borderTop: `1px solid ${C.border}` }}>
              <button onClick={() => setOpen(false)} className="miqResetBtn" style={{ height: 26, padding: '0 12px', fontSize: 11.5 }}>Done</button>
            </div>
          </div>
        </>, document.body
      )}
    </label>
  )
}

/* ============================== SIGNATURE: STATE CONSTELLATION MAP ============================== */
// Bubble SIZE = real case volume (magnitude); bubble COLOUR = real burden zone
// (severity) -- the same two-channel encoding common to epi dashboards, and
// crucially the colour now comes from the EXACT SAME scoring engine as Visual
// Overview, so a state that reads Red here reads Red there too.
// RGB fills matching ZONE_COLORS' hex values exactly, for deck.gl's
// getFillColor (which needs [r,g,b,a] arrays, not CSS hex strings).
const ZONE_FILL_RGB = {
  'Red': [220, 38, 38], 'Amber': [217, 119, 6], 'Yellow': [202, 138, 4],
  'Green': [22, 163, 74], 'Not a Hotspot': [100, 116, 139],
}
const RISKMAP_NIGERIA_VIEW = { longitude: 8.7, latitude: 9.3, zoom: 5.0, pitch: 0, bearing: 0 }

// Real Nigeria map (state or LGA grain, toggleable), replacing the old SVG
// hex-dot "constellation" -- same real burden zone per area, just drawn as
// actual geography instead of a stylised node graph. Clicking a state or LGA
// highlights it and drives the SAME filters.locations/filters.lgas the rest
// of this dashboard already reacts to.
function RiskMap({ points, lgaZones, selected, selectedLga, onSelect, onSelectLga, categoryFilter, regionFilter }) {
  const [statesGeo, setStatesGeo] = useState(null)
  const [lgasGeo, setLgasGeo] = useState(null)
  const [scope, setScope] = useState('states')
  const [hover, setHover] = useState(null)
  const [view, setView] = useState(RISKMAP_NIGERIA_VIEW)

  useEffect(() => {
    fetch(`${BASE}data/geo/states.geojson`).then(r => r.json()).then(setStatesGeo).catch(() => {})
    fetch(`${BASE}data/geo/lgas.geojson`).then(r => r.json()).then(setLgasGeo).catch(() => {})
  }, [])

  // Picking specific LGA(s) elsewhere (the LOCATION tree filter) should be
  // visible HERE too, not just narrow the charts silently -- auto-switch to
  // LGA view so the map can actually show them highlighted.
  useEffect(() => { if (selectedLga?.length) setScope('lgas') }, [selectedLga])

  const pointByName = useMemo(() => Object.fromEntries(points.map(p => [p.name, p])), [points])

  const layers = useMemo(() => {
    if (scope === 'states') {
      if (!statesGeo) return []
      const fillFor = name => {
        const p = pointByName[name]
        const dim = (categoryFilter && categoryFilter !== 'All' && p?.dominant !== categoryFilter) ||
                    (regionFilter && regionFilter !== 'All' && p?.region !== regionFilter)
        const rgb = ZONE_FILL_RGB[p?.dominant || 'Not a Hotspot']
        return [...rgb, dim ? 60 : 215]
      }
      return [new GeoJsonLayer({
        id: 'dash-states', data: statesGeo, pickable: true, stroked: true, filled: true,
        getFillColor: f => fillFor(f.properties.st),
        getLineColor: f => (selected.includes(f.properties.st) ? [15, 34, 48, 255] : [255, 255, 255, 255]),
        getLineWidth: f => (selected.includes(f.properties.st) ? 2.6 : 1),
        lineWidthMinPixels: 1,
        updateTriggers: { getFillColor: [pointByName, categoryFilter, regionFilter], getLineColor: selected, getLineWidth: selected },
        onClick: info => info.object && onSelect(info.object.properties.st),
        onHover: info => setHover(info.object ? { ...info, kind: 'state' } : null),
      })]
    }
    if (!lgasGeo) return []
    const regionByState = Object.fromEntries(STATE_GRID.map(s => [s.key, s.region]))
    const fillForLga = (stName, key) => {
      const zone = lgaZones[key]?.zone || 'Not a Hotspot'
      const dim = (categoryFilter && categoryFilter !== 'All' && zone !== categoryFilter) ||
                  (regionFilter && regionFilter !== 'All' && regionByState[stName] !== regionFilter)
      const rgb = ZONE_FILL_RGB[zone]
      return [...rgb, dim ? 55 : 210]
    }
    const lgaIsSelected = f => selectedLga.length ? selectedLga.includes(lgaKeyFor(f.properties.st, f.properties.lga)) : selected.includes(f.properties.st)
    return [new GeoJsonLayer({
      id: 'dash-lgas', data: lgasGeo, pickable: true, stroked: true, filled: true,
      getFillColor: f => fillForLga(f.properties.st, lgaKeyFor(f.properties.st, f.properties.lga)),
      getLineColor: f => (lgaIsSelected(f) ? [15, 34, 48, 255] : [255, 255, 255, 200]),
      getLineWidth: f => (lgaIsSelected(f) ? 2.2 : 0.4),
      lineWidthMinPixels: 0.4,
      updateTriggers: { getFillColor: [lgaZones, categoryFilter, regionFilter], getLineColor: [selected, selectedLga], getLineWidth: [selected, selectedLga] },
      onClick: info => info.object && (onSelectLga ? onSelectLga(info.object.properties.st, info.object.properties.lga) : onSelect(info.object.properties.st)),
      onHover: info => setHover(info.object ? { ...info, kind: 'lga' } : null),
    })]
  }, [scope, statesGeo, lgasGeo, pointByName, lgaZones, selected, selectedLga, categoryFilter, regionFilter])

  const ready = scope === 'states' ? !!statesGeo : !!lgasGeo

  return (
    <div>
      <div style={{ display: 'inline-flex', background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 3, marginBottom: 10 }}>
        {[['states', 'State view'], ['lgas', 'LGA view']].map(([k, lbl]) => (
          <button key={k} onClick={() => setScope(k)}
            style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
              fontFamily: 'inherit', background: scope === k ? C.panel : 'transparent', color: scope === k ? C.teal : C.textDim }}>{lbl}</button>
        ))}
      </div>
      <div style={{ position: 'relative', height: 430, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}` }}>
        {!ready && <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textFaint, fontSize: 12.5 }}>Loading map…</div>}
        {ready && (
          <DeckGL viewState={view} controller={true} layers={layers} onViewStateChange={e => setView(e.viewState)} style={{ position: 'absolute', inset: 0 }}>
            <GLMap mapStyle={BLANK_MAP_STYLE} />
          </DeckGL>
        )}
        {hover?.object && (() => {
          const name = hover.kind === 'state' ? hover.object.properties.st : hover.object.properties.st
          const p = pointByName[name]
          if (hover.kind === 'state' && !p) return null
          const zone = hover.kind === 'state' ? p.dominant : (lgaZones[lgaKeyFor(hover.object.properties.st, hover.object.properties.lga)]?.zone || 'Not a Hotspot')
          return (
            <div style={{ position: 'absolute', left: hover.x + 12, top: hover.y + 12, pointerEvents: 'none', background: C.panel, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '8px 11px', fontSize: 12, boxShadow: '0 8px 24px rgba(15,34,48,.16)', zIndex: 5, minWidth: 140 }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 3 }}>{hover.kind === 'state' ? hover.object.properties.st : hover.object.properties.lga}</div>
              {hover.kind === 'lga' && <div style={{ fontSize: 10.5, color: C.textFaint, marginBottom: 3 }}>{hover.object.properties.st}</div>}
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 700,
                background: ZONE_COLORS[zone] + '22', color: ZONE_COLORS[zone] }}>{ZONE_LABELS[zone]}</span>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

/* ============================== TOPBAR + SIDEBAR ============================== */
const NAV = [
  { id: 'overview', label: 'Command Overview', icon: LayoutDashboard },
  { id: 'iptp', label: 'IPTp Coverage', icon: Syringe },
  { id: 'intervention', label: 'Intervention Impact', icon: ShieldCheck },
]
function Sidebar({ page, setPage, collapsed, onToggle }) {
  return (
    <div className={`sidebar ${collapsed ? 'sidebarCollapsed' : ''}`}>
      <div className="brand">
        <div className="brandMark"><Activity size={17} color="#ffffff" strokeWidth={2.6} /></div>
        {!collapsed && <div style={{ flex: 1, minWidth: 0 }}><div className="brandTitle">Malaria</div><div className="brandSub">Predictive Analytics</div></div>}
        <button className="sidebarToggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={16} color={C.textDim} /> : <PanelLeftClose size={16} color={C.textDim} />}
        </button>
      </div>
      <div className="navList">
        {NAV.map(item => {
          const Icon = item.icon, active = page === item.id
          return (
            <button key={item.id} className={`navItem ${active ? 'navItemActive' : ''}`} onClick={() => setPage(item.id)}
              title={collapsed ? item.label : undefined}>
              <Icon size={16} strokeWidth={2.1} color={active ? C.teal : C.textDim} />
              {!collapsed && <span>{item.label}</span>}{!collapsed && active && <span className="navDot" />}
            </button>
          )
        })}
      </div>
      {!collapsed && (
        <div className="sidebarFoot">
          <div style={{ fontSize: 10.5, color: C.textFaint, lineHeight: 1.5 }}>National Malaria Elimination Programme<br />Nigeria · live warehouse data</div>
        </div>
      )}
    </div>
  )
}
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// `locations` (state names) and `lgas` (LGA keys, "State|||LGA") are both
// multi-select arrays and mutually exclusive -- the LOCATION filter is
// either "one or more states" or "one or more LGAs", never a mix, enforced
// by LocationTreeFilter's own click handlers (picking either kind clears
// the other).
export const DEFAULT_FILTERS = { periodMode: 'month', monthIdx: null, years: [], months: [], locations: [], region: 'All', lgas: [], category: 'All' }

// Selected-location + time-period summary, ALL CAPS, shared across every tab
// (Command Overview / IPTp / Intervention Impact) so it's always clear what
// slice of data is on screen without having to re-read every dropdown.
function SelectionBanner({ filters, months, lastIdx }) {
  const monthIdx = filters.monthIdx ?? lastIdx
  const cur = months[monthIdx]
  const monthRestrictLabel = filters.months.length
    ? `SHOWING ${filters.months.length} SELECTED MONTH${filters.months.length > 1 ? 'S' : ''} ONLY`
    : (filters.years.length ? `SHOWING ${filters.years.slice().sort((a, b) => a - b).join(', ')} ONLY` : '')
  const timeLabel = filters.periodMode === 'year'
    ? (filters.years.length ? `${filters.years.slice().sort((a, b) => a - b).join(', ')} (COMBINED)` : 'ALL YEARS')
    : ((cur ? cur.label.toUpperCase() + (cur.forecast ? ' (FORECAST)' : '') : '—')
      + (monthRestrictLabel ? ` · ${monthRestrictLabel}` : ''))
  const locLabel = filters.lgas.length === 1 ? `${filters.lgas[0].split('|||')[1]}, ${filters.lgas[0].split('|||')[0]}`
    : filters.lgas.length ? filters.lgas.map(k => k.split('|||')[1]).join(', ')
    : filters.locations.length ? filters.locations.join(', ')
    : filters.region !== 'All' ? (REGIONS_META.find(r => r.code === filters.region)?.name || filters.region)
    : 'NIGERIA (NATIONAL)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, fontWeight: 700,
      letterSpacing: '.3px', color: C.tealLight, background: `${C.teal}0f`, border: `1px solid ${C.teal}33`,
      borderRadius: 8, padding: '7px 12px', marginBottom: 16 }}>
      <MapIcon size={13} strokeWidth={2.4} />
      <span>VIEWING: {locLabel.toUpperCase()}</span>
      <span style={{ color: C.border }}>·</span>
      <span>{timeLabel}</span>
      {filters.category !== 'All' && (<><span style={{ color: C.border }}>·</span><span>{ZONE_LABELS[filters.category].toUpperCase()} ONLY</span></>)}
    </div>
  )
}

function TopBar({ title, subtitle, filters, setFilters, burden, months, lastIdx }) {
  const years = [...new Set(months.map(m => +m.ym.split('-')[0]))].sort((a, b) => a - b)
  const isDefault = !filters.locations.length && filters.region === 'All' && !filters.lgas.length &&
    filters.category === 'All' && filters.periodMode === 'month' && filters.monthIdx === lastIdx && !filters.years.length && !filters.months.length
  const resetAll = () => setFilters({ ...DEFAULT_FILTERS, monthIdx: lastIdx })

  // MONTH mode: MONTHS is a multi-select box row (like YEARS) -- picking one
  // or more specific months restricts every chart's x-axis to exactly those
  // points (even a single month, rendered as a single dot -- no line to draw
  // from one point, which is expected and fine). Scoped to whichever years
  // are currently checked in YEARS below, or every year when none are.
  const monthIdx = filters.monthIdx ?? lastIdx
  const cur = months[monthIdx]
  const monthOptions = months
    .map((m, i) => ({ i, y: +m.ym.split('-')[0], mo: +m.ym.split('-')[1] }))
    .filter(m => !filters.years.length || filters.years.includes(m.y))

  // YEAR mode: pick any number of years -- combined (summed/averaged) into
  // one aggregate point per selected year, instead of one point per month.
  // MONTH mode reuses this SAME `filters.years` field for a different job:
  // restricting which months the charts show at all (e.g. only Jan-Dec 2024),
  // left unaggregated -- one point per real month, just a narrower window.
  // MONTHS (filters.months) narrows further still, to an exact subset of
  // real months rather than a whole-year window. Toggle boxes (not a native
  // multi-select) since multi-select's ctrl/cmd-click gesture is rarely
  // discovered by anyone who isn't already looking for it. Year mode always
  // keeps >=1 year selected (combining zero years is meaningless); month
  // mode allows zero for both YEARS and MONTHS via their "All" box, meaning
  // "no restriction" -- the default, selected state for each.
  const toggleYear = y => setFilters(f => {
    const has = f.years.includes(y)
    const next = has ? f.years.filter(x => x !== y) : [...f.years, y]
    const years2 = (f.periodMode === 'year' && !next.length) ? f.years : next
    // Drop any checked MONTHS that fall outside the newly-checked years, and
    // snap the KPI-driving monthIdx to the latest month still valid, instead
    // of leaving either pointed at a year no longer in scope.
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
        <button className="miqResetBtn" onClick={resetAll} disabled={isDefault} title="Reset every filter back to the national view, latest real month">
          ↺ Reset
        </button>

        <label className="selectWrap">
          <span className="selectLabel">PERIOD MODE</span>
          <div style={{ display: 'inline-flex', background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 7, padding: 2 }}>
            {[['month', '📅 Month'], ['year', '🗓️ Year']].map(([m, lbl]) => (
              <button key={m} onClick={() => switchMode(m)}
                style={{ border: 'none', cursor: 'pointer', padding: '5px 9px', borderRadius: 5, fontSize: 11.5, fontWeight: 600,
                  fontFamily: 'inherit', background: filters.periodMode === m ? C.panel : 'transparent', color: filters.periodMode === m ? C.teal : C.textDim }}>{lbl}</button>
            ))}
          </div>
        </label>

        {filters.periodMode === 'month' ? (
          <>
            <MultiSelectDropdown label="YEARS" options={years.map(y => ({ value: y, label: String(y) }))}
              selected={filters.years} onToggle={toggleYear} onClear={clearYears} />
            <MultiSelectDropdown label="MONTHS" searchable minWidth={110}
              options={monthOptions.map(m => ({ value: m.i, label: `${MONTH_ABBR[m.mo - 1]}${filters.years.length !== 1 ? ` '${String(m.y).slice(2)}` : ''}` }))}
              selected={filters.months} onToggle={toggleMonth} onClear={clearMonths} />
          </>
        ) : (
          <label className="selectWrap">
            <span className="selectLabel">YEARS (COMBINED)</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 280, padding: '2px 0' }}>
              {years.map(y => (
                <button key={y} onClick={() => toggleYear(y)}
                  style={{ border: `1px solid ${filters.years.includes(y) ? C.teal : C.border}`, cursor: 'pointer', padding: '4px 9px', borderRadius: 20,
                    fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                    background: filters.years.includes(y) ? `${C.teal}18` : C.panel, color: filters.years.includes(y) ? C.teal : C.textDim }}>{y}</button>
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

/* ============================== DATA MODEL ============================== */
// Real state- and LGA-level burden scoring AT A SELECTED MONTH (driven by the
// PERIOD filter), using the exact same scoreDetail/buildZones formula Visual
// Overview uses, with the same "always national peer set" methodology --
// national aggregates (natSeries) still cover the FULL history regardless of
// which month is selected, for the trend charts.
function useRealModel(burden, meta, monthIdx) {
  return useMemo(() => {
    if (!burden || !burden.months?.length) return null
    const months = burden.months
    const lastIdx = lastIdxNonForecast(months)
    const idx = monthIdx != null ? monthIdx : lastIdx
    const flags = burden.flags || {}
    const stateKeys = Object.keys(burden.states || {})
    const lgaKeys = Object.keys(burden.lgas || {})

    // Full-history national/region/location-scoped series (cases, rain, IPTp,
    // dose counts) live in useScopedSeries below, not here -- it already
    // covers the unfiltered national case (location='All', region='All'), so
    // there's no separate unfiltered series needed in this hook.

    // ---- STATE-level real burden score at `idx` (peer set = all 37 states) --
    // this is what colours/scores the constellation map, computed identically
    // to Visual Overview's State view so the two views always agree.
    const stateUnits = buildUnitsAt(burden.states, idx)
    const statePeerAvg = stateUnits.length ? sum(stateUnits.map(u => u.x.cases)) / stateUnits.length : 0
    const stateRaws = stateUnits.map(u => scoreDetail(u.x, statePeerAvg, flags).raw)
    // NOT `Math.min(...stateRaws, 0)` -- that unconditionally folds a literal
    // 0 into the comparison, artificially pinning rawMin to 0 whenever every
    // real raw score is positive (which they always are), shrinking the
    // effective range and inflating every unit's rawScaled term. Visual
    // Overview's own rawRange has never had this padding; matching it exactly
    // is what makes the two views' zone counts agree.
    const stateRawRange = stateRaws.length ? [Math.min(...stateRaws), Math.max(...stateRaws)] : [0, 1]
    const stateZones = buildZones(stateUnits, statePeerAvg, flags, stateRawRange)

    // ---- LGA-level real burden score at `idx` (peer set = all 774 LGAs) --
    // used for the Hotspot Intelligence zone breakdown and the IPTp
    // "hotspot LGAs only" filter.
    const lgaUnits = buildUnitsAt(burden.lgas, idx)
    const lgaPeerAvg = lgaUnits.length ? sum(lgaUnits.map(u => u.x.cases)) / lgaUnits.length : 0
    const lgaRaws = lgaUnits.map(u => scoreDetail(u.x, lgaPeerAvg, flags).raw)
    const lgaRawRange = lgaRaws.length ? [Math.min(...lgaRaws), Math.max(...lgaRaws)] : [0, 1]
    const lgaZones = buildZones(lgaUnits, lgaPeerAvg, flags, lgaRawRange)

    const lgaAggByState = {}
    lgaKeys.forEach(k => {
      const [stName] = k.split('|||')
      lgaAggByState[stName] = lgaAggByState[stName] || { total: 0, Red: 0, Amber: 0, Yellow: 0, Green: 0, 'Not a Hotspot': 0 }
      const z = lgaZones[k]?.zone || 'Not a Hotspot'
      lgaAggByState[stName].total++
      lgaAggByState[stName][z]++
    })

    const points = STATE_GRID.map(s => {
      const sz = stateZones[s.key] || { display: 0, zone: 'Not a Hotspot' }
      const agg = lgaAggByState[s.key] || { total: 0, Red: 0, Amber: 0, Yellow: 0, Green: 0, 'Not a Hotspot': 0 }
      const b = burden.states[s.key] || {}
      return {
        ...s, ...gridToXY(s.col, s.row),
        cases: b.cases?.[idx] ?? 0,
        score: sz.display, zone: sz.zone, dominant: sz.zone,
        // Includes Green -- Red/Amber/Yellow/Green are all real hotspot tiers
        // (burden >= 60); only "Not a Hotspot" (< 60) is excluded. Green was
        // previously left out here, silently undercounting every "hotspot LGA"
        // total on this page relative to the zone breakdown shown right next
        // to it (which always listed Green as its own real count).
        hotspotLgaCount: agg.Red + agg.Amber + agg.Yellow + agg.Green, agg,
        facilities: b.n_facilities?.[idx] ?? 0,
        latest: {
          cases: b.cases?.[idx] ?? null, total: b.total?.[idx] ?? null,
          iptv: b.ipt_cov?.[idx] ?? null, feverTest: b.fever_testing?.[idx] ?? null,
          population: b.population?.[idx] ?? null, popDensity: b.pop_density?.[idx] ?? null,
        },
      }
    })
    const totalHotspotLgas = lgaKeys.reduce((s, k) => s + (['Red', 'Amber', 'Yellow', 'Green'].includes(lgaZones[k]?.zone) ? 1 : 0), 0)

    const mapeLga = meta?.metrics?.validation?.find(v => /LGA/i.test(v.label) && /XGB/i.test(v.label))

    // Recent-rise alert: always anchored to the latest REAL month, independent
    // of whatever month the PERIOD filter is currently exploring.
    const last3 = Math.max(0, lastIdx - 2)
    const recentRise = points.filter(p => {
      const b = burden.states[p.key]
      if (!b) return false
      const now = sum(b.cases?.slice(last3, lastIdx + 1) || [])
      const prevStart = Math.max(0, last3 - 3), prevEnd = Math.max(0, last3)
      const prev = sum(b.cases?.slice(prevStart, prevEnd) || [])
      return prev > 0 && (now - prev) / prev > 0.15
    }).map(p => p.name)

    return {
      months, lastIdx, idx, points, totalHotspotLgas,
      lgaZones,
      mapeLga, recentRise, flags,
      latestLabel: months[lastIdx]?.label, selectedLabel: months[idx]?.label, selectedForecast: months[idx]?.forecast,
    }
  }, [burden, meta, monthIdx])
}

// Full-history state/LGA/region-scoped series (cases, total, rain, IPTp %,
// and the 4 real dose counts) -- this is what makes the ZONE/STATE/LGA
// filters actually change what every chart/KPI shows, instead of only
// affecting the map. When a specific LGA is picked, reads burden.lgas
// directly (no aggregation needed -- it's already one entity); otherwise
// sums whatever set of states the ZONE/STATE filter resolves to. When
// periodMode is 'year', additionally collapses the monthly series into one
// combined (summed/averaged) row per selected year.
//
// HOTSPOT ZONE (filters.category): needs `M` (the current burden-score
// classification, at the selected period) because "which areas are
// currently Red/Amber/Yellow/Green" isn't itself a raw indicator in
// burden.json -- it's the computed output of useRealModel. Applied at
// whichever grain the other filters already resolved to: a specific LGA is
// checked against its own zone; a specific state narrows to just ITS LGAs
// currently in that zone; the national/zone view narrows to just the
// STATES currently in that zone.
function sumRows(stores, m, i) {
  return {
    month: m.label, ym: m.ym, forecast: m.forecast,
    cases: sum(stores.map(b => b?.cases?.[i])),
    total: sum(stores.map(b => b?.total?.[i])),
    rain: avg(stores.map(b => b?.rain?.[i])),
    act: sum(stores.map(b => b?.act?.[i])),
    llin: sum(stores.map(b => b?.llin?.[i])),
    rdt: sum(stores.map(b => b?.rdt_done?.[i])),
    severeTreated: sum(stores.map(b => b?.severe_treated?.[i])),
    iptv: avg(stores.map(b => b?.ipt_cov?.[i]).filter(v => v > 0)),
    feverTest: avg(stores.map(b => b?.fever_testing?.[i]).filter(v => v > 0)),
    iptp1: sum(stores.map(b => b?.iptp1_n?.[i])),
    iptp2: sum(stores.map(b => b?.iptp2_n?.[i])),
    iptp3: sum(stores.map(b => b?.iptp3_n?.[i])),
    iptp4: sum(stores.map(b => b?.iptp4_n?.[i])),
  }
}
function useScopedSeries(burden, filters, M) {
  return useMemo(() => {
    if (!burden?.months?.length) return null
    const months = burden.months
    const regionName = REGIONS_META.find(r => r.code === filters.region)?.name
    const catFilter = filters.category !== 'All' ? filters.category : null

    let monthlySeries, label
    if (filters.lgas.length) {
      // One or more LGAs, summed together -- an LGA that doesn't match the
      // active HOTSPOT ZONE filter contributes nothing (same "honest empty
      // result" rule as a single LGA that doesn't match).
      const keys = filters.lgas.filter(key => !catFilter || M?.lgaZones?.[key]?.zone === catFilter)
      monthlySeries = months.map((m, i) => sumRows(keys.map(k => burden.lgas[k]), m, i))
      const names = filters.lgas.map(k => k.split('|||')[1])
      label = catFilter && keys.length < filters.lgas.length
        ? `${names.join(', ')} (${catFilter}-zone only)`
        : names.join(', ')
    } else if (filters.locations.length) {
      const stateKeys = filters.locations.map(name => STATE_GRID.find(s => s.name === name)?.key).filter(Boolean)
      if (catFilter && M?.lgaZones) {
        // Just these states' LGAs currently classed in the selected zone --
        // a state only has ONE dominant zone label, which can't represent
        // "only its Red-zone LGAs", so this drops to LGA grain instead.
        const prefixes = stateKeys.map(k => `${k}|||`)
        const lgaKeys = Object.keys(burden.lgas).filter(k => prefixes.some(p => k.startsWith(p)) && M.lgaZones[k]?.zone === catFilter)
        monthlySeries = months.map((m, i) => sumRows(lgaKeys.map(k => burden.lgas[k]), m, i))
      } else {
        monthlySeries = months.map((m, i) => sumRows(stateKeys.map(k => burden.states[k]), m, i))
      }
      label = catFilter ? `${filters.locations.join(', ')} (${catFilter}-zone LGAs)` : filters.locations.join(', ')
    } else {
      const dominantByState = Object.fromEntries((M?.points || []).map(p => [p.key, p.dominant]))
      const matches = STATE_GRID.filter(s =>
        (filters.region === 'All' || s.region === filters.region) &&
        burden.states[s.key] &&
        (!catFilter || dominantByState[s.key] === catFilter))
      // No catFilter and truly no zone/state narrowing at all -> every state
      // (the original "national" default). A catFilter that matches zero
      // states is a real, honest empty result -- NOT the same situation, so
      // it must not fall back to "every state" (that would silently ignore
      // the filter instead of showing that nothing currently matches it).
      const keys = matches.length ? matches.map(s => s.key) : (catFilter ? [] : Object.keys(burden.states))
      monthlySeries = months.map((m, i) => sumRows(keys.map(k => burden.states[k]), m, i))
      label = catFilter ? `${catFilter}-zone states` : (filters.region !== 'All' ? regionName : 'Nigeria (national)')
    }

    let series = monthlySeries
    if (filters.periodMode === 'year') {
      const allYears = [...new Set(monthlySeries.map(d => +d.ym.split('-')[0]))].sort((a, b) => a - b)
      let yearsToUse = (filters.years?.length ? filters.years : allYears.slice(-1)).slice().sort((a, b) => a - b)
      // A single selected year collapses to one point -- no line can be drawn
      // from one point. Silently pad with the adjacent year (prefer the
      // previous one, since it exists for certain; fall back to the next)
      // purely for charting continuity -- KPIs/snapshots still key off the
      // user's actual selection via `filters.years`, not this padded set.
      if (yearsToUse.length === 1) {
        const y = yearsToUse[0]
        const idx = allYears.indexOf(y)
        const neighbor = idx > 0 ? allYears[idx - 1] : allYears[idx + 1]
        if (neighbor != null) yearsToUse = [...yearsToUse, neighbor].sort((a, b) => a - b)
      }
      const SUM_FIELDS = ['cases', 'total', 'act', 'llin', 'rdt', 'severeTreated', 'iptp1', 'iptp2', 'iptp3', 'iptp4']
      const AVG_FIELDS = ['rain', 'iptv', 'feverTest']
      series = yearsToUse.map(y => {
        const rows = monthlySeries.filter(d => +d.ym.split('-')[0] === y)
        const out = { month: String(y), ym: `${y}-01`, forecast: rows.some(r => r.forecast) }
        SUM_FIELDS.forEach(f => { out[f] = sum(rows.map(r => r[f])) })
        AVG_FIELDS.forEach(f => { out[f] = avg(rows.map(r => r[f]).filter(v => v != null)) })
        return out
      })
    } else if (filters.months?.length) {
      // An exact set of real months (possibly just one -- a single point,
      // rendered as a single dot with no line, which is the honest result of
      // "show me just this one month" rather than silently falling back to
      // the full range). Indices line up 1:1 with monthlySeries since both
      // are built from the same burden.months array in the same order.
      const set = new Set(filters.months)
      series = monthlySeries.filter((d, i) => set.has(i))
    } else if (filters.years?.length) {
      // MONTH mode's own use of `years`: a real window, not an aggregate --
      // e.g. picking just 2024 shows exactly its 12 real months (Jan-Dec),
      // one point each, same shape as the unrestricted series so every chart
      // downstream (and the interval={length>15?4:0} x-axis logic already in
      // place) needs no special-casing for this being a filtered view.
      series = monthlySeries.filter(d => filters.years.includes(+d.ym.split('-')[0]))
    }

    return { series, monthlySeries, label }
  }, [burden, filters.locations, filters.region, filters.lgas, filters.category, filters.periodMode, filters.years, filters.months, M])
}

// A year-mode row is flagged forecast if it contains ANY forecast month, so
// the current/latest year (always partly forecast) can leave every row in a
// short padded series forecast-flagged. Fall back to the last row outright
// rather than showing blank KPIs -- month mode always has real history, so
// this fallback never triggers there.
const lastActual = series => [...series].reverse().find(d => !d.forecast) || series[series.length - 1]

/* ============================== PAGE: OVERVIEW ============================== */
function OverviewPage({ M, scoped, filters, setFilters }) {
  const scopedPoints = useMemo(() => M.points.filter(p =>
    (filters.region === 'All' || p.region === filters.region) &&
    (!filters.locations.length || filters.locations.includes(p.name)) &&
    (!filters.lgas.length || filters.lgas.some(k => k.startsWith(`${p.name}|||`)))
  ), [M.points, filters.region, filters.locations, filters.lgas])
  const feverConfirmedSplit = useMemo(() => withForecastSplit(scoped.series, ['total', 'cases']), [scoped.series])

  // HOTSPOT ZONE filter: when a specific zone (Red/Amber/Yellow/Green) is
  // picked, every count on this page -- KPI strip, region treemap sizes, and
  // the state/zone bar chart -- narrows to JUST that zone's LGA count,
  // instead of only dimming the map (the map previously silently ignored
  // this filter for every other chart/number on the page).
  const zoneCount = p => filters.category === 'All' ? p.hotspotLgaCount : (p.agg[filters.category] || 0)

  const treeData = REGIONS_META.map(r => ({
    name: r.name, code: r.code,
    size: M.points.filter(p => p.region === r.code).reduce((s, p) => s + zoneCount(p), 0) || 0.001,
    fill: REGION_COLORS[r.code],
  }))
  const topStates = [...scopedPoints].sort((a, b) => b.score - a.score).slice(0, 5)
  // Picking one or more specific LGAs narrows scopedPoints to their PARENT
  // STATES (there's no per-LGA entry in M.points, which is state-grain) --
  // so without this, the KPI strip would silently show the whole state's
  // counts under a card labelled with just those LGAs' names. Read each
  // selected LGA's own zone straight out of M.lgaZones instead.
  const lgaZoneOf = key => M.lgaZones[key]?.zone
  const countLgas = pred => filters.lgas.filter(k => pred(lgaZoneOf(k))).length
  const scopedHotspotLgas = filters.lgas.length
    ? countLgas(z => filters.category !== 'All' ? z === filters.category : (z && z !== 'Not a Hotspot'))
    : scopedPoints.reduce((s, p) => s + zoneCount(p), 0)
  const scopedAmber = filters.lgas.length ? countLgas(z => z === 'Amber') : scopedPoints.reduce((s, p) => s + p.agg.Amber, 0)
  const scopedYellow = filters.lgas.length ? countLgas(z => z === 'Yellow') : scopedPoints.reduce((s, p) => s + p.agg.Yellow, 0)
  const scopedGreen = filters.lgas.length ? countLgas(z => z === 'Green') : scopedPoints.reduce((s, p) => s + p.agg.Green, 0)
  const scopedRed = filters.lgas.length ? countLgas(z => z === 'Red') : scopedPoints.reduce((s, p) => s + p.agg.Red, 0)

  // Real facility count for whatever's currently selected (specific
  // state(s)/LGA(s), or the national/region-scoped total) -- shown in the
  // treemap card, in the space that used to be empty below its caption.
  const scopedFacilities = scopedPoints.reduce((s, p) => s + (p.facilities || 0), 0)
  const facilityScopeLabel = filters.lgas.length ? filters.lgas.map(k => k.split('|||')[1]).join(', ')
    : filters.locations.length ? filters.locations.join(', ')
    : (filters.region !== 'All' ? REGIONS_META.find(r => r.code === filters.region)?.name : 'Nigeria (national)')

  // Every state matching the current LOCATION/GEOPOLITICAL ZONE/HOTSPOT ZONE
  // filter -- reuses scopedPoints (already filtered the same way) rather than
  // re-filtering M.points, so this can never drift out of sync with the KPIs
  // above it. Not capped to a top-N -- the card scrolls internally instead.
  // Sorted by severity, not just total count -- most Red LGAs first (ties
  // broken by Amber, then Yellow, then Green), so the worst states are
  // always at the top and the safest (Green-heavy) states sink to the
  // bottom, instead of a high-Green, low-Red state outranking a genuinely
  // worse one just because its total hotspot count happens to be bigger.
  const stackData = [...scopedPoints]
    .map(d => ({ state: d.name, Red: d.agg.Red, Amber: d.agg.Amber, Yellow: d.agg.Yellow, Green: d.agg.Green }))
    .filter(d => filters.category === 'All' || d[filters.category] > 0)
    .sort((a, b) => (b.Red - a.Red) || (b.Amber - a.Amber) || (b.Yellow - a.Yellow) || (b.Green - a.Green))
  const zoneBars = filters.category === 'All'
    ? [['Red', C.red], ['Amber', C.amber], ['Yellow', C.yellow], ['Green', C.green]]
    : [[filters.category, ZONE_COLORS[filters.category]]]

  // Map clicks are still single-pick (replace, not add-to) -- deliberate
  // multi-select lives in the LOCATION filter's checkbox tree; a map click
  // is a quick "just this one" gesture, so it clears whatever multi-select
  // was active there rather than appending to it.
  const onMapSelect = name => setFilters(f => ({ ...f, locations: (f.locations.length === 1 && f.locations[0] === name) ? [] : [name], lgas: [] }))
  const onMapSelectLga = (stateName, lgaName) => setFilters(f => {
    const key = `${stateName}|||${lgaName}`
    return { ...f, lgas: (f.lgas.length === 1 && f.lgas[0] === key) ? [] : [key], locations: [] }
  })

  return (
    <>
      {M.recentRise.length > 0 && (
        <div className="alertBar">
          <AlertTriangle size={15} color={C.amber} />
          <span><strong>{M.recentRise.length} state{M.recentRise.length > 1 ? 's' : ''}</strong> show a real 3-month case rise of 15%+ as of {M.latestLabel}: {M.recentRise.slice(0, 6).join(', ')}{M.recentRise.length > 6 ? '…' : ''}.</span>
        </div>
      )}
      <div className="grid5">
        <KPICard label={`Hotspot LGAs (${scoped.label})`} value={scopedHotspotLgas} icon={MapIcon} accent={C.azure} />
        <KPICard label="Red Zone LGAs" value={scopedRed} icon={AlertTriangle} accent={C.red} />
        <KPICard label="Amber Zone LGAs" value={scopedAmber} icon={AlertTriangle} accent={C.amber} />
        <KPICard label="Yellow Zone LGAs" value={scopedYellow} icon={AlertTriangle} accent={C.yellow} />
        <KPICard label="Green Zone LGAs" value={scopedGreen} icon={ShieldCheck} accent={C.green} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Hotspot LGAs by Geographic Region — click a region to filter" icon={MapIcon}
          info="Each tile is one of Nigeria's 6 geopolitical zones, sized by its real hotspot LGA count (Red+Amber+Yellow+Green) as of the selected month. Click a tile to filter every KPI, chart and the map on this page down to that zone."
          right={filters.region !== 'All' && <button className="miqChip" onClick={() => setFilters(f => ({ ...f, region: 'All' }))}>✕ {REGIONS_META.find(r => r.code === filters.region)?.name}</button>}>
          <ResponsiveContainer width="100%" height={360}>
            <Treemap data={treeData} dataKey="size" stroke={C.bg} isAnimationActive={false}
              content={({ x, y, width, height, name, code, size, fill }) => {
                // Recharts' Treemap passes the implicit root/wrapper node
                // through `content` too (no `code`, no `size`), plus its
                // squarified layout can produce NaN x/y/width/height for a
                // degenerate cell when region sizes are wildly uneven (e.g. a
                // region with 0 hotspot LGAs next to one with 100+). Guard on
                // BOTH: skip anything without a real region code, and use
                // Number.isFinite (not just `<= 1` -- NaN <= 1 is false, so
                // that alone doesn't catch it and React warns about a NaN SVG
                // attribute).
                if (code == null) return null
                if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null
                const selected = filters.region === code
                const onClick = () => setFilters(f => ({ ...f, region: f.region === code ? 'All' : code }))
                const displaySize = Number.isFinite(size) ? Math.round(size) : 0
                // Every cell always shows BOTH its name and count -- the old
                // three-tier (name+count / count-only / rotated) layout could
                // land a mid-sized region (e.g. South West) in the "count
                // only" tier depending on the squarify layout that month,
                // silently dropping its label. Clipped to the cell's own rect
                // so a long name in a narrow cell clips cleanly instead of
                // visually bleeding into the next region.
                const big = width >= 70 && height >= 38
                const rotated = !big && height > width * 1.3 && height >= 60
                const clipId = `miq-tree-clip-${code}`
                // Shrink the name's font just enough to fit the cell's own
                // width (never below 8px) instead of clipping mid-word --
                // ~0.62em average glyph width for this bold sans font.
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 10.5, color: C.textFaint, maxWidth: 340 }}>Number = real hotspot LGA count in that region as of {M.selectedLabel}. Click a region to filter every KPI/chart on this page to it.</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 9, padding: '7px 12px' }}>
              <MapIcon size={14} color={C.tealLight} strokeWidth={2.2} />
              <div>
                <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 15, color: C.text, lineHeight: 1.1 }}>{fmt(scopedFacilities)}</div>
                <div style={{ fontSize: 9.5, color: C.textFaint }}>reporting facilities · {facilityScopeLabel}</div>
              </div>
            </div>
          </div>
        </Card>
        <Card title="National Risk Map" icon={Target} right={<ZoneLegend compact />}
          info="Real Nigeria map (state or LGA grain, toggle above it), coloured by real burden zone -- same formula and national ranking as Visual Overview. Click any state or LGA to filter every KPI/chart on this page to it.">
          <RiskMap points={M.points} lgaZones={M.lgaZones} selected={filters.locations}
            selectedLga={filters.lgas}
            onSelect={onMapSelect} onSelectLga={onMapSelectLga} categoryFilter={filters.category} regionFilter={filters.region} />
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={`Distribution of Hotspot LGAs by State & Zone (${stackData.length} state${stackData.length !== 1 ? 's' : ''})`} icon={Activity}
          right={filters.category !== 'All' ? <span className="miqChip" style={{ cursor: 'default' }}>{ZONE_LABELS[filters.category]} only</span> : (
            // Only the zones this chart can actually show (Red/Amber/Yellow/
            // Green) -- every LGA here is by definition a hotspot, so the
            // generic <ZoneLegend/> always listing "Not a Hotspot" too was a
            // legend entry with nothing in the chart to match it.
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {zoneBars.map(([z, color]) => (
                <div key={z} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
                  <span style={{ fontSize: 11.5, color: C.textDim }}>{ZONE_LABELS[z]}</span>
                </div>
              ))}
            </div>
          )}
          info="Every matching state, sorted by hotspot LGA count. Filtered to the HOTSPOT ZONE picker above when one is set. Scroll inside the chart to see all of them -- nothing is truncated.">
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
        </Card>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={(() => {
          const yFrom = scoped.series[0]?.ym?.slice(0, 4), yTo = scoped.series[scoped.series.length - 1]?.ym?.slice(0, 4)
          const range = yFrom === yTo ? yFrom : `${yFrom}-${yTo}`
          const unit = filters.periodMode === 'year' ? 'year' : 'month'
          return `Fever Cases vs Confirmed Malaria — ${scoped.label}, ${scoped.series.length} ${unit}${scoped.series.length === 1 ? '' : 's'} (${range})`
        })()} icon={Activity}
          info="Real monthly totals: 'Fever/tested cases' is everyone tested for malaria (the 'total' indicator); 'Confirmed malaria' is lab-confirmed cases. Solid = reported; dashed = model forecast. Scoped to whatever ZONE/STATE/LGA/HOTSPOT ZONE filter is set above.">
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={feverConfirmedSplit} margin={{ top: 4, right: 4 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={feverConfirmedSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis yAxisId="l" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Area yAxisId="l" type="monotone" dataKey="total_actual" name="Fever/tested cases" stroke={C.chartBlue} fill={C.chartBlue} fillOpacity={0.15} strokeWidth={2} connectNulls />
              <Area yAxisId="l" type="monotone" dataKey="total_forecast" name="Fever/tested cases (forecast)" stroke={C.chartBlue} strokeDasharray="5 4" fill={C.chartBlue} fillOpacity={0.05} strokeWidth={2} connectNulls />
              <Line yAxisId="r" type="monotone" dataKey="cases_actual" name="Confirmed malaria" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
              <Line yAxisId="r" type="monotone" dataKey="cases_forecast" name="Confirmed malaria (forecast)" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        <Card title={`Top 5 Highest-Burden States (${scoped.label})`} icon={AlertTriangle}
          info="Ranked by real burden score (0-100), the same score and national ranking Visual Overview uses -- not just raw case count.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topStates.map((s, i) => (
              <div key={s.name} className="rankRow">
                <span className="rankNo">{i + 1}</span>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: ZONE_COLORS[s.dominant], flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13 }}>{s.name}</span>
                <span className="tagRegion" style={{ color: REGION_COLORS[s.region] }}>{s.region}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, fontWeight: 700 }}>{s.score.toFixed(0)}</span>
              </div>
            ))}
            {!topStates.length && <div className="muted" style={{ fontSize: 12, color: C.textFaint }}>No states match the current filters.</div>}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 11.5, color: C.textDim, lineHeight: 1.6 }}>
            Real burden score (0-100) as of {M.selectedLabel}{M.selectedForecast ? ' (forecast month)' : ''} — same formula and national ranking as Visual Overview.
          </div>
        </Card>
      </div>
    </>
  )
}

/* ============================== PAGE: IPTP COVERAGE ============================== */
function IPTpPage({ M, scoped, filters, burden }) {
  const lastReal = lastActual(scoped.series) || {}
  // Cumulative % of IPTp1 reached at each dose -- the SAME scale the funnel
  // bars themselves use, so the "from % to %" dropoff text below and each
  // bar's own label can never show two different, confusing percentages for
  // the same dose. Deliberately UNCAPPED (see doseCompare below for why).
  const ratio12 = lastReal.iptp1 > 0 ? lastReal.iptp2 / lastReal.iptp1 * 100 : null
  // Cumulative IPTp3+ completion from dose 1 -- the WHO-relevant figure (see
  // the policy note below).
  const completion3National = lastReal.iptp1 > 0 ? lastReal.iptp3 / lastReal.iptp1 * 100 : null

  // The bar graph: for the CURRENT location+time selection only, real number
  // AND % for IPTp1/2/3/3+ -- nothing else layered on. "3+" = doses 3 and 4
  // combined (any administration this period that represents a woman's 3rd
  // dose or later), matching WHO's "IPTp3+" reporting convention.
  // pct is intentionally NOT capped at 100 -- these are monthly dose COUNTS,
  // not a per-woman cohort followed over time: this month's IPTp3/IPTp4
  // recipients are women who started IPTp1 in an EARLIER month (doses are
  // staggered across each woman's own ANC schedule), so a busy month can
  // easily report more dose-3-or-4 administrations than that SAME month's
  // fresh IPTp1 initiations. Capping at 100% would hide that real signal
  // behind a falsely tidy "100%" instead of showing the true ratio (e.g.
  // 105%) that actually explains what's happening.
  const iptp3PlusNum = (lastReal.iptp3 || 0) + (lastReal.iptp4 || 0)
  const doseCompare = [
    { dose: 'IPTp1', num: lastReal.iptp1 || 0, pct: lastReal.iptp1 ? 100 : 0, color: C.chartBlue },
    { dose: 'IPTp2', num: lastReal.iptp2 || 0, pct: ratio12 ?? 0, color: C.chartTeal },
    { dose: 'IPTp3', num: lastReal.iptp3 || 0, pct: lastReal.iptp1 > 0 ? (lastReal.iptp3 || 0) / lastReal.iptp1 * 100 : 0, color: C.chartPurple },
    { dose: 'IPTp3+', num: iptp3PlusNum, pct: lastReal.iptp1 > 0 ? iptp3PlusNum / lastReal.iptp1 * 100 : 0, color: C.chartAmber },
  ]
  const doseTrendSplit = useMemo(() => withForecastSplit(scoped.series, ['iptp1', 'iptp2', 'iptp3', 'iptp4']), [scoped.series])

  // GRAPH 3 drills down one geography level at a time, mirroring the ZONE ->
  // STATE -> LGA filter hierarchy itself: nothing selected shows the 6 zones,
  // picking a zone shows its states, picking a state shows its LGAs, and
  // picking a single LGA shows just that one bar. Picking MULTIPLE states or
  // LGAs shows one bar per selection instead of an implicit drill-down, since
  // there's no single parent to drill from. Every level renders through the
  // SAME 100%-stacked-bar shape (see `breakdown` below) so a single LGA and
  // a 30-state zone look like the same chart, just with more bars -- always
  // the same height, composition (% of that row's own 4 doses) not raw
  // magnitude. Each row uses the SAME real dose-count fields as everywhere
  // else on this page, read directly off burden.json at the same month
  // lastReal itself resolved to (never a different, silently-drifted period).
  const breakdownLevel = filters.lgas.length === 1 ? 'lga'
    : filters.lgas.length > 1 ? 'lgas-multi'
    : filters.locations.length === 1 ? 'state'
    : filters.locations.length > 1 ? 'states-multi'
    : filters.region !== 'All' ? 'zone' : 'national'
  const targetIdx = useMemo(() => {
    if (!burden?.months?.length) return -1
    const i = burden.months.findIndex(m => m.ym === lastReal.ym)
    return i
  }, [burden, lastReal.ym])
  const breakdown = useMemo(() => {
    if (targetIdx < 0 || !burden) return []
    const doseRow = b => {
      const i1 = b?.iptp1_n?.[targetIdx] || 0, i2 = b?.iptp2_n?.[targetIdx] || 0
      const i3 = b?.iptp3_n?.[targetIdx] || 0, i4 = b?.iptp4_n?.[targetIdx] || 0
      return { iptp1: i1, iptp2: i2, iptp3: i3, iptp4: i4 }
    }
    let rows = []
    if (breakdownLevel === 'lga') {
      rows = [{ name: scoped.label, iptp1: lastReal.iptp1 || 0, iptp2: lastReal.iptp2 || 0, iptp3: lastReal.iptp3 || 0, iptp4: lastReal.iptp4 || 0 }]
    } else if (breakdownLevel === 'lgas-multi') {
      rows = filters.lgas.map(key => ({ name: key.split('|||')[1], ...doseRow(burden.lgas[key]) }))
    } else if (breakdownLevel === 'state') {
      rows = lgaNamesForState(burden, filters.locations[0]).map(l => ({ name: l, ...doseRow(burden.lgas[`${filters.locations[0]}|||${l}`]) }))
    } else if (breakdownLevel === 'states-multi') {
      rows = filters.locations.map(name => ({ name, ...doseRow(burden.states[STATE_GRID.find(s => s.name === name)?.key]) }))
    } else if (breakdownLevel === 'zone') {
      rows = STATE_GRID.filter(s => s.region === filters.region).map(s => ({ name: s.name, ...doseRow(burden.states[s.key]) }))
    } else {
      rows = REGIONS_META.map(r => {
        const sums = STATE_GRID.filter(s => s.region === r.code).reduce((acc, s) => {
          const row = doseRow(burden.states[s.key])
          acc.iptp1 += row.iptp1; acc.iptp2 += row.iptp2; acc.iptp3 += row.iptp3; acc.iptp4 += row.iptp4
          return acc
        }, { iptp1: 0, iptp2: 0, iptp3: 0, iptp4: 0 })
        return { name: r.name, ...sums }
      })
    }
    // Each bar is stacked to its OWN total (iptp1+iptp2+iptp3+iptp4 for that
    // row) = 100%, so every bar reaches the same height regardless of that
    // row's actual volume -- a composition view, not a magnitude one. Raw
    // counts are kept on the row too, purely for the tooltip.
    return rows
      .filter(r => r.iptp1 > 0 || r.iptp2 > 0 || r.iptp3 > 0 || r.iptp4 > 0)
      .map(r => {
        const total = r.iptp1 + r.iptp2 + r.iptp3 + r.iptp4
        return {
          ...r,
          iptp1Pct: total > 0 ? r.iptp1 / total * 100 : 0, iptp2Pct: total > 0 ? r.iptp2 / total * 100 : 0,
          iptp3Pct: total > 0 ? r.iptp3 / total * 100 : 0, iptp4Pct: total > 0 ? r.iptp4 / total * 100 : 0,
        }
      })
      .sort((a, b) => (b.iptp1 + b.iptp2 + b.iptp3 + b.iptp4) - (a.iptp1 + a.iptp2 + a.iptp3 + a.iptp4))
  }, [breakdownLevel, burden, filters.locations, filters.lgas, filters.region, targetIdx, scoped.label, lastReal])
  const breakdownTitle = breakdownLevel === 'lga' ? `IPTp Dose Composition — ${scoped.label}`
    : breakdownLevel === 'lgas-multi' ? `IPTp Dose Composition by LGA — ${filters.lgas.length} selected`
    : breakdownLevel === 'state' ? `IPTp Dose Composition by LGA — ${filters.locations[0]}`
    : breakdownLevel === 'states-multi' ? `IPTp Dose Composition by State — ${filters.locations.length} selected`
    : breakdownLevel === 'zone' ? `IPTp Dose Composition by State — ${REGIONS_META.find(r => r.code === filters.region)?.name || filters.region}`
    : `IPTp Dose Composition by Zone — Nigeria (national)`

  // Funnel stages share the EXACT same pct definitions as the KPI row above
  // (doseCompare's own pct fields, uncapped-ness and all) so the funnel can
  // NEVER show a different number than the card sitting right on top of it --
  // ratio12 in particular is intentionally uncapped (real dose-pairing
  // artifacts, same ones noted for IPTp3+ above, can push IPTp2 over 100% of
  // IPTp1 -- e.g. Lagos, Mar 2026). Only the bar's CSS width gets clamped to
  // 100 for layout sanity; the displayed number and the drop-off delta always
  // use the true value, so an over-100% reading still renders as an honest
  // "increase" rather than silently rounding down to agree with a capped bar.
  const iptp1v = lastReal.iptp1 || 0
  const funnelPcts = [
    iptp1v > 0 ? 100 : 0,
    ratio12 ?? 0,
    completion3National ?? 0,
    iptp1v > 0 ? (lastReal.iptp4 || 0) / iptp1v * 100 : 0,
  ]
  const funnelStages = ['IPTp1', 'IPTp2', 'IPTp3', 'IPTp4'].map((label, i) => ({
    label, pct: funnelPcts[i], color: [C.chartBlue, C.chartGreen, C.chartAmber, C.chartRed][i],
    drop: i < 3 ? funnelPcts[i] - funnelPcts[i + 1] : null,
  }))

  return (
    <>
      <div className="grid4" style={{ marginTop: 16 }}>
        {doseCompare.map(d => (
          <KPICard key={d.dose} label={`${d.dose} (${lastReal.month || '—'})`} value={`${fmt(d.num)} (${d.pct.toFixed(0)}%)`} icon={Syringe} accent={d.color} />
        ))}
      </div>

      {/* ── GRAPH 1: the dose cascade/funnel -- the standard way multi-dose
           preventive-treatment programmes are reported globally (WHO/RBM). ── */}
      <div style={{ marginTop: 16 }}>
        <Card title="IPTp Dose Cascade — Real Retention (primary view)" icon={AlertTriangle}
          info="What share of women who got IPTp1 went on to get IPTp2, IPTp3+ and IPTp4+, computed from real dose counts for the latest reported month -- a genuine dropout/retention view, not an estimate. This is the standard funnel representation WHO/RBM use for multi-dose preventive treatment reporting."
          sub={`Latest real month: ${lastReal.month || '—'}`}>
          <div className="funnel">
            {funnelStages.map((f, i) => (
              <div key={f.label}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 56, flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: C.text }}>{f.label}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      width: Math.min(100, Math.max(8, f.pct)) + '%', minWidth: 48, boxSizing: 'border-box',
                      background: `${f.color}22`, border: `1px solid ${f.color}66`, borderRadius: 6,
                      padding: '9px 12px', fontSize: 14, fontWeight: 700, color: f.color,
                    }}>
                      {f.pct.toFixed(0)}%
                    </div>
                  </div>
                </div>
                {f.drop != null && (
                  <div style={{ marginLeft: 68, marginTop: 5, marginBottom: 8, fontSize: 11, color: C.textFaint }}>
                    {f.drop >= 0 ? `↓ −${f.drop.toFixed(0)}pp drop-off to next dose` : `↑ +${(-f.drop).toFixed(0)}pp increase to next dose`}
                  </div>
                )}
              </div>
            ))}
          </div>
          {completion3National != null && (
            <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 14, lineHeight: 1.6 }}>
              National IPTp3+ completion is <b style={{ color: completion3National >= 80 ? C.green : C.red }}>{completion3National.toFixed(0)}%</b> against the WHO/RBM 80% target{completion3National < 80 ? ` — a ${(80 - completion3National).toFixed(0)}pp gap.` : '.'} Facility-level follow-up on later ANC visits can help close this gap.
            </div>
          )}
        </Card>
      </div>

      {/* ── GRAPH 2: all 4 doses over time, real portion solid / forecast dashed. ── */}
      <div style={{ marginTop: 16 }}>
        <Card title={`IPTp Dose Counts Over Time — ${scoped.label}`} icon={Syringe}
          info="Real monthly dose COUNTS (not percentages) for IPTp1 through IPTp4. Solid = reported; dashed = model forecast.">
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={doseTrendSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={doseTrendSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              {[['iptp1', 'IPTp1', C.chartBlue], ['iptp2', 'IPTp2', C.chartTeal], ['iptp3', 'IPTp3', C.chartPurple], ['iptp4', 'IPTp4', C.chartAmber]].map(([k, name, color]) => (
                <React.Fragment key={k}>
                  <Line type="monotone" dataKey={`${k}_actual`} name={name} stroke={color} strokeWidth={2.2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={`${k}_forecast`} name={`${name} (forecast)`} stroke={color} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
                </React.Fragment>
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* ── GRAPH 3: 100%-stacked dose composition, drilling one geography
           level per the ZONE/STATE/LGA filter -- nothing selected shows
           zones, a zone shows its states, a state shows its LGAs, an LGA
           shows just its own single bar. Every bar reaches the same height
           (100%) since each is stacked to ITS OWN total -- a composition
           view (what share of this row's doses were 1st/2nd/3rd/4th),
           hover for the real underlying counts. ── */}
      <div style={{ marginTop: 16 }}>
        {(() => {
          const unitNoun = breakdownLevel === 'lga' ? 'location' : breakdownLevel === 'state' ? 'LGA' : breakdownLevel === 'lgas-multi' ? 'selected LGA'
            : breakdownLevel === 'states-multi' ? 'selected state' : breakdownLevel === 'zone' ? 'state' : 'zone'
          const CHART_H = 420
          const BAR_GROUP_W = 92
          const needsScroll = breakdown.length > 8
          const chartWidth = needsScroll ? Math.max(breakdown.length * BAR_GROUP_W, 600) : '100%'
          const bars = [
            ['iptp1Pct', 'IPTp1', C.chartBlue], ['iptp2Pct', 'IPTp2', C.chartTeal],
            ['iptp3Pct', 'IPTp3', C.chartPurple], ['iptp4Pct', 'IPTp4', C.chartRed],
          ]
          const StackedDoseTooltip = ({ active, payload, label }) => {
            if (!active || !payload?.length) return null
            const row = payload[0]?.payload
            if (!row) return null
            return (
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 12, boxShadow: '0 8px 24px rgba(15,34,48,.16)', minWidth: 150 }}>
                <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>{label}</div>
                {bars.map(([pctKey, name, color]) => {
                  const rawKey = pctKey.replace('Pct', '')
                  return (
                    <div key={pctKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                      <span style={{ color }}>{name}</span>
                      <b style={{ fontFamily: 'IBM Plex Mono, monospace', color: C.text }}>{fmt(row[rawKey])} ({row[pctKey].toFixed(0)}%)</b>
                    </div>
                  )
                })}
              </div>
            )
          }
          return (
            <Card title={`${breakdownTitle}, ${lastReal.month || 'latest month'}`} icon={Syringe}
              info={`Each bar is that ${unitNoun}'s own real IPTp1-4 dose counts, stacked as a share of its own total (always 100% tall) rather than raw magnitude -- hover a bar for the actual dose counts. ${breakdownLevel === 'national' || breakdownLevel === 'zone' ? 'Click a ZONE or STATE' : breakdownLevel !== 'lga' ? 'Pick states or LGAs' : 'Pick a different zone/state/LGA'} in the LOCATION filter above to drill down or compare further.`}>
              <div style={{ overflowX: needsScroll ? 'auto' : 'hidden' }}>
                <ResponsiveContainer width={chartWidth} height={CHART_H}>
                  <BarChart data={breakdown} margin={{ top: 8, right: 10, left: 0, bottom: 70 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: C.textDim, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} interval={0} angle={-40} textAnchor="end" height={70} />
                    <YAxis domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
                    <Tooltip content={<StackedDoseTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
                    {bars.map(([k, name, color]) => <Bar key={k} dataKey={k} name={name} stackId="dose" fill={color} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {needsScroll && <div style={{ fontSize: 10.5, color: C.textFaint, textAlign: 'center', marginTop: 2 }}>Scroll horizontally to see all {breakdown.length}.</div>}
              {!breakdown.length && <div className="muted" style={{ fontSize: 12, color: C.textFaint, textAlign: 'center', padding: 20 }}>No dose data for this period.</div>}
            </Card>
          )
        })()}
      </div>

    </>
  )
}

// One real series, solid where it's actually reported and dashed once the
// model takes over -- replaces the AreaChart used everywhere on this page
// (an Area's fill made the actual/forecast boundary hard to read at a
// glance; a plain vs dashed Line makes it explicit).
function SplitLineChart({ data, dataKey, name, color, height = 270, yTickFmt = fmt }) {
  const split = useMemo(() => withForecastSplit(data, [dataKey]), [data, dataKey])
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={split}>
        <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9 }} axisLine={{ stroke: C.border }} tickLine={false} interval={split.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
        <YAxis tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={yTickFmt} />
        <Tooltip content={<CustomTooltip />} />
        <Line type="monotone" dataKey={`${dataKey}_actual`} name={name} stroke={color} strokeWidth={2.2} dot={false} connectNulls />
        <Line type="monotone" dataKey={`${dataKey}_forecast`} name={`${name} (forecast)`} stroke={color} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
      </LineChart>
    </ResponsiveContainer>
  )
}

/* ============================== PAGE: INTERVENTION IMPACT ============================== */
function InterventionPage({ M, scoped }) {
  const last = lastActual(scoped.series)
  const rainCasesSplit = useMemo(() => withForecastSplit(scoped.series, ['cases']), [scoped.series])

  return (
    <>
      <div className="grid4" style={{ marginTop: 16 }}>
        <KPICard label={`Fever cases (${last?.month || '—'})`} value={last ? fmt(last.total) : '—'} icon={Thermometer} accent={C.azure} />
        <KPICard label={`Confirmed malaria (${last?.month || '—'})`} value={last ? fmt(last.cases) : '—'} icon={Activity} accent={C.red} />
        <KPICard label={`LLIN Distributed (${last?.month || '—'})`} value={last ? fmt(last.llin) : '—'} icon={ShieldCheck} accent={C.purple} />
        <KPICard label={`ACT Given (${last?.month || '—'})`} value={last ? fmt(last.act) : '—'} icon={ShieldCheck} accent={C.tealLight} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`Fever Cases (tested) — ${scoped.label}`} icon={Thermometer}
          info="Real 'total reported' (confirmed + presumed) series -- everyone tested or presumptively treated for fever/malaria. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="total" name="Fever cases" color={C.chartBlue} />
        </Card>
        <Card title={`Confirmed Malaria — ${scoped.label}`} icon={Activity}
          info="Real lab-confirmed malaria case counts for the current filter. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="cases" name="Confirmed malaria" color={C.chartRed} />
        </Card>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`ACT Treatment Courses Given — ${scoped.label}`} icon={ShieldCheck}
          info="Real ACT (Artemisinin-based Combination Therapy) courses given -- the actual treatment-coverage intervention. More courses given shrinks the treatment gap in the burden score. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="act" name="ACT courses given" color={C.chartTeal} />
        </Card>
        <Card title={`LLIN Nets Distributed — ${scoped.label}`} icon={ShieldCheck}
          info="Real LLIN (Long-Lasting Insecticidal Net) distribution counts -- the actual vector-control intervention. More nets distributed shrinks the protection gap in the burden score. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="llin" name="LLIN nets distributed" color={C.chartPurple} />
        </Card>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title={`RDT Tests Performed — ${scoped.label}`} icon={Droplets}
          info="Real Rapid Diagnostic Test (RDT) counts -- the actual testing/diagnosis intervention. More testing catches more real cases sooner and shrinks the testing gap in the burden score. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="rdt" name="RDT tests performed" color={C.chartBlue} />
        </Card>
        <Card title={`Severe Malaria Treated (Artesunate) — ${scoped.label}`} icon={ShieldCheck}
          info="Real count of severe malaria cases treated with injectable Artesunate -- the case-management intervention for the most serious cases, distinct from routine ACT courses. Solid = reported; dashed = model forecast.">
          <SplitLineChart data={scoped.series} dataKey="severeTreated" name="Severe malaria treated" color={C.chartRed} />
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={`Rainfall vs. Confirmed Malaria Cases — ${scoped.label}`} icon={CloudRain}
          info="Real monthly rainfall against real confirmed cases -- look for the seasonal lag (cases typically rise a few weeks after rainfall peaks) rather than an assumed fixed offset. The case line is solid where reported, dashed where forecast.">
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={rainCasesSplit}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={{ stroke: C.border }} tickLine={false} interval={rainCasesSplit.length > 15 ? 4 : 0} angle={-35} textAnchor="end" height={48} />
              <YAxis yAxisId="l" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + 'mm'} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Bar yAxisId="l" dataKey="rain" name="Rainfall (mm)" fill={C.chartBlue} fillOpacity={0.55} radius={[3, 3, 0, 0]} />
              <Line yAxisId="r" type="monotone" dataKey="cases_actual" name="Confirmed cases" stroke={C.chartRed} strokeWidth={2.2} dot={false} connectNulls />
              <Line yAxisId="r" type="monotone" dataKey="cases_forecast" name="Confirmed cases (forecast)" stroke={C.chartRed} strokeWidth={2.2} strokeDasharray="5 4" dot={false} connectNulls legendType="none" />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 6, lineHeight: 1.6 }}>Real monthly rainfall and confirmed-case series — inspect visually for the seasonal lag rather than an assumed fixed offset.</div>
        </Card>
      </div>
    </>
  )
}

/* ============================== APP ============================== */
export default function ManagerDashboard({ data, variant = 'after', disease = 'malaria' }) {
  const [page, setPage] = useState('overview')
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [burden, setBurden] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setBurden(null)
    // no-store: burden.json changes (widened windows, new fields) shouldn't
    // ever be served from a stale browser cache -- this is the same file
    // Visual Overview reads, and the two views must always agree on it.
    fetch(`${BASE}data/${variant}/burden.json`, { cache: 'no-store' }).then(r => r.json()).then(setBurden).catch(() => setBurden({ months: [], lgas: {}, states: {} }))
  }, [variant])

  const lastIdx = useMemo(() => (burden?.months?.length ? lastIdxNonForecast(burden.months) : 0), [burden])
  // Default the PERIOD filter to the latest REAL month the first time burden
  // data loads, without overwriting a choice the user has already made.
  useEffect(() => { if (burden?.months?.length && filters.monthIdx == null) setFilters(f => ({ ...f, monthIdx: lastIdx })) }, [burden, lastIdx])
  // The map/KPI snapshot always needs ONE concrete month index -- in Month
  // mode that's just the picked month; in Year mode (which can span several
  // combined years) it's the last real-or-forecast month of the LATEST
  // selected year, so the snapshot always reflects the most recent data
  // within the selected range.
  const effectiveMonthIdx = useMemo(() => {
    if (filters.periodMode === 'year' && filters.years?.length && burden?.months?.length) {
      const y = Math.max(...filters.years)
      let idx = -1
      burden.months.forEach((m, i) => { if (+m.ym.split('-')[0] === y) idx = i })
      return idx >= 0 ? idx : lastIdx
    }
    return filters.monthIdx ?? lastIdx
  }, [filters.periodMode, filters.years, filters.monthIdx, burden, lastIdx])

  const M = useRealModel(burden, data?.meta, effectiveMonthIdx)
  const scoped = useScopedSeries(burden, filters, M)

  const months = burden?.months || []

  const metaTxt = {
    overview: { title: 'Command Overview', sub: 'National summary across all 6 geopolitical zones' },
    iptp: { title: 'IPTp Coverage', sub: 'Real dose-level IPTp1-4 cascade and national coverage %' },
    intervention: { title: 'Intervention Impact', sub: 'Fever/confirmed case trends & rainfall correlation' },
  }[page]

  if (disease !== 'malaria') {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--txt-2)' }}>The MalariaIQ command console is malaria-specific — switch to the Malaria tab to view it.</div>
  }

  return (
    <div className="miq-root">
      <style>{`
        .miq-root { background: ${C.bg}; color: ${C.text}; font-family: 'IBM Plex Sans', system-ui, sans-serif; display: flex; height: calc(100vh - 132px); border-radius: 12px; overflow: hidden; }
        .miq-root * { box-sizing: border-box; }
        .miq-root button, .miq-root select, .miq-root input { font-family: inherit; }
        .miq-root button:focus-visible, .miq-root select:focus-visible, .miq-root input:focus-visible { outline: 2px solid ${C.azure}; outline-offset: 2px; }

        .miq-root .sidebar { width: 226px; flex-shrink: 0; background: ${C.panel2}; border-right: 1px solid ${C.border}; display: flex; flex-direction: column; padding: 18px 12px; transition: width 0.18s ease, padding 0.18s ease; }
        .miq-root .sidebarCollapsed { width: 62px; padding: 18px 8px; }
        .miq-root .sidebarCollapsed .brand { justify-content: center; padding: 6px 0 20px; }
        .miq-root .sidebarCollapsed .navItem { justify-content: center; padding: 9px 0; }
        .miq-root .sidebarCollapsed .navItemActive::before { left: -8px; }
        .miq-root .sidebarToggle { margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: 1px solid ${C.border}; background: ${C.panel}; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
        .miq-root .sidebarCollapsed .sidebarToggle { margin-left: 0; }
        .miq-root .sidebarToggle:hover { background: ${C.panelAlt}; }
        .miq-root .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 20px; }
        .miq-root .brandMark { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, ${C.teal}, ${C.azure}); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
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
        .miq-root .topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 26px; background: ${C.bg}ee; backdrop-filter: blur(6px); border-bottom: 1px solid ${C.border}; flex-wrap: wrap; gap: 12px; }
        .miq-root .topTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; }
        .miq-root .topSub { font-size: 12px; color: ${C.textFaint}; margin-top: 2px; }
        .miq-root .content { padding: 20px 26px 40px; }

        .miq-root .selectWrap { display: flex; flex-direction: column; gap: 4px; }
        .miq-root .selectLabel { font-size: 9.5px; letter-spacing: 0.6px; color: ${C.textFaint}; font-weight: 600; }
        .miq-root .selectBox { display: flex; align-items: center; gap: 6px; background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 7px; padding: 6px 8px; }
        .miq-root .selectBox select { background: transparent; border: none; color: ${C.text}; font-size: 12px; appearance: none; cursor: pointer; max-width: 168px; }
        .miq-root .selectBox select option { background: ${C.panel}; }
        .miq-root .miqResetBtn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid ${C.teal}; background: ${C.teal}12; color: ${C.teal}; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
        .miq-root .miqResetBtn:hover:not(:disabled) { background: ${C.teal}22; }
        .miq-root .miqResetBtn:disabled { opacity: 0.4; cursor: default; border-color: ${C.border}; color: ${C.textFaint}; background: transparent; }
        .miq-root .miqChip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 20px; border: 1px solid ${C.teal}55; background: ${C.teal}14; color: ${C.teal}; font-size: 11px; font-weight: 700; cursor: pointer; }
        .miq-root .miqChip:hover { background: ${C.teal}24; }

        .miq-root .card { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .miq-root .cardHead { display: flex; justify-content: space-between; align-items: center; padding: 13px 18px; border-bottom: 1px solid ${C.border}; }
        .miq-root .cardTitle { font-size: 12.8px; font-weight: 600; letter-spacing: 0.1px; }
        .miq-root .tag { font-size: 9.5px; background: ${C.teal}33; color: ${C.tealLight}; padding: 1px 6px; border-radius: 5px; font-weight: 600; }

        .miq-root .alertBar { display: flex; align-items: center; gap: 10px; background: ${C.amber}14; border: 1px solid ${C.amber}44; color: ${C.text}; padding: 10px 16px; border-radius: 10px; font-size: 12.5px; margin-bottom: 16px; line-height: 1.5; }

        .miq-root .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .miq-root .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .miq-root .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        .miq-root .grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; }
        @media (max-width: 1300px) { .miq-root .grid5 { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 1100px) { .miq-root .grid3 { grid-template-columns: 1fr 1fr; } .miq-root .grid4 { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 800px) { .miq-root .grid2, .miq-root .grid3, .miq-root .grid4, .miq-root .grid5 { grid-template-columns: 1fr; } .miq-root .sidebar { display: none; } }

        .miq-root .kpi { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; padding: 14px 16px; }
        .miq-root .kpiTop { display: flex; justify-content: space-between; align-items: flex-start; }
        .miq-root .kpiLabel { font-size: 11px; color: ${C.textDim}; }
        .miq-root .kpiIconWrap { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
        .miq-root .kpiValue { font-family: 'Space Grotesk', sans-serif; font-size: 22px; font-weight: 700; margin-top: 8px; }
        .miq-root .kpiDelta { display: flex; align-items: center; gap: 3px; font-size: 11px; margin-top: 6px; }

        .miq-root .rankRow { display: flex; align-items: center; gap: 10px; }
        .miq-root .rankNo { width: 18px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: ${C.textFaint}; }
        .miq-root .tagRegion { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; }

        .miq-root .miniStat { flex: 1; min-width: 90px; background: ${C.panel2}; border: 1px solid ${C.border}; border-radius: 9px; padding: 10px 12px; text-align: center; }
        .miq-root .miniStatVal { font-family: 'Space Grotesk', sans-serif; font-size: 19px; font-weight: 700; }
        .miq-root .miniStatLbl { font-size: 10px; color: ${C.textFaint}; margin-top: 2px; }

        .miq-root .tableWrap { overflow-y: auto; }
        .miq-root .dataTable { width: 100%; border-collapse: collapse; font-size: 12px; }
        .miq-root .dataTable th { text-align: left; color: ${C.textFaint}; font-weight: 600; font-size: 10.5px; letter-spacing: 0.3px; padding: 6px 10px; border-bottom: 1px solid ${C.border}; position: sticky; top: 0; background: ${C.panel}; }
        .miq-root .dataTable td { padding: 7px 10px; border-bottom: 1px solid ${C.border}66; color: ${C.text}; }
        .miq-root .dataTable tr:hover td { background: ${C.panelAlt}; }
      `}</style>

      <Sidebar page={page} setPage={setPage} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />
      <div className="miqMain">
        <TopBar title={metaTxt.title} subtitle={metaTxt.sub} filters={filters} setFilters={setFilters}
          burden={burden} months={months} lastIdx={lastIdx} />
        <div className="content">
          {!M || !scoped ? (
            <div style={{ padding: 60, textAlign: 'center', color: C.textDim }}>Loading real burden data…</div>
          ) : <>
            <SelectionBanner filters={filters} months={months} lastIdx={lastIdx} />
            {page === 'overview' && <OverviewPage M={M} scoped={scoped} filters={filters} setFilters={setFilters} />}
            {page === 'iptp' && <IPTpPage M={M} scoped={scoped} filters={filters} burden={burden} />}
            {page === 'intervention' && <InterventionPage M={M} scoped={scoped} />}
          </>}
        </div>
      </div>
    </div>
  )
}
