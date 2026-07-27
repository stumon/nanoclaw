---
name: hnair-ticket-alert
description: Monitor Hainan Airlines flight prices hourly via Playwright-intercepted mobile API. Alert via WhatsApp when price drops below threshold. Control via chat messages to Andy (start/stop/change params).
---

# 海南航空机票价格监控

每小时查询海南航空**实际航班最低价**（全日期范围），低于阈值时通过 WhatsApp 推送。

## 数据源（三层）

1. **m.hnair.com 移动端 API**（Playwright 截获） -- 加载海南航空移动端首页，截获内部签名的 `lowFareTicket` API 响应，获取指定路线的全日期最低价（含促销价如"周二幸运夜"¥199）
2. **海南航空特价 API** -- 国内特价 + 国际特价两个 JSON 接口，作为补充数据
3. **Tavily 搜索** -- 搜索引擎兜底，需要 TAVILY_API_KEY

每次运行都会打印摘要日志，包含最低价、最佳日期、阈值、数据来源。

## 工作原理

海南航空移动端（m.hnair.com）在首页加载时会自动调用 `faretrend/lowFareTicket` 签名 API，返回从当前出发城市到所有目的地的全日期最低机票价格。此 API 使用 HMAC-SHA256 签名，无法直接 curl 调用，因此通过 Playwright 无头浏览器加载页面，截获浏览器发出的已签名 API 响应。

价格说明：
- **促销参考价**：来自首页 lowFareTicket API（如「周二幸运夜」等活动价），数量极少或需活动入口，**与 App 内按日期查询的列表价可能不一致**，仅作参考。
- **实际可订价**：来自航班列表 API（与 App 内该日期搜索结果一致）。脚本会尽量截获该接口；**仅当实际可订价低于阈值时才推送 WhatsApp 通知**，避免误导。

## 参数控制

发消息给 Andy 来控制：
- "继续查询机票信息" -- 使用默认参数（深圳-乌鲁木齐，300元）
- "查深圳到成都 低于500元" -- 自定义路线和价格
- "不再查询机票信息" -- 停止查询

Andy 会解析消息并写入 `groups/main/hnair-config.json`：

```json
{
  "enabled": true,
  "origin": "深圳",
  "destination": "乌鲁木齐",
  "priceMax": 300,
  "daysAhead": 180
}
```

## 默认值

| 参数 | 默认 |
|------|------|
| 出发地 | 深圳 |
| 目的地 | 乌鲁木齐 |
| 价格阈值 | 300 元 |

## 前置条件

- 已配置 WhatsApp 渠道且 NanoClaw 在运行
- Node 18+
- Playwright + Chromium 已安装 (`npx playwright install chromium`)
- 可选：TAVILY_API_KEY（启用搜索引擎兜底）

## 安装

```bash
npx playwright install chromium
cp scripts/com.nanoclaw.hnair-hourly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.hnair-hourly.plist
```

手动测试：

```bash
npx tsx scripts/hnair-ticket-check.ts
```

## 日志与如何确认在运行

机票 skill 由 launchd 每小时执行一次（`com.nanoclaw.hnair-hourly`）。日志有两处：

1. **按北京时区小时分文件**（脚本内写入）：`logs/hnair-ticket-check-YYYY-MM-DD-HH.log`  
   例如 17 点运行 → `hnair-ticket-check-2026-03-08-17.log`。
2. **launchd 标准输出**（最近一次运行）：`logs/hnair-hourly-stdout.log`  
   每次运行的 console 输出都会追加到这里，**看最近是否在跑可直接 tail 这个文件**。

```bash
# 看最近一次运行的输出（推荐）
tail -80 logs/hnair-hourly-stdout.log

# 当前小时的脚本日志（北京时区）
tail -50 logs/hnair-ticket-check-$(date +%Y-%m-%d-%H).log

# 列出最近的小时日志文件
ls -lt logs/hnair-ticket-check-*.log | head -10
```

确认 launchd 已加载：`launchctl list | grep hnair`，若有 `com.nanoclaw.hnair-hourly` 且无退出码即表示在运行。

每次运行的摘要格式：
```
[摘要] 深圳-乌鲁木齐 最低价: ¥860 (2026年3月28日) | 阈值: ¥300 | 数据源: playwright-lowFare | 未达阈值
```

当触发促销价时：
```
[摘要] 深圳-乌鲁木齐 最低价: ¥199 (2026年3月16日) | 阈值: ¥300 | 数据源: playwright-lowFare | 已通知
```

## 注意

- 数据来自海南航空真实售票系统，价格实时变化
- "周二幸运夜"等促销活动会出现超低价（如 ¥199），促销结束后价格回升到正常水平
- 每小时执行一次，通过 Playwright 无头浏览器截获 API，约耗时 10-15 秒
- 支持 30+ 国内主要城市的机场代码映射
