@echo off
chcp 65001 >nul
title 团队雷达接入
cd /d "%~dp0..\.."
set NAME=
for /f "delims=" %%i in ('git config radar.user 2^>nul') do set NAME=%%i
if "%NAME%"=="" for /f "delims=" %%i in ('git config user.name 2^>nul') do set NAME=%%i
if "%NAME%"=="" set NAME=%USERNAME%
set SERVER=http://100.121.200.66:8787

curl -s -m 4 -o nul "%SERVER%/api/state"
if errorlevel 1 (
  echo.
  echo  [X] 服务器打不通：%SERVER%
  echo      1. 看右下角托盘 Tailscale 是否 Connected，不是就点 Connect
  echo      2. 还不行就是主机没开服务，群里喊一声
  echo.
  pause
  exit /b 1
)

echo [OK] 服务器可达，以 [%NAME%] 接入...
start "雷达探针" powershell -NoExit -Command "node tools/team-radar/agent.js --user %NAME% --server %SERVER%"
timeout /t 1 >nul
start "雷达监视" powershell -NoExit -Command "node tools/team-radar/watch.js --user %NAME% --server %SERVER%"
timeout /t 2 >nul
start %SERVER%
echo.
echo [OK] 接入完成！花名：%NAME%
echo      两个窗口已跑探针，别关；浏览器将打开仪表盘，看到你的卡片即成功。
echo      如果之前已经跑过，会多开一组窗口，把旧窗口关掉即可。
echo.
pause
