#!/bin/bash
#
# 股票每日推送脚本
# 1. 运行 stock 项目的全市场分析
# 2. 收集今日生成的报告
# 3. 通过 NanoClaw IPC 推送到 WhatsApp
#

set -euo pipefail

STOCK_DIR="/Users/huanyu.guo/self/stock"
NANOCLAW_DIR="/Users/huanyu.guo/self/nanoclaw"
IPC_DIR="$NANOCLAW_DIR/data/ipc/whatsapp_main/messages"
CHAT_JID="8619860743536@s.whatsapp.net"
TODAY=$(date +%Y%m%d)
LOG_FILE="$NANOCLAW_DIR/logs/stock-daily.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

mkdir -p "$IPC_DIR" "$(dirname "$LOG_FILE")"

log "=== 开始每日股票分析 ==="

# launchd/cron 等环境 PATH 很精简，显式注入常见 Go 路径，避免 stock 项目里 go 命令找不到
EXTRA_PATHS=(
    "/usr/local/go/bin"
    "$HOME/go/bin"
    "$HOME/go19/go*/bin"
    "/opt/homebrew/bin"
    "/usr/local/bin"
)
shopt -s nullglob
for p in "${EXTRA_PATHS[@]}"; do
    for d in $p; do
        if [ -d "$d" ]; then
            PATH="$d:$PATH"
        fi
    done
done
shopt -u nullglob
export PATH

if ! command -v go >/dev/null 2>&1; then
    log "⚠️ 未找到 go 命令（当前 PATH=$PATH），A股数据采集可能会失败并回退到旧数据"
fi

# 1. 运行全市场分析
log "运行 run_daily_all.sh ..."
cd "$STOCK_DIR"
if bash run_daily_all.sh >> "$LOG_FILE" 2>&1; then
    log "分析完成"
else
    log "分析脚本出错 (exit $?), 尝试推送已有报告"
fi

# 2. 收集今日报告
REPORTS=()

for pattern in \
    "$STOCK_DIR/每日交易指南_${TODAY}.md" \
    "$STOCK_DIR/港股每日推荐_${TODAY}.md" \
    "$STOCK_DIR/港股混合策略_${TODAY}.md" \
    "$STOCK_DIR/美股每日交易指南_${TODAY}.md" \
    "$STOCK_DIR/stock/daily_report_${TODAY}.md" \
    "$STOCK_DIR/stock/A股每日推荐_${TODAY}.md"; do
    if [ -f "$pattern" ]; then
        REPORTS+=("$pattern")
    fi
done

if [ ${#REPORTS[@]} -eq 0 ]; then
    log "今日无报告生成，跳过推送"
    exit 0
fi

log "找到 ${#REPORTS[@]} 个报告"

# 3. 逐个推送到 WhatsApp
send_ipc_message() {
    local text="$1"
    local ts=$(date +%s%N)
    local filename="stock-${ts}.json"
    
    # 用 python3 生成 JSON 确保 Unicode 正确
    python3 -c "
import json, sys
msg = {'type': 'message', 'chatJid': '$CHAT_JID', 'text': sys.stdin.read()}
with open('$IPC_DIR/$filename', 'w') as f:
    json.dump(msg, f, ensure_ascii=False)
" <<< "$text"
    
    log "IPC 消息已写入: $filename"
}

for report in "${REPORTS[@]}"; do
    name=$(basename "$report" .md)
    content=$(cat "$report")
    
    # WhatsApp 单条消息上限约 65000 字符，报告一般 2-4KB，直接发
    send_ipc_message "$content"
    log "已推送: $name"
    
    sleep 1
done

log "=== 推送完成 (${#REPORTS[@]} 条报告) ==="
