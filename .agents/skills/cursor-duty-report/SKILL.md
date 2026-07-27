# Cursor 值班日报 Skill

在 Cursor 中通过 Codex 生成值班日报。脚本负责数据采集和规则诊断，Codex 负责分析，最后脚本发送邮件。

触发词：值班日报、值班巡查、duty report、Platform值班、Funder值班、UC值班、Platform日报、卡单日报、Funder日报、UC日报

## 支持的报告类型

| 关键词 | 配置文件 | 说明 |
|--------|---------|------|
| UC | config/duty-dashboards/uc.yaml | UC 值班日报（激活、合同、QPS） |
| Funder | config/duty-dashboards/funding.yaml | Funder 值班巡查（MQ、DB、资源） |
| Platform / 卡单 | config/duty-dashboards/funding-platform.yaml | Funding Platform 卡单监控 |

用户说"三个团队值班日报"时，按 UC -> Funder -> Platform 顺序依次执行全部流程。

## 执行流程

严格按以下 3 步执行，不要跳过任何步骤。

### Step 1: 数据采集

运行采集脚本，获取 Grafana 面板数据和规则引擎诊断结果：

```bash
npx tsx scripts/generic-duty-report.ts --config <配置文件路径> --collect-only
```

按团队选择配置文件：
```bash
# UC
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/uc.yaml --collect-only
# Funder
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding.yaml --collect-only
# Platform
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/funding-platform.yaml --collect-only
```

**UC 报告额外步骤 -- 激活申请单数据采集**：
UC 报告需要额外运行激活申请单采集脚本，从各国 Dashboard 的饼图面板查询 ES 数据：

```bash
npx tsx scripts/uc-activation-data.ts
```

输出文件: `logs/uc-activation-{date}.md`，包含各国各产品的新增用户、通过率、环比和同比表格。

脚本完成后会输出文件路径：
- `logs/{report_type}-panel-data-{date}.md` — 面板数据和统计
- `logs/{report_type}-diagnosis-{date}.json` — 结构化诊断结果
- `logs/uc-activation-{date}.md` — UC 激活申请单数据（仅 UC 报告）

等待脚本完成（通常 2-3 分钟），确认输出文件路径。

### Step 2: Codex 分析

读取 Step 1 输出的面板数据文件（`.md` 文件），然后按照以下要求进行分析。

对于 UC 报告，还需要读取 `logs/uc-activation-{date}.md` 激活申请单数据。

分析要求：

你是一名金融科技值班数据分析师。以下是今天从 Grafana 采集的监控面板数据和规则引擎诊断结果。请根据数据进行专业分析。

输出格式要求（严格遵守，不要使用 Markdown 标记）：

```
以下是 {今日日期} 的 {报告名称}分析：

[总体风险] 低/中/高
[一句话总结] （不超过30字描述整体状况）

[异常分析]
异常1: {分组名} / {面板名} | 当前值: {latest值} | 环比: {昨日值}({变化%}) | 同比: {上周值}({变化%}) | 原因: {一句话根因推断} | 建议: {一句话行动} | 紧急度: 立即处理/持续观察
异常2: ...
（没有异常则写"无"）
（分组名即数据中 rowTitle 字段，如"紧急-还款内部卡单超3小时"，帮助快速定位 Grafana 面板位置）
（环比/同比数据来自采集文件中每行末尾的"环比:"和"同比:"字段，若无历史数据则标注"无数据"）

[关联发现]
（多个异常之间的关联。没有则写"无"）

[各地区激活申请单监控数据明细]
（仅 UC 报告需要，数据来自 logs/uc-activation-{date}.md）
按地区分表输出，每个地区一张表：
  {地区} - {地区全名}
  产品 | 新增用户 | 通过率 | 环比(用户) | 环比(通过率) | 同比(用户) | 同比(通过率)
- 红色标记规则：环比或同比变化超过 20% 且新增用户超过100 的数据项，在该数值前加 [!] 标记
- 小样本（新增用户低于100）的产品标注"(小样本)"
- 地区全名对照：ID-印度尼西亚, TH-泰国, PH-菲律宾, MY-马来西亚, SG-新加坡, VN-越南, BR-巴西, TW-台湾, MX-墨西哥

[值班行动]
1. {最重要的事}
2. {次重要的事}
（按优先级排序，最多5条）
```

分析原则：
- 只基于实际数据分析，不要推测外部原因（如"央行维护"、"汇率波动"等）
- 区分区域，VN 的数据不要混入 ID 的分析
- 卡单数为 0 的面板不算异常
- 关注 critical 和 warning 面板，normal 面板简要概括
- 同一类型卡单在多个区域同时异常时，指出关联性
- 每个异常必须带上分组名（rowTitle），方便值班人员快速在 Grafana 中定位
- 引用精确的数值，包括环比和同比变化百分比（如有）
- 成功率类指标需要结合请求量判断：当某区域请求量极低（如 TW、SG 小国家/小产品），单次失败即可使成功率降至 0%，此类波动不应视为严重异常，应降级为"持续观察"或标注"低量场景"
- 当 rowTitle 为"全局(...)"时，表示该 series 在多个区域出现完全相同的数据（全局共享服务），只需报告一次，不要拆分为各区域独立异常
- 核心值班场景（按优先级）：
  (1) 请求量持续掉零 -- 原因中标注了"持续掉零"的面板需重点关注，但先看同比/环比是否一直如此
  (2) 成功率突然下降并持续 -- 结合 trend 和 recentChangePct 判断是突发还是渐变
  (3) 失败量突然飙升并持续 -- 关注失败数从 0 变为持续非 0 的情况
  (4) 请求量突然飙升并持续 -- 注意与大促日历对比
  (5) 请求量突然下降并持续 -- 可能是上游切量或故障
- 同比/环比判断规则（原因末尾会自动标注分类标签）：
  - "(新增异常)" -- 昨日和上周均无此问题，优先级最高，需立即关注
  - "(持续2天)" -- 昨日已存在相同状态，需要关注是否在恶化
  - "(历史常态,与昨日和上周一致)" -- 历史上一直如此，可降低关注度，简要提及即可
- 激活申请单数据分析规则（仅 UC 报告）：
  - 必须完整输出所有地区的激活申请单表格，不要遗漏任何国家
  - 关注显著下降（环比或同比变化超 20% 且新增用户超100）的产品，在异常分析中提及
  - 小样本产品（新增用户低于100）的大幅波动属正常，无需纳入异常
  - 多国同一产品同时下降需在"关联发现"中指出（可能是全局性原因）

将分析结论保存到文件：
- 路径：`logs/{report_type}-analysis-{date}.md`
- 例如：`logs/funding-platform-analysis-2026-03-12.md`

### Step 3: 发送邮件

运行发送脚本：

```bash
npx tsx scripts/send-duty-email.ts --config <配置文件路径> --analysis <分析文件路径>
```

按团队选择配置和分析文件：
```bash
# UC
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/uc.yaml --analysis logs/uc-cursor-analysis-{date}.md
# Funder
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/funding.yaml --analysis logs/funding-analysis-{date}.md
# Platform
npx tsx scripts/send-duty-email.ts --config config/duty-dashboards/funding-platform.yaml --analysis logs/funding-platform-analysis-{date}.md
```

等待脚本完成，确认输出"邮件发送成功"。

## 注意事项

- 数据采集脚本需要网络访问 Grafana，确保 VPN 或网络正常
- `.env` 文件中需要有 `GRAFANA_API_KEY`
- Gmail 凭据位于 `~/.gmail-mcp/`
- 如果采集脚本报错，先排查网络和认证问题
- 分析时不要调用任何外部 LLM API，直接由 Codex 分析
