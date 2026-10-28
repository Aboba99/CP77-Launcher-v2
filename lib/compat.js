'use strict';

/**
 * Frameworks that other Cyberpunk mods depend on. `probe` files are looked up in the game folder,
 * so a framework installed by hand counts the same as one installed through the launcher.
 */
const FRAMEWORKS = {
  cet: { name: 'Cyber Engine Tweaks', probe: ['bin/x64/plugins/cyber_engine_tweaks.asi'] },
  red4ext: { name: 'RED4ext', probe: ['red4ext/RED4ext.dll'] },
  redscript: { name: 'redscript', probe: ['engine/tools/scc.exe'] },
  archivexl: { name: 'ArchiveXL', probe: ['red4ext/plugins/ArchiveXL/ArchiveXL.dll'] },
  tweakxl: { name: 'TweakXL', probe: ['red4ext/plugins/TweakXL/TweakXL.dll'] },
};

/** Which framework a deployed file needs (rel path is relative to the game folder, lower-case). */
function requirementOf(rel) {
  if (rel.endsWith('.xl') && rel.startsWith('archive/')) return 'archivexl';
  if (rel.startsWith('r6/scripts/') && rel.endsWith('.reds')) return 'redscript';
  if (rel.startsWith('r6/tweaks/')) return 'tweakxl';
  if (rel.startsWith('bin/x64/plugins/cyber_engine_tweaks/mods/')) return 'cet';
  if (rel.startsWith('red4ext/plugins/')) return 'red4ext';
  return null;
}

/**
 * @param mods      library mods ({ id, name, enabled, files })
 * @param hasFile   (relPath) => boolean, true if the file exists in the game folder
 * @returns { [modId]: [{ level: 'error' | 'warn', text }] } for enabled mods only
 */
function checkCompat(mods, hasFile) {
  const issues = {};
  const add = (id, level, text) => (issues[id] ||= []).push({ level, text });
  const enabled = mods.filter((m) => m.enabled);
  const present = new Map();
  const isPresent = (fw) => {
    if (!present.has(fw)) present.set(fw, FRAMEWORKS[fw].probe.some(hasFile));
    return present.get(fw);
  };

  // 1. missing frameworks
  for (const mod of enabled) {
    const needs = new Set();
    for (const f of mod.files) {
      const fw = requirementOf(f.toLowerCase());
      if (fw) needs.add(fw);
    }
    for (const fw of needs) {
      if (!isPresent(fw)) add(mod.id, 'error', `Нужен ${FRAMEWORKS[fw].name}, но он не найден в папке игры`);
    }
  }

  // 2. several enabled mods writing the same file
  const owners = new Map();
  for (const mod of enabled) {
    for (const f of mod.files) {
      const key = f.toLowerCase();
      const list = owners.get(key);
      if (list) list.push(mod);
      else owners.set(key, [mod]);
    }
  }
  const pairs = new Map();
  for (const list of owners.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i].id}|${list[j].id}`;
        const p = pairs.get(key);
        if (p) p.count++;
        else pairs.set(key, { a: list[i], b: list[j], count: 1 });
      }
    }
  }
  for (const { a, b, count } of pairs.values()) {
    add(a.id, 'warn', `Конфликт с «${b.name}»: общих файлов — ${count}`);
    add(b.id, 'warn', `Конфликт с «${a.name}»: общих файлов — ${count}`);
  }
  return issues;
}

module.exports = { FRAMEWORKS, requirementOf, checkCompat };
