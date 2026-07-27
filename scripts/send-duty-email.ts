/**
 * Send a duty report email using a pre-generated analysis file.
 *
 * Usage:
 *   npx tsx scripts/send-duty-email.ts \
 *     --config config/duty-dashboards/funding-platform.yaml \
 *     --analysis logs/funding-platform-analysis-2026-03-12.md
 *
 * Reads the analysis text and the diagnosis JSON (auto-discovered from config),
 * builds HTML email, sends via Gmail, and optionally sends IPC notification.
 */
import fs from 'fs';
import path from 'path';
import { loadDutyConfig, renderSubjectTemplate } from './lib/duty-config.js';
import {
  buildHtmlEmail,
  sendEmail,
  sendIpcAlert,
  type EmailContext,
} from './lib/duty-email.js';

// ── Load .env ──────────────────────────────────────────
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Parse CLI args ─────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const configFile = getArg('--config');
const analysisFile = getArg('--analysis');

if (!configFile || !analysisFile) {
  console.error('Usage: npx tsx scripts/send-duty-email.ts --config <yaml> --analysis <file>');
  process.exit(1);
}

const configPath = path.resolve(process.cwd(), configFile);
const analysisPath = path.resolve(process.cwd(), analysisFile);
const config = loadDutyConfig(configPath);

const NANOCLAW_DIR = process.cwd();
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const IPC_DIR = path.join(NANOCLAW_DIR, 'data', 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = config.output.ipc_chat_jid;
const RECIPIENT = process.env[config.output.recipient_env]
  || process.env.ON_DUTY_RECIPIENT
  || config.output.fallback_recipient;
const TASK_ID = process.env.DUTY_TASK_ID || '';
const TASK_TAG = TASK_ID ? `[${TASK_ID}] ` : '';

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    fs.appendFileSync(path.join(LOG_DIR, `${config.report_type}-duty-${tag}.log`), line + '\n');
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  log(`=== 发送 ${config.name} 邮件 ===`);

  if (!fs.existsSync(analysisPath)) {
    throw new Error(`分析文件不存在: ${analysisPath}`);
  }
  const analysisText = fs.readFileSync(analysisPath, 'utf-8');
  log(`读取分析文件: ${analysisPath} (${analysisText.length} 字)`);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const diagnosisPath = path.join(LOG_DIR, `${config.report_type}-diagnosis-${todayStr}.json`);

  let emailCtx: EmailContext;
  if (fs.existsSync(diagnosisPath)) {
    const diag = JSON.parse(fs.readFileSync(diagnosisPath, 'utf-8'));
    log(`读取诊断文件: ${diagnosisPath}`);
    emailCtx = {
      configName: config.name,
      dashboardUid: config.grafana.dashboard_uid,
      totalRawPanels: diag.total_panels ?? 0,
      diagnoses: (diag.diagnoses ?? []).map((d: { panelTitle: string; rowTitle: string; severity: string }) => ({
        panelTitle: d.panelTitle,
        rowTitle: d.rowTitle,
        severity: d.severity as 'critical' | 'warning' | 'normal',
      })),
      noDataPanels: [],
      skippedPanels: [],
    };
  } else {
    log(`诊断文件不存在，使用精简邮件格式: ${diagnosisPath}`);
    emailCtx = {
      configName: config.name,
      dashboardUid: config.grafana.dashboard_uid,
      totalRawPanels: 0,
      diagnoses: [],
      noDataPanels: [],
      skippedPanels: [],
    };
  }

  const modelResults = [{ modelName: 'Claude Code', analysis: analysisText }];

  const criticals = emailCtx.diagnoses.filter(d => d.severity === 'critical').length;
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const subject = renderSubjectTemplate(config.output.subject_template, {
    today,
    name: config.name,
    criticalCount: criticals,
  });

  const htmlBody = buildHtmlEmail(modelResults, today, emailCtx);

  try {
    await sendEmail(subject, htmlBody, RECIPIENT);
    log('邮件发送成功');
    const warnings = emailCtx.diagnoses.filter(d => d.severity === 'warning').length;
    const statusLine = criticals > 0
      ? `发现 ${criticals} 个严重异常, ${warnings} 个告警`
      : warnings > 0
        ? `发现 ${warnings} 个告警，无严重异常`
        : `全部正常`;
    sendIpcAlert(
      `${TASK_TAG}${config.name}报告已发送\n${statusLine}\n收件人: ${RECIPIENT}\n主题: ${subject}`,
      IPC_DIR, CHAT_JID, config.report_type,
    );
  } catch (err) {
    log(`邮件发送失败: ${err instanceof Error ? err.message : String(err)}`);
    sendIpcAlert(
      `${TASK_TAG}${config.name}邮件发送失败: ${err instanceof Error ? err.message : String(err)}`,
      IPC_DIR, CHAT_JID, config.report_type,
    );
    process.exitCode = 1;
  }

  log(`=== 邮件发送流程完成 ===`);
}

main();
