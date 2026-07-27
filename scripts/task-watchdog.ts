/**
 * Task Watchdog -- 每小时检查所有定时任务的健康状态
 *
 * 检查项:
 *   1. launchd 任务是否已加载，退出码是否正常
 *   2. NanoClaw 主进程是否存活
 *   3. 关键输出文件是否按时生成（新闻摘要、股票报告）
 *   4. DB 中 active 调度任务是否有连续失败
 *   5. 日志文件是否有 Error/Fatal/Traceback
 *
 * 告警通过 IPC 消息发送到 WhatsApp。
 *
 * 运行: npx tsx scripts/task-watchdog.ts
 */

import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || process.cwd();
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const IPC_DIR = path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'messages');
const CHAT_JID = '8619860743536@s.whatsapp.net';

const EXPECTED_LAUNCHD_JOBS = [
  'com.nanoclaw',
  'com.nanoclaw.news-summary',
  'com.nanoclaw.stock-daily',
  'com.nanoclaw.hnair-hourly',
  'com.nanoclaw.log-cleanup',
];

interface Alert {
  level: 'warn' | 'error';
  check: string;
  message: string;
}

function now(): Date {
  return new Date();
}

function todayStr(): string {
  return now().toISOString().slice(0, 10);
}

function isWeekday(): boolean {
  const day = now().getDay();
  return day >= 1 && day <= 5;
}

function currentHour(): number {
  const h = now().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
  return parseInt(h, 10);
}

// ── Check 1: launchd jobs ──────────────────────────────────────────

function checkLaunchdJobs(): Alert[] {
  const alerts: Alert[] = [];
  let output: string;
  try {
    output = execSync('launchctl list', { encoding: 'utf-8' });
  } catch {
    alerts.push({
      level: 'error',
      check: 'launchd',
      message: '无法执行 launchctl list',
    });
    return alerts;
  }

  const lines = output.trim().split('\n');
  const loaded = new Map<string, { pid: string; exitCode: string }>();

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const label = parts[2];
      if (label.startsWith('com.nanoclaw')) {
        loaded.set(label, { pid: parts[0], exitCode: parts[1] });
      }
    }
  }

  for (const job of EXPECTED_LAUNCHD_JOBS) {
    const info = loaded.get(job);
    if (!info) {
      alerts.push({
        level: 'error',
        check: 'launchd',
        message: `${job} 未加载`,
      });
      continue;
    }
    if (info.exitCode !== '0' && info.exitCode !== '-') {
      alerts.push({
        level: 'warn',
        check: 'launchd',
        message: `${job} 最近退出码=${info.exitCode}`,
      });
    }
  }

  // NanoClaw main process should have a running PID
  const main = loaded.get('com.nanoclaw');
  if (main && (main.pid === '-' || main.pid === '0')) {
    alerts.push({
      level: 'error',
      check: 'launchd',
      message: 'com.nanoclaw 主进程未运行 (PID=-)',
    });
  }

  return alerts;
}

// ── Check 2: output file freshness ─────────────────────────────────

function checkOutputFiles(): Alert[] {
  const alerts: Alert[] = [];
  const hour = currentHour();

  // News brief: expected after 9:20 Beijing time
  if (hour >= 10) {
    const newsFile = path.join(DATA_DIR, `news-brief-${todayStr()}.md`);
    if (!fs.existsSync(newsFile)) {
      alerts.push({
        level: 'warn',
        check: '新闻摘要',
        message: `今日新闻文件不存在: news-brief-${todayStr()}.md`,
      });
    }
  }

  // Stock report: expected after 16:00 on weekdays
  if (isWeekday() && hour >= 17) {
    const stockLog = path.join(LOGS_DIR, 'stock-daily.log');
    if (fs.existsSync(stockLog)) {
      const content = fs.readFileSync(stockLog, 'utf-8');
      const lines = content.trim().split('\n');
      const last50 = lines.slice(-50).join('\n');
      const todayDate = todayStr().replace(/-/g, '').slice(0, 8);
      const todayFormatted = todayStr();

      const hasToday =
        last50.includes(todayFormatted) || last50.includes(todayDate);
      if (hasToday && last50.includes('今日无报告生成')) {
        alerts.push({
          level: 'error',
          check: '股票数据',
          message: '今日股票分析运行但无报告生成（可能依赖缺失）',
        });
      } else if (!hasToday) {
        alerts.push({
          level: 'warn',
          check: '股票数据',
          message: '今日股票分析似乎未运行',
        });
      }
    } else {
      alerts.push({
        level: 'warn',
        check: '股票数据',
        message: 'stock-daily.log 不存在',
      });
    }
  }

  return alerts;
}

// ── Check 3: DB scheduled tasks ────────────────────────────────────

function checkDbTasks(): Alert[] {
  const alerts: Alert[] = [];
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    return alerts;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    alerts.push({
      level: 'warn',
      check: 'DB',
      message: '无法打开 messages.db',
    });
    return alerts;
  }

  try {
    const activeTasks = db
      .prepare(
        `SELECT id, prompt, schedule_type, schedule_value, next_run
         FROM scheduled_tasks WHERE status = 'active'`,
      )
      .all() as Array<{
      id: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      next_run: string | null;
    }>;

    const nowMs = Date.now();

    for (const task of activeTasks) {
      if (!task.next_run) continue;
      const nextRunMs = new Date(task.next_run).getTime();
      if (isNaN(nextRunMs)) continue;

      // Overdue by more than 2x the interval (or 2 hours for cron)
      let thresholdMs = 2 * 3600_000;
      if (task.schedule_type === 'interval') {
        thresholdMs = 2 * parseInt(task.schedule_value, 10);
      }

      if (nowMs - nextRunMs > thresholdMs) {
        const overdueMin = Math.round((nowMs - nextRunMs) / 60_000);
        alerts.push({
          level: 'warn',
          check: 'DB任务',
          message: `任务 ${task.id} 已过期 ${overdueMin} 分钟未执行: ${task.prompt.slice(0, 40)}`,
        });
      }

      // Check for consecutive failures in run logs
      const recentRuns = db
        .prepare(
          `SELECT status FROM task_run_logs
           WHERE task_id = ? ORDER BY run_at DESC LIMIT 3`,
        )
        .all(task.id) as Array<{ status: string }>;

      if (
        recentRuns.length >= 3 &&
        recentRuns.every((r) => r.status === 'error')
      ) {
        alerts.push({
          level: 'error',
          check: 'DB任务',
          message: `任务 ${task.id} 连续 3 次失败: ${task.prompt.slice(0, 40)}`,
        });
      }
    }
  } finally {
    db.close();
  }

  return alerts;
}

// ── Check 4: log file errors ───────────────────────────────────────

function checkLogErrors(): Alert[] {
  const alerts: Alert[] = [];

  if (!fs.existsSync(LOGS_DIR)) return alerts;

  const SELF_LOGS = new Set(['watchdog-stdout.log', 'watchdog-stderr.log']);

  const logFiles = fs
    .readdirSync(LOGS_DIR)
    .filter(
      (f) =>
        (f.endsWith('.log') || f.endsWith('-stderr.log')) &&
        !SELF_LOGS.has(f),
    );

  const textErrorPatterns = [
    /\bFatal\b/i,
    /\bTraceback\b/i,
    /ModuleNotFoundError/,
    /ECONNREFUSED/,
    /SIGKILL/,
  ];

  /**
   * baileys (WhatsApp) 在弱网下会频繁触发这些 level>=50 日志，但内建
   * reconnect/retry 机制每次都能自恢复，不应该打扰用户。只要不影响消息
   * 投递，这些都视作"可忽略的自愈噪音"。真实的 WhatsApp 不可用问题
   * 会表现为 "connection failure after N retries" 或主进程直接崩溃。
   */
  const BAILEYS_SELF_HEALING = [
    'error in sending keep alive',
    'timed out waiting for message',
    'Failed to flush outgoing queue',
    'transaction failed, rolling back',
    'Connection was lost',
    'Connection Terminated',
    'Connection Closed',
    'Precondition Required',
  ];

  const isNanoclawJsonLog = (filename: string) =>
    /^nanoclaw\.\d{4}-\d{2}-\d{2}/.test(filename);

  const isBaileysSelfHealing = (jsonLine: string): boolean =>
    BAILEYS_SELF_HEALING.some((pat) => jsonLine.includes(pat));

  for (const file of logFiles) {
    const filePath = path.join(LOGS_DIR, file);
    const stat = fs.statSync(filePath);

    if (Date.now() - stat.mtimeMs > 2 * 3600_000) continue;
    if (stat.size === 0) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const tail = lines.slice(-30);

    let errorLines: string[];

    if (isNanoclawJsonLog(file)) {
      errorLines = tail.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.level !== 'number' || parsed.level < 50) return false;
          if (isBaileysSelfHealing(line)) return false;
          return true;
        } catch {
          return false;
        }
      });
    } else {
      errorLines = tail.filter((line) =>
        textErrorPatterns.some((p) => p.test(line)),
      );
    }

    if (errorLines.length > 0) {
      alerts.push({
        level: 'warn',
        check: '日志',
        message: `${file} 最近有 ${errorLines.length} 条错误: ${errorLines[0].slice(0, 80)}`,
      });
    }
  }

  return alerts;
}

// ── Alert dispatch ─────────────────────────────────────────────────

function sendAlert(alerts: Alert[]): void {
  if (alerts.length === 0) return;

  fs.mkdirSync(IPC_DIR, { recursive: true });

  const header = `⚠️ 任务巡检告警 ${todayStr()} ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  const body = alerts
    .map(
      (a) =>
        `${a.level === 'error' ? '🔴' : '🟡'} [${a.check}] ${a.message}`,
    )
    .join('\n');

  const text = `${header}\n${'─'.repeat(30)}\n${body}`;

  const filename = `watchdog-${Date.now()}.json`;
  const msg = { type: 'message', chatJid: CHAT_JID, text };

  fs.writeFileSync(path.join(IPC_DIR, filename), JSON.stringify(msg), 'utf-8');
  console.log(`[watchdog] 已发送 ${alerts.length} 条告警 → ${filename}`);
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  console.log(
    `[watchdog] 开始巡检 ${now().toISOString()} (Beijing ${currentHour()}:xx)`,
  );

  const alerts: Alert[] = [
    ...checkLaunchdJobs(),
    ...checkOutputFiles(),
    ...checkDbTasks(),
    ...checkLogErrors(),
  ];

  if (alerts.length === 0) {
    console.log('[watchdog] 所有检查通过，无告警');
  } else {
    console.log(`[watchdog] 发现 ${alerts.length} 条告警:`);
    for (const a of alerts) {
      console.log(
        `  ${a.level === 'error' ? 'ERROR' : 'WARN'} [${a.check}] ${a.message}`,
      );
    }
    sendAlert(alerts);
  }
}

main();
