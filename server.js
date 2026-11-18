// Qorgau AI — сервер без зависимостей: `node server.js` -> http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { RiskEngine } = require('./engine/risk');
const { Simulator, ATTACKS } = require('./engine/simulator');

const PORT = process.env.PORT || 3000;
const engine = new RiskEngine();
const sim = new Simulator(engine);
const streams = new Set();

const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
};
engine.on('tx', (tx) => broadcast('tx', tx));
engine.on('update', (tx) => broadcast('update', tx));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const userView = (u) => ({
  id: u.id, name: u.name, city: u.city, avgAmount: u.avgAmount, activeHours: u.activeHours, mainDevice: u.mainDevice,
  known: [...u.known].map((id) => engine.world.accounts.get(id)).map((a) => ({ id: a.id, name: a.name, phone: a.phone, bank: a.bank })),
});

const routes = {
  'GET /api/users': () => engine.world.users.map((u) => ({ id: u.id, name: u.name, city: u.city })),
  'GET /api/user': (q) => userView(engine.getUser(q.get('id')) || engine.world.users[0]),
  'GET /api/demo-recipients': () => ({
    mule: pick3(engine.world.mules.slice(0, 3)),
    blacklisted: pick3(engine.world.blacklisted),
  }),
  'POST /api/transfer/check': (q, b) => engine.evaluate(b),
  'POST /api/transfer/confirm': (q, b) => engine.confirm(b.txId, b),
  'POST /api/review': (q, b) => engine.review(b.txId, b.label),
  'GET /api/transactions': (q) => engine.txs.slice(-Number(q.get('limit') || 60)).reverse(),
  'GET /api/stats': () => ({ ...engine.stats(), simRunning: sim.running }),
  'GET /api/accounts/suspicious': () => engine.suspiciousAccounts(),
  'POST /api/sim': (q, b) => { b.on ? sim.start() : sim.stop(); return { running: sim.running }; },
  'POST /api/sim/attack': (q, b) => {
    if (!ATTACKS[b.type]) throw new Error('unknown attack');
    sim.attack(b.type);
    return { ok: true };
  },
};

function pick3(list) { return list.map((a) => ({ id: a.id, name: a.name, phone: a.phone, bank: a.bank, ageDays: a.ageDays })); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, handler(url.searchParams, body));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // static
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Qorgau AI запущен:  http://localhost:${PORT}`);
  console.log(`  Клиент:            http://localhost:${PORT}/client.html`);
  console.log(`  Антифрод-центр:    http://localhost:${PORT}/dashboard.html`);
  console.log(`  ML: Isolation Forest, ${engine.mlInfo.samples} обучающих операций, ${engine.mlInfo.trainMs} мс\n`);
});
