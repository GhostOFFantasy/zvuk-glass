'use strict';
/* Официальный клип трека с YouTube на фоне визуализатора: поиск, встроенный плеер без звука, синхронизация с треком */
(function () {
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const mounts = new Set(); // { box, iframe, videoId, ready, state, time, timeAt, lastSeek }
  const listeners = new Set();

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
      const m = { box, iframe: null, videoId: null, ready: false, state: -1, time: null, timeAt: 0, lastSeek: 0 };
      mounts.add(m);
      box.classList.add('clip-box');
      if (Player.current && this.trackId !== String(Player.current.id)) this.resolve();
      else this._applyVideo();
      startSync();
      return {
        detach: () => {
          mounts.delete(m);
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
        const f = document.createElement('iframe');
        f.className = 'clip-frame';
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('tabindex', '-1');
        f.src = `${ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&cc_load_policy=0&enablejsapi=1&start=${start}`;
        f.addEventListener('load', () => {
          // подписка на события плеера (время, состояние)
          post(m, { event: 'listening', id: 1, channel: 'widget' });
          setTimeout(() => post(m, { event: 'listening', id: 1, channel: 'widget' }), 1200);
        });
        m.box.appendChild(f);
        m.iframe = f;
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
