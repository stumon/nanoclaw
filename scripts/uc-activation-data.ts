/**
 * UC 激活申请单数据采集。
 * 从各国 Grafana Dashboard 的饼图面板查询 ES，获取新增用户、通过率及环比/同比。
 * 输出到 logs/uc-activation-{date}.md
 *
 * Usage: npx tsx scripts/uc-activation-data.ts
 */
import fs from 'fs';
import path from 'path';

// ── Load .env ──
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const GRAFANA_BASE = 'https://monitoring.infra.sz.shopee.io/grafana';
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY || '';
const COOKIE_PATH = path.join(process.env.HOME || '/root', '.grafana_cookie.json');
const LOG_DIR = path.join(process.cwd(), 'logs');

const COUNTRY_DASHBOARDS: Record<string, string> = {
  ID: '6PtXp0gDk',
  TH: 'YQPet0gDz',
  PH: '2-SS20gvk',
  MY: '2sch2ARDz',
  SG: 'A5E41Agvz',
  VN: 'SwzKJ0gDz',
  BR: 'ARYt10gDz',
  TW: 'ZRHPJARDz',
  MX: 'jqMUJ0Rvz',
};

const DS_UID_TO_ID: Record<string, number> = {
  ztQohUNnk: 834,
  Th0wqsYVk: 5941,
  NpcN5vF4k: 5109,
  'Gv6ZUC_nz': 2053,
  HdkeTUHnz: 837,
  oMwH6nP7k: 1683,
  QE4M2LK4k: 5136,
  AhJ6GKxnz: 1460,
  Le0TFeMIk: 7625,
  U8disEcNz: 13784,
};

const PRODUCT_CODE_ORDER = ['SPLX', 'SPL', 'CHP', 'BCL', 'SCL', 'FES', 'SL', 'CL'];
const PRODUCT_NAME_MAP: Record<string, string> = {
  SPL: 'SPL', CL: 'buyerloan', SL: 'sellerloan', FES: 'fastEscrow',
  CHP: 'CicilanHP', SPLX: 'SPLX', BCL: 'BCL', SCL: 'SCL',
};
const PRODUCT_SORT: Record<string, number> = {
  SPL: 1, CL: 2, BCL: 3, SL: 4, FES: 5, CHP: 6, SPLX: 7, SCL: 8,
};

interface PanelTarget {
  query: string;
  timeField: string;
  bucketAggs: Array<{ id: string; type: string; settings: unknown }>;
  datasource?: { type?: string; uid?: string };
}

interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  datasource?: { type?: string; uid?: string };
  targets?: PanelTarget[];
  panels?: GrafanaPanel[];
  collapsed?: boolean;
}

interface PeriodData { total: number; passed: number; passRate: number }

interface ProductRow {
  name: string;
  code: string;
  sortOrder: number;
  today: PeriodData;
  yesterday: PeriodData;
  lastWeek: PeriodData;
  dodPassedPct: number;
  dodRatePct: number;
  wowPassedPct: number;
  wowRatePct: number;
}

interface CountryReport {
  country: string;
  products: ProductRow[];
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function gfHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GRAFANA_API_KEY) {
    h['Authorization'] = `Bearer ${GRAFANA_API_KEY}`;
  } else {
    try {
      const raw = fs.readFileSync(COOKIE_PATH, 'utf-8');
      const cookie = JSON.parse(raw);
      if (cookie.grafana_session) {
        h['Cookie'] = `grafana_session=${cookie.grafana_session}`;
      }
    } catch { /* ignore */ }
  }
  return h;
}

function extractProductCode(title: string): string | null {
  for (const code of PRODUCT_CODE_ORDER) {
    if (title.includes(code)) return code;
  }
  return null;
}

function changePct(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / Math.abs(previous)) * 100;
}

async function fetchDashboardPanels(uid: string): Promise<GrafanaPanel[]> {
  const url = `${GRAFANA_BASE}/api/dashboards/uid/${uid}`;
  const res = await fetch(url, { headers: gfHeaders() });
  if (!res.ok) throw new Error(`Dashboard ${uid} fetch failed: ${res.status}`);
  const json = await res.json() as { dashboard: { panels: GrafanaPanel[] } };
  const all: GrafanaPanel[] = [];
  for (const p of json.dashboard.panels || []) {
    if (p.type === 'row' && p.collapsed && p.panels?.length) {
      all.push(...p.panels);
    } else {
      all.push(p);
    }
  }
  return all;
}

async function queryESPeriod(target: PanelTarget, from: number, to: number): Promise<PeriodData> {
  const dsUid = target.datasource?.uid || '';
  const dsId = DS_UID_TO_ID[dsUid];
  if (!dsId) throw new Error(`Unknown datasource UID: ${dsUid}`);

  const filtersAgg = target.bucketAggs?.find(a => a.type === 'filters');
  if (!filtersAgg) throw new Error('No filters bucketAgg');
  const settings = filtersAgg.settings as { filters?: Array<{ label: string; query: string }> };
  if (!settings.filters?.length) throw new Error('No filters in settings');

  const filterQueries: Record<string, unknown> = {};
  for (const f of settings.filters) {
    filterQueries[f.label] = { query_string: { query: f.query, analyze_wildcard: true } };
  }

  const esQuery = {
    size: 0,
    query: {
      bool: {
        filter: [
          { range: { [target.timeField]: { gte: from, lte: to, format: 'epoch_millis' } } },
          { query_string: { analyze_wildcard: true, query: target.query } },
        ],
      },
    },
    aggs: { '3': { filters: { filters: filterQueries } } },
  };

  let indexName = '*apply*';
  const idxMatch = target.query.match(/_index:(\S+)/);
  if (idxMatch) indexName = idxMatch[1];

  const header = JSON.stringify({ search_type: 'query_then_fetch', ignore_unavailable: true, index: indexName });
  const body = `${header}\n${JSON.stringify(esQuery)}\n`;

  const url = `${GRAFANA_BASE}/api/datasources/proxy/${dsId}/_msearch`;
  const hdrs = gfHeaders();
  hdrs['Content-Type'] = 'application/x-ndjson';

  const res = await fetch(url, { method: 'POST', headers: hdrs, body });
  if (!res.ok) throw new Error(`ES query failed: ${res.status}`);

  const json = await res.json() as {
    responses?: Array<{ aggregations?: { '3'?: { buckets?: Record<string, { doc_count: number }> } } }>;
  };

  const buckets = json.responses?.[0]?.aggregations?.['3']?.buckets || {};
  let total = 0;
  let passed = 0;
  for (const [label, bucket] of Object.entries(buckets)) {
    total += bucket.doc_count;
    if (label === '通过') passed = bucket.doc_count;
  }
  const passRate = total > 0 ? Math.floor((passed * 100) / total) : 0;
  return { total, passed, passRate };
}

async function processCountry(country: string, uid: string): Promise<CountryReport> {
  log(`处理 ${country}...`);
  const panels = await fetchDashboardPanels(uid);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const todayRange = { from: now - DAY, to: now };
  const yesterdayRange = { from: now - 2 * DAY, to: now - DAY };
  const lastWeekRange = { from: now - 8 * DAY, to: now - 7 * DAY };

  const products: ProductRow[] = [];

  for (const panel of panels) {
    const code = extractProductCode(panel.title);
    if (!code) continue;
    if (!panel.targets?.length) continue;

    const target = panel.targets[0];
    if (!target.bucketAggs?.length) continue;

    try {
      const today = await queryESPeriod(target, todayRange.from, todayRange.to);
      if (today.total === 0) continue;

      let yesterday: PeriodData;
      try { yesterday = await queryESPeriod(target, yesterdayRange.from, yesterdayRange.to); }
      catch { yesterday = { total: 0, passed: 0, passRate: 0 }; }

      let lastWeek: PeriodData;
      try { lastWeek = await queryESPeriod(target, lastWeekRange.from, lastWeekRange.to); }
      catch { lastWeek = { total: 0, passed: 0, passRate: 0 }; }

      const name = PRODUCT_NAME_MAP[code] || code;
      products.push({
        name, code,
        sortOrder: PRODUCT_SORT[code] || 99,
        today, yesterday, lastWeek,
        dodPassedPct: changePct(today.passed, yesterday.passed),
        dodRatePct: changePct(today.passRate, yesterday.passRate),
        wowPassedPct: changePct(today.passed, lastWeek.passed),
        wowRatePct: changePct(today.passRate, lastWeek.passRate),
      });
      log(`  ${name}: 新增${today.passed}, 通过率${today.passRate}%, 环比${changePct(today.passed, yesterday.passed).toFixed(1)}%`);
    } catch (err) {
      log(`  ${code} 查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  products.sort((a, b) => a.sortOrder - b.sortOrder);
  return { country, products };
}

function fmtPct(v: number): string {
  if (v === 0) return '持平';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function isSmallSample(passed: number): boolean {
  return passed < 100;
}

function buildReport(reports: CountryReport[]): string {
  const lines: string[] = [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  lines.push(`=== UC 各地区激活申请单数据 (${today}) ===`);
  lines.push('红色标记表示环比或同比变化超过 20% 且新增用户超过100');
  lines.push('');

  for (const r of reports) {
    if (r.products.length === 0) continue;

    lines.push(`--- ${r.country} ---`);
    lines.push('产品 | 新增用户 | 通过率 | 环比(用户) | 环比(通过率) | 同比(用户) | 同比(通过率)');
    lines.push('--- | --- | --- | --- | --- | --- | ---');

    for (const p of r.products) {
      const small = isSmallSample(p.today.passed) ? ' (小样本)' : '';
      const dodPassedAlert = !isSmallSample(p.today.passed) && Math.abs(p.dodPassedPct) > 20 ? ' [!]' : '';
      const wowPassedAlert = !isSmallSample(p.today.passed) && Math.abs(p.wowPassedPct) > 20 ? ' [!]' : '';
      lines.push(
        `${p.name}${small} | ${p.today.passed.toLocaleString()} | ${p.today.passRate}% | ` +
        `${fmtPct(p.dodPassedPct)}${dodPassedAlert} | ${fmtPct(p.dodRatePct)} | ` +
        `${fmtPct(p.wowPassedPct)}${wowPassedAlert} | ${fmtPct(p.wowRatePct)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  log('=== UC 激活申请单数据采集开始 ===');

  const reports: CountryReport[] = [];
  for (const [country, uid] of Object.entries(COUNTRY_DASHBOARDS)) {
    try {
      const report = await processCountry(country, uid);
      reports.push(report);
    } catch (err) {
      log(`${country} 处理失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const text = buildReport(reports);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const outPath = path.join(LOG_DIR, `uc-activation-${today}.md`);
  fs.writeFileSync(outPath, text);

  log(`输出文件: ${outPath}`);
  log(`=== UC 激活申请单数据采集完成 ===`);
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
