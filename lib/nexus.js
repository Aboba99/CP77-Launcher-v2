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

/** Nexus sends reset times like "2024-05-01 13:00:00 +0000"; normalise to ISO so Date can parse it everywhere. */
function parseReset(value) {
  if (!value) return 0;
  const iso = String(value).trim().replace(' ', 'T').replace(/\s*([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Reads the x-rl-* headers Nexus attaches to every API response.
 * Returns { hourly, daily } with { limit, remaining, reset } each, or null when the headers are missing.
 */
function parseRateLimits(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const bucket = (name) => {
    const limit = Number(headers.get(`x-rl-${name}-limit`));
    const remaining = Number(headers.get(`x-rl-${name}-remaining`));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || headers.get(`x-rl-${name}-remaining`) === null) return null;
    return { limit, remaining: Math.max(0, Math.min(limit, remaining)), reset: parseReset(headers.get(`x-rl-${name}-reset`)) };
  };
  const hourly = bucket('hourly');
  const daily = bucket('daily');
  return hourly || daily ? { hourly, daily } : null;
}

/**
 * Merges a fresh reading into the previous one. Parallel requests can resolve out of order,
 * so within the same reset window the smaller "remaining" wins.
 */
function mergeRateLimits(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  const pick = (a, b) => {
    if (!b) return a;
    if (!a || a.reset !== b.reset || a.limit !== b.limit) return b;
    return b.remaining <= a.remaining ? b : a;
  };
  return { hourly: pick(prev.hourly, next.hourly), daily: pick(prev.daily, next.daily) };
}

/**
 * @param {object} [opts]
 * @param {(limits: object, apiKey: string) => void} [opts.onRateLimit] called with the x-rl-* readings of each
 *   successful (or 429) response and the key that made it; rejected keys (401) are never reported.
 */
function createNexus({ fetchImpl = fetch, version = '2.0.0', api = API, onRateLimit = () => {} } = {}) {
  async function request(apiKey, pathname, params = {}) {
    const url = new URL(api + pathname);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      headers: { apikey: apiKey, 'Application-Name': 'CP77 Launcher', 'Application-Version': version, accept: 'application/json' },
    });
    if (res.ok || res.status === 429) {
      const limits = parseRateLimits(res.headers);
      if (limits) onRateLimit(limits, apiKey);
    }
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

module.exports = { GAME, NexusError, isApiKey, parseNxm, parseRateLimits, mergeRateLimits, createNexus };
