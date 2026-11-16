'use strict';
/* «Чернила» и «вода» над клипом.
   Обычные элементы меняют цвет по яркости фона вокруг них. Название и исполнитель дополнительно
   получают двумерную карту света: через background-clip:text темнеет даже только часть буквы.
   WebView2 копирует уже готовый кадр окна в память; изображение нигде не сохраняется и наружу не уходит. */
(function () {
  const PERIOD = 90; // мс между кадрами; busy не даёт захватам накапливаться
  const WIDTH = 640; // до 2,4 CSS-пикселя на точку: хватает для границы внутри одной буквы
  const PAD = 14;
  const TO_DARK = 0.55;
  const TO_LIGHT = 0.47;
  const VOTES = 2;
  const DWELL = 300;
  const FADE = 280;
  // У длинной строки исполнителей 96 колонок накрывали букву вместе с промежутком.
  // 192 × 28 сохраняет настоящие зазоры; один кадр по-прежнему обслуживает весь интерфейс.
  const WATER_W = 192;
  const WATER_H = 28;
  const BRIGHT_BG = '.clip-box.clip-on, .vz-media video, .vz-img:not(.blur)';
  const SPATIAL = '.np-title, .np-artist, .np-source, #vizTitle, #vizArtist';

  const live = new Map();
  let timer = 0;
  let busy = false;
  let raf = 0;
  const stats = { frames: 0, frameMs: 0, paints: 0 };

  function targets() {
    const np = document.getElementById('nowPlaying');
    if (np && !np.classList.contains('hidden')) {
      if (!np.classList.contains('viz-on') || !np.querySelector(BRIGHT_BG)) return [];
      return [
        ...np.querySelectorAll(
          '.np-close, .np-source, .np-title, .np-artist, .np-seek, .np-controls > *, #npLike, #npLyricsBtn, #npVizBtn, #npEqBtn, .np-actions > [data-act="current-menu"], .np-vol, .vz-gear',
        ),
        ...document.querySelectorAll('.win-ctrls'),
      ];
    }
    const stage = document.getElementById('vizStage');
    if (stage && stage.isConnected && stage.querySelector(BRIGHT_BG)) return [...stage.querySelectorAll('#vizTitle, #vizArtist, .vz-ctrl > *, .vz-fs, .vz-gear')];
    return [];
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth01 = (v) => {
    const x = clamp01(v);
    return x * x * (3 - 2 * x);
  };
  const linearLuma = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  const contrast = (a, b) => {
    const la = linearLuma(clamp01(a)) + 0.05;
    const lb = linearLuma(clamp01(b)) + 0.05;
    return Math.max(la, lb) / Math.min(la, lb);
  };

  /** Графит при умеренном засвете → глубокий чёрный при почти белом кадре. */
  function darkRGB(l) {
    const t = smooth01((l - 0.5) / 0.45);
    return [Math.round(17 - 15 * t), Math.round(21 - 18 * t), Math.round(29 - 24 * t)];
  }

  function inkRGB(l) {
    // Узкий переход: на среднем сером нельзя надолго оставлять серый же текст.
    const dark = smooth01((l - 0.48) / 0.03);
    const shade = darkRGB(l);
    const edge = 1 - Math.abs(dark - 0.5) * 2;
    const tint = edge * 0.035;
    return [243, 247, 255].map((base, i) => base + (shade[i] - base) * dark + (i === 0 ? 112 - base : i === 1 ? 207 - base : 245 - base) * tint);
  }

  // 256 оттенков достаточно для плавности, а в горячем цикле не создаются тысячи массивов каждую секунду.
  const INK_LUT = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) INK_LUT.set(inkRGB(i / 255), i * 3);

  function percentile(hist, n, q) {
    let acc = 0;
    for (let b = 0; b < hist.length; b++) {
      acc += hist[b];
      if (acc >= n * q) return (b + 0.5) / hist.length;
    }
    return 1;
  }

  /** Яркость фона в «кольце» вокруг элемента: текст внутри не участвует в замере. */
  function ringLuma(px, w, h, r, kx, ky) {
    const x0 = Math.max(0, Math.floor((r.left - PAD) * kx));
    const y0 = Math.max(0, Math.floor((r.top - PAD) * ky));
    const x1 = Math.min(w - 1, Math.ceil((r.right + PAD) * kx));
    const y1 = Math.min(h - 1, Math.ceil((r.bottom + PAD) * ky));
    const ix0 = r.left * kx;
    const ix1 = r.right * kx;
    const iy0 = r.top * ky;
    const iy1 = r.bottom * ky;
    const hist = new Uint16Array(32);
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
    // Медиана лучше p85 описывает основной фон, а p75 сохраняет реакцию на засвет части контрола.
    return (sum / n) * 0.3 + percentile(hist, n, 0.5) * 0.45 + percentile(hist, n, 0.75) * 0.25;
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

  function point(f, x, y) {
    const cx = Math.max(0, Math.min(f.w - 1, x));
    const cy = Math.max(0, Math.min(f.h - 1, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(f.w - 1, x0 + 1);
    const y1 = Math.min(f.h - 1, y0 + 1);
    const u = cx - x0;
    const v = cy - y0;
    const a = f.px[y0 * f.w + x0] * (1 - u) + f.px[y0 * f.w + x1] * u;
    const b = f.px[y1 * f.w + x0] * (1 - u) + f.px[y1 * f.w + x1] * u;
    return (a * (1 - v) + b * v) / 255;
  }

  /** Видимая строка + запас на межбуквенные интервалы и выступы крайних глифов. */
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
    // Range учитывает text-transform и настоящий шрифт; canvas — запас для старых WebView.
    const natural = Math.min(r.width, Math.max(advance, tr.width || 0));
    let textLeft = r.left;
    if (cs.textAlign === 'center') textLeft += (r.width - natural) / 2;
    else if (cs.textAlign === 'right' || cs.textAlign === 'end') textLeft += r.width - natural;
    const pad = Math.max(3, Math.ceil(parseFloat(cs.fontSize) * 0.12));
    const left = textLeft - pad;
    const width = natural + pad * 2;
    return {
      left, right: left + width, top: r.top, bottom: r.bottom, width, height: r.height,
      cssLeft: left - r.left, cssWidth: width, textLeft: textLeft - r.left, textWidth: natural,
      key: [text, cs.font, cs.letterSpacing, cs.textTransform, left, r.top, width, r.height].join('|'),
    };
  }

  /** Альфа-маска глифов: в прозрачных промежутках кадр содержит настоящий фон, а не цвет текста. */
  function textMask(el, box) {
    const cs = getComputedStyle(el);
    let text = el.textContent.trim();
    if (cs.textTransform === 'uppercase') text = text.toUpperCase();
    else if (cs.textTransform === 'lowercase') text = text.toLowerCase();
    else if (cs.textTransform === 'capitalize') text = text.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
    const canvas = document.createElement('canvas');
    canvas.width = WATER_W;
    canvas.height = WATER_H;
    const ctx = canvas.getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing;
    const measure = (s) => ctx.measureText(s).width;
    if (measure(text) > box.textWidth) {
      const chars = [...text];
      let lo = 0;
      let hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(chars.slice(0, mid).join('') + '…') <= box.textWidth) lo = mid;
        else hi = mid - 1;
      }
      text = chars.slice(0, lo).join('') + '…';
    }
    const metrics = ctx.measureText(text);
    const size = parseFloat(cs.fontSize) || 16;
    const ascent = metrics.fontBoundingBoxAscent || size * 0.8;
    const descent = metrics.fontBoundingBoxDescent || size * 0.2;
    const baseline = (box.height - ascent - descent) * 0.5 + ascent;
    ctx.scale(WATER_W / box.width, WATER_H / box.height);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, box.textLeft - box.cssLeft, baseline);
    const rgba = ctx.getImageData(0, 0, WATER_W, WATER_H).data;
    const alpha = new Uint8Array(WATER_W * WATER_H);
    // Один соседний шаг сетки защищает от чтения старого текста на его antialias-краях.
    // Без него яркий штрих из прошлого кадра попадает в карту фона и даёт полосы-двойники.
    for (let y = 0; y < WATER_H; y++) {
      for (let x = 0; x < WATER_W; x++) {
        let a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= WATER_H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < WATER_W) a = Math.max(a, rgba[(yy * WATER_W + xx) * 4 + 3]);
          }
        }
        alpha[y * WATER_W + x] = a;
      }
    }
    return alpha;
  }

  /** Медиана трёх близких точек не принимает ореол буквы или одиночный блик за весь фон. */
  function sampleBand(f, x, y, dx, dy) {
    const a = point(f, x + dx * 2, y + dy * 2);
    const b = point(f, x + dx * 4, y + dy * 4);
    const c = point(f, x + dx * 7, y + dy * 7);
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }

  /** Coons-поверхность: точно сохраняет фон у каждого края и не усредняет разные засветы между собой. */
  function waterField(f, box, kx, ky, mask) {
    const top = new Float32Array(WATER_W);
    const bottom = new Float32Array(WATER_W);
    const left = new Float32Array(WATER_H);
    const right = new Float32Array(WATER_H);
    for (let x = 0; x < WATER_W; x++) {
      const sx = (box.left + ((x + 0.5) / WATER_W) * box.width) * kx;
      top[x] = sampleBand(f, sx, box.top * ky, 0, -ky);
      bottom[x] = sampleBand(f, sx, box.bottom * ky, 0, ky);
    }
    for (let y = 0; y < WATER_H; y++) {
      const sy = (box.top + ((y + 0.5) / WATER_H) * box.height) * ky;
      left[y] = sampleBand(f, box.left * kx, sy, -kx, 0);
      right[y] = sampleBand(f, box.right * kx, sy, kx, 0);
    }
    const tl = (top[0] + left[0]) * 0.5;
    const tr = (top[WATER_W - 1] + right[0]) * 0.5;
    const bl = (bottom[0] + left[WATER_H - 1]) * 0.5;
    const br = (bottom[WATER_W - 1] + right[WATER_H - 1]) * 0.5;
    const field = new Float32Array(WATER_W * WATER_H);
    for (let y = 0; y < WATER_H; y++) {
      const v = (y + 0.5) / WATER_H;
      for (let x = 0; x < WATER_W; x++) {
        const u = (x + 0.5) / WATER_W;
        const vertical = top[x] * (1 - v) + bottom[x] * v;
        const horizontal = left[y] * (1 - u) + right[y] * u;
        const corners = tl * (1 - u) * (1 - v) + tr * u * (1 - v) + bl * (1 - u) * v + br * u * v;
        field[y * WATER_W + x] = clamp01(vertical + horizontal - corners);
      }
    }
    if (mask) {
      const prev = new Int16Array(WATER_W);
      const next = new Int16Array(WATER_W);
      for (let y = 0; y < WATER_H; y++) {
        const row = y * WATER_W;
        for (let x = 0; x < WATER_W; x++) {
          const i = row + x;
          // Только полностью прозрачная маска: antialias-край всё ещё содержит старый текст.
          if (mask[i] !== 0) continue;
          const sx = (box.left + ((x + 0.5) / WATER_W) * box.width) * kx;
          const sy = (box.top + ((y + 0.5) / WATER_H) * box.height) * ky;
          field[i] = point(f, sx, sy);
        }
        let at = -1;
        for (let x = 0; x < WATER_W; x++) {
          if (mask[row + x] === 0) at = x;
          prev[x] = at;
        }
        at = -1;
        for (let x = WATER_W - 1; x >= 0; x--) {
          if (mask[row + x] === 0) at = x;
          next[x] = at;
        }
        // Под самой буквой фон продолжается между ближайшими видимыми промежутками слева и справа.
        for (let x = 0; x < WATER_W; x++) {
          const i = row + x;
          if (mask[i] === 0) continue;
          const base = field[i];
          const a = prev[x];
          const b = next[x];
          if (a >= 0 && b >= 0 && Math.abs(field[row + a] - field[row + b]) < 0.22) {
            const t = (x - a) / (b - a);
            field[i] = field[row + a] * (1 - t) + field[row + b] * t;
          } else if (a >= 0 || b >= 0) {
            // Резкий переход не растягиваем между далёкими промежутками: Coons уже знает его форму.
            // Ближайший настоящий фон лишь локально уточняет засвет внутри самой буквы.
            const at = a >= 0 && (b < 0 || x - a <= b - x) ? a : b;
            const distance = Math.abs(x - at);
            const weight = Math.max(0, 1 - distance / 5) * 0.95;
            field[i] = base * (1 - weight) + field[row + at] * weight;
          }
        }
      }
      // Широкий штрих может не иметь горизонтального зазора: уточняем его по строкам выше и ниже.
      // Этот проход идёт только после того, как прочитаны все реальные промежутки всех строк.
      for (let x = 0; x < WATER_W; x++) {
        let at = -1;
        for (let y = 0; y < WATER_H; y++) {
          if (mask[y * WATER_W + x] === 0) at = y;
          prev[y] = at;
        }
        at = -1;
        for (let y = WATER_H - 1; y >= 0; y--) {
          if (mask[y * WATER_W + x] === 0) at = y;
          next[y] = at;
        }
        for (let y = 0; y < WATER_H; y++) {
          const i = y * WATER_W + x;
          if (mask[i] === 0) continue;
          const base = field[i];
          const a = prev[y];
          const b = next[y];
          if (a >= 0 && b >= 0 && Math.abs(field[a * WATER_W + x] - field[b * WATER_W + x]) < 0.22) {
            const t = (y - a) / (b - a);
            field[i] = field[a * WATER_W + x] * (1 - t) + field[b * WATER_W + x] * t;
          } else if (a >= 0 || b >= 0) {
            const at = a >= 0 && (b < 0 || y - a <= b - y) ? a : b;
            const distance = Math.abs(y - at);
            const weight = Math.max(0, 1 - distance / 5) * 0.95;
            field[i] = base * (1 - weight) + field[at * WATER_W + x] * weight;
          }
        }
      }
    }
    let mean = 0;
    for (const l of field) mean += l;
    return { field, mean: mean / field.length };
  }

  function paintWater(el, st) {
    if (!st.canvas) {
      st.canvas = document.createElement('canvas');
      st.canvas.width = WATER_W;
      st.canvas.height = WATER_H;
      st.ctx = st.canvas.getContext('2d');
      st.image = st.ctx.createImageData(WATER_W, WATER_H);
    }
    const data = st.image.data;
    for (let i = 0; i < st.field.length; i++) {
      const tone = Math.round(clamp01(st.field[i]) * 255) * 3;
      data[i * 4] = INK_LUT[tone];
      data[i * 4 + 1] = INK_LUT[tone + 1];
      data[i * 4 + 2] = INK_LUT[tone + 2];
      data[i * 4 + 3] = 255;
    }
    st.ctx.putImageData(st.image, 0, 0);
    el.style.backgroundImage = `url(${st.canvas.toDataURL('image/png')})`;
    el.style.backgroundSize = `${st.box.width}px ${st.box.height}px`;
    el.style.backgroundPosition = `${st.box.cssLeft}px 0`;
    st.paints = (st.paints || 0) + 1;
    st.paintAt = performance.now();
    stats.paints++;
  }

  function enabled() {
    return !window.ZG_MOBILE && Boolean(window.App?.settings?.viz) && App.settings.viz.inkEnabled !== false;
  }

  async function measure() {
    if (!enabled()) {
      clear();
      busy = false;
      return;
    }
    if (busy || document.body.classList.contains('win-hidden') || document.hidden) return;
    const els = targets();
    if (!els.length) return clear();
    busy = true;
    try {
      const f = await frame();
      if (!enabled()) {
        clear();
        return;
      }
      if (!f) return;
      const kx = f.w / window.innerWidth;
      const ky = f.h / window.innerHeight;
      const now = performance.now();
      const seen = new Set();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const spatial = el.matches(SPATIAL);
        const box = spatial ? textBox(el) : null;
        if (spatial && !box) continue;
        seen.add(el);
        let st = live.get(el);
        if (!st) st = { ink: 0, target: 0, votes: 0, flipAt: 0, spatial, ready: false };
        if (spatial && st.maskKey !== box.key) {
          st.mask = textMask(el, box);
          st.maskKey = box.key;
        }
        const water = spatial ? waterField(f, box, kx, ky, st.mask) : null;
        const l = spatial ? water.mean : ringLuma(f.px, f.w, f.h, r, kx, ky);
        if (l == null) continue;
        if (!st.ready) {
          Object.assign(st, { lf: l, bgl: l, bglT: l, ready: true });
          live.set(el, st);
          el.classList.add('inkable');
          const [r, g, b] = darkRGB(l);
          el.style.setProperty('--ink-dark', `rgb(${r} ${g} ${b})`);
        }
        if (spatial) {
          el.classList.add('water-ink');
          st.fieldT = water.field;
          st.box = box;
          if (!st.field) st.field = water.field.slice();
          st.needPaint = true;
          // Для воды нет голосования и долгой задержки: поле меняется сразу, но плавно.
          st.target = l > TO_DARK ? 1 : l < TO_LIGHT ? 0 : st.target;
        } else {
          st.lf = st.lf * 0.4 + l * 0.6;
          const want = st.target === 0 ? st.lf > TO_DARK : st.lf < TO_LIGHT;
          st.votes = want ? st.votes + 1 : 0;
          if (st.votes >= VOTES && now - st.flipAt > DWELL) {
            st.target = 1 - st.target;
            st.flipAt = now;
            st.votes = 0;
          }
        }
        st.bglT = l;
        el.dataset.luma = l.toFixed(2);
      }
      for (const el of [...live.keys()]) if (!seen.has(el)) reset(el);
      animate();
    } catch {
      /* Если кадр не получился, следующий замер пройдёт без накопления запросов. */
    } finally {
      busy = false;
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
        if (st.spatial) {
          if (!st.field || !st.fieldT) continue;
          let dirty = st.needPaint;
          for (let i = 0; i < st.field.length; i++) {
            const d = st.fieldT[i] - st.field[i];
            if (Math.abs(d) > 0.002) {
              st.field[i] += d * Math.min(1, dt / 70);
              dirty = true;
            } else st.field[i] = st.fieldT[i];
          }
          if (dirty && now - (st.paintAt || 0) > 28) {
            paintWater(el, st);
            st.needPaint = false;
          }
          if (dirty) moving = true;
          continue;
        }
        if (st.bgl !== st.bglT) {
          const d = st.bglT - st.bgl;
          st.bgl = Math.abs(d) < 0.005 ? st.bglT : st.bgl + d * Math.min(1, dt / 170);
          el.style.setProperty('--bgl', st.bgl.toFixed(3));
          const [r, g, b] = darkRGB(st.bgl);
          el.style.setProperty('--ink-dark', `rgb(${r} ${g} ${b})`);
          if (st.bgl !== st.bglT) moving = true;
        }
        if (st.ink === st.target) continue;
        const d = st.target - st.ink;
        st.ink = Math.abs(d) < 0.004 ? st.target : st.ink + Math.sign(d) * Math.min(Math.abs(d), dt / FADE);
        const e = st.ink * st.ink * (3 - 2 * st.ink);
        el.style.setProperty('--ink', e.toFixed(3));
        if (st.ink !== st.target) moving = true;
      }
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function reset(el) {
    el.classList.remove('inkable', 'water-ink');
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
        timer = setInterval(measure, PERIOD);
        measure();
      }
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      busy = false;
      cancelAnimationFrame(raf);
      raf = 0;
      clear();
    },
    measure,
    enabled,
    _boxForTest: (el) => textBox(el),
    _test: {
      width: WATER_W,
      height: WATER_H,
      darkRGB,
      inkRGB,
      contrast,
      waterField: (f, box, cssWidth, cssHeight, mask) => waterField(f, box, f.w / cssWidth, f.h / cssHeight, mask),
    },
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
      return [...live].map(([el, st]) => ({
        el,
        ink: st.ink,
        target: st.target,
        luma: +(el.dataset.luma || 0),
        spatial: st.spatial,
        spread: st.field ? Math.max(...st.field) - Math.min(...st.field) : 0,
        paints: st.paints || 0,
      }));
    },
    get stats() {
      return { ...stats, period: PERIOD, width: WIDTH, active: live.size };
    },
  };
  window.Ink = Ink;
})();
