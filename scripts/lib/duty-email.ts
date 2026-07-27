/**
 * Shared email building and sending utilities for duty reports.
 * Used by both generic-duty-report.ts (full mode) and send-duty-email.ts (Cursor mode).
 */
import fs from 'fs';
import path from 'path';

const GMAIL_CRED_DIR = path.join(process.env.HOME || '/root', '.gmail-mcp');

export type Severity = 'critical' | 'warning' | 'normal';

export interface ModelAnalysis {
  modelName: string;
  analysis: string;
}

export interface PanelDiagnosisSummary {
  panelTitle: string;
  rowTitle: string;
  severity: Severity;
}

export interface NoDataPanel {
  panelTitle: string;
  rowTitle: string;
}

export interface SkippedPanel {
  title: string;
  type: string;
}

export interface EmailContext {
  configName: string;
  dashboardUid: string;
  totalRawPanels: number;
  diagnoses: PanelDiagnosisSummary[];
  noDataPanels: NoDataPanel[];
  skippedPanels: SkippedPanel[];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildHtmlEmail(
  modelResults: ModelAnalysis[],
  today: string,
  ctx: EmailContext,
): string {
  const criticals = ctx.diagnoses.filter(d => d.severity === 'critical').length;
  const warnings = ctx.diagnoses.filter(d => d.severity === 'warning').length;
  const normals = ctx.diagnoses.filter(d => d.severity === 'normal').length;

  const statusColor = criticals > 0 ? '#dc3545' : warnings > 0 ? '#fd7e14' : '#28a745';
  const statusText = criticals > 0
    ? `${criticals} 个严重异常, ${warnings} 个告警`
    : warnings > 0
      ? `${warnings} 个告警`
      : '全部正常';

  const severityBadge = (s: Severity) => {
    const colors: Record<Severity, string> = { critical: '#e74c3c', warning: '#f39c12', normal: '#27ae60' };
    const labels: Record<Severity, string> = { critical: 'CRITICAL', warning: 'WARNING', normal: 'OK' };
    return `<span style="background:${colors[s]};color:white;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:bold">${labels[s]}</span>`;
  };

  const modelSections = modelResults.map((mr, idx) => {
    const colors = ['#3498db', '#8e44ad', '#27ae60', '#e67e22'];
    const borderColor = colors[idx % colors.length];
    return `
  <div style="margin-bottom:20px">
    <h3 style="color:#2c3e50;border-bottom:2px solid ${borderColor};padding-bottom:8px">AI 分析 - ${escapeHtml(mr.modelName)}</h3>
    <pre style="white-space:pre-wrap;font-size:14px;line-height:1.6;background:#f8f9fa;padding:16px;border-radius:4px">${escapeHtml(mr.analysis)}</pre>
  </div>`;
  }).join('');

  const panelOverviewRows = [
    ...ctx.diagnoses.map(d => `<tr>
      <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(d.rowTitle)}</td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(d.panelTitle)}</td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center">${severityBadge(d.severity)}</td>
    </tr>`),
    ...ctx.noDataPanels.map(nd => `<tr style="opacity:0.6">
      <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(nd.rowTitle)}</td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(nd.panelTitle)}</td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center"><span style="background:#95a5a6;color:white;padding:2px 6px;border-radius:3px;font-size:11px">无数据</span></td>
    </tr>`),
    ...ctx.skippedPanels.map(sp => `<tr style="opacity:0.5">
      <td style="padding:4px 10px;border:1px solid #e0e0e0">-</td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0">${escapeHtml(sp.title)} <span style="color:#999">(${escapeHtml(sp.type)})</span></td>
      <td style="padding:4px 10px;border:1px solid #e0e0e0;text-align:center"><span style="background:#bdc3c7;color:white;padding:2px 6px;border-radius:3px;font-size:11px">跳过</span></td>
    </tr>`),
  ].join('');

  const modelNames = modelResults.map(m => m.modelName).join(', ');
  const totalPanelCount = ctx.diagnoses.length + ctx.noDataPanels.length + ctx.skippedPanels.length;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333">
<div style="background:${statusColor};color:white;padding:16px 24px;border-radius:8px 8px 0 0">
  <h2 style="margin:0">${escapeHtml(ctx.configName)} - ${today}</h2>
  <p style="margin:4px 0 0;opacity:0.9">${statusText} | ${normals} 正常</p>
  <p style="margin:4px 0 0;opacity:0.7;font-size:12px">面板覆盖: 总计 ${ctx.totalRawPanels} 个, 有数据 ${ctx.diagnoses.length} 个, 无数据 ${ctx.noDataPanels.length} 个, 跳过 ${ctx.skippedPanels.length} 个</p>
</div>
<div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px">
  ${modelSections}
  <details style="margin-top:24px">
    <summary style="cursor:pointer;color:#666;font-size:14px">面板概览 (${totalPanelCount} 个)</summary>
    <table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:8px">
      <thead><tr style="background:#f8f9fa">
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left">分组</th>
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:left">面板</th>
        <th style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">状态</th>
      </tr></thead>
      <tbody>${panelOverviewRows}</tbody>
    </table>
  </details>

</div>
<p style="color:#999;font-size:12px;margin-top:16px;text-align:center">由 NanoClaw Duty Report 自动生成 | Dashboard: ${ctx.dashboardUid} | 模型: ${escapeHtml(modelNames)}</p>
</body></html>`;
}

export async function sendEmail(subject: string, htmlBody: string, recipients: string): Promise<void> {
  const credPath = path.join(GMAIL_CRED_DIR, 'credentials.json');
  const keysPath = path.join(GMAIL_CRED_DIR, 'gcp-oauth.keys.json');
  if (!fs.existsSync(credPath)) throw new Error(`Gmail 凭据不存在: ${credPath}`);

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
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`Gmail send failed: ${sendRes.status} ${text.slice(0, 300)}`);
  }
}

export function sendIpcAlert(text: string, ipcDir: string, chatJid: string, reportType: string): void {
  try {
    fs.mkdirSync(ipcDir, { recursive: true });
    const msg = { type: 'message', chatJid, text };
    const filename = `duty_${reportType}_${Date.now()}.json`;
    fs.writeFileSync(path.join(ipcDir, filename), JSON.stringify(msg));
  } catch { /* ignore */ }
}
