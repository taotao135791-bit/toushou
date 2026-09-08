# 团队雷达 · 实时协作监控

面向并行开发的实时变更监控与冲突预警工具。每位成员在本机运行探针客户端，
自动上报分支与文件级变更；团队通过仪表盘实时掌握成员动态、识别并行修改冲突
与受保护路径变更。

## 快速演示（约 1 分钟）

    node tools/team-radar/server.js      # 1. 启动服务（默认 http://localhost:8787）
    node tools/team-radar/simulate.js    # 2. 另开终端，模拟 3 名成员并行开发
    # 3. 浏览器打开 http://localhost:8787

演示数据包含三种典型状态：

- 两名成员并发修改同一文件，系统标记"同文件并发修改"（红色预警）；
- 一名成员修改受保护路径（src/main/ipc.ts），顶部显示变更警报；
- 一名成员在独立区域开发，状态为"无冲突"。

## 正式部署

服务部署在团队常开的机器上。默认仅监听本机，对团队开放时执行：

    HOST=0.0.0.0 node tools/team-radar/server.js

每位成员在本机仓库目录运行探针（建议使用稳定的花名）：

    node tools/team-radar/agent.js --user 花名 --server http://服务器IP:8787

更省事的方式（一键启动，自动用 git user.name 作为花名）：

- macOS：在访达里双击 tools/team-radar/start-mac.command
  （首次如提示无法验证，右键选择"打开"一次即可）
- Windows：右键 tools/team-radar/start-windows.ps1，选择"使用 PowerShell 运行"

固定花名（每台电脑执行一次，配置保存在本地 git，不会进仓库）：

    git config radar.user 花名

主机专用：双击 tools/team-radar/start-server-mac.command 一键启动两个团队服务
（雷达 8787 + 意图中台 8788）。主机重启后记得重新双击一次。

探针每 15 秒上报一次；超过 2 分钟未上报的会话将标记为"会话超时"。

## 团队部署拓扑（3 台 Mac + 1 台 Windows）

1. 选定一台常开的 Mac 作为服务节点：

       HOST=0.0.0.0 node tools/team-radar/server.js

   - 建议在路由器上为该机器做 DHCP 地址保留，避免 IP 变动后全员改配置；
   - 首次启动如遇 macOS 防火墙询问，选择"允许"。

2. Mac 成员（其余两台）：在仓库目录开两个终端，--user 使用自己的花名：

       node tools/team-radar/agent.js --user 花名 --server http://服务器IP:8787
       node tools/team-radar/watch.js --user 花名 --server http://服务器IP:8787

3. Windows 成员：安装 Node.js LTS 与 Git for Windows 后，在 PowerShell 中
   运行与上面相同的两条命令。功能差异：
   - 探针（agent.js）与服务（server.js）为纯 Node 实现，Windows 完全兼容；
   - 监视器（watch.js）在 Windows 上使用系统气泡通知（PowerShell），
     首次运行如弹出执行策略提示，按脚本内置参数运行即可；
   - 建议使用 Windows Terminal，或先执行 chcp 65001 以保证中文正常显示。

4. 全员浏览器（含负责人）打开：http://服务器IP:8787

## 变更预检（开发前检查目标路径）

    node tools/team-radar/agent.js --check src/renderer/pages/settings --server http://服务器IP:8787

退出码约定：0 无并行修改；2 存在并行修改冲突（列出对方姓名与分支，
应先协同确认）；3 目标路径属于受保护路径（合并前需负责人审核）；
1 服务不可用。

该预检已写入仓库根目录 AGENTS.md 与 CLAUDE.md，作为 coding agent 的低打扰
强制关卡：每个任务对计划改动的目录检查一次（约 1 秒）；退出码 0/3/1 时
不打断开发，仅在退出码 2（同文件并发修改）时暂停并向用户报告，确认后在
同一范围内放行、不再重复询问。

## 实时告警（保存即检测）

与探针并行运行监视器（两个终端，--user 保持一致）：

    node tools/team-radar/watch.js --user 花名 --server http://服务器IP:8787

- 文件保存瞬间自动检测：与他人活跃文件冲突时弹出"并行修改冲突"提醒，
  修改受保护路径时弹出"受保护文件变更"提醒（macOS 系统通知，含提示音）；
- 同一文件 800ms 内的连续保存合并为一次检测，5 分钟内不重复提醒；
- 服务不可用时监视器静默，不影响正常开发。

## 接入自检（卡在哪一目了然）

    node tools/team-radar/doctor.js

逐项检查 Node、仓库版本、花名、两个服务可达性、探针在线状态（服务器端反查），
红项自带修复提示。退出码 0=全绿。卡住时把完整输出贴群里即可。

## 简易式接入（推荐所有人使用）

双击一个文件，自动检查服务器、自动启动探针与监视器、自动打开仪表盘并弹窗汇报：

- macOS：双击 tools/team-radar/接入-Mac.command（首次右键选"打开"）
- Windows：双击 tools/team-radar/接入-Windows.bat

已在线则不会重复启动；服务器不通会弹窗告诉你该找谁。

## 受保护路径

redline.json 配置共享契约路径，当前与 AGENTS.md 的高影响路径一致：
src/main/、src/shared/、preload.ts、electron-builder.json、.github/。
任何成员修改上述路径时，仪表盘将显示警报，提示合并前需对应负责人审核。

## 数据与隐私

- 探针仅上报分支名、变更文件路径与时间戳，不传输代码内容；
- 无需任何 GitHub 凭证；
- 服务状态保存在内存中，重启后清空（如需历史趋势，后续可增加持久化）。
