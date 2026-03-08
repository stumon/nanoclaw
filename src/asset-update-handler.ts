/**
 * Host-side asset update state machine.
 *
 * Bypasses the container agent entirely for the "更新资产" workflow.
 * Steps:
 *   1. Detect trigger → send acknowledgment
 *   2. Collect images (buffered on host)
 *   3. Detect "结束发送" → run pipeline:
 *      a. Vision model analyzes each image
 *      b. LLM extracts structured JSON from analyses
 *      c. node patch-assets.js --data JSON
 *      d. node update_all_assets.js
 *   4. Send result to user
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const TRIGGER_RE = /更新资产|更新持仓|更新飞书资产/;
const END_RE = /结束发送/;

const STOCK_LARK_DIR = path.resolve(
  process.env.HOME || '/Users/huanyu.guo',
  'self/stock/lark',
);

interface AssetSession {
  chatJid: string;
  imagePaths: string[];
  startedAt: number;
}

const sessions = new Map<string, AssetSession>();

export function isAssetTrigger(text: string): boolean {
  return TRIGGER_RE.test(text);
}

export function isEndTrigger(text: string): boolean {
  return END_RE.test(text);
}

export function hasActiveSession(chatJid: string): boolean {
  const s = sessions.get(chatJid);
  if (!s) return false;
  if (Date.now() - s.startedAt > 10 * 60 * 1000) {
    sessions.delete(chatJid);
    return false;
  }
  return true;
}

export function getSessionImageCount(chatJid: string): number {
  return sessions.get(chatJid)?.imagePaths.length ?? 0;
}

export function startSession(chatJid: string): void {
  sessions.set(chatJid, {
    chatJid,
    imagePaths: [],
    startedAt: Date.now(),
  });
  logger.info({ chatJid }, 'Asset update session started');
}

export function addImage(chatJid: string, absImagePath: string): void {
  const s = sessions.get(chatJid);
  if (s) {
    s.imagePaths.push(absImagePath);
    logger.info(
      { chatJid, image: absImagePath, total: s.imagePaths.length },
      'Image added to asset session',
    );
  }
}

// ── Vision analysis ────────────────────────────────────────────────

const VISION_PROMPT = `请逐行分析这张券商/基金APP截图中的每一条持仓记录，不要遗漏任何一行。

注意事项：
- 名称可能以数字开头（如 500ETF、300ETF、科创50等），这些也是有效持仓，必须列出
- 从上到下逐行读取，确认每一行都已记录
- 输出格式：平台名称、每只股票/基金的名称、持仓数量、市值
- **不要输出成本价/买入价**，只输出市值和持仓数量
- 最后统计总共识别了多少条持仓记录`;

async function callVision(
  env: Record<string, string>,
  base64: string,
  mime: string,
  prompt: string,
): Promise<string> {
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 3000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return `[Vision API error: HTTP ${res.status} ${text.slice(0, 200)}]`;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || '[Vision model returned empty]';
  } finally {
    clearTimeout(timeout);
  }
}

async function splitTallImage(imagePath: string): Promise<Buffer[]> {
  const sharp = (await import('sharp')).default;
  const metadata = await sharp(imagePath).metadata();
  const { width, height } = metadata;
  if (!width || !height) return [fs.readFileSync(imagePath)];

  const ratio = height / width;
  if (ratio <= 3) return [fs.readFileSync(imagePath)];

  const segCount = Math.ceil(ratio / 2.5);
  const segHeight = Math.ceil(height / segCount);
  const overlap = Math.round(segHeight * 0.1);

  logger.info(
    { width, height, ratio: ratio.toFixed(1), segments: segCount },
    'Splitting tall screenshot into segments',
  );

  const segments: Buffer[] = [];
  for (let i = 0; i < segCount; i++) {
    const top = Math.max(0, i * segHeight - (i > 0 ? overlap : 0));
    const bottom = Math.min(height, (i + 1) * segHeight + (i < segCount - 1 ? overlap : 0));
    const h = bottom - top;
    const buf = await sharp(imagePath)
      .extract({ left: 0, top, width, height: h })
      .jpeg({ quality: 90 })
      .toBuffer();
    segments.push(buf);
  }
  return segments;
}

async function callVisionMultiImage(
  env: Record<string, string>,
  imageBuffers: Buffer[],
  prompt: string,
): Promise<string> {
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  for (const buf of imageBuffers) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` },
    });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.VISION_MODEL,
        messages: [{ role: 'user', content }],
        max_tokens: 4000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return `[Vision API error: HTTP ${res.status} ${text.slice(0, 200)}]`;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || '[Vision model returned empty]';
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeImage(imagePath: string): Promise<string> {
  const env = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'VISION_MODEL',
  ]);
  if (!env.VISION_MODEL || !env.OPENAI_API_KEY || !env.OPENAI_BASE_URL) {
    return '[Vision model not configured]';
  }

  const segments = await splitTallImage(imagePath);

  if (segments.length === 1) {
    const base64 = segments[0].toString('base64');
    return callVision(env, base64, 'image/jpeg', VISION_PROMPT);
  }

  logger.info(
    { segments: segments.length },
    'Sending all segments in single multi-image vision call',
  );

  const multiPrompt = `以下 ${segments.length} 张图片是同一个券商APP持仓截图的不同部分（从上到下依次排列，有部分重叠）。
请综合所有图片，列出完整的持仓信息。

**重要规则：**
1. 同一只股票/基金只列一次（去重）
2. 名称可能以数字开头（如 500ETF、300ETF），这些也是有效持仓
3. 输出格式（每行一条，用逗号分隔）：
   名称, 持仓数量, 市值
4. **不要输出成本价/买入价，只输出市值**（市值是每行最大的那个金额数字）
5. 最后标注：平台名称、总资产、可用现金
6. 不要输出多余的解释文字`;

  return callVisionMultiImage(env, segments, multiPrompt);
}

// ── Structured data extraction via LLM ─────────────────────────────

const EXTRACTION_PROMPT = `你是一个金融数据提取器。你的任务是从多个券商/基金APP截图的分析文本中，提取**每一只**股票和基金的数据，不要遗漏任何一条持仓记录。

**极其重要：不要丢失任何数据！每一个截图分析文本中提到的每一只股票、ETF、基金都必须出现在输出中。**

平台标识符映射（根据截图分析文本中的平台名自动匹配）：
- 中国银河证券/银河证券 → "galaxy"
- 华泰证券 → "huatai"
- 川财证券 → "chuancai"
- 盈透证券/Interactive Brokers/IBKR → "ibkr"
- 支付宝 → "alipay"
- 云闪付 → "yunShanFu"
- 招商银行 → "zhaoShang"

输出 JSON 格式示例：
{
  "galaxy": {
    "holdings": [
      { "name": "中国平安", "code": "601318", "quantity": 1100, "marketValue": 71830, "assetType": "A股" },
      { "name": "中证500ETF", "code": "510500", "quantity": 5000, "marketValue": 54365, "assetType": "场内基金" }
    ],
    "cash": 49545.98
  },
  "huatai": {
    "holdings": [
      { "name": "恒生医药ETF", "code": "159892", "quantity": 11900, "marketValue": 9091.6, "assetType": "场内基金" }
    ]
  },
  "ibkr": {
    "holdings": [
      { "name": "META", "code": "META", "quantity": 2, "marketValueUSD": 1327.96, "assetType": "美股" }
    ],
    "cash": 1800.00
  },
  "alipay": { "cash": 2904.73, "fund": 48635.69 },
  "yunShanFu": 118385.10,
  "zhaoShang": 525050.9
}

必须遵循的规则：
1. 每个截图分析文本对应一个平台，不要漏掉任何平台
2. 每个平台的每一只股票/ETF/基金都必须列出，即使有几十条也要全部写出
3. code 字段：如果分析文本中有股票代码就填写，没有就写空字符串 ""
4. assetType 判断规则（非常重要）：
   - A股：个股（如中国平安、中国铝业、招商银行等）
   - 场内基金：所有在券商APP持仓列表中出现的ETF和基金，包括名称含"ETF"的（如黄金ETF、500ETF、医疗ETF、酒ETF），以及名称含"基金""龙头""互联""医疗""创业板""纳指""稀金属""光伏"等的场内交易品种
   - 美股：美股持仓（如META、AAPL等）
   - 基金：仅限支付宝等场外平台的基金
   - 货币基金：余额宝等货币型基金
   简单规则：**如果持仓出现在券商APP（银河、华泰、川财等）中且不是个股，就是"场内基金"**
5. ETF 的 assetType 是 "场内基金"
6. 使用 marketValue（市值），不要使用成本价/买入价
7. 美股持仓用 marketValueUSD（不是 marketValue）
8. 数量和市值必须是数字
9. 如果截图中有现金/可用余额，加 cash 字段
10. 只包含截图中出现的平台
11. 只输出 JSON，不要有任何其他文字或解释

以下是 {count} 个截图的分析文本，每个用 --- 分隔：
---
`;

function repairJson(str: string): Record<string, unknown> | null {
  let s = str.trim();
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Count unclosed brackets
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // Truncate last incomplete entry if inside an array
  if (brackets > 0 || braces > 1) {
    const lastComplete = Math.max(s.lastIndexOf('},'), s.lastIndexOf('}]'));
    if (lastComplete > 0) {
      s = s.slice(0, lastComplete + 1);
      // Recount
      braces = 0; brackets = 0; inString = false; escape = false;
      for (const ch of s) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
    }
  }
  // Close unclosed brackets/braces
  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0) { s += '}'; braces--; }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function extractStructuredData(
  analyses: string[],
): Promise<{ json: Record<string, unknown> | null; raw: string }> {
  const env = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'VISION_MODEL',
  ]);
  if (!env.OPENAI_API_KEY || !env.OPENAI_BASE_URL) {
    return { json: null, raw: 'LLM not configured' };
  }

  const prompt =
    EXTRACTION_PROMPT.replace('{count}', String(analyses.length)) +
    analyses.join('\n---\n') +
    '\n---\n\n请仔细检查每个截图分析中的每一条持仓记录都已包含在 JSON 中，然后输出 JSON：';

  const url = `${env.OPENAI_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.VISION_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { json: null, raw: `LLM API error: HTTP ${res.status} ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content || '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { json: null, raw: `LLM did not return JSON: ${raw.slice(0, 300)}` };
    }

    let jsonStr = jsonMatch[0];

    try {
      const parsed = JSON.parse(jsonStr);
      return { json: parsed, raw: jsonStr };
    } catch {
      logger.warn({ length: jsonStr.length }, 'JSON parse failed, attempting repair');
      const repaired = repairJson(jsonStr);
      if (repaired) {
        logger.info('JSON repaired successfully');
        return { json: repaired, raw: jsonStr };
      }
      return { json: null, raw: `JSON parse failed: ${jsonStr.slice(0, 500)}` };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── Script execution ───────────────────────────────────────────────

function runScript(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, timeout: timeoutMs });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on('data', (d) => stdout.push(d.toString()));
    proc.stderr.on('data', (d) => stderr.push(d.toString()));
    proc.on('close', (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      }),
    );
    proc.on('error', (err) =>
      resolve({ exitCode: 1, stdout: '', stderr: err.message }),
    );
  });
}

// ── Main pipeline ──────────────────────────────────────────────────

export async function processAssetUpdate(chatJid: string): Promise<string> {
  const session = sessions.get(chatJid);
  if (!session) return '没有进行中的资产更新会话。';

  const { imagePaths } = session;
  sessions.delete(chatJid);

  if (imagePaths.length === 0) {
    return '未收到截图，请重新发送「更新资产」并上传截图。';
  }

  logger.info(
    { chatJid, imageCount: imagePaths.length },
    'Asset update pipeline starting',
  );

  // Step 1: Vision analysis for each image
  const analyses: string[] = [];
  for (const img of imagePaths) {
    logger.info({ image: path.basename(img) }, 'Analyzing asset screenshot');
    const analysis = await analyzeImage(img);
    analyses.push(analysis);
    logger.info(
      { image: path.basename(img), length: analysis.length, preview: analysis.slice(0, 300) },
      'Asset screenshot analyzed',
    );
  }

  // Save full analyses to file for debugging
  try {
    const debugDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(debugDir, { recursive: true });
    const debugFile = path.join(debugDir, 'asset-update-debug.log');
    const debugContent = analyses
      .map((a, i) => `=== Screenshot ${i + 1} (${path.basename(imagePaths[i])}) ===\n${a}`)
      .join('\n\n');
    fs.writeFileSync(debugFile, `${new Date().toISOString()}\n\n${debugContent}\n`);
    logger.info({ debugFile }, 'Full vision analyses saved to file');
  } catch { /* ignore */ }

  // Step 2: Extract structured JSON
  logger.info(
    { analysisCount: analyses.length, totalChars: analyses.reduce((a, b) => a + b.length, 0) },
    'Extracting structured data from analyses',
  );
  const { json, raw } = await extractStructuredData(analyses);

  if (!json) {
    return `数据提取失败：${raw}\n\n视觉分析结果：\n${analyses.join('\n---\n')}`;
  }

  // Convert marketValue -> price (price = marketValue / quantity)
  for (const key of Object.keys(json)) {
    const platform = json[key] as Record<string, unknown>;
    const holdings = platform?.holdings as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(holdings)) continue;
    for (const h of holdings) {
      if (h.marketValue != null && h.quantity) {
        h.price = Math.round(((h.marketValue as number) / (h.quantity as number)) * 1000) / 1000;
        delete h.marketValue;
      }
      if (h.marketValueUSD != null && h.quantity) {
        h.priceUSD = Math.round(((h.marketValueUSD as number) / (h.quantity as number)) * 100) / 100;
        delete h.marketValueUSD;
      }
    }
  }

  const platforms = Object.keys(json);
  logger.info({ platforms, extractedJson: raw.slice(0, 500) }, 'Structured data extracted');

  // Save extracted JSON for debugging
  try {
    const debugFile = path.join(process.cwd(), 'logs', 'asset-update-debug.log');
    fs.appendFileSync(debugFile, `\n\n=== Extracted JSON ===\n${raw}\n`);
  } catch { /* ignore */ }

  // Step 3: Patch assets
  const jsonStr = JSON.stringify(json);
  logger.info({ dataLength: jsonStr.length }, 'Running patch-assets.js');

  const patchResult = await runScript(STOCK_LARK_DIR, 'node', [
    'patch-assets.js',
    '--data',
    jsonStr,
  ]);

  if (patchResult.exitCode !== 0) {
    logger.error(
      { exitCode: patchResult.exitCode, stderr: patchResult.stderr },
      'patch-assets.js failed',
    );
    return `资产数据写入失败：\n${patchResult.stderr || patchResult.stdout}`;
  }

  logger.info({ output: patchResult.stdout.trim() }, 'patch-assets.js done');

  // Step 4: Run update script
  logger.info('Running update_all_assets.js');
  const updateResult = await runScript(STOCK_LARK_DIR, 'node', [
    'update_all_assets.js',
  ]);

  if (updateResult.exitCode !== 0) {
    logger.error(
      { exitCode: updateResult.exitCode, stderr: updateResult.stderr },
      'update_all_assets.js failed',
    );
    return `飞书更新失败：\n${(updateResult.stderr || updateResult.stdout).slice(0, 500)}`;
  }

  logger.info('Asset update pipeline complete');

  // Format result
  const lines: string[] = ['资产更新完成！'];
  lines.push('');
  lines.push(`已更新平台：${platforms.join('、')}`);
  lines.push(patchResult.stdout.trim());

  const updateOutput = updateResult.stdout.trim();
  if (updateOutput) {
    const lastLines = updateOutput.split('\n').slice(-10).join('\n');
    lines.push('');
    lines.push(lastLines);
  }

  return lines.join('\n');
}
