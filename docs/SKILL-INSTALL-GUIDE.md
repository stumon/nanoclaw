# Skills 安装指南

## Skills 架构

所有 skills 统一管理，Cursor 和 Andy 都能使用：

```
安装位置                          同步到容器
~/.claude/skills/ (全局)    -->  /home/node/.claude/skills/
~/.cursor/skills/ (Cursor)  -->  /home/node/.claude/skills/
项目/.claude/skills/ (Bot)  -->  /workspace/project/.claude/skills/
container/skills/ (工具)    -->  /home/node/.claude/skills/
```

容器启动时自动同步所有 skills。安装一次，Cursor 和 Andy 都能看到。

NanoClaw 项目内的 `.claude/skills/`（标记为 [Bot]）是 Andy 在 WhatsApp 中的专属能力，如发消息、查机票、更新资产等。

---

## 安装 Skill

### 搜索

```bash
npx skills find <关键词>
```

示例：

```bash
npx skills find skill-vetter
```

选择安装数最多的那个。

### 安装

```bash
npx skills add <owner/repo@skill-name> -g -y
```

参数说明：
- `owner/repo` = GitHub 仓库地址
- `@skill-name` = 仓库中的具体 skill 名称
- `-g` = 全局安装
- `-y` = 跳过确认

安装后重启 NanoClaw 即可让 Andy 也用上新 skill：

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 查看已安装

```bash
npx skills list -g
```

### 删除

```bash
npx skills remove <skill-name> -g
```

### 更新全部

```bash
npx skills update
```

### 批量安装示例

```bash
for skill in copywriting content-strategy marketing-ideas; do
  npx skills add "coreyhaines31/marketingskills@$skill" -g -y
done
```

---

## NanoClaw Bot Skills

NanoClaw 项目内的 Bot Skills 是 Andy 的专属能力（渠道管理、机票监控等），不从外部市场安装。

### 查看

```bash
ls .claude/skills/
```

### 激活

```bash
cd /Users/huanyu.guo/self/nanoclaw
npx tsx scripts/apply-skill.ts .claude/skills/<skill-name>
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 自定义

在 `.claude/skills/<skill-name>/SKILL.md` 中编写 Markdown 指令。

---

## 秘钥配置

所有秘钥统一维护在项目根目录的 `.env` 文件中，容器启动时自动传入。

```bash
# === 模型配置 ===
OPENAI_API_KEY=xxx
OPENAI_BASE_URL=https://...
MODEL_NAME=QwQ-32B

# === 飞书 ===
APPID=cli_xxx
APPSecret=xxx

# === Tavily Search ===
TAVILY_API_KEY=xxx

# === 其他 skill 需要的秘钥 ===
# WEATHER_API_KEY=xxx
```

新增秘钥只需在 `.env` 中加一行，不需要改代码。

---

## 完整示例：安装 skill-vetter

```bash
# 1. 搜索
npx skills find skill-vetter

# 2. 安装
npx skills add useai-pro/openclaw-skills-security@skill-vetter -g -y

# 3. 验证
npx skills list -g | grep skill-vetter

# 4. 重启让 Andy 也能用
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## 常用命令速查

| 操作 | 命令 |
|------|------|
| 搜索 skill | `npx skills find <关键词>` |
| 安装 skill | `npx skills add <owner/repo@name> -g -y` |
| 查看已安装 | `npx skills list -g` |
| 删除 skill | `npx skills remove <name> -g` |
| 更新全部 | `npx skills update` |
| 重启 Andy | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` |
| 问 Andy 有哪些 skill | WhatsApp 里说「你有哪些skill」 |

## Skills 来源

- 官方注册表：https://skills.sh
- GitHub 仓库直接安装：`npx skills add <owner/repo>`
- 社区推荐：小红书、知乎等分享的 skill 列表
