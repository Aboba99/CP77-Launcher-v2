'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { pickLatest } = require('./versions');

const API = 'https://api.nexusmods.com/v1';
const GAME = 'cyberpunk2077';

class NexusError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Personal API keys are long base64-like strings; the narrow shape keeps us from sending unrelated tokens. */
const isApiKey = (text) => /^[A-Za-z0-9+/_-]{70,100}={0,2}$/.test(String(text || '').trim());

/** Parses nxm://cyberpunk2077/mods/<id>/files/<id>?key=..&expires=.. */
function parseNxm(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'nxm:') return null;
  const game = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'mods' && parts[2] === 'files' && /^\d+$/.test(parts[1] || '') && /^\d+$/.test(parts[3] || '')) {
    return {
      type: 'mod',
      game,
      modId: parts[1],
      fileId: parts[3],
      key: u.searchParams.get('key') || '',
      expires: u.searchParams.get('expires') || '',
    };
  }
  if (parts[0] === 'collections') return { type: 'collection', game };
  return null;
}

function createNexus({ fetchImpl = fetch, version = '2.0.0', api = API } = {}) {
  async function request(apiKey, pathname, params = {}) {
    const url = new URL(api + pathname);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      headers: { apikey: apiKey, 'Application-Name': 'CP77 Launcher', 'Application-Version': version, accept: 'application/json' },
    });
    if (res.status === 401) throw new NexusError('Неверный API-ключ Nexus Mods.', 401);
    if (res.status === 403) {
      throw new NexusError('Nexus отказал в доступе. Бесплатным аккаунтам нужно скачивать кнопкой «Mod Manager Download» на странице мода.', 403);
    }
    if (res.status === 429) throw new NexusError('Слишком много запросов к Nexus Mods, подождите немного.', 429);
    if (!res.ok) throw new NexusError(`Nexus Mods вернул ошибку ${res.status}.`, res.status);
    return res.json();
  }

  return {
    async validate(apiKey) {
      const data = await request(apiKey, '/users/validate.json');
      return { name: String(data.name || ''), premium: !!data.is_premium };
    },

    /** Newest version of a mod as { fileId, version, name, chain } or null. */
    async latestFile(apiKey, modId, fileId) {
      return pickLatest(await request(apiKey, `/games/${GAME}/mods/${modId}/files.json`), fileId);
    },

    /** Free accounts must pass the key/expires pair from the nxm link; premium accounts don't need it. */
    async downloadLink(apiKey, { modId, fileId, key, expires }) {
      const list = await request(apiKey, `/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`, { key, expires });
      const uri = Array.isArray(list) && list[0] && list[0].URI;
      if (!uri) throw new NexusError('Nexus не вернул ссылку для скачивания. Возможно, она устарела — нажмите кнопку на сайте ещё раз.');
      return uri;
    },

    async download(uri, dir, onProgress = () => {}) {
      const res = await fetchImpl(uri);
      if (!res.ok || !res.body) throw new NexusError(`Не удалось скачать файл (ошибка ${res.status}).`, res.status);

      const name = path.basename(decodeURIComponent(new URL(uri).pathname)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'mod.zip';
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);

      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        onProgress(received, total);
      });
      try {
        await pipeline(body, fs.createWriteStream(file));
      } catch (err) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        throw err;
      }
      return file;
    },
  };
}

module.exports = { GAME, NexusError, isApiKey, parseNxm, createNexus };
