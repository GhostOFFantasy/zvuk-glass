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
      <div class="n" data-act="play-row"><span class="num">${o.num ? o.num(t, i) : i + 1}</span><span class="pi">${ICONS.play}</span><span class="eqs"><i></i><i></i><i></i></span></div>
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
    const head = o.head === false ? '' : `<div class="tracks-head${o.album === false ? ' no-album' : ''}" style="${o.album === false ? 'grid-template-columns:36px minmax(0,1fr) 40px 56px 40px' : ''}"><span style="text-align:center">#</span><span>Название</span>${o.album === false ? '' : '<span class="al">Альбом</span>'}<span></span><span style="text-align:right">${ICONS.clock ? icon('clock') : ''}</span><span></span></div>`;
    return { listId, html: `${head}<div class="tracks${o.compact ? ' compact' : ''}" data-list-root="${listId}">${tracks.map((t, i) => trackRow(t, i, listId, o)).join('')}</div>` };
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
    { id: 'any', label: 'Любой', icon: 'infinity' },
    { id: 'russian', label: 'Русский', icon: 'mic' },
    { id: 'foreign', label: 'Зарубежный', icon: 'globe' },
    { id: 'instrumental', label: 'Без слов', icon: 'note' },
  ];
  const POPS = [
    { id: 'any', label: 'Любимое', icon: 'heart' },
    { id: 'popular', label: 'Популярное', icon: 'fire' },
    { id: 'rare', label: 'Незнакомое', icon: 'compass' },
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
    return parts.length ? 'Настроено: ' + parts.join(' · ') : 'Бесконечный поток треков, подобранных под ваш вкус';
  }

  const wavePlaying = () => Player.source?.kind === 'wave' && Player.playing;
  const orbHtml = () =>
    `<button class="wave-orb${wavePlaying() ? ' playing' : ''}" data-act="wave-toggle" id="waveOrb" title="Моя волна"><div class="core"></div><div class="shell"></div>${icon(wavePlaying() ? 'pause' : 'play')}</button>`;

  /** Кольцо-визуализатор вокруг кнопки: живёт под музыку, только когда играет волна. */
  function attachRing(canvas, inner) {
    if (!canvas) return;
    Viz.attach(canvas, {
      style: 'orbit',
      inner,
      idle: true,
      sensitivity: 1.15,
      liveIf: () => Player.source?.kind === 'wave',
      fps: 40,
      maxDpr: 1.5,
      onFrame: (V) => {
        const hero = canvas.closest('.wv-hero');
        if (hero) hero.style.setProperty('--beat', (wavePlaying() ? V.bass * 0.6 + V.beat * 0.6 : 0).toFixed(3));
      },
    });
  }

  function waveHero() {
    const w = App.settings.wave || {};
    return `<div class="wave-hero glass panel liquid">
      <div class="orb-wrap"><canvas id="homeRing"></canvas>${orbHtml()}</div>
      <div class="wave-text">
        <h2>Моя волна</h2>
        <p id="waveSummary">${esc(waveSummary())}</p>
        <div class="chips">${MOODS.map((m) => `<button class="chip${(w.mood || 'any') === m.id ? ' on' : ''}" data-act="wave-set" data-key="mood" data-val="${m.id}">${m.label}</button>`).join('')}
          <button class="chip" data-act="nav" data-view="wave">${icon('settings')}Настроить</button></div>
      </div>
    </div>`;
  }

  function waveNowHtml() {
    const t = Player.current;
    if (Player.source?.kind === 'wave' && t) {
      const liked = App.likes.track.has(String(t.id));
      return `<div class="wv-now"><img src="${esc(cover(t, 96))}" alt="">
        <div class="nt"><div><b>${esc(t.title)}</b></div><div class="a">${esc(artistsText(t.artists))}</div></div>
        <button class="icon-btn like-btn${liked ? ' liked' : ''}" data-act="like" data-type="track" data-id="${esc(t.id)}" title="Нравится">${icon(liked ? 'heartFill' : 'heart')}</button>
        <button class="icon-btn" data-act="next" title="Дальше">${icon('next')}</button></div>`;
    }
    return `<div class="wv-hint">${icon('sparkle')}Нажмите на кнопку — поток подстроится под ваш вкус и настроение</div>`;
  }

  const Views = {};

  Views.home = async (view) => {
    const nm = App.settings.profileLocal?.name || App.profile?.name;
    view.innerHTML = `<h1 class="greet">${greeting()}${nm ? ', ' + esc(nm) : ''}</h1>
      ${waveHero()}
      <div id="h-synth"></div>
      <div id="h-recent">${skeletonShelf('Недавнее')}</div>
      <div id="h-rec">${skeletonShelf('Рекомендуем')}</div>
      <div id="h-art"></div>
      <div id="h-waves">${skeletonShelf('Волны')}</div>
      <div id="h-hist"></div>`;
    attachRing(view.querySelector('#homeRing'), 88);
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
    const src = { kind: 'list', title: 'Топ 100' };
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
        <div class="top-info"><div class="kind">${icon('fire')}Чарт Звука</div><h2>${esc(d.top.title || 'Топ 100')}</h2>
          <p>Самые прослушиваемые треки дня${updText ? ` · ${updText}` : ''}</p>
          <div class="top-btns"><button class="btn primary" data-act="play-list-all" data-list="${tl.listId}">${icon('play')}Слушать чарт</button>
            <button class="btn" data-act="shuffle-list" data-list="${tl.listId}">${icon('shuffle')}Вперемешку</button>
            <button class="btn" data-act="open" data-kind="playlist" data-id="${esc(d.top.id)}">${icon('playlist')}Плейлист</button></div></div>
        <div class="top-podium">${podium}</div>
      </div>
      <section class="section pop-sec"><div class="section-head"><h2>Топ 100</h2><span class="pop-count">${tracksWord(top.length)}</span></div>
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
    const open = box.classList.toggle('collapsed');
    btn.textContent = open ? `Показать все ${box.querySelectorAll('.tr').length}` : 'Свернуть';
    if (open) box.closest('.section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // ---------- Моя волна ----------
  Views.wave = async (view) => {
    const w = App.settings.wave || {};
    const pills = (key, list, cur) =>
      `<div class="opt-pills">${list.map((o) => `<button class="opt-pill${(cur || 'any') === o.id ? ' on' : ''}" data-act="wave-set" data-key="${key}" data-val="${o.id}">${icon(o.icon)}${o.label}</button>`).join('')}</div>`;
    view.innerHTML = `
      <section class="wv-hero glass panel">
        <div class="wv-aurora"><i></i><i></i><i></i></div>
        <div class="wv-orb"><canvas class="wv-ring" id="waveRing"></canvas>${orbHtml()}</div>
        <div class="wv-text">
          <div class="wv-kicker">${icon('wave')}Персональный поток</div>
          <h1 class="wv-title">Моя волна</h1>
          <p class="wv-sub" id="waveSummary">${esc(waveSummary())}</p>
          <div id="wvNowSlot">${waveNowHtml()}</div>
        </div>
      </section>
      <section class="wv-grid">
        <div class="wv-card glass wide"><h3>Настроение</h3>
          <div class="mood-tiles">${MOODS.map((m) => `<button class="mood${(w.mood || 'any') === m.id ? ' on' : ''}" style="--m1:${m.c[0]};--m2:${m.c[1]}" data-act="wave-set" data-key="mood" data-val="${m.id}">${icon(m.icon)}<b>${m.label}</b></button>`).join('')}</div>
        </div>
        <div class="wv-card glass"><h3>Язык</h3>${pills('lang', LANGS, w.lang)}</div>
        <div class="wv-card glass"><h3>Характер</h3>${pills('pop', POPS, w.pop)}</div>
        <div class="wv-card glass wide"><h3>Жанры
            <button class="more${(w.genres || []).length ? '' : ' hidden'}" data-act="wave-genre" data-val="__clear" id="genreClear" style="text-transform:none;letter-spacing:0;color:var(--text-2);font-weight:600">Сбросить</button></h3>
          <div class="chips">${GENRES.map(([id, label]) => `<button class="chip${(w.genres || []).includes(id) ? ' on' : ''}" data-act="wave-genre" data-val="${id}">${label}</button>`).join('')}</div>
        </div>
      </section>
      <div id="waveNow"></div>
      <div id="waveEditorial">${skeletonShelf('Волны по жанрам и настроениям')}</div>`;
    attachRing(view.querySelector('#waveRing'), 90);
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
    el.innerHTML = `<section class="section"><div class="section-head"><h2>Сейчас в потоке · ${esc(Player.source.title || '')}</h2></div>
      <div class="tracks">${upcoming.map((t, i) => trackRow(t, i, listId, { num: () => (i === 0 ? '▶' : i) })).join('')}</div></section>`;
    el.querySelectorAll('.tr').forEach((row, i) => (row.dataset.queueIdx = Player.index + i));
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
      const from = list.children.length;
      const to = Math.min(st.tracks.length, from + POP_STEP);
      list.insertAdjacentHTML('beforeend', st.tracks.slice(from, to).map((t, i) => trackRow(t, from + i, st.listId, { album: true })).join(''));
      st.shown = to;
    } else if (st.loading) await st.loading;
    const left = st.tracks.length - list.children.length;
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
    view.innerHTML = `<div class="hero" style="--hero:var(--accent-2)">
        <div class="hero-cover"><div class="tile-art" style="--t1:var(--accent);--t2:var(--accent-2)">${icon('heartFill')}</div></div>
        <div class="hero-info"><div class="kind">Коллекция</div><h1>Любимые треки</h1><div class="meta" id="likedMeta">Загрузка…</div></div>
      </div>
      <div class="actions">
        <button class="play-orb accent xl" data-act="play-list-all" id="likedPlay">${icon('play')}</button>
        <button class="icon-btn" data-act="shuffle-list" id="likedShuffle" title="Перемешать">${icon('shuffle')}</button>
        <input class="input" id="likedFilter" placeholder="Найти в любимых" style="max-width:280px;height:40px;border-radius:999px;margin-left:auto" />
      </div>
      <div id="likedList">${Array.from({ length: 10 }, () => '<div class="skel" style="height:50px;margin:6px 0;border-radius:14px"></div>').join('')}</div>`;
    let ids;
    try {
      ids = await api('getLikedTrackIds');
    } catch (e) {
      view.querySelector('#likedList').innerHTML = errorBox(e);
      return;
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
    for (let i = 0; i < ids.length; i += 150) {
      const part = await api('getTracks', ids.slice(i, i + 150));
      if (!root.isConnected) return;
      const start = tracks.length;
      tracks.push(...part);
      root.insertAdjacentHTML('beforeend', part.map((t, k) => trackRow(t, start + k, listId)).join(''));
    }
    const filter = view.querySelector('#likedFilter');
    filter.addEventListener('input', debounce(() => {
      const f = filter.value.trim().toLowerCase();
      root.querySelectorAll('.tr').forEach((row) => {
        const t = tracks[+row.dataset.idx];
        const hay = (t.title + ' ' + artistsText(t.artists) + ' ' + (t.release?.title || '')).toLowerCase();
        row.style.display = !f || hay.includes(f) ? '' : 'none';
      });
    }, 150));
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
  const eqPresetChips = () =>
    Object.entries(AudioFX.PRESETS).map(([id, p]) => `<button class="chip${AudioFX.eq.preset === id ? ' on' : ''}" data-eqp="${id}">${p.name}</button>`).join('') +
    (AudioFX.eq.preset === 'custom' ? '<button class="chip on">Свой</button>' : '');
  Views.eq = { slider: eqSlider, paint: paintEqSliders, bind: bindEqSliders, presets: eqPresetChips };

  Views.equalizer = async (view) => {
    const eq = AudioFX.eq;
    const slider = eqSlider;
    view.innerHTML = `<div class="eq-head"><h1 class="page-title">Эквалайзер</h1>
        <div class="ctrl">${AudioFX.ready ? '' : '<span class="muted small">Web Audio недоступен</span>'}<span>Включён</span><button class="switch${eq.enabled ? ' on' : ''}" id="eqSwitch"></button></div></div>
      <div class="eq-panel glass${eq.enabled ? '' : ' off'}" id="eqPanel">
        <div class="eq-grid">
          ${slider('pre', 'Уровень')}
          <div class="eq-sep"></div>
          <div class="eq-bands"><canvas class="eq-canvas" id="eqCanvas"></canvas>${AudioFX.FREQS.map((f, i) => slider(i, AudioFX.LABELS[i])).join('')}</div>
        </div>
      </div>
      <div class="eq-presets" id="eqPresets"></div>
      <div class="eq-options">
        <div class="opt"><button class="switch${eq.compressor ? ' on' : ''}" id="eqComp"></button>Компрессор — выравнивает громкость тихих и громких мест</div>
        <button class="btn" id="eqReset">${icon('refresh')}Сбросить</button>
      </div>
      <p class="eq-note">Тяните ползунки вверх и вниз · двойной щелчок возвращает 0 дБ · колёсико мыши — точная подстройка. Настройки применяются ко всей музыке сразу.</p>`;

    const panel = view.querySelector('#eqPanel');
    const sync = () => {
      const e = AudioFX.eq;
      panel.classList.toggle('off', !e.enabled);
      view.querySelector('#eqSwitch').classList.toggle('on', e.enabled);
      view.querySelector('#eqComp').classList.toggle('on', e.compressor);
      paintEqSliders(view);
      view.querySelector('#eqPresets').innerHTML = eqPresetChips();
    };
    // изменения из мини-эквалайзера в полноэкранном плеере
    const onExternal = () => (view.contains(panel) ? sync() : window.removeEventListener('zg:eq', onExternal));
    window.addEventListener('zg:eq', onExternal);
    bindEqSliders(view, sync);
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
    view.querySelector('#eqPresets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-eqp]');
      if (!b) return;
      AudioFX.setPreset(b.dataset.eqp);
      if (!AudioFX.eq.enabled) AudioFX.setEnabled(true);
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
          ${row('Эквалайзер', AudioFX.eq.enabled ? `Включён · ${esc(AudioFX.PRESETS[AudioFX.eq.preset]?.name || 'свой')}` : 'Выключен', `<button class="btn small" data-act="nav" data-view="equalizer">${icon('eq')}Открыть</button>`)}
          ${row('Визуализатор', 'Мягкая анимация под ритм, фон — обложка, своя картинка, видео или официальный клип. Есть и в полноэкранном плеере.', `<button class="btn small" data-act="nav" data-view="visualizer">${icon('viz')}Открыть</button>`)}
          ${row('Тексты из LRCLIB', 'Если в Zvuk у песни нет текста или он без привязки ко времени, приложение найдёт синхронизированный текст в открытой базе LRCLIB. Туда уходят только исполнитель, название и длительность трека.', `<button class="switch${App.settings.lyrics?.external !== false ? ' on' : ''}" data-act="lyrics-ext"></button>`)}
        </div>

        <div class="set-title">Клипы с YouTube</div>
        <div class="set-card glass" id="ytCard"><div class="muted small">Загрузка…</div></div>

        <div class="set-title">Стиль интерфейса</div>
        <div class="set-card glass">
          <div class="design-tiles">
            <button class="design-tile${s.design !== 'classic' ? ' on' : ''}" data-cseg="design" data-val="glass">
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

    // ---------- О программе и обновления ----------
    const renderAbout = async () => {
      const card = view.querySelector('#aboutCard');
      if (!card || !card.isConnected) return document.removeEventListener('zg:update', renderAbout);
      let st = App.update;
      if (!st.current) st = App.update = { ...(await window.zvuk.update.state()), ...(st.state !== 'idle' ? st : {}) };
      const btn = (act, label, ic, primary) => `<button class="btn small${primary ? ' primary' : ''}" data-updact="${act}">${icon(ic)}${label}</button>`;
      let line = '';
      let ctrl = '';
      if (st.packaged === false) line = 'Версия для разработки — обновления работают в установленном приложении';
      else if (st.state === 'checking') (line = 'Проверяем обновления…'), (ctrl = `<button class="btn small" disabled>${icon('refresh')}Проверка…</button>`);
      else if (st.state === 'downloading') line = `Скачивается версия ${esc(st.version || '')}${st.percent ? ` — ${st.percent}%` : '…'}`;
      else if (st.state === 'ready') (line = `Версия ${esc(st.version)} скачана и установится при выходе`), (ctrl = btn('install', 'Перезапустить и обновить', 'refresh', true));
      else if (st.state === 'error') (line = `Не удалось проверить: ${esc(st.message || '')}`), (ctrl = btn('check', 'Повторить', 'refresh'));
      else (line = st.state === 'none' ? 'Установлена последняя версия' : 'Обновления проверяются автоматически'), (ctrl = btn('check', 'Проверить обновления', 'refresh'));
      card.querySelector('#appVer').textContent = st.current ? 'v' + st.current : '';
      card.querySelector('#updLine').innerHTML = line;
      card.querySelector('#updCtrl').innerHTML = ctrl;
    };
    document.addEventListener('zg:update', renderAbout);
    view.querySelector('#aboutCard').addEventListener('click', (e) => {
      const b = e.target.closest('[data-updact]');
      if (!b) return;
      if (b.dataset.updact === 'install') App.installUpdate();
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
  window.UI = { trackRow, trackList, registerList, Lists, card, shelf, waveOptions, waveSummary, waveHero, MOODS, LANGS, POPS, GENRES, entityCard, playlistCard };
})();
