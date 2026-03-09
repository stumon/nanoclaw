#!/usr/bin/env node
/**
 * gen-news-image.js
 *
 * Render a news-brief markdown file into a newspaper-style PNG image
 * using Chromium headless screenshot.
 *
 * Usage:
 *   node gen-news-image.js <markdown-file> <output-png> [en|zh]
 *
 * Example:
 *   node gen-news-image.js /workspace/project/data/news-brief-2026-03-08.md \
 *        /workspace/group/infographic-en.png en
 *
 * Chromium is expected at /usr/bin/chromium (container) or auto-detected.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CHROMIUM_PATHS = [
  process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChromium() {
  for (const p of CHROMIUM_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Chromium not found. Set AGENT_BROWSER_EXECUTABLE_PATH.');
}

// --------------- Markdown Parsing ---------------

function parseSections(md) {
  const lines = md.split('\n');
  let title = '';
  const sections = [];
  let current = null;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const bullet = line.match(/^-\s+(.+)/);

    if (h1 && !title) {
      title = h1[1].trim();
    } else if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1].trim(), items: [] };
    } else if (bullet && current) {
      let text = bullet[1].trim();
      // Strip trailing URLs for cleaner display
      text = text.replace(/\s*https?:\/\/\S+$/g, '').trim();
      if (text) current.items.push(text);
    }
  }
  if (current) sections.push(current);
  return { title, sections };
}

// --------------- Section Labels ---------------

const SECTION_LABELS = {
  en: { '世界': 'WORLD', '商业': 'BUSINESS', '科技': 'TECHNOLOGY', '观点': 'OPINION' },
  zh: { '世界': '世界', '商业': '商业', '科技': '科技', '观点': '观点',
         'WORLD': '世界', 'BUSINESS': '商业', 'TECHNOLOGY': '科技', 'OPINION': '观点' },
};

const SECTION_ICONS = {
  '世界': '&#127758;', 'WORLD': '&#127758;',
  '商业': '&#128200;', 'BUSINESS': '&#128200;',
  '科技': '&#128187;', 'TECHNOLOGY': '&#128187;',
  '观点': '&#128172;', 'OPINION': '&#128172;',
};

function sectionLabel(heading, lang) {
  const map = SECTION_LABELS[lang] || SECTION_LABELS.en;
  return map[heading] || heading;
}

function sectionIcon(heading) {
  return SECTION_ICONS[heading] || SECTION_ICONS[sectionLabel(heading, 'en')] || '';
}

// --------------- HTML Generation ---------------

function generateHtml(parsed, lang) {
  const isZh = lang === 'zh';
  const dateStr = new Date().toLocaleDateString(isZh ? 'zh-CN' : 'en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const sectionsHtml = parsed.sections.map((sec) => {
    const label = sectionLabel(sec.heading, lang);
    const icon = sectionIcon(sec.heading);
    const itemsHtml = sec.items.map((item, i) => `
      <div class="item">
        <span class="bullet">${String(i + 1).padStart(2, '0')}</span>
        <span class="text">${escapeHtml(item)}</span>
      </div>`).join('');

    return `
      <div class="section">
        <div class="section-header">
          <span class="icon">${icon}</span>
          <span class="label">${escapeHtml(label)}</span>
        </div>
        <div class="items">${itemsHtml}</div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@400;500;600&family=Noto+Serif+SC:wght@600;700&family=Noto+Sans+SC:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 800px;
    background: #faf8f4;
    font-family: ${isZh
      ? "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"
      : "'Inter', 'Helvetica Neue', Arial, sans-serif"};
    color: #1a1a1a;
    padding: 0;
  }

  .container {
    padding: 48px 40px 40px;
  }

  /* ---------- Header ---------- */
  .masthead {
    text-align: center;
    border-bottom: 4px double #1a1a1a;
    padding-bottom: 20px;
    margin-bottom: 32px;
  }
  .masthead .overline {
    font-size: 11px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 8px;
  }
  .masthead h1 {
    font-family: ${isZh
      ? "'Noto Serif SC', serif"
      : "'Playfair Display', Georgia, serif"};
    font-weight: 900;
    font-size: ${isZh ? '36px' : '42px'};
    line-height: 1.15;
    letter-spacing: ${isZh ? '2px' : '-0.5px'};
    margin-bottom: 6px;
  }
  .masthead .date {
    font-size: 13px;
    color: #666;
    letter-spacing: 1px;
  }
  .masthead .rule {
    margin-top: 16px;
    border: none;
    border-top: 1px solid #ccc;
  }

  /* ---------- Sections ---------- */
  .section {
    margin-bottom: 28px;
    break-inside: avoid;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 2px solid #1a1a1a;
  }
  .section-header .icon {
    font-size: 20px;
  }
  .section-header .label {
    font-family: ${isZh
      ? "'Noto Serif SC', serif"
      : "'Playfair Display', Georgia, serif"};
    font-weight: 700;
    font-size: ${isZh ? '20px' : '22px'};
    letter-spacing: ${isZh ? '2px' : '1.5px'};
    text-transform: ${isZh ? 'none' : 'uppercase'};
  }

  /* ---------- Items ---------- */
  .items {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .item {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding: 10px 14px;
    background: #fff;
    border-radius: 6px;
    border-left: 3px solid #c9a96e;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .item .bullet {
    font-family: 'Inter', monospace;
    font-weight: 600;
    font-size: 13px;
    color: #c9a96e;
    flex-shrink: 0;
    min-width: 20px;
  }
  .item .text {
    font-size: ${isZh ? '15px' : '14.5px'};
    line-height: 1.6;
    color: #2a2a2a;
  }

  /* ---------- Footer ---------- */
  .footer {
    margin-top: 36px;
    padding-top: 16px;
    border-top: 4px double #1a1a1a;
    text-align: center;
    font-size: 11px;
    color: #999;
    letter-spacing: 2px;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="masthead">
      <div class="overline">${isZh ? '每日简报' : 'DAILY BRIEFING'}</div>
      <h1>${escapeHtml(parsed.title || (isZh ? '今日要闻' : 'Today\'s Headlines'))}</h1>
      <div class="date">${escapeHtml(dateStr)}</div>
      <hr class="rule">
    </div>
    ${sectionsHtml}
    <div class="footer">${isZh ? '由 Andy 自动生成' : 'Generated by Andy'}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --------------- Main ---------------

function main() {
  const [,, mdFile, outputPng, lang = 'en'] = process.argv;

  if (!mdFile || !outputPng) {
    console.error('Usage: node gen-news-image.js <markdown-file> <output-png> [en|zh]');
    process.exit(1);
  }

  if (!fs.existsSync(mdFile)) {
    console.error(`File not found: ${mdFile}`);
    process.exit(1);
  }

  const md = fs.readFileSync(mdFile, 'utf-8');
  const parsed = parseSections(md);

  if (parsed.sections.length === 0) {
    console.error('No sections found in markdown');
    process.exit(1);
  }

  const html = generateHtml(parsed, lang);

  // Write HTML to temp file
  const tmpHtml = path.join('/tmp', `news-${lang}-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html);

  const chromium = findChromium();
  const outDir = path.dirname(outputPng);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Estimate viewport height from content: header ~200px + per-section ~70px + per-item ~56px + footer ~100px
  const totalItems = parsed.sections.reduce((n, s) => n + s.items.length, 0);
  const estHeight = 200 + parsed.sections.length * 70 + totalItems * 56 + 100;
  const vpHeight = Math.max(600, Math.min(5000, estHeight));

  const cmd = [
    `"${chromium}"`,
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--font-render-hinting=none',
    `--screenshot="${outputPng}"`,
    `--window-size=800,${vpHeight}`,
    `"file://${tmpHtml}"`,
  ].join(' ');

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 30000 });
  } catch (err) {
    if (!fs.existsSync(outputPng)) {
      console.error('Chromium screenshot failed:', err.stderr?.toString() || err.message);
      process.exit(2);
    }
  }

  // Clean up
  try { fs.unlinkSync(tmpHtml); } catch {}

  if (fs.existsSync(outputPng)) {
    const size = fs.statSync(outputPng).size;
    console.log(`OK: ${outputPng} (${(size / 1024).toFixed(1)} KB)`);
  } else {
    console.error('Screenshot was not created');
    process.exit(2);
  }
}

main();
