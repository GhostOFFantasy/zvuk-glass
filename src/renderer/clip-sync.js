'use strict';
/* Математика автосинхронизации клипа: общая шкала времени, подтверждение кандидатов и фильтр дрейфа.
   Не обращается к DOM, сети или аудио — отдельно проверяется синтетическими последовательностями. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const VERSION = 2;
  const DEAD_ZONE = 0.065;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  const validRate = (r) => finite(r) && r >= 0.97 && r <= 1.03;

  function median(values) {
    const a = values.filter(finite).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function weightedMedian(items, value, weight) {
    const a = items.slice().sort((x, y) => value(x) - value(y));
    const total = a.reduce((s, x) => s + Math.max(0, weight(x)), 0);
    if (!a.length || total <= 0) return NaN;
    let acc = 0;
    for (const x of a) {
      acc += Math.max(0, weight(x));
      if (acc >= total / 2) return value(x);
    }
    return value(a[a.length - 1]);
  }

  /** Точки [мс эпохи, секунды плеера] → положение на общей шкале, скорость и ошибку регрессии. */
  function fitAt(points, at, expectedRate = 1) {
    const p = (points || []).filter((x) => Array.isArray(x) && finite(x[0]) && finite(x[1])).sort((a, b) => a[0] - b[0]);
    if (!p.length) return null;
    const rate0 = validRate(expectedRate) ? expectedRate : 1;
    if (p.length === 1) return { value: p[0][1] + ((at - p[0][0]) / 1000) * rate0, rate: rate0, error: 0, n: 1 };
    const xy = p.map((x) => [(x[0] - at) / 1000, x[1]]);
    const mx = xy.reduce((s, x) => s + x[0], 0) / xy.length;
    const my = xy.reduce((s, x) => s + x[1], 0) / xy.length;
    let xx = 0;
    let xySum = 0;
    for (const x of xy) {
      xx += (x[0] - mx) ** 2;
      xySum += (x[0] - mx) * (x[1] - my);
    }
    let rate = xx > 1e-6 ? xySum / xx : rate0;
    // Скачок времени при перемотке/буферизации не должен превращаться в другую скорость.
    if (!(rate > rate0 * 0.85 && rate < rate0 * 1.15)) rate = rate0;
    const intercept = median(xy.map((x) => x[1] - rate * x[0]));
    const error = median(xy.map((x) => Math.abs(x[1] - (intercept + rate * x[0]))));
    return { value: intercept, rate, error, n: p.length };
  }

  /** Согласование разных музыкальных фрагментов; одиночный аккорд или припев результата не даёт. */
  function decide(shots) {
    const items = [];
    (shots || []).forEach((s, k) => {
      for (const c of s.cands || []) {
        if (finite(c.off) && c.score >= 0.32 && validRate(c.rate == null ? 1 : c.rate)) {
          items.push({ k, at: finite(s.v) ? s.v : k * 20, off: c.off, rate: c.rate == null ? 1 : c.rate, score: c.score });
        }
      }
    });
    const clusters = [];
    for (const anchor of items) {
      const best = new Map();
      for (const it of items) {
        if (Math.abs(it.off - anchor.off) > 0.13 || Math.abs(it.rate - anchor.rate) > 0.0025) continue;
        const old = best.get(it.k);
        if (!old || old.score < it.score) best.set(it.k, it);
      }
      const members = [...best.values()];
      // Два замера одного и того же места — не независимое подтверждение.
      const distinct = members.filter((x, i) => members.findIndex((y) => Math.abs(y.at - x.at) < 6) === i);
      const sum = distinct.reduce((s, x) => s + x.score, 0);
      if (!sum) continue;
      clusters.push({
        n: distinct.length,
        sum,
        mean: sum / distinct.length,
        offset: weightedMedian(distinct, (x) => x.off, (x) => x.score),
        rate: median(distinct.map((x) => x.rate)),
        spread: Math.max(...distinct.map((x) => x.off)) - Math.min(...distinct.map((x) => x.off)),
        members: distinct,
      });
    }
    clusters.sort((a, b) => b.sum - a.sum || a.spread - b.spread);
    const best = clusters.find((x) => x.n >= 2);
    if (!best) return null;
    const rival = clusters.find((x) => Math.abs(x.offset - best.offset) > 0.3 || Math.abs(x.rate - best.rate) > 0.004);
    const margin = rival ? best.sum - rival.sum : best.sum;
    // Два очень чистых разных фрагмента достаточно; в остальных случаях слушаем третий.
    const strong = best.n >= 3 || (best.sum >= 1.45 && best.spread <= 0.04 && margin >= 0.45);
    if (!strong || best.sum < 0.95 || margin < 0.18 || best.spread > 0.18) return null;
    const confidence = clamp((best.mean / 0.75) * 0.55 + Math.min(3, best.n) * 0.1 + clamp(margin / 0.5, 0, 1) * 0.15, 0, 0.99);
    return {
      offset: best.offset,
      rate: best.rate,
      score: best.mean,
      confidence,
      spread: best.spread,
      n: best.n,
      by: `agree${best.n}`,
    };
  }

  /** Медиана и согласованные подтверждения: одиночный скачок сообщения не приводит к коррекции. */
  class DriftFilter {
    constructor() {
      this.samples = [];
      this.pending = null;
    }
    reset() {
      this.samples.length = 0;
      this.pending = null;
    }
    push(value, at, valid = true) {
      if (!valid || !finite(value)) {
        this.reset();
        return null;
      }
      this.samples = this.samples.filter((x) => at - x.at <= 1000 && Math.abs(x.value - value) < 0.4);
      this.samples.push({ value, at });
      if (this.samples.length > 7) this.samples.shift();
      if (this.samples.length < 4) return null;
      const drift = median(this.samples.map((x) => x.value));
      const deviation = median(this.samples.map((x) => Math.abs(x.value - drift)));
      if (deviation > 0.075) {
        this.pending = null;
        return null;
      }
      const p = this.pending;
      if (p && Math.sign(p.drift) === Math.sign(drift) && Math.abs(p.drift - drift) < 0.12) {
        p.n++;
        p.drift = median([p.drift, drift]);
      } else this.pending = { drift, n: 1 };
      if (this.pending.n < 3) return null;
      const out = this.pending.drift;
      this.pending = null;
      return { drift, deviation, samples: this.samples.length };
    }
  }

  /** Скорость меняется только на незаметные 5 %, и лишь когда плеер подтвердил такую возможность. */
  function correction(drift, { fineRate = false } = {}) {
    const ad = Math.abs(drift);
    if (ad < DEAD_ZONE) return { kind: 'none' };
    if (fineRate && ad <= 0.4) {
      const delta = 0.05;
      return { kind: 'rate', rate: drift > 0 ? 1 - delta : 1 + delta, ms: clamp((ad / delta) * 1000, 1000, 6500) };
    }
    // Без подтверждённой микроскорости небольшую ошибку оставляем в мёртвой зоне,
    // а заметную исправляем редкой перемоткой вместо слышимых ×0,75 / ×1,25.
    if (ad < 0.24) return { kind: 'none' };
    return { kind: 'seek' };
  }

  function summarize(history) {
    const a = (history || []).map((x) => Math.abs(x.drift)).filter(finite).sort((x, y) => x - y);
    if (!a.length) return { samples: 0, medianMs: null, maxMs: null, p95Ms: null };
    return {
      samples: a.length,
      medianMs: Math.round(median(a) * 1000),
      maxMs: Math.round(a[a.length - 1] * 1000),
      p95Ms: Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] * 1000),
    };
  }

  function selfTest() {
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push({ name, ok: Boolean(ok), detail });
      if (!ok) throw new Error(`${name}: ${detail}`);
    };
    const pts = Array.from({ length: 50 }, (_, i) => [1000000 + i * 200, 40 + i * 0.2 + (i === 9 ? 0.16 : 0)]);
    const fit = fitAt(pts, 1009800);
    check('timeline', Math.abs(fit.value - 49.8) < 0.025, JSON.stringify(fit));
    const shot = (v, off, score, rate = 1, wrong = null) => ({ v, cands: [{ off, score, rate }, ...(wrong == null ? [] : [{ off: wrong, score: score + 0.05, rate }])] });
    const known = decide([shot(35, 12.345, 0.76), shot(105, 12.35, 0.74)]);
    check('known-offset', known && Math.abs(known.offset - 12.345) < 0.005, JSON.stringify(known));
    const chorus = decide([shot(30, 8, 0.58, 1, 48), shot(90, 8.01, 0.61, 1, 88), shot(155, 7.995, 0.59, 1, 128)]);
    check('repeated-chorus', chorus && Math.abs(chorus.offset - 8) < 0.01 && chorus.n === 3, JSON.stringify(chorus));
    check('one-shot-rejected', decide([shot(30, 5, 0.95)]) === null);
    const mismatch = decide([shot(30, 5, 0.22), shot(90, 17, 0.25), shot(155, -4, 0.28)]);
    check('mismatch-rejected', mismatch === null, JSON.stringify(mismatch));
    const tempo = decide([shot(32, 4.5, 0.7, 1.008), shot(92, 4.505, 0.69, 1.008), shot(160, 4.495, 0.7, 1.008)]);
    check('tempo-drift', tempo && Math.abs(tempo.rate - 1.008) < 0.0001, JSON.stringify(tempo));
    const filter = new DriftFilter();
    [0.02, 0.025, 0.32, 0.021, 0.024, 0.022].forEach((x, i) => filter.push(x, i * 100));
    check('jitter-filter', !filter.pending || Math.abs(filter.pending.drift) < DEAD_ZONE, JSON.stringify(filter.pending));
    filter.push(0.7, 700);
    filter.push(0.7, 800, false);
    check('pause-reset', filter.samples.length === 0 && filter.pending === null);
    check('dead-zone', correction(0.064, { fineRate: true }).kind === 'none');
    check('no-audible-rate-jump', correction(0.2, { fineRate: false }).kind === 'none' && correction(-0.2, { fineRate: true }).rate === 1.05);
    check('confirmed-seek', correction(-0.5, { fineRate: false }).kind === 'seek');
    return { ok: true, version: VERSION, tests: results };
  }

  return { VERSION, DEAD_ZONE, median, fitAt, decide, DriftFilter, correction, summarize, selfTest };
});
