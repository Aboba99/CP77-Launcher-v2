'use strict';

const PRE = /^(alpha|beta|rc|pre|preview|dev|nightly|test)$/;

/** "v1.2a-beta" -> [1, 2, 'a', 'beta'] */
function tokens(v) {
  const s = String(v || '').toLowerCase().replace(/^v(?=\d)/, '');
  return (s.match(/\d+|[a-z]+/g) || []).map((t) => (/^\d/.test(t) ? Number(t) : t));
}

// numbers are themselves, a missing part is 0, pre-release tags sort below it, other letters just above it
const value = (t) => (t === undefined ? 0 : typeof t === 'number' ? t : PRE.test(t) ? -1 : 0.5);

function compareVersions(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = value(x[i]) - value(y[i]);
    if (d) return d > 0 ? 1 : -1;
    if (typeof x[i] === 'string' && typeof y[i] === 'string' && x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Unknown installed version can't be compared, so it never counts as "older". */
const isNewer = (latest, installed) => !!latest && !!installed && compareVersions(latest, installed) > 0;

/**
 * Picks the newest file of a mod from Nexus' files.json.
 * With a known installed file id we follow Nexus' own update chain (old_file_id -> new_file_id);
 * otherwise we fall back to the newest MAIN file.
 */
function pickLatest(data, fileId) {
  const files = (data && data.files) || [];
  const byId = new Map(files.map((f) => [String(f.file_id), f]));
  const toLatest = (f, chain) => ({ fileId: String(f.file_id), version: String(f.version || ''), name: String(f.name || ''), chain });

  if (fileId && byId.has(String(fileId))) {
    const next = new Map(((data && data.file_updates) || []).map((u) => [String(u.old_file_id), String(u.new_file_id)]));
    let cur = String(fileId);
    const seen = new Set();
    while (next.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = next.get(cur);
    }
    if (byId.has(cur)) return toLatest(byId.get(cur), true);
  }

  const main = files.filter((f) => f.category_name === 'MAIN').sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0));
  return main[0] ? toLatest(main[0], false) : null;
}

function hasUpdate(mod) {
  const l = mod.latest;
  if (!l) return false;
  if (l.chain && mod.fileId && String(l.fileId) !== String(mod.fileId)) return true;
  return isNewer(l.version, mod.version);
}

module.exports = { compareVersions, isNewer, pickLatest, hasUpdate };
