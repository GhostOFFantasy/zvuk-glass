'use strict';
/* Аудио-движок: эквалайзер, компрессор, громкость и анализатор спектра (Web Audio) */
(function () {
  const FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ['32', '64', '125', '250', '500', '1к', '2к', '4к', '8к', '16к'];

  const PRESETS = {
    flat: { name: 'Ровный', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bass: { name: 'Больше баса', bands: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0] },
    rock: { name: 'Рок', bands: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5] },
    pop: { name: 'Поп', bands: [-1, 1, 3, 4, 3, 1, -1, -1, 0, 1] },
    electronic: { name: 'Электроника', bands: [5, 4.5, 1, 0, -2, 1, 0, 1.5, 4, 5] },
    hiphop: { name: 'Хип-хоп', bands: [5.5, 4.5, 2, 3, -1, -1, 1, 0, 2, 3] },
    vocal: { name: 'Вокал', bands: [-2, -1, 0, 2, 4, 4.5, 3, 1.5, 0, -1] },
    jazz: { name: 'Джаз', bands: [3, 2, 1, 2, -1.5, -1.5, 0, 1.5, 2.5, 3] },
    classical: { name: 'Классика', bands: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
    acoustic: { name: 'Акустика', bands: [4, 3.5, 2.5, 1, 1, 1, 2, 3, 3, 2] },
    loudness: { name: 'Громкость+', bands: [6, 4, 0, 0, -1, 0, -1, -2, 4, 3] },
    night: { name: 'Ночной', bands: [-4, -3, -1, 1, 2, 2.5, 1.5, 0, -2, -4] },
    treble: { name: 'Больше высоких', bands: [0, 0, 0, 0, 0, 1, 2.5, 4.5, 6, 7] },
  };

  // preset: id готового пресета, 'custom' («Свой») или 'u:…' (сохранённый пользователем).
  // custom — последние ручные настройки, user — свои пресеты с названиями. Ничего из этого не теряется
  // при переключении на готовые пресеты.
  const DEFAULT_EQ = { enabled: false, preset: 'flat', bands: PRESETS.flat.bands.slice(), preamp: 0, compressor: false, custom: null, user: [] };
  const isUser = (id) => typeof id === 'string' && id.startsWith('u:');
  const MAX_USER = 30;
  const dbToGain = (db) => Math.pow(10, db / 20);

  const AudioFX = {
    FREQS,
    LABELS,
    PRESETS,
    ready: false,
    ctx: null,
    analyser: null,
    eq: { ...DEFAULT_EQ },
    volume: 1,
    onChange: null,

    init(audio, eqSettings) {
      if (eqSettings) {
        this.eq = { ...DEFAULT_EQ, ...eqSettings, bands: (eqSettings.bands || DEFAULT_EQ.bands).slice(0, 10) };
        this.eq.user = Array.isArray(eqSettings.user) ? eqSettings.user.filter((p) => p && isUser(p.id) && Array.isArray(p.bands)).slice(0, MAX_USER) : [];
        // раньше «Свой» не запоминался отдельно — переносим текущие ручные настройки
        if (!this.eq.custom && this.eq.preset === 'custom') this.eq.custom = { bands: this.eq.bands.slice(), preamp: this.eq.preamp || 0 };
        if (isUser(this.eq.preset) && !this.userPreset(this.eq.preset)) this.eq.preset = 'custom';
      }
      try {
        this.ctx = new AudioContext({ latencyHint: 'playback' });
        const c = this.ctx;
        this.src = c.createMediaElementSource(audio);
        this.pre = c.createGain();
        this.filters = FREQS.map((f, i) => {
          const b = c.createBiquadFilter();
          b.type = i === 0 ? 'lowshelf' : i === FREQS.length - 1 ? 'highshelf' : 'peaking';
          b.frequency.value = f;
          b.Q.value = 1.05;
          b.gain.value = 0;
          return b;
        });
        this.comp = c.createDynamicsCompressor();
        this.comp.threshold.value = -22;
        this.comp.knee.value = 28;
        this.comp.ratio.value = 3.2;
        this.comp.attack.value = 0.004;
        this.comp.release.value = 0.22;
        this.post = c.createGain();
        this.analyser = c.createAnalyser();
        this.analyser.fftSize = 4096;
        this.analyser.smoothingTimeConstant = 0.78;
        this.vol = c.createGain();

        this.src.connect(this.pre);
        let node = this.pre;
        for (const f of this.filters) {
          node.connect(f);
          node = f;
        }
        this.last = node;
        this.post.connect(this.analyser);
        this.analyser.connect(this.vol);
        this.vol.connect(c.destination);
        audio.volume = 1;
        audio.addEventListener('play', () => this.ctx.state !== 'running' && this.ctx.resume());
        this.ready = true;
      } catch (e) {
        console.warn('Web Audio недоступен', e);
        this.ready = false;
      }
      this.apply();
    },

    apply() {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      const on = this.eq.enabled;
      this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? this.eq.bands[i] || 0 : 0, t, 0.03));
      this.pre.gain.setTargetAtTime(on ? dbToGain(this.eq.preamp || 0) : 1, t, 0.03);
      try {
        this.last.disconnect();
        this.comp.disconnect();
      } catch {}
      if (on && this.eq.compressor) {
        this.last.connect(this.comp);
        this.comp.connect(this.post);
      } else this.last.connect(this.post);
    },

    _changed() {
      this.apply();
      this.onChange && this.onChange(this.eq);
      window.dispatchEvent(new Event('zg:eq'));
    },
    setEnabled(v) {
      this.eq.enabled = Boolean(v);
      this._changed();
    },
    userPreset(id) {
      return (this.eq.user || []).find((p) => p.id === id) || null;
    },
    /** Название пресета для подписей: готовый, «Свой» или своё название. */
    presetName(id = this.eq.preset) {
      if (PRESETS[id]) return PRESETS[id].name;
      if (isUser(id)) return this.userPreset(id)?.name || 'Свой';
      return 'Свой';
    },
    /** Ручная правка: попадает в выбранный свой пресет, а если выбран готовый — в «Свой». */
    _remember() {
      const u = isUser(this.eq.preset) ? this.userPreset(this.eq.preset) : null;
      if (u) {
        u.bands = this.eq.bands.slice();
        u.preamp = this.eq.preamp || 0;
      } else {
        this.eq.preset = 'custom';
        this.eq.custom = { bands: this.eq.bands.slice(), preamp: this.eq.preamp || 0 };
      }
    },
    setBand(i, db) {
      this.eq.bands[i] = Math.round(Math.max(-12, Math.min(12, db)) * 2) / 2;
      this._remember();
      if (!this.eq.enabled) this.eq.enabled = true;
      this._changed();
    },
    setPreamp(db) {
      this.eq.preamp = Math.round(Math.max(-12, Math.min(6, db)) * 2) / 2;
      // общий уровень у готовых пресетов подбирается сам; у своих — запоминается вместе с полосами
      if (this.eq.preset === 'custom' || isUser(this.eq.preset)) this._remember();
      this._changed();
    },
    setPreset(id) {
      let bands;
      let preamp;
      if (PRESETS[id]) {
        bands = PRESETS[id].bands;
        // Чтобы не было перегруза, при подъёме частот немного снижаем общий уровень
        preamp = -Math.round(Math.max(0, ...bands) * 0.6 * 2) / 2;
      } else if (id === 'custom') {
        const c = this.eq.custom || { bands: PRESETS.flat.bands, preamp: 0 };
        bands = c.bands;
        preamp = c.preamp || 0;
      } else {
        const u = this.userPreset(id);
        if (!u) return;
        bands = u.bands;
        preamp = u.preamp || 0;
      }
      this.eq.preset = id;
      this.eq.bands = bands.slice(0, 10);
      this.eq.preamp = preamp;
      this.eq.enabled = id !== 'flat' || this.eq.enabled;
      this._changed();
    },
    /** Сохранить текущие настройки как свой пресет с названием; он сразу становится выбранным. */
    savePreset(name) {
      const n = String(name || '').trim().slice(0, 30);
      if (!n) return null;
      const user = this.eq.user || [];
      if (user.length >= MAX_USER) return null;
      const p = { id: 'u:' + Date.now().toString(36), name: n, bands: this.eq.bands.slice(), preamp: this.eq.preamp || 0 };
      this.eq.user = [...user, p];
      this.eq.preset = p.id;
      if (!this.eq.enabled) this.eq.enabled = true;
      this._changed();
      return p.id;
    },
    renamePreset(id, name) {
      const u = this.userPreset(id);
      const n = String(name || '').trim().slice(0, 30);
      if (!u || !n) return;
      u.name = n;
      this._changed();
    },
    /** Удалить свой пресет; если он был выбран, его настройки остаются в «Своём». */
    deletePreset(id) {
      const u = this.userPreset(id);
      if (!u) return;
      this.eq.user = this.eq.user.filter((p) => p.id !== id);
      if (this.eq.preset === id) {
        this.eq.preset = 'custom';
        this.eq.custom = { bands: u.bands.slice(), preamp: u.preamp || 0 };
      }
      this._changed();
    },
    setCompressor(v) {
      this.eq.compressor = Boolean(v);
      this._changed();
    },
    /** «Сбросить» — все полосы на 0 (пресет «Ровный»); «Свой» и свои пресеты не трогаем. */
    reset() {
      this.eq = { ...this.eq, preset: 'flat', bands: DEFAULT_EQ.bands.slice(), preamp: 0 };
      this._changed();
    },

    /** Громкость регулируется после анализатора — визуализация не зависит от уровня звука. */
    setVolume(v) {
      this.volume = v;
      if (this.ready && !this.ducked) this.vol.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    },

    /** Временно заглушить трек (анализатор продолжает работать) — для подстройки клипа по звуку. */
    ducked: false,
    duck(on) {
      this.ducked = Boolean(on);
      if (this.ready) this.vol.gain.setTargetAtTime(on ? 0 : this.volume ?? 1, this.ctx.currentTime, 0.02);
    },

    /** АЧХ эквалайзера в дБ для массива частот. */
    response(freqs) {
      const out = new Float32Array(freqs.length);
      if (!this.ready || !this.eq.enabled) return out;
      const mag = new Float32Array(freqs.length);
      const ph = new Float32Array(freqs.length);
      for (const f of this.filters) {
        f.getFrequencyResponse(freqs, mag, ph);
        for (let i = 0; i < freqs.length; i++) out[i] += 20 * Math.log10(mag[i] || 1e-6);
      }
      for (let i = 0; i < out.length; i++) out[i] += this.eq.preamp || 0;
      return out;
    },
  };

  window.AudioFX = AudioFX;
})();
