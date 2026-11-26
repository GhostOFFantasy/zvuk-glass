'use strict';
/* Связка интерфейса: навигация, коллекция, поиск, панели, плеер, горячие клавиши */
(function () {
  // параметры служебного запуска приходят от Rust-части (раньше — в адресе страницы)
  const params = new URLSearchParams(window.__ZG_ARGS__ || location.search);
  const SCREENSHOT = params.get('screenshot') === '1';

  const App = {
    settings: {},
    profile: null,
    demo: false,
    likes: { track: new Set(), release: new Set(), artist: new Set(), playlist: new Set() },
    playlists: [],
    route: null,
    history: [],
    future: [],
    panel: null,
    lyrics: { trackId: null, data: null, loading: false },
  };
  window.App = App;

  // ======================================================================
  // Запуск и вход
  // ======================================================================
  async function boot() {
    hydrateIcons();
    Clip.bindPlayer();
    App.settings = await window.zvuk.settings.get();
    App.settings.viz = { style: 'bars', color: 'accent', sensitivity: 1, dim: 35, pulse: true, syncVideo: true, ...(App.settings.viz || {}) };
    App.settings.profileLocal = App.settings.profileLocal || {};
    // эффект преломления (SVG-фильтр) на телефоне слишком тяжёл — там только размытое стекло
    document.body.classList.toggle('liquid-on', App.settings.liquidGlass !== false && !window.ZG_MOBILE);
    Custom.init(App.settings);
    setPerformanceMode(App.settings.performanceMode, false);
    sendIcons();
    initUpdates();
    const st = await window.zvuk.auth.state();
    if (st.authorized) start(st);
    else {
      showLogin();
      if (SCREENSHOT) setTimeout(() => window.zvuk.screenshotReady(), 1500);
    }
  }

  // ======================================================================
  // Обновления «по воздуху»
  // ======================================================================
  App.update = { state: 'idle' };
  let updHidden = null;
  function initUpdates() {
    const apply = (st) => {
      App.update = st || { state: 'idle' };
      renderUpdateBanner();
      document.dispatchEvent(new CustomEvent('zg:update', { detail: App.update }));
    };
    window.zvuk.update.onStatus(apply);
    window.zvuk.update.state().then(apply).catch(() => {});
  }
  function renderUpdateBanner() {
    const st = App.update;
    let el = $('#updBanner');
    if (st.state !== 'ready' || updHidden === st.version) {
      if (el && !el.classList.contains('out')) {
        el.classList.add('out');
        setTimeout(() => el.remove(), 320);
      }
      return;
    }
    if (el) return;
    el = document.createElement('div');
    el.id = 'updBanner';
    el.className = 'upd-banner glass-menu';
    el.innerHTML = `<div class="upd-ic">${icon('sparkle')}</div>
      <div class="upd-tx"><b>Готово обновление ${esc(st.version || '')}</b><span>${window.ZG_MOBILE ? 'Нажмите «Установить» и подтвердите в окне Android' : 'Установится само при выходе — или прямо сейчас'}</span></div>
      <button class="btn small primary" data-upd="install">${icon('refresh')}${window.ZG_MOBILE ? 'Установить' : 'Перезапустить'}</button>
      <button class="upd-x" data-upd="later" title="Позже">${icon('close')}</button>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-upd]');
      if (!b) return;
      if (b.dataset.upd === 'install') App.installUpdate();
      else {
        updHidden = st.version;
        renderUpdateBanner();
      }
    });
    document.body.appendChild(el);
  }
  App.checkUpdates = () => window.zvuk.update.check();
  App.installUpdate = async () => {
    toast('Устанавливаем обновление…', { iconName: 'refresh', ms: 6000 });
    await window.zvuk.update.install();
  };

  function showLogin() {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    Custom.setTrackTheme(null);
    hydrateIcons($('#login'));
  }

  async function loginResult(r) {
    if (r.ok) {
      $('#loginError').classList.add('hidden');
      start(r.data);
    } else {
      $('#loginError').textContent = r.error.message;
      $('#loginError').classList.remove('hidden');
    }
  }

  /** Достаёт токен из того, что вставил пользователь: сам токен или весь текст страницы профиля. */
  function extractToken(text) {
    text = String(text || '').trim();
    if (!text) return null;
    try {
      const j = JSON.parse(text);
      const t = j?.result?.profile?.token || j?.result?.token || j?.token;
      if (t) return String(t);
    } catch {}
    const m = text.match(/"token"\s*:\s*"([^"]+)"/) || text.match(/token\s*[:=]\s*"?([A-Za-z0-9._-]{16,})/i);
    if (m) return m[1];
    if (/^[A-Za-z0-9._-]{16,}$/.test(text)) return text;
    return null;
  }

  async function loginWithText(text) {
    const token = extractToken(text);
    if (!token) {
      $('#loginError').textContent = 'Не нашли токен. Скопируйте всё содержимое страницы zvuk.com/api/tiny/profile или только значение token.';
      $('#loginError').classList.remove('hidden');
      return;
    }
    loginResult(await window.zvuk.auth.withToken(token));
  }

  $('#tokenForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loginWithText($('#tokenInput').value);
  });

  let started = false;
  async function start(st) {
    App.profile = st.profile || null;
    App.demo = Boolean(st.demo);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderProfileChip();
    if (started) {
      navigate('home', {}, { replace: true });
      loadLibrary();
      return;
    }
    started = true;
    hydrateIcons($('#app'));
    hydrateIcons($('#nowPlaying'));
    applySections();
    Player.init(App.settings);
    bindPlayer();
    Nova.init();
    Ink.start();
    Custom.setTrackTheme(null);
    // Мини-визуализатор на фоне панели плеера
    // 30 кадров/с, обычная чёткость и мягкий стиль — фоновой полоске больше не нужно
    // на телефоне мини-плеер без визуализатора — холст не рисуем вовсе (экономия батареи)
    if (!window.ZG_MOBILE) App.miniViz = Viz.attach($('#miniViz'), { style: 'bars', soft: true, barH: 0.9, bars: 72, maxDpr: 1, fps: 30, glow: false, idle: false, sensitivity: 0.9 });
    updateQualityBadge();
    const saveEq = debounce((eq) => window.zvuk.settings.set({ eq }), 300);
    AudioFX.onChange = (eq) => {
      saveEq(eq);
      $('#plEqBtn').classList.toggle('on', eq.enabled);
    };
    $('#plEqBtn').classList.toggle('on', AudioFX.eq.enabled);
    $('#sbToggle').title = Custom.s.compact ? 'Развернуть панель' : 'Свернуть панель';
    // «Пульс в такт» полосы времени: обновляем переменную только на двух полосах, а не на всём документе
    const seekEls = [$('#seek'), $('#npSeek')];
    let lastBeat = -1;
    Viz.onTick = (V, live) => {
      if (!Custom.s.seekBeat) return;
      const b = live ? Math.round(V.beat * 20) / 20 : 0;
      if (b === lastBeat) return;
      lastBeat = b;
      for (const el of seekEls) el.style.setProperty('--beat', b);
    };

    const route = params.get('route');
    if (route) {
      const [v, ...rest] = route.split(':');
      const arg = rest.join(':');
      const key = v === 'search' ? 'q' : 'id';
      navigate(v, arg ? { [key]: arg } : {}, { replace: true });
    } else navigate('home', {}, { replace: true });

    loadLibrary();
    restoreQueue();
    if (SCREENSHOT) screenshotWhenReady().catch((error) => {
      console.error('SCREENSHOT_FLOW failure', error);
      window.zvuk.screenshotReady(0);
    });
    else setTimeout(() => whatsNew(false), 1400);
  }

  // ======================================================================
  // «Что нового»: плашка после обновления (тексты — changelog.js)
  // ======================================================================
  const verNum = (v) => String(v || '0').split('.').map(Number).reduce((s, n) => s * 1000 + (n || 0), 0);
  async function whatsNew(force, curOverride) {
    const list = window.ZG_CHANGELOG || [];
    const st = curOverride ? null : await window.zvuk.update.state().catch(() => null);
    const cur = curOverride || (st && st.current);
    if (!cur || !list.length) return;
    const seen = App.settings.seenVersion;
    let entries;
    if (force) entries = list.filter((e) => verNum(e.version) <= verNum(cur)).slice(0, 1);
    else {
      if (seen === cur) return;
      App.settings.seenVersion = cur;
      window.zvuk.settings.set({ seenVersion: cur });
      // только что установили (настроек ещё не было) — рассказывать «что нового» не о чем
      if (!seen && App.settings.freshInstall) return;
      // все версии, вышедшие после той, что стояла раньше; если раньше была «бо́льшая» (смена нумерации) — текущая
      entries = list.filter((e) => verNum(e.version) <= verNum(cur) && (!seen || verNum(e.version) > verNum(seen)));
      if (!entries.length) entries = list.filter((e) => e.version === cur);
    }
    if (!entries.length) return;
    $('.wn-back')?.remove();
    const back = document.createElement('div');
    back.className = 'wn-back';
    const many = entries.length > 1;
    back.innerHTML = `<div class="wn glass-menu" role="dialog" aria-label="Что нового">
        <div class="wn-head">
          <div class="wn-mark">${icon('sparkle')}</div>
          <div class="wn-tt"><div class="wn-kicker">${force ? 'Что нового' : 'Приложение обновлено'}</div><h3>Zvuk Glass ${esc(cur)}</h3></div>
          <button class="icon-btn" data-wn="close" title="Закрыть">${icon('close')}</button>
        </div>
        <div class="wn-list">${entries
          .map(
            (e) =>
              `${many ? `<div class="wn-ver">Версия ${esc(e.version)}</div>` : ''}${e.items
                .map((it) => `<div class="wn-item"><span class="wn-ic">${icon(it.icon || 'check')}</span><div><b>${esc(it.title)}</b><p>${esc(it.text)}</p></div></div>`)
                .join('')}`,
          )
          .join('')}</div>
        <div class="wn-foot">
          <button class="btn small" data-wn="github">${icon('external')}Все изменения на GitHub</button>
          <button class="btn primary" data-wn="close">Понятно</button>
        </div>
      </div>`;
    const close = () => {
      back.classList.add('out');
      setTimeout(() => back.remove(), 260);
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    back.addEventListener('mousedown', (e) => e.target === back && close());
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wn]');
      if (!b) return;
      if (b.dataset.wn === 'github') window.zvuk.openZvuk(`https://github.com/GhostOFFantasy/zvuk-glass/releases/tag/v${cur}`);
      close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
  }
  App.whatsNew = (force = true, version) => whatsNew(force, version);

  /** Имя и аватар: свои (локальные) имеют приоритет над данными Zvuk. */
  App.displayName = () => App.settings.profileLocal?.name || App.profile?.name || (App.demo ? 'Гость' : 'Профиль');
  App.avatarUrl = (size = 64) => Custom.media.avatar || (App.profile?.image ? img(App.profile.image, size) : '');
  function renderProfileChip() {
    const name = App.displayName();
    const av = App.avatarUrl(64);
    $('#profileChip').innerHTML = `<span class="profile-copy"><b>${esc(name)}</b><small>Личное пространство</small></span><span class="ava">${av ? `<img src="${esc(av)}" alt="">` : esc(name[0])}</span>`;
  }
  App.renderProfileChip = renderProfileChip;

  // ======================================================================
  // Коллекция и плейлисты
  // ======================================================================
  App.refreshCollection = async () => {
    const c = await api('getCollectionIds');
    App.likes.track = new Set(c.tracks);
    App.likes.release = new Set(c.releases);
    App.likes.artist = new Set(c.artists);
    App.likes.playlist = new Set(c.playlists);
    App.collection = c;
    return c;
  };

  App.loadPlaylists = async () => {
    const c = App.collection || (await App.refreshCollection());
    const list = await api('getPlaylistsShort', c.playlists);
    const own = list.filter((p) => App.isOwnPlaylist(p));
    const other = list.filter((p) => !App.isOwnPlaylist(p));
    App.playlists = [...own, ...other];
    renderSidePlaylists();
    return App.playlists;
  };

  App.isOwnPlaylist = (p) => Boolean(p && App.profile?.id && String(p.userId) === String(App.profile.id));

  async function loadLibrary() {
    if (App.demo) return renderSidePlaylists();
    try {
      await App.refreshCollection();
      refreshLikeButtons();
      await App.loadPlaylists();
    } catch (e) {
      console.warn('library', e);
      if (e.code === 'UNAUTHORIZED') return sessionExpired();
      renderSidePlaylists();
    }
  }

  function renderSidePlaylists() {
    const el = $('#sidePlaylists');
    if (!App.playlists.length) {
      el.innerHTML = `<div class="muted small" style="padding:6px 12px">${App.demo ? 'Войдите, чтобы видеть свои плейлисты' : 'Плейлистов пока нет'}</div>`;
      return;
    }
    el.innerHTML = App.playlists
      .map((p) => {
        const art = playlistArt(p, 96);
        return `<button class="sp-item${App.route?.view === 'playlist' && String(App.route.params.id) === String(p.id) ? ' active' : ''}" data-act="nav" data-view="playlist" data-id="${esc(p.id)}">
        <div class="sp-art">${art || `<div class="tile-art">${icon('playlist')}</div>`}</div>
        <div class="t"><div>${esc(p.title)}</div><div class="s">${App.isOwnPlaylist(p) ? 'Мой плейлист' : 'Плейлист'} · ${p.trackCount ?? 0}</div></div></button>`;
      })
      .join('');
  }

  async function sessionExpired() {
    toast('Сессия Zvuk истекла — войдите заново', { error: true });
    await window.zvuk.auth.logout();
    showLogin();
  }

  // ---------- Лайки ----------
  App.toggleLike = async (type, id) => {
    if (App.demo) return toast('Войдите в аккаунт, чтобы добавлять в коллекцию');
    id = String(id);
    const set = App.likes[type];
    const was = set.has(id);
    was ? set.delete(id) : set.add(id);
    refreshLikeButtons();
    try {
      await api(was ? 'unlike' : 'like', type, id);
      const what = { track: 'Трек', release: 'Альбом', artist: 'Исполнитель', playlist: 'Плейлист' }[type];
      toast(was ? `${what} убран из коллекции` : `${what} добавлен в коллекцию`, { iconName: was ? 'heart' : 'heartFill', ms: 1800 });
      if (type === 'playlist') App.loadPlaylists();
    } catch (e) {
      was ? set.add(id) : set.delete(id);
      refreshLikeButtons();
      toast('Не получилось: ' + e.message, { error: true });
    }
  };

  function refreshLikeButtons() {
    $$('[data-act="like"]').forEach((b) => {
      const liked = App.likes[b.dataset.type]?.has(String(b.dataset.id));
      b.classList.toggle('liked', Boolean(liked));
      const i = b.querySelector('.i');
      if (i) i.innerHTML = ICONS[liked ? 'heartFill' : 'heart'];
      const label = b.querySelector('span:not(.i)');
      if (label && b.dataset.type === 'artist') label.textContent = liked ? 'В коллекции' : 'В коллекцию';
    });
    const cur = Player.current;
    const liked = cur && App.likes.track.has(String(cur.id));
    for (const b of [$('#plLike'), $('#npLike')]) {
      b.classList.toggle('liked', Boolean(liked));
      b.querySelector('.i').innerHTML = ICONS[liked ? 'heartFill' : 'heart'];
    }
  }

  // ---------- Плейлисты: создание и редактирование ----------
  async function createPlaylist(trackIds = []) {
    if (App.demo) return toast('Войдите в аккаунт, чтобы создавать плейлисты');
    const name = await modal({ title: 'Новый плейлист', input: 'Мой плейлист', okText: 'Создать' });
    if (!name) return;
    try {
      const id = await api('createPlaylist', name, trackIds);
      await App.refreshCollection().catch(() => {});
      await App.loadPlaylists();
      toast(`Плейлист «${name}» создан`, { iconName: 'check' });
      if (id) navigate('playlist', { id });
    } catch (e) {
      toast('Не удалось создать плейлист: ' + e.message, { error: true });
    }
  }

  async function addToPlaylist(pl, tracks) {
    try {
      await api('addTracksToPlaylist', pl.id, tracks.map((t) => t.id));
      api.invalidate('getPlaylist:');
      toast(`Добавлено в «${pl.title}»`, { iconName: 'check' });
      App.loadPlaylists();
    } catch (e) {
      toast('Не удалось добавить: ' + e.message, { error: true });
    }
  }

  async function removeFromPlaylist(playlistId, track) {
    try {
      const p = await window.zvuk.call('getPlaylist', playlistId);
      const ids = p.trackIds.filter((x) => String(x) !== String(track.id));
      await api('updatePlaylist', playlistId, { name: p.title, isPublic: p.isPublic, trackIds: ids });
      api.invalidate('getPlaylist:');
      toast('Трек удалён из плейлиста', { iconName: 'trash' });
      App.loadPlaylists();
      if (App.route?.view === 'playlist') render(true);
    } catch (e) {
      toast('Не удалось удалить: ' + e.message, { error: true });
    }
  }

  async function playlistMenuActions(p) {
    const own = App.isOwnPlaylist(p);
    const items = [
      { label: 'Слушать', icon: 'play', onClick: () => playEntity('playlist', p.id) },
      { label: 'Добавить в очередь', icon: 'addQueue', onClick: async () => Player.addToQueue((await api('getPlaylist', p.id)).tracks) },
      { label: 'Скопировать ссылку', icon: 'link', onClick: () => copyLink(`https://zvuk.com/playlist/${p.id}`) },
    ];
    if (own)
      items.push(
        { sep: true },
        {
          label: 'Переименовать',
          icon: 'edit',
          onClick: async () => {
            const name = await modal({ title: 'Переименовать плейлист', input: p.title, okText: 'Сохранить' });
            if (!name) return;
            try {
              await api('renamePlaylist', p.id, name);
              api.invalidate('getPlaylist:');
              await App.loadPlaylists();
              render(true);
            } catch (e) {
              toast('Не получилось: ' + e.message, { error: true });
            }
          },
        },
        {
          label: 'Удалить плейлист',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await modal({ title: 'Удалить плейлист?', text: `«${p.title}» будет удалён из вашего аккаунта Zvuk. Это действие нельзя отменить.`, okText: 'Удалить', danger: true });
            if (!ok) return;
            try {
              await api('deletePlaylist', p.id);
              await App.refreshCollection().catch(() => {});
              await App.loadPlaylists();
              toast('Плейлист удалён', { iconName: 'trash' });
              navigate('playlists', {}, { replace: true });
            } catch (e) {
              toast('Не получилось: ' + e.message, { error: true });
            }
          },
        }
      );
    else
      items.push({ label: App.likes.playlist.has(String(p.id)) ? 'Убрать из коллекции' : 'Добавить в коллекцию', icon: 'heart', onClick: () => App.toggleLike('playlist', p.id) });
    return items;
  }

  function copyLink(url) {
    window.zvuk.clipboard(url);
    toast('Ссылка скопирована', { iconName: 'link', ms: 1600 });
  }

  // ======================================================================
  // Навигация
  // ======================================================================
  const NAV_MAIN = ['home', 'wave', 'search', 'liked', 'albums', 'artists', 'playlists', 'history'];

  let waveOrbitHandle = null;
  let waveOrbitToken = 0;

  function syncWaveTransport() {
    const title = $('#waveTransportTitle');
    if (!title) return;
    const active = Player.source?.kind === 'wave';
    title.textContent = active && Player.playing ? 'Орбита в движении' : active ? 'Орбита на паузе' : 'Запустить орбиту';
  }

  function setWaveFocus(on) {
    const hero = $('.wv-hero');
    const portal = hero?.querySelector('.wv-portal');
    const canvas = $('#waveCosmos');
    const token = ++waveOrbitToken;
    waveOrbitHandle?.stop();
    waveOrbitHandle = null;
    document.body.classList.toggle('wave-focus', on);
    if (hero) delete hero.dataset.orbitFallback;
    const focusCover = $('#wvNowSlot .wv-now img');
    if (focusCover && Player.current) focusCover.src = cover(Player.current, on ? 600 : 160);

    const play = $('#waveOrb');
    const slot = $('#wavePlaySlot');
    if (on && play && slot) slot.append(play);
    else if (!on && play && portal) portal.insertBefore(play, portal.querySelector('.wv-instrument-action'));
    if (canvas?._cosmos) {
      const normalStyle = document.body.classList.contains('design-classic') ? 'waves' : 'gravity';
      canvas._cosmos.set({ style: on ? 'none' : normalStyle });
      canvas.dataset.scene = on ? 'orbit3d' : normalStyle;
    }
    const sceneLabel = $('.wv-portal-label');
    if (sceneLabel) sceneLabel.innerHTML = `<span></span>${on ? 'Музыкальные миры' : 'Орбитальная карта'}<span></span>`;
    const sceneSub = $('.wv-portal-sub');
    if (sceneSub) sceneSub.textContent = on ? 'Планета — музыкальный мир · тяните для вращения · двойной клик — сброс' : 'Музыка формирует пространство вокруг вас';
    syncWaveTransport();
    const btn = $('#waveFocusBtn');
    if (btn) {
      btn.innerHTML = `${icon(on ? 'close' : 'fullscreen')}<span>${on ? 'Выйти' : 'Погрузиться'}</span>`;
      btn.title = on ? 'Выйти из полноэкранного погружения (Esc)' : 'Интерактивная орбита на весь экран (Esc — выход)';
      btn.setAttribute('aria-pressed', String(on));
    }
    if (on && hero) {
      $('#scroller').scrollTop = 0;
      // Запрашиваем полный экран синхронно, пока действие пользователя ещё активно.
      if (document.fullscreenElement !== hero) hero.requestFullscreen?.().catch(() => {});
      import('./orbit3d.js').then(({ mountOrbit }) => {
        if (token !== waveOrbitToken || !document.body.classList.contains('wave-focus') || !hero.isConnected) return;
        waveOrbitHandle = mountOrbit(hero);
        hero._orbit3d = waveOrbitHandle;
      }).catch((error) => {
        if (token !== waveOrbitToken || !hero.isConnected) return;
        console.warn('Orbit 3D is unavailable; restored the lightweight scene.', error);
        hero.dataset.orbitFallback = 'true';
        hero.querySelectorAll('.wv-3d-stage').forEach((el) => el.remove());
        waveOrbitHandle = null;
        if (play && portal) portal.prepend(play);
        if (canvas?._cosmos) {
          canvas._cosmos.set({ style: 'solar' });
          canvas.dataset.scene = 'solar';
        }
        if (sceneLabel) sceneLabel.innerHTML = '<span></span>Музыкальная вселенная<span></span>';
        if (sceneSub) sceneSub.textContent = 'Центр — старт / пауза · кольцо — путь трека';
        toast('3D-ускорение недоступно — включена лёгкая орбита', { ms: 3500 });
      });
    } else {
      if (hero && document.fullscreenElement === hero) document.exitFullscreen?.().catch(() => {});
      const seek = $('#waveRingSeek');
      if (seek) {
        const duration = Player.audio.duration;
        const enabled = Number.isFinite(duration) && duration > 0 && Boolean(Player.current);
        seek.classList.toggle('available', enabled);
        seek.tabIndex = enabled ? 0 : -1;
        seek.setAttribute('aria-disabled', String(!enabled));
      }
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('wave-focus')) setWaveFocus(false);
  });

  function navigate(view, p = {}, { replace = false } = {}) {
    if (!Views[view]) view = 'home';
    // Переход к странице всегда показывает её: полноэкранный плеер сворачивается
    if (window.NP && NP.isOpen) NP.close();
    const sc = $('#scroller');
    if (App.route && !replace) {
      App.route.scroll = sc.scrollTop;
      App.history.push(App.route);
      App.future = [];
    }
    App.route = { view, params: p, scroll: 0 };
    render();
  }
  App.navigate = navigate;
  App.rerender = () => render(true);

  function goBack() {
    if (!App.history.length) return;
    App.route.scroll = $('#scroller').scrollTop;
    App.future.push(App.route);
    App.route = App.history.pop();
    render(false, App.route.scroll);
  }
  function goForward() {
    if (!App.future.length) return;
    App.route.scroll = $('#scroller').scrollTop;
    App.history.push(App.route);
    App.route = App.future.pop();
    render(false, App.route.scroll);
  }

  let renderSeq = 0;
  async function render(keepScroll = false, restoreScroll = 0) {
    const seq = ++renderSeq;
    const sc = $('#scroller');
    const prevScroll = sc.scrollTop;
    const old = $('#view');
    // Сначала останавливаем WebGL и возвращаем кнопку в исходный слот, затем заменяем страницу.
    if (document.body.classList.contains('wave-focus')) setWaveFocus(false);
    // сцена визуализатора держит клип YouTube и анимацию — освобождаем её вместе со старым экраном
    if (Views._vizScene) {
      Views._vizScene.destroy();
      Views._vizScene = null;
    }
    if (Views._pulse) {
      Views._pulse.destroy();
      Views._pulse = null;
    }
    const view = document.createElement('div');
    view.className = 'view' + (keepScroll ? '' : ' enter');
    view.id = 'view';
    view.dataset.page = App.route.view;
    document.body.dataset.route = App.route.view;
    old.replaceWith(view);
    sc.scrollTop = keepScroll ? prevScroll : 0;
    const { view: v, params: p } = App.route;
    if (v !== 'wave') setWaveFocus(false);
    updateNav();
    if (v !== 'release' && v !== 'artist' && v !== 'playlist') App.setPageTheme(null);
    $('#btnBack').disabled = !App.history.length;
    $('#btnFwd').disabled = !App.future.length;
    if (v === 'search') $('#searchInput').value = p.q || '';
    try {
      await Views[v](view, p);
    } catch (e) {
      console.error(e);
      if (e.code === 'UNAUTHORIZED') return sessionExpired();
      if (seq === renderSeq) view.innerHTML = `<div class="empty">${icon('note')}<div>${esc(e.message)}</div><button class="btn" data-act="reload-view">Повторить</button></div>`;
    }
    if (seq !== renderSeq) return;
    if (restoreScroll) requestAnimationFrame(() => (sc.scrollTop = restoreScroll));
    else if (keepScroll) sc.scrollTop = prevScroll;
    UI.virtualize?.(view);
    UI.warmImages?.(view);
    markPlayingRows();
  }

  function updateNav() {
    const v = App.route?.view;
    $$('.sidebar .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    moveIndicator();
    // список плейлистов не перерисовываем — только отмечаем открытый
    const pid = v === 'playlist' ? String(App.route.params.id) : null;
    $$('#sidePlaylists .sp-item').forEach((b) => b.classList.toggle('active', b.dataset.id === pid));
  }
  function moveIndicator() {
    const v = App.route?.view;
    const active = $(`.sidebar .nav-item[data-view="${v}"]`);
    const ind = $('#navIndicator');
    const section = active?.closest('[data-sec-body]')?.dataset.secBody;
    const hiddenSec = section && $('#sidebar').classList.contains(`sec-${section}-off`) && !document.body.classList.contains('compact-sidebar');
    if (active && !hiddenSec) {
      const sb = $('#sidebarScroll').getBoundingClientRect();
      const r = active.getBoundingClientRect();
      ind.style.transform = `translateY(${r.top - sb.top + $('#sidebarScroll').scrollTop}px)`;
      ind.style.opacity = '1';
    } else ind.style.opacity = '0';
  }
  window.addEventListener('resize', debounce(updateNav, 100));
  let navScrollRaf = 0;
  $('#sidebarScroll')?.addEventListener('scroll', () => {
    if (navScrollRaf) return;
    navScrollRaf = requestAnimationFrame(() => {
      navScrollRaf = 0;
      moveIndicator();
    });
  }, { passive: true });

  // ---------- Сворачиваемые разделы боковой панели ----------
  const SEC_KEY = 'zg.sections';
  const secState = () => {
    try {
      return JSON.parse(localStorage.getItem(SEC_KEY) || '{}');
    } catch {
      return {};
    }
  };
  function applySections() {
    const s = secState();
    for (const sec of ['main', 'lib', 'pl']) $('#sidebar').classList.toggle(`sec-${sec}-off`, Boolean(s[sec]));
    $$('.sec-toggle').forEach((b) => {
      const collapsed = Boolean(s[b.dataset.sec]);
      b.title = collapsed ? 'Развернуть' : 'Свернуть';
      b.setAttribute('aria-expanded', String(!collapsed));
    });
  }
  function toggleSection(sec) {
    const s = secState();
    s[sec] = !s[sec];
    localStorage.setItem(SEC_KEY, JSON.stringify(s));
    applySections();
    followIndicator();
  }
  /** Индикатор активного пункта следует за анимацией (сворачивание разделов, смена ширины панели). */
  function followIndicator(ms = 520) {
    const t0 = performance.now();
    const ind = $('#navIndicator');
    ind.style.transition = 'opacity 0.3s ease';
    const follow = () => {
      moveIndicator();
      if (performance.now() - t0 < ms) requestAnimationFrame(follow);
      else ind.style.transition = '';
    };
    follow();
  }
  /**
   * Сворачивание боковой панели без перекладки всей страницы на каждом кадре:
   * панель на время анимации «всплывает» поверх контента и меняет только свою ширину,
   * а основная область перестраивается один раз — под панелью, где этого не видно.
   */
  let sbBusy = false;
  function toggleCompact() {
    if (sbBusy) return;
    const toCompact = !Custom.s.compact;
    const sb = $('#sidebar');
    const body = document.body;
    const done = () => {
      $('#sbToggle').title = Custom.s.compact ? 'Развернуть панель' : 'Свернуть панель';
      moveIndicator();
    };
    if (Custom.s.reduceMotion) {
      Custom.set({ compact: toCompact });
      return done();
    }
    sbBusy = true;
    const main = $('#main');
    const r = sb.getBoundingClientRect();
    const mainLeft0 = main.getBoundingClientRect().left;
    const cs = getComputedStyle($('#app'));
    const target = parseFloat(cs.getPropertyValue(toCompact ? '--sb-compact' : '--sb-full')) || (toCompact ? 78 : 258);
    const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)';
    const DUR = 380;
    // 1) панель «всплывает» поверх и держит прежнюю ширину
    Object.assign(sb.style, { left: r.left + 'px', top: r.top + 'px', height: r.height + 'px', width: r.width + 'px', transition: 'none' });
    body.classList.add('sb-anim');
    // 2) сетка сразу переходит в новое состояние — основная область перестраивается один раз
    Custom.set({ compact: toCompact });
    const dx = mainLeft0 - main.getBoundingClientRect().left;
    sb.getBoundingClientRect();
    sb.style.transition = `width ${DUR}ms ${ease}`;
    // 3) основная область визуально стоит на прежнем месте и едет вместе с краем панели (только transform)
    main.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => {
      sb.style.width = target + 'px';
      main.style.transition = `transform ${DUR}ms ${ease}`;
      main.style.transform = 'translateX(0)';
    });
    followIndicator(DUR + 40);
    setTimeout(() => {
      body.classList.remove('sb-anim');
      for (const p of ['left', 'top', 'height', 'width', 'transition']) sb.style.removeProperty(p);
      main.style.removeProperty('transform');
      main.style.removeProperty('transition');
      sbBusy = false;
      done();
    }, DUR + 30);
  }

  // ---------- Тема страницы и фона ----------
  App.heroColor = (item) => {
    const t = themeFromPalette(palette(item));
    return t ? t.c1 : 'var(--c1)';
  };
  App.setPageTheme = () => {}; // фон определяется текущим треком

  let bgFlip = false;
  let bgSrc = '';
  function setBackground(t) {
    // для размытого фона хватает крошечной картинки: растянутая, она уже мягкая, а размытие дешевле
    const src = cover(t, 96);
    if (src && src !== bgSrc) {
      bgSrc = src;
      const pre = new Image();
      pre.onload = () => {
        bgFlip = !bgFlip;
        const on = bgFlip ? $('#bgArtA') : $('#bgArtB');
        const off = bgFlip ? $('#bgArtB') : $('#bgArtA');
        on.style.backgroundImage = `url("${src}")`;
        on.classList.add('on');
        off.classList.remove('on');
        $('#npBg').style.backgroundImage = `url("${src}")`;
        const vb = $('#vizBg');
        if (vb) vb.style.backgroundImage = `url("${src}")`;
      };
      pre.src = src;
    }
    Custom.setTrackTheme(themeFromPalette(palette(t)));
  }

  // ======================================================================
  // Воспроизведение сущностей
  // ======================================================================
  async function playEntity(kind, id) {
    try {
      if (kind === 'release') {
        const r = await api('getRelease', id);
        const tracks = (r.tracks || []).map((t) => ({ ...t, release: t.release || { id: r.id, title: r.title, image: r.image } }));
        Player.playList(tracks, 0, { kind: 'list', title: r.title });
      } else if (kind === 'playlist') {
        const p = await api('getPlaylist', id);
        if (!p.tracks.length) return toast('Плейлист пуст');
        Player.playList(p.tracks, 0, { kind: 'list', title: p.title });
      } else if (kind === 'artist') {
        const [a, tracks] = await Promise.all([api('getArtistsShort', [id]).then((r) => r[0]).catch(() => null), api('getArtistTracks', id, 100)]);
        if (!tracks.length) return toast('У исполнителя нет треков');
        Player.playList(tracks, 0, { kind: 'list', title: a?.title || tracks[0].artists?.[0]?.title || 'Исполнитель' });
      } else if (kind === 'wave') {
        startEditorialWave(id);
      } else if (kind === 'liked') {
        navigate('liked');
      }
    } catch (e) {
      toast('Не удалось запустить: ' + e.message, { error: true });
    }
  }

  // Дрейф фоновых пятен выполняется композитором, без пересчёта CSS-стилей каждую кадровую метку.
  // WAAPI сохраняет те же ключевые кадры и длительности; при отказе API остаётся исходный CSS-вариант.
  let ambientAnimations = [];
  let ambientReady = false;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function syncAmbientMotion() {
    const classes = document.body.classList;
    const stopped = reducedMotion.matches || document.hidden || ['reduce-motion', 'perf-eco', 'design-classic', 'no-blobs', 'win-hidden'].some((name) => classes.contains(name));
    for (const animation of ambientAnimations) {
      if (stopped && animation.playState === 'running') animation.pause();
      else if (!stopped && animation.playState === 'paused') animation.play();
    }
  }
  function initAmbientMotion() {
    if (ambientReady) return syncAmbientMotion();
    const blobs = [...document.querySelectorAll('.blob')];
    if (!blobs.length || typeof blobs[0].animate !== 'function') return;
    const specs = [];
    for (const element of blobs) {
      const cssAnimation = element.getAnimations().find((animation) => /^drift[123]$/.test(animation.animationName || ''));
      if (!cssAnimation?.effect) return;
      specs.push({ element, frames: cssAnimation.effect.getKeyframes(), timing: cssAnimation.effect.getTiming(), currentTime: cssAnimation.currentTime || 0 });
    }
    ambientReady = true;
    document.body.classList.add('waapi-blobs');
    ambientAnimations = specs.map(({ element, frames, timing, currentTime }) => {
      const animation = element.animate(frames, timing);
      animation.currentTime = currentTime;
      return animation;
    });
    const observer = new MutationObserver(syncAmbientMotion);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', syncAmbientMotion);
    reducedMotion.addEventListener('change', syncAmbientMotion);
    syncAmbientMotion();
  }

  function setPerformanceMode(mode, persist = true) {
    if (mode === 'high') mode = 'full';
    if (mode === 'balanced') mode = 'auto';
    if (!['auto', 'full', 'eco'].includes(mode)) mode = 'auto';
    App.settings.performanceMode = mode;
    document.body.classList.remove('perf-balanced');
    document.body.classList.toggle('perf-full', mode === 'full');
    document.body.classList.toggle('perf-eco', mode === 'eco');
    if (persist) window.zvuk.settings.set({ performanceMode: mode });
    initAmbientMotion();
    window.dispatchEvent(new CustomEvent('zg:performance', { detail: { mode } }));
  }
  App.setPerformanceMode = setPerformanceMode;

  function startMyWave() {
    const opts = UI.waveOptions();
    const world = OrbitWorlds.get(App.settings.wave?.world);
    Player.startEndless({
      kind: 'wave',
      title: `Орбита · ${world.name}`,
      params: { opts },
      fetchMore: () => window.zvuk.call('personalWave', 10, opts),
    });
  }
  function startWaveWorld(id) {
    const world = OrbitWorlds.get(id);
    if (App.settings.wave?.world === world.id && Player.source?.kind === 'wave' && Player.current) {
      if (!Player.playing) Player.toggle();
      return;
    }
    const w = OrbitWorlds.settings(world.id);
    App.settings.wave = w;
    window.zvuk.settings.set({ wave: w });
    const summary = $('#waveSummary');
    if (summary) summary.textContent = UI.waveSummary(w);
    Views._waveTune?.(w);
    startMyWave();
    toast(`${world.name} · ${world.short}`, { iconName: world.icon, ms: 2800 });
  }
  document.addEventListener('orbit-world', (e) => startWaveWorld(e.detail?.id));
  async function startEditorialWave(id) {
    let title = 'Волна';
    try {
      title = (await api('getWaves', [String(id)]))[0]?.title || title;
    } catch {}
    const fetchMore = async () => {
      const parts = await Promise.allSettled([window.zvuk.call('waveContent', id), window.zvuk.call('waveContent', id)]);
      return parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : []));
    };
    Player.startEndless({ kind: 'ewave', title, params: { id }, fetchMore });
    toast(`Включена волна «${title}»`, { iconName: 'wave', ms: 2000 });
  }
  function startRadio(type, id, title) {
    let cursor = 0;
    Player.startEndless({
      kind: 'radio',
      title: `Радио: ${title}`,
      params: { type, id, title },
      fetchMore: async () => {
        const r = await window.zvuk.call('radio', type, id, cursor);
        cursor = r.cursor || cursor + r.tracks.length;
        return r.tracks;
      },
    });
    toast(`Радио «${title}»`, { iconName: 'radio', ms: 2000 });
  }

  function restoreQueue() {
    const d = Player.restore();
    if (!d) return;
    const s = d.source || {};
    let source = { kind: 'list', title: s.title || '' };
    if (s.kind === 'wave') source = { kind: 'wave', title: 'Музыкальная орбита', params: s.params, fetchMore: () => window.zvuk.call('personalWave', 10, s.params?.opts || {}) };
    else if (s.kind === 'radio' && s.params) {
      let cursor = 0;
      source = { kind: 'radio', title: s.title, params: s.params, fetchMore: async () => { const r = await window.zvuk.call('radio', s.params.type, s.params.id, cursor); cursor = r.cursor || cursor + r.tracks.length; return r.tracks; } };
    } else if (s.kind === 'ewave' && s.params) {
      source = { kind: 'ewave', title: s.title, params: s.params, fetchMore: () => window.zvuk.call('waveContent', s.params.id) };
    }
    Player.cue(d.queue, d.index, d.pos, source);
  }

  // ======================================================================
  // Привязка плеера к интерфейсу
  // ======================================================================
  let seekUI, npSeekUI, volUI, npVolUI;
  function syncTrackPlayIcons(force = false) {
    const playing = force === true || Player.playing;
    document.querySelectorAll('.tr[data-track]').forEach((row) => {
      const current = Player.current && String(Player.current.id) === String(row.dataset.track);
      row.classList.toggle('playing', current);
      const icon = row.querySelector('[data-play-icon]');
      if (icon) icon.innerHTML = current && playing ? ICONS.pause : ICONS.play;
    });
  }
  function bindPlayer() {
    Player.on('track', syncTrackPlayIcons);
    Player.on('state', syncTrackPlayIcons);
    // Телефон: мини-плеер внизу — по нажатию на него (кроме кнопок) открывается полноэкранный плеер
    $('#player').addEventListener('click', (e) => {
      if (window.ZG_MOBILE && !e.target.closest('button, .slider, a, .lnk')) openNowPlaying();
    });
    seekUI = slider($('#seek'), {
      onInput: (v) => {
        const d = Player.audio.duration || Player.current?.duration || 0;
        $('#plCur').textContent = fmtTime(v * d);
        seekUI.setForce(v);
      },
      onCommit: (v) => Player.seek(v * (Player.audio.duration || 0)),
    });
    npSeekUI = slider($('#npSeek'), {
      onInput: (v) => {
        const d = Player.audio.duration || Player.current?.duration || 0;
        $('#npCur').textContent = fmtTime(v * d);
        npSeekUI.setForce(v);
      },
      onCommit: (v) => Player.seek(v * (Player.audio.duration || 0)),
    });
    // Громкость: полоска в панели плеера и такая же в полноэкранном плеере
    const volSlider = (el) => {
      const ui = slider(el, {
        onInput: (v) => {
          Player.volume = v;
          Player.muted = false;
          Player._applyVolume();
          ui.setForce(v); // во время перетаскивания set() пропускается — двигаем полоску сами
        },
        onCommit: (v) => Player.setVolume(v),
      });
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        Player.setVolume(Player.volume + (e.deltaY < 0 ? 0.05 : -0.05));
      });
      return ui;
    };
    volUI = volSlider($('#vol'));
    npVolUI = volSlider($('#npVol'));
    Views._bindWaveVolume = () => {
      const el = $('#waveVol');
      if (!el) return;
      if (!el._volUI) el._volUI = volSlider(el);
      el._volUI.setForce(Player.muted ? 0 : Player.volume);
    };
    Views._bindWaveVolume();
    Views._bindWaveSeek = () => {
      const el = $('#waveSeek');
      if (!el) return;
      if (!el._seekUI) {
        const ui = slider(el, {
          onInput: (v) => {
            const d = Player.audio.duration || Player.current?.duration || 0;
            $('#waveSeekCur').textContent = fmtTime(v * d);
            ui.setForce(v);
          },
          onCommit: (v) => Player.seek(v * (Player.audio.duration || Player.current?.duration || 0)),
        });
        el._seekUI = ui;
      }
      const d = Player.audio.duration || Player.current?.duration || 0;
      el._seekUI.setForce(d ? (Player.audio.currentTime || 0) / d : 0);
      $('#waveSeekCur').textContent = fmtTime(Player.audio.currentTime || 0);
      $('#waveSeekDur').textContent = fmtTime(d);
    };
    Views._bindWaveSeek();

    Player.on('track', (t) => {
      $('#plTitle').innerHTML = t.release ? `<span class="lnk" data-act="nav" data-view="release" data-id="${esc(t.release.id)}">${esc(t.title)}</span>` : esc(t.title);
      $('#plArtist').innerHTML = artistsLinks(t.artists);
      const c = cover(t, 200);
      $('#plCover').src = c;
      $('#npTitle').textContent = t.title;
      $('#npArtist').innerHTML = artistsLinks(t.artists);
      const meta = $('.np-meta');
      meta.classList.remove('swap');
      void meta.offsetWidth;
      meta.classList.add('swap');
      setBackground(t);
      refreshLikeButtons();
      markPlayingRows();
      App.lyrics = { trackId: null, data: null, loading: false };
      if (App.panel === 'lyrics' || App.panel === 'nova' || lyricsInNp() || Nova.wantsLyrics()) loadLyrics();
      if (App.route?.view === 'wave') Views._waveNow();
      if (npOpen()) NP.render();
      Views._vizTrack && Views._vizTrack(t);
      NP.trackChanged(t);
      Clip.trackChanged();
      ClipOffer.trackChanged(t);
    });
    Player.on('stream', updateQualityBadge);
    Player.on('state', ({ playing }) => {
      const ic = ICONS[playing ? 'pause' : 'play'];
      $('#plPlay .i').innerHTML = ic;
      $('#npPlay .i').innerHTML = ic;
      $('#plEq').style.display = playing ? 'flex' : 'none';
      const vp = $('#vizPlay .i');
      if (vp) vp.innerHTML = ic;
      const orb = $('#waveOrb');
      if (orb) {
        const wavePlaying = playing && Player.source?.kind === 'wave';
        orb.classList.toggle('playing', wavePlaying);
        orb.querySelector(':scope > .i').innerHTML = ICONS[wavePlaying ? 'pause' : 'play'];
      }
      syncWaveTransport();
    });
    Player.on('time', ({ cur, dur, buf }) => {
      const v = dur ? cur / dur : 0;
      seekUI.set(v, buf);
      $('#plCur').textContent = fmtTime(cur);
      $('#plDur').textContent = fmtTime(dur);
      const waveSeek = $('#waveSeek');
      if (waveSeek?._seekUI) {
        waveSeek._seekUI.set(v, buf);
        $('#waveSeekCur').textContent = fmtTime(cur);
        $('#waveSeekDur').textContent = fmtTime(dur);
      }
      if (npOpen()) {
        npSeekUI.set(v, buf);
        $('#npCur').textContent = fmtTime(cur);
        $('#npDur').textContent = fmtTime(dur);
      }
      syncLyrics(cur);
    });
    Player.on('queue', debounce(() => {
      if (App.panel === 'queue') renderQueue();
      if (App.route?.view === 'wave') Views._waveNow();
      if (npOpen()) NP.render();
    }, 60));
    Player.on('modes', renderModes);
    Player.on('volume', ({ volume, muted }) => {
      const v = muted ? 0 : volume;
      volUI.setForce(v);
      npVolUI.setForce(v);
      const ic = ICONS[muted || volume === 0 ? 'vol0' : volume < 0.5 ? 'vol1' : 'vol2'];
      $('#plVolBtn .i').innerHTML = ic;
      $('#npVolBtn .i').innerHTML = ic;
      $('#npVolVal').textContent = Math.round(v * 100) + '%';
      Views._bindWaveVolume?.();
      $('#waveVol')?._volUI?.setForce(v);
      const waveVolIcon = $('#waveVolBtn .i');
      if (waveVolIcon) waveVolIcon.innerHTML = ic;
      const waveVolVal = $('#waveVolVal');
      if (waveVolVal) waveVolVal.textContent = Math.round(v * 100) + '%';
    });
    Player.on('empty', () => startMyWave());
    Player.on('loading', (on) => document.body.classList.toggle('loading', on));
    // Кнопки на миниатюре (Windows), в уведомлении, на экране блокировки и гарнитуре (Android)
    window.zvuk.player.onCommand((cmd) => {
      cmd = String(cmd || '');
      if (cmd === 'toggle') Player.toggle();
      else if (cmd === 'next') Player.next();
      else if (cmd === 'prev') Player.prev();
      else if (cmd === 'play') !Player.playing && Player.toggle();
      else if (cmd === 'pause') Player.playing && Player.toggle();
      else if (cmd.startsWith('seek:')) Player.seek(parseFloat(cmd.slice(5)) || 0);
    });
    // Свёрнутое окно ничего не рисует: визуализатор, клип, видео-обои и анимации встают, музыка играет
    window.zvuk.onHidden((hidden) => {
      document.body.classList.toggle('win-hidden', hidden);
      Viz.setHidden(hidden);
      waveOrbitHandle?.setHidden(hidden);
      Clip.hidden = hidden;
      const vid = $('#bgVideo');
      if (vid && vid.getAttribute('src')) hidden ? vid.pause() : vid.play().catch(() => {});
    });
    renderModes();
    Player._applyVolume();
  }

  // ---------- Значок качества (кликабельный) ----------
  const Q_LABEL = { flac: 'FLAC', high: '320', mid: '128' };
  const Q_NAME = { flac: 'FLAC — без потерь', high: 'MP3 320 кбит/с', mid: 'MP3 128 кбит/с' };
  function updateQualityBadge() {
    const b = $('#plQuality');
    const s = Player.stream;
    b.classList.toggle('preview', Boolean(s && s.preview));
    if (s && s.preview) {
      b.textContent = 'ПРЕВЬЮ';
      b.title = 'Доступен только фрагмент трека · нажмите, чтобы выбрать качество';
    } else {
      const q = s ? s.quality : Player.quality;
      b.textContent = Q_LABEL[q] || 'FLAC';
      b.title = `${Q_NAME[q]}${s && s.quality !== Player.quality ? ` (выбрано: ${Q_NAME[Player.quality]}, у трека нет)` : ''} · нажмите, чтобы сменить`;
    }
  }
  function setQuality(q) {
    Player.setQuality(q);
    App.settings.quality = q;
    window.zvuk.settings.set({ quality: q });
    $$('[data-act="quality"]').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
    updateQualityBadge();
    toast('Качество: ' + Q_NAME[q], { iconName: 'check', ms: 1500 });
  }
  function qualityMenu(el) {
    const r = el.getBoundingClientRect();
    const t = Player.current;
    const items = ['flac', 'high', 'mid'].map((q) => ({
      label: Q_NAME[q],
      icon: q === 'flac' ? 'flac' : 'note',
      onClick: () => setQuality(q),
    }));
    openMenu(r.left - 120, r.top - 8 - 44 * 3 - 70, [
      { header: `<div class="t"><div>Качество звука</div><div class="s">${t ? (t.hasFlac ? 'У трека есть FLAC' : 'У трека нет FLAC — будет 320') : 'Для следующих треков'}</div></div>` },
      ...items,
    ]);
    // отметить выбранное
    $$('.ctx .mi').forEach((m, i) => {
      if (['flac', 'high', 'mid'][i] === Player.quality) m.insertAdjacentHTML('beforeend', icon('check', 'chk'));
    });
  }

  function renderModes() {
    for (const id of ['#plShuffle', '#npShuffle']) $(id).classList.toggle('on', Player.shuffle);
    for (const id of ['#plRepeat', '#npRepeat']) {
      $(id).classList.toggle('on', Player.repeat !== 'off');
      $(id).querySelector('.i').innerHTML = ICONS[Player.repeat === 'one' ? 'repeatOne' : 'repeat'];
      $(id).title = Player.repeat === 'off' ? 'Повтор выключен' : Player.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека';
    }
  }

  function markPlayingRows() {
    const id = Player.current ? String(Player.current.id) : null;
    $$('.tr').forEach((r) => r.classList.toggle('playing', r.dataset.track === id));
    $$('.qi').forEach((r) => r.classList.toggle('cur', +r.dataset.qi === Player.index));
  }

  // ======================================================================
  // Правая панель: очередь и текст
  // ======================================================================
  function openPanel(name) {
    if (App.panel === name) return closePanel();
    App.panel = name;
    $('#sidePanel').classList.add('open');
    $$('#spSeg button').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
    $('#plQueueBtn').classList.toggle('on', name === 'queue');
    $('#plLyricsBtn').classList.toggle('on', name === 'lyrics');
    $('#plNovaBtn').classList.toggle('on', name === 'nova');
    if (name === 'queue') renderQueue();
    else if (name === 'nova') {
      Nova.mount($('#spBody'));
      loadLyrics();
    } else {
      renderLyricsInto($('#spBody'));
      loadLyrics();
    }
    Nova.render();
  }
  function closePanel() {
    App.panel = null;
    $('#sidePanel').classList.remove('open');
    $('#plQueueBtn').classList.remove('on');
    $('#plLyricsBtn').classList.remove('on');
    $('#plNovaBtn').classList.remove('on');
    Nova.render();
  }
  // для мобильного модуля (жесты и системная кнопка «Назад»): mobile.js
  Object.assign(App, {
    openPanel: (n) => openPanel(n),
    closePanel: () => closePanel(),
    openNowPlaying: () => openNowPlaying(),
    closeNowPlaying: () => closeNowPlaying(),
    goBack: () => goBack(),
    hideSuggest: () => hideSuggest(),
    loadLyrics: () => loadLyrics(),
    /** Меню трека у строки списка — для долгого нажатия пальцем. */
    rowMenu(row, x, y) {
      const l = UI.Lists.get(row.dataset.list);
      trackMenu(trackFromRow(row), x, y, { playlistId: l?.source?.playlistId, queueIdx: row.dataset.queueIdx != null ? +row.dataset.queueIdx : null });
    },
  });

  function renderQueue() {
    const body = $('#spBody');
    if (!Player.queue.length) {
      body.innerHTML = `<div class="empty">${icon('queue')}<div>Очередь пуста</div><button class="btn primary" data-act="wave-toggle">${icon('wave')}Включить «Музыкальную орбиту»</button></div>`;
      return;
    }
    const row = (t, i) => `<div class="qi${i === Player.index ? ' cur' : i < Player.index ? ' past' : ''}" data-qi="${i}" data-act="queue-play">
      <img loading="lazy" decoding="async" src="${esc(cover(t, 96))}" alt=""><div class="qt"><div class="q1">${esc(t.title)}</div><div class="q2">${esc(artistsText(t.artists))}</div></div>
      ${i !== Player.index ? `<button class="icon-btn" data-act="queue-remove" title="Убрать">${icon('close')}</button>` : ''}</div>`;
    const from = Math.max(0, Player.index - 3);
    const prev = Player.queue.slice(from, Player.index);
    const cur = Player.current;
    const next = Player.queue.slice(Player.index + 1, Player.index + 151);
    body.innerHTML = `
      ${prev.length ? `<div class="sp-head">Ранее</div>${prev.map((t, k) => row(t, from + k)).join('')}` : ''}
      <div class="sp-head">Сейчас играет${Player.source?.title ? ' · ' + esc(Player.source.title) : ''}</div>${cur ? row(cur, Player.index) : ''}
      ${next.length ? `<div class="sp-head" style="display:flex;justify-content:space-between;align-items:center">Далее${Player.endless ? '' : `<button class="more" data-act="queue-clear" style="text-transform:none;letter-spacing:0;font-weight:600">Очистить</button>`}</div>${next.map((t, k) => row(t, Player.index + 1 + k)).join('')}` : ''}
      ${Player.endless ? `<div class="muted small" style="padding:10px 12px">${icon('sparkle')} Новые треки подбираются автоматически</div>` : ''}`;
    const curEl = body.querySelector('.qi.cur');
    if (curEl) curEl.scrollIntoView({ block: 'center' });
  }

  async function loadLyrics() {
    const t = Player.current;
    if (!t) return renderLyricsAll();
    if (App.lyrics.trackId === t.id && (App.lyrics.data || App.lyrics.loading)) return;
    const offset = lyrOffset(t.id);
    App.lyrics = { trackId: t.id, data: null, loading: true, source: 'zvuk', offset };
    renderLyricsAll();
    let data = null;
    let source = 'zvuk';
    try {
      data = parseLyrics(await api('getLyrics', t.id));
    } catch {}
    if (App.lyrics.trackId !== t.id) return;
    // В Zvuk текста нет или он без времени строк — ищем синхронизированный в открытой базе LRCLIB
    if ((!data || !data.synced) && App.settings.lyrics?.external !== false) {
      // пока ищем, обычный текст из Zvuk уже виден
      App.lyrics = { trackId: t.id, data, loading: !data, searching: true, source, offset };
      lastLine = -2;
      renderLyricsAll();
      const ext = await window.zvuk.lyrics.external(t);
      if (App.lyrics.trackId !== t.id) return;
      const parsed = ext && ext.text ? parseLyrics({ text: ext.text }) : null;
      if (parsed && (parsed.synced || !data)) {
        data = parsed;
        source = 'lrclib';
      }
    }
    App.lyrics = { trackId: t.id, data: data || 'none', loading: false, source, offset };
    lastLine = -2;
    renderLyricsAll();
  }
  // Сдвиг времени текста для трека (если строки спешат или отстают): хранится на этом компьютере
  function lyrOffset(id) {
    try {
      return parseFloat(localStorage.getItem('zg.lyrOff.' + id)) || 0;
    } catch {
      return 0;
    }
  }
  function nudgeLyrics(d) {
    const L = App.lyrics;
    if (!L.trackId) return;
    L.offset = Math.round(((L.offset || 0) + d) * 100) / 100;
    if (Math.abs(L.offset) > 30) L.offset = Math.sign(L.offset) * 30;
    try {
      if (L.offset) localStorage.setItem('zg.lyrOff.' + L.trackId, String(L.offset));
      else localStorage.removeItem('zg.lyrOff.' + L.trackId);
    } catch {}
    for (const v of $$('.lyr-off b')) v.textContent = fmtOff(L.offset);
    lastLine = -2;
    syncLyrics(Player.audio.currentTime);
  }
  const fmtOff = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v || 0).toFixed(2).replace('.', ',') + ' с';
  /** Подпись источника над текстом из LRCLIB и подстройка времени строк. */
  function lyrSource(L) {
    if (L.source !== 'lrclib' || !L.data || L.data === 'none') return '';
    const sync = L.data.synced
      ? `<div class="lyr-off" title="Если строки спешат или отстают от песни"><button data-act="lyr-off" data-d="-0.25" title="Показывать строки раньше на 0,25 с">−</button><b>${fmtOff(L.offset)}</b><button data-act="lyr-off" data-d="0.25" title="Показывать строки позже на 0,25 с">+</button></div>`
      : '';
    return `<div class="lyr-src">${icon('globe')}<span>${L.data.synced ? 'Текст из LRCLIB' : 'Текст из LRCLIB · без привязки ко времени'}</span>${sync}</div>`;
  }
  function renderLyricsAll() {
    if (App.panel === 'lyrics') renderLyricsInto($('#spBody'));
    if (lyricsInNp()) renderLyricsInto($('#npLyrics'));
    if (App.panel === 'nova') syncLyrics(Player.audio.currentTime);
    const L = App.lyrics || {};
    document.dispatchEvent(new CustomEvent('zg:lyrics-state', { detail: {
      trackId: L.trackId, loading: Boolean(L.loading), searching: Boolean(L.searching), source: L.source,
      synced: Boolean(L.data && L.data !== 'none' && L.data.synced), none: L.data === 'none',
    } }));
  }
  function renderLyricsInto(el) {
    const L = App.lyrics;
    // в полноэкранном плеере подпись источника стоит над текстом, вне зоны затухания
    const inNp = el.id === 'npLyrics';
    const src = Player.current && L.data ? lyrSource(L) : '';
    if (inNp) $('#npLyrSrc').innerHTML = src;
    const head = inNp ? '' : src;
    if (!Player.current) el.innerHTML = `<div class="empty">${icon('lyrics')}<div>Включите трек, чтобы увидеть текст</div></div>`;
    else if (L.loading || !L.data) el.innerHTML = `<div class="empty">${icon('lyrics')}<div>${L.searching ? 'В Zvuk текста нет — ищем в LRCLIB…' : 'Загружаем текст…'}</div></div>`;
    else if (L.data === 'none') el.innerHTML = `<div class="empty">${icon('lyrics')}<div>Для этого трека нет текста</div></div>`;
    else if (L.data.synced)
      el.innerHTML = `${head}<div class="lyrics">${L.data.lines.map((l, i) => `<div class="ln" data-act="lyric-seek" data-t="${l.t}" data-li="${i}">${esc(l.text || '♪')}</div>`).join('')}</div>`;
    else el.innerHTML = `${head}<div class="lyrics plain">${esc(L.data.text)}</div>`;
    lastLine = -2;
    syncLyrics(Player.audio.currentTime);
  }
  let lastLine = -2;
  let lastNovaLineKey = '';
  let userScrollAt = 0;
  ['#spBody', '#npLyrics'].forEach((s) => $(s).addEventListener('wheel', () => (userScrollAt = Date.now()), { passive: true }));
  function syncLyrics(cur) {
    const L = App.lyrics.data;
    if (!L || L === 'none' || !L.synced) return;
    if (App.panel !== 'lyrics' && App.panel !== 'nova' && !lyricsInNp() && !Nova.wantsLyrics()) return;
    cur -= App.lyrics.offset || 0; // сдвиг: строки показываются позже (+) или раньше (−)
    let idx = -1;
    let lo = 0, hi = L.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L.lines[mid].t <= cur + 0.25) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx === lastLine) return;
    lastLine = idx;
    for (const root of [$('#spBody'), $('#npLyrics')]) {
      const lines = root.querySelectorAll('.lyrics .ln');
      if (!lines.length) continue;
      lines.forEach((el, i) => {
        el.classList.toggle('cur', i === idx);
        el.classList.toggle('past', i < idx);
      });
      if (idx >= 0 && Date.now() - userScrollAt > 3500) {
        const el = lines[idx];
        const box = root;
        const target = el.offsetTop - box.clientHeight * 0.38;
        box.scrollTo({ top: target, behavior: 'smooth' });
      }
    }
    const novaLineKey = `${App.lyrics.trackId}|${idx}`;
    if (novaLineKey === lastNovaLineKey) return;
    lastNovaLineKey = novaLineKey;
    document.dispatchEvent(new CustomEvent('zg:lyrics-line', { detail: {
      trackId: App.lyrics.trackId, index: idx, line: idx >= 0 ? L.lines[idx] : null,
      previous: idx > 0 ? L.lines[idx - 1] : null, next: idx >= 0 ? L.lines[idx + 1] || null : L.lines[0] || null,
      time: cur,
    } }));
  }

  // ======================================================================
  // Полноэкранный плеер
  // ======================================================================
  function npOpen() {
    return NP.isOpen;
  }
  function lyricsInNp() {
    return NP.isOpen && NP.lyricsOn;
  }
  function openNowPlaying() {
    if (!Player.current) return toast('Сначала включите трек');
    NP.open();
    if (NP.lyricsOn) {
      renderLyricsInto($('#npLyrics'));
      loadLyrics();
    }
    const a = Player.audio;
    const d = a.duration || Player.current?.duration || 0;
    npSeekUI.setForce(d ? a.currentTime / d : 0);
    $('#npCur').textContent = fmtTime(a.currentTime);
    $('#npDur').textContent = fmtTime(d);
  }
  function closeNowPlaying() {
    NP.close();
  }
  function toggleNpLyrics() {
    if (NP.toggleLyrics()) {
      renderLyricsInto($('#npLyrics'));
      loadLyrics();
    }
  }

  // ======================================================================
  // Меню трека
  // ======================================================================
  function trackFromRow(row) {
    if (row.dataset.queueIdx != null) return Player.queue[+row.dataset.queueIdx];
    const l = UI.Lists.get(row.dataset.list);
    return l ? l.tracks[+row.dataset.idx] : null;
  }

  function trackMenu(t, x, y, ctx = {}) {
    if (!t) return;
    const liked = App.likes.track.has(String(t.id));
    const own = App.playlists.filter((p) => App.isOwnPlaylist(p));
    const items = [
      { header: `<img src="${esc(cover(t, 96))}" alt=""><div class="t"><div>${esc(t.title)}</div><div class="s">${esc(artistsText(t.artists))}</div></div>` },
      { label: 'Играть следующим', icon: 'playNext', onClick: () => (Player.playNext(t), toast('Будет играть следующим', { iconName: 'playNext', ms: 1500 })) },
      { label: 'Добавить в очередь', icon: 'addQueue', onClick: () => (Player.addToQueue(t), toast('Добавлено в очередь', { iconName: 'addQueue', ms: 1500 })) },
      {
        label: 'Добавить в плейлист',
        icon: 'addList',
        sub: () => [
          { label: 'Новый плейлист', icon: 'plus', onClick: () => createPlaylist([t.id]) },
          ...(own.length ? [{ sep: true }] : []),
          ...own.map((p) => ({ label: p.title, icon: 'playlist', onClick: () => addToPlaylist(p, [t]) })),
        ],
      },
      { sep: true },
      { label: liked ? 'Убрать из любимых' : 'Нравится', icon: liked ? 'heartFill' : 'heart', onClick: () => App.toggleLike('track', t.id) },
      { label: 'Радио по треку', icon: 'radio', onClick: () => startRadio('TRACK', t.id, t.title) },
      ...(t.artists || []).slice(0, 3).map((a) => ({ label: `К исполнителю: ${a.title}`, icon: 'mic', onClick: () => navigate('artist', { id: a.id }) })),
      ...(t.release ? [{ label: 'Перейти к альбому', icon: 'album', onClick: () => navigate('release', { id: t.release.id }) }] : []),
      { label: 'Скопировать ссылку', icon: 'link', onClick: () => copyLink(`https://zvuk.com/track/${t.id}`) },
    ];
    if (ctx.playlistId) items.push({ sep: true }, { label: 'Удалить из плейлиста', icon: 'trash', danger: true, onClick: () => removeFromPlaylist(ctx.playlistId, t) });
    if (ctx.queueIdx != null && ctx.queueIdx !== Player.index) items.push({ sep: true }, { label: 'Убрать из очереди', icon: 'close', onClick: () => Player.removeAt(ctx.queueIdx) });
    openMenu(x, y, items);
  }

  // ======================================================================
  // Делегирование кликов
  // ======================================================================
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const d = el.dataset;
    switch (act) {
      case 'nav':
        e.stopPropagation();
        if (el.classList.contains('nav-item')) navTapEffect(el, e);
        if (d.view === 'search') showRecentTop();
        else hideRecentTop();
        if (d.view === 'search' && App.route?.view !== 'search') navigate('search', { q: $('#searchInput').value.trim() });
        else if (d.view !== 'search') navigate(d.view, d.id ? { id: d.id } : {});
        else $('#searchInput').focus();
        closeNowPlayingIfNav(el);
        break;
      case 'open':
        if (e.target.closest('[data-act="play-entity"]')) return;
        if (d.kind === 'wave') return startEditorialWave(d.id);
        if (d.kind === 'new-playlist') return createPlaylist();
        navigate(d.kind, { id: d.id });
        break;
      case 'play-entity':
        e.stopPropagation();
        playEntity(d.kind, d.id);
        break;
      case 'play-row': {
        e.stopPropagation();
        const row = el.closest('[data-list]') || el;
        if (row.dataset.queueIdx != null) { Player.playAt(+row.dataset.queueIdx); syncTrackPlayIcons(true); return; }
        const l = UI.Lists.get(row.dataset.list);
        if (l) { Player.playList(l.tracks, +row.dataset.idx, l.source || { kind: 'list', title: '' }); syncTrackPlayIcons(true); }
        break;
      }
      case 'play-list-all':
      case 'shuffle-list': {
        const l = UI.Lists.get(d.list);
        if (!l || !l.tracks.length) return;
        if (act === 'shuffle-list' && !Player.shuffle) Player.toggleShuffle();
        if (act === 'play-list-all' && Player.shuffle) Player.toggleShuffle();
        Player.playList(l.tracks, act === 'shuffle-list' ? Math.floor(Math.random() * l.tracks.length) : 0, l.source);
        break;
      }
      case 'like':
        e.stopPropagation();
        App.toggleLike(d.type, d.id);
        break;
      case 'like-current':
        if (Player.current) App.toggleLike('track', Player.current.id);
        break;
      case 'track-menu': {
        e.stopPropagation();
        const row = el.closest('.tr');
        const r = el.getBoundingClientRect();
        const l = UI.Lists.get(row.dataset.list);
        trackMenu(trackFromRow(row), r.left - 200, r.bottom + 4, { playlistId: l?.source?.playlistId, queueIdx: row.dataset.queueIdx != null ? +row.dataset.queueIdx : null });
        break;
      }
      case 'current-menu': {
        const r = el.getBoundingClientRect();
        // (ниже — меню текущего трека)
        trackMenu(Player.current, r.left, r.top - 380);
        break;
      }
      case 'entity-menu': {
        const r = el.getBoundingClientRect();
        if (d.kind === 'playlist') {
          const p = App.playlists.find((x) => String(x.id) === String(d.id)) || (await api('getPlaylist', d.id));
          openMenu(r.left, r.bottom + 6, await playlistMenuActions(p));
        } else if (d.kind === 'release') {
          const rel = await api('getRelease', d.id);
          const own = App.playlists.filter((p) => App.isOwnPlaylist(p));
          openMenu(r.left, r.bottom + 6, [
            { label: 'Добавить в очередь', icon: 'addQueue', onClick: () => Player.addToQueue(rel.tracks.map((t) => ({ ...t, release: t.release || { id: rel.id, title: rel.title, image: rel.image } }))) },
            { label: 'Добавить в плейлист', icon: 'addList', sub: () => [{ label: 'Новый плейлист', icon: 'plus', onClick: () => createPlaylist(rel.tracks.map((t) => t.id)) }, ...(own.length ? [{ sep: true }] : []), ...own.map((p) => ({ label: p.title, icon: 'playlist', onClick: () => addToPlaylist(p, rel.tracks) }))] },
            { label: 'Скопировать ссылку', icon: 'link', onClick: () => copyLink(`https://zvuk.com/release/${rel.id}`) },
          ]);
        }
        break;
      }
      case 'toggle':
        Player.toggle();
        break;
      case 'next':
        Player.next();
        break;
      case 'prev':
        Player.prev();
        break;
      case 'shuffle':
        Player.toggleShuffle();
        break;
      case 'repeat':
        Player.cycleRepeat();
        break;
      case 'mute':
        Player.toggleMute();
        break;
      case 'panel':
        openPanel(d.panel);
        break;
      case 'panel-close':
        closePanel();
        break;
      case 'queue-play':
        if (e.target.closest('[data-act="queue-remove"]')) return;
        Player.playAt(+el.dataset.qi);
        break;
      case 'queue-remove':
        e.stopPropagation();
        Player.removeAt(+el.closest('.qi').dataset.qi);
        break;
      case 'queue-clear':
        Player.clearUpcoming();
        break;
      case 'lyric-seek':
        Player.seek(+d.t + (App.lyrics.offset || 0));
        userScrollAt = 0;
        break;
      case 'lyr-off':
        nudgeLyrics(+d.d);
        break;
      case 'lyrics-ext': {
        const on = !(App.settings.lyrics?.external !== false);
        App.settings.lyrics = { ...(App.settings.lyrics || {}), external: on };
        window.zvuk.settings.set({ lyrics: App.settings.lyrics });
        el.classList.toggle('on', on);
        // текущий трек перечитаем с новым режимом
        App.lyrics = { trackId: null, data: null, loading: false };
        if (App.panel === 'lyrics' || lyricsInNp()) loadLyrics();
        break;
      }
      case 'nowplaying':
        openNowPlaying();
        break;
      case 'nowplaying-close':
        closeNowPlaying();
        break;
      case 'np-lyrics':
        toggleNpLyrics();
        break;
      case 'np-viz':
        NP.toggleViz();
        break;
      case 'np-eq':
        NP.toggleEq();
        break;
      case 'toggle-compact':
        toggleCompact();
        break;
      case 'quality-menu':
        e.stopPropagation();
        qualityMenu(el);
        break;
      case 'wave-toggle':
        if (Player.source?.kind === 'wave' && Player.current) Player.toggle();
        else startMyWave();
        break;
      case 'wave-focus':
        setWaveFocus(!document.body.classList.contains('wave-focus'));
        break;
      case 'wave-set': {
        const w = { ...(App.settings.wave || {}) };
        w[d.key] = d.val;
        await saveWave(w, true);
        break;
      }
      case 'wave-genre': {
        const w = { ...(App.settings.wave || {}) };
        let g = new Set(w.genres || []);
        if (d.val === '__clear') g = new Set();
        else g.has(d.val) ? g.delete(d.val) : g.add(d.val);
        w.genres = [...g];
        await saveWave(w, false);
        break;
      }
      case 'radio':
        startRadio(d.type, d.id, d.title);
        break;
      case 'create-playlist':
        createPlaylist();
        break;
      case 'sec-toggle':
        e.stopPropagation();
        toggleSection(d.sec);
        break;
      case 'search':
        input.value = d.q;
        doSearch(d.q);
        break;
      case 'clear-searches':
        localStorage.removeItem('zg.searches');
        hideRecentTop();
        render(true);
        break;
      case 'expand-tracks': {
        const box = $('#searchTracks');
        if (box) box.style.maxHeight = 'none';
        el.remove();
        break;
      }
      case 'expand-pop':
        Views.popMore(el);
        break;
      case 'collapse-pop':
        Views.popMore(el, true);
        break;
      case 'top-toggle':
        Views.topToggle(el);
        break;
      case 'shelf-scroll': {
        const sh = el.closest('.section').querySelector('.shelf');
        sh.scrollBy({ left: +d.dir * sh.clientWidth * 0.85 });
        break;
      }
      case 'reload-view':
        api.invalidate('');
        render(true);
        break;
      case 'back':
        goBack();
        break;
      case 'forward':
        goForward();
        break;
      case 'quality':
        setQuality(d.q);
        break;
      case 'performance-mode': {
        setPerformanceMode(d.mode);
        $$('[data-act="performance-mode"]').forEach((button) => {
          const on = button.dataset.mode === App.settings.performanceMode;
          button.classList.toggle('on', on);
          button.setAttribute('aria-pressed', String(on));
        });
        const note = $('#perfModeNote');
        if (note) note.textContent = {
          auto: 'Полное качество, разрешение и частота дисплея. Приложение само прекращает невидимую и ненужную работу без ограничения FPS.',
          full: 'Все видимые эффекты и анимации активны. Полное разрешение, материалы и максимальная частота дисплея.',
          eco: 'Только декоративный фон становится статичным. Разрешение, материалы и частота кадров не снижаются.',
        }[App.settings.performanceMode];
        break;
      }
      case 'toggle-liquid':
        App.settings.liquidGlass = !App.settings.liquidGlass;
        document.body.classList.toggle('liquid-on', App.settings.liquidGlass);
        el.classList.toggle('on', App.settings.liquidGlass);
        window.zvuk.settings.set({ liquidGlass: App.settings.liquidGlass });
        break;
      case 'logout': {
        const ok = await modal({ title: 'Выйти из аккаунта?', text: 'Токен будет удалён с этого компьютера.', okText: 'Выйти', danger: true });
        if (!ok) return;
        Player.pause();
        await window.zvuk.auth.logout();
        App.likes = { track: new Set(), release: new Set(), artist: new Set(), playlist: new Set() };
        App.playlists = [];
        localStorage.removeItem('zg.queue.v1');
        showLogin();
        break;
      }
      case 'open-zvuk':
        window.zvuk.openZvuk(d.url);
        break;
      case 'paste-token':
        loginWithText(await window.zvuk.readClipboard());
        break;
    }
  });

  /** Нажатие на пункт меню: «пружинящая» иконка и волна света от точки клика. */
  function navTapEffect(el, e) {
    el.classList.remove('tap');
    void el.offsetWidth;
    el.classList.add('tap');
    setTimeout(() => el.classList.remove('tap'), 520);
    const r = el.getBoundingClientRect();
    const rip = document.createElement('span');
    rip.className = 'rip';
    rip.style.left = (e.clientX || r.left + r.width / 2) - r.left + 'px';
    rip.style.top = (e.clientY || r.top + r.height / 2) - r.top + 'px';
    el.appendChild(rip);
    setTimeout(() => rip.remove(), 700);
  }

  function closeNowPlayingIfNav(el) {
    if (npOpen() && el.closest('#nowPlaying')) closeNowPlaying();
  }

  async function saveWave(w, restart) {
    App.settings.wave = w;
    window.zvuk.settings.set({ wave: w });
    // Обновляем отмеченные варианты без перерисовки страницы
    $$('[data-act="wave-set"]').forEach((b) => b.classList.toggle('on', (w[b.dataset.key] || 'any') === b.dataset.val));
    $$('[data-act="wave-genre"]').forEach((b) => b.dataset.val !== '__clear' && b.classList.toggle('on', (w.genres || []).includes(b.dataset.val)));
    const clr = $('#genreClear');
    if (clr) clr.classList.toggle('hidden', !(w.genres || []).length);
    const sum = $('#waveSummary');
    if (sum) sum.textContent = UI.waveSummary(w);
    Views._waveTune?.(w);
    if (restart || Player.source?.kind === 'wave') {
      clearTimeout(saveWave.t);
      saveWave.t = setTimeout(startMyWave, restart ? 0 : 700);
    }
  }

  // Двойной клик по строке — воспроизвести; одиночный — выделить
  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tr');
    if (!row || e.target.closest('button, .lnk')) return;
    if (row.dataset.queueIdx != null) return Player.playAt(+row.dataset.queueIdx);
    const l = UI.Lists.get(row.dataset.list);
    if (l) Player.playList(l.tracks, +row.dataset.idx, l.source || { kind: 'list', title: '' });
  });
  document.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.tr');
    $$('.tr.sel').forEach((r) => r !== row && r.classList.remove('sel'));
    if (row) row.classList.add('sel');
  });
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tr');
    const qi = e.target.closest('.qi');
    if (row) {
      e.preventDefault();
      const l = UI.Lists.get(row.dataset.list);
      trackMenu(trackFromRow(row), e.clientX, e.clientY, { playlistId: l?.source?.playlistId, queueIdx: row.dataset.queueIdx != null ? +row.dataset.queueIdx : null });
    } else if (qi) {
      e.preventDefault();
      trackMenu(Player.queue[+qi.dataset.qi], e.clientX, e.clientY, { queueIdx: +qi.dataset.qi });
    } else if (e.target.closest('.card[data-kind="playlist"], .sp-item')) {
      e.preventDefault();
      const id = e.target.closest('[data-id]').dataset.id;
      const p = App.playlists.find((x) => String(x.id) === String(id));
      if (p) playlistMenuActions(p).then((items) => openMenu(e.clientX, e.clientY, items));
    } else if (!e.target.closest('input')) e.preventDefault();
  });
  // Кнопки «назад/вперёд» на мыши
  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) goBack();
    if (e.button === 4) goForward();
  });

  // ======================================================================
  // Поиск с подсказками
  // ======================================================================
  const input = $('#searchInput');
  const sugg = $('#suggest');
  let suggItems = [];
  let suggIdx = -1;
  let suggSeq = 0;
  const recentTop = $('#recentTop');
  const recentTopList = $('#recentTopList');

  App.recentSearches = () => {
    try {
      const list = JSON.parse(localStorage.getItem('zg.searches') || '[]');
      return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 12) : [];
    } catch {
      return [];
    }
  };
  function fillRecentTop() {
    const list = App.recentSearches().slice(0, 6);
    recentTopList.innerHTML = list
      .map((q) => `<button class="recent-query" data-act="search" data-q="${esc(q)}" title="${esc(q)}">${icon('clock')}<span>${esc(q)}</span></button>`)
      .join('');
    hydrateIcons(recentTopList);
    return list.length;
  }
  function fitRecentTop() {
    if (recentTop.classList.contains('hidden')) return;
    const items = $$('.recent-query', recentTopList);
    items.forEach((b) => {
      b.classList.remove('hidden');
      b.style.maxWidth = '';
    });
    // Показываем целые кнопки: обрезанный наполовину запрос выглядит как ошибка вёрстки.
    for (let i = items.length - 1; i > 0 && recentTopList.scrollWidth > recentTopList.clientWidth + 1; i--) items[i].classList.add('hidden');
    if (items[0] && recentTopList.scrollWidth > recentTopList.clientWidth + 1) items[0].style.maxWidth = Math.max(48, recentTopList.clientWidth) + 'px';
    recentTop.classList.toggle('has-more', items.some((b) => b.classList.contains('hidden')));
  }
  let recentFitFrame = 0;
  function queueRecentFit() {
    if (recentFitFrame || recentTop.classList.contains('hidden')) return;
    recentFitFrame = requestAnimationFrame(() => {
      recentFitFrame = 0;
      fitRecentTop();
    });
  }
  function showRecentTop() {
    if (!fillRecentTop()) return hideRecentTop();
    recentTop.classList.remove('hidden');
    fitRecentTop();
    queueRecentFit();
  }
  function hideRecentTop() {
    recentTop.classList.add('hidden');
    recentTop.classList.remove('has-more');
  }
  // Плавное изменение ширины поиска меняет место для запросов на каждом кадре.
  // Observer живёт постоянно, но пересчёт шести кнопок происходит только при реальном resize видимой ленты.
  const recentSizeObserver = new ResizeObserver(queueRecentFit);
  recentSizeObserver.observe(recentTopList);
  window.addEventListener('resize', queueRecentFit);
  recentTop.addEventListener('mousedown', (e) => {
    // Не отдаём фокус до клика по запросу — иначе лента успевает скрыться.
    if (e.target.closest('.recent-query')) e.preventDefault();
  });
  recentTop.addEventListener('focusout', () =>
    setTimeout(() => {
      if (document.activeElement !== input && !recentTop.contains(document.activeElement)) hideRecentTop();
    }, 150),
  );
  recentTop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const items = $$('.recent-query:not(.hidden)', recentTopList);
    const at = items.indexOf(document.activeElement);
    if (!items.length) return;
    e.preventDefault();
    items[(at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  });

  function rememberSearch(q) {
    if (!q) return;
    const list = App.recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    localStorage.setItem('zg.searches', JSON.stringify(list.slice(0, 12)));
    if (!recentTop.classList.contains('hidden')) {
      fillRecentTop();
      fitRecentTop();
    }
  }
  function doSearch(q) {
    q = q.trim();
    hideSuggest();
    if (!q) {
      navigate('search', {});
      showRecentTop();
      return;
    }
    hideRecentTop();
    rememberSearch(q);
    if (App.route?.view === 'search') {
      App.route.params = { q };
      render();
    } else navigate('search', { q });
  }

  const liveSearch = debounce(() => {
    const q = input.value.trim();
    if (App.route?.view === 'search' && q !== (App.route.params.q || '')) {
      App.route.params = { q };
      render(true);
    }
  }, 450);

  // Подсказки живут на уровне окна (иначе их перекрывает основная панель) — ставим под строкой поиска
  function placeSuggest() {
    const r = $('#searchPill').getBoundingClientRect();
    sugg.style.left = r.left + 'px';
    sugg.style.top = r.bottom + 8 + 'px';
    sugg.style.width = Math.max(r.width, 380) + 'px';
  }
  window.addEventListener('resize', () => !sugg.classList.contains('hidden') && placeSuggest());

  const loadSuggest = debounce(async () => {
    const q = input.value.trim();
    const seq = ++suggSeq;
    if (q.length < 2 || document.activeElement !== input) return hideSuggest();
    const [ac, qs] = await Promise.allSettled([api('autocomplete', q), api('quickSearch', q, 7)]);
    if (seq !== suggSeq || document.activeElement !== input) return;
    const queries = (ac.value || []).filter((x) => x.toLowerCase() !== q.toLowerCase()).slice(0, 3);
    const ents = qs.value || [];
    suggItems = [...queries.map((x) => ({ type: 'q', q: x })), ...ents.map((x) => ({ type: 'e', x }))];
    suggIdx = -1;
    if (!suggItems.length) return hideSuggest();
    const typeName = { Track: 'Трек', Artist: 'Исполнитель', Release: 'Альбом', Playlist: 'Плейлист' };
    sugg.innerHTML = suggItems
      .map((it, i) => {
        if (it.type === 'q') return `<div class="sg-q" data-si="${i}">${icon('search')}<span>${esc(it.q)}</span></div>`;
        const x = it.x;
        const sub = x.__typename === 'Track' ? artistsText(x.artists) : x.__typename === 'Release' ? artistsText(x.artists) : '';
        return `<div class="sg-item" data-si="${i}"><img class="${x.__typename === 'Artist' ? 'round' : ''}" src="${esc(cover(x, 96))}" alt="">
          <div class="sg-text"><div>${esc(x.title)}</div>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div><span class="sg-type">${typeName[x.__typename]}</span></div>`;
      })
      .join('');
    hydrateIcons(sugg);
    placeSuggest();
    sugg.classList.remove('hidden');
  }, 180);

  function hideSuggest() {
    sugg.classList.add('hidden');
    suggItems = [];
    suggIdx = -1;
  }
  function pickSuggest(i) {
    const it = suggItems[i];
    if (!it) return;
    hideSuggest();
    if (it.type === 'q') {
      input.value = it.q;
      return doSearch(it.q);
    }
    const x = it.x;
    rememberSearch(input.value.trim());
    input.blur();
    if (x.__typename === 'Track') Player.playList([x], 0, { kind: 'list', title: x.title });
    else navigate(x.__typename === 'Artist' ? 'artist' : x.__typename === 'Release' ? 'release' : 'playlist', { id: x.id });
  }

  input.addEventListener('input', () => {
    if (input.value.trim()) hideRecentTop();
    else if (document.activeElement === input) showRecentTop();
    if (App.route?.view === 'search') {
      hideSuggest();
      liveSearch();
    } else loadSuggest();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggItems.length) {
        if (e.key === 'ArrowDown' && !recentTop.classList.contains('hidden')) {
          e.preventDefault();
          $('.recent-query:not(.hidden)', recentTopList)?.focus();
        }
        return;
      }
      e.preventDefault();
      suggIdx = (suggIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggItems.length) % suggItems.length;
      $$('[data-si]', sugg).forEach((el) => el.classList.toggle('active', +el.dataset.si === suggIdx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggIdx >= 0) pickSuggest(suggIdx);
      else doSearch(input.value);
    } else if (e.key === 'Escape') {
      hideSuggest();
      input.blur();
    }
  });
  input.addEventListener('focus', showRecentTop);
  input.addEventListener('blur', () =>
    setTimeout(() => {
      hideSuggest();
      if (!recentTop.contains(document.activeElement)) hideRecentTop();
    }, 150),
  );
  sugg.addEventListener('mousedown', (e) => {
    const el = e.target.closest('[data-si]');
    if (el) {
      e.preventDefault();
      pickSuggest(+el.dataset.si);
    }
  });

  // ======================================================================
  // Горячие клавиши
  // ======================================================================
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, [contenteditable]');
    if ((e.ctrlKey && (e.key === 'k' || e.key === 'f' || e.code === 'KeyK' || e.code === 'KeyF')) || (e.key === '/' && !typing)) {
      e.preventDefault();
      input.focus();
      input.select();
      showRecentTop();
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
      if (NP.eqOpen) NP.closeEq();
      else if (npOpen()) closeNowPlaying();
      else if (document.body.classList.contains('wave-focus')) setWaveFocus(false);
      return;
    }
    if (e.altKey && e.key === 'ArrowLeft') return goBack();
    if (e.altKey && e.key === 'ArrowRight') return goForward();
    if (typing || $('#modalLayer').children.length) return;
    if (e.code === 'Space') {
      e.preventDefault();
      Player.toggle();
    } else if (e.ctrlKey && e.key === 'ArrowRight') Player.next();
    else if (e.ctrlKey && e.key === 'ArrowLeft') Player.prev();
    else if (e.shiftKey && e.key === 'ArrowRight') Player.seekRel(10);
    else if (e.shiftKey && e.key === 'ArrowLeft') Player.seekRel(-10);
    else if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault();
      Player.setVolume(Player.volume + 0.05);
    } else if (e.ctrlKey && e.key === 'ArrowDown') {
      e.preventDefault();
      Player.setVolume(Player.volume - 0.05);
    } else if (e.ctrlKey && (e.key === 'l' || e.code === 'KeyL')) {
      e.preventDefault();
      if (Player.current) App.toggleLike('track', Player.current.id);
    } else if (!e.ctrlKey && (e.key === 'm' || e.code === 'KeyM')) Player.toggleMute();
    else if (!e.ctrlKey && e.code === 'KeyF' && App.route?.view === 'visualizer') {
      const st = $('#vizStage');
      if (st) document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen().catch(() => {});
    }
  });

  // ======================================================================
  // Иконки для панели задач и окна (рисуются на canvas)
  // ======================================================================
  function sendIcons() {
    const draw = (fn, size = 32) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      fn(g, size);
      return c.toDataURL('image/png');
    };
    const tri = (g, x, y, w, h, dir) => {
      g.beginPath();
      if (dir > 0) {
        g.moveTo(x, y);
        g.lineTo(x + w, y + h / 2);
        g.lineTo(x, y + h);
      } else {
        g.moveTo(x + w, y);
        g.lineTo(x, y + h / 2);
        g.lineTo(x + w, y + h);
      }
      g.closePath();
      g.fill();
    };
    const icons = {
      play: draw((g) => tri(g, 10, 7, 15, 18, 1)),
      pause: draw((g) => {
        g.fillRect(8, 7, 6, 18);
        g.fillRect(18, 7, 6, 18);
      }),
      next: draw((g) => {
        tri(g, 6, 8, 14, 16, 1);
        g.fillRect(21, 8, 4, 16);
      }),
      prev: draw((g) => {
        tri(g, 12, 8, 14, 16, -1);
        g.fillRect(7, 8, 4, 16);
      }),
    };
    window.zvuk.player.thumbarIcons(icons);
    // Тот же фирменный знак, что и в оболочке: один локальный SVG без сетевых ресурсов.
    const brand = new Image();
    brand.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(brand, 0, 0, 256, 256);
      window.zvuk.player.appIcon(c.toDataURL('image/png'));
    };
    brand.src = 'brand.svg';
  }

  // ======================================================================
  // Служебный режим снимка экрана
  // ======================================================================
  async function screenshotWhenReady() {
    console.warn('SCREENSHOT_FLOW begin');
    await new Promise((r) => setTimeout(r, 2500));
    const imgs = $$('img').filter((i) => i.src && !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => (i.onload = i.onerror = r)))), new Promise((r) => setTimeout(r, 5000))]);
    let extra = params.get('extra') || '';
    console.warn('SCREENSHOT_FLOW assets ' + extra);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (['homenarrow', 'pulsenarrow', 'likednarrow'].includes(extra)) {
      await window.zvuk.debug.resize(1050, 740);
      await wait(700);
    }
    const firstList = () => [...UI.Lists.values()].find((x) => x.tracks.length > 4) || [...UI.Lists.values()].find((x) => x.tracks.length);
    // Тихое воспроизведение: звук идёт в анализатор, но не в динамики
    const silentPlay = async (idx = 0) => {
      let l = firstList();
      if (!l) {
        const r = await api('getRelease', '6233892');
        l = { tracks: r.tracks.map((t) => ({ ...t, release: { id: r.id, title: r.title, image: r.image } })), source: { kind: 'list', title: r.title } };
      }
      Player.playList(l.tracks, idx, l.source);
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      await wait(4500);
    };
    if (extra === 'uiactions') {
      await silentPlay(0);
      const result = { playIcon: false, presetWheel: false, volumeCancel: false, details: null };
      const row = [...document.querySelectorAll('.tr[data-track]')].find((item) => String(item.dataset.track) === String(Player.current?.id)) || document.querySelector('.tr[data-track]');
      row.querySelector('[data-act="play-row"]').click();
      const rowIcon = row.querySelector('[data-play-icon]');
      result.playIcon = rowIcon.querySelectorAll('rect').length === 2 && !rowIcon.querySelector('path');
      const playDetails = { currentId: Player.current?.id, rowId: row.dataset.track, playing: Player.playing, icon: rowIcon.innerHTML };
      NP.open();
      await wait(350);
      NP.toggleEq();
      const presets = $('#npEq .ne-presets');
      presets.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      result.presetWheel = presets.scrollTop > 0 || presets.scrollLeft > 0;
      NP.closeEq();
      Player.setVolume(.6);
      const slider = $('#npVol');
      const rect = slider.getBoundingClientRect();
      const x = (fraction) => rect.left + rect.width * fraction;
      const y = rect.top + rect.height / 2;
      slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 91, button: 0, isPrimary: true, clientX: x(.6), clientY: y, bubbles: true }));
      slider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 91, clientX: x(.4), clientY: y, bubbles: true }));
      slider.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 91, clientX: 0, clientY: y, bubbles: true }));
      result.volumeCancel = Player.volume > .37 && Player.volume < .43;
      result.details = { ...playDetails, sliderWidth: Math.round(rect.width), volume: Player.volume };
      result.pass = result.playIcon && result.presetWheel && result.volumeCancel;
      console.warn('SELFTEST uiactions: ' + JSON.stringify(result));
      return window.zvuk.screenshotReady(300);
    }
    if (extra === 'novaemotions') {
      await silentPlay(0);
      if (App.panel !== 'nova') openPanel('nova');
      if (!Nova._stateForTest().watching) $('[data-nova-watch]')?.click();
      Nova.setStyle('lunar');
      if (!Player.playing) { Player.play(); await wait(250); }
      const cases = [['tenderness', 'love'], ['joy', 'happy'], ['excitement', 'dance'], ['shy', 'kiss'], ['thoughtful', 'stars'], ['support', 'lonely'], ['longing', 'goodbye'], ['surprise', 'wow']];
      const result = {};
      const realNow = Date.now;
      try {
        for (let index = 0; index < cases.length; index++) {
          const [emotion, word] = cases[index];
          Date.now = () => realNow() + (index + 1) * 20000;
          document.dispatchEvent(new CustomEvent('zg:lyrics-line', { detail: { trackId: Player.current.id, index, line: { t: 8 + index * 3, text: word }, next: { t: 30, text: 'Next line' } } }));
          Date.now = realNow;
          const motion = $('.nv-portrait .nova-motion');
          const image = motion?.querySelector(':scope > img');
          for (let n = 0; n < 40 && !(image?.complete && image.naturalWidth > 0); n++) await wait(50);
          await wait(80);
          const rigActive = motion?._novaRig?.getStats().active;
          result[emotion] = Nova._stateForTest().pose === emotion && motion?.dataset.staticEmotion === '1' && motion.dataset.pose === emotion && image?.getAttribute('src') === `assets/nova/emotions/${emotion}.webp` && image.complete && image.naturalWidth > 0 && motion._novaVideo.paused && !rigActive;
        }
        const motion = $('.nv-portrait .nova-motion');
        for (const style of ['lunar', 'signal', 'neon', 'impulse', 'resonance', 'eclipse']) {
          Nova.setStyle(style);
          let styleOk = true;
          for (const [emotion] of cases) {
            motion.dataset.localPose = emotion;
            Nova.renderPose();
            const image = motion.querySelector(':scope > img');
            const expected = style === 'lunar' ? `assets/nova/emotions/${emotion}.webp` : `assets/nova/styles/${style}/${emotion}.webp`;
            for (let n = 0; n < 40 && !(image?.complete && image.naturalWidth > 0 && image.getAttribute('src') === expected); n++) await wait(25);
            styleOk = styleOk && image?.getAttribute('src') === expected && image.complete && image.naturalWidth > 0;
          }
          const concept = await fetch(`assets/nova/styles/${style}/concept.webp`);
          result[`style:${style}`] = styleOk && concept.ok;
        }
        delete motion.dataset.localPose;
        Nova.setStyle('lunar');
        Nova.renderPose();
      } finally { Date.now = realNow; }
      result.pass = Object.values(result).every(Boolean);
      console.warn('SELFTEST novaemotions: ' + JSON.stringify(result));
      return window.zvuk.screenshotReady(300);
    }
    // NOVA: Синхронизация — спектральный чарт и настоящие аудиочасы плеера.
    if (extra.startsWith('pulse')) {
      const readyPulse = async () => {
        for (let i = 0; i < 100 && !window.__pulseTest; i++) await wait(100);
        return Boolean(window.__pulseTest);
      };
      if (!await readyPulse()) {
        console.warn('SELFTEST pulse: {"pass":false,"reason":"renderer-not-ready"}');
        return window.zvuk.screenshotReady(0);
      }
      if (extra === 'pulse' || extra === 'pulsenarrow') return window.zvuk.screenshotReady(500);
      await silentPlay(0);
      navigate('pulse');
      if (!await readyPulse()) return window.zvuk.screenshotReady(0);
      const game = window.__pulseTest;
      const untilState = async (wanted, timeout = 120000) => {
        const started = performance.now();
        while (performance.now() - started < timeout && game.state !== wanted) await wait(100);
        return game.state === wanted;
      };
      const untilPlay = () => untilState('play');
      if (extra === 'pulsestart') {
        Player.pause();
        Player.audio.removeAttribute('src');
        Player.audio.load();
        await wait(250);
        const button = $('[data-pg-action="start"]');
        const pulseRoot = button?.closest('.pulse-shell');
        const trackId = String(Player.current?.id || '');
        const stateBefore = game.state;
        const beforePaused = Player.audio.paused;
        const events = [];
        const errors = [];
        const onError = (event) => errors.push(event.error?.stack || event.message || String(event.reason));
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onError);
        button?.addEventListener('click', (event) => events.push(`button:${event.target.tagName}:${event.cancelBubble}`));
        pulseRoot?.addEventListener('click', () => events.push('root'));
        if (button) {
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          events.push(hit === button || button.contains(hit) ? 'hit-button' : `hit-${hit?.tagName}.${hit?.className}`);
          await window.zvuk.debug.mouse(x, y);
          await wait(100);
          await window.zvuk.debug.mouse(x, y, 'mousePressed');
          await wait(60);
          await window.zvuk.debug.mouse(x, y, 'mouseReleased');
        }
        const entered = ['prepare', 'countdown'].includes(game.state);
        await wait(500);
        const after500 = game.state;
        const playing = await untilState('play', 20000);
        const metrics = game.metrics();
        const report = { button: Boolean(button), disabled: button?.disabled, stateBefore, beforePaused, afterPaused: Player.audio.paused, events, errors, entered, after500, domState: pulseRoot?.dataset.state, playing, state: game.state, notes: metrics.chartNotes, sameTrack: trackId === String(Player.current?.id || ''), sourceRestored: Boolean(Player.audio.src), lifecycle: metrics.lifecycle };
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onError);
        report.pass = report.button && entered && playing && metrics.chartNotes > 0;
        console.warn('SELFTEST pulsestart: ' + JSON.stringify(report));
        return window.zvuk.screenshotReady(300);
      }
      const key = (code, down = true) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
        key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
        code, bubbles: true, cancelable: true,
      }));
      if (extra === 'pulsetest') {
        const result = {
          title: false, sfxDefault: false, prepare: false, countdown: false, play: false, chart: false,
          keys: true, exact: false, early: false, late: false, expanded: false, miss: false, hold: false, earlyRelease: false,
          pause: false, resumeHold: false, regrab: false, sfx: false, calibration: false, seek: false, track: false,
          victory: false, unlock: false, stylePersistence: false, restart: false, trackDuringAnalysis: false,
          gameOver: false, titleReturn: false,
        };
        game.setDifficulty('normal');
        result.title = game.state === 'title';
        result.sfxDefault = game.metrics().sfxEnabled;
        const starting = game.start();
        result.prepare = game.state === 'prepare';
        await starting;
        result.countdown = game.state === 'countdown' && !Player.playing && game.metrics().trackTime < .15;
        result.play = await untilPlay();
        let metrics = game.metrics();
        result.chart = metrics.chartNotes > 0 && metrics.onsets > 0 && metrics.method === 'spectral-flux' && metrics.bpm > 0;
        for (let lane = 0; lane < 4; lane++) {
          Player.seek(0); await wait(45);
          game.inject(lane, game.metrics().trackTime);
          const hits = game.metrics().hits;
          key(['KeyD', 'KeyF', 'KeyJ', 'KeyK'][lane]);
          key(['KeyD', 'KeyF', 'KeyJ', 'KeyK'][lane], false);
          await wait(20);
          result.keys = result.keys && game.metrics().hits === hits + 1 && Math.abs(game.metrics().lastOffset) <= .12;
        }
        game.resetFixture(); await wait(35);
        let noteTime = game.metrics().trackTime + .4;
        game.inject(0, noteTime); game.hit(0, noteTime);
        result.exact = game.metrics().lastJudge === 'perfect' && Math.abs(game.metrics().lastOffset) < .001;
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime + .4;
        game.inject(0, noteTime); game.hit(0, noteTime - .07);
        result.early = game.metrics().lastJudge === 'great' && game.metrics().lastOffset < 0;
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime + .4;
        game.inject(0, noteTime); game.hit(0, noteTime + .11);
        result.late = game.metrics().lastJudge === 'good' && game.metrics().lastOffset > 0;
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime + .4;
        game.inject(0, noteTime); game.hit(0, noteTime + .14);
        result.expanded = game.metrics().lastJudge === 'good' && game.metrics().lastOffset > .125;
        game.resetFixture(); await wait(35);
        game.inject(2, game.metrics().trackTime + .05);
        for (let attempt = 0; attempt < 20 && !game.metrics().misses; attempt++) await wait(50);
        result.miss = game.metrics().misses === 1 && game.metrics().lastJudge === 'miss';
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime;
        game.inject(1, noteTime, .38); game.hit(1, noteTime); await wait(560);
        result.hold = game.metrics().holdTicks > 0 && game.metrics().activeHolds === 0 && game.metrics().misses === 0 && game.metrics().lastJudge === 'hold';
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime;
        game.inject(1, noteTime, 1.5); game.hit(1, noteTime); await wait(180); key('KeyF', false);
        result.earlyRelease = game.metrics().lastJudge === 'broken' && game.metrics().misses === 1;
        game.resetFixture(); await wait(35);
        noteTime = game.metrics().trackTime;
        game.inject(1, noteTime, 1.2); game.hit(1, noteTime); await wait(120);
        game.pause();
        const pausedAt = game.metrics().trackTime;
        const pausedTicks = game.metrics().holdTicks;
        await wait(180);
        result.pause = game.state === 'pause' && !Player.playing && Math.abs(game.metrics().trackTime - pausedAt) < .04;
        game.resume(); await wait(180);
        result.resumeHold = game.state === 'play' && game.metrics().holding === 1 && game.metrics().activeHolds === 0 && game.metrics().holdTicks === pausedTicks;
        key('KeyF'); await wait(150);
        result.regrab = game.metrics().activeHolds === 1 && game.metrics().holdTicks > pausedTicks;
        key('KeyF', false);
        const sfx = $('[data-pg-action="sfx"]');
        const sfxBefore = game.metrics().sfxEnabled;
        sfx.click();
        const sfxChanged = game.metrics().sfxEnabled !== sfxBefore && localStorage.getItem('zg.pulse.sfx') === (sfxBefore ? '0' : '1');
        sfx.click();
        result.sfx = sfxChanged && game.metrics().sfxEnabled === sfxBefore;
        const calibration = $('[data-pg="calibration"]');
        calibration.value = '25';
        calibration.dispatchEvent(new Event('input', { bubbles: true }));
        calibration.dispatchEvent(new Event('change', { bubbles: true }));
        result.calibration = game.metrics().calibration === 25 && localStorage.getItem('zg.pulse.offset') === '25';
        calibration.value = '0';
        calibration.dispatchEvent(new Event('input', { bubbles: true }));
        calibration.dispatchEvent(new Event('change', { bubbles: true }));
        Player.seek(1); await wait(80);
        result.seek = Math.abs(game.metrics().trackTime - 1) < .25 && game.metrics().activeHolds === 0 && game.metrics().skipped > 0;
        const oldTrack = String(Player.current?.id);
        Player.next(); await wait(1400);
        result.track = String(Player.current?.id) !== oldTrack && game.state === 'title' && game.metrics().chartNotes === 0;
        const progressBefore = game.progress();
        const completedTrack = String(Player.current?.id);
        game.finish(true);
        result.victory = game.state === 'result' && game.metrics().result === 'complete';
        result.unlock = game.progress().clears.includes(completedTrack) && game.metrics().unlocked.includes('signal') && (progressBefore.clears.includes(completedTrack) || $('.sync-unlocks')?.textContent.includes('Сигнал'));
        $('[data-style="signal"]')?.click();
        result.stylePersistence = game.metrics().activeStyle === 'signal' && localStorage.getItem('zg.nova.style') === 'signal' && document.body.dataset.novaStyle === 'signal';
        const restarting = game.restart();
        result.restart = ['prepare', 'countdown'].includes(game.state);
        const interruptedTrack = String(Player.current?.id);
        Player.next();
        await restarting; await wait(200);
        result.trackDuringAnalysis = String(Player.current?.id) !== interruptedTrack && game.state === 'title' && game.metrics().chartNotes === 0;
        await game.start();
        await untilPlay();
        game.finish(false);
        result.gameOver = game.state === 'result' && game.metrics().result === 'interrupted';
        $('[data-pg-action="title"]')?.click();
        result.titleReturn = game.state === 'title' && !Player.playing && game.metrics().activeHolds === 0;
        result.metrics = game.metrics();
        result.pass = Object.values(result).every((value) => typeof value !== 'boolean' || value);
        console.warn('SELFTEST pulse: ' + JSON.stringify(result));
        return window.zvuk.screenshotReady(300);
      }
      if (extra === 'pulseexpert') {
        game.setDifficulty('expert');
        await game.start();
        const m = game.metrics();
        const report = { difficulty: m.difficulty, laneCount: m.laneCount, notes: m.chartNotes, onsets: m.onsets, bpm: m.bpm, method: m.method, buttons: document.querySelectorAll('[data-lane]').length };
        report.pass = m.difficulty === 'expert' && m.laneCount === 5 && report.buttons === 5 && report.notes > 0 && report.onsets > 0;
        console.warn('SELFTEST pulseexpert: ' + JSON.stringify(report));
        return window.zvuk.screenshotReady(300);
      }
      if (extra === 'pulserhythm') {
        await game.start();
        const m = game.metrics();
        const report = { notes: m.chartNotes, onsets: m.onsets, bpm: m.bpm, method: m.method, inferred: m.inferred };
        report.pass = report.notes > 0 && report.onsets > 0 && report.method === 'spectral-flux';
        console.warn('SELFTEST pulserhythm: ' + JSON.stringify(report));
        return window.zvuk.screenshotReady(300);
      }
      if (extra === 'pulseperf') AudioFX.setVolume(0);
      const starting = game.start();
      if (extra === 'pulsecount') { await untilState('countdown'); return window.zvuk.screenshotReady(350); }
      await starting;
      await untilPlay();
      if (extra === 'pulseperf') {
        const deltas = [];
        let previous = performance.now();
        const end = previous + 3000;
        await new Promise((resolve) => {
          const tick = (now) => {
            deltas.push(now - previous);
            previous = now;
            if (now < end) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        deltas.sort((a, b) => a - b);
        const m = game.metrics();
        const report = {
          fps: Math.round(deltas.length * 1000 / (previous - end + 3000)),
          p95: Math.round((deltas[Math.floor(deltas.length * .95)] || 0) * 10) / 10,
          over25: deltas.filter((value) => value > 25).length,
          drawAvgMs: Math.round((m.drawAvg || 0) * 1000) / 1000,
          drawMaxMs: Math.round((m.drawMax || 0) * 1000) / 1000,
          frames: m.drawCount || 0, notes: m.chartNotes,
        };
        report.pass = report.frames > 30 && report.notes > 0;
        console.warn('SELFTEST pulseperf: ' + JSON.stringify(report));
        return window.zvuk.screenshotReady(300);
      }
      if (extra === 'pulseplay' || extra === 'pulsepause') {
        await game.perfectNext();
        if (extra === 'pulsepause') game.pause();
        return window.zvuk.screenshotReady(350);
      }
      if (extra === 'pulsewin' || extra === 'pulselose') {
        if (extra === 'pulseplay') await game.perfectNext();
        game.finish(extra === 'pulsewin');
        return window.zvuk.screenshotReady(400);
      }
      return window.zvuk.screenshotReady(0);
    }
    // Прежний служебный сценарий шутера сохранён только для ручной диагностики старых копий.
    if (extra.startsWith('legacyPulse')) {
      const readyPulse = async () => {
        for (let i = 0; i < 100 && !window.__pulseTest; i++) await wait(100);
        return Boolean(window.__pulseTest);
      };
      if (!await readyPulse()) {
        console.warn('SELFTEST pulse: {"pass":false,"reason":"renderer-not-ready"}');
        return window.zvuk.screenshotReady(0);
      }
      if (extra === 'pulse' || extra === 'pulsenarrow') return window.zvuk.screenshotReady(500);
      await silentPlay(0);
      navigate('pulse');
      if (!await readyPulse()) return window.zvuk.screenshotReady(0);
      const game = window.__pulseTest;
      const untilPlay = async () => {
        for (let i = 0; i < 60 && game.state !== 'play'; i++) await wait(100);
        return game.state === 'play';
      };
      const key = (code, down = true) => document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
        key: code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
        code, bubbles: true, cancelable: true,
      }));
      const tap = async (code) => { key(code); key(code, false); await wait(35); };
      if (extra !== 'pulsetest') {
        $('[data-pg-action="start"]')?.click();
        if (extra === 'pulsecount') return window.zvuk.screenshotReady(500);
        await untilPlay();
      }
      if (extra === 'pulseplay' || extra === 'pulsepause') {
        game.pose(0, 6, 0);
        game.setIntensity(.82);
        game.spawn('sentinel', 5, -.32);
        game.spawn('husk', 4.2, .12);
        game.spawn('skitter', 4.8, .45);
        game.spawn('elite', 7, -.45);
        await wait(120);
        game.fire();
        if (extra === 'pulsepause') $('[data-pg-action="pause"]')?.click();
        return window.zvuk.screenshotReady(450);
      }
      if (extra === 'pulsewin' || extra === 'pulselose') {
        if (extra === 'pulsewin') {
          game.pose(0, 6, 0);
          game.spawn('husk', 4);
          game.fire();
          await wait(280);
          game.fire();
          await wait(120);
          game.finish(true);
        } else game.damage(1000);
        return window.zvuk.screenshotReady(500);
      }
      if (extra === 'pulserhythm') {
        game.setIntensity(.12);
        game.setTempo(.86);
        await wait(900);
        const calm = game.metrics();
        game.setIntensity(.95);
        await wait(900);
        const peak = game.metrics();
        const result = {
          calm: { drive: calm.drive, beatPeriod: calm.beatPeriod, waveDelay: calm.waveDelay, surge: calm.surge, activeEnemies: calm.activeEnemies },
          peak: { drive: peak.drive, beatPeriod: peak.beatPeriod, waveDelay: peak.waveDelay, surge: peak.surge, activeEnemies: peak.activeEnemies },
        };
        result.denser = peak.waveDelay < calm.waveDelay * .7;
        result.surge = !calm.surge && peak.surge;
        result.pass = result.denser && result.surge;
        console.warn('SELFTEST pulserhythm: ' + JSON.stringify(result));
        return window.zvuk.screenshotReady(300);
      }
      if (extra === 'pulsetest') {
        const result = {
          title: false, countdown: false, play: false, forward: false, backward: false, left: false, right: false,
          turnRight: false, turnLeft: false, shotHit: false, beatShot: false, cover: false, pointerLock: false,
          mouseLook: false, pause: false, resume: false, overheat: false, cooled: false, telegraph: false,
          attack: false, pickup: false, sfx: false, calibration: false, seek: false, track: false,
          victory: false, restart: false, gameOver: false, titleReturn: false,
        };
        result.title = game.state === 'title';
        $('[data-pg-action="start"]')?.click();
        result.countdown = game.state === 'countdown';
        result.play = await untilPlay();
        let before = game.metrics().playerZ;
        key('KeyW'); await wait(130); key('KeyW', false);
        result.forward = game.metrics().playerZ < before - .15;
        before = game.metrics().playerZ;
        key('KeyS'); await wait(130); key('KeyS', false);
        result.backward = game.metrics().playerZ > before + .15;
        before = game.metrics().playerX;
        key('KeyA'); await wait(130); key('KeyA', false);
        result.left = game.metrics().playerX < before - .15;
        before = game.metrics().playerX;
        key('KeyD'); await wait(130); key('KeyD', false);
        result.right = game.metrics().playerX > before + .15;
        before = game.metrics().yaw;
        key('ArrowRight'); await wait(120); key('ArrowRight', false);
        result.turnRight = game.metrics().yaw < before - .05;
        before = game.metrics().yaw;
        key('ArrowLeft'); await wait(120); key('ArrowLeft', false);
        result.turnLeft = game.metrics().yaw > before + .05;

        Player.seek(1);
        game.pose(0, 6, 0);
        await wait(280);
        let metrics = game.metrics();
        game.spawn('husk', 4);
        await tap('Space');
        result.shotHit = game.metrics().shots === metrics.shots + 1 && game.metrics().hits === metrics.hits + 1;
        await wait(250);
        game.setTempo(.3);
        await wait(15);
        metrics = game.metrics();
        await tap('Space');
        result.beatShot = game.metrics().beatHits === metrics.beatHits + 1;

        Player.seek(1);
        game.pose(-3.2, 4.6, 0);
        await wait(280);
        metrics = game.metrics();
        game.spawn('husk', 4);
        await tap('Space');
        result.cover = game.metrics().shots === metrics.shots + 1 && game.metrics().hits === metrics.hits;

        Player.seek(1);
        game.pose(0, 6, 0);
        const canvas = $('.pulse-canvas');
        const rect = canvas.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
        await wait(180);
        result.pointerLock = game.metrics().pointerLocked;
        before = game.metrics().yaw;
        await window.zvuk.debug.mouse(x + 70, y);
        await wait(120);
        result.mouseLook = result.pointerLock && Math.abs(game.metrics().yaw - before) > .01;
        await tap('KeyP');
        await wait(120);
        result.pause = game.state === 'pause' && !Player.playing;
        $('[data-pg-action="resume"]')?.click();
        await wait(180);
        result.resume = game.state === 'play' && Player.playing;

        Player.seek(1);
        game.pose(7, 7, 0);
        for (let i = 0; i < 7 && !game.metrics().overheated; i++) {
          await tap('Space');
          await wait(235);
        }
        result.overheat = game.metrics().overheated;
        for (let i = 0; i < 55 && game.metrics().overheated; i++) await wait(100);
        result.cooled = result.overheat && !game.metrics().overheated && game.metrics().heat <= 38;

        Player.seek(1);
        game.pose(0, 6, 0);
        game.setTempo(.3);
        metrics = game.metrics();
        game.spawn('sentinel', 4);
        for (let i = 0; i < 24 && game.metrics().telegraphs === metrics.telegraphs; i++) await wait(50);
        result.telegraph = game.metrics().telegraphs > metrics.telegraphs;
        for (let i = 0; i < 24 && game.metrics().attacks === metrics.attacks; i++) await wait(50);
        result.attack = game.metrics().attacks > metrics.attacks && game.metrics().health < metrics.health;
        game.damage(30);
        before = game.metrics().health;
        game.pickup(.1);
        await wait(120);
        result.pickup = game.metrics().health > before && game.metrics().activePickups === 0;

        const sfx = $('[data-pg-action="sfx"]');
        const sfxBefore = game.metrics().sfxEnabled;
        sfx.click();
        const sfxChanged = game.metrics().sfxEnabled !== sfxBefore && localStorage.getItem('zg.pulse.sfx') === (sfxBefore ? '0' : '1');
        sfx.click();
        result.sfx = sfxChanged && game.metrics().sfxEnabled === sfxBefore;
        const calibration = $('[data-pg="calibration"]');
        calibration.value = '25';
        calibration.dispatchEvent(new Event('input', { bubbles: true }));
        calibration.dispatchEvent(new Event('change', { bubbles: true }));
        result.calibration = game.metrics().calibration === 25 && localStorage.getItem('zg.pulse.offset') === '25';
        calibration.value = '0';
        calibration.dispatchEvent(new Event('input', { bubbles: true }));
        calibration.dispatchEvent(new Event('change', { bubbles: true }));
        game.spawn('husk', 1);
        Player.seek(1);
        result.seek = game.metrics().activeEnemies === 0;
        const oldTrack = String(Player.current?.id);
        Player.next();
        await wait(600);
        result.track = String(Player.current?.id) !== oldTrack && game.state === 'title' && game.metrics().activeEnemies === 0;
        $('[data-pg-action="start"]')?.click();
        await untilPlay();
        game.spawn('elite', 5);
        game.finish(true);
        result.victory = game.state === 'result' && $('.pulse-shell').dataset.result === 'victory' && game.metrics().activeEnemies === 0;
        $('[data-pg-action="restart"]')?.click();
        result.restart = game.state === 'countdown';
        await untilPlay();
        game.damage(1000);
        result.gameOver = game.state === 'result' && $('.pulse-shell').dataset.result === 'game-over' && game.metrics().energy === 0;
        $('[data-pg-action="title"]')?.click();
        result.titleReturn = game.state === 'title' && !Player.playing && game.metrics().activeEnemies === 0;
        result.metrics = game.metrics();
        result.pass = Object.values(result).every((value) => typeof value !== 'boolean' || value);
        console.warn('SELFTEST pulse: ' + JSON.stringify(result));
        return window.zvuk.screenshotReady(300);
      }
      return window.zvuk.screenshotReady(0);
    }
    // служебно: выбрать стиль визуализатора для снимка
    if (params.get('vizstyle')) {
      App.settings.viz.style = params.get('vizstyle');
      if (App.route?.view === 'visualizer') {
        App.rerender();
        await wait(600);
      }
    }
    // Переносная копия: ни автоматический, ни ручной запрос не должен запускать загрузку обновления.
    if (extra === 'portable') {
      const state = await window.zvuk.update.state();
      const checked = await window.zvuk.update.check();
      navigate('settings');
      await wait(900);
      $('#aboutCard')?.scrollIntoView({ block: 'center' });
      const line = $('#updLine')?.textContent || '';
      const pass = state.portable === true && state.state === 'portable' && checked.state === 'portable' && line.includes('Переносная тестовая копия');
      console.warn(`SELFTEST portable: pass=${pass} flag=${state.portable} state=${state.state} manual=${checked.state} line=${line}`);
      return window.zvuk.screenshotReady(600);
    }
    // Полный проход по страницам: фактический DOM, раскладка, кадры, число API-вызовов и гонки.
    // Работает только в служебном анонимном режиме и ничего не меняет в аккаунте.
    if (extra === 'fullaudit') {
      Player.pause();
      const report = { pages: [], checks: {}, faults: [] };
      const rawCall = window.zvuk.call;
      const calls = {};
      const countedCall = (method, ...args) => {
        calls[method] = (calls[method] || 0) + 1;
        return rawCall(method, ...args);
      };
      window.zvuk.call = countedCall;
      const fault = (e) => report.faults.push(String(e?.message || e));
      const onError = (e) => fault(e.message);
      const onReject = (e) => fault(e.reason?.message || e.reason);
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onReject);
      const sampleFrames = (ms = 900) => new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const end = last + ms;
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (now < end) return requestAnimationFrame(tick);
          deltas.sort((a, b) => a - b);
          resolve({ fps: +(deltas.length * 1000 / (now - end + ms)).toFixed(1), p95: +(deltas[Math.floor(deltas.length * 0.95)] || 0).toFixed(1), over25: deltas.filter((x) => x > 25).length });
        };
        requestAnimationFrame(tick);
      });
      const waitFor = async (fn, timeout = 30000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          try { if (fn()) return true; } catch {}
          await wait(200);
        }
        return false;
      };
      const visit = async (name, params, selector, ready = () => true) => {
        navigate(name, params || {});
        const found = await waitFor(() => $(selector) && ready());
        await wait(350);
        const perf = await sampleFrames();
        const error = $('#view [data-act="reload-view"]');
        const entry = {
          page: name + (params?.q ? ':' + params.q : ''), loaded: found,
          content: $(selector)?.textContent?.trim().slice(0, 100) || '',
          error: error?.textContent || null,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          strayNova: Boolean(view.querySelector('.nova-context, .home-nova, .wv-nova-companion') || document.querySelector('#novaLive')),
          detachedCanvas: [...document.querySelectorAll('canvas')].filter((c) => !c.isConnected).length,
          perf,
        };
        entry.pass = found && !error && !entry.horizontalOverflow && !entry.strayNova;
        report.pages.push(entry);
        console.warn(`AUDIT page ${JSON.stringify(entry)}`);
      };
      try {
        const cases = [
          ['home', {}, '#homeRing'],
          ['popular', {}, '#topList .tr'],
          ['wave', {}, '#waveCosmos'],
          ['pulse', {}, '.pulse-shell', () => Boolean(window.__pulseTest)],
          ['search', {}, '#searchWaves', () => !$('#searchWaves .skel')],
          ['search', { q: 'Imagine' }, '#view .tr'],
          ['artist', { id: '102622' }, '.artist-hero'],
          ['release', { id: '19896779' }, '#view .tr'],
          ['playlist', { id: '1062105' }, '#view .tr'],
          ['liked', {}, '#likedMeta', () => $('#likedMeta')?.textContent !== 'Загрузка…' && !$('#likedList .skel')],
          ['albums', {}, '.page-title', () => !$('#view .skel')],
          ['artists', {}, '.page-title', () => !$('#view .skel')],
          ['playlists', {}, '.page-title', () => !$('#view .skel')],
          ['history', {}, '.page-title', () => !$('#view .skel')],
          ['settings', {}, '#aboutCard'],
          ['visualizer', {}, '#vizStage canvas'],
          ['equalizer', {}, '#eqCanvas'],
        ];
        for (const c of cases) await visit(...c);
        // Повторный вход использует кэш; подписка не запрашивается при каждом клике.
        await visit('settings', {}, '#aboutCard');
        await visit('popular', {}, '#topList .tr');
        report.checks.popularChart = $$('#topList .tr').length;
        report.checks.popularPodium = $$('.tp-card').length;
        report.checks.popularContent = report.checks.popularChart > 0 && report.checks.popularPodium === 3;

        // Реальный backend: восемь одинаковых вызовов → один dispatch и один HTTP-запрос.
        let before = await window.zvuk.debug.apiStats();
        const trackId = $('#view .tr')?.dataset.track || (await api('getRelease', '6233892')).tracks[0].id;
        const same = await Promise.all(Array.from({ length: 8 }, () => rawCall('getTracks', [trackId])));
        let after = await window.zvuk.debug.apiStats();
        report.checks.backendDedup = { identicalResults: same.every((x) => JSON.stringify(x) === JSON.stringify(same[0])), httpDelta: after.httpSent - before.httpSent };
        before = after;
        const collections = await Promise.all(Array.from({ length: 8 }, () => rawCall('getCollectionIds')));
        after = await window.zvuk.debug.apiStats();
        report.checks.collectionDedup = { identicalResults: collections.every((x) => JSON.stringify(x) === JSON.stringify(collections[0])), httpDelta: after.httpSent - before.httpSent };

        // Ограничение JS-кэша, повторное использование Promise и удаление ошибки — без сети.
        api.invalidate('search:');
        window.zvuk.call = async () => ({ tracks: [], artists: [], releases: [], playlists: [] });
        for (let i = 0; i < 190; i++) await api('search', 'audit-cache-' + i);
        const cacheInfo = api.auditCache();
        let mockCalls = 0;
        window.zvuk.call = async () => { mockCalls++; return { tracks: [], artists: [], releases: [], playlists: [] }; };
        await api('search', 'audit-cache-189');
        await api('search', 'audit-cache-0');
        report.checks.lru = { ...cacheInfo, pass: cacheInfo?.size === 180 && mockCalls === 1 };
        window.zvuk.call = async () => { mockCalls++; throw new Error('synthetic-cache-error'); };
        for (let i = 0; i < 2; i++) await api('search', 'audit-error').catch(() => {});
        report.checks.rejectedCacheRemoved = mockCalls === 3;
        let release;
        window.zvuk.call = () => { mockCalls++; return new Promise((r) => { release = r; }); };
        const a = api('search', 'audit-shared');
        const b = api('search', 'audit-shared');
        release({ tracks: [] });
        await Promise.all([a, b]);
        report.checks.frontendPromiseShared = mockCalls === 4;
        api.invalidate('search:');
        window.zvuk.call = countedCall;

        // Медленный ответ прежней волны не должен перезаписать новую очередь.
        const savedPlayer = { queue: Player.queue, index: Player.index, source: Player.source, original: Player.original, load: Player._load };
        let finishOld;
        Player._load = (i) => { Player.index = i; };
        const oldSource = { kind: 'wave', fetchMore: () => new Promise((r) => { finishOld = r; }) };
        const first = Player.startEndless(oldSource);
        const newSource = { kind: 'wave', fetchMore: async () => [{ id: 'audit-new', title: 'new', artists: [] }] };
        await Player.startEndless(newSource);
        finishOld([{ id: 'audit-old', title: 'old', artists: [] }]);
        await first;
        report.checks.waveRace = Player.source === newSource && Player.queue.length === 1 && Player.current?.id === 'audit-new';
        Player._load = savedPlayer.load;

        // close → open за 360 мс: старый таймер не закрывает новый экран.
        const releaseData = await api('getRelease', '6233892');
        Player.queue = releaseData.tracks.slice(0, 1);
        Player.index = 0;
        Player.source = { kind: 'list', title: 'audit' };
        const oldViz = NP.vizOn;
        NP.vizOn = false;
        NP.open();
        NP.close();
        NP.open();
        await wait(700);
        report.checks.nowPlayingRace = NP.isOpen && !$('#nowPlaying').classList.contains('closing') && document.body.classList.contains('np-open');
        let cyclesOk = true;
        for (let cycle = 0; cycle < 3; cycle++) {
          NP.open();
          await wait(560);
          cyclesOk = cyclesOk && NP.isOpen && document.body.classList.contains('np-open');
          NP.close();
          await wait(420);
          cyclesOk = cyclesOk && !NP.isOpen && !$('#nowPlaying').classList.contains('closing') && !document.body.classList.contains('np-open');
        }
        report.checks.nowPlayingCycles = Boolean(cyclesOk);
        const popularNav = $('[data-act="nav"][data-view="popular"]');
        if (!popularNav.offsetParent) {
          toggleSection('main');
          await wait(150);
        }
        const navRect = popularNav.getBoundingClientRect();
        const navHit = document.elementFromPoint(navRect.left + navRect.width / 2, navRect.top + navRect.height / 2);
        report.checks.nowPlayingHitTest = {
          pass: Boolean(navHit && !navHit.closest('#nowPlaying') && (navHit === popularNav || popularNav.contains(navHit))),
          visible: Boolean(popularNav.offsetParent),
          rect: [navRect.left, navRect.top, navRect.width, navRect.height].map(Math.round),
          hit: navHit ? `${navHit.tagName}#${navHit.id}.${navHit.className}` : null,
          npOpen: NP.isOpen,
        };
        NP.vizOn = oldViz;
        Object.assign(Player, { queue: savedPlayer.queue, index: savedPlayer.index, source: savedPlayer.source, original: savedPlayer.original });
        Player.emit('queue');
        report.checks.waveRace = Boolean(report.checks.waveRace);
        report.checks.backendDedup.pass = report.checks.backendDedup.httpDelta === 1 && report.checks.backendDedup.identicalResults;
        report.checks.collectionDedup.pass = report.checks.collectionDedup.httpDelta === 1 && report.checks.collectionDedup.identicalResults;
        report.checks.subscriptionCached = (calls.getSubscription || 0) === 1;
      } catch (e) { fault(e); }
      finally {
        window.zvuk.call = rawCall;
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onReject);
      }
      report.calls = calls;
      report.pass = report.pages.every((p) => p.pass) && !report.faults.length && Object.entries(report.checks).filter(([, v]) => typeof v === 'object').every(([, v]) => v.pass !== false) && Object.entries(report.checks).filter(([, v]) => typeof v === 'boolean').every(([, v]) => v);
      console.warn('SELFTEST fullaudit: ' + JSON.stringify(report));
      navigate('home');
      await wait(1400);
      return window.zvuk.screenshotReady(0);
    }
    // служебно: долгое тихое воспроизведение (проверка медиаклавиш и системной панели Windows)
    if (extra === 'playlong' || extra === 'playlongq') {
      await silentPlay(1);
      // «q» — очень тихо, но не беззвучно (проверка захвата звука)
      if (extra === 'playlongq') {
        Player._applyVolume = () => AudioFX.setVolume(0.02);
        AudioFX.setVolume(0.02);
        console.warn(`SELFTEST audio: ctx=${AudioFX.ctx && AudioFX.ctx.state} ready=${AudioFX.ready} gain=${AudioFX.vol && AudioFX.vol.gain.value} paused=${Player.audio.paused} level=${Viz.level.toFixed(3)}`);
      }
      await wait(25000);
      return window.zvuk.screenshotReady(0);
    }
    // служебно: карточка «О программе» (и баннер, если обновление уже скачано)
    if (extra.startsWith('about')) {
      const until = Date.now() + (parseInt(extra.slice(5), 10) || 0) * 1000;
      while (Date.now() < until && App.update.state !== 'ready') await wait(500);
      $('#aboutCard')?.scrollIntoView({ block: 'center' });
      return window.zvuk.screenshotReady(600);
    }
    if (extra.startsWith('np') && extra !== 'npvizpanel' && extra !== 'npvizimpact') {
      if (extra.includes('play')) await silentPlay(2);
      else {
        const l = firstList();
        if (l) Player.cue(l.tracks, Math.min(2, l.tracks.length - 1), 0, l.source);
        await wait(1500);
      }
      NP.lyricsOn = extra.includes('lyrics') || extra === 'nplayout';
      NP.vizOn = extra.includes('viz');
      openNowPlaying();
      await wait(2200);
      if (extra === 'nporbitring' || extra === 'nporbitringwide') {
        Player.save = () => {};
        try {
          const saved = JSON.parse(localStorage.getItem('zg.queue.v1') || 'null');
          const synthetic = saved?.queue?.filter((track) => String(track.id).startsWith('ring-demo-')).length || 0;
          if (synthetic > 200) localStorage.removeItem('zg.queue.v1');
        } catch {}
        const seed = Player.queue.slice();
        const current = Player.current;
        const longQueue = Array.from({ length: 240 }, (_, i) => ({ ...seed[i % seed.length], id: `ring-demo-${i}` }));
        longQueue[120] = current;
        Player.queue = longQueue;
        Player.index = 120;
        Player.repeat = 'all';
        NP.render();
        await wait(900);
        const visible = () => [...$$('.cf-item:not(.recycling)')];
        const indexes = () => visible().map((el) => +el.dataset.qi);
        const initial = { count: visible().length, unique: new Set(indexes()).size, current: $('[data-qi="120"].cf-item.cur') != null };
        Player.index = 121;
        NP.render();
        await wait(900);
        const stepped = { count: visible().length, current: $('[data-qi="121"].cf-item.cur') != null, removed: !indexes().includes(114), added: indexes().includes(127) };
        Player.repeat = 'off';
        Player.index = 239;
        NP.render();
        await wait(900);
        const finite = { count: visible().length, current: $('[data-qi="239"].cf-item.cur') != null, wrapped: indexes().includes(0) };
        Player.repeat = 'all';
        NP.render();
        await wait(900);
        const looped = { count: visible().length, current: $('[data-qi="239"].cf-item.cur') != null, wrapped: indexes().includes(0) };
        const report = { initial, stepped, finite, looped, sizes: [] };
        for (const [width, height] of [[1920, 1000], [1280, 800], [900, 700], [600, 760]]) {
          await window.__TAURI__.core.invoke('debug_resize', { width, height });
          await wait(400);
          const contained = visible().every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= -2 && r.right <= innerWidth + 2 && r.top >= -2 && r.bottom <= innerHeight + 2;
          });
          report.sizes.push({ requested: [width, height], actual: [innerWidth, innerHeight], contained });
        }
        const renderStarted = performance.now();
        for (let i = 0; i < 120; i++) NP.render();
        report.renderMs = Math.round((performance.now() - renderStarted) / 120 * 1000) / 1000;
        report.pass = initial.count === 13 && initial.unique === 13 && initial.current &&
          stepped.count === 13 && stepped.current && stepped.removed && stepped.added &&
          finite.count === 7 && finite.current && !finite.wrapped &&
          looped.count === 13 && looped.current && looped.wrapped && report.sizes.every((s) => s.contained);
        console.warn('SELFTEST nporbitring: ' + JSON.stringify(report));
        await window.__TAURI__.core.invoke('debug_resize', { width: extra.endsWith('wide') ? 1920 : 1400, height: extra.endsWith('wide') ? 1000 : 900 });
        Player.index = 120;
        NP.render();
        await wait(900);
        return window.zvuk.screenshotReady(350);
      }
      if (extra === 'nplayout') {
        const report = { sizes: [], pass: true };
        for (const [width, height] of [[1280, 800], [1000, 740], [800, 700], [600, 760]]) {
          await window.__TAURI__.core.invoke('debug_resize', { width, height });
          await wait(350);
          const panel = $('.np-lyrics');
          const panelRect = panel.getBoundingClientRect();
          const lines = [...panel.querySelectorAll('.lyrics .ln')];
          const bounds = lines.map((line) => {
            const range = document.createRange();
            range.selectNodeContents(line);
            const rect = range.getBoundingClientRect();
            const style = getComputedStyle(line);
            return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 && rect.right <= innerWidth + 1 && style.whiteSpace === 'normal' && style.transform === 'none';
          });
          const entry = { requested: [width, height], actual: [innerWidth, innerHeight], lines: lines.length, contained: bounds.every(Boolean), documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, panelRight: Math.round(panelRect.right), viewportWidth: innerWidth };
          entry.pass = lines.length > 0 && entry.contained && !entry.documentOverflow && panelRect.right <= innerWidth + 1;
          report.sizes.push(entry);
        }
        report.pass = report.sizes.every((entry) => entry.pass);
        console.warn('SELFTEST nplayout-bounds: ' + JSON.stringify(report));
        await window.__TAURI__.core.invoke('debug_resize', { width: 1280, height: 800 });
        await wait(350);
        return window.zvuk.screenshotReady(350);
      }
      const npStageStyle = getComputedStyle($('.np-stage'));
      const npCenter = window.innerWidth / 2 - (NP.lyricsOn ? window.innerWidth * (window.innerWidth <= 640 ? 0.22 : 0.13) : 0);
      const npParts = ['#npTitle', '.np-seek', '.np-controls'].map((selector) => {
        const r = $(selector).getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - npCenter) <= 2;
      });
      const npLayout = npStageStyle.display === 'flex' && npStageStyle.flexDirection === 'column' && npParts.every(Boolean);
      console.warn(`SELFTEST nplayout: centered=${npLayout} display=${npStageStyle.display} direction=${npStageStyle.flexDirection} parts=${npParts.join('/')}`);
      if (extra.includes('real')) {
        // настоящая мышь: сначала мимо карточки, потом на её центр (как это делает человек); сначала «ранее», потом «далее»
        for (const d of [-1, 1]) {
          const side = [...$$('.cf-item')].find((x) => +x.dataset.qi === Player.index + d);
          if (!side) {
            console.warn(`SELFTEST nphover ${d}: нет карточки`);
            continue;
          }
          const r = side.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          await window.zvuk.debug.mouse(x, 20);
          await wait(250);
          for (let k = 1; k <= 8; k++) {
            await window.zvuk.debug.mouse(x, 20 + ((y - 20) * k) / 8);
            await wait(40);
          }
          // немного «поводить» внутри — проверка, что наведение не дёргается
          for (let k = 0; k < 10; k++) {
            await window.zvuk.debug.mouse(x + Math.sin(k) * r.width * 0.25, y + Math.cos(k) * r.height * 0.25);
            await wait(50);
          }
          await window.zvuk.debug.mouse(x + r.width * 0.15, y - r.height * 0.15);
          await wait(1200);
          const hit = document.elementFromPoint(x, y);
          const chain = [];
          for (let e = hit; e && chain.length < 4; e = e.parentElement) chain.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : ''));
          console.warn(`SELFTEST nphover ${d > 0 ? 'next' : 'prev'}: hover=${side.classList.contains('hover')} matches=${side.matches(':hover')} card=${getComputedStyle(side.firstChild).transform.slice(0, 48)} hit=${chain.join(' < ')}`);
        }
      } else if (extra.includes('hover')) {
        const side = [...$$('.cf-item')].find((x) => +x.dataset.qi === Player.index + 1);
        if (side) {
          const r = side.getBoundingClientRect();
          const ev = { clientX: r.left + r.width * 0.7, clientY: r.top + r.height * 0.3, bubbles: true };
          side.dispatchEvent(new PointerEvent('pointerenter', ev));
          side.dispatchEvent(new PointerEvent('pointermove', ev));
        }
        await wait(1200);
      } else if (extra === 'npcurrent') {
        const current = $('.cf-item.cur');
        const r = current.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await window.zvuk.debug.mouse(x, 20);
        await wait(150);
        await window.zvuk.debug.mouse(x, y);
        await wait(500);
        await window.zvuk.debug.mouse(x + r.width * 0.22, y - r.height * 0.18);
        await wait(300);
        const tilt = current.querySelector('.cf-tilt');
        const card = current.querySelector('.cf-card');
        const shine = Number(getComputedStyle(current.querySelector('.cf-shine')).opacity);
        const source = $('#npSource').getBoundingClientRect();
        const sourceError = Math.abs(source.left + source.width / 2 - innerWidth / 2);
        const result = {
          hover: current.matches(':hover'), noPlay: !current.querySelector('.cf-play'), shine,
          rx: parseFloat(tilt.style.getPropertyValue('--rx')), mx: parseFloat(card.style.getPropertyValue('--mx')),
          zoom: getComputedStyle(current).getPropertyValue('--art-scale').trim(), lift: card.style.getPropertyValue('--hz'), sourceError,
        };
        result.pass = result.hover && result.noPlay && result.shine > 0.7 && Math.abs(result.rx) > 1 && Math.abs(result.mx) > 1 && result.zoom === '1.06' && result.lift === '36px' && sourceError < 2;
        console.warn('SELFTEST npcurrent: ' + JSON.stringify(result));
      }
      if (extra.includes('viz')) {
        $('.vz-gear') && $('.vz-gear').click();
        await wait(600);
        console.warn(`SELFTEST npviz: vizOn=${NP.vizOn} canvas=${Boolean($('#npScene canvas'))} level=${Viz.level.toFixed(3)} appHidden=${document.body.classList.contains('np-open')}`);
      }
    } else if (extra === 'voldrag' || extra === 'minieq') {
      // настоящая мышь: зажать полоску громкости и тянуть — полоска должна идти за курсором до отпускания
      const M = window.zvuk.debug.mouse;
      const dragVol = async (el, tag) => {
        const r = el.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const at = (p) => r.left + r.width * p;
        await M(at(0.85), y);
        await wait(150);
        await M(at(0.85), y, 'mousePressed');
        const seen = [];
        for (let k = 1; k <= 6; k++) {
          await M(at(0.85 - k * 0.1), y, 'mouseDragged');
          await wait(90);
          seen.push(parseFloat(el.querySelector('.fill').style.width).toFixed(0));
        }
        await M(at(0.25), y, 'mouseReleased');
        await wait(200);
        console.warn(`SELFTEST voldrag ${tag}: fill during drag=${seen.join(',')}% final=${parseFloat(el.querySelector('.fill').style.width).toFixed(0)}% volume=${Player.volume.toFixed(2)} label=${$('#npVolVal').textContent}`);
      };
      const l = firstList();
      if (l) Player.cue(l.tracks, Math.min(2, l.tracks.length - 1), 0, l.source);
      await wait(800);
      if (extra === 'voldrag') await dragVol($('#vol'), 'bar');
      else {
        openNowPlaying();
        await wait(1500);
        await dragVol($('#npVol'), 'np');
        console.warn(`SELFTEST npvol mirrored: bar=${parseFloat($('#vol .fill').style.width).toFixed(0)}%`);
        $('#npEqBtn').click();
        await wait(500);
        $('#npEq [data-eqp="rock"]').click();
        await wait(300);
        // тянем полосу 64 Гц вниз настоящей мышью
        const tr = $$('#npEq .vs')[1].querySelector('.track').getBoundingClientRect();
        const cx = tr.left + tr.width / 2;
        await M(cx, tr.top + tr.height * 0.3);
        await M(cx, tr.top + tr.height * 0.3, 'mousePressed');
        for (let k = 1; k <= 5; k++) {
          await M(cx, tr.top + tr.height * (0.3 + k * 0.08), 'mouseDragged');
          await wait(60);
        }
        await M(cx, tr.top + tr.height * 0.7, 'mouseReleased');
        await wait(300);
        console.warn(`SELFTEST npeq: open=${NP.eqOpen} enabled=${AudioFX.eq.enabled} preset=${AudioFX.eq.preset} bands=${AudioFX.eq.bands.join('/')} state=${$('#npEq .ne-state').textContent} plBtnOn=${$('#plEqBtn').classList.contains('on')}`);
        await M(tr.left + tr.width / 2, tr.top + tr.height * 0.7);
        await wait(400);
      }
    } else if (extra === 'clipfeedback') {
      // Локальная регрессия семи исправлений. YouTube здесь не подменяется и не проверяется:
      // mock-mount нужен только для синхронных команд seekTo и setPlaybackQuality.
      navigate('settings');
      await wait(650);
      const settingsStates = {};
      for (const key of ['clipRestart', 'clipKeepPaused', 'inkEnabled']) {
        const b = $(`#clipPrefs [data-vpref="${key}"]`);
        if (!b) {
          settingsStates[key] = false;
          continue;
        }
        const before = Clip.pref(key);
        b.click();
        await wait(100);
        const saved = await window.zvuk.settings.get();
        settingsStates[key] = Clip.pref(key) !== before && b.getAttribute('aria-pressed') === String(Clip.pref(key)) && saved.viz?.[key] === Clip.pref(key);
      }
      const prefsOk = Object.values(settingsStates).every(Boolean);
      console.warn(`SELFTEST clipprefs settings: ${JSON.stringify(settingsStates)} pass=${prefsOk}`);

      let l = firstList();
      if (!l) {
        const r = await api('getRelease', '6233892');
        l = { tracks: r.tracks.map((t) => ({ ...t, release: { id: r.id, title: r.title, image: r.image } })), source: { kind: 'list', title: r.title } };
      }
      Player.cue(l.tracks, Math.min(2, l.tracks.length - 1), 0, { kind: 'list', title: 'Музыкальная орбита · очень длинное название источника без обрезанных букв' });
      await wait(650);
      const tid = String(Player.current.id);
      Clip.trackId = tid;
      Clip.entry = { cands: [], pick: null, manual: null, offset: 0, auto: null };
      Clip.status = 'ok';
      App.settings.viz.bg = 'clip';
      NP.vizOn = true;
      openNowPlaying();
      await wait(800);
      $('#npTitle').textContent = 'Firestarter — Orbital Resonance';
      $('#npArtist').textContent = 'VALORANT, Grabbitz, Oli Sykes, Courtney LaPlante';
      $('#npSource').textContent = 'Сейчас играет · Музыкальная орбита · длинное название источника';
      const fake = document.createElement('div');
      fake.className = 'vz-img';
      fake.style.cssText = 'position:absolute;inset:0;background:linear-gradient(105deg,#0c1424 0 34%,#eef5ff 45% 66%,#111a2c 77% 100%)';
      $('#nowPlaying .vz-media').appendChild(fake);

      $('#nowPlaying .vz-gear')?.click();
      await wait(300);
      const panelStates = {};
      for (const key of ['clipRestart', 'clipKeepPaused', 'inkEnabled']) {
        const b = $(`#nowPlaying .vz-panel [data-vpref="${key}"]`);
        if (!b) {
          panelStates[key] = false;
          continue;
        }
        const before = Clip.pref(key);
        b.click();
        await wait(100);
        const current = $(`#nowPlaying .vz-panel [data-vpref="${key}"]`);
        const saved = await window.zvuk.settings.get();
        panelStates[key] = Clip.pref(key) !== before && current?.getAttribute('aria-pressed') === String(Clip.pref(key)) && saved.viz?.[key] === Clip.pref(key);
      }
      const panelOk = Object.values(panelStates).every(Boolean);
      console.warn(`SELFTEST clipprefs visualizer: ${JSON.stringify(panelStates)} pass=${panelOk}`);
      $('#nowPlaying .vz-gear')?.click();

      Clip.setPreference('inkEnabled', true);
      Ink.stop();
      Ink.start();
      await wait(1200);
      const boxes = ['#npSource', '#npTitle', '#npArtist'].map((selector) => {
        const el = $(selector);
        const b = Ink._boxForTest(el);
        const contains = Boolean(b && b.cssLeft <= b.textLeft + 0.01 && b.cssLeft + b.cssWidth >= b.textLeft + b.textWidth - 0.01);
        return { selector, contains, cssLeft: b?.cssLeft, cssWidth: b?.cssWidth, textLeft: b?.textLeft, textWidth: b?.textWidth };
      });
      const boxesOk = boxes.every((b) => b.contains);
      console.warn(`SELFTEST cliptext boxes: ${JSON.stringify(boxes)} pass=${boxesOk}`);

      Clip.setPreference('inkEnabled', false);
      await wait(120);
      const inkOff = Ink.stats.active === 0 && !$('#nowPlaying .ink-text') && ['#npSource', '#npTitle', '#npArtist'].every((s) => !$(s).style.backgroundImage && getComputedStyle($(s)).webkitTextStrokeWidth === '0px');
      Clip.setPreference('inkEnabled', true);
      Ink.start();
      console.warn(`SELFTEST clipprefs inkOff=${inkOff}`);

      const oldSeek = Player.seek;
      let restartSeeks = 0;
      Player.seek = () => restartSeeks++;
      Clip.setPreference('clipRestart', false);
      const holdResult = Clip._restartAfterSync();
      Player.seek = oldSeek;
      const holdOk = holdResult === 'hold' && restartSeeks === 0;
      console.warn(`SELFTEST cliprestart hold=${holdResult} seeks=${restartSeeks} pass=${holdOk}`);

      // Только политика уведомления: реальная видимость YouTube этим тестом не доказывается.
      Clip.entry = { cands: [{ id: 'synthetic-video' }], pick: 0, manual: null, offset: 0, auto: null };
      App.settings.viz.bg = 'cover';
      const oldFind = window.zvuk.yt.find;
      let disabledLookups = 0;
      window.zvuk.yt.find = async (...args) => {
        disabledLookups++;
        return oldFind(...args);
      };
      const disabledNeed = await ClipOffer.need(Player.current);
      window.zvuk.yt.find = oldFind;
      App.settings.viz.bg = 'clip';
      const oldVisible = ClipOffer.clipVisible;
      ClipOffer.clipVisible = () => false;
      const hiddenNeed = await ClipOffer.need(Player.current);
      ClipOffer.clipVisible = () => true;
      const visibleNeed = await ClipOffer.need(Player.current);
      ClipOffer.clipVisible = oldVisible;
      const offerPolicy = disabledNeed === null && disabledLookups === 0 && hiddenNeed === null && visibleNeed?.sync === true && !('clip' in visibleNeed);
      console.warn(`SELFTEST clipoffer policy-test disabledNeed=${disabledNeed === null} disabledLookups=${disabledLookups} hiddenNeed=${hiddenNeed === null} visibleSync=${visibleNeed?.sync} syncOnly=${visibleNeed && !('clip' in visibleNeed)} pass=${offerPolicy}`);

      const oldAuto = Clip.auto;
      App.settings.viz.clipAuto = true;
      Clip._wantTrack = tid;
      Clip._cal = false;
      Clip._calKey = tid + '|synthetic-video';
      Clip.sync = { state: 'fail', message: 'synthetic failure' };
      const failedDue = Clip._calibrationDueForTest({ state: 1, lastSeek: 0 }, 100000);
      Clip._calKey = '';
      const freshDue = Clip._calibrationDueForTest({ state: 1, lastSeek: 0 }, 100000);
      const noRetry = failedDue === false && freshDue === true;
      App.settings.viz.clipAuto = oldAuto;
      Clip.sync = { state: 'idle', message: '' };
      console.warn(`SELFTEST clipretry failedDue=${failedDue} freshDue=${freshDue} pass=${noRetry}`);

      const sent = [];
      const iframe = { contentWindow: { postMessage: (raw) => sent.push(JSON.parse(raw)) } };
      const mock = {
        iframe, ready: true, state: 1, time: 0, timeAt: performance.now(),
        box: { classList: { remove() {} } }, driftFilter: { reset() {} },
      };
      Clip._seekForTest(mock, 42.25);
      const seekCmd = sent.find((c) => c.func === 'seekTo');
      const seekOk = seekCmd?.args?.[0] === 42.25 && mock.seekTarget === 42.25 && mock.seekSentAt > 0;
      const oldQuality = Clip.quality;
      App.settings.viz.clipQ = '2160';
      const quality2160 = Clip._qualityForTest(mock);
      const q4k = sent.some((c) => c.func === 'setPlaybackQualityRange' && c.args?.[0] === 'hd2160' && c.args?.[1] === 'hd2160') && sent.some((c) => c.func === 'setPlaybackQuality' && c.args?.[0] === 'hd2160');
      App.settings.viz.clipQ = 'auto';
      Clip._qualityForTest(mock);
      const autoRelease = sent.some((c) => c.func === 'setPlaybackQualityRange' && c.args?.[0] === 'default' && c.args?.[1] === 'highres') && sent.some((c) => c.func === 'setPlaybackQuality' && c.args?.[0] === 'default');
      App.settings.viz.clipQ = oldQuality;
      const commandsOk = seekOk && q4k && autoRelease && mock.iframe === iframe && quality2160.wanted === 'hd2160';
      console.warn(`SELFTEST clipcommands synthetic seek=${seekOk} q4k=${q4k} autoRelease=${autoRelease} sameFrame=${mock.iframe === iframe} pass=${commandsOk}`);

      const all = prefsOk && panelOk && boxesOk && inkOff && holdOk && offerPolicy && noRetry && commandsOk;
      console.warn(`SELFTEST clipfeedback: pass=${all}`);
      if (!all) console.error('SELFTEST clipfeedback: один или несколько локальных тестов не пройдены');
      await wait(2800);
    } else if (extra === 'clippause') {
      const until = async (fn, timeout = 20000) => {
        const started = performance.now();
        while (performance.now() - started < timeout) {
          try { if (fn()) return true; } catch {}
          await wait(200);
        }
        return false;
      };
      const visibleMount = () => Clip._debugMounts().find((m) => m.connected && m.ready && m.on);
      App.settings.viz.bg = 'clip';
      App.settings.viz.style = 'waves';
      await silentPlay(2);
      NP.vizOn = true;
      openNowPlaying();
      await wait(1000);
      await Clip.setLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      const result = { playing: false, hold: false, resume: false, currentMode: false, reopen: false };
      result.playing = await until(() => visibleMount()?.state === 1, 25000);
      Clip.setPreference('clipKeepPaused', true);
      Player.pause();
      const held = await until(() => Player.audio.paused && visibleMount()?.state === 2, 7000);
      await wait(500);
      const timeA = visibleMount()?.time;
      await wait(900);
      const timeB = visibleMount()?.time;
      result.hold = held && Boolean(visibleMount()) && (timeA == null || timeB == null || Math.abs(timeA - timeB) < 0.08);
      Player.toggle();
      result.resume = await until(() => !Player.audio.paused && visibleMount()?.state === 1, 9000);
      Player.pause();
      await until(() => Player.audio.paused, 3000);
      Clip.setPreference('clipKeepPaused', false);
      result.currentMode = await until(() => {
        const mounts = Clip._debugMounts().filter((m) => m.connected && m.ready);
        return mounts.length > 0 && mounts.every((m) => !m.on && m.state !== 1);
      }, 7000);
      Clip.setPreference('clipKeepPaused', true);
      result.reopen = await until(() => Player.audio.paused && visibleMount()?.state === 2, 7000);
      result.pass = Object.entries(result).filter(([key]) => key !== 'pass').every(([, value]) => value === true);
      console.warn(`SELFTEST clippause: ${JSON.stringify(result)} mounts=${JSON.stringify(Clip._debugMounts())}`);
    } else if (extra === 'ink' || extra === 'inkclip') {
      // «Чернила»: элементы над светлым фоном темнеют, над тёмным — остаются светлыми
      const name = (el) => el.id || [...el.classList].filter((c) => c !== 'inkable').slice(0, 2).join('.');
      const report = (tag) => console.warn(`SELFTEST ink ${tag}: ` + Ink.state.map((s) => `${name(s.el)}=${s.luma.toFixed(2)}${s.target ? '●' : '○'}`).join(' '));
      if (extra === 'inkclip') {
        App.settings.viz.bg = 'clip';
        App.settings.viz.style = 'waves';
      }
      await silentPlay(2);
      NP.vizOn = true;
      openNowPlaying();
      await wait(2000);
      if (extra === 'ink') {
        const fake = document.createElement('div');
        fake.className = 'vz-img';
        fake.style.cssText = 'position:absolute;inset:0;background:linear-gradient(90deg,#f2f2f2 0 50%,#0e0e12 50% 100%)';
        $('#nowPlaying .vz-media').appendChild(fake);
        await wait(2500);
        report('split');
        const outlined = Ink.state.filter((s) => s.text);
        const outlineOk = outlined.length >= 2 && outlined.every((s) => parseFloat(getComputedStyle(s.el).webkitTextStrokeWidth) > 0 && getComputedStyle(s.el).backgroundImage === 'none');
        console.warn(`SELFTEST outline: elements=${outlined.length} pass=${outlineOk} stroke=${getComputedStyle($('#npTitle')).webkitTextStrokeWidth} color=${getComputedStyle($('#npTitle')).webkitTextStrokeColor} frameMs=${Ink.stats.frameMs.toFixed(1)} period=${Ink.stats.period}`);
        const decisionOk = Ink._test.desiredInk(0.92, 0) === 1 && Ink._test.desiredInk(0.47, 0) === 0 && Ink._test.desiredInk(0.47, 1) === 1 && Ink._test.desiredInk(0.05, 1) === 0;
        const antiFlicker = Ink._test.history >= 5 && Ink._test.fade >= 800 && Ink._test.cooldown >= 1000;
        const shadeSamples = [0.5, 0.55, 0.65, 0.85, 0.98].map((l) => ({ l, rgb: Ink._test.darkRGB(l) }));
        const pureBlack = shadeSamples.every((s) => s.rgb.every((v) => v === 0));
        const shadeContrast = shadeSamples.every((s) => Ink._test.contrast(s.l, Ink._test.rgbLuma(s.rgb)) >= 3);
        const shadesOk = pureBlack && shadeContrast;
        let previousTarget = Ink.state.find((s) => s.el.id === 'npTitle')?.target;
        let rapidFlips = 0;
        for (let i = 0; i < 14; i++) {
          fake.style.background = i % 2 ? '#f4f4f4' : '#0e0e12';
          await wait(190);
          const target = Ink.state.find((s) => s.el.id === 'npTitle')?.target;
          if (previousTarget != null && target != null && target !== previousTarget) rapidFlips++;
          previousTarget = target;
        }
        const rapidOk = rapidFlips <= 2;
        console.warn(`SELFTEST ink-precision: outline=${outlineOk} decisions=${decisionOk} hysteresis=${antiFlicker} rapidFlips=${rapidFlips} rapidOk=${rapidOk} shades=${shadesOk} palette=${JSON.stringify(shadeSamples)}`);
        if (!outlineOk || !decisionOk || !antiFlicker || !rapidOk || !shadesOk) console.error('SELFTEST ink-precision: FAILED');
        fake.style.background = '#f4f4f4';
        await wait(2000);
        const darkTextStyle = getComputedStyle($('#npTitle'));
        const noWhiteGlow = pureBlack && Ink.state.find((s) => s.el.id === 'npTitle')?.ink > 0.98 && !/(?:255|245|250)/.test(darkTextStyle.textShadow + darkTextStyle.webkitTextStrokeColor);
        console.warn(`SELFTEST ink white: dark=${Ink.state.filter((s) => s.target).length}/${Ink.state.length} pureBlack=${pureBlack} noWhiteGlow=${noWhiteGlow} shadow=${darkTextStyle.textShadow} stroke=${darkTextStyle.webkitTextStrokeColor}`);
        if (!noWhiteGlow) console.error('SELFTEST ink black glow: FAILED');
        fake.style.background = 'linear-gradient(90deg,#f2f2f2 0 50%,#0e0e12 50% 100%)';
        await wait(2200);
      } else {
        await Clip.setLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        await wait(9000);
        const box = $('#nowPlaying .clip-box');
        const r = box ? box.getBoundingClientRect() : null;
        const on = await Ink.debugLuma(r);
        const frame = $('#nowPlaying .clip-frame, #nowPlaying .clip-box iframe');
        if (frame) frame.style.visibility = 'hidden';
        await wait(400);
        const off = await Ink.debugLuma(r);
        if (frame) frame.style.visibility = '';
        let resizes = 0;
        const onRs = () => resizes++;
        window.addEventListener("resize", onRs);
        window.visualViewport && window.visualViewport.addEventListener("resize", onRs);
        const t0 = performance.now();
        for (let k = 0; k < 10; k++) await window.zvuk.ui.probe(240);
        console.warn(`SELFTEST inkclip: clipOn=${box && box.classList.contains('clip-on')} lumaWithClip=${on && on.mean.toFixed(3)} lumaHidden=${off && off.mean.toFixed(3)} size=${on && on.size} probeMs=${((performance.now() - t0) / 10).toFixed(1)} resizesDuringProbes=${resizes}`);
        await wait(1500);
        report('clip');
      }
    } else if (extra === 'eqpresets') {
      // Свои пресеты эквалайзера: «Свой» не пропадает при переключении, свои с названиями
      const E = AudioFX;
      const show = () => `${E.eq.preset}:${E.eq.bands.slice(0, 3).join('/')}`;
      E.setPreset('rock');
      E.setBand(0, 9);
      E.setBand(1, -6);
      const afterEdit = show();
      E.setPreset('pop');
      const onPop = show();
      E.setPreset('custom');
      const backToCustom = show();
      const id = E.savePreset('Мой бас');
      E.setBand(2, 4);
      E.setPreset('rock');
      E.setPreset(id);
      const backToUser = show();
      const id2 = E.savePreset('Ночной мой');
      E.setBand(0, -3);
      E.renamePreset(id2, 'Тихий');
      E.deletePreset(id2);
      console.warn(`SELFTEST eqpresets: edit=${afterEdit} pop=${onPop} custom=${backToCustom} user=${backToUser} afterDelete=${show()} users=${E.eq.user.map((p) => p.name).join(',')} name=${E.presetName(id)}`);
      E.setPreset(id);
      App.rerender();
      await wait(900);
    } else if (extra === 'whatsnew') {
      // Плашка после обновления с последней публичной версии: все изменения объединены в 3.0.0.
      App.settings.seenVersion = '2.3.3';
      App.settings.freshInstall = false;
      await App.whatsNew(false, '3.0.0');
      await wait(700);
      const shownVersion = $('.wn-tt h3')?.textContent || '';
      const wnItems = $$('.wn-item').length;
      console.warn(`SELFTEST whatsnew: shown=${Boolean($('.wn-back'))} items=${wnItems} seen=${App.settings.seenVersion} title=${shownVersion} current=${shownVersion === 'Zvuk Glass 3.0.0'} consolidated=${wnItems === 7}`);
    } else if (extra === 'lyrext') {
      // Тексты: сколько треков чарта без синхронизированного текста в Zvuk и сколько из них нашлось в LRCLIB
      const pop = await api('popular');
      const tracks = (pop.top?.tracks || []).slice(0, 25);
      const stat = { synced: 0, plain: 0, none: 0, extSynced: 0, extPlain: 0, extNone: 0 };
      let sample = null;
      for (const t of tracks) {
        let z = null;
        try {
          z = parseLyrics(await api('getLyrics', t.id));
        } catch {}
        if (z && z.synced) {
          stat.synced++;
          continue;
        }
        stat[z ? 'plain' : 'none']++;
        const ext = await window.zvuk.lyrics.external(t);
        const p = ext && ext.text ? parseLyrics({ text: ext.text }) : null;
        if (p && p.synced) {
          stat.extSynced++;
          if (!sample) sample = { t, p };
        } else stat[p ? 'extPlain' : 'extNone']++;
      }
      console.warn(`SELFTEST lyrext chart25: ${JSON.stringify(stat)}`);
      // показываем найденный текст в полноэкранном плеере и сдвигаем время
      const t = sample ? sample.t : tracks[0];
      Player.playList([t], 0, { kind: 'list', title: 'Тест' });
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      if (sample) App.lyrics = { trackId: t.id, data: sample.p, loading: false, source: 'lrclib', offset: 0 };
      NP.lyricsOn = true;
      NP.vizOn = false;
      openNowPlaying();
      await wait(3000);
      const lineAt = () => $$('#npLyrics .ln').findIndex((x) => x.classList.contains('cur'));
      const before = lineAt();
      $('#npLyrSrc [data-act="lyr-off"][data-d="0.25"]')?.click();
      $('#npLyrSrc [data-act="lyr-off"][data-d="0.25"]')?.click();
      await wait(300);
      console.warn(`SELFTEST lyrext show: track=${t.title} lines=${sample ? sample.p.lines.length : 0} src=${$('#npLyrSrc .lyr-src span:not(.i)')?.textContent} offset=${$('#npLyrSrc .lyr-off b')?.textContent} curLine=${before}->${lineAt()} t=${Player.audio.currentTime.toFixed(1)}`);
      await wait(1500);
    } else if (extra === 'artistpop') {
      const rows = () => $$('#popTracks .tr').length;
      const btn = () => $('#popSec .pop-more [data-act="expand-pop"]');
      console.warn(`SELFTEST artistpop start: rows=${rows()} btn=${btn() && btn().textContent}`);
      btn() && btn().click();
      await wait(4000);
      console.warn(`SELFTEST artistpop expanded: rows=${rows()} count=${$('#popCount').textContent} btn=${btn() && btn().textContent}`);
      btn() && btn().click();
      await wait(1500);
      const ids = $$('#popTracks .tr').map((r) => r.dataset.track);
      console.warn(`SELFTEST artistpop more: rows=${rows()} unique=${new Set(ids).size} btn=${btn() && btn().textContent} listLen=${UI.Lists.get($('#popTracks .tr').dataset.list).tracks.length}`);
      $('#popTracks .tr:nth-child(25) [data-act="play-row"]')?.click();
      await wait(1500);
      console.warn(`SELFTEST artistpop play: queue=${Player.queue.length} index=${Player.index}`);
      Player.pause();
      $('#popSec').scrollIntoView();
      await wait(600);
    } else if (extra === 'popular') {
      console.warn(`SELFTEST popular: top=${$$('#topList .tr').length} shelves=${$$('#view .section').length} cards=${$$('#view .card').length} podium=${$$('.tp-card').length}`);
      // сворачивание окна: всё, что рисует, должно встать, после разворота — продолжить
      await silentPlay(0);
      const vt = () => Viz._frames || 0;
      document.querySelector('.wc-min').click();
      await wait(1500);
      const f0 = vt();
      await wait(1000);
      console.warn(`SELFTEST minimized: winHidden=${document.body.classList.contains('win-hidden')} vizHidden=${Viz.hidden} clipHidden=${Clip.hidden} framesWhileHidden=${vt() - f0} playing=${!Player.audio.paused}`);
      document.querySelector('.wc-max').click();
      await wait(1500);
      const f1 = vt();
      await wait(1000);
      console.warn(`SELFTEST restored: winHidden=${document.body.classList.contains('win-hidden')} vizHidden=${Viz.hidden} frames=${vt() - f1}`);
      Player.pause();
      await wait(2500);
      const f2 = vt();
      await wait(1000);
      console.warn(`SELFTEST paused: framesPerSec=${vt() - f2} (мини-визуализатор спит)`);
      $('#scroller').scrollTop = 1180;
      await wait(1200);
    } else if (extra === 'vizoff') {
      await silentPlay(0);
      $('.vz-gear')?.click();
      await wait(150);
      $('[data-vk="style"][data-vv="particles"]')?.click();
      await wait(650);
      const hasPixels = () => {
        const canvas = $('.vz-canvas');
        if (!canvas?.width || !canvas.height) return false;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 16) if (data[i]) return true;
        return false;
      };
      const hadEffect = hasPixels();
      Player.pause();
      await wait(120);
      $('[data-vk="style"][data-vv="off"]')?.click();
      await wait(140);
      const result = { hadEffect, paused: Player.audio.paused, styleOff: App.settings.viz.style === 'off', cleared: !hasPixels() };
      result.pass = Object.values(result).every((value) => value === true);
      console.warn(`SELFTEST vizoff: ${JSON.stringify(result)}`);
    } else if (extra === 'npvizimpact') {
      await silentPlay(0);
      NP.vizOn = true;
      openNowPlaying();
      await wait(1300);
      const gear = $('.np .vz-gear');
      const panel = $('.np .vz-controls');
      gear?.click();
      await wait(350);
      panel?.querySelector('[data-vk="style"][data-vv="impact"]')?.click();
      const style = App.settings.viz.style === 'impact';
      const layer = $('.np .cf-item.cur .cf-art');
      const media = $('.np .vz-media');
      const stage = $('.np-stage');
      const matrixScale = (el) => {
        const value = getComputedStyle(el).transform;
        const match = value && value !== 'none' ? value.match(/^matrix\(([^,]+)/) : null;
        return match ? Number(match[1]) : 1;
      };
      const stageTransform = getComputedStyle(stage).transform;
      const panelTransform = getComputedStyle(panel).transform;
      let controlsFixed = Boolean(layer && !layer.contains(stage) && !layer.contains(panel) && !panel.classList.contains('hidden'));
      const sample = async (target) => {
        let minScale = matrixScale(target);
        let maxScale = minScale;
        let minWidth = target.getBoundingClientRect().width;
        let maxWidth = minWidth;
        let maxPunch = 1;
        let maxLight = 1;
        for (let i = 0; i < 60; i++) {
          await wait(60);
          const punch = Number(getComputedStyle(target).getPropertyValue('--bass-punch')) || 1;
          const light = Number(getComputedStyle(target).getPropertyValue('--bass-light')) || 1;
          const scale = matrixScale(target);
          const width = target.getBoundingClientRect().width;
          maxPunch = Math.max(maxPunch, punch);
          maxLight = Math.max(maxLight, light);
          minScale = Math.min(minScale, scale);
          maxScale = Math.max(maxScale, scale);
          minWidth = Math.min(minWidth, width);
          maxWidth = Math.max(maxWidth, width);
          controlsFixed = controlsFixed && getComputedStyle(stage).transform === stageTransform && getComputedStyle(panel).transform === panelTransform;
        }
        return { maxPunch, maxLight, minScale, maxScale, layerDelta: maxWidth - minWidth,
          effect: maxPunch > 1.0001 && maxLight > 1.0001 && maxScale > 1.0001 && maxScale - minScale > 0.0001 };
      };
      // Детерминированный бас проверяет именно видимую обложку и обёртку клипа.
      const analyser = AudioFX.analyser;
      const readFrequency = analyser.getByteFrequencyData;
      analyser.getByteFrequencyData = (data) => {
        const strong = performance.now() % 720 < 180;
        data.fill(strong ? 35 : 12);
        for (let i = 0; i < Math.min(12, data.length); i++) data[i] = strong ? 245 : 25;
      };
      let cover;
      let clip;
      let coverOffScale = 1;
      let clipOffScale = 1;
      let coverAfterClip = 1;
      const hadClipBox = media.classList.contains('clip-box');
      const hadClipOn = media.classList.contains('clip-on');
      try {
        cover = await sample(layer);
        panel?.querySelector('[data-vk="style"][data-vv="off"]')?.click();
        await wait(140);
        coverOffScale = matrixScale(layer);
        media.classList.add('clip-box', 'clip-on');
        panel?.querySelector('[data-vk="style"][data-vv="impact"]')?.click();
        clip = await sample(media);
        coverAfterClip = matrixScale(layer);
        panel?.querySelector('[data-vk="style"][data-vv="off"]')?.click();
        await wait(140);
        clipOffScale = matrixScale(media);
      } finally {
        analyser.getByteFrequencyData = readFrequency;
        media.classList.toggle('clip-box', hadClipBox);
        media.classList.toggle('clip-on', hadClipOn);
      }
      const result = {
        style, target: Boolean(layer && media), cover, clip, controlsFixed,
        coverOffScale, clipOffScale, coverAfterClip,
        offReset: Math.abs(coverOffScale - 1) < .0001 && Math.abs(clipOffScale - 1) < .0001 && Math.abs(coverAfterClip - 1) < .0001,
        layerMoves: cover.layerDelta > 1 && clip.layerDelta > 1,
      };
      result.pass = result.style && result.target && cover.effect && clip.effect && result.offReset && result.layerMoves && result.controlsFixed;
      console.warn(`SELFTEST npvizimpact: ${JSON.stringify(result)}`);
      panel?.querySelector('[data-vk="style"][data-vv="impact"]')?.click();
      panel?.querySelector('[data-vclose]')?.click();
      await wait(700);
    } else if (extra === 'vizimpact') {
      await silentPlay(0);
      $('.vz-gear')?.click();
      await wait(150);
      $('[data-vk="style"][data-vv="impact"]')?.click();
      $('[data-vclose]')?.click();
      let maxPunch = 1;
      let maxLight = 1;
      let maxScale = 1;
      let moderatePunch = 1;
      let maxTranslation = 0;
      let layer = null;
      const analyser = AudioFX.analyser;
      const readFrequency = analyser.getByteFrequencyData;
      const started = performance.now();
      analyser.getByteFrequencyData = (data) => {
        if (performance.now() - started > 2400) {
          data.fill(72);
          for (let i = 0; i < Math.min(12, data.length); i++) data[i] = 62;
          return;
        }
        const strong = performance.now() % 720 < 180;
        data.fill(strong ? 35 : 12);
        for (let i = 0; i < Math.min(12, data.length); i++) data[i] = strong ? 245 : 25;
      };
      try {
        for (let i = 0; i < 80; i++) {
          await wait(60);
          layer = $('.vz-stage .clip-box.clip-on') || $('.vz-stage .vz-cover');
          if (!layer) continue;
          const punch = Number(getComputedStyle(layer).getPropertyValue('--bass-punch')) || 1;
          maxPunch = Math.max(maxPunch, punch);
          if (i >= 40) moderatePunch = Math.max(moderatePunch, punch);
          maxLight = Math.max(maxLight, Number(getComputedStyle(layer).getPropertyValue('--bass-light')) || 1);
          const transform = getComputedStyle(layer).transform;
          const matrix = transform.match(/^matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
          maxScale = Math.max(maxScale, Number(matrix?.[0]) || 1);
          if (matrix?.length === 6) maxTranslation = Math.max(maxTranslation, Math.abs(matrix[4]), Math.abs(matrix[5]));
        }
      } finally {
        analyser.getByteFrequencyData = readFrequency;
      }
      const result = { style: App.settings.viz.style === 'impact', target: Boolean(layer), effect: maxPunch > 1.0001 && maxLight > 1.0001 && maxScale > 1.0001, moderateResponse: moderatePunch > 1.008, noShake: maxTranslation < .01, maxPunch, moderatePunch, maxLight, maxScale, maxTranslation };
      result.pass = result.style && result.target && result.effect && result.moderateResponse && result.noShake;
      console.warn(`SELFTEST vizimpact: ${JSON.stringify(result)}`);
    } else if (extra === 'clipoffset') {
      await silentPlay(0);
      NP.vizOn = true;
      openNowPlaying();
      await wait(1300);
      $('.np .vz-gear')?.click();
      let offset = null;
      for (let i = 0; i < 30 && !offset; i++) { offset = $('.np .vz-offset'); if (!offset) await wait(200); }
      offset?.scrollIntoView({ block: 'center' });
      await wait(250);
      const minus = offset?.querySelector('[data-vclip="minus"]')?.getBoundingClientRect();
      const value = offset?.querySelector('b')?.getBoundingClientRect();
      const plus = offset?.querySelector('[data-vclip="plus"]')?.getBoundingClientRect();
      const midpoint = minus && plus ? (minus.left + minus.width / 2 + plus.left + plus.width / 2) / 2 : 0;
      const centered = Boolean(value && midpoint && Math.abs(value.left + value.width / 2 - midpoint) <= 2);
      console.warn(`SELFTEST clipoffset: ${JSON.stringify({ visible: Boolean(offset), centered, pass: Boolean(offset && centered) })}`);
    } else if (extra === 'vizparticles') {
      await silentPlay(0);
      $('.vz-gear')?.click();
      await wait(160);
      $('[data-vk="style"][data-vv="particles"]')?.click();
      await wait(650);
      $('[data-vclose]')?.click();
      console.warn(`SELFTEST vizparticles: style=${App.settings.viz.style} bg=${App.settings.viz.bg} panelClosed=${$('.vz-controls')?.classList.contains('hidden')}`);
      await wait(450);
    } else if (extra === 'vizpanel' || extra === 'npvizpanel') {
      await silentPlay(0);
      if (extra === 'npvizpanel') {
        NP.vizOn = true;
        openNowPlaying();
        await wait(1300);
      }
      const scope = extra === 'npvizpanel' ? '.np' : '#vizStage';
      const gear = $(`${scope} .vz-gear`);
      const panel = $(`${scope} .vz-controls`);
      gear?.click();
      await wait(180);
      const result = { open: false, allStyles: false, presets: false, range: false, dim: false, close: false, reopened: false, gearVisible: false, separate: false };
      result.open = panel && !panel.classList.contains('hidden') && gear?.getAttribute('aria-expanded') === 'true';
      result.gearVisible = Boolean(gear && getComputedStyle(gear).display !== 'none' && gear.getBoundingClientRect().width > 0);
      const queueCount = $('#npQueueCount');
      if (extra === 'npvizpanel' && gear && queueCount && getComputedStyle(queueCount).display !== 'none') {
        const c = queueCount.getBoundingClientRect();
        const g = gear.getBoundingClientRect();
        result.separate = c.right <= g.left - 8;
      } else result.separate = true;
      let stylesOk = true;
      for (const style of VizScene.STYLES) {
        panel.querySelector(`[data-vk="style"][data-vv="${style.id}"]`)?.click();
        await wait(45);
        stylesOk = stylesOk && App.settings.viz.style === style.id && panel.querySelector(`[data-vv="${style.id}"]`)?.getAttribute('aria-pressed') === 'true';
      }
      result.allStyles = stylesOk;
      panel.querySelector('[data-vk="style"][data-vv="waves"]')?.click();
      let presetsOk = true;
      for (const value of [.65, 1.55, 1]) {
        panel.querySelector(`[data-vresponse="${value}"]`)?.click();
        presetsOk = presetsOk && App.settings.viz.sensitivity === value;
      }
      result.presets = presetsOk;
      const response = panel.querySelector('[data-vr="sensitivity"]');
      response.value = '.85';
      response.dispatchEvent(new Event('input', { bubbles: true }));
      result.range = App.settings.viz.sensitivity === .85 && panel.querySelector('[data-vvalue="sensitivity"]')?.textContent.includes('0,85');
      const dim = panel.querySelector('[data-vr="dim"]');
      dim.value = '47';
      dim.dispatchEvent(new Event('input', { bubbles: true }));
      result.dim = App.settings.viz.dim === 47 && panel.querySelector('[data-vvalue="dim"]')?.textContent === '47%';
      panel.querySelector('[data-vclose]')?.click();
      result.close = panel.classList.contains('hidden') && gear.getAttribute('aria-expanded') === 'false';
      gear.click();
      await wait(120);
      result.reopened = !panel.classList.contains('hidden') && App.settings.viz.sensitivity === .85 && App.settings.viz.dim === 47;
      result.pass = Object.values(result).every((value) => value === true);
      console.warn(`SELFTEST ${extra}: ${JSON.stringify(result)}`);
    } else if (extra === 'vizplay' || extra === 'eqplay') {
      await silentPlay(0);
      if (extra === 'eqplay') {
        AudioFX.setPreset('rock');
        await wait(800);
      }
      console.warn(`SELFTEST webaudio: ctx=${AudioFX.ctx?.state} level=${Viz.level.toFixed(3)} bass=${Viz.bass.toFixed(3)} paused=${Player.audio.paused} error=${Player.audio.error ? Player.audio.error.code : 'none'}`);
      // показать панели визуализатора на снимке
      const st = $('#vizStage');
      if (st) st.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      if (App.route?.view === 'equalizer') App.rerender();
      await wait(900);
    } else if (extra === 'eqlock') {
      const initial = structuredClone(AudioFX.eq);
      AudioFX.setLocked(false);
      AudioFX.setPreset('flat');
      await wait(80);
      $('#eqLock').click();
      await wait(420);
      const saved = await window.zvuk.settings.get();
      const result = {
        locked: AudioFX.eq.locked && $('#eqLock').getAttribute('aria-pressed') === 'true' && $('#eqPanel').classList.contains('locked') && $('#eqPresets [data-eqp="rock"]').disabled && getComputedStyle($('#eqPanel .vs')).pointerEvents === 'none',
        persisted: saved.eq?.locked === true,
        protected: false, unlocked: false, changed: false, restored: false,
      };
      $('#eqPresets [data-eqp="rock"]').click();
      result.protected = AudioFX.eq.preset === 'flat';
      $('#eqLock').click();
      await wait(100);
      result.unlocked = !AudioFX.eq.locked && !$('#eqPresets [data-eqp="rock"]').disabled;
      $('#eqPresets [data-eqp="rock"]').click();
      result.changed = AudioFX.eq.preset === 'rock';
      AudioFX.eq = { ...initial, bands: initial.bands.slice(), user: (initial.user || []).map((p) => ({ ...p, bands: p.bands.slice() })) };
      AudioFX._changed();
      result.restored = AudioFX.eq.preset === initial.preset;
      AudioFX.setLocked(true);
      result.pass = Object.entries(result).filter(([key]) => key !== 'pass').every(([, value]) => value === true);
      console.warn(`SELFTEST eqlock: ${JSON.stringify(result)}`);
    } else if (extra === 'headphoneeq' || extra === 'headphoneeqsony') {
      const initial = structuredClone(AudioFX.eq);
      if (AudioFX.eq.locked) {
        AudioFX.setLocked(false);
        await wait(60);
      }
      const result = { models: HeadphoneEQ.models.length, presets: {}, drawers: {}, standard: false, restored: false };
      for (const model of HeadphoneEQ.models) {
        const card = $(`[data-hq-model="${model.id}"]`);
        const toggle = card.querySelector('[data-hq-toggle]');
        toggle.click();
        await wait(520);
        const drawer = card.querySelector('.hq-drawer');
        result.drawers[model.id] = {
          open: card.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'true' && !drawer.inert && drawer.getBoundingClientRect().height > 100,
          presets: card.querySelectorAll('.hq-preset').length === model.presets.length,
        };
        for (const preset of model.presets) {
          card.querySelector(`[data-eqp="${preset.id}"]`).click();
          await wait(100);
          result.presets[preset.id] = AudioFX.eq.preset === preset.id && AudioFX.eq.enabled && AudioFX.eq.preamp === preset.preamp && preset.bands.every((v, i) => AudioFX.eq.bands[i] === v);
        }
        toggle.click();
        await wait(520);
        result.drawers[model.id].closed = !card.classList.contains('open') && drawer.inert && drawer.getBoundingClientRect().height < 5;
      }
      AudioFX.setPreset('rock');
      result.standard = AudioFX.eq.preset === 'rock' && AudioFX.presetName() === 'Рок';
      AudioFX.eq = { ...initial, bands: initial.bands.slice(), user: (initial.user || []).map((p) => ({ ...p, bands: p.bands.slice() })) };
      AudioFX._changed();
      result.restored = AudioFX.eq.preset === initial.preset && AudioFX.eq.bands.every((v, i) => v === initial.bands[i]);
      const shownModel = extra === 'headphoneeqsony' ? 'sony' : 'nothing';
      $(`[data-hq-toggle="${shownModel}"]`).click();
      await wait(600);
      $(`[data-hq-model="${shownModel}"]`).scrollIntoView({ block: 'start' });
      await wait(500);
      result.pass = result.models === 2 && result.standard && result.restored && Object.values(result.presets).every(Boolean) && Object.values(result.drawers).every((d) => d.open && d.presets && d.closed);
      console.warn(`SELFTEST headphoneeq: ${JSON.stringify(result)}`);
    } else if (extra === 'virtuallists') {
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      navigate('popular');
      for (let i = 0; i < 60 && !$('#topList .tr'); i++) await wait(250);
      if ($('#topList')?.classList.contains('collapsed')) $('[data-act="top-toggle"]').click();
      await wait(650);
      const root = $('#topList .tracks.virtualized');
      const list = root ? UI.Lists.get(root.dataset.listRoot) : null;
      const result = { virtualized: false, count: false, height: false, deepRows: false, click: false };
      if (root && list) {
        const total = list.tracks.length;
        result.virtualized = total >= 36 && root.dataset.virtualized === 'true';
        result.count = root.querySelectorAll('.tr').length > 0 && root.querySelectorAll('.tr').length < total;
        result.height = root.scrollHeight >= total * 55;
        const sc = $('#scroller');
        const rootTop = root.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        sc.scrollTop = rootTop + 60 * 60;
        await wait(600);
        const rows = [...root.querySelectorAll('.tr')];
        const target = rows[Math.min(2, rows.length - 1)];
        const index = Number(target?.dataset.idx);
        if (target) {
          result.deepRows = Number(rows[0].dataset.idx) > 30 && Number(target.dataset.idx) === index;
          target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          await wait(450);
          result.click = String(Player.current?.id) === String(list.tracks[index]?.id);
        }
        sc.scrollTop = 0;
        await wait(350);
      }
      result.pass = Object.entries(result).filter(([key]) => key !== 'pass').every(([, value]) => value === true);
      console.warn(`SELFTEST virtuallists: ${JSON.stringify(result)} domRows=${root?.querySelectorAll('.tr').length || 0} total=${list?.tracks.length || 0}`);
    } else if (extra === 'quality') {
      App.setPerformanceMode(App.settings.performanceMode || 'auto');
      const initial = App.settings.performanceMode;
      const result = { buttons: false, saved: false, eco: false, full: false, legacy: false, restored: false };
      navigate('settings');
      await wait(750);
      result.buttons = $$('[data-act="performance-mode"]').length === 3;
      for (const mode of ['full', 'eco']) {
        const button = $(`[data-act="performance-mode"][data-mode="${mode}"]`);
        button.click();
        await wait(420);
        result[mode] = App.settings.performanceMode === mode && button.classList.contains('on') && (mode !== 'eco' || document.body.classList.contains('perf-eco'));
      }
      const saved = await window.zvuk.settings.get();
      result.saved = saved.performanceMode === 'eco';
      navigate('wave');
      await wait(650);
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      for (let i = 0; i < 72 && (!Player.current || Player.audio.paused); i++) await wait(250);
      const r = $('#waveFocusBtn').getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (let attempt = 0; attempt < 2 && !document.body.classList.contains('wave-focus'); attempt++) {
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
        await wait(350);
      }
      for (let i = 0; i < 70 && !($('.wv-hero')?._orbit3d?.getStats().frames > 4); i++) await wait(150);
      const orbit = $('.wv-hero')?._orbit3d;
      if (orbit) {
        const fullDpr = orbit.getStats().pixelRatio;
        App.setPerformanceMode('eco');
        await wait(250);
        result.eco = orbit.getStats().performanceMode === 'eco' && orbit.getStats().pixelRatio === fullDpr;
        App.setPerformanceMode('full');
        await wait(250);
        result.full = orbit.getStats().performanceMode === 'full' && orbit.getStats().pixelRatio === fullDpr;
        App.setPerformanceMode('high');
        result.legacy = App.settings.performanceMode === 'full';
        App.setPerformanceMode('balanced');
        result.legacy = result.legacy && App.settings.performanceMode === 'auto';
      } else {
        result.eco = result.full = result.legacy = false;
      }
      App.setPerformanceMode(initial);
      navigate('settings');
      await wait(500);
      $('#perfModes').scrollIntoView({ block: 'center' });
      result.restored = App.settings.performanceMode === initial && $('[data-act="performance-mode"][data-mode="' + initial + '"]').classList.contains('on');
      result.pass = Object.entries(result).filter(([key]) => key !== 'pass').every(([, value]) => value === true);
      console.warn(`SELFTEST quality: ${JSON.stringify(result)}`);
    } else if (extra === 'scrollperf') {
      await silentPlay(0);
      AudioFX.setVolume(0);
      const routes = ['home', 'popular', 'liked', 'albums', 'artists', 'settings', 'equalizer'];
      const results = [];
      for (const route of routes) {
        const navStarted = performance.now();
        navigate(route);
        await new Promise(requestAnimationFrame);
        const navPaint = performance.now() - navStarted;
        await wait(1200);
        const sc = $('#scroller');
        sc.scrollTop = 0;
        await wait(200);
        const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
        const intervals = [];
        const longFrames = [];
        let observer = null;
        try {
          observer = new PerformanceObserver((list) => longFrames.push(...list.getEntries()));
          observer.observe({ type: 'long-animation-frame' });
        } catch {}
        const started = await new Promise((resolve) => {
          let begin = 0;
          let last = 0;
          const duration = 1600;
          const step = (now) => {
            if (!begin) { begin = now; last = now; }
            const p = Math.min(1, (now - begin) / duration);
            intervals.push(now - last);
            last = now;
            sc.scrollTop = maxScroll * (1 - Math.cos(p * Math.PI * 2)) * 0.5;
            if (p < 1) requestAnimationFrame(step);
            else resolve(begin);
          };
          requestAnimationFrame(step);
        });
        observer?.disconnect();
        const elapsed = performance.now() - started;
        const sorted = intervals.slice(1).sort((a, b) => a - b);
        const fps = intervals.length * 1000 / elapsed;
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
        const offenders = {};
        for (const entry of longFrames) {
          for (const script of entry.scripts || []) {
            const name = script.sourceFunctionName || script.invoker || script.sourceURL || 'unknown';
            offenders[name] = (offenders[name] || 0) + (script.duration || 0);
          }
        }
        const item = { route, fps: +fps.toFixed(1), p95: +p95.toFixed(1), slow: intervals.filter((v) => v > 34).length, longMs: Math.round(longFrames.reduce((s, e) => s + e.duration, 0)), navPaint: Math.round(navPaint), maxScroll, offenders: Object.entries(offenders).sort((a, b) => b[1] - a[1]).slice(0, 3) };
        results.push(item);
        console.warn(`SCROLLPERF ${JSON.stringify(item)}`);
      }
      const scrolling = results.filter((r) => r.maxScroll > 20);
      console.warn(`SELFTEST scrollperf: ${JSON.stringify({ averageFps: +(scrolling.reduce((s, r) => s + r.fps, 0) / Math.max(1, scrolling.length)).toFixed(1), totalLongMs: results.reduce((s, r) => s + r.longMs, 0), results })}`);
    } else if (extra === 'perf') {
      // Замер плавности: интервалы между кадрами и «длинные кадры» основного потока
      await silentPlay(0);
      const loaf = [];
      try {
        new PerformanceObserver((l) => loaf.push(...l.getEntries())).observe({ type: 'long-animation-frame' });
      } catch {}
      const measure = (ms, onFrame) =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const end = last + ms;
          const f = (t) => {
            d.push(t - last);
            last = t;
            onFrame && onFrame();
            if (t < end) requestAnimationFrame(f);
            else {
              d.sort((a, b) => a - b);
              const avg = d.reduce((s, x) => s + x, 0) / d.length;
              res(`frames=${d.length} avg=${avg.toFixed(1)}ms p95=${d[Math.floor(d.length * 0.95)].toFixed(1)}ms slow=${d.filter((x) => x > 25).length}`);
            }
          };
          requestAnimationFrame(f);
        });
      const loafSum = () => {
        const s = loaf.reduce((a, e) => a + e.duration, 0);
        loaf.length = 0;
        return `длинных кадров=${loaf.length} ${s.toFixed(0)}мс`;
      };
      await wait(1500);
      loaf.length = 0;
      console.warn('PERF idle: ' + (await measure(3000)));
      const sc = $('#scroller');
      console.warn('PERF scroll: ' + (await measure(2000, () => (sc.scrollTop += 6))));
      const n1 = loaf.reduce((a, e) => a + e.duration, 0);
      loaf.length = 0;
      toggleCompact();
      console.warn('PERF collapse: ' + (await measure(900)) + ` | longtasks=${loaf.reduce((a, e) => a + e.duration, 0).toFixed(0)}ms`);
      loaf.length = 0;
      await wait(300);
      toggleCompact();
      console.warn('PERF expand: ' + (await measure(900)) + ` | longtasks=${loaf.reduce((a, e) => a + e.duration, 0).toFixed(0)}ms`);
      void n1;
      void loafSum;
    } else if (extra === 'sbcollapse' || extra === 'sbexpand') {
      // кадр прямо посреди анимации боковой панели
      if (extra === 'sbexpand') {
        toggleCompact();
        await wait(900);
      }
      toggleCompact();
      await wait(170);
      const m = $('#main').getBoundingClientRect();
      const s = $('#sidebar').getBoundingClientRect();
      console.warn(`SELFTEST ${extra} mid: sidebar x=${Math.round(s.left)} w=${Math.round(s.width)} | main x=${Math.round(m.left)} w=${Math.round(m.width)}`);
      return window.zvuk.screenshotReady(0);
    } else if (extra === 'clipofferopen') {
      // При выключенном клипе ни открытие, ни повторное открытие окна не показывает предложений.
      Object.assign(App.settings.viz, { bg: 'cover', clipAuto: false });
      NP.vizOn = false;
      await silentPlay(2);
      ClipOffer._force = true;
      console.warn(`SELFTEST clipofferopen before: card=${Boolean($('.clip-offer'))}`);
      const t0 = performance.now();
      openNowPlaying();
      await wait(2400);
      const suppressed = !$('.clip-offer');
      console.warn(`SELFTEST clipofferopen disabled: suppressed=${suppressed} after=${Math.round(performance.now() - t0)}ms`);
      NP.close();
      await wait(600);
      console.warn(`SELFTEST clipofferopen closed: card=${Boolean($('.clip-offer'))}`);
      openNowPlaying();
      await wait(1200);
      console.warn(`SELFTEST clipofferopen reopened: suppressed=${!$('.clip-offer')}`);
    } else if (extra === 'clipwatch') {
      // сторож: плеер YouTube «не загрузился» (подменяем адрес) — через ~12 с приложение пересоздаёт его само
      Object.assign(App.settings.viz, { bg: 'clip', style: 'waves', clipAuto: false });
      await silentPlay(2);
      NP.vizOn = true;
      openNowPlaying();
      await wait(1200);
      Player.seek(0.3);
      await Clip.setLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await wait(50);
      const f = $('#nowPlaying .clip-frame');
      if (f) f.src = 'about:blank';
      const t0 = performance.now();
      let k = 0;
      while (!$('#nowPlaying .clip-box.clip-on') && k++ < 280) await wait(100);
      console.warn(`SELFTEST clipwatch: on=${Boolean($('#nowPlaying .clip-box.clip-on'))} after=${((performance.now() - t0) / 1000).toFixed(1)}s sameFrame=${$('#nowPlaying .clip-frame') === f}`);
    } else if (extra === 'clipoffer' || extra === 'clipofferok') {
      // Синтетическая видимость нужна только для проверки карточки подстройки, не самого YouTube.
      Object.assign(App.settings.viz, { bg: 'clip', clipAuto: false });
      NP.vizOn = true;
      await silentPlay(2);
      const t = Player.current;
      Clip.trackId = String(t.id);
      Clip.entry = { cands: [{ id: 'synthetic-video' }], pick: 0, manual: null, offset: 0, auto: null };
      const oldVisible = ClipOffer.clipVisible;
      const oldRequest = Clip.requestSync;
      let syncRequested = false;
      ClipOffer.clipVisible = () => true;
      Clip.requestSync = (id) => { syncRequested = id === String(t.id); };
      const need = await ClipOffer.need(t);
      console.warn(`SELFTEST clipoffer need: ${JSON.stringify(need)}`);
      ClipOffer.show(t, need);
      await wait(900);
      const offerText = $('.clip-offer')?.textContent || '';
      const syncOnly = offerText.includes('Подстроить клип?') && !offerText.includes('Включить');
      console.warn(`SELFTEST clipoffer card: syncOnly=${syncOnly} bg=${App.settings.viz.bg}`);
      if (extra === 'clipofferok') {
        $('.clip-offer [data-co="ok"]')?.click();
        await wait(2500);
        console.warn(`SELFTEST clipoffer ok: card=${Boolean($('.clip-offer'))} bgUnchanged=${App.settings.viz.bg === 'clip'} syncRequested=${syncRequested} npOpen=${NP.isOpen} vizOn=${NP.vizOn}`);
        await wait(1500);
      }
      ClipOffer.clipVisible = oldVisible;
      Clip.requestSync = oldRequest;
    } else if (extra.startsWith('clipstart')) {
      // clipstart@<id ролика>@<мс> — снимок через заданное время после появления клипа (значки YouTube поверх него)
      // @r — после паузы и продолжения, @s — после перемотки трека
      const [, vid = 'BnnbP7pCIvQ', ms = '300', action] = extra.split('@');
      Object.assign(App.settings.viz, { bg: 'clip', style: 'waves', clipAuto: false });
      await silentPlay(2);
      NP.vizOn = true;
      openNowPlaying();
      await wait(1500);
      Player.seek(0.3); // превью трека — всего 30 секунд
      await Clip.setLink('https://www.youtube.com/watch?v=' + vid);
      const on = () => Boolean($('#nowPlaying .clip-box.clip-on'));
      let k = 0;
      while (!on() && k++ < 200) {
        await wait(100);
        if (k % 20 === 0) console.warn(`SELFTEST clipstart wait: t=${Player.audio.currentTime.toFixed(1)} paused=${Player.audio.paused} status=${Clip.status} frame=${Boolean($('.clip-frame'))}`);
      }
      console.warn(`SELFTEST clipstart: on=${on()} after=${k * 100}ms`);
      if (!on() && $('.clip-frame')) {
        // клип так и не пошёл — показываем, что в плеере YouTube
        $('.clip-frame').style.opacity = '1';
        return window.zvuk.screenshotReady(300);
      }
      if (action) {
        await wait(5000);
        if (action === 'r') {
          Player.toggle();
          await wait(2500);
          Player.toggle();
        } else Player.seek(Math.max(0.5, Player.audio.currentTime - 8));
        k = 0;
        await wait(1000);
        while (!on() && k++ < 100) await wait(100);
        console.warn(`SELFTEST clipstart ${action}: on=${on()} after=${k * 100}ms t=${Player.audio.currentTime.toFixed(1)}`);
      }
      await wait(+ms);
      return window.zvuk.screenshotReady(0);
    } else if (extra === 'clipmath') {
      const result = ClipSync.selfTest();
      console.warn(`SELFTEST clipmath: ${JSON.stringify(result)}`);
      // Локальная проверка сохранения и приоритета ручной поправки, без YouTube и аккаунта.
      const old = { trackId: Clip.trackId, entry: Clip.entry, auto: App.settings.viz && App.settings.viz.clipAuto };
      const tid = '__clipmath__';
      try {
        Clip.trackId = tid;
        await Clip._update({
          manual: 'synthetic-video', offset: 0,
          auto: { ver: ClipSync.VERSION, vid: 'synthetic-video', offset: 12.345, rate: 1.008, score: 0.8, confidence: 0.9, locked: false },
        });
        await Clip.setSyncMode('locked');
        await Clip.shift(0.5);
        const locked = Clip.syncMode === 'locked' && Clip.autoInfo.locked && Math.abs(Clip.offset - 12.845) < 0.0001 && Clip.rate === 1.008;
        Clip._cal = true;
        const calSeq = Clip._calSeq;
        await Clip.shift(-0.25);
        const cancel = !Clip._cal && Clip._calSeq > calSeq && Clip.autoInfo.locked && Math.abs(Clip.offset - 12.595) < 0.0001;
        await Clip.setSyncMode('auto');
        const unlocked = Clip.syncMode === 'auto' && !Clip.autoInfo.locked && Math.abs(Clip.offset - 12.595) < 0.0001;
        await Clip.setSyncMode('manual');
        const manual = Clip.syncMode === 'manual' && Math.abs(Clip.offset - 12.595) < 0.0001;
        await Clip._update({ auto: { ver: ClipSync.VERSION, vid: 'synthetic-video', offset: 77, captureMs: 3000 } });
        const shortCapture = Clip.autoInfo === null;
        await Clip._update({ auto: { ver: ClipSync.VERSION, vid: 'synthetic-video', offset: 77, captureMs: 3000, locked: true, manualAt: Date.now() } });
        const shortLocked = Clip.autoInfo?.locked === true && Clip.autoInfo?.offset === 77;
        await Clip._update({ auto: { ver: ClipSync.VERSION, vid: 'synthetic-video', offset: 12.345, captureMs: 4000 } });
        const fullCapture = Clip.autoInfo !== null;
        await Clip._update({ auto: { ver: 1, vid: 'synthetic-video', offset: 99 } });
        const legacy = Clip.autoInfo === null;
        console.warn(`SELFTEST clipmodes: locked=${locked} cancel=${cancel} unlocked=${unlocked} manual=${manual} legacyRejected=${legacy} shortCaptureRejected=${shortCapture} shortLockedPreserved=${shortLocked} fullCaptureAccepted=${fullCapture}`);
        if (!locked || !cancel || !unlocked || !manual || !legacy || !shortCapture || !shortLocked || !fullCapture) throw new Error('clipmodes failed');
      } finally {
        await window.zvuk.yt.update(tid, { manual: null, offset: 0, auto: null });
        if (App.settings.viz) App.settings.viz.clipAuto = old.auto;
        Clip.trackId = old.trackId;
        Clip.entry = old.entry;
      }
      await wait(300);
    } else if (extra.startsWith('clipsync')) {
      // clipsync@<id ролика>[@<план>[@<id трека>]] — проверить на другом ролике.
      // План: «-» — слушать клип только там, где он идёт (ручной сдвиг шагами по 20 с, как раньше);
      // «auto» — как в приложении; «a,b» — перематывать клип в эти секунды и сверять замеры.
      const [, vidArg = 'dQw4w9WgXcQ', planArg = 'auto', trackArg] = extra.split('@');
      Clip._testPlan = planArg === 'auto' ? null : planArg === '-' ? [null] : planArg.split(',').map(Number);
      extra = extra.split('@')[0];
      // Автосинхронизация: тихое воспроизведение (звук нужен — его слушает захват), клип по ссылке.
      // Для гостя трек — 30-секундное превью из середины песни, поэтому сначала ищем место клипа,
      // где звучит этот фрагмент (ручной сдвиг шагами по 20 с), потом повторяем замер для проверки.
      const s = App.settings.viz;
      Object.assign(s, { bg: 'clip', style: 'waves', clipAuto: false, clipQ: '480' });
      let t;
      if (trackArg) {
        t = (await api('getTracks', [trackArg]))[0];
      } else if (vidArg === 'dQw4w9WgXcQ') {
        const r = await api('search', 'Rick Astley Never Gonna Give You Up');
        const ok = (x) => /never gonna give you up/i.test(x.title) && /astley/i.test(artistsText(x.artists)) && !/instrumental|karaoke|remix|mix\)|live|acoustic|pianoforte|edit/i.test(x.title);
        t = r.tracks.find(ok) || r.tracks[0];
      } else {
        const r = await api('getRelease', '6233892');
        t = { ...r.tracks[0], release: { id: r.id, title: r.title, image: r.image } };
      }
      console.warn(`SELFTEST clipsync track: ${t.title} — ${artistsText(t.artists)}`);
      Player._applyVolume = () => AudioFX.setVolume(0.02);
      Player.playList([t], 0, { kind: 'list', title: 'test' });
      await wait(2500);
      AudioFX.setVolume(0.02);
      App.rerender();
      await wait(800);
      await Clip.setLink('https://www.youtube.com/watch?v=' + vidArg);
      for (let k = 0; k < 300 && !Clip._readyForTest(); k++) await wait(100);
      const playerReady = Clip._readyForTest();
      console.warn(`SELFTEST clipsync player: status=${Clip.status} ready=${playerReady} frame=${Boolean($('.clip-frame'))} message=${Clip.message}`);
      if (playerReady && Player.audio.paused) {
        // Пока ждали YouTube, короткое гостевое превью могло закончиться.
        Player.seek(1);
        Player.play();
        await wait(1200);
      }
      await wait(1800);
      Clip._calKey = Clip.trackId + '|' + Clip.videoId; // подстройку запускает сам тест, по шагам
      s.clipAuto = true;
      const steps = planArg !== '-' ? [0] : vidArg === 'dQw4w9WgXcQ' ? [0, 20, 40, 60, 80, 100, 120, 140, 160, 180] : Array.from({ length: 14 }, (_, i) => i * 20);
      for (const off of steps) {
        Player.seek(1);
        await Clip._update({ offset: off, auto: null });
        Clip._calKey = Clip.trackId + '|' + Clip.videoId; // чтобы подстройка не запустилась сама посреди шага
        await wait(2600);
        console.warn(`SELFTEST clipsync before off=${off}: paused=${Player.audio.paused} t=${Player.audio.currentTime.toFixed(2)} gain=${AudioFX.vol && AudioFX.vol.gain.value.toFixed(3)} ducked=${AudioFX.ducked} level=${Viz.level.toFixed(3)}`);
        await Clip.calibrate(true);
        const novaSync = Nova._stateForTest().sync;
        console.warn(`SELFTEST clipsync try off=${off}: ${Clip.sync.state} ${Clip.sync.message} t=${Player.audio.currentTime.toFixed(2)} nova=${JSON.stringify(novaSync)}`);
        if (Clip.sync.state === 'done') break;
      }
      if (Clip.sync.state === 'done') {
        const first = Clip.autoInfo.offset;
        if (Player.audio.paused) {
          Player.seek(1);
          Player.play();
          await wait(2200);
        }
        // Точность удержания по сообщениям YouTube; цифры не подменяются оценкой.
        await wait(3000);
        const ds = [];
        for (let k = 0; k < 40; k++) {
          ds.push(Clip._driftForTest());
          await wait(100);
        }
        const v = ds.filter((x) => isFinite(x));
        const mean = v.reduce((a, b) => a + Math.abs(b), 0) / (v.length || 1);
        console.warn(`SELFTEST clipsync hold: mean|drift|=${(mean * 1000).toFixed(0)}ms max=${v.length ? (Math.max(...v.map(Math.abs)) * 1000).toFixed(0) : '-'}ms n=${v.length}`);
        console.warn(`SELFTEST clipsync diag: ${JSON.stringify(Clip._diagForTest())}`);

        const beforePause = Clip._diagForTest();
        Player.pause();
        await wait(1800);
        const paused = Clip._diagForTest();
        const pauseOk = paused.mounts.every((m, i) => m.filterSamples === 0 && m.history.length === beforePause.mounts[i].history.length);
        console.warn(`SELFTEST clipsync pause: ok=${pauseOk} filter=${paused.mounts.map((m) => m.filterSamples)}`);
        Player.seek(1);
        Player.play();
        await wait(2200);
        const beforeSeek = Clip._diagForTest();
        Player.seek(3);
        await wait(1700);
        const afterSeek = Clip._diagForTest();
        const seekOk = afterSeek.mounts.every((m, i) => m.corrections === beforeSeek.mounts[i].corrections);
        console.warn(`SELFTEST clipsync seek: ok=${seekOk} corrections=${afterSeek.mounts.map((m) => m.corrections)}`);
        if (!pauseOk || !seekOk) throw new Error('clipsync pause/seek regression');

        // Повторный замер с того же места — должен дать тот же сдвиг.
        Player.seek(1);
        await wait(2500);
        await Clip.calibrate(true);
        console.warn(`SELFTEST clipsync repeat: state=${Clip.sync.state} first=${first} second=${Clip.autoInfo ? Clip.autoInfo.offset : '-'} diff=${Clip.autoInfo ? ((Clip.autoInfo.offset - first) * 1000).toFixed(0) + 'ms' : '-'}`);
        console.warn(`SELFTEST clipsync final: ${JSON.stringify(Clip._diagForTest())}`);
      } else {
        console.warn(`SELFTEST clipsync unavailable: состояние=${Clip.sync.state}; реальные drift/pause/seek не проверены`);
      }
      $('.vz-gear') && $('.vz-gear').click();
      await wait(700);
    } else if (extra.startsWith('clipq')) {
      // Клип в заданном качестве (clipq1080, clipq480, clipqauto, clipq2160@<id 4K-ролика>)
      const [wantedQuality, wantedVideo] = extra.slice(5).split('@');
      App.settings.viz.bg = 'clip';
      App.settings.viz.style = 'waves';
      App.settings.viz.clipQ = wantedQuality || 'auto';
      await silentPlay(0);
      App.rerender();
      await wait(1200);
      await Clip.setLink('https://www.youtube.com/watch?v=' + (wantedVideo || 'dQw4w9WgXcQ'));
      await wait(12000);
      const f = $('.clip-frame');
      const box = $('.clip-box');
      const qdiag = Clip._diagForTest().mounts[0] || {};
      console.warn(`SELFTEST clipq: want=${Clip.quality} actual=${Clip.actualQuality || '?'} frame=${f ? f.clientWidth + 'x' + f.clientHeight : '-'} box=${box ? box.clientWidth + 'x' + box.clientHeight : '-'} dpr=${devicePixelRatio} visible=${box && box.classList.contains('clip-on')} reported=${qdiag.quality || '?'} matched=${qdiag.qualityMatched} requests=${qdiag.qualityRequests} available=${JSON.stringify(qdiag.qualityLevels || [])}`);
      if (wantedQuality === '2160' && qdiag.qualityMatched) {
        Clip.setQuality('1440');
        await wait(3500);
        console.warn(`SELFTEST clipq switch2K: actual=${Clip.actualQuality || '?'} diag=${(Clip._diagForTest().mounts[0] || {}).quality || '?'}`);
        Clip.setQuality('2160');
        await wait(5000);
        const back = Clip._diagForTest().mounts[0] || {};
        console.warn(`SELFTEST clipq back4K: actual=${Clip.actualQuality || '?'} matched=${back.qualityMatched} sameFrame=${$('.clip-frame') === f}`);
        for (let i = 0; i < 30 && back.state !== 1; i++) await wait(100);
        Player.seek(15);
        let seek = {};
        for (let i = 0; i < 30; i++) {
          seek = Clip._diagForTest().mounts[0] || {};
          if (seek.seekKind === 'track' && Math.abs((seek.seekTarget ?? -1) - 15) < 0.01 && seek.seekLatencyMs != null) break;
          await wait(100);
        }
        console.warn(`SELFTEST clipseek live: kind=${seek.seekKind} target=${seek.seekTarget} ackMs=${seek.seekLatencyMs}`);
      }
      $('.vz-gear') && $('.vz-gear').click();
      await wait(700);
    } else if (extra === 'cliptest') {
      // Клип по ссылке (без ключа) во вкладке визуализатора + проверка ключа-пустышки
      App.settings.viz.bg = 'clip';
      App.settings.viz.style = 'waves';
      await silentPlay(0);
      App.rerender();
      await wait(1500);
      console.warn(`SELFTEST clip: status=${Clip.status} msg=${Clip.message}`);
      await Clip.setLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await wait(9000);
      const box = $('.clip-box');
      console.warn(`SELFTEST clip: status=${Clip.status} video=${Clip.videoId} frame=${Boolean($('.clip-frame'))} visible=${box && box.classList.contains('clip-on')}`);
      Player.seek(15);
      await wait(3500);
      console.warn(`SELFTEST clip after seek: visible=${box && box.classList.contains('clip-on')}`);
      const r = await window.zvuk.yt.setKey('AIzaSyThisIsNotARealKey_000000000000');
      console.warn(`SELFTEST fake key: ok=${r.ok} msg=${r.ok ? '' : r.error.message.length + 'chars'} code=${r.ok ? '' : r.error.code}`);
      $('.vz-gear') && $('.vz-gear').click();
      await wait(700);
    } else if (extra === 'ringseek') {
      // Реальная мышь и клавиатура на эллиптической шкале: нажатие, перетаскивание, Home и стрелки.
      localStorage.setItem('zg.waveScene', 'rings');
      if ($('#waveCosmos').dataset.scene !== 'rings') App.rerender();
      await wait(1200);
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      for (let i = 0; i < 60 && (!Player.current || !isFinite(Player.audio.duration) || Player.audio.paused); i++) await wait(250);
      await wait(700);
      const ring = $('#waveRingSeek');
      const visible = Boolean(ring?._ringGeometry?.duration) && getComputedStyle(ring).pointerEvents === 'auto' && ring.tabIndex === 0;
      ring.focus({ preventScroll: true });
      ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await wait(100);
      const home = Math.abs(Player.audio.currentTime) < 1;
      ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await wait(100);
      const arrow = Math.abs(Player.audio.currentTime - 5) < 1;
      const point = (fraction) => {
        const g = ring._ringGeometry;
        const r = ring.getBoundingClientRect();
        const a = -Math.PI / 2 + fraction * Math.PI * 2;
        const x = Math.cos(a) * g.r;
        const y = Math.sin(a) * g.r * g.flat;
        return { x: r.left + g.x + x * Math.cos(g.tilt) - y * Math.sin(g.tilt), y: r.top + g.y + x * Math.sin(g.tilt) + y * Math.cos(g.tilt) };
      };
      const mouse = async (p, type) => window.zvuk.debug.mouse(p.x, p.y, type);
      let p = point(0.25);
      await mouse(p);
      await mouse(p, 'mousePressed');
      await mouse(p, 'mouseReleased');
      await wait(150);
      const clicked = Math.abs(Player.audio.currentTime - Player.audio.duration * 0.25) < 1.5;
      p = point(0.48);
      await mouse(p);
      await mouse(p, 'mousePressed');
      for (let i = 1; i <= 8; i++) {
        await mouse(point(0.48 + i * 0.0125), 'mouseDragged');
        await wait(25);
      }
      await mouse(point(0.58), 'mouseReleased');
      await wait(150);
      const dragged = Math.abs(Player.audio.currentTime - Player.audio.duration * 0.58) < 1.5;
      const playBefore = Player.playing;
      const center = point(0);
      const g = ring._ringGeometry;
      const rect = ring.getBoundingClientRect();
      center.x = rect.left + g.x;
      center.y = rect.top + g.y;
      await mouse(center);
      await mouse(center, 'mousePressed');
      await mouse(center, 'mouseReleased');
      await wait(100);
      const centerButton = Player.playing !== playBefore;
      if (!Player.playing) $('#waveOrb').click();
      Player.seek(Player.audio.duration * 0.42);
      await wait(600);
      console.warn(`SELFTEST ringseek: visible=${visible} home=${home} arrow=${arrow} clicked=${clicked} dragged=${dragged} centerButton=${centerButton} progress=${(Player.audio.currentTime / Player.audio.duration).toFixed(2)} duration=${Player.audio.duration.toFixed(1)} radius=${ring._ringGeometry.r.toFixed(1)}`);
    } else if (extra === 'waverings') {
      // Единственная оконная тема не зависит от устаревшего сохранённого выбора.
      localStorage.setItem('zg.waveScene', 'tide');
      App.rerender();
      await wait(1200);
      const rings = $('#waveCosmos').dataset.scene === 'rings' && $('.wv-portal-label').textContent.includes('Кольца Сатурна');
      const noToggle = !$('#waveSceneBtn') && !$('[data-act="wave-scene"]');
      $('.nav-item[data-view="home"]').click();
      await wait(1500);
      const homeRings = $('#homeRing')?.dataset.scene === 'rings' && $('.home-wave-signature').textContent === 'Кольца Сатурна';
      $('.nav-item[data-view="wave"]').click();
      await wait(1200);
      console.warn(`SELFTEST waverings: rings=${rings} noToggle=${noToggle} homeRings=${homeRings} scene=${$('#waveCosmos').dataset.scene} label=${$('.wv-portal-label').textContent}`);
    } else if (extra === 'wavefocus') {
      // Погружение: настоящий клик, полный экран, выход по Esc и повторный вход.
      const clickFocus = async () => {
        const r = $('#waveFocusBtn').getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
      };
      await clickFocus();
      await wait(700);
      const active = document.body.classList.contains('wave-focus');
      const consoleOff = getComputedStyle($('.wv-console')).display === 'none';
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(300);
      const escaped = !document.body.classList.contains('wave-focus');
      await clickFocus();
      await wait(1000);
      const restored = document.body.classList.contains('wave-focus');
      console.warn(`SELFTEST wavefocus: active=${active} consoleOff=${consoleOff} escaped=${escaped} restored=${restored} full=${Boolean(document.fullscreenElement)} scene=${$('#waveCosmos').dataset.scene} hero=${Math.round($('.wv-hero').clientHeight)} viewport=${$('#scroller').clientHeight}`);
    } else if (extra === 'orbit3dzoom') {
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      for (let i = 0; i < 72 && (!Player.current || Player.audio.paused); i++) await wait(250);
      const clickFocus = async () => {
        const r = $('#waveFocusBtn').getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
      };
      for (let attempt = 0; attempt < 2 && !document.body.classList.contains('wave-focus'); attempt++) {
        await clickFocus();
        await wait(400);
      }
      for (let i = 0; i < 60 && !($('.wv-hero')?._orbit3d?.getStats().frames > 4); i++) await wait(150);
      const canvas = $('.wv-3d-canvas');
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < 7; i++) {
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
        await wait(120);
      }
      await wait(900);
      const orbit = $('.wv-hero')?._orbit3d;
      const distance = orbit ? Math.hypot(...orbit.getStats().camera) : 0;
      console.warn(`SELFTEST orbit3dzoom: ready=${Boolean(orbit)} distance=${distance.toFixed(2)} zoomed=${distance > 0 && distance < 8.4} wide=${rect.width > $('.wv-portal').getBoundingClientRect().width * 1.6}`);
    } else if (extra === 'orbit3d') {
      // Новая WebGL-сцена: реальные указатель, колесо, клавиатура, жизненный цикл и FPS.
      AudioFX.setVolume(0);
      Player._applyVolume = () => {
        AudioFX.setVolume(0);
        Player.emit('volume', { volume: Player.volume, muted: Player.muted });
      };
      const until = async (fn, timeout = 15000) => {
        const started = performance.now();
        while (performance.now() - started < timeout) {
          try { if (fn()) return true; } catch {}
          await wait(150);
        }
        return false;
      };
      const clickFocus = async () => {
        const r = $('#waveFocusBtn').getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
      };
      const enter = async () => {
        for (let attempt = 0; attempt < 2 && !document.body.classList.contains('wave-focus'); attempt++) {
          await clickFocus();
          await wait(350);
        }
        return until(() => $('.wv-hero')?._orbit3d?.getStats().frames > 4, 12000);
      };
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      const playing = await until(() => Player.source?.kind === 'wave' && Player.playing && !Player.audio.paused && isFinite(Player.audio.duration), 18000);
      const ready = await enter();
      await until(() => $('.wv-3d-loader.hidden'), 6000);
      const hero = $('.wv-hero');
      const orbit = hero?._orbit3d;
      const result = { ready, playing, asset: hero?.dataset.orbitAsset || 'none' };
      if (orbit) {
        const canvas = $('.wv-3d-canvas');
        const mouse = (x, y, kind) => window.zvuk.debug.mouse(x, y, kind);
        const distance = (a) => Math.hypot(...a);
        result.leftTransport = $('#waveOrb').parentElement.id === 'wavePlaySlot';
        result.worldCount = orbit.getStats().worldCount === 6;
        const focusCover = $('.wv-now img');
        const focusPanelHeight = $('.wv-copy').clientHeight;
        result.largePanel = focusCover && focusCover.getBoundingClientRect().width > 170 && focusPanelHeight > innerHeight * 0.4 && parseFloat(getComputedStyle($('.wv-now .nt div')).fontSize) >= 17;
        result.compactPanel = focusPanelHeight <= innerHeight - 60 && getComputedStyle($('.wv-copy')).alignSelf === 'center';
        result.coverHighRes = focusCover && focusCover.src === cover(Player.current, 600);
        result.artistLink = Boolean($('.wv-now .a [data-view="artist"]'));
        result.mainHint = $('.wv-hero').dataset.mainHint === 'ready';
        const rect = canvas.getBoundingClientRect();
        result.wideCanvas = rect.width > $('.wv-portal').getBoundingClientRect().width * 1.6;
        result.orbitShifted = orbit.getWorldTargets().find((w) => w.id === 'any').x < rect.left + rect.width * 0.48;
        result.leftSeekBound = Boolean($('#waveSeek')?._seekUI);
        const focusPanelRect = $('.wv-copy').getBoundingClientRect();
        const footerRect = $('.wv-focus-footer').getBoundingClientRect();
        result.footerMoved = Math.abs(footerRect.left - focusPanelRect.left) < 3 && footerRect.top >= focusPanelRect.bottom - 2 && footerRect.bottom <= innerHeight;
        const x = rect.left + rect.width * 0.55;
        const y = rect.top + rect.height * 0.2;
        const cameraBefore = orbit.getStats().camera;
        await mouse(x, y);
        await mouse(x, y, 'mousePressed');
        for (let i = 1; i <= 9; i++) {
          await mouse(x + i * 9, y + i * 3, 'mouseDragged');
          await wait(22);
        }
        await mouse(x + 81, y + 27, 'mouseReleased');
        await wait(500);
        const cameraDragged = orbit.getStats().camera;
        result.drag = Math.hypot(...cameraDragged.map((v, i) => v - cameraBefore[i])) > 0.08;
        const zoomBefore = distance(cameraDragged);
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        await wait(450);
        result.zoom = Math.abs(distance(orbit.getStats().camera) - zoomBefore) > 0.08;
        $('.wv-3d-reset').click();
        await wait(950);
        result.reset = orbit.getStats().camera.every((v, i) => Math.abs(v - [0, 4.6, 11.8][i]) < 0.06);
        if (playing) {
          const leftSeekRect = $('#waveSeek').getBoundingClientRect();
          const panelRect = $('.wv-copy').getBoundingClientRect();
          result.leftSeekVisible = leftSeekRect.top >= panelRect.top && leftSeekRect.bottom <= panelRect.bottom;
          const leftSeekX = leftSeekRect.left + leftSeekRect.width * 0.6;
          const leftSeekY = leftSeekRect.top + leftSeekRect.height / 2;
          await mouse(leftSeekX, leftSeekY);
          await mouse(leftSeekX, leftSeekY, 'mousePressed');
          await mouse(leftSeekX, leftSeekY, 'mouseReleased');
          await wait(300);
          result.leftSeek = Math.abs(Player.audio.currentTime - Player.audio.duration * 0.6) < 1.5;
          const ring = $('#waveRingSeek');
          ring.focus({ preventScroll: true });
          ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
          await wait(150);
          ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          await wait(300);
          result.keyboard = Math.abs(Player.audio.currentTime - 5) < 1.2;
          const ringPoint = orbit.getRingTarget(0.43);
          const px = ringPoint.x;
          const py = ringPoint.y;
          await mouse(px, py);
          await mouse(px, py, 'mousePressed');
          await mouse(px, py, 'mouseReleased');
          await wait(350);
          result.ringSeek = Math.abs(Player.audio.currentTime - Player.audio.duration * 0.43) < 2;
          const wasPlaying = Player.playing;
          $('#waveOrb').click();
          await wait(350);
          result.leftToggle = Player.playing !== wasPlaying;
          $('#waveOrb').click();
          await wait(350);
          const previousVolume = Player.volume;
          Player.setVolume(0.4);
          await wait(80);
          $('#waveVol').dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));
          await wait(100);
          result.volumeControl = Math.abs(Player.volume - 0.45) < 0.02 && $('#waveVolVal').textContent === '45%';
          $('#waveVolBtn').click();
          await wait(100);
          result.muteControl = Player.muted && $('#waveVolVal').textContent === '0%';
          $('#waveVolBtn').click();
          Player.setVolume(previousVolume);
        }
        const rockTarget = orbit.getWorldTargets().find((w) => w.id === 'rock' && w.visible);
        if (rockTarget) {
          await mouse(rockTarget.x, rockTarget.y);
          await mouse(rockTarget.x, rockTarget.y, 'mousePressed');
          await mouse(rockTarget.x, rockTarget.y, 'mouseReleased');
          result.worldClick = await until(() => App.settings.wave?.world === 'rock' && Player.source?.title?.includes('Рок-гигант'), 5000);
          result.worldOptions = App.settings.wave?.mood === 'energetic' && App.settings.wave?.genres?.includes('rock');
          canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
          result.worldKeyboard = await until(() => App.settings.wave?.world === 'any', 5000);
          result.worldReset = App.settings.wave?.mood === 'any' && App.settings.wave?.lang === 'any' && App.settings.wave?.pop === 'any' && App.settings.wave?.genres?.length === 0;
        } else {
          result.worldClick = result.worldOptions = result.worldKeyboard = result.worldReset = false;
        }
        await until(() => Player.playing, 8000);
        const perfStart = orbit.getStats();
        const perfAt = performance.now();
        await wait(4500);
        const perfEnd = orbit.getStats();
        result.fps = +((perfEnd.frames - perfStart.frames) * 1000 / (performance.now() - perfAt)).toFixed(1);
        result.renderMs = +perfEnd.renderMs.toFixed(2);
        result.drawCalls = perfEnd.calls;
        result.triangles = perfEnd.triangles;
        result.quality = perfEnd.quality;
        result.pixelRatio = perfEnd.pixelRatio;
        result.pixels = perfEnd.pixels;
        result.scissor = perfEnd.scissor;
        result.shader = $('.wv-hero').dataset.shader || 'pbr';
        orbit.setHidden(true);
        const hiddenFrames = orbit.getStats().frames;
        await wait(400);
        result.hiddenStop = orbit.getStats().frames === hiddenFrames;
        orbit.setHidden(false);
        await wait(250);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(400);
        result.normalRestored = !document.body.classList.contains('wave-focus') && !orbit.getStats().active && $('#waveOrb').parentElement.classList.contains('wv-portal') && $('#waveCosmos').dataset.scene !== 'orbit3d';
        navigate('home');
        await wait(650);
        result.navigationDispose = App.route.view === 'home' && orbit.getStats().destroyed && !orbit.getStats().active;
        navigate('wave');
        await until(() => $('#waveFocusBtn'), 6000);
        result.reenter = await enter();
        await until(() => $('.wv-3d-loader.hidden'), 5000);
        result.singleRenderer = $$('.wv-3d-canvas').length === 1;
      }
      console.warn(`SELFTEST orbit3d: ${JSON.stringify(result)}`);
    } else if (extra === 'orbit3dfallback') {
      // Отказ WebGL не должен оставлять экран без рабочей орбиты и перемотки.
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      for (let i = 0; i < 72 && (!Player.current || !isFinite(Player.audio.duration) || Player.audio.paused); i++) await wait(250);
      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (/^(?:webgl2?|experimental-webgl)$/.test(kind)) return null;
        return nativeGetContext.call(this, kind, ...args);
      };
      const r = $('#waveFocusBtn').getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      await window.zvuk.debug.mouse(x, y);
      await window.zvuk.debug.mouse(x, y, 'mousePressed');
      await window.zvuk.debug.mouse(x, y, 'mouseReleased');
      let fallback = false;
      for (let i = 0; i < 60; i++) {
        if ($('.wv-hero')?.dataset.orbitFallback) { fallback = true; break; }
        await wait(100);
      }
      const hero = $('.wv-hero');
      const ring = $('#waveRingSeek');
      let ringUsable = false;
      for (let i = 0; i < 60; i++) {
        if (Boolean(ring?._ringGeometry?.duration) && getComputedStyle(ring).pointerEvents === 'auto') { ringUsable = true; break; }
        await wait(100);
      }
      const result = {
        fallback,
        playing: Player.source?.kind === 'wave' && Player.playing && !Player.audio.paused,
        playRestored: $('#waveOrb').parentElement.classList.contains('wv-portal'),
        transportHidden: getComputedStyle($('.wv-focus-transport')).display === 'none',
        ringUsable,
        canvasRestored: $('#waveCosmos').dataset.scene === 'solar' && Boolean($('#waveCosmos')._cosmos),
        stageRemoved: !$('.wv-3d-stage'),
      };
      HTMLCanvasElement.prototype.getContext = nativeGetContext;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(400);
      result.exitRestored = !document.body.classList.contains('wave-focus') && !hero.dataset.orbitFallback;
      console.warn(`SELFTEST orbit3dfallback: ${JSON.stringify(result)}`);
    } else if (extra === 'wavefocusfx') {
      // Планеты в полном экране с реально играющим превью: FPS и скачки угла.
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      if (Player.source?.kind !== 'wave' || !Player.playing) $('#waveOrb').click();
      for (let i = 0; i < 48 && (!Player.current || Player.audio.paused); i++) await wait(250);
      const playing = Player.source?.kind === 'wave' && Player.playing && !Player.audio.paused;
      Viz._solarMaxStep = 0;
      Viz._solarJumps = 0;
      // В служебном неактивном окне первый клик иногда лишь активирует его.
      for (let attempt = 0; attempt < 2 && !document.fullscreenElement; attempt++) {
        if (attempt && document.body.classList.contains('wave-focus')) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(250);
        }
        const r = $('#waveFocusBtn').getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await window.zvuk.debug.mouse(x, y);
        await window.zvuk.debug.mouse(x, y, 'mousePressed');
        await window.zvuk.debug.mouse(x, y, 'mouseReleased');
        await wait(300);
      }
      await wait(400);
      const frames = Viz._infFrames || 0;
      const started = performance.now();
      await wait(6000);
      const fps = ((Viz._infFrames || 0) - frames) * 1000 / (performance.now() - started);
      const ring = $('#waveRingSeek');
      const fullRing = Boolean(ring?._ringGeometry?.duration) && getComputedStyle(ring).pointerEvents === 'auto';
      let fullKey = false;
      let fullClick = false;
      if (fullRing) {
        ring.focus({ preventScroll: true });
        ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        ring.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        fullKey = Math.abs(Player.audio.currentTime - 5) < 1;
        const g = ring._ringGeometry;
        const r = ring.getBoundingClientRect();
        const x = Math.cos(g.tilt) * g.r;
        const y = Math.sin(g.tilt) * g.r;
        const px = r.left + g.x + x;
        const py = r.top + g.y + y;
        await window.zvuk.debug.mouse(px, py);
        await window.zvuk.debug.mouse(px, py, 'mousePressed');
        await window.zvuk.debug.mouse(px, py, 'mouseReleased');
        await wait(150);
        fullClick = Math.abs(Player.audio.currentTime - Player.audio.duration * 0.25) < 1.5;
        Player.seek(Player.audio.duration * 0.42);
        await wait(600);
      }
      const panel = $('.wv-copy').getBoundingClientRect();
      console.warn(`SELFTEST wavefocusfx: playing=${playing} full=${Boolean(document.fullscreenElement)} scene=${$('#waveCosmos').dataset.scene} energy=${Viz.level.toFixed(3)} fps=${fps.toFixed(1)} infMs=${(Viz._infMs || 0).toFixed(2)} maxStep=${(Viz._solarMaxStep || 0).toFixed(4)} jumps=${Viz._solarJumps || 0} ring=${fullRing} fullKey=${fullKey} fullClick=${fullClick} panel=${Math.round(panel.width)}x${Math.round(panel.height)}`);
    } else if (extra === 'orbital' || extra === 'orbitalsettings') {
      // Глобальная тема: настоящий выбор в настройках, сохранение и совпадение на всех страницах.
      const themeButton = $('[data-cseg="design"][data-val="orbit"]');
      if (extra === 'orbitalsettings' && themeButton) {
        themeButton.click();
        await wait(250);
        $('[data-cseg="design"][data-val="glass"]').click();
        await wait(250);
        themeButton.click();
      } else Custom.set({ design: 'orbit' });
      await wait(700);
      const saved = (await window.zvuk.settings.get()).custom?.design === 'orbit';
      const selected = extra === 'orbital' || ($$('.design-tile.on').length === 1 && themeButton.classList.contains('on'));
      const firstTheme = $('.design-tile')?.dataset.val || '-';
      const defaultOk = Custom.DEFAULTS.design === 'orbit' && (extra !== 'orbitalsettings' || firstTheme === 'orbit');
      if (extra === 'orbitalsettings') themeButton.scrollIntoView({ block: 'center' });
      console.warn(`SELFTEST orbital: on=${document.body.classList.contains('theme-orbit')} classic=${document.body.classList.contains('design-classic')} saved=${saved} selected=${selected} default=${Custom.DEFAULTS.design} first=${firstTheme} defaultOk=${defaultOk} accent=${getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()} stars=${getComputedStyle($('#bg'), '::after').animationName} view=${App.route.view}`);
    } else if (extra === 'wavecalm') {
      // Спокойный режим: статический кадр нарисован, затем цикл этой сцены остановлен.
      Custom.set({ reduceMotion: true }, false);
      App.rerender();
      await wait(1300);
      const canvas = $('#waveCosmos');
      const before = Viz._infFrames || 0;
      await wait(500);
      const stopped = (Viz._infFrames || 0) === before;
      console.warn(`SELFTEST wavecalm: staticFrame=${canvas.toDataURL().length > 10000} stopped=${stopped} reduce=${document.body.classList.contains('reduce-motion')}`);
    } else if (extra === 'wavefx') {
      // Пульт волны: выбор меняет свет сцены, кристалл управляет музыкой, холст действительно движется.
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      const clear = $('#genreClear');
      if (clear && !clear.classList.contains('hidden')) {
        clear.click();
        await wait(200);
      }
      $('[data-act="wave-set"][data-key="mood"][data-val="calm"]').click();
      await wait(3500);
      $('[data-act="wave-genre"][data-val="electronic"]').click();
      await wait(1200);
      const hero = $('.wv-hero');
      const hr = hero.getBoundingClientRect();
      hero.dispatchEvent(new PointerEvent('pointermove', { clientX: hr.left + hr.width * 0.8, clientY: hr.top + hr.height * 0.35, bubbles: true }));
      await wait(150);
      const parallax = !['', '0', '0.000'].includes(hero.style.getPropertyValue('--px'));
      const pointerEarly = Viz._infPointerX || 0;
      const canvas = $('#waveCosmos');
      const snap = () => {
        const s = canvas.toDataURL();
        let hash = 0;
        for (let i = 0; i < s.length; i += 97) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
        return hash;
      };
      const before = snap();
      for (let i = 0; i < 24 && (!Player.current || !Player.audio.src || Player.audio.paused); i++) await wait(250);
      const ready = Boolean(Player.current && Player.audio.src && Player.playing);
      $('#waveOrb').click();
      await wait(350);
      const paused = !Player.playing;
      $('#waveOrb').click();
      await wait(450);
      const resumed = Player.playing;
      const frames = Viz._frames || 0;
      const infFrames = Viz._infFrames || 0;
      await wait(700);
      const animated = snap() !== before && (Viz._frames || 0) > frames;
      const pointerLate = Viz._infPointerX || 0;
      const smooth = pointerEarly > 0 && pointerEarly < 0.29 && pointerLate > pointerEarly && pointerLate <= 0.301;
      const infFps = ((Viz._infFrames || 0) - infFrames) / 0.7;
      const steadyFrames = Viz._infFrames || 0;
      await wait(1000);
      const steadyFps = ((Viz._infFrames || 0) - steadyFrames) / 1;
      console.warn(`SELFTEST wavefx: mood=${App.settings.wave.mood} selected=${Boolean($('.mood.on[data-val="calm"]'))} color=${hero.style.getPropertyValue('--mood-a')} genre=${App.settings.wave.genres.join(',')} count=${$('#genreCount').textContent} source=${Player.source?.kind} playing=${Player.playing} ready=${ready} paused=${paused} resumed=${resumed} parallax=${parallax} smooth=${smooth} animated=${animated} infFps=${infFps.toFixed(1)} steadyFps=${steadyFps.toFixed(1)} infMs=${(Viz._infMs || 0).toFixed(2)}`);
    } else if (extra === 'recent') {
      // Лента последних запросов: длинные значения и полный цикл «показать → выбрать → показать снова».
      localStorage.setItem('zg.searches', JSON.stringify(['Земфира', 'Кино', 'Atomic Heart', 'Очень длинный поисковый запрос, который не должен сломать шапку', 'Музыка без слов', 'Synthwave']));
      input.value = '';
      input.focus();
      showRecentTop();
      await wait(500);
      const shownBefore = $$('.recent-query:not(.hidden)', recentTopList).length;
      const fitBefore = recentTopList.scrollWidth <= recentTopList.clientWidth + 1;
      const expected = App.recentSearches()[0];
      $('.recent-query').click();
      await wait(1200);
      const picked = App.route?.view === 'search' && App.route.params.q === expected;
      navigate('wave');
      input.value = '';
      input.focus();
      showRecentTop();
      await wait(1200);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await wait(250);
      const keyboard = recentTop.contains(document.activeElement) && !recentTop.classList.contains('hidden');
      input.focus();
      const rt = recentTop.getBoundingClientRect();
      const right = $('.tb-right').getBoundingClientRect();
      console.warn(`SELFTEST recent: shown=${shownBefore}/6 fit=${fitBefore} picked=${picked} first=${App.recentSearches()[0]} visible=${!recentTop.classList.contains('hidden')} keyboard=${keyboard} noOverlap=${rt.right <= right.left + 1}`);
    } else if (extra === 'waveconsole') {
      const panel = $('.wv-console');
      panel.scrollIntoView({ block: 'center' });
      await wait(600);
      const selectors = ['.wv-console', '.mood', '.mood-icon', '.wv-tune-block', '.wv-genres', '.opt-pill', '.opt-icon', '.wv-genres .chip'];
      const radii = Object.fromEntries(selectors.map((selector) => {
        const el = $(selector);
        return [selector, el ? getComputedStyle(el).borderRadius : 'missing'];
      }));
      const rounded = Object.values(radii).every((value) => parseFloat(value) >= 10 && !value.trim().includes(' '));
      const overflow = document.documentElement.scrollWidth > innerWidth + 1;
      console.warn(`SELFTEST waveconsole: ${JSON.stringify({ radii, rounded, overflow, pass: rounded && !overflow })}`);
    } else if (extra === 'wavenarrow') {
      // Узкое окно: декоративная сцена уменьшается, лента запросов полностью уступает место поиску.
      await window.__TAURI__.core.invoke('debug_resize', { width: 1050, height: 740 });
      await wait(1000);
      const hero = $('.wv-hero').getBoundingClientRect();
      const reactor = $('.wv-portal').getBoundingClientRect();
      console.warn(`SELFTEST wavenarrow: width=${innerWidth} page=${document.documentElement.scrollWidth} hero=${Math.round(hero.width)} reactor=${Math.round(reactor.width)} recent=${getComputedStyle(recentTop).display} tune=${getComputedStyle($('.wv-tune-grid')).gridTemplateColumns}`);
    } else if (extra === 'classic') {
      Custom.set({ design: 'classic', compact: true }, false);
      followIndicator(600);
      await silentPlay(0);
    } else if (extra === 'seekset') {
      Custom.set({ seekStyle: 'wave', seekColor: 'accent', seekThumb: 'always', seekHeight: 6 }, false);
      App.rerender();
      await wait(800);
      const st = [...$$('.set-title')].find((x) => x.textContent.includes('Полоса времени'));
      if (st) st.scrollIntoView({ block: 'start' });
      await silentPlay(0);
    } else if (extra === 'gravityhome' || extra === 'gravitywave') {
      const home = extra === 'gravityhome';
      const canvas = home ? $('#homeRing') : $('#waveCosmos');
      const hero = canvas?.closest(home ? '.home-wave' : '.wv-hero');
      const play = hero?.querySelector('#waveOrb');
      for (let i = 0; i < 70 && !(canvas?._gravity?.frames > 4); i++) await wait(100);
      const report = { page: home ? 'home' : 'wave', scene: canvas?.dataset.scene, sizes: [] };
      for (const [width, height] of [[1920, 1000], [1280, 800], [900, 700], [600, 760]]) {
        await window.__TAURI__.core.invoke('debug_resize', { width, height });
        await wait(450);
        const c = canvas.getBoundingClientRect();
        const b = play.getBoundingClientRect();
        const state = canvas._gravity;
        const centerError = state ? Math.hypot(c.left + state.x - b.left - b.width / 2, c.top + state.y - b.top - b.height / 2) : 999;
        const map = hero.querySelector(home ? '.home-orbital-map' : '.wv-orbital-map');
        const contained = b.left >= innerWidth * 0 && b.right <= innerWidth + 1 && b.top >= 0 && b.bottom <= innerHeight + 1;
        report.sizes.push({ requested: [width, height], centerError: Math.round(centerError * 10) / 10, mapHidden: getComputedStyle(map).visibility === 'hidden', contained, frames: state?.frames || 0 });
      }
      report.pass = report.scene === 'gravity' && report.sizes.every((s) => s.centerError < 2 && s.mapHidden && s.contained && s.frames > 4);
      console.warn('SELFTEST gravity: ' + JSON.stringify(report));
      await window.__TAURI__.core.invoke('debug_resize', { width: 1400, height: 900 });
      await wait(450);
    } else if (extra === 'waveplay' || extra === 'waveplaywide' || extra === 'gravityplay') {
      if (extra === 'waveplaywide') {
        await window.__TAURI__.core.invoke('debug_resize', { width: 1920, height: 1000 });
        await wait(600);
      }
      startMyWave();
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      await wait(6000);
      const now = $('#wvNowSlot .wv-now');
      const copy = $('.wv-copy');
      const title = now?.querySelector('.nt b');
      const like = now?.querySelector('.like-btn');
      const nowRect = now?.getBoundingClientRect();
      const copyRect = copy?.getBoundingClientRect();
      const gap = title && like ? Math.round(like.getBoundingClientRect().left - title.getBoundingClientRect().right) : -1;
      const compact = Boolean(nowRect && copyRect && nowRect.width <= Math.min(copyRect.width, 540) + 1 && gap >= 0 && gap < 360 && nowRect.right <= copyRect.right + 1);
      console.warn(`SELFTEST wave: source=${Player.source?.kind} playing=${Player.playing} track=${Player.current?.id} level=${Viz.level.toFixed(3)}`);
      console.warn('SELFTEST wavetrack: ' + JSON.stringify({ width: Math.round(nowRect?.width || 0), copyWidth: Math.round(copyRect?.width || 0), gap, compact, pass: Player.source?.kind === 'wave' && compact }));
      if (extra === 'gravityplay') {
        const canvas = $('#waveCosmos');
        const beforeFrames = canvas._gravity?.frames || 0;
        const iconIs = (name) => {
          const template = document.createElement('template');
          template.innerHTML = ICONS[name];
          return Boolean($('#waveOrb .i svg')?.isEqualNode(template.content.firstChild));
        };
        $('#waveOrb').click();
        await wait(650);
        const paused = Player.source?.kind === 'wave' && !Player.playing && $('#waveOrb').classList.contains('playing') === false && iconIs('play');
        $('#waveOrb').click();
        await wait(900);
        const resumed = Player.source?.kind === 'wave' && Player.playing && $('#waveOrb').classList.contains('playing') && iconIs('pause');
        const animated = (canvas._gravity?.frames || 0) > beforeFrames + 4;
        console.warn('SELFTEST gravityplay: ' + JSON.stringify({ scene: canvas.dataset.scene, paused, resumed, animated, pass: canvas.dataset.scene === 'gravity' && paused && resumed && animated }));
      }
    } else if (extra === 'collapse') {
      toggleSection('lib');
      toggleSection('pl');
      await wait(900);
      console.warn(`SELFTEST collapse: lib=${$('#sidebar').classList.contains('sec-lib-off')} pl=${$('#sidebar').classList.contains('sec-pl-off')}`);
      toggleSection('lib');
      toggleSection('pl');
      await wait(100);
      toggleSection('lib');
      toggleSection('pl');
      await wait(900);
    } else if (extra === 'menunp') {
      const l = firstList();
      Player.cue(l.tracks, 1, 0, l.source);
      await wait(1200);
      openNowPlaying();
      await wait(1200);
      $('[data-act="current-menu"]').click();
      await wait(400);
      const item = [...$$('.ctx .mi')].find((m) => m.textContent.includes('Перейти к альбому'));
      console.warn(`SELFTEST npmenu: menuItem=${Boolean(item)}`);
      item && item.click();
      await wait(1800);
      console.warn(`SELFTEST npmenu: route=${App.route.view}:${App.route.params.id} npOpen=${NP.isOpen}`);
    } else if (extra === 'artistcard') {
      let card = null;
      for (let i = 0; i < 40 && !card; i++) { card = $('.card.round'); if (!card) await wait(200); }
      if (card) {
        const rect = card.getBoundingClientRect();
        await window.zvuk.debug.mouse(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
      await wait(350);
      const cover = card?.querySelector('.cover')?.getBoundingClientRect();
      const orb = card?.querySelector('.play-orb')?.getBoundingClientRect();
      let inside = false;
      if (cover && orb) {
        const cx = cover.left + cover.width / 2;
        const cy = cover.top + cover.height / 2;
        inside = [[orb.left, orb.top], [orb.right, orb.top], [orb.left, orb.bottom], [orb.right, orb.bottom]].every(([x, y]) => Math.hypot(x - cx, y - cy) <= cover.width / 2 + 1);
      }
      console.warn(`SELFTEST artistcard: ${JSON.stringify({ found: Boolean(card), visible: orb?.width > 0, inside, pass: Boolean(card && orb?.width && inside) })}`);
    } else if (extra === 'suggest') {
      const inp = $('#searchInput');
      inp.focus();
      inp.value = 'atomic hear';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(2500);
    } else if (extra === 'likedfilter') {
      const input = $('#likedFilter');
      const root = $('#likedList .tracks');
      const normalize = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const initialRows = [...root.querySelectorAll('.tr')];
      const counts = new Map();
      for (const row of initialRows) {
        const title = normalize(row.querySelector('.tn')?.textContent);
        const char = title.match(/[\p{L}\p{N}]/u)?.[0];
        if (char) counts.set(char, (counts.get(char) || 0) + 1);
      }
      const query = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'g';
      const title = normalize(initialRows[0]?.querySelector('.tn')?.textContent);
      const word = title.split(' ')[0] || query;
      const type = (value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      input.focus();
      for (const value of [query, word, title, query]) type(value);
      const currentRows = [...root.querySelectorAll('.tr')];
      const matches = (rows) => rows.length > 0 && rows.every((row) => normalize(`${row.querySelector('.tn')?.textContent} ${row.querySelector('.t2')?.textContent} ${row.querySelector('.al')?.textContent}`).includes(query));
      const immediate = matches(currentRows);
      const animated = currentRows.some((row) => Boolean(row._filterAnimation));
      await wait(500);
      const rows = [...root.querySelectorAll('.tr')];
      let positions = true;
      if (root.classList.contains('virtualized') && rows.length) {
        const step = parseFloat(rows[0].style.height) + (parseFloat(getComputedStyle(root).rowGap) || 0);
        positions = rows.every((row) => Math.abs(parseFloat(row.style.top) - Number(row.dataset.idx) * step) < 1);
      }
      const firstGap = rows.length ? Math.abs(rows[0].getBoundingClientRect().top - root.getBoundingClientRect().top - (parseFloat(getComputedStyle(root).paddingTop) || 0)) : 999;
      type('zzzz-no-such-track-изр');
      const emptyBox = $('.liked-filter-empty');
      const empty = root.querySelectorAll('.tr').length === 0 && emptyBox && !emptyBox.hidden;
      type(query);
      await wait(450);
      const restored = matches([...root.querySelectorAll('.tr')]);
      const report = { query, immediate, animated, positions, firstGap: Math.round(firstGap * 10) / 10, empty: Boolean(empty), restored, count: currentRows.length };
      report.pass = immediate && animated && positions && firstGap <= 12 && empty && restored;
      console.warn('SELFTEST likedfilter: ' + JSON.stringify(report));
    } else if (extra === 'novatest') {
      await silentPlay(0);
      openPanel('nova');
      await wait(250);
      const result = { reaction: false, disabled: false, transport: false, lyricsAction: false, gameAction: false, sync: false, beat: false, reduced: false, restored: false };
      if (!Nova._stateForTest().watching) $('[data-nova-watch]')?.click();
      Nova.setStyle('lunar');
      if (!Player.playing) Player.play();
      await wait(100);
      const detail = (text, index = 0) => ({ trackId: Player.current.id, index, line: { t: 8 + index * 3, text }, next: { t: 20, text: 'Next line' } });
      document.dispatchEvent(new CustomEvent('zg:lyrics-line', { detail: detail('I love you under the stars') }));
      result.reaction = Nova._stateForTest().reaction?.id === 'love' && $('[data-nv="message"]')?.textContent.includes('love');
      $('[data-nova-watch]')?.click();
      const disabledMessage = Nova._stateForTest().message;
      await wait(500);
      document.dispatchEvent(new CustomEvent('zg:lyrics-line', { detail: detail('Rain on the window', 1) }));
      const wrap = $('.nv-collapse-wrap');
      result.disabled = !Nova._stateForTest().watching && Nova._stateForTest().collapsed && Nova._stateForTest().message === disabledMessage && Nova._stateForTest().line?.line?.text === 'Rain on the window' && $('.nova-panel').classList.contains('is-collapsed') && $('[data-nova-watch]').getAttribute('aria-expanded') === 'false' && parseFloat(getComputedStyle(wrap).height) < 2;
      $('[data-nova-watch]')?.click();
      await wait(500);
      result.restoredComments = Nova._stateForTest().watching && !Nova._stateForTest().collapsed && $('[data-nova-watch]').getAttribute('aria-expanded') === 'true' && parseFloat(getComputedStyle(wrap).height) > 100;
      const wasPlaying = Player.playing;
      $('[data-nova-action="toggle"]')?.click();
      await wait(150);
      result.transport = Player.playing !== wasPlaying;
      $('[data-nova-action="toggle"]')?.click();
      $('.nv-quick-actions [data-act="panel"][data-panel="lyrics"]')?.click();
      result.lyricsAction = App.panel === 'lyrics';
      if (App.panel !== 'nova') openPanel('nova');
      $('.nv-quick-actions [data-view="pulse"]')?.click();
      await wait(350);
      result.gameAction = App.route?.view === 'pulse';
      navigate('home');
      if (App.panel !== 'nova') openPanel('nova');
      await wait(650);
      document.dispatchEvent(new CustomEvent('zg:clip', { detail: { trackId: Player.current.id, sync: { state: 'run', phase: 'measure', shot: 2, total: 5, message: 'Сравниваю фрагменты' } } }));
      result.sync = Nova._stateForTest().sync?.state === 'run' && document.body.classList.contains('nova-syncing') && !$('.nv-sync-card')?.classList.contains('hidden');
      document.dispatchEvent(new CustomEvent('zg:clip', { detail: { trackId: Player.current.id, sync: { state: 'done', phase: 'done', offset: .125, confidence: .9 } } }));
      window.dispatchEvent(new Event('zg:beat'));
      result.beat = document.body.classList.contains('nova-beat');
      document.body.classList.remove('nova-word-react');
      const motionElement = $('.nv-portrait .nova-motion');
      const expectedPoses = { idle: 'thoughtful', listening: 'excitement', delighted: 'joy', help: 'support', pause: 'longing', wave: 'tenderness' };
      result.staticPoses = true;
      for (const [pose, emotion] of Object.entries(expectedPoses)) {
        motionElement.dataset.localPose = pose;
        Nova.renderPose();
        const image = motionElement.querySelector(':scope > img');
        for (let i = 0; i < 40 && !(image?.complete && image.naturalWidth > 0); i++) await wait(50);
        result.staticPoses = result.staticPoses && motionElement.dataset.rigState === 'static' && image?.getAttribute('src') === `assets/nova/emotions/${emotion}.webp` && image.complete && image.naturalWidth > 0 && !motionElement._novaRig && !motionElement._novaVideo.getAttribute('src');
      }
      delete motionElement.dataset.localPose;
      Nova.renderPose();
      document.body.classList.add('reduce-motion');
      document.dispatchEvent(new CustomEvent('zg:lyrics-line', { detail: detail('Fire and flame', 2) }));
      await wait(250);
      const novaMotions = [...$$('.nv-portrait .nova-motion, .nova-player-btn .nova-motion')];
      const novaVideos = novaMotions.map((el) => el._novaVideo).filter(Boolean);
      result.reduced = !document.body.classList.contains('nova-word-react') && getComputedStyle($('.nv-portrait')).animationName === 'none' && novaMotions.length >= 2 && novaMotions.every((el) => el.dataset.staticEmotion === '1' && !el._novaRig) && novaVideos.every((video) => video.paused && video.muted && !video.getAttribute('src'));
      document.body.classList.remove('reduce-motion');
      await wait(450);
      result.restored = Nova._stateForTest().watching && novaMotions.every((el) => el.dataset.rigState === 'static' && el.querySelector(':scope > img')?.naturalWidth > 0);
      navigate('home');
      await wait(450);
      if (App.panel !== 'nova') openPanel('nova');
      await wait(650);
      const chips = $('.home-wave .chips')?.getBoundingClientRect();
      const copy = $('.home-wave .wave-text')?.getBoundingClientRect();
      result.layout = App.panel === 'nova' && $('#sidePanel').classList.contains('open') && chips && copy && chips.bottom <= copy.bottom + 1 && !document.querySelector('.home-nova, .nova-context, .wv-nova-companion, #novaLive');
      const orbitAligned = (stage, line, button, hero) => {
        if (!stage || !line || !button || !hero) return false;
        const s = stage.getBoundingClientRect(), l = line.getBoundingClientRect(), b = button.getBoundingClientRect(), h = hero.getBoundingClientRect();
        return s.width >= h.width * .35 && s.left >= h.left - 1 && s.right <= h.right + 1 && Math.abs((l.left + l.right - b.left - b.right) / 2) < 3 && Math.abs((l.top + l.bottom - b.top - b.bottom) / 2) < 3;
      };
      result.homeOrbit = orbitAligned($('.home-orbit-stage'), $('.home-orbit-line.l1'), $('.home-wave-play'), $('.home-wave'));
      closePanel(); await wait(600);
      result.closedPanel = App.panel !== 'nova' && motionElement._novaVideo.paused;
      if (App.panel !== 'nova') openPanel('nova'); await wait(650);
      navigate('wave'); await wait(550);
      if (App.panel !== 'nova') openPanel('nova');
      await wait(650);
      result.waveOrbit = orbitAligned($('.orbit-observatory .wv-portal'), $('.orbit-observatory .wv-orbit-line.l1'), $('.orbit-observatory .wv-portal .wv-play'), $('.orbit-observatory'));
      const liveMotions = [...$$('.nova-motion')];
      result.resources = liveMotions.length >= 2 && liveMotions.every((el) => !el._novaRig && el.dataset.rigState === 'static' && !el._novaVideo.getAttribute('src'));
      result.pass = Object.values(result).every((value) => typeof value !== 'boolean' || value);
      console.warn('SELFTEST novatest: ' + JSON.stringify(result));
    } else if (extra === 'novaframes') {
      Player.pause();
      if (App.panel !== 'nova') openPanel('nova');
      const motion = $('.nv-portrait .nova-motion');
      for (let i = 0; i < 80 && !motion?._novaRig; i++) await wait(100);
      const rig = motion?._novaRig;
      const source = motion?.querySelector('.nova-rig-canvas');
      if (!rig || !source) throw new Error('Интерактивный риг Новы не загрузился');
      const sheet = document.createElement('div');
      sheet.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-content:center;gap:12px;padding:18px;background:#070b16;color:#dce9ff;font:12px sans-serif;overflow:hidden';
      document.body.append(sheet);
      const report = [];
      const grab = () => {
        const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 290;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
        const w = source.width * scale, h = source.height * scale;
        context.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      for (const pose of ['idle', 'listening', 'delighted', 'help', 'pause', 'wave']) {
        motion.dataset.localPose = pose;
        Nova.renderPose();
        await wait(950);
        const before = rig.getStats(), first = grab();
        await wait(280);
        const after = rig.getStats(), second = grab();
        let total = 0, count = 0;
        for (let i = 0; i < first.pixels.length; i += 16) {
          total += Math.abs(first.pixels[i] - second.pixels[i]) + Math.abs(first.pixels[i + 1] - second.pixels[i + 1]) + Math.abs(first.pixels[i + 2] - second.pixels[i + 2]);
          count += 3;
        }
        const meanPixelDelta = +(total / count).toFixed(3);
        const signatureDelta = +Math.abs(after.signature - before.signature).toFixed(4);
        const card = document.createElement('div');
        card.style.cssText = 'padding:9px;border:1px solid #293b58;border-radius:12px;background:#10192b;text-align:center;overflow:hidden';
        second.canvas.style.cssText = 'display:block;width:100%;height:290px;object-fit:contain;background:#050a16;border-radius:7px';
        const label = document.createElement('div');
        label.textContent = `${pose} · сетка ${after.vertices} · Δ ${signatureDelta}`;
        label.style.paddingTop = '8px';
        card.append(second.canvas, label); sheet.append(card);
        report.push({ pose, frames: after.frames, vertices: after.vertices, arm: after.arm, drawMs: after.drawMs, signatureDelta, meanPixelDelta, pass: after.frames > before.frames && signatureDelta > .001 && meanPixelDelta > .005 && (!['wave', 'help'].includes(pose) || after.arm < -.3) });
      }
      Nova.renderPose();
      console.warn('SELFTEST novaframes: ' + JSON.stringify({ pass: report.every((item) => item.pass), poses: report }));
    } else if (extra === 'homepanel') {
      await silentPlay(0);
      if (App.panel !== 'nova') openPanel('nova');
      await wait(800);
    } else if (extra === 'nova' || extra === 'novacollapsed') {
      await silentPlay(0);
      openPanel('nova');
      let line = null;
      // В гостевом режиме доступны 30-секундные превью: ищем реальный трек с ранней строкой.
      for (let attempt = 0; attempt < 5 && !line; attempt++) {
        const lyricsWait = Date.now() + 16000;
        while (Date.now() < lyricsWait && (App.lyrics.trackId !== Player.current?.id || App.lyrics.loading || App.lyrics.searching)) await wait(200);
        const lines = App.lyrics.data?.synced ? App.lyrics.data.lines : [];
        const duration = Player.audio.duration || 30;
        line = lines.find((l) => l.text && l.t >= 0 && l.t < duration - 2) || null;
        if (!line && attempt < 4) {
          Player.next();
          await wait(3000);
        }
      }
      openPanel('lyrics');
      await wait(300);
      openPanel('queue');
      await wait(300);
      openPanel('nova');
      if (line) Player.seek(line.t + 0.35);
      await wait(1400);
      if (extra === 'novacollapsed') {
        if (Nova._stateForTest().watching) $('[data-nova-watch]')?.click();
        await wait(650);
        const persistent = ['.nv-quick-actions', '.nv-track-card', '.nv-lyric-card'].every((selector) => {
          const el = $(selector);
          return el && !el.closest('.nv-collapse-wrap') && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
        });
        const pass = Nova._stateForTest().collapsed && !Nova._stateForTest().watching && persistent && parseFloat(getComputedStyle($('.nv-collapse-wrap')).height) < 2;
        console.warn('SELFTEST novacollapsed: ' + JSON.stringify({ persistent, pass }));
      }
      const ns = Nova._stateForTest();
      console.warn(`SELFTEST nova: panel=${App.panel} track=${ns.trackKey} lyricIndex=${ns.line?.index} activeLine=${ns.line?.index >= 0} synced=${Boolean(App.lyrics.data?.synced)} watching=${ns.watching} state=${JSON.stringify(ns)}`);
    } else if (extra === 'queue' || extra === 'lyrics') {
      const l = [...UI.Lists.values()].find((x) => x.tracks.length);
      if (l) Player.cue(l.tracks, 0, 0, l.source);
      await new Promise((r) => setTimeout(r, 1500));
      openPanel(extra);
      await new Promise((r) => setTimeout(r, 2500));
    } else if (extra === 'play') {
      // Самопроверка: реально запускаем трек и смотрим, что звук идёт
      await silentPlay(0);
      const a = Player.audio;
      console.warn(`SELFTEST play: paused=${a.paused} currentTime=${a.currentTime.toFixed(2)} duration=${a.duration} error=${a.error ? a.error.code : 'none'} quality=${Player.stream?.quality} preview=${Player.stream?.preview} webaudio=${AudioFX.ctx?.state} level=${Viz.level.toFixed(3)}`);
      Player.next();
      await new Promise((r) => setTimeout(r, 4000));
      console.warn(`SELFTEST next: index=${Player.index} title=${Player.current?.title} paused=${a.paused} t=${a.currentTime.toFixed(2)}`);
      Player.seek(10);
      await new Promise((r) => setTimeout(r, 1500));
      console.warn(`SELFTEST seek: t=${a.currentTime.toFixed(2)} level=${Viz.level.toFixed(3)}`);
      Player.pause();
    } else if (extra === 'menu') {
      const row = $('.tr');
      if (row) {
        const r = row.getBoundingClientRect();
        trackMenu(trackFromRow(row), r.left + 300, r.top + 20, {});
      }
      await new Promise((r) => setTimeout(r, 600));
    } else {
      const l = [...UI.Lists.values()].find((x) => x.tracks.length);
      if (l && !Player.current) Player.cue(l.tracks, 0, 0, l.source);
      await new Promise((r) => setTimeout(r, 2000));
    }
    window.zvuk.screenshotReady();
  }

  boot().catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#fff">Ошибка запуска: ${esc(e.message)}</div>`);
  });
})();
