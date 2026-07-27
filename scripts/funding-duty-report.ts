/**
 * Funder 值班日报自动生成脚本
 *
 * 运行：npx tsx scripts/funding-duty-report.ts
 *
 * 流程：
 *   1. 从 ~/.grafana_cookie.json 读取并验证 Grafana Cookie
 *   2. 通过 Grafana /api/ds/query 批量范围查询 Dashboard 所有 Panel (Prometheus range, step=15m)
 *   3. 对每个序列计算统计特征 (mean/max/min/stddev/trend/spikes)
 *   4. 规则引擎异常预检测，标记 normal/warning/critical
 *   5. 两层输出：异常层完整统计 + 正常层汇总
 *   6. 调用 LLM 做根因分析和关联分析
 *   7. 通过 Gmail API 发送 HTML 邮件
 *   8. 通过 IPC 通知 WhatsApp 用户
 *
 * .env 配置：
 *   FUNDING_DUTY_RECIPIENT=huanyu.guo@shopee.com  (逗号分隔多个收件人)
 */
import fs from 'fs';
import path from 'path';

// ── 加载 .env ──────────────────────────────────────────
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── 常量 ──────────────────────────────────────────────
const NANOCLAW_DIR = process.cwd();
const GRAFANA_BASE = 'https://monitoring.infra.sz.shopee.io/grafana';
const DASHBOARD_UID = 'Ia35Utv4k';
const COOKIE_PATH = path.join(process.env.HOME || '/Users/huanyu.guo', '.grafana_cookie.json');
const RECIPIENT = process.env.FUNDING_DUTY_RECIPIENT || process.env.ON_DUTY_RECIPIENT || 'huanyu.guo@shopee.com';
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = '8619860743536@s.whatsapp.net';
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const GMAIL_CRED_DIR = path.join(process.env.HOME || '/Users/huanyu.guo', '.gmail-mcp');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const MODEL_NAME = process.env.MODEL_NAME || 'QwQ-32B';

function loadModelsFromConfig(): string[] {
  try {
    const configPath = path.join(process.cwd(), 'config', 'duty-dashboards', 'funding.yaml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/^models:\s*\n((?:\s+-\s+.+\n?)+)/m);
      if (match) {
        const models = match[1]
          .split('\n')
          .map(line => line.replace(/^\s*-\s*"?([^"]*)"?\s*$/, '$1').trim())
          .filter(Boolean);
        if (models.length > 0) return models;
      }
    }
  } catch { /* fall through */ }
  return [];
}

const DUTY_MODELS: string[] = (() => {
  const fromYaml = loadModelsFromConfig();
  if (fromYaml.length > 0) return fromYaml;
  if (process.env.DUTY_MODELS) {
    return process.env.DUTY_MODELS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [MODEL_NAME];
})();
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY || '';
const TASK_ID = process.env.DUTY_TASK_ID || '';
const TASK_TAG = TASK_ID ? `[${TASK_ID}] ` : '';

const CONCURRENCY = 5;
const BATCH_SIZE = 15;
const RANGE_STEP_MS = 900_000;       // 15 minutes
const RANGE_MAX_POINTS = 96;         // 24h / 15min
const MAX_SERIES_PER_PANEL = 5;
const MAX_REPORT_CHARS = 10000;

// ── 类型定义 ──────────────────────────────────────────

interface CookieConfig {
  grafana_session: string;
  updated_at: string;
  expires_at: string;
}

interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  collapsed?: boolean;
  datasource?: { type?: string; uid?: string } | string;
  targets?: GrafanaTarget[];
  panels?: GrafanaPanel[];
}

interface GrafanaTarget {
  refId?: string;
  expr?: string;
  legendFormat?: string;
  datasource?: { type?: string; uid?: string };
  [key: string]: unknown;
}

interface RowGroup {
  rowTitle: string;
  panels: PanelInfo[];
}

interface PanelInfo {
  title: string;
  type: string;
  targets: ResolvedTarget[];
}

interface ResolvedTarget {
  panelTitle: string;
  refId: string;
  dsUid: string;
  legendFormat: string;
  target: GrafanaTarget;
}

interface TimeSeriesPoint {
  time: number;
  value: number;
}

interface SeriesStats {
  label: string;
  latest: number | null;
  mean: number;
  max: number;
  min: number;
  stddev: number;
  trend: 'rising' | 'falling' | 'stable';
  trendPct: number;
  spikeCount: number;
  zeroCount: number;
  changeRate: number;
  dataPoints: number;
}

type Severity = 'normal' | 'warning' | 'critical';

interface PanelDiagnosis {
  panelTitle: string;
  rowTitle: string;
  severity: Severity;
  reasons: string[];
  stats: SeriesStats[];
}

// ── 日志 ──────────────────────────────────────────────
function getLogPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `funding-duty-${y}-${m}-${day}.log`);
}

function log(msg: string): void {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogPath(), line + '\n');
  } catch { /* ignore */ }
}

// ── IPC ──────────────────────────────────────────────
function sendIpcAlert(text: string): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const file = path.join(IPC_DIR, `funding-duty-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', chatJid: CHAT_JID, text }, null, 0), 'utf-8');
  log(`IPC 已写入: ${file}`);
}

// ── 1. Grafana 认证 ───────────────────────────────────

function loadSession(): string {
  if (GRAFANA_API_KEY) return '';
  if (!fs.existsSync(COOKIE_PATH)) {
    throw new Error(`GRAFANA_API_KEY 未配置且 Cookie 文件不存在: ${COOKIE_PATH}`);
  }
  const cfg: CookieConfig = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
  if (!cfg.grafana_session) throw new Error('grafana_session 为空');
  if (cfg.expires_at && new Date(cfg.expires_at) < new Date()) {
    log(`Cookie 已过期 (${cfg.expires_at})，仍然尝试验证...`);
  }
  return cfg.grafana_session;
}

function grafanaHeaders(session: string): Record<string, string> {
  const h: Record<string, string> = { 'X-Grafana-Org-Id': '28' };
  if (GRAFANA_API_KEY) {
    h['Authorization'] = `Bearer ${GRAFANA_API_KEY}`;
  } else {
    h['Cookie'] = `grafana_session=${session}`;
  }
  return h;
}

async function validateGrafana(session: string): Promise<boolean> {
  try {
    const res = await fetch(`${GRAFANA_BASE}/api/dashboards/uid/${DASHBOARD_UID}`, {
      headers: grafanaHeaders(session),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 2. Grafana API ───────────────────────────────────

async function grafanaGet(urlPath: string, session: string): Promise<unknown> {
  const res = await fetch(`${GRAFANA_BASE}${urlPath}`, {
    headers: grafanaHeaders(session),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grafana GET ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function grafanaPost(urlPath: string, session: string, body: string): Promise<unknown> {
  const res = await fetch(`${GRAFANA_BASE}${urlPath}`, {
    method: 'POST',
    headers: { ...grafanaHeaders(session), 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grafana POST ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── 3. Dashboard 解析 ────────────────────────────────

const TEMPLATE_VARS: Record<string, string> = {
  '$sample_period': '1m',
  '${sample_period}': '1m',
};

function populateTemplateVarsFromDashboard(
  templating?: { list?: Array<{ name?: string; type?: string; current?: { value?: string; text?: string }; options?: Array<{ value?: string; text?: string; selected?: boolean }> }> },
): void {
  if (!templating?.list) return;
  for (const v of templating.list) {
    if (!v.name) continue;
    let val = v.current?.value ?? '';
    if (val === '$__all' || val === 'All' || val === '') {
      const firstOption = v.options?.find(o => o.value && o.value !== '$__all');
      val = firstOption?.value ?? '.*';
    }
    if (TEMPLATE_VARS[`$${v.name}`] !== undefined) continue;
    TEMPLATE_VARS[`$${v.name}`] = val;
    TEMPLATE_VARS[`\${${v.name}}`] = val;
    log(`模板变量: $${v.name} = ${val}`);
  }
}

function replaceTemplateVars(expr: string): string {
  let result = expr;
  for (const [k, v] of Object.entries(TEMPLATE_VARS)) {
    result = result.split(k).join(v);
  }
  result = result.replace(/\$\w+/g, (match) => {
    if (match.startsWith('$__')) return match;
    return match;
  });
  return result;
}

let _dashboardDefaultDsUid: string | null = null;

function resolveTargetDsUid(panel: GrafanaPanel, target: GrafanaTarget): string | null {
  const tds = target.datasource;
  if (tds && typeof tds === 'object' && tds.uid && tds.uid !== '-- Mixed --') {
    return tds.uid;
  }
  const pds = panel.datasource;
  if (pds && typeof pds === 'object' && pds.uid && pds.uid !== '-- Mixed --') {
    return pds.uid;
  }
  if (_dashboardDefaultDsUid) {
    return _dashboardDefaultDsUid;
  }
  return null;
}

interface PanelSkipRecord {
  title: string;
  type: string;
  reason: string;
}

const _skippedPanels: PanelSkipRecord[] = [];

function extractRowGroups(panels: GrafanaPanel[]): RowGroup[] {
  const groups: RowGroup[] = [];
  let currentRow = '(未分组)';
  _skippedPanels.length = 0;

  for (const p of panels) {
    if (p.type === 'row') {
      const title = p.title.replace(/[-─]+/g, '').trim();
      if (title) currentRow = title;

      if (p.collapsed && p.panels?.length) {
        const panelInfos: PanelInfo[] = [];
        for (const np of p.panels) {
          if (np.type === 'text') {
            _skippedPanels.push({ title: np.title, type: np.type, reason: 'text 类型' });
            continue;
          }
          if (!np.targets?.length) {
            _skippedPanels.push({ title: np.title, type: np.type, reason: '无 targets' });
            continue;
          }
          const targets = resolveTargets(np);
          if (targets.length > 0) {
            panelInfos.push({ title: np.title, type: np.type, targets });
          } else {
            _skippedPanels.push({ title: np.title, type: np.type, reason: 'datasource 解析失败' });
          }
        }
        if (panelInfos.length > 0) {
          groups.push({ rowTitle: currentRow, panels: panelInfos });
        }
      }
      continue;
    }

    if (p.type === 'text') {
      _skippedPanels.push({ title: p.title, type: p.type, reason: 'text 类型' });
      continue;
    }
    if (!p.targets?.length) {
      if (p.type !== 'row') {
        _skippedPanels.push({ title: p.title, type: p.type, reason: '无 targets' });
      }
      continue;
    }
    const targets = resolveTargets(p);
    if (targets.length > 0) {
      let group = groups.find(g => g.rowTitle === currentRow);
      if (!group) {
        group = { rowTitle: currentRow, panels: [] };
        groups.push(group);
      }
      group.panels.push({ title: p.title, type: p.type, targets });
    } else {
      _skippedPanels.push({ title: p.title, type: p.type, reason: 'datasource 解析失败' });
    }
  }

  if (_skippedPanels.length > 0) {
    log(`跳过 ${_skippedPanels.length} 个面板:`);
    for (const sp of _skippedPanels) {
      log(`  - "${sp.title}" (type=${sp.type}): ${sp.reason}`);
    }
  }

  return groups;
}

function resolveTargets(panel: GrafanaPanel): ResolvedTarget[] {
  const resolved: ResolvedTarget[] = [];
  for (const t of panel.targets ?? []) {
    const dsUid = resolveTargetDsUid(panel, t);
    if (!dsUid) continue;
    if (!t.expr) continue;

    resolved.push({
      panelTitle: panel.title,
      refId: t.refId || 'A',
      dsUid,
      legendFormat: t.legendFormat || '',
      target: {
        ...t,
        expr: replaceTemplateVars(t.expr),
      },
    });
  }
  return resolved;
}

// ── 4. 批量范围查询 ─────────────────────────────────

interface QueryJob {
  dsUid: string;
  targets: ResolvedTarget[];
}

interface DsQueryFrame {
  schema?: {
    fields?: Array<{
      name: string;
      labels?: Record<string, string>;
    }>;
  };
  data?: { values?: unknown[][] };
}

interface DsQueryResult {
  results?: Record<string, {
    frames?: DsQueryFrame[];
    error?: string;
  }>;
}

interface RawSeriesData {
  label: string;
  legendFormat: string;
  labels: Record<string, string>;
  points: TimeSeriesPoint[];
}

function buildQueryJobs(groups: RowGroup[]): QueryJob[] {
  const byDs = new Map<string, ResolvedTarget[]>();

  for (const g of groups) {
    for (const p of g.panels) {
      for (const t of p.targets) {
        let arr = byDs.get(t.dsUid);
        if (!arr) { arr = []; byDs.set(t.dsUid, arr); }
        arr.push(t);
      }
    }
  }

  const jobs: QueryJob[] = [];
  for (const [dsUid, targets] of byDs) {
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      jobs.push({ dsUid, targets: targets.slice(i, i + BATCH_SIZE) });
    }
  }
  return jobs;
}

async function runQueryJob(
  job: QueryJob,
  session: string,
  from: number,
  to: number,
): Promise<Map<string, RawSeriesData[]>> {
  const resultMap = new Map<string, RawSeriesData[]>();

  const queries = job.targets.map(t => ({
    datasource: { uid: t.dsUid },
    expr: t.target.expr,
    refId: t.refId,
    instant: false,
    maxDataPoints: RANGE_MAX_POINTS,
    intervalMs: RANGE_STEP_MS,
  }));

  const payload = {
    queries,
    from: String(from),
    to: String(to),
  };

  const raw = await grafanaPost('/api/ds/query', session, JSON.stringify(payload)) as DsQueryResult;

  if (!raw.results) return resultMap;

  for (const t of job.targets) {
    const key = `${t.panelTitle}::${t.refId}`;
    const refResult = raw.results[t.refId];
    if (!refResult?.frames?.length) {
      resultMap.set(key, []);
      continue;
    }

    const seriesList: RawSeriesData[] = [];
    for (const frame of refResult.frames) {
      const fields = frame.schema?.fields ?? [];
      const values = frame.data?.values ?? [];

      const timeIdx = fields.findIndex(f => f.name === 'Time' || f.name === 'time');
      const valueField = fields.find(f => f.name !== 'Time' && f.name !== 'time');
      const valueIdx = valueField ? fields.indexOf(valueField) : -1;
      if (valueIdx < 0) continue;

      const labels = valueField?.labels ?? {};
      const times = (timeIdx >= 0 ? values[timeIdx] : []) as number[];
      const vals = values[valueIdx] as number[];

      const points: TimeSeriesPoint[] = [];
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (typeof v === 'number' && !Number.isNaN(v)) {
          points.push({ time: times[i] ?? 0, value: v });
        }
      }

      let label = t.legendFormat;
      if (label) {
        for (const [k, v] of Object.entries(labels)) {
          label = label.split(`{{${k}}}`).join(v);
        }
        label = label.replace(/\{\{[^}]+\}\}/g, '').trim();
      }
      if (!label) {
        const lv = Object.values(labels);
        label = lv.length === 0 ? 'total' : lv.length === 1 ? lv[0] : lv.join('/');
      }

      seriesList.push({ label, legendFormat: t.legendFormat, labels, points });
    }
    resultMap.set(key, seriesList);
  }

  return resultMap;
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

// ── 5. 统计特征引擎 ─────────────────────────────────

function computeSeriesStats(series: RawSeriesData): SeriesStats {
  const pts = series.points;
  if (pts.length === 0) {
    return {
      label: series.label,
      latest: null, mean: 0, max: 0, min: 0, stddev: 0,
      trend: 'stable', trendPct: 0, spikeCount: 0, zeroCount: 0,
      changeRate: 0, dataPoints: 0,
    };
  }

  const values = pts.map(p => p.value);
  const n = values.length;
  const latest = values[n - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const max = Math.max(...values);
  const min = Math.min(...values);

  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  const spikeThreshold = mean + 3 * stddev;
  const spikeCount = stddev > 0 ? values.filter(v => v > spikeThreshold).length : 0;
  const zeroCount = values.filter(v => v === 0).length;

  // Linear regression for trend
  let trend: 'rising' | 'falling' | 'stable' = 'stable';
  let trendPct = 0;
  if (n >= 4) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const totalChange = slope * (n - 1);
    const baseline = mean || 1;
    trendPct = (totalChange / baseline) * 100;

    if (trendPct > 10) trend = 'rising';
    else if (trendPct < -10) trend = 'falling';
  }

  const earliest = values[0];
  const changeRate = earliest !== 0 ? ((latest - earliest) / Math.abs(earliest)) * 100 : 0;

  return {
    label: series.label,
    latest, mean, max, min, stddev,
    trend, trendPct, spikeCount, zeroCount,
    changeRate, dataPoints: n,
  };
}

// ── 6. 异常预检测 ────────────────────────────────────

interface AnomalyRule {
  match: (title: string) => boolean;
  check: (stats: SeriesStats[]) => { severity: Severity; reasons: string[] };
}

const MAX_REASONS_PER_PANEL = 3;

const ANOMALY_RULES: AnomalyRule[] = [
  {
    match: (t) => /MQ堆积|lag|积压|backlog/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.latest !== null && s.latest > 50000) {
          sev = 'critical';
          reasons.push(`${s.label} 堆积=${fmt(s.latest)}`);
        } else if (s.latest !== null && s.latest > 5000) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} 堆积=${fmt(s.latest)}`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /CPU|cpu/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.max > 90) {
          sev = 'critical';
          reasons.push(`${s.label} max=${fmt(s.max)}%`);
        } else if (s.max > 80 || (s.latest !== null && s.latest > 80)) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} latest=${fmt(s.latest)}%, max=${fmt(s.max)}%`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /内存|memory|mem/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.max > 95) {
          sev = 'critical';
          reasons.push(`${s.label} max=${fmt(s.max)}%`);
        } else if (s.max > 85 || (s.latest !== null && s.latest > 85)) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} latest=${fmt(s.latest)}%, max=${fmt(s.max)}%`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /DB耗时|db.*耗时|latency|p50|p99/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.max > 10000) {
          sev = 'critical';
          reasons.push(`${s.label} max=${fmt(s.max)}ms`);
        } else if (s.max > 2000 || (s.latest !== null && s.latest > 2000)) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} P50=${fmt(s.latest)}ms, max=${fmt(s.max)}ms`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /卡单|stuck|pending/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.latest !== null && s.latest > 0) {
          sev = 'critical';
          reasons.push(`${s.label} 卡单=${fmt(s.latest)}`);
        } else if (s.max > 0) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} 24h内最大卡单=${fmt(s.max)}`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /探活|health|alive/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.latest !== null && s.latest < 10) {
          sev = 'critical';
          reasons.push(`${s.label} 探活=${fmt(s.latest)} (期望10)`);
        } else if (s.min < 10) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} 24h内最低=${fmt(s.min)}`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
  {
    match: (t) => /KMS|kms/i.test(t),
    check: (stats) => {
      const reasons: string[] = [];
      let sev: Severity = 'normal';
      for (const s of stats) {
        if (s.latest !== null && s.latest === 0) {
          sev = 'critical';
          reasons.push(`${s.label} KMS获取失败`);
        }
      }
      return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
    },
  },
];

function detectAnomaliesGeneric(stats: SeriesStats[]): { severity: Severity; reasons: string[] } {
  const reasons: string[] = [];
  let sev: Severity = 'normal';

  for (const s of stats) {
    // Skip series with very small absolute values to avoid noise
    if (Math.abs(s.mean) < 1 && Math.abs(s.max) < 1) continue;

    if (s.spikeCount >= 5) {
      if (sev === 'normal') sev = 'warning';
      reasons.push(`${s.label} 出现${s.spikeCount}次尖峰(>3sigma)`);
    }
    if (s.trend === 'rising' && s.trendPct > 100) {
      if (sev === 'normal') sev = 'warning';
      reasons.push(`${s.label} 持续上升(+${fmt(s.trendPct)}%)`);
    }
    if (s.stddev > 0 && s.latest !== null && Math.abs(s.latest) > 10) {
      const z = Math.abs(s.latest - s.mean) / s.stddev;
      if (z > 4) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 当前值偏离均值(Z=${z.toFixed(1)})`);
      }
    }
  }

  return { severity: sev, reasons: reasons.slice(0, MAX_REASONS_PER_PANEL) };
}

interface PanelDataSkipRecord {
  panelTitle: string;
  rowTitle: string;
  reason: string;
}

const _noDataPanels: PanelDataSkipRecord[] = [];

function diagnosePanels(groups: RowGroup[], dataMap: Map<string, RawSeriesData[]>): PanelDiagnosis[] {
  const diagnoses: PanelDiagnosis[] = [];
  _noDataPanels.length = 0;

  for (const group of groups) {
    for (const panel of group.panels) {
      const allSeries: RawSeriesData[] = [];
      for (const t of panel.targets) {
        const key = `${t.panelTitle}::${t.refId}`;
        const series = dataMap.get(key);
        if (series) allSeries.push(...series);
      }

      const withData = allSeries.filter(s => s.points.length > 0);
      if (withData.length === 0) {
        _noDataPanels.push({
          panelTitle: panel.title,
          rowTitle: group.rowTitle,
          reason: allSeries.length === 0 ? '查询无返回' : '所有序列数据点为空',
        });
        continue;
      }

      const stats = withData.map(computeSeriesStats);

      let severity: Severity = 'normal';
      let reasons: string[] = [];

      const matchedRule = ANOMALY_RULES.find(r => r.match(panel.title));
      if (matchedRule) {
        const result = matchedRule.check(stats);
        severity = result.severity;
        reasons = result.reasons;
      }

      const generic = detectAnomaliesGeneric(stats);
      if (severityRank(generic.severity) > severityRank(severity)) {
        severity = generic.severity;
      }
      reasons.push(...generic.reasons);

      // Keep top series by absolute latest value
      stats.sort((a, b) => Math.abs(b.latest ?? 0) - Math.abs(a.latest ?? 0));
      const topStats = stats.slice(0, MAX_SERIES_PER_PANEL);

      const uniqueReasons = [...new Set(reasons)].slice(0, MAX_REASONS_PER_PANEL);

      diagnoses.push({
        panelTitle: panel.title,
        rowTitle: group.rowTitle,
        severity,
        reasons: uniqueReasons,
        stats: topStats,
      });
    }
  }

  if (_noDataPanels.length > 0) {
    log(`${_noDataPanels.length} 个面板无数据:`);
    for (const nd of _noDataPanels) {
      log(`  - "${nd.rowTitle} / ${nd.panelTitle}": ${nd.reason}`);
    }
  }

  return diagnoses;
}

function severityRank(s: Severity): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}

// ── 7. 数据获取 ──────────────────────────────────────

async function fetchAllPanelData(session: string): Promise<{ groups: RowGroup[]; dataMap: Map<string, RawSeriesData[]>; totalRawPanels: number }> {
  log(`获取 Dashboard ${DASHBOARD_UID}...`);
  const dashResp = await grafanaGet(`/api/dashboards/uid/${DASHBOARD_UID}`, session) as {
    dashboard: { panels: GrafanaPanel[]; title: string; templating?: { list?: Array<{ name?: string; type?: string; current?: { value?: string; text?: string }; query?: string; options?: Array<{ value?: string; text?: string; selected?: boolean }> }> } };
  };

  log(`Dashboard: ${dashResp.dashboard.title}`);

  populateTemplateVarsFromDashboard(dashResp.dashboard.templating as Parameters<typeof populateTemplateVarsFromDashboard>[0]);

  const allPanels = dashResp.dashboard.panels ?? [];
  const countRawPanels = (panels: GrafanaPanel[]): number => {
    let count = 0;
    for (const p of panels) {
      if (p.type === 'row') {
        if (p.collapsed && p.panels?.length) count += p.panels.length;
      } else {
        count++;
      }
    }
    return count;
  };
  const totalRawPanels = countRawPanels(allPanels);

  const firstPanel = allPanels.find(p => p.type !== 'row' && p.datasource);
  if (firstPanel?.datasource && typeof firstPanel.datasource === 'object' && firstPanel.datasource.uid) {
    _dashboardDefaultDsUid = firstPanel.datasource.uid;
    log(`Dashboard 默认 datasource UID: ${_dashboardDefaultDsUid}`);
  }

  const groups = extractRowGroups(allPanels);
  const totalPanels = groups.reduce((s, g) => s + g.panels.length, 0);
  const totalTargets = groups.reduce((s, g) => s + g.panels.reduce((s2, p) => s2 + p.targets.length, 0), 0);
  log(`解析完成: ${groups.length} 个分组, ${totalPanels} 个 Panel, ${totalTargets} 个查询目标`);

  const jobs = buildQueryJobs(groups);
  log(`构建 ${jobs.length} 个批量查询任务 (并发=${CONCURRENCY}, 批大小=${BATCH_SIZE}, step=15m)`);

  const now = Date.now();
  const from = now - 24 * 60 * 60 * 1000;

  const batchResults = await runWithConcurrency(
    jobs.map(job => () => runQueryJob(job, session, from, now).catch(err => {
      log(`查询批次失败 (ds=${job.dsUid}): ${err instanceof Error ? err.message : String(err)}`);
      return new Map<string, RawSeriesData[]>();
    })),
    CONCURRENCY,
  );

  const merged = new Map<string, RawSeriesData[]>();
  for (const batch of batchResults) {
    for (const [k, v] of batch) {
      const existing = merged.get(k);
      if (existing) {
        existing.push(...v);
      } else {
        merged.set(k, v);
      }
    }
  }

  const successCount = [...merged.values()].filter(v => v.length > 0).length;
  log(`数据获取完成: ${successCount}/${merged.size} 个查询有数据`);

  return { groups, dataMap: merged, totalRawPanels };
}

// ── 8. 构建 LLM 输入 ────────────────────────────────

function isMegaSalePeriod(date: Date = new Date()): { active: boolean; saleName: string; dayOffset: number } {
  const tz = 'Asia/Shanghai';
  const local = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const month = local.getMonth() + 1;
  const day = local.getDate();

  const saleDates = [
    { m: 1, d: 1 }, { m: 2, d: 2 }, { m: 3, d: 3 }, { m: 4, d: 4 },
    { m: 5, d: 5 }, { m: 6, d: 6 }, { m: 7, d: 7 }, { m: 8, d: 8 },
    { m: 9, d: 9 }, { m: 10, d: 10 }, { m: 11, d: 11 }, { m: 12, d: 12 },
  ];

  for (const sale of saleDates) {
    const saleDate = new Date(local.getFullYear(), sale.m - 1, sale.d);
    const diffMs = local.getTime() - saleDate.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

    if (Math.abs(diffDays) <= 2) {
      const saleName = `${sale.m}.${sale.d}`;
      return { active: true, saleName, dayOffset: diffDays };
    }
  }

  return { active: false, saleName: '', dayOffset: 0 };
}

function getMegaSaleContext(): string {
  const { active, saleName, dayOffset } = isMegaSalePeriod();
  if (!active) return '';

  const offsetDesc = dayOffset === 0 ? '大促当天'
    : dayOffset > 0 ? `大促后第${dayOffset}天`
    : `大促前第${Math.abs(dayOffset)}天`;

  return `当前处于 Shopee ${saleName} 大促期间（${offsetDesc}），交易量、延迟等指标波动属于正常现象，请在分析中充分考虑大促因素，避免将大促导致的正常流量增长标记为异常。`;
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'N/A';
  if (Number.isNaN(v)) return 'NaN';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function buildReportText(diagnoses: PanelDiagnosis[], totalRawPanels = 0): string {
  const lines: string[] = [];
  lines.push('=== Funder (A大促) Grafana 24h 巡查报告 ===');
  lines.push('时间窗口: 最近24小时, 采样间隔: 15分钟');
  const megaSale = getMegaSaleContext();
  if (megaSale) lines.push(`[大促提醒] ${megaSale}`);
  lines.push('');

  const criticals = diagnoses.filter(d => d.severity === 'critical');
  const warnings = diagnoses.filter(d => d.severity === 'warning');
  const normals = diagnoses.filter(d => d.severity === 'normal');

  const withData = diagnoses.length;
  const noData = _noDataPanels.length;
  const skipped = _skippedPanels.length;
  lines.push(`面板统计: 总计 ${totalRawPanels} 个面板, 有数据 ${withData} 个, 无数据 ${noData} 个, 跳过 ${skipped} 个`);
  lines.push(`摘要: ${criticals.length} 个严重异常, ${warnings.length} 个告警, ${normals.length} 个正常`);
  lines.push('');

  // Tier 1: Critical and Warning panels with full detail
  if (criticals.length > 0) {
    lines.push('== [严重异常] ==');
    for (const d of criticals) {
      lines.push(`[CRITICAL] ${d.rowTitle} / ${d.panelTitle}`);
      lines.push(`  原因: ${d.reasons.join('; ')}`);
      for (const s of d.stats) {
        const trendStr = s.trend === 'stable' ? '平稳' : s.trend === 'rising' ? `上升(+${fmt(s.trendPct)}%)` : `下降(${fmt(s.trendPct)}%)`;
        lines.push(`  ${s.label}: latest=${fmt(s.latest)}, mean=${fmt(s.mean)}, max=${fmt(s.max)}, min=${fmt(s.min)}, stddev=${fmt(s.stddev)}, trend=${trendStr}, spikes=${s.spikeCount}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('== [告警] ==');
    for (const d of warnings) {
      lines.push(`[WARNING] ${d.rowTitle} / ${d.panelTitle}`);
      lines.push(`  原因: ${d.reasons.join('; ')}`);
      for (const s of d.stats) {
        const trendStr = s.trend === 'stable' ? '平稳' : s.trend === 'rising' ? `上升(+${fmt(s.trendPct)}%)` : `下降(${fmt(s.trendPct)}%)`;
        lines.push(`  ${s.label}: latest=${fmt(s.latest)}, mean=${fmt(s.mean)}, max=${fmt(s.max)}, trend=${trendStr}`);
      }
    }
    lines.push('');
  }

  // Tier 2: Normal panels - grouped summary
  if (normals.length > 0) {
    lines.push('== [正常] ==');
    const byRow = new Map<string, PanelDiagnosis[]>();
    for (const d of normals) {
      const arr = byRow.get(d.rowTitle) ?? [];
      arr.push(d);
      byRow.set(d.rowTitle, arr);
    }
    for (const [row, panels] of byRow) {
      const summaryParts = panels.slice(0, 3).map(d => {
        const topStat = d.stats[0];
        return topStat ? `${d.panelTitle}=${fmt(topStat.latest)}` : d.panelTitle;
      });
      const extra = panels.length > 3 ? ` (+${panels.length - 3}项)` : '';
      lines.push(`[OK] ${row}: ${summaryParts.join(', ')}${extra}`);
    }
    lines.push('');
  }

  let text = lines.join('\n');

  if (text.length > MAX_REPORT_CHARS) {
    text = text.slice(0, MAX_REPORT_CHARS) + '\n\n... (数据已截断)';
  }

  return text;
}

// ── 9. 历史基线存储 + LLM 分析 ──────────────────────────

import {
  storeMetrics, clearMetricsForDate, getBaselines, formatBaselinesForPrompt,
  filterRelevantBaselines, storeAnomalies, getAnomalyTracking,
  formatAnomalyTrackingForPrompt, closeDb,
  type DutyMetric, type AnomalyRecord,
} from './lib/duty-metrics-db.js';

function storeFundingDiagnoses(diagnoses: PanelDiagnosis[]): void {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  clearMetricsForDate(today, 'funding');

  const rows: DutyMetric[] = [];
  for (const d of diagnoses) {
    for (const s of d.stats) {
      if (s.latest !== null) {
        rows.push({
          date: today,
          reportType: 'funding',
          groupName: d.rowTitle || null,
          metricName: `${d.panelTitle}::${s.label}`,
          metricValue: s.latest,
        });
      }
    }
  }

  if (rows.length > 0) {
    storeMetrics(rows);
    log(`已存储 ${rows.length} 条 Funding 指标到历史数据库`);
  }
}

function getFundingBaselineText(diagnoses: PanelDiagnosis[]): string {
  const allBaselines = getBaselines('funding', 30);
  const abnormalKeys = diagnoses
    .filter(d => d.severity !== 'normal')
    .map(d => d.panelTitle);
  const relevant = filterRelevantBaselines(allBaselines, abnormalKeys);
  log(`基线过滤: ${allBaselines.length} 条全量 -> ${relevant.length} 条异常相关`);
  return formatBaselinesForPrompt(relevant);
}

const LLM_URL = OPENAI_BASE_URL
  ? `${OPENAI_BASE_URL}/chat/completions`
  : 'https://api.openai.com/v1/chat/completions';

async function callLLM(systemPrompt: string, userContent: string, maxTokens = 2048, modelName = MODEL_NAME): Promise<string> {
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('LLM 返回空内容');
  return content;
}

function buildPanelText(d: PanelDiagnosis): string {
  const lines: string[] = [];
  const tag = d.severity === 'critical' ? '[CRITICAL]' : d.severity === 'warning' ? '[WARNING]' : '[OK]';
  lines.push(`${tag} ${d.rowTitle} / ${d.panelTitle}`);
  if (d.reasons.length > 0) lines.push(`  原因: ${d.reasons.join('; ')}`);
  for (const s of d.stats) {
    const trendStr = s.trend === 'stable' ? '平稳' : s.trend === 'rising' ? `上升(+${fmt(s.trendPct)}%)` : `下降(${fmt(s.trendPct)}%)`;
    lines.push(`  ${s.label}: latest=${fmt(s.latest)}, mean=${fmt(s.mean)}, max=${fmt(s.max)}, min=${fmt(s.min)}, stddev=${fmt(s.stddev)}, trend=${trendStr}, spikes=${s.spikeCount}`);
  }
  return lines.join('\n');
}

async function stage1PerPanel(
  panel: PanelDiagnosis,
  panelBaseline: string,
  modelName: string,
  megaSaleContext: string,
): Promise<string | null> {
  const panelText = buildPanelText(panel);
  const baselineBlock = panelBaseline
    ? `\n历史基线：\n${panelBaseline}\n`
    : '';
  const megaSaleBlock = megaSaleContext ? `\n${megaSaleContext}\n` : '';
  const prompt = `你是一名金融科技值班分析师。以下是单个 Grafana 面板的监控数据，[CRITICAL]/[WARNING] 为预检测标记。
${baselineBlock}${megaSaleBlock}
判断这个面板是否存在真正的异常（排除历史基线范围内的正常波动）。

如果是真正的异常，输出一行：
${panel.panelTitle} | {严重程度:严重/告警} | {一句话原因}

如果不是真正的异常，输出一行：无异常`;

  try {
    const result = await callLLM(prompt, panelText, 256, modelName);
    const trimmed = result.trim();
    if (trimmed === '无异常' || trimmed.length < 5) return null;
    return trimmed;
  } catch (err) {
    log(`Stage1 per-panel 失败 [${panel.panelTitle}]: ${err instanceof Error ? err.message : String(err)}`);
    return `${panel.panelTitle} | ${panel.severity === 'critical' ? '严重' : '告警'} | ${panel.reasons[0] || '自动检测异常'}`;
  }
}

const STAGE1_CONCURRENCY = 5;

async function runPerPanelStage1(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  modelName: string,
  megaSaleContext: string,
): Promise<string> {
  const abnormals = diagnoses.filter(d => d.severity !== 'normal');
  if (abnormals.length === 0) return '无异常';

  log(`Stage 1 [${modelName}]: ${abnormals.length} 个异常面板并发确认 (并发=${STAGE1_CONCURRENCY})...`);
  const confirmed: string[] = [];

  for (let i = 0; i < abnormals.length; i += STAGE1_CONCURRENCY) {
    const batch = abnormals.slice(i, i + STAGE1_CONCURRENCY);
    const results = await Promise.all(
      batch.map(panel => {
        const relevantBaseline = baselineText
          .split('\n')
          .filter(line => line.includes(panel.panelTitle) || line.includes(panel.rowTitle))
          .join('\n');
        return stage1PerPanel(panel, relevantBaseline, modelName, megaSaleContext);
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const panelKey = `${batch[j].rowTitle}/${batch[j].panelTitle}`;
      if (results[j]) {
        confirmed.push(results[j]!);
        log(`  确认异常: ${panelKey}`);
      } else {
        log(`  排除误报: ${panelKey}`);
      }
    }
  }

  if (confirmed.length === 0) return '无异常';
  log(`Stage 1 完成 [${modelName}]: ${confirmed.length}/${abnormals.length} 确认为异常`);
  return confirmed.join('\n');
}

async function stage2CorrelationAndAction(confirmedAnomalies: string, modelName: string, megaSaleContext = ''): Promise<string> {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  log('Stage 2: 关联分析 + 行动建议...');
  const megaSaleBlock = megaSaleContext ? `\n注意：${megaSaleContext}\n` : '';

  const prompt = `你是一名金融科技值班分析师。以下是已确认的异常列表。
${megaSaleBlock}
请严格按照以下格式输出，不要使用 Markdown 标记（不要用 # * \` 等符号）：

[总体风险] 低/中/高
[一句话总结] （不超过30字描述整体状况）

[异常分析]
异常1: {面板名} | 原因: {一句话根因推断} | 建议: {一句话行动} | 紧急度: 立即处理/持续观察
异常2: ...
（没有异常则写"无"）

[关联发现]
（多个异常之间的关联。没有则写"无"）

[值班行动]
1. {最重要的事}
2. {次重要的事}
（按优先级排序，最多3条）

以下是一个好的输出示例：
---
[总体风险] 中
[一句话总结] MQ堆积导致部分支付处理延迟，但未影响核心链路

[异常分析]
异常1: MQ消费/topic-payment 堆积 | 原因: 下游消费者可能重启或GC | 建议: 检查消费者pod状态 | 紧急度: 持续观察
异常2: DB耗时/payment-db P99上升 | 原因: 慢查询增多 | 建议: 检查慢查询日志 | 紧急度: 持续观察

[关联发现]
MQ堆积与DB耗时上升可能相关：DB响应变慢导致消费者变慢，进而堆积

[值班行动]
1. 检查 payment-db 慢查询和连接池状态
2. 观察MQ堆积是否随DB恢复而消化
---

开头写"以下是 ${today} 的 Funder 值班巡查分析："`;

  const result = await callLLM(prompt, confirmedAnomalies, 2048, modelName);
  log(`Stage 2 完成 [${modelName}]: ${result.length} 字`);
  return result;
}

async function analyzeWithLLM(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  modelName: string,
  megaSaleContext: string,
): Promise<string> {
  log(`开始 per-panel LLM 分析 [${modelName}]...`);
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const stage1Result = await runPerPanelStage1(diagnoses, baselineText, modelName, megaSaleContext);

  if (stage1Result.trim() === '无异常' || stage1Result.trim().length < 5) {
    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return [
      `以下是 ${today} 的 Funder 值班巡查分析：`,
      '',
      '[总体风险] 低',
      '[一句话总结] 各项监控指标正常，无真实异常',
      '',
      '[异常分析]',
      '无',
      '',
      '[关联发现]',
      '无',
      '',
      '[值班行动]',
      '1. 各项指标正常，无需特别操作',
    ].join('\n');
  }

  return stage2CorrelationAndAction(stage1Result, modelName, megaSaleContext);
}

function validateLLMOutput(output: string): { valid: boolean; reason: string } {
  if (!output || output.length < 50) {
    return { valid: false, reason: '输出过短' };
  }
  const hasRiskLevel = /\[总体风险\]\s*(低|中|高)/.test(output);
  if (!hasRiskLevel) {
    return { valid: false, reason: '缺少 [总体风险] 字段' };
  }
  const hasSummary = /\[一句话总结\]/.test(output);
  if (!hasSummary) {
    return { valid: false, reason: '缺少 [一句话总结] 字段' };
  }
  const hasAnalysis = /\[异常分析\]/.test(output);
  if (!hasAnalysis) {
    return { valid: false, reason: '缺少 [异常分析] 字段' };
  }
  const hasAction = /\[值班行动\]/.test(output);
  if (!hasAction) {
    return { valid: false, reason: '缺少 [值班行动] 字段' };
  }
  const hasExcessiveMarkdown = /#{2,}|^\*\*|```/m.test(output);
  if (hasExcessiveMarkdown) {
    return { valid: false, reason: '包含 Markdown 格式' };
  }
  return { valid: true, reason: '' };
}

function buildRuleEngineFallback(diagnoses: PanelDiagnosis[]): string {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const criticals = diagnoses.filter(d => d.severity === 'critical');
  const warnings = diagnoses.filter(d => d.severity === 'warning');

  const riskLevel = criticals.length > 0 ? '高' : warnings.length > 0 ? '中' : '低';
  const lines: string[] = [];

  lines.push(`以下是 ${today} 的 Funder 值班巡查分析：`);
  lines.push('（注：LLM 分析不可用，以下为规则引擎自动生成）');
  lines.push('');
  lines.push(`[总体风险] ${riskLevel}`);
  lines.push(`[一句话总结] ${criticals.length} 个严重异常, ${warnings.length} 个告警`);
  lines.push('');
  lines.push('[异常分析]');

  if (criticals.length === 0 && warnings.length === 0) {
    lines.push('无');
  } else {
    let idx = 1;
    for (const d of [...criticals, ...warnings].slice(0, 10)) {
      const urgency = d.severity === 'critical' ? '立即处理' : '持续观察';
      lines.push(`异常${idx}: ${d.panelTitle} | 原因: ${d.reasons[0] || '自动检测异常'} | 建议: 检查面板详情 | 紧急度: ${urgency}`);
      idx++;
    }
  }

  lines.push('');
  lines.push('[关联发现]');
  lines.push('无（规则引擎无法做关联分析）');
  lines.push('');
  lines.push('[值班行动]');
  if (criticals.length > 0) {
    lines.push(`1. 立即检查以下严重异常面板: ${criticals.slice(0, 3).map(d => d.panelTitle).join(', ')}`);
  }
  if (warnings.length > 0) {
    lines.push(`${criticals.length > 0 ? '2' : '1'}. 持续观察告警面板趋势`);
  }
  if (criticals.length === 0 && warnings.length === 0) {
    lines.push('1. 各项指标正常，无需特别操作');
  }

  return lines.join('\n');
}

interface ModelAnalysis {
  modelName: string;
  analysis: string;
}

async function analyzeWithSingleModel(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  modelName: string,
  megaSaleContext: string,
): Promise<string> {
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const output = await analyzeWithLLM(diagnoses, baselineText, modelName, megaSaleContext);
      const { valid, reason } = validateLLMOutput(output);
      if (valid) {
        log(`LLM 输出校验通过 [${modelName}] (尝试 ${attempt})`);
        return output;
      }
      log(`LLM 输出校验失败 [${modelName}] (尝试 ${attempt}/${MAX_RETRIES}): ${reason}`);
    } catch (err) {
      log(`LLM 调用失败 [${modelName}] (尝试 ${attempt}/${MAX_RETRIES}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[${modelName}] 重试耗尽，降级为规则引擎输出`);
  return buildRuleEngineFallback(diagnoses);
}

async function analyzeWithAllModels(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  megaSaleContext: string,
): Promise<ModelAnalysis[]> {
  const results: ModelAnalysis[] = [];
  for (const modelName of DUTY_MODELS) {
    const analysis = await analyzeWithSingleModel(diagnoses, baselineText, modelName, megaSaleContext);
    results.push({ modelName, analysis });
  }
  return results;
}

// ── 10. 构建 HTML 邮件 ───────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function analysisToHtml(text: string): string {
  return escapeHtml(text)
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      let html = line;
      html = html.replace(/【异常】/g, '<span style="color:#e74c3c;font-weight:bold">【异常】</span>');
      return `<p style="margin:4px 0;line-height:1.6">${html}</p>`;
    })
    .join('');
}

function buildHtmlEmail(_reportText: string, modelResults: ModelAnalysis[], diagnoses: PanelDiagnosis[], today: string, totalRawPanels = 0): string {
  const criticals = diagnoses.filter(d => d.severity === 'critical');
  const warnings = diagnoses.filter(d => d.severity === 'warning');
  const normals = diagnoses.filter(d => d.severity === 'normal');

  const overallColor = criticals.length > 0 ? '#e74c3c' : warnings.length > 0 ? '#f39c12' : '#27ae60';
  const overallLabel = criticals.length > 0 ? '存在严重异常' : warnings.length > 0 ? '存在告警' : '全部正常';

  const severityBadge = (s: Severity) => {
    const colors = { critical: '#e74c3c', warning: '#f39c12', normal: '#27ae60' };
    const labels = { critical: 'CRITICAL', warning: 'WARNING', normal: 'OK' };
    return `<span style="background:${colors[s]};color:white;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:bold">${labels[s]}</span>`;
  };

  const anomalyRows = [...criticals, ...warnings].map(d => {
    const topStat = d.stats[0];
    return `<tr>
      <td style="padding:6px 10px;border:1px solid #e0e0e0">${severityBadge(d.severity)}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0">${escapeHtml(d.rowTitle)}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0">${escapeHtml(d.panelTitle)}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0">${escapeHtml(d.reasons.join('; '))}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${topStat ? escapeHtml(fmt(topStat.latest)) : '-'}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${topStat ? escapeHtml(fmt(topStat.mean)) : '-'}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${topStat ? escapeHtml(fmt(topStat.max)) : '-'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;max-width:900px;margin:0 auto;padding:20px">

<h2 style="color:#2c3e50;border-bottom:2px solid #e67e22;padding-bottom:10px;margin-bottom:20px">
  Funder 值班巡查报告 ${escapeHtml(today)}
</h2>

<div style="background:${overallColor}15;border-left:4px solid ${overallColor};padding:12px 16px;margin-bottom:20px;border-radius:4px">
  <span style="font-size:16px;font-weight:bold;color:${overallColor}">${overallLabel}</span>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <span style="color:#666">严重: ${criticals.length} &nbsp; 告警: ${warnings.length} &nbsp; 正常: ${normals.length}</span>
  <br/><span style="color:#999;font-size:12px">面板覆盖: 总计 ${totalRawPanels} 个, 有数据 ${diagnoses.length} 个, 无数据 ${_noDataPanels.length} 个, 解析跳过 ${_skippedPanels.length} 个</span>
</div>

${modelResults.map((mr, idx) => {
    const borderColor = idx === 0 ? '#f0c8a0' : '#c8a0f0';
    const bgColor = idx === 0 ? '#fff8f0' : '#f8f0ff';
    const titleColor = idx === 0 ? '#e67e22' : '#8e44ad';
    return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:16px 20px;margin-bottom:16px">
  <h3 style="color:${titleColor};margin:0 0 12px;font-size:15px">AI 巡查分析 - ${escapeHtml(mr.modelName)}</h3>
  ${analysisToHtml(mr.analysis)}
</div>`;
  }).join('')}

${anomalyRows.length > 0 ? `
<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">异常和告警明细</h3>
  <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:12px">
    <thead>
      <tr style="background:#f8f9fa">
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:left">级别</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:left">分组</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:left">面板</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:left">原因</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">最新值</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">均值</th>
        <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">最大值</th>
      </tr>
    </thead>
    <tbody>${anomalyRows}</tbody>
  </table>
</div>
` : ''}

<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">面板概览</h3>
  <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:12px">
    <thead>
      <tr style="background:#f8f9fa">
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left">分组</th>
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left">面板</th>
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">状态</th>
      </tr>
    </thead>
    <tbody>
      ${diagnoses.map(d => `<tr>
        <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(d.rowTitle)}</td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(d.panelTitle)}</td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center">${severityBadge(d.severity)}</td>
      </tr>`).join('')}
      ${_noDataPanels.map(nd => `<tr style="opacity:0.6">
        <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(nd.rowTitle)}</td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(nd.panelTitle)}</td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center"><span style="background:#95a5a6;color:white;padding:2px 6px;border-radius:3px;font-size:11px">无数据</span></td>
      </tr>`).join('')}
      ${_skippedPanels.map(sp => `<tr style="opacity:0.5">
        <td style="padding:4px 10px;border:1px solid #e0e0e0">-</td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(sp.title)} <span style="color:#999">(${escapeHtml(sp.type)})</span></td>
        <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center"><span style="background:#bdc3c7;color:white;padding:2px 6px;border-radius:3px;font-size:11px">跳过: ${escapeHtml(sp.reason)}</span></td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>

<div style="margin-top:30px;padding-top:12px;border-top:1px solid #eee;color:#95a5a6;font-size:11px">
  由 NanoClaw Funder-Duty Skill 自动生成 | 24h范围查询+统计聚合+异常预检测 | 分析模型: ${escapeHtml(modelResults.map(m => m.modelName).join(', '))}
</div>

</body>
</html>`;
}

// ── 11. Gmail 发送 ───────────────────────────────────

async function sendEmail(subject: string, htmlBody: string, recipients: string): Promise<void> {
  log(`发送邮件到 ${recipients}...`);

  const credPath = path.join(GMAIL_CRED_DIR, 'credentials.json');
  const keysPath = path.join(GMAIL_CRED_DIR, 'gcp-oauth.keys.json');
  if (!fs.existsSync(credPath)) {
    throw new Error(`Gmail 凭证不存在: ${credPath}\n请先完成 GCP OAuth 配置`);
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

  const clientId = keys.installed?.client_id || keys.web?.client_id;
  const clientSecret = keys.installed?.client_secret || keys.web?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('gcp-oauth.keys.json 格式错误');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token refresh failed: ${tokenRes.status} ${text.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json() as { access_token: string };
  const accessToken = tokenData.access_token;

  const from = credentials.email || 'me';
  const raw = Buffer.from(
    `From: ${from}\r\n` +
    `To: ${recipients}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n` +
    `\r\n` +
    htmlBody,
  ).toString('base64url');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`Gmail send failed: ${sendRes.status} ${text.slice(0, 300)}`);
  }

  log('邮件发送成功');
}

// ── 主流程 ──────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== Funder 值班巡查流程开始 ===');

  try {
    const session = loadSession();
    if (!await validateGrafana(session)) {
      throw new Error(
        GRAFANA_API_KEY
          ? 'Grafana API Key 无效，请检查 .env 中 GRAFANA_API_KEY'
          : 'Grafana Cookie 已失效，请更新 ~/.grafana_cookie.json 或配置 GRAFANA_API_KEY',
      );
    }
    log(GRAFANA_API_KEY ? 'API Key 验证通过' : 'Cookie 验证通过');

    const { groups, dataMap, totalRawPanels } = await fetchAllPanelData(session);

    log('计算统计特征和异常检测...');
    const diagnoses = diagnosePanels(groups, dataMap);

    const criticals = diagnoses.filter(d => d.severity === 'critical').length;
    const warnings = diagnoses.filter(d => d.severity === 'warning').length;
    const normals = diagnoses.filter(d => d.severity === 'normal').length;
    log(`诊断完成: ${criticals} critical, ${warnings} warning, ${normals} normal`);

    let baselineText = '';
    let trackingText = '';
    try {
      storeFundingDiagnoses(diagnoses);
      baselineText = getFundingBaselineText(diagnoses);
      log(`基线信息: ${baselineText.length > 0 ? baselineText.split('\n').length + ' 行' : '暂无历史数据'}`);

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      const currentAnomalies: AnomalyRecord[] = diagnoses
        .filter(d => d.severity !== 'normal')
        .map(d => ({
          key: `${d.rowTitle}/${d.panelTitle}`,
          severity: d.severity,
          reason: d.reasons[0] || '',
        }));
      const tracking = getAnomalyTracking(todayStr, 'funding', currentAnomalies);
      storeAnomalies(todayStr, 'funding', currentAnomalies);
      trackingText = formatAnomalyTrackingForPrompt(tracking);
      if (trackingText) {
        log(`异常追踪: ${tracking.continuing.length} 持续, ${tracking.newAnomalies.length} 新增, ${tracking.recovered.length} 已恢复`);
      }
    } catch (err) {
      log(`基线/追踪处理失败 (不影响报告): ${err instanceof Error ? err.message : String(err)}`);
    }

    const reportText = buildReportText(diagnoses, totalRawPanels);
    log(`报告文本 ${reportText.length} 字`);

    const combinedContext = [baselineText, trackingText].filter(Boolean).join('\n');
    const megaSaleContext = getMegaSaleContext();
    log(`使用 ${DUTY_MODELS.length} 个模型进行分析: ${DUTY_MODELS.join(', ')}`);
    const modelResults = await analyzeWithAllModels(diagnoses, combinedContext, megaSaleContext);

    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = `[值班巡查] ${today} Funder值班巡查报告${criticals > 0 ? ' [有异常]' : ''}`;
    const htmlBody = buildHtmlEmail(reportText, modelResults, diagnoses, today, totalRawPanels);

    try {
      await sendEmail(subject, htmlBody, RECIPIENT);
      const statusLine = criticals > 0
        ? `⚠️ 发现 ${criticals} 个严重异常, ${warnings} 个告警`
        : warnings > 0
          ? `⚡ 发现 ${warnings} 个告警，无严重异常`
          : `✅ 全部正常`;
      sendIpcAlert(`${TASK_TAG}Funder 值班巡查报告已发送\n${statusLine}\n收件人: ${RECIPIENT}\n主题: ${subject}`);
    } catch (emailErr) {
      log(`邮件发送失败: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`);
      sendIpcAlert(
        `${TASK_TAG}⚠️ Funder 值班巡查邮件发送失败，以下是分析结果：\n\n${analysis.slice(0, 3000)}`,
      );
    }

    log('=== Funder 值班巡查流程完成 ===');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`流程失败: ${msg}`);
    sendIpcAlert(`${TASK_TAG}❌ Funder 值班巡查生成失败: ${msg.slice(0, 500)}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
