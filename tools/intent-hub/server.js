#!/usr/bin/env node
/* 意图中台 · 服务端
 * 多人 vibe coding 的开工前意图登记与查重：AI 在动功能/修 bug 之前先申报，
 * 中台按"先到先得锁"判定——范围重叠或描述相似即被拒，拿到绿灯才开工。
 *
 * 启动: node tools/intent-hub/server.js [--port 8788]
 * 数据: 同目录 intents.json（重启不丢）；活跃意图 24 小时未关闭自动过期。
 * 依赖: 仅 Node 18+（无第三方包），macOS / Windows 通用。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = parseInt(getArg('port', '8788'), 10);
const STORE = getArg('store', path.join(__dirname, 'intents.json'));
const PUBLIC = path.join(__dirname, 'public', 'index.html');
const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;
const SIMILAR_THRESHOLD = 0.3;

let state = { seq: 1, intents: [] };
try {
  state = JSON.parse(fs.readFileSync(STORE, 'utf8'));
} catch {
  /* 首次运行无数据 */
}

const save = () => fs.writeFileSync(STORE, JSON.stringify(state, null, 2));

/* ---------- 判定逻辑（纯函数，供 selftest 复用思路） ---------- */

/** 中文按相邻两字切词，英文按单词；小写化。 */
function tokenize(text) {
  const tokens = new Set();
  const cjk = String(text || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i + 1 < seg.length; i++) tokens.add(seg.slice(i, i + 2));
  }
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) {
    tokens.add(w);
  }
  return tokens;
}

/** Jaccard 相似度（0~1），词表为空时为 0。 */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, '');

/** 范围重叠：任一路径互为前缀（目录树包含）。 */
function scopeOverlap(a, b) {
  const listA = (a || []).map(normPath).filter(Boolean);
  const listB = (b || []).map(normPath).filter(Boolean);
  for (const x of listA) {
    for (const y of listB) {
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return [x, y];
    }
  }
  return null;
}

function activeIntents(now = Date.now()) {
  return state.intents.filter(
    (i) => i.status === 'active' && now - i.updatedAt < ACTIVE_TTL_MS
  );
}

/** 与现有活跃意图比对（排除同一用户的续报）。返回冲突列表。 */
function findConflicts(intent) {
  const mine = tokenize(intent.title + ' ' + (intent.detail || ''));
  const conflicts = [];
  for (const other of activeIntents()) {
    if (other.user === intent.user) continue;
    const overlap = scopeOverlap(other.scope, intent.scope);
    const sim = similarity(mine, tokenize(other.title + ' ' + (other.detail || '')));
    if (overlap || sim >= SIMILAR_THRESHOLD) {
      conflicts.push({
        id: other.id,
        user: other.user,
        title: other.title,
        branch: other.branch,
        registeredAt: other.registeredAt,
        reason: overlap
          ? `范围重叠: ${overlap[0]} ↔ ${overlap[1]}`
          : `描述相似度 ${(sim * 100).toFixed(0)}%`,
      });
    }
  }
  return conflicts;
}

/* ---------- HTTP ---------- */

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) return reject(new Error('body too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(PUBLIC, 'utf8'));
      return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      const now = Date.now();
      send(res, 200, { now, intents: activeIntents(now), total: state.intents.length });
      return;
    }
    if (req.method === 'POST' && req.url === '/register') {
      const body = await readBody(req);
      const user = String(body.user || '').trim().slice(0, 40);
      const title = String(body.title || '').trim().slice(0, 200);
      const scope = Array.isArray(body.scope) ? body.scope.slice(0, 10).map(normPath).filter(Boolean) : [];
      if (!user || !title) return send(res, 400, { ok: false, error: 'user 与 title 必填' });
      const intent = {
        user,
        title,
        detail: String(body.detail || '').trim().slice(0, 500),
        scope,
        branch: String(body.branch || '').trim().slice(0, 80),
      };
      const conflicts = findConflicts(intent);
      if (conflicts.length > 0) {
        return send(res, 200, { ok: true, verdict: 'blocked', conflicts });
      }
      const now = Date.now();
      const record = { id: state.seq++, status: 'active', ...intent, registeredAt: now, updatedAt: now };
      state.intents.push(record);
      save();
      return send(res, 200, { ok: true, verdict: 'clear', id: record.id, ttlHours: 24 });
    }
    if (req.method === 'POST' && req.url === '/close') {
      const body = await readBody(req);
      const id = Number(body.id);
      const record = state.intents.find((i) => i.id === id);
      if (!record) return send(res, 404, { ok: false, error: 'intent 不存在' });
      record.status = 'closed';
      record.updatedAt = Date.now();
      record.closedBy = String(body.by || record.user).slice(0, 40);
      save();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    send(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`意图中台已启动: http://0.0.0.0:${PORT}  （先到先得锁，Ctrl+C 退出）`);
});
