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

  const DEFAULT_EQ = { enabled: false, preset: 'flat', bands: PRESETS.flat.bands.slice(), preamp: 0, compressor: false };
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
      if (eqSettings) this.eq = { ...DEFAULT_EQ, ...eqSettings, bands: (eqSettings.bands || DEFAULT_EQ.bands).slice(0, 10) };
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
    setBand(i, db) {
      this.eq.bands[i] = Math.round(Math.max(-12, Math.min(12, db)) * 2) / 2;
      this.eq.preset = 'custom';
      if (!this.eq.enabled) this.eq.enabled = true;
      this._changed();
    },
    setPreamp(db) {
      this.eq.preamp = Math.round(Math.max(-12, Math.min(6, db)) * 2) / 2;
      this._changed();
    },
    setPreset(id) {
      const p = PRESETS[id];
      if (!p) return;
      this.eq.preset = id;
      this.eq.bands = p.bands.slice();
      // Чтобы не было перегруза, при подъёме частот немного снижаем общий уровень
      const peak = Math.max(0, ...p.bands);
      this.eq.preamp = -Math.round(peak * 0.6 * 2) / 2;
      this.eq.enabled = id !== 'flat' || this.eq.enabled;
      this._changed();
    },
    setCompressor(v) {
      this.eq.compressor = Boolean(v);
      this._changed();
    },
    reset() {
      this.eq = { ...DEFAULT_EQ, bands: DEFAULT_EQ.bands.slice(), enabled: this.eq.enabled };
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
