// Обучаемая модель (логистическая регрессия, SGD) поверх сигналов риск-движка.
// 1) Предобучается на размеченной истории (синтетический архив кейсов).
// 2) Дообучается онлайн на каждом решении аналитика «мошенничество / легитимно».
// Так система учится на опыте банка, а не только на заранее написанных правилах.

const CODES = ['AMOUNT_X', 'AMOUNT', 'NEW_RECIP', 'ODD_HOUR', 'VELOCITY', 'NEW_DEVICE', 'GEO', 'PWD_RESET',
  'REMOTE', 'ON_CALL', 'CALLER', 'BLACKLIST', 'YOUNG_ACC', 'MULE', 'FANIN', 'TEXT', 'SOCIAL_ENG', 'ML'];

const NUMERIC = ['Сумма к норме (log)', 'Отклонение по времени', 'Частота за час', 'Возраст счёта (log)',
  'Отправителей получателю', 'ML-аномалия', 'Текст: вероятность скама'];

const CODE_NAMES = {
  AMOUNT_X: 'крупная сумма', AMOUNT: 'сумма выше нормы', NEW_RECIP: 'новый получатель', ODD_HOUR: 'необычное время',
  VELOCITY: 'частые операции', NEW_DEVICE: 'новое устройство', GEO: 'другой город', PWD_RESET: 'смена пароля',
  REMOTE: 'удалённый доступ', ON_CALL: 'звонок', CALLER: 'неизвестный номер', BLACKLIST: 'база жалоб',
  YOUNG_ACC: 'свежий счёт', MULE: 'признак дропа', FANIN: 'много отправителей', TEXT: 'фраза мошенников',
  SOCIAL_ENG: 'паттерн соц. инженерии', ML: 'аномалия iForest',
};
const FEATURE_NAMES = [...CODES.map((c) => CODE_NAMES[c]), ...NUMERIC.map((n) => n.toLowerCase())];

function featurize(f, reasons, ml, textProb) {
  const has = new Set(reasons.map((r) => r.code));
  return [
    ...CODES.map((c) => (has.has(c) ? 1 : 0)),
    Math.max(-1, Math.min(1.5, Math.log2(Math.max(f.ratio, 1e-3)) / 4)),
    Math.min(f.hourDev, 12) / 6,
    Math.min(f.velocity, 10) / 5,
    Math.log10(f.recipientAge + 1) / 4,
    Math.min(f.fanIn, 20) / 10,
    ml,
    textProb,
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

class LogisticModel {
  constructor(dim = FEATURE_NAMES.length) {
    this.w = new Array(dim).fill(0);
    this.b = 0;
    this.trainedOn = 0;
    this.feedback = 0;
  }

  predict(x) {
    let z = this.b;
    for (let i = 0; i < x.length; i++) z += this.w[i] * x[i];
    return sigmoid(z);
  }

  update(x, y, lr = 0.05, l2 = 1e-4) {
    const err = this.predict(x) - y;
    for (let i = 0; i < x.length; i++) this.w[i] -= lr * (err * x[i] + l2 * this.w[i]);
    this.b -= lr * err;
  }

  fit(X, Y, { epochs = 30, lr = 0.1, rng = Math.random } = {}) {
    const idx = [...X.keys()];
    for (let e = 0; e < epochs; e++) {
      idx.sort(() => rng() - 0.5);
      for (const i of idx) this.update(X[i], Y[i], lr * (1 - e / (epochs + 1)));
    }
    this.trainedOn = X.length;
    return this;
  }

  // Онлайн-дообучение по решению аналитика: несколько шагов, чтобы решение «весило»
  learn(x, y) {
    for (let k = 0; k < 5; k++) this.update(x, y, 0.1);
    this.feedback++;
  }

  topFactors(x, n = 3) {
    return x.map((v, i) => ({ name: FEATURE_NAMES[i], c: v * this.w[i] }))
      .filter((t) => t.c > 0.05).sort((a, b) => b.c - a.c).slice(0, n).map((t) => t.name);
  }

  info() {
    const top = this.w.map((w, i) => ({ name: FEATURE_NAMES[i], w: +w.toFixed(2) }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 6);
    return { trainedOn: this.trainedOn, feedback: this.feedback, top };
  }
}

module.exports = { LogisticModel, featurize, FEATURE_NAMES };
