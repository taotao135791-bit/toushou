# 团队雷达客户端一键启动（Windows）：右键"使用 PowerShell 运行"
# 花名优先取 git config radar.user（执行一次: git config radar.user 你的花名）
# 未设置则退回 git user.name
$root = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
$name = (git -C $root config radar.user) 2>$null
if (-not $name) { $name = (git -C $root config user.name) 2>$null }
if (-not $name) { $name = $env:USERNAME }
$server = "http://100.121.200.66:8787"
Write-Host "以 [$name] 接入团队雷达 -> $server"
Start-Process powershell -ArgumentList '-NoExit','-Command',"chcp 65001 | Out-Null; node tools/team-radar/agent.js --user $name --server $server" -WorkingDirectory $root
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList '-NoExit','-Command',"chcp 65001 | Out-Null; node tools/team-radar/watch.js --user $name --server $server" -WorkingDirectory $root
Write-Host "已在两个窗口启动探针与监视器，窗口保持开启即可。"
