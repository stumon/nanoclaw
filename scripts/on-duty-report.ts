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

// ── 2. LLM 分析 ──────────────────────────────────────
async function analyzeWithLLM(reportText: string): Promise<string> {
  log('调用 LLM 分析报告...');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const systemPrompt = `你是一名金融科技值班数据分析师。请分析以下 Grafana 值班监控数据，生成一份简洁的中文值班总结。

要求：
1. 总结整体趋势（1-2 句话）
2. 列出环比或同比变化超过 20% 的异常数据（标红色警告）
3. 给出值班建议（需要关注的风险点）
4. 输出纯文本，不要使用 Markdown 标记（不要用 #、*、** 等符号）
5. 用简洁的分段式文字，每行一个要点
6. 开头写"以下是 ${today} 的值班数据分析总结："`;

  const url = OPENAI_BASE_URL
    ? `${OPENAI_BASE_URL}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reportText },
      ],
      max_tokens: 4096,
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
  log(`LLM 分析完成，${content.length} 字`);
  return content;
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

      const highlightUser = Math.abs(parseFloat(userChange)) >= 20;
      const highlightRate = Math.abs(parseFloat(rateChange)) >= 20;
      const highlightWowUser = Math.abs(parseFloat(wowUserChange)) >= 20;
      const highlightWowRate = Math.abs(parseFloat(wowRateChange)) >= 20;

      const warn = (val: string, active: boolean) =>
        active ? `<span style="color:#e74c3c;font-weight:bold">${escapeHtml(val)}</span>` : escapeHtml(val);

      rows.push(`<tr>
        <td style="padding:6px 10px;border:1px solid #e0e0e0">${escapeHtml(name)}</td>
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

function buildHtmlEmail(reportText: string, analysis: string, today: string): string {
  const dataHtml = rawReportToHtml(reportText);
  const hasTableData = dataHtml.length > 0;

  // LLM 分析转 HTML：每行变段落，异常标红
  const analysisHtml = escapeHtml(analysis)
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      let html = line;
      html = html.replace(/【异常】/g, '<span style="color:#e74c3c;font-weight:bold">【异常】</span>');
      return `<p style="margin:4px 0;line-height:1.6">${html}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;max-width:800px;margin:0 auto;padding:20px">

<h2 style="color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;margin-bottom:20px">
  值班日报 ${escapeHtml(today)}
</h2>

<!-- Part 1: LLM 分析总结 -->
<div style="background:#f0f7ff;border:1px solid #b8d4f0;border-radius:8px;padding:16px 20px;margin-bottom:24px">
  <h3 style="color:#2980b9;margin:0 0 12px;font-size:15px">AI 分析总结</h3>
  ${analysisHtml}
</div>

${hasTableData ? `
<!-- Part 2: 原始监控数据 -->
<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">各地区监控数据明细</h3>
  <p style="color:#7f8c8d;font-size:12px;margin:0 0 12px">红色标记表示环比或同比变化超过 20%</p>
  ${dataHtml}
</div>
` : `
<!-- Fallback: 纯文本数据 -->
<div style="margin-top:24px">
  <h3 style="color:#2c3e50;margin:0 0 12px;font-size:15px;border-bottom:1px solid #eee;padding-bottom:8px">各国监控数据</h3>
  <pre style="background:#f8f9fa;padding:16px;border-radius:6px;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap">${escapeHtml(reportText)}</pre>
</div>
`}

<div style="margin-top:30px;padding-top:12px;border-top:1px solid #eee;color:#95a5a6;font-size:11px">
  由 NanoClaw On-Duty Skill 自动生成 | 数据来源: Grafana 监控 | 分析模型: ${escapeHtml(MODEL_NAME)}
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

    const analysis = await analyzeWithLLM(reportText);

    const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = `[值班日报] ${today} UC激活值班日报`;
    const htmlBody = buildHtmlEmail(reportText, analysis, today);

    try {
      await sendEmail(subject, htmlBody, RECIPIENT);
      sendIpcAlert(`✅ 值班日报已发送\n收件人: ${RECIPIENT}\n主题: ${subject}`);
    } catch (emailErr) {
      log(`邮件发送失败: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`);
      sendIpcAlert(
        `⚠️ 值班日报邮件发送失败，以下是分析结果：\n\n${analysis.slice(0, 3000)}`,
      );
    }

    log('=== 值班日报流程完成 ===');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`流程失败: ${msg}`);
    sendIpcAlert(`❌ 值班日报生成失败: ${msg.slice(0, 500)}`);
    process.exit(1);
  }
}

main();
