#!/bin/bash
# 在后台启动 NanoClaw（开发模式），关掉终端后进程继续跑。
# 用法: ./scripts/start-background.sh
# 日志: logs/nanoclaw.log

set -e
cd "$(dirname "$0")/.."
mkdir -p logs
nohup npm run dev >> logs/nanoclaw.log 2>&1 &
echo "NanoClaw 已在后台启动，PID: $!"
echo "可关闭本终端。查看日志: tail -f logs/nanoclaw.log"
disown 2>/dev/null || true
