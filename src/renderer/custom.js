'use strict';
/* Кастомизация интерфейса: фон, цвета, стекло, форма, масштаб, шрифт */
(function () {
  const DEFAULTS = {
    accentMode: 'auto', // auto — из обложки, fixed — свой цвет
    accent: '#9d8cff',
    bgMode: 'cover', // cover | image | video | gradient
    gradient: 'aurora',
    bgBlur: 24,
    bgDim: 30,
    blobs: true,
    glass: 1,
    glassBlur: 30,
    radius: 28,
    scale: 1,
    font: 'segoe',
    compact: false,
    reduceMotion: false,
    miniViz: true,
    design: 'glass', // glass — «жидкое стекло», classic — обычный плоский дизайн
    seekStyle: 'line', // line | glow | wave | liquid
    seekColor: 'white', // white | accent | rainbow
    seekHeight: 5,
    seekThumb: 'hover', // hover | always | never
    seekBeat: false,
  };

  const GRADIENTS = {
    aurora: { name: 'Аврора', colors: ['#1fd1a5', '#6d4dff', '#0b6cff'] },
    sunset: { name: 'Закат', colors: ['#ff7e5f', '#ff3d77', '#7b2ff7'] },
    ocean: { name: 'Океан', colors: ['#00c6ff', '#0061ff', '#00e0c7'] },
    forest: { name: 'Лес', colors: ['#2ecc71', '#0f9b8e', '#c3e86a'] },
    neon: { name: 'Неон', colors: ['#ff00d4', '#00f0ff', '#7a00ff'] },
    peach: { name: 'Персик', colors: ['#ffb199', '#ff6a88', '#ffd36e'] },
    candy: { name: 'Конфета', colors: ['#f093fb', '#f5576c', '#4facfe'] },
    graphite: { name: 'Графит', colors: ['#6b7080', '#2b2f38', '#9aa0ad'] },
  };

  const SWATCHES = ['#9d8cff', '#ff7ab6', '#4fd1c5', '#5b9dff', '#ffb547', '#7ee08a', '#ff6b6b', '#e2e2e9'];

  const FONTS = {
    segoe: { name: 'Segoe UI', text: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif", display: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif" },
    bahn: { name: 'Bahnschrift', text: "'Bahnschrift', 'Segoe UI', sans-serif", display: "'Bahnschrift', 'Segoe UI', sans-serif" },
    trebuchet: { name: 'Trebuchet', text: "'Trebuchet MS', 'Segoe UI', sans-serif", display: "'Trebuchet MS', 'Segoe UI', sans-serif" },
    georgia: { name: 'Georgia', text: "'Segoe UI Variable Text', 'Segoe UI', sans-serif", display: "Georgia, 'Times New Roman', serif" },
  };

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
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
  const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

  /** Тема из одного выбранного цвета. */
  function themeFromColor(hex) {
    const [h, s0] = rgbToHsl(hexToRgb(hex));
    const s = Math.max(0.12, Math.min(0.95, s0));
    return { accent: hsl(h, s, 0.7), accent2: hsl(h + 38, s, 0.68), c1: hsl(h, s, 0.42), c2: hsl(h + 38, s, 0.4), c3: hsl(h - 50, s * 0.9, 0.36) };
  }

  const Custom = {
    DEFAULTS,
    GRADIENTS,
    SWATCHES,
    FONTS,
    s: { ...DEFAULTS },
    media: {},
    trackTheme: null,

    init(settings) {
      this.s = { ...DEFAULTS, ...(settings.custom || {}) };
      this.media = settings.mediaUrls || {};
      this.apply();
    },

    set(patch, save = true) {
      Object.assign(this.s, patch);
      this.apply();
      if (save) this._save();
    },
    _save: debounce(function () {
      window.zvuk.settings.set({ custom: Custom.s });
    }, 300),

    reset() {
      this.s = { ...DEFAULTS };
      this.apply();
      window.zvuk.settings.set({ custom: this.s });
    },

    _vars: {},
    apply() {
      const s = this.s;
      const root = document.documentElement.style;
      const b = document.body.classList;
      // Переменные на корне меняем только если значение другое: любое изменение там
      // заставляет пересчитать стили всей страницы (это и тормозило сворачивание панели)
      const r = {
        setProperty: (k, v) => {
          v = String(v);
          if (this._vars[k] === v) return;
          this._vars[k] = v;
          root.setProperty(k, v);
        },
        removeProperty: (k) => {
          if (!(k in this._vars)) return;
          delete this._vars[k];
          root.removeProperty(k);
        },
      };
      r.setProperty('--radius', s.radius + 'px');
      r.setProperty('--glass-k', s.glass);
      r.setProperty('--glass-blur', s.glassBlur + 'px');
      r.setProperty('--wall-blur', s.bgBlur + 'px');
      r.setProperty('--bg-dim', (s.bgDim / 100).toFixed(2));
      const f = FONTS[s.font] || FONTS.segoe;
      r.setProperty('--font', f.text);
      r.setProperty('--font-display', f.display);
      for (const m of ['cover', 'image', 'video', 'gradient']) b.toggle('bg-mode-' + m, s.bgMode === m);
      b.toggle('no-blobs', !s.blobs);
      b.toggle('compact-sidebar', s.compact);
      b.toggle('reduce-motion', s.reduceMotion);
      b.toggle('mini-viz-on', s.miniViz);
      b.toggle('design-classic', s.design === 'classic');
      // настоящее размытие под панелями нужно только поверх своих обоев с деталями
      b.toggle('bd-on', s.design !== 'classic' && (s.bgMode === 'image' || s.bgMode === 'video'));
      b.toggle('seek-beat', Boolean(s.seekBeat));
      r.setProperty('--seek-h', s.seekHeight + 'px');
      const seekKey = this.seekClasses();
      if (this._seekKey !== seekKey) {
        this._seekKey = seekKey;
        this.styleSeek(document.querySelectorAll('.slider.seek:not(.demo)'));
      }
      // Цвета пятен фона: из темы или из выбранного градиента
      if (s.bgMode === 'gradient') {
        const g = (GRADIENTS[s.gradient] || GRADIENTS.aurora).colors;
        r.setProperty('--b1', g[0]);
        r.setProperty('--b2', g[1]);
        r.setProperty('--b3', g[2]);
      } else {
        r.removeProperty('--b1');
        r.removeProperty('--b2');
        r.removeProperty('--b3');
      }
      // Свои обои
      const wall = document.getElementById('bgWall');
      const vid = document.getElementById('bgVideo');
      const wallBg = s.bgMode === 'image' && this.media.wallImage ? `url("${this.media.wallImage}")` : 'none';
      if (wall && this._wallBg !== wallBg) {
        this._wallBg = wallBg;
        wall.style.backgroundImage = wallBg;
      }
      if (vid) {
        const want = s.bgMode === 'video' && this.media.wallVideo ? this.media.wallVideo : '';
        if (want && vid.getAttribute('src') !== want) {
          vid.src = want;
          vid.play().catch(() => {});
        } else if (!want && vid.getAttribute('src')) {
          vid.removeAttribute('src');
          vid.load();
        }
      }
      this.refreshTheme();
      // масштаб и раскладка меняются редко — не трогаем их без необходимости
      const layoutKey = `${s.scale}|${s.compact}|${s.radius}|${s.font}|${s.design}`;
      if (this._layoutKey !== layoutKey) {
        if (this._zoom !== s.scale) window.zvuk.setZoom(s.scale);
        this._zoom = s.scale;
        this._layoutKey = layoutKey;
        clearTimeout(this._rt);
        this._rt = setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
      }
    },

    /** Классы оформления полосы времени (стиль, цвет, ползунок). */
    seekClasses(st = this.s.seekStyle, col = this.s.seekColor, th = this.s.seekThumb) {
      return `st-${st} sc-${col} th-${th}`;
    },
    styleSeek(list, st, col, th) {
      for (const el of list) {
        el.className = el.className.replace(/\b(st|sc|th)-\w+\b/g, '').replace(/\s+/g, ' ').trim() + ' ' + this.seekClasses(st, col, th);
      }
    },

    /** Тема трека проходит через настройки: при «своём цвете» она заменяется. */
    setTrackTheme(t) {
      this.trackTheme = t;
      this.refreshTheme();
    },
    refreshTheme() {
      const t = this.s.accentMode === 'fixed' ? themeFromColor(this.s.accent) : this.trackTheme;
      const key = JSON.stringify(t);
      if (key === this._themeKey) return; // та же тема — не трогаем стили страницы
      this._themeKey = key;
      applyTheme(t);
    },

    async pickMedia(key, kind) {
      try {
        const url = await window.zvuk.media.pick(key, kind);
        if (url) this.media[key] = url;
        return url;
      } catch (e) {
        toast('Не удалось открыть файл: ' + e.message, { error: true });
        return null;
      }
    },
    async clearMedia(key) {
      await window.zvuk.media.clear(key);
      this.media[key] = null;
    },
  };

  window.Custom = Custom;
})();
