'use strict';
/* Полноэкранный плеер: 3D-карусель очереди, наклон карточек за курсором, режимы текста и визуализатора */
(function () {
  const root = document.getElementById('nowPlaying');
  const flow = document.getElementById('npFlow');
  const items = new Map(); // индекс в очереди → элемент
  const RANGE = 3;
  const RING_RANGE = 6;
  const RING_SLOTS = RING_RANGE * 2 + 1;
  // Классическая Cover Flow остаётся отдельной геометрией.
  const X = [0, 0.98, 1.66, 2.2, 2.6];
  const SC = [1, 0.7, 0.54, 0.44, 0.38];
  const RY = [0, 40, 50, 56, 60];
  const Z = [0, -140, -260, -360, -420];
  const OP = [1, 1, 0.75, 0.35, 0];

  let scene = null;
  const layout = { classic: false, width: 0, size: 0 };

  function ringRadius(size) {
    return Math.max(size * 0.5, Math.min(size * 1.72, layout.width / 2 - size * 0.34));
  }

  // Индексы замыкаются только там, где это разрешено режимом очереди.
  function ringOffset(i) {
    const n = Player.queue.length;
    const off = i - Player.index;
    if (!n || layout.classic || !(Player.endless || Player.repeat === 'all')) return off;
    const wrapped = ((off % n) + n) % n;
    return wrapped > n / 2 ? wrapped - n : wrapped;
  }

  function base(off, size, el) {
    if (!layout.classic) {
      const angle = off * Math.PI * 2 / RING_SLOTS;
      const sine = Math.sin(angle);
      const cosine = Math.cos(angle);
      const depth = (cosine + 1) / 2;
      const radiusX = ringRadius(size);
      const scale = off === 0 ? 1 : 0.16 + 0.42 * depth;
      const ry = -sine * 28;
      const x = sine * radiusX;
      const y = (cosine - 1) * size * 0.32;
      const z = (cosine - 1) * size * 0.45;
      // Наклоняем только обложку: подпись остаётся ровной и строго по её центру.
      el.style.setProperty('--satellite-tilt', `${(-sine * 3).toFixed(2)}deg`);
      el.style.setProperty('--satellite-scale', scale.toFixed(3));
      el.style.setProperty('--orbit-ry', `${ry.toFixed(2)}deg`);
      el.style.zIndex = String(100 + Math.round(depth * 100));
      return {
        t: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) scale(${scale.toFixed(3)})`,
        o: off === 0 ? 1 : Math.max(0.18, 0.28 + 0.72 * depth), ry: 0, labelScale: 1 / scale,
      };
    }
    const a = Math.min(4, Math.abs(off));
    const s = Math.sign(off);
    const ry = RY[a] * s;
    el.style.removeProperty('--satellite-tilt');
    el.style.removeProperty('--satellite-scale');
    el.style.removeProperty('--orbit-ry');
    el.style.removeProperty('z-index');
    return { t: `translateX(${(X[a] * s * size).toFixed(1)}px) translateZ(${Z[a]}px) rotateY(${ry}deg) scale(${SC[a]})`, o: OP[a], ry, labelScale: 1 };
  }

  // ---------- Наведение: двигается только содержимое, «рамка» карточки стоит на месте ----------
  function hoverPose(el) {
    const card = el._card || el.firstChild;
    const hovered = el.classList.contains('hover');
    if (!hovered && !el._hoverStyled) return;
    if (!hovered) {
      for (const p of ['--hry', '--hz', '--hs']) card.style.removeProperty(p);
      el._hoverStyled = false;
      return;
    }
    el._hoverStyled = true;
    if (el.classList.contains('side')) {
      const orbital = !layout.classic;
      // Спутник лишь слегка приближается: старое разворачивание ломало орбитальный силуэт.
      card.style.setProperty('--hry', orbital ? '0deg' : (-parseFloat(el.dataset.bry || 0) * 0.78).toFixed(1) + 'deg');
      card.style.setProperty('--hz', orbital ? '46px' : '90px');
      card.style.setProperty('--hs', orbital ? '1.12' : '1.06');
    } else {
      card.style.removeProperty('--hry');
      card.style.setProperty('--hz', '36px');
      card.style.setProperty('--hs', '1.025');
    }
  }

  function build(i, t) {
    const el = document.createElement('div');
    el.className = 'cf-item';
    el.dataset.qi = i;
    el.dataset.tid = t.id;
    el.innerHTML = `<div class="cf-card"><div class="cf-tilt"><div class="cf-art">
        <img src="${esc(cover(t, 600))}" alt="" draggable="false">
        <div class="cf-dim"></div><div class="cf-shine"></div>
        </div></div><div class="cf-label"><span class="tag"></span><span class="ttl">${esc(t.title)}</span><small>${esc(artistsText(t.artists))}</small><span class="go">${icon('play')}</span></div></div>`;
    el._card = el.firstChild;
    el._tag = el.querySelector('.tag');
    const tilt = el._card.firstChild;
    el._tilt = tilt;
    const card = el._card;
    let raf = 0;
    let last = null;
    const applyTilt = () => {
      raf = 0;
      if (!last || !el.classList.contains('hover')) return;
      const r = el.getBoundingClientRect();
      const current = el.classList.contains('cur');
      const px = Math.max(-0.5, Math.min(0.5, (last.clientX - r.left) / r.width - 0.5));
      const py = Math.max(-0.5, Math.min(0.5, (last.clientY - r.top) / r.height - 0.5));
      tilt.style.setProperty('--ry', (px * (current ? 10 : 16)).toFixed(2) + 'deg');
      tilt.style.setProperty('--rx', (-py * (current ? 8 : 12)).toFixed(2) + 'deg');
      tilt.style.setProperty('--sx', ((px + 0.5) * 100).toFixed(1) + '%');
      tilt.style.setProperty('--sy', ((py + 0.5) * 100).toFixed(1) + '%');
      tilt.style.setProperty('--px', (-px * (current ? 20 : 14)).toFixed(1) + 'px');
      tilt.style.setProperty('--py', (-py * (current ? 20 : 14)).toFixed(1) + 'px');
      if (current) {
        card.style.setProperty('--mx', (px * 8).toFixed(1) + 'px');
        card.style.setProperty('--my', (py * 6).toFixed(1) + 'px');
      }
    };
    el.addEventListener('pointerenter', () => {
      el.classList.add('hover');
      if (el.classList.contains('cur')) el.style.setProperty('--art-scale', '1.06');
      flow.classList.toggle('flow-hover', el.classList.contains('side'));
      hoverPose(el);
    });
    el.addEventListener('pointermove', (e) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(applyTilt);
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('hover');
      el.style.removeProperty('--art-scale');
      if (!flow.querySelector('.cf-item.hover')) flow.classList.remove('flow-hover');
      hoverPose(el);
      for (const p of ['--rx', '--ry', '--px', '--py']) tilt.style.removeProperty(p);
      for (const p of ['--mx', '--my']) card.style.removeProperty(p);
    });
    el.addEventListener('click', () => {
      const qi = +el.dataset.qi;
      if (qi === Player.index) Player.toggle();
      else Player.playAt(qi);
    });
    return el;
  }

  function place(el, offOverride, force = false) {
    const size = layout.size || el.offsetWidth || flow.clientHeight;
    const off = offOverride != null ? offOverride : ringOffset(+el.dataset.qi);
    const poseKey = `${off}|${size}|${layout.width}|${layout.classic ? 1 : 0}`;
    if (!force && el._poseKey === poseKey) return;
    el._poseKey = poseKey;
    const { t, o, ry, labelScale } = base(off, size, el);
    el.style.transform = t;
    el.style.opacity = o;
    el.style.setProperty('--label-scale', labelScale.toFixed(3));
    el.dataset.bry = ry;
    el.dataset.ringOff = off;
    el.classList.toggle('cur', off === 0);
    el.classList.toggle('side', off !== 0);
    el.classList.toggle('far', Math.abs(off) >= 2);
    const text = off === 0 ? '' : off > 0 ? (off === 1 ? 'Далее' : `Через ${off}`) : off === -1 ? 'Ранее' : `${-off} назад`;
    if (el._tag && el._tag.textContent !== text) el._tag.textContent = text;
    hoverPose(el);
  }

  function render() {
    if (root.classList.contains('hidden')) return;
    const q = Player.queue;
    const idx = Player.index;
    const classic = document.body.classList.contains('design-classic');
    layout.classic = classic;
    layout.width = flow.clientWidth;
    layout.size = items.values().next().value?.offsetWidth || 0;
    const range = classic ? RANGE : RING_RANGE;
    const wrap = !classic && q.length > 1 && (Player.endless || Player.repeat === 'all');
    const want = new Set();
    if (idx >= 0 && idx < q.length) {
      for (let off = -range; off <= range; off++) {
        let i = idx + off;
        if (wrap) i = ((i % q.length) + q.length) % q.length;
        if (i >= 0 && i < q.length && Math.abs(ringOffset(i)) <= range) want.add(i);
      }
    }
    for (const [i, el] of items) {
      if (!want.has(i) || !q[i] || el.dataset.tid !== String(q[i].id)) {
        items.delete(i);
        el.style.pointerEvents = 'none';
        const previous = +el.dataset.ringOff || ringOffset(i) || 1;
        place(el, classic ? (previous > 0 ? 4 : -4) : Math.sign(previous) * (RING_RANGE + 1));
        el.classList.add('recycling');
        el.style.opacity = 0;
        setTimeout(() => el.remove(), 800);
      }
    }
    const added = [];
    for (const i of want) {
      let el = items.get(i);
      if (!el) {
        el = build(i, q[i]);
        flow.appendChild(el);
        items.set(i, el);
        layout.size ||= el.offsetWidth;
        const off = ringOffset(i);
        if (classic) place(el, off >= 0 ? Math.min(4, off + 1) : Math.max(-4, off - 1));
        else {
          place(el, Math.abs(off) >= RING_RANGE - 1 ? Math.sign(off) * (RING_RANGE + 1) : off);
          if (Math.abs(off) >= RING_RANGE - 1) el.classList.add('materializing');
        }
        el.style.opacity = 0;
        added.push(el);
      } else place(el);
    }
    if (!classic && layout.size) flow.style.setProperty('--ring-width', `${(ringRadius(layout.size) * 2).toFixed(1)}px`);
    if (added.length) flow.getBoundingClientRect(); // один расчёт раскладки для всей новой группы
    for (const el of added) {
      place(el, undefined, true);
      setTimeout(() => el.classList.remove('materializing'), 800);
    }
    const count = document.getElementById('npQueueCount');
    const countText = q.length ? `∞ ${tracksWord(q.length)}` : '';
    if (count.textContent !== countText) count.textContent = countText;
    const countTitle = Player.endless ? 'Очередь подгружается автоматически' : 'Треков в текущей очереди';
    if (count.title !== countTitle) count.title = countTitle;
    const src = Player.source?.title;
    const sourceEl = document.getElementById('npSource');
    const sourceText = src ? `Сейчас играет · ${src}` : 'Сейчас играет';
    if (sourceEl.textContent !== sourceText) sourceEl.textContent = sourceText;
  }

  /** Центр и радиус текущей обложки (для кольца и ауры визуализатора). */
  function coverCenter(canvas) {
    const cur = flow.querySelector('.cf-item.cur .cf-tilt');
    const c = canvas.getBoundingClientRect();
    if (!cur) return { x: c.width / 2, y: c.height / 2, r: Math.min(c.width, c.height) * 0.18 };
    const e = cur.getBoundingClientRect();
    return { x: e.left + e.width / 2 - c.left, y: e.top + e.height / 2 - c.top, r: e.width / 2 };
  }

  // ---------- Мини-эквалайзер (всплывает над кнопкой «Эквалайзер») ----------
  const eqBox = document.getElementById('npEq');
  const eqBtn = document.getElementById('npEqBtn');
  let eqBuilt = false;
  function eqBuild() {
    const E = Views.eq;
    eqBox.innerHTML = `<div class="ne-head"><b>Эквалайзер</b><span class="ne-state"></span><button class="switch" data-ne="on" title="Включить / выключить"></button></div>
      <div class="ne-bands">${AudioFX.FREQS.map((f, i) => E.slider(i, AudioFX.LABELS[i])).join('')}</div>
      <div class="ne-presets" data-ne="presets"></div>
      <div class="ne-foot"><div class="ne-opt"><button class="switch" data-ne="comp"></button>Компрессор</div>
        <button class="chip" data-ne="reset" title="Все полосы на 0 дБ">${icon('refresh')}Сброс</button>
        <button class="chip" data-ne="full" title="Открыть полный эквалайзер">Подробнее${icon('chevronRight')}</button></div>`;
    E.bind(eqBox.querySelector('.ne-bands'), eqSync);
    const presets = eqBox.querySelector('.ne-presets');
    // Колесо и тачпад прокручивают и горизонтальный ряд, и сетку пресетов.
    presets.addEventListener('wheel', (e) => {
      e.preventDefault();
      const vertical = getComputedStyle(presets).overflowY !== 'hidden';
      if (vertical) presets.scrollTop += e.deltaY;
      else presets.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
    eqBox.addEventListener('click', (e) => {
      const p = e.target.closest('[data-eqp]');
      if (p) {
        AudioFX.setPreset(p.dataset.eqp);
        if (!AudioFX.eq.enabled) AudioFX.setEnabled(true);
        return;
      }
      const b = e.target.closest('[data-ne]');
      if (!b) return;
      const k = b.dataset.ne;
      if (k === 'on') AudioFX.setEnabled(!AudioFX.eq.enabled);
      else if (k === 'comp') {
        AudioFX.setCompressor(!AudioFX.eq.compressor);
        if (AudioFX.eq.compressor && !AudioFX.eq.enabled) AudioFX.setEnabled(true);
      } else if (k === 'reset') AudioFX.reset();
      else if (k === 'full') {
        NP.close();
        App.navigate('equalizer');
      }
    });
    eqBuilt = true;
  }
  let lastPreset = null;
  function eqSync() {
    if (!eqBuilt || eqBox.classList.contains('hidden')) return;
    const e = AudioFX.eq;
    eqBox.classList.toggle('off', !e.enabled);
    eqBox.querySelector('[data-ne="on"]').classList.toggle('on', e.enabled);
    eqBox.querySelector('[data-ne="comp"]').classList.toggle('on', e.compressor);
    eqBox.querySelector('.ne-state').textContent = e.enabled ? AudioFX.presetName() : 'выключен';
    Views.eq.paint(eqBox, '');
    // ряд пресетов перерисовываем только при смене пресета — иначе сбрасывается прокрутка
    if (lastPreset !== e.preset) {
      lastPreset = e.preset;
      const row = eqBox.querySelector('.ne-presets');
      const x = row.scrollLeft;
      row.innerHTML = Views.eq.presets();
      row.scrollLeft = x;
    }
  }
  window.addEventListener('zg:eq', eqSync);
  // клик мимо панели закрывает её
  document.addEventListener('pointerdown', (e) => {
    if (!eqBox.classList.contains('hidden') && !e.target.closest('.np-eq-wrap')) NP.closeEq();
  }, true);

  let openTimer = 0;
  let closeTimer = 0;
  const NP = {
    get eqOpen() {
      return !eqBox.classList.contains('hidden');
    },
    toggleEq() {
      if (this.eqOpen) return this.closeEq();
      if (!eqBuilt) eqBuild();
      lastPreset = null;
      eqBox.classList.remove('hidden');
      eqBtn.classList.add('on');
      eqSync();
      const row = eqBox.querySelector('.ne-presets');
      const on = row.querySelector('.chip.on');
      row.scrollLeft = on ? on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2 : 0;
    },
    closeEq() {
      eqBox.classList.add('hidden');
      eqBtn.classList.remove('on');
    },
    get isOpen() {
      return !root.classList.contains('hidden');
    },
    lyricsOn: localStorage.getItem('zg.npLyrics') === '1',
    vizOn: localStorage.getItem('zg.npViz') === '1',
    open() {
      clearTimeout(closeTimer);
      if (this.lyricsOn && this.vizOn) this.vizOn = false;
      root.classList.remove('hidden', 'closing');
      root.classList.toggle('lyrics-on', this.lyricsOn);
      root.classList.toggle('viz-on', this.vizOn);
      this._buttons();
      render();
      if (this.vizOn) this._mountScene();
      // после анимации появления прячем интерфейс под плеером, чтобы он не отрисовывался
      clearTimeout(openTimer);
      openTimer = setTimeout(() => this.isOpen && document.body.classList.add('np-open'), 520);
      if (window.ClipOffer) ClipOffer.npOpened(); // предложить клип и подстройку
    },
    close() {
      this.closeEq();
      if (window.ClipOffer) ClipOffer.hide();
      clearTimeout(openTimer);
      document.body.classList.remove('np-open');
      root.classList.add('closing');
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        // open() снимает closing и отменяет таймер; обычное закрытие обязано дойти до hidden.
        if (!root.classList.contains('closing')) return;
        root.classList.add('hidden');
        root.classList.remove('closing');
        this._unmountScene();
        for (const el of items.values()) el.remove();
        items.clear();
      }, 360);
    },
    toggleLyrics() {
      this.lyricsOn = !this.lyricsOn;
      if (this.lyricsOn && this.vizOn) this.toggleViz();
      localStorage.setItem('zg.npLyrics', this.lyricsOn ? '1' : '0');
      root.classList.toggle('lyrics-on', this.lyricsOn);
      this._buttons();
      this._relayout();
      return this.lyricsOn;
    },
    toggleViz() {
      this.vizOn = !this.vizOn;
      if (this.vizOn && this.lyricsOn) {
        this.lyricsOn = false;
        localStorage.setItem('zg.npLyrics', '0');
        root.classList.remove('lyrics-on');
      }
      localStorage.setItem('zg.npViz', this.vizOn ? '1' : '0');
      root.classList.toggle('viz-on', this.vizOn);
      this._buttons();
      this.vizOn ? this._mountScene() : this._unmountScene();
      this._relayout();
      return this.vizOn;
    },
    _buttons() {
      document.getElementById('npLyricsBtn').classList.toggle('on', this.lyricsOn);
      document.getElementById('npVizBtn').classList.toggle('on', this.vizOn);
    },
    _relayout() {
      // размер обложек меняется плавно — пересчитываем положение по ходу анимации
      render();
      setTimeout(render, 330);
      setTimeout(render, 650);
    },
    _mountScene() {
      if (scene) return;
      scene = VizScene.mount({ layer: document.getElementById('npScene'), host: root, kind: 'np', centerFn: coverCenter });
    },
    _unmountScene() {
      if (scene) scene.destroy();
      scene = null;
    },
    trackChanged(t) {
      if (scene) scene.setTrack(t);
    },
    render,
  };
  window.addEventListener('resize', debounce(render, 80));
  Player.on('modes', () => { if (NP.isOpen) render(); });
  window.NP = NP;
})();
