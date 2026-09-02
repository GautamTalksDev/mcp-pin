'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sha256 } = require('./canonical');

const HOME = process.env.MCP_PIN_HOME || process.env.ATTEST_HOME || path.join(os.homedir(), '.mcp-pin');
const PINS = path.join(HOME, 'pins.json');
const LOG = path.join(HOME, 'log.ndjson');

function ensure() {
  fs.mkdirSync(HOME, { recursive: true });
}

function serverId(command, args) {
  return sha256([command].concat(args || []).join(' ')).slice(0, 16);
}

function readPins() {
  try {
    return JSON.parse(fs.readFileSync(PINS, 'utf8'));
  } catch {
    return {};
  }
}

function writePins(pins) {
  ensure();
  fs.writeFileSync(PINS, JSON.stringify(pins, null, 2));
}

function getPin(id) {
  return readPins()[id] || null;
}

function setPin(id, record) {
  const pins = readPins();
  pins[id] = record;
  writePins(pins);
}

function deletePin(id) {
  const pins = readPins();
  delete pins[id];
  writePins(pins);
}

// Append-only, hash-linked local log. Same entry shape the public log uses,
// so a local log can be submitted upstream verbatim.
function lastLogHash() {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return 'GENESIS';
    return JSON.parse(lines[lines.length - 1]).entry_hash;
  } catch {
    return 'GENESIS';
  }
}

function append(entry) {
  ensure();
  const prev = lastLogHash();
  const body = Object.assign({ prev_entry_hash: prev, observed_at: new Date().toISOString() }, entry);
  body.entry_hash = sha256(JSON.stringify(body));
  fs.appendFileSync(LOG, JSON.stringify(body) + '\n');
  return body;
}

function readLog() {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Verify the local chain links. Offline verification, no network.
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

module.exports = { HOME, PINS, LOG, serverId, readPins, getPin, setPin, deletePin, append, readLog, verifyLog };
