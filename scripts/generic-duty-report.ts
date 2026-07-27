/**
 * Generic Grafana duty report runner - configuration driven.
 *
 * Usage:
 *   npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding.yaml
 *
 * This script:
 *   1. Loads a YAML config for the target dashboard
 *   2. Fetches all panels from Grafana via /api/ds/query (Prometheus range queries)
 *   3. Computes statistical features per series
 *   4. Runs config-defined anomaly rules + generic Z-score detection
 *   5. Stores metrics for historical baselines, tracks anomaly persistence
 *   6. Two-stage LLM analysis (anomaly confirmation -> correlation + action)
 *   7. Sends HTML email via Gmail API and IPC notification
 */
import fs from 'fs';
import path from 'path';
import {
  loadDutyConfig,
  compileAnomalyRules,
  buildGenericDetector,
  checkBaselineAnomalies,
  severityRank,
  buildStage1Prompt,
  buildStage2Prompt,
  validateLLMOutput,
  patchLLMOutput,
  renderSubjectTemplate,
  type DutyConfig,
  type SeriesStats,
  type Severity,
  type CompiledAnomalyRule,
  type BaselineEntry,
} from './lib/duty-config.js';
import {
  storeMetrics, clearMetricsForDate, getBaselines, formatBaselinesForPrompt,
  filterRelevantBaselines, storeAnomalies, getAnomalyTracking,
  formatAnomalyTrackingForPrompt, getYesterdayMetrics, getLastWeekMetrics,
  closeDb,
  type DutyMetric, type AnomalyRecord, type HistoricalMetricMap,
} from './lib/duty-metrics-db.js';
import {
  buildHtmlEmail as buildHtmlEmailShared,
  sendEmail as sendEmailShared,
  sendIpcAlert as sendIpcAlertShared,
  type EmailContext,
} from './lib/duty-email.js';

// ── Load .env ──────────────────────────────────────────
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Parse CLI args ─────────────────────────────────────
const args = process.argv.slice(2);
const configIdx = args.indexOf('--config');
if (configIdx === -1 || !args[configIdx + 1]) {
  console.error('Usage: npx tsx scripts/generic-duty-report.ts --config <path-to-yaml>');
  process.exit(1);
}
const configPath = path.resolve(process.cwd(), args[configIdx + 1]);
const collectOnly = args.includes('--collect-only');
const config = loadDutyConfig(configPath);

// ── Environment ────────────────────────────────────────
const NANOCLAW_DIR = process.cwd();
const COOKIE_PATH = path.join(process.env.HOME || '/root', '.grafana_cookie.json');
const RECIPIENT = process.env[config.output.recipient_env]
  || process.env.ON_DUTY_RECIPIENT
  || config.output.fallback_recipient;
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = config.output.ipc_chat_jid;
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const GMAIL_CRED_DIR = path.join(process.env.HOME || '/root', '.gmail-mcp');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const MODEL_NAME = process.env.MODEL_NAME || 'QwQ-32B';
const DUTY_MODELS: string[] = config.models?.length
  ? config.models
  : process.env.DUTY_MODELS
    ? process.env.DUTY_MODELS.split(',').map(s => s.trim()).filter(Boolean)
    : [MODEL_NAME];

const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY || '';
const TASK_ID = process.env.DUTY_TASK_ID || '';
const TASK_TAG = TASK_ID ? `[${TASK_ID}] ` : '';
const RANGE_STEP_MS = config.grafana.step_minutes * 60_000;

// ── Logging ────────────────────────────────────────────
function getLogPath(): string {
  const d = new Date();
  const tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.join(LOG_DIR, `${config.report_type}-duty-${tag}.log`);
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogPath(), line + '\n');
  } catch { /* ignore */ }
}

// ── Types ──────────────────────────────────────────────
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
  repeat?: string;
  repeatDirection?: string;
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

type DsType = 'prometheus' | 'elasticsearch' | 'googlesheets' | 'unknown';

interface ResolvedTarget {
  panelTitle: string;
  refId: string;
  dsUid: string;
  dsType: DsType;
  legendFormat: string;
  target: GrafanaTarget;
}

interface RawSeriesData {
  label: string;
  points: Array<{ time: number; value: number }>;
}

interface PanelDiagnosis {
  panelTitle: string;
  rowTitle: string;
  severity: Severity;
  reasons: string[];
  stats: SeriesStats[];
}

// ── Grafana Authentication ─────────────────────────────
function loadSession(): CookieConfig {
  if (GRAFANA_API_KEY) return { grafana_session: '', updated_at: '', expires_at: '' };
  if (!fs.existsSync(COOKIE_PATH)) {
    throw new Error(`GRAFANA_API_KEY 未配置且 Cookie 文件不存在: ${COOKIE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')) as CookieConfig;
}

async function validateGrafana(session: CookieConfig): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.grafana.base_url}/api/dashboards/uid/${config.grafana.dashboard_uid}`,
      { headers: gfHeaders(session) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── Template Variables ─────────────────────────────────
const TEMPLATE_VARS: Record<string, string> = {};
const TEMPLATE_VAR_OPTIONS: Record<string, Array<{ text: string; value: string }>> = {};

function populateTemplateVarsFromDashboard(
  templating?: { list?: Array<{ name?: string; type?: string; current?: { value?: string; text?: string }; options?: Array<{ value?: string; text?: string; selected?: boolean }> }> },
): void {
  if (!templating?.list) return;
  for (const v of templating.list) {
    if (!v.name) continue;
    const allOptions = (v.options || [])
      .filter(o => o.value && o.value !== '$__all')
      .map(o => ({ text: o.text || o.value || '', value: o.value || '' }));
    if (allOptions.length) {
      TEMPLATE_VAR_OPTIONS[v.name] = allOptions;
    }

    let val = v.current?.value ?? '';
    if (val === '$__all' || val === 'All' || val === '') {
      const firstOption = allOptions[0];
      val = firstOption?.value ?? '.*';
    }
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
  return result;
}

const _autoDiscoveredUids: Record<string, string> = {};
const _unresolvedDsNames = new Set<string>();

function resolveDsUid(rawUid: string): string {
  const uidMap = config.grafana.datasource_uid_map;
  if (uidMap && uidMap[rawUid]) return uidMap[rawUid];

  if (_autoDiscoveredUids[rawUid]) return _autoDiscoveredUids[rawUid];

  const resolved = replaceTemplateVars(rawUid);

  if (uidMap && uidMap[resolved]) return uidMap[resolved];
  if (_autoDiscoveredUids[resolved]) return _autoDiscoveredUids[resolved];

  if (resolved !== rawUid && /^[A-Za-z]/.test(resolved) && resolved.includes('-')) {
    _unresolvedDsNames.add(resolved);
  }

  return resolved;
}

async function autoDiscoverDsUids(session: CookieConfig): Promise<void> {
  try {
    const res = await fetch(
      `${config.grafana.base_url}/api/frontend/settings`,
      { headers: gfHeaders(session) },
    );
    if (!res.ok) {
      log(`自动发现数据源 UID: /api/frontend/settings 返回 ${res.status}, 跳过`);
      return;
    }
    const data = await res.json() as {
      datasources?: Record<string, { uid?: string; type?: string; name?: string }>;
    };
    const ds = data.datasources || {};
    let count = 0;
    for (const [name, info] of Object.entries(ds)) {
      if (info.uid && info.type?.includes('elasticsearch')) {
        _autoDiscoveredUids[name] = info.uid;
        count++;
      }
    }
    if (count > 0) {
      log(`自动发现 ${count} 个 ES 数据源 UID 映射（通过 /api/frontend/settings）`);
    }
  } catch (err) {
    log(`自动发现数据源 UID 失败 (不影响已配置的映射): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function logUnresolvedDsNames(): void {
  if (_unresolvedDsNames.size === 0) return;
  log(`以下 ${_unresolvedDsNames.size} 个数据源名称未解析为 UID（查询可能失败）:`);
  for (const name of _unresolvedDsNames) {
    const discovered = _autoDiscoveredUids[name];
    if (discovered) {
      log(`  "${name}" -> 已自动发现 UID: ${discovered}`);
    } else {
      log(`  "${name}" -> 未找到 UID, 建议在 YAML 的 datasource_uid_map 中手动配置`);
    }
  }
}

function detectDsType(ds?: { type?: string; uid?: string } | string): DsType {
  if (!ds) return 'unknown';
  const t = typeof ds === 'string' ? ds : (ds.type || '');
  if (t.includes('prometheus')) return 'prometheus';
  if (t.includes('elasticsearch')) return 'elasticsearch';
  if (t.includes('googlesheets') || t.includes('google-sheets')) return 'googlesheets';
  return 'unknown';
}

// ── Grafana Data Fetching ──────────────────────────────
function gfHeaders(session: CookieConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Grafana-Org-Id': String(config.grafana.org_id),
  };
  if (GRAFANA_API_KEY) {
    h['Authorization'] = `Bearer ${GRAFANA_API_KEY}`;
  } else {
    h['Cookie'] = `grafana_session=${session.grafana_session}`;
  }
  return h;
}

interface PanelSkipRecord {
  title: string;
  type: string;
  reason: string;
}

interface PanelDataSkipRecord {
  panelTitle: string;
  rowTitle: string;
  reason: string;
}

const _skippedPanels: PanelSkipRecord[] = [];
const _noDataPanels: PanelDataSkipRecord[] = [];

const SUPPORTED_PANEL_TYPES = [
  'timeseries', 'graph', 'stat', 'gauge', 'bargauge', 'table',
  'barchart', 'piechart', 'heatmap', 'histogram', 'candlestick',
  'state-timeline', 'status-history', 'trend',
];

function resolveOnePanel(
  p: GrafanaPanel,
  panelTitle: string,
  defaultDs: string | undefined,
  defaultDsType: DsType | undefined,
  varOverride?: { varName: string; opt: { text: string; value: string } },
): ResolvedTarget[] {
  const panelDsObj = typeof p.datasource === 'object' ? p.datasource : undefined;
  const panelDsType = detectDsType(p.datasource) || defaultDsType || 'unknown';

  const targets: ResolvedTarget[] = [];
  for (const t of (p.targets || [])) {
    const targetDsType = detectDsType(t.datasource) || panelDsType;
    let rawUid = t.datasource?.uid || panelDsObj?.uid || defaultDs || '';
    if (!rawUid) continue;

    if (varOverride) {
      rawUid = replaceVarInString(rawUid, varOverride.varName, varOverride.opt);
    }
    const dsUid = resolveDsUid(rawUid);

    const patchDatasource = (orig: GrafanaTarget): GrafanaTarget => {
      if (!varOverride) return orig;
      const cloned: GrafanaTarget = { ...orig };
      if (cloned.datasource?.uid) {
        cloned.datasource = {
          ...cloned.datasource,
          uid: replaceVarInString(cloned.datasource.uid, varOverride.varName, varOverride.opt),
        };
      }
      return cloned;
    };

    if (targetDsType === 'prometheus') {
      if (!t.expr) continue;
      let expr = t.expr;
      if (varOverride) expr = replaceVarInString(expr, varOverride.varName, varOverride.opt);
      targets.push({
        panelTitle, refId: t.refId || 'A', dsUid, dsType: 'prometheus',
        legendFormat: t.legendFormat || '',
        target: patchDatasource({ ...t, expr: replaceTemplateVars(expr) }),
      });
    } else if (targetDsType === 'elasticsearch') {
      const esQuery = t.query as string | undefined;
      if (!esQuery && !(t as Record<string, unknown>).bucketAggs) continue;
      const cloned = patchDatasource({ ...t });
      if (varOverride && typeof cloned.query === 'string') {
        cloned.query = replaceVarInString(cloned.query, varOverride.varName, varOverride.opt);
      }
      targets.push({
        panelTitle, refId: t.refId || 'A', dsUid, dsType: 'elasticsearch',
        legendFormat: '',
        target: cloned,
      });
    } else if (targetDsType === 'googlesheets') {
      const spreadsheet = (t as Record<string, unknown>).spreadsheet as string | undefined;
      if (!spreadsheet) continue;
      const cloned = patchDatasource({ ...t }) as Record<string, unknown>;
      if (varOverride) {
        if (typeof cloned.range === 'string') {
          cloned.range = replaceVarInString(cloned.range, varOverride.varName, varOverride.opt);
        }
        if (typeof cloned.spreadsheet === 'string') {
          cloned.spreadsheet = replaceVarInString(cloned.spreadsheet, varOverride.varName, varOverride.opt);
        }
      }
      targets.push({
        panelTitle, refId: t.refId || 'A', dsUid, dsType: 'googlesheets',
        legendFormat: '',
        target: cloned as GrafanaTarget,
      });
    }
  }
  return targets;
}

function extractPanels(raw: GrafanaPanel[], defaultDs?: string, defaultDsType?: DsType): RowGroup[] {
  const groups: RowGroup[] = [];
  let currentRow = 'Default';
  _skippedPanels.length = 0;

  const addToGroup = (rowTitle: string, panel: { title: string; type: string; targets: ResolvedTarget[] }) => {
    let group = groups.find(g => g.rowTitle === rowTitle);
    if (!group) {
      group = { rowTitle, panels: [] };
      groups.push(group);
    }
    group.panels.push(panel);
  };

  for (const p of raw) {
    if (p.type === 'row') {
      currentRow = p.title || 'Unnamed Row';
      if (p.collapsed && p.panels?.length) {
        const nested = extractPanels(p.panels, defaultDs, defaultDsType);
        for (const ng of nested) {
          const existing = groups.find(g => g.rowTitle === currentRow);
          if (existing) {
            existing.panels.push(...ng.panels);
          } else {
            groups.push({ rowTitle: currentRow, panels: ng.panels });
          }
        }
      }
      continue;
    }

    if (!SUPPORTED_PANEL_TYPES.includes(p.type)) {
      if (p.type !== 'text') {
        _skippedPanels.push({ title: p.title, type: p.type, reason: `不支持的类型 ${p.type}` });
      }
      continue;
    }
    if (!p.targets?.length) {
      _skippedPanels.push({ title: p.title, type: p.type, reason: '无 targets' });
      continue;
    }

    const repeatVar = p.repeat;
    const repeatOptions = repeatVar ? TEMPLATE_VAR_OPTIONS[repeatVar] : undefined;

    if (repeatVar && repeatOptions && repeatOptions.length > 1) {
      for (const opt of repeatOptions) {
        const expandedTitle = replaceVarInString(p.title, repeatVar, opt);
        const targets = resolveOnePanel(p, expandedTitle, defaultDs, defaultDsType, { varName: repeatVar, opt });
        if (targets.length === 0) {
          _skippedPanels.push({ title: expandedTitle, type: p.type, reason: 'datasource 解析失败' });
          continue;
        }
        addToGroup(currentRow, { title: expandedTitle, type: p.type, targets });
      }
    } else {
      const targets = resolveOnePanel(p, p.title, defaultDs, defaultDsType);
      if (targets.length === 0) {
        _skippedPanels.push({ title: p.title, type: p.type, reason: 'datasource 解析失败' });
        continue;
      }
      addToGroup(currentRow, { title: p.title, type: p.type, targets });
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

async function fetchSingleDashboard(
  session: CookieConfig,
  uid: string,
): Promise<{ panels: GrafanaPanel[]; templating?: unknown }> {
  const url = `${config.grafana.base_url}/api/dashboards/uid/${uid}`;
  const res = await fetch(url, { headers: gfHeaders(session) });
  if (!res.ok) throw new Error(`Dashboard ${uid} fetch failed: ${res.status}`);

  const data = await res.json() as {
    dashboard?: {
      panels?: GrafanaPanel[];
      templating?: { list?: Array<{ name?: string; type?: string; current?: { value?: string; text?: string }; options?: Array<{ value?: string; text?: string; selected?: boolean }> }> };
    };
  };
  return {
    panels: data.dashboard?.panels || [],
    templating: data.dashboard?.templating,
  };
}

async function fetchDashboard(session: CookieConfig): Promise<{ groups: RowGroup[]; totalRawPanels: number }> {
  const uids = [config.grafana.dashboard_uid, ...(config.grafana.additional_uids || [])];
  let allPanels: GrafanaPanel[] = [];

  for (const uid of uids) {
    log(`拉取 Dashboard ${uid} ...`);
    const { panels, templating } = await fetchSingleDashboard(session, uid);
    if (!panels.length) {
      log(`Dashboard ${uid} 无面板，跳过`);
      continue;
    }
    populateTemplateVarsFromDashboard(templating as Parameters<typeof populateTemplateVarsFromDashboard>[0]);
    allPanels = allPanels.concat(panels);
  }

  if (!allPanels.length) throw new Error('所有 Dashboard 均无面板');

  const countRawPanels = (raw: GrafanaPanel[]): number => {
    let count = 0;
    for (const p of raw) {
      if (p.type === 'row') {
        if (p.collapsed && p.panels?.length) {
          for (const sub of p.panels) {
            const repeatOpts = sub.repeat ? TEMPLATE_VAR_OPTIONS[sub.repeat] : undefined;
            count += (repeatOpts && repeatOpts.length > 1) ? repeatOpts.length : 1;
          }
        }
      } else {
        const repeatOpts = p.repeat ? TEMPLATE_VAR_OPTIONS[p.repeat] : undefined;
        count += (repeatOpts && repeatOpts.length > 1) ? repeatOpts.length : 1;
      }
    }
    return count;
  };
  const totalRawPanels = countRawPanels(allPanels);

  const firstDs = allPanels[0]?.datasource;
  const defaultDs = (typeof firstDs === 'object' ? firstDs?.uid : undefined);
  const defaultDsType = detectDsType(firstDs);
  const groups = extractPanels(allPanels, defaultDs, defaultDsType);
  return { groups, totalRawPanels };
}

async function queryPrometheus(
  session: CookieConfig,
  dsUid: string,
  expr: string,
  fromMs: number,
  toMs: number,
): Promise<RawSeriesData[]> {
  const body = {
    queries: [
      {
        refId: 'A',
        datasource: { type: 'prometheus', uid: dsUid },
        expr,
        instant: false,
        range: true,
        maxDataPoints: config.grafana.max_data_points,
        intervalMs: RANGE_STEP_MS,
      },
    ],
    from: String(fromMs),
    to: String(toMs),
  };

  const res = await fetch(`${config.grafana.base_url}/api/ds/query`, {
    method: 'POST',
    headers: gfHeaders(session),
    body: JSON.stringify(body),
  });

  if (!res.ok) return [];

  const json = await res.json() as {
    results?: Record<string, {
      frames?: Array<{
        schema?: { fields?: Array<{ labels?: Record<string, string> }> };
        data?: { values?: Array<Array<number | null>> };
      }>;
    }>;
  };

  const results: RawSeriesData[] = [];
  const frames = json.results?.A?.frames || [];
  for (const frame of frames) {
    const labelField = frame.schema?.fields?.[1];
    const label = labelField?.labels
      ? Object.values(labelField.labels).filter(Boolean).join(' / ') || 'value'
      : 'value';
    const times = frame.data?.values?.[0] || [];
    const vals = frame.data?.values?.[1] || [];
    const points: Array<{ time: number; value: number }> = [];
    for (let i = 0; i < times.length; i++) {
      if (vals[i] !== null && vals[i] !== undefined && isFinite(vals[i] as number)) {
        points.push({ time: times[i] as number, value: vals[i] as number });
      }
    }
    if (points.length > 0) {
      results.push({ label, points });
    }
  }
  return results;
}

async function queryElasticsearch(
  session: CookieConfig,
  target: GrafanaTarget,
  dsUid: string,
  fromMs: number,
  toMs: number,
): Promise<RawSeriesData[]> {
  const t = target as Record<string, unknown>;
  const body = {
    queries: [{
      refId: target.refId || 'A',
      datasource: { type: 'elasticsearch', uid: dsUid },
      alias: (t.alias as string) || '',
      query: (t.query as string) || '*',
      bucketAggs: t.bucketAggs || [],
      metrics: t.metrics || [{ id: '1', type: 'count' }],
      timeField: (t.timeField as string) || '@timestamp',
      hide: false,
    }],
    from: String(fromMs),
    to: String(toMs),
  };

  const res = await fetch(`${config.grafana.base_url}/api/ds/query`, {
    method: 'POST',
    headers: gfHeaders(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];

  const json = await res.json() as {
    results?: Record<string, {
      frames?: Array<{
        schema?: { fields?: Array<{ name?: string; labels?: Record<string, string> }> };
        data?: { values?: Array<Array<number | string | null>> };
      }>;
    }>;
  };

  const refId = target.refId || 'A';
  const frames = json.results?.[refId]?.frames || [];
  const results: RawSeriesData[] = [];

  for (const frame of frames) {
    const fields = frame.schema?.fields || [];
    const values = frame.data?.values || [];
    if (values.length < 2) continue;

    const hasTimestamp = fields[0]?.name === 'time';
    if (hasTimestamp) {
      const labelField = fields[1];
      const label = labelField?.labels
        ? Object.values(labelField.labels).filter(Boolean).join(' / ') || 'value'
        : 'value';
      const times = values[0] as Array<number | null>;
      const vals = values[1] as Array<number | null>;
      const points: Array<{ time: number; value: number }> = [];
      for (let i = 0; i < times.length; i++) {
        if (vals[i] !== null && vals[i] !== undefined && isFinite(vals[i] as number)) {
          points.push({ time: times[i] as number, value: vals[i] as number });
        }
      }
      if (points.length > 0) results.push({ label, points });
    } else {
      const metricIdx = fields.length - 1;
      let totalCount = 0;
      if (metricIdx >= 0 && values[metricIdx]) {
        for (const v of values[metricIdx]) {
          if (typeof v === 'number' && isFinite(v)) totalCount += v;
        }
      }
      const bucketIdx = fields.length >= 2 ? 0 : -1;
      const bucketVals = bucketIdx >= 0 && values[bucketIdx]
        ? (values[bucketIdx] as Array<string | number | null>).filter(v => v != null).map(String)
        : [];
      const label = bucketVals.length > 0
        ? bucketVals.join(', ')
        : (fields[metricIdx]?.labels ? Object.values(fields[metricIdx].labels!).join(' / ') : 'count');
      results.push({ label, points: [{ time: Date.now(), value: totalCount }] });
    }
  }
  return results;
}

async function queryGoogleSheets(
  session: CookieConfig,
  target: GrafanaTarget,
  dsUid: string,
  fromMs: number,
  toMs: number,
): Promise<RawSeriesData[]> {
  const t = target as Record<string, unknown>;
  const body = {
    queries: [{
      refId: target.refId || 'A',
      datasource: { type: 'grafana-googlesheets-datasource', uid: dsUid },
      cacheDurationSeconds: (t.cacheDurationSeconds as number) || 300,
      range: t.range || '',
      spreadsheet: t.spreadsheet || '',
    }],
    from: String(fromMs),
    to: String(toMs),
  };

  const res = await fetch(`${config.grafana.base_url}/api/ds/query`, {
    method: 'POST',
    headers: gfHeaders(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];

  const json = await res.json() as {
    results?: Record<string, {
      frames?: Array<{
        schema?: { fields?: Array<{ name?: string; type?: string }> };
        data?: { values?: Array<Array<unknown>> };
      }>;
    }>;
  };

  const refId = target.refId || 'A';
  const frames = json.results?.[refId]?.frames || [];
  const results: RawSeriesData[] = [];

  for (const frame of frames) {
    const fields = frame.schema?.fields || [];
    const values = frame.data?.values || [];
    const rowCount = values.length > 0 ? (values[0]?.length || 0) : 0;
    const sheetRange = (t.range as string) || 'sheet';
    results.push({
      label: `${sheetRange} (${rowCount} rows, ${fields.length} cols)`,
      points: [{ time: Date.now(), value: rowCount }],
    });
  }
  return results;
}

function stringContainsVar(str: string, varName: string): boolean {
  return str.includes(`$${varName}`) || str.includes(`\${${varName}}`);
}

function needsVarIteration(target: ResolvedTarget): string | null {
  const rawUid = target.target.datasource?.uid || '';
  const t = target.target as Record<string, unknown>;
  for (const [varName, options] of Object.entries(TEMPLATE_VAR_OPTIONS)) {
    if (options.length <= 1) continue;
    if (stringContainsVar(rawUid, varName)) return varName;
    if (target.dsType === 'googlesheets' || target.dsType === 'elasticsearch') {
      const range = (t.range as string) || '';
      const query = (t.query as string) || '';
      if (stringContainsVar(range, varName) || stringContainsVar(query, varName)) {
        return varName;
      }
    }
  }
  return null;
}

async function queryTarget(
  session: CookieConfig,
  t: ResolvedTarget,
  fromMs: number,
  toMs: number,
): Promise<RawSeriesData[]> {
  if (t.dsType === 'prometheus') {
    const expr = t.target.expr || '';
    if (!expr) return [];
    return queryPrometheus(session, t.dsUid, expr, fromMs, toMs);
  }

  if (t.dsType === 'elasticsearch') {
    return queryElasticsearch(session, t.target, t.dsUid, fromMs, toMs);
  }

  if (t.dsType === 'googlesheets') {
    return queryGoogleSheets(session, t.target, t.dsUid, fromMs, toMs);
  }

  return [];
}

function replaceVarInString(str: string, varName: string, opt: { text: string; value: string }): string {
  let result = str;
  result = result.replace(new RegExp(`\\$\\{${varName}:text\\}`, 'g'), opt.text);
  result = result.replace(new RegExp(`\\$\\{${varName}:value\\}`, 'g'), opt.value);
  result = result.replace(new RegExp(`\\$\\{${varName}\\}`, 'g'), opt.value);
  result = result.replace(new RegExp(`\\$${varName}`, 'g'), opt.value);
  return result;
}

function filterOptionsByPanelRegion(
  panelTitle: string,
  options: Array<{ text: string; value: string }>,
): Array<{ text: string; value: string }> {
  const match = panelTitle.match(/^([A-Z]{2}(?:-[A-Z]+)?)\s*[-\s]/);
  if (!match) return options;
  const prefix = match[1].toUpperCase();
  const filtered = options.filter(o => o.text.toUpperCase() === prefix);
  return filtered.length > 0 ? filtered : options;
}

async function queryTargetWithVarIteration(
  session: CookieConfig,
  t: ResolvedTarget,
  fromMs: number,
  toMs: number,
): Promise<RawSeriesData[]> {
  const varName = needsVarIteration(t);
  if (!varName) {
    return queryTarget(session, t, fromMs, toMs);
  }

  const allOptions = TEMPLATE_VAR_OPTIONS[varName] || [];
  const options = filterOptionsByPanelRegion(t.panelTitle, allOptions);
  const singleRegion = options.length === 1;

  const allResults: RawSeriesData[] = [];
  for (const opt of options) {
    const clonedTarget: ResolvedTarget = JSON.parse(JSON.stringify(t));

    const rawUid = clonedTarget.target.datasource?.uid || '';
    const resolvedUid = replaceVarInString(rawUid, varName, opt);
    clonedTarget.dsUid = resolveDsUid(resolvedUid);

    const tt = clonedTarget.target as Record<string, unknown>;
    if (typeof tt.range === 'string') {
      tt.range = replaceVarInString(tt.range, varName, opt);
    }
    if (typeof tt.query === 'string') {
      tt.query = replaceVarInString(tt.query as string, varName, opt);
    }

    clonedTarget.panelTitle = `${t.panelTitle} [${opt.text}]`;

    try {
      const series = await queryTarget(session, clonedTarget, fromMs, toMs);
      if (!singleRegion) {
        for (const s of series) {
          s.label = `${opt.text}: ${s.label}`;
        }
      }
      allResults.push(...series);
    } catch { /* skip failed queries for this variant */ }
  }

  return allResults;
}

async function fetchAllPanelData(
  session: CookieConfig,
  groups: RowGroup[],
): Promise<Map<string, RawSeriesData[]>> {
  const now = Date.now();
  const fromMs = now - config.grafana.time_range_hours * 3600_000;
  const dataMap = new Map<string, RawSeriesData[]>();

  const allTargets: ResolvedTarget[] = [];
  for (const g of groups) {
    for (const p of g.panels) {
      allTargets.push(...p.targets);
    }
  }

  log(`共 ${allTargets.length} 个查询目标，分批执行 (batch=${config.query.batch_size}, concurrency=${config.query.concurrency})`);

  const concurrency = config.query.concurrency;
  for (let i = 0; i < allTargets.length; i += config.query.batch_size) {
    const batch = allTargets.slice(i, i + config.query.batch_size);
    const running: Set<Promise<void>> = new Set();

    for (const t of batch) {
      const task = (async () => {
        try {
          const series = await queryTargetWithVarIteration(session, t, fromMs, now);
          const key = `${t.panelTitle}::${t.refId}`;
          const existing = dataMap.get(key) || [];
          existing.push(...series.slice(0, config.query.max_series_per_panel));
          if (existing.length > 0) dataMap.set(key, existing);
        } catch { /* skip failed queries */ }
      })();
      running.add(task);
      task.then(() => running.delete(task));
      if (running.size >= concurrency) {
        await Promise.race(running);
      }
    }
    await Promise.all(running);
  }

  log(`数据获取完成: ${dataMap.size} 个面板有数据`);
  return dataMap;
}

// ── Statistical Features ───────────────────────────────
function computeSeriesStats(series: RawSeriesData): SeriesStats {
  const values = series.points.map(p => p.value);
  const n = values.length;
  if (n === 0) {
    return {
      label: series.label, latest: null, mean: 0, max: 0, min: 0,
      stddev: 0, trend: 'stable', trendPct: 0, spikeCount: 0,
      zeroCount: 0, zeroStreak: 0, changeRate: 0, dataPoints: 0, recentChangePct: 0,
    };
  }

  const latest = values[n - 1];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  const half = Math.floor(n / 2);
  const firstHalfMean = half > 0
    ? values.slice(0, half).reduce((a, b) => a + b, 0) / half
    : mean;
  const secondHalfMean = half > 0
    ? values.slice(-half).reduce((a, b) => a + b, 0) / half
    : mean;
  const ref = Math.abs(firstHalfMean) > 0.001 ? firstHalfMean : 1;
  const trendPct = ((secondHalfMean - firstHalfMean) / Math.abs(ref)) * 100;
  const trend: 'rising' | 'falling' | 'stable' =
    trendPct > 20 ? 'rising' : trendPct < -20 ? 'falling' : 'stable';

  let spikeCount = 0;
  if (stddev > 0) {
    for (const v of values) {
      if (Math.abs(v - mean) > 3 * stddev) spikeCount++;
    }
  }

  const zeroCount = values.filter(v => v === 0).length;
  let zeroStreak = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (values[i] === 0) zeroStreak++;
    else break;
  }
  const earliest = values[0];
  const changeRate = earliest !== 0 ? ((latest - earliest) / Math.abs(earliest)) * 100 : 0;

  const recentSlice = Math.max(1, Math.floor(n / 8));
  const recentValues = values.slice(-recentSlice);
  const previousValues = values.slice(0, n - recentSlice);
  const recentMean = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
  const previousMean = previousValues.length > 0
    ? previousValues.reduce((a, b) => a + b, 0) / previousValues.length
    : recentMean;
  const prevRef = Math.abs(previousMean) > 0.001 ? previousMean : 1;
  const recentChangePct = ((recentMean - previousMean) / Math.abs(prevRef)) * 100;

  return {
    label: series.label,
    latest, mean, max, min, stddev,
    trend, trendPct, spikeCount, zeroCount, zeroStreak,
    changeRate, dataPoints: n, recentChangePct,
  };
}

// ── Anomaly Detection ──────────────────────────────────
function diagnosePanels(
  groups: RowGroup[],
  dataMap: Map<string, RawSeriesData[]>,
  rules: CompiledAnomalyRule[],
  genericDetect: (stats: SeriesStats[]) => { severity: Severity; reasons: string[] },
): PanelDiagnosis[] {
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

      const allStats = withData.map(computeSeriesStats);

      const panelRegion = extractPanelRegion(panel.title);
      const stats = panelRegion
        ? allStats.filter(s => {
            if (!s.label.includes(':')) return true;
            const labelRegion = s.label.split(':')[0].trim().toUpperCase();
            return labelRegion === panelRegion.toUpperCase()
              || labelRegion === 'VALUE'
              || labelRegion === 'COUNT';
          })
        : allStats;

      if (stats.length === 0 && allStats.length > 0) {
        log(`  面板 "${panel.title}" 区域过滤后无匹配数据，使用全部数据`);
        stats.push(...allStats);
      }

      let severity: Severity = 'normal';
      let reasons: string[] = [];

      const matchedRule = rules.find(r => r.match(panel.title));
      if (matchedRule) {
        const result = matchedRule.check(stats);
        severity = result.severity;
        reasons = result.reasons;
      }

      const generic = genericDetect(stats);
      if (severityRank(generic.severity) > severityRank(severity)) {
        severity = generic.severity;
      }
      reasons.push(...generic.reasons);

      diagnoses.push({
        panelTitle: panel.title,
        rowTitle: group.rowTitle,
        severity,
        reasons: reasons.slice(0, config.generic_detection.max_reasons_per_panel),
        stats: stats.slice(0, config.query.max_series_per_panel),
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

// ── Global Series Deduplication ────────────────────────
function deduplicateGlobalDiagnoses(diagnoses: PanelDiagnosis[]): PanelDiagnosis[] {
  const byPanel = new Map<string, PanelDiagnosis[]>();
  for (const d of diagnoses) {
    const existing = byPanel.get(d.panelTitle) || [];
    existing.push(d);
    byPanel.set(d.panelTitle, existing);
  }

  const deduped: PanelDiagnosis[] = [];
  const merged = new Set<PanelDiagnosis>();

  for (const [panelTitle, group] of byPanel) {
    if (group.length < 3) {
      continue;
    }

    const fingerprint = (s: SeriesStats) =>
      `${s.label}|${s.latest}|${s.mean.toFixed(3)}|${s.min.toFixed(3)}|${s.max.toFixed(3)}|${s.stddev.toFixed(3)}`;

    const first = group[0];
    const firstFp = first.stats.map(fingerprint).sort().join(';;');

    const identicalGroup = group.filter(d => {
      const fp = d.stats.map(fingerprint).sort().join(';;');
      return fp === firstFp;
    });

    if (identicalGroup.length >= 3) {
      const regions = identicalGroup.map(d => d.rowTitle).join(', ');
      const highestSev = identicalGroup.reduce(
        (max, d) => severityRank(d.severity) > severityRank(max) ? d.severity : max,
        'normal' as Severity,
      );
      const allReasons = identicalGroup.flatMap(d => d.reasons);
      const uniqueReasons = [...new Set(allReasons)];

      deduped.push({
        panelTitle,
        rowTitle: `全局(${regions})`,
        severity: highestSev,
        reasons: uniqueReasons.slice(0, config.generic_detection.max_reasons_per_panel),
        stats: first.stats,
      });

      for (const d of identicalGroup) merged.add(d);
      log(`  去重: "${panelTitle}" 在 ${identicalGroup.length} 个区域数据完全相同，合并为全局`);
    }
  }

  for (const d of diagnoses) {
    if (!merged.has(d)) deduped.push(d);
  }

  return deduped;
}

// ── Report Text Builder ────────────────────────────────
const fmt = (n: number | null): string => {
  if (n === null) return 'N/A';
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(3);
};

interface ComparisonData {
  yesterday: HistoricalMetricMap;
  lastWeek: HistoricalMetricMap;
}

// ── Comparison Enrichment ─────────────────────────────
function isSimilarValue(current: number, historical: number, isRateMetric: boolean): boolean {
  if (isRateMetric) {
    return Math.abs(current - historical) < 5;
  }
  if (historical === 0 && current === 0) return true;
  if (historical === 0) return false;
  return Math.abs((current - historical) / Math.abs(historical)) < 0.3;
}

function enrichWithComparison(
  diagnoses: PanelDiagnosis[],
  comparison: ComparisonData | null,
): void {
  if (!comparison) return;

  for (const d of diagnoses) {
    if (d.severity === 'normal') continue;

    let matchYesterday = 0;
    let matchLastWeek = 0;
    let totalComparable = 0;

    for (const s of d.stats) {
      if (s.latest === null) continue;
      const key = `${d.panelTitle}::${s.label}`;
      const isRate = s.max <= 100 && s.min >= 0 && /成功率|率/.test(d.panelTitle);

      const ydVal = comparison.yesterday.values.get(key);
      const lwVal = comparison.lastWeek.values.get(key);

      if (ydVal !== undefined || lwVal !== undefined) {
        totalComparable++;
        if (ydVal !== undefined && isSimilarValue(s.latest, ydVal, isRate)) matchYesterday++;
        if (lwVal !== undefined && isSimilarValue(s.latest, lwVal, isRate)) matchLastWeek++;
      }
    }

    if (totalComparable === 0) continue;

    const ydRatio = matchYesterday / totalComparable;
    const lwRatio = matchLastWeek / totalComparable;

    if (ydRatio >= 0.5 && lwRatio >= 0.5) {
      d.reasons.push('(历史常态,与昨日和上周一致)');
      if (d.severity === 'critical') {
        d.severity = 'warning';
        log(`  降级: "${d.rowTitle}/${d.panelTitle}" critical→warning (历史常态)`);
      }
    } else if (ydRatio >= 0.5) {
      d.reasons.push('(持续2天)');
    } else {
      d.reasons.push('(新增异常)');
    }
  }
}

function buildComparisonStr(
  panelTitle: string,
  label: string,
  latest: number,
  comp: ComparisonData | null,
): string {
  if (!comp) return '';
  const key = `${panelTitle}::${label}`;
  const parts: string[] = [];

  const ydVal = comp.yesterday.values.get(key);
  if (ydVal !== undefined && ydVal !== 0) {
    const pct = ((latest - ydVal) / Math.abs(ydVal)) * 100;
    parts.push(`环比: 昨日=${fmt(ydVal)}(${pct >= 0 ? '+' : ''}${fmt(pct)}%)`);
  } else if (ydVal === 0) {
    parts.push(`环比: 昨日=0`);
  } else if (comp.yesterday.date) {
    parts.push(`环比: 昨日无此指标`);
  }

  const lwVal = comp.lastWeek.values.get(key);
  if (lwVal !== undefined && lwVal !== 0) {
    const pct = ((latest - lwVal) / Math.abs(lwVal)) * 100;
    parts.push(`同比: 上周=${fmt(lwVal)}(${pct >= 0 ? '+' : ''}${fmt(pct)}%)`);
  } else if (lwVal === 0) {
    parts.push(`同比: 上周=0`);
  } else if (comp.lastWeek.date) {
    parts.push(`同比: 上周无此指标`);
  }

  return parts.length > 0 ? ' | ' + parts.join(' | ') : '';
}

function buildReportText(
  diagnoses: PanelDiagnosis[],
  totalRawPanels = 0,
  opts?: { truncate?: boolean; comparison?: ComparisonData | null },
): string {
  const truncate = opts?.truncate ?? true;
  const comp = opts?.comparison ?? null;

  const lines: string[] = [];
  lines.push(`=== ${config.name} Grafana ${config.grafana.time_range_hours}h 巡查报告 ===`);
  lines.push(`时间窗口: 最近${config.grafana.time_range_hours}小时, 采样间隔: ${config.grafana.step_minutes}分钟`);
  if (comp) {
    const ydInfo = comp.yesterday.date ? `昨日(${comp.yesterday.date})` : '昨日(无数据)';
    const lwInfo = comp.lastWeek.date ? `上周(${comp.lastWeek.date})` : '上周(无数据)';
    lines.push(`对比基准: ${ydInfo}, ${lwInfo}`);
  }
  lines.push('');

  const criticals = diagnoses.filter(d => d.severity === 'critical');
  const warnings = diagnoses.filter(d => d.severity === 'warning');
  const normals = diagnoses.filter(d => d.severity === 'normal');

  lines.push(`面板统计: 总计 ${totalRawPanels} 个, 有数据 ${diagnoses.length} 个, 无数据 ${_noDataPanels.length} 个, 跳过 ${_skippedPanels.length} 个`);
  lines.push(`摘要: ${criticals.length} 个严重异常, ${warnings.length} 个告警, ${normals.length} 个正常`);
  lines.push('');

  if (criticals.length > 0) {
    lines.push('== [严重异常] ==');
    for (const d of criticals) {
      lines.push(`[CRITICAL] ${d.rowTitle} / ${d.panelTitle}`);
      lines.push(`  原因: ${d.reasons.join('; ')}`);
      for (const s of d.stats) {
        const trendStr = s.trend === 'stable' ? '平稳' : s.trend === 'rising' ? `上升(+${fmt(s.trendPct)}%)` : `下降(${fmt(s.trendPct)}%)`;
        const recentStr = Math.abs(s.recentChangePct) > 10 ? `, 近期变化=${fmt(s.recentChangePct)}%` : '';
        const compStr = buildComparisonStr(d.panelTitle, s.label, s.latest, comp);
        lines.push(`  ${s.label}: latest=${fmt(s.latest)}, mean=${fmt(s.mean)}, max=${fmt(s.max)}, min=${fmt(s.min)}, stddev=${fmt(s.stddev)}, trend=${trendStr}, spikes=${s.spikeCount}${recentStr}${compStr}`);
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
        const recentStr = Math.abs(s.recentChangePct) > 10 ? `, 近期变化=${fmt(s.recentChangePct)}%` : '';
        const compStr = buildComparisonStr(d.panelTitle, s.label, s.latest, comp);
        lines.push(`  ${s.label}: latest=${fmt(s.latest)}, mean=${fmt(s.mean)}, max=${fmt(s.max)}, trend=${trendStr}${recentStr}${compStr}`);
      }
    }
    lines.push('');
  }

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
  if (truncate && text.length > config.query.max_report_chars) {
    text = text.slice(0, config.query.max_report_chars) + '\n\n... (数据已截断)';
  }
  return text;
}

// ── Mega Sale Awareness ───────────────────────────────
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

// ── LLM Integration ────────────────────────────────────
const LLM_URL = OPENAI_BASE_URL
  ? `${OPENAI_BASE_URL}/chat/completions`
  : 'https://api.openai.com/v1/chat/completions';

const LLM_MAX_RETRIES = 3;
const LLM_BASE_DELAY_MS = 2000;

async function callLLM(systemPrompt: string, userContent: string, maxTokens = 2048, modelName = MODEL_NAME): Promise<string> {
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
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

    if (res.status === 429 && attempt < LLM_MAX_RETRIES) {
      const delay = LLM_BASE_DELAY_MS * Math.pow(2, attempt);
      log(`LLM 429 限流, 重试 ${attempt + 1}/${LLM_MAX_RETRIES}, 等待 ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  }
  throw new Error('LLM API 重试耗尽');
}

interface ModelAnalysis {
  modelName: string;
  analysis: string;
}

function extractPanelRegion(title: string): string | null {
  const m = title.match(/^([A-Z]{2}(?:-[A-Z]+)?)\s*[-\s]/);
  return m ? m[1] : null;
}

function buildPanelText(d: PanelDiagnosis): string {
  const lines: string[] = [];
  const tag = d.severity === 'critical' ? '[CRITICAL]' : d.severity === 'warning' ? '[WARNING]' : '[OK]';
  const region = extractPanelRegion(d.panelTitle);
  lines.push(`${tag} ${d.rowTitle} / ${d.panelTitle}`);
  if (region) lines.push(`  区域: ${region}`);
  if (d.reasons.length > 0) lines.push(`  原因: ${d.reasons.join('; ')}`);

  const regionPrefix = region ? `${region}` : null;
  for (const s of d.stats) {
    if (regionPrefix && s.label.includes(':')) {
      const labelRegion = s.label.split(':')[0].trim().toUpperCase();
      if (labelRegion !== regionPrefix.toUpperCase() && labelRegion !== 'VALUE' && labelRegion !== 'COUNT') {
        continue;
      }
    }
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
  const baselineBlock = panelBaseline ? `\n历史基线：\n${panelBaseline}\n` : '';
  const megaSaleBlock = megaSaleContext ? `\n${megaSaleContext}\n` : '';
  const prompt = `你是一名${config.prompt.role}。以下是单个 Grafana 面板的监控数据，[CRITICAL]/[WARNING] 为预检测标记。
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
    const sev = panel.severity === 'critical' ? '严重' : '告警';
    return `${panel.panelTitle} | ${sev} | 规则引擎检测异常: ${panel.reasons.length}条告警`;
  }
}

const STAGE1_CONCURRENCY = 3;
const STAGE1_BATCH_COOLDOWN_MS = 2000;

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

    if (i + STAGE1_CONCURRENCY < abnormals.length) {
      await new Promise(r => setTimeout(r, STAGE1_BATCH_COOLDOWN_MS));
    }
  }

  if (confirmed.length === 0) return '无异常';
  log(`Stage 1 完成 [${modelName}]: ${confirmed.length}/${abnormals.length} 确认为异常`);
  return confirmed.join('\n');
}

async function twoStageLLMForModel(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  modelName: string,
  megaSaleContext: string,
): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const stage1Result = await runPerPanelStage1(diagnoses, baselineText, modelName, megaSaleContext);

  if (stage1Result.trim() === '无异常' || stage1Result.trim().length < 5) {
    return [
      `以下是 ${today} 的 ${config.name}分析：`,
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

  log(`Stage 2 [${modelName}]: 关联分析 + 行动建议...`);
  const megaSaleBlock = megaSaleContext ? `\n注意：${megaSaleContext}` : '';
  const s2Prompt = buildStage2Prompt(config, today) + megaSaleBlock;
  const stage2Result = await callLLM(s2Prompt, stage1Result, 2048, modelName);
  log(`Stage 2 完成 [${modelName}]: ${stage2Result.length} 字`);

  const { valid, reason } = validateLLMOutput(stage2Result);
  if (!valid) {
    log(`Stage 2 输出校验失败 [${modelName}]: ${reason}, 尝试重试...`);
    const retry = await callLLM(s2Prompt, stage1Result, 2048, modelName);
    const { valid: v2 } = validateLLMOutput(retry);
    if (v2) return patchLLMOutput(retry);
    log(`[${modelName}] 重试仍失败, 降级为规则引擎输出`);
    return buildFallbackReport(diagnoses, today);
  }

  return patchLLMOutput(stage2Result);
}

async function analyzeWithAllModels(
  diagnoses: PanelDiagnosis[],
  baselineText: string,
  megaSaleContext: string,
): Promise<ModelAnalysis[]> {
  const results: ModelAnalysis[] = [];
  for (const modelName of DUTY_MODELS) {
    try {
      const analysis = await twoStageLLMForModel(diagnoses, baselineText, modelName, megaSaleContext);
      results.push({ modelName, analysis });
    } catch (err) {
      log(`[${modelName}] LLM 分析失败: ${err instanceof Error ? err.message : String(err)}, 使用规则引擎降级`);
      const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      results.push({ modelName, analysis: buildFallbackReport(diagnoses, today) });
    }
  }
  saveModelOutputs(results);
  return results;
}

function saveModelOutputs(analyses: ModelAnalysis[]): void {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const outPath = path.join(LOG_DIR, `${config.report_type}-model-outputs-${date}.log`);
    const lines: string[] = [];
    for (const a of analyses) {
      lines.push(`\n${'='.repeat(60)}`);
      lines.push(`模型: ${a.modelName}`);
      lines.push(`时间: ${new Date().toISOString()}`);
      lines.push('='.repeat(60));
      lines.push(a.analysis);
    }
    fs.appendFileSync(outPath, lines.join('\n') + '\n');
    log(`模型输出已保存到 ${outPath}`);
  } catch (err) {
    log(`保存模型输出失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildFallbackReport(diagnoses: PanelDiagnosis[], today: string): string {
  const criticals = diagnoses.filter(d => d.severity === 'critical');
  const warnings = diagnoses.filter(d => d.severity === 'warning');
  const riskLevel = criticals.length > 0 ? '高' : warnings.length > 0 ? '中' : '低';

  const lines: string[] = [
    `以下是 ${today} 的 ${config.name}分析：`,
    '（注：LLM 分析不可用，以下为规则引擎自动生成）',
    '',
    `[总体风险] ${riskLevel}`,
    `[一句话总结] ${criticals.length} 个严重异常, ${warnings.length} 个告警`,
    '',
    '[异常分析]',
  ];

  if (criticals.length === 0 && warnings.length === 0) {
    lines.push('无');
  } else {
    let idx = 1;
    for (const d of [...criticals, ...warnings].slice(0, 10)) {
      const urgency = d.severity === 'critical' ? '立即处理' : '持续观察';
      const reasonSummary = d.reasons.length > 0 ? `规则引擎检测${d.reasons.length}条告警` : '自动检测异常';
      lines.push(`异常${idx}: ${d.panelTitle} | 原因: ${reasonSummary} | 建议: 检查面板详情 | 紧急度: ${urgency}`);
      idx++;
    }
  }

  lines.push('', '[关联发现]', '无（规则引擎无法做关联分析）');
  lines.push('', '[值班行动]');

  if (criticals.length > 0) {
    lines.push(`1. 立即检查: ${criticals.slice(0, 3).map(d => d.panelTitle).join(', ')}`);
  }
  if (warnings.length > 0) {
    lines.push(`${criticals.length > 0 ? '2' : '1'}. 持续观察告警面板`);
  }
  if (criticals.length === 0 && warnings.length === 0) {
    lines.push('1. 各项指标正常，无需特别操作');
  }

  return lines.join('\n');
}

// ── HTML Email Builder (delegates to shared module) ────
function buildHtmlEmail(
  _reportText: string,
  modelResults: ModelAnalysis[],
  diagnoses: PanelDiagnosis[],
  today: string,
  totalRawPanels = 0,
): string {
  const ctx: EmailContext = {
    configName: config.name,
    dashboardUid: config.grafana.dashboard_uid,
    totalRawPanels,
    diagnoses: diagnoses.map(d => ({
      panelTitle: d.panelTitle,
      rowTitle: d.rowTitle,
      severity: d.severity,
    })),
    noDataPanels: _noDataPanels.map(nd => ({
      panelTitle: nd.panelTitle,
      rowTitle: nd.rowTitle,
    })),
    skippedPanels: _skippedPanels.map(sp => ({
      title: sp.title,
      type: sp.type,
    })),
  };
  return buildHtmlEmailShared(modelResults, today, ctx);
}

// ── Gmail Sender (delegates to shared module) ──────────
async function sendEmail(subject: string, htmlBody: string, recipients: string): Promise<void> {
  await sendEmailShared(subject, htmlBody, recipients);
  log('邮件发送成功');
}

// ── IPC Notification (delegates to shared module) ──────
function sendIpcAlert(text: string): void {
  sendIpcAlertShared(text, IPC_DIR, CHAT_JID, config.report_type);
}

// ── Main Pipeline ──────────────────────────────────────
async function main(): Promise<void> {
  log(`=== ${config.name} 值班巡查流程开始 ===`);

  try {
    const session = loadSession();
    if (!await validateGrafana(session)) {
      throw new Error(
        GRAFANA_API_KEY
          ? 'Grafana API Key 无效，请检查 .env 中 GRAFANA_API_KEY'
          : 'Grafana Cookie 无效或过期，请配置 GRAFANA_API_KEY 或重新登录获取 cookie',
      );
    }
    log(GRAFANA_API_KEY ? 'API Key 验证通过' : 'Cookie 验证通过');

    await autoDiscoverDsUids(session);

    const { groups, totalRawPanels } = await fetchDashboard(session);
    const totalPanels = groups.reduce((sum, g) => sum + g.panels.length, 0);
    log(`Dashboard 解析完成: ${groups.length} 行, ${totalPanels} 面板 (原始总计 ${totalRawPanels})`);

    const dataMap = await fetchAllPanelData(session, groups);

    logUnresolvedDsNames();

    log('计算统计特征和异常检测...');
    const rules = compileAnomalyRules(config.anomaly_rules, config.generic_detection.max_reasons_per_panel);
    const genericDetect = buildGenericDetector(config.generic_detection);
    let diagnoses = diagnosePanels(groups, dataMap, rules, genericDetect);
    diagnoses = deduplicateGlobalDiagnoses(diagnoses);

    let criticals = diagnoses.filter(d => d.severity === 'critical').length;
    let warnings = diagnoses.filter(d => d.severity === 'warning').length;
    let normals = diagnoses.filter(d => d.severity === 'normal').length;
    log(`诊断完成: ${criticals} critical, ${warnings} warning, ${normals} normal`);

    let combinedContext = '';
    try {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      clearMetricsForDate(todayStr, config.report_type as 'funding');

      const metricRows: DutyMetric[] = [];
      for (const d of diagnoses) {
        for (const s of d.stats) {
          if (s.latest !== null) {
            metricRows.push({
              date: todayStr,
              reportType: config.report_type as 'uc' | 'funding',
              groupName: d.rowTitle || null,
              metricName: `${d.panelTitle}::${s.label}`,
              metricValue: s.latest,
            });
          }
        }
      }
      if (metricRows.length > 0) {
        storeMetrics(metricRows);
        log(`已存储 ${metricRows.length} 条指标到历史数据库`);
      }

      const allBaselines = getBaselines(config.report_type as 'funding', 30);

      if (allBaselines.length > 0) {
        const blEntries: BaselineEntry[] = allBaselines.map(b => ({
          metricName: b.metricName,
          mean: b.mean,
          stddev: b.stddev,
        }));
        let baselineUpgrades = 0;
        for (const d of diagnoses) {
          if (d.severity !== 'normal') continue;
          const blResult = checkBaselineAnomalies(
            d.panelTitle, d.stats, blEntries,
            config.generic_detection.max_reasons_per_panel,
          );
          if (blResult.severity !== 'normal') {
            d.severity = blResult.severity;
            d.reasons.push(...blResult.reasons);
            baselineUpgrades++;
          }
        }
        if (baselineUpgrades > 0) {
          log(`基线规则引擎提升 ${baselineUpgrades} 个面板的严重级别`);
        }
      }

      const abnormalKeys = diagnoses.filter(d => d.severity !== 'normal').map(d => d.panelTitle);
      const relevant = filterRelevantBaselines(allBaselines, abnormalKeys);
      const baselineText = formatBaselinesForPrompt(relevant);
      log(`基线过滤: ${allBaselines.length} 条全量 -> ${relevant.length} 条异常相关`);

      const currentAnomalies: AnomalyRecord[] = diagnoses
        .filter(d => d.severity !== 'normal')
        .map(d => ({
          key: `${d.rowTitle}/${d.panelTitle}`,
          severity: d.severity,
          reason: d.reasons[0] || '',
        }));
      const tracking = getAnomalyTracking(todayStr, config.report_type as 'funding', currentAnomalies);
      storeAnomalies(todayStr, config.report_type as 'funding', currentAnomalies);
      const trackingText = formatAnomalyTrackingForPrompt(tracking);

      if (trackingText) {
        log(`异常追踪: ${tracking.continuing.length} 持续, ${tracking.newAnomalies.length} 新增, ${tracking.recovered.length} 已恢复`);
      }

      combinedContext = [baselineText, trackingText].filter(Boolean).join('\n');
    } catch (err) {
      log(`基线/追踪处理失败 (不影响报告): ${err instanceof Error ? err.message : String(err)}`);
    }

    let comparison: ComparisonData | null = null;
    try {
      const yesterday = getYesterdayMetrics(config.report_type);
      const lastWeek = getLastWeekMetrics(config.report_type);
      if (yesterday.date || lastWeek.date) {
        comparison = { yesterday, lastWeek };
        log(`同比/环比: 昨日${yesterday.date ? `(${yesterday.date}, ${yesterday.values.size}条)` : '(无数据)'}, 上周${lastWeek.date ? `(${lastWeek.date}, ${lastWeek.values.size}条)` : '(无数据)'}`);
      } else {
        log('同比/环比: 暂无历史数据');
      }
    } catch (err) {
      log(`同比/环比加载失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    enrichWithComparison(diagnoses, comparison);
    criticals = diagnoses.filter(d => d.severity === 'critical').length;
    warnings = diagnoses.filter(d => d.severity === 'warning').length;
    normals = diagnoses.filter(d => d.severity === 'normal').length;

    const reportText = buildReportText(diagnoses, totalRawPanels, {
      truncate: !collectOnly,
      comparison,
    });
    log(`报告文本 ${reportText.length} 字`);

    if (collectOnly) {
      const todayFile = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      const dataPath = path.join(LOG_DIR, `${config.report_type}-panel-data-${todayFile}.md`);
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(dataPath, reportText);

      const diagnosisPath = path.join(LOG_DIR, `${config.report_type}-diagnosis-${todayFile}.json`);
      const compLookup = (panelTitle: string, label: string, src: HistoricalMetricMap | undefined) => {
        if (!src) return undefined;
        return src.values.get(`${panelTitle}::${label}`);
      };
      const summary = {
        name: config.name,
        report_type: config.report_type,
        date: todayFile,
        total_panels: totalRawPanels,
        data_panels: diagnoses.length,
        no_data_panels: _noDataPanels.length,
        skipped_panels: _skippedPanels.length,
        critical: criticals,
        warning: warnings,
        normal: normals,
        comparison_dates: {
          yesterday: comparison?.yesterday.date ?? null,
          lastWeek: comparison?.lastWeek.date ?? null,
        },
        diagnoses: diagnoses.map(d => ({
          panelTitle: d.panelTitle,
          rowTitle: d.rowTitle,
          severity: d.severity,
          reasons: d.reasons,
          stats: d.stats.map(s => {
            const ydVal = compLookup(d.panelTitle, s.label, comparison?.yesterday);
            const lwVal = compLookup(d.panelTitle, s.label, comparison?.lastWeek);
            return {
              label: s.label,
              latest: s.latest,
              mean: s.mean,
              max: s.max,
              min: s.min,
              trend: s.trend,
              trendPct: s.trendPct,
              spikeCount: s.spikeCount,
              zeroStreak: s.zeroStreak,
              yesterdayValue: ydVal ?? null,
              yesterdayChangePct: ydVal !== undefined && ydVal !== 0
                ? Number((((s.latest - ydVal) / Math.abs(ydVal)) * 100).toFixed(1))
                : null,
              lastWeekValue: lwVal ?? null,
              lastWeekChangePct: lwVal !== undefined && lwVal !== 0
                ? Number((((s.latest - lwVal) / Math.abs(lwVal)) * 100).toFixed(1))
                : null,
            };
          }),
        })),
      };
      fs.writeFileSync(diagnosisPath, JSON.stringify(summary, null, 2));

      log(`数据采集完成 (--collect-only 模式)`);
      log(`  面板数据: ${dataPath}`);
      log(`  诊断 JSON: ${diagnosisPath}`);
      log(`=== ${config.name} 数据采集完成 ===`);
      return;
    }

    const megaSaleContext = getMegaSaleContext();
    log(`使用 ${DUTY_MODELS.length} 个模型进行分析: ${DUTY_MODELS.join(', ')}`);
    const modelResults = await analyzeWithAllModels(diagnoses, combinedContext, megaSaleContext);

    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = renderSubjectTemplate(config.output.subject_template, {
      today,
      name: config.name,
      criticalCount: criticals,
    });
    const htmlBody = buildHtmlEmail(reportText, modelResults, diagnoses, today, totalRawPanels);

    try {
      await sendEmail(subject, htmlBody, RECIPIENT);
      const statusLine = criticals > 0
        ? `⚠️ 发现 ${criticals} 个严重异常, ${warnings} 个告警`
        : warnings > 0
          ? `⚡ 发现 ${warnings} 个告警，无严重异常`
          : `✅ 全部正常`;
      sendIpcAlert(`${TASK_TAG}${config.name}报告已发送\n${statusLine}\n收件人: ${RECIPIENT}\n主题: ${subject}`);
    } catch (emailErr) {
      log(`邮件发送失败: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`);
      const firstAnalysis = modelResults[0]?.analysis || '无分析结果';
      sendIpcAlert(`${TASK_TAG}⚠️ ${config.name}邮件发送失败，以下是分析结果：\n\n${firstAnalysis.slice(0, 3000)}`);
    }

    log(`=== ${config.name} 流程完成 ===`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`致命错误: ${errMsg}`);
    sendIpcAlert(`${TASK_TAG}❌ ${config.name}生成失败: ${errMsg}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
