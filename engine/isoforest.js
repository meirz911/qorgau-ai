// Isolation Forest — реализация с нуля (Liu, Ting, Zhou 2008), без зависимостей.
// Идея: аномальные транзакции изолируются случайными разбиениями быстрее нормальных.

const EULER = 0.5772156649;

function c(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

class IsolationForest {
  constructor({ nTrees = 150, sampleSize = 256, rng = Math.random } = {}) {
    this.nTrees = nTrees;
    this.sampleSize = sampleSize;
    this.rng = rng;
    this.trees = [];
  }

  fit(X) {
    this.m = Math.min(this.sampleSize, X.length);
    const limit = Math.ceil(Math.log2(this.m));
    this.trees = [];
    for (let t = 0; t < this.nTrees; t++) {
      const sample = [];
      for (let i = 0; i < this.m; i++) sample.push(X[Math.floor(this.rng() * X.length)]);
      this.trees.push(this._build(sample, 0, limit));
    }
    return this;
  }

  _build(X, depth, limit) {
    if (depth >= limit || X.length <= 1) return { size: X.length };
    const dims = X[0].length;
    const order = [...Array(dims).keys()].sort(() => this.rng() - 0.5);
    for (const f of order) {
      let min = Infinity, max = -Infinity;
      for (const x of X) { if (x[f] < min) min = x[f]; if (x[f] > max) max = x[f]; }
      if (max > min) {
        const v = min + this.rng() * (max - min);
        const L = [], R = [];
        for (const x of X) (x[f] < v ? L : R).push(x);
        return { f, v, l: this._build(L, depth + 1, limit), r: this._build(R, depth + 1, limit) };
      }
    }
    return { size: X.length };
  }

  _path(x, node, d) {
    while (node.size === undefined) {
      node = x[node.f] < node.v ? node.l : node.r;
      d++;
    }
    return d + c(node.size);
  }

  // 0..1, где > ~0.6 — явная аномалия
  score(x) {
    let sum = 0;
    for (const t of this.trees) sum += this._path(x, t, 0);
    return Math.pow(2, -(sum / this.trees.length) / c(this.m));
  }
}

module.exports = { IsolationForest };
