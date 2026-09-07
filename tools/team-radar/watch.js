#!/usr/bin/env node
/* 团队雷达 · 实时监视器（强拦截档）
 * AI/自己保存文件时立即检测：是否存在同文件并发修改、是否涉及受保护路径，并弹出系统通知。
 * 通知方式：macOS 使用系统通知（osascript），Windows 使用气泡通知（PowerShell），其他平台输出到终端。
 * 用法: node tools/team-radar/watch.js --user 花名 --server http://服务器IP:8787
 * 建议和 agent.js 各开一个终端，--user 名字保持一致。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SERVER = get('server', 'http://localhost:8787');
const USER = get('user', process.env.USER || '我');

const IGNORE = [
  /^\.git\//,
  /^node_modules\//,
  /^dist-electron\//,
  /^release\//,
  /(^|\/)\.DS_Store$/,
];
const DEBOUNCE_MS = 800; // 同一文件 800ms 内的连续保存合并成一次检查
const QUIET_MS = 5 * 60 * 1000; // 同一文件 5 分钟内不重复弹窗

const gitRoot = async () => {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    return process.cwd();
  }
};

const esc = (s) => String(s).replace(/"/g, '\\"');

const notify = async (title, subtitle, body, sound) => {
  try {
    if (process.platform === 'darwin') {
      const line =
        'display notification "' + esc(body) + '" with title "' + esc(title) +
        '" subtitle "' + esc(subtitle) + '"' + (sound ? ' sound name "' + sound + '"' : '');
      await exec('osascript', ['-e', line]);
    } else if (process.platform === 'win32') {
      const ps = (s) => String(s).replace(/'/g, "''");
      const plain = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Warning',
        '$n.Visible = $true',
        "$n.ShowBalloonTip(8000, '" + ps(plain(title) + ' · ' + subtitle) + "', '" + ps(body) + "', [System.Windows.Forms.ToolTipIcon]::Warning)",
        'Start-Sleep -Seconds 9',
        '$n.Dispose()',
      ].join('\n');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-radar-'));
      const file = path.join(dir, 'notify.ps1');
      fs.writeFileSync(file, '\ufeff' + script, 'utf8');
      await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]);
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      console.log('[' + title + '] ' + subtitle + ' — ' + body);
    }
  } catch (e) {
    console.error('通知失败: ' + e.message);
  }
};

const pending = new Map(); // file -> timer
const lastAlert = new Map(); // file -> 上次弹窗时间

function checkFile(rel) {
  fetch(SERVER + '/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: USER, files: [rel] }),
  })
    .then((r) => r.json())
    .then((data) => {
      const now = Date.now();
      if (lastAlert.get(rel) && now - lastAlert.get(rel) < QUIET_MS) return;
      const c = data.conflicts && data.conflicts[0];
      if (c) {
        lastAlert.set(rel, now);
        const msg = c.user + '（' + c.branch + '）正在修改该文件，请先协同确认';
        const alsoRed = data.redlineHit && data.redlineHit.length ? '，且属于受保护路径' : '';
        console.log('⚠️  ' + rel + ' — ' + msg + alsoRed);
        notify('⚠️ 团队雷达：并行修改冲突', rel, msg + alsoRed, 'Basso');
      } else if (data.redlineHit && data.redlineHit.length) {
        lastAlert.set(rel, now);
        console.log('🔴 ' + rel + ' — 受保护路径（共享契约），合并前需负责人审核');
        notify('🔴 团队雷达：受保护文件变更', rel, '共享契约路径，合并前需负责人审核', 'Sosumi');
      }
    })
    .catch(() => {}); // 服务器不在线时静默，不打断开发
}

(async () => {
  const root = await gitRoot();
  console.log('实时监视已启动: ' + USER + ' @ ' + root + ' -> ' + SERVER + '（运行期间保持窗口开启，Ctrl+C 退出）');
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (IGNORE.some((re) => re.test(rel))) return;
      clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(() => checkFile(rel), DEBOUNCE_MS));
    });
  } catch (e) {
    console.error('启动失败: ' + e.message);
    process.exit(1);
  }
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
})();
