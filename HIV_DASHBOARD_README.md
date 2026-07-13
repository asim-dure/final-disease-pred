# HIV Predictive Analytics Dashboard — How It Works

This document explains how the HIV dashboard (Command Overview, What-If
Simulation, Budget Planning, facility drill-down) works: which data it
uses, why each feature was included or left out, how the forecast and
burden score are calculated, where every external/survey number comes
from, and how the What-If Simulator connects to all of it. Every figure in
the dashboard traces back to a real warehouse query or a cited external
source. Where a simplification was necessary, it's stated plainly rather
than hidden.

Every chart on the dashboard states its source twice, in two different
places: the (i) icon next to each chart's title gives the full methodology
on hover, and a plain, always-visible "Source:" line sits directly under
the chart itself — so the exact indicator name backing a number is visible
without needing to hover over anything.

## 1. Data source: NDARS only

**Rule:** every HIV number in this dashboard comes from **NDARS
(`system_id = 7`) only**. Nigeria's warehouse holds HIV data from four
systems — NHMIS (1), ENNRIMS (2), NDR (3), and NDARS (7) — and the same
indicator name can exist in more than one of them with different values.
Mixing systems for the same metric risks silently combining inconsistent
data, so this dashboard draws from exactly one system throughout.

This mattered in practice: an earlier design pulled "PLHIV currently on
ART" from NHMIS, which has a genuine ~14-month data-quality problem in
that indicator (Jan 2024–Jan 2025, swinging between roughly 1 million and
near-zero from one month to the next). NDARS's own equivalent indicator
(`ART Monthly_3_Currently on ART`) is stable across the same period, so
the dashboard uses that instead.

**One naming note, not a rule exception:** Nigeria's HIV data system
records the MSM (men who have sex with men) population under the label
**"SDC"** (Sexual and Gender-Diverse Community) rather than "MSM" directly,
reflecting that this is a legally sensitive population category. NDARS's
`PREP.1 ... SDC, Total` indicator is the real, current, NDARS-native data
for this group, and it's labelled "MSM (SDC)" throughout the dashboard so
the connection is clear. A separate, more detailed MSM-specific indicator
set does exist in the warehouse, but it belongs to a different system
(ENNRIMS, `system_id = 2`) — consistent with the NDARS-only rule, it is
not used here.

## 2. Why these features, and not others

NDARS collects roughly 395 columns of HIV data, grouped into 12
categories: HTS (testing), PMTCT, TB/HIV co-infection, Key Population,
PrEP, ART, Viral Load, Viral Hepatitis, Cervical Cancer, DQA, and a summary
KPI. Not all of them are usable — a column that's missing for 90%+ of
facilities can't produce a trustworthy state or LGA average; averaging
mostly-empty data produces a number that looks precise but isn't real.

A completeness check across all 395 columns found:

| Category | Columns | Usable (reported for enough facilities to trust) |
|---|---|---|
| HTS (testing) | 160 | ~39 |
| ART | 70 | ~5 |
| PMTCT | 15 | ~3 |
| PrEP | 58 | Only when scoped to specific key-population groups |
| Key Population | 20 | Only when scoped to specific key-population groups |
| Viral Load | 5 | Usable (feeds VL-monitoring) |
| Viral Hepatitis | 7 | Not usable — over 90% missing |
| Cervical Cancer | 7 | Not usable — over 90% missing |
| TB/HIV co-infection | 38 | Not usable (most columns) — over 90% missing |
| DQA | 4 | Not usable — over 90% missing |

**The simple rule this dashboard follows: build a feature only where the
underlying data is real and complete enough to trust; otherwise, leave it
out and say so, rather than show a chart that looks informative but is
actually built on mostly-missing data.**

That's why the dashboard covers **Testing, ART treatment, Viral Load
monitoring, PMTCT, and Key Population PrEP uptake** — those are the
categories with enough real, current reporting to support a genuine
state/LGA/facility view. Viral Hepatitis, Cervical Cancer, most of TB/HIV
co-infection, and DQA are not included, and the dashboard says so directly
rather than showing an empty or misleading chart for them.

## 3. The core data panel — `export_burden_hiv.py`

Produces `ui/public/data/after/hiv/burden_rich.json`, the file both the
Command Overview dashboard and the What-If Simulator read.

### 3.1 Indicators (all `system_id = 7`)

| Field | NDARS indicator(s) summed | Role |
|---|---|---|
| `hts_tested` | `HTS Monthly_1n_HTS_TST Total, Male` + `Female` | Testing volume |
| `hts_neg` | `HTS Monthly_1n_HTS_TST_NEG Total, Male` + `Female` | Negative results |
| `hts_pos` | `HTS Monthly_1n_HTS_TST_POS Total, Male` + `Female` | **The forecast target** |
| `art_curr` | `ART Monthly_3_Currently on ART Female` + `Male` | Currently on ART |
| `art_vl_tested` | `ART Monthly_6a_Currently on ART with VL result Female` + `Male` | VL-monitoring |
| `pmtct_tested` | `PMTCT_HTS_Total...` | PMTCT testing |
| `hts_pos_<band>` / `hts_neg_<band>` | `HTS Monthly_1n_HTS_TST_POS/_NEG Total <age>, Male` + `Female`, summed per bucket | New diagnoses / negative results by age group |
| `hts_tested_<band>` | `hts_pos_<band> + hts_neg_<band>` (derived; no separate age-banded "Total" indicator exists) | Testing volume by age group |
| `art_vl_suppressed_pct` | `ART: Percentage Virally Suppressed` (facility-grain %; `dim_indicator_master` tags this indicator's own aggregation as **Average**, so it's averaged — never summed — when rolled up, unlike every other field in this table) | Viral load suppression rate |
| `cacx_neg` / `cacx_pos` / `cacx_suspected` / `cacx_referred` | `ART Monthly_23a-d_WLHIV on ART screened for cervical cancer (NEG/POS/Suspected Cancer/Referred)` | Cervical cancer screening cascade (women living with HIV, on ART) |
| `hepb_neg` / `hepb_pos` | `Number of KP tested negative/positive for Hepatitis B, Male` + `Female Total` | Key Population Hepatitis B testing |
| `hepc_neg` / `hepc_pos` | `Number of KP tested negative/positive for Hepatitis C, Male` + `Female Total` | Key Population Hepatitis C testing |

These four additions came from a later, targeted re-check of NDARS's
Viral Load, Cervical Cancer and Viral Hepatitis categories — the earlier
`>90% missing at facility grain` finding was true in aggregate but not
evenly true within each category, and re-querying at the indicator level
(rather than the category level) surfaced these as real and usable. The
viral-suppression field in particular fills what was previously disclosed
here as a genuine gap (§9) — it's included as its own chart, not folded
into the burden score, because it's a percentage with no paired raw count
to weight a multi-area rollup by (see §9 for the full explanation).

The age-band fields (`<band>` = `u15`, `15_24`, `25_49`, `50plus`) group
NDARS's 11 raw reported bands (`1-4`, `5-9`, `10-14`, `15-19`, `20-24`,
`25-29`, `30-34`, `35-39`, `40-44`, `45-49`, and a band literally named
`5O+` in the source data — a capital letter O, not "50+" — confirmed live,
not a data-entry typo this project introduced) into 4 standard
epidemiological buckets, each summed across both sexes. They're grouped
rather than shown as 22 separate lines because several of the raw bands,
especially at the youngest and oldest ages, report from a much smaller
number of states than the aggregate `hts_pos`/`hts_neg` totals — bucketing
keeps each line statistically meaningful instead of noisy. These fields are
excluded from the "last real month" cutoff calculation in §3.3 for the same
reason: a thin age-band slice reporting late in a given month shouldn't be
allowed to drag back the real/forecast boundary for the whole dashboard.

One indicator name carries a trailing non-breaking-space character in the
source data (`ART Monthly_3_Currently on ART Male\xa0`) — not a typo; the
Female variant doesn't have it, and the code accounts for it explicitly.

The fetch itself (`etl_warehouse_common.fetch_fact_series()`) joins the
fact table to the indicator and geography dimension tables, de-duplicates
on each row's `hashkey` (some indicators were loaded into the warehouse
multiple times under different internal IDs, which would otherwise inflate
totals by 16–66×), and rolls facility-level rows up to LGA and state.

### 3.2 The forecast target

The dashboard's forecast target — "new HIV-positive diagnoses" — is the
sum of exactly two real indicators: `HTS_TST_POS Total, Male` and
`HTS_TST_POS Total, Female`. NDARS also reports roughly 100 further
breakdowns of this same figure (by age band, by testing venue, by
sex-within-those-breakdowns); none of those are added into the *target
itself*, since doing so would double-count the same tests. This target is
what "New HIV-positive diagnoses" means everywhere in the dashboard, and
it's the number the What-If Simulator's levers move.

The age-band breakdown of this same figure (§3.1) IS shown separately, as
its own "New HIV Diagnoses by Age Group" chart on the Testing &
Case-Finding tab — it's a read-only breakdown of the same target, not a
second target, and its four lines always sum back to the same `hts_pos`
total shown elsewhere on that tab.

### 3.3 Deciding the last "real" (reported) month

Reporting to a national health data system doesn't complete all at once —
different indicators, and different facilities, finish reporting a given
month at different times. A simple "any nonzero value" check would treat a
half-reported month as fully real. Instead, for each of the six core
fields, the pipeline checks month by month whether that month's national
total is at least 40% of the trailing three-month median; the field's own
last complete month is the last one that passes. The dashboard's overall
"last real month" is the earliest (most conservative) of the six fields'
own cutoffs, so the actual/forecast boundary never overstates how current
the data is.

As of this write-up, that cutoff lands on January 2026: HIV testing
volume genuinely drops off sharply in the following month (from 37
reporting states to roughly a dozen), reflecting normal reporting lag; and
the ART-currently-on-treatment figures for the months after that are
identical across four consecutive months in every state, which reads as a
carried-forward snapshot rather than fresh monthly reporting. Both point
independently to the same cutoff. This check re-runs on every export, so
it will move forward automatically as more recent months finish reporting.

### 3.4 Forecast method: calendar-month climatology

Forecast months use the average of that same calendar month across all
real years (e.g., every real January averaged together), not a trained
statistical model. This is a deliberate choice: there isn't yet enough
clean historical HIV data to fit a reliable time-series model the way the
malaria forecast does, so the dashboard uses this simpler, transparent
method and states plainly that it is a seasonal average, not a fitted
forecast.

### 3.5 Population & density

Population and density figures come from `agg_lga_pop.parquet`, the same
population dataset the malaria dashboard uses, so the two dashboards stay
consistent with each other. Two corrections were necessary:

1. **State-level density is not a simple sum of its LGAs' densities** —
   doing so produces a meaningless number (an early version showed a
   state at "1.28 million people per km²"). The correct way is to work out
   each LGA's own land area from its population and density, add up the
   areas and populations separately across the state, and only then divide
   population by area.
2. **The raw population dataset undercounts Nigeria's real population**,
   and needs to be scaled up to match the official published estimate. The
   raw dataset's own national total for 2026 is about 234.1 million,
   against the official NBS/UN mid-2026 estimate of 242,431,832 — the
   dataset is scaled uniformly to match that real figure. This is the same
   correction and the same target figure the malaria dashboard already
   applies, so population and density for the same state and month now
   read identically on both dashboards.

Population is projected forward for future months at Nigeria's long-run
growth rate of roughly 2.5% per year, matching the malaria dashboard's own
assumption.

## 4. The burden score — `ui/src/hivBurdenScore.js`

The burden score uses the same weighted-factor design as the malaria
dashboard's burden score, so both are read the same way.

### 4.1 The 5 factors

| # | Factor | Weight | What it measures | Why it's included |
|---|---|---|---|---|
| 1 | Case burden (positivity) | 30 | This area's positive-test rate vs. the national average | The most direct signal of where the epidemic is currently concentrated |
| 2 | Testing gap | 20 | How far testing volume falls short of the national average | Under-testing is the next biggest driver of undetected transmission |
| 3 | ART coverage gap | 20 | How far ART coverage falls short of the national average | Treatment coverage is the strongest lever for reducing further transmission |
| 4 | VL-monitoring gap | 20 | Share of this area's own ART patients without a recent viral-load check | Routine monitoring catches treatment failure early, before it becomes a transmission risk again |
| 5 | Population density | 10 | This area's density relative to the national maximum | Used as a proxy for urban/social risk context (see 4.3) |

Each factor is scored 0–1 and multiplied by its weight; the five weighted
scores add up to a raw score out of 100.

### 4.2 From raw score to the displayed score and colour zone

The displayed 0–100 score blends two things: how this area ranks against
its peers (60% weight) and how its raw score compares to the national
spread (40% weight). Blending the two matters because rank alone can't
show *how much* worse an area is (the least-bad area in a bad year would
still look "fine"), and a raw score alone doesn't adjust for relative
severity across the country. The zone colour then follows fixed
thresholds: below 60 is "Not a Hotspot," 60–70 Green, 71–80 Yellow, 81–90
Amber, 91+ Red — the same banding the malaria dashboard uses, so most
areas read as "Not a Hotspot" rather than the whole map lighting up.

### 4.3 A disclosed limitation: no dedicated socio-economic indicator for HIV

NDARS does not include a usable socio-economic dataset (poverty,
education, urban context) of its own. Rather than invent one, population
density is used as a stand-in for that context in the burden score, and
this is stated directly in the score's own explanation rather than left
unexplained. Separately, the What-If Simulator does include real
poverty/literacy levers sourced from an external national survey (see
§6.4) — that's a distinct addition used only in the simulator, not part of
the core burden score above.

## 5. What-If Simulator

`ui/src/views/HivWhatIfBudget.jsx` is the dashboard's second tab ("What If
Simulation"), in the same position and using the same layout style as the
malaria dashboard's equivalent tab: one map, one trend chart, and one set
of levers, all driven by a single shared state so moving a lever updates
everything at once, with no separate "Run" step.

### 5.1 The time bar

A monthly slider spans the real reporting history plus a 12-month
forecast, with `‹`/`›` step controls and an Actual/Forecast label for
whichever month is selected. The map and burden score reflect that exact
month. **Levers are only active on forecast months** — adjusting a lever
against a month that has already been reported doesn't mean anything, so
on an actual month the lever panel explains this instead of showing
sliders.

### 5.2 The levers and their effect sizes

| Lever | Effect on cases | Direction | Basis |
|---|---|---|---|
| ART coverage | −0.30 | Reduces cases | WHO/UNAIDS "Treatment as Prevention" — the strongest lever |
| HIV testing (general) | −0.15 | Reduces cases | More testing finds cases earlier, reducing further spread |
| PMTCT testing | −0.15 | Reduces cases | Same logic as general testing, applied to a narrower group |
| VL-monitoring | −0.12 | Reduces cases | Catches treatment failure before it becomes a transmission risk |
| Poverty (MPI) | +0.10 | Increases cases | Higher poverty is associated with reduced healthcare access |
| Literacy/schooling | −0.10 | Reduces cases | Better education access supports awareness and healthcare-seeking |
| PrEP — MSM | −0.028 | Reduces cases | Scaled to this group's estimated share of the epidemic (§5.4) |
| PrEP — PWID | −0.009 | Reduces cases | Scaled to this group's estimated share of the epidemic |
| PrEP — Sex Workers | −0.021 | Reduces cases | Scaled to this group's estimated share of the epidemic |
| PrEP — Transgender | −0.005 | Reduces cases | Scaled to this group's estimated share of the epidemic |
| Population | ×1.0 (linear) | Increases cases as population grows | See §5.3 |
| Density | ×0.15 | Increases cases as density grows | See §5.3 |

These effect sizes are not fitted to a clinical trial — there is no
randomized study in this dataset to calculate them from directly. What is
real: which indicator each lever moves, and the direction and relative
size of its effect, grounded in the WHO/UNAIDS treatment literature and
the cited surveys in §6. This is stated directly rather than presented as
a precisely fitted number.

**One important design choice: the same lever set drives the map, the
trend chart, and the budget solver.** Moving a lever in the simulator uses
the identical effect size the server-side budget engine uses, so the
live preview on screen and a generated budget plan can never disagree with
each other.

### 5.3 Population and density needed their own effect sizes, not malaria's

The malaria dashboard's own population lever uses a sub-linear weight
(0.8), because malaria spreads through a shared, limited mosquito
population — more people dilutes transmission per person. HIV spreads
person-to-person with no equivalent limiting factor, so at a roughly
constant prevalence rate, case counts should scale close to linearly with
population — the dashboard uses a weight of 1.0 for HIV rather than
reusing malaria's discounted figure. Density has a smaller, separate
effect (weight 0.15): denser areas generally mean more social contact and
somewhat higher transmission, a gentler relationship than population size
itself.

### 5.4 Key Population levers: why they move the total by different amounts

Each Key Population lever (MSM, PWID, Sex Workers, Transgender) is scaled
to that group's own estimated share of Nigeria's total HIV-positive
population, calculated as:

```
estimated PLHIV in group = population size estimate × prevalence in that group
share of national epidemic = that figure ÷ Nigeria's total estimated PLHIV (1.9 million)
```

| Group | Population estimate | Prevalence | Estimated PLHIV | Share of national epidemic |
|---|---|---|---|---|
| MSM | 600,000 | 25.0% | 150,000 | 7.9% |
| Sex Workers | 740,000 | 15.5% | 114,700 | 6.0% |
| PWID | 441,500 | 10.9% | 48,124 | 2.5% |
| Transgender | 94,000 | 28.8% | 27,072 | 1.4% |

This is why, for example, moving the MSM lever from one end of its range
to the other changes the national case count by a smaller amount than
moving the ART lever the same distance: the MSM lever is deliberately
scoped to that group's real, cited share of the epidemic, not applied as
if it affected the entire population. Where these figures come from is in
§6.3.

## 6. External and survey data sources

Every figure below is a published, citable source, linked directly —
none are estimated without a reference.

### 6.1 Nigeria population (mid-2026 estimate)

**242,431,832** — UN DESA *World Population Prospects: 2024 Revision*
(medium-fertility variant) mid-2026 estimate for Nigeria, used to correct
the raw population dataset's undercount (§3.5). The same figure the
malaria dashboard already uses.

- [Nigeria Population 2026 — Worldometer (UN DESA data)](https://www.worldometers.info/world-population/nigeria-population/)
- [Nigeria National Population Estimates — National Bureau of Statistics](https://nigerianstat.gov.ng/download/474)

### 6.2 National adult HIV prevalence

**~1.3%** — Nigeria HIV/AIDS Indicator and Impact Survey (NAIIS), 2018.
Used as the general-population baseline that Key Population prevalence is
compared against.

- [NAIIS 2018 official data portal — NASCP](https://nadanaiis.nascp.gov.ng/catalog/3)
- [NAIIS in the Nigeria Bureau of Statistics microdata catalogue](https://microdata.nigerianstat.gov.ng/index.php/catalog/65)

### 6.3 Key Population prevalence and population size estimates

- **Prevalence** (MSM 25.0%, Sex Workers 15.5%, PWID 10.9%, Transgender
  28.8%): Nigeria's 2020–2021 Integrated Biological & Behavioural
  Surveillance Survey (IBBSS), a national government-conducted survey.
  [Full study — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11877050/)
- **Population size estimates** (MSM ~600,000, Sex Workers ~740,000, PWID
  ~441,500, Transgender ~94,000): NACA (National Agency for the Control of
  AIDS) Key Population Size Estimation, 2023.
  [Full report — naca.gov.ng](https://naca.gov.ng/wp-content/uploads/2024/03/Final-KPSE-20-States-Report_-DEC-2023-2.pdf)
- **Nigeria's total PLHIV estimate** (1.9 million, all ages): a
  commonly-cited UNAIDS/NASCP figure, used as the denominator for the
  Key Population share calculation in §5.4.
- People who inject drugs are estimated globally at roughly **14 times**
  higher risk of acquiring HIV than the general adult population (an
  older, widely-cited UNAIDS figure put this at 22 times; UNAIDS revised
  it down in its 2024 update). Both are consistent in direction with
  Nigeria's own IBBSS-measured PWID prevalence of 10.9% (roughly 8× the
  1.3% national baseline).
  [UNAIDS key populations](https://www.unaids.org/en/topic/key-populations) ·
  [UNAIDS 2024 update — people who inject drugs](https://www.unaids.org/sites/default/files/media_asset/2024-unaids-global-aids-update-people-who-inject-drugs_en.pdf)

### 6.4 Socio-economic data (Poverty / Literacy levers)

**OPHI (Oxford Poverty & Human Development Initiative) / National Bureau
of Statistics Multidimensional Poverty Index** — a state-level national
survey, reused from the same population dataset's poverty-headcount and
schooling-deprivation columns. This is the same survey the malaria
dashboard already uses for its own model, applied here to HIV as well. The
schooling-deprivation figure is inverted into a "literacy/schooling
access" reading, so that raising the lever represents more access, kept
consistent with how every other lever in the simulator is set up (higher
= better, unless marked as a risk factor).

- [OPHI Nigeria MPI directory](https://ophi.org.uk/national-mpi-directory/nigeria-mpi)
- [Nigeria National Bureau of Statistics — Multidimensional Poverty Index](https://nigerianstat.gov.ng/news/78)

### 6.5 HIV programme unit costs (Budget Planning)

These are literature-based planning estimates, clearly labelled as
indicative rather than figures pulled from the warehouse. Costing studies
report a range depending on country, year and service-delivery model —
the figures below are a reasonable point within each study's own range,
not an average across all of them:

| Item | Cost used | Source |
|---|---|---|
| ART, per patient-year | ~$130 | [The Cost of Providing Comprehensive HIV Treatment in PEPFAR-Supported Programs — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3225224/) |
| HIV test (general population) | ~$20 | [Costs of HIV prevention services provided by community-based organizations to female sex workers in Nigeria — PLOS One](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0282826) |
| PMTCT test | ~$18 | Same source as above (same family of Nigeria HIV-testing cost data) |
| Viral load test | ~$20 | Typical sub-Saharan Africa viral-load assay cost, consistent with the general HIV-testing cost literature above — no single Nigeria-specific VL-test costing study was found, disclosed as the weakest-sourced figure of the five along with PrEP below |
| PrEP, per person-year | ~$70 | [Low costs and opportunities for efficiency: a cost analysis of the first year of programmatic PrEP delivery in Kenya's public sector — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8365926/) — this is toward the low end of the published range; a more recent 2024 Kenya study found costs from $217–283/person-year ([Frontiers](https://www.frontiersin.org/journals/reproductive-health/articles/10.3389/frph.2024.1278764/full)), and no Nigeria-specific figure was found. Labelled as the least certain of the five in the Budget Planning UI. |

## 7. Budget Planning

The budget solver uses the same optimisation method as the malaria
dashboard: given a total budget, it works out the spending mix across all
available interventions that averts the most cases, using a standard
diminishing-returns allocation approach (each intervention gives less
additional benefit per naira as more is spent on it, so the optimal
approach spreads the budget rather than spending it all on one lever). The
underlying math is identical to malaria's already-validated solver; only
the HIV-specific intervention list and unit costs are new.

One design point worth explaining: pricing each intervention as "the cost
to fund Nigeria's entire ART or testing programme from scratch" makes any
realistic planning budget look like it barely moves the needle, since a
full national programme costs hundreds of billions of naira a year. The
solver instead prices population-wide interventions as an incremental
scale-up on top of the programme that's already running — which is the
more realistic use case for a budget-planning tool.

**Forward mode ("Levers → Budget"):** prices out the exact scenario
already set up with the levers, using the real unit costs above, and
generates a month-by-month deployment plan.

**Reverse mode ("Budget → Levers"):** you provide a total budget, and the
solver — not an AI — decides the most cost-effective spending mix across
all costed levers to maximise cases averted; an AI model is only used
afterward to write up the plan the solver has already decided.

## 8. Facility-level drill-down

Switching the map to LGA view and selecting an LGA opens a facility list
and detail panel (the same component the malaria dashboard uses, extended
here with a real HIV data source).

This runs as a live query against the warehouse rather than a pre-built
snapshot (which the malaria dashboard uses, because a live query there is
too slow at that scale). For HIV, a live query for one LGA typically
returns in a few seconds, and is cached afterward so repeat views of the
same LGA are instant.

**Facilities are only shown if they have real reported data recent enough
to support a forecast** — a facility needs at least 6 real, non-zero
testing months in the recent reporting window to appear at all, and its
LGA needs to have a valid forecast for that facility to be shown with one.
A facility that reported once in passing, or one whose LGA-level forecast
isn't available, is left out rather than shown with a misleadingly thin
or missing trend.

**Facility-level scoring** uses the same weighted-factor formula as the
main burden score, minus the density factor (which isn't meaningful at
facility scale), and compares each facility only to other facilities in
its own LGA — not to every facility nationally, since there isn't yet a
large enough sample of HIV facility-level data to calibrate a fair
national scale the way the malaria dashboard's facility score has been.

## 9. What's deliberately not shown, and why

- **Most of TB/HIV co-infection, DQA, and most of the broader Viral
  Hepatitis category (treatment-uptake indicators):** over 90% missing at
  the facility level (§2). Building charts on this data would present a
  precise-looking number built on mostly-absent reporting. Two categories
  that were originally assumed to fall in this same bucket turned out, on
  a later re-check prompted by a direct question about them, to have
  genuinely usable coverage and are now shown instead of excluded:
  **Cervical Cancer screening** (§3.1 — 37-of-37-state coverage, WLHIV on
  ART) and **Key Population Hepatitis B/C testing** (§3.1 — 30-32 of 37
  states, thinner than the core fields but real). This is a live,
  periodically re-verified judgment call, not a one-time decision — it
  changes as new categories are checked, not just when NDARS's own data
  improves.
- **A separate, more detailed age-banded MSM indicator set:** real data
  exists, but it belongs to a different reporting system (ENNRIMS) than the
  one this dashboard is scoped to (NDARS) — left out to keep every number
  in this dashboard traceable to one consistent source. This is a distinct
  dataset from the NDARS HTS age-band breakdown described in §3.1, which
  IS shown (grouped by all key populations together, not MSM-specific).
- **The 7 individual raw age bands within each of the 4 grouped buckets in
  §3.1:** shown grouped, not as 11 separate lines, because several raw
  bands report from too few states on their own to plot honestly month to
  month (§3.1 explains the exact grouping and why).
- **The burden score's VL-monitoring factor is NOT the viral-suppression
  rate.** A real NDARS "ART: Percentage Virally Suppressed" indicator does
  exist (found on the same re-check that surfaced Cervical Cancer and
  Hepatitis testing above) and is shown as its own chart on the Treatment
  & Care tab — but it's reported as a facility-grain PERCENTAGE with no
  paired raw suppressed/tested COUNT to weight a multi-facility rollup by
  facility size, so it's kept out of the count-based burden score formula
  and shown separately instead of being silently blended in. The score's
  own VL-monitoring factor stays what it always was: the share of ART
  patients who got a viral-load check at all (monitoring intensity), a
  genuinely different question from "of those checked, how many were
  suppressed."
- **State/LGA-level trend data for the Key Population PrEP/testing-
  positivity cards and socio-economic levers:** these specific cards are
  disclosed as national-level only — that PrEP/testing data is too sparse
  per state to support a reliable local figure, and the socio-economic
  data is a single 2019 survey snapshot, not something that changes month
  to month. Key Population Hepatitis B/C testing (§3.1) is a separate,
  better-covered dataset and IS shown at state/LGA grain, responding to
  the location filter like any other chart.

## 10. File map

| File | Produces | Notes |
|---|---|---|
| `export_burden_hiv.py` | `ui/public/data/after/hiv/burden_rich.json` | Core monthly panel (testing, ART, VL, PMTCT, population, density), per state and LGA |
| `export_hiv_kp_socio.py` | `ui/public/data/after/hiv/kp_socio.json` | Key Population PrEP levers + socio-economic snapshot |
| `drivers_hiv.py` | `ui/public/data/after/hiv/drivers.json` | Driver baselines (supporting file; the What-If Simulator reads `burden_rich.json` directly) |
| `disease_config.py` | — | HIV configuration: forecast target, lever effect sizes, dashboard capabilities |
| `api.py` | — | Forecast, budget, and benchmarking endpoints, including the HIV budget solver |
| `facility_api.py` | — | Facility-level endpoints, HIV section |
| `ui/src/hivBurdenScore.js` | — | The burden score formula, shared across the dashboard and the simulator |
| `ui/src/views/HivManagerDashboard.jsx` | — | Command Overview / Testing & Case-Finding / Treatment & Care tabs |
| `ui/src/views/HivWhatIfBudget.jsx` | — | What If Simulation tab (levers, map, chart, budget) |
| `ui/src/views/FacilityPanel.jsx` | — | Facility-level detail panel (shared with the malaria dashboard) |

To refresh the dashboard after a warehouse update: run
`export_burden_hiv.py`, then `export_hiv_kp_socio.py` (it reads the first
script's output to line up its own month range), then restart the
frontend.
