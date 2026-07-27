#!/bin/bash
# 推送美股每日报告到 WhatsApp（IPC）
set -euo pipefail

STOCK_DIR="/Users/huanyu.guo/self/stock"
NANOCLAW_DIR="/Users/huanyu.guo/self/nanoclaw"
IPC_DIR="$NANOCLAW_DIR/data/ipc/whatsapp_main/messages"
CHAT_JID="120363406615515477@g.us"
TODAY=$(date +%Y%m%d)
REPORT="$STOCK_DIR/美股每日交易指南_${TODAY}.md"
LOG_FILE="$NANOCLAW_DIR/logs/us-stock-push.log"

mkdir -p "$IPC_DIR" "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

if [ ! -f "$REPORT" ]; then
    log "❌ 报告不存在: $REPORT"
    exit 1
fi

TODAY_DISPLAY=$(date '+%Y-%m-%d')
CONTENT=$(cat "$REPORT")
COMBINED="📊 美股每日精选 Top3 ${TODAY_DISPLAY}
═══════════════════════════════

${CONTENT}"

ts=$(date +%s%N)
filename="stock-us-${ts}.json"

python3 -c "
import json, sys
msg = {'type': 'message', 'chatJid': '$CHAT_JID', 'text': sys.stdin.read()}
with open('$IPC_DIR/$filename', 'w') as f:
    json.dump(msg, f, ensure_ascii=False)
" <<< "$COMBINED"

log "✅ 已写入 IPC: $filename (${#COMBINED} 字节)"
