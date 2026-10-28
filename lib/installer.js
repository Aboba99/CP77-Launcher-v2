'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const GAME_DIRS = new Set(['archive', 'bin', 'engine', 'r6', 'red4ext']);
const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar', '.tar']);
const JUNK = /(^|\/)(__macosx|\.ds_store|thumbs\.db|desktop\.ini)(\/|$)/i;
const CET_ROOT = 'bin/x64/plugins/cyber_engine_tweaks/mods';

/* ------------------------------------------------------------------ naming */

function safeName(name) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim();
  return clean || 'mod';
}

/** Nexus file names look like "Name-107-1-15-1-1700000000". */
function parseName(base) {
  const m = String(base).match(/^(.+?)-(\d+)-(\d+(?:-\d+)*)-(\d{9,11})$/);
  if (m) return { name: m[1].trim(), modId: m[2], version: m[3].replace(/-/g, '.') };
  return { name: String(base).trim() || 'Mod', modId: '', version: '' };
}

/* -------------------------------------------------------------- extraction */

function sevenZipPath() {
  const p = require('7zip-bin').path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    /* not fatal */
  }
  return p;
}

function extract7z(file, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      sevenZipPath(),
      ['x', file, `-o${dest}`, '-y', '-aoa', '-bd'],
      { windowsHide: true, maxBuffer: 1 << 26 },
      (err, _stdout, stderr) => {
        // exit code 1 = non-fatal warning
        if (err && err.code !== 1) reject(new Error(`Не удалось распаковать архив. ${String(stderr || err.message).trim()}`));
        else resolve();
      }
    );
  });
}

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Небезопасный путь внутри архива.');
  return full;
}

async function extractRar(file, dest) {
  const { createExtractorFromData } = require('node-unrar-js');
  const buf = await fsp.readFile(file);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const extractor = await createExtractorFromData({ data });
  const { files } = extractor.extract();
  for (const f of files) {
    if (f.fileHeader.flags.directory) continue;
    const to = safeJoin(dest, f.fileHeader.name.replace(/\\/g, '/'));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, f.extraction.data);
  }
}

async function sniff(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(8);
    await fh.read(b, 0, 8, 0);
    if (b.subarray(0, 4).toString('latin1') === 'Rar!') return 'rar';
    if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
    if (b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    return null;
  } finally {
    await fh.close();
  }
}

async function walk(dir, base = dir, out = []) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, base, out);
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/* ---------------------------------------------------------------- planning */

function analyze(entries, modName) {
  const cetDirs = new Set();
  for (const { segs } of entries) {
    if (segs[segs.length - 1].toLowerCase() === 'init.lua') cetDirs.add(segs.slice(0, -1).join('/'));
  }
  const tops = new Set(entries.map((e) => e.segs[0]));
  const wrapper = tops.size === 1 && entries.every((e) => e.segs.length > 1) ? [...tops][0] : null;
  return {
    // most specific folder first
    cetDirs: [...cetDirs].sort((a, b) => b.length - a.length),
    wrapper,
    modName: safeName(modName),
  };
}

/** Returns the destination path (relative to the game root) or null to skip the file. */
function classify(segs, ctx) {
  const lower = segs.map((s) => s.toLowerCase());
  const name = segs[segs.length - 1];
  const ext = path.extname(name).toLowerCase();

  // 1. Already laid out like the game folder (archive/, bin/, r6/, red4ext/, engine/)
  const marker = lower.findIndex((s) => GAME_DIRS.has(s));
  if (marker !== -1) return segs.slice(marker).join('/');

  // 2. Cyber Engine Tweaks Lua mod (folder with init.lua)
  const dir = segs.slice(0, -1).join('/');
  for (const c of ctx.cetDirs) {
    if (c === '' || dir === c || dir.startsWith(`${c}/`)) {
      const depth = c ? c.split('/').length : 0;
      const folder = c ? c.split('/').pop() : ctx.modName;
      return `${CET_ROOT}/${folder}/${segs.slice(depth).join('/')}`;
    }
  }

  // 3. REDmod: mods/<name>/...
  const mi = lower.indexOf('mods');
  if (mi !== -1 && lower.length > mi + 2) return segs.slice(mi).join('/');

  // 4. Loose files, decided by extension
  const rel = (ctx.wrapper ? segs.slice(1) : segs).join('/');
  switch (ext) {
    case '.archive':
    case '.xl':
      return `archive/pc/mod/${name}`;
    case '.reds':
      return `r6/scripts/${ctx.modName}/${rel}`;
    case '.tweak':
    case '.yaml':
    case '.yml':
      return `r6/tweaks/${ctx.modName}/${rel}`;
    case '.dll':
      return `red4ext/plugins/${ctx.modName}/${name}`;
    default:
      return null;
  }
}

function planFiles(files, modName) {
  const entries = files.filter((f) => !JUNK.test(f)).map((f) => ({ src: f, segs: f.split('/') }));
  const ctx = analyze(entries, modName);
  const plan = [];
  for (const e of entries) {
    const dest = classify(e.segs, ctx);
    if (dest) plan.push({ src: e.src, dest });
  }
  return plan;
}

/* ------------------------------------------------------------------ staging */

/**
 * Unpacks `src` (archive, folder or single file) and stores the files in
 * <stagingRoot>/<id>/ laid out exactly as they must appear in the game folder.
 */
async function stageSource(src, { stagingRoot, id, modName }) {
  const stat = await fsp.stat(src);
  const work = path.join(stagingRoot, `.work-${id}`);
  const out = path.join(stagingRoot, id);

  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });

  try {
    let base = work;
    let move = true;

    if (stat.isDirectory()) {
      base = src;
      move = false;
    } else {
      const kind = await sniff(src);
      const ext = path.extname(src).toLowerCase();
      if (kind === 'rar') await extractRar(src, work);
      else if (kind === 'zip' || kind === '7z' || ARCHIVE_EXT.has(ext)) await extract7z(src, work);
      else await fsp.copyFile(src, path.join(work, path.basename(src)));
    }

    const plan = planFiles(await walk(base), modName);
    if (!plan.length) throw new Error('Не удалось определить, куда устанавливать файлы этого мода.');

    const files = [];
    let size = 0;
    for (const { src: from, dest } of plan) {
      const to = safeJoin(out, dest);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      const source = path.join(base, ...from.split('/'));
      if (move) await fsp.rename(source, to);
      else await fsp.copyFile(source, to);
      size += (await fsp.stat(to)).size;
      if (!files.includes(dest)) files.push(dest);
    }
    return { files, size };
  } catch (err) {
    await fsp.rm(out, { recursive: true, force: true });
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ deploy */

async function deployMod(mod, stagingRoot, gameDir, only) {
  for (const rel of only || mod.files) {
    const from = path.join(stagingRoot, mod.id, ...rel.split('/'));
    const to = safeJoin(gameDir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rm(to, { force: true });
    try {
      await fsp.link(from, to); // hard link: no extra disk space
    } catch {
      await fsp.copyFile(from, to); // different drive
    }
  }
}

async function undeployMod(mod, gameDir) {
  const root = path.resolve(gameDir);
  const dirs = new Set();
  for (const rel of mod.files) {
    const to = safeJoin(gameDir, rel);
    await fsp.rm(to, { force: true });
    dirs.add(path.dirname(to));
  }
  // prune folders left empty, but never the top-level game folders
  for (let d of [...dirs].sort((a, b) => b.length - a.length)) {
    while (path.relative(root, d).split(path.sep).length > 1) {
      try {
        await fsp.rmdir(d);
      } catch {
        break;
      }
      d = path.dirname(d);
    }
  }
}

module.exports = { parseName, safeName, planFiles, stageSource, deployMod, undeployMod };
