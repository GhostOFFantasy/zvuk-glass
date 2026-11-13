'use strict';
/* «Чернила» над клипом: элементы интерфейса поверх клипа или видео сами становятся тёмными там,
   где под ними светлый кадр, и снова светлыми над тёмным. Меняется только то, что сливается с фоном.

   Кадр клипа (YouTube внутри окна) прочитать скриптом нельзя, поэтому пару раз в секунду приложение
   копирует уже нарисованный кадр окна (WebView2 CapturePreview — без перерисовки страницы, ничего
   не моргает), уменьшает его до серой картинки шириной 240 точек и меряет яркость фона вокруг
   каждого элемента. Кадр живёт только в памяти. */
(function () {
  const PERIOD = 420; // мс между замерами
  const WIDTH = 240; // ширина серой копии кадра, точек
  const PAD = 14; // ширина «кольца» вокруг элемента, по которому меряем фон, px
  const TO_DARK = 0.56; // светлее — элемент темнеет (около 0,48 контраст белого и тёмного текста равен)
  const TO_LIGHT = 0.44; // темнее — снова светлый (между порогами — без изменений)
  const VOTES = 2; // столько замеров подряд фон должен быть «за», прежде чем цвет сменится
  const DWELL = 1200; // и не чаще раза в 1,2 с для одного элемента — без мелькания на быстрых склейках
  const FADE = 650; // длительность плавного перехода, мс

  const live = new Map(); // элемент → состояние
  let timer = 0;
  let busy = false;
  let raf = 0;

  // фон, который может быть светлым: идущий клип, своё видео или картинка без размытия
  const BRIGHT_BG = '.clip-box.clip-on, .vz-media video, .vz-img:not(.blur)';

  /** Что сейчас лежит поверх клипа/видео. */
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

  /** Яркость фона в «кольце» вокруг прямоугольника: смесь средней и светлой части (0..1). */
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
        if (inY && x > ix0 && x < ix1) continue; // сам элемент не считаем — только фон вокруг
        const l = px[y * w + x] / 255;
        sum += l;
        hist[Math.min(31, (l * 32) | 0)]++;
        n++;
      }
    }
    if (!n) return null;
    // 85-й процентиль: если заметная часть фона светлая, текст уже плохо читается
    let acc = 0;
    let p85 = 1;
    for (let b = 0; b < 32; b++) {
      acc += hist[b];
      if (acc >= n * 0.85) {
        p85 = (b + 0.5) / 32;
        break;
      }
    }
    return (sum / n) * 0.6 + p85 * 0.4;
  }

  /** Серая копия текущего кадра окна: { w, h, px: Uint8Array }. */
  async function frame() {
    const r = await window.zvuk.ui.probe(WIDTH);
    if (!r || !r.data) return null;
    const bin = atob(r.data);
    const px = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
    return { w: r.w, h: r.h, px };
  }

  async function measure() {
    if (busy || document.body.classList.contains('win-hidden') || document.hidden) return;
    const els = targets();
    if (!els.length) return clear();
    busy = true;
    try {
      const f = await frame();
      if (!f) return;
      // кадр снят в физических точках окна — переводим координаты элементов
      const kx = f.w / window.innerWidth;
      const ky = f.h / window.innerHeight;
      const now = performance.now();
      const seen = new Set();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const l = ringLuma(f.px, f.w, f.h, r, kx, ky);
        if (l == null) continue;
        seen.add(el);
        let st = live.get(el);
        if (!st) {
          st = { ink: 0, target: 0, lf: l, bgl: l, bglT: l, votes: 0, flipAt: 0 };
          live.set(el, st);
          el.classList.add('inkable');
        }
        st.lf = st.lf * 0.4 + l * 0.6; // сглаживание по времени
        const want = st.target === 0 ? st.lf > TO_DARK : st.lf < TO_LIGHT;
        st.votes = want ? st.votes + 1 : 0;
        if (st.votes >= VOTES && now - st.flipAt > DWELL) {
          st.target = 1 - st.target;
          st.flipAt = now;
          st.votes = 0;
        }
        st.bglT = st.lf;
        el.dataset.luma = st.lf.toFixed(2);
      }
      // элементы, которые больше не над клипом (или пропали с экрана), возвращаем как было
      for (const el of [...live.keys()]) if (!seen.has(el)) reset(el);
      animate();
    } catch {
      /* кадр не получился — попробуем в следующий раз */
    } finally {
      busy = false;
    }
  }

  /** Плавный переход: --ink от 0 (светлый интерфейс) до 1 (тёмный), все цвета считаются из него в CSS. */
  function animate() {
    if (raf) return;
    let last = performance.now();
    const step = (now) => {
      raf = 0;
      const dt = Math.min(64, now - last);
      last = now;
      let moving = false;
      for (const [el, st] of live) {
        // яркость фона (для силы тени у светлого текста) догоняет замер плавно
        if (st.bgl !== st.bglT) {
          const d = st.bglT - st.bgl;
          st.bgl = Math.abs(d) < 0.005 ? st.bglT : st.bgl + d * Math.min(1, dt / 280);
          el.style.setProperty('--bgl', st.bgl.toFixed(3));
          if (st.bgl !== st.bglT) moving = true;
        }
        if (st.ink === st.target) continue;
        const d = st.target - st.ink;
        st.ink = Math.abs(d) < 0.004 ? st.target : st.ink + Math.sign(d) * Math.min(Math.abs(d), dt / FADE);
        // мягкое начало и конец перехода
        const e = st.ink * st.ink * (3 - 2 * st.ink);
        el.style.setProperty('--ink', e.toFixed(3));
        if (st.ink !== st.target) moving = true;
      }
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function reset(el) {
    el.classList.remove('inkable');
    el.style.removeProperty('--ink');
    el.style.removeProperty('--bgl');
    delete el.dataset.luma;
    live.delete(el);
  }

  function clear() {
    for (const el of [...live.keys()]) reset(el);
  }

  const Ink = {
    start() {
      // снимок кадра окна есть только в WebView2 (Windows)
      if (window.ZG_MOBILE) return;
      if (!timer) timer = setInterval(measure, PERIOD);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      clear();
    },
    measure,
    /** Служебно: средняя яркость прямоугольника на кадре окна (проверка, что клип попадает в снимок). */
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
      return [...live].map(([el, st]) => ({ el, ink: st.ink, target: st.target, luma: +(el.dataset.luma || 0) }));
    },
  };
  window.Ink = Ink;
})();
