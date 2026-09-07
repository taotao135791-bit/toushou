#!/usr/bin/env node
/* 意图中台 · 客户端（AI 开工前调用）
 * 上报: node cli.js --title "要做的事" --scope 目录1 目录2 --branch 分支
 *       （--user 可省略：默认取 git 提交身份，与 PR/blame 天然对应；
 *         想用自选花名展示才需要显式传 --user）
 * 查看: node cli.js --list
 * 关闭: node cli.js --close 3
 *
 * 服务器默认走 Tailscale MagicDNS 设备名（leoliumacbook-air:8788），--server 可覆盖。
 * 退出码: 0=拿到绿灯已登记 / 2=被先到先得锁拦下（打印持锁人，停止本次修改并报告用户）
 *         1=服务不可达（报告一次后继续，不阻塞）
 */
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SERVER = get('server', 'http://leoliumacbook-air:8788');
const TITLE = get('title', '');
const CLOSE_ID = get('close', '');
const LIST = args.includes('--list');

/** git 提交身份作为默认花名：PR 作者、blame、意图三者天然对齐。 */
function defaultUser() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const USER = get('user', '') || defaultUser();

async function main() {
  if (LIST) {
    const res = await fetch(SERVER + '/state');
    const data = await res.json();
    const rows = data.intents || [];
    if (rows.length === 0) {
      console.log('当前没有进行中的意图');
    } else {
      console.log('进行中的意图:');
      for (const r of rows) {
        const age = Math.round((Date.now() - r.registeredAt) / 60000);
        console.log(`  #${r.id} [${r.user}] ${r.title} · ${r.branch || '-'} · ${age}分钟前 · 范围: ${(r.scope || []).join(', ') || '-'}`);
      }
    }
    return 0;
  }
  if (CLOSE_ID) {
    const res = await fetch(SERVER + '/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: Number(CLOSE_ID), by: USER || 'cli' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'close 失败');
    console.log(`意图 #${CLOSE_ID} 已关闭`);
    return 0;
  }
  if (!USER || !TITLE) {
    console.error('需要 --title（可加 --scope 目录1 目录2 与 --branch 分支名）；--user 缺省时取 git user.name，当前未能取得，请显式传入');
    return 1;
  }
  const scopeStart = args.indexOf('--scope');
  const scope = scopeStart >= 0 ? args.slice(scopeStart + 1).filter((a) => !a.startsWith('--')) : [];
  const res = await fetch(SERVER + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: USER, title: TITLE, scope, branch: get('branch', '') }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'register 失败');
  if (data.verdict === 'clear') {
    console.log(`绿灯: 意图 #${data.id} 已登记，可以开工（24 小时内有效，完成后请 --close ${data.id}）`);
    return 0;
  }
  console.log('红灯: 与进行中的意图撞车（先到先得锁）——请停止本次修改并报告用户:');
  for (const c of data.conflicts || []) {
    const age = Math.round((Date.now() - c.registeredAt) / 60000);
    console.log(`  #${c.id} [${c.user}] ${c.title} · ${age}分钟前 · ${c.reason} · 分支: ${c.branch || '-'}`);
  }
  return 2;
}

main().catch((err) => {
  console.error('意图中台不可达: ' + err.message);
  process.exit(1);
}).then((code) => process.exit(code));
