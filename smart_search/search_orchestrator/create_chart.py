"""
"Create your own chart" -- NL -> structured spec -> templated SQL -> data
for a React (ECharts) chart. Used when Smart Search's orchestrator can't find
an existing PowerBI chart for the user's question and they choose to build one.

Design (safe NL->SQL, no raw LLM SQL):
  1. interpret(query): a Groq agent turns the plain-language question into a
     CONSTRAINED spec -- which disease/fact table, which metric keywords to
     search indicators by, the x-axis dimension (time/state/lga/gender/age),
     and the chart type (line/bar/pie/bubble/histogram). The LLM never writes
     SQL; it only fills in tokens from fixed whitelists.
  2. The metric keywords are matched against dim_indicator_master. If several
     indicators match (e.g. "cases" -> 20+ malaria indicators), we hand those
     back for a HUMAN-IN-THE-LOOP pick instead of guessing.
  3. run_chart(spec): builds a parameterized SQL from templates (table name
     and x-dimension come from whitelists, indicator_key is a bound int) and
     returns rows shaped for the chart.

Only the five warehouse fact tables are queryable; sub-diseases live inside
the ncd/ntd facts and are narrowed by the indicator-name search.
"""
import os

import pandas as pd
from fastapi import HTTPException

FACT_TABLES = {
    "malaria": "fact_indicator_data_malaria",
    "hiv": "fact_indicator_data_hiv",
    "tb": "fact_indicator_data_tb",
    "ncd": "fact_indicator_data_ncd",
    "ntd": "fact_indicator_data_ntd",
}

# Sub-disease word -> which fact group it lives in.
SUBDISEASE_GROUP = {
    "hypertension": "ncd", "diabetes": "ncd", "asthma": "ncd", "cervical": "ncd",
    "arthritis": "ncd", "depression": "ncd", "breast": "ncd", "coronary": "ncd",
    "heart": "ncd", "cancer": "ncd",
    "yaws": "ntd", "elephantiasis": "ntd", "lymphatic": "ntd", "filariasis": "ntd",
    "sickle": "ntd", "snake": "ntd",
}

ALLOWED_CHART_TYPES = {"line", "bar", "pie", "bubble", "histogram"}
ALLOWED_X_DIMS = {"time", "state", "lga", "gender", "age"}

# x-dimension -> (SQL select for the grouping key, join clause, label).
_GEO_JOIN = "left join public.dim_geo_location_master g on g.geo_admin_location_key = f.geo_admin_location_key"
X_DIM_SQL = {
    "time":   {"key": "f.year::text",               "join": "",        "label": "Year",   "order": "min(f.year)"},
    "state":  {"key": "g.geo_admin_level2_name",     "join": _GEO_JOIN, "label": "State",  "order": "sum(f.indicator_value) desc"},
    "lga":    {"key": "g.geo_admin_level3_name",     "join": _GEO_JOIN, "label": "LGA",    "order": "sum(f.indicator_value) desc"},
    "gender": {"key": "f.gender",                    "join": "",        "label": "Gender", "order": "sum(f.indicator_value) desc"},
    "age":    {"key": "f.age::text",                 "join": "",        "label": "Age",    "order": "min(f.age)"},
}


_ENGINE = None


def _engine():
    """Single process-wide engine with a small connection pool -- rebuilding
    it per query added noticeable latency."""
    global _ENGINE
    if _ENGINE is None:
        url = os.getenv("WAREHOUSE_DATABASE_URL", "")
        if not url:
            raise HTTPException(500, "WAREHOUSE_DATABASE_URL not set -- can't build charts from the warehouse.")
        from sqlalchemy import create_engine
        _ENGINE = create_engine(url, pool_pre_ping=True, pool_size=4, max_overflow=4)
    return _ENGINE


def _resolve_fact(disease: str, terms: list[str]) -> tuple[str | None, str | None]:
    """Returns (fact_group, fact_table) or (None, None) if unknown."""
    d = (disease or "").lower().strip()
    if d in FACT_TABLES:
        return d, FACT_TABLES[d]
    for word, grp in SUBDISEASE_GROUP.items():
        if word in d or any(word in t.lower() for t in terms):
            return grp, FACT_TABLES[grp]
    return None, None


def interpret(query: str, groq_client, model: str, context: str = "", last_spec: dict | None = None) -> dict:
    import json

    prev_block = ""
    if last_spec and last_spec.get("indicator_key"):
        prev_block = (
            "\nPREVIOUS CHART the user just built (for follow-ups): "
            f"indicator=\"{last_spec.get('indicator_name')}\", disease={last_spec.get('disease')}, "
            f"x_dim={last_spec.get('x_dim')}, chart_type={last_spec.get('chart_type')}.\n"
            "If the new request only CHANGES that previous chart (e.g. 'now by state', "
            "'make it a bar chart', 'as a pie') and keeps the SAME metric, set "
            "\"reuse_previous\": true. Otherwise set it false.\n"
        )
    ctx_block = f"\nCONVERSATION SO FAR:\n{context}\n" if context else ""

    prompt = f"""A user wants to BUILD a chart from the health warehouse. Turn their plain-
language request into a strict JSON spec. You do NOT write SQL -- you only
choose values from the allowed lists.
{ctx_block}{prev_block}

Allowed disease values: malaria, hiv, tb, ncd, ntd. Map sub-diseases to their
group: hypertension/diabetes/asthma/cervical/arthritis/depression/breast
cancer/coronary heart disease -> "ncd"; yaws/elephantiasis/lymphatic
filariasis/sickle cell/snake bites -> "ntd". Keep the specific sub-disease
word (e.g. "hypertension") in search_terms so the right indicator is found.

Allowed x_dim (what the x-axis groups by): time, state, lga, gender, age.
If the user says "over time"/"trend"/"by year" -> time. "by state" -> state.
"by lga" -> lga. "male/female"/"by gender/sex" -> gender. "age wise"/"by
age" -> age. If unclear, use "time".

Allowed chart_type: line, bar, pie, bubble, histogram. If the user names a
different/unsupported type, set chart_type to "unsupported". If they don't
say, use "line".

search_terms: 2-5 lowercase keywords from the metric they want, e.g.
"malaria cases graph" -> ["malaria","cases"]; "hypertension new cases" ->
["hypertension","new","cases"]. Include the disease/sub-disease word.

USER REQUEST: "{query}"

Respond with ONLY this JSON:
{{"disease": "...", "search_terms": ["..."], "x_dim": "...", "chart_type": "...", "title": "<short chart title>", "reuse_previous": false}}
"""
    resp = groq_client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=250,
        temperature=0.1,
        response_format={"type": "json_object"},
    )
    try:
        spec = json.loads(resp.choices[0].message.content)
    except (json.JSONDecodeError, AttributeError):
        raise HTTPException(502, "Chart interpreter returned a non-JSON response")

    chart_type = (spec.get("chart_type") or "line").lower()
    if chart_type == "unsupported" or chart_type not in ALLOWED_CHART_TYPES:
        return {
            "status": "not_possible",
            "message": "I can only build line, bar, pie, bubble, or histogram charts. "
                       "What you're asking for doesn't fit any of those -- try rephrasing.",
        }

    x_dim = (spec.get("x_dim") or "time").lower()
    if x_dim not in ALLOWED_X_DIMS:
        x_dim = "time"

    # Follow-up that only tweaks the previous chart -> reuse its indicator, no
    # re-disambiguation needed. Skips straight to "ready".
    if spec.get("reuse_previous") and last_spec and last_spec.get("indicator_key"):
        reused = dict(last_spec)
        reused["x_dim"] = x_dim
        reused["chart_type"] = chart_type
        reused["title"] = spec.get("title") or last_spec.get("title")
        return {"status": "ready", "spec": reused}

    terms = [t for t in (spec.get("search_terms") or []) if t and isinstance(t, str)][:5]
    fact_group, fact_table = _resolve_fact(spec.get("disease", ""), terms)
    if not fact_table:
        return {
            "status": "not_possible",
            "message": f"I don't have a warehouse dataset for \"{spec.get('disease')}\". "
                       "I can build charts for malaria, HIV, TB, NCDs, or NTDs.",
        }

    candidates = _search_indicators(fact_table, terms)
    base = {
        "disease": fact_group, "fact_table": fact_table, "x_dim": x_dim,
        "chart_type": chart_type, "title": spec.get("title") or query,
        "search_terms": terms,
    }
    if not candidates:
        return {
            "status": "not_possible",
            "message": f"I couldn't find any indicator matching \"{' '.join(terms)}\" in the "
                       f"{fact_group.upper()} data. Try different wording.",
        }
    if len(candidates) == 1:
        base["indicator_key"] = candidates[0]["indicator_key"]
        base["indicator_name"] = candidates[0]["indicator_name"]
        return {"status": "ready", "spec": base}
    return {"status": "needs_indicator", "spec": base, "candidates": candidates}


# disease group -> the disease_id(s) used in dim_indicator_master, so the
# indicator search can scope to the right disease WITHOUT touching the giant
# fact table (which has no index on indicator_key -> a 20s seq scan). Lazily
# discovered once per process from a cheap distinct on dim.
_DISEASE_IDS_CACHE: dict = {}


def _disease_ids_for_group(group: str) -> list[int]:
    if group in _DISEASE_IDS_CACHE:
        return _DISEASE_IDS_CACHE[group]
    from sqlalchemy import text
    # dim_disease_master maps names -> ids; match the group's diseases by name.
    like_terms = {
        "malaria": ["malaria"], "hiv": ["hiv"], "tb": ["tb", "tuberc"],
        "ncd": ["hypertension", "diabetes", "asthma", "cervical", "arthritis",
                "depression", "breast", "coronary", "ncd", "non commun", "non-commun"],
        "ntd": ["yaws", "elephantiasis", "filariasis", "sickle", "snake", "ntd", "neglected"],
    }.get(group, [group])
    conds = " or ".join([f"lower(disease_name) like :t{i}" for i in range(len(like_terms))])
    params = {f"t{i}": f"%{like_terms[i]}%" for i in range(len(like_terms))}
    ids = []
    try:
        eng = _engine()
        with eng.connect() as c:
            for r in c.execute(text(f"select disease_id from public.dim_disease_master where {conds}"), params):
                ids.append(int(r[0]))
    except Exception:
        ids = []
    _DISEASE_IDS_CACHE[group] = ids
    return ids


def _search_indicators(fact_table: str, terms: list[str], limit: int = 12) -> list[dict]:
    """Searches the small dim_indicator_master by name terms only -- never the
    24M-row fact table -- so this stays fast. Scoped to the fact's disease
    group via disease_id when we can resolve it (else name terms already carry
    the disease word). run_chart handles the rare case of an indicator with no
    fact rows gracefully."""
    if fact_table not in FACT_TABLES.values() or not terms:
        return []
    from sqlalchemy import text
    eng = _engine()
    group = next((g for g, t in FACT_TABLES.items() if t == fact_table), None)
    disease_ids = _disease_ids_for_group(group) if group else []

    def run(all_terms: bool):
        joiner = " and " if all_terms else " or "
        conds = joiner.join([f"lower(i.indicator_name) like :t{i}" for i in range(len(terms))])
        params = {f"t{i}": f"%{terms[i].lower()}%" for i in range(len(terms))}
        scope = ""
        if disease_ids:
            scope = f" and i.disease_id in ({','.join(str(x) for x in disease_ids)})"
        sql = text(f"""
            select i.indicator_key, i.indicator_name
            from public.dim_indicator_master i
            where ({conds}) and i.indicator_name is not null{scope}
            order by length(i.indicator_name)
            limit {limit}
        """)
        with eng.connect() as c:
            return [{"indicator_key": int(r[0]), "indicator_name": r[1]} for r in c.execute(sql, params)]

    rows = run(all_terms=True)      # prefer indicators matching ALL keywords
    if not rows:
        rows = run(all_terms=False)  # fall back to ANY keyword
    return rows


# The fact tables have no index on indicator_key, so each aggregation is a
# ~20s parallel seq scan of 24M+ rows. We can't index a read-only warehouse,
# so cache results for the process lifetime -- the same chart replots
# instantly, and different breakdowns of one indicator only pay the scan once.
_CHART_DATA_CACHE: dict = {}


def run_chart(spec: dict) -> dict:
    from sqlalchemy import text
    fact_table = spec.get("fact_table")
    x_dim = spec.get("x_dim", "time")
    chart_type = spec.get("chart_type", "line")
    indicator_key = spec.get("indicator_key")

    if fact_table not in FACT_TABLES.values():
        raise HTTPException(400, "Unknown dataset")
    if x_dim not in X_DIM_SQL:
        raise HTTPException(400, "Unknown x dimension")
    if not isinstance(indicator_key, int):
        raise HTTPException(400, "indicator_key must be chosen first")

    cache_key = (fact_table, indicator_key, x_dim)
    if cache_key in _CHART_DATA_CACHE:
        data = _CHART_DATA_CACHE[cache_key]
    else:
        xd = X_DIM_SQL[x_dim]
        sql = text(f"""
            select {xd['key']} as xk, sum(f.indicator_value) as yv
            from public.{fact_table} f
            {xd['join']}
            where f.indicator_key = :ik and f.indicator_value is not null and {xd['key']} is not null
            group by {xd['key']}
            order by {xd['order']}
            limit 60
        """)
        eng = _engine()
        with eng.connect() as c:
            df = pd.read_sql(sql, c, params={"ik": indicator_key})
        data = [[str(r.xk), round(float(r.yv), 2)] for r in df.itertuples()]
        _CHART_DATA_CACHE[cache_key] = data

    xd = X_DIM_SQL[x_dim]

    if not data:
        return {
            "possible": False,
            "message": f"There's no data to plot for \"{spec.get('indicator_name', 'that indicator')}\" "
                       f"broken down by {xd['label'].lower()}. It might not be tracked that way -- "
                       "try a different breakdown (e.g. over time or by state).",
        }

    return {
        "possible": True,
        "chart_type": chart_type,
        "title": spec.get("title") or spec.get("indicator_name"),
        "indicator_name": spec.get("indicator_name"),
        "x_label": xd["label"],
        "y_label": "Value",
        "data": data,
    }
