'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON store with debounced atomic writes.
 * `data` is a live object: mutate it, then call save().
 */
function createStore(file, defaults) {
  let data;
  try {
    data = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = structuredClone(defaults);
  }

  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[store] write failed:', err);
    }
  }

  function save() {
    if (!timer) timer = setTimeout(flush, 200);
  }

  return { data, save, flush };
}

module.exports = { createStore };
