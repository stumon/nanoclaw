---
name: grafana-inspection
description: 在 Cursor 中直接用 Claude 分析 Grafana 监控数据，生成值班巡检报告。利用 Claude 的强推理能力替代弱模型，无需额外基础设施。
---

# Grafana 智能巡检 Skill

触发词: "巡检", "grafana inspection", "grafana 巡检", "智能巡检", "monitoring check", "监控巡检", "值班巡检"

当用户提到以上关键词时，按以下流程执行巡检。

## 前置条件

- .env 中已配置 `GRAFANA_API_KEY`
- config/duty-dashboards/ 下有对应的 YAML 配置文件
- 网络可达 Grafana 实例

## 执行流程

### Step 1: 确定巡检目标

检查用户消息中的关键词，确定要巡检的 Dashboard：

| 关键词 | 配置文件 | Dashboard |
|--------|----------|-----------|
| funder / 大促 | config/duty-dashboards/funding.yaml | A大促监控 |
| platform / 卡单 / 资损 | config/duty-dashboards/funding-platform.yaml | 卡单监控大盘 + 资损类指标 |
| uc | (UC 使用独立脚本) | UC 监控 |

如果用户未指定，列出可用的巡检目标让用户选择。

### Step 2: 读取配置

```bash
cat config/duty-dashboards/<target>.yaml
```

从 YAML 中提取：
- `grafana.base_url` / `grafana.dashboard_uid` / `grafana.additional_uids` / `grafana.org_id`
- `anomaly_rules` (域规则列表)
- `prompt.role` / `prompt.dashboard_description`

### Step 3: 读取 API Key

```bash
grep GRAFANA_API_KEY .env | cut -d= -f2
```

### Step 4: 拉取 Dashboard 元数据

对每个 Dashboard UID 执行：

```bash
curl -s \
  -H "Authorization: Bearer <API_KEY>" \
  -H "X-Grafana-Org-Id: <org_id>" \
  "<base_url>/api/dashboards/uid/<uid>" | python3 -c "
import sys, json
d = json.load(sys.stdin)
panels = d.get('dashboard', {}).get('panels', [])
for p in panels:
    t = p.get('type','')
    title = p.get('title','')
    if t == 'row':
        print(f'ROW: {title}')
        for sp in p.get('panels', []):
            st = sp.get('type','')
            stitle = sp.get('title','')
            targets = len(sp.get('targets', []))
            print(f'  [{st}] {stitle} ({targets} targets)')
    else:
        targets = len(p.get('targets', []))
        print(f'[{t}] {title} ({targets} targets)')
"
```

根据面板列表，选择需要重点分析的分组（优先级：卡单 > MQ堆积 > DB耗时 > 交易延迟 > 其他）。

### Step 5: 拉取时序数据

对选定的面板，提取其 Prometheus 查询表达式，然后批量查询：

```bash
# 获取面板的 target 表达式
curl -s \
  -H "Authorization: Bearer <API_KEY>" \
  -H "X-Grafana-Org-Id: <org_id>" \
  "<base_url>/api/dashboards/uid/<uid>" | python3 -c "
import sys, json
d = json.load(sys.stdin)
panels = d.get('dashboard', {}).get('panels', [])
# 提取指定面板的 targets...
"
```

然后用 `/api/ds/query` 查询 24h 数据：

```bash
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
FROM_MS=$(python3 -c "import time; print(int((time.time()-86400)*1000))")

curl -s -X POST \
  -H "Authorization: Bearer <API_KEY>" \
  -H "X-Grafana-Org-Id: <org_id>" \
  -H "Content-Type: application/json" \
  "<base_url>/api/ds/query" \
  -d '{"queries":[{"datasource":{"uid":"<ds_uid>"},"expr":"<prometheus_expr>","refId":"A","instant":false,"maxDataPoints":96,"intervalMs":900000}],"from":"'$FROM_MS'","to":"'$NOW_MS'"}'
```

将返回的 JSON 保存到临时文件供分析。

### Step 6: 分析数据

对拉取到的时序数据，执行以下分析：

1. **统计特征计算**：对每条时序计算 latest、mean、max、min、stddev、趋势方向
2. **规则匹配**：参照 YAML 中的 `anomaly_rules`，检查是否触发域规则
3. **Z-score 检测**：对未被域规则覆盖的面板，检查 Z-score 是否 > 4
4. **业务语义判断**：
   - 卡单=0 在日切后是正常的
   - MQ堆积绝对值 < 100 通常不需要关注
   - 探活值 10=成功, 5=失败, 0=上报中断
   - 趋势上升但绝对值很低的指标通常是噪声

### Step 7: 生成报告

按以下格式输出报告：

```
以下是 <日期> 的 <Dashboard名称> 值班巡查分析：

[总体风险] 低/中/高
[一句话总结] （不超过30字）

[异常分析]
异常1: <面板名> | 原因: <根因推断> | 建议: <行动> | 紧急度: 立即处理/持续观察
...

[关联发现]
（多个异常之间的关联分析）

[值班行动]
1. <最重要的事>
2. <次重要的事>
```

### Step 8: 发送报告（可选）

如果用户要求发送邮件，可以触发脚本：

```bash
npx tsx scripts/funding-duty-report.ts
# 或
npx tsx scripts/generic-duty-report.ts --config config/duty-dashboards/<target>.yaml
```

## 大促日期感知

Shopee 大促日期为当月同日（1/1, 2/2, 3/3 ... 12/12），大促期间为大促日前后各 2 天。
在大促期间，以下现象属于正常波动：
- 交易量/MQ吞吐量上升 50-200%
- 卡单数量短期增加（因交易量增大）
- DB延迟小幅上升

分析时应标注当前是否处于大促期间，并据此调整异常判断阈值。

## 与自动化脚本的区别

| 维度 | 自动化脚本 | Cursor 巡检 Skill |
|------|------------|-------------------|
| 分析模型 | compass-max / QwQ-32B（内部弱模型） | Claude（Cursor 内置强模型） |
| 数据范围 | 全量 500+ target | 按需选取核心指标 |
| 触发方式 | WhatsApp 消息 / 定时任务 | Cursor 对话 |
| 输出方式 | 自动发邮件 + WhatsApp 通知 | Cursor 对话 + 可选发邮件 |
| 适用场景 | 日常自动巡检 | 深度分析、问题排查、临时巡检 |
