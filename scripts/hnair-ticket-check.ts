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

/** 从航班列表 API 响应中解析第一班航班号、起飞/到达时间，以及整页最低可预订价 */
function parseSearchApiBody(body: unknown): {
  flightNo?: string;
  depTime?: string;
  arrTime?: string;
  /** 该日期实际可预订的最低价（与 App 列表一致） */
  minListPrice?: number;
} {
  const o = body as Record<string, unknown>;
  const data = o?.data as Record<string, unknown> | undefined;
  const list = (data?.flightList ?? data?.flights ?? data?.list ?? data?.flightInfoList) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list) || list.length === 0) return {};

  const first = list[0];
  const flightNo = (first.flightNo ?? first.flightNumber ?? first.flightNoDisplay) as string | undefined;
  const depTime = (first.depTime ?? first.departTime ?? first.departureTime) as string | undefined;
  const arrTime = (first.arrTime ?? first.arriveTime ?? first.arrivalTime) as string | undefined;

  let minListPrice: number | undefined;
  for (const item of list) {
    const p = item.price ?? item.lowestPrice ?? item.cashPrice ?? item.adultPrice ?? item.salePrice;
    const num = typeof p === 'number' ? p : typeof p === 'string' ? Number(p) : undefined;
    if (num != null && Number.isFinite(num) && num > 0 && num < 100000) {
      if (minListPrice == null || num < minListPrice) minListPrice = num;
    }
  }
  return { flightNo, depTime, arrTime, minListPrice };
}

// ── 数据源 1：Playwright 截获 m.hnair.com lowFareTicket API ──
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

    const flights: Flight[] = [];
    let gotData = false;

    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      try {
        if (url.includes('lowFareTicket')) {
          const body = await response.json() as {
            data?: {
              ok?: boolean;
              info?: Array<{
                dstAndAirlinePriceInfo?: Array<{
                  dst: string;
                  dstName: string;
                  airlinePriceInfo: {
                    date: string;
                    lowestPrice: number;
                    lowestDiscount: number;
                    cabin: string;
                    cabinClass: string;
                  };
                }>;
              }>;
            };
          };

          if (!body?.data?.info) return;
          for (const entry of body.data.info) {
            for (const dst of entry.dstAndAirlinePriceInfo || []) {
              if (dst.dst === dstCode) {
                const info = dst.airlinePriceInfo;
                flights.push({
                  date: info.date,
                  price: info.lowestPrice,
                  discount: info.lowestDiscount,
                  cabin: info.cabin,
                  origin: cfg.origin,
                  destination: cfg.destination,
                  source: 'playwright-lowFare',
                });
                gotData = true;
              }
            }
          }
        }
      } catch { /* ignore parse errors */ }
    });

    await page.goto('https://m.hnair.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (!gotData) {
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    if (flights.length > 0) {
      const cheapest = flights[0];
      const listUrl = `https://m.hnair.com/#/flightList?orgCity=${cityToIata(cfg.origin)}&dstCity=${dstCode}&departDate=${cheapest.date}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`;
      try {
        await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 30000 });
        const searchResp = await page.waitForResponse(
          (r) => r.url().includes('airLowFareSearch') && !r.url().includes('Lower'),
          { timeout: 10000 }
        );
        const searchApiBody = await searchResp.json();
        const parsed = parseSearchApiBody(searchApiBody);
        if (parsed.flightNo || parsed.depTime || parsed.arrTime) {
          flights[0].flightNo = parsed.flightNo;
          flights[0].depTime = parsed.depTime;
          flights[0].arrTime = parsed.arrTime;
        }
        if (parsed.minListPrice != null) {
          flights[0].actualListPrice = parsed.minListPrice;
        }
      } catch {
        // 列表页可能不触发 API 或超时，保留价格与日期即可
      }
    }

    await browser.close();
    browser = undefined;
    return flights.sort((a, b) => a.price - b.price);
  } catch (e) {
    log(`[Playwright] 失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** 单条航班用于日志展示（区分促销参考价与实际可预订价） */
function formatFlightLogLine(f: Flight): string {
  const parts: string[] = [];
  parts.push(`航空公司 ${AIRLINE_NAME}`);
  parts.push(`航线 ${f.origin}-${f.destination}`);
  parts.push(`日期 ${formatDate(f.date)}`);

  if (f.actualListPrice != null) {
    parts.push(`实际可订最低 ¥${f.actualListPrice}`);
    if (f.price < f.actualListPrice) {
      parts.push(`促销参考 ¥${f.price}（活动价，数量有限，以 App 内为准）`);
    }
  } else {
    parts.push(`促销参考价 ¥${f.price}（非列表价，以 App 内查询为准）`);
  }
  if (f.discount != null) parts.push(`经济舱 ${(f.discount * 100).toFixed(0)}折`);
  if (f.cabin) parts.push(`舱位 ${f.cabin}`);
  if (f.flightNo) parts.push(`航班 ${f.flightNo}`);
  if (f.depTime || f.arrTime) parts.push(`起飞 ${f.depTime ?? '-'} 到达 ${f.arrTime ?? '-'}`);
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

  // 数据源 1：Playwright 截获移动端 lowFareTicket API（全日期最低价）
  const pwFlights = await fetchViaPlaywright(cfg);
  if (pwFlights.length > 0) {
    log(`[航班信息] ${formatFlightLogLine(pwFlights[0])}`);
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

  // 排序：优先按实际可订价，无则按促销参考价
  const effectivePrice = (f: Flight) => f.actualListPrice ?? f.price;
  allFlights.sort((a, b) => effectivePrice(a) - effectivePrice(b));

  const minFlight = allFlights.length > 0 ? allFlights[0] : null;
  const minEffective = minFlight ? effectivePrice(minFlight) : Infinity;
  let notified = false;

  // 仅当拿到「实际可订价」且低于阈值时才通知。仅有促销参考价（如 199）时不通知，因与 App 内列表价可能不一致
  if (minFlight && minFlight.actualListPrice != null && minFlight.actualListPrice <= cfg.priceMax) {
    const cheap = allFlights.filter((f) => f.actualListPrice != null && f.actualListPrice <= cfg.priceMax).slice(0, 10);
    const lines = cheap.map((f) => `  ${formatDate(f.date)} ¥${f.actualListPrice}`);
    const searchUrl = `https://m.hnair.com/#/flightList?orgCity=${cityToIata(cfg.origin)}&dstCity=${cityToIata(cfg.destination)}&departDate=${minFlight.date}&adultNum=1&childNum=0&infantNum=0&cabinClass=Y`;
    sendIpcAlert(
      `✈️ 海南航空低价提醒\n` +
      `${route} 实际可订价低于 ¥${cfg.priceMax}！\n\n` +
      `最低价：\n${lines.join('\n')}\n\n` +
      `查看详情：${searchUrl}`
    );
    notified = true;
  }

  const sources = [...new Set(allFlights.map((f) => f.source))].join('+') || '无';
  const status = notified ? '已通知' : (minFlight ? '未达阈值' : '无数据');
  if (minFlight) {
    const priceDesc = minFlight.actualListPrice != null
      ? `实际可订 ¥${minFlight.actualListPrice} (${formatDate(minFlight.date)})`
      : `促销参考 ¥${minFlight.price} (${formatDate(minFlight.date)}，以 App 为准)`;
    log(`[摘要] ${AIRLINE_NAME} | ${route} | ${priceDesc} | 阈值 ¥${cfg.priceMax} | ${status} | 数据源 ${sources}`);
    if (minFlight.flightNo || minFlight.depTime || minFlight.arrTime) {
      log(`[摘要] 航班 ${minFlight.flightNo ?? '-'} 起飞 ${minFlight.depTime ?? '-'} 到达 ${minFlight.arrTime ?? '-'}`);
    }
  } else {
    log(`[摘要] ${AIRLINE_NAME} | ${route} | 无数据 | 阈值 ¥${cfg.priceMax} | ${status} | 数据源 ${sources}`);
  }
  log('=== 扫描结束 ===');
}

main();
