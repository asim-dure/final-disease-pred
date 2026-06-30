import React, { useState, useEffect } from 'react'
import { useData } from './lib'
import Overview from './views/Overview'
import GeoExplorer from './views/GeoExplorer'
import Forecast from './views/Forecast'
import Simulator from './views/Simulator'
import ModelLab from './views/ModelLab'
import DataExplorer from './views/DataExplorer'
import Methodology from './views/Methodology'
import WhatIfLab from './views/WhatIfLab'
import VisualOverview from './views/VisualOverview'
import DataNotes from './views/DataNotes'

// Minister-facing sidebar: two plain-language groups always open, plus a
// "Deep Dive" group for technical/model-internals sections, collapsed by default.
// Visual Overview leads the list — it's the map ministers actually look at;
// National Overview is internal ML-model experimentation, so it lives in Deep Dive.
// Built from the selected disease's `capabilities` block (from /api/diseases) so
// malaria's full sidebar renders unchanged, while thinner diseases simply omit
// items their data can't support — never a disabled/greyed-out item.
function buildNavGroups(label, caps) {
  const overviewItems = [{ id: 'visual', label: 'Visual Overview', ico: '🗺️' }]
  // 'visuallga' (a separate "All-LGA Hotspot Map" item rendering VisualOverview
  // with allLgas) is hidden from the nav -- Visual Overview's own State/LGA
  // scope toggle already covers it, so a second nav entry for the same map is
  // redundant. The route + component still exist below (App.jsx's view==='visuallga'
  // branch), just not linked from the sidebar.

  const interventionItems = []
  if (caps.simulator) interventionItems.push({ id: 'simulator', label: 'What-If Simulator', ico: '🎛️' })
  if (caps.whatiflab) interventionItems.push({ id: 'whatiflab', label: 'What-If Lab', ico: '🔬' })

  const groups = [
    { id: 'g-overview', label: `${label} Overview`, items: overviewItems },
  ]
  if (interventionItems.length) groups.push({ id: 'g-intervention', label: 'Intervention Planning', items: interventionItems })
  return groups
}

function buildDeepDiveItems(caps, disease) {
  const items = []
  if (caps.overview) items.push({ id: 'overview', label: 'National Overview (ML experiments)', ico: '📊' })
  if (caps.model_lab) items.push({ id: 'modellab', label: 'Model Lab', ico: '🧪' })
  if (caps.data_explorer) items.push({ id: 'data', label: 'Data Explorer', ico: '🗄️' })
  if (caps.methodology) items.push({ id: 'method', label: 'Model & Methodology', ico: '🧬' })
  // every disease except malaria (and, for the full lever panel, HIV's own
  // Simulator tab) has no driver/intervention dataset in the warehouse, so
  // the hotspot map can't show a live "Intervention levers" panel the way
  // malaria's does -- this note explains why, instead of leaving the gap
  // unexplained.
  if (disease !== 'malaria') items.push({ id: 'datanotes', label: "About this disease's data", ico: 'ℹ️' })
  return items
}

const MALARIA_CAPS = {
  overview: true, hotspot_map: true, forecast: true, simulator: true,
  whatiflab: true, data_explorer: true, methodology: true, model_lab: true,
}

const GROUP_ICONS = { malaria: '🦟', hiv: '🩸', tb: '🫁', ncd: '🩺', ntd: '🪱' }

// Embedding support (e.g. inside ODC's "Predictive Analysis" sections via
// iframe): reading these query params is the ONLY way default standalone
// behavior changes -- a plain visit to / with no params renders identically
// to before. ?disease=<id> locks the initial tab; ?embedded=1 hides the
// disease switcher entirely (single-disease embed); ?embedded=1&group=ncd|ntd
// restricts the switcher to diseases in that group instead of hiding it
// outright, since NCD/NTD are umbrella sections covering several diseases.
const KNOWN_DISEASE_IDS = ['malaria', 'hiv', 'tb', 'hypertension', 'diabetes', 'cervical_cancer', 'sickle_cell', 'asthma', 'yaws', 'elephantiasis']
const GROUP_DEFAULT_DISEASE = { ncd: 'hypertension', ntd: 'sickle_cell' }

function readEmbedParams() {
  if (typeof window === 'undefined') return { urlDisease: null, embedded: false, embedGroup: null }
  const params = new URLSearchParams(window.location.search)
  return {
    urlDisease: params.get('disease'),
    embedded: params.get('embedded') === '1',
    embedGroup: params.get('group'),
  }
}

export default function App() {
  const { urlDisease, embedded, embedGroup } = readEmbedParams()
  const initialDisease = (urlDisease && KNOWN_DISEASE_IDS.includes(urlDisease)) ? urlDisease
    : (embedGroup && GROUP_DEFAULT_DISEASE[embedGroup]) ? GROUP_DEFAULT_DISEASE[embedGroup]
    : 'malaria'

  const [diseases, setDiseases] = useState(null)
  const [disease, setDisease] = useState(initialDisease)
  const [view, setView] = useState('visual')
  const variant = 'after'
  const [deepDiveOpen, setDeepDiveOpen] = useState(false)
  const { data, err } = useData(variant, disease)

  // load the disease list once on mount — until it resolves, only malaria's
  // tab renders (today's exact UI), so there's never a layout flash.
  useEffect(() => {
    fetch('/api/diseases').then(r => r.json()).then(setDiseases).catch(() => setDiseases(null))
  }, [])

  const activeCfg = diseases?.find(d => d.id === disease)
  const caps = disease === 'malaria' ? MALARIA_CAPS : (activeCfg?.capabilities || MALARIA_CAPS)
  const label = activeCfg?.label || (disease === 'malaria' ? 'Malaria' : disease)
  const navGroups = buildNavGroups(label, caps)
  const deepDiveItems = buildDeepDiveItems(caps, disease)

  // if switching disease drops the current view from its nav (e.g. leaving a
  // diseases-only tab like Simulator), fall back to Visual Overview.
  const allIds = new Set([...navGroups.flatMap(g => g.items.map(i => i.id)), ...deepDiveItems.map(i => i.id)])
  useEffect(() => { if (!allIds.has(view)) setView('visual') }, [disease])

  const selectDisease = (id) => { setDisease(id); setView('visual') }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">{GROUP_ICONS[activeCfg?.group] || '🦟'}</span>
          <div>
            <h1>{label} Risk<br />Intelligence</h1>
            <div className="sub">Nigeria · DHIS2</div>
          </div>
        </div>

        {diseases && diseases.length > 1 && !(embedded && !embedGroup) && (
          <div className="disease-tabs">
            {diseases
              .filter(d => !(embedded && embedGroup) || d.group === embedGroup)
              .map(d => (
                <button key={d.id} className={`disease-tab ${disease === d.id ? 'active' : ''}`}
                  onClick={() => selectDisease(d.id)} title={d.label}>
                  {d.label}
                </button>
              ))}
          </div>
        )}

        <nav className="nav">
          {navGroups.map(g => (
            <div className="nav-group" key={g.id}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map(n => (
                <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => setView(n.id)}>
                  <span className="ico">{n.ico}</span>{n.label}
                </button>
              ))}
            </div>
          ))}

          {deepDiveItems.length > 0 && (
            <div className="nav-group">
              <button className="nav-deepdive-toggle" onClick={() => setDeepDiveOpen(o => !o)}>
                <span className="ico">🧬</span>Deep Dive
                <span className="chev">{deepDiveOpen ? '▾' : '▸'}</span>
              </button>
              {deepDiveOpen && (
                <div className="nav-deepdive-items">
                  {deepDiveItems.map(n => (
                    <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => setView(n.id)}>
                      <span className="ico">{n.ico}</span>{n.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          Facility-level surveillance aggregated to LGA / State.<br />
          WHO/SEIR climate, spatial &amp; mechanistic models.
        </div>
      </aside>

      <main className="main">
        {err && <div className="loading" style={{ color: '#e11d48' }}>Failed to load data: {err}</div>}
        {!data && !err && <div className="loading"><div className="spinner" />Loading data…</div>}
        {data && view === 'overview' && <Overview data={data} variant={variant} disease={disease} />}
        {data && view === 'visual' && <VisualOverview data={data} variant={variant} disease={disease} />}
        {data && view === 'visuallga' && <VisualOverview data={data} variant={variant} allLgas disease={disease} />}
        {data && view === 'geo' && <GeoExplorer data={data} variant={variant} disease={disease} />}
        {data && view === 'forecast' && <Forecast data={data} variant={variant} disease={disease} />}
        {data && view === 'simulator' && <Simulator data={data} variant={variant} disease={disease} />}
        {data && view === 'modellab' && <ModelLab data={data} variant={variant} disease={disease} />}
        {data && view === 'data' && <DataExplorer data={data} variant={variant} disease={disease} datasetInfo={activeCfg?.dataset_info} label={label} />}
        {data && view === 'method' && <Methodology data={data} variant={variant} disease={disease} />}
        {data && view === 'datanotes' && <DataNotes disease={disease} label={label} caps={caps} datasetInfo={activeCfg?.dataset_info} />}
        {view === 'whatiflab' && <WhatIfLab disease={disease} />}
      </main>
    </div>
  )
}
