#!/usr/bin/env node
/* 模拟 3 名开发者同时开发，用于演示/验收仪表盘 */
const SERVER = process.env.SERVER || 'http://localhost:8787';

const people = [
  {
    user: '阿磊',
    branch: 'codex/alei-settings',
    base: ['README.md', 'src/renderer/pages/settings/Settings.tsx'],
    flicker: ['src/renderer/pages/settings/Settings.test.ts'],
    branchFiles: ['src/renderer/pages/settings/useSettings.ts'],
  },
  {
    user: '小雨',
    branch: 'codex/xiaoyu-theme',
    base: ['src/renderer/pages/settings/Settings.tsx', 'src/main/theme.ts'],
    flicker: ['src/main/ipc.ts'],
    branchFiles: [],
  },
  {
    user: '学贤',
    branch: 'codex/xuexian-dashboard',
    base: ['tools/team-radar/server.js', 'tools/team-radar/public/index.html'],
    flicker: ['tools/team-radar/README.md'],
    branchFiles: ['tools/team-radar/agent.js'],
  },
];

async function tick() {
  for (const p of people) {
    const workFiles = [...p.base, ...(Math.random() < 0.7 ? p.flicker : [])];
    try {
      await fetch(SERVER + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: p.user,
          branch: p.branch,
          workFiles,
          branchFiles: p.branchFiles,
        }),
      });
    } catch (e) {
      console.error('上报失败 (' + p.user + '): ' + e.message);
      return;
    }
  }
  console.log('✓ ' + new Date().toLocaleTimeString() + ' 已上报 3 名开发者状态');
}

(async () => {
  console.log('模拟器已启动 -> ' + SERVER + '（每 5 秒刷新，Ctrl+C 退出）');
  await tick();
  setInterval(tick, 5000);
})();
