/**
 * 今日新闻 RSS 抓取（宿主机运行，写入 data/news-brief-YYYY-MM-DD.md）
 *
 * 运行：npx tsx scripts/news-summary.ts
 * 可选定时：cron 或 launchd 每日早晨执行，供 news-summary + newspaper-brief 组合使用。
 *
 * 主源为 BBC；若超时或失败则依次尝试卫报、NPR、TechCrunch、Google News 等备用源（国内网络下 BBC 常不可用）。
 */
import fs from 'fs';
import path from 'path';

import { translateNewsTitlesToZh } from './lib/translate-en-to-zh.js';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DATE = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const OUT_PATH = path.join(DATA_DIR, `news-brief-${DATE}.md`);

/**
 * 每个栏目按顺序尝试，首个成功且解析出条目者采用。
 * 顺序：国际优质源在前（BBC/Guardian/NPR/TechCrunch/Google News），
 * 国内可达源兜底（China Daily / Xinhua / People's Daily）以防外网全挂。
 */
const RSS_FALLBACKS: Record<string, string[]> = {
  world: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.theguardian.com/world/rss',
    'https://feeds.npr.org/1001/rss.xml',
    'https://news.google.com/rss/search?q=world+news&hl=en-US&gl=US&ceid=US:en',
    'https://www.chinadaily.com.cn/rss/world_rss.xml',
    'http://www.xinhuanet.com/english/rss/worldrss.xml',
    'http://en.people.cn/rss/90000.xml',
  ],
  business: [
    'https://feeds.bbci.co.uk/news/business/rss.xml',
    'https://www.theguardian.com/business/rss',
    'https://news.google.com/rss/search?q=business+economy&hl=en-US&gl=US&ceid=US:en',
    'https://www.chinadaily.com.cn/rss/bizchina_rss.xml',
    'http://en.people.cn/business/rss/90778.xml',
  ],
  technology: [
    'https://feeds.bbci.co.uk/news/technology/rss.xml',
    'https://www.theguardian.com/technology/rss',
    'https://techcrunch.com/feed/',
    'https://news.google.com/rss/search?q=technology&hl=en-US&gl=US&ceid=US:en',
    'https://www.chinadaily.com.cn/rss/tech_rss.xml',
    'http://en.people.cn/rss/90001.xml',
  ],
};

const MAX_ITEMS_PER_SECTION = 5;

/** 跳过频道占位标题 */
const GENERIC_TITLE =
  /^(BBC News|World|Business|Technology|The Guardian|NPR News|Top Stories|Google News)$/i;

/** 在 data/ 里查找比今天更早且非空的 news-brief，用于"全空不覆盖"兜底 */
function findLatestExistingBrief(todayPath: string): string | null {
  const dir = path.dirname(todayPath);
  const todayName = path.basename(todayPath);
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /^news-brief-\d{4}-\d{2}-\d{2}\.md$/.test(f) && f !== todayName)
    .sort();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const p = path.join(dir, candidates[i]);
    try {
      if (fs.statSync(p).size > 256) return p;
    } catch {}
  }
  return null;
}

function extractItems(xml: string): Array<{ title: string; link: string }> {
  const items: Array<{ title: string; link: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(
      /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/is,
    );
    const linkMatch = block.match(/<link>(.*?)<\/link>/i);
    let title = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? '').trim() : '';
    title = title.replace(/<[^>]+>/g, '').trim();
    const link = linkMatch ? linkMatch[1].trim() : '';
    if (title && !GENERIC_TITLE.test(title)) {
      items.push({ title, link });
    }
  }
  return items.slice(0, MAX_ITEMS_PER_SECTION);
}

async function fetchRss(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; NanoClawNews/1; +https://github.com/)',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** 把 fetch/DNS 错误收敛成单行 reason，避免每个源都把 stack 全部打到 stderr */
function briefErr(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { message?: string; cause?: { code?: string; hostname?: string; message?: string } };
  const cause = e.cause;
  if (cause?.code && cause?.hostname) return `${cause.code} ${cause.hostname}`;
  if (cause?.code) return `${cause.code}${cause.message ? ` ${cause.message}` : ''}`;
  return e.message ?? 'unknown error';
}

async function fetchSectionWithFallbacks(
  sectionKey: string,
  urls: string[],
): Promise<{ items: Array<{ title: string; link: string }>; sourceUrl: string }> {
  const attemptReasons: string[] = [];
  for (const url of urls) {
    try {
      const xml = await fetchRss(url);
      const items = extractItems(xml);
      if (items.length > 0) {
        console.log(
          `[news-summary] ${sectionKey}: ok (${items.length} items) from ${url}`,
        );
        return { items, sourceUrl: url };
      }
      attemptReasons.push(`${url} -> empty`);
    } catch (err) {
      attemptReasons.push(`${url} -> ${briefErr(err)}`);
    }
  }
  console.warn(
    `[news-summary] ${sectionKey}: all fallbacks failed (${attemptReasons.length} tried)`,
  );
  for (const r of attemptReasons) console.warn(`  · ${r}`);
  return { items: [], sourceUrl: '' };
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const sections: Record<string, Array<{ title: string; link: string }>> = {
    world: [],
    business: [],
    technology: [],
  };
  const sources: Record<string, string> = {};

  for (const key of Object.keys(sections) as Array<keyof typeof RSS_FALLBACKS>) {
    const urls = RSS_FALLBACKS[key];
    const { items, sourceUrl } = await fetchSectionWithFallbacks(key, urls);
    sections[key] = items;
    if (sourceUrl) sources[key] = sourceUrl;
  }

  // 若所有栏目都没拉到条目（通常是全外网不可达），保留昨天/历史的可用文件，
  // 避免用空壳覆盖掉后续推送流程依赖的正常内容。
  const totalItems = Object.values(sections).reduce((n, s) => n + s.length, 0);
  if (totalItems === 0) {
    const latestExisting = findLatestExistingBrief(OUT_PATH);
    if (latestExisting && latestExisting !== OUT_PATH) {
      console.warn(
        `[news-summary] all sections empty — keeping latest available: ${path.basename(
          latestExisting,
        )} (not overwriting with empty file)`,
      );
      process.exit(2);
    }
    console.warn(
      '[news-summary] all sections empty and no previous brief available',
    );
  }

  // 英文标题译为中文后再写入（便于推送与阅读）
  const keys = ['world', 'business', 'technology'] as const;
  const flatTitles: string[] = [];
  const ranges: Array<{ key: (typeof keys)[number]; start: number; len: number }> =
    [];
  let offset = 0;
  for (const key of keys) {
    const list = sections[key];
    const titles = list.map((i) => i.title);
    ranges.push({ key, start: offset, len: titles.length });
    flatTitles.push(...titles);
    offset += titles.length;
  }
  const zhTitles = await translateNewsTitlesToZh(flatTitles);
  for (const r of ranges) {
    const slice = zhTitles.slice(r.start, r.start + r.len);
    sections[r.key] = sections[r.key].map((item, i) => ({
      ...item,
      title: slice[i] ?? item.title,
    }));
  }

  function hostOf(u: string): string {
    if (!u) return '无';
    try {
      return new URL(u).hostname;
    } catch {
      return u.slice(0, 48);
    }
  }

  const metaLines =
    Object.keys(sources).length > 0
      ? [
          '',
          `> 数据来源（每栏首个成功源）：世界 ${hostOf(sources.world ?? '')}；商业 ${hostOf(sources.business ?? '')}；科技 ${hostOf(sources.technology ?? '')}`,
          process.env.NEWS_SUMMARY_NO_TRANSLATE === '1'
            ? '> 标题未翻译（NEWS_SUMMARY_NO_TRANSLATE=1）'
            : '> 标题已译为简体中文（无 OPENAI 时使用 MyMemory 免费接口，可配置 OPENAI_API_KEY 提高质量）',
          '',
        ]
      : ['', '> 本日各栏均未拉到条目，请检查网络或稍后重试。', ''];

  const lines: string[] = [
    `# 今日要闻 ${DATE}`,
    ...metaLines,
    '## 世界',
    ...sections.world.map(
      (i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`,
    ),
    '',
    '## 商业',
    ...sections.business.map(
      (i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`,
    ),
    '',
    '## 科技',
    ...sections.technology.map(
      (i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`,
    ),
    '',
    '## 观点',
    '- （由 news-summary 或 agent 根据上述要闻补充简短判断）',
    '',
  ];

  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`[news-summary] wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[news-summary]', err);
  process.exit(1);
});
