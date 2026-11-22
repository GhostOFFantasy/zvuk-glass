const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/* Анализатор стоит до EQ: тембровые настройки не меняют сложность игры. */
export class RhythmInput {
  constructor() {
    this.available = Boolean(AudioFX.ready && AudioFX.src && AudioFX.ctx);
    this.period = 0.86;
    this.confidence = 0;
    this.energy = 0;
    this.bass = 0;
    this.drive = 0.22;
    this.baseEnergy = 0;
    this.lastUpdate = 0;
    this.lastOnset = 0;
    this.onsetStrength = 0;
    this.testDrive = null;
    this.onsets = [];
    this.history = new Float32Array(96);
    this.historyIndex = 0;
    this.historyCount = 0;
    if (!this.available) return;
    this.analyser = AudioFX.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.18;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.prev = new Uint8Array(this.analyser.frequencyBinCount);
    AudioFX.src.connect(this.analyser);
  }

  reset(time = 0) {
    this.onsets.length = 0;
    this.history.fill(0);
    this.prev?.fill(0);
    this.historyIndex = 0;
    this.historyCount = 0;
    this.lastOnset = time;
    this.lastUpdate = time;
    this.confidence = 0;
    this.energy = 0;
    this.bass = 0;
    this.drive = 0.22;
    this.baseEnergy = 0;
    this.onsetStrength = 0;
    this.testDrive = null;
    this.period = 0.86;
  }

  estimate() {
    const intervals = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const interval = this.onsets[i] - this.onsets[i - 1];
      if (interval >= 0.25 && interval <= 1.4) intervals.push(interval);
    }
    if (intervals.length < 5) {
      this.confidence = 0;
      return;
    }
    intervals.sort((a, b) => a - b);
    let period = intervals[Math.floor(intervals.length / 2)];
    while (period < 0.34) period *= 2;
    while (period > 1.08) period *= 0.5;
    let deviation = 0;
    let matches = 0;
    for (const interval of intervals) {
      let folded = interval;
      while (folded < period * 0.72) folded *= 2;
      while (folded > period * 1.45) folded *= 0.5;
      deviation += Math.abs(folded - period);
      if (Math.abs(folded - period) < period * 0.2) matches++;
    }
    deviation /= intervals.length;
    const stability = clamp(1 - deviation / (period * 0.34), 0, 1);
    const agreement = matches / intervals.length;
    this.confidence = clamp((intervals.length - 3) / 8, 0, 1) * stability * agreement;
    if (this.confidence >= 0.42) this.period = period;
  }

  update(time) {
    if (!this.available || !Player.playing) return false;
    const dt = clamp(time - this.lastUpdate, 1 / 240, 0.1);
    this.lastUpdate = time;
    this.analyser.getByteFrequencyData(this.freq);
    let flux = 0;
    let low = 0;
    let total = 0;
    for (let i = 2; i < 54; i++) {
      const difference = (this.freq[i] - this.prev[i]) / 255;
      if (difference > 0) flux += difference;
      if (i < 16) low += this.freq[i] / 255;
      total += this.freq[i] / 255;
    }
    flux /= 52;
    low /= 14;
    total /= 52;
    this.energy += (total - this.energy) * (1 - Math.exp(-dt * 9));
    this.bass += (low - this.bass) * (1 - Math.exp(-dt * 12));
    if (!this.baseEnergy) this.baseEnergy = Math.max(0.001, total);
    const baseRate = total > this.baseEnergy ? 0.055 : 0.11;
    this.baseEnergy += (total - this.baseEnergy) * (1 - Math.exp(-dt * baseRate));
    const loudness = clamp((total - 0.035) / 0.19, 0, 1);
    const lift = clamp((total - this.baseEnergy) / (0.025 + this.baseEnergy * 0.45), 0, 1);
    const targetDrive = clamp(0.08 + loudness * 0.42 + lift * 0.62, 0.05, 1);
    const response = targetDrive > this.drive ? 3.4 : 0.7;
    this.drive += (targetDrive - this.drive) * (1 - Math.exp(-dt * response));
    let mean = 0;
    for (let i = 0; i < this.historyCount; i++) mean += this.history[i];
    mean = this.historyCount ? mean / this.historyCount : 0;
    let variance = 0;
    for (let i = 0; i < this.historyCount; i++) variance += (this.history[i] - mean) ** 2;
    const deviation = this.historyCount ? Math.sqrt(variance / this.historyCount) : 0;
    const threshold = mean * 1.24 + deviation * 0.42;
    const onset = flux > 0.022 && low > 0.085 && flux > threshold && time - this.lastOnset > 0.19;
    this.onsetStrength = onset ? clamp(0.35 + (flux - threshold) / (0.035 + deviation), 0.35, 1) : 0;
    this.history[this.historyIndex] = flux;
    this.historyIndex = (this.historyIndex + 1) % this.history.length;
    this.historyCount = Math.min(this.history.length, this.historyCount + 1);
    this.prev.set(this.freq);
    if (onset) {
      this.lastOnset = time;
      this.onsets.push(time);
      if (this.onsets.length > 28) this.onsets.shift();
      this.estimate();
    }
    return onset;
  }

  destroy() {
    if (!this.available) return;
    try { AudioFX.src.disconnect(this.analyser); } catch {}
    try { this.analyser.disconnect(); } catch {}
    this.onsets.length = 0;
  }
}
