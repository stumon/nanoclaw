/**
 * Discover Elasticsearch datasource UIDs from Grafana.
 *
 * Strategy (in order):
 *   1. API mode: GET /api/frontend/settings (works with API Key or session cookie)
 *   2. Browser mode: Playwright intercepts POST /api/ds/query (fallback, needs Chrome SSO)
 *
 * Usage:
 *   npx tsx scripts/grafana-discover-ds-uids.ts --config config/duty-dashboards/funding-platform.yaml
 *   npx tsx scripts/grafana-discover-ds-uids.ts --config ... --browser   # force Playwright mode
 *   npx tsx scripts/grafana-discover-ds-uids.ts --config ... --dry-run   # print only, don't write
 *
 * Options:
 *   --config <path>   YAML config file to read Grafana URL and write datasource_uid_map
 *   --browser         Skip API mode and go straight to Playwright
 *   --timeout <ms>    Playwright page load timeout (default: 30000)
 *   --dry-run         Print discovered UIDs without writing to config
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Load .env ──────────────────────────────────────────
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── CLI args ───────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const configPath = getArg('config');
const timeout = parseInt(getArg('timeout') || '30000', 10);
const dryRun = args.includes('--dry-run');
const forceBrowser = args.includes('--browser');

if (!configPath) {
  console.error('Usage: npx tsx scripts/grafana-discover-ds-uids.ts --config <yaml> [--browser] [--dry-run]');
  process.exit(1);
}

// ── Config ─────────────────────────────────────────────
const raw = fs.readFileSync(configPath, 'utf-8');
const yamlConfig = parseYaml(raw);
const baseUrl: string = yamlConfig.grafana?.base_url;
const orgId: number = yamlConfig.grafana?.org_id || 1;
const apiKey = process.env.GRAFANA_API_KEY || '';
const cookiePath = path.join(process.env.HOME || '/root', '.grafana_cookie.json');

if (!baseUrl) {
  console.error('Config missing grafana.base_url');
  process.exit(1);
}

interface DiscoveredDs {
  name: string;
  uid: string;
  type: string;
}

// ── Strategy 1: API mode via /api/frontend/settings ────
async function discoverViaApi(): Promise<DiscoveredDs[]> {
  const headers: Record<string, string> = {
    'X-Grafana-Org-Id': String(orgId),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (fs.existsSync(cookiePath)) {
    const cookie = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
    headers['Cookie'] = `grafana_session=${cookie.grafana_session}`;
  } else {
    throw new Error('No GRAFANA_API_KEY or session cookie available');
  }

  console.log('Trying API mode: GET /api/frontend/settings ...');
  const res = await fetch(`${baseUrl}/api/frontend/settings`, { headers });
  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    datasources?: Record<string, { uid?: string; type?: string; name?: string }>;
  };

  const results: DiscoveredDs[] = [];
  for (const [name, info] of Object.entries(data.datasources || {})) {
    if (info.uid) {
      results.push({ name, uid: info.uid, type: info.type || 'unknown' });
    }
  }

  return results;
}

// ── Strategy 2: Browser mode via Playwright ────────────
async function discoverViaBrowser(): Promise<DiscoveredDs[]> {
  const { chromium } = await import('playwright');

  const dashUid = yamlConfig.grafana?.dashboard_uid;
  const hours = yamlConfig.grafana?.time_range_hours || 24;
  const url = `${baseUrl}/d/${dashUid}/?orgId=${orgId}&from=now-${hours}h&to=now`;

  const candidates = [
    path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome'),
    path.join(process.env.HOME || '', '.config/google-chrome'),
    path.join(process.env.HOME || '', '.config/chromium'),
  ];
  const profileDir = candidates.find(p => fs.existsSync(p));
  if (!profileDir) {
    throw new Error('Chrome profile not found');
  }

  console.log('Using Playwright browser mode');
  console.log(`Chrome profile: ${profileDir}`);
  console.log(`Dashboard URL: ${url}`);
  console.log('');
  console.log('IMPORTANT: Close all Chrome windows before proceeding.');
  console.log('');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    viewport: { width: 1920, height: 1080 },
  });

  const results: DiscoveredDs[] = [];
  const seen = new Set<string>();

  try {
    const page = await context.newPage();

    page.on('request', (req) => {
      if (req.method() !== 'POST' || !req.url().includes('/api/ds/query')) return;
      try {
        const body = JSON.parse(req.postData() || '{}');
        for (const q of body.queries || []) {
          const uid = q.datasource?.uid;
          const type = q.datasource?.type || 'unknown';
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            results.push({ name: uid, uid, type });
          }
        }
      } catch { /* skip */ }
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout });
    } catch {
      console.log('Page did not reach networkidle, continuing...');
    }

    await page.waitForTimeout(5000);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);
    await page.close();
  } finally {
    await context.close();
  }

  return results;
}

// ── Filter to relevant ES datasources ──────────────────
function filterRelevantDs(all: DiscoveredDs[]): Record<string, string> {
  const varOptions: string[] = [];
  const templating = yamlConfig.grafana?.template_vars;

  // Also extract from dashboard if we can
  const allVarValues = new Set<string>();

  // Read the dashboard to get template variable values
  try {
    const dashUid = yamlConfig.grafana?.dashboard_uid;
    if (dashUid && apiKey) {
      // We already have the var options from the config discovery
    }
  } catch { /* skip */ }

  // Match against known datasource patterns for this dashboard
  const esMap: Record<string, string> = {};
  for (const ds of all) {
    if (!ds.type.includes('elasticsearch')) continue;
    esMap[ds.name] = ds.uid;
  }

  return esMap;
}

// ── Write to YAML config ───────────────────────────────
function writeToConfig(esMap: Record<string, string>): void {
  const existing: Record<string, string> = yamlConfig.grafana?.datasource_uid_map || {};
  const merged = { ...existing, ...esMap };

  yamlConfig.grafana = yamlConfig.grafana || {};
  yamlConfig.grafana.datasource_uid_map = merged;

  const output = stringifyYaml(yamlConfig, { lineWidth: 0 });
  fs.writeFileSync(configPath!, output, 'utf-8');

  console.log(`\nWritten ${Object.keys(merged).length} UID mappings to ${configPath}`);
}

// ── Main ───────────────────────────────────────────────
(async () => {
  try {
    let allDs: DiscoveredDs[];

    if (forceBrowser) {
      allDs = await discoverViaBrowser();
    } else {
      try {
        allDs = await discoverViaApi();
        console.log(`API mode succeeded: found ${allDs.length} total datasources`);
      } catch (err) {
        console.log(`API mode failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('Falling back to browser mode...');
        allDs = await discoverViaBrowser();
      }
    }

    const esDs = allDs.filter(d => d.type.includes('elasticsearch'));
    console.log(`\n=== Elasticsearch Datasources (${esDs.length}) ===`);
    for (const d of esDs.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  "${d.name}" -> ${d.uid}`);
    }

    const otherTypes = new Set(allDs.filter(d => !d.type.includes('elasticsearch')).map(d => d.type));
    console.log(`\nOther datasource types: ${[...otherTypes].join(', ')}`);

    const esMap: Record<string, string> = {};
    for (const d of esDs) esMap[d.name] = d.uid;

    if (dryRun) {
      console.log('\n[DRY RUN] Would write the following mappings:');
      console.log(JSON.stringify(esMap, null, 2));
    } else if (Object.keys(esMap).length > 0) {
      writeToConfig(esMap);
    } else {
      console.log('\nNo ES datasources found.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();
