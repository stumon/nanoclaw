---
name: hnair-ticket-alert
description: Scan Hainan Airlines fares hourly with dynamic route/price params. Alert via WhatsApp with flight details. Control via chat messages to Andy (start/stop/change params).
---

# 海南航空特价机票提醒

每小时扫描海南航空特价机票，低于阈值时通过 WhatsApp 推送航班信息（年月日+价格）。

支持动态参数 -- 通过发消息给 Andy 指定出发地、目的地、价格阈值：
- 「继续查询机票信息」→ 使用默认参数（深圳-乌鲁木齐，300元）
- 「查深圳到成都 低于500元」→ 自定义路线和价格
- 「不再查询机票信息」→ 停止查询

## 默认值

| 参数 | 默认 |
|------|------|
| 出发地 | 深圳 |
| 目的地 | 乌鲁木齐 |
| 价格阈值 | 300 元 |
| 扫描范围 | 最近半年（180天） |

## 前置条件

- 已配置 WhatsApp 渠道且 NanoClaw 在运行
- 本机已安装 Node 18+
- 已安装 Playwright：`npm install playwright` 和 `npx playwright install chromium`

## 查询方式

1. **Playwright 无头浏览器（默认）**
   使用 Playwright 无头浏览器打开海南航空官网搜索航班，提取航班信息和价格（不会在桌面弹出窗口）。

2. **国内特价接口（辅助）**
   同时请求 `https://www.hnair.com/xsy/tjjp/gntjjp/data/index.json`，筛选符合条件的特价航班作为补充数据。

## 安装步骤

### 1. 复制脚本到项目

将 skill 下的 `add/scripts/hnair-ticket-check.ts` 复制到项目根目录的 `scripts/` 下（若已通过 apply-skill 应用则跳过）。

### 2. 每小时运行

**macOS (launchd)：**

```bash
cp scripts/com.nanoclaw.hnair-hourly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.hnair-hourly.plist
```

**手动测试：**

```bash
npx tsx scripts/hnair-ticket-check.ts
```

## 参数控制

用户通过发消息给 Andy 来控制查询参数。Andy 会解析消息并写入配置文件 `groups/main/hnair-config.json`。

配置文件格式：

```json
{
  "enabled": true,
  "origin": "深圳",
  "destination": "乌鲁木齐",
  "priceMax": 300,
  "daysAhead": 180
}
```

### 启动/修改参数

发送给 Andy 的消息示例：
- 「继续查询机票信息」→ 默认参数
- 「查深圳到成都 低于500元」→ 自定义
- 「帮我看北京飞三亚 200元以下 最近3个月」→ 全部自定义

### 停止查询

发送「不再查询机票信息」给 Andy，配置会被设为 `enabled: false`。

## 逻辑说明

1. 读取 `groups/main/hnair-config.json`，若 `enabled` 为 false 则跳过
2. 若无配置文件，使用默认值（深圳-乌鲁木齐，300元，180天）
3. 使用 Playwright 无头浏览器搜索航班，提取航班信息（日期、价格）
4. 同时请求国内特价 JSON 接口作为补充数据源
5. 合并结果，筛选低于阈值的航班，按价格排序
6. 拼接航班信息（年月日+价格）发送提醒

## 环境变量

以下环境变量可覆盖部分行为（一般不需要设置）：

- `HNAIR_IPC_CHAT_JID`：接收提醒的 WhatsApp JID
- `HNAIR_TARGET_PRICE`：精确目标价格（元），默认 `199`
- `HNAIR_USE_BROWSER`：是否用无头浏览器，默认 `true`
- `HNAIR_NANOCLAW_DIR`：NanoClaw 项目根目录

## 注意事项

- 官网改版后接口或选择器可能失效，需自行调整
- 每小时执行一次即可，避免请求过频
- 日志在 `logs/hnair-ticket-check.log`
- 支持 30+ 国内主要城市的机场代码自动映射
