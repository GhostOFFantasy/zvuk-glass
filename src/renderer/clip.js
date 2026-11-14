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
  const YT_CHROME_HIDDEN_MS = 250;
  // Запас вперёд при запуске клипа (секунды): столько примерно занимает загрузка плеера
  const START_LEAD = 1.5;
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
    /** Человек согласился подстроить клип этого трека (уведомление или переключатель): подстройка начнётся, когда клип пойдёт. */
    requestSync(trackId) {
      if (!this.auto) this.setAuto(true);
      prepareTrack(trackId); // пока грузится клип, трек для сравнения уже скачивается
      this._wantTrack = String(trackId);
      this._calKey = '';
      this._calTries = 0;
      this.sync = { state: 'idle', message: '' };
      this._emit();
    },
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
     * Измерение сдвига по звуку (5–10 секунд; на новом устройстве вывода — на 4 секунды дольше):
     * 1) пишем звук приложения, пока играет трек, — узнаём задержку всего звукового тракта;
     * 2) глушим трек и включаем звук клипа — узнаём, какое место песни звучит в клипе в его текущий момент.
     * Задержки тракта одинаковы для обоих звуков и сокращаются.
     * Во вступлении (тихо, один и тот же аккорд) и в повторах припева одного замера мало: тогда клип
     * перематывается в середину песни и замер повторяется — сдвиг принимается, когда два замера сходятся.
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
      const key = tid + '|' + vid;
      if (this._calKey !== key) this._calTries = 0;
      this._calKey = key;
      this._calTries = (this._calTries || 0) + 1;
      this._wantTrack = tid; // запуск вручную — тоже согласие (для повторных попыток)
      this._cal = true;
      const began = performance.now();
      const still = () => this.trackId === tid && this.videoId === vid && this.auto && !a.paused;
      const restore = () => {
        cmd(m, 'mute');
        noCaptions(m);
        AudioFX.duck(false);
      };
      try {
        set('run', 'Готовим трек для сравнения…');
        setRate(m, 1);
        const prep = await prepareTrack(tid);
        if (!still()) throw new Error('cancel');
        const T = (prep && prep.duration) || a.duration || 0;

        set('run', 'Слушаем трек… (1 из 2)');
        cmd(m, 'mute');
        const lat = await getLatency(tid, a); // задержка тракта для трека
        if (!still()) throw new Error('cancel');
        if (lat == null) throw new Error('Не удалось узнать трек в звуке приложения — попробуйте ещё раз');

        set('run', 'Слушаем клип… (2 из 2) — несколько секунд звук идёт из клипа');
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

        // замеры клипа: сначала там, где он идёт сейчас (если трек уже не во вступлении), потом в середине песни
        const D = (this.info && this.info.dur) || m.dur || 0;
        const plan = this._testPlan ? this._testPlan.slice() : shotPlan(T, D, a.currentTime, this.offset);
        const shots = [];
        let found = null;
        let silent = 0;
        let noTime = 0;
        for (let k = 0; k < plan.length && !found; k++) {
          let from = (m.seekWall || 0) + 600; // время клипа до последней перемотки не годится
          if (plan[k] != null) {
            set('run', `Слушаем клип в другом месте песни… (${k + 1} из ${plan.length})`);
            const t = await seekClip(m, plan[k], still);
            if (!still()) throw new Error('cancel');
            if (t == null) {
              console.warn(`SELFTEST clipsync shot ${k}: клип не пошёл после перемотки на ${plan[k].toFixed(1)}`);
              continue;
            }
            from = t;
          }
          let r;
          try {
            r = await window.zvuk.sync.measure(tid, 4, 0, 1e6);
          } catch (e) {
            if (!still()) throw new Error('cancel');
            if (e && e.code === 'SILENT') silent++;
            console.warn(`SELFTEST clipsync shot ${k}: ${(e && e.message) || e}`);
            continue;
          }
          if (!still()) throw new Error('cancel');
          const pts = (m.hist || []).filter((p) => p[0] > Math.max(r.startMs - 4000, from) && p[0] < r.startMs + 7000);
          const v = pts.length >= 2 ? fitAt(pts, r.startMs) : null;
          if (v == null) {
            noTime++;
            const h = m.hist || [];
            console.warn(`SELFTEST clipsync nohist: hist=${h.length} first=${h.length ? (h[0][0] - r.startMs).toFixed(0) : '-'} last=${h.length ? (h[h.length - 1][0] - r.startMs).toFixed(0) : '-'} now=${(wallNow() - r.startMs).toFixed(0)}`);
            continue;
          }
          const cands = (r.cands && r.cands.length ? r.cands : [{ pos: r.pos, score: r.score }]).map((c) => ({ off: v - c.pos - lat, score: c.score }));
          shots.push({ v, score: r.score, second: r.second, cands });
          console.warn(`SELFTEST clipsync shot ${k}: v=${v.toFixed(2)} pts=${pts.length} ` + cands.map((c) => `${c.off.toFixed(3)}:${c.score.toFixed(2)}`).join(' '));
          found = decide(shots, k === plan.length - 1);
        }
        // последние перемотки могли не получиться — тогда последним был более ранний замер
        if (!found && shots.length) found = decide(shots, true);
        restore();
        if (!still()) throw new Error('cancel');
        if (!found) {
          if (!shots.length && noTime) throw new Error('YouTube не сообщил время клипа — попробуйте ещё раз');
          if (!shots.length && silent) throw new Error('Звук клипа не слышен — проверьте, что YouTube не заглушён');
          throw new Error('Звук клипа не совпал с треком — возможно, в клипе другая версия песни или мешали другие звуки на компьютере');
        }
        const offset = Math.round(found.offset * 1000) / 1000;
        if (!isFinite(offset) || Math.abs(offset) > 900) throw new Error('Получился странный сдвиг — попробуйте ещё раз');
        await this._update({ auto: { vid, offset, score: Math.round(found.score * 100) / 100, lat: Math.round(lat * 1000), at: Date.now() } });
        for (const x of mounts) x.lastSeek = 0;
        console.warn(`SELFTEST clipsync: offset=${offset} lat=${(lat * 1000).toFixed(0)}ms by=${found.by} score=${found.score.toFixed(2)} shots=${shots.length} took=${((performance.now() - began) / 1000).toFixed(1)}s`);
        set('done');
        // во время замера звучал клип (иногда из середины песни) — включаем трек сначала, чтобы песня прозвучала целиком
        if (still()) {
          Player.seek(0);
          toast('Клип подстроен — трек играет сначала', { iconName: 'check', ms: 2600 });
        }
      } catch (e) {
        restore();
        const msg = (e && e.message) || String(e);
        if (msg === 'cancel') set('idle');
        else {
          console.warn(`SELFTEST clipsync fail: ${msg}`);
          // при автоподстройке пробуем ещё раз позже — в другом месте песни (всего до трёх попыток)
          set('fail', !this.autoInfo && this._calTries < 3 ? msg + '. Попробую ещё раз через полминуты' : msg);
        }
      } finally {
        this._cal = false;
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
        if (m.reloadFor !== id) {
          m.reloadFor = id;
          m.reloads = 0;
        }
        m.videoId = id;
        m.ready = false;
        m.state = -1;
        m.time = null;
        m.everPlayed = false;
        m.chromeOff = false;
        m.created = performance.now();
        m.box.classList.remove('clip-on');
        if (m.iframe) m.iframe.remove();
        m.iframe = null;
        if (!id) continue;
        // с небольшим запасом вперёд: пока плеер грузится, трек успевает уйти — клип стартует почти в такт, без лишней перемотки
        const start = Math.max(0, Math.round(Player.audio.currentTime + this.offset + (Player.audio.paused ? 0 : START_LEAD)));
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

  /** Перемотка клипа. После неё YouTube на несколько секунд показывает свою кнопку паузы — клип прячем, пока она не уйдёт. */
  function seekVideo(m, t) {
    cmd(m, 'seekTo', [t, true]);
    m.playSince = performance.now();
    m.box.classList.remove('clip-on');
  }

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
    const tl = sampleClock(() => a.currentTime);
    const t0 = a.currentTime;
    let r;
    try {
      r = await window.zvuk.sync.measure(tid, 4, Math.max(0, t0 - 2.5), t0 + 1.5);
    } catch (e) {
      tl.stop();
      console.warn(`SELFTEST clipsync latency: ${(e && e.message) || e} → прошлая ${lastLat()}`);
      return lastLat();
    }
    tl.stop();
    const base = fitAt(tl.points, r.startMs);
    const cands = (r.cands && r.cands.length ? r.cands : [{ pos: r.pos, score: r.score }])
      .filter((c) => c.score >= 0.4)
      .map((c) => ({ lat: base - c.pos, score: c.score }))
      .filter((c) => c.lat > -0.2 && c.lat < 1.5);
    const prev = lastLat();
    console.warn(`SELFTEST clipsync latency: ` + cands.map((c) => `${(c.lat * 1000).toFixed(0)}ms:${c.score.toFixed(2)}`).join(' ') + ` prev=${prev}`);
    if (!cands.length) return prev;
    let best = cands[0];
    if (cands.length > 1 && cands[0].score - cands[1].score < 0.08) {
      const want = prev != null ? prev : 0.1; // обычно задержка — десятки миллисекунд
      best = cands.slice().sort((x, y) => Math.abs(x.lat - want) - Math.abs(y.lat - want))[0];
    }
    App.settings.clipLat = { v: Math.round(best.lat * 1000) / 1000, dev, at: Date.now() };
    window.zvuk.settings.set({ clipLat: App.settings.clipLat });
    return best.lat;
  }

  /**
   * Где слушать клип (секунды клипа; null — там, где он идёт сейчас, без перемотки).
   * Вступление трека и его последние секунды пропускаем. Если клип длиннее трека (сюжетное начало
   * или концовка), песня в любом случае звучит в отрезке [D − T, T] клипа — берём точки внутри него.
   */
  function shotPlan(T, D, tNow, off) {
    const plan = [];
    if (tNow > INTRO_S && (!T || tNow < T - 12)) plan.push(null);
    const lo = Math.max(0, D - T);
    const hi = Math.min(D, T);
    let pts = [];
    if (D > 0 && T > 0 && hi - lo >= 30) pts = [0.3, 0.7, 0.5].map((f) => lo + f * (hi - lo));
    else if (D > 0) pts = [0.4, 0.62, 0.78].map((f) => f * D);
    else if (T > 0) pts = [0.4, 0.65, 0.8].map((f) => f * T + off);
    // не слушать там, где клип и так идёт сейчас
    const cur = tNow + off;
    for (const p of pts) if (plan.length < 3 && !(plan[0] === null && Math.abs(p - cur) < 8)) plan.push(Math.max(0, p));
    return plan;
  }

  /** Перемотать клип и дождаться, когда он пойдёт с нового места. → момент (мс), с которого его время верно, или null. */
  async function seekClip(m, at, still) {
    seekVideo(m, at);
    m.seekWall = wallNow();
    m.lastSeek = performance.now();
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (!still()) return null;
      if (m.state !== 1 && m.state !== 3) cmd(m, 'playVideo');
      const h = (m.hist || []).filter((p) => p[0] > m.seekWall + 250 && p[1] > at - 1 && p[1] < at + 10);
      if (m.state === 1 && h.length >= 2) {
        await sleep(350); // звук после перемотки появляется чуть позже картинки
        return h[0][0];
      }
    }
    const h = m.hist || [];
    console.warn(`SELFTEST clipsync seek stuck: state=${m.state} last=${h.length ? h[h.length - 1][1].toFixed(2) + '@' + (h[h.length - 1][0] - m.seekWall).toFixed(0) + 'ms' : '-'}`);
    return null;
  }

  /**
   * Решение по замерам клипа: { offset, score, by } или null (нужен ещё замер).
   * Каждый замер даёт несколько мест-кандидатов (сдвигов); верный сдвиг — тот, на котором сходятся
   * замеры из разных мест клипа. Одиночный замер принимаем, только если он однозначный.
   */
  function decide(shots, last) {
    const items = [];
    shots.forEach((s, k) => s.cands.forEach((c) => c.score >= 0.28 && items.push({ k, off: c.off, score: c.score })));
    const clusters = items
      .map((anchor) => {
        const best = new Map(); // замер → лучший кандидат рядом с anchor
        for (const it of items) if (Math.abs(it.off - anchor.off) <= 0.15 && (!best.has(it.k) || best.get(it.k).score < it.score)) best.set(it.k, it);
        const mem = [...best.values()];
        const sum = mem.reduce((s, x) => s + x.score, 0);
        return { n: mem.length, sum, offset: mem.reduce((s, x) => s + x.off * x.score, 0) / sum };
      })
      .filter((c) => c.n >= 2)
      .sort((a, b) => b.sum - a.sum);
    if (clusters.length) {
      const c = clusters[0];
      const rival = clusters.find((x) => Math.abs(x.offset - c.offset) > 0.3);
      if (c.sum >= 0.75 && (!rival || c.sum - rival.sum >= 0.15)) return { offset: c.offset, score: c.sum / c.n, by: `agree${c.n}` };
    }
    // однозначный одиночный замер (последний — проверенный порог прежних версий)
    const one = shots
      .filter((s) => s.score >= 0.45 && s.score - s.second >= 0.12)
      .concat(last ? shots.filter(matched) : [])
      .sort((a, b) => b.score - a.score)[0];
    if (one) return { offset: one.cands[0].off, score: one.score, by: 'single' };
    return null;
  }
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
      if (typeof info.playerState === 'number') {
        if (info.playerState === 1 && m.state !== 1) {
          m.playSince = performance.now();
          m.everPlayed = true;
        }
        else if (info.playerState !== 1) m.box.classList.remove('clip-on'); // пауза или подгрузка — прячем сразу
        m.state = info.playerState;
      }
      if (typeof info.duration === 'number' && info.duration > 0) m.dur = info.duration;
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
        seekVideo(m, exp + 0.12); // небольшой запас на подгрузку после перемотки
        m.lastSeek = now;
        m.seekWall = wallNow();
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
      for (const m of mounts) {
        if (!m.iframe) continue;
        const dur = (Clip.info && Clip.info.dur) || m.dur;
        // во время подстройки клип слушается в разных местах — не останавливаем его
        const outside = !Clip._cal && (exp < 0 || (dur && exp > dur - 0.4));
        // сторож: плеер YouTube не загрузился или так и не пошёл (например, сеть ещё не поднялась после
        // включения компьютера) — пересоздаём его, с растущей паузой, до пяти раз
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
          continue;
        }
        if (playing && m.state !== 1 && m.state !== 3) cmd(m, 'playVideo');
        if (!playing && m.state === 1) cmd(m, 'pauseVideo');
        // показываем клип только когда он реально идёт (нет чёрных экранов загрузки и паузы)
        // и YouTube уже убрал свою кнопку паузы, которую показывает при каждом запуске и перемотке
        m.box.classList.toggle('clip-on', m.state === 1 && playing && performance.now() - (m.playSince || 0) > (m.chromeOff ? YT_CHROME_HIDDEN_MS : YT_CHROME_MS));
        if (tick % 50 === 0) noCaptions(m); // субтитры YouTube иногда возвращаются сами
        if (Clip._cal || m.time == null) continue; // во время подстройки клип не трогаем
        // текущее время клипа: точное (среднее по сообщениям) в режиме автосинхронизации
        const rate = m.rateWant || 1;
        const vt = tight ? clipNow(m) : m.time + (m.state === 1 ? (rate * (performance.now() - m.timeAt)) / 1000 : 0);
        const drift = vt - exp;
        if (tight && playing && m.state === 1) holdTight(m, drift, exp);
        else {
          if (m.rateWant && m.rateWant !== 1) setRate(m, 1);
          // пока клип ещё не пошёл, не перематываем: каждая перемотка начинает подгрузку заново
          if (m.state === 1 && Math.abs(drift) > 0.9 && performance.now() - m.lastSeek > 2500) {
            seekVideo(m, exp);
            m.lastSeek = performance.now();
            m.seekWall = wallNow();
          }
        }
        // подстройка, на которую согласились (уведомление, переключатель), — запускаем, когда клип пошёл;
        // не получилось — ещё две попытки через полминуты (в другом месте песни)
        if (Clip.auto && !Clip.autoInfo && playing && m.state === 1 && Clip.status === 'ok' && Clip._wantTrack === Clip.trackId) {
          const key = Clip.trackId + '|' + Clip.videoId;
          const retry = Clip._calKey === key && Clip.sync.state === 'fail' && (Clip._calTries || 0) < 3 && performance.now() - (Clip._calEnd || 0) > 30000;
          if ((Clip._calKey !== key || retry) && performance.now() - m.lastSeek > 2500) Clip.calibrate();
        }
      }
    }, 100);
  }

  // ---------- Предложение включить клип и подстройку (карточка справа сверху) ----------
  const trackInfo = (t) => ({ id: String(t.id), title: t.title, artists: (t.artists || []).map((a) => a.title), duration: t.duration });

  const ClipOffer = {
    dismissed: new Set(), // треки, для которых карточку уже показали и закрыли (до перезапуска приложения)
    el: null,
    timer: 0,
    life: 0,

    /** Предлагаем только в окне «Сейчас играет» (открыли по обложке трека) — сразу при открытии и при смене трека в нём. */
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

    async check(t) {
      if (!this.enabled || Player.current !== t || Clip._cal || this.dismissed.has(String(t.id)) || this.el) return;
      const need = await this.need(t);
      if (need && this.enabled && Player.current === t && (need.clip || need.sync)) this.show(t, need);
    },

    /**
     * Что предложить: { clip — включить клип на фоне, sync — подстроить по звуку } или null.
     * Клип ищем только в кэше: искать на YouTube для каждого трека — тратить квоту ключа.
     */
    async need(t) {
      const id = String(t.id);
      const v = App.settings.viz || {};
      let entry = Clip.trackId === id && Clip.entry ? Clip.entry : null;
      if (!entry) {
        const r = await window.zvuk.yt.find(trackInfo(t), false, true);
        entry = r.ok ? r.data : null;
      }
      if (!entry) return null;
      let vid = null;
      if (!entry.uncached) {
        vid = entry.manual || (entry.pick != null && entry.cands && entry.cands[entry.pick] ? entry.cands[entry.pick].id : null);
        if (!vid) return null; // клип искали — подходящего нет
      } else {
        // ещё не искали: без ключа YouTube найти клип нельзя
        const st = await window.zvuk.yt.state().catch(() => null);
        if (!st || !st.hasKey) return null;
      }
      const synced = Boolean(vid && entry.auto && entry.auto.vid === vid && typeof entry.auto.offset === 'number');
      return { clip: v.bg !== 'clip', sync: !synced };
    },

    show(t, need) {
      this.hide(true);
      const id = String(t.id);
      const items = [];
      if (need.clip) items.push(['film', 'Показать клип на фоне', 'Официальный клип с YouTube — за визуализатором']);
      if (need.sync) items.push(['sparkle', 'Подстроить клип по звуку', '5–10 секунд: звук ненадолго пойдёт из клипа, потом трек начнётся сначала']);
      const el = document.createElement('div');
      el.className = 'clip-offer glass-menu';
      el.setAttribute('role', 'dialog');
      el.innerHTML = `<div class="co-head">
          <span class="co-mark">${icon('video')}</span>
          <div class="co-tt"><b>${need.clip ? 'Включить клип?' : 'Подстроить клип?'}</b><span>${esc(t.title)}</span></div>
          <button class="icon-btn" data-co="close" title="Закрыть">${icon('close')}</button>
        </div>
        <div class="co-list">${items.map(([ic, b, p]) => `<div class="co-item"><span class="co-ic">${icon(ic)}</span><div><b>${b}</b><p>${p}</p></div></div>`).join('')}</div>
        <div class="co-foot">
          <button class="btn small" data-co="close">Не сейчас</button>
          <button class="btn small primary" data-co="ok">${need.clip && need.sync ? 'Включить и подстроить' : need.clip ? 'Включить' : 'Подстроить'}</button>
        </div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-co]');
        if (!b) return;
        this.dismissed.add(id);
        this.hide();
        if (b.dataset.co === 'ok') this.accept(t, need);
      });
      // сама уходит через 25 секунд (пока над ней мышь — ждёт)
      const arm = () => {
        clearTimeout(this.life);
        this.life = setTimeout(() => {
          this.dismissed.add(id);
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

    /** «Да»: включаем клип на фоне и/или подстройку — и показываем клип (экран «Сейчас играет» с визуализатором). */
    accept(t, need) {
      const id = String(t.id);
      if (!App.settings.viz) App.settings.viz = {};
      const v = App.settings.viz;
      if (need.clip) {
        v.bg = 'clip';
        window.zvuk.settings.set({ viz: v });
      }
      if (need.sync) Clip.requestSync(id);
      const onViz = App.route && App.route.view === 'visualizer';
      if (onViz) {
        if (need.clip) App.rerender();
      } else {
        if (!NP.vizOn) NP.toggleViz();
        else if (need.clip && NP.isOpen) {
          // фон сменился — пересобираем сцену
          NP._unmountScene();
          NP._mountScene();
        }
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
