/**
 * 海南航空特价机票扫描 -- 支持动态参数。
 *
 * 运行：npx tsx scripts/hnair-ticket-check.ts
 *
 * 参数来源（优先级从高到低）：
 *   1. groups/main/hnair-config.json（由 Andy 根据用户指令写入）
 *   2. 环境变量
 *   3. 内置默认值
 *
 * 默认值：深圳 -> 乌鲁木齐，最近半年，低于 300 元。
 *
 * 配置文件格式 (groups/main/hnair-config.json)：
 *   {
 *     "enabled": true,
 *     "origin": "深圳",
 *     "destination": "乌鲁木齐",
 *     "priceMax": 300,
 *     "daysAhead": 180
 *   }
 *
 * 环境变量（可覆盖配置文件中没有的字段）：
 *   HNAIR_USE_BROWSER    - 是否用无头浏览器，默认 true
 *   HNAIR_API_URL        - 机票查询接口 URL（兜底）
 *   HNAIR_IPC_CHAT_JID   - 接收提醒的 WhatsApp JID
 *   HNAIR_TARGET_PRICE   - 精确目标价，默认 199
 *   HNAIR_NANOCLAW_DIR   - NanoClaw 根目录
 */
import fs from 'fs';
import path from 'path';

// ── 常量 ──────────────────────────────────────────────
const GNTJJP_URL = 'https://www.hnair.com/xsy/tjjp/gntjjp/data/index.json';
const NANOCLAW_DIR = process.env.HNAIR_NANOCLAW_DIR || process.cwd();
const CONFIG_PATH = path.join(NANOCLAW_DIR, 'groups', 'main', 'hnair-config.json');
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = process.env.HNAIR_IPC_CHAT_JID || '8619860743536@s.whatsapp.net';
const TARGET_PRICE = process.env.HNAIR_TARGET_PRICE || '199';
const LOG_FILE = path.join(NANOCLAW_DIR, 'logs', 'hnair-ticket-check.log');
const API_URL = process.env.HNAIR_API_URL || '';
const USE_BROWSER = !(process.env.HNAIR_USE_BROWSER === 'false' || process.env.HNAIR_USE_BROWSER === '0');
const START_URL = process.env.HNAIR_START_URL || 'https://new.hnair.com/hainanair/ibe/common/flightSearch.do';
const DEBUG_ARTIFACTS = process.env.HNAIR_DEBUG_ARTIFACTS === 'true' || process.env.HNAIR_DEBUG_ARTIFACTS === '1';

// ── 城市 → 机场三字码映射 ────────────────────────────
const CITY_CODE_MAP: Record<string, string> = {
  深圳: 'SZX', 乌鲁木齐: 'URC', 北京: 'PEK', 上海: 'SHA',
  广州: 'CAN', 成都: 'CTU', 杭州: 'HGH', 武汉: 'WUH',
  长沙: 'CSX', 西安: 'XIY', 重庆: 'CKG', 南京: 'NKG',
  青岛: 'TAO', 厦门: 'XMN', 昆明: 'KMG', 大连: 'DLC',
  天津: 'TSN', 郑州: 'CGO', 三亚: 'SYX', 海口: 'HAK',
  哈尔滨: 'HRB', 沈阳: 'SHE', 贵阳: 'KWE', 福州: 'FOC',
  兰州: 'LHW', 南宁: 'NNG', 银川: 'INC', 呼和浩特: 'HET',
  拉萨: 'LXA', 石家庄: 'SJW', 太原: 'TYN', 合肥: 'HFE',
  南昌: 'KHN', 长春: 'CGQ', 珠海: 'ZUH', 温州: 'WNZ',
  宁波: 'NGB', 无锡: 'WUX', 烟台: 'YNT', 济南: 'TNA',
};

// ── 配置文件读取 ──────────────────────────────────────
interface HnairConfig {
  enabled: boolean;
  origin: string;
  destination: string;
  priceMax: number;
  daysAhead: number;
}

const DEFAULTS: HnairConfig = {
  enabled: true,
  origin: '深圳',
  destination: '乌鲁木齐',
  priceMax: 300,
  daysAhead: 180,
};

function loadConfig(): HnairConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return {
        enabled: raw.enabled !== false,
        origin: raw.origin || DEFAULTS.origin,
        destination: raw.destination || DEFAULTS.destination,
        priceMax: typeof raw.priceMax === 'number' ? raw.priceMax : DEFAULTS.priceMax,
        daysAhead: typeof raw.daysAhead === 'number' ? raw.daysAhead : DEFAULTS.daysAhead,
      };
    }
  } catch (e) {
    log(`读取配置文件失败，使用默认值: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 环境变量可覆盖默认值
  return {
    enabled: true,
    origin: DEFAULTS.origin,
    destination: DEFAULTS.destination,
    priceMax: process.env.HNAIR_PRICE_MAX ? Number(process.env.HNAIR_PRICE_MAX) : DEFAULTS.priceMax,
    daysAhead: process.env.HNAIR_DAYS_AHEAD ? Number(process.env.HNAIR_DAYS_AHEAD) : DEFAULTS.daysAhead,
  };
}

function cityToCode(city: string): string {
  return CITY_CODE_MAP[city] || '';
}

// ── 工具函数 ──────────────────────────────────────────
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

function sendIpcAlert(text: string): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const file = path.join(IPC_DIR, `hnair-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', chatJid: CHAT_JID, text }, null, 0), 'utf-8');
  log(`IPC 已写入: ${file}`);
}

function extractPricesFromText(text: string | null | undefined): number[] {
  if (!text) return [];
  const yuanMatches = [...text.matchAll(/(\d+)\s*元/g)];
  const rmbMatches = [...text.matchAll(/￥\s*(\d+)/g)];
  const nums = [...yuanMatches.map((m) => m[1]), ...rmbMatches.map((m) => m[1])].map((s) => Number(s));
  return nums.filter((n) => Number.isFinite(n) && n > 0);
}

function findTargetPriceInObject(obj: unknown, target: string): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'number') return String(obj) === target;
  if (typeof obj === 'string') {
    const m = obj.match(/(\d+)\s*元?/);
    return m ? m[1] === target : false;
  }
  if (Array.isArray(obj)) return obj.some((v) => findTargetPriceInObject(v, target));
  if (typeof obj === 'object') return Object.values(obj).some((v) => findTargetPriceInObject(v, target));
  return false;
}

interface GntjjpFlight {
  Date: string;
  Price: string;
  Origin: string;
  Destination: string;
  Link?: string;
}

function formatDateFull(dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

function formatDateShort(dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

// ── 数据源 ────────────────────────────────────────────

async function fetchGntjjpAndFilter(cfg: HnairConfig, maxItems: number = 10): Promise<GntjjpFlight[]> {
  try {
    const res = await fetch(GNTJJP_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      log(`gntjjp 接口状态: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { flightResults?: GntjjpFlight[] };
    const list = data.flightResults || [];
    const filtered = list.filter(
      (f) =>
        f.Origin === cfg.origin &&
        f.Destination === cfg.destination &&
        Number.isFinite(Number(f.Price)) &&
        Number(f.Price) < cfg.priceMax
    );
    const sorted = filtered.sort((a, b) => Number(a.Price) - Number(b.Price));
    return sorted.slice(0, maxItems);
  } catch (e) {
    log(`gntjjp 请求失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function checkByApi(): Promise<boolean> {
  if (!API_URL.trim()) return false;
  try {
    const method = (process.env.HNAIR_API_METHOD || 'GET').toUpperCase();
    const body = process.env.HNAIR_API_BODY;
    const res = await fetch(API_URL, {
      method,
      headers: { 'Content-Type': 'application/json', ...(process.env.HNAIR_API_HEADERS ? JSON.parse(process.env.HNAIR_API_HEADERS) : {}) },
      body: method !== 'GET' && body ? body : undefined,
    });
    const text = await res.text();
    let hasTarget = false;
    try {
      const data = JSON.parse(text);
      hasTarget = findTargetPriceInObject(data, TARGET_PRICE);
    } catch {
      hasTarget = new RegExp(`${TARGET_PRICE}\\s*元`).test(text);
    }
    return hasTarget;
  } catch (e) {
    log(`接口请求失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function checkByBrowser(cfg: HnairConfig): Promise<{ prices: number[]; hasExactTarget: boolean; departDate: string }> {
  const { chromium } = await import('playwright');
  const originCode = cityToCode(cfg.origin);
  const destCode = cityToCode(cfg.destination);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
    if (DEBUG_ARTIFACTS) {
      page.on('request', (req) => {
        if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') log(`XHR => ${req.method()} ${req.url()}`);
      });
      page.on('response', (res) => {
        const req = res.request();
        if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') log(`XHR <= ${res.status()} ${res.url()}`);
      });
      page.on('console', (m) => log(`console.${m.type()}: ${m.text()}`));
    }

    const candidateUrls = [START_URL, 'https://new.hnair.com/hainanair/ibe/common/flightSearch.do', 'https://www.hnair.com/'].filter(Boolean);

    let navigated = false;
    for (const u of candidateUrls) {
      try {
        await page.goto(u, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(1500);
        log(`当前页面: ${page.url()}`);
        navigated = true;
        break;
      } catch (e) {
        log(`打开页面失败(${u}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!navigated) return { prices: [], hasExactTarget: false, departDate: '' };

    if (DEBUG_ARTIFACTS) {
      const shot = path.join(NANOCLAW_DIR, 'logs', `hnair-debug-start-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log(`已保存截图: ${shot}`);
    }

    if (page.url().includes('flightDynamic')) {
      await page.getByRole('link', { name: /搜索机票/ }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      log(`切换后页面: ${page.url()}`);
    }

    // 出发城市
    const fromInput = page.locator('#Search-OriginDestinationInformation-Origin-location_input_location').first();
    await fromInput.click({ timeout: 8000 }).catch(() => {});
    await fromInput.fill(cfg.origin).catch(async () => {
      await page.getByPlaceholder(/出发城市|出发/).first().fill(cfg.origin).catch(async () => {
        await page.locator('input[placeholder*=出发], input[aria-label*=出发]').first().fill(cfg.origin).catch(() => {});
      });
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(400);
    if (originCode) {
      await page
        .locator('#Search-OriginDestinationInformation-Origin-location')
        .first()
        .evaluate((el, v) => { (el as HTMLInputElement).value = v as string; }, originCode)
        .catch(() => {});
    }

    // 到达城市
    const toInput = page.locator('#Search-OriginDestinationInformation-Destination-location_input_location').first();
    await toInput.click({ timeout: 8000 }).catch(() => {});
    await toInput.fill(cfg.destination).catch(async () => {
      await page.getByPlaceholder(/到达城市|到达|目的/).first().fill(cfg.destination).catch(async () => {
        await page.locator('input[placeholder*=到达], input[aria-label*=到达]').first().fill(cfg.destination).catch(() => {});
      });
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(400);
    if (destCode) {
      await page
        .locator('#Search-OriginDestinationInformation-Destination-location')
        .first()
        .evaluate((el, v) => { (el as HTMLInputElement).value = v as string; }, destCode)
        .catch(() => {});
    }

    // 出发日期
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    const departDate = `${y}-${m}-${d}`;
    log(`本次查询出发日期: ${departDate}`);
    await page.locator('input.depart-input').first().fill(departDate).catch(() => {});
    await page
      .locator('input[name="Search/DateInformation/departDate"]')
      .first()
      .evaluate((el, v) => {
        const input = el as HTMLInputElement;
        input.value = v as string;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, departDate)
      .catch(() => {});

    // 点击查询
    const clickSearch = async () => {
      await page
        .locator('a.search-btn, a.trip-search-btn, button.btn-search')
        .first()
        .click({ timeout: 8000 })
        .catch(async () => {
          await page.getByRole('button', { name: /搜索|查询|搜索航班/ }).first().click({ timeout: 8000 }).catch(() => {});
        });
    };
    await Promise.all([page.waitForNavigation({ waitUntil: 'commit', timeout: 60000 }).catch(() => {}), clickSearch()]);
    await page.waitForTimeout(5000);
    log(`点击搜索后页面: ${page.url()}`);
    if (page.url().includes('flightSearch.do')) {
      log('未跳转到结果页，尝试直接提交 searchForm');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'commit', timeout: 60000 }).catch(() => {}),
        page
          .evaluate(() => {
            const f = document.querySelector<HTMLFormElement>('form#searchForm');
            f?.submit();
          })
          .catch(() => {}),
      ]);
      await page.waitForTimeout(5000);
      log(`直接提交后页面: ${page.url()}`);
    }

    const body = await page.locator('body').textContent().catch(() => '');
    if (DEBUG_ARTIFACTS) {
      const html = await page.content().catch(() => '');
      const htmlPath = path.join(NANOCLAW_DIR, 'logs', `hnair-debug-page-${Date.now()}.html`);
      fs.writeFileSync(htmlPath, html, 'utf-8');
      log(`已保存 HTML: ${htmlPath}`);

      const shot = path.join(NANOCLAW_DIR, 'logs', `hnair-debug-after-search-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log(`已保存截图: ${shot}`);
    }
    if (process.env.HNAIR_DEBUG_DUMP === 'true') {
      log(`页面文本前 800 字: ${(body || '').slice(0, 800).replace(/\s+/g, ' ')}`);
    }
    const prices = extractPricesFromText(body);
    const hasExactTarget = prices.some((p) => String(p) === TARGET_PRICE);
    return { prices, hasExactTarget, departDate };
  } finally {
    if (browser) await browser.close();
  }
}

// ── 主流程 ────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.enabled) {
    log('机票查询已被用户停止（配置 enabled=false），跳过本次扫描');
    return;
  }

  const route = `${cfg.origin}-${cfg.destination}`;
  log('=== 海南航空特价扫描开始 ===');
  log(`路线: ${route} | 价格阈值: ${cfg.priceMax}元 | 扫描范围: ${cfg.daysAhead}天`);

  // 1. Playwright 无头浏览器
  let browserDepartDate = '';
  let prices: number[] = [];
  let hasExactTarget = false;

  if (USE_BROWSER) {
    log('使用无头浏览器查询（不会打开可见窗口）');
    try {
      const r = await checkByBrowser(cfg);
      prices = r.prices;
      hasExactTarget = r.hasExactTarget;
      browserDepartDate = r.departDate;
    } catch (e) {
      log(`浏览器查询失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. 国内特价接口（补充）
  const flights = await fetchGntjjpAndFilter(cfg, 10);

  // 3. 优先展示有结构化日期的接口数据
  if (flights.length > 0) {
    log(`接口筛选到 ${flights.length} 条 ${route} 低于${cfg.priceMax}元`);
    const lines = flights.map((f) => `${formatDateFull(f.Date)} ${Number(f.Price)}元`);
    const body = ['航班信息：', ...lines].join('\n');
    sendIpcAlert(`海南航空特价提醒：${route} 低于${cfg.priceMax}元\n\n${body}`);
    log('=== 扫描结束 ===');
    return;
  }

  // 4. 浏览器抓到的价格
  if (prices.length) {
    const sorted = [...prices].sort((a, b) => a - b);
    const min = sorted[0];
    log(`抓到价格数量: ${prices.length}; 最低价: ${min}元; 前几个: ${sorted.slice(0, 12).join('元, ')}元`);
    if (Number.isFinite(cfg.priceMax) && min <= cfg.priceMax) {
      log(`最低价 ${min} <= 阈值 ${cfg.priceMax}，发送提醒`);
      const dateDisplay = browserDepartDate ? formatDateFull(browserDepartDate) : '近期';
      const top5 = sorted.filter((p) => p <= cfg.priceMax).slice(0, 5);
      const priceList = top5.map((p) => `${dateDisplay} ${p}元`).join('\n');
      sendIpcAlert(`海南航空特价提醒：${route} 低于${cfg.priceMax}元\n\n航班信息：\n${priceList}`);
      log('=== 扫描结束 ===');
      return;
    }
    log(`最低价 ${min} > 阈值 ${cfg.priceMax}，不提醒`);
  } else if (!USE_BROWSER && API_URL.trim()) {
    log('浏览器模式已关闭，使用 HNAIR_API_URL 查询');
    hasExactTarget = await checkByApi();
  } else if (!USE_BROWSER) {
    log('浏览器模式已关闭且未配置 HNAIR_API_URL，跳过扫描。');
    log('=== 扫描结束 ===');
    return;
  } else {
    log('未能从页面解析到任何价格文本');
  }

  if (hasExactTarget) {
    log(`发现 ${TARGET_PRICE}元特价，发送提醒`);
    const dateDisplay = browserDepartDate ? formatDateFull(browserDepartDate) : '近期';
    sendIpcAlert(`海南航空特价提醒：${route}\n\n航班信息：\n${dateDisplay} ${TARGET_PRICE}元`);
  } else {
    log(`未发现精确目标价 ${TARGET_PRICE}元`);
  }
  log('=== 扫描结束 ===');
}

main();
