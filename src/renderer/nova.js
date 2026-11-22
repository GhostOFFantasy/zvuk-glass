'use strict';
/* Нова — локальный помощник поверх реальных событий плеера, текста, клипа и игры.
   Словарные реакции относятся только к найденному слову; смысл песни не анализируется. */
(function () {
  const POSES = new Set(['idle', 'listening', 'delighted', 'help', 'pause', 'wave']);
  const PHASES = {
    requested: 'Жду появления клипа', prepare: 'Готовлю трек к сравнению', latency: 'Измеряю задержку звука',
    listen: 'Слушаю клип', measure: 'Сравниваю фрагменты', match: 'Сопоставляю совпадения',
    apply: 'Применяю измеренный сдвиг', done: 'Клип синхронизирован', fail: 'Не удалось синхронизировать',
    wait: 'Синхронизация ждёт', idle: 'Синхронизация не запущена',
  };
  const REACTIONS = window.NOVA_DIALOGUE?.reactions || [];
  const STATIC_EMOTIONS = new Set(['tenderness', 'joy', 'excitement', 'shy', 'thoughtful', 'support', 'longing', 'surprise']);
  const EMOTION_SRC = Object.fromEntries([...STATIC_EMOTIONS].map((id) => [id, `assets/nova/emotions/${id}.webp`]));
  const variant = (list, key) => {
    if (!list?.length) return '';
    const index = [...String(key)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % list.length;
    return list[index];
  };
  const CONTEXT = {
    popular: ['Пульс дня', 'Посмотрим, какие треки сегодня задают ритм.'],
    liked: ['Ваше созвездие', 'Здесь живут треки, к которым особенно приятно возвращаться.'],
    artist: ['Новый музыкальный мир', 'Можно запустить популярное или отправиться дальше на радио исполнителя.'],
    release: ['Слушаем целиком', 'Мне нравится, когда альбом раскрывается как единое путешествие.'],
    playlist: ['Плейлист на орбите', 'Запустите с начала или перемешайте — я останусь рядом.'],
    search: ['Ищем новый сигнал', 'Откройте карточку результата или сразу включите его.'],
    albums: ['Коллекция миров', 'Каждая обложка — отдельная история.'],
    artists: ['Ваши созвездия', 'Любимые исполнители уже ждут на своих орбитах.'],
    playlists: ['Ваши координаты', 'Собирайте настроения, а я помогу им звучать.'],
    history: ['Следы путешествия', 'Здесь легко вернуться к тому, что недавно звучало.'],
  };
  const state = { pose: 'idle', message: 'Откройте текст — я буду рядом, пока играет музыка.', line: null, sync: null, track: null, reaction: null };
  let collapsed = false;
  try { collapsed = localStorage.getItem('zg.nova.collapsed') === '1'; } catch {}
  let watching = !collapsed;
  let initialized = false;
  let liveTimer = 0;
  let poseTimer = 0;
  let beatTimer = 0;
  let liveSticky = false;
  let lastComment = 0;
  let lastSyncKey = '';
  let trackKey = '';
  let firstVoice = false;
  let lastWordKey = '';
  let lastWordAt = 0;
  const seenLines = new Map();

  const STYLE_IDS = new Set(['lunar', 'signal', 'neon', 'impulse', 'resonance', 'eclipse']);
  let activeStyle = 'lunar';
  try { activeStyle = localStorage.getItem('zg.nova.style') || 'lunar'; } catch {}
  if (!STYLE_IDS.has(activeStyle)) activeStyle = 'lunar';
  const POSE_EMOTION = {
    idle: 'thoughtful', listening: 'excitement', delighted: 'joy',
    help: 'support', pause: 'longing', wave: 'tenderness',
  };
  const poseSrc = (pose) => {
    const emotion = POSE_EMOTION[pose] || pose;
    if (!STATIC_EMOTIONS.has(emotion)) return EMOTION_SRC.thoughtful;
    return activeStyle === 'lunar' ? EMOTION_SRC[emotion] : `assets/nova/styles/${activeStyle}/${emotion}.webp`;
  };
  const reduced = () => document.hidden || document.body.classList.contains('reduce-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const text = (root, key, value) => {
    const el = root && root.querySelector(`[data-nv="${key}"]`);
    if (el && el.textContent !== String(value ?? '')) el.textContent = String(value ?? '');
  };
  const activeSync = () => state.sync && (state.sync.state === 'run' || state.sync.phase === 'requested');

  function syncMotion(el) {
    const video = el?._novaVideo;
    if (!video) return;
    if (el.dataset.staticEmotion === '1') {
      video.pause();
      el._novaRig?.setActive(false);
      return;
    }
    const panelHidden = Boolean(el.closest('#spBody')) && App.panel !== 'nova';
    const shouldPlay = el.isConnected && el._novaVisible !== false && !panelHidden && !reduced();
    if (el._novaRig) {
      video.pause();
      el._novaRig.setActive(shouldPlay);
      return;
    }
    if (shouldPlay && video.paused && video.dataset.failed !== '1') video.play().catch(() => {});
    else if (!shouldPlay && !video.paused) video.pause();
  }

  const motionObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target._novaVisible = entry.isIntersecting;
      syncMotion(entry.target);
    }
  }, { threshold: .04 }) : null;

  function mountRig(el) {
    if (el._novaRig || el._novaRigPromise || el._novaRigFailed) return;
    el.dataset.rigState = 'loading';
    el._novaRigPromise = import('./nova-live2d.js')
      .then(({ createNovaRig }) => createNovaRig(el))
      .then((rig) => {
        delete el._novaRigPromise;
        if (!el.isConnected) { rig.dispose(); return; }
        el._novaRig = rig;
        el.dataset.rigState = el.dataset.staticEmotion === '1' ? 'static' : 'ready';
        if (el.dataset.staticEmotion === '1') rig.setActive(false);
        else rig.setPose(el.dataset.pose || 'idle', Boolean(Player.playing));
        syncMotion(el);
      })
      .catch(() => {
        delete el._novaRigPromise;
        el._novaRigFailed = true;
        el.dataset.rigState = 'fallback';
        syncMotion(el);
      });
  }

  function ensureMotion(source, staticMode = false) {
    let el = source;
    if (el.tagName === 'IMG') {
      const replacement = document.createElement('span');
      for (const attr of el.attributes) {
        if (attr.name === 'src' || attr.name === 'alt') continue;
        replacement.setAttribute(attr.name, attr.value);
      }
      replacement.classList.add('nova-motion');
      const alt = el.getAttribute('alt') || '';
      replacement.setAttribute('aria-label', alt);
      if (alt) replacement.setAttribute('role', 'img');
      el.replaceWith(replacement);
      el = replacement;
    }
    el.classList.add('nova-motion');
    if (!el._novaVideo) {
      const image = document.createElement('img');
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('error', () => {
        video.dataset.failed = '1';
        el.dataset.videoState = 'error';
        video.pause();
      });
      video.addEventListener('loadeddata', () => { el.dataset.videoState = 'ready'; });
      el.addEventListener('nova:rig-fallback', () => {
        el._novaRig = null;
        el._novaRigFailed = true;
        el.dataset.rigState = 'fallback';
        syncMotion(el);
      });
      el.replaceChildren(image, video);
      el._novaVideo = video;
      motionObserver?.observe(el);
    }
    if (staticMode) {
      el._novaVideo.pause();
      el.dataset.rigState = 'static';
    } else mountRig(el);
    return el;
  }

  function setStyle(id) {
    if (!STYLE_IDS.has(id)) return false;
    const changed = activeStyle !== id;
    activeStyle = id;
    try { localStorage.setItem('zg.nova.style', id); } catch {}
    document.body.dataset.novaStyle = id;
    document.querySelectorAll('[data-nova-pose]').forEach((el) => { el.dataset.novaStyle = id; });
    if (changed) renderPose();
    return true;
  }

  function renderPose() {
    for (const source of [...document.querySelectorAll('[data-nova-pose]:not(body)')]) {
      const localPose = source.dataset.localPose;
      const pose = POSES.has(localPose) || STATIC_EMOTIONS.has(localPose) ? localPose : state.pose;
      const src = poseSrc(pose);
      const staticMode = POSES.has(pose) || STATIC_EMOTIONS.has(pose);
      const motion = ensureMotion(source, staticMode);
      const image = motion.querySelector(':scope > img');
      const video = motion._novaVideo;
      motion.dataset.staticEmotion = '1';
      if (image.getAttribute('src') !== src) image.src = src;
      if (video.getAttribute('poster') !== src) video.poster = src;
      video.pause();
      motion._novaRig?.setActive(false);
      motion.dataset.pose = pose;
      motion.dataset.novaStyle = activeStyle;
      syncMotion(motion);
    }
    document.body.classList.toggle('nova-syncing', activeSync());
    document.body.classList.toggle('nova-playing', Boolean(Player.playing));
    document.body.dataset.novaState = state.pose;
    document.body.dataset.novaStyle = activeStyle;
  }

  function renderTransport() {
    document.querySelectorAll('[data-nova-action="toggle"]').forEach((button) => {
      const mode = Player.playing ? 'pause' : 'play';
      if (button.dataset.mode !== mode) {
        button.dataset.mode = mode;
        button.innerHTML = icon(mode);
      }
      button.title = Player.playing ? 'Пауза' : 'Продолжить';
      button.setAttribute('aria-label', button.title);
    });
  }

  function renderPanel() {
    const root = document.querySelector('#spBody .nova-panel');
    if (!root) return;
    const t = Player.current;
    const L = App.lyrics || {};
    const data = L.data;
    const line = state.line && String(state.line.trackId) === String(t?.id) ? state.line : null;
    text(root, 'track', t?.title || 'Пока тишина');
    text(root, 'artist', t ? artistsText(t.artists) : 'Выберите трек или запустите орбиту');
    text(root, 'message', state.message);
    text(root, 'line', line?.line?.text || (data?.synced ? 'Жду первую строку…' : 'Синхронизированный текст пока не найден'));
    const next = line?.next;
    text(root, 'next', next ? `Далее: ${next.text || '♪'}` : data === 'none' ? 'Для этого трека текст не найден' : data && !data.synced ? 'Есть текст без привязки ко времени' : 'Строки появятся здесь по мере воспроизведения');
    text(root, 'source', L.source === 'lrclib' ? 'Синхронизированный текст · LRCLIB' : data?.synced ? 'Синхронизированный текст · Zvuk' : 'Реагирую на события плеера');
    text(root, 'reaction', state.reaction ? `Заметила слово: ${state.reaction.word}` : 'Словарные реакции · локально');
    root.classList.toggle('has-line', Boolean(line?.line?.text));
    root.classList.toggle('has-reaction', Boolean(state.reaction));
    root.classList.toggle('no-track', !t);
    const coverEl = root.querySelector('[data-nv="cover"]');
    const src = t ? cover(t, 160) : '';
    if (coverEl && coverEl.getAttribute('src') !== src) {
      if (src) coverEl.src = src;
      else coverEl.removeAttribute('src');
    }
    root.classList.toggle('is-collapsed', collapsed);
    const toggle = root.querySelector('[data-nova-watch]');
    if (toggle) {
      toggle.classList.toggle('on', watching);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = collapsed ? 'Развернуть Нову и включить комментарии' : 'Свернуть Нову и выключить комментарии';
    }
    renderSync(root);
    renderPose();
    renderTransport();
  }

  function renderSync(root = document) {
    const box = root.querySelector?.('[data-nv="sync"]');
    if (!box) return;
    const s = state.sync;
    box.classList.toggle('hidden', !s || s.state === 'idle' && s.phase !== 'requested');
    if (!s) return;
    const phase = s.phase || (s.state === 'run' ? 'measure' : s.state);
    text(root, 'sync-title', PHASES[phase] || 'Синхронизация клипа');
    let detail = s.message || '';
    if (phase === 'done') {
      const parts = [];
      if (Number.isFinite(s.offset)) parts.push(`сдвиг ${s.offset >= 0 ? '+' : '−'}${Math.abs(s.offset).toFixed(3).replace('.', ',')} с`);
      if (Number.isFinite(s.confidence)) parts.push(`уверенность ${Math.round(s.confidence * 100)}%`);
      if (s.shots) parts.push(`фрагментов: ${s.shots}`);
      detail = parts.join(' · ') || 'Измеренный сдвиг применён';
    }
    text(root, 'sync-detail', detail);
    text(root, 'sync-count', s.shot && s.total ? `${s.shot} / ${s.total}` : '');
    const meter = root.querySelector('[data-nv="sync-meter"]');
    if (meter) {
      const known = s.shot && s.total;
      meter.classList.toggle('indeterminate', s.state === 'run' && !known);
      meter.style.setProperty('--sync-progress', known ? Math.min(1, s.shot / s.total) : 0);
    }
  }

  let liveVisible = false;
  function renderLive() {
    const el = document.getElementById('novaLive');
    if (!el) return;
    text(el, 'message', activeSync() ? (PHASES[state.sync.phase] || state.sync.message || 'Синхронизирую клип') : state.message);
    el.classList.toggle('syncing', activeSync());
    el.classList.toggle('hidden', !watching || !liveVisible || App.panel === 'nova' || document.body.classList.contains('nova-page-hidden'));
    renderPose();
    renderTransport();
  }
  function render() { renderPanel(); renderLive(); }

  function showLive(sticky = false, ms = 5600) {
    clearTimeout(liveTimer);
    if (!watching) {
      liveVisible = false;
      liveSticky = false;
      renderLive();
      return;
    }
    liveVisible = true;
    liveSticky = sticky;
    renderLive();
    if (!sticky) liveTimer = setTimeout(() => {
      if (!liveSticky) { liveVisible = false; renderLive(); }
    }, ms);
  }

  function comment(message, pose = 'help', popup = false, sticky = false) {
    clearTimeout(poseTimer);
    state.message = String(message || '');
    state.pose = POSES.has(pose) || STATIC_EMOTIONS.has(pose) ? pose : 'help';
    if (popup) showLive(sticky, sticky ? 0 : 5600);
    render();
    const expected = state.message;
    poseTimer = setTimeout(() => {
      if (state.message !== expected || activeSync()) return;
      state.pose = Player.playing ? 'listening' : 'idle';
      renderPose();
    }, 6500);
  }

  function matchWord(value) {
    const tokens = String(value).toLocaleLowerCase('ru').match(/[a-zа-яё]+/giu) || [];
    for (const token of tokens) {
      for (const reaction of REACTIONS) {
        if (reaction.words.includes(token) || reaction.roots.some((root) => token.startsWith(root))) {
          const template = variant(reaction.variants, `${reaction.id}:${token}`);
          return { ...reaction, word: token, text: () => template.replaceAll('{w}', token) };
        }
      }
    }
    return null;
  }

  function mount(root) {
    if (!root) return;
    root.innerHTML = `<div class="nova-panel${collapsed ? ' is-collapsed' : ''}">
      <header class="nv-header"><div class="nv-intro-top"><span><i></i>НОВА · РЯДОМ С МУЗЫКОЙ</span><button class="icon-btn nv-watch" data-nova-watch aria-expanded="${!collapsed}" aria-controls="nvCollapse" title="${collapsed ? 'Развернуть Нову и включить комментарии' : 'Свернуть Нову и выключить комментарии'}">${icon('chevronDown')}</button></div></header>
      <div class="nv-collapse-wrap" id="nvCollapse"><div class="nv-collapse-body">
      <section class="nv-intro">
        <div class="nv-portrait"><div class="nv-halo" aria-hidden="true"></div><div class="nv-scan" aria-hidden="true"></div><img data-nova-pose src="${poseSrc(state.pose)}" alt="Нова"><i class="nv-heart" aria-hidden="true">♥</i></div>
        <div class="nv-message" data-nv="message"></div>
      </section>
      </div></div>
      <div class="nv-quick-actions" aria-label="Быстрые действия Новы">
        <button data-nova-action="toggle" title="Играть или пауза"></button>
        <button data-act="panel" data-panel="lyrics">${icon('lyrics')}<span>Текст</span></button>
        <button data-act="nav" data-view="pulse">${icon('pulse')}<span>Игра</span></button>
        <button data-act="nav" data-view="wave">${icon('wave')}<span>Орбита</span></button>
      </div>
      <section class="nv-track-card">
        <img data-nv="cover" alt=""><div class="nv-track-copy"><small>СЕЙЧАС НА ОРБИТЕ</small><b data-nv="track"></b><span data-nv="artist"></span></div>
      </section>
      <section class="nv-lyric-card">
        <div class="nv-section-label"><span>Сейчас в тексте</span><small data-nv="source"></small></div>
        <blockquote data-nv="line"></blockquote>
        <p data-nv="next"></p>
        <div class="nv-reaction"><i></i><span data-nv="reaction"></span></div>
        <button class="nv-text-link" data-act="panel" data-panel="lyrics">Открыть весь текст${icon('chevronRight')}</button>
      </section>
      <section class="nv-sync-card hidden" data-nv="sync" aria-live="polite">
        <div class="nv-sync-head"><span class="nv-sync-glyph">${icon('refresh')}</span><div><b data-nv="sync-title"></b><small data-nv="sync-detail"></small></div><strong data-nv="sync-count"></strong></div>
        <div class="nv-sync-track" data-nv="sync-meter"><i></i></div>
      </section>
      <p class="nv-privacy">${icon('lock')}Всё происходит на этом устройстве: события плеера, время строк и реакции на отдельные слова. Текст никуда не отправляется; смысл всей песни не анализируется.</p>
    </div>`;
    render();
  }

  function mountContext(view) {
    if (!initialized || !view?.isConnected || view.querySelector('.nova-context')) return;
    const route = view.dataset.page;
    const copy = CONTEXT[route];
    if (!copy) return;
    const box = document.createElement('button');
    box.className = 'nova-context';
    box.dataset.act = 'panel';
    box.dataset.panel = 'nova';
    box.innerHTML = `<span class="nova-context-avatar"><img data-nova-pose src="${poseSrc(state.pose)}" alt=""></span><span><small>НОВА · ${esc(copy[0])}</small><b>${esc(copy[1])}</b></span><span class="nova-context-open">Поговорить${icon('chevronRight')}</span>`;
    const anchor = view.querySelector('.hero, .top-hero, .page-title');
    if (anchor) anchor.insertAdjacentElement('afterend', box);
    else view.prepend(box);
    renderPose();
  }

  function onTrack(t) {
    clearTimeout(liveTimer);
    liveVisible = false;
    liveSticky = false;
    state.track = t || null;
    state.line = null;
    state.sync = null;
    state.reaction = null;
    lastSyncKey = '';
    trackKey = t ? String(t.id) : '';
    firstVoice = false;
    lastWordKey = '';
    lastWordAt = 0;
    seenLines.clear();
    lastComment = 0;
    if (t) {
      const intro = variant(window.NOVA_DIALOGUE?.intros, trackKey).replaceAll('{title}', t.title);
      comment(intro, 'wave', false);
    } else comment('На орбите тишина. Выберите музыку, когда будете готовы.', 'idle', false);
  }

  function onLine(d) {
    if (!d || String(d.trackId) !== trackKey) return;
    state.line = d;
    renderPanel();
    if (!watching) return;
    const value = String(d.line?.text || '').trim();
    if (!value || !Player.playing || activeSync()) return;
    const now = Date.now();
    const found = matchWord(value);
    const wordKey = found ? `${found.id}:${found.word}` : '';
    if (found && now - lastComment > 7000 && (wordKey !== lastWordKey || now - lastWordAt > 20000)) {
      lastComment = now;
      lastWordKey = wordKey;
      lastWordAt = now;
      firstVoice = true;
      state.reaction = { id: found.id, word: found.word };
      comment(found.text(found.word), found.pose, true);
      document.body.classList.remove('nova-word-react');
      if (!reduced()) {
        void document.body.offsetWidth;
        document.body.classList.add('nova-word-react');
      }
      return;
    }
    const key = value.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const seen = seenLines.get(key) || 0;
    seenLines.set(key, seen + 1);
    if (!firstVoice) {
      firstVoice = true;
      if (d.line.t >= 15 && now - lastComment > 18000) {
        lastComment = now;
        comment('Первые слова появились — дальше следуем за текстом вместе.', 'delighted');
      }
    } else if (seen && now - lastComment > 18000) {
      lastComment = now;
      comment('Знакомая строка вернулась — как небольшой припев на нашей орбите.', 'delighted');
    } else if (d.next && d.next.t - d.line.t >= 12 && now - lastComment > 18000) {
      lastComment = now;
      comment('Дальше музыкальная пауза — на время оставляю сцену звуку.', 'listening');
    }
  }

  function onClip(clip) {
    const s = clip?.sync;
    if (!s || !clip.trackId || String(clip.trackId) !== trackKey) return;
    const phase = s.phase || (s.state === 'run' ? 'measure' : s.state);
    if (s.state === 'idle' && phase !== 'requested') {
      if (state.sync) {
        state.sync = null;
        liveVisible = false;
        liveSticky = false;
        clearTimeout(liveTimer);
        render();
      }
      return;
    }
    const key = JSON.stringify([s.state, phase, s.message, s.shot, s.total, s.offset, s.confidence]);
    if (key === lastSyncKey) return;
    lastSyncKey = key;
    state.sync = { ...s, phase };
    if (s.state === 'run') comment(s.message || PHASES[phase] || 'Синхронизирую клип…', 'listening', true, true);
    else if (s.state === 'done') {
      const offset = Number.isFinite(s.offset) ? ` Сдвиг ${s.offset >= 0 ? '+' : '−'}${Math.abs(s.offset).toFixed(3).replace('.', ',')} с.` : '';
      comment(`Готово — измеренный сдвиг применён.${offset}`, 'delighted', true, false);
      showLive(false, 10000);
    } else if (s.state === 'fail') {
      comment(s.message || 'Не получилось подстроить этот клип. Автоматический сдвиг не применён.', 'help', true, false);
      showLive(false, 12000);
    } else if (phase === 'requested') comment('Начну синхронизацию, когда клип появится на экране.', 'help');
    else comment(s.message || PHASES.wait, 'help');
    renderSync();
  }

  function game(type, detail = {}) {
    if (!initialized || activeSync()) return;
    const combo = Number(detail.combo) || 0;
    const score = Math.max(0, Number(detail.score) || 0);
    if (type === 'start') comment('Чарт готов. Встречайте ноты на линии назначенными клавишами, а длинные лучи удерживайте.', 'listening', true);
    else if (type === 'combo' && [10, 25, 50, 100].includes(combo)) comment(`Серия ×${combo}! Музыка и нажатия совпадают — продолжаем!`, 'delighted', combo >= 25);
    else if (type === 'pause') comment('Музыка и ноты остановлены в одной точке. Продолжим без сдвига.', 'pause');
    else if (type === 'result') comment(`Синхронизация завершена: ${Math.round(score).toLocaleString('ru-RU')} очков. Загляните в открытые стили!`, 'wave', true);
    else if (type === 'calibration') comment('Поправка применена только к моменту нажатия. Музыка и чарт остаются на общих аудиочасах.', 'help');
  }

  function onBeat() {
    if (!watching || !Player.playing || reduced() || App.route?.view === 'pulse') return;
    document.querySelectorAll('.nova-motion').forEach((el) => el._novaRig?.pulse());
    document.body.classList.add('nova-beat');
    clearTimeout(beatTimer);
    beatTimer = setTimeout(() => document.body.classList.remove('nova-beat'), 170);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    setStyle(activeStyle);
    let bodyReduced = document.body.classList.contains('reduce-motion');
    new MutationObserver(() => {
      const next = document.body.classList.contains('reduce-motion');
      if (next === bodyReduced) return;
      bodyReduced = next;
      renderPose();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.body.classList.toggle('nova-on', watching);
    // Панель открывается только кнопкой в нижнем плеере; отдельных плашек на страницах нет.
    Player.on('track', onTrack);
    Player.on('state', ({ playing }) => {
      renderPose();
      renderTransport();
      if (!watching || activeSync()) return;
      const phrases = playing ? window.NOVA_DIALOGUE?.play : window.NOVA_DIALOGUE?.pause;
      const message = variant(phrases, `${trackKey}:${playing}:${Date.now()}`);
      comment(message, playing ? 'delighted' : 'pause', !playing);
    });
    Player.on('seek', ({ time }) => {
      if (watching && !activeSync()) comment(variant(window.NOVA_DIALOGUE?.seek, `${trackKey}:${time}`).replaceAll('{time}', fmtTime(time)), 'help', false);
    });
    document.addEventListener('zg:lyrics-state', () => renderPanel());
    document.addEventListener('zg:lyrics-line', (e) => onLine(e.detail));
    document.addEventListener('zg:clip', (e) => onClip(e.detail));
    window.addEventListener('zg:beat', onBeat);
    document.addEventListener('visibilitychange', () => {
      document.body.classList.toggle('nova-page-hidden', document.hidden);
      if (document.hidden) document.body.classList.remove('nova-beat', 'nova-word-react');
      renderPose();
      renderLive();
    });
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => renderPose());
    document.addEventListener('click', (e) => {
      const action = e.target.closest('[data-nova-action="toggle"]');
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        Player.toggle();
        return;
      }
      const b = e.target.closest('[data-nova-watch]');
      if (!b) return;
      collapsed = !collapsed;
      watching = !collapsed;
      try {
        localStorage.setItem('zg.nova.collapsed', collapsed ? '1' : '0');
        localStorage.removeItem('zg.nova.watch');
      } catch {}
      document.body.classList.toggle('nova-on', watching);
      if (collapsed) {
        clearTimeout(liveTimer);
        liveVisible = false;
        liveSticky = false;
        document.body.classList.remove('nova-beat', 'nova-word-react');
      }
      comment(collapsed ? 'Нова свернута. Разверните панель, чтобы снова включить живые комментарии.' : 'Я снова рядом — живые комментарии включены.', watching ? 'listening' : 'idle');
      if (watching) App.loadLyrics?.();
    });
    if (Player.current) onTrack(Player.current);
    render();
  }

  window.Nova = {
    init, mount, mountContext, render, renderPose, setStyle, game,
    wantsLyrics: () => watching && !window.ZG_MOBILE,
    _stateForTest: () => ({ watching, collapsed, activeStyle, pose: state.pose, message: state.message, line: state.line, sync: state.sync, trackKey, reaction: state.reaction }),
  };
})();
