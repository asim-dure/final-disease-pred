import React, { useState, useEffect, useMemo } from 'react'
import { Card } from '../components'
import { loadDataset, COLORS, fmtFull } from '../lib'

const PAGE = 50

export default function DataExplorer({ data, variant = 'after', disease = 'malaria', datasetInfo, label }) {
  const [ds, setDs] = useState(null)
  const [q, setQ] = useState('')
  const [stateF, setStateF] = useState('')
  const [yearF, setYearF] = useState('')
  const [page, setPage] = useState(0)
  const [sortCol, setSortCol] = useState(4)   // confirmed cases (malaria default; harmless initial sort for other diseases)
  const [sortDir, setSortDir] = useState(-1)

  useEffect(() => { setDs(null); loadDataset(variant, disease).then(setDs) }, [variant, disease])
  useEffect(() => { setPage(0) }, [q, stateF, yearF, sortCol, sortDir])

  const states = useMemo(() => data.meta.ranking.map(r => r.state).sort(), [data])
  // "year" column index/values derived from the actual data, not hardcoded —
  // malaria's columns happen to have year at index 2, but other diseases'
  // dataset.json shapes don't, so look it up by name instead.
  const yearIdx = ds ? ds.dataset.columns.findIndex(c => c.toLowerCase() === 'year') : -1
  const years = useMemo(() => {
    if (!ds || yearIdx < 0) return []
    return [...new Set(ds.dataset.rows.map(r => r[yearIdx]))].sort()
  }, [ds, yearIdx])

  const filtered = useMemo(() => {
    if (!ds) return []
    const ql = q.toLowerCase()
    let rows = ds.dataset.rows
    if (stateF) rows = rows.filter(r => r[0] === stateF)
    if (yearF && yearIdx >= 0) rows = rows.filter(r => String(r[yearIdx]) === yearF)
    if (ql) rows = rows.filter(r => (r[0] + ' ' + r[1]).toLowerCase().includes(ql))
    rows = rows.slice().sort((a, b) => {
      const x = a[sortCol], y = b[sortCol]
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir
      return String(x).localeCompare(String(y)) * sortDir
    })
    return rows
  }, [ds, q, stateF, yearF, sortCol, sortDir])

  if (!ds) return <div className="loading"><div className="spinner" />Loading dataset…</div>

  const cols = ds.dataset.columns
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const nPages = Math.ceil(filtered.length / PAGE)
  const numCols = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])

  const sortBy = (i) => { if (sortCol === i) setSortDir(d => -d); else { setSortCol(i); setSortDir(-1) } }

  return (
    <>
      <div className="view-head">
        <h2>Data Explorer</h2>
        {disease === 'malaria' ? (
          <p>The facility-level DHIS2 extract aggregated to <b>LGA-month</b> (2023–2026), now enriched with
            <b> population</b> and <b>incidence per 1,000</b>. {fmtFull(ds.dataset.n)} rows · {cols.length} columns.
            Sort by any column, filter by state/year, or search a place name.</p>
        ) : (
          <p>
            {datasetInfo?.source ? <><b>Source:</b> {datasetInfo.source}. </> : null}
            {datasetInfo?.coverage ? <><b>Coverage:</b> {datasetInfo.coverage}. </> : null}
            {fmtFull(ds.dataset.n)} rows · {cols.length} columns.
            Sort by any column, filter by state/year, or search a place name.
          </p>
        )}
      </div>

      <div className="controls">
        <div className="select-wrap"><label>Search place</label>
          <input type="text" placeholder="state or LGA…" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 200 }} /></div>
        <div className="select-wrap"><label>State</label>
          <select value={stateF} onChange={e => setStateF(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">All states</option>{states.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
        {yearIdx >= 0 && <div className="select-wrap"><label>Year</label>
          <select value={yearF} onChange={e => setYearF(e.target.value)}>
            <option value="">All</option>{years.map(y => <option key={y} value={y}>{y}</option>)}</select></div>}
        <span className="chip" style={{ alignSelf: 'center' }}>{fmtFull(filtered.length)} rows match</span>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <Card className="col" style={{ flex: 3, minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div className="tbl-scroll" style={{ maxHeight: 620, border: 'none' }}>
            <table className="data">
              <thead><tr>
                {cols.map((c, i) => (
                  <th key={i} className={numCols.has(i) ? 'num' : ''} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => sortBy(i)}>
                    {c}{sortCol === i ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={numCols.has(j) ? 'num' : ''} style={j === 4 ? { color: COLORS.accent, fontWeight: 600 } : {}}>
                        {typeof v === 'number' && numCols.has(j) ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })) : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>Page {page + 1} of {nPages || 1} · showing {pageRows.length} of {fmtFull(filtered.length)}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" disabled={page === 0} onClick={() => setPage(0)}>« First</button>
              <button className="btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
              <button className="btn" disabled={page >= nPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
              <button className="btn" disabled={page >= nPages - 1} onClick={() => setPage(nPages - 1)}>Last »</button>
            </div>
          </div>
        </Card>
      </div>

      {datasetInfo && (
        <Card title={`About ${label || disease}'s dataset`} sub="Where this data comes from and what it does/doesn't cover" style={{ marginBottom: 18 }}>
          <table className="data">
            <tbody>
              {datasetInfo.source && <tr><td style={{ fontWeight: 600, width: 140, verticalAlign: 'top' }}>Source</td><td>{datasetInfo.source}</td></tr>}
              {datasetInfo.coverage && <tr><td style={{ fontWeight: 600, verticalAlign: 'top' }}>Coverage</td><td>{datasetInfo.coverage}</td></tr>}
              {datasetInfo.granularity && <tr><td style={{ fontWeight: 600, verticalAlign: 'top' }}>Granularity</td><td>{datasetInfo.granularity}</td></tr>}
            </tbody>
          </table>
          {datasetInfo.notes && <p style={{ fontSize: '.84rem', lineHeight: 1.6, color: 'var(--txt-2)', marginTop: 10 }}>{datasetInfo.notes}</p>}
          {ds.dataset.note && <div className="muted" style={{ fontSize: '.76rem', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>{ds.dataset.note}</div>}
        </Card>
      )}

      <Card title="Data dictionary" sub="How each field is built (SUM / MEAN / derived)">
        <table className="data">
          <thead><tr><th>Field</th><th>Aggregation</th><th>Description</th></tr></thead>
          <tbody>
            {ds.dict.map((d, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600, color: 'var(--txt-0)' }}>{d.field}</td>
                <td><span className="badge-soft" style={{ background: d.agg === 'SUM' ? '#e6f7f4' : d.agg === 'MEAN' ? '#fef3c7' : '#dbeafe', color: d.agg === 'SUM' ? '#0d9488' : d.agg === 'MEAN' ? '#b45309' : '#1d4ed8' }}>{d.agg}</span></td>
                <td>{d.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!datasetInfo && <div className="muted" style={{ fontSize: '.76rem', marginTop: 10 }}>{ds.dataset.note}</div>}
      </Card>
    </>
  )
}
