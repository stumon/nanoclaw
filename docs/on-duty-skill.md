# 值班日报自动化 Skill

## 这是什么

值班日报 Skill 是一个自动化工具，每天自动从 Grafana 监控系统拉取各国业务数据，通过 AI 分析后生成值班日报邮件，发送到指定的工作邮箱。

覆盖 9 个国家：ID、TH、PH、MY、SG、VN、BR、TW、MX

覆盖的产品线：SPL、Buyerloan、Sellerloan、FastEscrow、CicilanHP、SPLX、BCL、SCL

## 能做什么

- 自动拉取 Grafana 最近 24 小时的监控数据
- 对比环比（与昨日）和同比（与上周同天）的数据变化
- AI 自动识别异常指标（变化超过 20% 的数据标红）
- 生成格式清晰的 HTML 邮件，包含数据表格和 AI 分析总结
- 支持定时自动运行（每个工作日上午 10:00）和手动触发

## 邮件效果

邮件分为两个部分：

1. AI 分析总结（蓝色卡片区域）
   - 整体趋势判断
   - 异常数据告警
   - 值班建议

2. 各地区监控数据明细（表格）
   - 每个国家一张表
   - 列出各产品的新增用户数、通过率
   - 环比和同比变化率
   - 超过 20% 变化的数据标红

## 使用方式

### 方式一：自动运行

脚本通过 macOS launchd 定时任务每天上午 10:00（北京时间）自动运行。无需任何操作，邮件会自动发送。

### 方式二：手动触发

在 WhatsApp 中给 Andy 发消息：

```
发值班邮件
```

或者：

```
值班报告
```

Andy 会自动运行脚本并发送邮件。

### 方式三：命令行运行

```bash
cd /path/to/nanoclaw
npx tsx scripts/on-duty-report.ts
```

## 配置

所有配置集中在 `.env` 文件中：

```
# 值班日报邮件收件人（逗号分隔多个收件人）
ON_DUTY_RECIPIENT=huanyu.guo@shopee.com
```

如需发给多人，用逗号分隔：

```
ON_DUTY_RECIPIENT=huanyu.guo@shopee.com,someone@shopee.com
```

## 技术架构

```
launchd 定时 (每天10:00)
       |
       v
on-duty-report.ts (宿主机脚本)
       |
       |-- 1. 运行 Go 二进制 (grafana_report)
       |       |-- 读取 Grafana Cookie (~/.grafana_cookie.json)
       |       |-- 通过 VPN 访问 Grafana API
       |       |-- 查询 Elasticsearch 数据源
       |       |-- 输出各国各产品的数据报告
       |
       |-- 2. 调用 LLM API (QwQ-32B)
       |       |-- 分析数据异常
       |       |-- 生成中文总结
       |
       |-- 3. 构建 HTML 邮件
       |       |-- Part 1: AI 分析总结
       |       |-- Part 2: 原始数据表格（异常标红）
       |
       |-- 4. 通过 Gmail API 发送邮件
       |
       |-- 5. 通过 IPC 通知 WhatsApp
```

## 依赖项

| 依赖 | 用途 | 位置 |
|------|------|------|
| grafana_report | Go 编译的数据采集工具 | uc/on-duty/grafana_report |
| Grafana Cookie | Grafana 登录凭证 | ~/.grafana_cookie.json |
| Gmail OAuth | 邮件发送凭证 | ~/.gmail-mcp/ |
| VPN | 访问内网 Grafana | 宿主机网络 |
| LLM API | AI 数据分析 | .env 中配置 |

## 常见问题

### Grafana Cookie 过期怎么办

Cookie 默认 30 天有效。过期后脚本会自动尝试从 Chrome 浏览器读取新的 Cookie。如果也失败，需要手动更新：

1. 在浏览器中打开 Grafana 并登录
2. 打开开发者工具 -> Application -> Cookies
3. 复制 grafana_session 的值
4. 运行 Go 程序时会提示输入，或者直接编辑 ~/.grafana_cookie.json

### 邮件发送失败

检查 Gmail OAuth 凭证是否过期：

```bash
ls -la ~/.gmail-mcp/credentials.json
```

如果需要重新授权：

```bash
rm ~/.gmail-mcp/credentials.json
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

### VPN 断了

脚本需要 VPN 连接来访问 Grafana。如果 VPN 断开，Go 脚本会超时失败。WhatsApp 会收到失败通知。

### 想修改分析模型

在 `.env` 中修改 MODEL_NAME：

```
MODEL_NAME=compass-max
```

## 日志位置

- 运行日志：logs/on-duty-YYYY-MM-DD.log
- launchd stdout：logs/on-duty-stdout.log
- launchd stderr：logs/on-duty-stderr.log
