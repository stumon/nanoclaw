/**
 * 值班日报自动生成脚本
 *
 * 运行：npx tsx scripts/on-duty-report.ts
 *
 * 流程：
 *   1. 运行 Go 编译的 grafana_report 二进制，捕获 stdout
 *   2. 调用 LLM API 分析值班数据，生成中文总结
 *   3. 通过 Gmail API 发送 HTML 邮件（原始数据 + LLM 总结）
 *   4. 通过 IPC 通知 WhatsApp 用户
 *
 * .env 配置：
 *   ON_DUTY_RECIPIENT=huanyu.guo@shopee.com  (逗号分隔多个收件人)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ── 加载 .env ──────────────────────────────────────────
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── 常量 ──────────────────────────────────────────────
const NANOCLAW_DIR = process.cwd();
const GO_BINARY = '/Users/huanyu.guo/uc/awesome-project-sp-sz/uc/on-duty/grafana_report';
const GO_CWD = '/Users/huanyu.guo/uc/awesome-project-sp-sz/uc/on-duty';
const RECIPIENT = process.env.ON_DUTY_RECIPIENT || 'huanyu.guo@shopee.com';
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = '8619860743536@s.whatsapp.net';
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const GMAIL_CRED_DIR = path.join(process.env.HOME || '/Users/huanyu.guo', '.gmail-mcp');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const MODEL_NAME = process.env.MODEL_NAME || 'QwQ-32B';
const DUTY_MODELS: string[] = process.env.DUTY_MODELS
  ? process.env.DUTY_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : [MODEL_NAME];

// ── 日志 ──────────────────────────────────────────────
function getLogPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `on-duty-${y}-${m}-${day}.log`);
}

function log(msg: string): void {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(getLogPath(), line + '\n');
  } catch { /* ignore */ }
}

// ── IPC ──────────────────────────────────────────────
function sendIpcAlert(text: string): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const file = path.join(IPC_DIR, `on-duty-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', chatJid: CHAT_JID, text }, null, 0), 'utf-8');
  log(`IPC 已写入: ${file}`);
}

// ── 1. 运行 Go 二进制 ──────────────────────────────────
function runGoBinary(): string {
  log('运行 grafana_report...');
  if (!fs.existsSync(GO_BINARY)) {
    throw new Error(`Go 二进制不存在: ${GO_BINARY}`);
  }
  try {
    const output = execSync(GO_BINARY, {
      cwd: GO_CWD,
      timeout: 120_000,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME || '/Users/huanyu.guo' },
    });
    log(`Go 脚本输出 ${output.length} 字节`);
    return output;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout, e.stderr].filter(Boolean).join('\n');
    if (combined.includes('报告预览:')) {
      log('Go 脚本虽然退出码非零但有报告输出，继续处理');
      return combined;
    }
    throw new Error(`Go 脚本执行失败: ${e.message}\n${combined}`);
  }
}

// ── 1b. 解析指标 + 历史基线 ───────────────────────────
import {
  storeMetrics, clearMetricsForDate, getBaselines, formatBaselinesForPrompt,
  storeAnomalies, getAnomalyTracking, formatAnomalyTrackingForPrompt,
  closeDb, type DutyMetric, type AnomalyRecord,
} from './lib/duty-metrics-db.js';

interface ParsedMetric {
  country: string;
  product: string;
  newUsers: number;
  passRate: number;
}

function parseReportMetrics(reportText: string): ParsedMetric[] {
  const metrics: ParsedMetric[] = [];
  const blocks = reportText.split(/\n(?=[A-Z]{2}\n)/);

  for (const block of blocks) {
    const lines = block.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) continue;
    const country = lines[0].trim();
    if (!/^[A-Z]{2}$/.test(country)) continue;

    const summaryLine = lines.find(l => /新增用户\d+/.test(l));
    if (!summaryLine) continue;

    const productPattern = /(\w+)新增用户(\d+)，通过率(\d+)%/g;
    let match;
    while ((match = productPattern.exec(summaryLine)) !== null) {
      metrics.push({
        country,
        product: match[1],
        newUsers: parseInt(match[2], 10),
        passRate: parseInt(match[3], 10),
      });
    }
  }
  return metrics;
}

function storeAndGetBaseline(reportText: string): { baselineText: string; trackingText: string } {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const parsed = parseReportMetrics(reportText);

  if (parsed.length > 0) {
    clearMetricsForDate(today, 'uc');
    const rows: DutyMetric[] = [];
    for (const m of parsed) {
      rows.push({
        date: today,
        reportType: 'uc',
        groupName: m.country,
        metricName: `${m.product}_new_users`,
        metricValue: m.newUsers,
      });
      rows.push({
        date: today,
        reportType: 'uc',
        groupName: m.country,
        metricName: `${m.product}_pass_rate`,
        metricValue: m.passRate,
      });
    }
    storeMetrics(rows);
    log(`已存储 ${rows.length} 条 UC 指标到历史数据库`);
  }

  const baselines = getBaselines('uc', 30);
  const baselineText = formatBaselinesForPrompt(baselines);

  const baselineMap = new Map<string, { mean: number; stddev: number }>();
  for (const b of baselines) {
    baselineMap.set(`${b.groupName}::${b.metricName}`, { mean: b.mean, stddev: b.stddev });
  }

  const currentAnomalies: AnomalyRecord[] = [];
  for (const m of parsed) {
    if (m.newUsers >= 100) {
      const usersKey = `${m.country}::${m.product}_new_users`;
      const usersBaseline = baselineMap.get(usersKey);
      if (usersBaseline && usersBaseline.stddev > 0) {
        const z = Math.abs(m.newUsers - usersBaseline.mean) / usersBaseline.stddev;
        if (z > 2) {
          currentAnomalies.push({
            key: `${m.country}/${m.product}_new_users`,
            severity: z > 3 ? 'critical' : 'warning',
            reason: `Z-score=${z.toFixed(1)}, 当前=${m.newUsers}, 基线均值=${usersBaseline.mean.toFixed(0)}`,
          });
        }
      }
    }

    const rateKey = `${m.country}::${m.product}_pass_rate`;
    const rateBaseline = baselineMap.get(rateKey);
    if (rateBaseline && rateBaseline.stddev > 0) {
      const z = Math.abs(m.passRate - rateBaseline.mean) / rateBaseline.stddev;
      if (z > 2) {
        currentAnomalies.push({
          key: `${m.country}/${m.product}_pass_rate`,
          severity: z > 3 ? 'critical' : 'warning',
          reason: `Z-score=${z.toFixed(1)}, 当前=${m.passRate}%, 基线均值=${rateBaseline.mean.toFixed(1)}%`,
        });
      }
    }
  }

  const tracking = getAnomalyTracking(today, 'uc', currentAnomalies);
  storeAnomalies(today, 'uc', currentAnomalies);
  const trackingText = formatAnomalyTrackingForPrompt(tracking);
  if (trackingText) {
    log(`异常追踪: ${tracking.continuing.length} 持续, ${tracking.newAnomalies.length} 新增, ${tracking.recovered.length} 已恢复`);
  }

  return { baselineText, trackingText };
}

// ── 2. LLM 分析 ──────────────────────────────────────
const LLM_URL = OPENAI_BASE_URL
  ? `${OPENAI_BASE_URL}/chat/completions`
  : 'https://api.openai.com/v1/chat/completions';

async function callLLM(systemPrompt: string, userContent: string, maxTokens = 2048, modelName = MODEL_NAME): Promise<string> {
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('LLM 返回空内容');
  return content;
}

async function stage1AnomalyConfirm(reportText: string, baselineText: string, modelName: string): Promise<string> {
  log('Stage 1: UC 异常确认...');
  const baselineBlock = baselineText
    ? `\n历史上下文（基线 + 异常追踪）：\n${baselineText}\n`
    : '';
  const prompt = `你是一名金融科技 UC 值班分析师。以下是各国激活监控数据。
${baselineBlock}
你的任务是找出真正偏离基线2个标准差以上的异常。注意以下规则：
1. 小国家（MX/TW/SG）天然波动大，除非偏离极端否则不标记
2. 新增用户少于100的产品属于小样本，波动大是正常现象，不要标记为异常

请严格按以下格式输出，一行一个，不要额外文字，不要 Markdown：
{国家}-{产品} | {严重程度:严重/告警} | {当前值} | {一句话原因}

如果没有真正的异常，只输出一行：无异常

示例：
PH-CicilanHP | 告警 | 新增1437(-49%) | 可能是渠道投放缩减
ID-SPL | 严重 | 新增203(-80%) | 全渠道激活骤降`;

  const result = await callLLM(prompt, reportText, 1024, modelName);
  log(`Stage 1 完成 [${modelName}]: ${result.split('\n').filter(l => l.trim()).length} 行`);
  return result;
}

async function stage2CorrelationAndAction(confirmedAnomalies: string, modelName: string): Promise<string> {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  log('Stage 2: UC 关联分析 + 行动建议...');

  const prompt = `你是一名金融科技 UC 值班分析师。以下是已确认的异常列表。

请严格按照以下格式输出，不要使用 Markdown 标记（不要用 # * \` 等符号）：

[总体风险] 低/中/高
[一句话总结] （不超过30字描述整体状况）

[异常分析]
异常1: {国家}-{产品} | 数据: {当前值} | 原因: {一句话} | 建议: {一句话} | 紧急度: 立即处理/持续观察
异常2: ...
（没有异常则写"无"）

[关联发现]
（多国同产品同方向变化可能指向全局原因。没有则写"无"）

[值班行动]
1. {最重要的事}
2. {次重要的事}
（按优先级排序，最多3条）

示例：
---
[总体风险] 低
[一句话总结] 各国激活数据整体稳定，ID-SPL小幅下降在基线范围内

[异常分析]
异常1: PH-CicilanHP | 数据: 新增1437(-49%同比) | 原因: 渠道投放缩减 | 建议: 确认PH市场团队是否调整投放 | 紧急度: 持续观察

[关联发现]
无

[值班行动]
1. 关注PH-CicilanHP同比下降趋势，如持续3天则升级
---

开头写"以下是 ${today} 的值班数据分析总结："`;

  const result = await callLLM(prompt, confirmedAnomalies, 2048, modelName);
  log(`Stage 2 完成 [${modelName}]: ${result.length} 字`);
  return result;
}

async function analyzeWithLLM(reportText: string, baselineText: string, modelName: string): Promise<string> {
  log(`开始双阶段 LLM 分析 [${modelName}]...`);
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const stage1Result = await stage1AnomalyConfirm(reportText, baselineText, modelName);

  if (stage1Result.trim() === '无异常' || stage1Result.trim().length < 5) {
    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return [
      `以下是 ${today} 的值班数据分析总结：`,
      '',
      '[总体风险] 低',
      '[一句话总结] 各国激活数据正常，无真实异常',
      '',
      '[异常分析]',
      '无',
      '',
      '[关联发现]',
      '无',
      '',
      '[值班行动]',
      '1. 各国指标正常，无需特别操作',
    ].join('\n');
  }

  return stage2CorrelationAndAction(stage1Result, modelName);
}

function validateLLMOutput(output: string): { valid: boolean; reason: string } {
  if (!output || output.length < 50) {
    return { valid: false, reason: '输出过短' };
  }
  const hasRiskLevel = /\[总体风险\]\s*(低|中|高)/.test(output);
  if (!hasRiskLevel) return { valid: false, reason: '缺少 [总体风险]' };
  const hasSummary = /\[一句话总结\]/.test(output);
  if (!hasSummary) return { valid: false, reason: '缺少 [一句话总结]' };
  const hasAnalysis = /\[异常分析\]/.test(output);
  if (!hasAnalysis) return { valid: false, reason: '缺少 [异常分析]' };
  const hasAction = /\[值班行动\]/.test(output);
  if (!hasAction) return { valid: false, reason: '缺少 [值班行动]' };
  if (/#{2,}|^\*\*|```/m.test(output)) return { valid: false, reason: '包含 Markdown 格式' };
  return { valid: true, reason: '' };
}

function buildUcFallback(reportText: string): string {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return [
    `以下是 ${today} 的值班数据分析总结：`,
    '（注：LLM 分析不可用，以下为原始数据摘要）',
    '',
    '[总体风险] 中',
    '[一句话总结] LLM 分析异常，请查看原始数据',
    '',
    '[异常分析]',
    '无（LLM 降级，未能自动分析异常）',
    '',
    '[关联发现]',
    '无',
    '',
    '[值班行动]',
    '1. 请人工查看以下原始数据判断是否有异常',
    '',
    '--- 原始数据摘要 ---',
    reportText.slice(0, 2000),
  ].join('\n');
}

interface ModelAnalysis {
  modelName: string;
  analysis: string;
}

async function analyzeWithSingleModel(reportText: string, baselineText: string, modelName: string): Promise<string> {
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const output = await analyzeWithLLM(reportText, baselineText, modelName);
      const { valid, reason } = validateLLMOutput(output);
      if (valid) {
        log(`LLM 输出校验通过 [${modelName}] (尝试 ${attempt})`);
        return output;
      }
      log(`LLM 输出校验失败 [${modelName}] (尝试 ${attempt}/${MAX_RETRIES}): ${reason}`);
    } catch (err) {
      log(`LLM 调用失败 [${modelName}] (尝试 ${attempt}/${MAX_RETRIES}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[${modelName}] 重试耗尽，降级为规则引擎输出`);
  return buildUcFallback(reportText);
}

async function analyzeWithAllModels(reportText: string, baselineText: string): Promise<ModelAnalysis[]> {
  const results: ModelAnalysis[] = [];
  for (const modelName of DUTY_MODELS) {
    const analysis = await analyzeWithSingleModel(reportText, baselineText, modelName);
    results.push({ modelName, analysis });
  }
  return results;
}

// ── 3. 构建 HTML 邮件 ──────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 将 Go 脚本的原始报告文本转为结构化 HTML 表格 */
function rawReportToHtml(reportText: string): string {
  const sections: string[] = [];
  const countryBlocks = reportText.split(/\n(?=[A-Z]{2}\n)/);

  for (const block of countryBlocks) {
    const lines = block.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) continue;

    const countryCode = lines[0].trim();
    if (!/^[A-Z]{2}$/.test(countryCode)) continue;

    const countryNames: Record<string, string> = {
      ID: '印度尼西亚', TH: '泰国', PH: '菲律宾', MY: '马来西亚',
      SG: '新加坡', VN: '越南', BR: '巴西', TW: '台湾', MX: '墨西哥',
    };
    const countryLabel = countryNames[countryCode]
      ? `${countryCode} - ${countryNames[countryCode]}`
      : countryCode;

    // Parse product lines
    const productLine = lines.find(l => /新增用户\d+/.test(l));
    const dodSection = lines.slice(
      lines.findIndex(l => l.includes('环比数据')),
      lines.findIndex(l => l.includes('同比数据')),
    );
    const wowSection = lines.slice(
      lines.findIndex(l => l.includes('同比数据')),
    );

    const rows: string[] = [];
    for (const line of dodSection) {
      const m = line.match(/^\s+(\S+):\s+新增用户\s+(\d+)->(\d+)\s+\(([^)]+)\),\s+通过率\s+(\d+)%->(\d+)%\s+\(([^)]+)\)/);
      if (!m) continue;
      const [, name, prevUsers, curUsers, userChange, prevRate, curRate, rateChange] = m;

      // Find matching wow line
      const wowLine = wowSection.find(l => l.trim().startsWith(name + ':'));
      let wowUserChange = '-', wowRateChange = '-';
      const wm = wowLine?.match(/\(([^)]+)\),\s+通过率.*\(([^)]+)\)/);
      if (wm) { wowUserChange = wm[1]; wowRateChange = wm[2]; }

      const isSmallSample = parseInt(curUsers, 10) < 100;
      const highlightUser = !isSmallSample && Math.abs(parseFloat(userChange)) >= 20;
      const highlightRate = !isSmallSample && Math.abs(parseFloat(rateChange)) >= 20;
      const highlightWowUser = !isSmallSample && Math.abs(parseFloat(wowUserChange)) >= 20;
      const highlightWowRate = !isSmallSample && Math.abs(parseFloat(wowRateChange)) >= 20;

      const warn = (val: string, active: boolean) =>
        active ? `<span style="color:#e74c3c;font-weight:bold">${escapeHtml(val)}</span>` : escapeHtml(val);
      const smallTag = isSmallSample
        ? ' <span style="color:#999;font-size:11px">(小样本)</span>'
        : '';

      rows.push(`<tr${isSmallSample ? ' style="opacity:0.7"' : ''}>
        <td style="padding:6px 10px;border:1px solid #e0e0e0">${escapeHtml(name)}${smallTag}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${escapeHtml(curUsers)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${escapeHtml(curRate)}%</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${warn(userChange, highlightUser)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${warn(rateChange, highlightRate)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${warn(wowUserChange, highlightWowUser)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${warn(wowRateChange, highlightWowRate)}</td>
      </tr>`);
    }

    if (rows.length === 0) continue;

    sections.push(`
      <h3 style="color:#2c3e50;margin:20px 0 8px;font-size:15px;border-left:4px solid #3498db;padding-left:10px">${escapeHtml(countryLabel)}</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:12px">
        <thead>
          <tr style="background:#f8f9fa">
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:left">产品</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">新增用户</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">通过率</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">环比(用户)</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">环比(通过率)</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">同比(用户)</th>
            <th style="padding:8px 10px;border:1px solid #e0e0e0;text-align:right">同比(通过率)</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>`);
  }

  return sections.join('');
}

function analysisToHtml(text: string): string {
  return escapeHtml(text)
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      let html = line;
      html = html.replace(/【异常】/g, '<span style="color:#e74c3c;font-weight:bold">【异常】</span>');
      return `<p style="margin:4px 0;line-height:1.6">${html}</p>`;
    })
    .join('');
}

function buildHtmlEmail(reportText: string, modelResults: ModelAnalysis[], today: string): string {
  const dataHtml = rawReportToHtml(reportText);
  const hasTableData = dataHtml.length > 0;

  const modelSections = modelResults.map((mr, idx) => {
    const borderColor = idx === 0 ? '#b8d4f0' : '#d4c8f0';
    const bgColor = idx === 0 ? '#f0f7ff' : '#f7f0ff';
    const titleColor = idx === 0 ? '#2980b9' : '#8e44ad';
    return `
<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:16px 20px;margin-bottom:16px">
  <h3 style="color:${titleColor};margin:0 0 12px;font-size:15px">AI 分析 - ${escapeHtml(mr.modelName)}</h3>
  ${analysisToHtml(mr.analysis)}
</div>`;
  }).join('');

  const modelNames = modelResults.map(m => m.modelName).join(', ');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;max-width:800px;margin:0 auto;padding:20px">

<h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;margin-bottom:20px">
  值班日报 ${escapeHtml(today)}
</h2>

${modelSections}

${hasTableData ? `
<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">各地区监控数据明细</h3>
  <p style="color:#7f8c8d;font-size:12px;margin:0 0 12px">红色标记表示环比或同比变化超过 20% 且新增用户超过100</p>
  ${dataHtml}
</div>
` : `
<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">各国监控数据</h3>
  <pre style="background:#f8f9fa;padding:16px;border-radius:6px;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap">${escapeHtml(reportText)}</pre>
</div>
`}

<div style="margin-top:30px;padding-top:12px;border-top:1px solid #eee;color:#95a5a6;font-size:11px">
  由 NanoClaw On-Duty Skill 自动生成 | 数据来源: Grafana 监控 | 分析模型: ${escapeHtml(modelNames)}
</div>

</body>
</html>`;
}

// ── 4. Gmail API 发送邮件 ──────────────────────────────
async function sendEmail(subject: string, htmlBody: string, recipients: string): Promise<void> {
  log(`发送邮件到 ${recipients}...`);

  const credPath = path.join(GMAIL_CRED_DIR, 'credentials.json');
  const keysPath = path.join(GMAIL_CRED_DIR, 'gcp-oauth.keys.json');
  if (!fs.existsSync(credPath)) {
    throw new Error(`Gmail 凭证不存在: ${credPath}\n请先完成 GCP OAuth 配置`);
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

  const clientId = keys.installed?.client_id || keys.web?.client_id;
  const clientSecret = keys.installed?.client_secret || keys.web?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('gcp-oauth.keys.json 格式错误');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token refresh failed: ${tokenRes.status} ${text.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json() as { access_token: string };
  const accessToken = tokenData.access_token;

  const from = credentials.email || 'me';
  const raw = Buffer.from(
    `From: ${from}\r\n` +
    `To: ${recipients}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n` +
    `\r\n` +
    htmlBody,
  ).toString('base64url');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`Gmail send failed: ${sendRes.status} ${text.slice(0, 300)}`);
  }

  log('邮件发送成功');
}

// ── 主流程 ──────────────────────────────────────────────
async function main(): Promise<void> {
  log('=== 值班日报流程开始 ===');

  try {
    const rawReport = runGoBinary();

    const previewIdx = rawReport.indexOf('报告预览:');
    const reportText = previewIdx >= 0
      ? rawReport.slice(previewIdx + '报告预览:'.length).trim()
      : rawReport;

    if (!reportText || reportText.length < 50) {
      throw new Error(`报告内容过短 (${reportText.length} 字)，可能获取数据失败`);
    }
    log(`提取报告正文 ${reportText.length} 字`);

    let combinedContext = '';
    try {
      const { baselineText, trackingText } = storeAndGetBaseline(reportText);
      log(`基线信息: ${baselineText.length > 0 ? baselineText.split('\n').length + ' 行' : '暂无历史数据'}`);
      combinedContext = [baselineText, trackingText].filter(Boolean).join('\n');
    } catch (err) {
      log(`基线处理失败 (不影响报告): ${err instanceof Error ? err.message : String(err)}`);
    }

    log(`使用 ${DUTY_MODELS.length} 个模型进行分析: ${DUTY_MODELS.join(', ')}`);
    const modelResults = await analyzeWithAllModels(reportText, combinedContext);

    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = `[值班日报] ${today} UC激活值班日报`;
    const htmlBody = buildHtmlEmail(reportText, modelResults, today);

    try {
      await sendEmail(subject, htmlBody, RECIPIENT);
      sendIpcAlert(`✅ 值班日报已发送\n收件人: ${RECIPIENT}\n主题: ${subject}`);
    } catch (emailErr) {
      log(`邮件发送失败: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`);
      const firstAnalysis = modelResults[0]?.analysis || '无分析结果';
      sendIpcAlert(
        `⚠️ 值班日报邮件发送失败，以下是分析结果：\n\n${firstAnalysis.slice(0, 3000)}`,
      );
    }

    log('=== 值班日报流程完成 ===');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`流程失败: ${msg}`);
    sendIpcAlert(`❌ 值班日报生成失败: ${msg.slice(0, 500)}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
