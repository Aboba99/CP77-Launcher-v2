'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeTheme, net, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createStore } = require('./lib/store');
const { Library } = require('./lib/library');
const { detectGame, deriveGameDir, isGameDir } = require('./lib/game');
const { GAME, createNexus, isApiKey, parseNxm } = require('./lib/nexus');
const { hasUpdate } = require('./lib/versions');

const NEXUS_PARTITION = 'persist:nexus';
const NEXUS_HOST = /^https:\/\/([\w-]+\.)*nexusmods\.com(\/|$)/i;
const KEY_PAGE = 'https://www.nexusmods.com/users/myaccount?tab=api';
const BG = { dark: '#101216', light: '#f3f4f7' };
const SETTABLE = ['theme', 'launchPath', 'gameDir', 'launchArgs'];
const DEFAULTS = { theme: 'dark', launchPath: '', gameDir: '', launchArgs: '', nexusKey: '', lastUpdateCheck: 0 };
const UPDATE_CHECK_EVERY = 6 * 3600e3;
const LOGIN_WAIT = 3 * 60e3;

let win = null;
let settings = null;
let library = null;
let nexus = null;
let nexusUser = null;
let loginTimer = null;

const pendingUpdates = new Map(); // modId -> { replaceId, fileId, version, until }
const recentNxm = new Set();

const isNxm = (url) => /^nxm:/i.test(url);
const isWeb = (url) => /^https?:/i.test(url);
const isProtocolLink = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const toast = (type, text) => send('toast', { type, text });

function progressSender(name) {
  let last = 0;
  return (received, total) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    send('download', { name, state: 'progress', received, total });
  };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'Недопустимый источник запроса.' };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

/* ------------------------------------------------------------------ settings */

function publicSettings() {
  const { nexusKey, ...rest } = settings.data;
  return rest;
}

function applyTheme() {
  const theme = settings.data.theme === 'light' ? 'light' : 'dark';
  settings.data.theme = theme;
  nativeTheme.themeSource = theme;
  if (win && !win.isDestroyed()) win.setBackgroundColor(BG[theme]);
}

function adoptGame(found) {
  settings.data.gameDir = found.gameDir;
  if (!settings.data.launchPath) settings.data.launchPath = found.exe;
  settings.save();
}

/* --------------------------------------------------------------- nexus account */

function getKey() {
  const stored = settings.data.nexusKey;
  if (!stored) return '';
  try {
    const buf = Buffer.from(stored, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}

function setKey(key) {
  if (!key) settings.data.nexusKey = '';
  else if (safeStorage.isEncryptionAvailable()) settings.data.nexusKey = safeStorage.encryptString(key).toString('base64');
  else settings.data.nexusKey = Buffer.from(key, 'utf8').toString('base64');
  settings.save();
}

const nexusState = () => ({ linked: !!settings.data.nexusKey, user: nexusUser, waiting: !!loginTimer });

async function refreshNexusUser() {
  const key = getKey();
  nexusUser = null;
  if (key) nexusUser = await nexus.validate(key).catch(() => null);
  send('nexus:user', nexusState());
}

function stopLogin() {
  if (loginTimer) clearInterval(loginTimer);
  loginTimer = null;
  send('nexus:user', nexusState());
}

/**
 * "Sign in with Nexus": opens the API key page in the default browser and links the account
 * as soon as a Nexus-shaped key (70-100 base64 characters) is in the clipboard.
 * A key the user copied earlier counts too: copying the same text again changes nothing.
 */
async function startLogin() {
  if (loginTimer) clearInterval(loginTimer);
  const seen = new Set(); // texts Nexus already rejected
  const until = Date.now() + LOGIN_WAIT;
  let busy = false;

  loginTimer = setInterval(async () => {
    if (busy) return;
    if (Date.now() > until) {
      stopLogin();
      toast('info', 'Время ожидания ключа вышло. Нажмите «Войти через Nexus» ещё раз.');
      return;
    }
    const text = clipboard.readText().trim();
    if (seen.has(text) || !isApiKey(text)) return;
    seen.add(text);
    busy = true;
    try {
      const user = await nexus.validate(text);
      nexusUser = user;
      setKey(text);
      if (clipboard.readText().trim() === text) clipboard.clear();
      stopLogin();
      toast('success', `Nexus Mods: вход выполнен (${user.name}). Для скачивания войдите ещё раз на сайте во вкладке Nexus Mods — вход запомнится.`);
    } catch (err) {
      if (err.status !== 401) seen.delete(text); // network trouble: try the same text again
    } finally {
      busy = false;
    }
  }, 1000);

  try {
    await shell.openExternal(KEY_PAGE);
  } catch (err) {
    stopLogin();
    throw err;
  }
  send('nexus:user', nexusState());
}

/* ------------------------------------------------------------ nexus downloads */

/** Gets a download link from the API, downloads the file and installs it. */
async function fetchAndInstall(label, link, meta) {
  const report = progressSender(label);
  send('download', { name: label, state: 'start', received: 0, total: 0 });
  try {
    const uri = await nexus.downloadLink(getKey(), link);
    const dir = path.join(app.getPath('userData'), 'downloads', String(Date.now()));
    const file = await nexus.download(uri, dir, report);
    send('download', { name: path.basename(file), state: 'done' });
    await installPaths([file], { cleanup: true, meta });
  } catch (err) {
    send('download', { name: label, state: 'error' });
    throw err;
  }
}

/** nxm:// link from the site's "Mod Manager Download" button. */
async function handleNxm(url) {
  if (recentNxm.has(url)) return;
  recentNxm.add(url);
  setTimeout(() => recentNxm.delete(url), 5000);

  const link = parseNxm(url);
  if (!link) return toast('error', 'Неподдерживаемая ссылка Nexus Mods.');
  if (link.type === 'collection') {
    return toast('info', 'Коллекции Nexus ставятся только через Vortex. Скачайте моды из коллекции по одному.');
  }
  if (link.game !== GAME) return toast('error', 'Эта ссылка не для Cyberpunk 2077.');
  if (!getKey()) {
    send('goto', 'settings');
    return toast('error', 'Чтобы ставить моды в один клик, войдите: Настройки → Nexus Mods.');
  }

  // a download the user started with the "Update" button replaces the old version
  const pend = pendingUpdates.get(link.modId);
  const isUpdate = !!pend && pend.until > Date.now() && pend.fileId === link.fileId;
  if (isUpdate) pendingUpdates.delete(link.modId);
  const meta = { modId: link.modId, fileId: link.fileId, ...(isUpdate ? { replaceId: pend.replaceId, version: pend.version } : {}) };

  try {
    await fetchAndInstall(`мод ${link.modId}`, link, meta);
  } catch (err) {
    toast('error', err.message);
  }
}

/* ------------------------------------------------------------------- updates */

async function checkUpdates() {
  const key = getKey();
  if (!key) throw new Error('Чтобы проверять обновления, войдите в Nexus Mods в настройках.');

  const targets = library.mods.filter((m) => m.modId);
  const results = [];
  let next = 0;
  let failure = null;

  async function worker() {
    while (!failure && next < targets.length) {
      const mod = targets[next++];
      try {
        const latest = await nexus.latestFile(key, mod.modId, mod.fileId);
        results.push({ id: mod.id, latest: latest ? { ...latest, checkedAt: Date.now() } : undefined });
      } catch (err) {
        if (err.status !== 404) failure = err; // 404: the mod was removed from Nexus, skip it
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));

  await library.applyLatest(results);
  if (failure) throw failure;
  settings.data.lastUpdateCheck = Date.now();
  settings.save();
  return { checked: targets.length, updates: library.mods.filter(hasUpdate).length };
}

async function autoCheckUpdates() {
  if (!getKey() || Date.now() - (settings.data.lastUpdateCheck || 0) < UPDATE_CHECK_EVERY) return;
  try {
    const { updates } = await checkUpdates();
    if (updates) toast('info', `Доступны обновления модов: ${updates}`);
  } catch {
    /* offline or rate limited: try again on the next start */
  }
}

async function updateMod(id) {
  const mod = library.mods.find((m) => m.id === String(id));
  if (!mod || !mod.latest || !hasUpdate(mod)) throw new Error('Нет данных об обновлении. Нажмите «Обновления».');
  if (!getKey()) throw new Error('Войдите в Nexus Mods в настройках.');
  const { fileId, version } = mod.latest;
  if (!/^\d+$/.test(mod.modId) || !/^\d+$/.test(fileId)) throw new Error('Не удалось определить файл обновления.');

  // premium accounts may download through the API, everyone else goes through the website button
  if (nexusUser && nexusUser.premium) {
    await fetchAndInstall(`${mod.name} ${version}`, { modId: mod.modId, fileId }, { modId: mod.modId, fileId, version, replaceId: mod.id });
    return { mode: 'direct' };
  }
  pendingUpdates.set(mod.modId, { replaceId: mod.id, fileId, version, until: Date.now() + 30 * 60e3 });
  send('nexus:open', `https://www.nexusmods.com/${GAME}/mods/${mod.modId}?tab=files&file_id=${fileId}`);
  toast('info', 'Нажмите «Mod Manager Download» у выделенного файла — обновление установится само.');
  return { mode: 'site' };
}

/* -------------------------------------------------------------------- game */

function resolveGameDir(launchPath) {
  let target = launchPath;
  if (/\.lnk$/i.test(target) && process.platform === 'win32') {
    try {
      target = shell.readShortcutLink(target).target;
    } catch {
      return '';
    }
  }
  return deriveGameDir(target);
}

async function launchGame() {
  const target = String(settings.data.launchPath || '').trim().replace(/^"(.*)"$/, '$1');
  if (!target) throw new Error('Укажите путь к игре или ярлыку в настройках.');

  if (isProtocolLink(target)) return shell.openExternal(target); // e.g. steam://rungameid/1091500
  if (!fs.existsSync(target)) throw new Error(`Файл не найден: ${target}`);

  if (path.extname(target).toLowerCase() === '.exe') {
    const args = (String(settings.data.launchArgs).match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
    const child = spawn(target, args, { cwd: path.dirname(target), detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    return;
  }

  const error = await shell.openPath(target); // .lnk, .url, ...
  if (error) throw new Error(error);
}

/* ------------------------------------------------------------------ installs */

async function installPaths(paths, { cleanup = false, meta } = {}) {
  const results = [];
  for (const p of paths) {
    const label = path.basename(p);
    try {
      const mod = await library.install(p, meta);
      results.push({ ok: true, name: mod.name });
      toast('success', `Установлено: ${mod.name}`);
    } catch (err) {
      results.push({ ok: false, name: label, error: err.message });
      toast('error', `${label}: ${err.message}`);
    } finally {
      if (cleanup) fs.promises.rm(path.dirname(p), { recursive: true, force: true }).catch(() => {});
    }
  }
  return results;
}

/* ----------------------------------------------------------- nexus web session */

function setupNexusSession() {
  const ses = session.fromPartition(NEXUS_PARTITION);
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|cp-77-v2|cp77-launcher)\/\S+/g, ''));

  // manual downloads from the website land here and are installed automatically
  ses.on('will-download', (_event, item) => {
    const dir = path.join(app.getPath('userData'), 'downloads', String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(item.getFilename() || 'mod.zip');
    const target = path.join(dir, name);
    item.setSavePath(target);

    const report = progressSender(name);
    send('download', { name, state: 'start', received: 0, total: item.getTotalBytes() });
    item.on('updated', () => report(item.getReceivedBytes(), item.getTotalBytes()));
    item.once('done', (_e, state) => {
      if (state !== 'completed') {
        send('download', { name, state: 'error' });
        toast('error', `Загрузка не завершена: ${name}`);
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        return;
      }
      send('download', { name, state: 'done' });
      installPaths([target], { cleanup: true });
    });
  });
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;

  const guard = (event, url) => {
    if (isNxm(url)) {
      event.preventDefault();
      handleNxm(url);
    } else if (!isWeb(url)) {
      event.preventDefault();
    }
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);

  contents.setWindowOpenHandler(({ url }) => {
    if (isNxm(url)) handleNxm(url);
    else if (isWeb(url)) contents.loadURL(url);
    return { action: 'deny' };
  });
});

/* -------------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'CP77 Launcher v2',
    backgroundColor: BG[settings.data.theme] || BG.dark,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.removeMenu();

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    params.partition = NEXUS_PARTITION;
    if (!NEXUS_HOST.test(params.src || '')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

/* ------------------------------------------------------------------------ IPC */

function registerIpc() {
  ipcMain.on('theme:get', (event) => {
    event.returnValue = settings.data.theme;
  });

  handle('app:init', () => ({ settings: publicSettings(), library: library.snapshot(), nexus: nexusState() }));

  handle('settings:set', (patch) => {
    const data = settings.data;
    for (const key of SETTABLE) if (patch && typeof patch[key] === 'string') data[key] = patch[key].trim();
    if (patch && 'launchPath' in patch && !data.gameDir) data.gameDir = resolveGameDir(data.launchPath);
    applyTheme();
    settings.save();
    library.onChange(library.snapshot()); // the game folder may have changed: refresh compatibility
    return publicSettings();
  });

  handle('settings:validate', () => {
    const launch = String(settings.data.launchPath || '').replace(/^"(.*)"$/, '$1');
    return {
      gameDir: isGameDir(settings.data.gameDir),
      launch: !!launch && (isProtocolLink(launch) || fs.existsSync(launch)),
    };
  });

  handle('settings:pickLaunch', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Игра или ярлык для запуска',
      properties: ['openFile'],
      filters: [
        { name: 'Игра или ярлык', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('settings:pickDir', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Папка с игрой', properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('settings:detect', () => {
    const found = detectGame();
    if (!found) return null;
    adoptGame(found);
    library.onChange(library.snapshot());
    return publicSettings();
  });

  handle('game:launch', launchGame);

  handle('nexus:login', startLogin);
  handle('nexus:loginCancel', () => {
    stopLogin();
    return nexusState();
  });
  handle('nexus:link', async (key) => {
    const apiKey = String(key || '').trim();
    if (!apiKey) throw new Error('Вставьте API-ключ.');
    nexusUser = await nexus.validate(apiKey);
    setKey(apiKey);
    stopLogin();
    return nexusState();
  });
  handle('nexus:unlink', () => {
    setKey('');
    nexusUser = null;
    stopLogin();
    return nexusState();
  });

  handle('mods:install', (paths) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
      throw new Error('Некорректные файлы.');
    }
    return installPaths(paths);
  });

  handle('mods:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите файлы модов',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Моды', extensions: ['zip', '7z', 'rar', 'archive', 'xl', 'reds', 'tweak', 'yaml', 'dll'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : installPaths(res.filePaths);
  });

  handle('mods:toggle', (id, enabled) => library.setEnabled(String(id), !!enabled));
  handle('mods:remove', (id) => library.remove(String(id)));
  handle('mods:checkUpdates', checkUpdates);
  handle('mods:update', updateMod);

  handle('collections:save', (c) => library.saveCollection(c || {}));
  handle('collections:delete', (id) => library.deleteCollection(String(id)));
  handle('collections:toggle', (id, enabled) => library.setCollectionEnabled(String(id), !!enabled));
}

/* ------------------------------------------------------------------ lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cp77.launcher.v2');
    const userData = app.getPath('userData');

    settings = createStore(path.join(userData, 'settings.json'), DEFAULTS);
    library = new Library({
      root: path.join(userData, 'library'),
      getGameDir: () => settings.data.gameDir,
      onChange: (snapshot) => send('library:changed', snapshot),
    });
    nexus = createNexus({ fetchImpl: (url, opts) => net.fetch(url, opts), version: app.getVersion() });

    if (!settings.data.gameDir) {
      const found = detectGame();
      if (found) adoptGame(found);
    }

    applyTheme();
    setupNexusSession();
    registerIpc();
    createWindow();
    refreshNexusUser().then(autoCheckUpdates);
  });

  app.on('before-quit', () => {
    if (loginTimer) clearInterval(loginTimer);
    if (settings) settings.flush();
    if (library) library.flush();
  });
  app.on('window-all-closed', () => app.quit());
}
