#!/usr/bin/env bash
# 航班雷达 —— 一键启动
# 用法: bash start.sh [端口]   然后浏览器打开 http://127.0.0.1:端口
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-4173}"

# 已在运行则直接给地址
if curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "航班雷达已在运行: http://127.0.0.1:${PORT}/"
  exit 0
fi

echo "启动航班雷达 (端口 ${PORT}) ..."
cd "$DIR"
nohup node server.js "$PORT" > server.log 2>&1 &
PID=$!
sleep 2

if curl -s -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "已启动 (pid ${PID})"
  echo "打开: http://127.0.0.1:${PORT}/"
  echo "停止: kill ${PID}"
else
  echo "启动失败，日志如下："
  cat "$DIR/server.log"
  exit 1
fi
