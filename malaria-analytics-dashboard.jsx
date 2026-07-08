import { useState, useMemo } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart,
  ScatterChart, Scatter, Treemap,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ZAxis, ReferenceLine
} from 'recharts';
import {
  LayoutDashboard, Map as MapIcon, TrendingUp, Syringe, ShieldCheck, Target,
  ChevronDown, Info, ArrowUpRight, ArrowDownRight, AlertTriangle,
  Droplets, CloudRain, Thermometer, Activity, X, Bell
} from 'lucide-react';

/* ============================== DESIGN TOKENS ============================== */
const C = {
  bg: '#0A101C',
  panel: '#121A2A',
  panelAlt: '#16203380',
  panel2: '#0E1523',
  border: '#22304A',
  borderLight: '#2C3D5C',
  text: '#E9EEF6',
  textDim: '#8C9AB5',
  textFaint: '#5B6B89',
  teal: '#0E8388',
  tealLight: '#2DD4BF',
  azure: '#38BDF8',
  azureDim: '#38BDF833',
  red: '#F0483E',
  amber: '#F59E0B',
  yellow: '#EAB308',
  green: '#22C55E',
  purple: '#A78BFA',
};
const ZONE_COLORS = { red: C.red, amber: C.amber, yellow: C.yellow, green: C.green };
const ZONE_LABELS = { red: 'Red Zone', amber: 'Amber Zone', yellow: 'Yellow Zone', green: 'Green Zone' };
const REGION_COLORS = { NW: '#38BDF8', NC: '#818CF8', NE: '#A78BFA', SW: '#F472B6', SE: '#FB923C', SS: '#34D399' };

/* ============================== MOCK DATA ============================== */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const REGIONS = [
  { code: 'NW', name: 'North West', total: 184 },
  { code: 'NC', name: 'North Central', total: 115 },
  { code: 'NE', name: 'North East', total: 111 },
  { code: 'SW', name: 'South West', total: 132 },
  { code: 'SE', name: 'South East', total: 95 },
  { code: 'SS', name: 'South South', total: 125 },
];
const TOTAL_HOTSPOTS = REGIONS.reduce((s, r) => s + r.total, 0);

const STATE_ZONE_TABLE = [
  { state: 'Kano', red: 42, amber: 4, yellow: 25, green: 0 },
  { state: 'Katsina', red: 33, amber: 4, yellow: 23, green: 0 },
  { state: 'Akwa Ibom', red: 27, amber: 12, yellow: 18, green: 3 },
  { state: 'Jigawa', red: 26, amber: 3, yellow: 17, green: 0 },
  { state: 'Delta', red: 22, amber: 12, yellow: 14, green: 3 },
  { state: 'Kaduna', red: 21, amber: 3, yellow: 12, green: 0 },
  { state: 'Sokoto', red: 20, amber: 0, yellow: 10, green: 0 },
  { state: 'Imo', red: 19, amber: 24, yellow: 4, green: 9 },
  { state: 'Rivers', red: 19, amber: 11, yellow: 14, green: 5 },
  { state: 'Kebbi', red: 19, amber: 3, yellow: 9, green: 0 },
  { state: 'Borno', red: 15, amber: 14, yellow: 12, green: 3 },
  { state: 'Cross River', red: 15, amber: 8, yellow: 14, green: 3 },
  { state: 'Edo', red: 15, amber: 8, yellow: 13, green: 0 },
  { state: 'Benue', red: 14, amber: 17, yellow: 0, green: 0 },
  { state: 'Anambra', red: 13, amber: 21, yellow: 3, green: 6 },
  { state: 'Lagos', red: 13, amber: 20, yellow: 8, green: 18 },
];

// 37 states (36 + FCT), positioned on an axial hex grid approximating real geography
const STATE_HOTSPOTS = [
  { name: 'Sokoto', code: 'SK', region: 'NW', col: 2, row: 0, count: 20, dominant: 'red' },
  { name: 'Kebbi', code: 'KB', region: 'NW', col: 1, row: 1, count: 19, dominant: 'red' },
  { name: 'Zamfara', code: 'ZM', region: 'NW', col: 3, row: 1, count: 23, dominant: 'red' },
  { name: 'Katsina', code: 'KT', region: 'NW', col: 4, row: 0, count: 33, dominant: 'red' },
  { name: 'Jigawa', code: 'JG', region: 'NW', col: 6, row: 0, count: 26, dominant: 'red' },
  { name: 'Kano', code: 'KN', region: 'NW', col: 5, row: 1, count: 42, dominant: 'red' },
  { name: 'Kaduna', code: 'KD', region: 'NW', col: 4, row: 2, count: 21, dominant: 'red' },
  { name: 'Yobe', code: 'YB', region: 'NE', col: 8, row: 0, count: 18, dominant: 'red' },
  { name: 'Borno', code: 'BO', region: 'NE', col: 9, row: 1, count: 15, dominant: 'red' },
  { name: 'Bauchi', code: 'BA', region: 'NE', col: 7, row: 2, count: 22, dominant: 'red' },
  { name: 'Gombe', code: 'GM', region: 'NE', col: 8, row: 2, count: 19, dominant: 'red' },
  { name: 'Adamawa', code: 'AD', region: 'NE', col: 9, row: 3, count: 20, dominant: 'red' },
  { name: 'Taraba', code: 'TR', region: 'NE', col: 8, row: 4, count: 17, dominant: 'red' },
  { name: 'Niger', code: 'NG', region: 'NC', col: 2, row: 3, count: 17, dominant: 'amber' },
  { name: 'FCT', code: 'FC', region: 'NC', col: 5, row: 3, count: 21, dominant: 'amber' },
  { name: 'Nasarawa', code: 'NS', region: 'NC', col: 6, row: 3, count: 15, dominant: 'amber' },
  { name: 'Kwara', code: 'KW', region: 'NC', col: 1, row: 4, count: 14, dominant: 'amber' },
  { name: 'Kogi', code: 'KG', region: 'NC', col: 3, row: 4, count: 16, dominant: 'amber' },
  { name: 'Benue', code: 'BN', region: 'NC', col: 6, row: 4, count: 14, dominant: 'amber' },
  { name: 'Plateau', code: 'PL', region: 'NC', col: 7, row: 3, count: 18, dominant: 'amber' },
  { name: 'Oyo', code: 'OY', region: 'SW', col: 1, row: 5, count: 26, dominant: 'yellow' },
  { name: 'Osun', code: 'OS', region: 'SW', col: 2, row: 5, count: 20, dominant: 'green' },
  { name: 'Ekiti', code: 'EK', region: 'SW', col: 3, row: 5, count: 28, dominant: 'yellow' },
  { name: 'Ondo', code: 'ON', region: 'SW', col: 3, row: 6, count: 23, dominant: 'yellow' },
  { name: 'Ogun', code: 'OG', region: 'SW', col: 1, row: 6, count: 22, dominant: 'yellow' },
  { name: 'Lagos', code: 'LA', region: 'SW', col: 0, row: 6, count: 13, dominant: 'green' },
  { name: 'Enugu', code: 'EN', region: 'SE', col: 5, row: 5, count: 22, dominant: 'amber' },
  { name: 'Ebonyi', code: 'EB', region: 'SE', col: 6, row: 5, count: 19, dominant: 'amber' },
  { name: 'Anambra', code: 'AN', region: 'SE', col: 4, row: 6, count: 13, dominant: 'green' },
  { name: 'Imo', code: 'IM', region: 'SE', col: 5, row: 6, count: 19, dominant: 'green' },
  { name: 'Abia', code: 'AB', region: 'SE', col: 6, row: 6, count: 22, dominant: 'amber' },
  { name: 'Edo', code: 'ED', region: 'SS', col: 2, row: 7, count: 15, dominant: 'amber' },
  { name: 'Delta', code: 'DE', region: 'SS', col: 1, row: 7, count: 22, dominant: 'red' },
  { name: 'Bayelsa', code: 'BY', region: 'SS', col: 1, row: 8, count: 25, dominant: 'red' },
  { name: 'Rivers', code: 'RI', region: 'SS', col: 3, row: 8, count: 19, dominant: 'yellow' },
  { name: 'Akwa Ibom', code: 'AK', region: 'SS', col: 5, row: 8, count: 27, dominant: 'red' },
  { name: 'Cross River', code: 'CR', region: 'SS', col: 6, row: 7, count: 15, dominant: 'amber' },
];

// synthetic coverage figures used by the Priority Matrix (SS/NW skew low coverage + high risk on purpose)
const COVERAGE_BY_STATE = STATE_HOTSPOTS.map(s => {
  const northPenalty = ['NW', 'NE'].includes(s.region) ? 18 : 0;
  const base = 68 - northPenalty - (s.count - 18) * 0.6;
  const itn = Math.max(30, Math.min(78, Math.round(base + (s.name.length % 5) * 2)));
  const iptp3 = Math.max(18, Math.min(62, Math.round(itn * 0.62 - (s.dominant === 'red' ? 6 : 0))));
  return { ...s, itn, iptp3 };
});
const PRIORITY_RANKED = [...COVERAGE_BY_STATE]
  .map(s => ({ ...s, score: Math.round(s.count * (1 - s.iptp3 / 100) * (1 - s.itn / 140)) }))
  .sort((a, b) => b.score - a.score);

const FEVER_CASES = [58, 54, 50, 47, 58, 60, 58, 59, 58, 57, 46, 45].map(v => v * 1e6 * (0.94 + 0.001));
const CONFIRMED_CASES = [3.8, 3.4, 3.0, 2.0, 3.3, 3.9, 3.7, 3.8, 3.9, 3.6, 2.1, 2.0].map(v => v * 1e6);
const IRS_COVERAGE = [14.5, 14.6, 14.0, 13.9, 14.7, 14.9, 14.2, 14.1, 14.8, 15.0, 14.3, 14.6];
const ITN_COVERAGE = [56.2, 57.8, 56.0, 57.5, 56.4, 58.1, 56.3, 57.6, 56.5, 58.4, 57.0, 57.9];
const RAINFALL = [15, 40, 95, 300, 260, 275, 250, 265, 270, 120, 25, 10];
const IPTP1 = [71, 70, 71, 70, 69, 70, 71, 70, 69, 70, 71, 70];
const IPTP2 = [53, 52, 52, 51, 52, 53, 52, 51, 52, 53, 52, 52];
const IPTP3 = [37, 37, 36, 36, 37, 38, 37, 36, 37, 38, 37, 37];

const LGA_IPTP = [
  'Bwari','Adavi','Bungudu','Umuahia South','Yagba West','Kanke','Etsako West','Suru',
  'Calabar Municipal','Egbedore','Ondo East','Ifedore','Oru East','Oyun','Ogo Oluwa','Garko',
  'Jos South','Ughelli North','Asa','Onuimo','Ikenne','Odo Otin','Ilejemeje','Ido Osi',
  'Agege','Obowo','Ikole',
].map((name, i) => {
  const p1 = 42 + ((i * 7) % 18);
  const p2 = 28 + ((i * 5) % 14);
  const p3 = 12 + ((i * 3) % 10);
  return { name, p1, p2, p3 };
});

const ACTUAL_VS_PRED = STATE_HOTSPOTS.map(s => {
  const err = ((s.name.length * 13) % 9) - 4;
  return { state: s.name, code: s.code, actual: s.count, predicted: Math.max(1, s.count + err), tested: 1104 + s.count * 3800, positive: 55 + s.count * 720, fever: 5157 + s.count * 4200 };
});
const MAE = ACTUAL_VS_PRED.reduce((s, d) => s + Math.abs(d.actual - d.predicted), 0) / ACTUAL_VS_PRED.length;
const MODEL_ACCURACY = Math.round((1 - MAE / (TOTAL_HOTSPOTS / 37)) * 100);

/* ============================== HELPERS ============================== */
function fmt(n, opts = {}) {
  if (n >= 1e6) return (n / 1e6).toFixed(opts.d ?? 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(opts.d ?? 1) + 'K';
  return Math.round(n).toLocaleString();
}
function gridToXY(col, row) {
  const hexW = 62, hexH = 54;
  const x = col * hexW + (row % 2 === 1 ? hexW / 2 : 0) + 40;
  const y = row * hexH + 30;
  return { x, y };
}

/* ============================== SHARED UI ============================== */
function Card({ title, icon: Icon, tag, right, children, style, bodyStyle }) {
  return (
    <div className="card" style={style}>
      {title && (
        <div className="cardHead">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {Icon && <Icon size={15} color={C.tealLight} strokeWidth={2.2} />}
            <span className="cardTitle">{title}</span>
            {tag && <span className="tag">{tag}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {right}
            <Info size={13} color={C.textFaint} />
          </div>
        </div>
      )}
      <div style={{ padding: '14px 18px 18px', ...bodyStyle }}>{children}</div>
    </div>
  );
}

function KPICard({ label, value, delta, deltaGood, icon: Icon, accent }) {
  const up = delta >= 0;
  const goodColor = deltaGood ? C.green : C.red;
  const badColor = deltaGood ? C.red : C.green;
  return (
    <div className="kpi">
      <div className="kpiTop">
        <span className="kpiLabel">{label}</span>
        <div className="kpiIconWrap" style={{ background: (accent || C.teal) + '22' }}>
          <Icon size={14} color={accent || C.tealLight} strokeWidth={2.2} />
        </div>
      </div>
      <div className="kpiValue">{value}</div>
      {delta !== undefined && (
        <div className="kpiDelta" style={{ color: up ? goodColor : badColor }}>
          {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          <span>{Math.abs(delta)}% vs last month</span>
        </div>
      )}
    </div>
  );
}

function ZoneLegend({ compact }) {
  return (
    <div style={{ display: 'flex', gap: compact ? 10 : 16, flexWrap: 'wrap' }}>
      {Object.entries(ZONE_LABELS).map(([k, label]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: ZONE_COLORS[k], display: 'inline-block' }} />
          <span style={{ fontSize: 11.5, color: C.textDim }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

function CustomTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: '#0D1524', border: `1px solid ${C.borderLight}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
      {label && <div style={{ color: C.textDim, marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', color: C.text }}>
          <span style={{ color: p.color || p.fill }}>{p.name}</span>
          <strong style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{typeof p.value === 'number' ? fmt(p.value) : p.value}{suffix || ''}</strong>
        </div>
      ))}
    </div>
  );
}

function Select({ value, onChange, options, label }) {
  return (
    <label className="selectWrap">
      <span className="selectLabel">{label}</span>
      <div className="selectBox">
        <select value={value} onChange={e => onChange(e.target.value)}>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <ChevronDown size={13} color={C.textDim} />
      </div>
    </label>
  );
}

/* ============================== SIGNATURE: STATE CONSTELLATION MAP ============================== */
function ConstellationMap({ selected, onSelect, categoryFilter }) {
  const points = STATE_HOTSPOTS.map(s => ({ ...s, ...gridToXY(s.col, s.row) }));
  const regionLabelPos = {
    NW: gridToXY(3.2, -0.9), NE: gridToXY(8.6, -0.9), NC: gridToXY(4.2, 2.15),
    SW: gridToXY(0.9, 4.4), SE: gridToXY(5.4, 4.4), SS: gridToXY(2.8, 6.55),
  };
  return (
    <svg viewBox="0 0 660 500" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={C.azure} stopOpacity="0.35" />
          <stop offset="100%" stopColor={C.azure} stopOpacity="0" />
        </radialGradient>
      </defs>
      {Object.entries(regionLabelPos).map(([code, p]) => (
        <text key={code} x={p.x} y={p.y} fill={REGION_COLORS[code]} fontSize="11.5" fontWeight="700" letterSpacing="1.5" fontFamily="IBM Plex Mono, monospace" opacity="0.85">{code}</text>
      ))}
      {points.map(s => {
        const dim = categoryFilter !== 'All' && s.dominant !== categoryFilter.toLowerCase();
        const r = 7 + Math.sqrt(s.count) * 1.65;
        const isSel = selected === s.name;
        return (
          <g key={s.name} onClick={() => onSelect(isSel ? null : s.name)} style={{ cursor: 'pointer' }} opacity={dim ? 0.18 : 1}>
            {isSel && <circle cx={s.x} cy={s.y} r={r + 9} fill="url(#glow)" />}
            <circle cx={s.x} cy={s.y} r={r} fill={ZONE_COLORS[s.dominant]} fillOpacity={isSel ? 0.95 : 0.8}
              stroke={isSel ? C.text : '#0A101C'} strokeWidth={isSel ? 1.6 : 1} />
            <text x={s.x} y={s.y + 3.5} textAnchor="middle" fontSize={r > 15 ? 9.5 : 8} fontWeight="700"
              fill="#0A101C" fontFamily="IBM Plex Mono, monospace">{s.code}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ============================== TOPBAR + SIDEBAR ============================== */
const NAV = [
  { id: 'overview', label: 'Command Overview', icon: LayoutDashboard },
  { id: 'hotspot', label: 'Hotspot Intelligence', icon: MapIcon },
  { id: 'model', label: 'Predictive Model', icon: TrendingUp },
  { id: 'iptp', label: 'IPTp Coverage', icon: Syringe },
  { id: 'intervention', label: 'Intervention Impact', icon: ShieldCheck },
  { id: 'priority', label: 'Priority & Response', icon: Target },
];

function Sidebar({ page, setPage }) {
  return (
    <div className="sidebar">
      <div className="brand">
        <div className="brandMark"><Activity size={17} color="#0A101C" strokeWidth={2.6} /></div>
        <div>
          <div className="brandTitle">MalariaIQ</div>
          <div className="brandSub">Predictive Analytics</div>
        </div>
      </div>
      <div className="navList">
        {NAV.map(item => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button key={item.id} className={`navItem ${active ? 'navItemActive' : ''}`} onClick={() => setPage(item.id)}>
              <Icon size={16} strokeWidth={2.1} color={active ? C.tealLight : C.textDim} />
              <span>{item.label}</span>
              {active && <span className="navDot" />}
            </button>
          );
        })}
      </div>
      <div className="sidebarFoot">
        <div style={{ fontSize: 10.5, color: C.textFaint, lineHeight: 1.5 }}>
          National Malaria Elimination Programme<br />Nigeria · Sample / illustrative data
        </div>
      </div>
    </div>
  );
}

function TopBar({ title, subtitle, filters, setFilters }) {
  return (
    <div className="topbar">
      <div>
        <div className="topTitle">{title}</div>
        {subtitle && <div className="topSub">{subtitle}</div>}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <Select label="PERIOD" value={filters.period} onChange={v => setFilters(f => ({ ...f, period: v }))} options={['2026', '2025']} />
        <Select label="LOCATION" value={filters.location} onChange={v => setFilters(f => ({ ...f, location: v }))} options={['All', ...STATE_HOTSPOTS.map(s => s.name).sort()]} />
        <Select label="CATEGORY" value={filters.category} onChange={v => setFilters(f => ({ ...f, category: v }))} options={['All', 'Red', 'Amber', 'Yellow', 'Green']} />
        <div className="bellWrap"><Bell size={16} color={C.textDim} /><span className="bellDot" /></div>
      </div>
    </div>
  );
}

/* ============================== PAGE: OVERVIEW ============================== */
function OverviewPage({ filters }) {
  const redTotal = STATE_HOTSPOTS.filter(s => s.dominant === 'red').reduce((s, x) => s + x.count, 0);
  const treeData = REGIONS.map(r => ({ name: r.name, code: r.code, size: r.total, fill: REGION_COLORS[r.code] }));
  const topMovers = [...STATE_HOTSPOTS].sort((a, b) => b.count - a.count).slice(0, 5);

  return (
    <>
      <div className="alertBar">
        <AlertTriangle size={15} color={C.amber} />
        <span><strong>6 states</strong> crossed the Red Zone LGA threshold this reporting period &mdash; Kano, Katsina, Jigawa, Zamfara, Akwa Ibom, Bayelsa. See Priority &amp; Response for the ranked action list.</span>
      </div>

      <div className="grid4">
        <KPICard label="Total Hotspot LGAs" value={TOTAL_HOTSPOTS} delta={4.2} deltaGood={false} icon={MapIcon} accent={C.azure} />
        <KPICard label="Red Zone LGAs" value={redTotal} delta={6.8} deltaGood={false} icon={AlertTriangle} accent={C.red} />
        <KPICard label="Avg. IPTp3 Coverage" value={IPTP3[IPTP3.length - 1] + '%'} delta={1.1} deltaGood={true} icon={Syringe} accent={C.tealLight} />
        <KPICard label="Model Accuracy" value={MODEL_ACCURACY + '%'} delta={0.6} deltaGood={true} icon={TrendingUp} accent={C.purple} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Hotspot LGA by Geographic Region" icon={MapIcon}>
          <ResponsiveContainer width="100%" height={230}>
            <Treemap data={treeData} dataKey="size" stroke={C.bg} isAnimationActive={false}
              content={({ x, y, width, height, name, size, fill }) => (
                width > 2 && height > 2 ? (
                  <g>
                    <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={0.85} stroke={C.bg} strokeWidth={2} />
                    {width > 55 && height > 34 && (
                      <>
                        <text x={x + 10} y={y + 20} fill="#0A101C" fontSize={12} fontWeight="700">{name}</text>
                        <text x={x + 10} y={y + height - 12} fill="#0A101C" fontSize={17} fontWeight="800" fontFamily="IBM Plex Mono, monospace">{size}</text>
                      </>
                    )}
                  </g>
                ) : null
              )} />
          </ResponsiveContainer>
        </Card>

        <Card title="National Risk Constellation" icon={Target} right={<ZoneLegend compact />}>
          <ConstellationMap selected={null} onSelect={() => {}} categoryFilter="All" />
        </Card>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Fever Cases vs Confirmed Malaria &mdash; 2026" icon={Activity}>
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={MONTHS.map((m, i) => ({ month: m, fever: FEVER_CASES[i], confirmed: CONFIRMED_CASES[i] }))}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis yAxisId="l" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area yAxisId="l" type="monotone" dataKey="fever" name="Fever cases" stroke={C.azure} fill={C.azure} fillOpacity={0.15} strokeWidth={2} />
              <Line yAxisId="r" type="monotone" dataKey="confirmed" name="Confirmed malaria" stroke={C.red} strokeWidth={2.2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Top 5 Highest-Burden States" icon={AlertTriangle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topMovers.map((s, i) => (
              <div key={s.name} className="rankRow">
                <span className="rankNo">{i + 1}</span>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: ZONE_COLORS[s.dominant], flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13 }}>{s.name}</span>
                <span className="tagRegion" style={{ color: REGION_COLORS[s.region] }}>{s.region}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, fontWeight: 700 }}>{s.count}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 11.5, color: C.textDim, lineHeight: 1.6 }}>
            Ranking reflects total hotspot LGA count per state across all zone categories for the selected period.
          </div>
        </Card>
      </div>
    </>
  );
}

/* ============================== PAGE: HOTSPOT INTELLIGENCE ============================== */
function HotspotPage({ filters }) {
  const [selected, setSelected] = useState(null);
  const selState = STATE_HOTSPOTS.find(s => s.name === selected);
  const stackData = STATE_ZONE_TABLE.map(d => ({ ...d, total: d.red + d.amber + d.yellow + d.green }));

  return (
    <>
      <div className="grid2">
        <Card title="Zone Constellation Map &mdash; click a state" icon={Target} right={<ZoneLegend compact />}>
          <ConstellationMap selected={selected} onSelect={setSelected} categoryFilter={filters.category} />
        </Card>

        <Card title={selState ? `${selState.name} &middot; ${selState.region}` : 'Select a state on the map'} icon={MapIcon}>
          {selState ? (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div className="miniStat"><div className="miniStatVal" style={{ color: ZONE_COLORS[selState.dominant] }}>{selState.count}</div><div className="miniStatLbl">Hotspot LGAs</div></div>
                <div className="miniStat"><div className="miniStatVal">{COVERAGE_BY_STATE.find(c => c.name === selState.name)?.itn}%</div><div className="miniStatLbl">ITN coverage</div></div>
                <div className="miniStat"><div className="miniStatVal">{COVERAGE_BY_STATE.find(c => c.name === selState.name)?.iptp3}%</div><div className="miniStatLbl">IPTp3 coverage</div></div>
              </div>
              <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.7 }}>
                Dominant classification is <strong style={{ color: ZONE_COLORS[selState.dominant] }}>{ZONE_LABELS[selState.dominant]}</strong>.
                {selState.dominant === 'red' && ' This state is flagged for accelerated IRS/ITN distribution and IPTp catch-up outreach &mdash; see Priority &amp; Response.'}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: C.textFaint, padding: '30px 0', textAlign: 'center' }}>Click any node on the constellation map to see state-level detail here.</div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Distribution of Hotspot LGAs by State &amp; Zone" icon={Activity} right={<ZoneLegend compact />}>
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={stackData} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis type="category" dataKey="state" width={90} tick={{ fill: C.textDim, fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="red" stackId="z" name="Red" fill={C.red} radius={[0,0,0,0]} />
              <Bar dataKey="amber" stackId="z" name="Amber" fill={C.amber} />
              <Bar dataKey="yellow" stackId="z" name="Yellow" fill={C.yellow} />
              <Bar dataKey="green" stackId="z" name="Green" fill={C.green} radius={[0,4,4,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </>
  );
}

/* ============================== PAGE: PREDICTIVE MODEL ============================== */
function ModelPage() {
  const [minFever, setMinFever] = useState(5157);
  const [minTested, setMinTested] = useState(1104);
  const [minPositive, setMinPositive] = useState(55);

  const filtered = useMemo(() => ACTUAL_VS_PRED.filter(d => d.fever >= minFever && d.tested >= minTested && d.positive >= minPositive), [minFever, minTested, minPositive]);

  return (
    <>
      <div className="grid4">
        <KPICard label="Model Accuracy" value={MODEL_ACCURACY + '%'} icon={TrendingUp} accent={C.tealLight} />
        <KPICard label="Mean Abs. Error (LGAs)" value={MAE.toFixed(1)} icon={Activity} accent={C.purple} />
        <KPICard label="States in Scope" value={filtered.length + ' / 37'} icon={MapIcon} accent={C.azure} />
        <KPICard label="Forecast Horizon" value="30 days" icon={Target} accent={C.amber} />
      </div>

      <Card title="Filter by Surveillance Thresholds" icon={Activity} style={{ marginTop: 16 }}>
        <div className="sliderGrid">
          <div className="sliderItem">
            <div className="sliderLbl">Population with fever &ge; <strong>{minFever.toLocaleString()}</strong></div>
            <input type="range" min={5157} max={140000} step={500} value={minFever} onChange={e => setMinFever(+e.target.value)} />
          </div>
          <div className="sliderItem">
            <div className="sliderLbl"># Tested &ge; <strong>{minTested.toLocaleString()}</strong></div>
            <input type="range" min={1104} max={140000} step={500} value={minTested} onChange={e => setMinTested(+e.target.value)} />
          </div>
          <div className="sliderItem">
            <div className="sliderLbl"># Tested Positive &ge; <strong>{minPositive.toLocaleString()}</strong></div>
            <input type="range" min={55} max={20000} step={100} value={minPositive} onChange={e => setMinPositive(+e.target.value)} />
          </div>
        </div>
      </Card>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Actual vs. Predicted Hotspot LGAs by State" icon={TrendingUp}>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" />
              <XAxis type="number" dataKey="actual" name="Actual" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} label={{ value: 'Actual', position: 'insideBottom', offset: -4, fill: C.textFaint, fontSize: 11 }} />
              <YAxis type="number" dataKey="predicted" name="Predicted" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} label={{ value: 'Predicted', angle: -90, position: 'insideLeft', fill: C.textFaint, fontSize: 11 }} />
              <ZAxis range={[60, 60]} />
              <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 45, y: 45 }]} stroke={C.textFaint} strokeDasharray="4 4" />
              <Scatter data={filtered} name="States" fill={C.azure} fillOpacity={0.85} />
            </ScatterChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>Dashed line marks perfect prediction (actual = predicted). Points below the line indicate under-prediction.</div>
        </Card>

        <Card title="State-Level Prediction Table" icon={MapIcon}>
          <div className="tableWrap" style={{ maxHeight: 280 }}>
            <table className="dataTable">
              <thead><tr><th>State</th><th>Actual</th><th>Predicted</th><th>Delta</th></tr></thead>
              <tbody>
                {filtered.sort((a,b)=>b.actual-a.actual).map(d => {
                  const delta = d.predicted - d.actual;
                  return (
                    <tr key={d.state}>
                      <td>{d.state}</td>
                      <td style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{d.actual}</td>
                      <td style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{d.predicted}</td>
                      <td style={{ fontFamily: 'IBM Plex Mono, monospace', color: delta === 0 ? C.textDim : delta > 0 ? C.red : C.green }}>{delta > 0 ? '+' : ''}{delta}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ============================== PAGE: IPTP COVERAGE ============================== */
function IPTpPage() {
  const trend = MONTHS.map((m, i) => ({ month: m, IPTp1: IPTP1[i], IPTp2: IPTP2[i], IPTp3: IPTP3[i] }));
  const drop12 = (100 - IPTP2[11] / IPTP1[11] * 100).toFixed(0);
  const drop23 = (100 - IPTP3[11] / IPTP2[11] * 100).toFixed(0);

  return (
    <>
      <div className="grid4">
        <KPICard label="IPTp1 Coverage" value={IPTP1[11] + '%'} delta={0.4} deltaGood={true} icon={Syringe} accent={C.azure} />
        <KPICard label="IPTp2 Coverage" value={IPTP2[11] + '%'} delta={0.2} deltaGood={true} icon={Syringe} accent={C.tealLight} />
        <KPICard label="IPTp3 Coverage" value={IPTP3[11] + '%'} delta={0.9} deltaGood={true} icon={Syringe} accent={C.purple} />
        <KPICard label="IPTp1&rarr;3 Dropout" value={(100 - IPTP3[11] / IPTP1[11] * 100).toFixed(0) + '%'} delta={1.4} deltaGood={false} icon={AlertTriangle} accent={C.red} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Comparative Analysis of ANC Receiving IPTp Over a Period" icon={Syringe}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={trend}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis domain={[0, 80]} tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
              <Tooltip content={<CustomTooltip suffix="%" />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Line type="monotone" dataKey="IPTp1" stroke={C.azure} strokeWidth={2.2} dot={false} />
              <Line type="monotone" dataKey="IPTp2" stroke={C.tealLight} strokeWidth={2.2} dot={false} />
              <Line type="monotone" dataKey="IPTp3" stroke={C.purple} strokeWidth={2.2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="IPTp Cascade &mdash; Attrition Across Doses" icon={AlertTriangle}>
          <div className="funnel">
            {[{ label: 'IPTp1', val: IPTP1[11], color: C.azure }, { label: 'IPTp2', val: IPTP2[11], color: C.tealLight }, { label: 'IPTp3', val: IPTP3[11], color: C.purple }].map((f, i, arr) => (
              <div key={f.label} style={{ marginBottom: i < arr.length - 1 ? 6 : 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: C.textDim, marginBottom: 4 }}>
                  <span>{f.label}</span><span style={{ fontFamily: 'IBM Plex Mono, monospace', color: C.text }}>{f.val}%</span>
                </div>
                <div className="funnelTrack"><div className="funnelFill" style={{ width: f.val + '%', background: f.color }} /></div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <div className="warnPill"><AlertTriangle size={12} color={C.amber} /> {drop12}% drop IPTp1&rarr;2</div>
            <div className="warnPill"><AlertTriangle size={12} color={C.red} /> {drop23}% drop IPTp2&rarr;3</div>
          </div>
          <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 12, lineHeight: 1.7 }}>
            Nearly half of ANC attendees who begin IPTp do not complete the recommended three-dose course. Facility-level follow-up messaging on the WhatsApp self-screening module can help close this gap.
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Population Receiving IPTp Treatment by LGA" icon={Syringe}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={LGA_IPTP}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={{ stroke: C.border }} tickLine={false} interval={0} angle={-45} textAnchor="end" height={80} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
              <Tooltip content={<CustomTooltip suffix="%" />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Bar dataKey="p1" stackId="a" name="IPTp1" fill={C.azure} />
              <Bar dataKey="p2" stackId="a" name="IPTp2" fill={C.tealLight} />
              <Bar dataKey="p3" stackId="a" name="IPTp3" fill={C.purple} radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </>
  );
}

/* ============================== PAGE: INTERVENTION IMPACT ============================== */
function InterventionPage() {
  const chartData = MONTHS.map((m, i) => ({
    month: m, fever: FEVER_CASES[i], confirmed: CONFIRMED_CASES[i],
    irs: IRS_COVERAGE[i], itn: ITN_COVERAGE[i], rainfall: RAINFALL[i],
  }));
  const positivityRate = (CONFIRMED_CASES[11] / FEVER_CASES[11] * 100).toFixed(1);

  return (
    <>
      <div className="grid4">
        <KPICard label="Fever Cases (Dec)" value={fmt(FEVER_CASES[11])} delta={2.2} deltaGood={false} icon={Thermometer} accent={C.azure} />
        <KPICard label="Confirmed Malaria (Dec)" value={fmt(CONFIRMED_CASES[11])} delta={4.7} deltaGood={false} icon={Activity} accent={C.red} />
        <KPICard label="ITN Household Coverage" value={ITN_COVERAGE[11].toFixed(1) + '%'} delta={1.6} deltaGood={true} icon={ShieldCheck} accent={C.tealLight} />
        <KPICard label="Test Positivity Rate" value={positivityRate + '%'} delta={0.8} deltaGood={false} icon={Droplets} accent={C.amber} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Number of Fever Cases" icon={Thermometer}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="fever" name="Fever cases" stroke={C.azure} fill={C.azure} fillOpacity={0.18} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Malaria Case Confirmed" icon={Activity}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="confirmed" name="Confirmed malaria" stroke={C.red} fill={C.red} fillOpacity={0.18} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid3" style={{ marginTop: 16 }}>
        <Card title="% Households Covered by IRS" icon={ShieldCheck}>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chartData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis domain={[13, 15.5]} tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
              <Tooltip content={<CustomTooltip suffix="%" />} />
              <Line type="monotone" dataKey="irs" name="IRS coverage" stroke={C.tealLight} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title="% Households with &ge;1 ITN" icon={ShieldCheck}>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chartData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis domain={[54, 59]} tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
              <Tooltip content={<CustomTooltip suffix="%" />} />
              <Line type="monotone" dataKey="itn" name="ITN coverage" stroke={C.azure} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title="ANC Attendees Receiving IPTp" icon={Syringe}>
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={MONTHS.map((m,i)=>({month:m, IPTp1:IPTP1[i], IPTp2:IPTP2[i], IPTp3:IPTP3[i]}))}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis tick={{ fill: C.textFaint, fontSize: 9.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} />
              <Tooltip content={<CustomTooltip suffix="%" />} />
              <Area type="monotone" stackId="s" dataKey="IPTp1" stroke={C.azure} fill={C.azure} fillOpacity={0.5} />
              <Area type="monotone" stackId="s" dataKey="IPTp2" stroke={C.tealLight} fill={C.tealLight} fillOpacity={0.5} />
              <Area type="monotone" stackId="s" dataKey="IPTp3" stroke={C.purple} fill={C.purple} fillOpacity={0.6} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Rainfall vs. Malaria Positive Cases" icon={CloudRain}>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={chartData}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} />
              <YAxis yAxisId="l" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => v + 'mm'} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11.5, color: C.textDim }} />
              <Bar yAxisId="l" dataKey="rainfall" name="Rainfall (mm)" fill={C.azure} fillOpacity={0.55} radius={[3,3,0,0]} />
              <Line yAxisId="r" type="monotone" dataKey="confirmed" name="Positive cases" stroke={C.red} strokeWidth={2.2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11.5, color: C.textDim, marginTop: 6, lineHeight: 1.6 }}>
            Confirmed cases rise roughly six weeks after rainfall peaks (April&ndash;September), consistent with the mosquito breeding-to-transmission lag &mdash; useful for pre-positioning IRS teams ahead of the rains.
          </div>
        </Card>
      </div>
    </>
  );
}

/* ============================== PAGE: PRIORITY & RESPONSE (NEW THEME) ============================== */
function PriorityPage() {
  const top8 = PRIORITY_RANKED.slice(0, 8);
  return (
    <>
      <div className="grid4">
        <KPICard label="Top Priority State" value={PRIORITY_RANKED[0].name} icon={Target} accent={C.red} />
        <KPICard label="States Needing Urgent IPTp Catch-up" value={COVERAGE_BY_STATE.filter(s => s.iptp3 < 35).length} icon={Syringe} accent={C.amber} />
        <KPICard label="States Below 55% ITN Coverage" value={COVERAGE_BY_STATE.filter(s => s.itn < 55).length} icon={ShieldCheck} accent={C.azure} />
        <KPICard label="Avg. Priority Score" value={Math.round(PRIORITY_RANKED.reduce((s,d)=>s+d.score,0)/PRIORITY_RANKED.length)} icon={Activity} accent={C.purple} />
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <Card title="Risk vs. Intervention Coverage Matrix" icon={Target}>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 4" />
              <XAxis type="number" dataKey="count" name="Hotspot LGAs (risk)" domain={[10, 45]} tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={{ stroke: C.border }} tickLine={false} label={{ value: 'Hotspot LGA count (risk) \u2192', position: 'insideBottom', offset: -4, fill: C.textFaint, fontSize: 11 }} />
              <YAxis type="number" dataKey="itn" name="ITN coverage %" domain={[25, 80]} tick={{ fill: C.textFaint, fontSize: 10.5 }} axisLine={false} tickLine={false} label={{ value: 'ITN coverage % \u2192', angle: -90, position: 'insideLeft', fill: C.textFaint, fontSize: 11 }} />
              <ZAxis range={[50, 50]} />
              <Tooltip content={({ active, payload }) => active && payload?.length ? (
                <div style={{ background: '#0D1524', border: `1px solid ${C.borderLight}`, borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ color: C.text, fontWeight: 700, marginBottom: 2 }}>{payload[0].payload.name}</div>
                  <div style={{ color: C.textDim }}>Hotspot LGAs: <strong style={{ color: C.text }}>{payload[0].payload.count}</strong></div>
                  <div style={{ color: C.textDim }}>ITN coverage: <strong style={{ color: C.text }}>{payload[0].payload.itn}%</strong></div>
                  <div style={{ color: C.textDim }}>IPTp3 coverage: <strong style={{ color: C.text }}>{payload[0].payload.iptp3}%</strong></div>
                </div>
              ) : null} cursor={{ strokeDasharray: '3 3' }} />
              <ReferenceLine x={27.5} stroke={C.textFaint} strokeDasharray="4 4" />
              <ReferenceLine y={52.5} stroke={C.textFaint} strokeDasharray="4 4" />
              <Scatter data={COVERAGE_BY_STATE} name="States" shape={(props) => {
                const { cx, cy, payload } = props;
                const urgent = payload.count > 27.5 && payload.itn < 52.5;
                return <circle cx={cx} cy={cy} r={5.5} fill={urgent ? C.red : C.azure} fillOpacity={0.85} stroke="#0A101C" strokeWidth={1} />;
              }} />
            </ScatterChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 5, background: C.red, display: 'inline-block' }} /><span style={{ fontSize: 11, color: C.textDim }}>High risk / low coverage &mdash; urgent</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 5, background: C.azure, display: 'inline-block' }} /><span style={{ fontSize: 11, color: C.textDim }}>Other states</span></div>
          </div>
        </Card>

        <Card title="Resource Allocation Priority Ranking" icon={AlertTriangle}>
          <div className="tableWrap" style={{ maxHeight: 300 }}>
            <table className="dataTable">
              <thead><tr><th>#</th><th>State</th><th>Hotspots</th><th>ITN%</th><th>IPTp3%</th><th>Score</th></tr></thead>
              <tbody>
                {top8.map((s, i) => (
                  <tr key={s.name}>
                    <td>{i + 1}</td>
                    <td>{s.name}</td>
                    <td style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{s.count}</td>
                    <td style={{ fontFamily: 'IBM Plex Mono, monospace', color: s.itn < 52 ? C.red : C.textDim }}>{s.itn}%</td>
                    <td style={{ fontFamily: 'IBM Plex Mono, monospace', color: s.iptp3 < 35 ? C.red : C.textDim }}>{s.iptp3}%</td>
                    <td style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700, color: C.amber }}>{s.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 10, lineHeight: 1.6 }}>
            Score = hotspot LGA count &times; IPTp3 coverage gap &times; ITN coverage gap. Higher scores indicate states where risk is high and protective coverage is lowest &mdash; the recommended sequence for IRS/ITN campaign and IPTp catch-up deployment.
          </div>
        </Card>
      </div>
    </>
  );
}

/* ============================== APP ============================== */
export default function App() {
  const [page, setPage] = useState('overview');
  const [filters, setFilters] = useState({ period: '2026', location: 'All', category: 'All' });

  const meta = {
    overview: { title: 'Command Overview', sub: 'National summary across all 6 geopolitical zones' },
    hotspot: { title: 'Hotspot Intelligence', sub: 'Geographic distribution & state-level drill-down' },
    model: { title: 'Predictive Model', sub: 'Actual vs. predicted classification performance' },
    iptp: { title: 'IPTp Coverage', sub: 'ANC uptake, cascade attrition & LGA breakdown' },
    intervention: { title: 'Intervention Impact', sub: 'IRS, ITN, case trends & rainfall correlation' },
    priority: { title: 'Priority & Response', sub: 'Cross-referenced risk vs. coverage for resource allocation' },
  }[page];

  return (
    <div className="app" style={{ '--c-bg': C.bg }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;700&display=swap');
        * { box-sizing: border-box; }
        .app { background: ${C.bg}; color: ${C.text}; font-family: 'IBM Plex Sans', system-ui, sans-serif; min-height: 100%; display: flex; }
        ::selection { background: ${C.azure}55; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${C.borderLight}; border-radius: 4px; }
        button, select, input { font-family: inherit; }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid ${C.azure}; outline-offset: 2px; }

        .sidebar { width: 226px; flex-shrink: 0; background: ${C.panel2}; border-right: 1px solid ${C.border}; display: flex; flex-direction: column; padding: 18px 12px; }
        .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 20px; }
        .brandMark { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, ${C.tealLight}, ${C.azure}); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .brandTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
        .brandSub { font-size: 10.5px; color: ${C.textFaint}; margin-top: 1px; }
        .navList { display: flex; flex-direction: column; gap: 2px; flex: 1; }
        .navItem { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; background: transparent; border: none; color: ${C.textDim}; font-size: 12.8px; text-align: left; cursor: pointer; position: relative; transition: background 0.15s; }
        .navItem:hover { background: ${C.panelAlt}; color: ${C.text}; }
        .navItemActive { background: linear-gradient(90deg, ${C.teal}33, transparent); color: ${C.text}; font-weight: 600; }
        .navItemActive::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: ${C.tealLight}; }
        .navDot { margin-left: auto; width: 5px; height: 5px; border-radius: 3px; background: ${C.tealLight}; }
        .sidebarFoot { padding: 12px 8px 4px; border-top: 1px solid ${C.border}; margin-top: 10px; }

        .main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100vh; overflow-y: auto; }
        .topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 26px; background: ${C.bg}ee; backdrop-filter: blur(6px); border-bottom: 1px solid ${C.border}; }
        .topTitle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; }
        .topSub { font-size: 12px; color: ${C.textFaint}; margin-top: 2px; }
        .content { padding: 20px 26px 40px; }

        .selectWrap { display: flex; flex-direction: column; gap: 4px; }
        .selectLabel { font-size: 9.5px; letter-spacing: 0.6px; color: ${C.textFaint}; font-weight: 600; }
        .selectBox { display: flex; align-items: center; gap: 6px; background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 7px; padding: 6px 8px; }
        .selectBox select { background: transparent; border: none; color: ${C.text}; font-size: 12px; appearance: none; cursor: pointer; }
        .selectBox select option { background: ${C.panel}; }
        .bellWrap { position: relative; width: 32px; height: 32px; border-radius: 8px; background: ${C.panel}; border: 1px solid ${C.border}; display: flex; align-items: center; justify-content: center; }
        .bellDot { position: absolute; top: 7px; right: 7px; width: 6px; height: 6px; border-radius: 4px; background: ${C.red}; }

        .card { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .cardHead { display: flex; justify-content: space-between; align-items: center; padding: 13px 18px; border-bottom: 1px solid ${C.border}; }
        .cardTitle { font-size: 12.8px; font-weight: 600; letter-spacing: 0.1px; }
        .tag { font-size: 9.5px; background: ${C.teal}33; color: ${C.tealLight}; padding: 1px 6px; border-radius: 5px; font-weight: 600; }

        .alertBar { display: flex; align-items: center; gap: 10px; background: ${C.amber}14; border: 1px solid ${C.amber}44; color: ${C.text}; padding: 10px 16px; border-radius: 10px; font-size: 12.5px; margin-bottom: 16px; line-height: 1.5; }

        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        @media (max-width: 1100px) { .grid3 { grid-template-columns: 1fr 1fr; } .grid4 { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 800px) { .grid2, .grid3, .grid4 { grid-template-columns: 1fr; } .sidebar { display: none; } }

        .kpi { background: ${C.panel}; border: 1px solid ${C.border}; border-radius: 12px; padding: 14px 16px; }
        .kpiTop { display: flex; justify-content: space-between; align-items: flex-start; }
        .kpiLabel { font-size: 11px; color: ${C.textDim}; }
        .kpiIconWrap { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
        .kpiValue { font-family: 'Space Grotesk', sans-serif; font-size: 24px; font-weight: 700; margin-top: 8px; }
        .kpiDelta { display: flex; align-items: center; gap: 3px; font-size: 11px; margin-top: 6px; }

        .rankRow { display: flex; align-items: center; gap: 10px; }
        .rankNo { width: 18px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: ${C.textFaint}; }
        .tagRegion { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; }

        .miniStat { flex: 1; background: ${C.panel2}; border: 1px solid ${C.border}; border-radius: 9px; padding: 10px 12px; text-align: center; }
        .miniStatVal { font-family: 'Space Grotesk', sans-serif; font-size: 19px; font-weight: 700; }
        .miniStatLbl { font-size: 10px; color: ${C.textFaint}; margin-top: 2px; }

        .tableWrap { overflow-y: auto; }
        .dataTable { width: 100%; border-collapse: collapse; font-size: 12px; }
        .dataTable th { text-align: left; color: ${C.textFaint}; font-weight: 600; font-size: 10.5px; letter-spacing: 0.3px; padding: 6px 10px; border-bottom: 1px solid ${C.border}; position: sticky; top: 0; background: ${C.panel}; }
        .dataTable td { padding: 7px 10px; border-bottom: 1px solid ${C.border}66; color: ${C.text}; }
        .dataTable tr:hover td { background: ${C.panelAlt}; }

        .sliderGrid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 22px; }
        @media (max-width: 900px) { .sliderGrid { grid-template-columns: 1fr; } }
        .sliderItem input[type=range] { width: 100%; accent-color: ${C.azure}; }
        .sliderLbl { font-size: 11.5px; color: ${C.textDim}; margin-bottom: 8px; }
        .sliderLbl strong { color: ${C.text}; font-family: 'IBM Plex Mono', monospace; }

        .funnelTrack { background: ${C.panel2}; border-radius: 5px; height: 10px; overflow: hidden; }
        .funnelFill { height: 100%; border-radius: 5px; }
        .warnPill { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: ${C.textDim}; background: ${C.panel2}; border: 1px solid ${C.border}; padding: 4px 9px; border-radius: 20px; }
      `}</style>

      <Sidebar page={page} setPage={setPage} />
      <div className="main">
        <TopBar title={meta.title} subtitle={meta.sub} filters={filters} setFilters={setFilters} />
        <div className="content">
          {page === 'overview' && <OverviewPage filters={filters} />}
          {page === 'hotspot' && <HotspotPage filters={filters} />}
          {page === 'model' && <ModelPage />}
          {page === 'iptp' && <IPTpPage />}
          {page === 'intervention' && <InterventionPage />}
          {page === 'priority' && <PriorityPage />}
        </div>
      </div>
    </div>
  );
}
