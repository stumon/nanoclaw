<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw -- 您的专属 Claude 助手，在容器中安全运行。它轻巧易懂，并能根据您的个人需求灵活定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; &bull; &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; &bull; &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

通过 Claude Code，NanoClaw 可以动态重写自身代码，根据您的需求定制功能。

**新功能：** 首个支持 [Agent Swarms（智能体集群）](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。可轻松组建智能体团队，在您的聊天中高效协作。

## 我为什么创建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，但我无法安心使用一个我不了解却能访问我个人隐私的软件。OpenClaw 有近 50 万行代码、53 个配置文件和 70+ 个依赖项。其安全性是应用级别的（通过白名单、配对码实现），而非操作系统级别的隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个您能快速理解的代码库，为您提供了同样的核心功能。只有一个进程，少数几个文件。智能体（Agent）运行在具有文件系统隔离的真实 Linux 容器中，而不是依赖于权限检查。

## 快速开始

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
claude
```

然后运行 `/setup`。Claude Code 会处理一切：依赖安装、身份验证、容器设置、服务配置。

> **注意：** 以 `/` 开头的命令（如 `/setup`、`/add-whatsapp`）是 [Claude Code 技能](https://code.claude.com/docs/en/skills)。请在 `claude` CLI 提示符中输入，而非在普通终端中。

## 设计哲学

**小巧易懂：** 单一进程，少量源文件。无微服务、无消息队列、无复杂抽象层。让 Claude Code 引导您轻松上手。

**通过隔离保障安全:** 智能体运行在 Linux 容器（在 macOS 上是 Apple Container，或 Docker）中。它们只能看到被明确挂载的内容。即便通过 Bash 访问也十分安全，因为所有命令都在容器内执行，不会直接操作您的宿主机。

**为单一用户打造:** 这不是一个框架，是一个完全符合您个人需求的、可工作的软件。您可以 Fork 本项目，然后让 Claude Code 根据您的精确需求进行修改和适配。

**定制即代码修改:** 没有繁杂的配置文件。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生:** 无安装向导（由 Claude Code 指导安装）。无需监控仪表盘，直接询问 Claude 即可了解系统状况。无调试工具（描述问题，Claude 会修复它）。

**技能（Skills）优于功能（Features）:** 贡献者不应该向代码库添加新功能（例如支持 Telegram）。相反，他们应该贡献像 `/add-telegram` 这样的 [Claude Code 技能](https://code.claude.com/docs/en/skills)，这些技能可以改造您的 fork。最终，您得到的是只做您需要事情的整洁代码。

**最好的工具套件，最好的模型:** 本项目运行在 Claude Agent SDK 之上，这意味着您直接运行的就是 Claude Code。Claude Code 高度强大，其编码和问题解决能力使其能够修改和扩展 NanoClaw，为每个用户量身定制。

## 功能支持

- **多渠道消息** - 通过 WhatsApp、Telegram、Discord、Slack 或 Gmail 与您的助手对话。使用 `/add-whatsapp` 或 `/add-telegram` 等技能添加渠道，可同时运行一个或多个。
- **隔离的群组上下文** - 每个群组都拥有独立的 `CLAUDE.md` 记忆和隔离的文件系统。它们在各自的容器沙箱中运行，且仅挂载所需的文件系统。
- **主频道** - 您的私有频道（self-chat），用于管理控制；其他所有群组都完全隔离
- **计划任务** - 运行 Claude 的周期性作业，并可以给您回发消息
- **网络访问** - 搜索和抓取网页内容
- **容器隔离** - 智能体在 Apple Container (macOS) 或 Docker (macOS/Linux) 的沙箱中运行
- **智能体集群（Agent Swarms）** - 启动多个专业智能体团队，协作完成复杂任务（首个支持此功能的个人 AI 助手）
- **可选集成** - 通过技能添加 Gmail (`/add-gmail`) 等更多功能

## 使用方法

使用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每周一到周五早上9点，给我发一份销售渠道的概览（需要访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入，就更新它
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集关于 AI 发展的资讯，然后发给我一份简报
```

在主频道（您的self-chat）中，可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

没有需要学习的配置文件。直接告诉 Claude Code 您想要什么：

- "把触发词改成 @Bob"
- "记住以后回答要更简短直接"
- "当我说早上好的时候，加一个自定义的问候"
- "每周存储一次对话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要添加功能，而是添加技能。**

如果您想添加 Telegram 支持，不要创建一个 PR 同时添加 Telegram 和 WhatsApp。而是贡献一个技能文件 (`.claude/skills/add-telegram/SKILL.md`)，教 Claude Code 如何改造一个 NanoClaw 安装以使用 Telegram。

然后用户在自己的 fork 上运行 `/add-telegram`，就能得到只做他们需要事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

### RFS (技能征集)

我们希望看到的技能：

**通信渠道**
- `/add-signal` - 添加 Signal 作为渠道

**会话管理**
- `/clear` - 添加一个 `/clear` 命令，用于压缩会话（在同一会话中总结上下文，同时保留关键信息）。这需要研究如何通过 Claude Agent SDK 以编程方式触发压缩。

## 系统要求

- macOS 或 Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) 或 [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## 架构

```
渠道 --> SQLite --> 轮询循环 --> 容器 (Claude Agent SDK) --> 响应
```

单一 Node.js 进程。渠道通过技能添加，启动时自注册 -- 编排器连接具有凭据的渠道。智能体在具有文件系统隔离的 Linux 容器中执行。每个群组的消息队列带有并发控制。通过文件系统进行 IPC。

完整架构详情请见 [docs/SPEC.md](docs/SPEC.md)。

关键文件：
- `src/index.ts` - 编排器：状态管理、消息循环、智能体调用
- `src/channels/registry.ts` - 渠道注册表（启动时自注册）
- `src/ipc.ts` - IPC 监听与任务处理
- `src/router.ts` - 消息格式化与出站路由
- `src/group-queue.ts` - 带全局并发限制的群组队列
- `src/container-runner.ts` - 生成流式智能体容器
- `src/task-scheduler.ts` - 运行计划任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/CLAUDE.md` - 各群组的记忆

## FAQ

**为什么是 Docker？**

Docker 提供跨平台支持（macOS 和 Linux）和成熟的生态系统。在 macOS 上，您可以选择通过运行 `/convert-to-apple-container` 切换到 Apple Container，以获得更轻量级的原生运行时体验。

**我可以在 Linux 上运行吗？**

可以。Docker 是默认的容器运行时，在 macOS 和 Linux 上都可以使用。只需运行 `/setup`。

**这个项目安全吗？**

智能体在容器中运行，而不是在应用级别的权限检查之后。它们只能访问被明确挂载的目录。您仍然应该审查您运行的代码，但这个代码库小到您真的可以做到。完整的安全模型请见 [docs/SECURITY.md](docs/SECURITY.md)。

NanoClaw 没有任何公网暴露的端口。WhatsApp/Telegram 等渠道使用出站连接（从本机连出去），不需要监听端口。API 代理仅监听在容器桥接网络接口 `192.168.64.1` 上，外部网络完全不可达。整个系统运行在你的本地机器上，不对外提供任何服务。

**为什么没有配置文件？**

我们不希望配置泛滥。每个用户都应该定制它，让代码完全符合他们的需求，而不是去配置一个通用的系统。如果您喜欢用配置文件，告诉 Claude 让它加上。

**我可以使用第三方或开源模型吗？**

可以。NanoClaw 支持任何 API 兼容的模型端点。在 `.env` 文件中设置以下环境变量：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

这使您能够使用：
- 通过 [Ollama](https://ollama.ai) 配合 API 代理运行的本地模型
- 托管在 [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai) 等平台上的开源模型
- 兼容 Anthropic API 格式的自定义模型部署

注意：为获得最佳兼容性，模型需支持 Anthropic API 格式。

**时区和日志时间用的是哪个时区？**

所有计划任务（cron、launchd StartCalendarInterval）、任务运行时间和日志轮转都使用**北京时间**（Asia/Shanghai）。在 `.env` 中设置 `TZ=Asia/Shanghai` 或在 launchd plist 中配置；`TZ` 未设置时，代码默认使用 `Asia/Shanghai`。

**如何调试问题？**

问 Claude Code。"为什么计划任务没有运行？" "最近的日志里有什么？" "为什么这条消息没有得到回应？" 这就是 AI 原生的方法。

也可以直接检查容器：

```bash
container ls                            # 列出运行中的容器
container exec -it <container-id> bash  # 进入一个运行中的容器
container logs <container-id>           # 查看容器日志
```

**为什么我的安装不成功？**

如果遇到问题，安装过程中 Claude 会尝试动态修复。如果问题仍然存在，运行 `claude`，然后运行 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请开一个 PR 来修改 setup SKILL.md。

**容器无法访问外网（Apple Container 网络限制）？**

Apple Container 的 NAT 只允许容器访问宿主机网关 `192.168.64.1`，无法直接连接公网。

NanoClaw 提供了**通用解决方案**，无需为每个工具逐一适配：

1. **正向代理**（`src/forward-proxy.ts`）：监听在 `192.168.64.1:8463`，支持 HTTP 转发和 HTTPS CONNECT 隧道。容器启动时自动设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量指向它。所有遵循标准代理协议的工具（curl、fetch、apt-get、pip、npm、Python requests 等）都会自动通过宿主机上网，无需任何额外配置。
2. **反向代理**（`src/api-proxy.ts`）：监听在 `192.168.64.1:8462`，用于特定 API 路由（LLM API、Tavily 搜索、URL 抓取等）。`container-runner.ts` 自动将 `OPENAI_BASE_URL` 重写为代理地址。

构建容器镜像时，`container/build.sh` 也会自动传递代理参数，确保 `apt-get update` / `pip install` 等构建步骤能正常访问网络。

**LLM API 需要 VPN，但容器无法使用宿主机 VPN？**

容器运行在隔离的 Linux VM 中，无法访问宿主机的 VPN 路由。如果您的 LLM API（如 `compass.llm.shopee.io`）需要 VPN，容器无法直连。

同一个反向代理解决了此问题：在 `.env` 中设置 `OPENAI_BASE_URL` 为您的 VPN 端点。NanoClaw 会自动重写 URL 通过宿主机代理路由，而宿主机有 VPN 访问权限。容器无需直连。

**如何让群组中不需要 @Andy 就自动回复每条消息？**

每个群组有一个 `requiresTrigger` 标志。为 `true`（默认）时，助手仅在消息包含触发词时回复。为 `false` 时，助手会回复群组中的每条消息。

- **添加新群组时：** 在注册步骤中传入 `--no-trigger-required`：

  ```bash
  npx tsx setup/register.ts --channel whatsapp --jid 120363406615515477@g.us --name "我的群组" --folder whatsapp_main --trigger "@Andy" --no-trigger-required
  ```

- **已有群组修改：** 更新数据库。从日志中获取群组 JID（如 `chatJid` 字段），然后：

  ```bash
  sqlite3 store/messages.db "UPDATE registered_groups SET requires_trigger = 0 WHERE jid = 'YOUR_GROUP_JID';"
  ```
  将 `YOUR_GROUP_JID` 替换为实际的群组 JID（如 `120363406615515477@g.us`）。

  重启 NanoClaw 使更改生效：
  ```bash
  # macOS
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw
  # Linux
  systemctl --user restart nanoclaw
  ```

**sender-allowlist.json 是什么，如何配置？**

该文件位于项目根目录：`sender-allowlist.json`。它控制**谁**可以在每个群组中触发助手（当 `requiresTrigger` 为 true 时）。键是**群组 JID**（如 `120363406615515477@g.us`），不是群组名称。JID 可在收到消息时的日志中找到（`chatJid` 字段）。

- `default`：应用于未在 `chats` 中列出的任何群组
- `chats.<jid>.allow`：`"*"` = 任何人都可触发；或者指定 WhatsApp 发送者 ID 数组，如 `["8613800138000@s.whatsapp.net"]`
- `chats.<jid>.mode`：`"trigger"` = 仅白名单内的发送者触发；`"drop"` = 忽略该群组的消息

示例（允许一个群组的所有人触发，限制另一个群组）：

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "120363406615515477@g.us": { "allow": "*", "mode": "trigger" },
    "999888777666@g.us": { "allow": ["8619860743536@s.whatsapp.net"], "mode": "trigger" }
  },
  "logDenied": true
}
```

如果该文件缺失或无效，则允许所有发送者。

**什么样的代码更改会被接受？**

安全修复、bug 修复，以及对基础配置的明确改进。仅此而已。

其他一切（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能来贡献。

这使得基础系统保持最小化，并让每个用户可以定制他们的安装，而无需继承他们不想要的功能。

## 社区

有任何疑问或建议？欢迎[加入 Discord 社区](https://discord.gg/VDdww8qS42)与我们交流。

## 更新日志

破坏性变更和迁移说明请见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT
