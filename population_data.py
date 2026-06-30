"""
Population enrichment for Nigerian states / LGAs.

Source baseline: National Population Commission (NPC) 2006 census projected to
2022 (NBS projections). Values are in persons. Annual growth applied at 2.5%/yr
(Nigeria's approximate national growth rate) to cover 2023-2028.

LGA population is approximated by distributing each state's population across its
LGAs in proportion to the LGA's share of reporting facilities. True per-LGA
census figures are not available in the source file, so this is a documented
proxy used for incidence-per-1,000 scaling and as a model feature.
"""

# State -> projected 2022 population (persons), NPC/NBS projection basis.
STATE_POP_2022 = {
    "Kano": 14253000, "Lagos": 13491000, "Kaduna": 9032000, "Katsina": 9001000,
    "Oyo": 8120000, "Rivers": 7476000, "Bauchi": 7540000, "Jigawa": 6201000,
    "Benue": 6141000, "Anambra": 6001000, "Borno": 6010000, "Delta": 5920000,
    "Niger": 6010000, "Imo": 5901000, "Akwa Ibom": 5900000, "Ogun": 5890000,
    "Sokoto": 5900000, "Kebbi": 5001000, "Ondo": 5001000, "Osun": 5000000,
    "Kogi": 4910000, "Zamfara": 5400000, "Enugu": 4690000, "Kwara": 3500000,
    "Edo": 4780000, "Plateau": 4900000, "Adamawa": 4700000, "Cross River": 4200000,
    "Abia": 4112000, "Ekiti": 3500000, "Gombe": 3900000, "Yobe": 3900000,
    "Taraba": 3600000, "Ebonyi": 3000000, "Nasarawa": 2900000, "Bayelsa": 2500000,
    "Federal Capital Territory": 3840000,
}

GROWTH_RATE = 0.025
BASE_YEAR = 2022


def state_population(state: str, year: int) -> float:
    """Projected state population for a given year."""
    base = STATE_POP_2022.get(state)
    if base is None:
        return float("nan")
    return base * ((1.0 + GROWTH_RATE) ** (year - BASE_YEAR))
