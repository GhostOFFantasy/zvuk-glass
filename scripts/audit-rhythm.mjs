import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const output = process.argv[2];
if (!output) throw new Error('Укажите путь для результата');
const pages = await fetch('http://127.0.0.1:9222/json').then((response) => response.json());
const page = pages.find((item) => item.type === 'page' && item.url.startsWith('http://tauri.localhost'));
if (!page) throw new Error('Окно приложения не найдено');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
});
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
await mkdir(dirname(output), { recursive: true });
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
await writeFile(output.replace(/\.json$/i, '') + '-result.png', Buffer.from(screenshot.data, 'base64'));

async function audit() {
  const { RhythmChart } = await import('/rhythm-chart.js');
  const track = Player.current;
  const duration = Player.audio.duration;
  const analyzer = new RhythmChart();
  const normal = await analyzer.load(track, Player.audio, () => {}, 'normal');
  const hard = await analyzer.load(track, Player.audio, () => {}, 'hard');

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
    return bytes;
  }

  const bytes = await fetchAll(Player.audio.src);
  const context = AudioFX.ctx || new AudioContext();
  const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const rate = 16000;
  const ratio = decoded.sampleRate / rate;
  const signal = new Float32Array(Math.ceil(decoded.duration * rate));
  for (let index = 0; index < signal.length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(decoded.length - 1, left + 1);
    const fraction = position - left;
    let value = 0;
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      value += data[left] + (data[right] - data[left]) * fraction;
    }
    signal[index] = value / decoded.numberOfChannels;
  }

  const size = 512;
  const hop = 128;
  const bins = size / 2;
  const reverse = new Uint16Array(size);
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    reverse[i] = j;
  }
  const cosine = new Float32Array(bins);
  const sine = new Float32Array(bins);
  const window = new Float32Array(size);
  for (let i = 0; i < bins; i++) {
    cosine[i] = Math.cos(-2 * Math.PI * i / size);
    sine[i] = Math.sin(-2 * Math.PI * i / size);
  }
  for (let i = 0; i < size; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1));
  const count = Math.max(1, Math.floor((signal.length - size) / hop));
  const flux = new Float32Array(count);
  const real = new Float32Array(size);
  const imaginary = new Float32Array(size);
  const previous = new Float32Array(bins);
  const current = new Float32Array(bins);
  for (let frame = 0; frame < count; frame++) {
    const at = frame * hop;
    for (let i = 0; i < size; i++) { real[i] = signal[at + i] * window[i]; imaginary[i] = 0; }
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j <= i) continue;
      let value = real[i]; real[i] = real[j]; real[j] = value;
      value = imaginary[i]; imaginary[i] = imaginary[j]; imaginary[j] = value;
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1;
      const step = size / length;
      for (let i = 0; i < size; i += length) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tr = real[b] * cosine[k] - imaginary[b] * sine[k];
          const ti = real[b] * sine[k] + imaginary[b] * cosine[k];
          real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
          real[a] += tr; imaginary[a] += ti;
        }
      }
    }
    let positive = 0;
    let used = 0;
    for (let k = 2; k < bins; k++) {
      const hz = k * rate / size;
      if (hz > 6500) break;
      if (hz < 40) continue;
      const magnitude = Math.hypot(real[k], imaginary[k]) / size;
      const level = Math.log1p(magnitude * 120);
      current[k] = level;
      const difference = Math.max(0, level - previous[k]);
      positive += difference * (hz < 180 ? 1.25 : hz > 2000 ? .72 : 1);
      used++;
    }
    flux[frame] = positive / Math.max(1, used);
    previous.set(current);
  }

  const peaks = [];
  for (let i = 2; i < count - 3; i++) {
    const value = flux[i];
    if (value <= 0 || value < flux[i - 1] || value < flux[i + 1] || value < flux[i - 2] || value < flux[i + 2]) continue;
    let mean = 0;
    let samples = 0;
    for (let j = Math.max(0, i - 12); j < Math.min(count, i + 6); j++) { mean += flux[j]; samples++; }
    mean /= Math.max(1, samples);
    let variance = 0;
    for (let j = Math.max(0, i - 12); j < Math.min(count, i + 6); j++) variance += (flux[j] - mean) ** 2;
    const deviation = Math.sqrt(variance / Math.max(1, samples));
    if (value < mean * 1.04 + deviation * .55) continue;
    const time = (i * hop + size * .5) / rate;
    const last = peaks[peaks.length - 1];
    if (last && time - last.time < .09) {
      if (value > last.strength) { last.time = time; last.strength = value; }
      continue;
    }
    peaks.push({ time, strength: value });
  }
  const playablePeaks = peaks.filter((peak) => peak.time >= 2.75 && peak.time <= duration - .65);
  const sortedStrengths = playablePeaks.map((peak) => peak.strength).sort((a, b) => a - b);
  const strongThreshold = sortedStrengths[Math.floor(sortedStrengths.length / 2)] || 0;
  const strongPeaks = playablePeaks.filter((peak) => peak.strength >= strongThreshold);

  function nearest(items, time) {
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (items[middle].time < time) low = middle + 1;
      else high = middle - 1;
    }
    const candidates = [items[low - 1], items[low]].filter(Boolean);
    return candidates.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0] || null;
  }
  function distribution(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const absolute = sorted.map(Math.abs).sort((a, b) => a - b);
    return {
      samples: values.length,
      medianSignedMs: sorted[Math.floor(sorted.length / 2)],
      medianAbsoluteMs: absolute[Math.floor(absolute.length / 2)],
      meanAbsoluteMs: absolute.reduce((sum, value) => sum + value, 0) / absolute.length,
      within50ms: absolute.filter((value) => value <= 50).length,
      within80ms: absolute.filter((value) => value <= 80).length,
      within100ms: absolute.filter((value) => value <= 100).length,
    };
  }
  function match(notes) {
    const offsets = notes.map((note) => {
      const peak = nearest(playablePeaks, note.time);
      return peak ? (note.time - peak.time) * 1000 : Infinity;
    }).filter(Number.isFinite);
    return distribution(offsets);
  }
  function coverage(notes) {
    const offsets = strongPeaks.map((peak) => {
      const note = nearest(notes, peak.time);
      return note ? Math.abs(note.time - peak.time) * 1000 : Infinity;
    });
    return { strongPeaks: strongPeaks.length, coveredWithin80ms: offsets.filter((value) => value <= 80).length };
  }
  const realNotes = normal.notes.filter((note) => !note.inferred);
  const inferredNotes = normal.notes.filter((note) => note.inferred);
  const period = 60 / normal.bpm;
  let best = null;
  for (let phase = 0; phase < period; phase += .005) {
    const errors = realNotes.map((note) => {
      const wrapped = ((note.time - phase + period / 2) % period + period) % period - period / 2;
      return Math.abs(wrapped * 1000);
    }).sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    if (!best || median < best.medianGridDeviationMs) best = { phaseMs: phase * 1000, medianGridDeviationMs: median, within50ms: errors.filter((value) => value <= 50).length, realNotes: realNotes.length };
  }
  const details = normal.notes.map((note) => {
    const peak = nearest(playablePeaks, note.time);
    return { id: note.id, time: note.time, lane: note.lane, inferred: Boolean(note.inferred), strength: note.strength,
      nearestIndependentOffsetMs: peak ? (note.time - peak.time) * 1000 : null };
  });
  return {
    track: { id: track.id, title: track.title, artists: track.artists?.map((artist) => artist.title), duration },
    independentAnalysis: { sampleRate: rate, fftSize: size, hop, frameMs: hop / rate * 1000, peaks: playablePeaks.length, strongPeaks: strongPeaks.length, strongThreshold },
    charts: {
      normal: { notes: normal.notes.length, real: realNotes.length, inferred: inferredNotes.length, bpm: normal.bpm, onsets: normal.onsets },
      hard: { notes: hard.notes.length, real: hard.notes.filter((note) => !note.inferred).length, inferred: hard.notes.filter((note) => note.inferred).length, bpm: hard.bpm, onsets: hard.onsets },
    },
    matching: { realNotes: match(realNotes), inferredNotes: match(inferredNotes), allNotes: match(normal.notes) },
    strongPeakCoverage: { allNormalNotes: coverage(normal.notes), realNormalNotesOnly: coverage(realNotes) },
    beatGrid: best,
    details,
  };
}

const response = await call('Runtime.evaluate', { expression: `(${audit.toString()})()`, returnByValue: true, awaitPromise: true });
if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
const report = response.result?.value;
await writeFile(output, JSON.stringify(report, null, 2));
const summary = { ...report };
delete summary.details;
console.log(JSON.stringify(summary, null, 2));
socket.close();
