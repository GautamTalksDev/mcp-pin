'use strict';
// Preload for tests: make store.append throw so we can assert pin files are
// not left behind when the log write fails.
const path = require('path');
const Module = require('module');
const STORE = path.normalize(path.resolve(__dirname, '..', 'src', 'store.js'));
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exported = origLoad.apply(this, arguments);
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    return exported;
  }
  if (path.normalize(resolved) === STORE) {
    exported.append = function () {
      throw new Error('injected append failure');
    };
  }
  return exported;
};
