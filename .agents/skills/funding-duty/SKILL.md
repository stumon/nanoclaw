---
name: funder-duty
description: 生成并发送 Funder (A大促) 值班日报邮件。从 Grafana 拉取 A大促监控数据，用 LLM 分析后通过 Gmail 发送到工作邮箱。
---

# Funder 值班日报 Skill

触发词: "funder值班", "funder报告", "funder日报", "funder邮件", "funding值班", "funding报告", "funding日报", "大促监控", "funder duty", "funding duty"

任何包含"funder"或"funding"+"值班/日报/报告/邮件"或"大促"+"监控/值班"的消息都应触发此 skill。

## 严格约束（必须遵守）

- 此 skill 只能通过 Gmail 发送 HTML 邮件，不支持其他格式或渠道
- 不要提及 PDF、Excel、Word 等文件格式——脚本不会生成这些
- 不要提及钉钉、飞书、Slack 等——脚本不会发送到这些渠道
- 不要编造脚本不具备的功能
- 如果工具调用失败，如实告知用户失败原因，不要假装成功

## 工作模式

### 模式一: 触发宿主机脚本（推荐）

当用户提到 funder/funding 值班相关关键词时，立即调用 MCP 工具，不要反问任何细节:

`mcp__nanoclaw__run_host_script({ script_name: "funding-duty-report.ts" })`

调用后只回复: "Funder 值班日报正在生成中，完成后会自动发送到你的 Gmail 邮箱。"

脚本自动完成:
1. 通过 Grafana API Key 验证并访问 Grafana
2. 通过 Grafana /api/ds/query 批量查询 A大促 Dashboard 所有 Panel 的 Prometheus 时序数据
3. 调用 LLM 分析数据生成值班总结
4. 通过 Gmail API 发送 HTML 邮件到 huanyu.guo@shopee.com
5. 通过 IPC 通知用户

脚本运行需要宿主机 VPN 连接（访问 Grafana）。如果工具不可用或失败，切换到模式二。

### 模式二: 手动数据分析

用户直接粘贴 Funder 监控数据时:

1. 分析数据，关注: MQ堆积、MQ吞吐、DB耗时、交易TPS、机器资源、卡单、中间件探活
2. 生成邮件正文（中文，纯文本，语气正式简洁）
3. 使用 Gmail MCP 工具发送邮件:
   - 收件人: huanyu.guo@shopee.com
   - 主题: [值班日报] YYYY-MM-DD Funder值班日报
   - 正文: 分析结果

## 监控 Dashboard

A大促监控: https://monitoring.infra.sz.shopee.io/grafana/d/Ia35Utv4k/ada-cu-jian-kong?orgId=28&from=now-24h&to=now

包含 18 个分组、165 个 Panel、503 个 Prometheus 查询目标，覆盖:
MQ堆积、MQ吞吐、DB耗时、资方交易TPS、Funder流量、机器CPU/内存、DB磁盘、交易卡单、放还款量占比、文件资方拒绝率、SFTP、KMS、中间件探活、Ceph、MQ宽表、服务状态、交易延迟、LOG

## 依赖

- Grafana API Key: .env 中的 GRAFANA_API_KEY
- Gmail 凭证: ~/.gmail-mcp/
- VPN 连接（访问 Grafana）
