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
 *   { "enabled": true, "origin": "深圳", "destination": "乌鲁木齐", "priceMax": 300, "daysAhead": 180 }
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
const CHAT_JID = process.env.HNAIR_IPC_CHAT_JID || '8619860743536@s.whatsapp.net';
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';

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
  '石家庄': 'SJW', '温州': 'WNZ', '珠海': 'ZUH', '桂林': 'KWL',
};

// ── 配置 ──────────────────────────────────────────────
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
    log(`读取配置失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    enabled: true,
    origin: DEFAULTS.origin,
    destination: DEFAULTS.destination,
    priceMax: process.env.HNAIR_PRICE_MAX ? Number(process.env.HNAIR_PRICE_MAX) : DEFAULTS.priceMax,
    daysAhead: process.env.HNAIR_DAYS_AHEAD ? Number(process.env.HNAIR_DAYS_AHEAD) : DEFAULTS.daysAhead,
  };
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
  /** 航班号，如 HU7341 */
  flightNo?: string;
  /** 起飞时间，如 08:00 */
  depTime?: string;
  /** 到达时间，如 14:30 */
  arrTime?: string;
  /** 该日期在航班列表 API 中的最低可预订价（与 App 内查询一致），无则为促销参考价 */
  actualListPrice?: number;
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

function formatDate(dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
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

const SAMPLE_RELOADS = 15;

// ── 数据源 1：Playwright 多次采样 m.hnair.com lowFareTicket 会员价 API ──
async function fetchViaPlaywright(cfg: HnairConfig): Promise<Flight[]> {
  const dstCode = cityToIata(cfg.destination);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    const page = await context.newPage();

    const dateMap = new Map<string, { price: number; discount?: number; cabin?: string }>();

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

    log(`[Playwright] 开始 ${SAMPLE_RELOADS + 1} 次采样...`);
    await page.goto('https://m.hnair.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    for (let i = 0; i < SAMPLE_RELOADS; i++) {
      await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
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
      }))
      .sort((a, b) => a.price - b.price);
  } catch (e) {
    log(`[Playwright] 失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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
async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.enabled) {
    log('机票查询已停止（enabled=false）');
    return;
  }

  const route = `${cfg.origin}-${cfg.destination}`;
  log('=== 海南航空机票价格监控开始 ===');
  log(`路线: ${route} | 阈值: ${cfg.priceMax}元`);

  let allFlights: Flight[] = [];

  // 数据源 1：Playwright 多次采样 lowFareTicket API
  const pwFlights = await fetchViaPlaywright(cfg);
  if (pwFlights.length > 0) {
    log(`[Playwright] 共 ${pwFlights.length} 个日期，最低: ${formatFlightLogLine(pwFlights[0])}`);
    allFlights.push(...pwFlights);
  } else {
    log(`[Playwright] ${route} 无数据`);
  }

  // 数据源 2：特价 API（补充数据）
  const apiFlights = await fetchHnairApis(cfg);
  if (apiFlights.length > 0) {
    log(`[API] ${route} 共 ${apiFlights.length} 条特价, 最低价 ¥${apiFlights[0].price}`);
    allFlights.push(...apiFlights);
  }

  // 数据源 3：Tavily 搜索（兜底）
  if (allFlights.length === 0) {
    const tavilyFlights = await searchByTavily(cfg);
    if (tavilyFlights.length > 0) {
      log(`[Tavily] 找到 ${tavilyFlights.length} 个价格, 最低 ¥${tavilyFlights[0].price}`);
      allFlights.push(...tavilyFlights);
    } else {
      log(`[Tavily] ${route} 无数据`);
    }
  }

  const effectivePrice = (f: Flight) => f.actualListPrice ?? f.price;
  allFlights.sort((a, b) => effectivePrice(a) - effectivePrice(b));

  const minFlight = allFlights.length > 0 ? allFlights[0] : null;
  const minEffective = minFlight ? effectivePrice(minFlight) : Infinity;
  let notified = false;

  if (minFlight && minEffective <= cfg.priceMax) {
    const cheap = allFlights.filter((f) => effectivePrice(f) <= cfg.priceMax).slice(0, 15);
    const seen = new Set<string>();
    const uniqueCheap = cheap.filter((f) => { if (seen.has(f.date)) return false; seen.add(f.date); return true; });
    const lines = uniqueCheap.map((f) => {
      const ep = effectivePrice(f);
      const discountTag = f.discount ? ` (${(f.discount * 100).toFixed(0)}折)` : '';
      return `  ${formatDate(f.date)} ¥${ep}${discountTag}`;
    });
    const searchUrl = `https://m.hnair.com/#/flightList?orgCity=${cityToIata(cfg.origin)}&dstCity=${cityToIata(cfg.destination)}&departDate=${minFlight.date}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`;
    sendIpcAlert(
      `✈️ 海南航空低价提醒\n` +
      `${route} 发现低于 ¥${cfg.priceMax} 的飞飞乐会员价！\n\n` +
      `低价日期（${uniqueCheap.length} 个）：\n${lines.join('\n')}\n\n` +
      `请在海航 App 中查看确认\n${searchUrl}`
    );
    notified = true;
  }

  const sources = [...new Set(allFlights.map((f) => f.source))].join('+') || '无';
  const status = notified ? '已通知' : (minFlight ? '未达阈值' : '无数据');
  if (minFlight) {
    log(`[摘要] ${AIRLINE_NAME} | ${route} | ¥${effectivePrice(minFlight)} (${formatDate(minFlight.date)}) | 阈值 ¥${cfg.priceMax} | ${status} | 数据源 ${sources}`);
  } else {
    log(`[摘要] ${AIRLINE_NAME} | ${route} | 无数据 | 阈值 ¥${cfg.priceMax} | ${status} | 数据源 ${sources}`);
  }
  log('=== 扫描结束 ===');
}

main();
