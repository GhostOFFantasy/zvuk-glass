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
    /** Сдвиг клипа: при автосинхронизации — измеренный по звуку, иначе ручной. */
    get offset() {
      const a = this.autoInfo;
      if (this.auto && a) return a.offset;
      return (this.entry && this.entry.offset) || 0;
    },
    get manualOffset() {
      return (this.entry && this.entry.offset) || 0;
    },

    // ---------- Автосинхронизация по звуку ----------
    get auto() {
      return Boolean(App.settings.viz && App.settings.viz.clipAuto);
    },
    /** Результат измерения для текущего ролика: { vid, offset, score, lat, at }. */
    get autoInfo() {
      const e = this.entry;
      return e && e.auto && e.auto.vid === this.videoId && typeof e.auto.offset === 'number' ? e.auto : null;
    },
    sync: { state: 'idle', message: '' }, // idle | run | done | fail | wait
    _cal: false,
    _calKey: '',
    setAuto(on) {
      if (!App.settings.viz) App.settings.viz = {};
      App.settings.viz.clipAuto = Boolean(on);
      window.zvuk.settings.set({ viz: App.settings.viz });
      this._calKey = '';
      this.sync = { state: 'idle', message: '' };
      if (!on) for (const m of mounts) setRate(m, 1);
      for (const m of mounts) m.lastSeek = 0;
      this._emit();
    },

    /**
     * Измерение сдвига по звуку (около 10 секунд):
     * 1) пишем звук приложения, пока играет трек, — узнаём задержку всего звукового тракта;
     * 2) глушим трек и включаем звук клипа — узнаём, какое место песни звучит в клипе в его текущий момент.
     * Задержки тракта одинаковы для обоих звуков и сокращаются.
     */
    async calibrate(force = false) {
      if (this._cal || !this.auto) return;
      const m = [...mounts].reverse().find((x) => x.iframe && x.ready && x.box.isConnected);
      const a = Player.audio;
      if (!m || this.status !== 'ok' || !this.trackId || !this.videoId) return;
      if (!force && this.autoInfo) return;
      const set = (state, message = '') => {
        this.sync = { state, message };
        this._emit();
      };
      if (a.paused) return set('wait', 'Включите музыку — подстройка начнётся сама');
      const tid = this.trackId;
      const vid = this.videoId;
      this._calKey = tid + '|' + vid;
      this._cal = true;
      const still = () => this.trackId === tid && this.videoId === vid && this.auto && !a.paused;
      const restore = () => {
        cmd(m, 'mute');
        noCaptions(m);
        AudioFX.duck(false);
      };
      try {
        set('run', 'Готовим трек для сравнения…');
        setRate(m, 1);
        await window.zvuk.sync.prepare(tid);
        if (!still()) throw new Error('cancel');

        set('run', 'Слушаем трек… (1 из 2)');
        cmd(m, 'mute');
        const tl = sampleClock(() => a.currentTime);
        const t0 = a.currentTime;
        const rA = await window.zvuk.sync.measure(tid, 4, Math.max(0, t0 - 3), t0 + 8);
        tl.stop();
        if (!still()) throw new Error('cancel');
        if (!matched(rA)) throw new Error('Не удалось узнать трек в звуке приложения — попробуйте ещё раз');
        const lat = fitAt(tl.points, rA.startMs) - rA.pos; // задержка тракта для трека

        set('run', 'Слушаем клип… (2 из 2) — пару секунд звук идёт из клипа');
        AudioFX.duck(true);
        const vol = Math.max(8, Math.round(Player.volume * Player.volume * 100));
        cmd(m, 'unMute');
        cmd(m, 'setVolume', [vol]);
        // ждём, пока YouTube действительно сделает звук громче (сообщает в своих событиях), до 2 секунд
        for (let k = 0; k < 20 && (m.muted !== false || !(m.volume >= vol - 1)); k++) {
          if (k % 5 === 4) {
            cmd(m, 'unMute');
            cmd(m, 'setVolume', [vol]);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 300));
        console.warn(`SELFTEST clipsync phaseB: state=${m.state} muted=${m.muted} volume=${m.volume} rate=${m.rate}`);
        if (m.muted === true) throw new Error('YouTube не даёт включить звук клипа — нажмите на клип один раз и повторите');
        const rB = await window.zvuk.sync.measure(tid, 4.5, 0, 1e6);
        restore();
        if (!still()) throw new Error('cancel');
        if (!matched(rB)) throw new Error('Звук клипа не совпал с треком — возможно, в клипе другая версия песни или мешали другие звуки на компьютере');
        const pts = (m.hist || []).filter((p) => p[0] > rB.startMs - 4000 && p[0] < rB.startMs + 7000);
        const v = fitAt(pts, rB.startMs);
        if (v == null) {
          const h = m.hist || [];
          console.warn(`SELFTEST clipsync nohist: hist=${h.length} first=${h.length ? (h[0][0] - rB.startMs).toFixed(0) : '-'} last=${h.length ? (h[h.length - 1][0] - rB.startMs).toFixed(0) : '-'} now=${(wallNow() - rB.startMs).toFixed(0)}`);
          throw new Error('YouTube не сообщил время клипа — попробуйте ещё раз');
        }
        const offset = Math.round((v - rB.pos - lat) * 1000) / 1000;
        if (!isFinite(offset) || Math.abs(offset) > 900) throw new Error('Получился странный сдвиг — попробуйте ещё раз');
        await this._update({ auto: { vid, offset, score: Math.round(rB.score * 100) / 100, lat: Math.round(lat * 1000), at: Date.now() } });
        for (const x of mounts) x.lastSeek = 0;
        console.warn(`SELFTEST clipsync: offset=${offset} lat=${(lat * 1000).toFixed(0)}ms scoreA=${rA.score.toFixed(2)}/${rA.second.toFixed(2)} scoreB=${rB.score.toFixed(2)}/${rB.second.toFixed(2)} posB=${rB.pos.toFixed(3)} v=${v.toFixed(3)} pts=${pts.length}`);
        set('done');
      } catch (e) {
        restore();
        const msg = (e && e.message) || String(e);
        if (msg === 'cancel') set('idle');
        else {
          console.warn(`SELFTEST clipsync fail: ${msg}`);
          set('fail', msg);
        }
      } finally {
        this._cal = false;
      }
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
      if (this.auto) return; // при автосинхронизации ручной сдвиг недоступен
      await this._update({ offset: Math.round((this.manualOffset + delta) * 10) / 10 });
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
      this.sync = { state: 'idle', message: '' };
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
        // без autoplay: играть клип начнёт синхронизация, когда громкость уже 0 (без «вспышки» звука)
        f.src = `${ORIGIN}/embed/${id}?autoplay=0&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&cc_load_policy=0&enablejsapi=1&start=${start}${vq ? '&vq=' + vq : ''}`;
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

  /** Без звука YouTube сам включает субтитры — выключаем их (после смены громкости он включает снова). */
  function noCaptions(m) {
    cmd(m, 'unloadModule', ['captions']);
    cmd(m, 'unloadModule', ['cc']);
    cmd(m, 'setOption', ['captions', 'track', {}]);
  }

  // ---------- Помощники автосинхронизации ----------
  /** Общие часы с Rust-частью: миллисекунды от эпохи (с долями). */
  const wallNow = () => performance.timeOrigin + performance.now();
  /** Записывает значение часов (например, позицию трека) каждые 10 мс. */
  function sampleClock(fn) {
    const points = [];
    const t = setInterval(() => points.push([wallNow(), fn()]), 10);
    points.push([wallNow(), fn()]);
    return { points, stop: () => clearInterval(t) };
  }
  /** Прямая по точкам [мс, секунды] методом наименьших квадратов → значение в момент tMs. */
  function fitAt(points, tMs) {
    if (!points || !points.length) return null;
    if (points.length === 1) return points[0][1] + (tMs - points[0][0]) / 1000;
    const n = points.length;
    const mx = points.reduce((s, p) => s + p[0], 0) / n;
    const my = points.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const [x, y] of points) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) * (x - mx);
    }
    let k = sxx > 0 ? sxy / sxx : 0.001;
    // время идёт с обычной скоростью: если точки шумят, не даём наклону уйти далеко
    if (!(k > 0.0009 && k < 0.0011)) k = 0.001;
    return my + k * (tMs - mx);
  }
  /** Совпадение уверенное: по аккордам это место заметно лучше любого другого места трека. */
  // (тот же звук даёт ~0,8; ниже 0,4 — скорее похожие аккорды в другом месте песни)
  const matched = (r) => r && r.score >= 0.4 && r.score - r.second >= 0.1;
  function setRate(m, r) {
    if ((m.rateWant || 1) === r) return;
    m.rateWant = r;
    m.stableSince = wallNow() + 300; // сообщения в момент смены скорости не учитываем
    cmd(m, 'setPlaybackRate', [r]);
  }
  /** Время клипа сейчас: среднее по сообщениям YouTube за 1,5 с (одиночное сообщение «дрожит» на миллисекунды). */
  function clipNow(m) {
    const rate = m.rateWant || 1;
    if (m.state !== 1) return m.time;
    const now = wallNow();
    const pts = (m.hist || []).filter((p) => p[0] > now - 1500 && p[0] > (m.stableSince || 0));
    if (!pts.length) return m.time + (rate * (performance.now() - m.timeAt)) / 1000;
    return pts.reduce((s, p) => s + p[1] + (rate * (now - p[0])) / 1000, 0) / pts.length;
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN) return;
    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    const m = [...mounts].find((x) => x.iframe && x.iframe.contentWindow === e.source);
    if (window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot) {
      // служебно: поток событий YouTube в режиме проверки (каждое 15-е)
      Clip._dbg = (Clip._dbg || 0) + 1;
      if (Clip._dbg % 15 === 1 || d.event === 'onStateChange' || d.event === 'onError') {
        const i = d.info && typeof d.info === 'object' ? d.info : {};
        console.warn(`YT #${Clip._dbg} ${d.event} mount=${Boolean(m)} mounts=${mounts.size} t=${i.currentTime != null ? i.currentTime.toFixed(2) : '-'} st=${i.playerState ?? (typeof d.info === 'number' ? d.info : '-')} vol=${i.volume ?? '-'} muted=${i.muted ?? '-'}`);
      }
    }
    if (!m) return;
    if (d.event === 'onReady' || d.event === 'initialDelivery') {
      if (!m.ready) {
        m.ready = true;
        // Клип без звука. Важно: не параметром mute=1 в адресе (из этого режима «автозапуск без звука»
        // YouTube без нажатия пользователя звук не включает), а обычной командой — её можно отменить
        // для автосинхронизации. Громкость 0 не годится: YouTube держит минимум 5%.
        cmd(m, 'mute');
        noCaptions(m);
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
      if (typeof info.playbackRate === 'number') m.rate = info.playbackRate;
      if (typeof info.muted === 'boolean') m.muted = info.muted;
      if (typeof info.volume === 'number') m.volume = info.volume;
      if (typeof info.currentTime === 'number') {
        m.time = info.currentTime;
        m.timeAt = performance.now();
        // история времени клипа (для точной подстройки) — последние 10 секунд
        const h = m.hist || (m.hist = []);
        h.push([wallNow(), info.currentTime]);
        while (h.length && h[0][0] < h[h.length - 1][0] - 10000) h.shift();
      }
      if (typeof info.playerState === 'number') m.state = info.playerState;
      if (typeof info.playbackQuality === 'string' && QNAME[info.playbackQuality] && QNAME[info.playbackQuality] !== Clip.actualQuality) {
        Clip.actualQuality = QNAME[info.playbackQuality];
        Clip._emit();
      }
    }
  });

  // ---------- Синхронизация с треком ----------
  /**
   * Точное удержание (автосинхронизация). Мелкое расхождение убираем разовой поправкой:
   * клип идёт ×1,25 или ×0,75 ровно столько, сколько нужно (|расхождение| / 0,25 с), и возвращается к ×1 —
   * без перемотки и подгрузки. Большое расхождение — перемоткой.
   */
  function holdTight(m, drift, exp) {
    const now = performance.now();
    if (m.corrUntil && now < m.corrUntil) return; // идёт поправка или плеер успокаивается после неё
    const ad = Math.abs(drift);
    if (ad > 1.2) {
      if (now - m.lastSeek > 2000) {
        clearTimeout(m.corrTimer);
        setRate(m, 1);
        cmd(m, 'seekTo', [exp + 0.12, true]); // небольшой запас на подгрузку после перемотки
        m.lastSeek = now;
        m.stableSince = wallNow() + 700;
        m.corrUntil = now + 1600;
      }
      return;
    }
    // До 40 мс рассинхрон губ и звука не заметен (порог восприятия ~45 мс), а точность замера ~±20 мс;
    // YouTube поддерживает только ×0,75 / ×1,25 — поправка короче 160 мс не успевает сработать
    if (ad < 0.04) return;
    const ms = Math.min(4000, Math.max(160, (ad / 0.25) * 1000));
    if (window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot) console.warn(`HOLD drift=${(drift * 1000).toFixed(0)}ms fix=${ms.toFixed(0)}ms reportedRate=${m.rate} pts=${(m.hist || []).filter((p) => p[0] > (m.stableSince || 0)).length}`);
    setRate(m, drift > 0 ? 0.75 : 1.25);
    clearTimeout(m.corrTimer);
    m.corrTimer = setTimeout(() => setRate(m, 1), ms);
    m.corrUntil = now + ms + 1100; // после поправки ждём свежих сообщений о времени
  }

  // служебно (режим снимков): текущее расхождение клипа и трека, секунды
  Clip._driftForTest = () => {
    const m = [...mounts].find((x) => x.ready && x.time != null);
    if (!m || (m.corrUntil && performance.now() < m.corrUntil)) return NaN;
    return clipNow(m) - (Player.audio.currentTime + Clip.offset);
  };

  let syncTimer = 0;
  let tick = 0;
  function startSync() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      // плееры, чей фон уже убран со страницы, освобождаем (защита от утечек)
      for (const m of [...mounts]) {
        if (!m.box.isConnected) {
          mounts.delete(m);
          m.ro.disconnect();
          clearTimeout(m.corrTimer);
          if (m.iframe) m.iframe.remove();
        }
      }
      if (!mounts.size) {
        clearInterval(syncTimer);
        syncTimer = 0;
        return;
      }
      tick++;
      const tight = Clip.auto && !Clip._cal && Boolean(Clip.autoInfo);
      // обычный режим проверяется раз в 400 мс, точный — каждые 100 мс
      if (!tight && !Clip._cal && tick % 4) return;
      const a = Player.audio;
      // в свёрнутом окне клип стоит (после разворота догонит трек перемоткой)
      const playing = !a.paused && !(Clip.hidden && !Clip._cal);
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
        // показываем клип только когда он реально идёт (нет чёрных экранов загрузки и паузы)
        m.box.classList.toggle('clip-on', m.state === 1 && playing);
        if (tick % 50 === 0) noCaptions(m); // субтитры YouTube иногда возвращаются сами
        if (Clip._cal || m.time == null) continue; // во время подстройки клип не трогаем
        // текущее время клипа: точное (среднее по сообщениям) в режиме автосинхронизации
        const rate = m.rateWant || 1;
        const vt = tight ? clipNow(m) : m.time + (m.state === 1 ? (rate * (performance.now() - m.timeAt)) / 1000 : 0);
        const drift = vt - exp;
        if (tight && playing && m.state === 1) holdTight(m, drift, exp);
        else {
          if (m.rateWant && m.rateWant !== 1) setRate(m, 1);
          if (Math.abs(drift) > 0.9 && performance.now() - m.lastSeek > 2500) {
            cmd(m, 'seekTo', [exp, true]);
            m.lastSeek = performance.now();
          }
        }
        // автосинхронизация включена, а измерения для этого клипа ещё нет — запускаем, когда клип пошёл
        if (Clip.auto && !Clip.autoInfo && playing && m.state === 1 && Clip.status === 'ok') {
          const key = Clip.trackId + '|' + Clip.videoId;
          if (Clip._calKey !== key && performance.now() - m.lastSeek > 2500) Clip.calibrate();
        }
      }
    }, 100);
  }

  window.Clip = Clip;
})();
