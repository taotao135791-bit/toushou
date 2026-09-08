#!/usr/bin/env node
/* 团队雷达接入自检（doctor）
 * 用法: node tools/team-radar/doctor.js
 * 把全部输出原样贴到群里，红项自带修复提示。退出码 0=全绿 1=有红项。
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const exec = promisify(execFile);

const SERVER = process.env.RADAR_SERVER || 'http://100.121.200.66:8787';
const HUB = process.env.HUB_SERVER || 'http://100.121.200.66:8788';

const lines = [];
let bad = 0;
const ok = (name, detail) => lines.push('✅ ' + name + '：' + detail);
const fail = (name, detail, hint) => {
  bad++;
  lines.push('❌ ' + name + '：' + detail);
  if (hint) lines.push('   ↳ 修复：' + hint);
};

const git = async (args) => {
  try {
    const r = await exec('git', args, { timeout: 6000 });
    return r.stdout.trim();
  } catch {
    return null;
  }
};

async function ping(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

(async () => {
  console.log('===== 团队雷达接入自检 =====');
  console.log('时间: ' + new Date().toLocaleString() + ' | 平台: ' + os.platform());

  // 1. Node
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) ok('Node', 'v' + process.versions.node);
  else fail('Node', 'v' + process.versions.node + '（需 18 以上）', '到 nodejs.org 下载 LTS 安装，重开终端后再跑一次');

  // 2. 仓库
  const root = await git(['rev-parse', '--show-toplevel']);
  if (!root) {
    fail('仓库目录', '当前目录不是 git 仓库', '先 cd 到 toushou 仓库目录再运行本命令');
  } else {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) || '?';
    ok('仓库目录', root + '（分支 ' + branch + '）');
    const hasAgent = fs.existsSync(path.join(root, 'tools/team-radar/agent.js'));
    const hasStarter = fs.existsSync(path.join(root, 'tools/team-radar/start-mac.command')) ||
      fs.existsSync(path.join(root, 'tools/team-radar/start-windows.ps1'));
    if (!hasAgent) fail('代码版本', '缺少 tools/team-radar/，main 没拉到最新', '执行 git pull 拉取最新 main');
    else if (!hasStarter) fail('代码版本', '没有一键启动脚本，落后于 PR #15', '执行 git pull 拉取最新 main');
    else ok('代码版本', '最新（含一键启动）');
  }

  // 3. 花名
  let myName = await git(['config', 'radar.user']);
  let nameSource = 'radar.user 配置';
  if (!myName) {
    myName = await git(['config', 'user.name']);
    nameSource = 'git user.name（未配 radar.user）';
  }
  if (myName) ok('花名', myName + '（来源：' + nameSource + '）');
  else fail('花名', '未设置', '执行 git config radar.user 你的花名（一次性）');

  // 4. 网络：两个服务
  const r1 = await ping(SERVER + '/api/state');
  const r2 = await ping(HUB + '/state');
  if (r1.ok) ok('雷达服务器', '可达（' + SERVER + '）');
  else fail('雷达服务器', '不可达（' + SERVER + '）', '先看下面两个都不可达的统一提示');
  if (r2.ok) ok('意图中台', '可达（' + HUB + '）');
  else fail('意图中台', '不可达（' + HUB + '）', '先看下面两个都不可达的统一提示');
  if (!r1.ok && !r2.ok) {
    const tip = os.platform() === 'win32'
      ? '两个服务都不可达，大概率 Tailscale 未连接：右下角托盘点 Tailscale → Connect；已连接仍不行就把本输出贴群里'
      : '两个服务都不可达，大概率 Tailscale 未连接：菜单栏 Tailscale 图标应为 Connected；已连接仍不行就把本输出贴群里';
    lines.push('   ↳ ' + tip);
    bad = bad > 0 ? bad : bad + 1;
  }

  // 5. 探针在线状态（服务器端反查）
  if (r1.ok && myName) {
    try {
      const st = await (await fetch(SERVER + '/api/state', { signal: AbortSignal.timeout(4000) })).json();
      const me = (st.users || []).find((u) => u.user === myName);
      if (!me) {
        fail('探针', '服务器上没有你的上报记录', '双击 start-mac.command（Windows 右键 start-windows.ps1 → 使用 PowerShell 运行）');
      } else {
        const age = Math.round((Date.now() - me.lastActive) / 1000);
        if (me.stale || age > 35) {
          fail('探针', '上次上报 ' + age + ' 秒前（已超时）', '探针进程停了，重新双击启动脚本；跑完再执行本命令复核');
        } else {
          ok('探针', '在线，' + age + ' 秒前上报，分支 ' + me.branch);
        }
      }
    } catch (e) {
      fail('探针', '读取服务器状态失败：' + (e && e.message), '把本输出贴群里');
    }
  }

  console.log(lines.join('\n'));
  console.log('==========================');
  if (bad === 0) {
    console.log('结论：✅ 全部通过，你已完整接入团队协作。');
    process.exit(0);
  } else {
    console.log('结论：❌ 有 ' + bad + ' 个红项，按"修复"提示处理后重跑本命令。');
    console.log('（把以上全部输出原样复制到群里即可）');
    process.exit(1);
  }
})();
