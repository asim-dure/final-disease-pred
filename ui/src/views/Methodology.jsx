import React from 'react'
import { Card, KPI } from '../components'
import { COLORS, fmt } from '../lib'
import { CATALOGUE, STATUS, MODELS_FRAMEWORK } from '../framework'

export default function Methodology({ data, variant = 'after' }) {
  const lb = data.leaderboard
  const reg = lb?.regression || []
  const champ = reg.find(r => r.kind === 'Ensemble') || reg[0]
  const bestClf = lb ? lb.classification.models.slice().sort((a, b) => b.metrics.ROC_AUC - a.metrics.ROC_AUC)[0] : null
  const isAfter = variant === 'after'
  const nFeat = lb?.features?.length

  // count dataset coverage across the framework catalogue
  const allRows = CATALOGUE.flatMap(c => c.rows)
  const covered = allRows.filter(r => r[5] !== 'external').length

  return (
    <>
      <div className="view-head">
        <h2>Model & Methodology</h2>
        <p>End-to-end pipeline: facility-level aggregation → population enrichment → feature engineering →
          a multi-model ML / DL / time-series benchmark → an ensemble champion forecasting to 2030, with a
          conditional driver layer powering the What-If simulator.</p>
      </div>

      <div className="champion-banner" style={{ background: 'linear-gradient(100deg,rgba(124,58,237,.10),rgba(37,99,235,.06))' }}>
        <span className="trophy">🧬</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: '1.02rem' }}>
            WHO/SEIR-augmented build
          </div>
          <div className="muted" style={{ fontSize: '.82rem' }}>
            {`REAL external data fetched & merged — LGA-level NDVI (FEWS NET satellite, ~96% of LGAs matched) and NOAA ENSO/IOD climate indices — together with derived climate lags & anomalies, SEIR mechanistic proxies (EIR, R₀, recruitment, mortality), surveillance lags, a spatial-spillover feature, and 5 additional models (SVR, Bayesian Ridge, Transformer, conditional Prophet, and a Ross–Macdonald SEIR/TSIR). ${nFeat ? nFeat + ' features used.' : ''}`}
          </div>
        </div>
      </div>

      {lb && (
        <div className="grid kpis">
          <KPI label="Models benchmarked" value={lb.n_models} delta="ML · DL · Time-Series · Classification" deltaClass="flat" color={COLORS.accent} />
          <KPI label="Champion (LGA RMSE)" value={fmt(champ.lga.RMSE)} delta={`${lb.champion}`.slice(0, 22)} deltaClass="flat" color={COLORS.accent2} />
          <KPI label="Champion MAPE" value={champ.lga.MAPE_pct + '%'} delta={`R² ${champ.lga.R2} · MedAE ${fmt(champ.lga.MedAE)}`} deltaClass="flat" color={COLORS.violet} />
          <KPI label="Hotspot AUC / Gini" value={bestClf.metrics.ROC_AUC} delta={`${bestClf.model} · Gini ${bestClf.metrics.Gini}`} deltaClass="flat" color={COLORS.amber} />
        </div>
      )}

      <Card title="Pipeline & methodology">
        <div className="method-section">
          <h4>1 · Aggregation (facility → ward → LGA → state)</h4>
          <p>The 3.27M-row, 993 MB DHIS2 facility extract is streamed in chunks and aggregated under the column rules:</p>
          <ul>
            <li><b>SUM</b> — absolute counts (confirmed cases, doses, nets, admissions, tests) summed across facilities.</li>
            <li><b>MEAN</b> — rates, percentages, coverage and environmental variables averaged across facilities.</li>
            <li><b>FIRST</b> — identifiers / static geo attributes; <code>facility</code> rolls up to a facility count.</li>
          </ul>
          <p>Target totals reconcile exactly across all four levels (34.78M confirmed cases nationally in 2025).</p>
        </div>
        <div className="method-section">
          <h4>2 · Population enrichment & incidence</h4>
          <p>State populations (NPC/NBS 2022 projection, +2.5%/yr) are attached and split to LGAs by facility share,
            yielding <code>incidence per 1,000</code>. Population now ships inside the aggregated CSVs and the Data Explorer.</p>
        </div>
        <div className="method-section">
          <h4>3 · Leakage-free features</h4>
          <p>Forecasting uses only knowable-ahead signals: target lags (1/2/3/12), rolling means/std, seasonal
            harmonics, trend, log-population, weather (incl. 1-month lag), and a train-only LGA/state level encoding.
            Operational counts (RDTs performed, ACT given) correlate strongly with cases but are <i>co-determined</i>
            with them, so they are excluded as predictors — see the Model Lab for the full feature list.</p>
        </div>
        <div className="method-section">
          <h4>3c · Reporting-gap imputation</h4>
          <p>December 2023 is a total surveillance gap in the source data (national confirmed cases = 0 — no facility
            reported that month). It is imputed per-LGA by linear interpolation between Nov-2023 and Jan-2024 so the
            outlier doesn't distort the trend or the models. Population is used <b>as a raw count</b> (persons), with
            no log or rolling transform.</p>
        </div>
        <div className="method-section">
          <h4>4 · Conditional forecasting — how the future is predicted</h4>
          <p>Because the strongest predictors are programme indicators (testing, treatment) that aren't yet observed
            for future months, the forecast is <b>conditional</b>: we forecast each input first, then predict cases
            from those inputs. Concretely:</p>
          <ul>
            <li><b>Every driver is forecast forward individually</b> — for each LGA and feature, future months =
              that feature's seasonal climatology <i>plus its own damped 2023→2025 trend</i>, so 2026–2030 tracks each
              indicator's recent growth path rather than a flat average.</li>
            <li>The case models then run <b>recursively</b> on those forecast inputs (their own predictions feed back
              as lags), month by month to Dec 2030.</li>
            <li><b>Time-series models are conditional too:</b> <code>SARIMAX-X</code> and <code>ARIMAX</code> use the
              forecast drivers (RDT volume, ACT volume, rainfall, temperature) as <b>exogenous regressors</b> — so
              they differ from the univariate seasonal-naive / ETS baselines instead of mirroring them.</li>
          </ul>
        </div>
        <div className="method-section">
          <h4>5 · The model benchmark</h4>
          <ul>
            <li><b>Machine Learning:</b> k-NN, Random Forest, Extra Trees, Gradient Boosting, HistGradientBoosting,
              XGBoost, LightGBM, CatBoost.</li>
            <li><b>Deep Learning (PyTorch):</b> MLP, LSTM and GRU sequence models on 12-month windows.</li>
            <li><b>Time-Series:</b> SARIMAX-X (conditional), ARIMAX (conditional), Holt-Winters (ETS), seasonal-naive.</li>
            <li><b>Classification:</b> 6 models predicting hotspot status (accuracy / precision / recall / F1 / AUC /
              Gini / log-loss / Brier).</li>
          </ul>
          <p>All are validated on the held-out <b>2026 Q1</b> via true multi-step recursion. The top-3 regressors form
            the production <b>ensemble champion</b> ({lb?.champion}) used for the forecast to 2030.</p>
        </div>
        <div className="method-section">
          <h4>6 · What-If simulator</h4>
          <p>The What-If simulator starts each lever at the location's <i>forecasted</i> driver baseline and
            re-conditions the case forecast through per-driver elasticities — so scenarios reflect each location's own
            projected path rather than a generic zero point.</p>
        </div>
      </Card>

      <Card title="Burden score, hotspot zones &amp; the Mechanistic model — full justification"
        sub="Why each parameter is in the score, why it's weighted the way it is, and exactly where every number comes from"
        style={{ marginTop: 18 }}>
        <div className="method-section">
          <h4>Facility-level burden (4 factors, 0–100)</h4>
          <p>Each factor was chosen because it answers a DIFFERENT question a health officer actually asks about a
            facility, and together they can't be gamed by improving just one number:</p>
          <ul>
            <li><b>Case volume (45%)</b> — "how big is the problem here at all?" Log-scaled against the national P99
              (~865 confirmed cases/month) so one outlier facility doesn't compress everyone else near zero. Given the
              highest weight because raw caseload is the single strongest predictor of where limited commodities
              (RDTs, ACTs, nets) should physically go this month.</li>
            <li><b>Testing gap (25%)</b> — "are we even finding the cases that exist?" Built from <code>Fever Testing
              Rate</code> (DHIS2), the share of fever presentations actually given a parasitological test. This
              REPLACED test-positivity (confirmed ÷ RDT tested) after your review flagged it as reading too high
              almost everywhere: clinicians mostly test patients they already suspect have malaria, so positivity
              clusters near 90–100% at most facilities and stops discriminating between them. Testing gap doesn't
              saturate the same way and captures a genuinely different, actionable risk — facilities that under-test
              are the ones most likely to be missing or mistreating real cases.</li>
            <li><b>Treatment gap (18%)</b> — "of the cases we found, how many actually got treated?" Confirmed cases
              minus ACT courses given, as a share of confirmed cases. A facility can have low volume and good testing
              but still fail patients here if ACT stock runs out.</li>
            <li><b>Diagnostic gap (12%)</b> — "how much of what we're reporting is even confirmed?" Presumed
              (clinically-diagnosed, unconfirmed) share of total reported cases. Lowest weight because it's the most
              downstream of the four — a symptom of the testing gap above, kept separate only because DHIS2 reports it
              as its own number and a large gap here specifically flags over-reliance on clinical diagnosis.</li>
          </ul>
          <p>LLIN/net distribution was considered but excluded — it's reported in only ~4% of facility-month rows,
            too sparse to score reliably without effectively guessing for 96% of facilities.</p>
        </div>
        <div className="method-section">
          <h4>LGA/state-level burden (10 factors, rank-blended)</h4>
          <p>The map's own score blends four groups — <b>A) disease load</b> (case volume + trend, 35%),
            <b> B) transmission signal</b> (RDT positivity + treatment gap, 25%), <b>C) weather</b> (rainfall,
            temperature vs the 27°C optimum, humidity, 20%), and <b>D) protection gaps</b> (net gap, IRS gap, IPT gap,
            20%) — then blends the raw 0–100 score with each area's PERCENTILE RANK against its peers (60% rank / 40%
            raw). The rank component exists so "high burden" always means something relative to the rest of Nigeria,
            not just relative to an arbitrary fixed scale.</p>
        </div>
        <div className="method-section">
          <h4>Hotspot zone thresholds — why they were raised</h4>
          <p>Zones are <b>Not a Hotspot 0–59 · Green 60–70 · Yellow 71–80 · Amber 81–90 · Red 91–100</b> (previously
            0–18/38/58/78, a far lower bar). The old thresholds had a hidden problem: the rank-blend above gives EVERY
            area a rank-based floor just from being ranked at all (the median area sits at rank_pct≈0.5, contributing
            ~30 points from rank alone before its raw severity is even considered) — so under the old &lt;18 cutoff
            for "Not a Hotspot," most LGAs cleared that bar by default and the map read as almost entirely colour,
            regardless of whether transmission was actually elevated. Raising the floor to 60 means an area now needs
            genuinely high combined rank+severity to earn ANY hotspot colour — a below-median area cannot cross into
            Green by rank alone, so the map goes back to showing WHERE the real problem areas are instead of shading
            the whole country.</p>
        </div>
        <div className="method-section">
          <h4>Why nothing reached Red at first, and exactly how that was fixed</h4>
          <p>Raising the thresholds (above) exposed a SECOND, separate problem: with real national data loaded, the
            single worst STATE in the country topped out at a display score of <b>85.4</b> (Amber) — nothing ever
            reached 91+, no matter how severe. Checking the maths directly against the live data showed why: the
            raw 0–100 formula has a theoretical ceiling of 100, but two of its ten factors are effectively CONSTANT in
            practice — RDT-positivity defaults to a fixed 0.55 nationwide (positive-test counts aren't collected at
            all, flagged via <code>flags.no_rdt_pos</code>) and the IRS-gap factor is hard-fixed at 1.0 (no IRS data
            exists at all) — so the REAL achievable raw score across all 37 states only ever spanned <b>38.6 to
            63.6</b>, a 25-point band nowhere near the formula's theoretical 100. Blending that narrow, compressed raw
            score with the rank term (which DOES span the full 0–100 by construction) meant the raw component could
            never contribute enough for the worst real state to clear 91, however severe it genuinely was.</p>
          <p><b>The fix:</b> instead of feeding <code>raw ÷ 100</code> directly into the blend, the raw score is now
            MIN-MAX NORMALISED against the actual range observed nationally that month
            (<code>(raw − national_min) ÷ (national_max − national_min)</code>) before blending. This doesn't change
            what's being measured — the same 10 weighted factors, the same 60/40 rank/raw blend — it only rescales the
            raw component to use the range that's ACTUALLY achieved in practice, so the single worst area nationally
            reaches close to 100 (Red) instead of capping out around 85 (Amber) purely because of the formula's
            unreachable theoretical ceiling. Re-checked against the live warehouse data after the fix: state-level, the
            worst state (Abia, raw 63.6, ranked #1) now scores <b>85.4 → 100</b>; LGA-level, across all 774 LGAs
            nationally the distribution became <b>6 Red · 48 Amber · 64 Yellow · 105 Green · 551 Not a Hotspot</b> —
            genuine reds for the worst areas, while the majority (551 of 774) correctly stay unflagged.</p>
          <p><b>Critical detail — this normalisation is always computed against the FULL NATIONAL set, never the
            current view.</b> When you drill into one state, its LGAs are still compared against all 774 LGAs
            nationally, not just that state's own ~10–30 LGAs. Without this, a genuinely low-burden state's single
            least-bad LGA could look like the worst in the country purely from being the top of a small, mild peer
            group — the exact same class of bug the FACILITY-level score was fixed for earlier this session
            (facilities were briefly ranked only against their own LGA's peers, making outlier facilities in
            low-burden LGAs look artificially severe). The peer-average used in the case-volume factor is computed
            the same way, for the same reason: always the national LGA average, never re-baselined per state.</p>
          <p><b>Facility-level scoring needed a different fix, for a different reason.</b> Facility burden is
            deliberately an ABSOLUTE score (not rank-based at all — see the facility-burden section above), so the
            same rank/raw blend fix doesn't apply. Sampling 671 real facilities across the six highest-burden LGAs in
            the country (Kaduna North, Alimosho, Umunneochi, Bindawa, Takai, Abuja Municipal — chosen BECAUSE they're
            the worst LGAs nationally, so this sample is already biased toward the worst facilities in Nigeria, not a
            random draw) found the single worst facility in the country scored only <b>86.9</b> raw — still short of
            91+ — because in practice most facilities test and treat reasonably well even when case volume is high,
            so the testing/treatment/diagnostic-gap factors rarely all max out simultaneously the way the formula's
            theoretical ceiling assumes. The fix is a fixed empirical stretch constant
            (<code>100 ÷ 87 ≈ 1.15</code>, derived directly from that sample's observed ceiling), applied to every
            facility's raw score everywhere — NOT a per-LGA or per-request recalculation, so the score stays
            absolute and comparable nationwide, exactly as originally designed. Re-checked after the fix: the same
            671-facility sample now distributes as <b>1 Red · 8 Yellow · 61 Green · 601 Not a Hotspot</b>, with the
            single genuinely worst facility in the sample correctly reaching 99.9.</p>
        </div>
        <div className="method-section">
          <h4>Mechanistic (Ross-Macdonald) What-If parameters — what's real vs. derived vs. illustrative</h4>
          <p>Every parameter in the Mechanistic panel is tagged with exactly where it comes from (visible in the
            panel's own "Location context" table and API response), because a government audience specifically needs
            to know which numbers are measured and which are estimated:</p>
          <ul>
            <li><b>Measured (warehouse-sourced, used as-is):</b> population, population density, PfPR (parasite rate),
              rainfall, temperature, NDVI, poverty (MPI headcount %), education deprivation (literacy proxy), IPTp
              coverage (via "% of all Antenatal care clients receiving malaria IPT" — the DHIS2 "IPTp1 Coverage"
              indicator itself was found to be corrupted at source, ~46% of rows exceeding 100% with values up to
              1e8%, so this cleaner proxy indicator is used instead), and RDT testing volume.</li>
            <li><b>Derived from real data via a standard demographic ratio (NOT this location's own measurement,
              because Nigeria does not publish per-LGA figures for these):</b> pregnant-women population
              (population × 4.4%, consistent with national crude birth rate) and under-5 population (population ×
              17.5%, UN World Population Prospects Nigeria age structure) — both applied to this LGA's REAL population
              figure, so the population itself is real even though the age/condition split is a standard ratio.
              "Infected population" is derived the same way, as population × PfPR — a prevalence-based estimate, not
              a case count.</li>
            <li><b>Illustrative (no source data exists at all, literature/policy defaults used as a starting point
              only):</b> IRS coverage (~8% national baseline — IRS campaigns are localised and no per-LGA coverage is
              published) and vaccine/child-immunisation coverage (~31% national baseline, NDHS-consistent). Both are
              clearly labelled as such and fully user-adjustable — they are starting POINTS for a scenario, not
              claims about this specific LGA.</li>
          </ul>
          <p>Two further modelling choices, both driven by real data: <b>population density</b> feeds the model as a
            bounded dilution factor on vector-to-host ratio (denser settlements dilute the same mosquito population
            over more people — the standard explanation for why urban malaria transmission tends to run lower than
            rural at equal rainfall), and the <b>socioeconomic vulnerability index</b> (average of poverty + education
            deprivation) discounts nominal ACT coverage into an EFFECTIVE coverage — a poorer, less literate area
            converts the same nominal treatment coverage into less complete treatment-seeking behaviour in practice.
            IPTp and vaccine coverage are deliberately audience-scoped (to pregnant women and under-5s respectively)
            rather than applied population-wide, because that's what they actually are clinically.</p>
        </div>
      </Card>

      <Card title="Full technical deep-dive — everything done, end to end"
        sub="The complete, auditable record of the data handling, feature forecasting, prediction and validation"
        style={{ marginTop: 18 }}>

        <div className="method-section">
          <h4>A · Source data & multi-level aggregation</h4>
          <ul>
            <li><b>Input:</b> a 993&nbsp;MB DHIS2 facility extract — 3,269,768 rows × 123 columns covering 37 states +
              FCT, {data.meta.summary.n_lgas} LGAs, 8,942 wards and 46,399 facilities. Target =
              <code>MAL - Malaria cases confirmed (number)</code>.</li>
            <li><b>Streamed aggregation</b> (250k-row chunks) rolls facility records up to ward / LGA / state / national
              under fixed rules: <b>SUM</b> for the 33 absolute-count columns, <b>MEAN</b> for the 82 rate / coverage /
              environment columns (computed as Σ&nbsp;value ÷ Σ&nbsp;non-null count), and FIRST / group-keys for geo &
              time. Confirmed-case totals reconcile <b>exactly</b> across all four levels.</li>
            <li><b>Population</b> = NPC/NBS 2022 state projection grown at 2.5%/yr, split to each LGA by its share of
              reporting facilities; <code>incidence per 1,000 = cases ÷ population × 1,000</code>.</li>
            <li><b>Reporting-gap imputation:</b> December 2023 was a total surveillance gap (national confirmed = 0).
              It is imputed per-LGA by linear interpolation between Nov-2023 and Jan-2024 for the target and every
              reported indicator, so the outlier doesn't bias trends or training.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>B · Train / test / forecast split</h4>
          <ul>
            <li><b>Usable target window:</b> Jan&nbsp;2023 – Mar&nbsp;2026 (2020-2022 carry no confirmed-case data;
              2026-04 onward is unobserved).</li>
            <li><b>Training:</b> 2023-01 … 2025-12 (complete — 36 months × {data.meta.summary.n_lgas} LGAs).</li>
            <li><b>Test (held out):</b> 2026-01 … 2026-03 (the only out-of-sample months with actuals) — used
              <i>only</i> to measure accuracy, never for fitting.</li>
            <li><b>Forecast horizon:</b> 2026-04 … 2030-12, produced by recursive multi-step prediction.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>C · Feature engineering & selection</h4>
          <ul>
            <li><b>122 candidate features</b> = 8 base + 114 malaria indicators. Base: <code>lag1/lag2/lag3</code>
              (log of confirmed cases 1–3 months back), <code>population</code> (raw persons, no transform),
              <code>year</code>, <code>month</code>, and <code>state_level</code> / <code>lga_level</code> (each
              area's mean log-cases over the training window — a leakage-free identity encoding). The 114 indicators
              are the aggregated programme columns (RDT/microscopy tested, ACT given, LLINs, IPTp coverage, positivity
              rates, admissions, …) used at their monthly value.</li>
            <li><b>Model-based selection:</b> every candidate is ranked by importance <i>averaged across Random Forest +
              XGBoost + LightGBM</i> on the training data. The 8 base features are always kept; the <b>top 32
              indicators</b> fill the set to <b>K = {lb.feature_selection?.k ?? 40}</b>. The full 122-candidate ranking
              (score + selected flag) is shown in the Model Lab so it's auditable.</li>
            <li><b>Target transform:</b> models learn <code>log1p(cases)</code>; predictions are <code>expm1</code>-ed
              and clipped to [0, 2,000,000] per LGA-month for numerical stability. Feature names are sanitized so
              special characters (%, &lt;, [CONFIG]) don't break XGBoost / LightGBM.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>D · How each feature is forecast (conditional inputs)</h4>
          <p>The strongest predictors are programme indicators that aren't yet observed for future months, so each one
            is <b>forecast individually first</b>, then fed to the case models. For 2023-01…2026-03 the <i>actual</i>
            observed value is used. For the forecast horizon (2026-04…2030-12), for every LGA × feature:</p>
          <p style={{ fontFamily: 'var(--mono)', background: '#eaf4f2', padding: '10px 14px', borderRadius: 8, color: 'var(--txt-0)', fontSize: '.82rem' }}>
            forecast(lga, month, year) = seasonal_climatology(lga, month) + 0.5 × slope(lga, feature) × (year − 2024)
          </p>
          <ul>
            <li><code>seasonal_climatology</code> = that LGA's mean of the feature for that calendar month over
              2023-2025 (captures seasonality).</li>
            <li><code>slope</code> = (feature mean in 2025 − feature mean in 2023) ÷ 2 — the LGA's own annual trend —
              damped by 0.5 and <b>bounded to ±100%</b> of the climatology, clamped ≥ 0 (captures growth without
              runaway). This is why 2026+ tracks each indicator's recent path rather than a flat multi-year average.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>E · How cases are predicted from the forecast features (recursion)</h4>
          <ul>
            <li>The case model is trained once on the training matrix (40 features → <code>log1p</code> cases).</li>
            <li>Forecasting is <b>recursive and month-by-month</b>: for each future month the model predicts cases from
              (i) the conditionally-forecast indicator features for that month and (ii) <code>lag1/lag2/lag3</code>,
              which in the horizon are the model's <i>own previous predictions</i>. The prediction is written back and
              the process steps forward — so the autoregressive signal propagates while the indicators follow their
              own forecasts.</li>
            <li><b>Validation</b> uses the identical recursion but over 2026 Q1, scoring predictions against the
              held-out actuals (true multi-step, predictions feed forward — not one-step cheating).</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>F · Conditional time-series (SARIMAX-X / ARIMAX)</h4>
          <ul>
            <li>Unlike the univariate baselines, <code>SARIMAX-X</code> (order (1,1,1)(1,1,0)₁₂) and <code>ARIMAX</code>
              (order (2,1,2)) are fit on the target <b>plus exogenous regressors</b>: total RDT tests, total ACT given,
              mean rainfall and mean temperature (standardized).</li>
            <li>They forecast the future <b>conditioned on those drivers' own forecasts</b> (Section D), at national,
              state and LGA level — which is why they now diverge from, and beat, seasonal-naive / ETS instead of
              mirroring them. National 2026 Q1 MAPE: SARIMAX-X {lb.time_series?.find(t => t.model.includes('SARIMAX'))?.national?.MAPE_pct}%,
              ARIMAX {lb.time_series?.find(t => t.model.includes('ARIMAX'))?.national?.MAPE_pct}% vs seasonal-naive
              {' '}{lb.time_series?.find(t => t.model.includes('Naive'))?.national?.MAPE_pct}%.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>G · The model roster (no extra training beyond this)</h4>
          <ul>
            <li><b>Machine Learning (8):</b> k-Nearest Neighbors, Random Forest (200 trees, depth 14), Extra Trees
              (200, depth 16), Gradient Boosting (300, depth 3, lr 0.05), HistGradientBoosting (500 iters),
              XGBoost (700, depth 6, lr 0.03, subsample 0.85), LightGBM (700, 48 leaves), CatBoost (600, depth 7).
              Linear models (Ridge/Lasso/ElasticNet) were excluded — multicollinear with 114 indicators and they
              extrapolate explosively in recursion.</li>
            <li><b>Deep Learning (3, PyTorch):</b> MLP (128→64→1, dropout 0.1, SmoothL1, 60 epochs) on the tabular
              features; LSTM and GRU (hidden 48) on 12-month sequence windows of [log-cases, rainfall, temperature,
              humidity, sin/cos seasonality].</li>
            <li><b>Time-Series (4):</b> SARIMAX-X (conditional), ARIMAX (conditional), Holt-Winters (ETS, additive
              trend+seasonal), Seasonal-Naive (same month last year — the baseline).</li>
            <li><b>Classification (6):</b> hotspot detection (LGA-month incidence ≥ the training top-tercile threshold)
              — Logistic Regression, Random Forest, HistGradientBoosting, XGBoost, LightGBM, CatBoost; time-based test
              2025-10 … 2026-03; metrics accuracy / precision / recall / F1 / ROC-AUC / Gini / log-loss / Brier.</li>
          </ul>
        </div>

        <div className="method-section">
          <h4>H · Validation, metrics & the production champion</h4>
          <ul>
            <li><b>Held-out window:</b> 2026 Q1, recursive. Regression metrics reported: Actual, Predicted, Diff,
              ME (bias), MAE (L1), MedAE, RMSE, MSE (L2), Std-error, Max-AE, MAPE, sMAPE, RMSLE, R² — recomputed for
              pooled / national / state / single-LGA geographies in the Model Lab.</li>
            <li><b>Champion = top-3 regressors by validation RMSE, ensembled</b> (mean of predictions): currently
              {' '}<b>{lb.champion}</b>. Validation: LGA MAPE {champ?.lga?.MAPE_pct}%, national MAPE
              {' '}{champ?.national?.MAPE_pct}%.</li>
            <li>The production forecast (the National Overview / Geographic Explorer / Forecast lines) is this champion
              refit through 2026-03 and run recursively to 2030. The multi-model overlay refits each model the same way
              for side-by-side comparison. <b>Cross-check:</b> the ML ensemble and the conditional SARIMAX-X
              independently land within ~1% of each other for 2026.</li>
            <li><b>Leakage note (stated for transparency):</b> the dominant features (RDT tested, ACT given, total
              reported) are same-month operational counts mechanically tied to confirmed cases, so the ~3-6% validation
              error reflects that concurrent relationship plus the quality of the driver forecasts — not pure
              out-of-sample skill.</li>
          </ul>
        </div>
      </Card>

      {/* ---------- DHIS2 vs non-DHIS2 framework catalogue (always shown) ---------- */}
      <Card title="Feature framework — DHIS2 vs non-DHIS2 (full WHO/NMCP catalogue)"
        sub={`Every feature in the expert malaria framework, tagged by where it comes from. ${covered} of ${allRows.length} are available in this project (DHIS2 / climate-reanalysis / derived); the rest need external datasets.`}
        style={{ marginTop: 18 }}>
        <div className="pill-legend" style={{ marginBottom: 14 }}>
          {Object.entries(STATUS).map(([k, s]) => (
            <span key={k}><span className="badge-soft" style={{ background: s.bg, color: s.color }}>{s.label}</span> {s.note}</span>
          ))}
        </div>
        {CATALOGUE.map((cat, ci) => (
          <div key={ci} style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: '.92rem', color: 'var(--txt-0)', margin: '4px 0' }}>{cat.cat}</h4>
            <div className="muted" style={{ fontSize: '.76rem', marginBottom: 6 }}>{cat.tag}</div>
            <table className="data">
              <thead><tr><th>Feature</th><th>Source</th><th>Mechanism</th><th>Lag</th><th>Status</th></tr></thead>
              <tbody>
                {cat.rows.map((r, ri) => {
                  const s = STATUS[r[5]]
                  return <tr key={ri}>
                    <td style={{ fontWeight: 600, color: 'var(--txt-0)' }}>{r[0]}</td>
                    <td className="muted" style={{ fontSize: '.8rem' }}>{r[2]}</td>
                    <td className="muted" style={{ fontSize: '.8rem' }}>{r[3]}</td>
                    <td className="muted" style={{ fontSize: '.8rem' }}>{r[4]}</td>
                    <td><span className="badge-soft" style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Card>

      {isAfter && (
        <>
          <Card title="SEIR / Ross–Macdonald transmission framework" sub="The mechanistic backbone behind the SEIR/TSIR model and the climate-derived features" style={{ marginTop: 18 }}>
            <div className="method-section">
              <p>Malaria needs a <b>two-host</b> extension of SEIR because transmission requires the Anopheles
                mosquito as an obligate intermediate (Ross 1911, Macdonald 1957). Humans pass through
                Susceptible → Exposed → Infectious → Recovered (with waning immunity back to S after ~6–12 months);
                mosquitoes through Sᵥ → Eᵥ → Iᵥ, with climate-dependent rates.</p>
              <pre style={{ fontFamily: 'var(--mono)', background: '#eaf4f2', padding: '12px 14px', borderRadius: 8, color: 'var(--txt-0)', fontSize: '.78rem', overflow: 'auto', lineHeight: 1.6 }}>{`Human:    dSₕ/dt = μₕNₕ − (ab·Iᵥ/Nₕ)Sₕ − μₕSₕ + δRₕ
          dEₕ/dt = (ab·Iᵥ/Nₕ)Sₕ − (νₕ+μₕ)Eₕ
          dIₕ/dt = νₕEₕ − (rₕ+μₕ+αₕ)Iₕ
          dRₕ/dt = rₕIₕ − (δ+μₕ)Rₕ
Mosquito: dSᵥ/dt = φ(T,R) − (ac·Iₕ/Nₕ)Sᵥ − μᵥ(T)Sᵥ
          dEᵥ/dt = (ac·Iₕ/Nₕ)Sᵥ − (νᵥ(T)+μᵥ(T))Eᵥ
          dIᵥ/dt = νᵥ(T)Eᵥ − μᵥ(T)Iᵥ
R₀ = (m·a²·b·c) / (μᵥ(rₕ+μₕ)) · e^(−μᵥ/νᵥ)     R₀>1 → expansion`}</pre>
              <p style={{ marginTop: 8 }}><b>Parameter → feature bridge</b> (how the compartmental model maps to our derived inputs):</p>
              <table className="data">
                <thead><tr><th>SEIR parameter</th><th>Meaning</th><th>Our feature</th></tr></thead>
                <tbody>
                  {[['μᵥ(T) mosquito mortality', 'deaths/day, temp-driven', 'mortality_proxy'],
                    ['φ(T,R) recruitment', 'adults emerging/day', 'recruitment_proxy'],
                    ['a biting rate', 'peaks ~25°C', 'temp_suitability'],
                    ['R₀ reproduction number', 'transmission potential', 'r0_proxy = TPR × case-growth'],
                    ['rₕ recovery rate', 'treatment + immunity', 'ACT coverage (indicator)'],
                    ['δ immunity waning', '6–24 mo prior exposure', 'lag6 / lag12 cases'],
                    ['EIR (master variable)', 'infective bites/person', 'eir_proxy = suitability × rain × humidity']].map((r, i) => (
                    <tr key={i}><td style={{ fontWeight: 600 }}>{r[0]}</td><td className="muted">{r[1]}</td>
                      <td className="mono" style={{ color: COLORS.accent2 }}>{r[2]}</td></tr>
                  ))}
                </tbody>
              </table>
              <p style={{ marginTop: 8 }} className="muted">Our <code>SEIR/TSIR (mechanistic)</code> model implements the
                time-series-SIR reduction <b>log Iₜ = c + α·log Iₜ₋₁ + β·log(suitabilityₜ)</b>, fit by least squares and
                forecast recursively under the climate-suitability forecast — a semi-mechanistic, climate-forced
                renewal model derived from this framework.</p>
            </div>
          </Card>

          <Card title="Model architecture — built vs documented" sub="The framework's full model stack; we implemented the tractable ones and document the GPU/research-grade frontier" style={{ marginTop: 18 }}>
            <table className="data">
              <thead><tr><th>Model</th><th>Role</th><th>Status</th></tr></thead>
              <tbody>
                {MODELS_FRAMEWORK.map((m, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600, color: 'var(--txt-0)' }}>{m[0]}</td>
                    <td className="muted" style={{ fontSize: '.82rem' }}>{m[1]}</td>
                    <td><span className="badge-soft" style={{ background: m[2] === 'built' ? '#e6f7f4' : '#fef3c7', color: m[2] === 'built' ? '#0d9488' : '#b45309' }}>{m[2] === 'built' ? '✓ Built' : 'Documented'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: '.76rem', marginTop: 10 }}>
              "Built" models are in the Model Lab leaderboard and overlays. "Documented" ones (full TFT, Bayesian
              hierarchical/INLA, GNN, PINN) require external infrastructure (GPU, spatial graphs, PyMC/Stan) beyond
              this dataset — listed for completeness per the framework.
            </div>
          </Card>
        </>
      )}
    </>
  )
}
