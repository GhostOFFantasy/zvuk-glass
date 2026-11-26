import { RhythmChart, DIFFICULTIES } from './rhythm-chart.js';

const LANE_SETS = {
  4: { names: ['D', 'F', 'J', 'K'], codes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
  5: { names: ['D', 'F', 'J', 'K', 'L'], codes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'] },
};
const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'expert'];
const COLORS = ['#bcb2f4', '#ace8d0', '#f3b8cf', '#a8d9f5', '#f2cf8b'];
let laneCount = 4;
let laneNames = LANE_SETS[4].names;
let laneCodes = LANE_SETS[4].codes;
let LOOKAHEAD = 2.15;
let WINDOWS = { perfect: .045, great: .085, good: .15 };
let scoreScale = 1;
const STYLES = [
  { id: 'lunar', name: 'Лунная', hint: 'Базовый образ', color: '#a8d9f5', unlocked: () => true },
  { id: 'signal', name: 'Сигнал', hint: 'Завершить первый трек', color: '#ace8d0', unlocked: (p) => p.clears.length >= 1 },
  { id: 'neon', name: 'Неон', hint: 'Завершить три разных трека', color: '#bcb2f4', unlocked: (p) => p.clears.length >= 3 },
  { id: 'impulse', name: 'Импульс', hint: 'Два трека с точностью от 80%', color: '#f2cf8b', unlocked: (p) => p.eighty.length >= 2 },
  { id: 'resonance', name: 'Резонанс', hint: 'Точность от 90%', color: '#f3b8cf', unlocked: (p) => p.bestAccuracy >= 90 },
  { id: 'eclipse', name: 'Полная серия', hint: 'Трек без пропусков', color: '#e9e6ff', unlocked: (p) => p.fullCombo },
];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const $ = (root, key) => root.querySelector(`[data-pg="${key}"]`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function number(key, fallback, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
  } catch { return fallback; }
}

function loadProgress() {
  try {
    const value = JSON.parse(localStorage.getItem('zg.sync.progress.v1') || '{}');
    return {
      clears: [...new Set((value.clears || []).map(String))].slice(0, 500),
      eighty: [...new Set((value.eighty || []).map(String))].slice(0, 500),
      bestAccuracy: clamp(Number(value.bestAccuracy) || 0, 0, 100),
      bestScore: clamp(Number(value.bestScore) || 0, 0, 999999999),
      bestCombo: clamp(Number(value.bestCombo) || 0, 0, 999999),
      fullCombo: Boolean(value.fullCombo),
    };
  } catch { return { clears: [], eighty: [], bestAccuracy: 0, bestScore: 0, bestCombo: 0, fullCombo: false }; }
}

export function mountPulse(view) {
  let destroyed = false;
  let state = 'title';
  let session = 0;
  let raf = 0;
  let chart = null;
  let notes = [];
  let noteCursor = 0;
  let chartPromise = null;
  let countdownEnd = 0;
  let countdownValue = 0;
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let energy = 55;
  let judged = 0;
  let quality = 0;
  let perfect = 0;
  let great = 0;
  let good = 0;
  let misses = 0;
  let hits = 0;
  let holds = 0;
  let holdTicks = 0;
  let lastJudge = null;
  let lastOffset = 0;
  let unlockedNow = [];
  let difficulty = 'normal';
  try { difficulty = localStorage.getItem('zg.pulse.difficulty') || 'normal'; } catch {}
  if (!DIFFICULTIES[difficulty]) difficulty = 'normal';
  let overdriveUntil = 0;
  let overdriveUsed = false;
  let calibration = number('zg.pulse.offset', 0, -200, 200);
  let sfxEnabled = number('zg.pulse.sfx', 1, 0, 1) === 1;
  let progress = loadProgress();
  let activeStyle = 'lunar';
  try { activeStyle = localStorage.getItem('zg.nova.style') || 'lunar'; } catch {}
  if (!STYLES.some((s) => s.id === activeStyle)) activeStyle = 'lunar';
  const pressed = new Set();
  const activeHolds = new Map();
  const pointerLanes = new Map();
  const effects = [];
  const voices = new Set();
  const analyzer = new RhythmChart();
  const reduced = () => document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const track = Player.current;
  function applyDifficulty(id) {
    const level = DIFFICULTIES[id] || DIFFICULTIES.normal;
    laneCount = level.lanes;
    laneNames = LANE_SETS[laneCount].names;
    laneCodes = LANE_SETS[laneCount].codes;
    LOOKAHEAD = level.lookahead;
    WINDOWS = { ...level.windows };
    scoreScale = level.score;
    overdriveUntil = 0;
    overdriveUsed = false;
  }
  applyDifficulty(difficulty);

  view.innerHTML = `<section class="pulse-shell sync-shell" data-state="title">
    <header class="pulse-head"><div><span class="pulse-kicker">NOVA / МУЗЫКАЛЬНЫЙ ПУЛЬТ</span><h1>NOVA: Синхронизация</h1></div><div class="pulse-head-status"><i></i><span>Ноты следуют аудиопотоку</span></div></header>
    <div class="pulse-layout">
      <section class="pulse-stage sync-stage" aria-label="Четыре дорожки ритм-игры">
        <canvas class="pulse-canvas sync-canvas" tabindex="0" aria-label="Нажимайте ${laneNames.join(' ')} в момент пересечения нот с линией. Длинные ноты удерживайте."></canvas>
        <div class="pulse-hud"><div><small>СЧЁТ</small><b data-pg="score">0</b></div><div><small>СЕРИЯ</small><b data-pg="combo">×0</b></div><div class="pulse-energy"><small>СИНХРОНИЗАЦИЯ <output data-pg="energy">55%</output><output class="sync-overdrive" data-pg="overdrive"></output></small><span role="progressbar" aria-label="Синхронизация" aria-valuemin="0" aria-valuemax="100" aria-valuenow="55" data-pg="energyMeter"><i data-pg="energyBar"></i></span></div></div>
        <div class="sync-judgement" data-pg="judgement" aria-live="polite"></div>
        <div class="sync-chart-info" data-pg="chartInfo">Музыка → чарт → ваши нажатия</div>
        <div class="pulse-overlay" data-pg="overlay"></div>
      </section>
      <aside class="pulse-side">
        <section class="pulse-track"><span class="pulse-side-label">ТЕКУЩИЙ ТРЕК</span><div><img data-pg="cover" alt=""><span><b data-pg="track">${track ? esc(track.title) : 'Трек не выбран'}</b><small data-pg="artist">${track ? esc(artistsText(track.artists)) : 'Запустите музыку перед игрой'}</small></span></div></section>
        <section class="pulse-nova"><div class="pulse-nova-orbit"></div><span class="pulse-nova-mark" data-nova-pose></span><div><b>Нова · координатор</b><p data-pg="nova">Четыре клавиши, одна музыкальная линия. Начнём?</p></div></section>
        <section class="pulse-stats"><div><small>ТОЧНОСТЬ</small><b data-pg="accuracy">—</b></div><div><small>ЛУЧШАЯ СЕРИЯ</small><b data-pg="bestCombo">×${progress.bestCombo}</b></div><div><small>ЗАВЕРШЕНО</small><b data-pg="clears">${progress.clears.length}</b></div></section>
        <section class="sync-wardrobe"><div class="sync-wardrobe-head"><span class="pulse-side-label">СТИЛИ НОВЫ</span><small data-pg="styleCount"></small></div><div class="sync-styles" data-pg="styles"></div></section>
        <section class="pulse-difficulty"><span class="pulse-side-label">СЛОЖНОСТЬ</span><div data-pg="difficulties">${DIFFICULTY_ORDER.map((id) => `<button data-difficulty="${id}" aria-pressed="${id === difficulty}">${DIFFICULTIES[id].label}<small>${DIFFICULTIES[id].lanes === 5 ? '5 клавиш' : '4 клавиши'}</small></button>`).join('')}</div></section>
        <section class="pulse-settings"><label><span>Калибровка ввода <output data-pg="offset">${calibration} мс</output></span><input data-pg="calibration" aria-label="Калибровка игрового тайминга" type="range" min="-200" max="200" step="5" value="${calibration}"></label><button class="pulse-sfx" data-pg-action="sfx" aria-pressed="${sfxEnabled}"><span>Звук попаданий</span><i></i></button><small>Окна точности зависят от уровня · вывод звука учитывается автоматически</small></section>
        <div class="pulse-diagnostics" data-pg="diagnostics">Аудиочасы · не зависят от FPS</div>
      </aside>
    </div>
    <footer class="pulse-controls sync-controls">${laneNames.map((key, i) => `<button data-lane="${i}" aria-label="Дорожка ${key}"><kbd>${key}</kbd><span>${i === 0 ? 'ЛЕВЫЙ' : i === laneCount - 1 ? 'ПРАВЫЙ' : 'ЦЕНТР'}</span></button>`).join('')}<button class="pulse-pause" data-pg-action="pause" title="Пауза (P)">${icon('pause')}<span>Пауза</span></button></footer>
  </section>`;

  const root = view.querySelector('.pulse-shell');
  const stage = root.querySelector('.pulse-stage');
  const canvas = root.querySelector('canvas');
  const context = canvas.getContext('2d');
  const overlay = $(root, 'overlay');
  const stars = Array.from({ length: 54 }, (_, i) => ({ x: ((i * 73) % 101) / 101, y: ((i * 37) % 97) / 97, a: .12 + (i % 5) * .06 }));
  let width = 1;
  let height = 1;
  let dpr = 1;
  let pose = '';
  let lastFrame = performance.now();
  let fps = 60;
  let fpsFrames = 0;
  let fpsAt = performance.now();
  let drawTotal = 0;
  let drawCount = 0;
  let drawMax = 0;
  const judgementEl = $(root, 'judgement');
  const difficultyButtons = [...root.querySelectorAll('[data-difficulty]')];
  const elementCache = new Map();

  function element(key) {
    let el = elementCache.get(key);
    if (!el?.isConnected) {
      el = $(root, key);
      if (el) elementCache.set(key, el);
    }
    return el;
  }
  function text(key, value) {
    const el = element(key);
    if (el && el.textContent !== String(value)) el.textContent = value;
  }

  function accuracy() { return judged ? Math.round(quality / judged * 1000) / 10 : 0; }
  function outputLatency() {
    const value = Number(AudioFX.ctx?.outputLatency);
    return Number.isFinite(value) && value > 0 ? Math.min(.5, value) : 0;
  }
  // Элементные часы минус аппаратная задержка вывода: ноты совпадают со слышимой долей.
  function rawTime() { return Math.max(0, (Player.audio.currentTime || 0) - outputLatency()); }
  function clock() { return rawTime() + calibration / 1000; }
  function setPose(next) {
    if (pose === next) return;
    pose = next;
    const el = root.querySelector('[data-nova-pose]');
    if (el) el.dataset.localPose = next;
    Nova.renderPose?.();
  }

  function unlocked(style) { return style.unlocked(progress); }
  function chooseStyle(id) {
    const style = STYLES.find((item) => item.id === id);
    if (!style || !unlocked(style)) return false;
    activeStyle = id;
    Nova.setStyle?.(id);
    renderStyles();
    text('nova', `Стиль «${style.name}» активен. Нова сменила костюм, позы и орбитальное свечение.`);
    return true;
  }

  function renderStyles() {
    const available = STYLES.filter(unlocked);
    text('styleCount', `${available.length} / ${STYLES.length}`);
    $(root, 'styles').innerHTML = STYLES.map((style) => {
      const open = unlocked(style);
      return `<button class="sync-style${activeStyle === style.id ? ' on' : ''}" data-style="${style.id}" style="--style-color:${style.color}" aria-pressed="${activeStyle === style.id}" ${open ? '' : 'disabled'} title="${esc(style.hint)}"><span class="sync-style-art"><img src="assets/nova/styles/${style.id}/concept.webp" alt="" loading="lazy"></span><span><b>${style.name}</b><small>${open ? style.hint : icon('lock') + style.hint}</small></span>${activeStyle === style.id ? icon('check') : ''}</button>`;
    }).join('');
    root.dataset.novaStyle = activeStyle;
  }

  function updateTrack() {
    const current = Player.current;
    text('track', current?.title || 'Трек не выбран');
    text('artist', current ? artistsText(current.artists) : 'Запустите музыку перед игрой');
    const src = current && typeof cover === 'function' ? cover(current, 300) : '';
    const image = $(root, 'cover');
    if (image.getAttribute('src') !== src) src ? image.src = src : image.removeAttribute('src');
  }

  function updateHud() {
    text('score', Math.round(score).toLocaleString('ru-RU'));
    text('combo', `×${combo}`);
    text('accuracy', judged ? `${accuracy().toLocaleString('ru-RU')}%` : '—');
    text('energy', `${Math.round(energy)}%`);
    text('bestCombo', `×${Math.max(maxCombo, progress.bestCombo)}`);
    text('clears', progress.clears.length);
    const meter = element('energyMeter');
    if (meter && meter.getAttribute('aria-valuenow') !== String(Math.round(energy))) meter.setAttribute('aria-valuenow', String(Math.round(energy)));
    const bar = element('energyBar');
    if (bar && bar.style.width !== `${energy}%`) bar.style.width = `${energy}%`;
    root.classList.toggle('is-low-energy', energy < 25);
    const overdriving = overdriveUntil > rawTime();
    const multiplier = overdriving ? '2' : String(Math.min(6, 1 + Math.floor(combo / 10)));
    const energyElement = element('energy');
    if (energyElement?.parentElement.dataset.multiplier !== multiplier) energyElement.parentElement.dataset.multiplier = multiplier;
    root.classList.toggle('is-overdrive', overdriving);
    text('overdrive', overdriving ? `OVERDRIVE ×2 · ${Math.max(1, Math.ceil(overdriveUntil - rawTime()))} с` : '');
    root.dataset.difficulty = difficulty;
    difficultyButtons.forEach((button) => {
      const value = String(button.dataset.difficulty === difficulty);
      if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
    });
    if (chart) text('chartInfo', `${DIFFICULTIES[difficulty].label} · ${chart.notes.length} нот · ${chart.onsets} атак · ≈ ${chart.bpm} BPM · −${Math.round(outputLatency() * 1000)} мс вывод`);
    const next = nextNote();
    if (state === 'play') {
      const diagnostics = element('diagnostics');
      const value = `${fps} FPS · ${next ? `следующая ${laneNames[next.lane]} · ${Math.max(0, next.time - rawTime()).toFixed(2)} с` : 'финиш'} · ${chart?.method || 'чарт'}`;
      if (diagnostics && diagnostics.textContent !== value) diagnostics.textContent = value;
    }
  }

  function resetStats() {
    noteCursor = 0;
    score = combo = maxCombo = judged = quality = perfect = great = good = misses = hits = holds = holdTicks = 0;
    energy = 55;
    lastJudge = null;
    lastOffset = 0;
    unlockedNow = [];
    overdriveUntil = 0;
    overdriveUsed = false;
    pressed.clear();
    activeHolds.clear();
    effects.length = 0;
    if (chart) notes = chart.notes.map((note) => ({ ...note, state: 'pending', judgement: null }));
    else notes = [];
    delete root.dataset.result;
    updateHud();
  }

  function setState(next) {
    state = next;
    root.dataset.state = next;
    for (const button of root.querySelectorAll('[data-lane]')) button.disabled = next !== 'play';
    const pause = root.querySelector('[data-pg-action="pause"]');
    pause.disabled = !['play', 'countdown', 'pause'].includes(next);
    pause.querySelector('span').textContent = next === 'pause' ? 'Далее' : 'Пауза';
    if (next === 'title') {
      setPose('idle');
      overlay.innerHTML = `<div class="pulse-dialog"><span class="pulse-kicker">ПЕСНЯ СТАНОВИТСЯ ЧАРТОМ</span><h2>Поймайте<br>ритм вместе</h2><p>Нажимайте <b>${laneNames.join(' ')}</b>, когда ноты коснутся световой линии. Длинные лучи удерживайте до конца. Точность оценивается по времени самой песни.</p>${Player.current ? '<button class="pulse-primary" data-pg-action="start">Синхронизировать</button>' : '<button class="pulse-primary" data-pg-action="music">Сначала выбрать музыку</button>'}<small>Короткие ноты и удержания · P — пауза · стили открываются за прохождение</small></div>`;
    } else if (next === 'prepare') {
      setPose('listening');
      overlay.innerHTML = '<div class="pulse-dialog compact"><span class="pulse-kicker">АНАЛИЗ АУДИОПОТОКА</span><h2>Слушаю вперёд</h2><p data-pg="prepareText">Читаю аудиопоток</p><div class="sync-prepare-meter"><i data-pg="prepareBar"></i></div><small>Атаки, бас и частоты превращаются в ноты до начала игры.</small></div>';
    } else if (next === 'countdown') {
      setPose('listening');
      countdownValue = 0;
      overlay.innerHTML = `<div class="pulse-countdown"><small>СИНХРОНИЗАЦИЯ</small><b data-pg="count">3</b><span>${laneNames.join(' ')} — нажатие · длинный луч — удержание</span></div>`;
    } else if (next === 'play') overlay.innerHTML = '';
    else if (next === 'pause') {
      setPose('pause');
      overlay.innerHTML = '<div class="pulse-dialog compact"><span class="pulse-kicker">АУДИОЧАСЫ ОСТАНОВЛЕНЫ</span><h2>Пауза</h2><p>Музыка, ноты и удержания остановлены в одной точке.</p><button class="pulse-primary" data-pg-action="resume">Продолжить</button><button class="pulse-secondary" data-pg-action="restart">Начать заново</button><button class="pulse-secondary" data-pg-action="title">Вернуться к описанию</button></div>';
    } else if (next === 'result') {
      const won = root.dataset.result === 'complete';
      setPose(won ? 'delighted' : 'help');
      const unlockHtml = unlockedNow.length ? `<div class="sync-unlocks">Открыто: ${unlockedNow.map((id) => `<b>${STYLES.find((s) => s.id === id).name}</b>`).join('')}</div>` : '';
      overlay.innerHTML = `<div class="pulse-dialog result"><span class="pulse-kicker">${won ? 'ТРЕК СИНХРОНИЗИРОВАН' : 'СИНХРОНИЗАЦИЯ ПОТЕРЯНА'}</span><h2>${won ? 'Ритм пойман' : 'Ещё одна попытка'}</h2><div class="pulse-result-score">${Math.round(score).toLocaleString('ru-RU')}<small>ОЧКОВ</small></div><p>Точность ${accuracy().toLocaleString('ru-RU')}% · лучшая серия ×${maxCombo}<br>Идеально ${perfect} · точно ${great} · хорошо ${good} · пропуски ${misses}</p>${unlockHtml}<button class="pulse-primary" data-pg-action="restart">Ещё раз</button><button class="pulse-secondary" data-pg-action="title">К описанию и стилям</button></div>`;
    }
    for (const button of overlay.querySelectorAll('[data-pg-action]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
      });
    }
    updateHud();
    if (next !== 'pause') startLoop();
  }

  async function prepare() {
    if (!Player.current) throw new Error('Сначала выберите трек');
    const key = `${Player.current.id}:${Player.audio.src}:${difficulty}`;
    if (chart && chart.key === key) return chart;
    if (chartPromise?.key === key) return chartPromise.promise;
    const sourceTrack = Player.current;
    const promise = analyzer.load(sourceTrack, Player.audio, (value, label) => {
      if (destroyed) return;
      text('prepareText', label);
      const bar = $(root, 'prepareBar');
      if (bar) bar.style.width = `${Math.round(value * 100)}%`;
    }, difficulty).then((value) => {
      if (!destroyed && Player.current === sourceTrack && `${Player.current?.id}:${Player.audio.src}:${difficulty}` === key) {
        value.key = key;
        chart = value;
        notes = chart.notes.map((note) => ({ ...note, state: 'pending' }));
      }
      return value;
    }).finally(() => { if (chartPromise?.key === key) chartPromise = null; });
    chartPromise = { key, promise };
    return promise;
  }

  async function begin() {
    if (destroyed || ['prepare', 'countdown'].includes(state)) return false;
    if (!Player.current) { toast('Сначала включите трек', { iconName: 'note' }); return false; }
    activeTrackId = String(Player.current.id);
    const token = ++session;
    resetStats();
    setState('prepare');
    try {
      if (!Player.audio.src) {
        Player.playAt(Player.index);
        for (let i = 0; i < 100 && !Player.audio.src; i++) await wait(100);
      }
      await prepare();
      if (destroyed || token !== session) return false;
      if (!notes.length) throw new Error('В этом фрагменте не найдено подходящих атак. Попробуйте другой трек.');
      resetStats();
      Player.seek(0);
      Player.pause();
      countdownEnd = performance.now() + 3000;
      setState('countdown');
      AudioFX.ctx?.resume().catch(() => {});
      text('nova', 'Чарт готов. Слушайте атаку и встречайте ноту на нижней линии.');
      Nova.game?.('start');
      return true;
    } catch (error) {
      if (destroyed || token !== session) return false;
      setState('title');
      text('nova', error.message || 'Не удалось прочитать этот аудиопоток.');
      toast(error.message || 'Не удалось построить чарт', { error: true });
      return false;
    }
  }

  function pause(pauseAudio = true) {
    if (!['play', 'countdown'].includes(state)) return false;
    pausedFrom = state;
    countdownRemaining = state === 'countdown' ? Math.max(0, countdownEnd - performance.now()) : 0;
    clearInput();
    setState('pause');
    if (pauseAudio) Player.pause();
    text('nova', 'Остановила музыку и чарт в одной точке. Продолжим с этой же ноты.');
    Nova.game?.('pause');
    return true;
  }
  let pausedFrom = 'play';
  let countdownRemaining = 0;

  function resume() {
    if (state !== 'pause' || destroyed) return false;
    if (pausedFrom === 'countdown') {
      countdownEnd = performance.now() + countdownRemaining;
      setState('countdown');
      Player.pause();
    } else {
      setState('play');
      Player.play();
    }
    lastFrame = performance.now();
    AudioFX.ctx?.resume().catch(() => {});
    text('nova', 'Продолжаем. Музыкальные часы снова ведут ноты.');
    startLoop();
    return true;
  }

  function finish(completed = true) {
    if (destroyed || state === 'result') return false;
    const before = { ...progress, clears: [...progress.clears], eighty: [...progress.eighty] };
    clearInput();
    root.dataset.result = completed ? 'complete' : 'interrupted';
    if (completed) {
      const id = String(Player.current?.id || 'unknown');
      if (!progress.clears.includes(id)) progress.clears.push(id);
      if (accuracy() >= 80 && !progress.eighty.includes(id)) progress.eighty.push(id);
      progress.bestAccuracy = Math.max(progress.bestAccuracy, accuracy());
      progress.fullCombo ||= judged === notes.length && notes.length > 0 && misses === 0;
    }
    progress.bestScore = Math.max(progress.bestScore, Math.round(score));
    progress.bestCombo = Math.max(progress.bestCombo, maxCombo);
    unlockedNow = STYLES.filter((style) => unlocked(style) && !style.unlocked(before)).map((style) => style.id);
    try { localStorage.setItem('zg.sync.progress.v1', JSON.stringify(progress)); } catch {}
    renderStyles();
    setState('result');
    Player.pause();
    tone(completed ? 'complete' : 'miss');
    text('nova', completed ? 'Трек завершён. Новые орбитальные стили уже ждут в вашей коллекции.' : 'Связь сбилась. Попробуйте ещё раз — спокойный темп поможет поймать серию.');
    Nova.game?.('result', { score, combo: maxCombo });
    return true;
  }

  function advanceNoteCursor() {
    while (noteCursor < notes.length && ['hit', 'miss', 'skipped'].includes(notes[noteCursor].state)) noteCursor++;
  }
  function nextNote(lane = null) {
    for (let i = noteCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.state === 'pending' && (lane == null || note.lane === lane)) return note;
    }
    return null;
  }

  function judge(note, kind, offset) {
    const weight = kind === 'perfect' ? 1 : kind === 'great' ? .85 : .6;
    judged++;
    quality += weight;
    hits++;
    if (kind === 'perfect') perfect++;
    else if (kind === 'great') great++;
    else good++;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    energy = clamp(energy + (kind === 'perfect' ? 1.5 : 1), 0, 100);
    if (!overdriveUsed && energy >= 100 && combo >= 10) {
      overdriveUntil = rawTime() + 8;
      overdriveUsed = true;
      energy = 70;
    }
    const multiplier = overdriveUntil > rawTime() ? 2 : 1;
    score += Math.round((kind === 'perfect' ? 1000 : kind === 'great' ? 700 : 400) * (1 + Math.min(2, combo / 40)) * scoreScale * multiplier);
    note.judgement = kind;
    lastJudge = kind;
    lastOffset = offset;
    note.state = note.duration ? 'holding' : 'hit';
    if (note.duration) { activeHolds.set(note.lane, note); holds++; }
    effects.push({ lane: note.lane, at: performance.now(), kind });
    tone(kind);
    if ([10, 25, 50, 100].includes(combo)) {
      setPose('delighted');
      text('nova', `Серия ×${combo}. Вы с музыкой на одной частоте!`);
      Nova.game?.('combo', { combo });
    } else if (combo === 1) setPose('listening');
  }

  function miss(note, broken = false) {
    if (!note || ['hit', 'miss'].includes(note.state)) return;
    note.state = 'miss';
    note.judgement = broken ? 'broken' : 'miss';
    activeHolds.delete(note.lane);
    judged++;
    misses++;
    combo = 0;
    energy = clamp(energy - (broken ? 5 : 7), 0, 100);
    lastJudge = broken ? 'broken' : 'miss';
    lastOffset = 0;
    setPose('help');
    text('nova', broken ? 'Длинный луч оборвался. Удерживайте клавишу до самого конца.' : 'Немного мимо. Смотрите на линию и слушайте следующую атаку.');
    tone('miss');
    if (energy <= 0) finish(false);
  }

  function press(lane, forcedTime = null) {
    if (state !== 'play' || destroyed || pressed.has(lane)) return false;
    pressed.add(lane);
    const time = forcedTime == null ? clock() : forcedTime;
    const suspended = notes.find((note) => note.lane === lane && note.state === 'holding');
    if (suspended) {
      if (time <= suspended.time + suspended.duration + WINDOWS.good) {
        activeHolds.set(lane, suspended);
        lastJudge = 'hold';
        return true;
      }
      miss(suspended, true);
      return false;
    }
    let target = null;
    let distance = Infinity;
    for (let i = noteCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.lane !== lane || note.state !== 'pending') continue;
      const delta = time - note.time;
      if (Math.abs(delta) <= WINDOWS.good && Math.abs(delta) < distance) { target = note; distance = Math.abs(delta); }
      if (note.time > time + WINDOWS.good) break;
    }
    if (!target) { judgeEmpty(lane); return false; }
    const offset = time - target.time;
    const kind = distance <= WINDOWS.perfect ? 'perfect' : distance <= WINDOWS.great ? 'great' : 'good';
    judge(target, kind, offset);
    return true;
  }

  function judgeEmpty(lane) {
    combo = 0;
    energy = clamp(energy - 1.2, 0, 100);
    lastJudge = 'empty';
    effects.push({ lane, at: performance.now(), kind: 'empty' });
    if (energy <= 0) finish(false);
  }

  function release(lane) {
    pressed.delete(lane);
    const note = activeHolds.get(lane);
    if (note && clock() < note.time + note.duration - WINDOWS.good) miss(note, true);
  }

  function clearInput() {
    pressed.clear();
    activeHolds.clear();
    pointerLanes.clear();
    for (const button of root.querySelectorAll('[data-lane].pressed')) button.classList.remove('pressed');
  }

  function update(time) {
    if (state !== 'play') return;
    if (overdriveUntil && time >= overdriveUntil) overdriveUntil = 0;
    advanceNoteCursor();
    for (let i = noteCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.state === 'pending' && note.time > time + WINDOWS.good) break;
      if (note.state === 'pending' && time > note.time + WINDOWS.good) miss(note);
      if (state !== 'play') return;
      if (note.state === 'holding') {
        const end = note.time + note.duration;
        if (!activeHolds.has(note.lane)) {
          if (time > end + WINDOWS.good) miss(note, true);
          continue;
        }
        if (time >= end) {
          note.state = 'hit';
          activeHolds.delete(note.lane);
          score += 350 + Math.round(note.duration * 300);
          energy = clamp(energy + 2, 0, 100);
          lastJudge = 'hold';
        } else {
          const tick = Math.floor(clamp((time - note.time) / note.duration, 0, 1) * 10);
          if (tick > (note.ticks || 0)) { score += (tick - (note.ticks || 0)) * 30; holdTicks += tick - (note.ticks || 0); note.ticks = tick; }
        }
      }
    }
    const last = notes[notes.length - 1];
    const duration = Number(Player.audio.duration) || chart?.duration || 0;
    const audioTime = Number(Player.audio.currentTime) || 0;
    if (duration > 0) {
      if (Player.audio.ended || audioTime >= duration - .03) finish(true);
    } else if (last && rawTime() > last.time + last.duration + 1.25) finish(true);
  }

  function tone(kind) {
    if (!sfxEnabled || !AudioFX.ctx || AudioFX.ctx.state !== 'running') return;
    const ctx = AudioFX.ctx;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = ctx.currentTime;
    const frequency = { perfect: 880, great: 660, good: 520, miss: 120, complete: 740 }[kind] || 420;
    oscillator.type = kind === 'miss' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    if (kind === 'complete') oscillator.frequency.exponentialRampToValueAtTime(1100, at + .25);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(kind === 'miss' ? .012 : .018, at + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, at + (kind === 'complete' ? .32 : .09));
    oscillator.connect(gain).connect(ctx.destination);
    voices.add(oscillator);
    oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(at);
    oscillator.stop(at + .35);
  }

  const staticLayer = document.createElement('canvas');
  const staticContext = staticLayer.getContext('2d');
  let staticBuilds = 0;

  // Неоновый фон, звёзды, полотно и разметка неизменны между кадрами — рисуем их один раз.
  function renderStatic() {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    const target = staticContext;
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = target.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#23dce5'); bg.addColorStop(.35, '#563cd1'); bg.addColorStop(.7, '#ed369c'); bg.addColorStop(1, '#6820b6');
    target.fillStyle = bg; target.fillRect(0, 0, width, height);
    target.save();
    target.lineWidth = Math.max(22, width * .055);
    target.strokeStyle = '#fff228'; target.shadowColor = '#ffde2b'; target.shadowBlur = 22;
    target.beginPath(); target.ellipse(width * .15, height * .17, width * .34, height * .48, -.65, .1, Math.PI * 1.48); target.stroke();
    target.lineWidth = Math.max(15, width * .032); target.strokeStyle = '#42f6ee'; target.shadowColor = '#42f6ee';
    target.beginPath(); target.ellipse(width * .77, height * .05, width * .42, height * .36, .55, .1, Math.PI * 1.55); target.stroke();
    target.lineWidth = Math.max(22, width * .06); target.strokeStyle = '#fa62c0'; target.shadowColor = '#fa62c0';
    target.beginPath(); target.ellipse(width * .97, height * .55, width * .32, height * .54, .36, 1.7, Math.PI * 1.94); target.stroke();
    target.restore();
    for (const star of stars) {
      const size = 1 + star.a * 10;
      target.fillStyle = `rgba(255,255,255,${Math.min(.9, star.a + .15)})`;
      target.fillRect(star.x * width, star.y * height * .58, size, size);
    }
    const laneWidth = Math.min(width * .74, 600);
    const left = (width - laneWidth) / 2;
    const horizon = Math.max(67, height * .145);
    const hitY = height - Math.max(88, height * .17);
    const topWidth = laneWidth * .38;
    const trackGradient = target.createLinearGradient(0, horizon, 0, height);
    trackGradient.addColorStop(0, '#111129'); trackGradient.addColorStop(.55, '#21134f'); trackGradient.addColorStop(1, '#352078');
    target.save(); target.shadowColor = 'rgba(197,77,255,.7)'; target.shadowBlur = 28;
    target.fillStyle = trackGradient; target.beginPath();
    target.moveTo(left + (laneWidth - topWidth) / 2, horizon); target.lineTo(left + (laneWidth + topWidth) / 2, horizon);
    target.lineTo(left + laneWidth, height + 2); target.lineTo(left, height + 2); target.closePath(); target.fill(); target.restore();
    for (let lane = 0; lane < laneCount; lane++) {
      const bottomL = left + laneWidth * lane / laneCount;
      const topL = left + (laneWidth - topWidth) / 2 + topWidth * lane / laneCount;
      target.strokeStyle = 'rgba(205,175,255,.16)'; target.lineWidth = 1;
      target.beginPath(); target.moveTo(topL, horizon); target.lineTo(bottomL, height); target.stroke();
    }
    for (let row = 1; row < 12; row++) {
      const p = Math.pow(row / 12, 1.65), y = horizon + p * (hitY - horizon);
      const currentWidth = topWidth + (laneWidth - topWidth) * p;
      target.strokeStyle = 'rgba(194,163,255,.055)'; target.beginPath(); target.moveTo((width - currentWidth) / 2, y); target.lineTo((width + currentWidth) / 2, y); target.stroke();
    }
    staticBuilds++;
  }

  function draw(now) {
    context.clearRect(0, 0, width, height);
    context.drawImage(staticLayer, 0, 0, width, height);
    const laneWidth = Math.min(width * .74, 600);
    const left = (width - laneWidth) / 2;
    const horizon = Math.max(67, height * .145);
    const hitY = height - Math.max(88, height * .17);
    const topWidth = laneWidth * .38;
    const time = state === 'pause' ? pauseDrawTime : clock();
    const pulse = effects.length && !reduced() ? Math.max(0, 1 - (now - effects[effects.length - 1].at) / 280) : 0;
    for (let lane = 0; lane < laneCount; lane++) {
      const bottomL = left + laneWidth * lane / laneCount;
      const bottomR = left + laneWidth * (lane + 1) / laneCount;
      const topL = left + (laneWidth - topWidth) / 2 + topWidth * lane / laneCount;
      const topR = left + (laneWidth - topWidth) / 2 + topWidth * (lane + 1) / laneCount;
      context.fillStyle = pressed.has(lane) ? 'rgba(246,113,255,.16)' : lane % 2 ? 'rgba(4,0,26,.12)' : 'rgba(255,255,255,.025)';
      context.beginPath(); context.moveTo(topL, horizon); context.lineTo(topR, horizon); context.lineTo(bottomR, hitY + 30); context.lineTo(bottomL, hitY + 30); context.closePath(); context.fill();
    }
    context.save(); context.shadowColor = '#fa8aff'; context.shadowBlur = 13 + pulse * 20;
    context.strokeStyle = `rgba(255,146,252,${.6 + pulse * .4})`; context.lineWidth = 3;
    context.beginPath(); context.moveTo(left - 3, hitY); context.lineTo(left + laneWidth + 3, hitY); context.stroke(); context.restore();
    const keyRadiusX = laneWidth / laneCount * .34;
    for (let lane = 0; lane < laneCount; lane++) {
      const keyX = left + laneWidth * (lane + .5) / laneCount;
      context.save(); context.shadowColor = COLORS[lane]; context.shadowBlur = pressed.has(lane) ? 24 : 9;
      context.fillStyle = pressed.has(lane) ? COLORS[lane] : '#25144e'; context.strokeStyle = COLORS[lane]; context.lineWidth = 2.5;
      context.beginPath(); context.ellipse(keyX, hitY, keyRadiusX, 9, 0, 0, Math.PI * 2); context.fill(); context.stroke();
      context.fillStyle = pressed.has(lane) ? '#28113e' : '#f3dcff'; context.font = '700 11px Inter, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(laneNames[lane], keyX, hitY + 22); context.restore();
    }
    if (state === 'play' || state === 'pause') {
      for (let i = noteCursor; i < notes.length; i++) {
        const note = notes[i];
        if (['hit', 'miss', 'skipped'].includes(note.state)) continue;
        const until = note.time - time;
        if (until > LOOKAHEAD) break;
        const holding = note.state === 'holding';
        if (holding ? time > note.time + note.duration + Math.max(.18, WINDOWS.good + .04) : until < -Math.max(.18, WINDOWS.good + .04)) continue;
        const p = holding ? 1 : clamp(1 - until / LOOKAHEAD, 0, 1);
        const eased = Math.pow(p, 1.65);
        const y = horizon + eased * (hitY - horizon);
        const currentWidth = topWidth + (laneWidth - topWidth) * eased;
        const currentLeft = left + (laneWidth - currentWidth) / 2;
        const x = currentLeft + currentWidth * (note.lane + .5) / laneCount;
        const noteWidth = currentWidth / laneCount * .62;
        const noteHeight = 6 + eased * 11;
        context.save();
        context.shadowColor = '#ef59fa'; context.shadowBlur = holding ? 24 : 12;
        if (note.duration) {
          const endP = clamp(1 - (note.time + note.duration - time) / LOOKAHEAD, 0, 1);
          const endY = horizon + Math.pow(endP, 1.65) * (hitY - horizon);
          const trail = context.createLinearGradient(0, endY, 0, y);
          trail.addColorStop(0, 'rgba(173,81,255,.25)'); trail.addColorStop(1, 'rgba(255,114,252,.85)');
          context.fillStyle = trail; roundedRect(x - noteWidth * .22, Math.min(y, endY), noteWidth * .44, Math.max(5, Math.abs(y - endY)), 5); context.fill();
        }
        context.fillStyle = '#6721a8'; roundedRect(x - noteWidth / 2, y - noteHeight / 2 + 3, noteWidth, noteHeight, noteHeight / 2); context.fill();
        const noteGradient = context.createLinearGradient(0, y - noteHeight / 2, 0, y + noteHeight / 2);
        noteGradient.addColorStop(0, holding ? '#fffaff' : '#ffd2ff'); noteGradient.addColorStop(.38, holding ? '#e9fcff' : '#ed83fb'); noteGradient.addColorStop(1, '#9c35d6');
        context.fillStyle = noteGradient; context.strokeStyle = '#ffe0ff'; context.lineWidth = 1.2;
        roundedRect(x - noteWidth / 2, y - noteHeight / 2, noteWidth, noteHeight, noteHeight / 2); context.fill(); context.stroke();
        context.fillStyle = 'rgba(255,255,255,.8)'; roundedRect(x - noteWidth * .33, y - noteHeight * .3, noteWidth * .66, 1.6, 1); context.fill();
        context.restore();
      }
    }
    const judgement = judgementEl;
    if (lastJudge && state === 'play') {
      const labels = { perfect: 'ИДЕАЛЬНО', great: 'ТОЧНО', good: 'ХОРОШО', miss: 'ПРОПУСК', broken: 'ЛУЧ ОБОРВАН', empty: 'МИМО ДОЛИ', hold: 'ЛУЧ ЗАВЕРШЁН' };
      const colors = { perfect: '#ace8d0', great: '#bcb2f4', good: '#a8d9f5', miss: '#f3b8cf', broken: '#f3b8cf', empty: '#85919d', hold: '#ace8d0' };
      const value = `${labels[lastJudge] || ''}${lastOffset && ['perfect', 'great', 'good'].includes(lastJudge) ? ` · ${lastOffset > 0 ? '+' : ''}${Math.round(lastOffset * 1000)} мс` : ''}`;
      if (judgement.textContent !== value) judgement.textContent = value;
      if (judgement.dataset.kind !== lastJudge) {
        judgement.style.color = colors[lastJudge] || '#fff';
        judgement.dataset.kind = lastJudge;
      }
    } else if (judgement.textContent) judgement.textContent = '';
  }

  function roundedRect(x, y, w, h, r) {
    context.beginPath(); context.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  function resize() {
    width = Math.max(1, stage.clientWidth); height = Math.max(1, stage.clientHeight);
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderStatic();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  let pauseDrawTime = 0;
  function frame(now) {
    raf = 0;
    if (destroyed || document.hidden) return;
    const dt = Math.min(.05, (now - lastFrame) / 1000);
    lastFrame = now;
    fpsFrames++;
    if (now - fpsAt > 900) { fps = Math.round(fpsFrames * 1000 / (now - fpsAt)); fpsFrames = 0; fpsAt = now; }
    if (state === 'countdown') {
      const left = countdownEnd - now;
      const count = Math.max(1, Math.ceil(left / 1000));
      if (count !== countdownValue) { countdownValue = count; text('count', count); tone('good'); }
      if (left <= 0) { setState('play'); setPose('listening'); Player.play(); }
    }
    if (state === 'play') update(clock());
    if (state === 'pause' && !pauseDrawTime) pauseDrawTime = clock();
    if (state !== 'pause') pauseDrawTime = 0;
    const drawStarted = performance.now();
    draw(now);
    const drawElapsed = performance.now() - drawStarted;
    drawTotal += drawElapsed;
    drawCount++;
    drawMax = Math.max(drawMax, drawElapsed);
    if (now - (frame.lastHud || 0) > 100) { updateHud(); frame.lastHud = now; }
    if (state !== 'pause') raf = requestAnimationFrame(frame);
  }
  function startLoop() { if (!raf && !destroyed && !document.hidden) { lastFrame = performance.now(); raf = requestAnimationFrame(frame); } }

  function restart() { session++; return begin(); }
  function showTitle() { session++; clearInput(); setState('title'); Player.pause(); }
  function toggleSfx(button) {
    sfxEnabled = !sfxEnabled;
    button.setAttribute('aria-pressed', String(sfxEnabled));
    try { localStorage.setItem('zg.pulse.sfx', sfxEnabled ? '1' : '0'); } catch {}
    if (!sfxEnabled) for (const voice of voices) { try { voice.stop(); } catch {} }
    else tone('good');
  }

  function onClick(event) {
    const difficultyButton = event.target.closest('button[data-difficulty]');
    if (difficultyButton && root.contains(difficultyButton)) { chooseDifficulty(difficultyButton.dataset.difficulty); return; }
    const styleButton = event.target.closest('[data-style]');
    if (styleButton && root.contains(styleButton)) { chooseStyle(styleButton.dataset.style); return; }
    const button = event.target.closest('[data-pg-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.pgAction;
    if (action === 'start') begin();
    else if (action === 'restart') restart();
    else if (action === 'resume') resume();
    else if (action === 'pause') state === 'pause' ? resume() : pause();
    else if (action === 'title') showTitle();
    else if (action === 'music') App.navigate('wave');
    else if (action === 'sfx') toggleSfx(button);
  }

  function onKeyDown(event) {
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const lane = laneCodes.indexOf(event.code);
    if (lane < 0 && !['KeyP', 'Escape', 'Enter', 'Space'].includes(event.code)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.code === 'KeyP' || event.code === 'Escape') { state === 'pause' ? resume() : pause(); return; }
    if (event.code === 'Enter' || event.code === 'Space') {
      if (state === 'title') begin(); else if (state === 'pause') resume(); else if (state === 'result') restart();
      return;
    }
    if (lane >= 0) { root.querySelector(`[data-lane="${lane}"]`)?.classList.add('pressed'); press(lane); }
  }
  function onKeyUp(event) {
    const lane = laneCodes.indexOf(event.code);
    if (lane < 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    root.querySelector(`[data-lane="${lane}"]`)?.classList.remove('pressed'); release(lane);
  }

  let laneCleanups = [];
  function bindLaneButtons() {
    laneCleanups.forEach((cleanup) => cleanup());
    laneCleanups = [];
    root.querySelector('.sync-controls').innerHTML = `${laneNames.map((key, i) => `<button data-lane="${i}" aria-label="Дорожка ${key}"><kbd>${key}</kbd><span>${i === 0 ? 'ЛЕВЫЙ' : i === laneCount - 1 ? 'ПРАВЫЙ' : 'ЦЕНТР'}</span></button>`).join('')}<button class="pulse-pause" data-pg-action="pause" title="Пауза (P)">${icon('pause')}<span>Пауза</span></button>`;
    for (const button of root.querySelectorAll('[data-lane]')) {
      const lane = Number(button.dataset.lane);
      const down = (event) => { if (state !== 'play') return; event.preventDefault(); button.setPointerCapture(event.pointerId); pointerLanes.set(event.pointerId, lane); button.classList.add('pressed'); press(lane); };
      const up = (event) => { if (pointerLanes.get(event.pointerId) !== lane) return; pointerLanes.delete(event.pointerId); button.classList.remove('pressed'); release(lane); };
      button.addEventListener('pointerdown', down); button.addEventListener('pointerup', up); button.addEventListener('pointercancel', up);
      laneCleanups.push(() => { button.removeEventListener('pointerdown', down); button.removeEventListener('pointerup', up); button.removeEventListener('pointercancel', up); });
    }
    renderStatic();
  }
  function chooseDifficulty(id) {
    if (!DIFFICULTIES[id] || id === difficulty) return;
    difficulty = id;
    try { localStorage.setItem('zg.pulse.difficulty', id); } catch {}
    session++;
    chart = null;
    notes = [];
    chartPromise = null;
    applyDifficulty(id);
    bindLaneButtons();
    clearInput();
    resetStats();
    setState('title');
  }
  bindLaneButtons();

  let activeTrackId = String(track?.id || '');
  function onTrackEvent() {
    const id = String(Player.current?.id || '');
    if (id === activeTrackId && ['prepare', 'countdown'].includes(state)) {
      updateTrack();
      return;
    }
    activeTrackId = id;
    session++;
    chart = null;
    notes = [];
    chartPromise = null;
    resetStats();
    updateTrack();
    setState('title');
  }
  function onStateEvent() {
    if (Player.audio.ended && state === 'play') { finish(true); return; }
    if (!Player.playing && state === 'play') pause(false);
  }
  function onSeekEvent() {
    if (!['play', 'pause'].includes(state)) return;
    clearInput();
    score = combo = maxCombo = judged = quality = perfect = great = good = misses = hits = holds = holdTicks = 0;
    energy = 55;
    for (const note of notes) { note.state = note.time < rawTime() - .12 ? 'skipped' : 'pending'; note.judgement = null; note.ticks = 0; }
    noteCursor = 0;
    updateHud();
  }
  function onVisibility() { if (document.hidden) { if (['play', 'countdown'].includes(state)) pause(true); cancelAnimationFrame(raf); raf = 0; } else startLoop(); }
  function onCalibrationInput(event) { calibration = clamp(Number(event.target.value) || 0, -200, 200); text('offset', `${calibration} мс`); }
  function onCalibrationChange() {
    try { localStorage.setItem('zg.pulse.offset', String(calibration)); } catch {}
    text('nova', `Поправка ${calibration >= 0 ? '+' : ''}${calibration} мс применена к нажатиям. Аудиопоток не изменён.`);
    Nova.game?.('calibration');
  }

  root.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown, true); window.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('visibilitychange', onVisibility);
  Player.events.addEventListener('track', onTrackEvent); Player.events.addEventListener('state', onStateEvent); Player.events.addEventListener('seek', onSeekEvent);
  $(root, 'calibration').addEventListener('input', onCalibrationInput); $(root, 'calibration').addEventListener('change', onCalibrationChange);
  updateTrack(); renderStyles();
  if (!chooseStyle(activeStyle)) chooseStyle('lunar');
  setState('title'); startLoop();
  if (Player.current && Player.audio.src) prepare().catch(() => {});

  const api = {
    get state() { return state; },
    setDifficulty: chooseDifficulty,
    start: begin, restart, pause, resume, finish,
    resetFixture() { resetStats(); Player.seek(0); },
    hit: (lane, time) => press(Number(lane), time),
    release,
    async perfectNext() {
      const note = nextNote();
      if (!note) return false;
      Player.seek(Math.max(0, note.time - .06));
      await wait(75);
      const hit = press(note.lane);
      if (note.duration) { await wait((note.duration + .18) * 1000); release(note.lane); }
      return hit;
    },
    inject(lane = 0, time = rawTime(), duration = 0) {
      const note = { id: Math.max(0, ...notes.map((n) => n.id)) + 1, lane: clamp(Number(lane) || 0, 0, laneCount - 1), time: Number(time), duration: Number(duration) || 0, state: 'pending', judgement: null };
      notes.push(note); notes.sort((a, b) => a.time - b.time); noteCursor = 0; return note.id;
    },
    progress: () => ({ ...progress, clears: [...progress.clears], eighty: [...progress.eighty], activeStyle }),
    metrics: () => ({
      state, result: root.dataset.result || null, fps, score: Math.round(score), combo, maxCombo, energy, accuracy: accuracy(), judged, perfect, great, good, hits, misses, holds, holdTicks,
      pending: notes.filter((n) => n.state === 'pending').length, holding: notes.filter((n) => n.state === 'holding').length, skipped: notes.filter((n) => n.state === 'skipped').length,
      activeHolds: activeHolds.size, chartNotes: notes.length, onsets: chart?.onsets || 0,
      method: chart?.method || null, bpm: chart?.bpm || null, inferred: chart?.inferred || 0, calibration, sfxEnabled, trackTime: rawTime(), judgedTime: clock(), lastJudge, lastOffset,
      difficulty, laneCount, outputLatency: outputLatency(), overdriveUntil, scoreScale,
      drawAvg: drawCount ? drawTotal / drawCount : 0, drawMax, drawCount, staticBuilds, noteCursor,
      nextNote: nextNote() ? { ...nextNote() } : null, unlocked: STYLES.filter(unlocked).map((s) => s.id), activeStyle, playing: Player.playing,
    }),
  };
  window.__pulseTest = api;
  return {
    ...api,
    destroy() {
      if (destroyed) return;
      destroyed = true; session++;
      cancelAnimationFrame(raf); resizeObserver.disconnect(); analyzer.destroy(); clearInput();
      root.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('visibilitychange', onVisibility);
      Player.events.removeEventListener('track', onTrackEvent); Player.events.removeEventListener('state', onStateEvent); Player.events.removeEventListener('seek', onSeekEvent);
      $(root, 'calibration').removeEventListener('input', onCalibrationInput); $(root, 'calibration').removeEventListener('change', onCalibrationChange);
      laneCleanups.forEach((cleanup) => cleanup());
      for (const voice of voices) { voice.onended = null; try { voice.stop(); } catch {} try { voice.disconnect(); } catch {} }
      voices.clear();
      if (window.__pulseTest === api) delete window.__pulseTest;
    },
  };
}
