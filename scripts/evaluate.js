// Офлайн-оценка качества. Запуск: npm run eval
// Обучаемая модель предобучается на ОТДЕЛЬНОМ синтетическом мире (другие клиенты и счета),
// а проверяется на этом — чтобы не было утечки.
// Две группы атак: «типовые» (как в демо) и «замаскированные» (мошенник старается выглядеть обычно).

const { RiskEngine, T_CHALLENGE, T_HOLD } = require('../engine/risk');
const { Simulator, ATTACKS, STEALTH, pretrainSupervised } = require('../engine/simulator');
const { rng } = require('../engine/data');
const { nb, SCAM, LEGIT } = require('../engine/nlp');

const e = new RiskEngine();
const pre = pretrainSupervised(e);
const sim = new Simulator(e);

const records = [];
sim._submit = (input) => {
  const tx = e.evaluate({ ...input, source: 'sim' });
  // Решение БЕЗ обучаемой модели — для сравнения (ablation)
  const raw = tx.reasons.filter((r) => r.code !== 'SUPERVISED').reduce((s, r) => s + r.points, 0);
  const base = Math.round(100 * (1 - Math.exp(-raw / 45)));
  records.push({ group: input.group, type: input.attack || 'норма', truth: input.truth, full: tx.score, base });
};

const jobs = [];
for (let i = 0; i < 3000; i++) jobs.push(() => sim.normal());
const addAttacks = (gens, group) => {
  for (const [type, g] of Object.entries(gens)) {
    for (let i = 0; i < 50; i++) {
      jobs.push(() => {
        const tx = g(e);
        (Array.isArray(tx) ? tx : [tx]).forEach((t) => sim._submit({ ...t, truth: 'fraud', attack: type, group }));
      });
    }
  }
};
addAttacks(ATTACKS, 'типовые');
addAttacks(STEALTH, 'замаскированные');
jobs.sort(() => rng() - 0.5);
jobs.forEach((j) => j());

const flagged = (s) => s >= T_CHALLENGE;
const held = (s) => s >= T_HOLD;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

function metrics(key) {
  const legit = records.filter((r) => r.truth === 'legit');
  const row = (rs) => ({ n: rs.length, flagged: rs.filter((r) => flagged(r[key])).length, held: rs.filter((r) => held(r[key])).length });
  const std = row(records.filter((r) => r.group === 'типовые'));
  const st = row(records.filter((r) => r.group === 'замаскированные'));
  const lg = row(legit);
  const tp = std.flagged + st.flagged;
  return {
    'Типовые атаки: выявлено': pct(std.flagged, std.n),
    'Замаскированные: выявлено': pct(st.flagged, st.n),
    'Замаскированные: задержано': pct(st.held, st.n),
    'Честные: предупреждение': pct(lg.flagged - lg.held, lg.n),
    'Честные: задержано': pct(lg.held, lg.n),
    'Precision (точность флага)': pct(tp, tp + lg.flagged),
  };
}

console.log(`\nQorgau AI — оценка качества`);
console.log(`Обучаемая модель: предобучена на ${pre.samples} кейсах (${pre.frauds} мошеннических) из другого мира`);
console.log(`Тест: ${records.filter((r) => r.truth === 'legit').length} честных переводов, ` +
  `${records.filter((r) => r.group === 'типовые').length} типовых и ${records.filter((r) => r.group === 'замаскированные').length} замаскированных атак\n`);

const table = { 'Правила + iForest': metrics('base'), '+ обучаемая модель': metrics('full') };
console.table(table);

const byType = {};
for (const r of records.filter((x) => x.truth === 'fraud')) {
  const t = (byType[r.type] ??= { группа: r.group, n: 0, 'выявлено (правила)': 0, 'выявлено (+модель)': 0 });
  t.n++;
  if (flagged(r.base)) t['выявлено (правила)']++;
  if (flagged(r.full)) t['выявлено (+модель)']++;
}
for (const t of Object.values(byType)) {
  t['выявлено (правила)'] = pct(t['выявлено (правила)'], t.n);
  t['выявлено (+модель)'] = pct(t['выявлено (+модель)'], t.n);
}
console.log('По типам атак:');
console.table(byType);

// NLP: leave-one-out на корпусе (честная оценка на текстах, которых модель не видела)
let correct = 0;
const all = [...SCAM.map((t) => [t, 1]), ...LEGIT.map((t) => [t, 0])];
const NB = nb.constructor;
for (let i = 0; i < all.length; i++) {
  const m = new NB();
  all.forEach(([t, y], j) => { if (j !== i) m.add(t, y ? 'scam' : 'legit'); });
  const p = m.predict(all[i][0]).prob;
  if ((p >= 0.5 ? 1 : 0) === all[i][1]) correct++;
}
console.log(`NLP (Naive Bayes), leave-one-out на ${all.length} текстах RU/KZ: точность ${pct(correct, all.length)}`);
const s = e.stats();
console.log(`Среднее время решения: ${s.avgLatency} мс\n`);
