"""
Per-chart thumbnail generator.

The page-level thumbnails (main.py's /search/thumbnail via PowerBI ExportTo)
show the WHOLE page, which for a chart-level match looks like "the dashboard"
rather than the one chart the user picked. PowerBI has no API to export a
single visual as an image, and cropping a page screenshot by visual layout
coordinates is unreliable (the authored canvas coords don't map cleanly to
the rendered pixels).

So this does it the clean way: it embeds each titled visual ON ITS OWN
(type: "visual" -- the same single-visual embed the UI uses on click) in
headless Chromium and screenshots it. That yields a pixel-perfect image of
just that one chart, no coordinate math. Output:
thumbnails_visual/<report_id>__<visual_name>.png, served by /search/thumbnail
when a visual is requested (falls back to the page image if a crop isn't
there).

    py -3 snap_visuals.py                # every titled chart (slow, ~1-2h)
    py -3 snap_visuals.py <report_id>    # just one report
    py -3 snap_visuals.py --missing      # only charts without an image yet
"""
import os
import sys

from dotenv import load_dotenv

load_dotenv()

import pandas as pd

from metadata import load_dashboard_metadata, get_full_dashboard_row, load_chart_metadata

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POWERBI_JS = os.path.join(BASE_DIR, "..", "console-react", "node_modules", "powerbi-client", "dist", "powerbi.min.js")
VISUAL_THUMB_DIR = os.path.join(BASE_DIR, "thumbnails_visual")
os.makedirs(VISUAL_THUMB_DIR, exist_ok=True)


def thumb_path(report_id, visual_name):
    return os.path.join(VISUAL_THUMB_DIR, f"{report_id}__{visual_name}.png".replace("/", "_"))


def _embed_info(report_id):
    import requests
    row = get_full_dashboard_row(report_id)
    if not row:
        return None
    tenant_id, workspace_id = row.get("tenant_id"), row.get("workspace_id")
    client_id, client_secret = row.get("application_id"), row.get("secret_value")
    if not all([tenant_id, workspace_id, client_id, client_secret, report_id]):
        return None
    tok = requests.post(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/token",
        data={"grant_type": "client_credentials", "resource": "https://analysis.windows.net/powerbi/api",
              "client_id": client_id, "client_secret": client_secret},
        timeout=20,
    )
    tok.raise_for_status()
    access = tok.json()["access_token"]
    h = {"Authorization": f"Bearer {access}"}
    r = requests.get(f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}", headers=h, timeout=20)
    r.raise_for_status()
    embed_url = r.json()["embedUrl"]
    g = requests.post(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}/GenerateToken",
        json={"accessLevel": "View", "allowSaveAs": False}, headers=h, timeout=20,
    )
    g.raise_for_status()
    return embed_url, g.json()["token"]


# Embeds ONE visual full-frame and resolves once it has rendered.
_SINGLE_VISUAL_JS = """
async ([embedUrl, accessToken, reportId, pageName, visualName]) => {
  const models = window['powerbi-client'].models;
  const el = document.getElementById('embed');
  powerbi.reset(el);
  const v = powerbi.embed(el, {
    type: 'visual', embedUrl, accessToken, id: reportId,
    pageName, visualName, tokenType: models.TokenType.Embed,
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('load timeout')), 40000);
    v.on('rendered', () => { clearTimeout(t); resolve(); });
    v.on('error', () => { clearTimeout(t); reject(new Error('embed error')); });
  });
}
"""


def snap_report(pw_page, report_id, charts, skip_existing):
    """charts: list of dicts with page_name, visual_name for this report."""
    info = _embed_info(report_id)
    if not info:
        return 0, "no embed info / missing creds"
    embed_url, token = info
    saved = 0
    for c in charts:
        out = thumb_path(report_id, c["visual_name"])
        if skip_existing and os.path.exists(out):
            continue
        try:
            pw_page.evaluate(_SINGLE_VISUAL_JS, [embed_url, token, report_id, c["page_name"], c["visual_name"]])
            pw_page.wait_for_timeout(900)
            pw_page.locator("#embed").screenshot(path=out)
            saved += 1
        except Exception:
            # A single unrenderable visual shouldn't abort the whole report.
            continue
    return saved, None


def main():
    with open(POWERBI_JS, "r", encoding="utf-8") as f:
        powerbi_js = f.read()

    args = [a for a in sys.argv[1:]]
    skip_existing = "--missing" in args
    only = next((a for a in args if not a.startswith("--")), None)

    charts = [r for r in load_chart_metadata() if r["level"] == "chart" and r.get("visual_name") and r.get("page_name")]
    by_report = {}
    for c in charts:
        by_report.setdefault(c["report_id"], []).append(c)

    dashboards = load_dashboard_metadata()
    order = [d["report_id"] for d in dashboards if d.get("report_id") in by_report]
    if only:
        order = [rid for rid in order if rid == only]

    from playwright.sync_api import sync_playwright

    harness = (f"<!doctype html><html><head><meta charset='utf-8'>"
               f"<style>#embed{{width:900px;height:520px}}</style>"
               f"<script>{powerbi_js}</script></head>"
               f"<body><div id='embed'></div></body></html>")

    total = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pw_page = browser.new_page(viewport={"width": 960, "height": 620}, device_scale_factor=1)
        for i, rid in enumerate(order):
            name = next((d["dashboard"] for d in dashboards if d.get("report_id") == rid), rid)
            print(f"[{i+1}/{len(order)}] {name} ({len(by_report[rid])} charts) ...", end=" ", flush=True)
            try:
                pw_page.set_content(harness, wait_until="load")
                n, err = snap_report(pw_page, rid, by_report[rid], skip_existing)
                print(f"SKIP ({err})" if err else f"{n} images")
                total += n
            except Exception as e:
                print(f"FAIL ({e})")
        browser.close()
    print(f"\nDone. {total} per-chart thumbnail images saved to thumbnails_visual/.")


if __name__ == "__main__":
    main()
