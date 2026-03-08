#!/usr/bin/env npx tsx
/**
 * Feishu Bitable Asset Updater
 *
 * Called by the agent inside the container to update Feishu bitable records.
 * Accepts JSON data via --data (or stdin) plus a --token for auth.
 *
 * Usage:
 *   npx tsx scripts/update-lark-assets.ts --token <user_access_token> --data '<json>'
 *   echo '<json>' | npx tsx scripts/update-lark-assets.ts --token <user_access_token>
 *
 * JSON format:
 * {
 *   "platforms": [
 *     {
 *       "name": "中国银河证券",
 *       "mode": "replace",    // delete all existing records for this platform, then create
 *       "holdings": [
 *         { "asset": "中国平安", "assetType": "A股", "quantity": 1100, "priceCNY": 65.29 },
 *         ...
 *       ],
 *       "cash": 49545.98,           // optional: platform cash in CNY
 *       "cashCurrency": "CNY",      // optional: default CNY
 *       "cashRate": 1.0             // optional: exchange rate to CNY
 *     },
 *     {
 *       "name": "支付宝",
 *       "mode": "upsert",    // find existing records and update, or create new
 *       "holdings": [
 *         { "asset": "余额宝", "assetType": "货币基金", "quantity": 2904.73, "priceCNY": 1.0 },
 *         { "asset": "基金组合", "assetType": "基金", "quantity": 48635.69, "priceCNY": 1.0 }
 *       ]
 *     }
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';

const BASE_ID = 'WlHUbyiobawU1GssgoXcdfE0noh';
const TABLE_ID = 'tblhHUfS83WUvSCj';
const BASE_URL = 'https://open.feishu.cn/open-apis';

interface Holding {
  asset: string;
  assetType: string;
  quantity: number;
  priceCNY: number;
}

interface PlatformUpdate {
  name: string;
  mode: 'replace' | 'upsert';
  holdings: Holding[];
  cash?: number;
  cashCurrency?: string;
  cashRate?: number;
}

interface InputData {
  platforms: PlatformUpdate[];
}

interface LarkRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

// ─── HTTP helpers (no external deps — uses Node built-in fetch) ─────────────

async function larkGet(token: string, endpoint: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

async function larkPost(token: string, endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function larkPut(token: string, endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function larkDelete(token: string, endpoint: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

// ─── Bitable operations ─────────────────────────────────────────────────────

const recordsEndpoint = `/bitable/v1/apps/${BASE_ID}/tables/${TABLE_ID}/records`;

async function getAllRecords(token: string): Promise<LarkRecord[]> {
  const all: LarkRecord[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = { page_size: '100' };
    if (pageToken) params.page_token = pageToken;
    const data = await larkGet(token, recordsEndpoint, params);
    if (data.data?.items) all.push(...data.data.items);
    pageToken = data.data?.page_token;
  } while (pageToken);

  return all;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    return first.text || first.name || String(first);
  }
  if (typeof value === 'object' && value !== null) {
    return (value as any).text || (value as any).name || String(value);
  }
  return String(value || '');
}

async function deleteRecordsForPlatform(token: string, records: LarkRecord[], platform: string): Promise<number> {
  const toDelete = records.filter(r => extractText(r.fields['平台']) === platform);
  let count = 0;
  for (const r of toDelete) {
    try {
      await larkDelete(token, `${recordsEndpoint}/${r.record_id}`);
      count++;
      await sleep(50);
    } catch { /* skip */ }
  }
  return count;
}

async function createRecord(token: string, fields: Record<string, unknown>): Promise<void> {
  await larkPost(token, recordsEndpoint, { fields });
}

async function updateRecord(token: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
  await larkPut(token, `${recordsEndpoint}/${recordId}`, { fields });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Platform handlers ──────────────────────────────────────────────────────

async function handleReplace(
  token: string,
  records: LarkRecord[],
  platform: PlatformUpdate,
): Promise<{ deleted: number; created: number; failed: number }> {
  const stats = { deleted: 0, created: 0, failed: 0 };

  stats.deleted = await deleteRecordsForPlatform(token, records, platform.name);
  console.log(`  [${platform.name}] deleted ${stats.deleted} old records`);

  for (const h of platform.holdings) {
    try {
      await createRecord(token, {
        '平台': platform.name,
        '资产': h.asset,
        '资产类型': h.assetType,
        '持仓数量': h.quantity,
        '价格-CNY': h.priceCNY,
      });
      stats.created++;
      await sleep(50);
    } catch (err) {
      console.error(`  [${platform.name}] failed to create ${h.asset}: ${err}`);
      stats.failed++;
    }
  }

  if (platform.cash != null) {
    try {
      await createRecord(token, {
        '平台': platform.name,
        '资产': platform.cashCurrency || 'CNY',
        '资产类型': '现金',
        '持仓数量': platform.cash,
        '价格-CNY': platform.cashRate ?? 1.0,
      });
      stats.created++;
    } catch (err) {
      console.error(`  [${platform.name}] failed to create cash: ${err}`);
      stats.failed++;
    }
  }

  return stats;
}

async function handleUpsert(
  token: string,
  records: LarkRecord[],
  platform: PlatformUpdate,
): Promise<{ updated: number; created: number; failed: number }> {
  const stats = { updated: 0, created: 0, failed: 0 };

  for (const h of platform.holdings) {
    try {
      const existing = records.find(r => {
        const p = extractText(r.fields['平台']);
        const t = extractText(r.fields['资产类型']);
        const a = extractText(r.fields['资产']);
        return p === platform.name && (t === h.assetType || a === h.asset);
      });

      if (existing) {
        await updateRecord(token, existing.record_id, {
          '持仓数量': h.quantity,
          '价格-CNY': h.priceCNY,
        });
        stats.updated++;
      } else {
        await createRecord(token, {
          '平台': platform.name,
          '资产': h.asset,
          '资产类型': h.assetType,
          '持仓数量': h.quantity,
          '价格-CNY': h.priceCNY,
        });
        stats.created++;
      }
      await sleep(50);
    } catch (err) {
      console.error(`  [${platform.name}] failed to upsert ${h.asset}: ${err}`);
      stats.failed++;
    }
  }

  if (platform.cash != null) {
    try {
      const existing = records.find(r => {
        const p = extractText(r.fields['平台']);
        const t = extractText(r.fields['资产类型']);
        return p === platform.name && t === '现金';
      });
      if (existing) {
        await updateRecord(token, existing.record_id, {
          '持仓数量': platform.cash,
          '价格-CNY': platform.cashRate ?? 1.0,
        });
        stats.updated++;
      } else {
        await createRecord(token, {
          '平台': platform.name,
          '资产': platform.cashCurrency || 'CNY',
          '资产类型': '现金',
          '持仓数量': platform.cash,
          '价格-CNY': platform.cashRate ?? 1.0,
        });
        stats.created++;
      }
    } catch (err) {
      console.error(`  [${platform.name}] failed to upsert cash: ${err}`);
      stats.failed++;
    }
  }

  return stats;
}

// ─── Token management ────────────────────────────────────────────────────────

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json() as any;
  if (data.code !== 0) {
    throw new Error(`Failed to get tenant token: code=${data.code} msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

function readEnvVars(): { appId: string; appSecret: string } {
  // Check environment variables first (set by container agent-runner)
  if (process.env.APPID && process.env.APPSecret) {
    return { appId: process.env.APPID, appSecret: process.env.APPSecret };
  }
  // Fall back to .env file (when running on host directly)
  const candidates = [
    path.join(process.cwd(), '.env'),
    '/workspace/project/.env',
  ];
  for (const envPath of candidates) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const vars: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
      if (vars.APPID && vars.APPSecret) {
        return { appId: vars.APPID, appSecret: vars.APPSecret };
      }
    } catch { /* try next */ }
  }
  return { appId: '', appSecret: '' };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let token = '';
  let dataStr = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      token = args[++i];
    } else if (args[i] === '--data' && args[i + 1]) {
      dataStr = args[++i];
    }
  }

  // Auto-obtain token if not provided
  if (!token) {
    const { appId, appSecret } = readEnvVars();
    if (appId && appSecret) {
      console.log('No --token provided, obtaining tenant_access_token from app credentials...');
      token = await getTenantToken(appId, appSecret);
    } else {
      console.error('No --token and no APPID/APPSecret in .env. Cannot authenticate.');
      process.exit(1);
    }
  }

  // Read from stdin if --data not provided
  if (!dataStr) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    dataStr = Buffer.concat(chunks).toString('utf-8');
  }

  let input: InputData;
  try {
    input = JSON.parse(dataStr);
  } catch (err) {
    console.error(`Invalid JSON: ${err}`);
    process.exit(1);
  }

  if (!input.platforms || !Array.isArray(input.platforms)) {
    console.error('JSON must have a "platforms" array');
    process.exit(1);
  }

  console.log(`Fetching existing records...`);
  const records = await getAllRecords(token);
  console.log(`Found ${records.length} existing records`);

  const totals = { deleted: 0, created: 0, updated: 0, failed: 0 };

  for (const platform of input.platforms) {
    console.log(`\nProcessing: ${platform.name} (mode: ${platform.mode})`);

    if (platform.mode === 'replace') {
      const s = await handleReplace(token, records, platform);
      totals.deleted += s.deleted;
      totals.created += s.created;
      totals.failed += s.failed;
    } else {
      const s = await handleUpsert(token, records, platform);
      totals.updated += s.updated;
      totals.created += s.created;
      totals.failed += s.failed;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Deleted: ${totals.deleted}`);
  console.log(`Created: ${totals.created}`);
  console.log(`Updated: ${totals.updated}`);
  console.log(`Failed: ${totals.failed}`);

  if (totals.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
