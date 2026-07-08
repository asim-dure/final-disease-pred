"""
STANDALONE TEST (not wired into the app) — Optimal malaria intervention budget
allocation for ONE LGA in a single month, solved two ways and compared:

  1. SOLVER  — an exhaustive combinatorial optimiser (multiple-choice knapsack
     over discretised spend levels; brute-force enumeration with budget pruning,
     i.e. the "PnC" approach) that finds the provably best spend mix.
  2. GROQ LLM — the same problem handed to llama-3.3-70b-versatile, asked to
     allocate the budget. We then RE-SCORE the LLM's allocation with the exact
     same impact model, so we compare like-for-like: what the LLM *claims* vs
     what its allocation *actually* achieves vs the solver optimum.

Impact model uses the app's OWN intervention elasticities (from drivers.py
DRIVER_META) so the effectiveness assumptions are the project's, not invented.
Unit costs are illustrative PMI/WHO-range figures (the repo carries no costs),
clearly flagged below. Real cases_pred & population come from forecast_lga.parquet.

Run:  python test_budget_solver.py
"""
import os
import json
import math
import itertools
from dotenv import load_dotenv
import pandas as pd

load_dotenv()

# ── Scenario ────────────────────────────────────────────────────────────────
STATE, LGA, YM = "Katsina", "Funtua", "2026-10"      # a high-burden LGA, forecast month
BUDGET = 120_000                                     # USD available for this LGA-month
STEP = 5_000                                         # spend granularity for the solver grid
K = 3.0                                              # diminishing-returns curvature (see below)

# ── Interventions ───────────────────────────────────────────────────────────
# elasticity           : |Δcases / Δdriver| from drivers.py DRIVER_META (app's model)
# case_audience        : fraction of the LGA's cases the intervention can act on
#                        (drivers.py 'audience'; 1.0 for whole-population measures)
# unit_cost / coverage : illustrative PMI/WHO-range procurement+delivery costs
# The two derived numbers per intervention:
#   max_avert  = cases * case_audience * elasticity   (ceiling if fully scaled up)
#   full_cost  = cost to fully cover its target audience for the LGA-month
INTERVENTIONS = {
    "LLIN nets":        dict(elasticity=0.40, case_audience=1.00, unit_cost=5.00,  per="pop",   ratio=1/1.8),   # 1 net / 1.8 people
    "ACT treatment":    dict(elasticity=0.30, case_audience=1.00, unit_cost=1.50,  per="cases", ratio=1.2),     # 1.2 courses / confirmed case
    "RDT testing":      dict(elasticity=0.12, case_audience=1.00, unit_cost=0.55,  per="cases", ratio=2.0),     # 2 tests / confirmed case
    "IPTp (pregnant)":  dict(elasticity=0.20, case_audience=0.08, unit_cost=0.70,  per="pop",   ratio=3*0.04),  # 3 SP doses, ~4% of pop pregnant
    "SMC (under-5)":    dict(elasticity=0.30, case_audience=0.35, unit_cost=4.00,  per="pop",   ratio=0.17),    # 1 monthly course, ~17% under-5
}


def load_lga():
    df = pd.read_parquet("forecast_lga.parquet")
    df["ym"] = df["year"].astype(str) + "-" + df["month"].astype(str).str.zfill(2)
    r = df[(df.state == STATE) & (df.lga == LGA) & (df.ym == YM)]
    if r.empty:
        raise SystemExit(f"No forecast row for {STATE}/{LGA} {YM}")
    return float(r.iloc[0]["cases_pred"]), float(r.iloc[0]["population"])


def build_params(cases, pop):
    """Return {name: {max_avert, full_cost}} from the model above."""
    p = {}
    for name, d in INTERVENTIONS.items():
        base = pop if d["per"] == "pop" else cases
        full_cost = base * d["ratio"] * d["unit_cost"]
        max_avert = cases * d["case_audience"] * d["elasticity"]
        p[name] = dict(max_avert=max_avert, full_cost=full_cost)
    return p


def averted(spend, full_cost, max_avert):
    """Concave (diminishing-returns) impact: ~95% of the ceiling at full-coverage
    spend, so extra dollars on an already-funded intervention buy less — which is
    exactly why the optimum SPREADS across interventions and needs a real solver
    (greedy-by-cheapest is not optimal under diminishing returns)."""
    if full_cost <= 0:
        return 0.0
    return max_avert * (1.0 - math.exp(-K * min(spend, full_cost) / full_cost))


# ── 1) SOLVER: exhaustive combinatorial optimisation (PnC) ───────────────────
def solve(params, budget):
    names = list(params)
    # per-intervention candidate spend levels: 0, STEP, 2*STEP, ... up to its
    # full cost (never useful to spend past full coverage) or the budget.
    levels = {}
    for n in names:
        cap = min(params[n]["full_cost"], budget)
        lv = list(range(0, int(cap) + STEP, STEP))
        lv = [min(x, budget) for x in lv]
        levels[n] = sorted(set(lv))
    total_space = 1
    for n in names:
        total_space *= len(levels[n])

    best = {"avert": -1, "alloc": None, "spend": 0}
    evaluated = 0
    # Recursive enumeration with budget pruning — this is the brute-force "PnC".
    def rec(i, spent, avert_sum, alloc):
        nonlocal best, evaluated
        if i == len(names):
            evaluated += 1
            if avert_sum > best["avert"]:
                best = {"avert": avert_sum, "alloc": dict(alloc), "spend": spent}
            return
        n = names[i]
        for s in levels[n]:
            if spent + s > budget:
                break  # levels sorted asc -> no larger level fits either
            alloc[n] = s
            rec(i + 1, spent + s, avert_sum + averted(s, params[n]["full_cost"], params[n]["max_avert"]), alloc)
        alloc.pop(n, None)
    rec(0, 0, 0.0, {})
    return best, total_space, evaluated


# ── 2) GROQ LLM: same problem, asked to allocate ────────────────────────────
def ask_llm(cases, pop, params, budget):
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        return None, "GROQ_API_KEY not set"
    from groq import Groq
    client = Groq(api_key=api_key)
    rows = "\n".join(
        f"  - {n}: elasticity {INTERVENTIONS[n]['elasticity']}, "
        f"max cases avertable = {params[n]['max_avert']:.0f}, "
        f"full-coverage cost = ${params[n]['full_cost']:,.0f}"
        for n in params
    )
    prompt = f"""You are a malaria programme budget optimiser for Nigeria's NMEP.
For ONE local government area (LGA) for ONE month, allocate a fixed budget across
malaria interventions to MAXIMISE total malaria cases averted.

LGA: {LGA}, {STATE} State. Month: {YM}.
Projected malaria cases this month: {cases:,.0f}. Population: {pop:,.0f}.
TOTAL BUDGET: ${budget:,.0f}. Spend must be in multiples of ${STEP:,.0f}.

Interventions (spend $s on one is capped at its full-coverage cost; the cases it
averts follows a DIMINISHING-RETURNS curve:
    cases_averted(s) = max_avert * (1 - exp(-{K} * s / full_cost))
so the first dollars help most and returns flatten near full coverage):
{rows}

Allocate the budget to maximise TOTAL cases averted (sum across interventions).
You may fund any subset. Total spend must be <= ${budget:,.0f}.
Return ONLY valid JSON (no prose, no markdown):
{{"allocations": {{"<intervention name exactly as listed>": <dollars>, ...}},
  "expected_total_cases_averted": <number>}}"""
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2, max_tokens=800,
    )
    txt = resp.choices[0].message.content.strip()
    s, e = txt.find("{"), txt.rfind("}") + 1
    return json.loads(txt[s:e]), None


def score_llm(alloc, params, budget):
    """Re-score the LLM's chosen spends with the SAME impact model, clamped to
    each intervention's full cost and snapped to the spend grid. Returns actual
    averted + feasibility info so the comparison is apples-to-apples."""
    clean, total = {}, 0
    for n in params:
        raw = float(alloc.get(n, 0) or 0)
        s = max(0, round(raw / STEP) * STEP)
        s = min(s, int(params[n]["full_cost"]) // STEP * STEP + STEP, params[n]["full_cost"])
        clean[n] = s
        total += s
    over = total > budget + 1e-6
    actual = sum(averted(clean[n], params[n]["full_cost"], params[n]["max_avert"]) for n in params)
    return clean, total, actual, over


def bar(x, xmax, width=22):
    n = int(round(width * x / xmax)) if xmax else 0
    return "█" * n + "·" * (width - n)


def main():
    cases, pop = load_lga()
    params = build_params(cases, pop)

    print("=" * 74)
    print(f" BUDGET OPTIMISATION TEST — {LGA}, {STATE}  ·  {YM}")
    print("=" * 74)
    print(f" Projected malaria cases : {cases:,.0f}")
    print(f" Population              : {pop:,.0f}")
    print(f" Budget                  : ${BUDGET:,.0f}   (spend grid ${STEP:,.0f})")
    print("\n Interventions (elasticity from app's drivers.py; costs PMI/WHO-range):")
    print(f"   {'intervention':<18}{'elast':>6}{'max avert':>11}{'full cost':>13}{'$/case @first$':>15}")
    for n in params:
        first_ce = params[n]["full_cost"] / (params[n]["max_avert"] * K) if params[n]["max_avert"] else float("inf")
        print(f"   {n:<18}{INTERVENTIONS[n]['elasticity']:>6.2f}{params[n]['max_avert']:>11,.0f}"
              f"{params[n]['full_cost']:>13,.0f}{first_ce:>14.2f}")

    # ---- solver ----
    best, space, evaluated = solve(params, BUDGET)
    print("\n" + "-" * 74)
    print(" [1] SOLVER — exhaustive multiple-choice knapsack (brute-force PnC)")
    print("-" * 74)
    print(f"   combinatorial space  : {space:,} spend-level combinations")
    print(f"   feasible evaluated   : {evaluated:,} (after budget pruning)")
    print(f"   {'intervention':<18}{'spend':>12}   allocation")
    for n in params:
        s = best["alloc"][n]
        print(f"   {n:<18}${s:>10,.0f}   {bar(s, BUDGET)}")
    print(f"   {'TOTAL SPEND':<18}${best['spend']:>10,.0f}")
    print(f"   >> SOLVER cases averted (optimum): {best['avert']:,.0f}")

    # ---- LLM ----
    print("\n" + "-" * 74)
    print(" [2] GROQ LLM — llama-3.3-70b-versatile, same problem")
    print("-" * 74)
    llm, err = ask_llm(cases, pop, params, BUDGET)
    if err:
        print("   LLM unavailable:", err)
        return
    clean, llm_total, llm_actual, over = score_llm(llm.get("allocations", {}), params, BUDGET)
    print(f"   {'intervention':<18}{'spend':>12}   allocation")
    for n in params:
        print(f"   {n:<18}${clean[n]:>10,.0f}   {bar(clean[n], BUDGET)}")
    print(f"   {'TOTAL SPEND':<18}${llm_total:>10,.0f}" + ("   ⚠ OVER BUDGET" if over else ""))
    print(f"   LLM's CLAIMED cases averted     : {float(llm.get('expected_total_cases_averted', 0)):,.0f}")
    print(f"   LLM allocation's ACTUAL averted : {llm_actual:,.0f}  (re-scored with same model)")

    # ---- comparison ----
    gap = best["avert"] - llm_actual
    pct = 100 * gap / best["avert"] if best["avert"] else 0
    print("\n" + "=" * 74)
    print(" COMPARISON")
    print("=" * 74)
    print(f"   SOLVER optimum ............ {best['avert']:,.0f} cases averted  (${best['spend']:,.0f})")
    print(f"   LLM actual ................ {llm_actual:,.0f} cases averted  (${llm_total:,.0f})")
    print(f"   LLM claimed ............... {float(llm.get('expected_total_cases_averted', 0)):,.0f} cases averted")
    print(f"   Solver beats LLM by ....... {gap:,.0f} cases  ({pct:.1f}% more, same budget)")
    claim_err = float(llm.get("expected_total_cases_averted", 0)) - llm_actual
    print(f"   LLM self-estimate error ... {claim_err:+,.0f} cases (claimed − actual)")
    print("=" * 74)


if __name__ == "__main__":
    main()
