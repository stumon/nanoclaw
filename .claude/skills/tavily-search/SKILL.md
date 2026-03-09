---
name: tavily-search
description: |
  Tavily AI search API - Optimized search for AI agents. Use when searching the web for current information, news, facts, or any task requiring real-time data.
---

# Tavily Search

Tavily AI 搜索，专为 AI agent 优化的实时网络搜索。

## 使用方式

直接在 WhatsApp 上对 Andy 说「搜索 xxx」或「帮我查一下 xxx」即可。Andy 会自动调用 Tavily 搜索全球数据，如果搜索结果是英文，会自动翻译成中文回复。

也可以在容器内用脚本直接搜索：

```bash
./scripts/search "your search query"
./scripts/search "query" 10          # 返回 10 条结果（默认 5 条）
```

## 搜索特性

- 默认深度搜索（search_depth: advanced），结果更全面
- 搜索范围为全球数据，不限地域
- 自动生成 AI 摘要（include_answer: true）
- 返回来源链接和内容片段

## 翻译规则

当 agent 收到搜索结果后，需遵循以下规则：
1. 搜索结果如果是英文或其他非中文内容，翻译为中文后回复用户
2. 保留原始来源链接（URL 不翻译）
3. 专有名词保留英文原文，用括号标注中文含义
4. 技术术语、产品名等在首次出现时给出英文原名

## 环境变量

在项目根目录 `.env` 中配置：

```
TAVILY_API_KEY=your-api-key
```

获取 API key: https://tavily.com/

此 key 同时被以下功能使用：
- tavily-search skill（本 skill，通用搜索）
- hnair-ticket-alert skill（海南航空机票搜索兜底）

## 搜索模型说明

搜索本身由 Tavily API 完成，与 LLM 模型无关。模型只影响对搜索结果的理解、总结和翻译质量。当前可用模型：

| 模型 | 适合场景 |
|------|---------|
| QwQ-32B (Andy) | 日常搜索，中文理解好，推理能力强 |
| compass-max (Mark) | 复杂分析，综合推理能力最强 |
| codecompass (Code) | 代码相关搜索 |

建议：日常搜索用 Andy（QwQ-32B）即可，复杂分析可以 @Mark。

## 示例

对 Andy 说：
- 「搜索 Claude 4 最新消息」
- 「帮我查一下 React 19 有什么新特性」
- 「搜索今天的科技新闻」
- 「search latest AI research papers on reasoning」
