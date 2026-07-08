"""
Ross-Macdonald mechanistic malaria transmission model, for the What-If Simulator's
"Mechanistic" mode.

WHY this exists (manager's brief, verbatim): "add population, population density,
more actual parameters, and include SEIR/Ross-Macdonald concepts... build this
logically since data isn't good enough to train a model." The existing Simulator
lever math (drivers.py) is an EMPIRICAL elasticity model: "if LLIN distribution
moves +X%, cases move -0.40*X% (fit from historical correlation)." That's a
reasonable statistical model, but it can't answer "why" -- it has no notion of a
mosquito, a biting rate, or population density. This module adds a complementary,
THEORY-DRIVEN layer using the classic Ross-Macdonald vectorial-capacity framework
so a user can reason about actual entomological/clinical parameters (biting rate,
vector survival, treatment rate) instead of an opaque "% change" abstraction.

This is intentionally NOT fit/trained on data (there is no facility-grain vector
bionomic data to train on). Instead it uses textbook parameter values from the
literature (Smith & McKenzie 2004; WHO Global Malaria Programme vector control
guidance), explicitly labelled as such everywhere they appear, mirroring the same
honesty pattern used for the budget solver's "illustrative PMI/WHO-range" costs.

Core equations (Ross 1911 / Macdonald 1957, standard modern form):

  Vectorial capacity        C  = (m * a^2 * p^n) / -ln(p)
  Basic reproduction number R0 = C * b * c / r          (Smith & McKenzie 2004 form)
  Steady-state human prevalence (Macdonald 1957 SIS approximation):
                             x* = (R0 - 1) / R0                        for R0 > 1, else 0
    where m  = vector-to-host ratio (mosquitoes per person)
          a  = human biting rate (bites per mosquito per day)
          p  = daily vector survival probability
          n  = extrinsic incubation period (days, temperature-dependent)
          b  = mosquito -> human transmission probability per infectious bite
          c  = human -> mosquito transmission probability per bite on an infectious host
          r  = human recovery rate (1 / infectious period, per day)

WHY EACH INPUT IS IN THE MODEL (the manager also asked to justify every
parameter -- this is that justification, kept next to the code it describes
rather than in a separate doc that can drift out of sync):

  pop_density   -- drives `m` via density_dilution_factor(). Vector density per
                   HOST (not per hectare) is what matters for transmission, and
                   breeding-site count doesn't scale with human population --
                   so denser settlements dilute the mosquito-to-host ratio.
                   This is the one parameter the manager explicitly named, and
                   it is the mechanism by which "population density" enters
                   Ross-Macdonald at all (it has no other natural slot).
  rainfall      -- drives `m` via rain_factor(). Standing water = larval
                   habitat; saturates rather than growing unboundedly, since
                   excess rain can also FLUSH larval sites.
  ndvi          -- drives `m` via ndvi_factor(). NDVI (vegetation greenness) is
                   a well-established remote-sensing correlate of mosquito
                   habitat availability independent of same-week rainfall
                   (standing vegetation/shade sustains breeding sites between
                   rain events) -- this is why it's a SEPARATE multiplier on
                   `m`, not a duplicate of the rain factor.
  temperature   -- drives `n` (extrinsic incubation period) via the standard
                   degree-day model. Colder -> parasite develops slower in the
                   mosquito -> fewer infectious mosquitoes at any time.
  itn_coverage  -- reduces `a` (deterrence) AND `p` (insecticidal kill). Two
                   distinct entomological effects of the same intervention,
                   modelled separately because they act on different terms.
  irs_coverage  -- reduces `p` only (indoor spraying kills resting mosquitoes;
                   it does not deter outdoor biting the way a bednet does).
  act_coverage  -- raises `r` (shortens the human infectious period). This is
                   population-wide because ACT is given to any confirmed case.
  iptp_coverage -- reduces `c` (human->mosquito transmission), but ONLY for the
                   pregnant-women sub-population (audience-scoped, exactly like
                   drivers.py's own iptp driver) -- IPTp clears placental/
                   peripheral parasitaemia in pregnant women specifically, it
                   is not a population-wide treatment.
  vaccine_coverage -- reduces `b` (mosquito->human transmission), audience-
                   scoped to the under-5 population, since RTS,S/R21-type
                   malaria vaccines are administered to young children and act
                   by reducing the chance an infectious bite establishes
                   infection (not by killing mosquitoes or curing an existing
                   infection).

Population density's role is the one genuinely novel input the manager asked
for. Vector density per person (m) is NOT primarily driven by how many people
live somewhere -- it's driven by breeding-site availability. Holding breeding
sites roughly fixed, doubling the human population roughly HALVES the
mosquito-to-human ratio (the same mosquitoes are now shared over more hosts) --
this is the standard "dilution"/zooprophylaxis-adjacent effect used to explain
why dense urban areas typically see lower malaria transmission than sparse rural
ones at the same rainfall/temperature. We apply this as a bounded multiplicative
adjustment on the literature baseline m0, not as a fitted coefficient.
"""
import math

# ---------------------------------------------------------------------------
# Literature default parameters (Smith & McKenzie 2004; WHO vector control
# guidance for An. gambiae-dominant West African settings). These are NOT fit
# to this dataset -- they are standard textbook/WHO values, used as the
# "no intervention, average conditions" starting point for the sliders.
# ---------------------------------------------------------------------------
DEFAULTS = {
    "m0": 4.0,     # baseline vector-to-host ratio at median rural density/rainfall
    "a0": 0.30,    # baseline human biting rate (bites/mosquito/day)
    "p0": 0.90,    # baseline daily vector survival probability (unsprayed)
    "b": 0.5,      # mosquito->human transmission probability per bite
    "c": 0.5,      # human->mosquito transmission probability per bite
    "r0": 1 / 60,  # baseline human recovery rate (~60-day untreated infectious period)
}
REF_DENSITY = 500.0   # people/km^2 -- density at which the dilution adjustment is neutral (=1.0)
REF_NDVI = 0.35        # typical wet-season NDVI for savanna/Sahel Nigeria -- neutral point

# Demographic ratio constants (NOT DHIS2/warehouse data -- Nigeria does not
# publish these per-facility, so they're standard national demographic
# estimates, applied uniformly to any population figure). Sources noted
# per-constant since the manager asked for parameter-level justification.
PREGNANT_SHARE = 0.044   # ~4.4% of population pregnant at any time (NDHS-consistent
                         # crude birth rate ~35/1000/yr x ~9mo effective carrying period;
                         # matches the ~4% figure already used in test_budget_solver.py)
UNDER5_SHARE = 0.175     # ~17.5% of population under 5 (UN World Population Prospects
                         # Nigeria age structure -- distinct from drivers.py's u5llin
                         # "audience: 0.35", which is under-5's share of CASES, not
                         # of population; the two numbers measure different things)

# DHS-style vaccine/health-access coverage: Nigeria has no facility-grain source
# for this (NDHS is a household SURVEY, not DHIS2 reporting), so it is modelled,
# not measured -- an illustrative national baseline (NDHS 2018-consistent basic
# child immunisation coverage, commonly cited ~31%) adjusted per-LGA by relative
# deprivation (poverty_mpi_h), since health-system access correlates with both.
NATIONAL_VACCINE_BASELINE = 0.31
# IRS has no national coverage figure published at LGA grain either (campaigns
# are localised/targeted); this is an illustrative NMEP-consistent low baseline
# reflecting that IRS reaches a minority of LGAs in any given year.
NATIONAL_IRS_BASELINE = 0.08


def extrinsic_incubation_days(temp_c: float) -> float:
    """Detinov/Macdonald degree-day model for P. falciparum EIP: n = DD / (T - T_min),
    DD=111 degree-days, T_min=16C (standard entomological constants). Clipped to a
    plausible 7-30 day range since the formula blows up near/below T_min."""
    if temp_c is None or temp_c <= 16.5:
        return 30.0
    n = 111.0 / (temp_c - 16.0)
    return max(7.0, min(30.0, n))


def density_dilution_factor(pop_density: float) -> float:
    """Bounded, monotonically-decreasing adjustment on vector-to-host ratio m as
    population density rises (see module docstring). 1.0 at REF_DENSITY (typical
    rural LGA), rising toward ~1.6 in sparse areas, falling toward ~0.45 in dense
    urban ones. Bounds are a deliberate simplifying choice, not a fitted curve."""
    if pop_density is None or pop_density <= 0:
        return 1.0
    ratio = REF_DENSITY / pop_density
    return max(0.45, min(1.6, ratio ** 0.35))


def ndvi_factor(ndvi: float) -> float:
    """Bounded adjustment on m from vegetation greenness (see module docstring
    for why this is separate from the rainfall factor). 1.0 at REF_NDVI;
    0.7..1.3 range -- a smaller swing than rain/density since NDVI is a slower-
    moving, more diffuse habitat signal than standing water."""
    if ndvi is None:
        return 1.0
    return max(0.7, min(1.3, 1.0 + (ndvi - REF_NDVI) * 0.9))


def vectorial_capacity(m: float, a: float, p: float, n: float) -> float:
    """C = (m * a^2 * p^n) / -ln(p) -- expected number of future infective bites
    arising from all mosquitoes biting one infectious human today."""
    if p <= 0 or p >= 1:
        return 0.0
    return (m * a * a * (p ** n)) / (-math.log(p))


def r0(vec_cap: float, b: float, c: float, r: float) -> float:
    """R0 = C * b * c / r (Smith & McKenzie 2004)."""
    if r <= 0:
        return 0.0
    return vec_cap * b * c / r


def steady_state_prevalence(R0: float) -> float:
    """Macdonald (1957) SIS-type steady-state parasite rate. Returns 0 for R0<=1
    (transmission cannot sustain itself); asymptotes toward 1 for very large R0."""
    if R0 <= 1.0:
        return 0.0
    return (R0 - 1.0) / R0


def population_context(population: float, pfpr: float = None, poverty_mpi_h: float = None,
                        dep_schooling: float = None) -> dict:
    """Assemble the state/LGA-level demographic & socioeconomic parameters the
    manager asked for, each tagged with exactly where it comes from:
      - "warehouse"   : a real DHIS2/warehouse-sourced column, used as-is
      - "demographic_ratio" : population x a standard national demographic
        share (not this location's own data -- Nigeria doesn't publish
        per-LGA pregnant/under-5 population counts)
      - "illustrative" : a modelled proxy where no source data exists at all
    """
    pop = population or 0.0
    out = {
        "population": {"value": round(pop), "source": "warehouse (agg_lga_pop.parquet)"},
        "pregnant_women_population": {
            "value": round(pop * PREGNANT_SHARE), "source": "demographic_ratio",
            "note": f"population x {PREGNANT_SHARE:.1%} (standard national estimate, not location-specific)"},
        "under5_population": {
            "value": round(pop * UNDER5_SHARE), "source": "demographic_ratio",
            "note": f"population x {UNDER5_SHARE:.1%} (UN World Population Prospects Nigeria age structure)"},
    }
    if pfpr is not None:
        out["infected_population_estimate"] = {
            "value": round(pop * pfpr / 100.0), "source": "warehouse (pfpr) x population",
            "note": f"population x PfPR {pfpr:.1f}% -- a prevalence-based estimate, not a case count"}
    if poverty_mpi_h is not None or dep_schooling is not None:
        parts = [v for v in (poverty_mpi_h, dep_schooling) if v is not None]
        out["socioeconomic_vulnerability_index"] = {
            "value": round(sum(parts) / len(parts), 1), "source": "warehouse (poverty_mpi_h, dep_schooling)",
            "note": "simple average of MPI poverty headcount % and education-deprivation % (literacy proxy); "
                    "higher = more vulnerable. Used below to discount nominal ACT coverage into EFFECTIVE coverage."}
    return out


# Reference ("status quo") coverage the forecast is assumed to already bake in.
# The case multiplier is measured RELATIVE to this point, not relative to a
# hypothetical zero-intervention world -- so at these slider positions the
# multiplier is 1.0 (the model leaves the data-driven forecast untouched) and
# moving a slider up/down from here scales it gradually. These MUST match the
# What-If sliders' initial positions in VisualOverview.jsx (itn 40, irs 50,
# act 45, vaccine 50; iptp defaults to the location's real reported rate).
REF_COVERAGE = {"itn": 0.40, "irs": 0.50, "act": 0.45, "vaccine": 0.50}


def _r0_for(coverage, m_base, n, access_discount):
    """R0 (and the underlying a/p/b/c/r terms) for one coverage set, holding the
    environment (m_base, n) fixed. Effect strengths are deliberately SOFTER than
    a textbook maximal-efficacy model: at realistic Nigerian coverage the country
    is still endemic (R0 > 1), so the ratio of two R0 values has room to move
    continuously instead of the prevalence-based ratio's hard 0/near-1 cliff."""
    m0, a0, p0, b0, c0, r0_rate = (DEFAULTS[k] for k in ("m0", "a0", "p0", "b", "c", "r0"))
    itn = max(0.0, min(1.0, coverage.get("itn", 0.0)))
    irs = max(0.0, min(1.0, coverage.get("irs", 0.0)))
    act = max(0.0, min(1.0, coverage.get("act", 0.0)))
    iptp = max(0.0, min(1.0, coverage.get("iptp", 0.0)))
    vac = max(0.0, min(1.0, coverage.get("vaccine", 0.0)))

    a = a0 * (1.0 - 0.45 * itn)                                   # ITN deters biting
    survival_penalty = 1.0 - (0.15 * itn + 0.30 * irs)           # ITN + IRS vector kill (softened)
    p = max(0.05, p0 * max(0.05, survival_penalty))
    r = r0_rate * (1.0 + 1.5 * act * access_discount)             # ACT shortens infectious period
    c = c0 * (1.0 - 0.6 * iptp * PREGNANT_SHARE)                  # IPTp: pregnant-women audience only
    b = b0 * (1.0 - 0.4 * vac * UNDER5_SHARE)                     # Vaccine: under-5 audience only
    C = vectorial_capacity(m_base, a, p, n)
    R0 = r0(C, b, c, r)
    return R0, {"m": round(m_base, 2), "a": round(a, 3), "p": round(p, 3), "b": round(b, 3), "c": round(c, 3),
                "vectorial_capacity": round(C, 3), "R0": round(R0, 2),
                "steady_state_prevalence": round(steady_state_prevalence(R0), 4)}


def run_scenario(pop_density: float, temp_c: float, rainfall_mm_day: float, ndvi: float = None,
                  itn_coverage: float = 0.0, irs_coverage: float = 0.0, act_coverage: float = 0.0,
                  iptp_coverage: float = 0.0, vaccine_coverage: float = 0.0,
                  socioeconomic_index: float = None, ref_coverage: dict = None,
                  pop_density_scale: float = 1.0) -> dict:
    """Compute a status-quo baseline and the slider scenario (R0 / prevalence /
    vectorial capacity), plus a case multiplier to apply to a case forecast --
    same multiplicative-scaling pattern the empirical Simulator already uses.

    The multiplier is (R0_scenario / R0_reference) ** 0.7, bounded -- NOT a
    prevalence ratio. Equilibrium prevalence (R0-1)/R0 is flat for R0>2 and
    cliffs at R0=1, so a prevalence ratio is either ~1 or ~0 with no usable
    middle (it pinned the old multiplier at its 0.02 floor for every realistic
    input). R0 scales continuously with every intervention term, and cases track
    transmission intensity far better than equilibrium prevalence, so the R0
    ratio gives a smooth, responsive, bounded control surface. The 0.7 exponent
    damps it (cases don't move one-for-one with R0); the reference point makes
    the DEFAULT slider positions a no-op (multiplier 1.0).

    Coverage args are fractions in [0, 1]:
      itn_coverage     -- ITN/LLIN use: reduces biting rate `a` AND vector survival `p`
      irs_coverage     -- indoor residual spraying: reduces vector survival `p`
      act_coverage     -- effective treatment coverage: raises human recovery rate `r`,
                          discounted by socioeconomic_index into EFFECTIVE coverage
      iptp_coverage    -- IPTp in pregnancy: reduces `c`, scoped to PREGNANT_SHARE only
      vaccine_coverage -- child immunisation: reduces `b`, scoped to UNDER5_SHARE only
    """
    itn_coverage = max(0.0, min(1.0, itn_coverage))
    irs_coverage = max(0.0, min(1.0, irs_coverage))
    act_coverage = max(0.0, min(1.0, act_coverage))
    iptp_coverage = max(0.0, min(1.0, iptp_coverage))
    vaccine_coverage = max(0.0, min(1.0, vaccine_coverage))

    rain_factor = 0.5 + 0.5 * min(1.0, (rainfall_mm_day or 0.0) / 8.0)   # 0.5..1.0, saturates ~8mm/day
    veg = ndvi_factor(ndvi)
    n = extrinsic_incubation_days(temp_c)

    m0 = DEFAULTS["m0"]
    # Reference m uses the location's REAL density; the scenario m uses the
    # density What-If lever's SCALED density -- so the density lever moves the
    # scenario R0 relative to the reference (it would cancel if both used the
    # same density). Denser -> more dilution -> lower m -> lower transmission.
    dilution = density_dilution_factor(pop_density)
    scaled_density = (pop_density * pop_density_scale) if (pop_density and pop_density_scale and pop_density_scale > 0) else pop_density
    dilution_scn = density_dilution_factor(scaled_density)
    m_ref = m0 * rain_factor * dilution * veg
    m_scn = m0 * rain_factor * dilution_scn * veg

    # ACT effectiveness discounted by socioeconomic access (poorer/less-literate
    # areas convert nominal coverage into treatment-seeking less completely).
    access_discount = 1.0
    if socioeconomic_index is not None:
        access_discount = max(0.6, 1.0 - (socioeconomic_index / 100.0) * 0.4)

    # Reference ("status quo") and scenario (slider) coverage sets. The reference
    # IPTp defaults to the SCENARIO IPTp when the caller doesn't override it, so
    # an untouched IPTp slider is a no-op (it's audience-tiny anyway).
    ref = dict(REF_COVERAGE)
    if ref_coverage:
        ref.update({k: v for k, v in ref_coverage.items() if v is not None})
    ref.setdefault("iptp", iptp_coverage)
    scn = {"itn": itn_coverage, "irs": irs_coverage, "act": act_coverage,
           "iptp": iptp_coverage, "vaccine": vaccine_coverage}

    R0_ref, ref_terms = _r0_for(ref, m_ref, n, access_discount)
    R0_scn, scn_terms = _r0_for(scn, m_scn, n, access_discount)
    # also the true no-intervention R0, for context/reporting (at real density)
    R0_natural, _ = _r0_for({}, m_ref, n, access_discount)

    ratio = (R0_scn / R0_ref) if R0_ref > 1e-9 else 1.0
    mult = ratio ** 0.7
    mult = max(0.3, min(2.2, mult))   # guard rails: bounded, gradual response

    return {
        "inputs": {"pop_density": pop_density, "temp_c": temp_c, "rainfall_mm_day": rainfall_mm_day, "ndvi": ndvi,
                   "itn_coverage": itn_coverage, "irs_coverage": irs_coverage, "act_coverage": act_coverage,
                   "iptp_coverage": iptp_coverage, "vaccine_coverage": vaccine_coverage,
                   "socioeconomic_index": socioeconomic_index},
        "derived": {"density_dilution": round(dilution, 3), "density_dilution_scenario": round(dilution_scn, 3),
                    "pop_density_scaled": round(scaled_density) if scaled_density else None,
                    "extrinsic_incubation_days": round(n, 1),
                    "rain_factor": round(rain_factor, 3), "ndvi_factor": round(veg, 3),
                    "access_discount": round(access_discount, 3),
                    "R0_natural_no_intervention": round(R0_natural, 2), "R0_ratio": round(ratio, 4)},
        # "baseline" = the status-quo reference the forecast already reflects, so
        # the R0 arrow reads "status quo -> your scenario" and is 1.0 at load.
        "baseline": ref_terms,
        "scenario": scn_terms,
        "case_multiplier": round(mult, 4),
        "method": "Ross-Macdonald vectorial capacity / R0 (Smith & McKenzie 2004 form); "
                  "multiplier = (R0_scenario / R0_status-quo)^0.7, bounded. Literature "
                  "default parameters, not fit to this dataset.",
    }
