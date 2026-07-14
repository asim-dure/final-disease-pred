import React from "react";
import ReactECharts from "echarts-for-react";

// Renders a "create your own" chart with ECharts (React). Supported types:
// line (default -- a glowing white line), bar, pie, bubble, histogram.
// Styled to match the dark/teal Smart Search theme.
const TEAL = "#2dd4bf";
const AXIS = "#a6b2c2";
const GRID = "rgba(255,255,255,0.08)";

function buildOption({ chart_type, title, x_label, y_label, data, indicator_name }) {
  const cats = data.map((d) => d[0]);
  const vals = data.map((d) => d[1]);
  const seriesName = indicator_name || title || "Value";

  // No in-chart title -- the surrounding chart box / overlay supplies the
  // heading, so the plot gets the full height.
  const base = {
    backgroundColor: "transparent",
    tooltip: { trigger: chart_type === "pie" ? "item" : "axis" },
    legend: {
      show: true,
      bottom: 4,
      textStyle: { color: AXIS, fontWeight: 600 },
      data: [seriesName],
    },
    grid: { left: 56, right: 28, top: 24, bottom: 48, containLabel: true },
  };

  if (chart_type === "pie") {
    return {
      ...base,
      legend: { show: true, bottom: 4, textStyle: { color: AXIS, fontWeight: 600 } },
      series: [
        {
          name: seriesName,
          type: "pie",
          radius: ["38%", "66%"],
          center: ["50%", "52%"],
          data: data.map((d) => ({ name: d[0], value: d[1] })),
          label: { color: "#eef3f8", fontWeight: 600 },
          itemStyle: { borderColor: "#0b0f14", borderWidth: 2 },
        },
      ],
    };
  }

  if (chart_type === "bubble") {
    return {
      ...base,
      xAxis: { type: "category", name: x_label, data: cats, axisLabel: { color: AXIS }, axisLine: { lineStyle: { color: GRID } }, nameTextStyle: { color: AXIS } },
      yAxis: { type: "value", name: y_label, axisLabel: { color: AXIS }, splitLine: { lineStyle: { color: GRID } }, nameTextStyle: { color: AXIS } },
      series: [
        {
          name: seriesName,
          type: "scatter",
          data: vals.map((v, i) => [i, v]),
          symbolSize: (val) => {
            const max = Math.max(...vals, 1);
            return 10 + (val[1] / max) * 46;
          },
          itemStyle: { color: TEAL, shadowColor: "rgba(45,212,191,0.6)", shadowBlur: 12 },
        },
      ],
    };
  }

  // line (default, glowing white), bar, histogram
  const isBar = chart_type === "bar" || chart_type === "histogram";
  const series = isBar
    ? {
        name: seriesName,
        type: "bar",
        data: vals,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: "#2dd4bf" }, { offset: 1, color: "#0d9488" }],
          },
        },
      }
    : {
        name: seriesName,
        type: "line",
        data: vals,
        smooth: true,
        symbol: "circle",
        symbolSize: 8,
        showSymbol: true,
        lineStyle: { color: "#ffffff", width: 3, shadowColor: "rgba(255,255,255,0.85)", shadowBlur: 14 },
        itemStyle: { color: "#ffffff", borderColor: "#ffffff", shadowColor: "rgba(255,255,255,0.9)", shadowBlur: 10 },
        areaStyle: {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: "rgba(255,255,255,0.28)" }, { offset: 1, color: "rgba(255,255,255,0.02)" }],
          },
        },
      };

  return {
    ...base,
    xAxis: {
      type: "category", name: x_label, data: cats,
      axisLabel: { color: AXIS, fontWeight: 600, hideOverlap: true },
      axisLine: { lineStyle: { color: GRID } },
      nameTextStyle: { color: AXIS },
    },
    yAxis: {
      type: "value", name: y_label,
      axisLabel: { color: AXIS },
      splitLine: { lineStyle: { color: GRID } },
      nameTextStyle: { color: AXIS },
    },
    series: [series],
  };
}

const ChartRenderer = ({ chart }) => (
  <ReactECharts
    option={buildOption(chart)}
    style={{ height: "100%", width: "100%" }}
    opts={{ renderer: "canvas" }}
    notMerge
  />
);

export default ChartRenderer;
