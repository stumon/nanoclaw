---
name: newspaper-brief
description: |
  将已整理好的新闻摘要（如 news-summary 输出）生成为报纸风格长图。使用 gen-news-image.cjs（Chromium headless 截图），不依赖外部 AI 图像服务。触发词：报纸风长图、今日报纸图、生成报纸、newspaper brief。
---

# Newspaper Brief 报纸风长图

把 **世界 / 商业 / 科技 / 观点** 四栏新闻摘要生成为**报纸风格竖版长图**，便于分享或早报阅读。

## 输入

- 来自 **news-summary** 的 Markdown 内容（今日要闻 + 四栏列表），或
- 用户提供的已分栏新闻文本。

Markdown 格式要求（gen-news-image.cjs 可解析）：

```markdown
# 今日要闻 YYYY-MM-DD

## 世界
- 第一条新闻标题
- 第二条...

## 商业
- ...

## 科技
- ...

## 观点
- ...
```

## 使用方式

1. 先确保已有结构化新闻 Markdown（若用户说「今日报纸」则先跑 news-summary 得到该内容）。
2. 把 Markdown 写入文件，例如 `/workspace/group/news-en.md`。
3. 用 Bash 调用 `gen-news-image.cjs` 生成 PNG：
   ```bash
   node /workspace/project/scripts/gen-news-image.cjs /workspace/group/news-en.md /workspace/group/infographic-en.png en
   ```
   参数说明：
   - 第 1 个参数：Markdown 文件路径
   - 第 2 个参数：输出 PNG 路径
   - 第 3 个参数：语言（`en` 或 `zh`），影响标题字体和栏名
4. 调用 MCP 工具 `send_image` 发图片：
   ```
   send_image(relativePath: "infographic-en.png", caption: "Today's Headlines")
   ```
5. **不要只回复文字摘要，必须调用 `send_image` 发送图片文件。**

## 与 news-summary 的组合链路（今日报纸 = 英文 + 中文各一张）

当用户说「今日报纸」「生成今日报纸」「新闻报纸长图」时，**必须发两张长图**：

1. **news-summary**：得到英文四栏 Markdown，写入 `/workspace/group/news-en.md`。
2. 生成英文长图：
   ```bash
   node /workspace/project/scripts/gen-news-image.cjs /workspace/group/news-en.md /workspace/group/infographic-en.png en
   ```
   然后 `send_image(relativePath: "infographic-en.png", caption: "Today's Headlines")`。
3. 将英文内容**翻译成中文**，写入 `/workspace/group/news-zh.md`。
4. 生成中文长图：
   ```bash
   node /workspace/project/scripts/gen-news-image.cjs /workspace/group/news-zh.md /workspace/group/infographic-zh.png zh
   ```
   然后 `send_image(relativePath: "infographic-zh.png", caption: "今日要闻 · 中文版")`。

缺一不可；两张都必须是**图片**，不是文字。若只生成了英文图或只发了文字，必须继续完成中文图并以图片形式发送。

## 注意事项

- `gen-news-image.cjs` 使用容器内 Chromium（`/usr/bin/chromium`）做 headless 截图，不需要外部 API。
- 内容中不要包含敏感信息（API key、密码等）。
- 若 `gen-news-image.cjs` 报错 `Chromium not found`，检查 `AGENT_BROWSER_EXECUTABLE_PATH` 环境变量。
