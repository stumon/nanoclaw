# Cursor + Claude 值班日报操作指南

## 背景

公司内部 LLM（QwQ-32B、compass-max 等）在分析大量 Grafana 监控面板数据时，存在数据混淆、区域交叉引用、幻觉等问题。通过 Cursor IDE 内置的 Claude Code 直接分析采集到的面板数据，可以获得更准确、更可靠的值班结论。

此方案与原有 WhatsApp 触发的值班日报（使用 Shopee LLM）并行运行，互不影响。

## 前置条件

### 1. Cursor IDE

团队成员需安装 Cursor IDE，并确保 Claude Code 可用。

### 2. NanoClaw 仓库

克隆 NanoClaw 仓库到本地：

```bash
git clone <nanoclaw-repo-url>
cd nanoclaw
npm install
```

### 3. 环境变量

在项目根目录 `.env` 文件中配置：

```
# Grafana API Key（必须，用于采集面板数据）
GRAFANA_API_KEY=<your-grafana-api-key>

# 邮件收件人（逗号分隔）
ON_DUTY_RECIPIENT=your.name@shopee.com
```

### 4. Gmail 凭据

邮件发送依赖 Gmail OAuth，凭据文件位于 `~/.gmail-mcp/`。首次使用需完成 OAuth 授权流程。

## 支持的团队

| 团队 | 关键词 | 配置文件 | Dashboard |
|------|--------|---------|-----------|
| UC | UC值班 | config/duty-dashboards/uc.yaml | UserCenter BE值班日报 |
| Funder | Funder值班 | config/duty-dashboards/funding.yaml | A大促监控 |
| Platform | Platform值班 | config/duty-dashboards/funding-platform.yaml | 卡单监控大盘 + 资损类指标 |

## 使用方式

### 方式一：对话触发（推荐）

在 Cursor 中直接说：

- "UC 值班日报" — 生成 UC 团队值班报告
- "Funder 值班日报" — 生成 Funder 团队值班报告
- "Platform 值班日报" — 生成 Platform 团队值班报告
- "三个团队值班日报" — 依次生成全部三个团队的报告

Cursor 会自动执行以下三步流程。

### 方式二：手动执行

如果需要手动控制每一步，按以下流程操作。

#### Step 1: 数据采集

```bash
# UC
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/uc.yaml --collect-only

# Funder
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding.yaml --collect-only

# Platform
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding-platform.yaml --collect-only
```

脚本完成后输出两个文件：
- `logs/{report_type}-panel-data-{date}.md` — 面板原始数据和统计
- `logs/{report_type}-diagnosis-{date}.json` — 结构化诊断结果

耗时约 1-2 分钟，取决于面板数量和网络速度。

#### Step 2: Claude 分析

让 Claude Code 读取 Step 1 输出的面板数据文件，进行分析。Claude 会基于实际采集的监控数据，按以下格式输出值班结论：

```
[总体风险] 低/中/高
[一句话总结] ...
[异常分析] ...
[关联发现] ...
[值班行动] ...
```

分析结论保存到 `logs/{report_type}-analysis-{date}.md`。

#### Step 3: 发送邮件

```bash
# UC
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/uc.yaml --analysis logs/uc-cursor-analysis-{date}.md

# Funder
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/funding.yaml --analysis logs/funding-analysis-{date}.md

# Platform
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/funding-platform.yaml --analysis logs/funding-platform-analysis-{date}.md
```

## 完整流程图

```
用户在 Cursor 中说 "XX 值班日报"
        |
        v
[Step 1] generic-duty-report.ts --collect-only
        |  -> Grafana API 采集面板数据
        |  -> 规则引擎初筛异常
        |  -> 输出 panel-data.md + diagnosis.json
        v
[Step 2] Claude Code 分析
        |  -> 读取采集数据
        |  -> 多维度分析（趋势、关联、跨区域）
        |  -> 输出 analysis.md
        v
[Step 3] send-duty-email.ts
        |  -> 构建 HTML 邮件
        |  -> Gmail API 发送
        |  -> IPC 通知 WhatsApp（可选）
        v
    邮件送达收件人
```

## 如何新增团队/Dashboard

1. 在 `config/duty-dashboards/` 下新建 YAML 配置文件，参考已有配置

2. 必填字段：

```yaml
name: "团队名 值班巡查"
report_type: "unique-id"

grafana:
  base_url: "https://monitoring.infra.sz.shopee.io/grafana"
  dashboard_uid: "<从 Grafana URL 获取>"
  org_id: 28
  time_range_hours: 24
  step_minutes: 15
  max_data_points: 96

query:
  concurrency: 5
  batch_size: 15
  max_series_per_panel: 10
  max_report_chars: 10000

anomaly_rules: []  # 根据面板指标类型定制

generic_detection:
  z_score_threshold: 4
  spike_count_threshold: 5
  trend_pct_threshold: 100
  min_absolute_value: 1
  max_reasons_per_panel: 3

output:
  recipient_env: "ON_DUTY_RECIPIENT"
  fallback_recipient: "your.name@shopee.com"
  subject_template: "[值班巡查] {today} {name}{critical_tag}"
  ipc_chat_jid: "<WhatsApp JID>"

prompt:
  role: "值班数据分析师"
  dashboard_description: "Dashboard 描述"
```

3. 获取 `dashboard_uid`：从 Grafana URL 中提取，如 `https://...grafana/d/scXKigdVk/...` 中的 `scXKigdVk`

4. 配置 `anomaly_rules`：通过 Grafana API 查看面板结构，为关键指标定制阈值规则

5. 更新 `.claude/skills/cursor-duty-report/SKILL.md` 中的"支持的报告类型"表格

## 常见问题

### 数据采集报错 "API Key 验证失败"

检查 `.env` 中 `GRAFANA_API_KEY` 是否正确，可通过以下命令验证：

```bash
curl -H "Authorization: Bearer $GRAFANA_API_KEY" \
  "https://monitoring.infra.sz.shopee.io/grafana/api/org"
```

### 数据采集报错 "Dashboard 404"

确认 YAML 中的 `org_id` 与 Dashboard 所在的 Grafana Org 一致。API 请求会自动带上 `X-Grafana-Org-Id` 头。

### 邮件发送失败 "Token refresh failed"

Gmail OAuth token 过期，需重新授权。运行 NanoClaw 的 setup 流程刷新凭据。

### 部分面板显示 "不支持的类型"

`grafana-piechart-panel` 等社区插件面板目前不支持通过 API 查询数据。这些面板会被跳过，不影响其他面板的采集。如需覆盖，可考虑在 Grafana 中将 piechart 替换为 timeseries 类型。

### 面板数据不完整

某些面板使用模板变量（如 `$es_cluster`）引用 Elasticsearch 数据源。脚本会通过 `/api/frontend/settings` 自动发现数据源 UID 映射。如果自动发现失败，可在 YAML 的 `grafana.datasource_uid_map` 中手动配置映射。
