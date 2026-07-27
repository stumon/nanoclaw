/**
 * 海南航空机票价格监控 -- Playwright 截获移动端 API + 特价 API 双层数据源。
 *
 * 运行：npx tsx scripts/hnair-ticket-check.ts
 *
 * 数据源（按优先级）：
 *   1. m.hnair.com lowFareTicket API -- Playwright 加载移动端首页，截获内部签名 API，获取全日期最低价
 *   2. 特价 JSON API -- 海南航空官方特价列表（补充数据）
 *   3. Tavily Search -- 搜索引擎兜底（需 TAVILY_API_KEY）
 *
 * 配置文件 (groups/main/hnair-config.json)：
 *   { "enabled": true, "origin": "深圳", "destination": "乌鲁木齐", "priceMax": 300, "daysAhead": 180, "focusMonths": ["2026-05", "2026-06"] }
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

// Load .env so launchd-spawned processes can read API keys
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── 常量 ──────────────────────────────────────────────
const GNTJJP_API = 'https://www.hnair.com/xsy/tjjp/gntjjp/data/index.json';
const GJTJJP_API = 'https://www.hnair.com/xsy/tjjp/gjtjjp/data/index.json';
const TAVILY_API = 'https://api.tavily.com/search';

const NANOCLAW_DIR = process.env.HNAIR_NANOCLAW_DIR || process.cwd();
const CONFIG_PATH = path.join(NANOCLAW_DIR, 'groups', 'main', 'hnair-config.json');
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = process.env.HNAIR_IPC_CHAT_JID || '120363406615515477@g.us';
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const SEEN_STATE_PATH = path.join(NANOCLAW_DIR, 'data', 'hnair-seen-state.json');
const SEEN_TTL_MS = 24 * 3600 * 1000;
const LOCAL_SCHEDULE_PATH = path.join(NANOCLAW_DIR, 'config', 'hnair-schedule.json');

/** 按小时生成日志文件名：hnair-ticket-check-YYYY-MM-DD-HH.log */
function getLogPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return path.join(LOG_DIR, `hnair-ticket-check-${y}-${m}-${day}-${h}.log`);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';

// 城市名 → IATA 代码映射
const CITY_IATA: Record<string, string> = {
  '深圳': 'SZX', '乌鲁木齐': 'URC', '北京': 'PEK', '北京首都': 'PEK', '北京大兴': 'PKX',
  '上海': 'SHA', '上海浦东': 'PVG', '上海虹桥': 'SHA', '广州': 'CAN', '成都': 'CTU',
  '成都天府': 'TFU', '重庆': 'CKG', '杭州': 'HGH', '西安': 'XIY', '海口': 'HAK',
  '三亚': 'SYX', '长沙': 'CSX', '武汉': 'WUH', '南京': 'NKG', '昆明': 'KMG',
  '郑州': 'CGO', '厦门': 'XMN', '大连': 'DLC', '哈尔滨': 'HRB', '贵阳': 'KWE',
  '兰州': 'LHW', '呼和浩特': 'HET', '沈阳': 'SHE', '长春': 'CGQ', '济南': 'TNA',
  '福州': 'FOC', '太原': 'TYN', '南宁': 'NNG', '合肥': 'HFE', '南昌': 'KHN',
  '石家庄': 'SJW', '温州': 'WNZ', '珠海': 'ZUH', '桂林': 'KWL', '伊宁': 'YIN',
};

// ── 配置 ──────────────────────────────────────────────
interface RouteConfig {
  origin: string;
  destination: string;
  priceMax: number;
  focusMonths: string[];
  /** true 时，在时刻表未知（unknown）的情况下也按 all_666 推送；
   *  用于用户明确信任"这条路线都是 20:00-08:00 起飞的早晚班"的场景。
   *  注意：该标志不会覆盖已发现非 666 窗口航班的 mixed 结果（保守不推）。*/
  assumeAll666Window?: boolean;
}

interface HnairConfig {
  enabled: boolean;
  origin: string;
  destination: string;
  priceMax: number;
  daysAhead: number;
  focusMonths: string[];
  routes?: RouteConfig[];
}

const DEFAULTS: HnairConfig = {
  enabled: true,
  origin: '深圳',
  destination: '乌鲁木齐',
  priceMax: 300,
  daysAhead: 180,
  focusMonths: ['2026-05', '2026-06'],
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
        focusMonths: Array.isArray(raw.focusMonths) ? raw.focusMonths : DEFAULTS.focusMonths,
        routes: Array.isArray(raw.routes) ? raw.routes : undefined,
      };
    }
  } catch (e) {
    log(`读取配置失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    enabled: true,
    origin: DEFAULTS.origin,
    destination: DEFAULTS.destination,
    priceMax: process.env.HNAIR_PRICE_MAX ? Number(process.env.HNAIR_PRICE_MAX) : DEFAULTS.priceMax,
    daysAhead: process.env.HNAIR_DAYS_AHEAD ? Number(process.env.HNAIR_DAYS_AHEAD) : DEFAULTS.daysAhead,
    focusMonths: DEFAULTS.focusMonths,
  };
}

/** Build the list of effective routes from config. If routes[] is present, use it; otherwise fall back to the single-route fields. */
function getRoutes(cfg: HnairConfig): RouteConfig[] {
  if (cfg.routes && cfg.routes.length > 0) {
    return cfg.routes.map(r => ({
      origin: r.origin || cfg.origin,
      destination: r.destination || cfg.destination,
      priceMax: typeof r.priceMax === 'number' ? r.priceMax : cfg.priceMax,
      focusMonths: Array.isArray(r.focusMonths) ? r.focusMonths : cfg.focusMonths,
      assumeAll666Window: typeof r.assumeAll666Window === 'boolean' ? r.assumeAll666Window : undefined,
    }));
  }
  return [{
    origin: cfg.origin,
    destination: cfg.destination,
    priceMax: cfg.priceMax,
    focusMonths: cfg.focusMonths,
  }];
}

// ── 会员可用性判断 ──────────────────────────────────────
// 666 会员：20:00-次日08:00 出发，不可用于春运/五一/暑运/十一
// 2666 会员：19:00-次日09:00 出发，不可用于春运/暑运（五一、十一可用）

const PLUS666_BLACKOUT: Array<[string, string]> = [
  ['2026-01-10', '2026-02-18'], // 春运
  ['2026-04-30', '2026-05-05'], // 五一
  ['2026-07-01', '2026-08-31'], // 暑运
  ['2026-09-29', '2026-10-08'], // 十一
];

function isDateIn666Blackout(dateStr: string): boolean {
  for (const [start, end] of PLUS666_BLACKOUT) {
    if (dateStr >= start && dateStr <= end) return true;
  }
  return false;
}

/** 666 卡可订：20:00-次日08:00 起飞 */
function isTimeIn666Window(depTime: string): boolean {
  const h = parseInt(depTime.slice(0, 2), 10);
  return h >= 20 || h < 8;
}

// ── 工具 ──────────────────────────────────────────────
const AIRLINE_NAME = '海南航空';

interface Flight {
  date: string;
  price: number;
  discount?: number;
  cabin?: string;
  origin: string;
  destination: string;
  source: string;
  flightNo?: string;
  depTime?: string;
  arrTime?: string;
  actualListPrice?: number;
  /** true = PLUS 会员专享价 (cabin "B")，首页 API 直接返回，可信不需二次验证 */
  isMemberPrice?: boolean;
}

function log(msg: string): void {
  const logFile = getLogPath();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, line);
  // stdout 也带时间戳，方便 launchd 捕获的 hnair-hourly-stdout.log 可读
  console.log(line.trim());
}

function sendIpcAlert(text: string): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const file = path.join(IPC_DIR, `hnair-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', chatJid: CHAT_JID, text }, null, 0), 'utf-8');
  log(`IPC 已写入: ${file}`);
}

type SeenState = Record<string, number>;

function loadSeen(): SeenState {
  try {
    if (fs.existsSync(SEEN_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SEEN_STATE_PATH, 'utf-8')) as SeenState;
      const now = Date.now();
      const cleaned: SeenState = {};
      for (const [k, ts] of Object.entries(raw)) {
        if (now - ts < SEEN_TTL_MS) cleaned[k] = ts;
      }
      return cleaned;
    }
  } catch { /* ignore */ }
  return {};
}

function saveSeen(state: SeenState): void {
  fs.mkdirSync(path.dirname(SEEN_STATE_PATH), { recursive: true });
  fs.writeFileSync(SEEN_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function seenKey(origin: string, destination: string, date: string, price: number): string {
  return `${origin}|${destination}|${date}|${price}`;
}

function formatDate(dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

function formatBeijingDateTime(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatFocusMonths(months: string[]): string {
  return months
    .map((month) => {
      const m = month.match(/^(\d{4})-(\d{2})$/);
      return m ? `${m[1]}年${parseInt(m[2], 10)}月` : month;
    })
    .join('、');
}

function extractPrices(text: string): number[] {
  if (!text) return [];
  const matches = [
    ...text.matchAll(/(\d+)\s*元/g),
    ...text.matchAll(/[¥￥]\s*(\d+)/g),
  ];
  return matches.map((m) => Number(m[1])).filter((n) => n > 50 && n < 10000);
}

function cityToIata(name: string): string {
  return CITY_IATA[name] || name;
}

const SAMPLE_RELOADS = 8;

// ── 数据源 1：Playwright 多入口采样 lowFareTicket 会员价 API ──
// 首页 + 搜索页（带 focusMonths 日期）交替加载，累积不同日期的会员价数据。
// lowFareTicket API 每次只返回每个目的地的一个日期，且按出发城市缓存，
// 从搜索页入口有更高概率返回 focusMonths 范围内的日期。
async function fetchViaPlaywright(cfg: HnairConfig): Promise<Flight[]> {
  const orgCode = cityToIata(cfg.origin);
  const dstCode = cityToIata(cfg.destination);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });

    const dateMap = new Map<string, { price: number; discount?: number; cabin?: string }>();

    const collectLowFare = (page: import('playwright').Page) => {
      page.on('response', async (response) => {
        const url = response.url();
        if (!url.includes('lowFareTicket') || !(response.headers()['content-type'] || '').includes('json')) return;
        try {
          const body = await response.json() as {
            data?: { info?: Array<{ dstAndAirlinePriceInfo?: Array<{ dst: string; airlinePriceInfo: { date: string; lowestPrice: number; lowestDiscount: number; cabin: string } }> }> };
          };
          if (!body?.data?.info) return;
          for (const entry of body.data.info) {
            for (const dst of entry.dstAndAirlinePriceInfo || []) {
              if (dst.dst === dstCode) {
                const info = dst.airlinePriceInfo;
                const existing = dateMap.get(info.date);
                if (!existing || info.lowestPrice < existing.price) {
                  dateMap.set(info.date, { price: info.lowestPrice, discount: info.lowestDiscount, cabin: info.cabin });
                }
              }
            }
          }
        } catch { /* ignore */ }
      });
    };

    // 构建采样入口列表：首页 + focusMonths 中每个月的多个搜索页日期
    const entryUrls: string[] = ['https://m.hnair.com/'];
    for (const month of cfg.focusMonths || []) {
      const [y, m] = month.split('-').map(Number);
      if (!y || !m) continue;
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d += 7) {
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        entryUrls.push(`https://m.hnair.com/#/flightList?orgCity=${orgCode}&dstCity=${dstCode}&departDate=${dateStr}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`);
      }
    }

    log(`[Playwright] 开始采样 (${entryUrls.length} 个入口 × ${SAMPLE_RELOADS} 次刷新)...`);

    for (const entryUrl of entryUrls) {
      const page = await context.newPage();
      collectLowFare(page);
      try {
        await page.goto(entryUrl, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(800);
        for (let i = 0; i < SAMPLE_RELOADS; i++) {
          await page.reload({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch (e) {
        log(`[Playwright] 入口加载失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      await page.close().catch(() => {});
    }

    await browser.close();
    browser = undefined;

    log(`[Playwright] 采样完成: ${dateMap.size} 个日期`);
    for (const [d, v] of [...dateMap.entries()].sort((a, b) => a[1].price - b[1].price)) {
      log(`[Playwright]   ${d} → ¥${v.price}${v.discount ? ` (${(v.discount * 100).toFixed(0)}折)` : ''}`);
    }

    if (dateMap.size === 0) return [];

    return [...dateMap.entries()]
      .map(([date, v]) => ({
        date,
        price: v.price,
        discount: v.discount,
        cabin: v.cabin,
        origin: cfg.origin,
        destination: cfg.destination,
        source: 'playwright-member',
        isMemberPrice: v.cabin === 'B',
      }))
      .sort((a, b) => a.price - b.price);
  } catch (e) {
    log(`[Playwright] 失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── 数据源 1.5：目标月份扫描（逐日期访问搜索页获取实际价格）──
const SCAN_CONCURRENCY = 4;
const SCAN_PAGE_TIMEOUT = 15000;
const SCAN_WAIT_AFTER_LOAD = 3000;
const SCAN_SAMPLE_INTERVAL = 4;

function generateSampleDates(months: string[]): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates: string[] = [];

  for (const month of months) {
    const [year, mon] = month.split('-').map(Number);
    if (!year || !mon) continue;
    const daysInMonth = new Date(year, mon, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += SCAN_SAMPLE_INTERVAL) {
      const d = new Date(year, mon - 1, day);
      if (d <= today) continue;
      dates.push(`${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return dates;
}

async function scanFocusMonths(cfg: HnairConfig): Promise<Flight[]> {
  if (!cfg.focusMonths || cfg.focusMonths.length === 0) return [];

  const dates = generateSampleDates(cfg.focusMonths);
  if (dates.length === 0) {
    log(`[月份扫描] 目标月份 ${cfg.focusMonths.join(',')} 无未来日期可扫描`);
    return [];
  }

  log(`[月份扫描] 目标月份: ${cfg.focusMonths.join(', ')} | 采样日期 ${dates.length} 个 | 并行度 ${SCAN_CONCURRENCY}`);

  const orgCode = cityToIata(cfg.origin);
  const dstCode = cityToIata(cfg.destination);
  const results: Flight[] = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });

    for (let i = 0; i < dates.length; i += SCAN_CONCURRENCY) {
      const batch = dates.slice(i, i + SCAN_CONCURRENCY);
      const tasks = batch.map(async (date) => {
        let page;
        try {
          page = await context.newPage();
          let lowestPrice: number | null = null;

          page.on('response', async (response) => {
            const url = response.url();
            const isFlightSearch = url.includes('searchFlight') || url.includes('flightList') || url.includes('flight/list');
            if (!isFlightSearch || !(response.headers()['content-type'] || '').includes('json')) return;
            try {
              const body = await response.json() as Record<string, unknown>;
              const text = JSON.stringify(body);
              const priceMatches = text.matchAll(/"(?:price|lowestPrice|salePrice|totalPrice)":\s*(\d+)/g);
              for (const m of priceMatches) {
                const p = parseInt(m[1], 10);
                if (p > 50 && p < 50000 && (lowestPrice === null || p < lowestPrice)) {
                  lowestPrice = p;
                }
              }
            } catch { /* ignore */ }
          });

          const searchUrl = `https://m.hnair.com/#/flightList?orgCity=${orgCode}&dstCity=${dstCode}&departDate=${date}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`;
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: SCAN_PAGE_TIMEOUT }).catch(() => {});
          await page.waitForTimeout(SCAN_WAIT_AFTER_LOAD);

          if (lowestPrice !== null) {
            log(`[月份扫描] ${date} → ¥${lowestPrice}`);
            results.push({
              date,
              price: lowestPrice,
              origin: cfg.origin,
              destination: cfg.destination,
              source: 'month-scan',
            });
          }
        } catch (e) {
          log(`[月份扫描] ${date} 失败: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (page) await page.close().catch(() => {});
        }
      });

      await Promise.all(tasks);
    }
  } catch (e) {
    log(`[月份扫描] Playwright 启动失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  results.sort((a, b) => a.price - b.price);
  if (results.length > 0) {
    log(`[月份扫描] 扫描完成: ${results.length}/${dates.length} 个日期有价格，最低 ¥${results[0].price} (${results[0].date})`);
  } else {
    log(`[月份扫描] 扫描完成: 0/${dates.length} 个日期有价格`);
  }
  return results;
}

/** 单条航班用于日志展示 */
function formatFlightLogLine(f: Flight): string {
  const parts: string[] = [];
  parts.push(`${AIRLINE_NAME}`);
  parts.push(`${f.origin}-${f.destination}`);
  parts.push(`${formatDate(f.date)}`);
  parts.push(`¥${f.actualListPrice ?? f.price}`);
  if (f.discount != null) parts.push(`${(f.discount * 100).toFixed(0)}折`);
  if (f.flightNo) parts.push(`${f.flightNo}`);
  if (f.depTime || f.arrTime) parts.push(`${f.depTime ?? '-'}-${f.arrTime ?? '-'}`);
  return parts.join(' | ');
}

// ── 数据源 2：海南航空特价 JSON API（国内+国际）─────
async function fetchHnairApis(cfg: HnairConfig): Promise<Flight[]> {
  const apis = [
    { url: GNTJJP_API, label: '国内' },
    { url: GJTJJP_API, label: '国际' },
  ];
  const all: Flight[] = [];

  for (const { url, label } of apis) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) {
        log(`[API-${label}] 状态: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        flightResults?: Array<{ Date: string; Price: string; Origin: string; Destination: string }>;
      };
      const list = data.flightResults || [];
      const matched = list
        .filter((f) => f.Origin === cfg.origin && f.Destination === cfg.destination && Number.isFinite(Number(f.Price)))
        .map((f) => ({
          date: f.Date,
          price: Number(f.Price),
          origin: f.Origin,
          destination: f.Destination,
          source: `api-${label}`,
        }));
      if (matched.length > 0) {
        log(`[API-${label}] ${cfg.origin}-${cfg.destination} 共 ${matched.length} 条`);
      }
      all.push(...matched);
    } catch (e) {
      log(`[API-${label}] 请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return all.sort((a, b) => a.price - b.price);
}

// ── 数据源 3：Tavily 搜索 ────────────────────────────
async function searchByTavily(cfg: HnairConfig): Promise<Flight[]> {
  if (!TAVILY_KEY) {
    log('[Tavily] 未配置 TAVILY_API_KEY，跳过');
    return [];
  }
  try {
    const query = `海南航空 ${cfg.origin}到${cfg.destination} 机票价格 ${new Date().getFullYear()}`;
    const res = await fetch(TAVILY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      }),
    });
    if (!res.ok) {
      log(`[Tavily] 状态: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as {
      answer?: string;
      results?: Array<{ content: string; title: string; url: string }>;
    };

    const allText = [data.answer || '', ...(data.results || []).map((r) => `${r.title} ${r.content}`)].join('\n');
    const prices = extractPrices(allText);
    if (prices.length === 0) {
      log(`[Tavily] 未从搜索结果中提取到价格`);
      return [];
    }

    const today = new Date().toISOString().slice(0, 10);
    return [...new Set(prices)]
      .sort((a, b) => a - b)
      .slice(0, 10)
      .map((p) => ({ date: today, price: p, origin: cfg.origin, destination: cfg.destination, source: 'tavily' }));
  } catch (e) {
    log(`[Tavily] 搜索失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ── 主流程 ────────────────────────────────────────────

// ── 航班时刻表（本地配置优先，Tavily 降级）──────────
interface FlightSchedule {
  flightNo: string;
  depTime: string;
  arrTime: string;
  airline?: string;
}

const SCHEDULE_CACHE_PATH = path.join(NANOCLAW_DIR, 'data', 'hnair-schedule-cache.json');
const SCHEDULE_CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 天

function loadScheduleCache(): Record<string, { flights: FlightSchedule[]; ts: number }> {
  try {
    if (fs.existsSync(SCHEDULE_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_CACHE_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveScheduleCache(cache: Record<string, { flights: FlightSchedule[]; ts: number }>): void {
  fs.mkdirSync(path.dirname(SCHEDULE_CACHE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

/** 读取本地手工维护的时刻表（最权威） */
function loadLocalSchedule(): Record<string, FlightSchedule[]> {
  try {
    if (fs.existsSync(LOCAL_SCHEDULE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LOCAL_SCHEDULE_PATH, 'utf-8')) as Record<string, unknown>;
      const out: Record<string, FlightSchedule[]> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_') || !Array.isArray(v)) continue;
        out[k] = (v as FlightSchedule[]).filter(f => f.flightNo && f.depTime);
      }
      return out;
    }
  } catch (e) {
    log(`[时刻表] 读取本地配置失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {};
}

/**
 * 获取路线已知海航系航班时刻表。
 * 优先级：本地配置 config/hnair-schedule.json > 缓存 data/hnair-schedule-cache.json > Tavily 查询。
 */
async function getFlightSchedule(origin: string, destination: string): Promise<{ flights: FlightSchedule[]; source: 'local' | 'cache' | 'tavily' | 'none' }> {
  const cacheKey = `${origin}-${destination}`;

  const local = loadLocalSchedule();
  if (local[cacheKey] && local[cacheKey].length > 0) {
    log(`[时刻表] ${cacheKey} 使用本地配置 (${local[cacheKey].length} 个航班)`);
    return { flights: local[cacheKey], source: 'local' };
  }

  const cache = loadScheduleCache();
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < SCHEDULE_CACHE_TTL && cached.flights.length > 0) {
    log(`[时刻表] ${cacheKey} 使用缓存 (${cached.flights.length} 个航班)`);
    return { flights: cached.flights, source: 'cache' };
  }

  if (!TAVILY_KEY) {
    log(`[时刻表] ${cacheKey} 无本地配置/缓存，TAVILY_API_KEY 未配置，跳过`);
    return { flights: [], source: 'none' };
  }

  try {
    const query = `"${origin}到${destination}" 海南航空 直飞 航班时刻表 航班号 起飞时间 到达时间`;
    log(`[时刻表] ${cacheKey} Tavily 查询`);
    const res = await fetch(TAVILY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'advanced',
        include_answer: true,
        max_results: 5,
      }),
    });
    if (!res.ok) {
      log(`[时刻表] ${cacheKey} Tavily 状态: ${res.status}`);
      return { flights: cached?.flights || [], source: cached?.flights?.length ? 'cache' : 'none' };
    }
    const data = await res.json() as { answer?: string; results?: Array<{ content: string }> };
    const allText = [data.answer || '', ...(data.results || []).map(r => r.content)].join('\n');

    const flights: FlightSchedule[] = [];
    // 只抓海航系航司：HU 海南航空, CN 大新华, GS 天津航, JD 首都航, Y8 金鹏, UQ 乌鲁木齐航
    const re = /\b(HU|CN|GS|JD|Y8|UQ)(\d{3,5})\D{0,40}?(\d{2}:\d{2})\D{1,40}?(\d{2}:\d{2})/g;
    const seen = new Set<string>();
    for (const m of allText.matchAll(re)) {
      const flightNo = m[1] + m[2];
      if (seen.has(flightNo)) continue;
      seen.add(flightNo);
      flights.push({ flightNo, depTime: m[3], arrTime: m[4] });
    }

    if (flights.length > 0) {
      cache[cacheKey] = { flights: flights.slice(0, 8), ts: Date.now() };
      saveScheduleCache(cache);
      log(`[时刻表] ${cacheKey} 查到 ${flights.length} 个航班: ${flights.slice(0, 4).map(f => `${f.flightNo} ${f.depTime}`).join(', ')}`);
      return { flights: flights.slice(0, 8), source: 'tavily' };
    }
    log(`[时刻表] ${cacheKey} 未解析到航班时刻`);
    return { flights: [], source: 'none' };
  } catch (e) {
    log(`[时刻表] Tavily 失败: ${e instanceof Error ? e.message : String(e)}`);
    return { flights: cached?.flights || [], source: cached?.flights?.length ? 'cache' : 'none' };
  }
}

/**
 * 判断一条路线的已知航班是否"全部"在 666 窗口（20:00-次日08:00）内。
 * 只有全部在窗口内时，才能确信 lowFareTicket 返回的 B 舱会员价是 666 卡可购的。
 * （因为 B 舱作为 PLUS 会员专享舱只会挂在 666 或 2666 时段的航班上，
 *   若该路线所有航班都在 666 窗口 → B 舱必然挂在这些航班上 → 666 可买）
 */
function classifyRouteFor666(flights: FlightSchedule[]): {
  verdict: 'all_666' | 'mixed_or_2666_only' | 'unknown';
  in666: FlightSchedule[];
  outOf666: FlightSchedule[];
} {
  if (flights.length === 0) {
    return { verdict: 'unknown', in666: [], outOf666: [] };
  }
  const in666 = flights.filter(f => isTimeIn666Window(f.depTime));
  const outOf666 = flights.filter(f => !isTimeIn666Window(f.depTime));
  if (outOf666.length === 0 && in666.length > 0) {
    return { verdict: 'all_666', in666, outOf666 };
  }
  return { verdict: 'mixed_or_2666_only', in666, outOf666 };
}

/**
 * 处理单条航线：
 *   1. 从 lowFareTicket 拿到 B 舱会员价 + 日期 + 最低价
 *   2. 查本地时刻表（配置 > 缓存 > Tavily）判断该路线航班分布
 *   3. 只有当"所有已知海航系航班都在 20:00-08:00 窗口内"时才推送（666 可买）
 *      - 其他情况（混合 / 仅 2666 扩展时段 / 时刻表缺失）：静默，只写日志
 *   4. 24 小时内同一 路线|日期|价格 组合不重复推送
 */
async function processRoute(cfg: HnairConfig, route: RouteConfig): Promise<void> {
  const routeCfg: HnairConfig = { ...cfg, ...route };
  const routeLabel = `${route.origin}-${route.destination}`;
  log(`--- 航线: ${routeLabel} | 阈值: ${route.priceMax}元 | 重点月份: ${route.focusMonths.join(', ') || '无'} ---`);

  let allFlights: Flight[] = [];

  const pwFlights = await fetchViaPlaywright(routeCfg);
  if (pwFlights.length > 0) {
    log(`[Playwright] 共 ${pwFlights.length} 个日期，最低: ${formatFlightLogLine(pwFlights[0])}`);
    const memberCount = pwFlights.filter(f => f.isMemberPrice).length;
    if (memberCount > 0) log(`[Playwright] 其中 ${memberCount} 个为 PLUS 会员价 (B舱)`);
    allFlights.push(...pwFlights);
  } else {
    log(`[Playwright] ${routeLabel} 无数据`);
  }

  if (route.focusMonths && route.focusMonths.length > 0) {
    const before = allFlights.length;
    const dropped = allFlights.filter(f =>
      f.isMemberPrice && f.price <= route.priceMax &&
      !route.focusMonths.some(m => f.date.startsWith(m))
    );
    allFlights = allFlights.filter(f => route.focusMonths.some(m => f.date.startsWith(m)));
    if (dropped.length > 0) {
      log(`[过滤] focusMonths ${route.focusMonths.join(',')} 过滤掉 ${dropped.length} 个价格阈值内的会员价日期: ${dropped.map(f => `${f.date}¥${f.price}`).join(', ')}（若需监控请扩大 focusMonths）`);
    } else if (allFlights.length < before) {
      log(`[过滤] focusMonths ${route.focusMonths.join(',')} → ${before} → ${allFlights.length} 条`);
    }
  }

  allFlights.sort((a, b) => a.price - b.price);

  const memberFlights = allFlights.filter(f => f.isMemberPrice && f.price <= route.priceMax);
  const minFlight = allFlights.length > 0 ? allFlights[0] : null;
  let notified = false;
  let notifiedCount = 0;
  let skipReason = '';

  if (memberFlights.length > 0) {
    const candidate = memberFlights.filter(f => !isDateIn666Blackout(f.date));
    const blackoutCount = memberFlights.length - candidate.length;
    if (blackoutCount > 0) log(`[666过滤] 排除 ${blackoutCount} 个黑名单日期（春运/五一/暑运/十一）`);

    if (candidate.length === 0) {
      log(`[666过滤] ${routeLabel} 所有会员价日期均在 666 黑名单内，不通知`);
      skipReason = '全部在 666 黑名单';
    } else {
      const seen = loadSeen();
      const now = Date.now();
      const newOnes = candidate.filter(f => {
        const k = seenKey(route.origin, route.destination, f.date, f.price);
        return !seen[k] || (now - seen[k]) > SEEN_TTL_MS;
      });
      const dedupedCount = candidate.length - newOnes.length;
      if (dedupedCount > 0) log(`[去重] ${routeLabel} 跳过 ${dedupedCount} 个 24h 内已推送过的日期`);

      if (newOnes.length === 0) {
        log(`[去重] ${routeLabel} 无新增会员价日期，跳过通知`);
        skipReason = '24h 内已推送';
      } else {
        const { flights: schedule, source: scheduleSource } = await getFlightSchedule(route.origin, route.destination);
        const { verdict, in666, outOf666 } = classifyRouteFor666(schedule);

        log(`[666判定] ${routeLabel} (时刻表来源:${scheduleSource}) verdict=${verdict} | 666窗口内: ${in666.map(f => `${f.flightNo}@${f.depTime}`).join(',') || '无'} | 窗口外: ${outOf666.map(f => `${f.flightNo}@${f.depTime}`).join(',') || '无'}`);

        // 只有本地 config 的时刻表可作为推送依据（cache/tavily 数据有可能混入反向航班或其它错误）
        // Tavily 结果会进缓存供下一次的 local 配置参考，但不直接决定推送
        const trustworthy = scheduleSource === 'local';
        const effectiveVerdict: 'all_666' | 'mixed_or_2666_only' | 'unknown' = (() => {
          if (trustworthy && verdict === 'all_666') return 'all_666';
          if (trustworthy && verdict === 'mixed_or_2666_only') return 'mixed_or_2666_only';
          if (route.assumeAll666Window === true) return 'all_666';
          return 'unknown';
        })();
        if (effectiveVerdict === 'all_666' && !trustworthy) {
          log(`[666判定] ${routeLabel} 使用 route.assumeAll666Window=true 强制按 all_666 推送`);
        } else if (!trustworthy && verdict !== 'unknown') {
          log(`[666判定] ${routeLabel} 时刻表来源为 ${scheduleSource}，仅作参考提示（verdict=${verdict}），实际推送按 unknown 保守处理`);
        }

        if (effectiveVerdict !== 'all_666') {
          const candidateSummary = newOnes.map(f => `${f.date}¥${f.price}`).join(', ');
          if (effectiveVerdict === 'unknown') {
            log(`[666判定] ${routeLabel} 时刻表未知，保守不推送。待通知日期: ${candidateSummary}（补救: 在 config/hnair-schedule.json 添加时刻表，或在 hnair-config.json 的该路线加 "assumeAll666Window": true）`);
            skipReason = '时刻表未知';
          } else {
            log(`[666判定] ${routeLabel} 存在非 666 窗口航班 [${outOf666.map(f => `${f.flightNo} ${f.depTime}`).join(',')}]，B 舱 ¥${newOnes[0]?.price} 可能挂在 2666 航班上，保守不推送。待通知: ${candidateSummary}`);
            skipReason = '存在非 666 航班';
          }
        } else {
          const dateGroups = new Map<string, { price: number }>();
          for (const f of newOnes) {
            const g = dateGroups.get(f.date);
            if (!g) dateGroups.set(f.date, { price: f.price });
            else if (f.price < g.price) g.price = f.price;
          }

          const lines: string[] = [];
          const sortedDates = [...dateGroups.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(0, 10);
          const sampleFlight = in666[0];
          for (const [date, info] of sortedDates) {
            if (sampleFlight) {
              lines.push(`  ${formatDate(date)} ¥${info.price}  ${sampleFlight.flightNo} ${sampleFlight.depTime}-${sampleFlight.arrTime}`);
            } else {
              lines.push(`  ${formatDate(date)} ¥${info.price}`);
            }
          }

          const cheapestNew = [...newOnes].sort((a, b) => a.price - b.price)[0];
          const searchUrl = `https://m.hnair.com/#/flightList?orgCity=${cityToIata(route.origin)}&dstCity=${cityToIata(route.destination)}&departDate=${cheapestNew.date}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`;

          let msg = `✈️ 海航PLUS 666 可购\n推送时间：${formatBeijingDateTime()} 北京时间\n监控月份：${formatFocusMonths(route.focusMonths)}\n${routeLabel} 有 ${dateGroups.size} 个日期 ≤¥${route.priceMax}！\n`;
          if (in666.length > 0) {
            msg += `已知航班全部在 20:00-08:00 窗口（${in666.map(f => `${f.flightNo} ${f.depTime}`).join(' / ')}）\n\n`;
          } else {
            msg += `(基于路线配置信任该航线都是 20:00-08:00 早晚班，请 App 核实)\n\n`;
          }
          for (const line of lines) msg += `${line}\n`;
          msg += `\n最低 ¥${cheapestNew.price} ${formatDate(cheapestNew.date)}\n`;
          msg += `打开海航APP查看 → ${searchUrl}`;

          sendIpcAlert(msg);
          notified = true;
          notifiedCount = newOnes.length;

          for (const f of newOnes) {
            seen[seenKey(route.origin, route.destination, f.date, f.price)] = now;
          }
          saveSeen(seen);
        }
      }
    }
  }

  const sources = [...new Set(allFlights.map((f) => f.source))].join('+') || '无';
  const memberCount = memberFlights.length;
  const status = notified
    ? `已通知(${notifiedCount}个新增日期)`
    : (skipReason ? `跳过(${skipReason})` : (minFlight ? '无新会员低价' : '无数据'));
  if (minFlight) {
    log(`[摘要] ${AIRLINE_NAME} | ${routeLabel} | 最低¥${minFlight.price} (${formatDate(minFlight.date)}) | 会员价${memberCount}个≤¥${route.priceMax} | ${status} | ${sources}`);
  } else {
    log(`[摘要] ${AIRLINE_NAME} | ${routeLabel} | 无数据 | 阈值 ¥${route.priceMax} | ${status} | ${sources}`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.enabled) {
    log('机票查询已停止（enabled=false）');
    return;
  }

  const routes = getRoutes(cfg);
  log('=== 海南航空机票价格监控开始 ===');
  log(`共 ${routes.length} 条航线`);

  for (const route of routes) {
    await processRoute(cfg, route);
  }

  log('=== 扫描结束 ===');
}

main();
