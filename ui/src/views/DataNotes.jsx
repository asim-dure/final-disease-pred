import React from 'react'
import { Card } from '../components'

// Plain-language explanation of why several panels that exist for malaria
// (and partly for HIV) are intentionally absent for every other disease --
// not a bug, not a missing feature, just honest about what the warehouse
// actually contains. Shown in Deep Dive so a minister/analyst clicking
// around isn't left wondering why a panel they saw on malaria is missing.
export default function DataNotes({ disease, label, caps, datasetInfo }) {
  return (
    <>
      <div className="view-head">
        <h2>About {label}'s data</h2>
        <p>Where this data comes from, what it covers, and why some panels available for Malaria aren't shown here.</p>
      </div>

      {datasetInfo && (
        <Card title={`Dataset: ${label}`} sub="Source, coverage and known limitations">
          <table className="data">
            <tbody>
              {datasetInfo.source && <tr><td style={{ fontWeight: 600, width: 140, verticalAlign: 'top' }}>Source</td><td>{datasetInfo.source}</td></tr>}
              {datasetInfo.coverage && <tr><td style={{ fontWeight: 600, verticalAlign: 'top' }}>Coverage</td><td>{datasetInfo.coverage}</td></tr>}
              {datasetInfo.granularity && <tr><td style={{ fontWeight: 600, verticalAlign: 'top' }}>Granularity</td><td>{datasetInfo.granularity}</td></tr>}
            </tbody>
          </table>
          {datasetInfo.notes && (
            <p style={{ fontSize: '.84rem', lineHeight: 1.6, color: 'var(--txt-2)', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {datasetInfo.notes}
            </p>
          )}
        </Card>
      )}

      <Card title="No Intervention Levers panel on the hotspot map" sub="By design, not a bug" style={datasetInfo ? { marginTop: 16 } : {}}>
        <p>
          Malaria's hotspot map lets you drag levers (rainfall, ACT treatment courses, LLIN nets, etc.) and watch the
          burden score react live, because the warehouse has real monthly driver/intervention figures for malaria at
          LGA level. For {label.toLowerCase()}, no equivalent per-LGA driver dataset exists in the warehouse — only
          case volume and trend. Showing levers without real driver data would mean fabricating an effect that has no
          underlying evidence, so the panel is left out entirely rather than faked.
        </p>
      </Card>

      <Card title="Burden score methodology" sub="What's actually shown instead" style={{ marginTop: 16 }}>
        <p>
          The map still shows a genuine 0–100 burden score and zone (Red/Amber/Yellow/Green/Not a Hotspot), computed
          from case volume (60%) + case trend (40%) — precomputed once in Python from the warehouse, not adjustable
          live. This is the same "volume_trend" tier used for every disease without driver data.
        </p>
      </Card>

      {caps.simulator ? (
        <Card title="What-If Simulator is available for this disease" sub="A separate, real-data tab" style={{ marginTop: 16 }}>
          <p>
            Unlike the map, the <b>What-If Simulator</b> tab for {label} uses real intervention indicators from the
            warehouse (e.g. testing volume, condoms distributed, PrEP screening for HIV) with their own elasticities —
            that's a genuinely different, smaller set of levers than malaria's 5, scoped to what's actually measured.
          </p>
        </Card>
      ) : (
        <Card title="No What-If Simulator for this disease" sub="No driver/intervention indicators in the warehouse" style={{ marginTop: 16 }}>
          <p>
            The Simulator tab is hidden for {label} because the warehouse has no intervention/driver indicators at all
            for this disease — only reported case counts. There is nothing to build real levers from without inventing
            numbers, so the tab is omitted rather than shown empty or fabricated.
          </p>
        </Card>
      )}

      {!caps.overview && (
        <Card title="No 'National Overview (ML experiments)' tab" sub="No multi-model leaderboard for this disease" style={{ marginTop: 16 }}>
          <p>
            Malaria's National Overview compares several trained forecasting models against each other (a multi-model
            leaderboard). Training new models for other diseases is out of scope here — {label}'s forecast comes from
            a single SARIMAX model run directly against the warehouse's time series, so there's no leaderboard to show.
          </p>
        </Card>
      )}

      {!caps.forecast && (
        <Card title="No Forecast / What-If tabs" sub="Insufficient historical data" style={{ marginTop: 16 }}>
          <p>
            {label} doesn't have enough monthly historical data points in the warehouse to fit a reliable SARIMAX
            forecast (forecasting needs a meaningful run of consistent monthly history). Rather than show an
            unreliable projection, the Forecast and What-If tabs are omitted for this disease.
          </p>
        </Card>
      )}
    </>
  )
}
