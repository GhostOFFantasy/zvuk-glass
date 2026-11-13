'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeImage, clipboard, protocol, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { ZvukClient } = require('./zvuk-api');
const Clips = require('./clips');
const Updater = require('./updater');

// Протокол для своих файлов пользователя (обои, аватар, видео) — регистрируется до запуска
protocol.registerSchemesAsPrivileged([
  { scheme: 'zg-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---------- Аргументы запуска ----------
const argv = process.argv.slice(1);
const argValue = (name) => {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const SCREENSHOT = argValue('screenshot'); // путь к PNG (или true) — служебный режим для проверки интерфейса
const DEMO = Boolean(argValue('demo') || SCREENSHOT); // анонимный токен, без входа
const ROUTE = argValue('route');
const EXTRA = argValue('extra');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const LOGIN_PREVIEW = Boolean(argValue('login-preview')); // служебно: показать экран входа при снимке

if (!SCREENSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Настройки ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  quality: 'flac',
  volume: 0.8,
  shuffle: false,
  repeat: 'off',
  liquidGlass: false,
  wave: { energy: null, fun: null, language: null, instrumental: false, genres: [], popularity: null },
  custom: {},
  eq: null,
  viz: {},
  profileLocal: {},
  media: {}, // ключ → { path, mime, copied, v }
  bounds: null,
};
const PUBLIC_KEYS = ['quality', 'volume', 'shuffle', 'repeat', 'liquidGlass', 'wave', 'custom', 'eq', 'viz', 'profileLocal'];

// ---------- Свои файлы пользователя ----------
const MEDIA_KEYS = new Set(['avatar', 'wallImage', 'wallVideo', 'vizVideo', 'vizImage']);
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
};
const mediaDir = () => path.join(app.getPath('userData'), 'media');
const mediaUrl = (key) => {
  const m = settings.media && settings.media[key];
  return m && fs.existsSync(m.path) ? `zg-media://file/${key}?v=${m.v}` : null;
};
const mediaUrls = () => Object.fromEntries([...MEDIA_KEYS].map((k) => [k, mediaUrl(k)]));

function dropMedia(key) {
  const old = settings.media && settings.media[key];
  if (old && old.copied) {
    try {
      fs.unlinkSync(old.path);
    } catch {}
  }
  if (settings.media) delete settings.media[key];
}

async function pickMedia(key, kind) {
  if (!MEDIA_KEYS.has(key)) throw new Error('bad key');
  const filters =
    kind === 'video'
      ? [{ name: 'Видео', extensions: ['mp4', 'webm', 'm4v', 'mkv', 'mov'] }]
      : [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }];
  const r = await dialog.showOpenDialog(win, { title: kind === 'video' ? 'Выберите видео' : 'Выберите изображение', properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error('Неподдерживаемый формат файла');
  dropMedia(key);
  const size = fs.statSync(src).size;
  let file = src;
  let copied = false;
  // Небольшие файлы копируем к себе (переживут удаление оригинала), большие видео — используем на месте
  if (size < 60 * 1024 * 1024) {
    fs.mkdirSync(mediaDir(), { recursive: true });
    file = path.join(mediaDir(), `${key}-${Date.now()}.${ext}`);
    fs.copyFileSync(src, file);
    copied = true;
  }
  settings.media = { ...(settings.media || {}), [key]: { path: file, mime, copied, v: Date.now() } };
  saveSettings();
  return mediaUrl(key);
}

/** Отдаёт файл с поддержкой Range — нужно для перемотки и зацикливания видео. */
function serveMedia(request) {
  const u = new URL(request.url);
  const key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const m = MEDIA_KEYS.has(key) && settings.media && settings.media[key];
  if (!m || !fs.existsSync(m.path)) return new Response('Not found', { status: 404 });
  const size = fs.statSync(m.path).size;
  const headers = { 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = request.headers.get('range');
  if (range) {
    const mt = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = mt[1] ? parseInt(mt[1], 10) : 0;
    let end = mt[2] ? parseInt(mt[2], 10) : size - 1;
    if (!mt[1] && mt[2]) {
      start = Math.max(0, size - parseInt(mt[2], 10));
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const body = Readable.toWeb(fs.createReadStream(m.path, { start, end }));
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(m.path)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}
let settings = { ...DEFAULT_SETTINGS };
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  // 1.4: тяжёлый эффект преломления теперь выключен по умолчанию (включается в настройках)
  if (!settings.migr14) {
    settings.liquidGlass = false;
    settings.migr14 = true;
    saveSettings();
  }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error('settings save failed', e);
    }
  }, 300);
}

// ---------- Токен (хранится зашифрованным средствами Windows) ----------
function saveToken(token) {
  if (!token) {
    delete settings.tokenEnc;
    delete settings.tokenPlain;
  } else if (safeStorage.isEncryptionAvailable()) {
    settings.tokenEnc = safeStorage.encryptString(token).toString('base64');
    delete settings.tokenPlain;
  } else {
    settings.tokenPlain = token;
  }
  saveSettings();
}
function readToken() {
  try {
    if (settings.tokenEnc) return safeStorage.decryptString(Buffer.from(settings.tokenEnc, 'base64'));
  } catch {
    return null;
  }
  return settings.tokenPlain || null;
}

// ---------- Клипы с YouTube: ключ пользователя (зашифрован) и кэш найденного ----------
let clipCache = null;
function saveYtKey(key) {
  delete settings.ytKeyEnc;
  delete settings.ytKeyPlain;
  if (key && safeStorage.isEncryptionAvailable()) settings.ytKeyEnc = safeStorage.encryptString(key).toString('base64');
  else if (key) settings.ytKeyPlain = key;
  saveSettings();
}
function readYtKey() {
  try {
    if (settings.ytKeyEnc) return safeStorage.decryptString(Buffer.from(settings.ytKeyEnc, 'base64'));
  } catch {
    return null;
  }
  return settings.ytKeyPlain || null;
}
/** track: { id, title, artists: [названия], duration }. force — искать заново. */
async function findClip(track, force = false) {
  const prev = clipCache.get(track.id);
  if (prev && !force) return prev;
  const key = readYtKey();
  if (!key) return { ...(prev || {}), error: 'NO_KEY' };
  const cands = await Clips.search(key, track);
  const pick = cands.length && cands[0].score >= 4 ? 0 : null;
  return clipCache.set(track.id, { cands, pick, manual: prev?.manual || null, offset: prev?.offset || 0, at: Date.now() });
}

// ---------- Клиент Zvuk ----------
const client = new ZvukClient();
let profile = null;

async function initAuth() {
  if (LOGIN_PREVIEW) return;
  if (DEMO) {
    client.setToken(await client.getAnonymousToken());
    profile = await client.getProfile();
    return;
  }
  const token = readToken();
  if (!token) return;
  client.setToken(token);
  try {
    const p = await client.getProfile();
    if (p.isAnonymous) {
      client.setToken(null);
      profile = null;
    } else profile = p;
  } catch (e) {
    // Нет сети или временная блокировка — работаем с сохранённым токеном, профиль подтянем позже.
    profile = { id: '', name: null, isAnonymous: false, offline: true };
  }
}

async function authState() {
  if (!client.token || !profile) return { authorized: false, demo: DEMO };
  return { authorized: true, demo: DEMO, profile: { id: profile.id, name: profile.name, image: profile.image, isAnonymous: profile.isAnonymous } };
}

async function applyToken(token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9._-]{16,}$/.test(token)) throw new Error('Похоже, это не токен Zvuk');
  const probe = new ZvukClient({ token });
  probe.jar = client.jar;
  const p = await probe.getProfile();
  if (p.isAnonymous) throw new Error('Этот токен анонимный — войдите в аккаунт на zvuk.com и скопируйте токен заново');
  client.setToken(token);
  profile = p;
  saveToken(token);
  return authState();
}

// ---------- Главное окно ----------
let win = null;
function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: SCREENSHOT ? 1400 : b.width || 1360,
    height: SCREENSHOT ? 900 : b.height || 880,
    x: SCREENSHOT ? undefined : b.x,
    y: SCREENSHOT ? undefined : b.y,
    minWidth: 980,
    minHeight: 640,
    show: true,
    // В служебном режиме снимков окно видимо (иначе не идут анимации), но полностью прозрачно
    ...(SCREENSHOT ? { opacity: 0, skipTaskbar: true, focusable: false } : {}),
    title: 'Zvuk Glass',
    backgroundColor: '#0b0b10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#f2f2f7', height: 44 },
    ...(fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (b.maximized && !SCREENSHOT) win.maximize();

  const query = {};
  if (ROUTE) query.route = ROUTE;
  if (SCREENSHOT) query.screenshot = '1';
  if (typeof EXTRA === 'string') query.extra = EXTRA;
  if (typeof argValue('vizstyle') === 'string') query.vizstyle = argValue('vizstyle');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query });

  // Внешние ссылки — в системный браузер.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || SCREENSHOT) return;
    settings.bounds = { ...(win.isMaximized() ? settings.bounds || {} : win.getBounds()), maximized: win.isMaximized() };
    saveSettings();
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);
  win.on('closed', () => (win = null));

  if (SCREENSHOT) {
    win.webContents.on('console-message', (...args) => {
      const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
      const level = d ? d.level : args[1];
      const message = d ? d.message : args[2];
      if (level === 'error' || level === 'warning' || level >= 2) console.log('[renderer]', message);
    });
    ipcMain.once('screenshot:ready', async (_e, delay) => {
      await new Promise((r) => setTimeout(r, typeof delay === 'number' ? delay : 1200));
      const img = await win.webContents.capturePage();
      const out = typeof SCREENSHOT === 'string' ? SCREENSHOT : path.join(process.cwd(), 'screenshot.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SCREENSHOT_SAVED', out);
      app.quit();
    });
    setTimeout(() => {
      console.log('SCREENSHOT_TIMEOUT');
      app.quit();
    }, argValue('updtest') ? 300000 : 60000);
  }
}

// ---------- Кнопки на миниатюре в панели задач ----------
let thumbIcons = null;
function updateThumbar(playing) {
  if (!win || !thumbIcons || process.platform !== 'win32') return;
  const send = (cmd) => () => win && win.webContents.send('media:command', cmd);
  win.setThumbarButtons([
    { tooltip: 'Предыдущий', icon: thumbIcons.prev, click: send('prev') },
    { tooltip: playing ? 'Пауза' : 'Играть', icon: playing ? thumbIcons.pause : thumbIcons.play, click: send('toggle') },
    { tooltip: 'Следующий', icon: thumbIcons.next, click: send('next') },
  ]);
}

// ---------- IPC ----------
const API_METHODS = new Set([
  'quickSearch', 'search', 'autocomplete', 'getTracks', 'getStream', 'getLyrics', 'getRelatedTracks',
  'getRelease', 'getArtist', 'getReleasesShort', 'getArtistsShort', 'getPlaylistsShort', 'getPlaylist',
  'createPlaylist', 'addTracksToPlaylist', 'updatePlaylist', 'renamePlaylist', 'deletePlaylist',
  'getCollectionIds', 'getLikedTrackIds', 'like', 'unlike', 'hideTrack', 'personalWave', 'getWaves',
  'waveContent', 'radio', 'recommendations', 'synthesisPlaylists', 'listeningHistory', 'recentlyPlayed',
  'getSubscription',
]);

function registerIpc() {
  ipcMain.handle('zvuk', async (_e, method, args) => {
    if (!API_METHODS.has(method)) return { ok: false, error: { code: 'BAD_METHOD', message: method } };
    try {
      const data = await client[method](...(Array.isArray(args) ? args : []));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'ERROR', message: e.message } };
    }
  });

  ipcMain.handle('auth:state', () => authState());
  ipcMain.handle('auth:token', async (_e, token) => {
    try {
      return { ok: true, data: await applyToken(token) };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  ipcMain.handle('auth:logout', async () => {
    client.setToken(null);
    profile = null;
    saveToken(null);
    return authState();
  });
  // Буфер обмена читается только по кнопке «Вставить» на экране входа
  ipcMain.handle('clipboard:read', () => (profile ? '' : clipboard.readText()));

  ipcMain.handle('settings:get', () => {
    const pub = Object.fromEntries(PUBLIC_KEYS.map((k) => [k, settings[k]]));
    pub.mediaUrls = mediaUrls();
    return pub;
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    for (const k of PUBLIC_KEYS) if (patch && k in patch) settings[k] = patch[k];
    saveSettings();
    return true;
  });
  ipcMain.handle('media:pick', async (_e, key, kind) => {
    try {
      return { ok: true, data: await pickMedia(key, kind) };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  ipcMain.handle('media:clear', (_e, key) => {
    if (MEDIA_KEYS.has(key)) {
      dropMedia(key);
      saveSettings();
    }
    return true;
  });

  ipcMain.on('player:state', (_e, st) => {
    if (!win) return;
    updateThumbar(Boolean(st && st.playing));
    win.setTitle(st && st.title ? `${st.title} — ${st.artist || ''} · Zvuk Glass` : 'Zvuk Glass');
  });
  ipcMain.on('thumbar:icons', (_e, icons) => {
    try {
      thumbIcons = Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, nativeImage.createFromDataURL(v)]));
      updateThumbar(false);
    } catch {}
  });
  ipcMain.on('app:icon', (_e, dataUrl) => {
    try {
      if (!win || !dataUrl) return;
      const image = nativeImage.createFromDataURL(dataUrl);
      win.setIcon(image);
      if (!fs.existsSync(ICON_PATH)) {
        fs.mkdirSync(path.dirname(ICON_PATH), { recursive: true });
        const png = image.toPNG();
        fs.writeFileSync(ICON_PATH, png);
        // .ico для ярлыка Windows: контейнер ICO с PNG внутри
        const head = Buffer.alloc(22);
        head.writeUInt16LE(0, 0);
        head.writeUInt16LE(1, 2);
        head.writeUInt16LE(1, 4);
        head.writeUInt8(0, 6); // 256
        head.writeUInt8(0, 7);
        head.writeUInt16LE(1, 10);
        head.writeUInt16LE(32, 12);
        head.writeUInt32LE(png.length, 14);
        head.writeUInt32LE(22, 18);
        fs.writeFileSync(ICON_PATH.replace(/\.png$/, '.ico'), Buffer.concat([head, png]));
      }
    } catch {}
  });
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https:\/\/((www\.)?zvuk\.com|console\.cloud\.google\.com|(www\.)?youtube\.com)\//.test(url)) shell.openExternal(url);
    return true;
  });

  // ---------- Клипы ----------
  const wrap = (fn) => async (_e, ...a) => {
    try {
      return { ok: true, data: await fn(...a) };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'ERROR', message: e.message } };
    }
  };
  ipcMain.handle('yt:state', () => ({ hasKey: Boolean(readYtKey()), cached: clipCache ? clipCache.size : 0 }));
  ipcMain.handle(
    'yt:setKey',
    wrap(async (key) => {
      key = String(key || '').trim();
      if (!/^[\w-]{20,}$/.test(key)) throw new Clips.ClipError('Похоже, это не ключ API', 'BAD_KEY');
      await Clips.checkKey(key);
      saveYtKey(key);
      return true;
    })
  );
  ipcMain.handle('yt:clearKey', () => (saveYtKey(null), true));
  ipcMain.handle('yt:find', wrap((track, force) => findClip(track, force)));
  ipcMain.handle(
    'yt:update',
    wrap((trackId, patch) => {
      const e = clipCache.get(trackId) || { cands: [], pick: null, manual: null, offset: 0, at: Date.now() };
      for (const k of ['pick', 'manual', 'offset']) if (patch && k in patch) e[k] = patch[k];
      return clipCache.set(trackId, e);
    })
  );
  ipcMain.handle('yt:clearCache', () => (clipCache.clear(), true));
  ipcMain.handle('yt:parse', (_e, text) => Clips.parseVideoId(text));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (SCREENSHOT) app.setPath('userData', path.join(app.getPath('temp'), 'zvuk-glass-screenshot'));
  loadSettings();
  protocol.handle('zg-media', serveMedia);
  // Аудиопотоки Zvuk анализируются Web Audio (визуализатор, эквалайзер) — разрешаем их чтение странице
  clipCache = new Clips.ClipCache(app.getPath('userData'));
  // Встроенный плеер YouTube требует заголовок Referer (иначе «ошибка 153»), а у локальной страницы его нет.
  // Подставляем нейтральный адрес в зарезервированной зоне .invalid — он никому не принадлежит.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*'] }, (d, cb) => {
    if (d.resourceType === 'subFrame' && !d.requestHeaders.Referer) d.requestHeaders.Referer = 'https://zvuk-glass.invalid/';
    cb({ requestHeaders: d.requestHeaders });
  });
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://*/*', 'http://*/*'] }, (details, cb) => {
    if (details.resourceType !== 'media') return cb({});
    const h = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      const lk = k.toLowerCase();
      if (lk !== 'access-control-allow-origin' && lk !== 'access-control-allow-credentials') h[k] = v;
    }
    h['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: h });
  });
  registerIpc();
  // в режиме снимков обновления не проверяются (кроме служебной проверки самого обновления)
  const updTest = Boolean(SCREENSHOT && argValue('updtest'));
  Updater.init(() => win, { enabled: !SCREENSHOT || updTest, firstCheckMs: SCREENSHOT ? 500 : undefined, test: updTest });
  await initAuth().catch((e) => console.error('auth init failed', e));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
