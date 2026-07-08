"""
LLM extraction step for the autonomous News & Intervention Alerts pipeline.

Input is UNPREDICTABLE: NACA/NMEP/NTBLCP publish everything from genuine
outbreak/case-surge announcements to procurement notices, newsletters,
staff-welfare posts, and strategic-plan launches. The prompt and schema below
are deliberately permissive (every field nullable, no field required to be
present) so a post that isn't actually alert-worthy is classified as such
rather than crashing or forcing a fabricated geography/severity onto
unrelated content. extract() never raises -- on any failure it returns a
safe, clearly-marked fallback dict so one bad LLM response can't break a
pipeline run covering many posts.
"""
import json
import logging
import os

log = logging.getLogger("news_llm")

EXTRACT_PROMPT = """\
You are a disease-surveillance analyst for Nigeria's Federal Ministry of Health.
You will be shown ONE post from an official Nigerian health programme (NACA / \
NMEP / NTBLCP). These programmes publish a WIDE variety of content -- genuine \
outbreak or case-surge announcements, but also procurement notices, staff \
welfare updates, newsletters, conference announcements, and general awareness \
content. Most posts are NOT public-health alerts.

Source: {source_label}
Title: {title}
Content: {content}
{weather_block}
Return ONLY valid JSON (no markdown fences, no commentary) with exactly these fields:
{{
  "is_alert_worthy": true or false -- true ONLY if this post reports an OUTBREAK, \
case surge/cluster, or emerging/ongoing transmission of a COMMUNICABLE or \
NOTIFIABLE disease (e.g. Lassa fever, cholera, measles, mpox, diphtheria, \
meningitis, yellow fever, Ebola, dengue), OR a substantive surveillance/\
programmatic update on malaria, HIV or TB. FALSE for drug-quality/recall or \
counterfeit-medicine notices, nutrition/food/allergy topics, non-communicable \
diseases, health financing/policy, staffing, procurement, appointments, \
awareness days, or generic health features carrying no outbreak/surveillance signal.
  "disease": one of "malaria", "hiv", "tb", "other", or null if not identifiable,
  "disease_other_label": the SPECIFIC disease/pathogen name in Title Case \
(e.g. "Cholera", "Ebola", "Mpox", "Measles", "Diphtheria") -- REQUIRED whenever \
is_alert_worthy is true and disease is "other" or null. If you cannot name the \
specific disease, set is_alert_worthy to false rather than leaving this empty. \
Null only when disease is one of malaria/hiv/tb.
  "geography_level": one of "national", "state", "lga", "facility", "unclear",
  "location": the specific state/LGA/facility name mentioned, or "Nigeria" for \
national scope, or null if genuinely not stated,
  "severity": one of "informational", "watch", "warning", "critical" -- your \
best-effort assessment of urgency, "informational" if not alert-worthy,
  "summary": a 2-4 sentence plain-English summary of what the post actually says \
-- if real figures are present (case counts, deaths, CFR, trend vs. prior \
period, affected states/LGAs, age/sex distribution), cite the SPECIFIC numbers \
shown, do not just restate the disease name generically.
  "epi_data": an object with the SPECIFIC numeric figures for THIS report's \
reporting period if present in the text, else null. Use null for any single \
field not stated -- never guess a number. Fields:
    {{"epi_week": integer epidemiological week number or null,
      "confirmed_this_week": new confirmed cases in the current/latest week or null,
      "deaths_this_week": deaths in the current/latest week or null,
      "cfr_pct": case fatality rate as a number (e.g. 30.8 for 30.8%) or null,
      "cumulative_confirmed": cumulative confirmed cases for the year/period or null,
      "cumulative_deaths": cumulative deaths for the year/period or null,
      "states_affected": number of states with at least one confirmed case or null,
      "lgas_affected": number of LGAs affected or null,
      "top_states": array of the most-affected state names listed, or null}}
  "intervention_recommendation": 2-4 sentences of concrete, actionable early-\
intervention guidance for FMOH/state/LGA health officials IF this is alert-\
worthy, grounded only in what the post states -- never invent case numbers, \
locations, or facts not present in the text. Null if not alert-worthy.
  "cross_disease_correlation": 3-5 sentences analyzing how this disease/outbreak \
could correlate with, mask, or affect the surveillance/diagnosis/caseload of \
OTHER diseases -- e.g. diseases that share overlapping symptoms (fever-\
presenting illnesses like malaria, typhoid, dengue, and Lassa fever are \
commonly clinically confused at first presentation, since they share the \
fever/headache/fatigue prodrome); explain the specific diagnostic-confusion or \
caseload risk this creates for those other diseases in this geography (e.g. \
"a Lassa fever surge in {{location}} risks malaria cases being misdiagnosed \
or malaria caseloads appearing inflated/deflated due to differential-diagnosis \
confusion, since both present with fever in the same season/region"), and give \
a concrete recommendation for adjusting clinical/surveillance practice for \
those other diseases as a result (e.g. mandate RDT/lab confirmation rather than \
clinical diagnosis alone in affected LGAs during the outbreak period). Ground \
this in real clinical/epidemiological relationships between named diseases, \
never invent a correlation that doesn't medically make sense. If real current \
weather data is provided above, explicitly factor it in for weather-sensitive \
diseases (malaria, dengue, cholera, yellow fever) -- e.g. elevated rainfall/\
humidity/optimal temperature for mosquito breeding should be cited as raising \
near-term malaria risk alongside whatever disease this post is actually about. \
Null if not alert-worthy or no meaningful cross-disease relationship applies.
}}

If the content is ambiguous, unrelated to disease surveillance, or you are \
unsure, set is_alert_worthy to false rather than guessing. Never fabricate a \
specific case count, location, or figure that is not stated in the text above.

Special case -- official situation reports (sitreps) from a national disease \
control agency (e.g. NCDC) that confirm an ACTIVE, ONGOING outbreak but don't \
include case-count detail in the text shown to you: these ARE alert-worthy \
(severity "watch" at minimum, since active national-level surveillance on a \
named disease is itself a meaningful signal) even without specific numbers. \
For intervention_recommendation in this case, give STANDARD, well-established \
public-health guidance for that specific disease (e.g. for Lassa fever: rodent \
control and food storage hygiene, isolation precautions and ribavirin protocol \
for suspected cases, community awareness) -- this is general medical knowledge \
about the named disease, not a fabricated claim about this specific outbreak's \
numbers, so it is allowed and expected here."""

FALLBACK = {
    "is_alert_worthy": False,
    "disease": None,
    "disease_other_label": None,
    "geography_level": "unclear",
    "location": None,
    "severity": "informational",
    "summary": None,
    "epi_data": None,
    "intervention_recommendation": None,
    "cross_disease_correlation": None,
    "weather": None,
}

_EPI_NUM_FIELDS = ("epi_week", "confirmed_this_week", "deaths_this_week", "cfr_pct",
                   "cumulative_confirmed", "cumulative_deaths", "states_affected", "lgas_affected")


def _coerce_epi(raw) -> dict | None:
    """epi_data is the structured numeric backbone of the trajectory chart --
    coerce every field to a number (or None), drop anything non-numeric the
    LLM might have returned, so the consolidation/charting code can trust it."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for f in _EPI_NUM_FIELDS:
        v = raw.get(f)
        try:
            out[f] = float(v) if v is not None and str(v).strip() != "" else None
        except (ValueError, TypeError):
            out[f] = None
    top = raw.get("top_states")
    out["top_states"] = [str(s)[:60] for s in top][:8] if isinstance(top, list) else None
    # Only meaningful if at least one real number came through
    if all(out[f] is None for f in _EPI_NUM_FIELDS):
        return None
    return out

_VALID_DISEASE = {"malaria", "hiv", "tb", "other", None}
_VALID_LEVEL = {"national", "state", "lga", "facility", "unclear"}
_VALID_SEVERITY = {"informational", "watch", "warning", "critical"}


def _coerce(raw: dict) -> dict:
    """Defensive normalization -- an LLM can return a value outside the
    allowed enum, a missing field, or a wrong type. Never trust it blindly;
    fall back field-by-field rather than discarding the whole extraction."""
    out = dict(FALLBACK)
    if not isinstance(raw, dict):
        return out
    out["is_alert_worthy"] = bool(raw.get("is_alert_worthy", False))
    disease = raw.get("disease")
    out["disease"] = disease if disease in _VALID_DISEASE else None
    label = raw.get("disease_other_label")
    out["disease_other_label"] = str(label)[:80].strip() if label and str(label).strip().lower() not in ("", "null", "none", "unknown", "n/a") else None
    # An alert-worthy item MUST name its disease, otherwise it renders as an
    # "Unknown Outbreak" card -- half-baked data the user (rightly) rejects.
    if out["is_alert_worthy"] and out["disease"] in (None, "other") and not out["disease_other_label"]:
        out["is_alert_worthy"] = False
    level = raw.get("geography_level")
    out["geography_level"] = level if level in _VALID_LEVEL else "unclear"
    loc = raw.get("location")
    out["location"] = str(loc)[:200] if loc else None
    sev = raw.get("severity")
    out["severity"] = sev if sev in _VALID_SEVERITY else "informational"
    summary = raw.get("summary")
    out["summary"] = str(summary)[:600] if summary else None
    out["epi_data"] = _coerce_epi(raw.get("epi_data"))
    rec = raw.get("intervention_recommendation")
    out["intervention_recommendation"] = str(rec)[:1200] if rec and out["is_alert_worthy"] else None
    correlation = raw.get("cross_disease_correlation")
    out["cross_disease_correlation"] = str(correlation)[:1500] if correlation and out["is_alert_worthy"] else None
    return out


def _format_weather_block(weather: dict | None) -> str:
    if not weather:
        return ""
    return (
        f"\nCurrent real weather data for {weather.get('location_used')}: "
        f"temperature {weather.get('temperature_c')}°C, humidity {weather.get('humidity_pct')}%, "
        f"rainfall today {weather.get('rainfall_today_mm')}mm, rainfall over the past 7 days "
        f"{weather.get('rainfall_7day_mm')}mm. Assessment: {weather.get('note')}.\n"
    )


def extract(post: dict, weather: dict | None = None) -> dict:
    """post: {title, content_text, source_label, ...} from news_scraper.
    weather: optional dict from weather.get_weather_context(), folded into
    the prompt so cross_disease_correlation can cite real current
    conditions for weather-sensitive diseases. Returns a dict matching
    FALLBACK's shape (plus a passthrough "weather" key), always -- never
    raises."""
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        log.warning("GROQ_API_KEY not set -- skipping LLM extraction, marking not alert-worthy")
        return dict(FALLBACK, summary="(LLM extraction unavailable -- GROQ_API_KEY not set)", weather=weather)

    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        prompt = EXTRACT_PROMPT.format(
            source_label=post.get("source_label", "Unknown source"),
            title=post.get("title", "")[:300],
            content=post.get("content_text", "")[:4000],
            weather_block=_format_weather_block(weather),
        )
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=1500,
        )
        raw_text = resp.choices[0].message.content.strip()
        if raw_text.startswith("```"):
            lines = raw_text.split("\n")
            raw_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        start, end = raw_text.find("{"), raw_text.rfind("}") + 1
        parsed = json.loads(raw_text[start:end])
        result = _coerce(parsed)
        result["weather"] = weather
        return result
    except Exception as exc:
        log.warning(f"LLM extraction failed for post '{post.get('title', '')[:60]}': {exc}")
        return dict(FALLBACK, summary=f"(LLM extraction failed: {exc})", weather=weather)


PLAN_PROMPT = """\
You are the lead epidemiologist-planner at Nigeria's Federal Ministry of Health.
TODAY'S DATE IS {today}. You are writing a CONSOLIDATED OUTBREAK INTELLIGENCE &
RESPONSE PLAN for a single ongoing outbreak, AS OF TODAY. You have the full
multi-week trajectory below (stitched from consecutive official NCDC situation
reports), the most-affected states, real weather (recent + forward forecast)
for the worst-hit area, and our OWN internal malaria surveillance + forecast
data for those same states.

OUTBREAK: {disease}
Multi-week trajectory (oldest -> newest; "Week N" = epidemiological week of
the year, e.g. Week 23 = early June -- NOT a relative count). Note sitrep data
lags today's date by a few weeks, which is normal for surveillance:
{trajectory}

Most-affected states (latest report): {top_states}
Weather (recent + forward forecast) for worst-affected area: {weather}
{internal_block}
Write a rich, DESCRIPTIVE markdown plan -- NOT a generic disease fact sheet, and
NOT a repeat of one week's numbers. ALWAYS anchor to today's date ({today}).
Use the WHOLE trajectory to reason about direction and momentum. Structure it
with these markdown sections (use `##` headers, bullet lists, and a markdown
table where useful):

## Combined Outlook (as of {today})
THIS IS THE MOST IMPORTANT SECTION. In a flowing, descriptive narrative,
explicitly fuse the THREE data streams into one picture, anchored to today's
date ({today}): (1) what the NEWS/sitrep sources show (the latest outbreak case
numbers and which states), (2) what the WEATHER shows (recent and the forward
7-day rainfall/temperature forecast, and what that means for vector-borne
co-risk), and (3) what OUR OWN forecast data projects for malaria in those same
states over the coming months. Then state HOW THESE CORRELATE -- e.g. "As of
{today}, NCDC sitreps show Lassa fever concentrated in Bauchi and Edo; the
7-day weather forecast shows continued heavy rainfall there; and our own malaria
forecast projects Bauchi rising from ~62,000 to ~115,000 cases/month into the
high-transmission season -- so these states face a compounding, fever-dominated
caseload from BOTH diseases at once, which is how the combined risk picture
looks." Use the real numbers provided. This synthesis is the whole point.

## Situation Assessment
Interpret the trajectory: is the outbreak accelerating, plateauing, or
declining? Cite the actual week-over-week numbers and the CFR trend. State what
the momentum implies for the next 2-4 weeks FROM TODAY ({today}).

## Priority States & Resource Allocation
Using the most-affected states, recommend a concrete, RANKED allocation of
response resources (case-management teams, lab/diagnostic capacity, ribavirin
or disease-appropriate therapeutics, isolation beds). Be specific about which
states get priority and why, grounded in the numbers.

## Cross-Disease Health-System Load
Explain how this outbreak interacts with OTHER diseases in the SAME states --
diagnostic confusion (shared symptoms), competition for the same health-system
capacity, and (if weather indicates) weather-driven co-risks like malaria. If
"OUR INTERNAL SURVEILLANCE DATA" is provided above, you MUST cite those
specific real malaria caseload numbers per state and reason about the combined
burden (e.g. "Edo is fighting a Lassa surge on top of ~38,000 confirmed malaria
cases/month per our data -- both fever-presenting, both drawing on the same
diagnostic capacity"). Name the affected states explicitly.

## Recommended Interventions (Sequenced)
A sequenced, time-phased intervention plan (immediate / 2-week / 6-week),
specific to this disease and this trajectory.

## Monitoring & Triggers
Define concrete numeric triggers that would escalate or de-escalate the
response (e.g. "if weekly confirmed cases exceed X or CFR rises above Y%").

Be specific and numeric throughout, grounded in the trajectory provided. Never
invent figures not derivable from the data above. Aim for a substantial,
decision-ready brief, not a short summary."""


SIGNAL_PROMPT = """\
You are the lead epidemiologist-planner at Nigeria's Federal Ministry of Health.
TODAY IS {today}. A credible Nigerian health-news source has published the report
below. It is an EARLY NEWS SIGNAL (a single article), NOT a confirmed weekly
situation report -- so frame the brief as "verify, then act", never as settled
surveillance data.

DISEASE: {disease}
LOCATION: {location}
SOURCE: {source}
REPORT DATE: {published}
WHAT THE REPORT SAYS: {summary}
{internal_block}{weather_block}
Write a SHORT, decision-ready markdown brief with EXACTLY these three sections:

## What we know
2-3 sentences on the reported situation. Cite any SPECIFIC figures actually
stated (cases, deaths, affected areas). Never invent a number.

## Why it matters
2-3 sentences on the public-health significance for Nigeria as of {today} --
including any cross-disease or weather interaction that is genuinely relevant
(e.g. a fever-presenting disease complicating malaria diagnosis, heavy rainfall
raising vector/water-borne risk). If our internal malaria data is given above,
reference it concretely.

## Recommended early actions
3-4 concrete, PROPORTIONATE bullets for FMOH/state officials appropriate to an
unconfirmed early signal -- e.g. verification with the state epidemiologist,
heightened surveillance, RDT/lab confirmation, commodity pre-positioning.

Keep the WHOLE brief under 190 words. Be specific; never fabricate figures."""


def generate_signal_brief(disease: str, location: str, summary: str, source: str,
                          published: str, weather_text: str = "", internal_text: str = "",
                          today: str | None = None) -> str | None:
    """Concise 3-section brief for a single NEWS-ARTICLE signal (no multi-week
    epi trajectory). Keeps journalism-sourced cards complete and decision-ready
    instead of an empty KPI shell. Returns None on failure."""
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        return None
    from datetime import date
    today = today or date.today().isoformat()
    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        weather_block = (f"CURRENT WEATHER ({location or 'Nigeria'}): {weather_text}\n") if weather_text else ""
        internal_block = ("OUR INTERNAL MALARIA DATA: " + internal_text + "\n") if internal_text else ""
        prompt = SIGNAL_PROMPT.format(
            today=today, disease=disease, location=location or "Nigeria (not specified)",
            source=source or "health news source", published=published or "recent",
            summary=summary or "(no summary available)",
            internal_block=internal_block, weather_block=weather_block,
        )
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=900,
        )
        return resp.choices[0].message.content.strip()
    except Exception as exc:
        log.warning(f"Signal brief generation failed for '{disease}': {exc}")
        return None


def generate_outbreak_plan(disease: str, trajectory_text: str, top_states: str,
                           weather_text: str, internal_text: str = "",
                           today: str | None = None) -> str | None:
    """One richer LLM call per consolidated outbreak (not per weekly report),
    producing the descriptive, data-grounded planning brief shown on the
    Outbreak Intelligence card. internal_text (from internal_data.py) folds
    OUR own per-state surveillance+forecast figures into the brief; `today`
    anchors the whole analysis to the current date so it reads as a live,
    as-of-today situational synthesis. Returns None on failure (card still
    renders the chart + trajectory without it)."""
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        return None
    from datetime import date
    today = today or date.today().isoformat()
    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        internal_block = ("\n" + internal_text + "\n") if internal_text else ""
        prompt = PLAN_PROMPT.format(
            today=today, disease=disease, trajectory=trajectory_text,
            top_states=top_states or "not specified", weather=weather_text or "not available",
            internal_block=internal_block,
        )
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",  # bigger model for the marquee planning brief
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=2200,
        )
        return resp.choices[0].message.content.strip()
    except Exception as exc:
        log.warning(f"Outbreak plan generation failed for '{disease}': {exc}")
        return None
