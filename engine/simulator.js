// Генератор потока транзакций: нормальный трафик + атаки разных типов.
// Каждая операция несёт ground truth -> на дашборде считаются recall / FPR.

const { rng, pick, randInt, gauss, CITIES } = require('./data');

class Simulator {
  constructor(engine) {
    this.engine = engine;
    this.timer = null;
    this.fraudRate = 0.12;
    this.intervalMs = 900;
  }

  get running() { return !!this.timer; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  tick() {
    if (rng() < this.fraudRate) this.attack(pick(Object.keys(ATTACKS)));
    else this.normal();
  }

  normal() {
    const w = this.engine.world;
    const u = pick(w.users);
    const known = [...u.known];
    const recipientId = rng() < 0.88 ? pick(known) : pick(w.legit).id;
    const amount = Math.round(Math.max(500, u.avgAmount + gauss() * u.stdAmount) / 100) * 100;
    this._submit({
      userId: u.id, recipientId, amount, hour: randInt(u.activeHours[0], u.activeHours[1]),
      comment: pick(['', '', '', 'за обед', 'долг', 'на подарок', 'коммуналка', 'спасибо!', 'такси']),
      truth: 'legit',
    });
  }

  attack(type) {
    const tx = ATTACKS[type](this.engine);
    if (Array.isArray(tx)) tx.forEach((t, i) => setTimeout(() => this._submit({ ...t, truth: 'fraud', attack: type }), i * 250));
    else this._submit({ ...tx, truth: 'fraud', attack: type });
  }

  _submit(input) {
    const tx = this.engine.evaluate({ ...input, source: 'sim' });
    if (tx.status === 'PENDING') {
      // Клиент видит предупреждение: жертва мошенника чаще отменяет, честный клиент — подтверждает
      setTimeout(() => {
        if (tx.truth === 'fraud') {
          const r = rng();
          if (r < 0.55) this.engine.confirm(tx.id, { action: 'cancel' });
          else if (r < 0.8) this.engine.confirm(tx.id, { action: 'proceed', answers: { onCall: true } });
          else this.engine.confirm(tx.id, { action: 'proceed', answers: { onCall: false, knowsRecipient: true } });
        } else {
          this.engine.confirm(tx.id, rng() < 0.92
            ? { action: 'proceed', answers: { onCall: false, askedByStranger: false, knowsRecipient: true } }
            : { action: 'cancel' });
        }
      }, randInt(1500, 4000));
    }
  }
}

const big = (u, lo, hi) => Math.round((u.avgAmount * (lo + rng() * (hi - lo))) / 1000) * 1000;

const ATTACKS = {
  socialEngineering(e) {
    const u = pick(e.world.users);
    return { userId: u.id, recipientId: pick(e.world.mules).id, amount: big(u, 5, 15),
      comment: pick(['перевод на безопасный счет', 'по указанию службы безопасности', 'резервный счет', '']),
      context: { onCall: true, callerUnknown: true } };
  },
  remoteAccess(e) {
    const u = pick(e.world.users);
    return { userId: u.id, recipientId: pick(e.world.mules).id, amount: big(u, 6, 20),
      context: { remoteAccess: true, onCall: rng() < 0.7, callerUnknown: true } };
  },
  accountTakeover(e) {
    const u = pick(e.world.users);
    return { userId: u.id, recipientId: pick(e.world.mules).id, amount: big(u, 4, 12), hour: randInt(1, 4),
      deviceId: `DEV-X${randInt(100, 999)}`, city: pick(CITIES.filter((c) => c !== u.city)),
      context: { passwordChanged: true } };
  },
  marketplace(e) {
    const u = pick(e.world.users);
    return { userId: u.id, recipientId: pick(e.world.blacklisted.concat(e.world.mules)).id, amount: big(u, 1, 4),
      comment: pick(['предоплата за iPhone, OLX', 'задаток за квартиру', 'доставка + предоплата']) };
  },
  investment(e) {
    const u = pick(e.world.users);
    return { userId: u.id, recipientId: pick(e.world.mules).id, amount: big(u, 3, 10),
      comment: pick(['инвестиции USDT, доход 30% в месяц', 'пополнение на биржу', 'пассивный доход']) };
  },
  muleBurst(e) {
    // Несколько разных людей за секунды переводят на один свежий счёт — сеть дропов
    const mule = pick(e.world.mules);
    const n = randInt(3, 5);
    const senders = [...e.world.users].sort(() => rng() - 0.5).slice(0, n);
    return senders.map((u) => ({ userId: u.id, recipientId: mule.id, amount: big(u, 1, 3),
      comment: pick(['', 'за товар', 'перевод']) }));
  },
};

module.exports = { Simulator, ATTACKS };
