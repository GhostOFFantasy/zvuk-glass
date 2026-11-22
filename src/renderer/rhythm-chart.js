const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const DIFFICULTIES = {
  easy: { label: 'Лёгкий', lanes: 4, density: .45, lookahead: 2.4, windows: { perfect: .06, great: .11, good: .185 }, score: .8 },
  normal: { label: 'Средний', lanes: 4, density: .72, lookahead: 2.15, windows: { perfect: .045, great: .085, good: .15 }, score: 1 },
  hard: { label: 'Сложный', lanes: 4, density: 1, lookahead: 1.85, windows: { perfect: .035, great: .07, good: .13 }, score: 1.2 },
  expert: { label: 'Эксперт', lanes: 5, density: 1.3, lookahead: 1.65, windows: { perfect: .028, great: .055, good: .11 }, score: 1.5 },
};

/* Чарт строится до старта. Спектральный поток отмечает атаки звука, а не громкость кадра. */
export class RhythmChart {
  constructor() {
    this.cache = new Map();
    this.pending = null;
  }

  async load(track, audio, progress = () => {}, difficulty = 'normal') {
    if (!track || !audio?.src) throw new Error('Сначала запустите музыкальный поток');
    const level = DIFFICULTIES[difficulty] ? difficulty : 'normal';
    const key = `${track.id}:${audio.src}:${level}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending?.key === key) return this.pending.promise;
    const promise = this.analyze(track, audio.src, progress, level)
      .then((chart) => {
        this.cache.set(key, chart);
        if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        return chart;
      })
      .finally(() => { if (this.pending?.key === key) this.pending = null; });
    this.pending = { key, promise };
    return promise;
  }

  async analyze(track, src, progress, difficulty) {
    progress(.04, 'Читаю аудиопоток');
    const bytes = await fetchAll(src);
    progress(.22, 'Определяю атаки и частоты');
    const context = AudioFX.ctx || new AudioContext();
    const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const sampleRate = 11025;
    progress(.36, 'Микширую и уменьшаю сигнал');
    const signal = mixDown(decoded, sampleRate);
    progress(.48, 'Строю спектральную карту');
    const features = spectralFlux(signal, sampleRate);
    progress(.72, 'Размечаю ноты и удержания');
    const chart = makeChart(features, track, decoded.duration, difficulty);
    chart.method = 'spectral-flux';
    chart.duration = decoded.duration;
    progress(1, `${chart.notes.length} нот · ритм готов`);
    return chart;
  }

  destroy() { this.cache.clear(); this.pending = null; }
}

async function fetchAll(src) {
  const chunks = [];
  let start = 0;
  let total = 0;
  for (let part = 0; part < 128; part++) {
    const response = await fetch(src, { headers: { Range: `bytes=${start}-${start + 2097151}` } });
    if (!response.ok) throw new Error(`Аудиопоток недоступен (${response.status})`);
    const range = response.headers.get('Content-Range');
    const match = range?.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length) break;
    chunks.push(data);
    start += data.length;
    if (match) total = Number(match[3]);
    if ((total && start >= total) || response.status === 200 || data.length < 2097152) break;
  }
  const bytes = new Uint8Array(start);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (bytes.length < 1024) throw new Error('Пустой аудиопоток');
  return bytes;
}

function mixDown(decoded, targetRate) {
  const channels = [];
  for (let index = 0; index < decoded.numberOfChannels; index++) channels.push(decoded.getChannelData(index));
  const ratio = decoded.sampleRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.ceil(decoded.duration * targetRate)));
  for (let index = 0; index < output.length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(decoded.length - 1, left + 1);
    const fraction = position - left;
    let value = 0;
    for (const channel of channels) value += channel[left] + (channel[right] - channel[left]) * fraction;
    output[index] = value / channels.length;
  }
  return output;
}

function spectralFlux(signal, rate) {
  const size = 512;
  const hop = 128;
  const bins = size / 2;
  const rev = new Uint16Array(size);
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float32Array(bins);
  const sin = new Float32Array(bins);
  const window = new Float32Array(size);
  for (let i = 0; i < bins; i++) { cos[i] = Math.cos(-2 * Math.PI * i / size); sin[i] = Math.sin(-2 * Math.PI * i / size); }
  for (let i = 0; i < size; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1));
  const count = Math.max(1, Math.floor((signal.length - size) / hop));
  const flux = new Float32Array(count);
  const bass = new Float32Array(count);
  const treble = new Float32Array(count);
  const centroid = new Float32Array(count);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  const previous = new Float32Array(bins);
  const current = new Float32Array(bins);
  for (let frame = 0; frame < count; frame++) {
    const at = frame * hop;
    for (let i = 0; i < size; i++) { real[i] = signal[at + i] * window[i]; imag[i] = 0; }
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      if (j <= i) continue;
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1;
      const step = size / length;
      for (let i = 0; i < size; i += length) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tr = real[b] * cos[k] - imag[b] * sin[k];
          const ti = real[b] * sin[k] + imag[b] * cos[k];
          real[b] = real[a] - tr; imag[b] = imag[a] - ti;
          real[a] += tr; imag[a] += ti;
        }
      }
    }
    let positive = 0;
    let low = 0;
    let high = 0;
    let weighted = 0;
    let energy = 0;
    for (let k = 2; k < bins; k++) {
      const hz = k * rate / size;
      if (hz > 5000) break;
      const magnitude = Math.hypot(real[k], imag[k]) / size;
      current[k] = magnitude;
      const difference = Math.max(0, magnitude - previous[k]);
      positive += difference * (hz < 190 ? 1.35 : hz > 1800 ? .78 : 1);
      if (hz < 190) low += difference;
      if (hz > 1800) high += magnitude;
      weighted += hz * magnitude;
      energy += magnitude;
    }
    flux[frame] = positive;
    bass[frame] = low;
    treble[frame] = high;
    centroid[frame] = energy ? weighted / energy : 0;
    previous.set(current);
  }
  return { flux, bass, treble, centroid, hop, size, rate };
}

function median(values, fallback = .5) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function makeChart(features, track, duration, difficultyId) {
  const difficulty = DIFFICULTIES[difficultyId] || DIFFICULTIES.normal;
  const { flux, bass, treble, centroid, hop, size, rate } = features;
  const onsets = [];
  for (let i = 3; i < flux.length - 3; i++) {
    const value = flux[i];
    if (value <= 0 || value < flux[i - 1] || value < flux[i + 1]) continue;
    let mean = 0;
    let count = 0;
    for (let j = Math.max(0, i - 22); j < Math.min(flux.length, i + 10); j++) { mean += flux[j]; count++; }
    mean /= Math.max(1, count);
    let variance = 0;
    for (let j = Math.max(0, i - 22); j < Math.min(flux.length, i + 10); j++) variance += (flux[j] - mean) ** 2;
    const deviation = Math.sqrt(variance / Math.max(1, count));
    if (value < mean * 1.12 + deviation * .42 || value < .006) continue;
    const time = (i * hop + size * .5) / rate;
    const last = onsets[onsets.length - 1];
    if (last && time - last.time < .14) {
      if (value > last.strength) { last.time = time; last.strength = value; last.bass = bass[i]; last.treble = treble[i]; last.centroid = centroid[i]; }
      continue;
    }
    onsets.push({ time, strength: value, bass: bass[i], treble: treble[i], centroid: centroid[i] });
  }
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    const interval = onsets[i].time - onsets[i - 1].time;
    if (interval >= .2 && interval <= 1.2) intervals.push(interval);
  }
  let period = median(intervals, .5);
  while (period < .3) period *= 2;
  while (period > 1) period *= .5;
  const averageStrength = median(onsets.map((onset) => onset.strength), .02);
  const selected = [];
  for (const onset of onsets) {
    if (onset.time < 2.75 || onset.time > duration - .65) continue;
    const last = selected[selected.length - 1];
    const distance = last ? onset.time - last.time : 1;
    if (distance < .22) {
      if (onset.strength > last.strength * 1.12) selected[selected.length - 1] = onset;
      continue;
    }
    if (distance < .34 && onset.strength < averageStrength * .55) continue;
    selected.push(onset);
  }

  let levelSelected = selected;
  if (difficulty.density < 1 && selected.length > 4) {
    const target = Math.max(4, Math.ceil(selected.length * difficulty.density));
    levelSelected = [...selected].sort((a, b) => b.strength - a.strength).slice(0, target).sort((a, b) => a.time - b.time);
  }
  const filled = [];
  for (let i = 0; i < levelSelected.length; i++) {
    const onset = levelSelected[i];
    const previous = filled[filled.length - 1];
    if (difficulty.density >= 1 && previous && onset.time - previous.time > Math.max(1.35, period * 2.6)) {
      for (let time = previous.time + period; time < onset.time - period * .6; time += period) {
        if (time > 2.75) filled.push({ ...previous, time, strength: previous.strength * .35, inferred: true });
      }
    }
    if (difficulty.density > 1 && previous && onset.time - previous.time > period * 1.25) {
      const time = previous.time + (onset.time - previous.time) * .5;
      if (time - previous.time > .28 && onset.time - time > .28) filled.push({ ...previous, time, strength: previous.strength * .48, inferred: true });
    }
    filled.push(onset);
  }
  let seed = 7919;
  for (const char of String(track.id)) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const laneCount = difficulty.lanes;
  const notes = filled.map((onset, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const next = filled[index + 1];
    const gap = next ? next.time - onset.time : period;
    const hold = gap > .72 && index % (difficultyId === 'expert' ? 5 : 7) === (difficultyId === 'expert' ? 2 : 5);
    const lane = (Math.floor(onset.centroid / 650) + (onset.bass > onset.treble * .15 ? 1 : 0) + (seed % 3) + index) % laneCount;
    return {
      id: index + 1, lane, time: onset.time, duration: hold ? clamp(gap * .62, .45, 1.55) : 0,
      strength: onset.strength, inferred: Boolean(onset.inferred), state: 'pending', judgement: null,
    };
  });
  return {
    notes, bpm: Math.round(60 / period), onsets: onsets.length, inferred: notes.filter((n) => n.inferred).length,
    windows: { ...difficulty.windows }, lanes: laneCount, lookahead: difficulty.lookahead,
    difficulty: difficultyId, scoreScale: difficulty.score,
  };
}
