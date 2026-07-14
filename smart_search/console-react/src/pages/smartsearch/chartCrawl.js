// Crawl logic for extracting chart/visual titles out of an embedded PowerBI
// report, in the browser, via the powerbi-client SDK. Same technique as the
// old system's reportSearchIndexCrawl.js (report.getPages() ->
// page.setActive() -> page.getVisuals()) -- reused as a documented working
// pattern, but this is a fresh, standalone copy for the new smart-search
// chart-metadata layer, not an import of the old file.

const PAGE_RENDER_WAIT_MS = 500;
const EXCLUDED_VISUAL_TYPES = ["slicer", "shape", "image", "actionButton", "pageNavigator", "bookmarkNavigator"];

function normalizeTitle(value) {
  return String(value || "").replace(/[​-‍﻿­]/g, "").replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveVisualTitle(visual) {
  let title = visual.title || "";
  if (!normalizeTitle(title)) {
    try {
      const property = await visual.getProperty({ objectName: "title", propertyName: "titleText" });
      if (property?.value) title = String(property.value);
    } catch {
      // titleText not available for this visual type -- leave title blank
    }
  }
  return title;
}

// Walks every page/visual of an already-embedded report and returns flat
// rows ready for /search/chart-metadata/ingest.
export async function crawlChartMetadata(report, { reportId, dashboard }) {
  const pages = await report.getPages();
  const activePageBefore = pages.find((p) => p.isActive) || pages[0];
  const entries = [];

  for (const page of pages) {
    await page.setActive();
    await wait(PAGE_RENDER_WAIT_MS);

    const visuals = await page.getVisuals();
    for (const visual of visuals) {
      if (EXCLUDED_VISUAL_TYPES.includes(visual.type)) continue;
      const title = normalizeTitle(await resolveVisualTitle(visual));
      if (!title) continue;
      entries.push({
        report_id: reportId,
        dashboard,
        page_name: page.name,
        page_display_name: page.displayName,
        visual_name: visual.name,
        chart_title: title,
        chart_type: visual.type,
      });
    }
  }

  if (activePageBefore) {
    try {
      await activePageBefore.setActive();
    } catch {
      // restoring the prior page is best-effort
    }
  }

  return entries;
}
