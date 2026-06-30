import { useEffect, useState } from 'react'

const BASE = import.meta.env.BASE_URL || '/'

// variant-aware fetch: data lives under data/<before|after>/, except for
// non-malaria diseases, which live under data/<variant>/<disease>/ (a sibling
// convention, per the multi-disease plan — malaria's own unprefixed files are
// never moved). disease='malaria' (the default) reproduces today's exact path.
const j = (v, f, disease = 'malaria') =>
  fetch(disease === 'malaria' ? `${BASE}data/${v}/${f}` : `${BASE}data/${v}/${disease}/${f}`).then(r => r.json())

export function useData(variant = 'after', disease = 'malaria') {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    setData(null); setErr(null)
    Promise.all([
      j(variant, 'national.json', disease), j(variant, 'states.json', disease), j(variant, 'geo.json', disease), j(variant, 'meta.json', disease),
      j(variant, 'drivers.json', disease).catch(() => null), j(variant, 'leaderboard.json', disease).catch(() => null),
      j(variant, 'avp.json', disease).catch(() => null), j(variant, 'hotspots.json', disease).catch(() => null),
    ]).then(([national, states, geo, meta, drivers, leaderboard, avp, hotspots]) => {
      setData({ national, states, geo, meta, drivers, leaderboard, avp, hotspots, variant, disease })
    }).catch(e => setErr(String(e)))
  }, [variant, disease])
  return { data, err }
}

const _lgaCache = {}
export async function loadLgas(variant = 'after', disease = 'malaria') {
  const key = `${disease}:${variant}`
  if (_lgaCache[key]) return _lgaCache[key]
  _lgaCache[key] = await j(variant, 'lgas.json', disease)
  return _lgaCache[key]
}

const _dsCache = {}
export async function loadDataset(variant = 'after', disease = 'malaria') {
  const key = `${disease}:${variant}`
  if (_dsCache[key]) return _dsCache[key]
  const [dataset, dict] = await Promise.all([j(variant, 'dataset.json', disease), j(variant, 'data_dictionary.json', disease)])
  _dsCache[key] = { dataset, dict }
  return _dsCache[key]
}

const _mm = {}
export async function loadMM(variant, kind, disease = 'malaria') {        // 'national' | 'states' | 'lgas'
  const key = `${disease}:${variant}:${kind}`
  if (_mm[key]) return _mm[key]
  _mm[key] = await j(variant, `mm_${kind}.json`, disease).catch(() => null)
  return _mm[key]
}

// stable colour per model name for overlays
export const MODEL_PALETTE = ['#2563eb', '#e11d48', '#d97706', '#7c3aed', '#0891b2',
  '#65a30d', '#db2777', '#0d9488', '#ca8a04', '#9333ea', '#475569', '#0ea5e9', '#dc2626']

export const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.round(n).toLocaleString()
}
export const fmtFull = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString()
export const pct = (n) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'

export const COLORS = {
  accent: '#0d9488', accent2: '#2563eb', coral: '#e11d48', amber: '#d97706',
  violet: '#7c3aed', green: '#16a34a', grid: 'rgba(15,34,48,0.07)', axis: '#64798a',
}

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export const monthLabel = (d) => {
  const [y, m] = d.split('-')
  return MONTHS[+m - 1] + " '" + y.slice(2)
}

// zone classification by ANNUAL confirmed-case incidence per 1,000 population
export function zone(incidence) {
  if (incidence == null) return { name: 'Unknown', color: '#54677a' }
  if (incidence >= 400) return { name: 'Very High', color: '#dc2626' }
  if (incidence >= 250) return { name: 'High', color: '#ea580c' }
  if (incidence >= 100) return { name: 'Moderate', color: '#ca8a04' }
  if (incidence >= 25)  return { name: 'Low', color: '#16a34a' }
  return { name: 'Very Low', color: '#475569' }
}

// Non-malaria diseases display precomputed 0-100 burden-score zones (thresholds
// match etl_warehouse_common.zone_for_score) instead of malaria's incidence bands.
export function burdenZone(score) {
  if (score == null || isNaN(score)) return { name: 'Not a Hotspot', color: '#64748b' }
  if (score < 18) return { name: 'Not a Hotspot', color: '#64748b' }
  if (score < 38) return { name: 'Green', color: '#16a34a' }
  if (score < 58) return { name: 'Yellow', color: '#ca8a04' }
  if (score < 78) return { name: 'Amber', color: '#ea580c' }
  return { name: 'Red', color: '#dc2626' }
}

// Disease-aware zone dispatch: malaria keeps its existing incidence-based zone();
// every other disease uses the precomputed burden-score zone.
export function zoneFor(disease, value) {
  return disease === 'malaria' ? zone(value) : burdenZone(value)
}
