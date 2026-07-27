# NanoClaw 使用指南

## 项目简介

NanoClaw 是一个轻量级的个人 AI 助手，通过 WhatsApp/Telegram 等即时通讯渠道与用户交互。agent 运行在隔离的 Linux 容器中，确保安全性。

核心特点：
- 单进程架构，代码量小，易于理解和定制
- 容器级隔离（Docker / Apple Container），agent 无法直接操作宿主机
- 多渠道支持（WhatsApp、Telegram、Slack、Discord、Gmail）
- 多模型支持（兼容 OpenAI API 格式的任何模型）
- 定时任务、IPC 通信、技能扩展体系

## 架构概览

```
用户消息 (WhatsApp/Telegram/...)
    |
    v
宿主机 Node.js 进程
  |- 渠道层：接收/发送消息，存入 SQLite
  |- 消息循环：轮询 SQLite，匹配触发词
  |- 调度器：按 cron/interval/once 执行定时任务
  |- IPC Watcher：处理容器发来的 IPC 请求
    |
    v (spawn container)
Linux 容器 (Docker/Apple Container)
  |- Agent Runner：OpenAI 兼容的 agent 循环
  |- 内置工具：Bash, Read, Write, Edit, Glob, Grep, WebSearch, FetchURL
  |- MCP 工具：send_message, schedule_task, run_host_script 等
  |- 文件隔离：只能访问挂载的目录
```

关键文件：

| 文件 | 作用 |
|------|------|
| `src/index.ts` | 主编排器：消息循环、agent 调用 |
| `src/channels/registry.ts` | 渠道注册表 |
| `src/ipc.ts` | IPC 请求处理 |
| `src/container-runner.ts` | 容器启动与挂载管理 |
| `src/task-scheduler.ts` | 定时任务调度 |
| `src/db.ts` | SQLite 数据库操作 |
| `container/agent-runner/src/index.ts` | 容器内 agent 核心逻辑 |
| `groups/global/CLAUDE.md` | 全局 agent 指令 |
| `groups/{name}/CLAUDE.md` | 各群组独立记忆 |
| `.env` | 环境变量配置 |

## 安装与配置

### 前置条件

- macOS 或 Linux
- Node.js 20+
- Docker 或 Apple Container (macOS)
- Claude Code CLI（用于运行技能命令）

### 安装步骤

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
npm install
npm run build
```

### 配置 `.env`

```bash
# LLM API（支持任何 OpenAI 兼容端点）
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://your-api-endpoint/v1
MODEL_NAME=your-model-name

# 多角色（可选，格式: 名字:模型,名字:模型）
PERSONAS=Andy:model-a,Mark:model-b

# 视觉模型（可选，用于图片分析）
VISION_MODEL=your-vision-model

# 触发模式（true 表示 @Andy 可出现在消息任意位置）
TRIGGER_ANYWHERE=true

# 时区
TZ=Asia/Shanghai
```

### 添加消息渠道

在 Claude Code CLI 中运行对应技能：

```
/add-whatsapp    # 添加 WhatsApp
/add-telegram    # 添加 Telegram
/add-slack       # 添加 Slack
/add-discord     # 添加 Discord
/add-gmail       # 添加 Gmail
```

### 构建容器镜像

```bash
./container/build.sh
```

### 启动服务

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux (systemd)
systemctl --user start nanoclaw

# 开发模式（前台运行，带热重载）
npm run dev
```

## 日常使用

### 触发词

默认触发词为 `@Andy`。在群组中需要使用触发词，在主频道（self-chat）中可直接发消息。

```
@Andy 今天天气怎么样
@Andy 帮我搜一下最新的科技新闻
```

### 多 Persona 切换

通过 `PERSONAS` 环境变量配置多个角色，每个角色可使用不同模型：

```
PERSONAS=Andy:QwQ-32B,Mark:compass-max,Code:codecompass
```

使用时通过 `@角色名` 触发：

```
@Andy 帮我查个东西        # 使用 QwQ-32B
@Mark 写一篇分析报告      # 使用 compass-max
@Code 帮我重构这段代码     # 使用 codecompass
```

### 群组管理

在主频道中管理群组：

```
@Andy 列出所有群组
@Andy 加入"家庭聊天"群组
```

让群组不需要触发词自动回复（修改数据库）：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET requires_trigger = 0 WHERE jid = 'YOUR_GROUP_JID';"
```

### 定时任务

agent 可以创建和管理定时任务：

```
@Andy 每天早上9点给我发一份新闻简报
@Andy 列出所有定时任务
@Andy 暂停那个新闻任务
```

支持的调度类型：
- **cron**: 标准 cron 表达式，如 `0 9 * * *`（每天9点）
- **interval**: 毫秒间隔，如 `3600000`（每小时）
- **once**: 一次性执行，如 `2026-03-10T15:30:00`

## 已配置的 Skills

### 值班日报

触发词：发值班邮件、值班日报、发送值班邮件等

功能：从 Grafana 拉取各国监控数据，调 LLM 分析后发送 HTML 格式邮件。

使用：直接在 WhatsApp 发送"发值班邮件"即可。

配置：
- 收件人：`.env` 中的 `ON_DUTY_RECIPIENT`
- 每日自动发送：通过 launchd 定时任务（`com.nanoclaw.on-duty.plist`）

### 海航机票监控

功能：每小时检查海南航空特价机票，发现低价时通过 WhatsApp 通知。

配置：`scripts/hnair-ticket-check.ts` 中设置航线和价格阈值。

### 每日新闻简报

触发词：今日报纸、今日新闻、生成今日报纸

功能：抓取当日新闻，分类整理后发送英文和中文两份简报。

### 股票分析

触发词：分析 AAPL、帮我看看特斯拉、选股

功能：使用 5 种量化筛选框架（价值、成长、质量、做空、特殊情况）分析股票。

### 飞书资产更新

功能：将飞书文档中的持仓数据自动更新，支持视觉模型识别截图。

## 高级功能

### IPC 通信机制

容器内的 agent 通过 MCP 工具与宿主机通信：

| MCP 工具 | 用途 |
|----------|------|
| `send_message` | 发送消息到用户/群组 |
| `send_image` | 发送图片到用户/群组 |
| `schedule_task` | 创建定时任务 |
| `list_tasks` | 列出定时任务 |
| `pause_task` / `resume_task` | 暂停/恢复任务 |
| `cancel_task` | 取消任务 |
| `run_host_script` | 触发宿主机执行脚本（仅主频道） |
| `register_group` | 注册新群组（仅主频道） |

### run_host_script

容器 agent 可以通过 `run_host_script` 触发宿主机执行 `scripts/` 目录下的脚本。用于需要宿主机资源（VPN、本地二进制、凭证等）的场景。

安全限制：
- 仅主频道可触发
- 脚本必须在 `scripts/` 目录内
- 只允许 `.ts` 后缀
- 禁止路径穿越

### 自动上下文压缩 (Compaction)

当对话历史超过约 60000 tokens 时，系统自动：
1. 调用 LLM 将早期历史压缩为摘要
2. 保留最近 20% 的原始消息
3. 压缩摘要 + 近期消息组成新的上下文

这确保长对话不会因为超出 context window 而丢失关键信息。

### Session 持久化

每次查询结束后，对话历史自动保存到 `/workspace/group/.session_history.json`。容器重启后会自动恢复之前的对话上下文。

### Agent Teams（子 agent 并行协作）

主 agent 可以通过 `Task` 工具启动多个子 agent 并行处理任务。每个子 agent 拥有独立的对话历史和上下文，共享所有工具（Bash、Read、Write、WebSearch 等），但不能再启动子 agent（防止无限递归）。

同一轮中的多个 Task 调用通过 `Promise.all` 并行执行，结果汇总后返回主 agent。

## 自实现功能对照表（vs Claude Code SDK）

由于本项目使用 OpenAI 兼容 API 而非 Claude Code SDK，以下功能为自行实现。

| 功能 | Claude Code SDK 原生行为 | 自实现方案 | 当前限制 |
|------|--------------------------|-----------|----------|
| Agent Loop | 递归式 `EZ()` 循环，内置重试、fallback、budget 控制（`maxBudgetUsd`、`maxTurns`、`maxThinkingTokens`） | `runAgentLoop()` 迭代循环，`MAX_TOOL_ITERATIONS = 50`，OpenAI Chat Completions API | 无 budget 控制，无 thinking tokens 限制 |
| Auto Compaction | 内置压缩，通过 `compact_boundary` 事件通知，精确 token 计数 | `compactHistory()` 函数，约 60000 tokens 触发，LLM 摘要 + 保留 20% 近期消息 | token 估算基于字符数（chars/4），不如 SDK 精确 |
| Session Persistence | `resume` / `resumeSessionAt` 参数 + `data/sessions/` 目录下的 transcript 文件，支持多 session 管理 | 每次查询后保存到 `.session_history.json`，启动时加载 | 无 session ID 管理，无多 session 切换 |
| Task / Sub-Agent | 进程级隔离，支持同步等待、后台异步（fire-and-forget）、Agent Teams（多人协作+轮询）三种模式 | 函数级隔离（递归 `runAgentLoop`），仅支持并行等待模式（`Promise.all`） | 无后台模式，无 agent 间通信（Teams），递归深度固定一层 |
| Hooks | PreToolUse、PostToolUse、SessionStart、PreCompact、SubagentStart/Stop 等丰富的钩子系统 | 未实现 | 无法在工具执行前后注入自定义逻辑 |
| Structured Output | `outputFormat` 支持 JSON Schema，agent 可返回结构化数据 | 未实现 | agent 只能返回纯文本 |

### 各功能实现细节

**Agent Loop**：核心循环位于 `container/agent-runner/src/index.ts` 的 `runAgentLoop()` 函数。使用 `openai` npm 包调用 Chat Completions API，每轮解析 `tool_calls`，执行后将结果推入 messages 继续循环，直到模型不再返回 tool_calls 或达到 50 次迭代上限。

**Auto Compaction**：`compactHistory()` 函数在每次查询前检查 token 估算值。超过阈值时，将早期消息发送给 LLM 生成摘要，替换原始消息，仅保留最近 20% 的完整消息。

**Session Persistence**：`saveSessionHistory()` 在每次查询结束后将 `conversationHistory` 序列化为 JSON 写入群组目录。`loadSessionHistory()` 在容器启动时读取并恢复。多模态内容（图片）在序列化时提取文本部分。

**Task / Sub-Agent**：当模型返回的 tool_calls 中包含 `Task` 调用时，系统将其与普通工具调用分开处理。普通工具顺序执行，Task 调用通过 `Promise.all` 并行执行。每个 Task 启动一个新的 `runAgentLoop`，使用简化的 system prompt，工具列表中移除 `Task`（防递归）。

## 代理网络架构

容器无法直接访问外网，NanoClaw 提供两个代理：

- **正向代理** (`192.168.64.1:8463`)：HTTP/HTTPS 通用代理，容器启动时自动设置 `HTTP_PROXY`/`HTTPS_PROXY`
- **反向代理** (`192.168.64.1:8462`)：LLM API 路由，自动重写 `OPENAI_BASE_URL` 通过宿主机

## 服务管理

```bash
# macOS 重启
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# macOS 停止
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux 重启
systemctl --user restart nanoclaw

# 查看运行中的容器
container ls

# 进入容器调试
container exec -it <container-id> bash

# 编译项目
npm run build

# 重建容器镜像
./container/build.sh
```

## FAQ 与故障排查

### agent 不回复消息

1. 检查服务是否在运行：查看最新日志 `logs/nanoclaw.*.log`
2. 确认触发词是否正确（默认 `@Andy`）
3. 主频道（self-chat）不需要触发词

### 容器内工具报错

容器无法直接访问宿主机网络和文件。如果工具需要：
- **外网访问**：通过正向代理自动处理（curl、npm、pip 等）
- **VPN 资源**：使用 `run_host_script` 让宿主机执行
- **宿主机文件**：在 `container-runner.ts` 中添加挂载

### 定时任务不执行

```bash
# 查看任务列表
sqlite3 store/messages.db "SELECT id, prompt, schedule_type, schedule_value, next_run, status FROM scheduled_tasks;"
```

确认 `status` 为 `active`，`next_run` 时间合理。

### 修改 `.env` 后是否需要重启

- 宿主机脚本（`scripts/*.ts`）：直接读取 `.env`，无需重启
- 容器 agent：每次启动新容器会重新加载，无需重启
- 主进程配置（`PERSONAS`、`TRIGGER_ANYWHERE` 等）：需要重启

### 日志在哪里

| 日志 | 位置 |
|------|------|
| 主进程 | `logs/nanoclaw.*.log` |
| 容器 agent | `groups/{name}/logs/container-*.log` |
| 值班日报 | `logs/on-duty-*.log` |
| 机票监控 | `logs/hnair-ticket-check.log` |
| 新闻简报 | `logs/news-summary-stdout.log` |

### 如何添加新的宿主机脚本

1. 在 `scripts/` 目录下创建 `.ts` 文件
2. 在 `groups/global/CLAUDE.md` 中添加触发指令
3. 使用 `mcp__nanoclaw__run_host_script({ script_name: "your-script.ts" })` 触发
