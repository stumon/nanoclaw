---
name: on-duty
description: 生成并发送值班日报邮件。从 Grafana 拉取各国监控数据，用 LLM 分析后发送到工作邮箱。
---

# 值班日报 Skill

触发词: "值班报告", "值班邮件", "值班日报", "发值班邮件", "发送值班邮件", "发送值班日报", "发值班日报", "on-duty report", "值班数据"

任何包含"值班"+"邮件/日报/报告"的消息都应触发此 skill。

## 工作模式

### 模式一: 触发宿主机脚本（推荐）

当用户提到值班相关关键词时，立即调用 MCP 工具，不要反问任何细节:

`mcp__nanoclaw__run_host_script({ script_name: "on-duty-report.ts" })`

调用后告诉用户: "值班日报正在生成中，完成后会自动发送到邮箱。"

该工具会请求宿主机执行脚本，脚本自动完成:
1. 运行 Go 二进制从 Grafana 拉取各国值班数据
2. 调用 LLM 分析数据
3. 通过 Gmail API 发送邮件到 huanyu.guo@shopee.com
4. 通过 IPC 通知用户

脚本运行需要宿主机 VPN 连接（访问 Grafana）。如果工具不可用或失败，切换到模式二。

### 模式二: 手动数据分析

用户直接粘贴值班数据时:

1. 分析数据，关注以下要点:
   - 各国各产品新增用户数和通过率
   - 环比变化超过 20% 的指标（标记为异常）
   - 同比变化超过 20% 的指标（标记为异常）
   - 整体趋势总结

2. 生成邮件正文（中文，纯文本，语气正式简洁）

3. 使用 Gmail MCP 工具发送邮件:
   - 收件人: huanyu.guo@shopee.com
   - 主题: [值班日报] YYYY-MM-DD UC激活组值班日报
   - 正文: 分析结果

## 涉及的产品

| 代码 | 产品名 |
|------|--------|
| SPL | SPL (ConsumerLoan) |
| CL | buyerloan (CashLoan) |
| SL | sellerloan (SellerLoan) |
| FES | fastEscrow |
| CHP | CicilanHP |
| SPLX | SPLX |
| BCL | BCL |
| SCL | SCL |

## 覆盖国家

ID, TH, PH, MY, SG, VN, BR, TW, MX

## 依赖

- Go 二进制: `/Users/huanyu.guo/uc/awesome-project-sp-sz/uc/on-duty/grafana_report`
- Grafana Cookie: `~/.grafana_cookie.json`
- Gmail 凭证: `~/.gmail-mcp/`
- VPN 连接（访问 Grafana）
