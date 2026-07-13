// HIV hotspot burden score -- same "single source of truth, weighted-factor"
// pattern as ../burdenScore.js (malaria), scoped to the 5 factor groups
// confirmed to have real, current NDARS (system_id=7) data: Testing,
// Intervention (ART reach), Treatment (VL-monitoring), Population, and
// Population density (standing in for socio-economic context -- no
// HIV-specific socio-economic covariate set is joinable to this geography
// yet; disclosed here rather than fabricated, same honesty bar as every
// other judgment call in this project).
//
// x: { hts_tested, hts_pos, art_curr, art_vl_tested, population, pop_density }

export const cl = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

function fmtK(n) {
  if (n == null || isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.round(n).toLocaleString()
}
export const n0 = v => (v == null ? '0' : (Math.abs(v) >= 1000 ? fmtK(v) : (Math.abs(v) >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1))))

export function hivScoreDetail(x, peerAvg) {
  const pop = Math.max(1, x.population || 0)
  const testRate = (x.hts_tested || 0) / pop
  const posRate = (x.hts_pos || 0) / pop
  const artRate = (x.art_curr || 0) / pop
  // Case/positivity burden -- same "vs peer average" relative scaling as
  // malaria's own heaviest-weighted factor, since raw positive-test counts
  // alone would just re-rank states by population.
  //
  // hts_reported/art_reported (from export_burden_hiv.py) gate testGap/
  // caseBurden/artGap to the SAME neutral 0.3 fallback this file already
  // uses for "insufficient peer data" -- verified live (Niger, Apr 2024):
  // 4 LGAs had hts_tested=0/art_curr=0 not because testing/ART genuinely
  // stopped, but because that month's HTS/ART Monthly forms weren't filed
  // at all (the SAME facilities had real, substantial PMTCT counts that
  // exact month) -- without this gate, a real reporting gap reads as a
  // maximal service gap (testGap/artGap = 1, near-max score) instead of
  // "unknown," which is a materially different, overstated risk claim.
  // x.hts_reported/x.art_reported default to true when absent (older
  // cached data, or a synthetic/aggregated row) so this is a no-op unless
  // the flag is explicitly false.
  const hasHts = x.hts_reported !== false
  const hasArt = x.art_reported !== false
  const caseBurden = !hasHts ? 0.3 : (peerAvg?.posRate > 0 ? cl(posRate / (peerAvg.posRate * 2.5)) : (posRate > 0 ? 1 : 0))
  const testGap = !hasHts ? 0.3 : (peerAvg?.testRate > 0 ? cl(1 - testRate / peerAvg.testRate) : 0.3)
  const artGap = !hasArt ? 0.3 : (peerAvg?.artRate > 0 ? cl(1 - artRate / peerAvg.artRate) : 0.3)
  // VL-monitoring gap is self-contained (a real ratio, no peer needed): what
  // share of people CURRENTLY ON ART are also getting a viral-load check.
  const vlGap = (hasArt && x.art_curr > 0) ? cl(1 - (x.art_vl_tested || 0) / x.art_curr) : 0.5
  const densityFactor = peerAvg?.maxDensity > 0 ? cl((x.pop_density || 0) / peerAvg.maxDensity) : 0

  const F = [
    { name: 'A1 · Case burden (positivity)', w: 30, sub: caseBurden, formula: 'min(1, pos_rate ÷ (peer_avg_pos_rate × 2.5))', subst: `min(1, ${(posRate * 1000).toFixed(2)}/1k ÷ (${((peerAvg?.posRate || 0) * 1000).toFixed(2)}/1k × 2.5))` },
    { name: 'B1 · Testing gap', w: 20, sub: testGap, formula: '1 − test_rate ÷ peer_avg_test_rate', subst: `1 − ${(testRate * 1000).toFixed(1)}/1k ÷ ${((peerAvg?.testRate || 0) * 1000).toFixed(1)}/1k` },
    { name: 'C1 · ART coverage gap', w: 20, sub: artGap, formula: '1 − art_rate ÷ peer_avg_art_rate', subst: `1 − ${(artRate * 1000).toFixed(1)}/1k ÷ ${((peerAvg?.artRate || 0) * 1000).toFixed(1)}/1k` },
    { name: 'D1 · VL-monitoring gap', w: 20, sub: vlGap, formula: '1 − VL-tested ÷ currently-on-ART', subst: `1 − ${n0(x.art_vl_tested)} ÷ ${n0(x.art_curr)}` },
    { name: 'E1 · Population density', w: 10, sub: densityFactor, formula: 'density ÷ national max density', subst: `${n0(x.pop_density)} ÷ ${n0(peerAvg?.maxDensity)}` },
  ]
  F.forEach(r => { r.points = r.w * r.sub })
  return { factors: F, raw: F.reduce((a, r) => a + r.points, 0) }
}

export function scoreToZone(display) {
  if (display < 60) return 'Not a Hotspot'
  if (display < 71) return 'Green'
  if (display < 81) return 'Yellow'
  if (display < 91) return 'Amber'
  return 'Red'
}

export function pctRanks(vals) {
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

// Same rank(60%) + normalized-raw(40%) blend as malaria's buildZones, so the
// two dashboards' zone distributions are readable the same way.
//
// Units with x.reported === false (this area had NO real reported row at
// all for this month -- see export_burden_hiv.py's "reported" column) are
// excluded from the ranked/scored set entirely and returned with zone
// 'No Data' instead of being scored. This matters because a totally
// unreported area's fields are all 0 (fillna'd), which the score formula
// would otherwise read as "0 tests, 0 on ART despite real population" --
// a maximal SERVICE GAP, not a genuinely low-risk reading -- confirmed live
// on Niger/Apr-2024: 4 unreported LGAs scored Amber (77-85 display) purely
// from that gap math, none of it backed by an actual report. Excluding them
// from the ranked set also stops their presence from diluting/shifting the
// percentile ranks of areas that DID report.
export function hivBuildZones(units, peerAvg, rawRange) {
  const reported = units.filter(u => u.x?.reported !== false)
  const unreported = units.filter(u => u.x?.reported === false)
  const raws = reported.map(u => hivScoreDetail(u.x, peerAvg).raw)
  const ranks = pctRanks(raws)
  const order = raws.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])
  const pos = {}; order.forEach(([, i], r) => { pos[i] = r + 1 })
  const [rawMin, rawMax] = rawRange || [Math.min(...raws, 0), Math.max(...raws, 1)]
  const rawSpan = (rawMax - rawMin) || 1
  const res = {}
  reported.forEach((u, i) => {
    const rawScaled = cl((raws[i] - rawMin) / rawSpan)
    const rankTerm = 0.60 * ranks[i], rawTerm = 0.40 * rawScaled
    const display = cl(rankTerm + rawTerm, 0, 1) * 100
    res[u.key] = { raw: raws[i], rankPct: ranks[i], rankPos: pos[i], rankTerm, rawTerm, display, zone: scoreToZone(display), n: reported.length }
  })
  unreported.forEach(u => {
    res[u.key] = { raw: null, rankPct: null, rankPos: null, rankTerm: null, rawTerm: null, display: null, zone: 'No Data', n: reported.length }
  })
  return res
}
