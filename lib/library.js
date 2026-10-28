'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');
const { parseName, stageSource, deployMod, undeployMod } = require('./installer');
const { checkCompat } = require('./compat');
const { hasUpdate } = require('./versions');
const { isGameDir } = require('./game');

class Library {
  constructor({ root, getGameDir, onChange }) {
    this.staging = path.join(root, 'staging');
    this.getGameDir = getGameDir;
    this.onChange = onChange || (() => {});
    fs.mkdirSync(this.staging, { recursive: true });
    this.store = createStore(path.join(root, 'library.json'), { mods: [], collections: [] });
    this.queue = Promise.resolve();

    // clean leftovers of an interrupted install
    for (const name of fs.readdirSync(this.staging)) {
      if (name.startsWith('.work-')) fs.rmSync(path.join(this.staging, name), { recursive: true, force: true });
    }
  }

  get mods() {
    return this.store.data.mods;
  }

  get collections() {
    return this.store.data.collections;
  }

  /** Light copy for the UI: no file lists, but update and compatibility flags. */
  snapshot() {
    const gameDir = this.getGameDir();
    const ready = isGameDir(gameDir);
    const issues = ready ? checkCompat(this.mods, (rel) => fs.existsSync(path.join(gameDir, ...rel.split('/')))) : {};
    return {
      mods: this.mods.map(({ files, ...rest }) => ({
        ...rest,
        fileCount: files.length,
        update: hasUpdate(rest),
        issues: issues[rest.id] || [],
      })),
      collections: this.collections,
    };
  }

  modDir(id) {
    return path.join(this.staging, id);
  }

  _run(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  _commit() {
    this.store.save();
    this.onChange(this.snapshot());
  }

  _gameDir() {
    const dir = this.getGameDir();
    if (!dir || !fs.existsSync(dir)) throw new Error('Не найдена папка игры. Укажите её в настройках.');
    return dir;
  }

  _mod(id) {
    const mod = this.mods.find((m) => m.id === id);
    if (!mod) throw new Error('Мод не найден.');
    return mod;
  }

  /** Remove a mod's files from the game and hand shared files back to other enabled mods. */
  async _undeploy(mod, gameDir) {
    await undeployMod(mod, gameDir);
    const own = new Set(mod.files);
    for (const other of this.mods) {
      if (other.id === mod.id || !other.enabled) continue;
      const shared = other.files.filter((f) => own.has(f));
      if (shared.length) await deployMod(other, this.staging, gameDir, shared);
    }
  }

  async _setEnabled(mod, enabled, gameDir) {
    if (mod.enabled === enabled) return;
    if (enabled) await deployMod(mod, this.staging, gameDir);
    else await this._undeploy(mod, gameDir);
    mod.enabled = enabled;
  }

  /* ----------------------------------------------------------------- mods */

  /**
   * @param meta optional { modId, fileId, version } known from Nexus,
   *             and { replaceId } to update that exact mod in place.
   */
  install(src, meta = {}) {
    return this._run(async () => {
      const gameDir = this._gameDir();
      const stat = await fsp.stat(src);
      const base = stat.isDirectory() ? path.basename(src) : path.basename(src, path.extname(src));
      const parsed = parseName(base);

      const replace = meta.replaceId ? this.mods.find((m) => m.id === meta.replaceId) : null;
      const name = replace ? replace.name : parsed.name;
      const modId = String(meta.modId || parsed.modId || '');
      const existing = replace || this.mods.find((m) => m.name === name && (m.modId || '') === modId);

      const id = crypto.randomUUID();
      const { files, size } = await stageSource(src, { stagingRoot: this.staging, id, modName: name });

      const mod = {
        id,
        name,
        version: String(meta.version || parsed.version || ''),
        modId,
        fileId: String(meta.fileId || ''),
        source: path.basename(src),
        size,
        files,
        enabled: false,
        installedAt: existing ? existing.installedAt : Date.now(),
        updatedAt: Date.now(),
        latest: existing ? existing.latest : undefined,
      };

      let wasEnabled = true;
      if (existing) {
        wasEnabled = existing.enabled;
        const index = this.mods.indexOf(existing);
        await this._undeploy(existing, gameDir);
        await fsp.rm(this.modDir(existing.id), { recursive: true, force: true });
        this.mods[index] = mod;
        for (const c of this.collections) c.modIds = c.modIds.map((x) => (x === existing.id ? id : x));
      } else {
        this.mods.push(mod);
      }

      try {
        if (wasEnabled) await this._setEnabled(mod, true, gameDir);
      } finally {
        this._commit();
      }
      return { id, name: mod.name };
    });
  }

  setEnabled(id, enabled) {
    return this._run(async () => {
      const mod = this._mod(id);
      await this._setEnabled(mod, !!enabled, this._gameDir());
      this._commit();
    });
  }

  remove(id) {
    return this._run(async () => {
      const mod = this._mod(id);
      if (mod.enabled) {
        const dir = this.getGameDir();
        if (dir && fs.existsSync(dir)) await this._undeploy(mod, dir);
      }
      await fsp.rm(this.modDir(id), { recursive: true, force: true });
      this.store.data.mods = this.mods.filter((m) => m.id !== id);
      for (const c of this.collections) c.modIds = c.modIds.filter((x) => x !== id);
      this._commit();
    });
  }

  /** Stores the newest Nexus version found for several mods at once: [{ id, latest }] */
  applyLatest(results) {
    return this._run(async () => {
      for (const { id, latest } of results) {
        const mod = this.mods.find((m) => m.id === id);
        if (mod) mod.latest = latest || undefined;
      }
      this._commit();
    });
  }

  /* ---------------------------------------------------------- collections */

  saveCollection({ id, name, modIds }) {
    return this._run(async () => {
      const title = String(name || '').trim().slice(0, 80);
      if (!title) throw new Error('Введите название коллекции.');
      const known = new Set(this.mods.map((m) => m.id));
      const ids = [...new Set(modIds || [])].filter((x) => known.has(x));

      const existing = id && this.collections.find((c) => c.id === id);
      if (existing) {
        existing.name = title;
        existing.modIds = ids;
      } else {
        this.collections.push({ id: crypto.randomUUID(), name: title, modIds: ids, createdAt: Date.now() });
      }
      this._commit();
    });
  }

  deleteCollection(id) {
    return this._run(async () => {
      this.store.data.collections = this.collections.filter((c) => c.id !== id);
      this._commit();
    });
  }

  setCollectionEnabled(id, enabled) {
    return this._run(async () => {
      const coll = this.collections.find((c) => c.id === id);
      if (!coll) throw new Error('Коллекция не найдена.');
      const gameDir = this._gameDir();
      try {
        for (const modId of coll.modIds) {
          const mod = this.mods.find((m) => m.id === modId);
          if (mod) await this._setEnabled(mod, !!enabled, gameDir);
        }
      } finally {
        this._commit();
      }
    });
  }

  flush() {
    this.store.flush();
  }
}

module.exports = { Library };
