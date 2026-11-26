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

  const observedCanvases = new WeakMap();
  const canvasVisibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const h = observedCanvases.get(entry.target);
      if (!h) continue;
      h.onscreen = entry.isIntersecting;
      if (h.onscreen) start();
    }
  }, { rootMargin: '160px' });

  function impactLayer(canvas) {
    const np = canvas?.closest('.np');
    if (np) return np.querySelector('.clip-box.clip-on') || np.querySelector('.cf-item.cur .cf-art') || np.querySelector('.np-scene');
    const stage = canvas?.closest('.vz-stage');
    if (stage) return stage.querySelector('.clip-box.clip-on') || stage.querySelector('.vz-cover') || stage.querySelector('.vz-media');
    return canvas?.parentElement;
  }

  function clearImpact(h) {
    const current = impactLayer(h.canvas);
    for (const layer of new Set([h._impactLayer, current])) {
      if (!layer) continue;
      layer.style.setProperty('--bass-punch', '1');
      layer.style.setProperty('--bass-light', '1');
    }
    h._impactLayer = null;
    h._impactCss = 1;
  }

  function clearVisual(h) {
    const { canvas, g } = h;
    if (g) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.shadowBlur = 0;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.restore();
    }
    if (h.parts) h.parts.length = 0;
    if (h.rip) h.rip.length = 0;
    h.blank = true;
    clearImpact(h);
  }

  const Viz = {
    STYLES,
    COLORS,
    bass: 0, // 0..1 энергия низких частот
    level: 0, // 0..1 общая громкость
    beat: 0, // затухающий импульс на сильной доле
    _bassAvg: 0,
    audioConsumers: new Set(), // активные 3D-сцены тоже используют FFT, даже без 2D-холста

    /** Подключить canvas. opts: { style, color, sensitivity, bars, glow, idle, onFrame } */
    attach(canvas, opts = {}) {
      const previous = observedCanvases.get(canvas);
      if (previous) {
        handles.delete(previous);
        previous.resizeObserver?.disconnect();
      }
      const h = {
        canvas,
        g: canvas.getContext('2d'),
        opts: { style: 'bars', color: 'accent', sensitivity: 1, bars: 72, glow: true, idle: true, alpha: 1, ...opts },
        vals: null,
        peaks: null,
        parts: [],
        onscreen: true,
      };
      h.seekEl = h.opts.seekEl || null;
      h.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (!rect) return;
        h._cssW = rect.width;
        h._cssH = rect.height;
      });
      h.resizeObserver.observe(canvas);
      handles.add(h);
      observedCanvases.set(canvas, h);
      canvasVisibility.observe(canvas);
      if (h.seekEl) attachRingSeek(h.seekEl, canvas);
      start();
      return {
        set(o) {
          Object.assign(h.opts, o);
          if (h.opts.style !== 'impact') {
            h._impact = 0;
            clearImpact(h);
          }
          // Ползунок отклика не должен обнулять сглаженный спектр на каждом событии input.
          const smoothOnly = Object.keys(o).every((key) => key === 'sensitivity' || key === 'onFrame');
          if (!smoothOnly) h.vals = null;
          h._ringLayout = '';
          h._ringEnabled = undefined;
          if (h.seekEl) {
            h.seekEl._ringGeometry = null;
            h.seekEl.classList.remove('available', 'near-ring');
          }
          if (h.opts.style === 'none') {
            h._impact = 0;
            clearVisual(h);
          } else {
            h.blank = false;
            start();
          }
        },
        stop() {
          clearVisual(h);
          handles.delete(h);
          h.resizeObserver?.disconnect();
          canvasVisibility.unobserve(canvas);
          observedCanvases.delete(canvas);
        },
      };
    },
  };

  // Экономия: окно свёрнуто — не рисуем вовсе; музыка на паузе и нет «дышащих» холстов — проверяем раз в 250 мс
  let nap = 0;
  let quiet = 0;
  Viz.hidden = false;
  Viz.setHidden = (v) => {
    Viz.hidden = Boolean(v);
    if (!Viz.hidden) start();
  };
  function start() {
    if (nap) {
      clearTimeout(nap);
      nap = 0;
    }
    if (!raf && !Viz.hidden) raf = requestAnimationFrame(loop);
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
    for (const h of [...handles]) {
      if (!h.canvas.isConnected) {
        h.seekEl?._ringSeekCleanup?.();
        handles.delete(h);
        h.resizeObserver?.disconnect();
        canvasVisibility.unobserve(h.canvas);
        observedCanvases.delete(h.canvas);
      }
    }
    if (!handles.size || Viz.hidden) return;
    const live = AudioFX.ready && !Player.audio.paused;
    quiet = live || Viz.level > 0.002 || Viz.beat > 0.01 ? 0 : quiet + 1;
    if (quiet > 90) {
      let calm = true;
      for (const h of handles) if (h.onscreen !== false && (h.opts.idle || h.opts.onFrame)) calm = false;
      if (Viz.audioConsumers.size) calm = false;
      if (calm) {
        nap = setTimeout(() => {
          nap = 0;
          start();
        }, 250);
        return;
      }
    }
    raf = requestAnimationFrame(loop);
    Viz._frames = (Viz._frames || 0) + 1;
    const now = performance.now();
    const tickDt = Math.min(0.05, Math.max(0.001, (now - (Viz._tickAt || now - 16.67)) / 1000));
    Viz._tickAt = now;
    tIdle += tickDt;
    const npEl = document.getElementById('nowPlaying');
    const npOpen = npEl && !npEl.classList.contains('hidden');
    const fullScreen = document.fullscreenElement;
    let needData = Viz.audioConsumers.size > 0;
    let needTime = false;
    for (const h of handles) {
      h._due = h.onscreen !== false && h.opts.style !== 'none' && !(npOpen && !npEl.contains(h.canvas)) && !(fullScreen && !fullScreen.contains(h.canvas));
      if (!h._due) continue;
      // Частота следует реальным кадрам каждого холста, без искусственного общего ограничения.
      if (h.opts.fps) {
        const interval = 1000 / h.opts.fps;
        if (h._fpsStart == null) {
          h._fpsStart = now - interval;
          h._fpsDone = 0;
        }
        const target = Math.floor((now - h._fpsStart) / interval);
        if (target <= h._fpsDone) h._due = false;
        else {
          if (target - h._fpsDone > 2) h._fpsDone = target - 1;
          h._fpsDone = target;
        }
      }
      if (h._due) {
        needData = true;
        if (h.opts.style === 'waves') needTime = true;
      }
    }
    // Нет рисуемого кадра или активной 3D-сцены — FFT и связанные обновления не нужны.
    if (needData && AudioFX.ready) {
      readColors();
      const a = AudioFX.analyser;
      if (!freq || freq.length !== a.frequencyBinCount) freq = new Uint8Array(a.frequencyBinCount);
      if (needTime && (!time || time.length !== a.fftSize)) time = new Uint8Array(a.fftSize);
      a.getByteFrequencyData(freq);
      // Временной массив нужен только волнам; полосы и 3D используют спектр.
      if (needTime) a.getByteTimeDomainData(time);
      const b = live ? band(30, 160) : 0;
      Viz.bass = Viz.bass * 0.6 + b * 0.4;
      Viz.level = Viz.level * 0.7 + (live ? band(30, 12000) : 0) * 0.3;
      Viz._bassAvg = Viz._bassAvg * 0.95 + b * 0.05;
      if (live && b > Viz._bassAvg * 1.25 && b > 0.45 && Viz.beat < 0.3) {
        Viz.beat = 1;
        window.dispatchEvent(new Event('zg:beat'));
      }
      Viz.beat *= 0.9;
    }
    if (needData) Viz.onTick && Viz.onTick(Viz, live);
    for (const h of handles) if (h._due) draw(h, live);
  }

  function fit(h) {
    const c = h.canvas;
    const dpr = Math.min(h.opts.maxDpr || 2, window.devicePixelRatio || 1);
    // clientWidth/clientHeight внутри кадра после вставки строк вызывали принудительный layout.
    // ResizeObserver хранит актуальную геометрию между реальными изменениями размера.
    if (h._cssW == null || h._fitDpr !== dpr) {
      h._cssW = c.clientWidth;
      h._cssH = c.clientHeight;
    }
    h._fitDpr = dpr;
    const w = Math.max(1, Math.round(h._cssW * dpr));
    const ht = Math.max(1, Math.round(h._cssH * dpr));
    if (c.width !== w || c.height !== ht) {
      c.width = w;
      c.height = ht;
    }
    return { w, h: ht, dpr };
  }

  /** Единый отклик для всех стилей: настройка применяется один раз и меняется без скачка. */
  function response(h) {
    const requested = Number(h.opts.sensitivity);
    const target = Number.isFinite(requested) && requested > 0 ? requested : 1;
    if (h._response != null && h._responseFrame === Viz._frames) return h._response;
    h._responseFrame = Viz._frames;
    const now = performance.now();
    if (h._response == null) {
      h._response = target;
      h._responseAt = now;
      return target;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - h._responseAt) / 1000));
    h._responseAt = now;
    h._response += (target - h._response) * (1 - Math.exp(-dt * 12));
    if (Math.abs(target - h._response) < 0.001) h._response = target;
    return h._response;
  }

  /** Значения столбцов в логарифмической шкале 35 Гц – 16 кГц. */
  function values(h, live, n) {
    if (!h.vals || h.vals.length !== n) {
      h.vals = new Float32Array(n);
      h.peaks = new Float32Array(n);
    }
    const s = response(h);
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
    } else if (style === 'gravity') {
      drawGravitySpiral(h, live, w, ht, dpr);
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
      const amp = ht * 0.38 * response(h);
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
      const spawn = live ? Math.floor(1 + Viz.bass * 4 + Viz.beat * 9) : 1;
      for (let i = 0; i < spawn && h.parts.length < 320; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (0.8 + Math.random() * 2.3 + Viz.bass * 4) * dpr;
        h.parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, r: (0.65 + Math.random() * 1.6) * dpr, hue: Math.random() });
      }
      for (let i = h.parts.length - 1; i >= 0; i--) {
        const p = h.parts[i];
        p.x += p.vx * (1 + Viz.beat);
        p.y += p.vy * (1 + Viz.beat);
        p.life -= 0.011;
        if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > ht + 20) {
          h.parts.splice(i, 1);
          continue;
        }
        g.globalAlpha = Math.max(0, p.life) * o.alpha * 0.82;
        g.fillStyle = o.color === 'rainbow' ? `hsl(${Math.round(p.hue * 360)} 90% 65%)` : o.color === 'white' ? '#fff' : p.hue > 0.5 ? accent : accent2;
        g.beginPath();
        g.arc(p.x, p.y, p.r * (1 + Viz.bass * 0.6), 0, Math.PI * 2);
        g.fill();
      }
      // Мягкий центральный источник не засвечивает видео и интерфейс.
      g.globalAlpha = o.alpha * (0.16 + Viz.bass * 0.24);
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, ht) * (0.14 + Viz.bass * 0.08));
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
    } else if (style === 'impact') {
      drawImpact(h, live, w, ht, dpr);
    } else if (style === 'tide' || style === 'rings') {
      drawTide(h, live, w, ht, dpr);
    } else if (style === 'infinity') {
      drawInfinity(h, live, w, ht, dpr);
    } else if (style === 'solar') {
      drawSolarSystem(h, live, w, ht, dpr);
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

  const GRAVITY_TAU = Math.PI * 2;
  const gravityRand = (i, salt = 0) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  /** Чистая гравитационная спираль: частицы и свет, без обложек и карточек треков. */
  function drawGravitySpiral(h, live, w, ht, dpr) {
    const g = h.g;
    const c = centerOf(h, w, ht, dpr);
    const vals = values(h, live, 96);
    const reduced = document.body.classList.contains('reduce-motion');
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - (h._gravityAt || now - 16)) / 1000));
    h._gravityAt = now;
    const targetEnergy = live ? Math.min(1, Viz.level * 1.3 + Viz.bass * 0.45 + Viz.beat * 0.2) : 0;
    h._gravityEnergy = (h._gravityEnergy || 0) + (targetEnergy - (h._gravityEnergy || 0)) * (1 - Math.exp(-dt * 5));
    const energy = h._gravityEnergy;
    const targetSpeed = reduced ? 0 : live ? 0.105 + energy * 0.16 : 0.018;
    h._gravitySpeed = (h._gravitySpeed ?? targetSpeed) + (targetSpeed - (h._gravitySpeed ?? targetSpeed)) * (1 - Math.exp(-dt * 3));
    h._gravitySpin = (h._gravitySpin || 0) + dt * h._gravitySpeed;
    h._gravityFlow = (h._gravityFlow || 0) + (reduced ? 0 : dt * (live ? 0.014 + energy * 0.014 : 0.0025));
    if (!h._gravityDust) {
      h._gravityDust = Array.from({ length: 1100 }, (_, i) => ({
        u: gravityRand(i, 1), arm: i % 4,
        radial: (gravityRand(i, 2) - 0.5) * 0.16,
        angular: (gravityRand(i, 3) - 0.5) * 0.16,
        size: 0.75 + gravityRand(i, 4) * 2.1,
        alpha: 0.22 + gravityRand(i, 5) * 0.78,
        phase: gravityRand(i, 6) * GRAVITY_TAU,
        alt: gravityRand(i, 7) > 0.58,
      }));
    }
    const core = Math.max(38 * dpr, c.r * 1.05);
    const R = Math.max(core * 2.2, Math.min(w * 0.43, ht * 1.06));
    const flatten = 0.44;
    const spin = h._gravitySpin;
    const point = (u, arm, angular = 0, radial = 0) => {
      const angle = arm * GRAVITY_TAU / 4 + Math.pow(u, 0.78) * GRAVITY_TAU * 0.95 + spin + angular;
      const radius = core + (R - core) * Math.pow(u, 0.92);
      const rr = radius * (1 + radial * u);
      return [Math.cos(angle) * rr, Math.sin(angle) * rr * flatten];
    };

    g.save();
    g.translate(c.x, c.y);
    g.rotate(-0.12);
    g.globalCompositeOperation = 'source-over';
    const halo = g.createRadialGradient(0, 0, core * 0.3, 0, 0, R * 0.82);
    halo.addColorStop(0, rgba(accRGB, 0.13 + energy * 0.12));
    halo.addColorStop(0.32, rgba(acc2RGB, 0.045 + energy * 0.05));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(0, 0, R * 0.82, 0, GRAVITY_TAU);
    g.fill();

    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.shadowBlur = 3 * dpr;
    for (let arm = 0; arm < 4; arm++) {
      g.beginPath();
      for (let j = 0; j <= 180; j++) {
        const p = point(0.025 + (j / 180) * 0.975, arm);
        if (j) g.lineTo(p[0], p[1]);
        else g.moveTo(p[0], p[1]);
      }
      g.globalAlpha = 0.28 + energy * 0.14;
      g.strokeStyle = arm % 2 ? rgba(acc2RGB, 0.88) : rgba(accRGB, 0.9);
      g.lineWidth = 0.95 * dpr;
      g.stroke();
    }
    g.shadowBlur = 0;

    for (let i = 0; i < h._gravityDust.length; i++) {
      const p = h._gravityDust[i];
      const u = 1 - ((1 - p.u + h._gravityFlow) % 1);
      const pos = point(Math.max(0.018, u), p.arm, p.angular, p.radial);
      const depth = 0.55 + 0.45 * Math.sin(p.arm * GRAVITY_TAU / 4 + u * GRAVITY_TAU + spin);
      const fade = Math.sin(Math.PI * u);
      const v = vals[Math.min(vals.length - 1, Math.floor(u * vals.length))];
      const twinkle = reduced ? 1 : 0.82 + 0.18 * Math.sin(tIdle * 0.8 + p.phase);
      g.globalAlpha = Math.min(0.95, (0.16 + p.alpha * 0.6 + v * 0.35) * fade * depth * twinkle * (1 + energy * 0.45));
      g.fillStyle = p.alt ? accent2 : accent;
      const size = p.size * dpr * (0.7 + depth * 0.5) * (1 + energy * 0.25);
      if (size < 1.15 * dpr) g.fillRect(pos[0], pos[1], size, size);
      else {
        g.beginPath();
        g.arc(pos[0], pos[1], size, 0, GRAVITY_TAU);
        g.fill();
      }
    }

    // Гравитационный колодец оставляет центр свободным для настоящей кнопки play/pause.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const well = g.createRadialGradient(0, 0, 0, 0, 0, core * 2.6);
    well.addColorStop(0, 'rgba(3,8,14,0.96)');
    well.addColorStop(0.4, 'rgba(4,10,17,0.82)');
    well.addColorStop(0.72, 'rgba(5,12,20,0.28)');
    well.addColorStop(1, 'rgba(5,12,20,0)');
    g.fillStyle = well;
    g.beginPath();
    g.arc(0, 0, core * 2.6, 0, GRAVITY_TAU);
    g.fill();
    g.strokeStyle = rgba(accRGB, 0.2 + energy * 0.28);
    g.lineWidth = 0.8 * dpr;
    g.beginPath();
    g.arc(0, 0, core * (1.16 + energy * 0.05), 0, GRAVITY_TAU);
    g.stroke();
    g.restore();

    // Свет не мешает заголовку слева, особенно на узких окнах.
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createLinearGradient(0, 0, w, 0);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(0.2, 'rgba(0,0,0,0.12)');
    mask.addColorStop(0.43, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = mask;
    g.fillRect(0, 0, w, ht);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const diag = h.canvas._gravity || (h.canvas._gravity = { frames: 0 });
    diag.frames++;
    diag.x = c.x / dpr;
    diag.y = c.y / dpr;
    diag.energy = energy;
    diag.speed = h._gravitySpeed;
  }

  /** Мягкие волны снизу: три слоя плавных кривых с прозрачной заливкой. */
  function drawWaves(h, live, w, ht, dpr) {
    const g = h.g;
    const n = 26;
    const vals = values(h, live, n);
    const layers = [
      { amp: 0.27, c: accRGB, a: 0.45, ph: 0, sp: 0.7 },
      { amp: 0.2, c: acc2RGB, a: 0.32, ph: 2.1, sp: 0.55 },
      { amp: 0.14, c: [255, 255, 255], a: 0.08, ph: 4.2, sp: 0.9 },
    ];
    for (const L of layers) {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const k = (i + Math.round(L.ph * 2)) % n;
        const v = vals[k];
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

  /** Пульс кадра: заметная мягкая пульсация от общего уровня и баса, без тряски. */
  function drawImpact(h, live, w, ht, dpr) {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - (h._impactAt || now - 16)) / 1000));
    h._impactAt = now;
    h._motionQuery ||= window.matchMedia('(prefers-reduced-motion: reduce)');
    const calm = h._motionQuery.matches || document.body.classList.contains('reduce-motion');
    const musicalEnergy = Math.min(1, Viz.level * 0.72 + Viz.bass * 0.48 + Viz.beat * 0.2);
    const target = live && !calm ? Math.max(0.025, musicalEnergy) : 0;
    const current = h._impact || 0;
    // Быстрая атака и экспоненциальное затухание сохраняют пульс даже между сильными басами.
    h._impact = target > current
      ? current + (target - current) * (1 - Math.exp(-dt * 28))
      : current + (target - current) * (1 - Math.exp(-dt * 9));
    const energy = h._impact < 0.004 ? 0 : h._impact;
    const scale = calm ? 1 : Math.min(1.08, 1 + energy * 0.062 * response(h));
    const light = calm ? 1 : Math.min(1.16, 1 + energy * 0.12 * response(h));
    const layer = impactLayer(h.canvas);
    if (layer !== h._impactLayer) {
      if (h._impactLayer) {
        h._impactLayer.style.setProperty('--bass-punch', '1');
        h._impactLayer.style.setProperty('--bass-light', '1');
      }
      h._impactLayer = layer;
      h._impactCss = 0;
    }
    if (layer && Math.abs((h._impactCss || 1) - scale) > 0.00015) {
      layer.style.setProperty('--bass-punch', scale.toFixed(4));
      layer.style.setProperty('--bass-light', light.toFixed(3));
      h._impactCss = scale;
    }
    if (live && Viz.beat > 0.95 && now - (h._impactBeatAt || 0) > 280) {
      h._impactWave = 0;
      h._impactBeatAt = now;
    }
    h._impactWave = Math.min(1, (h._impactWave ?? 1) + dt * 1.35);
    if (!energy || h._impactWave >= 1) return;
    const g = h.g;
    const radius = Math.max(w, ht) * (0.12 + h._impactWave * 0.46);
    g.globalAlpha = (1 - h._impactWave) * energy * 0.24;
    g.strokeStyle = accent;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(w / 2, ht / 2, radius, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  /** Аура: мягкое свечение вокруг обложки + расходящиеся круги на сильных долях. */
  function drawAura(h, live, w, ht, dpr) {
    const g = h.g;
    const c = centerOf(h, w, ht, dpr);
    const vals = values(h, live, 12);
    const bass = live ? Math.min(1, (vals[0] + vals[1] + vals[2]) / 3 * 1.4) : 0.12 + 0.05 * Math.sin(tIdle * 1.2);
    const high = live ? Math.min(1, (vals[7] + vals[8] + vals[9]) / 3 * 2) : 0.1;
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
    const gap = (w / n) * 0.45;
    const bw = w / n - gap;
    const gr = g.createLinearGradient(0, ht * 0.6, 0, ht);
    gr.addColorStop(0, rgba(accRGB, 0.6));
    gr.addColorStop(1, rgba(acc2RGB, 0.04));
    g.fillStyle = gr;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
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
    const maxLen = cc ? cc.r * 0.42 : Math.max(8 * dpr, Math.min(w, ht) / 2 - R0 - 4 * dpr);
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

  /** «Живая бесконечность»: цельная симметричная лента и инерционное движение в одном цикле Viz. */
  const infRand = (i, k = 0) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const INF_TAU = Math.PI * 2;
  function drawInfinity(h, live, w, ht, dpr) {
    const __infStart = performance.now();
    const g = h.g;
    const o = h.opts;
    const now = performance.now();
    const t = now / 1000;
    const dt = Math.min(0.05, Math.max(0.001, (now - (h._infAt || now - 16)) / 1000));
    h._infAt = now;

    // Настроение меняет цвет плавно, без резкого переключения палитры.
    if (!h._infPalAt || now - h._infPalAt > 450) {
      const cs = getComputedStyle(h.canvas);
      h._infTarget = [toRGB(cs.getPropertyValue('--mood-a').trim() || accent, accRGB), toRGB(cs.getPropertyValue('--mood-b').trim() || accent2, acc2RGB)];
      h._infPalAt = now;
    }
    if (!h._infCur) h._infCur = h._infTarget.map((c) => c.slice());
    const ease = Math.min(1, dt * 4);
    for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) h._infCur[k][j] += (h._infTarget[k][j] - h._infCur[k][j]) * ease;
    const A = h._infCur[0];
    const B = h._infCur[1];
    const c = centerOf(h, w, ht, dpr);
    const vals = values(h, live, 48);
    const energy = live ? Math.min(1, Viz.bass * 0.85 + Viz.level * 0.65) : 0.12 + 0.04 * Math.sin(t * 0.8);
    const beat = live ? Viz.beat : 0;

    // Мышь влияет только на внутреннюю камеру. Экспоненциальное сглаживание не зависит от FPS.
    const pointer = o.pointer || { x: 0, y: 0, tx: 0, ty: 0 };
    const follow = 1 - Math.exp(-dt * 10);
    pointer.x += (pointer.tx - pointer.x) * follow;
    pointer.y += (pointer.ty - pointer.y) * follow;
    const rotation = pointer.x * 0.035;
    const stretchY = 1 + pointer.y * 0.025;
    const rc = Math.cos(rotation);
    const rs = Math.sin(rotation);

    // 64 дальние звезды: фиксированные координаты, только мягкое движение и мерцание.
    if (!h._stars) {
      h._stars = Array.from({ length: 64 }, (_, i) => ({
        x: infRand(i, 1), y: infRand(i, 2), r: 0.35 + infRand(i, 3) * 1.25,
        a: 0.12 + infRand(i, 4) * 0.48, ph: infRand(i, 5) * INF_TAU,
        sp: 0.08 + infRand(i, 6) * 0.24, tw: 0.5 + infRand(i, 7) * 1.4,
        depth: 0.2 + infRand(i, 8), alt: infRand(i, 9) > 0.55, cross: i % 13 === 0,
      }));
    }
    g.globalCompositeOperation = 'source-over';
    for (const p of h._stars) {
      const x = (p.x * w + Math.sin(t * p.sp + p.ph) * p.depth * 9 * dpr + pointer.x * p.depth * 8 * dpr + w) % w;
      const y = p.y * ht + Math.cos(t * p.sp * 0.7 + p.ph) * p.depth * 6 * dpr + pointer.y * p.depth * 6 * dpr;
      g.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(t * p.tw + p.ph)) * o.alpha;
      g.fillStyle = rgba(p.alt ? B : A, 0.9);
      g.beginPath();
      g.arc(x, y, p.r * dpr * (1 + beat * 0.25), 0, INF_TAU);
      g.fill();
      if (p.cross) {
        g.strokeStyle = rgba([245, 245, 255], 0.55);
        g.lineWidth = 0.7 * dpr;
        g.beginPath();
        g.moveTo(x - 4 * dpr, y); g.lineTo(x + 4 * dpr, y);
        g.moveTo(x, y - 4 * dpr); g.lineTo(x, y + 4 * dpr);
        g.stroke();
      }
    }

    g.globalAlpha = o.alpha;
    const neb = g.createRadialGradient(c.x, c.y, c.r * 0.5, c.x, c.y, c.r * 5.2);
    neb.addColorStop(0, rgba(A, 0.1 + energy * 0.06));
    neb.addColorStop(0.48, rgba(B, 0.045));
    neb.addColorStop(1, rgba(A, 0));
    g.fillStyle = neb;
    g.fillRect(0, 0, w, ht);

    // Два спокойных музыкальных горизонта вместо трёх: разницы на экране почти нет.
    g.lineWidth = 1 * dpr;
    for (let l = 0; l < 2; l++) {
      g.globalAlpha = (0.075 + l * 0.03) * o.alpha;
      g.strokeStyle = rgba(l ? B : A, 0.9);
      g.beginPath();
      for (let i = 0; i <= 32; i++) {
        const x = (i / 32) * w;
        const y = ht * (0.81 + l * 0.065) + Math.sin(i * 0.48 + t * (0.35 + l * 0.08) + l) * 9 * dpr + vals[(i + l * 5) % 48] * 16 * dpr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }

    const span = Math.min(w * 0.26, ht * 0.5);
    const scale = 1 + energy * 0.035 + beat * 0.015;
    if (!h._infPath) {
      // Симметричная лемниската: лево/право и верх/низ совпадают, центр всегда (0, 0).
      const path = new Path2D();
      for (let i = 0; i <= 192; i++) {
        const u = (i / 192) * INF_TAU;
        const x = Math.cos(u);
        const y = 0.36 * Math.sin(u * 2);
        i ? path.lineTo(x, y) : path.moveTo(x, y);
      }
      path.closePath();
      h._infPath = path;
    }
    const point = (u) => {
      const x = Math.cos(u) * span * scale;
      const y = 0.36 * Math.sin(u * 2) * span * scale * stretchY;
      return { x: c.x + x * rc - y * rs, y: c.y + x * rs + y * rc };
    };

    g.save();
    g.translate(c.x, c.y);
    g.rotate(rotation);
    g.scale(span * scale, span * scale * stretchY);
    const ribbon = g.createLinearGradient(-1, -0.4, 1, 0.4);
    ribbon.addColorStop(0, rgba(A, 0.94));
    ribbon.addColorStop(0.46, rgba([238, 242, 255], 0.86));
    ribbon.addColorStop(0.58, rgba([238, 242, 255], 0.86));
    ribbon.addColorStop(1, rgba(B, 0.94));
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Вся лента — четыре непрерывных штриха вместо 420 отдельных сегментов.
    g.globalAlpha = (0.13 + energy * 0.07) * o.alpha;
    g.strokeStyle = rgba(A, 0.85);
    g.lineWidth = 30 * dpr / (span * scale);
    g.shadowBlur = (12 + energy * 14) * dpr;
    g.shadowColor = rgba(A, 0.7);
    g.stroke(h._infPath);
    g.shadowBlur = 0;
    g.globalAlpha = (0.72 + energy * 0.12) * o.alpha;
    g.strokeStyle = ribbon;
    g.lineWidth = 14 * dpr / (span * scale);
    g.stroke(h._infPath);
    g.globalAlpha = 0.48 * o.alpha;
    g.strokeStyle = rgba([245, 245, 255], 0.72);
    g.lineWidth = 2.4 * dpr / (span * scale);
    g.stroke(h._infPath);
    // Бегущий свет: пунктир смещается по готовому Path2D, без построения сегментов.
    g.globalAlpha = 0.82 * o.alpha;
    g.strokeStyle = ribbon;
    g.lineWidth = 4 * dpr / (span * scale);
    g.setLineDash([0.055, 0.16]);
    g.lineDashOffset = -t * (live ? 0.38 : 0.16);
    g.stroke(h._infPath);
    g.setLineDash([]);
    g.lineDashOffset = 0;
    g.restore();

    // Кнопка — часть пересечения ленты: отдельной плашки у неё больше нет.
    const core = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r * 1.45);
    core.addColorStop(0, rgba([245, 245, 255], 0.16 + energy * 0.05));
    core.addColorStop(0.35, rgba(A, 0.13 + energy * 0.06));
    core.addColorStop(1, rgba(A, 0));
    g.globalAlpha = o.alpha;
    g.fillStyle = core;
    g.fillRect(c.x - c.r * 1.5, c.y - c.r * 1.5, c.r * 3, c.r * 3);

    g.globalAlpha = (0.12 + energy * 0.12) * o.alpha;
    g.strokeStyle = rgba([245, 245, 255], 0.8);
    g.lineWidth = 1.2 * dpr;
    g.beginPath();
    for (let i = 0; i < 40; i++) {
      const x = c.x - span * 0.58 + (i / 39) * span * 1.16;
      const envelope = Math.sin((i / 39) * Math.PI);
      const y = c.y + (vals[i] - 0.08) * span * 0.1 * envelope + Math.sin(t * 1.4 + i * 0.5) * 2 * dpr;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();

    // 24 путника движутся по той же идеальной кривой, что и сама лента.
    if (!h._travelers) {
      h._travelers = Array.from({ length: 24 }, (_, i) => ({
        u: infRand(i, 20) * INF_TAU, speed: 0.08 + infRand(i, 21) * 0.18,
        r: 0.8 + infRand(i, 22) * 1.7, alt: infRand(i, 23) > 0.5,
      }));
    }
    g.globalCompositeOperation = 'lighter';
    for (const p of h._travelers) {
      const u = (p.u + t * p.speed * (live ? 1.8 : 0.65)) % INF_TAU;
      const at = point(u);
      g.globalAlpha = (0.38 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.8 + p.u))) * o.alpha;
      g.fillStyle = rgba(p.alt ? B : A, 0.95);
      g.beginPath();
      g.arc(at.x, at.y, p.r * dpr * (1 + energy * 0.65), 0, INF_TAU);
      g.fill();
    }

    if (live && h.parts.length < 48 && Math.random() < 0.12 + energy * 0.22) {
      const a = Math.random() * INF_TAU;
      const sp = (18 + Math.random() * 42 + energy * 35) * dpr;
      h.parts.push({ x: c.x, y: c.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.35 + Math.random() * 0.35, r: 0.7 + Math.random() * 1.8, alt: Math.random() > 0.5 });
    }
    for (let i = h.parts.length - 1; i >= 0; i--) {
      const p = h.parts[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.992;
      p.vy *= 0.992;
      p.life -= dt * p.decay;
      if (p.life <= 0) {
        h.parts.splice(i, 1);
        continue;
      }
      g.globalAlpha = p.life * 0.72 * o.alpha;
      g.fillStyle = rgba(p.alt ? B : A, 0.95);
      g.beginPath();
      g.arc(p.x, p.y, p.r * dpr * (0.5 + p.life), 0, INF_TAU);
      g.fill();
    }

    // Импульсы повторяют форму бесконечности, а не создают отдельный объект поверх кнопки.
    h._infRip = h._infRip || [];
    if (live && beat > 0.92 && now - (h._infBeat || 0) > 320) {
      h._infBeat = now;
      if (h._infRip.length < 3) h._infRip.push({ s: 1, a: 0.3 });
    }
    for (let i = h._infRip.length - 1; i >= 0; i--) {
      const p = h._infRip[i];
      p.s += dt * 0.5;
      p.a -= dt * 0.3;
      if (p.a <= 0.01) {
        h._infRip.splice(i, 1);
        continue;
      }
      g.save();
      g.translate(c.x, c.y);
      g.rotate(rotation);
      const rsScale = span * scale * p.s;
      g.scale(rsScale, rsScale * stretchY);
      g.globalAlpha = p.a * o.alpha;
      g.strokeStyle = rgba(A, 0.9);
      g.lineWidth = 1.5 * dpr / rsScale;
      g.stroke(h._infPath);
      g.restore();
    }
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const __infCost = performance.now() - __infStart;
    Viz._infMs = (Viz._infMs || __infCost) * 0.95 + __infCost * 0.05;
    Viz._infFrames = (Viz._infFrames || 0) + 1;
    Viz._infPointerX = pointer.x;
  }

  /** Полоса времени — внешнее ледяное кольцо. Геометрия хранится на canvas, DOM не обновляется каждый кадр. */
  function ringTimeline() {
    const a = Player.audio;
    const duration = isFinite(a.duration) && a.duration > 0 ? a.duration : !a.src && Player.current?.duration > 0 ? Player.current.duration : 0;
    const current = Math.max(0, Math.min(duration, isFinite(a.currentTime) ? a.currentTime : 0));
    return { duration, current, progress: duration > 0 ? current / duration : 0 };
  }

  function syncRingSeek(h, c, R, flat, tilt, dpr) {
    const canvas = h.canvas;
    const el = h.seekEl;
    const time = ringTimeline();
    if (el) {
      const layout = `${canvas.offsetLeft}:${canvas.offsetTop}:${canvas.clientWidth}:${canvas.clientHeight}`;
      if (h._ringLayout !== layout) {
        h._ringLayout = layout;
        el.style.left = `${canvas.offsetLeft}px`;
        el.style.top = `${canvas.offsetTop}px`;
        el.style.width = `${canvas.clientWidth}px`;
        el.style.height = `${canvas.clientHeight}px`;
      }
    }
    const geo = canvas._ringGeometry || (canvas._ringGeometry = {});
    geo.x = c.x / dpr;
    geo.y = c.y / dpr;
    geo.r = R / dpr;
    geo.flat = flat;
    geo.tilt = tilt;
    geo.progress = time.progress;
    geo.duration = time.duration;
    geo.current = time.current;
    if (el) {
      el._ringGeometry = geo;
      const enabled = time.duration > 0 && Boolean(Player.current);
      if (h._ringEnabled !== enabled) {
        h._ringEnabled = enabled;
        el.classList.toggle('available', enabled);
        el.tabIndex = enabled ? 0 : -1;
        el.setAttribute('aria-disabled', String(!enabled));
      }
      const now = performance.now();
      if (enabled && (now - (h._ringAriaAt || 0) > 500 || h._ringAriaDuration !== time.duration)) {
        h._ringAriaAt = now;
        h._ringAriaDuration = time.duration;
        el.setAttribute('aria-valuemax', String(Math.round(time.duration)));
        el.setAttribute('aria-valuenow', String(Math.floor(time.current)));
        el.setAttribute('aria-valuetext', `${fmtTime(time.current)} из ${fmtTime(time.duration)}`);
      }
    }
    if (h._ringTimeBox === undefined) h._ringTimeBox = canvas.closest('.wv-hero')?.querySelector('.wv-orbit-time') || null;
    const seconds = Math.floor(time.current);
    const duration = Math.floor(time.duration);
    if (h._ringTimeBox && (h._ringTimeCur !== seconds || h._ringTimeDur !== duration)) {
      h._ringTimeCur = seconds;
      h._ringTimeDur = duration;
      h._ringTimeBox.querySelector('[data-ring-current]').textContent = fmtTime(seconds);
      h._ringTimeBox.querySelector('[data-ring-duration]').textContent = fmtTime(duration);
    }
  }

  function drawRingTimeline(h, c, R, flat, tilt, dpr, A, B) {
    const g = h.g;
    const radius = R * 2.05;
    const start = -Math.PI / 2;
    const time = ringTimeline();
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = h.opts.alpha;
    g.lineCap = 'round';
    g.shadowBlur = 0;
    g.strokeStyle = rgba([159, 191, 224], 0.16);
    g.lineWidth = 3 * dpr;
    g.beginPath();
    g.ellipse(c.x, c.y, radius, radius * flat, tilt, 0, INF_TAU);
    g.stroke();
    if (time.duration > 0) {
      const end = start + time.progress * INF_TAU;
      const light = themeGradient(g, c.x - radius, c.y, c.x + radius, c.y);
      g.strokeStyle = light;
      g.globalAlpha = 0.86 * h.opts.alpha;
      g.lineWidth = 2.4 * dpr;
      g.shadowBlur = 4 * dpr;
      g.shadowColor = rgba(A, 0.5);
      g.beginPath();
      g.ellipse(c.x, c.y, radius, radius * flat, tilt, start, end);
      g.stroke();
      g.shadowBlur = 0;
      const a = end;
      const x = Math.cos(a) * radius;
      const y = Math.sin(a) * radius * flat;
      const hx = c.x + x * Math.cos(tilt) - y * Math.sin(tilt);
      const hy = c.y + x * Math.sin(tilt) + y * Math.cos(tilt);
      g.fillStyle = rgba([231, 245, 255], 0.94);
      g.beginPath();
      g.arc(hx, hy, 3 * dpr, 0, INF_TAU);
      g.fill();
      g.globalAlpha = 0.32 * h.opts.alpha;
      g.strokeStyle = rgba(B, 0.75);
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.arc(hx, hy, 6 * dpr, 0, INF_TAU);
      g.stroke();
    }
    g.globalAlpha = 1;
    syncRingSeek(h, c, radius, flat, tilt, dpr);
  }

  /** Прозрачная зона ввода: захватывает только само кольцо, не планету и не интерфейс. */
  function attachRingSeek(el, canvas) {
    el._ringSeekCleanup?.();
    let dragging = false;
    let pointerId = null;
    let frame = 0;
    let lastEvent = null;
    const fractionAt = (e, tolerance = 15) => {
      const geo = el._ringGeometry;
      if (!geo || !geo.duration) return null;
      const rect = el.getBoundingClientRect();
      const dx = e.clientX - rect.left - geo.x;
      const dy = e.clientY - rect.top - geo.y;
      const cs = Math.cos(geo.tilt);
      const sn = Math.sin(geo.tilt);
      const x = dx * cs + dy * sn;
      const y = -dx * sn + dy * cs;
      if (Math.abs(Math.hypot(x, y / geo.flat) - geo.r) > tolerance) return null;
      const angle = Math.atan2(y / geo.flat, x);
      return ((angle + Math.PI / 2 + INF_TAU) % INF_TAU) / INF_TAU;
    };
    const seekEvent = (e) => {
      const geo = el._ringGeometry;
      const fraction = fractionAt(e, dragging ? 120 : 15);
      if (fraction == null) return false;
      Player.seek(fraction * geo.duration);
      return true;
    };
    const move = (e) => {
      if (!dragging) {
        el.classList.toggle('near-ring', fractionAt(e) != null);
        return;
      }
      lastEvent = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (dragging && lastEvent) seekEvent(lastEvent);
      });
    };
    const down = (e) => {
      if (e.button !== 0 || el.getAttribute('aria-disabled') === 'true' || fractionAt(e) == null) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      pointerId = e.pointerId;
      lastEvent = e;
      el.setPointerCapture(pointerId);
      el.classList.add('drag');
      el.focus({ preventScroll: true });
      seekEvent(e);
    };
    const end = (e) => {
      if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
      if (e.type !== 'pointercancel' && e.type !== 'lostpointercapture') seekEvent(e);
      dragging = false;
      pointerId = null;
      lastEvent = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      el.classList.remove('drag');
      if (e.type !== 'lostpointercapture' && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const leave = () => { if (!dragging) el.classList.remove('near-ring'); };
    const key = (e) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      let seconds = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seconds = Player.audio.currentTime - 5;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seconds = Player.audio.currentTime + 5;
      else if (e.key === 'Home') seconds = 0;
      else if (e.key === 'End') seconds = Player.audio.duration - 0.25;
      if (seconds == null) return;
      e.preventDefault();
      e.stopPropagation();
      Player.seek(seconds);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('keydown', key);
    el._ringSeekCleanup = () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', end);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('keydown', key);
      el._ringGeometry = null;
      delete el._ringSeekCleanup;
    };
  }

  /** «Орбитальный прилив» и «Кольца Сатурна»: туманность, планета, луны и кольцевая система. */
  function drawTide(h, live, w, ht, dpr) {
    const started = performance.now();
    const g = h.g;
    const o = h.opts;
    const ringMode = o.style === 'rings';
    const now = started;
    const t = now / 1000;
    const dt = Math.min(0.05, Math.max(0.001, (now - (h._tideAt || now - 16)) / 1000));
    h._tideAt = now;
    if (!h._tidePalAt || now - h._tidePalAt > 450) {
      const cs = getComputedStyle(h.canvas);
      h._infTarget = [toRGB(cs.getPropertyValue('--mood-a').trim() || accent, accRGB), toRGB(cs.getPropertyValue('--mood-b').trim() || accent2, acc2RGB)];
      h._tidePalAt = now;
    }
    if (!h._infCur) h._infCur = h._infTarget.map((c) => c.slice());
    const ease = Math.min(1, dt * 4);
    for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) h._infCur[k][j] += (h._infTarget[k][j] - h._infCur[k][j]) * ease;
    const A = h._infCur[0];
    const B = h._infCur[1];
    const c = centerOf(h, w, ht, dpr);
    const vals = values(h, live, 44);
    const energy = live ? Math.min(1, Viz.bass * 0.85 + Viz.level * 0.65) : 0.1 + 0.04 * Math.sin(t * 0.7);
    const beat = live ? Viz.beat : 0;
    const pointer = o.pointer || { x: 0, y: 0, tx: 0, ty: 0 };
    const follow = 1 - Math.exp(-dt * 8);
    pointer.x += (pointer.tx - pointer.x) * follow;
    pointer.y += (pointer.ty - pointer.y) * follow;

    // Дальняя световая взвесь: 28 точек, а не отдельные DOM-частицы.
    if (!h._tideDust) {
      h._tideDust = Array.from({ length: 28 }, (_, i) => ({ x: infRand(i, 81), y: infRand(i, 82), ph: infRand(i, 83) * INF_TAU, r: 0.5 + infRand(i, 84) * 1.5, alt: i % 2 }));
    }
    g.globalCompositeOperation = 'source-over';
    for (const p of h._tideDust) {
      const x = p.x * w + Math.sin(t * 0.3 + p.ph) * 9 * dpr + pointer.x * 7 * dpr;
      const y = p.y * ht * 0.64 + Math.cos(t * 0.22 + p.ph) * 6 * dpr;
      g.globalAlpha = (0.06 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.7 + p.ph))) * o.alpha;
      g.fillStyle = rgba(p.alt ? B : A, 0.8);
      g.beginPath();
      g.arc(x, y, p.r * dpr, 0, INF_TAU);
      g.fill();
    }

    // Верхняя дымка и мягкие преломления света под стеклом.
    const mist = g.createLinearGradient(0, 0, 0, ht);
    mist.addColorStop(0, rgba(A, 0.025));
    mist.addColorStop(0.55, rgba(B, 0.055));
    mist.addColorStop(1, rgba(A, 0));
    g.globalAlpha = o.alpha;
    g.fillStyle = mist;
    g.fillRect(0, 0, w, ht);
    g.lineCap = 'round';
    for (let l = 0; l < 5; l++) {
      g.globalAlpha = (0.035 + l * 0.008) * o.alpha;
      g.strokeStyle = rgba(l % 2 ? B : A, 0.8);
      g.lineWidth = (5 + l * 2) * dpr;
      g.beginPath();
      for (let i = 0; i <= 26; i++) {
        const x = (i / 26) * w;
        const y = ht * (0.18 + l * 0.055) + Math.sin(i * 0.55 + t * 0.3 + l) * (8 + l * 2) * dpr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }

    const layers = [
      { y: 0.51, amp: 8, phase: 0.4, speed: 0.45, col: A, alpha: 0.12 },
      { y: 0.59, amp: 12, phase: 1.6, speed: 0.58, col: B, alpha: 0.16 },
      { y: 0.68, amp: 16, phase: 2.9, speed: 0.72, col: A, alpha: 0.2 },
      { y: 0.77, amp: 21, phase: 4.2, speed: 0.88, col: B, alpha: 0.24 },
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const pts = [];
      for (let i = 0; i <= 44; i++) {
        const x = (i / 44) * w;
        const wave = Math.sin(i * 0.33 + t * L.speed + L.phase) * L.amp + Math.sin(i * 0.17 - t * L.speed * 0.55 + L.phase) * L.amp * 0.45;
        const audio = vals[i] * L.amp * (live ? 1.4 : 0.35);
        pts.push([x, ht * L.y + (wave + audio) * dpr]);
      }
      const gr = g.createLinearGradient(0, ht * (L.y - 0.08), 0, ht);
      gr.addColorStop(0, rgba(L.col, L.alpha + energy * 0.05));
      gr.addColorStop(0.45, rgba(L.col, L.alpha * 0.65));
      gr.addColorStop(1, rgba(L.col, 0.015));
      g.globalAlpha = o.alpha;
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      g.lineTo(w, ht);
      g.lineTo(0, ht);
      g.closePath();
      g.fill();
      // Световая кромка воды: одна линия на слой, без тяжёлой тени по всему контуру.
      g.globalAlpha = (0.22 + li * 0.055) * o.alpha;
      g.strokeStyle = rgba(li % 2 ? B : A, 0.75);
      g.lineWidth = (1.1 + li * 0.25) * dpr;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      g.stroke();
      if (li === layers.length - 1) {
        // Пена только на переднем крае, редкие короткие штрихи.
        g.strokeStyle = rgba([239, 250, 255], 0.32);
        g.lineWidth = 1.2 * dpr;
        for (let i = 1; i < pts.length; i += 4) {
          const p = pts[i];
          g.globalAlpha = (0.14 + vals[i] * 0.22) * o.alpha;
          g.beginPath();
          g.moveTo(p[0] - 5 * dpr, p[1] - 1.5 * dpr);
          g.lineTo(p[0] + 5 * dpr, p[1] - 1.5 * dpr);
          g.stroke();
        }
      }
    }

    const R = Math.min(w, ht) * (ringMode ? 0.145 : 0.17);
    const orbitTilt = (ringMode ? -0.42 : -0.3) + pointer.x * (ringMode ? 0.08 : 0.06);
    const rotateOrbit = (x, y) => ({ x: c.x + x * Math.cos(orbitTilt) - y * Math.sin(orbitTilt), y: c.y + x * Math.sin(orbitTilt) + y * Math.cos(orbitTilt) });
    if (!h._tideMoons) {
      h._tideMoons = Array.from({ length: 3 }, (_, i) => ({ orbit: 1.55 + i * 0.48, phase: (i / 3) * INF_TAU, speed: 0.34 - i * 0.07, size: 4 + i * 2, alt: i % 2 }));
    }
    // Три орбитальные траектории и маленькие луны на них.
    for (let i = 0; i < h._tideMoons.length; i++) {
      const p = h._tideMoons[i];
      const orbit = R * p.orbit;
      g.globalAlpha = (0.14 + i * 0.035) * o.alpha;
      g.strokeStyle = rgba(i % 2 ? B : A, 0.75);
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.ellipse(c.x, c.y, orbit, orbit * 0.46, orbitTilt, 0, INF_TAU);
      g.stroke();
      const u = p.phase + t * p.speed * (live ? 1.5 : 0.65);
      const at = rotateOrbit(Math.cos(u) * orbit, Math.sin(u) * orbit * 0.46);
      const pr = p.size * dpr * (1 + beat * 0.05);
      const moon = g.createRadialGradient(at.x - pr * 0.35, at.y - pr * 0.35, 0, at.x, at.y, pr);
      moon.addColorStop(0, rgba([245, 250, 255], 0.95));
      moon.addColorStop(0.45, rgba(p.alt ? B : A, 0.9));
      moon.addColorStop(1, rgba([10, 18, 32], 0.95));
      g.globalAlpha = o.alpha;
      g.fillStyle = moon;
      g.beginPath();
      g.arc(at.x, at.y, pr, 0, INF_TAU);
      g.fill();
    }

    const aura = g.createRadialGradient(c.x, c.y, R * 0.2, c.x, c.y, R * 2.4);
    aura.addColorStop(0, rgba(A, 0.2 + energy * 0.09));
    aura.addColorStop(0.5, rgba(B, 0.08));
    aura.addColorStop(1, rgba(A, 0));
    g.globalAlpha = o.alpha;
    g.fillStyle = aura;
    g.fillRect(c.x - R * 2.4, c.y - R * 2.4, R * 4.8, R * 4.8);
    if (ringMode) {
      // Несколько независимых ледяных и каменных полос Сатурна, а не один ободок.
      for (let band = 0; band < 8; band++) {
        const mul = 1.45 + band * 0.11;
        g.globalAlpha = (0.12 + band * 0.018) * o.alpha;
        g.strokeStyle = rgba(band % 3 === 0 ? B : A, 0.82);
        g.lineWidth = (band % 3 === 1 ? 8 : 3.5) * dpr;
        g.beginPath();
        g.ellipse(c.x, c.y, R * mul, R * mul * 0.32, orbitTilt, 0, INF_TAU);
        g.stroke();
      }
    }
    // Задняя часть кольца — перед планетой.
    g.globalAlpha = 0.42 * o.alpha;
    g.strokeStyle = rgba(B, 0.72);
    g.lineWidth = 3.2 * dpr;
    g.beginPath();
    g.ellipse(c.x, c.y, R * 1.65, R * 0.48, orbitTilt, Math.PI, INF_TAU);
    g.stroke();
    // Центральная планета с атмосферой и теневой стороной.
    const planet = g.createRadialGradient(c.x - R * 0.38, c.y - R * 0.42, R * 0.06, c.x, c.y, R);
    planet.addColorStop(0, rgba([248, 252, 255], 0.98));
    planet.addColorStop(0.32, rgba(A, 0.95));
    planet.addColorStop(0.68, rgba(B, 0.8));
    planet.addColorStop(1, rgba([8, 14, 28], 0.98));
    g.fillStyle = planet;
    g.shadowBlur = (16 + energy * 14) * dpr;
    g.shadowColor = rgba(A, 0.62);
    g.beginPath();
    g.arc(c.x, c.y, R, 0, INF_TAU);
    g.fill();
    g.shadowBlur = 0;
    // Тонкая атмосферная кромка.
    g.globalAlpha = (0.24 + energy * 0.1) * o.alpha;
    g.strokeStyle = rgba(A, 0.9);
    g.lineWidth = 1.4 * dpr;
    g.beginPath();
    g.arc(c.x, c.y, R * 1.05, 0, INF_TAU);
    g.stroke();
    // Передняя яркая дуга кольца.
    g.globalAlpha = 0.78 * o.alpha;
    g.strokeStyle = rgba([232, 244, 255], 0.85);
    g.lineWidth = 3.2 * dpr;
    g.beginPath();
    g.ellipse(c.x, c.y, R * 1.65, R * 0.48, orbitTilt, 0, Math.PI);
    g.stroke();
    if (ringMode) {
      // Ледяные и каменные частицы медленно проходят сквозь полосы.
      if (!h._ringDust) {
        h._ringDust = Array.from({ length: 48 }, (_, i) => ({ u: infRand(i, 91) * INF_TAU, orbit: 1.45 + infRand(i, 92) * 0.77, size: 0.6 + infRand(i, 93) * 1.5, alt: i % 3 === 0 }));
      }
      for (const p of h._ringDust) {
        const u = p.u + t * 0.07 * (live ? 1.6 : 0.65);
        const orbit = R * p.orbit;
        const at = rotateOrbit(Math.cos(u) * orbit, Math.sin(u) * orbit * 0.32);
        g.globalAlpha = (0.16 + 0.22 * (0.5 + 0.5 * Math.sin(t + p.u))) * o.alpha;
        g.fillStyle = rgba(p.alt ? B : A, 0.85);
        g.beginPath();
        g.arc(at.x, at.y, p.size * dpr, 0, INF_TAU);
        g.fill();
      }
    }
    // Музыкальная корона: короткие лучи по спектру.
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 32; i++) {
      const u = (i / 32) * INF_TAU + t * 0.04;
      const inner = R * 1.18;
      const len = vals[i] * R * 0.38;
      g.globalAlpha = (0.12 + Math.min(0.48, vals[i])) * o.alpha;
      g.strokeStyle = rgba(i % 2 ? B : A, 0.85);
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      g.moveTo(c.x + Math.cos(u) * inner, c.y + Math.sin(u) * inner);
      g.lineTo(c.x + Math.cos(u) * (inner + len), c.y + Math.sin(u) * (inner + len));
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    drawRingTimeline(h, c, R, 0.32, orbitTilt, dpr, A, B);
    const cost = performance.now() - started;
    Viz._infMs = (Viz._infMs || cost) * 0.95 + cost * 0.05;
    Viz._infFrames = (Viz._infFrames || 0) + 1;
    Viz._infPointerX = pointer.x;
  }

  const mixRGB = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const SATURN_ICE = [
    { r: 1.36, w: 2, a: 0.18, tone: 0 },
    { r: 1.45, w: 5, a: 0.16, tone: 2 },
    { r: 1.54, w: 7, a: 0.13, tone: 0 },
    { r: 1.64, w: 3, a: 0.28, tone: 2 },
    { r: 1.76, w: 8, a: 0.12, tone: 1 },
    { r: 1.86, w: 2, a: 0.26, tone: 2 },
    { r: 1.96, w: 4, a: 0.13, tone: 0 },
  ];
  function drawPlanetRings(g, c, R, flat, tilt, dpr, A, B, front, alpha) {
    g.lineCap = 'butt';
    for (const band of SATURN_ICE) {
      g.globalAlpha = band.a * (front ? 1.3 : 0.65) * alpha;
      g.strokeStyle = rgba(band.tone === 2 ? [211, 224, 239] : band.tone ? B : A, 0.92);
      g.lineWidth = band.w * dpr;
      g.beginPath();
      g.ellipse(c.x, c.y, R * band.r, R * band.r * flat, tilt, front ? 0 : Math.PI, front ? Math.PI : INF_TAU);
      g.stroke();
    }
  }

  /** Газовый гигант: облачные слои ограничены сферой, терминатор скрывает дальнюю сторону. */
  function drawGasGiant(g, c, R, dpr, A, B, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.beginPath();
    g.arc(c.x, c.y, R, 0, INF_TAU);
    g.clip();
    const sphere = g.createRadialGradient(c.x - R * 0.43, c.y - R * 0.45, R * 0.04, c.x, c.y, R * 1.08);
    sphere.addColorStop(0, rgba([232, 242, 251], 0.98));
    sphere.addColorStop(0.18, rgba(mixRGB(A, [219, 232, 243], 0.58), 0.98));
    sphere.addColorStop(0.48, rgba(mixRGB(A, [48, 64, 93], 0.42), 1));
    sphere.addColorStop(0.76, rgba(mixRGB(B, [19, 29, 51], 0.64), 1));
    sphere.addColorStop(1, rgba([4, 9, 22], 1));
    g.fillStyle = sphere;
    g.shadowBlur = 9 * dpr;
    g.shadowColor = rgba(A, 0.3);
    g.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    g.shadowBlur = 0;
    for (let i = 0; i < 11; i++) {
      const y = c.y - R * 0.9 + i * R * 0.18;
      const bow = Math.sin((i / 10) * Math.PI) * R * 0.15;
      const thick = R * (0.043 + (i % 3) * 0.017);
      g.globalAlpha = (0.12 + (i % 2) * 0.055) * alpha;
      g.fillStyle = rgba(i % 3 === 0 ? mixRGB(B, [220, 228, 240], 0.44) : mixRGB(A, [226, 234, 243], 0.56), 1);
      g.beginPath();
      g.moveTo(c.x - R * 1.1, y);
      g.bezierCurveTo(c.x - R * 0.48, y + bow, c.x + R * 0.48, y + bow, c.x + R * 1.1, y);
      g.lineTo(c.x + R * 1.1, y + thick);
      g.bezierCurveTo(c.x + R * 0.48, y + bow + thick, c.x - R * 0.48, y + bow + thick, c.x - R * 1.1, y + thick);
      g.closePath();
      g.fill();
      g.globalAlpha = 0.09 * alpha;
      g.strokeStyle = rgba([226, 237, 250], 0.9);
      g.lineWidth = 0.8 * dpr;
      g.beginPath();
      g.moveTo(c.x - R, y + thick * 1.8);
      g.bezierCurveTo(c.x - R * 0.4, y + bow + thick * 2.1, c.x + R * 0.4, y + bow + thick * 2.1, c.x + R, y + thick * 1.8);
      g.stroke();
    }
    const terminator = g.createLinearGradient(c.x - R * 0.85, c.y - R * 0.5, c.x + R * 0.85, c.y + R * 0.3);
    terminator.addColorStop(0, rgba([240, 248, 255], 0.08));
    terminator.addColorStop(0.38, rgba([7, 13, 28], 0));
    terminator.addColorStop(0.66, rgba([4, 9, 23], 0.22));
    terminator.addColorStop(1, rgba([2, 5, 15], 0.9));
    g.globalAlpha = alpha;
    g.fillStyle = terminator;
    g.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    const atmosphere = g.createLinearGradient(c.x - R, c.y - R, c.x + R, c.y + R);
    atmosphere.addColorStop(0, rgba([231, 246, 255], 0.68));
    atmosphere.addColorStop(0.4, rgba(A, 0.32));
    atmosphere.addColorStop(0.72, rgba(B, 0.15));
    atmosphere.addColorStop(1, rgba(A, 0.035));
    g.strokeStyle = atmosphere;
    g.lineWidth = 2.2 * dpr;
    g.beginPath();
    g.arc(c.x, c.y, R * 0.988, 0, INF_TAU);
    g.stroke();
    g.restore();
  }

  /** Полноэкранная звёздная система: газовый гигант, планеты, пояс астероидов и музыкальная корона. */
  function drawSolarSystem(h, live, w, ht, dpr) {
    const started = performance.now();
    const g = h.g;
    const o = h.opts;
    const now = started;
    const t = now / 1000;
    const dt = Math.min(0.05, Math.max(0.001, (now - (h._solarAt || now - 16)) / 1000));
    h._solarAt = now;
    if (!h._solarPalAt || now - h._solarPalAt > 450) {
      const cs = getComputedStyle(h.canvas);
      h._infTarget = [toRGB(cs.getPropertyValue('--mood-a').trim() || accent, accRGB), toRGB(cs.getPropertyValue('--mood-b').trim() || accent2, acc2RGB)];
      h._solarPalAt = now;
    }
    if (!h._infCur) h._infCur = h._infTarget.map((c) => c.slice());
    const ease = Math.min(1, dt * 4);
    for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) h._infCur[k][j] += (h._infTarget[k][j] - h._infCur[k][j]) * ease;
    const A = h._infCur[0];
    const B = h._infCur[1];
    const c = centerOf(h, w, ht, dpr);
    const vals = values(h, live, 56);
    let energy = live ? Math.min(1, Viz.bass * 0.85 + Viz.level * 0.65) : 0.12 + 0.04 * Math.sin(t * 0.8);
    h._solarEnergy ??= energy;
    h._solarEnergy += (energy - h._solarEnergy) * (1 - Math.exp(-dt * 7));
    energy = h._solarEnergy;
    const beat = live ? Viz.beat : 0;
    const pointer = o.pointer || { x: 0, y: 0, tx: 0, ty: 0 };
    const follow = 1 - Math.exp(-dt * 8);
    pointer.x += (pointer.tx - pointer.x) * follow;
    pointer.y += (pointer.ty - pointer.y) * follow;
    const tilt = -0.1 + pointer.x * 0.075;
    const flat = 0.54 + pointer.y * 0.055;
    const rc = Math.cos(tilt);
    const rs = Math.sin(tilt);
    const rotate = (x, y) => ({ x: c.x + x * rc - y * rs, y: c.y + x * rs + y * rc });

    if (!h._solarStars) {
      h._solarStars = Array.from({ length: 112 }, (_, i) => ({
        x: infRand(i, 41), y: infRand(i, 42), r: 0.35 + infRand(i, 43) * 1.45,
        a: 0.12 + infRand(i, 44) * 0.54, ph: infRand(i, 45) * INF_TAU,
        tw: 0.35 + infRand(i, 46) * 1.25, depth: 0.25 + infRand(i, 47), alt: infRand(i, 48) > 0.58,
      }));
    }
    g.globalCompositeOperation = 'source-over';
    for (const p of h._solarStars) {
      const x = (p.x * w + pointer.x * p.depth * 14 * dpr + Math.sin(t * 0.08 + p.ph) * 5 * dpr + w) % w;
      const y = p.y * ht + pointer.y * p.depth * 10 * dpr;
      g.globalAlpha = p.a * (0.62 + 0.38 * Math.sin(t * p.tw + p.ph)) * o.alpha;
      g.fillStyle = rgba(p.alt ? B : A, 0.92);
      g.beginPath();
      g.arc(x, y, p.r * dpr * (1 + beat * 0.18), 0, INF_TAU);
      g.fill();
    }

    // Туманность не перекрывает текст: самый яркий свет остаётся вокруг звезды.
    let neb = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.min(w, ht) * 0.58);
    neb.addColorStop(0, rgba(A, 0.11 + energy * 0.04));
    neb.addColorStop(0.45, rgba(B, 0.045));
    neb.addColorStop(1, rgba(A, 0));
    g.globalAlpha = o.alpha;
    g.fillStyle = neb;
    g.fillRect(0, 0, w, ht);

    const R = Math.min(ht * 0.118, w * 0.076) * (1 + energy * 0.035 + beat * 0.012);
    // Орбиты и планеты имеют общий наклон, поэтому система выглядит как единый объёмный объект.
    if (!h._planets) {
      h._planets = Array.from({ length: 5 }, (_, i) => ({
        orbit: 1.85 + i * 0.61, angle: (i / 5) * INF_TAU + (infRand(i, 51) - 0.5) * 0.45,
        speed: 0.16 - i * 0.018, size: (5.5 + infRand(i, 52) * 8 + i * 0.7) * 1.25,
        alt: i % 2 === 1, ring: i === 2,
      }));
    }
    const targetSpeed = live ? 1 + energy * 0.75 : 0.42;
    h._solarSpeed ??= targetSpeed;
    h._solarSpeed += (targetSpeed - h._solarSpeed) * (1 - Math.exp(-dt * 3.5));
    const speed = h._solarSpeed;
    for (let i = 0; i < h._planets.length; i++) {
      const p = h._planets[i];
      const orbit = R * p.orbit;
      g.globalAlpha = (0.13 + i * 0.015) * o.alpha;
      g.strokeStyle = rgba(i % 2 ? B : A, 0.8);
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.ellipse(c.x, c.y, orbit, orbit * flat, tilt, 0, INF_TAU);
      g.stroke();
    }

    // Пояс астероидов: угол накапливается по времени кадра, а не умножается на меняющуюся энергию.
    g.fillStyle = rgba(A, 0.8);
    h._solarBeltAngle = (h._solarBeltAngle || 0) + dt * 0.035 * speed;
    for (let i = 0; i < 56; i++) {
      const u = infRand(i, 61) * INF_TAU + h._solarBeltAngle;
      const orbit = R * (2.95 + infRand(i, 62) * 0.18);
      const at = rotate(Math.cos(u) * orbit, Math.sin(u) * orbit * flat);
      g.globalAlpha = (0.1 + infRand(i, 63) * 0.22) * o.alpha;
      g.beginPath();
      g.arc(at.x, at.y, (0.45 + infRand(i, 64) * 0.85) * dpr, 0, INF_TAU);
      g.fill();
    }

    for (let i = 0; i < h._planets.length; i++) {
      const p = h._planets[i];
      // Интегрирование угла устраняет скачок t * speed при каждом изменении громкости.
      const u = p.angle += dt * p.speed * speed;
      // Диагностика плавности: музыка не должна телепортировать планету по орбите.
      const previousU = h._solarPrevU?.[i];
      const angleStep = previousU == null ? 0 : Math.abs(u - previousU);
      (h._solarPrevU || (h._solarPrevU = []))[i] = u;
      Viz._solarMaxStep = Math.max(Viz._solarMaxStep || 0, angleStep);
      if (angleStep > 0.12) Viz._solarJumps = (Viz._solarJumps || 0) + 1;
      const orbit = R * p.orbit;
      const at = rotate(Math.cos(u) * orbit, Math.sin(u) * orbit * flat);
      const pr = p.size * 1.22 * dpr * (1 + beat * 0.04);
      const col = p.alt ? B : A;
      const glow = g.createRadialGradient(at.x, at.y, pr * 0.4, at.x, at.y, pr * 2.5);
      glow.addColorStop(0, rgba(col, 0.2));
      glow.addColorStop(1, rgba(col, 0));
      g.globalAlpha = o.alpha;
      g.fillStyle = glow;
      g.fillRect(at.x - pr * 2.5, at.y - pr * 2.5, pr * 5, pr * 5);
      if (p.ring) {
        g.strokeStyle = rgba([225, 232, 250], 0.48);
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.ellipse(at.x, at.y, pr * 1.85, pr * 0.52, tilt - 0.2, 0, INF_TAU);
        g.stroke();
      }
      const sphere = g.createRadialGradient(at.x - pr * 0.38, at.y - pr * 0.42, pr * 0.08, at.x, at.y, pr);
      sphere.addColorStop(0, rgba([245, 248, 255], 0.96));
      sphere.addColorStop(0.34, rgba(col, 0.95));
      sphere.addColorStop(1, rgba([9, 14, 28], 0.98));
      g.fillStyle = sphere;
      g.beginPath();
      g.arc(at.x, at.y, pr, 0, INF_TAU);
      g.fill();
    }

    // Спектр остаётся цветным и не выжигает детали атмосферы центральной планеты.
    g.globalCompositeOperation = 'source-over';
    g.lineCap = 'round';
    for (let i = 0; i < 56; i++) {
      const u = (i / 56) * INF_TAU + t * 0.035;
      const len = vals[i] * R * 0.38;
      const inner = R * 1.12;
      g.globalAlpha = (0.07 + Math.min(0.32, vals[i] * 0.7)) * o.alpha;
      g.strokeStyle = rgba(i % 2 ? B : A, 0.84);
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      g.moveTo(c.x + Math.cos(u) * inner, c.y + Math.sin(u) * inner);
      g.lineTo(c.x + Math.cos(u) * (inner + len), c.y + Math.sin(u) * (inner + len));
      g.stroke();
    }
    const halo = g.createRadialGradient(c.x, c.y, R * 0.82, c.x, c.y, R * 1.68);
    halo.addColorStop(0, rgba(A, 0.035));
    halo.addColorStop(0.38, rgba(A, 0.09 + energy * 0.035));
    halo.addColorStop(0.68, rgba(B, 0.035));
    halo.addColorStop(1, rgba(A, 0));
    g.globalAlpha = o.alpha;
    g.fillStyle = halo;
    g.fillRect(c.x - R * 1.7, c.y - R * 1.7, R * 3.4, R * 3.4);
    drawPlanetRings(g, c, R, 0.3, tilt, dpr, A, B, false, o.alpha);
    drawGasGiant(g, c, R, dpr, A, B, o.alpha);
    drawPlanetRings(g, c, R, 0.3, tilt, dpr, A, B, true, o.alpha);
    drawRingTimeline(h, c, R, 0.3, tilt, dpr, A, B);

    // Редкие падающие звёзды — периодические, без случайного создания и удаления объектов.
    for (let i = 0; i < 2; i++) {
      const phase = (t * 0.035 + i * 0.47) % 1;
      const alpha = Math.pow(Math.sin(phase * Math.PI), 12) * 0.42;
      const x = w * (1.08 - phase * 1.16);
      const y = ht * (0.12 + i * 0.22 + phase * 0.2);
      g.globalAlpha = alpha * o.alpha;
      g.strokeStyle = rgba([238, 247, 255], 0.9);
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 72 * dpr, y - 30 * dpr);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const cost = performance.now() - started;
    Viz._infMs = (Viz._infMs || cost) * 0.95 + cost * 0.05;
    Viz._infFrames = (Viz._infFrames || 0) + 1;
    Viz._infPointerX = pointer.x;
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
