'use strict';
/* Экраны приложения и общие компоненты (строки треков, карточки, полки) */
(function () {
  // ---------- Реестр списков треков (для воспроизведения по клику) ----------
  const Lists = new Map();
  let listSeq = 0;
  function registerList(tracks, source) {
    const id = 'l' + ++listSeq;
    Lists.set(id, { tracks, source });
    if (Lists.size > 80) Lists.delete(Lists.keys().next().value);
    return id;
  }

  // ---------- Компоненты ----------
  function trackRow(t, i, listId, o = {}) {
    const liked = App.likes.track.has(String(t.id));
    const cur = Player.current && String(Player.current.id) === String(t.id);
    const noAlbum = o.album === false;
    return `<div class="tr${noAlbum ? ' no-album' : ''}${cur ? ' playing' : ''}" data-track="${esc(t.id)}" data-list="${listId}" data-idx="${i}">
      <div class="n" data-act="play-row"><span class="num">${o.num ? o.num(t, i) : i + 1}</span><span class="pi" data-play-icon>${cur && Player.playing ? ICONS.pause : ICONS.play}</span><span class="eqs"><i></i><i></i><i></i></span></div>
      <div class="ti">${o.cover === false ? '' : `<img loading="lazy" decoding="async" src="${esc(cover(t, 96))}" alt="" data-act="play-row" style="cursor:pointer" title="Слушать">`}
        <div class="tt"><div class="t1"><span class="tn">${esc(t.title)}</span>${t.explicit ? '<span class="explicit">E</span>' : ''}</div>
        <div class="t2">${artistsLinks(t.artists)}</div></div></div>
      ${noAlbum ? '' : `<div class="al">${t.release ? `<span class="lnk" data-act="nav" data-view="release" data-id="${esc(t.release.id)}">${esc(t.release.title)}</span>` : ''}</div>`}
      <button class="icon-btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="track" data-id="${esc(t.id)}" title="Нравится">${icon(liked ? 'heartFill' : 'heart')}</button>
      <div class="du">${fmtTime(t.duration)}</div>
      <button class="icon-btn more-btn" data-act="track-menu" title="Ещё">${icon('more')}</button>
    </div>`;
  }

  function trackList(tracks, source, o = {}) {
    const listId = registerList(tracks, source);
    Lists.get(listId).options = o;
    const head = o.head === false ? '' : `<div class="tracks-head${o.album === false ? ' no-album' : ''}" style="${o.album === false ? 'grid-template-columns:36px minmax(0,1fr) 40px 56px 40px' : ''}"><span style="text-align:center">#</span><span>Название</span>${o.album === false ? '' : '<span class="al">Альбом</span>'}<span></span><span style="text-align:right">${ICONS.clock ? icon('clock') : ''}</span><span></span></div>`;
    return { listId, html: `${head}<div class="tracks${o.compact ? ' compact' : ''}" data-list-root="${listId}">${tracks.map((t, i) => trackRow(t, i, listId, o)).join('')}</div>` };
  }

  /* Виртуализация длинных списков: в DOM только видимые строки и запас вокруг них. */
  const virtualLists = new Set();
  let virtualRaf = 0;
  let virtualBound = false;
  function scheduleVirtual() {
    if (virtualRaf) return;
    virtualRaf = requestAnimationFrame(() => {
      virtualRaf = 0;
      for (const state of [...virtualLists]) {
        if (!state.root.isConnected) virtualLists.delete(state);
        else renderVirtual(state);
      }
    });
  }
  function invalidateVirtual() {
    for (const state of virtualLists) state.rootTop = null;
    scheduleVirtual();
  }
  function positionVirtualRow(row, index, state, selected) {
    if (row.dataset.virtualPosition !== String(index)) {
      row.style.top = `${index * state.step}px`;
      row.style.height = `${state.rowH}px`;
      row.setAttribute('aria-posinset', String(index + 1));
      row.dataset.virtualPosition = String(index);
    }
    // Размер списка может вырасти без смены видимого диапазона.
    const setSize = String(state.total);
    if (row.getAttribute('aria-setsize') !== setSize) row.setAttribute('aria-setsize', setSize);
    if (selected.has(row.dataset.track)) row.classList.add('sel');
  }
  function renderVirtual(state) {
    const { root, list, rowH, step, total } = state;
    const sc = $('#scroller');
    // Геометрия стабильна между изменениями окна/страницы. Не читаем её на каждый scroll:
    // такое чтение после прошлой вставки строк принудительно запускало layout каждого кадра.
    if (state.rootTop == null) {
      const rr = root.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      state.rootTop = rr.top - sr.top + sc.scrollTop;
      state.viewH = sc.clientHeight;
    }
    const visibleStart = sc.scrollTop - state.rootTop;
    const start = Math.max(0, Math.min(total, Math.floor((visibleStart / step - 8) / 4) * 4));
    const end = Math.max(start, Math.min(total, Math.ceil(((visibleStart + state.viewH) / step + 8) / 4) * 4));
    if (start === state.start && end === state.end) {
      for (const row of root.children) {
        const size = String(total);
        if (row.getAttribute('aria-setsize') !== size) row.setAttribute('aria-setsize', size);
      }
      return;
    }
    state.start = start;
    state.end = end;
    const selected = new Set([...root.querySelectorAll('.tr.sel')].map((row) => row.dataset.track));
    const listId = root.dataset.listRoot;
    const options = list.options || {};
    const existing = new Map();
    for (const row of [...root.children]) {
      const index = Number(row.dataset.idx);
      if (index >= start && index < end) {
        positionVirtualRow(row, index, state, selected);
        existing.set(index, row);
      } else row.remove();
    }
    // Сохраняем уже показанные строки и создаём только вновь входящие. Раньше innerHTML
    // заново разбирал весь видимый список, перезапускал загрузку обложек и выбрасывал узлы.
    const missing = [];
    let html = '';
    for (let i = start; i < end; i++) {
      if (existing.has(i)) continue;
      missing.push(i);
      html += trackRow(list.tracks[i], i, listId, options);
    }
    if (html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      template.content.querySelectorAll('.tr').forEach((row) => {
        const index = Number(row.dataset.idx);
        positionVirtualRow(row, index, state, selected);
        existing.set(index, row);
      });
      // Вставка в визуальном порядке сохраняет предсказуемую навигацию с клавиатуры.
      let cursor = root.firstElementChild;
      for (const index of missing) {
        const row = existing.get(index);
        while (cursor && Number(cursor.dataset.idx) < index) cursor = cursor.nextElementSibling;
        root.insertBefore(row, cursor);
        if (cursor === row) cursor = cursor.nextElementSibling;
      }
    }
    root.dataset.virtualStart = String(start);
    root.dataset.virtualEnd = String(end);
  }
  function virtualize(root = document) {
    const sc = $('#scroller');
    if (!sc) return;
    if (!virtualBound) {
      sc.addEventListener('scroll', scheduleVirtual, { passive: true });
      window.addEventListener('resize', invalidateVirtual, { passive: true });
      virtualBound = true;
    }
    for (const state of [...virtualLists]) if (!state.root.isConnected) virtualLists.delete(state);
    root.querySelectorAll('[data-list-root]').forEach((element) => {
      if (element.classList.contains('tracks-grid')) return;
      const list = Lists.get(element.dataset.listRoot);
      if (!list) return;
      const total = element.dataset.virtualTotal == null ? list.tracks.length : Math.min(list.tracks.length, Number(element.dataset.virtualTotal) || 0);
      const current = [...virtualLists].find((state) => state.root === element);
      if (current) {
        current.total = total;
        element.style.height = `${total * current.rowH + Math.max(0, total - 1) * (current.step - current.rowH)}px`;
        current.rootTop = null;
        renderVirtual(current);
        return;
      }
      const first = element.querySelector('.tr');
      if (!first || total < 36) return;
      const rowH = first.getBoundingClientRect().height || (element.classList.contains('compact') ? 52 : 58);
      const gap = parseFloat(getComputedStyle(element).rowGap) || 2;
      element.dataset.virtualized = 'true';
      element.classList.add('virtualized');
      element.style.height = `${total * rowH + Math.max(0, total - 1) * gap}px`;
      const state = { root: element, list, rowH, step: rowH + gap, total, start: -1, end: -1 };
      virtualLists.add(state);
      renderVirtual(state);
    });
  }

  /** Мгновенная фильтрация модели + FLIP: совпадения подтягиваются вверх без пустых мест. */
  function replaceListTracks(root, list, tracks, emptyText = 'Совпадений нет') {
    const previous = new Map();
    for (const row of root.querySelectorAll('.tr')) previous.set(String(row.dataset.track), { row, top: row.getBoundingClientRect().top });
    const state = [...virtualLists].find((item) => item.root === root);
    const reduced = document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.tracks = tracks;
    if (state) {
      state.total = tracks.length;
      state.root.style.height = `${tracks.length * state.rowH + Math.max(0, tracks.length - 1) * (state.step - state.rowH)}px`;
      if (state.rootTop != null) $('#scroller').scrollTop = Math.min($('#scroller').scrollTop, state.rootTop);
      state.rootTop = null;
      state.start = -1;
      state.end = -1;
      const indexes = new Map(tracks.map((track, i) => [String(track.id), i]));
      for (const row of [...root.children]) {
        const index = indexes.get(String(row.dataset.track));
        if (index == null) { row.remove(); continue; }
        row.dataset.idx = index;
        row.dataset.virtualPosition = '';
        const number = row.querySelector('.num');
        if (number) number.textContent = index + 1;
      }
      renderVirtual(state);
    } else {
      const existing = new Map([...previous].map(([id, item]) => [id, item.row]));
      const fragment = document.createDocumentFragment();
      tracks.forEach((track, i) => {
        let row = existing.get(String(track.id));
        if (!row) {
          const template = document.createElement('template');
          template.innerHTML = trackRow(track, i, root.dataset.listRoot, list.options || {});
          row = template.content.firstElementChild;
        }
        row.dataset.idx = i;
        const number = row.querySelector('.num');
        if (number) number.textContent = i + 1;
        fragment.append(row);
      });
      root.replaceChildren(fragment);
      root.style.height = '';
    }
    const empty = root.parentElement.querySelector('.liked-filter-empty') || (() => {
      const el = document.createElement('div');
      el.className = 'empty liked-filter-empty';
      el.setAttribute('role', 'status');
      root.parentElement.append(el);
      return el;
    })();
    empty.innerHTML = `${icon('search')}<div>${esc(emptyText)}</div>`;
    empty.hidden = tracks.length > 0;
    if (reduced) return;
    for (const row of root.querySelectorAll('.tr')) {
      const old = previous.get(String(row.dataset.track));
      const top = row.getBoundingClientRect().top;
      const dy = old ? old.top - top : 0;
      if (old && Math.abs(dy) < 1) continue;
      row._filterAnimation?.cancel();
      row._filterAnimation = row.animate([
        { transform: old ? `translateY(${dy}px)` : 'translateY(22px)', opacity: old ? 1 : 0 },
        { transform: 'translateY(0px)', opacity: 1 },
      ], { duration: old ? 360 : 280, easing: 'cubic-bezier(.2,.82,.2,1)' });
    }
  }

  let imageWarmToken = 0;
  function warmImages(root = document) {
    const token = ++imageWarmToken;
    const vh = window.innerHeight;
    const images = [...root.querySelectorAll('img[loading="lazy"]')].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.bottom > -vh * 0.5 && r.top < vh * 2;
    }).slice(0, 24);
    let at = 0;
    const step = () => {
      if (token !== imageWarmToken || !root.isConnected) return;
      for (let n = 0; n < 4 && at < images.length; n++, at++) images[at].decode?.().catch(() => {});
      if (at < images.length) {
        if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 350 });
        else setTimeout(step, 40);
      }
    };
    if (window.requestIdleCallback) requestIdleCallback(step, { timeout: 350 });
    else setTimeout(step, 40);
  }

  function card(it) {
    const play = it.playable === false ? '' : `<button class="play-orb accent" data-act="play-entity" data-kind="${it.kind}" data-id="${esc(it.id)}" title="Слушать">${icon('play')}</button>`;
    const art = it.art || (it.image ? `<img loading="lazy" decoding="async" src="${esc(it.image)}" alt="">` : `<div class="tile-art">${icon(it.kind === 'artist' ? 'mic' : 'note')}</div>`);
    return `<div class="card${it.round ? ' round' : ''}" data-act="open" data-kind="${it.kind}" data-id="${esc(it.id)}" ${it.extra || ''}>
      <div class="cover">${art}${play}</div>
      <div class="ct">${esc(it.title)}</div>
      ${it.sub ? `<div class="cs">${it.sub}</div>` : ''}
    </div>`;
  }

  const releaseCard = (r) =>
    card({ kind: 'release', id: r.id, title: r.title, image: cover(r, 300), sub: `${year(r.date)}${r.date ? ' · ' : ''}${esc(r.artists ? artistsText(r.artists) : releaseType(r.type))}` });
  const releaseCardType = (r) => card({ kind: 'release', id: r.id, title: r.title, image: cover(r, 300), sub: `${year(r.date)} · ${releaseType(r.type)}` });
  const artistCard = (a) => card({ kind: 'artist', id: a.id, title: a.title, image: img(a.image?.src, 300), sub: 'Исполнитель', round: true });
  const playlistCard = (p) =>
    card({ kind: 'playlist', id: p.id, title: p.title, art: playlistArt(p, 300) || null, sub: p.trackCount != null ? tracksWord(p.trackCount) : esc(p.description || 'Плейлист') });
  const WAVE_TINTS = [['#ff4f9a', '#6d4dff'], ['#20c9c0', '#2f6bff'], ['#ffb347', '#ff4f6d'], ['#7ee08a', '#16a3a1'], ['#ff8a5c', '#d64fff'], ['#5ee7df', '#b490ca'], ['#f6d365', '#fda085'], ['#a18cd1', '#fbc2eb'], ['#84fab0', '#8fd3f4'], ['#fccb90', '#d57eeb']];
  const waveCard = (w, i) => {
    const [a, b] = WAVE_TINTS[i % WAVE_TINTS.length];
    const art = w.image?.src
      ? `<img loading="lazy" decoding="async" src="${esc(img(w.image.src, 300))}" alt="">`
      : `<div class="tile-art" style="--t1:${a};--t2:${b}"><div class="tile-label">${esc(w.title)}</div></div>`;
    return card({ kind: 'wave', id: w.id, title: w.title, art, sub: esc(w.description || 'Волна') });
  };

  function entityCard(x) {
    if (x.__typename === 'Release') return releaseCard(x);
    if (x.__typename === 'Artist') return artistCard(x);
    if (x.__typename === 'Playlist') return playlistCard(x);
    return '';
  }

  function shelf(title, inner, { more = null, id = '' } = {}) {
    return `<section class="section"${id ? ` id="${id}"` : ''}>
      <div class="section-head"><h2>${esc(title)}</h2>
        <div class="arrows">${more ? `<button class="more" ${more}>Все</button>` : ''}
          <button class="icon-btn" data-act="shelf-scroll" data-dir="-1">${icon('chevronLeft')}</button>
          <button class="icon-btn" data-act="shelf-scroll" data-dir="1">${icon('chevronRight')}</button></div>
      </div>
      <div class="shelf">${inner}</div>
    </section>`;
  }
  const skeletonShelf = (title, round = false) =>
    `<section class="section"><div class="section-head"><h2>${esc(title)}</h2></div><div class="shelf">${Array.from({ length: 7 }, () => `<div class="card"><div class="cover skel" style="${round ? 'border-radius:50%' : ''}"></div><div class="skel" style="height:14px;margin-top:12px;width:80%"></div><div class="skel" style="height:12px;margin-top:8px;width:55%"></div></div>`).join('')}</div></section>`;
  const skeletonPage = () =>
    `<div class="hero"><div class="hero-cover skel"></div><div class="hero-info" style="flex:1"><div class="skel" style="height:14px;width:90px"></div><div class="skel" style="height:56px;width:60%;margin:12px 0"></div><div class="skel" style="height:14px;width:40%"></div></div></div>
     <div style="margin-top:30px">${Array.from({ length: 8 }, () => '<div class="skel" style="height:50px;margin:6px 0;border-radius:14px"></div>').join('')}</div>`;
  const errorBox = (e, retry = true) =>
    `<div class="empty">${icon('note')}<div>${esc(e?.message || 'Что-то пошло не так')}</div>${retry ? '<button class="btn" data-act="reload-view">Повторить</button>' : ''}</div>`;

  // ---------- Главная ----------
  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Доброй ночи';
    if (h < 12) return 'Доброе утро';
    if (h < 18) return 'Добрый день';
    return 'Добрый вечер';
  }

  const MOODS = [
    { id: 'any', label: 'Любое', icon: 'sparkle', c: ['#a78bfa', '#f472b6'] },
    { id: 'energetic', label: 'Бодрое', energy: 0.9, fun: 0.6, icon: 'bolt', c: ['#fbbf24', '#f97316'] },
    { id: 'fun', label: 'Весёлое', energy: 0.65, fun: 0.92, icon: 'sun', c: ['#facc15', '#fb7185'] },
    { id: 'calm', label: 'Спокойное', energy: 0.15, fun: 0.5, icon: 'moon', c: ['#60a5fa', '#22d3ee'] },
    { id: 'sad', label: 'Грустное', energy: 0.3, fun: 0.08, icon: 'cloud', c: ['#818cf8', '#64748b'] },
  ];
  const LANGS = [
    { id: 'any', label: 'Любой', hint: 'Все языки', icon: 'infinity' },
    { id: 'russian', label: 'Русский', hint: 'Русская речь', icon: 'mic' },
    { id: 'foreign', label: 'Зарубежный', hint: 'Мировая сцена', icon: 'globe' },
    { id: 'instrumental', label: 'Без слов', hint: 'Только музыка', icon: 'note' },
  ];
  const POPS = [
    { id: 'any', label: 'Любимое', hint: 'По вашему вкусу', icon: 'heart' },
    { id: 'popular', label: 'Популярное', hint: 'Всем знакомые', icon: 'fire' },
    { id: 'rare', label: 'Незнакомое', hint: 'Свежие открытия', icon: 'compass' },
  ];
  const GENRES = [
    ['pop', 'Поп'], ['rock', 'Рок'], ['hip_hop', 'Хип-хоп'], ['electronic', 'Электроника'], ['indie', 'Инди'], ['metal', 'Метал'],
    ['folk_world_country', 'Фолк'], ['easy_listening_ambient', 'Эмбиент'], ['instrumental_acoustic', 'Акустика'], ['soundtrack', 'Саундтреки'], ['classical', 'Классика'],
  ];

  function waveOptions(w = App.settings.wave || {}) {
    const o = {};
    const mood = MOODS.find((m) => m.id === w.mood);
    if (mood && mood.energy != null) {
      o.energy = mood.energy;
      o.fun = mood.fun;
    }
    if (w.lang === 'instrumental') o.instrumental = true;
    else if (w.lang === 'russian' || w.lang === 'foreign') o.language = w.lang;
    if (w.pop === 'popular') o.popularity = 1;
    if (w.pop === 'rare') o.popularity = 0;
    if (w.genres && w.genres.length) o.genres = w.genres;
    return o;
  }
  function waveSummary(w = App.settings.wave || {}) {
    const parts = [];
    const mood = MOODS.find((m) => m.id === w.mood && m.id !== 'any');
    if (mood) parts.push(mood.label.toLowerCase());
    const lang = LANGS.find((m) => m.id === w.lang && m.id !== 'any');
    if (lang) parts.push(lang.label.toLowerCase());
    const pop = POPS.find((m) => m.id === w.pop && m.id !== 'any');
    if (pop) parts.push(pop.label.toLowerCase());
    if (w.genres && w.genres.length) parts.push(GENRES.filter((g) => w.genres.includes(g[0])).map((g) => g[1].toLowerCase()).join(', '));
    return parts.length ? 'Настроено: ' + parts.join(' · ') : 'Персональный поток, который подстраивается под ваш вкус';
  }

  const wavePlaying = () => Player.source?.kind === 'wave' && Player.playing;
  const portalHtml = () =>
    `<button class="wv-play${wavePlaying() ? ' playing' : ''}" data-act="wave-toggle" id="waveOrb" title="Музыкальная орбита — играть / пауза" aria-label="Музыкальная орбита — играть или пауза">${icon(wavePlaying() ? 'pause' : 'play')}</button>`;

  /** В оконном режиме — чистая гравитационная спираль; 3D-миры остаются в погружении. */
  function attachCosmos(canvas, pointer) {
    if (!canvas) return;
    const hero = canvas.closest('.wv-hero, .home-wave');
    const gravity = !document.body.classList.contains('design-classic');
    hero?.classList.toggle('gravity-orbit', gravity);
    const handle = Viz.attach(canvas, {
      style: gravity ? 'gravity' : 'waves',
      idle: true,
      sensitivity: 1.05,
      liveIf: () => Player.source?.kind === 'wave',
      pointer,
      centerFn: (target) => {
        const c = target.getBoundingClientRect();
        const play = target.parentElement.querySelector('#waveOrb');
        if (!play) return { x: c.width * 0.72, y: c.height * 0.46, r: 50 };
        const r = play.getBoundingClientRect();
        return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top, r: r.width / 2 };
      },
      fps: 60,
      maxDpr: 1,
      onFrame: (V) => {
        if (!hero) return;
        hero.style.setProperty('--beat', (wavePlaying() ? V.bass * 0.6 + V.beat * 0.6 : 0).toFixed(3));
        hero.style.setProperty('--energy', (wavePlaying() ? V.level : 0).toFixed(3));
      },
    });
    canvas._cosmos = handle;
    canvas.dataset.scene = gravity ? 'gravity' : 'waves';
    return handle;
  }

  function waveHero() {
    const w = App.settings.wave || {};
    const mood = MOODS.find((m) => m.id === (w.mood || 'any')) || MOODS[0];
    return `<section class="wave-hero home-wave glass panel" aria-label="Персональный музыкальный эфир">
      <canvas class="home-wave-cosmos" id="homeRing" aria-hidden="true"></canvas>
      <div class="home-studio-topline"><span><i></i>NOVA · ПЕРСОНАЛЬНЫЙ ЭФИР</span><span>ОРБИТА / 01</span></div>
      <div class="wave-text">
        <div class="home-wave-kicker">ВАША МУЗЫКАЛЬНАЯ СРЕДА</div>
        <h2>Ваша музыка.<br><em>Ваша орбита.</em></h2>
        <p id="waveSummary">${esc(waveSummary())}</p>
        <div class="chips" aria-label="Настроение потока">${MOODS.map((m) => `<button class="chip${(w.mood || 'any') === m.id ? ' on' : ''}" data-act="wave-set" data-key="mood" data-val="${m.id}">${m.label}</button>`).join('')}
          <button class="chip home-wave-settings" data-act="nav" data-view="wave">${icon('settings')}Настроить поток</button></div>
      </div>
      <div class="home-orbit-stage">
        <div class="home-orbital-map" aria-hidden="true"><i class="home-orbit-line l1"></i><i class="home-orbit-line l2"></i><i class="home-orbit-line l3"></i><i class="home-orbit-moon m1"></i><i class="home-orbit-moon m2"></i><span class="home-orbit-coordinate c1">01 / ВКУС</span><span class="home-orbit-coordinate c2">02 / НАСТРОЕНИЕ</span><span class="home-orbit-coordinate c3">03 / ОТКРЫТИЯ</span></div>
        <button class="home-wave-play${wavePlaying() ? ' playing' : ''}" data-act="wave-toggle" id="waveOrb" title="Персональная орбита — играть / пауза" aria-label="Персональная орбита — играть или пауза">${icon(wavePlaying() ? 'pause' : 'play')}</button>
        <div class="home-scope-caption"><span>ПЕРСОНАЛЬНАЯ ОРБИТА</span><b>${esc(mood.label)}</b></div>
      </div>
    </section>`;
  }

  function waveNowHtml() {
    const t = Player.current;
    if (Player.source?.kind === 'wave' && t) {
      const liked = App.likes.track.has(String(t.id));
      const focused = document.body.classList.contains('wave-focus');
      return `<div class="wv-now"><img src="${esc(cover(t, focused ? 600 : 160))}" alt="">
        <div class="nt"><div><b>${esc(t.title)}</b></div><div class="a">${artistsLinks(t.artists)}</div></div>
        <button class="icon-btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="track" data-id="${esc(t.id)}" title="Нравится">${icon(liked ? 'heartFill' : 'heart')}</button>
        <button class="icon-btn" data-act="next" title="Дальше">${icon('next')}</button></div>`;
    }
    return `<div class="wv-hint">${icon('sparkle')}Запустите орбиту — поток подстроится под ваш вкус и настроение</div>`;
  }

  const Views = {};

  Views.home = async (view) => {
    const nm = App.settings.profileLocal?.name || App.profile?.name;
    view.innerHTML = `<header class="home-heading">
        <div><div class="page-kicker"><span class="signal-dot"></span>Персональная обсерватория</div>
          <h1 class="greet">${greeting()}${nm ? ', ' + esc(nm) : ''}</h1></div>
        <div class="home-heading-note"><span>Ваша музыка</span><i></i><span>Новые открытия</span></div>
      </header>
      ${waveHero()}
      <div id="h-synth"></div>
      <div id="h-recent">${skeletonShelf('Недавнее')}</div>
      <div id="h-rec">${skeletonShelf('Рекомендуем')}</div>
      <div id="h-art"></div>
      <div id="h-waves">${skeletonShelf('Волны')}</div>
      <div id="h-hist"></div>`;
    const homeCalm = Custom.s.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const homeCosmos = attachCosmos(view.querySelector('#homeRing'), { x: 0, y: 0, tx: 0, ty: 0 });
    // В спокойном режиме оставляем один готовый статический кадр, а не пустой холст.
    if (homeCalm && homeCosmos) requestAnimationFrame(() => requestAnimationFrame(() => homeCosmos.stop()));
    const fill = async (id, fn) => {
      const el = view.querySelector('#' + id);
      try {
        const html = await fn();
        if (el.isConnected) el.innerHTML = html || '';
      } catch (e) {
        if (el.isConnected) el.innerHTML = '';
        console.warn(id, e);
      }
    };
    await Promise.all([
      fill('h-synth', async () => {
        const list = (await api('synthesisPlaylists')).filter((p) => p.trackCount);
        return list.length ? shelf('Плейлисты для вас', list.map(playlistCard).join('')) : '';
      }),
      fill('h-recent', async () => {
        const list = await api('recentlyPlayed', 20);
        return list.length ? shelf('Недавнее', list.map(entityCard).join('')) : '';
      }),
      (async () => {
        let rec = [];
        try {
          rec = await api('recommendations', [1, 2]);
        } catch (e) {
          console.warn(e);
        }
        const elR = view.querySelector('#h-rec');
        const elA = view.querySelector('#h-art');
        const rel = rec.filter((x) => x.__typename !== 'Artist');
        const art = rec.filter((x) => x.__typename === 'Artist');
        if (elR) elR.innerHTML = rel.length ? shelf('Рекомендуем', rel.map(entityCard).join('')) : '';
        if (elA) elA.innerHTML = art.length ? shelf('Исполнители для вас', art.map(artistCard).join('')) : '';
      })(),
      fill('h-waves', async () => {
        const waves = await api('getWaves', ['1', '2', '3', '6', '7', '10', '4', '5', '9', '8']);
        return waves.length ? shelf('Волны', waves.map(waveCard).join('')) : '';
      }),
      fill('h-hist', async () => {
        const hist = await api('listeningHistory', 30);
        const uniq = [];
        const seen = new Set();
        for (const t of hist) if (!seen.has(t.id) && uniq.length < 12) seen.add(t.id) && uniq.push(t);
        if (!uniq.length) return '';
        const listId = registerList(uniq, { kind: 'list', title: 'Вы слушали' });
        return `<section class="section"><div class="section-head"><h2>Вы слушали</h2><button class="more" data-act="nav" data-view="history">Вся история</button></div>
          <div class="tracks tracks-grid compact">${uniq.map((t, i) => trackRow(t, i, listId, { album: false })).join('')}</div></section>`;
      }),
    ]);
  };

  // ---------- Популярное: чарт «Топ 100», чарты, артисты и релизы из чарта, хиты десятилетий, подборки ----------
  const TOP_SHOWN = 10;
  Views.popular = async (view) => {
    view.innerHTML = `<h1 class="page-title">Популярное</h1>
      <div class="top-hero glass skel-hero"><div class="skel" style="height:100%;border-radius:inherit"></div></div>
      ${skeletonShelf('Чарты и хиты')}${skeletonShelf('Артисты чарта', true)}`;
    const d = await api('popular');
    const top = (d.top?.tracks || []).filter(Boolean);
    const src = { kind: 'list', title: 'Топ 100 · Zvuk' };
    const tl = trackList(top, src, { head: false, album: true, num: (t, i) => i + 1 });
    // артисты и релизы — по порядку мест в чарте, без повторов
    const artists = [];
    const releases = [];
    const seenA = new Set();
    const seenR = new Set();
    for (const t of top) {
      for (const a of t.artists || []) if (a?.id && !seenA.has(a.id) && artists.length < 24) seenA.add(a.id) && artists.push(a);
      const r = t.release;
      if (r?.id && !seenR.has(r.id) && releases.length < 24) seenR.add(r.id) && releases.push({ ...r, artists: t.artists });
    }
    const upd = d.top?.updated ? new Date(d.top.updated) : null;
    const updText = upd && !isNaN(upd) ? `обновлён ${upd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : '';
    const podium = top.slice(0, 3).map((t, i) => `<div class="tp-card p${i + 1}" data-act="play-row" data-list="${tl.listId}" data-idx="${i}" title="${esc(t.title)} — ${esc(artistsText(t.artists))}">
        <img src="${esc(cover(t, 300))}" alt="" draggable="false"><span class="tp-place">${i + 1}</span></div>`).join('');
    view.innerHTML = `<h1 class="page-title">Популярное</h1>
      ${top.length ? `<div class="top-hero glass">
        <div class="top-info"><div class="kind">${icon('pulse')}Главный чарт · Zvuk</div><h2>Топ 100</h2>
          <p>100 самых прослушиваемых треков дня${updText ? ` · ${updText}` : ''}</p>
          <div class="top-btns"><button class="btn primary" data-act="play-list-all" data-list="${tl.listId}">${icon('play')}Слушать чарт</button>
            <button class="btn" data-act="shuffle-list" data-list="${tl.listId}">${icon('shuffle')}Вперемешку</button>
            <button class="btn" data-act="open" data-kind="playlist" data-id="${esc(d.top.id)}">${icon('playlist')}Исходный плейлист</button></div></div>
        <div class="top-podium">${podium}</div>
      </div>
      <section class="section pop-sec"><div class="section-head"><h2>Полный чарт</h2><span class="pop-count">${tracksWord(top.length)}</span></div>
        <div class="pop-tracks top-list collapsed" id="topList" style="--rows:${TOP_SHOWN}">${tl.html}</div>
        ${top.length > TOP_SHOWN ? `<div class="pop-more"><button class="chip" data-act="top-toggle">Показать все ${top.length}</button></div>` : ''}</section>` : ''}
      ${d.charts?.length ? shelf('Чарты и хиты', d.charts.map(playlistCard).join('')) : ''}
      ${artists.length ? shelf('Артисты чарта', artists.map(artistCard).join('')) : ''}
      ${releases.length ? shelf('Релизы из чарта', releases.map(releaseCard).join('')) : ''}
      ${d.decades?.length ? shelf('Хиты десятилетий', d.decades.map(playlistCard).join('')) : ''}
      ${d.editorial?.length ? `<section class="section"><div class="section-head"><h2>Подборки редакции</h2></div><div class="grid">${d.editorial.map(playlistCard).join('')}</div></section>` : ''}`;
  };
  Views.topToggle = (btn) => {
    const box = document.getElementById('topList');
    if (!box) return;
    const collapsed = box.classList.toggle('collapsed');
    const root = box.querySelector('[data-list-root]');
    const total = Lists.get(root?.dataset.listRoot)?.tracks.length || 0;
    btn.textContent = collapsed ? `Показать все ${total}` : 'Свернуть';
    virtualize(box);
    if (collapsed) box.closest('.section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // ---------- Музыкальная орбита ----------
  Views.wave = async (view) => {
    const w = App.settings.wave || {};
    const mood = MOODS.find((m) => m.id === (w.mood || 'any')) || MOODS[0];
    const moodNotes = {
      any: 'Доверьтесь музыкальному потоку',
      energetic: 'Темп, драйв и энергия',
      fun: 'Светлые треки и хороший настрой',
      calm: 'Мягкое звучание без спешки',
      sad: 'Тихие эмоции и атмосфера',
    };
    const selectedWorld = OrbitWorlds.get(w.world);
    const pills = (key, list, cur) =>
      `<div class="opt-pills">${list.map((o) => `<button class="opt-pill${(cur || 'any') === o.id ? ' on' : ''}" style="--m1:${mood.c[0]};--m2:${mood.c[1]}" data-act="wave-set" data-key="${key}" data-val="${o.id}" aria-pressed="${(cur || 'any') === o.id}"><span class="opt-icon">${icon(o.icon)}</span><span class="opt-copy"><b>${o.label}</b><small>${o.hint}</small></span><span class="opt-check" aria-hidden="true">${icon('check')}</span></button>`).join('')}</div>`;
    view.innerHTML = `
      <section class="wv-hero orbit-observatory glass panel" style="--mood-a:${mood.c[0]};--mood-b:${mood.c[1]}">
        <button class="wv-focus-btn" id="waveFocusBtn" data-act="wave-focus" title="Режим погружения (Esc — выход)">${icon('fullscreen')}<span>Погрузиться</span></button>
        <canvas class="wv-cosmos" id="waveCosmos" aria-hidden="true"></canvas>
        <div class="wv-ring-seek" id="waveRingSeek" role="slider" tabindex="-1" aria-label="Позиция трека на кольце" aria-valuemin="0" aria-valuenow="0" aria-disabled="true" title="Нажмите на кольцо для перемотки"></div>
        <div class="wv-vignette" aria-hidden="true"></div>
        <div class="wv-coordinates" aria-hidden="true"><span>NOVA / ЭФИР</span><i></i><span>ЖИВОЙ МУЗЫКАЛЬНЫЙ ПОТОК</span></div>
        <div class="wv-copy">
          <div class="wv-kicker"><span class="wv-live-dot"></span>Настраивается под ваш вкус</div>
          <h1 class="wv-title">Музыкальная <span>орбита</span></h1>
          <p class="wv-sub" id="waveSummary">${esc(waveSummary())}</p>
          <div class="wv-mood-note" id="waveMoodNote">${icon(mood.icon)}<span>${w.world && selectedWorld.id !== 'any' ? esc(selectedWorld.description) : moodNotes[mood.id]}</span></div>
          <div class="wv-focus-transport">
            <div class="wv-focus-play-slot" id="wavePlaySlot"></div>
            <div class="wv-focus-transport-copy"><b id="waveTransportTitle">Запустить орбиту</b><span>Пробел — старт / пауза</span></div>
          </div>
          <div class="wv-focus-volume">
            <button class="icon-btn" id="waveVolBtn" data-act="mute" title="Выключить / включить звук" aria-label="Выключить или включить звук">${icon(Player.muted || Player.volume === 0 ? 'vol0' : Player.volume < 0.5 ? 'vol1' : 'vol2')}</button>
            <div class="slider vol" id="waveVol" title="Громкость"><div class="fill"></div><div class="thumb"></div></div>
            <span id="waveVolVal">${Math.round((Player.muted ? 0 : Player.volume) * 100)}%</span>
          </div>
          <div class="wv-focus-seek"><span id="waveSeekCur">${fmtTime(Player.audio.currentTime || 0)}</span><div class="slider seek" id="waveSeek" title="Позиция трека"><div class="buf"></div><div class="fill"></div><div class="thumb"></div></div><span id="waveSeekDur">${fmtTime(Player.audio.duration || 0)}</span></div>
          <div id="wvNowSlot">${waveNowHtml()}</div>
          <div class="wv-world-guide">${icon('sparkle')}<span><b id="waveWorldName">${esc(selectedWorld.name)}</b><small id="waveWorldHint">В погружении доступны отдельные музыкальные миры</small></span><kbd>0–6</kbd></div>
        </div>
        <div class="wv-portal">
          <div class="wv-orbital-map" aria-hidden="true"><div class="wv-map-label"><span>ОРБИТАЛЬНАЯ КАРТА</span><i>LIVE</i></div><i class="wv-orbit-line l1"></i><i class="wv-orbit-line l2"></i><i class="wv-orbit-line l3"></i><i class="wv-orbit-moon m1"></i><i class="wv-orbit-moon m2"></i><i class="wv-orbit-moon m3"></i><span class="wv-orbit-coordinate c1">01 / ВКУС</span><span class="wv-orbit-coordinate c2">02 / НАСТРОЕНИЕ</span><span class="wv-orbit-coordinate c3">03 / ОТКРЫТИЯ</span></div>
          ${portalHtml()}
          <div class="wv-instrument-action"><span>ЦЕНТР ОРБИТЫ</span><small>Старт / пауза персонального потока</small></div>
        </div>
        <div class="wv-focus-footer"><div class="wv-portal-label"><span></span>Орбитальная карта<span></span></div><div class="wv-portal-sub">Музыка формирует пространство вокруг вас</div><div class="wv-orbit-time" aria-hidden="true"><span data-ring-current>0:00</span><i></i><span data-ring-duration>0:00</span></div></div>
      </section>
      <section class="wv-console glass">
        <div class="wv-console-head">
          <div><span class="wv-section-kicker">Пульт потока</span><h2>Соберите свою частоту</h2></div>
          <p>Поток подстроится автоматически</p>
        </div>
        <div class="mood-tiles">${MOODS.map((m) => `<button class="mood${(w.mood || 'any') === m.id ? ' on' : ''}" style="--m1:${m.c[0]};--m2:${m.c[1]}" data-act="wave-set" data-key="mood" data-val="${m.id}" aria-pressed="${(w.mood || 'any') === m.id}" title="${moodNotes[m.id]}">
          <span class="mood-icon">${icon(m.icon)}</span><span class="mood-copy"><b>${m.label}</b><small>${moodNotes[m.id]}</small></span><span class="mood-check">${icon('check')}</span>
        </button>`).join('')}</div>
        <div class="wv-tune-grid">
          <section class="wv-tune-block"><h3>${icon('globe')}Язык звучания</h3>${pills('lang', LANGS, w.lang)}</section>
          <section class="wv-tune-block"><h3>${icon('compass')}Характер открытий</h3>${pills('pop', POPS, w.pop)}</section>
        </div>
        <section class="wv-genres">
          <div class="wv-genre-head"><h3>${icon('note')}Жанровый спектр</h3><div class="wv-genre-tools"><span id="genreCount">${(w.genres || []).length ? `Выбрано: ${(w.genres || []).length}` : 'Все жанры'}</span>
            <button class="more${(w.genres || []).length ? '' : ' hidden'}" data-act="wave-genre" data-val="__clear" id="genreClear">Сбросить</button></div></div>
          <div class="chips">${GENRES.map(([id, label]) => `<button class="chip${(w.genres || []).includes(id) ? ' on' : ''}" data-act="wave-genre" data-val="${id}" aria-pressed="${(w.genres || []).includes(id)}">${label}</button>`).join('')}</div>
        </section>
      </section>
      <div id="waveNow"></div>
      <div id="waveEditorial">${skeletonShelf('Волны по жанрам и настроениям')}</div>`;
    const calm = Custom.s.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const cosmos = attachCosmos(view.querySelector('#waveCosmos'), pointer);
    Views._bindWaveVolume?.();
    Views._bindWaveSeek?.();
    if (calm && cosmos) requestAnimationFrame(() => requestAnimationFrame(() => cosmos.stop()));
    const hero = view.querySelector('.wv-hero');
    if (!calm) {
      let px = 0;
      let py = 0;
      let raf = 0;
      const paint = () => {
        raf = 0;
        if (!hero.isConnected) return;
        pointer.tx = px;
        pointer.ty = py;
        hero.style.setProperty('--px', px.toFixed(3));
        hero.style.setProperty('--py', py.toFixed(3));
      };
      hero.addEventListener('pointermove', (e) => {
        const r = hero.getBoundingClientRect();
        px = (e.clientX - r.left) / r.width - 0.5;
        py = (e.clientY - r.top) / r.height - 0.5;
        if (!raf) raf = requestAnimationFrame(paint);
      });
      hero.addEventListener('pointerleave', () => {
        px = py = 0;
        if (!raf) raf = requestAnimationFrame(paint);
      });
    }
    Views._waveNow(view);
    try {
      const waves = await api('getWaves', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
      const el = view.querySelector('#waveEditorial');
      if (el) el.innerHTML = waves.length ? shelf('Волны по жанрам и настроениям', waves.map(waveCard).join('')) : '';
    } catch {
      const el = view.querySelector('#waveEditorial');
      if (el) el.innerHTML = '';
    }
  };
  Views._waveTune = (w) => {
    const mood = MOODS.find((m) => m.id === (w.mood || 'any')) || MOODS[0];
    const world = OrbitWorlds.get(w.world);
    const hasWorld = w.world && world.id !== 'any';
    const hero = $('.wv-hero');
    if (hero) {
      hero.style.setProperty('--mood-a', hasWorld ? world.color : mood.c[0]);
      hero.style.setProperty('--mood-b', hasWorld ? world.accent : mood.c[1]);
    }
    const note = $('#waveMoodNote');
    if (note) {
      const text = {
        any: 'Доверьтесь музыкальному потоку',
        energetic: 'Темп, драйв и энергия',
        fun: 'Светлые треки и хороший настрой',
        calm: 'Мягкое звучание без спешки',
        sad: 'Тихие эмоции и атмосфера',
      }[mood.id];
      note.innerHTML = `${icon(hasWorld ? world.icon : mood.icon)}<span>${esc(hasWorld ? world.description : text)}</span>`;
    }
    const worldName = $('#waveWorldName');
    if (worldName) worldName.textContent = world.name;
    const worldHint = $('#waveWorldHint');
    if (worldHint) worldHint.textContent = hasWorld ? world.short : 'Нажмите на планету — включится её музыкальный мир';
    const count = $('#genreCount');
    if (count) count.textContent = (w.genres || []).length ? `Выбрано: ${(w.genres || []).length}` : 'Все жанры';
    $$('[data-act="wave-set"]').forEach((b) => b.setAttribute('aria-pressed', String((w[b.dataset.key] || 'any') === b.dataset.val)));
    $$('[data-act="wave-genre"]').forEach((b) => b.dataset.val !== '__clear' && b.setAttribute('aria-pressed', String((w.genres || []).includes(b.dataset.val))));
  };
  Views._waveNow = (view = document.getElementById('view')) => {
    const slot = view.querySelector('#wvNowSlot');
    if (slot) slot.innerHTML = waveNowHtml();
    const el = view.querySelector('#waveNow');
    if (!el) return;
    if (Player.source?.kind !== 'wave' && Player.source?.kind !== 'ewave' && Player.source?.kind !== 'radio') {
      el.innerHTML = '';
      return;
    }
    const upcoming = Player.queue.slice(Math.max(0, Player.index), Player.index + 8);
    const listId = registerList(upcoming, null);
    el.innerHTML = `<section class="section"><div class="section-head"><h2>Сейчас на орбите · ${esc(Player.source.title || '')}</h2></div>
      <div class="tracks">${upcoming.map((t, i) => trackRow(t, i, listId, { num: () => (i === 0 ? '▶' : i) })).join('')}</div></section>`;
    el.querySelectorAll('.tr').forEach((row, i) => (row.dataset.queueIdx = Player.index + i));
  };

  // ---------- Орбитальный пульс: ритм-игра на текущем аудиопотоке ----------
  Views.pulse = async (view) => {
    view.classList.add('full', 'pulse-view');
    view.innerHTML = '<div class="pulse-loading"><span></span><b>Нова синхронизирует сектор с музыкой…</b></div>';
    const { mountPulse } = await import('./pulse.js');
    if (!view.isConnected || view.dataset.page !== 'pulse' || App.route?.view !== 'pulse') return;
    Views._pulse = mountPulse(view);
  };

  // ---------- Поиск ----------
  Views.search = async (view, { q } = {}) => {
    q = (q || '').trim();
    if (!q) {
      const recent = App.recentSearches();
      view.innerHTML = `<h1 class="page-title">Поиск</h1>
        ${recent.length ? `<section class="section"><div class="section-head"><h2>Вы искали</h2><button class="more" data-act="clear-searches">Очистить</button></div>
          <div class="recent-searches">${recent.map((s) => `<button class="chip" data-act="search" data-q="${esc(s)}">${icon('search')}${esc(s)}</button>`).join('')}</div></section>` : ''}
        <div id="searchWaves">${skeletonShelf('Волны')}</div>`;
      try {
        const waves = await api('getWaves', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
        const el = view.querySelector('#searchWaves');
        if (el) el.innerHTML = shelf('Включите волну', waves.map(waveCard).join(''));
      } catch {}
      return;
    }
    view.innerHTML = `<h1 class="page-title">«${esc(q)}»</h1>${skeletonShelf('Треки')}`;
    let r;
    try {
      r = await api('search', q, 30);
    } catch (e) {
      view.innerHTML = errorBox(e);
      return;
    }
    if (App.route?.params?.q !== q) return;
    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
    const nq = norm(q);
    let top = null;
    const a0 = r.artists[0];
    if (a0 && (norm(a0.title) === nq || (nq.length > 3 && norm(a0.title).startsWith(nq)))) top = { kind: 'artist', item: a0 };
    else if (r.tracks[0]) top = { kind: 'track', item: r.tracks[0] };
    else if (r.releases[0]) top = { kind: 'release', item: r.releases[0] };
    else if (a0) top = { kind: 'artist', item: a0 };
    if (!top) {
      view.innerHTML = `<h1 class="page-title">«${esc(q)}»</h1><div class="empty">${icon('search')}<div>Ничего не нашлось. Попробуйте изменить запрос.</div></div>`;
      return;
    }
    const topHtml = (() => {
      const it = top.item;
      if (top.kind === 'artist')
        return `<div class="top-card glass round" data-act="open" data-kind="artist" data-id="${esc(it.id)}"><img src="${esc(img(it.image?.src, 240))}" alt=""><div><div class="tt">${esc(it.title)}</div><div class="ts"><span class="pill">Исполнитель</span></div></div>
          <button class="play-orb accent xl" data-act="play-entity" data-kind="artist" data-id="${esc(it.id)}">${icon('play')}</button></div>`;
      if (top.kind === 'release')
        return `<div class="top-card glass" data-act="open" data-kind="release" data-id="${esc(it.id)}"><img src="${esc(cover(it, 240))}" alt=""><div><div class="tt">${esc(it.title)}</div><div class="ts"><span class="pill">${releaseType(it.type)}</span>${esc(artistsText(it.artists))}</div></div>
          <button class="play-orb accent xl" data-act="play-entity" data-kind="release" data-id="${esc(it.id)}">${icon('play')}</button></div>`;
      const listId = registerList([it], { kind: 'list', title: it.title });
      return `<div class="top-card glass" data-list="${listId}" data-idx="0" data-act="play-row"><img src="${esc(cover(it, 240))}" alt=""><div><div class="tt">${esc(it.title)}</div><div class="ts"><span class="pill">Трек</span>${artistsLinks(it.artists)}</div></div>
        <button class="play-orb accent xl" data-act="play-row">${icon('play')}</button></div>`;
    })();
    const tl = trackList(r.tracks.slice(0, 30), { kind: 'list', title: `Поиск: ${q}` }, { head: false, compact: true });
    view.innerHTML = `<h1 class="page-title">«${esc(q)}»</h1>
      <div class="search-top">
        <section><div class="section-head"><h2>Лучший результат</h2></div>${topHtml}</section>
        <section style="min-width:0"><div class="section-head"><h2>Треки</h2></div><div class="search-tracks" style="max-height:${52 * 5 + 8}px;overflow:hidden" id="searchTracks">${tl.html}</div>
          ${r.tracks.length > 5 ? '<button class="more" data-act="expand-tracks" style="margin-top:8px;color:var(--text-2);font-weight:600">Показать все треки</button>' : ''}</section>
      </div>
      ${r.artists.length ? shelf('Исполнители', r.artists.map(artistCard).join('')) : ''}
      ${r.releases.length ? shelf('Альбомы и синглы', r.releases.map(releaseCard).join('')) : ''}
      ${r.playlists.length ? shelf('Плейлисты', r.playlists.map(playlistCard).join('')) : ''}`;
  };

  // ---------- Исполнитель ----------
  Views.artist = async (view, { id }) => {
    view.innerHTML = skeletonPage();
    let a;
    try {
      a = await api('getArtist', id);
    } catch (e) {
      view.innerHTML = errorBox(e);
      return;
    }
    if (!a) {
      view.innerHTML = errorBox({ message: 'Исполнитель не найден' }, false);
      return;
    }
    App.setPageTheme(a);
    const liked = App.likes.artist.has(String(a.id));
    const releases = a.releases || [];
    const albums = releases.filter((r) => r.type === 'album');
    const singles = releases.filter((r) => r.type === 'single' || r.type === 'ep');
    const comps = releases.filter((r) => r.type === 'compilation');
    const pop = a.popularTracks || [];
    const tl = trackList(pop, { kind: 'list', title: a.title }, { head: false, album: true });
    const bgLayers = [a.image?.src].filter(Boolean).map((s) => `url('${esc(img(s, 1000))}')`).join(', ') || 'none';
    const likes = a.collectionItemData?.likesCount;
    view.innerHTML = `<div class="hero artist-hero" style="--hero:${App.heroColor(a)}">
        <div class="hero-bg" style="background-image:${bgLayers}"></div>
        <div class="hero-info"><div class="kind">Исполнитель</div><h1>${esc(a.title)}</h1>
          <div class="meta">${likes ? `<b>${likes.toLocaleString('ru-RU')}</b> в коллекциях` : ''}</div></div>
      </div>
      <div class="actions">
        <button class="play-orb accent xl" data-act="play-entity" data-kind="artist" data-id="${esc(a.id)}" title="Популярные треки">${icon('play')}</button>
        <button class="btn" data-act="radio" data-type="ARTIST" data-id="${esc(a.id)}" data-title="${esc(a.title)}">${icon('radio')}Радио исполнителя</button>
        <button class="btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="artist" data-id="${esc(a.id)}">${icon(liked ? 'heartFill' : 'heart')}<span>${liked ? 'В коллекции' : 'В коллекцию'}</span></button>
      </div>
      ${pop.length ? `<section class="section pop-sec" id="popSec"><div class="section-head"><h2>Популярные треки</h2><span class="pop-count" id="popCount"></span></div>
        <div id="popTracks" class="pop-tracks collapsed">${tl.html}</div>
        <div class="pop-more">${pop.length > 5 ? '<button class="chip" data-act="expand-pop">Ещё</button>' : ''}</div></section>` : ''}
      ${albums.length ? shelf('Альбомы', albums.map(releaseCardType).join('')) : ''}
      ${singles.length ? shelf('Синглы и EP', singles.map(releaseCardType).join('')) : ''}
      ${comps.length ? shelf('Сборники', comps.map(releaseCardType).join('')) : ''}
      ${a.relatedArtists?.length ? shelf('Похожие исполнители', a.relatedArtists.map(artistCard).join('')) : ''}
      ${a.description ? `<section class="section"><div class="section-head"><h2>Об исполнителе</h2></div><div class="glass panel" style="padding:22px 24px;border-radius:24px;max-width:900px"><div style="position:relative;z-index:2;color:var(--text-2);white-space:pre-line;user-select:text">${esc(a.description)}</div></div></section>` : ''}`;
    const sec = view.querySelector('#popSec');
    // Список из getArtist (20 шт.) дополняется полным при первом «Ещё». Массив pop зарегистрирован как
    // список воспроизведения — новые треки дописываются в него же, и клик по любой строке играет всё подряд.
    // Zvuk отдаёт на одну позицию меньше запрошенного (19 из 20) — полный список догружаем, если пришло 15 и больше
    if (sec) sec._pop = { id: a.id, tracks: pop, listId: tl.listId, shown: pop.length, full: pop.length < 15, loading: null };
  };

  const POP_STEP = 50;
  /** «Ещё» в популярных треках: сначала раскрываем первые 20, затем догружаем полный список и показываем порциями. */
  Views.popMore = async (btn, collapse) => {
    const sec = btn.closest('#popSec');
    const st = sec && sec._pop;
    if (!st) return;
    const box = sec.querySelector('#popTracks');
    const list = box.querySelector('.tracks');
    const more = sec.querySelector('.pop-more');
    if (collapse) {
      box.classList.add('collapsed');
      more.innerHTML = '<button class="chip" data-act="expand-pop">Ещё</button>';
      list.dataset.virtualTotal = String(st.shown);
      virtualize(box);
      sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const wasCollapsed = box.classList.contains('collapsed');
    box.classList.remove('collapsed');
    btn.disabled = true;
    if (!st.full && !st.loading) {
      st.loading = api('getArtistTracks', st.id, 500)
        .then((all) => {
          const have = new Set(st.tracks.map((t) => String(t.id)));
          for (const t of all || []) if (!have.has(String(t.id))) st.tracks.push(t);
          st.full = true;
        })
        .catch(() => {})
        .finally(() => (st.loading = null));
    }
    if (!wasCollapsed) {
      // уже раскрыто — показываем следующую порцию
      if (st.loading) {
        btn.disabled = true;
        btn.textContent = 'Загружаю…';
        await st.loading;
      }
      const from = st.shown;
      const to = Math.min(st.tracks.length, from + POP_STEP);
      if (!list.dataset.virtualized) list.insertAdjacentHTML('beforeend', st.tracks.slice(from, to).map((t, i) => trackRow(t, from + i, st.listId, { album: true })).join(''));
      st.shown = to;
    } else if (st.loading) await st.loading;
    st.shown = Math.min(st.shown, st.tracks.length);
    list.dataset.virtualTotal = String(st.shown);
    virtualize(box);
    const left = st.tracks.length - st.shown;
    sec.querySelector('#popCount').textContent = st.full ? tracksWord(st.tracks.length) : '';
    more.innerHTML =
      (left > 0 ? `<button class="chip" data-act="expand-pop">Показать ещё ${Math.min(left, POP_STEP)}</button>` : '') +
      '<button class="chip" data-act="collapse-pop">Свернуть</button>';
  };

  // ---------- Релиз ----------
  Views.release = async (view, { id }) => {
    view.innerHTML = skeletonPage();
    let r;
    try {
      r = await api('getRelease', id);
    } catch (e) {
      view.innerHTML = errorBox(e);
      return;
    }
    if (!r) {
      view.innerHTML = errorBox({ message: 'Релиз не найден' }, false);
      return;
    }
    App.setPageTheme(r);
    const tracks = (r.tracks || []).map((t) => ({ ...t, release: t.release || { id: r.id, title: r.title, image: r.image } }));
    const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const liked = App.likes.release.has(String(r.id));
    const tl = trackList(tracks, { kind: 'list', title: r.title }, { album: false, cover: false });
    view.innerHTML = `<div class="hero" style="--hero:${App.heroColor(r)}">
        <div class="hero-cover"><img src="${esc(cover(r, 600))}" alt=""></div>
        <div class="hero-info"><div class="kind">${releaseType(r.type)}</div><h1>${esc(r.title)}</h1>
          <div class="meta"><b>${artistsLinks(r.artists)}</b><span class="dot"></span>${year(r.date)}<span class="dot"></span>${tracksWord(tracks.length)}, ${fmtTotal(total)}</div>
          ${r.genres?.length ? `<div class="desc">${esc(r.genres.map((g) => g.name).join(', '))}</div>` : ''}</div>
      </div>
      <div class="actions">
        <button class="play-orb accent xl" data-act="play-list-all" data-list="${tl.listId}">${icon('play')}</button>
        <button class="icon-btn" data-act="shuffle-list" data-list="${tl.listId}" title="Перемешать">${icon('shuffle')}</button>
        <button class="icon-btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="release" data-id="${esc(r.id)}" title="В коллекцию">${icon(liked ? 'heartFill' : 'heart')}</button>
        <button class="icon-btn" data-act="radio" data-type="RELEASE" data-id="${esc(r.id)}" data-title="${esc(r.title)}" title="Радио по альбому">${icon('radio')}</button>
        <button class="icon-btn" data-act="entity-menu" data-kind="release" data-id="${esc(r.id)}" title="Ещё">${icon('more')}</button>
      </div>
      ${tl.html}
      ${r.label?.title ? `<div class="muted small" style="margin:18px 14px 0">${r.date ? new Date(r.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' : ''}${esc(r.label.title)}</div>` : ''}
      ${r.related?.length ? shelf('Похожие релизы', r.related.map(releaseCard).join('')) : ''}`;
  };

  // ---------- Плейлист ----------
  Views.playlist = async (view, { id }) => {
    view.innerHTML = skeletonPage();
    let p;
    try {
      p = await api('getPlaylist', id);
    } catch (e) {
      view.innerHTML = errorBox(e);
      return;
    }
    if (!p) {
      view.innerHTML = errorBox({ message: 'Плейлист не найден' }, false);
      return;
    }
    const own = App.isOwnPlaylist(p);
    App.setPageTheme(p.tracks[0] || p);
    const total = p.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const liked = App.likes.playlist.has(String(p.id));
    const art = playlistArt(p, 600);
    const tl = trackList(p.tracks, { kind: 'list', title: p.title, playlistId: own ? String(p.id) : null }, {});
    view.innerHTML = `<div class="hero" style="--hero:${App.heroColor(p.tracks[0] || p)}">
        <div class="hero-cover">${art || `<div class="tile-art">${icon('playlist')}</div>`}</div>
        <div class="hero-info"><div class="kind">${own ? 'Мой плейлист' : 'Плейлист'}</div><h1>${esc(p.title)}</h1>
          ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
          <div class="meta" style="margin-top:8px">${tracksWord(p.tracks.length)}${total ? ', ' + fmtTotal(total) : ''}</div></div>
      </div>
      <div class="actions">
        <button class="play-orb accent xl" data-act="play-list-all" data-list="${tl.listId}" ${p.tracks.length ? '' : 'disabled'}>${icon('play')}</button>
        <button class="icon-btn" data-act="shuffle-list" data-list="${tl.listId}" title="Перемешать">${icon('shuffle')}</button>
        ${own ? '' : `<button class="icon-btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="playlist" data-id="${esc(p.id)}" title="В коллекцию">${icon(liked ? 'heartFill' : 'heart')}</button>`}
        <button class="icon-btn" data-act="entity-menu" data-kind="playlist" data-id="${esc(p.id)}" title="Ещё">${icon('more')}</button>
      </div>
      ${p.tracks.length ? tl.html : `<div class="empty">${icon('playlist')}<div>В плейлисте пока нет треков. Добавляйте их через меню «⋯» у любого трека.</div></div>`}`;
  };

  // ---------- Любимые треки ----------
  Views.liked = async (view) => {
    view.innerHTML = `<div class="hero liked-hero" style="--hero:var(--accent-2)">
        <div class="liked-visual" aria-hidden="true"><div class="liked-orbits"><i></i><i></i><i></i><span>${icon('heartFill')}</span><b></b><b></b><b></b></div><small>ЛИЧНАЯ ГРАВИТАЦИЯ</small></div>
        <div class="hero-info"><div class="kind">Личное созвездие</div><h1>Любимые треки</h1><p class="liked-intro">Всё, к чему хочется возвращаться,<br>собрано в одной системе.</p><div class="meta" id="likedMeta">Загрузка…</div></div>
      </div>
      <div class="actions liked-actions">
        <button class="play-orb accent xl" data-act="play-list-all" id="likedPlay">${icon('play')}</button>
        <button class="icon-btn" data-act="shuffle-list" id="likedShuffle" title="Перемешать">${icon('shuffle')}</button>
        <label class="liked-search">${icon('search')}<input class="input" id="likedFilter" placeholder="Найти в созвездии" aria-label="Найти в любимых треках" /></label>
      </div>
      <div id="likedList">${Array.from({ length: 10 }, () => '<div class="skel" style="height:50px;margin:6px 0;border-radius:14px"></div>').join('')}</div>`;
    let ids;
    try {
      ids = await api('getLikedTrackIds');
    } catch (e) {
      view.querySelector('#likedList').innerHTML = errorBox(e);
      return;
    }
    const filterScenario = new URLSearchParams(window.__ZG_ARGS__ || location.search).get('extra') === 'likedfilter';
    let useFilterFixture = false;
    if (filterScenario && ids.length < 36) {
      ids = Array.from({ length: 240 }, (_, i) => `filter-track-${i}`);
      useFilterFixture = true;
    }
    App.likes.track = new Set(ids);
    const meta = view.querySelector('#likedMeta');
    if (meta) meta.textContent = tracksWord(ids.length);
    const listEl = view.querySelector('#likedList');
    if (!ids.length) {
      listEl.innerHTML = `<div class="empty">${icon('heart')}<div>Отмечайте треки сердечком — они появятся здесь.</div></div>`;
      return;
    }
    const tracks = [];
    const src = { kind: 'list', title: 'Любимые треки' };
    const listId = registerList(tracks, src);
    view.querySelector('#likedPlay').dataset.list = listId;
    view.querySelector('#likedShuffle').dataset.list = listId;
    listEl.innerHTML = `<div class="tracks" data-list-root="${listId}"></div>`;
    const root = listEl.firstChild;
    const list = Lists.get(listId);
    const filter = view.querySelector('#likedFilter');
    const textCache = new WeakMap();
    const normalize = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const searchText = (track) => {
      if (!textCache.has(track)) textCache.set(track, normalize(`${track.title} ${artistsText(track.artists)} ${track.release?.title || ''}`));
      return textCache.get(track);
    };
    const applyFilter = () => {
      if (!root.isConnected) return;
      const tokens = normalize(filter.value).split(' ').filter(Boolean);
      const matched = tokens.length ? tracks.filter((track) => tokens.every((token) => searchText(track).includes(token))) : tracks.slice();
      replaceListTracks(root, list, matched, tokens.length ? 'Ничего не найдено. Попробуйте другое название или исполнителя.' : '');
    };
    filter.addEventListener('input', applyFilter);
    const fixture = [
      ['God Is A Weapon', 'Falling In Reverse', 'Popular Monster'],
      ['GPT', 'Элджей, ANIKV', 'COMPLEX полноценности'],
      ['GO', 'Blackpink', 'DEADLINE'],
      ['Во тьме', 'dotla.', 'Пьяный поцелуй'],
      ['Love Me', 'From Ashes To New', 'Blackout'],
      ['Spiral Dreams', 'Nova', 'Гравитация'],
    ];
    const fixtureImages = ['joy', 'shy', 'support', 'tenderness', 'thoughtful', 'surprise'];
    for (let i = 0; i < ids.length; i += 150) {
      const part = useFilterFixture ? ids.slice(i, i + 150).map((id, k) => {
        const n = i + k;
        const f = fixture[n % fixture.length];
        return {
          id, title: n < fixture.length ? f[0] : `${f[0]} · ${n + 1}`, duration: 180 + n % 90,
          artists: [{ id: `filter-artist-${n % fixture.length}`, title: f[1] }],
          release: { id: `filter-release-${n % fixture.length}`, title: f[2], image: { src: `assets/nova/emotions/${fixtureImages[n % fixtureImages.length]}.webp` } },
        };
      }) : await api('getTracks', ids.slice(i, i + 150));
      if (!root.isConnected) return;
      const start = tracks.length;
      tracks.push(...part);
      root.insertAdjacentHTML('beforeend', part.map((t, k) => trackRow(t, start + k, listId)).join(''));
      if (normalize(filter.value)) applyFilter();
      else list.tracks = tracks;
    }
  };

  // ---------- Коллекция ----------
  async function collectionGrid(view, title, loader, render, emptyText) {
    view.innerHTML = `<h1 class="page-title">${esc(title)}</h1><div class="grid">${Array.from({ length: 12 }, () => '<div class="card"><div class="cover skel"></div><div class="skel" style="height:14px;margin-top:12px;width:70%"></div></div>').join('')}</div>`;
    try {
      const items = await loader();
      view.innerHTML = `<h1 class="page-title">${esc(title)}</h1>${items.length ? `<div class="grid">${items.map(render).join('')}</div>` : `<div class="empty">${icon('note')}<div>${esc(emptyText)}</div></div>`}`;
    } catch (e) {
      view.innerHTML = `<h1 class="page-title">${esc(title)}</h1>${errorBox(e)}`;
    }
  }
  Views.albums = (view) =>
    collectionGrid(view, 'Альбомы', async () => {
      const c = await App.refreshCollection();
      return api('getReleasesShort', c.releases.slice(0, 500));
    }, releaseCard, 'Добавляйте альбомы в коллекцию — они появятся здесь.');
  Views.artists = (view) =>
    collectionGrid(view, 'Исполнители', async () => {
      const c = await App.refreshCollection();
      return api('getArtistsShort', c.artists.slice(0, 500));
    }, artistCard, 'Добавляйте исполнителей в коллекцию — они появятся здесь.');
  Views.playlists = async (view) => {
    await collectionGrid(view, 'Плейлисты', async () => {
      await App.loadPlaylists();
      return App.playlists;
    }, playlistCard, 'Здесь появятся ваши плейлисты.');
    const grid = view.querySelector('.grid') || view;
    grid.insertAdjacentHTML('afterbegin', card({ kind: 'new-playlist', id: 'new', title: 'Новый плейлист', sub: 'Создать', playable: false, art: `<div class="tile-art" style="--t1:rgba(255,255,255,.12);--t2:rgba(255,255,255,.04)">${icon('plus')}</div>` }));
  };

  // ---------- История ----------
  Views.history = async (view) => {
    view.innerHTML = `<h1 class="page-title">История прослушиваний</h1>${Array.from({ length: 10 }, () => '<div class="skel" style="height:50px;margin:6px 0;border-radius:14px"></div>').join('')}`;
    try {
      const hist = await api('listeningHistory', 100);
      const tl = trackList(hist, { kind: 'list', title: 'История' }, {});
      view.innerHTML = `<h1 class="page-title">История прослушиваний</h1>${hist.length ? tl.html : `<div class="empty">${icon('clock')}<div>История пока пуста.</div></div>`}`;
    } catch (e) {
      view.innerHTML = `<h1 class="page-title">История прослушиваний</h1>${errorBox(e)}`;
    }
  };

  // ---------- Визуализатор под ритм музыки (минималистичный) ----------
  Views.visualizer = async (view) => {
    view.classList.add('full');
    const t = Player.current;
    view.innerHTML = `<div class="vz-stage" id="vizStage">
      <div class="vz-center">
        <div class="vz-cover-wrap" id="vizCoverWrap"><img class="vz-cover" id="vizCover" src="${esc(cover(t, 600))}" alt=""></div>
        <div class="vz-t1" id="vizTitle">${esc(t ? t.title : 'Включите музыку')}</div>
        <div class="vz-t2" id="vizArtist">${t ? esc(artistsText(t.artists)) : 'Визуализация оживёт под ритм'}</div>
        <div class="vz-ctrl">
          <button class="icon-btn" data-act="prev" title="Предыдущий">${icon('prev')}</button>
          <button class="play-orb" data-act="toggle" id="vizPlay" title="Играть / пауза">${icon(Player.playing ? 'pause' : 'play')}</button>
          <button class="icon-btn" data-act="next" title="Следующий">${icon('next')}</button>
        </div>
      </div>
      <button class="icon-btn glass-btn vz-fs" data-vact="fullscreen" title="Во весь экран (F)">${icon('fullscreen')}</button>
    </div>`;
    const stage = view.querySelector('#vizStage');
    const wrap = view.querySelector('#vizCoverWrap');
    const scene = VizScene.mount({
      layer: stage,
      host: stage,
      kind: 'tab',
      centerFn: (canvas) => {
        const c = canvas.getBoundingClientRect();
        const e = wrap.getBoundingClientRect();
        return { x: e.left + e.width / 2 - c.left, y: e.top + e.height / 2 - c.top, r: e.width / 2 };
      },
    });
    Views._vizScene = scene;
    // Прячем кнопки, когда мышь не двигается
    let idleT = 0;
    const wake = () => {
      stage.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => stage.isConnected && !stage.querySelector('.vz-panel:not(.hidden)') && stage.classList.add('idle'), 2800);
    };
    stage.addEventListener('pointermove', wake);
    wake();
    const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen().catch(() => {}));
    stage.addEventListener('dblclick', (e) => !e.target.closest('button, input, .vz-panel') && toggleFs());
    stage.querySelector('[data-vact="fullscreen"]').addEventListener('click', toggleFs);
  };
  Views._vizTrack = (t) => {
    const s = document.getElementById('vizStage');
    if (!s || !t) return;
    s.querySelector('#vizCover').src = cover(t, 600);
    s.querySelector('#vizTitle').textContent = t.title;
    s.querySelector('#vizArtist').textContent = artistsText(t.artists);
    Views._vizScene && Views._vizScene.setTrack(t);
  };

  // ---------- Эквалайзер ----------
  const fmtDb = (v) => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(Math.abs(v) % 1 ? 1 : 0);
  const eqSlider = (band, label) => `<div class="vs${band === 'pre' ? ' pre' : ''}" data-band="${band}">
        <div class="val"></div><div class="track"><div class="fill"></div><div class="knob"></div></div><div class="lbl">${label}</div></div>`;
  /** Положение вертикальных ползунков (.vs[data-band]) по текущим настройкам. */
  function paintEqSliders(root, unit = ' дБ') {
    const e = AudioFX.eq;
    root.querySelectorAll('.vs').forEach((el) => {
      const b = el.dataset.band;
      const v = b === 'pre' ? e.preamp : e.bands[+b];
      const top = ((12 - v) / 24) * 100;
      el.querySelector('.val').textContent = fmtDb(v) + unit;
      el.querySelector('.knob').style.top = top + '%';
      const fill = el.querySelector('.fill');
      fill.style.top = Math.min(50, top) + '%';
      fill.style.height = Math.abs(top - 50) + '%';
    });
  }
  /** Перетаскивание, двойной щелчок и колёсико на ползунках — общие для страницы и мини-эквалайзера. */
  function bindEqSliders(root, sync) {
    const setVal = (band, v) => (band === 'pre' ? AudioFX.setPreamp(v) : AudioFX.setBand(+band, v));
    root.querySelectorAll('.vs').forEach((el) => {
      const track = el.querySelector('.track');
      const band = el.dataset.band;
      const fromY = (y) => {
        const r = track.getBoundingClientRect();
        return 12 - ((y - r.top) / r.height) * 24;
      };
      let drag = false;
      track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = true;
        el.classList.add('drag');
        track.setPointerCapture(e.pointerId);
        setVal(band, fromY(e.clientY));
        sync();
      });
      track.addEventListener('pointermove', (e) => {
        if (!drag) return;
        setVal(band, fromY(e.clientY));
        sync();
      });
      const end = () => {
        drag = false;
        el.classList.remove('drag');
      };
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
      track.addEventListener('dblclick', () => {
        setVal(band, 0);
        sync();
      });
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        const cur = band === 'pre' ? AudioFX.eq.preamp : AudioFX.eq.bands[+band];
        setVal(band, cur + (e.deltaY < 0 ? 0.5 : -0.5));
        sync();
      });
    });
  }
  /** Кнопки пресетов (активный подсвечен, «Свой» — если ползунки двигали вручную). */
  // Готовые пресеты, «Свой» (последние ручные настройки — не пропадает при переключении) и свои с названиями.
  // manage — на странице эквалайзера ещё кнопка «Сохранить как пресет».
  const eqPresetChips = (manage = false) => {
    const cur = AudioFX.eq.preset;
    const chip = (id, name, cls = '') => `<button class="chip${cls}${cur === id ? ' on' : ''}" data-eqp="${esc(id)}" title="${esc(name)}">${esc(name)}</button>`;
    return (
      Object.entries(AudioFX.PRESETS).map(([id, p]) => chip(id, p.name)).join('') +
      chip('custom', 'Свой', ' eq-own') +
      (AudioFX.eq.user || []).map((p) => chip(p.id, p.name, ' eq-user')).join('') +
      (manage ? `<button class="chip eq-add" data-eqsave title="Сохранить текущие настройки как свой пресет">${icon('plus')}Сохранить как пресет</button>` : '')
    );
  };
  Views.eq = { slider: eqSlider, paint: paintEqSliders, bind: bindEqSliders, presets: eqPresetChips };

  const headphonePanels = () => `<section class="hq-section" id="eqHeadphones">
    <div class="hq-section-head"><div><span class="wv-section-kicker">Персональная акустика</span><h2>Профили для наушников</h2></div>
      <p>Измеренные коррекции и отдельные тембральные пресеты Nova с акцентом на бас.</p></div>
    ${HeadphoneEQ.models.map((model) => {
      const open = HeadphoneEQ.get(AudioFX.eq.preset)?.modelId === model.id;
      return `<section class="hq-model glass${open ? ' open' : ''}" data-hq-model="${model.id}">
        <button class="hq-toggle" type="button" data-hq-toggle="${model.id}" aria-expanded="${open}" aria-controls="hq-${model.id}">
          <span class="hq-emblem">${icon('eq')}</span><span class="hq-heading"><b>${esc(model.name)}</b><small>${model.presets.length} пресета · 10 полос · защита от перегруза</small></span>
          <span class="hq-state" data-hq-state></span><span class="hq-chevron">${icon('chevronDown')}</span>
        </button>
        <div class="hq-drawer" id="hq-${model.id}" aria-hidden="${!open}" ${open ? '' : 'inert'}><div class="hq-drawer-clip"><div class="hq-inner">
          <p class="hq-intro">${esc(model.description)}</p>
          <div class="hq-presets">${model.presets.map((p) => `<article class="hq-preset" data-hq-preset="${p.id}">
            <div class="hq-preset-head"><h3>${esc(p.name)}</h3><button class="btn small primary" type="button" data-eqp="${p.id}">Применить</button></div>
            <p>${esc(p.description)}</p>
            <div class="hq-bands" aria-label="Значения полос в децибелах">${p.bands.map((v, i) => `<span><small>${AudioFX.LABELS[i]}</small><b>${v > 0 ? '+' : ''}${v}</b></span>`).join('')}</div>
            <div class="hq-preset-foot"><span>Уровень ${p.preamp} дБ · ${esc(p.basis)}</span>${p.sourceUrl ? `<button class="hq-source" type="button" data-act="open-zvuk" data-url="${esc(p.sourceUrl)}">${esc(p.source)} ↗</button>` : `<small class="hq-local-source">${esc(p.source)}</small>`}</div>
          </article>`).join('')}</div>
          <p class="hq-disclaimer">Это отправные точки, а не обязательный «правильный» звук: посадка, состояние амбушюр и слух влияют на результат. Сравнивайте на комфортной громкости. Во избежание двойной коррекции не включайте одновременно другой эквалайзер для этих наушников.</p>
        </div></div></div>
      </section>`;
    }).join('')}
  </section>`;

  Views.equalizer = async (view) => {
    const eq = AudioFX.eq;
    const slider = eqSlider;
    view.innerHTML = `<div class="eq-head"><h1 class="page-title">Эквалайзер</h1>
        <div class="ctrl"><button class="icon-btn eq-lock${eq.locked ? ' on' : ''}" id="eqLock" type="button" title="${eq.locked ? 'Разблокировать настройки' : 'Заблокировать настройки'}" aria-label="Блокировка настроек эквалайзера" aria-pressed="${Boolean(eq.locked)}">${icon(eq.locked ? 'lock' : 'unlock')}</button>${AudioFX.ready ? '' : '<span class="muted small">Web Audio недоступен</span>'}<span>Включён</span><button class="switch${eq.enabled ? ' on' : ''}" id="eqSwitch"></button></div></div>
      <div class="eq-panel glass${eq.enabled ? '' : ' off'}${eq.locked ? ' locked' : ''}" id="eqPanel">
        <div class="eq-grid">
          ${slider('pre', 'Уровень')}
          <div class="eq-sep"></div>
          <div class="eq-bands"><canvas class="eq-canvas" id="eqCanvas"></canvas>${AudioFX.FREQS.map((f, i) => slider(i, AudioFX.LABELS[i])).join('')}</div>
        </div>
      </div>
      <div class="eq-presets" id="eqPresets"></div>
      <div class="eq-manage" id="eqManage"></div>
      <div class="eq-options">
        <div class="opt"><button class="switch${eq.compressor ? ' on' : ''}" id="eqComp"></button>Компрессор — выравнивает громкость тихих и громких мест</div>
        <button class="btn" id="eqReset">${icon('refresh')}Сбросить</button>
      </div>
      <p class="eq-note">Тяните ползунки вверх и вниз · двойной щелчок возвращает 0 дБ · колёсико мыши — точная подстройка. Настройки применяются ко всей музыке сразу.</p>
      ${headphonePanels()}`;

    const panel = view.querySelector('#eqPanel');
    const sync = () => {
      const e = AudioFX.eq;
      panel.classList.toggle('off', !e.enabled);
      panel.classList.toggle('locked', Boolean(e.locked));
      panel.setAttribute('aria-disabled', String(Boolean(e.locked)));
      view.querySelector('#eqSwitch').classList.toggle('on', e.enabled);
      view.querySelector('#eqComp').classList.toggle('on', e.compressor);
      const lock = view.querySelector('#eqLock');
      lock.classList.toggle('on', Boolean(e.locked));
      lock.setAttribute('aria-pressed', String(Boolean(e.locked)));
      lock.title = e.locked ? 'Разблокировать настройки' : 'Заблокировать настройки';
      lock.innerHTML = icon(e.locked ? 'lock' : 'unlock');
      paintEqSliders(view);
      view.querySelector('#eqPresets').innerHTML = eqPresetChips(true);
      view.querySelectorAll('.hq-preset').forEach((card) => {
        const active = card.dataset.hqPreset === e.preset;
        card.classList.toggle('active', active);
        card.querySelector('[data-eqp]').innerHTML = active ? `${icon('check')}Применён` : 'Применить';
      });
      view.querySelectorAll('.hq-model').forEach((card) => {
        const selected = HeadphoneEQ.get(e.preset)?.modelId === card.dataset.hqModel;
        const state = card.querySelector('[data-hq-state]');
        state.textContent = selected ? 'Профиль выбран' : '';
        state.classList.toggle('active', selected);
      });
      const u = AudioFX.userPreset(e.preset);
      view.querySelector('#eqManage').innerHTML = u
        ? `<span>Свой пресет «${esc(u.name)}» — изменения ползунков сохраняются в нём</span><button class="btn small" data-eqrename>${icon('edit')}Переименовать</button><button class="btn small" data-eqdelete>${icon('trash')}Удалить</button>`
        : e.preset === 'custom'
          ? '<span>«Свой» — ваши последние ручные настройки. Они не пропадут, если переключиться на другой пресет и обратно.</span>'
          : '';
      view.querySelectorAll('#eqPresets button, #eqManage button, #eqComp, #eqReset, .hq-preset [data-eqp]').forEach((button) => { button.disabled = Boolean(e.locked); });
    };
    // изменения из мини-эквалайзера в полноэкранном плеере
    const onExternal = () => (view.contains(panel) ? sync() : window.removeEventListener('zg:eq', onExternal));
    window.addEventListener('zg:eq', onExternal);
    bindEqSliders(view, sync);
    view.querySelector('#eqLock').addEventListener('click', () => {
      AudioFX.setLocked(!AudioFX.eq.locked);
      sync();
    });
    view.querySelector('#eqSwitch').addEventListener('click', () => {
      AudioFX.setEnabled(!AudioFX.eq.enabled);
      sync();
    });
    view.querySelector('#eqComp').addEventListener('click', () => {
      AudioFX.setCompressor(!AudioFX.eq.compressor);
      if (AudioFX.eq.compressor && !AudioFX.eq.enabled) AudioFX.setEnabled(true);
      sync();
    });
    view.querySelector('#eqReset').addEventListener('click', () => {
      AudioFX.reset();
      sync();
    });
    view.querySelector('#eqPresets').addEventListener('click', async (e) => {
      if (e.target.closest('[data-eqsave]')) {
        const name = await modal({ title: 'Свой пресет', text: 'Текущие настройки сохранятся под этим названием. Потом их можно менять — пресет запомнит изменения.', input: '', okText: 'Сохранить' });
        if (name && AudioFX.savePreset(name)) toast(`Пресет «${name}» сохранён`, { iconName: 'check' });
        else if (name) toast('Слишком много своих пресетов — удалите ненужные', { error: true });
        sync();
        return;
      }
      const b = e.target.closest('[data-eqp]');
      if (!b) return;
      AudioFX.setPreset(b.dataset.eqp);
      if (!AudioFX.eq.enabled) AudioFX.setEnabled(true);
      sync();
    });
    view.querySelector('#eqHeadphones').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-hq-toggle]');
      if (toggle) {
        const card = toggle.closest('.hq-model');
        const open = !card.classList.contains('open');
        card.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
        const drawer = card.querySelector('.hq-drawer');
        drawer.inert = !open;
        drawer.setAttribute('aria-hidden', String(!open));
        return;
      }
      const preset = e.target.closest('.hq-preset [data-eqp]');
      if (!preset) return;
      AudioFX.setPreset(preset.dataset.eqp);
      sync();
    });
    // свой пресет выбран — его можно переименовать или удалить
    view.querySelector('#eqManage').addEventListener('click', async (e) => {
      const id = AudioFX.eq.preset;
      const u = AudioFX.userPreset(id);
      if (!u) return;
      if (e.target.closest('[data-eqrename]')) {
        const name = await modal({ title: 'Название пресета', input: u.name, okText: 'Сохранить' });
        if (name) AudioFX.renamePreset(id, name);
      } else if (e.target.closest('[data-eqdelete]')) {
        const ok = await modal({ title: `Удалить пресет «${u.name}»?`, text: 'Его настройки останутся в пресете «Свой».', okText: 'Удалить', danger: true });
        if (ok) AudioFX.deletePreset(id);
      }
      sync();
    });
    sync();
    Viz.attach(view.querySelector('#eqCanvas'), { style: 'eq', padTop: 26, padBottom: 28, idle: false, sensitivity: 1.1 });
  };

  // ---------- Настройки ----------
  function updateRangeFill(r) {
    const p = ((parseFloat(r.value) - parseFloat(r.min)) / (parseFloat(r.max) - parseFloat(r.min))) * 100;
    r.style.setProperty('--p', p.toFixed(1) + '%');
    const lbl = r.parentElement.querySelector('.range-val');
    if (lbl) lbl.textContent = fmtSet(parseFloat(r.value), r.dataset.fmt);
  }
  window.updateRangeFill = updateRangeFill;
  function fmtSet(v, f) {
    if (f === 'px') return Math.round(v) + 'px';
    if (f === '%') return Math.round(v) + '%';
    if (f === 'x') return Math.round(v * 100) + '%';
    return String(v);
  }

  Views.settings = async (view) => {
    const p = App.profile || {};
    const s = Custom.s;
    const q = Player.quality;
    const performanceMode = App.settings.performanceMode || 'auto';
    const performanceNotes = {
      auto: 'Полное качество, разрешение и частота дисплея. Приложение само прекращает невидимую и ненужную работу без ограничения FPS.',
      full: 'Все видимые эффекты и анимации активны. Полное разрешение, материалы и максимальная частота дисплея.',
      eco: 'Только декоративный фон становится статичным. Разрешение, материалы и частота кадров не снижаются.',
    };
    const name = App.displayName();
    const av = App.avatarUrl(160);
    const seg = (key, list, cur) => `<div class="seg">${list.map(([id, label]) => `<button class="${cur === id ? 'on' : ''}" data-cseg="${key}" data-val="${id}">${label}</button>`).join('')}</div>`;
    const range = (key, min, max, step, fmt) =>
      `<div class="ctrl"><input type="range" class="range" data-cset="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-fmt="${fmt}"><span class="range-val"></span></div>`;
    const sw = (key, on) => `<button class="switch${on ? ' on' : ''}" data-cswitch="${key}"></button>`;
    const row = (label, sub, ctrl) => `<div class="row"><div class="lbl">${label}${sub ? `<div class="s">${sub}</div>` : ''}</div>${ctrl}</div>`;
    const mediaBlock = (key, kind) => {
      const url = Custom.media[key];
      const thumb = url ? (kind === 'video' ? `<video src="${esc(url)}" muted loop autoplay playsinline></video>` : '') : icon(kind === 'video' ? 'video' : 'image');
      return `<div class="row"><div class="media-pick">
        <div class="media-thumb" style="${url && kind !== 'video' ? `background-image:url('${esc(url)}')` : ''}">${thumb}</div>
        <div><div style="font-weight:600">${kind === 'video' ? 'Своё видео на фоне' : 'Своя картинка на фоне'}</div>
          <div class="muted small" style="margin:2px 0 10px">${kind === 'video' ? 'MP4 или WebM, зацикливается без звука' : 'JPG, PNG, WebP или GIF'}</div>
          <div class="btns"><button class="btn small primary" data-cmedia="${key}" data-kind="${kind}">${icon('upload')}${url ? 'Заменить' : 'Выбрать файл'}</button>
          ${url ? `<button class="btn small" data-cclear="${key}">${icon('trash')}Убрать</button>` : ''}</div></div></div></div>`;
    };

    view.innerHTML = `<h1 class="page-title">Настройки</h1>
      <div class="settings">
        <div class="set-card glass">
          <div class="account">
            <div class="ava" data-cmedia="avatar" data-kind="image" title="Сменить аватар">${av ? `<img src="${esc(av)}" alt="">` : esc(name[0] || 'Z')}</div>
            <div style="min-width:0">
              <input class="input name-input" id="nameInput" maxlength="40" placeholder="${esc(p.name || 'Ваше имя')}" value="${esc(App.settings.profileLocal.name || '')}" />
              <div class="muted small" style="margin-top:6px">Zvuk ID ${esc(p.id || '—')}</div><div id="subInfo"></div>
            </div>
            <div style="margin-left:auto;display:flex;flex-direction:column;gap:8px;align-items:flex-end">
              ${Custom.media.avatar ? `<button class="btn small" data-cclear="avatar">${icon('trash')}Убрать фото</button>` : ''}
              <button class="btn small" data-act="logout">${icon('logout')}Выйти</button>
            </div>
          </div>
          <div class="muted small" style="margin-top:12px">Имя и аватар хранятся только в приложении и не меняют ваш профиль в Zvuk.</div>
        </div>

        <div class="set-title">Звук</div>
        <div class="set-card glass">
          ${row('Качество', 'Выбирается лучшее доступное, не выше указанного. Также можно переключить, нажав на значок FLAC в плеере.', `<div class="seg">
            <button class="${q === 'flac' ? 'on' : ''}" data-act="quality" data-q="flac">FLAC</button>
            <button class="${q === 'high' ? 'on' : ''}" data-act="quality" data-q="high">320 кбит/с</button>
            <button class="${q === 'mid' ? 'on' : ''}" data-act="quality" data-q="mid">128 кбит/с</button></div>`)}
          ${row('Эквалайзер', AudioFX.eq.enabled ? `Включён · ${esc(AudioFX.presetName())}` : 'Выключен', `<button class="btn small" data-act="nav" data-view="equalizer">${icon('eq')}Открыть</button>`)}
          ${row('Визуализатор', 'Мягкая анимация под ритм, фон — обложка, своя картинка, видео или официальный клип. Есть и в полноэкранном плеере.', `<button class="btn small" data-act="nav" data-view="visualizer">${icon('viz')}Открыть</button>`)}
          ${row('Тексты из LRCLIB', 'Если в Zvuk у песни нет текста или он без привязки ко времени, приложение найдёт синхронизированный текст в открытой базе LRCLIB. Туда уходят только исполнитель, название и длительность трека.', `<button class="switch${App.settings.lyrics?.external !== false ? ' on' : ''}" data-act="lyrics-ext"></button>`)}
        </div>

        <div class="set-title">Клипы с YouTube</div>
        <div class="set-card glass" id="ytCard"><div class="muted small">Загрузка…</div></div>
        ${window.ZG_MOBILE ? '' : `<div class="set-card glass" id="clipPrefs">
          <h3>Синхронизация и читаемость</h3>
          ${row('В начало после синхронизации', 'После удачного замера запускать трек сначала. Выключите, чтобы сохранять текущую позицию.', `<button class="switch${Clip.pref('clipRestart') ? ' on' : ''}" data-vpref="clipRestart" aria-label="В начало после синхронизации" aria-pressed="${Clip.pref('clipRestart')}"></button>`)}
          ${row('Оставлять клип на экране при паузе', 'Останавливать видео вместе с треком и сохранять текущий кадр на экране. Выключено — прежний режим: клип скрывается на паузе.', `<button class="switch${Clip.pref('clipKeepPaused') ? ' on' : ''}" data-vpref="clipKeepPaused" aria-label="Оставлять клип на экране при паузе" aria-pressed="${Clip.pref('clipKeepPaused')}"></button>`)}
          ${row('Контрастный контур текста', 'Цельный цвет букв и аккуратная обводка подстраиваются под фон только при потере читаемости. Сглаживание защищает от мерцания на быстрых кадрах.', `<button class="switch${Clip.pref('inkEnabled') ? ' on' : ''}" data-vpref="inkEnabled" aria-label="Контрастный контур текста" aria-pressed="${Clip.pref('inkEnabled')}"></button>`)}
        </div>`}

        <div class="set-title">Производительность</div>
        <div class="set-card glass">
          ${row('Качество и нагрузка', `<span id="perfModeNote">${performanceNotes[performanceMode]}</span>`, `<div class="seg perf-modes" id="perfModes" role="group" aria-label="Режим производительности">${[['auto', 'Авто'], ['full', 'Полный'], ['eco', 'Экономия']].map(([id, label]) => `<button class="${performanceMode === id ? 'on' : ''}" data-act="performance-mode" data-mode="${id}" aria-pressed="${performanceMode === id}">${label}</button>`).join('')}</div>`)}
        </div>

        <div class="set-title">Стиль интерфейса</div>
        <div class="set-card glass">
          <div class="design-tiles">
            <button class="design-tile${s.design === 'orbit' ? ' on' : ''}" data-cseg="design" data-val="orbit">
              <div class="pv orbit"><i></i><i></i><i></i></div><b>Орбитальная</b><span>Матовая музыкальная среда, мягкий свет и Нова рядом</span></button>
            <button class="design-tile${s.design === 'glass' ? ' on' : ''}" data-cseg="design" data-val="glass">
              <div class="pv glassy"><i></i><i></i><i></i></div><b>Жидкое стекло</b><span>Полупрозрачные панели, размытие и блики</span></button>
            <button class="design-tile${s.design === 'classic' ? ' on' : ''}" data-cseg="design" data-val="classic">
              <div class="pv flat"><i></i><i></i><i></i></div><b>Обычный</b><span>Плотные тёмные панели, как в Spotify. Работает быстрее.</span></button>
          </div>
        </div>

        <div class="set-title">Полоса времени</div>
        <div class="set-card glass">
          <div class="seek-tiles">${[['line', 'Линия'], ['glow', 'Сияние'], ['wave', 'Волна'], ['liquid', 'Жидкость']]
            .map(([id, label]) => `<button class="seek-tile${s.seekStyle === id ? ' on' : ''}" data-seekstyle="${id}">
              <div class="slider seek demo ${Custom.seekClasses(id, s.seekColor === 'white' ? 'accent' : s.seekColor, 'always')}"><div class="buf" style="width:80%"></div><div class="fill" style="width:62%"></div><div class="thumb" style="left:62%"></div></div>
              <b>${label}</b></button>`).join('')}</div>
          ${row('Цвет', '', seg('seekColor', [['white', 'Белый'], ['accent', 'Цвет темы'], ['rainbow', 'Радуга']], s.seekColor))}
          ${row('Толщина', '', range('seekHeight', 3, 10, 1, 'px'))}
          ${row('Ползунок', '', seg('seekThumb', [['hover', 'При наведении'], ['always', 'Всегда'], ['never', 'Скрыт']], s.seekThumb))}
          ${row('Пульс в такт музыке', 'Полоса вспыхивает на сильных долях', sw('seekBeat', s.seekBeat))}
          <div class="seek-preview"><div class="slider seek demo ${Custom.seekClasses()}" id="seekPreview"><div class="buf" style="width:78%"></div><div class="fill" style="width:46%"></div><div class="thumb" style="left:46%"></div></div></div>
        </div>

        <div class="set-title">Цвета и шрифт</div>
        <div class="set-card glass">
          ${row('Цвет акцента', s.accentMode === 'auto' ? 'Подбирается по обложке текущего трека' : 'Ваш цвет для всего интерфейса', seg('accentMode', [['auto', 'Из обложки'], ['fixed', 'Свой']], s.accentMode))}
          ${s.accentMode === 'fixed' ? `<div class="row"><div class="swatches">${Custom.SWATCHES.map((c) => `<button class="swatch${s.accent.toLowerCase() === c ? ' on' : ''}" style="background:${c}" data-swatch="${c}"></button>`).join('')}
            <input type="color" class="color-input" id="accentPicker" value="${esc(s.accent)}" title="Любой цвет"></div></div>` : ''}
          ${row('Шрифт', '', seg('font', Object.entries(Custom.FONTS).map(([id, f]) => [id, f.name]), s.font))}
        </div>

        <div class="set-title">Обои</div>
        <div class="set-card glass">
          ${row('Фон приложения', '', seg('bgMode', [['cover', 'Обложка трека'], ['image', 'Картинка'], ['video', 'Видео'], ['gradient', 'Градиент']], s.bgMode))}
          ${s.bgMode === 'image' ? mediaBlock('wallImage', 'image') : ''}
          ${s.bgMode === 'video' ? mediaBlock('wallVideo', 'video') : ''}
          ${s.bgMode === 'gradient' ? `<div class="row"><div class="grad-tiles">${Object.entries(Custom.GRADIENTS).map(([id, g]) => `<button class="grad-tile${s.gradient === id ? ' on' : ''}" data-grad="${id}" style="background:linear-gradient(135deg, ${g.colors.join(', ')})">${g.name}</button>`).join('')}</div></div>` : ''}
          ${s.bgMode === 'image' || s.bgMode === 'video' ? row('Размытие обоев', '', range('bgBlur', 0, 60, 1, 'px')) : ''}
          ${row('Затемнение фона', 'Делает текст читаемее на ярких обоях', range('bgDim', 0, 80, 1, '%'))}
          ${row('Цветные пятна', 'Мягко плывущие цветные блики поверх фона', sw('blobs', s.blobs))}
        </div>

        <div class="set-title">Стекло и форма</div>
        <div class="set-card glass">
          ${row('Плотность стекла', 'Насколько матовыми выглядят панели', range('glass', 0.3, 2.2, 0.05, 'x'))}
          ${row('Размытие стекла', '', range('glassBlur', 0, 60, 1, 'px'))}
          ${row('Скругление углов', '', range('radius', 4, 40, 1, 'px'))}
          ${row('Масштаб интерфейса', '', range('scale', 0.8, 1.25, 0.05, 'x'))}
          ${row('Эффект преломления «жидкого стекла»', 'Искажает фон за плеером. Отключите, если интерфейс подтормаживает.', `<button class="switch${App.settings.liquidGlass ? ' on' : ''}" data-act="toggle-liquid"></button>`)}
        </div>

        <div class="set-title">Интерфейс</div>
        <div class="set-card glass">
          ${row('Компактная боковая панель', 'Только иконки — больше места для музыки', sw('compact', s.compact))}
          ${row('Мини-визуализатор в плеере', 'Полоски спектра на фоне нижней панели', sw('miniViz', s.miniViz))}
          ${row('Меньше анимаций', 'Отключает движение фона и переходы', sw('reduceMotion', s.reduceMotion))}
          <div class="row"><div class="lbl">Вернуть всё оформление как было</div><button class="btn small" id="resetLook">${icon('refresh')}Сбросить</button></div>
        </div>

        <div class="set-title">Справка</div>
        <div class="set-card glass">
          <h3>Горячие клавиши</h3>
          <div class="kbd-list">
            <kbd>Пробел</kbd><span>Играть / пауза</span>
            <kbd>Ctrl + → / ←</kbd><span>Следующий / предыдущий трек</span>
            <kbd>Shift + → / ←</kbd><span>Перемотка на 10 секунд</span>
            <kbd>Ctrl + ↑ / ↓</kbd><span>Громкость</span>
            <kbd>M</kbd><span>Без звука</span>
            <kbd>Ctrl + L</kbd><span>Нравится</span>
            <kbd>Ctrl + K</kbd><span>Поиск</span>
            <kbd>Alt + ← / →</kbd><span>Назад / вперёд</span>
            <kbd>F</kbd><span>Визуализатор во весь экран</span>
            <kbd>Медиаклавиши</kbd><span>Работают и при свёрнутом окне</span>
          </div>
        </div>
        <div class="set-card glass" id="aboutCard">
          <h3>О программе</h3>
          <div class="row"><div class="lbl">Zvuk Glass <span class="ver-pill" id="appVer"></span><div class="s" id="updLine">&nbsp;</div></div><div class="ctrl" id="updCtrl"></div></div>
          <div class="muted small" style="margin-top:4px">Неофициальный клиент. Использует внутренний API zvuk.com, поэтому после обновлений сервиса что-то может перестать работать. Новые версии приходят сами через GitHub.</div>
        </div>
      </div>`;

    // Настройки — рабочая панель, а не узкая лента: группируем разделы один раз,
    // сохраняя исходную разметку контролов и единый набор обработчиков ниже.
    const settingsRoot = view.querySelector('.settings');
    settingsRoot.querySelector(':scope > .set-card')?.classList.add('settings-account');
    const sectionIds = ['sound', 'clips', 'design', 'seek', 'color', 'wallpaper', 'glass', 'interface', 'help'];
    for (const title of [...settingsRoot.querySelectorAll(':scope > .set-title')]) {
      const group = document.createElement('section');
      group.className = 'settings-group';
      group.dataset.group = sectionIds.shift() || 'other';
      title.before(group);
      group.append(title);
      while (group.nextElementSibling?.classList.contains('set-card')) group.append(group.nextElementSibling);
    }

    view.querySelectorAll('.range').forEach(updateRangeFill);
    api('getSubscription')
      .then((sub) => {
        const el = view.querySelector('#subInfo');
        if (!el) return;
        const active = sub && /active|trial/i.test(sub.status || '');
        el.innerHTML = sub
          ? `<span class="sub-pill${active ? '' : ' off'}">${icon('check')}${esc(sub.name || 'Подписка')}${sub.expirationDate ? ' · до ' + new Date(sub.expirationDate).toLocaleDateString('ru-RU') : ''}</span>`
          : `<span class="sub-pill off">Подписка не найдена</span>`;
      })
      .catch(() => {});

    const rerender = () => App.rerender();
    view.addEventListener('input', (e) => {
      const r = e.target.closest('[data-cset]');
      if (r) {
        updateRangeFill(r);
        Custom.set({ [r.dataset.cset]: parseFloat(r.value) });
      }
      if (e.target.id === 'accentPicker') {
        Custom.set({ accent: e.target.value, accentMode: 'fixed' });
        view.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
      }
    });
    // ---------- Клипы с YouTube: ключ API ----------
    const ytCard = view.querySelector('#ytCard');
    const renderYt = async () => {
      const st = await window.zvuk.yt.state();
      if (!ytCard.isConnected) return;
      ytCard.innerHTML = `<h3>Официальные клипы на фоне визуализатора</h3>
        <div class="muted small" style="margin-top:4px">В визуализаторе выберите фон «Клип» — приложение найдёт официальный клип трека на YouTube и покажет его без звука, в такт музыке.</div>
        ${st.hasKey
          ? `<div class="row"><div class="lbl">Ключ YouTube сохранён<div class="s">Хранится зашифрованным только на этом компьютере. Запомнено клипов: ${st.cached}</div></div>
              <div class="ctrl"><button class="btn small" data-yt="cache">Забыть найденные</button><button class="btn small" data-yt="clear">${icon('trash')}Удалить ключ</button></div></div>`
          : `<ol class="steps yt-steps">
              <li><span class="num">1</span><div class="st"><b>Включите YouTube Data API v3</b><span>в своём проекте Google Cloud (бесплатно)</span></div><button class="btn small" data-yt="open" data-url="https://console.cloud.google.com/apis/library/youtube.googleapis.com">Открыть</button></li>
              <li><span class="num">2</span><div class="st"><b>Создайте ключ API</b><span>«Учётные данные» → «Создать» → «Ключ API»</span></div><button class="btn small" data-yt="open" data-url="https://console.cloud.google.com/apis/credentials">Открыть</button></li>
              <li><span class="num">3</span><div class="st"><b>Вставьте ключ ниже</b><span>хватает примерно на 100 новых поисков в день, найденное запоминается</span></div></li>
            </ol>
            <form class="token-form" id="ytForm" style="margin-top:12px"><input class="input" id="ytKey" type="password" placeholder="Ключ YouTube Data API" autocomplete="off" spellcheck="false"><button class="btn primary" type="submit">Сохранить</button></form>
            <div class="muted small" style="margin-top:8px">Без ключа клип тоже можно показать: в визуализаторе нажмите «Ссылка» и вставьте адрес ролика.</div>`}`;
      const form = ytCard.querySelector('#ytForm');
      if (form)
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const r = await window.zvuk.yt.setKey(ytCard.querySelector('#ytKey').value);
          if (r.ok) {
            toast('Ключ YouTube сохранён', { iconName: 'check' });
            renderYt();
          } else toast(r.error.message, { error: true, ms: 5000 });
        });
    };
    ytCard.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-yt]');
      if (!b) return;
      if (b.dataset.yt === 'open') window.zvuk.openZvuk(b.dataset.url);
      if (b.dataset.yt === 'cache') {
        await window.zvuk.yt.clearCache();
        toast('Найденные клипы забыты — поиск будет заново', { iconName: 'refresh' });
      }
      if (b.dataset.yt === 'clear') {
        if (!(await modal({ title: 'Удалить ключ YouTube?', text: 'Автопоиск клипов отключится. Уже найденные клипы останутся.', okText: 'Удалить', danger: true }))) return;
        await window.zvuk.yt.clearKey();
      }
      renderYt();
    });
    renderYt();
    const clipPrefs = view.querySelector('#clipPrefs');
    if (clipPrefs) {
      const syncPrefs = () => clipPrefs.querySelectorAll('[data-vpref]').forEach((b) => {
        const on = Clip.pref(b.dataset.vpref);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      clipPrefs.addEventListener('click', (e) => {
        const b = e.target.closest('[data-vpref]');
        if (!b) return;
        Clip.setPreference(b.dataset.vpref, !Clip.pref(b.dataset.vpref));
        syncPrefs();
      });
      const offPrefs = Clip.onChange(() => view.isConnected ? syncPrefs() : offPrefs());
    }

    // ---------- О программе и обновления ----------
    const renderAbout = async () => {
      const card = view.querySelector('#aboutCard');
      if (!card || !card.isConnected) return document.removeEventListener('zg:update', renderAbout);
      let st = App.update;
      if (!st.current) st = App.update = { ...(await window.zvuk.update.state()), ...(st.state !== 'idle' ? st : {}) };
      const btn = (act, label, ic, primary) => `<button class="btn small${primary ? ' primary' : ''}" data-updact="${act}">${icon(ic)}${label}</button>`;
      let line = '';
      let ctrl = '';
      if (st.portable) line = 'Переносная тестовая копия — обновления и установка отключены';
      else if (st.packaged === false) line = 'Версия для разработки — обновления работают в установленном приложении';
      else if (st.state === 'checking') (line = 'Проверяем обновления…'), (ctrl = `<button class="btn small" disabled>${icon('refresh')}Проверка…</button>`);
      else if (st.state === 'downloading') line = `Скачивается версия ${esc(st.version || '')}${st.percent ? ` — ${st.percent}%` : '…'}`;
      else if (st.state === 'ready')
        (line = window.ZG_MOBILE ? `Версия ${esc(st.version)} скачана — установку подтвердит Android` : `Версия ${esc(st.version)} скачана и установится при выходе`),
          (ctrl = btn('install', window.ZG_MOBILE ? 'Установить' : 'Перезапустить и обновить', 'refresh', true));
      else if (st.state === 'error') (line = `Не удалось проверить: ${esc(st.message || '')}`), (ctrl = btn('check', 'Повторить', 'refresh'));
      else (line = st.state === 'none' ? 'Установлена последняя версия' : 'Обновления проверяются автоматически'), (ctrl = btn('check', 'Проверить обновления', 'refresh'));
      card.querySelector('#appVer').textContent = st.current ? 'v' + st.current : '';
      card.querySelector('#updLine').innerHTML = line;
      // плашка с изменениями текущей версии — открыть ещё раз
      card.querySelector('#updCtrl').innerHTML = btn('news', 'Что нового', 'sparkle') + ctrl;
    };
    document.addEventListener('zg:update', renderAbout);
    view.querySelector('#aboutCard').addEventListener('click', (e) => {
      const b = e.target.closest('[data-updact]');
      if (!b) return;
      if (b.dataset.updact === 'install') App.installUpdate();
      else if (b.dataset.updact === 'news') App.whatsNew(true);
      else App.checkUpdates();
    });
    renderAbout();

    view.querySelector('#nameInput').addEventListener('change', (e) => {
      App.settings.profileLocal.name = e.target.value.trim() || null;
      window.zvuk.settings.set({ profileLocal: App.settings.profileLocal });
      App.renderProfileChip();
      toast('Имя сохранено', { iconName: 'check', ms: 1400 });
    });
    view.querySelector('#resetLook').addEventListener('click', async () => {
      const ok = await modal({ title: 'Сбросить оформление?', text: 'Цвета, фон, стекло, скругления и масштаб вернутся к исходным. Свои файлы останутся.', okText: 'Сбросить' });
      if (!ok) return;
      Custom.reset();
      rerender();
    });
    view.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-cseg], [data-cswitch], [data-swatch], [data-grad], [data-cmedia], [data-cclear], [data-seekstyle]');
      if (!t) return;
      const d = t.dataset;
      const preview = view.querySelector('#seekPreview');
      if (d.seekstyle) {
        Custom.set({ seekStyle: d.seekstyle });
        view.querySelectorAll('.seek-tile').forEach((x) => x.classList.toggle('on', x === t));
        Custom.styleSeek([preview]);
      } else if (d.cseg) {
        Custom.set({ [d.cseg]: d.val });
        if (['accentMode', 'bgMode', 'seekColor'].includes(d.cseg)) rerender();
        else t.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === t));
        if (d.cseg === 'seekThumb') Custom.styleSeek([preview]);
        if (d.cseg === 'design') setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
      } else if (d.cswitch) {
        const v = !Custom.s[d.cswitch];
        Custom.set({ [d.cswitch]: v });
        t.classList.toggle('on', v);
      } else if (d.swatch) {
        Custom.set({ accent: d.swatch, accentMode: 'fixed' });
        view.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === t));
        const pk = view.querySelector('#accentPicker');
        if (pk) pk.value = d.swatch;
      } else if (d.grad) {
        Custom.set({ gradient: d.grad, bgMode: 'gradient' });
        view.querySelectorAll('.grad-tile').forEach((x) => x.classList.toggle('on', x === t));
      } else if (d.cmedia) {
        const url = await Custom.pickMedia(d.cmedia, d.kind);
        if (!url) return;
        if (d.cmedia === 'avatar') App.renderProfileChip();
        else Custom.apply();
        rerender();
      } else if (d.cclear) {
        await Custom.clearMedia(d.cclear);
        if (d.cclear === 'avatar') App.renderProfileChip();
        else Custom.apply();
        rerender();
      }
    });
  };

  window.Views = Views;
  window.UI = { trackRow, trackList, registerList, Lists, card, shelf, waveOptions, waveSummary, waveHero, MOODS, LANGS, POPS, GENRES, entityCard, playlistCard, virtualize, warmImages };
})();
