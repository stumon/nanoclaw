#!/usr/bin/env python3
"""
scrapling_fetch.py - Scrape any URL and return clean Markdown text.

Usage:
    python3 scrapling_fetch.py <url> [max_chars] [--stealthy]

    url        Target URL to scrape
    max_chars  Maximum output characters (default: 30000)
    --stealthy Use StealthyFetcher (bypasses Cloudflare/Turnstile, needs camoufox)

Exit codes:
    0  Success
    1  Usage error
    2  Fetch or parse error
"""

import sys
import html2text as _html2text

SELECTORS = [
    "article",
    "main",
    ".post-content",
    ".article-content",
    ".article-body",
    ".entry-content",
    "#content",
    "[class*='body']",
    "[class*='article']",
    "[class*='content']",
]


def to_markdown(html_str: str) -> str:
    h = _html2text.HTML2Text()
    h.ignore_links = False
    h.ignore_images = True
    h.ignore_tables = False
    h.body_width = 0
    return h.handle(html_str)


def extract_content(page) -> str:
    for sel in SELECTORS:
        try:
            elements = page.css(sel)
            if elements:
                return elements[0].html or ""
        except Exception:
            continue

    # Fall back to full body
    try:
        body = page.css("body")
        if body:
            return body[0].html or ""
    except Exception:
        pass

    return str(page.html or "")


def fetch_and_convert(url: str, max_chars: int, stealthy: bool) -> str:
    if stealthy:
        try:
            from scrapling.fetchers import StealthyFetcher
            page = StealthyFetcher().fetch(url)
        except ImportError:
            print(
                "[warn] StealthyFetcher unavailable, falling back to Fetcher",
                file=sys.stderr,
            )
            stealthy = False

    if not stealthy:
        from scrapling.fetchers import Fetcher
        page = Fetcher(auto_match=False).get(url, stealthy_headers=True)

    html_content = extract_content(page)
    md = to_markdown(html_content)

    # Collapse excessive blank lines
    import re
    md = re.sub(r"\n{3,}", "\n\n", md).strip()

    if len(md) > max_chars:
        md = md[:max_chars] + "\n\n[... content truncated ...]"

    return md


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(1)

    url = args[0]
    max_chars = 30000
    stealthy = "--stealthy" in args

    for a in args[1:]:
        if a.isdigit():
            max_chars = int(a)
        elif a.startswith("--") and not a == "--stealthy":
            print(f"Unknown flag: {a}", file=sys.stderr)
            sys.exit(1)

    try:
        result = fetch_and_convert(url, max_chars, stealthy)
        print(result)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
