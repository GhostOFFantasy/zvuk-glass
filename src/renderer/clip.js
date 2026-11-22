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
  // Сколько YouTube держит поверх ролика свою кнопку паузы после запуска или перемотки (с запасом)
  const YT_CHROME_MS = 4800;
  // …если внутри плеера наш стиль их уже спрятал (см. YT_FRAME_JS в lib.rs) — клип показываем почти сразу
  const YT_CHROME_HIDDEN_MS = 100;
  // Небольшой запас на запуск: прежние полторы секунды заметно задерживали первый кадр.
  const START_LEAD = 0.35;
  // Не сокращать ниже 4 с: более короткие фрагменты теряют надёжность на повторах и тихих местах.
  const CAPTURE_S = 4;
  // Вступление песни (секунды): там замер клипа «на месте» ненадёжен — слушаем середину песни
  const INTRO_S = 20;
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
    const bw = m.box.clientWidth;
    const bh = m.box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const fitKey = `${q}:${Math.round(bw)}x${Math.round(bh)}@${dpr}`;
    if (m.fitKey !== fitKey) {
      m.fitKey = fitKey;
      m.qualityRetries = 0;
      m.qualityMatched = false;
      clearTimeout(m.qualityTimer);
      m.qualityTimer = 0;
    }
    if (q === 'auto') {
      f.style.width = f.style.height = f.style.transform = '';
      applyQuality(m);
      return;
    }
    if (!bw || !bh) return;
    const h = (FRAME[q] || +q) / dpr;
    const w = (h * 16) / 9;
    const k = Math.max(bw / w, bh / h);
    f.style.width = w.toFixed(1) + 'px';
    f.style.height = h.toFixed(1) + 'px';
    f.style.transform = `translate(-50%, -50%) scale(${k.toFixed(4)})`;
    scheduleQuality(m);
  }

  function applyQuality(m, force = false) {
    const vq = QUALITY[Clip.quality];
    const wanted = vq || 'auto';
    m.qualityWanted = wanted;
    if (!m.ready || (!force && m.qSent === wanted)) return;
    const now = performance.now();
    m.qSent = wanted;
    m.qSentAt = now;
    m.qualityMatched = false;
    post(m, { event: 'zgQuality', quality: wanted });
    if (vq) {
      cmd(m, 'setPlaybackQualityRange', [vq, vq]);
      cmd(m, 'setPlaybackQuality', [vq]);
    } else {
      // После ручного 4K «Авто» должно снова разрешить YouTube выбирать весь диапазон.
      cmd(m, 'setPlaybackQualityRange', ['default', 'highres']);
      cmd(m, 'setPlaybackQuality', ['default']);
    }
    m.qualityRequests = (m.qualityRequests || 0) + 1;
  }

  // Не пересоздаём iframe и не зацикливаем загрузку: несколько коротких попыток после старта/ресайза.
  function scheduleQuality(m) {
    if (!m.ready || !QUALITY[Clip.quality] || m.qualityMatched || m.qualityTimer) return;
    const delays = [0, 350, 1000, 2400, 5000];
    const step = () => {
      m.qualityTimer = 0;
      if (!m.iframe || !m.ready || m.qualityMatched || !QUALITY[Clip.quality]) return;
      applyQuality(m, true);
      const n = (m.qualityRetries = (m.qualityRetries || 0) + 1);
      if (n < delays.length) m.qualityTimer = setTimeout(step, delays[n]);
    };
    m.qualityTimer = setTimeout(step, delays[0]);
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
      const a = e && e.auto;
      // Неподтверждённые 3-секундные замеры пересчитываем; ручную фиксацию и старые удачные сохраняем.
      return a && a.vid === this.videoId && a.ver === ClipSync.VERSION && (a.locked || a.captureMs !== 3000) && typeof a.offset === 'number' && isFinite(a.offset) && (!a.rate || (a.rate >= 0.97 && a.rate <= 1.03)) ? a : null;
    },
    get rate() {
      const a = this.autoInfo;
      return this.auto && a && a.rate ? a.rate : 1;
    },
    get syncMode() {
      if (!this.auto) return 'manual';
      return this.autoInfo && this.autoInfo.locked ? 'locked' : 'auto';
    },
    /** Явное действие пользователя отменяет старый замер: его результат не должен перезаписать выбор. */
    cancelCalibration() {
      if (!this._cal) return false;
      this._calSeq++;
      this._cal = false;
      this.sync = { state: 'idle', message: '' };
      AudioFX.duck(false);
      return true;
    },
    /** Авто — осторожное удержание; заблокировано — только ручная поправка; вручную — без аудиозахвата. */
    async setSyncMode(mode) {
      this.cancelCalibration();
      if (mode === 'manual') {
        const off = this.offset;
        this.setAuto(false);
        await this._update({ offset: Math.round(off * 1000) / 1000 });
      } else if (mode === 'locked') {
        if (!this.auto) this.setAuto(true);
        const a = this.autoInfo;
        if (a) await this._update({ auto: { ...a, locked: true } });
      } else {
        if (!this.auto) this.setAuto(true);
        const a = this.autoInfo;
        if (a && a.locked) await this._update({ auto: { ...a, locked: false } });
        if (!this.autoInfo && Player.current) this.requestSync(Player.current.id);
      }
      resetMounts();
      this._emit();
    },
    sync: { state: 'idle', message: '' }, // idle | run | done | fail | wait
    _cal: false,
    _calKey: '',
    _calSeq: 0,
    pref(key) {
      if (key === 'clipKeepPaused') return App.settings.viz?.[key] === true;
      return App.settings.viz?.[key] !== false;
    },
    setPreference(key, on) {
      if (!['clipRestart', 'inkEnabled', 'clipKeepPaused'].includes(key)) return;
      if (!App.settings.viz) App.settings.viz = {};
      App.settings.viz[key] = Boolean(on);
      window.zvuk.settings.set({ viz: App.settings.viz });
      if (key === 'inkEnabled' && window.Ink) on ? Ink.start() : Ink.stop();
      this._emit();
    },
    _restartAfterSync() {
      if (this.pref('clipRestart')) {
        Player.seek(0);
        toast('Клип подстроен по нескольким фрагментам — трек играет сначала', { iconName: 'check', ms: 2600 });
        return 'restart';
      }
      const exp = Player.audio.currentTime * this.rate + this.offset;
      for (const m of mounts) if (m.ready) jumpClip(m, exp, 'calibrated');
      toast('Клип подстроен по нескольким фрагментам — позиция трека сохранена', { iconName: 'check', ms: 2600 });
      return 'hold';
    },
    _latencyHint() {
      const c = window.AudioFX && AudioFX.ctx;
      if (!c) return null;
      return { baseMs: Math.round((Number(c.baseLatency) || 0) * 1000), outputMs: Math.round((Number(c.outputLatency) || 0) * 1000), measured: false };
    },
    /** Человек согласился подстроить клип этого трека (уведомление или переключатель): подстройка начнётся, когда клип пойдёт. */
    requestSync(trackId) {
      if (!this.auto) this.setAuto(true);
      prepareTrack(trackId); // пока грузится клип, трек для сравнения уже скачивается
      this._wantTrack = String(trackId);
      this._calKey = '';
      this._calTries = 0;
      this.sync = { state: 'idle', phase: 'requested', message: 'Начну синхронизацию, когда клип появится на экране' };
      this._emit();
    },
    setAuto(on) {
      if (!App.settings.viz) App.settings.viz = {};
      App.settings.viz.clipAuto = Boolean(on);
      window.zvuk.settings.set({ viz: App.settings.viz });
      this._calSeq++;
      this._cal = false;
      this._calKey = '';
      this.sync = { state: 'idle', message: '' };
      AudioFX.duck(false);
      for (const m of mounts) {
        cmd(m, 'mute');
        noCaptions(m);
        setRate(m, on ? this.rate : 1);
        m.lastSeek = 0;
      }
      resetMounts();
      this._emit();
    },

    /** Два коротких независимых фрагмента; третий — только при неоднозначности. */
    async calibrate(force = false) {
      if (this._cal || !this.auto) return;
      const set = (state, message = '', phase = state, detail = {}) => {
        this.sync = { state, message, phase, ...detail };
        this._emit();
      };
      const m = [...mounts].reverse().find((x) => x.iframe && x.ready && x.box.isConnected);
      const a = Player.audio;
      if (!m) return set('wait', 'Клип ещё загружается — подстройка начнётся после запуска');
      if (this.status !== 'ok' || !this.trackId || !this.videoId) return set('wait', 'Сначала дождитесь загрузки клипа');
      if (!force && this.autoInfo) return;
      if (a.paused) return set('wait', 'Включите музыку — подстройка начнётся сама');
      const tid = this.trackId;
      const vid = this.videoId;
      const key = tid + '|' + vid;
      const seq = ++this._calSeq;
      if (this._calKey !== key) this._calTries = 0;
      this._calKey = key;
      this._calTries = (this._calTries || 0) + 1;
      this._wantTrack = tid;
      this._cal = true;
      const began = performance.now();
      const still = () => seq === this._calSeq && this.trackId === tid && this.videoId === vid && this.auto && !a.paused && !this.hidden && m.iframe && m.box.isConnected;
      const restore = () => {
        if (seq !== this._calSeq && this._cal) return;
        cmd(m, 'mute');
        noCaptions(m);
        setRate(m, this.rate);
        AudioFX.duck(false);
        resetMounts();
      };
      try {
        set('run', 'Готовим трек для сравнения…', 'prepare');
        setRate(m, 1);
        const prep = await prepareTrack(tid); // обычно уже готов благодаря requestSync()
        if (!still()) throw new Error('cancel');
        const T = (prep && prep.duration) || a.duration || 0;

        set('run', 'Слушаем трек и измеряем задержку…', 'latency');
        cmd(m, 'mute');
        const lat = await getLatency(tid, a);
        if (!still()) throw new Error('cancel');
        if (lat == null) throw new Error('Не удалось узнать трек в звуке приложения — попробуйте ещё раз');

        set('run', 'Слушаем клип — несколько секунд звук идёт из клипа', 'listen');
        AudioFX.duck(true);
        const vol = Math.max(8, Math.round(Player.volume * Player.volume * 100));
        cmd(m, 'unMute');
        cmd(m, 'setVolume', [vol]);
        for (let k = 0; k < 14 && (m.muted !== false || !(m.volume >= vol - 1)); k++) {
          if (k % 4 === 3) {
            cmd(m, 'unMute');
            cmd(m, 'setVolume', [vol]);
          }
          await sleep(70);
        }
        await sleep(120);
        if (m.muted === true) throw new Error('YouTube не даёт включить звук клипа — нажмите на клип один раз и повторите');
        if (m.state !== 1) throw new Error('Клип остановился или загружается — включите его и повторите вручную');

        const D = (this.info && this.info.dur) || m.dur || 0;
        const plan = this._testPlan ? this._testPlan.slice() : shotPlan(T, D, a.currentTime, this.offset);
        const shots = [];
        let found = null;
        let silent = 0;
        let noTime = 0;
        let unstable = 0;
        for (let k = 0; k < plan.length && !found; k++) {
          let from = (m.seekWall || 0) + 400;
          set('run', `Проверяем музыкальный фрагмент… (${k + 1} из ${plan.length})`, 'measure', { shot: k + 1, total: plan.length });
          if (plan[k] != null) {
            const t = await seekClip(m, plan[k], still);
            if (!still()) throw new Error('cancel');
            if (t == null) continue;
            from = t;
          }
          const clock = sampleClock(() => [a.currentTime, !a.paused && a.readyState >= 3, m.state]);
          let r;
          try {
            r = await window.zvuk.sync.measure(tid, CAPTURE_S, 0, 1e6);
          } catch (e) {
            clock.stop();
            if (!still()) throw new Error('cancel');
            if (e && e.code === 'SILENT') silent++;
            console.warn(`SELFTEST clipsync shot ${k}: ${(e && e.message) || e}`);
            continue;
          }
          const samples = clock.stop();
          if (!still()) throw new Error('cancel');
          const end = r.endMs || r.startMs + CAPTURE_S * 1000;
          const observed = samples.filter((p) => p[0] >= r.startMs && p[0] <= end);
          const good = observed.filter((p) => p[1][1] && p[1][2] === 1);
          const track = fitInfo(good.map((p) => [p[0], p[1][0]]), r.startMs);
          const pts = (m.hist || []).filter((p) => p[0] > Math.max(r.startMs - 1200, from) && p[0] < end);
          const clip = fitInfo(pts, r.startMs);
          if (!track || !clip || good.length < observed.length * 0.9 || track.error > 0.08 || clip.error > 0.1 || m.seekWall > r.startMs + 200) {
            unstable++;
            if (!pts.length) noTime++;
            console.warn(`SELFTEST clipsync shot ${k}: нестабильный участок clock=${good.length}/${observed.length} clipPts=${pts.length}`);
            continue;
          }
          const v = clip.value;
          if (v == null) {
            noTime++;
            continue;
          }
          const cands = (r.cands && r.cands.length ? r.cands : [{ pos: r.pos, score: r.score, rate: r.rate }]).map((c) => {
            const rate = c.rate >= 0.97 && c.rate <= 1.03 ? c.rate : 1;
            return { off: v - (c.pos + lat) * rate, rate, score: c.score };
          });
          shots.push({ v, score: r.score, second: r.second, cands });
          console.warn(`SELFTEST clipsync shot ${k}: v=${v.toFixed(2)} pts=${pts.length} ` + cands.map((c) => `${c.off.toFixed(3)}@${c.rate.toFixed(3)}:${c.score.toFixed(2)}`).join(' '));
          set('run', 'Сопоставляю результаты замеров…', 'match', { shot: k + 1, total: plan.length });
          found = ClipSync.decide(shots);
        }
        restore();
        if (!still()) throw new Error('cancel');
        if (!found) {
          if (!shots.length && noTime) throw new Error('YouTube не сообщил время клипа — попробуйте ещё раз');
          if (!shots.length && silent) throw new Error('Звук клипа не слышен — проверьте, что YouTube не заглушён');
          if (!shots.length && unstable) throw new Error('Клип или трек останавливался во время замера — повторите вручную на спокойном участке');
          throw new Error('Версия клипа отличается от трека или совпадение неоднозначно. Автоматический сдвиг не применён');
        }
        const offset = Math.round(found.offset * 1000) / 1000;
        const rate = Math.round(found.rate * 10000) / 10000;
        if (!isFinite(offset) || Math.abs(offset) > 900 || !(rate >= 0.97 && rate <= 1.03)) throw new Error('Сдвиг не прошёл проверку — автоматическая настройка отменена');
        const elapsedMs = Math.round(performance.now() - began);
        const auto = {
          ver: ClipSync.VERSION, vid, offset, rate, score: Math.round(found.score * 100) / 100,
          confidence: Math.round(found.confidence * 100) / 100, lat: Math.round(lat * 1000), at: Date.now(),
          by: found.by, shots: shots.length, elapsedMs, captureMs: CAPTURE_S * 1000, locked: false,
        };
        set('run', 'Применяю измеренный сдвиг…', 'apply', { offset, confidence: auto.confidence, shots: shots.length, elapsedMs });
        await this._update({ auto });
        if (!still()) throw new Error('cancel');
        this._lastCalibration = { ...auto, unstable, silent };
        resetMounts();
        console.warn(`SELFTEST clipsync: offset=${offset} rate=${rate} lat=${(lat * 1000).toFixed(0)}ms by=${found.by} confidence=${found.confidence.toFixed(2)} shots=${shots.length} took=${(elapsedMs / 1000).toFixed(1)}s`);
        set('done', '', 'done', { offset, confidence: auto.confidence, shots: shots.length, elapsedMs });
        if (still()) this._restartAfterSync();
      } catch (e) {
        restore();
        const msg = (e && e.message) || String(e);
        if (msg === 'cancel') set('idle');
        else {
          console.warn(`SELFTEST clipsync fail: ${msg}`);
          set('fail', msg); // никаких автоматических повторов после первой реальной неудачи
        }
      } finally {
        if (seq === this._calSeq) this._cal = false;
        this._calEnd = performance.now();
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
      // Сохраняем текущий кадр: переключение качества не пересоздаёт плеер.
      for (const m of mounts) {
        clearTimeout(m.qualityTimer);
        m.qualityTimer = 0;
        m.qualityMatched = false;
        m.qualityRetries = 0;
        m.qSent = null;
        fit(m);
        applyQuality(m, true);
        scheduleQuality(m);
      }
      this._emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    _emit() {
      for (const fn of listeners) fn(this);
      document.dispatchEvent(new CustomEvent('zg:clip', { detail: this }));
    },
    _debugMounts() {
      return [...mounts].map((m) => ({ ready: m.ready, state: m.state, time: m.time, on: m.box.classList.contains('clip-on'), connected: m.box.isConnected, videoId: m.videoId }));
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
      const r = await window.zvuk.yt.find(trackInfo(t), force);
      if (seq !== this._seq) return;
      clearTimeout(this._retryTimer);
      if (!r.ok) {
        this.status = 'error';
        this.message = r.error.message;
        // сеть ещё не поднялась (например, сразу после включения компьютера) — пробуем снова с растущей паузой
        const code = r.error && r.error.code;
        if (!['QUOTA', 'BAD_KEY', 'API_DISABLED'].includes(code) && mounts.size) {
          const tid = this.trackId;
          this._retries = (this._retries || 0) + 1;
          const wait = Math.min(30000, 2500 * 2 ** Math.min(this._retries - 1, 4));
          this._retryTimer = setTimeout(() => this.trackId === tid && mounts.size && this.resolve(), wait);
        }
      } else {
        this._retries = 0;
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
      this.cancelCalibration();
      const off = Math.round((this.offset + delta) * 1000) / 1000;
      const a = this.autoInfo;
      if (this.auto && a) {
        // Ручная поправка всегда важнее автоматики и сохраняется как явная блокировка.
        await this._update({ auto: { ...a, offset: off, locked: true, manualAt: Date.now() } });
      } else {
        if (this.auto) this.setAuto(false);
        await this._update({ offset: off });
      }
      resetMounts();
      for (const m of mounts) m.lastSeek = 0;
    },

    // ---------- Встроенный плеер ----------
    attach(box) {
      const m = { box, iframe: null, videoId: null, ready: false, state: -1, time: null, timeAt: 0, lastSeek: 0, ro: null, rateWant: 1, driftFilter: new ClipSync.DriftFilter(), history: [], corrections: 0 };
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
          clearTimeout(m.qualityTimer);
          clearTimeout(m.corrTimer);
          clearTimeout(m.rateTimer);
          m.qualityTimer = 0;
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
        if (this._cal) {
          this._calSeq++;
          this._cal = false;
          AudioFX.duck(false);
        }
        if (m.reloadFor !== id) {
          m.reloadFor = id;
          m.reloads = 0;
        }
        m.videoId = id;
        m.ready = false;
        m.state = -1;
        m.time = null;
        m.hist = [];
        m.everPlayed = false;
        m.chromeOff = false;
        clearTimeout(m.qualityTimer);
        m.qualityTimer = 0;
        m.qSent = null;
        m.quality = '';
        m.qualityMatched = false;
        m.qualityRetries = 0;
        m.qualityRequests = 0;
        m.fitKey = '';
        m.seekTarget = null;
        m.seekSentAt = 0;
        m.seekAckAt = 0;
        m.seekLatencyMs = null;
        m.lastSeek = 0;
        m.rateWant = 1;
        m.rate = 1;
        m.fineRate = false;
        m.rateBlocked = false;
        m.created = performance.now();
        resetMount(m);
        m.box.classList.remove('clip-on');
        if (m.iframe) m.iframe.remove();
        m.iframe = null;
        if (!id) continue;
        // Единая модель времени: clip = track × rate + offset.
        const start = Math.max(0, Math.round(Player.audio.currentTime * this.rate + this.offset + (Player.audio.paused ? 0 : START_LEAD * this.rate)));
        const vq = QUALITY[this.quality];
        this.actualQuality = '';
        const f = document.createElement('iframe');
        f.className = 'clip-frame';
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('tabindex', '-1');
        // без autoplay: играть клип начнёт синхронизация, когда громкость уже 0 (без «вспышки» звука)
        f.src = `${ORIGIN}/embed/${id}?autoplay=0&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&cc_load_policy=0&enablejsapi=1&start=${start}${vq ? '&vq=' + vq : ''}#zgq=${vq || 'auto'}`;
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

  /** Перемотка клипа. После неё YouTube на несколько секунд показывает свою кнопку паузы — клип прячем, пока она не уйдёт. */
  function seekVideo(m, t) {
    cmd(m, 'seekTo', [t, true]);
    m.playSince = performance.now();
    m.box.classList.remove('clip-on');
  }

  /** Обязательная перемотка именно по действию пользователя, не отложенная коррекция дрейфа. */
  function jumpClip(m, t, kind = 'track') {
    const target = Math.max(0, Number(t) || 0);
    const now = performance.now();
    const wall = wallNow();
    resetMount(m);
    seekVideo(m, target);
    m.lastSeek = now;
    m.seekWall = wall;
    m.seekSentAt = now;
    m.seekTarget = target;
    m.seekAckAt = 0;
    m.seekLatencyMs = null;
    m.seekKind = kind;
    m.trackAt = wall;
    m.trackTime = Player.audio.currentTime;
    m.transport = !Player.audio.paused && Player.audio.readyState >= 3;
  }

  function syncTrackSeek(time) {
    if (Clip._cal || !isFinite(time)) return;
    const exp = time * Clip.rate + Clip.offset;
    for (const m of mounts) {
      if (m.ready && m.videoId === Clip.videoId && (m.state === 1 || m.state === 2)) jumpClip(m, exp, 'track');
    }
  }
  // clip.js загружается раньше player.js: подписка выполняется только после загрузки всех модулей.
  Clip.bindPlayer = () => {
    if (Clip._playerBound) return;
    Clip._playerBound = true;
    Player.on('seek', ({ time }) => syncTrackSeek(time));
  };
  Clip._seekForTest = (m, time) => jumpClip(m, time, 'test');
  Clip._qualityForTest = (m) => {
    applyQuality(m, true);
    return { wanted: m.qualityWanted, requests: m.qualityRequests };
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
  /** Записывает состояние часов каждые 20 мс; stop() возвращает неизменяемый снимок замера. */
  function sampleClock(fn) {
    const points = [];
    let stopped = false;
    const sample = () => !stopped && points.push([wallNow(), fn()]);
    const t = setInterval(sample, 20);
    sample();
    return {
      points,
      stop: () => {
        if (stopped) return points.slice();
        clearInterval(t);
        sample(); // последняя точка фиксирует реальный конец записи
        stopped = true;
        return points.slice();
      },
    };
  }
  /** Общая регрессия времени: сохраняет значение, скорость и ошибку для проверки качества. */
  function fitInfo(points, tMs, rate = 1) {
    return ClipSync.fitAt(points, tMs, rate);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Задержка звукового тракта с прошлого удачного замера: { v, dev, at } (у каждого устройства вывода своя). */
  function lastLatInfo() {
    const l = App.settings.clipLat;
    if (typeof l === 'number' && isFinite(l)) return { v: l, dev: '', at: 0 };
    return l && typeof l === 'object' && isFinite(l.v) ? l : null;
  }
  function lastLat() {
    const l = lastLatInfo();
    return l ? l.v : null;
  }

  /** Трек для сравнения: скачать и разобрать один раз (повторный вызов ждёт тот же результат). */
  let prepared = { id: null, p: null };
  function prepareTrack(tid) {
    tid = String(tid);
    if (prepared.id !== tid) {
      const p = window.zvuk.sync.prepare(tid);
      prepared = { id: tid, p };
      p.catch(() => prepared.p === p && (prepared = { id: null, p: null }));
    }
    return prepared.p;
  }

  /**
   * Задержка тракта. Если она уже измерена на этом же устройстве вывода за последние три дня — берём её
   * и сразу переходим к звуку клипа (подстройка на ~5 секунд быстрее); иначе измеряем.
   */
  async function getLatency(tid, a) {
    const dev = await window.zvuk.sync.device().catch(() => '');
    const l = lastLatInfo();
    if (l && dev && l.dev === dev && Date.now() - l.at < 3 * 86400e3) {
      console.warn(`SELFTEST clipsync latency: прошлая ${(l.v * 1000).toFixed(0)}ms (то же устройство)`);
      return l.v;
    }
    return measureLatency(tid, a, dev);
  }

  /**
   * Задержка звукового тракта: какое место трека звучит в динамиках в момент записи.
   * Ищем только рядом с текущей позицией; если рисунок повторяется (вступление из одного такта),
   * выбираем задержку, ближайшую к прошлой. Не узнали трек — берём прошлую задержку.
   */
  async function measureLatency(tid, a, dev = '') {
    const tl = sampleClock(() => [a.currentTime, !a.paused && a.readyState >= 3]);
    const t0 = a.currentTime;
    let r;
    try {
      r = await window.zvuk.sync.measure(tid, CAPTURE_S, Math.max(0, t0 - 2.5), t0 + 1.5);
    } catch (e) {
      tl.stop();
      console.warn(`SELFTEST clipsync latency: ${(e && e.message) || e} → прошлая ${lastLat()}`);
      return lastLat();
    }
    const points = tl.stop();
    const end = r.endMs || r.startMs + CAPTURE_S * 1000;
    const observed = points.filter((p) => p[0] >= r.startMs && p[0] <= end);
    const good = observed.filter((p) => p[1][1]);
    const clock = fitInfo(good.map((p) => [p[0], p[1][0]]), r.startMs);
    if (!clock || good.length < 8 || good.length < observed.length * 0.9 || clock.error > 0.08) {
      console.warn(`SELFTEST clipsync latency: нестабильные часы ${good.length}/${observed.length} — сохраняю прошлую задержку`);
      return lastLat();
    }
    const base = clock.value;
    const cands = (r.cands && r.cands.length ? r.cands : [{ pos: r.pos, score: r.score }])
      .filter((c) => c.score >= 0.4)
      .map((c) => ({ lat: base - c.pos, score: c.score }))
      .filter((c) => c.lat > -0.2 && c.lat < 1.5);
    const prev = lastLat();
    console.warn(`SELFTEST clipsync latency: ` + cands.map((c) => `${(c.lat * 1000).toFixed(0)}ms:${c.score.toFixed(2)}`).join(' ') + ` prev=${prev}`);
    if (!cands.length) return prev;
    let best = cands[0];
    if (cands.length > 1 && cands[0].score - cands[1].score < 0.08) {
      const want = prev != null ? prev : 0.1;
      best = cands.slice().sort((x, y) => Math.abs(x.lat - want) - Math.abs(y.lat - want))[0];
    }
    App.settings.clipLat = { v: Math.round(best.lat * 1000) / 1000, dev, at: Date.now() };
    window.zvuk.settings.set({ clipLat: App.settings.clipLat });
    return best.lat;
  }

  /** Сначала текущий пригодный фрагмент, затем разнесённые точки; план не превышает трёх замеров. */
  function shotPlan(T, D, tNow, off) {
    const plan = [];
    if (tNow > INTRO_S && (!T || tNow < T - 12)) plan.push(null);
    const lo = Math.max(0, D - T);
    const hi = Math.min(D, T);
    let pts = [];
    if (D > 0 && T > 0 && hi - lo >= 30) pts = [0.3, 0.7, 0.5].map((f) => lo + f * (hi - lo));
    else if (D > 0) pts = [0.4, 0.62, 0.78].map((f) => f * D);
    else if (T > 0) pts = [0.4, 0.65, 0.8].map((f) => f * T + off);
    const cur = tNow * Clip.rate + off;
    for (const p of pts) if (plan.length < 3 && !(plan[0] === null && Math.abs(p - cur) < 8)) plan.push(Math.max(0, p));
    return plan;
  }

  /** Быстрое подтверждение новой позиции; длительный запасной таймаут не блокирует обычный случай. */
  async function seekClip(m, at, still) {
    jumpClip(m, at, 'calibration');
    for (let i = 0; i < 70; i++) {
      await sleep(70);
      if (!still()) return null;
      if (m.state !== 1 && m.state !== 3) cmd(m, 'playVideo');
      const h = (m.hist || []).filter((p) => p[0] > m.seekWall + 100 && p[1] > at - 1 && p[1] < at + 10);
      if (m.state === 1 && h.length >= 2) {
        await sleep(140);
        return h[0][0];
      }
    }
    const h = m.hist || [];
    console.warn(`SELFTEST clipsync seek stuck: state=${m.state} last=${h.length ? h[h.length - 1][1].toFixed(2) + '@' + (h[h.length - 1][0] - m.seekWall).toFixed(0) + 'ms' : '-'}`);
    return null;
  }

  function resetMount(m) {
    if (m.driftFilter) m.driftFilter.reset();
    clearTimeout(m.corrTimer);
    clearTimeout(m.rateTimer);
    m.corrUntil = 0;
    m.trackAt = 0;
    m.trackTime = null;
    m.stableSince = wallNow() + 600;
  }
  function resetMounts() {
    for (const m of mounts) resetMount(m);
  }
  function setRate(m, r) {
    if (!isFinite(r) || r < 0.9 || r > 1.1 || (m.rateWant || 1) === r) return;
    m.rateWant = r;
    m.rateAck = false;
    m.rateChangedAt = performance.now();
    m.stableSince = wallNow() + 600;
    if (m.driftFilter) m.driftFilter.reset();
    cmd(m, 'setPlaybackRate', [r]);
  }
  /** Линейная оценка по последним сообщениям, а не среднее шумных мгновенных значений. */
  function clipNow(m) {
    const rate = m.rateWant || 1;
    if (m.state !== 1) return m.time;
    const now = wallNow();
    const hist = m.hist || [];
    m.clockFresh = hist.length ? hist[hist.length - 1][0] : 0;
    const pts = hist.filter((p) => p[0] > now - 1600 && p[0] > (m.stableSince || 0));
    const fit = fitInfo(pts, now, rate);
    if (fit && fit.n >= 2) {
      m.clockError = fit.error;
      return fit.value;
    }
    m.clockError = 0.1;
    return m.time + (rate * (performance.now() - m.timeAt)) / 1000;
  }

  // сеть вернулась — перезапускаем то, что не загрузилось
  window.addEventListener('online', () => {
    for (const m of mounts) if (!m.everPlayed) m.videoId = null;
    Clip._applyVideo();
    if (Clip.status === 'error' && mounts.size) Clip.resolve();
  });

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
      if (Clip._dbg % 15 === 1 || d.event === 'zgChrome' || d.event === 'onStateChange' || d.event === 'onError' || (d.info && typeof d.info === 'object' && typeof d.info.playerState === 'number')) {
        const i = d.info && typeof d.info === 'object' ? d.info : {};
        console.warn(`YT #${Clip._dbg} ${d.event} mount=${Boolean(m)} mounts=${mounts.size} t=${i.currentTime != null ? i.currentTime.toFixed(2) : '-'} st=${i.playerState ?? (typeof d.info === 'number' ? d.info : '-')} vol=${i.volume ?? '-'} muted=${i.muted ?? '-'}`);
      }
    }
    if (!m) return;
    // наш стиль внутри плеера на месте: значки YouTube спрятаны
    if (d.event === 'zgChrome') {
      m.chromeOff = true;
      return;
    }
    if (d.event === 'onReady' || d.event === 'initialDelivery') {
      if (!m.ready) {
        m.ready = true;
        m.readyAt = performance.now();
        cmd(m, 'mute');
        noCaptions(m);
        if (!Player.audio.paused) cmd(m, 'playVideo');
      }
      applyQuality(m);
      scheduleQuality(m);
    }
    if (d.event === 'onError') {
      Clip.status = 'error';
      Clip.message = `YouTube не даёт показать этот ролик (код ${d.info}). Попробуйте «Другой».`;
      Clip._emit();
    }
    const info = d.info;
    if (info && typeof info === 'object') {
      if (typeof info.playbackRate === 'number') {
        m.rate = info.playbackRate;
        if (Math.abs(info.playbackRate - (m.rateWant || 1)) < 0.006) {
          m.rateAck = true;
          if (Math.abs(info.playbackRate - 0.95) < 0.006 || Math.abs(info.playbackRate - 1.05) < 0.006) m.fineRate = true;
        }
      }
      if (Array.isArray(info.availablePlaybackRates) && info.availablePlaybackRates.includes(0.95) && info.availablePlaybackRates.includes(1.05)) m.fineRate = true;
      if (typeof info.muted === 'boolean') m.muted = info.muted;
      if (typeof info.volume === 'number') m.volume = info.volume;
      if (typeof info.currentTime === 'number') {
        m.time = info.currentTime;
        m.timeAt = performance.now();
        if (m.seekTarget != null && !m.seekAckAt && Math.abs(info.currentTime - m.seekTarget) < 1.5) {
          m.seekAckAt = m.timeAt;
          m.seekLatencyMs = Math.max(0, Math.round(m.seekAckAt - m.seekSentAt));
        }
        const h = m.hist || (m.hist = []);
        h.push([wallNow(), info.currentTime]);
        while (h.length && h[0][0] < h[h.length - 1][0] - 10000) h.shift();
      }
      if (typeof info.playerState === 'number') {
        if (info.playerState === 1 && m.state !== 1) {
          m.playSince = performance.now();
          m.everPlayed = true;
          m.stableSince = wallNow() + 650;
          m.driftFilter.reset();
          m.qualityRetries = 0;
          applyQuality(m, true);
          scheduleQuality(m);
        } else if (info.playerState !== 1) {
          m.box.classList.remove('clip-on');
          m.driftFilter.reset();
        }
        m.state = info.playerState;
      }
      if (typeof info.duration === 'number' && info.duration > 0) m.dur = info.duration;
      if (Array.isArray(info.availableQualityLevels)) m.qualityLevels = info.availableQualityLevels.slice();
      if (typeof info.playbackQuality === 'string' && QNAME[info.playbackQuality]) {
        m.quality = info.playbackQuality;
        m.qualityMatched = Boolean(QUALITY[Clip.quality] && m.quality === QUALITY[Clip.quality]);
        if (m.qualityMatched) {
          clearTimeout(m.qualityTimer);
          m.qualityTimer = 0;
        }
        if (QNAME[info.playbackQuality] !== Clip.actualQuality) {
          Clip.actualQuality = QNAME[info.playbackQuality];
          if (window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot) console.warn(`YT quality ${info.playbackQuality} wanted=${m.qualityWanted} available=${JSON.stringify(m.qualityLevels || [])}`);
          Clip._emit();
        }
      }
    }
  });

  // ---------- Синхронизация с треком ----------
  /** Точное удержание: медиана, гистерезис и только подтверждённые коррекции. */
  function holdTight(m, drift, exp) {
    const now = performance.now();
    const wall = wallNow();
    const valid = wall > (m.stableSince || 0) && wall - (m.clockFresh || 0) < 1800 && m.clockError <= 0.075 && !(m.corrUntil && now < m.corrUntil);
    if (valid) {
      const history = m.history || (m.history = []);
      history.push({
        at: Math.round(wall), trackTime: Player.audio.currentTime, clipTime: exp + drift,
        offset: Clip.offset, drift, confidence: Math.max(0, 1 - (m.clockError || 0) / 0.1), state: Clip.syncMode,
      });
      if (history.length > 120) history.splice(0, history.length - 120);
    }
    const measured = m.driftFilter.push(drift, wall, valid);
    if (!measured) return;
    const action = ClipSync.correction(measured.drift, { fineRate: Boolean(m.fineRate && !m.rateBlocked) });
    if (action.kind === 'none' || now - m.lastSeek < 3000) return;
    m.corrections = (m.corrections || 0) + 1;
    if (action.kind === 'seek') {
      clearTimeout(m.corrTimer);
      clearTimeout(m.rateTimer);
      setRate(m, Clip.rate);
      jumpClip(m, exp, 'drift');
      m.stableSince = wall + 900;
      m.corrUntil = now + 1800;
    } else {
      setRate(m, action.rate);
      clearTimeout(m.rateTimer);
      m.rateTimer = setTimeout(() => {
        // Если YouTube не подтвердил микроскорость, откатываем её и дальше используем только seek.
        if (m.rateWant === action.rate && (!isFinite(m.rate) || Math.abs(m.rate - action.rate) > 0.006)) {
          m.fineRate = false;
          m.rateBlocked = true;
          setRate(m, Clip.rate);
          m.corrUntil = performance.now() + 1200;
        }
      }, 800);
      clearTimeout(m.corrTimer);
      m.corrTimer = setTimeout(() => setRate(m, Clip.rate), action.ms);
      m.corrUntil = now + action.ms + 1100;
    }
    if (window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot) {
      console.warn(`HOLD median=${(measured.drift * 1000).toFixed(0)}ms mad=${(measured.deviation * 1000).toFixed(0)}ms action=${action.kind} rate=${m.rateWant} n=${measured.samples}`);
    }
    m.driftFilter.reset();
  }

  function autoCalibrationDue(m, now = performance.now()) {
    const key = Clip.trackId + '|' + Clip.videoId;
    return Clip.auto && !Clip.autoInfo && !Clip._cal && m.state === 1 && Clip.status === 'ok' &&
      Clip._wantTrack === Clip.trackId && Clip._calKey !== key && now - (m.lastSeek || 0) > 1500;
  }

  // Служебная диагностика: ограниченная история без ежекадрового обновления DOM.
  Clip._readyForTest = () => [...mounts].some((x) => x.iframe && x.ready && x.box.isConnected);
  Clip._calibrationDueForTest = (m, now) => autoCalibrationDue(m, now);
  Clip._driftForTest = () => {
    const m = [...mounts].find((x) => x.ready && x.time != null);
    if (!m || (m.corrUntil && performance.now() < m.corrUntil)) return NaN;
    return clipNow(m) - (Player.audio.currentTime * Clip.rate + Clip.offset);
  };
  Clip._diagForTest = () => ({
    mode: Clip.syncMode,
    rate: Clip.rate,
    syncState: Clip.sync.state,
    calibration: Clip._lastCalibration || Clip.autoInfo,
    latencyHint: Clip._latencyHint(),
    mounts: [...mounts].map((m) => ({
      ready: m.ready, state: m.state, corrections: m.corrections || 0,
      filterSamples: m.driftFilter.samples.length, lastSeek: m.lastSeek || 0, stableSince: m.stableSince || 0,
      seekKind: m.seekKind || '', seekTarget: m.seekTarget ?? null, seekLatencyMs: m.seekLatencyMs ?? null,
      qualityWanted: m.qualityWanted || 'auto', quality: m.quality || '', qualityMatched: Boolean(m.qualityMatched), qualityRequests: m.qualityRequests || 0,
      qualityLevels: (m.qualityLevels || []).slice(),
      fineRate: Boolean(m.fineRate), rateBlocked: Boolean(m.rateBlocked),
      history: (m.history || []).slice(), ...ClipSync.summarize(m.history || []),
    })),
  });

  let syncTimer = 0;
  let tick = 0;
  function startSync() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      for (const m of [...mounts]) {
        if (!m.box.isConnected) {
          mounts.delete(m);
          m.ro.disconnect();
          clearTimeout(m.corrTimer);
          clearTimeout(m.qualityTimer);
          if (m.iframe) m.iframe.remove();
        }
      }
      if (!mounts.size) {
        clearInterval(syncTimer);
        syncTimer = 0;
        return;
      }
      tick++;
      const tight = Clip.syncMode === 'auto' && !Clip._cal && Boolean(Clip.autoInfo);
      if (!tight && !Clip._cal && tick % 4) return;
      const a = Player.audio;
      const playing = !a.paused && !(Clip.hidden && !Clip._cal);
      const holdPaused = a.paused && Clip.pref('clipKeepPaused') && !Clip.hidden && !Clip._cal;
      const exp = a.currentTime * Clip.rate + Clip.offset;
      for (const m of mounts) {
        if (!m.iframe) continue;
        const dur = (Clip.info && Clip.info.dur) || m.dur;
        const outside = !Clip._cal && (exp < 0 || (dur && exp > dur - 0.4));
        const stuck = !m.ready || (!m.everPlayed && playing && !outside);
        if (stuck && !Clip._cal && (m.reloads || 0) < 5 && performance.now() - m.created > 12000 + 6000 * (m.reloads || 0)) {
          m.reloads = (m.reloads || 0) + 1;
          console.warn(`clip: плеер не пошёл (ready=${m.ready} state=${m.state}) — перезагрузка ${m.reloads}`);
          m.videoId = null;
          Clip._applyVideo();
          continue;
        }
        if (!m.ready) continue;
        if (outside) {
          if (m.state === 1) cmd(m, 'pauseVideo');
          m.box.classList.remove('clip-on');
          m.driftFilter.reset();
          continue;
        }
        if (playing && m.state !== 1 && m.state !== 3) cmd(m, 'playVideo');
        if (!playing && m.state === 1) cmd(m, 'pauseVideo');
        const wasOn = m.box.classList.contains('clip-on');
        const settled = performance.now() - (m.playSince || 0) > (m.chromeOff ? YT_CHROME_HIDDEN_MS : YT_CHROME_MS);
        const on = m.state === 1 && playing && settled;
        const keepPaused = holdPaused && settled && m.state !== 0 && m.state !== 3;
        m.box.classList.toggle('clip-on', on || keepPaused);
        if (on && !wasOn && Player.current) queueMicrotask(() => ClipOffer.check(Player.current));
        if (tick % 50 === 0) noCaptions(m);
        if (Clip._cal || m.time == null) continue;

        const now = performance.now();
        const wall = wallNow();
        const advancing = playing && !a.seeking && a.readyState >= 3;
        const expectedTrack = m.trackAt ? m.trackTime + (wall - m.trackAt) / 1000 : a.currentTime;
        const trackJump = advancing && m.trackAt && Math.abs(a.currentTime - expectedTrack) > 0.35;
        if (m.transport !== advancing || trackJump) {
          resetMount(m);
          // Событие Player.seek срабатывает сразу; это резерв для системной перемотки без него.
          if (trackJump && m.state === 1) jumpClip(m, exp, 'track-fallback');
        }
        m.transport = advancing;
        m.trackAt = wall;
        m.trackTime = a.currentTime;
        if (Clip.auto && m.rateWant !== Clip.rate && !(m.corrUntil && now < m.corrUntil)) setRate(m, Clip.rate);

        const rate = m.rateWant || 1;
        const vt = tight ? clipNow(m) : m.time + (m.state === 1 ? (rate * (now - m.timeAt)) / 1000 : 0);
        const drift = vt - exp;
        if (tight && advancing && m.state === 1) holdTight(m, drift, exp);
        else {
          m.driftFilter.reset();
          if (m.rateWant && m.rateWant !== Clip.rate) setRate(m, Clip.rate);
          if (Clip.syncMode !== 'locked' && advancing && m.state === 1 && Math.abs(drift) > 0.9 && now - m.lastSeek > 2500) jumpClip(m, exp, 'drift');
        }
        if (advancing && autoCalibrationDue(m, now)) Clip.calibrate();
      }
    }, 100);
  }

  // ---------- Предложение подстройки уже включённого клипа ----------
  const trackInfo = (t) => ({ id: String(t.id), title: t.title, artists: (t.artists || []).map((a) => a.title), duration: t.duration });

  const ClipOffer = {
    dismissed: new Set(), // треки, для которых предложение подстройки уже закрыли (до перезапуска приложения)
    el: null,
    timer: 0,
    life: 0,

    /** Предлагаем только в окне «Сейчас играет». Выключенный клип не ищем и не предлагаем включать. */
    get enabled() {
      return !window.ZG_MOBILE && (this._force || !(window.__ZG_ARGS__ && window.__ZG_ARGS__.screenshot)) && window.NP && NP.isOpen;
    },
    npOpened() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.enabled && Player.current && this.check(Player.current), 350);
    },
    trackChanged(t) {
      this.hide();
      clearTimeout(this.timer);
      if (t && this.enabled) this.timer = setTimeout(() => this.check(t), 300);
    },

    clipVisible() {
      return [...mounts].reverse().some((m) => m.box.isConnected && m.iframe && m.ready && m.state === 1 && m.videoId === Clip.videoId && m.box.classList.contains('clip-on'));
    },

    async check(t) {
      if (!this.enabled || Player.current !== t || Clip._cal || this.el) return;
      const need = await this.need(t);
      // Подстройку предлагаем только для включённого и уже видимого клипа.
      if (!need?.sync || !this.enabled || Player.current !== t || !this.clipVisible()) return;
      if (!this.dismissed.has(String(t.id) + ':sync')) this.show(t, need);
    },

    /** Поиск только в кэше и только при видимом клипе; в остальных режимах сетевых запросов нет. */
    async need(t) {
      const v = App.settings.viz || {};
      if (v.bg !== 'clip' || !this.clipVisible()) return null;
      const id = String(t.id);
      let entry = Clip.trackId === id && Clip.entry ? Clip.entry : null;
      if (!entry) {
        const r = await window.zvuk.yt.find(trackInfo(t), false, true);
        entry = r.ok ? r.data : null;
      }
      if (!entry) return null;
      let vid = null;
      if (!entry.uncached) {
        vid = entry.manual || (entry.pick != null && entry.cands && entry.cands[entry.pick] ? entry.cands[entry.pick].id : null);
        if (!vid) return null;
      } else {
        const st = await window.zvuk.yt.state().catch(() => null);
        if (!st || !st.hasKey) return null;
      }
      const synced = Boolean(vid && entry.auto && entry.auto.ver === ClipSync.VERSION && (entry.auto.locked || entry.auto.captureMs !== 3000) && entry.auto.vid === vid && typeof entry.auto.offset === 'number');
      return { sync: !synced, visible: true };
    },

    show(t, need) {
      if (!need.sync || App.settings.viz?.bg !== 'clip' || !this.clipVisible()) return;
      this.hide(true);
      const id = String(t.id);
      const dismissKey = id + ':sync';
      const items = [['sparkle', 'Подстроить клип по звуку', `Несколько секунд звук пойдёт из клипа; ${Clip.pref('clipRestart') ? 'затем трек начнётся сначала' : 'текущая позиция сохранится'}`]];
      const el = document.createElement('div');
      el.className = 'clip-offer glass-menu';
      el.setAttribute('role', 'dialog');
      el.innerHTML = `<div class="co-head">
          <span class="co-mark">${icon('video')}</span>
          <div class="co-tt"><b>Подстроить клип?</b><span>${esc(t.title)}</span></div>
          <button class="icon-btn" data-co="close" title="Закрыть">${icon('close')}</button>
        </div>
        <div class="co-list">${items.map(([ic, b, p]) => `<div class="co-item"><span class="co-ic">${icon(ic)}</span><div><b>${b}</b><p>${p}</p></div></div>`).join('')}</div>
        <div class="co-foot">
          <button class="btn small" data-co="close">Не сейчас</button>
          <button class="btn small primary" data-co="ok">Подстроить</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-co]');
        if (!b) return;
        this.dismissed.add(dismissKey);
        this.hide();
        if (b.dataset.co === 'ok') this.accept(t, need);
      });
      // сама уходит через 25 секунд (пока над ней мышь — ждёт)
      const arm = () => {
        clearTimeout(this.life);
        this.life = setTimeout(() => {
          this.dismissed.add(dismissKey);
          this.hide();
        }, 25000);
      };
      el.addEventListener('mouseenter', () => clearTimeout(this.life));
      el.addEventListener('mouseleave', arm);
      arm();
      document.body.appendChild(el);
      this.el = el;
    },

    hide(now = false) {
      clearTimeout(this.life);
      const el = this.el;
      this.el = null;
      if (!el) return;
      if (now) return el.remove();
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    },

    /** «Да»: подстраиваем уже включённый клип, не меняя выбранный пользователем фон. */
    accept(t, need) {
      const id = String(t.id);
      // Пока карточка была на экране, клип мог скрыться, выключиться или смениться.
      if (!need.sync || App.settings.viz?.bg !== 'clip' || !this.clipVisible() || Player.current !== t) return;
      Clip.requestSync(id);
      if (!(App.route && App.route.view === 'visualizer')) {
        if (!NP.vizOn) NP.toggleViz();
        if (!NP.isOpen) App.openNowPlaying();
      }
      // клип не нашёлся — говорим сразу, а не молча показываем обложку
      const off = Clip.onChange(() => {
        if (Clip.trackId !== id || Clip.status === 'loading' || Clip.status === 'idle') return;
        off();
        if (Clip.status === 'none') toast('Официальный клип для этого трека не нашёлся — можно вставить ссылку в настройках визуализатора', { error: true, ms: 4200 });
        else if (Clip.status === 'nokey') toast('Для поиска клипов нужен ключ YouTube — его можно добавить в настройках', { error: true, ms: 4200 });
      });
      setTimeout(off, 20000);
    },
  };

  window.Clip = Clip;
  window.ClipOffer = ClipOffer;
})();
