---
name: news-summary
description: |
  抓取今日新闻并提炼 5~8 条重点，按「世界 / 商业 / 科技 / 观点」四栏输出。用于每日简报或作为 newspaper-brief 的输入。触发词：今日新闻、新闻摘要、抓取新闻、今日要闻。
---

# News Summary 今日新闻摘要

抓取今日新闻，**每栏保留 4~5 条**，总约 15~20 条，按 **世界 / 商业 / 科技 / 观点** 分栏输出结构化内容。内容越丰富，报纸越好看，**不要压缩、不要只取 3 条**。

## 输出格式

必须产出如下结构的 Markdown（供 newspaper-brief 或直接阅读）：

```markdown
# 今日要闻 YYYY-MM-DD

## 世界
- [标题（可保留原文英文，简短翻译附后）]
- [...]
- [...]
- [...]
- [...]

## 商业
- [...]
- [...]
- [...]
- [...]

## 科技
- [...]
- [...]
- [...]
- [...]

## 观点
- [对当日重点新闻的简短判断，2~3 条，中文]
```

**每栏 4~5 条，观点 2~3 条，总计约 18~23 条。不可少于 12 条。**

## 数据来源

优先级：
1. **宿主机 RSS 摘要文件**（若存在）：读取 `/workspace/project/data/news-brief-YYYY-MM-DD.md`（由 `scripts/news-summary.ts` 生成），**保留文件里全部条目（每栏 4~5 条），仅补全「观点」栏**，不要再裁剪。
2. **WebSearch**：若无文件，用内置 `WebSearch` 分主题查询今日要闻，每主题取 4~5 条：
   - `today world news headlines`
   - `today business news headlines`
   - `today tech news headlines`

## 与 newspaper-brief 的组合

当用户要求「今日报纸」「生成今日报纸」「新闻报纸长图」时，先完成本 skill 得到上述 Markdown，再将**完整内容**交给 **newspaper-brief** skill 生成报纸风长图。

## 宿主机定时任务（每日 9:20 北京时区）

在宿主机每天 9:20（北京时间）自动拉取 RSS 并写入 `data/news-brief-YYYY-MM-DD.md`：

1. 将 `scripts/com.nanoclaw.news-summary.plist` 中的 `WorkingDirectory`、`StandardOutPath`、`StandardErrorPath` 中的路径改为你的项目根目录（若与默认一致可不动）。
2. 安装并加载：

```bash
cp scripts/com.nanoclaw.news-summary.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.news-summary.plist
```

3. 时间说明：plist 内已设置 `TZ=Asia/Shanghai`，故 9:20 为**北京时间**早晨 9:20。
4. 卸载：`launchctl unload ~/Library/LaunchAgents/com.nanoclaw.news-summary.plist`

## 注意事项

- 观点栏：可为编辑/AI 的简短判断，不必逐条对应信源。
- 若存在 `data/news-brief-*.md`，优先基于该文件提炼，减少重复抓取。
