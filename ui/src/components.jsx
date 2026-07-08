import React, { useMemo, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell, Legend,
} from 'recharts'
import { COLORS, fmt, fmtFull, monthLabel, MODEL_PALETTE } from './lib'

// Small ⓘ info icon with a hover/click tooltip — for non-technical users.
export const InfoTip = ({ text, title, w = 260 }) => {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        style={{ cursor: 'help', width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
          background: 'rgba(13,148,136,.14)', color: 'var(--accent)', fontSize: '.66rem', fontWeight: 800,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontStyle: 'italic',
          border: '1px solid rgba(13,148,136,.3)', userSelect: 'none', marginLeft: 5 }}>i</span>
      {open && (
        <span style={{ position: 'absolute', zIndex: 50, top: '130%', left: '50%', transform: 'translateX(-50%)',
          width: w, background: 'var(--bg-2)', color: 'var(--txt-0)', borderRadius: 9, padding: '10px 12px',
          fontSize: '.74rem', lineHeight: 1.55, fontWeight: 400, fontStyle: 'normal', textAlign: 'left',
          boxShadow: '0 10px 34px rgba(0,0,0,.28)', pointerEvents: 'none' }}>
          {title && <b style={{ display: 'block', color: '#5eead4', marginBottom: 3 }}>{title}</b>}
          {text}
        </span>
      )}
    </span>
  )
}

export const Card = ({ title, sub, right, children, style }) => (
  <div className="card" style={style}>
    {(title || right) && (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          {title && <h3>{title}</h3>}
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {right}
      </div>
    )}
    {children}
  </div>
)

export const KPI = ({ label, value, delta, deltaClass, color = COLORS.accent }) => (
  <div className="card kpi">
    <div className="accent-bar" style={{ background: color }} />
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {delta != null && <div className={`delta ${deltaClass}`}>{delta}</div>}
  </div>
)

const TT = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 13px', fontSize: '.8rem', boxShadow: '0 8px 30px rgba(15,34,48,.12)' }}>
      <div style={{ color: 'var(--txt-0)', fontWeight: 700, marginBottom: 6 }}>{monthLabel(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{p.name}</span>
          <span className="mono" style={{ fontWeight: 600 }}>{fmtFull(p.value)}{unit || ''}</span>
        </div>
      ))}
    </div>
  )
}

const axisProps = {
  tick: { fill: COLORS.axis, fontSize: 11 }, tickLine: false,
  axisLine: { stroke: 'rgba(0,201,167,0.12)' },
}

// Time series: actual (solid) + forecast (dashed), with a split marker
export function ForecastChart({ data, height = 320, splitDate }) {
  // data: [{date, cases, forecast(bool)}]
  const merged = data.map(d => ({
    date: d.date,
    actual: d.forecast ? null : d.cases,
    forecast: d.forecast ? d.cases : null,
  }))
  // bridge the gap: last actual also seeds forecast line
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].forecast != null && merged[i - 1].actual != null)
      merged[i - 1].forecast = merged[i - 1].actual
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={merged} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="gF" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.amber} stopOpacity={0.22} />
            <stop offset="100%" stopColor={COLORS.amber} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="date" {...axisProps} tickFormatter={monthLabel} minTickGap={32} />
        <YAxis {...axisProps} tickFormatter={fmt} width={48} />
        <Tooltip content={<TT />} />
        {splitDate && <ReferenceLine x={splitDate} stroke="rgba(255,209,102,.5)" strokeDasharray="4 4"
          label={{ value: 'Forecast →', fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />}
        <Area type="monotone" dataKey="actual" name="Actual" stroke={COLORS.accent} strokeWidth={2.4}
          fill="url(#gA)" connectNulls dot={false} />
        <Area type="monotone" dataKey="forecast" name="Forecast" stroke={COLORS.amber} strokeWidth={2.4}
          strokeDasharray="6 4" fill="url(#gF)" connectNulls dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function CompareChart({ data, series, height = 320, unit, splitDate, splitLabel = 'Forecast →' }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="date" {...axisProps} tickFormatter={monthLabel} minTickGap={32} />
        <YAxis {...axisProps} tickFormatter={fmt} width={48} />
        <Tooltip content={<TT unit={unit} />} />
        {splitDate && <ReferenceLine x={splitDate} stroke="rgba(217,119,6,.55)" strokeDasharray="4 4"
          label={{ value: splitLabel, fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />}
        <Legend wrapperStyle={{ fontSize: '.78rem', color: 'var(--txt-1)' }} />
        {series.map(s => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color}
            strokeWidth={2.2} strokeDasharray={s.dashed ? '6 4' : undefined} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

// Multi-model overlay: actual line + any number of model forecast trajectories,
// toggled via chips. `mm` = { dates:[...], models:{ name:[values...] } } for a location.
export function ModelOverlay({ actualSeries, mm, defaultSelected = ['Ensemble (top-3)'], height = 340 }) {
  const modelNames = mm?.models ? Object.keys(mm.models) : []
  const colorFor = (m) => MODEL_PALETTE[modelNames.indexOf(m) % MODEL_PALETTE.length]
  const [sel, setSel] = useState(defaultSelected.filter(d => modelNames.includes(d)))

  const data = useMemo(() => {
    if (!mm) return []
    const actByDate = {}
    ;(actualSeries || []).forEach(d => { if (!d.forecast) actByDate[d.date] = Math.round(d.cases) })
    const mmIndex = {}
    modelNames.forEach(m => mm.models[m].forEach((v, i) => { (mmIndex[mm.dates[i]] ||= {})[m] = v }))
    const allDates = [...new Set([...(actualSeries || []).map(d => d.date), ...mm.dates])].sort()
    const rows = allDates.map(date => {
      const row = { date, Actual: actByDate[date] ?? null }
      sel.forEach(m => { row[m] = mmIndex[date]?.[m] ?? null })
      return row
    })
    const idx = allDates.indexOf(mm.dates[0])      // bridge model lines to the last actual
    if (idx > 0 && rows[idx - 1] && rows[idx - 1].Actual != null) sel.forEach(m => { rows[idx - 1][m] = rows[idx - 1].Actual })
    return rows
  }, [actualSeries, mm, sel])

  const series = [{ key: 'Actual', name: 'Actual', color: 'var(--txt-0)', width: 2.6 },
    ...sel.map(m => ({ key: m, name: m, color: colorFor(m), dashed: true }))]

  if (!mm) return <div className="loading" style={{ height }}><div className="spinner" />Loading model forecasts…</div>
  return (
    <>
      <div className="tag-list" style={{ marginBottom: 12 }}>
        {modelNames.map(m => {
          const on = sel.includes(m); const col = colorFor(m)
          return (
            <button key={m} className="chip" onClick={() => setSel(s => s.includes(m) ? s.filter(x => x !== m) : [...s, m])}
              style={{ cursor: 'pointer', borderColor: on ? col : 'var(--border)', background: on ? col + '16' : 'transparent', color: on ? col : 'var(--txt-2)', fontWeight: on ? 700 : 500 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: col, display: 'inline-block', opacity: on ? 1 : .35 }} />{m}
            </button>
          )
        })}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid stroke={COLORS.grid} vertical={false} />
          <XAxis dataKey="date" {...axisProps} tickFormatter={monthLabel} minTickGap={32} />
          <YAxis {...axisProps} tickFormatter={fmt} width={48} />
          <Tooltip content={<TT />} />
          <ReferenceLine x={mm.dates[0]} stroke="rgba(217,119,6,.5)" strokeDasharray="4 4"
            label={{ value: 'Forecast →', fill: COLORS.amber, fontSize: 11, position: 'insideTopRight' }} />
          <Legend wrapperStyle={{ fontSize: '.76rem', color: 'var(--txt-1)' }} />
          {series.map(s => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color}
              strokeWidth={s.width || 2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {sel.length === 0 && <div className="muted" style={{ fontSize: '.78rem', marginTop: 6 }}>Select one or more models above to overlay their forecasts.</div>}
    </>
  )
}

export function AnnualBars({ data, height = 260 }) {
  // data: [{year, cases, forecast(bool)}]
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="year" {...axisProps} />
        <YAxis {...axisProps} tickFormatter={fmt} width={48} />
        <Tooltip cursor={{ fill: 'rgba(0,201,167,0.05)' }}
          content={({ active, payload, label }) => active && payload?.length ? (
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 12px', fontSize: '.8rem', boxShadow: '0 8px 30px rgba(15,34,48,.12)' }}>
              <div style={{ color: 'var(--txt-0)', fontWeight: 700 }}>{label}{payload[0].payload.forecast ? ' (forecast)' : ''}</div>
              <div className="mono" style={{ color: payload[0].payload.forecast ? COLORS.amber : COLORS.accent }}>{fmtFull(payload[0].value)} cases</div>
            </div>) : null} />
        <Bar dataKey="cases" radius={[6, 6, 0, 0]}>
          {data.map((d, i) => <Cell key={i} fill={d.forecast ? COLORS.amber : COLORS.accent} fillOpacity={d.forecast ? 0.7 : 0.95} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Lightweight markdown renderer for Groq-generated reports (headers, bold,
// bullet lists, and pipe tables with a `---` separator row) -- no markdown
// dependency added to the project; just enough to make the LLM's GFM-style
// output render as real HTML instead of raw pipe-text.
function renderInline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => p.startsWith('**') && p.endsWith('**')
    ? <b key={i}>{p.slice(2, -2)}</b> : <React.Fragment key={i}>{p}</React.Fragment>)
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.length > 0 && cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c))
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

export function MarkdownLite({ text }) {
  if (!text) return null
  const lines = String(text).split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // pipe table: header row, separator row, then data rows
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line)
      const rows = []
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        rows.push(splitRow(lines[j]))
        j++
      }
      blocks.push(
        <div key={i} style={{ overflowX: 'auto', margin: '10px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr>{header.map((h, k) => (
                <th key={k} style={{ textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid var(--border)', color: 'var(--txt-1)', fontWeight: 700, whiteSpace: 'nowrap' }}>{renderInline(h)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} style={{ background: ri % 2 ? 'var(--bg-3)' : 'transparent' }}>
                  {r.map((c, ci) => <td key={ci} style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--txt-2)' }}>{renderInline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      i = j
      continue
    }

    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^(#{1,4})/)[1].length
      const txt = line.replace(/^#{1,4}\s/, '')
      const Tag = level <= 2 ? 'h4' : 'h5'
      blocks.push(<Tag key={i} style={{ margin: '14px 0 6px', color: 'var(--txt-1)' }}>{renderInline(txt)}</Tag>)
      i++; continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      let j = i
      while (j < lines.length && /^\s*[-*]\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*[-*]\s+/, ''))
        j++
      }
      blocks.push(
        <ul key={i} style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
          {items.map((it, k) => <li key={k} style={{ margin: '2px 0' }}>{renderInline(it)}</li>)}
        </ul>
      )
      i = j; continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      let j = i
      while (j < lines.length && /^\s*\d+\.\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*\d+\.\s+/, ''))
        j++
      }
      blocks.push(
        <ol key={i} style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
          {items.map((it, k) => <li key={k} style={{ margin: '2px 0' }}>{renderInline(it)}</li>)}
        </ol>
      )
      i = j; continue
    }

    if (line.trim() === '') { i++; continue }

    blocks.push(<p key={i} style={{ margin: '4px 0' }}>{renderInline(line)}</p>)
    i++
  }
  return <div style={{ fontSize: '.86rem', lineHeight: 1.6, color: 'var(--txt-2)' }}>{blocks}</div>
}

export function HBars({ data, max, valueKey = 'value', labelKey = 'label', color = COLORS.accent, fmtVal = fmt }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 130, fontSize: '.82rem', color: 'var(--txt-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d[labelKey]}</div>
          <div style={{ flex: 1, background: 'var(--bg-3)', borderRadius: 6, height: 22, position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(2, (d[valueKey] / max) * 100)}%`,
              background: typeof color === 'function' ? color(d) : color, borderRadius: 6, transition: 'width .4s' }} />
          </div>
          <div className="mono" style={{ width: 70, textAlign: 'right', fontSize: '.82rem', color: 'var(--txt-0)' }}>{fmtVal(d[valueKey])}</div>
        </div>
      ))}
    </div>
  )
}
