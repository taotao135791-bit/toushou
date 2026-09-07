#!/usr/bin/env node
/* 自检: 拉起服务器 -> 模拟 3 人上报 -> 校验重叠/红线/预检 -> 自动退出
 * 用法: node tools/team-radar/selftest.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8790; // 独立端口，不影响正在运行的实例
const BASE = 'http://127.0.0.1:' + PORT;

const post = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runAgent(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'agent.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '✅' : '❌') + ' ' + msg);
  if (!cond) failures++;
};

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    await sleep(600);
    await post('/report', {
      user: '阿磊',
      branch: 'codex/a',
      workFiles: ['src/renderer/pages/settings/Settings.tsx'],
      branchFiles: ['src/renderer/pages/settings/useSettings.ts'],
    });
    await post('/report', {
      user: '小雨',
      branch: 'codex/b',
      workFiles: ['src/renderer/pages/settings/Settings.tsx', 'src/main/ipc.ts'],
      branchFiles: [],
    });
    await post('/report', {
      user: '学贤',
      branch: 'codex/c',
      workFiles: ['tools/team-radar/server.js'],
      branchFiles: [],
    });

    const st = await (await fetch(BASE + '/api/state')).json();
    ok(st.users.length === 3, '三名成员都上报成功');
    const pairAB = st.pairs.find(
      (p) =>
        (p.a === '阿磊' && p.b === '小雨') || (p.a === '小雨' && p.b === '阿磊')
    );
    ok(
      pairAB && pairAB.level === 'red' && pairAB.shared.includes('src/renderer/pages/settings/Settings.tsx'),
      '同文件并发修改识别为冲突预警'
    );
    const red = st.redAlerts.find((a) => a.user === '小雨');
    ok(red && red.files.includes('src/main/ipc.ts'), '受保护路径触发警报');

    const chk = await post('/check', { files: ['src/renderer/pages/settings'] });
    ok(chk.conflicts.length === 2, '变更预检能识别该路径的并行修改者');
    const chk2 = await post('/check', { files: ['docs/'] });
    ok(chk2.conflicts.length === 0, '空闲路径预检通过');
    const chkSelf = await post('/check', {
      user: '阿磊',
      files: ['src/renderer/pages/settings/Settings.tsx'],
    });
    ok(
      chkSelf.conflicts.length === 1 && chkSelf.conflicts[0].user === '小雨',
      '预检排除本人会话，仅报告他人'
    );
    const gate = await runAgent(['--check', 'src/renderer/pages/settings', '--server', BASE]);
    ok(
      gate.code === 2 && gate.out.includes('并行修改冲突'),
      'CLI 预检在冲突时以退出码 2 拦截'
    );
    const gateClear = await runAgent(['--check', 'docs/', '--server', BASE]);
    ok(gateClear.code === 0, 'CLI 预检在空闲路径返回退出码 0');
    const gateRed = await runAgent(['--check', 'src/main/unknown-file.ts', '--server', BASE]);
    ok(gateRed.code === 3, 'CLI 预检在受保护路径返回退出码 3');
  } finally {
    srv.kill();
  }
  process.exit(failures ? 1 : 0);
})();
