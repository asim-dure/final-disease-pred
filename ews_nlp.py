# EWS NLP helper — mounts onto the existing FastAPI app in api.py.
# Adds two routes used by the console-react EWS Rule Builder:
#
#   POST /api/ews/interpret   — plain-English → JSON rule extraction via Groq
#   GET  /api/ews/meta        — static metadata (diseases, metric types, etc.)
#
# Integration (add to api.py):
#   from ews_nlp import ews_router
#   app.include_router(ews_router)
#
# No new port, no new process — runs on the same uvicorn instance as api.py.

import json
import os
from fastapi import APIRouter
from pydantic import BaseModel

ews_router = APIRouter()

DISEASES = {
    "malaria": {"label": "Malaria", "indicators": ["Confirmed cases", "Suspected cases", "Deaths", "Treatment success rate"]},
    "hiv":     {"label": "HIV",     "indicators": ["Individuals tested HIV positive", "New ART initiations", "PMTCT coverage", "Viral load suppression"]},
    "tb":      {"label": "TB",      "indicators": ["New TB notifications", "TB treatment success rate", "MDR-TB cases", "TB mortality rate"]},
    "hypertension": {"label": "Hypertension", "indicators": ["Hypertension cases", "BP controlled patients", "New hypertension diagnoses"]},
    "diabetes":     {"label": "Diabetes",     "indicators": ["Diabetes cases", "HbA1c controlled patients", "New diabetes diagnoses"]},
}

STATES_BY_DISEASE = {
    "malaria":      ["Kano", "Lagos", "Katsina", "Oyo", "Borno", "Kaduna", "Rivers", "Bauchi", "Jigawa", "Anambra",
                     "Kogi", "Benue", "Plateau", "Niger", "Sokoto", "Kebbi", "Zamfara", "Gombe", "Yobe", "Adamawa"],
    "hiv":          ["Lagos", "Benue", "Anambra", "Rivers", "FCT", "Kano", "Oyo", "Akwa Ibom", "Delta", "Edo"],
    "tb":           ["Lagos", "Kano", "Rivers", "FCT", "Oyo", "Kaduna", "Borno", "Delta", "Enugu", "Anambra"],
    "hypertension": ["Lagos", "Oyo", "Kano", "FCT", "Rivers", "Delta", "Anambra", "Kaduna", "Ogun", "Osun"],
    "diabetes":     ["Lagos", "Oyo", "FCT", "Rivers", "Anambra", "Delta", "Kano", "Kaduna", "Ogun", "Enugu"],
}

EXTRACT_PROMPT = """\
Extract EWS rule parameters from this text as JSON. Return ONLY valid JSON.

Fields (use null for anything not mentioned):
- rule_name: short name (5-8 words)
- disease_phrase: disease mentioned
- indicator_phrase: metric/indicator mentioned
- state_phrase: Nigerian state (or null for national)
- metric_type: "pct_change" | "raw" | "zscore"
- comparison_basis: "previous_period" | "same_period_last_year" | "rolling_mean"
- operator: ">=" | ">" | "<=" | "<"
- warning_value: numeric warning threshold (or null)
- critical_value: numeric critical threshold (or null)
- consecutive_periods: integer (default 1)
- mode: "actual" | "predicted" | "both"
- channels: ["whatsapp" and/or "email"]
- recipients: [phone numbers or emails]

Text: {text}"""


def _resolve(extracted: dict) -> dict:
    issues = []
    resolved = dict(extracted)

    phrase = (extracted.get("disease_phrase") or "").lower().strip()
    matched = next((k for k in DISEASES if phrase in k or k in phrase), None)
    resolved["disease"] = matched
    if not matched:
        issues.append(f"Could not match disease '{phrase}'. Available: {list(DISEASES)}")

    state_phrase = (extracted.get("state_phrase") or "").strip()
    if state_phrase and matched:
        states = STATES_BY_DISEASE.get(matched, [])
        sl = state_phrase.lower()
        resolved["state"] = next((s for s in states if sl in s.lower() or s.lower() in sl), None)
        if not resolved["state"]:
            issues.append(f"Could not match state '{state_phrase}' for {matched}.")
    else:
        resolved["state"] = None

    ind_phrase = (extracted.get("indicator_phrase") or "").strip()
    if ind_phrase and matched:
        all_inds = DISEASES[matched]["indicators"]
        candidates = [i for i in all_inds if ind_phrase.lower() in i.lower()]
        if candidates:
            resolved["indicator_name"] = candidates[0]
            if len(candidates) > 1:
                issues.append(f"Multiple matches for '{ind_phrase}': {candidates}. Using first.")
        else:
            resolved["indicator_name"] = all_inds[0]
            issues.append(f"No match for '{ind_phrase}'. Defaulting to '{all_inds[0]}'.")
    else:
        resolved["indicator_name"] = (DISEASES.get(matched or "malaria", {}).get("indicators") or ["cases"])[0]

    op = extracted.get("operator") or ">="
    conditions = {}
    if extracted.get("critical_value") is not None:
        conditions["critical"] = {"operator": op, "value": float(extracted["critical_value"])}
    if extracted.get("warning_value") is not None:
        conditions["warning"] = {"operator": op, "value": float(extracted["warning_value"])}
    if conditions:
        resolved["conditions"] = conditions

    resolved["issues"] = issues
    return resolved


@ews_router.get("/ews/api/ews/meta")
def ews_meta():
    return {
        "diseases": [{"key": k, "name": v["label"]} for k, v in DISEASES.items()],
        "metric_types": [
            {"key": "pct_change", "label": "% Change"},
            {"key": "raw",        "label": "Raw Value"},
            {"key": "zscore",     "label": "Z-Score"},
        ],
        "comparison_bases": [
            {"key": "previous_period",       "label": "Previous Period"},
            {"key": "same_period_last_year", "label": "Same Period Last Year"},
            {"key": "rolling_mean",          "label": "6-Month Rolling Mean"},
        ],
        "modes": [
            {"key": "actual",    "label": "Actual Only"},
            {"key": "predicted", "label": "Predicted (Nowcast) Only"},
            {"key": "both",      "label": "Both"},
        ],
        "channels": ["whatsapp", "email"],
        "whatsapp_live": False,
    }


class InterpretRequest(BaseModel):
    text: str


@ews_router.post("/ews/api/ews/interpret")
def ews_interpret(req: InterpretRequest):
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return {"extracted": {}, "resolved": {}, "issues": ["GROQ_API_KEY not set — AI interpretation unavailable."]}
    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": EXTRACT_PROMPT.format(text=req.text)}],
            temperature=0.1,
            max_tokens=512,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        s, e = raw.find("{"), raw.rfind("}") + 1
        extracted = json.loads(raw[s:e])
    except Exception as exc:
        return {"extracted": {}, "resolved": {}, "issues": [f"AI extraction failed: {exc}"]}

    resolved = _resolve(extracted)
    return {"extracted": extracted, "resolved": resolved, "issues": resolved.get("issues", [])}
