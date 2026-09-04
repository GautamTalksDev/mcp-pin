'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sha256 } = require('./canonical');

const HOME = process.env.MCP_PIN_HOME || process.env.ATTEST_HOME || path.join(os.homedir(), '.mcp-pin');
const PINS = path.join(HOME, 'pins.json'); // legacy; migrated to pins.d/
const PINS_DIR = path.join(HOME, 'pins.d');
const LOG = path.join(HOME, 'log.ndjson');
const LOCK = path.join(HOME, 'log.lock');

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 10000;

class CorruptStateError extends Error {
  constructor(filePath, cause) {
    const extra = cause && cause.message ? ': ' + cause.message : '';
    super('corrupt state at ' + filePath + extra);
    this.name = 'CorruptStateError';
    this.path = filePath;
    this.cause = cause;
  }
}

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch {}
}

function mkdirPrivate(p) {
  fs.mkdirSync(p, { recursive: true });
  chmodQuiet(p, 0o700);
}

function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CorruptStateError(filePath, e);
  }
}

function parseJson(filePath, raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CorruptStateError(filePath, e);
  }
}

function atomicWrite(dest, data) {
  const tmp = dest + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  chmodQuiet(dest, 0o600);
}

function pinPath(id) {
  if (!/^[a-f0-9]+$/i.test(String(id))) throw new Error('invalid server id');
  return path.join(PINS_DIR, id + '.json');
}

function migrateLegacyPins() {
  const raw = readText(PINS);
  if (raw === null) return;
  const pins = parseJson(PINS, raw);
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) {
    throw new CorruptStateError(PINS, new Error('pins.json is not an object'));
  }
  mkdirPrivate(PINS_DIR);
  for (const [id, rec] of Object.entries(pins)) {
    if (!/^[a-f0-9]+$/i.test(id)) {
      throw new CorruptStateError(PINS, new Error('pins.json contains an invalid server id'));
    }
    atomicWrite(pinPath(id), JSON.stringify(rec, null, 2));
  }
  const migrated = PINS + '.migrated';
  fs.renameSync(PINS, migrated);
  chmodQuiet(migrated, 0o600);
}

function ensure() {
  mkdirPrivate(HOME);
  mkdirPrivate(PINS_DIR);
  migrateLegacyPins();
}

function serverId(command, args) {
  return sha256([command].concat(args || []).join(' ')).slice(0, 16);
}

function readPins() {
  ensure();
  let names;
  try {
    names = fs.readdirSync(PINS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new CorruptStateError(PINS_DIR, e);
  }
  const out = {};
  for (const name of names) {
    if (!/^[a-f0-9]+\.json$/i.test(name)) continue;
    const p = path.join(PINS_DIR, name);
    try {
      out[name.slice(0, -5)] = parseJson(p, fs.readFileSync(p, 'utf8'));
    } catch (e) {
      // One unreadable pin must not take down `list`. The session for that
      // server still fail-closes in getPin.
      process.stderr.write('mcp-pin: skipping unreadable pin ' + p + '\n');
    }
  }
  return out;
}

function getPin(id) {
  ensure();
  const p = pinPath(id);
  const raw = readText(p);
  if (raw === null) return null;
  return parseJson(p, raw);
}

function setPin(id, record) {
  ensure();
  atomicWrite(pinPath(id), JSON.stringify(record, null, 2));
}

function deletePin(id) {
  ensure();
  try { fs.unlinkSync(pinPath(id)); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function lastLogHash() {
  const raw = readText(LOG);
  if (raw === null || !raw.trim()) return 'GENESIS';
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) return 'GENESIS';
  const last = lines[lines.length - 1];
  const j = parseJson(LOG, last);
  if (!j.entry_hash) throw new CorruptStateError(LOG, new Error('missing entry_hash on tail'));
  return j.entry_hash;
}

function withLogLock(fn) {
  ensure();
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      try {
        try { fs.writeFileSync(fd, String(process.pid)); } catch {}
        chmodQuiet(LOCK, 0o600);
        return fn();
      } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(LOCK); } catch {}
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error('timed out waiting for log lock at ' + LOCK);
      }
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          process.stderr.write('mcp-pin: reclaiming stale log lock\n');
          try { fs.unlinkSync(LOCK); } catch {}
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
      }
      sleepSync(15 + Math.floor(Math.random() * 40));
    }
  }
}

function append(entry) {
  return withLogLock(() => {
    const prev = lastLogHash();
    const body = Object.assign({ prev_entry_hash: prev, observed_at: new Date().toISOString() }, entry);
    body.entry_hash = sha256(JSON.stringify(body));
    const line = JSON.stringify(body) + '\n';
    const fd = fs.openSync(LOG, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    chmodQuiet(LOG, 0o600);
    return body;
  });
}

function readLog() {
  const raw = readText(LOG);
  if (raw === null || !raw.trim()) return [];
  const entries = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    entries.push(parseJson(LOG, l));
  }
  return entries;
}

function verifyLog() {
  const entries = readLog();
  let prev = 'GENESIS';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prev_entry_hash !== prev) return { ok: false, index: i, reason: 'broken link' };
    const copy = Object.assign({}, e);
    delete copy.entry_hash;
    if (sha256(JSON.stringify(copy)) !== e.entry_hash) return { ok: false, index: i, reason: 'bad entry hash' };
    prev = e.entry_hash;
  }
  return { ok: true, count: entries.length };
}

module.exports = {
  HOME, PINS, PINS_DIR, LOG, LOCK,
  serverId, ensure, readPins, getPin, setPin, deletePin,
  append, readLog, verifyLog, CorruptStateError,
};
