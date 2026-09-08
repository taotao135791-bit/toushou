#!/bin/sh
# 简易式接入（macOS）：双击这一个文件就够了
# 自动检查服务器 -> 自动启动探针与监视器 -> 自动打开仪表盘 -> 弹窗汇报结果
cd "$(dirname "$0")/../.." || exit 1
NAME=$(git config radar.user 2>/dev/null | head -1)
[ -z "$NAME" ] && NAME=$(git config user.name 2>/dev/null | head -1)
[ -z "$NAME" ] && NAME=$(whoami)
SERVER=http://100.121.200.66:8787

# 1. 服务器可达性
if ! curl -s -m 4 "$SERVER/api/state" >/dev/null 2>&1; then
  osascript -e "display dialog \"服务器打不通：$SERVER\n\n先确认菜单栏 Tailscale 是 Connected；\n还是不行就是主机没开服务，群里喊一声。\" with title \"团队雷达接入\" buttons {\"好\"} default button \"好\"" >/dev/null 2>&1
  exit 1
fi

# 2. 探针是否已在线（在线就不重复启动）
if node -e "fetch(process.argv[1]+'/api/state').then(r=>r.json()).then(j=>{const u=(j.users||[]).find(x=>x.user===process.argv[2]);process.exit(u&&!u.stale?0:1)}).catch(()=>process.exit(1))" "$SERVER" "$NAME" 2>/dev/null; then
  osascript -e "display dialog \"你已在线，花名：$NAME\n\n浏览器即将打开仪表盘。\" with title \"团队雷达\" buttons {\"好\"} default button \"好\"" >/dev/null 2>&1
  open "$SERVER"
  exit 0
fi

# 3. 启动探针 + 监视器
osascript -e "tell application \"Terminal\" to activate" >/dev/null
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && node tools/team-radar/agent.js --user '$NAME' --server '$SERVER'\"" >/dev/null
sleep 1
osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && node tools/team-radar/watch.js --user '$NAME' --server '$SERVER'\"" >/dev/null
sleep 2
open "$SERVER"
osascript -e "display dialog \"接入完成！花名：$NAME\n\n两个终端窗口已在跑探针（别关）；\n浏览器将打开仪表盘，看到你的卡片即成功。\" with title \"团队雷达\" buttons {\"好\"} default button \"好\"" >/dev/null 2>&1
