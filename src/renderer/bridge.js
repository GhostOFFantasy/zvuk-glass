'use strict';
/*
 * Мост интерфейса к Rust-части приложения (Tauri). Даёт тот же объект window.zvuk,
 * что был в Electron-версии, поэтому остальной код интерфейса не меняется.
 * Здесь же — свои кнопки окна и перетаскивание за заголовок.
 */
(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  const toError = (e) => {
    const err = new Error((e && e.message) || String(e));
    err.code = (e && e.code) || 'ERROR';
    return err;
  };
  // Вызов, который не бросает исключение, а возвращает { ok, data | error } — как ipc в Electron-версии
  const wrapped = (cmd, args) =>
    invoke(cmd, args).then(
      (data) => ({ ok: true, data }),
      (e) => ({ ok: false, error: { code: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) } })
    );

  async function call(method, ...args) {
    try {
      return await invoke('zvuk_call', { method, args });
    } catch (e) {
      throw toError(e);
    }
  }

  window.zvuk = {
    call,
    auth: {
      state: () => invoke('auth_state'),
      withToken: (token) => wrapped('auth_token', { token: String(token || '') }),
      logout: () => invoke('auth_logout'),
    },
    settings: {
      get: () => invoke('settings_get'),
      set: (patch) => invoke('settings_set', { patch }),
    },
    player: {
      state: (st) => invoke('player_state', { st }).catch(() => {}),
      onCommand: (fn) => listen('media:command', (e) => fn(e.payload)),
      thumbarIcons: (icons) => invoke('thumbar_icons', { icons }).catch(() => {}),
      appIcon: () => {}, // значок приложения теперь встроен при сборке
    },
    clipboard: (text) => invoke('clipboard_write', { text: String(text || '') }),
    readClipboard: () => invoke('clipboard_read'),
    media: {
      pick: async (key, kind) => {
        try {
          return await invoke('media_pick', { key, kind });
        } catch (e) {
          throw toError(e);
        }
      },
      clear: (key) => invoke('media_clear', { key }),
    },
    yt: {
      state: () => invoke('yt_state'),
      setKey: (k) => wrapped('yt_set_key', { key: String(k || '') }),
      clearKey: () => invoke('yt_clear_key'),
      find: (track, force) => wrapped('yt_find', { track, force: Boolean(force) }),
      update: (trackId, patch) => wrapped('yt_update', { trackId, patch: patch || {} }),
      clearCache: () => invoke('yt_clear_cache'),
      parse: (text) => invoke('yt_parse', { text: String(text || '') }),
    },
    // автосинхронизация клипа по звуку
    sync: {
      prepare: (trackId) => invoke('sync_prepare', { trackId: String(trackId) }),
      measure: (trackId, seconds, lo, hi) => invoke('sync_measure', { trackId: String(trackId), seconds, lo, hi }),
    },
    update: {
      state: () => invoke('update_state'),
      check: () => invoke('update_check'),
      install: () => invoke('update_install'),
      onStatus: (fn) => listen('update:status', (e) => fn(e.payload)),
    },
    setZoom: (f) => invoke('set_zoom', { factor: Number(f) || 1 }),
    openZvuk: (url) => invoke('shell_open', { url: String(url || '') }),
    screenshotReady: (delay) => invoke('screenshot_ready', { delay: typeof delay === 'number' ? Math.max(0, Math.round(delay)) : null }),
    // служебные проверки (работают только в режиме снимков)
    debug: {
      log: (msg) => invoke('debug_log', { msg: String(msg) }).catch(() => {}),
      mouse: (x, y, kind) => invoke('debug_mouse', { x, y, kind: kind || null }).catch(() => {}),
    },
  };

  // В режиме снимков предупреждения и ошибки интерфейса уходят в вывод приложения
  if (window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot) {
    for (const k of ['warn', 'error']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => {
        orig(...a);
        window.zvuk.debug.log(`[${k}] ` + a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
      };
    }
    window.addEventListener('error', (e) => window.zvuk.debug.log('[error] ' + e.message));
    window.addEventListener('unhandledrejection', (e) => window.zvuk.debug.log('[reject] ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
  }

  // ---------- Окно без системной рамки: свои кнопки и перетаскивание ----------
  const win = (action) => invoke('win_action', { action });

  // Области, помеченные в CSS как -webkit-app-region: drag, перетаскивают окно (как было в Electron)
  function dragRegion(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      if (el.closest && el.matches('button, a, input, textarea, select, label, [contenteditable], .no-drag')) return false;
      const cs = getComputedStyle(el);
      const v = cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || cs.webkitAppRegion || cs.appRegion;
      if (v === 'drag') return true;
      if (v === 'no-drag') return false;
    }
    return false;
  }
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || !dragRegion(e.target)) return;
      e.preventDefault();
      if (e.detail === 2) win('toggleMaximize').then(setMax);
      else win('drag');
    },
    true
  );

  const ICONS = {
    min: '<svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>',
    max: '<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1.2" /></svg>',
    restore: '<svg viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1.1" /><path d="M2.5 2.5V1.6c0-.6.5-1.1 1.1-1.1h4.8c.6 0 1.1.5 1.1 1.1v4.8c0 .6-.5 1.1-1.1 1.1h-.9" /></svg>',
    close: '<svg viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>',
  };
  let maxBtn = null;
  function setMax(m) {
    if (!maxBtn) return;
    maxBtn.innerHTML = m ? ICONS.restore : ICONS.max;
    maxBtn.title = m ? 'Свернуть в окно' : 'Развернуть';
    document.body.classList.toggle('win-max', Boolean(m));
  }
  function mountControls() {
    const box = document.createElement('div');
    box.className = 'win-ctrls';
    box.innerHTML = `<button class="wc-min" title="Свернуть" data-wc="minimize">${ICONS.min}</button><button class="wc-max" title="Развернуть" data-wc="toggleMaximize">${ICONS.max}</button><button class="wc-close" title="Закрыть" data-wc="close">${ICONS.close}</button>`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wc]');
      if (b) win(b.dataset.wc).then(setMax);
    });
    document.body.appendChild(box);
    maxBtn = box.querySelector('.wc-max');
    const sync = () => invoke('win_state').then((s) => setMax(s.maximized)).catch(() => {});
    let t = null;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(sync, 80);
    });
    sync();
  }
  if (document.body) mountControls();
  else document.addEventListener('DOMContentLoaded', mountControls);
})();
