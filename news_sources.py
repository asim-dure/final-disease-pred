"""
Official Nigerian health-programme sources monitored by the autonomous News &
Intervention Alerts pipeline (news_pipeline.py). Single source of truth so a
new source is one dict entry, not a code change elsewhere.

Two source "shapes" exist, dispatched on in news_scraper.py by which key is
present:
  - wp_api_base: fetched via that site's public WordPress REST API
    (`/wp-json/wp/v2/posts`) -- confirmed live for NACA and NMEP. NTBLCP's
    site (ntblcp.org.ng) was confirmed DOWN (hosting suspended) at
    implementation time -- it stays in this list so the pipeline picks it
    back up automatically once the site returns; until then every run logs
    a clear "source unreachable" warning and continues with the other
    sources rather than failing the whole pipeline.
  - sitreps_url: NCDC's disease-situation-report listing page (not
    WordPress, not an API -- the page itself lists downloadable PDF sitreps
    as plain HTML anchors, confirmed live with real, current weekly Lassa
    fever sitreps at implementation time). Scraped via the HTML-anchor
    pattern in news_scraper.fetch_ncdc_sitreps(), not a generic site
    scraper -- this page's structure is NCDC-specific.

ReliefWeb (UN OCHA's humanitarian/health report aggregator API) was
evaluated as a third addition but its public API returned 403/410 from this
environment even on the correct v2 endpoint -- NOT wired in, to avoid
shipping an unverified integration. Revisit if ReliefWeb access is sorted
out (may need a registered appname or IP allowlisting).
"""

SOURCES = [
    {
        "id": "naca",
        "label": "NACA (National Agency for the Control of AIDS)",
        "wp_api_base": "https://naca.gov.ng/wp-json/wp/v2/posts",
        "disease_hint": "hiv",
    },
    {
        "id": "nmep",
        "label": "NMEP (National Malaria Elimination Programme)",
        "wp_api_base": "https://nmcp.gov.ng/wp-json/wp/v2/posts",
        "disease_hint": "malaria",
    },
    {
        "id": "ntblcp",
        "label": "NTBLCP (National Tuberculosis & Leprosy Control Programme)",
        "wp_api_base": "https://ntblcp.org.ng/wp-json/wp/v2/posts",
        "disease_hint": "tb",
    },
    {
        "id": "ncdc",
        "label": "NCDC (Nigeria Centre for Disease Control and Prevention)",
        "sitreps_url": "https://ncdc.gov.ng/diseases/sitreps",
        "disease_hint": None,  # NCDC sitreps cover whichever disease(s) currently have an active outbreak
    },

    # ── Nigerian health journalism (added on the BA's recommendation) ──────────
    # Credible, active health-desk outlets that break outbreak/health-system news
    # the sector actually reads -- they cover ALL diseases and often surface an
    # outbreak (Lassa, cholera, diphtheria, mpox, etc.) days before it lands in a
    # formal sitrep, which is exactly the early-warning edge we want. All three
    # expose the standard WordPress REST API (verified live). The LLM extraction
    # step (news_llm.extract) marks non-alert-worthy/off-topic posts is_alert_
    # worthy=false, so they're stored for audit but never clutter the dashboard.
    {
        "id": "nhw",
        "label": "Nigeria Health Watch",
        "wp_api_base": "https://nigeriahealthwatch.com/wp-json/wp/v2/posts",
        "disease_hint": None,  # dedicated health-journalism org, all diseases
    },
    {
        "id": "punch_health",
        "label": "Punch HealthWise",
        "wp_api_base": "https://healthwise.punchng.com/wp-json/wp/v2/posts",
        "disease_hint": None,  # Punch's dedicated health vertical, all diseases
    },
    {
        "id": "premium_health",
        "label": "Premium Times (Health Desk)",
        "wp_api_base": "https://www.premiumtimesng.com/wp-json/wp/v2/posts",
        # Premium Times is a GENERAL paper; restrict to its Health category
        # (id 45500, verified) so we don't burn LLM calls on politics/sport.
        "wp_params": {"categories": 45500},
        "disease_hint": None,
    },
]
