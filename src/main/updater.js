'use strict';
/*
 * Обновления «по воздуху» через GitHub Releases (electron-updater).
 * Работает только в установленной версии: при запуске и каждые 4 часа проверяет новый релиз,
 * тихо скачивает его в фоне и ставит при выходе из приложения (или сразу — по кнопке «Перезапустить»).
 */
const { app, ipcMain } = require('electron');

const FIRST_CHECK_MS = 8000;
const EVERY_MS = 4 * 60 * 60 * 1000;

let status = { state: 'idle' };
let getWin = () => null;
let updater = null;
let timer = null;

function send(patch) {
  status = { ...patch, current: app.getVersion(), packaged: app.isPackaged };
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send('update:status', status);
}

function load() {
  if (updater || !app.isPackaged) return updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    console.error('electron-updater недоступен', e);
    return null;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = null;
  updater.on('checking-for-update', () => send({ state: 'checking' }));
  updater.on('update-not-available', () => send({ state: 'none', checkedAt: Date.now() }));
  updater.on('update-available', (i) => send({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', (p) => send({ state: 'downloading', version: status.version, percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  updater.on('error', (e) => send({ state: 'error', message: friendly(e) }));
  return updater;
}

function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(m)) return 'Нет связи с GitHub';
  if (/404|latest\.yml/i.test(m)) return 'На GitHub пока нет опубликованных версий';
  if (/rate limit|403/i.test(m)) return 'GitHub временно ограничил запросы, попробуем позже';
  return m.split('\n')[0].slice(0, 160) || 'Неизвестная ошибка';
}

async function check() {
  const u = load();
  if (!u) {
    send({ state: 'dev' });
    return status;
  }
  if (status.state === 'ready' || status.state === 'downloading' || status.state === 'checking') return status;
  try {
    await u.checkForUpdates();
  } catch (e) {
    send({ state: 'error', message: friendly(e) });
  }
  return status;
}

function init(winGetter, { enabled = true, firstCheckMs = FIRST_CHECK_MS } = {}) {
  getWin = winGetter;
  ipcMain.handle('update:state', () => ({ ...status, current: app.getVersion(), packaged: app.isPackaged }));
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => {
    if (!updater || status.state !== 'ready') return false;
    // тихая установка и сразу запуск новой версии
    setImmediate(() => updater.quitAndInstall(true, true));
    return true;
  });
  if (!enabled || !app.isPackaged) return;
  setTimeout(check, firstCheckMs);
  timer = setInterval(check, EVERY_MS);
  timer.unref?.();
}

module.exports = { init, check };
