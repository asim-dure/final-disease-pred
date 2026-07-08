// Shared MapLibre style for every Nigeria-only choropleth (Visual Overview's
// map, the Dashboard's Risk Map). A real basemap style (e.g. CARTO Positron)
// draws the whole world -- neighbouring countries, their city labels, their
// borders -- which reads as "why is Niger/Benin/Cameroon/Chad on my Nigeria
// map?" A blank background-only style means MapLibre renders nothing but a
// flat colour; the ONLY geography visible is whatever this app's own
// GeoJsonLayer (Nigeria's real state/LGA boundaries) draws on top of it.
export const BLANK_MAP_STYLE = {
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#eef2f6' } },
  ],
}
