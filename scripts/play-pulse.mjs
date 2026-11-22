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
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
const keys = [
  { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 },
  { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 },
  { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74 },
  { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 },
  { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76 },
];
const keyEvent = (lane, type) => call('Input.dispatchKeyEvent', { type, ...keys[lane] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const initial = await evaluate(`(async () => {
  if (!window.__pulseTest) throw new Error('Откройте NOVA: Синхронизация');
  window.__pulseTest.setDifficulty('normal');
  await window.__pulseTest.restart();
  return { track: Player.current?.title, artists: Player.current?.artists?.map(a => a.title), trackId: Player.current?.id,
    duration: Player.audio.duration, state: window.__pulseTest.state, metrics: window.__pulseTest.metrics() };
})()`);
console.log(`Старт: ${initial.track}, нот: ${initial.metrics.chartNotes}, BPM: ${initial.metrics.bpm}`);
const startedAt = Date.now();
const attempted = new Set();
const held = new Map();
const attempts = [];
const timeline = [];
let lastJudged = -1;
let lastProgress = -15;
let finalMetrics = initial.metrics;
while (Date.now() - startedAt < 255000) {
  const metrics = await evaluate('window.__pulseTest?.metrics()');
  if (!metrics) throw new Error('Игровой экран закрыт во время прохождения');
  finalMetrics = metrics;
  if (metrics.judged !== lastJudged) {
    timeline.push({ time: metrics.trackTime, judged: metrics.judged, judge: metrics.lastJudge,
      offset: metrics.lastOffset, hits: metrics.hits, misses: metrics.misses, combo: metrics.combo });
    lastJudged = metrics.judged;
  }
  if (metrics.trackTime - lastProgress >= 15 && metrics.state === 'play') {
    console.log(`${metrics.trackTime.toFixed(1)} с · точность ${metrics.accuracy}% · серия ${metrics.combo} · пропуски ${metrics.misses}`);
    lastProgress = metrics.trackTime;
  }
  if (metrics.state === 'result') break;
  if (metrics.state === 'play') {
    for (const [lane, hold] of held) {
      if (metrics.trackTime >= hold.releaseAt) {
        await keyEvent(lane, 'keyUp');
        held.delete(lane);
      }
    }
    const note = metrics.nextNote;
    if (note && !attempted.has(note.id)) {
      const delta = note.time - metrics.trackTime;
      if (delta <= 0.012) {
        attempted.add(note.id);
        if (delta >= -0.11) {
          await keyEvent(note.lane, 'rawKeyDown');
          const releaseAt = note.time + (note.duration || 0.045) + 0.025;
          held.set(note.lane, { releaseAt, noteId: note.id });
          attempts.push({ id: note.id, lane: note.lane, noteTime: note.time, duration: note.duration,
            pressedAt: metrics.trackTime, schedulingOffset: metrics.trackTime - note.time, releaseAt });
        }
      }
    }
  }
  await sleep(4);
}
for (const lane of held.keys()) await keyEvent(lane, 'keyUp');
const final = await evaluate(`({ state: window.__pulseTest?.state, metrics: window.__pulseTest?.metrics(),
  track: Player.current?.title, trackId: Player.current?.id, audioTime: Player.audio.currentTime,
  duration: Player.audio.duration, paused: Player.audio.paused, resultText: document.querySelector('.pulse-dialog.result')?.innerText })`);
const offsets = timeline.filter((event) => ['perfect', 'great', 'good'].includes(event.judge)).map((event) => event.offset * 1000);
const stats = offsets.length ? {
  samples: offsets.length,
  meanMs: offsets.reduce((sum, value) => sum + value, 0) / offsets.length,
  meanAbsoluteMs: offsets.reduce((sum, value) => sum + Math.abs(value), 0) / offsets.length,
  minMs: Math.min(...offsets), maxMs: Math.max(...offsets),
} : null;
const report = { initial, final, attempts: attempts.length, stats, timeline, attemptDetails: attempts };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log('RESULT ' + JSON.stringify({ state: final.state, result: final.metrics?.result, track: final.track,
  audioTime: final.audioTime, duration: final.duration, score: final.metrics?.score,
  accuracy: final.metrics?.accuracy, combo: final.metrics?.maxCombo, hits: final.metrics?.hits,
  misses: final.metrics?.misses, holds: final.metrics?.holds, notes: final.metrics?.chartNotes, stats, output }));
socket.close();
if (final.state !== 'result' || final.metrics?.result !== 'complete') process.exitCode = 2;
