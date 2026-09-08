#!/bin/sh
# 团队雷达客户端一键启动（macOS）：双击本文件即可
# 花名优先取 git config radar.user（执行一次: git config radar.user 你的花名）
# 未设置则退回 git user.name
cd "$(dirname "$0")/../.." || exit 1
USER_NAME=$(git config radar.user 2>/dev/null | head -1)
[ -z "$USER_NAME" ] && USER_NAME=$(git config user.name 2>/dev/null | head -1)
[ -z "$USER_NAME" ] && USER_NAME=$(whoami)
SERVER=$RADAR_SERVER
[ -z "$SERVER" ] && SERVER=http://100.121.200.66:8787
echo "以 [$USER_NAME] 接入团队雷达 -> $SERVER"
osascript -e "tell application \"Terminal\" to activate" >/dev/null
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && node tools/team-radar/agent.js --user '$USER_NAME' --server '$SERVER'\"" >/dev/null
sleep 1
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && node tools/team-radar/watch.js --user '$USER_NAME' --server '$SERVER'\"" >/dev/null
echo "已在两个终端窗口启动探针与监视器，窗口保持开启即可。"
