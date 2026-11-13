'use strict';
/* Официальный клип трека с YouTube на фоне визуализатора: поиск, встроенный плеер без звука, синхронизация с треком */
(function () {
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const mounts = new Set(); // { box, iframe, videoId, ready, state, time, timeAt, lastSeek, ro }
  const listeners = new Set();
  // Качество клипа: высота кадра → код YouTube
  const QUALITY = { 480: 'large', 720: 'hd720', 1080: 'hd1080', 1440: 'hd1440', 2160: 'hd2160' };
  // Высота плеера для каждого качества (подобрано проверкой): для низких YouTube «округляет вверх»
  // (плеер 480 px уже даёт 720p), поэтому плеер чуть меньше; для высоких — ровно по качеству
  const FRAME = { 480: 420, 720: 600, 1080: 1080, 1440: 1440, 2160: 2160 };
  const QNAME = { tiny: '144p', small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '4K', highres: '8K' };
  const QLIST = [
    ['auto', 'Авто'],
    ['480', '480p'],
    ['720', '720p'],
    ['1080', '1080p'],
    ['1440', '1440p'],
    ['2160', '4K'],
  ];

  /**
   * YouTube сам выбирает качество по размеру плеера на экране, а команду «поставь качество» давно игнорирует.
   * Поэтому для выбранного качества делаем плеер ровно такого размера (в физических пикселях)
   * и масштабируем его до размера фона. «Авто» — плеер размером с фон.
   */
  function fit(m) {
    const f = m.iframe;
    if (!f) return;
    const q = Clip.quality;
    if (q === 'auto') {
      f.style.width = f.style.height = f.style.transform = '';
      return;
    }
    const bw = m.box.clientWidth;
    const bh = m.box.clientHeight;
    if (!bw || !bh) return;
    const dpr = window.devicePixelRatio || 1;
    const h = (FRAME[q] || +q) / dpr;
    const w = (h * 16) / 9;
    const k = Math.max(bw / w, bh / h) * 1.24;
    f.style.width = w.toFixed(1) + 'px';
    f.style.height = h.toFixed(1) + 'px';
    f.style.transform = `translate(-50%, -50%) scale(${k.toFixed(4)})`;
  }

  const Clip = {
    trackId: null,
    entry: null, // кэш из главного процесса: { cands, pick, manual, offset }
    status: 'idle', // idle | loading | ok | none | nokey | error
    message: '',
    _seq: 0,

    get videoId() {
      const e = this.entry;
      if (!e) return null;
      if (e.manual) return e.manual;
      return e.pick != null && e.cands && e.cands[e.pick] ? e.cands[e.pick].id : null;
    },
    get info() {
      const e = this.entry;
      if (!e) return null;
      if (e.manual) return { id: e.manual, title: 'Ваша ссылка', channel: 'YouTube' };
      return e.pick != null && e.cands ? e.cands[e.pick] : null;
    },
    get offset() {
      return (this.entry && this.entry.offset) || 0;
    },
    QLIST,
    /** Выбранное качество: 'auto' или высота кадра ('720', '1080', …). */
    get quality() {
      const q = App.settings.viz && App.settings.viz.clipQ;
      return q && (q === 'auto' || QUALITY[q]) ? String(q) : 'auto';
    },
    /** Качество, которое YouTube сейчас реально показывает (например «1080p»). */
    actualQuality: '',
    setQuality(q) {
      if (!App.settings.viz) App.settings.viz = {};
      App.settings.viz.clipQ = q;
      window.zvuk.settings.set({ viz: App.settings.viz });
      this.actualQuality = '';
      // новое качество применяется перезапуском плеера с того же места
      for (const m of mounts) m.videoId = null;
      this._applyVideo();
      this._emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    _emit() {
      for (const fn of listeners) fn(this);
    },

    /** Найти клип для текущего трека (только когда клип реально показывается). */
    async resolve(force = false) {
      const t = Player.current;
      if (!t) return;
      const seq = ++this._seq;
      if (this.trackId !== String(t.id)) {
        this.trackId = String(t.id);
        this.entry = null;
        this._applyVideo(); // клип прошлого трека сразу убираем
      }
      this.status = 'loading';
      this.message = '';
      this._emit();
      const r = await window.zvuk.yt.find({ id: String(t.id), title: t.title, artists: (t.artists || []).map((a) => a.title), duration: t.duration }, force);
      if (seq !== this._seq) return;
      if (!r.ok) {
        this.status = 'error';
        this.message = r.error.message;
      } else {
        this.entry = r.data;
        if (this.videoId) this.status = 'ok';
        else if (r.data.error === 'NO_KEY') this.status = 'nokey';
        else this.status = 'none';
      }
      this._emit();
      this._applyVideo();
    },

    async _update(patch) {
      if (!this.trackId) return;
      const r = await window.zvuk.yt.update(this.trackId, patch);
      if (r.ok) this.entry = r.data;
      this.status = this.videoId ? 'ok' : this.status === 'ok' ? 'none' : this.status;
      this._emit();
    },
    /** Следующий найденный вариант (если подобрался не тот ролик). */
    async next() {
      const e = this.entry;
      if (!e || !e.cands || !e.cands.length) return toast('Других вариантов нет — вставьте ссылку на клип');
      const pick = e.manual ? 0 : ((e.pick == null ? -1 : e.pick) + 1) % e.cands.length;
      await this._update({ pick, manual: null });
      this._applyVideo();
    },
    async setLink(text) {
      const id = await window.zvuk.yt.parse(text);
      if (!id) return toast('Не похоже на ссылку YouTube', { error: true });
      await this._update({ manual: id });
      this.status = 'ok';
      this._emit();
      this._applyVideo();
    },
    async shift(delta) {
      await this._update({ offset: Math.round((this.offset + delta) * 10) / 10 });
      for (const m of mounts) m.lastSeek = 0; // пересинхронизироваться сразу
    },

    // ---------- Встроенный плеер ----------
    attach(box) {
      const m = { box, iframe: null, videoId: null, ready: false, state: -1, time: null, timeAt: 0, lastSeek: 0, ro: null };
      mounts.add(m);
      box.classList.add('clip-box');
      // размер фона меняется (окно, полноэкранный режим) — плеер подстраивается под выбранное качество
      m.ro = new ResizeObserver(() => fit(m));
      m.ro.observe(box);
      if (Player.current && this.trackId !== String(Player.current.id)) this.resolve();
      else this._applyVideo();
      startSync();
      return {
        detach: () => {
          mounts.delete(m);
          m.ro.disconnect();
          if (m.iframe) m.iframe.remove();
          box.classList.remove('clip-box', 'clip-on');
        },
      };
    },

    trackChanged() {
      if (mounts.size) this.resolve();
      else this.trackId = null;
    },

    _applyVideo() {
      const id = this.videoId;
      for (const m of mounts) {
        if (m.videoId === id) continue;
        m.videoId = id;
        m.ready = false;
        m.state = -1;
        m.time = null;
        m.box.classList.remove('clip-on');
        if (m.iframe) m.iframe.remove();
        m.iframe = null;
        if (!id) continue;
        const start = Math.max(0, Math.floor(Player.audio.currentTime + this.offset));
        const vq = QUALITY[this.quality];
        this.actualQuality = '';
        const f = document.createElement('iframe');
        f.className = 'clip-frame';
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('tabindex', '-1');
        f.src = `${ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&cc_load_policy=0&enablejsapi=1&start=${start}${vq ? '&vq=' + vq : ''}`;
        f.addEventListener('load', () => {
          // подписка на события плеера (время, состояние)
          post(m, { event: 'listening', id: 1, channel: 'widget' });
          setTimeout(() => post(m, { event: 'listening', id: 1, channel: 'widget' }), 1200);
        });
        m.box.appendChild(f);
        m.iframe = f;
        fit(m);
      }
    },
  };

  function post(m, msg) {
    try {
      m.iframe && m.iframe.contentWindow && m.iframe.contentWindow.postMessage(JSON.stringify(msg), ORIGIN);
    } catch {}
  }
  const cmd = (m, func, args = []) => post(m, { event: 'command', func, args, id: 1, channel: 'widget' });

  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN) return;
    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    const m = [...mounts].find((x) => x.iframe && x.iframe.contentWindow === e.source);
    if (!m) return;
    if (d.event === 'onReady' || d.event === 'initialDelivery') {
      if (!m.ready) {
        m.ready = true;
        cmd(m, 'mute');
        cmd(m, 'unloadModule', ['captions']); // без звука YouTube сам включает субтитры
        cmd(m, 'unloadModule', ['cc']);
        // подсказка качества (новые версии плеера могут её игнорировать — главное делает размер плеера)
        const vq = QUALITY[Clip.quality];
        if (vq) {
          cmd(m, 'setPlaybackQualityRange', [vq, vq]);
          cmd(m, 'setPlaybackQuality', [vq]);
        }
      }
    }
    if (d.event === 'onError') {
      Clip.status = 'error';
      Clip.message = `YouTube не даёт показать этот ролик (код ${d.info}). Попробуйте «Другой».`;
      Clip._emit();
    }
    const info = d.info;
    if (info && typeof info === 'object') {
      if (typeof info.currentTime === 'number') {
        m.time = info.currentTime;
        m.timeAt = performance.now();
      }
      if (typeof info.playerState === 'number') m.state = info.playerState;
      if (typeof info.playbackQuality === 'string' && QNAME[info.playbackQuality] && QNAME[info.playbackQuality] !== Clip.actualQuality) {
        Clip.actualQuality = QNAME[info.playbackQuality];
        Clip._emit();
      }
    }
  });

  // ---------- Синхронизация с треком ----------
  let syncTimer = 0;
  function startSync() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      if (!mounts.size) {
        clearInterval(syncTimer);
        syncTimer = 0;
        return;
      }
      const a = Player.audio;
      const playing = !a.paused;
      const exp = a.currentTime + Clip.offset;
      const dur = Clip.info && Clip.info.dur;
      for (const m of mounts) {
        if (!m.iframe || !m.ready) continue;
        const outside = exp < 0 || (dur && exp > dur - 0.4);
        if (outside) {
          if (m.state === 1) cmd(m, 'pauseVideo');
          m.box.classList.remove('clip-on');
          continue;
        }
        if (playing && m.state !== 1 && m.state !== 3) cmd(m, 'playVideo');
        if (!playing && m.state === 1) cmd(m, 'pauseVideo');
        // текущее время клипа с поправкой на время с последнего сообщения
        const vt = m.time == null ? null : m.time + (m.state === 1 ? (performance.now() - m.timeAt) / 1000 : 0);
        if (vt != null && Math.abs(vt - exp) > 0.9 && performance.now() - m.lastSeek > 2500) {
          cmd(m, 'seekTo', [exp, true]);
          m.lastSeek = performance.now();
        }
        // показываем клип только когда он реально идёт (нет чёрных экранов загрузки и паузы)
        m.box.classList.toggle('clip-on', m.state === 1 && playing);
      }
    }, 400);
  }

  window.Clip = Clip;
})();
