# NCD/NTD What-If Simulator Levers — Research Reference

This document is a research reference, not a build plan. It answers one question: for the 12 NCD (Non-Communicable Disease) and NTD (Neglected Tropical Disease) conditions this project tracks, what real, citable, survey-backed indicators could serve as What-If Simulator levers — given that, unlike malaria and HIV, these diseases currently have **only a single target-variable indicator each** (a case-count forecast target) and nothing else. No code has been changed to act on this research yet; it is the input to a future, separate implementation plan.

## Why this exists

Malaria's and HIV's What-If Simulators work because their warehouse data includes real intervention/coverage indicators (ITN distribution, IPTp doses, HTS testing volume, ART coverage, PrEP uptake) that move a lever and visibly change a forecast. The 12 NCD/NTD diseases below have none of that — every one of them is `interventions: []`, `elasticity: {}` in `disease_config.py`, with an explicit code comment that no per-LGA driver/intervention dataset exists. This document surveys what real external data *could* fill that gap, disease by disease, so a human can decide which levers are worth building before any engineering starts.

## The 12 diseases

**7 already wired** in `disease_config.py` (hotspot map + forecast only, no levers): Hypertension, Diabetes, Cervical Cancer, Asthma (group `ncd`); Sickle Cell, Yaws, Elephantiasis (group `ntd` — Sickle Cell's fact data actually lives in the `ncd` schema despite its UI tag, confirmed live).

**5 more referenced only in a separate, older app** (`odc_new_ui/fmoh_dashboard`), not yet in `disease_config.py` at all: Arthritis, Depression, Breast Cancer, Coronary Heart Disease (NCD); Snake bites (NTD).

`hypertension`/`diabetes` do carry one extra indicator (`txcov`, treatment coverage), but it's national-only — 4 rows in the entire `ncd` fact table — and unwired anywhere in the code.

## The real constraint: geographic resolution, not existence of data

Real survey data on NCD/NTD risk factors and interventions in Nigeria does exist. The hard part is that almost none of it is naturally resolvable to LGA grain, this dashboard's native geography — the same situation HIV's Key Population data was in, disclosed as national-only rather than fabricated to a finer grain. Every source below is tagged with a resolution tier:

| Tier | Meaning |
|---|---|
| **A** | Real data, LGA grain, **already sitting in this repo** — zero new integration cost |
| **A′** | Real data, LGA/district grain, external source, needs new integration |
| **B** | Real data, state or geopolitical-zone grain — the same resolution malaria/HIV's own population and MPI data already use |
| **C** | Real data, but national or single-study only — usable as a disclosed constant or elasticity-calibration reference, not a live per-area lever |

## A major finding: real LGA-grain socio-economic data is already in this repo, unused for NCD/NTD

`agg_lga_pop.parquet` — the same population file malaria's `export_burden.py` (and by extension HIV's rescale logic) already depends on — contains far more than population. Confirmed real columns, already at LGA grain, already loaded and geo-joined in this project:

- `population`, `pop_density` (already used everywhere)
- `poverty_mpi_h` — MPI poverty headcount (HIV's `export_hiv_kp_socio.py` already reuses this same MPI figure at state level; here it's available at LGA grain)
- `dep_schooling`, `dep_electricity`, `dep_water`, `dep_housing` — the 4 real MPI deprivation sub-indices, LGA grain
- `"Use of clean fuels and technologies for cooking"` — directly answers Asthma's cooking-fuel risk lever, LGA grain, no new survey extraction needed
- `"Literacy among women"`, `"Households using an improved sanitation facility"`, `"Households using Improved Water as Source of drinking water"` — real WASH/socio-economic covariates, LGA grain

This means cooking fuel, sanitation, water access, literacy, and poverty/deprivation are **Tier A for every disease below where they're a relevant risk proxy** — most of the 12 — with no external survey work required, only a join this project already knows how to do.

Separately confirmed: this project's own population pipeline (`population_data.py`) is **total-population only** — NPC 2006-census-based state totals, projected forward at 2.5%/yr, distributed to LGA by facility share. No age- or sex-disaggregated population source exists anywhere in this repo today.

## Demographic/structural levers: scoping "Population" correctly per disease

A "Population" lever only makes sense scaled to the disease's real at-risk sub-population — a Breast Cancer population lever must scale women's population specifically, the same way a malaria population lever wouldn't make sense scaled to only men. Since no LGA-level (or even state-level) age/sex breakdown of Nigeria's population was found in this pass — only a national sex ratio (49.38% female / 50.62% male) and age structure (42.54% aged 0–14, median age 18.3, 2026 UN-modelled projection) — the most defensible currently-available method is: **real per-LGA total population (already in this repo) × a real, cited national sex/age ratio**, the same "national constant applied to real per-LGA data" pattern already used for HIV's population growth-rate assumption.

| Disease | At-risk sub-population |
|---|---|
| Hypertension | Adults (18+) |
| Diabetes | Adults (18+) |
| Cervical Cancer | Adult women, screening-age emphasis (WHO 90-70-90 targets: screened at 35 and 45) |
| Asthma | All ages, pediatric-weighted (childhood biomass-smoke exposure is the dominant cited risk pathway) |
| Arthritis | Older adults (45+/60+) |
| Depression | Working-age adults (18–65) |
| Breast Cancer | Adult women, 40+ screening-eligible emphasis |
| Coronary Heart Disease | Adults (18+); literature notes a male skew in confirmed cases |
| Sickle Cell | Births / under-5 population — genetic, expressed at birth, autosomal (no sex-scoping needed) |
| Yaws | Children, peak ages 6–10, under-15 overall (WHO: 75–80% of all cases are under 15) |
| Elephantiasis (LF) | General population in endemic LGAs; adult-weighting optional (clinical disease is adult-visible, infection occurs at any age) |
| Snake bites | Working-age rural/agricultural population |

**Disclosed limitation:** these ratios are national constants, not state/LGA-resolved. A true state-by-state demographic breakdown would need NPC's own census/projection publications sourced directly — flagged as unresolved, not fabricated.

## Cross-cutting sources

- **`agg_lga_pop.parquet`** — see above. Tier A, already in repo.
- **NDHS 2023-24** (National Population Commission + DHS Program, launched Oct 2025 — [full report](https://dhsprogram.com/pubs/pdf/FR395/FR395.pdf)) — 39,050 women + 12,204 men, state-representative. Captures cooking fuel (redundant with the Tier A source above, useful as a cross-check), tobacco use, alcohol use, wealth index/quintile, urban/rural residence, women's BMI. Tier B.
- **NNHS 2018** (NBS + UNICEF, all 37 domains = 36 states + FCT — [full report](https://www.nigerianstat.gov.ng/pdfuploads/NNHS_2018_Final%20Report.pdf)) — anthropometric/nutrition, state-level. Tier B.
- **GBD Nigeria / IHME modelling** — real published zone-level population-attributable-fraction (PAF) estimates for hypertension/CVD risk factors, e.g. stroke PAF: North West 33.4%, North East 33.5% ([study](https://pmc.ncbi.nlm.nih.gov/articles/PMC11166022/)). Tier B.
- **ESPEN data portal** (WHO AFRO — [espen.afro.who.int](http://espen.afro.who.int/)) — the only external source offering genuine LGA/district-level data, specifically NTD MDA coverage and prevalence mapping. Tier A′, highest priority for the NTD diseases.
- **National sex ratio / age structure** (2026 UN-modelled projection) — 49.38% female / 50.62% male; 42.54% aged 0–14; median age 18.3. Tier B, national constant only.

## Per-disease candidate levers

### NCD group

**Hypertension** *(wired; `txcov` unused, national-only 2nd indicator)*
- Salt/sodium intake, BMI/obesity, physical inactivity, alcohol, tobacco — NDHS/NNHS (Tier B).
- Cooking fuel, literacy, water/sanitation, MPI — `agg_lga_pop.parquet` (Tier A).
- Zone-level PAF from the GBD study above (Tier B) — a real North/South split is already quantified.
- `txcov` — Tier C only, 4 national rows, cannot be revived per-LGA.

**Diabetes** *(wired; same `txcov` situation)*
- Obesity/BMI, unhealthy diet, physical inactivity — NDHS/NNHS (Tier B); same Tier A cooking-fuel/MPI/literacy columns apply.
- African GBD 2021 diabetes risk-factor study exists ([link](https://pmc.ncbi.nlm.nih.gov/articles/PMC12422890/)) — Tier B/C, needs a Nigeria-specific extraction pass.

**Cervical Cancer** *(wired; forecast target only)*
- HPV vaccination coverage — real but very low and mostly study-level (~35% awareness, <10% actual vaccination in cited studies) — Tier C.
- Cervical screening coverage — ~8.7% opportunistic-screening national estimate — Tier C, not geo-resolved.
- **Best real lever: HIV co-infection prevalence.** This repo already has real, live, LGA-grain HIV burden data (`burden_rich.json`); HIV-positive women have sharply elevated cervical cancer risk. Tier A — nothing external needed, just a join to data already in this repo.
- MPI/poverty — Tier A via `agg_lga_pop.parquet`.

**Asthma** *(wired; forecast target only)*
- Household solid/biomass cooking-fuel share — **Tier A, already in `agg_lga_pop.parquet`.**
- Indoor PM2.5 — only single rural-community readings found (median 1,575 µg/m³ vs. the WHO guideline of 25 µg/m³) — Tier C, not geo-resolvable as-is; satellite PM2.5 (NASA/WHO ambient air-quality data) is a plausible Tier B alternative, not yet verified.
- Tobacco/secondhand smoke exposure — NDHS (Tier B).

**Arthritis** *(not yet in `disease_config.py`)*
- Weakest evidence base of the 12 — no national survey found, only scattered single-hospital prevalence studies (Tier C only). Obesity/BMI and age-structure (NNHS/NDHS, Tier B) are the only real geo-resolvable proxies. May not be worth building unless specifically wanted.

**Depression / Mental Health** *(not yet in `disease_config.py`)*
- Only national-ish source found: the Nigerian Survey of Mental Health and Well-being (World Mental Health Survey initiative, 21 of 36 states, 6,752 adults) — but its own data quality is disputed in the literature (3.1% lifetime prevalence reported vs. 14.6% in comparable cross-national surveys). Tier C, low reliability even at that.
- MPI/poverty (Tier A) is a more defensible real proxy than the disputed prevalence survey itself.

**Breast Cancer** *(not yet in `disease_config.py`)*
- Mammography screening uptake ~9–15% in cited studies — Tier C, single-study, not geo-resolved.
- The HIV-covariate idea used for cervical cancer does not apply here — MPI/poverty (Tier A) and NDHS women's-health-service-access indicators (Tier B) are the realistic fallback.

**Coronary Heart Disease** *(not yet in `disease_config.py`)*
- The richest single-study risk-factor breakdown found in this whole pass: hypertension 30.6%, obesity 25.5%, diabetes 3.6%, physical inactivity 62.2%, tobacco 5.6% (male), unhealthy diet 74.8% — one national ACE-study country analysis, Tier C (not geo-resolved). Every one of these factors is independently available via NDHS/NNHS/`agg_lga_pop.parquet` at Tier A/B, so CHD can lever off the exact same stack already assembled for hypertension/diabetes.

### NTD group

**Sickle Cell** *(wired; data lives in the `ncd` schema despite the `ntd` UI tag)*
- Genetically driven, not month-to-month intervention-responsive the way the others are. Real Nigeria constants: ~23.7% trait prevalence, ~20 per 1,000 births affected (~150,000 births/year nationally) — Tier C, single-study national constants, not geo-resolved.
- Newborn screening coverage/uptake is a real, actively-studied intervention (multiple pilot studies, e.g. Lagos) but no nationally aggregated per-state coverage figure was found — would need a dedicated follow-up search of NBS/FMOH newborn-screening-programme reporting.
- Malaria co-endemicity is a real, scientifically documented interaction (sickle cell trait is *protective* against malaria) — this repo has live malaria burden data, so a methodological link is possible, but the protective direction makes it a poor drop-in "risk" lever without careful framing.

**Yaws** *(wired; smallest dataset of all 12 — 558 rows / 403 locations)*
- **ESPEN portal MDA/prevalence data — Tier A′**, the strongest single candidate of the whole list; yaws is exactly what ESPEN tracks at district level.
- WHO's Morges Strategy (single-dose azithromycin mass drug administration) has a documented Nigeria pilot success in Nsukka.
- Sharpest population-scoping finding of this research: **75–80% of all yaws cases are children under 15, peak incidence ages 6–10** (WHO fact sheet), sexes equally affected.

**Elephantiasis / Lymphatic Filariasis** *(wired; year-only hotspot table)*
- **ESPEN portal MDA/prevalence data — Tier A′**, same strength as yaws.
- Real, well-documented Nigeria MDA history with quantified coverage (≥85% reported per round, 72.2% actual via an independent 2003 population-based survey) and **state-level elimination status already exists in the literature** — Plateau and Nasarawa states officially stopped MDA after hitting elimination thresholds. This is about as close to a ready-made state-level lever as anything in this research.
- Shares the same mosquito-vector transmission mechanism malaria's own IRS/ITN levers already model — worth checking whether malaria's existing vector-control data could double as a covariate (not yet verified).

**Snake bites** *(not yet in `disease_config.py`)*
- Real, quantified regional hotspot data exists (Benue valley: 497 per 100,000/year, ~10x the regional average) — Tier B/C boundary; needs a dedicated pass to check resolvability beyond the single cited hotspot region.
- Antivenom access / hub-and-spoke distribution is the literature's own recommended intervention lever — Tier C (facility-access proxy, not yet geo-resolved). Rural/agricultural-occupation share (NDHS urban/rural split, Tier B) is a defensible stand-in exposure proxy.

## Open questions this research does not resolve

1. Whether NDHS/NNHS/GBD data is downloadable at true state grain (37 domains) or only 6-zone grain, for every specific indicator named above — needs a per-indicator follow-up pass before any number ships, the same rigor already applied to every HIV dashboard figure.
2. Whether the ESPEN portal's Nigeria data is bulk-downloadable/scriptable (API or CSV export) or only interactive-map-browsable — determines whether the yaws/elephantiasis levers can be a real automated pipeline or only a manual one-time pull.
3. Whether to add the 5 not-yet-wired diseases (Arthritis, Depression, Breast Cancer, Coronary Heart Disease, Snake bites) to `disease_config.py` at all — Arthritis and Depression have the weakest real evidence base of the 12.
4. State/LGA-level sex and age-structure breakdowns — only national constants were found in this pass; would need NPC's actual census/projection publications for anything finer than "one national ratio applied everywhere."
5. No cost-per-unit data (the equivalent of HIV's unit-cost literature for the budget solver) was researched for any of these 12 diseases — relevant only once/if Comparative Benchmarking + budget planning is scoped for them.

## Next steps

This document is an input to a future planning session, not a build plan. Once reviewed and pruned, an implementation plan would still need to cover: the final disease list, whether state-level-disclosed levers are acceptable (the HIV precedent) or only LGA-resolvable levers (ESPEN-backed NTD, `agg_lga_pop.parquet`-backed NCD) should ship, `disease_config.py` schema additions for elasticity/intervention/population-scope fields, and the export-pipeline/API/UI work to actually wire a What-If Simulator tab per disease.
