// WHO/NMCP malaria predictive-analytics framework, mapped to THIS project's data.
// status: dhis2 = from the DHIS2 facility extract (in dataset) · weather = climate
// reanalysis already in the dataset · derived = computed by us in the After build ·
// external = would require an outside dataset we don't have.

export const STATUS = {
  dhis2: { label: 'DHIS2 ✓', color: '#0d9488', bg: '#e6f7f4', note: 'in your facility dataset' },
  weather: { label: 'Climate ✓', color: '#2563eb', bg: '#dbeafe', note: 'reanalysis, already in dataset' },
  derived: { label: 'Derived ✓', color: '#7c3aed', bg: '#ede9fe', note: 'computed in the After build' },
  added: { label: 'Fetched ✓', color: '#be185d', bg: '#fce7f3', note: 'real external data fetched & merged (After)' },
  external: { label: 'External ✗', color: '#b45309', bg: '#fef3c7', note: 'still needs an outside data source' },
}

export const CATALOGUE = [
  {
    cat: '1 · Climate & meteorological', tag: 'Primary driver — acts through vector & parasite biology',
    rows: [
      ['Monthly rainfall', 'mm/mo', 'CHIRPS / dataset', 'Standing water → Anopheles breeding', '1–2 mo', 'weather'],
      ['Rainfall lag 1 / lag 2', 'mm', 'derived', 'Breeding-habitat lag (top global predictor)', '1–2 mo', 'derived'],
      ['Rainfall cumulative 3-mo', 'mm', 'derived', 'Sustained habitat availability', '1–2 mo', 'derived'],
      ['Rainfall anomaly (z-score)', 'σ', 'derived', 'Above-normal breeding conditions', '2–4 wk', 'derived'],
      ['Heavy-rain / dry-spell counts', 'count', 'CHIRPS daily', 'Flush-out non-linearity', '0–2 wk', 'external'],
      ['Mean / min / max temperature', '°C', 'ERA5 / dataset', 'Sporogony (EIP), vector survival', '1–2 mo', 'weather'],
      ['Thermal suitability index', '0–1', 'derived (Mordecai)', 'Composite thermal performance, peak 25°C', '1–3 wk', 'derived'],
      ['Diurnal temperature range', '°C', 'derived', 'Wide range = vector thermal stress', '1–2 wk', 'derived'],
      ['Temperature anomaly', 'σ', 'derived', 'Anomalous warming events', '0–2 wk', 'derived'],
      ['Relative humidity', '%', 'ERA5 / dataset', 'Adult-vector desiccation survival', '0–2 wk', 'weather'],
      ['Humidity lag 1', '%', 'derived', 'Vector longevity lag', '1–2 mo', 'derived'],
      ['Solar radiation / wind speed', 'kWh, m/s', 'dataset', 'Micro-climate / dispersal', '—', 'weather'],
      ['NDVI + NDVI anomaly (per LGA)', 'index', 'FEWS NET satellite', 'Vegetation = shade/humidity/resting sites for vectors', '2–3 mo', 'added'],
      ['EVI / NDWI / LST / soil moisture', 'index', 'MODIS / Landsat / SMAP', 'Canopy / water extent / micro-climate', '2–5 wk', 'external'],
    ],
  },
  {
    cat: '2 · Entomological', tag: 'Most direct transmission measure — hardest to obtain',
    rows: [
      ['Climate-driven EIR proxy', 'index', 'derived', 'Suitability × rainfall × humidity = transmission pressure', '—', 'derived'],
      ['Mosquito recruitment φ(T,R)', 'index', 'derived', 'Rainfall_lag2 × thermal suitability', '—', 'derived'],
      ['Mosquito mortality μᵥ(T)', 'index', 'derived', 'Rises away from 25°C optimum', '—', 'derived'],
      ['Measured EIR / vectorial capacity', 'bites/p/d', 'field surveys', 'Gold-standard transmission rate', '—', 'external'],
      ['Anopheles density / sporozoite rate', '—', 'NMCP entomology', 'Vector abundance & infection', '—', 'external'],
      ['Species composition / insecticide resistance', '—', 'field / VCAG', 'An. gambiae efficiency; control efficacy', '—', 'external'],
    ],
  },
  {
    cat: '3 · Program / health-system interventions', tag: 'Modifies what climate & vectors would otherwise predict',
    rows: [
      ['LLINs distributed / ITN access', 'count/%', 'DHIS2', 'Household-level vector protection', '0–2 mo', 'dhis2'],
      ['Under-5 LLIN coverage', '%', 'DHIS2', 'Protects highest-mortality group', '0–1 mo', 'dhis2'],
      ['IRS rooms protected', 'count', 'DHIS2', 'Indoor residual spraying', '0–6 mo', 'dhis2'],
      ['IPTp 2+/3+ coverage', '%', 'DHIS2', 'Preventive therapy in pregnancy', '1–2 mo', 'dhis2'],
      ['ACT treatment courses', 'count', 'DHIS2', 'Clears parasites, stops onward spread', '0–1 mo', 'dhis2'],
      ['RDT / microscopy tested', 'count', 'DHIS2', 'Diagnostic / surveillance intensity', '0', 'dhis2'],
      ['Test positivity rate (TPR)', '%', 'DHIS2', 'Leading indicator of transmission', '0–1 mo', 'dhis2'],
      ['SMC rounds / MDA', 'count/%', 'NMCP', 'Seasonal chemoprevention (Sahel)', '0–1 mo', 'external'],
      ['RTS,S / R21 vaccine coverage', '%', 'NHMIS pilot', 'Transformative where scaled (post-2023)', '—', 'external'],
    ],
  },
  {
    cat: '4 · Population & demographic', tag: 'Who is at risk and where',
    rows: [
      ['Total population (projected)', 'count', 'NPC / WorldPop', 'Denominator for all rates', '—', 'dhis2'],
      ['Reporting-facility count', 'count', 'DHIS2', 'Catchment / access proxy', '—', 'dhis2'],
      ['Under-5 / pregnant-women population', 'count', 'WorldPop / census', 'Highest-vulnerability groups', '—', 'external'],
      ['Population density / growth', 'p/km²,%', 'WorldPop / census', 'Transmission amplifier', '—', 'external'],
      ['Rural-urban / migrant / refugee', '%', 'census / UNHCR', 'Habitat & immunity differences', '—', 'external'],
    ],
  },
  {
    cat: '5 · Health-system capacity', tag: 'Affects true & observed incidence',
    rows: [
      ['Reporting completeness (OPD/IPD/DTH)', '%', 'DHIS2', 'Data-quality covariate', '0', 'dhis2'],
      ['OPD consultation rate', '/1000', 'DHIS2', 'Health-seeking behaviour', '0', 'dhis2'],
      ['RDT / ACT stock availability', '%', 'DHIS2 commodity', 'Stock-out → under-detection', '0', 'external'],
      ['Facility distance / CHW density / absenteeism', 'km,/1000,%', 'GIS / HMIS', 'Access & delivery capacity', '—', 'external'],
    ],
  },
  {
    cat: '6 · Geospatial & environmental', tag: 'Spatial structure of transmission risk',
    rows: [
      ['Spatial lag of case burden', 'cases', 'derived', 'Neighbouring-area (state) spillover', '1 mo', 'derived'],
      ['Elevation / slope', 'm, °', 'SRTM DEM', 'Hard ceiling for transmission (>2000 m)', '—', 'external'],
      ['Distance to water / wetland / rice', 'km, km²', 'OSM / land cover', 'Permanent breeding habitat', '—', 'external'],
      ['Urbanization / deforestation / flood / roads', 'index', 'ESA / Hansen / OSM', 'Habitat change & mobility', '—', 'external'],
      ["Local Moran's I / Getis-Ord Gi*", 'cluster', 'derived (esda)', 'Hotspot cluster membership', '—', 'external'],
    ],
  },
  {
    cat: '7 · Socioeconomic & social determinants', tag: 'Structural vulnerability — all external (DHS/World Bank)',
    rows: [
      ['Poverty / wealth quintile', '%', 'DHS / World Bank', 'Net ownership, outdoor exposure', '—', 'external'],
      ['Housing quality / clean water / electricity', 'index/%', 'DHS / MICS', 'Indoor vector entry; water storage', '—', 'external'],
      ['Literacy / female education', '%, yrs', 'census / DHS', 'Care-seeking behaviour', '—', 'external'],
      ['Malnutrition / Gini', '%, 0–1', 'DHS / World Bank', 'Severity & differential vulnerability', '—', 'external'],
    ],
  },
  {
    cat: '8 · Epidemiological surveillance', tag: "The disease's own history — temporal autocorrelation",
    rows: [
      ['Confirmed cases lag 1 / 2 / 3', 'cases', 'DHIS2', 'Recent transmission momentum', '1–3 mo', 'dhis2'],
      ['Confirmed cases lag 6 / 12', 'cases', 'derived', 'Semi-annual & year-on-year pattern', '6–12 mo', 'derived'],
      ['Rolling mean 3 / 6-month', 'cases', 'derived', 'Smoothed / medium-term trend', '—', 'derived'],
      ['Year-over-year change', '%', 'derived', 'Growth / decline trajectory', '—', 'derived'],
      ['Test positivity rate lag 1', '%', 'derived', 'Leading indicator of incidence change', '1 mo', 'derived'],
      ['R₀ proxy (TPR × case growth)', 'index', 'derived', 'Intrinsic transmission potential', '—', 'derived'],
      ['Malaria prevalence (PfPR₂–₁₀)', '%', 'MAP / MIS survey', 'Population-level transmission intensity', '—', 'external'],
    ],
  },
  {
    cat: '9 · Climate change & ENSO', tag: 'Long-range & anomalous climate signals',
    rows: [
      ['ENSO — Niño 3.4 ONI', '°C anom', 'NOAA CPC', 'El Niño → rainfall anomalies (2023–24 super El Niño)', '—', 'added'],
      ['IOD — Dipole Mode Index', 'index', 'NOAA PSL', 'Drives African rainfall anomalies', '—', 'added'],
      ['Seasonal climate forecast', 'mm anom', 'IRI / ECMWF', '3-month-ahead rainfall', '—', 'external'],
      ['Long-term temperature trend', '°C/dec', 'ERA5', 'Climate-change baseline shift', '—', 'external'],
    ],
  },
]

// model architecture — which we actually built vs documented-only
export const MODELS_FRAMEWORK = [
  ['LightGBM / XGBoost / CatBoost', 'Gradient boosting on tabular + climate-lag features; SHAP-interpretable', 'built'],
  ['Random Forest / Extra Trees / HistGB', 'Bagged & boosted trees, non-linear rainfall response', 'built'],
  ['Support Vector Regression (RBF)', 'Kernel regression baseline', 'built'],
  ['Bayesian Ridge', 'Bayesian linear regression — uncertainty-aware', 'built'],
  ['MLP / LSTM / GRU', 'Feed-forward + recurrent deep nets on 12-month windows', 'built'],
  ['Transformer (self-attention)', 'Attention over the lag window — lightweight TFT-style', 'built'],
  ['SARIMAX-X / ARIMAX (conditional)', 'Seasonal ARIMA with exogenous climate/programme drivers', 'built'],
  ['Holt-Winters (ETS) / Seasonal-Naive', 'Classical seasonal baselines', 'built'],
  ['SEIR / TSIR (mechanistic)', 'Ross–Macdonald-derived time-series SIR with climate forcing', 'built'],
  ['Prophet (conditional)', 'Decomposable trend+seasonality with driver regressors', 'built'],
  ['Temporal Fusion Transformer (full)', 'Quantile multi-horizon attention — needs GPU + pytorch-forecasting', 'documented'],
  ['Bayesian Hierarchical (PyMC/INLA)', 'Partial pooling across districts, full posteriors', 'documented'],
  ['Graph Neural Network (ST-GCN)', 'District adjacency / migration network — needs spatial graph', 'documented'],
  ['Physics-Informed NN (PINN)', 'Embeds SEIR ODEs in the loss — frontier research', 'documented'],
]
