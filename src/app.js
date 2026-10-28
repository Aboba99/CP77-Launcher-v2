'use strict';

const NEXUS_HOME = 'https://www.nexusmods.com/games/cyberpunk2077';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: {},
  mods: [],
  collections: [],
  nexus: { linked: false, user: null, waiting: false },
  search: '',
  sort: { key: 'installedAt', dir: -1 },
  busy: 0,
};

/* ------------------------------------------------------------------ helpers */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  mods: '<path d="M12 3l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 17l8 4 8-4"/>',
  collections: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  play: '<path d="M7 4l13 8-13 8V4z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moon: '<path d="M20 14a8 8 0 11-10-10 6.5 6.5 0 0010 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  forward: '<path d="M9 5l7 7-7 7"/>',
  reload: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
};

function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || ''; // static, trusted strings only
  return s;
}

function fillIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => {
    if (el.firstChild && el.firstChild.nodeName === 'svg') return;
    el.prepend(icon(el.dataset.icon, Number(el.dataset.size) || 18));
  });
}

async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || 'Ошибка');
  return res.data;
}

async function safe(promise) {
  try {
    const data = await call(promise);
    return data === undefined ? true : data; // undefined is reserved for "failed"
  } catch (err) {
    toast('error', err.message);
    return undefined;
  }
}

function toast(type, text) {
  const el = h('div', { class: `toast ${type}`, text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' || type === 'info' ? 7000 : 3500);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

const formatDate = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });

function hash(str) {
  let x = 0;
  for (const ch of str) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x;
}

function schedule(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

/* ---------------------------------------------------------------- busy/install */

function setBusy(delta) {
  state.busy = Math.max(0, state.busy + delta);
  $('#busy').hidden = state.busy === 0;
}

async function installPaths(paths) {
  setBusy(1);
  try {
    await call(api.installMods(paths));
  } catch (err) {
    toast('error', err.message);
  } finally {
    setBusy(-1);
  }
}

/* ------------------------------------------------------------------- tabs */

function showTab(name) {
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'nexus') ensureWebview();
  if (name === 'settings') validateSettings();
}

/* ------------------------------------------------------------------- theme */

function applyTheme() {
  const dark = state.settings.theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeLabel').textContent = dark ? 'Тёмная тема' : 'Светлая тема';
  const holder = $('#themeIcon');
  holder.replaceChildren(icon(dark ? 'moon' : 'sun'));
  $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === (dark ? 'dark' : 'light')));
}

async function setTheme(theme) {
  state.settings.theme = theme;
  applyTheme();
  await safe(api.setSettings({ theme }));
}

/* -------------------------------------------------------------------- mods */

const COMPARE = {
  name: (a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }),
  version: (a, b) => (a.version || '').localeCompare(b.version || '', undefined, { numeric: true }),
  installedAt: (a, b) => a.installedAt - b.installedAt,
  size: (a, b) => a.size - b.size,
};

const renderMods = schedule(() => {
  $('#modCount').textContent = state.mods.length || '';
  const q = state.search.trim().toLowerCase();
  const list = state.mods
    .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.source || '').toLowerCase().includes(q))
    .sort((a, b) => COMPARE[state.sort.key](a, b) * state.sort.dir);

  $$('#modHead [data-sort]').forEach((b) => {
    const on = b.dataset.sort === state.sort.key;
    b.classList.toggle('sorted', on);
    b.dataset.arrow = on ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : '';
    b.textContent = b.textContent.replace(/ [↑↓]$/, '') + b.dataset.arrow;
  });

  renderBadges();
  $('#modEmpty').hidden = state.mods.length > 0;
  const frag = document.createDocumentFragment();
  for (const mod of list) frag.append(modRow(mod));
  $('#modRows').replaceChildren(frag);
});

function renderBadges() {
  const updates = state.mods.filter((m) => m.update).length;
  const bad = state.mods.filter((m) => m.issues && m.issues.length);
  const hasError = bad.some((m) => m.issues.some((i) => i.level === 'error'));
  $('#updBadge').textContent = updates || '';
  const badge = $('#compatBadge');
  badge.textContent = state.mods.length ? bad.length || '✓' : '';
  badge.className = `badge ${bad.length ? (hasError ? 'bad' : 'warn') : 'ok'}`;
}

function issueLines(mod) {
  const list = mod.issues || [];
  const lines = list.slice(0, 2).map((i) => h('small', { class: `issue ${i.level}`, text: `${i.level === 'error' ? '✖' : '⚠'} ${i.text}` }));
  if (list.length > 2) lines.push(h('small', { class: 'issue warn', text: `…и ещё проблем: ${list.length - 2}` }));
  return lines;
}

function versionCell(mod) {
  const cell = h('span', { class: 'ver-cell' }, h('span', { class: 'muted', text: mod.version || '—' }));
  if (mod.update && mod.latest) {
    const label = mod.latest.version || 'новая';
    const btn = h('button', { class: 'pill', title: `Обновить до ${label}`, text: `↑ ${label}` });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Обновление…';
      await safe(api.updateMod(mod.id));
      renderMods();
    });
    cell.append(btn);
  }
  return cell;
}

function modRow(mod) {
  const toggle = h(
    'label',
    { class: 'switch' },
    h('input', {
      type: 'checkbox',
      checked: mod.enabled,
      onChange: async (e) => {
        const res = await safe(api.toggleMod(mod.id, e.target.checked));
        if (res === undefined) renderMods();
      },
    }),
    h('span')
  );

  const del = h('button', { class: 'icon-btn', title: 'Удалить' });
  del.append(icon('trash'));
  del.addEventListener('click', () => {
    if (del.dataset.armed) {
      safe(api.removeMod(mod.id));
      return;
    }
    del.dataset.armed = '1';
    del.className = 'icon-btn confirm';
    del.replaceChildren('Удалить?');
    setTimeout(() => {
      if (!del.isConnected) return;
      delete del.dataset.armed;
      del.className = 'icon-btn';
      del.replaceChildren(icon('trash'));
    }, 3000);
  });

  return h(
    'div',
    { class: `row${mod.enabled ? '' : ' off'}` },
    toggle,
    h('div', { class: 'mod-name' }, h('b', { text: mod.name, title: mod.name }), h('small', { text: `${mod.source} · файлов: ${mod.fileCount}` }), issueLines(mod)),
    versionCell(mod),
    h('span', { class: 'muted', text: formatDate(mod.installedAt) }),
    h('span', { class: 'muted', text: formatSize(mod.size) }),
    h('div', { class: 'actions' }, del)
  );
}

/* ----------------------------------------------------- updates and compatibility */

async function checkUpdates() {
  const btn = $('#updBtn');
  btn.disabled = true;
  $('#updLabel').textContent = 'Проверяю…';
  const res = await safe(api.checkUpdates());
  btn.disabled = false;
  $('#updLabel').textContent = 'Обновления';
  if (!res || res === true) return;
  if (!res.checked) toast('info', 'Нет модов, скачанных с Nexus: их версию проверить нельзя.');
  else if (res.updates) toast('info', `Доступны обновления модов: ${res.updates}`);
  else toast('success', 'Все моды актуальны');
}

function openCompat() {
  const dlg = $('#dialog');
  const bad = state.mods.filter((m) => m.issues && m.issues.length);
  const items = bad.length
    ? bad.map((m) =>
        h('div', { class: 'compat-item' }, h('b', { text: m.name }), m.issues.map((i) => h('small', { class: `issue ${i.level}`, text: `${i.level === 'error' ? '✖' : '⚠'} ${i.text}` })))
      )
    : [h('p', { class: 'muted', text: 'Проблем не найдено.' })];
  dlg.replaceChildren(
    h('h2', { text: 'Совместимость модов' }),
    h('small', { class: 'muted', text: 'Проверяются включённые моды: общие файлы между модами и нужные им фреймворки (Cyber Engine Tweaks, RED4ext, redscript, ArchiveXL, TweakXL). Версию самой игры проверка не учитывает.' }),
    h('div', { class: 'compat-list' }, items),
    h('div', { class: 'dlg-foot' }, h('button', { class: 'btn primary', text: 'Закрыть', onClick: () => dlg.close() }))
  );
  dlg.showModal();
}

/* ------------------------------------------------------------- collections */

const renderCollections = schedule(() => {
  const byId = new Map(state.mods.map((m) => [m.id, m]));
  $('#collEmpty').hidden = state.collections.length > 0;
  const frag = document.createDocumentFragment();

  for (const c of state.collections) {
    const mods = c.modIds.map((id) => byId.get(id)).filter(Boolean);
    const on = mods.filter((m) => m.enabled).length;
    const edit = h('button', { class: 'icon-btn', title: 'Изменить', onClick: () => openCollectionEditor(c) });
    edit.append(icon('edit'));

    frag.append(
      h(
        'article',
        { class: 'card' },
        h('div', { class: 'cover', vars: { '--h': hash(c.name) % 360 } }, h('span', { text: [...c.name][0].toUpperCase() })),
        h(
          'div',
          { class: 'card-body' },
          h('h3', { text: c.name, title: c.name }),
          h('span', { class: 'muted', text: `Модов: ${mods.length} · включено: ${on}` }),
          h(
            'div',
            { class: 'card-foot' },
            h(
              'label',
              { class: 'switch' },
              h('input', {
                type: 'checkbox',
                checked: mods.length > 0 && on === mods.length,
                disabled: mods.length === 0,
                onChange: async (e) => {
                  const res = await safe(api.toggleCollection(c.id, e.target.checked));
                  if (res === undefined) renderCollections();
                },
              }),
              h('span')
            ),
            edit
          )
        )
      )
    );
  }
  $('#collGrid').replaceChildren(frag);
});

function openCollectionEditor(coll) {
  const dlg = $('#dialog');
  const selected = new Set(coll ? coll.modIds : []);
  const name = h('input', { class: 'input', placeholder: 'Название коллекции', maxlength: '80', value: coll ? coll.name : '' });
  const filter = h('input', { class: 'input', placeholder: 'Поиск модов…' });
  const list = h('div', { class: 'pick-list' });

  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const items = state.mods.filter((m) => !q || m.name.toLowerCase().includes(q));
    list.replaceChildren(
      ...(items.length
        ? items.map((m) =>
            h(
              'label',
              { class: 'pick' },
              h('input', {
                type: 'checkbox',
                checked: selected.has(m.id),
                onChange: (e) => (e.target.checked ? selected.add(m.id) : selected.delete(m.id)),
              }),
              h('span', { text: m.name })
            )
          )
        : [h('div', { class: 'pick muted', text: 'Нет установленных модов' })])
    );
  };
  filter.addEventListener('input', renderList);
  renderList();

  const foot = h(
    'div',
    { class: 'dlg-foot' },
    coll &&
      h('button', {
        class: 'btn danger left',
        text: 'Удалить',
        onClick: async () => {
          await safe(api.deleteCollection(coll.id));
          dlg.close();
        },
      }),
    h('button', { class: 'btn', text: 'Отмена', onClick: () => dlg.close() }),
    h('button', {
      class: 'btn primary',
      text: 'Сохранить',
      onClick: async () => {
        const res = await safe(api.saveCollection({ id: coll && coll.id, name: name.value, modIds: [...selected] }));
        if (res !== undefined) dlg.close();
      },
    })
  );

  dlg.replaceChildren(h('h2', { text: coll ? 'Изменить коллекцию' : 'Новая коллекция' }), name, filter, list, foot);
  dlg.showModal();
  name.focus();
}

/* ------------------------------------------------------------------- nexus */

let webview = null;
let webviewReady = false;

function updateNav() {
  if (!webview) return;
  try {
    $('#nxBack').disabled = !webview.canGoBack();
    $('#nxFwd').disabled = !webview.canGoForward();
  } catch {
    /* not ready yet */
  }
}

function ensureWebview() {
  if (webview) return;
  webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:nexus');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('src', NEXUS_HOME);
  $('#nexusHost').append(webview);

  const onNav = (e) => {
    if (e.url) $('#nxUrl').value = e.url;
    updateNav();
  };
  webview.addEventListener('did-navigate', onNav);
  webview.addEventListener('did-navigate-in-page', onNav);
  webview.addEventListener('dom-ready', () => {
    webviewReady = true;
    updateNav();
  });
}

function nexusGo(url) {
  ensureWebview();
  if (webviewReady) webview.loadURL(url).catch(() => {});
  else webview.setAttribute('src', url);
}

function showDownload(d) {
  const bar = $('#dlBar');
  if (d.state === 'done' || d.state === 'error') {
    $('#dlFill').style.width = d.state === 'done' ? '100%' : '0';
    setTimeout(() => (bar.hidden = true), 1500);
    return;
  }
  bar.hidden = false;
  $('#dlName').textContent = `Загрузка: ${d.name}`;
  $('#dlFill').style.width = d.total > 0 ? `${Math.round((d.received / d.total) * 100)}%` : '30%';
}

/* ------------------------------------------------------------ nexus account */

function renderNexus() {
  const { linked, user, waiting } = state.nexus;
  const status = $('#nxStatus');
  if (waiting) status.textContent = 'Ожидаю ключ… войдите на открывшейся странице и скопируйте «Personal API Key».';
  else if (!linked) status.textContent = 'Аккаунт не привязан';
  else if (user) status.textContent = `✓ ${user.name}${user.premium ? ' · Premium' : ''}`;
  else status.textContent = 'Ключ сохранён (нет связи с Nexus Mods)';
  status.className = `hint ${linked && !waiting ? 'ok' : ''}`;
  $('#nxLinkRow').hidden = linked && !waiting;
  $('#nxLogin').hidden = waiting;
  $('#nxCancel').hidden = !waiting;
  $('#nxUnlink').hidden = !linked || waiting;
}

async function linkNexus() {
  const input = $('#nxKey');
  const data = await safe(api.linkNexus(input.value));
  if (!data) return;
  input.value = '';
  state.nexus = data;
  renderNexus();
  toast('success', 'Аккаунт Nexus Mods привязан');
}

/* ---------------------------------------------------------------- settings */

async function validateSettings() {
  const v = await safe(api.validate());
  if (!v) return;
  const set = (el, ok, good, bad) => {
    el.textContent = ok ? good : bad;
    el.className = `hint ${ok ? 'ok' : 'bad'}`;
  };
  set($('#launchHint'), v.launch, '✓ Путь найден', 'Файл не найден');
  set($('#dirHint'), v.gameDir, '✓ Найден Cyberpunk2077.exe', 'Папка с игрой не найдена (нужна папка, где лежит bin\\x64)');
}

function loadSettingsForm() {
  $('#launchPath').value = state.settings.launchPath || '';
  $('#gameDir').value = state.settings.gameDir || '';
  $('#launchArgs').value = state.settings.launchArgs || '';
}

async function saveSettings(patch) {
  const data = await safe(api.setSettings(patch));
  if (!data) return;
  state.settings = data;
  loadSettingsForm();
  validateSettings();
  const ok = $('#saved');
  ok.hidden = false;
  setTimeout(() => (ok.hidden = true), 1200);
}

/* -------------------------------------------------------------------- init */

async function playGame() {
  const btn = $('#playBtn');
  btn.disabled = true;
  $('#playLabel').textContent = 'Запуск…';
  await safe(api.launch());
  setTimeout(() => {
    btn.disabled = false;
    $('#playLabel').textContent = 'Играть';
  }, 3000);
}

function bindDragOverlay() {
  const overlay = $('#dropOverlay');
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  let depth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.classList.add('show');
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('show');
  });
  document.addEventListener('drop', () => {
    depth = 0;
    overlay.classList.remove('show');
  });
}

async function main() {
  fillIcons();

  const init = await call(api.init());
  state.settings = init.settings;
  state.mods = init.library.mods;
  state.collections = init.library.collections;
  state.nexus = init.nexus;
  applyTheme();
  renderNexus();
  loadSettingsForm();

  $$('.nav').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#themeBtn').addEventListener('click', () => setTheme(state.settings.theme === 'light' ? 'dark' : 'light'));
  $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
  $('#playBtn').addEventListener('click', playGame);

  $('#addBtn').addEventListener('click', async () => {
    setBusy(1);
    try {
      await call(api.pickMods());
    } catch (err) {
      toast('error', err.message);
    } finally {
      setBusy(-1);
    }
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderMods();
  });
  $('#modHead').addEventListener('click', (e) => {
    const key = e.target.dataset && e.target.dataset.sort;
    if (!key) return;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
    renderMods();
  });
  $('#newCollBtn').addEventListener('click', () => openCollectionEditor(null));

  $('#nxBack').addEventListener('click', () => webview && webview.canGoBack() && webview.goBack());
  $('#nxFwd').addEventListener('click', () => webview && webview.canGoForward() && webview.goForward());
  $('#nxReload').addEventListener('click', () => webview && webview.reload());
  $$('[data-nx]').forEach((b) => b.addEventListener('click', () => nexusGo(b.dataset.nx)));

  $('#nxLogin').addEventListener('click', () => safe(api.loginNexus()));
  $('#nxCancel').addEventListener('click', async () => {
    const data = await safe(api.cancelLogin());
    if (data && data !== true) {
      state.nexus = data;
      renderNexus();
    }
  });
  $('#updBtn').addEventListener('click', checkUpdates);
  $('#compatBtn').addEventListener('click', openCompat);
  $('#nxLink').addEventListener('click', linkNexus);
  $('#nxKey').addEventListener('keydown', (e) => e.key === 'Enter' && linkNexus());
  $('#nxUnlink').addEventListener('click', async () => {
    const data = await safe(api.unlinkNexus());
    if (data) {
      state.nexus = data;
      renderNexus();
    }
  });

  $('#launchPath').addEventListener('change', (e) => saveSettings({ launchPath: e.target.value }));
  $('#gameDir').addEventListener('change', (e) => saveSettings({ gameDir: e.target.value }));
  $('#launchArgs').addEventListener('change', (e) => saveSettings({ launchArgs: e.target.value }));
  $('#pickLaunch').addEventListener('click', async () => {
    const p = await safe(api.pickLaunch());
    if (p) saveSettings({ launchPath: p });
  });
  $('#pickDir').addEventListener('click', async () => {
    const p = await safe(api.pickDir());
    if (p) saveSettings({ gameDir: p });
  });
  $('#detectBtn').addEventListener('click', async () => {
    const data = await safe(api.detectGame());
    if (data) {
      state.settings = data;
      loadSettingsForm();
      validateSettings();
    } else if (data === null) {
      toast('info', 'Игра не найдена автоматически. Укажите папку вручную.');
    }
  });

  api.on('library:changed', (lib) => {
    state.mods = lib.mods;
    state.collections = lib.collections;
    renderMods();
    renderCollections();
  });
  api.on('toast', (t) => toast(t.type, t.text));
  api.on('download', showDownload);
  api.on('nexus:user', (n) => {
    state.nexus = n;
    renderNexus();
  });
  api.on('goto', showTab);
  api.on('nexus:open', (url) => {
    showTab('nexus');
    nexusGo(url);
  });
  api.onFilesDropped(installPaths);
  bindDragOverlay();

  renderMods();
  renderCollections();
}

main().catch((err) => {
  console.error(err);
  document.body.prepend(h('pre', { text: `Ошибка запуска: ${err.message}` }));
});
