// Синтетические клиенты, счета и история операций (детерминированно, seed).

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(2026);
const pick = (a) => a[Math.floor(rng() * a.length)];
const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));
const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());

const FIRST = ['Айгерим', 'Ерлан', 'Дана', 'Нурлан', 'Асель', 'Тимур', 'Жанар', 'Арман', 'Мадина', 'Данияр',
  'Камила', 'Бауыржан', 'Сауле', 'Ержан', 'Алия', 'Руслан', 'Гульнара', 'Айдос', 'Томирис', 'Санжар'];
const LAST = ['Садык', 'Жумабае', 'Ахмет', 'Касым', 'Бек', 'Оспан', 'Мухамед', 'Сейткалие', 'Абдрахман', 'Исае',
  'Нуржан', 'Тлеу', 'Ибрае', 'Карим', 'Серик', 'Омаро'];
const FEMALE = new Set(['Айгерим', 'Дана', 'Асель', 'Жанар', 'Мадина', 'Камила', 'Сауле', 'Алия', 'Гульнара', 'Томирис']);
const CITIES = ['Тараз', 'Тараз', 'Тараз', 'Алматы', 'Астана', 'Шымкент', 'Караганда'];
const BANKS = ['BCC', 'Kaspi', 'Halyk', 'Freedom', 'Jusan', 'ForteBank'];

function fullName() {
  const f = pick(FIRST);
  let l = pick(LAST);
  l = l.endsWith('е') || l.endsWith('о') ? l + 'в' : l + 'ов';
  if (FEMALE.has(f)) l += 'а';
  return `${f} ${l}`;
}
const phone = () => `+7 ${pick(["700", "701", "702", "705", "707", "708", "747", "771", "775", "777", "778"])} ${randInt(100, 999)} ${randInt(10, 99)} ${randInt(10, 99)}`;

function buildWorld() {
  const accounts = new Map();
  let accSeq = 1;
  const addAccount = (o) => {
    const id = `ACC${String(accSeq++).padStart(4, '0')}`;
    const a = { id, name: fullName(), phone: phone(), bank: pick(BANKS), ageDays: randInt(120, 4000),
      mule: false, blacklisted: false, reports: 0, ...o };
    accounts.set(id, a);
    return a;
  };

  // Легитимные счета
  for (let i = 0; i < 160; i++) addAccount({});
  // Дропы (мул-счета): свежие, собирают деньги со многих отправителей
  const mules = [];
  for (let i = 0; i < 8; i++) mules.push(addAccount({ ageDays: randInt(1, 14), mule: true }));
  // Счета из базы жалоб (blacklist)
  const blacklisted = [];
  for (let i = 0; i < 4; i++) blacklisted.push(addAccount({ ageDays: randInt(5, 60), blacklisted: true, reports: randInt(3, 12) }));

  const legit = [...accounts.values()].filter((a) => !a.mule && !a.blacklisted);
  const users = [];
  for (let i = 0; i < 36; i++) {
    const avg = Math.round(Math.exp(9.3 + gauss() * 0.6)); // ~ 5k..40k ₸
    const known = new Set();
    const nKnown = randInt(3, 8);
    while (known.size < nKnown) known.add(pick(legit).id);
    const dev = `DEV-${randInt(1000, 9999)}`;
    users.push({
      id: `U${String(i + 1).padStart(3, '0')}`,
      name: fullName(),
      city: pick(CITIES),
      avgAmount: avg,
      stdAmount: Math.round(avg * (0.4 + rng() * 0.4)),
      activeHours: [randInt(7, 10), randInt(20, 23)],
      devices: new Set([dev]),
      mainDevice: dev,
      known,
      recent: [], // timestamps последних операций (velocity)
      passwordChangedAt: 0,
    });
  }
  // «Выдержанные» дропы: старые купленные счета — их не видно по возрасту, только по поведению
  const agedMules = [];
  for (let i = 0; i < 6; i++) agedMules.push(addAccount({ ageDays: randInt(120, 900), mule: true }));
  return { accounts, users, mules, blacklisted, legit, agedMules };
}

// Нормальная история — обучающая выборка для Isolation Forest
function normalHistory(world, perUser = 80) {
  const rows = [];
  for (const u of world.users) {
    for (let i = 0; i < perUser; i++) {
      const amount = Math.max(500, u.avgAmount + gauss() * u.stdAmount);
      const hour = randInt(u.activeHours[0], u.activeHours[1]);
      const isNew = rng() < 0.15 ? 1 : 0;
      rows.push({
        ratio: amount / u.avgAmount,
        hourDev: hourDeviation(hour, u.activeHours),
        isNewRecipient: isNew,
        isNewDevice: rng() < 0.03 ? 1 : 0,
        velocity: rng() < 0.85 ? 0 : randInt(1, 2),
        recipientAge: isNew ? randInt(30, 4000) : randInt(120, 4000),
        fanIn: rng() < 0.9 ? randInt(0, 1) : randInt(2, 3),
        geoMismatch: rng() < 0.05 ? 1 : 0,
      });
    }
  }
  return rows;
}

function hourDeviation(hour, [from, to]) {
  if (hour >= from && hour <= to) return 0;
  const d = hour < from ? from - hour : hour - to;
  return Math.min(d, 24 - d);
}

module.exports = { buildWorld, normalHistory, hourDeviation, rng, pick, randInt, gauss, phone, fullName, CITIES };
