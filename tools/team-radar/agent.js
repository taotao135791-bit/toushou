#!/usr/bin/env node
/* 团队雷达 · 探针
 * 上报: node agent.js --user 名字 --server http://IP:8787
 * 预检: node agent.js --check src/renderer/pages/xxx --server http://IP:8787
 * 预检退出码: 0=无并行修改 2=存在冲突 3=受保护路径 1=服务不可用
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const server = get('server', 'http://localhost:8787');
const check = get('check', '');

const git = async (params, fallback = null) => {
  try {
    const { stdout } = await exec('git', params, { maxBuffer: 1e7 });
    return stdout.trim();
  } catch {
    return fallback;
  }
};

function parseFiles(out) {
  return [
    ...new Set(
      out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          let f = l.slice(3).trim().replace(/^"|"$/g, '');
          if (f.includes(' -> ')) f = f.split(' -> ').pop();
          return f;
        })
    ),
  ].sort();
}

async function collect() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], '-')) || '-';
  const workFiles = parseFiles(await git(['status', '--porcelain'], ''));
  let base = await git(['rev-parse', '--verify', '-q', 'main'], '');
  if (!base) base = await git(['rev-parse', '--verify', '-q', 'origin/main'], '');
  const branchFiles = base
    ? parseFiles(await git(['diff', '--name-only', base + '...HEAD'], ''))
    : [];
  return { branch, workFiles, branchFiles };
}

async function reportLoop(user) {
  console.log('探针已启动: ' + user + ' -> ' + server + '（每 15 秒上报，Ctrl+C 退出）');
  const tick = async () => {
    try {
      const info = await collect();
      await fetch(server + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, ...info }),
      });
      console.log(
        '✓ ' + new Date().toLocaleTimeString() + ' ' + info.branch + ' 工作区变更 ' + info.workFiles.length + ' 个文件'
      );
    } catch (e) {
      console.error('上报失败: ' + e.message);
    }
  };
  await tick();
  setInterval(tick, 15000);
}

async function runCheck() {
  try {
    const r = await fetch(server + '/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [check] }),
    });
    const data = await r.json();
    if (data.redlineHit && data.redlineHit.length) {
      console.log('🔴 目标路径属于受保护文件：' + data.redlineHit.join(', ') + '（合并前需负责人审核）');
    }
    if (!data.conflicts || !data.conflicts.length) {
      if (data.redlineHit && data.redlineHit.length) {
        console.log('⛔ 退出码 3：目标路径无并行修改，但属于受保护路径；可继续开发，合并前需负责人审核。');
        process.exitCode = 3;
      } else {
        console.log('✅ 目标路径当前无并行修改，可以开始开发');
        process.exitCode = 0;
      }
      return;
    }
    for (const c of data.conflicts) {
      console.log('⚠ ' + c.user + '（' + c.branch + '）正在修改：' + c.shared.join(', '));
    }
    console.log('⛔ 检测到并行修改冲突。停止修改该路径，先与上述成员协同确认；确认无碍后再继续。');
    process.exitCode = 2;
  } catch (e) {
    console.error('预检失败: ' + e.message);
    console.error('团队雷达服务不可用。请向用户报告服务离线，并询问是否在无预检的情况下继续。');
    process.exitCode = 1;
  }
}

(async () => {
  if (check) return runCheck();
  const user = get('user', (await git(['config', 'user.name'], '')) || process.env.USER || '我');
  return reportLoop(user);
})();
