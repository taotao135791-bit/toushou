#!/usr/bin/env node
/* 意图中台自检：临时端口起服务，覆盖 绿灯/红灯/范围重叠/关锁复用/过期 四条主路径。
 * 运行: node tools/intent-hub/selftest.js
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const PORT = 18788 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
// 独立临时数据文件：绝不污染生产 intents.json，也避免上轮残留影响本轮。
const STORE = path.join(os.tmpdir(), `intent-hub-selftest-${Date.now()}.json`);
let failed = 0;

const ok = (cond, label) => {
  console.log((cond ? '✅ ' : '❌ ') + label);
  if (!cond) failed++;
};

const post = async (url, body) =>
  (await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(PORT), '--store', STORE], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));

  try {
    // 1. 首个意图拿到绿灯
    const a = await post('/register', {
      user: 'Caddie', title: '广告文案评分优化：五维权重调整', scope: ['src/renderer/ads'], branch: 'feat/score',
    });
    ok(a.verdict === 'clear' && a.id >= 1, '首个意图拿到绿灯并登记');

    // 2. 他人相似意图被先到先得锁拦下
    const b = await post('/register', {
      user: 'Leo', title: '优化广告文案的评分权重', scope: ['src/renderer'], branch: 'fix/w',
    });
    ok(b.verdict === 'blocked', '相似意图被红灯拦下');
    ok((b.conflicts || []).some((c) => c.user === 'Caddie'), '红灯指出持锁人');

    // 3. 无关意图正常放行
    const c = await post('/register', {
      user: 'Leo', title: '插件市场搜索结果分页', scope: ['src/renderer/plugins'], branch: 'feat/page',
    });
    ok(c.verdict === 'clear', '无关意图拿到绿灯');

    // 4. 关锁后范围可复用
    await post('/close', { id: a.id, by: 'Caddie' });
    const d = await post('/register', {
      user: 'Leo', title: '广告文案评分权重调整', scope: ['src/renderer/ads'], branch: 'fix/w2',
    });
    ok(d.verdict === 'clear', '关闭意图后锁释放，同范围可申报');

    // 5. 同一用户的续报不受自己拦截
    const e = await post('/register', {
      user: 'Leo', title: '插件市场搜索分页样式微调', scope: ['src/renderer/plugins'], branch: 'feat/page',
    });
    ok(e.verdict === 'clear', '同一用户续报不被自己拦截');

    // 6. 看板数据包含全部活跃意图（c、d、e 三条在锁）
    const state = await (await fetch(BASE + '/state')).json();
    ok(Array.isArray(state.intents) && state.intents.length === 3, '看板 /state 返回活跃意图');
  } finally {
    server.kill();
    try { require('fs').unlinkSync(STORE); } catch {}
  }

  console.log(failed === 0 ? '\n自检全部通过' : `\n${failed} 项失败`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('自检异常: ' + err.message);
  process.exitCode = 1;
});
