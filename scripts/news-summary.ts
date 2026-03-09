/**
 * 今日新闻 RSS 抓取（宿主机运行，写入 data/news-brief-YYYY-MM-DD.md）
 *
 * 运行：npx tsx scripts/news-summary.ts
 * 可选定时：cron 或 launchd 每日早晨执行，供 news-summary + newspaper-brief 组合使用。
 *
 * 数据源：BBC World / Business / Technology RSS。容器内无直连公网，本脚本需在宿主机执行。
 */
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DATE = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const OUT_PATH = path.join(DATA_DIR, `news-brief-${DATE}.md`);

const RSS_URLS: Record<string, string> = {
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
};

const MAX_ITEMS_PER_SECTION = 5;

function extractItems(xml: string): Array<{ title: string; link: string }> {
  const items: Array<{ title: string; link: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i);
    const linkMatch = block.match(/<link>(.*?)<\/link>/i);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? '').trim() : '';
    const link = linkMatch ? linkMatch[1].trim() : '';
    if (title && !title.match(/^(BBC News|World|Business|Technology)$/i)) {
      items.push({ title, link });
    }
  }
  return items.slice(0, MAX_ITEMS_PER_SECTION);
}

async function fetchRss(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/1)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const sections: Record<string, Array<{ title: string; link: string }>> = {
    world: [],
    business: [],
    technology: [],
  };

  for (const [key, url] of Object.entries(RSS_URLS)) {
    try {
      const xml = await fetchRss(url);
      sections[key] = extractItems(xml);
    } catch (err) {
      console.error(`[news-summary] ${key} fetch failed:`, err);
    }
  }

  const lines: string[] = [
    `# 今日要闻 ${DATE}`,
    '',
    '## 世界',
    ...sections.world.map((i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`),
    '',
    '## 商业',
    ...sections.business.map((i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`),
    '',
    '## 科技',
    ...sections.technology.map((i) => `- ${i.title}${i.link ? ` ${i.link}` : ''}`),
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
