# NanoClaw Changelog

## v1.3.2 - 2026-03-08

### Changed
- hnair-ticket-check.ts 完全重写：从查询特价推广列表改为查询**实际航班最低价**
  - 核心方案：Playwright 加载 m.hnair.com 移动端首页，截获内部签名的 lowFareTicket API，获取全日期最低价
  - 补充数据源：特价 API（国内+国际）、Tavily 搜索
  - 解决了之前"无数据"的根本问题：特价列表不等于实际航班价格
- 数据准确性：获取的是海航真实售票系统的价格，包含促销活动价格（如"周二幸运夜"¥199）

### Updated
- hnair-ticket-alert SKILL.md: 更新数据源说明为 Playwright 截获方案，详细解释工作原理

### Dependencies
- playwright (已在 package.json 中)
- Chromium 浏览器 (`npx playwright install chromium`)

## v1.3.1 - 2026-03-08

### Changed
- hnair-ticket-check.ts 重写：删除 200 行 Playwright 代码，改为三层数据源（gntjjp API 国内+国际、主页 HTML、Tavily 搜索）
- 无需 Playwright 依赖，纯 fetch 实现，代码从 450 行缩到 200 行

### Added
- docs/SKILLS.md: 101 个 skills 中文功能说明，按场景分类，含使用方式和秘钥要求

### Fixed
- hnair-ticket-alert SKILL.md: 更新为三层数据源说明，去掉 Playwright 前置条件

## v1.3.0 - 2026-03-08

### Changed
- Skills 目录统一：全部 101 个 skills 集中维护在项目 .claude/skills/ 下，删除 container/skills/ 目录
- container-runner.ts 简化：只从 .claude/skills/ 同步到容器，去掉 ~/.claude/skills/ 和 ~/.cursor/skills/ 多源同步
- .env 秘钥自动传递：新增秘钥只需加到 .env，不再需要改代码白名单

### Fixed
- find-skill SKILL.md 重写：去掉外部脚本依赖，直接指导 Andy 用 ls + head 列出 skills 并分类回复
- hnair-ticket-check.ts：gntjjp 接口不再预过滤价格，每次运行打印摘要日志（最低价+阈值+状态），仅低于阈值才通知 WhatsApp

## v1.2.9 - 2026-03-08

### Changed
- Skills 统一架构：容器启动时自动同步 ~/.claude/skills/ 和 ~/.cursor/skills/ 到容器内，Andy 和 Cursor 共享所有 100 个 skills
- .env 秘钥管理：去掉白名单限制，所有 .env 变量自动传入容器，新增秘钥只需加一行

### Updated
- docs/SKILL-INSTALL-GUIDE.md: 反映统一架构，安装一次两边都能用
- docs/SKILL-INVENTORY.md: 更新为统一视图，标注 Andy/Cursor 可用性
- find-skill.sh: 扫描 /home/node/.claude/skills/（所有同步后的 skills），标注 [Bot] 专属能力
- find-skill SKILL.md: 简化说明，反映统一架构

## v1.2.8 - 2026-03-08

### Added
- 5 new skills: skill-vetter, tavily-search, weather, gog, summarize
- docs/SKILL-INSTALL-GUIDE.md: Skills 安装指南
- docs/SKILL-INVENTORY.md: 完整 105 个 skills 清单

## v1.2.7 - 2026-03-08

### Security
- Fix: image path traversal vulnerability in src/index.ts and src/vision-preprocessor.ts (path.relative check)

### Changed
- VISION_MODEL switched from Qwen2.5-VL-72B-Instruct to compass-llvm (faster, more accurate)

### Fixed
- Hainan Airlines ticket monitor launchd plist: added nvm PATH, loaded to ~/Library/LaunchAgents/

### Added
- Vision model comparison test script (scripts/test-vision-models.mjs) and report (logs/vision-model-comparison.md)
- find-skill: container skill to list/search installed NanoClaw skills (.claude/skills/find-skill/)
- Multi Agent documentation in USAGE.md (Personas, multi-channel, Telegram Swarm)
- CHANGELOG.md for version tracking
- 30 new Cursor/Claude Code skills installed globally:
  - vercel-labs: web-design-guidelines, vercel-react-best-practices, vercel-composition-patterns, vercel-react-native-skills
  - coreyhaines31: copywriting, content-strategy, marketing-ideas, copy-editing, social-content, seo-audit
  - jimliu/baoyu-skills: baoyu-cover-image, baoyu-comic, baoyu-infographic, baoyu-url-to-markdown, baoyu-markdown-to-html, baoyu-format-markdown
  - toolshell: agent-tools, ai-image-generation
  - Others: ui-ux-pro-max, tailwind-design-system, remotion-best-practices, browser-use, supabase-postgres-best-practices, next-best-practices, better-auth-best-practices, building-native-ui, react-doctor, audit-website, reflection, just-scrape

## v1.2.6

- Initial Compass API version
- WhatsApp channel with Baileys
- Apple Container runtime
- Host-side vision preprocessing (Qwen2.5-VL)
- Asset update handler (host-side state machine)
- Hainan Airlines ticket alert skill
- API proxy for container networking
- Multi-persona support (PERSONAS env var)
