#!/bin/bash
#
# 股票每日推送脚本
# 1. 运行 stock 项目的全市场分析（A股 + 港股 + 美股）
# 2. 收集今日 A股、趋势加速 Top5、美股报告
# 3. 分三条 IPC 消息推送到 WhatsApp（间隔 3 秒）
#
# 手动仅重推: STOCK_REPORT_DATE=20260622 bash scripts/stock-daily-push.sh --push-only
#

set -euo pipefail

STOCK_DIR="/Users/huanyu.guo/self/stock"
NANOCLAW_DIR="/Users/huanyu.guo/self/nanoclaw"
IPC_DIR="$NANOCLAW_DIR/data/ipc/whatsapp_main/messages"
CHAT_JID="120363406615515477@g.us"
TODAY="${STOCK_REPORT_DATE:-$(date +%Y%m%d)}"
LOG_FILE="$NANOCLAW_DIR/logs/stock-daily.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

mkdir -p "$IPC_DIR" "$(dirname "$LOG_FILE")"

PUSH_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --push-only) PUSH_ONLY=true ;;
    esac
done

log "=== 开始每日股票分析 ==="

# launchd/cron 等环境 PATH 很精简，显式注入常见路径
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

# stock 项目依赖 mysql-connector-python / requests。
# 按优先级查找可用的 Python 解释器（需要有 requests + mysql.connector）。
PYTHON_CANDIDATES=(
    "/usr/local/opt/python@3.11/bin"
    "/opt/homebrew/opt/python@3.11/bin"
    "/usr/local/opt/python@3.12/bin"
    "/opt/homebrew/opt/python@3.12/bin"
)
PYTHON_FOUND=false
for candidate in "${PYTHON_CANDIDATES[@]}"; do
    if [ -x "$candidate/python3" ] && "$candidate/python3" -c "import requests, mysql.connector" 2>/dev/null; then
        PATH="$candidate:$PATH"
        export PATH
        PYTHON_FOUND=true
        log "使用 Python: $("$candidate/python3" --version 2>&1) ($candidate)"
        break
    fi
done
if [ "$PYTHON_FOUND" = false ]; then
    log "⚠️ 未找到带 requests+mysql.connector 的 Python，尝试用默认 python3: $(python3 --version 2>&1) ($(which python3 2>/dev/null))"
fi
log "python3 -> $(which python3 2>/dev/null) ($(python3 --version 2>&1))"

if [ "$PUSH_ONLY" = false ]; then
    # 1. 运行全市场分析
    log "运行 run_daily_all.sh ..."
    cd "$STOCK_DIR"
    if bash run_daily_all.sh >> "$LOG_FILE" 2>&1; then
        log "分析完成"
    else
        log "分析脚本出错 (exit $?), 尝试推送已有报告"
    fi
else
    log "跳过分析 (--push-only)，仅推送已有报告"
fi

# 2. 收集今日报告（A股 + 趋势加速 Top5 + 美股）
cd "$STOCK_DIR"
MOMENTUM_PUSH_FILE="趋势加速推送_${TODAY}.txt"

# 生成趋势加速 Top5 短消息（A股 + 港股，供单独推送）
log "生成趋势加速 Top5 短消息 ..."
if python3 scripts/format_momentum_push.py --date "$TODAY" >> "$LOG_FILE" 2>&1; then
    log "趋势加速短消息已生成"
else
    log "⚠️ 趋势加速短消息生成失败，尝试使用已有文件"
fi

REPORT_SPECS=(
    "每日交易指南_${TODAY}.md|📊 A股每日精选 Top3|ashare"
    "美股每日交易指南_${TODAY}.md|📊 美股每日精选 Top3|us"
)

TODAY_DISPLAY=$(date '+%Y-%m-%d')
PUSH_COUNT=0

# 3. 分条推送到 WhatsApp（A股、趋势加速 Top5、美股各一条）
send_ipc_message() {
    local text="$1"
    local label="$2"
    local ts=$(date +%s%N)
    local filename="stock-${ts}.json"

    python3 -c "
import json, sys
msg = {'type': 'message', 'chatJid': '$CHAT_JID', 'text': sys.stdin.read()}
with open('$IPC_DIR/$filename', 'w') as f:
    json.dump(msg, f, ensure_ascii=False)
" <<< "$text"

    log "IPC 已写入 [$label]: $filename (${#text} 字节)"
}

for spec in "${REPORT_SPECS[@]}"; do
    IFS='|' read -r filename header kind <<< "$spec"
    report="$STOCK_DIR/$filename"

    if [ ! -f "$report" ]; then
        log "⚠️ 跳过缺失报告: $filename"
        continue
    fi

    content=$(cat "$report")

    if [ "$kind" = "ashare" ]; then
        prefix="${header} ${TODAY_DISPLAY}
（只跟踪 3 只新股，其余为持仓操作建议）
═══════════════════════════════"
    else
        prefix="${header} ${TODAY_DISPLAY}
═══════════════════════════════"
    fi

    message="${prefix}

${content}"

    if [ ${#message} -gt 60000 ]; then
        log "⚠️ ${filename} 过长 (${#message} 字节)，截断至 60000"
        message="${message:0:60000}

…（内容过长已截断，完整版见本地 ${filename}）"
    fi

    send_ipc_message "$message" "$filename"
    PUSH_COUNT=$((PUSH_COUNT + 1))
    # 间隔发送，减轻 WhatsApp 多设备同步压力
    sleep 3
done

# 趋势加速 Top5 短消息（单独一条，便于快速扫一眼）
momentum_report="$STOCK_DIR/$MOMENTUM_PUSH_FILE"
if [ -f "$momentum_report" ]; then
    momentum_content=$(cat "$momentum_report")
    momentum_message="${momentum_content}"
    send_ipc_message "$momentum_message" "$MOMENTUM_PUSH_FILE"
    PUSH_COUNT=$((PUSH_COUNT + 1))
    sleep 3
else
    log "⚠️ 跳过缺失报告: $MOMENTUM_PUSH_FILE"
fi

if [ "$PUSH_COUNT" -eq 0 ]; then
    log "今日无可用报告，跳过推送"
    exit 0
fi

log "=== 推送完成 (${PUSH_COUNT} 条 WhatsApp 消息) ==="
