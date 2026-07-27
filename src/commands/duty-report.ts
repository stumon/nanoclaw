import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../logger.js';
import { Channel } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAUSE_FILE = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'duty-reports.paused',
);

/**
 * When true, WhatsApp keyword auto-runs for duty reports are skipped (no scripts, no mail).
 * Toggle: create/remove config/duty-reports.paused or set NANOCLAW_DUTY_REPORTS_DISABLED=1.
 */
export function isDutyReportAutoSendPaused(): boolean {
  const v = process.env.NANOCLAW_DUTY_REPORTS_DISABLED;
  if (v === '1' || v === 'true') return true;
  try {
    return fs.existsSync(PAUSE_FILE);
  } catch {
    return false;
  }
}

const DUTY_CORE = /值班|duty/i;
const DUTY_REPORT = /日报|报告|邮件/;
const FUNDING_KEYWORD = /funding|大促/i;
const FUNDER_KEYWORD = /funder/i;
const PLATFORM_KEYWORD = /platform|卡单监控|资损/i;
const UC_KEYWORD = /\buc\b/i;

let _taskSeq = 0;
function nextTaskId(): string {
  return `D${String(++_taskSeq).padStart(2, '0')}`;
}

export interface DutyDetection {
  triggerUc: boolean;
  triggerFunder: boolean;
  triggerPlatform: boolean;
}

export function detectDutyCommand(text: string): DutyDetection | null {
  const normalized = (text || '').replace(/\u3000/g, ' ').trim();

  const hasDutyCore = DUTY_CORE.test(normalized);
  const hasFunding = FUNDING_KEYWORD.test(normalized);
  const hasFunder = FUNDER_KEYWORD.test(normalized);
  const hasPlatform = PLATFORM_KEYWORD.test(normalized);
  const hasUc = UC_KEYWORD.test(normalized);
  const hasReportWord = DUTY_REPORT.test(normalized);

  if (
    !hasDutyCore &&
    !(hasFunding && hasReportWord) &&
    !(hasFunder && hasReportWord) &&
    !(hasPlatform && hasReportWord)
  )
    return null;

  const result: DutyDetection = {
    triggerUc: false,
    triggerFunder: false,
    triggerPlatform: false,
  };

  if (hasUc) result.triggerUc = true;

  if (hasPlatform) {
    result.triggerPlatform = true;
    if (hasFunder) result.triggerFunder = true;
  } else if (hasFunder || hasFunding) {
    result.triggerFunder = true;
  }

  if (!result.triggerUc && !result.triggerFunder && !result.triggerPlatform) {
    result.triggerUc = true;
  }

  return result;
}

function runScript(cmd: string, taskId: string): void {
  const env = { ...process.env, DUTY_TASK_ID: taskId };
  const child = exec(
    cmd,
    { cwd: process.cwd(), timeout: 600_000, env },
    (error, _stdout, stderr) => {
      if (error) {
        logger.error(
          { cmd, taskId, error: error.message, stderr: stderr?.slice(0, 500) },
          'Duty report script failed',
        );
      } else {
        logger.info({ cmd, taskId }, 'Duty report script completed');
      }
    },
  );
  child.unref();
}

export async function autoTriggerDutyScripts(
  messages: Array<{ content: string; is_bot_message?: boolean }>,
  chatJid: string,
  channel: Channel,
): Promise<boolean> {
  const combinedText = messages
    .filter((m) => !m.is_bot_message)
    .map((m) => m.content)
    .join(' ');

  const detection = detectDutyCommand(combinedText);
  if (!detection) return false;

  if (isDutyReportAutoSendPaused()) {
    await channel.sendMessage(
      chatJid,
      '值班日报自动发送已暂停，恢复时间待定。恢复时删除 config/duty-reports.paused 后重启 NanoClaw，或在环境变量里取消 NANOCLAW_DUTY_REPORTS_DISABLED。单次发送可在 Cursor 按 skill 手动运行脚本。',
    );
    return true;
  }

  const parts: string[] = [];

  if (detection.triggerUc) {
    const id = nextTaskId();
    runScript('npx tsx scripts/on-duty-report.ts', id);
    parts.push(`[${id}] UC 值班日报`);
    logger.info({ chatJid, taskId: id }, 'Auto-triggered UC duty report');
  }

  if (detection.triggerFunder) {
    const id = nextTaskId();
    runScript('npx tsx scripts/funding-duty-report.ts', id);
    parts.push(`[${id}] Funder 值班巡查报告`);
    logger.info({ chatJid, taskId: id }, 'Auto-triggered Funder duty report');
  }

  if (detection.triggerPlatform) {
    const id = nextTaskId();
    runScript(
      'npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding-platform.yaml',
      id,
    );
    parts.push(`[${id}] Funding Platform 值班巡查报告`);
    logger.info(
      { chatJid, taskId: id },
      'Auto-triggered Funding Platform duty report',
    );
  }

  const reply = `${parts.join(' 和 ')}正在生成，完成后自动发送邮件。`;
  await channel.sendMessage(chatJid, reply);

  return true;
}
