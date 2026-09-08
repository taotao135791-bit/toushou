#!/usr/bin/env node
/* 团队雷达 · 实时协作仪表盘服务器（零依赖，Node 18+）
 * 只接收文件路径与分支名，不接收代码内容。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // 局域网使用: HOST=0.0.0.0 node server.js
const STALE_MS = 2 * 60 * 1000; // 超过 2 分钟未上报视为"会话超时"
const HEARTBEAT_MS = 10 * 1000;

let redline = [];
try {
  redline = JSON.parse(fs.readFileSync(path.join(__dirname, 'redline.json'), 'utf8'));
} catch {
  redline = [];
}

const users = new Map(); // user -> 上报状态
const clients = new Set(); // 浏览器 SSE 连接

const isRedline = (f) =>
  redline.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'));
const dirOf = (f) => path.posix.dirname(f);
const changedOf = (u) => [...new Set([...(u.workFiles || []), ...(u.branchFiles || [])])];

function computeState() {
  const now = Date.now();
  const list = [...users.values()]
    .map((u) => {
      const changed = changedOf(u);
      return {
        user: u.user,
        branch: u.branch,
        workFiles: u.workFiles,
        branchFiles: u.branchFiles,
        changed,
        lastActive: u.ts,
        stale: now - u.ts > STALE_MS,
        redlineFiles: changed.filter(isRedline),
      };
    })
    .sort((a, b) => a.user.localeCompare(b.user, 'zh'));

  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const setB = new Set(b.changed);
      const shared = a.changed.filter((f) => setB.has(f));
      const dirsB = new Set(b.changed.map(dirOf));
      const sharedDirs = [...new Set(a.changed.map(dirOf))].filter((d) => dirsB.has(d));
      pairs.push({
        a: a.user,
        b: b.user,
        shared,
        sharedDirs,
        level: shared.length ? 'red' : sharedDirs.length ? 'yellow' : 'green',
        stale: a.stale || b.stale,
      });
    }
  }
  return {
    ts: now,
    staleMs: STALE_MS,
    redline,
    users: list,
    pairs,
    redAlerts: list
      .filter((u) => !u.stale && u.redlineFiles.length)
      .map((u) => ({ user: u.user, branch: u.branch, files: u.redlineFiles })),
  };
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify(computeState()) + '\n\n';
  for (const res of clients) res.write(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const cleanFiles = (v) =>
  Array.isArray(v)
    ? [...new Set(v.filter((f) => typeof f === 'string' && f && f.length < 512))]
        .sort()
        .slice(0, 2000)
    : [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (req.method === 'POST' && url.pathname === '/report') {
      const body = await readBody(req);
      const user = String(body.user || '').trim().slice(0, 50);
      if (!user) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"missing user"}');
        return;
      }
      users.set(user, {
        user,
        branch: String(body.branch || '-').slice(0, 100),
        workFiles: cleanFiles(body.workFiles),
        branchFiles: cleanFiles(body.branchFiles),
        ts: Date.now(),
      });
      broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/check') {
      const body = await readBody(req);
      const query = cleanFiles(body.files);
      const me = String(body.user || '').trim().slice(0, 50);
      if (!query.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"missing files"}');
        return;
      }
      const match = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
      const conflicts = computeState()
        .users.filter((u) => !u.stale && u.user !== me)
        .map((u) => {
          const shared = u.changed.filter((f) => query.some((q) => match(q, f)));
          return shared.length ? { user: u.user, branch: u.branch, shared } : null;
        })
        .filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, conflicts, redlineHit: query.filter(isRedline) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(computeState()));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: ' + JSON.stringify(computeState()) + '\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
});

// 自动清理：超过 10 分钟未上报的成员直接移除，避免"幽灵卡片"长期挂墙
const GHOST_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [k, u] of users) {
    if (now - u.ts > GHOST_MS) {
      users.delete(k);
      removed = true;
    }
  }
  if (removed) broadcast();
}, HEARTBEAT_MS);
setInterval(broadcast, HEARTBEAT_MS);
server.listen(PORT, HOST, () => console.log('团队雷达已启动: http://' + HOST + ':' + PORT));
