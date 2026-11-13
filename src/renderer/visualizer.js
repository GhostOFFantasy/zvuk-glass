'use strict';
/* Визуализатор под ритм музыки: несколько стилей отрисовки, общий цикл анализа звука */
(function () {
  const STYLES = [
    { id: 'bars', name: 'Столбцы' },
    { id: 'mirror', name: 'Зеркало' },
    { id: 'ring', name: 'Кольцо' },
    { id: 'wave', name: 'Волна' },
    { id: 'particles', name: 'Частицы' },
  ];
  const COLORS = [
    { id: 'accent', name: 'Цвет темы' },
    { id: 'rainbow', name: 'Радуга' },
    { id: 'white', name: 'Белый' },
  ];

  const handles = new Set();
  let raf = 0;
  let freq = null;
  let time = null;
  let colorsAt = 0;
  let accent = '#9d8cff';
  let accent2 = '#ff7ab6';
  let tIdle = 0;

  const Viz = {
    STYLES,
    COLORS,
    bass: 0, // 0..1 энергия низких частот
    level: 0, // 0..1 общая громкость
    beat: 0, // затухающий импульс на сильной доле
    _bassAvg: 0,

    /** Подключить canvas. opts: { style, color, sensitivity, bars, glow, idle, onFrame } */
    attach(canvas, opts = {}) {
      const h = {
        canvas,
        g: canvas.getContext('2d'),
        opts: { style: 'bars', color: 'accent', sensitivity: 1, bars: 72, glow: true, idle: true, alpha: 1, ...opts },
        vals: null,
        peaks: null,
        parts: [],
      };
      handles.add(h);
      start();
      return {
        set(o) {
          Object.assign(h.opts, o);
          h.vals = null;
        },
        stop() {
          handles.delete(h);
        },
      };
    },
  };

  function start() {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // Цвета темы в виде [r,g,b] — для мягких полупрозрачных градиентов
  const norm = document.createElement('canvas').getContext('2d');
  let accRGB = [157, 140, 255];
  let acc2RGB = [255, 122, 182];
  const toRGB = (c, fb) => {
    norm.fillStyle = '#000';
    norm.fillStyle = c;
    const v = norm.fillStyle;
    if (v[0] === '#' && v.length === 7) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
    const m = v.match(/\d+(\.\d+)?/g);
    return m ? m.slice(0, 3).map(Number) : fb;
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function readColors() {
    const now = performance.now();
    if (now - colorsAt < 400) return;
    colorsAt = now;
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue('--accent').trim() || accent;
    accent2 = cs.getPropertyValue('--accent-2').trim() || accent2;
    accRGB = toRGB(accent, accRGB);
    acc2RGB = toRGB(accent2, acc2RGB);
  }

  /** Среднее значение спектра в полосе частот (0..1). */
  function band(fLo, fHi) {
    const a = AudioFX.analyser;
    const nyq = AudioFX.ctx.sampleRate / 2;
    const n = a.frequencyBinCount;
    let i0 = Math.max(1, Math.floor((fLo / nyq) * n));
    let i1 = Math.max(i0 + 1, Math.ceil((fHi / nyq) * n));
    let s = 0;
    for (let i = i0; i < i1 && i < n; i++) s += freq[i];
    return s / ((i1 - i0) * 255);
  }

  function loop() {
    raf = 0;
    for (const h of [...handles]) if (!h.canvas.isConnected) handles.delete(h);
    if (!handles.size) return;
    raf = requestAnimationFrame(loop);
    readColors();
    const live = AudioFX.ready && !Player.audio.paused;
    tIdle += 0.016;
    if (AudioFX.ready) {
      const a = AudioFX.analyser;
      if (!freq || freq.length !== a.frequencyBinCount) {
        freq = new Uint8Array(a.frequencyBinCount);
        time = new Uint8Array(a.fftSize);
      }
      a.getByteFrequencyData(freq);
      a.getByteTimeDomainData(time);
      const b = live ? band(30, 160) : 0;
      Viz.bass = Viz.bass * 0.6 + b * 0.4;
      Viz.level = Viz.level * 0.7 + (live ? band(30, 12000) : 0) * 0.3;
      // Бит: бас заметно выше скользящего среднего
      Viz._bassAvg = Viz._bassAvg * 0.95 + b * 0.05;
      if (live && b > Viz._bassAvg * 1.25 && b > 0.45 && Viz.beat < 0.3) Viz.beat = 1;
      Viz.beat *= 0.9;
    }
    Viz.onTick && Viz.onTick(Viz, live);
    // Пока открыт полноэкранный плеер, холсты под ним не рисуем
    const npEl = document.getElementById('nowPlaying');
    const npOpen = npEl && !npEl.classList.contains('hidden');
    const now = performance.now();
    for (const h of handles) {
      if (npOpen && !npEl.contains(h.canvas)) continue;
      // ограничение частоты для второстепенных холстов (мини-визуализатор, кольцо)
      if (h.opts.fps) {
        if (now - (h._last || 0) < 1000 / h.opts.fps - 3) continue;
        h._last = now;
      }
      draw(h, live);
    }
  }

  function fit(h) {
    const c = h.canvas;
    const dpr = Math.min(h.opts.maxDpr || 2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const ht = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== ht) {
      c.width = w;
      c.height = ht;
    }
    return { w, h: ht, dpr };
  }

  /** Значения столбцов в логарифмической шкале 35 Гц – 16 кГц. */
  function values(h, live, n) {
    if (!h.vals || h.vals.length !== n) {
      h.vals = new Float32Array(n);
      h.peaks = new Float32Array(n);
    }
    const s = h.opts.sensitivity || 1;
    for (let j = 0; j < n; j++) {
      let v;
      if (live) {
        const f0 = 35 * Math.pow(16000 / 35, j / n);
        const f1 = 35 * Math.pow(16000 / 35, (j + 1) / n);
        v = Math.pow(band(f0, f1), 1.35) * s * (1 + j / n * 0.6);
      } else if (h.opts.idle) {
        v = 0.05 + 0.04 * Math.sin(tIdle * 1.6 + j * 0.35) + 0.03 * Math.sin(tIdle * 0.7 + j * 0.13);
      } else v = 0;
      v = Math.min(1, v);
      if (h.opts.soft) h.vals[j] = v > h.vals[j] ? h.vals[j] * 0.72 + v * 0.28 : h.vals[j] * 0.94 + v * 0.06;
      else h.vals[j] = v > h.vals[j] ? h.vals[j] * 0.35 + v * 0.65 : h.vals[j] * 0.88 + v * 0.12;
      h.peaks[j] = Math.max(h.vals[j], h.peaks[j] - 0.008);
    }
    return h.vals;
  }

  function paint(g, w, ht, h, i, n, alpha = 1) {
    const c = h.opts.color;
    if (c === 'rainbow') return `hsla(${Math.round((i / n) * 300 + tIdle * 20) % 360} 90% 65% / ${alpha})`;
    if (c === 'white') return `rgba(255,255,255,${alpha})`;
    return null; // градиент темы
  }
  function themeGradient(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, accent);
    gr.addColorStop(1, accent2);
    return gr;
  }
  function roundBar(g, x, y, w, hh, r) {
    r = Math.min(r, w / 2, Math.abs(hh) / 2);
    g.beginPath();
    g.roundRect(x, y, w, hh, r);
    g.fill();
  }

  function draw(h, live) {
    const { w, h: ht, dpr } = fit(h);
    const g = h.g;
    const o = h.opts;
    // Визуализация может реагировать только на «свой» источник (например, только на волну)
    if (live && o.liveIf && !o.liveIf()) live = false;
    if (o.style === 'none') {
      if (!h.blank) {
        g.clearRect(0, 0, w, ht);
        h.blank = true;
      }
      return;
    }
    // Музыки нет, «дыхания» нет и всё уже погасло — холст не трогаем вовсе (никакой перерисовки)
    if (!live && !o.idle && h.vals) {
      let mx = 0;
      for (let i = 0; i < h.vals.length; i++) if (h.vals[i] > mx) mx = h.vals[i];
      if (mx < 0.01) {
        if (!h.blank) {
          g.clearRect(0, 0, w, ht);
          h.blank = true;
        }
        o.onFrame && o.onFrame(Viz);
        return;
      }
    }
    h.blank = false;
    g.clearRect(0, 0, w, ht);
    g.globalAlpha = o.alpha;
    g.globalCompositeOperation = 'source-over';
    g.shadowBlur = 0;
    const style = o.style;
    if (style === 'bars' && o.soft) {
      drawSoftBars(h, live, w, ht, dpr);
    } else if (style === 'waves') {
      drawWaves(h, live, w, ht, dpr);
    } else if (style === 'aura') {
      drawAura(h, live, w, ht, dpr);
    } else if (style === 'bars' || style === 'mirror') {
      const n = o.bars;
      const vals = values(h, live, n);
      // Без музыки и без «дыхания» ничего не рисуем — иначе внизу остаётся пунктир
      let mx = 0;
      for (let i = 0; i < n; i++) mx = Math.max(mx, vals[i]);
      if (mx < 0.01) {
        g.globalAlpha = 1;
        o.onFrame && o.onFrame(Viz);
        return;
      }
      const gap = Math.max(1, (w / n) * 0.28);
      const bw = w / n - gap;
      const grad = themeGradient(g, 0, 0, w, 0);
      if (o.glow) {
        g.shadowBlur = 18 * dpr;
        g.shadowColor = accent;
      }
      for (let i = 0; i < n; i++) {
        const x = i * (bw + gap) + gap / 2;
        const v = vals[i];
        g.fillStyle = paint(g, w, ht, h, i, n) || grad;
        if (style === 'bars') {
          const bh = Math.max(2 * dpr, v * ht * 0.92);
          roundBar(g, x, ht - bh, bw, bh, bw / 2);
          if (o.peaksOn !== false) {
            const py = ht - h.peaks[i] * ht * 0.92 - 6 * dpr;
            g.globalAlpha = o.alpha * 0.8;
            roundBar(g, x, py, bw, 3 * dpr, 2 * dpr);
            g.globalAlpha = o.alpha;
          }
        } else {
          const bh = Math.max(3 * dpr, v * ht * 0.46);
          roundBar(g, x, ht / 2 - bh, bw, bh * 2, bw / 2);
        }
      }
    } else if (style === 'ring') {
      const n = 120;
      const vals = values(h, live, n / 2);
      const cx = w / 2;
      const cy = ht / 2;
      const R = Math.min(w, ht) * 0.22 * (1 + Viz.bass * 0.12 + Viz.beat * 0.05);
      g.lineCap = 'round';
      g.lineWidth = Math.max(2, ((Math.PI * 2 * R) / n) * 0.55);
      if (o.glow) {
        g.shadowBlur = 22 * dpr;
        g.shadowColor = accent;
      }
      const grad = themeGradient(g, cx - R, cy - R, cx + R, cy + R);
      for (let i = 0; i < n; i++) {
        const k = i < n / 2 ? i : n - 1 - i; // симметрия
        const v = vals[k];
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        const len = 6 * dpr + v * Math.min(w, ht) * 0.26;
        g.strokeStyle = paint(g, w, ht, h, k, n / 2) || grad;
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * (R + 6 * dpr), cy + Math.sin(ang) * (R + 6 * dpr));
        g.lineTo(cx + Math.cos(ang) * (R + 6 * dpr + len), cy + Math.sin(ang) * (R + 6 * dpr + len));
        g.stroke();
      }
      g.shadowBlur = 0;
      g.strokeStyle = `rgba(255,255,255,${0.25 + Viz.beat * 0.5})`;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.stroke();
    } else if (style === 'wave') {
      const vals = values(h, live, 64);
      // мягкая заливка спектра снизу
      g.fillStyle = themeGradient(g, 0, 0, w, 0);
      g.globalAlpha = o.alpha * 0.25;
      g.beginPath();
      g.moveTo(0, ht);
      for (let i = 0; i < vals.length; i++) g.lineTo((i / (vals.length - 1)) * w, ht - vals[i] * ht * 0.5);
      g.lineTo(w, ht);
      g.fill();
      g.globalAlpha = o.alpha;
      // осциллограмма
      if (o.glow) {
        g.shadowBlur = 16 * dpr;
        g.shadowColor = accent;
      }
      g.lineWidth = 3 * dpr;
      g.strokeStyle = o.color === 'white' ? '#fff' : o.color === 'rainbow' ? themeRainbow(g, w) : themeGradient(g, 0, 0, w, 0);
      g.beginPath();
      const step = Math.max(1, Math.floor((time ? time.length : 1024) / 512));
      const N = time ? Math.floor(time.length / step) : 512;
      const amp = ht * 0.38 * (o.sensitivity || 1);
      for (let i = 0; i < N; i++) {
        const v = live && time ? (time[i * step] - 128) / 128 : Math.sin(tIdle * 2 + i / 30) * 0.05;
        const x = (i / (N - 1)) * w;
        const y = ht / 2 + v * amp;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    } else if (style === 'particles') {
      const cx = w / 2;
      const cy = ht / 2;
      const vals = values(h, live, 48);
      g.globalCompositeOperation = 'lighter';
      const spawn = live ? Math.floor(2 + Viz.bass * 10 + Viz.beat * 24) : 1;
      for (let i = 0; i < spawn && h.parts.length < 700; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (1.2 + Math.random() * 3 + Viz.bass * 7) * dpr;
        h.parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, r: (1 + Math.random() * 3) * dpr, hue: Math.random() });
      }
      for (let i = h.parts.length - 1; i >= 0; i--) {
        const p = h.parts[i];
        p.x += p.vx * (1 + Viz.beat);
        p.y += p.vy * (1 + Viz.beat);
        p.life -= 0.008;
        if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > ht + 20) {
          h.parts.splice(i, 1);
          continue;
        }
        g.globalAlpha = Math.max(0, p.life) * o.alpha;
        g.fillStyle = o.color === 'rainbow' ? `hsl(${Math.round(p.hue * 360)} 90% 65%)` : o.color === 'white' ? '#fff' : p.hue > 0.5 ? accent : accent2;
        g.beginPath();
        g.arc(p.x, p.y, p.r * (1 + Viz.bass), 0, Math.PI * 2);
        g.fill();
      }
      // центральное свечение
      g.globalAlpha = o.alpha * (0.35 + Viz.bass * 0.5);
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, ht) * (0.18 + Viz.bass * 0.12));
      rg.addColorStop(0, accent);
      rg.addColorStop(1, 'transparent');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(cx, cy, Math.min(w, ht) * 0.4, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = o.alpha;
      g.globalCompositeOperation = 'source-over';
      // тонкие лучи спектра по кругу
      g.strokeStyle = themeGradient(g, 0, 0, w, ht);
      g.lineWidth = 2 * dpr;
      const R = Math.min(w, ht) * 0.12;
      for (let i = 0; i < 96; i++) {
        const v = vals[i % 48];
        const ang = (i / 96) * Math.PI * 2;
        g.globalAlpha = o.alpha * 0.6;
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
        g.lineTo(cx + Math.cos(ang) * (R + v * R * 1.6), cy + Math.sin(ang) * (R + v * R * 1.6));
        g.stroke();
      }
      g.globalAlpha = o.alpha;
    } else if (style === 'eq') {
      drawEq(h, live, w, ht, dpr);
    } else if (style === 'orbit') {
      drawOrbit(h, live, w, ht, dpr);
    }
    g.globalAlpha = 1;
    o.onFrame && o.onFrame(Viz);
  }

  function themeRainbow(g, w) {
    const gr = g.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${(i * 55 + tIdle * 20) % 360} 90% 65%)`);
    return gr;
  }

  /** Центр сцены: по обложке (centerFn) или по центру холста. Значения в пикселях холста. */
  function centerOf(h, w, ht, dpr) {
    if (h.opts.centerFn) {
      const now = performance.now();
      if (!h._c || now - h._cAt > 200) {
        h._c = h.opts.centerFn(h.canvas);
        h._cAt = now;
      }
      return { x: h._c.x * dpr, y: h._c.y * dpr, r: h._c.r * dpr };
    }
    return { x: w / 2, y: ht / 2, r: Math.min(w, ht) * 0.18 };
  }

  /** Мягкие волны снизу: три слоя плавных кривых с прозрачной заливкой. */
  function drawWaves(h, live, w, ht, dpr) {
    const g = h.g;
    const n = 26;
    const vals = values(h, live, n);
    const s = h.opts.sensitivity || 1;
    const layers = [
      { amp: 0.27, c: accRGB, a: 0.45, ph: 0, sp: 0.7 },
      { amp: 0.2, c: acc2RGB, a: 0.32, ph: 2.1, sp: 0.55 },
      { amp: 0.14, c: [255, 255, 255], a: 0.08, ph: 4.2, sp: 0.9 },
    ];
    for (const L of layers) {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const k = (i + Math.round(L.ph * 2)) % n;
        const v = vals[k] * s;
        const wob = 0.025 * Math.sin(tIdle * L.sp + i * 0.55 + L.ph);
        pts.push([(i / (n - 1)) * w, ht - (0.05 + v * L.amp + wob + 0.03) * ht]);
      }
      const gr = g.createLinearGradient(0, ht * 0.35, 0, ht);
      gr.addColorStop(0, rgba(L.c, L.a));
      gr.addColorStop(1, rgba(L.c, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, ht);
      g.lineTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < n - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      g.lineTo(pts[n - 1][0], pts[n - 1][1]);
      g.lineTo(w, ht);
      g.closePath();
      g.fill();
      // тонкая светлая кромка
      g.strokeStyle = rgba(L.c, Math.min(1, L.a + 0.25));
      g.lineWidth = 1.5 * dpr;
      g.stroke();
    }
  }

  /** Аура: мягкое свечение вокруг обложки + расходящиеся круги на сильных долях. */
  function drawAura(h, live, w, ht, dpr) {
    const g = h.g;
    const c = centerOf(h, w, ht, dpr);
    const s = h.opts.sensitivity || 1;
    const vals = values(h, live, 12);
    const bass = live ? Math.min(1, (vals[0] + vals[1] + vals[2]) / 3 * 1.4 * s) : 0.12 + 0.05 * Math.sin(tIdle * 1.2);
    const high = live ? Math.min(1, (vals[7] + vals[8] + vals[9]) / 3 * 2 * s) : 0.1;
    const R1 = c.r * (1.12 + bass * 0.45);
    let gr = g.createRadialGradient(c.x, c.y, c.r * 0.8, c.x, c.y, R1 * 1.35);
    gr.addColorStop(0, rgba(accRGB, Math.min(0.5, 0.3 * (0.35 + bass))));
    gr.addColorStop(1, rgba(accRGB, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, ht);
    const ox = Math.cos(tIdle * 0.35) * c.r * 0.2;
    const oy = Math.sin(tIdle * 0.28) * c.r * 0.16;
    gr = g.createRadialGradient(c.x + ox, c.y + oy, c.r * 0.7, c.x + ox, c.y + oy, c.r * (1.15 + high * 0.6) * 1.3);
    gr.addColorStop(0, rgba(acc2RGB, Math.min(0.35, 0.24 * (0.3 + high))));
    gr.addColorStop(1, rgba(acc2RGB, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, ht);
    // круги на битах
    h.rip = h.rip || [];
    if (live && Viz.beat > 0.95 && (!h._ripAt || performance.now() - h._ripAt > 280)) {
      h._ripAt = performance.now();
      h.rip.push({ r: c.r * 1.02, a: 0.45 });
    }
    g.lineWidth = 2 * dpr;
    for (let i = h.rip.length - 1; i >= 0; i--) {
      const p = h.rip[i];
      p.r += (2.2 + bass * 3) * dpr;
      p.a *= 0.965;
      if (p.a < 0.02) {
        h.rip.splice(i, 1);
        continue;
      }
      g.strokeStyle = `rgba(255,255,255,${p.a.toFixed(3)})`;
      g.beginPath();
      g.arc(c.x, c.y, p.r, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** Мягкие столбцы: тонкие, полупрозрачные, без свечения и пиков. */
  function drawSoftBars(h, live, w, ht, dpr) {
    const g = h.g;
    const n = h.opts.bars || 64;
    const vals = values(h, live, n);
    const s = h.opts.sensitivity || 1;
    const gap = (w / n) * 0.45;
    const bw = w / n - gap;
    const gr = g.createLinearGradient(0, ht * 0.6, 0, ht);
    gr.addColorStop(0, rgba(accRGB, 0.6));
    gr.addColorStop(1, rgba(acc2RGB, 0.04));
    g.fillStyle = gr;
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, vals[i] * s);
      const bh = Math.max(2 * dpr, v * ht * (h.opts.barH || 0.36));
      roundBar(g, i * (bw + gap) + gap / 2, ht - bh, bw, bh, bw / 2);
    }
  }

  /** Кольцо лучей вокруг круглой кнопки или обложки: «дышит» в покое и пульсирует под музыку. */
  function drawOrbit(h, live, w, ht, dpr) {
    const g = h.g;
    const o = h.opts;
    const n = 40;
    const vals = values(h, live, n);
    const cc = o.centerFn ? centerOf(h, w, ht, dpr) : null;
    const cx = cc ? cc.x : w / 2;
    const cy = cc ? cc.y : ht / 2;
    const k = live ? 1 : 0;
    const R0 = (cc ? cc.r + 10 * dpr : (o.inner || 92) * dpr) * (1 + Viz.beat * 0.035 * k);
    const maxLen = cc ? cc.r * 0.42 * (o.sensitivity || 1) : Math.max(8 * dpr, Math.min(w, ht) / 2 - R0 - 4 * dpr);
    h.rot = (h.rot || 0) + (live ? 0.004 + Viz.bass * 0.01 : 0.0015);
    // мягкое свечение вокруг кнопки
    g.globalAlpha = 0.35 + (live ? Viz.bass * 0.45 : 0.1 * (1 + Math.sin(tIdle * 1.4)));
    const rg = g.createRadialGradient(cx, cy, R0 * 0.85, cx, cy, R0 + maxLen);
    rg.addColorStop(0, accent);
    rg.addColorStop(1, 'transparent');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(cx, cy, R0 + maxLen, 0, Math.PI * 2);
    g.fill();
    // лучи
    const rays = n * 2;
    const grad = themeGradient(g, cx - R0, cy - R0, cx + R0, cy + R0);
    g.lineCap = 'round';
    g.lineWidth = Math.max(2 * dpr, ((Math.PI * 2 * R0) / rays) * 0.42);
    if (o.glow !== false) {
      g.shadowBlur = 12 * dpr;
      g.shadowColor = accent;
    }
    for (let i = 0; i < rays; i++) {
      const j = i < n ? i : rays - 1 - i;
      const v = vals[j];
      const ang = h.rot + (i / rays) * Math.PI * 2;
      const len = 3 * dpr + v * maxLen;
      g.globalAlpha = 0.5 + Math.min(0.5, v * 0.9);
      g.strokeStyle = o.color === 'rainbow' ? `hsl(${Math.round((i / rays) * 360)} 90% 65%)` : grad;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      g.beginPath();
      g.moveTo(cx + c * (R0 + 4 * dpr), cy + s * (R0 + 4 * dpr));
      g.lineTo(cx + c * (R0 + 4 * dpr + len), cy + s * (R0 + 4 * dpr + len));
      g.stroke();
    }
    g.shadowBlur = 0;
    // тонкая орбита
    g.globalAlpha = 0.28 + Viz.beat * 0.5 * k;
    g.strokeStyle = '#fff';
    g.lineWidth = 1.2 * dpr;
    g.setLineDash([2 * dpr, 6 * dpr]);
    g.beginPath();
    g.arc(cx, cy, R0, h.rot * -2, h.rot * -2 + Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  /** Фон эквалайзера: спектр и кривая АЧХ на той же шкале, что и ползунки полос. */
  const EQ_POINTS = 240;
  let eqFreqs = null;
  function drawEq(h, live, w, ht, dpr) {
    const g = h.g;
    const fx = (f) => ((Math.log2(f / 32) / Math.log2(16000 / 32)) * 9 + 0.5) / 10;
    const pad = (h.opts.padTop || 0) * dpr;
    const padB = (h.opts.padBottom || 0) * dpr;
    const area = ht - pad - padB;
    const ydb = (db) => pad + area / 2 - (db / 12) * (area / 2);
    // сетка
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1 * dpr;
    for (const db of [-12, -6, 0, 6, 12]) {
      g.beginPath();
      g.moveTo(0, ydb(db));
      g.lineTo(w, ydb(db));
      g.stroke();
    }
    // спектр
    if (AudioFX.ready && freq) {
      const n = 90;
      const vals = values(h, live, n);
      const grad = g.createLinearGradient(0, pad, 0, ht - padB);
      grad.addColorStop(0, accent2);
      grad.addColorStop(1, 'transparent');
      g.fillStyle = grad;
      g.globalAlpha = 0.35;
      g.beginPath();
      g.moveTo(0, ht - padB);
      for (let i = 0; i < n; i++) {
        const f = 35 * Math.pow(16000 / 35, (i + 0.5) / n);
        g.lineTo(fx(f) * w, ht - padB - vals[i] * area);
      }
      g.lineTo(w, ht - padB);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
    }
    // кривая АЧХ
    if (!eqFreqs) {
      eqFreqs = new Float32Array(EQ_POINTS);
      for (let i = 0; i < EQ_POINTS; i++) eqFreqs[i] = 20 * Math.pow(20000 / 20, i / (EQ_POINTS - 1));
    }
    const resp = AudioFX.response(eqFreqs);
    g.shadowBlur = 20 * dpr;
    g.shadowColor = accent;
    g.lineWidth = 3 * dpr;
    g.strokeStyle = themeGradient(g, 0, 0, w, 0);
    g.beginPath();
    for (let i = 0; i < EQ_POINTS; i++) {
      const x = fx(eqFreqs[i]) * w;
      const y = ydb(Math.max(-14, Math.min(14, resp[i])));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
    // заливка под кривой
    g.lineTo(w, ydb(0));
    g.lineTo(0, ydb(0));
    g.closePath();
    g.globalAlpha = 0.12;
    g.fillStyle = themeGradient(g, 0, 0, w, 0);
    g.fill();
    g.globalAlpha = 1;
  }

  window.Viz = Viz;
})();
