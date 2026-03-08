# NanoClaw Compass 版使用说明

本项目基于 NanoClaw 改造，将 LLM 后端从 Claude API 切换为 Shopee Compass API（OpenAI 兼容格式），容器运行时使用 Apple Container（macOS 原生）。

## 使用方式（重要）

NanoClaw 是一个聊天机器人服务。你不需要在终端里和它对话，而是通过聊天渠道（WhatsApp、Telegram 等）发消息。

**整体流程：**

```
步骤 1：NanoClaw 以 launchd 服务方式常驻后台，无需打开终端
  （开机自动启动，关机自动停止，不依赖任何终端窗口）

步骤 2：在 WhatsApp/Telegram 群里 @Agent 发消息
  例如："@Agent 帮我写一个 Python 脚本计算斐波那契数列"

步骤 3：Agent 自动在容器里执行任务，然后在群里回复你
```

## 服务管理（launchd）

NanoClaw 以 macOS launchd 系统服务方式运行，plist 位于 `~/Library/LaunchAgents/com.nanoclaw.plist`，运行 **生产构建**（`dist/index.js`）。

**日常操作命令：**

```bash
# 查看服务状态（PID 列有数字 = 正在运行）
launchctl list | grep com.nanoclaw

# 重启服务（代码更新后必须执行）
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 启动服务
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# 查看实时日志
tail -f /Users/huanyu.guo/self/nanoclaw/logs/nanoclaw.log

# 查看错误日志
tail -f /Users/huanyu.guo/self/nanoclaw/logs/nanoclaw.error.log
```

**修改代码后的完整更新流程：**

```bash
cd /Users/huanyu.guo/self/nanoclaw

# 1. 编译新代码
npm run build

# 2. 重启服务让新代码生效
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 3. 确认服务已重新起来（看到 PID 有数字）
launchctl list | grep com.nanoclaw
```

**如果只需要重建容器（Agent 镜像）：**

```bash
cd /Users/huanyu.guo/self/nanoclaw
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**终端里只在需要时执行这些操作：**
- `npm run build` - 编译 TypeScript 代码
- `./container/build.sh` - 重建 Agent 容器镜像
- `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` - 重启服务

**不要在终端里输入中文消息！** 文档下面的"在聊天群里说"示例都是你在 WhatsApp/Telegram 聊天群中发送的消息，不是终端命令。

## 容器网络修复（睡眠唤醒后）

Apple Container 依赖宿主机的 IP 转发和 NAT 规则才能访问外网。电脑睡眠/合盖后这些规则可能丢失，导致 Andy 回复 `Error calling LLM API: Connection error`。

**手动修复（立即生效）：**

```bash
cd /Users/huanyu.guo/self/nanoclaw
sudo ./scripts/fix-container-network.sh
```

脚本做了两件事：`sysctl -w net.inet.ip.forwarding=1` 和重新配置 `pfctl` NAT 规则。

**安装自动修复（一次性，之后每次唤醒自动执行）：**

```bash
# 复制 plist 到系统目录（需要 sudo）
sudo cp /Users/huanyu.guo/self/nanoclaw/scripts/com.nanoclaw.network-fix.plist /Library/LaunchDaemons/

# 加载
sudo launchctl load /Library/LaunchDaemons/com.nanoclaw.network-fix.plist
```

安装后，macOS 会在网络变化时（包括睡眠唤醒、WiFi 切换）自动执行修复脚本。

**验证网络是否正常：**

```bash
# 检查 IP 转发是否开启（期望值为 1）
sysctl net.inet.ip.forwarding

# 测试容器是否能访问外网
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 期望输出: 404（表示网络通了，只是没有有效请求）
```

**卸载自动修复：**

```bash
sudo launchctl unload /Library/LaunchDaemons/com.nanoclaw.network-fix.plist
sudo rm /Library/LaunchDaemons/com.nanoclaw.network-fix.plist
```

## 容器镜像重建

修改了 `container/` 目录下的文件（Dockerfile、agent-runner 等）后，需要重建容器镜像。

**所有命令必须在项目根目录下执行：**

```bash
cd /Users/huanyu.guo/self/nanoclaw

# 重建容器镜像
./container/build.sh

# 重启 NanoClaw 使新镜像生效
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 查看日志

日志文件路径：

| 文件 | 内容 |
|------|------|
| `~/self/nanoclaw/logs/nanoclaw.log` | 主日志（消息收发、容器启停、Agent 输出） |
| `~/self/nanoclaw/logs/nanoclaw.error.log` | 仅错误日志 |
| `~/self/nanoclaw/groups/whatsapp_main/logs/` | 每次容器运行的详细日志 |

常用命令（在终端执行）：

```bash
# 实时监控全部日志
tail -f ~/self/nanoclaw/logs/nanoclaw.log

# 只看收到的消息
grep "Incoming message" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 只看 Andy 回复的内容
grep "Agent output" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 只看错误
grep "ERROR" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 看容器启动和挂载信息
grep -E "Spawning|Mount allowlist|Mount validated|REJECTED" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 看图片处理流程（视觉模型预处理）
grep -E "image saved|Preprocessing|Vision analysis" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 看 LLM API 调用和网络问题
grep -E "proxy|Connection error|LLM API" ~/self/nanoclaw/logs/nanoclaw.log | tail -20

# 查看最近一次容器的完整运行日志
ls -lt ~/self/nanoclaw/groups/whatsapp_main/logs/ | head -5
# 然后 cat 最新的文件，例如：
# cat ~/self/nanoclaw/groups/whatsapp_main/logs/container-2026-03-07T06-28-39-587Z.log

# 实时监控（结合多个关键词）
tail -f ~/self/nanoclaw/logs/nanoclaw.log | grep -E "Incoming|Agent output|ERROR|image saved"
```

日志字段说明：
- `chatJid` - 聊天 ID
- `sender` - 发送者
- `content` - 消息内容（前200字符）
- `fromMe` - 是否是自己发的消息
- `group` - 所属群组名称

## 架构

```
Host (NanoClaw 主进程)
  |
  |-- 读取 .env 中的 secrets
  |-- 通过 stdin JSON 传入容器
  v
Apple Container (nanoclaw-agent:latest)
  |
  |-- agent-runner (OpenAI SDK)
  |     |-- 调用 Compass API (/v1/chat/completions)
  |     |-- 执行 tool calling 循环
  |     |-- MCP server (NanoClaw IPC 工具)
  |
  |-- 通过 stdout 返回结果 (OUTPUT_MARKER 协议)
```

## 执行目录

Agent 运行在一个隔离的 Linux 容器中，目录结构如下：

| 容器内路径 | 对应 Host 路径 | 权限 | 说明 |
|------------|---------------|------|------|
| `/workspace/group/` | `groups/{群组名}/` | 读写 | Agent 的工作目录（CWD），所有相对路径都基于此 |
| `/workspace/project/` | 项目根目录 | 只读 | 仅 main 群组可见，用于查看项目代码 |
| `/workspace/global/` | `groups/global/` | 只读 | 全局记忆目录，非 main 群组可读 |
| `/workspace/extra/` | 额外挂载目录 | 只读 | 通过配置挂载的附加目录 |
| `/workspace/ipc/` | `data/ipc/{群组名}/` | 读写 | IPC 通信目录（消息、任务） |
| `/home/node/.claude/` | `data/sessions/{群组名}/.claude/` | 读写 | 会话和设置存储 |

Host 端命令的执行目录：

| 命令 | 执行目录 |
|------|---------|
| `npm run dev` / `npm run build` | 项目根目录 `/Users/huanyu.guo/self/nanoclaw/` |
| `./container/build.sh` | 项目根目录（脚本内自动 cd 到 `container/`） |
| `container system start` | 任意目录均可 |

## 环境配置

在项目根目录的 `.env` 文件中配置：

```
OPENAI_API_KEY=你的Compass API Key
OPENAI_BASE_URL=https://compass.llm.shopee.io/compass-api/v1
MODEL_NAME=compass-max
```

可选的模型名（从 Compass API 获取的完整列表中选择）：

- `compass-max` - Compass 最强模型
- `compass-max-thinking` - 带思考链的版本
- `gpt-4o` / `gpt-4.1` - OpenAI 模型
- `claude-sonnet-4@20250514` - Anthropic 模型（通过 Compass 代理）
- `gemini-2.5-pro` - Google 模型
- 更多模型见 `https://compass.llm.shopee.io/compass-api/v1/models`

## 多 Agent 配置

NanoClaw 支持三种方式运行多个 Agent，按复杂度递增排列。

### 方式 A：Personas（同一个 Bot，多个身份/模型）

在同一个聊天中通过不同触发词使用不同的 LLM 模型。每个 persona 有独立的名字和模型。共享同一个群组目录和聊天上下文。

#### 配置

在 `.env` 中添加 `PERSONAS`：

```
PERSONAS=Andy:compass-max,Mark:QwQ-32B,Code:codecompass
```

格式：`名字:模型名,名字:模型名,...`

- 第一个 persona 为默认（用于自聊等不需要触发词的场景）
- 不配置 PERSONAS 时行为和原来完全一样（向后兼容）

#### 使用方式

在聊天群里说：
> @Andy 帮我写一份项目总结

Andy 使用 compass-max（最强模型）处理。

在聊天群里说：
> @Mark 分析一下这个问题的多种解法

Mark 使用 QwQ-32B（推理模型）处理。

在聊天群里说：
> @Code 写一个 Python 爬虫

Code 使用 codecompass（代码模型）处理。

#### 可用模型

| 模型名 | RPM | 适合场景 |
|--------|-----|---------|
| compass-max | 120 | 默认主力 |
| QwQ-32B | 30 | 推理/分析 |
| codecompass | 10 | 代码生成 |
| compass-v2 | 30 | 通用 |
| compass-vl | 5 | 多模态（图片） |
| Qwen2.5-32B-Instruct | 30 | 通用 |
| Qwen2.5-Coder-14B-Instruct | 30 | 代码 |
| compass | 10 | 轻量 |

#### 注意事项

- 自聊模式（不需要触发词）默认使用第一个 persona（Andy:compass-max）
- 每个 persona 共享同一个群组和工作目录，只是模型不同
- 修改 PERSONAS 后需要重启服务生效

#### 群聊里为什么没提醒我（触发词在结尾）

在**群聊**中，只有**消息开头**带 @Andy 才会触发 Agent。例如：
- 会触发：`@Andy 十分钟后提醒我`
- 不会触发：`十分钟后提醒我@Andy`（@ 在结尾）

自聊（给自己发消息）不需要触发词，所以两种写法都会处理。

如果希望群聊里「消息中任意位置出现 @Andy 也触发」，在 `.env` 中加一行：
```
TRIGGER_ANYWHERE=true
```
重启后，`十分钟后提醒我@Andy` 在群里也会被处理。

### 方式 B：多渠道（不同平台各自一个 Bot）

在 WhatsApp、Telegram、Slack、Discord 等多个平台上各运行一个独立 Bot。每个渠道有自己的群组注册、触发词和会话上下文。

安装渠道：

```bash
# 添加 Telegram
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram && npm run build

# 添加 Slack
npx tsx scripts/apply-skill.ts .claude/skills/add-slack && npm run build

# 添加 Discord
npx tsx scripts/apply-skill.ts .claude/skills/add-discord && npm run build
```

每个渠道的详细配置见本文后面的「聊天渠道配置」章节。

多渠道 + Personas 可以组合使用。例如 WhatsApp 上有 Andy 和 Mark，Telegram 上也有同样的两个 persona。

### 方式 C：Telegram Agent Swarm（子代理池）

在 Telegram 群组中创建多个 Bot 身份，主 Bot 接收消息后分派给子 Bot 执行，每个子 Bot 以自己的名义回复。适合需要多个 Agent 身份同时工作的场景。

前置条件：已安装 Telegram 渠道（方式 B）。

```bash
# 安装 Swarm 支持
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram-swarm && npm run build
```

Swarm 模式下：
- 主 Bot 负责接收和路由消息
- Pool Bot（子代理）各有独立的 Telegram Bot Token 和名称
- 每个子代理可以绑定不同的 LLM 模型
- 子代理以自己的 Bot 身份在群里发消息

### 三种方式对比

| 特性 | Personas | 多渠道 | Telegram Swarm |
|------|----------|--------|---------------|
| 同一聊天多身份 | Yes | No | Yes |
| 跨平台 | No | Yes | No（仅 Telegram） |
| 独立 Bot Token | No | Yes | Yes |
| 共享群组目录 | Yes | No | 部分共享 |
| 配置复杂度 | 低 | 中 | 高 |
| 适合场景 | 个人多模型切换 | 多平台覆盖 | 团队多代理协作 |

## 海南航空特价机票提醒（Skill）

每小时扫描海南航空深圳到乌鲁木齐 3 月、4 月特价，若出现 199 元则推送到 WhatsApp。**默认不打开浏览器**：优先用接口查询（需在官网抓包配置 `HNAIR_API_URL`）；未配置接口时可设 `HNAIR_USE_BROWSER=true` 使用无头浏览器（不会在电脑上弹出可见窗口）。

- 脚本：`scripts/hnair-ticket-check.ts`
- 依赖：`npm install playwright` 后执行 `npx playwright install chromium`
- 每小时运行：使用 `scripts/com.nanoclaw.hnair-hourly.plist` 配置 launchd（见 [.claude/skills/hnair-ticket-alert/SKILL.md](.claude/skills/hnair-ticket-alert/SKILL.md)）
- 环境变量：`HNAIR_IPC_CHAT_JID`、`HNAIR_TARGET_PRICE`、`HNAIR_NANOCLAW_DIR` 可选

## 可用功能

### 内置工具（6 个）

Agent 在容器内（工作目录 `/workspace/group/`）可以使用以下工具完成任务。

下面的"在聊天群里说"是你在 WhatsApp/Telegram 中 @Agent 发送的消息，不是终端命令。"Agent 调用"是 Agent 内部自动执行的，你看不到也不需要关心。

#### Bash - 执行 shell 命令

执行任意 shell 命令，超时 120 秒。工作目录为 `/workspace/group/`。

在聊天群里说：
> @Agent 帮我看看当前目录下有哪些文件

Agent 调用：
```json
{ "name": "Bash", "arguments": { "command": "ls -la" } }
```

在聊天群里说：
> @Agent 帮我安装 python3 的 requests 库

Agent 调用：
```json
{ "name": "Bash", "arguments": { "command": "pip3 install requests" } }
```

在聊天群里说：
> @Agent 用 git 看一下最近的提交记录

Agent 调用：
```json
{ "name": "Bash", "arguments": { "command": "git log --oneline -10" } }
```

#### Read - 读取文件

读取文件内容，支持指定起始行和行数。路径相对于 `/workspace/group/`。

在聊天群里说：
> @Agent 看一下 config.json 的内容

Agent 调用：
```json
{ "name": "Read", "arguments": { "path": "config.json" } }
```

在聊天群里说：
> @Agent 看一下 main.py 的前 20 行

Agent 调用：
```json
{ "name": "Read", "arguments": { "path": "main.py", "offset": 1, "limit": 20 } }
```

#### Write - 写入文件

创建或覆盖文件，自动创建父目录。路径相对于 `/workspace/group/`。

在聊天群里说：
> @Agent 帮我写一个 Python 的 Hello World 脚本

Agent 调用：
```json
{
  "name": "Write",
  "arguments": {
    "path": "hello.py",
    "content": "#!/usr/bin/env python3\nprint('Hello, World!')\n"
  }
}
```

在聊天群里说：
> @Agent 创建一个 data/output 目录并在里面写一个空的 README

Agent 调用：
```json
{
  "name": "Write",
  "arguments": {
    "path": "data/output/README.md",
    "content": "# Output\n\n此目录存放输出数据。\n"
  }
}
```

#### Edit - 精确编辑文件

在文件中找到一段精确匹配的文本并替换为新内容。适合小改动，不需要重写整个文件。

在聊天群里说：
> @Agent 把 config.json 里的 port 从 3000 改成 8080

Agent 调用：
```json
{
  "name": "Edit",
  "arguments": {
    "path": "config.json",
    "old_string": "\"port\": 3000",
    "new_string": "\"port\": 8080"
  }
}
```

#### Glob - 搜索文件名

按模式搜索文件名，返回匹配的文件路径列表。

在聊天群里说：
> @Agent 帮我找一下项目里所有的 TypeScript 文件

Agent 调用：
```json
{ "name": "Glob", "arguments": { "pattern": "*.ts" } }
```

在聊天群里说：
> @Agent 看看 src 目录下有没有 JSON 配置文件

Agent 调用：
```json
{ "name": "Glob", "arguments": { "pattern": "*.json", "cwd": "src" } }
```

#### Grep - 搜索文件内容

用正则表达式搜索文件内容，返回匹配的行和文件路径。

在聊天群里说：
> @Agent 帮我找一下代码里哪里用到了 TODO

Agent 调用：
```json
{ "name": "Grep", "arguments": { "pattern": "TODO", "include": "*.py" } }
```

在聊天群里说：
> @Agent 在 src 目录下搜索所有包含 "import requests" 的文件

Agent 调用：
```json
{ "name": "Grep", "arguments": { "pattern": "import requests", "path": "src" } }
```

---

### MCP 工具（7 个）

通过 NanoClaw IPC 协议与 Host 通信的工具。这些工具用于和外部系统交互（发消息、管理任务等）。

#### send_message - 发送即时消息

Agent 运行期间随时可以给用户或群组发消息。适合进度更新或需要发送多条消息的场景。

在聊天群里说：
> @Agent 帮我跑一下测试，跑完告诉我结果

Agent 先发一条消息：
```json
{
  "name": "mcp__nanoclaw__send_message",
  "arguments": { "text": "正在运行测试，请稍等..." }
}
```

然后执行测试，完成后再发一条：
```json
{
  "name": "mcp__nanoclaw__send_message",
  "arguments": { "text": "测试完成！共 42 个用例，全部通过。" }
}
```

#### schedule_task - 创建定时任务

支持三种调度方式：cron 表达式、固定间隔、一次性执行。时间均为本地时区。

在聊天群里说：
> @Agent 每天早上 9 点给我发天气预报

Agent 调用：
```json
{
  "name": "mcp__nanoclaw__schedule_task",
  "arguments": {
    "prompt": "查询今天的天气预报，用 send_message 发送给用户。格式简洁，包含温度和天气状况。",
    "schedule_type": "cron",
    "schedule_value": "0 9 * * *",
    "context_mode": "isolated"
  }
}
```

在聊天群里说：
> @Agent 5 分钟后提醒我开会

Agent 调用：
```json
{
  "name": "mcp__nanoclaw__schedule_task",
  "arguments": {
    "prompt": "用 send_message 提醒用户：该开会了！",
    "schedule_type": "once",
    "schedule_value": "2026-03-06T15:30:00",
    "context_mode": "isolated"
  }
}
```

在聊天群里说：
> @Agent 每隔 1 小时检查一次服务器状态

Agent 调用：
```json
{
  "name": "mcp__nanoclaw__schedule_task",
  "arguments": {
    "prompt": "执行 curl http://localhost:8080/health 检查服务器状态，如果返回非 200 就用 send_message 通知用户。",
    "schedule_type": "interval",
    "schedule_value": "3600000",
    "context_mode": "isolated"
  }
}
```

#### list_tasks - 列出定时任务

查看当前所有已安排的定时任务。

在聊天群里说：
> @Agent 看看我有哪些定时任务

Agent 调用：
```json
{ "name": "mcp__nanoclaw__list_tasks", "arguments": {} }
```

返回示例：
```
Scheduled tasks:
- [abc123] 查询天气预报... (cron: 0 9 * * *) - active, next: 2026-03-07T09:00:00
- [def456] 检查服务器状态... (interval: 3600000) - active, next: 2026-03-06T17:00:00
```

#### pause_task - 暂停定时任务

暂停一个正在运行的定时任务，不删除。

在聊天群里说：
> @Agent 暂停那个天气预报的任务

Agent 调用：
```json
{ "name": "mcp__nanoclaw__pause_task", "arguments": { "task_id": "abc123" } }
```

#### resume_task - 恢复定时任务

恢复一个被暂停的任务。

在聊天群里说：
> @Agent 把天气预报恢复

Agent 调用：
```json
{ "name": "mcp__nanoclaw__resume_task", "arguments": { "task_id": "abc123" } }
```

#### cancel_task - 取消定时任务

永久删除一个定时任务。

在聊天群里说：
> @Agent 那个服务器检查不需要了，删掉吧

Agent 调用：
```json
{ "name": "mcp__nanoclaw__cancel_task", "arguments": { "task_id": "def456" } }
```

#### register_group - 注册新群组

仅 main 群组可用。将一个新的聊天群组注册到 NanoClaw，使 agent 可以响应该群组的消息。

在 main 群组的聊天里说：
> @Agent 把我的家庭群也加上，群组 ID 是 120363336345536173@g.us

Agent 调用：
```json
{
  "name": "mcp__nanoclaw__register_group",
  "arguments": {
    "jid": "120363336345536173@g.us",
    "name": "家庭群",
    "folder": "whatsapp_family",
    "trigger": "@Andy"
  }
}
```

---

### 系统功能示例

#### CLAUDE.md 记忆

每个群组的工作目录下可以放一个 `CLAUDE.md` 文件，Agent 启动时会自动读取作为系统提示的一部分。

示例：在 `groups/whatsapp_family/CLAUDE.md` 中写入：

```markdown
# 家庭群设置

- 用中文回复
- 语气亲切友好
- 家庭成员：爸爸、妈妈、弟弟
- 爸爸喜欢钓鱼，妈妈喜欢做菜
- 弟弟在读高中，经常问数学题
```

Agent 每次启动时都会读取这些信息，从而记住群组的偏好设置。

#### 多轮对话

在一次容器生命周期内，Agent 会记住之前的对话内容：

```
你在群里说: @Agent 帮我写一个 Python 函数，计算斐波那契数列
Agent 回复: (写了一个 fib.py)

你在群里说: @Agent 加一个缓存优化
Agent 回复: (记得之前写的代码，直接在 fib.py 上用 Edit 工具加了 @lru_cache)

你在群里说: @Agent 跑一下看看结果对不对
Agent 回复: (用 Bash 执行 python3 fib.py，返回结果)
```

#### IPC 后续消息

容器运行期间，Host 可以将新的用户消息通过 IPC 文件推送给正在运行的 Agent。Agent 不需要重启就能接收并处理后续消息。这使得连续对话成为可能。

---

## 常用命令

### 构建

```bash
# 编译 Host 端 TypeScript
npm run build

# 构建容器镜像（使用 Apple Container）
./container/build.sh

# 如果镜像构建出问题，清除缓存重建
container builder stop && container builder rm && container builder start
./container/build.sh
```

### 运行

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run start
```

### 容器运行时管理

```bash
# 检查 Apple Container 状态
container system status

# 启动 Apple Container
container system start

# 停止 Apple Container
container system stop
```

### 快速测试

```bash
# 直接测试容器（不经过 Host），在项目根目录执行
echo '{"prompt":"你好，请列出当前目录的文件","groupFolder":"test","chatJid":"test@g.us","isMain":false,"secrets":{"OPENAI_API_KEY":"你的key","OPENAI_BASE_URL":"https://compass.llm.shopee.io/compass-api/v1","MODEL_NAME":"compass-max"}}' | container run -i --rm nanoclaw-agent:latest

# 测试工具调用：让 Agent 创建一个文件
echo '{"prompt":"创建一个文件 hello.txt，内容为 Hello NanoClaw，然后读取确认","groupFolder":"test","chatJid":"test@g.us","isMain":false,"secrets":{"OPENAI_API_KEY":"你的key","OPENAI_BASE_URL":"https://compass.llm.shopee.io/compass-api/v1","MODEL_NAME":"compass-max"}}' | container run -i --rm nanoclaw-agent:latest

# 查看容器 stderr 日志（agent 运行日志输出在 stderr）
echo '{"prompt":"你好","groupFolder":"test","chatJid":"test@g.us","isMain":false,"secrets":{"OPENAI_API_KEY":"你的key","OPENAI_BASE_URL":"https://compass.llm.shopee.io/compass-api/v1","MODEL_NAME":"compass-max"}}' | container run -i --rm nanoclaw-agent:latest 2>agent.log
cat agent.log
```

---

## 聊天渠道配置

NanoClaw 通过聊天渠道和你交互。你需要至少配置一个渠道，Agent 才能收发消息。

**原理：** NanoClaw 作为一个客户端连接到聊天平台的服务器。和你在浏览器打开 WhatsApp Web 一样，NanoClaw 在电脑上"登录"了你的聊天平台，所以手机上发的消息，电脑也能收到。

**目前支持 5 个渠道：**

| 渠道 | 连接方式 | 需要的凭据 | 适合场景 |
|------|---------|-----------|---------|
| WhatsApp | 扫二维码关联为"已关联设备" | 无需 token，扫码即可 | 已有 WhatsApp |
| Telegram | 创建 Bot，拉入群聊 | Bot Token（从 @BotFather 获取） | 配置最简单 |
| Slack | 创建 Slack App，Socket Mode | Bot Token + App Token | 公司用 Slack |
| Discord | 创建 Bot，邀请进 Server | Bot Token（从 Developer Portal 获取） | 个人/社区 |
| Gmail | GCP OAuth 授权 | OAuth credentials.json | 邮件触发 |

### 安装渠道的通用步骤

所有渠道的安装都通过 skill 系统，在项目根目录执行：

```bash
# 1. 安装渠道代码和依赖
npx tsx scripts/apply-skill.ts .claude/skills/add-{渠道名}

# 2. 编译
npm run build

# 3. 重启服务
npm run dev  # 开发模式
```

---

### WhatsApp

**原理：** NanoClaw 使用 Baileys 库（非官方 WhatsApp Web API）连接 WhatsApp 服务器。效果等同于你在电脑上开了一个 WhatsApp Web，所以手机群里的消息电脑也能收到。

**第 1 步：安装 WhatsApp 渠道**

```bash
cd /Users/huanyu.guo/self/nanoclaw
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp
npm run build
```

**第 2 步：认证（扫二维码）**

推荐方式 -- 浏览器弹出二维码：

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

执行后浏览器会弹出一个二维码页面：
1. 打开手机 WhatsApp -> 设置 -> 已关联的设备 -> 关联设备
2. 扫描电脑浏览器上的二维码
3. 页面显示 "Authenticated!" 表示成功

备选方式 -- 配对码（无需摄像头）：

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone 你的手机号
```

手机号格式：国际区号+号码，不带加号，例如 `8613812345678`。终端会显示一个 8 位配对码，在手机上输入即可（60 秒内有效）。

**第 3 步：验证认证成功**

```bash
ls store/auth/creds.json
# 如果文件存在，说明认证成功
```

**第 4 步：注册聊天（告诉 NanoClaw 监听哪个对话）**

方式 A -- 自己和自己聊（推荐，最简单）：

```bash
# 获取你的 JID
node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0]+'@s.whatsapp.net')"

# 注册（把下面的 JID 替换成上一步输出的内容）
npx tsx setup/index.ts --step register \
  --jid "你的JID@s.whatsapp.net" \
  --name "self" \
  --trigger "@Andy" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "Andy" \
  --is-main \
  --no-trigger-required
```

方式 B -- 注册一个群聊：

```bash
# 列出你的所有群
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step groups --list

# 找到目标群的 JID（格式如 120363336345536173@g.us），然后注册
npx tsx setup/index.ts --step register \
  --jid "群的JID@g.us" \
  --name "我的群" \
  --trigger "@Andy" \
  --folder "whatsapp_mygroup" \
  --channel whatsapp
```

**第 5 步：启动并测试**

```bash
npm run dev
```

然后在手机 WhatsApp 上：
- 自聊模式：打开"给自己发消息"，直接发任何消息
- 群聊模式：在群里发 `@Andy 你好`

Agent 应该在几秒内回复。

**手机上如何 @ Agent：**
- 自聊模式不需要 @，直接发消息即可
- 群聊模式直接输入文字 `@Andy`（这不是 WhatsApp 的 @ 功能，而是文本匹配，只要消息里包含触发词就行）

**常见问题：**
- 二维码过期：60 秒内未扫描会过期，重新执行认证命令即可
- 配对码失败：码 60 秒过期，重新执行。确保手机号包含国际区号
- 冲突断连：同一个账号只能有一个 NanoClaw 实例运行，用 `pkill -f "node dist/index.js"` 杀掉多余进程

---

### Telegram

**原理：** 你在 Telegram 里创建一个 Bot，拿到 token 填入配置。然后把 Bot 拉入群聊，群里 @Bot 发消息就能触发 Agent。

**第 1 步：创建 Bot**

1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`，按提示操作：
   - Bot 名称：随便起，比如 "Andy Assistant"
   - Bot 用户名：必须以 bot 结尾，比如 `andy_ai_bot`
3. BotFather 会回复一个 token（格式如 `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`），复制保存

**第 2 步：安装 Telegram 渠道并配置**

```bash
cd /Users/huanyu.guo/self/nanoclaw

# 安装渠道代码
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram

# 在 .env 中添加 token
echo 'TELEGRAM_BOT_TOKEN=你的token' >> .env

# 同步到容器环境
mkdir -p data/env && cp .env data/env/env

# 编译
npm run build
```

**第 3 步：获取 Chat ID**

1. 在 Telegram 里搜索你刚创建的 Bot 用户名，打开对话
2. 发送 `/chatid`，Bot 会回复 Chat ID（格式如 `tg:123456789`）
3. 如果是群聊：先把 Bot 拉进群，然后在群里发 `/chatid`

**第 4 步：注册聊天**

在 `npm run dev` 运行后，通过 setup 脚本或数据库注册。

**第 5 步：启动并测试**

```bash
npm run dev
```

在 Telegram 里给 Bot 发消息或在群里 @Bot，Agent 应该回复。

**群聊注意事项：**
默认 Telegram Bot 在群里只能看到 @提及和命令。如果想让 Bot 看到所有消息：
1. 打开 Telegram，找到 @BotFather
2. 发送 `/mybots`，选择你的 Bot
3. Bot Settings -> Group Privacy -> Turn off

---

### Slack

**原理：** 创建一个 Slack App 并启用 Socket Mode（不需要公网 URL），NanoClaw 通过 WebSocket 连接 Slack 服务器接收消息。

**第 1 步：创建 Slack App**

1. 打开 https://api.slack.com/apps，点 Create New App
2. 选 "From scratch"，填名称和 Workspace
3. 左侧菜单 Socket Mode -> 开启，生成 App-Level Token（`xapp-...`），复制保存
4. 左侧菜单 Event Subscriptions -> 开启，添加 Bot Events：
   - `message.channels`、`message.groups`、`message.im`
5. 左侧菜单 OAuth and Permissions -> 添加 Scopes：
   - `chat:write`、`channels:history`、`groups:history`、`im:history`、`channels:read`、`groups:read`、`users:read`
6. 点 Install to Workspace，复制 Bot User OAuth Token（`xoxb-...`）

**第 2 步：安装 Slack 渠道并配置**

```bash
cd /Users/huanyu.guo/self/nanoclaw

npx tsx scripts/apply-skill.ts .claude/skills/add-slack

# 在 .env 中添加两个 token
echo 'SLACK_BOT_TOKEN=xoxb-你的token' >> .env
echo 'SLACK_APP_TOKEN=xapp-你的token' >> .env

mkdir -p data/env && cp .env data/env/env
npm run build
```

**第 3 步：获取 Channel ID**

1. 把 Bot 添加到目标频道（右键频道 -> View channel details -> Integrations -> Add apps）
2. 在浏览器打开频道，URL 格式为 `https://app.slack.com/client/T.../C0123456789`，`C...` 部分就是 Channel ID

NanoClaw 使用的 JID 格式：`slack:C0123456789`

**第 4 步：注册并测试**

```bash
npm run dev
```

在 Slack 频道发消息测试。

---

### Discord

**原理：** 在 Discord Developer Portal 创建 Bot，邀请进 Server，NanoClaw 通过 Discord Gateway 接收消息。

**第 1 步：创建 Bot**

1. 打开 https://discord.com/developers/applications，点 New Application
2. 左侧 Bot 标签 -> Reset Token -> 复制 token（只显示一次）
3. 开启 Privileged Gateway Intents：
   - Message Content Intent（必须）
   - Server Members Intent（可选）
4. 左侧 OAuth2 -> URL Generator：
   - Scopes 勾选 `bot`
   - Bot Permissions 勾选 `Send Messages`、`Read Message History`、`View Channels`
   - 复制生成的 URL，在浏览器打开邀请 Bot 进 Server

**第 2 步：安装 Discord 渠道并配置**

```bash
cd /Users/huanyu.guo/self/nanoclaw

npx tsx scripts/apply-skill.ts .claude/skills/add-discord

echo 'DISCORD_BOT_TOKEN=你的token' >> .env

mkdir -p data/env && cp .env data/env/env
npm run build
```

**第 3 步：获取 Channel ID**

1. Discord 设置 -> 高级 -> 开启开发者模式
2. 右键目标文字频道 -> 复制频道 ID

NanoClaw 使用的 JID 格式：`dc:1234567890123456`

**第 4 步：注册并测试**

```bash
npm run dev
```

在 Discord 频道 @Bot 发消息测试。

---

### Gmail

**原理：** 通过 Google OAuth 授权，NanoClaw 获取 Gmail 读写权限。可以配置为工具模式（Agent 被其他渠道触发后可以读写邮件）或频道模式（新邮件直接触发 Agent）。

**第 1 步：创建 GCP OAuth 凭据**

1. 打开 https://console.cloud.google.com，创建或选择项目
2. APIs and Services -> Library，搜索 "Gmail API"，点 Enable
3. APIs and Services -> Credentials -> + CREATE CREDENTIALS -> OAuth client ID
   - 如果提示配置同意屏幕：选 External，填应用名和邮箱，保存
   - Application type 选 Desktop app
4. 点 DOWNLOAD JSON，保存为 `gcp-oauth.keys.json`

**第 2 步：安装 Gmail 并配置**

```bash
cd /Users/huanyu.guo/self/nanoclaw

# 放置 OAuth 凭据
mkdir -p ~/.gmail-mcp
cp 你下载的路径/gcp-oauth.keys.json ~/.gmail-mcp/gcp-oauth.keys.json

# 安装渠道代码
npx tsx scripts/apply-skill.ts .claude/skills/add-gmail

# 执行 OAuth 授权（会弹出浏览器让你登录 Google 账号）
npx -y @gongrzhe/server-gmail-autoauth-mcp auth

npm run build
```

**第 3 步：测试**

```bash
npm run dev
```

在其他渠道（如 WhatsApp）对 Agent 说 `@Andy 看看我最近的邮件`。

---

## 与原版 NanoClaw 的差异

### 已替换

| 组件 | 原版 | 当前 |
|------|------|------|
| LLM API | Anthropic Messages API | OpenAI Chat Completions API |
| Agent SDK | @anthropic-ai/claude-agent-sdk | openai SDK + 自定义 agent loop |
| CLI | @anthropic-ai/claude-code | 不需要 |
| 容器运行时 | Docker | Apple Container |
| 模型 | Claude | compass-max（或其他 Compass 支持的模型） |

### 暂不支持

- WebSearch / WebFetch - 网页搜索和抓取工具
- Agent Teams / Swarm - 多 agent 协作
- Session resumption - 跨容器重启的会话恢复（当前用内存中滑动窗口）
- ToolSearch / Skill - 工具发现和技能系统
- NotebookEdit - Jupyter notebook 编辑
- 自动 compaction - 改为简单截断（保留最近 100 条消息）

### 改动的文件

| 文件 | 改动 |
|------|------|
| `src/container-runner.ts` | readSecrets() 新增 OPENAI 变量；buildContainerArgs 支持 Apple Container |
| `src/container-runtime.ts` | 替换为 Apple Container 实现 |
| `container/agent-runner/src/index.ts` | 完整重写，用 OpenAI SDK 实现 agent loop |
| `container/agent-runner/package.json` | 依赖从 claude-agent-sdk 换为 openai |
| `container/Dockerfile` | 移除 claude-code；Apple Container entrypoint |
| `container/build.sh` | 默认运行时改为 container |
| `.env` | Compass API 配置 |
