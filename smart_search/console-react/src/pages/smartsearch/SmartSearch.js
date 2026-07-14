import React, { useEffect, useRef, useState } from "react";
import { Input, Button, Card, Spin, Tag, Alert, Typography } from "antd";
import { SearchOutlined, BarChartOutlined, ExpandOutlined, CompressOutlined, CloseOutlined, PlusOutlined, LineChartOutlined } from "@ant-design/icons";
import { models } from "powerbi-client";
import { PowerBIEmbed } from "powerbi-client-react";
import { orchestrateSearch, getEmbedToken, thumbnailUrl, interpretChart, runChart } from "./smartSearchApi";
import ChartRenderer from "./ChartRenderer";
import "./SmartSearch.scss";

const { Text } = Typography;

// Real rendered-image preview of a match (PowerBI ExportTo PNG of the page it
// lives on, cached server-side) -- not a text blurb. Shows a spinner while
// the first render generates, falls back to a chart icon if it fails.
function MatchThumbnail({ match }) {
  const [status, setStatus] = useState("loading");
  if (!match.report_id) {
    return (
      <div className="smart-search-thumb smart-search-thumb-fallback">
        <BarChartOutlined />
      </div>
    );
  }
  return (
    <div className="smart-search-thumb">
      {status !== "loaded" && (
        <div className="smart-search-thumb-fallback">
          {status === "loading" ? <Spin size="small" /> : <BarChartOutlined />}
        </div>
      )}
      <img
        src={thumbnailUrl(match.report_id, match.page_name, match.visual_name)}
        alt={match.chart_title || match.report_heading || match.dashboard || "Chart preview"}
        style={{ display: status === "loaded" ? "block" : "none" }}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
      />
    </div>
  );
}

// Natural-language chart search, powered by the search_orchestrator backend
// (Groq llama-3.3-70b-versatile over a dashboard/page/chart catalog).
// Separate from the old SearchEngine.js keyword search (still at /search).
//
// The orchestrator returns up to 6 ranked options; they render as preview
// cards and the user picks one. The chosen match opens in an overlay panel
// that embeds the real content via PowerBIEmbed -- a single visual for a
// chart-level match, the specific page for a page-level match, or the whole
// dashboard otherwise -- with a maximize toggle.
const SmartSearch = () => {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState([]);
  const [activeMatch, setActiveMatch] = useState(null); // the match being embedded, or null
  const [overlayChart, setOverlayChart] = useState(null); // a created chart shown maximized, or null
  const [maximized, setMaximized] = useState(false);
  const [embedConfig, setEmbedConfig] = useState(null);
  const [embedError, setEmbedError] = useState(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const logRef = useRef(null);
  // Last successfully built chart spec this session -- lets a follow-up like
  // "now by state" reuse the same indicator. Ref so async callbacks see the
  // latest value. Cleared on reload (session-only memory).
  const lastSpecRef = useRef(null);

  const updateTurn = (id, patch) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // 3+1 context window: the last 3 turns verbatim + a one-line summary of
  // everything older, so the orchestrator/agent can resolve follow-ups.
  const buildContext = (allTurns) => {
    const describe = (t) => {
      let a = "…";
      if (t.create?.status === "done") a = `built chart of "${t.create.chart.indicator_name}" by ${t.create.chart.x_label}`;
      else if (t.result?.available) a = `found: ${t.result.matches.slice(0, 2).map((m) => m.chart_title || m.dashboard).join(", ")}`;
      else if (t.result && !t.result.available) a = "no match found";
      return `Q: ${t.query} -> ${a}`;
    };
    const recent = allTurns.slice(-3);
    const older = allTurns.slice(0, -3);
    let ctx = "";
    if (older.length) {
      ctx += `Earlier this session the user asked about: ${older.map((t) => t.query).join("; ")}.\n`;
    }
    ctx += recent.map(describe).join("\n");
    return ctx.trim();
  };

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [turns, loading]);

  // ── "Create your own chart" flow ──────────────────────────────
  const startCreate = async (turn) => {
    updateTurn(turn.id, { create: { status: "loading" } });
    try {
      const res = await interpretChart(turn.query, buildContext(turns), lastSpecRef.current);
      if (res.status === "ready") {
        updateTurn(turn.id, { create: { status: "building", spec: res.spec } });
        buildChart(turn.id, res.spec);
      } else {
        updateTurn(turn.id, { create: res }); // not_possible OR needs_indicator
      }
    } catch (e) {
      updateTurn(turn.id, { create: { status: "error", message: `Couldn't build that (${e.message}).` } });
    }
  };

  const pickIndicator = (turn, candidate) => {
    const spec = { ...turn.create.spec, indicator_key: candidate.indicator_key, indicator_name: candidate.indicator_name };
    updateTurn(turn.id, { create: { status: "building", spec } });
    buildChart(turn.id, spec);
  };

  const buildChart = async (turnId, spec) => {
    try {
      const res = await runChart(spec);
      if (res.possible) {
        lastSpecRef.current = spec; // remember for follow-ups ("now by state")
        updateTurn(turnId, { create: { status: "done", spec, chart: res } });
      } else {
        updateTurn(turnId, { create: { status: "not_possible", message: res.message, spec } });
      }
    } catch (e) {
      updateTurn(turnId, { create: { status: "error", message: `Couldn't build that (${e.message}).` } });
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q || loading) return;
    setQuery("");
    setLoading(true);
    const turnId = Date.now();
    const ctx = buildContext(turns);
    setTurns((prev) => [...prev, { id: turnId, query: q, result: null, error: null }]);
    try {
      const data = await orchestrateSearch(q, ctx);
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, result: data } : t)));
    } catch (e) {
      const message =
        e.message === "GROQ_API_KEY not set in .env"
          ? "Smart search isn't configured yet -- the orchestrator is missing its Groq API key."
          : `Smart search is not available right now (${e.message}).`;
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: message } : t)));
    } finally {
      setLoading(false);
    }
  };

  const closeOverlay = () => {
    setActiveMatch(null);
    setOverlayChart(null);
    setMaximized(false);
    setEmbedConfig(null);
    setEmbedError(null);
  };

  const openMatch = async (match) => {
    setActiveMatch(match);
    setMaximized(false);
    setEmbedConfig(null);
    setEmbedError(null);
    if (!match.report_id) {
      setEmbedError("This item has no report_id on file, so it can't be embedded.");
      return;
    }
    setEmbedLoading(true);
    try {
      const token = await getEmbedToken(match.report_id);
      const base = {
        id: token.report_id,
        embedUrl: token.embed_url,
        accessToken: token.access_token,
        tokenType: models.TokenType.Embed,
        settings: { filterPaneEnabled: false, navContentPaneEnabled: false },
      };
      if (match.visual_name && match.page_name) {
        // Chart-level match -> embed ONLY that one visual, full-frame.
        setEmbedConfig({ ...base, type: "visual", pageName: match.page_name, visualName: match.visual_name });
      } else if (match.page_name) {
        // Page-level match -> open the report straight to that page.
        setEmbedConfig({ ...base, type: "report", pageName: match.page_name });
      } else {
        // Dashboard-level match -> whole report, default page.
        setEmbedConfig({ ...base, type: "report" });
      }
    } catch (e) {
      setEmbedError(`Couldn't embed this (${e.message}).`);
    } finally {
      setEmbedLoading(false);
    }
  };

  const activeTitle = activeMatch
    ? `${activeMatch.dashboard || activeMatch.report_name || ""}${
        activeMatch.chart_title
          ? ` — ${activeMatch.chart_title}`
          : activeMatch.page_display_name
          ? ` — ${activeMatch.page_display_name}`
          : ""
      }`
    : "";

  return (
    <div className="smart-search-page">
      <div className="smart-search-topbar">
        <div className="smart-search-topbar-avatar">
          <BarChartOutlined />
        </div>
        <div className="smart-search-topbar-text">
          <div className="smart-search-topbar-title">Smart Search</div>
          <div className="smart-search-topbar-sub">Ask for any dashboard or chart in plain language</div>
        </div>
      </div>

      <div className="smart-search-log" ref={logRef}>
        {turns.length === 0 && !loading && (
          <div className="smart-search-empty-state">
            <div className="smart-search-empty-icon"><BarChartOutlined /></div>
            <div className="smart-search-empty-title">What chart are you looking for?</div>
            <div className="smart-search-empty-sub">
              Try “show me age wise distribution of HIV in male and female” or “malaria RDT/microscopy”.
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="smart-search-turn">
            {/* User message -- right aligned bubble */}
            <div className="smart-search-row is-user">
              <div className="smart-search-bubble is-user">{turn.query}</div>
            </div>

            {/* Bot response -- left aligned with avatar */}
            <div className="smart-search-row is-bot">
              <div className="smart-search-avatar"><BarChartOutlined /></div>
              <div className="smart-search-bot-content">
                {turn.result === null && !turn.error && (
                  <div className="smart-search-bubble is-bot smart-search-typing">
                    <Spin size="small" /> <span>Searching the dashboards…</span>
                  </div>
                )}

                {turn.error && (
                  <div className="smart-search-bubble is-bot">
                    <Alert type="error" showIcon message={turn.error} />
                  </div>
                )}

                {turn.result && !turn.result.available && (
                  <div className="smart-search-bubble is-bot">
                    {turn.result.message || "Not available — no matching chart was found."}
                  </div>
                )}

                {/* Once the user chooses to build their own chart, the old
                    PowerBI matches are no longer the focus -- hide them so
                    only the generated chart shows. */}
                {turn.result && turn.result.available && !turn.create && (
                  <>
                    <div className="smart-search-bubble is-bot">
                      Found <b>{turn.result.matches.length}</b>{" "}
                      {turn.result.matches.length === 1 ? "match" : "matches"} — pick one to open it.
                    </div>
                    <div className="smart-search-match-grid">
                      {turn.result.matches.map((match, i) => (
                        <Card
                          key={i}
                          hoverable
                          onClick={() => openMatch(match)}
                          className="smart-search-match-card"
                        >
                          <MatchThumbnail match={match} />
                          <div className="smart-search-match-body">
                            <div className="smart-search-match-title">
                              {match.chart_title || match.report_heading || match.report_name || match.dashboard}
                            </div>
                            <div className="smart-search-match-meta">
                              {match.level === "chart" && <Tag color="purple">Chart</Tag>}
                              {match.level === "page" && <Tag color="cyan">Page</Tag>}
                              {match.level === "dashboard" && <Tag color="geekblue">Dashboard</Tag>}
                              {match.dashboard && <Tag>{match.dashboard}</Tag>}
                              {match.page_display_name && match.level !== "page" && <Tag>{match.page_display_name}</Tag>}
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </>
                )}

                {/* Create-your-own-chart affordance + flow (shown once a
                    result is back; prominent when nothing was found). */}
                {turn.result && !turn.create && (
                  <div className="smart-search-create-cta">
                    {!turn.result.available && (
                      <span className="smart-search-create-hint">
                        Not what you wanted? Build it from the live data instead —
                      </span>
                    )}
                    <Button
                      className="smart-search-create-btn"
                      icon={<PlusOutlined />}
                      onClick={() => startCreate(turn)}
                    >
                      Create your own chart
                    </Button>
                    <span className="smart-search-create-or">or just ask another question below.</span>
                  </div>
                )}

                {turn.create && (
                  <div className="smart-search-create-flow">
                    {turn.create.status === "loading" && (
                      <div className="smart-search-bubble is-bot smart-search-typing">
                        <Spin size="small" /> <span>Working out how to build that…</span>
                      </div>
                    )}

                    {turn.create.status === "building" && (
                      <div className="smart-search-bubble is-bot smart-search-typing">
                        <Spin size="small" /> <span>Querying the warehouse… (first build can take ~20s)</span>
                      </div>
                    )}

                    {(turn.create.status === "not_possible" || turn.create.status === "error") && (
                      <div className="smart-search-bubble is-bot">{turn.create.message}</div>
                    )}

                    {turn.create.status === "needs_indicator" && (
                      <>
                        <div className="smart-search-bubble is-bot">
                          “<b>{turn.create.spec.search_terms.join(" ")}</b>” matches several indicators — which one do you mean?
                        </div>
                        <div className="smart-search-indicator-list">
                          {turn.create.candidates.map((cand) => (
                            <button
                              key={cand.indicator_key}
                              className="smart-search-indicator-chip"
                              onClick={() => pickIndicator(turn, cand)}
                            >
                              {cand.indicator_name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {turn.create.status === "done" && (
                      <div className="smart-search-chartbox">
                        <div className="smart-search-chartbox-toolbar">
                          <div className="smart-search-chartbox-heading">
                            <div className="smart-search-chartbox-title">
                              <LineChartOutlined /> {turn.create.chart.title}
                            </div>
                            <div className="smart-search-chartbox-sub">
                              {turn.create.chart.indicator_name} · by {turn.create.chart.x_label} · {turn.create.chart.chart_type} chart
                            </div>
                          </div>
                          <Button
                            size="small"
                            type="text"
                            icon={<ExpandOutlined />}
                            onClick={() => setOverlayChart(turn.create.chart)}
                          >
                            Maximize
                          </Button>
                        </div>
                        <div className="smart-search-chartbox-body">
                          <ChartRenderer chart={turn.create.chart} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="smart-search-bar">
        <div className="smart-search-inputwrap">
          <Input
            size="large"
            bordered={false}
            placeholder="Message Smart Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={runSearch}
            disabled={loading}
            className="smart-search-input"
          />
          <Button
            type="primary"
            shape="circle"
            size="large"
            icon={<SearchOutlined />}
            onClick={runSearch}
            loading={loading}
            disabled={!query.trim()}
            className="smart-search-send"
          />
        </div>
      </div>

      {activeMatch && (
        <div className="smart-search-overlay" onClick={closeOverlay}>
          <div
            className={`smart-search-overlay-panel ${maximized ? "is-maximized" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="smart-search-overlay-toolbar">
              <span className="smart-search-overlay-title">{activeTitle}</span>
              <div className="smart-search-overlay-actions">
                <Button
                  size="small"
                  type="text"
                  icon={maximized ? <CompressOutlined /> : <ExpandOutlined />}
                  onClick={() => setMaximized((m) => !m)}
                >
                  {maximized ? "Minimize" : "Maximize"}
                </Button>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={closeOverlay} />
              </div>
            </div>
            <div className="smart-search-overlay-body">
              {embedLoading && (
                <div className="smart-search-embed-loading">
                  <Spin /> <Text type="secondary">Loading...</Text>
                </div>
              )}
              {!embedLoading && embedError && <Alert type="error" showIcon message={embedError} />}
              {!embedLoading && !embedError && embedConfig && (
                <PowerBIEmbed embedConfig={embedConfig} cssClassName="smart-search-embed" />
              )}
            </div>
          </div>
        </div>
      )}

      {overlayChart && (
        <div className="smart-search-overlay" onClick={closeOverlay}>
          <div
            className={`smart-search-overlay-panel ${maximized ? "is-maximized" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="smart-search-overlay-toolbar">
              <span className="smart-search-overlay-title">{overlayChart.title}</span>
              <div className="smart-search-overlay-actions">
                <Button
                  size="small"
                  type="text"
                  icon={maximized ? <CompressOutlined /> : <ExpandOutlined />}
                  onClick={() => setMaximized((m) => !m)}
                >
                  {maximized ? "Minimize" : "Maximize"}
                </Button>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={closeOverlay} />
              </div>
            </div>
            <div className="smart-search-overlay-body smart-search-overlay-chart">
              <ChartRenderer chart={overlayChart} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SmartSearch;
