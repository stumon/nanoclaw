/**
 * Multi-source parallel fetcher for the intelligence station.
 * Supports RSS, Tavily search, and GitHub Trending scraping.
 */

export interface IntelItem {
  title: string;
  url: string;
  source: string;
  category: string;
  /** Optional snippet / description from the source */
  snippet?: string;
}

interface SourceDef {
  type: 'rss' | 'tavily' | 'github_trending';
  url?: string;
  query?: string;
  name: string;
}

interface CategoryDef {
  label: string;
  emoji: string;
  sources: SourceDef[];
}

const UA = 'Mozilla/5.0 (compatible; NanoClaw-Intel/1)';
const FETCH_TIMEOUT = 15_000;

// ── RSS ─────────────────────────────────────────────────

function extractRssItems(
  xml: string,
  maxItems: number,
): Array<{ title: string; link: string; snippet?: string }> {
  const items: Array<{ title: string; link: string; snippet?: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(
      /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i,
    );
    const linkMatch = block.match(/<link>(.*?)<\/link>/i);
    const descMatch = block.match(
      /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/is,
    );
    const title = titleMatch
      ? (titleMatch[1] ?? titleMatch[2] ?? '').trim()
      : '';
    const link = linkMatch ? linkMatch[1].trim() : '';
    const snippet = descMatch
      ? (descMatch[1] ?? descMatch[2] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200)
      : undefined;

    if (title && !title.match(/^(BBC News|World|Business|Technology)$/i)) {
      items.push({ title, link, snippet });
    }
    if (items.length >= maxItems) break;
  }

  // Also try Atom <entry> format
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[1];
      const titleMatch = block.match(
        /<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i,
      );
      const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
      const title = titleMatch
        ? (titleMatch[1] ?? titleMatch[2] ?? '').trim()
        : '';
      const link = linkMatch ? linkMatch[1].trim() : '';
      if (title) {
        items.push({ title, link });
      }
      if (items.length >= maxItems) break;
    }
  }

  return items;
}

async function fetchRss(
  source: SourceDef,
  category: string,
  maxItems: number,
): Promise<IntelItem[]> {
  const res = await fetch(source.url!, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${source.url}`);
  const xml = await res.text();
  return extractRssItems(xml, maxItems).map((item) => ({
    title: item.title,
    url: item.link,
    source: source.name,
    category,
    snippet: item.snippet,
  }));
}

// ── Tavily Search ───────────────────────────────────────

async function fetchTavily(
  source: SourceDef,
  category: string,
  maxItems: number,
  apiKey: string,
): Promise<IntelItem[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: source.query,
      max_results: maxItems,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results: Array<{ title: string; url: string; content?: string }>;
  };
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    source: source.name,
    category,
    snippet: r.content?.slice(0, 200),
  }));
}

// ── GitHub Trending ─────────────────────────────────────

async function fetchGitHubTrending(
  source: SourceDef,
  category: string,
  maxItems: number,
): Promise<IntelItem[]> {
  const res = await fetch(source.url!, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const html = await res.text();

  const items: IntelItem[] = [];

  // Step 1: Extract repo hrefs from h2 > a links
  const hrefRegex = /href="(\/[^"]+)"\s+data-view-component="true"\s+class="Link"/g;
  const repoHrefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRegex.exec(html)) !== null) {
    const href = m[1].trim();
    if (href.split('/').filter(Boolean).length === 2) {
      repoHrefs.push(href);
    }
  }

  // Step 2: Extract descriptions
  const descRegex = /<p class="col-9[^"]*">\s*([\s\S]*?)\s*<\/p>/gi;
  const descriptions: string[] = [];
  while ((m = descRegex.exec(html)) !== null) {
    descriptions.push(m[1].replace(/<[^>]+>/g, '').trim().slice(0, 200));
  }

  // Step 3: Extract stars today
  const starsRegex = /([\d,]+)\s*stars today/gi;
  const starCounts: string[] = [];
  while ((m = starsRegex.exec(html)) !== null) {
    starCounts.push(m[1].replace(/,/g, ''));
  }

  for (let i = 0; i < repoHrefs.length && items.length < maxItems; i++) {
    const repoPath = repoHrefs[i];
    const repoName = repoPath.slice(1); // remove leading /
    const stars = starCounts[i] || '';
    const desc = descriptions[i] || undefined;
    const titleParts = [repoName];
    if (stars) titleParts.push(`+${stars}★ today`);

    items.push({
      title: titleParts.join(' '),
      url: `https://github.com${repoPath}`,
      source: source.name,
      category,
      snippet: desc,
    });
  }

  return items;
}

// ── Orchestrator ────────────────────────────────────────

export async function fetchAllSources(
  categories: Record<string, CategoryDef>,
  opts: { tavilyApiKey?: string; maxItemsPerSource?: number },
): Promise<Record<string, IntelItem[]>> {
  const maxItems = opts.maxItemsPerSource ?? 10;
  const results: Record<string, IntelItem[]> = {};

  const tasks: Array<{
    categoryKey: string;
    promise: Promise<IntelItem[]>;
  }> = [];

  for (const [catKey, catDef] of Object.entries(categories)) {
    for (const source of catDef.sources) {
      let promise: Promise<IntelItem[]>;

      switch (source.type) {
        case 'rss':
          promise = fetchRss(source, catKey, maxItems);
          break;
        case 'tavily':
          if (!opts.tavilyApiKey) {
            console.warn(
              `[intel] Skipping Tavily source "${source.name}" — no API key`,
            );
            continue;
          }
          promise = fetchTavily(source, catKey, maxItems, opts.tavilyApiKey);
          break;
        case 'github_trending':
          promise = fetchGitHubTrending(source, catKey, maxItems);
          break;
        default:
          console.warn(`[intel] Unknown source type: ${(source as any).type}`);
          continue;
      }

      tasks.push({
        categoryKey: catKey,
        promise: promise.catch((err) => {
          console.error(
            `[intel] Failed to fetch "${source.name}" (${catKey}):`,
            err instanceof Error ? err.message : err,
          );
          return [] as IntelItem[];
        }),
      });
    }
  }

  const settled = await Promise.all(tasks.map((t) => t.promise));

  for (let i = 0; i < tasks.length; i++) {
    const catKey = tasks[i].categoryKey;
    if (!results[catKey]) results[catKey] = [];
    results[catKey].push(...settled[i]);
  }

  return results;
}
