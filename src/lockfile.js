'use strict';
/*
 * mcp-pin.lock: the tool definitions a team approved, committed next to the
 * project's shared .mcp.json and reviewed in pull requests like a dependency
 * lockfile. Each definition is stored as readable JSON, so the pull request
 * diff shows exactly what a server now tells the model.
 *
 *   mcp-pin lock            start each server in .mcp.json and write the lock
 *   mcp-pin lock --check    compare every server with the lock; exit 1 on change (CI)
 *   mcp-pin --lock <file> --name <server> -- <cmd>   the proxy pins against the lock
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { collectAllTools, collectAllPrompts } = require('./list-tools');
const { observe } = require('./definitions');
const { spawnServer } = require('./spawn');
const store = require('./store');
const { isStdio, unwrapEntry } = require('./wrap');

const VERSION = require('../package.json').version;

// Start one server the way an MCP client would, read what the model would
// read, and stop it. No tool is ever called.
function probeDefinitions(command, args, extraEnv, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawnServer(command, args, { env: Object.assign({}, process.env, extraEnv || {}), stdio: ['pipe', 'pipe', 'pipe'] });
    let seq = 0;
    let stderr = '';
    const pending = new Map();
    const timer = setTimeout(() => finish(new Error('timed out after ' + timeoutMs / 1000 + ' s')), timeoutMs);
    let done = false;
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); child.kill(); } catch {}
      if (err) reject(Object.assign(err, { stderr: stderr.slice(-400) }));
      else resolve(value);
    }
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error('server exited (' + code + ') before listing its tools')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { stderr += d; });
    const request = (method, params) => new Promise((res, rej) => {
      const id = 'lock-' + (++seq);
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id, method }, params !== undefined ? { params } : {})) + '\n');
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const p = m && m.method === undefined && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message || 'rpc error'));
      else p.res(m.result);
    });
    (async () => {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-pin-lock', version: VERSION } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const tools = await collectAllTools(request);
      // As in the proxy: a server that will not list the prompts it declares
      // leaves them unknown, not empty.
      let prompts = [];
      if (init && init.capabilities && init.capabilities.prompts) {
        try { prompts = await collectAllPrompts(request); } catch { prompts = undefined; }
      }
      const instructions = init && typeof init.instructions === 'string' ? init.instructions : null;
      finish(null, observe(tools, prompts, instructions));
    })().catch((e) => finish(e));
  });
}

// Environment placeholders as clients expand them: ${VAR} and ${VAR:-default}
// (Claude Code) and ${env:VAR} (VS Code, Cursor). Anything else is left as written.
function expand(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, dflt) => {
    const v = env[name];
    return v !== undefined && v !== '' ? v : dflt !== undefined ? dflt : '';
  });
}

// The stdio servers a project config declares, with mcp-pin taken back out
// of any entry that is already wrapped. The id comes from the command as
// written in the shared config, so it is the same on every machine; the
// command that runs has its placeholders filled in from this machine.
function serversFrom(configFile) {
  const doc = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const map = (doc && (doc.mcpServers || doc.servers)) || {};
  const out = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!isStdio(entry)) continue;
    const plain = unwrapEntry(entry) || entry;
    const args = Array.isArray(plain.args) ? plain.args : [];
    const env = {};
    for (const [k, v] of Object.entries(plain.env || {})) env[k] = expand(v);
    out.push({ name, command: expand(plain.command), args: args.map((a) => expand(a)), env, id: store.serverId(plain.command, args) });
  }
  return out;
}

function toEntry(server, obs) {
  const defs = (list) => list.map((t) => ({ name: t.name, hash: t.hash, definition: JSON.parse(t.canonical) }));
  const e = { id: server.id, setHash: obs.setHash, tools: defs(obs.tools) };
  if (obs.prompts) { e.promptsHash = obs.promptsHash; e.prompts = defs(obs.prompts); }
  e.instructionsHash = obs.instructionsHash;
  e.instructions = obs.instructions;
  return e;
}

// A lock entry in the shape the proxy and the diff code use for a pin,
// rebuilt from its readable definitions. A hand-edited lock must still hash
// to everything it claims, or it is refused.
function asPin(entry) {
  const defs = (list) => list.map((t) => t.definition);
  const instructions = typeof entry.instructions === 'string' ? entry.instructions : null;
  const pin = observe(defs(entry.tools || []), entry.prompts ? defs(entry.prompts) : undefined, instructions);
  const actual = pin.tools.concat(pin.prompts || []);
  const bad = (entry.tools || []).concat(entry.prompts || []).find((t) => !actual.some((a) => a.name === t.name && a.hash === t.hash));
  if (bad) throw new Error(`the definition of "${bad.name}" does not match its hash (was the lock edited by hand?)`);
  if (pin.setHash !== entry.setHash || (entry.prompts && pin.promptsHash !== entry.promptsHash) || pin.instructionsHash !== (entry.instructionsHash === undefined ? null : entry.instructionsHash)) {
    throw new Error('an entry does not match its own hashes (was the lock edited by hand?)');
  }
  pin.id = entry.id;
  return pin;
}

function readLock(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || doc.lockfileVersion !== 1 || typeof doc.servers !== 'object') throw new Error(file + ' is not an mcp-pin lockfile (lockfileVersion 1)');
  return doc;
}

// The lock entry for one proxied server: by --name, else by command id.
// A name match wins even when the command differs (a path that is not the
// same on every machine, say): the lock pins what the model reads, and
// mcp-pin lock --check reports command changes in review.
function findEntry(lock, name, id) {
  if (name && lock.servers[name]) return lock.servers[name];
  for (const e of Object.values(lock.servers)) if (e && e.id === id) return e;
  return null;
}

function writeLock(file, servers) {
  const doc = {
    lockfileVersion: 1,
    about: 'Written by mcp-pin lock. These are the MCP tool definitions this project approved. Review changes to this file like a dependency update.',
    servers,
  };
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { probeDefinitions, expand, serversFrom, toEntry, asPin, readLock, findEntry, writeLock };
