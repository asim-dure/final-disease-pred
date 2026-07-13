// Shared MapLibre style for every Nigeria-only choropleth (Visual Overview's
// map, the Dashboard's Risk Map). A real basemap style (e.g. CARTO Positron)
// draws the whole world -- neighbouring countries, their city labels, their
// borders -- which reads as "why is Niger/Benin/Cameroon/Chad on my Nigeria
// map?" A blank background-only style means MapLibre renders nothing but a
// flat colour; the ONLY geography visible is whatever this app's own
// GeoJsonLayer (Nigeria's real state/LGA boundaries) draws on top of it.
//
// A function (not a static object) purely so the background colour can
// follow the current Light/Dark theme -- reads the same data-theme attribute
// styles.css's :root[data-theme='dark'] selector keys off, no React context
// needed for one cosmetic paint colour. Re-evaluated on every render (cheap,
// tiny object), so toggling the theme updates it immediately.
export function blankMapStyle() {
  const dark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
  return {
    version: 8,
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': dark ? '#141b28' : '#eef2f6' } },
    ],
  }
}
