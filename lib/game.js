'use strict';
const fs = require('fs');
const path = require('path');

const GAME_EXE = path.join('bin', 'x64', 'Cyberpunk2077.exe');

function isGameDir(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, GAME_EXE));
  } catch {
    return false;
  }
}

/** Work out the game root folder from an exe path (or a resolved shortcut target). */
function deriveGameDir(target) {
  if (!target || typeof target !== 'string') return '';
  if (/[\\/]bin[\\/]x64[\\/][^\\/]+\.exe$/i.test(target)) {
    return path.dirname(path.dirname(path.dirname(target)));
  }
  if (/\.exe$/i.test(target)) {
    const dir = path.dirname(target);
    if (isGameDir(dir)) return dir;
  }
  return '';
}

function candidateDirs() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const steamRoots = [path.join(pf86, 'Steam'), path.join(pf, 'Steam')];
  const libraries = new Set(steamRoots);

  for (const root of steamRoots) {
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        libraries.add(m[1].replace(/\\\\/g, '\\'));
      }
    } catch {
      /* Steam not installed here */
    }
  }
  for (const letter of 'CDEFGH') {
    libraries.add(`${letter}:\\SteamLibrary`);
    libraries.add(`${letter}:\\Steam`);
  }

  const dirs = [];
  for (const lib of libraries) dirs.push(path.join(lib, 'steamapps', 'common', 'Cyberpunk 2077'));
  dirs.push(
    path.join(pf86, 'GOG Galaxy', 'Games', 'Cyberpunk 2077'),
    path.join(pf, 'Epic Games', 'Cyberpunk2077'),
    path.join(pf86, 'Epic Games', 'Cyberpunk2077')
  );
  for (const letter of 'CDEFGH') {
    dirs.push(`${letter}:\\GOG Games\\Cyberpunk 2077`, `${letter}:\\Games\\Cyberpunk 2077`);
  }
  return dirs;
}

function detectGame() {
  for (const dir of candidateDirs()) {
    if (isGameDir(dir)) return { gameDir: dir, exe: path.join(dir, GAME_EXE) };
  }
  return null;
}

module.exports = { GAME_EXE, isGameDir, deriveGameDir, detectGame };
