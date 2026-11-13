'use strict';
/* Плеер: очередь, бесконечные источники (волны, радио), медиаклавиши, сохранение состояния */
(function () {
  const audio = document.getElementById('audio');
  const STORE_KEY = 'zg.queue.v1';

  const slim = (t) =>
    t && {
      id: String(t.id), title: t.title, duration: t.duration, explicit: t.explicit, hasFlac: t.hasFlac, lyrics: t.lyrics,
      artists: (t.artists || []).map((a) => ({ id: a.id, title: a.title, image: a.image })),
      release: t.release ? { id: t.release.id, title: t.release.title, image: t.release.image } : null,
    };

  const Player = {
    audio,
    queue: [],
    index: -1,
    source: null, // { kind: 'list'|'wave'|'ewave'|'radio', title, ... }
    original: null,
    shuffle: false,
    repeat: 'off',
    quality: 'flac',
    volume: 0.8,
    muted: false,
    stream: null,
    events: new EventTarget(),
    _loadToken: 0,
    _retried: false,
    _failStreak: 0,
    _fetching: false,
    _prefetch: new Map(),
    _previewWarned: false,

    on(name, fn) {
      this.events.addEventListener(name, (e) => fn(e.detail));
    },
    emit(name, detail) {
      this.events.dispatchEvent(new CustomEvent(name, { detail }));
    },
    get current() {
      return this.queue[this.index] || null;
    },
    get playing() {
      return !audio.paused && !audio.ended;
    },
    get endless() {
      return Boolean(this.source && this.source.fetchMore);
    },

    init(settings) {
      this.quality = settings.quality || 'flac';
      this.volume = settings.volume ?? 0.8;
      this.shuffle = Boolean(settings.shuffle);
      this.repeat = settings.repeat || 'off';
      AudioFX.init(audio, settings.eq);
      AudioFX.onChange = debounce((eq) => window.zvuk.settings.set({ eq }), 300);
      this._applyVolume();

      audio.addEventListener('play', () => this._state());
      audio.addEventListener('pause', () => this._state());
      audio.addEventListener('playing', () => {
        this._failStreak = 0;
        this._state();
      });
      audio.addEventListener('waiting', () => this.emit('buffering', true));
      audio.addEventListener('canplay', () => this.emit('buffering', false));
      audio.addEventListener('timeupdate', () => this._time());
      audio.addEventListener('progress', () => this._time());
      audio.addEventListener('durationchange', () => this._time());
      audio.addEventListener('ended', () => this._ended());
      audio.addEventListener('error', () => this._error());
      this._setupMediaSession();
      setInterval(() => this.save(), 10000);
      window.addEventListener('beforeunload', () => this.save());
    },

    // ---------- Управление очередью ----------
    playList(tracks, start = 0, source = { kind: 'list', title: '' }) {
      tracks = (tracks || []).filter(Boolean);
      if (!tracks.length) return;
      this.source = source;
      this.original = null;
      if (this.shuffle && !source.fetchMore) {
        const first = tracks[start];
        const rest = shuffleArr(tracks.filter((_, i) => i !== start));
        this.original = tracks.slice();
        this.queue = [first, ...rest];
        this._load(0, true);
      } else {
        this.queue = tracks.slice();
        this._load(start, true);
      }
      this.emit('queue');
    },

    /** Загрузить без автозапуска (восстановление после перезапуска). */
    cue(tracks, index = 0, position = 0, source = null) {
      this.queue = tracks.filter(Boolean);
      this.source = source || { kind: 'list', title: '' };
      if (!this.queue.length) return;
      this._load(Math.min(index, this.queue.length - 1), false, position);
      this.emit('queue');
    },

    playAt(i) {
      if (i >= 0 && i < this.queue.length) this._load(i, true);
    },

    playNext(tracks) {
      tracks = [].concat(tracks).filter(Boolean);
      if (!this.queue.length) return this.playList(tracks, 0, { kind: 'list', title: 'Очередь' });
      this.queue.splice(this.index + 1, 0, ...tracks);
      if (this.original) this.original.push(...tracks);
      this.emit('queue');
    },

    addToQueue(tracks) {
      tracks = [].concat(tracks).filter(Boolean);
      if (!this.queue.length) return this.playList(tracks, 0, { kind: 'list', title: 'Очередь' });
      if (this.endless) {
        // В бесконечной волне «в конец» означает «после ближайших треков»
        this.queue.splice(this.index + 1, 0, ...tracks);
      } else this.queue.push(...tracks);
      if (this.original) this.original.push(...tracks);
      this.emit('queue');
    },

    removeAt(i) {
      if (i === this.index || i < 0 || i >= this.queue.length) return;
      this.queue.splice(i, 1);
      if (i < this.index) this.index--;
      this.emit('queue');
    },

    clearUpcoming() {
      this.queue.splice(this.index + 1);
      this.emit('queue');
    },

    /** Бесконечный источник: fetchMore() должен возвращать новую порцию треков. */
    async startEndless(source, initial = null) {
      this.source = source;
      this.original = null;
      this.queue = [];
      this.index = -1;
      this.emit('loading', true);
      try {
        const first = initial && initial.length ? initial : await source.fetchMore();
        if (!first || !first.length) throw new Error('Пусто');
        this.queue = this._dedupe(first);
        this._load(0, true);
        this.emit('queue');
      } catch (e) {
        toast('Не удалось запустить: ' + e.message, { error: true });
      } finally {
        this.emit('loading', false);
      }
    },

    _dedupe(list) {
      const recent = new Set(this.queue.slice(-200).map((t) => String(t.id)));
      const out = [];
      for (const t of list) {
        if (!t || recent.has(String(t.id))) continue;
        recent.add(String(t.id));
        out.push(t);
      }
      return out;
    },

    async _ensureBuffer() {
      if (!this.endless || this._fetching) return;
      if (this.queue.length - this.index > 3) return;
      this._fetching = true;
      const src = this.source;
      try {
        for (let tries = 0; tries < 3; tries++) {
          const more = this._dedupe(await src.fetchMore());
          if (src !== this.source) return;
          if (more.length) {
            this.queue.push(...more);
            this.emit('queue');
            break;
          }
        }
      } catch (e) {
        console.warn('fetchMore failed', e);
      } finally {
        this._fetching = false;
      }
    },

    // ---------- Воспроизведение ----------
    async _load(i, autoplay, startAt = 0) {
      const token = ++this._loadToken;
      this.index = i;
      this._retried = false;
      const t = this.queue[i];
      if (!t) return;
      audio.pause();
      this.emit('track', t);
      this.emit('queue');
      this._mediaMeta(t);
      let s = this._prefetch.get(t.id) || null;
      try {
        if (!s) s = await api('getStream', t.id, this.quality);
      } catch (e) {
        if (token !== this._loadToken) return;
        this._failStreak++;
        toast(`«${t.title}» недоступен: ${e.message}`, { error: true });
        if (autoplay && this._failStreak < 5 && i < this.queue.length - 1) setTimeout(() => token === this._loadToken && this._load(i + 1, true), 700);
        return;
      }
      if (token !== this._loadToken) return;
      this._prefetch.delete(t.id);
      this.stream = s;
      this.emit('stream', s);
      if (s.preview && !this._previewWarned) {
        this._previewWarned = true;
        toast('Доступны только 30-секундные превью — проверьте подписку Zvuk', { error: true, ms: 6000 });
      }
      audio.src = s.url;
      if (startAt > 0) {
        const seekOnce = () => {
          audio.currentTime = Math.min(startAt, (audio.duration || startAt + 1) - 1);
          audio.removeEventListener('loadedmetadata', seekOnce);
        };
        audio.addEventListener('loadedmetadata', seekOnce);
      }
      if (autoplay) {
        try {
          await audio.play();
        } catch (e) {
          if (e.name !== 'AbortError') console.warn(e);
        }
      } else this._state();
      this._ensureBuffer();
      setTimeout(() => token === this._loadToken && this._prefetchNext(), 8000);
    },

    async _prefetchNext() {
      const n = this.queue[this.index + 1];
      if (!n || this._prefetch.has(n.id)) return;
      try {
        this._prefetch.set(n.id, await api('getStream', n.id, this.quality));
        if (this._prefetch.size > 20) this._prefetch.delete(this._prefetch.keys().next().value);
      } catch {}
    },

    toggle() {
      if (!this.current) return this.emit('empty');
      if (audio.paused) {
        if (!audio.src) this._load(this.index, true);
        else audio.play().catch(() => {});
      } else audio.pause();
    },
    play() {
      if (audio.paused) this.toggle();
    },
    pause() {
      audio.pause();
    },

    async next(user = true) {
      if (!this.queue.length) return;
      if (this.index < this.queue.length - 1) return this._load(this.index + 1, true);
      if (this.endless) {
        await this._ensureBuffer();
        if (this.index < this.queue.length - 1) return this._load(this.index + 1, true);
        return;
      }
      if (this.repeat === 'all' || user) return this._load(0, this.repeat === 'all' || user);
      audio.pause();
      audio.currentTime = 0;
    },

    prev() {
      if (!this.queue.length) return;
      if (audio.currentTime > 3 || this.index === 0) {
        audio.currentTime = 0;
        if (audio.paused) audio.play().catch(() => {});
        return;
      }
      this._load(this.index - 1, true);
    },

    seek(sec) {
      if (!isFinite(audio.duration)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration - 0.25, sec));
      this._time();
    },
    seekRel(d) {
      this.seek(audio.currentTime + d);
    },

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.volume > 0) this.muted = false;
      this._applyVolume();
      window.zvuk.settings.set({ volume: this.volume });
    },
    toggleMute() {
      this.muted = !this.muted;
      this._applyVolume();
    },
    _applyVolume() {
      const v = this.muted ? 0 : this.volume * this.volume;
      if (AudioFX.ready) {
        audio.volume = 1;
        AudioFX.setVolume(v);
      } else audio.volume = v;
      this.emit('volume', { volume: this.volume, muted: this.muted });
    },

    toggleShuffle() {
      if (this.endless) {
        toast('В волне и радио треки и так подбираются по ходу', { iconName: 'sparkle' });
        return;
      }
      this.shuffle = !this.shuffle;
      window.zvuk.settings.set({ shuffle: this.shuffle });
      const cur = this.current;
      if (this.shuffle && this.queue.length > 1) {
        this.original = this.queue.slice();
        const rest = shuffleArr(this.queue.filter((_, i) => i !== this.index));
        this.queue = [cur, ...rest];
        this.index = 0;
      } else if (!this.shuffle && this.original) {
        this.queue = this.original;
        this.original = null;
        this.index = Math.max(0, this.queue.findIndex((t) => t === cur));
      }
      this.emit('modes');
      this.emit('queue');
    },

    cycleRepeat() {
      this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
      window.zvuk.settings.set({ repeat: this.repeat });
      this.emit('modes');
    },

    setQuality(q) {
      this.quality = q;
      this._prefetch.clear();
      if (this.current && audio.src) {
        const pos = audio.currentTime;
        const wasPlaying = this.playing;
        this._load(this.index, wasPlaying, pos);
      }
    },

    // ---------- События audio ----------
    _state() {
      const t = this.current;
      document.body.classList.toggle('paused', audio.paused);
      this.emit('state', { playing: this.playing });
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
      window.zvuk.player.state({ playing: this.playing, title: t?.title, artist: t ? artistsText(t.artists) : '' });
    },
    _lastPos: 0,
    _time() {
      const d = audio.duration;
      let buf = 0;
      try {
        if (audio.buffered.length) buf = audio.buffered.end(audio.buffered.length - 1) / (d || 1);
      } catch {}
      this.emit('time', { cur: audio.currentTime, dur: isFinite(d) ? d : this.current?.duration || 0, buf });
      const now = Math.floor(audio.currentTime);
      if (now !== this._lastPos && 'mediaSession' in navigator && isFinite(d) && d > 0) {
        this._lastPos = now;
        try {
          navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, d) });
        } catch {}
      }
      if (this.index >= 0 && audio.currentTime > 15) this._ensureBuffer();
    },
    _ended() {
      if (this.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      this.next(false);
    },
    async _error() {
      const t = this.current;
      if (!t || !audio.src) return;
      const pos = audio.currentTime || 0;
      if (!this._retried) {
        // Ссылка могла протухнуть — запрашиваем свежую и продолжаем с того же места
        this._retried = true;
        try {
          const s = await window.zvuk.call('getStream', t.id, this.quality);
          if (t !== this.current) return;
          this.stream = s;
          audio.src = s.url;
          audio.addEventListener('loadedmetadata', () => (audio.currentTime = pos), { once: true });
          await audio.play();
          return;
        } catch {}
      }
      toast(`Не удалось воспроизвести «${t.title}»`, { error: true });
      this._failStreak++;
      if (this._failStreak < 5) setTimeout(() => this.next(false), 800);
    },

    // ---------- Медиаклавиши и системный виджет Windows ----------
    _setupMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      const h = (a, fn) => {
        try {
          ms.setActionHandler(a, fn);
        } catch {}
      };
      h('play', () => this.play());
      h('pause', () => this.pause());
      h('stop', () => this.pause());
      h('previoustrack', () => this.prev());
      h('nexttrack', () => this.next());
      h('seekbackward', (d) => this.seekRel(-(d.seekOffset || 10)));
      h('seekforward', (d) => this.seekRel(d.seekOffset || 10));
      h('seekto', (d) => this.seek(d.seekTime));
    },
    _mediaMeta(t) {
      if (!('mediaSession' in navigator) || !t) return;
      const src = t.release?.image?.src;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: artistsText(t.artists),
        album: t.release?.title || '',
        artwork: src ? [96, 192, 384, 512].map((s) => ({ src: img(src, s), sizes: `${s}x${s}`, type: 'image/jpeg' })) : [],
      });
    },

    // ---------- Сохранение между запусками ----------
    save() {
      try {
        if (!this.queue.length) return;
        const start = Math.max(0, this.index - 50);
        const data = {
          queue: this.queue.slice(start, start + 300).map(slim),
          index: this.index - start,
          pos: audio.currentTime || 0,
          source: this.source ? { kind: this.source.kind, title: this.source.title, params: this.source.params || null } : null,
        };
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
      } catch {}
    },
    restore() {
      try {
        const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (!d || !d.queue || !d.queue.length) return false;
        return d;
      } catch {
        return false;
      }
    },
  };

  window.Player = Player;
})();
