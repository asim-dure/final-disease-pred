// Client for the new search-orchestrator backend (odc_new_ui/search_orchestrator,
// FastAPI + Groq llama-3.3-70b-versatile). Separate from ewsApi.js's backend and
// from the old dashboardSearchRegistry/reportSearchIndex* system used by
// SearchEngine.js -- this talks to a standalone service, default port 8600.
const BACKEND =
  process.env.REACT_APP_SEARCH_ORCHESTRATOR_URL || "http://localhost:8600";

async function postJson(path, payload, timeoutMs) {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // ignore -- fall back to plain status text
    }
    throw new Error(detail);
  }
  return res.json();
}

export function orchestrateSearch(query, context = "") {
  return postJson("/search/orchestrate", { query, context }, 20000);
}

// Fetches a fresh, short-lived PowerBI embed token for a matched dashboard.
// Credentials (client id/secret, tenant, workspace) stay server-side in
// search_orchestrator -- only the embedUrl + View-scoped embed token (which
// expires) ever reach the browser.
export function getEmbedToken(reportId) {
  return postJson("/search/embed-token", { report_id: reportId }, 15000);
}

// Chart-metadata crawler (ChartCrawler.js) -- builds the chart-level layer
// of the search catalog by walking each dashboard's real pages/visuals in a
// live embedded PowerBI session, one dashboard at a time.
export async function getCrawlableDashboards() {
  const res = await fetch(`${BACKEND}/search/crawlable-dashboards`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.dashboards || [];
}

export function ingestChartMetadata(entries) {
  return postJson("/search/chart-metadata/ingest", { entries }, 20000);
}

// A real rendered-image preview of the matched dashboard/page (PowerBI's own
// ExportTo API, PNG, cached server-side) -- not a text description. Used as
// an <img src=...> directly; the backend handles auth + caching.
// "Create your own chart" -- NL -> structured spec (may need a human pick
// between several indicators) -> data for an ECharts React chart.
export function interpretChart(query, context = "", lastSpec = null) {
  return postJson("/create/interpret", { query, context, last_spec: lastSpec }, 30000);
}

// First plot of an indicator scans a 24M-row fact table (~20s, no index on
// the warehouse we can't alter); results are cached server-side after, so
// give the first call generous headroom.
export function runChart(spec) {
  return postJson("/create/run", { spec }, 75000);
}

export function thumbnailUrl(reportId, pageName, visualName) {
  const params = new URLSearchParams();
  if (pageName) params.set("page", pageName);
  if (visualName) params.set("visual", visualName);
  const qs = params.toString();
  return `${BACKEND}/search/thumbnail/${encodeURIComponent(reportId)}${qs ? `?${qs}` : ""}`;
}
