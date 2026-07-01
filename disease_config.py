"""
Single source of truth for every disease's warehouse schema mapping and
frontend capability flags. Every ETL script and api.py imports from here.

Column names below were re-confirmed live against the FMOH UAT warehouse
(information_schema.columns) during implementation, not copied blind from
ODC 3.0's source. Notable corrections vs. ODC 3.0's hotspot.py CONFIG:
  - hiv_hotspot_predictions DOES have a real monthly "date" column (83
    distinct months observed) -- it is NOT snapshot-only as ODC's CONFIG
    implies. time_grain_hotspot is therefore "month", derived from date.
"""

# malaria stays on the existing file-based pipeline; this entry exists only
# so /api/diseases can return one consistent list including malaria.
MALARIA = {
    "label": "Malaria", "group": "malaria", "source": "file",
    "forecastable": True, "tb_style_excluded": False,
    "time_grain_hotspot": "month", "time_grain_fact": "month",
    "has_score": True, "has_zone": False, "has_intervention_drivers": True,
    "burden_tier": "full",
    "dataset_info": {
        "source": "Facility-level DHIS2 extract (agg_lga_pop.parquet), aggregated to LGA-month",
        "coverage": "2023-2026 (monthly)",
        "granularity": "773 LGAs x month",
        "notes": "Enriched with population, incidence/1,000, and 10+ climate/geo/socioeconomic covariates. The only disease here with real per-LGA intervention/driver data (ACT, LLIN, RDT, IPTp), so it's the only one with a live lever-adjustable burden score and a grounded unit-cost budget table.",
    },
    "capabilities": {
        "overview": True, "hotspot_map": True, "forecast": True,
        "simulator": True, "whatiflab": True, "data_explorer": True,
        "methodology": True, "model_lab": True,
    },
}

DISEASES = {
    "malaria": MALARIA,

    "hiv": {
        "label": "HIV", "group": "hiv", "source": "warehouse",
        "hotspot_table": "hiv_hotspot_predictions",
        "hotspot_cols": {
            "state": "state", "lga": "actual_lga", "date": "date",
            "score": "prev", "zone": None,
            "value": "Individuals tested HIV positive",
        },
        "fact_schema": "hiv",
        # Forecast target switched to an NDARS-sourced (system_id=7) derived
        # series per explicit user spec: sum of exactly the two Total-by-sex
        # HTS_TST_POS columns below. Verified live against the warehouse:
        # both indicator_name rows have system_id=7 in dim_indicator_master
        # AND f.system_id=7 on every fact row (double-confirmed at both the
        # dim and fact level); 69,881 rows, 4,343 distinct geo locations,
        # 2014-2026. The ~100 disaggregated variants (by age band, by
        # venue/site, by sex-within-those-breakdowns) are NEVER summed in --
        # see forecast_target_components + forecast_target_system_id below,
        # consumed by etl_warehouse_common.fetch_fact_series()'s multi-name
        # sum + system_id guard (same double-count-guard pattern as TB's
        # TB_CASE_PARTITION, generalized to "sum exactly these N Total-level
        # columns, never any disaggregated breakdown").
        "forecast_target": "HIV positive tests (HTS_TST_POS, NDARS Total Male+Female)",
        "forecast_target_components": [
            "HTS Monthly_1n_HTS_TST_POS Total, Male",
            "HTS Monthly_1n_HTS_TST_POS Total, Female",
        ],
        "forecast_target_system_id": 7,  # NDARS
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": True, "has_zone": False, "has_intervention_drivers": True,
        # Real, verified-live warehouse indicators (see drivers_hiv.py) --
        # NOT fabricated. ART coverage, linkage-to-care, and PMTCT testing
        # volume are actually reported per LGA/month; elasticity direction
        # and magnitude are literature-cited (WHO/UNAIDS Treatment-as-
        # Prevention), exactly the same honesty bar as malaria's own
        # NMEP/WHO-cited driver elasticities in drivers.py. Two of these
        # three indicators had warehouse rows duplicated under an identical
        # hashkey (~16x-66x inflation) -- fixed generically in
        # etl_warehouse_common.fetch_fact_series() via a hashkey dedup, not
        # patched around here.
        "interventions": ["PLHIV currently on ART", "Newly enrolled in HIV care", "PMTCT testing volume"],
        "elasticity": {"art": -0.30, "linkage": -0.20, "pmtct_testing": -0.15},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "hiv.fact_indicator_data (warehouse, NDARS system_id=7) + hiv_hotspot_predictions",
            "coverage": "2014-2026 (forecast series); hotspot table has 83 distinct reported months",
            "granularity": "69,881 fact rows across 4,343 distinct geo locations",
            "notes": "Forecast target is the sum of the two Total-by-sex HTS_TST_POS columns only -- the ~100 disaggregated age/venue/sex-breakdown variants are deliberately never summed in, to avoid double-counting.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": True, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "tb": {
        "label": "Tuberculosis", "group": "tb", "source": "warehouse",
        "hotspot_table": "tb_hotspot_predictions",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": None, "zone": "Predicted_Hotspot_Zone",
            "value": "Notified_TB_Cases",
        },
        "fact_schema": "tb",
        "forecastable": False, "tb_style_excluded": True,
        "time_grain_hotspot": "month", "time_grain_fact": "annual_only",
        "has_score": False, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "case_partition": "sex",  # sum Male+Female only -- see TB_CASE_PARTITION below
        "dataset_info": {
            "source": "tb_hotspot_predictions (warehouse) + tb.fact_indicator_data",
            "coverage": "Only 2 real annual data points nationally",
            "granularity": "LGA-level hotspot snapshot, annual case counts",
            "notes": "Insufficient history for any statistical forecast (SARIMAX needs a meaningful run of consistent monthly data) -- Forecast, What-If and Simulator tabs are intentionally absent for TB, not broken.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": False,
            "simulator": False, "whatiflab": False, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
        "forecast_unavailable_reason": "Only 2 real annual data points exist for TB nationally -- insufficient for any statistical forecast.",
    },

    "hypertension": {
        "label": "Hypertension", "group": "ncd", "source": "warehouse",
        "hotspot_table": "hypertension_hotspot_predictions",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": "hypertension_risk_score", "zone": "prevalence_category",
            "value": "hypertension_total_estimated_cases",
        },
        "fact_schema": "ncd",
        # Verified live: 829,379 rows, 32,086 distinct geo locations, 2016-2026.
        "forecast_target": "Hypertension New Cases (suspected)",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": True, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        # Decision #4: treatment_gap tier demoted to volume_trend -- txcov is
        # national-only (4 rows in ncd.fact_indicator_data), cannot be joined
        # per-LGA without fabricating a broadcast value.
        "burden_tier": "volume_trend",
        "national_only_indicators": ["txcov"],
        "dataset_info": {
            "source": "hypertension_hotspot_predictions + ncd.fact_indicator_data (warehouse)",
            "coverage": "2016-2026 (monthly)",
            "granularity": "829,379 fact rows across 32,086 distinct geo locations",
            "notes": "Treatment-coverage ('txcov') is reported NATIONALLY ONLY (4 rows total) -- it is shown as a national KPI only, never broadcast down to LGA rows as a fabricated per-LGA figure. No per-LGA driver/intervention dataset exists, so the burden score uses volume+trend only, not the full driver-weighted tier.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            # whatiflab=True: Plug & Play SARIMAX forecasting works generically
            # for any forecastable disease (get_df_for/agg_level/run_sarimax
            # need only the single forecast_target series, already fetched).
            # The Intervention/Budget sub-sections honestly degrade to "no
            # interventions configured" / "budget needs unit costs, not yet
            # configured" (see api.py get_meta()/budget routes) rather than
            # fabricating driver data that doesn't exist for this disease.
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "diabetes": {
        "label": "Diabetes", "group": "ncd", "source": "warehouse",
        "hotspot_table": "diabetes_hotspot_predictions",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": "Risk_Score", "zone": "predicted_zone",
            "value": "Total_Diabetes_Cases",
        },
        "fact_schema": "ncd",
        # Verified live: 279,393 rows, 21,127 distinct geo locations, 2016-2026.
        "forecast_target": "Diabetes Mellitus new cases (suspected)",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": True, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "national_only_indicators": ["txcov"],
        "dataset_info": {
            "source": "diabetes_hotspot_predictions + ncd.fact_indicator_data (warehouse)",
            "coverage": "2016-2026 (monthly)",
            "granularity": "279,393 fact rows across 21,127 distinct geo locations",
            "notes": "Same national-only treatment-coverage limitation as hypertension: 'txcov' is shown as a national KPI only, never broadcast to LGA rows. No per-LGA driver dataset exists.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "cervical_cancer": {
        "label": "Cervical Cancer", "group": "ncd", "source": "warehouse",
        "hotspot_table": "cervical_cancer_hotspot",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": "Leading_Hotspot_Score", "zone": "Predicted_Zone_Label",
            "value": "Pop_Cancer_Detected",
        },
        "fact_schema": "ncd",
        # Verified live: 4,424 rows, 1,903 distinct geo locations, 2020-2026.
        "forecast_target": "ART Cervical Cancer new cases (suspected)",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": True, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "cervical_cancer_hotspot + ncd.fact_indicator_data (warehouse)",
            "coverage": "2020-2026 (monthly)",
            "granularity": "4,424 fact rows across 1,903 distinct geo locations",
            "notes": "No per-LGA screening/vaccination driver data exists in the warehouse, so this disease has no intervention levers or unit-cost budget table -- only case volume + trend.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "sickle_cell": {
        "label": "Sickle Cell Disease", "group": "ntd", "source": "warehouse",
        "hotspot_table": "sickle_cell_hotspots",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": None, "zone": "Zone_Label", "value": "SCD_Total_Cases",
        },
        # Correction vs. initial assumption: sickle cell facts live in the
        # ncd schema, NOT ntd (verified live -- 0 rows under ntd, 117,552
        # rows under ncd.fact_indicator_data, disease_name='Sickle Cell').
        # "group": "ntd" is kept for UI tab categorization only.
        "fact_schema": "ncd",
        "forecast_target": "Sickle Cell disease new cases (suspected)",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": False, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "sickle_cell_hotspots + ncd.fact_indicator_data (warehouse, disease_name='Sickle Cell')",
            "coverage": "Reported under the ncd schema, not ntd, despite the NTD tab grouping (verified live: 0 rows under ntd, 117,552 rows under ncd for Sickle Cell)",
            "granularity": "117,552 fact rows",
            "notes": "No risk score in the source hotspot table (has_score=False) -- areas are ranked by case volume, labelled 'Case Volume Rank' rather than implying a modelled risk score.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "asthma": {
        "label": "Asthma", "group": "ncd", "source": "warehouse",
        "hotspot_table": "asthma_hotspot_predictions",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "year", "month": "month",
            "score": None, "zone": "predicted_zone_classifier",
            "value": "asthma_admissions",
        },
        "fact_schema": "ncd",
        # Verified live: 200,097 rows, 20,864 distinct geo locations, 2016-2026.
        "forecast_target": "Asthma new cases (suspected)",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": False, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "asthma_hotspot_predictions + ncd.fact_indicator_data (warehouse)",
            "coverage": "2016-2026 (monthly)",
            "granularity": "200,097 fact rows across 20,864 distinct geo locations",
            "notes": "No risk score in the source hotspot table (has_score=False) -- ranked by admission volume instead.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "yaws": {
        "label": "Yaws", "group": "ntd", "source": "warehouse",
        "hotspot_table": "yaws_predictive_hotspot",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": "Month",
            "score": "Holistic_Risk_Score", "zone": "Predicted_Risk_Zone",
            "value": "reported_cases",
        },
        "fact_schema": "ntd",
        # Verified live: 558 rows, 403 distinct geo locations, 2020-2026.
        "forecast_target": "Yaws new cases",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "month", "time_grain_fact": "month",
        "has_score": True, "has_zone": True, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "yaws_predictive_hotspot + ntd.fact_indicator_data (warehouse)",
            "coverage": "2020-2026 (monthly)",
            "granularity": "558 fact rows across 403 distinct geo locations -- the smallest dataset of the 9",
            "notes": "Most LGAs have too few reported months for SARIMAX (only 2 of 768 LGAs had enough history for a per-LGA forecast in the latest export run), so the national/state forecast is far more reliable than any single LGA trend shown on the map.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },

    "elephantiasis": {
        "label": "Elephantiasis (LF)", "group": "ntd", "source": "warehouse",
        "hotspot_table": "elephantiasis_hotspot_predictions",
        "hotspot_cols": {
            "state": "State", "lga": "LGA", "year": "Year", "month": None,
            "score": None, "zone": None, "value": "Elephantiasis_Cases",
            "predicted": "Predicted_Cases",
        },
        "fact_schema": "ntd",
        # Verified live: 1,456 rows, 854 distinct geo locations, 2020-2026.
        "forecast_target": "Elephantiasis new cases",
        "forecastable": True, "tb_style_excluded": False,
        "time_grain_hotspot": "year_only", "time_grain_fact": "month",
        "has_score": False, "has_zone": False, "has_intervention_drivers": False,
        "interventions": [], "elasticity": {},
        "burden_tier": "volume_trend",
        "dataset_info": {
            "source": "elephantiasis_hotspot_predictions + ntd.fact_indicator_data (warehouse)",
            "coverage": "Hotspot table: year-only, no month column. Forecast series (fact table): 2020-2026 monthly",
            "granularity": "1,456 fact rows across 854 distinct geo locations",
            "notes": "The hotspot map can only show an annual trend (no monthly slider) because the source hotspot table has no month column -- the national/state Forecast tab is monthly because it's built from the separate fact_indicator_data table, not the hotspot table. Only 13 of 768 LGAs had enough history for a per-LGA forecast.",
        },
        "capabilities": {
            "overview": False, "hotspot_map": True, "forecast": True,
            "simulator": False, "whatiflab": True, "data_explorer": True,
            "methodology": False, "model_lab": False,
        },
    },
}

# TB's "Total notified" indicator is reported 4-way (Adult/Child x Male/Female)
# -- two overlapping partitions of the same population. Sum exactly ONE.
TB_CASE_PARTITION = "sex"
DOUBLE_COUNT_GUARD_NOTE = (
    "TB 'Total notified' is reported 4-way (Adult/Child x Male/Female) -- "
    "these are TWO overlapping partitions of the same population. "
    "Sum exactly ONE partition (TB_CASE_PARTITION)."
)

# public.dim_geo_location_master: admin_level=2 -> state (37 rows incl. FCT),
# admin_level=3 -> LGA (853 rows). Confirmed live against the warehouse.
GEO_STATE_LEVEL = 2
GEO_LGA_LEVEL = 3


def forecastable_diseases() -> list[str]:
    return [k for k, v in DISEASES.items() if v.get("forecastable")]


def diseases_with_capability(cap: str) -> list[str]:
    return [k for k, v in DISEASES.items() if v.get("capabilities", {}).get(cap)]


def get_hotspot_config(disease_id: str) -> dict:
    cfg = DISEASES[disease_id]
    if cfg.get("source") != "warehouse":
        raise ValueError(f"{disease_id} is not a warehouse-backed disease")
    return cfg


def get_burden_tier(disease_id: str) -> str:
    return DISEASES[disease_id]["burden_tier"]


def supports_month_slider(disease_id: str) -> bool:
    """True only when a real per-LGA monthly series exists to step through
    (fact-table time grain == month, forecastable, not TB-style excluded).
    Malaria is excluded here -- it already has its own live lever-driven
    slider in VisualOverview.jsx; this flag is for the *static* read-only
    slider used by every other disease."""
    if disease_id == "malaria":
        return False
    cfg = DISEASES[disease_id]
    return bool(cfg.get("forecastable") and cfg.get("forecast_target")
                and cfg.get("time_grain_fact") == "month" and not cfg.get("tb_style_excluded"))


def supports_benchmarking(disease_id: str) -> bool:
    """Comparative benchmarking (LGA vs peer LGAs vs state vs national
    average) needs a real per-LGA monthly fact series to compare across --
    same underlying requirement as the Forecast tab (forecastable, monthly
    grain, not TB-style excluded). Malaria always qualifies (its own
    LGA-month parquet)."""
    if disease_id == "malaria":
        return True
    cfg = DISEASES[disease_id]
    return bool(cfg.get("forecastable") and cfg.get("forecast_target")
                and cfg.get("time_grain_fact") == "month" and not cfg.get("tb_style_excluded"))


def supports_state_zone(disease_id: str) -> bool:
    """Whether a genuine, non-fabricated burden zone can be shown at STATE
    level. Malaria has its own incidence-banded zoneFor() (handled separately
    in the frontend). For new diseases, only those whose LGA-level zone
    concept is meaningful (has_zone) get an aggregated state-level zone --
    diseases with has_zone=False (hiv, elephantiasis) have no comparable
    0-100 score to band at any geography, so no state zone is fabricated."""
    if disease_id == "malaria":
        return True
    return bool(DISEASES[disease_id].get("has_zone"))


def public_disease_list() -> list[dict]:
    """Shape returned by GET /api/diseases -- only what the frontend needs."""
    out = []
    for did, cfg in DISEASES.items():
        caps = dict(cfg["capabilities"])
        caps["month_slider"] = supports_month_slider(did)
        caps["state_zone"] = supports_state_zone(did)
        caps["benchmarking"] = supports_benchmarking(did)
        out.append({
            "id": did,
            "label": cfg["label"],
            "group": cfg["group"],
            "capabilities": caps,
            "forecastable": cfg["forecastable"],
            "forecast_target": cfg.get("forecast_target"),
            "forecast_unavailable_reason": cfg.get("forecast_unavailable_reason"),
            "interventions": cfg.get("interventions", []),
            "has_unit_costs": did == "malaria",
            "dataset_info": cfg.get("dataset_info"),
        })
    return out
