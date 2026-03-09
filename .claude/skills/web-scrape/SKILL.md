---
name: web-scrape
description: |
  Scrape any URL and return clean Markdown text. Auto-routes WeChat / JS-heavy pages to agent-browser, other pages to Scrapling (Python). Triggers: scrape url, crawl page, fetch article, read webpage, 抓取网页, 读取文章, 爬取.
---

# Web Scrape

Scrape any URL and get clean Markdown text. Auto-selects the best method based on the URL.

## Routing Rules

| URL Pattern | Method | Why |
|-------------|--------|-----|
| `mp.weixin.qq.com` | **agent-browser** | WeChat requires JS challenge; HTTP fetchers get "环境异常" |
| Cloudflare / Turnstile protected | **scrapling --stealthy** | StealthyFetcher bypasses JS challenges |
| All other URLs | **scrapling** (basic Fetcher) | Fastest, no browser overhead |

## Method 1: agent-browser (WeChat and JS-heavy pages)

Use for `mp.weixin.qq.com/*` and any site that returns empty / challenge pages with basic HTTP.

```bash
# Open the page in a real browser
agent-browser open "<url>"

# Wait for content to load, then get article text
agent-browser snapshot

# Extract the text you need from the snapshot output
# Close when done
agent-browser close
```

WeChat articles typically render the content in a `#js_content` div. After `agent-browser snapshot`, look for the article text in the output.

## Method 2: scrapling (most other pages)

Script path inside container: `/workspace/project/.claude/skills/web-scrape/scrapling_fetch.py`

Requires Python3 + scrapling (installed in container image).

```bash
# Basic scrape (30000 char limit)
python3 /workspace/project/.claude/skills/web-scrape/scrapling_fetch.py <url>

# Custom character limit
python3 /workspace/project/.claude/skills/web-scrape/scrapling_fetch.py <url> 50000

# Stealthy mode for Cloudflare / heavy anti-crawl
python3 /workspace/project/.claude/skills/web-scrape/scrapling_fetch.py <url> 30000 --stealthy
```

### Selector Priority

The script tries content selectors in order:

1. `article`
2. `main`
3. `.post-content`, `.article-content`, `.article-body`, `.entry-content`
4. `#content`
5. `[class*='body']`, `[class*='article']`, `[class*='content']`
6. Full `body` (fallback)

### Stealthy Mode

`--stealthy` uses `StealthyFetcher` (camoufox browser) which bypasses Cloudflare Turnstile, PerimeterX, and DataDome. Needs camoufox installed separately.

## Decision Flowchart

1. Is the URL `mp.weixin.qq.com`? -> Use **agent-browser**
2. Did basic scrapling return empty / challenge page? -> Retry with `--stealthy`
3. Did `--stealthy` also fail? -> Fall back to **agent-browser**

## Examples

```bash
# WeChat article -> agent-browser
agent-browser open "https://mp.weixin.qq.com/s/EwVItQH4JUsONqv_Fmi4wQ"
agent-browser snapshot
agent-browser close

# Regular blog -> scrapling
python3 /workspace/project/.claude/skills/web-scrape/scrapling_fetch.py \
  "https://example.com/article" 30000

# Cloudflare-protected -> scrapling stealthy
python3 /workspace/project/.claude/skills/web-scrape/scrapling_fetch.py \
  "https://protected-site.com/page" 30000 --stealthy
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| WeChat returns "环境异常" | Use agent-browser, not scrapling |
| `ModuleNotFoundError: scrapling` | Rebuild container image (`./container/build.sh`) |
| Empty output from scrapling | Try `--stealthy`, or fall back to agent-browser |
| `StealthyFetcher unavailable` | `pip3 install camoufox && python3 -m camoufox fetch` |
| Truncated content | Increase max_chars, e.g. `60000` |
