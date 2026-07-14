"""
Headless server-side crawler for CHART/VISUAL titles.

PowerBI's REST API can list a report's pages but NOT the visuals inside them
-- visual titles are only reachable through the powerbi-client JavaScript
SDK running against a live embedded report in a real browser. This script is
that browser: it drives headless Chromium (Playwright), embeds each dashboard
with a real embed token, walks every page's visuals via the SDK
(getPages -> getVisuals -> title/getProperty), and writes one row per visual
into chart_metadata.parquet.

Run it directly (no frontend needed):
    py -3 crawl_visuals.py                # all dashboards
    py -3 crawl_visuals.py <report_id>    # just one

The FastAPI service (main.py) can be running or not -- this talks to the DB
and PowerBI directly, then the running service picks up the new rows on its
next /search/refresh (or restart).
"""
import os
import sys
import json
import time

from dotenv import load_dotenv

load_dotenv()

from metadata import load_dashboard_metadata, get_full_dashboard_row, append_chart_metadata

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POWERBI_JS = os.path.join(
    BASE_DIR, "..", "console-react", "node_modules", "powerbi-client", "dist", "powerbi.min.js"
)

EXCLUDED_VISUAL_TYPES = {"slicer", "shape", "image", "actionButton", "pageNavigator", "bookmarkNavigator"}


def _service_token(tenant_id, client_id, client_secret):
    import requests
    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "resource": "https://analysis.windows.net/powerbi/api",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _embed_info(report_id):
    """Returns (embed_url, embed_token) for one report, using the same 3-step
    flow as main.py's /search/embed-token."""
    import requests
    row = get_full_dashboard_row(report_id)
    if not row:
        return None
    tenant_id, workspace_id = row.get("tenant_id"), row.get("workspace_id")
    client_id, client_secret = row.get("application_id"), row.get("secret_value")
    if not all([tenant_id, workspace_id, client_id, client_secret, report_id]):
        return None
    access = _service_token(tenant_id, client_id, client_secret)
    headers = {"Authorization": f"Bearer {access}"}
    r = requests.get(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}",
        headers=headers, timeout=20,
    )
    r.raise_for_status()
    embed_url = r.json()["embedUrl"]
    g = requests.post(
        f"https://api.powerbi.com/v1.0/myorg/groups/{workspace_id}/reports/{report_id}/GenerateToken",
        json={"accessLevel": "View", "allowSaveAs": False},
        headers=headers, timeout=20,
    )
    g.raise_for_status()
    return embed_url, g.json()["token"]


# Runs inside the browser: embeds the report, walks pages/visuals, returns
# flat entries. Mirrors console-react's chartCrawl.js so both crawlers agree.
_BROWSER_CRAWL_JS = """
async ([embedUrl, accessToken, reportId]) => {
  const EXCLUDED = ["slicer","shape","image","actionButton","pageNavigator","bookmarkNavigator"];
  const models = window['powerbi-client'].models;
  const el = document.getElementById('embed');
  const report = powerbi.embed(el, {
    type: 'report',
    embedUrl,
    accessToken,
    id: reportId,
    tokenType: models.TokenType.Embed,
    settings: { filterPaneEnabled: false, navContentPaneEnabled: false },
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('load timeout')), 45000);
    report.on('loaded', () => { clearTimeout(t); resolve(); });
    report.on('error', (e) => { clearTimeout(t); reject(new Error('embed error')); });
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const pages = await report.getPages();
  for (const page of pages) {
    try { await page.setActive(); } catch (e) { continue; }
    await wait(600);
    let visuals = [];
    try { visuals = await page.getVisuals(); } catch (e) { continue; }
    for (const v of visuals) {
      if (EXCLUDED.includes(v.type)) continue;
      let title = norm(v.title);
      if (!title) {
        try {
          const p = await v.getProperty({ objectName: 'title', propertyName: 'titleText' });
          if (p && p.value) title = norm(p.value);
        } catch (e) {}
      }
      if (!title) continue;
      out.push({
        page_name: page.name,
        page_display_name: page.displayName,
        visual_name: v.name,
        chart_title: title,
        chart_type: v.type,
      });
    }
  }
  return out;
}
"""


def crawl_report(page, report_id, dashboard_name):
    info = _embed_info(report_id)
    if not info:
        return [], "no embed info / missing creds"
    embed_url, token = info
    try:
        raw = page.evaluate(_BROWSER_CRAWL_JS, [embed_url, token, report_id])
    except Exception as e:
        return [], f"browser crawl failed: {e}"
    entries = []
    for r in raw:
        entries.append({
            "report_id": report_id,
            "dashboard": dashboard_name,
            "page_name": r["page_name"],
            "page_display_name": r["page_display_name"],
            "visual_name": r["visual_name"],
            "chart_title": r["chart_title"],
            "chart_type": r["chart_type"],
        })
    return entries, None


def main():
    if not os.path.exists(POWERBI_JS):
        print(f"ERROR: powerbi-client bundle not found at {POWERBI_JS}")
        sys.exit(1)
    with open(POWERBI_JS, "r", encoding="utf-8") as f:
        powerbi_js = f.read()

    only = sys.argv[1] if len(sys.argv) > 1 else None
    dashboards = load_dashboard_metadata()
    if only:
        dashboards = [d for d in dashboards if d.get("report_id") == only]

    from playwright.sync_api import sync_playwright

    harness = f"<!doctype html><html><head><meta charset='utf-8'>" \
              f"<style>#embed{{width:1280px;height:800px}}</style>" \
              f"<script>{powerbi_js}</script></head>" \
              f"<body><div id='embed'></div></body></html>"

    total = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1366, "height": 900})
        for i, d in enumerate(dashboards):
            rid = d.get("report_id")
            name = d.get("dashboard")
            if not rid:
                continue
            print(f"[{i+1}/{len(dashboards)}] {name} ...", end=" ", flush=True)
            try:
                page.set_content(harness, wait_until="load")
                entries, err = crawl_report(page, rid, name)
                if err:
                    print(f"SKIP ({err})")
                    continue
                if entries:
                    append_chart_metadata(entries)
                    total += len(entries)
                print(f"{len(entries)} visuals")
            except Exception as e:
                print(f"FAIL ({e})")
        browser.close()

    print(f"\nDone. {total} visual rows ingested into chart_metadata.parquet.")


if __name__ == "__main__":
    main()
