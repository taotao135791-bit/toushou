#!/bin/sh
# 主机专用：双击启动团队协作服务（雷达 8787 + 意图中台 8788，两个终端窗口）
cd "$(dirname "$0")/../.." || exit 1
osascript -e "tell application \"Terminal\" to activate" >/dev/null
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && HOST=0.0.0.0 node tools/team-radar/server.js\"" >/dev/null
sleep 1
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && node tools/intent-hub/server.js --port 8788 --repo taotao135791-bit/toushou\"" >/dev/null
echo "已启动：团队雷达 http://100.121.200.66:8787"
echo "        意图中台 http://100.121.200.66:8788"
echo "两个终端窗口保持开启；关机/重启后重新双击本文件。"
