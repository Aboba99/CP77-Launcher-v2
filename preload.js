'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// apply the saved theme before the first paint
const theme = ipcRenderer.sendSync('theme:get');
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

const EVENTS = new Set(['toast', 'download', 'library:changed', 'nexus:user', 'nexus:open', 'goto']);
let dropHandler = null;

// Dropped files: resolve real paths here (File.path no longer exists in modern Electron)
window.addEventListener('dragover', (e) => e.preventDefault(), true);
window.addEventListener(
  'drop',
  (e) => {
    e.preventDefault();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean);
    if (paths.length && dropHandler) dropHandler(paths);
  },
  true
);

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  init: invoke('app:init'),
  setSettings: invoke('settings:set'),
  validate: invoke('settings:validate'),
  pickLaunch: invoke('settings:pickLaunch'),
  pickDir: invoke('settings:pickDir'),
  detectGame: invoke('settings:detect'),
  launch: invoke('game:launch'),

  loginNexus: invoke('nexus:login'),
  cancelLogin: invoke('nexus:loginCancel'),
  linkNexus: invoke('nexus:link'),
  unlinkNexus: invoke('nexus:unlink'),

  installMods: invoke('mods:install'),
  pickMods: invoke('mods:pick'),
  toggleMod: invoke('mods:toggle'),
  removeMod: invoke('mods:remove'),
  checkUpdates: invoke('mods:checkUpdates'),
  updateMod: invoke('mods:update'),

  saveCollection: invoke('collections:save'),
  deleteCollection: invoke('collections:delete'),
  toggleCollection: invoke('collections:toggle'),

  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onFilesDropped: (cb) => {
    dropHandler = cb;
  },
});
