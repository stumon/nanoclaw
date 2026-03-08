# Lark Asset Update Skill

Trigger: "lark asset update", "feishu asset", "update assets via screenshot", "更新资产", "飞书资产"

## Description

Update personal asset data in a Feishu (Lark) Bitable by sending screenshots of broker/fund apps via WhatsApp. The agent uses vision to extract holding data from screenshots, then calls the Feishu API to update records.

## Prerequisites

This skill requires two core changes that are NOT auto-applied:

1. **WhatsApp image download** -- `src/channels/whatsapp.ts` must import `downloadMediaMessage` from Baileys and save received images to `groups/{folder}/media/`. Messages containing images get tagged with `[Image: media/filename.jpg]`.

2. **Agent-runner vision support** -- `container/agent-runner/src/index.ts` must detect `[Image: path]` tags in user messages, load the image as base64, and send multimodal content to the LLM API.

If these changes are already present, the skill works out of the box.

## Setup

1. Copy the update script:
   ```bash
   cp .claude/skills/lark-asset-update/add/scripts/update-lark-assets.ts scripts/
   ```

2. Add the "飞书资产更新" section to `groups/main/CLAUDE.md` (see below).

3. Rebuild NanoClaw:
   ```bash
   npm run build
   ```

4. Rebuild the container (only if agent-runner was modified):
   ```bash
   ./container/build.sh
   ```

## Conversation Flow

1. User sends "更新资产" to Andy
2. Andy replies: "请依次发送截图和飞书 token，完成后说「结束发送」"
3. User sends screenshots (broker apps, fund apps, bank balances) and a Feishu user_access_token
4. User sends "结束发送"
5. Andy:
   - Analyzes each screenshot using vision
   - Extracts: platform name, asset names, asset types, quantities, prices
   - Constructs JSON data
   - Calls `npx tsx /workspace/project/scripts/update-lark-assets.ts`
   - Reports the update summary

## Supported Platforms

| Platform | Asset Types | Mode |
|----------|------------|------|
| 中国银河证券 | A股, 场内基金 | replace |
| 华泰证券 | 场内基金 | replace |
| 川财证券 | A股 | replace |
| 盈透证券 (IBKR) | 美股 (USD, rate 7.0) | replace |
| 支付宝 | 货币基金, 基金 | upsert |
| 云闪付 | 现金 (bank balances) | upsert |
| 招商银行 | 基金 | upsert |

## Feishu Bitable

- Base ID: `WlHUbyiobawU1GssgoXcdfE0noh`
- Table ID: `tblhHUfS83WUvSCj`
- Fields: 平台, 资产, 资产类型, 持仓数量, 价格-CNY
- Auth: user_access_token (2-hour validity, provided by user each time)

## CLAUDE.md Section

Add the following to `groups/main/CLAUDE.md` to teach Andy the conversation flow:

```markdown
## 飞书资产更新

用户通过发送截图来更新飞书多维表格中的个人资产数据。

触发词：「更新资产」「更新持仓」「更新飞书资产」

流程：
1. 用户说「更新资产」→ 回复引导发送截图和 token
2. 用户发送截图 + token
3. 用户说「结束发送」→ 分析截图，调用脚本更新

脚本路径：/workspace/project/scripts/update-lark-assets.ts
```

See the full section in the actual `groups/main/CLAUDE.md` for complete instructions.
