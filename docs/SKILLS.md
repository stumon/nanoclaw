# NanoClaw Skills 功能说明

所有 101 个 skills 统一维护在项目 `.claude/skills/` 目录下，容器启动时自动同步，Andy（WhatsApp）和 Cursor 都能使用。

标记 [Bot] 的是 Andy 在 WhatsApp 中的专属能力。

---

## 财务管理

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| lark-asset-update [Bot] | 发送券商截图更新飞书资产表 | 对 Andy 说「更新资产」，然后发截图 | APPID + APPSecret |
| xlsx | Excel 创建、编辑、公式、数据分析 | 让 AI 处理 .xlsx 文件 | 无 |
| gog | Google Workspace（Gmail、日历、Drive、Sheets） | 让 AI 操作 Google 服务 | Google OAuth |

## 出行助手

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| hnair-ticket-alert [Bot] | 海南航空特价机票监控，每小时扫描，低价推送 | 对 Andy 说「查深圳到成都 低于500元」 | 可选 TAVILY_API_KEY |
| weather | 查天气预报（wttr.in / Open-Meteo） | 问「北京天气」 | 无 |

## 即时查询

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| tavily-search | Tavily AI 搜索引擎，实时网络搜索 | 让 AI 搜索任何信息 | TAVILY_API_KEY |
| summarize | 从 URL、播客、本地文件中提取和总结文本 | 给一个 URL 让 AI 总结 | 无 |
| just-scrape | AI 网页抓取、数据提取、搜索、爬虫 | 让 AI 从网页提取结构化数据 | SGAI_API_KEY |
| audit-website | 网站全面审计（SEO、性能、安全等 230+ 规则） | 让 AI 审计一个网站 | 无 |

## 浏览器自动化

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| agent-browser [Bot] | 浏览器自动化：打开网页、点击、填表、截图、提取数据 | Andy 自动调用，用户无需操作 | 无 |
| browser-use | 浏览器自动化 CLI（支持云端浏览器） | `browser-use open <url>` | 可选 BROWSER_USE_API_KEY |
| webapp-testing | Playwright 本地 Web 应用测试 | 编写 Python 测试脚本 | 无 |

## 渠道管理 [Bot]

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| add-whatsapp | 添加 WhatsApp 渠道（QR/配对码） | `/add-whatsapp` |
| add-telegram | 添加 Telegram 渠道（控制/被动模式） | `/add-telegram` |
| add-slack | 添加 Slack 渠道（Socket Mode） | `/add-slack` |
| add-discord | 添加 Discord 渠道 | `/add-discord` |
| add-gmail | 添加 Gmail 集成（工具/渠道模式） | `/add-gmail` |
| add-telegram-swarm | Telegram 子代理池 | `/add-telegram-swarm` |

## 语音处理 [Bot]

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| add-voice-transcription | WhatsApp 语音转文字（OpenAI Whisper） | 发语音消息自动转文字 | OPENAI_API_KEY |
| use-local-whisper | 本地语音转文字（whisper.cpp，Apple Silicon） | 替代 OpenAI Whisper | 无 |

## 社交媒体 [Bot]

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| x-integration | X（Twitter）发推/点赞/回复/转推 | 对 Andy 说「发推 xxx」 |

## AI 工具

| Skill | 功能 | 使用方式 | 秘钥 |
|-------|------|---------|------|
| agent-tools | 通过 inference.sh CLI 运行 150+ AI 应用 | `infsh <model> <prompt>` | 各模型 API Key |
| ai-image-generation | AI 图像生成（FLUX、Gemini、Grok 等 50+ 模型） | 让 AI 生成图片 | 各模型 API Key |
| add-ollama-tool [Bot] | 接入本地 Ollama 模型 | MCP 工具调用 | 无 |
| add-parallel [Bot] | Parallel AI MCP 网络研究 | MCP 工具调用 | Parallel API Key |

## 编程开发

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| vercel-react-best-practices | React/Next.js 性能优化（Vercel 工程实践） | 写 React 代码时自动应用 |
| vercel-composition-patterns | React 组合模式：复合组件、render props | 重构组件时自动应用 |
| vercel-react-native-skills | React Native/Expo 移动端最佳实践 | 写 RN 代码时自动应用 |
| next-best-practices | Next.js 文件约定、RSC、数据模式 | 写 Next.js 代码时自动应用 |
| remotion-best-practices | Remotion 视频框架最佳实践 | 写 Remotion 代码时自动应用 |
| better-auth-best-practices | Better Auth 认证配置 | 配置认证时自动应用 |
| supabase-postgres-best-practices | PostgreSQL 性能优化 | 写 SQL 时自动应用 |
| building-native-ui | Expo Router 构建原生 UI | 写 Expo 代码时自动应用 |
| react-doctor | React 代码健康检查 | 完成功能后运行检查 |
| tailwind-design-system | Tailwind CSS v4 设计系统 | 构建组件库时自动应用 |
| mcp-builder | 构建 MCP 服务器 | 让 AI 创建 MCP 集成 |

## 设计和视觉

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| frontend-design | 生产级前端界面设计 | 让 AI 构建网页/组件 |
| ui-ux-pro-max | UI/UX 设计（50 风格、21 调色板、50 字体搭配） | 让 AI 设计界面 |
| canvas-design | 海报、视觉艺术（PNG/PDF） | 让 AI 创建视觉设计 |
| algorithmic-art | p5.js 算法艺术 | 让 AI 生成算法艺术 |
| web-design-guidelines | Web 界面规范审查 | 让 AI 审查 UI 代码 |
| brand-guidelines | Anthropic 品牌配色 | 应用品牌主题时自动应用 |
| theme-factory | 10 种预设主题 | 让 AI 应用主题到文档/网页 |
| web-artifacts-builder | 复杂多组件 HTML 制品 | 创建交互式网页应用 |
| slack-gif-creator | Slack 动画 GIF | 让 AI 创建 GIF |
| baoyu-cover-image | 文章封面图（9 色板 x 6 风格） | 让 AI 生成封面图 |
| baoyu-comic | 知识漫画创作 | 让 AI 画教育漫画 |
| baoyu-infographic | 信息图（21 布局 x 20 风格） | 让 AI 生成信息图 |

## 写作和营销

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| copywriting | 营销文案：首页、落地页、产品介绍 | 让 AI 写文案 |
| copy-editing | 编辑改善现有文案 | 让 AI 改文案 |
| content-strategy | 内容规划：选题、内容日历 | 让 AI 规划内容 |
| marketing-ideas | 营销创意发散 | 让 AI 出营销方案 |
| social-content | 社交媒体内容 | 让 AI 写社交帖子 |
| seo-audit | SEO 审计和排名诊断 | 让 AI 审计 SEO |
| internal-comms | 内部通信（报告、FAQ、事故报告） | 让 AI 写内部文档 |
| doc-coauthoring | 协作撰写文档/提案 | 让 AI 帮写文档 |
| reflection | 分析对话，提出改进建议 | 自动触发 |

## 文档处理

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| pdf | PDF 提取、创建、合并、拆分、表单 | 让 AI 处理 PDF |
| pptx | PowerPoint 创建和编辑 | 让 AI 做 PPT |
| docx | Word 文档创建、编辑、批注 | 让 AI 处理 Word |
| xlsx | Excel 创建、公式、数据分析 | 让 AI 处理 Excel |
| baoyu-url-to-markdown | 网页抓取转 Markdown | 给 URL 让 AI 转 Markdown |
| baoyu-markdown-to-html | Markdown 转微信兼容 HTML | 让 AI 转微信格式 |
| baoyu-format-markdown | Markdown 格式化排版 | 让 AI 美化 Markdown |

## 系统管理 [Bot]

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| setup | 初始安装：依赖、认证、服务配置 | `/setup` |
| customize | 自定义行为：添加渠道、改触发词 | `/customize` |
| debug | 排查容器、日志、环境变量问题 | `/debug` |
| find-skill | 列出和搜索已安装的 skills | 对 Andy 说「有哪些skill」 |
| update-nanoclaw | 拉取上游更新 | `/update-nanoclaw` |
| convert-to-apple-container | Docker 切换到 Apple Container | `/convert-to-apple-container` |

## 代码审查 [Bot]

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| get-qodo-rules | 加载团队编码规则 | 代码任务前自动触发 |
| qodo-pr-resolver | AI PR 代码审查 | `/qodo-pr-resolver` |
| skill-vetter | 安全审查 skill（检测恶意代码） | 安装 skill 前让 AI 审查 |
| skill-creator | 创建和编辑 skills | 让 AI 创建新 skill |

## Agent 架构

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| context-fundamentals | 上下文工程基础 | 设计 Agent 时参考 |
| context-compression | 上下文压缩和摘要 | 优化 token 使用时参考 |
| context-degradation | 诊断上下文退化 | Agent 出错时排查 |
| context-optimization | 上下文优化（KV 缓存、分区） | 优化性能时参考 |
| filesystem-context | 文件系统上下文管理 | 设计 Agent 记忆时参考 |
| memory-systems | Agent 记忆系统框架对比 | 选型 Agent 记忆时参考 |
| multi-agent-patterns | 多 Agent 模式（Supervisor/Swarm） | 设计多 Agent 时参考 |
| hosted-agents | 后台 Agent 和沙箱环境 | 部署 Agent 时参考 |
| evaluation | Agent 评估框架 | 测试 Agent 质量时参考 |
| advanced-evaluation | 高级评估（打分、偏差消除） | 精细评估时参考 |
| bdi-mental-states | BDI 架构（信念-愿望-意图） | 认知 Agent 研究时参考 |
| tool-design | Agent 工具设计 | 设计 MCP 工具时参考 |
| project-development | LLM 项目开发流程 | 启动 AI 项目时参考 |

## 工程实践

| Skill | 功能 | 使用方式 |
|-------|------|---------|
| brainstorming | 创意工作前的需求探索 | 做功能前自动触发 |
| writing-plans | 多步骤任务计划 | 复杂任务前自动触发 |
| executing-plans | 按计划执行（带审查点） | 执行计划时自动触发 |
| subagent-driven-development | 子 Agent 并行开发 | 多任务并行时使用 |
| dispatching-parallel-agents | 分派并行 Agent | 2+ 独立任务时使用 |
| test-driven-development | TDD（先测试后实现） | 写功能前使用 |
| systematic-debugging | 系统化调试 | 遇到 bug 时使用 |
| requesting-code-review | 提交代码审查 | 完成功能后使用 |
| receiving-code-review | 接收审查反馈 | 收到反馈时使用 |
| using-git-worktrees | Git Worktree 隔离开发 | 开分支时使用 |
| finishing-a-development-branch | 完成开发分支 | 合并/PR 时使用 |
| verification-before-completion | 完成前验证 | 提交前使用 |
| using-superpowers | 初始化 skills | 对话开始时自动触发 |
| writing-skills | 创建和编辑 skills | 写 skill 时使用 |
| template | 模板 skill | 占位 |

---

## 常见问题

### 怎么问 Andy 有哪些功能？

在 WhatsApp 中对 Andy 说：
- 「你能做什么」
- 「有哪些skill」
- 「帮助」

### 怎么安装新 skill？

```bash
# 搜索
npx skills find <关键词>

# 安装
npx skills add <owner/repo@skill-name> -g -y

# 重启让 Andy 也能用
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 秘钥放哪里？

所有秘钥放在项目根目录的 `.env` 文件中，容器启动时自动传入：

```
# 模型
OPENAI_API_KEY=xxx
OPENAI_BASE_URL=https://...

# 飞书
APPID=cli_xxx
APPSecret=xxx

# Tavily 搜索
TAVILY_API_KEY=xxx
```

新增秘钥只需加一行，不需要改代码。

### 怎么查看日志？

```bash
# NanoClaw 主日志
tail -50 logs/nanoclaw.log

# 机票监控日志
tail -20 logs/hnair-ticket-check.log
```
