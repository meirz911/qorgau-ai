// Qorgau Risk Engine: правила + Isolation Forest + сетевой анализ получателей + текст.
// Каждое решение объяснимо: список причин с вкладом в баллы.

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { IsolationForest } = require('./isoforest');
const { analyzeText } = require('./text');
const { nb } = require('./nlp');
const { LogisticModel, featurize } = require('./supervised');
const { buildWorld, normalHistory, hourDeviation, rng, randInt, phone, fullName } = require('./data');

const DAY = 24 * 3600e3;
const HOUR = 3600e3;
const T_CHALLENGE = 35;
const T_HOLD = 70;

function toVector(f) {
  return [
    Math.max(-3, Math.min(6, Math.log2(f.ratio))),
    f.hourDev,
    f.isNewRecipient,
    f.isNewDevice,
    Math.min(f.velocity, 10),
    Math.log10(f.recipientAge + 1),
    Math.min(f.fanIn, 20),
    f.geoMismatch,
  ];
}

function quantile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))];
}

class RiskEngine extends EventEmitter {
  constructor() {
    super();
    this.world = buildWorld();
    this.txs = [];
    this.byId = new Map();
    this.inbound = new Map(); // accountId -> [{userId, ts, amount}]
    this.seq = 1;
    this.clock = Date.now(); // виртуальное время: симулятор «проматывает» минуты
    this.sup = new LogisticModel(); // обучаемая модель: предобучение + решения аналитиков
    this.xById = new Map(); // вектор признаков операции — для дообучения при разметке

    const t0 = performance.now();
    const X = normalHistory(this.world).map(toVector);
    this.forest = new IsolationForest({ nTrees: 150, sampleSize: 256, rng }).fit(X);
    const train = X.map((x) => this.forest.score(x));
    this.mlThreshold = quantile(train, 0.97);
    this.mlInfo = { samples: X.length, trees: 150, features: 8, threshold: +this.mlThreshold.toFixed(3),
      trainMs: Math.round(performance.now() - t0) };

    // Подогреваем «мул-счета»: они уже собирают деньги от разных людей за последние сутки
    const now = Date.now();
    this.world.mules.slice(0, 3).forEach((m, i) => {
      const n = 4 + i * 2;
      for (let k = 0; k < n; k++) {
        this._pushInbound(m.id, `EXT${randInt(100, 999)}`, now - randInt(1, 20) * HOUR, randInt(20, 300) * 1000);
      }
    });
  }

  _pushInbound(accId, userId, ts, amount) {
    if (!this.inbound.has(accId)) this.inbound.set(accId, []);
    this.inbound.get(accId).push({ userId, ts, amount });
  }

  fanIn(accId, excludeUser, now = this.clock) {
    const list = this.inbound.get(accId) || [];
    return new Set(list.filter((x) => now - x.ts < DAY && x.userId !== excludeUser).map((x) => x.userId)).size;
  }

  getUser(id) { return this.world.users.find((u) => u.id === id); }

  resolveRecipient({ recipientId, recipientPhone }) {
    if (recipientId && this.world.accounts.has(recipientId)) return this.world.accounts.get(recipientId);
    if (recipientPhone) {
      const norm = recipientPhone.replace(/\D/g, '');
      for (const a of this.world.accounts.values()) if (a.phone.replace(/\D/g, '') === norm) return a;
      const id = `ACC${String(this.world.accounts.size + 1).padStart(4, '0')}`;
      const a = { id, name: fullName(), phone: recipientPhone, bank: 'Kaspi', ageDays: randInt(30, 2500),
        mule: false, blacklisted: false, reports: 0 };
      this.world.accounts.set(id, a);
      return a;
    }
    throw new Error('recipient required');
  }

  evaluate(input) {
    const t0 = performance.now();
    const user = this.getUser(input.userId);
    if (!user) throw new Error('unknown user');
    const rec = this.resolveRecipient(input);
    const ctx = input.context || {};
    this.clock += input.source === "sim" ? 90e3 : 60e3;
    const now = input.ts || this.clock;
    const amount = Math.max(1, Number(input.amount) || 0);
    const hour = Number.isInteger(input.hour) ? input.hour : new Date(now).getHours();
    const deviceId = input.deviceId || user.mainDevice;
    const city = input.city || user.city;

    const f = {
      ratio: amount / user.avgAmount,
      hourDev: hourDeviation(hour, user.activeHours),
      isNewRecipient: user.known.has(rec.id) ? 0 : 1,
      isNewDevice: user.devices.has(deviceId) ? 0 : 1,
      velocity: user.recent.filter((ts) => now - ts < HOUR).length,
      recipientAge: rec.ageDays,
      fanIn: this.fanIn(rec.id, user.id, now),
      geoMismatch: city !== user.city ? 1 : 0,
    };

    const reasons = [];
    const add = (code, label, points, group) => reasons.push({ code, label, points: Math.round(points), group });

    // --- Поведение клиента
    const z = (amount - user.avgAmount) / user.stdAmount;
    if (f.ratio >= 5) add('AMOUNT_X', `Сумма в ${f.ratio.toFixed(1)}× выше обычной для клиента`, 25, 'behavior');
    else if (z > 3) add('AMOUNT', `Сумма нетипично высокая (${z.toFixed(1)}σ)`, 15, 'behavior');
    if (f.isNewRecipient) add('NEW_RECIP', 'Новый получатель — переводов ему ранее не было', 10, 'behavior');
    if (f.hourDev >= 3) add('ODD_HOUR', `Нетипичное время операции (${String(hour).padStart(2, '0')}:00)`, hour < 6 ? 10 : 6, 'behavior');
    if (f.velocity >= 3) add('VELOCITY', `${f.velocity} операций за последний час`, 15, 'behavior');

    // --- Устройство и сессия
    if (f.isNewDevice) add('NEW_DEVICE', 'Вход с нового устройства', 15, 'session');
    if (f.geoMismatch) add('GEO', `Геолокация (${city}) не совпадает с обычной (${user.city})`, 10, 'session');
    if (ctx.passwordChanged) add('PWD_RESET', 'Пароль / номер телефона изменён < 24 ч назад', 20, 'session');
    if (ctx.remoteAccess) add('REMOTE', 'Активно приложение удалённого доступа (AnyDesk / RustDesk)', 30, 'session');
    if (ctx.onCall) add('ON_CALL', 'Клиент разговаривает по телефону во время перевода', 18, 'session');
    if (ctx.onCall && ctx.callerUnknown) add('CALLER', 'Звонок с незнакомого номера / через мессенджер', 10, 'session');

    // --- Получатель и сеть
    if (rec.blacklisted) add('BLACKLIST', `Получатель в базе жалоб (${rec.reports} обращений)`, 45, 'network');
    if (rec.ageDays < 14) add('YOUNG_ACC', `Счёт получателя открыт ${rec.ageDays} дн. назад`, 15, 'network');
    // Дроп = молодой счёт + много незнакомых отправителей. Старый счёт с потоком — обычно ИП/продавец.
    const youngish = rec.ageDays < 90;
    if (f.fanIn >= 5 && youngish) add('MULE', `Счёт ${rec.ageDays} дн. принял деньги от ${f.fanIn} разных людей за 24 ч — признак дропа`, 28, 'network');
    else if (f.fanIn >= 3 && youngish) add('FANIN', `Получатель за 24 ч принял деньги от ${f.fanIn} разных людей`, 12, 'network');
    else if (f.fanIn >= 8) add('FANIN', `Высокий поток входящих (${f.fanIn} отправителей за 24 ч)`, 5, 'network');

    // --- Текст
    const text = analyzeText(input.comment);
    for (const h of text.hits) add('TEXT', `Комментарий: ${h.cat}`, h.points, 'text');
    // NLP-модель ловит формулировки, которых нет в списке фраз
    const nlp = input.comment ? nb.predict(input.comment) : { prob: 0, words: [] };
    if (!text.hits.length && nlp.prob >= 0.85) {
      add('TEXT_ML', `Комментарий похож на мошеннический (NLP ${Math.round(nlp.prob * 100)}%${nlp.words.length ? ': «' + nlp.words.join('», «') + '»' : ''})`, 14, 'text');
    }

    // --- Комбо-паттерн социальной инженерии
    if (ctx.onCall && f.isNewRecipient && (f.ratio > 3 || text.points > 0)) {
      add('SOCIAL_ENG', 'Паттерн социальной инженерии: звонок + новый получатель + крупная сумма', 15, 'pattern');
    }

    // --- ML: Isolation Forest
    const ml = this.forest.score(toVector(f));
    const mlPts = Math.max(0, Math.min(1, (ml - this.mlThreshold) / 0.12)) * 30;
    if (mlPts >= 3) add('ML', `ML: поведенческая аномалия (Isolation Forest, score ${ml.toFixed(2)})`, mlPts, 'ml');

    // --- Обучаемая модель (логистическая регрессия на размеченных кейсах и решениях аналитиков)
    const x = featurize(f, reasons, ml, nlp.prob);
    const fraudProb = this.sup.trainedOn ? this.sup.predict(x) : null;
    if (fraudProb !== null && fraudProb >= 0.6) {
      const why = this.sup.topFactors(x).join(', ');
      add('SUPERVISED', `Модель, обученная на кейсах банка: вероятность мошенничества ${Math.round(fraudProb * 100)}%${why ? ' (' + why + ')' : ''}`,
        (fraudProb - 0.5) * 50, 'ml');
    }

    const raw = reasons.reduce((s, r) => s + r.points, 0);
    const score = Math.round(100 * (1 - Math.exp(-raw / 45)));
    const decision = score >= T_HOLD ? 'HOLD' : score >= T_CHALLENGE ? 'CHALLENGE' : 'ALLOW';
    reasons.sort((a, b) => b.points - a.points);

    const tx = {
      id: `TX${String(this.seq++).padStart(6, '0')}`,
      ts: now,
      userId: user.id, userName: user.name, userCity: user.city,
      recipient: { id: rec.id, name: rec.name, phone: rec.phone, bank: rec.bank, ageDays: rec.ageDays },
      amount, comment: input.comment || '', hour, deviceId, city, context: ctx,
      features: f, ml: +ml.toFixed(3),
      fraudProb: fraudProb === null ? null : +fraudProb.toFixed(3),
      textProb: +nlp.prob.toFixed(3),
      score, decision, reasons,
      scenario: classify(reasons),
      status: decision === 'ALLOW' ? 'COMPLETED' : decision === 'HOLD' ? 'HELD' : 'PENDING',
      source: input.source || 'client',
      truth: input.truth || null,
      label: null,
      latencyMs: 0,
    };
    tx.latencyMs = +(performance.now() - t0).toFixed(2);

    user.recent.push(now);
    if (user.recent.length > 50) user.recent.shift();
    this._pushInbound(rec.id, user.id, now, amount);
    if (tx.status === 'COMPLETED') user.known.add(rec.id);

    this.txs.push(tx);
    this.byId.set(tx.id, tx);
    this.xById.set(tx.id, x);
    if (this.txs.length > 3000) {
      const old = this.txs.shift();
      this.byId.delete(old.id);
      this.xById.delete(old.id);
    }
    this.emit('tx', tx);
    return tx;
  }

  // Ответ клиента на экран-предупреждение
  confirm(txId, { action, answers = {} }) {
    const tx = this.byId.get(txId);
    if (!tx) throw new Error('unknown tx');
    if (tx.status !== 'PENDING') return tx;
    tx.answers = answers;
    if (action === 'cancel') {
      tx.status = 'CANCELLED';
    } else if (answers.onCall || answers.askedByStranger || answers.knowsRecipient === false) {
      tx.status = 'HELD';
      tx.decision = 'HOLD';
      tx.reasons.unshift({ code: 'ANSWERS', label: 'Ответы клиента указывают на мошенническую схему', points: 30, group: 'pattern' });
      tx.score = Math.max(tx.score, T_HOLD + 5);
    } else {
      tx.status = 'COMPLETED';
      this.getUser(tx.userId)?.known.add(tx.recipient.id);
    }
    this.emit('update', tx);
    return tx;
  }

  // Решение аналитика: обратная связь + сетевой эффект
  review(txId, label) {
    const tx = this.byId.get(txId);
    if (!tx) throw new Error('unknown tx');
    const firstLabel = !tx.label;
    tx.label = label;
    // Самообучение: решение аналитика сразу дообучает модель
    const x = this.xById.get(txId);
    if (x && firstLabel && (label === 'fraud' || label === 'legit')) this.sup.learn(x, label === 'fraud' ? 1 : 0);
    const acc = this.world.accounts.get(tx.recipient.id);
    if (label === 'fraud') {
      tx.status = tx.status === 'COMPLETED' ? 'COMPLETED' : 'BLOCKED';
      if (acc) { acc.reports += 1; if (acc.reports >= 1) acc.blacklisted = true; }
    } else if (label === 'legit' && tx.status === 'HELD') {
      tx.status = 'COMPLETED';
      this.getUser(tx.userId)?.known.add(tx.recipient.id);
    }
    this.emit('update', tx);
    return tx;
  }

  stats() {
    const s = { total: 0, ALLOW: 0, CHALLENGE: 0, HOLD: 0, saved: 0, volume: 0, avgLatency: 0,
      hist: Array(10).fill(0), reasons: {}, scenarios: {},
      truth: { fraud: 0, fraudCaught: 0, legit: 0, legitFlagged: 0 } };
    let lat = 0;
    for (const t of this.txs) {
      s.total++;
      s[t.decision]++;
      s.volume += t.amount;
      lat += t.latencyMs;
      s.hist[Math.min(9, Math.floor(t.score / 10))]++;
      if (t.status === 'HELD' || t.status === 'CANCELLED' || t.status === 'BLOCKED') s.saved += t.amount;
      for (const r of t.reasons) s.reasons[r.code] = (s.reasons[r.code] || 0) + 1;
      if (t.decision !== 'ALLOW') s.scenarios[t.scenario] = (s.scenarios[t.scenario] || 0) + 1;
      if (t.truth === 'fraud') { s.truth.fraud++; if (t.decision !== 'ALLOW') s.truth.fraudCaught++; }
      if (t.truth === 'legit') { s.truth.legit++; if (t.decision !== 'ALLOW') s.truth.legitFlagged++; }
    }
    s.avgLatency = s.total ? +(lat / s.total).toFixed(2) : 0;
    s.recall = s.truth.fraud ? s.truth.fraudCaught / s.truth.fraud : null;
    s.fpr = s.truth.legit ? s.truth.legitFlagged / s.truth.legit : null;
    s.ml = this.mlInfo;
    s.sup = this.sup.info();
    s.ai = this.aiInfo || null;
    return s;
  }

  suspiciousAccounts(now = this.clock) {
    const out = [];
    for (const [id, list] of this.inbound) {
      const acc = this.world.accounts.get(id);
      if (!acc) continue;
      const recent = list.filter((x) => now - x.ts < DAY);
      const senders = new Set(recent.map((x) => x.userId)).size;
      if (senders >= 3 || acc.blacklisted) {
        out.push({ id, name: acc.name, phone: acc.phone, bank: acc.bank, ageDays: acc.ageDays,
          senders, sum: recent.reduce((s, x) => s + x.amount, 0), blacklisted: acc.blacklisted, reports: acc.reports });
      }
    }
    return out.sort((a, b) => b.senders - a.senders).slice(0, 12);
  }
}

function classify(reasons) {
  const has = (c) => reasons.some((r) => r.code === c);
  const textHas = (s) => reasons.some((r) => r.code === 'TEXT' && r.label.includes(s));
  if (has('REMOTE')) return 'Удалённый доступ к телефону';
  if (has('SOCIAL_ENG') || (has('ON_CALL') && textHas('безопасн'))) return 'Социальная инженерия (звонок)';
  if (has('NEW_DEVICE') && (has('PWD_RESET') || has('GEO'))) return 'Захват аккаунта';
  if (textHas('Инвестиции')) return 'Инвестиционная схема';
  if (textHas('Предоплата')) return 'Мошенничество на маркетплейсе';
  if (has('MULE') || has('FANIN') || has('BLACKLIST')) return 'Перевод на дроп / мул-счёт';
  if (textHas('Родственник')) return '«Родственник в беде»';
  if (has('ML')) return 'Поведенческая аномалия';
  return reasons.length ? 'Нетипичная операция' : 'Норма';
}

module.exports = { RiskEngine, T_CHALLENGE, T_HOLD };
