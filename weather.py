"""
Real, free, no-key weather data (Open-Meteo) for the News & Intervention
Alerts pipeline -- lets the LLM ground its cross-disease correlation in
ACTUAL current weather, not a generic assumption. Malaria transmission in
particular is directly weather-driven (mosquito breeding tracks rainfall,
humidity, and temperature), so this matters most for malaria but is passed
generically since other vector-borne/water-borne diseases (dengue, cholera,
yellow fever) are weather-linked too.

Never raises -- weather context is an enhancement, not a hard dependency;
get_weather_context() returns None on any failure and callers must handle
that (omit weather from the prompt rather than fail the whole pipeline run).
"""
import logging

import requests

log = logging.getLogger("weather")

TIMEOUT = 10

# Approximate state-capital coordinates for Nigeria's most outbreak-relevant
# states (covers the states most frequently named in NCDC sitreps / NACA-NMEP
# posts). Falls back to Abuja (national proxy) for an unrecognized or null
# location -- intentionally coarse (state-level, not LGA-level) since that's
# the geographic resolution most alerts actually specify.
STATE_COORDS = {
    "abuja": (9.0765, 7.3986), "fct": (9.0765, 7.3986),
    "lagos": (6.5244, 3.3792), "kano": (12.0022, 8.5920),
    "edo": (6.3350, 5.6037), "ondo": (7.2526, 5.2070),
    "bauchi": (10.3158, 9.8442), "taraba": (8.8833, 11.3617),
    "benue": (7.7322, 8.5391), "ebonyi": (6.2649, 8.0137),
    "kaduna": (10.5222, 7.4383), "rivers": (4.8156, 7.0498),
    "oyo": (7.3775, 3.9470), "borno": (11.8333, 13.1500),
    "katsina": (12.9908, 7.6018), "sokoto": (13.0059, 5.2476),
    "anambra": (6.2209, 6.9370), "enugu": (6.5244, 7.5086),
    "plateau": (9.2182, 9.5179), "niger": (9.6177, 6.5569),
}
NATIONAL_DEFAULT = (9.0765, 7.3986)  # Abuja, used as a Nigeria-wide proxy


def guess_location_from_text(text: str) -> str | None:
    """Cheap local heuristic (no LLM call) to spot a known Nigerian state
    name in raw post text, so weather can be fetched for a relevant
    location BEFORE the LLM extraction step runs (avoiding a second LLM
    round-trip just to learn the location first)."""
    if not text:
        return None
    lower = text.lower()
    for name in STATE_COORDS:
        if name in ("fct",):  # too short/ambiguous to substring-match safely
            continue
        if name in lower:
            return name.title()
    return None


def _resolve_coords(location: str | None) -> tuple[float, float]:
    if not location:
        return NATIONAL_DEFAULT
    key = location.strip().lower()
    for name, coords in STATE_COORDS.items():
        if name in key:
            return coords
    return NATIONAL_DEFAULT


def get_weather_context(location: str | None = None) -> dict | None:
    """Returns {location_used, temperature_c, humidity_pct,
    rainfall_today_mm, rainfall_7day_mm, note} or None on failure. `note`
    flags conditions known to favor mosquito breeding / disease spread, so
    the LLM prompt doesn't have to re-derive that threshold logic itself."""
    lat, lon = _resolve_coords(location)
    try:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,precipitation",
                "daily": "precipitation_sum",
                "past_days": 7, "forecast_days": 7,
                "timezone": "Africa/Lagos",
            },
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        from datetime import date
        current = data.get("current", {})
        daily = data.get("daily", {})
        times = daily.get("time", [])
        precips = daily.get("precipitation_sum", [])
        today = date.today().isoformat()
        # Split the daily series into past (<= today) and forecast (> today),
        # so the brief can contrast recent rainfall with the FORWARD outlook.
        past_rain = sum(p for t, p in zip(times, precips) if p is not None and t <= today)
        fcst_rain = sum(p for t, p in zip(times, precips) if p is not None and t > today)
        temp = current.get("temperature_2m")
        humidity = current.get("relative_humidity_2m")
        rain_today = current.get("precipitation")

        notes = []
        if past_rain and past_rain > 20:
            notes.append("recent 7-day rainfall is elevated -- conditions favor mosquito breeding (malaria) and may increase flood/water contamination risk (cholera)")
        if fcst_rain and fcst_rain > 20:
            notes.append(f"the 7-day rainfall FORECAST (~{round(fcst_rain)}mm) points to continued/increasing mosquito-breeding conditions in the days ahead")
        if temp is not None and 20 <= temp <= 30:
            notes.append("temperature is in the optimal range for malaria parasite development in mosquitoes")
        if humidity is not None and humidity > 60:
            notes.append("high humidity further supports mosquito survival/breeding")

        return {
            "location_used": location or "Nigeria (national proxy)",
            "as_of": today,
            "temperature_c": temp,
            "humidity_pct": humidity,
            "rainfall_today_mm": rain_today,
            "rainfall_7day_mm": round(past_rain, 1) if past_rain is not None else None,
            "rainfall_forecast_7day_mm": round(fcst_rain, 1) if fcst_rain is not None else None,
            "note": "; ".join(notes) if notes else "no strong weather-driven disease signal detected",
        }
    except Exception as e:
        log.warning(f"Weather fetch failed for location={location!r}: {e}")
        return None
