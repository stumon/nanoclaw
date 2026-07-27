/**
 * 24h Intelligence Station — main entry point.
 *
 * Fetches from all configured sources, deduplicates, AI-scores,
 * formats, and pushes to WhatsApp via IPC.
 *
 * Usage:
 *   npx tsx scripts/intel-station.ts                    # auto-detect morning/evening
 *   npx tsx scripts/intel-station.ts --period morning   # force morning
 *   npx tsx scripts/intel-station.ts --period evening   # force evening
 *   npx tsx scripts/intel-station.ts --dry-run          # fetch + score, don't push
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { fetchAllSources, type IntelItem } from './lib/intel-fetcher.js';
import { dedup } from './lib/intel-dedup.js';
import {
  scoreAndFilter,
  generateInsight,
  type ScoredItem,
} from './lib/intel-scorer.js';

// ── .env loader (for launchd which has minimal env) ─────

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
let period = 'morning';

const periodIdx = args.indexOf('--period');
if (periodIdx !== -1 && args[periodIdx + 1]) {
  period = args[periodIdx + 1];
} else {
  // Auto-detect based on current hour (Beijing time)
  const bjHour = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  ).getHours();
  period = bjHour < 15 ? 'morning' : 'evening';
}

const periodLabel = period === 'morning' ? '早间情报' : '晚间情报';
const periodEmoji = period === 'morning' ? '\u{1F4E1}' : '\u{1F319}';

// ── Load config ─────────────────────────────────────────

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'intel-sources.yaml');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[intel] Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}

const config = parseYaml(fs.readFileSync(CONFIG_PATH, 'utf-8')) as {
  categories: Record<
    string,
    { label: string; emoji: string; sources: any[] }
  >;
  scoring: {
    model: string;
    min_score: number;
    max_items_per_category: number;
    user_profile: string;
  };
  ipc: { dir_relative: string; chat_jid: string };
};

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DATE = new Date().toISOString().slice(0, 10);
const OUT_PATH = path.join(DATA_DIR, `intel-brief-${period}-${DATE}.md`);
const LOG_PREFIX = '[intel]';

function log(...args: unknown[]) {
  console.log(LOG_PREFIX, ...args);
}

// ── Format output ───────────────────────────────────────

function formatWhatsAppMessage(
  scored: Record<string, ScoredItem[]>,
  insight: string,
): string {
  const lines: string[] = [`${periodEmoji} ${periodLabel} ${DATE}`, ''];

  let totalItems = 0;

  for (const [catKey, items] of Object.entries(scored)) {
    if (items.length === 0) continue;
    const catDef = config.categories[catKey];
    if (!catDef) continue;

    totalItems += items.length;
    lines.push(`${catDef.emoji} ${catDef.label} (${items.length})`);
    for (const item of items) {
      lines.push(`• [${item.score}分] ${item.title} — ${item.comment}`);
    }
    lines.push('');
  }

  if (totalItems === 0) {
    lines.push('今日暂无高分情报，信息源均为常规内容。');
    lines.push('');
  }

  lines.push(`\u{1F4A1} 观点`);
  lines.push(insight);

  return lines.join('\n');
}

function formatMarkdown(
  scored: Record<string, ScoredItem[]>,
  insight: string,
): string {
  const lines: string[] = [`# ${periodLabel} ${DATE}`, ''];

  for (const [catKey, items] of Object.entries(scored)) {
    if (items.length === 0) continue;
    const catDef = config.categories[catKey];
    if (!catDef) continue;

    lines.push(`## ${catDef.label}`);
    for (const item of items) {
      const urlPart = item.url ? ` [link](${item.url})` : '';
      lines.push(
        `- **[${item.score}分]** ${item.title} — ${item.comment}${urlPart}`,
      );
    }
    lines.push('');
  }

  lines.push('## 观点');
  lines.push(insight);
  lines.push('');

  return lines.join('\n');
}

// ── IPC push ────────────────────────────────────────────

function pushToWhatsApp(text: string): void {
  const ipcDir = path.join(PROJECT_ROOT, config.ipc.dir_relative);
  fs.mkdirSync(ipcDir, { recursive: true });

  const ts = Date.now();
  const filename = `intel-${period}-${ts}.json`;
  const msg = {
    type: 'message',
    chatJid: config.ipc.chat_jid,
    text,
  };

  fs.writeFileSync(path.join(ipcDir, filename), JSON.stringify(msg, null, 2), 'utf-8');
  log(`IPC message written: ${filename} (${text.length} bytes)`);
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  log(`Starting ${periodLabel} (${DATE})`);
  const startTime = Date.now();

  // 1. Fetch all sources in parallel
  log('Fetching sources...');
  const raw = await fetchAllSources(config.categories, {
    tavilyApiKey: process.env.TAVILY_API_KEY,
    maxItemsPerSource: 10,
  });

  const rawCount = Object.values(raw).reduce((sum, items) => sum + items.length, 0);
  log(`Fetched ${rawCount} items from ${Object.keys(raw).length} categories`);

  // 2. Deduplicate
  log('Deduplicating...');
  const deduped = dedup(raw);
  const dedupCount = Object.values(deduped).reduce(
    (sum, items) => sum + items.length,
    0,
  );
  log(`After dedup: ${dedupCount} items (removed ${rawCount - dedupCount})`);

  // 3. AI scoring
  log('Scoring with AI...');
  const scored = await scoreAndFilter(deduped, {
    model: config.scoring.model,
    minScore: config.scoring.min_score,
    maxItemsPerCategory: config.scoring.max_items_per_category,
    userProfile: config.scoring.user_profile,
  });

  const scoredCount = Object.values(scored).reduce(
    (sum, items) => sum + items.length,
    0,
  );
  log(
    `After scoring: ${scoredCount} items passed (threshold >= ${config.scoring.min_score})`,
  );

  // 4. Generate editorial insight
  log('Generating insight...');
  const insight = await generateInsight(scored, config.scoring.model);

  // 5. Format and save
  const markdown = formatMarkdown(scored, insight);
  fs.writeFileSync(OUT_PATH, markdown, 'utf-8');
  log(`Saved to ${OUT_PATH}`);

  const waMessage = formatWhatsAppMessage(scored, insight);

  if (dryRun) {
    log('=== DRY RUN — message preview ===');
    console.log(waMessage);
  } else {
    // 6. Push to WhatsApp
    log('Pushing to WhatsApp...');
    pushToWhatsApp(waMessage);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s (${rawCount} fetched -> ${dedupCount} deduped -> ${scoredCount} scored)`);
}

main().catch((err) => {
  console.error(LOG_PREFIX, 'Fatal error:', err);
  process.exit(1);
});
