import React, { useState } from "react";
import { Button, Progress, List, Typography, Alert, Tag } from "antd";
import { models } from "powerbi-client";
import { PowerBIEmbed } from "powerbi-client-react";
import { getCrawlableDashboards, getEmbedToken, ingestChartMetadata } from "./smartSearchApi";
import { crawlChartMetadata } from "./chartCrawl";
import "./SmartSearch.scss";

const { Title, Text } = Typography;

// Admin/one-off page: walks every dashboard in dim_dashboard_mapping, embeds
// each one for real (via /search/embed-token), crawls its pages/visuals in
// the browser, and posts the results to /search/chart-metadata/ingest --
// this is what actually populates the chart-level layer of the search
// catalog (chart_metadata.parquet), so specific-chart questions stop
// resolving to "the whole dashboard" by default. Run manually, whenever the
// PowerBI content changes; not on a schedule.
const ChartCrawler = () => {
  const [dashboards, setDashboards] = useState([]);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(0);
  const [log, setLog] = useState([]);
  const [embedConfig, setEmbedConfig] = useState(null);
  const [error, setError] = useState(null);

  const appendLog = (entry) => setLog((prev) => [entry, ...prev].slice(0, 200));

  const start = async () => {
    setError(null);
    setLog([]);
    setCurrent(0);
    setRunning(true);
    try {
      const list = await getCrawlableDashboards();
      setDashboards(list);
      let totalCharts = 0;
      for (let i = 0; i < list.length; i++) {
        setCurrent(i + 1);
        const d = list[i];
        try {
          const token = await getEmbedToken(d.report_id);
          const config = {
            type: "report",
            id: token.report_id,
            embedUrl: token.embed_url,
            accessToken: token.access_token,
            tokenType: models.TokenType.Embed,
            settings: { filterPaneEnabled: false, navContentPaneEnabled: false },
          };
          window.__crawlerReportRef = null;
          window.__crawlerLoaded = false;
          setEmbedConfig(config);

          const report = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("embed timed out")), 25000);
            const check = setInterval(() => {
              if (window.__crawlerLoaded && window.__crawlerReportRef) {
                clearTimeout(timeout);
                clearInterval(check);
                resolve(window.__crawlerReportRef);
              }
            }, 200);
          });

          const entries = await crawlChartMetadata(report, { reportId: d.report_id, dashboard: d.dashboard });
          if (entries.length) {
            await ingestChartMetadata(entries);
            totalCharts += entries.length;
          }
          appendLog({ dashboard: d.dashboard, charts: entries.length, status: "ok" });
        } catch (e) {
          appendLog({ dashboard: d.dashboard, charts: 0, status: "failed", message: e.message });
        }
      }
      appendLog({ dashboard: `Done -- ${totalCharts} chart rows ingested total`, status: "summary" });
    } catch (e) {
      setError(e.message);
    } finally {
      setEmbedConfig(null);
      setRunning(false);
    }
  };

  return (
    <div className="smart-search-page">
      <div className="smart-search-header">
        <Title level={3}>Chart Metadata Crawler</Title>
        <Text type="secondary">
          Walks every dashboard in dim_dashboard_mapping, embeds it, and reads real page/chart titles into
          chart_metadata.parquet so Smart Search can match specific charts, not just whole dashboards.
        </Text>
      </div>

      <div style={{ padding: "12px 4px" }}>
        <Button type="primary" onClick={start} loading={running} disabled={running}>
          {running ? "Crawling..." : "Start crawl"}
        </Button>
        {dashboards.length > 0 && (
          <Progress
            percent={Math.round((current / dashboards.length) * 100)}
            style={{ maxWidth: 400, marginLeft: 16, display: "inline-block" }}
          />
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}

        <List
          style={{ marginTop: 16 }}
          size="small"
          bordered
          dataSource={log}
          renderItem={(item) => (
            <List.Item>
              <span>{item.dashboard}</span>
              {item.status === "ok" && <Tag color="green">{item.charts} charts</Tag>}
              {item.status === "failed" && <Tag color="red">{item.message}</Tag>}
            </List.Item>
          )}
        />
      </div>

      {embedConfig && (
        <div aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 }}>
          <PowerBIEmbed
            embedConfig={embedConfig}
            cssClassName="chart-crawler-hidden-embed"
            eventHandlers={
              new Map([
                [
                  "loaded",
                  () => {
                    window.__crawlerLoaded = true;
                  },
                ],
              ])
            }
            getEmbeddedComponent={(embeddedReport) => {
              window.__crawlerReportRef = embeddedReport;
            }}
          />
        </div>
      )}
    </div>
  );
};

export default ChartCrawler;
