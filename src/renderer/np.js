'use strict';
/* Полноэкранный плеер: 3D-карусель очереди, наклон карточек за курсором, режимы текста и визуализатора */
(function () {
  const root = document.getElementById('nowPlaying');
  const flow = document.getElementById('npFlow');
  const items = new Map(); // индекс в очереди → элемент
  const RANGE = 3;
  // Положение карточек по удалённости от центра (доли размера обложки)
  const X = [0, 0.98, 1.66, 2.2, 2.6];
  const SC = [1, 0.7, 0.54, 0.44, 0.38];
  const RY = [0, 40, 50, 56, 60];
  const Z = [0, -140, -260, -360, -420];
  const OP = [1, 1, 0.75, 0.35, 0];

  let scene = null;

  function base(off, size) {
    const a = Math.min(4, Math.abs(off));
    const s = Math.sign(off);
    const ry = RY[a] * s;
    return { t: `translateX(${(X[a] * s * size).toFixed(1)}px) translateZ(${Z[a]}px) rotateY(${ry}deg) scale(${SC[a]})`, o: OP[a], ry };
  }

  // ---------- Наведение: двигается только содержимое, «рамка» карточки стоит на месте ----------
  function hoverPose(el) {
    const card = el.firstChild;
    if (!el.classList.contains('hover')) {
      for (const p of ['--hry', '--hz', '--hs']) card.style.removeProperty(p);
      return;
    }
    if (el.classList.contains('side')) {
      // разворачиваем к зрителю и выдвигаем вперёд
      card.style.setProperty('--hry', (-parseFloat(el.dataset.bry || 0) * 0.78).toFixed(1) + 'deg');
      card.style.setProperty('--hz', '90px');
      card.style.setProperty('--hs', '1.06');
    } else {
      card.style.removeProperty('--hry');
      card.style.setProperty('--hz', '20px');
      card.style.setProperty('--hs', '1.02');
    }
  }

  function build(i, t) {
    const el = document.createElement('div');
    el.className = 'cf-item';
    el.dataset.qi = i;
    el.dataset.tid = t.id;
    el.innerHTML = `<div class="cf-card"><div class="cf-tilt">
        <img src="${esc(cover(t, 600))}" alt="" draggable="false">
        <div class="cf-dim"></div><div class="cf-shine"></div>
        <div class="cf-label"><span class="tag"></span><span class="ttl">${esc(t.title)}</span><small>${esc(artistsText(t.artists))}</small><span class="go">${icon('play')}</span></div>
        <div class="cf-play"><span class="pp-play">${icon('play')}</span><span class="pp-pause">${icon('pause')}</span></div>
      </div></div>`;
    const tilt = el.firstChild.firstChild;
    let raf = 0;
    let last = null;
    const applyTilt = () => {
      raf = 0;
      if (!last || !el.classList.contains('hover')) return;
      const r = el.getBoundingClientRect();
      const px = Math.max(-0.5, Math.min(0.5, (last.clientX - r.left) / r.width - 0.5));
      const py = Math.max(-0.5, Math.min(0.5, (last.clientY - r.top) / r.height - 0.5));
      tilt.style.setProperty('--ry', (px * 16).toFixed(2) + 'deg');
      tilt.style.setProperty('--rx', (-py * 12).toFixed(2) + 'deg');
      tilt.style.setProperty('--sx', ((px + 0.5) * 100).toFixed(1) + '%');
      tilt.style.setProperty('--sy', ((py + 0.5) * 100).toFixed(1) + '%');
      tilt.style.setProperty('--px', (-px * 14).toFixed(1) + 'px');
      tilt.style.setProperty('--py', (-py * 14).toFixed(1) + 'px');
    };
    el.addEventListener('pointerenter', () => {
      el.classList.add('hover');
      flow.classList.toggle('flow-hover', el.classList.contains('side'));
      hoverPose(el);
    });
    el.addEventListener('pointermove', (e) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(applyTilt);
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('hover');
      if (!flow.querySelector('.cf-item.hover')) flow.classList.remove('flow-hover');
      hoverPose(el);
      for (const p of ['--rx', '--ry', '--px', '--py']) tilt.style.removeProperty(p);
    });
    el.addEventListener('click', () => {
      const qi = +el.dataset.qi;
      if (qi === Player.index) Player.toggle();
      else Player.playAt(qi);
    });
    return el;
  }

  function place(el, offOverride) {
    const size = el.offsetWidth || flow.clientHeight;
    const off = offOverride != null ? offOverride : +el.dataset.qi - Player.index;
    const { t, o, ry } = base(off, size);
    el.style.transform = t;
    el.style.opacity = o;
    el.dataset.bry = ry;
    el.classList.toggle('cur', off === 0);
    el.classList.toggle('side', off !== 0);
    el.classList.toggle('far', Math.abs(off) >= 2);
    const tag = el.querySelector('.tag');
    if (tag) tag.textContent = off === 0 ? '' : off > 0 ? (off === 1 ? 'Далее' : `Через ${off}`) : off === -1 ? 'Ранее' : `${-off} назад`;
    hoverPose(el);
  }

  function render() {
    if (root.classList.contains('hidden')) return;
    const q = Player.queue;
    const idx = Player.index;
    const want = new Set();
    for (let i = Math.max(0, idx - RANGE); i <= Math.min(q.length - 1, idx + RANGE); i++) want.add(i);
    for (const [i, el] of items) {
      if (!want.has(i) || !q[i] || el.dataset.tid !== String(q[i].id)) {
        items.delete(i);
        el.style.pointerEvents = 'none';
        place(el, i - idx > 0 ? 4 : -4);
        el.style.opacity = 0;
        setTimeout(() => el.remove(), 800);
      }
    }
    for (const i of want) {
      let el = items.get(i);
      if (!el) {
        el = build(i, q[i]);
        flow.appendChild(el);
        items.set(i, el);
        const off = i - idx;
        place(el, off >= 0 ? Math.min(4, off + 1) : Math.max(-4, off - 1));
        el.style.opacity = 0;
        el.getBoundingClientRect(); // начальное положение для анимации появления
      }
      place(el);
    }
    const src = Player.source?.title;
    document.getElementById('npSource').textContent = src ? `Сейчас играет · ${src}` : 'Сейчас играет';
  }

  /** Центр и радиус текущей обложки (для кольца и ауры визуализатора). */
  function coverCenter(canvas) {
    const cur = flow.querySelector('.cf-item.cur .cf-tilt');
    const c = canvas.getBoundingClientRect();
    if (!cur) return { x: c.width / 2, y: c.height / 2, r: Math.min(c.width, c.height) * 0.18 };
    const e = cur.getBoundingClientRect();
    return { x: e.left + e.width / 2 - c.left, y: e.top + e.height / 2 - c.top, r: e.width / 2 };
  }

  let openTimer = 0;
  const NP = {
    get isOpen() {
      return !root.classList.contains('hidden');
    },
    lyricsOn: localStorage.getItem('zg.npLyrics') === '1',
    vizOn: localStorage.getItem('zg.npViz') === '1',
    open() {
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
    },
    close() {
      clearTimeout(openTimer);
      document.body.classList.remove('np-open');
      root.classList.add('closing');
      setTimeout(() => {
        root.classList.add('hidden');
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
  window.NP = NP;
})();
