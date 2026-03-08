---
name: find-skill
description: List available skills and capabilities. Triggers on "有哪些skill", "你能做什么", "what can you do", "list skills", "find skill", "能做什么", "功能列表", "帮助".
---

# Find Skill

当用户问「你能做什么」「有哪些skill」「帮助」时，列出所有可用的 skills。

## 操作步骤

1. 运行 `ls /home/node/.claude/skills/` 获取所有 skill 目录名
2. 对每个 skill，运行 `head -5 /home/node/.claude/skills/<name>/SKILL.md` 读取 description 行
3. 按以下分类格式输出给用户

## 回复模板（用中文）

```
当前可用的功能（共 N 个 Skills）：

**财务管理**
- lark-asset-update: 截图更新飞书资产表
- xlsx: Excel 创建和分析

**出行助手**
- hnair-ticket-alert: 海南航空特价机票监控
- weather: 天气查询

**渠道管理**
- add-whatsapp / add-telegram / add-slack / add-discord / add-gmail

**即时查询**
- tavily-search: 联网搜索
- summarize: 网页/播客总结
- gog: Google Workspace（Gmail、日历、Drive）

**编程开发**
- mcp-builder / react-doctor / next-best-practices 等

**设计与写作**
- frontend-design / copywriting / canvas-design 等

**文档处理**
- pdf / pptx / docx / xlsx

**系统管理**
- setup / debug / customize / update-nanoclaw

需要了解某个功能的详情，告诉我名称即可。
```

分类原则：把用户最常用的功能（财务、出行、查询）放前面，技术类放后面。不需要列出全部 101 个，按类别列出代表性的即可，末尾加「等」。

## 查看某个 skill 详情

```bash
cat /home/node/.claude/skills/<skill-name>/SKILL.md
```

## 秘钥说明

如果某个 skill 需要 API Key，告诉用户在主机的 `.env` 文件中添加即可，容器启动时自动传入。
