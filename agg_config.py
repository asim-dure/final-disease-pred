"""
Column classification for aggregating DHIS2 facility-level malaria data.

Aggregation logic (mirrors the project spec):
  - GROUP KEYS : geography + time (not aggregated; used as group dimensions)
  - SUM        : absolute counts (cases, doses, nets, admissions...) -> summed across facilities
  - MEAN       : rates / percentages / coverage / environment -> averaged across facilities
  - FIRST      : identifiers / static attributes -> first non-null in the group

`facility` is a GROUP KEY at ward level and below; when rolling up it becomes a
count (n_facilities). Weather columns are environmental and are averaged (MEAN).
"""

TARGET = "MAL - Malaria cases confirmed (number)"

GROUP_KEYS = ["country", "state", "lga", "ward", "facility", "year", "month"]

# Columns dropped from aggregates (raw struct / redundant)
DROP_COLS = ["datas"]

WEATHER_COLS = [
    "temperature_mean_c", "temperature_max_c", "temperature_min_c",
    "humidity_pct", "rainfall_mm_day", "wind_speed_ms", "solar_kwh_m2_day",
]

# Explicit SUM list per the spec (matched against actual CSV names; truncated
# names in the CSV are matched by prefix in build_classification()).
SUM_EXPLICIT = [
    "ACT Given - Total",
    "IPTp1 Coverage (institutional)",
    "IPTp2 Coverage (institutional)",
    "IPTp3 Coverage (institutional)",
    "IPTp>=4 Coverage (institutional)",
    "LLIN given",                       # "LLIN given – Total" (en-dash safe prefix)
    "Children <5 yrs who received LLIN",
    "MAL - Malaria cases confirmed (number)",
    "MAL - Malaria cases tested with RDT",
    "MAL - Malaria cases tested with microscopy",
    "MAL - Total reported malaria cases",
    "MAL - Malaria deaths inpatient",
    "MAL - Malaria inpatient admissions",
    "MAL - Non-malaria deaths inpatient",
    "Persons with Severe Malaria given recommended pre-referral",
    "Persons with Severe Malaria treated with Artesunate",
    "Persons with Severe Malaria treated with other pre referral",
    "Severe Malaria cases seen",
    # additional absolute counts present in the file
    "Anti-Malarial treatment",
    "Anti-Malarial treatment among children under 5 yrs",
    "Access to an ITN",
    "MAL - Non-malaria outpatient cases",
    "Number of malaria cases treated with artemisinin",
    "Number of malaria positive cases by microscopy",
    "Number of malaria positive cases by rapid diagnostic test",
    "Number of suspected malaria cases",
    "Children under age 5 with a fever received ACT",
    "Children with a fever had blood taken for testing",
    "Severe Malaria Treatment",
    "Closing Balance - Rapid Diagnostic Test",
]

# Substrings that force a column to MEAN (rates / proportions / coverage / static survey)
MEAN_SUBSTRINGS = [
    "%", "percentage", "rate", "positivity", "completeness", "prevalence",
    "literacy", "ownership", "use of", "households using", "households with",
    "diagnostic usage", "coverage", "estimated malaria cases",
    "mortality", "case fatality", "confirmed malaria (rdt",
    "malaria diagnostic", "fever testing", "who slept under",
    "sleeping under", "who say there", "seen or heard", "who received",
    "took any ipt", "antenatal care", "antenatal 1st", "clinically diagnosed",
    "with a fever", "attending antenatal", "clean fuels", "improved water",
    "vector control", "sources of itns", "persons with access",
]


def build_classification(all_cols):
    """Return dict mapping each column -> 'key' | 'sum' | 'mean' | 'first' | 'drop'."""
    cls = {}
    sum_lower = [s.lower() for s in SUM_EXPLICIT]
    for c in all_cols:
        cl = c.lower().strip()
        if c in GROUP_KEYS:
            cls[c] = "key"
        elif c in DROP_COLS:
            cls[c] = "drop"
        elif c in WEATHER_COLS:
            cls[c] = "mean"
        elif any(cl.startswith(s) or s in cl for s in sum_lower):
            cls[c] = "sum"
        elif any(sub in cl for sub in MEAN_SUBSTRINGS):
            cls[c] = "mean"
        else:
            # default: treat unknown numeric indicators as counts (sum)
            cls[c] = "sum"
    # IPTp coverage columns: spec says SUM (override any mean match)
    for c in all_cols:
        if c.lower().startswith("iptp") and "coverage" in c.lower():
            cls[c] = "sum"
    return cls
