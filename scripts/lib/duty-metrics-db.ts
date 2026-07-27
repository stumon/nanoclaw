/**
 * Duty metrics historical baseline storage.
 * Used by on-duty-report.ts and funding-duty-report.ts to store daily metrics
 * and compute rolling statistical baselines for LLM prompt injection.
 */
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'store', 'messages.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS duty_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        report_type TEXT NOT NULL,
        group_name TEXT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_duty_metrics_lookup
        ON duty_metrics(report_type, metric_name, group_name, date);

      CREATE TABLE IF NOT EXISTS duty_anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        report_type TEXT NOT NULL,
        anomaly_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_duty_anomalies_lookup
        ON duty_anomalies(report_type, date);
    `);
  }
  return _db;
}

export interface DutyMetric {
  date: string;
  reportType: 'uc' | 'funding';
  groupName: string | null;
  metricName: string;
  metricValue: number;
}

export interface BaselineStats {
  groupName: string | null;
  metricName: string;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  count: number;
  lastValue: number | null;
  lastDate: string | null;
}

export function storeMetrics(metrics: DutyMetric[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO duty_metrics (date, report_type, group_name, metric_name, metric_value)
    VALUES (?, ?, ?, ?, ?)
  `);

  const upsert = db.transaction((items: DutyMetric[]) => {
    for (const m of items) {
      stmt.run(m.date, m.reportType, m.groupName, m.metricName, m.metricValue);
    }
  });
  upsert(metrics);
}

/**
 * Delete existing metrics for a given date+type before re-inserting,
 * to handle re-runs on the same day.
 */
export function clearMetricsForDate(date: string, reportType: 'uc' | 'funding'): void {
  const db = getDb();
  db.prepare('DELETE FROM duty_metrics WHERE date = ? AND report_type = ?')
    .run(date, reportType);
}

/**
 * Query rolling baselines for a report type over the past N days.
 * Returns per (group_name, metric_name) aggregated stats.
 */
export function getBaselines(
  reportType: 'uc' | 'funding',
  days: number = 30,
): BaselineStats[] {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT
      group_name,
      metric_name,
      AVG(metric_value) as mean,
      COUNT(*) as count,
      MIN(metric_value) as min,
      MAX(metric_value) as max
    FROM duty_metrics
    WHERE report_type = ? AND date >= ?
    GROUP BY group_name, metric_name
    HAVING count >= 2
  `).all(reportType, cutoffStr) as Array<{
    group_name: string | null;
    metric_name: string;
    mean: number;
    count: number;
    min: number;
    max: number;
  }>;

  const stdevStmt = db.prepare(`
    SELECT
      group_name,
      metric_name,
      metric_value
    FROM duty_metrics
    WHERE report_type = ? AND date >= ? AND group_name IS ? AND metric_name = ?
    ORDER BY date
  `);

  const lastStmt = db.prepare(`
    SELECT metric_value, date
    FROM duty_metrics
    WHERE report_type = ? AND group_name IS ? AND metric_name = ?
    ORDER BY date DESC
    LIMIT 1
  `);

  return rows.map(row => {
    const values = stdevStmt.all(
      reportType, cutoffStr, row.group_name, row.metric_name,
    ) as Array<{ metric_value: number }>;

    const mean = row.mean;
    const variance = values.reduce((sum, v) => sum + (v.metric_value - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    const last = lastStmt.get(reportType, row.group_name, row.metric_name) as
      { metric_value: number; date: string } | undefined;

    return {
      groupName: row.group_name,
      metricName: row.metric_name,
      mean,
      stddev,
      min: row.min,
      max: row.max,
      count: row.count,
      lastValue: last?.metric_value ?? null,
      lastDate: last?.date ?? null,
    };
  });
}

/**
 * Filter baselines to only those relevant to abnormal panels/metrics.
 * Reduces token usage by not injecting baselines for normal metrics.
 */
export function filterRelevantBaselines(
  baselines: BaselineStats[],
  abnormalKeys: string[],
): BaselineStats[] {
  if (abnormalKeys.length === 0) return [];
  return baselines.filter(b =>
    abnormalKeys.some(key =>
      b.metricName.includes(key) ||
      (b.groupName && key.includes(b.groupName))
    )
  );
}

/**
 * Format baselines into a text block suitable for LLM prompt injection.
 */
export function formatBaselinesForPrompt(baselines: BaselineStats[]): string {
  if (baselines.length === 0) {
    return '（暂无历史基线数据，首次运行将自动积累）';
  }

  const fmt = (n: number) => {
    if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
    if (Math.abs(n) >= 1) return n.toFixed(1);
    return n.toFixed(3);
  };

  const grouped = new Map<string, BaselineStats[]>();
  for (const b of baselines) {
    const key = b.groupName || '_global';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(b);
  }

  const lines: string[] = [`历史基线（过去30天，${baselines[0]?.count ?? 0}天数据）：`];

  for (const [group, stats] of grouped) {
    if (group !== '_global') {
      lines.push(`[${group}]`);
    }
    for (const s of stats.slice(0, 20)) {
      lines.push(
        `  ${s.metricName}: 均值=${fmt(s.mean)}, 标准差=${fmt(s.stddev)}, 范围=[${fmt(s.min)}, ${fmt(s.max)}]`,
      );
    }
  }

  return lines.join('\n');
}

// ── Anomaly persistence tracking ──────────────────────

export interface AnomalyRecord {
  key: string;
  severity: string;
  reason: string;
}

export interface AnomalyTrackingResult {
  continuing: Array<{ key: string; days: number; severity: string }>;
  newAnomalies: AnomalyRecord[];
  recovered: string[];
}

export function storeAnomalies(
  date: string,
  reportType: 'uc' | 'funding',
  anomalies: AnomalyRecord[],
): void {
  const db = getDb();
  db.prepare('DELETE FROM duty_anomalies WHERE date = ? AND report_type = ?')
    .run(date, reportType);

  const insert = db.prepare(
    'INSERT INTO duty_anomalies (date, report_type, anomaly_key, severity, reason) VALUES (?, ?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    for (const a of anomalies) {
      insert.run(date, reportType, a.key, a.severity, a.reason);
    }
  });
  tx();
}

export function getAnomalyTracking(
  today: string,
  reportType: 'uc' | 'funding',
  currentAnomalies: AnomalyRecord[],
): AnomalyTrackingResult {
  const db = getDb();

  const recentDays = db.prepare(`
    SELECT DISTINCT date FROM duty_anomalies
    WHERE report_type = ? AND date < ?
    ORDER BY date DESC
    LIMIT 7
  `).all(reportType, today) as Array<{ date: string }>;

  if (recentDays.length === 0) {
    return {
      continuing: [],
      newAnomalies: currentAnomalies,
      recovered: [],
    };
  }

  const yesterdayDate = recentDays[0].date;
  const yesterdayKeys = new Set(
    (db.prepare(
      'SELECT anomaly_key FROM duty_anomalies WHERE date = ? AND report_type = ?',
    ).all(yesterdayDate, reportType) as Array<{ anomaly_key: string }>)
      .map(r => r.anomaly_key),
  );

  const allHistoricalKeys = new Map<string, number>();
  for (const { date } of recentDays) {
    const rows = db.prepare(
      'SELECT anomaly_key FROM duty_anomalies WHERE date = ? AND report_type = ?',
    ).all(date, reportType) as Array<{ anomaly_key: string }>;
    for (const r of rows) {
      allHistoricalKeys.set(r.anomaly_key, (allHistoricalKeys.get(r.anomaly_key) || 0) + 1);
    }
  }

  const currentKeys = new Set(currentAnomalies.map(a => a.key));

  const continuing: AnomalyTrackingResult['continuing'] = [];
  const newAnomalies: AnomalyRecord[] = [];
  const recovered: string[] = [];

  for (const a of currentAnomalies) {
    if (yesterdayKeys.has(a.key)) {
      const consecutiveDays = (allHistoricalKeys.get(a.key) || 0) + 1;
      continuing.push({ key: a.key, days: consecutiveDays, severity: a.severity });
    } else {
      newAnomalies.push(a);
    }
  }

  for (const key of yesterdayKeys) {
    if (!currentKeys.has(key)) {
      recovered.push(key);
    }
  }

  return { continuing, newAnomalies, recovered };
}

export function formatAnomalyTrackingForPrompt(tracking: AnomalyTrackingResult): string {
  const lines: string[] = [];

  if (tracking.continuing.length > 0) {
    lines.push('[持续异常]');
    for (const c of tracking.continuing.slice(0, 10)) {
      lines.push(`  ${c.key} 已连续${c.days}天出现 (${c.severity})`);
    }
  }

  if (tracking.newAnomalies.length > 0) {
    lines.push('[新增异常]');
    for (const n of tracking.newAnomalies.slice(0, 10)) {
      lines.push(`  ${n.key} 今天首次出现 (${n.severity})`);
    }
  }

  if (tracking.recovered.length > 0) {
    lines.push('[已恢复]');
    for (const r of tracking.recovered.slice(0, 10)) {
      lines.push(`  ${r} 昨天异常，今天已恢复`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

export interface HistoricalMetricMap {
  date: string | null;
  values: Map<string, number>;
}

/**
 * Get metrics for a specific date offset (e.g. -1 = yesterday, -7 = last week).
 * Returns a Map keyed by "panelTitle::label" -> metric_value.
 */
function getMetricsByOffset(
  reportType: string,
  dayOffset: number,
): HistoricalMetricMap {
  const db = getDb();
  const target = new Date();
  target.setDate(target.getDate() + dayOffset);
  const targetStr = target.toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT metric_name, metric_value
    FROM duty_metrics
    WHERE report_type = ? AND date = ?
  `).all(reportType, targetStr) as Array<{
    metric_name: string;
    metric_value: number;
  }>;

  const values = new Map<string, number>();
  for (const r of rows) {
    values.set(r.metric_name, r.metric_value);
  }

  return { date: rows.length > 0 ? targetStr : null, values };
}

export function getYesterdayMetrics(reportType: string): HistoricalMetricMap {
  return getMetricsByOffset(reportType, -1);
}

export function getLastWeekMetrics(reportType: string): HistoricalMetricMap {
  return getMetricsByOffset(reportType, -7);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
