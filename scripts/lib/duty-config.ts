/**
 * Configuration-driven duty report framework.
 *
 * Loads YAML configs from config/duty-dashboards/ and provides
 * reusable types and rule builders for any Grafana-based duty report.
 *
 * Usage:
 *   npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding.yaml
 */
import fs from 'fs';
import { parse as parseYaml } from 'yaml';

// ── YAML Config Types ──────────────────────────────────

export interface DutyConfig {
  name: string;
  report_type: string;
  models?: string[];

  grafana: {
    base_url: string;
    dashboard_uid: string;
    additional_uids?: string[];
    org_id: number;
    time_range_hours: number;
    step_minutes: number;
    max_data_points: number;
    datasource_uid_map?: Record<string, string>;
  };

  query: {
    concurrency: number;
    batch_size: number;
    max_series_per_panel: number;
    max_report_chars: number;
  };

  anomaly_rules: AnomalyRuleConfig[];

  generic_detection: {
    z_score_threshold: number;
    spike_count_threshold: number;
    trend_pct_threshold: number;
    recent_change_pct_threshold: number;
    min_absolute_value: number;
    max_reasons_per_panel: number;
  };

  output: {
    recipient_env: string;
    fallback_recipient: string;
    subject_template: string;
    ipc_chat_jid: string;
  };

  prompt: {
    role: string;
    dashboard_description: string;
    stage1_example: string;
    stage2_example: string;
  };
}

export interface AnomalyRuleConfig {
  match_pattern: string;
  match_flags?: string;
  field: 'latest' | 'max' | 'min' | 'mean';
  warning_threshold: number;
  critical_threshold: number;
  unit?: string;
  label_template?: string;
  below_threshold?: boolean;
  equals_zero_critical?: boolean;
  invert_for_warning?: boolean;
  min_mean_threshold?: number;
}

// ── Series Stats (shared type) ─────────────────────────

export interface SeriesStats {
  label: string;
  latest: number | null;
  mean: number;
  max: number;
  min: number;
  stddev: number;
  trend: 'rising' | 'falling' | 'stable';
  trendPct: number;
  spikeCount: number;
  zeroCount: number;
  zeroStreak: number;
  changeRate: number;
  dataPoints: number;
  recentChangePct: number;
}

export type Severity = 'normal' | 'warning' | 'critical';

export interface AnomalyCheckResult {
  severity: Severity;
  reasons: string[];
}

export interface CompiledAnomalyRule {
  match: (title: string) => boolean;
  check: (stats: SeriesStats[]) => AnomalyCheckResult;
}

// ── Config Loader ──────────────────────────────────────

export function loadDutyConfig(configPath: string): DutyConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = parseYaml(raw) as DutyConfig;

  if (!config.name || !config.report_type) {
    throw new Error(`Invalid config: missing name or report_type in ${configPath}`);
  }
  if (!config.grafana?.dashboard_uid) {
    throw new Error(`Invalid config: missing grafana.dashboard_uid in ${configPath}`);
  }

  config.query = {
    concurrency: 5,
    batch_size: 15,
    max_series_per_panel: 5,
    max_report_chars: 10000,
    ...config.query,
  };
  config.generic_detection = {
    z_score_threshold: 4,
    spike_count_threshold: 5,
    trend_pct_threshold: 100,
    recent_change_pct_threshold: 200,
    min_absolute_value: 10,
    max_reasons_per_panel: 3,
    ...config.generic_detection,
  };

  return config;
}

// ── Rule Compiler ──────────────────────────────────────

const fmt = (n: number | null): string => {
  if (n === null) return 'N/A';
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(3);
};

export function compileAnomalyRules(
  ruleConfigs: AnomalyRuleConfig[],
  maxReasons: number,
): CompiledAnomalyRule[] {
  return ruleConfigs.map(rc => {
    const regex = new RegExp(rc.match_pattern, rc.match_flags || 'i');

    return {
      match: (title: string) => regex.test(title),
      check: (stats: SeriesStats[]): AnomalyCheckResult => {
        const reasons: string[] = [];
        let sev: Severity = 'normal';

        for (const s of stats) {
          const fieldValue = s[rc.field] as number | null;
          if (fieldValue === null || fieldValue === undefined) continue;

          if (rc.equals_zero_critical && fieldValue === 0) {
            sev = 'critical';
            reasons.push(
              (rc.label_template || `${s.label}=${fieldValue}`)
                .replace('{label}', s.label)
                .replace('{value}', fmt(fieldValue)),
            );
            continue;
          }

          if (rc.below_threshold) {
            const lowVolume = rc.min_mean_threshold != null && s.mean < rc.min_mean_threshold;
            if (fieldValue < rc.critical_threshold) {
              if (lowVolume) {
                if (sev === 'normal') sev = 'warning';
                reasons.push(
                  `${s.label} 成功率=${fmt(fieldValue)}%(低量,mean=${fmt(s.mean)}%,降级为告警)`,
                );
              } else {
                sev = 'critical';
                reasons.push(
                  (rc.label_template || `${s.label}=${fieldValue}`)
                    .replace('{label}', s.label)
                    .replace('{value}', fmt(fieldValue)),
                );
              }
            } else if (fieldValue < rc.warning_threshold && sev === 'normal') {
              sev = 'warning';
              reasons.push(
                (rc.label_template || `${s.label}=${fieldValue}`)
                  .replace('{label}', s.label)
                  .replace('{value}', fmt(fieldValue)),
              );
            }
          } else {
            if (fieldValue > rc.critical_threshold) {
              sev = 'critical';
              reasons.push(
                (rc.label_template || `${s.label}=${fieldValue}`)
                  .replace('{label}', s.label)
                  .replace('{value}', fmt(fieldValue)),
              );
            } else if (fieldValue > rc.warning_threshold && sev === 'normal') {
              if (rc.invert_for_warning) {
                if (s.max > 0) {
                  sev = 'warning';
                  reasons.push(
                    (rc.label_template || `${s.label}=${fieldValue}`)
                      .replace('{label}', s.label)
                      .replace('{value}', fmt(s.max)),
                  );
                }
              } else {
                sev = 'warning';
                reasons.push(
                  (rc.label_template || `${s.label}=${fieldValue}`)
                    .replace('{label}', s.label)
                    .replace('{value}', fmt(fieldValue)),
                );
              }
            }
          }
        }

        return { severity: sev, reasons: reasons.slice(0, maxReasons) };
      },
    };
  });
}

export function buildGenericDetector(config: DutyConfig['generic_detection']) {
  return function detectGeneric(stats: SeriesStats[]): AnomalyCheckResult {
    const reasons: string[] = [];
    let sev: Severity = 'normal';

    for (const s of stats) {
      const zeroStreakThreshold = Math.max(4, Math.floor(s.dataPoints * 0.25));
      if (s.zeroStreak >= zeroStreakThreshold && s.dataPoints > 0 && s.max > 0) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 持续掉零(最近${s.zeroStreak}/${s.dataPoints}个采样点=0)`);
      }

      if (Math.abs(s.mean) < config.min_absolute_value && Math.abs(s.max) < config.min_absolute_value) continue;

      if (s.spikeCount >= config.spike_count_threshold) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 出现${s.spikeCount}次尖峰(>3sigma)`);
      }
      if (s.trend === 'rising' && s.trendPct > config.trend_pct_threshold) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 持续上升(+${fmt(s.trendPct)}%)`);
      }
      if (s.trend === 'falling' && s.trendPct < -config.trend_pct_threshold) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 持续下降(${fmt(s.trendPct)}%)`);
      }
      if (s.recentChangePct > config.recent_change_pct_threshold) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 近期突增(+${fmt(s.recentChangePct)}%)`);
      }
      if (s.recentChangePct < -config.recent_change_pct_threshold / 4) {
        if (sev === 'normal') sev = 'warning';
        reasons.push(`${s.label} 近期突降(${fmt(s.recentChangePct)}%)`);
      }
      if (s.stddev > 0 && s.latest !== null && Math.abs(s.latest) > config.min_absolute_value) {
        const z = Math.abs(s.latest - s.mean) / s.stddev;
        if (z > config.z_score_threshold) {
          if (sev === 'normal') sev = 'warning';
          reasons.push(`${s.label} 当前值偏离均值(Z=${z.toFixed(1)})`);
        }
      }
    }

    return { severity: sev, reasons: reasons.slice(0, config.max_reasons_per_panel) };
  };
}

export interface BaselineEntry {
  metricName: string;
  mean: number;
  stddev: number;
}

export function checkBaselineAnomalies(
  panelTitle: string,
  stats: SeriesStats[],
  baselines: BaselineEntry[],
  maxReasons: number,
): AnomalyCheckResult {
  const reasons: string[] = [];
  let sev: Severity = 'normal';

  for (const s of stats) {
    if (s.latest === null) continue;
    const key = `${panelTitle}::${s.label}`;
    const bl = baselines.find(b => b.metricName === key);
    if (!bl || bl.stddev === 0 || bl.mean === 0) continue;

    const deviation = Math.abs(s.latest - bl.mean);
    const threshold = 3 * bl.stddev;
    if (deviation > threshold) {
      if (sev === 'normal') sev = 'warning';
      const direction = s.latest > bl.mean ? '偏高' : '偏低';
      const zHist = (deviation / bl.stddev).toFixed(1);
      reasons.push(`${s.label} 历史基线${direction}(Z_hist=${zHist}, baseline=${fmt(bl.mean)}+-${fmt(bl.stddev)})`);
    }
  }

  return { severity: sev, reasons: reasons.slice(0, maxReasons) };
}

export function severityRank(s: Severity): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}

// ── Prompt Builder ─────────────────────────────────────

export function buildStage1Prompt(config: DutyConfig, baselineText: string): string {
  const baselineBlock = baselineText
    ? `\n历史上下文（基线 + 异常追踪，持续异常优先关注）：\n${baselineText}\n`
    : '';

  return `你是一名${config.prompt.role}。以下是预处理过的 Grafana "${config.prompt.dashboard_description}" 监控数据，[CRITICAL]/[WARNING] 为预检测异常。
${baselineBlock}
你的任务是确认哪些是真正的异常（排除在历史基线范围内的正常波动）。

请严格按以下格式输出每个确认的异常，一行一个，不要额外文字，不要 Markdown：
{面板名} | {严重程度:严重/告警} | {一句话原因}

如果没有真正的异常，只输出一行：无异常

示例：
${config.prompt.stage1_example}`;
}

export function buildStage2Prompt(config: DutyConfig, today: string): string {
  return `你是一名${config.prompt.role}。以下是已确认的异常列表。

请严格按照以下格式输出，不要使用 Markdown 标记（不要用 # * \` 等符号）：

[总体风险] 低/中/高
[一句话总结] （不超过30字描述整体状况）

[异常分析]
异常1: {面板名} | 原因: {一句话根因推断} | 建议: {一句话行动} | 紧急度: 立即处理/持续观察
异常2: ...
（没有异常则写"无"）

[关联发现]
（多个异常之间的关联。没有则写"无"）

[值班行动]
1. {最重要的事}
2. {次重要的事}
（按优先级排序，最多3条）

以下是一个好的输出示例：
---
${config.prompt.stage2_example}
---

开头写"以下是 ${today} 的 ${config.name}分析："`;
}

// ── Output Validation ──────────────────────────────────

export function validateLLMOutput(output: string): { valid: boolean; reason: string } {
  if (!output || output.length < 50) {
    return { valid: false, reason: '输出过短' };
  }
  if (!/\[总体风险\]\s*(低|中|高)/.test(output)) {
    return { valid: false, reason: '缺少 [总体风险]' };
  }
  if (!/\[异常分析\]/.test(output)) {
    return { valid: false, reason: '缺少 [异常分析]' };
  }
  if (/#{2,}|^\*\*|```/m.test(output)) {
    return { valid: false, reason: '包含 Markdown 格式' };
  }
  return { valid: true, reason: '' };
}

export function patchLLMOutput(output: string): string {
  let patched = output;
  if (!/\[一句话总结\]/.test(patched)) {
    const insertAt = patched.indexOf('[异常分析]');
    if (insertAt > 0) {
      patched = patched.slice(0, insertAt) + '[一句话总结] 详见异常分析\n\n' + patched.slice(insertAt);
    }
  }
  if (!/\[值班行动\]/.test(patched)) {
    patched += '\n\n[值班行动]\n1. 关注上述异常面板，按严重程度优先处理';
  }
  if (!/\[关联发现\]/.test(patched)) {
    const actionIdx = patched.indexOf('[值班行动]');
    if (actionIdx > 0) {
      patched = patched.slice(0, actionIdx) + '[关联发现]\n需结合业务上下文进一步分析\n\n' + patched.slice(actionIdx);
    }
  }
  return patched;
}

export function renderSubjectTemplate(
  template: string,
  vars: { today: string; name: string; criticalCount: number },
): string {
  return template
    .replace('{today}', vars.today)
    .replace('{name}', vars.name)
    .replace('{critical_tag}', vars.criticalCount > 0 ? ' [有异常]' : '');
}
