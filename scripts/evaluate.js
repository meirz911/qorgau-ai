// Офлайн-оценка качества: 1500 нормальных переводов + по 50 атак каждого типа.
// Запуск: npm run eval
const { RiskEngine } = require('../engine/risk');
const { Simulator, ATTACKS } = require('../engine/simulator');

const e = new RiskEngine();
const sim = new Simulator(e);
const rows = {};
const run = (label, input) => {
  const t = e.evaluate({ ...input, source: 'sim' });
  const r = (rows[label] ??= { n: 0, ALLOW: 0, CHALLENGE: 0, HOLD: 0, avgScore: 0 });
  r.n++; r[t.decision]++; r.avgScore += t.score;
};
sim._submit = (input) => run(input.attack || 'legit (норма)', input);
for (let i = 0; i < 1500; i++) sim.normal();
for (const type of Object.keys(ATTACKS)) for (let i = 0; i < 50; i++) {
  const tx = ATTACKS[type](e);
  (Array.isArray(tx) ? tx : [tx]).forEach((t) => run(type, { ...t, truth: 'fraud' }));
}
for (const r of Object.values(rows)) r.avgScore = Math.round(r.avgScore / r.n);
console.log(`\nQorgau AI — оценка на синтетических данных (iForest: ${e.mlInfo.samples} обуч. операций)\n`);
console.table(rows);
const s = e.stats();
console.log(`Recall (поймано мошенничества): ${(s.recall * 100).toFixed(1)}%`);
console.log(`FPR (честных с трением):        ${(s.fpr * 100).toFixed(1)}%  — только мягкое предупреждение, не блокировка`);
console.log(`Среднее время решения:          ${s.avgLatency} мс\n`);
