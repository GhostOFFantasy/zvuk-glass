'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

async function call(method, ...args) {
  const r = await ipcRenderer.invoke('zvuk', method, args);
  if (!r.ok) {
    const err = new Error(r.error.message);
    err.code = r.error.code;
    throw err;
  }
  return r.data;
}

contextBridge.exposeInMainWorld('zvuk', {
  call,
  auth: {
    state: () => ipcRenderer.invoke('auth:state'),
    withToken: (token) => ipcRenderer.invoke('auth:token', token),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  player: {
    state: (st) => ipcRenderer.send('player:state', st),
    onCommand: (fn) => ipcRenderer.on('media:command', (_e, cmd) => fn(cmd)),
    thumbarIcons: (icons) => ipcRenderer.send('thumbar:icons', icons),
    appIcon: (dataUrl) => ipcRenderer.send('app:icon', dataUrl),
  },
  clipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  media: {
    pick: async (key, kind) => {
      const r = await ipcRenderer.invoke('media:pick', key, kind);
      if (!r.ok) throw new Error(r.error.message);
      return r.data;
    },
    clear: (key) => ipcRenderer.invoke('media:clear', key),
  },
  yt: {
    state: () => ipcRenderer.invoke('yt:state'),
    setKey: (k) => ipcRenderer.invoke('yt:setKey', k),
    clearKey: () => ipcRenderer.invoke('yt:clearKey'),
    find: (track, force) => ipcRenderer.invoke('yt:find', track, force),
    update: (trackId, patch) => ipcRenderer.invoke('yt:update', trackId, patch),
    clearCache: () => ipcRenderer.invoke('yt:clearCache'),
    parse: (text) => ipcRenderer.invoke('yt:parse', text),
  },
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (fn) => ipcRenderer.on('update:status', (_e, st) => fn(st)),
  },
  setZoom: (f) => webFrame.setZoomFactor(Math.min(1.4, Math.max(0.75, Number(f) || 1))),
  openZvuk: (url) => ipcRenderer.invoke('shell:open', url),
  screenshotReady: (delay) => ipcRenderer.send('screenshot:ready', delay),
});
