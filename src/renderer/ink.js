'use strict';
/* Контрастный текст над клипом: целая заливка и обводка, без карт цвета и «наливания».
   Один захват WebView2 обслуживает все элементы. Кадр не сохраняется и никуда не отправляется. */
(function () {
  const PERIOD = 140;
  const WIDTH = 512;
  const PAD = 11;
  const HISTORY = 5;
  const VOTES = 3;
  const COOLDOWN = 1200;
  const FADE = 900;
  const MIN_CONTRAST = 3.1;
  const TEXT = '.np-title, .np-artist, .np-source, #vizTitle, #vizArtist';
  const BRIGHT_BG = '.clip-box.clip-on, .vz-media video, .vz-img:not(.blur)';
  const LIGHT = [241, 246, 255];
  const live = new Map();
  const stats = { frames: 0, frameMs: 0 };
  const hist = new Uint16Array(32);
  let timer = 0;
  let busy = false;
  let raf = 0;
  let epoch = 0;

  function targets() {
    const np = document.getElementById('nowPlaying');
    if (np && !np.classList.contains('hidden')) {
      if (!np.classList.contains('viz-on') || !np.querySelector(BRIGHT_BG)) return [];
      return [
        ...np.querySelectorAll('.np-close, .np-source, .np-title, .np-artist, .np-seek, .np-controls > *, #npLike, #npLyricsBtn, #npVizBtn, #npEqBtn, .np-actions > [data-act="current-menu"], .np-vol, .vz-gear'),
        ...document.querySelectorAll('.win-ctrls'),
      ];
    }
    const stage = document.getElementById('vizStage');
    if (stage && stage.isConnected && stage.querySelector(BRIGHT_BG)) return [...stage.querySelectorAll('#vizTitle, #vizArtist, .vz-ctrl > *, .vz-fs, .vz-gear')];
    return [];
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const linearLuma = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  const contrast = (a, b) => {
    const la = linearLuma(clamp01(a)) + 0.05;
    const lb = linearLuma(clamp01(b)) + 0.05;
    return Math.max(la, lb) / Math.min(la, lb);
  };
  const rgbLuma = (rgb) => (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  const LIGHT_LUMA = rgbLuma(LIGHT);

  function darkRGB() {
    return [0, 0, 0];
  }
  function inkRGB(l) {
    return contrast(LIGHT_LUMA, l) < MIN_CONTRAST ? darkRGB(l) : LIGHT;
  }

  /** Меняем цвет только при потере контраста; широкий гистерезис гасит частые смены кадра. */
  function desiredInk(l, current) {
    if (current === 0 && l > 0.4 && contrast(LIGHT_LUMA, l) < MIN_CONTRAST) return 1;
    if (current === 1 && l < 0.44 && contrast(rgbLuma(darkRGB(l)), l) < MIN_CONTRAST) return 0;
    return current;
  }

  function percentile(histogram, n, q) {
    let acc = 0;
    for (let b = 0; b < histogram.length; b++) {
      acc += histogram[b];
      if (acc >= n * q) return (b + 0.5) / histogram.length;
    }
    return 1;
  }

  /** Основной фон вокруг всего элемента; яркие пиксели букв в замер не попадают. */
  function ringLuma(px, w, h, r, kx, ky) {
    const x0 = Math.max(0, Math.floor((r.left - PAD) * kx));
    const y0 = Math.max(0, Math.floor((r.top - PAD) * ky));
    const x1 = Math.min(w - 1, Math.ceil((r.right + PAD) * kx));
    const y1 = Math.min(h - 1, Math.ceil((r.bottom + PAD) * ky));
    const ix0 = r.left * kx;
    const ix1 = r.right * kx;
    const iy0 = r.top * ky;
    const iy1 = r.bottom * ky;
    hist.fill(0);
    let sum = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      const inY = y > iy0 && y < iy1;
      for (let x = x0; x <= x1; x++) {
        if (inY && x > ix0 && x < ix1) continue;
        const l = px[y * w + x] / 255;
        sum += l;
        hist[Math.min(31, (l * 32) | 0)]++;
        n++;
      }
    }
    if (!n) return null;
    const p25 = percentile(hist, n, 0.25);
    const p75 = percentile(hist, n, 0.75);
    const base = sum / n * 0.2 + percentile(hist, n, 0.5) * 0.55 + percentile(hist, n, 0.7) * 0.25;
    // На контрастном стыке оставляем светлые буквы с тёмным контуром: единый чёрный цвет
    // исчез бы на тёмной части кадра. На однородном светлом фоне текст остаётся чисто чёрным.
    if (p75 - p25 > 0.48 && p25 < 0.4) return Math.min(base, 0.28);
    return base;
  }

  async function frame() {
    const started = performance.now();
    const r = await window.zvuk.ui.probe(WIDTH);
    if (!r || !r.data) return null;
    const bin = atob(r.data);
    const px = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
    stats.frames++;
    stats.frameMs = stats.frameMs * 0.9 + (performance.now() - started) * 0.1;
    return { w: r.w, h: r.h, px };
  }

  /** Сохранено для диагностики строк: реальные границы текста, а не всего контейнера. */
  function textBox(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const text = el.textContent.trim();
    if (!text || !r.width || !r.height) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const tr = range.getBoundingClientRect();
    const ctx = textBox.ctx || (textBox.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = cs.font;
    const spacing = parseFloat(cs.letterSpacing) || 0;
    const advance = ctx.measureText(text).width + spacing * Math.max(0, [...text].length - 1);
    const natural = Math.min(r.width, Math.max(advance, tr.width || 0));
    let textLeft = r.left;
    if (cs.textAlign === 'center') textLeft += (r.width - natural) / 2;
    else if (cs.textAlign === 'right' || cs.textAlign === 'end') textLeft += r.width - natural;
    const pad = Math.max(3, Math.ceil(parseFloat(cs.fontSize) * 0.12));
    const left = textLeft - pad;
    const width = natural + pad * 2;
    return { left, right: left + width, top: r.top, bottom: r.bottom, width, height: r.height,
      cssLeft: left - r.left, cssWidth: width, textLeft: textLeft - r.left, textWidth: natural };
  }

  function enabled() {
    return !window.ZG_MOBILE && Boolean(window.App?.settings?.viz) && App.settings.viz.inkEnabled !== false;
  }

  function paintInitial(el, st, l) {
    el.classList.add('inkable');
    if (el.matches(TEXT)) el.classList.add('ink-text');
    const [r, g, b] = darkRGB(l);
    el.style.setProperty('--ink-dark', `rgb(${r} ${g} ${b})`);
    el.style.setProperty('--ink', st.ink.toFixed(3));
    el.style.setProperty('--bgl', l.toFixed(3));
  }

  async function measure() {
    if (!enabled()) {
      epoch++;
      clear();
      busy = false;
      return;
    }
    if (busy || document.body.classList.contains('win-hidden') || document.hidden) return;
    const els = targets();
    if (!els.length) return clear();
    const ticket = epoch;
    busy = true;
    try {
      const f = await frame();
      if (ticket !== epoch || !enabled() || !f) return;
      const kx = f.w / window.innerWidth;
      const ky = f.h / window.innerHeight;
      const now = performance.now();
      const seen = new Set();
      for (const el of els) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const l = ringLuma(f.px, f.w, f.h, r, kx, ky);
        if (l == null) continue;
        seen.add(el);
        let st = live.get(el);
        if (!st) {
          const target = desiredInk(l, 0);
          st = { ink: target, target, votes: 0, flipAt: -Infinity, lf: l, bgl: l, bglT: l,
            history: Array(HISTORY).fill(l), lastSample: now };
          live.set(el, st);
          paintInitial(el, st, l);
        }
        const sampleDt = Math.min(500, now - st.lastSample);
        st.lastSample = now;
        st.history.push(l);
        if (st.history.length > HISTORY) st.history.shift();
        const ordered = st.history.slice().sort((a, b) => a - b);
        const median = ordered[(ordered.length / 2) | 0];
        st.lf += (median - st.lf) * (1 - Math.exp(-sampleDt / 240));
        const want = desiredInk(st.lf, st.target);
        st.votes = want !== st.target ? st.votes + 1 : 0;
        const currentLuma = st.target ? rgbLuma(darkRGB(st.lf)) : LIGHT_LUMA;
        const urgent = contrast(currentLuma, st.lf) < 1.65;
        if (st.votes >= (urgent ? 1 : VOTES) && now - st.flipAt >= COOLDOWN) {
          st.target = want;
          st.flipAt = now;
          st.votes = 0;
        }
        st.bglT = st.lf;
        el.dataset.luma = st.lf.toFixed(2);
      }
      for (const el of [...live.keys()]) if (!seen.has(el)) reset(el);
      animate();
    } catch {
      /* Следующий замер начнётся без накопления запросов. */
    } finally {
      if (ticket === epoch) busy = false;
    }
  }

  function animate() {
    if (raf) return;
    let last = performance.now();
    const step = (now) => {
      raf = 0;
      const dt = Math.min(64, now - last);
      last = now;
      let moving = false;
      for (const [el, st] of live) {
        if (st.bgl !== st.bglT) {
          const d = st.bglT - st.bgl;
          st.bgl = Math.abs(d) < 0.004 ? st.bglT : st.bgl + d * Math.min(1, dt / 240);
          el.style.setProperty('--bgl', st.bgl.toFixed(3));
          const [r, g, b] = darkRGB(st.bgl);
          el.style.setProperty('--ink-dark', `rgb(${r} ${g} ${b})`);
          if (st.bgl !== st.bglT) moving = true;
        }
        if (st.ink === st.target) continue;
        const d = st.target - st.ink;
        st.ink = Math.abs(d) < 0.002 ? st.target : st.ink + Math.sign(d) * Math.min(Math.abs(d), dt / FADE);
        const e = st.ink * st.ink * (3 - 2 * st.ink);
        el.style.setProperty('--ink', e.toFixed(4));
        if (st.ink !== st.target) moving = true;
      }
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function reset(el) {
    el.classList.remove('inkable', 'ink-text', 'water-ink');
    for (const p of ['--ink', '--bgl', '--ink-dark', 'background-image', 'background-size', 'background-position', 'color', '-webkit-text-fill-color']) el.style.removeProperty(p);
    delete el.dataset.luma;
    live.delete(el);
  }
  function clear() {
    for (const el of [...live.keys()]) reset(el);
  }

  const Ink = {
    start() {
      if (!enabled()) return;
      if (!timer) {
        epoch++;
        timer = setInterval(measure, PERIOD);
        measure();
      }
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      epoch++;
      busy = false;
      cancelAnimationFrame(raf);
      raf = 0;
      clear();
    },
    measure,
    enabled,
    _boxForTest: textBox,
    _test: { darkRGB, inkRGB, contrast, rgbLuma, desiredInk, fade: FADE, cooldown: COOLDOWN, history: HISTORY },
    async debugLuma(r) {
      const f = await frame();
      if (!f) return null;
      const kx = f.w / window.innerWidth;
      const ky = f.h / window.innerHeight;
      let s = 0;
      let n = 0;
      for (let y = Math.floor(r.top * ky); y < Math.min(f.h, Math.ceil(r.bottom * ky)); y++)
        for (let x = Math.floor(r.left * kx); x < Math.min(f.w, Math.ceil(r.right * kx)); x++) {
          s += f.px[y * f.w + x] / 255;
          n++;
        }
      return { mean: n ? s / n : 0, size: `${f.w}x${f.h}` };
    },
    get state() {
      return [...live].map(([el, st]) => ({ el, ink: st.ink, target: st.target, luma: +(el.dataset.luma || 0), text: el.classList.contains('ink-text'), votes: st.votes }));
    },
    get stats() {
      return { ...stats, period: PERIOD, width: WIDTH, active: live.size };
    },
  };
  window.Ink = Ink;
})();
