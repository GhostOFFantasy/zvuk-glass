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
    App.settings = await window.zvuk.settings.get();
    App.settings.viz = { style: 'bars', color: 'accent', sensitivity: 1, dim: 35, pulse: true, syncVideo: true, ...(App.settings.viz || {}) };
    App.settings.profileLocal = App.settings.profileLocal || {};
    document.body.classList.toggle('liquid-on', App.settings.liquidGlass !== false);
    Custom.init(App.settings);
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
      <div class="upd-tx"><b>Готово обновление ${esc(st.version || '')}</b><span>Установится само при выходе — или прямо сейчас</span></div>
      <button class="btn small primary" data-upd="install">${icon('refresh')}Перезапустить</button>
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
    Custom.setTrackTheme(null);
    // Мини-визуализатор на фоне панели плеера
    // 30 кадров/с, обычная чёткость и мягкий стиль — фоновой полоске больше не нужно
    App.miniViz = Viz.attach($('#miniViz'), { style: 'bars', soft: true, barH: 0.9, bars: 72, maxDpr: 1, fps: 30, glow: false, idle: false, sensitivity: 0.9 });
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
    if (SCREENSHOT) screenshotWhenReady();
  }

  /** Имя и аватар: свои (локальные) имеют приоритет над данными Zvuk. */
  App.displayName = () => App.settings.profileLocal?.name || App.profile?.name || (App.demo ? 'Гость' : 'Профиль');
  App.avatarUrl = (size = 64) => Custom.media.avatar || (App.profile?.image ? img(App.profile.image, size) : '');
  function renderProfileChip() {
    const name = App.displayName();
    const av = App.avatarUrl(64);
    $('#profileChip').innerHTML = `<span class="ava">${av ? `<img src="${esc(av)}" alt="">` : esc(name[0])}</span><span>${esc(name)}</span>`;
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
    // сцена визуализатора держит клип YouTube и анимацию — освобождаем её вместе со старым экраном
    if (Views._vizScene) {
      Views._vizScene.destroy();
      Views._vizScene = null;
    }
    const view = document.createElement('div');
    view.className = 'view' + (keepScroll ? '' : ' enter');
    view.id = 'view';
    old.replaceWith(view);
    sc.scrollTop = keepScroll ? prevScroll : 0;
    const { view: v, params: p } = App.route;
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
    const hiddenSec = active && active.closest('.sec-body') && $('#sidebar').classList.contains('sec-lib-off') && !document.body.classList.contains('compact-sidebar');
    if (active && !hiddenSec) {
      const sb = $('#sidebar').getBoundingClientRect();
      const r = active.getBoundingClientRect();
      ind.style.transform = `translateY(${r.top - sb.top}px)`;
      ind.style.opacity = '1';
    } else ind.style.opacity = '0';
  }
  window.addEventListener('resize', debounce(updateNav, 100));

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
    $('#sidebar').classList.toggle('sec-lib-off', Boolean(s.lib));
    $('#sidebar').classList.toggle('sec-pl-off', Boolean(s.pl));
    $$('.sec-toggle').forEach((b) => (b.title = s[b.dataset.sec] ? 'Развернуть' : 'Свернуть'));
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
        const a = await api('getArtist', id);
        Player.playList(a.popularTracks || [], 0, { kind: 'list', title: a.title });
      } else if (kind === 'wave') {
        startEditorialWave(id);
      } else if (kind === 'liked') {
        navigate('liked');
      }
    } catch (e) {
      toast('Не удалось запустить: ' + e.message, { error: true });
    }
  }

  function startMyWave() {
    const opts = UI.waveOptions();
    Player.startEndless({
      kind: 'wave',
      title: 'Моя волна',
      params: { opts },
      fetchMore: () => window.zvuk.call('personalWave', 10, opts),
    });
  }
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
    if (s.kind === 'wave') source = { kind: 'wave', title: 'Моя волна', params: s.params, fetchMore: () => window.zvuk.call('personalWave', 10, s.params?.opts || {}) };
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
  let seekUI, npSeekUI, volUI;
  function bindPlayer() {
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
    volUI = slider($('#vol'), {
      onInput: (v) => {
        Player.volume = v;
        Player.muted = false;
        Player._applyVolume();
      },
      onCommit: (v) => Player.setVolume(v),
    });
    $('#vol').addEventListener('wheel', (e) => {
      e.preventDefault();
      Player.setVolume(Player.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    });

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
      if (App.panel === 'lyrics' || lyricsInNp()) loadLyrics();
      if (App.route?.view === 'wave') Views._waveNow();
      if (npOpen()) NP.render();
      Views._vizTrack && Views._vizTrack(t);
      NP.trackChanged(t);
      Clip.trackChanged();
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
    });
    Player.on('time', ({ cur, dur, buf }) => {
      const v = dur ? cur / dur : 0;
      seekUI.set(v, buf);
      $('#plCur').textContent = fmtTime(cur);
      $('#plDur').textContent = fmtTime(dur);
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
      volUI.set(muted ? 0 : volume);
      $('#plVolBtn .i').innerHTML = ICONS[muted || volume === 0 ? 'vol0' : volume < 0.5 ? 'vol1' : 'vol2'];
    });
    Player.on('empty', () => startMyWave());
    Player.on('loading', (on) => document.body.classList.toggle('loading', on));
    window.zvuk.player.onCommand((cmd) => (cmd === 'toggle' ? Player.toggle() : cmd === 'next' ? Player.next() : Player.prev()));
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
    if (name === 'queue') renderQueue();
    else {
      renderLyricsInto($('#spBody'));
      loadLyrics();
    }
  }
  function closePanel() {
    App.panel = null;
    $('#sidePanel').classList.remove('open');
    $('#plQueueBtn').classList.remove('on');
    $('#plLyricsBtn').classList.remove('on');
  }

  function renderQueue() {
    const body = $('#spBody');
    if (!Player.queue.length) {
      body.innerHTML = `<div class="empty">${icon('queue')}<div>Очередь пуста</div><button class="btn primary" data-act="wave-toggle">${icon('wave')}Включить «Мою волну»</button></div>`;
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
    App.lyrics = { trackId: t.id, data: null, loading: true };
    renderLyricsAll();
    let data = null;
    try {
      data = parseLyrics(await api('getLyrics', t.id));
    } catch {}
    if (App.lyrics.trackId !== t.id) return;
    App.lyrics = { trackId: t.id, data: data || 'none', loading: false };
    lastLine = -2;
    renderLyricsAll();
  }
  function renderLyricsAll() {
    if (App.panel === 'lyrics') renderLyricsInto($('#spBody'));
    if (lyricsInNp()) renderLyricsInto($('#npLyrics'));
  }
  function renderLyricsInto(el) {
    const L = App.lyrics;
    if (!Player.current) el.innerHTML = `<div class="empty">${icon('lyrics')}<div>Включите трек, чтобы увидеть текст</div></div>`;
    else if (L.loading || !L.data) el.innerHTML = `<div class="empty">${icon('lyrics')}<div>Загружаем текст…</div></div>`;
    else if (L.data === 'none') el.innerHTML = `<div class="empty">${icon('lyrics')}<div>Для этого трека нет текста</div></div>`;
    else if (L.data.synced)
      el.innerHTML = `<div class="lyrics">${L.data.lines.map((l, i) => `<div class="ln" data-act="lyric-seek" data-t="${l.t}" data-li="${i}">${esc(l.text || '♪')}</div>`).join('')}</div>`;
    else el.innerHTML = `<div class="lyrics plain">${esc(L.data.text)}</div>`;
    lastLine = -2;
    syncLyrics(Player.audio.currentTime);
  }
  let lastLine = -2;
  let userScrollAt = 0;
  ['#spBody', '#npLyrics'].forEach((s) => $(s).addEventListener('wheel', () => (userScrollAt = Date.now()), { passive: true }));
  function syncLyrics(cur) {
    const L = App.lyrics.data;
    if (!L || L === 'none' || !L.synced) return;
    if (App.panel !== 'lyrics' && !lyricsInNp()) return;
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
        if (row.dataset.queueIdx != null) return Player.playAt(+row.dataset.queueIdx);
        const l = UI.Lists.get(row.dataset.list);
        if (l) Player.playList(l.tracks, +row.dataset.idx, l.source || { kind: 'list', title: '' });
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
        Player.seek(+d.t);
        userScrollAt = 0;
        break;
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
        navigate('search', { q: d.q });
        break;
      case 'clear-searches':
        localStorage.removeItem('zg.searches');
        render(true);
        break;
      case 'expand-tracks': {
        const box = $('#searchTracks');
        if (box) box.style.maxHeight = 'none';
        el.remove();
        break;
      }
      case 'expand-pop': {
        const box = $('#popTracks');
        if (box) box.style.maxHeight = 'none';
        el.remove();
        break;
      }
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

  App.recentSearches = () => {
    try {
      return JSON.parse(localStorage.getItem('zg.searches') || '[]');
    } catch {
      return [];
    }
  };
  function rememberSearch(q) {
    const list = App.recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    localStorage.setItem('zg.searches', JSON.stringify(list.slice(0, 12)));
  }
  function doSearch(q) {
    q = q.trim();
    hideSuggest();
    if (!q) return navigate('search', {});
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
    if (App.route?.view === 'search') {
      hideSuggest();
      liveSearch();
    } else loadSuggest();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggItems.length) return;
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
  input.addEventListener('blur', () => setTimeout(hideSuggest, 150));
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
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
      if (npOpen()) closeNowPlaying();
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
    // Иконка приложения
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const r = 64;
    g.beginPath();
    g.roundRect(8, 8, 240, 240, r);
    g.clip();
    const cg = g.createConicGradient(3.5, 128, 128);
    cg.addColorStop(0, '#9d8cff');
    cg.addColorStop(0.35, '#ff7ab6');
    cg.addColorStop(0.65, '#ffd36e');
    cg.addColorStop(1, '#9d8cff');
    g.fillStyle = cg;
    g.fillRect(0, 0, 256, 256);
    const rg = g.createRadialGradient(80, 64, 0, 80, 64, 140);
    rg.addColorStop(0, 'rgba(255,255,255,.85)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#fff';
    g.lineWidth = 16;
    g.lineCap = 'round';
    g.beginPath();
    const ys = [0, -38, 30, -58, 44, -24, 10];
    ys.forEach((dy, i) => {
      const x = 52 + i * 25;
      g.moveTo(x, 128 - Math.abs(dy) / 2 - 8);
      g.lineTo(x, 128 + Math.abs(dy) / 2 + 8);
    });
    g.stroke();
    window.zvuk.player.appIcon(c.toDataURL('image/png'));
  }

  // ======================================================================
  // Служебный режим снимка экрана
  // ======================================================================
  async function screenshotWhenReady() {
    await new Promise((r) => setTimeout(r, 2500));
    const imgs = $$('img').filter((i) => i.src && !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => (i.onload = i.onerror = r)))), new Promise((r) => setTimeout(r, 5000))]);
    let extra = params.get('extra') || '';
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
    // служебно: выбрать стиль визуализатора для снимка
    if (params.get('vizstyle')) {
      App.settings.viz.style = params.get('vizstyle');
      if (App.route?.view === 'visualizer') {
        App.rerender();
        await wait(600);
      }
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
    if (extra.startsWith('np')) {
      if (extra.includes('play')) await silentPlay(2);
      else {
        const l = firstList();
        if (l) Player.cue(l.tracks, Math.min(2, l.tracks.length - 1), 0, l.source);
        await wait(1500);
      }
      NP.lyricsOn = extra.includes('lyrics');
      NP.vizOn = extra.includes('viz');
      openNowPlaying();
      await wait(2200);
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
      }
      if (extra.includes('viz')) {
        $('.vz-gear') && $('.vz-gear').click();
        await wait(600);
        console.warn(`SELFTEST npviz: vizOn=${NP.vizOn} canvas=${Boolean($('#npScene canvas'))} level=${Viz.level.toFixed(3)} appHidden=${document.body.classList.contains('np-open')}`);
      }
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
    } else if (extra.startsWith('clipsync')) {
      // clipsync@<id ролика> — проверить на другом ролике
      const vidArg = extra.includes('@') ? extra.split('@')[1] : 'dQw4w9WgXcQ';
      extra = extra.split('@')[0];
      // Автосинхронизация: тихое воспроизведение (звук нужен — его слушает захват), клип по ссылке.
      // Для гостя трек — 30-секундное превью из середины песни, поэтому сначала ищем место клипа,
      // где звучит этот фрагмент (ручной сдвиг шагами по 20 с), потом повторяем замер для проверки.
      const s = App.settings.viz;
      Object.assign(s, { bg: 'clip', style: 'waves', clipAuto: false, clipQ: '480' });
      let t;
      if (extra === 'clipsync') {
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
      await wait(4000);
      Clip._calKey = Clip.trackId + '|' + Clip.videoId; // подстройку запускает сам тест, по шагам
      s.clipAuto = true;
      const steps = extra === 'clipsync' ? [0, 20, 40, 60, 80, 100, 120, 140, 160, 180] : [0];
      for (const off of steps) {
        Player.seek(1);
        await Clip._update({ offset: off, auto: null });
        Clip._calKey = Clip.trackId + '|' + Clip.videoId; // чтобы подстройка не запустилась сама посреди шага
        await wait(2600);
        console.warn(`SELFTEST clipsync before off=${off}: paused=${Player.audio.paused} t=${Player.audio.currentTime.toFixed(2)} gain=${AudioFX.vol && AudioFX.vol.gain.value.toFixed(3)} ducked=${AudioFX.ducked} level=${Viz.level.toFixed(3)}`);
        await Clip.calibrate(true);
        console.warn(`SELFTEST clipsync try off=${off}: ${Clip.sync.state} ${Clip.sync.message}`);
        if (Clip.sync.state === 'done') break;
      }
      if (Clip.sync.state === 'done') {
        const first = Clip.autoInfo.offset;
        // точность удержания: расхождение по сообщениям YouTube в течение 4 секунд
        await wait(3000);
        const ds = [];
        for (let k = 0; k < 40; k++) {
          const f = $('.clip-frame');
          ds.push(Clip._driftForTest ? Clip._driftForTest() : NaN);
          await wait(100);
        }
        const v = ds.filter((x) => isFinite(x));
        const mean = v.reduce((a, b) => a + Math.abs(b), 0) / (v.length || 1);
        console.warn(`SELFTEST clipsync hold: mean|drift|=${(mean * 1000).toFixed(0)}ms max=${(Math.max(...v.map(Math.abs)) * 1000).toFixed(0)}ms n=${v.length}`);
        // повторный замер с того же места — должен дать тот же сдвиг
        Player.seek(Math.max(1, Player.audio.currentTime - 12));
        await wait(2500);
        await Clip.calibrate(true);
        console.warn(`SELFTEST clipsync repeat: first=${first} second=${Clip.autoInfo ? Clip.autoInfo.offset : '-'} diff=${Clip.autoInfo ? ((Clip.autoInfo.offset - first) * 1000).toFixed(0) + 'ms' : '-'}`);
      }
      $('.vz-gear') && $('.vz-gear').click();
      await wait(700);
    } else if (extra.startsWith('clipq')) {
      // Клип в заданном качестве (clipq1080, clipq480, clipqauto)
      App.settings.viz.bg = 'clip';
      App.settings.viz.style = 'waves';
      App.settings.viz.clipQ = extra.slice(5) || 'auto';
      await silentPlay(0);
      App.rerender();
      await wait(1200);
      await Clip.setLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await wait(12000);
      const f = $('.clip-frame');
      const box = $('.clip-box');
      console.warn(`SELFTEST clipq: want=${Clip.quality} actual=${Clip.actualQuality || '?'} frame=${f ? f.clientWidth + 'x' + f.clientHeight : '-'} box=${box ? box.clientWidth + 'x' + box.clientHeight : '-'} dpr=${devicePixelRatio} visible=${box && box.classList.contains('clip-on')}`);
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
    } else if (extra === 'waveplay') {
      startMyWave();
      AudioFX.setVolume(0);
      Player._applyVolume = () => AudioFX.setVolume(0);
      await wait(6000);
      console.warn(`SELFTEST wave: source=${Player.source?.kind} playing=${Player.playing} track=${Player.current?.id} level=${Viz.level.toFixed(3)}`);
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
    } else if (extra === 'suggest') {
      const inp = $('#searchInput');
      inp.focus();
      inp.value = 'atomic hear';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(2500);
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
