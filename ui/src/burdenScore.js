// Single source of truth for the malaria hotspot burden score. Both
// VisualOverview (the map + levers) and the MalariaIQ Dashboard's Command
// Overview / Hotspot Intelligence pages import this SAME module, so the two
// views can never disagree on a colour or a count again -- previously the
// Dashboard had its own simplified 3-factor approximation that produced
// different zones/counts than Visual Overview's real 10-factor formula.

export const ZONE_ORDER = ['Red', 'Amber', 'Yellow', 'Green', 'Not a Hotspot']

export function scoreToZone(display) {
  if (display < 60) return 'Not a Hotspot'
  if (display < 71) return 'Green'
  if (display < 81) return 'Yellow'
  if (display < 91) return 'Amber'
  return 'Red'
}

export const cl = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
// Self-contained (no dependency on lib.js's fmt) so this module has zero
// import surface -- just numbers in, numbers/zones out.
function fmtK(n) {
  if (n == null || isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.round(n).toLocaleString()
}
export const n0 = v => (v == null ? '0' : (Math.abs(v) >= 1000 ? fmtK(v) : (Math.abs(v) >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1))))

// x: { cases, total, trend, fever_testing, act, rain, temp, hum, itn, llin, ipt_cov }
export function scoreDetail(x, peerAvg, flags = {}) {
  const cases = x.cases || 0
  const total = (x.total || 0) || cases
  const vol = peerAvg > 0 ? cl(cases / (peerAvg * 3)) : (cases > 0 ? 1 : 0)
  const trend = cl(((x.trend || 0) + 1) / 2)
  const haveFeverTesting = x.fever_testing != null
  const testGap = haveFeverTesting ? cl(1 - (x.fever_testing || 0) / 100) : (total > 0 ? 0.3 : 0)
  // "treated" (Anti-Malarial treatment, beyond ACT courses) is entirely zero
  // across this warehouse extract -- not collected -- so it was a dead term
  // that never actually moved this factor. Dropped from both the formula and
  // its lever (there was never a real baseline to adjust away from).
  const gap = total > 0 ? cl((total - (x.act || 0)) / total) : 0
  const rain_s = cl((x.rain || 0) / 8)
  const temp_s = 1 - cl(Math.abs((x.temp ?? 27) - 27) / 12)
  const hum_s = cl(((x.hum ?? 60) - 40) / 55)
  const nets = (x.itn || 0) + (x.llin || 0)
  const ref = Math.max(1, cases * 2.5)
  const net_s = 1 - cl(nets / ref)
  const ipt_s = 1 - cl((x.ipt_cov || 0) / 100)
  const F = [
    { name: 'A1 · Case volume',   w: 20, sub: vol,     formula: 'min(1, cases ÷ (peer_avg × 3))',  subst: `min(1, ${n0(cases)} ÷ (${n0(peerAvg)} × 3))` },
    { name: 'A2 · Case trend',    w: 15, sub: trend,   formula: '(trend_ratio + 1) ÷ 2',            subst: `(${(x.trend || 0).toFixed(2)} + 1) ÷ 2` },
    { name: 'B1 · Testing gap',   w: 12, sub: testGap, formula: '1 − Fever Testing Rate ÷ 100',     subst: haveFeverTesting ? `1 − ${(x.fever_testing || 0).toFixed(0)} ÷ 100` : 'no data → 0.3' },
    { name: 'B2 · Treatment gap', w: 13, sub: gap,     formula: '(total − ACT) ÷ total',            subst: total > 0 ? `(${n0(total)} − ${n0(x.act || 0)}) ÷ ${n0(total)}` : 'no cases → 0' },
    { name: 'C1 · Rainfall',      w: 8,  sub: rain_s,  formula: 'mm/day ÷ 8',                       subst: `${(x.rain || 0).toFixed(1)} ÷ 8` },
    { name: 'C2 · Temperature',   w: 6,  sub: temp_s,  formula: '1 − |°C − 27| ÷ 12',               subst: `1 − |${(x.temp ?? 27).toFixed(1)} − 27| ÷ 12` },
    { name: 'C3 · Humidity',      w: 6,  sub: hum_s,   formula: '(% − 40) ÷ 55',                    subst: `(${(x.hum ?? 60).toFixed(0)} − 40) ÷ 55` },
    { name: 'D1 · Net gap',       w: 10, sub: net_s,   formula: '1 − (ITN + LLIN) ÷ (cases × 2.5)', subst: `1 − ${n0(nets)} ÷ ${n0(ref)}` },
    { name: 'D2 · IRS gap',       w: 5,  sub: 1.0,     formula: '1 − sprayed ÷ (total × 0.5)',      subst: 'no IRS data → 1.0' },
    { name: 'D3 · IPT gap',       w: 5,  sub: ipt_s,   formula: '1 − IPT_coverage ÷ 100',           subst: `1 − ${n0(x.ipt_cov || 0)} ÷ 100` },
  ]
  F.forEach(r => { r.points = r.w * r.sub })
  return { factors: F, raw: F.reduce((a, r) => a + r.points, 0) }
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

// rawRange: [min, max] of raw scores across the FULL national peer group --
// see VisualOverview's original comment: normalising against the range
// actually observed nationally each month is what lets the genuinely worst
// areas reach Red instead of capping out around Amber.
export function buildZones(units, peerAvg, flags, rawRange) {
  const raws = units.map(u => scoreDetail(u.x, peerAvg, flags).raw)
  const ranks = pctRanks(raws)
  const order = raws.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])
  const pos = {}; order.forEach(([, i], r) => { pos[i] = r + 1 })
  const [rawMin, rawMax] = rawRange || [Math.min(...raws, 0), Math.max(...raws, 1)]
  const rawSpan = (rawMax - rawMin) || 1
  const res = {}
  units.forEach((u, i) => {
    const rawScaled = cl((raws[i] - rawMin) / rawSpan)
    const rankTerm = 0.60 * ranks[i], rawTerm = 0.40 * rawScaled
    const display = cl(rankTerm + rawTerm, 0, 1) * 100
    res[u.key] = { raw: raws[i], rankPct: ranks[i], rankPos: pos[i], rankTerm, rawTerm, display, zone: scoreToZone(display), n: units.length }
  })
  return res
}
