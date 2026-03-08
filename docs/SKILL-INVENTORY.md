# NanoClaw Skills 清单

最后更新：2026-03-08

所有 skills 统一管理，容器启动时自动同步，Cursor 和 Andy 都能使用。

标记 [Bot] 的是 Andy 在 WhatsApp 中的专属能力（渠道管理、机票监控等）。其余 skills 是通用能力（编程、设计、写作等），Andy 和 Cursor 都可调用。

---

## NanoClaw Bot Skills [Bot]

安装位置：项目/.claude/skills/

共 21 个。Andy 在 WhatsApp 对话中的专属技能。

### 渠道管理

| Skill | 用途 | 触发方式 |
|-------|------|---------|
| add-whatsapp | 添加 WhatsApp 渠道，QR 码或配对码认证 | `/add-whatsapp` |
| add-telegram | 添加 Telegram 渠道，支持控制/被动模式 | `/add-telegram` |
| add-slack | 添加 Slack 渠道，Socket Mode 无需公网 URL | `/add-slack` |
| add-discord | 添加 Discord 渠道，discord.js 集成 | `/add-discord` |
| add-gmail | 添加 Gmail 集成，支持工具模式或完整渠道 | `/add-gmail` |
| add-telegram-swarm | Telegram 子代理池，每个 bot 独立身份 | `/add-telegram-swarm` |

### 功能增强

| Skill | 用途 | 触发方式 |
|-------|------|---------|
| hnair-ticket-alert | 海南航空特价机票监控，每小时扫描，低价推送 WhatsApp | 聊天中说「查询机票信息」 |
| lark-asset-update | 发送券商截图更新飞书资产表，视觉识别持仓数据 | 聊天中说「更新资产」 |
| add-voice-transcription | WhatsApp 语音转文字（OpenAI Whisper API） | 发送语音消息自动触发 |
| use-local-whisper | 本地语音转文字（whisper.cpp，Apple Silicon） | 替代 OpenAI Whisper |
| add-ollama-tool | 接入本地 Ollama 模型，便宜/快速的摘要翻译 | MCP 工具调用 |
| add-parallel | 添加 Parallel AI MCP 高级网络研究 | MCP 工具调用 |
| x-integration | X（Twitter）发推/点赞/回复/转推 | 聊天中说「发推」「tweet」 |

### 系统管理

| Skill | 用途 | 触发方式 |
|-------|------|---------|
| setup | 初始安装：依赖、认证、服务配置 | `/setup` |
| customize | 自定义行为：添加渠道、改触发词、加集成 | `/customize` |
| debug | 排查容器、日志、环境变量、挂载问题 | `/debug` |
| find-skill | 列出和搜索已安装的 NanoClaw skills | 聊天中说「有哪些 skill」 |
| update-nanoclaw | 拉取上游 NanoClaw 更新到自定义安装 | `/update-nanoclaw` |
| convert-to-apple-container | 从 Docker 切换到 Apple Container | `/convert-to-apple-container` |
| get-qodo-rules | 加载团队编码规则用于代码审查 | 代码任务前自动触发 |
| qodo-pr-resolver | AI 代码审查，修复 PR 问题 | `/qodo-pr-resolver` |

---

## 通用 Skills（Andy 和 Cursor 都能用）

### ~/.claude/skills/（52 个）

通用能力，容器启动时自动同步给 Andy。

#### Agent 基础能力

| Skill | 用途 |
|-------|------|
| agent-tools | 通过 inference.sh CLI 运行 150+ AI 应用（图像/视频生成、LLM、搜索等） |
| skill-creator | 创建和编辑 Claude skills |
| mcp-builder | 构建 MCP 服务器，让 LLM 连接外部服务 |
| skill-vetter | 安全审查 skill，检测恶意代码和权限滥用 |
| tavily-search | Tavily AI 搜索 API，实时网络搜索 |
| weather | 通过 wttr.in 或 Open-Meteo 查天气预报 |
| gog | Google Workspace CLI（Gmail、Calendar、Drive、Sheets、Docs） |
| summarize | 从 URL、播客、本地文件中提取和总结文本 |

#### 写作和思考

| Skill | 用途 |
|-------|------|
| copywriting | 撰写营销文案：首页、落地页、产品介绍 |
| copy-editing | 编辑和改善现有营销文案 |
| content-strategy | 内容规划：选题、内容日历、话题集群 |
| marketing-ideas | 营销创意发散：SaaS 增长策略和灵感 |
| social-content | 社交媒体内容：LinkedIn、Twitter、Instagram |
| seo-audit | SEO 审计：技术 SEO、排名诊断、Core Web Vitals |
| audit-website | 网站全面体检：SEO、性能、安全等 230+ 规则 |
| reflection | 分析对话和工具使用，提出改进建议 |
| doc-coauthoring | 协作撰写文档、提案、技术规范 |
| internal-comms | 内部通信：状态报告、FAQ、事故报告 |

#### 设计和视觉

| Skill | 用途 |
|-------|------|
| web-design-guidelines | 审查 UI 代码是否符合 Web 界面规范 |
| frontend-design | 生产级前端界面，高设计质量 |
| ui-ux-pro-max | UI/UX 设计：50 种风格、21 调色板、50 字体搭配 |
| canvas-design | 创建海报、视觉艺术（PNG/PDF） |
| tailwind-design-system | Tailwind CSS v4 设计系统和组件库 |
| algorithmic-art | p5.js 算法艺术：流场、粒子系统 |
| ai-image-generation | AI 图像生成：FLUX、Gemini、Grok 等 50+ 模型 |
| baoyu-cover-image | 文章封面图生成：9 色板 x 6 渲染风格 |
| baoyu-comic | 知识漫画创作：多种画风和语调 |
| baoyu-infographic | 信息图生成：21 种布局 x 20 种视觉风格 |
| brand-guidelines | Anthropic 品牌配色和字体 |
| theme-factory | 10 种预设主题，可应用于幻灯片、文档、网页 |
| web-artifacts-builder | 复杂多组件 HTML 制品（React + Tailwind + shadcn） |
| slack-gif-creator | Slack 动画 GIF 创建 |

#### 编程和产品构建

| Skill | 用途 |
|-------|------|
| vercel-react-best-practices | React/Next.js 性能优化（Vercel 工程实践） |
| vercel-composition-patterns | React 组合模式：复合组件、render props |
| vercel-react-native-skills | React Native/Expo 移动端最佳实践 |
| next-best-practices | Next.js 文件约定、RSC、数据模式、元数据 |
| remotion-best-practices | Remotion 视频框架最佳实践 |
| better-auth-best-practices | Better Auth 认证配置和插件 |
| supabase-postgres-best-practices | Supabase + PostgreSQL 性能优化 |
| building-native-ui | Expo Router 构建原生 UI |
| browser-use | 浏览器自动化：测试、填表、截图、数据提取 |
| webapp-testing | Playwright 本地 Web 应用测试 |
| react-doctor | React 变更后检查问题 |

#### 办公文档

| Skill | 用途 |
|-------|------|
| pdf | PDF 提取、创建、合并、拆分、表单填写 |
| pptx | PowerPoint 创建和编辑 |
| docx | Word 文档创建、编辑、批注、修订 |
| xlsx | Excel 创建、公式、格式化、数据分析 |
| baoyu-url-to-markdown | 网页抓取转 Markdown |
| baoyu-markdown-to-html | Markdown 转微信兼容 HTML |
| baoyu-format-markdown | Markdown 格式化和排版 |
| just-scrape | AI 网页抓取、数据提取、搜索 |
| template | 模板 skill（占位） |

### ~/.cursor/skills/（27 个）

AI Agent 开发和工程实践，同样同步给 Andy。

#### Agent 架构

| Skill | 用途 |
|-------|------|
| context-fundamentals | 上下文工程基础：窗口、注意力、预算 |
| context-compression | 上下文压缩：摘要、token 优化 |
| context-degradation | 诊断上下文退化：丢失中间、注意力模式 |
| context-optimization | 上下文优化：KV 缓存、分区、容量扩展 |
| filesystem-context | 文件系统上下文管理：工具输出持久化 |
| memory-systems | Agent 记忆系统：Mem0、Zep、Letta 等框架对比 |
| multi-agent-patterns | 多 Agent 模式：Supervisor、Swarm、Handoff |
| hosted-agents | 后台 Agent：沙箱 VM、远程编码环境 |
| evaluation | Agent 评估：LLM-as-judge、质量门控 |
| advanced-evaluation | 高级评估：直接打分、成对比较、偏差消除 |
| bdi-mental-states | BDI 架构：信念-愿望-意图建模 |
| tool-design | Agent 工具设计：MCP 工具、命名约定 |
| project-development | LLM 项目开发：批处理管道、成本估算 |

#### 工程实践（Superpowers）

| Skill | 用途 |
|-------|------|
| brainstorming | 创意工作前的需求和设计探索 |
| writing-plans | 多步骤任务前的计划编写 |
| executing-plans | 按计划执行，带审查检查点 |
| subagent-driven-development | 子 Agent 驱动开发：并行独立任务 |
| dispatching-parallel-agents | 分派并行 Agent：2+ 独立任务 |
| test-driven-development | TDD：先写测试再写实现 |
| systematic-debugging | 系统化调试：在修复前诊断 |
| requesting-code-review | 提交代码审查 |
| receiving-code-review | 接收代码审查反馈 |
| using-git-worktrees | Git Worktree 隔离开发 |
| finishing-a-development-branch | 完成开发分支：合并/PR/清理 |
| verification-before-completion | 完成前验证：运行命令确认结果 |
| using-superpowers | 对话开始时初始化 skills |
| writing-skills | 创建和编辑 skills |

### ~/.cursor/skills-cursor/（5 个）

Cursor IDE 专用设置类。

| Skill | 用途 |
|-------|------|
| create-rule | 创建 Cursor 持久化 AI 规则 |
| create-skill | 创建 Agent Skill |
| create-subagent | 创建子 Agent |
| migrate-to-skills | 迁移到 skills 系统 |
| update-cursor-settings | 修改 Cursor/VSCode 设置 |

---

## 汇总

| 来源 | 数量 | Andy 可用 | Cursor 可用 |
|------|------|-----------|-------------|
| Bot Skills（项目/.claude/skills/） | 21 | 是 | 是 |
| 全局 Skills（~/.claude/skills/） | 52 | 是（自动同步） | 是 |
| Cursor Skills（~/.cursor/skills/） | 27 | 是（自动同步） | 是 |
| Cursor Settings（~/.cursor/skills-cursor/） | 5 | 否（IDE 专用） | 是 |
| **总计** | **105** | **100** | **105** |
