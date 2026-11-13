'use strict';
/* Общие утилиты интерфейса */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** URL картинки Zvuk нужного размера. */
  function img(src, size = 300) {
    if (!src) return '';
    let s = typeof src === 'object' ? src.src : src;
    if (!s) return '';
    if (s.startsWith('/')) s = 'https://zvuk.com' + s;
    // Сервер картинок принимает только subtype=cover|cover_background
    s = s.replace('subtype=secondImage', 'subtype=cover');
    if (s.includes('{size}')) return s.replace('{size}', `${size}x${size}`);
    return s;
  }
  /** Обложка сущности (трек, релиз, плейлист, исполнитель). */
  function cover(item, size = 300) {
    if (!item) return '';
    if (item.coverV1?.src) return img(item.coverV1.src, size);
    if (item.release?.image?.src) return img(item.release.image.src, size);
    if (item.image?.src) return img(item.image.src, size);
    return '';
  }
  /** Обложка плейлиста: своя, мозаика 2×2 из альбомов треков или одна обложка трека. */
  function playlistArt(p, size = 300) {
    if (!p) return '';
    if (p.coverV1?.src) return `<img loading="lazy" decoding="async" src="${esc(img(p.coverV1.src, size))}" alt="">`;
    const m = p.mosaic || [];
    if (m.length >= 4)
      return `<div class="mosaic">${m.slice(0, 4).map((s) => `<img loading="lazy" decoding="async" src="${esc(img(s, Math.round(size / 2)))}" alt="">`).join('')}</div>`;
    if (m.length) return `<img loading="lazy" decoding="async" src="${esc(img(m[0], size))}" alt="">`;
    if (p.image?.src && !p.image.src.startsWith('/')) return `<img loading="lazy" decoding="async" src="${esc(img(p.image.src, size))}" alt="">`;
    return '';
  }

  function palette(item) {
    const p = item?.release?.image?.palette || item?.image?.palette;
    if (!p) return null;
    return p.split(',').map((x) => x.trim()).filter((x) => /^#[0-9a-f]{6}$/i.test(x));
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtTotal(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  const tracksWord = (n) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;
  const year = (d) => (d ? String(d).slice(0, 4) : '');
  const RELEASE_TYPES = { album: 'Альбом', single: 'Сингл', ep: 'EP', compilation: 'Сборник' };
  const releaseType = (t) => RELEASE_TYPES[t] || 'Альбом';
  const artistsText = (arr) => (arr || []).map((a) => a.title).join(', ');
  const artistsLinks = (arr) =>
    (arr || []).map((a) => `<span class="lnk" data-act="nav" data-view="artist" data-id="${esc(a.id)}">${esc(a.title)}</span>`).join(', ');

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }
  function shuffleArr(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }

  // ---------- Цвета ----------
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

  /** Из палитры обложки делает цвета темы: акценты и пятна фона. */
  function themeFromPalette(colors) {
    if (!colors || !colors.length) return null;
    const hs = colors.map(hexToHsl);
    // Самый «живой» цвет — тот, у кого насыщенность выше и светлота не крайняя.
    const score = ([, s, l]) => s * (1 - Math.abs(l - 0.5) * 1.4);
    const sorted = hs.slice().sort((a, b) => score(b) - score(a));
    const main = sorted[0];
    // Почти бесцветная обложка — оставляем фирменные цвета, иначе интерфейс станет серым
    if (main[1] < 0.18 || score(main) < 0.08) return null;
    const second = sorted[1] || [(main[0] + 40) % 360, main[1], main[2]];
    const third = sorted[2] || [(main[0] + 300) % 360, main[1], main[2]];
    const vivid = (c, l) => {
      const s = c[1] < 0.12 ? 0.08 : Math.min(0.95, Math.max(0.55, c[1] * 1.25));
      return hsl(c[0], s, l);
    };
    const secondHue = Math.abs(second[0] - main[0]) < 18 && second[1] > 0.12 ? (main[0] + 35) % 360 : second[0];
    return {
      accent: vivid(main, 0.68),
      accent2: vivid([secondHue, Math.max(second[1], main[1] * 0.8), 0], 0.66),
      c1: vivid(main, 0.42),
      c2: vivid(second, 0.4),
      c3: vivid(third, 0.36),
    };
  }
  const DEFAULT_THEME = { accent: '#9d8cff', accent2: '#ff7ab6', c1: '#6d4dff', c2: '#ff4f9a', c3: '#20c9c0' };
  function applyTheme(t) {
    t = t || DEFAULT_THEME;
    const r = document.documentElement.style;
    r.setProperty('--accent', t.accent);
    r.setProperty('--accent-2', t.accent2);
    r.setProperty('--c1', t.c1);
    r.setProperty('--c2', t.c2);
    r.setProperty('--c3', t.c3);
  }

  // ---------- API с кэшем ----------
  const cache = new Map();
  const CACHE_TTL = 5 * 60 * 1000;
  const CACHEABLE = new Set(['getRelease', 'getArtist', 'getPlaylist', 'search', 'getWaves', 'getLyrics', 'recommendations', 'synthesisPlaylists']);
  async function api(method, ...args) {
    const key = CACHEABLE.has(method) ? method + ':' + JSON.stringify(args) : null;
    if (key) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < CACHE_TTL) return hit.p;
    }
    const p = window.zvuk.call(method, ...args);
    if (key) {
      cache.set(key, { t: Date.now(), p });
      p.catch(() => cache.delete(key));
    }
    return p;
  }
  api.invalidate = (prefix) => {
    for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  };

  // ---------- Уведомления ----------
  function toast(msg, { error = false, iconName = null, ms = 3200 } = {}) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast glass-menu' + (error ? ' err' : '');
    el.innerHTML = (iconName ? icon(iconName) : '') + `<span>${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  // ---------- Контекстное меню ----------
  let menuEl = null;
  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
  /**
   * items: [{ label, icon, onClick, danger, sub: [...], sep: true, header: html }]
   */
  function openMenu(x, y, items) {
    closeMenu();
    const layer = $('#menuLayer');
    const build = (list) => {
      const m = document.createElement('div');
      m.className = 'ctx glass-menu';
      for (const it of list) {
        if (it.sep) {
          m.insertAdjacentHTML('beforeend', '<div class="sep"></div>');
          continue;
        }
        if (it.header) {
          m.insertAdjacentHTML('beforeend', `<div class="mh">${it.header}</div><div class="sep"></div>`);
          continue;
        }
        const b = document.createElement('button');
        b.className = 'mi' + (it.danger ? ' danger' : '');
        b.innerHTML = (it.icon ? icon(it.icon) : '<span class="i"></span>') + `<span>${esc(it.label)}</span>` + (it.sub ? icon('chevronRight', 'arrow') : '');
        if (it.sub) {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const old = m.querySelector('.ctx');
            m.querySelectorAll('.mi.open').forEach((x) => x.classList.remove('open'));
            if (old) old.remove();
            const sub = build(typeof it.sub === 'function' ? it.sub() : it.sub);
            sub.classList.add('sub');
            b.classList.add('open');
            document.body.appendChild(sub);
            const r = b.getBoundingClientRect();
            place(sub, r.right + 4, r.top - 6, r.left - 4);
            sub.dataset.parent = '1';
            menuEl.subEl && menuEl.subEl.remove();
            menuEl.subEl = sub;
          });
        } else {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            it.onClick && it.onClick();
          });
        }
        m.appendChild(b);
      }
      return m;
    };
    const place = (m, px, py, altX) => {
      const w = m.offsetWidth, h = m.offsetHeight;
      let left = px, top = py;
      if (left + w > innerWidth - 8) left = altX != null ? altX - w : innerWidth - w - 8;
      if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
      m.style.left = Math.max(8, left) + 'px';
      m.style.top = Math.max(8, top) + 'px';
    };
    const m = build(items);
    layer.appendChild(m);
    place(m, x, y);
    menuEl = m;
    const origRemove = m.remove.bind(m);
    m.remove = () => {
      if (m.subEl) m.subEl.remove();
      origRemove();
    };
  }
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !e.target.closest('.ctx')) closeMenu();
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  // ---------- Модальные окна ----------
  function modal({ title, text = '', input = null, okText = 'Готово', danger = false, cancelText = 'Отмена' }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `<form class="modal glass panel">
        <h3>${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ''}
        ${input !== null ? `<input class="input" maxlength="120" value="${esc(input)}" />` : ''}
        <div class="btns"><button type="button" class="btn" data-x>${esc(cancelText)}</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(okText)}</button></div>
      </form>`;
      $('#modalLayer').appendChild(back);
      const form = back.querySelector('form');
      const inp = back.querySelector('input');
      const done = (v) => {
        back.remove();
        resolve(v);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (inp && !inp.value.trim()) return inp.focus();
        done(inp ? inp.value.trim() : true);
      });
      back.querySelector('[data-x]').addEventListener('click', () => done(null));
      back.addEventListener('mousedown', (e) => e.target === back && done(null));
      back.addEventListener('keydown', (e) => e.key === 'Escape' && done(null));
      setTimeout(() => (inp ? (inp.focus(), inp.select()) : form.querySelector('[type=submit]').focus()), 30);
    });
  }

  // ---------- Слайдер ----------
  function slider(el, { onInput, onCommit }) {
    let dragging = false;
    const valueAt = (e) => {
      const r = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      el.classList.add('drag');
      el.setPointerCapture(e.pointerId);
      onInput && onInput(valueAt(e));
    });
    el.addEventListener('pointermove', (e) => dragging && onInput && onInput(valueAt(e)));
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('drag');
      onCommit && onCommit(valueAt(e));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return {
      set(v, buf) {
        if (dragging) return;
        el.querySelector('.fill').style.width = v * 100 + '%';
        el.querySelector('.thumb').style.left = v * 100 + '%';
        if (buf != null && el.querySelector('.buf')) el.querySelector('.buf').style.width = buf * 100 + '%';
      },
      setForce(v) {
        el.querySelector('.fill').style.width = v * 100 + '%';
        el.querySelector('.thumb').style.left = v * 100 + '%';
      },
      get dragging() {
        return dragging;
      },
    };
  }

  // ---------- Блик за курсором на стеклянных панелях ----------
  let raf = 0, lastEv = null;
  document.addEventListener('pointermove', (e) => {
    lastEv = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const el = lastEv.target.closest && lastEv.target.closest('.glass');
      // большие панели блик не используют — не трогаем их стили на каждое движение мыши
      if (!el || el.classList.contains('panel')) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', lastEv.clientX - r.left + 'px');
      el.style.setProperty('--my', lastEv.clientY - r.top + 'px');
    });
  });

  // ---------- Синхронизированный текст (LRC) ----------
  function parseLyrics(l) {
    if (!l || !l.text) return null;
    const lines = [];
    const re = /^\s*\[(\d+):(\d+(?:[.,]\d+)?)\]\s*(.*)$/;
    for (const raw of l.text.split(/\r?\n/)) {
      const m = raw.match(re);
      if (m) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(',', '.')), text: m[3] });
    }
    if (lines.length > 3) return { synced: true, lines: lines.filter((x, i) => x.text || (lines[i + 1] && lines[i + 1].t - x.t > 4)).sort((a, b) => a.t - b.t) };
    return { synced: false, text: l.text.replace(/^\s*\[[^\]]*\]\s*/gm, '') };
  }

  Object.assign(window, {
    $, $$, esc, img, cover, playlistArt, palette, fmtTime, fmtTotal, plural, tracksWord, year, releaseType, artistsText, artistsLinks,
    debounce, shuffleArr, themeFromPalette, applyTheme, api, toast, openMenu, closeMenu, modal, slider, parseLyrics,
  });
})();
